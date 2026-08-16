import { readFile, writeFile, rename, mkdir, copyFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, extname, join } from "node:path";
import YAML from "yaml";
import { backupFile, addSnapshot } from "./snapshots";

export interface ConfigTransactionOptions<T> {
  filePath: string;
  action: string;
  target: string;
  profile: string;
  mutate: (current: T) => T | Promise<T>;
  validate?: (next: T) => void | Promise<void>;
  healthCheck?: (text: string) => void | Promise<void>;
}

export function parseConfigText<T = unknown>(text: string, filePath: string): T {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".json") return JSON.parse(text) as T;
  if (ext === ".yml" || ext === ".yaml") return YAML.parse(text) as T;
  throw new Error(`Unsupported config extension: ${ext}`);
}

export function stringifyConfigText(value: unknown, filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".json") return JSON.stringify(value, null, 2) + "\n";
  if (ext === ".yml" || ext === ".yaml") return YAML.stringify(value, { lineWidth: 0 });
  throw new Error(`Unsupported config extension: ${ext}`);
}

export async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = join(dirname(filePath), `.beacon-${randomUUID()}.tmp`);
  await writeFile(tmp, content, "utf8");
  try {
    await rename(tmp, filePath);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export async function runConfigTransaction<T>(options: ConfigTransactionOptions<T>): Promise<{
  backupPath: string;
  snapshotId: string;
  newText: string;
}> {
  const { filePath, action, target, profile, mutate, validate, healthCheck } = options;
  const originalText = await readFile(filePath, "utf8").catch(() => undefined);
  if (originalText === undefined) throw new Error(`File not found: ${filePath}`);

  const backupPath = await backupFile(filePath);
  const current = parseConfigText<T>(originalText, filePath);
  const next = await mutate(current);
  if (validate) await validate(next);

  const newText = stringifyConfigText(next, filePath);
  await atomicWrite(filePath, newText);

  if (healthCheck) {
    try {
      await healthCheck(newText);
    } catch (err) {
      await copyFile(backupPath, filePath);
      throw err;
    }
  }

  const snapshot = await addSnapshot({
    action,
    target,
    profile,
    backupPath,
    targetPath: filePath,
  });

  return { backupPath, snapshotId: snapshot.id, newText };
}
