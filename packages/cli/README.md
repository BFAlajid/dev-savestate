# dev-savestate

Emulator save states for development environments. Save and restore your full working context in seconds.

## Installation

```bash
npm install -g dev-savestate
```

Requires Node.js 20+ and Git.

## Usage

```bash
# Save your current state with a note
dvs save my-feature "Working on the login flow"

# List all saved states
dvs list

# Load a saved state
dvs load my-feature

# Undo the last load
dvs back

# See all commands
dvs --help
```

## What It Captures

- **Git state**: Branch, staged and unstaged changes (binary-safe patches)
- **Untracked files**: New files not yet tracked by git
- **Context note**: Free-text note describing what you were working on
- **Metadata**: Timestamps, time spent in context, load history

When paired with the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=bunji.dev-savestate-vscode), also captures open files, cursor positions, and tab layout.

## Commands

| Command | Description |
|---------|-------------|
| `dvs save <name> [note]` | Save current working context |
| `dvs load <name>` | Restore a saved state |
| `dvs list` | List all saved states |
| `dvs delete <name>` | Delete a saved state |
| `dvs back` | Undo the last load |
| `dvs inspect <name>` | Show state details |
| `dvs diff <a> <b>` | Compare two states |
| `dvs search <query>` | Search states |
| `dvs timeline` | View activity timeline |
| `dvs stats` | Usage statistics |
| `dvs share <name>` | Export a state |
| `dvs import <file>` | Import a shared state |
| `dvs run <label> -- <cmd>` | Run a managed process |
| `dvs recover` | Recover orphaned states |

For the full documentation, see the [project README](https://github.com/BFAlajid/dev-savestate#readme).

## License

MIT
