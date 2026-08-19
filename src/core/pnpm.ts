// pnpm 构建脚本策略：把一次明确的插件安装失败转换为可审计、幂等的 allowBuilds 更新。
import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { isMap, parseDocument } from 'yaml'
import { atomicWriteWithBackup } from './mcp.js'

const PACKAGE_NAME_RE = /^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/
const BUILD_DEP_PATH_RE = /^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+@(?:git\+|github:|file:|https?:\/\/).+$/
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g
const LOCK_RETRY_LIMIT = 40
const LOCK_RETRY_MS = 25
const LOCK_STALE_MS = 30_000

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function isBuildApprovalKey(value: string): boolean {
  return PACKAGE_NAME_RE.test(value) || BUILD_DEP_PATH_RE.test(value)
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function stripPnpmHintPrefix(line: string): string {
  return line.replace(/^\s*hint:\s?/, '')
}

/**
 * 从 pnpm 的 ERR_PNPM_IGNORED_BUILDS 输出中提取包名。
 * pnpm 可能输出 `node-pty@1.1.0`，allowBuilds 对 registry 依赖使用包名，因此这里去掉版本。
 */
export function parseIgnoredBuildPackages(output: string): string[] {
  const packages = new Set<string>()
  for (const line of output.replace(ANSI_RE, '').split(/\r?\n/)) {
    const marker = line.match(/ignored build scripts?\s*:\s*(.+)$/i)
    if (!marker) continue
    for (const token of marker[1].split(/[\s,]+/)) {
      const candidate = token.replace(/^[`'"([{<]+|[\].,;:'"）】)>}]+$/g, '')
      const match = candidate.match(/^(@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+)(?:@.+)?$/)
      if (match && PACKAGE_NAME_RE.test(match[1])) packages.add(match[1])
    }
  }
  return [...packages]
}

/**
 * 解析两种 pnpm 构建授权错误：
 * - 普通依赖：ERR_PNPM_IGNORED_BUILDS + 包名列表；
 * - Git 依赖 prepare：ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED + allowBuilds 示例。
 * Git 依赖必须保留 pnpm 给出的完整 depPath，不能只保留 manifest.name。
 */
export function parseBuildApprovalKeys(output: string): string[] {
  const clean = output.replace(ANSI_RE, '')
  if (/ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED/i.test(clean)) {
    const lines = clean.split(/\r?\n/).map(stripPnpmHintPrefix)
    const allowIndex = lines.findIndex((line) => /^\s*allowBuilds:\s*$/.test(line))
    if (allowIndex < 0) return []
    const keys: string[] = []
    for (let index = allowIndex + 1; index < lines.length; index++) {
      const line = lines[index]
      if (!line.trim()) continue
      if (!/^\s{2,}/.test(line)) break
      const match = line.match(/^\s{2,}(.+?):\s*true\s*$/)
      if (match && isBuildApprovalKey(match[1].trim())) keys.push(match[1].trim())
    }
    return unique(keys)
  }
  if (/ERR_PNPM_IGNORED_BUILDS/i.test(clean)) return parseIgnoredBuildPackages(clean)
  return []
}

export interface ApproveIgnoredBuildsResult {
  changed: boolean
  approved: string[]
}

function withWorkspaceLock<T>(workspaceFile: string, task: () => T): T {
  const lockFile = `${workspaceFile}.lock`
  let fd: number | undefined
  for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt++) {
    try {
      fd = openSync(lockFile, 'wx', 0o600)
      break
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw err
      try {
        if (Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_MS) unlinkSync(lockFile)
      } catch {
        /* another writer may have removed/replaced the lock */
      }
      sleepSync(LOCK_RETRY_MS)
    }
  }
  if (fd === undefined) throw new Error(`等待 pnpm-workspace.yaml 锁超时: ${workspaceFile}`)
  try {
    return task()
  } finally {
    try {
      closeSync(fd)
    } finally {
      try {
        unlinkSync(lockFile)
      } catch {
        /* lock may already have been cleaned up after a stale-owner recovery */
      }
    }
  }
}

/**
 * 幂等地把包加入 profile 的 pnpm-workspace.yaml allowBuilds。
 * 只写入 pnpm 明确报告的 key，不覆盖用户明确设置为 false 的拒绝项。
 * 读改写全程持有跨进程锁，并沿用 profile 配置的原子写入与备份策略。
 */
export function approveIgnoredBuilds(workspaceFile: string, packageNames: string[]): ApproveIgnoredBuildsResult {
  const names = unique(packageNames.filter(isBuildApprovalKey))
  if (names.length === 0) return { changed: false, approved: [] }

  return withWorkspaceLock(workspaceFile, () => {
    const source = existsSync(workspaceFile) ? readFileSync(workspaceFile, 'utf8') : ''
    const doc = parseDocument(source || '{}')
    if (doc.errors.length > 0) throw new Error(`pnpm-workspace.yaml 解析失败: ${doc.errors[0].message}`)

    const existing = doc.get('allowBuilds')
    if (existing !== undefined && existing !== null && !isMap(existing)) {
      throw new Error('pnpm-workspace.yaml 的 allowBuilds 必须是包名到布尔值的映射')
    }
    if (existing === null) doc.set('allowBuilds', {})

    const denied = names.filter((name) => doc.getIn(['allowBuilds', name]) === false)
    if (denied.length > 0) {
      throw new Error(`构建包已被用户明确拒绝：${denied.join(', ')}`)
    }

    const approved: string[] = []
    for (const name of names) {
      if (doc.getIn(['allowBuilds', name]) === true) continue
      doc.setIn(['allowBuilds', name], true)
      approved.push(name)
    }
    if (approved.length === 0) return { changed: false, approved: [] }

    const currentSource = existsSync(workspaceFile) ? readFileSync(workspaceFile, 'utf8') : ''
    if (currentSource !== source) throw new Error('pnpm-workspace.yaml 在更新期间发生变化，请重试安装')
    atomicWriteWithBackup(workspaceFile, doc.toString())
    return { changed: true, approved }
  })
}
