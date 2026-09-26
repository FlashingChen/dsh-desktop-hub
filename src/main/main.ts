// Electron 主进程：窗口安全边界 + IPC（来源校验）+ harness 生命周期 + 插件/MCP/Skills 管理
import { spawn as spawnProcess, type ChildProcess } from 'node:child_process'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell, Tray, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, isAbsolute, basename } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir, release as osRelease } from 'node:os'
import {
  startHarness,
  resolveDshExec,
  dshHome,
  listProfiles,
  runtimePathEnv,
  stopTree,
  type HarnessHandle,
  type DshProfile,
} from '../core/harness.js'
import {
  activatePlugin,
  classifyInstallSpec,
  deactivatePlugin,
  deactivatePluginIfActive,
  listPlugins,
  runPluginOp,
} from '../core/plugins.js'
import { PluginOpRunner } from '../core/plugin-ops.js'
import {
  convertJsonToYaml,
  extractMcpServers,
  replaceMcpRows,
  mergeMcpRows,
  updateMcpRow,
  deleteMcpRow,
  atomicWriteWithBackup,
  readPatch,
  validateMcpApplyInput,
  validateMcpUpdateInput,
} from '../core/mcp.js'
import { scanSkillsDetailed, resolveSkillIdentity, createSkill, setInvocation, importSkillFromZip, importSkillFromGitHub, importSkillFromClawHub, type SkillSummary } from '../core/skills.js'
import { IPC, type PluginOpAction, type HarnessStatus } from '../core/ipc.js'
import { DIAGNOSTIC_FORMAT_VERSION, formatDiagnostics, type DiagnosticHarnessState } from '../core/diagnostics.js'
import { checkCredentialsFile } from '../core/credentials-migration.js'
import { normalizeFeedbackInput, toFeedbackPayload } from '../core/feedback.js'
import { submitFeedback } from '../core/feedback-client.js'
import { initLog, log } from '../core/log.js'
import { fetchMarketItems, preflightPluginSpec, type MarketKind } from '../core/market.js'
import { getTrayWindowAction } from '../core/tray.js'
import { wireSmoke } from './smoke.js'
import { createPermissionHandlers } from './permissions.js'
import { createNavigationGuard, isAllowedIpcSender, isAllowedNavigation } from './navigation.js'
import { embeddedManagerUrl } from '../core/manager-url.js'
import { loadInitialPage, type InitialPageLoadFailure } from './window-load.js'
import { createUpdater } from './updater.js'
import {
  validateClawHubImportInput,
  validateMcpDeleteId,
  validatePluginStartInput,
  validateSkillCreateInput,
  validateSkillImportUrl,
  validateSkillToggleInput,
} from './ipc-validation.js'
import { TrackedTaskRegistry } from './tracked-tasks.js'
import { startLocalRendererServer, type LocalRendererServer } from './renderer-server.js'

const APP_NAME = 'DSH Desktop Hub'
const __dirname = dirname(fileURLToPath(import.meta.url))
const RENDERER_ROOT = join(__dirname, '..', 'renderer')
let RENDERER_URL = ''
const ARTIFACTS_DIR = join(__dirname, '..', '..', 'artifacts')

const argv = process.argv
const SMOKE = argv.includes('--smoke')
const HARNESS_SMOKE = argv.includes('--harness-smoke')
// 默认（无 flag）＝产品行为：窗口先行，harness 后台启动，失败自动重试

// 运行日志：任何启动/连接问题都落盘可查（Windows 真机无控制台）
initLog()
log(`argv=${JSON.stringify(argv)}`)

/** 超过该耗时视为慢启动：日志给出可操作提示，诊断块带上实际秒数（Issue #35） */
const SLOW_START_LOG_MS = 45_000

app.setName(APP_NAME)
// In development Electron's resourcesPath points into node_modules/electron,
// while packaged builds place this app's resources under app/resources.
// Resolve from Electron's actual app path so both launches use this project's
// bundled DSH version instead of an unrelated global `dsh` on PATH.
process.env.DSH_DESKTOP_RESOURCES_DIR = join(app.getAppPath(), 'resources')
if (!app.isPackaged) process.env.DSH_DESKTOP_ALLOW_PATH_NODE = '1'
// Windows 任务栏分组/通知归属（须在 ready 前设置）；其他平台无此概念
if (process.platform === 'win32') app.setAppUserModelId('com.dshdesktophub.app')

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let rendererServer: LocalRendererServer | null = null
let harness: HarnessHandle | null = null
let lastHarnessStatus: HarnessStatus = { state: 'starting' }
/** 上次成功就绪的 Harness 启动耗时（ms）；诊断与慢启动日志用（Issue #35） */
let lastHarnessStartupMs: number | null = null
let restarting = false
let stoppingHarness = false
/** 已收到用户退出请求；普通关闭按钮只隐藏到托盘，显式退出时才真正关闭窗口。 */
let quitRequested = false
/** Windows 正在关机/重启/注销；此时必须放行窗口 close，不能再隐藏到托盘。 */
let sessionEnding = false
/** 退出标志：将在退出清理期间抑制 harness 自动重启（防关闭竞态 respawn 出孤儿） */
let quitting = false
let autoRestartTimer: NodeJS.Timeout | null = null
/** 启动中（尚未就绪）的 dsh 子进程：退出时若仍在途则必须清理，防孤儿 */
let startingProc: ChildProcess | null = null
/** 启动清理失败/世代失效后仍需重试的确切 ChildProcess，避免后续启动覆盖唯一句柄。 */
const harnessCleanupRetries = new Set<ChildProcess>()
/** 每次主动停止都会递增；让被取消的启动 Promise 不能重新夺回 harness 状态或触发自动重启。 */
let harnessStartGeneration = 0
/** 自动重启墙钟限流：10 分钟内最多 8 次（防 crash-after-ready 死循环绕过计数） */
const autoRestartTimes: number[] = []
/** dsh 子进程最近输出（环形），失败时拼进 UI 错误信息 */
const recentDshLog: string[] = []

function canAutoRestart(): boolean {
  const now = Date.now()
  const windowMs = 10 * 60_000
  const recent = autoRestartTimes.filter((t) => now - t < windowMs)
  autoRestartTimes.length = 0
  autoRestartTimes.push(...recent)
  if (recent.length >= 8) {
    log(`harness: 10 分钟内自动重启已达 ${recent.length} 次，停止自动重启（可手动重启）`)
    return false
  }
  autoRestartTimes.push(now)
  return true
}

/** M2 管理的目标 profile（与 harness 启动一致）；M5 将支持切换 */
const ACTIVE_PROFILE = 'web'
const DESKTOP_HUB_PLUGIN_NAME = '@dsh-desktop-hub/manager'
let desktopHubPluginPromise: Promise<string> | null = null

// ---- 单实例锁：两个实例同时操作同一 profile/patch 会写冲突（P2-11）----
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  if (SMOKE || HARNESS_SMOKE) {
    const mode = HARNESS_SMOKE ? '--harness-smoke' : '--smoke'
    const message = `${mode} 无法获取单实例锁；已有 DSH Desktop Hub 实例正在运行，冒烟断言未执行`
    log(`SMOKE FAIL: ${message}`)
    console.error(`SMOKE FAIL: ${message}`)
    app.exit(1)
  } else {
    app.quit()
  }
}

function activeProfile(): DshProfile | null {
  return listProfiles(dshHome()).find((p) => p.name === ACTIVE_PROFILE) ?? null
}

function bundledDesktopHubPluginDir(): string {
  const roots = [
    join(process.cwd(), 'resources', 'plugins', 'dsh-desktop-hub'),
    ...(process.resourcesPath
      ? [
          join(process.resourcesPath, 'app', 'resources', 'plugins', 'dsh-desktop-hub'),
          join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'plugins', 'dsh-desktop-hub'),
          join(process.resourcesPath, 'plugins', 'dsh-desktop-hub'),
        ]
      : []),
  ]
  const source = roots.find((root) => existsSync(join(root, 'package.json')))
  if (!source) throw new Error('桌面管理器 DSH 插件资源缺失')
  return source
}

function runPnpm(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawnProcess('pnpm', args, {
      cwd,
      env: runtimePathEnv(ACTIVE_PROFILE, cwd),
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    })
    const timeout = setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error('安装桌面管理器 DSH 插件超时'))
    }, 90_000)
    proc.once('error', (error) => {
      clearTimeout(timeout)
      reject(new Error(`准备桌面管理器 DSH 插件失败：${error.message}`))
    })
    proc.once('exit', (code, signal) => {
      clearTimeout(timeout)
      if (code === 0) resolve()
      else reject(new Error(`准备桌面管理器 DSH 插件失败（code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}）`))
    })
  })
}

/** Install the bundled UI extension as a profile dependency and activate it only for this desktop launch. */
async function ensureDesktopHubPlugin(): Promise<string> {
  if (desktopHubPluginPromise) return desktopHubPluginPromise
  desktopHubPluginPromise = (async () => {
    const profile = activeProfile()
    if (!profile) throw new Error(`DSH profile「${ACTIVE_PROFILE}」不存在，无法挂载桌面管理器插件`)
    const source = bundledDesktopHubPluginDir()
    const destination = join(app.getPath('userData'), 'plugins', 'dsh-desktop-hub')
    mkdirSync(destination, { recursive: true })
    for (const file of ['package.json', 'index.js', 'client.js', 'cordis.patch.yml']) {
      copyFileSync(join(source, file), join(destination, file))
    }

    const packageJson = JSON.parse(readFileSync(join(profile.dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, unknown>
    }
    const currentSpec = packageJson.dependencies?.[DESKTOP_HUB_PLUGIN_NAME]
    if (currentSpec !== undefined) {
      if (typeof currentSpec !== 'string' || (!currentSpec.startsWith('file:') && !currentSpec.startsWith('link:'))) {
        throw new Error(`DSH profile 中的「${DESKTOP_HUB_PLUGIN_NAME}」依赖与桌面管理器插件冲突`)
      }
      const localPath = currentSpec.slice(currentSpec.indexOf(':') + 1)
      const linkedPath = isAbsolute(localPath) ? localPath : join(profile.dir, localPath)
      if (realpathSync(linkedPath) !== realpathSync(destination)) {
        throw new Error(`DSH profile 中的「${DESKTOP_HUB_PLUGIN_NAME}」依赖指向其他目录`)
      }
    } else {
      await runPnpm(['add', '--save-exact', '--ignore-scripts', destination], profile.dir)
    }

    const installedPackage = join(profile.dir, 'node_modules', '@dsh-desktop-hub', 'manager', 'package.json')
    if (!existsSync(installedPackage)) throw new Error('桌面管理器 DSH 插件未能链接到 web profile')
    const installedManifest = JSON.parse(readFileSync(installedPackage, 'utf8')) as { name?: unknown }
    if (installedManifest.name !== DESKTOP_HUB_PLUGIN_NAME) throw new Error('web profile 中的桌面管理器插件包名无效')
    return join(destination, 'cordis.patch.yml')
  })().catch((error: unknown) => {
    desktopHubPluginPromise = null
    throw error
  })
  return desktopHubPluginPromise
}

interface RuntimeManifest {
  dshVersion?: unknown
  pnpmVersion?: unknown
}

function readRuntimeManifest(): RuntimeManifest | null {
  const base = process.resourcesPath ?? join(process.cwd(), 'resources')
  const roots = process.resourcesPath
    ? [join(base, 'app', 'resources'), join(base, 'app.asar.unpacked', 'resources'), base]
    : [base]
  for (const root of roots) {
    const file = join(root, 'runtime-manifest.json')
    if (!existsSync(file)) continue
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (value && typeof value === 'object') return value as RuntimeManifest
    } catch {
      /* optional diagnostic metadata; ignore malformed/missing manifest */
    }
  }
  return null
}

function readDshRuntimeVersion(): string | null {
  const manifestVersion = readRuntimeManifest()?.dshVersion
  if (typeof manifestVersion === 'string' && manifestVersion.trim()) return manifestVersion

  const packageFiles = [
    join(process.cwd(), 'resources', 'rt', 'package.json'),
    join(__dirname, '..', '..', 'resources', 'rt', 'package.json'),
  ]
  for (const file of packageFiles) {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as { dependencies?: Record<string, unknown> }
      const version = value.dependencies?.['@deepseek-ai/dsh']
      if (typeof version === 'string' && version.trim()) return version
    } catch {
      /* Packaged builds use the generated runtime manifest; development can read resources/rt/package.json. */
    }
  }
  return null
}

function diagnosticHarnessState(state: HarnessStatus['state']): DiagnosticHarnessState {
  return state === 'starting' || state === 'ready' || state === 'exited' || state === 'restarting' ? state : 'unknown'
}

function buildDiagnosticText(): string {
  const manifest = readRuntimeManifest()
  const dshVersion = typeof manifest?.dshVersion === 'string' ? manifest.dshVersion : null
  const pnpmVersion = typeof manifest?.pnpmVersion === 'string' ? manifest.pnpmVersion : null
  const cred = checkCredentialsFile()
  return formatDiagnostics({
    formatVersion: DIAGNOSTIC_FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    packaged: app.isPackaged,
    profile: ACTIVE_PROFILE,
    platform: process.platform,
    osRelease: osRelease(),
    arch: process.arch,
    electronVersion: process.versions.electron ?? 'unknown',
    chromeVersion: process.versions.chrome ?? 'unknown',
    nodeVersion: process.versions.node ?? 'unknown',
    dshVersion,
    pnpmVersion,
    harnessState: diagnosticHarnessState(lastHarnessStatus.state),
    harnessExitCode: typeof lastHarnessStatus.code === 'number' ? lastHarnessStatus.code : null,
    harnessStartupMs: lastHarnessStartupMs,
    updateState: updater.status().state,
    credentialsFormat: cred.format,
  })
}

const DEFAULT_FEEDBACK_ENDPOINT = 'https://feedback.flashingchen.xyz/v1/feedback'

function feedbackEndpoint(): string {
  return (process.env.DSH_FEEDBACK_ENDPOINT ?? DEFAULT_FEEDBACK_ENDPOINT).trim()
}

function feedbackBaseUrl(): string {
  try {
    const u = new URL(feedbackEndpoint())
    return `${u.protocol}//${u.host}`
  } catch { return 'https://feedback.flashingchen.xyz' }
}

async function fetchJson(url: string, timeoutMs = 10000): Promise<unknown> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal })
    const text = await res.text()
    try { return JSON.parse(text) } catch { return { ok: false, code: 'invalid_response', message: text.slice(0,300) } }
  } finally { clearTimeout(t) }
}

// ---- IPC 来源校验（P1-2 / P2-9）：只接受壳层主帧与内嵌管理中心子帧，拒绝 harness iframe / 外部页 ----
function assertRendererSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame
  const url = frame?.url ?? ''
  if (!frame || !isAllowedIpcSender(url, frame === event.sender.mainFrame, RENDERER_URL)) {
    throw new Error('IPC 来源校验失败：拒绝非壳层主帧与非法管理中心帧调用')
  }
}

/** 返回壳层主帧（存在且为我们的 renderer），供 push 事件使用 */
function shellWebContents(): WebContents | null {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.getURL() === RENDERER_URL) {
    return mainWindow.webContents
  }
  return null
}

const updater = createUpdater()
const UPDATE_CHECK_DELAY_MS = 8_000
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000
let updateInitialTimer: NodeJS.Timeout | null = null
let updateInterval: NodeJS.Timeout | null = null

function scheduleUpdateChecks(): void {
  if (!app.isPackaged) return
  clearTimeout(updateInitialTimer ?? undefined)
  clearInterval(updateInterval ?? undefined)
  updateInitialTimer = setTimeout(() => {
    updateInitialTimer = null
    void updater.check()
  }, UPDATE_CHECK_DELAY_MS)
  updateInitialTimer.unref?.()
  updateInterval = setInterval(() => void updater.check(), UPDATE_CHECK_INTERVAL_MS)
  updateInterval.unref?.()
}

// ---- profile 写操作串行化：插件 patch 与 MCP patch 都落在同一文件上（P1-5）----
let mutationChain: Promise<unknown> = Promise.resolve()
let pendingMutations = 0
let mutationsShuttingDown = false
function serializeMutation<T>(task: () => Promise<T> | T): Promise<T> {
  if (mutationsShuttingDown) return Promise.reject(new Error('应用正在退出，无法开始新的写操作'))
  pendingMutations += 1
  const next = mutationChain.then(task, task)
  const tracked = next.finally(() => {
    pendingMutations -= 1
  })
  mutationChain = tracked.then(
    () => undefined,
    () => undefined,
  )
  return tracked
}

// 网络 Skill 导入会长时间等待远端响应，但写入的不是 profile patch。独立跟踪，
// 让退出可以 drain 已登记导入，同时不占用插件/MCP 的串行 mutationChain。
const skillImportTasks = new TrackedTaskRegistry()

// ---- 插件操作：启动/完成分离 + 流式输出 + 可取消 + 有界缓冲（P1-5 / P2-10）----
// IPC 的 start-op 只能确认「已登记」，不能等待 dsh 子进程结束；完成由 plugin-op:done
// 事件单独推送。否则一个 0.8s 内完成的操作会先发 done，再把 token 返回 renderer，
// renderer 永远收不到与自己 token 匹配的终态（Issue #8）。
let opSeq = 0

function sendPluginEvent(channel: string, ...payload: unknown[]): void {
  try {
    // 每次推送取最新 webContents；窗口可能在长操作期间销毁，send 需防御（P3）。
    shellWebContents()?.send(channel, ...payload)
  } catch {
    /* 窗口已销毁：忽略推送；终态仍由 PluginOpRunner 有界保存，供 status 查询。 */
  }
}

const pluginOps = new PluginOpRunner({
  nextToken: () => `op-${++opSeq}`,
  schedule: (task) => serializeMutation(task),
  onChunk: (token, text) => sendPluginEvent(IPC.pluginOpChunk, token, text),
  onDone: (done) => sendPluginEvent(IPC.pluginOpDone, done),
  onFinalizeError: (message) => log(`plugin remove: patch 激活行清理失败 —— ${message}`),
})

async function requestPluginBuildApproval(keys: string[]): Promise<boolean> {
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
  for (const key of keys) {
    const options = {
      type: 'warning' as const,
      title: '授权插件构建脚本',
      message: `插件安装需要执行构建脚本：${key}`,
      detail: '该脚本会在本机沙箱之外执行，并写入当前 profile 的 allowBuilds。是否允许并重试？',
      buttons: ['取消安装', '允许并重试'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }
    const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    if (result.response !== 1) return false
  }
  return true
}

function startPluginOp(action: PluginOpAction, args: string[], finalize?: () => void) {
  if (pluginOps.isShuttingDown()) return { ok: false as const, error: '应用正在退出，无法启动新的插件操作' }
  const exec = resolveDshExec()
  if (!exec) return { ok: false as const, error: '未找到 dsh 可执行文件' }
  const profile = activeProfile()
  return pluginOps.start({
    profile: ACTIVE_PROFILE,
    action,
    args,
    run: () => runPluginOp({
      dsh: exec.exec,
      node: exec.node,
      profile: ACTIVE_PROFILE,
      action,
      args,
      env: runtimePathEnv(ACTIVE_PROFILE),
      autoApproveBuilds: profile ? { workspaceFile: join(profile.dir, 'pnpm-workspace.yaml') } : undefined,
      requestBuildApproval: requestPluginBuildApproval,
    }),
    finalize,
  })
}

// ---- Skills 路径 allowlist（P1-2）：按 ID 重扫 → 取扫描结果路径 → realpath 域校验 ----
function resolveSkillRoot(source: SkillSummary['source']): string {
  // Windows 无 HOME 环境变量（USERPROFILE 才是主目录），必须用 os.homedir()
  const home = homedir()
  switch (source) {
    case 'user-dsh':
      return join(dshHome(), 'skills')
    case 'user-agents':
      return join(home, '.agents', 'skills')
    default:
      throw new Error(`skill 来源「${source}」不允许通过壳层修改`)
  }
}

function resolveScannedSkill(
  id: string,
  source: SkillSummary['source'],
  kind: SkillSummary['kind'],
): SkillSummary {
  const skill = resolveSkillIdentity({ dshHome: dshHome() }, { id, source, kind })
  if (!skill.canToggle) throw new Error(`skill 来源「${source}」不允许通过壳层修改`)
  const root = resolveSkillRoot(source)
  const pathReal = realpathSync(skill.path)
  const rootReal = realpathSync(root)
  // 域校验用 relative 判定，避免平台分隔符/大小写差异（Windows \\ 与不区分大小写）
  const rel = relative(rootReal, pathReal)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`skill 路径越界: ${skill.path}`)
  }
  const base = dirname(pathReal).split(/[\\/]/).pop() ?? ''
  const isBundle = skill.kind === 'bundle' && basename(pathReal) === 'SKILL.md' && base === skill.name
  const isFlat = skill.kind === 'flat' && basename(pathReal) === `${skill.name}.md`
  if (!isBundle && !isFlat) throw new Error(`skill 不是扫描到的 SKILL.md 或扁平文件: ${pathReal}`)
  return skill
}

// ---- IPC 注册 ----
function registerIpc(): void {
  ipcMain.handle(IPC.runtimeInfo, (event) => {
    assertRendererSender(event)
    return { appVersion: app.getVersion(), dshVersion: readDshRuntimeVersion() }
  })

  ipcMain.handle(IPC.updatesGetStatus, (event) => {
    assertRendererSender(event)
    return updater.status()
  })

  ipcMain.handle(IPC.updatesCheck, (event) => {
    assertRendererSender(event)
    return updater.check()
  })

  ipcMain.handle(IPC.updatesDownload, (event) => {
    assertRendererSender(event)
    return updater.download()
  })

  ipcMain.handle(IPC.updatesInstall, (event) => {
    assertRendererSender(event)
    return updater.install()
  })

  ipcMain.handle(IPC.harnessUrl, (event) => {
    assertRendererSender(event)
    return harness?.url ?? null
  })

  ipcMain.handle(IPC.harnessRestart, (event) => {
    assertRendererSender(event)
    return restartHarness()
  })

  ipcMain.handle(IPC.feedbackDiagnostics, (event) => {
    assertRendererSender(event)
    return { ok: true as const, text: buildDiagnosticText() }
  })

  ipcMain.handle(IPC.feedbackCopy, (event, text: unknown) => {
    assertRendererSender(event)
    if (typeof text !== 'string' || !text.trim()) return { ok: false as const, error: '没有可复制的内容' }
    if (text.length > 64 * 1024) return { ok: false as const, error: '复制内容超过 64KB 上限' }
    try {
      clipboard.writeText(text)
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.feedbackSubmit, async (event, input: unknown) => {
    assertRendererSender(event)
    const normalized = normalizeFeedbackInput(input)
    if (!normalized.ok) return { ok: false as const, code: 'invalid_request' as const, message: normalized.error }
    const payload = toFeedbackPayload(normalized.input, {
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      profile: ACTIVE_PROFILE,
    })
    return submitFeedback(payload, { endpoint: feedbackEndpoint() })
  })

  ipcMain.handle(IPC.feedbackStatus, async (event, receiptIds: unknown) => {
    assertRendererSender(event)
    if (!Array.isArray(receiptIds) || receiptIds.length === 0) return { ok: false as const, code: 'invalid_request' as const, message: '缺少 receiptIds' }
    const ids = receiptIds.filter((v): v is string => typeof v === 'string' && /^fb_[a-z0-9]{24}$/.test(v)).slice(0,20)
    if (ids.length === 0) return { ok: false as const, code: 'invalid_request' as const, message: 'receiptIds 无效' }
    const url = `${feedbackBaseUrl()}/v1/feedback?receiptIds=${encodeURIComponent(ids.join(','))}`
    try {
      const data = await fetchJson(url) as Record<string, unknown>
      return data
    } catch (err) {
      return { ok: false as const, code: 'network_error' as const, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.feedbackIssues, async (event, params: unknown) => {
    assertRendererSender(event)
    const p = (params && typeof params === 'object' ? params as Record<string, unknown> : {}) as Record<string, unknown>
    const state = p.state === 'closed' || p.state === 'all' ? p.state : 'open'
    const page = Math.max(1, Math.min(10, Number(p.page ?? 1) || 1))
    const perPage = Math.max(1, Math.min(50, Number(p.perPage ?? 20) || 20))
    const url = `${feedbackBaseUrl()}/v1/issues?state=${encodeURIComponent(String(state))}&page=${page}&per_page=${perPage}`
    try {
      const data = await fetchJson(url) as Record<string, unknown>
      return data
    } catch (err) {
      return { ok: false as const, code: 'network_error' as const, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.feedbackIssueDetail, async (event, issueNumber: unknown) => {
    assertRendererSender(event)
    const num = Number(issueNumber)
    if (!Number.isInteger(num) || num <= 0) return { ok: false as const, code: 'invalid_request' as const, message: 'issueNumber 无效' }
    const url = `${feedbackBaseUrl()}/v1/issues/${num}`
    try {
      const data = await fetchJson(url) as Record<string, unknown>
      return data
    } catch (err) {
      return { ok: false as const, code: 'network_error' as const, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.feedbackOpenIssue, async (event, issueNumber: unknown) => {
    assertRendererSender(event)
    const num = Number(issueNumber)
    if (!Number.isInteger(num) || num <= 0) return { ok: false as const, error: 'issueNumber 无效' }
    const url = `https://github.com/${'FlashingChen'}/dsh-desktop-hub/issues/${num}`
    try {
      await shell.openExternal(url)
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.pluginsList, (event) => {
    assertRendererSender(event)
    const profile = activeProfile()
    if (!profile) return { ok: false as const, error: `profile「${ACTIVE_PROFILE}」不存在`, entries: [] }
    try {
      const patch = readPatch(profile.dir)
      const entries = listPlugins(profile, patch)
      return { ok: true as const, profile: ACTIVE_PROFILE, entries }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, entries: [] }
    }
  })

  ipcMain.handle(IPC.pluginsActivate, async (event, name: unknown) => {
    assertRendererSender(event)
    const profile = activeProfile()
    if (!profile) return { ok: false as const, error: `profile「${ACTIVE_PROFILE}」不存在`, output: '' }
    if (typeof name !== 'string' || !name.trim()) return { ok: false as const, error: 'name 无效', output: '' }
    const packageName = name.trim()
    try {
      const entry = listPlugins(profile, readPatch(profile.dir)).find((candidate) => candidate.name === packageName)
      if (!entry) return { ok: false as const, error: `插件「${packageName}」未安装`, output: '' }
      if (entry.activationSource === 'bundle') {
        return { ok: false as const, error: `「${packageName}」由组合包激活，无需单独激活`, output: '' }
      }
      if (entry.activationSource === 'patch') {
        return { ok: true as const, output: '插件已经激活', backup: '' }
      }
      return await serializeMutation(() => {
        const patch = readPatch(profile.dir)
        const result = writePluginPatch(profile, activatePlugin(patch, packageName))
        return { ...result, output: `插件「${packageName}」已激活；请重启 Harness` }
      })
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, output: '' }
    }
  })

  ipcMain.handle(IPC.pluginsDeactivate, async (event, name: unknown) => {
    assertRendererSender(event)
    const profile = activeProfile()
    if (!profile) return { ok: false as const, error: `profile「${ACTIVE_PROFILE}」不存在`, output: '' }
    if (typeof name !== 'string' || !name.trim()) return { ok: false as const, error: 'name 无效', output: '' }
    const packageName = name.trim()
    try {
      const entry = listPlugins(profile, readPatch(profile.dir)).find((candidate) => candidate.name === packageName)
      if (!entry) return { ok: false as const, error: `插件「${packageName}」未安装`, output: '' }
      if (entry.activationSource === 'bundle') {
        return { ok: false as const, error: `「${packageName}」由组合包激活，不能单独停用（停用只对 patch 手动激活的插件生效）`, output: '' }
      }
      if (entry.activationSource === 'none') {
        return { ok: false as const, error: `插件「${packageName}」未激活`, output: '' }
      }
      return await serializeMutation(() => {
        const patch = readPatch(profile.dir)
        const result = writePluginPatch(profile, deactivatePlugin(patch, packageName))
        return { ...result, output: `插件「${packageName}」已停用；package 依赖仍保留` }
      })
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, output: '' }
    }
  })

  ipcMain.handle(IPC.pluginsPrepareInstall, (event, spec: unknown) => {
    assertRendererSender(event)
    if (typeof spec !== 'string' || !spec.trim()) return { ok: false as const, error: '插件 spec 无效' }
    const plan = classifyInstallSpec(spec.slice(0, 500))
    if (plan.kind === 'routing-suite') {
      return { ok: false as const, kind: plan.kind, normalized: plan.normalized, error: plan.message }
    }
    return { ok: true as const, kind: plan.kind, normalized: plan.normalized }
  })

  ipcMain.handle(IPC.pluginsStartOp, (event, action: unknown, args: unknown) => {
    assertRendererSender(event)
    const validated = validatePluginStartInput(action, args)
    if (!validated.ok) return { ok: false as const, error: validated.error }
    const operationAction = validated.value.action
    let operationArgs = validated.value.args
    if (operationAction === 'add') {
      const plan = classifyInstallSpec(operationArgs[0])
      if (plan.kind === 'routing-suite') return { ok: false as const, error: plan.message }
      if (!plan.normalized) return { ok: false as const, error: '插件 spec 无效' }
      // Renderer 已经预处理过一次；主进程仍再次归一化，防止绕过 UI 的调用把网页 URL 送进 pnpm。
      operationArgs = [plan.normalized]
    }
    const removeName = operationAction === 'remove' ? operationArgs[0] : undefined
    return startPluginOp(operationAction, operationArgs, removeName === undefined ? undefined : () => {
      // 已在 PluginOpRunner 的 profile mutation 串行区内，不能再次进入 serializeMutation。
      const profile = activeProfile()
      if (!profile) throw new Error(`profile「${ACTIVE_PROFILE}」不存在，无法清理插件激活行`)
      const patch = readPatch(profile.dir)
      const cleaned = deactivatePluginIfActive(patch, removeName)
      if (cleaned !== patch) writePluginPatch(profile, cleaned)
    })
  })

  ipcMain.handle(IPC.pluginsCancelOp, (event, token: unknown) => {
    assertRendererSender(event)
    if (typeof token !== 'string') return { ok: false as const }
    return { ok: pluginOps.cancel(token) }
  })

  ipcMain.handle(IPC.pluginsOpStatus, (event, token: unknown) => {
    assertRendererSender(event)
    if (typeof token !== 'string' || !token) return { state: 'unknown' as const }
    return pluginOps.status(token)
  })

  ipcMain.handle(IPC.mcpList, (event) => {
    assertRendererSender(event)
    const profile = activeProfile()
    if (!profile) return { ok: false as const, error: `profile「${ACTIVE_PROFILE}」不存在`, servers: [] }
    try {
      const servers = extractMcpServers(readPatch(profile.dir))
      return { ok: true as const, profile: ACTIVE_PROFILE, servers }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, servers: [] }
    }
  })

  ipcMain.handle(IPC.mcpConvert, (event, jsonText: unknown) => {
    assertRendererSender(event)
    if (typeof jsonText !== 'string') return { ok: false as const, error: '输入无效', yaml: '', warnings: [] }
    return convertJsonToYaml(jsonText)
  })

  ipcMain.handle(IPC.mcpApply, async (event, input: unknown) => {
    assertRendererSender(event)
    const profile = activeProfile()
    if (!profile) return { ok: false as const, error: `profile「${ACTIVE_PROFILE}」不存在`, backup: '' }
    const validated = validateMcpApplyInput(input)
    if (!validated.ok) return { ok: false as const, error: validated.error, backup: '' }
    try {
      return await serializeMutation(() => {
        const patch = readPatch(profile.dir)
        const next = validated.value.mode === 'replace'
          ? replaceMcpRows(patch, validated.value.rows)
          : mergeMcpRows(patch, validated.value.rows)
        return writeMcpPatch(profile, next, extractMcpServers(next).length)
      })
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, backup: '' }
    }
  })

  ipcMain.handle(IPC.mcpUpdate, async (event, input: unknown) => {
    assertRendererSender(event)
    const profile = activeProfile()
    if (!profile) return { ok: false as const, error: `profile「${ACTIVE_PROFILE}」不存在`, backup: '' }
    const validated = validateMcpUpdateInput(input)
    if (!validated.ok) return { ok: false as const, error: validated.error, backup: '' }
    try {
      return await serializeMutation(() => {
        const next = updateMcpRow(readPatch(profile.dir), validated.value.row)
        return writeMcpPatch(profile, next, extractMcpServers(next).length)
      })
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, backup: '' }
    }
  })

  ipcMain.handle(IPC.mcpDelete, async (event, id: unknown) => {
    assertRendererSender(event)
    const profile = activeProfile()
    if (!profile) return { ok: false as const, error: `profile「${ACTIVE_PROFILE}」不存在`, backup: '' }
    const validated = validateMcpDeleteId(id)
    if (!validated.ok) return { ok: false as const, error: validated.error, backup: '' }
    try {
      return await serializeMutation(() => {
        const next = deleteMcpRow(readPatch(profile.dir), validated.value)
        return writeMcpPatch(profile, next, extractMcpServers(next).length)
      })
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, backup: '' }
    }
  })

  ipcMain.handle(IPC.skillsList, (event) => {
    assertRendererSender(event)
    try {
      // 随包 skills：官方 Config.bundledSkillDir 默认取 $DSH_BUNDLED_SKILL_DIR，存在才扫描
      const bundledDir = process.env.DSH_BUNDLED_SKILL_DIR || undefined
      const scanned = scanSkillsDetailed({ dshHome: dshHome(), bundledDir })
      const skills = scanned.skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse,
        modelInvocable: skill.modelInvocable,
        userInvocable: skill.userInvocable,
        source: skill.source,
        kind: skill.kind,
        shadowed: skill.shadowed,
        canToggle: skill.canToggle,
        bodyPreview: skill.bodyPreview,
      }))
      return { ok: true as const, skills, warnings: scanned.warnings }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, skills: [] }
    }
  })

  ipcMain.handle(IPC.skillsCreate, (event, input: unknown) => {
    assertRendererSender(event)
    if (mutationsShuttingDown) return { ok: false as const, error: '应用正在退出，无法开始新的写操作', path: '' }
    const validated = validateSkillCreateInput(input)
    if (!validated.ok) return { ok: false as const, error: validated.error, path: '' }
    const payload = validated.value
    try {
      const path = createSkill({
        root: join(dshHome(), 'skills'),
        name: payload.name,
        description: payload.description,
        body: payload.body,
        overwrite: payload.overwrite,
      })
      return { ok: true as const, path }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, path: '' }
    }
  })

  ipcMain.handle(IPC.skillsToggle, (event, input: unknown) => {
    assertRendererSender(event)
    if (mutationsShuttingDown) return { ok: false as const, error: '应用正在退出，无法开始新的写操作' }
    const validated = validateSkillToggleInput(input)
    if (!validated.ok) return { ok: false as const, error: validated.error }
    const payload = validated.value
    try {
      const skill = resolveScannedSkill(payload.id, payload.source, payload.skillKind)
      setInvocation(skill.path, payload.kind, payload.value)
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC.skillsImportFile, (event, buffer: unknown, overwrite: unknown) => {
    assertRendererSender(event)
    if (mutationsShuttingDown) return { ok: false as const, error: '应用正在退出，无法开始新的写操作', result: null }
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) return { ok: false as const, error: '文件无效', result: null }
    if (buffer.byteLength > 20 * 1024 * 1024) return { ok: false as const, error: '文件超过 20MB 上限', result: null }
    try {
      const result = importSkillFromZip(Buffer.from(buffer), { root: join(dshHome(), 'skills'), overwrite: overwrite === true })
      return { ok: true as const, result }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, result: null }
    }
  })

  ipcMain.handle(IPC.skillsImportUrl, async (event, url: unknown, overwrite: unknown) => {
    assertRendererSender(event)
    const validated = validateSkillImportUrl(url)
    if (!validated.ok) return { ok: false as const, error: validated.error, result: null }
    try {
      const result = await skillImportTasks.start(() => importSkillFromGitHub(
        validated.value,
        { root: join(dshHome(), 'skills'), overwrite: overwrite === true },
      ))
      return { ok: true as const, result }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, result: null }
    }
  })

  ipcMain.handle(IPC.skillsImportClawHub, async (event, input: unknown, overwrite: unknown) => {
    assertRendererSender(event)
    const validated = validateClawHubImportInput(input)
    if (!validated.ok) return { ok: false as const, error: validated.error, result: null }
    try {
      const result = await skillImportTasks.start(() => importSkillFromClawHub(
        validated.value,
        { root: join(dshHome(), 'skills'), overwrite: overwrite === true },
      ))
      return { ok: true as const, result }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, result: null }
    }
  })

  ipcMain.handle(IPC.marketList, async (event, kind: unknown, query: unknown) => {
    assertRendererSender(event)
    const selected = kind === 'plugin' || kind === 'mcp' || kind === 'skill' ? kind as MarketKind : undefined
    if (!selected) return { ok: false as const, kind: 'all' as const, items: [], error: '市场类型无效' }
    const result = await fetchMarketItems(selected, typeof query === 'string' ? query.slice(0, 120) : '', {
      cacheDir: join(app.getPath('userData'), 'market-cache'),
    })
    return { ok: true as const, kind: selected, items: result.items, online: result.online, cached: result.cached, error: result.error }
  })

  ipcMain.handle(IPC.marketPluginPreflight, async (event, spec: unknown) => {
    assertRendererSender(event)
    if (typeof spec !== 'string' || !spec.trim()) return { ok: false as const, error: '插件 spec 无效' }
    return preflightPluginSpec(spec.slice(0, 500))
  })
}

function writeMcpPatch(profile: { dir: string }, next: string, rowCount: number) {
  const patchFile = join(profile.dir, 'cordis.patch.yml')
  const backup = atomicWriteWithBackup(patchFile, next)
  return { ok: true as const, backup, rows: rowCount }
}

function writePluginPatch(profile: { dir: string }, next: string) {
  const patchFile = join(profile.dir, 'cordis.patch.yml')
  const backup = atomicWriteWithBackup(patchFile, next)
  return { ok: true as const, backup }
}

// ---- 窗口与安全 ----
function currentHarnessOrigin(): string | null {
  if (!harness) return null
  try {
    return new URL(harness.url).origin
  } catch {
    return null
  }
}

function resolveTrayIconPath(): string | null {
  // resources/ 会被 electron-builder 一起打进 app；开发模式下 app.getAppPath() 则是仓库根目录。
  const fileName = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'
  const candidates = [
    join(app.getAppPath(), 'resources', fileName),
    join(process.resourcesPath, fileName),
    join(app.getAppPath(), 'build', 'icon.png'),
  ]
  return candidates.find((path) => existsSync(path)) ?? null
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createSkeletonWindow()
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function toggleMainWindow(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) {
    showMainWindow()
    return
  }
  const action = getTrayWindowAction({
    destroyed: false,
    minimized: win.isMinimized(),
    visible: win.isVisible(),
  })
  if (action === 'hide') win.hide()
  else showMainWindow()
}

function requestAppQuit(): void {
  // before-quit 是所有退出入口（应用菜单、托盘、系统关闭）的统一状态切换点。
  app.quit()
}

function updateTrayMenu(): void {
  if (!tray) return
  const visible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized())
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: visible ? '隐藏窗口' : '显示窗口', click: toggleMainWindow },
      { type: 'separator' },
      { label: '退出', click: requestAppQuit },
    ]),
  )
}

function createTray(): void {
  if (tray || SMOKE || HARNESS_SMOKE) return
  const iconPath = resolveTrayIconPath()
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  if (process.platform === 'darwin' && iconPath && basename(iconPath) === 'trayTemplate.png') icon.setTemplateImage(true)
  let nextTray: Tray | null = null
  try {
    nextTray = new Tray(icon)
    nextTray.setToolTip(APP_NAME)
    nextTray.on('click', toggleMainWindow)
    tray = nextTray
    updateTrayMenu()
  } catch (err) {
    try {
      nextTray?.destroy()
    } catch {
      /* tray 创建失败后的兜底清理也不能阻止应用启动 */
    }
    tray = null
    log(`tray: 创建失败 —— ${err instanceof Error ? err.message : String(err)}`)
  }
}

function openExternalHttpUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return

  const reportFailure = (error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error)
    log(`external-link: 系统浏览器打开 ${parsed.protocol} 链接失败 —— ${detail}`)
  }
  try {
    void shell.openExternal(parsed.href).catch(reportFailure)
  } catch (error) {
    reportFailure(error)
  }
}

function hardenWindow(win: BrowserWindow): void {
  // 拒绝任意 popup：http(s) 外部链接交给系统浏览器，其余一律 deny（P2-9）
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalHttpUrl(url)
    return { action: 'deny' }
  })
  // 用户/页面发起的任意 frame 导航与服务端重定向执行同一白名单策略。
  // will-frame-navigate 已覆盖主 frame，不再重复注册仅处理主 frame 的 will-navigate。
  const guardNavigation = createNavigationGuard(RENDERER_URL, () => harness?.url ?? null)
  win.webContents.on('will-frame-navigate', guardNavigation)
  win.webContents.on('will-redirect', guardNavigation)
  // 权限默认拒绝，但必须放行可信 Harness iframe 的剪贴板读写。
  // Electron 会分别走 permission check 与 permission request 两条路径；两者必须使用同一策略，
  // 否则即使 request 放行，check 仍返回 false，navigator.clipboard 也会静默失败。
  const permissionHandlers = createPermissionHandlers(currentHarnessOrigin)
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback, details) => {
    permissionHandlers.request(permission, callback, details)
  })
  win.webContents.session.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) =>
    permissionHandlers.check(permission, requestingOrigin, details),
  )
}

function handleInitialPageLoadFailure(failure: InitialPageLoadFailure): void {
  const message = `窗口初始页面加载失败 [${failure.source}]：${failure.detail}`
  log(`window: ${message}`)
  // A user/system quit can abort an otherwise valid in-flight load. Keep that
  // rejection in the log, but do not turn an intentional shutdown into a crash.
  if (quitRequested || sessionEnding || quitting) return
  if (SMOKE || HARNESS_SMOKE) console.error(`SMOKE FAIL: ${message}`)
  process.exitCode = 1
  app.quit()
}

function createWindow(url: string): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: APP_NAME,
    show: !(SMOKE || HARNESS_SMOKE),
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) log(`renderer console error [${sourceId}:${line}] ${message}`)
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (errorCode === -3) return
    log(`renderer load failed (mainFrame=${isMainFrame}, code=${errorCode}) ${errorDescription}: ${validatedURL}`)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`renderer process exited (reason=${details.reason}, exitCode=${details.exitCode})`)
  })
  hardenWindow(mainWindow)
  loadInitialPage(mainWindow, url, handleInitialPageLoadFailure)
  mainWindow.on('close', (event) => {
    // 普通点右上角关闭只隐藏窗口，Harness 与后台进程继续运行；托盘菜单「退出」才真正退出。
    if (SMOKE || HARNESS_SMOKE || quitRequested || sessionEnding || !tray) return
    event.preventDefault()
    mainWindow?.hide()
  })
  if (process.platform === 'win32') {
    mainWindow.on('query-session-end', handleWindowsQuerySessionEnd)
    mainWindow.on('session-end', handleWindowsSessionEnd)
  }
  mainWindow.on('show', updateTrayMenu)
  mainWindow.on('hide', updateTrayMenu)
  mainWindow.on('minimize', updateTrayMenu)
  mainWindow.on('restore', updateTrayMenu)
  mainWindow.on('closed', () => {
    mainWindow = null
    updateTrayMenu()
  })
  // createTray() 通常先于窗口创建；显式刷新一次，避免托盘菜单保留初始的「显示窗口」状态。
  updateTrayMenu()
}

function createSkeletonWindow(): void {
  createWindow(RENDERER_URL)
  // harness iframe 导航完成时推送状态（iframe load 事件对长连接页面不可靠）
  mainWindow?.webContents.on('did-frame-navigate', (_e, frameURL, _code, _status, isMainFrame) => {
    const activeHarness = harness
    if (
      !isMainFrame
      && activeHarness
      && frameURL !== RENDERER_URL
      && isAllowedNavigation(frameURL, RENDERER_URL, activeHarness.url)
    ) {
      mainWindow?.webContents.send(IPC.harnessFrameLoaded, frameURL)
      sendHarnessStatus({ state: 'ready', url: activeHarness.url })
    }
  })
}

// ---- harness 生命周期监控（P2-11）：意外退出 → 通知 UI + 自动重启（墙钟限流） ----
function watchHarness(proc: HarnessHandle['proc']): void {
  proc.on('exit', (code, signal) => {
    // quitting：will-quit 清理期间不再触发自动重启（防关闭竞态 respawn 出孤儿）
    if (restarting || stoppingHarness || autoRestartTimer || quitting) return
    log(`harness: 意外退出（code=${code}, signal=${signal ?? ''}），自动重启`)

    harness = null
    if (!canAutoRestart()) {
      sendHarnessStatus({ state: 'exited', code, signal, error: 'Harness 反复异常退出，已停止自动重启；请点击重启按钮' })
      return
    }
    sendHarnessStatus({ state: 'exited', code, signal, error: 'Harness 意外退出，正在自动重启…' })
    void startHarnessAndWatch().catch((err) => {
      scheduleAutoRestart(`意外退出后重启失败（${err instanceof Error ? err.message : String(err)}）`)
    })
  })
}

function sendHarnessStatus(status: HarnessStatus): void {
  lastHarnessStatus = { ...status, since: Date.now() }
  try {
    shellWebContents()?.send(IPC.harnessStatus, lastHarnessStatus)
  } catch {
    /* 窗口未就绪/已销毁：状态仍由日志留痕 */
  }
}

/** 同步启动 harness 并等待就绪（冒烟模式 / 手动重启共用；失败抛错且不改窗口状态） */
async function startHarnessAndWatch(): Promise<void> {
  const generation = ++harnessStartGeneration
  let spawnedProc: ChildProcess | null = null
  sendHarnessStatus({ state: 'starting' })
  const startedAt = Date.now()
  try {
    const desktopHubPatch = await ensureDesktopHubPlugin()
    const exec = resolveDshExec()
    if (!exec) {
      log('harness: resolveDshExec 返回 null —— 捆绑运行时缺失且系统无 dsh')
      throw new Error('未找到 dsh 运行时（捆绑运行时缺失且系统未安装 dsh），错误详情见运行日志')
    }
    log(`harness: 使用${exec.node ? '捆绑' : 'PATH 回退'}运行时（node=${exec.node ?? 'PATH'}，dsh=${exec.exec}）`)
    const next = await startHarness({
      profile: ACTIVE_PROFILE,
      patchFiles: [desktopHubPatch],
      readyTimeoutMs: 180_000,
      onLog: (line) => {
        log(`dsh: ${line}`)
        recentDshLog.push(line)
        if (recentDshLog.length > 10) recentDshLog.shift()
      },
      onSpawn: (proc) => {
        spawnedProc = proc
        if (generation !== harnessStartGeneration) {
          harnessCleanupRetries.add(proc)
          void stopTree(proc).then(
            () => harnessCleanupRetries.delete(proc),
            (err: unknown) => {
              log(`harness: 清理已失效启动进程失败 —— ${err instanceof Error ? err.message : String(err)}`)
            },
          )
          return
        }
        startingProc = proc
        log(`harness: 子进程已启动（pid=${proc.pid}）`)
      },
    })
    // stopHarness() 可能在 startHarness() 等待期间取消了这一代；不能让已停止的进程重新成为当前 harness。
    if (generation !== harnessStartGeneration || stoppingHarness || quitting) {
      try {
        await next.stop()
      } catch (error) {
        harnessCleanupRetries.add(next.proc)
        log(`harness: 清理已失效就绪进程失败 —— ${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }

    harness = next
    if (startingProc === next.proc) startingProc = null
    harnessCleanupRetries.delete(next.proc)
    watchHarness(next.proc)
    lastHarnessStartupMs = Date.now() - startedAt
    log(`harness: 就绪 ${next.url}（启动耗时 ${(lastHarnessStartupMs / 1000).toFixed(1)}s）`)
    if (lastHarnessStartupMs > SLOW_START_LOG_MS) {
      log(`harness: 本次启动超过 ${Math.round(SLOW_START_LOG_MS / 1000)}s —— 常见原因是杀毒软件/Defender 逐文件扫描捆绑运行时；` +
        '将 DSH Desktop Hub 安装目录加入排除项通常可显著加速（详见运行日志与反馈诊断中的 Harness last startup）')
    }
    sendHarnessStatus({ state: 'ready', url: next.url })
  } catch (err) {
    // startHarness 仅在原始启动错误之后的 stopTree 也失败时抛 AggregateError。
    // 将这一代的确切句柄转入 retry set，后续世代覆盖 startingProc 也不会丢失它。
    if (err instanceof AggregateError && spawnedProc) harnessCleanupRetries.add(spawnedProc)
    if (startingProc === spawnedProc) startingProc = null
    // 被主动停止/新一代启动取消的 Promise 不算启动失败，也不能触发自动重试。
    if (generation !== harnessStartGeneration || stoppingHarness || quitting) return
    const msg = err instanceof Error ? err.message : String(err)
    // 附上 dsh 最近输出（截断），让 UI 直接显示真实失败原因而不是干等 180s 或笼统报错
    const tail = recentDshLog.slice(-10).join('\n').slice(0, 800)
    const withTail = tail ? `${msg}\n--- dsh 最近输出 ---\n${tail}` : msg
    log(`harness: 启动失败 —— ${withTail}`)
    sendHarnessStatus({ state: 'exited', code: -1, error: withTail })
    throw err
  }
}

/** 后台启动（默认产品行为）：失败按指数退避自动重试，最多 5 次后交还 UI 手动重启 */
function startHarnessBackground(): void {
  void startHarnessAndWatch().catch((err) => {
    scheduleAutoRestart(`启动失败（${err instanceof Error ? err.message : String(err)}）`)
  })
}

function scheduleAutoRestart(reason: string): void {
  if (!canAutoRestart()) return
  const attempt = autoRestartTimes.length
  const delay = Math.min(3_000 * 2 ** (attempt - 1), 60_000)
  log(`harness: ${reason}（${attempt}/8 次/10 分钟），${Math.round(delay / 1000)}s 后自动重试`)
  clearTimeout(autoRestartTimer ?? undefined)
  autoRestartTimer = setTimeout(() => {
    autoRestartTimer = null
    void startHarnessAndWatch().catch((err) => {
      log(`harness: 自动重试失败 —— ${err instanceof Error ? err.message : String(err)}`)
      scheduleAutoRestart('自动重试失败')
    })
  }, delay)
}

/** 主动停止（手动重启 / 退出用）：抑制 watchHarness 的自动重启 */
async function stopHarness(): Promise<void> {
  stoppingHarness = true

  // 先使所有在途启动失效，再等待其子进程退出，避免旧 Promise 重新写回 harness。
  harnessStartGeneration += 1
  const errors: unknown[] = []
  try {
    const activeHarness = harness
    const startingProcesses = new Set(harnessCleanupRetries)
    if (startingProc) startingProcesses.add(startingProc)
    if (activeHarness) startingProcesses.delete(activeHarness.proc)
    for (const proc of startingProcesses) {
      try {
        await stopTree(proc)
        harnessCleanupRetries.delete(proc)
        if (startingProc === proc) startingProc = null
      } catch (error) {
        harnessCleanupRetries.add(proc)
        const detail = error instanceof Error ? error.message : String(error)
        errors.push(new Error(`Harness 启动进程树停止失败（pid=${proc.pid ?? 'unknown'}）：${detail}`, { cause: error }))
      }
    }
    if (activeHarness) {
      try {
        await activeHarness.stop()
        if (harness === activeHarness) harness = null
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        errors.push(new Error(`Harness 运行进程树停止失败（pid=${activeHarness.proc.pid ?? 'unknown'}）：${detail}`, { cause: error }))
      }
    }
    if (errors.length > 0) {
      const detail = errors.map((error) => error instanceof Error ? error.message : String(error)).join('；')
      throw new AggregateError(errors, `Harness 后台进程清理失败：${detail}`)
    }
  } finally {
    stoppingHarness = false
  }
}

/** 手动重启（UI 按钮触发，同步等待结果并回传渲染层） */
async function restartHarness(): Promise<{ ok: boolean; url?: string; error?: string }> {
  if (restarting) return { ok: false, error: 'Harness 正在重启中' }
  restarting = true
  clearTimeout(autoRestartTimer ?? undefined)
  autoRestartTimer = null
  sendHarnessStatus({ state: 'restarting' })
  try {
    // 初次后台启动尚未就绪时 harness 仍为 null，但 startingProc 已经存在；必须无条件取消它。
    await stopHarness()
    await startHarnessAndWatch()
    return { ok: true, url: harness?.url }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sendHarnessStatus({ state: 'exited', code: -1, error: msg })
    return { ok: false, error: msg }
  } finally {
    restarting = false
  }
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      // Windows 无 app 菜单（菜单在窗口内），首项用「文件」更符合平台习惯；mac 用 app 名
      { label: process.platform === 'win32' ? '文件' : APP_NAME, submenu: [{ role: 'quit', label: '退出' }] },
      {
        label: '编辑',
        submenu: [
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { role: 'selectAll', label: '全选' },
        ],
      },
      {
        label: '窗口',
        submenu: [{ role: 'togglefullscreen', label: '全屏' }],
      },
    ]),
  )
}

app.on('second-instance', () => {
  // 冒烟模式的 harness 启动是异步的；不要在它完成前创建额外窗口。
  if (SMOKE || HARNESS_SMOKE) return
  showMainWindow()
})

function handleStartupFatal(error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  log(`startup: fatal —— ${detail}`)
  console.error(`STARTUP FATAL: ${detail}`)
  process.exitCode = 1
  // 统一走正常退出事件，让 will-quit 有机会停止已启动或仍在途的 Harness。
  app.quit()
}

void app.whenReady().then(async () => {
  rendererServer = await startLocalRendererServer(RENDERER_ROOT)
  RENDERER_URL = rendererServer.url
  registerIpc()
  updater.setup((status) => sendPluginEvent(IPC.updatesStatus, status))
  if (SMOKE) {
    createSkeletonWindow()
    wireSmoke({ mainWindow: () => mainWindow, harness: () => harness, artifactsDir: ARTIFACTS_DIR, harnessSmoke: false, managerUrl: embeddedManagerUrl(RENDERER_URL) })
    return
  }
  if (HARNESS_SMOKE) {
    await startHarnessAndWatch()
    createSkeletonWindow()
    wireSmoke({ mainWindow: () => mainWindow, harness: () => harness, artifactsDir: ARTIFACTS_DIR, harnessSmoke: true, managerUrl: embeddedManagerUrl(RENDERER_URL) })
    return
  }
  // 默认产品行为：窗口先行（立即出现，状态「连接中」，绝不因 harness 慢而空白/退出），
  // harness 后台启动；失败自动重试（指数退避），最多 5 次后状态条给出原因并等待手动重启
  buildMenu()
  createTray()
  createSkeletonWindow()
  startHarnessBackground()
  scheduleUpdateChecks()
  app.on('activate', () => {
    showMainWindow()
  })
}).catch(handleStartupFatal)

function releaseExitResources(): void {
  clearTimeout(autoRestartTimer ?? undefined)
  autoRestartTimer = null
  if (!tray) return
  const currentTray = tray
  tray = null
  try {
    currentTray.destroy()
  } catch {
    /* 退出阶段的托盘销毁失败不应阻止进程清理 */
  }
}

/** 停止退出时仍在途的 Harness；由统一后台清理链在 mutation drain 后调用。 */
async function stopHarnessForExit(): Promise<void> {
  await stopHarness()
}

let backgroundStopPromise: Promise<void> | null = null

function hasBackgroundWorkForExit(): boolean {
  return pluginOps.hasActiveOperations()
    || pendingMutations > 0
    || skillImportTasks.pendingCount() > 0
    || harnessCleanupRetries.size > 0
    || Boolean(harness || startingProc)
}

const MUTATION_EXIT_TIMEOUT_MS = 2_000
const SKILL_IMPORT_EXIT_TIMEOUT_MS = 2_000
const HARNESS_EXIT_TIMEOUT_MS = 5_000

function waitForExitStage<T>(label: string, task: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}在 ${timeoutMs}ms 内未完成`)), timeoutMs)
  })
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer))
}

/**
 * 退出顺序必须固定：先禁止/取消插件操作，再 drain profile 写队列，最后停止 Harness。
 * shutdown 会先 cancel 当前插件进程，因此等待 mutationChain 不会和插件 execute 相互死锁。
 */
function stopBackgroundWorkForExit(): Promise<void> {
  if (backgroundStopPromise) return backgroundStopPromise
  mutationsShuttingDown = true
  skillImportTasks.beginShutdown()
  backgroundStopPromise = (async () => {
    const errors: unknown[] = []
    try {
      await pluginOps.shutdown()
    } catch (error) {
      errors.push(error)
    }
    try {
      await waitForExitStage('profile 写队列收口', mutationChain, MUTATION_EXIT_TIMEOUT_MS)
    } catch (error) {
      errors.push(error)
    }
    try {
      await waitForExitStage('Skill 导入收口', skillImportTasks.drain(), SKILL_IMPORT_EXIT_TIMEOUT_MS)
    } catch (error) {
      errors.push(error)
    }
    try {
      await waitForExitStage('Harness 清理', stopHarnessForExit(), HARNESS_EXIT_TIMEOUT_MS)
    } catch (error) {
      errors.push(error)
    }
    if (errors.length > 0) {
      const detail = errors.map((error) => error instanceof Error ? error.message : String(error)).join('；')
      throw new AggregateError(errors, `后台任务退出清理失败：${detail}`)
    }
  })()
  return backgroundStopPromise
}

function currentExitCode(): number {
  return typeof process.exitCode === 'number' ? process.exitCode : 0
}

function markWindowsSessionEnding(): void {
  sessionEnding = true
  quitRequested = true
  releaseExitResources()
}

function handleWindowsQuerySessionEnd(event: { preventDefault: () => void }): void {
  markWindowsSessionEnding()
  // query-session-end 是唯一可以在 Windows 关机/重启/注销前争取清理时间的事件。
  if (!hasBackgroundWorkForExit() || quitting) return
  quitting = true
  event.preventDefault()
  void stopBackgroundWorkForExit()
    .catch((err) => log(`session-end: 后台任务清理失败 —— ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => app.exit(currentExitCode()))
}

function handleWindowsSessionEnd(): void {
  // session-end 无法再阻止系统退出；至少确保任何后续 close 不会被托盘逻辑拦截。
  markWindowsSessionEnding()
}

app.on('before-quit', () => {
  // app.quit()（包括应用菜单）会先触发 before-quit，再触发 BrowserWindow close。
  // 记录该状态后，close handler 才会放行真正的窗口关闭。
  quitRequested = true
})

app.on('window-all-closed', () => {
  // 有托盘时窗口关闭只是隐藏；即使窗口因渲染崩溃被销毁，也让用户从托盘重新打开。
  if (process.platform !== 'darwin' && !tray) app.quit()
})

app.on('will-quit', (e) => {
  releaseExitResources()
  if (rendererServer) {
    const server = rendererServer
    rendererServer = null
    void server.close().catch((error) => log(`renderer: 本机静态服务关闭失败 —— ${error instanceof Error ? error.message : String(error)}`))
  }
  clearTimeout(updateInitialTimer ?? undefined)
  updateInitialTimer = null
  clearInterval(updateInterval ?? undefined)
  updateInterval = null
  // detached 的 Harness / plugin 子进程与已确认的 profile 写操作都必须在退出前收口。
  if (hasBackgroundWorkForExit() && !quitting) {
    quitting = true
    e.preventDefault()
    void stopBackgroundWorkForExit()
      .catch((err) => log(`will-quit: 后台任务清理失败 —— ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        // app.quit() does not guarantee propagation of Node's process.exitCode
        // through Electron's native quit path. Cleanup is complete now, so use
        // app.exit() to return the smoke result deterministically.
        app.exit(currentExitCode())
      })
  } else if (typeof process.exitCode === 'number' && !quitting) {
    // Skeleton smoke has no Harness child to clean up, but it still needs its
    // assertion result to reach CI instead of being flattened to zero.
    quitting = true
    e.preventDefault()
    app.exit(process.exitCode)
  }
})
