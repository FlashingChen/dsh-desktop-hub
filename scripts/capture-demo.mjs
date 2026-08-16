// README 产品截图捕获（独立驱动，不修改生产代码）
// 用法：npm run build && npx electron scripts/capture-demo.mjs [--harness]
// 产物：assets/demo/*.png（mcp-flow-1..4 / skills / plugins / harness）
import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const DEMO_HOME = '/tmp/dsh-demo-capture'
const OUT_DIR = join(root, 'assets', 'demo')
const RENDERER_HTML = join(root, 'dist', 'renderer', 'index.html')
const RENDERER_URL = `file://${RENDERER_HTML}`
const WITH_HARNESS = process.argv.includes('--harness')

process.env.DSH_HOME = DEMO_HOME

const { IPC } = await import(join(root, 'dist', 'core', 'ipc.js'))
const mcp = await import(join(root, 'dist', 'core', 'mcp.js'))
const { listPlugins } = await import(join(root, 'dist', 'core', 'plugins.js'))
const { scanSkills } = await import(join(root, 'dist', 'core', 'skills.js'))
const { startHarness, dshHome, listProfiles } = await import(join(root, 'dist', 'core', 'harness.js'))

const ACTIVE_PROFILE = 'web'
const PROFILE_DIR = join(dshHome(), 'profiles', ACTIVE_PROFILE)

// ---- 合成演示 home：与真实用户数据完全隔离 ----
function buildDemoHome() {
  rmSync(DEMO_HOME, { recursive: true, force: true })
  mkdirSync(PROFILE_DIR, { recursive: true })

  writeFileSync(
    join(PROFILE_DIR, 'package.json'),
    JSON.stringify(
      {
        name: 'web',
        private: true,
        dependencies: {
          '@deepseek-ai/dsh-mcp-client': '^0.1.0',
          '@dsh-external/dsh-super-injector': '^1.0.0',
          '@dsh-external/dsh-mode-boost': '^1.0.0',
          'dsh-worktree': '^0.2.0',
        },
        dsh: {
          profile: {
            bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
          },
        },
      },
      null,
      2,
    ),
  )

  writeFileSync(
    join(PROFILE_DIR, 'cordis.patch.yml'),
    [
      '- insert:',
      '    - id: mcp-memory',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: memory',
      '        transport: stdio',
      '        command: npx',
      "        args: ['-y', '@modelcontextprotocol/server-memory']",
      '',
    ].join('\n'),
  )

  const mkSkill = (rel, frontmatter, body) => {
    const dir = join(dshHome(), rel)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`)
  }
  mkSkill(
    'skills/web-research',
    'name: web-research\ndescription: 带来源引用的多步网络调研：规划查询、逐条核验、输出带链接的结论。\nwhenToUse: 需要事实核查、多源交叉验证或最新信息时',
    '# Web Research\n\n1. 拆分查询维度\n2. 逐源核验\n3. 输出带链接结论\n',
  )
  mkSkill(
    'skills/code-review',
    'name: code-review\ndescription: 对代码变更做安全与质量评审：先找注入点，再看可维护性，最后给最小修复。',
    '# Code Review\n\n- 安全优先\n- 最小改动\n',
  )
  mkSkill(
    'bundled-skills/meeting-notes',
    'name: meeting-notes\ndescription: 随包示例：把会议记录整理为结论、待办、风险三栏。',
    '# Meeting Notes\n\n## 结论 / 待办 / 风险\n',
  )
  // 扁平 skill 文件（无目录包裹）
  const flat = join(dshHome(), 'skills', 'git-triage.md')
  writeFileSync(
    flat,
    '---\nname: git-triage\ndescription: 从 git log/diff 快速定位回归：按提交粒度二分。\n---\n\n# Git Triage\n',
  )
  process.env.DSH_BUNDLED_SKILL_DIR = join(dshHome(), 'bundled-skills')
}

// ---- 轻量 IPC（与 src/main/main.ts 同一契约，仅注册截图需要的通道）----
function registerIpc() {
  const profile = () => listProfiles(dshHome()).find((p) => p.name === ACTIVE_PROFILE) ?? null
  const assertShell = (event) => {
    const frame = event.senderFrame
    if (frame !== event.sender.mainFrame || frame.url !== RENDERER_URL) throw new Error('IPC 来源校验失败')
  }

  ipcMain.handle(IPC.mcpList, (event) => {
    assertShell(event)
    const p = profile()
    if (!p) return { ok: false, error: `profile「${ACTIVE_PROFILE}」不存在`, servers: [] }
    try {
      return { ok: true, profile: ACTIVE_PROFILE, servers: mcp.extractMcpServers(mcp.readPatch(p.dir)) }
    } catch (err) {
      return { ok: false, error: err.message, servers: [] }
    }
  })
  ipcMain.handle(IPC.mcpConvert, (event, jsonText) => {
    assertShell(event)
    if (typeof jsonText !== 'string') return { ok: false, error: '输入无效', yaml: '', warnings: [] }
    return mcp.convertJsonToYaml(jsonText)
  })
  ipcMain.handle(IPC.mcpApply, (event, input) => {
    assertShell(event)
    const p = profile()
    if (!p) return { ok: false, error: `profile「${ACTIVE_PROFILE}」不存在`, backup: '' }
    const payload = input ?? {}
    if (!Array.isArray(payload.rows) || payload.rows.length === 0) return { ok: false, error: '没有可写入的服务器', backup: '' }
    const mode = payload.mode === 'replace' ? 'replace' : 'merge'
    const rows = payload.rows.map((r) => {
      if (!r || typeof r !== 'object') return null
      if (typeof r.id !== 'string' || !r.id.trim()) return null
      if (!r.config || typeof r.config !== 'object' || Array.isArray(r.config)) return null
      return { id: r.id.trim(), name: r.name, config: r.config }
    })
    if (rows.some((r) => r === null)) return { ok: false, error: 'MCP 服务器格式无效', backup: '' }
    try {
      const patch = mcp.readPatch(p.dir)
      const next = mode === 'replace' ? mcp.replaceMcpRows(patch, rows) : mcp.mergeMcpRows(patch, rows)
      const backup = mcp.atomicWriteWithBackup(join(p.dir, 'cordis.patch.yml'), next)
      return { ok: true, backup, rows: mcp.extractMcpServers(next).length }
    } catch (err) {
      return { ok: false, error: err.message, backup: '' }
    }
  })
  ipcMain.handle(IPC.pluginsList, (event) => {
    assertShell(event)
    const p = profile()
    if (!p) return { ok: false, error: `profile「${ACTIVE_PROFILE}」不存在`, entries: [] }
    try {
      return { ok: true, profile: ACTIVE_PROFILE, entries: listPlugins(p, mcp.readPatch(p.dir)) }
    } catch (err) {
      return { ok: false, error: err.message, entries: [] }
    }
  })
  ipcMain.handle(IPC.skillsList, (event) => {
    assertShell(event)
    try {
      const bundledDir = process.env.DSH_BUNDLED_SKILL_DIR || undefined
      return { ok: true, skills: scanSkills({ dshHome: dshHome(), bundledDir }) }
    } catch (err) {
      return { ok: false, error: err.message, skills: [] }
    }
  })
  ipcMain.handle(IPC.harnessUrl, (event) => {
    assertShell(event)
    return harness?.url ?? null
  })
}

let harness = null
let win = null

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function shot(name) {
  const contentH = await win.webContents.executeJavaScript(
    `Math.max(document.body.scrollHeight, document.body.getBoundingClientRect().height)`,
  )
  console.log(`shot ${name}: contentH=${contentH}`)
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1280, height: Math.min(contentH, 1600) })
  mkdirSync(OUT_DIR, { recursive: true })
  const out = join(OUT_DIR, `${name}.png`)
  writeFileSync(out, image.toPNG())
  console.log(`captured ${out} (${image.getSize().width}x${image.getSize().height})`)
}

async function shotFull(name) {
  const image = await win.webContents.capturePage()
  mkdirSync(OUT_DIR, { recursive: true })
  const out = join(OUT_DIR, `${name}.png`)
  writeFileSync(out, image.toPNG())
  console.log(`captured ${out} (${image.getSize().width}x${image.getSize().height})`)
}

async function waitFor(probeJs, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await win.webContents.executeJavaScript(probeJs)
    if (ok) return true
    await sleep(250)
  }
  return false
}

app.whenReady().then(async () => {
  buildDemoHome()
  registerIpc()
  try {
    await runCapture()
  } catch (err) {
    console.error(`CAPTURE FAIL: ${err?.stack ?? err}`)
    await harness?.stop().catch(() => {})
    app.exit(1)
  }
})

async function runCapture() {
  win = new BrowserWindow({
    width: 1280,
    height: 1400,
    title: 'DSH Desktop Hub',
    show: false,
    webPreferences: {
      offscreen: true,
      preload: join(root, 'dist', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`)
  })
  win.webContents.on('did-frame-navigate', (_e, frameURL, _code, _status, isMainFrame) => {
    console.log(`frame-navigate: isMain=${isMainFrame} ${frameURL.slice(0, 80)}`)
    if (!isMainFrame && harness && frameURL.startsWith(harness.url)) {
      win.webContents.send(IPC.harnessFrameLoaded, frameURL)
      win.webContents.send(IPC.harnessStatus, { state: 'ready', url: harness.url })
    }
  })
  await win.loadURL(RENDERER_URL)
  const js = async (label, code) => {
    console.log(`step: ${label}`)
    try {
      return await win.webContents.executeJavaScript(code)
    } catch (err) {
      console.error(`step FAIL ${label}: ${err.message}`)
      throw err
    }
  }
  // 展开固定高度壳层，让整页内容参与截图（仅影响本次捕获，不改生产样式）
  await js("inject-style", `(() => {
    const s = document.createElement('style')
    s.textContent = [
      'html, body { height: auto !important; overflow: visible !important; }',
      '.app-shell { height: auto !important; }',
      'main { height: auto !important; overflow: visible !important; }',
      '.panel { height: auto !important; overflow: visible !important; }',
      '.preview-surface pre { line-height: 1.5 !important; }',
    ].join(String.fromCharCode(10))
    document.head.appendChild(s)
  })()`)

  const ready = await waitFor(
    `document.getElementById('plugin-status').textContent.includes('共') && document.getElementById('skills-status').textContent.includes('共')`,
    10000,
  )
  if (!ready) throw new Error('Plugin/Skills 面板未加载完成')
  console.log(
    'layout:',
    await js(
      'debug-layout',
      `(() => {
        const q = (s) => { const el = document.querySelector(s); return el ? getComputedStyle(el).height + ' rc=' + el.getBoundingClientRect().height : 'n/a' }
        return JSON.stringify({ html: q('html'), body: q('body'), shell: q('.app-shell'), main: q('main'), panel: q('.panel.active'), docH: document.documentElement.scrollHeight, bodyH: document.body.scrollHeight })
      })()`,
    ),
  )

  // ---- MCP Tab：粘贴 → 转换 → 写入 ----
  await js("switch-mcp", `document.getElementById('tab-mcp').click()`)
  await sleep(500)
  const sample = JSON.stringify(
    {
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
        },
        search: {
          type: 'http',
          url: 'https://mcp.example.com/search',
        },
      },
    },
    null,
    2,
  )
  await js("fill-json", `document.getElementById('mcp-json').value = ${JSON.stringify(sample)}`)
  await sleep(400)
  await shot('mcp-flow-1')

  await js("convert", `document.getElementById('mcp-convert').click()`)
  const converted = await waitFor(`document.getElementById('mcp-preview').textContent.length > 60`, 6000)
  if (!converted) throw new Error('MCP 转换未完成')
  await sleep(500)
  await shot('mcp-flow-2')

  await js("apply", `window.confirm = () => true; document.getElementById('mcp-apply').click()`)
  const applied = await waitFor(
    `document.getElementById('mcp-warnings').textContent.includes('成功') && document.querySelectorAll('#mcp-server-rows tr').length >= 3`,
    6000,
  )
  if (!applied) throw new Error('MCP 写入未完成')
  await sleep(500)
  await shot('mcp-flow-3')

  // ---- Skills / Plugin Tab ----
  await js("switch-skills", `document.getElementById('tab-skills').click()`)
  await waitFor(`document.querySelectorAll('#skills-rows tr').length >= 3`, 6000)
  await sleep(500)
  await shot('skills')

  await js("switch-plugin", `document.getElementById('tab-plugin').click()`)
  await waitFor(`document.querySelectorAll('#plugin-rows tr').length >= 3`, 6000)
  await sleep(500)
  await shot('plugins')

  // ---- Harness Tab（可选 --harness：真实 dsh web + 官方 Web UI）----
  if (WITH_HARNESS) {
    await js("switch-harness", `document.getElementById('tab-harness').click()`)
    process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? 'demo-token' // demo patch 的 !!js 引用需要可求值
    try {
      harness = await startHarness({ profile: ACTIVE_PROFILE, readyTimeoutMs: 120_000 })
      console.log(`harness ready: ${harness.url}`)
    } catch (err) {
      console.error(`harness 启动失败（跳过 harness 截图）: ${err.message}`)
      harness = null
    }
    if (harness) {
      await js('mount-iframe', `(() => {
        const f = document.getElementById('harness-frame')
        if (f && !f.src) f.src = ${JSON.stringify(harness.url)}
      })()`)
      await sleep(6000) // 等 iframe 提交 + Web UI 首屏渲染
      win.webContents.send(IPC.harnessStatus, { state: 'ready', url: harness.url })
      // harness 面板按原布局（100% 高度 iframe）整窗截取
      await js('restore-layout', `(() => {
        const s = [...document.querySelectorAll('style')].find((el) => el.textContent.includes('preview-surface pre'))
        if (s) s.remove()
      })()`)
      await sleep(800)
      // 关闭官方 Web UI 的引导弹窗：经 WebFrameMain 直接在 iframe 上下文点按钮
      try {
        const frame = win.webContents.mainFrame.frames.find((f) => f.url.includes('127.0.0.1'))
        if (frame) {
          const click = `(() => {
            const btns = [...document.querySelectorAll('button')].map((el) => el.textContent.trim())
            const pick = (exact) => [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === exact)
            const b1 = pick('继续')
            if (b1) { b1.click(); return 'continue' }
            const b2 = [...document.querySelectorAll('button')].find((el) => el.textContent.includes('稍后'))
            if (b2) { b2.click(); return 'later' }
            return 'none'
          })()`
          const r1 = await frame.executeJavaScript(click)
          await sleep(1500)
          const r2 = await frame.executeJavaScript(click)
          console.log(`modal dismiss: ${r1} -> ${r2}`)
          await sleep(2500)
        } else {
          console.log('harness iframe frame 未找到')
        }
      } catch (err) {
        console.log(`modal dismiss 失败: ${err.message}`)
      }
      await shotFull('harness')
    }
    await harness?.stop()
  }

  console.log('capture done')
  app.exit(0)
}

app.on('window-all-closed', () => app.quit())
