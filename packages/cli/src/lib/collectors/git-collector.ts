// Git collector: branch + commit + working-tree patch.
//
// Capture: records current branch, HEAD hash, whether the tree is dirty,
// and emits the working-tree patch (`git-patch.diff`) as a staging
// artifact. The patch includes BOTH unstaged and staged changes via
// `--binary` for binary-capable round-trip.
//
// Restore: best-effort checkout of the saved branch, then apply the patch
// through the multi-fallback pipeline in lib/git.ts (dry-run → already-
// applied reverse check → 3-way merge → reject). Conflicts/warnings are
// printed exactly as save.ts/load.ts printed them pre-refactor so the
// observable behavior is unchanged.
//
// Why patch is an artifact: collectors MUST NOT write directly into the
// atomic staging dir (that invariant is owned by storage.ts::
// atomicSaveState). By declaring the patch as a StagingArtifact, this
// collector surfaces the bytes to the orchestrator without knowing where
// staging lives. Save.ts then pulls the "git-patch.diff" artifact out and
// threads its `content` into atomicSaveState's existing `patchContent`
// parameter — storage.ts still writes git-patch.diff inline from that
// arg, so no double-write occurs and storage.ts is unchanged.

import { computeHash } from "../storage.js";
import {
  getBranch,
  getCommitHash,
  isDirty,
  getDiff,
  checkoutBranch,
  applyPatch,
} from "../git.js";
import { patchPath } from "../paths.js";
import type { SaveState } from "../types.js";
import type {
  CaptureContext,
  CaptureResult,
  Collector,
  RestoreContext,
} from "./types.js";

/** Artifact name used to thread patch bytes through the orchestrator. */
export const GIT_PATCH_ARTIFACT = "git-patch.diff";

export const gitCollector: Collector = {
  name: "git",

  async capture(ctx: CaptureContext): Promise<CaptureResult> {
    const [branch, commitHash, dirty] = await Promise.all([
      getBranch(ctx.git),
      getCommitHash(ctx.git),
      isDirty(ctx.git),
    ]);
    const patchContent = dirty ? await getDiff(ctx.git) : "";
    const patchHash = computeHash(patchContent);

    const slice: Partial<SaveState> = {
      git: {
        branch,
        commitHash,
        hasUncommittedChanges: dirty,
        patchFile: GIT_PATCH_ARTIFACT,
        patchHash,
      },
    };

    return {
      slice,
      artifacts: [
        { destRelative: GIT_PATCH_ARTIFACT, content: patchContent },
      ],
    };
  },

  async restore(ctx: RestoreContext, state: SaveState): Promise<void> {
    // Checkout only when the target branch differs from current — preserves
    // the pre-refactor "stay silent if already correct" behavior.
    const currentBranch = await getBranch(ctx.git);
    if (currentBranch !== state.git.branch) {
      const result = await checkoutBranch(ctx.git, state.git.branch);
      if (!result.success) {
        console.warn(`Warning: ${result.message}`);
        console.warn(`Staying on branch '${currentBranch}'`);
      }
    }

    // Apply patch only if the save captured uncommitted changes. patchPath
    // is the authoritative location of the on-disk patch file (both capture
    // artifact path and restore read path resolve to the same file via
    // paths.patchPath, so the collector doesn't need to know the raw
    // file name).
    if (state.git.hasUncommittedChanges) {
      const patchFile = patchPath(ctx.projectRoot, state.name);
      const result = await applyPatch(ctx.git, patchFile);
      if (result.alreadyApplied) {
        console.log("Patch already applied, skipping.");
      } else if (result.hadConflicts) {
        console.warn(`Warning: ${result.message}`);
      } else if (result.applied) {
        console.log("Patch applied.");
      } else {
        console.warn(`Warning: ${result.message}`);
      }
    }
  },
};
