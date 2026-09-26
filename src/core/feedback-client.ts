import { randomUUID } from 'node:crypto'
import { FEEDBACK_SCHEMA_VERSION, type FeedbackPayload, type FeedbackResult } from './feedback.js'
import { readResponseText } from './response-body.js'

const FEEDBACK_RESPONSE_MAX_BYTES = 32 * 1024
const FEEDBACK_RESPONSE_TOO_LARGE = `反馈服务响应超过 ${FEEDBACK_RESPONSE_MAX_BYTES} 字节上限`

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

function networkFailureCode(error: unknown): 'timeout' | 'network_error' {
  const name = error && typeof error === 'object' && 'name' in error ? (error as { name?: unknown }).name : undefined
  return name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'network_error'
}

function networkFailure(error: unknown): FeedbackResult {
  const code = networkFailureCode(error)
  return errorResult(
    code,
    code === 'timeout' ? '反馈服务响应超时' : '暂时无法连接反馈服务',
    true,
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type ParsedResponse = { ok: true; value: unknown } | { ok: false; message: string }

async function parseResponse(response: Response): Promise<ParsedResponse> {
  let text: string
  try {
    text = await readResponseText(response, FEEDBACK_RESPONSE_MAX_BYTES, FEEDBACK_RESPONSE_TOO_LARGE)
  } catch (error) {
    if (error instanceof Error && error.message === FEEDBACK_RESPONSE_TOO_LARGE) {
      return { ok: false, message: error.message }
    }
    // Abort/network failures while consuming the stream keep the same retry
    // semantics as failures from fetch() itself.
    throw error
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, message: '反馈服务返回格式无效' }
  }
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
      // HTTP status 是重试语义的权威来源；网关常在 429/5xx 返回 HTML 或空 body，
      // 不能让 JSON 解析失败把可重试状态降级为 invalid_response。
      const retryable = isRetryableStatus(response.status)
      const parsed = await parseResponse(response)
      if (!parsed.ok || !isServerResponse(parsed.value)) {
        if (!retryable) {
          return errorResult('invalid_response', parsed.ok ? '反馈服务返回格式无效' : parsed.message)
        }
        lastFailure = errorResult(
          'temporarily_unavailable',
          `反馈服务暂时不可用（HTTP ${response.status}）`,
          true,
        )
        if (attempt >= maxAttempts) return lastFailure
      } else {
        const data = parsed.value

        if (response.ok && data.ok === true && (data.status === 'queued' || data.status === 'accepted') && typeof data.receiptId === 'string' && data.receiptId.trim()) {
          return { ok: true, status: data.status, receiptId: data.receiptId.trim().slice(0, 120) }
        }

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
      }
    } catch (err) {
      lastFailure = networkFailure(err)
      if (attempt >= maxAttempts) return lastFailure
    } finally {
      clearTimeout(timer)
    }
    if (waitMs > 0) await sleep(waitMs)
  }
  return lastFailure
}
