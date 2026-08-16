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
