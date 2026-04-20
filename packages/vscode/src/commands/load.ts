import * as vscode from "vscode";
import { runCli } from "../services/cli";
import { readIndex, readState } from "../services/storage-reader";
import { restoreEditorState } from "../services/editor-restore";
import { pickState } from "../ui/quick-pick";

export async function executeLoad(
  workspaceRoot: string,
  stateName?: string
): Promise<void> {
  // If no name provided, show quick pick
  if (!stateName) {
    const index = await readIndex(workspaceRoot);
    const active = index.states.filter((e) => !e.archived);
    active.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );

    if (active.length === 0) {
      vscode.window.showInformationMessage("No save states found.");
      return;
    }

    stateName = await pickState(active, "Select a save state to load");
    if (!stateName) return; // cancelled
  }

  try {
    await runCli(workspaceRoot, [
      "load",
      stateName,
      "--force",
    ]);

    // Load succeeded (or at least didn't throw)
    // Read the state to get editor info
    try {
      const state = await readState(workspaceRoot, stateName);

      // Restore editor state if available
      if (state.editor) {
        await restoreEditorState(workspaceRoot, state.editor);
      }

      // Show mental stack
      const parts = [`Loaded: ${stateName}`];
      if (state.note) parts.push(`\n${state.note}`);
      if (state.nextStep) parts.push(`\nNext: ${state.nextStep}`);

      vscode.window.showInformationMessage(parts.join(""));
    } catch {
      // State read failed but load may have succeeded
      vscode.window.showInformationMessage(`Loaded: ${stateName}`);
    }
  } catch (err: any) {
    vscode.window.showErrorMessage(`Load failed: ${err.message}`);
  }
}
