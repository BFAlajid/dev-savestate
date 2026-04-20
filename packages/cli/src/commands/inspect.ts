import { Command } from "commander";
import { findProjectRoot } from "../lib/git.js";
import { ensureSavestateDir, readState, resolveStateDir } from "../lib/storage.js";
import { printMentalStack } from "../lib/display.js";

export const inspectCommand = new Command("inspect")
  .description("View save state details without loading")
  .argument("<name>", "Name of the save state")
  .option("--json", "Output as JSON")
  .action(async (name: string, opts: { json?: boolean }) => {
    try {
      const projectRoot = await findProjectRoot(process.cwd());
      await ensureSavestateDir(projectRoot);
      resolveStateDir(projectRoot, name); // validate + traversal guard
      const state = await readState(projectRoot, name);

      if (opts.json) {
        console.log(JSON.stringify(state, null, 2));
      } else {
        printMentalStack(state);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    }
  });
