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

function fakeProcess(done) {
  return {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    done,
    cancel() {},
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
