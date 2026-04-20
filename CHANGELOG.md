# Changelog
All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

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
