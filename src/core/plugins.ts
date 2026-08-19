// Plugin 系统核心：profile 插件清单解析 + dsh plugin 命令封装
import { readFileSync } from 'node:fs'
import { parseDocument, stringify } from 'yaml'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import type { DshProfile } from './harness.js'
import { terminateTree } from './harness.js'
import { approveIgnoredBuilds, parseBuildApprovalKeys, parseIgnoredBuildPackages } from './pnpm.js'

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

export interface InstallSpecPlan {
  kind: 'plugin' | 'routing-suite'
  normalized: string
  message?: string
}

/** 从 profile package.json 解析插件清单：bundles ∪ dependencies。
 * 传入 patch 文本时计算真实激活来源（bundle / patch / none）。 */
export function listPlugins(profile: DshProfile, patchText?: string): PluginEntry[] {
  const pkg = JSON.parse(readFileSync(join(profile.dir, 'package.json'), 'utf8'))
  const deps: Record<string, string> = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const bundles = new Set(profile.bundles)
  const names = new Set([...Object.keys(deps), ...bundles])
  return [...names]
    .map((name): PluginEntry => {
      const spec = deps[name] ?? ''
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

type PatchPair = { key?: { value?: unknown }; value?: unknown }
type PatchRow = { items?: PatchPair[] }

function unwrapPatchValue(value: unknown): unknown {
  if (value && typeof value === 'object' && 'value' in value) return (value as { value?: unknown }).value
  return value
}

function patchRowField(row: unknown, key: string): unknown {
  const items = (row as PatchRow | null)?.items
  return unwrapPatchValue(items?.find((pair) => unwrapPatchValue(pair.key?.value) === key)?.value)
}

function parsePluginPatch(patchText: string) {
  const doc = parseDocument(patchText)
  if (doc.errors.length > 0) throw new Error(`patch 解析失败: ${doc.errors[0].message}`)
  const contents = doc.contents as { items?: unknown[] } | null
  const entries = contents?.items ?? []
  return { doc, contents, entries }
}

function insertSequences(entries: unknown[]): { items: unknown[] }[] {
  const result: { items: unknown[] }[] = []
  for (const entry of entries) {
    const pairs = (entry as PatchRow | null)?.items
    const insert = pairs?.find((pair) => unwrapPatchValue(pair.key?.value) === 'insert')
    const sequence = insert?.value as { items?: unknown[] } | null | undefined
    if (Array.isArray(sequence?.items)) result.push(sequence as { items: unknown[] })
  }
  return result
}

/** 生成 profile patch 中稳定、合法的插件行 id。 */
export function pluginPatchId(name: string): string {
  const id = name.replace(/^@/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return id || 'plugin'
}

/** 判断插件是否已经通过 cordis.patch.yml 的 insert 层激活。 */
export function isPluginActive(patchText: string, name: string): boolean {
  const { entries } = parsePluginPatch(patchText)
  return insertSequences(entries).some((sequence) => sequence.items.some((row) => patchRowField(row, 'name') === name))
}

/** 向 patch 的 insert 层激活已安装插件；重复激活保持幂等。 */
export function activatePlugin(patchText: string, name: string, id = pluginPatchId(name)): string {
  const parsed = parsePluginPatch(patchText)
  const sequences = insertSequences(parsed.entries)
  if (sequences.some((sequence) => sequence.items.some((row) => patchRowField(row, 'name') === name))) return patchText
  const row = { id, name }
  const target = sequences[0]
  if (target) {
    target.items.push(parsed.doc.createNode(row))
    return parsed.doc.toString()
  }
  if (!parsed.contents) return stringify([{ insert: [row] }])
  if (!Array.isArray(parsed.contents.items)) throw new Error('patch 顶层必须是列表')
  const fresh = parseDocument(stringify([{ insert: [row] }]))
  const freshItems = ((fresh.contents as { items?: unknown[] } | null)?.items ?? []) as unknown[]
  parsed.contents.items.push(...freshItems)
  return parsed.doc.toString()
}

/** 从 patch 的 insert 层停用插件，但不卸载 package 依赖。 */
export function deactivatePlugin(patchText: string, name: string): string {
  const parsed = parsePluginPatch(patchText)
  let removed = 0
  for (const sequence of insertSequences(parsed.entries)) {
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
  const parsed = parsePluginPatch(patchText)
  let removed = 0
  for (const sequence of insertSequences(parsed.entries)) {
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
  cancel: () => void
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

  const cancel = (): void => {
    cancelled = true
    if (currentChild) terminateTree(currentChild.pid)
    else finish({ exitCode: null, signal: 'SIGTERM' })
  }

  const onAbort = (): void => cancel()
  if (opts.signal?.aborted) cancel()
  else opts.signal?.addEventListener('abort', onAbort, { once: true })

  const startAttempt = (): void => {
    if (settled || cancelled) {
      finish({ exitCode: null, signal: 'SIGTERM' })
      return
    }
    const cmd = buildPluginCommand(opts.profile, opts.action, opts.args ?? [])
    const spawnArgs = opts.node ? [opts.dsh, ...cmd] : cmd
    let child: ChildProcess
    try {
      child = spawn(opts.node ?? opts.dsh, spawnArgs, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
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
  return { stdout, stderr, done: promise, cancel }
}
