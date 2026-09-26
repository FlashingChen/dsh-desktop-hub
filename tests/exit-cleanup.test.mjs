import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { TrackedTaskRegistry } = await import('../dist/main/tracked-tasks.js')

const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8')

test('统一退出链先关闭插件 runner，再等待 mutation 与 Harness', () => {
  const cleanup = main.slice(main.indexOf('function stopBackgroundWorkForExit'), main.indexOf('function currentExitCode'))
  const pluginShutdown = cleanup.indexOf('await pluginOps.shutdown()')
  const mutationDrain = cleanup.indexOf("await waitForExitStage('profile 写队列收口', mutationChain")
  const skillImportDrain = cleanup.indexOf("await waitForExitStage('Skill 导入收口', skillImportTasks.drain()")
  const harnessStop = cleanup.indexOf("await waitForExitStage('Harness 清理', stopHarnessForExit()")

  assert.ok(pluginShutdown >= 0, '退出必须 shutdown plugin runner')
  assert.ok(mutationDrain > pluginShutdown, 'plugin 取消后才能等待 profile mutation 队列')
  assert.ok(skillImportDrain > mutationDrain, 'profile mutation 后必须等待独立 Skill 导入')
  assert.ok(harnessStop > skillImportDrain, '全部 mutation 收口后必须清理 Harness')
  assert.match(cleanup, /if \(backgroundStopPromise\) return backgroundStopPromise/, '重复退出事件必须复用同一清理 Promise')
  assert.match(cleanup, /new AggregateError/, '某类清理失败不得跳过其余后台清理')
  assert.match(cleanup, /MUTATION_EXIT_TIMEOUT_MS/, 'profile drain 必须有界')
  assert.match(cleanup, /SKILL_IMPORT_EXIT_TIMEOUT_MS/, 'Skill 导入 drain 必须有界')
  assert.match(cleanup, /HARNESS_EXIT_TIMEOUT_MS/, 'Harness 清理必须有界，失败后主进程仍可退出')
})

test('仅插件运行时两条系统退出路径也会阻止退出并等待清理', () => {
  const detector = main.slice(main.indexOf('function hasBackgroundWorkForExit'), main.indexOf('function stopBackgroundWorkForExit'))
  const queryEnd = main.slice(main.indexOf('function handleWindowsQuerySessionEnd'), main.indexOf('function handleWindowsSessionEnd'))
  const willQuit = main.slice(main.indexOf("app.on('will-quit'"))

  assert.match(detector, /pluginOps\.hasActiveOperations\(\)/, '退出条件必须包含仅 plugin active 的场景')
  for (const [label, source] of [['query-session-end', queryEnd], ['will-quit', willQuit]]) {
    assert.match(source, /hasBackgroundWorkForExit\(\)/, `${label} 必须检查全部后台工作`)
    assert.match(source, /preventDefault\(\)/, `${label} 必须阻止后台清理前退出`)
    assert.match(source, /stopBackgroundWorkForExit\(\)/, `${label} 必须等待统一后台清理`)
    assert.match(source, /app\.exit\(currentExitCode\(\)\)/, `${label} 清理后必须保留退出码`)
  }
})

test('退出开始后 profile 写队列与插件启动都拒绝新工作', () => {
  const mutations = main.slice(main.indexOf('let mutationChain'), main.indexOf('// ---- 插件操作'))
  const pluginStart = main.slice(main.indexOf('function startPluginOp'), main.indexOf('// ---- Skills 路径'))

  assert.match(mutations, /if \(mutationsShuttingDown\) return Promise\.reject/, '退出后不得接受新的 profile mutation')
  assert.match(mutations, /pendingMutations \+= 1/, '退出条件必须能识别已登记 mutation')
  assert.match(mutations, /pendingMutations -= 1/, 'mutation 结算后必须释放登记')
  assert.match(pluginStart, /pluginOps\.isShuttingDown\(\)/, '插件 IPC 必须在解析可执行文件前拒绝退出期 start')
})

test('独立 Skill 导入跟踪器在退出时拒绝新任务并等待在途任务', async () => {
  const registry = new TrackedTaskRegistry()
  let release
  const active = registry.start(() => new Promise((resolve) => { release = resolve }))
  assert.equal(registry.pendingCount(), 1)

  registry.beginShutdown()
  await assert.rejects(registry.start(async () => 'late'), /应用正在退出/)

  let drained = false
  const drain = registry.drain().then(() => { drained = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(drained, false, '在途导入未结算时 drain 不能假成功')
  release('done')
  assert.equal(await active, 'done')
  await drain
  assert.equal(drained, true)
  assert.equal(registry.pendingCount(), 0)
})

test('Skill 导入失败由 IPC caller 接收，退出 drain 仍只等待结算', async () => {
  const registry = new TrackedTaskRegistry()
  const failed = registry.start(async () => { throw new Error('download failed') })
  registry.beginShutdown()
  await Promise.all([
    assert.rejects(failed, /download failed/),
    assert.doesNotReject(registry.drain()),
  ])
  assert.equal(registry.pendingCount(), 0)

  const cleanup = main.slice(main.indexOf('function stopBackgroundWorkForExit'), main.indexOf('function currentExitCode'))
  assert.match(cleanup, /skillImportTasks\.beginShutdown\(\)/, '退出状态必须在异步 drain 之前同步生效')
  assert.match(main, /SKILL_IMPORT_EXIT_TIMEOUT_MS = 2_000/, '在途导入只争取明确的 2 秒退出窗口')
  const detector = main.slice(main.indexOf('function hasBackgroundWorkForExit'), main.indexOf('const MUTATION_EXIT_TIMEOUT_MS'))
  assert.match(detector, /skillImportTasks\.pendingCount\(\) > 0/, '仅有网络导入时也必须阻止立即退出')
})

test('Harness 停止失败保留句柄、尝试其余清理并向退出链聚合上抛', () => {
  const start = main.slice(main.indexOf('async function startHarnessAndWatch'), main.indexOf('function startHarnessBackground'))
  const stop = main.slice(main.indexOf('async function stopHarness()'), main.indexOf('/** 手动重启'))
  const detector = main.slice(main.indexOf('function hasBackgroundWorkForExit'), main.indexOf('const MUTATION_EXIT_TIMEOUT_MS'))

  assert.match(start, /err instanceof AggregateError && spawnedProc/, '启动清理失败必须识别 AggregateError')
  assert.match(start, /harnessCleanupRetries\.add\(spawnedProc\)/, '失败启动的 ChildProcess 必须跨世代保留')
  assert.match(stop, /const errors: unknown\[\] = \[\]/, '停止必须聚合多个清理错误')
  assert.match(stop, /for \(const proc of startingProcesses\)/, '所有失败启动句柄都必须重试')
  assert.match(stop, /if \(activeHarness\)/, '启动进程失败后仍必须尝试当前 Harness')
  assert.match(stop, /throw new AggregateError/, '任一真实停止失败必须向调用者上抛')
  assert.doesNotMatch(stop, /\/\* 已退出 \*\//, 'stopTree 已处理 ESRCH，不得吞掉其他停止失败')
  assert.doesNotMatch(stop, /finally \{\s*harness = null/, '停止失败不得丢失 active Harness 句柄')
  assert.match(detector, /harnessCleanupRetries\.size > 0/, '只有失败启动句柄时退出也必须进入清理链')
})
