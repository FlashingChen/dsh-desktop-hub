// 渲染进程：Tab 切换 + Plugin 面板（M2）
// 注意：本文件不得包含 import/export（浏览器普通脚本，CSP 禁止模块加载）

interface PluginEntry {
  name: string
  spec: string
  inBundles: boolean
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
  error?: string
}

interface DesktopApi {
  versions: { electron: string; node: string; chrome: string }
  plugins: {
    list: () => Promise<PluginListResult>
    install: (spec: string) => Promise<PluginOpResult>
    remove: (name: string) => Promise<PluginOpResult>
    update: () => Promise<PluginOpResult>
  }
  mcp: {
    list: () => Promise<McpListResult>
    convert: (jsonText: string) => Promise<McpConvertResult>
    apply: (rows: unknown[]) => Promise<McpApplyResult>
  }
  skills: {
    list: () => Promise<SkillsListResult>
    create: (input: { name: string; description: string; body: string }) => Promise<SkillsOpResult>
    toggle: (input: { path: string; kind: 'model' | 'user'; value: boolean }) => Promise<SkillsOpResult>
  }
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

interface McpListResult {
  ok: boolean
  profile?: string
  servers?: { id: string; config: Record<string, unknown> }[]
  error?: string
}

interface McpConvertResult {
  ok: boolean
  rows?: unknown[]
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

function switchTab(id: TabId): void {
  for (const t of TABS) {
    document.querySelector(`[data-tab="${t}"]`)?.classList.toggle('active', t === id)
    document.getElementById(`panel-${t}`)?.classList.toggle('active', t === id)
  }
}

for (const t of TABS) {
  document.querySelector(`[data-tab="${t}"]`)?.addEventListener('click', () => switchTab(t))
}

function setStatus(text: string, kind: 'error' | 'ok' = 'ok'): void {
  const el = document.getElementById('plugin-status')
  if (!el) return
  el.textContent = text
  el.className = `status ${kind}`
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
    .map(
      (p) =>
        `<tr>
          <td>${p.name}</td>
          <td>${sourceLabel[p.source]}</td>
          <td>${p.spec || '—'}</td>
          <td>${p.builtin ? '' : `<button data-remove="${p.name}">移除</button>`}</td>
        </tr>`,
    )
    .join('')
  el.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => void removePlugin(String((btn as HTMLElement).dataset.remove)))
  })
  setStatus(`profile「${res.profile}」共 ${res.entries.length} 个包`)
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
  setStatus(`安装${res.ok ? '成功' : '失败'}（exit=${res.exitCode}）\n${res.output ?? res.error ?? ''}`, res.ok ? 'ok' : 'error')
  if (res.ok) await refreshPlugins()
}

async function removePlugin(name: string): Promise<void> {
  if (!api) return
  if (!confirm(`确认移除插件「${name}」？`)) return
  setStatus(`移除中: ${name}`)
  const res = await api.plugins.remove(name)
  setStatus(`移除${res.ok ? '成功' : '失败'}（exit=${res.exitCode}）\n${res.output ?? res.error ?? ''}`, res.ok ? 'ok' : 'error')
  if (res.ok) await refreshPlugins()
}

document.getElementById('plugin-install')?.addEventListener('click', () => void installPlugin())
document.getElementById('plugin-refresh')?.addEventListener('click', () => void refreshPlugins())

// ---- MCP 面板 ----
let mcpRows: unknown[] = []

function setMcpStatus(text: string, kind: 'error' | 'ok' = 'ok'): void {
  const el = document.getElementById('mcp-warnings')
  if (!el) return
  el.textContent = text
  el.className = `status ${kind}`
}

async function refreshMcpServers(): Promise<void> {
  if (!api) return
  const el = document.getElementById('mcp-servers')
  if (!el) return
  const res = await api.mcp.list()
  el.textContent = res.ok ? `profile「${res.profile}」现有 MCP 服务器: ${res.servers?.length ?? 0}` : `加载失败: ${res.error ?? ''}`
  el.className = `status ${res.ok ? 'ok' : 'error'}`
}

async function convertPreview(): Promise<void> {
  const input = document.getElementById('mcp-json') as HTMLTextAreaElement | null
  const preview = document.getElementById('mcp-preview') as HTMLPreElement | null
  if (!input || !preview || !api) return
  const text = input.value.trim()
  if (!text) {
    setMcpStatus('请先粘贴 JSON', 'error')
    preview.textContent = ''
    return
  }
  const res = await api.mcp.convert(text)
  if (!res.ok) {
    setMcpStatus(`转换失败: ${res.error ?? ''}`, 'error')
    preview.textContent = ''
    mcpRows = []
    return
  }
  mcpRows = res.rows ?? []
  preview.textContent = res.yaml ?? ''
  setMcpStatus(`转换成功: ${mcpRows.length} 个服务器${res.warnings && res.warnings.length ? `\n警告: ${res.warnings.join('；')}` : ''}`, 'ok')
}

async function applyMcp(): Promise<void> {
  if (!api) return
  if (mcpRows.length === 0) {
    setMcpStatus('请先转换得到 YAML 再写入', 'error')
    return
  }
  if (!confirm(`确认将 ${mcpRows.length} 个 MCP 服务器写入 profile「web」的 cordis.patch.yml？\n服务器命令将在本机执行（沙箱之外），写入前自动备份。`)) return
  setMcpStatus('写入中…')
  const res = await api.mcp.apply(mcpRows)
  setMcpStatus(res.ok ? `写入成功（备份: ${res.backup}），HMR 热生效中` : `写入失败: ${res.error ?? ''}`, res.ok ? 'ok' : 'error')
  await refreshMcpServers()
}

document.getElementById('mcp-convert')?.addEventListener('click', () => void convertPreview())
document.getElementById('mcp-apply')?.addEventListener('click', () => void applyMcp())
document.getElementById('mcp-list')?.addEventListener('click', () => void refreshMcpServers())

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

if (api) {
  const el = document.getElementById('footer-versions')
  if (el) {
    el.textContent = `Electron ${api.versions.electron} · Node ${api.versions.node} · Chromium ${api.versions.chrome}`
  }
  void refreshPlugins()
  void refreshMcpServers()
  void refreshSkills()
}
