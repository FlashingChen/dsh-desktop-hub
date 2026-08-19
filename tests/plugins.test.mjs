// M2 单元测试：插件清单解析与命令封装（不触发真实 pnpm）
import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const {
  listPlugins,
  buildPluginCommand,
  runPluginOp,
  normalizeInstallSpec,
  classifyInstallSpec,
  parseIgnoredBuildPackages,
  parseBuildApprovalKeys,
  approveIgnoredBuilds,
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
  assert.equal(normalizeInstallSpec('github.com/omdsh-dev/DSH-better-sidebar'), 'github:omdsh-dev/DSH-better-sidebar')
  assert.equal(normalizeInstallSpec('https://github.com/owner/repo?tab=readme'), 'github:owner/repo')
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

test('parseIgnoredBuildPackages 提取 pnpm 忽略的构建包并去掉版本', () => {
  assert.deepEqual(
    parseIgnoredBuildPackages('[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: node-pty@1.1.0, @scope/native-addon@2.0.0'),
    ['node-pty', '@scope/native-addon'],
  )
})

test('parseBuildApprovalKeys 保留 Git prepare 错误要求的完整 allowBuilds key', () => {
  const depPath = '@scope/native-addon@git+https://github.com/owner/repo.git#abc1234'
  const output = `[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] git prepare blocked\nhint: allowBuilds:\nhint:   ${depPath}: true`
  assert.deepEqual(parseBuildApprovalKeys(output), [depPath])
})

test('approveIgnoredBuilds 幂等写入 pnpm-workspace.yaml 的 allowBuilds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pnpm-policy-'))
  try {
    const workspaceFile = join(dir, 'pnpm-workspace.yaml')
    writeFileSync(workspaceFile, 'packages:\n  - .\n')
    assert.deepEqual(approveIgnoredBuilds(workspaceFile, ['node-pty']), { changed: true, approved: ['node-pty'] })
    const depPath = '@scope/native-addon@git+https://github.com/owner/repo.git#abc1234'
    assert.deepEqual(approveIgnoredBuilds(workspaceFile, [depPath]), { changed: true, approved: [depPath] })
    const first = (await import('yaml')).parse(readFileSync(workspaceFile, 'utf8'))
    assert.equal(first.allowBuilds['node-pty'], true)
    assert.equal(first.allowBuilds[depPath], true)
    assert.deepEqual(approveIgnoredBuilds(workspaceFile, ['node-pty']), { changed: false, approved: [] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('approveIgnoredBuilds 不覆盖用户明确拒绝的构建包', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pnpm-policy-deny-'))
  try {
    const workspaceFile = join(dir, 'pnpm-workspace.yaml')
    const original = 'allowBuilds:\n  node-pty: false\n'
    writeFileSync(workspaceFile, original)
    assert.throws(() => approveIgnoredBuilds(workspaceFile, ['node-pty']), /明确拒绝/)
    assert.equal(readFileSync(workspaceFile, 'utf8'), original)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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

test('runPluginOp 检测被忽略的构建脚本，授权后自动重试并成功', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'dsh-build-retry-'))
  try {
    const script = join(bin, 'dsh-retry.mjs')
    const marker = join(bin, 'first-attempt')
    const workspaceFile = join(bin, 'pnpm-workspace.yaml')
    writeFileSync(workspaceFile, 'packages:\n  - .\n')
    writeFileSync(
      script,
      "import { existsSync, writeFileSync } from 'node:fs'\n" +
        `const marker = ${JSON.stringify(marker)}\n` +
        `if (!existsSync(marker)) { writeFileSync(marker, '1'); console.error('[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: node-pty@1.1.0'); process.exit(1) }\n` +
        "console.log('retry succeeded')\n",
    )
    const op = runPluginOp({
      dsh: script,
      node: process.execPath,
      profile: 'web',
      action: 'add',
      args: ['github:owner/repo'],
      autoApproveBuilds: { workspaceFile },
      requestBuildApproval: async (packages) => {
        assert.deepEqual(packages, ['node-pty'])
        return true
      },
    })
    let output = ''
    op.stdout.on('data', (chunk) => { output += String(chunk) })
    op.stderr.on('data', (chunk) => { output += String(chunk) })
    const result = await op.done
    assert.equal(result.exitCode, 0)
    assert.match(output, /Ignored build scripts/)
    assert.match(output, /retry succeeded/)
    assert.match((await import('node:fs')).readFileSync(workspaceFile, 'utf8'), /node-pty:\s*true/)
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
})

test('runPluginOp 处理 Git prepare 错误时按完整 depPath 授权并重试', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'dsh-git-build-retry-'))
  try {
    const script = join(bin, 'dsh-git-retry.mjs')
    const marker = join(bin, 'first-attempt')
    const workspaceFile = join(bin, 'pnpm-workspace.yaml')
    const depPath = '@scope/native-addon@git+https://github.com/owner/repo.git#abc1234'
    writeFileSync(workspaceFile, 'packages:\n  - .\n')
    writeFileSync(
      script,
      "import { existsSync, writeFileSync } from 'node:fs'\n" +
        `const marker = ${JSON.stringify(marker)}\n` +
        `if (!existsSync(marker)) { writeFileSync(marker, '1'); console.error('[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] git prepare blocked\\nhint: allowBuilds:\\nhint:   ${depPath}: true'); process.exit(1) }\n` +
        "console.log('git retry succeeded')\n",
    )
    const op = runPluginOp({
      dsh: script,
      node: process.execPath,
      profile: 'web',
      action: 'add',
      args: ['github:owner/repo'],
      autoApproveBuilds: { workspaceFile },
      requestBuildApproval: async (keys) => {
        assert.deepEqual(keys, [depPath])
        return true
      },
    })
    const result = await op.done
    assert.equal(result.exitCode, 0)
    const workspace = (await import('yaml')).parse(readFileSync(workspaceFile, 'utf8'))
    assert.equal(workspace.allowBuilds[depPath], true)
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
})

test('runPluginOp 未获构建授权时保留失败且不写入 allowBuilds', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'dsh-build-denied-'))
  try {
    const script = join(bin, 'dsh-denied.mjs')
    const workspaceFile = join(bin, 'pnpm-workspace.yaml')
    const original = 'packages:\n  - .\n'
    writeFileSync(workspaceFile, original)
    writeFileSync(script, "console.error('[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: node-pty@1.1.0')\nprocess.exit(1)\n")
    const op = runPluginOp({
      dsh: script,
      node: process.execPath,
      profile: 'web',
      action: 'add',
      args: ['github:owner/repo'],
      autoApproveBuilds: { workspaceFile },
      requestBuildApproval: async () => false,
    })
    const result = await op.done
    assert.equal(result.exitCode, 1)
    assert.equal(readFileSync(workspaceFile, 'utf8'), original)
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
})

test('runPluginOp 已成功的普通安装保持成功且不额外写入 allowBuilds', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'dsh-build-success-'))
  try {
    const script = join(bin, 'dsh-success.mjs')
    const workspaceFile = join(bin, 'pnpm-workspace.yaml')
    const original = 'packages:\n  - .\n'
    writeFileSync(workspaceFile, original)
    writeFileSync(script, "console.log('already succeeded')\n")
    const op = runPluginOp({
      dsh: script,
      node: process.execPath,
      profile: 'web',
      action: 'add',
      args: ['some-npm-package'],
      autoApproveBuilds: { workspaceFile },
    })
    const result = await op.done
    assert.equal(result.exitCode, 0)
    assert.equal((await import('node:fs')).readFileSync(workspaceFile, 'utf8'), original)
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
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
    // Windows 不能直跑无扩展名脚本（且 .cmd 需 shell），与生产一致：显式经 node.exe 执行
    const nodeOpt = { node: process.execPath }

    const ok = runPluginOp({ dsh: script, profile: 'web', action: 'add', args: ['x'], ...nodeOpt })
    const out = await ok.done
    assert.equal(out.exitCode, 0)

    const bad = runPluginOp({ dsh: script, profile: 'web', action: 'fail', ...nodeOpt })
    const badOut = await bad.done
    assert.equal(badOut.exitCode, 3)

    const slow = join(bin, 'slow.mjs')
    writeFileSync(slow, 'setTimeout(() => {}, 10_000)\n')
    const cancellable = runPluginOp({ dsh: slow, profile: 'web', action: 'add', ...nodeOpt })
    setTimeout(() => cancellable.cancel(), 50)
    const cancelled = await cancellable.done
    assert.ok(cancelled.signal === 'SIGTERM' || cancelled.exitCode !== 0, `取消必须终止操作：${JSON.stringify(cancelled)}`)
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
})
