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
}

type ActiveOperation = {
  process: PluginOpHandle | null
  cancelRequested: boolean
}

const DEFAULT_OUTPUT_CAP = 64 * 1024
const DEFAULT_MAX_COMPLETED = 32

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

  constructor(private readonly options: PluginOpRunnerOptions) {
    this.outputCap = options.outputCap ?? DEFAULT_OUTPUT_CAP
    this.maxCompleted = options.maxCompleted ?? DEFAULT_MAX_COMPLETED
  }

  start(request: PluginOpStartRequest): PluginOpStarted {
    const token = this.options.nextToken()
    const operation: ActiveOperation = { process: null, cancelRequested: false }
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
    operation.cancelRequested = true
    operation.process?.cancel()
    return true
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
      if (operation.cancelRequested) process.cancel()
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
    const command = buildPluginCommand(request.profile, request.action, request.args)
    this.emitChunk(token, `dsh ${command.join(' ')}\n`)
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

  private emitChunk(token: string, text: string): void {
    try {
      this.options.onChunk(token, text)
    } catch {
      // UI 推送失败不能影响 dsh 进程的收尾与终态登记。
    }
  }

  private finish(token: string, done: PluginOpDone): void {
    if (!this.active.delete(token)) return
    this.completed.set(token, done)
    while (this.completed.size > this.maxCompleted) {
      const oldest = this.completed.keys().next().value
      if (oldest === undefined) break
      this.completed.delete(oldest)
    }
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
