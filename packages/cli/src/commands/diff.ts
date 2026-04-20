import { Command } from "commander";
import { findProjectRoot } from "../lib/git.js";
import { ensureSavestateDir, readState, resolveStateDir } from "../lib/storage.js";

export const diffCommand = new Command("diff")
  .description("Compare two save states")
  .argument("<state1>", "First state name")
  .argument("<state2>", "Second state name")
  .option("--json", "Output as JSON")
  .action(async (state1Name: string, state2Name: string, opts: { json?: boolean }) => {
    try {
      const projectRoot = await findProjectRoot(process.cwd());
      await ensureSavestateDir(projectRoot);
      resolveStateDir(projectRoot, state1Name); // validate + traversal guard
      resolveStateDir(projectRoot, state2Name); // validate + traversal guard
      const s1 = await readState(projectRoot, state1Name);
      const s2 = await readState(projectRoot, state2Name);

      if (opts.json) { console.log(JSON.stringify({ state1: s1, state2: s2 }, null, 2)); return; }

      const w = 58;
      const border = "─".repeat(w - 2);
      console.log(`┌${border}┐`);
      pl(`  DIFF: ${s1.name} ↔ ${s2.name}`, w);
      console.log(`├${border}┤`);

      if (s1.git.branch !== s2.git.branch) {
        pl(`  Branch:   ${s1.git.branch} → ${s2.git.branch}`, w);
      } else {
        pl(`  Branch:   ${s1.git.branch} (same)`, w);
      }
      pl("", w);

      const files1 = new Set(s1.editor?.openFiles?.map((f) => f.relativePath) || []);
      const files2 = new Set(s2.editor?.openFiles?.map((f) => f.relativePath) || []);
      const onlyIn1 = [...files1].filter((f) => !files2.has(f));
      const onlyIn2 = [...files2].filter((f) => !files1.has(f));
      const inBoth = [...files1].filter((f) => files2.has(f));

      if (onlyIn1.length || onlyIn2.length || inBoth.length) {
        pl("  Files:", w);
        for (const f of onlyIn1) pl(`    - ${f} (${s1.name} only)`, w);
        for (const f of onlyIn2) pl(`    + ${f} (${s2.name} only)`, w);
        for (const f of inBoth) pl(`    = ${f} (both)`, w);
        pl("", w);
      }

      pl("  Notes:", w);
      if (s1.note) pl(`    - "${s1.note.slice(0, 40)}"`, w);
      if (s2.note) pl(`    + "${s2.note.slice(0, 40)}"`, w);
      pl("", w);
      pl(`  Loads:  ${s1.name}: ${s1.loadCount}  |  ${s2.name}: ${s2.loadCount}`, w);
      console.log(`└${border}┘`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    }
  });

function pl(text: string, width: number): void {
  const content = text.slice(0, width - 4);
  const padding = Math.max(0, width - 2 - content.length);
  console.log(`│${content}${" ".repeat(padding)}│`);
}
