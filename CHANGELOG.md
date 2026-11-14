# Changelog
All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [1.0.0] - UNRELEASED

First stable release of the CLI (`dev-savestate`) and MCP server
(`dev-savestate-mcp`). The VS Code extension stays in the repo as
experimental and is not published.

### Changed
- Root `build`, `test` and `typecheck` scripts run across all workspaces.
- Release workflow no longer publishes the VS Code extension.
- README: removed the Marketplace listing claim; added maintenance posture.

### Added
- Secret scanner (`packages/cli/src/lib/scanner.ts`) covering AWS /
  Slack / GitHub / Google / Anthropic / OpenAI / Stripe tokens, PEM
  private keys, Authorization Bearer headers, and generic credential
  assignments. `dvs save` warns; `dvs share` blocks unless `--force`.
  `--strict-secrets` on save escalates warnings to exit 1.
- Untracked file blob capture — `dvs save` now snapshots brand-new
  (pre-`git add`) files via `git ls-files --others --exclude-standard`
  into `<stateDir>/untracked/`. `dvs load` restores them; conflicts
  refuse overwrite without `--force-untracked`. 10 MB cutoff with
  `--include-large` override; symlinks skipped.
- Collector plugin interface (`packages/cli/src/lib/collectors/`) —
  save/load are now thin orchestrators over Git / Editor / Process /
  Untracked collectors. External IDE / database / Docker collectors
  can plug in without touching save.ts or load.ts.
- VS Code extension: `@vscode/test-electron` + mocha smoke harness.
  Tests assert activation, command registration parity with
  package.json, and tree view contribution.
- `packages/vscode/icon.png` — 128x128 PNG. Regenerator at
  `scripts/gen-icon.mjs` (pure Node stdlib, no deps) for
  reproducibility.
- Tag-triggered release workflow (`.github/workflows/release.yml`).
  Matrix verify on ubuntu/macos/windows × Node 20/22, then publish
  CLI and MCP to npm with provenance, and extension to VS Code
  Marketplace. Gated on `NPM_TOKEN` and `VSCE_PAT` secrets.
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
- SaveState schema bumped to v2 (adds required `untracked` field).
  v1 payloads migrate transparently on read via the scaffold that
  shipped in `feat(storage): Zod validation + migration scaffold`.
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
