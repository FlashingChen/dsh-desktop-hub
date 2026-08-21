// Issue #23：应用更新入口、GitHub 发布源与透明图标契约。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const read = (file) => readFileSync(join(root, file), 'utf8')

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

  assert.match(updater, /autoUpdater\.autoDownload = false/)
  assert.match(updater, /autoUpdater\.checkForUpdates\(\)/)
  assert.match(updater, /autoUpdater\.downloadUpdate\(\)/)
  assert.match(updater, /autoUpdater\.quitAndInstall\(/)
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
