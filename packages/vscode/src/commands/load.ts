import * as vscode from "vscode";
import { runCli } from "../services/cli";
import { readIndex, readState } from "../services/storage-reader";
import { restoreEditorState } from "../services/editor-restore";
import { pickState } from "../ui/quick-pick";
import { showActionableError } from "../ui/error-toast";
import { COMMANDS } from "../constants";

// Load applies a git patch which can touch thousands of files on big
// repos. 2 minutes matches the save budget.
const LOAD_TIMEOUT_MS = 120_000;

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
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Loading save state '${stateName}'...`,
        cancellable: false,
      },
      () =>
        runCli(
          workspaceRoot,
          ["load", stateName as string, "--force"],
          LOAD_TIMEOUT_MS
        )
    );

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
  } catch (err: unknown) {
    await showActionableError("Load failed", err, {
      id: COMMANDS.load,
      args: [{ entry: { name: stateName } }],
    });
  }
}
