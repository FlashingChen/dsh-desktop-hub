// 渲染进程：Tab 切换 + Plugin 面板（M2）
// 注意：本文件不得包含 import/export（浏览器普通脚本，CSP 禁止模块加载）

interface PluginEntry {
  name: string
  spec: string
  inBundles: boolean
  active: boolean
  builtin: boolean
  source: 'builtin-bundle' | 'bundle' | 'dependency'
}

interface PluginListResult {
  ok: boolean
  profile?: string
  entries?: PluginEntry[]
  error?: string
}

interface PluginOpResult {
  ok: boolean
  exitCode?: number | null
  output?: string
  backup?: string
  error?: string
}

interface DesktopApi {
  versions: { electron: string; node: string; chrome: string }
  harness: {
    url: () => Promise<string | null>
    onFrameLoaded: (cb: (url: string) => void) => void
  }
  plugins: {
    list: () => Promise<PluginListResult>
    install: (spec: string) => Promise<PluginOpResult>
    activate: (name: string) => Promise<PluginOpResult>
    deactivate: (name: string) => Promise<PluginOpResult>
    remove: (name: string) => Promise<PluginOpResult>
    update: () => Promise<PluginOpResult>
  }
  mcp: {
    list: () => Promise<McpListResult>
    convert: (jsonText: string) => Promise<McpConvertResult>
    apply: (rows: McpRow[]) => Promise<McpApplyResult>
    update: (input: { id: string; row: McpRow }) => Promise<McpApplyResult>
    delete: (id: string) => Promise<McpApplyResult>
  }
  skills: {
    list: () => Promise<SkillsListResult>
    create: (input: { name: string; description: string; body: string }) => Promise<SkillsOpResult>
    toggle: (input: { path: string; kind: 'model' | 'user'; value: boolean }) => Promise<SkillsOpResult>
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

interface SkillsOpResult {
  ok: boolean
  path?: string
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


function pluginOutput(res: PluginOpResult): string {
  return res.output || res.error || ''
}

function pluginResultText(action: string, res: PluginOpResult): string {
  return `${action}${res.ok ? '成功' : '失败'}${res.exitCode === undefined ? '' : `（exit=${res.exitCode}）`}\n${pluginOutput(res)}`
}


async function refreshPlugins(): Promise<void> {
  const el = document.getElementById('plugin-rows')
  if (!el || !api) return
  el.innerHTML = '<tr><td colspan="4">加载中…</td></tr>'
  const res = await api.plugins.list()
  if (!res.ok || !res.entries) {
    el.innerHTML = ''
    setStatus(`加载失败: ${res.error ?? '未知错误'}`, 'error')
    return
  }
  const sourceLabel: Record<PluginEntry['source'], string> = {
    'builtin-bundle': '内置组合包',
    bundle: '第三方组合包',
    dependency: '普通依赖',
  }
  el.innerHTML = res.entries
    .map((p) => {
      const action = p.builtin
        ? ''
        : `${p.active ? '<span class="status ok">已激活</span><button class="quiet" data-deactivate="' + escapeHtml(p.name) + '">停用</button>' : '<button data-activate="' + escapeHtml(p.name) + '">激活</button>'}<button class="quiet" data-remove="${escapeHtml(p.name)}">移除</button>`
      return `<tr>
        <td>${escapeHtml(p.name)}</td>
        <td>${sourceLabel[p.source]}</td>
        <td>${escapeHtml(p.spec || '—')}</td>
        <td>${action}</td>
      </tr>`
    })
    .join('')
  el.querySelectorAll<HTMLElement>('[data-activate]').forEach((btn) => {
    btn.addEventListener('click', () => void activatePlugin(String(btn.dataset.activate)))
  })
  el.querySelectorAll<HTMLElement>('[data-deactivate]').forEach((btn) => {
    btn.addEventListener('click', () => void deactivatePlugin(String(btn.dataset.deactivate)))
  })
  el.querySelectorAll<HTMLElement>('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => void removePlugin(String(btn.dataset.remove)))
  })
  setStatus(`profile「${res.profile}」共 ${res.entries.length} 个包`)
}

async function activatePlugin(name: string): Promise<void> {
  if (!api) return
  if (!confirm(`确认激活插件「${name}」？\n这会把它写入 profile patch，重启 Harness 后加载。`)) return
  setStatus(`激活中: ${name}`)
  const res = await api.plugins.activate(name)
  setStatus(pluginResultText('激活', res), res.ok ? 'ok' : 'error')
  if (res.ok) await refreshPlugins()
}

async function deactivatePlugin(name: string): Promise<void> {
  if (!api) return
  if (!confirm(`确认停用插件「${name}」？\n只移除 patch 激活行，不卸载 package。`)) return
  setStatus(`停用中: ${name}`)
  const res = await api.plugins.deactivate(name)
  setStatus(pluginResultText('停用', res), res.ok ? 'ok' : 'error')
  if (res.ok) await refreshPlugins()
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
  setStatus(`安装中: ${spec}`)
  const res = await api.plugins.install(spec)
  setStatus(pluginResultText('安装', res), res.ok ? 'ok' : 'error')
  if (res.ok) await refreshPlugins()
}

async function removePlugin(name: string): Promise<void> {
  if (!api) return
  if (!confirm(`确认移除插件「${name}」？`)) return
  setStatus(`移除中: ${name}`)
  const res = await api.plugins.remove(name)
  setStatus(pluginResultText('移除', res), res.ok ? 'ok' : 'error')
  if (res.ok) await refreshPlugins()
}

document.getElementById('plugin-install')?.addEventListener('click', () => void installPlugin())
document.getElementById('plugin-refresh')?.addEventListener('click', () => void refreshPlugins())

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
  mcpDraftRows = [row]
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
  if (!confirm(`确认${action} ${mcpDraftRows.length} 个 MCP 服务器到 profile「web」的 cordis.patch.yml？\n服务器命令将在本机执行（沙箱之外），写入前自动备份。`)) return
  setMcpStatus(`${action}中…`)
  const res = editing
    ? await api.mcp.update({ id: editingMcpId!, row: mcpDraftRows[0] })
    : await api.mcp.apply(mcpDraftRows)
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
const SOURCE_LABEL: Record<string, string> = {
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
  el.innerHTML = '<tr><td colspan="5">加载中…</td></tr>'
  const res = await api.skills.list()
  if (!res.ok || !res.skills) {
    el.innerHTML = ''
    setSkillsStatus(`加载失败: ${res.error ?? ''}`, 'error')
    return
  }
  el.innerHTML = res.skills
    .map(
      (s) => `<tr${s.shadowed ? ' class="dim"' : ''}>
        <td>${s.name}${s.shadowed ? ' <span class="tag">被遮蔽</span>' : ''}</td>
        <td>${s.description || '—'}</td>
        <td>${SOURCE_LABEL[s.source] ?? s.source}</td>
        <td><button data-toggle="${s.path}" data-kind="model" data-value="${s.modelInvocable ? '0' : '1'}">${s.modelInvocable ? '开' : '关'}</button></td>
        <td><button data-toggle="${s.path}" data-kind="user" data-value="${s.userInvocable ? '0' : '1'}">${s.userInvocable ? '开' : '关'}</button></td>
      </tr>`,
    )
    .join('')
  el.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', () =>
      void toggleSkill(
        String((btn as HTMLElement).dataset.toggle),
        (btn as HTMLElement).dataset.kind as 'model' | 'user',
        (btn as HTMLElement).dataset.value === '1',
      ),
    )
  })
  setSkillsStatus(`共 ${res.skills.length} 个 skill（含被遮蔽项）`)
}

async function toggleSkill(path: string, kind: 'model' | 'user', value: boolean): Promise<void> {
  if (!api) return
  const label = kind === 'model' ? '模型可见' : '用户可见'
  if (!confirm(`确认将「${path.split('/').pop()}」的${label}切换为${value ? '开启' : '关闭'}？`)) return
  const res = await api.skills.toggle({ path, kind, value })
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
  const overwrite = confirm('确认从 GitHub 导入该 skill 到 ~/.dsh/skills？\n（若已存在同名 skill 将覆盖）')
  setImportStatus(`下载导入中: ${url}`)
  const res = await api.skills.importUrl(url, overwrite)
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
  const overwrite = confirm(`确认导入「${file.name}」到 ~/.dsh/skills？\n（若已存在同名 skill 将覆盖）`)
  setImportStatus(`导入中: ${file.name}`)
  const buffer = await file.arrayBuffer()
  const res = await api.skills.importFile(buffer, overwrite)
  setImportStatus(
    res.ok ? `导入成功: ${res.result?.name}（${res.result?.installed.length} 个文件）` : `导入失败: ${res.error ?? ''}`,
    res.ok ? 'ok' : 'error',
  )
  input.value = ''
  if (res.ok) await refreshSkills()
}

document.getElementById('skill-import-url-btn')?.addEventListener('click', () => void importFromUrl())
document.getElementById('skill-import-file')?.addEventListener('click', () => void importFromFile())

// ---- Harness 面板：内嵌官方 Web UI ----
async function mountHarness(): Promise<void> {
  const frame = document.getElementById('harness-frame') as HTMLIFrameElement | null
  if (!frame || !api) return
  const url = await api.harness.url()
  if (!url) return
  frame.src = url
}

if (api) {
  void refreshPlugins()
  void refreshMcpServers()
  void refreshSkills()
  void mountHarness()
}
