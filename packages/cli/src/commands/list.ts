import { Command } from "commander";
import { findProjectRoot } from "../lib/git.js";
import { ensureSavestateDir, readIndex, recoverOrphans, readState } from "../lib/storage.js";
import { printStateList } from "../lib/display.js";

export const listCommand = new Command("list")
  .description("List all save states")
  .option("--archived", "Include archived states")
  .option("--json", "Output as JSON")
  .option("-t, --tag <tag>", "Filter by tag")
  .action(async (opts: { archived?: boolean; json?: boolean; tag?: string }) => {
    try {
      const projectRoot = await findProjectRoot(process.cwd());
      await ensureSavestateDir(projectRoot);

      const recovered = await recoverOrphans(projectRoot);
      if (recovered.length > 0) {
        for (const name of recovered) {
          console.log(`Recovered orphaned state: ${name}`);
        }
      }

      const index = await readIndex(projectRoot);
      let entries = index.states;

      if (!opts.archived) {
        entries = entries.filter((e) => !e.archived);
      }

      // Filter by tag if specified
      if (opts.tag) {
        const tag = opts.tag.toLowerCase();
        entries = entries.filter((e) => e.tags?.some((t) => t.toLowerCase() === tag));
      }

      entries.sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );

      if (opts.json) {
        console.log(JSON.stringify(entries, null, 2));
      } else {
        printStateList(entries);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    }
  });
