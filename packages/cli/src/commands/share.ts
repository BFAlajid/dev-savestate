import { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import { findProjectRoot } from "../lib/git.js";
import { ensureSavestateDir, readState, acquireLock, atomicSaveState, stateExists, validateStateName, resolveStateDir } from "../lib/storage.js";

interface SharePackage {
  manifest: { version: 1; name: string; createdAt: string; exportedAt: string; files: string[] };
  stateJson: string;
  noteMd: string;
  patchDiff: string;
}

export const shareCommand = new Command("share")
  .description("Export a save state as a portable .savestate.json package")
  .argument("<name>", "Name of the save state to export")
  .option("-o, --output <path>", "Output file path")
  .action(async (name: string, opts: { output?: string }) => {
    try {
      const projectRoot = await findProjectRoot(process.cwd());
      await ensureSavestateDir(projectRoot);
      const dir = resolveStateDir(projectRoot, name); // validate + traversal guard
      const state = await readState(projectRoot, name);

      let noteMd = "";
      let patchDiff = "";
      try { noteMd = await fs.readFile(path.join(dir, "note.md"), "utf-8"); } catch {}
      try { patchDiff = await fs.readFile(path.join(dir, "git-patch.diff"), "utf-8"); } catch {}

      const exportState = { ...state, projectRoot: "." };
      const pkg: SharePackage = {
        manifest: { version: 1, name: state.name, createdAt: state.createdAt, exportedAt: new Date().toISOString(), files: ["state.json", "note.md", "git-patch.diff"] },
        stateJson: JSON.stringify(exportState, null, 2),
        noteMd,
        patchDiff,
      };

      const outputPath = opts.output || `${name}.savestate.json`;
      await fs.writeFile(outputPath, JSON.stringify(pkg, null, 2) + "\n");
      console.log(`Exported: ${outputPath}`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    }
  });

export const importCommand = new Command("import")
  .description("Import a save state from a .savestate.json package")
  .argument("<file>", "Path to the .savestate.json file")
  .option("--name <name>", "Override the state name")
  .action(async (file: string, opts: { name?: string }) => {
    let release: (() => Promise<void>) | null = null;
    try {
      const projectRoot = await findProjectRoot(process.cwd());
      await ensureSavestateDir(projectRoot);

      const raw = await fs.readFile(file, "utf-8");
      const pkg: SharePackage = JSON.parse(raw);

      if (!pkg.manifest || pkg.manifest.version !== 1) {
        console.error("Invalid or unsupported .savestate.json format.");
        process.exitCode = 1;
        return;
      }

      const name = opts.name || pkg.manifest.name;
      const nameCheck = validateStateName(name);
      if (!nameCheck.valid) { console.error(`Error: ${nameCheck.reason}`); process.exitCode = 1; return; }

      if (await stateExists(projectRoot, name)) {
        console.error(`State '${name}' already exists. Use --name to import with a different name.`);
        process.exitCode = 1;
        return;
      }

      release = await acquireLock(projectRoot);
      const state = JSON.parse(pkg.stateJson);
      state.name = name;
      state.projectRoot = projectRoot;
      await atomicSaveState(projectRoot, name, state, pkg.patchDiff || "");

      console.log(`Imported: ${name}`);
      console.log(`  Branch: ${state.git.branch}`);
      if (state.note) console.log(`  Note:   ${state.note.slice(0, 60)}`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    } finally {
      if (release) await release();
    }
  });
