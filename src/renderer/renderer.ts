// 渲染进程：Tab 切换 + Plugin 面板（M2）
// 注意：本文件不得包含 import/export（浏览器普通脚本，CSP 禁止模块加载）
// 安全约定：任何来自主进程/磁盘的数据（skill 名/描述/路径、插件名、输出文本）
// 一律用 textContent / DOM API 渲染，绝不拼进 innerHTML（防注入，见 AUDIT P1-2）。

type ActivationSource = 'bundle' | 'patch' | 'none'

interface PluginEntry {
  name: string
  spec: string
  inBundles: boolean
  active: boolean
  activationSource: ActivationSource
  builtin: boolean
  source: 'builtin-bundle' | 'bundle' | 'dependency'
}

interface PluginListResult {
  ok: boolean
  profile?: string
  entries?: PluginEntry[]
  error?: string
}

interface PluginOpStarted {
  ok: boolean
  token?: string
  error?: string
}

interface PluginOpDone {
  token: string
  exitCode: number | null
  signal: string | null
  output: string
}

interface DesktopApi {
  harness: {
    url: () => Promise<string | null>
    restart: () => Promise<{ ok: boolean; url?: string; error?: string }>
    onFrameLoaded: (cb: (url: string) => void) => void
    onStatus: (cb: (status: { state: string; url?: string; code?: number | null }) => void) => void
  }
  plugins: {
    list: () => Promise<PluginListResult>
    activate: (name: string) => Promise<{ ok: boolean; output?: string; error?: string }>
    deactivate: (name: string) => Promise<{ ok: boolean; output?: string; error?: string }>
    startOp: (action: 'add' | 'remove' | 'update', args: string[]) => Promise<PluginOpStarted>
    cancelOp: (token: string) => Promise<{ ok: boolean }>
    onOpChunk: (cb: (token: string, text: string) => void) => void
    onOpDone: (cb: (done: PluginOpDone) => void) => void
  }
  mcp: {
    list: () => Promise<McpListResult>
    convert: (jsonText: string) => Promise<McpConvertResult>
    apply: (input: { rows: McpRow[]; mode: 'merge' | 'replace' }) => Promise<McpApplyResult>
    update: (input: { id: string; row: McpRow }) => Promise<McpApplyResult>
    delete: (id: string) => Promise<McpApplyResult>
  }
  skills: {
    list: () => Promise<SkillsListResult>
    create: (input: { name: string; description: string; body: string }) => Promise<{ ok: boolean; path?: string; error?: string }>
    toggle: (input: { id: string; source: string; kind: 'model' | 'user'; value: boolean }) => Promise<{ ok: boolean; error?: string }>
    importFile: (buffer: ArrayBuffer, overwrite: boolean) => Promise<SkillsImportResult>
    importUrl: (url: string, overwrite: boolean) => Promise<SkillsImportResult>
  }
}

interface SkillsImportResult {
  ok: boolean
  result?: { name: string; file: string; installed: string[] }
  error?: string
}

interface SkillsSummary {
  name: string
  description: string
  source: string
  path: string
  shadowed: boolean
  modelInvocable: boolean
  userInvocable: boolean
}

interface SkillsListResult {
  ok: boolean
  skills?: SkillsSummary[]
  error?: string
}

interface McpRow {
  id: string
  name: string
  config: Record<string, unknown>
}

interface McpListResult {
  ok: boolean
  profile?: string
  servers?: McpRow[]
  error?: string
}

interface McpConvertResult {
  ok: boolean
  rows?: McpRow[]
  yaml?: string
  warnings?: string[]
  error?: string
}

interface McpApplyResult {
  ok: boolean
  backup?: string
  error?: string
}

type DesktopWindow = Window & { dshDesktop?: DesktopApi }
const api = (window as DesktopWindow).dshDesktop

const TABS = ['harness', 'plugin', 'mcp', 'skills'] as const
type TabId = (typeof TABS)[number]

const harnessFullscreenButton = document.getElementById('harness-fullscreen')

function setHarnessFullscreen(active: boolean): void {
  document.body.classList.toggle('harness-fullscreen', active)
  harnessFullscreenButton?.setAttribute('aria-pressed', String(active))
  harnessFullscreenButton?.setAttribute('aria-label', active ? '退出 Harness 全屏' : '全屏显示 Harness')
  harnessFullscreenButton?.setAttribute('title', active ? '退出 Harness 全屏' : '全屏显示 Harness')
}

function switchTab(id: TabId): void {
  if (id !== 'harness' && document.body.classList.contains('harness-fullscreen')) setHarnessFullscreen(false)
  for (const t of TABS) {
    const tab = document.querySelector(`[data-tab="${t}"]`)
    const panel = document.getElementById(`panel-${t}`)
    const active = t === id
    tab?.classList.toggle('active', active)
    tab?.setAttribute('aria-selected', String(active))
    panel?.classList.toggle('active', active)
    panel?.setAttribute('aria-hidden', String(!active))
  }
}

harnessFullscreenButton?.addEventListener('click', () => {
  setHarnessFullscreen(!document.body.classList.contains('harness-fullscreen'))
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('harness-fullscreen')) setHarnessFullscreen(false)
})

for (const t of TABS) {
  const tab = document.querySelector(`[data-tab="${t}"]`)
  tab?.addEventListener('click', () => switchTab(t))
  tab?.addEventListener('keydown', (event) => {
    if (!(event instanceof KeyboardEvent) || !['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(event.key)) return
    event.preventDefault()
    const offset = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1
    const next = TABS[(TABS.indexOf(t) + offset + TABS.length) % TABS.length]
    document.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus()
    switchTab(next)
  })
}

function setStatus(text: string, kind: 'error' | 'ok' = 'ok'): void {
  const el = document.getElementById('plugin-status')
  if (!el) return
  el.textContent = text
  el.className = `status ${kind}`
}

// ---- Plugin 面板：激活状态机（bundle / patch / none）+ 流式操作 ----
const SOURCE_LABEL: Record<PluginEntry['source'], string> = {
  'builtin-bundle': '内置组合包',
  bundle: '第三方组合包',
  dependency: '普通依赖',
}

let activeOpToken: string | null = null
let opResultText = ''

function setOpControls(running: boolean): void {
  const cancel = document.getElementById('plugin-cancel') as HTMLButtonElement | null
  if (cancel) cancel.hidden = !running
}

function appendOpOutput(text: string): void {
  opResultText = (opResultText + text).slice(-2000)
}

async function refreshPlugins(): Promise<void> {
  const el = document.getElementById('plugin-rows')
  if (!el || !api) return
  el.replaceChildren()
  const loading = document.createElement('tr')
  const td = document.createElement('td')
  td.colSpan = 4
  td.textContent = '加载中…'
  loading.appendChild(td)
  el.appendChild(loading)
  const res = await api.plugins.list()
  el.replaceChildren()
  if (!res.ok || !res.entries) {
    setStatus(`加载失败: ${res.error ?? '未知错误'}`, 'error')
    return
  }
  for (const p of res.entries) {
    const tr = document.createElement('tr')
    const tdName = document.createElement('td')
    tdName.textContent = p.name
    const tdSource = document.createElement('td')
    tdSource.textContent = SOURCE_LABEL[p.source]
    const tdSpec = document.createElement('td')
    tdSpec.textContent = p.spec || '—'
    const tdOps = document.createElement('td')
    if (p.builtin) {
      const span = document.createElement('span')
      span.className = 'status ok'
      span.textContent = '内置'
      tdOps.appendChild(span)
    } else {
      if (p.activationSource === 'bundle') {
        const span = document.createElement('span')
        span.className = 'status ok'
        span.textContent = '随包激活'
        tdOps.appendChild(span)
      } else if (p.activationSource === 'patch') {
        const span = document.createElement('span')
        span.className = 'status ok'
        span.textContent = '已激活'
        tdOps.appendChild(span)
        const deactivate = document.createElement('button')
        deactivate.className = 'quiet'
        deactivate.textContent = '停用'
        deactivate.addEventListener('click', () => void deactivatePlugin(p.name))
        tdOps.appendChild(deactivate)
      } else {
        const activate = document.createElement('button')
        activate.textContent = '激活'
        activate.addEventListener('click', () => void activatePlugin(p.name))
        tdOps.appendChild(activate)
      }
      const remove = document.createElement('button')
      remove.className = 'quiet'
      remove.textContent = '移除'
      remove.addEventListener('click', () => void removePlugin(p.name))
      tdOps.appendChild(remove)
    }
    tr.append(tdName, tdSource, tdSpec, tdOps)
    el.appendChild(tr)
  }
  setStatus(`profile「${res.profile}」共 ${res.entries.length} 个包`)
}

async function activatePlugin(name: string): Promise<void> {
  if (!api) return
  if (!confirm(`确认激活插件「${name}」？\n这会把它写入 profile patch，重启 Harness 后加载。`)) return
  setStatus(`激活中: ${name}`)
  const res = await api.plugins.activate(name)
  setStatus(res.ok ? (res.output ?? '激活成功') : `激活失败: ${res.error ?? ''}`, res.ok ? 'ok' : 'error')
  if (res.ok) await refreshPlugins()
}

async function deactivatePlugin(name: string): Promise<void> {
  if (!api) return
  if (!confirm(`确认停用插件「${name}」？\n只移除 patch 激活行，不卸载 package。`)) return
  setStatus(`停用中: ${name}`)
  const res = await api.plugins.deactivate(name)
  setStatus(res.ok ? (res.output ?? '停用成功') : `停用失败: ${res.error ?? ''}`, res.ok ? 'ok' : 'error')
  if (res.ok) await refreshPlugins()
}

async function runPluginOpUi(action: 'add' | 'remove' | 'update', args: string[], label: string): Promise<void> {
  if (!api) return
  if (activeOpToken) {
    setStatus('已有插件操作进行中，请等待完成或取消', 'error')
    return
  }
  const started = await api.plugins.startOp(action, args)
  if (!started.ok || !started.token) {
    setStatus(`启动失败: ${started.error ?? ''}`, 'error')
    return
  }
  activeOpToken = started.token
  opResultText = ''
  setOpControls(true)
  setStatus(`${label}中…（输出如下，可取消）`, 'ok')
}

async function installPlugin(): Promise<void> {
  const input = document.getElementById('plugin-spec') as HTMLInputElement | null
  if (!input || !api) return
  const spec = input.value.trim()
  if (!spec) {
    setStatus('请输入包名或 github:owner/repo#commit', 'error')
    return
  }
  if (!confirm(`确认安装插件「${spec}」到 profile「web」？\n插件代码将在本机执行（沙箱之外）。`)) return
  await runPluginOpUi('add', [spec], '安装')
}

async function removePlugin(name: string): Promise<void> {
  if (!api) return
  if (!confirm(`确认移除插件「${name}」？\n若存在 patch 激活行将一并清理。`)) return
  await runPluginOpUi('remove', [name], '移除')
}

async function updateAllPlugins(): Promise<void> {
  if (!api) return
  if (!confirm('确认更新 profile「web」的全部插件？\n将执行 dsh plugin update。')) return
  await runPluginOpUi('update', [], '更新')
}

async function cancelPluginOp(): Promise<void> {
  if (!api || !activeOpToken) return
  await api.plugins.cancelOp(activeOpToken)
  setStatus('已发送取消请求（SIGTERM）', 'ok')
}

api?.plugins.onOpChunk((token, text) => {
  if (token !== activeOpToken) return
  appendOpOutput(text)
  setStatus(opResultText, 'ok')
})

api?.plugins.onOpDone((done) => {
  if (done.token !== activeOpToken) return
  activeOpToken = null
  setOpControls(false)
  appendOpOutput(done.output)
  const head = done.exitCode === 0 ? '操作成功' : `操作失败（exit=${done.exitCode ?? 'signal ' + (done.signal ?? '?')}）`
  setStatus(`${head}\n${opResultText.slice(-2000)}`, done.exitCode === 0 ? 'ok' : 'error')
  void refreshPlugins()
})

document.getElementById('plugin-install')?.addEventListener('click', () => void installPlugin())
document.getElementById('plugin-refresh')?.addEventListener('click', () => void refreshPlugins())
document.getElementById('plugin-update-all')?.addEventListener('click', () => void updateAllPlugins())
document.getElementById('plugin-cancel')?.addEventListener('click', () => void cancelPluginOp())

// ---- MCP 面板 ----
let mcpDraftRows: McpRow[] = []
let managedMcpRows: McpRow[] = []
let editingMcpId: string | null = null

function setMcpStatus(text: string, kind: 'error' | 'ok' = 'ok'): void {
  const el = document.getElementById('mcp-warnings')
  if (!el) return
  el.textContent = text
  el.className = `status ${kind}`
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function mcpTransport(row: McpRow): string {
  return typeof row.config.transport === 'string' ? row.config.transport : '未知'
}

function mcpTarget(row: McpRow): string {
  const { config } = row
  if (config.transport === 'stdio') {
    const command = typeof config.command === 'string' ? config.command : '—'
    const args = Array.isArray(config.args) ? config.args.map(String).join(' ') : ''
    return `${command}${args ? ` ${args}` : ''}`
  }
  return typeof config.url === 'string' ? config.url : '—'
}

function redactMcpTarget(value: string): string {
  return value.replace(/([?&][^=\s]+)=([^&\s]+)/g, '$1=…')
}

function mcpRowWarnings(row: McpRow): string[] {
  const warnings: string[] = []
  if (row.config.transport === 'stdio') {
    const command = typeof row.config.command === 'string' ? row.config.command.trim() : ''
    const args = Array.isArray(row.config.args) ? row.config.args : []
    if (!command) warnings.push(`「${row.id}」缺少 command`)
    else if (/\s/.test(command) && args.length === 0) warnings.push(`「${row.id}」的 command 含参数；请将可执行文件保留在 command，其余拆到 args`)
  }
  if (row.config.transport === 'streamable-http' && typeof row.config.url !== 'string') {
    warnings.push(`「${row.id}」缺少 HTTP url`)
  }
  return warnings
}

function setMcpEditorState(): void {
  const apply = document.getElementById('mcp-apply') as HTMLButtonElement | null
  const cancel = document.getElementById('mcp-cancel-edit') as HTMLButtonElement | null
  if (apply) apply.textContent = editingMcpId ? '保存修改' : '写入 patch'
  if (cancel) cancel.hidden = editingMcpId === null
}

function renderMcpRows(rows: McpRow[]): void {
  const el = document.getElementById('mcp-server-rows')
  if (!el) return
  if (rows.length === 0) {
    el.innerHTML = '<tr><td colspan="4">暂无 MCP 服务器</td></tr>'
    return
  }
  el.innerHTML = rows
    .map((row) => {
      const name = typeof row.config.serverName === 'string' ? row.config.serverName : row.id
      const target = redactMcpTarget(mcpTarget(row))
      return `<tr>
        <td>${escapeHtml(name)}</td>
        <td>${escapeHtml(mcpTransport(row))}</td>
        <td title="${escapeHtml(target)}">${escapeHtml(target)}</td>
        <td>
          <button data-mcp-edit="${escapeHtml(row.id)}">编辑</button>
          <button class="quiet" data-mcp-delete="${escapeHtml(row.id)}">删除</button>
        </td>
      </tr>`
    })
    .join('')
  el.querySelectorAll<HTMLElement>('[data-mcp-edit]').forEach((button) => {
    button.addEventListener('click', () => startMcpEdit(String(button.dataset.mcpEdit)))
  })
  el.querySelectorAll<HTMLElement>('[data-mcp-delete]').forEach((button) => {
    button.addEventListener('click', () => void deleteMcpServer(String(button.dataset.mcpDelete)))
  })
}

async function refreshMcpServers(): Promise<void> {
  if (!api) return
  const summary = document.getElementById('mcp-servers')
  if (summary) {
    summary.textContent = '读取 profile MCP 配置中…'
    summary.className = 'status'
  }
  const res = await api.mcp.list()
  if (!res.ok) {
    managedMcpRows = []
    renderMcpRows([])
    if (summary) {
      summary.textContent = `加载失败: ${res.error ?? ''}`
      summary.className = 'status error'
    }
    return
  }
  managedMcpRows = res.servers ?? []
  renderMcpRows(managedMcpRows)
  const warnings = managedMcpRows.flatMap(mcpRowWarnings)
  if (warnings.length > 0) setMcpStatus(`配置检查：${warnings.join('；')}`, 'error')
  if (summary) {
    summary.textContent = `profile「${res.profile}」现有 MCP 服务器: ${managedMcpRows.length}`
    summary.className = 'status ok'
  }
}

/** 深度还原 !!js 哨兵（{ $js: 'process.env.X' } → '${X}'；其他表达式保持字面字符串），
 * 供 MCP 编辑表单使用：转换回 renderRowsYaml 时 ${X} 会重新生成 !!js，动态语义闭环。 */
function restoreJsRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(restoreJsRefs)
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (typeof o.$js === 'string') {
      const m = o.$js.match(/^process\.env\.([A-Za-z_][A-Za-z0-9_]*)$/)
      return m ? `\${${m[1]}}` : o.$js
    }
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, restoreJsRefs(v)]))
  }
  return value
}

function startMcpEdit(id: string): void {
  const row = managedMcpRows.find((candidate) => candidate.id === id)
  const input = document.getElementById('mcp-json') as HTMLTextAreaElement | null
  const preview = document.getElementById('mcp-preview') as HTMLPreElement | null
  if (!row || !input) return
  const config = { ...row.config }
  const transport = config.transport
  const serverName = typeof config.serverName === 'string' ? config.serverName : row.id
  delete config.serverName
  delete config.transport
  if (transport === 'streamable-http') config.type = 'http'
  input.value = JSON.stringify({ mcpServers: { [serverName]: config } }, null, 2)
  if (preview) preview.textContent = ''
  editingMcpId = row.id
  // 哨兵还原后作为编辑草稿：即使不重新转换，保存时 ${VAR} 也能恢复 !!js
  mcpDraftRows = [{ ...row, config: restoreJsRefs(row.config) as Record<string, unknown> }]
  setMcpEditorState()
  setMcpStatus(`正在编辑 MCP「${serverName}」；转换后可保存修改`, 'ok')
}

function cancelMcpEdit(): void {
  editingMcpId = null
  mcpDraftRows = []
  const input = document.getElementById('mcp-json') as HTMLTextAreaElement | null
  const preview = document.getElementById('mcp-preview') as HTMLPreElement | null
  if (input) input.value = ''
  if (preview) preview.textContent = ''
  setMcpEditorState()
  setMcpStatus('已取消编辑', 'ok')
}

async function convertPreview(): Promise<void> {
  const input = document.getElementById('mcp-json') as HTMLTextAreaElement | null
  const preview = document.getElementById('mcp-preview') as HTMLPreElement | null
  if (!input || !preview || !api) return
  const text = input.value.trim()
  if (!text) {
    setMcpStatus('请先粘贴 JSON', 'error')
    preview.textContent = ''
    mcpDraftRows = []
    return
  }
  const res = await api.mcp.convert(text)
  if (!res.ok) {
    setMcpStatus(`转换失败: ${res.error ?? ''}`, 'error')
    preview.textContent = ''
    mcpDraftRows = []
    return
  }
  mcpDraftRows = res.rows ?? []
  preview.textContent = res.yaml ?? ''
  setMcpStatus(`转换成功: ${mcpDraftRows.length} 个服务器${res.warnings && res.warnings.length ? `\n警告: ${res.warnings.join('；')}` : ''}`, 'ok')
}

async function applyMcp(): Promise<void> {
  if (!api) return
  if (mcpDraftRows.length === 0) {
    setMcpStatus('请先转换得到 YAML 再写入', 'error')
    return
  }
  const editing = editingMcpId !== null
  const action = editing ? '保存修改' : '写入'
  const replaceCheck = document.getElementById('mcp-replace') as HTMLInputElement | null
  const replaceMode = !editing && (replaceCheck?.checked ?? false)
  const scope = editing
    ? '仅更新该服务器，其余行保留。'
    : replaceMode
      ? '全量替换：将清除现有全部 MCP 服务器。'
      : '合并写入：按 id 覆盖或追加，保留现有服务器。'
  if (!confirm(`确认${action} ${mcpDraftRows.length} 个 MCP 服务器到 profile「web」的 cordis.patch.yml？\n${scope}\n服务器命令将在本机执行（沙箱之外），写入前自动备份。`)) return
  setMcpStatus(`${action}中…`)
  const res = editing
    ? await api.mcp.update({ id: editingMcpId!, row: mcpDraftRows[0] })
    : await api.mcp.apply({ rows: mcpDraftRows, mode: replaceMode ? 'replace' : 'merge' })
  setMcpStatus(res.ok ? `${action}成功（备份: ${res.backup}），HMR 热生效中` : `${action}失败: ${res.error ?? ''}`, res.ok ? 'ok' : 'error')
  if (res.ok) {
    editingMcpId = null
    mcpDraftRows = []
    setMcpEditorState()
    await refreshMcpServers()
  }
}

async function deleteMcpServer(id: string): Promise<void> {
  if (!api) return
  const row = managedMcpRows.find((candidate) => candidate.id === id)
  const name = row && typeof row.config.serverName === 'string' ? row.config.serverName : id
  if (!confirm(`确认删除 MCP 服务器「${name}」？写入前自动备份。`)) return
  setMcpStatus(`删除中: ${name}`)
  const res = await api.mcp.delete(id)
  setMcpStatus(res.ok ? `删除成功（备份: ${res.backup}）` : `删除失败: ${res.error ?? ''}`, res.ok ? 'ok' : 'error')
  if (res.ok) {
    if (editingMcpId === id) cancelMcpEdit()
    await refreshMcpServers()
  }
}

document.getElementById('mcp-convert')?.addEventListener('click', () => void convertPreview())
document.getElementById('mcp-apply')?.addEventListener('click', () => void applyMcp())
document.getElementById('mcp-cancel-edit')?.addEventListener('click', cancelMcpEdit)
document.getElementById('mcp-list')?.addEventListener('click', () => void refreshMcpServers())
setMcpEditorState()

// ---- Skills 面板 ----
const SKILL_SOURCE_LABEL: Record<string, string> = {
  'project-dsh': '项目 .dsh/skills',
  'project-agents': '项目 .agents/skills',
  custom: '自定义目录',
  'user-dsh': '用户 ~/.dsh/skills',
  'user-agents': '用户 ~/.agents/skills',
  bundled: '随包',
}

function setSkillsStatus(text: string, kind: 'error' | 'ok' = 'ok'): void {
  const el = document.getElementById('skills-status')
  if (!el) return
  el.textContent = text
  el.className = `status ${kind}`
}

async function refreshSkills(): Promise<void> {
  const el = document.getElementById('skills-rows')
  if (!el || !api) return
  el.replaceChildren()
  const loading = document.createElement('tr')
  const tdLoading = document.createElement('td')
  tdLoading.colSpan = 5
  tdLoading.textContent = '加载中…'
  loading.appendChild(tdLoading)
  el.appendChild(loading)
  const res = await api.skills.list()
  el.replaceChildren()
  if (!res.ok || !res.skills) {
    setSkillsStatus(`加载失败: ${res.error ?? '未知错误'}`, 'error')
    return
  }
  for (const s of res.skills) {
    const tr = document.createElement('tr')
    if (s.shadowed) tr.className = 'dim'
    const tdName = document.createElement('td')
    tdName.textContent = s.name
    if (s.shadowed) {
      const tag = document.createElement('span')
      tag.className = 'tag'
      tag.textContent = '被遮蔽'
      tdName.appendChild(tag)
    }
    const tdDesc = document.createElement('td')
    tdDesc.textContent = s.description || '—'
    const tdSource = document.createElement('td')
    tdSource.textContent = SKILL_SOURCE_LABEL[s.source] ?? s.source
    const tdModel = document.createElement('td')
    const tdUser = document.createElement('td')
    // 只有用户级（~/.dsh/skills、~/.agents/skills）允许壳层切换；项目/自定义/随包只读展示
    if (s.source === 'user-dsh' || s.source === 'user-agents') {
      const btnModel = document.createElement('button')
      btnModel.textContent = s.modelInvocable ? '开' : '关'
      btnModel.addEventListener('click', () => void toggleSkill(s.name, s.source, 'model', !s.modelInvocable))
      tdModel.appendChild(btnModel)
      const btnUser = document.createElement('button')
      btnUser.textContent = s.userInvocable ? '开' : '关'
      btnUser.addEventListener('click', () => void toggleSkill(s.name, s.source, 'user', !s.userInvocable))
      tdUser.appendChild(btnUser)
    } else {
      const spanModel = document.createElement('span')
      spanModel.className = 'tag'
      spanModel.textContent = s.modelInvocable ? '开' : '关'
      spanModel.title = '仅用户级 skill 可在此切换'
      tdModel.appendChild(spanModel)
      const spanUser = document.createElement('span')
      spanUser.className = 'tag'
      spanUser.textContent = s.userInvocable ? '开' : '关'
      spanUser.title = '仅用户级 skill 可在此切换'
      tdUser.appendChild(spanUser)
    }
    tr.append(tdName, tdDesc, tdSource, tdModel, tdUser)
    el.appendChild(tr)
  }
  setSkillsStatus(`共 ${res.skills.length} 个 skill（含被遮蔽项）`)
}

async function toggleSkill(id: string, source: string, kind: 'model' | 'user', value: boolean): Promise<void> {
  if (!api) return
  const label = kind === 'model' ? '模型可见' : '用户可见'
  if (!confirm(`确认将「${id}」的${label}切换为${value ? '开启' : '关闭'}？`)) return
  const res = await api.skills.toggle({ id, source, kind, value })
  setSkillsStatus(res.ok ? `${label}已更新，即时生效` : `失败: ${res.error ?? ''}`, res.ok ? 'ok' : 'error')
  await refreshSkills()
}

async function createSkill(): Promise<void> {
  const name = (document.getElementById('skill-name') as HTMLInputElement | null)?.value.trim() ?? ''
  const desc = (document.getElementById('skill-desc') as HTMLInputElement | null)?.value.trim() ?? ''
  const body = (document.getElementById('skill-body') as HTMLTextAreaElement | null)?.value ?? ''
  if (!api) return
  if (!name) {
    setSkillsStatus('名称必填（kebab-case）', 'error')
    return
  }
  if (!confirm(`确认在 ~/.dsh/skills 创建 skill「${name}」？`)) return
  const res = await api.skills.create({ name, description: desc, body })
  setSkillsStatus(res.ok ? `已创建: ${res.path}` : `创建失败: ${res.error ?? ''}`, res.ok ? 'ok' : 'error')
  if (res.ok) await refreshSkills()
}

document.getElementById('skills-refresh')?.addEventListener('click', () => void refreshSkills())
document.getElementById('skill-create')?.addEventListener('click', () => void createSkill())

// ---- Skills 导入（.skill/.zip/GitHub 链接）----
function setImportStatus(text: string, kind: 'error' | 'ok' = 'ok'): void {
  const el = document.getElementById('skill-import-status')
  if (!el) return
  el.textContent = text
  el.className = `status ${kind}`
}

async function importFromUrl(): Promise<void> {
  const input = document.getElementById('skill-import-url') as HTMLInputElement | null
  if (!input || !api) return
  const url = input.value.trim()
  if (!url) {
    setImportStatus('请输入 GitHub 链接', 'error')
    return
  }
  // 取消 = 中止整个导入（P1-6）；确认 = 允许覆盖（主进程事务性替换）
  if (!confirm('确认从 GitHub 导入该 skill 到 ~/.dsh/skills？\n（若已存在同名 skill 将覆盖）')) return
  setImportStatus(`下载导入中: ${url}`)
  const res = await api.skills.importUrl(url, true)
  setImportStatus(
    res.ok ? `导入成功: ${res.result?.name}（${res.result?.installed.length} 个文件）` : `导入失败: ${res.error ?? ''}`,
    res.ok ? 'ok' : 'error',
  )
  if (res.ok) await refreshSkills()
}

async function importFromFile(): Promise<void> {
  const input = document.getElementById('skill-file') as HTMLInputElement | null
  if (!input || !api || !input.files?.length) return
  const file = input.files[0]
  if (!confirm(`确认导入「${file.name}」到 ~/.dsh/skills？\n（若已存在同名 skill 将覆盖）`)) {
    input.value = ''
    return
  }
  setImportStatus(`导入中: ${file.name}`)
  const buffer = await file.arrayBuffer()
  const res = await api.skills.importFile(buffer, true)
  setImportStatus(
    res.ok ? `导入成功: ${res.result?.name}（${res.result?.installed.length} 个文件）` : `导入失败: ${res.error ?? ''}`,
    res.ok ? 'ok' : 'error',
  )
  input.value = ''
  if (res.ok) await refreshSkills()
}

document.getElementById('skill-import-url-btn')?.addEventListener('click', () => void importFromUrl())
document.getElementById('skill-import-file')?.addEventListener('click', () => void importFromFile())

// ---- Harness 面板：内嵌官方 Web UI + 状态 + 重启 ----
function setHarnessStatusText(status: { state: string; url?: string; code?: number | null; error?: string }): void {
  const el = document.getElementById('harness-status')
  if (!el) return
  switch (status.state) {
    case 'starting':
      el.textContent = 'Harness 启动中…（首次运行或需 1-2 分钟，请稍候）'
      el.className = 'harness-status'
      break
    case 'restarting':
      el.textContent = 'Harness 重启中…'
      el.className = 'harness-status'
      break
    case 'ready':
      el.textContent = `已连接: ${status.url ?? ''}`
      el.className = 'harness-status ok'
      break
    case 'exited':
      el.textContent = status.error
        ? `Harness 连接失败：${status.error}`
        : `Harness 已退出（code=${status.code ?? '?'}），可点击重启`
      el.className = 'harness-status error'
      break
    default:
      el.textContent = '状态未知'
      el.className = 'harness-status'
  }
}

async function mountHarness(): Promise<void> {
  const frame = document.getElementById('harness-frame') as HTMLIFrameElement | null
  if (!frame || !api) return
  setHarnessStatusText({ state: 'starting' })
  const url = await api.harness.url()
  // 窗口先行时 harness 可能尚未就绪：保持「连接中…」，等待 onStatus 推送，不误显示已退出
  if (!url) return
  frame.src = url
}

async function restartHarness(): Promise<void> {
  if (!api) return
  setHarnessStatusText({ state: 'restarting' })
  const res = await api.harness.restart()
  if (!res.ok) {
    setHarnessStatusText({ state: 'exited', code: -1 })
    const el = document.getElementById('harness-status')
    if (el) el.textContent = `重启失败: ${res.error ?? ''}`
    return
  }
  // 重启后 --port 0 会换新端口：必须把 iframe 重挂到新 URL，否则停留在已死进程的旧端口
  const frame = document.getElementById('harness-frame') as HTMLIFrameElement | null
  if (frame && res.url) {
    frame.src = res.url
    setHarnessStatusText({ state: 'ready', url: res.url })
  }
}

if (api) {
  api.harness.onFrameLoaded((url) => setHarnessStatusText({ state: 'ready', url }))
  api.harness.onStatus(setHarnessStatusText)
  document.getElementById('harness-restart')?.addEventListener('click', () => void restartHarness())
  void refreshPlugins()
  void refreshMcpServers()
  void refreshSkills()
  void mountHarness()
}
