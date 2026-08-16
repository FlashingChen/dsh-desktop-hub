import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('dshDesktop', {
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },
  harness: {
    url: () => ipcRenderer.invoke('harness:url'),
    onFrameLoaded: (cb: (url: string) => void) => {
      ipcRenderer.on('harness:frame-loaded', (_e, url: string) => cb(url))
    },
  },
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    install: (spec: string) => ipcRenderer.invoke('plugins:install', spec),
    remove: (name: string) => ipcRenderer.invoke('plugins:remove', name),
    update: () => ipcRenderer.invoke('plugins:update'),
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    convert: (jsonText: string) => ipcRenderer.invoke('mcp:convert', jsonText),
    apply: (rows: unknown[]) => ipcRenderer.invoke('mcp:apply', rows),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    create: (input: { name: string; description: string; body: string }) => ipcRenderer.invoke('skills:create', input),
    toggle: (input: { path: string; kind: 'model' | 'user'; value: boolean }) => ipcRenderer.invoke('skills:toggle', input),
    importFile: (buffer: ArrayBuffer, overwrite: boolean) => ipcRenderer.invoke('skills:import-file', buffer, overwrite),
    importUrl: (url: string, overwrite: boolean) => ipcRenderer.invoke('skills:import-url', url, overwrite),
  },
})
