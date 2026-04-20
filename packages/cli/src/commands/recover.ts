import { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { findProjectRoot } from "../lib/git.js";
import { ensureSavestateDir, readState } from "../lib/storage.js";
import { formatRelativeTime } from "../lib/display.js";

interface ActiveHeartbeat {
  stateName: string;
  lastHeartbeat: string;
  pid: number;
}

export function activeHeartbeatPath(projectRoot: string): string {
  return path.join(projectRoot, ".savestate", "_active.json");
}

export async function writeHeartbeat(projectRoot: string, stateName: string): Promise<void> {
  const heartbeat: ActiveHeartbeat = {
    stateName,
    lastHeartbeat: new Date().toISOString(),
    pid: process.pid,
  };
  await writeFileAtomic(activeHeartbeatPath(projectRoot), JSON.stringify(heartbeat, null, 2) + "\n");
}

export async function clearHeartbeat(projectRoot: string): Promise<void> {
  try { await fs.unlink(activeHeartbeatPath(projectRoot)); } catch {}
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export const recoverCommand = new Command("recover")
  .description("Recover from a crash — restore last active state")
  .option("--clear", "Clear stale heartbeat without recovering")
  .action(async (opts: { clear?: boolean }) => {
    try {
      const projectRoot = await findProjectRoot(process.cwd());
      await ensureSavestateDir(projectRoot);

      const p = activeHeartbeatPath(projectRoot);
      let raw: string;
      try { raw = await fs.readFile(p, "utf-8"); } catch {
        console.log("No crash detected. Everything looks clean.");
        return;
      }

      const heartbeat: ActiveHeartbeat = JSON.parse(raw);

      if (opts.clear) {
        await clearHeartbeat(projectRoot);
        console.log("Heartbeat cleared.");
        return;
      }

      if (isPidAlive(heartbeat.pid)) {
        console.log(`Session is still active (PID ${heartbeat.pid}, state: ${heartbeat.stateName}).`);
        return;
      }

      console.log(`Crash detected — last active state: ${heartbeat.stateName} (${formatRelativeTime(heartbeat.lastHeartbeat)})`);
      try {
        const state = await readState(projectRoot, heartbeat.stateName);
        console.log(`  Branch: ${state.git.branch}`);
        if (state.note) console.log(`  Note:   ${state.note.slice(0, 60)}`);
      } catch { console.log("  (state data not readable)"); }

      console.log(`\nTo restore, run: dvs load ${heartbeat.stateName}`);
      console.log("To dismiss, run: dvs recover --clear");
      await clearHeartbeat(projectRoot);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    }
  });
