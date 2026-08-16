import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { beaconStateDir, snapshotsFile } from "./paths";
import { SnapshotRecord } from "./types";

const KEEP = 10;

export async function loadSnapshots(): Promise<SnapshotRecord[]> {
  try {
    const text = await readFile(snapshotsFile(), "utf8");
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function addSnapshot(record: Omit<SnapshotRecord, "id" | "timestamp">): Promise<SnapshotRecord> {
  const snapshots = await loadSnapshots();
  const snapshot: SnapshotRecord = {
    ...record,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
  };
  snapshots.unshift(snapshot);
  const trimmed = snapshots.slice(0, KEEP);
  await mkdir(beaconStateDir(), { recursive: true });
  await writeFile(snapshotsFile(), JSON.stringify(trimmed, null, 2) + "\n", "utf8");
  return snapshot;
}

export async function backupFile(sourcePath: string): Promise<string> {
  await mkdir(join(beaconStateDir(), "backups"), { recursive: true });
  const backupPath = join(beaconStateDir(), "backups", `${Date.now()}-${randomUUID()}.bak`);
  await mkdir(dirname(backupPath), { recursive: true });
  await copyFile(sourcePath, backupPath);
  return backupPath;
}

export async function restoreSnapshot(id: string): Promise<SnapshotRecord> {
  const snapshots = await loadSnapshots();
  const snapshot = snapshots.find((s) => s.id === id);
  if (!snapshot) throw new Error(`Snapshot not found: ${id}`);
  if (!snapshot.targetPath) throw new Error("Snapshot has no target path");
  await mkdir(dirname(snapshot.targetPath), { recursive: true });
  await copyFile(snapshot.backupPath, snapshot.targetPath);
  const updated = snapshots.map((s) =>
    s.id === id ? { ...s, restoredAt: new Date().toISOString() } : s,
  );
  await writeFile(snapshotsFile(), JSON.stringify(updated, null, 2) + "\n", "utf8");
  return { ...snapshot, restoredAt: new Date().toISOString() };
}
