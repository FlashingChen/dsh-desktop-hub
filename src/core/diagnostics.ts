/**
 * Low-sensitivity diagnostics shared by feedback UI, clipboard export and the
 * feedback service.  Keep this type deliberately closed: adding a field
 * here is a privacy decision, not just a formatting change.
 *
 * v1.1（Issue #35）：新增 `harnessStartupMs`（上次 Harness 启动耗时，纯数字）与
 * `updateState`（应用内更新状态枚举）。两者均为粗粒度、非敏感量，用于定位
 * 「启动要两分钟」「自动更新坏了」类反馈，不引入任何路径/主机/网络标识。
 */

export const DIAGNOSTIC_FORMAT_VERSION = 1 as const

export type DiagnosticHarnessState = 'starting' | 'ready' | 'exited' | 'restarting' | 'unknown'

export interface DiagnosticSnapshot {
  formatVersion: typeof DIAGNOSTIC_FORMAT_VERSION
  generatedAt: string
  appVersion: string
  packaged: boolean
  profile: string
  platform: string
  osRelease: string
  arch: string
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
  dshVersion: string | null
  pnpmVersion: string | null
  harnessState: DiagnosticHarnessState
  harnessExitCode: number | null
  /** 上次成功就绪的 Harness 启动耗时（ms）；未知/尚未启动过为 null */
  harnessStartupMs?: number | null
  /** 应用内更新状态枚举（idle/checking/available/…）；不包含错误详情文本 */
  updateState?: string | null
  /** 凭据文件格式（flat/versioned/missing/unknown），用于 Issue #38 排障 */
  credentialsFormat?: string | null
}

function oneLine(value: string): string {
  return value.replace(/[\r\n|]/g, (char) => char === '|' ? '\\|' : ' ')
}

function versionOrUnknown(value: string | null): string {
  return value && value.trim() ? value.trim() : 'unknown'
}

function exitCodeOrDash(value: number | null): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—'
}

/** 启动耗时以秒呈现（用户反馈的口径），缺失/非法值为 — */
function durationOrDash(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
  return `${(value / 1000).toFixed(1)} s`
}

/**
 * Format a whitelist-only snapshot.  No arbitrary object is accepted here, so
 * user paths, environment variables, credentials and raw logs cannot be
 * accidentally serialized into a diagnostic block.
 */
export function formatDiagnostics(snapshot: DiagnosticSnapshot): string {
  const rows: Array<[string, string]> = [
    ['Format', `v${snapshot.formatVersion}`],
    ['Generated at (UTC)', snapshot.generatedAt],
    ['DSH Desktop Hub', snapshot.appVersion],
    ['Packaged', snapshot.packaged ? 'yes' : 'no'],
    ['Profile', snapshot.profile],
    ['Platform', snapshot.platform],
    ['OS release', snapshot.osRelease],
    ['Architecture', snapshot.arch],
    ['Electron', snapshot.electronVersion],
    ['Chrome', snapshot.chromeVersion],
    ['Node.js', snapshot.nodeVersion],
    ['DSH runtime', versionOrUnknown(snapshot.dshVersion)],
    ['pnpm', versionOrUnknown(snapshot.pnpmVersion)],
    ['Harness state', snapshot.harnessState],
    ['Harness exit code', exitCodeOrDash(snapshot.harnessExitCode)],
    ['Harness last startup', durationOrDash(snapshot.harnessStartupMs)],
    ['App update state', snapshot.updateState ?? '—'],
    ['Credentials format', snapshot.credentialsFormat ?? '—'],
  ]
  const lines = [
    '<!-- DSH Desktop Hub diagnostics: low-sensitivity whitelist v1 -->',
    '### DSH Desktop Hub diagnostics',
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...rows.map(([key, value]) => `| ${oneLine(key)} | ${oneLine(value)} |`),
  ]
  return `${lines.join('\n')}\n`
}
