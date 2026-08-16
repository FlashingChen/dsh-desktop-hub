// Plugin 系统核心：profile 插件清单解析 + dsh plugin 命令封装
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { DshProfile } from './harness.js'

export interface PluginEntry {
  name: string
  /** dependencies 中的 spec（如版本号或 link:/path） */
  spec: string
  /** 是否在 dsh.profile.bundles（作为组合包激活） */
  inBundles: boolean
  /** @deepseek-ai/* 内置包 */
  builtin: boolean
  source: 'builtin-bundle' | 'bundle' | 'dependency'
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
      return { name, spec, inBundles, builtin, source }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
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
