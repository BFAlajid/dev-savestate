import * as vscode from "vscode";
import { COMMANDS, VIEWS } from "./constants";
import { SaveStateTreeProvider, SaveStateItem } from "./providers/tree-provider";
import {
  createStatusBar,
  startStatusBarTimer,
  disposeStatusBar,
} from "./ui/status-bar";
import { disposeChannel } from "./ui/output-channel";
import { setCliSecurityOutputChannel } from "./services/cli";
import { executeSave } from "./commands/save";
import { executeLoad } from "./commands/load";
import { executeDelete } from "./commands/delete";
import { executeBack } from "./commands/back";
import { executeInspect } from "./commands/inspect";
import { executeArchive, executeUnarchive } from "./commands/archive";

export function activate(context: vscode.ExtensionContext): void {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) return;

  const projectRoot = workspaceFolder.uri.fsPath;

  // Output channel for security + diagnostic messages. Wire it into the
  // CLI service so workspace-scoped cliPath rejections are visible.
  const securityChannel = vscode.window.createOutputChannel("Dev Savestate");
  setCliSecurityOutputChannel(securityChannel);

  // Tree view
  const treeProvider = new SaveStateTreeProvider(projectRoot);
  const treeView = vscode.window.createTreeView(VIEWS.savestateView, {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  // Status bar
  const statusBar = createStatusBar();
  startStatusBarTimer(projectRoot);

  // File system watchers for auto-refresh
  const indexWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceFolder, ".savestate/index.json")
  );
  const activeWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceFolder, ".savestate/_active.json")
  );

  const refreshAll = () => {
    treeProvider.refresh();
    startStatusBarTimer(projectRoot);
  };

  indexWatcher.onDidChange(refreshAll);
  indexWatcher.onDidCreate(refreshAll);
  indexWatcher.onDidDelete(refreshAll);
  activeWatcher.onDidChange(() => startStatusBarTimer(projectRoot));
  activeWatcher.onDidCreate(() => startStatusBarTimer(projectRoot));
  activeWatcher.onDidDelete(() => startStatusBarTimer(projectRoot));

  // Helper to run command + refresh tree after
  function withRefresh(fn: () => Promise<void>): () => Promise<void> {
    return async () => {
      await fn();
      treeProvider.refresh();
      startStatusBarTimer(projectRoot);
    };
  }

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand(
      COMMANDS.save,
      withRefresh(() => executeSave(projectRoot))
    ),
    vscode.commands.registerCommand(
      COMMANDS.quickSave,
      withRefresh(() => executeSave(projectRoot, true))
    ),
    vscode.commands.registerCommand(COMMANDS.load, (item?: SaveStateItem) =>
      withRefresh(() =>
        executeLoad(projectRoot, item?.entry?.name)
      )()
    ),
    vscode.commands.registerCommand(
      COMMANDS.delete,
      (item?: SaveStateItem) =>
        withRefresh(() =>
          executeDelete(projectRoot, item?.entry?.name)
        )()
    ),
    vscode.commands.registerCommand(
      COMMANDS.inspect,
      (nameOrItem?: string | SaveStateItem) => {
        const name =
          typeof nameOrItem === "string"
            ? nameOrItem
            : nameOrItem?.entry?.name;
        return executeInspect(projectRoot, name);
      }
    ),
    vscode.commands.registerCommand(
      COMMANDS.back,
      withRefresh(() => executeBack(projectRoot))
    ),
    vscode.commands.registerCommand(
      COMMANDS.archive,
      (item?: SaveStateItem) =>
        withRefresh(() =>
          executeArchive(projectRoot, item?.entry?.name ?? "")
        )()
    ),
    vscode.commands.registerCommand(
      COMMANDS.unarchive,
      (item?: SaveStateItem) =>
        withRefresh(() =>
          executeUnarchive(projectRoot, item?.entry?.name ?? "")
        )()
    ),
    vscode.commands.registerCommand(COMMANDS.refresh, () => {
      treeProvider.refresh();
      startStatusBarTimer(projectRoot);
    }),

    // Disposables
    treeView,
    statusBar,
    indexWatcher,
    activeWatcher,
    securityChannel
  );
}

export function deactivate(): void {
  disposeStatusBar();
  disposeChannel();
}
