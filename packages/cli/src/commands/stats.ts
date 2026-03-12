import { Command } from "commander";
import { findProjectRoot } from "../lib/git.js";
import { ensureSavestateDir, readIndex, readState } from "../lib/storage.js";

export const statsCommand = new Command("stats")
  .description("Show work duration analytics")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    try {
      const projectRoot = await findProjectRoot(process.cwd());
      await ensureSavestateDir(projectRoot);
      const index = await readIndex(projectRoot);

      if (index.states.length === 0) { console.log("No save states found."); return; }

      const entries: Array<{ name: string; loadCount: number; lastLoadedAt?: string; createdAt: string; branch: string }> = [];

      for (const entry of index.states) {
        try {
          const state = await readState(projectRoot, entry.name);
          entries.push({ name: state.name, loadCount: state.loadCount, lastLoadedAt: state.lastLoadedAt, createdAt: state.createdAt, branch: state.git.branch });
        } catch {}
      }

      if (opts.json) { console.log(JSON.stringify(entries, null, 2)); return; }

      entries.sort((a, b) => b.loadCount - a.loadCount);

      const maxNameLen = Math.max(...entries.map((e) => e.name.length), 4);
      const header = "NAME".padEnd(maxNameLen + 2) + "BRANCH".padEnd(20) + "LOADS".padEnd(8) + "LAST LOADED";
      console.log(header);
      console.log("─".repeat(header.length));

      for (const entry of entries) {
        const lastLoaded = entry.lastLoadedAt ? new Date(entry.lastLoadedAt).toLocaleDateString() : "never";
        console.log(entry.name.padEnd(maxNameLen + 2) + entry.branch.padEnd(20) + String(entry.loadCount).padEnd(8) + lastLoaded);
      }
      console.log(`\n${entries.length} state(s), ${entries.reduce((s, e) => s + e.loadCount, 0)} total loads`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    }
  });
