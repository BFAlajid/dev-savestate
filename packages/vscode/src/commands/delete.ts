import * as vscode from "vscode";
import { runCliRaw } from "../services/cli";
import { readIndex } from "../services/storage-reader";
import { pickState } from "../ui/quick-pick";
import { showActionableError } from "../ui/error-toast";

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
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Deleting save state '${stateName}'...`,
        cancellable: false,
      },
      () => runCliRaw(workspaceRoot, ["delete", stateName as string])
    );
    vscode.window.showInformationMessage(`Deleted: ${stateName}`);
  } catch (err: unknown) {
    // No Retry — deletion is destructive; auto re-invoking past a
    // failure could hide a real problem.
    await showActionableError("Delete failed", err);
  }
}
