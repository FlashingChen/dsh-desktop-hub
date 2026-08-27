// Credentials migration: flat → versioned (version: 1 + refs:)
// 复刻上游 dsh-credentials-local@0.1.1 的 renderFlatLayoutMigration 校验，不依赖该包。
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseDocument, isMap, isScalar } from 'yaml'
import { atomicWriteWithBackup } from './mcp.js'

export type CredentialsFormat = 'flat' | 'versioned' | 'empty' | 'missing' | 'unknown'

const CRED_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function isValidRef(name: string): boolean {
  return CRED_REF_RE.test(name)
}

export function detectCredentialsFormat(text: string | undefined): CredentialsFormat {
  if (text === undefined) return 'missing'
  if (text.trim() === '') return 'empty'
  let doc
  try {
    doc = parseDocument(text, { prettyErrors: true, uniqueKeys: true })
  } catch {
    return 'unknown'
  }
  if (doc.errors.length > 0) return 'unknown'
  const contents: any = doc.contents
  if (!isMap(contents) || contents.items.length === 0) return 'empty'
  // versioned: has version key
  const hasVersion = contents.items.some((pair: any) => isScalar(pair.key) && pair.key.value === 'version')
  if (hasVersion) {
    const obj: any = doc.toJS()
    if (obj && obj.version === '1') return 'unknown'
    if (obj && obj.version === 1) {
      const keys = Object.keys(obj)
      const allowed = new Set(['version','refs','records'])
      if (keys.some(k => !allowed.has(k))) return 'unknown'
      return 'versioned'
    }
    return 'unknown'
  }
  // flat: all keys valid refs, values non-empty strings, no directives
  for (const line of text.split('\n')) if (/^(%|---|\.\.\.)/.test(line)) return 'unknown'
  for (const pair of contents.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || !isValidRef(pair.key.value)) return 'unknown'
    if (!isScalar(pair.value) || typeof pair.value.value !== 'string' || pair.value.value.length === 0) return 'unknown'
  }
  return 'flat'
}

export function canMigrateFlat(text: string): boolean {
  return detectCredentialsFormat(text) === 'flat'
}

export function migrateFlat(text: string): string | undefined {
  if (!canMigrateFlat(text)) return undefined
  // 上游逻辑：原行 verbatim 缩进两格进 refs
  const indented = text.split('\n').map(line => line.length === 0 ? line : `  ${line}`).join('\n')
  const suffix = text.endsWith('\n') ? '' : '\n'
  return `version: 1\nrefs:\n${indented}${suffix}`
}

export function fixVersionStringIssue(text: string): string | undefined {
  // 处理 version: "1" 字符串误写 → 改为数字
  let doc
  try { doc = parseDocument(text) } catch { return undefined }
  const obj: any = doc.toJS()
  if (obj && obj.version === '1') {
    // 直接文本替换 version 行
    return text.replace(/^(\s*version\s*:\s*)"1"/m, '$11').replace(/^(\s*version\s*:\s*)'1'/m, '$11')
  }
  return undefined
}

export interface MigrationResult {
  ok: boolean
  formatBefore: CredentialsFormat
  formatAfter?: CredentialsFormat
  backupPath?: string
  migrated?: boolean
  error?: string
}

export function credentialsPath(home = homedir()): string {
  const dshHome = process.env.DSH_HOME ?? join(home, '.dsh')
  return join(dshHome, '.credentials.yaml')
}

export function checkCredentialsFile(path = credentialsPath()): { format: CredentialsFormat; text: string | undefined } {
  if (!existsSync(path)) return { format: 'missing', text: undefined }
  try {
    const text = readFileSync(path, 'utf8')
    return { format: detectCredentialsFormat(text), text }
  } catch {
    return { format: 'unknown', text: undefined }
  }
}

export function backupAndMigrate(path = credentialsPath()): MigrationResult {
  const { format, text } = checkCredentialsFile(path)
  if (format === 'missing' || format === 'empty') return { ok: true, formatBefore: format, migrated: false }
  if (format === 'versioned') {
    // also fix string version edge
    if (text && text.match(/version\s*:\s*["']1["']/)) {
      const fixed = fixVersionStringIssue(text)
      if (fixed && fixed !== text) {
        let backup = ''
        try { backup = atomicWriteWithBackup(path, fixed) } catch (e) { return { ok: false, formatBefore: format, error: String(e) } }
        return { ok: true, formatBefore: format, formatAfter: 'versioned', backupPath: backup, migrated: true }
      }
    }
    return { ok: true, formatBefore: format, migrated: false }
  }
  if (format === 'flat') {
    const migrated = migrateFlat(text!)
    if (!migrated) return { ok: false, formatBefore: format, error: '无法识别为可迁移的 flat 格式' }
    let backup = ''
    try {
      // 验证迁移后可被 versioned 解析
      const after = detectCredentialsFormat(migrated)
      if (after !== 'versioned') throw new Error('迁移后格式校验失败')
      backup = atomicWriteWithBackup(path, migrated)
    } catch (e) {
      return { ok: false, formatBefore: format, error: e instanceof Error ? e.message : String(e) }
    }
    return { ok: true, formatBefore: format, formatAfter: 'versioned', backupPath: backup, migrated: true }
  }
  // unknown: try fix version string, else report
  if (text) {
    const fixed = fixVersionStringIssue(text)
    if (fixed && fixed !== text) {
      try {
        const backup = atomicWriteWithBackup(path, fixed)
        return { ok: true, formatBefore: format, formatAfter: detectCredentialsFormat(fixed), backupPath: backup, migrated: true }
      } catch (e) { return { ok: false, formatBefore: format, error: String(e) } }
    }
  }
  return { ok: false, formatBefore: format, error: '未知凭据格式，需手动检查 ~/.dsh/.credentials.yaml' }
}

export function readCredentialsFormatLabel(format: CredentialsFormat): string {
  switch (format) {
    case 'flat': return '旧版 flat（需迁移）'
    case 'versioned': return '新版 versioned'
    case 'missing': return '不存在'
    case 'empty': return '空文件'
    case 'unknown': return '未知/损坏'
  }
}
