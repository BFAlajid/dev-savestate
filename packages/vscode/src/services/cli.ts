import * as vscode from "vscode";
import { execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { CONFIG } from "../constants";
import type { CliResult } from "../types";

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

  // 3. Fall back to global PATH
  return "dvs";
}

export function runCli(
  workspaceRoot: string,
  args: string[],
  timeout = 30000
): Promise<CliResult> {
  const binary = resolveCliBinary(workspaceRoot);

  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { cwd: workspaceRoot, timeout, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          // Try to parse JSON error from stdout first
          if (stdout) {
            try {
              const result = JSON.parse(stdout);
              resolve(result);
              return;
            } catch {
              // not JSON
            }
          }
          reject(
            new Error(
              stderr || error.message || `dvs ${args[0]} failed`
            )
          );
          return;
        }

        // Try JSON parse
        try {
          resolve(JSON.parse(stdout));
        } catch {
          // Non-JSON output — treat as success
          resolve({ success: true, output: stdout.trim() });
        }
      }
    );
  });
}

export function runCliRaw(
  workspaceRoot: string,
  args: string[],
  timeout = 30000
): Promise<string> {
  const binary = resolveCliBinary(workspaceRoot);

  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { cwd: workspaceRoot, timeout, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve(stdout);
      }
    );
  });
}
