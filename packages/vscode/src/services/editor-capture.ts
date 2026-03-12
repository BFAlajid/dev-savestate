import * as vscode from "vscode";
import path from "node:path";
import type { EditorState } from "../types";

export function captureEditorState(
  workspaceRoot: string
): EditorState {
  const openFiles: EditorState["openFiles"] = [];
  let activeFile: string | undefined;

  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor && !activeEditor.document.isUntitled) {
    activeFile = path.relative(
      workspaceRoot,
      activeEditor.document.uri.fsPath
    );
  }

  // Use tabGroups API (VS Code 1.77+)
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText) {
        const uri = tab.input.uri;
        const relativePath = path.relative(workspaceRoot, uri.fsPath);

        // Skip files outside workspace
        if (relativePath.startsWith("..")) continue;

        // Try to get cursor position from visible editors
        let cursorLine = 1;
        let cursorColumn = 1;

        const visibleEditor = vscode.window.visibleTextEditors.find(
          (e) => e.document.uri.toString() === uri.toString()
        );
        if (visibleEditor) {
          cursorLine = visibleEditor.selection.active.line + 1;
          cursorColumn = visibleEditor.selection.active.character + 1;
        }

        openFiles.push({
          relativePath,
          cursorLine,
          cursorColumn,
          viewColumn: group.viewColumn,
        });
      }
    }
  }

  return { openFiles, activeFile };
}
