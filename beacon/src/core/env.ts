import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { dshHome, profilesRoot, appStateFile, beaconStateDir } from "./paths";
import { DshEnvironment, AppState } from "./types";
import { listProfiles } from "./profiles";

const execFileAsync = promisify(execFile);

export async function isInstalled(): Promise<boolean> {
  try {
    await execFileAsync("dsh", ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function dshVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("dsh", ["--version"], { timeout: 5000 });
    return stdout.trim().split(/\r?\n/)[0] || undefined;
  } catch {
    return undefined;
  }
}

export async function dshPath(): Promise<string | undefined> {
  const command = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(command, ["dsh"], { timeout: 5000 });
    return stdout.trim().split(/\r?\n/)[0] || undefined;
  } catch {
    return undefined;
  }
}

export async function loadAppState(): Promise<AppState> {
  try {
    const text = await readFile(appStateFile(), "utf8");
    const parsed = JSON.parse(text) as Partial<AppState>;
    return {
      activeProfile: parsed.activeProfile,
      workspaceRoot: parsed.workspaceRoot,
    };
  } catch {
    return {};
  }
}

export async function saveAppState(state: AppState): Promise<void> {
  await mkdir(beaconStateDir(), { recursive: true });
  await writeFile(appStateFile(), JSON.stringify(state, null, 2) + "\n", "utf8");
}

export async function detectEnvironment(): Promise<DshEnvironment> {
  const home = dshHome();
  const [installed, version, dshPathValue, state] = await Promise.all([
    isInstalled(),
    dshVersion(),
    dshPath(),
    loadAppState(),
  ]);

  let activeProfile = process.env.DSH_PROFILE || state.activeProfile;
  const profiles = await listProfiles();
  if (!activeProfile || !profiles.some((p) => p.name === activeProfile)) {
    activeProfile = profiles.find((p) => p.name === "web")?.name ?? profiles[0]?.name;
  }
  const runtimeStatus: DshEnvironment["runtimeStatus"] = installed ? "unknown" : "error";

  const profilesRootValue = profilesRoot();
  let profilesRootExists = false;
  try {
    await access(profilesRootValue, constants.R_OK);
    profilesRootExists = true;
  } catch {
    profilesRootExists = false;
  }

  return {
    installed,
    dshPath: dshPathValue,
    version,
    dshHome: home,
    profilesRoot: profilesRootValue,
    profiles,
    activeProfile,
    runtimeStatus: profilesRootExists ? runtimeStatus : "error",
  };
}

export async function ensureStateDir(): Promise<string> {
  await mkdir(beaconStateDir(), { recursive: true });
  return beaconStateDir();
}

export function isProfileDir(name: string): boolean {
  // Skip non-profile files/dirs that commonly appear in ~/.dsh/profiles.
  return !name.startsWith(".") && !name.includes("node_modules");
}
