import { readdir, readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { profilesRoot, profilePath, profilePackageJson, profileCordisPatch } from "./paths";
import { ProfileInfo } from "./types";
import { isProfileDir } from "./env";
import { parsePatchYaml } from "./yaml";

export async function listProfiles(activeName?: string): Promise<ProfileInfo[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(profilesRoot(), { withFileTypes: true }).then((items) =>
      items.filter((item) => item.isDirectory() && isProfileDir(item.name)).map((item) => item.name),
    );
  } catch {
    entries = [];
  }

  const profiles = await Promise.all(entries.map((name) => readProfile(name, activeName)));
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

async function readProfile(name: string, activeName?: string): Promise<ProfileInfo> {
  const path = profilePath(name);
  let exists = true;
  try {
    await access(path, constants.R_OK);
  } catch {
    exists = false;
  }

  let bundles: string[] = [];
  let dependencies: Record<string, string> = {};
  try {
    const pkg = JSON.parse(await readFile(profilePackageJson(name), "utf8")) as {
      dependencies?: Record<string, string>;
      dsh?: { profile?: { bundles?: string[] } };
    };
    bundles = pkg.dsh?.profile?.bundles ?? [];
    dependencies = pkg.dependencies ?? {};
  } catch {
    bundles = [];
    dependencies = {};
  }

  let mcpCount = 0;
  try {
    const text = await readFile(profileCordisPatch(name), "utf8");
    mcpCount = parsePatchYaml(text).filter(
      (entry) => entry?.name === "@deepseek-ai/dsh-mcp-client",
    ).length;
  } catch {
    mcpCount = 0;
  }

  return {
    name,
    path,
    active: activeName === name,
    pluginCount: dependencies ? Object.keys(dependencies).length : 0,
    mcpCount,
    skillCount: 0,
    bundles,
    dependencies,
    exists,
  };
}

export async function profileExists(name: string): Promise<boolean> {
  try {
    await access(profilePath(name), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
