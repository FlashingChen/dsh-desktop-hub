import { contextBridge, ipcRenderer } from 'electron'

// Channel 名与 src/core/ipc.ts 保持一致（preload 是独立 CJS 编译，不能 import 共享模块；
// tests/skeleton.test.mjs 断言两者字符级一致）。
const CH = {
  harnessUrl: 'harness:url',
  harnessStatus: 'harness:status',
  harnessFrameLoaded: 'harness:frame-loaded',
  harnessRestart: 'harness:restart',
  pluginsList: 'plugins:list',
  pluginsActivate: 'plugins:activate',
  pluginsDeactivate: 'plugins:deactivate',
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
} as const

interface HarnessStatus {
  state: 'starting' | 'ready' | 'exited' | 'restarting'
  url?: string
  code?: number | null
  signal?: string | null
  error?: string
}

interface PluginOpStarted {
  ok: boolean
  token?: string
  error?: string
}

interface PluginOpDone {
  token: string
  exitCode: number | null
  signal: string | null
  output: string
}

type PluginOpStatus =
  | { state: 'running' }
  | { state: 'done'; done: PluginOpDone }
  | { state: 'unknown' }

contextBridge.exposeInMainWorld('dshDesktop', {
  harness: {
    url: (): Promise<string | null> => ipcRenderer.invoke(CH.harnessUrl),
    restart: (): Promise<{ ok: boolean; url?: string; error?: string }> => ipcRenderer.invoke(CH.harnessRestart),
    onFrameLoaded: (cb: (url: string) => void): void => {
      ipcRenderer.on(CH.harnessFrameLoaded, (_e, url: string) => cb(url))
    },
    onStatus: (cb: (status: HarnessStatus) => void): void => {
      ipcRenderer.on(CH.harnessStatus, (_e, status: HarnessStatus) => cb(status))
    },
  },
  plugins: {
    list: () => ipcRenderer.invoke(CH.pluginsList),
    activate: (name: string) => ipcRenderer.invoke(CH.pluginsActivate, name),
    deactivate: (name: string) => ipcRenderer.invoke(CH.pluginsDeactivate, name),
    startOp: (action: 'add' | 'remove' | 'update', args: string[]): Promise<PluginOpStarted> =>
      ipcRenderer.invoke(CH.pluginsStartOp, action, args),
    cancelOp: (token: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(CH.pluginsCancelOp, token),
    opStatus: (token: string): Promise<PluginOpStatus> => ipcRenderer.invoke(CH.pluginsOpStatus, token),
    onOpChunk: (cb: (token: string, text: string) => void): void => {
      ipcRenderer.on(CH.pluginOpChunk, (_e, token: string, text: string) => cb(token, text))
    },
    onOpDone: (cb: (done: PluginOpDone) => void): void => {
      ipcRenderer.on(CH.pluginOpDone, (_e, done: PluginOpDone) => cb(done))
    },
  },
  mcp: {
    list: () => ipcRenderer.invoke(CH.mcpList),
    convert: (jsonText: string) => ipcRenderer.invoke(CH.mcpConvert, jsonText),
    apply: (input: { rows: unknown[]; mode: 'merge' | 'replace' }) => ipcRenderer.invoke(CH.mcpApply, input),
    update: (input: { id: string; row: unknown }) => ipcRenderer.invoke(CH.mcpUpdate, input),
    delete: (id: string) => ipcRenderer.invoke(CH.mcpDelete, id),
  },
  skills: {
    list: () => ipcRenderer.invoke(CH.skillsList),
    create: (input: { name: string; description: string; body: string; overwrite?: boolean }) => ipcRenderer.invoke(CH.skillsCreate, input),
    toggle: (input: { id: string; source: string; kind: 'model' | 'user'; value: boolean }) =>
      ipcRenderer.invoke(CH.skillsToggle, input),
    importFile: (buffer: ArrayBuffer, overwrite: boolean) => ipcRenderer.invoke(CH.skillsImportFile, buffer, overwrite),
    importUrl: (url: string, overwrite: boolean) => ipcRenderer.invoke(CH.skillsImportUrl, url, overwrite),
    importClawHub: (input: { owner: string; slug: string; version?: string }, overwrite: boolean) =>
      ipcRenderer.invoke(CH.skillsImportClawHub, input, overwrite),
  },
  market: {
    list: (kind: 'plugin' | 'mcp' | 'skill', query?: string) => ipcRenderer.invoke(CH.marketList, kind, query),
    preflightPlugin: (spec: string) => ipcRenderer.invoke(CH.marketPluginPreflight, spec),
  },
})
