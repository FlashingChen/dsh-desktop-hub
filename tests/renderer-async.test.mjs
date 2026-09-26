// Renderer event/timer/startup fire-and-forget 与文件导入内存边界
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rendererSource = readFileSync(join(root, 'src', 'renderer', 'renderer.ts'), 'utf8')

function transpileHelpers(startMarker, endMarker, exports, context = {}) {
  const start = rendererSource.indexOf(startMarker)
  const end = rendererSource.indexOf(endMarker, start)
  assert.notEqual(start, -1, `${startMarker} 必须存在`)
  assert.notEqual(end, -1, `${endMarker} 必须位于 helper 之后`)
  const assignments = Object.entries(exports).map(([target, source]) => `globalThis.${target} = ${source}`).join('\n')
  const javascript = ts.transpileModule(`${rendererSource.slice(start, end)}\n${assignments}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  runInNewContext(javascript, context)
  return context
}

function immediate() {
  return new Promise((resolve) => setImmediate(resolve))
}

test('fireAndForget 捕获 IPC rejection、同步异常和 reporter teardown，并显示域内错误', async () => {
  const logs = []
  const context = transpileHelpers(
    'function errorText(',
    '\nconst TABS',
    { fireAndForget: 'fireAndForget' },
    { console: { error: (...args) => logs.push(args) } },
  )
  const fireAndForget = context.fireAndForget
  const unhandled = []
  const onUnhandled = (error) => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  try {
    let visible = ''
    assert.equal(
      fireAndForget('刷新插件列表', () => Promise.reject(new Error('IPC disconnected')), (message) => { visible = message }),
      undefined,
    )
    await immediate()
    assert.match(visible, /刷新插件列表失败：(?:Error: )?IPC disconnected/)
    assert.ok(logs.some((entry) => String(entry[0]).includes('刷新插件列表失败')))

    fireAndForget('启动任务', () => { throw new Error('sync failure') }, () => { throw new Error('DOM gone') })
    fireAndForget('销毁窗口', () => Promise.reject(new Error('late failure')), () => { throw new Error('DOM gone') })
    await immediate()
    assert.deepEqual(unhandled, [], '任何 detached rejection 都不得进入 unhandledrejection')
    assert.ok(logs.some((entry) => String(entry[0]).includes('错误状态无法显示')))
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('所有本地 async function 的非 await 调用都位于 fireAndForget task 内', () => {
  const sourceFile = ts.createSourceFile('renderer.ts', rendererSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const asyncNames = new Set()
  const unsafe = []
  const voidExpressions = []

  function collect(node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
      asyncNames.add(node.name.text)
    }
    ts.forEachChild(node, collect)
  }
  collect(sourceFile)

  function isFireAndForgetTask(node) {
    let current = node
    while (current && current !== sourceFile) {
      if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
        const call = current.parent
        return ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === 'fireAndForget' && call.arguments[1] === current
      }
      current = current.parent
    }
    return false
  }

  function audit(node) {
    if (ts.isVoidExpression(node)) voidExpressions.push(node)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && asyncNames.has(node.expression.text)) {
      const awaited = ts.isAwaitExpression(node.parent)
      const returned = ts.isReturnStatement(node.parent)
      if (!awaited && !returned && !isFireAndForgetTask(node)) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        unsafe.push(`${node.expression.text}@${position.line + 1}`)
      }
    }
    ts.forEachChild(node, audit)
  }
  audit(sourceFile)

  assert.deepEqual(unsafe, [])
  assert.equal(voidExpressions.length, 1, '只允许 boundary 内部的 void task().catch')
  assert.match(voidExpressions[0].getText(sourceFile), /^void task\(\)\.catch\(reject\)$/)
  for (const reporter of [
    'setStatus',
    'setMarketFailure',
    'setMcpStatus',
    'setSkillsStatus',
    'setImportStatus',
    'setFeedbackStatus',
    'reportUpdateDetachedFailure',
    'reportHarnessDetachedFailure',
  ]) {
    assert.match(rendererSource, new RegExp(`fireAndForget\\([\\s\\S]{0,300}${reporter}`), `${reporter} 必须接入 detached 错误边界`)
  }
})

test('Skill 文件在 renderer 读取前拒绝空文件和超过 20MB 的文件', async () => {
  const context = transpileHelpers(
    'const MAX_SKILL_IMPORT_BYTES',
    '\nasync function importFromFile(',
    { importSkillFileWithinLimit: 'importSkillFileWithinLimit' },
  )
  const importWithinLimit = context.importSkillFileWithinLimit

  for (const [size, expected] of [[0, /文件为空/], [20 * 1024 * 1024 + 1, /20MB/]]) {
    let reads = 0
    let imports = 0
    const attempt = await importWithinLimit(
      { size, arrayBuffer: async () => { reads += 1; return new ArrayBuffer(1) } },
      async () => { imports += 1; return { ok: true } },
    )
    assert.equal(attempt.ok, false)
    assert.match(attempt.error, expected)
    assert.equal(reads, 0, '非法文件不得调用 arrayBuffer')
    assert.equal(imports, 0, '非法文件不得调用 import IPC')
  }

  let reads = 0
  let imports = 0
  const valid = await importWithinLimit(
    { size: 1, arrayBuffer: async () => { reads += 1; return new ArrayBuffer(1) } },
    async () => { imports += 1; return { ok: true, result: { name: 'ok' } } },
  )
  assert.equal(valid.ok, true)
  assert.equal(reads, 1)
  assert.equal(imports, 1)

  const importStart = rendererSource.indexOf('async function importFromFile(')
  const importEnd = rendererSource.indexOf('\ndocument.getElementById(\'skill-import-url-btn\')', importStart)
  const importSource = rendererSource.slice(importStart, importEnd)
  assert.match(importSource, /skillImportFileSizeError\(file\.size\)[\s\S]*setImportStatus\(sizeError, 'error'\)[\s\S]*return/)
  assert.doesNotMatch(importSource, /file\.arrayBuffer\(/, 'UI handler 必须通过带上限的读取 helper')
})
