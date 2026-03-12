# VS Code Extension Design — dev-savestate (M2)

## Problem

The CLI (`dvs`) captures and restores developer context but cannot access VS Code's runtime state. When run from a terminal, `dvs save` can capture git state, notes, and processes, but editor state (open files, cursor positions, active file, split layout) is invisible. On load, the CLI can only print `code -g file:line:col` hints -- it cannot actually open files or restore cursor positions.

The VS Code extension bridges this gap: it captures editor state on save, restores it on load, and provides a visual interface (sidebar, status bar, command palette) so developers never need to leave their editor.

## Assumptions

1. The CLI (`packages/cli`) is fully implemented and stable. All core operations (save, load, delete, list, inspect, back, etc.) are functional.
2. The CLI exposes a `--json` output mode for machine-readable results (confirmed: `list --json`, `inspect --json`).
3. The extension targets VS Code 1.85+ (November 2023 release, widely adopted by now).
4. The extension will be published to the VS Code Marketplace as a standalone extension.
5. The workspace has exactly one git root. Multi-root workspaces are out of scope for M2.
6. The `dvs` binary is available on PATH, or the extension bundles the CLI package.
7. Node.js 20+ is available in the VS Code runtime (VS Code ships its own Node).

## Options

### Option A: Subprocess CLI Calls

The extension invokes `dvs` as a child process for all operations. The extension only adds editor-state capture/restore and UI on top.

**Pros:**
- Zero code duplication. CLI is the single source of truth for all logic (locking, atomic save, patch application, etc.).
- CLI and extension always stay in sync -- same binary, same behavior.
- Extension is thin: ~500 lines of UI/editor glue code.
- CLI can evolve independently without extension rebuilds.

**Cons:**
- Requires `dvs` on PATH or a reliable resolution strategy.
- Each operation spawns a process (10-50ms overhead per call, negligible for user-initiated actions).
- Error parsing requires structured output (JSON mode).
- Cannot hook into CLI internals (e.g., progress callbacks for long operations).

### Option B: Import Shared Core Library

Extract `packages/cli/src/lib/` into a `packages/core` package. Both CLI and extension import from `packages/core`.

**Pros:**
- In-process calls, no subprocess overhead.
- Type-safe interfaces between extension and core.
- Can share progress/event callbacks.

**Cons:**
- Requires a significant refactor: extract `packages/core`, update CLI to import from it, new build pipeline.
- VS Code extensions use CommonJS (`require`), but CLI is ESM. Need dual-format builds or bundler shimming.
- Core lib would need to avoid any CLI-specific imports (commander, readline, process.exit).
- Increases coupling: core changes require rebuilding both CLI and extension.
- Delays M2 by 1-2 days for the extraction refactor.

### Option C: Hybrid — Subprocess for Heavy Operations, Direct File I/O for Reads

The extension invokes `dvs` as a subprocess for mutating operations (save, load, delete, back) but reads `.savestate/index.json` and `state.json` directly for display (list, inspect, sidebar tree).

**Pros:**
- Fast sidebar rendering (no subprocess for reads).
- Mutating operations use the CLI's battle-tested locking and atomicity.
- No core extraction needed.
- FileSystemWatcher can detect `.savestate/` changes from CLI usage and refresh the tree.

**Cons:**
- Two code paths for reading state (extension reads JSON directly, CLI reads via storage.ts).
- Schema coupling: extension must understand `IndexFile` and `SaveState` types.
- Risk of stale reads if FileSystemWatcher misses an event.

## Chosen Architecture: Option C — Hybrid

**Justification:**

The sidebar tree view is the most latency-sensitive path. Users expect instant rendering when opening the sidebar, and spawning `dvs list --json` on every tree refresh adds unnecessary delay. Reading `index.json` directly is <1ms.

All mutating operations go through the CLI subprocess, preserving the single-writer guarantee (locking, atomic saves, pre-load checkpoints). This means the extension does not need to duplicate any of the safety-critical logic.

The schema coupling risk is low: `IndexFile` and `SaveState` are versioned (`version: 1`), stable types defined in `packages/cli/src/lib/types.ts`. The extension copies these type definitions (not imports -- to avoid build coupling). If the schema version changes, both must be updated, but that is an infrequent, deliberate event.

FileSystemWatcher on `.savestate/index.json` handles cross-tool consistency: if the user runs `dvs save` from a terminal, the sidebar auto-refreshes.

**Tradeoffs accepted:**
- Duplicated type definitions (low maintenance cost, high decoupling benefit).
- Subprocess overhead on save/load (~50ms, invisible behind the git operations that take seconds).
- Extension cannot show granular progress during CLI operations (acceptable: operations complete in <5s typically).

---

## Interfaces and Data Model

### Extension-to-CLI Interface

All mutating operations invoke the CLI as a subprocess:

```
dvs save <name> "<note>" --tag <t1> --tag <t2> --json
dvs load <name> --force --json
dvs delete <name> --json
dvs back --json
dvs archive <name> --json
dvs unarchive <name> --json
```

The `--json` flag causes the CLI to emit structured JSON to stdout. The extension parses this for success/error reporting.

**Editor state injection:** On save, the extension captures editor state and writes it to a temporary file, then passes it to the CLI:

```
dvs save <name> "<note>" --editor-state <path-to-temp-json>
```

This requires a small CLI enhancement: `save` accepts `--editor-state <file>` which reads the JSON and merges it into `state.editor`. This keeps editor-state capture in the extension (where the API lives) and persistence in the CLI (where atomicity lives).

On load, the extension reads the loaded state's `editor` field from `state.json` directly and restores files programmatically via the VS Code API.

### Editor State Schema

The extension captures this on save:

```typescript
interface EditorStateCapture {
  openFiles: Array<{
    relativePath: string;   // relative to workspace root
    cursorLine: number;     // 1-indexed
    cursorColumn: number;   // 1-indexed
    viewColumn: number;     // vscode.ViewColumn (1, 2, 3...)
    isPinned: boolean;
  }>;
  activeFile?: string;      // relativePath of the active editor
}
```

This matches the `SaveState.editor` schema from `types.ts`.

### Direct File I/O Interface

The extension reads these files directly (no subprocess):

| File | Purpose | When |
|---|---|---|
| `.savestate/index.json` | Sidebar tree population | On activation, on FileSystemWatcher event |
| `.savestate/states/<name>/state.json` | Inspect detail, mental stack display | On tree item click |
| `.savestate/states/<name>/note.md` | Note preview in hover/tooltip | On hover |
| `.savestate/_active.json` | Active state detection for status bar | On activation, on watcher event |

### Commands Registered

| Command ID | Title | Keybinding | Context Menu |
|---|---|---|---|
| `dvs.save` | Dev Savestate: Save | `Ctrl+Shift+S S` | -- |
| `dvs.quickSave` | Dev Savestate: Quick Save | `Ctrl+Shift+S Q` | -- |
| `dvs.load` | Dev Savestate: Load | `Ctrl+Shift+S L` | Tree item |
| `dvs.delete` | Dev Savestate: Delete | -- | Tree item |
| `dvs.inspect` | Dev Savestate: Inspect | -- | Tree item |
| `dvs.back` | Dev Savestate: Undo Last Load | -- | -- |
| `dvs.archive` | Dev Savestate: Archive | -- | Tree item |
| `dvs.unarchive` | Dev Savestate: Unarchive | -- | Tree item |
| `dvs.refresh` | Dev Savestate: Refresh | -- | View title |
| `dvs.showNote` | Dev Savestate: Show Note | -- | Tree item |

### TreeDataProvider

The sidebar uses a `vscode.TreeDataProvider<SaveStateItem>` with two levels:

**Level 1 — Group headers (optional, based on count):**
- "Recent" (updated within 24h)
- "This Week"
- "Older"
- "Archived" (collapsed by default)

If there are fewer than 6 states, skip grouping and show a flat list.

**Level 2 — State entries:**

Each `SaveStateItem` is a `vscode.TreeItem` with:
- `label`: state name
- `description`: branch name + relative time (e.g., `main - 2h ago`)
- `tooltip`: full note text
- `iconPath`: different icons for active state vs. archived vs. normal
- `contextValue`: `"savestate"` or `"savestate-archived"` (controls context menu visibility)
- `command`: on click, runs `dvs.inspect` to show the mental stack in an output channel

### Status Bar

A `vscode.StatusBarItem` on the left side (priority 100):

```
$(bookmark) auth-feature  47m
```

- Shows the currently active state name and elapsed time since load.
- Updated every 60 seconds via `setInterval`.
- Click action: `dvs.load` (opens quick pick to switch states).
- Hidden when no state is active.
- Active state determined by reading `.savestate/_active.json` (contains `stateName` and `loadedAt` timestamp).

### Mental Stack Display

When a state is inspected or loaded, the mental stack (note + next step + open files) is displayed in a dedicated **Output Channel** named "Dev Savestate".

Rationale for Output Channel over Webview:
- Output Channel is lightweight, always available, and does not require HTML/CSS.
- Mental stack is text-only content.
- Webview would add significant complexity (CSP, message passing, HTML template) for minimal visual benefit.
- Output Channel persists across editor restarts.

Format:

```
=== auth-feature ===
Branch: main
Saved: 2h ago (Mar 12, 14:30)

NOTE:
Debugging token refresh race condition. The issue is in
middleware.ts where the refresh token is read before the
previous request's write completes.

NEXT STEP:
Add a mutex around the token refresh call in middleware.ts:89

FILES:
  src/middleware.ts:89:12  (active)
  src/auth/token.ts:45:1
  tests/auth.test.ts:120:5
```

---

## File Structure

```
packages/vscode/
  package.json              # Extension manifest (contributes, activationEvents, etc.)
  tsconfig.json             # TypeScript config (CommonJS output for VS Code)
  esbuild.config.mjs        # Build script
  .vscodeignore             # Files excluded from VSIX package

  src/
    extension.ts            # activate() / deactivate() entry point
    commands/
      save.ts               # Save command (capture editor state, invoke CLI)
      load.ts               # Load command (invoke CLI, restore editor state)
      delete.ts             # Delete command (confirm, invoke CLI)
      back.ts               # Undo last load
      inspect.ts            # Show mental stack in output channel
      archive.ts            # Archive/unarchive
    providers/
      tree-provider.ts      # SaveStateTreeDataProvider
      tree-items.ts         # TreeItem subclasses (group header, state entry)
    services/
      cli.ts                # CLI subprocess wrapper (spawn dvs, parse JSON output)
      storage-reader.ts     # Direct file reader for index.json, state.json
      editor-capture.ts     # Capture current editor state from VS Code API
      editor-restore.ts     # Restore editor state (open files, set cursors)
    ui/
      status-bar.ts         # Status bar item management
      quick-pick.ts         # Quick pick helpers for load/delete selection
      output-channel.ts     # Mental stack output channel
    types.ts                # Duplicated SaveState, IndexFile, IndexEntry types
    constants.ts            # Command IDs, view IDs, config keys
```

### File Responsibilities

**`extension.ts`** — Entry point. Registers all commands, creates TreeDataProvider, creates StatusBarItem, sets up FileSystemWatcher on `.savestate/`, starts heartbeat timer. Disposes everything in `deactivate()`.

**`services/cli.ts`** — Wraps `child_process.execFile` to invoke `dvs`. Resolves the binary path (workspace `node_modules/.bin/dvs`, global PATH, or bundled). Returns typed results. Handles timeout (30s default). Passes `--json` flag. Sets `cwd` to workspace root.

**`services/storage-reader.ts`** — Reads `.savestate/index.json` and `.savestate/states/<name>/state.json` directly via `fs.readFile`. Returns typed objects. Handles missing/corrupt files gracefully (returns empty defaults). No write operations.

**`services/editor-capture.ts`** — Queries `vscode.window.tabGroups` API (VS Code 1.77+) to capture:
- All open text editor tabs across all groups
- For each: relative path, cursor position (from `vscode.window.activeTextEditor` or `TextDocument` metadata), view column, pinned status
- The active editor's relative path

**`services/editor-restore.ts`** — Given an `EditorStateCapture`, opens files sequentially:
1. Close all current editors (`vscode.commands.executeCommand('workbench.action.closeAllEditors')`) -- only after user confirmation via dialog
2. For each file in `openFiles`, ordered by `viewColumn`:
   - `vscode.workspace.openTextDocument(absolutePath)`
   - `vscode.window.showTextDocument(doc, { viewColumn, preview: false })`
   - Set cursor: `editor.selection = new vscode.Selection(pos, pos)` and `editor.revealRange()`
3. Finally, activate the `activeFile` editor

**`providers/tree-provider.ts`** — Implements `TreeDataProvider<SaveStateItem>`. Reads `index.json` via `storage-reader.ts`. Groups entries by recency. Fires `onDidChangeTreeData` when FileSystemWatcher detects changes. Supports `getParent()` for reveal.

**`ui/status-bar.ts`** — Creates and manages the status bar item. Reads `_active.json` to determine if a state is loaded. Starts a 60-second interval to update elapsed time. Hides when no state is active.

---

## Activation Events

```jsonc
"activationEvents": [
  "workspaceContains:.savestate",
  "onView:dvs.savestateView",
  "onCommand:dvs.save",
  "onCommand:dvs.load"
]
```

The extension activates lazily:
- If `.savestate/` exists in the workspace (returning user).
- If the user opens the sidebar view (first interaction).
- If the user runs a command from the palette.

The extension does NOT activate on every workspace open -- only when there is evidence the user uses dev-savestate.

---

## CLI Enhancement Required

The `save` command needs one addition for M2:

**`--editor-state <file>`** — Accepts a path to a JSON file containing `EditorStateCapture`. The save command reads this file and merges its contents into `state.editor` before persisting.

This is a minimal, backward-compatible change:
- CLI-only users: `state.editor` remains `undefined` (no change).
- Extension users: extension writes temp file, passes path, CLI reads and includes it.

The alternative (extension writes to `state.json` directly after CLI save) would break atomicity guarantees. The `--editor-state` flag keeps the CLI as the single writer.

---

## Failure Modes

| Failure | Detection | Mitigation |
|---|---|---|
| `dvs` binary not found | `execFile` returns ENOENT | Show error with install instructions: `npm i -g dev-savestate` |
| CLI returns non-zero exit | Parse stderr, exit code | Show error notification with stderr content |
| `index.json` corrupt/missing | JSON.parse throws or file missing | Return empty state list, show warning |
| `state.json` corrupt | JSON.parse throws | Show error on inspect, skip in tree view |
| FileSystemWatcher misses event | Stale tree data | Manual refresh button in view title; also refresh on command completion |
| Editor state capture fails (file deleted between capture and open) | `openTextDocument` throws | Skip that file, continue with remaining files, warn user |
| Save while another save in progress | CLI lock contention, ELOCKED error | Show "Another operation in progress" notification |
| Large workspace with many states (>100) | Tree render slowness | Paginate tree (show top 50, "Show More" node) |
| Extension activated but no git repo | CLI returns error | Show "Not a git repository" in tree view as placeholder |
| User declines editor close on load | Confirmation dialog returns false | Abort the editor restore portion only; git state still restored |
| `_active.json` stale (extension crashed) | Heartbeat timestamp >5min old, PID dead | Status bar hides, state treated as inactive |

---

## Security

- The extension runs in the VS Code Extension Host (same trust level as all extensions).
- No network requests. All data is local filesystem.
- CLI subprocess is invoked with workspace root as cwd. No shell expansion (`execFile`, not `exec`).
- Temp files for `--editor-state` are written to `os.tmpdir()` with random names and deleted after use.
- The extension does not read or display process commands (which may contain secrets). Mental stack display shows only note, next step, and file paths.
- No telemetry, no analytics, no external services.
- `.savestate/` is gitignored by the CLI on init (confirmed in `storage.ts`).

---

## Performance

| Operation | Expected Latency | Budget |
|---|---|---|
| Sidebar tree render (from index.json) | <5ms for 100 states | 50ms |
| Save (editor capture + CLI subprocess) | <2s (dominated by git diff) | 5s |
| Load (CLI subprocess + editor restore) | <3s (dominated by git checkout + apply) | 10s |
| Status bar update | <1ms (read cached state) | 10ms |
| FileSystemWatcher callback + tree refresh | <10ms | 50ms |
| Inspect (read state.json + render output) | <5ms | 50ms |

The extension should not block the UI thread. All CLI subprocess calls use `execFile` which is inherently async. File reads use `fs.promises`. Editor state restoration uses `async/await` with sequential `showTextDocument` calls (VS Code requires sequential editor opens to respect view columns correctly).

---

## Testing and Observability

### Test Strategy

**Unit tests (Vitest):**
- `storage-reader.ts` — reads/parses index.json and state.json fixtures.
- `editor-capture.ts` — mock `vscode.window.tabGroups` and verify output schema.
- `cli.ts` — mock `child_process.execFile`, verify command construction, JSON parsing, error handling.
- `tree-provider.ts` — verify grouping logic, item construction from index entries.
- `status-bar.ts` — verify elapsed time formatting.

**Integration tests (VS Code Extension Testing API / `@vscode/test-electron`):**
- Activate extension in a workspace with `.savestate/`.
- Run `dvs.save` command, verify editor state is captured.
- Run `dvs.load` command, verify files are opened at correct positions.
- Verify tree view populates from a fixture `index.json`.
- Verify status bar appears/disappears based on `_active.json`.

**Manual test scenarios:**
- Save with 10 open files across 3 split groups, load in fresh window, verify layout.
- Run `dvs save` from terminal, verify sidebar auto-refreshes.
- Load a state with a deleted file, verify graceful skip.
- Load a state while working tree is dirty, verify confirmation dialog.

### Observability

- Output channel "Dev Savestate" logs all CLI invocations and their results (with command args redacted for security).
- Extension logs use `console.log` (visible in Developer Tools > Console).
- CLI subprocess stderr is captured and logged to the output channel.
- No telemetry or external logging.

---

## Build and Bundle Strategy

**Bundler:** esbuild (consistent with architecture doc, fast, single-file output).

**Build config:**
- Entry point: `src/extension.ts`
- Output: `dist/extension.js` (single file, CommonJS format)
- Platform: `node`
- External: `vscode` (provided by VS Code runtime)
- Minify: yes for production, no for development
- Source maps: yes

**package.json (extension manifest) key fields:**

```jsonc
{
  "name": "dev-savestate",
  "displayName": "Dev Savestate",
  "description": "Emulator save states for development environments",
  "version": "0.1.0",
  "publisher": "bunji",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Other"],
  "main": "./dist/extension.js",
  "activationEvents": [
    "workspaceContains:.savestate",
    "onView:dvs.savestateView"
  ],
  "contributes": {
    "commands": [
      { "command": "dvs.save", "title": "Dev Savestate: Save", "icon": "$(save)" },
      { "command": "dvs.quickSave", "title": "Dev Savestate: Quick Save", "icon": "$(save-all)" },
      { "command": "dvs.load", "title": "Dev Savestate: Load", "icon": "$(folder-opened)" },
      { "command": "dvs.delete", "title": "Dev Savestate: Delete", "icon": "$(trash)" },
      { "command": "dvs.inspect", "title": "Dev Savestate: Inspect", "icon": "$(info)" },
      { "command": "dvs.back", "title": "Dev Savestate: Undo Last Load", "icon": "$(discard)" },
      { "command": "dvs.archive", "title": "Dev Savestate: Archive" },
      { "command": "dvs.unarchive", "title": "Dev Savestate: Unarchive" },
      { "command": "dvs.refresh", "title": "Dev Savestate: Refresh", "icon": "$(refresh)" },
      { "command": "dvs.showNote", "title": "Dev Savestate: Show Note" }
    ],
    "views": {
      "explorer": [
        {
          "id": "dvs.savestateView",
          "name": "Save States",
          "icon": "$(bookmark)",
          "contextualTitle": "Dev Savestate"
        }
      ]
    },
    "viewsContainers": {
      "activitybar": [
        {
          "id": "dvs-sidebar",
          "title": "Dev Savestate",
          "icon": "$(bookmark)"
        }
      ]
    },
    "menus": {
      "view/title": [
        { "command": "dvs.save", "when": "view == dvs.savestateView", "group": "navigation" },
        { "command": "dvs.refresh", "when": "view == dvs.savestateView", "group": "navigation" }
      ],
      "view/item/context": [
        { "command": "dvs.load", "when": "viewItem == savestate", "group": "1_actions@1" },
        { "command": "dvs.inspect", "when": "viewItem == savestate || viewItem == savestate-archived", "group": "1_actions@2" },
        { "command": "dvs.showNote", "when": "viewItem == savestate || viewItem == savestate-archived", "group": "1_actions@3" },
        { "command": "dvs.archive", "when": "viewItem == savestate", "group": "2_manage@1" },
        { "command": "dvs.unarchive", "when": "viewItem == savestate-archived", "group": "2_manage@1" },
        { "command": "dvs.delete", "when": "viewItem == savestate || viewItem == savestate-archived", "group": "3_danger@1" }
      ]
    },
    "keybindings": [
      { "command": "dvs.save", "key": "ctrl+shift+s s", "mac": "cmd+shift+s s" },
      { "command": "dvs.quickSave", "key": "ctrl+shift+s q", "mac": "cmd+shift+s q" },
      { "command": "dvs.load", "key": "ctrl+shift+s l", "mac": "cmd+shift+s l" }
    ],
    "configuration": {
      "title": "Dev Savestate",
      "properties": {
        "devSavestate.cliPath": {
          "type": "string",
          "default": "",
          "description": "Path to the dvs CLI binary. Leave empty for auto-detection."
        },
        "devSavestate.confirmEditorClose": {
          "type": "boolean",
          "default": true,
          "description": "Ask for confirmation before closing all editors on load."
        },
        "devSavestate.showArchivedStates": {
          "type": "boolean",
          "default": false,
          "description": "Show archived states in the sidebar tree."
        }
      }
    }
  }
}
```

**Decision: Own activity bar icon vs. Explorer sub-view.**

For M2, register the view under `explorer` (as a collapsible section in the Explorer sidebar). This avoids adding another activity bar icon that users must discover. In M7, when the sidebar gets richer (timeline, tags, search), it moves to its own activity bar container.

The manifest above shows both configurations. For M2 implementation, use the `explorer` view and remove the `viewsContainers` block.

---

## Task Plan

### Task 1: Scaffold `packages/vscode/` (0.5 day)

- Create directory structure as specified above.
- Write `package.json` (extension manifest with all contributes).
- Write `tsconfig.json` (target ES2022, module CommonJS, strict, external vscode types).
- Write `esbuild.config.mjs` (entry point, externals, CJS output).
- Write `.vscodeignore`.
- Add `"packages/vscode"` to root `package.json` workspaces.
- Add `@types/vscode`, `esbuild`, `@vscode/test-electron` as devDependencies.
- Verify: `npm run build` in packages/vscode produces `dist/extension.js`.

### Task 2: CLI Enhancement — `--editor-state` flag (0.5 day)

- Add `--editor-state <file>` option to `save` command in `packages/cli/src/commands/save.ts`.
- When provided, read the JSON file, validate it matches `EditorStateCapture` schema, merge into `state.editor`.
- Delete the temp file after reading.
- Add `--json` output mode to `save` command (emit `{ success: true, name, ... }` or `{ success: false, error: "..." }`).
- Add tests for both flags.

### Task 3: Core Services (1 day)

- **`services/cli.ts`** — CLI subprocess wrapper. Binary resolution logic: (1) `devSavestate.cliPath` setting, (2) workspace `node_modules/.bin/dvs`, (3) global `dvs` on PATH. `execFile` wrapper with JSON parsing and error normalization.
- **`services/storage-reader.ts`** — Direct reader for `index.json` and `state.json`. Type-safe parsing with fallback defaults.
- **`types.ts`** — Copy `SaveState`, `IndexFile`, `IndexEntry` type definitions from CLI.
- **`constants.ts`** — Command IDs, view IDs, config keys as string constants.
- Unit tests for cli.ts (mock execFile) and storage-reader.ts (fixture files).

### Task 4: Editor State Capture and Restore (1 day)

- **`services/editor-capture.ts`** — Use `vscode.window.tabGroups.all` to iterate tab groups and tabs. For each `TabInputText`, resolve relative path, read cursor from associated `TextEditor` if available (fallback to line 1, col 1). Build `EditorStateCapture` object.
- **`services/editor-restore.ts`** — Accept `EditorStateCapture`. Optionally close all editors (with confirmation dialog). Open files in correct view columns with correct cursor positions. Handle missing files gracefully.
- Unit tests with mocked vscode API.

### Task 5: Tree View Provider (0.5 day)

- **`providers/tree-provider.ts`** — `SaveStateTreeDataProvider` implementing `TreeDataProvider<SaveStateItem>`. Reads index via `storage-reader`. Groups by recency (or flat for <6 states). Fires refresh on `onDidChangeTreeData` event.
- **`providers/tree-items.ts`** — `SaveStateItem` extending `TreeItem`. Configures label, description, tooltip, icon, contextValue, and inline command.
- Register in `extension.ts` with `vscode.window.createTreeView()`.

### Task 6: Commands (1 day)

- **`commands/save.ts`** — Prompt for name (InputBox) and note (InputBox). Capture editor state. Write to temp file. Invoke `dvs save <name> "<note>" --editor-state <temp> --json`. Show success/error notification. Refresh tree.
- **`commands/load.ts`** — Show QuickPick of states (from storage-reader). Invoke `dvs load <name> --force --json`. On success, read `state.json` for editor state and call `editor-restore`. Refresh tree. Update status bar.
- **`commands/delete.ts`** — Confirm with dialog. Invoke `dvs delete <name> --json`. Refresh tree.
- **`commands/back.ts`** — Invoke `dvs back --json`. On success, restore pre-load editor state if available. Refresh tree. Clear status bar.
- **`commands/inspect.ts`** — Read `state.json` via storage-reader. Format mental stack. Write to output channel.
- **`commands/archive.ts`** — Invoke `dvs archive/unarchive <name> --json`. Refresh tree.

### Task 7: Status Bar and UI (0.5 day)

- **`ui/status-bar.ts`** — Create `StatusBarItem`. Read `_active.json` for current state. 60s interval timer for elapsed time. Click triggers `dvs.load`.
- **`ui/output-channel.ts`** — Create and manage the "Dev Savestate" output channel. Format mental stack text.
- **`ui/quick-pick.ts`** — Helper to build QuickPickItems from IndexEntries with branch and time metadata.

### Task 8: Extension Entry Point and Wiring (0.5 day)

- **`extension.ts`** — `activate()`: register all commands, create tree view, create status bar, create FileSystemWatcher for `.savestate/index.json` and `_active.json`, wire watcher events to tree refresh and status bar update. `deactivate()`: dispose all subscriptions, clear intervals, kill any pending CLI processes.
- Set up `context.subscriptions` for proper cleanup.

### Task 9: Integration Testing (1 day)

- Set up `@vscode/test-electron` runner.
- Test: extension activates when `.savestate/` exists.
- Test: save command captures editor state.
- Test: load command opens files at correct positions.
- Test: tree view shows states from fixture index.
- Test: status bar shows/hides based on active state.
- Test: FileSystemWatcher triggers tree refresh.

### Task 10: Polish and Manual Testing (0.5 day)

- Error message review (every error suggests a fix).
- Icon selection for tree items.
- Keybinding conflict check.
- Test on Windows, macOS, Linux (if CI available).
- Write `.vscodeignore` to minimize VSIX size.
- Test `vsce package` produces a valid VSIX.

**Total estimate: 7 days**

---

## Open Questions

1. **Should the sidebar live in Explorer or get its own activity bar icon?** The design proposes Explorer for M2, own icon for M7. Confirm this is acceptable or if users will expect a dedicated icon from day one.

2. **Quick Save behavior:** The architecture doc mentions "rotating quick-save slots (max 5)." For M2, should Quick Save simply overwrite a single `_quicksave` slot, or implement the rotation immediately? Recommendation: single slot for M2, rotation in M7.

3. **`--json` output mode coverage:** The CLI currently has `--json` on `list` and `inspect`. The `save`, `load`, `delete`, and `back` commands need `--json` added. Is this acceptable scope for M2, or should the extension parse human-readable output as a temporary measure?

4. **Tab group / split layout fidelity:** The `vscode.window.tabGroups` API provides view column info, but restoring exact split ratios (e.g., 60/40 split) requires `workbench.action.evenEditorWidths` or undocumented layout APIs. Should M2 attempt exact ratio restoration, or accept "correct column, default ratio"? Recommendation: correct column only for M2.

5. **Confirmation dialog on load:** When loading, the extension closes all editors to restore saved layout. Should this be (a) always confirm, (b) confirm only if there are unsaved changes, or (c) configurable? The design proposes configurable via `devSavestate.confirmEditorClose` defaulting to true.

6. **CLI binary bundling:** Should the VSIX bundle the CLI binary, or require it as a global install? Bundling increases VSIX size but eliminates the "dvs not found" failure mode. Recommendation: require global install for M2, bundle in M8.
