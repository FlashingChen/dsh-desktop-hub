import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { runM1Verification } = await import(pathToFileURL(join(root, 'scripts', 'verify-m1.mjs')).href)

function timeoutError(message = 'timed out') {
  return Object.assign(new Error(message), { name: 'TimeoutError' })
}

async function runScenario({ initial, stopError = null, postStop = async () => { throw new Error('ECONNREFUSED') } }) {
  let stopCalls = 0
  let startCalls = 0
  let fetchCalls = 0
  const timeoutValues = []
  const errors = []
  const logs = []
  const code = await runM1Verification({
    resolveExec: () => ({ exec: '/fake/dsh' }),
    start: async (options) => {
      startCalls += 1
      assert.deepEqual(options, { profile: 'web', readyTimeoutMs: 120_000 })
      return {
        url: 'http://127.0.0.1:43123',
        proc: { pid: 42 },
        stop: async () => {
          stopCalls += 1
          if (stopError) throw stopError
        },
      }
    },
    fetchImpl: async (...args) => {
      fetchCalls += 1
      return fetchCalls === 1 ? initial(...args) : postStop(...args)
    },
    timeoutSignal: (timeoutMs) => {
      timeoutValues.push(timeoutMs)
      return new AbortController().signal
    },
    wait: async () => {},
    logger: { log: (message) => logs.push(message), error: (message) => errors.push(message) },
  })
  return { code, stopCalls, startCalls, fetchCalls, timeoutValues, errors, logs }
}

test('HTTP 500、页面过短、fetch reject/timeout 都停止 Harness 且非零返回', async () => {
  const scenarios = [
    { name: 'HTTP 500', initial: async () => new Response('gateway', { status: 500 }), diagnosis: /HTTP 500/ },
    { name: '过短', initial: async () => new Response('short', { status: 200 }), diagnosis: /页面过短/ },
    { name: 'fetch reject', initial: async () => { throw new Error('connection reset') }, diagnosis: /访问失败: connection reset/ },
    { name: 'fetch timeout', initial: async () => { throw timeoutError() }, diagnosis: /访问超时 \(10000ms\)/ },
  ]
  for (const scenario of scenarios) {
    const result = await runScenario(scenario)
    assert.equal(result.code, 1, scenario.name)
    assert.equal(result.startCalls, 1, scenario.name)
    assert.equal(result.stopCalls, 1, scenario.name)
    assert.equal(result.fetchCalls, 1, scenario.name)
    assert.deepEqual(result.timeoutValues, [10_000], scenario.name)
    assert.match(result.errors[0], scenario.diagnosis, scenario.name)
  }
})

test('超大 Web UI body 有界失败、取消读取并停止 Harness', async () => {
  let pulls = 0
  let cancelled = false
  const result = await runScenario({
    initial: async () => new Response(new ReadableStream({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(64 * 1024))
        if (pulls === 100) controller.close()
      },
      cancel() {
        cancelled = true
      },
    }), { status: 200 }),
  })
  assert.equal(result.code, 1)
  assert.equal(result.stopCalls, 1)
  assert.equal(cancelled, true)
  assert.ok(pulls < 100, `不得读完超大 body，实际 pull ${pulls} 次`)
  assert.match(result.errors[0], /Web UI 响应超过 1048576 字节上限/)
})

test('成功路径也只 stop 一次，并对两次 HTTP 请求都设定超时', async () => {
  const result = await runScenario({
    initial: async () => new Response('x'.repeat(100), { status: 200 }),
  })
  assert.equal(result.code, 0)
  assert.equal(result.stopCalls, 1)
  assert.equal(result.fetchCalls, 2)
  assert.deepEqual(result.timeoutValues, [10_000, 3_000])
  assert.ok(result.logs.some((line) => line.includes('M1 VERIFY OK')))
})

test('stop 失败不掩盖原 HTTP 断言错误', async () => {
  const result = await runScenario({
    initial: async () => new Response('gateway', { status: 500 }),
    stopError: new Error('kill denied'),
  })
  assert.equal(result.code, 1)
  assert.equal(result.stopCalls, 1)
  assert.equal(result.fetchCalls, 1)
  assert.match(result.errors[0], /HTTP 500/)
  assert.match(result.errors[0], /Harness 停止失败: kill denied/)
})

test('无 runtime 直接失败且不启动 Harness', async () => {
  let startCalls = 0
  const errors = []
  const code = await runM1Verification({
    resolveExec: () => null,
    start: async () => {
      startCalls += 1
      throw new Error('不应启动')
    },
    logger: { log: () => {}, error: (message) => errors.push(message) },
  })
  assert.equal(code, 1)
  assert.equal(startCalls, 0)
  assert.match(errors[0], /^M1 FAIL: 未找到 dsh/)
})
