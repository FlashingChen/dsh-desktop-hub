// DSH harness 集成核心：环境检测、profile 发现、dsh web 启动与进程清理
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { parseDocument } from 'yaml'
import { atomicWriteWithBackup } from './mcp.js'

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
  // 打包布局（asar:false）：{resources}/app/resources/{rt,nd}；兼容旧 asar 布局。
  // Electron 开发模式的 process.resourcesPath 指向项目根而非项目的 resources/，
  // 因此显式补 cwd/resources，避免本地有捆绑 runtime 时错误回退到 PATH。
  const roots = [
    ...(process.resourcesPath
      ? [join(base, 'app', 'resources'), join(base, 'app.asar.unpacked', 'resources'), base]
      : [base]),
    ...((process as NodeJS.Process & { defaultApp?: boolean }).defaultApp === true ? [join(process.cwd(), 'resources')] : []),
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

const JS_ENV_REF_RE = /!!js[ \t]+process\.env\.([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?:(?:#[^\r\n]*)?(?:\r?\n|$))/g
const DIRECTORY_PICKER_HOST_PLUGINS = new Set([
  '@deepseek-ai/dsh-host-directory-picker',
  '@deepseek-ai/dsh-host-directory-picker-auto',
  '@deepseek-ai/dsh-host-directory-picker-native',
  '@deepseek-ai/dsh-host-directory-picker-browse',
])

/**
 * The shipped web bundle owns one adaptive `directory-picker` row. Older or
 * custom profiles may add another host implementation, which makes Cordis
 * register the `directoryPicker` service twice. Repair only when the profile
 * declares the official web bundle and has not explicitly overridden/disabled
 * its `directory-picker` row; otherwise leave user configuration untouched.
 */
export function repairDirectoryPickerRows(home: string = dshHome(), profile = 'web'): string[] {
  let profilePackage: { dsh?: { profile?: { bundles?: unknown } } }
  try {
    profilePackage = JSON.parse(readFileSync(join(home, 'profiles', profile, 'package.json'), 'utf8'))
  } catch {
    return []
  }
  const bundles = profilePackage.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.includes('@deepseek-ai/dsh-web-app')) return []

  const valueOf = (pair: unknown): string | undefined => {
    const p = pair as { value?: unknown } | null
    const value = p?.value
    if (value && typeof value === 'object' && 'value' in value) return String((value as { value: unknown }).value)
    return typeof value === 'string' ? value : undefined
  }
  const field = (row: unknown, key: string): string | undefined => {
    const items = (row as { items?: unknown[] } | null)?.items
    if (!Array.isArray(items)) return undefined
    const pair = items.find((candidate) => {
      const k = (candidate as { key?: { value?: unknown } } | null)?.key?.value
      return k === key
    })
    return valueOf(pair)
  }
  type PickerRow = { node: unknown; id?: string; name?: string; disabled?: string }
  type PatchLayer = { file: string; doc: ReturnType<typeof parseDocument>; entries: unknown[]; rows: PickerRow[] }
  const layers: PatchLayer[] = []
  for (const file of [join(home, 'profiles', profile, 'cordis.patch.yml'), join(home, 'cordis.patch.yml')]) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    let doc: ReturnType<typeof parseDocument>
    try {
      doc = parseDocument(text)
    } catch {
      continue
    }
    if (doc.errors.length > 0) continue
    const entries = (doc.contents as { items?: unknown[] } | null)?.items
    if (!Array.isArray(entries)) continue
    const rows: PickerRow[] = []
    const collect = (node: unknown): void => {
      rows.push({ node, id: field(node, 'id'), name: field(node, 'name'), disabled: field(node, 'disabled') })
    }
    for (const entry of entries) {
      const pairs = (entry as { items?: unknown[] } | null)?.items
      const insert = Array.isArray(pairs)
        ? pairs.find((candidate) => (candidate as { key?: { value?: unknown } } | null)?.key?.value === 'insert')
        : undefined
      const sequence = (insert as { value?: { items?: unknown[] } } | null)?.value?.items
      if (Array.isArray(sequence)) sequence.forEach(collect)
      else collect(entry)
    }
    layers.push({ file, doc, entries, rows })
  }

  const allRows = layers.flatMap((layer) => layer.rows)
  // An explicit row with the official id means the user has intentionally
  // changed or disabled the shipped provider. Do not guess its desired backend.
  if (allRows.some((row) => row.id === 'directory-picker' && (row.name !== undefined || row.disabled === 'true'))) return []
  const candidates = allRows.filter((row) => row.id !== 'directory-picker' && DIRECTORY_PICKER_HOST_PLUGINS.has(row.name ?? ''))
  if (candidates.length === 0) return []
  const candidateNodes = new Set(candidates.map((row) => row.node))
  const repaired: string[] = []

  for (const layer of layers) {
    const removed: string[] = []
    const removeFrom = (rows: unknown[]): void => {
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i]
        if (!candidateNodes.has(row)) continue
        removed.push(`${field(row, 'id') ?? '<anonymous>'} (${field(row, 'name')})`)
        rows.splice(i, 1)
      }
    }
    for (let i = layer.entries.length - 1; i >= 0; i--) {
      const entry = layer.entries[i]
      const pairs = (entry as { items?: unknown[] } | null)?.items
      const insert = Array.isArray(pairs)
        ? pairs.find((candidate) => (candidate as { key?: { value?: unknown } } | null)?.key?.value === 'insert')
        : undefined
      const sequence = (insert as { value?: { items?: unknown[] } } | null)?.value?.items
      if (Array.isArray(sequence)) removeFrom(sequence)
      else if (candidateNodes.has(entry)) {
        removed.push(`${field(entry, 'id') ?? '<anonymous>'} (${field(entry, 'name')})`)
        layer.entries.splice(i, 1)
      }
    }
    if (removed.length === 0) continue
    try {
      const backup = atomicWriteWithBackup(layer.file, layer.doc.toString())
      repaired.push(`${layer.file}: ${removed.join(', ')}${backup ? `；备份 ${backup}` : ''}`)
    } catch {
      // A read-only profile should still reach the normal DSH error path.
    }
  }
  return repaired
}

/**
 * DSH 的 `!!js process.env.NAME` 在 NAME 不存在时求值为 undefined；
 * dsh-mcp-client 的字符串 schema 会把这个 undefined 判为非法，进而让整个
 * `dsh web` 以 code=1 退出。把缺失的直接环境引用补成空字符串只作用于
 * Harness 子进程，不会修改用户 profile 或父进程环境；MCP 服务器仍会自行
 * 报告缺少凭据，但不会阻断其他插件和 Web UI 启动。
 */
function addMissingProfileEnvRefs(env: NodeJS.ProcessEnv, profile: string | undefined, cwd: string): void {
  if (!profile) return
  const patches: string[] = []
  for (const file of [join(dshHome(), 'profiles', profile, 'cordis.patch.yml'), join(dshHome(), 'cordis.patch.yml')]) {
    try {
      patches.push(readFileSync(file, 'utf8'))
    } catch {
      /* Optional patch layer. */
    }
  }
  const names = new Set<string>()
  for (const patch of patches) for (const match of patch.matchAll(JS_ENV_REF_RE)) names.add(match[1])
  if (names.size === 0) return
  const keys = Object.keys(env)
  const normalizeEnvKey = (key: string): string => process.platform === 'win32' ? key.toLowerCase() : key
  const hasKey = (name: string): boolean => {
    const present = keys.find((key) => normalizeEnvKey(key) === normalizeEnvKey(name))
    return present !== undefined && env[present] !== undefined
  }
  // DSH applies cwd/.env and then $DSH_HOME/.env only when the inherited
  // environment does not already define the name. Respect either layer so a
  // fallback does not mask a token deliberately kept in a profile environment file.
  const fileKeys = new Set<string>()
  for (const file of [join(cwd, '.env'), join(dshHome(), '.env')]) {
    try {
      for (const key of Object.keys(parseEnv(readFileSync(file, 'utf8')))) fileKeys.add(normalizeEnvKey(key))
    } catch {
      /* DSH will report malformed/unreadable .env files itself. */
    }
  }
  for (const name of names) {
    // Windows environment keys are case-insensitive; do not add a duplicate
    // key when the inherited environment used a different casing.
    if (!hasKey(name) && !fileKeys.has(normalizeEnvKey(name))) env[name] = ''
  }
}

/**
 * 构造统一 runtime PATH：捆绑 node/bin（node/npm/npx）+ dsh-runtime node_modules/.bin（dsh/pnpm）
 * + 原 PATH。`dsh plugin` 内部 spawnSync("pnpm") 依赖 PATH，npx MCP 也依赖 PATH 中的捆绑 npx；
 * 必须显式传给 Harness 与 Plugin 子进程（仅捆绑 node 存在时）。
 * `profile` 用于为缺失的 `!!js process.env.NAME` 引用提供非破坏性的空字符串默认值，
 * `cwd` 用于保留 DSH 分层 `.env` 中的值。
 */
export function runtimePathEnv(profile?: string, cwd: string = process.cwd()): NodeJS.ProcessEnv {
  const env = { ...process.env }
  addMissingProfileEnvRefs(env, profile, cwd)
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
const DIRECTORY_PICKER_DUP_RE = /service ["']directoryPicker["'] has been registered/i

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
  const profile = opts.profile ?? 'web'
  const repairs = repairDirectoryPickerRows(dshHome(), profile)
  if (repairs.length > 0) opts.onLog?.(`harness: 已移除重复 DirectoryPicker 配置：${repairs.join(' | ')}`)
  const args = ['web', '--port', String(opts.port ?? 0)]
  // M1 统一走官方 web profile；port 0 = 由 dsh 自选。
  // Windows 的 PATH 回退通常是 dsh.cmd；cmd shim 不能可靠地由 shell:false 直接启动。
  const spawnArgs = exec.node ? [exec.exec, ...args] : args
  const useWindowsShim = process.platform === 'win32' && !exec.node && /\.(?:cmd|bat)$/i.test(exec.exec)
  const proc = spawn(exec.node ?? exec.exec, spawnArgs, {
    cwd,
    detached: true,
    env: runtimePathEnv(profile, cwd),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: useWindowsShim,
  })
  opts.onSpawn?.(proc)

  return new Promise((resolve, reject) => {
    let url: string | null = null
    let settled = false
    let polling = false
    const outputTail: string[] = []
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
        outputTail.push(line)
        if (outputTail.length > 80) outputTail.shift()
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
        if (outputTail.some((line) => DIRECTORY_PICKER_DUP_RE.test(line))) {
          reject(new Error(`dsh web 提前退出（code=${code}）：DirectoryPicker 服务重复注册；请删除 profile/home patch 中额外的 dsh-host-directory-picker-native、browse 或 auto 行，仅保留官方 directory-picker auto 行`))
          return
        }
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
