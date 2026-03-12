import { Command } from "commander";
import readline from "node:readline/promises";
import path from "node:path";
import {
  findProjectRoot,
  createGit,
  isDirty,
  getBranch,
  checkoutBranch,
  applyPatch,
  stashChanges,
} from "../lib/git.js";
import {
  acquireLock,
  readState,
  ensureSavestateDir,
  validateStateName,
} from "../lib/storage.js";
import { patchPath } from "../lib/paths.js";
import { printMentalStack } from "../lib/display.js";
import type { SaveState } from "../lib/types.js";
import writeFileAtomic from "write-file-atomic";
import { stateJsonPath } from "../lib/paths.js";

async function promptChoice(question: string, choices: string): Promise<string> {
  if (!process.stdin.isTTY) return "a"; // abort in non-interactive mode
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(`${question} [${choices}]: `);
    return answer.trim().toLowerCase();
  } finally {
    rl.close();
  }
}

export const loadCommand = new Command("load")
  .description("Restore a saved development context")
  .argument("<name>", "Name of the save state to load")
  .option("-f, --force", "Skip dirty tree warning")
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

      release = await acquireLock(projectRoot);

      // Read state
      const state = await readState(projectRoot, name);
      const git = createGit(projectRoot);

      // Dirty tree check
      const dirty = await isDirty(git);
      if (dirty && !opts.force) {
        console.log("Working tree has uncommitted changes.\n");
        const choice = await promptChoice(
          "(s)tash current changes, (a)bort, or (f)orce load on top",
          "s/a/f"
        );

        if (choice === "a" || choice === "abort") {
          console.log("Aborted.");
          return;
        }

        if (choice === "s" || choice === "stash") {
          const stashMsg = `dvs: auto-stash before loading '${name}'`;
          try {
            await stashChanges(git, stashMsg);
            console.log("Changes stashed.");
          } catch (err: any) {
            console.error(`Could not stash: ${err.message}`);
            console.log("Aborting.");
            return;
          }
        }
        // choice === "f" or "force" — continue
      }

      // Checkout branch
      const currentBranch = await getBranch(git);
      if (currentBranch !== state.git.branch) {
        const result = await checkoutBranch(git, state.git.branch);
        if (!result.success) {
          console.warn(`Warning: ${result.message}`);
          console.warn(`Staying on branch '${currentBranch}'`);
        }
      }

      // Apply patch
      if (state.git.hasUncommittedChanges) {
        const patchFile = patchPath(projectRoot, name);
        const result = await applyPatch(git, patchFile);
        if (result.alreadyApplied) {
          console.log("Patch already applied, skipping.");
        } else if (result.hadConflicts) {
          console.warn(`Warning: ${result.message}`);
        } else if (result.applied) {
          console.log("Patch applied.");
        } else {
          console.warn(`Warning: ${result.message}`);
        }
      }

      // Display mental stack
      console.log("");
      printMentalStack(state);

      // Editor hints
      if (state.editor?.openFiles?.length) {
        console.log("\nTo open files:");
        for (const file of state.editor.openFiles) {
          const filePath = path.join(projectRoot, file.relativePath);
          console.log(`  code -g "${filePath}:${file.cursorLine}:${file.cursorColumn}"`);
        }
      }

      // Update metadata
      state.lastLoadedAt = new Date().toISOString();
      state.loadCount = (state.loadCount || 0) + 1;
      state.updatedAt = state.lastLoadedAt;

      const stateFile = stateJsonPath(projectRoot, name);
      await writeFileAtomic(
        stateFile,
        JSON.stringify(state, null, 2) + "\n"
      );
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    } finally {
      if (release) await release();
    }
  });
