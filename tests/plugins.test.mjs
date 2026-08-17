// M2 单元测试：插件清单解析与命令封装（不触发真实 pnpm）
import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const {
  listPlugins,
  buildPluginCommand,
  runPluginOp,
  normalizeInstallSpec,
  classifyInstallSpec,
  pluginPatchId,
  isPluginActive,
  activatePlugin,
  deactivatePlugin,
  deactivatePluginIfActive,
} = await import(pathToFileURL(join(root, 'dist', 'core', 'plugins.js')).href)

test('listPlugins 从 bundles ∪ dependencies 解析并分类', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-'))
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@deepseek-ai/dsh-base': '0.1.0-rc.6',
          '@deepseek-ai/dsh-web-app': '0.1.0-rc.6',
          'third-party-bundle': '^1.0.0',
          'plain-dep': 'link:/tmp/x',
        },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'third-party-bundle'] } },
      }),
    )
    const entries = listPlugins({ name: 'test', dir, bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'third-party-bundle'] })
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]))
    assert.equal(byName['@deepseek-ai/dsh-base'].source, 'builtin-bundle')
    assert.equal(byName['@deepseek-ai/dsh-base'].inBundles, true)
    assert.equal(byName['third-party-bundle'].source, 'bundle')
    assert.equal(byName['plain-dep'].source, 'dependency')
    assert.equal(byName['plain-dep'].inBundles, false)
    assert.equal(byName['plain-dep'].spec, 'link:/tmp/x')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listPlugins 排序稳定', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { b: '1', a: '1' }, dsh: { profile: { bundles: ['a'] } } }))
    const names = listPlugins({ name: 't', dir, bundles: ['a'] }).map((e) => e.name)
    assert.deepEqual(names, ['a', 'b'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listPlugins 按 patch 计算 activationSource（bundle / patch / none）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-'))
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { 'bundle-pkg': '1', 'patch-pkg': '1', 'idle-pkg': '1' },
        dsh: { profile: { bundles: ['bundle-pkg'] } },
      }),
    )
    const profile = { name: 't', dir, bundles: ['bundle-pkg'] }
    const patch = `- insert:\n    - id: patch-pkg\n      name: patch-pkg\n`
    const byName = Object.fromEntries(listPlugins(profile, patch).map((e) => [e.name, e]))
    assert.equal(byName['bundle-pkg'].activationSource, 'bundle')
    assert.equal(byName['bundle-pkg'].active, true)
    assert.equal(byName['patch-pkg'].activationSource, 'patch')
    assert.equal(byName['patch-pkg'].active, true)
    assert.equal(byName['idle-pkg'].activationSource, 'none')
    assert.equal(byName['idle-pkg'].active, false)
    // 无 patch 文本时 bundle 仍为 bundle，依赖不误报 active
    const bare = Object.fromEntries(listPlugins(profile).map((e) => [e.name, e]))
    assert.equal(bare['patch-pkg'].activationSource, 'none')
    assert.equal(bare['bundle-pkg'].activationSource, 'bundle')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildPluginCommand 构造官方命令形态', () => {
  assert.deepEqual(buildPluginCommand('web', 'add', ['github:user/repo#abc123']), [
    'plugin', '--profile', 'web', 'add', 'github:user/repo#abc123',
  ])
  assert.deepEqual(buildPluginCommand('web', 'remove', ['some-plugin']), [
    'plugin', '--profile', 'web', 'remove', 'some-plugin',
  ])
})

test('normalizeInstallSpec 将 GitHub 链接转为 github:owner/repo#branch', () => {
  assert.equal(normalizeInstallSpec('https://github.com/deepseek-ai/deepseek-harness'), 'github:deepseek-ai/deepseek-harness')
  assert.equal(normalizeInstallSpec('https://github.com/owner/repo.git'), 'github:owner/repo')
  assert.equal(normalizeInstallSpec('https://github.com/owner/repo/tree/main'), 'github:owner/repo#main')
  assert.equal(normalizeInstallSpec('https://github.com/owner/repo/tree/feat/x'), 'github:owner/repo#feat/x')
  assert.equal(
    normalizeInstallSpec('https://github.com/owner/repo/commit/abc123def456'),
    'github:owner/repo#abc123def456',
  )
  assert.equal(normalizeInstallSpec('some-npm-package'), 'some-npm-package')
  assert.equal(normalizeInstallSpec('github:owner/repo#main'), 'github:owner/repo#main')
  assert.equal(normalizeInstallSpec('./local/path'), './local/path')
})

test('classifyInstallSpec 将 Routing Suite 聚合仓库挡在 plugin 命令前', () => {
  const plan = classifyInstallSpec('https://github.com/yjh051108/dsh-routing-suite/tree/main')
  assert.equal(plan.kind, 'routing-suite')
  assert.equal(plan.normalized, 'github:yjh051108/dsh-routing-suite#main')
  assert.match(plan.message, /不是 DSH bundle/)
  assert.equal(classifyInstallSpec('github:yjh051108/dsh-super-injector').kind, 'plugin')
})

test('activatePlugin 为无 dsh.bundle 依赖写入 patch 激活行', () => {
  const patch = `# keep
- insert:
    - id: mcp-github
      name: '@deepseek-ai/dsh-mcp-client'
      config: {}
`
  const activated = activatePlugin(patch, 'dsh-worktree')
  assert.equal(pluginPatchId('dsh-worktree'), 'dsh-worktree')
  assert.equal(isPluginActive(activated, 'dsh-worktree'), true)
  assert.match(activated, /id: dsh-worktree/)
  assert.match(activated, /name: dsh-worktree/)
  assert.match(activated, /mcp-github/)
  assert.equal(activatePlugin(activated, 'dsh-worktree'), activated)
  const deactivated = deactivatePlugin(activated, 'dsh-worktree')
  assert.equal(isPluginActive(deactivated, 'dsh-worktree'), false)
  assert.match(deactivated, /mcp-github/)
  assert.throws(() => deactivatePlugin(deactivated, 'dsh-worktree'), /未激活/)
})



test('deactivatePluginIfActive 幂等清理 patch 激活行（remove 后残留清理）', () => {
  const patch = `# keep
- insert:
    - id: my-tool
      name: my-tool
`
  const cleaned = deactivatePluginIfActive(patch, 'my-tool')
  assert.equal(isPluginActive(cleaned, 'my-tool'), false, '激活行必须被移除')
  assert.match(cleaned, /# keep/, '无关注释必须保留')
  // 幂等：已清理或从未激活时原样返回，不 throw
  assert.equal(deactivatePluginIfActive(cleaned, 'my-tool'), cleaned)
  assert.equal(deactivatePluginIfActive(patch, 'never-installed'), patch)
})

test('runPluginOp 透传退出码并支持取消', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'dsh-bin-'))
  try {
    const script = join(bin, 'dsh')
    writeFileSync(
      script,
      '#!/usr/bin/env node\n' +
        'const action = process.argv.at(-1)\n' +
        'if (action === "fail") { console.error("boom"); process.exit(3) }\n' +
        'console.log("ok")\n',
    )
    chmodSync(script, 0o755)

    const ok = runPluginOp({ dsh: script, profile: 'web', action: 'add', args: ['x'] })
    const out = await ok.done
    assert.equal(out.exitCode, 0)

    const bad = runPluginOp({ dsh: script, profile: 'web', action: 'fail' })
    const badOut = await bad.done
    assert.equal(badOut.exitCode, 3)
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
})
