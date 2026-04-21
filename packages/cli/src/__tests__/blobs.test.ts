import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import simpleGit from "simple-git";
import {
  captureUntracked,
  restoreUntracked,
  DEFAULT_LARGE_FILE_LIMIT,
  type BlobManifest,
} from "../lib/blobs.js";
import { createGit, getUntrackedFiles } from "../lib/git.js";
import {
  ensureSavestateDir,
  atomicSaveState,
  computeHash,
  readState,
  deleteState,
} from "../lib/storage.js";
import * as paths from "../lib/paths.js";
import type { SaveState } from "../lib/types.js";

const execFileAsync = promisify(execFile);

// Absolute path to the built CLI for the end-to-end smoke test.
const CLI_DIR = path.resolve(__dirname, "..", "..");
const CLI_ENTRY = path.join(CLI_DIR, "dist", "index.js");

let testDir: string;

async function createTestRepo(prefix = "blobs"): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `dvs-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await fs.mkdir(dir, { recursive: true });
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig("user.email", "test@test.com");
  await git.addConfig("user.name", "Test");
  // Need at least one commit so HEAD exists for diff operations.
  await fs.writeFile(path.join(dir, "main.txt"), "initial\n");
  await git.add("main.txt");
  await git.commit("initial");
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
    note: "blob test",
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
  testDir = await createTestRepo();
});

afterEach(async () => {
  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch {
    // Windows file locks
  }
});

// ============================================================
// getUntrackedFiles — direct git wrapper
// ============================================================

describe("getUntrackedFiles", () => {
  it("returns empty array on a clean tree", async () => {
    const git = createGit(testDir);
    const list = await getUntrackedFiles(git);
    expect(list).toEqual([]);
  });

  it("returns new files but not tracked ones", async () => {
    const git = createGit(testDir);
    await fs.writeFile(path.join(testDir, "new-file.ts"), "new\n");
    const list = await getUntrackedFiles(git);
    expect(list).toContain("new-file.ts");
    expect(list).not.toContain("main.txt");
  });

  it("honors .gitignore via --exclude-standard", async () => {
    const git = createGit(testDir);
    await fs.writeFile(path.join(testDir, ".gitignore"), "ignored.log\n");
    await fs.writeFile(path.join(testDir, "ignored.log"), "nope\n");
    await fs.writeFile(path.join(testDir, "captured.txt"), "yes\n");
    const list = await getUntrackedFiles(git);
    expect(list).toContain("captured.txt");
    expect(list).not.toContain("ignored.log");
    // .gitignore itself is untracked in this fixture, which is fine — we
    // just assert the ignored file is filtered.
  });
});

// ============================================================
// captureUntracked — happy path and edge cases
// ============================================================

describe("captureUntracked", () => {
  it("copies a single untracked file into the staging dir", async () => {
    const git = createGit(testDir);
    const content = "hello world\n";
    await fs.writeFile(path.join(testDir, "newly-added.ts"), content);

    const stagingDir = path.join(testDir, "_staging");
    const manifest = await captureUntracked(testDir, stagingDir, {
      includeLarge: false,
      git,
    });

    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].relativePath).toBe("newly-added.ts");
    expect(manifest.files[0].size).toBe(Buffer.byteLength(content));

    // Blob is on disk in the staging dir.
    const copied = await fs.readFile(
      path.join(stagingDir, "newly-added.ts"),
      "utf-8"
    );
    expect(copied).toBe(content);
  });

  it("captures nested paths, creating parent directories", async () => {
    const git = createGit(testDir);
    const nestedPath = path.join(testDir, "src", "new", "deep", "file.ts");
    await fs.mkdir(path.dirname(nestedPath), { recursive: true });
    await fs.writeFile(nestedPath, "deep content\n");

    const stagingDir = path.join(testDir, "_staging");
    const manifest = await captureUntracked(testDir, stagingDir, {
      includeLarge: false,
      git,
    });

    expect(manifest.files).toHaveLength(1);
    // Manifest always stores POSIX paths (git output style).
    expect(manifest.files[0].relativePath).toBe("src/new/deep/file.ts");

    // Blob exists at the nested location inside staging.
    const blobPath = path.join(
      stagingDir,
      "src",
      "new",
      "deep",
      "file.ts"
    );
    const copied = await fs.readFile(blobPath, "utf-8");
    expect(copied).toBe("deep content\n");
  });

  it("does NOT capture .gitignored files", async () => {
    const git = createGit(testDir);
    await fs.writeFile(path.join(testDir, ".gitignore"), "secrets.env\n");
    await fs.writeFile(
      path.join(testDir, "secrets.env"),
      "API_KEY=...\n"
    );
    await fs.writeFile(path.join(testDir, "keepme.txt"), "visible\n");

    const stagingDir = path.join(testDir, "_staging");
    const manifest = await captureUntracked(testDir, stagingDir, {
      includeLarge: false,
      git,
    });

    const paths_captured = manifest.files.map((f) => f.relativePath);
    expect(paths_captured).toContain("keepme.txt");
    expect(paths_captured).not.toContain("secrets.env");
  });

  it("skips files over the large-file limit with a warning", async () => {
    const git = createGit(testDir);
    // Write a small file that the test limit considers "large".
    const bigContent = "x".repeat(2048);
    await fs.writeFile(path.join(testDir, "big-file.bin"), bigContent);

    const stagingDir = path.join(testDir, "_staging");
    const warnings: string[] = [];
    const manifest = await captureUntracked(testDir, stagingDir, {
      includeLarge: false,
      largeFileLimit: 1024, // force skip
      warn: (m) => warnings.push(m),
      git,
    });

    expect(manifest.files).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("big-file.bin");
    expect(warnings[0]).toMatch(/--include-large/);
  });

  it("captures a large file when --include-large is set", async () => {
    const git = createGit(testDir);
    const bigContent = "x".repeat(2048);
    await fs.writeFile(path.join(testDir, "big-file.bin"), bigContent);

    const stagingDir = path.join(testDir, "_staging");
    const warnings: string[] = [];
    const manifest = await captureUntracked(testDir, stagingDir, {
      includeLarge: true, // opt in
      largeFileLimit: 1024,
      warn: (m) => warnings.push(m),
      git,
    });

    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].relativePath).toBe("big-file.bin");
    expect(manifest.files[0].size).toBe(2048);
    expect(warnings).toHaveLength(0);
  });

  it("skips symlinks with a warning (MVP policy)", async () => {
    // Skip on Windows by default — createSymlink requires admin.
    if (process.platform === "win32") return;
    const git = createGit(testDir);

    const target = path.join(testDir, "target.txt");
    await fs.writeFile(target, "target content\n");

    const linkPath = path.join(testDir, "link.txt");
    try {
      await fs.symlink(target, linkPath);
    } catch {
      // Environment doesn't allow symlinks — skip the assertion path.
      return;
    }

    const stagingDir = path.join(testDir, "_staging");
    const warnings: string[] = [];
    const manifest = await captureUntracked(testDir, stagingDir, {
      includeLarge: false,
      warn: (m) => warnings.push(m),
      git,
    });

    const capturedPaths = manifest.files.map((f) => f.relativePath);
    // link.txt is skipped
    expect(capturedPaths).not.toContain("link.txt");
    // target.txt (regular file) was captured as normal
    expect(capturedPaths).toContain("target.txt");
    expect(warnings.some((w) => w.toLowerCase().includes("symlink"))).toBe(
      true
    );
  });

  it("returns empty manifest on a clean tree (no warnings)", async () => {
    const git = createGit(testDir);
    const stagingDir = path.join(testDir, "_staging");
    const warnings: string[] = [];
    const manifest = await captureUntracked(testDir, stagingDir, {
      includeLarge: false,
      warn: (m) => warnings.push(m),
      git,
    });
    expect(manifest.files).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("uses the default 10 MB cutoff when largeFileLimit is not overridden", () => {
    // Sanity: the exported constant matches the advertised 10 MB default.
    expect(DEFAULT_LARGE_FILE_LIMIT).toBe(10 * 1024 * 1024);
  });
});

// ============================================================
// restoreUntracked — round-trip and conflict handling
// ============================================================

describe("restoreUntracked", () => {
  it("round-trip: capture → delete → restore puts files back", async () => {
    const git = createGit(testDir);
    await fs.writeFile(path.join(testDir, "restore-me.txt"), "original\n");

    const stagingDir = path.join(testDir, ".savestate", "_stage");
    await fs.mkdir(stagingDir, { recursive: true });
    const manifest = await captureUntracked(
      testDir,
      path.join(stagingDir, "untracked"),
      { includeLarge: false, git }
    );
    expect(manifest.files).toHaveLength(1);

    // Delete the working copy.
    await fs.unlink(path.join(testDir, "restore-me.txt"));
    await expect(
      fs.access(path.join(testDir, "restore-me.txt"))
    ).rejects.toThrow();

    // Restore.
    const report = await restoreUntracked(testDir, manifest, stagingDir, {
      forceUntracked: false,
    });
    expect(report.restored).toBe(1);
    expect(report.conflicts).toEqual([]);

    const restored = await fs.readFile(
      path.join(testDir, "restore-me.txt"),
      "utf-8"
    );
    expect(restored).toBe("original\n");
  });

  it("round-trip preserves file mode", async () => {
    // File-mode preservation is a POSIX concept; Windows loses most bits
    // in a copy-and-chmod cycle, so this assertion is POSIX-only.
    if (process.platform === "win32") return;
    const git = createGit(testDir);
    const scriptPath = path.join(testDir, "run.sh");
    await fs.writeFile(scriptPath, "#!/bin/sh\necho hi\n");
    await fs.chmod(scriptPath, 0o755);

    const stagingDir = path.join(testDir, ".savestate", "_stage");
    await fs.mkdir(stagingDir, { recursive: true });
    const manifest = await captureUntracked(
      testDir,
      path.join(stagingDir, "untracked"),
      { includeLarge: false, git }
    );

    await fs.unlink(scriptPath);
    await restoreUntracked(testDir, manifest, stagingDir, {
      forceUntracked: false,
    });

    const restored = await fs.stat(scriptPath);
    // Low 9 bits (mode bits) should match 0o755.
    expect(restored.mode & 0o777).toBe(0o755);
  });

  it("skips files that already exist with identical content", async () => {
    const git = createGit(testDir);
    await fs.writeFile(path.join(testDir, "same.txt"), "identical\n");

    const stagingDir = path.join(testDir, ".savestate", "_stage");
    await fs.mkdir(stagingDir, { recursive: true });
    const manifest = await captureUntracked(
      testDir,
      path.join(stagingDir, "untracked"),
      { includeLarge: false, git }
    );

    // Don't delete — just restore on top of an identical file.
    const report = await restoreUntracked(testDir, manifest, stagingDir, {
      forceUntracked: false,
    });
    expect(report.restored).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.conflicts).toEqual([]);
  });

  it("refuses to overwrite conflicting files without --force-untracked", async () => {
    const git = createGit(testDir);
    await fs.writeFile(path.join(testDir, "conflict.txt"), "original\n");

    const stagingDir = path.join(testDir, ".savestate", "_stage");
    await fs.mkdir(stagingDir, { recursive: true });
    const manifest = await captureUntracked(
      testDir,
      path.join(stagingDir, "untracked"),
      { includeLarge: false, git }
    );

    // Change content on disk so it differs from the captured blob.
    await fs.writeFile(
      path.join(testDir, "conflict.txt"),
      "divergent local change\n"
    );

    const report = await restoreUntracked(testDir, manifest, stagingDir, {
      forceUntracked: false,
    });
    expect(report.restored).toBe(0);
    expect(report.conflicts).toEqual(["conflict.txt"]);

    // The divergent file MUST still be on disk untouched.
    const onDisk = await fs.readFile(
      path.join(testDir, "conflict.txt"),
      "utf-8"
    );
    expect(onDisk).toBe("divergent local change\n");
  });

  it("overwrites conflicting files when forceUntracked is true", async () => {
    const git = createGit(testDir);
    await fs.writeFile(path.join(testDir, "conflict.txt"), "original\n");

    const stagingDir = path.join(testDir, ".savestate", "_stage");
    await fs.mkdir(stagingDir, { recursive: true });
    const manifest = await captureUntracked(
      testDir,
      path.join(stagingDir, "untracked"),
      { includeLarge: false, git }
    );

    await fs.writeFile(
      path.join(testDir, "conflict.txt"),
      "divergent local change\n"
    );

    const report = await restoreUntracked(testDir, manifest, stagingDir, {
      forceUntracked: true,
    });
    expect(report.restored).toBe(1);
    expect(report.conflicts).toEqual([]);

    const onDisk = await fs.readFile(
      path.join(testDir, "conflict.txt"),
      "utf-8"
    );
    expect(onDisk).toBe("original\n");
  });

  it("throws a clear error if a manifest entry's blob is missing on disk", async () => {
    const stagingDir = path.join(testDir, ".savestate", "_stage");
    await fs.mkdir(path.join(stagingDir, "untracked"), { recursive: true });
    // Manifest references a file that was never copied.
    const manifest: BlobManifest = {
      files: [{ relativePath: "ghost.txt", size: 10, mode: 0o644 }],
    };
    await expect(
      restoreUntracked(testDir, manifest, stagingDir, { forceUntracked: false })
    ).rejects.toThrow(/missing on disk/i);
  });
});

// ============================================================
// Integration with atomicSaveState
// ============================================================

describe("atomicSaveState + untracked manifest", () => {
  it("commits the untracked/ subtree atomically with state.json", async () => {
    const git = createGit(testDir);
    await ensureSavestateDir(testDir);

    await fs.writeFile(path.join(testDir, "new.ts"), "fresh\n");

    // Simulate what save.ts does: capture into tmp, then pass a populator
    // that moves the subtree into the staging dir.
    const untrackedTmp = path.join(
      paths.tmpDir(testDir),
      `tmp-${Date.now()}`
    );
    const manifest = await captureUntracked(testDir, untrackedTmp, {
      includeLarge: false,
      git,
    });
    expect(manifest.files).toHaveLength(1);

    const state = buildState("with-untracked", testDir, {
      untracked: manifest,
    });
    await atomicSaveState(testDir, "with-untracked", state, "", async (staging) => {
      const dest = path.join(staging, "untracked");
      await fs.rename(untrackedTmp, dest);
    });

    // The state dir should now contain an untracked/ subtree with the file.
    const stateDirPath = paths.stateDir(testDir, "with-untracked");
    const contents = await fs.readdir(stateDirPath);
    expect(contents).toContain("untracked");
    const blob = await fs.readFile(
      path.join(stateDirPath, "untracked", "new.ts"),
      "utf-8"
    );
    expect(blob).toBe("fresh\n");
  });

  it("delete removes the untracked/ subtree along with the state", async () => {
    const git = createGit(testDir);
    await ensureSavestateDir(testDir);
    await fs.writeFile(path.join(testDir, "d.ts"), "to be deleted\n");

    const untrackedTmp = path.join(
      paths.tmpDir(testDir),
      `tmp-${Date.now()}`
    );
    const manifest = await captureUntracked(testDir, untrackedTmp, {
      includeLarge: false,
      git,
    });
    const state = buildState("to-delete", testDir, { untracked: manifest });
    await atomicSaveState(testDir, "to-delete", state, "", async (staging) => {
      await fs.rename(untrackedTmp, path.join(staging, "untracked"));
    });

    const stateDirPath = paths.stateDir(testDir, "to-delete");
    await expect(fs.access(stateDirPath)).resolves.not.toThrow();

    await deleteState(testDir, "to-delete");

    // Entire state dir including untracked/ is gone.
    await expect(fs.access(stateDirPath)).rejects.toThrow();
  });
});

// ============================================================
// End-to-end smoke test via the built CLI
// ============================================================

describe("dvs save → delete → load end-to-end (untracked)", () => {
  it("restores a brand-new file after the working copy is deleted", async () => {
    const repo = await createTestRepo("smoke");
    try {
      const untrackedPath = path.join(repo, "scripts", "setup.sh");
      await fs.mkdir(path.dirname(untrackedPath), { recursive: true });
      await fs.writeFile(untrackedPath, "#!/bin/sh\necho setup\n");

      // Save
      const saveOut = await execFileAsync(
        process.execPath,
        [CLI_ENTRY, "save", "smoke-untracked", "smoke note"],
        { cwd: repo }
      );
      expect(saveOut.stdout).toContain("Saved: smoke-untracked");

      // The state.json should have the manifest with one entry.
      const persisted = await readState(repo, "smoke-untracked");
      expect(persisted.untracked.files).toHaveLength(1);
      expect(persisted.untracked.files[0].relativePath).toBe(
        "scripts/setup.sh"
      );

      // Delete the working copy.
      await fs.rm(path.join(repo, "scripts"), {
        recursive: true,
        force: true,
      });
      await expect(fs.access(untrackedPath)).rejects.toThrow();

      // Load
      const loadOut = await execFileAsync(
        process.execPath,
        [CLI_ENTRY, "load", "smoke-untracked"],
        { cwd: repo }
      );
      expect(loadOut.stdout).toContain("Restored 1 untracked file");

      // File is back.
      const restored = await fs.readFile(untrackedPath, "utf-8");
      expect(restored).toBe("#!/bin/sh\necho setup\n");
    } finally {
      await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
    }
  });
});
