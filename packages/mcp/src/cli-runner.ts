import spawn from "cross-spawn";
import path from "node:path";
import fs from "node:fs";

/**
 * Thin wrapper around the dvs CLI. Mirrors the resolution logic in
 * packages/vscode/src/services/cli.ts so installs behave the same way
 * from an MCP client as they do from VS Code.
 *
 * Resolution order:
 *   1. $DVS_CLI_PATH environment variable (explicit override)
 *   2. <workspaceRoot>/node_modules/.bin/dvs (monorepo / local install)
 *   3. "dvs" on PATH (global install)
 *
 * The workspace root is determined per-call by process.cwd(). MCP clients
 * launch the server as a child process and set CWD to the project they
 * want to operate on; this matches how the CLI itself finds a project
 * root via findProjectRoot(process.cwd()).
 *
 * Why cross-spawn: Node's child_process.execFile on Windows cannot launch
 * .cmd / .bat shims or extensionless shell scripts — it bypasses PATHEXT
 * and shebang handling. cross-spawn normalizes this so the same code
 * works on POSIX and Windows without opening the shell-injection hole
 * that `shell: true` would.
 */

export interface CliRunResult {
  /** Raw stdout of the CLI process, trimmed. */
  stdout: string;
  /** Raw stderr of the CLI process, trimmed. */
  stderr: string;
  /** Exit code. 0 means success. */
  code: number;
}

function resolveCliBinary(workspaceRoot: string): string {
  if (process.env.DVS_CLI_PATH && process.env.DVS_CLI_PATH.length > 0) {
    return process.env.DVS_CLI_PATH;
  }

  const localBin = path.join(workspaceRoot, "node_modules", ".bin", "dvs");
  if (fs.existsSync(localBin)) return localBin;

  // cross-spawn performs PATHEXT lookup on Windows when given a bare name.
  return "dvs";
}

const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB — diffs can be large

/**
 * Run `dvs <args>` and return stdout/stderr/exit code. Never throws on
 * non-zero exit — callers decide how to interpret failure (some CLI
 * commands emit structured JSON errors on stdout even when exit code is
 * non-zero, and we want to surface that text to the MCP client).
 *
 * Throws only on process-spawn-level failures (binary not found, timeout
 * killed the child, stdout exceeded MAX_BUFFER, etc.).
 */
export function runCli(args: string[], timeoutMs = 60_000): Promise<CliRunResult> {
  const workspaceRoot = process.cwd();
  const binary = resolveCliBinary(workspaceRoot);

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
            `dvs CLI not found. Set DVS_CLI_PATH or install dev-savestate (npm i -g dev-savestate). Tried: ${binary}`
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
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code: code ?? 1,
      });
    });
  });
}

/**
 * Parse CLI stdout as JSON. Returns the parsed value on success.
 * Throws a descriptive error if stdout is not valid JSON — includes a
 * snippet of the original stdout to aid debugging.
 */
export function parseJsonStdout(stdout: string): unknown {
  if (!stdout) {
    throw new Error("CLI returned empty output (expected JSON)");
  }
  try {
    return JSON.parse(stdout);
  } catch (err) {
    const snippet = stdout.slice(0, 500);
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`CLI did not return valid JSON: ${reason}\nstdout: ${snippet}`);
  }
}
