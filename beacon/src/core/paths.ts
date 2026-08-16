import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

export function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

export function profilesRoot(): string {
  return join(dshHome(), "profiles");
}

export function profilePath(name: string): string {
  return join(profilesRoot(), name);
}

export function profileCordisPatch(name: string): string {
  return join(profilePath(name), "cordis.patch.yml");
}

export function profilePackageJson(name: string): string {
  return join(profilePath(name), "package.json");
}

export function beaconStateDir(): string {
  return join(dshHome(), "beacon");
}

export function snapshotsFile(): string {
  return join(beaconStateDir(), "snapshots.json");
}

export function appStateFile(): string {
  return join(beaconStateDir(), "state.json");
}

export function projectRoot(cwd = process.cwd()): string | undefined {
  let current = resolve(cwd);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = resolve(current, "..");
    if (parent === current) return undefined;
    current = parent;
  }
}
