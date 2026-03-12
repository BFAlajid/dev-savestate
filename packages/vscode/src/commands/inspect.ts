import * as vscode from "vscode";
import { readState } from "../services/storage-reader";
import { showMentalStack } from "../ui/output-channel";

export async function executeInspect(
  workspaceRoot: string,
  stateName?: string
): Promise<void> {
  if (!stateName) {
    stateName = await vscode.window.showInputBox({
      prompt: "State name to inspect",
    });
    if (!stateName) return;
  }

  try {
    const state = await readState(workspaceRoot, stateName);
    showMentalStack(state);
  } catch (err: any) {
    vscode.window.showErrorMessage(
      `Could not inspect '${stateName}': ${err.message}`
    );
  }
}
