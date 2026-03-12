import * as vscode from "vscode";
import path from "node:path";
import fs from "node:fs";
import { CONFIG } from "../constants";
import type { EditorState } from "../types";

export async function restoreEditorState(
  workspaceRoot: string,
  editor: EditorState
): Promise<void> {
  if (!editor.openFiles.length) return;

  // Optionally close all editors first
  const confirmClose = vscode.workspace
    .getConfiguration()
    .get<boolean>(CONFIG.confirmEditorClose, true);

  if (confirmClose) {
    const answer = await vscode.window.showWarningMessage(
      "Close all current editors to restore saved layout?",
      { modal: true },
      "Yes",
      "No"
    );
    if (answer === "Yes") {
      await vscode.commands.executeCommand(
        "workbench.action.closeAllEditors"
      );
    }
    // If "No", we open files on top of existing ones
  }

  // Open files grouped by viewColumn for correct ordering
  const sorted = [...editor.openFiles].sort(
    (a, b) => a.viewColumn - b.viewColumn
  );

  for (const file of sorted) {
    const absolutePath = path.join(workspaceRoot, file.relativePath);

    // Skip if file doesn't exist
    if (!fs.existsSync(absolutePath)) {
      vscode.window.showWarningMessage(
        `Skipped missing file: ${file.relativePath}`
      );
      continue;
    }

    try {
      const uri = vscode.Uri.file(absolutePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const ed = await vscode.window.showTextDocument(doc, {
        viewColumn: file.viewColumn,
        preview: false,
        preserveFocus: true,
      });

      // Set cursor position (convert from 1-indexed to 0-indexed)
      const pos = new vscode.Position(
        Math.max(0, file.cursorLine - 1),
        Math.max(0, file.cursorColumn - 1)
      );
      ed.selection = new vscode.Selection(pos, pos);
      ed.revealRange(
        new vscode.Range(pos, pos),
        vscode.TextEditorRevealType.InCenter
      );
    } catch {
      vscode.window.showWarningMessage(
        `Could not open: ${file.relativePath}`
      );
    }
  }

  // Activate the saved active file
  if (editor.activeFile) {
    const activePath = path.join(workspaceRoot, editor.activeFile);
    if (fs.existsSync(activePath)) {
      try {
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.file(activePath)
        );
        await vscode.window.showTextDocument(doc, { preserveFocus: false });
      } catch {
        // best effort
      }
    }
  }
}
