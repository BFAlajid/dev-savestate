import { Command } from "commander";
import readline from "node:readline/promises";
import { findProjectRoot } from "../lib/git.js";
import {
  ensureSavestateDir,
  acquireLock,
  stateExists,
  deleteState,
  validateStateName,
  resolveStateDir,
} from "../lib/storage.js";

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(`${question} [y/N]: `);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

export const deleteCommand = new Command("delete")
  .description("Delete a save state")
  .argument("<name>", "Name of the save state to delete")
  .option("-f, --force", "Skip confirmation")
  .action(async (name: string, opts: { force?: boolean }) => {
    let release: (() => Promise<void>) | null = null;

    try {
      // Validate name
      const nameCheck = validateStateName(name);
      if (!nameCheck.valid) {
        console.error(`Error: ${nameCheck.reason}`);
        process.exitCode = 1;
        return;
      }

      const projectRoot = await findProjectRoot(process.cwd());
      await ensureSavestateDir(projectRoot);
      resolveStateDir(projectRoot, name); // validate + traversal guard

      if (!(await stateExists(projectRoot, name))) {
        console.error(`State '${name}' not found.`);
        process.exitCode = 1;
        return;
      }

      if (!opts.force) {
        const yes = await confirm(
          `Delete state '${name}'? This cannot be undone.`
        );
        if (!yes) {
          console.log("Cancelled.");
          return;
        }
      }

      release = await acquireLock(projectRoot);
      await deleteState(projectRoot, name);
      console.log(`Deleted: ${name}`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    } finally {
      if (release) await release();
    }
  });
