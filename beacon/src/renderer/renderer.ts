import { DshEnvironment, ProfileInfo, McpServerView, McpServerConfig, SkillInfo, PluginInfo, CheckResult, SnapshotRecord, MarketplacePlugin } from "../core/types";

type Page = "overview" | "plugins" | "skills" | "mcp" | "profiles" | "doctor" | "settings" | "marketplace";

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector(selector) as T;

async function call<T>(promise: Promise<any>): Promise<T> {
  const res = await promise;
  if (res && res.ok === false) throw new Error(res.error || "Unknown error");
  return (res?.data ?? res) as T;
}

let state: {
  env?: DshEnvironment;
  profiles: ProfileInfo[];
  activeProfile?: string;
  workspaceRoot?: string;
} = { profiles: [] };

function setStatus(message: string, kind: "ok" | "error" = "ok"): void {
  const el = $("#status");
  if (!el) return;
  el.textContent = message;
  el.className = `status ${kind}`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function refresh(): Promise<void> {
  try {
    state.env = await call<DshEnvironment>(window.beacon.detectEnv());
    state.profiles = state.env.profiles;
    state.activeProfile = state.env.activeProfile;
    const appState = await call<{ workspaceRoot?: string }>(window.beacon.stateGet());
    state.workspaceRoot = appState.workspaceRoot;
    updateChrome();
    await renderCurrentPage();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "error");
  }
}

function updateChrome(): void {
  $("#profile-label").textContent = state.activeProfile ? `Profile: ${state.activeProfile}` : "No profile";
  $("#version-label").textContent = state.env?.version ? `DSH ${state.env.version}` : "DSH not found";
  const navLinks = document.querySelectorAll<HTMLAnchorElement>("[data-page]");
  navLinks.forEach((link) => link.classList.toggle("active", link.dataset.page === location.hash.replace("#", "")));
}

function page(): Page {
  const p = location.hash.replace("#", "") as Page;
  return ["overview", "plugins", "skills", "mcp", "profiles", "doctor", "settings", "marketplace"].includes(p)
    ? p
    : "overview";
}

async function renderCurrentPage(): Promise<void> {
  const p = page();
  const view = $("#view");
  if (p === "overview") view.innerHTML = await overviewHtml();
  else if (p === "plugins") view.innerHTML = await pluginsHtml();
  else if (p === "skills") view.innerHTML = await skillsHtml();
  else if (p === "mcp") view.innerHTML = await mcpHtml();
  else if (p === "profiles") view.innerHTML = await profilesHtml();
  else if (p === "doctor") view.innerHTML = await doctorHtml();
  else if (p === "settings") view.innerHTML = await settingsHtml();
  else if (p === "marketplace") view.innerHTML = await marketplaceHtml();
  bindPageEvents(p);
}

function bindPageEvents(p: Page): void {
  if (p === "mcp") bindMcpEvents();
  else if (p === "skills") bindSkillsEvents();
  else if (p === "plugins") bindPluginsEvents();
  else if (p === "profiles") bindProfilesEvents();
  else if (p === "doctor") bindDoctorEvents();
  else if (p === "settings") bindSettingsEvents();
  else if (p === "marketplace") bindMarketplaceEvents();
}

// ---------- Overview ----------
async function overviewHtml(): Promise<string> {
  const env = state.env;
  if (!env) return "<p>Loading environment…</p>";
  const [mcp, skills, plugins] = await Promise.all([
    state.activeProfile ? call<McpServerView[]>(window.beacon.mcpList(state.activeProfile)) : Promise.resolve([] as McpServerView[]),
    call<SkillInfo[]>(window.beacon.skillsList(state.workspaceRoot)),
    state.activeProfile ? call<PluginInfo[]>(window.beacon.pluginsList(state.activeProfile)) : Promise.resolve([] as PluginInfo[]),
  ]);
  const errorCount = !env.installed ? 1 : 0;
  return `
    <h1>Overview</h1>
    <div class="cards">
      <div class="card"><div class="num">${escapeHtml(env.version || "—")}</div><div>DSH Version</div></div>
      <div class="card"><div class="num">${escapeHtml(state.activeProfile || "—")}</div><div>Current Profile</div></div>
      <div class="card"><div class="num">${escapeHtml(env.runtimeStatus)}</div><div>Runtime</div></div>
      <div class="card"><div class="num">${plugins.length}</div><div>Plugins</div></div>
      <div class="card"><div class="num">${skills.length}</div><div>Skills</div></div>
      <div class="card"><div class="num">${mcp.length}</div><div>MCP Servers</div></div>
      <div class="card"><div class="num">${errorCount}</div><div>Errors</div></div>
    </div>
    <h2>Quick Actions</h2>
    <div class="actions">
      <button data-nav="mcp">Add MCP</button>
      <button data-nav="skills">Install Skill</button>
      <button data-nav="plugins">Install Plugin</button>
      <button data-nav="doctor">Run Doctor</button>
      <button id="open-dsh">Open DSH</button>
    </div>`;
}

async function bindOverviewEvents(): Promise<void> {
  const openDsh = $("#open-dsh");
  if (openDsh) openDsh.addEventListener("click", () => window.open("https://github.com/deepseek-ai/deepseek-harness"));
  document.querySelectorAll<HTMLButtonElement>("[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      location.hash = `#${btn.dataset.nav}`;
    });
  });
}

// ---------- Plugins ----------
async function pluginsHtml(): Promise<string> {
  if (!state.activeProfile) return "<p>No active profile.</p>";
  const plugins = await call<PluginInfo[]>(window.beacon.pluginsList(state.activeProfile));
  return `
    <h1>Plugins <small>${escapeHtml(state.activeProfile)}</small></h1>
    <div class="row">
      <input id="plugin-spec" placeholder="npm package spec, e.g. @deepseek-ai/dsh-web-app" />
      <button id="plugin-install">Install</button>
      <button id="plugin-update-all">Update All</button>
    </div>
    <table>
      <thead><tr><th>Name</th><th>Version</th><th>Enabled</th><th>Actions</th></tr></thead>
      <tbody>
        ${plugins.map((p) => `<tr>
          <td>${escapeHtml(p.name)}</td>
          <td>${escapeHtml(p.version)}</td>
          <td>${p.enabled ? "✅" : "⛔"}</td>
          <td>
            <button data-plugin-toggle="${escapeHtml(p.name)}">${p.enabled ? "Disable" : "Enable"}</button>
            <button data-plugin-update="${escapeHtml(p.name)}">Update</button>
            <button data-plugin-remove="${escapeHtml(p.name)}">Remove</button>
          </td>
        </tr>`).join("")}
      </tbody>
    </table>`;
}

function bindPluginsEvents(): void {
  $("#plugin-install")?.addEventListener("click", async () => {
    const spec = ($("#plugin-spec") as HTMLInputElement).value.trim();
    if (!spec || !state.activeProfile) return;
    try {
      setStatus(await call<string>(window.beacon.pluginsInstall(state.activeProfile, spec)), "ok");
      await renderCurrentPage();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), "error");
    }
  });
  $("#plugin-update-all")?.addEventListener("click", async () => {
    if (!state.activeProfile) return;
    try {
      setStatus(await call<string>(window.beacon.pluginsUpdateAll(state.activeProfile)), "ok");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), "error");
    }
  });
  document.querySelectorAll<HTMLButtonElement>("[data-plugin-toggle]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.pluginToggle!;
      if (!state.activeProfile) return;
      try {
        const list = await call<PluginInfo[]>(window.beacon.pluginsList(state.activeProfile));
        const p = list.find((x) => x.name === name);
        await call(window.beacon.pluginsSetEnabled(state.activeProfile, name, !p?.enabled));
        await renderCurrentPage();
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err), "error");
      }
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-plugin-update]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.pluginUpdate!;
      if (!state.activeProfile) return;
      try {
        setStatus(await call<string>(window.beacon.pluginsUpdate(state.activeProfile, name)), "ok");
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err), "error");
      }
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-plugin-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.pluginRemove!;
      if (!state.activeProfile) return;
      try {
        setStatus(await call<string>(window.beacon.pluginsRemove(state.activeProfile, name)), "ok");
        await renderCurrentPage();
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err), "error");
      }
    });
  });
}

// ---------- Skills ----------
async function skillsHtml(): Promise<string> {
  const skills = await call<SkillInfo[]>(window.beacon.skillsList(state.workspaceRoot));
  return `
    <h1>Skills</h1>
    <div class="row">
      <input id="skill-local" placeholder="Local skill folder path" />
      <select id="skill-scope"><option value="user">User/Global</option><option value="workspace">Workspace</option></select>
      <button id="skill-install-local">Install Local</button>
      <input id="skill-github" placeholder="GitHub repo URL" />
      <button id="skill-install-github">Install GitHub</button>
      <span class="muted">DSH currently supports user/global and workspace/project skill scopes; profile-scoped skills are not part of DSH's skill-filesystem rules.</span>
    </div>
    <table>
      <thead><tr><th>Name</th><th>Description</th><th>Scope</th><th>State</th><th>Actions</th></tr></thead>
      <tbody>
        ${skills.map((s) => `<tr>
          <td>${escapeHtml(s.name)}${s.shadowed ? " <span class='warn'>shadowed</span>" : ""}</td>
          <td>${escapeHtml(s.description)}</td>
          <td>${escapeHtml(s.scope)}</td>
          <td>${s.enabled ? "enabled" : "disabled"}${s.effective ? " / effective" : ""}</td>
          <td>
            <button data-skill-toggle="${escapeHtml(s.path)}">${s.enabled ? "Disable" : "Enable"}</button>
            <button data-skill-open="${escapeHtml(s.path)}">Open</button>
            <button data-skill-delete="${escapeHtml(s.path)}">Delete</button>
          </td>
        </tr>`).join("")}
      </tbody>
    </table>`;
}

function bindSkillsEvents(): void {
  const scope = (): "workspace" | "user" => ($("#skill-scope") as HTMLSelectElement).value as "workspace" | "user";
  $("#skill-install-local")?.addEventListener("click", async () => {
    const path = ($("#skill-local") as HTMLInputElement).value.trim();
    if (!path) return;
    try {
      await call(window.beacon.skillsInstallLocal(path, scope(), state.workspaceRoot));
      await renderCurrentPage();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), "error");
    }
  });
  $("#skill-install-github")?.addEventListener("click", async () => {
    const url = ($("#skill-github") as HTMLInputElement).value.trim();
    if (!url) return;
    try {
      await call(window.beacon.skillsInstallGitHub(url, scope(), state.workspaceRoot));
      await renderCurrentPage();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), "error");
    }
  });
  document.querySelectorAll<HTMLButtonElement>("[data-skill-toggle]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const path = btn.dataset.skillToggle!;
      try {
        const skills = await call<SkillInfo[]>(window.beacon.skillsList(state.workspaceRoot));
        const s = skills.find((x) => x.path === path);
        await call(window.beacon.skillsSetEnabled(path, !s?.enabled));
        await renderCurrentPage();
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err), "error");
      }
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-skill-open]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await call(window.beacon.openPath(btn.dataset.skillOpen!));
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-skill-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const path = btn.dataset.skillDelete!;
      if (!confirm(`Delete skill at ${path}?`)) return;
      try {
        await call(window.beacon.skillsDelete(path));
        await renderCurrentPage();
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err), "error");
      }
    });
  });
}

// ---------- MCP ----------
async function mcpHtml(): Promise<string> {
  if (!state.activeProfile) return "<p>No active profile.</p>";
  const servers = await call<McpServerView[]>(window.beacon.mcpList(state.activeProfile));
  return `
    <h1>MCP <small>${escapeHtml(state.activeProfile)}</small></h1>
    <h2>Manual Form</h2>
    <div class="row"><input id="mcp-name" placeholder="Name" /><select id="mcp-transport"><option value="stdio">stdio</option><option value="streamable-http">streamable-http</option></select></div>
    <div class="row"><input id="mcp-url" placeholder="URL (streamable-http)" /><input id="mcp-command" placeholder="Command (stdio)" /><input id="mcp-args" placeholder='Args JSON e.g. ["-y","pkg"]' /></div>
    <div class="row"><input id="mcp-env" placeholder='Env JSON e.g. {"TOKEN":"..."}' /><input id="mcp-headers" placeholder='Headers JSON e.g. {"Authorization":"Bearer ..."}' /><label><input id="mcp-enabled" type="checkbox" checked /> enabled</label></div>
    <div class="row"><button id="mcp-manual-add">Add MCP</button></div>
    <h2>JSON Import</h2>
    <textarea id="mcp-json" rows="5" placeholder='{"mcpServers":{"example":{"command":"npx","args":["-y","@modelcontextprotocol/server-everything"]}}}'></textarea>
    <button id="mcp-import">Preview & Install</button>
    <h2>Servers</h2>
    <table>
      <thead><tr><th>Name</th><th>Transport</th><th>Endpoint</th><th>Status</th><th>Tools</th><th>Actions</th></tr></thead>
      <tbody>
        ${servers.map((s) => `<tr>
          <td>${escapeHtml(s.name)}</td>
          <td>${escapeHtml(s.transport)}</td>
          <td>${escapeHtml(s.url || s.command || "")}</td>
          <td>${escapeHtml(s.connectionStatus)}</td>
          <td>${s.toolCount}</td>
          <td>
            <button data-mcp-toggle="${escapeHtml(s.name)}">${s.enabled ? "Disable" : "Enable"}</button>
            <button data-mcp-test="${escapeHtml(s.name)}">Test</button>
            <button data-mcp-tools="${escapeHtml(s.name)}">Tools</button>
            <button data-mcp-delete="${escapeHtml(s.name)}">Delete</button>
          </td>
        </tr>`).join("")}
      </tbody>
    </table>
    <pre id="mcp-result"></pre>`;
}

function bindMcpEvents(): void {
  $("#mcp-manual-add")?.addEventListener("click", async () => {
    const parseOptionalJson = (value: string): Record<string, string> | undefined => {
      if (!value.trim()) return undefined;
      return JSON.parse(value) as Record<string, string>;
    };
    const name = ($("#mcp-name") as HTMLInputElement).value.trim();
    if (!name || !state.activeProfile) return;
    const transport = ($("#mcp-transport") as HTMLSelectElement).value as "stdio" | "streamable-http";
    const config: McpServerConfig = {
      name,
      transport,
      enabled: ($("#mcp-enabled") as HTMLInputElement).checked,
    };
    if (transport === "stdio") {
      config.command = ($("#mcp-command") as HTMLInputElement).value.trim() || undefined;
      config.args = ($("#mcp-args") as HTMLInputElement).value.trim()
        ? JSON.parse(($("#mcp-args") as HTMLInputElement).value.trim())
        : undefined;
      config.env = parseOptionalJson(($("#mcp-env") as HTMLInputElement).value);
    } else {
      config.url = ($("#mcp-url") as HTMLInputElement).value.trim() || undefined;
      config.headers = parseOptionalJson(($("#mcp-headers") as HTMLInputElement).value);
    }
    try {
      await call(window.beacon.mcpAdd(state.activeProfile, config));
      await renderCurrentPage();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), "error");
    }
  });

  $("#mcp-import")?.addEventListener("click", async () => {
    const text = ($("#mcp-json") as HTMLTextAreaElement).value;
    if (!state.activeProfile) return;
    try {
      const parsed = await call<{ servers: McpServerConfig[] }>(window.beacon.mcpImportJson(text));
      for (const server of parsed.servers) {
        await call(window.beacon.mcpAdd(state.activeProfile, server));
      }
      $("#mcp-result").textContent = `Installed ${parsed.servers.length} MCP server(s).`;
      await renderCurrentPage();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), "error");
    }
  });

  const withServer = async (name: string, fn: (s: McpServerView) => Promise<void>) => {
    if (!state.activeProfile) return;
    try {
      const servers = await call<McpServerView[]>(window.beacon.mcpList(state.activeProfile));
      const s = servers.find((x) => x.name === name);
      if (s) await fn(s);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), "error");
    }
  };

  document.querySelectorAll<HTMLButtonElement>("[data-mcp-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => withServer(btn.dataset.mcpToggle!, async (s) => {
      if (!state.activeProfile) return;
      await call(window.beacon.mcpSetEnabled(state.activeProfile, s.name, !s.enabled));
      await renderCurrentPage();
    }));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-mcp-test]").forEach((btn) => {
    btn.addEventListener("click", () => withServer(btn.dataset.mcpTest!, async (s) => {
      const result = await call<{ ok: boolean; toolCount: number; tools: string[]; error?: string }>(window.beacon.mcpTest(s));
      $("#mcp-result").textContent = result.ok
        ? `Connected, ${result.toolCount} tools: ${result.tools.join(", ")}`
        : `Failed: ${result.error}`;
    }));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-mcp-tools]").forEach((btn) => {
    btn.addEventListener("click", () => withServer(btn.dataset.mcpTools!, async (s) => {
      const tools = await call<string[]>(window.beacon.mcpTools(s));
      $("#mcp-result").textContent = tools.join("\n");
    }));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-mcp-delete]").forEach((btn) => {
    btn.addEventListener("click", () => withServer(btn.dataset.mcpDelete!, async (s) => {
      if (!state.activeProfile) return;
      if (!confirm(`Delete MCP server ${s.name}?`)) return;
      await call(window.beacon.mcpDelete(state.activeProfile, s.name));
      await renderCurrentPage();
    }));
  });
}

// ---------- Profiles ----------
async function profilesHtml(): Promise<string> {
  const profiles = await call<ProfileInfo[]>(window.beacon.listProfiles());
  return `
    <h1>Profiles</h1>
    <table>
      <thead><tr><th>Name</th><th>Active</th><th>Path</th><th>Plugins</th><th>MCP</th><th>Actions</th></tr></thead>
      <tbody>
        ${profiles.map((p) => `<tr>
          <td>${escapeHtml(p.name)}</td><td>${p.active ? "✅" : ""}</td>
          <td>${escapeHtml(p.path)}</td><td>${p.pluginCount}</td><td>${p.mcpCount}</td>
          <td><button data-profile-switch="${escapeHtml(p.name)}">Switch</button><button data-profile-open="${escapeHtml(p.path)}">Open</button></td>
        </tr>`).join("")}
      </tbody>
    </table>`;
}

function bindProfilesEvents(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-profile-switch]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.profileSwitch!;
      state.activeProfile = name;
      await call(window.beacon.stateSet({ ...(await call(window.beacon.stateGet())), activeProfile: name }));
      await refresh();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-profile-open]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await call(window.beacon.openPath(btn.dataset.profileOpen!));
    });
  });
}

// ---------- Doctor ----------
async function doctorHtml(): Promise<string> {
  return `<h1>Doctor</h1><button id="doctor-run">Run Doctor</button><div id="doctor-results"></div>`;
}

function bindDoctorEvents(): void {
  $("#doctor-run")?.addEventListener("click", async () => {
    try {
      const results = await call<CheckResult[]>(window.beacon.doctorRun(state.activeProfile, state.workspaceRoot));
      $("#doctor-results").innerHTML = results.map((r) => `<div class="check ${r.status}">
        <strong>${escapeHtml(r.status.toUpperCase())}</strong> ${escapeHtml(r.title)} — ${escapeHtml(r.message)}
        ${r.details ? `<pre>${escapeHtml(r.details)}</pre>` : ""}
      </div>`).join("");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), "error");
    }
  });
}

// ---------- Settings ----------
async function settingsHtml(): Promise<string> {
  const snapshots = await call<SnapshotRecord[]>(window.beacon.snapshotsList());
  const profiles = state.profiles;
  return `
    <h1>Settings</h1>
    <div class="row">
      <label>Active profile</label>
      <select id="settings-profile">${profiles.map((p) => `<option value="${escapeHtml(p.name)}" ${p.name === state.activeProfile ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}</select>
      <button id="settings-save-profile">Save</button>
    </div>
    <div class="row">
      <label>Workspace root</label>
      <input id="settings-workspace" value="${escapeHtml(state.workspaceRoot || "")}" placeholder="Path to project for project-scoped skills" />
      <button id="settings-save-workspace">Save</button>
    </div>
    <h2>Snapshots / Rollback</h2>
    <table>
      <thead><tr><th>Time</th><th>Action</th><th>Target</th><th>Profile</th><th></th></tr></thead>
      <tbody>
        ${snapshots.map((s) => `<tr><td>${escapeHtml(new Date(s.timestamp).toLocaleString())}</td><td>${escapeHtml(s.action)}</td><td>${escapeHtml(s.target)}</td><td>${escapeHtml(s.profile)}</td><td><button data-snapshot-restore="${escapeHtml(s.id)}">Restore</button></td></tr>`).join("")}
      </tbody>
    </table>`;
}

function bindSettingsEvents(): void {
  $("#settings-save-profile")?.addEventListener("click", async () => {
    const name = ($("#settings-profile") as HTMLSelectElement).value;
    state.activeProfile = name;
    await call(window.beacon.stateSet({ ...(await call(window.beacon.stateGet())), activeProfile: name }));
    await refresh();
  });
  $("#settings-save-workspace")?.addEventListener("click", async () => {
    const root = ($("#settings-workspace") as HTMLInputElement).value.trim();
    state.workspaceRoot = root || undefined;
    await call(window.beacon.stateSet({ ...(await call(window.beacon.stateGet())), workspaceRoot: state.workspaceRoot }));
    await refresh();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-snapshot-restore]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await call(window.beacon.snapshotsRestore(btn.dataset.snapshotRestore!));
        await renderCurrentPage();
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err), "error");
      }
    });
  });
}

// ---------- Marketplace ----------
async function marketplaceHtml(): Promise<string> {
  return `
    <h1>Plugin Marketplace</h1>
    <div class="row">
      <input id="marketplace-query" placeholder="Search plugins" />
      <button id="marketplace-search">Search</button>
    </div>
    <div id="marketplace-results"></div>`;
}

function bindMarketplaceEvents(): void {
  const load = async (query: string) => {
    const plugins = await call<MarketplacePlugin[]>(window.beacon.marketplaceSearch(query));
    $("#marketplace-results").innerHTML = plugins.map((p) => `<div class="card">
      <div><strong>${escapeHtml(p.name)}</strong> <small>${escapeHtml(p.version)}</small></div>
      <div>${escapeHtml(p.description)}</div>
      <button data-marketplace-install="${escapeHtml(p.id)}">Install</button>
    </div>`).join("");
    document.querySelectorAll<HTMLButtonElement>("[data-marketplace-install]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!state.activeProfile) return;
        try {
          setStatus(await call<string>(window.beacon.marketplaceInstall(state.activeProfile, btn.dataset.marketplaceInstall!)), "ok");
          await renderCurrentPage();
        } catch (err) {
          setStatus(err instanceof Error ? err.message : String(err), "error");
        }
      });
    });
  };
  $("#marketplace-search")?.addEventListener("click", async () => {
    await load(($("#marketplace-query") as HTMLInputElement).value);
  });
  void load("");
}

// ---------- Boot ----------
window.addEventListener("hashchange", () => {
  void renderCurrentPage();
});
window.addEventListener("DOMContentLoaded", () => {
  void refresh();
});
