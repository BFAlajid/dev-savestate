import { Command } from "commander";
import readline from "node:readline/promises";
import fs from "node:fs/promises";
import path from "node:path";
import {
  findProjectRoot,
  createGit,
} from "../lib/git.js";
import {
  ensureSavestateDir,
  acquireLock,
  cleanStaleTmpDirs,
  atomicSaveState,
  stateExists,
  validateStateName,
  resolveStateDir,
} from "../lib/storage.js";
import { scanForSecrets, formatFindings, type ScanFinding } from "../lib/scanner.js";
import {
  BUILT_IN_COLLECTORS,
  GIT_PATCH_ARTIFACT,
  type CaptureContext,
  type CaptureResult,
  type StagingArtifact,
} from "../lib/collectors/index.js";
import type { SaveState } from "../lib/types.js";

async function promptLine(question: string): Promise<string> {
  if (!process.stdin.isTTY) return "";
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

/**
 * Validate a staging artifact's destination path before the orchestrator
 * writes it. Refuses absolute paths, traversal segments (`..`), leading
 * slashes, and null bytes. Collectors author `destRelative`, but they may
 * be third-party code in the future — defensive validation keeps the
 * atomic staging invariant robust.
 */
function assertSafeArtifactDest(destRelative: string): void {
  if (typeof destRelative !== "string" || destRelative.length === 0) {
    throw new Error("Invalid staging artifact: empty destRelative");
  }
  if (destRelative.includes("\x00")) {
    throw new Error("Invalid staging artifact: destRelative contains null byte");
  }
  if (path.isAbsolute(destRelative)) {
    throw new Error(
      `Invalid staging artifact: destRelative '${destRelative}' must be relative`
    );
  }
  const segments = destRelative.split(/[\\/]/);
  for (const seg of segments) {
    if (seg === "..") {
      throw new Error(
        `Invalid staging artifact: destRelative '${destRelative}' contains '..'`
      );
    }
  }
}

/**
 * Merge the partial SaveState slices returned by each collector into one
 * full state object. Fields not owned by any collector (name, timestamps,
 * tags, etc.) are provided by the caller via `base`. If two collectors
 * emit the same field, the later one wins — today there is no overlap,
 * but this matches the documented order-precedence in
 * lib/collectors/index.ts.
 */
function mergeSlices(
  base: SaveState,
  results: CaptureResult[]
): SaveState {
  const merged: Record<string, unknown> = { ...base };
  for (const r of results) {
    for (const [k, v] of Object.entries(r.slice)) {
      if (v !== undefined) {
        merged[k] = v;
      }
    }
  }
  return merged as unknown as SaveState;
}

/**
 * Write a single staging artifact into the atomic-rename window. The
 * `content` variant writes bytes directly; the `copyFrom` variant prefers
 * a rename (fast, same inode), falling back to recursive copy + rm when
 * the source is on a different filesystem than the staging dir (EXDEV).
 */
async function writeArtifact(
  stagingDir: string,
  artifact: StagingArtifact
): Promise<void> {
  assertSafeArtifactDest(artifact.destRelative);
  // Split POSIX-style dest into platform segments so a declared
  // `untracked/foo/bar.txt` places correctly on Windows.
  const destAbs = path.join(
    stagingDir,
    ...artifact.destRelative.split(/[\\/]/)
  );

  if ("content" in artifact) {
    await fs.mkdir(path.dirname(destAbs), { recursive: true });
    const payload =
      typeof artifact.content === "string"
        ? artifact.content
        : artifact.content;
    await fs.writeFile(destAbs, payload);
    return;
  }

  // copyFrom: prefer rename for speed, fall back to recursive cp + rm
  // when rename fails (cross-device, Windows locks, etc.). Mirrors the
  // pre-refactor untracked tmp-dir rename logic exactly.
  await fs.mkdir(path.dirname(destAbs), { recursive: true });
  try {
    await fs.rename(artifact.copyFrom, destAbs);
  } catch {
    await fs.cp(artifact.copyFrom, destAbs, { recursive: true });
    await fs.rm(artifact.copyFrom, { recursive: true, force: true });
  }
}

export const saveCommand = new Command("save")
  .description("Save current development context")
  .argument("[name]", "Name for the save state")
  .argument("[note]", "Context note describing what you were doing")
  .option("-t, --tag <tags...>", "Add tags to the save state")
  .option("--editor-state <file>", "Path to JSON file with editor state (used by VS Code extension)")
  .option("--strict-secrets", "Abort save if suspected secrets are found in the note or process list")
  .option("--include-large", "Capture untracked files over 10 MB (skipped by default)")
  .option("--json", "Output as JSON")
  .action(async (nameArg?: string, noteArg?: string, opts?: { tag?: string[]; editorState?: string; strictSecrets?: boolean; includeLarge?: boolean; json?: boolean }) => {
    let release: (() => Promise<void>) | null = null;

    try {
      const projectRoot = await findProjectRoot(process.cwd());
      await ensureSavestateDir(projectRoot);

      release = await acquireLock(projectRoot);
      await cleanStaleTmpDirs(projectRoot);

      const name =
        nameArg ||
        `save-${new Date().toISOString().slice(0, 16).replace(":", "")}`;

      const nameCheck = validateStateName(name);
      if (!nameCheck.valid) {
        console.error(`Error: ${nameCheck.reason}`);
        process.exitCode = 1;
        return;
      }
      // Traversal guard in addition to the character validator.
      resolveStateDir(projectRoot, name);

      if (nameArg && (await stateExists(projectRoot, name))) {
        console.log(`Updating existing state '${name}'`);
      }

      const git = createGit(projectRoot);

      // Run every built-in collector's capture in parallel. Each one
      // returns a slice (merged into the final SaveState) and optional
      // staging artifacts (written into the atomic-rename window below).
      const warnings: string[] = [];
      const captureCtx: CaptureContext = {
        projectRoot,
        git,
        opts: {
          includeLarge: !!opts?.includeLarge,
          editorStateFile: opts?.editorState,
        },
        warn: (m) => warnings.push(m),
      };
      const results = await Promise.all(
        BUILT_IN_COLLECTORS.map((c) => c.capture(captureCtx))
      );

      // Surface capture warnings (skipped large files, symlinks, etc.)
      // before the note prompt so the user sees them in a predictable
      // order — matches pre-refactor save.ts.
      if (warnings.length && !opts?.json) {
        for (const w of warnings) console.warn(w);
      }

      let note = noteArg || "";
      if (!note) {
        note = await promptLine("Note (what are you working on?): ");
      }

      let nextStep: string | undefined;
      if (process.stdin.isTTY) {
        const ns = await promptLine("Next step when you return? (optional, press Enter to skip): ");
        if (ns) nextStep = ns;
      }

      // Build the base SaveState with fields not owned by any collector,
      // then merge in each collector's slice.
      const now = new Date().toISOString();
      const base: SaveState = {
        version: 2,
        name,
        createdAt: now,
        updatedAt: now,
        projectRoot,
        note,
        nextStep,
        tags: opts?.tag || [],
        git: {
          branch: "",
          commitHash: "",
          hasUncommittedChanges: false,
          patchFile: "git-patch.diff",
          patchHash: "",
        },
        processes: [],
        untracked: { files: [] },
        archived: false,
        loadCount: 0,
      };
      const state = mergeSlices(base, results);

      // Secret scan on note + process commands/args. Warning only unless
      // --strict-secrets. Patch content is NOT scanned here — diffs are
      // often enormous and we'd rather keep the save fast. `dvs share`
      // blocks on patch content because that's when the state leaves the
      // machine.
      const secretFindings: ScanFinding[] = [];
      if (state.note) {
        secretFindings.push(...scanForSecrets(state.note, "note"));
      }
      for (let i = 0; i < state.processes.length; i++) {
        const p = state.processes[i];
        if (p.command) {
          secretFindings.push(
            ...scanForSecrets(p.command, `processes[${i}].command`)
          );
        }
        if (p.args && p.args.length) {
          secretFindings.push(
            ...scanForSecrets(p.args.join(" "), `processes[${i}].args`)
          );
        }
      }
      if (secretFindings.length > 0) {
        const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
        if (!opts?.json) {
          console.error(yellow("\u26A0 Possible secrets detected:"));
          console.error(formatFindings(secretFindings));
        }
        if (opts?.strictSecrets) {
          if (opts?.json) {
            console.log(
              JSON.stringify({
                success: false,
                error: "Suspected secrets detected (--strict-secrets)",
                findings: secretFindings,
              })
            );
          } else {
            console.error(
              yellow(
                "Aborted: --strict-secrets is set. Edit the note or remove the offending process entry and retry."
              )
            );
          }
          process.exitCode = 1;
          return;
        }
        if (!opts?.json) {
          console.error(
            yellow(
              "Save continues — consider editing the note or re-run with --strict-secrets to abort next time."
            )
          );
        }
      }

      // Separate the git patch artifact from the rest — storage.ts writes
      // git-patch.diff inline from its patchContent argument, so passing
      // it through populateStaging too would cause a double-write.
      let patchContent = "";
      const stagingArtifacts: StagingArtifact[] = [];
      for (const r of results) {
        if (!r.artifacts) continue;
        for (const a of r.artifacts) {
          if (a.destRelative === GIT_PATCH_ARTIFACT && "content" in a) {
            patchContent =
              typeof a.content === "string"
                ? a.content
                : a.content.toString("utf-8");
            continue;
          }
          stagingArtifacts.push(a);
        }
      }

      await atomicSaveState(
        projectRoot,
        name,
        state,
        patchContent,
        async (stagingDir) => {
          for (const artifact of stagingArtifacts) {
            await writeArtifact(stagingDir, artifact);
          }
        }
      );

      if (opts?.json) {
        const noteHasSecret = secretFindings.some((f) => f.location === "note");
        console.log(
          JSON.stringify({
            success: true,
            name,
            branch: state.git.branch,
            commitHash: state.git.commitHash,
            dirty: state.git.hasUncommittedChanges,
            note: noteHasSecret ? "<redacted>" : state.note,
            ...(secretFindings.length
              ? { secretFindings }
              : {}),
          })
        );
      } else {
        console.log("");
        console.log(`Saved: ${name}`);
        console.log(`  Branch:  ${state.git.branch}`);
        console.log(`  Commit:  ${state.git.commitHash.slice(0, 8)}`);
        if (state.git.hasUncommittedChanges) {
          console.log(`  Changes: ${patchContent.split("\n").length} lines of diff`);
        } else {
          console.log(`  Changes: clean working tree`);
        }
        if (state.tags.length) console.log(`  Tags:    ${state.tags.join(", ")}`);
        if (state.processes.length) console.log(`  Procs:   ${state.processes.map((p) => p.name).join(", ")}`);
        if (state.untracked.files.length) {
          console.log(`  New:     ${state.untracked.files.length} untracked file(s) captured`);
        }
        if (state.note) {
          // Don't echo the note summary when it contained a detected secret —
          // the whole point of the scanner is to avoid leaking the value.
          const noteHasSecret = secretFindings.some((f) => f.location === "note");
          if (noteHasSecret) {
            console.log(`  Note:    <redacted — see warning above>`);
          } else {
            console.log(`  Note:    ${state.note.slice(0, 60)}`);
          }
        }
        if (nextStep) console.log(`  Next:    ${nextStep.slice(0, 60)}`);
      }
    } catch (err: any) {
      if (opts?.json) {
        console.log(JSON.stringify({ success: false, error: err.message }));
      } else {
        console.error(`Error: ${err.message}`);
      }
      process.exitCode = 1;
    } finally {
      if (release) await release();
    }
  });
