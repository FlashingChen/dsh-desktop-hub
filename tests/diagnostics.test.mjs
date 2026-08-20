import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const diagnostics = await import(pathToFileURL(join(root, 'dist', 'core', 'diagnostics.js')).href)
const feedback = await import(pathToFileURL(join(root, 'dist', 'core', 'feedback.js')).href)

const snapshot = {
  formatVersion: 1,
  generatedAt: '2026-01-02T03:04:05.000Z',
  appVersion: '0.1.0',
  packaged: true,
  profile: 'web',
  platform: 'win32',
  osRelease: '10.0.26100',
  arch: 'x64',
  electronVersion: '43.4.0',
  chromeVersion: '134.0.0.0',
  nodeVersion: '24.10.0',
  dshVersion: '0.1.0-rc.6',
  pnpmVersion: '11.22.0',
  harnessState: 'ready',
  harnessExitCode: null,
}

test('诊断格式只输出低敏白名单字段', () => {
  const text = diagnostics.formatDiagnostics(snapshot)
  assert.match(text, /DSH Desktop Hub/)
  assert.match(text, /Electron/)
  assert.match(text, /Harness state/)
  assert.doesNotMatch(text, /home|secret|token|password|api[_ -]?key|127\.0\.0\.1/i)
})

test('诊断值中的换行和表格分隔符不会破坏 Markdown 表格', () => {
  const text = diagnostics.formatDiagnostics({ ...snapshot, osRelease: 'line1|line2\nline3' })
  assert.match(text, /line1\\\|line2 line3/)
  assert.doesNotMatch(text, /line1\\\|line2\nline3/)
})

test('匿名反馈会丢弃署名，署名反馈必须有署名', () => {
  const anonymous = feedback.normalizeFeedbackInput({
    mode: 'anonymous', category: 'bug', title: '标题', body: '内容', signature: '不应发送',
  })
  assert.equal(anonymous.ok, true)
  assert.equal(anonymous.input.signature, null)

  const signed = feedback.normalizeFeedbackInput({ mode: 'signed', category: 'bug', title: '标题', body: '内容' })
  assert.equal(signed.ok, false)
  assert.match(signed.error, /署名/)
})

test('反馈输入有明确长度上限并规范换行', () => {
  const result = feedback.normalizeFeedbackInput({
    mode: 'anonymous',
    category: 'feature',
    title: ' 标题\r\n',
    body: '正文\r\n第二行 ',
  })
  assert.equal(result.ok, true)
  assert.equal(result.input.title, '标题')
  assert.equal(result.input.body, '正文\n第二行')

  const tooLong = feedback.normalizeFeedbackInput({
    mode: 'anonymous', category: 'bug', title: '标题', body: 'x'.repeat(feedback.FEEDBACK_BODY_MAX + 1),
  })
  assert.equal(tooLong.ok, false)
})

test('反馈客户端使用幂等键并接受 queued 响应', async () => {
  let calls = 0
  let receivedKey = ''
  const payload = feedback.toFeedbackPayload(
    { mode: 'anonymous', category: 'bug', title: '标题', body: '正文', signature: null, diagnostics: null },
    { appVersion: '0.1.0', platform: 'darwin', arch: 'arm64', profile: 'web' },
  )
  const client = await import(pathToFileURL(join(root, 'dist', 'core', 'feedback-client.js')).href)
  const result = await client.submitFeedback(payload, {
    endpoint: 'http://127.0.0.1:8787/v1/feedback',
    idempotencyKey: '00000000-0000-4000-8000-000000000001',
    fetchImpl: async (_url, init) => {
      calls += 1
      receivedKey = init.headers['Idempotency-Key']
      return new Response(JSON.stringify({ ok: true, status: 'queued', receiptId: 'fb_test' }), { status: 202 })
    },
  })
  assert.deepEqual(result, { ok: true, status: 'queued', receiptId: 'fb_test' })
  assert.equal(calls, 1)
  assert.equal(receivedKey, '00000000-0000-4000-8000-000000000001')
})

test('反馈客户端拒绝非法 JSON 响应且不重试', async () => {
  const client = await import(pathToFileURL(join(root, 'dist', 'core', 'feedback-client.js')).href)
  const payload = { schemaVersion: 1, mode: 'anonymous', category: 'bug', title: 't', body: 'b', signature: null, diagnostics: null, client: { appVersion: 'x', platform: 'x', arch: 'x', profile: 'web' } }
  let calls = 0
  const result = await client.submitFeedback(payload, {
    endpoint: 'http://127.0.0.1:8787/v1/feedback',
    fetchImpl: async () => {
      calls += 1
      return new Response('null', { status: 200 })
    },
  })
  assert.equal(result.code, 'invalid_response')
  assert.equal(calls, 1)
})

test('反馈客户端拒绝未配置或非安全 endpoint', async () => {
  const client = await import(pathToFileURL(join(root, 'dist', 'core', 'feedback-client.js')).href)
  const payload = { schemaVersion: 1, mode: 'anonymous', category: 'bug', title: 't', body: 'b', signature: null, diagnostics: null, client: { appVersion: 'x', platform: 'x', arch: 'x', profile: 'web' } }
  assert.equal((await client.submitFeedback(payload, { endpoint: '' })).code, 'unconfigured')
  assert.equal((await client.submitFeedback(payload, { endpoint: 'http://example.com/v1/feedback' })).code, 'unconfigured')
})
