// Renderer MCP 编辑器的 !!js 还原与 JSON 转换闭环
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rendererSource = readFileSync(join(root, 'src', 'renderer', 'renderer.ts'), 'utf8')
const mcpModule = await import(pathToFileURL(join(root, 'dist', 'core', 'mcp.js')).href)

function loadPrepareMcpEdit() {
  const start = rendererSource.indexOf('function restoreJsRefs(')
  const end = rendererSource.indexOf('\nfunction startMcpEdit(', start)
  assert.notEqual(start, -1, 'restoreJsRefs helper 必须存在')
  assert.notEqual(end, -1, 'prepareMcpEdit helper 必须位于 startMcpEdit 前')
  const source = `${rendererSource.slice(start, end)}\nglobalThis.__prepareMcpEdit = prepareMcpEdit`
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const context = {}
  runInNewContext(javascript, context)
  return context.__prepareMcpEdit
}

test('MCP 编辑 textarea 先还原 process.env 哨兵，转换后恢复 !!js', () => {
  const prepareMcpEdit = loadPrepareMcpEdit()
  const prepared = prepareMcpEdit({
    id: 'mcp-existing',
    name: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: 'existing',
      transport: 'stdio',
      command: 'npx',
      env: {
        TOKEN: { $js: 'process.env.TOKEN' },
      },
    },
  })
  const editable = JSON.parse(prepared.json)
  assert.equal(editable.mcpServers.existing.env.TOKEN, '${TOKEN}')
  assert.equal(prepared.json.includes('"$js"'), false, 'textarea 不应暴露内部 $js 哨兵对象')
  assert.equal(prepared.config.env.TOKEN, '${TOKEN}')

  const converted = mcpModule.convertJsonToYaml(prepared.json)
  assert.equal(converted.ok, true)
  assert.equal(converted.rows[0].config.env.TOKEN, '${TOKEN}')
  assert.match(converted.yaml, /TOKEN: !!js process\.env\.TOKEN/)
})

test('未知 !!js 表达式不能进入编辑草稿或静默降级保存', () => {
  const prepareMcpEdit = loadPrepareMcpEdit()
  const unknownExpression = "process.env.TOKEN ?? 'fallback'"
  assert.throws(
    () => prepareMcpEdit({
      id: 'mcp-unknown-js',
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        serverName: 'unknown-js',
        transport: 'stdio',
        command: 'npx',
        env: { TOKEN: { $js: unknownExpression } },
      },
    }),
    /暂不支持安全往返.*process\.env\.TOKEN/,
  )
})

test('startMcpEdit 仅在完整编辑准备成功后写 textarea 与 draft', () => {
  const start = rendererSource.indexOf('function startMcpEdit(')
  const end = rendererSource.indexOf('\nfunction cancelMcpEdit(', start)
  const source = rendererSource.slice(start, end)
  assert.match(source, /try \{\s*prepared = prepareMcpEdit\(row\)\s*\} catch \(error\) \{[\s\S]*原配置未修改。[\s\S]*return\s*\}/)
  assert.match(source, /input\.value = prepared\.json[\s\S]*mcpDraftRows = \[\{ \.\.\.row, config: prepared\.config \}\]/)
})
