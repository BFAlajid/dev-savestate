import { Command } from "commander";
import readline from "node:readline/promises";
import path from "node:path";
import {
  findProjectRoot,
  createGit,
  isDirty,
  getBranch,
  getCommitHash,
  getDiff,
  stashChanges,
} from "../lib/git.js";
import {
  acquireLock,
  readState,
  ensureSavestateDir,
  validateStateName,
} from "../lib/storage.js";
import { stateDir as resolveStateDirPath } from "../lib/paths.js";
import { printMentalStack } from "../lib/display.js";
import {
  gitCollector,
  editorCollector,
  processCollector,
  untrackedCollector,
  type RestoreContext,
} from "../lib/collectors/index.js";
import { saveCheckpoint } from "./back.js";
import { writeHeartbeat } from "./recover.js";
import writeFileAtomic from "write-file-atomic";
import { stateJsonPath } from "../lib/paths.js";

async function promptChoice(question: string, choices: string): Promise<string> {
  if (!process.stdin.isTTY) return "a";
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
  .option("--force-untracked", "Overwrite existing untracked files that differ from the saved blobs")
  .action(async (name: string, opts: { force?: boolean; forceUntracked?: boolean }) => {
    let release: (() => Promise<void>) | null = null;

    try {
      const nameCheck = validateStateName(name);
      if (!nameCheck.valid) {
        console.error(`Error: ${nameCheck.reason}`);
        process.exitCode = 1;
        return;
      }

      const projectRoot = await findProjectRoot(process.cwd());
      await ensureSavestateDir(projectRoot);

      release = await acquireLock(projectRoot);

      const state = await readState(projectRoot, name);
      const git = createGit(projectRoot);

      // Save pre-load checkpoint for dvs back — must happen before any
      // checkout/patch/spawn so `dvs back` can fully undo this load.
      const currentBranch = await getBranch(git);
      const currentHash = await getCommitHash(git);
      const currentDiff = await getDiff(git);
      await saveCheckpoint(projectRoot, currentBranch, currentHash, currentDiff || undefined);

      // Dirty tree check — gates any destructive collector restore so we
      // never clobber unsaved local changes without the user's consent.
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
      }

      // Build a shared RestoreContext that every collector sees. `opts`
      // carries CLI flags; collectors only consume the ones they recognize.
      const stateDirPath = resolveStateDirPath(projectRoot, name);
      const restoreCtx: RestoreContext = {
        projectRoot,
        git,
        stateDir: stateDirPath,
        opts: {
          force: !!opts.force,
          forceUntracked: !!opts.forceUntracked,
        },
        warn: (m) => console.warn(m),
      };

      // Restore in pre-refactor observable order:
      //   1. git (checkout + patch) — working tree must be on target
      //      branch and patched before anything else writes files.
      //   2. untracked — new files materialized into the current tree.
      //   3. mental stack + editor hints (cross-cutting UX).
      //   4. processes — respawn after the tree is stable.
      // editorCollector.restore is a no-op on the CLI (see its source);
      // we still call it so the collector pipeline is uniform and a
      // future IDE collector override plugs in here without a load.ts
      // edit.
      await gitCollector.restore(restoreCtx, state);
      await untrackedCollector.restore(restoreCtx, state);

      console.log("");
      printMentalStack(state);

      if (state.editor?.openFiles?.length) {
        console.log("\nTo open files:");
        for (const file of state.editor.openFiles) {
          const filePath = path.join(projectRoot, file.relativePath);
          console.log(`  code -g "${filePath}:${file.cursorLine}:${file.cursorColumn}"`);
        }
      }
      await editorCollector.restore(restoreCtx, state);

      await processCollector.restore(restoreCtx, state);

      // Write heartbeat — records this state as the active session so
      // `dvs recover` can detect crashes and offer to reload.
      await writeHeartbeat(projectRoot, name);

      // Update metadata — lastLoadedAt / loadCount are used by list and
      // timeline; keeping the write at the end of load preserves its
      // "crash during load leaves the old metadata" semantics.
      state.lastLoadedAt = new Date().toISOString();
      state.loadCount = (state.loadCount || 0) + 1;
      state.updatedAt = state.lastLoadedAt;

      const stateFile = stateJsonPath(projectRoot, name);
      await writeFileAtomic(stateFile, JSON.stringify(state, null, 2) + "\n");
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    } finally {
      if (release) await release();
    }
  });
