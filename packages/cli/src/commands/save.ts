import { Command } from "commander";
import readline from "node:readline/promises";
import fs from "node:fs/promises";
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
import { getProcessesForSave, readProjectConfig, getConfigProcesses } from "../lib/process.js";
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
  .option("-t, --tag <tags...>", "Add tags to the save state")
  .option("--editor-state <file>", "Path to JSON file with editor state (used by VS Code extension)")
  .option("--json", "Output as JSON")
  .action(async (nameArg?: string, noteArg?: string, opts?: { tag?: string[]; editorState?: string; json?: boolean }) => {
    let release: (() => Promise<void>) | null = null;

    try {
      const projectRoot = await findProjectRoot(process.cwd());
      await ensureSavestateDir(projectRoot);

      release = await acquireLock(projectRoot);
      await cleanStaleTmpDirs(projectRoot);

      const name =
        nameArg ||
        `save-${new Date().toISOString().slice(0, 16).replace(":", "")}`;

      const nameCheck = validateStateName(name);
      if (!nameCheck.valid) {
        console.error(`Error: ${nameCheck.reason}`);
        process.exitCode = 1;
        return;
      }

      if (nameArg && (await stateExists(projectRoot, name))) {
        console.log(`Updating existing state '${name}'`);
      }

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

      let note = noteArg || "";
      if (!note) {
        note = await promptLine("Note (what are you working on?): ");
      }

      let nextStep: string | undefined;
      if (process.stdin.isTTY) {
        const ns = await promptLine("Next step when you return? (optional, press Enter to skip): ");
        if (ns) nextStep = ns;
      }

      // Collect processes
      const dvsRunProcs = getProcessesForSave();
      const config = await readProjectConfig(projectRoot);
      const configProcs = getConfigProcesses(config, projectRoot);
      const processes = [...dvsRunProcs, ...configProcs];

      // Read editor state from file if provided (VS Code extension path)
      let editor: SaveState["editor"] | undefined;
      if (opts?.editorState) {
        try {
          const raw = await fs.readFile(opts.editorState, "utf-8");
          editor = JSON.parse(raw);
          // Clean up temp file
          await fs.unlink(opts.editorState).catch(() => {});
        } catch {
          // Ignore invalid editor state — save proceeds without it
        }
      }

      const now = new Date().toISOString();
      const state: SaveState = {
        version: 1,
        name,
        createdAt: now,
        updatedAt: now,
        projectRoot,
        note,
        nextStep,
        tags: opts?.tag || [],
        git: {
          branch,
          commitHash,
          hasUncommittedChanges: dirty,
          patchFile: "git-patch.diff",
          patchHash,
        },
        editor,
        processes,
        archived: false,
        loadCount: 0,
      };

      await atomicSaveState(projectRoot, name, state, patchContent);

      if (opts?.json) {
        console.log(JSON.stringify({ success: true, name, branch, commitHash, dirty, note }));
      } else {
        console.log("");
        console.log(`Saved: ${name}`);
        console.log(`  Branch:  ${branch}`);
        console.log(`  Commit:  ${commitHash.slice(0, 8)}`);
        if (dirty) {
          console.log(`  Changes: ${patchContent.split("\n").length} lines of diff`);
        } else {
          console.log(`  Changes: clean working tree`);
        }
        if (state.tags.length) console.log(`  Tags:    ${state.tags.join(", ")}`);
        if (processes.length) console.log(`  Procs:   ${processes.map((p) => p.name).join(", ")}`);
        if (note) console.log(`  Note:    ${note.slice(0, 60)}`);
        if (nextStep) console.log(`  Next:    ${nextStep.slice(0, 60)}`);
      }
    } catch (err: any) {
      if (opts?.json) {
        console.log(JSON.stringify({ success: false, error: err.message }));
      } else {
        console.error(`Error: ${err.message}`);
      }
      process.exitCode = 1;
    } finally {
      if (release) await release();
    }
  });
