import { app, BrowserWindow, ipcMain, Menu } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { startHarness, resolveDshExec, dshHome, listProfiles, type HarnessHandle } from '../core/harness.js'
import {
  activatePlugin,
  classifyInstallSpec,
  deactivatePlugin,
  isPluginActive,
  listPlugins,
  runPluginOp,
} from '../core/plugins.js'
import {
  MCP_PLUGIN,
  convertJsonToYaml,
  extractMcpServers,
  replaceMcpRows,
  updateMcpRow,
  deleteMcpRow,
  atomicWriteWithBackup,
  readPatch,
  type McpRow,
} from '../core/mcp.js'
import { scanSkills, createSkill, setInvocation, importSkillFromZip, importSkillFromGitHub } from '../core/skills.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RENDERER_HTML = join(__dirname, '..', 'renderer', 'index.html')

const argv = process.argv
const SMOKE = argv.includes('--smoke')
const HARNESS_SMOKE = argv.includes('--harness-smoke')
// 默认（无 flag）＝产品行为：加载 harness Web UI + 菜单「管理台」

let mainWindow: BrowserWindow | null = null
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

function normalizeMcpRow(value: unknown): McpRow | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Partial<McpRow>
  if (!row.config || typeof row.config !== 'object' || Array.isArray(row.config)) return null
  if (typeof row.id !== 'string' || !row.id.trim()) return null
  return { id: row.id.trim(), name: MCP_PLUGIN, config: row.config as Record<string, unknown> }
}

function writeMcpPatch(profile: { dir: string }, next: string, rowCount: number) {
  const patchFile = join(profile.dir, 'cordis.patch.yml')
  const backup = atomicWriteWithBackup(patchFile, next)
  return { ok: true as const, backup, rows: rowCount }
}

function writeMcpRows(profile: { dir: string }, rows: McpRow[]) {
  return writeMcpPatch(profile, replaceMcpRows(readPatch(profile.dir), rows), rows.length)
}
function writePluginPatch(profile: { dir: string }, next: string) {
  const patchFile = join(profile.dir, 'cordis.patch.yml')
  const backup = atomicWriteWithBackup(patchFile, next)
  return { ok: true as const, backup }
}

function registerIpc(): void {
  ipcMain.handle('harness:url', () => harness?.url ?? null)
  ipcMain.handle('plugins:list', () => {
    const profile = activeProfile()
    if (!profile) return { ok: false as const, error: `profile「${ACTIVE_PROFILE}」不存在`, entries: [] }
    try {
      const patch = readPatch(profile.dir)
      const entries = listPlugins(profile).map((entry) => ({
        ...entry,
        active: entry.active || isPluginActive(patch, entry.name),
      }))
      return { ok: true as const, profile: ACTIVE_PROFILE, entries }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, entries: [] }
    }
  })
  ipcMain.handle('plugins:install', (_e, spec: string) => {
    if (typeof spec !== 'string' || !spec.trim()) return { ok: false as const, error: 'spec 无效', output: '' }
    const plan = classifyInstallSpec(spec)
    if (plan.kind === 'routing-suite') {
      return { ok: false as const, error: plan.message, output: '', code: 'routing-suite-not-a-plugin' as const }
    }
    return runPluginMutation('add', [plan.normalized])
  })
  ipcMain.handle('plugins:activate', (_e, name: string) => {
    const profile = activeProfile()
    if (!profile) return { ok: false as const, error: `profile「${ACTIVE_PROFILE}」不存在`, output: '' }
    if (typeof name !== 'string' || !name.trim()) return { ok: false as const, error: 'name 无效', output: '' }
    const packageName = name.trim()
    const entry = listPlugins(profile).find((candidate) => candidate.name === packageName)
    if (!entry) return { ok: false as const, error: `插件「${packageName}」未安装`, output: '' }
    if (entry.builtin) return { ok: false as const, error: '内置组合包无需单独激活', output: '' }
    try {
      const patch = readPatch(profile.dir)
      if (isPluginActive(patch, packageName)) return { ok: true as const, output: '插件已经激活', backup: '' }
      const result = writePluginPatch(profile, activatePlugin(patch, packageName))
      return { ...result, output: `插件「${packageName}」已激活；请重启 Harness` }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, output: '' }
    }
  })
  ipcMain.handle('plugins:deactivate', (_e, name: string) => {
    const profile = activeProfile()
    if (!profile) return { ok: false as const, error: `profile「${ACTIVE_PROFILE}」不存在`, output: '' }
    if (typeof name !== 'string' || !name.trim()) return { ok: false as const, error: 'name 无效', output: '' }
    try {
      const patch = readPatch(profile.dir)
      const result = writePluginPatch(profile, deactivatePlugin(patch, name.trim()))
      return { ...result, output: `插件「${name.trim()}」已停用；package 依赖仍保留` }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, output: '' }
    }
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
      const servers = extractMcpServers(readPatch(profile.dir))
      return { ok: true as const, profile: ACTIVE_PROFILE, servers }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, servers: [] }
    }
  })
  ipcMain.handle('mcp:convert', (_e, jsonText: string) => {
    if (typeof jsonText !== 'string') return { ok: false as const, error: '输入无效', yaml: '', warnings: [] }
    return convertJsonToYaml(jsonText)
  })
  ipcMain.handle('mcp:apply', (_e, rows: unknown) => {
    const profile = activeProfile()
    if (!profile) return { ok: false as const, error: `profile「${ACTIVE_PROFILE}」不存在`, backup: '' }
    if (!Array.isArray(rows) || rows.length === 0) return { ok: false as const, error: '没有可写入的服务器', backup: '' }
    const normalized = rows.map(normalizeMcpRow)
    if (normalized.some((row): row is null => row === null)) {
      return { ok: false as const, error: 'MCP 服务器格式无效', backup: '' }
    }
    try {
      return writeMcpRows(profile, normalized as McpRow[])
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, backup: '' }
    }
  })
  ipcMain.handle('mcp:update', (_e, input: unknown) => {
    const profile = activeProfile()
    if (!profile) return { ok: false as const, error: `profile「${ACTIVE_PROFILE}」不存在`, backup: '' }
    if (!input || typeof input !== 'object') return { ok: false as const, error: '输入无效', backup: '' }
    const payload = input as { id?: unknown; row?: unknown }
    if (typeof payload.id !== 'string' || !payload.id.trim()) return { ok: false as const, error: 'MCP id 无效', backup: '' }
    const row = normalizeMcpRow(payload.row)
    if (!row) return { ok: false as const, error: 'MCP 服务器格式无效', backup: '' }
    try {
      const next = updateMcpRow(readPatch(profile.dir), { ...row, id: payload.id.trim() })
      return writeMcpPatch(profile, next, extractMcpServers(next).length)
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, backup: '' }
    }
  })
  ipcMain.handle('mcp:delete', (_e, id: unknown) => {
    const profile = activeProfile()
    if (!profile) return { ok: false as const, error: `profile「${ACTIVE_PROFILE}」不存在`, backup: '' }
    if (typeof id !== 'string' || !id.trim()) return { ok: false as const, error: 'MCP id 无效', backup: '' }
    try {
      const next = deleteMcpRow(readPatch(profile.dir), id.trim())
      return writeMcpPatch(profile, next, extractMcpServers(next).length)
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
  ipcMain.handle('skills:import-file', (_e, buffer: ArrayBuffer, overwrite: boolean) => {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) return { ok: false as const, error: '文件无效', result: null }
    if (buffer.byteLength > 20 * 1024 * 1024) return { ok: false as const, error: '文件超过 20MB 上限', result: null }
    try {
      const result = importSkillFromZip(Buffer.from(buffer), { root: join(dshHome(), 'skills'), overwrite })
      return { ok: true as const, result }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, result: null }
    }
  })
  ipcMain.handle('skills:import-url', async (_e, url: string, overwrite: boolean) => {
    if (typeof url !== 'string' || !url.trim()) return { ok: false as const, error: '链接无效', result: null }
    try {
      const result = await importSkillFromGitHub(url, { root: join(dshHome(), 'skills'), overwrite })
      return { ok: true as const, result }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, result: null }
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
  // harness iframe 导航完成时推送状态（iframe load 事件对长连接页面不可靠）
  mainWindow?.webContents.on('did-frame-navigate', (_e, frameURL, _code, _status, isMainFrame) => {
    if (!isMainFrame && harness && frameURL.startsWith(harness.url)) {
      mainWindow?.webContents.send('harness:frame-loaded', frameURL)
    }
  })
}

async function assertDomAndScreenshot(tag: string, assert: (dom: unknown) => boolean, exitAfter = true): Promise<void> {
  const dom = (await mainWindow!.webContents.executeJavaScript(`(() => {
    const tabs = [...document.querySelectorAll('[data-tab]')].map(b => b.dataset.tab)
    const active = document.querySelector('.tab.active')?.dataset.tab
    const panels = ['harness','plugin','mcp','skills'].map(t => !!document.getElementById('panel-' + t))
    const pluginRows = [...document.querySelectorAll('#plugin-rows tr')].map(r => r.textContent ?? '')
    const mcpRows = [...document.querySelectorAll('#mcp-server-rows tr')].map(r => r.textContent ?? '')
    return {
      tabs, active, panels, title: document.title, bodyLen: document.body.innerText.length, pluginRows, mcpRows,
      apiPresent: !!window.dshDesktop,
      pluginStatus: document.getElementById('plugin-status')?.textContent ?? '',
      pluginErr: document.getElementById('plugin-status')?.className ?? '',
      mcpApply: document.getElementById('mcp-apply')?.textContent ?? '',
      mcpCancelHidden: document.getElementById('mcp-cancel-edit')?.hidden ?? false,
    }
  })()`)) as {
    tabs?: string[]
    active?: string
    panels?: boolean[]
    title: string
    bodyLen: number
    pluginRows?: string[]
    mcpRows?: string[]
    apiPresent?: boolean
    pluginStatus?: string
    pluginErr?: string
    mcpApply?: string
    mcpCancelHidden?: boolean
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
          const d = dom as {
            tabs?: string[]
            active?: string
            panels?: boolean[]
            title: string
            pluginRows?: string[]
            mcpRows?: string[]
            mcpApply?: string
            mcpCancelHidden?: boolean
          }
          const rows = d.pluginRows ?? []
          const mcpRows = d.mcpRows ?? []
          return (
            JSON.stringify(d.tabs) === JSON.stringify(['harness', 'plugin', 'mcp', 'skills']) &&
            d.active === 'harness' &&
            (d.panels?.every(Boolean) ?? false) &&
            d.title === 'DSH Desktop' &&
            rows.length >= 4 &&
            rows.some((r) => r.includes('dsh-base')) &&
            mcpRows.length >= 1 &&
            d.mcpApply === '写入 patch' &&
            d.mcpCancelHidden === true
          )
        }, false)
        // MCP 转换结果单独校验
        const mcp = (await mainWindow!.webContents.executeJavaScript(`(() => {
          const preview = document.getElementById('mcp-preview').textContent
          const warnings = document.getElementById('mcp-warnings').textContent
          return { preview, warnings, servers: document.getElementById('mcp-servers').textContent }
        })()`)) as { preview: string; warnings: string; servers: string }
        if (!mcp.preview.trimStart().startsWith('- insert:') || !mcp.preview.includes('dsh-mcp-client') || !mcp.preview.includes('streamable-http')) {
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
    mainWindow?.webContents.on('console-message', (_e, _level, message) => {
      if (message.includes('[harness]')) console.log(`[renderer] ${message}`)
    })
    let harnessFrameLoaded = false
    mainWindow?.webContents.on('did-frame-navigate', (_e, frameURL, _code, _status, isMainFrame) => {
      if (!isMainFrame && frameURL.startsWith('http://127.0.0.1:')) {
        harnessFrameLoaded = true
        console.log(`frame loaded: ${frameURL}`)
      }
    })
    mainWindow?.webContents.once('did-finish-load', () => {
      void (async () => {
        // 等待 renderer 通过 IPC 拿到 harness URL 并挂载 iframe
        const deadline = Date.now() + 8000
        while (Date.now() < deadline) {
          const src = await mainWindow!.webContents.executeJavaScript(
            `document.getElementById('harness-frame').src`,
          )
          if (src && src.startsWith('http://127.0.0.1:')) break
          await new Promise((r) => setTimeout(r, 250))
        }
        await assertDomAndScreenshot('m1-harness', (dom) => {
          const d = dom as { title: string; bodyLen: number }
          return d.title === 'DSH Desktop' && d.bodyLen > 0
        }, false)
        const src = (await mainWindow!.webContents.executeJavaScript(
          `document.getElementById('harness-frame').src`,
        )) as string
        if (!src.startsWith('http://127.0.0.1:')) {
          console.error(`SMOKE FAIL: harness iframe 未挂载 (${src})`)
          app.exit(1)
        }
        const status = (await mainWindow!.webContents.executeJavaScript(
          `document.getElementById('harness-status').textContent`,
        )) as string
        const loaded = harnessFrameLoaded || status.includes('已连接')
        let finalStatus = status
        if (!loaded) {
          const waitDeadline = Date.now() + 5000
          while (Date.now() < waitDeadline) {
            finalStatus = (await mainWindow!.webContents.executeJavaScript(
              `document.getElementById('harness-status').textContent`,
            )) as string
            if (finalStatus.includes('已连接') || harnessFrameLoaded) break
            await new Promise((r) => setTimeout(r, 400))
          }
        }
        if (!harnessFrameLoaded && !finalStatus.includes('已连接')) {
          console.error(`SMOKE FAIL: harness iframe 页面未加载（${finalStatus}）`)
          app.exit(1)
        }
        console.log(`SMOKE OK: harness 内嵌成功（iframe ${src}，状态「${finalStatus}」）`)
        app.exit(0)
      })()
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
    createSkeletonWindow()
    wireSmoke()
    return
  }
  // 默认产品行为：主窗口＝四 Tab 壳，Harness Tab 内嵌官方 Web UI
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: 'DSH Desktop', submenu: [{ role: 'quit', label: '退出' }] },
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
        submenu: [
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
