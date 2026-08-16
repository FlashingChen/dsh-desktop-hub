// 主进程 ↔ preload 共享 IPC 契约：channel 名 + 载荷类型
// （renderer 是纯脚本无法 import，保持字符串一致的复制，见 renderer.ts 顶部注释）

export const IPC = {
  harnessUrl: 'harness:url',
  harnessStatus: 'harness:status',
  harnessFrameLoaded: 'harness:frame-loaded',
  harnessRestart: 'harness:restart',
  pluginsList: 'plugins:list',
  pluginsActivate: 'plugins:activate',
  pluginsDeactivate: 'plugins:deactivate',
  pluginsStartOp: 'plugins:start-op',
  pluginsCancelOp: 'plugins:cancel-op',
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
} as const

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

export interface HarnessStatus {
  state: 'starting' | 'ready' | 'exited' | 'restarting'
  url?: string
  code?: number | null
  signal?: string | null
}

export interface McpApplyInput {
  rows: unknown[]
  mode: 'merge' | 'replace'
}
