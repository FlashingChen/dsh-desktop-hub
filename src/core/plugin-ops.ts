// 插件操作生命周期：把「启动」与「完成」拆成两个明确阶段。
// 主进程用它承接 dsh 子进程，渲染进程先拿 token，再通过事件接收终态；
// 这样完成得很快的操作也不会在 renderer 建立 token 前丢失终态。
import { buildPluginCommand, type PluginOpHandle } from './plugins.js'
import type { PluginOpAction, PluginOpDone, PluginOpStarted, PluginOpStatus } from './ipc.js'

export type PluginOpSchedule = <T>(task: () => Promise<T>) => Promise<T>

export interface PluginOpStartRequest {
  profile: string
  action: PluginOpAction
  args: string[]
  run: () => PluginOpHandle
  /** dsh 成功后执行的 profile patch 清理；失败时不会调用。 */
  finalize?: () => void
}

export interface PluginOpRunnerOptions {
  nextToken: () => string
  schedule: PluginOpSchedule
  onChunk: (token: string, text: string) => void
  onDone: (done: PluginOpDone) => void
  onFinalizeError?: (message: string) => void
  outputCap?: number
  maxCompleted?: number
  shutdownTimeoutMs?: number
}

type ActiveOperation = {
  process: PluginOpHandle | null
  cancelRequested: boolean
  cancelSucceeded: boolean
  completion: Promise<void>
  resolveCompletion: () => void
  cancelPromise: Promise<void> | null
}

const DEFAULT_OUTPUT_CAP = 64 * 1024
const DEFAULT_MAX_COMPLETED = 32
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 6_000
const DISPLAY_TOKEN_MAX = 240
const DISPLAY_COMMAND_MAX = 512

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cappedDisplayToken(value: string): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return sanitized.length > DISPLAY_TOKEN_MAX ? `${sanitized.slice(0, DISPLAY_TOKEN_MAX - 1)}…` : sanitized
}

function redactPluginSpecForDisplay(value: string): string {
  const sanitized = cappedDisplayToken(value)
  try {
    const parsed = new URL(sanitized)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    if (/(?:access[_-]?token|auth|credential|password|secret|api[_-]?key)/i.test(parsed.hash)) {
      parsed.hash = '#<redacted>'
    }
    return cappedDisplayToken(parsed.toString())
  } catch {
    const withoutCredentials = sanitized.replace(
      /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]+@/,
      '$1<redacted>@',
    )
    const query = withoutCredentials.indexOf('?')
    return cappedDisplayToken(query === -1 ? withoutCredentials : `${withoutCredentials.slice(0, query)}?<redacted>`)
  }
}

/** 仅供 UI 展示；真实 spawn argv 不变，add spec 的 credentials/query 不进入输出。 */
export function formatPluginCommandForDisplay(
  profile: string,
  action: PluginOpAction,
  args: readonly string[],
): string {
  const command = buildPluginCommand(profile, action, [...args])
  const displayed = command.map((value, index) => {
    const isPluginPositional = index === command.length - 1 && args.length === 1
    return isPluginPositional && action === 'add' ? redactPluginSpecForDisplay(value) : cappedDisplayToken(value)
  })
  const line = `dsh ${displayed.join(' ')}`
  return line.length > DISPLAY_COMMAND_MAX ? `${line.slice(0, DISPLAY_COMMAND_MAX - 1)}…` : line
}

/**
 * 管理插件操作的异步生命周期。
 *
 * start() 只负责登记并排队，立即返回 token；真正的 dsh 进程及终态由后台
 * task 完成。completed 保留最近的终态，使 renderer 丢失 push 事件时可以
 * 通过 status(token) 重新取得结果，而不是永久停留在 running。
 */
export class PluginOpRunner {
  private readonly active = new Map<string, ActiveOperation>()
  private readonly completed = new Map<string, PluginOpDone>()
  private readonly outputCap: number
  private readonly maxCompleted: number
  private readonly shutdownTimeoutMs: number
  private shuttingDown = false
  private shutdownPromise: Promise<void> | null = null

  constructor(private readonly options: PluginOpRunnerOptions) {
    this.outputCap = options.outputCap ?? DEFAULT_OUTPUT_CAP
    this.maxCompleted = options.maxCompleted ?? DEFAULT_MAX_COMPLETED
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  }

  start(request: PluginOpStartRequest): PluginOpStarted {
    if (this.shuttingDown) return { ok: false, error: '应用正在退出，无法启动新的插件操作' }
    const token = this.options.nextToken()
    const { promise: completion, resolve: resolveCompletion } = Promise.withResolvers<void>()
    const operation: ActiveOperation = {
      process: null,
      cancelRequested: false,
      cancelSucceeded: false,
      completion,
      resolveCompletion,
      cancelPromise: null,
    }
    this.active.set(token, operation)

    try {
      const scheduled = this.options.schedule(() => this.execute(token, operation, request))
      void scheduled.catch((error: unknown) => {
        this.finish(token, {
          token,
          exitCode: 1,
          signal: null,
          output: `插件操作执行失败：${errorMessage(error)}\n`,
        })
      })
    } catch (error) {
      this.finish(token, {
        token,
        exitCode: 1,
        signal: null,
        output: `插件操作排队失败：${errorMessage(error)}\n`,
      })
    }

    return { ok: true, token }
  }

  cancel(token: string): boolean {
    const operation = this.active.get(token)
    if (!operation) return false
    void this.requestCancel(token, operation).catch(() => {
      // 普通 UI cancel 没有异步返回通道；错误已作为 output chunk 留痕。
      // shutdown 会复用/重试同一 ChildProcess，并把失败显式 reject 给主进程。
    })
    return true
  }

  hasActiveOperations(): boolean {
    return this.active.size > 0
  }

  isShuttingDown(): boolean {
    return this.shuttingDown
  }

  /** 拒绝新操作、取消全部已登记操作，并等待每个 token 写入确定终态。 */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shuttingDown = true
    const operations = [...this.active.entries()]
    if (operations.length === 0) {
      this.shutdownPromise = Promise.resolve()
      return this.shutdownPromise
    }

    const cancelErrors: unknown[] = []
    const recordCancelError = (error: unknown): void => {
      if (error instanceof AggregateError) cancelErrors.push(...error.errors)
      else cancelErrors.push(error)
    }
    const cancellations = operations.map(async ([token, operation]) => {
      try {
        await this.requestCancel(token, operation)
      } catch (firstError) {
        // stopTree 已绑定原 ChildProcess，不存在 PID 延时复用风险。退出阶段再重试
        // 一次可覆盖暂态 taskkill/权限竞态；两次都失败才交给有界 shutdown 上抛。
        if (this.active.get(token) !== operation) {
          recordCancelError(firstError)
          return
        }
        try {
          await this.requestCancel(token, operation)
        } catch (retryError) {
          recordCancelError(firstError)
          recordCancelError(retryError)
        }
      }
    })
    const drain = Promise.all([
      Promise.all(operations.map(([, operation]) => operation.completion)),
      Promise.all(cancellations),
    ]).then(() => {
      if (cancelErrors.length > 0) throw new AggregateError(cancelErrors, '插件进程树停止失败')
    })
    this.shutdownPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const activeTokens = operations.map(([token]) => token).filter((token) => this.active.has(token))
        const timeout = new Error(
          `等待插件操作终态超时（${this.shutdownTimeoutMs}ms；仍在运行：${activeTokens.join(', ') || '未知'}）`,
        )
        reject(cancelErrors.length > 0
          ? new AggregateError([...cancelErrors, timeout], '插件操作退出收口失败')
          : timeout)
      }, this.shutdownTimeoutMs)
      void drain.then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
    return this.shutdownPromise
  }

  status(token: string): PluginOpStatus {
    const done = this.completed.get(token)
    if (done) return { state: 'done', done }
    if (this.active.has(token)) return { state: 'running' }
    return { state: 'unknown' }
  }

  private async execute(token: string, operation: ActiveOperation, request: PluginOpStartRequest): Promise<void> {
    if (operation.cancelRequested) {
      this.finish(token, {
        token,
        exitCode: null,
        signal: 'SIGTERM',
        output: '插件操作已取消（尚未启动）\n',
      })
      return
    }

    let process: PluginOpHandle
    try {
      process = request.run()
      operation.process = process
      if (operation.cancelRequested) {
        void this.requestCancel(token, operation).catch(() => {
          // execute 仍继续监听 process.done；停止失败不能伪造启动失败终态。
        })
      }
    } catch (error) {
      this.finish(token, {
        token,
        exitCode: 1,
        signal: null,
        output: `插件操作启动失败：${errorMessage(error)}\n`,
      })
      return
    }

    let output = ''
    this.emitChunk(token, `${formatPluginCommandForDisplay(request.profile, request.action, request.args)}\n`)
    const onChunk = (chunk: unknown): void => {
      const text = String(chunk)
      output = this.appendCapped(output, text)
      this.emitChunk(token, text)
    }
    for (const stream of [process.stdout, process.stderr]) stream.on('data', onChunk)

    let result: Awaited<PluginOpHandle['done']>
    try {
      result = await process.done
    } catch (error) {
      this.finish(token, {
        token,
        exitCode: 1,
        signal: null,
        output: this.appendCapped(output, `\n插件操作未返回退出状态：${errorMessage(error)}\n`),
      })
      return
    }

    let exitCode = result.exitCode
    let finalOutput = output
    if (result.exitCode === 0 && request.finalize) {
      try {
        request.finalize()
      } catch (error) {
        const message = errorMessage(error)
        try {
          this.options.onFinalizeError?.(message)
        } catch {
          // 记录日志失败也不能阻止终态广播。
        }
        exitCode = 1
        const prefix = request.action === 'remove' ? '插件移除后的 patch 激活行清理失败' : '插件操作后的 patch 清理失败'
        finalOutput = this.appendCapped(output, `\n${prefix}：${message}\n`)
      }
    }

    this.finish(token, {
      token,
      exitCode,
      signal: result.signal ?? null,
      output: finalOutput,
    })
  }

  private requestCancel(token: string, operation: ActiveOperation): Promise<void> {
    operation.cancelRequested = true
    if (!operation.process) {
      this.finish(token, {
        token,
        exitCode: null,
        signal: 'SIGTERM',
        output: '插件操作已取消（尚未启动）\n',
      })
      return Promise.resolve()
    }
    if (operation.cancelSucceeded) return Promise.resolve()
    if (operation.cancelPromise) return operation.cancelPromise
    let result: void | Promise<void>
    try {
      result = operation.process.stop?.() ?? operation.process.cancel()
    } catch (error) {
      this.emitChunk(token, `插件操作取消失败：${errorMessage(error)}\n`)
      return Promise.reject(error)
    }
    const pending = Promise.resolve(result)
      .then(() => {
        operation.cancelSucceeded = true
      })
      .catch((error: unknown) => {
        this.emitChunk(token, `插件操作取消失败：${errorMessage(error)}\n`)
        throw error
      })
      .finally(() => {
        if (operation.cancelPromise === pending) operation.cancelPromise = null
      })
    operation.cancelPromise = pending
    return pending
  }

  private emitChunk(token: string, text: string): void {
    try {
      this.options.onChunk(token, text)
    } catch {
      // UI 推送失败不能影响 dsh 进程的收尾与终态登记。
    }
  }

  private finish(token: string, done: PluginOpDone): void {
    const operation = this.active.get(token)
    if (!operation) return
    this.active.delete(token)
    this.completed.set(token, done)
    while (this.completed.size > this.maxCompleted) {
      const oldest = this.completed.keys().next().value
      if (oldest === undefined) break
      this.completed.delete(oldest)
    }
    operation.resolveCompletion()
    try {
      this.options.onDone(done)
    } catch {
      // 终态已保存在 completed；push 回调异常时仍可由 status(token) 查询。
    }
  }

  private appendCapped(value: string, chunk: string): string {
    const next = value + chunk
    return next.length > this.outputCap ? next.slice(next.length - this.outputCap) : next
  }
}
