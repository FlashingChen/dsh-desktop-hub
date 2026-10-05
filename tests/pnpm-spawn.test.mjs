// issue #47 回归：Windows 上 pnpm 只有 .cmd shim，shell:false 直接 spawn 必然 ENOENT。
// 这里锁定 planPnpmSpawn 的输出形状，以及 main.ts 的接线（不再 spawn 裸 'pnpm'）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { planPnpmSpawn } = await import(pathToFileURL(join(root, 'dist', 'core', 'pnpm-spawn.js')).href)

/** runtimePathEnv 的布局假设：dsh 的 lib/bin.js 上三级是 node_modules */
function fixtureRuntime(dir) {
  const pnpmEntry = join(dir, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
  const dshEntry = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  for (const file of [dshEntry, pnpmEntry]) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '// fixture')
  }
  return { exec: dshEntry, node: join(dir, 'nd', 'node.exe'), pnpmEntry }
}

test('捆绑运行时优先用「node + pnpm JS 入口」，不经过 shim 与 PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pnpm-plan-bundled-'))
  try {
    const runtime = fixtureRuntime(dir)
    const args = ['add', '--save-exact', '--ignore-scripts', join(dir, 'plugins with space', 'dsh-desktop-hub')]
    const plan = planPnpmSpawn(args, { platform: 'win32', dshExec: runtime })

    assert.equal(plan.executable, runtime.node)
    assert.deepEqual(plan.args, [runtime.pnpmEntry, ...args])
    // 带空格的 profile 路径必须保持单个 argv，绝不进 cmd.exe
    assert.equal(plan.args.at(-1), join(dir, 'plugins with space', 'dsh-desktop-hub'))
    assert.notEqual(plan.executable, 'pnpm')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Windows PATH 回退把 pnpm.cmd shim 解析成 node + 独立 argv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pnpm-plan-shim cmd &-'))
  try {
    const shim = join(dir, 'bin', 'pnpm.cmd')
    const entry = join(dir, 'pnpm', 'bin', 'pnpm.mjs')
    const node = join(dir, 'node', 'node.exe')
    for (const file of [entry, node]) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, '// fixture')
    }
    mkdirSync(dirname(shim), { recursive: true })
    writeFileSync(shim, '@ECHO off\r\n"%_prog%" "%dp0%\\..\\pnpm\\bin\\pnpm.mjs" %*\r\n')

    const args = ['add', 'space & name', '%PATH%']
    const plan = planPnpmSpawn(args, {
      platform: 'win32',
      env: { Path: `${join(dir, 'bin')};${join(dir, 'node')}` },
    })

    assert.equal(plan.executable, node)
    assert.deepEqual(plan.args, [entry, ...args])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Windows PATH 回退优先真实 exe，且元字符不会进入 shell', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pnpm-plan-exe-'))
  try {
    const exe = join(dir, 'bin', 'pnpm.exe')
    mkdirSync(dirname(exe), { recursive: true })
    writeFileSync(exe, '// fixture')
    const args = ['add', 'C:\\Users\\x & y\\插件']
    const plan = planPnpmSpawn(args, { platform: 'win32', env: { Path: join(dir, 'bin') } })
    assert.equal(plan.executable, exe)
    assert.deepEqual(plan.args, args)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POSIX 仍可直接启动 PATH 中的 pnpm，捆绑运行时存在时优先捆绑入口', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pnpm-plan-posix-'))
  try {
    const shim = join(dir, 'bin', 'pnpm')
    mkdirSync(dirname(shim), { recursive: true })
    writeFileSync(shim, '#!/usr/bin/env node\n')

    assert.deepEqual(
      planPnpmSpawn(['install'], { platform: 'darwin', env: { PATH: join(dir, 'bin') } }),
      { executable: shim, args: ['install'] },
    )

    const runtime = fixtureRuntime(dir)
    assert.deepEqual(
      planPnpmSpawn(['install'], { platform: 'darwin', env: { PATH: join(dir, 'bin') }, dshExec: runtime }),
      { executable: runtime.node, args: [runtime.pnpmEntry, 'install'] },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('找不到 pnpm 时抛出可诊断错误，而不是回退到裸 pnpm', () => {
  assert.throws(
    () => planPnpmSpawn(['add'], { platform: 'win32', env: { Path: '' }, pathExists: () => false }),
    /未找到可用的 pnpm/,
  )
  assert.throws(
    () => planPnpmSpawn(['add'], { platform: 'linux', env: { PATH: '' }, pathExists: () => false }),
    /未找到可用的 pnpm/,
  )
})

test('pnpm.cmd 无法解析或没有 node 时明确失败，绝不静默回退到 shell', () => {
  const common = { platform: 'win32', pathExists: (file) => file.endsWith('pnpm.cmd') || file.endsWith('node.exe') }
  assert.throws(
    () => planPnpmSpawn(['add'], { ...common, env: { Path: 'C:\\bin' }, readShim: () => '@echo off\r\npnpm.exe %*' }),
    /无法解析 Windows pnpm shim/,
  )
  assert.throws(
    () =>
      planPnpmSpawn(['add'], {
        platform: 'win32',
        env: { Path: 'C:\\bin' },
        pathExists: (file) => file.endsWith('pnpm.cmd') || file.endsWith('pnpm.mjs'),
        readShim: () => '"%dp0%\\..\\pnpm\\bin\\pnpm.mjs" %*',
      }),
    /PATH 中没有可用的 node\.exe/,
  )
})

test('main.ts 的 runPnpm 走 planPnpmSpawn、保持 shell:false，插件失败不阻断启动', () => {
  const main = readFileSync(join(root, 'src', 'main', 'main.ts'), 'utf8')
  const runPnpm = main.slice(main.indexOf('function runPnpm'), main.indexOf('async function ensureDesktopHubPlugin'))

  assert.match(runPnpm, /planPnpmSpawn\(/)
  assert.doesNotMatch(runPnpm, /spawnProcess\(\s*'pnpm'/, '不得再以 shell:false 直接 spawn 裸 pnpm（Windows 必然 ENOENT）')
  assert.match(runPnpm, /shell:\s*false/)

  // 可选 UI 插件准备失败必须降级为告警：否则一个插件会锁死整个工作区
  assert.match(main, /await ensureDesktopHubPlugin\(\)\.catch\(/)
  assert.match(main, /patchFiles: desktopHubPatch \? \[desktopHubPatch\] : \[\]/)
  assert.match(main, /state: 'ready', url: next\.url/)
  assert.equal(existsSync(join(root, 'dist', 'core', 'pnpm-spawn.js')), true)
})
