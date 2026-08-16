import { MarketplacePlugin, PluginRegistry } from "../core/types";

const SAMPLE_PLUGINS: MarketplacePlugin[] = [
  {
    id: "@deepseek-ai/dsh-web-app",
    name: "DSH Web App",
    version: "0.1.0-rc.6",
    description: "Official DeepSeek Harness web application bundle.",
    author: "DeepSeek AI",
    source: "npm",
    installTarget: "@deepseek-ai/dsh-web-app",
  },
  {
    id: "@deepseek-ai/dsh-tui",
    name: "DSH TUI",
    version: "0.1.0-rc.6",
    description: "Official DeepSeek Harness terminal UI bundle.",
    author: "DeepSeek AI",
    source: "npm",
    installTarget: "@deepseek-ai/dsh-tui",
  },
  {
    id: "@deepseek-ai/dsh-mcp-client",
    name: "MCP Client Bridge",
    version: "0.1.0-rc.6",
    description: "Connect external MCP servers and register their tools.",
    author: "DeepSeek AI",
    source: "npm",
    installTarget: "@deepseek-ai/dsh-mcp-client",
  },
];

export class StaticPluginRegistry implements PluginRegistry {
  private plugins = SAMPLE_PLUGINS;

  async search(query: string): Promise<MarketplacePlugin[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [...this.plugins];
    return this.plugins.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q),
    );
  }

  async get(id: string): Promise<MarketplacePlugin | null> {
    return this.plugins.find((p) => p.id === id) ?? null;
  }
}

export function createRegistry(): PluginRegistry {
  return new StaticPluginRegistry();
}
