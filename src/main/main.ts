import { app, BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { startHarness, findDsh, dshHome, listProfiles, type HarnessHandle } from '../core/harness.js'
import { listPlugins, runPluginOp } from '../core/plugins.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RENDERER_HTML = join(__dirname, '..', 'renderer', 'index.html')

const argv = process.argv
const SMOKE = argv.includes('--smoke')
const HARNESS = argv.includes('--harness')
const HARNESS_SMOKE = argv.includes('--harness-smoke')

let mainWindow: BrowserWindow | null = null
let harness: HarnessHandle | null = null

/** M2 管理的目标 profile（与 harness 启动一致）；M5 将支持切换 */
const ACTIVE_PROFILE = 'web'

function activeProfile() {
  return listProfiles(dshHome()).find((p) => p.name === ACTIVE_PROFILE) ?? null
}

async function runPluginMutation(action: 'add' | 'remove' | 'update', args: string[]) {
  const dsh = findDsh()
  if (!dsh) return { ok: false as const, error: '未找到 dsh 可执行文件', output: '' }
  const op = runPluginOp({ dsh, profile: ACTIVE_PROFILE, action, args })
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

async function assertDomAndScreenshot(tag: string, assert: (dom: unknown) => boolean): Promise<void> {
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
  app.exit(0)
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
          const n = await mainWindow!.webContents.executeJavaScript(
            `document.querySelectorAll('#plugin-rows tr').length`,
          )
          if (n > 0) break
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
        })
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
  if (HARNESS || HARNESS_SMOKE) {
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
  createSkeletonWindow()
  wireSmoke()
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
