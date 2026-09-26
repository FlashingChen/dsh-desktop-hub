// MCP 系统核心：JSON 导入转换 + profile cordis.patch.yml 事务读写
import { isMap, isScalar, isSeq, parseDocument, stringify, type YAMLSeq } from 'yaml'
import {
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  chmodSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, basename } from 'node:path'

export const MCP_PLUGIN = '@deepseek-ai/dsh-mcp-client'
const SRV_NAME = /^[A-Za-z0-9_-]{1,32}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const MAX_JSON_BYTES = 2 * 1024 * 1024
export const MCP_MAX_SERVERS = 128
const MAX_ARGS = 256
const MAX_ENV = 128
const MAX_HEADERS = 128
const MAX_COMMAND_LENGTH = 4_096
const MAX_ARG_LENGTH = 8_192
const MAX_VALUE_LENGTH = 32_768
const MAX_URL_LENGTH = 8_192
const MAX_CWD_LENGTH = 4_096
const MAX_ROW_ID_LENGTH = 128
export const MCP_MAX_ROWS_BYTES = 2 * 1024 * 1024
export const MCP_MAX_PATCH_BYTES = 2 * 1024 * 1024
const MAX_PATCH_LINES = 50_000
const MAX_DEEP_NODES = 32_768
const MAX_DEEP_DEPTH = 16
const MAX_DEEP_COLLECTION_ITEMS = 256
const MAX_DEEP_STRING_BYTES = 128 * 1024
const MAX_DEEP_KEY_BYTES = 256
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export interface McpServerSpec {
  name: string
  transport: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}

export interface McpRow {
  id: string
  name: string
  config: Record<string, unknown>
}

export interface ConvertResult {
  ok: boolean
  rows?: McpRow[]
  yaml?: string
  warnings?: string[]
  error?: string
}

type FieldResult<T> = { ok: true; value: T } | { ok: false; error: string }
type ServerValidation = { ok: true; server: McpServerSpec; warnings: string[] } | { ok: false; error: string }

export type McpRowValidationResult =
  | { ok: true; row: McpRow }
  | { ok: false; error: string }

export type McpRowsValidationResult =
  | { ok: true; rows: McpRow[] }
  | { ok: false; error: string }

export type McpApplyInputValidationResult =
  | { ok: true; value: { rows: McpRow[]; mode: 'replace' | 'merge' } }
  | { ok: false; error: string }

export type McpUpdateInputValidationResult =
  | { ok: true; value: { row: McpRow } }
  | { ok: false; error: string }

interface DeepBudget {
  nodes: number
  stringBytes: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  try {
    if (Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

/**
 * IPC 顶层 payload 必须是只含白名单 data property 的普通 record。
 * 返回 descriptor value 的副本，后续代码不再通过原对象触发 Proxy `get` trap。
 */
function cloneDataRecord(
  value: unknown,
  label: string,
  allowedKeys: ReadonlySet<string>,
): FieldResult<Record<string, unknown>> {
  if (!isPlainObject(value)) return { ok: false, error: `${label}必须是普通对象` }
  try {
    const keys = Reflect.ownKeys(value)
    if (keys.length > allowedKeys.size) return { ok: false, error: `${label}包含未知字段` }
    const output: Record<string, unknown> = Object.create(null)
    for (const key of keys) {
      if (typeof key !== 'string' || !allowedKeys.has(key)) return { ok: false, error: `${label}包含未知字段` }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) return { ok: false, error: `${label}${key} 必须是普通数据属性` }
      Object.defineProperty(output, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return { ok: true, value: output }
  } catch {
    return { ok: false, error: `${label}无法安全读取` }
  }
}

function deepFailure(label: string, detail: string): FieldResult<never> {
  return { ok: false, error: `${label}${detail}` }
}

function spendString(budget: DeepBudget, value: string, label: string, key = false): FieldResult<string> {
  const bytes = Buffer.byteLength(value, 'utf8')
  const individualLimit = key ? MAX_DEEP_KEY_BYTES : MAX_DEEP_STRING_BYTES
  if (bytes > individualLimit) return deepFailure(label, `超过 ${individualLimit} 字节上限`)
  if (/\0/.test(value)) return deepFailure(label, '含非法 NUL 字符')
  budget.stringBytes += bytes
  if (budget.stringBytes > MCP_MAX_ROWS_BYTES) {
    return deepFailure(label, `使 MCP payload 字符串总量超过 ${MCP_MAX_ROWS_BYTES} 字节上限`)
  }
  return { ok: true, value }
}

/** 将未来 config 字段复制为可审计的 JSON/YAML-safe 数据，绝不把输入对象直接交给 stringify。 */
function cloneYamlSafeValue(
  value: unknown,
  label: string,
  budget: DeepBudget,
  depth: number,
  ancestors: Set<object>,
): FieldResult<unknown> {
  budget.nodes += 1
  if (budget.nodes > MAX_DEEP_NODES) return deepFailure(label, `使 MCP payload 节点数超过 ${MAX_DEEP_NODES} 上限`)
  if (depth > MAX_DEEP_DEPTH) return deepFailure(label, `嵌套深度超过 ${MAX_DEEP_DEPTH} 层上限`)

  if (value === null || typeof value === 'boolean') return { ok: true, value }
  if (typeof value === 'string') return spendString(budget, value, label)
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { ok: true, value } : deepFailure(label, '必须是有限数字')
  }
  if (typeof value !== 'object') {
    return deepFailure(label, `包含不支持的 ${typeof value} 值`)
  }

  const objectValue = value as object
  if (ancestors.has(objectValue)) return deepFailure(label, '包含循环引用')
  ancestors.add(objectValue)
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_DEEP_COLLECTION_ITEMS) {
        return deepFailure(label, `数组项数超过 ${MAX_DEEP_COLLECTION_ITEMS} 上限`)
      }
      const keys = Reflect.ownKeys(value)
      if (keys.some((key) => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) {
        return deepFailure(label, '数组包含额外属性或 Symbol 键')
      }
      if (keys.length !== value.length + 1) return deepFailure(label, '数组包含空洞或额外索引')
      const output: unknown[] = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !('value' in descriptor)) return deepFailure(`${label}[${index}]`, '缺失或使用 accessor')
        const cloned = cloneYamlSafeValue(descriptor.value, `${label}[${index}]`, budget, depth + 1, ancestors)
        if (!cloned.ok) return cloned
        output.push(cloned.value)
      }
      return { ok: true, value: output }
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      return deepFailure(label, '必须是普通对象或数组（不允许 Map/Set/Date/ArrayBuffer/binary）')
    }
    const keys = Reflect.ownKeys(value)
    if (keys.length > MAX_DEEP_COLLECTION_ITEMS) {
      return deepFailure(label, `映射项数超过 ${MAX_DEEP_COLLECTION_ITEMS} 上限`)
    }
    const output: Record<string, unknown> = {}
    for (const key of keys) {
      if (typeof key !== 'string') return deepFailure(label, '包含不支持的 Symbol 键')
      if (DANGEROUS_KEYS.has(key)) return deepFailure(`${label}.${key}`, '是禁止的危险键')
      if (/[\u0000-\u001f\u007f]/.test(key)) return deepFailure(`${label}.${key}`, '键名含非法控制字符')
      const spentKey = spendString(budget, key, `${label}.${key}`, true)
      if (!spentKey.ok) return spentKey
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) return deepFailure(`${label}.${key}`, '不允许 accessor 属性')
      const cloned = cloneYamlSafeValue(descriptor.value, `${label}.${key}`, budget, depth + 1, ancestors)
      if (!cloned.ok) return cloned
      Object.defineProperty(output, key, {
        value: cloned.value,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return { ok: true, value: output }
  } catch (error) {
    return deepFailure(label, `无法安全读取：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    ancestors.delete(objectValue)
  }
}

function optionalStringArray(value: unknown, label: string): FieldResult<string[] | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  if (!Array.isArray(value)) return { ok: false, error: `${label} 必须是字符串数组` }
  if (value.length > MAX_ARGS) return { ok: false, error: `${label} 最多允许 ${MAX_ARGS} 项` }
  const result: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index]
    if (typeof item !== 'string') return { ok: false, error: `${label}[${index}] 必须是字符串` }
    if (item.length > MAX_ARG_LENGTH) return { ok: false, error: `${label}[${index}] 超过 ${MAX_ARG_LENGTH} 字符` }
    if (item.includes('\0')) return { ok: false, error: `${label}[${index}] 含非法 NUL 字符` }
    result.push(item)
  }
  return { ok: true, value: result }
}

function optionalStringMap(
  value: unknown,
  label: 'env' | 'headers',
): FieldResult<Record<string, string> | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  if (!isPlainObject(value)) return { ok: false, error: `${label} 必须是键值字符串对象` }
  const entries = Object.entries(value)
  const maxEntries = label === 'env' ? MAX_ENV : MAX_HEADERS
  if (entries.length > maxEntries) return { ok: false, error: `${label} 最多允许 ${maxEntries} 项` }
  const result: Record<string, string> = {}
  for (const [key, item] of entries) {
    if (key.length > 128) return { ok: false, error: `${label} 键长度不能超过 128 字符` }
    const validKey = label === 'env' ? ENV_NAME.test(key) : HEADER_NAME.test(key)
    if (!validKey) return { ok: false, error: `${label} 键「${key.slice(0, 80)}」格式无效` }
    if (typeof item !== 'string') return { ok: false, error: `${label}.${key} 必须是字符串` }
    if (item.length > MAX_VALUE_LENGTH) return { ok: false, error: `${label}.${key} 超过 ${MAX_VALUE_LENGTH} 字符` }
    if (item.includes('\0')) return { ok: false, error: `${label}.${key} 含非法 NUL 字符` }
    if (label === 'headers' && /[\r\n]/.test(item)) return { ok: false, error: `headers.${key} 含非法换行符` }
    result[key] = item
  }
  return { ok: true, value: result }
}

function transportKind(value: unknown, label: string): FieldResult<{ kind: McpServerSpec['transport']; sse: boolean }> {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, error: `${label} 必须是非空字符串` }
  switch (value.trim().toLowerCase()) {
    case 'stdio':
      return { ok: true, value: { kind: 'stdio', sse: false } }
    case 'http':
    case 'streamable-http':
      return { ok: true, value: { kind: 'streamable-http', sse: false } }
    case 'sse':
      return { ok: true, value: { kind: 'streamable-http', sse: true } }
    default:
      return { ok: false, error: `${label}「${value.slice(0, 80)}」不受支持` }
  }
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function validateServerConfig(name: string, value: unknown, canonical = false): ServerValidation {
  if (!isPlainObject(value)) return { ok: false, error: '配置必须是普通对象' }

  let selected: { kind: McpServerSpec['transport']; sse: boolean } | undefined
  if (canonical) {
    if (hasOwn(value, 'type')) return { ok: false, error: '规范化配置不得包含 type，请使用 transport' }
    if (value.transport !== 'stdio' && value.transport !== 'streamable-http') {
      return { ok: false, error: 'transport 必须是 stdio 或 streamable-http' }
    }
    selected = { kind: value.transport, sse: false }
  } else {
    const declared: { label: string; value: { kind: McpServerSpec['transport']; sse: boolean } }[] = []
    for (const label of ['type', 'transport'] as const) {
      if (!hasOwn(value, label)) continue
      const parsed = transportKind(value[label], label)
      if (!parsed.ok) return parsed
      declared.push({ label, value: parsed.value })
    }
    if (declared.length === 2 && declared[0].value.kind !== declared[1].value.kind) {
      return { ok: false, error: 'type 与 transport 冲突' }
    }
    selected = declared[0]?.value
    if (declared.some((item) => item.value.sse)) selected = { kind: 'streamable-http', sse: true }
  }

  const hasCommand = hasOwn(value, 'command')
  const hasRemoteUrl = hasOwn(value, 'url') || hasOwn(value, 'baseUrl')
  if (!selected) {
    if (hasCommand && hasRemoteUrl) return { ok: false, error: 'command 与 url/baseUrl 不能同时出现，请明确选择 stdio 或 HTTP' }
    if (hasCommand) selected = { kind: 'stdio', sse: false }
    else if (hasRemoteUrl) selected = { kind: 'streamable-http', sse: false }
    else return { ok: false, error: '缺少 command 或 url' }
  }

  if (selected.kind === 'stdio') {
    const remoteFields = ['url', 'baseUrl', 'headers'].filter((key) => hasOwn(value, key))
    if (remoteFields.length > 0) return { ok: false, error: `stdio 配置不能包含 ${remoteFields.join('/')}` }
    if (typeof value.command !== 'string' || !value.command.trim()) return { ok: false, error: 'stdio command 必须是非空字符串' }
    const command = value.command.trim()
    if (command.length > MAX_COMMAND_LENGTH) return { ok: false, error: `command 超过 ${MAX_COMMAND_LENGTH} 字符` }
    if (command.includes('\0')) return { ok: false, error: 'command 含非法 NUL 字符' }
    const args = optionalStringArray(value.args, 'args')
    if (!args.ok) return args
    const env = optionalStringMap(value.env, 'env')
    if (!env.ok) return env
    let cwd: string | undefined
    if (value.cwd !== undefined) {
      if (typeof value.cwd !== 'string' || !value.cwd.trim()) return { ok: false, error: 'cwd 必须是非空字符串' }
      cwd = value.cwd.trim()
      if (cwd.length > MAX_CWD_LENGTH) return { ok: false, error: `cwd 超过 ${MAX_CWD_LENGTH} 字符` }
      if (cwd.includes('\0')) return { ok: false, error: 'cwd 含非法 NUL 字符' }
    }
    return {
      ok: true,
      server: { name, transport: 'stdio', command, ...(args.value ? { args: args.value } : {}), ...(env.value ? { env: env.value } : {}), ...(cwd ? { cwd } : {}) },
      warnings: [],
    }
  }

  const stdioFields = ['command', 'args', 'env', 'cwd'].filter((key) => hasOwn(value, key))
  if (stdioFields.length > 0) return { ok: false, error: `HTTP 配置不能包含 ${stdioFields.join('/')}` }
  if (hasOwn(value, 'url') && hasOwn(value, 'baseUrl') && value.url !== value.baseUrl) {
    return { ok: false, error: 'url 与 baseUrl 冲突' }
  }
  const rawUrl = hasOwn(value, 'url') ? value.url : value.baseUrl
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return { ok: false, error: 'HTTP url 必须是非空字符串' }
  const url = rawUrl.trim()
  if (url.length > MAX_URL_LENGTH) return { ok: false, error: `url 超过 ${MAX_URL_LENGTH} 字符` }
  if (/[\u0000-\u001f\u007f]/.test(url)) return { ok: false, error: 'HTTP url 含非法控制字符' }
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return { ok: false, error: 'HTTP url 格式无效' }
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return { ok: false, error: 'HTTP url 只允许 http 或 https 协议' }
  if (!parsedUrl.hostname) return { ok: false, error: 'HTTP url 缺少主机名' }
  if (parsedUrl.username || parsedUrl.password) return { ok: false, error: 'HTTP url 不允许包含 credentials' }
  const headers = optionalStringMap(value.headers, 'headers')
  if (!headers.ok) return headers
  return {
    ok: true,
    server: { name, transport: 'streamable-http', url, ...(headers.value ? { headers: headers.value } : {}) },
    warnings: selected.sse ? [`「${name}」type=sse：DSH 仅支持 streamable-http，将按 HTTP 处理（需确认端点兼容）`] : [],
  }
}

/** 解析 Claude Code / Cursor 风格 MCP JSON（{ mcpServers: {...} }，兼容 baseUrl/type:sse） */
export function parseMcpJson(text: string): { servers: McpServerSpec[]; warnings: string[] } {
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) throw new Error(`JSON 超过 ${MAX_JSON_BYTES} 字节上限`)
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new Error(`JSON 解析失败: ${(err as Error).message}`)
  }
  if (!isPlainObject(data)) throw new Error('格式不支持：顶层必须是普通对象')
  const mcpServers = data.mcpServers
  if (!isPlainObject(mcpServers)) {
    throw new Error('格式不支持：需要 { "mcpServers": { ... } }（Claude Code/Cursor 风格）')
  }
  const entries = Object.entries(mcpServers)
  if (entries.length > MCP_MAX_SERVERS) throw new Error(`每次最多导入 ${MCP_MAX_SERVERS} 个 MCP 服务器`)
  const warnings: string[] = []
  const servers: McpServerSpec[] = []
  for (const [name, raw] of entries) {
    if (!SRV_NAME.test(name)) {
      warnings.push(`serverName「${name}」不符合 [A-Za-z0-9_-]{1,32}，已跳过`)
      continue
    }
    const validated = validateServerConfig(name, raw)
    if (!validated.ok) {
      warnings.push(`「${name}」${validated.error}，已跳过`)
      continue
    }
    warnings.push(...validated.warnings)
    servers.push(validated.server)
  }
  return { servers, warnings }
}

function validateMcpRowWithBudget(value: unknown, budget: DeepBudget): McpRowValidationResult {
  if (!isPlainObject(value)) return { ok: false, error: 'row 必须是普通对象' }
  let rawId: unknown
  let rawConfig: unknown
  try {
    const idDescriptor = Object.getOwnPropertyDescriptor(value, 'id')
    const configDescriptor = Object.getOwnPropertyDescriptor(value, 'config')
    if (!idDescriptor || !('value' in idDescriptor)) return { ok: false, error: 'id 必须是普通数据属性' }
    if (!configDescriptor || !('value' in configDescriptor)) return { ok: false, error: 'config 必须是普通数据属性' }
    rawId = idDescriptor.value
    rawConfig = configDescriptor.value
  } catch (error) {
    return { ok: false, error: `row 无法安全读取：${error instanceof Error ? error.message : String(error)}` }
  }
  if (typeof rawId !== 'string' || !rawId.trim()) return { ok: false, error: 'id 必须是非空字符串' }
  const id = rawId.trim()
  if (id.length > MAX_ROW_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(id)) return { ok: false, error: 'id 长度或字符无效' }
  const spentId = spendString(budget, id, 'id')
  if (!spentId.ok) return spentId
  const cloned = cloneYamlSafeValue(rawConfig, 'config', budget, 0, new Set())
  if (!cloned.ok) return cloned
  if (!isPlainObject(cloned.value)) return { ok: false, error: 'config 必须是普通对象' }
  const configValue = cloned.value
  const serverName = configValue.serverName
  if (typeof serverName !== 'string' || !SRV_NAME.test(serverName)) return { ok: false, error: 'config.serverName 格式无效' }
  const validated = validateServerConfig(serverName, configValue, true)
  if (!validated.ok) return { ok: false, error: validated.error }
  const [row] = convertToRows([validated.server])
  // 保留 dsh-mcp-client 的可选/未来配置字段，同时用共享验证结果覆盖并规范化
  // transport 核心字段；direct update 不应静默丢掉 reconnect 等既有设置。
  const config = { ...configValue, ...row.config }
  delete config.type
  delete config.baseUrl
  return { ok: true, row: { ...row, id, config } }
}

/** IPC/市场直接写入使用同一配置校验，避免绕过 JSON 导入边界。 */
export function validateMcpRow(value: unknown): McpRowValidationResult {
  return validateMcpRowWithBudget(value, { nodes: 0, stringBytes: 0 })
}

/** apply 的共享预算：128 个各自合法的 row 仍不能合计绕过 2MiB/节点上限。 */
export function validateMcpRows(values: unknown): McpRowsValidationResult {
  try {
    if (!Array.isArray(values) || values.length === 0) return { ok: false, error: '没有可写入的服务器' }
    if (values.length > MCP_MAX_SERVERS) return { ok: false, error: `一次最多写入 ${MCP_MAX_SERVERS} 个 MCP 服务器` }
    const budget: DeepBudget = { nodes: 1, stringBytes: 0 }
    const rows: McpRow[] = []
    const rowIds = new Map<string, number>()
    const serverNames = new Map<string, number>()
    for (let index = 0; index < values.length; index += 1) {
      const validated = validateMcpRowWithBudget(values[index], budget)
      if (!validated.ok) return { ok: false, error: `第 ${index + 1} 行：${validated.error}` }
      const previousId = rowIds.get(validated.row.id)
      if (previousId !== undefined) {
        return { ok: false, error: `第 ${index + 1} 行：id「${validated.row.id}」与第 ${previousId + 1} 行重复` }
      }
      const serverName = validated.row.config.serverName as string
      const previousServer = serverNames.get(serverName)
      if (previousServer !== undefined) {
        return { ok: false, error: `第 ${index + 1} 行：serverName「${serverName}」与第 ${previousServer + 1} 行重复` }
      }
      rowIds.set(validated.row.id, index)
      serverNames.set(serverName, index)
      rows.push(validated.row)
    }
    const yaml = stringify([{ insert: rows }])
    const bytes = Buffer.byteLength(yaml, 'utf8')
    if (bytes > MCP_MAX_ROWS_BYTES) {
      return { ok: false, error: `MCP rows 序列化后超过 ${MCP_MAX_ROWS_BYTES} 字节上限` }
    }
    return { ok: true, rows }
  } catch (error) {
    return { ok: false, error: `MCP rows 无法安全读取或序列化：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** apply handler 的完整 data-only 边界；handler 不再直接读取未可信对象。 */
export function validateMcpApplyInput(input: unknown): McpApplyInputValidationResult {
  const payload = cloneDataRecord(input, '输入', new Set(['rows', 'mode']))
  if (!payload.ok) return payload
  if (!Object.prototype.hasOwnProperty.call(payload.value, 'rows')) return { ok: false, error: '没有可写入的服务器' }
  const mode = payload.value.mode === undefined ? 'merge' : payload.value.mode
  if (mode !== 'replace' && mode !== 'merge') return { ok: false, error: 'MCP 写入模式无效' }
  const rows = validateMcpRows(payload.value.rows)
  if (!rows.ok) {
    const direct = rows.error === '没有可写入的服务器' || rows.error.startsWith('一次最多写入')
    return { ok: false, error: direct ? rows.error : `MCP 服务器格式无效：${rows.error}` }
  }
  return { ok: true, value: { rows: rows.rows, mode } }
}

/** update handler 的完整 data-only 边界；外层 id 覆盖草稿 row.id，保持既有编辑语义。 */
export function validateMcpUpdateInput(input: unknown): McpUpdateInputValidationResult {
  const payload = cloneDataRecord(input, '输入', new Set(['id', 'row']))
  if (!payload.ok) return payload
  if (typeof payload.value.id !== 'string' || !payload.value.id.trim()) return { ok: false, error: 'MCP id 无效' }
  const row = validateMcpRow(payload.value.row)
  if (!row.ok) return { ok: false, error: `MCP 服务器格式无效：${row.error}` }
  const target = validateMcpRow({ ...row.row, id: payload.value.id.trim() })
  if (!target.ok) return { ok: false, error: `MCP id 无效：${target.error}` }
  return { ok: true, value: { row: target.row } }
}

/** 转换服务器清单为 dsh-mcp-client 插件行 */
export function convertToRows(servers: McpServerSpec[]): McpRow[] {
  return servers.map((s) => {
    const config: Record<string, unknown> = { serverName: s.name, transport: s.transport }
    if (s.command) config.command = s.command
    if (s.args) config.args = s.args
    if (s.env) config.env = s.env
    if (s.cwd) config.cwd = s.cwd
    if (s.url) config.url = s.url
    if (s.headers) config.headers = s.headers
    return { id: `mcp-${s.name}`, name: MCP_PLUGIN, config }
  })
}

const ENV_REF = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g

/**
 * 唯一的 MCP 行序列化器：预览与落盘共用，保证所见即所写。
 * Claude Code 的 `${VAR}` 是客户端环境替换语义；DSH 不展开，需转成
 * `!!js process.env.VAR` 动态求值。行级纯 `${VAR}` 值被转换，混合字符串保持字面。
 */
export function renderRowsYaml(rows: McpRow[]): string {
  const validated = validateMcpRows(rows)
  if (!validated.ok) throw new Error(`MCP rows 格式无效：${validated.error}`)
  const text = stringify([{ insert: validated.rows }])
  return text.replace(
    /^(\s*[A-Za-z0-9_.-]+):\s*(['"])?\$\{([A-Za-z_][A-Za-z0-9_]*)\}\2\s*$/gm,
    '$1: !!js process.env.$3',
  )
}

/** JSON 文本 → 转换预览（YAML），env/headers 中 ${VAR} 转为 DSH 的 !!js process.env.VAR */
export function convertJsonToYaml(text: string): ConvertResult {
  try {
    const { servers, warnings } = parseMcpJson(text)
    if (servers.length === 0) return { ok: false, error: '没有可转换的服务器', warnings }
    const rows = convertToRows(servers)
    const envRefCount = (stringify([{ insert: rows }]).match(ENV_REF) ?? []).length
    const yamlText = renderRowsYaml(rows)
    if (envRefCount > 0) {
      warnings.push(`检测到 ${envRefCount} 处环境变量引用（如 \${VAR}），已转换为 !!js process.env.VAR —— 请确保变量在启动 dsh 的环境（或 $DSH_HOME/.env）中可用`)
    }
    return { ok: true, rows, yaml: yamlText, warnings }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** !!js 动态表达式的保真表示：提取时不得 unwrap 成字面字符串（DSH 侧按 JS 表达式求值） */
export interface JsRef {
  $js: string
}

const JS_TAG = 'tag:yaml.org,2002:js'

function assertPatchTextLimits(patchText: string): void {
  if (patchText.length > MCP_MAX_PATCH_BYTES || Buffer.byteLength(patchText, 'utf8') > MCP_MAX_PATCH_BYTES) {
    throw new Error(`patch 超过 ${MCP_MAX_PATCH_BYTES} 字节上限`)
  }
  let lines = 1
  for (let index = 0; index < patchText.length; index += 1) {
    if (patchText.charCodeAt(index) === 10 && ++lines > MAX_PATCH_LINES) {
      throw new Error(`patch 超过 ${MAX_PATCH_LINES} 行上限`)
    }
  }
}

export interface ParsedProfilePatch {
  doc: ReturnType<typeof parseDocument>
  contents: YAMLSeq<unknown> | null
  insertSequences: YAMLSeq<unknown>[]
}

function mapKey(pair: { key?: unknown }): unknown {
  return isScalar(pair.key) ? pair.key.value : undefined
}

/** 所有 patch 消费者共用的 AST 结构边界；不再通过 `.items` 猜测 Map/Seq。 */
export function parseProfilePatch(patchText: string): ParsedProfilePatch {
  assertPatchTextLimits(patchText)
  const doc = parseDocument(patchText)
  if (doc.errors.length > 0) throw new Error(`patch 解析失败: ${doc.errors[0].message}`)
  if (doc.contents === null) return { doc, contents: null, insertSequences: [] }
  if (!isSeq(doc.contents)) throw new Error('patch 顶层必须是 YAML sequence')

  const contents = doc.contents as YAMLSeq<unknown>
  const insertSequences: YAMLSeq<unknown>[] = []
  for (const entry of contents.items) {
    if (!isMap(entry)) continue
    for (const pair of entry.items) {
      if (mapKey(pair) !== 'insert') continue
      if (!isSeq(pair.value)) throw new Error('patch insert 必须是 YAML sequence')
      insertSequences.push(pair.value as YAMLSeq<unknown>)
    }
  }
  return { doc, contents, insertSequences }
}

/** 将 yaml AST 节点解包为纯 JS（Scalar→值、Seq→数组、Map→对象）。
 * !!js tagged scalar 返回 { $js: <expr> } 哨兵，保留动态求值语义。 */
function unwrap(v: unknown): unknown {
  if (isScalar(v)) {
    // Scalar：!!js 表达式必须保真，不能退化为字面字符串
    if (v.tag === JS_TAG) return { $js: String(v.value) }
    return unwrap(v.value)
  }
  if (isSeq(v)) return v.items.map(unwrap)
  if (isMap(v)) {
    const out: Record<string, unknown> = {}
    for (const pair of v.items) {
      const key = String(unwrap(pair.key))
      Object.defineProperty(out, key, {
        value: unwrap(pair.value),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return out
  }
  return v
}

function mapField(row: unknown, key: string): unknown {
  if (!isMap(row)) return undefined
  return row.items.find((pair) => mapKey(pair) === key)?.value
}

/** 从 profile cordis.patch.yml 提取现有 MCP 服务器 */
export function extractMcpServers(patchText: string): McpRow[] {
  const parsed = parseProfilePatch(patchText)
  const rows: McpRow[] = []
  for (const sequence of parsed.insertSequences) {
    for (const row of sequence.items) {
      if (unwrap(mapField(row, 'name')) === MCP_PLUGIN) {
        const configNode = mapField(row, 'config')
        if (!isMap(configNode)) throw new Error(`MCP row config 必须是 YAML map: ${String(unwrap(mapField(row, 'id')) ?? '')}`)
        rows.push({
          id: String(unwrap(mapField(row, 'id')) ?? ''),
          name: MCP_PLUGIN,
          config: unwrap(configNode) as Record<string, unknown>,
        })
      }
    }
  }
  return rows
}

/** 替换 patch 中的 MCP 行（保留其余行与注释），返回新 patch 文本
 * 新行由 renderRowsYaml 序列化后解析接入，保证与预览文本完全一致（含 !!js 标签）。 */
export function replaceMcpRows(patchText: string, rows: McpRow[]): string {
  const parsed = parseProfilePatch(patchText)

  let targetInsert: unknown[] | null = null
  for (const sequence of parsed.insertSequences) {
    const keep = sequence.items.filter((row) => unwrap(mapField(row, 'name')) !== MCP_PLUGIN)
    sequence.items.length = 0
    sequence.items.push(...keep)
    targetInsert ??= sequence.items
  }
  if (rows.length > 0) {
    const fresh = parseProfilePatch(renderRowsYaml(rows))
    const freshRows = fresh.insertSequences[0]?.items
    if (!fresh.contents || !freshRows) throw new Error('MCP rows 序列化后缺少 insert sequence')
    if (!targetInsert) {
      if (!parsed.contents) {
        ;(parsed.doc as { contents: unknown }).contents = fresh.contents
        return parsed.doc.toString()
      }
      parsed.contents.items.push(...fresh.contents.items)
    } else {
      targetInsert.push(...freshRows)
    }
  }
  return parsed.doc.toString()
}

/** 定位 AST 中 id+name 匹配的 MCP 行（只读 id/name 字段，不 unwrap 其他值，避免触碰 !!js） */
function findRowLocation(parsed: ParsedProfilePatch, id: string): { seq: unknown[]; index: number } | null {
  for (const sequence of parsed.insertSequences) {
    for (let index = 0; index < sequence.items.length; index += 1) {
      const row = sequence.items[index]
      if (String(unwrap(mapField(row, 'id'))) === id && unwrap(mapField(row, 'name')) === MCP_PLUGIN) {
        return { seq: sequence.items, index }
      }
    }
  }
  return null
}

/** 用 renderRowsYaml（唯一序列化器）生成单行 AST 节点，保证与预览文本一致（含 !!js） */
function newRowNode(row: McpRow): unknown {
  const fresh = parseProfilePatch(renderRowsYaml([row]))
  const node = fresh.insertSequences[0]?.items[0]
  if (!node) throw new Error(`MCP 行序列化失败: ${row.id}`)
  return node
}

/** 把新行节点追加到第一个 insert 序列；patch 无 insert 块（空/纯注释）时新建顶层 entry */
function appendRowNode(parsed: ParsedProfilePatch, row: McpRow): void {
  const target = parsed.insertSequences[0]
  if (target) {
    target.items.push(newRowNode(row))
    return
  }
  const fresh = parseProfilePatch(renderRowsYaml([row]))
  if (!fresh.contents) throw new Error(`MCP 行序列化失败: ${row.id}`)
  if (!parsed.contents) {
    ;(parsed.doc as { contents: unknown }).contents = fresh.contents
    parsed.contents = fresh.contents
    parsed.insertSequences.push(...fresh.insertSequences)
    return
  }
  parsed.contents.items.push(...fresh.contents.items)
  parsed.insertSequences.push(...fresh.insertSequences)
}

/** 合并写入：按行 id 就地更新/追加草稿行。
 * AST 行级操作：未编辑的 MCP 行（含 !!js 动态值）与其他插件行/注释原样保留。 */
export function mergeMcpRows(patchText: string, rows: McpRow[]): string {
  const parsed = parseProfilePatch(patchText)
  if (rows.length === 0) return parsed.doc.toString()
  const validated = validateMcpRows(rows)
  if (!validated.ok) throw new Error(`MCP rows 格式无效：${validated.error}`)
  for (const row of validated.rows) {
    const loc = findRowLocation(parsed, row.id)
    if (loc) loc.seq[loc.index] = newRowNode(row)
    else appendRowNode(parsed, row)
  }
  return parsed.doc.toString()
}

export interface PatchDescriptorSnapshot {
  size: number
  mtimeMs: number
  ctimeMs: number
  ino: number | bigint
  dev: number | bigint
}

export interface PatchDescriptorReadDependencies {
  fstat: (descriptor: number) => PatchDescriptorSnapshot
  read: (descriptor: number, buffer: Buffer, offset: number, length: number, position: null) => number
}

const DEFAULT_PATCH_DESCRIPTOR_READ_DEPENDENCIES: PatchDescriptorReadDependencies = {
  fstat: (descriptor) => fstatSync(descriptor),
  read: (descriptor, buffer, offset, length, position) => readSync(descriptor, buffer, offset, length, position),
}

function samePatchSnapshot(left: PatchDescriptorSnapshot, right: PatchDescriptorSnapshot): boolean {
  return left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.ino === right.ino
    && left.dev === right.dev
}

/**
 * 从已经打开的 fd 读取稳定快照。前后元数据或实际字节数任一变化都拒绝，
 * 防止外部 writer 截短、同尺寸覆盖或扩写时把混合内容当成完整 patch。
 */
export function readPatchDescriptor(
  descriptor: number,
  dependencies: PatchDescriptorReadDependencies = DEFAULT_PATCH_DESCRIPTOR_READ_DEPENDENCIES,
): string {
  const before = dependencies.fstat(descriptor)
  if (!Number.isSafeInteger(before.size) || before.size < 0) throw new Error('patch 文件大小无效')
  if (before.size > MCP_MAX_PATCH_BYTES) throw new Error(`patch 超过 ${MCP_MAX_PATCH_BYTES} 字节上限`)
  const buffer = Buffer.alloc(Math.min(MCP_MAX_PATCH_BYTES + 1, before.size + 1))
  let offset = 0
  while (offset < buffer.length) {
    const count = dependencies.read(descriptor, buffer, offset, buffer.length - offset, null)
    if (!Number.isInteger(count) || count < 0 || count > buffer.length - offset) {
      throw new Error('patch 读取返回了无效字节数')
    }
    if (count === 0) break
    offset += count
  }
  const after = dependencies.fstat(descriptor)
  if (offset !== before.size || !samePatchSnapshot(before, after)) {
    throw new Error('patch 在读取期间发生变化，请重试')
  }
  const text = buffer.subarray(0, offset).toString('utf8')
  assertPatchTextLimits(text)
  return text
}

/** 更新已有 MCP 行，保留同一 id 以支持 UI 编辑（行级替换，其他行 AST 原样）。 */
export function updateMcpRow(patchText: string, row: McpRow): string {
  const parsed = parseProfilePatch(patchText)
  const loc = findRowLocation(parsed, row.id)
  if (!loc) throw new Error(`MCP 服务器不存在: ${row.id}`)
  loc.seq[loc.index] = newRowNode(row)
  return parsed.doc.toString()
}

/** 删除已有 MCP 行（行级删除，其余行 AST 原样）；允许删除最后一个服务器。 */
export function deleteMcpRow(patchText: string, id: string): string {
  const parsed = parseProfilePatch(patchText)
  const loc = findRowLocation(parsed, id)
  if (!loc) throw new Error(`MCP 服务器不存在: ${id}`)
  loc.seq.splice(loc.index, 1)
  return parsed.doc.toString()
}

let atomicWriteSequence = 0

function hasErrorCode(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code
}

/** 用排他创建保留唯一文件名；已有文件绝不覆盖。 */
function createUniqueFile(base: string, create: (candidate: string) => void): string {
  for (let collision = 0; ; collision++) {
    const candidate = collision === 0 ? base : `${base}-${collision}`
    try {
      create(candidate)
      return candidate
    } catch (err) {
      if (!hasErrorCode(err, 'EEXIST')) throw err
    }
  }
}

/** 原子写 + 备份：写 .bak-<timestamp>-<pid>-<sequence>，临时文件 rename 落盘。
 * - 原文件不存在时跳过备份（不再 ENOENT），新文件默认 0600（patch 可能含 token）。
 * - 原文件存在时备份与临时文件继承原 mode（避免 0600 → 0644 权限漂移）。
 * - 文件名含进程内序号，且用排他创建避开磁盘上的已有文件，同一毫秒连续写也不碰撞。
 * - rename 带短暂重试：Windows 上 Defender 实时扫描 / dsh HMR watcher 可能瞬时占用（EBUSY/EPERM），
 *   与 dsh 自身写入器的重试策略对齐。 */
export function atomicWriteWithBackup(file: string, content: string, backupsDir?: string): string {
  assertPatchTextLimits(content)
  const dir = backupsDir ?? dirname(file)
  mkdirSync(dir, { recursive: true })
  let mode: number | null = null
  try {
    mode = statSync(file).mode & 0o777
  } catch (err) {
    if (!hasErrorCode(err, 'ENOENT')) throw err
  }
  const writeId = `${Date.now()}-${process.pid}-${atomicWriteSequence++}`
  const name = basename(file)
  let backup = ''
  if (mode !== null) {
    backup = createUniqueFile(join(dir, `${name}.bak-${writeId}`), (candidate) => {
      copyFileSync(file, candidate, constants.COPYFILE_EXCL)
    })
    chmodSync(backup, mode)
  }
  const tmp = createUniqueFile(join(dir, `.${name}.tmp-${writeId}`), (candidate) => {
    writeFileSync(candidate, content, { mode: mode ?? 0o600, flag: 'wx' })
  })
  try {
    renameWithRetry(tmp, file)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch (cleanupErr) {
      if (!hasErrorCode(cleanupErr, 'ENOENT')) {
        throw new AggregateError([err, cleanupErr], `原子写入失败，且无法清理临时文件：${tmp}`)
      }
    }
    throw err
  }
  return backup
}

/** rename 落盘：EBUSY/EPERM/EACCES 时 50ms×10 退避重试（同步；主进程低频写路径，代价可忽略） */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 9 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) throw err
      // 同步小睡：Atomics.wait 是主进程可用的唯一同步 sleep
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
}

/** 读取 profile 的 cordis.patch.yml（不存在返回空文本） */
export function readPatch(profileDir: string): string {
  const file = join(profileDir, 'cordis.patch.yml')
  let descriptor: number
  try {
    descriptor = openSync(file, 'r')
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return ''
    throw err
  }
  try {
    return readPatchDescriptor(descriptor)
  } finally {
    closeSync(descriptor)
  }
}
