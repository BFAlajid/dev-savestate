# Dev Savestate for VS Code

Emulator save states for development environments. Save and restore your full working context -- including open files, cursor positions, and tab layout -- in seconds.

## Features

- **Sidebar tree view** showing all saved states with timestamps and notes
- **One-click save and load** from the sidebar or command palette
- **Editor state capture**: open files, cursor positions, active file, tab order, split layout
- **Quick save** for instant saves without prompts
- **Archive management** to organize old states
- **Undo last load** with the `dvs back` command

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+S S` (`Cmd+Shift+S S` on Mac) | Save state |
| `Ctrl+Shift+S Q` (`Cmd+Shift+S Q` on Mac) | Quick save |
| `Ctrl+Shift+S L` (`Cmd+Shift+S L` on Mac) | Load state |

## Requirements

- The `dvs` CLI must be installed: `npm install -g dev-savestate`
- Node.js 20+
- Git

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `devSavestate.cliPath` | `""` | Path to the `dvs` CLI binary. Leave empty for auto-detection. |
| `devSavestate.confirmEditorClose` | `true` | Ask for confirmation before closing editors on load. |
| `devSavestate.showArchivedStates` | `false` | Show archived states in the sidebar tree. |

## How It Works

This extension wraps the `dvs` CLI and adds editor state capture. When you save, it records which files are open, where your cursors are, and how your editor tabs are arranged. When you load, it restores all of that alongside your git state.

States are stored in a `.savestate/` directory in your project root. Add it to your `.gitignore`.

## License

MIT
