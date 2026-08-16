// MCP 系统核心：JSON 导入转换 + profile cordis.patch.yml 事务读写
import { parseDocument, stringify } from 'yaml'
import { readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync, statSync, chmodSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'

export const MCP_PLUGIN = '@deepseek-ai/dsh-mcp-client'
const SRV_NAME = /^[A-Za-z0-9_-]{1,32}$/

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

/** 解析 Claude Code / Cursor 风格 MCP JSON（{ mcpServers: {...} }，兼容 baseUrl/type:sse） */
export function parseMcpJson(text: string): { servers: McpServerSpec[]; warnings: string[] } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new Error(`JSON 解析失败: ${(err as Error).message}`)
  }
  const mcpServers = (data as { mcpServers?: Record<string, unknown> })?.mcpServers
  if (!mcpServers || typeof mcpServers !== 'object') {
    throw new Error('格式不支持：需要 { "mcpServers": { ... } }（Claude Code/Cursor 风格）')
  }
  const warnings: string[] = []
  const servers: McpServerSpec[] = []
  for (const [name, raw] of Object.entries(mcpServers)) {
    const s = (raw ?? {}) as Record<string, unknown>
    if (!SRV_NAME.test(name)) {
      warnings.push(`serverName「${name}」不符合 [A-Za-z0-9_-]{1,32}，已跳过`)
      continue
    }
    let base: McpServerSpec
    if (typeof s.command === 'string') {
      base = { name, transport: 'stdio' }
      base.command = s.command
      if (Array.isArray(s.args)) base.args = s.args.map(String)
      if (s.env && typeof s.env === 'object') base.env = Object.fromEntries(Object.entries(s.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      if (typeof s.cwd === 'string') base.cwd = s.cwd
    } else {
      const type = String(s.type ?? 'http').toLowerCase()
      if (type === 'sse') warnings.push(`「${name}」type=sse：DSH 仅支持 streamable-http，将按 HTTP 处理（需确认端点兼容）`)
      base = { name, transport: 'streamable-http' }
      base.url = typeof s.url === 'string' ? s.url : typeof s.baseUrl === 'string' ? s.baseUrl : undefined
      if (!base.url) {
        warnings.push(`「${name}」缺少 url，已跳过`)
        continue
      }
      if (s.headers && typeof s.headers === 'object') {
        base.headers = Object.fromEntries(Object.entries(s.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      }
    }
    servers.push(base)
  }
  return { servers, warnings }
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
  const text = stringify([{ insert: rows }])
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

/** 将 yaml AST 节点解包为纯 JS（Scalar→值、Seq→数组、Map→对象） */
function unwrap(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>
    if (typeof o.type === 'string' && 'value' in o) return unwrap(o.value) // Scalar
    if (Array.isArray(o.items)) {
      const first = (o.items as unknown[])[0]
      const isMap = first && typeof first === 'object' && (first as { key?: unknown }).key !== undefined
      if (isMap) {
        const out: Record<string, unknown> = {}
        for (const pair of o.items as { key?: { value?: unknown }; value?: unknown }[]) {
          const k = pair.key && typeof pair.key === 'object' && 'value' in pair.key ? (pair.key as { value: unknown }).value : pair.key
          out[String(k)] = unwrap(pair.value)
        }
        return out
      }
      return (o.items as unknown[]).map(unwrap) // Seq
    }
  }
  return v
}

/** 从 profile cordis.patch.yml 提取现有 MCP 服务器 */
export function extractMcpServers(patchText: string): McpRow[] {
  const doc = parseDocument(patchText)
  if (doc.errors.length > 0) throw new Error(`patch 解析失败: ${doc.errors[0].message}`)
  const rows: McpRow[] = []
  const entries = (doc.contents as { items?: unknown[] } | null)?.items ?? []
  for (const entry of entries) {
    const node = entry as { items?: { key?: { value?: string }; value?: unknown }[] } | null
    if (!node?.items) continue
    for (const pair of node.items) {
      if (pair.key?.value !== 'insert') continue
      const seq = pair.value as { items?: unknown[] } | null
      if (!seq || !Array.isArray(seq.items)) continue
      for (const row of seq.items) {
        const r = row as { items?: { key?: { value?: string }; value?: unknown }[] } | null
        const get = (k: string): unknown => r?.items?.find((p) => p.key?.value === k)?.value
        if (unwrap(get('name')) === MCP_PLUGIN) {
          rows.push({
            id: String(unwrap(get('id')) ?? ''),
            name: MCP_PLUGIN,
            config: (unwrap(get('config')) as Record<string, unknown>) ?? {},
          })
        }
      }
    }
  }
  return rows
}

/** 替换 patch 中的 MCP 行（保留其余行与注释），返回新 patch 文本
 * 新行由 renderRowsYaml 序列化后解析接入，保证与预览文本完全一致（含 !!js 标签）。 */
export function replaceMcpRows(patchText: string, rows: McpRow[]): string {
  const doc = parseDocument(patchText)
  if (doc.errors.length > 0) throw new Error(`patch 解析失败: ${doc.errors[0].message}`)
  const entries = (doc.contents as { items?: unknown[] } | null)?.items ?? []

  let targetInsert: unknown[] | null = null
  for (const entry of entries) {
    const node = entry as { items?: { key?: { value?: string }; value?: unknown }[] } | null
    if (!node?.items) continue
    for (const pair of node.items) {
      if (pair.key?.value !== 'insert') continue
      const seq = pair.value as { items?: unknown[] } | null
      if (!seq || !Array.isArray(seq.items)) continue
      // 移除现有 MCP 行
      const keep = seq.items.filter((row) => {
        const r = row as { items?: { key?: { value?: string }; value?: unknown }[] } | null
        const name = r?.items?.find((p) => p.key?.value === 'name')?.value
        return unwrap(name) !== MCP_PLUGIN
      })
      seq.items.length = 0
      seq.items.push(...keep)
      targetInsert ??= seq.items
    }
  }
  if (rows.length > 0) {
    const fresh = parseDocument(renderRowsYaml(rows))
    const freshEntries = ((fresh.contents as { items?: unknown[] } | null)?.items ?? []) as unknown[]
    if (!targetInsert) {
      if (!doc.contents) return fresh.toString()
      const contents = doc.contents as { items?: unknown[] }
      ;(contents.items ??= []).push(...freshEntries)
    } else {
      const insertEntry = freshEntries[0] as { items?: { key?: { value?: string }; value?: { items?: unknown[] } }[] } | null
      const seq = insertEntry?.items?.find((p) => p.key?.value === 'insert')?.value
      if (seq?.items) targetInsert.push(...seq.items)
    }
  }
  return doc.toString()
}

/** 合并写入：按行 id 就地更新/追加草稿行，保留现有非草稿 MCP 行 */
export function mergeMcpRows(patchText: string, rows: McpRow[]): string {
  const existing = extractMcpServers(patchText)
  const merged = [...existing]
  for (const row of rows) {
    const idx = merged.findIndex((r) => r.id === row.id)
    if (idx >= 0) merged[idx] = row
    else merged.push(row)
  }
  return replaceMcpRows(patchText, merged)
}

/** 更新已有 MCP 行，保留同一 id 以支持 UI 编辑。 */
export function updateMcpRow(patchText: string, row: McpRow): string {
  const rows = extractMcpServers(patchText)
  const index = rows.findIndex((current) => current.id === row.id)
  if (index < 0) throw new Error(`MCP 服务器不存在: ${row.id}`)
  rows[index] = row
  return replaceMcpRows(patchText, rows)
}

/** 删除已有 MCP 行；允许删除最后一个服务器。 */
export function deleteMcpRow(patchText: string, id: string): string {
  const rows = extractMcpServers(patchText)
  const next = rows.filter((row) => row.id !== id)
  if (next.length === rows.length) throw new Error(`MCP 服务器不存在: ${id}`)
  return replaceMcpRows(patchText, next)
}

/** 原子写 + 备份：写 .bak-<ts>，临时文件 rename 落盘。
 * - 原文件不存在时跳过备份（不再 ENOENT），新文件默认 0600（patch 可能含 token）。
 * - 原文件存在时备份与临时文件继承原 mode（避免 0600 → 0644 权限漂移）。 */
export function atomicWriteWithBackup(file: string, content: string, backupsDir?: string): string {
  const dir = backupsDir ?? dirname(file)
  mkdirSync(dir, { recursive: true })
  let mode: number | null = null
  try {
    mode = statSync(file).mode & 0o777
  } catch {
    /* 原文件不存在：不备份 */
  }
  const ts = Date.now()
  const name = basename(file)
  let backup = ''
  if (mode !== null) {
    backup = join(dir, `${name}.bak-${ts}`)
    copyFileSync(file, backup)
    chmodSync(backup, mode)
  }
  const tmp = join(dir, `.${name}.tmp-${ts}`)
  writeFileSync(tmp, content, { mode: mode ?? 0o600 })
  renameSync(tmp, file)
  return backup
}

/** 读取 profile 的 cordis.patch.yml（不存在返回空文本） */
export function readPatch(profileDir: string): string {
  try {
    return readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
  } catch {
    return ''
  }
}
