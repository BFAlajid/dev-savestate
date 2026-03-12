import { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import { findProjectRoot, createGit, checkoutBranch, applyPatch } from "../lib/git.js";
import { ensureSavestateDir, acquireLock } from "../lib/storage.js";
import writeFileAtomic from "write-file-atomic";

interface Checkpoint {
  branch: string;
  commitHash: string;
  patchFile?: string;
  createdAt: string;
}

export function checkpointPath(projectRoot: string): string {
  return path.join(projectRoot, ".savestate", "_checkpoint.json");
}

export function checkpointPatchPath(projectRoot: string): string {
  return path.join(projectRoot, ".savestate", "_checkpoint-patch.diff");
}

export async function saveCheckpoint(
  projectRoot: string,
  branch: string,
  commitHash: string,
  patchContent?: string
): Promise<void> {
  const cp: Checkpoint = { branch, commitHash, createdAt: new Date().toISOString() };
  const dir = path.join(projectRoot, ".savestate");
  await fs.mkdir(dir, { recursive: true });

  if (patchContent && patchContent.trim()) {
    const pf = checkpointPatchPath(projectRoot);
    await writeFileAtomic(pf, patchContent);
    cp.patchFile = "_checkpoint-patch.diff";
  }

  await writeFileAtomic(checkpointPath(projectRoot), JSON.stringify(cp, null, 2) + "\n");
}

export async function clearCheckpoint(projectRoot: string): Promise<void> {
  try { await fs.unlink(checkpointPath(projectRoot)); } catch {}
  try { await fs.unlink(checkpointPatchPath(projectRoot)); } catch {}
}

export const backCommand = new Command("back")
  .description("Undo the last load (restore pre-load state)")
  .action(async () => {
    let release: (() => Promise<void>) | null = null;
    try {
      const projectRoot = await findProjectRoot(process.cwd());
      await ensureSavestateDir(projectRoot);

      let cpRaw: string;
      try { cpRaw = await fs.readFile(checkpointPath(projectRoot), "utf-8"); } catch {
        console.log("No previous state to restore. Run `dvs load` first.");
        return;
      }

      const checkpoint: Checkpoint = JSON.parse(cpRaw);
      release = await acquireLock(projectRoot);
      const git = createGit(projectRoot);

      const result = await checkoutBranch(git, checkpoint.branch);
      if (result.success) {
        console.log(`Restored branch: ${checkpoint.branch}`);
      } else {
        console.log(`Warning: ${result.message}`);
      }

      if (checkpoint.patchFile) {
        const pp = checkpointPatchPath(projectRoot);
        try {
          const content = await fs.readFile(pp, "utf-8");
          if (content.trim()) {
            const patchResult = await applyPatch(git, pp);
            console.log(patchResult.message);
          }
        } catch {
          console.log("Warning: Could not restore previous working tree changes.");
        }
      }

      await clearCheckpoint(projectRoot);
      console.log("Restored to pre-load state.");
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    } finally {
      if (release) await release();
    }
  });
