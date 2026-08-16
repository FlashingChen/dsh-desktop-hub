// M0 验证脚本：一键检查骨架契约（结构 + typecheck + 测试）
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
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
]) {
  check(`文件存在: ${f}`, existsSync(req(f)))
}

// 2) package.json 契约
const pkg = JSON.parse(readFileSync(req('package.json'), 'utf8'))
for (const s of ['typecheck', 'test', 'build', 'start', 'verify']) {
  check(`脚本存在: ${s}`, typeof pkg.scripts?.[s] === 'string')
}

// 3) 渲染层四 Tab 契约
const html = readFileSync(req('src/renderer/index.html'), 'utf8')
for (const tab of ['harness', 'plugin', 'mcp', 'skills']) {
  check(`Tab 存在: ${tab}`, html.includes(`data-tab="${tab}"`) && html.includes(`id="panel-${tab}"`))
}

// Windows 下 npm/npx 是 .cmd shim，不能直接 spawn（Node 不会自动解析 .cmd）
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'

// 4) 构建（harness/plugins 测试依赖 dist）
const build = spawnSync(npmCmd, ['run', 'build'], { cwd: root, encoding: 'utf8' })
check('构建通过', build.status === 0, build.status === 0 ? '' : (build.stderr || build.stdout).slice(0, 400))
for (const f of ['dist/main/main.js', 'dist/core/harness.js', 'dist/preload/preload.cjs', 'dist/renderer/index.html']) {
  check(`产物存在: ${f}`, existsSync(req(f)))
}

// 5) typecheck（主 + renderer 两套配置）
const tc = spawnSync(npxCmd, ['tsc', '--noEmit', '-p', 'tsconfig.json'], { cwd: root, encoding: 'utf8' })
const tcR = spawnSync(npxCmd, ['tsc', '--noEmit', '-p', 'tsconfig.renderer.json'], { cwd: root, encoding: 'utf8' })
check('typecheck 通过', tc.status === 0 && tcR.status === 0, tc.status !== 0 ? (tc.stderr || tc.stdout).slice(0, 400) : (tcR.stderr || tcR.stdout).slice(0, 400))

// 6) 测试
const t = spawnSync('node', ['--test', 'tests/*.test.mjs'], { cwd: root, encoding: 'utf8' })
check('测试通过', t.status === 0, t.status === 0 ? '' : (t.stderr || t.stdout).slice(0, 400))

console.log(failed ? '\nVERIFY FAILED' : '\nVERIFY OK')
process.exit(failed ? 1 : 0)
