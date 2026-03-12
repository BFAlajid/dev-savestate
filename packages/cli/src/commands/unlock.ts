import { Command } from "commander";
import fs from "node:fs/promises";
import { findProjectRoot } from "../lib/git.js";
import { lockPath } from "../lib/paths.js";

export const unlockCommand = new Command("unlock")
  .description("Force-remove a stale lock")
  .action(async () => {
    try {
      const projectRoot = await findProjectRoot(process.cwd());
      const lp = lockPath(projectRoot);
      try { await fs.access(lp); } catch {
        console.log("No lock exists.");
        return;
      }
      await fs.rm(lp, { recursive: true, force: true });
      console.log("Lock removed.");
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    }
  });
