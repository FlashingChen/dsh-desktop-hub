import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCaptureHome, removeCaptureHome } from '../scripts/capture-demo-home.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readScript = (name) => readFileSync(join(root, 'scripts', name), 'utf8')

test('图标生成脚本统一捕获顶层异步失败并非零退出', () => {
  const source = readScript('generate-icon.mjs')
  const handler = source.slice(source.indexOf('function handleGenerateIconFailure'), source.indexOf('async function runGenerateIcon'))

  assert.match(source, /void app\.whenReady\(\)\.then\(runGenerateIcon\)\.catch\(handleGenerateIconFailure\)/)
  assert.match(handler, /GENERATE ICON FAIL:/, '失败日志必须带脚本标签')
  assert.match(source, /error instanceof Error \? \(error\.stack \?\? error\.message\)/, '失败日志必须保留 stack')
  assert.match(handler, /win && !win\.isDestroyed\(\)/, '失败时必须尽力销毁隐藏窗口')
  assert.match(handler, /catch \(cleanupError\)/, '清理异常不得覆盖原始错误')
  assert.match(handler, /app\.exit\(1\)/, '失败必须明确非零退出')
  assert.doesNotMatch(source, /app\.whenReady\(\)\.then\(async/, '不得留下无尾部 catch 的 async whenReady 回调')
})

test('演示捕获脚本把依赖、准备和捕获纳入同一失败收口', () => {
  const source = readScript('capture-demo.mjs')
  const startup = source.slice(source.indexOf('async function startCapture'), source.indexOf('void app.whenReady()'))
  const finish = source.slice(source.indexOf('function finishCapture'), source.indexOf('async function startCapture'))

  assert.match(startup, /demoHome = createCaptureHome\(\)[\s\S]*process\.env\.DSH_HOME = demoHome[\s\S]*await loadDependencies\(\)[\s\S]*buildDemoHome\(\)[\s\S]*registerIpc\(\)[\s\S]*await runCapture\(\)/)
  assert.match(source, /void app\.whenReady\(\)\.then\(startCapture\)\.catch\(handleCaptureFailure\)/)
  assert.doesNotMatch(source, /^const .* = await import/m, '动态依赖加载不得逃逸顶层 catch')
  assert.match(finish, /CAPTURE FAIL:/, '失败日志必须带脚本标签')
  assert.match(finish, /await harness\?\.stop\(\)/, '完成时必须先等待 Harness 进程树停止')
  assert.match(finish, /win && !win\.isDestroyed\(\)/, '随后必须尽力销毁隐藏窗口')
  assert.match(finish, /if \(demoHome && harnessStopped && windowDestroyed\)[\s\S]*removeCaptureHome\(demoHome\)/, '仅在进程与窗口完成清理后删除本次临时根')
  assert.ok(finish.indexOf('await harness?.stop()') < finish.indexOf('win.destroy()'))
  assert.ok(finish.indexOf('win.destroy()') < finish.indexOf('removeCaptureHome(demoHome)'))
  assert.equal((finish.match(/catch \(cleanupError\)/g) ?? []).length, 3, '三类清理错误必须分别收敛')
  assert.match(finish, /app\.exit\(error \? 1 : 0\)/, '清理失败不得改变原始成功或失败退出码')
  assert.doesNotMatch(source, /\/tmp\/dsh-demo-capture|rmSync\(DEMO_HOME/, '不得使用或预删固定临时目录')
})

test('capture helper creates and removes only a unique temporary root', () => {
  const base = mkdtempSync(join(tmpdir(), 'capture-home-test-'))
  try {
    const homeA = createCaptureHome({ baseDir: base })
    const homeB = createCaptureHome({ baseDir: base })
    assert.notEqual(homeA, homeB)
    assert.match(homeA, /dsh-demo-capture-/)
    writeFileSync(join(homeA, 'marker'), 'owned')
    removeCaptureHome(homeA)
    assert.equal(existsSync(homeA), false)
    assert.equal(existsSync(homeB), true)
    assert.throws(() => removeCaptureHome(base), /拒绝清理/)
    assert.throws(
      () => removeCaptureHome(homeB, { remove: () => { throw new Error('cleanup denied') } }),
      /cleanup denied/,
    )
    assert.equal(existsSync(homeB), true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
