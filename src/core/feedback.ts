/** Client-side feedback contract and validation.  This module deliberately
 * knows nothing about GitHub; GitHub is a private server concern. */

export const FEEDBACK_SCHEMA_VERSION = 1 as const
export const FEEDBACK_TITLE_MAX = 160
export const FEEDBACK_BODY_MAX = 20_000
export const FEEDBACK_SIGNATURE_MAX = 80
export const FEEDBACK_DIAGNOSTICS_MAX = 8_000
export const FEEDBACK_TOTAL_MAX = 30_000

export type FeedbackMode = 'anonymous' | 'signed'
export type FeedbackCategory = 'bug' | 'feature' | 'other'

export interface FeedbackInput {
  mode: FeedbackMode
  category: FeedbackCategory
  title: string
  body: string
  signature?: string | null
  diagnostics?: string | null
}

export interface FeedbackClientInfo {
  appVersion: string
  platform: string
  arch: string
  profile: string
}

export interface FeedbackPayload {
  schemaVersion: typeof FEEDBACK_SCHEMA_VERSION
  mode: FeedbackMode
  category: FeedbackCategory
  title: string
  body: string
  signature: string | null
  diagnostics: string | null
  client: FeedbackClientInfo
}

export type FeedbackSubmitStatus = 'queued' | 'accepted'

export interface FeedbackSubmitResponse {
  ok: true
  status: FeedbackSubmitStatus
  receiptId: string
}

export interface FeedbackErrorResponse {
  ok: false
  code: 'unconfigured' | 'invalid_request' | 'idempotency_conflict' | 'rate_limited' | 'temporarily_unavailable' | 'network_error' | 'timeout' | 'invalid_response' | 'unknown'
  message: string
  retryable?: boolean
}

export type FeedbackResult = FeedbackSubmitResponse | FeedbackErrorResponse

export type FeedbackValidationResult = {
  ok: true
  input: FeedbackInput
} | {
  ok: false
  error: string
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n')
}

function cleanText(value: string): string {
  return normalizeLineEndings(value).trim()
}

function lengthOf(value: string): number {
  return [...value].length
}

/** Validate and normalize renderer input before it crosses the network boundary. */
export function normalizeFeedbackInput(value: unknown): FeedbackValidationResult {
  if (!value || typeof value !== 'object') return { ok: false, error: '反馈输入无效' }
  const raw = value as Partial<FeedbackInput>
  if (raw.mode !== 'anonymous' && raw.mode !== 'signed') return { ok: false, error: '提交模式无效' }
  if (raw.category !== 'bug' && raw.category !== 'feature' && raw.category !== 'other') return { ok: false, error: '反馈类型无效' }
  if (typeof raw.title !== 'string' || typeof raw.body !== 'string') return { ok: false, error: '反馈标题和正文不能为空' }

  const title = cleanText(raw.title)
  const body = cleanText(raw.body)
  if (!title) return { ok: false, error: '反馈标题不能为空' }
  if (!body) return { ok: false, error: '反馈正文不能为空' }
  if (lengthOf(title) > FEEDBACK_TITLE_MAX) return { ok: false, error: `反馈标题不能超过 ${FEEDBACK_TITLE_MAX} 个字符` }
  if (lengthOf(body) > FEEDBACK_BODY_MAX) return { ok: false, error: `反馈正文不能超过 ${FEEDBACK_BODY_MAX} 个字符` }

  let signature: string | null = null
  if (raw.mode === 'signed') {
    if (typeof raw.signature !== 'string') return { ok: false, error: '署名不能为空' }
    signature = cleanText(raw.signature)
    if (!signature) return { ok: false, error: '署名不能为空' }
    if (lengthOf(signature) > FEEDBACK_SIGNATURE_MAX) return { ok: false, error: `署名不能超过 ${FEEDBACK_SIGNATURE_MAX} 个字符` }
  }

  let diagnostics: string | null = null
  if (raw.diagnostics !== undefined && raw.diagnostics !== null) {
    if (typeof raw.diagnostics !== 'string') return { ok: false, error: '诊断信息无效' }
    diagnostics = cleanText(raw.diagnostics)
    if (lengthOf(diagnostics) > FEEDBACK_DIAGNOSTICS_MAX) return { ok: false, error: `诊断信息不能超过 ${FEEDBACK_DIAGNOSTICS_MAX} 个字符` }
    if (!diagnostics) diagnostics = null
  }

  const total = lengthOf(title) + lengthOf(body) + lengthOf(signature ?? '') + lengthOf(diagnostics ?? '')
  if (total > FEEDBACK_TOTAL_MAX) return { ok: false, error: `反馈总内容不能超过 ${FEEDBACK_TOTAL_MAX} 个字符` }

  return { ok: true, input: { mode: raw.mode, category: raw.category, title, body, signature, diagnostics } }
}

export function toFeedbackPayload(input: FeedbackInput, client: FeedbackClientInfo): FeedbackPayload {
  return {
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    mode: input.mode,
    category: input.category,
    title: input.title,
    body: input.body,
    signature: input.mode === 'signed' ? input.signature ?? null : null,
    diagnostics: input.diagnostics ?? null,
    client: {
      appVersion: cleanText(client.appVersion).slice(0, 64),
      platform: cleanText(client.platform).slice(0, 32),
      arch: cleanText(client.arch).slice(0, 32),
      profile: cleanText(client.profile).slice(0, 32),
    },
  }
}

/** The text users can paste into QQ or another support channel. */
export function formatFeedbackDocument(input: FeedbackInput): string {
  const mode = input.mode === 'signed' ? '署名提交' : '匿名/不署名'
  const category = input.category === 'bug' ? '问题反馈' : input.category === 'feature' ? '功能建议' : '其他'
  const lines = [
    `## DSH Desktop Hub 反馈`,
    '',
    `- 类型：${category}`,
    `- 模式：${mode}`,
    ...(input.mode === 'signed' ? [`- 署名：${input.signature ?? ''}`] : []),
    '',
    `### ${input.title}`,
    '',
    input.body,
  ]
  if (input.diagnostics) lines.push('', '### 诊断信息', '', input.diagnostics)
  return `${lines.join('\n')}\n`
}
