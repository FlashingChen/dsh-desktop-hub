// 主进程 ↔ preload 共享 IPC 契约：channel 名 + 载荷类型
// （renderer 是纯脚本无法 import，保持字符串一致的复制，见 renderer.ts 顶部注释）

export const IPC = {
  harnessUrl: 'harness:url',
  harnessStatus: 'harness:status',
  harnessFrameLoaded: 'harness:frame-loaded',
  harnessRestart: 'harness:restart',
  updatesStatus: 'updates:status',
  updatesGetStatus: 'updates:get-status',
  updatesCheck: 'updates:check',
  updatesDownload: 'updates:download',
  updatesInstall: 'updates:install',
  pluginsList: 'plugins:list',
  pluginsActivate: 'plugins:activate',
  pluginsDeactivate: 'plugins:deactivate',
  pluginsPrepareInstall: 'plugins:prepare-install',
  pluginsStartOp: 'plugins:start-op',
  pluginsCancelOp: 'plugins:cancel-op',
  pluginsOpStatus: 'plugins:op-status',
  pluginOpChunk: 'plugin-op:chunk',
  pluginOpDone: 'plugin-op:done',
  mcpList: 'mcp:list',
  mcpConvert: 'mcp:convert',
  mcpApply: 'mcp:apply',
  mcpUpdate: 'mcp:update',
  mcpDelete: 'mcp:delete',
  skillsList: 'skills:list',
  skillsCreate: 'skills:create',
  skillsToggle: 'skills:toggle',
  skillsImportFile: 'skills:import-file',
  skillsImportUrl: 'skills:import-url',
  skillsImportClawHub: 'skills:import-clawhub',
  marketList: 'market:list',
  marketPluginPreflight: 'market:plugin-preflight',
  feedbackDiagnostics: 'feedback:diagnostics',
  feedbackCopy: 'feedback:copy',
  feedbackSubmit: 'feedback:submit',
} as const

export type UpdateState = 'idle' | 'unsupported' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'

export interface UpdateStatus {
  state: UpdateState
  currentVersion: string
  version?: string
  releaseName?: string
  releaseDate?: string
  percent?: number
  error?: string
}

export interface UpdateActionResult {
  ok: boolean
  status: UpdateStatus
  error?: string
}

export type PluginOpAction = 'add' | 'remove' | 'update'

export interface PluginOpStarted {
  ok: boolean
  token?: string
  error?: string
}

export interface PluginOpDone {
  token: string
  exitCode: number | null
  signal: string | null
  output: string
}

export type PluginOpStatus =
  | { state: 'running' }
  | { state: 'done'; done: PluginOpDone }
  | { state: 'unknown' }

export interface HarnessStatus {
  state: 'starting' | 'ready' | 'exited' | 'restarting'
  url?: string
  code?: number | null
  signal?: string | null
  /** 失败/退出原因（面向用户的简短说明，UI 显示；详见运行日志） */
  error?: string
}

export interface McpApplyInput {
  rows: unknown[]
  mode: 'merge' | 'replace'
}

export interface FeedbackSubmitInput {
  mode: 'anonymous' | 'signed'
  category: 'bug' | 'feature' | 'other'
  title: string
  body: string
  signature?: string | null
  diagnostics?: string | null
}
