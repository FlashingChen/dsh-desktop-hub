// M3 单元测试：MCP JSON→YAML 转换与 patch 事务
import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { parseDocument } from 'yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(join(root, 'dist', 'core', 'mcp.js'))
const { parseMcpJson, convertToRows, convertJsonToYaml, extractMcpServers, replaceMcpRows, updateMcpRow, deleteMcpRow, atomicWriteWithBackup, MCP_PLUGIN } = mod

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
