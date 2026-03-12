import * as vscode from "vscode";
import type { IndexEntry } from "../types";

export interface StateQuickPickItem extends vscode.QuickPickItem {
  stateName: string;
}

export function buildQuickPickItems(
  entries: IndexEntry[]
): StateQuickPickItem[] {
  return entries.map((entry) => ({
    label: entry.name,
    description: `${entry.branch} - ${formatRelativeTime(entry.updatedAt)}`,
    detail: entry.notePreview || undefined,
    stateName: entry.name,
  }));
}

export async function pickState(
  entries: IndexEntry[],
  placeholder: string
): Promise<string | undefined> {
  const items = buildQuickPickItems(entries);
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: placeholder,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.stateName;
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
