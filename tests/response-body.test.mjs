import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { readResponseBytes, readResponseText } = await import(
  pathToFileURL(join(root, 'dist', 'core', 'response-body.js')).href
)

test('无 Content-Length 的分块响应超限时立即取消且不读取完整 body', async () => {
  let pulls = 0
  let cancelled = false
  const response = new Response(new ReadableStream({
    pull(controller) {
      pulls += 1
      controller.enqueue(new Uint8Array(4))
      if (pulls === 10) controller.close()
    },
    cancel() {
      cancelled = true
    },
  }))

  await assert.rejects(readResponseBytes(response, 5, 'body too large'), /body too large/)
  assert.equal(cancelled, true, '超限时必须 cancel reader')
  assert.ok(pulls < 10, `不得读完超限响应，实际 pull ${pulls} 次`)
})

test('文本上限按 UTF-8 字节而非 JavaScript 字符数计算', async () => {
  await assert.rejects(readResponseText(new Response('你好'), 5, 'utf8 too large'), /utf8 too large/)
  assert.equal(await readResponseText(new Response('你好'), 6, 'utf8 too large'), '你好')
})

test('正常分块响应可合并为 bytes 与 UTF-8 文本', async () => {
  const bytes = await readResponseBytes(new Response(new Uint8Array([0, 1, 2, 255])), 4, 'too large')
  assert.deepEqual([...bytes], [0, 1, 2, 255])
  assert.equal(await readResponseText(new Response('normal'), 6, 'too large'), 'normal')
})

test('Content-Length 超限会在读取 body 前快速拒绝并取消响应', async () => {
  let pulled = false
  let cancelled = false
  const response = new Response(new ReadableStream({
    pull(controller) {
      pulled = true
      controller.enqueue(new Uint8Array([1]))
    },
    cancel() {
      cancelled = true
    },
  }), { headers: { 'Content-Length': '100' } })

  await assert.rejects(readResponseBytes(response, 10, 'declared too large'), /declared too large/)
  await Promise.resolve()
  assert.equal(cancelled, true)
  assert.equal(pulled, false, 'Content-Length 快速拒绝不得读取 body')
})
