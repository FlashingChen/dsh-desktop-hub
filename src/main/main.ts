import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { startHarness, type HarnessHandle } from '../core/harness.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RENDERER_HTML = join(__dirname, '..', 'renderer', 'index.html')

const argv = process.argv
const SMOKE = argv.includes('--smoke')
const HARNESS = argv.includes('--harness')
const HARNESS_SMOKE = argv.includes('--harness-smoke')

let mainWindow: BrowserWindow | null = null
let harness: HarnessHandle | null = null

function createWindow(url: string): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'DSH Desktop',
    show: !(SMOKE || HARNESS_SMOKE),
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.js'),
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
    return { tabs, active, panels, title: document.title, bodyLen: document.body.innerText.length }
  })()`)) as { tabs?: string[]; active?: string; panels?: boolean[]; title: string; bodyLen: number }
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
      void assertDomAndScreenshot('m0-smoke', (dom) => {
        const d = dom as { tabs?: string[]; active?: string; panels?: boolean[]; title: string }
        return (
          JSON.stringify(d.tabs) === JSON.stringify(['harness', 'plugin', 'mcp', 'skills']) &&
          d.active === 'harness' &&
          (d.panels?.every(Boolean) ?? false) &&
          d.title === 'DSH Desktop'
        )
      })
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
