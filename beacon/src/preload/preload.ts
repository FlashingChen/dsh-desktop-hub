import { contextBridge, ipcRenderer } from "electron";
import { DshEnvironment, McpServerConfig, SnapshotRecord, MarketplacePlugin } from "../core/types";

const api = {
  detectEnv: (): Promise<DshEnvironment> => ipcRenderer.invoke("env:detect"),
  listProfiles: () => ipcRenderer.invoke("profiles:list"),
  profileExists: (name: string) => ipcRenderer.invoke("profiles:exists", name),

  mcpList: (profile: string) => ipcRenderer.invoke("mcp:list", profile),
  mcpAdd: (profile: string, config: McpServerConfig) => ipcRenderer.invoke("mcp:add", profile, config),
  mcpUpdate: (profile: string, originalName: string, config: McpServerConfig) =>
    ipcRenderer.invoke("mcp:update", profile, originalName, config),
  mcpDelete: (profile: string, name: string) => ipcRenderer.invoke("mcp:delete", profile, name),
  mcpSetEnabled: (profile: string, name: string, enabled: boolean) =>
    ipcRenderer.invoke("mcp:setEnabled", profile, name, enabled),
  mcpTest: (config: McpServerConfig) => ipcRenderer.invoke("mcp:test", config),
  mcpImportJson: (text: string) => ipcRenderer.invoke("mcp:importJson", text),
  mcpTools: (config: McpServerConfig) => ipcRenderer.invoke("mcp:tools", config),

  skillsList: (workspaceRoot?: string) => ipcRenderer.invoke("skills:list", workspaceRoot),
  skillsInstallLocal: (sourcePath: string, scope: "workspace" | "user", workspaceRoot?: string) =>
    ipcRenderer.invoke("skills:installLocal", sourcePath, scope, workspaceRoot),
  skillsInstallGitHub: (repoUrl: string, scope: "workspace" | "user", workspaceRoot?: string) =>
    ipcRenderer.invoke("skills:installGitHub", repoUrl, scope, workspaceRoot),
  skillsDelete: (path: string) => ipcRenderer.invoke("skills:delete", path),
  skillsSetEnabled: (path: string, enabled: boolean) => ipcRenderer.invoke("skills:setEnabled", path, enabled),
  skillsRead: (path: string) => ipcRenderer.invoke("skills:read", path),

  pluginsList: (profile: string) => ipcRenderer.invoke("plugins:list", profile),
  pluginsInstall: (profile: string, spec: string) => ipcRenderer.invoke("plugins:install", profile, spec),
  pluginsRemove: (profile: string, name: string) => ipcRenderer.invoke("plugins:remove", profile, name),
  pluginsUpdate: (profile: string, name: string) => ipcRenderer.invoke("plugins:update", profile, name),
  pluginsUpdateAll: (profile: string) => ipcRenderer.invoke("plugins:updateAll", profile),
  pluginsSetEnabled: (profile: string, name: string, enabled: boolean) =>
    ipcRenderer.invoke("plugins:setEnabled", profile, name, enabled),

  doctorRun: (profile?: string, workspaceRoot?: string) => ipcRenderer.invoke("doctor:run", profile, workspaceRoot),

  marketplaceSearch: (query: string) => ipcRenderer.invoke("marketplace:search", query),
  marketplaceGet: (id: string) => ipcRenderer.invoke("marketplace:get", id),
  marketplaceInstall: (profile: string, id: string) => ipcRenderer.invoke("marketplace:install", profile, id),

  snapshotsList: (): Promise<SnapshotRecord[]> => ipcRenderer.invoke("snapshots:list"),
  snapshotsRestore: (id: string) => ipcRenderer.invoke("snapshots:restore", id),

  stateGet: () => ipcRenderer.invoke("state:get"),
  stateSet: (state: Record<string, unknown>) => ipcRenderer.invoke("state:set", state),
  openPath: (path: string) => ipcRenderer.invoke("shell:openPath", path),
};

export type BeaconApi = typeof api;

contextBridge.exposeInMainWorld("beacon", api);
