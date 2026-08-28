// Credentials migration: flat → versioned (version: "1" + refs:)
// 复刻上游 dsh-credentials-local@0.1.1 的 renderFlatLayoutMigration 校验，不依赖该包。
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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
    if (obj && obj.version === 1) return 'unknown'
    if (obj && obj.version === '1') {
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
  return `version: "1"\nrefs:\n${indented}${suffix}`
}

export function fixVersionStringIssue(text: string): string | undefined {
  // 处理 version: 1 数字误写 → 改为字符串 "1"（dsh-credentials-local 要求 string）
  let doc
  try { doc = parseDocument(text) } catch { return undefined }
  const obj: any = doc.toJS()
  if (obj && obj.version === 1) {
    // 直接文本替换 version 行：数字 1 -> 字符串 "1"
    return text.replace(/^(\s*version\s*:\s*)1\s*$/m, '$1"1"')
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

// ---------- 版本感知：判断当前 dsh 是否支持 versioned ----------
function parseVersion(v: string): number[] | null {
  const m = v.trim().match(/v?(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?/)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function compareVersion(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av !== bv) return av - bv
  }
  return 0
}

function bundledExecExists(): boolean {
  const candidates: string[] = []
  const base = process.resourcesPath ?? join(process.cwd(), 'resources')
  const roots = [
    ...(process.resourcesPath ? [join(base, 'app', 'resources'), join(base, 'app.asar.unpacked', 'resources'), base] : [base]),
    ...((process as NodeJS.Process & { defaultApp?: boolean }).defaultApp === true ? [join(process.cwd(), 'resources')] : []),
  ]
  for (const root of roots) {
    const runtimeBin = join(root, 'rt', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const nodeBin = process.platform === 'win32' ? join(root, 'nd', 'node.exe') : join(root, 'nd', 'bin', 'node')
    if (existsSync(runtimeBin) && existsSync(nodeBin)) return true
  }
  return false
}

function bundledDshVersion(): string | null {
  // 读取打包 manifest 中的 dshVersion（最可靠）
  const candidates: string[] = []
  try {
    // 相对当前模块 src/core → dist/core 两种布局
    const here = dirname(fileURLToPath(import.meta.url))
    candidates.push(join(here, '..', '..', 'resources', 'runtime-manifest.json'))
    candidates.push(join(here, '..', 'resources', 'runtime-manifest.json'))
    candidates.push(join(process.cwd(), 'resources', 'runtime-manifest.json'))
    if (process.resourcesPath) {
      candidates.push(join(process.resourcesPath, 'app', 'resources', 'runtime-manifest.json'))
      candidates.push(join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'runtime-manifest.json'))
      candidates.push(join(process.resourcesPath, 'runtime-manifest.json'))
    }
  } catch { /* ignore */ }
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue
      const j = JSON.parse(readFileSync(p, 'utf8'))
      if (typeof j?.dshVersion === 'string' && j.dshVersion) return j.dshVersion
    } catch { /* ignore */ }
  }
  return null
}

function systemDshVersion(dshExec: string): string | null {
  try {
    const r = spawnSync(dshExec, ['--version'], { encoding: 'utf8', timeout: 3000 })
    if (r.error) return null
    const out = (r.stdout ?? '') + (r.stderr ?? '')
    const m = out.match(/(\d+\.\d+\.\d+(?:-rc\.\d+)?)/)
    return m ? m[1] : null
  } catch { return null }
}

export function dshSupportsVersioned(): boolean {
  // 1) 捆绑运行时存在则直接支持 versioned（打包版必为 >=0.1.1），避免 win32/manifest 在 mac 上的误判
  if (bundledExecExists()) return true
  // 2) 再看捆绑 manifest：平台匹配时才可信
  const bundled = bundledDshVersion()
  if (bundled) {
    const pv = parseVersion(bundled)
    const need = parseVersion('0.1.1')
    if (pv && need && compareVersion(pv, need) >= 0) {
      // 仅当 manifest 与当前平台匹配时才信任，否则以系统 dsh 为准
      try {
        const j = JSON.parse(readFileSync(join(process.cwd(), 'resources', 'runtime-manifest.json'), 'utf8'))
        if (j.platform && j.platform !== process.platform) { /* 平台不匹配，忽略 manifest */ } else return true
      } catch { return true }
    }
  }
  // 2) 看系统 dsh --version（以及 PATH 回退）
  // 复用 resolve 逻辑但避免循环依赖：直接找 PATH 上的 dsh
  const pathCandidates = (process.env.PATH ?? '').split(':')
  // 简单探测：which dsh 变种，spawnSync 直接试 dsh
  for (const bin of ['dsh', '/opt/homebrew/bin/dsh', '/usr/local/bin/dsh']) {
    const v = systemDshVersion(bin)
    if (!v) continue
    const pv = parseVersion(v)
    const need = parseVersion('0.1.1')
    if (pv && need) return compareVersion(pv, need) >= 0
    // 解析失败保守返回 false
    return false
  }
  // 3) 若检测不到 dsh，保守认为不支持 versioned（避免把 flat 写成 versioned 导致 harness 起不来）
  // 打包环境下 bundled 已在第1步返回 true，开发环境无 dsh 则保持 flat
  return false
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
    // 修复 version: 1 数字误写 → version: "1"
    if (text && /^\s*version\s*:\s*1\s*$/m.test(text)) {
      const fixed = fixVersionStringIssue(text)
      if (fixed && fixed !== text) {
        let backup = ''
        try { backup = atomicWriteWithBackup(path, fixed) } catch (e: unknown) { return { ok: false, formatBefore: format, error: String(e) } }
        return { ok: true, formatBefore: format, formatAfter: 'versioned', backupPath: backup, migrated: true }
      }
    }
    return { ok: true, formatBefore: format, migrated: false }
  }
  if (format === 'flat') {
    // 版本感知：仅当 dsh >=0.1.1 才允许 flat→versioned，否则保持 flat 避免 harness 崩溃
    if (!dshSupportsVersioned()) {
      return { ok: false, formatBefore: format, error: '当前 dsh 版本过低（<0.1.1），暂不支持 versioned，已保持 flat 可用（无需处理，打包版会自动支持）' }
    }
    if (!text) return { ok: false, formatBefore: format, error: '无法读取凭据文件' }
    const migrated = migrateFlat(text)
    if (!migrated) return { ok: false, formatBefore: format, error: '无法识别为可迁移的 flat 格式' }
    let backup = ''
    try {
      // 验证迁移后可被 versioned 解析
      const after = detectCredentialsFormat(migrated)
      if (after !== 'versioned') throw new Error('迁移后格式校验失败')
      backup = atomicWriteWithBackup(path, migrated)
    } catch (e: unknown) {
      return { ok: false, formatBefore: format, error: e instanceof Error ? e.message : String(e) }
    }
    return { ok: true, formatBefore: format, formatAfter: 'versioned', backupPath: backup, migrated: true }
  }
  // unknown: 尝试修复 version 数字问题
  if (text) {
    const fixed = fixVersionStringIssue(text)
    if (fixed && fixed !== text) {
      try {
        const backup = atomicWriteWithBackup(path, fixed)
        return { ok: true, formatBefore: format, formatAfter: detectCredentialsFormat(fixed), backupPath: backup, migrated: true }
      } catch (e: unknown) { return { ok: false, formatBefore: format, error: String(e) } }
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
