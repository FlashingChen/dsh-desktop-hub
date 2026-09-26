// M2 单元测试：插件清单解析与命令封装（不触发真实 pnpm）
import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { parseDocument } from 'yaml'

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
  planPluginSpawn,
} = await import(pathToFileURL(join(root, 'dist', 'core', 'plugins.js')).href)

test('Windows npm .cmd shim 解析为 node + 独立 argv，不把插件 spec 交给 shell', () => {
  const bin = mkdtempSync(join(tmpdir(), 'dsh cmd & argv-'))
  try {
    const shim = join(bin, 'dsh.cmd')
    const entry = join(bin, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const node = 'C:\\Program Files\\nodejs\\node.exe'
    const args = ['plugin', '--profile', 'web space', 'add', 'github:owner/repo&whoami', '%PATH%', 'x^y|z']
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, '// fixture')
    writeFileSync(shim, '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n')

    const plan = planPluginSpawn(shim, undefined, args, {
      platform: 'win32',
      findNode: () => node,
    })
    assert.deepEqual(plan, { executable: node, args: [entry, ...args] })
    assert.equal(plan.args.at(-3), 'github:owner/repo&whoami')
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
})

test('Windows .cmd fallback 无标准 JS 入口时 fail closed', () => {
  assert.throws(
    () => planPluginSpawn('C:\\tools\\dsh.cmd', undefined, ['plugin'], {
      platform: 'win32',
      readShim: () => '@echo off\r\ndsh.exe %*',
      pathExists: () => false,
      findNode: () => 'C:\\node.exe',
    }),
    /无法解析 Windows dsh shim/,
  )
})

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

test('listPlugins 过滤畸形 entry，trim/去重并保留其余插件面板内容', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-normalize-'))
  const warnings = []
  try {
    const dependencies = Object.create(null)
    dependencies[' good-plugin '] = ' ^1.0.0 '
    dependencies['good-plugin'] = '^1.1.0'
    dependencies['bad-object'] = { version: '1' }
    dependencies['bad-null'] = null
    dependencies['bad-number'] = 7
    dependencies['bad-empty'] = '   '
    dependencies.__proto__ = '^9.0.0'
    dependencies.constructor = '^9.0.0'
    dependencies.duplicate = '^1.0.0'
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies,
      devDependencies: { duplicate: ' ^2.0.0 ', 'dev-only': ' workspace:* ' },
    }))
    const entries = listPlugins({
      name: 'web',
      dir,
      bundles: [' bundle-only ', 'bundle-only', {}, 8, '', '__proto__'],
    }, undefined, { onWarning: (message) => warnings.push(message) })
    assert.deepEqual(entries.map((entry) => entry.name), ['bundle-only', 'dev-only', 'duplicate', 'good-plugin'])
    const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]))
    assert.equal(byName['good-plugin'].spec, '^1.1.0')
    assert.equal(byName.duplicate.spec, '^2.0.0', '合法 devDependency 应保持覆盖 dependency 的原语义')
    assert.equal(byName['dev-only'].spec, 'workspace:*')
    assert.equal(byName['bundle-only'].spec, '')
    assert.equal(byName['bundle-only'].inBundles, true)
    assert.ok(warnings.some((message) => /bad-object.*spec/.test(message)))
    assert.ok(warnings.some((message) => /bad-null.*spec/.test(message)))
    assert.ok(warnings.some((message) => /非法包名「__proto__」/.test(message)))
    assert.ok(warnings.some((message) => /bundle\[2\]/.test(message)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listPlugins 对 package 顶层和 dependency 容器畸形给出清晰错误', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-shape-'))
  const profile = { name: 'web', dir, bundles: [] }
  try {
    for (const value of [null, [], 'not-an-object']) {
      writeFileSync(join(dir, 'package.json'), JSON.stringify(value))
      assert.throws(() => listPlugins(profile), /package\.json 顶层必须是普通对象/)
    }
    for (const [field, value] of [
      ['dependencies', null],
      ['dependencies', []],
      ['dependencies', 'bad'],
      ['devDependencies', 7],
    ]) {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ [field]: value }))
      assert.throws(() => listPlugins(profile), new RegExp(`${field} 必须是普通对象`))
    }
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
  assert.match(activated, /^# keep\n/, '已有 sequence 的文档头注释必须保留')
  assert.match(activated, /id: dsh-worktree/)
  assert.match(activated, /name: dsh-worktree/)
  assert.match(activated, /mcp-github/)
  assert.equal(activatePlugin(activated, 'dsh-worktree'), activated)
  const deactivated = deactivatePlugin(activated, 'dsh-worktree')
  assert.equal(isPluginActive(deactivated, 'dsh-worktree'), false)
  assert.match(deactivated, /mcp-github/)
  assert.throws(() => deactivatePlugin(deactivated, 'dsh-worktree'), /未激活/)
})

test('activatePlugin 从空或纯注释 patch 新建内容时保留文档元信息', () => {
  const empty = activatePlugin('', 'empty-plugin')
  assert.equal(isPluginActive(empty, 'empty-plugin'), true)
  assert.equal(parseDocument(empty).errors.length, 0)

  const commented = activatePlugin('# keep plugin note\n# second line\n', 'commented-plugin')
  assert.match(commented, /^# keep plugin note\n# second line\n/)
  assert.equal(isPluginActive(commented, 'commented-plugin'), true)
  assert.equal(parseDocument(commented).errors.length, 0)
})

test('插件 patch helpers 与 MCP 共用严格 sequence/insert AST 结构边界', () => {
  const operations = [
    (patch) => isPluginActive(patch, 'safe-plugin'),
    (patch) => activatePlugin(patch, 'safe-plugin'),
    (patch) => deactivatePlugin(patch, 'safe-plugin'),
    (patch) => deactivatePluginIfActive(patch, 'safe-plugin'),
  ]
  for (const patch of ['insert: []\n', 'plain scalar\n']) {
    for (const operation of operations) assert.throws(() => operation(patch), /顶层必须是 YAML sequence/)
  }
  for (const patch of ['- insert: {}\n', '- insert: nope\n', '- insert:\n']) {
    for (const operation of operations) assert.throws(() => operation(patch), /insert 必须是 YAML sequence/)
  }

  const activated = activatePlugin('[]\n', 'safe-plugin')
  assert.equal(isPluginActive(activated, 'safe-plugin'), true)
  assert.equal(Array.isArray(parseDocument(activated).toJS()), true, '不得把 sequence 节点 push 进 YAML map.items')
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

test('runPluginOp 取消会终止插件操作生成的孙进程', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'dsh-cancel-tree-'))
  const launcher = join(bin, 'launcher.mjs')
  const grandchild = join(bin, 'grandchild.mjs')
  const marker = join(bin, 'survived')
  let op
  let rootPid
  let grandchildPid
  try {
    writeFileSync(
      grandchild,
      "import { writeFileSync } from 'node:fs'\n" +
        `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'survived'), 2_000)\n` +
        'setInterval(() => {}, 1_000)\n',
    )
    writeFileSync(
      launcher,
      "import { spawn } from 'node:child_process'\n" +
        `const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' })\n` +
        'child.unref()\n' +
        "console.log(`tree-ready ${process.pid} ${child.pid}`)\n" +
        'setInterval(() => {}, 1_000)\n',
    )

    op = runPluginOp({
      dsh: launcher,
      node: process.execPath,
      profile: 'web',
      action: 'add',
    })
    const ready = new Promise((resolve, reject) => {
      let output = ''
      const timeout = setTimeout(() => reject(new Error(`孙进程未及时启动：${output}`)), 3_000)
      op.stdout.on('data', (chunk) => {
        output += String(chunk)
        const match = output.match(/tree-ready (\d+) (\d+)/)
        if (!match) return
        clearTimeout(timeout)
        rootPid = Number(match[1])
        grandchildPid = Number(match[2])
        resolve()
      })
    })
    await ready
    op.cancel()
    let cancelTimeout
    try {
      await Promise.race([
        op.done,
        new Promise((_, reject) => {
          cancelTimeout = setTimeout(() => reject(new Error('插件取消未及时结束')), 3_000)
        }),
      ])
    } finally {
      clearTimeout(cancelTimeout)
    }
    await new Promise((resolve) => setTimeout(resolve, 2_300))
    assert.equal(existsSync(marker), false, '取消后孙进程不得继续执行延迟写入')
  } finally {
    op?.cancel()
    if (process.platform !== 'win32' && rootPid) {
      try {
        process.kill(-rootPid, 'SIGKILL')
      } catch {
        /* 已清理 */
      }
    }
    if (grandchildPid) {
      try {
        process.kill(grandchildPid, 'SIGKILL')
      } catch {
        /* 已清理 */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    rmSync(bin, { recursive: true, force: true })
  }
})

test('runPluginOp 强杀忽略 SIGTERM 的插件进程树并结算取消终态', { skip: process.platform === 'win32' }, async () => {
  const bin = mkdtempSync(join(tmpdir(), 'dsh-cancel-force-tree-'))
  const launcher = join(bin, 'launcher.mjs')
  const grandchild = join(bin, 'grandchild.mjs')
  const marker = join(bin, 'survived-force-cancel')
  let op
  let rootPid
  let grandchildPid
  try {
    writeFileSync(
      grandchild,
      "import { writeFileSync } from 'node:fs'\n" +
        "process.on('SIGTERM', () => {})\n" +
        `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'survived'), 2_500)\n` +
        'setInterval(() => {}, 1_000)\n',
    )
    writeFileSync(
      launcher,
      "import { spawn } from 'node:child_process'\n" +
        "process.on('SIGTERM', () => {})\n" +
        `const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' })\n` +
        'child.unref()\n' +
        "console.log(`force-tree-ready ${process.pid} ${child.pid}`)\n" +
        'setInterval(() => {}, 1_000)\n',
    )

    op = runPluginOp({
      dsh: launcher,
      node: process.execPath,
      profile: 'web',
      action: 'add',
    })
    await new Promise((resolve, reject) => {
      let output = ''
      const timeout = setTimeout(() => reject(new Error(`忽略 SIGTERM 的进程树未及时启动：${output}`)), 3_000)
      op.stdout.on('data', (chunk) => {
        output += String(chunk)
        const match = output.match(/force-tree-ready (\d+) (\d+)/)
        if (!match) return
        clearTimeout(timeout)
        rootPid = Number(match[1])
        grandchildPid = Number(match[2])
        resolve()
      })
    })

    const cancelStarted = Date.now()
    op.cancel()
    op.cancel()
    let cancelTimeout
    try {
      const result = await Promise.race([
        op.done,
        new Promise((_, reject) => {
          cancelTimeout = setTimeout(() => reject(new Error('强制取消未在合理期限内结算')), 3_500)
        }),
      ])
      assert.equal(result.signal, 'SIGKILL', `忽略 SIGTERM 后应由强杀结束：${JSON.stringify(result)}`)
    } finally {
      clearTimeout(cancelTimeout)
    }
    assert.ok(Date.now() - cancelStarted >= 1_500, '测试必须实际经过 SIGTERM 优雅等待窗口')
    await new Promise((resolve) => setTimeout(resolve, 800))
    assert.equal(existsSync(marker), false, '强制取消后孙进程不得执行延迟 marker')
  } finally {
    op?.cancel()
    if (rootPid) {
      try {
        process.kill(-rootPid, 'SIGKILL')
      } catch {
        /* 已清理 */
      }
    }
    if (grandchildPid) {
      try {
        process.kill(grandchildPid, 'SIGKILL')
      } catch {
        /* 已清理 */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    rmSync(bin, { recursive: true, force: true })
  }
})
