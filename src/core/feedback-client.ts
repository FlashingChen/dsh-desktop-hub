import { randomUUID } from 'node:crypto'
import { FEEDBACK_SCHEMA_VERSION, type FeedbackPayload, type FeedbackResult } from './feedback.js'

export interface FeedbackClientOptions {
  endpoint: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxAttempts?: number
  waitBetweenAttemptsMs?: number
  idempotencyKey?: string
}

interface ServerResponse {
  ok?: unknown
  status?: unknown
  receiptId?: unknown
  code?: unknown
  message?: unknown
}

function isServerResponse(value: unknown): value is ServerResponse {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function errorResult(
  code: Extract<FeedbackResult, { ok: false }>['code'],
  message: string,
  retryable = false,
): FeedbackResult {
  return { ok: false, code, message, ...(retryable ? { retryable: true } : {}) }
}

function validEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint)
    if (url.pathname !== '/v1/feedback') return false
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
  } catch {
    return false
  }
}

function responseMessage(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : fallback
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Submit to the configured feedback API.  GitHub is intentionally absent from
 * this module. Retries reuse one idempotency key so a lost response cannot
 * create duplicate Issues on the private server.
 */
export async function submitFeedback(payload: FeedbackPayload, options: FeedbackClientOptions): Promise<FeedbackResult> {
  const endpoint = options.endpoint.trim()
  if (!endpoint) return errorResult('unconfigured', '反馈服务尚未配置')
  if (!validEndpoint(endpoint)) return errorResult('unconfigured', '反馈服务地址无效或不是 HTTPS 地址')

  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = Math.max(1000, Math.min(options.timeoutMs ?? 10_000, 30_000))
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 2, 3))
  const waitMs = Math.max(0, Math.min(options.waitBetweenAttemptsMs ?? 250, 2_000))
  const idempotencyKey = options.idempotencyKey?.trim() || randomUUID()
  let lastFailure: FeedbackResult = errorResult('network_error', '暂时无法连接反馈服务', true)

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
          'X-DSH-Feedback-Schema': String(FEEDBACK_SCHEMA_VERSION),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      let parsed: unknown
      try {
        parsed = await response.json()
      } catch {
        parsed = null
      }
      if (!isServerResponse(parsed)) return errorResult('invalid_response', '反馈服务返回格式无效')
      const data = parsed

      if (response.ok && data.ok === true && (data.status === 'queued' || data.status === 'accepted') && typeof data.receiptId === 'string' && data.receiptId.trim()) {
        return { ok: true, status: data.status, receiptId: data.receiptId.trim().slice(0, 120) }
      }

      const retryable = isRetryableStatus(response.status)
      const code = data.code === 'rate_limited'
        ? 'rate_limited'
        : data.code === 'idempotency_conflict'
          ? 'idempotency_conflict'
          : data.code === 'invalid_request'
            ? 'invalid_request'
            : retryable
              ? 'temporarily_unavailable'
              : 'unknown'
      lastFailure = errorResult(code, responseMessage(data.message, `反馈提交失败（HTTP ${response.status}）`), retryable)
      if (!retryable || attempt >= maxAttempts) return lastFailure
    } catch (err) {
      const aborted = err instanceof DOMException ? err.name === 'AbortError' : err instanceof Error && err.name === 'AbortError'
      lastFailure = errorResult(aborted ? 'timeout' : 'network_error', aborted ? '反馈服务响应超时' : '暂时无法连接反馈服务', true)
      if (attempt >= maxAttempts) return lastFailure
    } finally {
      clearTimeout(timer)
    }
    if (waitMs > 0) await sleep(waitMs)
  }
  return lastFailure
}
