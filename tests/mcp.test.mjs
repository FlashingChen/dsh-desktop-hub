// M3 单元测试：MCP JSON→YAML 转换与 patch 事务
import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { parseDocument } from 'yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(join(root, 'dist', 'core', 'mcp.js')).href)
const { parseMcpJson, convertToRows, convertJsonToYaml, renderRowsYaml, extractMcpServers, replaceMcpRows, mergeMcpRows, updateMcpRow, deleteMcpRow, atomicWriteWithBackup, MCP_PLUGIN } = mod

const SAMPLE = JSON.stringify({
  mcpServers: {
    github: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
    },
    'remote-search': {
      type: 'http',
      url: 'https://mcp.example.com/search',
      headers: { Authorization: 'Bearer ${MCP_TOKEN}' },
    },
  },
})

test('parseMcpJson 解析混合 stdio+http 输入', () => {
  const { servers, warnings } = parseMcpJson(SAMPLE)
  assert.equal(servers.length, 2)
  const g = servers.find((s) => s.name === 'github')
  assert.equal(g?.transport, 'stdio')
  assert.equal(g?.command, 'npx')
  assert.deepEqual(g?.args, ['-y', '@modelcontextprotocol/server-github'])
  assert.deepEqual(g?.env, { GITHUB_TOKEN: '${GITHUB_TOKEN}' })
  const r = servers.find((s) => s.name === 'remote-search')
  assert.equal(r?.transport, 'streamable-http')
  assert.equal(r?.url, 'https://mcp.example.com/search')
  assert.deepEqual(r?.headers, { Authorization: 'Bearer ${MCP_TOKEN}' })
  assert.deepEqual(warnings, [])
})

test('parseMcpJson 处理 sse 与非法 serverName', () => {
  const { servers, warnings } = parseMcpJson(
    JSON.stringify({
      mcpServers: {
        'bad name!': { command: 'x' },
        legacy: { type: 'sse', url: 'http://x' },
      },
    }),
  )
  assert.equal(servers.length, 1)
  assert.equal(servers[0].name, 'legacy')
  assert.ok(warnings.some((w) => w.includes('sse')))
  assert.ok(warnings.some((w) => w.includes('bad name')))
})

test('parseMcpJson 拒绝非 mcpServers 格式', () => {
  assert.throws(() => parseMcpJson('{"other": 1}'), /格式不支持/)
  assert.throws(() => parseMcpJson('not json'), /JSON 解析失败/)
})

test('convertJsonToYaml 输出带 insert 包装的 profile patch YAML', () => {
  const res = convertJsonToYaml(SAMPLE)
  assert.equal(res.ok, true)
  const parsed = parseDocument(res.yaml ?? '')
  assert.equal(parsed.errors.length, 0)
  assert.match(res.yaml ?? '', /^- insert:/)
  const patch = parsed.toJS()
  assert.equal(patch.length, 1)
  assert.equal(patch[0].insert.length, 2)
  assert.equal(patch[0].insert[0].name, MCP_PLUGIN)
  assert.equal(patch[0].insert[0].config.transport, 'stdio')
  assert.equal(patch[0].insert[1].config.transport, 'streamable-http')
  assert.equal(patch[0].insert[1].config.serverName, 'remote-search')
})

test('convertJsonToYaml 将 ${VAR} 转为 !!js process.env.VAR（Claude Code 环境替换语义）', () => {
  const res = convertJsonToYaml(SAMPLE)
  assert.ok((res.yaml ?? '').includes('GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN'), `实际: ${res.yaml}`)
  assert.ok((res.warnings ?? []).some((w) => w.includes('环境变量引用')), '应有环境变量提示')
  // 非纯变量值保持字面
  const mixed = convertJsonToYaml(JSON.stringify({ mcpServers: { x: { command: 'a', env: { PATH: '/usr/bin:/bin', TOKEN: '${T}' } } } }))
  assert.ok((mixed.yaml ?? '').includes('PATH: /usr/bin:/bin'), `PATH 应保持字面: ${mixed.yaml}`)
  assert.ok((mixed.yaml ?? '').includes('TOKEN: !!js process.env.T'), `TOKEN 应转换: ${mixed.yaml}`)
})

test('extractMcpServers 从真实风格 patch 提取行', () => {
  const patch = `# 注释应保留
- insert:
    - id: dsh-mode-boost
      name: '@dsh-external/dsh-mode-boost'
      config: {}
    - id: mcp-github
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: github
        transport: stdio
        command: npx
`
  const rows = extractMcpServers(patch)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'mcp-github')
  assert.equal(rows[0].config.serverName, 'github')
})

test('replaceMcpRows 保留无关行、替换 MCP 行、可再解析', () => {
  const patch = `# 头部注释
- insert:
    - id: dsh-mode-boost
      name: '@dsh-external/dsh-mode-boost'
      config: {}
    - id: mcp-old
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: old
        transport: stdio
        command: npx
`
  const next = replaceMcpRows(patch, [
    { id: 'mcp-new', name: MCP_PLUGIN, config: { serverName: 'new', transport: 'streamable-http', url: 'http://x/mcp' } },
  ])
  const doc = parseDocument(next)
  assert.equal(doc.errors.length, 0)
  assert.ok(next.includes('dsh-mode-boost'), '无关行必须保留')
  assert.ok(!next.includes('mcp-old'), '旧 MCP 行必须移除')
  assert.ok(next.includes('mcp-new'), '新 MCP 行必须写入')
  assert.equal(extractMcpServers(next).length, 1)
})

test('updateMcpRow 只更新目标行并保留其他插件', () => {
  const patch = `- insert:
    - id: other
      name: '@dsh-external/example'
      config: {}
    - id: mcp-old
      name: '${MCP_PLUGIN}'
      config:
        serverName: old
        transport: stdio
        command: npx
`
  const next = updateMcpRow(patch, {
    id: 'mcp-old',
    name: MCP_PLUGIN,
    config: { serverName: 'new', transport: 'streamable-http', url: 'http://localhost/mcp' },
  })
  const rows = extractMcpServers(next)
  assert.deepEqual(rows.map((row) => row.id), ['mcp-old'])
  assert.equal(rows[0].config.serverName, 'new')
  assert.ok(next.includes('id: other'))
  assert.throws(() => updateMcpRow(patch, { id: 'missing', name: MCP_PLUGIN, config: {} }), /不存在/)
})

test('deleteMcpRow 支持删除最后一行并拒绝未知 id', () => {
  const patch = `- insert:
    - id: mcp-only
      name: '${MCP_PLUGIN}'
      config:
        serverName: only
        transport: stdio
        command: node
`
  const next = deleteMcpRow(patch, 'mcp-only')
  assert.deepEqual(extractMcpServers(next), [])
  assert.throws(() => deleteMcpRow(patch, 'missing'), /不存在/)
})

test('replaceMcpRows 空 patch 可新建 insert 块', () => {
  const next = replaceMcpRows('', [{ id: 'mcp-a', name: MCP_PLUGIN, config: { serverName: 'a', transport: 'stdio', command: 'x' } }])
  const doc = parseDocument(next)
  assert.equal(doc.errors.length, 0)
  assert.equal(extractMcpServers(next).length, 1)
})

test('atomicWriteWithBackup 落盘且保留备份', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-patch-'))
  try {
    const file = join(dir, 'cordis.patch.yml')
    writeFileSync(file, 'old')
    const backup = atomicWriteWithBackup(file, 'new')
    assert.equal(readFileSync(file, 'utf8'), 'new')
    assert.ok(existsSync(backup), '备份文件必须存在')
    assert.equal(readFileSync(backup, 'utf8'), 'old')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('预览与实际写入同源：replaceMcpRows 与 renderRowsYaml 输出一致（含 !!js 标签）', () => {
  const rows = [
    { id: 'mcp-github', name: MCP_PLUGIN, config: { serverName: 'github', transport: 'stdio', command: 'npx', env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } } },
    { id: 'mcp-remote', name: MCP_PLUGIN, config: { serverName: 'remote', transport: 'streamable-http', url: 'http://x', headers: { Authorization: 'Bearer ${T}' } } },
  ]
  const preview = renderRowsYaml(rows)
  const written = replaceMcpRows('', rows)
  assert.equal(written, preview, '预览与落盘必须逐字符一致（所见即所写）')
  assert.ok(preview.includes('GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN'), `预览应含 !!js 转换: ${preview}`)
  assert.ok(written.includes('GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN'), `落盘应含 !!js 转换: ${written}`)
  // 混合字符串（Bearer ${T}）不是纯 ${VAR}，应保持字面（与 DSH 语义一致）
  assert.ok(written.includes('Authorization: Bearer ${T}'), `混合值应保持字面: ${written}`)
  assert.ok(!written.includes("'${GITHUB_TOKEN}'"), '不应残留字面 ${GITHUB_TOKEN}')
  // 从落盘 patch 提取后仍可解析，且 name 正确
  assert.equal(extractMcpServers(written).length, 2)
})

test('mergeMcpRows 按 id 覆盖/追加并保留其他插件与既有服务器', () => {
  const patch = `# 头部注释
- insert:
    - id: dsh-mode-boost
      name: '@dsh-external/dsh-mode-boost'
      config: {}
    - id: mcp-existing
      name: '${MCP_PLUGIN}'
      config:
        serverName: existing
        transport: stdio
        command: node
`
  const next = mergeMcpRows(patch, [
    { id: 'mcp-existing', name: MCP_PLUGIN, config: { serverName: 'existing-v2', transport: 'streamable-http', url: 'http://new' } },
    { id: 'mcp-added', name: MCP_PLUGIN, config: { serverName: 'added', transport: 'stdio', command: 'npx' } },
  ])
  const rows = extractMcpServers(next)
  assert.deepEqual(rows.map((r) => r.id).sort(), ['mcp-added', 'mcp-existing'])
  assert.equal(rows.find((r) => r.id === 'mcp-existing')?.config.serverName, 'existing-v2')
  assert.ok(next.includes('dsh-mode-boost'), '无关插件行必须保留')
  assert.ok(next.includes('# 头部注释'), '注释必须保留')
  const doc = parseDocument(next)
  assert.equal(doc.errors.length, 0)
})

// ---- P1 修复：!!js 动态值在提取/合并/编辑/删除后必须保真（AST 行级操作）----

const JS_PATCH = `- insert:
    - id: mcp-github
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: github
        transport: stdio
        command: npx
        env:
          GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN
`

test('extractMcpServers 对 !!js 动态值返回 $js 哨兵（保真提取，不 unwrap 成字面字符串）', () => {
  const [row] = extractMcpServers(JS_PATCH)
  assert.deepEqual(row.config.env, { GITHUB_TOKEN: { $js: 'process.env.GITHUB_TOKEN' } }, `提取应保留动态语义: ${JSON.stringify(row.config.env)}`)
})

test('mergeMcpRows 合并新行时保留既有 !!js 行（行级替换，不整表重建）', () => {
  const next = mergeMcpRows(JS_PATCH, [
    { id: 'mcp-added', name: MCP_PLUGIN, config: { serverName: 'added', transport: 'stdio', command: 'node' } },
  ])
  assert.ok(next.includes('GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN'), `!!js 行必须原样保留: ${next}`)
  assert.ok(!next.includes('GITHUB_TOKEN: process.env.GITHUB_TOKEN'), '不得退化为字面字符串')
  assert.ok(next.includes('serverName: added'), '新行必须写入')
  const doc = parseDocument(next)
  assert.equal(doc.errors.length, 0)
})

test('updateMcpRow 编辑一行时保留其他行的 !!js（行级替换）', () => {
  const patch = `${JS_PATCH}- insert:
    - id: mcp-other
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: other
        transport: stdio
        command: node
`
  const next = updateMcpRow(patch, {
    id: 'mcp-other',
    name: MCP_PLUGIN,
    config: { serverName: 'other-v2', transport: 'streamable-http', url: 'http://new' },
  })
  assert.ok(next.includes('GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN'), `未编辑行 !!js 必须保留: ${next}`)
  assert.ok(next.includes('serverName: other-v2'), '目标行必须更新')
  const doc = parseDocument(next)
  assert.equal(doc.errors.length, 0)
})

test('deleteMcpRow 删除一行时保留其余行的 !!js（行级删除）', () => {
  const patch = `${JS_PATCH}- insert:
    - id: mcp-other
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: other
        transport: stdio
        command: node
`
  const next = deleteMcpRow(patch, 'mcp-other')
  assert.ok(next.includes('GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN'), `剩余行 !!js 必须保留: ${next}`)
  assert.ok(!next.includes('mcp-other'), '目标行必须删除')
})

test('atomicWriteWithBackup 原文件不存在时跳过备份并按 0600 新建；存在时保留原 mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-patch-'))
  try {
    const file = join(dir, 'cordis.patch.yml')
    const backup = atomicWriteWithBackup(file, 'first')
    assert.equal(backup, '', '原文件不存在时不应产生备份，也不应抛 ENOENT')
    assert.equal(readFileSync(file, 'utf8'), 'first')
    const mode = statSync(file).mode & 0o777
    assert.equal(mode, 0o600, `新文件应为 0600，实际 ${mode.toString(8)}`)
    chmodSync(file, 0o600)
    const backup2 = atomicWriteWithBackup(file, 'second')
    assert.ok(backup2, '已有文件应备份')
    assert.equal(readFileSync(backup2, 'utf8'), 'first')
    assert.equal(statSync(file).mode & 0o777, 0o600, `写后应保持 0600，实际 ${(statSync(file).mode & 0o777).toString(8)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
