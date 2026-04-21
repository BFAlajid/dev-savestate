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
    version: 2,
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
    untracked: { files: [] },
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
  it("SaveStateSchema parses a full v2 state (with untracked manifest)", () => {
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
    expect(IndexFileSchema.safeParse({ version: 2, states: [] }).success).toBe(
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
  it("reads a valid v2 state through the migration pipeline", async () => {
    await ensureSavestateDir(testDir);
    const state = buildValidState("valid", testDir, { note: "hello" });
    await atomicSaveState(testDir, "valid", state, "");

    const loaded = await readState(testDir, "valid");
    expect(loaded.name).toBe("valid");
    expect(loaded.note).toBe("hello");
    expect(loaded.version).toBe(2);
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
    expect(idx.version).toBe(2);
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
  it("returns shape-equal output for a valid v2 state (zero-migration identity)", () => {
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
      migrateState({ version: 2, name: 42, note: "wrong type" })
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
  it("returns shape-equal output for a valid v2 index", () => {
    const idx = { version: 2, states: [] };
    const out = migrateIndex(idx);
    expect(out).toEqual(idx);
  });

  it("upgrades a v1 index to v2 via the registered no-op bump", () => {
    const v1 = { version: 1, states: [] };
    const out = migrateIndex(v1);
    expect(out.version).toBe(2);
    expect(out.states).toEqual([]);
  });

  it("throws SchemaVersionError on future-version index", () => {
    expect(() => migrateIndex({ version: 42, states: [] })).toThrow(
      SchemaVersionError
    );
  });
});

// ============================================================
// Registry: v1 → v2 migration (first real migration)
// ============================================================

describe("v1 → v2 state migration", () => {
  it("CURRENT_SCHEMA_VERSION is 2 and state migration 1→2 is registered", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(2);
    expect(typeof stateMigrations[1]).toBe("function");
    expect(typeof indexMigrations[1]).toBe("function");
  });

  it("migrates a synthetic v1 state payload, filling in empty untracked manifest", () => {
    // Simulate what a v1 state.json would look like on disk: version 1,
    // no `untracked` field. The migration must add `{ files: [] }` and
    // bump version so the payload passes the v2 Zod schema.
    const v1Raw = {
      version: 1,
      name: "old-save",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      projectRoot: "/fake/path",
      note: "pre-v2 save",
      tags: [],
      git: {
        branch: "master",
        commitHash: "deadbeef",
        hasUncommittedChanges: false,
        patchFile: "git-patch.diff",
        patchHash: computeHash(""),
      },
      processes: [],
      archived: false,
      loadCount: 0,
    };
    const out = migrateState(v1Raw);
    expect(out.version).toBe(2);
    // The critical assertion: new `untracked` field is present and empty.
    expect((out as any).untracked).toEqual({ files: [] });
    // All v1 fields preserved verbatim.
    expect(out.name).toBe("old-save");
    expect(out.note).toBe("pre-v2 save");
    expect(out.git.branch).toBe("master");
  });

  it("reads a synthetic v1 state.json off disk → returns v2-shaped state", async () => {
    await ensureSavestateDir(testDir);
    // Manually write a v1-shaped state.json into the expected layout.
    const stateDirPath = paths.stateDir(testDir, "legacy");
    await fs.mkdir(stateDirPath, { recursive: true });
    const v1Payload = {
      version: 1,
      name: "legacy",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      projectRoot: testDir,
      note: "pre-v2 payload",
      tags: [],
      git: {
        branch: "master",
        commitHash: "deadbeef",
        hasUncommittedChanges: false,
        patchFile: "git-patch.diff",
        patchHash: computeHash(""),
      },
      processes: [],
      archived: false,
      loadCount: 0,
    };
    await fs.writeFile(
      paths.stateJsonPath(testDir, "legacy"),
      JSON.stringify(v1Payload, null, 2)
    );
    // Supporting files so readState doesn't trip on missing artifacts.
    await fs.writeFile(path.join(stateDirPath, "note.md"), "# legacy\n");
    await fs.writeFile(path.join(stateDirPath, "git-patch.diff"), "");

    const loaded = await readState(testDir, "legacy");
    expect(loaded.version).toBe(2);
    expect(loaded.untracked).toEqual({ files: [] });
    expect(loaded.note).toBe("pre-v2 payload");
  });

  it("re-saving a migrated v1 state writes v2 on disk", async () => {
    await ensureSavestateDir(testDir);
    // Seed a v1 payload on disk.
    const stateDirPath = paths.stateDir(testDir, "upgraded");
    await fs.mkdir(stateDirPath, { recursive: true });
    const v1Payload = {
      version: 1,
      name: "upgraded",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      projectRoot: testDir,
      note: "to be upgraded",
      tags: [],
      git: {
        branch: "master",
        commitHash: "deadbeef",
        hasUncommittedChanges: false,
        patchFile: "git-patch.diff",
        patchHash: computeHash(""),
      },
      processes: [],
      archived: false,
      loadCount: 0,
    };
    await fs.writeFile(
      paths.stateJsonPath(testDir, "upgraded"),
      JSON.stringify(v1Payload, null, 2)
    );
    await fs.writeFile(path.join(stateDirPath, "note.md"), "# upgraded\n");
    await fs.writeFile(path.join(stateDirPath, "git-patch.diff"), "");

    // Read-through-migration.
    const migrated = await readState(testDir, "upgraded");
    expect(migrated.version).toBe(2);

    // Re-save it. This is the second half of the round-trip: the migrated
    // in-memory state is written back verbatim.
    await atomicSaveState(testDir, "upgraded", migrated, "");

    // Inspect the on-disk JSON directly — not via readState, since readState
    // would just re-run the migration and mask a stale value.
    const rawOnDisk = await fs.readFile(
      paths.stateJsonPath(testDir, "upgraded"),
      "utf-8"
    );
    const parsed = JSON.parse(rawOnDisk);
    expect(parsed.version).toBe(2);
    expect(parsed.untracked).toEqual({ files: [] });
  });
});
