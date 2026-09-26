// M3 单元测试：MCP JSON→YAML 转换与 patch 事务
import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync, chmodSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { parseDocument } from 'yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(join(root, 'dist', 'core', 'mcp.js')).href)
const {
  parseMcpJson,
  convertToRows,
  convertJsonToYaml,
  renderRowsYaml,
  extractMcpServers,
  replaceMcpRows,
  mergeMcpRows,
  updateMcpRow,
  deleteMcpRow,
  atomicWriteWithBackup,
  readPatch,
  validateMcpRow,
  validateMcpRows,
  validateMcpApplyInput,
  validateMcpUpdateInput,
  MCP_MAX_PATCH_BYTES,
  MCP_MAX_SERVERS,
  MCP_PLUGIN,
} = mod

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
  assert.throws(() => parseMcpJson('[]'), /顶层必须是普通对象/)
  assert.throws(() => parseMcpJson('{"mcpServers":[]}'), /mcpServers/)
  assert.throws(() => parseMcpJson('not json'), /JSON 解析失败/)
})

test('parseMcpJson 严格拒绝数组映射、空 command、非 HTTP URL 与数组 env', () => {
  assert.throws(() => parseMcpJson('{"mcpServers":[{"command":"npx"}]}'), /mcpServers/)

  const { servers, warnings } = parseMcpJson(JSON.stringify({
    mcpServers: {
      blank: { command: '   ' },
      localFile: { type: 'http', url: 'file:///etc/passwd' },
      arrayEnv: { command: 'npx', env: ['secret'] },
      objectArg: { command: 'npx', args: [{ unsafe: true }] },
    },
  }))
  assert.deepEqual(servers, [])
  assert.ok(warnings.some((warning) => warning.includes('blank') && warning.includes('command')))
  assert.ok(warnings.some((warning) => warning.includes('localFile') && warning.includes('http 或 https')))
  assert.ok(warnings.some((warning) => warning.includes('arrayEnv') && warning.includes('env')))
  assert.ok(warnings.some((warning) => warning.includes('objectArg') && warning.includes('args[0]')))
})

test('parseMcpJson 在落盘前拒绝 child_process 无法处理的 NUL 字符', () => {
  const { servers, warnings } = parseMcpJson(JSON.stringify({
    mcpServers: {
      nulCommand: { command: 'np\0x' },
      nulArg: { command: 'npx', args: ['ok', 'bad\0arg'] },
      nulCwd: { command: 'npx', cwd: '/tmp/bad\0dir' },
      nulEnv: { command: 'npx', env: { TOKEN: 'bad\0value' } },
      newlineAllowed: { command: 'npx', args: ['line\nbreak'], env: { NOTE: 'line\nbreak' } },
    },
  }))

  assert.deepEqual(servers.map((server) => server.name), ['newlineAllowed'])
  for (const name of ['nulCommand', 'nulArg', 'nulCwd', 'nulEnv']) {
    assert.ok(warnings.some((warning) => warning.includes(name) && warning.includes('NUL')), `${name} 必须给出 NUL 诊断`)
  }
})

test('parseMcpJson mixed 输入跳过非法项并保留合法 env、headers 与 SSE 兼容提示', () => {
  const { servers, warnings } = parseMcpJson(JSON.stringify({
    mcpServers: {
      validStdio: {
        type: 'stdio',
        command: ' npx ',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: '${GITHUB_TOKEN}', EMPTY_OK: '' },
      },
      validSse: {
        type: 'sse',
        baseUrl: 'https://mcp.example.com/events',
        headers: { Authorization: 'Bearer ${MCP_TOKEN}', 'X-Client': 'desktop' },
      },
      credentialUrl: { type: 'http', url: 'https://user:secret@mcp.example.com/' },
      mixedTransport: { command: 'npx', url: 'https://mcp.example.com/' },
      wrongType: { type: 'stdio', url: 'https://mcp.example.com/' },
      primitive: 'npx',
    },
  }))

  assert.deepEqual(servers.map((server) => server.name), ['validStdio', 'validSse'])
  assert.equal(servers[0].command, 'npx')
  assert.deepEqual(servers[0].env, { GITHUB_TOKEN: '${GITHUB_TOKEN}', EMPTY_OK: '' })
  assert.equal(servers[1].transport, 'streamable-http')
  assert.deepEqual(servers[1].headers, { Authorization: 'Bearer ${MCP_TOKEN}', 'X-Client': 'desktop' })
  assert.ok(warnings.some((warning) => warning.includes('validSse') && warning.includes('sse')))
  assert.ok(warnings.some((warning) => warning.includes('credentialUrl') && warning.includes('credentials')))
  assert.ok(warnings.some((warning) => warning.includes('mixedTransport') && warning.includes('不能同时')))
  assert.ok(warnings.some((warning) => warning.includes('wrongType') && warning.includes('stdio 配置不能包含')))
  assert.ok(warnings.some((warning) => warning.includes('primitive') && warning.includes('普通对象')))
})

test('parseMcpJson 对服务器数量与字段规模设置明确上限', () => {
  const tooMany = Object.fromEntries(Array.from({ length: MCP_MAX_SERVERS + 1 }, (_, index) => [`s${index}`, { command: 'npx' }]))
  assert.throws(() => parseMcpJson(JSON.stringify({ mcpServers: tooMany })), /每次最多导入/)
  assert.throws(
    () => parseMcpJson(JSON.stringify({ mcpServers: {}, padding: 'x'.repeat(2 * 1024 * 1024) })),
    /JSON 超过 .*字节上限/,
  )

  const tooManyArgs = parseMcpJson(JSON.stringify({
    mcpServers: { oversized: { command: 'npx', args: Array.from({ length: 257 }, () => 'x') } },
  }))
  assert.deepEqual(tooManyArgs.servers, [])
  assert.ok(tooManyArgs.warnings.some((warning) => warning.includes('args 最多允许')))
})

test('validateMcpRow 为直接 apply/update 提供同一核心安全边界', () => {
  const valid = validateMcpRow({
    id: ' mcp-direct ',
    name: 'ignored',
    config: {
      serverName: 'direct',
      transport: 'stdio',
      command: ' npx ',
      args: ['-y', 'server'],
      env: { TOKEN: '${TOKEN}' },
    },
  })
  assert.equal(valid.ok, true)
  assert.equal(valid.row.id, 'mcp-direct')
  assert.equal(valid.row.name, MCP_PLUGIN)
  assert.equal(valid.row.config.command, 'npx')

  for (const [input, expected] of [
    [{ id: 'x', config: { serverName: 'x', transport: 'stdio', command: ' ' } }, /command/],
    [{ id: 'x', config: { serverName: 'x', transport: 'stdio', command: 'npx', env: ['secret'] } }, /env/],
    [{ id: 'x', config: { serverName: 'x', transport: 'streamable-http', url: 'file:///etc/passwd' } }, /http 或 https/],
    [{ id: 'x', config: { serverName: 'x', transport: 'streamable-http', url: 'https://user:pw@example.com' } }, /credentials/],
    [{ id: 'x', config: { serverName: 'x', transport: 'streamable-http', command: 'npx', url: 'https://example.com' } }, /HTTP 配置不能包含/],
  ]) {
    const result = validateMcpRow(input)
    assert.equal(result.ok, false)
    assert.match(result.error, expected)
  }
})

test('validateMcpRow 深层复制并保留受限的未来配置字段', () => {
  const input = {
    id: 'mcp-future',
    config: {
      serverName: 'future',
      transport: 'stdio',
      command: 'node',
      reconnect: {
        enabled: true,
        delays: [100, 250, null],
        policy: {},
        fallbacks: [],
      },
    },
  }
  const result = validateMcpRow(input)
  assert.equal(result.ok, true)
  assert.deepEqual(result.row.config.reconnect, input.config.reconnect)
  assert.notEqual(result.row.config.reconnect, input.config.reconnect, '未来字段必须复制后再交给 YAML，不保留输入引用')
  assert.match(renderRowsYaml([result.row]), /reconnect:/)
})

test('validateMcpRow 拒绝循环、超深、accessor、危险键与非 JSON/YAML 数据', () => {
  const base = () => ({ serverName: 'safe', transport: 'stdio', command: 'node' })

  const cyclic = base()
  cyclic.future = cyclic
  assert.match(validateMcpRow({ id: 'cycle', config: cyclic }).error, /循环引用/)

  let deep = { leaf: true }
  for (let index = 0; index < 100; index += 1) deep = { next: deep }
  assert.match(validateMcpRow({ id: 'deep', config: { ...base(), future: deep } }).error, /嵌套深度/)

  let getterCalled = false
  const accessor = base()
  Object.defineProperty(accessor, 'future', {
    enumerable: true,
    get() {
      getterCalled = true
      throw new Error('must not run')
    },
  })
  assert.match(validateMcpRow({ id: 'accessor', config: accessor }).error, /accessor/)
  assert.equal(getterCalled, false)

  const dangerous = base()
  Object.defineProperty(dangerous, '__proto__', { value: { polluted: true }, enumerable: true })
  assert.match(validateMcpRow({ id: 'danger', config: dangerous }).error, /危险键/)

  for (const [label, value, expected] of [
    ['undefined', undefined, /undefined/],
    ['bigint', 1n, /bigint/],
    ['map', new Map([['x', 1]]), /普通对象或数组/],
    ['binary', new ArrayBuffer(8), /binary/],
    ['nan', Number.NaN, /有限数字/],
  ]) {
    const result = validateMcpRow({ id: label, config: { ...base(), future: value } })
    assert.equal(result.ok, false, label)
    assert.match(result.error, expected, label)
  }
})

test('validateMcpRows 对单字符串、集合项与 aggregate payload 设总预算', () => {
  assert.match(
    validateMcpRow({
      id: 'large-string',
      config: { serverName: 'large', transport: 'stdio', command: 'node', future: 'x'.repeat(128 * 1024 + 1) },
    }).error,
    /131072 字节上限/,
  )
  assert.match(
    validateMcpRow({
      id: 'large-array',
      config: { serverName: 'array', transport: 'stdio', command: 'node', future: Array.from({ length: 257 }, () => 1) },
    }).error,
    /数组项数超过 256/,
  )

  const rows = Array.from({ length: MCP_MAX_SERVERS }, (_, index) => ({
    id: `mcp-${index}`,
    config: {
      serverName: `s${index}`,
      transport: 'stdio',
      command: 'node',
      future: 'x'.repeat(20_000),
    },
  }))
  const aggregate = validateMcpRows(rows)
  assert.equal(aggregate.ok, false)
  assert.match(aggregate.error, /总量|序列化后超过/)
})

test('MCP apply/update 顶层 payload 只读取 data property 并稳定拒绝 hostile record', () => {
  const row = { id: 'mcp-safe', config: { serverName: 'safe', transport: 'stdio', command: 'node' } }
  assert.deepEqual(validateMcpApplyInput({ rows: [row], mode: 'replace' }), {
    ok: true,
    value: { rows: [{ ...row, name: MCP_PLUGIN }], mode: 'replace' },
  })
  assert.deepEqual(validateMcpUpdateInput({ id: 'mcp-existing', row }), {
    ok: true,
    value: { row: { ...row, id: 'mcp-existing', name: MCP_PLUGIN } },
  })

  let getterCalled = false
  const accessor = { rows: [row] }
  Object.defineProperty(accessor, 'mode', {
    enumerable: true,
    get() {
      getterCalled = true
      throw new Error('must not run')
    },
  })
  const hostilePrototype = new Proxy({}, { getPrototypeOf: () => { throw new Error('trap') } })
  const hostileDescriptors = new Proxy({}, { ownKeys: () => { throw new Error('trap') } })
  const hostileGet = new Proxy({ rows: [row] }, { get: () => { throw new Error('get must not run') } })
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  for (const value of [null, [], new Map(), accessor, hostilePrototype, hostileDescriptors, revoked.proxy]) {
    assert.doesNotThrow(() => validateMcpApplyInput(value))
    assert.equal(validateMcpApplyInput(value).ok, false)
    assert.doesNotThrow(() => validateMcpUpdateInput(value))
    assert.equal(validateMcpUpdateInput(value).ok, false)
  }
  assert.equal(getterCalled, false)
  assert.equal(validateMcpApplyInput(hostileGet).ok, true, '合法 descriptor 副本不得触发原 Proxy get trap')
  assert.equal(validateMcpApplyInput({ rows: [row], mode: 'overwrite' }).ok, false)
  assert.equal(validateMcpApplyInput({ rows: [row], unexpected: true }).ok, false)
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

test('unwrap 通过 YAML 类型守卫区分空 map、空 seq 并保真 !!js', () => {
  const patch = `- insert:
    - id: mcp-shapes
      name: '${MCP_PLUGIN}'
      config:
        serverName: shapes
        transport: stdio
        command: node
        emptyMap: {}
        emptySeq: []
        token: !!js process.env.TOKEN
`
  const [row] = extractMcpServers(patch)
  assert.deepEqual(row.config.emptyMap, {})
  assert.deepEqual(row.config.emptySeq, [])
  assert.deepEqual(row.config.token, { $js: 'process.env.TOKEN' })
})

test('所有 patch AST helper 拒绝非 sequence 顶层与 malformed insert', () => {
  const row = { id: 'mcp-safe', name: MCP_PLUGIN, config: { serverName: 'safe', transport: 'stdio', command: 'node' } }
  const operations = [
    (patch) => extractMcpServers(patch),
    (patch) => replaceMcpRows(patch, [row]),
    (patch) => mergeMcpRows(patch, [row]),
    (patch) => updateMcpRow(patch, row),
    (patch) => deleteMcpRow(patch, row.id),
  ]
  for (const patch of ['insert: []\n', 'plain scalar\n', '42\n']) {
    for (const operation of operations) assert.throws(() => operation(patch), /顶层必须是 YAML sequence/)
  }
  for (const patch of ['- insert: {}\n', '- insert: nope\n', '- insert:\n']) {
    for (const operation of operations) assert.throws(() => operation(patch), /insert 必须是 YAML sequence/)
  }

  const next = replaceMcpRows('[]\n', [row])
  assert.equal(extractMcpServers(next).length, 1, '合法空 sequence 仍可追加 insert entry')
})

test('malformed patch 失败时原文件不被写入，patch 读取受字节与行数上限约束', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-malformed-patch-'))
  const file = join(dir, 'cordis.patch.yml')
  try {
    const malformed = 'insert: []\n'
    writeFileSync(file, malformed)
    assert.throws(() => replaceMcpRows(readPatch(dir), [{
      id: 'mcp-safe',
      name: MCP_PLUGIN,
      config: { serverName: 'safe', transport: 'stdio', command: 'node' },
    }]), /顶层必须是 YAML sequence/)
    assert.equal(readFileSync(file, 'utf8'), malformed)

    writeFileSync(file, 'x'.repeat(MCP_MAX_PATCH_BYTES + 1))
    assert.throws(() => readPatch(dir), /patch 超过 .*字节上限/)
    assert.throws(() => extractMcpServers('- {}\n'.repeat(50_001)), /patch 超过 50000 行上限/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
  assert.match(next, /^# 头部注释\n/, '已有 sequence 的文档头注释必须保留')
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

test('replaceMcpRows 从纯注释 patch 新建内容时保留文档注释与 !!js 标签', () => {
  const next = replaceMcpRows('# keep profile note\n# second line\n', [
    {
      id: 'mcp-commented',
      name: MCP_PLUGIN,
      config: { serverName: 'commented', transport: 'stdio', command: 'x', env: { TOKEN: '${TOKEN}' } },
    },
  ])

  assert.match(next, /^# keep profile note\n# second line\n/)
  assert.match(next, /TOKEN: !!js process\.env\.TOKEN/)
  assert.equal(parseDocument(next).errors.length, 0)
  assert.deepEqual(extractMcpServers(next)[0].config.env, { TOKEN: { $js: 'process.env.TOKEN' } })
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

test('readPatch 只把不存在的 patch 当作空文本，其他读取错误继续抛出', () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'mcp-read-patch-'))
  try {
    assert.equal(readPatch(profileDir), '')
    mkdirSync(join(profileDir, 'cordis.patch.yml'))
    assert.throws(
      () => readPatch(profileDir),
      (err) => err instanceof Error && err.code !== 'ENOENT',
      'patch 路径是目录时不得伪装成空配置',
    )
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
})

test('atomicWriteWithBackup 同一毫秒连续写保留不同前态且不覆盖已有工件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-unique-backup-'))
  const file = join(dir, 'cordis.patch.yml')
  const fixedNow = 1_700_000_000_123
  const legacyBackup = `${file}.bak-${fixedNow}`
  const legacyTmp = join(dir, `.cordis.patch.yml.tmp-${fixedNow}`)
  const originalNow = Date.now
  try {
    writeFileSync(file, 'initial')
    writeFileSync(legacyBackup, 'existing backup')
    writeFileSync(legacyTmp, 'existing tmp')
    Date.now = () => fixedNow

    const firstBackup = atomicWriteWithBackup(file, 'first')
    const secondBackup = atomicWriteWithBackup(file, 'second')

    assert.notEqual(firstBackup, secondBackup)
    assert.equal(readFileSync(firstBackup, 'utf8'), 'initial')
    assert.equal(readFileSync(secondBackup, 'utf8'), 'first')
    assert.equal(readFileSync(file, 'utf8'), 'second')
    assert.equal(readFileSync(legacyBackup, 'utf8'), 'existing backup')
    assert.equal(readFileSync(legacyTmp, 'utf8'), 'existing tmp')
  } finally {
    Date.now = originalNow
    rmSync(dir, { recursive: true, force: true })
  }
})

test('atomicWriteWithBackup 最终 rename 失败时清理临时文件并保留备份', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-rename-failure-'))
  const file = join(dir, 'cordis.patch.yml')
  const originalRenameSync = fs.renameSync
  try {
    writeFileSync(file, 'original')
    fs.renameSync = () => {
      const err = new Error('forced rename failure')
      err.code = 'EIO'
      throw err
    }
    syncBuiltinESMExports()

    assert.throws(() => atomicWriteWithBackup(file, 'replacement'), /forced rename failure/)
  } finally {
    fs.renameSync = originalRenameSync
    syncBuiltinESMExports()
  }
  try {
    const artifacts = readdirSync(dir)
    const backups = artifacts.filter((name) => name.includes('.bak-'))
    assert.equal(readFileSync(file, 'utf8'), 'original')
    assert.equal(backups.length, 1, `成功备份必须保留：${artifacts.join(', ')}`)
    assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), 'original')
    assert.equal(artifacts.some((name) => name.includes('.tmp-')), false, `临时文件必须清理：${artifacts.join(', ')}`)
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
    // Windows 无 POSIX 权限模型（chmod 仅 readonly 位），0600 语义不可表达，预期 0666
    const expectedMode = process.platform === 'win32' ? 0o666 : 0o600
    assert.equal(mode, expectedMode, `新文件应为 ${expectedMode.toString(8)}，实际 ${mode.toString(8)}`)
    chmodSync(file, 0o600)
    const backup2 = atomicWriteWithBackup(file, 'second')
    assert.ok(backup2, '已有文件应备份')
    assert.equal(readFileSync(backup2, 'utf8'), 'first')
    assert.equal(statSync(file).mode & 0o777, expectedMode, `写后应保持 ${expectedMode.toString(8)}，实际 ${(statSync(file).mode & 0o777).toString(8)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
