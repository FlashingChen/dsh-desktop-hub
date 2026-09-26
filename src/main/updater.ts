// 应用更新：通过 GitHub Releases 检查、手动下载并安装桌面端更新。
// electron-builder 负责生成 app-update.yml；开发模式不触碰网络，也不把错误刷到用户界面。
import { spawnSync } from 'node:child_process'
import electron from 'electron'
import electronUpdater, { type ProgressInfo, type UpdateInfo } from 'electron-updater'
import type { UpdateActionResult, UpdateState, UpdateStatus } from '../core/ipc.js'
import { log } from '../core/log.js'

// electron-updater 目前是 CommonJS 包；NodeNext 的 ESM 命名导入在 Electron
// 加载器中不可用，使用 default namespace 兼容打包后的运行时。
const { app } = electron

type StatusSender = (status: UpdateStatus) => void

interface UpdaterController {
  setup(send: StatusSender): void
  status(): UpdateStatus
  check(): Promise<UpdateActionResult>
  download(): Promise<UpdateActionResult>
  install(): UpdateActionResult
}

type AppLike = Pick<typeof app, 'getVersion' | 'getPath' | 'isPackaged'>

interface UpdaterDependencies {
  updater?: typeof electronUpdater.autoUpdater
  app?: AppLike
  getUnavailableReason?: () => string | null
  writeLog?: (message: string) => void
  scheduleImmediate?: (callback: () => void) => unknown
}

function currentVersion(runtimeApp: AppLike): string {
  try {
    return runtimeApp.getVersion()
  } catch {
    return 'unknown'
  }
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim().slice(0, 500) || '未知更新错误'
}

/**
 * Squirrel.Mac replaces the running app bundle. An unsigned/ad-hoc macOS
 * build cannot be safely updated, so leave the manual DMG path available
 * instead of advertising a download that will fail at installation time.
 */
function macUpdateUnavailableReason(runtimeApp: AppLike): string | null {
  if (!runtimeApp.isPackaged || process.platform !== 'darwin') return null
  const result = spawnSync('codesign', ['-dv', '--verbose=4', runtimeApp.getPath('exe')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const details = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const hasAuthority = /(?:^|\n)Authority=/.test(details)
  const isAdHoc = /(?:^|\n)Signature=adhoc(?:\n|$)/.test(details)
  if (result.status === 0 && hasAuthority && !isAdHoc) return null
  return '当前 macOS 版本未完成正式代码签名，应用内更新已禁用；请从 GitHub Releases 下载最新 DMG'
}

function unavailableReason(runtimeApp: AppLike): string | null {
  if (!runtimeApp.isPackaged) return '开发模式不检查更新；打包安装版会自动检查 GitHub Releases'
  return macUpdateUnavailableReason(runtimeApp)
}

function infoFields(info: UpdateInfo): Pick<UpdateStatus, 'version' | 'releaseName' | 'releaseDate'> {
  return {
    version: info.version,
    releaseName: typeof info.releaseName === 'string' ? info.releaseName : undefined,
    releaseDate: typeof info.releaseDate === 'string' ? info.releaseDate : undefined,
  }
}

export function createUpdater(dependencies: UpdaterDependencies = {}): UpdaterController {
  // electron-updater 的 autoUpdater 是惰性 getter；仅在未注入 fake 时触发，
  // 使状态机可在普通 Node 测试进程中实测而不启动 Electron。
  const updater = dependencies.updater ?? electronUpdater.autoUpdater
  const runtimeApp = dependencies.app ?? app
  const writeLog = dependencies.writeLog ?? log
  const scheduleImmediate = dependencies.scheduleImmediate ?? setImmediate
  const getUnavailableReason = dependencies.getUnavailableReason ?? (() => unavailableReason(runtimeApp))
  let send: StatusSender = () => undefined
  let configured = false
  // 签名状态/打包状态在会话内不变：首次调用后缓存，避免每次定时检查都同步 spawn codesign。
  let cachedUnavailable: string | null | undefined
  let pendingUpdate: UpdateInfo | null = null
  let checkPromise: Promise<UpdateActionResult> | null = null
  let downloadPromise: Promise<UpdateActionResult> | null = null
  let installRequested = false
  let currentStatus: UpdateStatus = {
    state: 'idle',
    currentVersion: currentVersion(runtimeApp),
  }

  const publish = (state: UpdateState, extra: Omit<UpdateStatus, 'state' | 'currentVersion'> = {}): UpdateStatus => {
    currentStatus = { state, currentVersion: currentVersion(runtimeApp), ...extra }
    send(currentStatus)
    return currentStatus
  }

  /** error event 与 Promise rejection 可能报告同一个错误；保留更新元数据并幂等发布。 */
  const publishError = (message: string): UpdateStatus => {
    const update = pendingUpdate ? infoFields(pendingUpdate) : {}
    if (
      currentStatus.state === 'error'
      && currentStatus.error === message
      && currentStatus.version === update.version
      && currentStatus.releaseName === update.releaseName
      && currentStatus.releaseDate === update.releaseDate
    ) {
      return currentStatus
    }
    return publish('error', { ...update, error: message })
  }

  const result = (ok: boolean, error?: string): UpdateActionResult => ({
    ok,
    status: { ...currentStatus },
    ...(error ? { error } : {}),
  })

  /** 返回不可用原因；可用时返回 null。结果按会话缓存（#8）。 */
  function unavailable(): string | null {
    if (cachedUnavailable === undefined) cachedUnavailable = getUnavailableReason()
    return cachedUnavailable
  }

  /** check/download 共用的不可用守卫；不可用时返回拒绝结果（#7）。 */
  function guardUnavailable(): UpdateActionResult | null {
    const reason = unavailable()
    if (!reason) return null
    publish('unsupported', { error: reason })
    return result(false, reason)
  }

  function configure(): void {
    if (configured) return
    configured = true
    // 只检查不自动下载：由用户明确点击下载，避免启动应用时悄悄消耗流量。
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.allowPrerelease = false
    updater.logger = {
      info: (message?: unknown) => writeLog(`updater: ${String(message ?? '')}`),
      warn: (message?: unknown) => writeLog(`updater warn: ${String(message ?? '')}`),
      error: (message?: unknown) => writeLog(`updater error: ${String(message ?? '')}`),
    }

    updater.on('checking-for-update', () => {
      publish('checking', pendingUpdate ? infoFields(pendingUpdate) : {})
    })
    updater.on('update-available', (info) => {
      pendingUpdate = info
      publish('available', infoFields(info))
      writeLog(`updater: 发现新版本 ${info.version}`)
    })
    updater.on('update-not-available', (info) => {
      pendingUpdate = null
      publish('not-available', infoFields(info))
      writeLog(`updater: 当前已是最新版本 ${info.version}`)
    })
    updater.on('download-progress', (progress: ProgressInfo) => {
      publish('downloading', {
        ...(pendingUpdate ? infoFields(pendingUpdate) : {}),
        percent: Math.max(0, Math.min(100, progress.percent)),
      })
    })
    updater.on('update-downloaded', (info) => {
      pendingUpdate = info
      publish('downloaded', infoFields(info))
      writeLog(`updater: 新版本 ${info.version} 已下载`)
    })
    updater.on('error', (error) => {
      // 仅在「已下载待安装」状态下复位安装锁（quitAndInstall 异步失败）；
      // 安装等待期无关的定时检查错误不应重新放开双重点击。
      if (installRequested && currentStatus.state === 'downloaded') installRequested = false
      const message = errorText(error)
      publishError(message)
      writeLog(`updater: ${message}`)
    })

    const unavailableNow = unavailable()
    publish(unavailableNow ? 'unsupported' : 'idle', unavailableNow ? { error: unavailableNow } : {})
  }

  function check(): Promise<UpdateActionResult> {
    configure()
    const blocked = guardUnavailable()
    if (blocked) return Promise.resolve(blocked)
    if (currentStatus.state === 'downloading' || currentStatus.state === 'downloaded') return Promise.resolve(result(true))
    if (checkPromise) return checkPromise

    // Promise.resolve().then 让 checkPromise 在 updater 可能同步 throw 之前就完成登记，
    // 并发调用因而共用同一个底层检查与同一 Promise。
    const task = Promise.resolve().then(async () => {
      publish('checking', pendingUpdate ? infoFields(pendingUpdate) : {})
      try {
        const checked = await updater.checkForUpdates()
        // 某些平台/版本的 updater 只返回结果而不及时派发事件，以结果补齐状态。
        if (checked?.isUpdateAvailable) {
          pendingUpdate = checked.updateInfo
          if (currentStatus.state !== 'available' || currentStatus.version !== checked.updateInfo.version) {
            publish('available', infoFields(checked.updateInfo))
          }
        } else if (checked && !checked.isUpdateAvailable) {
          pendingUpdate = null
          if (currentStatus.state !== 'not-available' || currentStatus.version !== checked.updateInfo.version) {
            publish('not-available', infoFields(checked.updateInfo))
          }
        } else if (currentStatus.state === 'error') {
          const message = currentStatus.error ?? '更新检查失败'
          return result(false, message)
        } else if (currentStatus.state !== 'available' && currentStatus.state !== 'not-available') {
          const message = '更新检查未返回结果'
          publishError(message)
          return result(false, message)
        }
        return result(true)
      } catch (error) {
        const message = errorText(error)
        publishError(message)
        return result(false, message)
      }
    })
    const tracked = task.finally(() => {
      if (checkPromise === tracked) checkPromise = null
    })
    checkPromise = tracked
    return checkPromise
  }

  async function download(): Promise<UpdateActionResult> {
    configure()
    const blocked = guardUnavailable()
    if (blocked) return blocked
    if (currentStatus.state === 'downloaded') return result(true)
    if (downloadPromise) return downloadPromise
    if (!pendingUpdate && currentStatus.state !== 'available') {
      const message = '当前没有可下载的更新，请先检查更新'
      publish('error', { error: message })
      return result(false, message)
    }

    downloadPromise = (async () => {
      publish('downloading', {
        ...(pendingUpdate ? infoFields(pendingUpdate) : {}),
        percent: 0,
      })
      try {
        await updater.downloadUpdate()
        return result(true)
      } catch (error) {
        const message = errorText(error)
        publishError(message)
        return result(false, message)
      } finally {
        downloadPromise = null
      }
    })()
    return downloadPromise
  }

  function install(): UpdateActionResult {
    configure()
    if (currentStatus.state !== 'downloaded') {
      const message = '更新尚未下载完成'
      return result(false, message)
    }
    if (installRequested) return result(true)
    installRequested = true
    // 让 IPC invoke 先返回，再由 updater 接管退出和安装流程；双重点击不会
    // 排队多个 quitAndInstall 回调。
    scheduleImmediate(() => {
      try {
        updater.quitAndInstall(false, true)
      } catch (error) {
        installRequested = false
        const message = errorText(error)
        publishError(message)
        writeLog(`updater: 安装失败 —— ${message}`)
      }
    })
    return result(true)
  }

  return {
    setup(nextSend) {
      send = nextSend
      configure()
    },
    status() {
      configure()
      return { ...currentStatus }
    },
    check,
    download,
    install,
  }
}
