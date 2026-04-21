import * as vscode from "vscode";
import { readIndex } from "../services/storage-reader";
import { CONFIG } from "../constants";
import type { IndexEntry } from "../types";

export class SaveStateItem extends vscode.TreeItem {
  constructor(
    public readonly entry: IndexEntry,
    public readonly isGroup: boolean = false
  ) {
    super(
      entry.name,
      isGroup
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    if (!isGroup) {
      this.description = `${entry.branch} - ${formatRelativeTime(entry.updatedAt)}`;
      this.tooltip = entry.notePreview || entry.name;
      this.contextValue = entry.archived ? "savestate-archived" : "savestate";
      this.iconPath = new vscode.ThemeIcon(
        entry.archived ? "archive" : "bookmark"
      );
      // Click to inspect
      this.command = {
        command: "dvs.inspect",
        title: "Inspect",
        arguments: [entry.name],
      };
    }
  }
}

class GroupItem extends vscode.TreeItem {
  children: SaveStateItem[] = [];

  constructor(label: string, children: SaveStateItem[]) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.children = children;
    this.contextValue = "group";
  }
}

// Allow a plain vscode.TreeItem for the "empty state" placeholder.
type TreeNode = SaveStateItem | GroupItem | vscode.TreeItem;

export class SaveStateTreeProvider
  implements vscode.TreeDataProvider<TreeNode>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    TreeNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (element instanceof GroupItem) {
      return element.children;
    }

    const index = await readIndex(this.projectRoot);
    let entries = index.states;

    // Filter archived unless configured to show
    const showArchived = vscode.workspace
      .getConfiguration()
      .get<boolean>(CONFIG.showArchived, false);

    const active = entries.filter((e) => !e.archived);
    const archived = entries.filter((e) => e.archived);

    // Sort by recency
    active.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );

    const items = active.map((e) => new SaveStateItem(e));

    // If fewer than 6 states, flat list
    if (items.length < 6 && !showArchived) {
      if (items.length === 0) {
        // Inert placeholder: no `command` property (non-clickable) and a
        // distinct contextValue so no context-menu actions match it.
        // Switching to `viewsWelcome` in package.json is the idiomatic
        // fix but is owned by another agent; this is the smallest local
        // change that stops the broken `dvs.inspect` click-through.
        const placeholder = new vscode.TreeItem(
          "No save states yet - click 'Save' in the view title",
          vscode.TreeItemCollapsibleState.None
        );
        placeholder.contextValue = "empty";
        placeholder.iconPath = new vscode.ThemeIcon("info");
        placeholder.tooltip =
          'Run "Dev Savestate: Save" from the command palette to create your first save state.';
        return [placeholder];
      }
      return items;
    }

    // Group by recency
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const weekMs = 7 * dayMs;

    const recent = items.filter(
      (i) => now - new Date(i.entry.updatedAt).getTime() < dayMs
    );
    const thisWeek = items.filter((i) => {
      const age = now - new Date(i.entry.updatedAt).getTime();
      return age >= dayMs && age < weekMs;
    });
    const older = items.filter(
      (i) => now - new Date(i.entry.updatedAt).getTime() >= weekMs
    );

    const groups: TreeNode[] = [];
    if (recent.length) groups.push(new GroupItem("Recent", recent));
    if (thisWeek.length) groups.push(new GroupItem("This Week", thisWeek));
    if (older.length) groups.push(new GroupItem("Older", older));

    if (showArchived && archived.length) {
      archived.sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
      const archivedItems = archived.map((e) => new SaveStateItem(e));
      const archiveGroup = new GroupItem("Archived", archivedItems);
      archiveGroup.collapsibleState =
        vscode.TreeItemCollapsibleState.Collapsed;
      groups.push(archiveGroup);
    }

    return groups;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

function formatRelativeTime(iso: string): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
