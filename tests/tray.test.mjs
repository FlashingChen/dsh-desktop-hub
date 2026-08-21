import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getTrayWindowAction } from '../dist/core/tray.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function pngInfo(path) {
  const png = readFileSync(path)
  assert.equal(png.toString('ascii', 1, 4), 'PNG', `${path} 不是 PNG`)
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    colorType: png[25],
  }
}

test('托盘激活会恢复最小化/隐藏窗口，并切换可见窗口', () => {
  assert.equal(getTrayWindowAction({ destroyed: false, minimized: false, visible: true }), 'hide')
  assert.equal(getTrayWindowAction({ destroyed: false, minimized: true, visible: true }), 'show')
  assert.equal(getTrayWindowAction({ destroyed: false, minimized: false, visible: false }), 'show')
  assert.equal(getTrayWindowAction({ destroyed: true, minimized: false, visible: true }), 'show')
})

test('后台托盘资源与窗口生命周期契约存在', () => {
  const main = readFileSync(join(root, 'src', 'main', 'main.ts'), 'utf8')
  const closeHandler = main.slice(main.indexOf("mainWindow.on('close'"), main.indexOf("mainWindow.on('show'"))

  const trayPath = join(root, 'resources', 'tray.png')
  const templatePath = join(root, 'resources', 'trayTemplate.png')
  const templateRetinaPath = join(root, 'resources', 'trayTemplate@2x.png')
  assert.ok(existsSync(trayPath), '缺少随包托盘图标')
  assert.deepEqual(pngInfo(templatePath), { width: 32, height: 32, colorType: 4 }, 'macOS 模板图标必须是 32x32 灰度透明 PNG')
  assert.deepEqual(pngInfo(templateRetinaPath), { width: 64, height: 64, colorType: 4 }, 'macOS Retina 模板图标必须是 64x64 灰度透明 PNG')
  assert.match(main, /new Tray\(/, '主进程必须创建托盘')
  assert.match(main, /setContextMenu\(/, '托盘必须提供上下文菜单')
  assert.match(main, /getTrayWindowAction\(/, '托盘点击必须使用统一窗口状态决策')
  assert.match(closeHandler, /event\.preventDefault\(\)/, '关闭窗口时必须拦截默认退出')
  assert.match(closeHandler, /mainWindow\?\.hide\(\)/, '普通关闭必须隐藏窗口')
  assert.match(closeHandler, /quitRequested/, '必须区分隐藏窗口与显式退出')
  assert.match(main, /nextTray\?\.destroy\(\)/, '托盘初始化失败时必须销毁已创建实例')
  assert.match(main, /(?:tray|currentTray)\.destroy\(\)/, '退出时必须销毁托盘')
  assert.match(main, /setTemplateImage\(true\)/, 'macOS 模板图标必须显式标记为 Template Image')
  assert.match(main, /\.on\('minimize', updateTrayMenu\)/, '最小化后必须刷新托盘菜单')
  assert.match(main, /\.on\('restore', updateTrayMenu\)/, '恢复后必须刷新托盘菜单')
  assert.match(main, /query-session-end/, 'Windows session-end 前必须放行窗口关闭并清理 Harness')
  assert.match(main, /session-end/, '必须处理 Windows session-end 兜底事件')
  assert.match(main, /sessionEnding/, 'Windows session-end 必须绕过托盘隐藏逻辑')

  const secondInstance = main.slice(main.indexOf("app.on('second-instance'"), main.indexOf('app.whenReady()'))
  assert.match(secondInstance, /SMOKE \|\| HARNESS_SMOKE/, '冒烟模式不得响应第二实例创建窗口')
})
