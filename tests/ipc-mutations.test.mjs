import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const {
  MAX_MCP_ID_BYTES,
  MAX_PLUGIN_ARG_BYTES,
  MAX_SKILL_BODY_BYTES,
  MAX_SKILL_DESCRIPTION_BYTES,
  MAX_SKILL_IMPORT_URL_BYTES,
  validateClawHubImportInput,
  validateMcpDeleteId,
  validatePluginStartInput,
  validateSkillCreateInput,
  validateSkillImportUrl,
  validateSkillToggleInput,
} = await import('../dist/main/ipc-validation.js')

const mainSource = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8')

function handlerSource(channel) {
  const startMarker = `  ipcMain.handle(IPC.${channel},`
  const start = mainSource.indexOf(startMarker)
  assert.notEqual(start, -1, `${channel} handler 必须存在`)
  const next = mainSource.indexOf('\n  ipcMain.handle(', start + startMarker.length)
  return mainSource.slice(start, next === -1 ? undefined : next)
}

test('串行 mutation IPC 在 try/catch 内等待任务，异步失败保持响应契约', () => {
  for (const channel of ['pluginsActivate', 'pluginsDeactivate', 'mcpApply', 'mcpUpdate', 'mcpDelete']) {
    const source = handlerSource(channel)
    assert.match(source, /^  ipcMain\.handle\(IPC\.\w+, async \(/, `${channel} handler 必须是 async`)
    assert.match(
      source,
      /try \{[\s\S]*return await serializeMutation\(/,
      `${channel} 必须在 try/catch 内 await serializeMutation，才能把 reject 转换为原有失败响应`,
    )
  }
})

test('MCP apply/update 通过共享 data-only 验证器收口', () => {
  assert.match(mainSource, /import \{[\s\S]*validateMcpApplyInput,[\s\S]*validateMcpUpdateInput,[\s\S]*\} from '\.\.\/core\/mcp\.js'/)
  assert.doesNotMatch(mainSource, /function normalizeMcpRow\(/, 'main 不应维护第二套漂移的 MCP row 校验')

  const apply = handlerSource('mcpApply')
  assert.match(apply, /validateMcpApplyInput\(input\)/)
  assert.doesNotMatch(apply, /\binput\s+as\b|payload\.(?:rows|mode)/, 'handler 不得直接读取未可信 apply payload')

  const update = handlerSource('mcpUpdate')
  assert.match(update, /validateMcpUpdateInput\(input\)/)
  assert.doesNotMatch(update, /\binput\s+as\b|payload\.(?:id|row)/, 'handler 不得直接读取未可信 update payload')
})

test('Skill 对象 IPC 对 null、数组与抛异常 Proxy 返回稳定校验错误', () => {
  const hostilePrototype = new Proxy({}, { getPrototypeOf: () => { throw new Error('trap') } })
  const hostileGet = new Proxy({}, { get: () => { throw new Error('trap') } })
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  for (const value of [null, undefined, [], hostilePrototype, hostileGet, revoked.proxy]) {
    assert.doesNotThrow(() => validateSkillCreateInput(value))
    assert.equal(validateSkillCreateInput(value).ok, false)
    assert.doesNotThrow(() => validateSkillToggleInput(value))
    assert.equal(validateSkillToggleInput(value).ok, false)
    assert.doesNotThrow(() => validateClawHubImportInput(value))
    assert.equal(validateClawHubImportInput(value).ok, false)
  }

  assert.deepEqual(validateSkillCreateInput({ name: 'safe-skill', description: '说明', body: '正文' }), {
    ok: true,
    value: { name: 'safe-skill', description: '说明', body: '正文', overwrite: false },
  })
  assert.deepEqual(validateSkillToggleInput({ id: 'skill-v1.YQ', source: 'user-dsh', skillKind: 'bundle', kind: 'model', value: false }), {
    ok: true,
    value: { id: 'skill-v1.YQ', source: 'user-dsh', skillKind: 'bundle', kind: 'model', value: false },
  })
  assert.equal(validateSkillToggleInput({ id: 'safe-skill', source: 'user-dsh', skillKind: 'bundle', kind: 'model', value: false }).ok, false)
  assert.equal(validateSkillToggleInput({ id: 'skill-v1.YQ', source: 'user-dsh', kind: 'model', value: false }).ok, false)
})

test('Skill 创建与导入按 UTF-8 字节和控制字符设置边界', () => {
  assert.equal(validateSkillCreateInput({
    name: 'safe-skill',
    description: 'a'.repeat(MAX_SKILL_DESCRIPTION_BYTES + 1),
    body: 'ok',
  }).ok, false)
  assert.equal(validateSkillCreateInput({
    name: 'safe-skill',
    description: 'ok',
    body: 'a'.repeat(MAX_SKILL_BODY_BYTES + 1),
  }).ok, false)
  assert.equal(validateSkillCreateInput({ name: 'safe-skill', description: 'bad\0value', body: 'ok' }).ok, false)
  assert.equal(validateSkillCreateInput({ name: 'safe-skill', description: 'ok', body: 'bad\0value' }).ok, false)

  assert.equal(validateSkillImportUrl(`https://github.com/o/r/${'a'.repeat(MAX_SKILL_IMPORT_URL_BYTES)}`).ok, false)
  assert.equal(validateSkillImportUrl('https://github.com/o/r\n;bad').ok, false)
  assert.deepEqual(validateSkillImportUrl('  https://github.com/o/r  '), { ok: true, value: 'https://github.com/o/r' })

  assert.equal(validateClawHubImportInput({ owner: 'owner', slug: 'slug', version: 'x'.repeat(65) }).ok, false)
  assert.deepEqual(validateClawHubImportInput({ owner: 'owner', slug: 'slug', version: 'latest' }), {
    ok: true,
    value: { owner: 'owner', slug: 'slug', version: 'latest' },
  })
})

test('插件 action 参数形状、数量、单项大小与控制字符被统一约束', () => {
  assert.deepEqual(validatePluginStartInput('add', [' github:owner/repo ']), {
    ok: true,
    value: { action: 'add', args: ['github:owner/repo'] },
  })
  assert.deepEqual(validatePluginStartInput('remove', ['plugin-name']), {
    ok: true,
    value: { action: 'remove', args: ['plugin-name'] },
  })
  assert.deepEqual(validatePluginStartInput('update', []), {
    ok: true,
    value: { action: 'update', args: [] },
  })
  for (const [action, args] of [
    ['add', []],
    ['add', ['one', 'two']],
    ['remove', []],
    ['remove', ['one', 'two']],
    ['update', ['unexpected']],
    ['add', ['bad\0arg']],
    ['remove', ['bad\narg']],
    ['add', ['a'.repeat(MAX_PLUGIN_ARG_BYTES + 1)]],
  ]) {
    assert.equal(validatePluginStartInput(action, args).ok, false, `${action} ${JSON.stringify(args)} 必须拒绝`)
  }
  const hostileArgs = new Proxy([], { get: () => { throw new Error('trap') } })
  assert.doesNotThrow(() => validatePluginStartInput('update', hostileArgs))
  assert.equal(validatePluginStartInput('update', hostileArgs).ok, false)
})

test('MCP delete id 与各 handler 使用规范化校验结果', () => {
  assert.deepEqual(validateMcpDeleteId('  mcp-1  '), { ok: true, value: 'mcp-1' })
  assert.equal(validateMcpDeleteId(`x${'a'.repeat(MAX_MCP_ID_BYTES)}`).ok, false)
  assert.equal(validateMcpDeleteId('mcp\nid').ok, false)

  const pluginStart = handlerSource('pluginsStartOp')
  assert.match(pluginStart, /validatePluginStartInput\(action, args\)/)
  const mcpDelete = handlerSource('mcpDelete')
  assert.match(mcpDelete, /validateMcpDeleteId\(id\)/)
  assert.match(mcpDelete, /deleteMcpRow\(readPatch\(profile\.dir\), validated\.value\)/)
  for (const channel of ['skillsCreate', 'skillsToggle']) {
    assert.match(handlerSource(channel), new RegExp(`validateSkill${channel === 'skillsCreate' ? 'Create' : 'Toggle'}Input\\(input\\)`))
  }
})

test('网络 Skill 导入进入独立跟踪器而不占用 profile 串行锁', () => {
  for (const channel of ['skillsImportUrl', 'skillsImportClawHub']) {
    const source = handlerSource(channel)
    assert.match(source, /await skillImportTasks\.start\(/)
    assert.doesNotMatch(source, /serializeMutation\(/)
    assert.match(source, /try \{[\s\S]*await skillImportTasks\.start\([\s\S]*catch \(err\)/, '退出期拒绝也必须转换为稳定 IPC 响应')
  }
})
