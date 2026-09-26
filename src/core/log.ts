// 主进程低频运行日志。文件后端始终 best-effort，任何失败都不能阻塞应用。
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import type { Dirent, Stats } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LOG_NAME_RE = /^main-(?:\d{13,16}|\d{13,16}-\d+-[a-f0-9]{8,})\.log$/
const DEFAULT_MAX_FILES = 10
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const CREATE_RETRIES = 8
const MAX_MESSAGE_CHARS = 32 * 1024
const PLACEHOLDER_RE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/
const SENSITIVE_KEY = '(?:[A-Za-z0-9_-]*token|api[_-]?key|[A-Za-z0-9_-]*secret|password|authorization)'
const KEY_PREFIX = `(^|[^A-Za-z0-9_-])((?:["']?)${SENSITIVE_KEY}(?:["']?)\\s*[:=]\\s*(?!(?:bearer|basic)\\b))`

interface LogFs {
  mkdir: typeof mkdirSync
  chmod: typeof chmodSync
  lstat: typeof lstatSync
  readdir: typeof readdirSync
  unlink: typeof unlinkSync
  open: typeof openSync
  write: typeof writeSync
  close: typeof closeSync
}

const defaultFs: LogFs = {
  mkdir: mkdirSync,
  chmod: chmodSync,
  lstat: lstatSync,
  readdir: readdirSync,
  unlink: unlinkSync,
  open: openSync,
  write: writeSync,
  close: closeSync,
}

export interface LogSession {
  path: string
  write(line: string): void
  close(): void
}

export interface LogSessionOptions {
  dir: string
  now?: () => number
  pid?: number
  randomSuffix?: () => string
  maxFiles?: number
  maxBytes?: number
  fs?: Partial<LogFs>
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code
}

function redactValue(prefix: string, value: string, quote = ''): string {
  if (PLACEHOLDER_RE.test(value)) return `${prefix}${quote}${value}${quote}`
  return `${prefix}${quote}<redacted>${quote}`
}

/** Linear, bounded conservative redaction shared by file and console output. */
export function sanitizeLogMessage(message: string): string {
  let text = String(message)
  if (text.length > MAX_MESSAGE_CHARS) text = `${text.slice(0, MAX_MESSAGE_CHARS)}…<truncated>`

  text = text.replace(/\b((?:https?|wss?):\/\/)([^\s/@]+)@/gi, '$1<redacted>@')
  text = text.replace(/(\bauthorization\s*[:=]\s*)(bearer|basic)\s+(\$\{[A-Za-z_][A-Za-z0-9_]*\}|[^\s,;"'}]+)/gi, (all, prefix, _scheme, value) => (
    PLACEHOLDER_RE.test(value) ? all : `${prefix}<redacted>`
  ))

  const doubleQuoted = new RegExp(`${KEY_PREFIX}"([^"\\r\\n]*)"`, 'gim')
  const singleQuoted = new RegExp(`${KEY_PREFIX}'([^'\\r\\n]*)'`, 'gim')
  // Keep shell-style ${VAR} references intact and do not let the unquoted
  // matcher consume the opening quote handled by the quoted matchers above.
  const unquoted = new RegExp(`${KEY_PREFIX}(\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}|[^\\s,;&}\\]"']+)`, 'gim')
  text = text.replace(doubleQuoted, (_all, lead, assignment, value) => `${lead}${redactValue(assignment, value, '"')}`)
  text = text.replace(singleQuoted, (_all, lead, assignment, value) => `${lead}${redactValue(assignment, value, "'")}`)
  text = text.replace(unquoted, (_all, lead, assignment, value) => `${lead}${redactValue(assignment, value)}`)

  return text.replace(/\b(?:gh[pousr]_[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, '<redacted>')
}

function isManagedLog(entry: Dirent, stat: Stats): boolean {
  return LOG_NAME_RE.test(entry.name) && entry.isFile() && stat.isFile()
}

function retainLogs(dir: string, keep: number, fs: LogFs): void {
  let entries: Dirent[]
  try {
    entries = fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  const managed: Array<{ name: string; mtimeMs: number; dev: number; ino: number }> = []
  for (const entry of entries) {
    if (!LOG_NAME_RE.test(entry.name) || !entry.isFile()) continue
    try {
      const stat = fs.lstat(join(dir, entry.name))
      if (isManagedLog(entry, stat)) managed.push({ name: entry.name, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino })
    } catch {
      /* a raced or unreadable entry is left untouched */
    }
  }
  managed.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
  for (const entry of managed.slice(Math.max(0, keep))) {
    try {
      const path = join(dir, entry.name)
      const current = fs.lstat(path)
      if (current.isFile() && current.dev === entry.dev && current.ino === entry.ino) fs.unlink(path)
    } catch {
      /* retention is best-effort */
    }
  }
}

/** 创建隔离日志会话；失败时返回 null，调用方继续正常启动。 */
export function createLogSession(options: LogSessionOptions): LogSession | null {
  const fs = { ...defaultFs, ...options.fs }
  const now = options.now ?? Date.now
  const pid = options.pid ?? process.pid
  const suffix = options.randomSuffix ?? (() => randomBytes(6).toString('hex'))
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) return null
  try {
    fs.mkdir(options.dir, { recursive: true, mode: 0o700 })
    if (!fs.lstat(options.dir).isDirectory()) return null
    try {
      fs.chmod(options.dir, 0o700)
    } catch {
      /* permission tightening is best-effort on Windows/unusual filesystems */
    }
    retainLogs(options.dir, Math.max(0, maxFiles - 1), fs)
  } catch {
    return null
  }

  let fd: number | null = null
  let path = ''
  for (let attempt = 0; attempt < CREATE_RETRIES; attempt++) {
    let stamp: number
    let random: string
    try {
      stamp = now()
      random = suffix()
    } catch {
      return null
    }
    if (!Number.isSafeInteger(stamp) || stamp < 0 || !Number.isSafeInteger(pid) || pid <= 0 || !/^[a-f0-9]{8,}$/.test(random)) {
      return null
    }
    path = join(options.dir, `main-${stamp}-${pid}-${random}.log`)
    try {
      fd = fs.open(path, 'wx', 0o600)
      break
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') return null
    }
  }
  if (fd === null) return null

  let bytesWritten = 0
  let disabled = false
  return {
    path,
    write(line) {
      if (disabled || fd === null) return
      const text = line.endsWith('\n') ? line : `${line}\n`
      const byteLength = Buffer.byteLength(text, 'utf8')
      if (bytesWritten + byteLength > maxBytes) {
        disabled = true
        return
      }
      try {
        const payload = Buffer.from(text, 'utf8')
        const written = fs.write(fd, payload, 0, payload.byteLength, null)
        bytesWritten += written
        if (written !== payload.byteLength) disabled = true
      } catch {
        disabled = true
      }
    },
    close() {
      if (fd === null) return
      try {
        fs.close(fd)
      } catch {
        /* closing a diagnostic file is best-effort */
      }
      fd = null
      disabled = true
    },
  }
}

let session: LogSession | null = null

/** 在用户目录初始化日志（幂等），返回日志文件路径。 */
export function initLog(): string {
  if (session) return session.path
  const dir = join(homedir(), '.dsh-desktop-hub', 'logs')
  session = createLogSession({ dir })
  if (!session) {
    console.error('[log] 日志初始化失败，继续使用控制台日志')
    return ''
  }
  log(`==== DSH Desktop Hub 启动（pid=${process.pid}, platform=${process.platform}, arch=${process.arch}, electron=${process.versions.electron ?? '?'}, node=${process.versions.node ?? '?'}）====`)
  return session.path
}

export function logPathOf(): string | null {
  return session?.path ?? null
}

/** 追加一行带时间戳的日志；文件失败或超限后仍保留 console 输出。 */
export function log(message: string): void {
  const line = `${new Date().toISOString()}  ${sanitizeLogMessage(message)}`
  session?.write(line)
  console.log(line)
}
