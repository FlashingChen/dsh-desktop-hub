import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('dshDesktop', {
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    install: (spec: string) => ipcRenderer.invoke('plugins:install', spec),
    remove: (name: string) => ipcRenderer.invoke('plugins:remove', name),
    update: () => ipcRenderer.invoke('plugins:update'),
  },
})
