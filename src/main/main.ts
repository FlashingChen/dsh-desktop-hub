// Electron 主进程：窗口安全边界 + IPC（来源校验）+ harness 生命周期 + 插件/MCP/Skills 管理
import { app, BrowserWindow, ipcMain, Menu, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, isAbsolute, basename } from 'node:path'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  startHarness,
  resolveDshExec,
  dshHome,
  listProfiles,
  runtimePathEnv,
  type HarnessHandle,
  type DshProfile,
} from '../core/harness.js'
import {
  activatePlugin,
  deactivatePlugin,
  deactivatePluginIfActive,
  isPluginActive,
  listPlugins,
  runPluginOp,
  type PluginOpHandle,
} from '../core/plugins.js'
import {
  MCP_PLUGIN,
  convertJsonToYaml,
  extractMcpServers,
  replaceMcpRows,
  mergeMcpRows,
  updateMcpRow,
  deleteMcpRow,
  atomicWriteWithBackup,
  readPatch,
  type McpRow,
} from '../core/mcp.js'
import { scanSkills, createSkill, setInvocation, importSkillFromZip, importSkillFromGitHub, type SkillSummary } from '../core/skills.js'
import { IPC, type PluginOpAction, type HarnessStatus } from '../core/ipc.js'
import { wireSmoke } from './smoke.js'

const APP_NAME = 'DSH Desktop Hub'
const __dirname = dirname(fileURLToPath(import.meta.url))
const RENDERER_HTML = join(__dirname, '..', 'renderer', 'index.html')
const RENDERER_URL = `file://${RENDERER_HTML}`
const ARTIFACTS_DIR = join(__dirname, '..', '..', 'artifacts')

const argv = process.argv
const SMOKE = argv.includes('--smoke')
const HARNESS_SMOKE = argv.includes('--harness-smoke')
// 默认（无 flag）＝产品行为：加载 harness Web UI + 菜单「管理台」

app.setName(APP_NAME)
// Windows 任务栏分组/通知归属（须在 ready 前设置）；其他平台无此概念
if (process.platform === 'win32') app.setAppUserModelId('com.dshdesktophub.app')

let mainWindow: BrowserWindow | null = null
let harness: HarnessHandle | null = null
let restarting = false

/** M2 管理的目标 profile（与 harness 启动一致）；M5 将支持切换 */
const ACTIVE_PROFILE = 'web'

// ---- 单实例锁：两个实例同时操作同一 profile/patch 会写冲突（P2-11）----
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

function activeProfile(): DshProfile | null {
  return listProfiles(dshHome()).find((p) => p.name === ACTIVE_PROFILE) ?? null
}

// ---- IPC 来源校验（P1-2 / P2-9）：只接受壳层主帧，拒绝 harness iframe / 外部页 ----
function assertRendererSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame
  const isMainFrame = frame === event.sender.mainFrame
  if (!isMainFrame || frame?.url !== RENDERER_URL) {
    throw new Error('IPC 来源校验失败：拒绝非壳层主帧调用')
  }
}

/** 返回壳层主帧（存在且为我们的 renderer），供 push 事件使用 */
function shellWebContents(): WebContents | null {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.getURL() === RENDERER_URL) {
    return mainWindow.webContents
  }
  return null
}

// ---- profile 写操作串行化：插件 patch 与 MCP patch 都落在同一文件上（P1-5）----
let mutationChain: Promise<unknown> = Promise.resolve()
function serializeMutation<T>(task: () => Promise<T> | T): Promise<T> {
  const next = mutationChain.then(task, task)
  mutationChain = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

// ---- 插件操作：流式输出 + 可取消 + 有界缓冲（P1-5 / P2-10）----
const OP_OUTPUT_CAP = 64 * 1024
const activeOps = new Map<string, PluginOpHandle>()
let opSeq = 0

function appendCapped(buf: string, chunk: string): string {
  buf += chunk
  return buf.length > OP_OUTPUT_CAP ? buf.slice(buf.length - OP_OUTPUT_CAP) : buf
}

function streamPluginOp(
  action: PluginOpAction,
  args: string[],
): Promise<{ ok: boolean; token?: string; error?: string; exitCode?: number | null }> {
  const exec = resolveDshExec()
  if (!exec) return Promise.resolve({ ok: false, error: '未找到 dsh 可执行文件' })
  return serializeMutation(async () => {
    const token = `op-${++opSeq}`
    const op = runPluginOp({
      dsh: exec.exec,
      node: exec.node,
      profile: ACTIVE_PROFILE,
      action,
      args,
      env: runtimePathEnv(),
    })
    activeOps.set(token, op)
    // 每次推送取最新 webContents；窗口可能在长操作期间销毁，send 需防御（P3）
    const sendToShell = (channel: string, ...payload: unknown[]): void => {
      try {
        shellWebContents()?.send(channel, ...payload)
      } catch {
        /* 窗口已销毁：忽略推送，操作结果仍由有界缓冲保存 */
      }
    }
    sendToShell(IPC.pluginOpChunk, token, `dsh plugin --profile ${ACTIVE_PROFILE} ${action} ${args.join(' ')}\n`)
    let output = ''
    const onChunk = (buf: Buffer): void => {
      const text = String(buf)
      output = appendCapped(output, text)
      sendToShell(IPC.pluginOpChunk, token, text)
    }
    op.stdout.on('data', onChunk)
    op.stderr.on('data', onChunk)
    const res = await op.done
    activeOps.delete(token)
    sendToShell(IPC.pluginOpDone, token, {
      token,
      exitCode: res.exitCode,
      signal: res.signal,
      output,
    })
    return { ok: true, token, exitCode: res.exitCode }
  })
}

// ---- Skills 路径 allowlist（P1-2）：按 ID 重扫 → 取扫描结果路径 → realpath 域校验 ----
function resolveSkillRoot(source: SkillSummary['source']): string {
  // Windows 无 HOME 环境变量（USERPROFILE 才是主目录），必须用 os.homedir()
  const home = homedir()
  switch (source) {
    case 'user-dsh':
      return join(dshHome(), 'skills')
    case 'user-agents':
      return join(home, '.agents', 'skills')
    default:
      throw new Error(`skill 来源「${source}」不允许通过壳层修改`)
  }
}

function resolveScannedSkill(name: string, source: SkillSummary['source']): SkillSummary {
  const skills = scanSkills({ dshHome: dshHome() })
  const skill = skills.find((s) => s.name === name && s.source === source)
  if (!skill) throw new Error(`skill「${name}」（${source}）不存在或不在允许的扫描根内`)
  const root = resolveSkillRoot(source)
  const pathReal = realpathSync(skill.path)
  const rootReal = realpathSync(root)
  // 域校验用 relative 判定，避免平台分隔符/大小写差异（Windows \\ 与不区分大小写）
  const rel = relative(rootReal, pathReal)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`skill 路径越界: ${skill.path}`)
  }
  const base = dirname(pathReal).split(/[\\/]/).pop() ?? ''
  const isBundle = basename(pathReal) === 'SKILL.md' && base === name
  const isFlat = basename(pathReal) === `${name}.md`
  if (!isBundle && !isFlat) throw new Error(`skill 不是扫描到的 SKILL.md 或扁平文件: ${pathReal}`)
  return skill
}

// ---- IPC 注册 ----
function registerIpc(): void {
  ipcMain.handle(IPC.harnessUrl, (event) => {
    assertRendererSender(event)
    return harness?.url ?? null
  })

  ipcMain.handle(IPC.harnessRestart, async (event) => {
    assertRendererSender(event)
    if (restarting) return { ok: false as const, error: 'Harness 正在重启中' }
    restarting = true
    const wc = shellWebContents()
    wc?.send(IPC.harnessStatus, { state: 'restarting' } satisfies HarnessStatus)
    try {
      await harness?.stop()
      harness = null
      const next = await startHarness({ profile: ACTIVE_PROFILE, readyTimeoutMs: 120_000 })
      harness = next
      watchHarness(next.proc)
      wc?.send(IPC.harnessStatus, { state: 'ready', url: next.url } satisfies HarnessStatus)
      return { ok: true as const, url: next.url }
    } catch (err) {
      wc?.send(IPC.harnessStatus, { state: 'exited', code: -1 } satisfies HarnessStatus)
      return { ok: false as const, error: (err as Error).message }
    } finally {
      restarting = false
    }
  })

  ipcMain.handle(IPC.pluginsList, (event) => {
    assertRendererSender(event)
    const profile = activeProfile()
    if (!profile) return { ok: false as const, error: `profile「${ACTIVE_PROFILE}」不存在`, entries: [] }
    try {
      const patch = readPatch(profile.dir)
      const entries = listPlugins(profile, patch)
      return { ok: true as const, profile: ACTIVE_PROFILE, entries }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, entries: [] }
    }
  })

  ipcMain.handle(IPC.pluginsActivate, (event, name: unknown) => {
    assertRendererSender(event)
    const profile = activeProfile()
    if (!profile) return { ok: false as const, error: `profile「${ACTIVE_PROFILE}」不存在`, output: '' }
    if (typeof name !== 'string' || !name.trim()) return { ok: false as const, error: 'name 无效', output: '' }
    const packageName = name.trim()
    try {
      const entry = listPlugins(profile, readPatch(profile.dir)).find((candidate) => candidate.name === packageName)
      if (!entry) return { ok: false as const, error: `插件「${packageName}」未安装`, output: '' }
      if (entry.activationSource === 'bundle') {
        return { ok: false as const, error: `「${packageName}」由组合包激活，无需单独激活`, output: '' }
      }
      if (entry.activationSource === 'patch') {
        return { ok: true as const, output: '插件已经激活', backup: '' }
      }
      return serializeMutation(() => {
        const patch = readPatch(profile.dir)
        const result = writePluginPatch(profile, activatePlugin(patch, packageName))
        return { ...result, output: `插件「${packageName}」已激活；请重启 Harness` }
      })
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, output: '' }
    }
  })

  ipcMain.handle(IPC.pluginsDeactivate, (event, name: unknown) => {
    assertRendererSender(event)
    const profile = activeProfile()
    if (!profile) return { ok: false as const, error: `profile「${ACTIVE_PROFILE}」不存在`, output: '' }
    if (typeof name !== 'string' || !name.trim()) return { ok: false as const, error: 'name 无效', output: '' }
    const packageName = name.trim()
    try {
      const entry = listPlugins(profile, readPatch(profile.dir)).find((candidate) => candidate.name === packageName)
      if (!entry) return { ok: false as const, error: `插件「${packageName}」未安装`, output: '' }
      if (entry.activationSource === 'bundle') {
        return { ok: false as const, error: `「${packageName}」由组合包激活，不能单独停用（停用只对 patch 手动激活的插件生效）`, output: '' }
      }
      if (entry.activationSource === 'none') {
        return { ok: false as const, error: `插件「${packageName}」未激活`, output: '' }
      }
      return serializeMutation(() => {
        const patch = readPatch(profile.dir)
        const result = writePluginPatch(profile, deactivatePlugin(patch, packageName))
        return { ...result, output: `插件「${packageName}」已停用；package 依赖仍保留` }
      })
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, output: '' }
    }
  })

  ipcMain.handle(IPC.pluginsStartOp, async (event, action: unknown, args: unknown) => {
    assertRendererSender(event)
    if (action !== 'add' && action !== 'remove' && action !== 'update') {
      return { ok: false as const, error: 'action 无效' }
    }
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      return { ok: false as const, error: 'args 无效' }
    }
    if (action === 'add' && args.length !== 1) return { ok: false as const, error: '安装需要 spec 参数' }
    const res = await streamPluginOp(action, args as string[])
    // remove 成功后清理残留的 patch 激活行（P1：避免重启后引用不存在的插件）
    if (action === 'remove' && res.ok && res.exitCode === 0) {
      try {
        await serializeMutation(() => {
          const profile = activeProfile()
          if (!profile) return
          const patch = readPatch(profile.dir)
          const cleaned = deactivatePluginIfActive(patch, (args as string[])[0])
          if (cleaned !== patch) writePluginPatch(profile, cleaned)
        })
      } catch (err) {
        console.error(`remove 后 patch 激活行清理失败: ${(err as Error).message}`)
      }
    }
    return res
  })

  ipcMain.handle(IPC.pluginsCancelOp, (event, token: unknown) => {
    assertRendererSender(event)
    if (typeof token !== 'string') return { ok: false as const }
    const op = activeOps.get(token)
    if (!op) return { ok: false as const }
    op.cancel()
    return { ok: true as const }
  })

  ipcMain.handle(IPC.mcpList, (event) => {
    assertRendererSender(event)
    const profile = activeProfile()
    if (!profile) return { ok: false as const, error: `profile「${ACTIVE_PROFILE}」不存在`, servers: [] }
    try {
      const servers = extractMcpServers(readPatch(profile.dir))
      return { ok: true as const, profile: ACTIVE_PROFILE, servers }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, servers: [] }
    }
  })

  ipcMain.handle(IPC.mcpConvert, (event, jsonText: unknown) => {
    assertRendererSender(event)
    if (typeof jsonText !== 'string') return { ok: false as const, error: '输入无效', yaml: '', warnings: [] }
    return convertJsonToYaml(jsonText)
  })

  ipcMain.handle(IPC.mcpApply, (event, input: unknown) => {
    assertRendererSender(event)
    const profile = activeProfile()
    if (!profile) return { ok: false as const, error: `profile「${ACTIVE_PROFILE}」不存在`, backup: '' }
    const payload = (input ?? {}) as { rows?: unknown; mode?: unknown }
    if (!Array.isArray(payload.rows) || payload.rows.length === 0) {
      return { ok: false as const, error: '没有可写入的服务器', backup: '' }
    }
    const mode = payload.mode === 'replace' ? 'replace' : 'merge'
    const normalized = payload.rows.map(normalizeMcpRow)
    if (normalized.some((row): row is null => row === null)) {
      return { ok: false as const, error: 'MCP 服务器格式无效', backup: '' }
    }
    try {
      return serializeMutation(() => {
        const patch = readPatch(profile.dir)
        const next = mode === 'replace' ? replaceMcpRows(patch, normalized as McpRow[]) : mergeMcpRows(patch, normalized as McpRow[])
        return writeMcpPatch(profile, next, extractMcpServers(next).length)
      })
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, backup: '' }
    }
  })

  ipcMain.handle(IPC.mcpUpdate, (event, input: unknown) => {
    assertRendererSender(event)
    const profile = activeProfile()
    if (!profile) return { ok: false as const, error: `profile「${ACTIVE_PROFILE}」不存在`, backup: '' }
    if (!input || typeof input !== 'object') return { ok: false as const, error: '输入无效', backup: '' }
    const payload = input as { id?: unknown; row?: unknown }
    const id = typeof payload.id === 'string' ? payload.id.trim() : ''
    if (!id) return { ok: false as const, error: 'MCP id 无效', backup: '' }
    const row = normalizeMcpRow(payload.row)
    if (!row) return { ok: false as const, error: 'MCP 服务器格式无效', backup: '' }
    try {
      return serializeMutation(() => {
        const next = updateMcpRow(readPatch(profile.dir), { ...row, id })
        return writeMcpPatch(profile, next, extractMcpServers(next).length)
      })
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, backup: '' }
    }
  })

  ipcMain.handle(IPC.mcpDelete, (event, id: unknown) => {
    assertRendererSender(event)
    const profile = activeProfile()
    if (!profile) return { ok: false as const, error: `profile「${ACTIVE_PROFILE}」不存在`, backup: '' }
    if (typeof id !== 'string' || !id.trim()) return { ok: false as const, error: 'MCP id 无效', backup: '' }
    try {
      return serializeMutation(() => {
        const next = deleteMcpRow(readPatch(profile.dir), id.trim())
        return writeMcpPatch(profile, next, extractMcpServers(next).length)
      })
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, backup: '' }
    }
  })

  ipcMain.handle(IPC.skillsList, (event) => {
    assertRendererSender(event)
    try {
      // 随包 skills：官方 Config.bundledSkillDir 默认取 $DSH_BUNDLED_SKILL_DIR，存在才扫描
      const bundledDir = process.env.DSH_BUNDLED_SKILL_DIR || undefined
      return { ok: true as const, skills: scanSkills({ dshHome: dshHome(), bundledDir }) }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, skills: [] }
    }
  })

  ipcMain.handle(IPC.skillsCreate, (event, input: unknown) => {
    assertRendererSender(event)
    const payload = input as { name?: unknown; description?: unknown; body?: unknown }
    if (typeof payload.name !== 'string' || typeof payload.description !== 'string' || typeof payload.body !== 'string') {
      return { ok: false as const, error: '输入无效', path: '' }
    }
    try {
      const path = createSkill({
        root: join(dshHome(), 'skills'),
        name: payload.name,
        description: payload.description,
        body: payload.body,
      })
      return { ok: true as const, path }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, path: '' }
    }
  })

  ipcMain.handle(IPC.skillsToggle, (event, input: unknown) => {
    assertRendererSender(event)
    const payload = input as { id?: unknown; source?: unknown; kind?: unknown; value?: unknown }
    if (typeof payload.id !== 'string' || !payload.id.trim()) return { ok: false as const, error: 'skill id 无效' }
    if (payload.kind !== 'model' && payload.kind !== 'user') return { ok: false as const, error: 'kind 无效' }
    if (typeof payload.value !== 'boolean') return { ok: false as const, error: 'value 无效' }
    try {
      const skill = resolveScannedSkill(payload.id.trim(), payload.source as SkillSummary['source'])
      setInvocation(skill.path, payload.kind, payload.value)
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC.skillsImportFile, (event, buffer: unknown, overwrite: unknown) => {
    assertRendererSender(event)
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) return { ok: false as const, error: '文件无效', result: null }
    if (buffer.byteLength > 20 * 1024 * 1024) return { ok: false as const, error: '文件超过 20MB 上限', result: null }
    try {
      const result = importSkillFromZip(Buffer.from(buffer), { root: join(dshHome(), 'skills'), overwrite: overwrite === true })
      return { ok: true as const, result }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, result: null }
    }
  })

  ipcMain.handle(IPC.skillsImportUrl, async (event, url: unknown, overwrite: unknown) => {
    assertRendererSender(event)
    if (typeof url !== 'string' || !url.trim()) return { ok: false as const, error: '链接无效', result: null }
    try {
      const result = await importSkillFromGitHub(url, { root: join(dshHome(), 'skills'), overwrite: overwrite === true })
      return { ok: true as const, result }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, result: null }
    }
  })
}

// ---- patch 写入助手 ----
function writeMcpPatch(profile: { dir: string }, next: string, rowCount: number) {
  const patchFile = join(profile.dir, 'cordis.patch.yml')
  const backup = atomicWriteWithBackup(patchFile, next)
  return { ok: true as const, backup, rows: rowCount }
}

function writePluginPatch(profile: { dir: string }, next: string) {
  const patchFile = join(profile.dir, 'cordis.patch.yml')
  const backup = atomicWriteWithBackup(patchFile, next)
  return { ok: true as const, backup }
}

function normalizeMcpRow(value: unknown): McpRow | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Partial<McpRow>
  if (!row.config || typeof row.config !== 'object' || Array.isArray(row.config)) return null
  if (typeof row.id !== 'string' || !row.id.trim()) return null
  return { id: row.id.trim(), name: MCP_PLUGIN, config: row.config as Record<string, unknown> }
}

// ---- 窗口与安全 ----
function isAllowedNavigation(url: string): boolean {
  if (url === RENDERER_URL) return true
  if (/^file:\/\/.+?\/dist\/renderer\/index\.html$/.test(url)) return true
  return /^http:\/\/127\.0\.0\.1:\d+/.test(url)
}

function hardenWindow(win: BrowserWindow): void {
  // 拒绝任意 popup：http(s) 外部链接交给系统浏览器，其余一律 deny（P2-9）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })
  // 主帧导航白名单：只允许壳层 renderer 与 harness loopback
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault()
  })
  // 权限请求全拒（摄像头/麦克风/地理位置等与壳无关）
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  win.webContents.session.setPermissionCheckHandler(() => false)
}

function createWindow(url: string): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: APP_NAME,
    show: !(SMOKE || HARNESS_SMOKE),
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  hardenWindow(mainWindow)
  void mainWindow.loadURL(url)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function createSkeletonWindow(): void {
  createWindow(RENDERER_URL)
  // harness iframe 导航完成时推送状态（iframe load 事件对长连接页面不可靠）
  mainWindow?.webContents.on('did-frame-navigate', (_e, frameURL, _code, _status, isMainFrame) => {
    if (!isMainFrame && harness && frameURL.startsWith(harness.url)) {
      mainWindow?.webContents.send(IPC.harnessFrameLoaded, frameURL)
      mainWindow?.webContents.send(IPC.harnessStatus, { state: 'ready', url: harness.url } satisfies HarnessStatus)
    }
  })
}

// ---- harness 生命周期监控（P2-11）：意外退出 → 通知 UI，可一键重启 ----
function watchHarness(proc: HarnessHandle['proc']): void {
  proc.on('exit', (code, signal) => {
    if (restarting) return
    harness = null
    mainWindow?.webContents.send(IPC.harnessStatus, { state: 'exited', code, signal } satisfies HarnessStatus)
  })
}

async function startHarnessAndWatch(): Promise<void> {
  harness = await startHarness({ profile: ACTIVE_PROFILE, readyTimeoutMs: 120_000 })
  watchHarness(harness.proc)
  console.log(`harness ready: ${harness.url}`)
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      // Windows 无 app 菜单（菜单在窗口内），首项用「文件」更符合平台习惯；mac 用 app 名
      { label: process.platform === 'win32' ? '文件' : APP_NAME, submenu: [{ role: 'quit', label: '退出' }] },
      {
        label: '编辑',
        submenu: [
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { role: 'selectAll', label: '全选' },
        ],
      },
      {
        label: '窗口',
        submenu: [{ role: 'togglefullscreen', label: '全屏' }],
      },
    ]),
  )
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(async () => {
  registerIpc()
  if (SMOKE) {
    createSkeletonWindow()
    wireSmoke({ mainWindow: () => mainWindow, harness: () => harness, artifactsDir: ARTIFACTS_DIR, harnessSmoke: false })
    return
  }
  if (HARNESS_SMOKE) {
    try {
      await startHarnessAndWatch()
    } catch (err) {
      console.error(`harness 启动失败: ${String(err)}`)
      app.exit(1)
      return
    }
    createSkeletonWindow()
    wireSmoke({ mainWindow: () => mainWindow, harness: () => harness, artifactsDir: ARTIFACTS_DIR, harnessSmoke: true })
    return
  }
  // 默认产品行为：主窗口＝四 Tab 壳，Harness Tab 内嵌官方 Web UI
  buildMenu()
  try {
    await startHarnessAndWatch()
  } catch (err) {
    console.error(`harness 启动失败: ${String(err)}`)
    app.exit(1)
    return
  }
  createSkeletonWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createSkeletonWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let quitting = false
app.on('will-quit', (e) => {
  if (harness && !quitting) {
    quitting = true
    e.preventDefault()
    void harness.stop().finally(() => app.quit())
  }
})
