import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { CheckResult, ProfileInfo } from "../core/types";
import { detectEnvironment } from "../core/env";
import { parsePatchYaml } from "../core/yaml";
import { scanSkills } from "../skills/manager";
import { readMcpServers } from "../mcp/manager";
import { dshHome, profileCordisPatch, profilePackageJson } from "../core/paths";

const execFileAsync = promisify(execFile);

export interface DoctorOptions {
  profile?: string;
  workspaceRoot?: string;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<CheckResult[]> {
  const env = await detectEnvironment();
  const profile = options.profile || env.activeProfile;
  const checks: CheckResult[] = [];

  // DSH
  if (!env.installed) {
    checks.push({
      status: "error",
      title: "DSH installed",
      message: "DSH CLI was not found on PATH",
      details: "Run `npm i -g @deepseek-ai/dsh` or install DeepSeek Harness.",
    });
  } else {
    checks.push({
      status: "ok",
      title: "DSH installed",
      message: `Found dsh at ${env.dshPath}`,
      details: `Version: ${env.version}`,
    });
  }

  // Runtime / config boot
  if (env.installed && profile) {
    try {
      const { stdout } = await execFileAsync("dsh", ["--profile", profile, "--dump-config"], {
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
      });
      checks.push({
        status: "ok",
        title: "DSH runtime / config boot",
        message: `Profile "${profile}" can compose its config`,
        details: `${stdout.split("\n").length} composed entries`,
      });
    } catch (err: any) {
      checks.push({
        status: "error",
        title: "DSH runtime / config boot",
        message: `Profile "${profile}" failed to compose`,
        details: err?.stderr || err?.message,
      });
    }
  } else {
    checks.push({
      status: env.installed ? "warning" : "error",
      title: "DSH runtime / config boot",
      message: "No active profile selected",
    });
  }

  // Profile
  const profiles: ProfileInfo[] = env.profiles;
  const activeProfile = profiles.find((p) => p.name === profile);
  if (!activeProfile) {
    checks.push({ status: "error", title: "Profile", message: `Profile "${profile}" does not exist` });
  } else if (!activeProfile.exists) {
    checks.push({ status: "error", title: "Profile", message: `Profile "${profile}" directory is missing` });
  } else {
    checks.push({
      status: "ok",
      title: "Profile",
      message: `Profile "${profile}" is readable`,
      details: `Plugins: ${activeProfile.pluginCount}, MCP: ${activeProfile.mcpCount}`,
    });
  }

  // Model config
  try {
    const settingsText = await readFile(join(dshHome(), "settings.yaml"), "utf8");
    const YAML = (await import("yaml")).default;
    const settings = YAML.parse(settingsText) as { "agent-default-model"?: { provider?: string; model?: string } };
    const model = settings?.["agent-default-model"];
    if (model?.provider && model.model) {
      checks.push({
        status: "ok",
        title: "Model config",
        message: `Default model: ${model.provider}/${model.model}`,
      });
    } else {
      checks.push({
        status: "warning",
        title: "Model config",
        message: "Default model is not fully configured in settings.yaml",
      });
    }
  } catch {
    checks.push({ status: "warning", title: "Model config", message: "settings.yaml not found or unreadable" });
  }

  // Plugins
  if (profile) {
    try {
      const pkg = JSON.parse(await readFile(profilePackageJson(profile), "utf8")) as {
        dependencies?: Record<string, string>;
        dsh?: { profile?: { bundles?: string[] } };
      };
      const deps = Object.keys(pkg.dependencies ?? {});
      const bundles = pkg.dsh?.profile?.bundles ?? [];
      const missing = bundles.filter((b) => !deps.includes(b));
      if (missing.length === 0) {
        checks.push({
          status: "ok",
          title: "Plugins",
          message: `${deps.length} dependencies, ${bundles.length} bundles`,
        });
      } else {
        checks.push({
          status: "error",
          title: "Plugins",
          message: "Some bundles are not declared as dependencies",
          details: missing.join(", "),
        });
      }
    } catch (err: any) {
      checks.push({ status: "error", title: "Plugins", message: "package.json unreadable", details: err.message });
    }
  }

  // Skills
  const skills = await scanSkills({ workspaceRoot: options.workspaceRoot });
  const shadowed = skills.filter((s) => s.shadowed);
  if (shadowed.length > 0) {
    checks.push({
      status: "warning",
      title: "Skills",
      message: `${skills.length} skills found, ${shadowed.length} shadowed`,
      details: shadowed.map((s) => `${s.name} @ ${s.path}`).join("\n"),
    });
  } else {
    checks.push({ status: "ok", title: "Skills", message: `${skills.length} skills found, no shadow conflicts` });
  }

  // MCP
  if (profile) {
    const mcpServers = await readMcpServers(profile);
    const invalid = mcpServers.filter((s) => (s.transport === "stdio" && !s.command) || (s.transport === "streamable-http" && !s.url));
    if (invalid.length > 0) {
      checks.push({
        status: "error",
        title: "MCP",
        message: `${invalid.length} MCP server(s) missing required fields`,
        details: invalid.map((s) => s.name).join(", "),
      });
    } else {
      checks.push({ status: "ok", title: "MCP", message: `${mcpServers.length} MCP server(s) configured` });
    }
  }

  // Config syntax
  if (profile) {
    try {
      const patch = await readFile(profileCordisPatch(profile), "utf8");
      const parsed = parsePatchYaml(patch);
      if (!Array.isArray(parsed)) throw new Error("cordis.patch.yml root must be an array");
      checks.push({ status: "ok", title: "Config syntax", message: "cordis.patch.yml parses as YAML array" });
    } catch (err: any) {
      checks.push({ status: "error", title: "Config syntax", message: "cordis.patch.yml is invalid", details: err.message });
    }
  }

  // Filesystem
  try {
    await access(dshHome(), constants.R_OK);
    checks.push({ status: "ok", title: "Filesystem", message: `${dshHome()} is readable` });
  } catch {
    checks.push({ status: "error", title: "Filesystem", message: `${dshHome()} is not accessible` });
  }

  return checks;
}
