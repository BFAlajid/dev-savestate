import * as vscode from "vscode";
import { runCliRaw } from "../services/cli";

export async function executeBack(workspaceRoot: string): Promise<void> {
  try {
    await runCliRaw(workspaceRoot, ["back"]);
    vscode.window.showInformationMessage("Undid last load.");
  } catch (err: any) {
    vscode.window.showErrorMessage(`Back failed: ${err.message}`);
  }
}
