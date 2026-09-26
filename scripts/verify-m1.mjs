// M1 实机验证：真实启动 dsh web → HTTP 200 → 优雅停止 → 无孤儿进程
import { pathToFileURL } from 'node:url'
import { startHarness, resolveDshExec } from '../dist/core/harness.js'
import { readResponseText } from '../dist/core/response-body.js'

const HARNESS_READY_TIMEOUT_MS = 120_000
const HTTP_REQUEST_TIMEOUT_MS = 10_000
const PORT_CLOSED_TIMEOUT_MS = 3_000
const MAX_WEB_UI_BYTES = 1024 * 1024
const MIN_WEB_UI_LENGTH = 100

function errorDetail(error) {
  return error instanceof Error ? error.message : String(error)
}

function isTimeoutError(error) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

async function cancelBody(response) {
  try {
    await response.body?.cancel()
  } catch {
    /* 验证结果仍以 HTTP 断言为准；body 取消错误已收敛。 */
  }
}

export async function runM1Verification({
  resolveExec = resolveDshExec,
  start = startHarness,
  fetchImpl = fetch,
  logger = console,
  timeoutSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs),
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  let exec
  try {
    exec = resolveExec()
  } catch (error) {
    logger.error(`M1 FAIL: dsh 运行时解析失败: ${errorDetail(error)}`)
    return 1
  }
  if (!exec) {
    logger.error('M1 FAIL: 未找到 dsh 可执行文件（无 bundled runtime，PATH 中也没有 dsh）')
    return 1
  }

  let handle
  try {
    handle = await start({ profile: 'web', readyTimeoutMs: HARNESS_READY_TIMEOUT_MS })
  } catch (error) {
    logger.error(`M1 FAIL: 启动失败: ${errorDetail(error)}`)
    return 1
  }

  let assertionFailure = null
  let cleanupFailure = null
  try {
    logger.log(`PASS  dsh web 启动并就绪: ${handle.url} (pid=${handle.proc.pid})`)
    const response = await fetchImpl(handle.url, { signal: timeoutSignal(HTTP_REQUEST_TIMEOUT_MS) })
    if (!response.ok) {
      await cancelBody(response)
      throw new Error(`HTTP ${response.status}`)
    }
    const body = await readResponseText(
      response,
      MAX_WEB_UI_BYTES,
      `Web UI 响应超过 ${MAX_WEB_UI_BYTES} 字节上限`,
    )
    if (body.length < MIN_WEB_UI_LENGTH) throw new Error(`页面过短 (${body.length}B)`)
    logger.log(`PASS  Web UI 可访问: HTTP ${response.status}, ${body.length}B`)
  } catch (error) {
    assertionFailure = isTimeoutError(error)
      ? `访问超时 (${HTTP_REQUEST_TIMEOUT_MS}ms)`
      : `访问失败: ${errorDetail(error)}`
  } finally {
    try {
      await handle.stop()
    } catch (error) {
      cleanupFailure = `Harness 停止失败: ${errorDetail(error)}`
    }
  }

  if (assertionFailure || cleanupFailure) {
    logger.error(`M1 FAIL: ${[assertionFailure, cleanupFailure].filter(Boolean).join('；')}`)
    return 1
  }

  await wait(500)
  try {
    const response = await fetchImpl(handle.url, { signal: timeoutSignal(PORT_CLOSED_TIMEOUT_MS) })
    await cancelBody(response)
    logger.error(`M1 FAIL: 停止后端口仍可访问 (${response.status})`)
    return 1
  } catch (error) {
    if (isTimeoutError(error)) {
      logger.error(`M1 FAIL: 停止后端口关闭检查超时 (${PORT_CLOSED_TIMEOUT_MS}ms)`)
      return 1
    }
    logger.log('PASS  停止后端口已关闭')
  }

  logger.log('\nM1 VERIFY OK')
  return 0
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await runM1Verification()
}
