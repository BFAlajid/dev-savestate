import * as vscode from "vscode";
import type { SaveState } from "../types";

let channel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Dev Savestate");
  }
  return channel;
}

export function showMentalStack(state: SaveState): void {
  const ch = getOutputChannel();
  ch.clear();

  const lines: string[] = [];
  lines.push(`=== ${state.name} ===`);
  lines.push(`Branch: ${state.git.branch}`);
  lines.push(`Commit: ${state.git.commitHash.slice(0, 8)}`);
  lines.push(`Saved:  ${formatRelativeTime(state.updatedAt)}`);
  lines.push("");

  if (state.note) {
    lines.push("NOTE:");
    lines.push(state.note);
    lines.push("");
  }

  if (state.nextStep) {
    lines.push("NEXT STEP:");
    lines.push(state.nextStep);
    lines.push("");
  }

  if (state.tags.length) {
    lines.push(`Tags: ${state.tags.join(", ")}`);
    lines.push("");
  }

  if (state.editor?.openFiles?.length) {
    lines.push("FILES:");
    for (const file of state.editor.openFiles) {
      const active =
        file.relativePath === state.editor.activeFile ? "  (active)" : "";
      lines.push(
        `  ${file.relativePath}:${file.cursorLine}:${file.cursorColumn}${active}`
      );
    }
    lines.push("");
  }

  if (state.git.hasUncommittedChanges) {
    lines.push("Has uncommitted changes (patch will be applied on load)");
  } else {
    lines.push("Clean working tree");
  }

  ch.appendLine(lines.join("\n"));
  ch.show(true);
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function disposeChannel(): void {
  channel?.dispose();
  channel = undefined;
}
