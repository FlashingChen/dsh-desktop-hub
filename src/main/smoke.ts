// 冒烟驱动（独立于生产主进程）：--smoke / --harness-smoke 的 DOM 断言 + 截屏
// 断言只依赖壳层自身契约，不依赖开发者机器上的特定 profile/skill 数据（P2-12）
import { app, type BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HarnessHandle } from '../core/harness.js'
import { IPC } from '../core/ipc.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_TITLE = 'DSH Desktop Hub'

export interface SmokeContext {
  mainWindow: () => BrowserWindow | null
  harness: () => HarnessHandle | null
  artifactsDir: string
  harnessSmoke: boolean
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface DomSnapshot {
  tabs?: string[]
  active?: string
  panels?: boolean[]
  title: string
  bodyLen: number
  pluginRows?: string[]
  pluginStatus?: string
  mcpRows?: string[]
  mcpApply?: string
  mcpCancelHidden?: boolean
  skillsStatus?: string
  marketCards?: { plugin: number; mcp: number; skills: number }
  harnessStatus?: string
  feedbackControls?: boolean
  feedbackQr?: boolean
}

async function snapshot(win: BrowserWindow): Promise<DomSnapshot> {
  return win.webContents.executeJavaScript(`(() => {
    const tabs = [...document.querySelectorAll('[data-tab]')].map(b => b.dataset.tab)
    const active = document.querySelector('.tab.active')?.dataset.tab
    const panels = ['harness','plugin','mcp','skills','feedback'].map(t => !!document.getElementById('panel-' + t))
    const pluginRows = [...document.querySelectorAll('#plugin-rows tr')].map(r => r.textContent ?? '')
    const mcpRows = [...document.querySelectorAll('#mcp-server-rows tr')].map(r => r.textContent ?? '')
    const marketCards = {
      plugin: document.querySelectorAll('#plugin-market-grid .market-card').length,
      mcp: document.querySelectorAll('#mcp-market-grid .market-card').length,
      skills: document.querySelectorAll('#skills-market-grid .market-card').length,
    }
    return {
      tabs, active, panels, title: document.title, bodyLen: document.body.innerText.length, pluginRows, mcpRows, marketCards,
      apiPresent: !!window.dshDesktop,
      pluginStatus: document.getElementById('plugin-status')?.textContent ?? '',
      mcpApply: document.getElementById('mcp-apply')?.textContent ?? '',
      mcpCancelHidden: document.getElementById('mcp-cancel-edit')?.hidden ?? false,
      skillsStatus: document.getElementById('skills-status')?.textContent ?? '',
      harnessStatus: document.getElementById('harness-status')?.textContent ?? '',
      feedbackControls: !!document.getElementById('feedback-submit') && !!document.getElementById('feedback-diagnostics') && !!document.getElementById('feedback-copy-full'),
      feedbackQr: !!document.querySelector('#panel-feedback img[src="community/qq-group.png"]'),
    }
  })()`) as Promise<DomSnapshot>
}

async function assertDomAndScreenshot(
  win: BrowserWindow,
  tag: string,
  assert: (dom: DomSnapshot) => boolean,
  artifactsDir: string,
  exitAfter = true,
): Promise<boolean> {
  const dom = await snapshot(win)
  if (!assert(dom)) {
    console.error(`SMOKE FAIL: unexpected DOM ${JSON.stringify(dom)}`)
    app.exit(1)
    return false
  }
  try {
    const image = await win.webContents.capturePage()
    const out = join(artifactsDir, `${tag}.png`)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, image.toPNG())
    console.log(`SMOKE OK: ${tag} DOM ${JSON.stringify({ title: dom.title, bodyLen: dom.bodyLen })} screenshot ${out}`)
  } catch (err) {
    console.error(`SMOKE FAIL: ${tag} 截图或工件写入失败：${err instanceof Error ? err.message : String(err)}`)
    app.exit(1)
    return false
  }
  if (exitAfter) app.exit(0)
  return true
}

/** 等待谓词为真（带超时） */
async function waitFor(win: BrowserWindow, probe: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe()) return true
    await sleep(200)
  }
  return false
}

export function wireSmoke(ctx: SmokeContext): void {
  const win = ctx.mainWindow()
  if (!win) {
    console.error('SMOKE FAIL: 无窗口')
    app.exit(1)
    return
  }
  win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    // 子帧（harness iframe）失败/中止（-3）在重启旧进程时是正常现象，容忍，由后续状态断言把关
    if (isMainFrame) {
      console.error(`SMOKE FAIL: main frame load failed (${code} ${desc})`)
      app.exit(1)
    }
  })

  if (!ctx.harnessSmoke) {
    // ---- 骨架冒烟：五 Tab + 数据面板加载（不依赖特定 profile 数据）----
    win.webContents.once('did-finish-load', () => {
      void (async () => {
        const ready = await waitFor(
          win,
          async () => {
            const dom = await snapshot(win)
            return (
              (dom.pluginStatus ?? '').includes('共') &&
              (dom.skillsStatus ?? '').includes('共') &&
              (dom.marketCards?.plugin ?? 0) > 0 &&
              (dom.marketCards?.mcp ?? 0) > 0 &&
              (dom.marketCards?.skills ?? 0) > 0
            )
          },
          35_000,
        )
        if (!ready) {
          console.error(`SMOKE FAIL: Plugin/Skills 面板未完成加载 ${JSON.stringify(await snapshot(win))}`)
          app.exit(1)
          return
        }
        // 驱动 MCP JSON→YAML 转换（只读，不写 profile）
        await win.webContents.executeJavaScript(`(() => {
          const ta = document.getElementById('mcp-json')
          ta.value = JSON.stringify({ mcpServers: {
            github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'x' } },
            remote: { type: 'http', url: 'https://mcp.example.com/search', headers: { Authorization: 'Bearer t' } }
          }})
          document.getElementById('mcp-convert').click()
        })()`)
        const converted = await waitFor(
          win,
          async () => (await win.webContents.executeJavaScript(`document.getElementById('mcp-preview').textContent.length > 0`)) as boolean,
          5000,
        )
        if (!converted) {
          console.error('SMOKE FAIL: MCP 转换未完成')
          app.exit(1)
        }
        const screenshotOk = await assertDomAndScreenshot(
          win,
          'm0-smoke',
          (dom) => {
            const d = dom as DomSnapshot
            return (
              JSON.stringify(d.tabs) === JSON.stringify(['harness', 'plugin', 'mcp', 'skills', 'feedback']) &&
              d.active === 'harness' &&
              (d.panels?.every(Boolean) ?? false) &&
              d.title === APP_TITLE &&
              (d.pluginStatus ?? '').includes('共') &&
              (d.skillsStatus ?? '').includes('共') &&
              d.mcpApply === '写入 patch' &&
              d.mcpCancelHidden === true &&
              (d.marketCards?.plugin ?? 0) > 0 &&
              (d.marketCards?.mcp ?? 0) > 0 &&
              (d.marketCards?.skills ?? 0) > 0 &&
              d.feedbackControls === true &&
              d.feedbackQr === true
            )
          },
          ctx.artifactsDir,
          false,
        )
        if (!screenshotOk) return
        // MCP 转换结果单独校验（预览必须与 patch 同构）
        const mcp = (await win.webContents.executeJavaScript(`(() => {
          const preview = document.getElementById('mcp-preview').textContent
          const warnings = document.getElementById('mcp-warnings').textContent
          return { preview, warnings, servers: document.getElementById('mcp-servers').textContent }
        })()`)) as { preview: string; warnings: string; servers: string }
        if (!mcp.preview.trimStart().startsWith('- insert:') || !mcp.preview.includes('dsh-mcp-client') || !mcp.preview.includes('streamable-http')) {
          console.error(`SMOKE FAIL: MCP 转换异常 ${JSON.stringify(mcp)}`)
          app.exit(1)
        }
        console.log(`SMOKE OK: MCP convert 端到端通过（${JSON.stringify(mcp.servers)}）`)
        app.exit(0)
      })()
    })
    return
  }

  // ---- harness 冒烟：真实 harness + iframe 挂载 + 状态「已连接」----
  let harnessFrameLoaded = false
  win.webContents.on('did-frame-navigate', (_e, frameURL, _code, _status, isMainFrame) => {
    if (!isMainFrame && frameURL.startsWith('http://127.0.0.1:')) {
      harnessFrameLoaded = true
      console.log(`frame loaded: ${frameURL}`)
    }
  })
  win.webContents.once('did-finish-load', () => {
    void (async () => {
      const mounted = await waitFor(
        win,
        async () => {
          const src = (await win.webContents.executeJavaScript(`document.getElementById('harness-frame').src`)) as string
          return src.startsWith('http://127.0.0.1:')
        },
        10_000,
      )
      if (!mounted) {
        console.error('SMOKE FAIL: harness iframe 未挂载')
        app.exit(1)
      }
      const screenshotOk = await assertDomAndScreenshot(
        win,
        'm1-harness',
        (dom) => dom.title === APP_TITLE && dom.bodyLen > 0,
        ctx.artifactsDir,
        false,
      )
      if (!screenshotOk) return
      const src = (await win.webContents.executeJavaScript(`document.getElementById('harness-frame').src`)) as string
      if (!src.startsWith('http://127.0.0.1:')) {
        console.error(`SMOKE FAIL: harness iframe 未挂载 (${src})`)
        app.exit(1)
      }
      // 状态条（renderer 经 harness:status / frame-loaded 更新）
      const connected = await waitFor(
        win,
        async () => {
          const status = (await win.webContents.executeJavaScript(`document.getElementById('harness-status').textContent`)) as string
          return status.includes('已连接') || harnessFrameLoaded
        },
        15_000,
      )
      if (!connected) {
        console.error(`SMOKE FAIL: harness 状态未变为已连接 ${JSON.stringify(await snapshot(win))}`)
        app.exit(1)
      }
      const finalStatus = (await win.webContents.executeJavaScript(
        `document.getElementById('harness-status').textContent`,
      )) as string
      console.log(`SMOKE OK: harness 内嵌成功（iframe ${src}，状态「${finalStatus}」）`)
      // P1 修复：重启 Harness 后 iframe 必须重挂载到新 URL（--port 0 每次随机端口）
      const oldSrc = src
      await win.webContents.executeJavaScript(`document.getElementById('harness-restart').click()`)
      const remounted = await waitFor(
        win,
        async () => {
          const current = (await win.webContents.executeJavaScript(`document.getElementById('harness-frame').src`)) as string
          return current !== oldSrc && current.startsWith('http://127.0.0.1:')
        },
        30_000,
      )
      if (!remounted) {
        console.error(`SMOKE FAIL: restart 后 iframe 未重挂载（旧 ${oldSrc}）${JSON.stringify(await snapshot(win))}`)
        app.exit(1)
      }
      const newSrc = (await win.webContents.executeJavaScript(`document.getElementById('harness-frame').src`)) as string
      const reconnected = await waitFor(
        win,
        async () => {
          const status = (await win.webContents.executeJavaScript(`document.getElementById('harness-status').textContent`)) as string
          return status.includes('已连接')
        },
        15_000,
      )
      if (!reconnected) {
        console.error(`SMOKE FAIL: 重启后状态未恢复已连接 ${JSON.stringify(await snapshot(win))}`)
        app.exit(1)
      }
      console.log(`SMOKE OK: harness 重启后 iframe 重挂载（${oldSrc} → ${newSrc}，状态已连接）`)
      app.exit(0)
    })()
  })
}

// 供外部断言 IPC 契约一致性的哨兵（不产生运行时行为）
export const _ipcChannels = IPC
