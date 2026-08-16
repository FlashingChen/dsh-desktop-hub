export type CheckStatus = "ok" | "warning" | "error";

export interface CheckResult {
  status: CheckStatus;
  title: string;
  message: string;
  details?: string;
}

export interface DshEnvironment {
  installed: boolean;
  dshPath?: string;
  version?: string;
  dshHome: string;
  profilesRoot: string;
  profiles: ProfileInfo[];
  activeProfile?: string;
  runtimeStatus: "unknown" | "running" | "stopped" | "error";
}

export interface ProfileInfo {
  name: string;
  path: string;
  active: boolean;
  pluginCount: number;
  mcpCount: number;
  skillCount: number;
  bundles: string[];
  dependencies: Record<string, string>;
  exists: boolean;
}

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  toolCallTimeoutMs?: number;
  failOnStartupError?: boolean;
  enabled?: boolean;
  raw?: unknown;
}

export interface McpServerView extends McpServerConfig {
  id: string;
  connectionStatus: "unknown" | "connected" | "failed" | "disabled";
  toolCount: number;
  error?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  scope: "project-dsh" | "project-agents" | "custom" | "user-dsh" | "user-agents" | "unknown";
  rank: number;
  path: string;
  root: string;
  enabled: boolean;
  effective: boolean;
  shadowed: boolean;
  format: "bundle" | "flat";
  whenToUse?: string;
  frontmatter: Record<string, unknown>;
}

export interface PluginInfo {
  name: string;
  version?: string;
  source?: string;
  profile: string;
  enabled: boolean;
  updateAvailable: boolean;
  bundle: boolean;
}

export interface SnapshotRecord {
  id: string;
  timestamp: string;
  action: string;
  target: string;
  profile: string;
  backupPath: string;
  targetPath?: string;
  restoredAt?: string;
}

export interface MarketplacePlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  homepage?: string;
  source: "npm" | "local" | "git";
  installTarget: string;
}

export interface RegistryPlugin extends MarketplacePlugin {}

export interface PluginRegistry {
  search(query: string): Promise<MarketplacePlugin[]>;
  get(id: string): Promise<MarketplacePlugin | null>;
}

export interface AppState {
  activeProfile?: string;
  workspaceRoot?: string;
}
