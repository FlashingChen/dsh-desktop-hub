import { app, BrowserWindow, ipcMain, Menu } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { startHarness, resolveDshExec, dshHome, listProfiles, type HarnessHandle } from '../core/harness.js'
import { listPlugins, runPluginOp } from '../core/plugins.js'
import {
  convertJsonToYaml,
  extractMcpServers,
  replaceMcpRows,
  atomicWriteWithBackup,
  readPatch,
  type McpRow,
} from '../core/mcp.js'
import { scanSkills, createSkill, setInvocation } from '../core/skills.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RENDERER_HTML = join(__dirname, '..', 'renderer', 'index.html')

const argv = process.argv
const SMOKE = argv.includes('--smoke')
const HARNESS_SMOKE = argv.includes('--harness-smoke')
// 默认（无 flag）＝产品行为：加载 harness Web UI + 菜单「管理台」

let mainWindow: BrowserWindow | null = null
let managementWindow: BrowserWindow | null = null
let harness: HarnessHandle | null = null

/** M2 管理的目标 profile（与 harness 启动一致）；M5 将支持切换 */
const ACTIVE_PROFILE = 'web'

function activeProfile() {
  return listProfiles(dshHome()).find((p) => p.name === ACTIVE_PROFILE) ?? null
}

async function runPluginMutation(action: 'add' | 'remove' | 'update', args: string[]) {
  const exec = resolveDshExec()
  if (!exec) return { ok: false as const, error: '未找到 dsh 可执行文件', output: '' }
  const op = runPluginOp({ dsh: exec.exec, node: exec.node, profile: ACTIVE_PROFILE, action, args })
  let output = ''
  op.stdout.on('data', (d: Buffer) => (output += String(d)))
  op.stderr.on('data', (d: Buffer) => (output += String(d)))
  const res = await op.done
  return { ok: res.exitCode === 0, exitCode: res.exitCode, output: output.slice(0, 2000) }
}

function registerIpc(): void {
  ipcMain.handle('plugins:list', () => {
    const profile = activeProfile()
    if (!profile) return { ok: false as const, error: `profile「${ACTIVE_PROFILE}」不存在`, entries: [] }
    return { ok: true as const, profile: ACTIVE_PROFILE, entries: listPlugins(profile) }
  })
  ipcMain.handle('plugins:install', (_e, spec: string) => {
    if (typeof spec !== 'string' || !spec.trim()) return { ok: false as const, error: 'spec 无效', output: '' }
    return runPluginMutation('add', [spec.trim()])
  })
  ipcMain.handle('plugins:remove', (_e, name: string) => {
    if (typeof name !== 'string' || !name.trim()) return { ok: false as const, error: 'name 无效', output: '' }
    return runPluginMutation('remove', [name.trim()])
  })
  ipcMain.handle('plugins:update', () => runPluginMutation('update', []))
  ipcMain.handle('mcp:list', () => {
    const profile = activeProfile()
    if (!profile) return { ok: false as const, error: `profile「${ACTIVE_PROFILE}」不存在`, servers: [] }
    try {
      const servers = extractMcpServers(readPatch(profile.dir)).map((r) => ({
        id: r.id,
        config: r.config as Record<string, unknown>,
      }))
      return { ok: true as const, profile: ACTIVE_PROFILE, servers }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, servers: [] }
    }
  })
  ipcMain.handle('mcp:convert', (_e, jsonText: string) => {
    if (typeof jsonText !== 'string') return { ok: false as const, error: '输入无效', yaml: '', warnings: [] }
    return convertJsonToYaml(jsonText)
  })
  ipcMain.handle('mcp:apply', (_e, rows: McpRow[]) => {
    const profile = activeProfile()
    if (!profile) return { ok: false as const, error: `profile「${ACTIVE_PROFILE}」不存在`, backup: '' }
    if (!Array.isArray(rows) || rows.length === 0) return { ok: false as const, error: '没有可写入的服务器', backup: '' }
    try {
      const patchFile = join(profile.dir, 'cordis.patch.yml')
      const next = replaceMcpRows(readPatch(profile.dir), rows)
      const backup = atomicWriteWithBackup(patchFile, next)
      return { ok: true as const, backup, rows: rows.length }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, backup: '' }
    }
  })
  ipcMain.handle('skills:list', () => {
    try {
      return { ok: true as const, skills: scanSkills({ dshHome: dshHome() }) }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, skills: [] }
    }
  })
  ipcMain.handle('skills:create', (_e, input: { name: string; description: string; body: string }) => {
    if (!input || typeof input.name !== 'string' || typeof input.description !== 'string' || typeof input.body !== 'string') {
      return { ok: false as const, error: '输入无效', path: '' }
    }
    try {
      const path = createSkill({ root: join(dshHome(), 'skills'), name: input.name, description: input.description, body: input.body })
      return { ok: true as const, path }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, path: '' }
    }
  })
  ipcMain.handle('skills:toggle', (_e, input: { path: string; kind: 'model' | 'user'; value: boolean }) => {
    if (!input || typeof input.path !== 'string' || !['model', 'user'].includes(input.kind)) {
      return { ok: false as const, error: '输入无效' }
    }
    try {
      setInvocation(input.path, input.kind, input.value)
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })
}

function createWindow(url: string): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'DSH Desktop',
    show: !(SMOKE || HARNESS_SMOKE),
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  void mainWindow.loadURL(url)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function createSkeletonWindow(): void {
  createWindow(`file://${RENDERER_HTML}`)
}

function openManagementWindow(): void {
  if (managementWindow && !managementWindow.isDestroyed()) {
    managementWindow.focus()
    return
  }
  managementWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    title: 'DSH Desktop 管理台',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  void managementWindow.loadFile(RENDERER_HTML)
  managementWindow.on('closed', () => {
    managementWindow = null
  })
}

async function assertDomAndScreenshot(tag: string, assert: (dom: unknown) => boolean, exitAfter = true): Promise<void> {
  const dom = (await mainWindow!.webContents.executeJavaScript(`(() => {
    const tabs = [...document.querySelectorAll('[data-tab]')].map(b => b.dataset.tab)
    const active = document.querySelector('.tab.active')?.dataset.tab
    const panels = ['harness','plugin','mcp','skills'].map(t => !!document.getElementById('panel-' + t))
    const pluginRows = [...document.querySelectorAll('#plugin-rows tr')].map(r => r.textContent ?? '')
    return {
      tabs, active, panels, title: document.title, bodyLen: document.body.innerText.length, pluginRows,
      apiPresent: !!window.dshDesktop,
      pluginStatus: document.getElementById('plugin-status')?.textContent ?? '',
      pluginErr: document.getElementById('plugin-status')?.className ?? '',
    }
  })()`)) as {
    tabs?: string[]
    active?: string
    panels?: boolean[]
    title: string
    bodyLen: number
    pluginRows?: string[]
    apiPresent?: boolean
    pluginStatus?: string
    pluginErr?: string
  }
  if (!assert(dom)) {
    console.error(`SMOKE FAIL: unexpected DOM ${JSON.stringify(dom)}`)
    app.exit(1)
  }
  const image = await mainWindow!.webContents.capturePage()
  const out = join(__dirname, '..', '..', 'artifacts', `${tag}.png`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, image.toPNG())
  console.log(`SMOKE OK: ${tag} DOM ${JSON.stringify({ title: dom.title, bodyLen: dom.bodyLen })} screenshot ${out}`)
  if (exitAfter) app.exit(0)
}

function wireSmoke(): void {
  mainWindow?.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`SMOKE FAIL: load failed (${code} ${desc})`)
    app.exit(1)
  })
  if (SMOKE) {
    mainWindow?.webContents.once('did-finish-load', () => {
      void (async () => {
        // 等待 Plugin 面板通过 IPC 加载真实 profile 插件
        const deadline = Date.now() + 5000
        while (Date.now() < deadline) {
          const ready = await mainWindow!.webContents.executeJavaScript(
            `document.querySelectorAll('#plugin-rows tr').length > 0 && document.getElementById('mcp-servers').textContent.length > 0 && document.querySelectorAll('#skills-rows tr').length > 0`,
          )
          if (ready) break
          await new Promise((r) => setTimeout(r, 200))
        }
        // 驱动 MCP JSON→YAML 转换（只读，不写 profile）
        await mainWindow!.webContents.executeJavaScript(`(() => {
          const ta = document.getElementById('mcp-json')
          ta.value = JSON.stringify({ mcpServers: {
            github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'x' } },
            remote: { type: 'http', url: 'https://mcp.example.com/search', headers: { Authorization: 'Bearer t' } }
          }})
          document.getElementById('mcp-convert').click()
        })()`)
        const convDeadline = Date.now() + 5000
        while (Date.now() < convDeadline) {
          const done = await mainWindow!.webContents.executeJavaScript(
            `document.getElementById('mcp-preview').textContent.length > 0`,
          )
          if (done) break
          await new Promise((r) => setTimeout(r, 200))
        }
        await assertDomAndScreenshot('m0-smoke', (dom) => {
          const d = dom as { tabs?: string[]; active?: string; panels?: boolean[]; title: string; pluginRows?: string[] }
          const rows = d.pluginRows ?? []
          return (
            JSON.stringify(d.tabs) === JSON.stringify(['harness', 'plugin', 'mcp', 'skills']) &&
            d.active === 'harness' &&
            (d.panels?.every(Boolean) ?? false) &&
            d.title === 'DSH Desktop' &&
            rows.length >= 4 &&
            rows.some((r) => r.includes('dsh-base'))
          )
        }, false)
        // MCP 转换结果单独校验
        const mcp = (await mainWindow!.webContents.executeJavaScript(`(() => {
          const preview = document.getElementById('mcp-preview').textContent
          const warnings = document.getElementById('mcp-warnings').textContent
          return { preview, warnings, servers: document.getElementById('mcp-servers').textContent }
        })()`)) as { preview: string; warnings: string; servers: string }
        if (!mcp.preview.includes('dsh-mcp-client') || !mcp.preview.includes('streamable-http')) {
          console.error(`SMOKE FAIL: MCP 转换异常 ${JSON.stringify(mcp)}`)
          app.exit(1)
        }
        console.log(`SMOKE OK: MCP convert 端到端通过（${JSON.stringify(mcp.servers)}）`)
        // Skills 列表校验（真实 ~/.dsh/skills）
        const skills = (await mainWindow!.webContents.executeJavaScript(`(() => {
          const rows = [...document.querySelectorAll('#skills-rows tr')].map(r => r.textContent ?? '')
          const status = document.getElementById('skills-status').textContent
          return { rows, status }
        })()`)) as { rows: string[]; status: string }
        if (!skills.rows.some((r) => r.includes('huashu-design')) || !skills.status.includes('共')) {
          console.error(`SMOKE FAIL: Skills 加载异常 ${JSON.stringify(skills)}`)
          app.exit(1)
        }
        console.log(`SMOKE OK: Skills 真实数据加载（${JSON.stringify(skills.status)}）`)
        app.exit(0)
      })()
    })
  } else if (HARNESS_SMOKE) {
    mainWindow?.webContents.once('did-finish-load', () => {
      void assertDomAndScreenshot('m1-harness', (dom) => {
        const d = dom as { title: string; bodyLen: number }
        return d.title.length > 0 && d.bodyLen > 0
      })
    })
  }
}

app.whenReady().then(async () => {
  registerIpc()
  if (SMOKE) {
    createSkeletonWindow()
    wireSmoke()
    return
  }
  if (HARNESS_SMOKE) {
    try {
      harness = await startHarness({ profile: 'web', readyTimeoutMs: 120_000 })
      console.log(`harness ready: ${harness.url}`)
    } catch (err) {
      console.error(`harness 启动失败: ${String(err)}`)
      app.exit(1)
      return
    }
    createWindow(harness.url)
    wireSmoke()
    return
  }
  // 默认产品行为：harness Web UI + 菜单管理台
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: 'DSH Desktop', submenu: [{ role: 'quit', label: '退出' }] },
      {
        label: '窗口',
        submenu: [
          { label: '管理台（Plugin / MCP / Skills）', click: () => openManagementWindow() },
          { type: 'separator' },
          { role: 'togglefullscreen', label: '全屏' },
        ],
      },
    ]),
  )
  try {
    harness = await startHarness({ profile: 'web', readyTimeoutMs: 120_000 })
    console.log(`harness ready: ${harness.url}`)
  } catch (err) {
    console.error(`harness 启动失败: ${String(err)}`)
    app.exit(1)
    return
  }
  createWindow(harness.url)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(harness!.url)
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
