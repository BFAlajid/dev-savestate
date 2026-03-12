import { Command } from "commander";
import readline from "node:readline/promises";
import {
  findProjectRoot,
  createGit,
  getBranch,
  getCommitHash,
  isDirty,
  getDiff,
} from "../lib/git.js";
import {
  ensureSavestateDir,
  acquireLock,
  cleanStaleTmpDirs,
  atomicSaveState,
  computeHash,
  stateExists,
  validateStateName,
} from "../lib/storage.js";
import type { SaveState } from "../lib/types.js";

async function promptLine(question: string): Promise<string> {
  if (!process.stdin.isTTY) return "";
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

export const saveCommand = new Command("save")
  .description("Save current development context")
  .argument("[name]", "Name for the save state")
  .argument("[note]", "Context note describing what you were doing")
  .action(async (nameArg?: string, noteArg?: string) => {
    let release: (() => Promise<void>) | null = null;

    try {
      const projectRoot = await findProjectRoot(process.cwd());
      await ensureSavestateDir(projectRoot);

      release = await acquireLock(projectRoot);
      await cleanStaleTmpDirs(projectRoot);

      // Resolve name
      const name =
        nameArg ||
        `save-${new Date().toISOString().slice(0, 16).replace(":", "")}`;

      // Validate name
      const nameCheck = validateStateName(name);
      if (!nameCheck.valid) {
        console.error(`Error: ${nameCheck.reason}`);
        process.exitCode = 1;
        return;
      }

      // Check if overwriting
      if (nameArg && (await stateExists(projectRoot, name))) {
        console.log(`Updating existing state '${name}'`);
      }

      // Capture git state
      const git = createGit(projectRoot);
      const [branch, commitHash, dirty] = await Promise.all([
        getBranch(git),
        getCommitHash(git),
        isDirty(git),
      ]);

      let patchContent = "";
      if (dirty) {
        patchContent = await getDiff(git);
      }

      const patchHash = computeHash(patchContent);

      // Resolve note
      let note = noteArg || "";
      if (!note) {
        note = await promptLine("Note (what are you working on?): ");
      }

      // Resolve next step
      let nextStep: string | undefined;
      if (process.stdin.isTTY) {
        const ns = await promptLine(
          "Next step when you return? (optional, press Enter to skip): "
        );
        if (ns) nextStep = ns;
      }

      // Build state
      const now = new Date().toISOString();
      const state: SaveState = {
        version: 1,
        name,
        createdAt: now,
        updatedAt: now,
        projectRoot,
        note,
        nextStep,
        git: {
          branch,
          commitHash,
          hasUncommittedChanges: dirty,
          patchFile: "git-patch.diff",
          patchHash,
        },
        archived: false,
        loadCount: 0,
      };

      // Atomic save
      await atomicSaveState(projectRoot, name, state, patchContent);

      // Summary
      console.log("");
      console.log(`Saved: ${name}`);
      console.log(`  Branch:  ${branch}`);
      console.log(`  Commit:  ${commitHash.slice(0, 8)}`);
      if (dirty) {
        const lines = patchContent.split("\n").length;
        console.log(`  Changes: ${lines} lines of diff`);
      } else {
        console.log(`  Changes: clean working tree`);
      }
      if (note) console.log(`  Note:    ${note.slice(0, 60)}`);
      if (nextStep) console.log(`  Next:    ${nextStep.slice(0, 60)}`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    } finally {
      if (release) await release();
    }
  });
