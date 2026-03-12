import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import simpleGit from "simple-git";
import {
  ensureSavestateDir,
  atomicSaveState,
  readState,
  readIndex,
  deleteState,
  acquireLock,
  computeHash,
  recoverOrphans,
  stateExists,
} from "../lib/storage.js";
import {
  findProjectRoot,
  createGit,
  getBranch,
  getCommitHash,
  isDirty,
  getDiff,
  checkoutBranch,
  applyPatch,
  stashChanges,
} from "../lib/git.js";
import { patchPath, stateDir, stateJsonPath } from "../lib/paths.js";
import type { SaveState } from "../lib/types.js";

let testDir: string;

async function createTestRepo(): Promise<string> {
  const dir = path.join(os.tmpdir(), `dvs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig("user.email", "test@test.com");
  await git.addConfig("user.name", "Test");
  // Create initial commit
  const filePath = path.join(dir, "main.txt");
  await fs.writeFile(filePath, "initial content\n");
  await git.add("main.txt");
  await git.commit("initial commit");
  return dir;
}

function buildState(
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
    note: overrides.note || "test note",
    nextStep: overrides.nextStep,
    git: overrides.git || {
      branch: "master",
      commitHash: "abc123",
      hasUncommittedChanges: false,
      patchFile: "git-patch.diff",
      patchHash: computeHash(""),
    },
    archived: false,
    loadCount: 0,
    ...overrides,
  };
}

beforeEach(async () => {
  testDir = await createTestRepo();
});

afterEach(async () => {
  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch {
    // Windows sometimes holds file locks briefly
  }
});

describe("dvs save and load", () => {
  it("should round-trip save and load with dirty tree", async () => {
    const git = createGit(testDir);
    await ensureSavestateDir(testDir);

    // Dirty the tree
    await fs.writeFile(path.join(testDir, "main.txt"), "modified content\n");

    // Capture state
    const branch = await getBranch(git);
    const commitHash = await getCommitHash(git);
    const patchContent = await getDiff(git);

    expect(patchContent).toBeTruthy();

    const state = buildState("test-roundtrip", testDir, {
      note: "Round trip test",
      git: {
        branch,
        commitHash,
        hasUncommittedChanges: true,
        patchFile: "git-patch.diff",
        patchHash: computeHash(patchContent),
      },
    });

    await atomicSaveState(testDir, "test-roundtrip", state, patchContent);

    // Reset tree
    await git.checkout(["--", "."]);
    const content = await fs.readFile(path.join(testDir, "main.txt"), "utf-8");
    expect(content.trim()).toBe("initial content");

    // Load — apply patch
    const patch = patchPath(testDir, "test-roundtrip");
    const result = await applyPatch(git, patch);
    expect(result.applied).toBe(true);

    // Verify restored content
    const restored = await fs.readFile(path.join(testDir, "main.txt"), "utf-8");
    expect(restored.trim()).toBe("modified content");
  });

  it("should list saved states sorted by recency", async () => {
    await ensureSavestateDir(testDir);

    const state1 = buildState("alpha", testDir, {
      createdAt: "2026-03-09T10:00:00Z",
      updatedAt: "2026-03-09T10:00:00Z",
    });
    const state2 = buildState("beta", testDir, {
      createdAt: "2026-03-09T11:00:00Z",
      updatedAt: "2026-03-09T11:00:00Z",
    });

    await atomicSaveState(testDir, "alpha", state1, "");
    await atomicSaveState(testDir, "beta", state2, "");

    const index = await readIndex(testDir);
    expect(index.states).toHaveLength(2);

    const names = index.states.map((s) => s.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
  });

  it("should delete a state and remove from index", async () => {
    await ensureSavestateDir(testDir);

    const state = buildState("to-delete", testDir);
    await atomicSaveState(testDir, "to-delete", state, "");

    expect(await stateExists(testDir, "to-delete")).toBe(true);

    await deleteState(testDir, "to-delete");

    expect(await stateExists(testDir, "to-delete")).toBe(false);
    const index = await readIndex(testDir);
    expect(index.states).toHaveLength(0);
  });

  it("should detect already-applied patch (idempotent load)", async () => {
    const git = createGit(testDir);
    await ensureSavestateDir(testDir);

    // Dirty and save
    await fs.writeFile(path.join(testDir, "main.txt"), "changed\n");
    const patchContent = await getDiff(git);
    const state = buildState("idempotent", testDir, {
      git: {
        branch: await getBranch(git),
        commitHash: await getCommitHash(git),
        hasUncommittedChanges: true,
        patchFile: "git-patch.diff",
        patchHash: computeHash(patchContent),
      },
    });
    await atomicSaveState(testDir, "idempotent", state, patchContent);

    // Don't reset — patch is already the current state
    const patch = patchPath(testDir, "idempotent");
    const result = await applyPatch(git, patch);
    expect(result.alreadyApplied).toBe(true);
    expect(result.applied).toBe(false);
  });

  it("should checkout branch on load", async () => {
    const git = createGit(testDir);
    await ensureSavestateDir(testDir);

    // Create and switch to feature branch
    await git.checkoutLocalBranch("feature");
    await fs.writeFile(path.join(testDir, "feature.txt"), "feature\n");
    await git.add("feature.txt");
    await git.commit("feature commit");

    const branch = await getBranch(git);
    expect(branch).toBe("feature");

    // Save state
    const state = buildState("on-feature", testDir, {
      git: {
        branch: "feature",
        commitHash: await getCommitHash(git),
        hasUncommittedChanges: false,
        patchFile: "git-patch.diff",
        patchHash: computeHash(""),
      },
    });
    await atomicSaveState(testDir, "on-feature", state, "");

    // Switch back to master
    await git.checkout("master");
    expect(await getBranch(git)).toBe("master");

    // Load — should checkout feature
    const result = await checkoutBranch(git, "feature");
    expect(result.success).toBe(true);
    expect(await getBranch(git)).toBe("feature");
  });

  it("should create state.json, note.md, and git-patch.diff", async () => {
    await ensureSavestateDir(testDir);

    const state = buildState("file-check", testDir, { note: "checking files" });
    await atomicSaveState(testDir, "file-check", state, "patch content");

    const dir = stateDir(testDir, "file-check");
    const files = await fs.readdir(dir);
    expect(files).toContain("state.json");
    expect(files).toContain("note.md");
    expect(files).toContain("git-patch.diff");

    const noteContent = await fs.readFile(path.join(dir, "note.md"), "utf-8");
    expect(noteContent).toContain("checking files");
  });

  it("should recover orphaned state directories", async () => {
    await ensureSavestateDir(testDir);

    // Create a state normally
    const state = buildState("orphan-test", testDir);
    await atomicSaveState(testDir, "orphan-test", state, "");

    // Manually remove from index (simulating crash between rename and index write)
    const indexPath = path.join(testDir, ".savestate", "index.json");
    await fs.writeFile(indexPath, JSON.stringify({ version: 1, states: [] }));

    // Verify index is empty
    const indexBefore = await readIndex(testDir);
    expect(indexBefore.states).toHaveLength(0);

    // Recover
    const recovered = await recoverOrphans(testDir);
    expect(recovered).toContain("orphan-test");

    // Verify index has it back
    const indexAfter = await readIndex(testDir);
    expect(indexAfter.states).toHaveLength(1);
    expect(indexAfter.states[0].name).toBe("orphan-test");
  });
});
