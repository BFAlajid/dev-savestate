import { Command } from "commander";
import { execFile } from "node:child_process";
import path from "node:path";
import { findProjectRoot } from "../lib/git.js";
import { ensureSavestateDir, readState, resolveStateDir } from "../lib/storage.js";

/**
 * Validate that relativePath is a real in-tree path.
 * We only accept paths that, after resolution, sit inside projectRoot.
 * We reject absolute paths, null bytes, and anything escaping the project.
 */
function assertSafeRelativePath(relativePath: string, projectRoot: string): void {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error("editor file path is empty");
  }
  if (relativePath.includes("\x00")) {
    throw new Error(`editor file path '${relativePath}' contains null byte`);
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error(`editor file path '${relativePath}' must be relative`);
  }
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(
      `editor file path '${relativePath}' escapes project root`
    );
  }
}

export const openCommand = new Command("open")
  .description("Open files from a save state without loading")
  .argument("<name>", "Name of the save state")
  .option("--no-launch", "Print file paths without opening in editor")
  .action(async (name: string, opts: { launch?: boolean }) => {
    try {
      const projectRoot = await findProjectRoot(process.cwd());
      await ensureSavestateDir(projectRoot);
      resolveStateDir(projectRoot, name); // validate + traversal guard
      const state = await readState(projectRoot, name);

      if (!state.editor?.openFiles?.length) {
        console.log(`No editor files saved in state '${name}'.`);
        return;
      }

      console.log(`${name} — ${state.editor.openFiles.length} file(s)\n`);

      type OpenTarget = { argPath: string; useGoto: boolean };
      const targets: OpenTarget[] = [];

      for (const file of state.editor.openFiles) {
        try {
          assertSafeRelativePath(file.relativePath, projectRoot);
        } catch (err: any) {
          console.warn(`Skipping ${file.relativePath}: ${err.message}`);
          continue;
        }

        const active = file.relativePath === state.editor.activeFile ? "  (active)" : "";
        const line = Number(file.cursorLine);
        const col = Number(file.cursorColumn);
        const useGoto =
          Number.isFinite(line) && line >= 1 && Number.isFinite(col) && col >= 1;

        if (useGoto) {
          console.log(`  ${file.relativePath}:${line}:${col}${active}`);
          targets.push({ argPath: `${file.relativePath}:${line}:${col}`, useGoto: true });
        } else {
          console.log(`  ${file.relativePath}${active}`);
          targets.push({ argPath: file.relativePath, useGoto: false });
        }
      }

      if (opts.launch !== false && targets.length) {
        console.log("\nOpening in VS Code...");
        for (const t of targets) {
          // execFile — arguments are passed as an argv array. No shell
          // interpolation, no quoting bugs, no injection from file names.
          const args = t.useGoto ? ["-g", t.argPath] : [t.argPath];
          execFile("code", args, { cwd: projectRoot }, (err) => {
            if (err) {
              // Best-effort; the user will see the error in stderr.
            }
          });
        }
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    }
  });
