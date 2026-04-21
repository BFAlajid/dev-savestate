// Runtime schemas for persisted dev-savestate JSON.
//
// The TS interfaces in ./types.ts remain the compile-time source of truth —
// these Zod schemas are an additive runtime guard layered on the read path
// in storage.ts. Every persisted JSON file (state.json, index.json,
// .savestaterc.json, _active.json) is validated here before the rest of the
// CLI gets to touch it.
//
// Policy on unknown fields:
//   * SaveState / IndexEntry / IndexFile use .passthrough() — unknown fields
//     round-trip untouched. This lets older CLI builds read files written by
//     newer CLIs that tacked on extra fields *at the current schema version*.
//     (Genuine breaking shape changes bump CURRENT_SCHEMA_VERSION and go
//     through the migration registry instead.)
//   * ProjectConfig uses .passthrough() — user-authored file; unknown keys
//     might be conventions from other tooling, so drop-don't-remove.
//   * ActiveState uses .strict() — the heartbeat file is CLI-authored and
//     small; unknown fields here indicate tampering or schema drift.
//
// `version` fields are typed as z.number() rather than z.literal(N) because
// the migration pipeline needs to read raw older-version payloads before
// deciding whether to upgrade them.

import { z } from "zod";

// --- Version constant ---

export const CURRENT_SCHEMA_VERSION = 2;

// --- Git sub-schema ---

const GitStateSchema = z
  .object({
    branch: z.string(),
    commitHash: z.string(),
    hasUncommittedChanges: z.boolean(),
    patchFile: z.string(),
    patchHash: z.string(),
  })
  .passthrough();

// --- Editor sub-schema ---

const EditorOpenFileSchema = z
  .object({
    relativePath: z.string(),
    cursorLine: z.number(),
    cursorColumn: z.number(),
    viewColumn: z.number(),
  })
  .passthrough();

const EditorStateSchema = z
  .object({
    openFiles: z.array(EditorOpenFileSchema),
    activeFile: z.string().optional(),
  })
  .passthrough();

// --- Process sub-schema ---

const SavedProcessSchema = z
  .object({
    name: z.string(),
    command: z.string(),
    args: z.array(z.string()),
    cwd: z.string(),
    port: z.number().optional(),
    source: z.enum(["dvs-run", "config"]),
  })
  .passthrough();

// --- Untracked blob manifest sub-schema ---
//
// Captures brand-new (not-yet-`git add`ed) files so that a round-trip save
// → delete working copy → load restores them. Blobs themselves live next to
// state.json under <stateDir>/untracked/ mirroring the working-tree layout;
// this manifest is the authoritative index of which files were captured.
// Added in schema v2 — see registry.ts for the v1→v2 migration that fills
// this in with { files: [] } for pre-existing states.

const UntrackedFileEntrySchema = z
  .object({
    relativePath: z.string(),
    size: z.number(),
    mode: z.number(),
  })
  .passthrough();

const UntrackedManifestSchema = z
  .object({
    files: z.array(UntrackedFileEntrySchema),
  })
  .passthrough();

// --- SaveState ---

export const SaveStateSchema = z
  .object({
    version: z.number(),
    name: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    projectRoot: z.string(),

    note: z.string(),
    nextStep: z.string().optional(),
    tags: z.array(z.string()),

    git: GitStateSchema,

    editor: EditorStateSchema.optional(),

    processes: z.array(SavedProcessSchema),

    // v2+: required. v1 payloads get { files: [] } via registry.ts.
    untracked: UntrackedManifestSchema,

    archived: z.boolean(),
    lastLoadedAt: z.string().optional(),
    loadCount: z.number(),
  })
  .passthrough();

// --- IndexEntry & IndexFile ---

export const IndexEntrySchema = z
  .object({
    name: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    branch: z.string(),
    notePreview: z.string(),
    archived: z.boolean(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough();

export const IndexFileSchema = z
  .object({
    version: z.number(),
    states: z.array(IndexEntrySchema),
  })
  .passthrough();

// --- ActiveState (heartbeat / _active.json) ---
//
// lastHeartbeat is accepted as either an ISO string (current CLI writes
// `new Date().toISOString()`) or an epoch-ms number (future migration to
// numeric heartbeats for cheap arithmetic). Both are valid because
// `new Date(x)` round-trips either. When we switch writers to numbers, a
// schema bump is unnecessary — readers still accept both until the union
// is tightened. Strict on unknown fields — the heartbeat is tiny and
// CLI-authored, so unexpected keys imply tampering or schema drift.
export const ActiveStateSchema = z
  .object({
    stateName: z.string(),
    lastHeartbeat: z.union([z.string(), z.number()]),
    pid: z.number(),
  })
  .strict();

// --- ProjectConfig (.savestaterc.json) ---

const ProjectConfigCommandSchema = z
  .object({
    name: z.string(),
    command: z.string(),
    cwd: z.string().optional(),
    port: z.number().optional(),
  })
  .passthrough();

export const ProjectConfigSchema = z
  .object({
    processes: z
      .object({
        commands: z.array(ProjectConfigCommandSchema).optional(),
      })
      .passthrough()
      .optional(),
    promptNextStep: z.boolean().optional(),
  })
  .passthrough();

// --- Inferred types (for migration functions only; do not re-export as the
// project's canonical types — types.ts remains source of truth). ---

export type ValidatedSaveState = z.infer<typeof SaveStateSchema>;
export type ValidatedIndexFile = z.infer<typeof IndexFileSchema>;
export type ValidatedActiveState = z.infer<typeof ActiveStateSchema>;
export type ValidatedProjectConfig = z.infer<typeof ProjectConfigSchema>;
