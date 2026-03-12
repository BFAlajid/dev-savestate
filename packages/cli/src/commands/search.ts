import { Command } from "commander";
import { findProjectRoot } from "../lib/git.js";
import { ensureSavestateDir, readIndex, readState } from "../lib/storage.js";
import { formatDateShort } from "../lib/display.js";

export const searchCommand = new Command("search")
  .description("Search save states by note content")
  .argument("<query>", "Search query")
  .option("--json", "Output as JSON")
  .action(async (query: string, opts: { json?: boolean }) => {
    try {
      const projectRoot = await findProjectRoot(process.cwd());
      await ensureSavestateDir(projectRoot);
      const index = await readIndex(projectRoot);
      const q = query.toLowerCase();

      const results: Array<{ name: string; branch: string; updatedAt: string; notePreview: string }> = [];

      for (const entry of index.states) {
        if (entry.name.toLowerCase().includes(q) || entry.notePreview.toLowerCase().includes(q)) {
          results.push({ name: entry.name, branch: entry.branch, updatedAt: entry.updatedAt, notePreview: entry.notePreview });
          continue;
        }
        try {
          const state = await readState(projectRoot, entry.name);
          if (state.note.toLowerCase().includes(q) || (state.nextStep && state.nextStep.toLowerCase().includes(q))) {
            results.push({ name: entry.name, branch: entry.branch, updatedAt: entry.updatedAt, notePreview: state.note.slice(0, 100) });
          }
        } catch {}
      }

      if (opts.json) { console.log(JSON.stringify(results, null, 2)); return; }
      if (results.length === 0) { console.log(`No states matching "${query}".`); return; }

      console.log(`${results.length} match(es) for "${query}":\n`);
      for (const r of results) {
        console.log(`  ${r.name.padEnd(22)} ${formatDateShort(r.updatedAt).padEnd(16)} "${r.notePreview.slice(0, 40)}"`);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    }
  });
