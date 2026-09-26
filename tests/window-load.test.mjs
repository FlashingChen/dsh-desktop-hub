import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { loadInitialPage } from '../dist/main/window-load.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fakeWindow(loadURL) {
  const webContents = new EventEmitter()
  return { webContents, loadURL }
}

const nextImmediate = () => new Promise((resolve) => setImmediate(resolve))

test('初始页面 loadURL rejection 被捕获并只报告一次', async () => {
  const load = deferred()
  const failures = []
  const win = fakeWindow(() => load.promise)

  loadInitialPage(win, 'file:///renderer/index.html', (failure) => failures.push(failure))
  win.webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///renderer/index.html', true)
  load.reject(new Error('loadURL rejected'))
  await nextImmediate()

  assert.equal(failures.length, 1)
  assert.equal(failures[0].source, 'loadURL')
  assert.match(failures[0].detail, /loadURL rejected/)
  assert.equal(win.webContents.listenerCount('did-fail-load'), 0)
})

test('主帧 did-fail-load 在 Promise 未拒绝时仍可靠收口', async () => {
  const load = deferred()
  const failures = []
  const win = fakeWindow(() => load.promise)

  loadInitialPage(win, 'file:///renderer/index.html', (failure) => failures.push(failure))
  win.webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///missing.html', true)
  await nextImmediate()

  assert.deepEqual(failures, [
    { source: 'did-fail-load', detail: '-6 ERR_FILE_NOT_FOUND (file:///missing.html)' },
  ])
  assert.equal(win.webContents.listenerCount('did-fail-load'), 0)
})

test('子帧失败不影响初始壳层加载，成功后移除临时监听', async () => {
  const load = deferred()
  const failures = []
  const win = fakeWindow(() => load.promise)

  loadInitialPage(win, 'file:///renderer/index.html', (failure) => failures.push(failure))
  win.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://127.0.0.1:3000/', false)
  load.resolve()
  await load.promise
  await Promise.resolve()

  assert.deepEqual(failures, [])
  assert.equal(win.webContents.listenerCount('did-fail-load'), 0)
})

test('loadURL 同步抛错也会被捕获并移除监听', () => {
  const failures = []
  const win = fakeWindow(() => {
    throw new Error('invalid URL')
  })

  loadInitialPage(win, 'invalid:', (failure) => failures.push(failure))

  assert.equal(failures.length, 1)
  assert.equal(failures[0].source, 'loadURL')
  assert.match(failures[0].detail, /invalid URL/)
  assert.equal(win.webContents.listenerCount('did-fail-load'), 0)
})

test('主进程在加载前接管失败，并以非零状态走统一退出清理', () => {
  const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8')
  const handler = main.slice(main.indexOf('function handleInitialPageLoadFailure'), main.indexOf('function createWindow'))
  const createWindow = main.slice(main.indexOf('function createWindow'), main.indexOf('function createSkeletonWindow'))

  assert.match(handler, /log\(`window: \$\{message\}`\)/, '任何初始加载失败都必须落盘')
  assert.match(handler, /quitRequested \|\| sessionEnding \|\| quitting/, '主动退出导致的加载中止不应误报崩溃')
  assert.match(handler, /SMOKE \|\| HARNESS_SMOKE/, '两种冒烟模式都必须输出明确失败')
  assert.match(handler, /process\.exitCode = 1/, '加载失败必须返回非零状态')
  assert.match(handler, /app\.quit\(\)/, '加载失败必须经过统一退出清理')
  assert.match(createWindow, /hardenWindow\(mainWindow\)[\s\S]*loadInitialPage\(mainWindow, url, handleInitialPageLoadFailure\)/)
  assert.doesNotMatch(createWindow, /void mainWindow\.loadURL/, '不得再遗留无处理的 loadURL Promise')
})

test('smoke 不再迟注册重复的初始主帧失败监听', () => {
  const smoke = readFileSync(new URL('../src/main/smoke.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(smoke, /did-fail-load/, '初始加载失败应只由加载前注册的主进程 helper 收口')
})
