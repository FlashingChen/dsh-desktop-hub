// Plugin 系统核心：profile 插件清单解析 + dsh plugin 命令封装
import { readFileSync } from 'node:fs'
import { isMap, isScalar, stringify } from 'yaml'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { createHash } from 'node:crypto'
import type { DshProfile } from './harness.js'
import { isPlainObject, normalizePackageName, stopTree } from './harness.js'
import { planDshSpawn, type DshSpawnPlan, type DshSpawnPlanDependencies } from './dsh-spawn.js'
import { approveIgnoredBuilds, parseBuildApprovalKeys } from './pnpm.js'
import { parseProfilePatch } from './mcp.js'

export { approveIgnoredBuilds, parseBuildApprovalKeys, parseIgnoredBuildPackages } from './pnpm.js'

export interface PluginEntry {
  name: string
  /** dependencies 中的 spec（如版本号或 link:/path） */
  spec: string
  /** 是否在 dsh.profile.bundles（作为组合包激活） */
  inBundles: boolean
  /** 当前是否处于激活状态（bundle 或 patch 任一来源） */
  active: boolean
  /** 激活来源：bundle = 组合包自带；patch = 用户 patch 手动激活；none = 未激活 */
  activationSource: 'bundle' | 'patch' | 'none'
  /** @deepseek-ai/* 内置包 */
  builtin: boolean
  source: 'builtin-bundle' | 'bundle' | 'dependency'
}

export const ROUTING_SUITE_REPOSITORY = 'github:yjh051108/dsh-routing-suite'
const PLUGIN_PATCH_ID_MAX_LENGTH = 128
const PLUGIN_PATCH_HASH_LENGTH = 16

export interface InstallSpecPlan {
  kind: 'plugin' | 'routing-suite'
  normalized: string
  message?: string
}

/** 从 profile package.json 解析插件清单：bundles ∪ dependencies。
 * 传入 patch 文本时计算真实激活来源（bundle / patch / none）。 */
export function listPlugins(profile: DshProfile, patchText?: string, options: {
  onWarning?: (message: string) => void
} = {}): PluginEntry[] {
  const warn = options.onWarning ?? ((message: string) => console.warn(`[plugins] ${message}`))
  let pkg: unknown
  try {
    pkg = JSON.parse(readFileSync(join(profile.dir, 'package.json'), 'utf8'))
  } catch (error) {
    throw new Error(`profile「${profile.name}」package.json 读取或解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isPlainObject(pkg)) throw new Error(`profile「${profile.name}」package.json 顶层必须是普通对象`)

  const deps = new Map<string, string>()
  const collectDependencies = (field: 'dependencies' | 'devDependencies'): void => {
    const value = pkg[field]
    if (value === undefined) return
    if (!isPlainObject(value)) {
      throw new Error(`profile「${profile.name}」package.json 的 ${field} 必须是普通对象`)
    }
    for (const [rawName, rawSpec] of Object.entries(value)) {
      const name = normalizePackageName(rawName)
      if (!name) {
        warn(`profile「${profile.name}」忽略 ${field} 中的非法包名「${rawName}」`)
        continue
      }
      if (typeof rawSpec !== 'string') {
        warn(`profile「${profile.name}」忽略 ${field}.${rawName}：spec 必须是非空字符串`)
        continue
      }
      const spec = rawSpec.trim()
      if (!spec || /[\0\r\n]/.test(spec)) {
        warn(`profile「${profile.name}」忽略 ${field}.${rawName}：spec 必须是合法的非空字符串`)
        continue
      }
      // 与原来的 object spread 一致：devDependencies 中的同名合法项覆盖 dependencies。
      deps.set(name, spec)
    }
  }
  collectDependencies('dependencies')
  collectDependencies('devDependencies')

  const bundles = new Set<string>()
  const rawBundles: unknown = profile.bundles
  if (!Array.isArray(rawBundles)) {
    warn(`profile「${profile.name}」忽略非法 bundles：必须是数组`)
  } else {
    for (const [index, rawName] of rawBundles.entries()) {
      const name = normalizePackageName(rawName)
      if (!name) {
        warn(`profile「${profile.name}」忽略非法 bundle[${index}]：必须是合法的非空包名字符串`)
        continue
      }
      bundles.add(name)
    }
  }
  const names = new Set([...deps.keys(), ...bundles])
  return [...names]
    .map((name): PluginEntry => {
      const spec = deps.get(name) ?? ''
      const inBundles = bundles.has(name)
      const builtin = name.startsWith('@deepseek-ai/')
      const source: PluginEntry['source'] = inBundles ? (builtin ? 'builtin-bundle' : 'bundle') : 'dependency'
      const patchActive = patchText !== undefined && isPluginActive(patchText, name)
      const activationSource: PluginEntry['activationSource'] = inBundles
        ? 'bundle'
        : patchActive
          ? 'patch'
          : 'none'
      return { name, spec, inBundles, active: activationSource !== 'none', activationSource, builtin, source }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

function unwrapPatchValue(value: unknown): unknown {
  if (isScalar(value)) return value.value
  return value
}

function patchRowField(row: unknown, key: string): unknown {
  if (!isMap(row)) return undefined
  return unwrapPatchValue(row.items.find((pair) => unwrapPatchValue(pair.key) === key)?.value)
}

/** 生成 profile patch 中稳定、合法的插件行 id。 */
export function pluginPatchId(name: string): string {
  const id = name.replace(/^@/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return (id || 'plugin').slice(0, PLUGIN_PATCH_ID_MAX_LENGTH)
}

function patchRowId(row: unknown): string | null {
  const value = patchRowField(row, 'id')
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

/** 顶层 map 和所有 insert row 的 id 都占用命名空间；重复/畸形行保持原样但绝不被复用。 */
function occupiedPatchIds(parsed: ReturnType<typeof parseProfilePatch>): Set<string> {
  const ids = new Set<string>()
  for (const entry of parsed.contents?.items ?? []) {
    const id = patchRowId(entry)
    if (id !== null) ids.add(id)
  }
  for (const sequence of parsed.insertSequences) {
    for (const row of sequence.items) {
      const id = patchRowId(row)
      if (id !== null) ids.add(id)
    }
  }
  return ids
}

function suffixedPluginPatchId(base: string, suffix: string): string {
  const stemLength = Math.max(1, PLUGIN_PATCH_ID_MAX_LENGTH - suffix.length - 1)
  return `${base.slice(0, stemLength)}-${suffix}`
}

/** 碰撞时以原始包名的 SHA-256 前缀稳定消歧；极小概率再碰撞时按顺序追加计数。 */
function availablePluginPatchId(base: string, name: string, occupied: ReadonlySet<string>): string {
  if (!occupied.has(base)) return base
  const hash = createHash('sha256').update(name, 'utf8').digest('hex').slice(0, PLUGIN_PATCH_HASH_LENGTH)
  const hashed = suffixedPluginPatchId(base, hash)
  if (!occupied.has(hashed)) return hashed
  for (let counter = 2; ; counter += 1) {
    const candidate = suffixedPluginPatchId(base, `${hash}-${counter}`)
    if (!occupied.has(candidate)) return candidate
  }
}

/** 判断插件是否已经通过 cordis.patch.yml 的 insert 层激活。 */
export function isPluginActive(patchText: string, name: string): boolean {
  const parsed = parseProfilePatch(patchText)
  return parsed.insertSequences.some((sequence) => sequence.items.some((row) => patchRowField(row, 'name') === name))
}

/** 向 patch 的 insert 层激活已安装插件；重复激活保持幂等。 */
export function activatePlugin(patchText: string, name: string, id = pluginPatchId(name)): string {
  const parsed = parseProfilePatch(patchText)
  const sequences = parsed.insertSequences
  if (sequences.some((sequence) => sequence.items.some((row) => patchRowField(row, 'name') === name))) return patchText
  const baseId = pluginPatchId(id)
  const row = { id: availablePluginPatchId(baseId, name, occupiedPatchIds(parsed)), name }
  const target = sequences[0]
  if (target) {
    target.items.push(parsed.doc.createNode(row))
    return parsed.doc.toString()
  }
  const fresh = parseProfilePatch(stringify([{ insert: [row] }]))
  if (!parsed.contents) {
    ;(parsed.doc as { contents: unknown }).contents = fresh.contents
    return parsed.doc.toString()
  }
  if (!fresh.contents) throw new Error('插件行序列化失败')
  parsed.contents.items.push(...fresh.contents.items)
  return parsed.doc.toString()
}

/** 从 patch 的 insert 层停用插件，但不卸载 package 依赖。 */
export function deactivatePlugin(patchText: string, name: string): string {
  const parsed = parseProfilePatch(patchText)
  let removed = 0
  for (const sequence of parsed.insertSequences) {
    const keep = sequence.items.filter((row) => {
      const matches = patchRowField(row, 'name') === name
      if (matches) removed += 1
      return !matches
    })
    sequence.items.length = 0
    sequence.items.push(...keep)
  }
  if (removed === 0) throw new Error(`插件未激活: ${name}`)
  return parsed.doc.toString()
}

/** 幂等停用：patch 中存在该插件的激活行则移除，否则原样返回（不 throw）。
 * 供「dsh plugin remove 成功后清理残留激活行」使用——避免重启后引用不存在的插件。 */
export function deactivatePluginIfActive(patchText: string, name: string): string {
  const parsed = parseProfilePatch(patchText)
  let removed = 0
  for (const sequence of parsed.insertSequences) {
    const keep = sequence.items.filter((row) => {
      const matches = patchRowField(row, 'name') === name
      if (matches) removed += 1
      return !matches
    })
    sequence.items.length = 0
    sequence.items.push(...keep)
  }
  return removed === 0 ? patchText : parsed.doc.toString()
}

/** 构造 dsh plugin 子命令 argv（纯函数，便于单测） */
export function buildPluginCommand(
  profile: string,
  action: 'add' | 'remove' | 'update',
  args: string[] = [],
): string[] {
  return ['plugin', '--profile', profile, action, ...args]
}

/**
 * 归一化安装 spec：支持直接粘贴 GitHub 链接。
 * - https://github.com/owner/repo 或 github.com/owner/repo → github:owner/repo
 * - https://github.com/owner/repo.git       → github:owner/repo
 * - https://github.com/owner/repo/tree/main → github:owner/repo#main
 * - https://github.com/owner/repo/commit/x  → github:owner/repo#x（commit 锁定）
 * - 已是 github:owner/repo 或 npm 包名/本地路径 → 原样返回
 */
export function normalizeInstallSpec(spec: string): string {
  const s = spec.trim()
  // 手动输入框允许用户粘贴浏览器地址，也允许省略协议；两者必须在进入 CLI 前归一化。
  const m = s.match(/^(?:(?:https?:[/][/]))?(?:www[.])?github[.]com[/]([A-Za-z0-9_.-]+)[/]([A-Za-z0-9_.-]+?)(?:[.]git)?(?:[/]|[?#]|$)/i)
  if (!m) return s
  const owner = m[1]
  const repo = m[2]
  const rest = s.slice(m[0].length).replace(/[?#].*$/, '').replace(/^[/]+|[/]+$/g, '')
  if (!rest) return `github:${owner}/${repo}`
  const tree = rest.match(/^tree[/](.+)$/i)
  if (tree) return `github:${owner}/${repo}#${tree[1]}`
  const commit = rest.match(/^commit[/]([0-9a-fA-F]{7,40})$/i)
  if (commit) return `github:${owner}/${repo}#${commit[1]}`
  return `github:${owner}/${repo}`
}

/** 识别不能直接交给 dsh plugin 的 Routing Suite 聚合仓库。 */
export function classifyInstallSpec(spec: string): InstallSpecPlan {
  const normalized = normalizeInstallSpec(spec)
  if (normalized === ROUTING_SUITE_REPOSITORY || normalized.startsWith(`${ROUTING_SUITE_REPOSITORY}#`)) {
    return {
      kind: 'routing-suite',
      normalized,
      message:
        'Routing Suite 是安装套装，不是 DSH bundle：仓库根目录没有 package.json/dsh.bundle。请单独安装 github:yjh051108/dsh-super-injector，再把 dsh-router-standard/preset/router-standard 复制到 $DSH_HOME/.agent-presets/router-standard；mode-boost 需按其 README 单独装配。',
    }
  }
  return { kind: 'plugin', normalized }
}


export interface PluginOpHandle {
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
  /** UI 兼容入口：发起取消并在 stderr 收敛异步停止错误。 */
  cancel: () => void
  /** 生命周期入口：停止机制失败时 rejection 由 shutdown 决定是否重试/上抛。 */
  stop?: () => Promise<void>
}

export type PluginSpawnPlan = DshSpawnPlan

/**
 * Windows 不能以 shell:false 直接执行 npm 的 .cmd shim；shell:true 又会让插件
 * spec 进入 cmd.exe 解释。只解析标准 npm shim 中固定的 JS 入口，再用真实 node
 * 和独立 argv 启动，用户输入因此永远不会拼进 shell 命令行。
 */
export function planPluginSpawn(
  dsh: string,
  node: string | undefined,
  args: string[],
  dependencies: DshSpawnPlanDependencies = {},
): PluginSpawnPlan {
  return planDshSpawn(dsh, node, args, dependencies)
}

/** 执行 dsh plugin 操作（真实改动 profile，须由显式用户动作触发）。
 * pnpm ≥10 可能在第一次安装时拒绝 native 依赖的构建脚本；若 pnpm 明确报告
 * ERR_PNPM_IGNORED_BUILDS，则只授权它报告的包并自动重试一次，避免把失败的半安装状态留给用户。
 */
export function runPluginOp(opts: {
  dsh: string
  node?: string
  profile: string
  action: 'add' | 'remove' | 'update'
  args?: string[]
  cwd?: string
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  autoApproveBuilds?: { workspaceFile: string }
  requestBuildApproval?: (keys: string[]) => Promise<boolean>
}): PluginOpHandle {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const { promise, resolve } = Promise.withResolvers<{
    exitCode: number | null
    signal: NodeJS.Signals | null
  }>()
  const retryBuildApproval = (opts.action === 'add' || opts.action === 'update') && opts.autoApproveBuilds
  let currentChild: ChildProcess | null = null
  let attempt = 0
  let settled = false
  let cancelled = false
  let cancelSucceeded = false
  let cancelPromise: Promise<void> | null = null
  const RETRY_OUTPUT_CAP = 256 * 1024

  const finish = (result: { exitCode: number | null; signal: NodeJS.Signals | null }): void => {
    if (settled) return
    settled = true
    currentChild = null
    opts.signal?.removeEventListener('abort', onAbort)
    stdout.end()
    stderr.end()
    resolve(result)
  }

  const requestCancel = (): Promise<void> => {
    if (settled) return Promise.resolve()
    cancelled = true
    if (cancelSucceeded) return Promise.resolve()
    if (cancelPromise) return cancelPromise
    const child = currentChild
    if (!child) {
      finish({ exitCode: null, signal: 'SIGTERM' })
      return Promise.resolve()
    }
    const pending = stopTree(child)
      .then(() => {
        cancelSucceeded = true
      })
      .catch((error: unknown) => {
        if (!settled) stderr.write(`\n插件进程树停止失败：${error instanceof Error ? error.message : String(error)}\n`)
        // 不能在 child 仍可能存活时伪造 SIGTERM 终态。保留 currentChild，后续
        // shutdown/cancel 可以重试同一个 ChildProcess；错误则由 shutdown 显式收口。
        throw error
      })
      .finally(() => {
        if (cancelPromise === pending) cancelPromise = null
      })
    cancelPromise = pending
    return pending
  }

  const cancel = (): void => {
    void requestCancel().catch(() => {
      // stderr 已记录；UI/AbortSignal 没有 Promise 消费方，必须在此收敛 rejection。
    })
  }
  const onAbort = (): void => cancel()
  if (opts.signal?.aborted) onAbort()
  else opts.signal?.addEventListener('abort', onAbort, { once: true })

  const startAttempt = (): void => {
    if (settled || cancelled) {
      finish({ exitCode: null, signal: 'SIGTERM' })
      return
    }
    const cmd = buildPluginCommand(opts.profile, opts.action, opts.args ?? [])
    let child: ChildProcess
    try {
      const plan = planPluginSpawn(opts.dsh, opts.node, cmd)
      child = spawn(plan.executable, plan.args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        // POSIX 必须让 dsh plugin 成为进程组 leader，取消时才能连同
        // pnpm / prepare 等后代一起终止。Windows 继续由 taskkill /T 管树。
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      finish({ exitCode: -1, signal: null })
      return
    }
    currentChild = child
    let attemptOutput = ''
    let spawnError = false
    const forward = (stream: NodeJS.ReadableStream | null, target: PassThrough): void => {
      stream?.on('data', (chunk: Buffer | string) => {
        attemptOutput = (attemptOutput + String(chunk)).slice(-RETRY_OUTPUT_CAP)
        target.write(chunk)
      })
    }
    forward(child.stdout, stdout)
    forward(child.stderr, stderr)
    child.once('error', () => {
      spawnError = true
    })
    child.once('close', (code, signal) => {
      void (async () => {
        if (settled) return
        currentChild = null
        const exitCode = code === null && spawnError ? -1 : code
        if (
          !cancelled &&
          attempt === 0 &&
          exitCode !== 0 &&
          signal === null &&
          retryBuildApproval
        ) {
          const approvalKeys = parseBuildApprovalKeys(attemptOutput)
          if (approvalKeys.length > 0) {
            try {
              if (!opts.requestBuildApproval) {
                stderr.write(`\n构建脚本需要显式授权；未修改 allowBuilds。请通过桌面端确认后重试安装。\n`)
                finish({ exitCode, signal })
                return
              }
              const requested = await opts.requestBuildApproval(approvalKeys)
              if (settled || cancelled) return
              if (!requested) {
                stderr.write(`\n构建脚本授权已取消，未修改 allowBuilds。请确认后重试安装。\n`)
                finish({ exitCode, signal })
                return
              }
              const approval = approveIgnoredBuilds(retryBuildApproval.workspaceFile, approvalKeys)
              if (approval.changed) {
                stdout.write(`\n已获用户授权构建脚本：${approval.approved.join(', ')}；正在重试安装…\n`)
                attempt = 1
                startAttempt()
                return
              }
            } catch (err) {
              stderr.write(`\npnpm 构建授权更新失败：${err instanceof Error ? err.message : String(err)}\n`)
            }
          }
        }
        if (!settled) finish({ exitCode, signal })
      })()
    })
  }

  if (!settled) startAttempt()
  return { stdout, stderr, done: promise, cancel, stop: requestCancel }
}
