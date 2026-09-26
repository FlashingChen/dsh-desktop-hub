// Safe dsh process planning shared by Harness and plugin operations.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

export interface DshSpawnPlan {
  executable: string
  args: string[]
}

export interface DshSpawnPlanDependencies {
  platform?: NodeJS.Platform
  readShim?: (file: string) => string
  pathExists?: (file: string) => boolean
  findNode?: () => string | null
}

function findNodeOnPath(platform: NodeJS.Platform, pathExists: (file: string) => boolean): string | null {
  const pathValue = platform === 'win32'
    ? process.env.Path ?? process.env.PATH ?? Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
    : process.env.PATH ?? ''
  const pathDelimiter = platform === 'win32' ? ';' : ':'
  const names = platform === 'win32' ? ['node.exe', 'node'] : ['node']
  for (const dir of pathValue.split(pathDelimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (pathExists(candidate)) return candidate
    }
  }
  return null
}

/**
 * Windows cannot execute an npm .cmd/.bat shim with shell:false. Resolve only
 * the shim's relative JavaScript entry and invoke it through a real Node binary,
 * keeping every dsh argument in a separate argv element and out of cmd.exe.
 * Supports both current `%dp0%\...` and legacy `%~dp0\...` npm shims.
 */
export function planDshSpawn(
  dsh: string,
  node: string | undefined,
  args: string[],
  dependencies: DshSpawnPlanDependencies = {},
): DshSpawnPlan {
  if (node) return { executable: node, args: [dsh, ...args] }
  const platform = dependencies.platform ?? process.platform
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(dsh)) return { executable: dsh, args }

  const readShim = dependencies.readShim ?? ((file: string) => readFileSync(file, 'utf8'))
  const pathExists = dependencies.pathExists ?? existsSync
  const shim = readShim(dsh)
  const entryMatches = shim.matchAll(/%(?:d[pP]0%|~d[pP]0)[\\/]([^"\r\n]*?\.(?:[cm]?js))/gi)
  let entry: string | null = null
  for (const match of entryMatches) {
    const candidate = resolve(dirname(dsh), match[1].replace(/[\\/]+/g, sep))
    if (pathExists(candidate)) {
      entry = candidate
      break
    }
  }
  if (!entry) throw new Error(`无法解析 Windows dsh shim 的 JavaScript 入口：${dsh}`)
  const nodeExecutable = dependencies.findNode
    ? dependencies.findNode()
    : findNodeOnPath(platform, pathExists)
  if (!nodeExecutable) throw new Error(`dsh shim 已找到，但 PATH 中没有可用的 node.exe：${dsh}`)
  return { executable: nodeExecutable, args: [entry, ...args] }
}
