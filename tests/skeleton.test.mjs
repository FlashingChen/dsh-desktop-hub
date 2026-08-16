// M0 骨架契约测试：守卫工程结构不被破坏
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('骨架文件齐全', () => {
  for (const f of [
    'src/main/main.ts',
    'src/preload/preload.ts',
    'src/renderer/index.html',
    'src/renderer/renderer.ts',
  ]) {
    assert.ok(existsSync(join(root, f)), `缺少 ${f}`)
  }
})

test('package.json 提供全部脚本与 devDependencies', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  for (const s of ['typecheck', 'test', 'build', 'start', 'verify']) {
    assert.equal(typeof pkg.scripts?.[s], 'string', `缺少脚本 ${s}`)
  }
  for (const d of ['electron', 'typescript', '@types/node']) {
    assert.ok(pkg.devDependencies?.[d], `缺少 devDependency ${d}`)
  }
})

test('渲染层包含四个系统 Tab（Harness/Plugin/MCP/Skills）', () => {
  const html = readFileSync(join(root, 'src/renderer/index.html'), 'utf8')
  for (const tab of ['harness', 'plugin', 'mcp', 'skills']) {
    assert.ok(html.includes(`data-tab="${tab}"`), `缺少 tab ${tab}`)
    assert.ok(html.includes(`id="panel-${tab}"`), `缺少面板 ${tab}`)
  }
})

test('主进程使用安全默认（contextIsolation + sandbox）', () => {
  const main = readFileSync(join(root, 'src/main/main.ts'), 'utf8')
  assert.ok(main.includes('contextIsolation: true'), 'contextIsolation 未开启')
  assert.ok(main.includes('sandbox: true'), 'sandbox 未开启')
  assert.ok(main.includes('nodeIntegration: false'), 'nodeIntegration 未关闭')
})

test('tsconfig 开启严格模式', () => {
  const ts = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'))
  assert.equal(ts.compilerOptions.strict, true)
})

test('package.json 已重命名为 dsh-desktop-hub 并锁定 Electron 43.4.0', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-desktop-hub')
  assert.equal(pkg.productName, 'DSH Desktop Hub')
  assert.equal(pkg.devDependencies?.electron, '43.4.0', 'Electron 必须锁定到审计给出的修复版本')
  assert.ok(!pkg.devDependencies.electron.includes('^'), 'electron 不得使用 semver range')
})

test('preload channel 与 src/core/ipc.ts 契约逐字符一致', () => {
  const ipcSrc = readFileSync(join(root, 'src/core/ipc.ts'), 'utf8')
  const preloadSrc = readFileSync(join(root, 'src/preload/preload.ts'), 'utf8')
  const ipcValues = [...ipcSrc.matchAll(/^  (\w+): '([^']+)',?$/gm)].map((m) => [m[1], m[2]])
  const preloadValues = [...preloadSrc.matchAll(/^ {2,4}(\w+): '([^']+)',?$/gm)].map((m) => [m[1], m[2]])
  const ipcMap = new Map(ipcValues)
  const preloadMap = new Map(preloadValues)
  assert.ok(ipcValues.length >= 20, `IPC 契约应有完整 channel 集，实际 ${ipcValues.length}`)
  for (const [key, value] of ipcValues) {
    assert.equal(preloadMap.get(key), value, `channel ${key} 在 preload 中不一致`)
  }
  for (const [key] of preloadValues) {
    assert.ok(ipcMap.has(key), `preload 存在契约外的 channel ${key}`)
  }
})

test('主进程具备窗口安全边界与单实例锁', () => {
  const main = readFileSync(join(root, 'src/main/main.ts'), 'utf8')
  assert.ok(main.includes('setWindowOpenHandler'), '缺少 popup 拦截')
  assert.ok(main.includes('will-navigate'), '缺少导航限制')
  assert.ok(main.includes('setPermissionRequestHandler'), '缺少权限请求拦截')
  assert.ok(main.includes('requestSingleInstanceLock'), '缺少单实例锁')
  assert.ok(main.includes('assertRendererSender'), '缺少 IPC sender 校验')
})

test('渲染层 skills 表格使用 DOM API（textContent）而非 innerHTML 拼接', () => {
  const renderer = readFileSync(join(root, 'src/renderer/renderer.ts'), 'utf8')
  assert.ok(renderer.includes('tdName.textContent = s.name'), 'skill 名称必须经 textContent 渲染')
  assert.ok(renderer.includes('tdDesc.textContent'), 'skill 描述必须经 textContent 渲染')
  const skillsBlock = renderer.slice(renderer.indexOf('async function refreshSkills'), renderer.indexOf('async function toggleSkill'))
  assert.ok(!skillsBlock.includes('innerHTML'), 'skills 渲染不得使用 innerHTML')
})
