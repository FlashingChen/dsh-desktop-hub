// DSH harness 集成核心：环境检测、profile 发现、dsh web 启动与进程清理
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface DshProfile {
  name: string
  dir: string
  bundles: string[]
}

export interface HarnessHandle {
  /** 解析出的 harness Web UI 地址（如 http://127.0.0.1:3080） */
  url: string
  /** 优雅停止：SIGTERM 进程组 → 兜底 SIGKILL，等待子进程退出 */
  stop: () => Promise<void>
  proc: ChildProcess
}

export interface DshExec {
  /** 可执行文件：系统 dsh 或捆绑的 dsh lib/bin.js */
  exec: string
  /** 捆绑 Node（存在时用 node 启动 exec） */
  node?: string
}

/** 解析 dsh 执行方式：优先打包内 runtime，回退系统 PATH */
export function resolveDshExec(): DshExec | null {
  const base = process.resourcesPath ?? join(process.cwd(), 'resources')
  const roots = process.resourcesPath ? [join(base, 'app.asar.unpacked', 'resources'), base] : [base]
  for (const root of roots) {
    const runtimeBin = join(root, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const nodeBin = join(root, 'node', 'bin', 'node')
    if (existsSync(runtimeBin) && existsSync(nodeBin)) return { exec: runtimeBin, node: nodeBin }
  }
  const dsh = findDsh()
  return dsh ? { exec: dsh } : null
}

/** 从 PATH 解析 dsh 可执行文件 */
export function findDsh(): string | null {
  const candidates = [process.env.DSH_BIN, '/opt/homebrew/bin/dsh', '/usr/local/bin/dsh', '/usr/bin/dsh'].filter(
    (p): p is string => !!p,
  )
  const pathDirs = (process.env.PATH ?? '').split(':')
  for (const dir of pathDirs) {
    const p = join(dir, 'dsh')
    if (existsSync(p)) candidates.push(p)
  }
  return candidates.find((p) => existsSync(p)) ?? null
}

/** DSH 用户目录：$DSH_HOME → ~/.dsh */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** 发现本机 profile（目录 + dsh.profile.bundles），过滤掉非 profile 目录 */
export function listProfiles(home: string = dshHome()): DshProfile[] {
  const profilesDir = join(home, 'profiles')
  if (!existsSync(profilesDir)) return []
  return readdirSync(profilesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
    .map((d) => {
      const dir = join(profilesDir, d.name)
      let bundles: string[] = []
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
      } catch {
        /* 缺 package.json 的目录不视为 profile */
      }
      return { name: d.name, dir, bundles }
    })
    .filter((p) => p.bundles.length > 0)
}

/** 从 dsh 输出解析 Web UI 地址（形如 "dsh web: http://127.0.0.1:3080"，兼容无协议前缀变体） */
export function parseHarnessUrl(line: string): string | null {
  const m = line.match(/(?:https?:\/\/)?127\.0\.0\.1:(\d+)/)
  return m ? `http://127.0.0.1:${m[1]}` : null
}

async function waitForHttp(url: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return true
    } catch {
      /* 未就绪，继续轮询 */
    }
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 300)
    await promise
  }
  return false
}

/** 启动 dsh web：spawn 独立进程组，解析端口，轮询就绪 */
export function startHarness(opts: {
  profile?: string
  cwd?: string
  port?: number
  onLog?: (line: string) => void
  readyTimeoutMs?: number
}): Promise<HarnessHandle> {
  const exec = resolveDshExec()
  if (!exec) return Promise.reject(new Error('未找到 dsh 可执行文件（请先安装 DeepSeek Harness）'))
  const cwd = opts.cwd ?? homedir()
  const args = ['web', '--port', String(opts.port ?? 0)]
  // M1 统一走官方 web profile；port 0 = 由 dsh 自选
  const spawnArgs = exec.node ? [exec.exec, ...args] : args
  const proc = spawn(exec.node ?? exec.exec, spawnArgs, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })

  return new Promise((resolve, reject) => {
    let url: string | null = null
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        stopTree(proc)
        reject(new Error('等待 dsh web 就绪超时'))
      }
    }, opts.readyTimeoutMs ?? 90_000)

    const onData = (buf: Buffer): void => {
      for (const line of buf.toString().split('\n')) {
        if (!line.trim()) continue
        opts.onLog?.(line)
        url ??= parseHarnessUrl(line)
        if (url && !settled) {
          void (async () => {
            const ok = await waitForHttp(url!)
            if (ok && !settled) {
              settled = true
              clearTimeout(timer)
              resolve({ url: url!, stop: () => stopTree(proc), proc })
            }
          })()
        }
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('error', (err) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(err)
      }
    })
    proc.on('exit', (code) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(`dsh web 提前退出（code=${code}）`))
      }
    })
  })
}

/** 终止整个进程树：SIGTERM → 2s 后 SIGKILL */
async function stopTree(proc: ChildProcess): Promise<void> {
  if (proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null) return
  try {
    process.kill(-proc.pid, 'SIGTERM') // detached 后负 pid = 进程组
  } catch {
    /* 已退出 */
  }
  const { promise, resolve } = Promise.withResolvers<void>()
  const t = setTimeout(() => {
    try {
      process.kill(-proc.pid!, 'SIGKILL')
    } catch {
      /* 已退出 */
    }
    resolve()
  }, 2000)
  proc.once('exit', () => {
    clearTimeout(t)
    resolve()
  })
  await promise
}
