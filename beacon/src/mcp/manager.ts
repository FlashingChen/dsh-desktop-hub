import { readFile } from "node:fs/promises";
import { profileCordisPatch } from "../core/paths";
import { McpServerConfig, McpServerView } from "../core/types";
import { parsePatchYaml, stringifyPatchYaml } from "../core/yaml";
import { runConfigTransaction } from "../core/transaction";

const MCP_PLUGIN = "@deepseek-ai/dsh-mcp-client";

export interface McpImportResult {
  servers: McpServerConfig[];
}

export function parseMcpJsonImport(text: string): McpImportResult {
  const parsed = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
  const source = parsed.mcpServers;
  if (!source || typeof source !== "object") {
    throw new Error("JSON must contain an mcpServers object");
  }
  const servers: McpServerConfig[] = Object.entries(source).map(([name, raw]) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const url = typeof entry.url === "string" ? entry.url : undefined;
    return {
      name,
      transport: url ? "streamable-http" : "stdio",
      url,
      command: typeof entry.command === "string" ? entry.command : undefined,
      args: Array.isArray(entry.args) ? (entry.args as string[]) : undefined,
      env: entry.env && typeof entry.env === "object" ? (entry.env as Record<string, string>) : undefined,
      headers: entry.headers && typeof entry.headers === "object" ? (entry.headers as Record<string, string>) : undefined,
      raw: entry,
    };
  });
  return { servers };
}

export function mcpEntryToConfig(entry: Record<string, any>): McpServerConfig {
  const cfg = (entry.config ?? {}) as Record<string, any>;
  return {
    name: cfg.serverName ?? entry.id ?? "unknown",
    transport: cfg.transport === "streamable-http" ? "streamable-http" : "stdio",
    command: typeof cfg.command === "string" ? cfg.command : undefined,
    args: Array.isArray(cfg.args) ? cfg.args : undefined,
    env: cfg.env && typeof cfg.env === "object" ? cfg.env : undefined,
    cwd: typeof cfg.cwd === "string" ? cfg.cwd : undefined,
    url: typeof cfg.url === "string" ? cfg.url : undefined,
    headers: cfg.headers && typeof cfg.headers === "object" ? cfg.headers : undefined,
    toolCallTimeoutMs: typeof cfg.toolCallTimeoutMs === "number" ? cfg.toolCallTimeoutMs : undefined,
    failOnStartupError: typeof cfg.failOnStartupError === "boolean" ? cfg.failOnStartupError : undefined,
    enabled: entry.disabled !== true,
    raw: entry,
  };
}

export function configToMcpEntry(config: McpServerConfig): Record<string, any> {
  const cfg: Record<string, any> = {
    serverName: config.name,
    transport: config.transport,
  };
  if (config.transport === "stdio") {
    if (config.command) cfg.command = config.command;
    if (config.args) cfg.args = config.args;
    if (config.env) cfg.env = config.env;
    if (config.cwd) cfg.cwd = config.cwd;
  } else {
    if (config.url) cfg.url = config.url;
    if (config.headers) cfg.headers = config.headers;
  }
  if (config.toolCallTimeoutMs !== undefined) cfg.toolCallTimeoutMs = config.toolCallTimeoutMs;
  if (config.failOnStartupError !== undefined) cfg.failOnStartupError = config.failOnStartupError;
  const entry: Record<string, any> = {
    id: `mcp-${config.name}`,
    name: MCP_PLUGIN,
    config: cfg,
  };
  if (config.enabled === false) entry.disabled = true;
  return entry;
}

function mcpEntriesFromPatch(entries: any[]): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const patch of entries) {
    if (!patch || typeof patch !== "object") continue;
    if (Array.isArray(patch.insert)) {
      for (const item of patch.insert) {
        if (item && typeof item === "object" && item.name === MCP_PLUGIN) out.push(item);
      }
    } else if (patch.name === MCP_PLUGIN) {
      out.push(patch);
    }
  }
  return out;
}

function replaceMcpEntries(entries: any[], mcpEntries: Record<string, any>[]): any[] {
  const next = entries
    .map((patch) => {
      if (!patch || typeof patch !== "object") return patch;
      if (Array.isArray(patch.insert)) {
        const filtered = patch.insert.filter(
          (item: any) => !(item && typeof item === "object" && item.name === MCP_PLUGIN),
        );
        if (filtered.length === 0) return undefined;
        return { ...patch, insert: filtered };
      }
      if (patch.name === MCP_PLUGIN) return undefined;
      return patch;
    })
    .filter(Boolean);
  if (mcpEntries.length > 0) {
    next.push({ insert: mcpEntries });
  }
  return next;
}

export async function readMcpServers(profile: string): Promise<McpServerView[]> {
  const filePath = profileCordisPatch(profile);
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const entries = parsePatchYaml(text);
  return mcpEntriesFromPatch(entries).map((entry, index) => {
    const cfg = mcpEntryToConfig(entry);
    return {
      ...cfg,
      id: `${cfg.name}-${index}`,
      connectionStatus: cfg.enabled === false ? "disabled" : "unknown",
      toolCount: 0,
    };
  });
}

export async function writeMcpServers(profile: string, servers: McpServerConfig[]): Promise<{
  backupPath: string;
  snapshotId: string;
}> {
  const filePath = profileCordisPatch(profile);
  const mcpEntries = servers.map(configToMcpEntry);
  const result = await runConfigTransaction<any[]>({
    filePath,
    action: "Update MCP servers",
    target: `profile:${profile}`,
    profile,
    mutate: (current) => replaceMcpEntries(current, mcpEntries),
    validate: (next) => {
      if (!Array.isArray(next)) throw new Error("cordis.patch.yml must remain a YAML array");
    },
  });
  return { backupPath: result.backupPath, snapshotId: result.snapshotId };
}

export async function addMcpServer(profile: string, config: McpServerConfig): Promise<void> {
  const servers = (await readMcpServers(profile)).map(stripView);
  if (servers.some((s) => s.name === config.name)) {
    throw new Error(`MCP server "${config.name}" already exists`);
  }
  await writeMcpServers(profile, [...servers, config]);
}

export async function updateMcpServer(profile: string, originalName: string, config: McpServerConfig): Promise<void> {
  const servers = (await readMcpServers(profile)).map(stripView);
  const idx = servers.findIndex((s) => s.name === originalName);
  if (idx === -1) throw new Error(`MCP server "${originalName}" not found`);
  if (config.name !== originalName && servers.some((s) => s.name === config.name)) {
    throw new Error(`MCP server "${config.name}" already exists`);
  }
  servers[idx] = config;
  await writeMcpServers(profile, servers);
}

export async function deleteMcpServer(profile: string, name: string): Promise<void> {
  const servers = (await readMcpServers(profile)).map(stripView);
  const next = servers.filter((s) => s.name !== name);
  if (next.length === servers.length) throw new Error(`MCP server "${name}" not found`);
  await writeMcpServers(profile, next);
}

export async function setMcpEnabled(profile: string, name: string, enabled: boolean): Promise<void> {
  const servers = (await readMcpServers(profile)).map(stripView);
  const idx = servers.findIndex((s) => s.name === name);
  if (idx === -1) throw new Error(`MCP server "${name}" not found`);
  servers[idx] = { ...servers[idx], enabled };
  await writeMcpServers(profile, servers);
}

function stripView(view: McpServerView): McpServerConfig {
  const { id: _id, connectionStatus: _cs, toolCount: _tc, error: _err, ...cfg } = view;
  return cfg;
}

export async function testMcpConnection(config: McpServerConfig): Promise<{
  ok: boolean;
  toolCount: number;
  tools: string[];
  error?: string;
}> {
  if (!config.enabled) return { ok: false, toolCount: 0, tools: [], error: "Server is disabled" };
  try {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const client = new Client({ name: "dsh-beacon", version: "0.1.0" });
    let transport: any;
    if (config.transport === "stdio") {
      if (!config.command) throw new Error("stdio server requires a command");
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: config.env ?? {},
        cwd: config.cwd,
      });
    } else {
      if (!config.url) throw new Error("streamable-http server requires a url");
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      });
    }
    await client.connect(transport);
    const result = await client.listTools();
    const tools = result.tools.map((t: any) => t.name);
    await client.close();
    return { ok: true, toolCount: tools.length, tools };
  } catch (err) {
    return { ok: false, toolCount: 0, tools: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export async function viewMcpTools(config: McpServerConfig): Promise<string[]> {
  const result = await testMcpConnection(config);
  if (!result.ok) throw new Error(result.error || "Connection failed");
  return result.tools;
}
