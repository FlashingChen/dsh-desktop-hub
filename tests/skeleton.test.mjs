// M0 骨架契约测试：守卫工程结构不被破坏
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('骨架文件齐全', () => {
  for (const f of [
    'src/main/main.ts',
    'src/preload/preload.ts',
    'src/renderer/index.html',
    'src/renderer/renderer.ts',
  ]) {
    assert.ok(existsSync(join(root, f)), `缺少 ${f}`)
  }
})

test('package.json 提供全部脚本与 devDependencies', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  for (const s of ['typecheck', 'test', 'build', 'start', 'verify']) {
    assert.equal(typeof pkg.scripts?.[s], 'string', `缺少脚本 ${s}`)
  }
  for (const d of ['electron', 'typescript', '@types/node']) {
    assert.ok(pkg.devDependencies?.[d], `缺少 devDependency ${d}`)
  }
  assert.equal(
    pkg.scripts.typecheck,
    'tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.renderer.json',
    '直接运行 typecheck 必须同时检查主进程与 renderer 配置',
  )
})

test('渲染层包含工作区 Tab（Harness/Plugin/MCP/Skills/Feedback）', () => {
  const html = readFileSync(join(root, 'src/renderer/index.html'), 'utf8')
  for (const tab of ['harness', 'plugin', 'mcp', 'skills', 'feedback']) {
    assert.ok(html.includes(`data-tab="${tab}"`), `缺少 tab ${tab}`)
    assert.ok(html.includes(`id="panel-${tab}"`), `缺少面板 ${tab}`)
  }
})

test('Desktop Hub leaves account management to Harness', () => {
  const html = readFileSync(join(root, 'src/renderer/index.html'), 'utf8')
  assert.doesNotMatch(html, /id="(?:panel-account|account-sign-in|account-sign-out|manager-tab-account)"/)
  for (const file of ['src/core/ipc.ts', 'src/preload/preload.ts', 'src/main/main.ts', 'src/renderer/renderer.ts']) {
    assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /account:(?:get-state|start-sign-in|sign-out)|connectDeepSeekAccount|api\.account/)
  }
})

test('主进程使用安全默认（contextIsolation + sandbox）', () => {
  const main = readFileSync(join(root, 'src/main/main.ts'), 'utf8')
  assert.ok(main.includes('contextIsolation: true'), 'contextIsolation 未开启')
  assert.ok(main.includes('sandbox: true'), 'sandbox 未开启')
  assert.ok(main.includes('nodeIntegration: false'), 'nodeIntegration 未关闭')
})

test('tsconfig 开启严格模式', () => {
  const ts = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'))
  assert.equal(ts.compilerOptions.strict, true)
})

test('package.json 已重命名为 dsh-desktop-hub 并锁定 Electron 43.4.0', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-desktop-hub')
  assert.equal(pkg.productName, 'DSH Desktop Hub')
  assert.equal(pkg.devDependencies?.electron, '43.4.0', 'Electron 必须锁定到审计给出的修复版本')
  assert.ok(!pkg.devDependencies.electron.includes('^'), 'electron 不得使用 semver range')
})

test('pluginOpDone IPC 使用单个 PluginOpDone payload', () => {
  const main = readFileSync(join(root, 'src', 'main', 'main.ts'), 'utf8')
  const preload = readFileSync(join(root, 'src', 'preload', 'preload.ts'), 'utf8')
  assert.ok(main.includes('onDone: (done) => sendPluginEvent(IPC.pluginOpDone, done)'), '主进程必须只发送 done 对象')
  assert.ok(!main.includes('sendPluginEvent(IPC.pluginOpDone, done.token, done)'), '不得把 token 作为额外的第一个 payload')
  assert.ok(preload.includes('ipcRenderer.on(CH.pluginOpDone, (_e, done: PluginOpDone) => cb(done))'), 'preload 必须转发完整 done 对象')
})

test('preload channel 与 src/core/ipc.ts 契约逐字符一致', () => {
  const ipcSrc = readFileSync(join(root, 'src/core/ipc.ts'), 'utf8')
  const preloadSrc = readFileSync(join(root, 'src/preload/preload.ts'), 'utf8')
  const ipcValues = [...ipcSrc.matchAll(/^  (\w+): '([^']+)',?$/gm)].map((m) => [m[1], m[2]])
  const preloadValues = [...preloadSrc.matchAll(/^ {2,4}(\w+): '([^']+)',?$/gm)].map((m) => [m[1], m[2]])
  const ipcMap = new Map(ipcValues)
  const preloadMap = new Map(preloadValues)
  assert.ok(ipcValues.length >= 20, `IPC 契约应有完整 channel 集，实际 ${ipcValues.length}`)
  for (const [key, value] of ipcValues) {
    assert.equal(preloadMap.get(key), value, `channel ${key} 在 preload 中不一致`)
  }
  for (const [key] of preloadValues) {
    assert.ok(ipcMap.has(key), `preload 存在契约外的 channel ${key}`)
  }
})

test('主进程具备窗口安全边界与单实例锁', () => {
  const main = readFileSync(join(root, 'src/main/main.ts'), 'utf8')
  assert.ok(main.includes('setWindowOpenHandler'), '缺少 popup 拦截')
  const externalOpen = main.slice(main.indexOf('function openExternalHttpUrl'), main.indexOf('function hardenWindow'))
  assert.match(externalOpen, /parsed = new URL\(url\)/, '外部链接必须先经 URL 解析')
  assert.match(externalOpen, /parsed\.protocol !== 'http:' && parsed\.protocol !== 'https:'/, '只允许精确的 HTTP(S) protocol')
  assert.match(externalOpen, /shell\.openExternal\(parsed\.href\)\.catch\(reportFailure\)/, '系统浏览器异步失败必须被捕获')
  assert.match(externalOpen, /external-link: 系统浏览器打开/, '系统浏览器失败必须写入明确日志')
  assert.doesNotMatch(externalOpen, /app\.(?:quit|exit)|process\.exit/, '打开外部链接失败不得退出主应用')
  const hardenWindow = main.slice(main.indexOf('function hardenWindow'), main.indexOf('function createWindow'))
  assert.match(hardenWindow, /setWindowOpenHandler[\s\S]*openExternalHttpUrl\(url\)[\s\S]*return \{ action: 'deny' \}/, 'popup 必须交给安全 helper 后始终 deny')
  assert.doesNotMatch(hardenWindow, /url\.startsWith/, '外部协议不得使用字符串前缀判断')
  assert.match(hardenWindow, /\.on\('will-frame-navigate', guardNavigation\)/, '任意 frame 导航必须接入统一策略')
  assert.match(hardenWindow, /\.on\('will-redirect', guardNavigation\)/, '服务端重定向必须接入统一策略')
  assert.match(hardenWindow, /createNavigationGuard\(RENDERER_URL, \(\) => harness\?\.url \?\? null\)/, '导航守卫必须按 details.url 与 isMainFrame 校验目标 frame')
  assert.doesNotMatch(hardenWindow, /\.on\('will-navigate'/, 'will-frame-navigate 已覆盖主 frame，不应重复注册 will-navigate')
  assert.ok(main.includes('setPermissionRequestHandler'), '缺少权限请求拦截')
  assert.ok(main.includes('requestSingleInstanceLock'), '缺少单实例锁')
  assert.ok(main.includes('assertRendererSender'), '缺少 IPC sender 校验')
})

test('冒烟未获取单实例锁时明确失败，产品模式保持普通单实例退出', () => {
  const main = readFileSync(join(root, 'src/main/main.ts'), 'utf8')
  const lockGuard = main.slice(main.indexOf('const gotSingleInstanceLock'), main.indexOf('function activeProfile'))
  assert.match(lockGuard, /if \(SMOKE \|\| HARNESS_SMOKE\)/, '两种冒烟模式都必须处理锁冲突')
  assert.match(lockGuard, /SMOKE FAIL/, '锁冲突必须输出清晰的冒烟失败信息')
  assert.match(lockGuard, /app\.exit\(1\)/, '冒烟断言未执行时必须非零退出')
  assert.match(lockGuard, /else \{\s*app\.quit\(\)/, '产品模式应保持原单实例退出行为')
})

test('两条异步冒烟流程统一捕获 rejection 并非零结束', () => {
  const smoke = readFileSync(join(root, 'src/main/smoke.ts'), 'utf8')
  const runner = smoke.slice(smoke.indexOf('function runSmokeTask'), smoke.indexOf('interface DomSnapshot'))
  assert.match(runner, /void task\(\)\.catch\(/, 'runner 必须捕获事件回调启动的异步任务 rejection')
  assert.match(runner, /SMOKE FAIL: \$\{label\}/, 'runner 必须输出带流程标签的失败信息')
  assert.match(runner, /error instanceof Error/, 'runner 必须保留 Error 诊断信息')
  assert.match(runner, /finishSmoke\(1\)/, 'runner 必须让异步异常以失败状态结束冒烟')

  const wireSmoke = smoke.slice(smoke.indexOf('export function wireSmoke'), smoke.indexOf('// 供外部断言'))
  assert.equal((wireSmoke.match(/runSmokeTask\(/g) ?? []).length, 2, '骨架与 Harness 流程都必须经过统一 runner')
  assert.match(wireSmoke, /runSmokeTask\('骨架冒烟', async \(\) =>/, '骨架流程未接入统一 runner')
  assert.match(wireSmoke, /runSmokeTask\('Harness 冒烟', async \(\) =>/, 'Harness 流程未接入统一 runner')
  assert.doesNotMatch(wireSmoke, /void \(async \(\) =>/, '不得留下无 catch 的异步 IIFE')
})

test('Harness iframe 仅在精确可信同源导航后标记 ready', () => {
  const main = readFileSync(join(root, 'src/main/main.ts'), 'utf8')
  const readyHandler = main.slice(main.indexOf("mainWindow?.webContents.on('did-frame-navigate'"), main.indexOf('// ---- harness 生命周期监控'))
  assert.match(readyHandler, /isAllowedNavigation\(frameURL, RENDERER_URL, activeHarness\.url\)/, 'ready 判定必须复用精确导航策略')
  assert.match(readyHandler, /frameURL !== RENDERER_URL/, 'renderer 子帧不得误报 Harness ready')
  assert.doesNotMatch(readyHandler, /startsWith\(harness\.url\)/, '不得使用可被 credential host confusion 绕过的前缀判断')
})

test('渲染层 skills 表格使用 DOM API（textContent）而非 innerHTML 拼接', () => {
  const renderer = readFileSync(join(root, 'src/renderer/renderer.ts'), 'utf8')
  assert.ok(renderer.includes('tdName.textContent = s.name'), 'skill 名称必须经 textContent 渲染')
  assert.ok(renderer.includes('tdDesc.textContent'), 'skill 描述必须经 textContent 渲染')
  const skillsBlock = renderer.slice(renderer.indexOf('async function refreshSkills'), renderer.indexOf('async function toggleSkill'))
  assert.ok(!skillsBlock.includes('innerHTML'), 'skills 渲染不得使用 innerHTML')
  assert.match(skillsBlock, /kindTag\.textContent = s\.kind === 'bundle' \? '目录包' : '扁平文件'/, '同名 bundle/flat 必须可区分')
  assert.match(skillsBlock, /if \(s\.canToggle\)/, '按钮权限必须使用扫描结果的精确可修改标记')
  assert.match(skillsBlock, /当前被更高优先级 Skill 遮蔽/, 'shadowed 行必须解释 fallback 设置语义')
  assert.match(skillsBlock, /扫描警告 \$\{res\.warnings\.length\} 项/, '扫描 warning 必须在 UI 明确计数')
})

test('Skill toggle 只使用 opaque id/source/file kind fresh-scan，IPC 不暴露或信任路径', () => {
  const main = readFileSync(join(root, 'src/main/main.ts'), 'utf8')
  const resolver = main.slice(main.indexOf('function resolveScannedSkill'), main.indexOf('// ---- IPC 注册'))
  assert.match(resolver, /resolveSkillIdentity\(\{ dshHome: dshHome\(\) \}, \{ id, source, kind \}\)/)
  assert.match(resolver, /realpathSync\(skill\.path\)/, 'toggle 必须二次 canonical path 校验')
  assert.match(resolver, /relative\(rootReal, pathReal\)/, 'toggle 必须二次校验 allowlist root')

  const list = main.slice(main.indexOf('ipcMain.handle(IPC.skillsList'), main.indexOf('ipcMain.handle(IPC.skillsCreate'))
  assert.match(list, /scanSkillsDetailed/)
  assert.match(list, /warnings: scanned\.warnings/)
  assert.doesNotMatch(list, /path: skill\.path|root: skill\.root/, 'renderer 不应获得扫描到的本地路径')

  const toggle = main.slice(main.indexOf('ipcMain.handle(IPC.skillsToggle'), main.indexOf('ipcMain.handle(IPC.skillsImportFile'))
  assert.match(toggle, /resolveScannedSkill\(payload\.id, payload\.source, payload\.skillKind\)/)
  const renderer = readFileSync(join(root, 'src/renderer/renderer.ts'), 'utf8')
  const toggleCall = renderer.slice(renderer.indexOf('async function toggleSkill'), renderer.indexOf('async function createSkill'))
  assert.match(toggleCall, /id: skill\.id, source: skill\.source, skillKind: skill\.kind/)
  assert.doesNotMatch(toggleCall, /skill\.path/)
})

test('渲染层禁止 HTML 字符串注入，MCP 操作直接闭包绑定原始 id', () => {
  const renderer = readFileSync(join(root, 'src/renderer/renderer.ts'), 'utf8')
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'createContextualFragment', 'document.write']) {
    assert.ok(!renderer.includes(sink), `renderer.ts 不得使用 ${sink}`)
  }
  const mcpBlock = renderer.slice(renderer.indexOf('function renderMcpRows'), renderer.indexOf('async function refreshMcpServers'))
  assert.match(mcpBlock, /nameCell\.textContent = name/, 'MCP 名称必须经 textContent 渲染')
  assert.match(mcpBlock, /targetCell\.textContent = target/, 'MCP 目标必须经 textContent 渲染')
  assert.match(mcpBlock, /startMcpEdit\(row\.id\)/, '编辑操作必须闭包绑定当前 row.id')
  assert.match(mcpBlock, /deleteMcpServer\(row\.id\)/, '删除操作必须闭包绑定当前 row.id')
  assert.doesNotMatch(mcpBlock, /dataset|data-mcp-/, 'MCP id 不得经 HTML data 属性往返')
})

test('手动插件安装先经主进程归一化，再把规范 spec 交给 dsh', () => {
  const renderer = readFileSync(join(root, 'src/renderer/renderer.ts'), 'utf8')
  const installBlock = renderer.slice(renderer.indexOf('async function installPlugin'), renderer.indexOf('async function removePlugin'))
  assert.ok(installBlock.includes('api.plugins.prepareInstall(raw)'), '手动输入必须先走安装 spec 预处理')
  assert.ok(installBlock.includes("runPluginOpUi('add', [spec]"), 'dsh 必须接收归一化后的 spec')
  assert.ok(!installBlock.includes("runPluginOpUi('add', [raw]"), '不得把原始 GitHub URL 直接交给 dsh')
})

test('插件操作 IPC 先返回 token，不能等待完成后才让 renderer 获得 token', () => {
  const main = readFileSync(join(root, 'src/main/main.ts'), 'utf8')
  const handler = main.slice(main.indexOf('ipcMain.handle(IPC.pluginsStartOp'), main.indexOf('ipcMain.handle(IPC.pluginsCancelOp'))
  assert.ok(handler.includes('startPluginOp('), 'start handler 必须立即创建并返回操作 token')
  assert.ok(!handler.includes('await streamPluginOp('), 'start handler 不得等待整个插件操作完成')
})

test('插件操作完成链路只做必要刷新并可靠收敛异步错误', () => {
  const renderer = readFileSync(join(root, 'src/renderer/renderer.ts'), 'utf8')
  const installBlock = renderer.slice(renderer.indexOf('async function installPlugin'), renderer.indexOf('async function removePlugin'))
  const updateBlock = renderer.slice(renderer.indexOf('async function updateAllPlugins'), renderer.indexOf('async function cancelPluginOp'))
  assert.doesNotMatch(installBlock, /refreshPlugins\(\)/, '手动安装 afterDone 不得重复中央刷新')
  assert.doesNotMatch(updateBlock, /refreshPlugins\(\)/, '批量更新 afterDone 不得重复中央刷新')

  const finalizeBlock = renderer.slice(renderer.indexOf('async function finalizePluginOp'), renderer.indexOf('api?.plugins.onOpChunk'))
  assert.match(finalizeBlock, /const refreshed = await refreshPlugins\(\)/, '完成链路必须先执行一次中央刷新')
  assert.match(finalizeBlock, /catch \(error\)/, '完成链路必须捕获刷新与 afterDone 异常')
  assert.match(finalizeBlock, /操作已完成但刷新\/后续处理失败/, '收尾失败必须保留操作完成语义并明确提示')
  assert.match(
    finalizeBlock,
    /fireAndForget\([\s\S]*\(\) => finalizePluginOp\(done, afterDone, operationStatus, operationKind\)[\s\S]*setStatus\(message, 'error'\)/,
    'done handler 必须交给带域内错误提示的 fire-and-forget 边界',
  )
  assert.doesNotMatch(finalizeBlock, /void \(async \(\) =>/, '不得留下无 catch 的 async IIFE')

  const marketInstall = renderer.slice(renderer.indexOf('async function installMarketPlugin'), renderer.indexOf('async function installMarketMcp'))
  const beforeActivationRefresh = marketInstall.slice(marketInstall.indexOf("if (entry.activationSource === 'none')"), marketInstall.indexOf('if (activationChanged)'))
  assert.doesNotMatch(beforeActivationRefresh, /refreshPlugins\(\)/, '激活失败时状态未改变，不得重复刷新')
  assert.equal((marketInstall.match(/await refreshPlugins\(\)/g) ?? []).length, 1, 'market install 最多只能有一次条件性二次刷新')
  assert.match(marketInstall, /if \(activationChanged\) \{[\s\S]*await refreshPlugins\(\)/, '仅激活状态改变后才允许二次刷新')
})

test('所有可能执行构建脚本的插件操作都要向用户披露授权风险', () => {
  const renderer = readFileSync(join(root, 'src/renderer/renderer.ts'), 'utf8')
  const updateBlock = renderer.slice(renderer.indexOf('async function updateAllPlugins'), renderer.indexOf('async function cancelPluginOp'))
  assert.match(updateBlock, /pnpm.*构建脚本/, '更新确认必须说明 pnpm 构建脚本授权风险')
})
