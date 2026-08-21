// 应用更新：通过 GitHub Releases 检查、手动下载并安装桌面端更新。
// electron-builder 负责生成 app-update.yml；开发模式不触碰网络，也不把错误刷到用户界面。
import { spawnSync } from 'node:child_process'
import { app } from 'electron'
import electronUpdater, { type ProgressInfo, type UpdateInfo } from 'electron-updater'
import type { UpdateActionResult, UpdateState, UpdateStatus } from '../core/ipc.js'
import { log } from '../core/log.js'

// electron-updater 目前是 CommonJS 包；NodeNext 的 ESM 命名导入在 Electron
// 加载器中不可用，使用 default namespace 兼容打包后的运行时。
const { autoUpdater } = electronUpdater

type StatusSender = (status: UpdateStatus) => void

interface UpdaterController {
  setup(send: StatusSender): void
  status(): UpdateStatus
  check(): Promise<UpdateActionResult>
  download(): Promise<UpdateActionResult>
  install(): UpdateActionResult
}

function currentVersion(): string {
  try {
    return app.getVersion()
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
function macUpdateUnavailableReason(): string | null {
  if (!app.isPackaged || process.platform !== 'darwin') return null
  const result = spawnSync('codesign', ['-dv', '--verbose=4', app.getPath('exe')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const details = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const hasAuthority = /(?:^|\n)Authority=/.test(details)
  const isAdHoc = /(?:^|\n)Signature=adhoc(?:\n|$)/.test(details)
  if (result.status === 0 && hasAuthority && !isAdHoc) return null
  return '当前 macOS 版本未完成正式代码签名，应用内更新已禁用；请从 GitHub Releases 下载最新 DMG'
}

function unavailableReason(): string | null {
  if (!app.isPackaged) return '开发模式不检查更新；打包安装版会自动检查 GitHub Releases'
  return macUpdateUnavailableReason()
}

function infoFields(info: UpdateInfo): Pick<UpdateStatus, 'version' | 'releaseName' | 'releaseDate'> {
  return {
    version: info.version,
    releaseName: typeof info.releaseName === 'string' ? info.releaseName : undefined,
    releaseDate: typeof info.releaseDate === 'string' ? info.releaseDate : undefined,
  }
}

export function createUpdater(): UpdaterController {
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
    currentVersion: currentVersion(),
  }

  const publish = (state: UpdateState, extra: Omit<UpdateStatus, 'state' | 'currentVersion'> = {}): UpdateStatus => {
    currentStatus = { state, currentVersion: currentVersion(), ...extra }
    send(currentStatus)
    return currentStatus
  }

  const result = (ok: boolean, error?: string): UpdateActionResult => ({
    ok,
    status: { ...currentStatus },
    ...(error ? { error } : {}),
  })

  /** 返回不可用原因；可用时返回 null。结果按会话缓存（#8）。 */
  function unavailable(): string | null {
    if (cachedUnavailable === undefined) cachedUnavailable = unavailableReason()
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
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowPrerelease = false
    autoUpdater.logger = {
      info: (message?: unknown) => log(`updater: ${String(message ?? '')}`),
      warn: (message?: unknown) => log(`updater warn: ${String(message ?? '')}`),
      error: (message?: unknown) => log(`updater error: ${String(message ?? '')}`),
    }

    autoUpdater.on('checking-for-update', () => {
      publish('checking')
    })
    autoUpdater.on('update-available', (info) => {
      pendingUpdate = info
      publish('available', infoFields(info))
      log(`updater: 发现新版本 ${info.version}`)
    })
    autoUpdater.on('update-not-available', (info) => {
      pendingUpdate = null
      publish('not-available', infoFields(info))
      log(`updater: 当前已是最新版本 ${info.version}`)
    })
    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      publish('downloading', {
        ...(pendingUpdate ? infoFields(pendingUpdate) : {}),
        percent: Math.max(0, Math.min(100, progress.percent)),
      })
    })
    autoUpdater.on('update-downloaded', (info) => {
      pendingUpdate = info
      publish('downloaded', infoFields(info))
      log(`updater: 新版本 ${info.version} 已下载`)
    })
    autoUpdater.on('error', (error) => {
      // quitAndInstall 失败时允许用户从「重启更新」再次尝试；检查/下载错误
      // 则不影响当前已下载状态的正常展示。
      if (installRequested) installRequested = false
      const message = errorText(error)
      publish('error', {
        ...(pendingUpdate ? infoFields(pendingUpdate) : {}),
        error: message,
      })
      log(`updater: ${message}`)
    })

    const unavailableNow = unavailable()
    publish(unavailableNow ? 'unsupported' : 'idle', unavailableNow ? { error: unavailableNow } : {})
  }

  async function check(): Promise<UpdateActionResult> {
    configure()
    const blocked = guardUnavailable()
    if (blocked) return blocked
    if (currentStatus.state === 'downloading' || currentStatus.state === 'downloaded') return result(true)
    if (checkPromise) return checkPromise

    checkPromise = (async () => {
      pendingUpdate = null
      publish('checking')
      try {
        const checked = await autoUpdater.checkForUpdates()
        // 某些平台/版本的 updater 只返回结果而不及时派发事件，以结果补齐状态。
        if (checked?.isUpdateAvailable && currentStatus.state === 'checking') {
          pendingUpdate = checked.updateInfo
          publish('available', infoFields(checked.updateInfo))
        } else if (checked && !checked.isUpdateAvailable && currentStatus.state === 'checking') {
          publish('not-available', infoFields(checked.updateInfo))
        }
        return result(true)
      } catch (error) {
        const message = errorText(error)
        publish('error', { error: message })
        return result(false, message)
      } finally {
        checkPromise = null
      }
    })()
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
        await autoUpdater.downloadUpdate()
        return result(true)
      } catch (error) {
        const message = errorText(error)
        publish('error', {
          ...(pendingUpdate ? infoFields(pendingUpdate) : {}),
          error: message,
        })
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
    setImmediate(() => {
      try {
        autoUpdater.quitAndInstall(false, true)
      } catch (error) {
        installRequested = false
        const message = errorText(error)
        publish('error', { error: message })
        log(`updater: 安装失败 —— ${message}`)
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
