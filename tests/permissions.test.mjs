// 权限策略回归测试：剪贴板必须可用，敏感设备权限仍默认拒绝。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createPermissionHandlers, isPermissionAllowed } from '../dist/main/permissions.js'

const mainSource = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8')
const rendererSource = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
const trustedHarness = {
  isMainFrame: false,
  requestingOrigin: 'http://127.0.0.1:3080',
  embeddingOrigin: 'file://',
  trustedOrigin: 'http://127.0.0.1:3080',
}

test('可信 Harness iframe 的剪贴板写入和读取权限被放行', () => {
  assert.equal(isPermissionAllowed('clipboard-sanitized-write', trustedHarness), true)
  assert.equal(isPermissionAllowed('clipboard-read', trustedHarness), true)
})

test('剪贴板权限不对主帧、其他来源或其他嵌入者放行', () => {
  for (const context of [
    { ...trustedHarness, isMainFrame: true },
    { ...trustedHarness, requestingOrigin: 'http://127.0.0.1:3081', trustedOrigin: 'http://127.0.0.1:3080' },
    { ...trustedHarness, requestingOrigin: 'https://evil.example', trustedOrigin: 'http://127.0.0.1:3080' },
    { ...trustedHarness, embeddingOrigin: 'https://evil.example' },
    { ...trustedHarness, requestingUrl: 'https://evil.example/copy', requestingOrigin: undefined },
    { ...trustedHarness, trustedOrigin: null },
  ]) {
    assert.equal(isPermissionAllowed('clipboard-read', context), false)
    assert.equal(isPermissionAllowed('clipboard-sanitized-write', context), false)
  }
})

test('敏感权限和未知权限仍被拒绝', () => {
  for (const permission of [
    'media', // Electron 用一个 media 权限覆盖摄像头/麦克风
    'camera',
    'microphone',
    'geolocation',
    'display-capture',
    'notifications',
    'deprecated-sync-clipboard-read',
    'unknown',
  ]) {
    assert.equal(isPermissionAllowed(permission), false, `${permission} 不应被放行`)
  }
})

test('Electron request/check 适配器在运行时回调中执行同一策略', () => {
  const handlers = createPermissionHandlers(() => trustedHarness.trustedOrigin)
  let requestResult = null
  handlers.request('clipboard-sanitized-write', (granted) => {
    requestResult = granted
  }, {
    isMainFrame: trustedHarness.isMainFrame,
    requestingUrl: 'http://127.0.0.1:3080/chat',
  })
  assert.equal(requestResult, true)
  assert.equal(handlers.check('clipboard-read', trustedHarness.requestingOrigin, {
    isMainFrame: trustedHarness.isMainFrame,
    embeddingOrigin: trustedHarness.embeddingOrigin,
  }), true)
  assert.equal(handlers.check('clipboard-read', 'https://evil.example', {
    isMainFrame: false,
    embeddingOrigin: trustedHarness.embeddingOrigin,
  }), false)
})

test('Harness iframe 声明标准 Clipboard Permissions Policy', () => {
  assert.match(rendererSource, /<iframe[^>]+id="harness-frame"[^>]+allow="clipboard-read; clipboard-write"/s)
})

test('主进程注册两条权限路径并委托给同一适配器', () => {
  assert.match(mainSource, /createPermissionHandlers\(currentHarnessOrigin\)/)
  assert.match(mainSource, /permissionHandlers\.request\(permission, callback, details\)/)
  assert.match(mainSource, /permissionHandlers\.check\(permission, requestingOrigin, details\)/)
  assert.doesNotMatch(mainSource, /setPermissionRequestHandler\([^\n]*callback\(false\)/)
  assert.doesNotMatch(mainSource, /setPermissionCheckHandler\(\(\) => false\)/)
})

test('权限匹配是精确的，不接受相似或大小写变体', () => {
  for (const permission of ['clipboard-write', 'Clipboard-read', 'clipboard-sanitized-write-extra', '']) {
    assert.equal(isPermissionAllowed(permission), false, `${permission} 不应被放行`)
  }
})
