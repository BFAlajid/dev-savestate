import * as vscode from "vscode";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCli } from "../services/cli";
import { captureEditorState } from "../services/editor-capture";
import { showActionableError } from "../ui/error-toast";
import { COMMANDS } from "../constants";

// Save on a large repo (big diffs, many processes) can legitimately take
// over 30s. 2 minutes gives us enough headroom without letting a truly
// stuck CLI hang forever.
const SAVE_TIMEOUT_MS = 120_000;

export async function executeSave(
  workspaceRoot: string,
  quickSave = false
): Promise<void> {
  let name: string | undefined;

  if (quickSave) {
    name = "_quicksave";
  } else {
    name = await vscode.window.showInputBox({
      prompt: "Save state name",
      placeHolder: "e.g., feature-auth-wip",
      validateInput: (value) => {
        if (!value) return "Name is required";
        if (/[\/\\:*?"<>|]/.test(value))
          return "Name cannot contain / \\ : * ? \" < > |";
        if (value.length > 100) return "Name too long (max 100)";
        if (value.startsWith(".") || value.startsWith("-"))
          return "Name cannot start with . or -";
        return null;
      },
    });
    if (!name) return; // cancelled
  }

  const note =
    quickSave
      ? ""
      : (await vscode.window.showInputBox({
          prompt: "What are you working on? (optional)",
          placeHolder: "Context note...",
        })) ?? "";

  // Capture editor state
  const editorState = captureEditorState(workspaceRoot);

  // Write editor state to temp file
  const tmpFile = path.join(
    os.tmpdir(),
    `dvs-editor-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  await fs.writeFile(tmpFile, JSON.stringify(editorState));

  try {
    const args = ["save", name];
    if (note) args.push(note);
    args.push("--editor-state", tmpFile, "--json");

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Saving dev-savestate '${name}'...`,
        cancellable: false,
      },
      () => runCli(workspaceRoot, args, SAVE_TIMEOUT_MS)
    );

    if (result.success) {
      vscode.window.showInformationMessage(`Saved: ${name}`);
    } else {
      const reason = result.error || "Unknown error";
      await showActionableError(
        "Save failed",
        new Error(reason),
        quickSave ? COMMANDS.quickSave : COMMANDS.save
      );
    }
  } catch (err: unknown) {
    await showActionableError(
      "Save failed",
      err,
      quickSave ? COMMANDS.quickSave : COMMANDS.save
    );
  } finally {
    // Clean up temp file
    await fs.unlink(tmpFile).catch(() => {});
  }
}
