import * as vscode from "vscode";
import { runCliRaw } from "../services/cli";

export async function executeArchive(
  workspaceRoot: string,
  stateName: string
): Promise<void> {
  try {
    await runCliRaw(workspaceRoot, ["archive", stateName]);
    vscode.window.showInformationMessage(`Archived: ${stateName}`);
  } catch (err: any) {
    vscode.window.showErrorMessage(`Archive failed: ${err.message}`);
  }
}

export async function executeUnarchive(
  workspaceRoot: string,
  stateName: string
): Promise<void> {
  try {
    await runCliRaw(workspaceRoot, ["unarchive", stateName]);
    vscode.window.showInformationMessage(`Unarchived: ${stateName}`);
  } catch (err: any) {
    vscode.window.showErrorMessage(`Unarchive failed: ${err.message}`);
  }
}
