// DSH harness 集成核心：环境检测、profile 发现、dsh web 启动与进程清理
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { parseEnv } from 'node:util'
import { parseDocument } from 'yaml'
import { planDshSpawn, type DshSpawnPlanDependencies } from './dsh-spawn.js'
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

/** Resolve a developer-installed Node for the repository's bundled DSH package. */
function findNodeOnPath(): string | null {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  const pathDirs = (process.env[pathKey] ?? process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  const names = process.platform === 'win32' ? ['node.exe', 'node.cmd', 'node'] : ['node']
  const candidates = [process.env.DSH_NODE, ...pathDirs.flatMap((dir) => names.map((name) => join(dir, name)))].filter(
    (path): path is string => typeof path === 'string' && path.length > 0,
  )
  return candidates.find((path) => existsSync(path)) ?? null
}

const DANGEROUS_PACKAGE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function isPackageSegment(value: string): boolean {
  if (!value || value.startsWith('.') || value.startsWith('_')) return false
  try {
    // npm package segments are URL-safe; keep legacy uppercase names readable,
    // but reject whitespace, separators, controls and malformed surrogates.
    return encodeURIComponent(value) === value
  } catch {
    return false
  }
}

/** 只接收可安全作为 package map key 的 npm 风格名称；调用方决定如何报告 null。 */
export function normalizePackageName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (!name || name.length > 214 || DANGEROUS_PACKAGE_KEYS.has(name)) return null
  if (name.startsWith('@')) {
    const segments = name.slice(1).split('/')
    return segments.length === 2 && segments.every(isPackageSegment) ? name : null
  }
  return isPackageSegment(name) ? name : null
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
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
    ...(process.env.DSH_DESKTOP_RESOURCES_DIR ? [process.env.DSH_DESKTOP_RESOURCES_DIR] : []),
    ...(process.resourcesPath
      ? [join(base, 'app', 'resources'), join(base, 'app.asar.unpacked', 'resources'), base]
      : [base]),
  ]
  const developmentNode = process.env.DSH_DESKTOP_ALLOW_PATH_NODE === '1' ? findNodeOnPath() : null
  for (const root of roots) {
    const runtimeBin = join(root, RUNTIME_DIRNAME, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    // 布局差异：darwin/linux tar.gz → bin/node；Windows zip → 根 node.exe
    const nodeBin = process.platform === 'win32'
      ? join(root, NODE_DIRNAME, 'node.exe')
      : join(root, NODE_DIRNAME, 'bin', 'node')
    if (existsSync(runtimeBin)) {
      if (existsSync(nodeBin)) return { exec: runtimeBin, node: nodeBin }
      // This checkout can hold a cross-target Node runtime while being developed
      // on another platform. Use the developer's Node only for local launches;
      // shipped apps always carry the matching runtime and never depend on PATH.
      if (developmentNode) return { exec: runtimeBin, node: developmentNode }
    }
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
export function prependRuntimePath(
  source: NodeJS.ProcessEnv,
  extra: string[],
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env = { ...source }
  const canonicalKey = platform === 'win32' ? 'Path' : 'PATH'
  const pathKeys = Object.keys(env).filter((key) => platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH')
  // Windows 环境键不区分大小写，但 Node 只会把排序后的一个重复键传给子进程。
  // 优先保留系统惯用的 Path，其次兼容只有 PATH 的环境，再删除全部重复 casing。
  const original = env[canonicalKey] ?? env.PATH ?? pathKeys.map((key) => env[key]).find((value) => value !== undefined) ?? ''
  for (const key of pathKeys) delete env[key]
  env[canonicalKey] = [...extra, original].filter(Boolean).join(platform === 'win32' ? ';' : ':')
  return env
}

export function runtimePathEnv(profile?: string, cwd: string = process.cwd()): NodeJS.ProcessEnv {
  let env = { ...process.env }
  addMissingProfileEnvRefs(env, profile, cwd)
  const exec = resolveDshExec()
  if (!exec?.node) return env
  const extra = [
    dirname(exec.node),
    // bin.js 在 dsh-runtime/node_modules/@deepseek-ai/dsh/lib/ → 上三级到 node_modules/.bin
    resolve(dirname(exec.exec), '..', '..', '..', '.bin'),
  ].filter((p) => existsSync(p))
  env = prependRuntimePath(env, extra)
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

/** 发现本机 profile（目录 + dsh.profile.bundles），过滤掉非 profile 目录。 */
export function listProfiles(home: string = dshHome(), options: {
  onWarning?: (message: string) => void
} = {}): DshProfile[] {
  const profilesDir = join(home, 'profiles')
  if (!existsSync(profilesDir)) return []
  const warn = options.onWarning ?? ((message: string) => console.warn(`[profiles] ${message}`))
  return readdirSync(profilesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
    .map((d) => {
      const dir = join(profilesDir, d.name)
      let bundles: string[] = []
      try {
        const pkg: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        if (!isPlainObject(pkg)) {
          warn(`profile「${d.name}」package.json 顶层必须是普通对象`)
          return { name: d.name, dir, bundles }
        }
        if (pkg.dsh === undefined) return { name: d.name, dir, bundles }
        if (!isPlainObject(pkg.dsh)) {
          warn(`profile「${d.name}」的 dsh 必须是普通对象`)
          return { name: d.name, dir, bundles }
        }
        if (pkg.dsh.profile === undefined) return { name: d.name, dir, bundles }
        if (!isPlainObject(pkg.dsh.profile)) {
          warn(`profile「${d.name}」的 dsh.profile 必须是普通对象`)
          return { name: d.name, dir, bundles }
        }
        const rawBundles = pkg.dsh.profile.bundles
        if (rawBundles === undefined) return { name: d.name, dir, bundles }
        if (!Array.isArray(rawBundles)) {
          warn(`profile「${d.name}」的 dsh.profile.bundles 必须是数组`)
          return { name: d.name, dir, bundles }
        }
        const seen = new Set<string>()
        for (const [index, raw] of rawBundles.entries()) {
          const name = normalizePackageName(raw)
          if (!name) {
            warn(`profile「${d.name}」忽略非法 bundle[${index}]：必须是合法的非空包名字符串`)
            continue
          }
          if (seen.has(name)) continue
          seen.add(name)
          bundles.push(name)
        }
      } catch (error) {
        // 缺 package.json 的普通目录仍不视为 profile；已存在但损坏的文件必须留诊断。
        if (existsSync(join(dir, 'package.json'))) {
          warn(`profile「${d.name}」package.json 读取或解析失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return { name: d.name, dir, bundles }
    })
    .filter((p) => p.bundles.length > 0)
}

/** 从 dsh 输出解析 Web UI 地址；保留启动令牌查询参数供本机 Web UI 完成授权。 */
export function parseHarnessUrl(line: string): string | null {
  const match = line.match(/(?:https?:\/\/)?127\.0\.0\.1:\d+(?:\/[^\s"'<>]*)?/)
  if (!match) return null
  try {
    const candidate = /^https?:\/\//i.test(match[0]) ? match[0] : `http://${match[0]}`
    const url = new URL(candidate)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.hash) return null
    return url.pathname === '/' && !url.search ? url.origin : url.href
  } catch {
    return null
  }
}

type HttpFetch = (url: string, init: { signal: AbortSignal }) => Promise<{
  ok: boolean
  status?: number
  body?: { cancel: () => void | Promise<void> } | null
}>
type TimerHandle = ReturnType<typeof setTimeout>

const HTTP_READY_REQUEST_TIMEOUT_MS = 2_000
const HTTP_READY_POLL_INTERVAL_MS = 300

/** 单次探测有独立期限；本机 Harness 的未授权根路径会返回 401，也代表 Web 服务已就绪。 */
export async function fetchHttpOkWithin(url: string, timeoutMs: number, options: {
  fetchFn?: HttpFetch
  signal?: AbortSignal
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle
  clearTimer?: (timer: TimerHandle) => void
} = {}): Promise<boolean> {
  if (timeoutMs <= 0 || options.signal?.aborted) return false
  const controller = new AbortController()
  const fetchFn = options.fetchFn ?? fetch
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  let timer: TimerHandle | undefined
  let onCancel: (() => void) | undefined
  const stopped = new Promise<false>((resolve) => {
    const stop = (): void => {
      controller.abort()
      resolve(false)
    }
    timer = setTimer(stop, timeoutMs)
    if (options.signal) {
      onCancel = stop
      options.signal.addEventListener('abort', onCancel, { once: true })
      if (options.signal.aborted) stop()
    }
  })
  // 同步 throw、abort 后的 reject 以及 race 输掉后才到达的 reject 都在这里收敛，
  // 避免启动流程已结算后产生 unhandled rejection。
  const request = Promise.resolve()
    .then(() => fetchFn(url, { signal: controller.signal }))
    .then((response) => {
      const ready = response.ok || response.status === 401
      try {
        // readiness 只需要 HTTP status。立即取消 body，避免轮询把未读
        // 响应及连接累计 180 秒；取消失败不改变已经取得的 readiness 结论。
        void Promise.resolve(response.body?.cancel()).catch(() => {})
      } catch {
        // 自定义/宿主 Response.body.cancel 也可能同步 throw。
      }
      return ready
    }, () => false)
  try {
    return await Promise.race([request, stopped])
  } finally {
    if (timer !== undefined) clearTimer(timer)
    if (onCancel) options.signal?.removeEventListener('abort', onCancel)
    controller.abort()
  }
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0 || signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, delayMs)
    signal?.addEventListener('abort', done, { once: true })
    if (signal?.aborted) done()
  })
}

/** 轮询期限直接绑定 startHarness 的总 deadline，不另开固定 60s 窗口。 */
export async function waitForHttp(url: string, options: {
  deadline: number
  signal?: AbortSignal
  now?: () => number
  request?: (url: string, timeoutMs: number, signal?: AbortSignal) => Promise<boolean>
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>
  requestTimeoutMs?: number
  pollIntervalMs?: number
}): Promise<boolean> {
  const now = options.now ?? Date.now
  const request = options.request ?? ((target, timeoutMs, signal) => fetchHttpOkWithin(target, timeoutMs, { signal }))
  const sleep = options.sleep ?? abortableDelay
  const requestTimeoutMs = options.requestTimeoutMs ?? HTTP_READY_REQUEST_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? HTTP_READY_POLL_INTERVAL_MS

  while (!options.signal?.aborted) {
    const remaining = options.deadline - now()
    if (remaining <= 0) return false
    const ok = await request(url, Math.min(requestTimeoutMs, remaining), options.signal)
    if (ok) return !options.signal?.aborted && now() < options.deadline
    if (options.signal?.aborted) return false
    const delayMs = Math.min(pollIntervalMs, options.deadline - now())
    if (delayMs <= 0) return false
    await sleep(delayMs, options.signal)
  }
  return false
}

/** dsh 启动期致命错误的 stderr 标记（installFailLoud 输出，随后 exit 1） */
const DSK_FATAL_RE = /dsh: fatal load failure: (.+)/
const DIRECTORY_PICKER_DUP_RE = /service ["']directoryPicker["'] has been registered/i

interface StartHarnessDependencies {
  resolveExec?: () => DshExec | null
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  platform?: NodeJS.Platform
  spawnPlanDependencies?: DshSpawnPlanDependencies
  stopProcess?: (proc: ChildProcess) => Promise<void>
  waitForReady?: typeof waitForHttp
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle
  clearTimer?: (timer: TimerHandle) => void
}

const STARTUP_LOG_MAX_LINES = 80
const STARTUP_LOG_MAX_CHARS = 32 * 1024
const STARTUP_LINE_BUFFER_MAX_CHARS = 16 * 1024
const STARTUP_DIAGNOSTIC_MAX_CHARS = 2_000

interface LogLineDecoder {
  write: (chunk: Buffer | Uint8Array | string) => void
  end: () => void
}

/** The web server's bootstrap token is one-use; probe the loopback origin without consuming it. */
function harnessReadinessUrl(url: string): string {
  return new URL(url).origin
}

/** Decode one stdout/stderr stream independently and keep unterminated lines bounded. */
function createLogLineDecoder(onLine: (line: string) => void): LogLineDecoder {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let ended = false

  const emitLine = (line: string): void => {
    onLine(line.endsWith('\r') ? line.slice(0, -1) : line)
  }
  const drain = (): void => {
    let newline = pending.indexOf('\n')
    while (newline >= 0) {
      emitLine(pending.slice(0, newline))
      pending = pending.slice(newline + 1)
      newline = pending.indexOf('\n')
    }
    // A hostile/noisy child must not grow one no-newline buffer without bound.
    // Emit bounded fragments; the next fragment remains stream-local.
    while (pending.length > STARTUP_LINE_BUFFER_MAX_CHARS) {
      emitLine(`${pending.slice(0, STARTUP_LINE_BUFFER_MAX_CHARS)}…[日志行分段]`)
      pending = pending.slice(STARTUP_LINE_BUFFER_MAX_CHARS)
    }
  }

  return {
    write: (chunk) => {
      if (ended) return
      pending += typeof chunk === 'string' ? chunk : decoder.write(Buffer.from(chunk))
      drain()
    },
    end: () => {
      if (ended) return
      ended = true
      pending += decoder.end()
      drain()
      if (pending) emitLine(pending)
      pending = ''
    },
  }
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** 保留原始启动诊断，并确保清理 Promise 的失败也进入调用方可观察的 rejection。 */
async function rejectHarnessStartupAfterCleanup(
  startupError: unknown,
  cleanup: () => Promise<void>,
): Promise<never> {
  const original = errorOf(startupError)
  try {
    await cleanup()
  } catch (cleanupError) {
    const cleanupFailure = errorOf(cleanupError)
    throw new AggregateError(
      [original, cleanupFailure],
      `${original.message}；Harness 进程树清理失败：${cleanupFailure.message}`,
    )
  }
  throw original
}

/** 启动 dsh web：POSIX 用独立进程组；Windows 由 taskkill /T 管理进程树 */
export function startHarness(opts: {
  profile?: string
  cwd?: string
  port?: number
  /** Invocation-only overlays; the user's persistent profile patch remains untouched. */
  patchFiles?: string[]
  onLog?: (line: string) => void
  readyTimeoutMs?: number
  /** 子进程 spawn 后的同步回调（供调用方追踪 in-flight 进程，退出清理用） */
  onSpawn?: (proc: ChildProcess) => void
}, dependencies: StartHarnessDependencies = {}): Promise<HarnessHandle> {
  const resolveExec = dependencies.resolveExec ?? resolveDshExec
  const spawnProcess = dependencies.spawnProcess ?? spawn
  const platform = dependencies.platform ?? process.platform
  const stopProcess = dependencies.stopProcess ?? stopTree
  const waitForReady = dependencies.waitForReady ?? waitForHttp
  const now = dependencies.now ?? Date.now
  const setTimer = dependencies.setTimer ?? setTimeout
  const clearTimer = dependencies.clearTimer ?? clearTimeout
  let proc: ChildProcess
  let repairLog: string | null = null
  try {
    const exec = resolveExec()
    if (!exec) return Promise.reject(new Error('未找到 dsh 可执行文件（请先安装 DeepSeek Harness）'))
    const cwd = opts.cwd ?? homedir()
    const profile = opts.profile ?? 'web'
    const repairs = repairDirectoryPickerRows(dshHome(), profile)
    if (repairs.length > 0) repairLog = `harness: 已移除重复 DirectoryPicker 配置：${repairs.join(' | ')}`
    const args = [
      '--profile',
      opts.profile ?? 'web',
      ...(opts.patchFiles ?? []).flatMap((file) => ['--patch', file]),
      '--no-open',
      '--port',
      String(opts.port ?? 0),
    ]
    const plan = planDshSpawn(exec.exec, exec.node, args, {
      ...dependencies.spawnPlanDependencies,
      platform,
    })
    proc = spawnProcess(plan.executable, plan.args, {
      cwd,
      // Windows .cmd/.bat has already been resolved to node + JS argv. Never
      // pass dsh paths or arguments through cmd.exe.
      detached: platform !== 'win32',
      env: runtimePathEnv(profile, cwd),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    })
  } catch (error) {
    return Promise.reject(errorOf(error))
  }

  return new Promise((resolve, reject) => {
    let url: string | null = null
    let settled = false
    let polling = false
    const outputTail: string[] = []
    let outputTailChars = 0
    let sawDirectoryPickerDuplicate = false
    const readyDeadline = now() + (opts.readyTimeoutMs ?? 90_000)
    const pollingController = new AbortController()
    let timer: TimerHandle | undefined
    let detachLogListeners = (): void => {}
    const settle = (complete: () => void): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimer(timer)
      pollingController.abort()
      detachLogListeners()
      complete()
    }
    const fail = (error: unknown): void => {
      settle(() => {
        // 立即标记 settled，阻止并发 timeout/exit/output 再次结算；但只在进程树
        // 清理完成后才向调用方 reject，避免下一代 Harness 与旧进程重叠。
        void rejectHarnessStartupAfterCleanup(error, () => stopProcess(proc)).catch(reject)
      })
    }
    const pushOutputTail = (line: string): void => {
      const stored = line.length > STARTUP_LOG_MAX_CHARS
        ? `…${line.slice(-(STARTUP_LOG_MAX_CHARS - 1))}`
        : line
      outputTail.push(stored)
      outputTailChars += stored.length
      while (outputTail.length > STARTUP_LOG_MAX_LINES || outputTailChars > STARTUP_LOG_MAX_CHARS) {
        outputTailChars -= outputTail.shift()?.length ?? 0
      }
    }
    const processLine = (line: string): void => {
      if (settled || !line.trim()) return
      pushOutputTail(line)
      if (DIRECTORY_PICKER_DUP_RE.test(line)) sawDirectoryPickerDuplicate = true
      try {
        opts.onLog?.(line)
      } catch (error) {
        fail(new Error(`Harness onLog 回调失败：${errorOf(error).message}`, { cause: errorOf(error) }))
        return
      }
      // dsh 启动期致命错误：立即失败并携带原因，不等 180s 轮询超时
      const fatal = line.match(DSK_FATAL_RE)
      if (fatal) {
        fail(new Error(`dsh 启动失败：${fatal[1].slice(0, 400)}`))
        return
      }
      url ??= parseHarnessUrl(line)
      // 只允许一个 HTTP 轮询在飞，避免每个日志块都新起轮询
      if (url && !settled && !polling) {
        polling = true
        void (async () => {
          try {
            const ok = await waitForReady(harnessReadinessUrl(url!), { deadline: readyDeadline, signal: pollingController.signal })
            polling = false
            if (ok) settle(() => resolve({ url: url!, stop: () => stopProcess(proc), proc }))
          } catch (err) {
            polling = false
            fail(err)
          }
        })()
      }
    }

    const stdoutDecoder = createLogLineDecoder(processLine)
    const stderrDecoder = createLogLineDecoder(processLine)
    const attachLogStream = (
      stream: NodeJS.ReadableStream | null,
      decoder: LogLineDecoder,
      label: string,
    ): (() => void) => {
      if (!stream) return () => decoder.end()
      const onData = (chunk: Buffer | Uint8Array | string): void => {
        try {
          decoder.write(chunk)
        } catch (error) {
          fail(new Error(`Harness ${label} 日志解码失败：${errorOf(error).message}`, { cause: errorOf(error) }))
        }
      }
      const onEnd = (): void => {
        try {
          decoder.end()
        } catch (error) {
          fail(new Error(`Harness ${label} 尾部日志解码失败：${errorOf(error).message}`, { cause: errorOf(error) }))
        }
      }
      const onError = (error: unknown): void => fail(error)
      stream.on('data', onData)
      stream.once('end', onEnd)
      stream.on('error', onError)
      return () => {
        stream.removeListener('data', onData)
        stream.removeListener('end', onEnd)
        stream.removeListener('error', onError)
      }
    }
    const detachStdout = attachLogStream(proc.stdout, stdoutDecoder, 'stdout')
    const detachStderr = attachLogStream(proc.stderr, stderrDecoder, 'stderr')
    detachLogListeners = () => {
      detachStdout()
      detachStderr()
    }
    proc.on('error', (err) => {
      fail(err)
    })
    proc.on('close', (code) => {
      if (!settled) {
        // close follows stdio closure, but injectable/fake streams may omit end.
        stdoutDecoder.end()
        stderrDecoder.end()
        if (settled) return
        if (sawDirectoryPickerDuplicate) {
          fail(new Error(`dsh web 提前退出（code=${code}）：DirectoryPicker 服务重复注册；请删除 profile/home patch 中额外的 dsh-host-directory-picker-native、browse 或 auto 行，仅保留官方 directory-picker auto 行`))
          return
        }
        const detail = outputTail.join('\n').slice(-STARTUP_DIAGNOSTIC_MAX_CHARS)
        fail(new Error(`dsh web 提前退出（code=${code}）${detail ? `：${detail}` : ''}`))
      }
    })
    try {
      opts.onSpawn?.(proc)
      if (repairLog) opts.onLog?.(repairLog)
    } catch (error) {
      fail(new Error(`Harness 启动回调失败：${errorOf(error).message}`, { cause: errorOf(error) }))
    }
    if (!settled) {
      const scheduled = setTimer(
        () => fail(new Error('等待 dsh web 就绪超时')),
        Math.max(0, readyDeadline - now()),
      )
      timer = scheduled
      // Injectable timers may invoke synchronously; do not retain their handle
      // after the callback has already settled startup.
      if (settled) clearTimer(scheduled)
    }
  })
}

/** Windows：taskkill /T 终止整棵树；非零状态不能被误报为清理成功。 */
function taskkillTree(proc: ChildProcess, force: boolean): void {
  const pid = proc.pid
  if (pid === undefined || proc.exitCode !== null || proc.signalCode !== null) return
  const result = spawnSync('taskkill', ['/pid', String(pid), '/T', ...(force ? ['/F'] : [])], {
    windowsHide: true,
    encoding: 'utf8',
  })
  if (result.error) throw new Error(`taskkill 启动失败：${result.error.message}`, { cause: result.error })
  if (result.status === 0) return
  // taskkill 的「找不到进程」通常是 128；只在 ChildProcess 同时已经记录退出时
  // 才视为良性竞态，不能仅凭可本地化/可变化的 stderr 吞掉权限等真实失败。
  if (result.status === 128 && (proc.exitCode !== null || proc.signalCode !== null)) return
  const detail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim().slice(0, 500)
  throw new Error(`taskkill ${force ? '/F ' : ''}/T 失败（status=${result.status ?? 'null'}）${detail ? `：${detail}` : ''}`)
}

async function waitForChildExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return true
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      proc.removeListener('exit', onExit)
      resolve(proc.exitCode !== null || proc.signalCode !== null)
    }, timeoutMs)
    proc.once('exit', onExit)
  })
}

function processGroupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    // A permission error still proves that the group exists. The subsequent
    // real signal will surface the permission failure to the caller.
    if (code === 'EPERM') return true
    throw error
  }
}

function signalProcessGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function waitForProcessGroupExit(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (processGroupExists(pgid)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)))
  }
  return true
}

/** 终止整个进程树：先优雅停止，未退出时再强杀；始终绑定当前 ChildProcess，避免 PID 延时复用。 */
export async function stopTree(proc: ChildProcess): Promise<void> {
  const pid = proc.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    if (proc.exitCode !== null || proc.signalCode !== null) return
    let gracefulFailure: unknown
    try {
      taskkillTree(proc, false)
    } catch (error) {
      gracefulFailure = error
    }
    // 优雅窗口 800ms（非 2s）：安装器非 PowerShell 路径在 WM_CLOSE 后约 1300ms（300+1000）即 /F 强杀主进程；
    // 优雅清理须落在该窗口内，否则 stopTree 半途被 TerminateProcess → node.exe 孤儿
    if (gracefulFailure === undefined) {
      if (await waitForChildExit(proc, 800)) return
    } else if (await waitForChildExit(proc, 100)) {
      // taskkill 与 ChildProcess exit 事件的良性竞态：命令报告目标已消失，
      // 随后 Node 确认这一确切 child 已退出。
      return
    }
    try {
      taskkillTree(proc, true)
    } catch (forceFailure) {
      if (await waitForChildExit(proc, 100)) return
      if (gracefulFailure !== undefined) {
        throw new AggregateError([gracefulFailure, forceFailure], 'Windows 进程树停止失败')
      }
      throw forceFailure
    }
    if (await waitForChildExit(proc, 1_000)) return
    const timeout = new Error(`taskkill /F 返回成功，但进程树未在 1000ms 内退出（pid=${pid}）`)
    if (gracefulFailure !== undefined) throw new AggregateError([gracefulFailure, timeout], 'Windows 进程树停止失败')
    throw timeout
  }
  // detached leader 的 PID 同时是 PGID。leader 退出不代表同组孙进程已退出，
  // 因此只以原始 PGID 的存在性为准；首次观察到 ESRCH 后立即停止，避免继续
  // 触碰未来可能复用该数字的新进程组。
  if (!processGroupExists(pid) || !signalProcessGroup(pid, 'SIGTERM')) return
  if (await waitForProcessGroupExit(pid, 2000)) return
  if (!signalProcessGroup(pid, 'SIGKILL')) return
  // SIGKILL 已不可被忽略；短暂等待内核/父进程回收，避免调用方与旧组重叠。
  if (!await waitForProcessGroupExit(pid, 500)) {
    throw new Error(`SIGKILL 后进程组仍未退出（pgid=${pid}）`)
  }
}
