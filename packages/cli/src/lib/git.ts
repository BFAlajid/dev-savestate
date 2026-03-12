import simpleGit, { type SimpleGit } from "simple-git";

export function createGit(projectRoot: string): SimpleGit {
  return simpleGit(projectRoot);
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
    await git.checkout(branch);
    return { success: true, message: `Checked out branch '${branch}'` };
  } catch (err: any) {
    return {
      success: false,
      message: `Could not checkout branch '${branch}': ${err.message}`,
    };
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
