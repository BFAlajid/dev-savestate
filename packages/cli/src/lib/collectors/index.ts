// Built-in collector registry.
//
// Ordering is intentional and observable — the same order governs both
// capture (merge order of slices and artifact writes) and restore (which
// runs collectors in listed order). Changing this order can change user-
// visible behavior, so keep it stable:
//
//   1. git        — branch, commit, patch. Must run first on restore so
//                   checkoutBranch + applyPatch finish before process
//                   respawn touches the working tree.
//   2. editor     — cheap slice capture; no-op restore on the CLI side.
//   3. processes  — needs the post-checkout branch to be current before
//                   restart (e.g. to respect per-branch port configs).
//   4. untracked  — restores NEW files last so the working tree is already
//                   the "saved branch + patch" state.
//
// Capture runs in parallel (Promise.all); each collector's capture is
// independent and order-insensitive at save time. The list order governs
// artifact emission and slice merge precedence for any overlapping fields
// (there are no overlapping fields today — this is defensive).

import { gitCollector } from "./git-collector.js";
import { editorCollector } from "./editor-collector.js";
import { processCollector } from "./process-collector.js";
import { untrackedCollector } from "./untracked-collector.js";
import type { Collector } from "./types.js";

export const BUILT_IN_COLLECTORS: Collector[] = [
  gitCollector,
  editorCollector,
  processCollector,
  untrackedCollector,
];

export { gitCollector, editorCollector, processCollector, untrackedCollector };
export { GIT_PATCH_ARTIFACT } from "./git-collector.js";
export { assertSafeEditorStatePath } from "./editor-collector.js";
export type {
  Collector,
  CaptureContext,
  RestoreContext,
  CaptureResult,
  StagingArtifact,
} from "./types.js";
