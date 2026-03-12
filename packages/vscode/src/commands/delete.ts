import * as vscode from "vscode";
import { runCliRaw } from "../services/cli";
import { readIndex } from "../services/storage-reader";
import { pickState } from "../ui/quick-pick";

export async function executeDelete(
  workspaceRoot: string,
  stateName?: string
): Promise<void> {
  if (!stateName) {
    const index = await readIndex(workspaceRoot);
    if (index.states.length === 0) {
      vscode.window.showInformationMessage("No save states to delete.");
      return;
    }

    stateName = await pickState(index.states, "Select a save state to delete");
    if (!stateName) return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Delete save state '${stateName}'? This cannot be undone.`,
    { modal: true },
    "Delete"
  );

  if (confirm !== "Delete") return;

  try {
    await runCliRaw(workspaceRoot, ["delete", stateName]);
    vscode.window.showInformationMessage(`Deleted: ${stateName}`);
  } catch (err: any) {
    vscode.window.showErrorMessage(`Delete failed: ${err.message}`);
  }
}
