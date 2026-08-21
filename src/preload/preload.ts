import { contextBridge, ipcRenderer } from 'electron'

// Channel 名与 src/core/ipc.ts 保持一致（preload 是独立 CJS 编译，不能 import 共享模块；
// tests/skeleton.test.mjs 断言两者字符级一致）。
const CH = {
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

interface HarnessStatus {
  state: 'starting' | 'ready' | 'exited' | 'restarting'
  url?: string
  code?: number | null
  signal?: string | null
  error?: string
}

type UpdateState = 'idle' | 'unsupported' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'

interface UpdateStatus {
  state: UpdateState
  currentVersion: string
  version?: string
  releaseName?: string
  releaseDate?: string
  percent?: number
  error?: string
}

interface UpdateActionResult {
  ok: boolean
  status: UpdateStatus
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
  updates: {
    status: (): Promise<UpdateStatus> => ipcRenderer.invoke(CH.updatesGetStatus),
    check: (): Promise<UpdateActionResult> => ipcRenderer.invoke(CH.updatesCheck),
    download: (): Promise<UpdateActionResult> => ipcRenderer.invoke(CH.updatesDownload),
    install: (): Promise<UpdateActionResult> => ipcRenderer.invoke(CH.updatesInstall),
    onStatus: (cb: (status: UpdateStatus) => void): void => {
      ipcRenderer.on(CH.updatesStatus, (_e, status: UpdateStatus) => cb(status))
    },
  },
  plugins: {
    list: () => ipcRenderer.invoke(CH.pluginsList),
    activate: (name: string) => ipcRenderer.invoke(CH.pluginsActivate, name),
    deactivate: (name: string) => ipcRenderer.invoke(CH.pluginsDeactivate, name),
    prepareInstall: (spec: string) => ipcRenderer.invoke(CH.pluginsPrepareInstall, spec),
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
  feedback: {
    diagnostics: (): Promise<{ ok: boolean; text?: string; error?: string }> => ipcRenderer.invoke(CH.feedbackDiagnostics),
    copy: (text: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(CH.feedbackCopy, text),
    submit: (input: {
      mode: 'anonymous' | 'signed'
      category: 'bug' | 'feature' | 'other'
      title: string
      body: string
      signature?: string | null
      diagnostics?: string | null
    }): Promise<{ ok: boolean; status?: 'queued' | 'accepted'; receiptId?: string; code?: string; message?: string; retryable?: boolean }> =>
      ipcRenderer.invoke(CH.feedbackSubmit, input),
  },
})
