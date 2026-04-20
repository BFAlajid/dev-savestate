import * as vscode from "vscode";
import spawn from "cross-spawn";
import path from "node:path";
import fs from "node:fs";
import { CONFIG } from "../constants";
import type { CliResult } from "../types";

/**
 * Why cross-spawn: Node's child_process.execFile on Windows cannot launch
 * .cmd / .bat shims created by `npm install -g` — it bypasses PATHEXT and
 * shebang handling, so `dvs.cmd` fails to spawn. cross-spawn normalizes
 * this so the same code works on POSIX and Windows without opening the
 * shell-injection hole that `shell: true` would.
 */

/**
 * A hostile workspace's `.vscode/settings.json` could set
 * `devSavestate.cliPath` to a binary that ships with the repo, and then
 * every dvs command would execute attacker-controlled code. The primary
 * defense is the extension's `capabilities.untrustedWorkspaces: { supported: false }`
 * declaration, but we still refuse workspace-scoped values here as a
 * belt-and-suspenders check for the case where the user grants trust to
 * a malicious folder.
 */
function resolveConfiguredCliPath(
  output: vscode.OutputChannel | null
): string | undefined {
  const config = vscode.workspace.getConfiguration();
  const inspected = config.inspect<string>(CONFIG.cliPath);
  if (!inspected) return undefined;

  const workspaceValue =
    inspected.workspaceValue ?? inspected.workspaceFolderValue;
  if (workspaceValue !== undefined) {
    // Log and fall through to global/default. Do NOT use the workspace value.
    output?.appendLine(
      "devSavestate.cliPath from workspace settings ignored for security; configure in user settings if desired."
    );
  }

  return inspected.globalValue ?? inspected.defaultValue;
}

// Optional output channel for security warnings (set by extension entry).
let securityChannel: vscode.OutputChannel | null = null;
export function setCliSecurityOutputChannel(ch: vscode.OutputChannel): void {
  securityChannel = ch;
}

function resolveCliBinary(workspaceRoot: string): string {
  // 1. User-configured path (user/global scope only; workspace scope ignored)
  const configured = resolveConfiguredCliPath(securityChannel);
  if (configured) return configured;

  // 2. Local node_modules/.bin/dvs
  const localBin = path.join(workspaceRoot, "node_modules", ".bin", "dvs");
  if (fs.existsSync(localBin)) return localBin;

  // 3. Fall back to global PATH (cross-spawn performs PATHEXT lookup on Windows)
  return "dvs";
}

const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB — diffs can be large

interface RawResult {
  stdout: string;
  stderr: string;
  code: number;
}

function spawnDvs(
  binary: string,
  args: string[],
  workspaceRoot: string,
  timeoutMs: number
): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: workspaceRoot,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let overflowed = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore — process already exited
      }
      reject(new Error(`dvs ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(
          new Error(
            `dvs CLI not found. Set devSavestate.cliPath or install dev-savestate (npm i -g dev-savestate). Tried: ${binary}`
          )
        );
        return;
      }
      reject(err);
    });

    const append = (chunk: Buffer, sink: "stdout" | "stderr"): void => {
      if (overflowed) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_BUFFER) {
        overflowed = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`dvs ${args[0]} output exceeded ${MAX_BUFFER} bytes`));
        }
        return;
      }
      if (sink === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
    };

    child.stdout?.on("data", (chunk: Buffer) => append(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => append(chunk, "stderr"));

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

export function runCli(
  workspaceRoot: string,
  args: string[],
  timeout = 30000
): Promise<CliResult> {
  const binary = resolveCliBinary(workspaceRoot);

  return spawnDvs(binary, args, workspaceRoot, timeout).then(
    ({ stdout, stderr, code }) => {
      if (code !== 0) {
        // Try to parse JSON error from stdout first (CLI emits structured
        // JSON errors on some failure paths).
        if (stdout) {
          try {
            return JSON.parse(stdout) as CliResult;
          } catch {
            // not JSON — fall through
          }
        }
        throw new Error(stderr.trim() || `dvs ${args[0]} failed`);
      }

      try {
        return JSON.parse(stdout) as CliResult;
      } catch {
        // Non-JSON output — treat as success
        return { success: true, output: stdout.trim() };
      }
    }
  );
}

export function runCliRaw(
  workspaceRoot: string,
  args: string[],
  timeout = 30000
): Promise<string> {
  const binary = resolveCliBinary(workspaceRoot);

  return spawnDvs(binary, args, workspaceRoot, timeout).then(
    ({ stdout, stderr, code }) => {
      if (code !== 0) {
        throw new Error(stderr.trim() || `dvs ${args[0]} failed`);
      }
      return stdout;
    }
  );
}
