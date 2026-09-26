// 插件移除冒烟：只在临时 DSH_HOME/profile 中执行真实 dsh plugin remove，不触碰用户 profile。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { resolveDshExec } from '../dist/core/harness.js'
import { planPluginSpawn, runPluginOp } from '../dist/core/plugins.js'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_DIAGNOSTIC_OUTPUT = 4_000

function errorDetail(error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  const message = error instanceof Error ? error.message : String(error)
  return [code, message].filter(Boolean).join(': ') || '无错误详情'
}

export function planPluginRemoveCommand(exec, args, dependencies) {
  return planPluginSpawn(exec.exec, exec.node, args, dependencies)
}

/** 纯终态判定：进程启动/超时错误由异步 runner 单独保留诊断。 */
export function classifyPluginRemoveResult(result, output = '') {
  const diagnostic = output.trim() ? output.trim().slice(-MAX_DIAGNOSTIC_OUTPUT) : '（无 stdout/stderr 输出）'
  if (result.exitCode === null) {
    if (result.signal) {
      return {
        ok: false,
        kind: 'signal',
        message: `dsh plugin remove 被信号终止（signal=${result.signal}）\n${diagnostic}`,
      }
    }
    return {
      ok: false,
      kind: 'missing-exit',
      message: `dsh plugin remove 未返回退出状态或信号\n${diagnostic}`,
    }
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      kind: 'nonzero',
      message: `dsh plugin remove 非零退出（exit=${result.exitCode}）\n${diagnostic}`,
    }
  }
  return { ok: true, kind: 'success', message: '' }
}

function appendOutput(value, chunk) {
  return (value + String(chunk)).slice(-MAX_DIAGNOSTIC_OUTPUT)
}

async function runPluginRemoveWithTimeout(operation, timeoutMs) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ type: 'timeout' }), timeoutMs)
  })
  const terminal = operation.done.then(
    (result) => ({ type: 'done', result }),
    (error) => ({ type: 'done-error', error }),
  )
  const outcome = await Promise.race([terminal, timeout])
  clearTimeout(timer)
  if (outcome.type !== 'timeout') return { outcome, safeToClean: true }

  if (typeof operation.stop !== 'function') {
    operation.cancel()
    return {
      outcome: { type: 'stop-error', error: new Error('插件操作 handle 未提供可等待的整树 stop()') },
      safeToClean: false,
    }
  }
  try {
    await operation.stop()
  } catch (error) {
    return { outcome: { type: 'stop-error', error }, safeToClean: false }
  }
  // stopTree 已确认整棵树退出；done 理应紧随 close 结算，再给事件循环一个有界窗口。
  let terminalTimer
  const afterStop = await Promise.race([
    terminal,
    new Promise((resolve) => {
      terminalTimer = setTimeout(() => resolve({ type: 'terminal-timeout' }), 1_000)
    }),
  ])
  clearTimeout(terminalTimer)
  return { outcome: { type: 'timeout-stopped', terminal: afterStop }, safeToClean: true }
}

export async function runPluginRemoveSmoke({
  resolveExec = resolveDshExec,
  runOperation = runPluginOp,
  removeTemp = (path) => rmSync(path, { recursive: true, force: true }),
  logger = console,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  let exec
  try {
    exec = resolveExec()
  } catch (error) {
    logger.error(`SMOKE FAIL: dsh 运行时解析失败：${errorDetail(error)}`)
    return 1
  }
  if (!exec) {
    logger.error('SMOKE FAIL: 未找到 dsh 运行时，真实插件移除断言未执行')
    return 1
  }

  let temp = null
  let safeToClean = true
  let failure = null
  let output = ''
  try {
    temp = mkdtempSync(join(tmpdir(), 'dsh-plugin-remove-smoke-'))
    const profileDir = join(temp, 'profiles', 'remove-test')
    const packageFile = join(profileDir, 'package.json')
    const packageJson = {
      name: 'dsh-plugin-remove-smoke',
      private: true,
      dependencies: { 'dsh-worktree': 'github:FlashingChen/dsh-worktree' },
    }
    // dsh plugin 只要求 profile package.json；pnpm 会在临时目录中完成 remove，不需要复制真实 node_modules。
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(packageFile, JSON.stringify(packageJson, null, 2))
    const operation = runOperation({
      dsh: exec.exec,
      node: exec.node,
      profile: 'remove-test',
      action: 'remove',
      args: ['dsh-worktree'],
      cwd: temp,
      env: { ...process.env, DSH_HOME: temp },
    })
    operation.stdout.on('data', (chunk) => { output = appendOutput(output, chunk) })
    operation.stderr.on('data', (chunk) => { output = appendOutput(output, chunk) })
    const result = await runPluginRemoveWithTimeout(operation, timeoutMs)
    safeToClean = result.safeToClean
    switch (result.outcome.type) {
      case 'done': {
        const verdict = classifyPluginRemoveResult(result.outcome.result, output)
        if (!verdict.ok) failure = verdict.message
        break
      }
      case 'done-error':
        failure = `dsh plugin remove 未返回终态：${errorDetail(result.outcome.error)}\n${output || '（无 stdout/stderr 输出）'}`
        break
      case 'stop-error':
        failure = `dsh plugin remove 超时（${timeoutMs}ms），且进程树停止失败：${errorDetail(result.outcome.error)}\n${output || '（无 stdout/stderr 输出）'}`
        break
      case 'timeout-stopped':
        failure = result.outcome.terminal.type === 'done-error'
          ? `dsh plugin remove 超时（${timeoutMs}ms）；进程树已停止，但终态失败：${errorDetail(result.outcome.terminal.error)}`
          : result.outcome.terminal.type === 'terminal-timeout'
            ? `dsh plugin remove 超时（${timeoutMs}ms）；进程树已停止，但 1000ms 内未登记终态`
            : `dsh plugin remove 超时（${timeoutMs}ms）；进程树已停止`
        if (output) failure += `\n${output}`
        break
    }
    if (!failure) {
      const after = JSON.parse(readFileSync(packageFile, 'utf8'))
      if (after.dependencies?.['dsh-worktree'] || after.devDependencies?.['dsh-worktree']) {
        failure = 'remove 命令退出成功但 package.json 仍保留 dsh-worktree'
      }
    }
  } catch (error) {
    failure = `插件移除冒烟执行异常：${errorDetail(error)}`
  } finally {
    if (temp && safeToClean) {
      try {
        removeTemp(temp)
      } catch (cleanupError) {
        const cleanup = `临时 DSH_HOME 清理失败（${temp}）：${errorDetail(cleanupError)}`
        failure = failure ? `${failure}；${cleanup}` : cleanup
      }
    } else if (temp) {
      failure = `${failure ?? '插件进程树状态未知'}；为避免与仍存活的子进程竞争，临时 DSH_HOME 已保留：${temp}`
    }
  }
  if (failure) {
    logger.error(`SMOKE FAIL: ${failure}`)
    return 1
  }
  logger.log('SMOKE OK: 真实 dsh plugin remove 在临时 profile 中通过')
  return 0
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await runPluginRemoveSmoke()
}
