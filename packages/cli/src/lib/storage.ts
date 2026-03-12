import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import writeFileAtomic from "write-file-atomic";
import lockfile from "proper-lockfile";
import type { SaveState, IndexFile, IndexEntry } from "./types.js";
import * as paths from "./paths.js";

// --- Name Validation ---

const INVALID_NAME_CHARS = /[\/\\:*?"<>|]/;
const RESERVED_NAMES = new Set([".", "..", "_tmp", "_autosaves", "_quicksaves"]);

export function validateStateName(name: string): { valid: boolean; reason: string } {
  if (!name || name.trim().length === 0) {
    return { valid: false, reason: "State name cannot be empty." };
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

// --- Index ---

export async function readIndex(projectRoot: string): Promise<IndexFile> {
  const p = paths.indexPath(projectRoot);
  try {
    const raw = await fs.readFile(p, "utf-8");
    return JSON.parse(raw) as IndexFile;
  } catch {
    return { version: 1, states: [] };
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
  try {
    const raw = await fs.readFile(p, "utf-8");
    return JSON.parse(raw) as SaveState;
  } catch (err: any) {
    throw new Error(`State '${name}' not found or corrupt: ${err.message}`);
  }
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

export async function atomicSaveState(
  projectRoot: string,
  name: string,
  state: SaveState,
  patchContent: string
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
    return release;
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
        const state = JSON.parse(raw) as SaveState;

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
      } catch {
        // Invalid state.json — skip, don't delete
      }
    }

    if (recovered.length > 0) {
      await writeIndex(projectRoot, index);
    }
  } catch {
    // states/ doesn't exist yet
  }

  return recovered;
}
