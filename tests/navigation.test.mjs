import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createNavigationGuard,
  isAllowedFrameNavigation,
  isAllowedIpcSender,
  isAllowedNavigation,
} from '../dist/main/navigation.js'
import {
  MANAGER_CENTER_TABS,
  embeddedManagerUrl,
  isManagerCenterTab,
} from '../dist/core/manager-url.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

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

// 中心 UI 跑在 shell 的子帧里（Harness 侧边栏打开 /manager.html?embedded=1），
// 若 IPC 只认壳层主帧，中心的读/写全部会被拒——这里锁住两条边界。
test('IPC 接受壳层主帧与内嵌管理中心子帧', () => {
  const shell = 'http://127.0.0.1:4000/index.html'
  assert.equal(isAllowedIpcSender(shell, true, shell), true)
  for (const tab of ['plugin', 'mcp', 'skills', 'updates', 'feedback']) {
    assert.equal(isAllowedIpcSender(`http://127.0.0.1:4000/manager.html?embedded=1&tab=${tab}`, false, shell), true, tab)
  }
})

test('IPC 拒绝主帧偏离壳层，以及非中心子帧（Harness 源 / 外部页 / 畸形 URL）', () => {
  const shell = 'http://127.0.0.1:4000/index.html'
  // 主帧必须精确等于壳层地址
  assert.equal(isAllowedIpcSender('http://127.0.0.1:4000/manager.html?embedded=1&tab=plugin', true, shell), false)
  assert.equal(isAllowedIpcSender(`${shell}?unexpected=1`, true, shell), false)
  // Harness 源即使是合法子帧也不得直接调用 IPC
  assert.equal(isAllowedIpcSender(harnessUrl, false, shell), false)
  assert.equal(isAllowedIpcSender(`${harnessUrl}/settings`, false, shell), false)
  // 外部页与畸形/放宽后的 manager 地址一律拒绝
  assert.equal(isAllowedIpcSender('https://evil.example/', false, shell), false)
  assert.equal(isAllowedIpcSender('http://127.0.0.1.evil.example:4000/manager.html?embedded=1&tab=plugin', false, shell), false)
  assert.equal(isAllowedIpcSender('http://127.0.0.1:4001/manager.html?embedded=1&tab=plugin', false, shell), false)
  assert.equal(isAllowedIpcSender('http://127.0.0.1:4000/manager.html?tab=plugin', false, shell), false)
  assert.equal(isAllowedIpcSender('http://127.0.0.1:4000/manager.html?embedded=0&tab=plugin', false, shell), false)
  assert.equal(isAllowedIpcSender('http://127.0.0.1:4000/manager.html?embedded=1&tab=account', false, shell), false)
  assert.equal(isAllowedIpcSender('http://127.0.0.1:4000/manager.html?embedded=1&tab=plugin&extra=1', false, shell), false)
  assert.equal(isAllowedIpcSender('http://owner@127.0.0.1:4000/manager.html?embedded=1&tab=plugin', false, shell), false)
  assert.equal(isAllowedIpcSender('about:blank', false, shell), false)
  assert.equal(isAllowedIpcSender('not a URL', false, shell), false)
})

// 中心地址有三处消费者（渲染层握手 / IPC 来源校验 / 冒烟），但渲染层是独立 bundle
// （tsconfig.renderer.json 的 rootDir 限死 src/renderer），无法 import core。
// 这里锁住「渲染层内联拼法 == core 的 embeddedManagerUrl」，任一处漂移都会红。
test('渲染层内联的中心地址与 core 单一来源保持一致', () => {
  const renderer = readFileSync(join(root, 'src/renderer/renderer.ts'), 'utf8')
  const handshake = renderer.slice(
    renderer.indexOf("dsh-desktop-hub/manager-url-request"),
    renderer.indexOf('dsh-desktop-hub/manager-url\''),
  )
  assert.match(handshake, /new URL\('\/manager\.html', window\.location\.origin\)/, '渲染层必须从壳层 origin 拼 /manager.html')
  assert.match(handshake, /searchParams\.set\('embedded', '1'\)/, '渲染层必须标记 embedded=1')
  assert.match(handshake, /searchParams\.set\('tab', 'plugin'\)/, '渲染层必须指定默认 tab=plugin')

  // 同一份拼法产出的地址必须与 core 逐字相同
  assert.equal(
    embeddedManagerUrl('http://127.0.0.1:4000/index.html'),
    new URL('/manager.html', 'http://127.0.0.1:4000/index.html').href.replace('/manager.html', '/manager.html?embedded=1&tab=plugin'),
  )
  for (const tab of MANAGER_CENTER_TABS) {
    assert.equal(embeddedManagerUrl('http://127.0.0.1:4000/index.html', tab), `http://127.0.0.1:4000/manager.html?embedded=1&tab=${tab}`)
  }
})

test('中心 tab 白名单只认五个工作区，且中心地址只接受白名单内的 tab', () => {
  assert.deepEqual([...MANAGER_CENTER_TABS], ['plugin', 'mcp', 'skills', 'updates', 'feedback'])
  for (const tab of MANAGER_CENTER_TABS) assert.equal(isManagerCenterTab(tab), true, tab)
  for (const tab of ['account', 'harness', '', null, undefined, 'PLUGIN']) assert.equal(isManagerCenterTab(tab), false, String(tab))

  const shell = 'http://127.0.0.1:4000/index.html'
  for (const tab of MANAGER_CENTER_TABS) {
    assert.equal(isAllowedFrameNavigation(embeddedManagerUrl(shell, tab), false, shell, harnessUrl), true, tab)
    assert.equal(isAllowedIpcSender(embeddedManagerUrl(shell, tab), false, shell), true, tab)
  }
  assert.equal(isAllowedFrameNavigation(embeddedManagerUrl(shell).replace('tab=plugin', 'tab=account'), false, shell, harnessUrl), false)
  assert.equal(isAllowedIpcSender(embeddedManagerUrl(shell).replace('tab=plugin', 'tab=account'), false, shell), false)
})
