import { app, BrowserWindow, ipcMain, shell } from "electron";
import { join } from "node:path";
import { detectEnvironment, saveAppState, loadAppState } from "../core/env";
import { listProfiles, profileExists } from "../core/profiles";
import {
  readMcpServers,
  addMcpServer,
  updateMcpServer,
  deleteMcpServer,
  setMcpEnabled,
  testMcpConnection,
  parseMcpJsonImport,
  viewMcpTools,
} from "../mcp/manager";
import { McpServerConfig } from "../core/types";
import {
  scanSkills,
  installSkillFromLocal,
  installSkillFromGitHub,
  deleteSkill,
  setSkillEnabled,
  readSkillMd,
} from "../skills/manager";
import {
  listPlugins,
  installPlugin,
  removePlugin,
  updatePlugin,
  updateAllPlugins,
  setPluginEnabled,
} from "../plugins/manager";
import { runDoctor } from "../doctor/doctor";
import { createRegistry } from "../marketplace/registry";
import { loadSnapshots, restoreSnapshot } from "../core/snapshots";

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: "DSH Beacon",
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(join(__dirname, "../../assets/renderer/index.html"));
}

function handle<T>(channel: string, fn: (...args: any[]) => Promise<T>): void {
  ipcMain.handle(channel, async (_event, ...args: any[]) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

app.whenReady().then(() => {
  handle("env:detect", () => detectEnvironment());
  handle("profiles:list", () => listProfiles());
  handle("profiles:exists", (name: string) => profileExists(name));
  handle("mcp:list", (profile: string) => readMcpServers(profile));
  handle("mcp:add", (profile: string, config: McpServerConfig) => addMcpServer(profile, config));
  handle("mcp:update", (profile: string, originalName: string, config: McpServerConfig) =>
    updateMcpServer(profile, originalName, config),
  );
  handle("mcp:delete", (profile: string, name: string) => deleteMcpServer(profile, name));
  handle("mcp:setEnabled", (profile: string, name: string, enabled: boolean) => setMcpEnabled(profile, name, enabled));
  handle("mcp:test", (config: McpServerConfig) => testMcpConnection(config));
  handle("mcp:importJson", async (text: string) => parseMcpJsonImport(text));
  handle("mcp:tools", (config: McpServerConfig) => viewMcpTools(config));

  handle("skills:list", (workspaceRoot?: string) => scanSkills({ workspaceRoot }));
  handle("skills:installLocal", (sourcePath: string, scope: "workspace" | "user", workspaceRoot?: string) =>
    installSkillFromLocal(sourcePath, scope, workspaceRoot),
  );
  handle("skills:installGitHub", (repoUrl: string, scope: "workspace" | "user", workspaceRoot?: string) =>
    installSkillFromGitHub(repoUrl, scope, workspaceRoot),
  );
  handle("skills:delete", (path: string) => deleteSkill(path));
  handle("skills:setEnabled", (path: string, enabled: boolean) => setSkillEnabled(path, enabled));
  handle("skills:read", (path: string) => readSkillMd(path));

  handle("plugins:list", (profile: string) => listPlugins(profile));
  handle("plugins:install", (profile: string, spec: string) => installPlugin(profile, spec));
  handle("plugins:remove", (profile: string, name: string) => removePlugin(profile, name));
  handle("plugins:update", (profile: string, name: string) => updatePlugin(profile, name));
  handle("plugins:updateAll", (profile: string) => updateAllPlugins(profile));
  handle("plugins:setEnabled", (profile: string, name: string, enabled: boolean) =>
    setPluginEnabled(profile, name, enabled),
  );

  handle("doctor:run", (profile?: string, workspaceRoot?: string) => runDoctor({ profile, workspaceRoot }));

  const registry = createRegistry();
  handle("marketplace:search", (query: string) => registry.search(query));
  handle("marketplace:get", (id: string) => registry.get(id));
  handle("marketplace:install", async (profile: string, id: string) => {
    const plugin = await registry.get(id);
    if (!plugin) throw new Error(`Marketplace plugin not found: ${id}`);
    return installPlugin(profile, plugin.installTarget);
  });

  handle("snapshots:list", () => loadSnapshots());
  handle("snapshots:restore", (id: string) => restoreSnapshot(id));

  handle("state:get", () => loadAppState());
  handle("state:set", (state: Record<string, unknown>) => saveAppState(state));
  handle("shell:openPath", (path: string) => shell.openPath(path));

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
