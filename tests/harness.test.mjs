// M1 单元测试：harness 核心纯函数（依赖 npm run build 后的 dist）
// 不依赖开发者机器上安装的 dsh / 真实 ~/.dsh（P2-12：验证门禁不得假绿/假红）
import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(join(root, 'dist', 'core', 'harness.js')).href)
const { findDsh, dshHome, listProfiles, parseHarnessUrl, repairDirectoryPickerRows, runtimePathEnv, resolveDshExec } = mod

test('findDsh 优先 DSH_BIN，并总能解析到存在的可执行文件', () => {
  const bin = mkdtempSync(join(tmpdir(), 'dsh-bin-'))
  try {
    const fake = join(bin, 'dsh')
    writeFileSync(fake, '#!/bin/sh\nexit 0\n')
    chmodSync(fake, 0o755)
    const prevBin = process.env.DSH_BIN
    // Windows 无 PATH 键（是 Path），与 findDsh 内部逻辑保持一致
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
    const prevPath = process.env[pathKey]
    try {
      // DSH_BIN 优先
      process.env.DSH_BIN = fake
      assert.equal(findDsh(), fake, 'DSH_BIN 应优先')
      // 无 DSH_BIN 时（PATH 或硬编码候选）应解析到存在的 dsh
      delete process.env.DSH_BIN
      process.env[pathKey] = bin
      const found = findDsh()
      assert.ok(found && existsSync(found), `应解析到存在的 dsh，实际 ${found}`)
    } finally {
      if (prevBin === undefined) delete process.env.DSH_BIN
      else process.env.DSH_BIN = prevBin
      if (prevPath === undefined) delete process.env[pathKey]
      else process.env[pathKey] = prevPath
    }
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
})

test('dshHome 默认 ~/.dsh，可被 DSH_HOME 覆盖', () => {
  const prev = process.env.DSH_HOME
  try {
    assert.equal(dshHome(), join(homedir(), '.dsh'))
    const home = join(tmpdir(), 'dsh-home-test')
    process.env.DSH_HOME = home
    assert.equal(dshHome(), home)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})

test('listProfiles 发现 fixture profile 且解析 bundles，忽略无 package.json 目录', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  try {
    const web = join(home, 'profiles', 'web')
    mkdirSync(web, { recursive: true })
    writeFileSync(
      join(web, 'package.json'),
      JSON.stringify({ dependencies: { '@deepseek-ai/dsh-base': '0.1.0-rc.6' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }),
    )
    const fake = join(home, 'profiles', 'not-a-profile')
    mkdirSync(fake, { recursive: true })
    writeFileSync(join(fake, 'x.txt'), 'x')
    const profiles = listProfiles(home)
    assert.equal(profiles.length, 1, '缺 package.json / 无 bundles 的目录应被过滤')
    assert.equal(profiles[0].name, 'web')
    assert.equal(profiles[0].bundles[0], '@deepseek-ai/dsh-base')
    assert.ok(profiles[0].bundles.includes('@deepseek-ai/dsh-web-app'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('parseHarnessUrl 解析 dsh web 输出', () => {
  assert.equal(parseHarnessUrl('dsh web: http://127.0.0.1:3080'), 'http://127.0.0.1:3080')
  assert.equal(parseHarnessUrl('[info] Listening on 127.0.0.1:45231'), 'http://127.0.0.1:45231')
  assert.equal(parseHarnessUrl('unrelated line'), null)
})

test('runtimePathEnv 在捆绑 runtime 存在时把 node/bin 与 .bin 加入 PATH，否则原样返回', () => {
  const exec = resolveDshExec()
  const env = runtimePathEnv()
  // Windows 的 PATH 键是 Path（大小写敏感，spread 副本不兼容大小写混用），随平台取键
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  assert.ok(env && typeof env[pathKey] === 'string', '应有 PATH')
  if (exec?.node) {
    assert.ok(env[pathKey].includes(dirname(exec.node)), `PATH 应包含捆绑 node/bin: ${env[pathKey]}`)
    assert.ok(env[pathKey].includes(join(root, 'resources', 'rt', 'node_modules', '.bin')), `PATH 应包含运行时 .bin: ${env[pathKey]}`)
  }
  // 不破坏原有 PATH 内容
  assert.ok(env[pathKey].includes(process.env[pathKey] ?? ''), '原 PATH 应保留')
})

test('repairDirectoryPickerRows 移除用户层重复 picker 并留下备份', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-picker-repair-'))
  try {
    const profile = join(home, 'profiles', 'web')
    mkdirSync(profile, { recursive: true })
    writeFileSync(
      join(profile, 'package.json'),
      JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } }),
    )
    const patch = `# keep this comment\n- insert:\n    - id: custom-picker\n      name: '@deepseek-ai/dsh-host-directory-picker-native'\n    - id: keep-me\n      name: some-plugin\n`
    const patchFile = join(profile, 'cordis.patch.yml')
    writeFileSync(patchFile, patch)
    const repairs = repairDirectoryPickerRows(home)
    assert.equal(repairs.length, 1)
    assert.match(readFileSync(patchFile, 'utf8'), /keep-me/)
    assert.doesNotMatch(readFileSync(patchFile, 'utf8'), /dsh-host-directory-picker-native/)
    assert.match(repairs[0], /cordis\.patch\.yml\.bak-/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('repairDirectoryPickerRows 不确认官方 bundle 或遇到显式覆盖时不改用户配置', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-picker-safe-'))
  try {
    const profile = join(home, 'profiles', 'web')
    mkdirSync(profile, { recursive: true })
    const patchFile = join(profile, 'cordis.patch.yml')
    const patch = `- insert:\n    - id: custom-picker\n      name: '@deepseek-ai/dsh-host-directory-picker-native'\n`
    writeFileSync(patchFile, patch)
    assert.deepEqual(repairDirectoryPickerRows(home), [])
    assert.match(readFileSync(patchFile, 'utf8'), /dsh-host-directory-picker-native/)

    writeFileSync(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } }))
    writeFileSync(patchFile, `- insert:\n    - id: directory-picker\n      disabled: true\n    - id: custom-picker\n      name: '@deepseek-ai/dsh-host-directory-picker-native'\n`)
    assert.deepEqual(repairDirectoryPickerRows(home), [])
    assert.match(readFileSync(patchFile, 'utf8'), /disabled: true/)
    assert.match(readFileSync(patchFile, 'utf8'), /dsh-host-directory-picker-native/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('runtimePathEnv(profile) 为缺失的直接 !!js process.env 引用补空字符串，不修改父环境', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-profile-env-'))
  const name = 'DESKTOP_HUB_TEST_MISSING_ENV'
  const fallbackName = 'DESKTOP_HUB_TEST_DEFAULT_EXPR'
  const previousHome = process.env.DSH_HOME
  const previousValue = process.env[name]
  const previousFallback = process.env[fallbackName]
  try {
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    writeFileSync(
      join(home, 'profiles', 'web', 'cordis.patch.yml'),
      `- insert:\n    - id: mcp-test\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        env:\n          TOKEN: !!js process.env.${name}\n          DEFAULTED: !!js process.env.${fallbackName} ?? 'fallback'\n`,
    )
    delete process.env[name]
    delete process.env[fallbackName]
    process.env.DSH_HOME = home
    writeFileSync(join(home, '.env'), `${name}=from-profile-file\n`)
    const fromEnvFile = runtimePathEnv('web')
    assert.equal(fromEnvFile[name], undefined, '不得用空字符串遮蔽 DSH_HOME/.env')
    assert.equal(fromEnvFile[fallbackName], undefined, '带 ?? 默认值的表达式不得被改写')
    rmSync(join(home, '.env'), { force: true })
    const env = runtimePathEnv('web')
    assert.equal(env[name], '', '子进程环境应把缺失引用补为空字符串')
    assert.equal(env[fallbackName], undefined, '带 ?? 默认值的表达式不得被改写')
    assert.equal(process.env[name], undefined, '父进程环境不得被修改')
  } finally {
    if (previousValue === undefined) delete process.env[name]
    else process.env[name] = previousValue
    if (previousFallback === undefined) delete process.env[fallbackName]
    else process.env[fallbackName] = previousFallback
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
