import fs from "node:fs/promises";
import simpleGit, { type SimpleGit } from "simple-git";

export function createGit(projectRoot: string): SimpleGit {
  return simpleGit(projectRoot);
}

// --- Branch name validation ---

const BRANCH_NAME_RE = /^[A-Za-z0-9_./-]+$/;

/**
 * Validate a branch name before handing it to `git checkout`.
 *
 * simple-git ultimately shells out; while it uses argv arrays, we still
 * refuse anything that contains shell metacharacters, whitespace, or
 * classic git refname abuse (leading dashes, `..`, control chars).
 *
 * Callers MUST invoke this before `git.checkout(branch)` for any branch
 * name that originated from user input or from a state file loaded off
 * disk (state files are effectively untrusted).
 */
export function validateBranchName(branch: string): void {
  if (typeof branch !== "string" || branch.length === 0) {
    throw new Error("Invalid branch name: empty");
  }
  if (branch.length > 256) {
    throw new Error("Invalid branch name: too long");
  }
  if (!BRANCH_NAME_RE.test(branch)) {
    throw new Error(
      `Invalid branch name '${branch}': only [A-Za-z0-9_./-] allowed`
    );
  }
  if (branch.startsWith("-") || branch.startsWith(".")) {
    throw new Error(`Invalid branch name '${branch}': cannot start with '-' or '.'`);
  }
  if (branch.includes("..")) {
    throw new Error(`Invalid branch name '${branch}': '..' is not allowed`);
  }
}

export async function findProjectRoot(startDir: string): Promise<string> {
  const git = simpleGit(startDir);
  try {
    const root = await git.revparse(["--show-toplevel"]);
    return root.trim();
  } catch {
    throw new Error(
      `Not a git repository (or any parent up to root). Run 'git init' first.`
    );
  }
}

export async function getBranch(git: SimpleGit): Promise<string> {
  const branch = await git.revparse(["--abbrev-ref", "HEAD"]);
  return branch.trim();
}

export async function getCommitHash(git: SimpleGit): Promise<string> {
  const hash = await git.revparse(["HEAD"]);
  return hash.trim();
}

export async function isDirty(git: SimpleGit): Promise<boolean> {
  const status = await git.status();
  return !status.isClean();
}

export async function getDiff(git: SimpleGit): Promise<string> {
  // Unstaged changes (tracked files, binary-capable)
  const unstaged = await git.diff(["--binary", "HEAD"]);
  // Staged changes
  const staged = await git.diff(["--binary", "--cached"]);

  if (!unstaged && !staged) return "";

  let combined = "";
  if (unstaged) combined += unstaged;
  if (staged) {
    if (combined && !combined.endsWith("\n")) combined += "\n";
    combined += staged;
  }
  return combined;
}

export async function checkoutBranch(
  git: SimpleGit,
  branch: string
): Promise<{ success: boolean; message: string }> {
  try {
    // Defense in depth: even though simple-git passes argv, refuse any
    // value that couldn't be a real branch name.
    validateBranchName(branch);
    await git.checkout(branch);
    return { success: true, message: `Checked out branch '${branch}'` };
  } catch (err: any) {
    return {
      success: false,
      message: `Could not checkout branch '${branch}': ${err.message}`,
    };
  }
}

/**
 * Scan a patch's text for suspicious symlink operations. Git patches can
 * encode symlinks via `new file mode 120000`, and a patch that flips a
 * regular file to a symlink (or vice versa) can be used to redirect later
 * writes outside the repo. We refuse any patch that creates or transmutes
 * a symlink.
 */
function assertPatchHasNoSymlinkMode(patchContent: string): void {
  // Plain creation of a symlink
  if (/\bnew file mode 120000\b/.test(patchContent)) {
    throw new Error(
      "Refusing to apply patch: creates a symlink (new file mode 120000)"
    );
  }
  // In-place mode change that transmutes a tracked file to a symlink, or
  // vice versa. Git emits `old mode XXX` + `new mode YYY` on chmod-style
  // hunks without a full delete/create pair.
  if (/^new mode 120000\s*$/m.test(patchContent)) {
    throw new Error(
      "Refusing to apply patch: changes file mode to symlink (new mode 120000)"
    );
  }
  if (/^old mode 120000\s*$/m.test(patchContent)) {
    throw new Error(
      "Refusing to apply patch: changes file mode from symlink (old mode 120000)"
    );
  }
  // Symlink deletion + regular file creation OR regular file deletion + symlink creation
  const delSymlink = /\bdeleted file mode 120000\b/.test(patchContent);
  const newRegular = /\bnew file mode 100\d{3}\b/.test(patchContent);
  const delRegular = /\bdeleted file mode 100\d{3}\b/.test(patchContent);
  const newSymlink = /\bnew file mode 120000\b/.test(patchContent);
  if ((delSymlink && newRegular) || (delRegular && newSymlink)) {
    throw new Error(
      "Refusing to apply patch: swaps between symlink and regular file"
    );
  }
}

export interface PatchResult {
  applied: boolean;
  alreadyApplied: boolean;
  hadConflicts: boolean;
  message: string;
}

export async function applyPatch(
  git: SimpleGit,
  patchFilePath: string
): Promise<PatchResult> {
  // Step 0: Content safety scan BEFORE any git invocation. A hostile
  // state file on disk could carry a symlink-creating patch designed to
  // redirect subsequent writes outside the repo.
  try {
    const patchContent = await fs.readFile(patchFilePath, "utf-8");
    assertPatchHasNoSymlinkMode(patchContent);
  } catch (err: any) {
    // If the read failed for a reason other than our own safety throw,
    // fall through and let git report it. If it was our throw, surface it.
    if (err && typeof err.message === "string" && err.message.startsWith("Refusing to apply patch")) {
      return {
        applied: false,
        alreadyApplied: false,
        hadConflicts: false,
        message: err.message,
      };
    }
    // ENOENT etc: let git produce the authoritative error below.
  }

  // Step 1: Dry run
  try {
    await git.raw(["apply", "--binary", "--check", patchFilePath]);
    // Dry run passed — apply for real
    await git.raw([
      "apply",
      "--binary",
      "--whitespace=nowarn",
      patchFilePath,
    ]);
    return {
      applied: true,
      alreadyApplied: false,
      hadConflicts: false,
      message: "Patch applied successfully.",
    };
  } catch {
    // Dry run failed — check if already applied
  }

  // Step 2: Reverse check (already applied?)
  try {
    await git.raw([
      "apply",
      "--binary",
      "--reverse",
      "--check",
      patchFilePath,
    ]);
    return {
      applied: false,
      alreadyApplied: true,
      hadConflicts: false,
      message: "Patch already applied, skipping.",
    };
  } catch {
    // Not already applied — genuine conflict
  }

  // Step 3: Three-way merge
  try {
    await git.raw(["apply", "--binary", "--3way", patchFilePath]);
    return {
      applied: true,
      alreadyApplied: false,
      hadConflicts: true,
      message:
        "Patch applied with conflicts. Check for conflict markers (<<<<<<< / ======= / >>>>>>>).",
    };
  } catch {
    // 3way failed
  }

  // Step 4: Reject fallback
  try {
    await git.raw(["apply", "--binary", "--reject", patchFilePath]);
    return {
      applied: true,
      alreadyApplied: false,
      hadConflicts: true,
      message:
        "Patch partially applied. Check .rej files for rejected hunks.",
    };
  } catch (err: any) {
    return {
      applied: false,
      alreadyApplied: false,
      hadConflicts: true,
      message: `Patch could not be applied: ${err.message}`,
    };
  }
}

export async function stashChanges(
  git: SimpleGit,
  message: string
): Promise<string> {
  // git stash create makes a stash commit without modifying reflog
  const hash = await git.raw(["stash", "create"]);
  const trimmed = hash.trim();
  if (!trimmed) {
    throw new Error("Nothing to stash");
  }
  // Store it so it shows up in stash list
  await git.raw(["stash", "store", "-m", message, trimmed]);
  // Clean the working tree (checkout tracked files, but don't delete untracked)
  await git.checkout(["--", "."]);
  return trimmed;
}
