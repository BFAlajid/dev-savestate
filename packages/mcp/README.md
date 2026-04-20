# dev-savestate-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that wraps the [`dvs`](https://github.com/BFAlajid/dev-savestate) CLI so Claude Desktop, Claude Code, Cursor, and other MCP clients can save and restore full developer context as a tool call.

Instead of walking a user through CLI commands, the assistant can say "saving your context as `auth-bug` with note 'stuck on JWT refresh'" and actually do it — or propose a restore and wait for approval.

## What the server exposes

Four tools:

| Tool | Purpose | Mutates state? |
|---|---|---|
| `list_savestates` | List save states in the current project (most recent first). | No |
| `save_current_context` | Capture current git + editor + processes into a named save state. | Writes to `.savestate/` |
| `load_savestate` | Restore a saved context — checkout branch, apply diff, restart processes. | **Yes — rewrites working tree** |
| `inspect_savestate` | Show full details for one save state without loading. | No |

## Install

```bash
npm install -g dev-savestate-mcp dev-savestate
```

- `dev-savestate-mcp` provides the `dvs-mcp` binary (this server).
- `dev-savestate` provides the `dvs` CLI that this server wraps. You need both.

You can also install locally inside a specific project (`npm install --save-dev dev-savestate-mcp dev-savestate`) — the server auto-discovers `./node_modules/.bin/dvs` before falling back to the PATH.

## Client configuration

The MCP client launches `dvs-mcp` as a child process and connects over stdio. **You must set the working directory to the project root** — the server uses `process.cwd()` to find the `.savestate/` folder.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "dev-savestate": {
      "command": "dvs-mcp",
      "cwd": "/absolute/path/to/your/project"
    }
  }
}
```

To manage save states across multiple projects, register a separate entry per project (e.g. `"dev-savestate-backend"`, `"dev-savestate-mobile"`).

### Claude Code

Add to `.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "dev-savestate": {
      "command": "dvs-mcp"
    }
  }
}
```

Claude Code launches MCP servers with CWD set to the project root automatically, so no `cwd` field is needed.

### Cursor

Edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "dev-savestate": {
      "command": "dvs-mcp",
      "cwd": "/absolute/path/to/your/project"
    }
  }
}
```

### Explicit CLI path (any client)

If the server cannot find the `dvs` binary, pass `DVS_CLI_PATH`:

```json
{
  "mcpServers": {
    "dev-savestate": {
      "command": "dvs-mcp",
      "cwd": "/absolute/path/to/your/project",
      "env": {
        "DVS_CLI_PATH": "/absolute/path/to/dvs"
      }
    }
  }
}
```

## Safety notes

- `load_savestate` is marked with the MCP `destructiveHint` annotation. Clients that honor the hint will surface an approval prompt. `force: true` overwrites uncommitted local changes with the saved patch — always confirm with the user first.
- Save states can contain the contents of your working-tree diff, including any secrets you haven't committed. This server does not redact them. Treat the `.savestate/` folder as sensitive.
- The server only operates on the project at `process.cwd()`. It cannot be redirected by tool arguments to touch other directories.

## Known limitations (MVP)

- **No `nextStep` field in `save_current_context`.** The CLI's interactive prompt captures a "next step when you return" hint, but the non-interactive path used by the MCP server has no flag for it. Add the hint to the `note` parameter instead (e.g. `"Stuck on JWT refresh. Next: try swapping libraries."`).
- **`load_savestate` returns plain text, not JSON.** The underlying `dvs load` command has no `--json` flag. The tool returns the CLI's human-readable output, which the model can read directly.
- **Single working directory per server process.** Save states are scoped to the project at `cwd`. To manage multiple projects simultaneously, register one MCP server entry per project.
- **No `delete`, `diff`, `archive`, `search`, `share`, or process-management tools.** MVP scope. Use the `dvs` CLI directly for those.

## Development

From the repo root:

```bash
npm install
cd packages/mcp
npm run build    # bundle to dist/
npm run typecheck
```

To test the server by hand without an MCP client:

```bash
node dist/index.js
```

Then send a JSON-RPC line on stdin and press enter:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/list"}
```

You should see a response listing the four tools.

## License

MIT
