import { readdir, readFile, mkdir, rm, copyFile, stat } from "node:fs/promises";
import { join, basename, extname, resolve } from "node:path";
import { homedir } from "node:os";
import { dshHome } from "../core/paths";
import { SkillInfo } from "../core/types";
import { parseYamlFrontmatter, stringifyYamlFrontmatter } from "../core/yaml";

export interface SkillScanOptions {
  workspaceRoot?: string;
  agentsHome?: string;
}

export interface SkillRoot {
  scope: SkillInfo["scope"];
  rank: number;
  path: string;
}

function parseBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.toLowerCase();
    if (["true", "yes", "on", "1"].includes(v)) return true;
    if (["false", "no", "off", "0"].includes(v)) return false;
  }
  return undefined;
}

export function skillRoots(options: SkillScanOptions = {}): SkillRoot[] {
  const roots: SkillRoot[] = [];
  const ws = options.workspaceRoot ? resolve(options.workspaceRoot) : undefined;
  const agentsHome = options.agentsHome || join(homedir(), ".agents");
  if (ws) {
    roots.push({ scope: "project-dsh", rank: 100, path: join(ws, ".dsh", "skills") });
    roots.push({ scope: "project-agents", rank: 200, path: join(ws, ".agents", "skills") });
  }
  roots.push({ scope: "user-dsh", rank: 400, path: join(dshHome(), "skills") });
  roots.push({ scope: "user-agents", rank: 500, path: join(agentsHome, "skills") });
  return roots;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function scanRoot(root: SkillRoot): Promise<SkillInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(root.path);
  } catch {
    return [];
  }
  const out: SkillInfo[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const full = join(root.path, entry);
    const entryStat = await stat(full).catch(() => undefined);
    if (!entryStat) continue;

    if (entryStat.isDirectory()) {
      const skillMd = join(full, "SKILL.md");
      try {
        const text = await readFile(skillMd, "utf8");
        const parsed = parseYamlFrontmatter(text);
        const name = typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name : entry;
        out.push({
          name,
          description: typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description : "",
          scope: root.scope,
          rank: root.rank,
          path: skillMd,
          root: root.path,
          enabled: parseBool(parsed.frontmatter["disable-model-invocation"]) !== true,
          effective: true,
          shadowed: false,
          format: "bundle",
          whenToUse: typeof parsed.frontmatter.whenToUse === "string" ? parsed.frontmatter.whenToUse : undefined,
          frontmatter: parsed.frontmatter,
        });
      } catch {
        // not a skill bundle
      }
    } else if (extname(entry).toLowerCase() === ".md") {
      try {
        const text = await readFile(full, "utf8");
        const parsed = parseYamlFrontmatter(text);
        const name = typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name : basename(entry, ".md");
        out.push({
          name,
          description: typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description : "",
          scope: root.scope,
          rank: root.rank,
          path: full,
          root: root.path,
          enabled: parseBool(parsed.frontmatter["disable-model-invocation"]) !== true,
          effective: true,
          shadowed: false,
          format: "flat",
          whenToUse: typeof parsed.frontmatter.whenToUse === "string" ? parsed.frontmatter.whenToUse : undefined,
          frontmatter: parsed.frontmatter,
        });
      } catch {
        // skip unreadable markdown
      }
    }
  }
  return out;
}

export async function scanSkills(options: SkillScanOptions = {}): Promise<SkillInfo[]> {
  const roots = skillRoots(options);
  const all = (await Promise.all(roots.map(scanRoot))).flat();
  const grouped = new Map<string, SkillInfo[]>();
  for (const skill of all) {
    const list = grouped.get(skill.name) ?? [];
    list.push(skill);
    grouped.set(skill.name, list);
  }
  const result: SkillInfo[] = [];
  for (const [name, skills] of grouped) {
    skills.sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path));
    skills.forEach((skill, i) => {
      skill.effective = i === 0;
      skill.shadowed = i > 0;
    });
    result.push(...skills);
  }
  return result.sort((a, b) => a.name.localeCompare(b.name) || a.rank - b.rank);
}

export type SkillInstallScope = "workspace" | "user";

export async function installSkillFromLocal(sourcePath: string, scope: SkillInstallScope, workspaceRoot?: string): Promise<string> {
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isDirectory()) throw new Error("Local skill must be a directory containing SKILL.md");
  const text = await readFile(join(sourcePath, "SKILL.md"), "utf8");
  const parsed = parseYamlFrontmatter(text);
  const name = typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name : basename(sourcePath);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("Skill name must be kebab-case");

  let targetRoot: string;
  if (scope === "user") {
    targetRoot = join(dshHome(), "skills");
  } else if (workspaceRoot) {
    targetRoot = join(workspaceRoot, ".dsh", "skills");
  } else {
    throw new Error("workspaceRoot is required when installing into workspace scope");
  }
  await mkdir(targetRoot, { recursive: true });
  const target = join(targetRoot, name);
  await rm(target, { recursive: true, force: true });
  await copyDir(sourcePath, target);
  return target;
}

async function copyDir(src: string, dest: string): Promise<void> {
  const entries = await readdir(src);
  await mkdir(dest, { recursive: true });
  for (const entry of entries) {
    if (entry === ".git") continue;
    const s = join(src, entry);
    const d = join(dest, entry);
    const st = await stat(s);
    if (st.isDirectory()) await copyDir(s, d);
    else await copyFile(s, d);
  }
}

export async function installSkillFromGitHub(repoUrl: string, scope: SkillInstallScope, workspaceRoot?: string): Promise<string> {
  const tmp = join(dshHome(), "beacon", "tmp", `skill-${Date.now()}`);
  await mkdir(tmp, { recursive: true });
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    await execFileAsync("git", ["clone", "--depth", "1", repoUrl, tmp], { timeout: 120000 });
    return await installSkillFromLocal(tmp, scope, workspaceRoot);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function deleteSkill(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export async function setSkillEnabled(path: string, enabled: boolean): Promise<void> {
  const isBundle = (await stat(path)).isDirectory() || path.endsWith("SKILL.md");
  const filePath = isBundle && path.endsWith("SKILL.md") ? path : path;
  const text = await readFile(filePath, "utf8");
  const parsed = parseYamlFrontmatter(text);
  if (enabled) delete parsed.frontmatter["disable-model-invocation"];
  else parsed.frontmatter["disable-model-invocation"] = true;
  await import("node:fs/promises").then((fs) => fs.writeFile(filePath, stringifyYamlFrontmatter(parsed.frontmatter, parsed.body), "utf8"));
}

export async function readSkillMd(path: string): Promise<string> {
  return readFile(path, "utf8");
}
