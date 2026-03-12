import * as vscode from "vscode";
import { execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { CONFIG } from "../constants";
import type { CliResult } from "../types";

function resolveCliBinary(workspaceRoot: string): string {
  // 1. User-configured path
  const configured = vscode.workspace
    .getConfiguration()
    .get<string>(CONFIG.cliPath);
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
