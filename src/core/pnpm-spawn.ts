// pnpm 进程规划：与 dsh 同一类 Windows 陷阱——npm 只提供 pnpm.cmd/.ps1 shim，
// 包内没有 pnpm.exe；`spawn('pnpm', {shell:false})` 在 Windows 上必然 ENOENT
// （直接 spawn pnpm.cmd 又会 EINVAL）。这里优先使用捆绑运行时里的 pnpm JS 入口
// + 捆绑 node，完全绕开 shim 与 PATH；只有在没有捆绑运行时（开发模式 / PATH 安装）
// 才回退到 PATH 解析，并把 .cmd/.bat 解析成 node + JS 入口。
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { resolveWindowsShimEntry, type DshSpawnPlan } from './dsh-spawn.js'

/**
 * 捆绑运行时中 pnpm 的入口，取自 pnpm 的 package.json bin 字段
 * （pnpm 11.x 为 bin/pnpm.mjs）；保留 .cjs 以兼容更早的布局。
 */
const BUNDLED_PNPM_ENTRIES = [join('pnpm', 'bin', 'pnpm.mjs'), join('pnpm', 'bin', 'pnpm.cjs')]

/** Windows 上 pnpm 可能的可执行形态（npm 在 Windows 上写的是 .cmd） */
const WINDOWS_PNPM_NAMES = ['pnpm.exe', 'pnpm.cmd', 'pnpm.bat']
const WINDOWS_NODE_NAMES = ['node.exe', 'node.cmd', 'node']

export interface PnpmSpawnDependencies {
  platform?: NodeJS.Platform
  /** 用于 PATH 解析的环境（调用方通常传 runtimePathEnv 的结果），默认 process.env */
  env?: NodeJS.ProcessEnv
  /** resolveDshExec() 的结果；用于定位捆绑运行时中的 pnpm 与 node */
  dshExec?: { exec: string; node?: string } | null
  readShim?: (file: string) => string
  pathExists?: (file: string) => boolean
  findNode?: () => string | null
}

export type PnpmSpawnPlan = DshSpawnPlan

/** Windows 环境键不区分大小写，且 Node 只把排序后的一个重复键传给子进程。 */
function pathValue(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return env.PATH ?? ''
  return env.Path ?? env.PATH ?? Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
}

function findOnPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  names: string[],
  pathExists: (file: string) => boolean,
): string | null {
  const delimiter = platform === 'win32' ? ';' : ':'
  for (const dir of pathValue(env, platform).split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (pathExists(candidate)) return candidate
    }
  }
  return null
}

/** 捆绑 dsh 的 node_modules/@deepseek-ai/dsh/lib/bin.js → node_modules（与 runtimePathEnv 同一布局假设） */
function bundledModulesDir(exec: string): string {
  return resolve(dirname(exec), '..', '..', '..')
}

/**
 * 规划一次 pnpm 调用：始终返回可直接以 shell:false 启动的 executable + argv。
 * 参数按独立 argv 元素传递、绝不拼进 cmd.exe，因此 profile 路径中的空格与元字符都不会被解释。
 */
export function planPnpmSpawn(args: string[], dependencies: PnpmSpawnDependencies = {}): PnpmSpawnPlan {
  const platform = dependencies.platform ?? process.platform
  const pathExists = dependencies.pathExists ?? existsSync
  const env = dependencies.env ?? process.env
  const dshExec = dependencies.dshExec ?? null
  const bundledNode = dshExec?.node

  // 1) 捆绑运行时：node <rt>/node_modules/pnpm/bin/pnpm.mjs …（不依赖 PATH 与 shim）
  if (bundledNode && dshExec) {
    const modules = bundledModulesDir(dshExec.exec)
    for (const entry of BUNDLED_PNPM_ENTRIES) {
      const candidate = join(modules, entry)
      if (pathExists(candidate)) return { executable: bundledNode, args: [candidate, ...args] }
    }
  }

  // 2) PATH 回退：Windows 上 .cmd/.bat 不能以 shell:false 直接执行，必须解析成 node + JS 入口
  const found = findOnPath(env, platform, platform === 'win32' ? WINDOWS_PNPM_NAMES : ['pnpm'], pathExists)
  if (!found) throw new Error('未找到可用的 pnpm：捆绑运行时缺少 pnpm，且 PATH 中没有 pnpm 可执行文件')
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(found)) return { executable: found, args }

  const entry = resolveWindowsShimEntry(found, dependencies)
  if (!entry) throw new Error(`无法解析 Windows pnpm shim 的 JavaScript 入口：${found}`)
  const node =
    dependencies.findNode?.() ??
    bundledNode ??
    findOnPath(env, platform, WINDOWS_NODE_NAMES, pathExists)
  if (!node) throw new Error(`pnpm shim 已找到，但 PATH 中没有可用的 node.exe：${found}`)
  return { executable: node, args: [entry, ...args] }
}
