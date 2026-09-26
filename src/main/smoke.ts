// 冒烟驱动（独立于生产主进程）：--smoke / --harness-smoke 的 DOM 断言 + 截屏
// 断言只依赖壳层自身契约，不依赖开发者机器上的特定 profile/skill 数据（P2-12）
import { app, type BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { HarnessHandle } from '../core/harness.js'
import { IPC } from '../core/ipc.js'

const APP_TITLE = 'DSH Desktop Hub'
const FIVE_TABS = ['harness', 'plugin', 'mcp', 'skills', 'feedback'] as const

export interface SmokeContext {
  mainWindow: () => BrowserWindow | null
  harness: () => HarnessHandle | null
  artifactsDir: string
  harnessSmoke: boolean
  /** 内嵌管理中心地址（/manager.html?embedded=1），与 Harness 侧边栏打开的 URL 同源。 */
  managerUrl: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Request a graceful quit; main's will-quit handler cleans Harness and preserves this exit code. */
let smokeFinished = false
function finishSmoke(code: number): void {
  if (smokeFinished) return
  smokeFinished = true
  process.exitCode = code
  app.quit()
}

/** Run an event-triggered smoke flow without letting a rejected promise hang CI. */
function runSmokeTask(label: string, task: () => Promise<void>): void {
  void task().catch((error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.error(`SMOKE FAIL: ${label} 异步执行失败：${detail}`)
    finishSmoke(1)
  })
}

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

/**
 * 读取渲染快照。`docExpr` 是求值为 Document 的 JS 表达式：默认主壳文档，
 * 传 iframe 的 contentDocument 可直接断言内嵌管理中心（同源，可直接访问）。
 */
async function snapshot(win: BrowserWindow, docExpr = 'document'): Promise<DomSnapshot> {
  return win.webContents.executeJavaScript(`(() => {
    // 刻意不叫 document：默认实参就是 'document'，同名 const 会形成 TDZ 自引用。
    const doc = ${docExpr}
    const tabs = [...doc.querySelectorAll('[data-tab]')].map(b => b.dataset.tab)
    const active = doc.querySelector('.tab.active')?.dataset.tab
    const panels = ['harness','plugin','mcp','skills','feedback'].map(t => !!doc.getElementById('panel-' + t))
    const pluginRows = [...doc.querySelectorAll('#plugin-rows tr')].map(r => r.textContent ?? '')
    const mcpRows = [...doc.querySelectorAll('#mcp-server-rows tr')].map(r => r.textContent ?? '')
    const marketCards = {
      plugin: doc.querySelectorAll('#plugin-market-grid .market-card').length,
      mcp: doc.querySelectorAll('#mcp-market-grid .market-card').length,
      skills: doc.querySelectorAll('#skills-market-grid .market-card').length,
    }
    return {
      tabs, active, panels, title: doc.title, bodyLen: doc.body.innerText.length, pluginRows, mcpRows, marketCards,
      apiPresent: !!window.dshDesktop,
      pluginStatus: doc.getElementById('plugin-status')?.textContent ?? '',
      mcpApply: doc.getElementById('mcp-apply')?.textContent ?? '',
      mcpCancelHidden: doc.getElementById('mcp-cancel-edit')?.hidden ?? false,
      skillsStatus: doc.getElementById('skills-status')?.textContent ?? '',
      harnessStatus: doc.getElementById('harness-status')?.textContent ?? '',
      feedbackControls: !!doc.getElementById('feedback-submit') && !!doc.getElementById('feedback-diagnostics') && !!doc.getElementById('feedback-copy-full'),
      feedbackQr: !!doc.querySelector('#panel-feedback img[src="community/qq-group.png"]'),
    }
  })()`) as Promise<DomSnapshot>
}

async function assertDomAndScreenshot(
  win: BrowserWindow,
  tag: string,
  assert: (dom: DomSnapshot) => boolean,
  artifactsDir: string,
  exitAfter = true,
  docExpr = 'document',
): Promise<boolean> {
  const dom = await snapshot(win, docExpr)
  if (!assert(dom)) {
    console.error(`SMOKE FAIL: unexpected DOM ${JSON.stringify(dom)}`)
    finishSmoke(1)
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
    finishSmoke(1)
    return false
  }
  if (exitAfter) finishSmoke(0)
  return true
}

/** 等待谓词为真（带超时） */
async function waitFor(probe: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe()) return true
    await sleep(200)
  }
  return false
}

/**
 * `createSkeletonWindow()` starts loading before `wireSmoke()` is attached.
 * A very fast local-file load can finish in that gap (notably on Windows), so
 * also handle an already-finished shell without running the callback twice.
 */
function onShellDidFinishLoad(win: BrowserWindow, callback: () => void): void {
  let called = false
  const run = (): void => {
    if (called) return
    called = true
    callback()
  }
  win.webContents.once('did-finish-load', run)
  if (!win.webContents.isLoading() && win.webContents.getURL().startsWith('file:')) queueMicrotask(run)
}

export function wireSmoke(ctx: SmokeContext): void {
  const win = ctx.mainWindow()
  if (!win) {
    console.error('SMOKE FAIL: 无窗口')
    finishSmoke(1)
    return
  }
  if (!ctx.harnessSmoke) {
    // ---- 骨架冒烟：壳层（desktop-host，Harness 全屏宿主）+ 内嵌管理中心（Plugin/MCP/Skills 中心）----
    onShellDidFinishLoad(win, () => {
      runSmokeTask('骨架冒烟', async () => {
        // 1) 壳层契约：desktop-host 只承载 Harness 宿主视图（CSS 隐藏其余面板），
        //    Plugin/MCP/Skills 中心由 manager.html 承载——壳层本就不加载中心数据。
        const shellReady = await waitFor(
          async () => {
            const dom = await snapshot(win)
            return (
              JSON.stringify(dom.tabs) === JSON.stringify(FIVE_TABS) &&
              dom.active === 'harness' &&
              (dom.panels?.every(Boolean) ?? false) &&
              dom.title === APP_TITLE &&
              dom.feedbackControls === true &&
              dom.feedbackQr === true
            )
          },
          10_000,
        )
        if (!shellReady) {
          console.error(`SMOKE FAIL: 壳层未渲染 ${JSON.stringify(await snapshot(win))}`)
          finishSmoke(1)
          return
        }
        const shellShot = await assertDomAndScreenshot(
          win,
          'm0-smoke',
          (dom) => dom.title === APP_TITLE && (dom.bodyLen ?? 0) > 0,
          ctx.artifactsDir,
          false,
        )
        if (!shellShot) return

        // 2) 内嵌管理中心：中心数据只在 manager-embedded（/manager.html?embedded=1）下加载。
        //    生产上它占用 shell 的 harness-frame（与主壳同源的子帧），这里按同样拓扑复现——
        //    不能把主帧导航过去：IPC 来源校验要求中心是子帧，主帧导航会被判为非法来源。
        const managerDoc = "document.getElementById('harness-frame')?.contentDocument"
        await win.webContents.executeJavaScript(`(() => {
          const frame = document.getElementById('harness-frame')
          if (!frame) throw new Error('缺少 harness-frame')
          frame.src = ${JSON.stringify(ctx.managerUrl)}
        })()`)
        const managerMounted = await waitFor(
          async () => (await win.webContents.executeJavaScript(
            `(() => {
              const d = ${managerDoc}
              return !!d && d.body?.classList.contains('manager-embedded') === true
            })()`,
          )) === true,
          15_000,
        )
        if (!managerMounted) {
          console.error(`SMOKE FAIL: 内嵌管理中心未挂载 ${JSON.stringify(await snapshot(win))}`)
          finishSmoke(1)
          return
        }
        const ready = await waitFor(
          async () => {
            const dom = await snapshot(win, managerDoc)
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
          console.error(`SMOKE FAIL: Plugin/Skills 面板未完成加载 ${JSON.stringify(await snapshot(win, managerDoc))}`)
          finishSmoke(1)
          return
        }
        // 驱动 MCP JSON→YAML 转换（只读，不写 profile）
        await win.webContents.executeJavaScript(`(() => {
          const doc = ${managerDoc}
          const ta = doc.getElementById('mcp-json')
          ta.value = JSON.stringify({ mcpServers: {
            github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'x' } },
            remote: { type: 'http', url: 'https://mcp.example.com/search', headers: { Authorization: 'Bearer t' } }
          }})
          doc.getElementById('mcp-convert').click()
        })()`)
        const converted = await waitFor(
          async () => (await win.webContents.executeJavaScript(
            `${managerDoc}.getElementById('mcp-preview').textContent.length > 0`,
          )) as boolean,
          5000,
        )
        if (!converted) {
          console.error('SMOKE FAIL: MCP 转换未完成')
          finishSmoke(1)
          return
        }
        const screenshotOk = await assertDomAndScreenshot(
          win,
          'm0-manager',
          (dom) => {
            const d = dom as DomSnapshot
            return (
              JSON.stringify(d.tabs) === JSON.stringify(FIVE_TABS) &&
              // manager.html?embedded=1&tab=plugin 默认停在 Plugin 中心（壳层才是 harness）
              d.active === 'plugin' &&
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
          managerDoc,
        )
        if (!screenshotOk) return
        // MCP 转换结果单独校验（预览必须与 patch 同构）
        const mcp = (await win.webContents.executeJavaScript(`(() => {
          const doc = ${managerDoc}
          const preview = doc.getElementById('mcp-preview').textContent
          const warnings = doc.getElementById('mcp-warnings').textContent
          return { preview, warnings, servers: doc.getElementById('mcp-servers').textContent }
        })()`)) as { preview: string; warnings: string; servers: string }
        if (!mcp.preview.trimStart().startsWith('- insert:') || !mcp.preview.includes('dsh-mcp-client') || !mcp.preview.includes('streamable-http')) {
          console.error(`SMOKE FAIL: MCP 转换异常 ${JSON.stringify(mcp)}`)
          finishSmoke(1)
          return
        }
        console.log(`SMOKE OK: MCP convert 端到端通过（${JSON.stringify(mcp.servers)}）`)
        finishSmoke(0)
      })
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
  onShellDidFinishLoad(win, () => {
    runSmokeTask('Harness 冒烟', async () => {
      const mounted = await waitFor(
        async () => {
          const src = (await win.webContents.executeJavaScript(`document.getElementById('harness-frame').src`)) as string
          return src.startsWith('http://127.0.0.1:')
        },
        10_000,
      )
      if (!mounted) {
        console.error('SMOKE FAIL: harness iframe 未挂载')
        finishSmoke(1)
        return
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
        finishSmoke(1)
        return
      }
      // 状态条（renderer 经 harness:status / frame-loaded 更新）
      const connected = await waitFor(
        async () => {
          const status = (await win.webContents.executeJavaScript(`document.getElementById('harness-status').textContent`)) as string
          return status.includes('已连接') || harnessFrameLoaded
        },
        15_000,
      )
      if (!connected) {
        console.error(`SMOKE FAIL: harness 状态未变为已连接 ${JSON.stringify(await snapshot(win))}`)
        finishSmoke(1)
        return
      }
      const finalStatus = (await win.webContents.executeJavaScript(
        `document.getElementById('harness-status').textContent`,
      )) as string
      console.log(`SMOKE OK: harness 内嵌成功（iframe ${src}，状态「${finalStatus}」）`)
      // P1 修复：重启 Harness 后 iframe 必须重挂载到新 URL（--port 0 每次随机端口）
      const oldSrc = src
      await win.webContents.executeJavaScript(`document.getElementById('harness-restart').click()`)
      const remounted = await waitFor(
        async () => {
          const current = (await win.webContents.executeJavaScript(`document.getElementById('harness-frame').src`)) as string
          return current !== oldSrc && current.startsWith('http://127.0.0.1:')
        },
        30_000,
      )
      if (!remounted) {
        console.error(`SMOKE FAIL: restart 后 iframe 未重挂载（旧 ${oldSrc}）${JSON.stringify(await snapshot(win))}`)
        finishSmoke(1)
        return
      }
      const newSrc = (await win.webContents.executeJavaScript(`document.getElementById('harness-frame').src`)) as string
      const reconnected = await waitFor(
        async () => {
          const status = (await win.webContents.executeJavaScript(`document.getElementById('harness-status').textContent`)) as string
          return status.includes('已连接')
        },
        15_000,
      )
      if (!reconnected) {
        console.error(`SMOKE FAIL: 重启后状态未恢复已连接 ${JSON.stringify(await snapshot(win))}`)
        finishSmoke(1)
        return
      }
      console.log(`SMOKE OK: harness 重启后 iframe 重挂载（${oldSrc} → ${newSrc}，状态已连接）`)
      finishSmoke(0)
    })
  })
}

// 供外部断言 IPC 契约一致性的哨兵（不产生运行时行为）
export const _ipcChannels = IPC
