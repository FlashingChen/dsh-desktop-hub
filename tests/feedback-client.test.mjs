import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { submitFeedback } = await import(pathToFileURL(join(root, 'dist', 'core', 'feedback-client.js')).href)

const endpoint = 'http://127.0.0.1:8787/v1/feedback'
const payload = {
  schemaVersion: 1,
  mode: 'anonymous',
  category: 'bug',
  title: 'test',
  body: 'body',
  signature: null,
  diagnostics: null,
  client: { appVersion: 'test', platform: 'test', arch: 'test', profile: 'web' },
}

test('503 HTML/空 body 会重试并复用同一幂等键', async () => {
  for (const badBody of ['<html>bad gateway</html>', '']) {
    const keys = []
    let calls = 0
    const result = await submitFeedback(payload, {
      endpoint,
      maxAttempts: 2,
      waitBetweenAttemptsMs: 0,
      idempotencyKey: 'feedback-retry-key',
      fetchImpl: async (_url, init) => {
        calls += 1
        keys.push(init.headers['Idempotency-Key'])
        if (calls === 1) return new Response(badBody, { status: 503 })
        return new Response(JSON.stringify({ ok: true, status: 'accepted', receiptId: 'receipt-1' }), { status: 202 })
      },
    })
    assert.deepEqual(result, { ok: true, status: 'accepted', receiptId: 'receipt-1' })
    assert.equal(calls, 2)
    assert.deepEqual(keys, ['feedback-retry-key', 'feedback-retry-key'])
  }
})

test('非重试 HTTP 状态的坏 JSON 保持 invalid_response 且不重试', async () => {
  let calls = 0
  const result = await submitFeedback(payload, {
    endpoint,
    maxAttempts: 3,
    waitBetweenAttemptsMs: 0,
    fetchImpl: async () => {
      calls += 1
      return new Response('<html>bad request</html>', { status: 400 })
    },
  })
  assert.deepEqual(result, { ok: false, code: 'invalid_response', message: '反馈服务返回格式无效' })
  assert.equal(calls, 1)
})

test('超大响应有界失败、取消 body 且不重试非重试状态', async () => {
  let pulls = 0
  let cancelled = false
  let calls = 0
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1
      controller.enqueue(new Uint8Array(2_048))
      if (pulls === 100) controller.close()
    },
    cancel() {
      cancelled = true
    },
  })
  const result = await submitFeedback(payload, {
    endpoint,
    maxAttempts: 3,
    waitBetweenAttemptsMs: 0,
    fetchImpl: async () => {
      calls += 1
      return new Response(body, { status: 200 })
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid_response')
  assert.match(result.message, /响应超过 32768 字节上限/)
  assert.equal(calls, 1)
  assert.equal(cancelled, true)
  assert.ok(pulls < 100, `不得读完超大 body，实际 pull ${pulls} 次`)
})

test('200 响应的 body 读取异常保持 timeout/network 重试语义', async () => {
  for (const scenario of [
    { name: 'abort', error: Object.assign(new Error('body aborted'), { name: 'AbortError' }), code: 'timeout' },
    { name: 'timeout', error: Object.assign(new Error('request timed out'), { name: 'TimeoutError' }), code: 'timeout' },
    { name: 'network', error: new Error('connection reset'), code: 'network_error' },
  ]) {
    let calls = 0
    const keys = []
    const result = await submitFeedback(payload, {
      endpoint,
      maxAttempts: 2,
      waitBetweenAttemptsMs: 0,
      idempotencyKey: `body-${scenario.name}-key`,
      fetchImpl: async (_url, init) => {
        calls += 1
        keys.push(init.headers['Idempotency-Key'])
        return new Response(new ReadableStream({
          start(controller) {
            controller.error(scenario.error)
          },
        }), { status: 200 })
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, scenario.code)
    assert.equal(result.retryable, true)
    assert.equal(calls, 2)
    assert.deepEqual(keys, [`body-${scenario.name}-key`, `body-${scenario.name}-key`])
  }
})

test('fetch 直接拒绝 TimeoutError 也按 timeout 重试', async () => {
  let calls = 0
  const keys = []
  const result = await submitFeedback(payload, {
    endpoint,
    maxAttempts: 2,
    waitBetweenAttemptsMs: 0,
    idempotencyKey: 'fetch-timeout-key',
    fetchImpl: async (_url, init) => {
      calls += 1
      keys.push(init.headers['Idempotency-Key'])
      throw Object.assign(new Error('signal timed out'), { name: 'TimeoutError' })
    },
  })
  assert.deepEqual(result, { ok: false, code: 'timeout', message: '反馈服务响应超时', retryable: true })
  assert.equal(calls, 2)
  assert.deepEqual(keys, ['fetch-timeout-key', 'fetch-timeout-key'])
})
