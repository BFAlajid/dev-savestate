import { Command } from "commander";
import { exec } from "node:child_process";
import { findProjectRoot } from "../lib/git.js";
import { ensureSavestateDir, readState } from "../lib/storage.js";

export const openCommand = new Command("open")
  .description("Open files from a save state without loading")
  .argument("<name>", "Name of the save state")
  .option("--no-launch", "Print file paths without opening in editor")
  .action(async (name: string, opts: { launch?: boolean }) => {
    try {
      const projectRoot = await findProjectRoot(process.cwd());
      await ensureSavestateDir(projectRoot);
      const state = await readState(projectRoot, name);

      if (!state.editor?.openFiles?.length) {
        console.log(`No editor files saved in state '${name}'.`);
        return;
      }

      console.log(`${name} — ${state.editor.openFiles.length} file(s)\n`);
      const commands: string[] = [];

      for (const file of state.editor.openFiles) {
        const active = file.relativePath === state.editor.activeFile ? "  (active)" : "";
        console.log(`  ${file.relativePath}:${file.cursorLine}:${file.cursorColumn}${active}`);
        commands.push(`code -g "${file.relativePath}:${file.cursorLine}:${file.cursorColumn}"`);
      }

      if (opts.launch !== false) {
        console.log("\nOpening in VS Code...");
        for (const cmd of commands) { exec(cmd, { cwd: projectRoot }); }
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    }
  });
