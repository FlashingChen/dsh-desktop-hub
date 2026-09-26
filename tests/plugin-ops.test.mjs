// Issue #8 回归测试：插件 IPC 的「启动」必须与「完成」分离。
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { PluginOpRunner } = await import(pathToFileURL(join(root, 'dist', 'core', 'plugin-ops.js')).href)

function deferred() {
  let resolve
  const promise = new Promise((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function fakeProcess(done, cancel = () => {}) {
  return {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    done,
    cancel,
  }
}

test('插件操作先返回 token，完成事件稍后到达且可查询终态', async () => {
  const processDone = deferred()
  const output = []
  const completed = []
  const runner = new PluginOpRunner({
    nextToken: () => 'op-test-1',
    schedule: (task) => task(),
    onChunk: (_token, text) => output.push(text),
    onDone: (done) => completed.push(done),
  })

  const started = runner.start({
    profile: 'web',
    action: 'remove',
    args: ['demo-plugin'],
    run: () => fakeProcess(processDone.promise),
  })

  assert.equal(started.ok, true)
  assert.equal(started.token, 'op-test-1')
  assert.equal(completed.length, 0, 'start 返回时子进程尚未完成，不能同步伪造完成')
  assert.equal(runner.status(started.token).state, 'running')

  processDone.resolve({ exitCode: 0, signal: null })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(completed.length, 1)
  assert.equal(completed[0].token, 'op-test-1')
  assert.equal(completed[0].exitCode, 0)
  assert.equal(runner.status(started.token).state, 'done')
  assert.ok(output.some((text) => text.includes('dsh plugin') && text.includes('remove')))
})

test('完成推送失败时仍保留终态，查询不会永久停在 running', async () => {
  const processDone = deferred()
  const runner = new PluginOpRunner({
    nextToken: () => 'op-test-lost-event',
    schedule: (task) => task(),
    onChunk: () => {},
    onDone: () => {
      throw new Error('renderer window disappeared')
    },
  })

  const started = runner.start({
    profile: 'web',
    action: 'update',
    args: [],
    run: () => fakeProcess(processDone.promise),
  })
  processDone.resolve({ exitCode: 3, signal: null })
  await new Promise((resolve) => setImmediate(resolve))

  const status = runner.status(started.token)
  assert.equal(status.state, 'done')
  assert.equal(status.done.exitCode, 3)
})

test('重复 cancel 在停止请求成功后保持幂等，仍等待真实 done', async () => {
  const processDone = deferred()
  let cancels = 0
  const runner = new PluginOpRunner({
    nextToken: () => 'op-idempotent-cancel',
    schedule: (task) => task(),
    onChunk: () => {},
    onDone: () => {},
  })
  const started = runner.start({
    profile: 'web',
    action: 'update',
    args: [],
    run: () => fakeProcess(processDone.promise, async () => { cancels += 1 }),
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runner.cancel(started.token), true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runner.cancel(started.token), true)
  assert.equal(cancels, 1)
  assert.equal(runner.status(started.token).state, 'running')
  processDone.resolve({ exitCode: null, signal: 'SIGTERM' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runner.status(started.token).state, 'done')
})

test('shutdown 取消运行中与排队操作，并等待所有 token 登记终态', async () => {
  let chain = Promise.resolve()
  const schedule = (task) => {
    const next = chain.then(task)
    chain = next.catch(() => {})
    return next
  }
  const runningDone = deferred()
  let runningCancels = 0
  let queuedRuns = 0
  let tokenSeq = 0
  const completed = []
  const runner = new PluginOpRunner({
    nextToken: () => `op-shutdown-${++tokenSeq}`,
    schedule,
    onChunk: () => {},
    onDone: (done) => completed.push(done),
  })

  const running = runner.start({
    profile: 'web',
    action: 'add',
    args: ['running'],
    run: () => fakeProcess(runningDone.promise, () => {
      runningCancels += 1
    }),
  })
  await new Promise((resolve) => setImmediate(resolve))
  const queued = runner.start({
    profile: 'web',
    action: 'remove',
    args: ['queued'],
    run: () => {
      queuedRuns += 1
      return fakeProcess(Promise.resolve({ exitCode: 0, signal: null }))
    },
  })

  let shutdownSettled = false
  const shutdown = runner.shutdown().then(() => {
    shutdownSettled = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runningCancels, 1, 'shutdown 必须立即请求取消运行中进程')
  assert.equal(shutdownSettled, false, '进程 done 未结算前 shutdown 不得提前 resolve')
  runningDone.resolve({ exitCode: null, signal: 'SIGTERM' })
  await shutdown
  await chain

  assert.equal(runningCancels, 1, '运行中进程必须取消且只能取消一次')
  assert.equal(queuedRuns, 0, '排队操作在 shutdown 后不得 spawn')
  assert.equal(runner.hasActiveOperations(), false)
  assert.equal(runner.status(running.token).state, 'done')
  const queuedStatus = runner.status(queued.token)
  assert.equal(queuedStatus.state, 'done')
  assert.match(queuedStatus.done.output, /尚未启动/)
  assert.deepEqual(new Set(completed.map((done) => done.token)), new Set([running.token, queued.token]))
})

test('shutdown 开始后拒绝新 start 并保持结构化失败', async () => {
  let nextTokenCalls = 0
  let runCalls = 0
  const runner = new PluginOpRunner({
    nextToken: () => {
      nextTokenCalls += 1
      return 'should-not-exist'
    },
    schedule: (task) => task(),
    onChunk: () => {},
    onDone: () => {},
  })

  await runner.shutdown()
  const started = runner.start({
    profile: 'web',
    action: 'update',
    args: [],
    run: () => {
      runCalls += 1
      return fakeProcess(Promise.resolve({ exitCode: 0, signal: null }))
    },
  })

  assert.deepEqual(started, { ok: false, error: '应用正在退出，无法启动新的插件操作' })
  assert.equal(nextTokenCalls, 0)
  assert.equal(runCalls, 0)
})

test('无 active 时 shutdown 立即完成且可幂等等待', async () => {
  const runner = new PluginOpRunner({
    nextToken: () => 'unused',
    schedule: (task) => task(),
    onChunk: () => {},
    onDone: () => {},
  })

  const first = runner.shutdown()
  const second = runner.shutdown()
  assert.equal(first, second, '重复 shutdown 必须复用同一个 drain Promise')
  await first
  assert.equal(runner.hasActiveOperations(), false)
  assert.equal(runner.isShuttingDown(), true)
})

test('停止机制失败且进程不退出时 shutdown 有界 reject，不伪造 token 终态', async () => {
  const processDone = deferred()
  const stopFailure = new Error('taskkill denied')
  const runner = new PluginOpRunner({
    nextToken: () => 'op-stuck-stop',
    schedule: (task) => task(),
    onChunk: () => {},
    onDone: () => assert.fail('存活进程不能收到伪造终态'),
    shutdownTimeoutMs: 30,
  })
  const started = runner.start({
    profile: 'web',
    action: 'add',
    args: ['stuck'],
    run: () => fakeProcess(processDone.promise, () => Promise.reject(stopFailure)),
  })
  await new Promise((resolve) => setImmediate(resolve))

  await assert.rejects(runner.shutdown(), (error) => {
    assert.ok(error instanceof AggregateError)
    assert.match(error.message, /插件操作退出收口失败/)
    assert.ok(error.errors.includes(stopFailure), 'shutdown 必须保留真实停止错误')
    assert.ok(error.errors.some((item) => item instanceof Error && /终态超时/.test(item.message)))
    return true
  })
  assert.equal(runner.status(started.token).state, 'running', '停止失败后 token 仍应如实保持 running')

  processDone.resolve({ exitCode: 7, signal: null })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runner.status(started.token).state, 'done')
})
