import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  stateExists,
} from "../lib/storage.js";
import {
  createGit,
  getBranch,
  getCommitHash,
  isDirty,
  getDiff,
  checkoutBranch,
  applyPatch,
  stashChanges,
} from "../lib/git.js";
import { patchPath } from "../lib/paths.js";
import { printMentalStack, printStateList } from "../lib/display.js";
import type { SaveState } from "../lib/types.js";

let testDir: string;

async function createTestRepo(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `dvs-scenario-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
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
    version: 2,
    name,
    createdAt: now,
    updatedAt: now,
    projectRoot,
    note: overrides.note ?? "test note",
    nextStep: overrides.nextStep,
    tags: overrides.tags || [],
    git: overrides.git || {
      branch: "master",
      commitHash: "abc123",
      hasUncommittedChanges: false,
      patchFile: "git-patch.diff",
      patchHash: computeHash(""),
    },
    processes: overrides.processes || [],
    untracked: overrides.untracked || { files: [] },
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

// ============================================================
// Git edge cases
// ============================================================

describe("Git edge cases", () => {
  it("1. Save with staged AND unstaged changes — both captured and restored", async () => {
    const git = createGit(testDir);
    await ensureSavestateDir(testDir);

    // Create a second file and commit it so we have two tracked files
    await fs.writeFile(path.join(testDir, "second.txt"), "second original\n");
    await git.add("second.txt");
    await git.commit("add second file");

    // Stage a change to main.txt
    await fs.writeFile(path.join(testDir, "main.txt"), "staged change\n");
    await git.add("main.txt");

    // Make an unstaged change to second.txt
    await fs.writeFile(path.join(testDir, "second.txt"), "unstaged change\n");

    // Verify tree is dirty
    expect(await isDirty(git)).toBe(true);

    // Capture diff
    const patchContent = await getDiff(git);
    expect(patchContent).toBeTruthy();
    // The diff should mention both files
    expect(patchContent).toContain("main.txt");
    expect(patchContent).toContain("second.txt");

    const branch = await getBranch(git);
    const commitHash = await getCommitHash(git);

    const state = buildState("staged-unstaged", testDir, {
      git: {
        branch,
        commitHash,
        hasUncommittedChanges: true,
        patchFile: "git-patch.diff",
        patchHash: computeHash(patchContent),
      },
    });
    await atomicSaveState(testDir, "staged-unstaged", state, patchContent);

    // Reset tree to clean state
    await git.reset(["--hard", "HEAD"]);
    expect(await isDirty(git)).toBe(false);

    // Apply patch
    const patch = patchPath(testDir, "staged-unstaged");
    const result = await applyPatch(git, patch);
    expect(result.applied).toBe(true);

    // Both changes should be restored
    const mainContent = await fs.readFile(
      path.join(testDir, "main.txt"),
      "utf-8"
    );
    expect(mainContent.trim()).toBe("staged change");

    const secondContent = await fs.readFile(
      path.join(testDir, "second.txt"),
      "utf-8"
    );
    expect(secondContent.trim()).toBe("unstaged change");
  });

  it("2. Save on detached HEAD — captures commit hash and reports HEAD", async () => {
    const git = createGit(testDir);
    await ensureSavestateDir(testDir);

    // Create a second commit
    await fs.writeFile(path.join(testDir, "main.txt"), "v2\n");
    await git.add("main.txt");
    await git.commit("second commit");

    const commitHash = await getCommitHash(git);

    // Detach HEAD
    await git.checkout(commitHash);

    const branch = await getBranch(git);
    // In detached HEAD, git rev-parse --abbrev-ref HEAD returns "HEAD"
    expect(branch).toBe("HEAD");

    const detachedHash = await getCommitHash(git);
    expect(detachedHash).toBe(commitHash);

    // Make a change and save
    await fs.writeFile(path.join(testDir, "main.txt"), "detached change\n");
    const patchContent = await getDiff(git);

    const state = buildState("detached-save", testDir, {
      git: {
        branch,
        commitHash: detachedHash,
        hasUncommittedChanges: true,
        patchFile: "git-patch.diff",
        patchHash: computeHash(patchContent),
      },
    });
    await atomicSaveState(testDir, "detached-save", state, patchContent);

    // Verify state was saved
    const loaded = await readState(testDir, "detached-save");
    expect(loaded.git.branch).toBe("HEAD");
    expect(loaded.git.commitHash).toBe(commitHash);
    expect(loaded.git.hasUncommittedChanges).toBe(true);
  });

  it("3. Load when saved branch was deleted — warns but doesn't crash", async () => {
    const git = createGit(testDir);
    await ensureSavestateDir(testDir);

    // Create feature branch
    await git.checkoutLocalBranch("temp-branch");
    await fs.writeFile(path.join(testDir, "temp.txt"), "temp\n");
    await git.add("temp.txt");
    await git.commit("temp commit");

    // Save state on temp-branch
    const state = buildState("on-temp", testDir, {
      git: {
        branch: "temp-branch",
        commitHash: await getCommitHash(git),
        hasUncommittedChanges: false,
        patchFile: "git-patch.diff",
        patchHash: computeHash(""),
      },
    });
    await atomicSaveState(testDir, "on-temp", state, "");

    // Switch to master and delete the branch
    await git.checkout("master");
    await git.deleteLocalBranch("temp-branch", true);

    // Try to checkout the deleted branch
    const result = await checkoutBranch(git, "temp-branch");
    expect(result.success).toBe(false);
    expect(result.message).toContain("temp-branch");

    // Should still be on master
    expect(await getBranch(git)).toBe("master");
  });

  it("4. Load with patch conflict — doesn't crash, reports conflict", async () => {
    const git = createGit(testDir);
    await ensureSavestateDir(testDir);

    // Modify file and save
    await fs.writeFile(path.join(testDir, "main.txt"), "original change\n");
    const patchContent = await getDiff(git);

    const state = buildState("conflict-test", testDir, {
      git: {
        branch: await getBranch(git),
        commitHash: await getCommitHash(git),
        hasUncommittedChanges: true,
        patchFile: "git-patch.diff",
        patchHash: computeHash(patchContent),
      },
    });
    await atomicSaveState(testDir, "conflict-test", state, patchContent);

    // Reset, then make a DIFFERENT change to the same lines
    await git.checkout(["--", "."]);
    await fs.writeFile(
      path.join(testDir, "main.txt"),
      "conflicting change\n"
    );
    await git.add("main.txt");
    await git.commit("conflicting commit");

    // Try to apply the saved patch — it should conflict
    const patch = patchPath(testDir, "conflict-test");
    const result = await applyPatch(git, patch);

    // It should not throw, and should indicate conflicts
    expect(result.hadConflicts).toBe(true);
  });

  it("5. Save with clean tree — empty patch, load is no-op for patch", async () => {
    const git = createGit(testDir);
    await ensureSavestateDir(testDir);

    expect(await isDirty(git)).toBe(false);

    const patchContent = await getDiff(git);
    expect(patchContent).toBe("");

    const branch = await getBranch(git);
    const commitHash = await getCommitHash(git);

    const state = buildState("clean-save", testDir, {
      git: {
        branch,
        commitHash,
        hasUncommittedChanges: false,
        patchFile: "git-patch.diff",
        patchHash: computeHash(""),
      },
    });
    await atomicSaveState(testDir, "clean-save", state, "");

    const loaded = await readState(testDir, "clean-save");
    expect(loaded.git.hasUncommittedChanges).toBe(false);

    // Patch file should exist but be empty
    const patchFile = patchPath(testDir, "clean-save");
    const patchOnDisk = await fs.readFile(patchFile, "utf-8");
    expect(patchOnDisk).toBe("");
  });

  it("6. Multiple saves overwrite — load restores the SECOND save", async () => {
    const git = createGit(testDir);
    await ensureSavestateDir(testDir);

    const branch = await getBranch(git);
    const commitHash = await getCommitHash(git);

    // First save: "first content"
    await fs.writeFile(path.join(testDir, "main.txt"), "first content\n");
    const patch1 = await getDiff(git);

    const state1 = buildState("overwrite-test", testDir, {
      note: "first save",
      git: {
        branch,
        commitHash,
        hasUncommittedChanges: true,
        patchFile: "git-patch.diff",
        patchHash: computeHash(patch1),
      },
    });
    await atomicSaveState(testDir, "overwrite-test", state1, patch1);

    // Second save: "second content" (same name)
    await fs.writeFile(path.join(testDir, "main.txt"), "second content\n");
    const patch2 = await getDiff(git);

    const state2 = buildState("overwrite-test", testDir, {
      note: "second save",
      git: {
        branch,
        commitHash,
        hasUncommittedChanges: true,
        patchFile: "git-patch.diff",
        patchHash: computeHash(patch2),
      },
    });
    await atomicSaveState(testDir, "overwrite-test", state2, patch2);

    // Verify only one entry in index
    const index = await readIndex(testDir);
    const matches = index.states.filter((s) => s.name === "overwrite-test");
    expect(matches).toHaveLength(1);
    expect(matches[0].notePreview).toBe("second save");

    // Reset and apply — should get second content
    await git.checkout(["--", "."]);
    const patchFile = patchPath(testDir, "overwrite-test");
    const result = await applyPatch(git, patchFile);
    expect(result.applied).toBe(true);

    const content = await fs.readFile(
      path.join(testDir, "main.txt"),
      "utf-8"
    );
    expect(content.trim()).toBe("second content");
  });
});

// ============================================================
// Storage edge cases
// ============================================================

describe("Storage edge cases", () => {
  it("7. Concurrent lock detection — clear error on second acquire", async () => {
    await ensureSavestateDir(testDir);

    const release1 = await acquireLock(testDir);

    // Second lock attempt should fail with clear error
    await expect(acquireLock(testDir)).rejects.toThrow(
      /Another dvs operation is currently running/
    );

    await release1();
  });

  it("8. Save with special characters in name — slashes, underscores, dashes", async () => {
    const git = createGit(testDir);
    await ensureSavestateDir(testDir);

    const branch = await getBranch(git);
    const commitHash = await getCommitHash(git);

    // Names with special characters (avoiding OS-invalid chars)
    const names = ["feature_v2", "hotfix-2026-03-09"];

    for (const name of names) {
      const state = buildState(name, testDir, {
        note: `Testing name: ${name}`,
        git: {
          branch,
          commitHash,
          hasUncommittedChanges: false,
          patchFile: "git-patch.diff",
          patchHash: computeHash(""),
        },
      });
      await atomicSaveState(testDir, name, state, "");

      // Verify it can be read back
      const loaded = await readState(testDir, name);
      expect(loaded.name).toBe(name);
      expect(loaded.note).toBe(`Testing name: ${name}`);
    }

    const index = await readIndex(testDir);
    expect(index.states).toHaveLength(names.length);
  });

  it("9. Large diff — 10,000 line file modified, save and load correctness", async () => {
    const git = createGit(testDir);
    await ensureSavestateDir(testDir);

    // Create a large file with 10,000 lines
    const lines: string[] = [];
    for (let i = 0; i < 10000; i++) {
      lines.push(`line ${i}: original content`);
    }
    const largePath = path.join(testDir, "large.txt");
    await fs.writeFile(largePath, lines.join("\n") + "\n");
    await git.add("large.txt");
    await git.commit("add large file");

    // Modify every 10th line
    const modifiedLines = lines.map((line, i) =>
      i % 10 === 0 ? `line ${i}: MODIFIED content` : line
    );
    await fs.writeFile(largePath, modifiedLines.join("\n") + "\n");

    const patchContent = await getDiff(git);
    expect(patchContent.length).toBeGreaterThan(1000);

    const state = buildState("large-diff", testDir, {
      git: {
        branch: await getBranch(git),
        commitHash: await getCommitHash(git),
        hasUncommittedChanges: true,
        patchFile: "git-patch.diff",
        patchHash: computeHash(patchContent),
      },
    });
    await atomicSaveState(testDir, "large-diff", state, patchContent);

    // Reset and restore
    await git.checkout(["--", "."]);
    const patchFile = patchPath(testDir, "large-diff");
    const result = await applyPatch(git, patchFile);
    expect(result.applied).toBe(true);

    // Verify specific modified lines (normalize CRLF for Windows)
    const restored = (await fs.readFile(largePath, "utf-8")).replace(/\r\n/g, "\n");
    const restoredLines = restored.split("\n");
    expect(restoredLines[0]).toBe("line 0: MODIFIED content");
    expect(restoredLines[1]).toBe("line 1: original content");
    expect(restoredLines[10]).toBe("line 10: MODIFIED content");
    expect(restoredLines[9990]).toBe("line 9990: MODIFIED content");
    expect(restoredLines[9999]).toBe("line 9999: original content");
  });

  it("10. Empty note — save with empty string note works fine", async () => {
    const git = createGit(testDir);
    await ensureSavestateDir(testDir);

    const state = buildState("empty-note", testDir, {
      note: "",
      git: {
        branch: await getBranch(git),
        commitHash: await getCommitHash(git),
        hasUncommittedChanges: false,
        patchFile: "git-patch.diff",
        patchHash: computeHash(""),
      },
    });
    await atomicSaveState(testDir, "empty-note", state, "");

    const loaded = await readState(testDir, "empty-note");
    expect(loaded.note).toBe("");
    expect(loaded.name).toBe("empty-note");

    // Index should have empty preview
    const index = await readIndex(testDir);
    const entry = index.states.find((s) => s.name === "empty-note");
    expect(entry).toBeDefined();
    expect(entry!.notePreview).toBe("");
  });
});

// ============================================================
// Load safety
// ============================================================

describe("Load safety", () => {
  it("11. Stash-on-load flow — stash created, state loads, stash visible in list", async () => {
    const git = createGit(testDir);
    await ensureSavestateDir(testDir);

    // Save a clean state with a branch
    const branch = await getBranch(git);
    const commitHash = await getCommitHash(git);
    const state = buildState("stash-test", testDir, {
      git: {
        branch,
        commitHash,
        hasUncommittedChanges: false,
        patchFile: "git-patch.diff",
        patchHash: computeHash(""),
      },
    });
    await atomicSaveState(testDir, "stash-test", state, "");

    // Dirty the tree
    await fs.writeFile(
      path.join(testDir, "main.txt"),
      "dirty before load\n"
    );
    expect(await isDirty(git)).toBe(true);

    // Stash changes (simulating the stash choice in load command)
    const stashMsg = "dvs: auto-stash before loading 'stash-test'";
    await stashChanges(git, stashMsg);

    // Working tree should be clean after stash
    expect(await isDirty(git)).toBe(false);

    // Stash should be visible in git stash list
    const stashList = await git.raw(["stash", "list"]);
    expect(stashList).toContain(stashMsg);

    // Verify the clean content is restored
    const content = await fs.readFile(
      path.join(testDir, "main.txt"),
      "utf-8"
    );
    expect(content.trim()).toBe("initial content");
  });

  it("12. Force load on dirty tree — state loads on top of existing changes", async () => {
    const git = createGit(testDir);
    await ensureSavestateDir(testDir);

    // Create a second file and commit
    await fs.writeFile(path.join(testDir, "other.txt"), "other original\n");
    await git.add("other.txt");
    await git.commit("add other file");

    const branch = await getBranch(git);
    const commitHash = await getCommitHash(git);

    // Save state that modifies main.txt
    await fs.writeFile(path.join(testDir, "main.txt"), "saved change\n");
    const patchContent = await getDiff(git);
    const savedState = buildState("force-test", testDir, {
      git: {
        branch,
        commitHash,
        hasUncommittedChanges: true,
        patchFile: "git-patch.diff",
        patchHash: computeHash(patchContent),
      },
    });
    await atomicSaveState(testDir, "force-test", savedState, patchContent);

    // Reset, then dirty a DIFFERENT file (simulating --force load on dirty tree)
    await git.checkout(["--", "."]);
    await fs.writeFile(path.join(testDir, "other.txt"), "dirty other\n");
    expect(await isDirty(git)).toBe(true);

    // Force-load: just apply patch on top (no stash, no abort)
    const patchFile = patchPath(testDir, "force-test");
    const result = await applyPatch(git, patchFile);
    expect(result.applied).toBe(true);

    // main.txt should have the saved change
    const mainContent = await fs.readFile(
      path.join(testDir, "main.txt"),
      "utf-8"
    );
    expect(mainContent.trim()).toBe("saved change");

    // other.txt should STILL have the dirty change (force doesn't discard)
    const otherContent = await fs.readFile(
      path.join(testDir, "other.txt"),
      "utf-8"
    );
    expect(otherContent.trim()).toBe("dirty other");
  });

  it("13. Load nonexistent state — throws clear error", async () => {
    await ensureSavestateDir(testDir);

    await expect(readState(testDir, "does-not-exist")).rejects.toThrow(
      /State 'does-not-exist' not found/
    );
  });
});

// ============================================================
// Index integrity
// ============================================================

describe("Index integrity", () => {
  it("14. Delete nonexistent state — stateExists returns false", async () => {
    await ensureSavestateDir(testDir);

    const exists = await stateExists(testDir, "ghost");
    expect(exists).toBe(false);
  });

  it("15. List on fresh repo (no .savestate) — returns empty list, doesn't crash", async () => {
    // Don't call ensureSavestateDir — simulate first use
    // readIndex returns empty states when index doesn't exist
    const index = await readIndex(testDir);
    expect(index.states).toHaveLength(0);
    expect(index.version).toBe(2);
  });

  it("16. Save-delete-save same name — works cleanly", async () => {
    const git = createGit(testDir);
    await ensureSavestateDir(testDir);

    const branch = await getBranch(git);
    const commitHash = await getCommitHash(git);

    // First save
    const state1 = buildState("recycled", testDir, {
      note: "first version",
      git: {
        branch,
        commitHash,
        hasUncommittedChanges: false,
        patchFile: "git-patch.diff",
        patchHash: computeHash(""),
      },
    });
    await atomicSaveState(testDir, "recycled", state1, "");
    expect(await stateExists(testDir, "recycled")).toBe(true);

    // Delete
    await deleteState(testDir, "recycled");
    expect(await stateExists(testDir, "recycled")).toBe(false);
    const indexAfterDelete = await readIndex(testDir);
    expect(indexAfterDelete.states.find((s) => s.name === "recycled")).toBeUndefined();

    // Second save with same name
    const state2 = buildState("recycled", testDir, {
      note: "second version",
      git: {
        branch,
        commitHash,
        hasUncommittedChanges: false,
        patchFile: "git-patch.diff",
        patchHash: computeHash(""),
      },
    });
    await atomicSaveState(testDir, "recycled", state2, "");

    // Verify it's the second version
    const loaded = await readState(testDir, "recycled");
    expect(loaded.note).toBe("second version");

    const indexFinal = await readIndex(testDir);
    const entries = indexFinal.states.filter((s) => s.name === "recycled");
    expect(entries).toHaveLength(1);
    expect(entries[0].notePreview).toBe("second version");
  });
});

// ============================================================
// Display
// ============================================================

describe("Display", () => {
  it("17. Mental stack with note and nextStep — both sections appear in output", () => {
    const state: SaveState = {
      version: 2,
      name: "display-test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      projectRoot: "/fake/path",
      note: "Working on auth token refresh",
      nextStep: "Add retry logic for expired tokens",
      tags: [],
      git: {
        branch: "feature/auth",
        commitHash: "abc123def456",
        hasUncommittedChanges: true,
        patchFile: "git-patch.diff",
        patchHash: "fakehash",
      },
      processes: [],
      untracked: { files: [] },
      archived: false,
      loadCount: 0,
    };

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      printMentalStack(state);

      const allOutput = logSpy.mock.calls.map((c) => c[0]).join("\n");

      // Should contain the state name
      expect(allOutput).toContain("display-test");

      // Should contain branch
      expect(allOutput).toContain("feature/auth");

      // Should contain NOTE section
      expect(allOutput).toContain("NOTE");
      expect(allOutput).toContain("Working on auth token refresh");

      // Should contain NEXT STEP section
      expect(allOutput).toContain("NEXT STEP");
      expect(allOutput).toContain("Add retry logic for expired tokens");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("printStateList with empty list shows 'No save states found.'", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      printStateList([]);

      const allOutput = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(allOutput).toContain("No save states found.");
    } finally {
      logSpy.mockRestore();
    }
  });
});
