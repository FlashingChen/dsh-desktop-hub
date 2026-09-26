import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const main = readFileSync(join(root, 'src', 'main', 'main.ts'), 'utf8')

test('主进程启动链统一捕获 fatal，并经正常退出事件保留非零状态', () => {
  const handler = main.slice(main.indexOf('function handleStartupFatal'), main.indexOf('void app.whenReady()'))
  const startup = main.slice(main.indexOf('void app.whenReady()'), main.indexOf('function releaseExitResources'))

  assert.match(startup, /\.catch\(handleStartupFatal\)/, 'whenReady 启动链必须捕获同步异常和异步 rejection')
  assert.match(handler, /startup: fatal/, 'fatal handler 必须写入明确的启动失败日志')
  assert.match(handler, /process\.exitCode = 1/, '产品与冒烟启动失败都必须设置非零退出状态')
  assert.match(handler, /app\.quit\(\)/, '启动失败必须进入 before-quit/will-quit 清理链')
  assert.doesNotMatch(handler, /app\.exit\(/, 'fatal handler 不得直接绕过 Harness 清理')
})

test('Harness 冒烟启动失败也交给统一 fatal 清理链', () => {
  const startup = main.slice(main.indexOf('void app.whenReady()'), main.indexOf('function releaseExitResources'))
  const harnessSmoke = startup.slice(startup.indexOf('if (HARNESS_SMOKE)'), startup.indexOf('// 默认产品行为'))
  const willQuit = main.slice(main.indexOf("app.on('will-quit'"))

  assert.match(harnessSmoke, /await startHarnessAndWatch\(\)/, 'Harness 冒烟必须等待启动结果')
  assert.doesNotMatch(harnessSmoke, /app\.exit\(/, 'Harness 冒烟启动异常不得直接退出')
  assert.doesNotMatch(harnessSmoke, /catch\s*\(/, 'Harness 冒烟启动异常应传播到统一 fatal handler')
  assert.match(willQuit, /hasBackgroundWorkForExit\(\)/, '退出链必须覆盖 Harness、插件与 profile 写操作')
  assert.match(willQuit, /stopBackgroundWorkForExit\(\)/, 'will-quit 必须等待统一后台清理')
  assert.match(willQuit, /app\.exit\(currentExitCode\(\)\)/, '清理完成后必须保留 fatal 非零退出状态')
})
