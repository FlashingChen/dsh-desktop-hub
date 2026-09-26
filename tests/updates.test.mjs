// Issue #23：应用更新入口、GitHub 发布源与透明图标契约。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import { parse } from 'yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createUpdater } = await import(pathToFileURL(join(root, 'dist', 'main', 'updater.js')).href)

const read = (file) => readFileSync(join(root, file), 'utf8')

class FakeAutoUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = true
  logger = null
  checkCalls = 0
  downloadCalls = 0
  checkBehaviors = []
  downloadBehavior = async () => undefined

  checkForUpdates() {
    this.checkCalls += 1
    const behavior = this.checkBehaviors.shift()
    if (!behavior) throw new Error('未配置 checkForUpdates 行为')
    return behavior(this)
  }

  downloadUpdate() {
    this.downloadCalls += 1
    return this.downloadBehavior(this)
  }

  quitAndInstall() {}
}

const fakeApp = {
  isPackaged: true,
  getVersion: () => '1.0.0',
  getPath: () => '/fake/app',
}

function updaterFixture() {
  const updater = new FakeAutoUpdater()
  const statuses = []
  const controller = createUpdater({
    updater,
    app: fakeApp,
    getUnavailableReason: () => null,
    writeLog: () => {},
    scheduleImmediate: (callback) => callback(),
  })
  controller.setup((status) => statuses.push({ ...status }))
  return { updater, controller, statuses }
}

function updateInfo(version) {
  return { version, releaseName: `Release ${version}`, releaseDate: '2026-08-24T00:00:00.000Z' }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test('应用更新使用 GitHub Releases 发布源并随包携带 electron-updater', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.ok(pkg.dependencies?.['electron-updater'])

  const builder = parse(read('electron-builder.yml'))
  assert.deepEqual(builder.publish, {
    provider: 'github',
    owner: 'FlashingChen',
    repo: 'dsh-desktop-hub',
  })
  assert.ok(builder.mac.target.some((target) => target.target === 'zip'), 'macOS 更新必须发布 zip 载荷')
  assert.equal(builder.mac.artifactName, 'DSH-Desktop-Hub-${version}-${arch}-mac.${ext}')
})

test('应用更新链路包含自动检查、用户确认下载与重启安装', () => {
  const updater = read('src/main/updater.ts')
  const main = read('src/main/main.ts')
  const preload = read('src/preload/preload.ts')
  const renderer = read('src/renderer/renderer.ts')
  const html = read('src/renderer/index.html')
  const releaseWorkflow = read('.github/workflows/release.yml')

  assert.match(updater, /updater\.autoDownload = false/)
  assert.match(updater, /updater\.checkForUpdates\(\)/)
  assert.match(updater, /updater\.downloadUpdate\(\)/)
  assert.match(updater, /updater\.quitAndInstall\(/)
  assert.match(updater, /macUpdateUnavailableReason/)
  assert.match(main, /scheduleUpdateChecks\(\)/)
  assert.match(main, /IPC\.updatesCheck/)
  assert.match(preload, /updatesGetStatus/)
  assert.match(renderer, /appUpdateDownload/)
  assert.match(releaseWorkflow, /electron-builder --mac dmg zip --arm64/)
  assert.match(releaseWorkflow, /release\/\*\.zip/)
  assert.match(releaseWorkflow, /release\/\*\.zip\.blockmap/)
  assert.match(renderer, /appUpdateInstalling/)
  assert.match(renderer, /api\.updates\.install\(\)[\s\S]*catch/)
  assert.match(renderer, /status\.error \?\? '当前版本不支持应用内更新'/)
  assert.match(html, /id="app-update-status"/)
  assert.match(html, /id="app-update-install"/)
})

test('应用图标为带 alpha 通道的 PNG，避免四角白边', () => {
  const png = readFileSync(join(root, 'build', 'icon.png'))
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  // PNG IHDR: bit depth at byte 24, color type at byte 25；6 = RGBA。
  assert.equal(png.readUInt8(24), 8)
  assert.equal(png.readUInt8(25), 6)
})

test('available 后复查失败保留版本并仍可下载，error event/reject 只发布一次', async () => {
  const { updater, controller, statuses } = updaterFixture()
  const available = updateInfo('2.0.0')
  updater.checkBehaviors.push(async (self) => {
    self.emit('update-available', available)
    return { isUpdateAvailable: true, updateInfo: available }
  })
  const first = await controller.check()
  assert.equal(first.ok, true)
  assert.equal(first.status.state, 'available')
  assert.equal(first.status.version, '2.0.0')

  updater.checkBehaviors.push(async (self) => {
    const error = new Error('temporary offline')
    self.emit('error', error)
    throw error
  })
  const failed = await controller.check()
  assert.equal(failed.ok, false)
  assert.equal(failed.status.state, 'error')
  assert.equal(failed.status.version, '2.0.0')
  assert.equal(failed.status.releaseName, 'Release 2.0.0')
  assert.equal(statuses.filter((status) => status.state === 'error' && status.error === 'temporary offline').length, 1)

  updater.downloadBehavior = async (self) => {
    self.emit('update-downloaded', available)
  }
  const downloaded = await controller.download()
  assert.equal(downloaded.ok, true)
  assert.equal(downloaded.status.state, 'downloaded')
  assert.equal(downloaded.status.version, '2.0.0')
  assert.equal(updater.downloadCalls, 1)
})

test('successful available 替换旧版本，not-available 才清除可下载更新', async () => {
  const { updater, controller } = updaterFixture()
  const oldInfo = updateInfo('2.0.0')
  const newInfo = updateInfo('2.1.0')
  updater.checkBehaviors.push(async () => ({ isUpdateAvailable: true, updateInfo: oldInfo }))
  assert.equal((await controller.check()).status.version, '2.0.0')

  updater.checkBehaviors.push(async () => ({ isUpdateAvailable: true, updateInfo: newInfo }))
  const replaced = await controller.check()
  assert.equal(replaced.ok, true)
  assert.equal(replaced.status.state, 'available')
  assert.equal(replaced.status.version, '2.1.0')

  const currentInfo = updateInfo('1.0.0')
  updater.checkBehaviors.push(async (self) => {
    self.emit('update-not-available', currentInfo)
    return { isUpdateAvailable: false, updateInfo: currentInfo }
  })
  const cleared = await controller.check()
  assert.equal(cleared.ok, true)
  assert.equal(cleared.status.state, 'not-available')
  const download = await controller.download()
  assert.equal(download.ok, false)
  assert.equal(updater.downloadCalls, 0)
})

test('首次检查失败不会产生幽灵版本', async () => {
  const { updater, controller, statuses } = updaterFixture()
  updater.checkBehaviors.push(async (self) => {
    const error = new Error('offline')
    self.emit('error', error)
    throw error
  })
  const failed = await controller.check()
  assert.equal(failed.ok, false)
  assert.equal(failed.status.state, 'error')
  assert.equal(failed.status.version, undefined)
  assert.equal(statuses.filter((status) => status.state === 'error' && status.error === 'offline').length, 1)
  assert.equal((await controller.download()).ok, false)
  assert.equal(updater.downloadCalls, 0)
})

test('并发 check 共用同一 Promise 且只发起一次检查', async () => {
  const { updater, controller } = updaterFixture()
  const pending = deferred()
  updater.checkBehaviors.push(async () => pending.promise)
  const first = controller.check()
  const second = controller.check()
  assert.equal(first, second)
  await Promise.resolve()
  assert.equal(updater.checkCalls, 1)
  pending.resolve({ isUpdateAvailable: true, updateInfo: updateInfo('3.0.0') })
  const [left, right] = await Promise.all([first, second])
  assert.deepEqual(left, right)
  assert.equal(left.ok, true)
  assert.equal(left.status.state, 'available')
  assert.equal(left.status.version, '3.0.0')
})
