import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  ensureSavestateDir,
  atomicSaveState,
  readState,
  readIndex,
  readActive,
  computeHash,
} from "../lib/storage.js";
import {
  migrateState,
  migrateIndex,
  SchemaVersionError,
  SchemaValidationError,
} from "../lib/migrations/index.js";
import {
  SaveStateSchema,
  IndexFileSchema,
  ActiveStateSchema,
  ProjectConfigSchema,
  CURRENT_SCHEMA_VERSION,
} from "../lib/schemas.js";
import {
  stateMigrations,
  indexMigrations,
} from "../lib/migrations/registry.js";
import * as paths from "../lib/paths.js";
import type { SaveState } from "../lib/types.js";

let testDir: string;

async function mkTestDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `dvs-schema-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function buildValidState(
  name: string,
  projectRoot: string,
  overrides: Partial<SaveState> = {}
): SaveState {
  const now = new Date().toISOString();
  return {
    version: 1,
    name,
    createdAt: now,
    updatedAt: now,
    projectRoot,
    note: "schema test",
    tags: [],
    git: {
      branch: "master",
      commitHash: "abc123",
      hasUncommittedChanges: false,
      patchFile: "git-patch.diff",
      patchHash: computeHash(""),
    },
    processes: [],
    archived: false,
    loadCount: 0,
    ...overrides,
  };
}

beforeEach(async () => {
  testDir = await mkTestDir();
});

afterEach(async () => {
  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch {
    // Windows file lock windows
  }
});

// ============================================================
// Schema sanity — each shape parses its canonical form
// ============================================================

describe("schemas parse canonical payloads", () => {
  it("SaveStateSchema parses a full v1 state", () => {
    const state = buildValidState("canonical", "/fake/path", {
      nextStep: "take a break",
      tags: ["feature", "auth"],
      editor: {
        openFiles: [
          {
            relativePath: "src/a.ts",
            cursorLine: 10,
            cursorColumn: 4,
            viewColumn: 1,
          },
        ],
        activeFile: "src/a.ts",
      },
      processes: [
        {
          name: "dev",
          command: "npm",
          args: ["run", "dev"],
          cwd: "/fake/path",
          port: 3000,
          source: "dvs-run",
        },
      ],
      lastLoadedAt: new Date().toISOString(),
      loadCount: 3,
    });
    const result = SaveStateSchema.safeParse(state);
    expect(result.success).toBe(true);
  });

  it("IndexFileSchema parses an empty index", () => {
    expect(IndexFileSchema.safeParse({ version: 1, states: [] }).success).toBe(
      true
    );
  });

  it("ActiveStateSchema accepts a numeric heartbeat (epoch ms)", () => {
    const ok = ActiveStateSchema.safeParse({
      stateName: "wip",
      lastHeartbeat: Date.now(),
      pid: 12345,
    });
    expect(ok.success).toBe(true);
  });

  it("ActiveStateSchema accepts an ISO-string heartbeat (current CLI writes this)", () => {
    const ok = ActiveStateSchema.safeParse({
      stateName: "wip",
      lastHeartbeat: "2026-04-20T00:00:00Z",
      pid: 12345,
    });
    expect(ok.success).toBe(true);
  });

  it("ActiveStateSchema rejects a non-string non-number heartbeat", () => {
    const bad = ActiveStateSchema.safeParse({
      stateName: "wip",
      lastHeartbeat: { millis: 0 },
      pid: 12345,
    });
    expect(bad.success).toBe(false);
  });

  it("ActiveStateSchema rejects unknown fields (strict)", () => {
    const bad = ActiveStateSchema.safeParse({
      stateName: "wip",
      lastHeartbeat: 1,
      pid: 1,
      extra: "nope",
    });
    expect(bad.success).toBe(false);
  });

  it("ProjectConfigSchema accepts an empty object", () => {
    expect(ProjectConfigSchema.safeParse({}).success).toBe(true);
  });

  it("ProjectConfigSchema accepts a full command list", () => {
    const ok = ProjectConfigSchema.safeParse({
      processes: {
        commands: [{ name: "dev", command: "npm run dev", port: 3000 }],
      },
      promptNextStep: true,
    });
    expect(ok.success).toBe(true);
  });
});

// ============================================================
// readState — validation + quarantine
// ============================================================

describe("readState validation and quarantine", () => {
  it("reads a valid v1 state through the migration pipeline", async () => {
    await ensureSavestateDir(testDir);
    const state = buildValidState("valid", testDir, { note: "hello" });
    await atomicSaveState(testDir, "valid", state, "");

    const loaded = await readState(testDir, "valid");
    expect(loaded.name).toBe("valid");
    expect(loaded.note).toBe("hello");
    expect(loaded.version).toBe(1);
  });

  it("quarantines and throws on truncated JSON in state.json", async () => {
    await ensureSavestateDir(testDir);
    const state = buildValidState("corrupt-json", testDir);
    await atomicSaveState(testDir, "corrupt-json", state, "");

    // Truncate the file — not valid JSON
    const p = paths.stateJsonPath(testDir, "corrupt-json");
    await fs.writeFile(p, '{"version": 1, "name": "cor');

    await expect(readState(testDir, "corrupt-json")).rejects.toThrow(
      /corrupt/i
    );

    // Source directory should be gone (quarantined)
    const stateDirExists = await fs
      .access(paths.stateDir(testDir, "corrupt-json"))
      .then(() => true)
      .catch(() => false);
    expect(stateDirExists).toBe(false);

    // _corrupt/ should now contain a subdir ending with "-corrupt-json"
    const corruptRoot = path.join(testDir, ".savestate", "_corrupt");
    const entries = await fs.readdir(corruptRoot);
    expect(entries.some((e) => e.endsWith("-corrupt-json"))).toBe(true);
  });

  it("quarantines and throws on valid JSON missing required fields", async () => {
    await ensureSavestateDir(testDir);
    const state = buildValidState("missing-fields", testDir);
    await atomicSaveState(testDir, "missing-fields", state, "");

    // Strip the `git` object entirely — required, so Zod must refuse
    const p = paths.stateJsonPath(testDir, "missing-fields");
    await fs.writeFile(
      p,
      JSON.stringify(
        {
          version: 1,
          name: "missing-fields",
          // no git, no projectRoot, no note, no tags, etc.
        },
        null,
        2
      )
    );

    await expect(readState(testDir, "missing-fields")).rejects.toThrow(
      /validation/i
    );

    const corruptRoot = path.join(testDir, ".savestate", "_corrupt");
    const entries = await fs.readdir(corruptRoot);
    expect(entries.some((e) => e.endsWith("-missing-fields"))).toBe(true);
  });

  it("keeps the 'not found' error path for ENOENT (no quarantine)", async () => {
    await ensureSavestateDir(testDir);
    await expect(readState(testDir, "ghost-state")).rejects.toThrow(
      /not found/i
    );

    // No _corrupt dir should have been created for a non-existent state
    const corruptRoot = path.join(testDir, ".savestate", "_corrupt");
    const corruptExists = await fs
      .access(corruptRoot)
      .then(() => true)
      .catch(() => false);
    expect(corruptExists).toBe(false);
  });
});

// ============================================================
// readIndex — ENOENT vs corruption
// ============================================================

describe("readIndex ENOENT vs corruption", () => {
  it("returns empty on ENOENT (no quarantine, no throw)", async () => {
    // Don't even call ensureSavestateDir — true fresh-project path
    const idx = await readIndex(testDir);
    expect(idx.version).toBe(1);
    expect(idx.states).toHaveLength(0);

    const corruptRoot = path.join(testDir, ".savestate", "_corrupt");
    const exists = await fs
      .access(corruptRoot)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("quarantines and throws on unparseable JSON", async () => {
    await ensureSavestateDir(testDir);
    const p = paths.indexPath(testDir);
    await fs.writeFile(p, "this is not JSON at all {{{");

    await expect(readIndex(testDir)).rejects.toThrow(/corrupt|parse/i);

    // The file itself should now be gone from its original path
    const stillThere = await fs
      .access(p)
      .then(() => true)
      .catch(() => false);
    expect(stillThere).toBe(false);

    // And a matching file should be in _corrupt
    const corruptRoot = path.join(testDir, ".savestate", "_corrupt");
    const entries = await fs.readdir(corruptRoot);
    expect(entries.some((e) => e.endsWith("-index.json"))).toBe(true);
  });

  it("quarantines and throws on valid JSON that fails schema (e.g. states is not an array)", async () => {
    await ensureSavestateDir(testDir);
    const p = paths.indexPath(testDir);
    await fs.writeFile(p, JSON.stringify({ version: 1, states: "nope" }));

    await expect(readIndex(testDir)).rejects.toThrow(/validation/i);
  });

  it("after a quarantine, a second read with a valid file succeeds", async () => {
    await ensureSavestateDir(testDir);
    const p = paths.indexPath(testDir);

    // First: break it, trigger quarantine.
    await fs.writeFile(p, "broken {");
    await expect(readIndex(testDir)).rejects.toThrow();

    // Second: write a valid index and re-read.
    await fs.writeFile(
      p,
      JSON.stringify({ version: 1, states: [] }, null, 2)
    );
    const idx = await readIndex(testDir);
    expect(idx.states).toHaveLength(0);
  });
});

// ============================================================
// readActive — benign absence, quarantine on corruption
// ============================================================

describe("readActive", () => {
  it("returns null when _active.json is missing", async () => {
    await ensureSavestateDir(testDir);
    const got = await readActive(testDir);
    expect(got).toBeNull();
  });

  it("returns the parsed heartbeat on a valid ISO-string payload (current CLI shape)", async () => {
    await ensureSavestateDir(testDir);
    const activePath = path.join(testDir, ".savestate", "_active.json");
    await fs.writeFile(
      activePath,
      JSON.stringify({
        stateName: "wip",
        lastHeartbeat: "2026-04-20T12:00:00.000Z",
        pid: 42,
      })
    );
    const got = await readActive(testDir);
    expect(got).toEqual({
      stateName: "wip",
      lastHeartbeat: "2026-04-20T12:00:00.000Z",
      pid: 42,
    });
  });

  it("returns the parsed heartbeat on a valid numeric payload (future shape)", async () => {
    await ensureSavestateDir(testDir);
    const activePath = path.join(testDir, ".savestate", "_active.json");
    await fs.writeFile(
      activePath,
      JSON.stringify({
        stateName: "wip",
        lastHeartbeat: 1700000000000,
        pid: 42,
      })
    );
    const got = await readActive(testDir);
    expect(got).toEqual({
      stateName: "wip",
      lastHeartbeat: 1700000000000,
      pid: 42,
    });
  });

  it("quarantines and returns null on unparseable content", async () => {
    await ensureSavestateDir(testDir);
    const activePath = path.join(testDir, ".savestate", "_active.json");
    await fs.writeFile(activePath, "garbage");
    const got = await readActive(testDir);
    expect(got).toBeNull();

    const corruptRoot = path.join(testDir, ".savestate", "_corrupt");
    const entries = await fs.readdir(corruptRoot);
    expect(entries.some((e) => e.endsWith("-_active.json"))).toBe(true);
  });

  it("quarantines and returns null on schema mismatch (unknown extra field)", async () => {
    await ensureSavestateDir(testDir);
    const activePath = path.join(testDir, ".savestate", "_active.json");
    await fs.writeFile(
      activePath,
      JSON.stringify({
        stateName: "wip",
        lastHeartbeat: Date.now(),
        pid: 42,
        tampered: true,
      })
    );
    const got = await readActive(testDir);
    expect(got).toBeNull();

    const corruptRoot = path.join(testDir, ".savestate", "_corrupt");
    const entries = await fs.readdir(corruptRoot);
    expect(entries.some((e) => e.endsWith("-_active.json"))).toBe(true);
  });
});

// ============================================================
// migrateState / migrateIndex
// ============================================================

describe("migrateState version handling", () => {
  it("returns shape-equal output for a valid v1 state (zero-migration identity)", () => {
    const state = buildValidState("identity", "/fake/path");
    const out = migrateState(state);
    expect(out).toEqual(state);
  });

  it("throws SchemaVersionError on a synthetic v99 payload", () => {
    const futureState = { ...buildValidState("future", "/p"), version: 99 };
    expect(() => migrateState(futureState)).toThrow(SchemaVersionError);
    try {
      migrateState(futureState);
    } catch (err: any) {
      expect(err.message).toMatch(/newer dvs CLI/);
      expect(err.message).toMatch(/npm i -g dev-savestate/);
    }
  });

  it("throws SchemaValidationError with useful Zod issues", () => {
    expect(() =>
      migrateState({ version: 1, name: 42, note: "wrong type" })
    ).toThrow(SchemaValidationError);
  });

  it("preserves unknown fields on a passthrough schema (forward compatibility)", () => {
    // Simulate a newer *same-version* payload that added an optional field.
    // Passthrough schemas should round-trip it rather than stripping.
    const withExtra = {
      ...buildValidState("extra", "/p"),
      parentStateId: "some-other-state",
    };
    const out = migrateState(withExtra) as typeof withExtra;
    expect(out.parentStateId).toBe("some-other-state");
  });
});

describe("migrateIndex version handling", () => {
  it("returns shape-equal output for a valid v1 index", () => {
    const idx = { version: 1, states: [] };
    const out = migrateIndex(idx);
    expect(out).toEqual(idx);
  });

  it("throws SchemaVersionError on future-version index", () => {
    expect(() => migrateIndex({ version: 42, states: [] })).toThrow(
      SchemaVersionError
    );
  });
});

// ============================================================
// Registry scaffold
// ============================================================

describe("migration registry scaffold", () => {
  it("is empty at CURRENT_SCHEMA_VERSION = 1 (no migrations needed yet)", () => {
    // Sanity: the scaffold ships with no migrations because v1 is current.
    // When we bump to v2, we expect stateMigrations[1] to be populated.
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
    expect(Object.keys(stateMigrations)).toHaveLength(0);
    expect(Object.keys(indexMigrations)).toHaveLength(0);
  });

  it("applying zero migrations returns a valid payload unchanged (identity property)", () => {
    const state = buildValidState("zero-mig", "/p");
    expect(migrateState(state)).toEqual(state);
    const idx = { version: 1, states: [] };
    expect(migrateIndex(idx)).toEqual(idx);
  });
});
