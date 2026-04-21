// Collector plugin interface.
//
// A Collector owns ONE dimension of the save state. Built-ins today:
//   - git        (branch, commit, dirty patch)
//   - editor     (VS Code open files / cursor positions)
//   - processes  (managed long-running commands)
//   - untracked  (brand-new files not yet `git add`ed)
//
// External collectors (neovim plugin, JetBrains bridge, Docker, DB dumps)
// plug in via the same interface. The `save` and `load` commands compose
// collectors into a pipeline; they do not know about any individual
// dimension's semantics.
//
// Invariant: the atomic staging dir (.savestate/_tmp/<uuid>/) is owned by
// the orchestrator (storage.ts::atomicSaveState). Collectors MUST NOT write
// directly into it. Instead, a collector declares any extra files it needs
// persisted alongside state.json by returning StagingArtifact entries; the
// orchestrator performs the actual writes from within the same try/catch
// that owns the rollback-on-failure rename. This preserves the "never
// half-written state dir" guarantee the rest of the CLI relies on.

import type { SimpleGit } from "simple-git";
import type { SaveState } from "../types.js";

/**
 * Context passed to a collector's `capture` phase on `dvs save`. Every input
 * a capturer might need to examine the working tree without knowing about
 * other dimensions.
 *
 * `opts` is a flag bag sourced from the CLI (e.g. `--include-large`,
 * `--strict-secrets`, `--editor-state`). A collector should ignore unknown
 * flags silently — flags exist so new capture behaviors can be opt-in
 * without forcing a schema bump.
 */
export interface CaptureContext {
  projectRoot: string;
  git: SimpleGit;
  /** Flag bag for opt-in behaviors. Typed as unknown so collectors validate. */
  opts: Record<string, unknown>;
  /**
   * Sink for non-fatal warnings surfaced during capture (e.g. skipped
   * symlinks, oversized untracked files). Aggregated by the orchestrator
   * and printed in a predictable order before the save summary.
   */
  warn: (message: string) => void;
}

/**
 * Context passed to a collector's `restore` phase on `dvs load`. `stateDir`
 * points at `.savestate/states/<name>/` where the collector can read any
 * auxiliary files it staged on capture (e.g. `untracked/` blobs, the git
 * patch file).
 */
export interface RestoreContext {
  projectRoot: string;
  git: SimpleGit;
  stateDir: string;
  /** Flag bag for opt-in behaviors (e.g. `--force`, `--force-untracked`). */
  opts: Record<string, unknown>;
  /** Same warning sink semantics as CaptureContext.warn. */
  warn: (message: string) => void;
}

/**
 * A file the orchestrator should drop into the atomic staging dir alongside
 * state.json. Two forms:
 *
 *   * `content`  — in-memory bytes/string. Use for small, already-known
 *                  blobs like `git-patch.diff`.
 *   * `copyFrom` — absolute path (typically somewhere under
 *                  .savestate/_tmp/) that should be renamed or recursively
 *                  copied into staging. Use for large tree-shaped payloads
 *                  like `untracked/` that were already written to disk by
 *                  the collector during capture. Rename-first, fall back to
 *                  copy-then-rm on cross-device errors.
 *
 * `destRelative` is a forward-slash path within the staging dir. The
 * orchestrator rejects any entry that tries to escape (absolute path, `..`
 * segments, null bytes).
 */
export type StagingArtifact =
  | { destRelative: string; content: Buffer | string }
  | { destRelative: string; copyFrom: string };

/**
 * Return shape from `capture`. `slice` is the collector's contribution to
 * the merged SaveState (partial — other collectors fill the other fields).
 * `artifacts` is the list of auxiliary files the orchestrator must stage
 * alongside state.json.
 */
export interface CaptureResult {
  slice: Partial<SaveState>;
  artifacts?: StagingArtifact[];
}

/**
 * Collector contract. Implementations should keep `capture` idempotent and
 * side-effect-free outside of their own tmp dir (if any). `restore` can
 * mutate the working tree but must respect the same safety invariants the
 * inline implementation enforces today (branch-name validation, symlink
 * refusal, path traversal guards).
 */
export interface Collector {
  readonly name: string;
  capture(ctx: CaptureContext): Promise<CaptureResult>;
  restore(ctx: RestoreContext, state: SaveState): Promise<void>;
}
