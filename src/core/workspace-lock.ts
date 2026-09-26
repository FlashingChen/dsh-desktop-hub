import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import type { Stats } from 'node:fs'

const RETRIES = 40
const RETRY_MS = 25
const STALE_MS = 30_000
const MAX_RECORD_BYTES = 4 * 1024
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/

interface LockRecord {
  version: 1
  token: string
  pid: number
}

interface Snapshot {
  dev: number
  ino: number
  mtimeMs: number
  size: number
  isFile: boolean
}

interface Inspection {
  snapshot: Snapshot
  record: LockRecord | null
}

type MovePhase = 'recover' | 'release'

export interface WorkspaceLockOptions {
  retryLimit?: number
  retryMs?: number
  staleMs?: number
  now?: () => number
  makeToken?: () => string
  pid?: number
  sleep?: (ms: number) => void
  kill?: (pid: number, signal: 0) => void
  unlink?: (path: string) => void
  beforeMove?: (phase: MovePhase, lockFile: string) => void
  afterCreateOpen?: (lockFile: string) => void
  beforeCreateVerify?: (lockFile: string) => void
  onRecoveryGuardAcquired?: (lockFile: string) => void
}

interface Context extends WorkspaceLockOptions {
  retryLimit: number
  retryMs: number
  staleMs: number
  now: () => number
  sleep: (ms: number) => void
  kill: (pid: number, signal: 0) => void
  unlink: (path: string) => void
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function isProcessAlive(pid: number, kill: (pid: number, signal: 0) => void = process.kill): boolean {
  try {
    kill(pid, 0)
    return true
  } catch (error) {
    return code(error) !== 'ESRCH' // EPERM/unknown: fail closed as alive.
  }
}

function snapshot(stat: Stats): Snapshot {
  return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size, isFile: stat.isFile() }
}

function sameFile(left: Snapshot, right: Snapshot): boolean {
  if (left.ino !== 0 || right.ino !== 0) return left.dev === right.dev && left.ino === right.ino
  return left.isFile === right.isFile && left.size === right.size && left.mtimeMs === right.mtimeMs
}

function parseRecord(source: string): LockRecord | null {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<LockRecord>
  if (
    record.version !== 1
    || typeof record.token !== 'string'
    || !TOKEN_RE.test(record.token)
    || !Number.isSafeInteger(record.pid)
    || (record.pid ?? 0) <= 0
  ) return null
  return record as LockRecord
}

function inspect(path: string): Inspection | null {
  let current: Snapshot
  try {
    current = snapshot(lstatSync(path))
  } catch (error) {
    if (code(error) === 'ENOENT') return null
    throw error
  }
  if (!current.isFile || current.size <= 0 || current.size > MAX_RECORD_BYTES) {
    return { snapshot: current, record: null }
  }
  try {
    return { snapshot: current, record: parseRecord(readFileSync(path, 'utf8')) }
  } catch (error) {
    if (code(error) === 'ENOENT') return null
    throw error
  }
}

function restoreMoved(moved: string, canonical: string, unlink: (path: string) => void): void {
  try {
    linkSync(moved, canonical) // exclusive: never overwrite a newer owner.
  } catch (error) {
    if (code(error) === 'EEXIST') throw new Error(`锁复核失败，隔离文件已保留: ${moved}`)
    throw error
  }
  unlink(moved)
}

function moveAndRemove(
  canonical: string,
  expected: Snapshot,
  phase: MovePhase,
  token: string,
  context: Context,
  accepts: (moved: Inspection) => boolean,
): boolean {
  context.beforeMove?.(phase, canonical)
  const movedPath = `${canonical}.${phase}-${token}-${randomUUID()}`
  try {
    renameSync(canonical, movedPath)
  } catch (error) {
    if (code(error) === 'ENOENT') return false
    throw error
  }
  const moved = inspect(movedPath)
  if (moved && sameFile(expected, moved.snapshot) && accepts(moved)) {
    context.unlink(movedPath)
    return true
  }
  restoreMoved(movedPath, canonical, context.unlink)
  return false
}

function recoverable(lock: Inspection, context: Context): boolean {
  return lock.record
    ? !isProcessAlive(lock.record.pid, context.kill)
    : context.now() - lock.snapshot.mtimeMs > context.staleMs
}

function acquireGuard(guard: string, token: string): boolean {
  let fd: number
  try {
    fd = openSync(guard, 'wx', 0o600)
  } catch (error) {
    if (code(error) === 'EEXIST') return false
    throw error
  }
  try {
    writeFileSync(fd, `${JSON.stringify({ version: 1, token, pid: process.pid })}\n`)
  } finally {
    closeSync(fd)
  }
  return true
}

function releaseGuard(guard: string, token: string, unlink: (path: string) => void): void {
  if (inspect(guard)?.record?.token !== token) throw new Error(`恢复 guard 所有权已变化: ${guard}`)
  unlink(guard)
}

function tryRecover(canonical: string, token: string, context: Context): boolean {
  const guard = `${canonical}.recovery`
  if (!acquireGuard(guard, token)) return false // Guard is never stale-reclaimed.

  let recovered = false
  let failed = false
  let failure: unknown
  try {
    context.onRecoveryGuardAcquired?.(canonical)
    const current = inspect(canonical) // Re-check only after owning the guard.
    if (current && recoverable(current, context)) {
      // Once this exact inode is moved, recovery never touches canonical again.
      recovered = moveAndRemove(canonical, current.snapshot, 'recover', token, context, () => true)
    }
  } catch (error) {
    failed = true
    failure = error
  }

  let releaseFailure: unknown
  try {
    releaseGuard(guard, token, context.unlink)
  } catch (error) {
    releaseFailure = error
  }
  if (failed && releaseFailure !== undefined) {
    throw new AggregateError([failure, releaseFailure], `锁恢复失败且 guard 释放也失败: ${canonical}`)
  }
  if (failed) throw failure
  if (releaseFailure !== undefined) throw releaseFailure
  return recovered
}

function guardExists(canonical: string): boolean {
  return inspect(`${canonical}.recovery`) !== null
}

function createOwned(canonical: string, record: LockRecord, context: Context): void {
  if (guardExists(canonical)) throw Object.assign(new Error(`工作区锁正在恢复: ${canonical}`), { code: 'ELOCKGUARD' })
  const fd = openSync(canonical, 'wx', 0o600)
  let created = snapshot(fstatSync(fd))
  let writeFailure: unknown
  try {
    context.afterCreateOpen?.(canonical)
    writeFileSync(fd, `${JSON.stringify(record)}\n`)
    created = snapshot(fstatSync(fd))
  } catch (error) {
    writeFailure = error
  }
  try {
    closeSync(fd)
  } catch (error) {
    writeFailure = writeFailure === undefined ? error : new AggregateError([writeFailure, error])
  }
  if (writeFailure !== undefined) throw writeFailure // Residue intentionally fails closed.

  context.beforeCreateVerify?.(canonical)
  for (let attempt = 0; guardExists(canonical) && attempt < context.retryLimit; attempt++) {
    if (attempt + 1 < context.retryLimit) context.sleep(context.retryMs)
  }
  if (guardExists(canonical)) throw new Error(`恢复 guard 未释放，拒绝进入写事务: ${canonical}`)
  const current = inspect(canonical)
  if (!current || !sameFile(created, current.snapshot) || current.record?.token !== record.token) {
    throw new Error(`锁创建后所有权复核失败，拒绝进入写事务: ${canonical}`)
  }
}

function releaseOwned(canonical: string, token: string, context: Context): void {
  const current = inspect(canonical)
  if (!current) throw new Error(`工作区锁在释放前消失: ${canonical}`)
  if (current.record?.token !== token) throw new Error(`工作区锁所有权已变化，拒绝删除当前锁: ${canonical}`)
  if (!moveAndRemove(canonical, current.snapshot, 'release', token, context, (moved) => moved.record?.token === token)) {
    throw new Error(`工作区锁在释放期间被替换，未删除替换锁: ${canonical}`)
  }
}

export function withWorkspaceLock<T>(workspaceFile: string, task: () => T, options: WorkspaceLockOptions = {}): T {
  const context: Context = {
    ...options,
    retryLimit: options.retryLimit ?? RETRIES,
    retryMs: options.retryMs ?? RETRY_MS,
    staleMs: options.staleMs ?? STALE_MS,
    now: options.now ?? Date.now,
    sleep: options.sleep ?? sleepSync,
    kill: options.kill ?? process.kill,
    unlink: options.unlink ?? unlinkSync,
  }
  const token = (options.makeToken ?? randomUUID)()
  const pid = options.pid ?? process.pid
  if (!TOKEN_RE.test(token) || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('工作区锁 owner 格式无效')
  if (!Number.isSafeInteger(context.retryLimit) || context.retryLimit <= 0) throw new Error('工作区锁重试次数无效')
  if (!Number.isFinite(context.retryMs) || context.retryMs < 0) throw new Error('工作区锁重试间隔无效')
  if (!Number.isFinite(context.staleMs) || context.staleMs < 0) throw new Error('工作区锁陈旧期限无效')
  const canonical = `${workspaceFile}.lock`
  const record: LockRecord = { version: 1, token, pid }

  let acquired = false
  for (let attempt = 0; attempt < context.retryLimit; attempt++) {
    try {
      createOwned(canonical, record, context)
      acquired = true
      break
    } catch (error) {
      if (!['EEXIST', 'ELOCKGUARD'].includes(code(error) ?? '')) throw error
    }
    if (tryRecover(canonical, token, context)) {
      try {
        createOwned(canonical, record, context)
        acquired = true
        break
      } catch (error) {
        if (!['EEXIST', 'ELOCKGUARD'].includes(code(error) ?? '')) throw error
      }
    }
    if (attempt + 1 < context.retryLimit) context.sleep(context.retryMs)
  }
  if (!acquired) throw new Error(`等待 pnpm-workspace.yaml 锁超时: ${workspaceFile}`)

  let result!: T
  let taskFailed = false
  let taskFailure: unknown
  try {
    result = task()
  } catch (error) {
    taskFailed = true
    taskFailure = error
  }
  let releaseFailure: unknown
  try {
    releaseOwned(canonical, token, context)
  } catch (error) {
    releaseFailure = error
  }
  if (taskFailed && releaseFailure !== undefined) {
    throw new AggregateError([taskFailure, releaseFailure], `任务失败且工作区锁释放也失败: ${workspaceFile}`)
  }
  if (taskFailed) throw taskFailure
  if (releaseFailure !== undefined) throw releaseFailure
  return result
}
