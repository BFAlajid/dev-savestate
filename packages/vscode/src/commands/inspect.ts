import * as vscode from "vscode";
import { readState } from "../services/storage-reader";
import { showMentalStack } from "../ui/output-channel";
import { showActionableError } from "../ui/error-toast";
import { COMMANDS } from "../constants";

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
    // Intentionally no withProgress — this only reads a local JSON file
    // and returns near-instantly. A progress toast for instant ops is
    // just noise.
    const state = await readState(workspaceRoot, stateName);
    showMentalStack(state);
  } catch (err: unknown) {
    await showActionableError(
      `Could not inspect '${stateName}'`,
      err,
      COMMANDS.inspect
    );
  }
}
