import * as vscode from "vscode";
import { runCliRaw } from "../services/cli";
import { showActionableError } from "../ui/error-toast";
import { COMMANDS } from "../constants";

export async function executeBack(workspaceRoot: string): Promise<void> {
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Undoing last load...",
        cancellable: false,
      },
      () => runCliRaw(workspaceRoot, ["back"])
    );
    vscode.window.showInformationMessage("Undid last load.");
  } catch (err: unknown) {
    await showActionableError("Back failed", err, COMMANDS.back);
  }
}
