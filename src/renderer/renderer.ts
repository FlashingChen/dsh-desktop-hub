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

interface PluginInstallPlan {
  ok: boolean
  kind?: 'plugin' | 'routing-suite'
  normalized?: string
  error?: string
}

interface PluginOpDone {
  token: string
  exitCode: number | null
  signal: string | null
  output: string
}

type UpdateState = 'idle' | 'unsupported' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'

interface UpdateStatus {
  state: UpdateState
  currentVersion: string
  version?: string
  releaseName?: string
  releaseDate?: string
  percent?: number
  error?: string
}

interface UpdateActionResult {
  ok: boolean
  status: UpdateStatus
  error?: string
}

type PluginOpStatus =
  | { state: 'running' }
  | { state: 'done'; done: PluginOpDone }
  | { state: 'unknown' }

type MarketKind = 'plugin' | 'mcp' | 'skill'

interface MarketBaseItem {
  id: string
  kind: MarketKind
  name: string
  description: string
  author: string
  version: string
  category: string
  tags: string[]
  verified: boolean
  permissions: string[]
  source?: string
  sourceUrl?: string
  popularity?: number
  trust?: 'bundled' | 'official' | 'curated' | 'community' | 'unreviewed'
}

interface PluginMarketItem extends MarketBaseItem {
  kind: 'plugin'
  spec: string
  packageName: string
}

interface McpMarketItem extends MarketBaseItem {
  kind: 'mcp'
  row: McpRow
  requiredEnv: string[]
}

interface SkillMarketItem extends MarketBaseItem {
  kind: 'skill'
  install:
    | { type: 'template'; name: string; description: string; body: string }
    | { type: 'github'; name: string; url: string }
    | { type: 'clawhub'; owner: string; slug: string; version: string; name: string }
}

type MarketItem = PluginMarketItem | McpMarketItem | SkillMarketItem

interface MarketListResult {
  ok: boolean
  kind?: MarketKind | 'all'
  items?: MarketItem[]
  online?: boolean
  cached?: boolean
  error?: string
}

interface PluginPreflightResult {
  ok: boolean
  normalizedSpec?: string
  packageName?: string
  version?: string
  bundle?: boolean
  locked?: boolean
  warning?: string
  error?: string
}

interface FeedbackSubmitResult {
  ok: boolean
  status?: 'queued' | 'accepted'
  receiptId?: string
  code?: string
  message?: string
  retryable?: boolean
}

interface DesktopApi {
  harness: {
    url: () => Promise<string | null>
    restart: () => Promise<{ ok: boolean; url?: string; error?: string }>
    onFrameLoaded: (cb: (url: string) => void) => void
    onStatus: (cb: (status: { state: string; url?: string; code?: number | null }) => void) => void
  }
  updates: {
    status: () => Promise<UpdateStatus>
    check: () => Promise<UpdateActionResult>
    download: () => Promise<UpdateActionResult>
    install: () => Promise<UpdateActionResult>
    onStatus: (cb: (status: UpdateStatus) => void) => void
  }
  plugins: {
    list: () => Promise<PluginListResult>
    activate: (name: string) => Promise<{ ok: boolean; output?: string; error?: string }>
    deactivate: (name: string) => Promise<{ ok: boolean; output?: string; error?: string }>
    prepareInstall: (spec: string) => Promise<PluginInstallPlan>
    startOp: (action: 'add' | 'remove' | 'update', args: string[]) => Promise<PluginOpStarted>
    cancelOp: (token: string) => Promise<{ ok: boolean }>
    opStatus: (token: string) => Promise<PluginOpStatus>
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
    create: (input: { name: string; description: string; body: string; overwrite?: boolean }) => Promise<{ ok: boolean; path?: string; error?: string }>
    toggle: (input: { id: string; source: string; kind: 'model' | 'user'; value: boolean }) => Promise<{ ok: boolean; error?: string }>
    importFile: (buffer: ArrayBuffer, overwrite: boolean) => Promise<SkillsImportResult>
    importUrl: (url: string, overwrite: boolean) => Promise<SkillsImportResult>
    importClawHub: (input: { owner: string; slug: string; version?: string }, overwrite: boolean) => Promise<SkillsImportResult>
  }
  market: {
    list: (kind: MarketKind, query?: string) => Promise<MarketListResult>
    preflightPlugin: (spec: string) => Promise<PluginPreflightResult>
  }
  feedback: {
    diagnostics: () => Promise<{ ok: boolean; text?: string; error?: string }>
    copy: (text: string) => Promise<{ ok: boolean; error?: string }>
    submit: (input: {
      mode: 'anonymous' | 'signed'
      category: 'bug' | 'feature' | 'other'
      title: string
      body: string
      signature?: string | null
      diagnostics?: string | null
    }) => Promise<FeedbackSubmitResult>
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

const TABS = ['harness', 'plugin', 'mcp', 'skills', 'feedback'] as const
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
  if (id === 'feedback') void refreshFeedbackDiagnostics()
}

harnessFullscreenButton?.addEventListener('click', () => {
  setHarnessFullscreen(!document.body.classList.contains('harness-fullscreen'))
})

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  if (document.body.classList.contains('harness-fullscreen')) setHarnessFullscreen(false)
  if (harnessMenu && !harnessMenu.hidden) setHarnessMenuOpen(false)
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
let pluginOpStarting = false
let opResultText = ''
let activeOpAfterDone: ((done: PluginOpDone) => void | Promise<void>) | null = null
let opRecoveryTimer: number | null = null
const OP_RECOVERY_DELAY_MS = 5 * 60_000

function clearOpRecoveryTimer(): void {
  if (opRecoveryTimer === null) return
  window.clearTimeout(opRecoveryTimer)
  opRecoveryTimer = null
}

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
    installedPluginEntries = []
    setStatus(`加载失败: ${res.error ?? '未知错误'}`, 'error')
    renderMarket('plugin')
    return
  }
  installedPluginEntries = res.entries
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
        span.title = '已写入 profile bundle；安装或变更后需重启 Harness 才会出现在运行中的 Web 界面'
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
  renderMarket('plugin')
}

async function activatePlugin(name: string): Promise<void> {
  if (!api) return
  if (!confirm(`确认激活插件「${name}」？\n激活后会自动重启 Harness，使它出现在运行中的 Web 界面。`)) return
  setStatus(`激活中: ${name}`)
  const res = await api.plugins.activate(name)
  setStatus(res.ok ? (res.output ?? '激活成功') : `激活失败: ${res.error ?? ''}`, res.ok ? 'ok' : 'error')
  if (res.ok) {
    await refreshPlugins()
    await restartHarnessForPluginChange(`插件「${name}」激活`)
  }
}

async function deactivatePlugin(name: string): Promise<void> {
  if (!api) return
  if (!confirm(`确认停用插件「${name}」？\n只移除 patch 激活行，不卸载 package。停用后会自动重启 Harness。`)) return
  setStatus(`停用中: ${name}`)
  const res = await api.plugins.deactivate(name)
  setStatus(res.ok ? (res.output ?? '停用成功') : `停用失败: ${res.error ?? ''}`, res.ok ? 'ok' : 'error')
  if (res.ok) {
    await refreshPlugins()
    await restartHarnessForPluginChange(`插件「${name}」停用`)
  }
}

function scheduleOpRecovery(token: string): void {
  clearOpRecoveryTimer()
  opRecoveryTimer = window.setTimeout(() => {
    opRecoveryTimer = null
    void recoverPluginOp(token)
  }, OP_RECOVERY_DELAY_MS)
}

async function recoverPluginOp(token: string, announceRunning = true): Promise<void> {
  if (!api || token !== activeOpToken) return
  try {
    const status = await api.plugins.opStatus(token)
    if (token !== activeOpToken) return
    if (status.state === 'done' && status.done) {
      handlePluginOpDone(status.done)
      return
    }
    if (status.state === 'unknown') {
      // 主进程已没有该操作：继续保持 token 只会把前端永久锁死，安全地回到可重试状态。
      activeOpToken = null
      activeOpAfterDone = null
      setOpControls(false)
      setStatus('插件操作状态已丢失，已解除锁定，请重试', 'error')
      return
    }
    if (announceRunning) setStatus('插件操作仍在进行中，请等待完成或取消', 'ok')
  } catch {
    // 查询失败不擅自放行，稍后重试；取消仍可由用户主动触发。
  }
  if (token === activeOpToken) scheduleOpRecovery(token)
}

async function runPluginOpUi(
  action: 'add' | 'remove' | 'update',
  args: string[],
  label: string,
  afterDone?: (done: PluginOpDone) => void | Promise<void>,
): Promise<void> {
  if (!api) return
  if (activeOpToken || pluginOpStarting) {
    setStatus('已有插件操作进行中，请等待完成或取消', 'error')
    return
  }
  pluginOpStarting = true
  activeOpAfterDone = afterDone ?? null
  try {
    const started = await api.plugins.startOp(action, args)
    if (!started.ok || !started.token) {
      activeOpAfterDone = null
      setStatus(`启动失败: ${started.error ?? ''}`, 'error')
      return
    }
    activeOpToken = started.token
    opResultText = ''
    setOpControls(true)
    setStatus(`${label}中…（输出如下，可取消）`, 'ok')
    // done push 可能早于 invoke 响应；立即查询一次权威终态，避免等到 watchdog。
    void recoverPluginOp(started.token, false)
  } catch (error) {
    activeOpAfterDone = null
    setStatus(`启动失败: ${error instanceof Error ? error.message : String(error)}`, 'error')
  } finally {
    pluginOpStarting = false
  }
}

async function installPlugin(): Promise<void> {
  const input = document.getElementById('plugin-spec') as HTMLInputElement | null
  if (!input || !api) return
  const raw = input.value.trim()
  if (!raw) {
    setStatus('请输入包名、GitHub 链接或 github:owner/repo#commit', 'error')
    return
  }
  const plan = await api.plugins.prepareInstall(raw)
  if (!plan.ok || !plan.normalized) {
    setStatus(`安装前检查失败: ${plan.error ?? '插件 spec 无效'}`, 'error')
    return
  }
  const spec = plan.normalized
  const display = raw === spec ? spec : `${raw}\n归一化为：${spec}`
  if (!confirm(`确认安装插件「${display}」到 profile「web」？\n安装完成后会自动重启 Harness，使插件生效。\n插件代码将在本机执行（沙箱之外）。\n若 pnpm 拒绝构建脚本，会列出明确报告的包并逐包再次确认；允许后才写入 allowBuilds 并重试。`)) return
  await runPluginOpUi('add', [spec], '安装', async () => {
    await refreshPlugins()
    await restartHarnessForPluginChange(`插件「${spec}」安装`)
  })
}

async function removePlugin(name: string): Promise<void> {
  if (!api) return
  if (!confirm(`确认移除插件「${name}」？\n若存在 patch 激活行将一并清理，完成后会自动重启 Harness。`)) return
  await runPluginOpUi('remove', [name], '移除', async () => {
    await restartHarnessForPluginChange(`插件「${name}」移除`)
  })
}

async function updateAllPlugins(): Promise<void> {
  if (!api) return
  if (!confirm('确认更新 profile「web」的全部插件？\n将执行 dsh plugin update，完成后会自动重启 Harness。\n更新可能执行第三方 pnpm 构建脚本；如需授权会逐包再次确认。')) return
  await runPluginOpUi('update', [], '更新', async () => {
    await refreshPlugins()
    await restartHarnessForPluginChange('插件更新')
  })
}

async function cancelPluginOp(): Promise<void> {
  if (!api || !activeOpToken) return
  const token = activeOpToken
  const res = await api.plugins.cancelOp(token)
  if (!res.ok) {
    // 进程可能已经结束但 done push 丢失；立即向主进程查询一次，避免还要等 watchdog。
    await recoverPluginOp(token)
    return
  }
  setStatus('已发送取消请求（SIGTERM）', 'ok')
}

function handlePluginOpDone(done: PluginOpDone): void {
  if (done.token !== activeOpToken) return
  const afterDone = activeOpAfterDone
  activeOpAfterDone = null
  activeOpToken = null
  clearOpRecoveryTimer()
  setOpControls(false)
  appendOpOutput(done.output)
  const head = done.exitCode === 0 ? '操作成功' : `操作失败（exit=${done.exitCode ?? 'signal ' + (done.signal ?? '?')}）`
  setStatus(`${head}\n${opResultText.slice(-2000)}`, done.exitCode === 0 ? 'ok' : 'error')
  void (async () => {
    await refreshPlugins()
    if (done.exitCode === 0 && afterDone) await afterDone(done)
  })()
}

api?.plugins.onOpChunk((token, text) => {
  if (token !== activeOpToken) return
  appendOpOutput(text)
  setStatus(opResultText, 'ok')
})

api?.plugins.onOpDone(handlePluginOpDone)

document.getElementById('plugin-install')?.addEventListener('click', () => void installPlugin())
document.getElementById('plugin-refresh')?.addEventListener('click', () => void refreshPlugins())
document.getElementById('plugin-update-all')?.addEventListener('click', () => void updateAllPlugins())
document.getElementById('plugin-cancel')?.addEventListener('click', () => void cancelPluginOp())

// ---- 扩展市场：三个市场共享目录加载、搜索与卡片交互 ----
const marketItems: Record<MarketKind, MarketItem[]> = { plugin: [], mcp: [], skill: [] }
const marketSearchTimers: Partial<Record<MarketKind, number>> = {}
const marketRequestSeq: Record<MarketKind, number> = { plugin: 0, mcp: 0, skill: 0 }
const marketVisibleLimits: Record<MarketKind, number> = { plugin: 60, mcp: 60, skill: 60 }
let installedPluginEntries: PluginEntry[] = []
let installedSkillEntries: SkillsSummary[] = []
/** ClawHub 的 SKILL.md frontmatter 可能给出不同于 slug 的规范名；记录本次导入返回的真实目录名。 */
const marketSkillAliases = new Map<string, string>()

const marketPanelNames: Record<MarketKind, string> = { plugin: 'plugin', mcp: 'mcp', skill: 'skills' }

function setMarketMode(kind: MarketKind, mode: 'market' | 'manage'): void {
  const suffix = marketPanelNames[kind]
  const switcher = document.querySelector<HTMLElement>(`.market-switcher[data-market-kind="${kind}"]`)
  switcher?.querySelectorAll<HTMLButtonElement>('[data-market-mode]').forEach((button) => {
    const active = button.dataset.marketMode === mode
    button.classList.toggle('active', active)
    button.setAttribute('aria-selected', String(active))
  })
  const market = document.getElementById(`${suffix}-market-view`)
  const manage = document.getElementById(`${suffix}-manage-view`)
  if (market) market.hidden = mode !== 'market'
  if (manage) manage.hidden = mode !== 'manage'
}

document.querySelectorAll<HTMLElement>('.market-switcher').forEach((switcher) => {
  const kind = switcher.dataset.marketKind as MarketKind
  if (kind !== 'plugin' && kind !== 'mcp' && kind !== 'skill') return
  switcher.querySelectorAll<HTMLButtonElement>('[data-market-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.dataset.marketMode === 'manage' ? 'manage' : 'market'
      setMarketMode(kind, mode)
    })
  })
})

function marketMatches(item: MarketItem, query: string): boolean {
  if (!query.trim()) return true
  const haystack = [item.name, item.description, item.author, item.category, ...item.tags].join(' ').toLowerCase()
  return query.toLowerCase().trim().split(/\s+/).every((term) => haystack.includes(term))
}

function marketPluginIdentities(item: PluginMarketItem): string[] {
  return [item.packageName, item.spec]
    .flatMap((value) => {
      const lower = value.toLowerCase().trim()
      const clean = lower.replace(/^github:/, '').split('#')[0]
      return [lower, clean, clean.split('/').pop() ?? clean]
    })
}

function pluginSpecIdentity(value: string): string {
  return value.toLowerCase().trim().replace(/^github:/, '').split('#')[0]
}

const MCP_ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

function collectMcpEnvNames(value: unknown, names: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(MCP_ENV_REF)) names.add(match[1])
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectMcpEnvNames(entry, names))
    return
  }
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((entry) => collectMcpEnvNames(entry, names))
  }
}

function marketMcpEnvNames(item: McpMarketItem): string[] {
  const names = new Set(item.requiredEnv)
  collectMcpEnvNames(item.row.config, names)
  return [...names]
}

function fillMcpEnvValues(value: unknown, envValues: Record<string, string>): unknown {
  if (typeof value === 'string') return value.replace(MCP_ENV_REF, (_match, name: string) => envValues[name] ?? _match)
  if (Array.isArray(value)) return value.map((entry) => fillMcpEnvValues(entry, envValues))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, fillMcpEnvValues(entry, envValues)]))
  }
  return value
}

function marketPluginInstalledEntry(item: PluginMarketItem): PluginEntry | undefined {
  const identities = marketPluginIdentities(item)
  const specIdentity = pluginSpecIdentity(item.spec)
  return installedPluginEntries.find((entry) =>
    identities.includes(entry.name.toLowerCase()) ||
    (entry.spec !== '' && pluginSpecIdentity(entry.spec) === specIdentity),
  )
}

function marketSkillNames(item: SkillMarketItem): Set<string> {
  const names = new Set([item.install.name])
  if (item.install.type === 'clawhub') {
    names.add(item.install.slug)
    names.add(item.name)
    const alias = marketSkillAliases.get(item.id)
    if (alias) names.add(alias)
  }
  return names
}

function marketIsInstalled(item: MarketItem): boolean {
  if (item.kind === 'plugin') return marketPluginInstalledEntry(item) !== undefined
  if (item.kind === 'mcp') {
    const serverName = typeof item.row.config.serverName === 'string' ? item.row.config.serverName : item.row.id
    return managedMcpRows.some((row) => row.id === item.row.id || row.config.serverName === serverName)
  }
  const names = marketSkillNames(item)
  return installedSkillEntries.some((skill) => names.has(skill.name) && !skill.shadowed)
}

function appendMarketText(parent: HTMLElement, className: string, text: string): HTMLElement {
  const node = document.createElement('span')
  node.className = className
  node.textContent = text
  parent.appendChild(node)
  return node
}

function createMarketCard(item: MarketItem): HTMLElement {
  const card = document.createElement('article')
  card.className = 'market-card'
  const head = document.createElement('div')
  head.className = 'market-card-head'
  const titleWrap = document.createElement('div')
  appendMarketText(titleWrap, 'market-card-title', item.name)
  appendMarketText(titleWrap, 'market-card-author', `${item.author} · ${item.version}`)
  head.appendChild(titleWrap)
  if (item.verified) appendMarketText(head, 'market-verified', 'DSH 已验证')
  else if (item.trust) {
    const trustLabels: Record<NonNullable<MarketBaseItem['trust']>, string> = {
      bundled: '随包内置',
      official: '官方目录',
      curated: '社区精选',
      community: '社区来源',
      unreviewed: '未审阅',
    }
    appendMarketText(head, 'market-trust', trustLabels[item.trust])
  }
  card.appendChild(head)

  appendMarketText(card, 'market-card-description', item.description)
  if (item.sourceUrl && /^https?:\/\//i.test(item.sourceUrl)) {
    const sourceLink = document.createElement('a')
    sourceLink.className = 'market-source-link'
    sourceLink.href = item.sourceUrl
    sourceLink.target = '_blank'
    sourceLink.rel = 'noreferrer noopener'
    sourceLink.textContent = '查看来源 ↗'
    card.appendChild(sourceLink)
  }
  const meta = document.createElement('div')
  meta.className = 'market-card-meta'
  appendMarketText(meta, '', item.category)
  if (item.source) appendMarketText(meta, '', item.source)
  if (typeof item.popularity === 'number' && item.popularity > 0) appendMarketText(meta, '', `热度 ${Math.round(item.popularity)}`)
  item.tags.slice(0, 4).forEach((tag) => appendMarketText(meta, '', `#${tag}`))
  card.appendChild(meta)

  const mcpEnvNames = item.kind === 'mcp' ? marketMcpEnvNames(item) : []
  if (item.kind === 'mcp' && mcpEnvNames.length > 0) {
    const env = document.createElement('div')
    env.className = 'market-env-fields'
    appendMarketText(env, 'market-env-title', '安装前填写以下环境变量（值会写入当前 profile，无需自行设置系统环境）')
    mcpEnvNames.forEach((name) => {
      const field = document.createElement('div')
      field.className = 'market-env-field'
      const label = document.createElement('label')
      label.textContent = name
      const input = document.createElement('input')
      input.type = 'password'
      input.autocomplete = 'off'
      input.spellcheck = false
      input.required = true
      input.placeholder = `填写 ${name}`
      input.dataset.mcpEnv = name
      field.append(label, input)
      env.appendChild(field)
    })
    card.appendChild(env)
  }
  if (item.permissions.length > 0) {
    const permissions = document.createElement('div')
    permissions.className = 'market-permissions'
    appendMarketText(permissions, 'market-permission', `权限：${item.permissions.join('；')}`)
    card.appendChild(permissions)
  }

  const footer = document.createElement('div')
  footer.className = 'market-card-footer'
  const installedPlugin = item.kind === 'plugin' ? marketPluginInstalledEntry(item) : undefined
  const installed = item.kind === 'plugin' ? installedPlugin !== undefined : marketIsInstalled(item)
  const activePlugin = installedPlugin && installedPlugin.activationSource !== 'none'
  const statusText = item.kind === 'plugin'
    ? activePlugin ? '已激活' : installed ? '已安装 · 未激活' : '未安装'
    : installed ? '已安装' : '未安装'
  appendMarketText(footer, 'status', statusText)
  const action = document.createElement('button')
  const needsPluginActivation = item.kind === 'plugin' && installedPlugin !== undefined && !activePlugin
  action.className = installed && !needsPluginActivation ? '' : 'primary'
  action.disabled = installed && !needsPluginActivation
  action.textContent = activePlugin ? '已激活' : needsPluginActivation ? '激活' : item.kind === 'plugin' ? '安装并激活' : '安装'
  action.addEventListener('click', () => {
    if (item.kind === 'plugin') {
      if (needsPluginActivation && installedPlugin) void activatePlugin(installedPlugin.name)
      else void installMarketPlugin(item)
    } else if (item.kind === 'mcp') {
      const envValues = Object.fromEntries(
        mcpEnvNames.map((name) => [name, (card.querySelector(`[data-mcp-env="${name}"]`) as HTMLInputElement | null)?.value ?? '']),
      )
      void installMarketMcp(item, envValues)
    } else void installMarketSkill(item)
  })
  footer.appendChild(action)
  card.appendChild(footer)
  return card
}

function renderMarket(kind: MarketKind): void {
  const suffix = marketPanelNames[kind]
  const grid = document.getElementById(`${suffix}-market-grid`)
  if (!grid) return
  const search = (document.getElementById(`${suffix}-market-search`) as HTMLInputElement | null)?.value.trim() ?? ''
  const items = marketItems[kind].filter((item) => marketMatches(item, search))
  grid.replaceChildren()
  if (items.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'market-empty'
    empty.textContent = search ? '没有匹配的扩展' : '目录暂时为空'
    grid.appendChild(empty)
    return
  }
  const visible = items.slice(0, marketVisibleLimits[kind])
  visible.forEach((item) => grid.appendChild(createMarketCard(item)))
  if (items.length > visible.length) {
    const more = document.createElement('button')
    more.className = 'market-load-more'
    more.type = 'button'
    more.textContent = `加载更多（还有 ${items.length - visible.length} 个）`
    more.addEventListener('click', () => {
      marketVisibleLimits[kind] += 60
      renderMarket(kind)
    })
    grid.appendChild(more)
  }
}

function setMarketCaption(kind: MarketKind, online: boolean, cached: boolean, error?: string): void {
  const suffix = marketPanelNames[kind]
  const caption = document.querySelector<HTMLElement>(`#${suffix}-market-view .market-toolbar-caption`)
  if (!caption) return
  caption.textContent = online ? error ? '在线目录 · 部分来源不可用' : '在线目录 · 安装前显示权限' : cached ? '网络不可用 · 显示上次缓存' : '网络不可用 · 显示随包精选'
  caption.title = error ?? ''
}

async function refreshMarket(kind: MarketKind, query = ''): Promise<void> {
  if (!api) return
  const requestId = ++marketRequestSeq[kind]
  const res = await api.market.list(kind, query)
  if (requestId !== marketRequestSeq[kind]) return
  if (!res.ok || !res.items) {
    marketItems[kind] = []
    setMarketCaption(kind, false, false, res.error)
    renderMarket(kind)
    return
  }
  marketItems[kind] = res.items
  marketVisibleLimits[kind] = 60
  setMarketCaption(kind, res.online === true, res.cached === true, res.error)
  renderMarket(kind)
}

function refreshAllMarkets(): void {
  ;(['plugin', 'mcp', 'skill'] as MarketKind[]).forEach((kind) => void refreshMarket(kind))
}

async function installMarketPlugin(item: PluginMarketItem): Promise<void> {
  if (!api) return
  setStatus(`正在预检插件：${item.name}`)
  const preflight = await api.market.preflightPlugin(item.spec)
  if (!preflight.ok || !preflight.normalizedSpec) {
    setStatus(`插件预检失败：${preflight.error ?? '未声明 dsh.bundle，已拒绝安装'}`, 'error')
    return
  }
  const lockedSpec = preflight.normalizedSpec
  const versionText = preflight.version ? `\n版本：${preflight.version}` : ''
  const warningText = preflight.warning ? `\n注意：${preflight.warning}` : ''
  if (!confirm(`确认安装并激活「${item.name}」？\n安装来源：${lockedSpec}${versionText}${warningText}\n安装完成后会自动重启 Harness，使插件出现在运行中的 Web 界面。\n插件代码将在本机执行（沙箱之外）。\n若 pnpm 拒绝构建脚本，会列出明确报告的包并逐包再次确认；允许后才写入 allowBuilds 并重试。`)) return
  setMarketMode('plugin', 'manage')
  await runPluginOpUi('add', [lockedSpec], '安装', async () => {
    const packageName = preflight.packageName ?? item.packageName
    const entry = installedPluginEntries.find((candidate) => candidate.name.toLowerCase() === packageName.toLowerCase())
    if (!entry) {
      setStatus(`已安装「${item.name}」，但未在 profile 清单找到 ${packageName}；请在已安装列表手动激活。`, 'error')
      return
    }
    if (entry.activationSource === 'none') {
      const activated = await api.plugins.activate(entry.name)
      if (!activated.ok) {
        setStatus(`已安装但激活失败：${activated.error ?? '请在已安装列表手动激活'}`, 'error')
        await refreshPlugins()
        return
      }
    }
    await refreshPlugins()
    await restartHarnessForPluginChange(`插件「${item.name}」安装并激活`)
  })
}

async function installMarketMcp(item: McpMarketItem, envValues: Record<string, string> = {}): Promise<void> {
  if (!api) return
  const envNames = marketMcpEnvNames(item)
  const missing = envNames.filter((name) => envValues[name] === undefined || envValues[name] === '')
  if (missing.length > 0) {
    setMcpStatus(`请先填写环境变量：${missing.join('、')}`, 'error')
    return
  }
  const config = fillMcpEnvValues(item.row.config, envValues) as Record<string, unknown>
  if (envNames.length > 0) {
    const existingEnv = config.env && typeof config.env === 'object' && !Array.isArray(config.env)
      ? { ...(config.env as Record<string, unknown>) }
      : {}
    // requiredEnv 是安装契约，不应只在模板碰巧含有 ${VAR} 占位符时才生效。
    for (const name of envNames) existingEnv[name] = envValues[name]
    config.env = existingEnv
  }
  const row: McpRow = { ...item.row, config }
  const envHint = envNames.length > 0 ? `\n已填写：${envNames.join('、')}（值会写入当前 profile）` : ''
  if (!confirm(`确认安装 MCP「${item.name}」？\n服务器命令将在本机执行（沙箱之外）。${envHint}`)) return
  setMarketMode('mcp', 'manage')
  setMcpStatus(`安装 MCP 中: ${item.name}`)
  const res = await api.mcp.apply({ rows: [row], mode: 'merge' })
  setMcpStatus(res.ok ? `已安装「${item.name}」（备份: ${res.backup}），配置已写入` : `安装失败: ${res.error ?? ''}`, res.ok ? 'ok' : 'error')
  if (res.ok) {
    await refreshMcpServers()
    renderMarket('mcp')
  }
}

async function installMarketSkill(item: SkillMarketItem): Promise<void> {
  if (!api) return
  const exists = marketIsInstalled(item)
  const prompt = exists
    ? `Skill「${item.install.name}」已存在，确认覆盖更新？\n现有 SKILL.md 将被替换。`
    : `确认安装 Skill「${item.name}」到用户级 ~/.dsh/skills？`
  if (!confirm(prompt)) return
  setMarketMode('skill', 'manage')
  setImportStatus(`安装 Skill 中: ${item.name}`)
  const res = item.install.type === 'github'
    ? await api.skills.importUrl(item.install.url, true)
    : item.install.type === 'clawhub'
      ? await api.skills.importClawHub({ owner: item.install.owner, slug: item.install.slug, version: item.install.version }, true)
      : await api.skills.create({
          name: item.install.name,
          description: item.install.description,
          body: item.install.body,
          overwrite: true,
        })
  const installedPath = (res as SkillsImportResult).result?.file ?? (res as { path?: string }).path
  const importedName = 'result' in res ? res.result?.name : undefined
  setImportStatus(res.ok ? `已安装「${item.name}」: ${installedPath ?? ''}` : `安装失败: ${res.error ?? ''}`, res.ok ? 'ok' : 'error')
  if (res.ok && item.install.type === 'clawhub' && importedName) {
    // importer 以 SKILL.md frontmatter 的合法 name 为准；同步回卡片，避免本次会话重复安装。
    marketSkillAliases.set(item.id, importedName)
    item.install.name = importedName
  }
  if (res.ok) {
    await refreshSkills()
    renderMarket('skill')
  }
}

for (const kind of ['plugin', 'mcp', 'skill'] as MarketKind[]) {
  const suffix = marketPanelNames[kind]
  document.getElementById(`${suffix}-market-search`)?.addEventListener('input', () => {
    const input = document.getElementById(`${suffix}-market-search`) as HTMLInputElement | null
    marketVisibleLimits[kind] = 60
    renderMarket(kind)
    if (marketSearchTimers[kind] !== undefined) window.clearTimeout(marketSearchTimers[kind])
    marketSearchTimers[kind] = window.setTimeout(() => void refreshMarket(kind, input?.value.trim() ?? ''), 350)
  })
  document.getElementById(`${suffix}-market-refresh`)?.addEventListener('click', () => {
    const input = document.getElementById(`${suffix}-market-search`) as HTMLInputElement | null
    void refreshMarket(kind, input?.value.trim() ?? '')
  })
}

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
  renderMarket('mcp')
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
    installedSkillEntries = []
    setSkillsStatus(`加载失败: ${res.error ?? '未知错误'}`, 'error')
    renderMarket('skill')
    return
  }
  installedSkillEntries = res.skills
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
  renderMarket('skill')
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

// ---- Feedback 面板：隐私选择 + 诊断复制 + 反馈 API ----
type FeedbackMode = 'anonymous' | 'signed'
type FeedbackCategory = 'bug' | 'feature' | 'other'

let feedbackMode: FeedbackMode = 'anonymous'
let feedbackDiagnosticsText = ''
let feedbackDiagnosticsLoaded = false
let feedbackSubmitting = false

function setFeedbackStatus(text: string, kind: 'error' | 'ok' | 'warn' = 'ok'): void {
  const el = document.getElementById('feedback-status')
  if (!el) return
  el.textContent = text
  el.className = `status ${kind} inline-status`
}

function setFeedbackMode(mode: FeedbackMode): void {
  feedbackMode = mode
  document.querySelectorAll<HTMLButtonElement>('[data-feedback-mode]').forEach((button) => {
    const active = button.dataset.feedbackMode === mode
    button.classList.toggle('active', active)
    button.setAttribute('aria-selected', String(active))
  })
  const signature = document.getElementById('feedback-signature-field')
  if (signature) signature.hidden = mode !== 'signed'
  const input = document.getElementById('feedback-signature') as HTMLInputElement | null
  if (input) {
    input.required = mode === 'signed'
    if (mode !== 'signed') input.value = ''
  }
}

function feedbackCategory(): FeedbackCategory {
  const value = (document.getElementById('feedback-category') as HTMLSelectElement | null)?.value
  return value === 'feature' || value === 'other' ? value : 'bug'
}

function feedbackInput(includeDiagnostics = false): {
  mode: FeedbackMode
  category: FeedbackCategory
  title: string
  body: string
  signature: string | null
  diagnostics: string | null
} {
  return {
    mode: feedbackMode,
    category: feedbackCategory(),
    title: (document.getElementById('feedback-title') as HTMLInputElement | null)?.value ?? '',
    body: (document.getElementById('feedback-body') as HTMLTextAreaElement | null)?.value ?? '',
    signature: feedbackMode === 'signed' ? (document.getElementById('feedback-signature') as HTMLInputElement | null)?.value ?? '' : null,
    diagnostics: includeDiagnostics && feedbackDiagnosticsText ? feedbackDiagnosticsText : null,
  }
}

function feedbackDocument(input: ReturnType<typeof feedbackInput>): string {
  const category = input.category === 'bug' ? '问题反馈' : input.category === 'feature' ? '功能建议' : '其他'
  const mode = input.mode === 'signed' ? '署名提交' : '匿名/不署名'
  const lines = [
    '## DSH Desktop Hub 反馈',
    '',
    `- 类型：${category}`,
    `- 模式：${mode}`,
    ...(input.mode === 'signed' ? [`- 署名：${input.signature ?? ''}`] : []),
    '',
    `### ${input.title.trim()}`,
    '',
    input.body.trim(),
  ]
  if (input.diagnostics) lines.push('', '### 诊断信息', '', input.diagnostics)
  return `${lines.join('\n')}\n`
}

async function refreshFeedbackDiagnostics(): Promise<void> {
  const pre = document.getElementById('feedback-diagnostics')
  if (!pre || !api) return
  pre.textContent = '读取中…'
  pre.className = 'feedback-diagnostics empty'
  const result = await api.feedback.diagnostics()
  if (!result.ok || !result.text) {
    feedbackDiagnosticsText = ''
    feedbackDiagnosticsLoaded = false
    pre.textContent = result.error ?? '诊断信息暂时不可用'
    pre.className = 'feedback-diagnostics empty'
    return
  }
  feedbackDiagnosticsText = result.text
  feedbackDiagnosticsLoaded = true
  pre.textContent = result.text
  pre.className = 'feedback-diagnostics'
}

async function copyFeedbackText(text: string, label: string): Promise<void> {
  if (!api) return
  if (!text.trim()) {
    setFeedbackStatus(`没有可复制的${label}`, 'error')
    return
  }
  const result = await api.feedback.copy(text)
  setFeedbackStatus(result.ok ? `${label}已复制到剪贴板` : `复制失败：${result.error ?? '未知错误'}`, result.ok ? 'ok' : 'error')
}

async function copyDiagnostics(): Promise<void> {
  if (!feedbackDiagnosticsLoaded) await refreshFeedbackDiagnostics()
  await copyFeedbackText(feedbackDiagnosticsText, '诊断信息')
}

async function copyFullFeedback(): Promise<void> {
  const include = (document.getElementById('feedback-include-diagnostics') as HTMLInputElement | null)?.checked ?? false
  if (include && !feedbackDiagnosticsLoaded) await refreshFeedbackDiagnostics()
  await copyFeedbackText(feedbackDocument(feedbackInput(include)), '完整反馈')
}

async function submitFeedbackUi(): Promise<void> {
  if (!api || feedbackSubmitting) return
  feedbackSubmitting = true
  const submit = document.getElementById('feedback-submit') as HTMLButtonElement | null
  if (submit) submit.disabled = true
  try {
    const include = (document.getElementById('feedback-include-diagnostics') as HTMLInputElement | null)?.checked ?? false
    if (include && !feedbackDiagnosticsLoaded) await refreshFeedbackDiagnostics()
    const input = feedbackInput(include)
    if (!input.title.trim()) {
      setFeedbackStatus('请填写反馈标题', 'error')
      return
    }
    if (!input.body.trim()) {
      setFeedbackStatus('请填写反馈内容', 'error')
      return
    }
    if (input.mode === 'signed' && !input.signature?.trim()) {
      setFeedbackStatus('署名提交需要填写署名', 'error')
      return
    }
    setFeedbackStatus('提交中…')
    const result = await api.feedback.submit(input)
    if (result.ok) {
      setFeedbackStatus(`反馈已收到，处理编号：${result.receiptId ?? '—'}`, 'ok')
    } else {
      setFeedbackStatus(`提交失败：${result.message ?? result.code ?? '未知错误'}\n可以复制完整反馈后发送到 QQ 群。`, result.code === 'unconfigured' ? 'warn' : 'error')
    }
  } catch {
    setFeedbackStatus('提交失败：反馈服务暂时不可用\n可以复制完整反馈后发送到 QQ 群。', 'error')
  } finally {
    feedbackSubmitting = false
    if (submit) submit.disabled = false
  }
}

document.querySelectorAll<HTMLButtonElement>('[data-feedback-mode]').forEach((button) => {
  button.addEventListener('click', () => setFeedbackMode(button.dataset.feedbackMode === 'signed' ? 'signed' : 'anonymous'))
})
document.getElementById('feedback-refresh-diagnostics')?.addEventListener('click', () => void refreshFeedbackDiagnostics())
document.getElementById('feedback-copy-diagnostics')?.addEventListener('click', () => void copyDiagnostics())
document.getElementById('feedback-copy-full')?.addEventListener('click', () => void copyFullFeedback())
document.getElementById('feedback-submit')?.addEventListener('click', () => void submitFeedbackUi())
setFeedbackMode('anonymous')

// ---- 应用更新：启动自动检查，下载与重启安装由用户确认 ----
const appUpdateVersion = document.getElementById('app-version')
const appUpdateBadge = document.getElementById('app-update-badge')
const appUpdateStatus = document.getElementById('app-update-status')
const appUpdateCheck = document.getElementById('app-update-check') as HTMLButtonElement | null
const appUpdateDownload = document.getElementById('app-update-download') as HTMLButtonElement | null
const appUpdateInstall = document.getElementById('app-update-install') as HTMLButtonElement | null
let appUpdateInstalling = false
let lastUpdateStatus: UpdateStatus | null = null

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function lastKnownVersion(): string {
  return lastUpdateStatus?.currentVersion ?? 'unknown'
}

function updateVersionLabel(version: string | undefined): string {
  if (!version) return '—'
  return version.startsWith('v') ? version : `v${version}`
}

function setUpdateStatus(status: UpdateStatus): void {
  // quitAndInstall 异步失败时主进程只会推 error 状态，这里复位安装锁，
  // 避免「重启更新」按钮永久不可点。
  if (status.state === 'error') appUpdateInstalling = false
  lastUpdateStatus = status
  if (appUpdateVersion) appUpdateVersion.textContent = updateVersionLabel(status.currentVersion)
  if (!appUpdateStatus) return
  if (appUpdateBadge) {
    appUpdateBadge.hidden = status.state !== 'available' && status.state !== 'downloaded'
    appUpdateBadge.textContent = status.state === 'downloaded' ? '待安装' : '有新版本'
  }
  if (appUpdateDownload) {
    // 下载失败后新版本信息仍在：保留下载按钮，免去先重新检查才能重试。
    appUpdateDownload.hidden = status.state !== 'available' && !(status.state === 'error' && status.version)
  }
  if (appUpdateInstall) {
    appUpdateInstall.hidden = status.state !== 'downloaded'
    appUpdateInstall.disabled = appUpdateInstalling
  }
  if (appUpdateCheck) {
    appUpdateCheck.hidden = status.state === 'downloaded'
    appUpdateCheck.disabled = status.state === 'checking' || status.state === 'downloading' || status.state === 'unsupported'
    appUpdateCheck.textContent = status.state === 'error' ? '重新检查' : '检查更新'
  }

  let text = '启动后自动检查'
  let kind: '' | 'ok' | 'error' | 'warn' = ''
  switch (status.state) {
    case 'unsupported':
      text = status.error ?? '当前版本不支持应用内更新'
      kind = 'warn'
      break
    case 'checking':
      text = '正在检查更新…'
      break
    case 'available':
      text = `发现新版本 ${updateVersionLabel(status.version)}`
      kind = 'ok'
      break
    case 'downloading':
      text = `下载更新中… ${Math.round(status.percent ?? 0)}%`
      break
    case 'downloaded':
      text = `${updateVersionLabel(status.version)} 已下载，重启后安装`
      kind = 'ok'
      break
    case 'not-available':
      text = '当前已是最新版本'
      kind = 'ok'
      break
    case 'error':
      text = `更新失败：${status.error ?? '未知错误'}`
      kind = 'error'
      break
  }
  appUpdateStatus.textContent = text
  appUpdateStatus.className = `sidebar-update-status${kind ? ` ${kind}` : ''}`
}

async function refreshUpdateStatus(): Promise<void> {
  if (!api) return
  try {
    setUpdateStatus(await api.updates.status())
  } catch {
    setUpdateStatus({ state: 'error', currentVersion: 'unknown', error: '更新状态暂时不可用' })
  }
}

async function checkForAppUpdate(): Promise<void> {
  if (!api || !appUpdateCheck) return
  appUpdateCheck.disabled = true
  try {
    const result = await api.updates.check()
    setUpdateStatus(result.status)
  } catch (error) {
    setUpdateStatus({
      state: 'error',
      currentVersion: lastKnownVersion(),
      error: errorText(error),
    })
  }
}

async function downloadAppUpdate(): Promise<void> {
  if (!api || !appUpdateDownload) return
  if (!confirm('确认下载新版本？下载完成后可选择重启安装。')) return
  try {
    const result = await api.updates.download()
    setUpdateStatus(result.status)
  } catch (error) {
    setUpdateStatus({
      state: 'error',
      currentVersion: lastKnownVersion(),
      error: errorText(error),
    })
  }
}

async function installAppUpdate(): Promise<void> {
  if (!api || !appUpdateInstall || appUpdateInstalling) return
  if (!confirm('更新已下载，确认退出并重启安装？')) return
  appUpdateInstalling = true
  appUpdateInstall.disabled = true
  try {
    const result = await api.updates.install()
    if (!result.ok) {
      appUpdateInstalling = false
      setUpdateStatus(result.status)
    }
  } catch (error) {
    appUpdateInstalling = false
    setUpdateStatus({
      state: 'error',
      currentVersion: lastKnownVersion(),
      error: errorText(error),
    })
  }
}

appUpdateCheck?.addEventListener('click', () => void checkForAppUpdate())
appUpdateDownload?.addEventListener('click', () => void downloadAppUpdate())
appUpdateInstall?.addEventListener('click', () => void installAppUpdate())

// ---- Harness 面板：内嵌官方 Web UI + 折叠式状态徽章（点击展开 已连接/重新连接/重新启动）----

const harnessOverlay = document.querySelector<HTMLElement>('.harness-overlay')
const harnessBadge = document.getElementById('harness-badge')
const harnessMenu = document.getElementById('harness-menu')
const harnessLoading = document.getElementById('harness-loading')
const harnessLoadingText = document.getElementById('harness-loading-text')
let harnessUrlCurrent: string | null = null
let currentHarnessState = 'starting'
let reconnectTimer: number | null = null

/** 状态类驱动徽章指示灯颜色（ready 绿 / 连接中、重启中 黄 / 失败 红） */
function setHarnessStateClass(state: string): void {
  harnessOverlay?.classList.remove('state-starting', 'state-ready', 'state-restarting', 'state-exited')
  if (['starting', 'ready', 'restarting', 'exited'].includes(state)) harnessOverlay?.classList.add(`state-${state}`)
}

function setHarnessMenuOpen(open: boolean): void {
  if (!harnessMenu || !harnessBadge) return
  harnessMenu.hidden = !open
  harnessBadge.setAttribute('aria-expanded', String(open))
}

/** WebView 就绪前的加载层：连接中/重启中/重连中显示指示，就绪或故障时隐藏 */
function setHarnessLoading(state: string): void {
  if (!harnessLoading) return
  const active = state === 'starting' || state === 'restarting' || state === 'reconnecting'
  harnessLoading.hidden = !active
  if (!harnessLoadingText || !active) return
  const text =
    state === 'starting'
      ? '正在启动 DeepSeek Harness…\n（首次运行或需 1-2 分钟，请稍候）'
      : state === 'restarting'
        ? 'Harness 重启中…'
        : '正在重新连接…'
  harnessLoadingText.textContent = text
}

function setHarnessStatusText(status: { state: string; url?: string; code?: number | null; error?: string }): void {
  const el = document.getElementById('harness-status')
  if (!el) return
  currentHarnessState = status.state
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  setHarnessStateClass(status.state)
  setHarnessLoading(status.state)
  let menuText = '状态未知'
  let kind: '' | 'ok' | 'error' = ''
  switch (status.state) {
    case 'starting':
      menuText = 'Harness 启动中…（首次运行或需 1-2 分钟，请稍候）'
      break
    case 'restarting':
      menuText = 'Harness 重启中…'
      break
    case 'ready':
      menuText = status.url ? `已连接: ${status.url}` : '已连接'
      kind = 'ok'
      harnessUrlCurrent = status.url ?? harnessUrlCurrent
      break
    case 'exited':
      menuText = status.error
        ? `Harness 连接失败：${status.error}`
        : `Harness 已退出（code=${status.code ?? '?'}），可重新启动`
      kind = 'error'
      break
  }
  // 箭头本身只显示颜色；完整状态放 tooltip 与弹层内，避免占面积
  if (harnessBadge) harnessBadge.title = menuText
  el.textContent = menuText
  el.className = `harness-status${kind ? ` ${kind}` : ''}`
  // 连接完成后自动缩回左下角徽章，不再遮挡界面；故障时自动展开便于查看原因并操作
  if (status.state === 'ready' || status.state === 'starting' || status.state === 'restarting') setHarnessMenuOpen(false)
  else if (status.state === 'exited') setHarnessMenuOpen(true)
}

// Browser canonicalizes a loopback origin to a trailing slash, while the Harness
// process output is slashless. Compare the normalized form to avoid reloading the
// iframe on every did-frame-navigate/status pair (especially visible in Windows smoke).
function sameHarnessUrl(left: string, right: string): boolean {
  return left.replace(/\/+$/, '') === right.replace(/\/+$/, '')
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

async function restartHarness(): Promise<boolean> {
  if (!api) return false
  setHarnessStatusText({ state: 'restarting' })
  const res = await api.harness.restart()
  if (!res.ok) {
    setHarnessStatusText({ state: 'exited', code: -1, error: `重启失败: ${res.error ?? ''}` })
    return false
  }
  // 重启后 --port 0 会换新端口：必须把 iframe 重挂到新 URL，否则停留在已死进程的旧端口
  const frame = document.getElementById('harness-frame') as HTMLIFrameElement | null
  if (frame && res.url) {
    frame.src = res.url
    setHarnessStatusText({ state: 'ready', url: res.url })
  }
  return true
}

async function restartHarnessForPluginChange(label: string): Promise<void> {
  setStatus(`${label}成功，正在重启 Harness 使运行时生效…`, 'ok')
  const restarted = await restartHarness()
  if (restarted) setStatus(`${label}成功，Harness 已重启，插件已加载`, 'ok')
  else setStatus(`${label}成功，但 Harness 重启失败；请点击 Harness 状态菜单手动重启`, 'error')
}

/** 重新连接：仅重挂 iframe，不重启后端进程；8s 内无就绪回执则提示超时 */
async function reconnectHarness(): Promise<void> {
  const frame = document.getElementById('harness-frame') as HTMLIFrameElement | null
  if (!frame) return
  if (currentHarnessState === 'starting' || currentHarnessState === 'restarting') return
  const url = harnessUrlCurrent
  if (!url) {
    setHarnessStatusText({ state: 'exited', code: null })
    return
  }
  currentHarnessState = 'reconnecting'
  setHarnessStateClass('starting')
  setHarnessMenuOpen(false)
  setHarnessLoading('reconnecting')
  if (harnessBadge) harnessBadge.title = '正在重新连接…'
  const el = document.getElementById('harness-status')
  if (el) {
    el.textContent = `正在重新连接 ${url}…`
    el.className = 'harness-status'
  }
  // 置空再挂载，确保同 URL 也会真正重新加载
  frame.src = 'about:blank'
  requestAnimationFrame(() => {
    frame.src = url
  })
  reconnectTimer = window.setTimeout(() => {
    if (currentHarnessState !== 'reconnecting') return
    setHarnessStatusText({ state: 'exited', code: null, error: '重新连接超时，可点击重新启动' })
  }, 8000)
}

if (api) {
  api.updates.onStatus((status) => setUpdateStatus(status))
  void refreshUpdateStatus()
  api.harness.onFrameLoaded((url) => {
    setHarnessStatusText({ state: 'ready', url })
    const frame = document.getElementById('harness-frame') as HTMLIFrameElement | null
    if (frame && !sameHarnessUrl(frame.src, url)) frame.src = url
  })
  // 窗口先行：收到 ready 时必须把 iframe 挂到新 URL（首次 mount 时 harness 可能未就绪）
  api.harness.onStatus((status) => {
    setHarnessStatusText(status)
    if (status.state === 'ready' && status.url) {
      const frame = document.getElementById('harness-frame') as HTMLIFrameElement | null
      if (frame && !sameHarnessUrl(frame.src, status.url)) frame.src = status.url
    }
  })
  document.getElementById('harness-reconnect')?.addEventListener('click', () => void reconnectHarness())
  document.getElementById('harness-restart')?.addEventListener('click', () => void restartHarness())
  harnessBadge?.addEventListener('click', () => {
    setHarnessMenuOpen(harnessMenu ? harnessMenu.hidden : false)
  })
  // 点击弹层外空白处收起（自身按钮点击由单独监听处理，这里用 contains 排除）
  document.addEventListener('click', (event) => {
    const target = event.target as Node | null
    if (harnessMenu && !harnessMenu.hidden && harnessOverlay && target && !harnessOverlay.contains(target)) {
      setHarnessMenuOpen(false)
    }
  })
  void refreshPlugins()
  void refreshMcpServers()
  void refreshSkills()
  refreshAllMarkets()
  void refreshFeedbackDiagnostics()
  void mountHarness()
}
