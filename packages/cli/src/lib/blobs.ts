// Blob capture & restore for untracked (new) files.
//
// `git diff HEAD` only captures changes to *tracked* files. A brand-new
// file you haven't yet `git add`ed is silently dropped by that pipeline
// and lost on round-trip. This module closes that gap: on save, we copy
// each untracked file into <stateDir>/untracked/<relativePath>; on load,
// we materialize them back into the working tree.
//
// Scope for MVP:
//   * Per-state storage (no content-addressed dedup). `dvs delete` cleans
//     up untracked blobs automatically via its existing recursive rm.
//   * Enumeration is delegated to `git ls-files --others --exclude-standard`
//     so `.gitignore` is honored with zero hand-rolled logic.
//   * Large files (>10 MB) are skipped with a warning unless the caller
//     opts in via `includeLarge`. Keeps save fast for users who accidentally
//     have huge untracked artifacts in their tree.
//   * Symlinks are skipped entirely with a warning. Supporting them
//     correctly (preserve link target, refuse traversal) is a larger
//     design question; defer to a follow-up.
//   * Path safety: every captured/restored file must resolve to a path
//     inside the project root. A hostile or malformed relative path that
//     escapes the root (e.g. "../../etc/passwd") is refused, mirroring the
//     guard `resolveStateDir` applies to state names.

import fs from "node:fs/promises";
import path from "node:path";
import type { SimpleGit } from "simple-git";
import { getUntrackedFiles } from "./git.js";

/** Default large-file cutoff (bytes). Files over this are skipped with a warning. */
export const DEFAULT_LARGE_FILE_LIMIT = 10 * 1024 * 1024;

export interface BlobManifestEntry {
  relativePath: string;
  size: number;
  mode: number;
}

export interface BlobManifest {
  files: BlobManifestEntry[];
}

export interface CaptureOptions {
  includeLarge: boolean;
  /**
   * Override the large-file cutoff (bytes). Tests use this to exercise the
   * skip path without needing to allocate a real >10 MB file.
   */
  largeFileLimit?: number;
  /**
   * Where to emit skip/warning messages. Defaults to console.warn. Passed
   * explicitly so tests can capture output and save.ts can route through
   * display.ts if desired.
   */
  warn?: (message: string) => void;
  /**
   * Pre-resolved list of untracked paths. If omitted, `captureUntracked`
   * instantiates `simple-git` itself via the caller-supplied `git`.
   * Lets save.ts reuse its existing SimpleGit instance without a second
   * process spawn.
   */
  git?: SimpleGit;
}

export interface RestoreOptions {
  /**
   * Overwrite existing files that differ from the captured blob. Default is
   * to refuse so an unsaved change in the working tree isn't silently
   * clobbered.
   */
  forceUntracked: boolean;
  warn?: (message: string) => void;
}

export interface RestoreReport {
  restored: number;
  skipped: number;
  bytesWritten: number;
  /** Relative paths that conflicted without --force-untracked. */
  conflicts: string[];
}

/**
 * Copy the untracked portion of the working tree into a destination dir.
 * Returns the manifest describing what was captured.
 *
 * The caller is responsible for creating `destDir` if desired, OR for passing
 * a dir that doesn't yet exist — we create it on first write. Empty manifests
 * are normal (most working trees have nothing untracked most of the time).
 *
 * @param projectRoot  Absolute path to the repo root. Must match `git.cwd`.
 * @param destDir      Directory to copy untracked files into, mirroring the
 *                     working-tree layout. Usually <stateDir>/untracked or
 *                     the staging equivalent.
 * @param opts.git     Required. SimpleGit instance bound to projectRoot.
 */
export async function captureUntracked(
  projectRoot: string,
  destDir: string,
  opts: CaptureOptions
): Promise<BlobManifest> {
  if (!opts.git) {
    throw new Error("captureUntracked: `opts.git` (SimpleGit) is required");
  }
  const limit = opts.largeFileLimit ?? DEFAULT_LARGE_FILE_LIMIT;
  const warn = opts.warn ?? ((m: string) => console.warn(m));

  const rawList = await getUntrackedFiles(opts.git);
  if (rawList.length === 0) {
    return { files: [] };
  }

  const resolvedRoot = path.resolve(projectRoot);
  const files: BlobManifestEntry[] = [];

  for (const rawRelative of rawList) {
    // Git always emits POSIX-style paths; normalize to platform separators
    // for disk access.
    const relPath = rawRelative.split("/").join(path.sep);
    const absSrc = path.resolve(resolvedRoot, relPath);

    // Path safety: refuse anything that escapes project root.
    if (absSrc !== resolvedRoot && !absSrc.startsWith(resolvedRoot + path.sep)) {
      warn(`Skipping untracked entry with unsafe path: ${rawRelative}`);
      continue;
    }

    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(absSrc);
    } catch {
      // The file git listed disappeared between `ls-files` and our stat —
      // tolerable (e.g. a build process wrote then deleted it). Skip.
      warn(`Skipping vanished untracked file: ${rawRelative}`);
      continue;
    }

    // MVP: skip symlinks with a warning. Supporting them correctly requires
    // refusing traversal targets too, which belongs in a follow-up.
    if (stat.isSymbolicLink()) {
      warn(`Skipping symlink (not captured): ${rawRelative}`);
      continue;
    }

    // git ls-files should only list regular files, but guard anyway.
    if (!stat.isFile()) {
      warn(`Skipping non-regular untracked entry: ${rawRelative}`);
      continue;
    }

    if (stat.size > limit && !opts.includeLarge) {
      warn(
        `Skipping large untracked file (${stat.size} bytes > ${limit}): ${rawRelative}. ` +
          `Re-run with --include-large to capture it.`
      );
      continue;
    }

    const absDest = path.join(destDir, relPath);
    // Path safety for dest: resolve and ensure it stays inside destDir.
    const resolvedDest = path.resolve(absDest);
    const resolvedDestDir = path.resolve(destDir);
    if (
      resolvedDest !== resolvedDestDir &&
      !resolvedDest.startsWith(resolvedDestDir + path.sep)
    ) {
      warn(`Skipping untracked entry with unsafe dest path: ${rawRelative}`);
      continue;
    }

    await fs.mkdir(path.dirname(absDest), { recursive: true });
    await fs.copyFile(absSrc, absDest);
    // Preserve the original mode. fs.copyFile does NOT copy the mode on all
    // platforms; fs.chmod explicitly is portable.
    try {
      await fs.chmod(absDest, stat.mode);
    } catch {
      // Mode restore is best-effort (e.g. Windows rejects some mode bits);
      // the manifest still records the original mode for restore.
    }

    files.push({
      // Always store POSIX paths in the manifest so states remain portable
      // across Windows and Unix.
      relativePath: rawRelative,
      size: stat.size,
      mode: stat.mode,
    });
  }

  return { files };
}

/**
 * Restore previously-captured untracked files back into the working tree.
 *
 * For each manifest entry:
 *   - If the destination already exists and is byte-identical, skip.
 *   - If it exists and differs, refuse unless `forceUntracked` is true.
 *     Conflicts are aggregated and returned so the caller can surface a
 *     useful error message rather than failing on the first one.
 *   - Otherwise, copy the blob from <stateDir>/untracked/<relativePath>
 *     into the working tree, creating parent dirs and restoring the mode.
 *
 * Throws if a manifest entry's blob file is missing on disk (genuine
 * corruption — don't silently skip).
 */
export async function restoreUntracked(
  projectRoot: string,
  manifest: BlobManifest,
  stateDir: string,
  opts: RestoreOptions
): Promise<RestoreReport> {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const resolvedRoot = path.resolve(projectRoot);
  const blobRoot = path.join(stateDir, "untracked");
  const resolvedBlobRoot = path.resolve(blobRoot);

  const report: RestoreReport = {
    restored: 0,
    skipped: 0,
    bytesWritten: 0,
    conflicts: [],
  };

  for (const entry of manifest.files) {
    // Normalize POSIX path (as stored in manifest) to platform separators.
    const relPath = entry.relativePath.split("/").join(path.sep);

    const absDest = path.resolve(resolvedRoot, relPath);
    if (absDest !== resolvedRoot && !absDest.startsWith(resolvedRoot + path.sep)) {
      warn(`Refusing to restore untracked entry with unsafe path: ${entry.relativePath}`);
      continue;
    }

    const absBlob = path.resolve(resolvedBlobRoot, relPath);
    if (
      absBlob !== resolvedBlobRoot &&
      !absBlob.startsWith(resolvedBlobRoot + path.sep)
    ) {
      warn(`Refusing to restore untracked blob with unsafe path: ${entry.relativePath}`);
      continue;
    }

    // Confirm the blob exists on disk. Missing blob = genuine corruption.
    let blobBytes: Buffer;
    try {
      blobBytes = await fs.readFile(absBlob);
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        throw new Error(
          `Untracked blob missing on disk for '${entry.relativePath}' ` +
            `(expected at ${absBlob}). State may be corrupt.`
        );
      }
      throw err;
    }

    // Destination already exists? Check for byte-equality or conflict.
    let destExists = false;
    try {
      const destBytes = await fs.readFile(absDest);
      destExists = true;
      if (destBytes.equals(blobBytes)) {
        report.skipped++;
        continue;
      }
      if (!opts.forceUntracked) {
        report.conflicts.push(entry.relativePath);
        continue;
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
      // No existing file — proceed to write.
    }
    void destExists;

    await fs.mkdir(path.dirname(absDest), { recursive: true });
    await fs.writeFile(absDest, blobBytes);
    try {
      await fs.chmod(absDest, entry.mode);
    } catch {
      // Mode restore best-effort (see captureUntracked note).
    }
    report.restored++;
    report.bytesWritten += blobBytes.length;
  }

  return report;
}

/**
 * Human-readable byte formatter for the load-time restore summary.
 * Small numbers stay in bytes; >1 KB moves to KB, >1 MB moves to MB.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
