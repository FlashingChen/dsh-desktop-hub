// 主进程运行日志：始终落盘到 ~/.dsh-desktop-hub/logs/main-<ts>.log
// 目的：Windows 真机 / 无 Node 机器上任何启动/连接问题，都可通过日志定位，
// 不再依赖控制台（Electron 打包后主进程 console 默认无处可看）。
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

let logPath: string | null = null

/** 在用户目录初始化日志（幂等），返回日志文件路径 */
export function initLog(): string {
  if (logPath) return logPath
  const dir = join(homedir(), '.dsh-desktop-hub', 'logs')
  mkdirSync(dir, { recursive: true })
  logPath = join(dir, `main-${Date.now()}.log`)
  log(`==== DSH Desktop Hub 启动（pid=${process.pid}, platform=${process.platform}, arch=${process.arch}, electron=${process.versions.electron ?? '?'}, node=${process.versions.node ?? '?'}）====`)
  return logPath
}

export function logPathOf(): string | null {
  return logPath
}

/** 追加一行带时间戳的日志（同步写；主进程低频事件，量级安全） */
export function log(message: string): void {
  const line = `${new Date().toISOString()}  ${message}`
  if (logPath) {
    try {
      appendFileSync(logPath, line + '\n')
    } catch {
      /* 日志目录不可写时静默（不阻塞启动） */
    }
  }
  console.log(line)
}