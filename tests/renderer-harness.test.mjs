import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const renderer = readFileSync(new URL('../src/renderer/renderer.ts', import.meta.url), 'utf8')
const harnessFunctions = renderer.slice(
  renderer.indexOf('function reportHarnessFailure'),
  renderer.indexOf('async function restartHarnessForPluginChange'),
)

function loadHarnessFunctions(harness, { statusThrows = false } = {}) {
  const statuses = []
  const frame = { src: 'about:blank' }
  const diagnostics = []
  const context = vm.createContext({
    api: { harness },
    console: { error: (message) => diagnostics.push(String(message)) },
    document: {
      getElementById(id) {
        return id === 'harness-frame' ? frame : null
      },
    },
    errorText(error) {
      return error instanceof Error ? error.message : String(error)
    },
    setHarnessStatusText(status) {
      if (statusThrows) throw new Error('document was destroyed')
      statuses.push({ ...status })
    },
  })
  const compiled = ts.transpileModule(harnessFunctions, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const functions = vm.runInContext(
    `${compiled}\n({ mountHarness, restartHarness })`,
    context,
  )
  return { ...functions, diagnostics, frame, statuses }
}

test('mountHarness 将 IPC rejection 收口为可见的 exited 状态', async () => {
  const fixture = loadHarnessFunctions({
    url: async () => {
      throw new Error('bridge disconnected')
    },
  })

  await assert.doesNotReject(fixture.mountHarness())

  assert.deepEqual(fixture.statuses[0], { state: 'starting' })
  assert.equal(fixture.statuses[1].state, 'exited')
  assert.equal(fixture.statuses[1].code, -1)
  assert.match(fixture.statuses[1].error, /读取 Harness 地址失败.*bridge disconnected/)
  assert.match(fixture.diagnostics[0], /读取 Harness 地址失败.*bridge disconnected/)
  assert.equal(fixture.frame.src, 'about:blank')
})

test('restartHarness 将 IPC rejection 收口为 exited 并返回 false', async () => {
  const fixture = loadHarnessFunctions({
    restart: async () => {
      throw new Error('window was destroyed')
    },
  })

  assert.equal(await fixture.restartHarness(), false)

  assert.deepEqual(fixture.statuses[0], { state: 'restarting' })
  assert.equal(fixture.statuses[1].state, 'exited')
  assert.equal(fixture.statuses[1].code, -1)
  assert.match(fixture.statuses[1].error, /重启失败.*window was destroyed/)
  assert.match(fixture.diagnostics[0], /重启失败.*window was destroyed/)
})

test('restartHarness 保留结构化失败和正常成功语义', async () => {
  const failed = loadHarnessFunctions({ restart: async () => ({ ok: false, error: 'daemon refused' }) })
  assert.equal(await failed.restartHarness(), false)
  assert.deepEqual(failed.statuses.at(-1), { state: 'exited', code: -1, error: '重启失败: daemon refused' })

  const succeeded = loadHarnessFunctions({ restart: async () => ({ ok: true, url: 'http://127.0.0.1:4567' }) })
  assert.equal(await succeeded.restartHarness(), true)
  assert.equal(succeeded.frame.src, 'http://127.0.0.1:4567')
  assert.deepEqual(succeeded.statuses.at(-1), { state: 'ready', url: 'http://127.0.0.1:4567' })
})

test('renderer teardown 期间状态 DOM 不可用也不会让异步调用 rejection', async () => {
  const mount = loadHarnessFunctions({ url: async () => 'http://127.0.0.1:4567' }, { statusThrows: true })
  await assert.doesNotReject(mount.mountHarness())
  assert.match(mount.diagnostics[0], /读取 Harness 地址失败.*document was destroyed/)

  const restart = loadHarnessFunctions({ restart: async () => ({ ok: true }) }, { statusThrows: true })
  assert.equal(await restart.restartHarness(), false)
  assert.match(restart.diagnostics[0], /重启失败.*document was destroyed/)
})
