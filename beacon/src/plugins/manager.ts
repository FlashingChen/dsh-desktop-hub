import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { profilePackageJson, profilePath } from "../core/paths";
import { PluginInfo } from "../core/types";
import { runConfigTransaction } from "../core/transaction";

const execFileAsync = promisify(execFile);

interface ProfilePackage {
  dependencies?: Record<string, string>;
  dsh?: { profile?: { bundles?: string[] } };
}

async function readPackage(profile: string): Promise<ProfilePackage> {
  try {
    return JSON.parse(await readFile(profilePackageJson(profile), "utf8")) as ProfilePackage;
  } catch {
    return {};
  }
}

export async function listPlugins(profile: string): Promise<PluginInfo[]> {
  const pkg = await readPackage(profile);
  const deps = pkg.dependencies ?? {};
  const bundles = pkg.dsh?.profile?.bundles ?? [];
  return Object.entries(deps).map(([name, spec]) => ({
    name,
    version: spec.startsWith("link:") || spec.startsWith("file:") ? spec : spec.replace(/^[~^]/, ""),
    source: spec,
    profile,
    enabled: bundles.includes(name),
    updateAvailable: false,
    bundle: bundles.includes(name),
  }));
}

async function runDshPlugin(profile: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("dsh", ["plugin", "--profile", profile, ...args], {
      cwd: profilePath(profile),
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout + stderr;
  } catch (err: any) {
    throw new Error(`dsh plugin failed: ${err?.stderr || err?.message}`);
  }
}

async function updateBundles(profile: string, mutate: (bundles: string[]) => string[]): Promise<void> {
  const filePath = profilePackageJson(profile);
  await runConfigTransaction<ProfilePackage>({
    filePath,
    action: "Update plugin bundles",
    target: `profile:${profile}`,
    profile,
    mutate: (current) => ({
      ...current,
      dsh: {
        ...(current.dsh ?? {}),
        profile: {
          ...(current.dsh?.profile ?? {}),
          bundles: mutate(current.dsh?.profile?.bundles ?? []),
        },
      },
    }),
    validate: (next) => {
      if (!Array.isArray(next.dsh?.profile?.bundles)) throw new Error("bundles must be an array");
    },
  });
}

export async function installPlugin(profile: string, spec: string): Promise<string> {
  const output = await runDshPlugin(profile, ["add", spec]);
  const name = spec.split("@")[0];
  const pkg = await readPackage(profile);
  const bundles = pkg.dsh?.profile?.bundles ?? [];
  if (!bundles.includes(name)) {
    await updateBundles(profile, (current) => [...current, name]);
  }
  return output;
}

export async function removePlugin(profile: string, name: string): Promise<string> {
  await updateBundles(profile, (current) => current.filter((b) => b !== name));
  return runDshPlugin(profile, ["remove", name]);
}

export async function updatePlugin(profile: string, name: string): Promise<string> {
  return runDshPlugin(profile, ["update", name]);
}

export async function updateAllPlugins(profile: string): Promise<string> {
  return runDshPlugin(profile, ["update"]);
}

export async function setPluginEnabled(profile: string, name: string, enabled: boolean): Promise<void> {
  const pkg = await readPackage(profile);
  const bundles = pkg.dsh?.profile?.bundles ?? [];
  if (enabled && !bundles.includes(name)) {
    await updateBundles(profile, (current) => [...current, name]);
  } else if (!enabled && bundles.includes(name)) {
    await updateBundles(profile, (current) => current.filter((b) => b !== name));
  }
}
