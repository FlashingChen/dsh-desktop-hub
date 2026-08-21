import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getTrayWindowAction } from '../dist/core/tray.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('托盘激活会恢复最小化/隐藏窗口，并切换可见窗口', () => {
  assert.equal(getTrayWindowAction({ destroyed: false, minimized: false, visible: true }), 'hide')
  assert.equal(getTrayWindowAction({ destroyed: false, minimized: true, visible: true }), 'show')
  assert.equal(getTrayWindowAction({ destroyed: false, minimized: false, visible: false }), 'show')
  assert.equal(getTrayWindowAction({ destroyed: true, minimized: false, visible: true }), 'show')
})

test('后台托盘资源与窗口生命周期契约存在', () => {
  const main = readFileSync(join(root, 'src', 'main', 'main.ts'), 'utf8')
  const closeHandler = main.slice(main.indexOf("mainWindow.on('close'"), main.indexOf("mainWindow.on('show'"))

  assert.ok(existsSync(join(root, 'resources', 'tray.png')), '缺少随包托盘图标')
  assert.match(main, /new Tray\(/, '主进程必须创建托盘')
  assert.match(main, /setContextMenu\(/, '托盘必须提供上下文菜单')
  assert.match(main, /getTrayWindowAction\(/, '托盘点击必须使用统一窗口状态决策')
  assert.match(closeHandler, /event\.preventDefault\(\)/, '关闭窗口时必须拦截默认退出')
  assert.match(closeHandler, /mainWindow\?\.hide\(\)/, '普通关闭必须隐藏窗口')
  assert.match(closeHandler, /quitRequested/, '必须区分隐藏窗口与显式退出')
  assert.match(main, /nextTray\?\.destroy\(\)/, '托盘初始化失败时必须销毁已创建实例')
  assert.match(main, /tray\.destroy\(\)/, '退出时必须销毁托盘')

  const secondInstance = main.slice(main.indexOf("app.on('second-instance'"), main.indexOf('app.whenReady()'))
  assert.match(secondInstance, /SMOKE \|\| HARNESS_SMOKE/, '冒烟模式不得响应第二实例创建窗口')
})
