// Editor collector: VS Code open files / cursor positions.
//
// The VS Code extension writes editor state (open files, cursor positions,
// view columns, active file) to a JSON temp file under the OS tmpdir or
// .savestate/_tmp/ and invokes the CLI with `--editor-state <file>`. The
// collector reads that temp file on capture, validates the path to prevent
// arbitrary-file-read / arbitrary-file-unlink abuse, and returns an
// `editor` slice. The temp file is unlinked as a side effect of capture
// (the extension expects one-shot consumption, matching pre-refactor save.ts
// behavior).
//
// Restore is a no-op here. The CLI has no IDE to open files in; the VS Code
// extension side performs the actual "reveal file at line:col" after a
// successful `dvs load`. See the load.ts `state.editor?.openFiles` block
// which prints `code -g <path>:<line>:<col>` hints for humans.
//
// Future: a neovim / JetBrains plugin would register its own editor
// collector that writes a different temp-file shape and restores by
// instructing the host IDE. The SaveState.editor sub-schema uses
// .passthrough() (see schemas.ts), so new fields can be added without a
// breaking schema bump.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { tmpDir as savestateTmpDir } from "../paths.js";
import type { SaveState } from "../types.js";
import type {
  CaptureContext,
  CaptureResult,
  Collector,
  RestoreContext,
} from "./types.js";

/**
 * Validate an `--editor-state` path. Must live under the OS tmpdir OR
 * .savestate/_tmp — any other location means the caller is trying to
 * coerce the CLI into reading then unlinking arbitrary files.
 *
 * Throws on any rejection; callers must wrap in try/catch to surface a
 * user-friendly error.
 */
export function assertSafeEditorStatePath(
  candidate: string,
  projectRoot: string
): void {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error("Invalid --editor-state path: empty");
  }
  if (candidate.includes("\x00")) {
    throw new Error("Invalid --editor-state path: contains null byte");
  }
  const resolved = path.resolve(candidate);
  const tmp = path.resolve(os.tmpdir()) + path.sep;
  const localTmp = path.resolve(savestateTmpDir(projectRoot)) + path.sep;
  if (!resolved.startsWith(tmp) && !resolved.startsWith(localTmp)) {
    throw new Error(
      "Invalid --editor-state path: must be under tmpdir or .savestate/_tmp"
    );
  }
}

export const editorCollector: Collector = {
  name: "editor",

  async capture(ctx: CaptureContext): Promise<CaptureResult> {
    const editorStateFile = ctx.opts.editorStateFile;
    if (typeof editorStateFile !== "string" || editorStateFile.length === 0) {
      // No temp file handed in — capture is a no-op, save proceeds without
      // an `editor` field. Matches pre-refactor behavior where `editor`
      // stayed undefined when --editor-state was omitted.
      return { slice: {} };
    }

    // Enforce path constraint BEFORE any read or unlink — prevents tricking
    // the CLI into reading/unlinking arbitrary files.
    assertSafeEditorStatePath(editorStateFile, ctx.projectRoot);

    let editor: SaveState["editor"] | undefined;
    try {
      const raw = await fs.readFile(editorStateFile, "utf-8");
      editor = JSON.parse(raw);
      // Clean up the temp file (only reached after path check passed).
      await fs.unlink(editorStateFile).catch(() => {});
    } catch {
      // Invalid or unreadable editor state — save proceeds without it.
      // Matches pre-refactor: the file was a nice-to-have, never a blocker.
      return { slice: {} };
    }

    if (!editor) return { slice: {} };
    return { slice: { editor } };
  },

  async restore(_ctx: RestoreContext, _state: SaveState): Promise<void> {
    // Intentional no-op on the CLI side. The VS Code extension consumes
    // `state.editor` directly after the CLI-driven load finishes (see
    // packages/vscode/src/commands/load.ts). A future third-party editor
    // collector (neovim, JetBrains) would override this with host-IDE-
    // specific restore logic.
  },
};
