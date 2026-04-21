import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import writeFileAtomic from "write-file-atomic";
import lockfile from "proper-lockfile";
import type { SaveState, IndexFile, IndexEntry } from "./types.js";
import * as paths from "./paths.js";
import { migrateState, migrateIndex, SchemaVersionError } from "./migrations/index.js";
import { ActiveStateSchema, type ValidatedActiveState } from "./schemas.js";

// --- Name Validation ---

const INVALID_NAME_CHARS = /[\/\\:*?"<>|]/;
const RESERVED_NAMES = new Set([".", "..", "_tmp", "_autosaves", "_quicksaves"]);

export function validateStateName(name: string): { valid: boolean; reason: string } {
  if (!name || name.trim().length === 0) {
    return { valid: false, reason: "State name cannot be empty." };
  }
  if (typeof name !== "string") {
    return { valid: false, reason: "State name must be a string." };
  }
  if (name.includes("\x00")) {
    return { valid: false, reason: "State name cannot contain null bytes." };
  }
  if (RESERVED_NAMES.has(name)) {
    return { valid: false, reason: `'${name}' is a reserved name.` };
  }
  if (INVALID_NAME_CHARS.test(name)) {
    return {
      valid: false,
      reason: `State name '${name}' contains invalid characters (/ \\ : * ? " < > |). Use dashes or underscores instead.`,
    };
  }
  if (name.length > 100) {
    return { valid: false, reason: "State name must be 100 characters or fewer." };
  }
  if (name.startsWith(".") || name.startsWith("-")) {
    return { valid: false, reason: `State name cannot start with '${name[0]}'.` };
  }
  return { valid: true, reason: "" };
}

/**
 * Resolve the on-disk directory for a state, enforcing that the resulting
 * path stays inside statesDir(projectRoot). Use this at every command entry
 * point that accepts a user-provided state name, before any filesystem
 * access, to prevent traversal via names like "../../etc/passwd".
 */
export function resolveStateDir(projectRoot: string, name: string): string {
  const check = validateStateName(name);
  if (!check.valid) {
    throw new Error(`Invalid state name: ${check.reason}`);
  }
  const base = path.resolve(paths.statesDir(projectRoot));
  const resolved = path.resolve(paths.stateDir(projectRoot, name));
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(
      `Invalid state name '${name}': resolved path escapes states directory`
    );
  }
  return resolved;
}

// --- Init ---

export async function ensureSavestateDir(projectRoot: string): Promise<void> {
  const dir = paths.savestateDir(projectRoot);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(paths.statesDir(projectRoot), { recursive: true });
  await fs.mkdir(paths.tmpDir(projectRoot), { recursive: true });

  // Write .gitignore if it doesn't exist
  const gitignore = paths.gitignorePath(projectRoot);
  try {
    await fs.access(gitignore);
  } catch {
    await writeFileAtomic(gitignore, "*\n");
  }
}

// --- Corruption quarantine ---
//
// When a persisted JSON file is unparseable or fails schema validation, we
// move it into .savestate/_corrupt/<ISO-timestamp>-<label>/ instead of
// deleting it. The user can inspect or hand-repair it later. This also
// prevents the F5 bug where a corrupt index.json was silently replaced by
// an empty one, orphaning every state.

function corruptDir(projectRoot: string): string {
  return path.join(paths.savestateDir(projectRoot), "_corrupt");
}

function quarantineTimestamp(): string {
  // ISO with colons replaced so the path is valid on Windows.
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Move a corrupt state directory into .savestate/_corrupt/. Best-effort —
 * if the quarantine move itself fails we surface the original error so the
 * caller knows *something* is wrong rather than swallowing the failure.
 * Returns the destination path (useful for the thrown error message) or
 * null on move failure.
 */
async function quarantineStateDir(
  projectRoot: string,
  name: string
): Promise<string | null> {
  const src = paths.stateDir(projectRoot, name);
  const dest = path.join(
    corruptDir(projectRoot),
    `${quarantineTimestamp()}-${name}`
  );
  try {
    await fs.mkdir(corruptDir(projectRoot), { recursive: true });
    await fs.rename(src, dest);
    return dest;
  } catch {
    return null;
  }
}

/**
 * Move a corrupt single file (index.json or _active.json) into
 * .savestate/_corrupt/. Same best-effort contract as quarantineStateDir.
 */
async function quarantineFile(
  projectRoot: string,
  absolutePath: string,
  label: string
): Promise<string | null> {
  const dest = path.join(
    corruptDir(projectRoot),
    `${quarantineTimestamp()}-${label}`
  );
  try {
    await fs.mkdir(corruptDir(projectRoot), { recursive: true });
    await fs.rename(absolutePath, dest);
    return dest;
  } catch {
    return null;
  }
}

// --- Index ---

export async function readIndex(projectRoot: string): Promise<IndexFile> {
  const p = paths.indexPath(projectRoot);
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf-8");
  } catch (err: any) {
    // ENOENT is the fresh-project / never-saved path — NOT corruption. Do
    // not quarantine; just return the empty index shape.
    if (err?.code === "ENOENT") {
      return { version: 2, states: [] };
    }
    throw err;
  }

  // Any failure past this point means the file exists but is unreadable as
  // an index. Quarantine it so we don't silently overwrite with an empty
  // index (F5), then surface a clear error.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (parseErr: any) {
    const dest = await quarantineFile(projectRoot, p, "index.json");
    throw new Error(
      `index.json is corrupt (JSON parse failed: ${parseErr?.message ?? "unknown"}). ` +
        (dest
          ? `Moved to ${dest}. `
          : `Could not quarantine the file. `) +
        `A fresh index will be written on the next save.`
    );
  }

  try {
    return migrateIndex(parsed) as IndexFile;
  } catch (validationErr: any) {
    const dest = await quarantineFile(projectRoot, p, "index.json");
    throw new Error(
      `index.json failed validation: ${validationErr?.message ?? "unknown"}. ` +
        (dest
          ? `Moved to ${dest}. `
          : `Could not quarantine the file. `) +
        `A fresh index will be written on the next save.`
    );
  }
}

export async function writeIndex(
  projectRoot: string,
  index: IndexFile
): Promise<void> {
  const p = paths.indexPath(projectRoot);
  await writeFileAtomic(p, JSON.stringify(index, null, 2) + "\n");
}

export function upsertIndexEntry(
  index: IndexFile,
  entry: IndexEntry
): IndexFile {
  const existing = index.states.findIndex((s) => s.name === entry.name);
  if (existing >= 0) {
    index.states[existing] = entry;
  } else {
    index.states.push(entry);
  }
  return index;
}

export function removeIndexEntry(index: IndexFile, name: string): IndexFile {
  index.states = index.states.filter((s) => s.name !== name);
  return index;
}

// --- State ---

export async function readState(
  projectRoot: string,
  name: string
): Promise<SaveState> {
  const p = paths.stateJsonPath(projectRoot, name);
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf-8");
  } catch (err: any) {
    // "Not found" is a user-facing error path (e.g. `dvs load ghost`); it
    // must stay distinguishable from corruption. The existing test suite
    // asserts the "not found" wording.
    if (err?.code === "ENOENT") {
      throw new Error(`State '${name}' not found or corrupt: ${err.message}`);
    }
    throw err;
  }

  // Any failure past this point is genuine corruption — quarantine the
  // whole state directory (not just state.json; note.md and git-patch.diff
  // may be relevant to a postmortem).
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (parseErr: any) {
    const dest = await quarantineStateDir(projectRoot, name);
    throw new Error(
      `State '${name}' is corrupt (JSON parse failed: ${parseErr?.message ?? "unknown"}). ` +
        (dest
          ? `Moved to ${dest}.`
          : `Could not quarantine the state directory.`)
    );
  }

  try {
    return migrateState(parsed) as SaveState;
  } catch (validationErr: any) {
    const dest = await quarantineStateDir(projectRoot, name);
    throw new Error(
      `State '${name}' failed validation: ${validationErr?.message ?? "unknown"}. ` +
        (dest
          ? `Moved to ${dest}.`
          : `Could not quarantine the state directory.`)
    );
  }
}

// --- Active heartbeat ---
//
// The heartbeat file at .savestate/_active.json is written by `dvs load`
// (see commands/recover.ts::writeHeartbeat) and read during crash recovery.
// Absence is benign — most of the time there is no active session. When the
// file exists but is unparseable we quarantine it and return null so the
// recovery flow treats this as "no heartbeat" rather than crashing.
export async function readActive(
  projectRoot: string
): Promise<ValidatedActiveState | null> {
  const p = path.join(paths.savestateDir(projectRoot), "_active.json");
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await quarantineFile(projectRoot, p, "_active.json");
    return null;
  }

  const result = ActiveStateSchema.safeParse(parsed);
  if (!result.success) {
    await quarantineFile(projectRoot, p, "_active.json");
    return null;
  }
  return result.data;
}

export async function stateExists(
  projectRoot: string,
  name: string
): Promise<boolean> {
  try {
    await fs.access(paths.stateJsonPath(projectRoot, name));
    return true;
  } catch {
    return false;
  }
}

// --- Atomic Save ---

/**
 * Optional hook invoked with the staging directory path so the caller can
 * drop additional files/subtrees (e.g. `untracked/`) before the atomic
 * rename. Any files written here are committed along with state.json on
 * success, or cleaned up with the staging dir on failure.
 */
export type StagingPopulator = (stagingDir: string) => Promise<void>;

export async function atomicSaveState(
  projectRoot: string,
  name: string,
  state: SaveState,
  patchContent: string,
  populateStaging?: StagingPopulator
): Promise<void> {
  const tmpBase = paths.tmpDir(projectRoot);
  const tmpId = crypto.randomUUID();
  const staging = path.join(tmpBase, tmpId);

  await fs.mkdir(staging, { recursive: true });

  try {
    // Write state.json
    await writeFileAtomic(
      path.join(staging, "state.json"),
      JSON.stringify(state, null, 2) + "\n"
    );

    // Write note.md
    let noteContent = `# ${name}\n\n${state.note}\n`;
    if (state.nextStep) {
      noteContent += `\n## Next Step\n\n${state.nextStep}\n`;
    }
    await writeFileAtomic(path.join(staging, "note.md"), noteContent);

    // Write git-patch.diff
    await writeFileAtomic(path.join(staging, "git-patch.diff"), patchContent);

    // Populate extra content (e.g. untracked/). Runs inside the same staging
    // dir so a failure here cleans up along with the JSON/note/patch writes.
    if (populateStaging) {
      await populateStaging(staging);
    }

    // Atomic rename: remove existing state dir if present, then rename
    const target = paths.stateDir(projectRoot, name);
    try {
      await fs.rm(target, { recursive: true, force: true });
    } catch {
      // Target doesn't exist, that's fine
    }
    await fs.rename(staging, target);

    // Update index (last step)
    const index = await readIndex(projectRoot);
    const entry: IndexEntry = {
      name,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      branch: state.git.branch,
      notePreview: state.note.slice(0, 100),
      archived: state.archived,
      tags: state.tags,
    };
    upsertIndexEntry(index, entry);
    await writeIndex(projectRoot, index);
  } catch (err) {
    // Cleanup staging on failure
    try {
      await fs.rm(staging, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
    throw err;
  }
}

// --- Delete ---

export async function deleteState(
  projectRoot: string,
  name: string
): Promise<void> {
  const dir = paths.stateDir(projectRoot, name);
  await fs.rm(dir, { recursive: true, force: true });

  const index = await readIndex(projectRoot);
  removeIndexEntry(index, name);
  await writeIndex(projectRoot, index);
}

// --- Locking ---

/**
 * Path to a companion PID marker written alongside the proper-lockfile lock.
 * proper-lockfile itself does not persist a PID; we write our own so that
 * `dvs unlock` can check whether the lock holder is still alive before
 * blowing it away.
 */
export function lockPidPath(projectRoot: string): string {
  return paths.lockPath(projectRoot) + ".pid";
}

export async function acquireLock(
  projectRoot: string
): Promise<() => Promise<void>> {
  const dir = paths.savestateDir(projectRoot);
  // proper-lockfile needs the target to exist
  await fs.mkdir(dir, { recursive: true });

  try {
    const release = await lockfile.lock(dir, {
      stale: 30000,
      update: 15000,
      retries: {
        retries: 3,
        minTimeout: 200,
        maxTimeout: 1000,
      },
      lockfilePath: paths.lockPath(projectRoot),
    });
    // Write PID marker. Best-effort; if this fails we still hold the lock.
    try {
      await writeFileAtomic(lockPidPath(projectRoot), String(process.pid));
    } catch {
      // Ignore — the lock itself is the authoritative state.
    }
    // Wrap release to clean up the marker.
    return async () => {
      try {
        await fs.unlink(lockPidPath(projectRoot));
      } catch {
        // Already gone
      }
      await release();
    };
  } catch (err: any) {
    if (err.code === "ELOCKED") {
      throw new Error(
        "Another dvs operation is currently running. If this is stale, run: dvs unlock"
      );
    }
    throw err;
  }
}

// --- Stale Tmp Cleanup ---

export async function cleanStaleTmpDirs(projectRoot: string): Promise<void> {
  const tmp = paths.tmpDir(projectRoot);
  try {
    const entries = await fs.readdir(tmp);
    const now = Date.now();
    const ONE_DAY = 24 * 60 * 60 * 1000;

    for (const entry of entries) {
      const entryPath = path.join(tmp, entry);
      try {
        const stat = await fs.stat(entryPath);
        if (stat.isDirectory() && now - stat.mtimeMs > ONE_DAY) {
          await fs.rm(entryPath, { recursive: true, force: true });
        }
      } catch {
        // Skip entries we can't stat
      }
    }
  } catch {
    // _tmp doesn't exist yet, that's fine
  }
}

// --- Hash ---

export function computeHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// --- Orphan Recovery ---

export async function recoverOrphans(projectRoot: string): Promise<string[]> {
  const recovered: string[] = [];
  const futureVersion: string[] = [];
  const sDir = paths.statesDir(projectRoot);
  const index = await readIndex(projectRoot);

  try {
    const entries = await fs.readdir(sDir);
    const indexedNames = new Set(index.states.map((s) => s.name));

    for (const entry of entries) {
      if (entry.startsWith("_")) continue; // skip _quicksaves etc.
      if (indexedNames.has(entry)) continue;

      // Check if it's a valid state directory
      const stateJsonFile = paths.stateJsonPath(projectRoot, entry);
      try {
        const raw = await fs.readFile(stateJsonFile, "utf-8");
        const parsed = JSON.parse(raw);
        // Run through the same validator the hot path uses so we don't
        // re-index malformed or future-version payloads. Unlike readState()
        // we do NOT quarantine here — an orphan may be recoverable via
        // manual inspection, and moving it would make that harder.
        const state = migrateState(parsed) as SaveState;

        // Valid — add to index
        const indexEntry: IndexEntry = {
          name: state.name,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt,
          branch: state.git.branch,
          notePreview: state.note.slice(0, 100),
          archived: state.archived,
          tags: state.tags,
        };
        upsertIndexEntry(index, indexEntry);
        recovered.push(entry);
      } catch (err) {
        // Invalid state.json — skip, don't delete. Differentiate
        // newer-CLI payloads so the user knows they need to upgrade
        // rather than assuming the file is corrupt.
        if (err instanceof SchemaVersionError) {
          futureVersion.push(entry);
        }
      }
    }

    if (recovered.length > 0) {
      await writeIndex(projectRoot, index);
    }

    if (futureVersion.length > 0) {
      const names = futureVersion.join(", ");
      console.warn(
        `Skipped ${futureVersion.length} orphan(s) written by a newer dvs: ${names}. Upgrade with \`npm i -g dev-savestate@latest\` to recover.`
      );
    }
  } catch {
    // states/ doesn't exist yet
  }

  return recovered;
}
