// M1 单元测试：harness 核心纯函数（依赖 npm run build 后的 dist）
// 不依赖开发者机器上安装的 dsh / 真实 ~/.dsh（P2-12：验证门禁不得假绿/假红）
import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { EventEmitter, once } from 'node:events'
import { spawn } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(join(root, 'dist', 'core', 'harness.js')).href)
const { planDshSpawn } = await import(pathToFileURL(join(root, 'dist', 'core', 'dsh-spawn.js')).href)
const {
  fetchHttpOkWithin,
  findDsh,
  dshHome,
  listProfiles,
  parseHarnessUrl,
  repairDirectoryPickerRows,
  startHarness,
  stopTree,
  runtimePathEnv,
  prependRuntimePath,
  resolveDshExec,
  waitForHttp,
} = mod

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForFile(file, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) return
    await delay(20)
  }
  throw new Error(`等待文件超时：${file}`)
}

function forceCleanupProcessGroup(pgid, childPid) {
  if (process.platform !== 'win32' && pgid) {
    try {
      process.kill(-pgid, 'SIGKILL')
    } catch {
      /* 已清理 */
    }
  }
  if (childPid) {
    try {
      process.kill(childPid, 'SIGKILL')
    } catch {
      /* 已清理 */
    }
  }
}

async function spawnStopTreeFixture(dir, { leaderExits, markerDelayMs }) {
  const launcher = join(dir, 'launcher.mjs')
  const grandchild = join(dir, 'grandchild.mjs')
  const readyFile = join(dir, 'grandchild-ready')
  const marker = join(dir, 'survived')
  writeFileSync(
    grandchild,
    "import { writeFileSync } from 'node:fs'\n" +
      "process.on('SIGTERM', () => {})\n" +
      `writeFileSync(${JSON.stringify(readyFile)}, String(process.pid))\n` +
      `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'survived'), ${markerDelayMs})\n` +
      'setInterval(() => {}, 1_000)\n',
  )
  writeFileSync(
    launcher,
    "import { spawn } from 'node:child_process'\n" +
      `const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' })\n` +
      "console.log(`tree-ready ${process.pid} ${child.pid}`)\n" +
      (leaderExits ? 'process.exit(0)\n' : 'setInterval(() => {}, 1_000)\n'),
  )
  const proc = spawn(process.execPath, [launcher], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let rootPid = proc.pid
  let grandchildPid
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`进程组 fixture 未及时启动：${output}`)), 3_000)
      const onData = (chunk) => {
        output += String(chunk)
        const match = output.match(/tree-ready (\d+) (\d+)/)
        if (!match) return
        clearTimeout(timer)
        rootPid = Number(match[1])
        grandchildPid = Number(match[2])
        resolve()
      }
      proc.stdout.on('data', onData)
      proc.stderr.on('data', (chunk) => { output += String(chunk) })
      proc.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    await waitForFile(readyFile)
    return { proc, rootPid, grandchildPid, marker }
  } catch (error) {
    forceCleanupProcessGroup(rootPid, grandchildPid)
    await delay(50)
    throw error
  }
}

function fakeHarnessProcess() {
  const proc = new EventEmitter()
  proc.pid = 4242
  proc.exitCode = null
  proc.signalCode = null
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  return proc
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test('findDsh 优先 DSH_BIN，并总能解析到存在的可执行文件', () => {
  const bin = mkdtempSync(join(tmpdir(), 'dsh-bin-'))
  try {
    const fake = join(bin, 'dsh')
    writeFileSync(fake, '#!/bin/sh\nexit 0\n')
    chmodSync(fake, 0o755)
    const prevBin = process.env.DSH_BIN
    // Windows 无 PATH 键（是 Path），与 findDsh 内部逻辑保持一致
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
    const prevPath = process.env[pathKey]
    try {
      // DSH_BIN 优先
      process.env.DSH_BIN = fake
      assert.equal(findDsh(), fake, 'DSH_BIN 应优先')
      // 无 DSH_BIN 时（PATH 或硬编码候选）应解析到存在的 dsh
      delete process.env.DSH_BIN
      process.env[pathKey] = bin
      const found = findDsh()
      assert.ok(found && existsSync(found), `应解析到存在的 dsh，实际 ${found}`)
    } finally {
      if (prevBin === undefined) delete process.env.DSH_BIN
      else process.env.DSH_BIN = prevBin
      if (prevPath === undefined) delete process.env[pathKey]
      else process.env[pathKey] = prevPath
    }
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
})

test('dshHome 默认 ~/.dsh，可被 DSH_HOME 覆盖', () => {
  const prev = process.env.DSH_HOME
  try {
    assert.equal(dshHome(), join(homedir(), '.dsh'))
    const home = join(tmpdir(), 'dsh-home-test')
    process.env.DSH_HOME = home
    assert.equal(dshHome(), home)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})

test('listProfiles 发现 fixture profile 且解析 bundles，忽略无 package.json 目录', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  try {
    const web = join(home, 'profiles', 'web')
    mkdirSync(web, { recursive: true })
    writeFileSync(
      join(web, 'package.json'),
      JSON.stringify({ dependencies: { '@deepseek-ai/dsh-base': '0.1.0-rc.6' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }),
    )
    const fake = join(home, 'profiles', 'not-a-profile')
    mkdirSync(fake, { recursive: true })
    writeFileSync(join(fake, 'x.txt'), 'x')
    const profiles = listProfiles(home)
    assert.equal(profiles.length, 1, '缺 package.json / 无 bundles 的目录应被过滤')
    assert.equal(profiles[0].name, 'web')
    assert.equal(profiles[0].bundles[0], '@deepseek-ai/dsh-base')
    assert.ok(profiles[0].bundles.includes('@deepseek-ai/dsh-web-app'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('listProfiles 过滤畸形 bundle、trim 去重且不让坏 entry 破坏合法 profile', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-profile-normalize-'))
  const profile = join(home, 'profiles', 'web')
  const warnings = []
  try {
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({
      dsh: {
        profile: {
          bundles: [' valid-pkg ', { name: 'bad' }, 7, '', 'valid-pkg', '@scope/tool', '__proto__', 'constructor'],
        },
      },
    }))
    const profiles = listProfiles(home, { onWarning: (message) => warnings.push(message) })
    assert.equal(profiles.length, 1)
    assert.deepEqual(profiles[0].bundles, ['valid-pkg', '@scope/tool'])
    assert.ok(warnings.some((message) => /bundle\[1\]/.test(message)))
    assert.ok(warnings.some((message) => /bundle\[2\]/.test(message)))
    assert.ok(warnings.some((message) => /bundle\[6\]/.test(message)))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('listProfiles 对 package 顶层与 bundles 容器错误留下诊断并继续扫描其他 profile', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-profile-shape-'))
  const warnings = []
  try {
    for (const [name, value] of [
      ['array-top', []],
      ['null-top', null],
      ['bad-bundles', { dsh: { profile: { bundles: { plugin: true } } } }],
      ['valid', { dsh: { profile: { bundles: ['ok-plugin'] } } }],
    ]) {
      const dir = join(home, 'profiles', name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify(value))
    }
    const profiles = listProfiles(home, { onWarning: (message) => warnings.push(message) })
    assert.deepEqual(profiles.map((profile) => profile.name), ['valid'])
    assert.ok(warnings.some((message) => /array-top.*顶层必须是普通对象/.test(message)))
    assert.ok(warnings.some((message) => /null-top.*顶层必须是普通对象/.test(message)))
    assert.ok(warnings.some((message) => /bad-bundles.*bundles 必须是数组/.test(message)))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('parseHarnessUrl 解析 dsh web 输出', () => {
  assert.equal(parseHarnessUrl('dsh web: http://127.0.0.1:3080'), 'http://127.0.0.1:3080')
  assert.equal(parseHarnessUrl('[info] Listening on 127.0.0.1:45231'), 'http://127.0.0.1:45231')
  assert.equal(parseHarnessUrl('unrelated line'), null)
})

test('Windows 新旧 npm shim 都解析为 node + 独立 argv，元字符不进入 shell', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness cmd &^%-'))
  const node = 'C:\\Program Files\\Node & Runtime\\node.exe'
  const args = ['web', '--profile', 'space & name', '%PATH%', 'x^y|z']
  try {
    for (const [file, variable] of [['dsh.cmd', '%dp0%'], ['legacy dsh.bat', '%~dp0']]) {
      const shim = join(dir, file)
      const entry = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      mkdirSync(dirname(entry), { recursive: true })
      writeFileSync(entry, '// fixture')
      writeFileSync(shim, `@ECHO off\r\n"${variable}\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n`)
      assert.deepEqual(planDshSpawn(shim, undefined, args, {
        platform: 'win32',
        findNode: () => node,
      }), { executable: node, args: [entry, ...args] })
    }

    assert.deepEqual(
      planDshSpawn('C:\\runtime space\\dsh.js', 'C:\\runtime space\\node.exe', ['web'], { platform: 'win32' }),
      { executable: 'C:\\runtime space\\node.exe', args: ['C:\\runtime space\\dsh.js', 'web'] },
    )
    assert.deepEqual(planDshSpawn('/usr/local/bin/dsh', undefined, ['web'], { platform: 'linux' }), {
      executable: '/usr/local/bin/dsh',
      args: ['web'],
    })
    assert.deepEqual(planDshSpawn('C:\\tools\\dsh.exe', undefined, ['web'], { platform: 'win32' }), {
      executable: 'C:\\tools\\dsh.exe',
      args: ['web'],
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Windows shim 无法解析或找不到 node 时 Harness 拒绝且绝不 spawn', async () => {
  let spawnCalls = 0
  const spawnProcess = () => {
    spawnCalls += 1
    return fakeHarnessProcess()
  }
  await assert.rejects(startHarness({}, {
    platform: 'win32',
    resolveExec: () => ({ exec: 'C:\\unsafe path &\\dsh.cmd' }),
    spawnPlanDependencies: {
      readShim: () => '@echo off\r\ndsh.exe %*',
      pathExists: () => false,
      findNode: () => 'C:\\node.exe',
    },
    spawnProcess,
  }), /无法解析 Windows dsh shim/)
  assert.equal(spawnCalls, 0)

  await assert.rejects(startHarness({}, {
    platform: 'win32',
    resolveExec: () => ({ exec: 'C:\\unsafe path &\\dsh.cmd' }),
    spawnPlanDependencies: {
      readShim: () => '"%dp0%\\lib\\bin.js" %*',
      pathExists: (file) => file.endsWith(join('lib', 'bin.js')),
      findNode: () => null,
    },
    spawnProcess,
  }), /PATH 中没有可用的 node\.exe/)
  assert.equal(spawnCalls, 0)
})

test('Harness Windows shim 接线始终 shell:false 并保留独立 argv', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-safe-spawn-'))
  const shim = join(dir, 'dsh path &.cmd')
  const entry = join(dir, 'lib', 'bin.js')
  const node = 'C:\\Program Files\\node.exe'
  const proc = fakeHarnessProcess()
  let spawned
  try {
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, '// fixture')
    writeFileSync(shim, '"%~dp0\\lib\\bin.js" %*\r\n')
    const started = startHarness({ port: 4321 }, {
      platform: 'win32',
      resolveExec: () => ({ exec: shim }),
      spawnPlanDependencies: { findNode: () => node },
      spawnProcess: (command, args, options) => {
        spawned = { command, args, options }
        return proc
      },
      stopProcess: async () => {},
      waitForReady: async () => true,
    })
    proc.stdout.emit('data', Buffer.from('dsh web: http://127.0.0.1:4321\r\n'))
    assert.equal((await started).url, 'http://127.0.0.1:4321')
    assert.equal(spawned.command, node)
    assert.deepEqual(spawned.args, [entry, '--profile', 'web', '--no-open', '--port', '4321'])
    assert.equal(spawned.options.shell, false)
    assert.equal(spawned.options.detached, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('waitForHttp 越过旧 60s 边界后仍在 startHarness 总期限内继续探测', async () => {
  let now = 0
  const attempts = []
  const ready = await waitForHttp('http://127.0.0.1:3080', {
    deadline: 61_000,
    now: () => now,
    request: async (_url, timeoutMs) => {
      attempts.push({ at: now, timeoutMs })
      return now > 60_000
    },
    sleep: async (delayMs) => { now += delayMs },
    pollIntervalMs: 30_001,
    requestTimeoutMs: 2_000,
  })
  assert.equal(ready, true)
  assert.deepEqual(attempts.map(({ at }) => at), [0, 30_001, 60_002])
  assert.deepEqual(attempts.map(({ timeoutMs }) => timeoutMs), [2_000, 2_000, 998])
})

test('fetchHttpOkWithin 可确定地结束挂起请求，并收敛稍后到达的 reject', async () => {
  let fireTimeout
  let rejectFetch
  let requestSignal
  let cleared = false
  const result = fetchHttpOkWithin('http://127.0.0.1:3080', 2_000, {
    fetchFn: (_url, { signal }) => {
      requestSignal = signal
      return new Promise((_resolve, reject) => { rejectFetch = reject })
    },
    setTimer: (callback, delayMs) => {
      assert.equal(delayMs, 2_000)
      fireTimeout = callback
      return 1
    },
    clearTimer: () => { cleared = true },
  })
  await Promise.resolve()
  assert.equal(requestSignal?.aborted, false)
  fireTimeout()
  rejectFetch(new Error('late abort rejection'))
  assert.equal(await result, false)
  assert.equal(requestSignal.aborted, true)
  assert.equal(cleared, true)
})

test('fetchHttpOkWithin 取得状态后恰好取消一次响应 body，取消失败不改变结果', async () => {
  for (const expected of [true, false]) {
    let cancelCalls = 0
    const result = await fetchHttpOkWithin('http://127.0.0.1:3080', 2_000, {
      fetchFn: async () => ({
        ok: expected,
        body: {
          cancel: () => {
            cancelCalls += 1
            return Promise.reject(new Error('late body cancel failure'))
          },
        },
      }),
    })
    assert.equal(result, expected)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(cancelCalls, 1)
  }
})

test('waitForHttp 在启动流程结算时立即停止挂起探测', async () => {
  const controller = new AbortController()
  let requestStarted = false
  const result = waitForHttp('http://127.0.0.1:3080', {
    deadline: 90_000,
    now: () => 0,
    signal: controller.signal,
    request: async (_url, _timeoutMs, signal) => {
      requestStarted = true
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      return false
    },
    sleep: async () => assert.fail('取消后不应进入下一轮 delay'),
  })
  await Promise.resolve()
  assert.equal(requestStarted, true)
  controller.abort()
  assert.equal(await result, false)
})

test('startHarness fatal 只结算一次，并在进程树清理完成后才 reject', async () => {
  const proc = fakeHarnessProcess()
  const cleanup = deferred()
  let timeout
  let stopCalls = 0
  let pollingCalls = 0
  let rejected = false
  const result = startHarness({ readyTimeoutMs: 90_000 }, {
    resolveExec: () => ({ exec: '/fake/dsh' }),
    spawnProcess: () => proc,
    stopProcess: async () => {
      stopCalls += 1
      await cleanup.promise
    },
    waitForReady: async () => {
      pollingCalls += 1
      return true
    },
    now: () => 0,
    setTimer: (callback) => {
      timeout = callback
      return 1
    },
    clearTimer: () => {},
  })
  void result.catch(() => { rejected = true })

  // fatal 后同一个 data chunk 的 URL 不得再启动 polling；并发 timeout 也不得重复 stop/reject。
  proc.stderr.emit('data', Buffer.from('dsh: fatal load failure: broken profile\ndsh web: http://127.0.0.1:3080\n'))
  timeout()
  await Promise.resolve()
  assert.equal(stopCalls, 1)
  assert.equal(pollingCalls, 0)
  assert.equal(rejected, false, '清理未完成时不得允许下一代启动')

  cleanup.resolve()
  await assert.rejects(result, /dsh 启动失败：broken profile/)
  assert.equal(rejected, true)
})

test('startHarness 分流拼接跨 chunk URL，并正确解码跨字节 UTF-8 与 CRLF', async () => {
  const proc = fakeHarnessProcess()
  const logs = []
  const readyUrls = []
  const started = startHarness({
    onLog: (line) => logs.push(line),
    readyTimeoutMs: 90_000,
  }, {
    resolveExec: () => ({ exec: '/fake/dsh' }),
    spawnProcess: () => proc,
    stopProcess: async () => {},
    waitForReady: async (url) => {
      readyUrls.push(url)
      return true
    },
  })

  const greeting = Buffer.from('准备🚀\r\n')
  const rocket = Buffer.from('🚀')
  const rocketAt = greeting.indexOf(rocket)
  proc.stdout.emit('data', greeting.subarray(0, rocketAt + 1))
  proc.stdout.emit('data', greeting.subarray(rocketAt + 1))
  proc.stdout.emit('data', Buffer.from('dsh web: http://127.0.'))
  proc.stderr.emit('data', Buffer.from('0.1:9999\r\n'))
  proc.stdout.emit('data', Buffer.from('0.1:4567\r'))
  proc.stdout.emit('data', Buffer.from('\n'))

  assert.equal((await started).url, 'http://127.0.0.1:4567')
  assert.deepEqual(readyUrls, ['http://127.0.0.1:4567'])
  assert.deepEqual(logs, ['准备🚀', '0.1:9999', 'dsh web: http://127.0.0.1:4567'])
})

test('startHarness 跨 chunk fatal 会清理子进程且保留多字节诊断', async () => {
  const proc = fakeHarnessProcess()
  let stopCalls = 0
  const started = startHarness({ readyTimeoutMs: 90_000 }, {
    resolveExec: () => ({ exec: '/fake/dsh' }),
    spawnProcess: () => proc,
    stopProcess: async () => { stopCalls += 1 },
  })
  const fatal = Buffer.from('dsh: fatal load failure: 配置🚫损坏\r\n')
  const emojiAt = fatal.indexOf(Buffer.from('🚫'))
  proc.stderr.emit('data', fatal.subarray(0, 9))
  proc.stderr.emit('data', fatal.subarray(9, emojiAt + 2))
  proc.stderr.emit('data', fatal.subarray(emojiAt + 2))
  await assert.rejects(started, /dsh 启动失败：配置🚫损坏/)
  assert.equal(stopCalls, 1)
})

test('startHarness close 会 flush 无换行尾部并限制提前退出诊断长度', async () => {
  const proc = fakeHarnessProcess()
  let stopCalls = 0
  const started = startHarness({ readyTimeoutMs: 90_000 }, {
    resolveExec: () => ({ exec: '/fake/dsh' }),
    spawnProcess: () => proc,
    stopProcess: async () => { stopCalls += 1 },
  })
  proc.stdout.emit('data', Buffer.from(`${'x'.repeat(70_000)}最后诊断：端口被占用`))
  proc.emit('close', 7)
  await assert.rejects(started, (error) => {
    assert.match(error.message, /dsh web 提前退出（code=7）/)
    assert.match(error.message, /最后诊断：端口被占用/)
    assert.ok(error.message.length < 2_200, `错误诊断必须有界，实际 ${error.message.length}`)
    return true
  })
  assert.equal(stopCalls, 1)
})

test('startHarness 收敛 onSpawn/onLog 异常并停止已 spawn 进程', async () => {
  for (const callback of ['onSpawn', 'onLog']) {
    const proc = fakeHarnessProcess()
    let stopCalls = 0
    const opts = callback === 'onSpawn'
      ? { onSpawn: () => { throw new Error('spawn observer broke') } }
      : { onLog: () => { throw new Error('log observer broke') } }
    const started = startHarness(opts, {
      resolveExec: () => ({ exec: '/fake/dsh' }),
      spawnProcess: () => proc,
      stopProcess: async () => { stopCalls += 1 },
    })
    if (callback === 'onLog') proc.stdout.emit('data', Buffer.from('first line\n'))
    await assert.rejects(started, new RegExp(callback === 'onSpawn' ? 'spawn observer broke' : 'log observer broke'))
    assert.equal(stopCalls, 1, `${callback} 失败必须清理已 spawn 子进程`)
  }
})

test('startHarness 超时清理失败合并保留两个诊断', async () => {
  const proc = fakeHarnessProcess()
  let timeout
  const result = startHarness({ readyTimeoutMs: 90_000 }, {
    resolveExec: () => ({ exec: '/fake/dsh' }),
    spawnProcess: () => proc,
    stopProcess: async () => { throw new Error('kill denied') },
    now: () => 0,
    setTimer: (callback) => {
      timeout = callback
      return 1
    },
    clearTimer: () => {},
  })

  timeout()
  await assert.rejects(result, (error) => {
    assert.ok(error instanceof AggregateError)
    assert.match(error.message, /等待 dsh web 就绪超时/)
    assert.match(error.message, /Harness 进程树清理失败：kill denied/)
    assert.deepEqual(error.errors.map((item) => item.message), ['等待 dsh web 就绪超时', 'kill denied'])
    return true
  })
})

test('stopTree 在 leader 响应 SIGTERM 后仍强杀忽略信号的同组孙进程', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-stop-tree-leader-exits-'))
  const markerDelayMs = 2_600
  let fixture
  try {
    fixture = await spawnStopTreeFixture(dir, { leaderExits: false, markerDelayMs })
    const started = Date.now()
    await stopTree(fixture.proc)
    const elapsed = Date.now() - started

    assert.ok(elapsed >= 1_800, `孙进程存活时必须保留 SIGTERM 宽限期，实际 ${elapsed}ms`)
    assert.equal(fixture.proc.signalCode, 'SIGTERM', '测试前置：leader 应响应优雅 SIGTERM，而非等到 SIGKILL')
    await delay(Math.max(0, markerDelayMs + 200 - elapsed))
    assert.equal(existsSync(fixture.marker), false, '忽略 SIGTERM 的孙进程不得执行延迟 marker')
  } finally {
    forceCleanupProcessGroup(fixture?.rootPid, fixture?.grandchildPid)
    await delay(50)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stopTree 在 detached leader 已退出后仍清理原进程组孙进程', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-stop-tree-dead-leader-'))
  const markerDelayMs = 2_600
  let fixture
  try {
    fixture = await spawnStopTreeFixture(dir, { leaderExits: true, markerDelayMs })
    if (fixture.proc.exitCode === null && fixture.proc.signalCode === null) await once(fixture.proc, 'exit')
    assert.equal(fixture.proc.exitCode, 0, '测试前置：detached leader 必须已自行正常退出')

    const started = Date.now()
    await stopTree(fixture.proc)
    const elapsed = Date.now() - started

    assert.ok(elapsed >= 1_800, `已退出 leader 的原进程组仍应等待并强杀孙进程，实际 ${elapsed}ms`)
    await delay(Math.max(0, markerDelayMs + 200 - elapsed))
    assert.equal(existsSync(fixture.marker), false, 'leader 先退出后孙进程仍不得执行延迟 marker')
  } finally {
    forceCleanupProcessGroup(fixture?.rootPid, fixture?.grandchildPid)
    await delay(50)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('main 收敛 generation 失效分支的异步停止错误', () => {
  const main = readFileSync(join(root, 'src', 'main', 'main.ts'), 'utf8')
  const onSpawn = main.slice(main.indexOf('onSpawn: (proc) => {'), main.indexOf('startingProc = proc'))
  assert.match(onSpawn, /harnessCleanupRetries\.add\(proc\)/, '失效世代必须先保留确切 ChildProcess')
  assert.match(onSpawn, /void stopTree\(proc\)\.then\(/, '失效世代的 stopTree rejection 必须被捕获')
  assert.match(onSpawn, /harnessCleanupRetries\.delete\(proc\)/, '仅停止成功后才可释放重试句柄')
  assert.match(onSpawn, /清理已失效启动进程失败/, '清理失败必须留下可诊断日志')
})

test('Windows taskkill 非零与强杀后仍存活都会显式失败', () => {
  const source = readFileSync(join(root, 'src', 'core', 'harness.ts'), 'utf8')
  const taskkill = source.slice(source.indexOf('function taskkillTree'), source.indexOf('function processGroupExists'))
  const windowsStop = source.slice(source.indexOf("if (process.platform === 'win32')", source.indexOf('export async function stopTree')))
  assert.match(taskkill, /result\.error/, 'taskkill spawn 错误不得吞掉')
  assert.match(taskkill, /result\.status === 0/, '只有成功状态或已确认退出竞态才可视为成功')
  assert.match(taskkill, /throw new Error\(`taskkill/, '非零状态必须抛出可诊断错误')
  assert.match(windowsStop, /taskkillTree\(proc, true\)/, '优雅停止失败后仍须尝试 /F 强杀')
  assert.match(windowsStop, /taskkill \/F 返回成功，但进程树未/, '强杀返回后仍须验证 ChildProcess 退出')
})

test('prependRuntimePath 在 Windows 删除重复 casing 并保留原 Path', () => {
  assert.deepEqual(
    prependRuntimePath({ PATH: 'old' }, ['C:\\runtime'], 'win32'),
    { Path: 'C:\\runtime;old' },
  )
  assert.deepEqual(
    prependRuntimePath({ Path: 'old', PATH: 'stale', KEEP: 'yes' }, ['C:\\runtime'], 'win32'),
    { Path: 'C:\\runtime;old', KEEP: 'yes' },
  )
})

test('runtimePathEnv 在捆绑 runtime 存在时把 node/bin 与 .bin 加入 PATH，否则原样返回', () => {
  const exec = resolveDshExec()
  const env = runtimePathEnv()
  // Windows 的 PATH 键是 Path（大小写敏感，spread 副本不兼容大小写混用），随平台取键
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  assert.ok(env && typeof env[pathKey] === 'string', '应有 PATH')
  if (exec?.node) {
    assert.ok(env[pathKey].includes(dirname(exec.node)), `PATH 应包含捆绑 node/bin: ${env[pathKey]}`)
    assert.ok(env[pathKey].includes(join(root, 'resources', 'rt', 'node_modules', '.bin')), `PATH 应包含运行时 .bin: ${env[pathKey]}`)
  }
  // 不破坏原有 PATH 内容
  assert.ok(env[pathKey].includes(process.env[pathKey] ?? ''), '原 PATH 应保留')
})

test('repairDirectoryPickerRows 移除用户层重复 picker 并留下备份', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-picker-repair-'))
  try {
    const profile = join(home, 'profiles', 'web')
    mkdirSync(profile, { recursive: true })
    writeFileSync(
      join(profile, 'package.json'),
      JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } }),
    )
    const patch = `# keep this comment\n- insert:\n    - id: custom-picker\n      name: '@deepseek-ai/dsh-host-directory-picker-native'\n    - id: keep-me\n      name: some-plugin\n`
    const patchFile = join(profile, 'cordis.patch.yml')
    writeFileSync(patchFile, patch)
    const repairs = repairDirectoryPickerRows(home)
    assert.equal(repairs.length, 1)
    assert.match(readFileSync(patchFile, 'utf8'), /keep-me/)
    assert.doesNotMatch(readFileSync(patchFile, 'utf8'), /dsh-host-directory-picker-native/)
    assert.match(repairs[0], /cordis\.patch\.yml\.bak-/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('repairDirectoryPickerRows 不确认官方 bundle 或遇到显式覆盖时不改用户配置', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-picker-safe-'))
  try {
    const profile = join(home, 'profiles', 'web')
    mkdirSync(profile, { recursive: true })
    const patchFile = join(profile, 'cordis.patch.yml')
    const patch = `- insert:\n    - id: custom-picker\n      name: '@deepseek-ai/dsh-host-directory-picker-native'\n`
    writeFileSync(patchFile, patch)
    assert.deepEqual(repairDirectoryPickerRows(home), [])
    assert.match(readFileSync(patchFile, 'utf8'), /dsh-host-directory-picker-native/)

    writeFileSync(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } }))
    writeFileSync(patchFile, `- insert:\n    - id: directory-picker\n      disabled: true\n    - id: custom-picker\n      name: '@deepseek-ai/dsh-host-directory-picker-native'\n`)
    assert.deepEqual(repairDirectoryPickerRows(home), [])
    assert.match(readFileSync(patchFile, 'utf8'), /disabled: true/)
    assert.match(readFileSync(patchFile, 'utf8'), /dsh-host-directory-picker-native/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('runtimePathEnv(profile) 为缺失的直接 !!js process.env 引用补空字符串，不修改父环境', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-profile-env-'))
  const name = 'DESKTOP_HUB_TEST_MISSING_ENV'
  const fallbackName = 'DESKTOP_HUB_TEST_DEFAULT_EXPR'
  const previousHome = process.env.DSH_HOME
  const previousValue = process.env[name]
  const previousFallback = process.env[fallbackName]
  try {
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    writeFileSync(
      join(home, 'profiles', 'web', 'cordis.patch.yml'),
      `- insert:\n    - id: mcp-test\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        env:\n          TOKEN: !!js process.env.${name}\n          DEFAULTED: !!js process.env.${fallbackName} ?? 'fallback'\n`,
    )
    delete process.env[name]
    delete process.env[fallbackName]
    process.env.DSH_HOME = home
    writeFileSync(join(home, '.env'), `${name}=from-profile-file\n`)
    const fromEnvFile = runtimePathEnv('web')
    assert.equal(fromEnvFile[name], undefined, '不得用空字符串遮蔽 DSH_HOME/.env')
    assert.equal(fromEnvFile[fallbackName], undefined, '带 ?? 默认值的表达式不得被改写')
    rmSync(join(home, '.env'), { force: true })
    const env = runtimePathEnv('web')
    assert.equal(env[name], '', '子进程环境应把缺失引用补为空字符串')
    assert.equal(env[fallbackName], undefined, '带 ?? 默认值的表达式不得被改写')
    assert.equal(process.env[name], undefined, '父进程环境不得被修改')
  } finally {
    if (previousValue === undefined) delete process.env[name]
    else process.env[name] = previousValue
    if (previousFallback === undefined) delete process.env[fallbackName]
    else process.env[fallbackName] = previousFallback
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
