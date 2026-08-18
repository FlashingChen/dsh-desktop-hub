// M0 验证脚本：一键检查骨架契约（结构 + typecheck + 测试）
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const req = (p) => join(root, p)
let failed = false

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failed = true
}

// 1) 骨架文件存在
for (const f of [
  'src/main/main.ts',
  'src/preload/preload.ts',
  'src/renderer/index.html',
  'src/renderer/renderer.ts',
  'scripts/verify.mjs',
  'scripts/smoke-plugin-remove.mjs',
]) {
  check(`文件存在: ${f}`, existsSync(req(f)))
}

// 2) package.json 契约
const pkg = JSON.parse(readFileSync(req('package.json'), 'utf8'))
for (const s of ['typecheck', 'test', 'build', 'start', 'verify', 'smoke:plugin']) {
  check(`脚本存在: ${s}`, typeof pkg.scripts?.[s] === 'string')
}

// 3) 渲染层四 Tab 契约
const html = readFileSync(req('src/renderer/index.html'), 'utf8')
for (const tab of ['harness', 'plugin', 'mcp', 'skills']) {
  check(`Tab 存在: ${tab}`, html.includes(`data-tab="${tab}"`) && html.includes(`id="panel-${tab}"`))
}

// Windows 下 npm/npx 是 .cmd shim，不能直接 spawn（Node 不会自动解析 .cmd）→ 须 shell:true 交给 cmd /c
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const spawnOpts = { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' }
/** 组装错误摘要：spawn 失败时 stderr/stdout 可能为 null，不得直接 .slice（防空指针掩蔽真实错误）；取尾部（错误详情通常在末尾） */
const errSummary = (r) => String((r.stderr || r.stdout || `spawn 失败（status=${r.status} error=${r.error ?? ''}）`).slice(-2000))

// 4) 构建（harness/plugins 测试依赖 dist）
const build = spawnSync(npmCmd, ['run', 'build'], spawnOpts)
check('构建通过', build.status === 0, build.status === 0 ? '' : errSummary(build))
for (const f of ['dist/main/main.js', 'dist/core/harness.js', 'dist/preload/preload.cjs', 'dist/renderer/index.html']) {
  check(`产物存在: ${f}`, existsSync(req(f)))
}

// 5) typecheck（主 + renderer 两套配置）
const tc = spawnSync(npxCmd, ['tsc', '--noEmit', '-p', 'tsconfig.json'], spawnOpts)
const tcR = spawnSync(npxCmd, ['tsc', '--noEmit', '-p', 'tsconfig.renderer.json'], spawnOpts)
const tcOk = tc.status === 0 && tcR.status === 0
check('typecheck 通过', tcOk, tcOk ? '' : (tc.status !== 0 ? errSummary(tc) : errSummary(tcR)))

// 6) 测试（node --test 无参数：默认发现规则扫描 tests/ 目录；Windows 下传 glob 会被展开成 d:\... 路径报错）
const t = spawnSync('node', ['--test'], { cwd: root, encoding: 'utf8' })
const tOk = t.status === 0
let tDetail = tOk ? '' : String(t.stderr ?? t.stdout ?? '')
if (!tOk) {
  // 失败时完整落盘，便于 CI 工件取回分析（Windows 上输出可能为空或巨大）
  try {
    const logPath = join(root, 'dist', 'test-stderr.log')
    writeFileSync(logPath, `status=${t.status} signal=${t.signal} error=${t.error ?? ''}\n---- stdout ----\n${t.stdout ?? ''}\n---- stderr ----\n${t.stderr ?? ''}`)
    tDetail = `测试失败（status=${t.status}），完整输出已写入 dist/test-stderr.log`
  } catch {
    /* 落盘失败时保留原始摘要 */
  }
}
check('测试通过', tOk, tDetail)

console.log(failed ? '\nVERIFY FAILED' : '\nVERIFY OK')
process.exit(failed ? 1 : 0)
