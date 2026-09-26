import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createNavigationGuard,
  isAllowedFrameNavigation,
  isAllowedNavigation,
} from '../dist/main/navigation.js'

const rendererUrl = 'file:///opt/DSH%20Desktop/dist/renderer/index.html'
const harnessUrl = 'http://127.0.0.1:3080/app'

test('embedded manager accepts current centers and rejects the removed account route', () => {
  const shell = 'http://127.0.0.1:4000/index.html'
  for (const tab of ['plugin', 'mcp', 'skills', 'updates', 'feedback']) {
    assert.equal(isAllowedFrameNavigation(`http://127.0.0.1:4000/manager.html?embedded=1&tab=${tab}`, false, shell, harnessUrl), true)
  }
  assert.equal(isAllowedFrameNavigation('http://127.0.0.1:4000/manager.html?embedded=1&tab=account', false, shell, harnessUrl), false)
})

test('navigation policy only accepts the exact desktop shell URL', () => {
  assert.equal(isAllowedNavigation(rendererUrl, rendererUrl, null), true)
  assert.equal(isAllowedNavigation(`${rendererUrl}?unexpected=1`, rendererUrl, null), false)
  assert.equal(isAllowedNavigation('file:///tmp/dist/renderer/index.html', rendererUrl, null), false)
})

test('navigation policy accepts URLs within the current trusted Harness origin', () => {
  assert.equal(isAllowedNavigation('http://127.0.0.1:3080/', rendererUrl, harnessUrl), true)
  assert.equal(isAllowedNavigation('http://127.0.0.1:3080/settings?tab=mcp#server', rendererUrl, harnessUrl), true)
})

test('frame-aware policy keeps the main frame on the exact shell and Harness in subframes', () => {
  assert.equal(isAllowedFrameNavigation(rendererUrl, true, rendererUrl, harnessUrl), true)
  assert.equal(isAllowedFrameNavigation(harnessUrl, true, rendererUrl, harnessUrl), false)
  assert.equal(isAllowedFrameNavigation(`${harnessUrl}/settings`, false, rendererUrl, harnessUrl), true)
  assert.equal(isAllowedFrameNavigation(rendererUrl, false, rendererUrl, harnessUrl), false)
  assert.equal(isAllowedFrameNavigation('about:blank', false, rendererUrl, harnessUrl), false)
})

test('navigation guard 对 navigate/redirect 都按目标 frame 身份阻止导航', () => {
  let currentHarness = harnessUrl
  const guard = createNavigationGuard(rendererUrl, () => currentHarness)
  const navigate = (url, isMainFrame) => {
    let prevented = false
    guard({ url, isMainFrame, preventDefault: () => { prevented = true } })
    return prevented
  }

  assert.equal(navigate(harnessUrl, true), true, 'Harness 子页不得替换主壳')
  assert.equal(navigate(rendererUrl, true), false)
  assert.equal(navigate('http://127.0.0.1:3080/redirected', false), false)
  assert.equal(navigate('http://attacker@127.0.0.1:3080/', false), true)
  assert.equal(navigate('https://evil.example/', false), true)
  currentHarness = null
  assert.equal(navigate('http://127.0.0.1:3080/', false), true)
})

test('navigation policy rejects credential-based host confusion', () => {
  assert.equal(isAllowedNavigation('http://127.0.0.1:3080@evil.example/', rendererUrl, harnessUrl), false)
  assert.equal(isAllowedNavigation('http://attacker@127.0.0.1:3080/', rendererUrl, harnessUrl), false)
  assert.equal(isAllowedNavigation('http://attacker:secret@127.0.0.1:3080/', rendererUrl, harnessUrl), false)
})

test('navigation policy rejects lookalike hosts, other loopback ports, and non-HTTP URLs', () => {
  const rejected = [
    'http://127.0.0.1.evil.example:3080/',
    'http://localhost:3080/',
    'http://127.0.0.2:3080/',
    'http://[::1]:3080/',
    'http://127.0.0.1:3081/',
    'https://127.0.0.1:3080/',
    'not a URL',
  ]
  for (const candidate of rejected) {
    assert.equal(isAllowedNavigation(candidate, rendererUrl, harnessUrl), false, candidate)
  }
})

test('navigation policy rejects an absent or untrusted Harness URL', () => {
  const candidate = 'http://127.0.0.1:3080/'
  assert.equal(isAllowedNavigation(candidate, rendererUrl, null), false)
  assert.equal(isAllowedNavigation(candidate, rendererUrl, 'https://127.0.0.1:3080/'), false)
  assert.equal(isAllowedNavigation(candidate, rendererUrl, 'http://localhost:3080/'), false)
  assert.equal(isAllowedNavigation(candidate, rendererUrl, 'http://owner@127.0.0.1:3080/'), false)
})
