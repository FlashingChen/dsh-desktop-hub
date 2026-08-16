// Plugin 系统核心：profile 插件清单解析 + dsh plugin 命令封装
import { readFileSync } from 'node:fs'
import { parseDocument, stringify } from 'yaml'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { DshProfile } from './harness.js'

export interface PluginEntry {
  name: string
  /** dependencies 中的 spec（如版本号或 link:/path） */
  spec: string
  /** 是否在 dsh.profile.bundles（作为组合包激活） */
  inBundles: boolean
  /** 是否已经在 profile patch 中激活 */
  active: boolean
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

/** 从 profile package.json 解析插件清单：bundles ∪ dependencies */
export function listPlugins(profile: DshProfile): PluginEntry[] {
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
      return { name, spec, inBundles, active: inBundles, builtin, source }
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
 * - https://github.com/owner/repo           → github:owner/repo
 * - https://github.com/owner/repo.git       → github:owner/repo
 * - https://github.com/owner/repo/tree/main → github:owner/repo#main
 * - https://github.com/owner/repo/commit/x  → github:owner/repo#x（commit 锁定）
 * - 已是 github:owner/repo 或 npm 包名/本地路径 → 原样返回
 */
export function normalizeInstallSpec(spec: string): string {
  const s = spec.trim()
  const m = s.match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/|$)/)
  if (!m) return s
  const owner = m[1]
  let repo = m[2]
  const rest = s.slice(m[0].length)
  if (!rest) return `github:${owner}/${repo}`
  const tree = rest.match(/^tree\/(.+)$/)
  if (tree) return `github:${owner}/${repo}#${tree[1]}`
  const commit = rest.match(/^commit\/([0-9a-fA-F]{7,40})$/)
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

/** 执行 dsh plugin 操作（真实改动 profile，须由显式用户动作触发） */
export function runPluginOp(opts: {
  dsh: string
  node?: string
  profile: string
  action: 'add' | 'remove' | 'update'
  args?: string[]
  cwd?: string
  signal?: AbortSignal
}): PluginOpHandle {
  const cmd = buildPluginCommand(opts.profile, opts.action, opts.args ?? [])
  const spawnArgs = opts.node ? [opts.dsh, ...cmd] : cmd
  const child = spawn(opts.node ?? opts.dsh, spawnArgs, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  const { promise, resolve } = Promise.withResolvers<{
    exitCode: number | null
    signal: NodeJS.Signals | null
  }>()
  child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
  child.on('error', () => resolve({ exitCode: -1, signal: null }))
  opts.signal?.addEventListener('abort', () => child.kill('SIGTERM'))
  return {
    stdout: child.stdout!,
    stderr: child.stderr!,
    done: promise,
    cancel: () => child.kill('SIGTERM'),
  }
}
