// DSH harness 集成核心：环境检测、profile 发现、dsh web 启动与进程清理
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'

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

/** 运行时目录名（缩短以压低 NSIS 安装路径深度；改动须与 scripts/bundle-runtime.mjs 同步） */
const RUNTIME_DIRNAME = 'rt'
const NODE_DIRNAME = 'nd'

/** 解析 dsh 执行方式：优先打包内 runtime，回退系统 PATH */
export function resolveDshExec(): DshExec | null {
  const base = process.resourcesPath ?? join(process.cwd(), 'resources')
  // 打包布局（asar:false）：{resources}/app/resources/{rt,nd}；兼容旧 asar 布局与开发模式直下
  const roots = [
    ...(process.resourcesPath
      ? [join(base, 'app', 'resources'), join(base, 'app.asar.unpacked', 'resources'), base]
      : [base]),
  ]
  for (const root of roots) {
    const runtimeBin = join(root, RUNTIME_DIRNAME, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    // 布局差异：darwin/linux tar.gz → bin/node；Windows zip → 根 node.exe
    const nodeBin = process.platform === 'win32'
      ? join(root, NODE_DIRNAME, 'node.exe')
      : join(root, NODE_DIRNAME, 'bin', 'node')
    if (existsSync(runtimeBin) && existsSync(nodeBin)) return { exec: runtimeBin, node: nodeBin }
  }
  const dsh = findDsh()
  return dsh ? { exec: dsh } : null
}

/**
 * 构造统一 runtime PATH：捆绑 node/bin（node/npm/npx）+ dsh-runtime node_modules/.bin（dsh/pnpm）
 * + 原 PATH。`dsh plugin` 内部 spawnSync("pnpm") 依赖 PATH，npx MCP 也依赖 PATH 中的捆绑 npx；
 * 必须显式传给 Harness 与 Plugin 子进程（仅捆绑 node 存在时）。
 */
export function runtimePathEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const exec = resolveDshExec()
  if (!exec?.node) return env
  const extra = [
    dirname(exec.node),
    // bin.js 在 dsh-runtime/node_modules/@deepseek-ai/dsh/lib/ → 上三级到 node_modules/.bin
    resolve(dirname(exec.exec), '..', '..', '..', '.bin'),
  ].filter((p) => existsSync(p))
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  env[pathKey] = [...extra, env[pathKey] ?? env.PATH ?? ''].filter(Boolean).join(process.platform === 'win32' ? ';' : ':')
  return env
}

/** 从 PATH 解析 dsh 可执行文件（Windows 下 npm 全局装的是 dsh.cmd shim） */
export function findDsh(): string | null {
  const isWin = process.platform === 'win32'
  const candidates = [
    process.env.DSH_BIN,
    // POSIX 常见安装路径（Homebrew / 官方脚本）；Windows 无固定安装路径，仅走 PATH
    ...(isWin ? [] : ['/opt/homebrew/bin/dsh', '/usr/local/bin/dsh', '/usr/bin/dsh']),
  ].filter((p): p is string => !!p)
  const pathKey = isWin ? 'Path' : 'PATH'
  const pathDirs = (process.env[pathKey] ?? process.env.PATH ?? '').split(isWin ? ';' : ':')
  for (const dir of pathDirs) {
    for (const name of isWin ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh']) {
      const p = join(dir, name)
      if (existsSync(p)) candidates.push(p)
    }
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

/** dsh 启动期致命错误的 stderr 标记（installFailLoud 输出，随后 exit 1） */
const DSK_FATAL_RE = /dsh: fatal load failure: (.+)/

/** 启动 dsh web：spawn 独立进程组，解析端口，轮询就绪 */
export function startHarness(opts: {
  profile?: string
  cwd?: string
  port?: number
  onLog?: (line: string) => void
  readyTimeoutMs?: number
  /** 子进程 spawn 后的同步回调（供调用方追踪 in-flight 进程，退出清理用） */
  onSpawn?: (proc: ChildProcess) => void
}): Promise<HarnessHandle> {
  const exec = resolveDshExec()
  if (!exec) return Promise.reject(new Error('未找到 dsh 可执行文件（请先安装 DeepSeek Harness）'))
  const cwd = opts.cwd ?? homedir()
  const args = ['web', '--port', String(opts.port ?? 0)]
  // M1 统一走官方 web profile；port 0 = 由 dsh 自选
  const spawnArgs = exec.node ? [exec.exec, ...args] : args
  const proc = spawn(exec.node ?? exec.exec, spawnArgs, {
    cwd,
    detached: true,
    env: runtimePathEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  opts.onSpawn?.(proc)

  return new Promise((resolve, reject) => {
    let url: string | null = null
    let settled = false
    let polling = false
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
        // dsh 启动期致命错误：立即失败并携带原因，不等 180s 轮询超时
        const fatal = line.match(DSK_FATAL_RE)
        if (fatal && !settled) {
          settled = true
          clearTimeout(timer)
          void stopTree(proc)
          reject(new Error(`dsh 启动失败：${fatal[1].slice(0, 400)}`))
          return
        }
        url ??= parseHarnessUrl(line)
        // 只允许一个 HTTP 轮询在飞，避免每个日志块都新起轮询
        if (url && !settled && !polling) {
          polling = true
          void (async () => {
            const ok = await waitForHttp(url!)
            polling = false
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

/** Windows：taskkill /T 终止整棵树（无 /F 先优雅；有窗口进程发 WM_CLOSE，控制台进程直接终止） */
function taskkillTree(pid: number, force: boolean): void {
  try {
    spawnSync('taskkill', ['/pid', String(pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true, stdio: 'ignore' })
  } catch {
    /* 已退出 */
  }
}

/** 终止单个进程树：Windows taskkill /T /F；POSIX SIGTERM（供插件取消复用）。
 * 插件取消必须有确定终态；Windows 控制台 Node 进程不会可靠响应 taskkill 的优雅 WM_CLOSE，
 * 只发不带 /F 的 taskkill 会让 dsh plugin 一直跑完，导致取消失效并卡住 CI。
 */
export function terminateTree(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    taskkillTree(pid, true)
  } else {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* 已退出 */
    }
  }
}

/** 终止整个进程树：POSIX SIGTERM 进程组（detached 负 pid）；Windows taskkill /T → 2s 后兜底强杀 */
export async function stopTree(proc: ChildProcess): Promise<void> {
  if (proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null) return
  if (process.platform === 'win32') {
    taskkillTree(proc.pid, false)
    const { promise, resolve } = Promise.withResolvers<void>()
    // 优雅窗口 800ms（非 2s）：安装器非 PowerShell 路径在 WM_CLOSE 后约 1300ms（300+1000）即 /F 强杀主进程；
    // 优雅清理须落在该窗口内，否则 stopTree 半途被 TerminateProcess → node.exe 孤儿
    const t = setTimeout(() => {
      taskkillTree(proc.pid!, true)
      resolve()
    }, 800)
    proc.once('exit', () => {
      clearTimeout(t)
      resolve()
    })
    await promise
    return
  }
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
