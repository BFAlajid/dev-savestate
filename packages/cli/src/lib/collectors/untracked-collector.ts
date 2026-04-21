// Untracked collector: brand-new files not yet `git add`ed.
//
// `git diff HEAD` only covers tracked files; a file you haven't staged is
// silently dropped on round-trip. captureUntracked() copies those files
// into a temp subtree under .savestate/_tmp/, honoring .gitignore via
// git ls-files and skipping large / symlinked / vanished entries. The
// tmp subtree is then handed to the orchestrator as a `copyFrom` staging
// artifact — the orchestrator renames (or cp-and-rms on EXDEV) that tree
// into `<stateDir>/untracked/` within its atomic-rename window.
//
// Empty manifests are common (most working trees have nothing untracked).
// We clean up the empty tmp dir immediately in capture so the stale-tmp
// sweeper has less work to do, and we emit zero artifacts so the final
// state dir does NOT have a stray empty `untracked/` subdir.
//
// On restore, restoreUntracked materializes blobs back into the working
// tree with conflict detection / --force-untracked override. Warnings and
// summary output are printed here so observable behavior matches the
// pre-refactor inline implementation in load.ts.

import fs from "node:fs/promises";
import path from "node:path";
import { captureUntracked, restoreUntracked, formatBytes } from "../blobs.js";
import { tmpDir as savestateTmpDir } from "../paths.js";
import { stateDir as resolveStateDirPath } from "../paths.js";
import type { SaveState } from "../types.js";
import type {
  CaptureContext,
  CaptureResult,
  Collector,
  RestoreContext,
} from "./types.js";

export const untrackedCollector: Collector = {
  name: "untracked",

  async capture(ctx: CaptureContext): Promise<CaptureResult> {
    const tmpId = `untracked-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;
    const tmpRoot = path.join(savestateTmpDir(ctx.projectRoot), tmpId);

    const manifest = await captureUntracked(ctx.projectRoot, tmpRoot, {
      includeLarge: !!ctx.opts.includeLarge,
      warn: ctx.warn,
      git: ctx.git,
    });

    if (manifest.files.length === 0) {
      // Nothing captured — clean up the (empty) temp dir immediately and
      // emit no artifact. This avoids leaving a stray `untracked/` subdir
      // in the final state dir when there were no new files to save.
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      return { slice: { untracked: manifest } };
    }

    return {
      slice: { untracked: manifest },
      artifacts: [{ destRelative: "untracked", copyFrom: tmpRoot }],
    };
  },

  async restore(ctx: RestoreContext, state: SaveState): Promise<void> {
    if (!state.untracked?.files?.length) return;

    const stateDirPath = resolveStateDirPath(ctx.projectRoot, state.name);
    const report = await restoreUntracked(
      ctx.projectRoot,
      state.untracked,
      stateDirPath,
      { forceUntracked: !!ctx.opts.forceUntracked }
    );

    if (report.conflicts.length > 0) {
      console.warn(
        `Warning: ${report.conflicts.length} untracked file(s) already exist ` +
          `with different content and were not overwritten. Re-run with ` +
          `--force-untracked to overwrite. Conflicts:`
      );
      for (const p of report.conflicts) console.warn(`  - ${p}`);
    }
    if (report.restored > 0) {
      console.log(
        `Restored ${report.restored} untracked file${
          report.restored === 1 ? "" : "s"
        } ` + `(+${formatBytes(report.bytesWritten)})`
      );
    }
  },
};
