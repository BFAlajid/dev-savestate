import * as vscode from "vscode";
import { getOutputChannel } from "./output-channel";

/**
 * Show an actionable error toast that routes to the output channel and
 * (optionally) re-invokes a command for Retry. Callers should pass the
 * retry command id only for idempotent-ish operations (save/load/back/
 * archive/unarchive) — never for destructive ones like delete.
 *
 * The full error (message + stack) is appended to the output channel
 * before the toast is shown, so users who click "Show Output" see the
 * full diagnostic.
 */
/**
 * Retry target: either a bare command ID (invoked with no args — only
 * appropriate for context-less commands like save/back/quickSave) or an
 * object with explicit args so the retry hits the same target (e.g.,
 * archiving the same state, not an empty string).
 */
export type RetryTarget = string | { id: string; args?: readonly unknown[] };

export async function showActionableError(
  contextLabel: string,
  err: unknown,
  retry?: RetryTarget
): Promise<void> {
  const channel = getOutputChannel();
  const error =
    err instanceof Error ? err : new Error(String(err ?? "Unknown error"));

  channel.appendLine(`[${contextLabel}] ${error.message}`);
  if (error.stack) channel.appendLine(error.stack);

  const retryResolved =
    typeof retry === "string" ? { id: retry, args: [] as readonly unknown[] } : retry;

  const actions: string[] = ["Show Output"];
  if (retryResolved) actions.push("Retry");

  const message = `${contextLabel}: ${error.message}`;
  const picked = await vscode.window.showErrorMessage(message, ...actions);

  if (picked === "Show Output") {
    channel.show(true);
  } else if (picked === "Retry" && retryResolved) {
    // Fire-and-forget — VS Code handles the returned promise internally.
    void vscode.commands.executeCommand(
      retryResolved.id,
      ...(retryResolved.args ?? [])
    );
  }
}
