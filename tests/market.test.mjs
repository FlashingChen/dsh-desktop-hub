// 扩展市场目录：三类条目契约与安装载荷完整性
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { listMarketItems, findMarketItem, fetchMarketItems } = await import(pathToFileURL(join(root, 'dist', 'core', 'market.js')).href)

test('市场目录包含 plugin / mcp / skill 三类条目且 id 唯一', () => {
  const all = listMarketItems()
  assert.ok(all.length >= 6)
  assert.deepEqual(new Set(all.map((item) => item.kind)), new Set(['plugin', 'mcp', 'skill']))
  assert.equal(new Set(all.map((item) => item.id)).size, all.length)
  assert.ok(listMarketItems('plugin').every((item) => item.kind === 'plugin'))
  assert.ok(listMarketItems('mcp').every((item) => item.kind === 'mcp'))
  assert.ok(listMarketItems('skill').every((item) => item.kind === 'skill'))
})

test('插件市场条目提供可执行安装 spec 与权限说明', () => {
  const item = findMarketItem('plugin', 'dsh-super-injector')
  assert.equal(item?.kind, 'plugin')
  assert.match(item.spec, /^(npm|github:)/)
  assert.ok(item.permissions.length > 0)
  assert.ok(item.packageName)
})

test('MCP 市场条目提供 dsh-mcp-client 行与稳定 id', () => {
  const items = listMarketItems('mcp')
  assert.ok(items.length >= 3)
  for (const item of items) {
    assert.equal(item.kind, 'mcp')
    assert.equal(item.row.name, '@deepseek-ai/dsh-mcp-client')
    assert.match(item.row.id, /^mcp-market-/)
    assert.equal(typeof item.row.config.serverName, 'string')
    assert.equal(item.row.config.transport, 'stdio')
  }
  const github = findMarketItem('mcp', 'mcp-github')
  assert.deepEqual(github?.requiredEnv, ['GITHUB_PERSONAL_ACCESS_TOKEN'])
  assert.equal(github?.row.config.env?.GITHUB_PERSONAL_ACCESS_TOKEN, '${GITHUB_PERSONAL_ACCESS_TOKEN}')
})

test('Skills 市场条目可离线生成有效模板', () => {
  const items = listMarketItems('skill')
  assert.ok(items.length >= 2)
  for (const item of items) {
    assert.equal(item.kind, 'skill')
    assert.equal(item.install.type, 'template')
    assert.match(item.install.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    assert.ok(item.install.description)
    assert.ok(item.install.body)
  }
})

test('schemaVersion 1 的旧市场缓存将 GitHub stars 从 popularity 迁移出来', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'dsh-market-cache-'))
  const cache = {
    schemaVersion: 1,
    kind: 'plugin',
    fetchedAt: Date.now(),
    items: [{
      id: 'legacy-plugin',
      kind: 'plugin',
      name: 'Legacy Plugin',
      description: 'legacy',
      author: 'owner',
      version: 'GitHub',
      category: 'community',
      tags: [],
      verified: false,
      permissions: [],
      source: 'DSH Plugin Market · curated',
      sourceUrl: 'https://github.com/owner/repo',
      popularity: 42,
      spec: 'github:owner/repo',
      packageName: 'repo',
    }, {
      id: 'legacy-zero-stars',
      kind: 'plugin',
      name: 'Legacy Zero Stars',
      description: 'legacy zero',
      author: 'owner',
      version: 'GitHub',
      category: 'community',
      tags: [],
      verified: false,
      permissions: [],
      source: 'DSH Plugin Market · curated',
      sourceUrl: 'https://github.com/owner/zero-repo',
      popularity: 0,
      spec: 'github:owner/zero-repo',
      packageName: 'zero-repo',
    }],
  }
  await writeFile(join(cacheDir, 'market-plugin.json'), JSON.stringify(cache), 'utf8')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('offline') }
  try {
    const result = await fetchMarketItems('plugin', '', { cacheDir })
    const item = result.items.find((candidate) => candidate.id === 'legacy-plugin')
    assert.equal(result.online, false)
    assert.equal(result.cached, true)
    const zeroStars = result.items.find((candidate) => candidate.id === 'legacy-zero-stars')
    assert.equal(item?.githubStars, 42)
    assert.equal(item?.popularity, undefined)
    assert.equal(zeroStars?.githubStars, undefined)
    assert.equal(zeroStars?.popularity, 0)
  } finally {
    globalThis.fetch = originalFetch
    await rm(cacheDir, { recursive: true, force: true })
  }
})
