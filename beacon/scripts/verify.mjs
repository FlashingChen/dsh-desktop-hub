#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const testArgs = process.argv.slice(2).filter((a) => a.startsWith("--")).join(" ");
const commands = [
  ["TypeScript typecheck", "npm run typecheck"],
  ["Build", "npm run build"],
  ["Test suite", `node scripts/test-runner.mjs ${testArgs}`.trim()],
];

for (const [label, cmd] of commands) {
  process.stdout.write(`\n▶ ${label}\n`);
  execSync(cmd, { cwd: root, stdio: "inherit" });
}

const required = [
  "dist/main/main.js",
  "dist/preload/preload.js",
  "dist/renderer/renderer.js",
  "assets/renderer/index.html",
];
for (const file of required) {
  if (!existsSync(join(root, file))) throw new Error(`Missing artifact: ${file}`);
}

console.log("\n✔ All verification steps passed.");
