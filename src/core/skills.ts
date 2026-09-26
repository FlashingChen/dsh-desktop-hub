// Skills 系统核心：按 DSH rank 规则扫描 skill 根目录、frontmatter 解析、创建/可见性切换、zip/GitHub 导入
import {
  existsSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  realpathSync,
  type Dirent,
  writeFileSync,
  mkdirSync,
  rmSync,
  renameSync,
  mkdtempSync,
  statSync,
  chmodSync,
} from 'node:fs'
import { join, dirname, resolve, basename, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { isMap, parseDocument, stringify } from 'yaml'
import AdmZip from 'adm-zip'
import { readResponseBytes, readResponseText } from './response-body.js'

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// 解压资源上限：条目数 / 单文件 / 总解压体积（防 zip bomb 与磁盘耗尽）
const MAX_ZIP_ENTRIES = 512
export const MAX_SKILL_FILE_BYTES = 10 * 1024 * 1024
export const MAX_SCAN_SKILL_FILE_BYTES = 2 * 1024 * 1024
export const MAX_SCAN_ROOT_ENTRIES = 1_024
export const MAX_SCAN_ROOT_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_ENTRY_SIZE = MAX_SKILL_FILE_BYTES
const MAX_TOTAL_SIZE = 100 * 1024 * 1024
// GitHub 下载上限与超时
const MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 30_000
const MAX_CLAWHUB_METADATA_SIZE = 256 * 1024
let writeArtifactSequence = 0

export type SkillSource = 'project-dsh' | 'project-agents' | 'custom' | 'user-dsh' | 'user-agents' | 'bundled'

export interface SkillScanOptions {
  dshHome?: string
  agentsHome?: string
  projectRoot?: string
  customDirs?: string[]
  bundledDir?: string
  limits?: Partial<SkillScanLimits>
}

export interface SkillScanLimits {
  maxEntriesPerRoot: number
  maxFileBytes: number
  maxTotalBytesPerRoot: number
}

export interface SkillSummary {
  /** Opaque scan identity; never interpreted as a filesystem path. */
  id: string
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  source: SkillSource
  root: string
  path: string
  kind: 'bundle' | 'flat'
  shadowed: boolean
  canToggle: boolean
  bodyPreview: string
}

export interface SkillScanResult {
  skills: SkillSummary[]
  warnings: string[]
}

export interface SkillIdentity {
  id: string
  source: SkillSource
  kind: SkillSummary['kind']
}

interface RawSkill {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  source: SkillSource
  rootSlot: number
  root: string
  path: string
  kind: 'bundle' | 'flat'
  canToggle: boolean
  body: string
}

interface SkillRoot {
  dir: string
  source: SkillSource
  slot: number
}

const RANK: Record<SkillSource, number> = {
  'project-dsh': 100,
  'project-agents': 200,
  custom: 300,
  'user-dsh': 400,
  'user-agents': 500,
  bundled: 600,
}

/** 解析 SKILL.md / <name>.md：frontmatter + 正文 */
export function parseSkillFile(text: string): { meta: Record<string, unknown>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { meta: {}, body: text }
  const doc = parseDocument(m[1])
  const meta = doc.errors.length > 0 ? {} : ((doc.toJS() ?? {}) as Record<string, unknown>)
  return { meta, body: m[2].replace(/^\n/, '') }
}

function skillNameFromDir(name: string): string | null {
  return KEBAB.test(name) ? name : null
}

function scanLimits(overrides: Partial<SkillScanLimits> | undefined): SkillScanLimits {
  const positive = (value: number | undefined, fallback: number): number =>
    Number.isSafeInteger(value) && value! > 0 ? value! : fallback
  return {
    maxEntriesPerRoot: positive(overrides?.maxEntriesPerRoot, MAX_SCAN_ROOT_ENTRIES),
    maxFileBytes: positive(overrides?.maxFileBytes, MAX_SCAN_SKILL_FILE_BYTES),
    maxTotalBytesPerRoot: positive(overrides?.maxTotalBytesPerRoot, MAX_SCAN_ROOT_TOTAL_BYTES),
  }
}

function isWithinRoot(rootReal: string, candidateReal: string): boolean {
  const rel = relative(rootReal, candidateReal)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function warningLabel(root: SkillRoot, entry?: string): string {
  return `${root.source}[${root.slot}]${entry ? ` ${entry}` : ''}`
}

function readScanFile(
  file: string,
  rootReal: string,
  remainingBytes: number,
  maxFileBytes: number,
): { text: string; bytes: number; real: string; symbolic: boolean } {
  // lstat before realpath makes symlinks explicit; realpath is then checked
  // against the canonical root before any target metadata/content is read.
  const initial = lstatSync(file)
  const real = realpathSync(file)
  if (!isWithinRoot(rootReal, real)) throw new Error('路径越过扫描根')
  const before = statSync(real)
  if (!before.isFile()) throw new Error('目标不是普通文件')
  if (before.size > maxFileBytes) throw new Error(`文件超过扫描上限 ${maxFileBytes} 字节`)
  if (before.size > remainingBytes) throw new Error('root 扫描总读取字节已达上限')

  const fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    // Re-check the opened inode and always perform a bounded read. A grow/shrink
    // race can no longer make readFileSync allocate an unbounded buffer.
    const opened = fstatSync(fd)
    if (!opened.isFile()) throw new Error('打开后的目标不是普通文件')
    if (opened.size > maxFileBytes) throw new Error(`文件超过扫描上限 ${maxFileBytes} 字节`)
    if (opened.size > remainingBytes) throw new Error('root 扫描总读取字节已达上限')
    const cap = Math.min(maxFileBytes, remainingBytes)
    const chunks: Buffer[] = []
    let total = 0
    while (total <= cap) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, cap + 1 - total))
      const count = readSync(fd, chunk, 0, chunk.length, null)
      if (count === 0) break
      chunks.push(chunk.subarray(0, count))
      total += count
    }
    if (total > maxFileBytes) throw new Error(`文件超过扫描上限 ${maxFileBytes} 字节`)
    if (total > remainingBytes) throw new Error('root 扫描总读取字节已达上限')
    return {
      text: Buffer.concat(chunks, total).toString('utf8'),
      bytes: total,
      real,
      symbolic: initial.isSymbolicLink(),
    }
  } finally {
    closeSync(fd)
  }
}

/** 扫描单个 skill 根目录；任何单条失败只产生 warning。 */
function scanRoot(root: SkillRoot, out: RawSkill[], warnings: string[], limits: SkillScanLimits): void {
  let rootReal: string
  try {
    rootReal = realpathSync(root.dir)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') warnings.push(`${warningLabel(root)} 根目录不可读，已跳过`)
    return
  }

  const entries: Dirent[] = []
  let directory
  try {
    directory = opendirSync(rootReal)
    while (entries.length < limits.maxEntriesPerRoot) {
      const entry = directory.readSync()
      if (!entry) break
      entries.push(entry)
    }
    if (entries.length === limits.maxEntriesPerRoot && directory.readSync()) {
      warnings.push(`${warningLabel(root)} 条目超过上限 ${limits.maxEntriesPerRoot}，其余已跳过`)
    }
  } catch {
    warnings.push(`${warningLabel(root)} 目录枚举失败，已跳过`)
    return
  } finally {
    try {
      directory?.closeSync()
    } catch {
      warnings.push(`${warningLabel(root)} 目录关闭失败`)
    }
  }

  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  let totalBytes = 0
  for (const entry of entries) {
    const p = join(rootReal, entry.name)
    let kind: RawSkill['kind'] | null = null
    let name: string | null = null
    let file = p
    try {
      const entryStat = lstatSync(p)
      if (entryStat.isDirectory() || entryStat.isSymbolicLink()) {
        name = skillNameFromDir(entry.name)
        if (name) {
          kind = 'bundle'
          file = join(p, 'SKILL.md')
        }
      }
      if (kind === null && entry.name.endsWith('.md') && (entryStat.isFile() || entryStat.isSymbolicLink())) {
        name = skillNameFromDir(entry.name.slice(0, -3))
        if (name) kind = 'flat'
      }
      if (!kind || !name) continue

      const read = readScanFile(file, rootReal, limits.maxTotalBytesPerRoot - totalBytes, limits.maxFileBytes)
      totalBytes += read.bytes
      const { meta, body } = parseSkillFile(read.text)
      const directShape = !entryStat.isSymbolicLink()
        && !read.symbolic
        && (kind === 'bundle'
          ? basename(read.real) === 'SKILL.md' && basename(dirname(read.real)) === name
          : basename(read.real) === `${name}.md`)
      out.push({
        name,
        description: typeof meta.description === 'string' ? meta.description : '',
        whenToUse: typeof meta.whenToUse === 'string' ? meta.whenToUse : undefined,
        modelInvocable: meta['disable-model-invocation'] !== true,
        userInvocable: meta['user-invocable'] !== false,
        source: root.source,
        rootSlot: root.slot,
        root: rootReal,
        path: file,
        kind,
        canToggle: directShape && (root.source === 'user-dsh' || root.source === 'user-agents'),
        body,
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误'
      warnings.push(`${warningLabel(root, entry.name)} 扫描失败，已跳过：${detail}`)
    }
  }
}

function opaqueSkillId(skill: Pick<RawSkill, 'source' | 'rootSlot' | 'kind' | 'name'>): string {
  const identity = JSON.stringify([skill.source, skill.rootSlot, skill.kind, skill.name])
  return `skill-v1.${Buffer.from(identity).toString('base64url')}`
}

/** 扫描全部 skill 根并返回可展示 warnings；低 rank 优先，同 root 同名 bundle 优先于 flat。 */
export function scanSkillsDetailed(opts: SkillScanOptions = {}): SkillScanResult {
  const dshHome = opts.dshHome ?? join(homedir(), '.dsh')
  const agentsHome = opts.agentsHome ?? join(homedir(), '.agents')
  const roots: SkillRoot[] = []
  if (opts.projectRoot) {
    roots.push({ dir: join(opts.projectRoot, '.dsh', 'skills'), source: 'project-dsh', slot: 0 })
    roots.push({ dir: join(opts.projectRoot, '.agents', 'skills'), source: 'project-agents', slot: 0 })
  }
  for (const [slot, dir] of (opts.customDirs ?? []).entries()) roots.push({ dir, source: 'custom', slot })
  roots.push({ dir: join(dshHome, 'skills'), source: 'user-dsh', slot: 0 })
  roots.push({ dir: join(agentsHome, 'skills'), source: 'user-agents', slot: 0 })
  if (opts.bundledDir) roots.push({ dir: opts.bundledDir, source: 'bundled', slot: 0 })

  const all: RawSkill[] = []
  const warnings: string[] = []
  const limits = scanLimits(opts.limits)
  for (const root of roots) scanRoot(root, all, warnings, limits)

  all.sort((a, b) =>
    a.name.localeCompare(b.name)
    || RANK[a.source] - RANK[b.source]
    || a.rootSlot - b.rootSlot
    || (a.kind === b.kind ? 0 : a.kind === 'bundle' ? -1 : 1),
  )

  // Hub 冲突展示规则：低 rank 先胜；同 root 同名时 bundle 稳定优先于 flat。
  const winner = new Map<string, RawSkill>()
  for (const s of all) {
    if (!winner.has(s.name)) winner.set(s.name, s)
  }
  return {
    warnings,
    skills: all.map((s) => ({
      id: opaqueSkillId(s),
      name: s.name,
      description: s.description,
      whenToUse: s.whenToUse,
      modelInvocable: s.modelInvocable,
      userInvocable: s.userInvocable,
      source: s.source,
      root: s.root,
      path: s.path,
      kind: s.kind,
      shadowed: winner.get(s.name) !== s,
      canToggle: s.canToggle,
      bodyPreview: s.body.slice(0, 120),
    })),
  }
}

/** Compatibility projection for core callers that only need summaries. */
export function scanSkills(opts: SkillScanOptions = {}): SkillSummary[] {
  return scanSkillsDetailed(opts).skills
}

/** Fresh-scan an opaque identity. Zero or duplicate matches both fail closed. */
export function resolveSkillIdentity(opts: SkillScanOptions, identity: SkillIdentity): SkillSummary {
  const matches = scanSkillsDetailed(opts).skills.filter((skill) =>
    skill.id === identity.id
    && skill.source === identity.source
    && skill.kind === identity.kind,
  )
  if (matches.length !== 1) throw new Error(`skill opaque id 未唯一匹配（count=${matches.length}）`)
  return matches[0]
}

/** 组装带 frontmatter 的 SKILL.md 文本 */
export function renderSkillFile(input: {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  body: string
}): string {
  const meta: Record<string, unknown> = { name: input.name, description: input.description }
  if (input.whenToUse) meta.whenToUse = input.whenToUse
  if (!input.modelInvocable) meta['disable-model-invocation'] = true
  if (!input.userInvocable) meta['user-invocable'] = false
  const body = input.body.replace(/^\n+/, '').replace(/\s+$/, '') + '\n'
  return `---\n${stringify(meta).trimEnd()}\n---\n${body}`
}

interface AtomicWriteDependencies {
  rename?: typeof renameSync
  remove?: typeof rmSync
}

function siblingArtifact(path: string, kind: 'tmp' | 'old'): string {
  writeArtifactSequence += 1
  return join(dirname(path), `.${basename(path)}.${kind}-${process.pid}-${Date.now()}-${writeArtifactSequence}`)
}

function aggregateFailure(primary: unknown, secondary: unknown, message: string): unknown {
  return new AggregateError([primary, secondary], message)
}

function removeAfterFailure(
  path: string,
  primary: unknown,
  message: string,
  remove: typeof rmSync = rmSync,
): unknown {
  try {
    remove(path, { recursive: true, force: true })
    return primary
  } catch (cleanupError) {
    return aggregateFailure(primary, cleanupError, message)
  }
}

function isReplaceConflict(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  return code === 'EEXIST' || code === 'EPERM' || code === 'EACCES'
}

function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // HTTP 状态才是主诊断；取消失败不能覆盖它。
  }
}

/** 同目录写完整临时文件后替换，避免覆盖写中途把原文件截断。 */
export function writeSkillFileAtomically(
  path: string,
  text: string,
  dependencies: AtomicWriteDependencies = {},
): void {
  const replace = dependencies.rename ?? renameSync
  const remove = dependencies.remove ?? rmSync
  const mode = statSync(path).mode & 0o7777
  const temp = siblingArtifact(path, 'tmp')
  let failure: unknown
  let committed = false

  try {
    writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx', mode })
    chmodSync(temp, mode)
    try {
      replace(temp, path)
      committed = true
    } catch (error) {
      if (!isReplaceConflict(error) || !existsSync(path)) throw error

      // Windows 不能直接 rename 覆盖已有文件：旧文件先移到同目录备份，替换失败则恢复。
      const backup = siblingArtifact(path, 'old')
      try {
        replace(path, backup)
      } catch (backupError) {
        throw aggregateFailure(error, backupError, `无法备份原 skill 文件: ${path}`)
      }
      try {
        replace(temp, path)
        committed = true
      } catch (replaceError) {
        try {
          replace(backup, path)
        } catch (rollbackError) {
          throw aggregateFailure(replaceError, rollbackError, `替换失败且无法恢复原 skill 文件: ${path}`)
        }
        throw replaceError
      }
      try {
        remove(backup, { force: true })
      } catch {
        // 新文件已提交；保留隐藏 recovery artifact 比向调用方假报失败更安全。
      }
    }
  } catch (error) {
    failure = error
  }

  try {
    remove(temp, { force: true })
  } catch (cleanupError) {
    if (!committed) {
      failure = failure
        ? aggregateFailure(failure, cleanupError, `写入失败且无法清理临时 skill 文件: ${path}`)
        : cleanupError
    }
  }
  if (failure) throw failure
}

/** 在指定根目录创建 bundle skill（<name>/SKILL.md） */
export function createSkill(opts: {
  root: string
  name: string
  description: string
  body: string
  whenToUse?: string
  modelInvocable?: boolean
  userInvocable?: boolean
  overwrite?: boolean
}): string {
  const name = opts.name.trim()
  if (!KEBAB.test(name)) throw new Error(`skill 名称必须是 kebab-case: ${name}`)
  const dir = join(opts.root, name)
  const file = join(dir, 'SKILL.md')
  const text = renderSkillFile({
    name,
    description: opts.description,
    whenToUse: opts.whenToUse,
    modelInvocable: opts.modelInvocable ?? true,
    userInvocable: opts.userInvocable ?? true,
    body: opts.body,
  })
  if (Buffer.byteLength(text, 'utf8') > MAX_SKILL_FILE_BYTES) {
    throw new Error(`SKILL.md 超过 ${MAX_SKILL_FILE_BYTES} 字节上限`)
  }
  mkdirSync(dir, { recursive: true })
  if (opts.overwrite) {
    // 目标可能在 exists-check 后由另一个创建者出现/消失；两种原子写法间有限重试。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (existsSync(file)) {
        try {
          writeSkillFileAtomically(file, text)
          return file
        } catch (error) {
          if (errorCode(error) === 'ENOENT') continue
          throw error
        }
      }
      try {
        writeFileSync(file, text, { flag: 'wx' })
        return file
      } catch (error) {
        if (errorCode(error) === 'EEXIST') continue
        throw error
      }
    }
    throw new Error(`skill 在并发写入中持续变化，无法安全覆盖: ${name}`)
  } else {
    try {
      writeFileSync(file, text, { flag: 'wx' })
    } catch (error) {
      if (errorCode(error) === 'EEXIST') throw new Error(`skill 已存在: ${name}`, { cause: error })
      throw error
    }
  }
  return file
}

/** frontmatter 缺 name 时的回退名：bundle（SKILL.md）取目录名，扁平（<name>.md）取文件名 */
function fallbackSkillName(path: string): string {
  const base = basename(path)
  if (base === 'SKILL.md') return dirname(path).split(/[\\/]/).pop() ?? ''
  if (base.endsWith('.md')) return base.slice(0, -3)
  return ''
}

function parseFrontmatterDocument(text: string): {
  doc: ReturnType<typeof parseDocument>
  meta: Record<string, unknown>
  body: string
} {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) throw new Error('skill 文件缺少 frontmatter')
  const doc = parseDocument(match[1])
  if (doc.errors.length > 0) throw new Error(`frontmatter 解析失败: ${doc.errors[0].message}`)
  if (doc.contents !== null && !isMap(doc.contents)) throw new Error('frontmatter 必须是 YAML mapping')
  return { doc, meta: (doc.toJS() ?? {}) as Record<string, unknown>, body: match[2] }
}

function canonicalizeImportedSkillFile(text: string, fallbackName: string): { name: string; text: string } {
  const { doc, meta, body } = parseFrontmatterDocument(text)
  const name = typeof meta.name === 'string' && KEBAB.test(meta.name)
    ? meta.name
    : KEBAB.test(fallbackName) ? fallbackName : ''
  if (!name) {
    throw new Error(
      `frontmatter 必须包含合法的 kebab-case name，且没有合法目录名可回退: ${JSON.stringify(meta.name)}`,
    )
  }
  doc.setIn(['name'], name)
  const canonicalText = `---\n${doc.toString().trimEnd()}\n---\n${body}`
  if (Buffer.byteLength(canonicalText, 'utf8') > MAX_ENTRY_SIZE) {
    throw new Error(`规范化后的 SKILL.md 超过单文件上限 ${MAX_ENTRY_SIZE} 字节`)
  }
  return { name, text: canonicalText }
}

/** 切换可见性并回写文件（model 可见 = 移除 disable-model-invocation）
 * 只修改 frontmatter 的目标字段（YAML AST 级），保留其余元数据与正文原样。 */
export function setInvocation(path: string, kind: 'model' | 'user', value: boolean): string {
  const text = readFileSync(path, 'utf8')
  const { doc, meta, body } = parseFrontmatterDocument(text)
  const name = typeof meta.name === 'string' && KEBAB.test(meta.name) ? meta.name : fallbackSkillName(path)
  if (!KEBAB.test(name)) throw new Error(`无法确定合法的 kebab-case skill 名称: ${JSON.stringify(name)}`)
  if (meta.name !== name) doc.setIn(['name'], name)
  const key = kind === 'model' ? 'disable-model-invocation' : 'user-invocable'
  if (value) doc.deleteIn([key])
  // disable-model-invocation: true 与 user-invocable: false 都是「关闭」语义
  else doc.setIn([key], kind === 'model' ? true : false)
  const next = `---\n${doc.toString().trimEnd()}\n---\n${body}`
  writeSkillFileAtomically(path, next)
  return next
}

export interface SkillImportResult {
  name: string
  file: string
  installed: string[]
}

/**
 * 校验并规整 zip 内相对路径。
 * 拒绝：`..` segment、绝对路径（`/` 或盘符 `C:`）、UNC、NUL 字节、空路径。
 * 返回以 `/` 分隔的相对 segments；非法返回 null（调用方整体拒绝该包）。
 */
function safeZipRelPath(entryName: string): string | null {
  const norm = entryName.replace(/\\/g, '/')
  if (norm.includes('\0')) return null
  if (norm.startsWith('/')) return null
  if (/^[A-Za-z]:/.test(norm)) return null
  const parts = norm.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.some((p) => p === '..')) return null
  if (parts.length === 0) return null
  return parts.join('/')
}

/** 校验整包限额与路径合法性（在解压任何内容之前执行） */
function validateZipEntries(entries: AdmZip.IZipEntry[]): void {
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error(`压缩包条目数 ${entries.length} 超过上限 ${MAX_ZIP_ENTRIES}`)
  }
  let total = 0
  for (const e of entries) {
    if (e.isDirectory) continue
    if (safeZipRelPath(e.entryName) === null) {
      throw new Error(`压缩包包含非法路径（拒绝 .. / 绝对路径 / NUL）: ${JSON.stringify(e.entryName)}`)
    }
    const size = e.header.size
    if (!Number.isFinite(size) || size < 0) throw new Error(`压缩包条目大小异常: ${e.entryName}`)
    if (size > MAX_ENTRY_SIZE) throw new Error(`文件 ${e.entryName} 超过单文件上限 ${MAX_ENTRY_SIZE} 字节`)
    total += size
    if (total > MAX_TOTAL_SIZE) throw new Error(`解压总量超过上限 ${MAX_TOTAL_SIZE} 字节`)
  }
}

interface InstallDependencies {
  rename?: typeof renameSync
  remove?: typeof rmSync
}

/** 把已解压到 tmpDir 的包原子装入 target；覆盖时旧目录先改名再替换，失败回滚。 */
export function installExtracted(
  tmpDir: string,
  target: string,
  overwrite: boolean,
  dependencies: InstallDependencies = {},
): void {
  const move = dependencies.rename ?? renameSync
  const remove = dependencies.remove ?? rmSync
  if (!existsSync(target)) {
    move(tmpDir, target)
    return
  }
  if (!overwrite) {
    const error = new Error(`skill 已存在: ${basename(target)}（如需覆盖请再次确认）`)
    throw removeAfterFailure(tmpDir, error, `skill 已存在且无法清理临时导入目录: ${target}`, remove)
  }
  const backup = siblingArtifact(target, 'old')
  move(target, backup)
  try {
    move(tmpDir, target)
  } catch (err) {
    let failure = err
    try {
      move(backup, target)
    } catch (rollbackError) {
      failure = aggregateFailure(failure, rollbackError, `导入替换失败且无法恢复原 skill: ${target}`)
    }
    throw removeAfterFailure(tmpDir, failure, `导入替换失败且无法清理临时目录: ${target}`, remove)
  }
  try {
    remove(backup, { recursive: true, force: true })
  } catch {
    // 新目录已提交；保留隐藏 recovery artifact，不能把成功安装假报为失败。
  }
}

function writeBundleFromZip(zip: AdmZip, sourceDir: string, root: string, overwrite: boolean): SkillImportResult {
  validateZipEntries(zip.getEntries())
  const entries = zip.getEntries()
  const prefix = sourceDir ? `${sourceDir.replace(/\/$/, '')}/` : ''
  const files = entries
    .filter((e) => !e.isDirectory)
    .map((entry) => ({ entry, path: safeZipRelPath(entry.entryName)! }))
  const sourceFiles = files.filter((file) => file.path.startsWith(prefix))
  const skillFile = sourceFiles.find((file) => file.path === `${prefix}SKILL.md`)
    ?? sourceFiles.find((file) => file.path.endsWith('/SKILL.md'))
  if (!skillFile) throw new Error('压缩包中未找到 SKILL.md，不是有效的 skill 包')
  const { entry: skillEntry, path: skillPath } = skillFile
  const skillDir = skillPath === 'SKILL.md' ? '' : skillPath.slice(0, -'/SKILL.md'.length)
  const dirName = skillDir.split('/').pop() ?? ''
  const text = skillEntry.getData().toString('utf8')
  let canonical: { name: string; text: string }
  try {
    canonical = canonicalizeImportedSkillFile(text, dirName)
  } catch (error) {
    const label = skillDir === '' ? '压缩包根目录 SKILL.md' : `压缩包 ${skillPath}`
    throw new Error(`${label} 无效: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  const { name } = canonical
  const target = join(root, name)

  // 先在同文件系统的临时目录完整解压并校验，全部成功后原子替换（rename 跨文件系统会 EXDEV）
  mkdirSync(root, { recursive: true })
  const tmpDir = mkdtempSync(join(dirname(root), '.dsh-skill-import-'))
  const installed: string[] = []
  try {
    for (const { entry: e, path: norm } of files) {
      if (skillDir && !norm.startsWith(skillDir + '/')) continue
      const rel = safeZipRelPath(skillDir ? norm.slice(skillDir.length + 1) : norm)!
      if (!rel) continue
      const dest = resolve(tmpDir, rel)
      // 越界判定用 relative()：Windows 上 resolve 产物是反斜杠路径，直接 startsWith(前缀+'/') 会永不匹配
      const relToTmp = relative(tmpDir, dest)
      if (relToTmp.startsWith('..') || isAbsolute(relToTmp)) {
        throw new Error(`解压路径越界: ${e.entryName}`)
      }
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, rel === 'SKILL.md' ? canonical.text : e.getData())
      installed.push(join(target, rel))
    }
    const targetSkill = join(target, 'SKILL.md')
    if (!existsSync(join(tmpDir, 'SKILL.md'))) throw new Error('skill 包缺少 SKILL.md')
    installExtracted(tmpDir, target, overwrite)
    return { name, file: targetSkill, installed }
  } catch (err) {
    throw removeAfterFailure(tmpDir, err, `skill 导入失败且无法清理临时目录: ${target}`)
  }
}

/** 从 zip 容器（.skill 或 .zip）导入 skill 包；支持根/单层子目录含 SKILL.md */
export function importSkillFromZip(buffer: Buffer, opts: { root: string; overwrite?: boolean }): SkillImportResult {
  const zip = new AdmZip(buffer)
  validateZipEntries(zip.getEntries())
  const entries = zip.getEntries()
  const hasSkill = entries.some((e) => {
    if (e.isDirectory) return false
    const rel = safeZipRelPath(e.entryName)
    return rel === 'SKILL.md' || rel?.endsWith('/SKILL.md')
  })
  if (!hasSkill) throw new Error('压缩包中未找到 SKILL.md，不是有效的 skill 包（.skill 或含 SKILL.md 的 zip）')
  // 根级 SKILL.md 不是包裹目录；其同级资源全部属于该 skill。
  const hasRootSkill = entries.some((e) => !e.isDirectory && safeZipRelPath(e.entryName) === 'SKILL.md')
  if (hasRootSkill) return writeBundleFromZip(zip, '', opts.root, opts.overwrite ?? false)
  // 若 zip 顶层是单一包裹目录（{repo}-{branch}/），自动剥掉
  const topLevels = new Set(
    entries
      .filter((e) => !e.isDirectory)
      .map((e) => safeZipRelPath(e.entryName)!.split('/')[0]),
  )
  if (topLevels.size === 1) {
    return writeBundleFromZip(zip, [...topLevels][0], opts.root, opts.overwrite ?? false)
  }
  return writeBundleFromZip(zip, '', opts.root, opts.overwrite ?? false)
}

export interface GitHubUrl {
  owner: string
  repo: string
  branch: string
  subPath: string
}

/** 解析 GitHub skill 仓库链接（支持 /tree/<branch>/<path> 与根仓库） */
export function parseGitHubSkillUrl(url: string): GitHubUrl {
  const m = url.trim().match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/|$)/)
  if (!m) throw new Error(`不是有效的 GitHub 链接: ${url}`)
  const rest = url.trim().slice(m[0].length)
  if (!rest) return { owner: m[1], repo: m[2], branch: 'main', subPath: '' }
  const tree = rest.match(/^tree\/([^/]+)(?:\/(.*))?$/)
  if (tree) return { owner: m[1], repo: m[2], branch: tree[1], subPath: tree[2] ?? '' }
  const blob = rest.match(/^blob\/([^/]+)\/(.+)\.md$/)
  if (blob) return { owner: m[1], repo: m[2], branch: blob[1], subPath: blob[2] }
  throw new Error(`暂不支持该 GitHub 路径（支持仓库根或 /tree/<branch>/<path>）: ${url}`)
}

/** 从 GitHub 仓库下载并导入 skill（codeload zip → 定位 SKILL.md → 安装） */
export async function importSkillFromGitHub(
  url: string,
  opts: { root: string; overwrite?: boolean },
): Promise<SkillImportResult> {
  const { owner, repo, branch, subPath } = parseGitHubSkillUrl(url)
  const candidates = [branch, branch === 'main' ? 'master' : branch].filter((v, i, a) => a.indexOf(v) === i)
  let buffer: Buffer | null = null
  for (const ref of candidates) {
    const url = `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${encodeURIComponent(ref)}`
    for (let attempt = 0; attempt < 3 && !buffer; attempt++) {
      try {
        const dl = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
        if (!dl.ok) {
          await cancelResponseBody(dl)
          continue
        }
        const data = Buffer.from(await readResponseBytes(
          dl,
          MAX_DOWNLOAD_SIZE,
          `仓库压缩包超过下载上限 ${MAX_DOWNLOAD_SIZE} 字节`,
        ))
        buffer = data
      } catch (err) {
        // 网络瞬时失败或超过上限，重试/终止
        if (err instanceof Error && err.message.includes('下载上限')) throw err
      }
    }
    if (buffer) break
  }
  if (!buffer) throw new Error(`下载失败：仓库 ${owner}/${repo} 分支 ${branch} 不存在或不可访问`)
  const zip = new AdmZip(buffer)
  validateZipEntries(zip.getEntries())
  const entries = zip.getEntries()
  const top = entries
    .filter((e) => !e.isDirectory)
    .map((e) => safeZipRelPath(e.entryName)?.split('/')[0] ?? '')
    .filter(Boolean)
  const topLevel = [...new Set(top)][0] ?? ''
  const sourceDir = [topLevel, subPath].filter(Boolean).join('/')
  return writeBundleFromZip(zip, sourceDir, opts.root, opts.overwrite ?? false)
}

function validClawHubPart(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)
}

/** 从 ClawHub 的公开 file API 导入固定版本的 SKILL.md。
 * ClawHub 的公开读取接口对辅助文件没有稳定的匿名打包接口，因此当前只落地其规范入口文件，
 * 不执行 skill 中的脚本；需要辅助文件的 Skill 仍应从 SkillsMP 的 GitHub source 安装。 */
export async function importSkillFromClawHub(
  input: { owner: string; slug: string; version?: string },
  opts: { root: string; overwrite?: boolean },
): Promise<SkillImportResult> {
  const owner = input.owner.trim()
  const slug = input.slug.trim()
  if (!validClawHubPart(owner) || !validClawHubPart(slug)) throw new Error('ClawHub owner/slug 无效')
  const apiBase = `https://clawhub.ai/api/v1/skills/${encodeURIComponent(slug)}`
  let version = input.version?.trim() || 'latest'
  if (version === 'latest') {
    const detailResponse = await fetch(`${apiBase}?owner=${encodeURIComponent(owner)}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'DSH-Desktop-Hub/0.2' },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    })
    if (!detailResponse.ok) {
      await cancelResponseBody(detailResponse)
      throw new Error(`ClawHub skill 元数据请求失败（HTTP ${detailResponse.status}）`)
    }
    const detail = JSON.parse(await readResponseText(
      detailResponse,
      MAX_CLAWHUB_METADATA_SIZE,
      `ClawHub skill 元数据超过大小上限 ${MAX_CLAWHUB_METADATA_SIZE} 字节`,
    )) as { latestVersion?: { version?: unknown } } | null
    const resolved = detail?.latestVersion?.version
    if (typeof resolved !== 'string' || !resolved.trim()) throw new Error('ClawHub 没有返回可安装版本')
    version = resolved.trim()
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(version)) throw new Error('ClawHub skill 版本无效')
  const fileUrl = `${apiBase}/file?owner=${encodeURIComponent(owner)}&path=SKILL.md&version=${encodeURIComponent(version)}`
  const response = await fetch(fileUrl, {
    headers: { Accept: 'text/markdown, text/plain', 'User-Agent': 'DSH-Desktop-Hub/0.2' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  })
  if (!response.ok) {
    await cancelResponseBody(response)
    throw new Error(`ClawHub SKILL.md 下载失败（HTTP ${response.status}）`)
  }
  const text = await readResponseText(response, MAX_ENTRY_SIZE, `SKILL.md 超过单文件上限 ${MAX_ENTRY_SIZE} 字节`)
  if (!text.trim() || text.includes('\0') || text.length > MAX_ENTRY_SIZE) throw new Error('ClawHub SKILL.md 内容无效或超过大小上限')
  let canonical: { name: string; text: string }
  try {
    canonical = canonicalizeImportedSkillFile(text, slug)
  } catch (error) {
    throw new Error(`ClawHub SKILL.md 无效: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  const { name } = canonical
  const target = join(opts.root, name)
  mkdirSync(opts.root, { recursive: true })
  const tmpParent = mkdtempSync(join(dirname(opts.root), '.dsh-clawhub-'))
  const tmpSkill = join(tmpParent, name)
  let result: SkillImportResult | undefined
  let failure: unknown
  try {
    mkdirSync(tmpSkill, { recursive: true })
    writeFileSync(join(tmpSkill, 'SKILL.md'), canonical.text)
    installExtracted(tmpSkill, target, opts.overwrite ?? false)
    result = { name, file: join(target, 'SKILL.md'), installed: [join(target, 'SKILL.md')] }
  } catch (error) {
    failure = error
  }
  try {
    rmSync(tmpParent, { recursive: true, force: true })
  } catch (cleanupError) {
    if (failure) {
      failure = aggregateFailure(failure, cleanupError, `ClawHub 导入失败且无法清理临时目录: ${target}`)
    }
    // result 存在表示安装已提交；此时保留空临时目录，不能假报导入失败。
  }
  if (failure) throw failure
  return result!
}
