import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { classifyPluginRemoveResult, planPluginRemoveCommand, runPluginRemoveSmoke } = await import(
  pathToFileURL(join(root, 'scripts', 'smoke-plugin-remove.mjs')).href
)

function fakeOperation(done, { stop = async () => {}, cancel = () => {} } = {}) {
  return { stdout: new EventEmitter(), stderr: new EventEmitter(), done, stop, cancel }
}

test('Windows dsh.cmd smoke 命令解析为 node 独立 argv，路径与元字符不进入 shell', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smoke cmd & spaces-'))
  try {
    const shim = join(dir, 'dsh.cmd')
    const entry = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const node = 'C:\\Program Files\\nodejs\\node.exe'
    const args = ['plugin', '--profile', 'profile with spaces', 'remove', 'pkg&whoami|echo %PATH% ^x']
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, '// fixture')
    writeFileSync(shim, '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n')

    const plan = planPluginRemoveCommand({ exec: shim }, args, {
      platform: 'win32',
      findNode: () => node,
    })
    assert.deepEqual(plan, { executable: node, args: [entry, ...args] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('plugin remove smoke 在缺少 dsh 时严格失败', async () => {
  const errors = []
  const code = await runPluginRemoveSmoke({
    resolveExec: () => null,
    logger: { log: () => {}, error: (message) => errors.push(message) },
  })
  assert.equal(code, 1)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /^SMOKE FAIL:/)
  assert.match(errors[0], /真实插件移除断言未执行/)
  assert.doesNotMatch(errors[0], /SMOKE SKIP/)
})

test('异步插件终态明确区分信号、缺失状态与普通非零退出', () => {
  const signal = classifyPluginRemoveResult({ exitCode: null, signal: 'SIGKILL' })
  assert.equal(signal.kind, 'signal')
  assert.match(signal.message, /信号终止（signal=SIGKILL）/)

  const missing = classifyPluginRemoveResult({ exitCode: null, signal: null })
  assert.equal(missing.kind, 'missing-exit')
  assert.match(missing.message, /未返回退出状态或信号/)

  const nonzero = classifyPluginRemoveResult({ exitCode: 7, signal: null })
  assert.equal(nonzero.kind, 'nonzero')
  assert.match(nonzero.message, /非零退出（exit=7）/)
  assert.match(nonzero.message, /无 stdout\/stderr 输出/)

  assert.deepEqual(
    classifyPluginRemoveResult({ exitCode: 0, signal: null }),
    { ok: true, kind: 'success', message: '' },
  )
})

test('plugin remove smoke 始终使用并清理临时 DSH_HOME', async () => {
  let observedHome = null
  const code = await runPluginRemoveSmoke({
    resolveExec: () => ({ exec: '/fake/dsh' }),
    runOperation: (options) => {
      observedHome = options.env.DSH_HOME
      assert.equal(options.cwd, observedHome)
      const packageFile = join(observedHome, 'profiles', 'remove-test', 'package.json')
      const pkg = JSON.parse(readFileSync(packageFile, 'utf8'))
      delete pkg.dependencies['dsh-worktree']
      writeFileSync(packageFile, JSON.stringify(pkg))
      return fakeOperation(Promise.resolve({ exitCode: 0, signal: null }))
    },
    logger: { log: () => {}, error: assert.fail },
  })
  assert.equal(code, 0)
  assert.ok(observedHome)
  assert.equal(existsSync(observedHome), false, '冒烟结束后必须删除临时 DSH_HOME')

  let failedHome = null
  const errors = []
  const failureCode = await runPluginRemoveSmoke({
    resolveExec: () => ({ exec: '/missing/dsh' }),
    runOperation: (options) => {
      failedHome = options.env.DSH_HOME
      return fakeOperation(Promise.resolve({ exitCode: 7, signal: null }))
    },
    logger: { log: () => {}, error: (message) => errors.push(message) },
  })
  assert.equal(failureCode, 1)
  assert.match(errors[0], /^SMOKE FAIL: dsh plugin remove 非零退出/)
  assert.equal(existsSync(failedHome), false, '操作失败后也必须删除临时 DSH_HOME')
})

test('plugin remove smoke 超时后先等待整树 stop，再清理临时目录', async () => {
  let observedHome
  let stopped = false
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  const errors = []
  const code = await runPluginRemoveSmoke({
    resolveExec: () => ({ exec: '/fake/dsh' }),
    timeoutMs: 10,
    runOperation: (options) => {
      observedHome = options.cwd
      return fakeOperation(done, {
        stop: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          stopped = true
          resolveDone({ exitCode: null, signal: 'SIGKILL' })
        },
      })
    },
    removeTemp: (path) => {
      assert.equal(stopped, true, '确认 stopTree 完成前不得删除 profile')
      rmSync(path, { recursive: true, force: true })
    },
    logger: { log: () => {}, error: (message) => errors.push(message) },
  })
  assert.equal(code, 1)
  assert.match(errors[0], /超时（10ms）；进程树已停止/)
  assert.equal(existsSync(observedHome), false)
})

test('超时 stop 失败时不假装已清理，并保留主诊断与临时目录', async () => {
  let observedHome
  let cleanupCalls = 0
  const errors = []
  const code = await runPluginRemoveSmoke({
    resolveExec: () => ({ exec: '/fake/dsh' }),
    timeoutMs: 10,
    runOperation: (options) => {
      observedHome = options.cwd
      return fakeOperation(new Promise(() => {}), {
        stop: async () => { throw new Error('taskkill denied') },
      })
    },
    removeTemp: () => { cleanupCalls += 1 },
    logger: { log: () => {}, error: (message) => errors.push(message) },
  })
  try {
    assert.equal(code, 1)
    assert.equal(cleanupCalls, 0)
    assert.equal(existsSync(observedHome), true)
    assert.match(errors[0], /超时（10ms），且进程树停止失败：taskkill denied/)
    assert.match(errors[0], /临时 DSH_HOME 已保留/)
  } finally {
    rmSync(observedHome, { recursive: true, force: true })
  }
})

test('临时目录清理异常与主失败联合报告，不覆盖非零退出诊断', async () => {
  let observedHome
  const errors = []
  const code = await runPluginRemoveSmoke({
    resolveExec: () => ({ exec: '/fake/dsh' }),
    runOperation: (options) => {
      observedHome = options.cwd
      return fakeOperation(Promise.resolve({ exitCode: 9, signal: null }))
    },
    removeTemp: () => { throw new Error('rm denied') },
    logger: { log: () => {}, error: (message) => errors.push(message) },
  })
  try {
    assert.equal(code, 1)
    assert.match(errors[0], /非零退出（exit=9）/)
    assert.match(errors[0], /临时 DSH_HOME 清理失败.*rm denied/)
  } finally {
    rmSync(observedHome, { recursive: true, force: true })
  }
})
