# dev-savestate — Architecture Plan

## Vision

Emulator save states for development environments. One command captures your full working context — git state, open files, cursor positions, running processes, and a context note. One command restores it all. Back in context in seconds instead of 30 minutes.

**Target users:** Developers who context-switch between tasks/branches, multi-client contractors, anyone who loses time to "where was I?"

**Core value proposition:** `dvs save auth-feature "Debugging token refresh race condition"` → walk away → `dvs load auth-feature` → you're exactly where you left off.

---

## The Problem

- Developers lose 20-30 minutes per context switch (Microsoft Research, 2023)
- Average developer context-switches 5-10 times per day — 2-3 hours lost daily
- VS Code workspaces save folder structure but not git state, cursor positions, terminal history, or mental context
- `git stash` saves uncommitted changes and nothing else
- No existing tool combines all context dimensions into a single atomic snapshot

---

## What a Save State Captures

| Dimension | What's captured | How |
|---|---|---|
| **Git state (tracked)** | Branch, HEAD hash, staged + unstaged changes to tracked files | `git diff --binary HEAD` + `git diff --binary --cached` |
| **Git state (untracked)** | Untracked file contents, stored as blobs | Copied to `.savestate/states/<name>/blobs/` with metadata |
| **Editor state** | Open files, cursor line/column per file, active file, tab order, pinned tabs, split layout | VS Code Extension API (extension mode only) |
| **Terminal state** | Working directory per terminal, terminal name, replay commands (from config/`dvs run`) | Best-effort — see Terminal State Contract below |
| **Processes** | Dev servers, watchers — recorded via `dvs run` or `.savestaterc.json` config | Explicit registration only — no runtime inference |
| **Context note** | Free-text developer note — the most valuable field | CLI argument or prompt |
| **Metadata** | Timestamp, name, project root, time spent in context | Automatic |

### Untracked File Handling

Untracked files are stored as blobs because they have no upstream storage — `git diff` cannot restore what git has never seen.

**Storage:**

```
.savestate/states/<name>/blobs/
├── manifest.json         # [{relativePath, hash, size, mode}]
├── src/new-module.ts     # actual file contents
└── scripts/setup.sh
```

**Rules:**
- Only untracked files inside the project root are captured
- Files matching `.gitignore` patterns are excluded by default
- Files matching `.savestaterc.json` `security.excludeFromPatch` patterns are excluded
- Large untracked files (> 10MB) trigger a warning with opt-in (`--include-large`)
- Binary untracked files are supported (stored as-is, not diffed)

**On restore:** Blobs are copied back to their original relative paths. If a file already exists at that path, the user is warned and offered: overwrite / skip / diff.

### Binary Diff Support

All git patches are generated with `--binary` to correctly handle tracked binary file modifications (images, SQLite files, compiled assets, etc.):

```bash
git diff --binary HEAD > git-patch.diff        # unstaged changes
git diff --binary --cached >> git-patch.diff   # staged changes
```

Patches are applied with whitespace/CRLF normalization to prevent cross-platform fragility:

```bash
git apply --binary --whitespace=nowarn git-patch.diff
```

### Terminal State Contract

Terminal capture is **best-effort** and explicitly scoped:

| Source | What's Captured | Reliability |
|---|---|---|
| `dvs run` wrapper | Exact command + cwd | Reliable (recorded at spawn) |
| `.savestaterc.json` config | Configured commands + cwd | Reliable (user-defined) |
| VS Code shell integration | Terminal name + cwd | Moderate (API-dependent) |
| Shell history files | Not captured per-terminal | Not used (global, noisy, not terminal-specific) |

**Schema representation:**

```typescript
terminal: {
  name: string;
  cwd: string;                           // relative to project root
  replay?: {
    kind: "dvs-run" | "config";
    commands: string[];
  };
}
```

**What is NOT promised:** Raw command history replay from the terminal. The VS Code Terminal API does not expose command history. Shell history files (`~/.bash_history`) are global and cannot be attributed to a specific terminal session.

## What It Does NOT Capture

- Full file contents of tracked files (git handles this via patches)
- `node_modules` or build artifacts
- Browser state or dev tools
- Database data
- Environment variables or secrets (security risk)
- Global shell history (not terminal-specific, too noisy)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│           CLI (commander) / VS Code Extension    │
│                    dvs save | load | list         │
└────────────────────────┬────────────────────────┘
                         │
┌────────────────────────▼────────────────────────┐
│               State Manager                      │
│  - Coordinates capture/restore across collectors │
│  - Handles dirty-tree conflicts                  │
│  - Manages .savestate/ storage                   │
└────┬──────┬──────┬──────┬──────┬────────────────┘
     │      │      │      │      │
┌────▼─┐ ┌──▼──┐ ┌─▼──┐ ┌▼───┐ ┌▼─────┐
│ Git  │ │Edit │ │Term│ │Proc│ │ Note │
│Captor│ │Captor│ │Cap │ │Cap │ │Captor│
└──────┘ └─────┘ └────┘ └────┘ └──────┘
```

---

## System Guarantees

The system must provide the following hard guarantees. These are non-negotiable invariants.

### Atomic Save Operation

A save state must either complete fully or fail without partial writes.

**Implementation:**
- All state files are written to a temporary directory first (`.savestate/_tmp/<uuid>/`)
- On success, the temporary directory is renamed atomically to its final location
- On failure, the temporary directory is deleted automatically
- Uses `write-file-atomic` (npm-maintained, battle-tested) for individual file writes — writes to `filename.{murmurhash}` then `fs.rename()`
- `fs.rename()` is guaranteed atomic on POSIX (Linux/macOS). On Windows NTFS, `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING` provides effective atomicity for small files

**Failure mode:** If the CLI crashes mid-save, only temp files exist. On next invocation, stale temp directories are cleaned up (see Crash Resilience below).

### Non-Destructive Load

The system must never overwrite user code silently.

**Rules:**
- If the working tree is dirty, the system warns and offers: stash current changes / abort / force
- The system never runs `git reset --hard`, `git clean -f`, or any destructive git command
- Editor state restoration closes current editors only after confirmation (VS Code extension) or with `--force` flag (CLI)
- Before any load, a **pre-load checkpoint** is created (see `dvs back` below) so the user can undo the restore

**Patch conflict strategy:**

Plain `git apply` does not produce merge-style conflict markers — it either succeeds or fails. The system uses a two-tier fallback:

1. **Try clean apply:** `git apply --binary --check <patch>` (dry run). If it passes, apply for real.
2. **Try three-way merge:** If clean apply fails, attempt `git apply --binary --3way <patch>`. This uses git's merge machinery and produces real conflict markers (`<<<<<<< / ======= / >>>>>>>`) where possible.
3. **Fallback to reject files:** If three-way is not possible (e.g., base commit is missing), use `git apply --binary --reject <patch>`. This creates `.rej` files alongside the conflicting files.
4. **Surface clearly:** Print a summary of what applied, what conflicted, and run `dvs repair` to list reject files with suggested next steps.

The guarantee: **the user always knows what happened and can always undo** via `dvs back`.

### Idempotent Restore

Running the same restore command multiple times must not corrupt the repository state.

**How:**
- `git checkout <branch>` is idempotent — checking out the current branch is a no-op
- **Patch idempotency check:** Before applying, the system performs a multi-step verification:
  1. Compute a SHA-256 hash of the patch file contents and store it in `state.json` as `git.patchHash`
  2. Before applying, run `git apply --binary --check <patch>` (dry run)
  3. If the dry run fails, run `git apply --binary --reverse --check <patch>` to detect "already applied"
  4. If reverse-check succeeds → patch is already applied → skip with message "Patch already applied, skipping"
  5. If both fail → genuine conflict → fall through to three-way / reject strategy above
- Editor state restoration is declarative ("these files should be open at these positions"), not imperative
- Process restarts check if the port is already in use before spawning

### Crash Resilience

If the CLI crashes during save, the partial state must be discarded automatically.

**Implementation:**
- Write to `.savestate/_tmp/` first, then atomic rename
- The `index.json` registry is only updated after the state directory is successfully renamed
- Uses a two-phase commit: (1) write state files, (2) update index

**Stale temp directory cleanup (robust rules):**

Temp directories are NOT cleaned up based on a simple age threshold (5 minutes is unsafe for large diffs, slow disks, WSL, antivirus scanning, or network home directories). Instead, cleanup requires ALL of:

1. No active file lock exists (`.savestate/lock/` absent or stale)
2. The temp directory contains an `in-progress` marker but no `complete` marker
3. If PID metadata is present in the marker, confirm the PID is dead (`process.kill(pid, 0)` throws)
4. The temp directory is older than **24 hours**

If conditions 1-3 are met but the directory is younger than 24 hours, it is left alone and flagged for `dvs doctor` review.

### Index Consistency — Orphan Recovery

**Critical rule:** If `states/<name>/` exists on disk but is not in `index.json`, it is treated as **recoverable, not orphaned**.

The system prefers false positives (keeping extra directories) over false negatives (deleting valid states). This matters because a crash between the atomic directory rename and the `index.json` update would create exactly this scenario.

**Recovery procedure:**
1. Scan `states/` for directories not in `index.json`
2. For each, check if `state.json` exists and parses correctly
3. If valid → add to `index.json` with status `created` and a warning: "Recovered state: <name>"
4. If invalid (missing `state.json`, corrupt JSON, missing patch file) → flag for `dvs doctor` review, do NOT auto-delete
5. Auto-recovery runs on every `dvs list` and `dvs doctor`

**Only `dvs doctor --gc` with explicit user confirmation will delete truly orphaned/corrupt directories.**

### Git Safety

The tool must never modify git history. Permitted git operations:

| Allowed | Not Allowed |
|---|---|
| `git checkout <branch>` | `git reset --hard` |
| `git apply <patch>` | `git rebase` |
| `git stash create` / `git stash store` | `git commit --amend` |
| `git diff` / `git status` | `git push --force` |
| `git stash pop` (user-initiated) | `git clean -f` |

The tool creates stashes via `git stash create` (which does not modify the reflog) and applies patches via `git apply` (which modifies the working tree only, never the commit history).

---

## State Lifecycle

Each save state follows a simplified lifecycle. Persisted status is limited to stable, user-controlled fields to avoid edge cases with multi-machine usage, crashes leaving wrong status, and index corruption from frequent writes.

### Persisted Fields (in `state.json`)

```typescript
{
  archived: boolean;           // user-controlled, default false
  deletedAt?: string;          // ISO 8601, set on soft delete (optional)
  lastLoadedAt?: string;       // ISO 8601, updated on each load
  loadCount: number;           // incremented on each load
  totalTimeInContext: number;  // seconds across all sessions
}
```

### Derived States (not persisted)

| Derived State | How It's Determined | Visible in `dvs list` |
|---|---|---|
| **Active** | `_active.json` heartbeat references this state name | Yes (highlighted) |
| **Recent** | `lastLoadedAt` within last 24 hours | Yes (sorted first) |
| **Stale** | `lastLoadedAt` older than 30 days, never archived | Yes (dimmed) |

**Why not persist "active" / "updated" as status fields?**
- Multi-machine: Two machines could mark different states "active" — conflicts on sync
- Crashes: A crash leaves the wrong status persisted with no cleanup path
- Index churn: Frequent status writes increase corruption risk

Instead, "active" is derived from the `_active.json` heartbeat (single source of truth for the running session), and "updated" is implicit from `updatedAt > createdAt`.

### Transitions

| Action | Effect |
|---|---|
| `dvs save <name>` | Creates state (or overwrites existing), sets `archived: false` |
| `dvs load <name>` | Updates `lastLoadedAt`, increments `loadCount`, writes `_active.json` |
| `dvs archive <name>` | Sets `archived: true` — hidden from default `dvs list` |
| `dvs unarchive <name>` | Sets `archived: false` |
| `dvs delete <name>` | Removes state directory and index entry (requires `--force` if not archived) |

### Benefits

- **State cleanup:** Archived states are hidden from default list, reducing noise
- **History tracking:** `history` array records all save/load events with timestamps
- **Team handoffs:** Archived states can be exported before deletion
- **Crash safety:** No status field can be left in an inconsistent state by a crash

---

## Storage Model

All savestates are stored under the project root in `.savestate/`.

### Directory Layout

```
.savestate/
├── config.json                    # project-level settings
├── index.json                     # state registry (fast lookups)
├── lock/                          # concurrency lock (directory-based)
├── _active.json                   # heartbeat for crash recovery
├── _tmp/                          # temporary writes (atomic save staging)
├── _autosaves/                    # auto-snapshots from branch switches
│   └── <branch-name>/
├── states/
│   ├── auth-feature/
│   │   ├── state.json             # full snapshot metadata
│   │   ├── note.md                # context note (human-readable)
│   │   └── git-patch.diff         # uncommitted changes as unified diff
│   ├── payment-flow/
│   │   └── ...
│   └── _quicksaves/               # rotating auto-save slots
│       ├── 2026-03-06T1430/
│       └── 2026-03-06T0900/
├── exports/                       # staging area for .savestate packages
└── .gitignore                     # auto-generated, ignores .savestate/
```

### index.json — State Registry

`index.json` acts as a registry for all states, enabling fast listing without scanning directories.

```json
{
  "version": 1,
  "states": [
    {
      "name": "auth-feature",
      "createdAt": "2026-03-06T14:30:00Z",
      "updatedAt": "2026-03-06T16:45:00Z",
      "branch": "auth-feature",
      "notePreview": "debugging token refresh race condition",
      "status": "active",
      "tags": ["bug", "urgent"],
      "issueId": "AUTH-142",
      "totalTimeInContext": 9660
    }
  ]
}
```

**Benefits:**
- Fast `dvs list` without scanning directories (< 100ms target)
- Quick metadata lookup for search and filtering
- Single source of truth for state existence and status
- Future-ready for indexing and full-text search

**Consistency rule:** `index.json` is always updated last, after all state files are written. If a state directory exists but is not in the index, it is treated as orphaned and cleaned up.

### state.json Schema

```typescript
interface SaveState {
  version: 1;
  name: string;
  createdAt: string;              // ISO 8601
  updatedAt: string;
  projectRoot: string;

  note: string;

  git: {
    branch: string;
    commitHash: string;           // HEAD at save time
    hasUncommittedChanges: boolean;
    patchFile: string;            // relative path to git-patch.diff
  };

  editor: {
    openFiles: Array<{
      relativePath: string;
      cursorLine: number;
      cursorColumn: number;
      isPinned: boolean;
      viewColumn: number;         // editor group (split pane)
    }>;
    activeFile: string;
  };

  terminals: Array<{
    name: string;
    cwd: string;                  // relative to project root
    recentCommands: string[];     // last 50, best-effort
  }>;

  processes: Array<{
    command: string;              // shell command to restart
    cwd: string;
    port?: number;
  }>;

  timeTracking: {
    totalTimeInContext: number;   // seconds across all sessions
    lastSessionDuration: number;
  };
}
```

---

## CLI Commands

```bash
# Save with name and note
dvs save auth-feature "Debugging token refresh race condition. Check auth.ts line 47."

# Quick save (auto-named with timestamp, prompts for note)
dvs save

# List all save states
dvs list

# Load a save state (restores everything)
dvs load auth-feature

# Inspect without loading
dvs inspect auth-feature

# Delete
dvs delete auth-feature

# Diff two save states
dvs diff auth-feature payment-flow

# Export for team handoff
dvs export auth-feature > auth-feature.savestate

# Import
dvs import < auth-feature.savestate
```

---

## Core Flows

### Save Flow

1. Acquire file lock (`.savestate/lock/`)
2. Detect project root (walk up to `.git/`)
3. Create staging directory (`.savestate/_tmp/<uuid>/`)
4. **Capture in parallel** (`Promise.all`):
   - Git state: branch, HEAD hash
   - If uncommitted changes: `git diff --binary HEAD` + `git diff --binary --cached` → `git-patch.diff`
   - Untracked files: copy to `blobs/` with manifest
   - **VS Code extension mode:** Query Extension API for open editors, cursors, terminals
   - **CLI-only mode:** Skip editor state capture (no reading VS Code internal storage — too brittle)
   - Collect managed processes (`dvs run` registry + `.savestaterc.json` config)
5. Accept context note from CLI arg or interactive prompt
6. Accept next step from interactive prompt (if configured)
7. Run secret scanner on note and process commands (warn if detected)
8. Write `state.json`, `note.md`, `git-patch.diff`, `blobs/` to staging directory
9. Atomic rename: staging directory → `states/<name>/`
10. Update `index.json` (last step — crash before here leaves no index entry)
11. Release file lock
12. Print summary

### Load Flow

1. Acquire file lock
2. Read and validate `state.json`
3. **Create pre-load checkpoint** (for `dvs back`):
   - Record current branch and HEAD
   - Capture current dirty tree as patch (with `--binary`)
   - Record current open editors (extension mode)
   - Record currently running `dvs run` processes
   - Store as `.savestate/_checkpoint.json`
4. **Dirty tree check:** If working tree is dirty → warn, offer: stash current changes / abort / force
5. Checkout saved branch (warn if branch deleted or has new commits)
6. **Apply patch with idempotency check:**
   - `git apply --binary --check` (dry run)
   - If fails: `git apply --binary --reverse --check` (already applied?)
   - If not applied: `git apply --binary` (clean) or `git apply --binary --3way` (conflict fallback)
7. Restore untracked files from `blobs/` (warn on existing files, offer: overwrite / skip / diff)
8. **VS Code extension:** Close all editors → open saved files at saved cursor positions → restore splits
9. **CLI-only:** Print file list as `code -g <file>:<line>:<col>` commands (editor hint plan)
10. Restart saved processes via `dvs run` (skip if port already in use)
11. Display mental stack restore panel (note + next step + files + processes)
12. Update `lastLoadedAt`, increment `loadCount`, write `_active.json` heartbeat
13. Release file lock
14. Start time tracking

### `dvs back` — Undo Last Load

If a restore goes wrong or the user loaded the wrong state, `dvs back` restores the pre-load checkpoint.

```bash
dvs back
```

**What it does:**
1. Read `.savestate/_checkpoint.json`
2. Checkout the original branch
3. Apply the original dirty-tree patch
4. Restore original editor state (extension mode)
5. Kill processes started by the load, restart pre-load processes
6. Delete checkpoint file

**Rules:**
- Only one level of undo (the most recent load)
- If no checkpoint exists, print: "No previous state to restore. Run `dvs load` first."
- `dvs back` itself does NOT create a checkpoint (no infinite undo chain)

### `dvs doctor` — Integrity Checker

```bash
dvs doctor
```

**What it checks:**

| Check | Action |
|---|---|
| Stale temp directories in `_tmp/` | Report, offer cleanup |
| State directories not in `index.json` | Recover valid ones, flag invalid |
| Index entries with missing directories | Remove from index |
| Stale lock directory | Report PID status, offer removal |
| Corrupt `state.json` files | Report, offer deletion |
| Missing patch files referenced in state | Report, mark state as degraded |
| Orphaned blob directories | Report size, offer cleanup |
| Stale `_active.json` heartbeat | Clear if PID is dead |
| `_checkpoint.json` from a crashed load | Report, offer recovery |

**Output:**

```
dvs doctor

  ✓ index.json consistent (12 states)
  ✓ No stale locks
  ✓ No orphaned temp directories
  ⚠ State 'old-experiment' not in index — recovered
  ⚠ Stale checkpoint from 2h ago — run `dvs back` or `dvs doctor --clear-checkpoint`
  ✗ State 'corrupt-state' has invalid state.json

  Run `dvs doctor --fix` to apply suggested repairs.
  Run `dvs doctor --gc` to garbage-collect orphaned data (requires confirmation).
```

### `dvs repair` — Patch Conflict Helper

When a patch fails to apply cleanly and `.rej` files are created:

```bash
dvs repair
```

**Output:**

```
Patch conflicts detected in auth-feature:

  src/auth.ts.rej     — 2 hunks rejected
  src/token.ts.rej    — 1 hunk rejected

Suggested actions:
  1. Review .rej files and apply changes manually
  2. Run `dvs repair --accept` to delete .rej files (marks conflicts as resolved)
  3. Run `dvs back` to undo the load entirely
```

---

## VS Code Extension

### Commands (Command Palette)

- `Dev Savestate: Save` → `Ctrl+Shift+S S`
- `Dev Savestate: Load` → `Ctrl+Shift+S L` (quick pick list)
- `Dev Savestate: Quick Save` → `Ctrl+Shift+S Q`
- `Dev Savestate: List` → opens sidebar panel

### Status Bar

```
[dvs: auth-feature] 47m
```

Shows loaded state name and session duration. Click to open list.

### Sidebar Panel

- Tree view of save states grouped by recency
- Each entry: name, branch, note preview, timestamp
- Right-click: load, inspect, delete, export

### Auto-Save (Optional)

When enabled: auto-save every N minutes with rotating quick-save slots (max 5). Only active when a named state is loaded. Never overwrites named saves.

---

## Edge Cases

| Scenario | Behavior |
|---|---|
| Dirty working tree on load | Warn → offer stash / abort / force. Pre-load checkpoint created first. |
| Saved branch deleted | Warn → stay on current branch, apply patch if compatible |
| Branch has new commits since save | Warn → load anyway, patch applies on top of current HEAD |
| Patch conflict (clean apply fails) | Try `--3way` for conflict markers. If unavailable, `--reject` for `.rej` files. Run `dvs repair` for guidance. |
| Patch already applied | Detect via `--reverse --check` → skip with message, no corruption |
| Binary file in patch | Handled by `--binary` flag on both `git diff` and `git apply` |
| CRLF/whitespace mismatch | `git apply --whitespace=nowarn` prevents cross-platform failures |
| Untracked file exists at blob restore path | Warn → offer overwrite / skip / diff |
| Saved file no longer exists | Skip file, warn, open remaining files |
| Export/import to different machine | Relative paths resolve against new project root |
| Port already in use on load | Skip that process restart, warn |
| No git repository | Error → suggest `git init` |
| Large uncommitted diff (>10MB) | Warn about size → save anyway, suggest committing |
| Large untracked files (>10MB each) | Warn → require `--include-large` to save |
| Multiple VS Code windows | Extension operates on active workspace only |
| Monorepo | Project root = git root, paths relative to git root |
| Wrong state loaded | Run `dvs back` to restore pre-load checkpoint |
| Crash during save | Temp dir orphaned → cleaned up by `dvs doctor` (24h threshold + PID check) |
| Crash during load | Pre-load checkpoint exists → `dvs doctor` detects and offers recovery |
| Index/directory mismatch | `dvs doctor` reconciles: recovers valid orphans, removes stale entries |
| Process command contains secrets | Secret scanner warns at save time, blocks at export time unless `--force` |
| Note contains secrets | Secret scanner warns at save time, redacted in debug logs |

---

## Process Capture Strategy

### The Problem with Runtime Inference

Port scanning can detect what PID is on a port, but it **cannot reliably reconstruct the command that started a process**:

- Watchers and compilers don't use ports
- Command lines are often truncated or unavailable (especially on Windows)
- Commands can contain inline secrets (`DATABASE_URL=... pnpm dev`)
- Cross-platform detection differs significantly (`lsof` vs `netstat` vs `Get-Process`)

**Therefore: process capture uses explicit registration only, not heuristic inference.**

### Tier 1: `dvs run` — Execution Wrapper (Most Reliable)

```bash
dvs run dev-server -- pnpm dev
dvs run storybook -- pnpm storybook --port 6006
```

`dvs run` spawns the process and records the exact command, cwd, environment redaction policy, and port:

```typescript
interface ManagedProcess {
  name: string;               // user-provided label
  command: string;             // exact command
  args: string[];              // exact arguments
  cwd: string;                // relative to project root
  port?: number;               // auto-detected or specified
  source: "dvs-run";
  pid?: number;                // runtime only, not persisted
}
```

**On save:** Processes started via `dvs run` are automatically recorded — no config needed.
**On load:** Processes are restarted with `dvs run` so they continue to be managed.
**On `dvs stop`:** All managed processes are killed cleanly.

### Tier 2: Config-Driven (Reliable, Manual)

```json
// .savestaterc.json
{
  "processes": {
    "commands": [
      { "name": "dev server", "command": "pnpm dev", "cwd": "." },
      { "name": "storybook", "command": "pnpm storybook", "cwd": "." }
    ]
  }
}
```

Config-defined processes are always saved and restored. The developer defines exactly what to run. No guessing.

### Tier 3: Port Scanning (Best-Effort Discovery Only)

Scan common dev ports (3000, 4200, 5173, 8000, 8080) → detect if something is running. Used only for:

- `dvs status` display: "port 3000 is active"
- Conflict detection on load: "port 3000 already in use, skipping process restart"

**Port scanning never attempts to reconstruct or save the original command.** It is a diagnostic tool, not a capture mechanism.

### Process Command Sanitization

Even with explicit registration, commands can contain secrets:

```bash
# Dangerous: secret inline
dvs run api -- DATABASE_URL=postgres://secret@host/db pnpm dev

# Safe: secret in .env (not captured)
dvs run api -- pnpm dev
```

**Rules:**
- Commands from `dvs run` are stored as-is (user explicitly typed them)
- Before saving, a regex-based scanner checks for common secret patterns (`*_KEY=`, `*_SECRET=`, `*_TOKEN=`, `Bearer `, `postgres://`, `mongodb://`)
- If detected, warn: "Process command may contain secrets. Store anyway? [y/N]"
- Commands from config are trusted (user wrote them deliberately in a committed file)
- In `dvs share` / `dvs export`, process commands undergo a stricter scan and require `--force` if secrets are detected

---

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | Node.js 20+ |
| CLI framework | Commander.js |
| Git operations | simple-git |
| VS Code Extension | VS Code Extension API |
| Storage | JSON files in `.savestate/` |
| Config | `.savestaterc.json` |
| Binary name | `dvs` (short for dev-savestate) |
| Testing | Vitest |
| Bundling | tsup (CLI), esbuild (extension) |
| Publishing | npm (`npx dev-savestate`) + VS Code Marketplace |
| Atomic writes | `write-file-atomic` |
| File locking | `proper-lockfile` |
| Process detection | `find-process` |
| Search indexing | Flat JSON (start) → FlexSearch (scale) |

---

## Concurrency Model

The CLI must prevent concurrent operations that could corrupt state.

### File Lock

Before any save or load operation, the system acquires a directory-based lock.

```
.savestate/lock/           ← mkdir-based lock (atomic on all platforms including NFS)
├── pid                    ← PID of lock holder
└── mtime updated every 5s ← liveness signal
```

**Implementation:** Uses `proper-lockfile` which creates a lock directory via `fs.mkdir()` (atomic on all platforms). Stores PID metadata inside for identification. Periodically updates `mtime` to signal liveness.

**If a lock exists:**

```
$ dvs save auth-feature
Error: Another dvs operation is currently running (PID 12345).
       If this is stale, run: dvs unlock
```

**Lock parameters:**

| Parameter | Value | Rationale |
|---|---|---|
| Stale timeout | 30 seconds | Save operations should never take this long |
| Update interval | 15 seconds | `stale / 2` for reliable detection |
| Retries | 3 with exponential backoff | Handle brief contention |

**`dvs unlock` command:** Force-removes a stale lock. Checks if the PID is still alive first — if the process is running, refuses to unlock without `--force`.

---

## Platform Compatibility

The tool must support Linux, macOS, and Windows.

### Platform Abstractions

| Concern | Linux/macOS | Windows |
|---|---|---|
| Process detection | `lsof -i :<port>`, `ps aux` | `netstat -ano`, `Get-Process` |
| File locking | `fs.mkdir()` (POSIX atomic) | `fs.mkdir()` (NTFS atomic) |
| Atomic rename | `fs.rename()` (POSIX guaranteed) | `MoveFileEx` (effective for small files) |
| Shell history | `~/.bash_history`, `~/.zsh_history` | `(Get-PSReadLineOption).HistorySavePath` |
| Open URL | `xdg-open` / `open` | `start` |
| Path separator | `/` | `\` (normalize with `path.resolve()`) |

**Implementation:** Use `find-process` npm package for cross-platform process detection. Use `process.platform` checks wrapped in a `Platform` utility module. All paths stored as forward-slash relative paths and resolved at runtime.

### Shell Compatibility

| Shell | Supported | History Capture | Hook Support |
|---|---|---|---|
| bash | Full | `~/.bash_history` or `$HISTFILE` | Full |
| zsh | Full | `~/.zsh_history` or `$HISTFILE` | Full |
| fish | Full | `~/.local/share/fish/fish_history` | Full |
| PowerShell | Full | `PSReadLine` history path | Via profile scripts |
| cmd.exe | Basic | No history capture | No hook support |

**Degradation:** Terminal features degrade gracefully. If history cannot be captured, the field is empty. If hooks cannot be installed, a warning is printed with manual instructions.

---

## Extensibility Model — Collector Plugin Architecture

Collectors must follow a defined plugin interface. This allows future collectors without modifying core logic.

### Collector Interface

```typescript
interface Collector<TState = unknown> {
  name: string;
  version: string;

  /** Capture current state for this dimension */
  capture(context: CollectorContext): Promise<TState>;

  /** Restore a previously captured state */
  restore(state: TState, context: CollectorContext): Promise<void>;

  /** Validate that a captured state can be restored in the current environment */
  validate(state: TState, context: CollectorContext): Promise<ValidationResult>;

  /** Optional cleanup on unload */
  cleanup?(): Promise<void>;
}

interface CollectorContext {
  projectRoot: string;
  platform: "linux" | "darwin" | "win32";
  isVSCodeExtension: boolean;
  config: ProjectConfig;
}

interface ValidationResult {
  valid: boolean;
  warnings: string[];    // Non-fatal issues (e.g., "file no longer exists")
  errors: string[];      // Fatal issues (e.g., "branch deleted")
}
```

### Built-in Collectors

| Collector | Captures | Restores |
|---|---|---|
| `GitCollector` | Branch, HEAD, staged/unstaged diff, untracked files | Checkout branch, apply patch |
| `EditorCollector` | Open files, cursor positions, splits, pinned tabs | Open files at positions |
| `TerminalCollector` | Working directory, recent commands | Print recent commands |
| `ProcessCollector` | Running dev servers (config-driven + port scan) | Restart processes |
| `NoteCollector` | Context note, next step | Display on load |

### Future Collectors (No Core Changes Required)

| Collector | What It Would Capture |
|---|---|
| `DebuggerCollector` | Breakpoints, watch expressions, call stack context |
| `DatabaseStateCollector` | Migration version, seed data state |
| `BrowserCollector` | Open tabs, DevTools state (via browser extension) |
| `DockerCollector` | Running containers, volume state |

### Registration

Collectors register with the State Manager at startup. The State Manager calls `capture()` on all registered collectors during save and `restore()` during load. Collectors run in parallel where independent (`Promise.all` for capture, sequential for restore with rollback).

---

## Failure Handling — Staged Execution Model

All restore operations follow a staged execution model with rollback.

### Stages

```
Stage 1: Validate    →  Stage 2: Prepare    →  Stage 3: Apply    →  Stage 4: Verify
   ↓ fail                  ↓ fail                 ↓ fail               ↓ fail
   abort                   rollback               rollback             warn
   (no changes)            (undo stash)           (undo checkout,      (state loaded
                                                   reapply backup)      but incomplete)
```

### Stage Details

**Stage 1 — Validate Environment**
- Check git repository exists
- Check saved branch exists (warn if deleted)
- Check working tree cleanliness
- Validate all collector states via `collector.validate()`
- **On failure:** Abort with descriptive error. No changes made.

**Stage 2 — Prepare Environment**
- Back up current state to `.savestate/_backup/`
- Stash current changes if working tree is dirty (with user confirmation)
- **On failure:** Delete backup, restore stash. Print recovery instructions.

**Stage 3 — Apply State**
- Checkout saved branch
- Apply git patch via `git apply`
- Restore editor state (collector)
- Restart saved processes (collector)
- **On failure:** Compensate in reverse order — kill restarted processes, close opened files, checkout original branch, pop stash, delete backup. Print what was rolled back.

**Stage 4 — Verify**
- Confirm patch applied cleanly
- Confirm files opened successfully
- Confirm processes running
- **On failure:** Print warnings but do not rollback (state is mostly loaded). List any issues for manual resolution.

### Implementation Pattern

```typescript
interface Stage<TContext> {
  name: string;
  execute(ctx: TContext): Promise<void>;
  compensate(ctx: TContext): Promise<void>;
}

async function executePipeline<TContext>(
  stages: Stage<TContext>[],
  ctx: TContext
): Promise<void> {
  const completed: Stage<TContext>[] = [];
  try {
    for (const stage of stages) {
      await stage.execute(ctx);
      completed.push(stage);
    }
  } catch (error) {
    for (const stage of completed.reverse()) {
      try {
        await stage.compensate(ctx);
      } catch (compensateError) {
        console.error(`Rollback warning: ${stage.name} compensation failed`);
      }
    }
    throw error;
  }
}
```

---

## Observability

### Debug Mode

```bash
dvs save auth-feature --debug
```

Debug output includes:
- Git commands executed and their output
- Files captured with sizes
- Process detection results
- Collector execution times
- Lock acquisition/release events

### Log File

When `--debug` is active, output is also written to `.savestate/debug.log` (rotated, max 1MB).

### Structured Output

```bash
dvs list --json          # Machine-readable JSON output
dvs inspect auth --json  # Pipe to jq for scripting
```

### Telemetry

- **Always opt-in.** Never enabled by default.
- If enabled, collects only: command name, execution time, error type (no content, no file names, no notes)
- Configuration: `dvs config set telemetry true`
- Future versions may include performance analysis hooks

---

## Performance Targets

| Operation | Target | Constraint |
|---|---|---|
| `dvs save` | **< 1 second** | Typical repo (< 10K files, < 1MB diff) |
| `dvs load` | **< 3 seconds** | Including branch checkout and process restart |
| `dvs list` | **< 100 milliseconds** | Read from `index.json`, no directory scan |
| `dvs search` | **< 200 milliseconds** | For < 100 states (flat JSON), < 500ms with FlexSearch |
| `dvs timeline` | **< 200 milliseconds** | Computed from index + history arrays |
| Auto-save hook | **< 1 second** | Must never block `git checkout` |
| CLI startup | **< 150 milliseconds** | Lazy-load non-essential modules |

### Performance Strategy

- **Avoid scanning full repository.** Rely on `git diff` for change detection, `index.json` for state metadata.
- **Cache state metadata.** `index.json` is the read-optimized cache. Full `state.json` is read only when needed.
- **Run collectors in parallel.** `Promise.all([gitCollector.capture(), editorCollector.capture(), ...])` during save.
- **Lazy-load modules.** Commander.js subcommands load their dependencies only when invoked.
- **Git performance.** Recommend `core.untrackedCache` and `core.fsmonitor` for large repos (~10x speedup for untracked file detection).

---

## Security Model

The system must avoid capturing or exposing sensitive information.

### Never Capture

| Category | Examples |
|---|---|
| Environment variables | `DATABASE_URL`, `API_KEY`, `AWS_SECRET_ACCESS_KEY` |
| Secret files | `.env`, `.env.local`, `credentials.json`, `*.pem`, `*.key` |
| Authentication tokens | OAuth tokens, JWT secrets, session cookies |
| SSH keys | `~/.ssh/id_rsa`, `~/.ssh/id_ed25519` |

### Patch File Safety

- Patch files contain only source code diffs (output of `git diff`)
- `.gitignore`'d files are excluded from patches by default
- Additional exclusion patterns configurable in `.savestaterc.json`:

```json
{
  "security": {
    "excludeFromPatch": [".env*", "*.pem", "*.key", "secrets/"],
    "warnOnSensitiveFiles": true
  }
}
```

### Note & Command Secret Scanning

Developers paste tokens into notes. Process commands can contain inline secrets. The system scans for both.

**Scan triggers:**

| Trigger | Scan Level | Action on Detection |
|---|---|---|
| `dvs save` | Lightweight (regex) | Warn: "Note/command may contain secrets — continue? [y/N]" |
| `dvs share` / `dvs export` | Strict (regex + pattern library) | Block unless `--force` |
| `--debug` log output | Always redacted | Notes and commands replaced with `[REDACTED]` in debug logs |

**Regex patterns scanned:**

```
*_KEY=, *_SECRET=, *_TOKEN=, *_PASSWORD=
Bearer <token>, Basic <token>
postgres://, mongodb://, mysql://, redis://
ghp_, gho_, sk-live_, sk-test_, AKIA
-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----
```

### Export Safety

- `dvs share` runs the strict secret scanner across: notes, next step, process commands, patch diffs
- If detected, prints what was found and requires `--force` to proceed
- Exported `.savestate` packages contain: state metadata, notes, diffs, and untracked blobs — but never environment variables, secret files, or `.gitignore`'d content

### Data Locality

- All data stored in `.savestate/` under the project root
- No server component. No cloud sync. No phone-home.
- Analytics (`dvs stats`) are computed locally and never transmitted
- AI features (when enabled) default to local models (Ollama). Cloud providers require explicit opt-in and API key configuration.
- Debug logs (`--debug`) redact notes and process commands by default

### Audit Trail

- All state operations (save, load, delete, export, import, back, doctor) are logged in `.savestate/audit.log`
- Log entries include: timestamp, operation, state name, user (from git config)
- Audit log is never exported with `.savestate` packages
- Notes and commands are NOT written to the audit log (privacy)

---

## Search and Indexing

### Phase 1 — Flat JSON (M4)

For repositories with < 100 savestates, search uses `Array.filter()` on `index.json`:

```typescript
const results = index.states.filter(s =>
  s.notePreview.includes(query) ||
  s.name.includes(query) ||
  s.tags?.some(t => t.includes(query))
);
```

**Performance:** < 1ms for 100 entries. Zero dependencies.

### Phase 2 — FlexSearch (Future)

For power users with 100+ savestates, upgrade to FlexSearch:

- Zero-dependency JavaScript search library
- Supports fuzzy matching, stemming, phonetic matching
- Index serializes to disk for persistence
- < 10ms search across 10,000 entries

```typescript
import FlexSearch from "flexsearch";

const index = new FlexSearch.Index({ tokenize: "forward" });
states.forEach(s => index.add(s.id, `${s.name} ${s.note} ${s.tags.join(" ")}`));
const results = index.search(query);
```

### Phase 3 — SQLite (Future, Optional)

For advanced query needs (date ranges, complex filters, relational queries):

- `better-sqlite3` — synchronous API, 2000+ qps, FTS5 full-text search
- Tradeoff: requires native addon (prebuilt binaries for most platforms)
- Only introduced if flat JSON + FlexSearch prove insufficient

---

## Team Workflow Support

### Individual → Team Adoption Path

```
Phase 1: Individual developer uses dvs daily
Phase 2: Developer shares a .savestate with a colleague
Phase 3: Team adopts shared conventions (naming, tags)
Phase 4: Team integrates with issue tracker (dvs save AUTH-142)
Phase 5: Organization standardizes on dvs for context handoffs
```

### Export/Import Workflow

```bash
# Senior developer captures debugging context
dvs save auth-bug "Found the race condition, need to add mutex"
dvs share auth-bug
# → auth-bug.savestate (portable package)

# Junior developer receives the package
dvs import auth-bug.savestate
dvs load auth-bug
# → Exact same branch, files, cursor positions, note, next step
```

### Team Conventions (Optional)

```json
// .savestaterc.json (committed to repo)
{
  "team": {
    "namingPattern": "{issueId}-{description}",
    "requiredTags": true,
    "issueTrackerProvider": "linear",
    "sharedExportsDir": "./handoffs/"
  }
}
```

---

## Future Evolution

| Phase | Focus | Features |
|---|---|---|
| **Phase 1** | CLI savestates | Core save/load, git + notes, next step prompt |
| **Phase 2** | IDE integration | VS Code extension, editor state, sidebar |
| **Phase 3** | Workflow automation | Auto-save hooks, crash recovery, process management |
| **Phase 4** | Developer memory | Timeline, search, analytics, tags |
| **Phase 5** | Team collaboration | Share/import, issue tracker linking, team conventions |
| **Phase 6** | AI-assisted context | AI summaries, smart suggestions, pattern detection |
| **Phase 7** | Multi-IDE support | JetBrains, Zed, Neovim collectors (plugin architecture) |

---

## Market Validation & Demand Signals

### The Problem Is Real and Measured

| Metric | Data | Source |
|---|---|---|
| Time to regain focus after interruption | **23 minutes 15 seconds** | Gloria Mark, UC Irvine |
| Time to start editing code after resuming | **10-15 minutes** | Georgia Institute of Technology |
| Attention residue after task switch | **30-60 minutes** | Leroy & Schmidt, UMN |
| Interruptions per developer per day | **47** | UC Irvine workday study |
| Productive hours out of 8 | **2.3** | UC Irvine workday study |
| Developers struggling with context switching | **~50%** | Livecycle Collaboration Study |
| Annual cost per developer from context switching | **~$50,000** | DEV Community / TeamCamp analysis |
| Hours lost weekly to workflow disruptions | **10+ hours for 50% of devs** | Atlassian DevEx Report 2025 |
| Time actually spent coding | **16% of workday (4.5 hrs/week)** | Vanson Bourne / Garden.io (400 devs) |

### Competitive Landscape (Expanded)

| Tool | Git | Editor | Terminal | Processes | Notes | Adoption |
|---|---|---|---|---|---|---|
| `git stash` | Partial | No | No | No | No | Built-in (universal) |
| `git worktree` | Partial | No | No | No | No | Surging (AI agent era) |
| DevContext (VS Code) | Branch only | Yes | Partial | No | No | New / low installs |
| ContextKeeper (Visual Studio) | Branch only | Tabs only | No | No | No | Open Beta, VS only |
| tmux-resurrect | No | Vim only | Yes | Yes | No | 12,505 GitHub stars |
| tmux-continuum | No | No | Yes | No | No | 3,837 GitHub stars |
| VS Code Project Manager | No | No | No | No | No | Millions of installs |
| Eclipse Mylyn | No | Task-focused UI | No | No | Yes | Discontinued |
| **dev-savestate** | **Full** | **Full** | **Full** | **Full** | **Full** | **Pre-launch** |

### Market Size

- Software development tools market: **$6.41B (2025)** → **$15.72B by 2031** at **16.12% CAGR**
- Global developer population: **~47 million** (SlashData 2025)
- 1,093 early-stage devtool VC investments in 2024 (Sequoia, Accel, Lightspeed, a16z active)
- 80% of developer tools offer a free tier
- Developers juggle an average of **14 tools**; 62% of executives prioritize tool consolidation

### Strongest Unique Value Propositions

1. **Async context handoff** — No competitor. Export full debugging context for another dev to pick up.
2. **Auto-save on branch switch** — No competitor. Git hook captures state atomically.
3. **Crash recovery beyond files** — VS Code restores files but not mental context, branch intent, or processes.
4. **Issue-tracker-aware savestates** — No tool ties full context snapshots to tickets.
5. **Personal-first analytics** — Unlike LinearB/Jellyfish (management-focused), `dvs stats` is private and developer-owned.

---

## Extended Features

### Task-Aware Savestates

Tie savestates to issue trackers. Developers mentally think in tickets, not savestate names.

**Usage:**

```bash
# Save tied to a ticket
dvs save AUTH-142 "race condition in refresh flow"

# Load by ticket ID
dvs load AUTH-142
# → Restores full context AND opens issue in browser
```

**State metadata stores:**

```typescript
interface TaskLink {
  issueId: string;            // "AUTH-142"
  issueURL?: string;          // "https://linear.app/team/AUTH-142"
  provider?: "github" | "linear" | "jira" | "auto";
}
```

**Schema addition to `SaveState`:**

```typescript
interface SaveState {
  // ... existing fields ...
  task?: TaskLink;
}
```

**Auto-detection strategy:**

1. Parse savestate name for issue key patterns: `PROJ-\d+`, `#\d+`, `GH-\d+`
2. If matched, resolve URL via configured provider (GitHub CLI `gh`, Linear CLI, or Jira API)
3. On `dvs load`, open `issueURL` in default browser (opt-in via config)
4. On `dvs save`, optionally update ticket status (e.g., "In Progress")

**Research backing:** GitHub CLI (`gh`), Linear CLI, and Git Integration for Jira are among the most-used developer tools. The convention of embedding issue keys in branch names (e.g., `AUTH-142-fix-refresh`) is nearly universal. dev-savestate formalizes this into a full context link.

**Configuration:**

```json
// .savestaterc.json
{
  "issueTrackers": {
    "provider": "linear",
    "projectPrefix": "AUTH",
    "openOnLoad": true,
    "updateStatusOnSave": false
  }
}
```

---

### Auto-Snapshot on Branch Switch

Git hook integration. When a developer runs `git checkout other-branch`, a hook automatically saves the current context.

**Implementation:**

```bash
# .git/hooks/post-checkout
#!/bin/sh
# Args: $1=prev HEAD, $2=new HEAD, $3=branch flag (1=branch, 0=file)
if [ "$3" = "1" ]; then
  dvs autosave --from-hook --prev-ref "$1" --quiet
fi
```

**Behavior:**

- Only triggers on branch checkouts (`$3 = 1`), not file checkouts
- Saves to `.savestate/_autosaves/<branch-name>/` with rotating slots (max 3 per branch)
- Must complete in **< 1 second** — no blocking, no prompts
- Silent by default (`--quiet`), logs to `.savestate/autosave.log`
- Opt-in: installed via `dvs hooks install`, removed via `dvs hooks uninstall`

**Research backing:** Husky (34.4K stars, 18.1M weekly npm downloads) and Lefthook (6.9K stars) prove developers accept hooks when they are fast and non-intrusive. The `post-checkout` hook is the natural trigger. Key principle: **never block or slow down `git checkout`**.

**CLI commands:**

```bash
dvs hooks install     # Adds post-checkout hook
dvs hooks uninstall   # Removes hook
dvs hooks status      # Shows installed hooks
```

**Edge cases:**

| Scenario | Behavior |
|---|---|
| Hook already exists | Append dvs logic, don't overwrite |
| `--no-verify` used | Hook does not run (git behavior) |
| Large repo (slow diff) | Skip diff capture, save metadata only |
| No named state loaded | Save as `_autosave/<branch>` |

---

### Context Timeline

Every save becomes a timeline entry. Visualize work context shifts throughout the day.

**Usage:**

```bash
dvs timeline
dvs timeline --today
dvs timeline --week
```

**Output:**

```
Today — Monday, March 9

 10:14  ● auth-feature         42m   "Debugging token refresh race condition"
 10:56  ● payment-refactor     33m   "Refactoring Stripe webhook handler"
 11:29  ● auth-feature         36m   "Added mutex lock, running tests"
 12:05  ○ lunch break
 13:10  ● hotfix-token         18m   "Emergency fix for prod token expiry"
 13:28  ● auth-feature         1h 2m "Tests passing, cleaning up"

Total active: 3h 51m across 5 sessions
Context switches: 4
```

**Data source:** Derived from `createdAt`, `updatedAt`, and `timeTracking` fields already in `state.json`. No new storage required — timeline is computed from existing save/load events.

**Schema addition:**

```typescript
interface SaveState {
  // ... existing fields ...
  history: Array<{
    action: "save" | "load" | "autosave";
    timestamp: string;         // ISO 8601
    sessionDuration?: number;  // seconds
  }>;
}
```

---

### Quick Jump Command

Open files directly from a savestate without loading the full state.

**Usage:**

```bash
dvs open auth-feature
```

**Output:**

```
auth-feature — 3 files saved

  auth.ts:47        (active file)
  token.ts:12
  middleware.ts:89

Opening in VS Code...
```

**Behavior:**

- Lists saved files with cursor positions
- Opens them in VS Code via `code -g <file>:<line>:<col>`
- Does NOT switch branches, restore terminals, or restart processes
- Useful for quickly referencing code from a previous context

---

### Context Search

Search across all savestate notes. Developers often forget what they named states.

**Usage:**

```bash
dvs search "race condition"
```

**Output:**

```
3 matches found

  auth-feature       Mar 9, 10:14   "Debugging token refresh race condition"
  payment-retry      Mar 7, 14:22   "Race condition in webhook dedup"
  webhook-fix        Mar 5, 09:41   "Fixed race condition in event queue"
```

**Implementation:** Full-text search across `note.md` files and `state.json` note fields. Uses simple substring matching (no external dependencies). Future: fuzzy search via `fuse.js`.

**Flags:**

```bash
dvs search "race condition" --tag bug     # Filter by tag
dvs search "race condition" --branch auth # Filter by branch
dvs search "race condition" --after 7d    # Last 7 days
```

---

### State Tags

Allow tagging savestates for organization and filtering.

**Usage:**

```bash
dvs save auth-feature --tag bug --tag urgent
dvs save perf-test --tag experiment
dvs list --tag bug
dvs list --tag experiment
```

**Schema addition:**

```typescript
interface SaveState {
  // ... existing fields ...
  tags: string[];
}
```

**Built-in tag suggestions:** `bug`, `feature`, `experiment`, `wip`, `review`, `handoff`

---

### Lightweight Memory Assistant (Next Step Prompt)

Add an optional "next step" prompt when saving. Restores mental flow instantly on load.

**Save flow:**

```bash
dvs save auth-feature "Debugging token refresh race condition"

# Interactive prompt (optional, configurable)
┌ What is the next step when you return?
│ Check mutex lock in refreshToken()
└
```

**Load flow:**

```bash
dvs load auth-feature

┌─────────────────────────────────────────────┐
│  STATE: auth-feature                        │
│  Branch: auth-feature                       │
│  Files: auth.ts  token.ts  middleware.ts    │
│                                             │
│  NOTE                                       │
│  Debugging refresh token race condition.    │
│                                             │
│  NEXT STEP                                  │
│  Check mutex lock in refreshToken()         │
└─────────────────────────────────────────────┘
```

**Schema addition:**

```typescript
interface SaveState {
  // ... existing fields ...
  nextStep?: string;
}
```

**Configuration:**

```json
// .savestaterc.json
{
  "promptNextStep": true    // default: true
}
```

**Research backing:** The #1 advice on HN for context switching is "write down where you are before switching." This automates that exact behavior. Carnegie Mellon research confirms that externalizing intent before interruption significantly reduces recovery time.

---

### Smart Diff of Savestates

Compare two savestates to see what mental context changed.

**Usage:**

```bash
dvs diff auth-feature payment-flow
```

**Output:**

```
┌─────────────────────────────────────────────────────────┐
│  DIFF: auth-feature ↔ payment-flow                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Branch:   auth-feature → payment-flow                  │
│                                                         │
│  Files changed:                                         │
│    - auth.ts:47                                         │
│    - token.ts:12                                        │
│    + stripe.ts:23                                       │
│    + webhook.ts:88                                      │
│                                                         │
│  Processes:                                             │
│    = pnpm dev (both)                                    │
│    - pnpm test:watch (auth-feature only)                │
│    + pnpm stripe:listen (payment-flow only)             │
│                                                         │
│  Notes:                                                 │
│    - "Debugging token refresh race condition"           │
│    + "Refactoring Stripe webhook handler"               │
│                                                         │
│  Time spent:                                            │
│    auth-feature: 2h 41m                                 │
│    payment-flow: 1h 12m                                 │
└─────────────────────────────────────────────────────────┘
```

---

### Crash Recovery

Detect when VS Code or terminal crashes and recover the last active context.

**Usage:**

```bash
dvs recover
```

**Output:**

```
Crash detected — VS Code exited unexpectedly at 14:32

Last active state: auth-feature (auto-saved at 14:28)

Restore? [Y/n]
```

**Implementation:**

1. When a state is loaded, write a heartbeat file: `.savestate/_active.json`
2. Heartbeat updates every 60 seconds with timestamp
3. On `dvs recover`, check if `_active.json` exists with stale timestamp (> 5 min old)
4. If stale → previous session did not exit cleanly → offer restore

**Heartbeat schema:**

```typescript
interface ActiveHeartbeat {
  stateName: string;
  lastHeartbeat: string;     // ISO 8601
  pid: number;               // VS Code or terminal PID
  cleanExit: boolean;        // set to true on normal dvs unload/save
}
```

**Research backing:** VS Code issue #139967 ("Restore last opened workspaces after crash") remains open. VS Code restores files but not full developer context (branch intent, mental notes, running processes). Extensions like Roo Code have filed issues about losing session state on crashes. This is a validated gap.

---

### Remote Sharing (Debugging Packages)

Turn a savestate into a portable debugging package for team handoffs.

**Usage:**

```bash
# Export
dvs share auth-feature
# → Creates auth-feature.savestate (compressed archive)

# Import
dvs import auth-feature.savestate
# → Restores full context on another machine
```

**Package contents:**

```
auth-feature.savestate (tar.gz)
├── state.json
├── note.md
├── git-patch.diff
└── manifest.json          # version, source machine, compatibility info
```

**What is NOT included (security):**
- No environment variables or secrets
- No absolute paths (all relative to project root)
- No process credentials
- Patch diffs only (not full file contents)

**Use cases:**
- **Debugging handoff:** Senior dev exports 3 hours of debugging context → junior dev imports and continues
- **Onboarding:** Lead creates a savestate at the exact point a new hire should start exploring
- **Pair programming:** Async pair programming across time zones
- **Bug reports:** Attach a `.savestate` to a bug ticket for exact reproduction context

**Research backing:** All existing collaboration tools (VS Code Live Share, CodeTogether, Code With Me) are **synchronous** — real-time only. No tool addresses **asynchronous context handoff**. This is a genuinely unserved gap.

---

### Work Duration Analytics

Track how long you spend in each context. Personal, private, developer-owned.

**Usage:**

```bash
dvs stats
dvs stats --week
dvs stats --month
```

**Output:**

```
This week — Mar 3 to Mar 9

  auth-feature      ████████████████░░░░  2h 41m  (34%)
  payment-flow      █████████░░░░░░░░░░░  1h 12m  (15%)
  hotfix-token      ███░░░░░░░░░░░░░░░░░  0h 37m  ( 8%)
  onboarding-docs   ██████░░░░░░░░░░░░░░  0h 52m  (11%)
  other             ████████░░░░░░░░░░░░  1h 14m  (16%)
  (not tracked)     ████░░░░░░░░░░░░░░░░  1h 18m  (17%)

  Total tracked: 6h 36m
  Context switches: 23
  Avg session: 17m
  Longest focus: 1h 02m (auth-feature, Thu 13:28)
```

**Privacy principle:** All data stays in `.savestate/`. Never transmitted. No server component. No manager dashboard. This is **for the developer** — unlike LinearB ($420-549/contributor/year) or Jellyfish which report to management.

**Research backing:** WakaTime (millions of VS Code installs) proves developers want time insights. But WakaTime tracks per-file, not per-task. dev-savestate tracks per-context — "how long did I spend debugging the race condition?" not just "how long was auth.ts open?" The task-level granularity is unique.

---

### AI-Generated Context Summary (Optional)

When saving, optionally analyze modified files to generate a context summary.

**Usage:**

```bash
dvs save auth-feature --ai-note
```

**Auto-generated note:**

```
Modified 3 files in auth module. Changes suggest token refresh retry
logic with mutex lock. Added 2 test cases for concurrent refresh
scenarios. auth.ts:47-62 (retry logic), auth.test.ts:120-145 (tests).
```

**Implementation:**

- Reads `git diff` output
- Sends to local LLM (Ollama) or cloud API (configurable)
- Generates 2-3 sentence summary focused on developer intent, not code description
- Appended to manual note, never replaces it
- **Fully opt-in** — disabled by default, requires explicit `--ai-note` flag or config

**Configuration:**

```json
// .savestaterc.json
{
  "ai": {
    "enabled": false,
    "provider": "ollama",       // "ollama" | "openai" | "anthropic"
    "model": "llama3.2",
    "autoNote": false           // true = generate on every save
  }
}
```

**Privacy:** Local-first by default (Ollama). Cloud providers are opt-in and require explicit API key configuration. Diffs are never stored remotely by dev-savestate.

---

### Mental Stack Restore (Load Display)

When loading a state, display a structured context restoration panel.

**On every `dvs load`:**

```
┌─────────────────────────────────────────────────┐
│                                                 │
│  ● STATE: auth-feature                          │
│                                                 │
│  Branch     auth-feature                        │
│  Saved      2h 14m ago (Mar 9, 10:14)          │
│  Time spent 2h 41m across 3 sessions            │
│  Ticket     AUTH-142                             │
│  Tags       bug, urgent                         │
│                                                 │
│  FILES                                          │
│    auth.ts:47          (active)                  │
│    token.ts:12                                   │
│    middleware.ts:89                               │
│                                                 │
│  PROCESSES                                      │
│    ✓ pnpm dev          → localhost:3000          │
│    ✓ pnpm test:watch   → running                │
│                                                 │
│  NOTE                                           │
│  Debugging refresh token race condition.        │
│  Added mutex lock, need to verify under load.   │
│                                                 │
│  NEXT STEP                                      │
│  Check mutex lock in refreshToken()             │
│                                                 │
└─────────────────────────────────────────────────┘
```

This is the core UX moment — the developer sees their full mental context restored in one glance. No hunting through files, no reading git log, no trying to remember what they were doing.

---

## Updated Schema (v3)

```typescript
interface SaveState {
  version: 3;
  name: string;
  createdAt: string;
  updatedAt: string;
  projectRoot: string;

  // --- Context ---
  note: string;
  nextStep?: string;
  tags: string[];
  aiNote?: string;

  // --- Issue tracker ---
  task?: {
    issueId: string;
    issueURL?: string;
    provider?: "github" | "linear" | "jira" | "auto";
  };

  // --- Lifecycle (simplified — "active" is derived from _active.json) ---
  archived: boolean;
  lastLoadedAt?: string;
  loadCount: number;

  // --- Git state ---
  git: {
    branch: string;
    commitHash: string;
    hasUncommittedChanges: boolean;
    patchFile: string;             // relative path to git-patch.diff
    patchHash: string;             // SHA-256 of patch contents (for idempotency)
    hasUntrackedFiles: boolean;
    blobsDir?: string;             // relative path to blobs/ directory
  };

  // --- Editor state (extension mode only) ---
  editor?: {
    openFiles: Array<{
      relativePath: string;
      cursorLine: number;
      cursorColumn: number;
      isPinned: boolean;
      viewColumn: number;
    }>;
    activeFile: string;
  };

  // --- Terminal state ---
  terminals: Array<{
    name: string;
    cwd: string;                   // relative to project root
    replay?: {
      kind: "dvs-run" | "config";
      commands: string[];
    };
  }>;

  // --- Processes (explicit registration only) ---
  processes: Array<{
    name: string;
    command: string;
    args: string[];
    cwd: string;
    port?: number;
    source: "dvs-run" | "config";
  }>;

  // --- Time tracking ---
  timeTracking: {
    totalTimeInContext: number;   // seconds across all sessions
    lastSessionDuration: number;
  };

  // --- History ---
  history: Array<{
    action: "save" | "load" | "autosave";
    timestamp: string;
    sessionDuration?: number;
  }>;
}

// Pre-load checkpoint (for dvs back)
interface PreLoadCheckpoint {
  branch: string;
  commitHash: string;
  dirtyTreePatch?: string;        // patch of working tree at load time
  dirtyTreePatchHash?: string;
  untrackedBlobs?: string;        // path to checkpoint blobs
  editor?: SaveState["editor"];
  processes: SaveState["processes"];
  createdAt: string;
}

// Untracked file manifest (stored in blobs/manifest.json)
interface BlobManifest {
  files: Array<{
    relativePath: string;
    hash: string;                  // SHA-256 of file contents
    size: number;                  // bytes
    mode: string;                  // file permissions (e.g., "100644")
  }>;
}
```

---

## Updated CLI Commands

```bash
# Core (M1)
dvs save <name> "<note>"        # Save with name and note
dvs save                         # Quick save (timestamp, prompts)
dvs load <name>                  # Restore everything + mental stack display
dvs back                         # Undo last load (restore pre-load checkpoint)
dvs list                         # List all save states
dvs list --archived              # Include archived states
dvs delete <name>                # Remove a state (requires --force if not archived)
dvs inspect <name>               # View without loading

# Process management
dvs run <label> -- <command>     # Run a process under dvs management
dvs stop                         # Stop all dvs-managed processes
dvs status                       # Show managed processes and port status

# Extended
dvs diff <state1> <state2>       # Smart diff of two states
dvs export <name>                # Export for handoff (stdout)
dvs import <file>                # Import shared state
dvs share <name>                 # Create .savestate package (with secret scan)

# Search & discovery
dvs search "<query>"             # Full-text search across notes
dvs timeline                     # Show context timeline
dvs timeline --today             # Today's timeline
dvs open <name>                  # Quick jump — open files without full load
dvs stats                        # Work duration analytics
dvs stats --week                 # Weekly breakdown

# Maintenance
dvs doctor                       # Check .savestate/ integrity
dvs doctor --fix                 # Apply suggested repairs
dvs doctor --gc                  # Garbage-collect orphaned data (interactive)
dvs repair                       # List .rej files from failed patch, suggest actions
dvs recover                      # Crash recovery (restore last active state)
dvs archive <name>               # Hide from default list
dvs unarchive <name>             # Unhide
dvs unlock                       # Force-remove stale lock (checks PID first)

# Git hooks
dvs hooks install                # Install post-checkout auto-save hook
dvs hooks uninstall              # Remove hook
dvs hooks status                 # Show installed hooks

# Flags (combinable with commands above)
--tag <tag>                      # Add tag to save, filter on list/search
--ai-note                        # Generate AI context summary on save
--issue <id>                     # Link to issue tracker ticket
--include-large                  # Include untracked files > 10MB
--debug                          # Verbose diagnostic output
--json                           # Machine-readable JSON output
--force                          # Skip confirmations (use with care)
```

---

## Updated Milestone Plan

### M0: Project Scaffolding (1 day)
- [ ] Initialize monorepo: `packages/cli` + `packages/vscode`
- [ ] TypeScript, tsup, Vitest setup
- [ ] CLI skeleton with Commander.js
- [ ] CI pipeline (lint, test, build)
- [ ] `write-file-atomic`, `proper-lockfile`, `find-process`, `simple-git` dependencies

### M1: CLI MVP — Git + Note + Safety (3-4 days)
- [ ] `dvs save <name> "<note>"` — captures git branch, HEAD, binary-capable diff, untracked blobs, note
- [ ] `dvs load <name>` — restores branch, applies patch (with idempotency check + 3way fallback), displays mental stack panel
- [ ] `dvs back` — undo last load (pre-load checkpoint)
- [ ] `dvs list` — table of saved states from `index.json`
- [ ] `dvs delete <name>`
- [ ] `.savestate/` directory management with auto `.gitignore`
- [ ] Atomic save (staging dir + rename + index update)
- [ ] File locking (`proper-lockfile`)
- [ ] Dirty tree conflict handling (stash/abort/force)
- [ ] Next step prompt on save
- [ ] Mental stack restore display on load
- [ ] Secret scanner for notes and commands (regex heuristics)
- [ ] `dvs doctor` — integrity checker with index reconciliation
- [ ] `dvs repair` — patch conflict helper
- [ ] Tests against a temp git repo (cover: clean save/load, dirty tree, idempotent load, crash recovery, orphan recovery)

### M2: VS Code Extension — Editor State (3-4 days)
- [ ] Capture open files, cursor positions, active file, split layout
- [ ] Restore: close all → reopen at exact positions with correct splits
- [ ] Command palette: Save, Load (quick pick), Quick Save
- [ ] Status bar indicator with loaded state name + timer
- [ ] Extension bundles CLI as dependency
- [ ] CLI-only mode: output `code -g file:line:col` commands (no reading VS Code internal storage)

### M3: Process Management + Hooks (2-3 days)
- [ ] `dvs run <label> -- <command>` — execution wrapper with command recording
- [ ] `dvs stop` — kill all managed processes
- [ ] `dvs status` — show managed processes and port status
- [ ] `.savestaterc.json` config for declared process commands
- [ ] Port scanning as diagnostic only (conflict detection, not command reconstruction)
- [ ] Process command secret scanner (warn on inline secrets)
- [ ] Restart managed processes on load (skip if port in use)
- [ ] `dvs hooks install/uninstall/status` — post-checkout auto-save
- [ ] Auto-save on branch switch (< 1 second, silent, metadata-only for large repos)

### M4: Search, Timeline, Analytics (2-3 days)
- [ ] `dvs search` — full-text search across notes (flat JSON)
- [ ] `dvs timeline` — context timeline visualization
- [ ] `dvs stats` — work duration analytics
- [ ] `dvs open` — quick jump to files without full load
- [ ] State tags (`--tag`)
- [ ] `dvs archive` / `dvs unarchive`
- [ ] History tracking per state
- [ ] `--json` structured output for scripting

### M5: Team Features + Sharing (2-3 days)
- [ ] `dvs share` / `dvs import` — portable .savestate packages (with secret scan + `--force`)
- [ ] `dvs diff` — smart comparison of two states
- [ ] `dvs inspect` — show state details without loading
- [ ] Task-aware savestates (issue tracker linking)
- [ ] Open issue in browser on load (opt-in)

### M6: Crash Recovery + AI (2-3 days)
- [ ] Heartbeat file (`_active.json`) for active state tracking
- [ ] `dvs recover` — detect crash, offer restore
- [ ] Stale checkpoint detection in `dvs doctor`
- [ ] AI-generated context summaries (opt-in, local-first via Ollama)
- [ ] `.savestaterc.json` AI provider configuration

### M7: VS Code Sidebar + Auto-Save (2-3 days)
- [ ] Sidebar tree view with all states, tags, timeline
- [ ] Right-click context menu (load, inspect, delete, export, share)
- [ ] Auto-save with configurable interval and rotating slots
- [ ] Quick save keybinding
- [ ] Crash recovery integration with extension lifecycle

### M8: Polish + Publish (2-3 days)
- [ ] README with GIF demos
- [ ] npm publish as `dev-savestate` (binary: `dvs`)
- [ ] VS Code Marketplace publish
- [ ] GitHub Actions for automated releases
- [ ] Landing page with demo video
- [ ] `dvs doctor` smoke test in CI

---

## Priority Order for Daily Stickiness

Based on research, these features create the strongest daily habit loop:

1. **Auto-save on branch switch** — Zero-effort. Works silently. Developers never lose context again.
2. **Next step prompt + mental stack restore** — The "aha moment" on every load. Instant habit formation.
3. **Context search** — Solves the "what did I name that?" problem. Used multiple times daily.
4. **Context timeline** — Visual feedback on work patterns. Checked once or twice daily.
5. **Share/import** — Team virality driver. One dev shares → colleague sees value → adoption spreads.

These five features should be prioritized across M1-M5 to maximize early retention.

---

## UX Design Principles

Based on developer tool adoption research:

| Principle | Implementation |
|---|---|
| **Time-to-value < 60 seconds** | `npm i -g dev-savestate && dvs save my-task "working on it"` — immediate value |
| **Zero config required** | Auto-detects git repo, VS Code, running processes. Config is opt-in. |
| **Progressive disclosure** | `dvs save/load` works immediately. Tags, AI notes, hooks are discovered over time. |
| **Every error suggests a fix** | "Branch `auth-feature` not found. Run `dvs list` to see available states." |
| **Non-intrusive hooks** | Post-checkout hook completes in < 1 second. Never blocks. |
| **Privacy by default** | All data in `.savestate/`. No server. No telemetry. No manager dashboard. |
| **Works with existing workflow** | Complements git, doesn't replace it. No new mental model required. |

---

## Naming

- Package: `dev-savestate`
- Binary: `dvs` (short, easy to type)
- VS Code Extension: `Dev Savestate`
- Storage directory: `.savestate/`
- File extension for exports: `.savestate`
