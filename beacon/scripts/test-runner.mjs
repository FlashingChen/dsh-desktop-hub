#!/usr/bin/env node
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dist = (...parts) => join(process.cwd(), "dist", ...parts);

const args = process.argv.slice(2);
const only = new Set(args.filter((a) => a.startsWith("--")).map((a) => a.slice(2)));

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

function want(name) {
  return only.size === 0 || only.has(name);
}

async function withTempHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-beacon-test-"));
  const old = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (old === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = old;
    await rm(dir, { recursive: true, force: true });
  }
}

async function testSkeleton() {
  const fs = await import("node:fs");
  for (const f of [
    "package.json",
    "tsconfig.json",
    "assets/renderer/index.html",
    "dist/main/main.js",
    "dist/preload/preload.js",
    "dist/renderer/renderer.js",
  ]) {
    assert(fs.existsSync(f), `skeleton file exists: ${f}`);
  }
  console.log("PASS skeleton");
}

async function testEnv() {
  await withTempHome(async (home) => {
    await mkdir(join(home, "profiles", "web"), { recursive: true });
    await writeFile(
      join(home, "profiles", "web", "package.json"),
      JSON.stringify({ name: "dsh-profile-web", dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } }),
    );
    const { listProfiles } = await import(dist("core/profiles.js"));
    const profiles = await listProfiles("web");
    assert(profiles.length === 1, "one profile discovered");
    assert(profiles[0].name === "web", "profile name");
    assert(profiles[0].active === true, "active flag set");
    const { detectEnvironment } = await import(dist("core/env.js"));
    const env = await detectEnvironment();
    assert(env.dshHome === home, "dshHome honors DSH_HOME");
    assert(env.profiles[0]?.name === "web", "env profiles discovered");
    console.log("PASS env");
  });
}

async function testTransaction() {
  await withTempHome(async (home) => {
    const file = join(home, "config.json");
    await mkdir(home, { recursive: true });
    await writeFile(file, JSON.stringify({ count: 1 }));
    const { runConfigTransaction } = await import(dist("core/transaction.js"));
    const { loadSnapshots } = await import(dist("core/snapshots.js"));
    const result = await runConfigTransaction({
      filePath: file,
      action: "increment",
      target: "config",
      profile: "test",
      mutate: (current) => ({ count: current.count + 1 }),
    });
    const parsed = JSON.parse(await readFile(file, "utf8"));
    assert(parsed.count === 2, "transaction wrote new value");
    assert(result.backupPath, "backup path returned");
    const snapshots = await loadSnapshots();
    assert(snapshots.length === 1, "snapshot recorded");
    assert(snapshots[0].action === "increment", "snapshot action");
    const { restoreSnapshot } = await import(dist("core/snapshots.js"));
    await restoreSnapshot(snapshots[0].id);
    const restored = JSON.parse(await readFile(file, "utf8"));
    assert(restored.count === 1, "rollback restored original");
    console.log("PASS transaction");
  });
}

async function testMcp() {
  await withTempHome(async (home) => {
    const profileDir = join(home, "profiles", "web");
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, "cordis.patch.yml"), "# test\n[]\n");
    const mcp = await import(dist("mcp/manager.js"));
    const parsed = mcp.parseMcpJsonImport(
      JSON.stringify({
        mcpServers: {
          example: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] },
        },
      }),
    );
    assert(parsed.servers[0].name === "example", "import name");
    assert(parsed.servers[0].transport === "stdio", "import transport");
    await mcp.addMcpServer("web", parsed.servers[0]);
    const list = await mcp.readMcpServers("web");
    assert(list.length === 1, "mcp added");
    assert(list[0].name === "example", "mcp name");
    await mcp.deleteMcpServer("web", "example");
    assert((await mcp.readMcpServers("web")).length === 0, "mcp deleted");
    const snapshots = await import(dist("core/snapshots.js")).then((m) => m.loadSnapshots());
    assert(snapshots.length >= 2, "mcp writes snapshots");
    console.log("PASS mcp");
  });
}

async function testSkills() {
  await withTempHome(async (home) => {
    // project root with .dsh/skills and user root ~/.dsh/skills
    const project = join(home, "project");
    await mkdir(join(project, ".dsh", "skills", "demo"), { recursive: true });
    await writeFile(
      join(project, ".dsh", "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: project demo\n---\nBody\n",
    );
    await mkdir(join(home, "skills", "demo"), { recursive: true });
    await writeFile(
      join(home, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: user demo\n---\nBody\n",
    );
    const { scanSkills } = await import(dist("skills/manager.js"));
    const skills = await scanSkills({ workspaceRoot: project, agentsHome: join(home, ".agents") });
    assert(skills.length === 2, "two demo skills found");
    const projectSkill = skills.find((s) => s.scope === "project-dsh");
    const userSkill = skills.find((s) => s.scope === "user-dsh");
    assert(projectSkill?.effective === true, "project skill is effective");
    assert(userSkill?.shadowed === true, "user skill is shadowed");
    console.log("PASS skills");
  });
}

async function testPlugins() {
  await withTempHome(async (home) => {
    const profileDir = join(home, "profiles", "web");
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      join(profileDir, "package.json"),
      JSON.stringify({
        name: "dsh-profile-web",
        dependencies: { "@deepseek-ai/dsh-base": "^0.1.0", "@dsh-external/extra": "link:../extra" },
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
      }),
    );
    const { listPlugins } = await import(dist("plugins/manager.js"));
    const plugins = await listPlugins("web");
    assert(plugins.length === 2, "two plugins listed");
    assert(plugins.find((p) => p.name === "@deepseek-ai/dsh-base")?.enabled === true, "base enabled");
    assert(plugins.find((p) => p.name === "@dsh-external/extra")?.enabled === false, "extra disabled");
    console.log("PASS plugins");
  });
}

async function testDoctor() {
  await withTempHome(async (home) => {
    await mkdir(join(home, "profiles", "web"), { recursive: true });
    await writeFile(join(home, "profiles", "web", "package.json"), "{}");
    await writeFile(join(home, "profiles", "web", "cordis.patch.yml"), "[]\n");
    const { runDoctor } = await import(dist("doctor/doctor.js"));
    const results = await runDoctor({ profile: "web" });
    assert(Array.isArray(results), "doctor returns array");
    assert(results.every((r) => ["ok", "warning", "error"].includes(r.status)), "status valid");
    assert(results.some((r) => r.title === "DSH installed"), "DSH check present");
    console.log("PASS doctor");
  });
}

async function testMarketplace() {
  const { createRegistry } = await import(dist("marketplace/registry.js"));
  const registry = createRegistry();
  const all = await registry.search("");
  assert(all.length >= 3, "static registry has entries");
  const found = await registry.get(all[0].id);
  assert(found?.id === all[0].id, "get by id");
  console.log("PASS marketplace");
}

async function testUi() {
  const fs = await import("node:fs");
  const html = fs.readFileSync("assets/renderer/index.html", "utf8");
  assert(html.includes("data-page"), "nav data-page present");
  assert(html.includes("../../dist/renderer/renderer.js"), "renderer script path");
  const preload = fs.readFileSync("dist/preload/preload.js", "utf8");
  assert(preload.includes("contextBridge"), "preload uses contextBridge");
  const main = fs.readFileSync("dist/main/main.js", "utf8");
  assert(main.includes("ipcMain.handle"), "main registers ipc handlers");
  console.log("PASS ui");
}

const tests = [
  ["skeleton", testSkeleton],
  ["env", testEnv],
  ["transaction", testTransaction],
  ["mcp", testMcp],
  ["skills", testSkills],
  ["plugins", testPlugins],
  ["doctor", testDoctor],
  ["marketplace", testMarketplace],
  ["ui", testUi],
];

let failed = 0;
for (const [name, fn] of tests) {
  if (!want(name)) continue;
  try {
    await fn();
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}: ${err.message}`);
  }
}
if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log(`\nAll requested tests passed (${only.size ? [...only].join(", ") : "all"})`);
