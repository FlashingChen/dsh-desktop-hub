/**
 * Low-sensitivity diagnostics shared by feedback UI, clipboard export and the
 * future feedback service.  Keep this type deliberately closed: adding a field
 * here is a privacy decision, not just a formatting change.
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
