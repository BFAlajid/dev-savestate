import * as vscode from "vscode";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCli } from "../services/cli";
import { captureEditorState } from "../services/editor-capture";

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

    const result = await runCli(workspaceRoot, args);

    if (result.success) {
      vscode.window.showInformationMessage(`Saved: ${name}`);
    } else {
      vscode.window.showErrorMessage(
        `Save failed: ${result.error || "Unknown error"}`
      );
    }
  } catch (err: any) {
    vscode.window.showErrorMessage(`Save failed: ${err.message}`);
  } finally {
    // Clean up temp file
    await fs.unlink(tmpFile).catch(() => {});
  }
}
