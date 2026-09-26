// Build-time download primitives. This file intentionally stays plain ESM JavaScript:
// bundle-runtime.mjs can run before any TypeScript build output exists.
import { link, open, rm } from 'node:fs/promises'

function errorOf(value) {
  return value instanceof Error ? value : new Error(String(value))
}

function contentLength(response) {
  const raw = response.headers?.get?.('content-length')?.trim()
  if (!raw || !/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : Number.POSITIVE_INFINITY
}

function cancelBody(body, reason) {
  try {
    void Promise.resolve(body?.cancel?.(reason)).catch(() => {})
  } catch {
    // Cancellation is best-effort. The primary size/network/timeout error wins.
  }
}

function normalizeTimeout(error, signal, label, timeoutMs) {
  if (!signal.aborted) return error
  const name = error && typeof error === 'object' ? error.name : undefined
  if (error !== signal.reason && name !== 'AbortError' && name !== 'TimeoutError') return error
  return new Error(`${label}下载超时（${timeoutMs}ms）`, { cause: errorOf(error) })
}

function awaitWithSignal(task, signal) {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const finish = (complete, value) => {
      signal.removeEventListener('abort', onAbort)
      complete(value)
    }
    const onAbort = () => finish(reject, signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve()
      .then(task)
      .then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      )
  })
}

/** Consume a Fetch Response body without ever buffering beyond maxBytes. */
export async function consumeBoundedResponse(response, options) {
  const { maxBytes, label, signal, onChunk } = options
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error(`无效响应上限: ${maxBytes}`)
  if (!response.body) throw new Error(`${label}没有响应 body`)
  const declared = contentLength(response)
  if (declared !== null && declared > maxBytes) {
    const error = new Error(`${label}超过大小上限 ${maxBytes} bytes（Content-Length: ${declared}）`)
    cancelBody(response.body, error)
    throw error
  }

  const reader = response.body.getReader()
  let rejectAbort
  const aborted = new Promise((_resolve, reject) => { rejectAbort = reject })
  const onAbort = () => {
    const reason = signal.reason instanceof Error ? signal.reason : new Error(`${label}下载已取消`)
    rejectAbort(reason)
    cancelBody(reader, reason)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()

  let total = 0
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted])
      if (signal.aborted) throw signal.reason
      if (done) return total
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
      total += chunk.byteLength
      if (total > maxBytes) {
        const error = new Error(`${label}超过大小上限 ${maxBytes} bytes`)
        cancelBody(reader, error)
        throw error
      }
      await Promise.race([Promise.resolve(onChunk(chunk)), aborted])
    }
  } catch (error) {
    cancelBody(reader, error)
    throw error
  } finally {
    signal.removeEventListener('abort', onAbort)
    try {
      reader.releaseLock()
    } catch {
      // A deliberately non-cooperative custom stream may retain a pending read;
      // timeout still returns to the caller and the abort rejection is observed.
    }
  }
}

function responseStatusError(response, label, statusError) {
  if (response.ok) return null
  return statusError?.(response) ?? new Error(`${label}下载失败: ${response.status}`)
}

/** Fetch a small UTF-8 build manifest with a timeout covering full body consumption. */
export async function fetchBoundedText(url, options) {
  const {
    maxBytes,
    timeoutMs,
    label,
    fetchFn = fetch,
    statusError,
  } = options
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const response = await awaitWithSignal(() => fetchFn(url, { signal }), signal)
    const statusFailure = responseStatusError(response, label, statusError)
    if (statusFailure) {
      cancelBody(response.body, statusFailure)
      throw statusFailure
    }
    const chunks = []
    let length = 0
    await consumeBoundedResponse(response, {
      maxBytes,
      label,
      signal,
      onChunk: (chunk) => {
        chunks.push(chunk)
        length += chunk.byteLength
      },
    })
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder().decode(bytes)
  } catch (error) {
    throw normalizeTimeout(error, signal, label, timeoutMs)
  }
}

/** Stream a response into one exact file path with byte and wall-clock bounds. */
export async function downloadBoundedFile(url, file, options) {
  const {
    maxBytes,
    timeoutMs,
    label,
    fetchFn = fetch,
    statusError,
  } = options
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const response = await awaitWithSignal(() => fetchFn(url, { signal }), signal)
    const statusFailure = responseStatusError(response, label, statusError)
    if (statusFailure) {
      cancelBody(response.body, statusFailure)
      throw statusFailure
    }
    let output
    try {
      // The transaction removes a stale part first; exclusive create then refuses
      // a symlink/file introduced in the race window instead of following it.
      output = await open(file, 'wx')
    } catch (error) {
      cancelBody(response.body, error)
      throw error
    }
    let position = 0
    let bodyFailure
    try {
      await consumeBoundedResponse(response, {
        maxBytes,
        label,
        signal,
        onChunk: async (chunk) => {
          let offset = 0
          while (offset < chunk.byteLength) {
            const { bytesWritten } = await output.write(chunk, offset, chunk.byteLength - offset, position)
            if (bytesWritten <= 0) throw new Error(`${label}写入临时文件失败：写入了 0 bytes`)
            offset += bytesWritten
            position += bytesWritten
          }
        },
      })
    } catch (error) {
      bodyFailure = errorOf(error)
    }
    try {
      await output.close()
    } catch (closeFailure) {
      const closeError = errorOf(closeFailure)
      if (bodyFailure) {
        throw new AggregateError(
          [bodyFailure, closeError],
          `${bodyFailure.message}；临时下载文件关闭失败：${closeError.message}`,
        )
      }
      throw closeError
    }
    if (bodyFailure) throw bodyFailure
  } catch (error) {
    throw normalizeTimeout(error, signal, label, timeoutMs)
  }
}

/**
 * Download -> verify -> no-clobber commit transaction. Failure removes only destination.part;
 * an existing verified destination is never deleted or overwritten by cleanup.
 */
export async function downloadVerifiedArtifact(options, dependencies = {}) {
  const {
    url,
    destination,
    maxBytes,
    timeoutMs,
    label,
    verify,
    fetchFn,
    statusError,
  } = options
  const part = `${destination}.part`
  const removeFile = dependencies.removeFile ?? ((path) => rm(path, { force: true }))
  const commitFile = dependencies.commitFile ?? (async (source, target) => {
    // Same-directory hard-link publication is atomic and fails with EEXIST instead
    // of replacing a destination created between the initial check and commit.
    // APFS/ext*/NTFS support hard links; an unsupported filesystem fails closed.
    await link(source, target)
    await removeFile(source)
  })
  const downloadFile = dependencies.downloadFile ?? downloadBoundedFile
  try {
    await removeFile(part)
    await downloadFile(url, part, { maxBytes, timeoutMs, label, fetchFn, statusError })
    await verify(part)
    await commitFile(part, destination)
  } catch (failure) {
    const original = errorOf(failure)
    try {
      await removeFile(part)
    } catch (cleanupFailure) {
      const cleanup = errorOf(cleanupFailure)
      throw new AggregateError(
        [original, cleanup],
        `${original.message}；临时下载清理失败（${part}）：${cleanup.message}`,
      )
    }
    throw original
  }
}
