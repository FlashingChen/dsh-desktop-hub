import type { PluginOpAction } from '../core/ipc.js'
import { MAX_SKILL_FILE_BYTES } from '../core/skills.js'

export const MAX_SKILL_NAME_BYTES = 128
export const MAX_SKILL_ID_BYTES = 512
export const MAX_SKILL_DESCRIPTION_BYTES = 64 * 1024
export const MAX_SKILL_BODY_BYTES = MAX_SKILL_FILE_BYTES
export const MAX_SKILL_IMPORT_URL_BYTES = 2_048
export const MAX_PLUGIN_ARG_BYTES = 500
export const MAX_MCP_ID_BYTES = 128

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const CLAWHUB_PART = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const CLAWHUB_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/
const CONTROL = /[\u0000-\u001f\u007f]/
const UNSAFE_TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

export interface SkillCreatePayload {
  name: string
  description: string
  body: string
  overwrite: boolean
}

export interface SkillTogglePayload {
  id: string
  source: 'user-dsh' | 'user-agents'
  skillKind: 'bundle' | 'flat'
  kind: 'model' | 'user'
  value: boolean
}

export interface ClawHubImportPayload {
  owner: string
  slug: string
  version?: string
}

function invalid<T>(error: string): ValidationResult<T> {
  return { ok: false, error }
}

/** IPC structured-clone payloads should be data-only records. Catch hostile Proxy traps in tests/embedders. */
function plainRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object') return null
  try {
    if (Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function withinUtf8Bytes(value: string, maxBytes: number): boolean {
  // A UTF-8 string is never shorter in bytes than in UTF-16 code units. This avoids
  // allocating a second huge buffer for obviously oversized hostile payloads.
  return value.length <= maxBytes && Buffer.byteLength(value, 'utf8') <= maxBytes
}

export function validateSkillCreateInput(input: unknown): ValidationResult<SkillCreatePayload> {
  const payload = plainRecord(input)
  if (!payload) return invalid('输入无效')
  try {
    if (typeof payload.name !== 'string' || typeof payload.description !== 'string' || typeof payload.body !== 'string') {
      return invalid('输入无效')
    }
    const name = payload.name.trim()
    if (!KEBAB.test(name) || !withinUtf8Bytes(name, MAX_SKILL_NAME_BYTES)) {
      return invalid(`skill 名称必须是 ${MAX_SKILL_NAME_BYTES} 字节内的 kebab-case`)
    }
    if (!withinUtf8Bytes(payload.description, MAX_SKILL_DESCRIPTION_BYTES) || CONTROL.test(payload.description)) {
      return invalid(`description 无效或超过 ${MAX_SKILL_DESCRIPTION_BYTES} 字节上限`)
    }
    if (!withinUtf8Bytes(payload.body, MAX_SKILL_BODY_BYTES) || UNSAFE_TEXT_CONTROL.test(payload.body)) {
      return invalid(`body 无效或超过 ${MAX_SKILL_BODY_BYTES} 字节上限`)
    }
    return {
      ok: true,
      value: { name, description: payload.description, body: payload.body, overwrite: payload.overwrite === true },
    }
  } catch {
    return invalid('输入无效')
  }
}

export function validateSkillToggleInput(input: unknown): ValidationResult<SkillTogglePayload> {
  const payload = plainRecord(input)
  if (!payload) return invalid('输入无效')
  try {
    const id = typeof payload.id === 'string' ? payload.id.trim() : ''
    if (!/^skill-v1\.[A-Za-z0-9_-]+$/.test(id) || !withinUtf8Bytes(id, MAX_SKILL_ID_BYTES)) return invalid('skill id 无效')
    if (payload.source !== 'user-dsh' && payload.source !== 'user-agents') return invalid('skill source 无效')
    if (payload.skillKind !== 'bundle' && payload.skillKind !== 'flat') return invalid('skill 文件类型无效')
    if (payload.kind !== 'model' && payload.kind !== 'user') return invalid('kind 无效')
    if (typeof payload.value !== 'boolean') return invalid('value 无效')
    return { ok: true, value: { id, source: payload.source, skillKind: payload.skillKind, kind: payload.kind, value: payload.value } }
  } catch {
    return invalid('输入无效')
  }
}

export function validateSkillImportUrl(url: unknown): ValidationResult<string> {
  if (typeof url !== 'string') return invalid('链接无效')
  const normalized = url.trim()
  if (!normalized || !withinUtf8Bytes(normalized, MAX_SKILL_IMPORT_URL_BYTES) || CONTROL.test(normalized)) {
    return invalid(`链接无效或超过 ${MAX_SKILL_IMPORT_URL_BYTES} 字节上限`)
  }
  return { ok: true, value: normalized }
}

export function validateClawHubImportInput(input: unknown): ValidationResult<ClawHubImportPayload> {
  const payload = plainRecord(input)
  if (!payload) return invalid('ClawHub 条目无效')
  try {
    if (typeof payload.owner !== 'string' || typeof payload.slug !== 'string') return invalid('ClawHub owner/slug 无效')
    const owner = payload.owner.trim()
    const slug = payload.slug.trim()
    if (!CLAWHUB_PART.test(owner) || !CLAWHUB_PART.test(slug)) return invalid('ClawHub owner/slug 无效')
    if (payload.version !== undefined && typeof payload.version !== 'string') return invalid('ClawHub version 无效')
    const version = typeof payload.version === 'string' ? payload.version.trim() : ''
    if (version && !CLAWHUB_VERSION.test(version)) return invalid('ClawHub version 无效')
    return { ok: true, value: { owner, slug, ...(version ? { version } : {}) } }
  } catch {
    return invalid('ClawHub 条目无效')
  }
}

export function validatePluginStartInput(
  action: unknown,
  args: unknown,
): ValidationResult<{ action: PluginOpAction; args: string[] }> {
  if (action !== 'add' && action !== 'remove' && action !== 'update') return invalid('action 无效')
  try {
    if (!Array.isArray(args)) return invalid('args 无效')
    const expected = action === 'update' ? 0 : 1
    if (args.length !== expected) {
      return invalid(action === 'add' ? '安装需要且仅允许一个 spec 参数' : action === 'remove' ? '移除需要且仅允许一个插件名' : '更新不接受额外参数')
    }
    const normalized: string[] = []
    for (const arg of args) {
      if (typeof arg !== 'string') return invalid('args 无效')
      const value = arg.trim()
      if (!value || !withinUtf8Bytes(value, MAX_PLUGIN_ARG_BYTES) || CONTROL.test(value)) {
        return invalid(`插件参数无效或超过 ${MAX_PLUGIN_ARG_BYTES} 字节上限`)
      }
      if ((action === 'add' || action === 'remove') && value.startsWith('-')) {
        return invalid('插件 positional 参数不能以 - 开头')
      }
      normalized.push(value)
    }
    return { ok: true, value: { action, args: normalized } }
  } catch {
    return invalid('args 无效')
  }
}

export function validateMcpDeleteId(id: unknown): ValidationResult<string> {
  if (typeof id !== 'string') return invalid('MCP id 无效')
  const normalized = id.trim()
  if (!normalized || !withinUtf8Bytes(normalized, MAX_MCP_ID_BYTES) || CONTROL.test(normalized)) {
    return invalid(`MCP id 无效或超过 ${MAX_MCP_ID_BYTES} 字节上限`)
  }
  return { ok: true, value: normalized }
}
