# dev-savestate

Emulator save states for development environments. Save and restore your full working context in seconds.

Developers lose 20-30 minutes per context switch. `dvs` captures your entire working state -- git changes, open files, cursor positions, running processes, and a context note -- then restores it all with a single command.

```
dvs save auth-feature "Debugging token refresh race condition"
# ... switch to another task, come back later ...
dvs load auth-feature
# Back in context in seconds
```

## Installation

```bash
npm install -g dev-savestate
```

Requires Node.js 20 or later and Git.

## Quick Start

```bash
# Save your current state
dvs save my-feature "Working on the login flow"

# List all saved states
dvs list

# Load a saved state
dvs load my-feature

# Undo the last load
dvs back
```

## Core Commands

| Command | Description |
|---------|-------------|
| `dvs save <name> [note]` | Save current working context |
| `dvs load <name>` | Restore a saved state |
| `dvs list` | List all saved states |
| `dvs delete <name>` | Delete a saved state |
| `dvs back` | Undo the last load (restores pre-load checkpoint) |

## Inspect and Compare

| Command | Description |
|---------|-------------|
| `dvs inspect <name>` | Show detailed info about a saved state |
| `dvs diff <a> <b>` | Compare two saved states |

## Search and Analytics

| Command | Description |
|---------|-------------|
| `dvs search <query>` | Search states by name or note content |
| `dvs timeline` | View save/load activity over time |
| `dvs stats` | Show usage statistics |
| `dvs open <name>` | Open a state's storage directory |

## Organization

| Command | Description |
|---------|-------------|
| `dvs archive <name>` | Archive a state (hide from default list) |
| `dvs unarchive <name>` | Unarchive a state |

## Sharing

| Command | Description |
|---------|-------------|
| `dvs share <name>` | Export a state as a portable archive |
| `dvs import <file>` | Import a shared state archive |

## Process Management

| Command | Description |
|---------|-------------|
| `dvs run <label> -- <cmd>` | Run a command as a managed process |
| `dvs stop <label>` | Stop a managed process |
| `dvs status` | Show running managed processes |

## Git Hooks

| Command | Description |
|---------|-------------|
| `dvs hooks install` | Install git hooks for automatic reminders |
| `dvs hooks uninstall` | Remove git hooks |

## Recovery and Maintenance

| Command | Description |
|---------|-------------|
| `dvs recover` | Recover orphaned or corrupted states |
| `dvs unlock` | Remove stale lock files |

## VS Code Extension

The companion VS Code extension adds:

- **Sidebar tree view** of all saved states
- **One-click save/load** with editor state capture (open files, cursor positions, tab layout)
- **Keyboard shortcuts**: `Ctrl+Shift+S S` (save), `Ctrl+Shift+S L` (load), `Ctrl+Shift+S Q` (quick save)
- **Context menu actions** on saved states (load, inspect, archive, delete)
- **Status bar** indicator

Install from the VS Code marketplace or search for "Dev Savestate" in extensions.

## How It Works

`dvs` stores save states in a `.savestate/` directory at your project root:

```
.savestate/
  index.json          # Registry of all states
  states/
    my-feature/
      state.json      # Metadata, branch, HEAD, note, timestamps
      git-patch.diff  # Staged + unstaged changes (git diff --binary)
      blobs/          # Untracked file contents
        manifest.json
        src/new-file.ts
```

**Git state** is captured using `git diff --binary` for both staged and unstaged changes. Patches are applied with `--whitespace=nowarn` for cross-platform reliability. Conflict resolution uses `--3way` fallback, then `--reject` so rejected hunks land as `.rej` files for manual reconciliation.

**Untracked files** are copied into `blobs/` since they have no git history to reconstruct from. Files matching `.gitignore` are excluded.

**Atomic saves** use a staging directory plus rename to prevent corruption from interrupted writes.

**Non-destructive loads** always create a pre-load checkpoint so `dvs back` can undo any load.

Add `.savestate/` to your `.gitignore` -- it contains local working state, not project code.

## Configuration

Create a `.savestaterc.json` in your project root for project-specific settings:

```json
{
  "processes": [
    {
      "label": "dev-server",
      "command": "npm run dev",
      "cwd": "."
    },
    {
      "label": "worker",
      "command": "node worker.js",
      "cwd": "./services"
    }
  ],
  "security": {
    "excludeFromPatch": [
      "**/.env",
      "**/*.pem",
      "**/credentials.json"
    ]
  }
}
```

## License

MIT
