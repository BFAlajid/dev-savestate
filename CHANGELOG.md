# Changelog
All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- `packages/mcp`: Model Context Protocol server wrapper exposing dvs as
  tools for Claude Desktop, Claude Code, Cursor, and other MCP clients
  (`list_savestates`, `save_current_context`, `load_savestate`,
  `inspect_savestate`).
- VS Code extension: progress notifications for long-running save/load/
  delete/back/archive operations (previously looked hung for up to 30s).
- VS Code extension: actionable error toasts with "Show Output" and
  "Retry" buttons. Retry re-invokes with the original target so
  archive/unarchive/load no longer retry with an empty state name.
- CLI: runtime Zod validation on every persisted JSON read
  (`state.json`, `index.json`, `_active.json`, `.savestaterc.json`).
- CLI: migration scaffold under `packages/cli/src/lib/migrations/` for
  future schema version bumps. Unknown-newer payloads throw a clear
  "upgrade the CLI" error; orphan recovery surfaces the same hint.
- CLI: reject `%` (cmd.exe `%VAR%` env expansion) and `^` (cmd.exe
  escape char) alongside the existing shell metacharacter set.

### Changed
- Corrupt `state.json` / `index.json` / `_active.json` now quarantines
  to `.savestate/_corrupt/<ISO>-<name>/` instead of silently returning
  an empty index or crashing.
- VS Code extension: spawn dvs via `cross-spawn` so npm-installed
  `.cmd` shims work on Windows (Node's `execFile` can't launch them).
- VS Code extension: empty-state sidebar item is no longer a clickable
  landmine that fired `dvs.inspect` on a literal placeholder string.
- VS Code extension: command errors always refresh the tree so a
  failed save/load doesn't leave stale state in the sidebar.

## [0.1.0] - 2026-04-20
### Added
- Initial CLI (`dvs`) with save/load/list/delete/back/run/stop/status/archive/unarchive/inspect/diff/search/timeline/stats/share/open/hooks/recover/unlock commands.
- VS Code extension with sidebar, status bar, command palette integration.
- Atomic save via staging dir + rename; idempotent restore; pre-load checkpoint.
- Git hooks integration (post-checkout autosave).
- State sharing via export/import.

### Known limitations
- `dvs doctor` is referenced in ARCHITECTURE.md but not yet implemented.
- Secret scanner not yet implemented.
- No `packages/vscode/icon.png` yet — extension ships without icon.
