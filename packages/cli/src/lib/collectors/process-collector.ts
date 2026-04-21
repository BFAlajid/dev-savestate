// Process collector: managed long-running commands.
//
// Captures two sources of processes:
//   - `dvs run`–managed live processes (in-memory registry)
//   - Declarative entries in .savestaterc.json's `processes.commands`
//
// On restore, iterates the list and respawns each. Port-in-use entries are
// skipped with a human-readable reason; entries that fail the security
// validator (shell metachars, absolute path escapes root, etc.) are also
// skipped. This keeps the pre-refactor "best-effort restart, never crash"
// behavior intact.
//
// Secret scanning of process command/args is intentionally left OUT of
// this collector. save.ts scans the merged SaveState after capture so the
// scan runs once across every dimension (today: note + processes; later:
// notes in external collectors too). See save.ts for the scanner integration.

import {
  getProcessesForSave,
  readProjectConfig,
  getConfigProcesses,
  restoreProcesses,
} from "../process.js";
import type { SaveState } from "../types.js";
import type {
  CaptureContext,
  CaptureResult,
  Collector,
  RestoreContext,
} from "./types.js";

export const processCollector: Collector = {
  name: "processes",

  async capture(ctx: CaptureContext): Promise<CaptureResult> {
    const dvsRunProcs = getProcessesForSave();
    const config = await readProjectConfig(ctx.projectRoot);
    const configProcs = getConfigProcesses(config, ctx.projectRoot);
    const processes = [...dvsRunProcs, ...configProcs];
    return { slice: { processes } };
  },

  async restore(ctx: RestoreContext, state: SaveState): Promise<void> {
    if (!state.processes?.length) return;
    const { started, skipped } = await restoreProcesses(
      state.processes,
      ctx.projectRoot
    );
    if (started.length) console.log(`\nProcesses started: ${started.join(", ")}`);
    if (skipped.length) console.log(`Processes skipped: ${skipped.join(", ")}`);
  },
};
