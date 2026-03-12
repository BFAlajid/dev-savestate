import * as vscode from "vscode";
import { COMMANDS } from "../constants";
import { readActiveState } from "../services/storage-reader";

let statusBarItem: vscode.StatusBarItem | undefined;
let updateInterval: ReturnType<typeof setInterval> | undefined;

export function createStatusBar(): vscode.StatusBarItem {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.command = COMMANDS.load;
  statusBarItem.tooltip = "Click to load a save state";
  return statusBarItem;
}

export async function updateStatusBar(
  projectRoot: string
): Promise<void> {
  if (!statusBarItem) return;

  const active = await readActiveState(projectRoot);

  if (active) {
    const elapsed = formatElapsed(active.loadedAt);
    statusBarItem.text = `$(bookmark) ${active.stateName}  ${elapsed}`;
    statusBarItem.show();
  } else {
    statusBarItem.hide();
  }
}

export function startStatusBarTimer(projectRoot: string): void {
  stopStatusBarTimer();
  updateStatusBar(projectRoot);
  updateInterval = setInterval(() => updateStatusBar(projectRoot), 60000);
}

export function stopStatusBarTimer(): void {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = undefined;
  }
}

export function disposeStatusBar(): void {
  stopStatusBarTimer();
  statusBarItem?.dispose();
  statusBarItem = undefined;
}

function formatElapsed(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "0m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
