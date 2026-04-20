import fs from "node:fs/promises";
import path from "node:path";
import { SAVESTATE_DIR, INDEX_FILE, ACTIVE_FILE, STATES_DIR } from "../constants";
import type { IndexFile, SaveState, ActiveState } from "../types";

export async function readIndex(projectRoot: string): Promise<IndexFile> {
  const indexPath = path.join(projectRoot, SAVESTATE_DIR, INDEX_FILE);
  try {
    const raw = await fs.readFile(indexPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { version: 1, states: [] };
  }
}

export async function readState(
  projectRoot: string,
  name: string
): Promise<SaveState> {
  const statePath = path.join(
    projectRoot,
    SAVESTATE_DIR,
    STATES_DIR,
    name,
    "state.json"
  );
  const raw = await fs.readFile(statePath, "utf-8");
  return JSON.parse(raw);
}

export async function readActiveState(
  projectRoot: string
): Promise<ActiveState | null> {
  const activePath = path.join(projectRoot, SAVESTATE_DIR, ACTIVE_FILE);
  try {
    const raw = await fs.readFile(activePath, "utf-8");
    const active: ActiveState = JSON.parse(raw);
    // Check staleness: if last heartbeat is more than 24h old, ignore
    const lastHeartbeat = new Date(active.lastHeartbeat).getTime();
    if (Date.now() - lastHeartbeat > 24 * 60 * 60 * 1000) return null;
    return active;
  } catch {
    return null;
  }
}

export function getIndexPath(projectRoot: string): string {
  return path.join(projectRoot, SAVESTATE_DIR, INDEX_FILE);
}

export function getActivePath(projectRoot: string): string {
  return path.join(projectRoot, SAVESTATE_DIR, ACTIVE_FILE);
}
