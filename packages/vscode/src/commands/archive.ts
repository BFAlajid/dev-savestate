import * as vscode from "vscode";
import { runCliRaw } from "../services/cli";
import { showActionableError } from "../ui/error-toast";
import { COMMANDS } from "../constants";

export async function executeArchive(
  workspaceRoot: string,
  stateName: string
): Promise<void> {
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Archiving '${stateName}'...`,
        cancellable: false,
      },
      () => runCliRaw(workspaceRoot, ["archive", stateName])
    );
    vscode.window.showInformationMessage(`Archived: ${stateName}`);
  } catch (err: unknown) {
    await showActionableError("Archive failed", err, {
      id: COMMANDS.archive,
      args: [{ entry: { name: stateName } }],
    });
  }
}

export async function executeUnarchive(
  workspaceRoot: string,
  stateName: string
): Promise<void> {
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Unarchiving '${stateName}'...`,
        cancellable: false,
      },
      () => runCliRaw(workspaceRoot, ["unarchive", stateName])
    );
    vscode.window.showInformationMessage(`Unarchived: ${stateName}`);
  } catch (err: unknown) {
    await showActionableError("Unarchive failed", err, {
      id: COMMANDS.unarchive,
      args: [{ entry: { name: stateName } }],
    });
  }
}
