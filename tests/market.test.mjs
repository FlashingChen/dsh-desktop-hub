// 扩展市场目录：三类条目契约与安装载荷完整性
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { listMarketItems, findMarketItem, fetchMarketItems } = await import(pathToFileURL(join(root, 'dist', 'core', 'market.js')).href)
const { validateMcpRow } = await import(pathToFileURL(join(root, 'dist', 'core', 'mcp.js')).href)

test('在线市场成功分支只写一次完整目录缓存', () => {
  const source = readFileSync(join(root, 'src', 'core', 'market.ts'), 'utf8')
  assert.equal(
    source.match(/if \(!normalizedQuery\) writeDiskMarketCache\(options\.cacheDir, kind, all\)/g)?.length,
    1,
  )
})

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

test('远程 MCP 市场生成的 stdio/HTTP 行均通过共享验证器，无法映射的 HTTP envHint 会告警跳过', async () => {
  const snapshot = {
    updated: 'test',
    servers: [{
      name: 'validator-compat-stdio',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'compat-server'],
      envHint: ['COMPAT_TOKEN'],
    }, {
      name: 'validator-compat-remote',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/compat',
      envHint: [],
    }, {
      name: 'validator-compat-remote-auth',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/private',
      envHint: ['UNMAPPED_TOKEN'],
    }],
  }
  const registry = {
    servers: [{
      server: {
        name: 'io.example/validator-compat-header',
        title: 'validator-compat-header',
        version: '1.0.0',
        remotes: [{
          type: 'streamable-http',
          url: 'https://registry.example.com/mcp',
          headers: [{ name: 'Authorization' }],
        }],
      },
    }],
    metadata: {},
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    const payload = url.includes('api.github.com/repos/LKMeng2001/dsh-mcp-market')
      ? { content: Buffer.from(JSON.stringify(snapshot)).toString('base64') }
      : url.startsWith('https://registry.modelcontextprotocol.io/')
        ? registry
        : null
    if (!payload) throw new Error(`unexpected URL: ${url}`)
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const result = await fetchMarketItems('mcp', 'validator-compat')
    const remoteItems = result.items.filter((item) => item.kind === 'mcp' && item.name.includes('validator-compat'))
    assert.equal(result.online, true)
    assert.deepEqual(
      new Set(remoteItems.map((item) => item.name)),
      new Set(['validator-compat-stdio', 'validator-compat-remote', 'validator-compat-header']),
    )
    for (const item of remoteItems) {
      const validated = validateMcpRow(item.row)
      assert.equal(validated.ok, true, `${item.name}: ${validated.error ?? ''}`)
    }
    const stdio = remoteItems.find((item) => item.name === 'validator-compat-stdio')
    const remote = remoteItems.find((item) => item.name === 'validator-compat-remote')
    const headerRemote = remoteItems.find((item) => item.name === 'validator-compat-header')
    assert.deepEqual(stdio?.row.config.env, { COMPAT_TOKEN: '${COMPAT_TOKEN}' })
    assert.equal('env' in remote.row.config, false)
    assert.equal('env' in headerRemote.row.config, false)
    assert.match(headerRemote.row.config.headers.Authorization, /^\$\{MCP_.*_AUTHORIZATION\}$/)
    assert.match(result.error, /HTTP headers.*validator-compat-remote-auth/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('市场 HTTP 非成功响应会取消 body，且清理异常不覆盖状态诊断', async () => {
  const originalFetch = globalThis.fetch
  let requests = 0
  let cancellations = 0
  globalThis.fetch = async () => {
    const request = ++requests
    return {
      ok: false,
      status: 503,
      headers: new Headers(),
      body: {
        cancel() {
          cancellations += 1
          if (request === 1) throw new Error('sync cancel failure')
          return Promise.reject(new Error('async cancel failure'))
        },
      },
    }
  }
  try {
    const result = await fetchMarketItems('mcp', 'cancel-http-body-contract')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(result.online, false)
    assert.match(result.error, /HTTP 503/)
    assert.ok(requests >= 3, `DSH API/raw 与官方 Registry 均应尝试，实际 ${requests}`)
    assert.equal(cancellations, requests, '每个 non-ok response 都必须取消 body')
  } finally {
    globalThis.fetch = originalFetch
  }
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
