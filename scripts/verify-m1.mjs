// M1 实机验证：真实启动 dsh web → HTTP 200 → 优雅停止 → 无孤儿进程
import { startHarness, findDsh } from '../dist/core/harness.js'

const fail = (msg) => {
  console.error(`M1 FAIL: ${msg}`)
  process.exit(1)
}
const ok = (msg) => console.log(`PASS  ${msg}`)

const dsh = findDsh()
if (!dsh) fail('未找到 dsh')

let handle
try {
  handle = await startHarness({ profile: 'web', readyTimeoutMs: 120_000 })
  ok(`dsh web 启动并就绪: ${handle.url} (pid=${handle.proc.pid})`)
} catch (err) {
  fail(`启动失败: ${String(err)}`)
}

try {
  const res = await fetch(handle.url)
  if (!res.ok) fail(`HTTP ${res.status}`)
  const body = await res.text()
  if (body.length < 100) fail(`页面过短 (${body.length}B)`)
  ok(`Web UI 可访问: HTTP ${res.status}, ${body.length}B`)
} catch (err) {
  fail(`访问失败: ${String(err)}`)
}

await handle.stop()
await new Promise((r) => setTimeout(r, 500))

// 孤儿进程检查：同 profile 不应再有存活 dsh web（组内 pid 已随组终止）
try {
  const res = await fetch(handle.url)
  fail(`停止后端口仍可访问 (${res.status})`)
} catch {
  ok('停止后端口已关闭')
}

console.log('\nM1 VERIFY OK')
process.exit(0)
