import { Command } from "commander";
import fs from "node:fs/promises";
import { findProjectRoot } from "../lib/git.js";
import { lockPath } from "../lib/paths.js";
import { lockPidPath } from "../lib/storage.js";

/**
 * Try to read the PID of the process that last acquired the lock.
 * We write a `lock.pid` file next to the proper-lockfile lock directory
 * on acquire; if that file is present and parseable, we use it to decide
 * whether the lock holder is still alive.
 */
async function readLockHolderPid(projectRoot: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(lockPidPath(projectRoot), "utf-8");
    const pid = parseInt(raw.trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // ESRCH => process does not exist. Anything else (EPERM, EINVAL)
    // conservatively means "can't tell" — treat as alive and force-required.
    if (err && err.code === "ESRCH") return false;
    return true;
  }
}

export const unlockCommand = new Command("unlock")
  .description("Force-remove a stale lock (only if the holder is gone)")
  .option("-f, --force", "Remove the lock even if the holder is still running")
  .action(async (opts: { force?: boolean }) => {
    try {
      const projectRoot = await findProjectRoot(process.cwd());
      const lp = lockPath(projectRoot);
      try {
        await fs.access(lp);
      } catch {
        // Lock directory absent — also clean up any stray PID marker.
        try { await fs.unlink(lockPidPath(projectRoot)); } catch {}
        console.log("No lock exists.");
        return;
      }

      const pid = await readLockHolderPid(projectRoot);
      if (pid === null) {
        if (!opts.force) {
          console.error(
            "Could not verify lock holder; pass --force to remove anyway."
          );
          process.exitCode = 1;
          return;
        }
        // --force: proceed.
      } else if (isPidAlive(pid)) {
        if (!opts.force) {
          console.error(
            `Lock is held by a live process (PID ${pid}). Investigate before removing.`
          );
          console.error("If you are sure it is stale, pass --force.");
          process.exitCode = 1;
          return;
        }
        console.warn(`--force: removing lock despite live PID ${pid}.`);
      }
      // Either PID was dead, or --force was passed.

      await fs.rm(lp, { recursive: true, force: true });
      try { await fs.unlink(lockPidPath(projectRoot)); } catch {}
      console.log("Lock removed.");
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    }
  });
