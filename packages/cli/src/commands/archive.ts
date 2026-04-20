import { Command } from "commander";
import { findProjectRoot } from "../lib/git.js";
import { ensureSavestateDir, acquireLock, readState, readIndex, writeIndex, stateExists, resolveStateDir } from "../lib/storage.js";
import { stateJsonPath } from "../lib/paths.js";
import writeFileAtomic from "write-file-atomic";

async function setArchived(name: string, archived: boolean): Promise<void> {
  let release: (() => Promise<void>) | null = null;
  try {
    const projectRoot = await findProjectRoot(process.cwd());
    await ensureSavestateDir(projectRoot);
    resolveStateDir(projectRoot, name); // validate + traversal guard

    if (!(await stateExists(projectRoot, name))) {
      console.error(`State '${name}' not found.`);
      process.exitCode = 1;
      return;
    }

    release = await acquireLock(projectRoot);
    const state = await readState(projectRoot, name);
    state.archived = archived;
    await writeFileAtomic(stateJsonPath(projectRoot, name), JSON.stringify(state, null, 2) + "\n");

    const index = await readIndex(projectRoot);
    const entry = index.states.find((s) => s.name === name);
    if (entry) { entry.archived = archived; await writeIndex(projectRoot, index); }

    console.log(`${archived ? "Archived" : "Unarchived"}: ${name}`);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  } finally {
    if (release) await release();
  }
}

export const archiveCommand = new Command("archive")
  .description("Archive a save state (hide from default list)")
  .argument("<name>", "Name of the save state")
  .action(async (name: string) => { await setArchived(name, true); });

export const unarchiveCommand = new Command("unarchive")
  .description("Unarchive a save state")
  .argument("<name>", "Name of the save state")
  .action(async (name: string) => { await setArchived(name, false); });
