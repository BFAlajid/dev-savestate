import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import type { ProjectConfig } from "./types.js";

interface ManagedProcess {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  port?: number;
  pid?: number;
  child?: ChildProcess;
}

// --- Security: process entry validator ---

export interface ProcessEntry {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  port?: number;
  source?: "dvs-run" | "config";
}

// Shell metacharacters that could enable command injection if we ever fell
// back to a shell. We reject them even though shell: false is the default,
// because the command string is still handled by OS loaders and because
// defense in depth matters if someone later flips shell back on.
// `%` and `^` are included for cmd.exe: %VAR% is env expansion and ^ is the
// escape char, so both are injection vectors on Windows shells.
const SHELL_METACHAR_RE = /[;&|$`\n\r<>%^]/;

export function assertSafeProcessEntry(
  entry: ProcessEntry,
  projectRoot: string
): void {
  if (!entry || typeof entry !== "object") {
    throw new Error("Invalid process entry: not an object");
  }
  if (typeof entry.command !== "string" || entry.command.length === 0) {
    throw new Error(
      `Invalid process entry '${entry.name}': command must be a non-empty string`
    );
  }
  if (SHELL_METACHAR_RE.test(entry.command)) {
    throw new Error(
      `Invalid process entry '${entry.name}': command contains shell metacharacters`
    );
  }
  if (entry.command.includes("\x00")) {
    throw new Error(
      `Invalid process entry '${entry.name}': command contains null byte`
    );
  }
  if (!Array.isArray(entry.args)) {
    throw new Error(
      `Invalid process entry '${entry.name}': args must be an array`
    );
  }
  for (const arg of entry.args) {
    if (typeof arg !== "string") {
      throw new Error(
        `Invalid process entry '${entry.name}': every arg must be a string`
      );
    }
    if (arg.includes("\x00")) {
      throw new Error(
        `Invalid process entry '${entry.name}': arg contains null byte`
      );
    }
  }
  if (typeof entry.cwd !== "string" || entry.cwd.length === 0) {
    throw new Error(
      `Invalid process entry '${entry.name}': cwd must be a non-empty string`
    );
  }
  if (entry.cwd.includes("\x00")) {
    throw new Error(
      `Invalid process entry '${entry.name}': cwd contains null byte`
    );
  }
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedCwd = path.resolve(entry.cwd);
  if (
    resolvedCwd !== resolvedRoot &&
    !resolvedCwd.startsWith(resolvedRoot + path.sep)
  ) {
    throw new Error(
      `Invalid process entry '${entry.name}': cwd '${resolvedCwd}' is outside project root`
    );
  }
}

const managed: Map<string, ManagedProcess> = new Map();

export function runProcess(
  name: string,
  command: string,
  args: string[],
  cwd: string,
  port?: number
): ManagedProcess {
  // shell: false — command must be a real executable, args are a real argv array.
  // Combined with assertSafeProcessEntry, this defeats shell injection.
  const child = spawn(command, args, {
    cwd,
    stdio: "inherit",
    shell: false,
    detached: false,
  });

  const proc: ManagedProcess = { name, command, args, cwd, port, pid: child.pid, child };
  managed.set(name, proc);
  child.on("exit", () => { managed.delete(name); });
  return proc;
}

export function stopAllProcesses(): number {
  let count = 0;
  for (const [, proc] of managed) {
    if (proc.child && !proc.child.killed) {
      proc.child.kill("SIGTERM");
      count++;
    }
  }
  managed.clear();
  return count;
}

export function getManagedProcesses(): ManagedProcess[] {
  return Array.from(managed.values());
}

export function getProcessesForSave(): Array<{
  name: string;
  command: string;
  args: string[];
  cwd: string;
  port?: number;
  source: "dvs-run" | "config";
}> {
  return Array.from(managed.values()).map((p) => ({
    name: p.name,
    command: p.command,
    args: p.args,
    cwd: p.cwd,
    port: p.port,
    source: "dvs-run" as const,
  }));
}

export async function readProjectConfig(projectRoot: string): Promise<ProjectConfig | null> {
  const configPath = path.join(projectRoot, ".savestaterc.json");
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function getConfigProcesses(
  config: ProjectConfig | null,
  projectRoot: string
): Array<{
  name: string;
  command: string;
  args: string[];
  cwd: string;
  port?: number;
  source: "dvs-run" | "config";
}> {
  if (!config?.processes?.commands) return [];
  const out: Array<{
    name: string;
    command: string;
    args: string[];
    cwd: string;
    port?: number;
    source: "dvs-run" | "config";
  }> = [];
  for (const cmd of config.processes.commands) {
    const entry = {
      name: cmd.name,
      command: cmd.command,
      args: [],
      cwd: cmd.cwd ? path.resolve(projectRoot, cmd.cwd) : projectRoot,
      port: cmd.port,
      source: "config" as const,
    };
    // Validate — rejects untrusted .savestaterc.json content before it ever
    // gets saved into a state and later replayed by restoreProcesses.
    assertSafeProcessEntry(entry, projectRoot);
    out.push(entry);
  }
  return out;
}

export async function restoreProcesses(
  processes: Array<{
    name: string;
    command: string;
    args: string[];
    cwd: string;
    port?: number;
    source: "dvs-run" | "config";
  }>,
  projectRoot: string
): Promise<{ started: string[]; skipped: string[] }> {
  const started: string[] = [];
  const skipped: string[] = [];

  for (const proc of processes) {
    if (proc.port) {
      const inUse = await isPortInUse(proc.port);
      if (inUse) {
        skipped.push(`${proc.name} (port ${proc.port} in use)`);
        continue;
      }
    }
    const cwd = path.isAbsolute(proc.cwd) ? proc.cwd : path.resolve(projectRoot, proc.cwd);
    try {
      // Validate every entry immediately before spawn. A state file on disk
      // is effectively untrusted (could be hand-edited, imported from a
      // shared package, or recovered from an orphan).
      assertSafeProcessEntry({ ...proc, cwd }, projectRoot);
      runProcess(proc.name, proc.command, proc.args, cwd, proc.port);
      started.push(proc.name);
    } catch (err: any) {
      skipped.push(`${proc.name} (${err?.message || "failed to start"})`);
    }
  }
  return { started, skipped };
}

async function isPortInUse(port: number): Promise<boolean> {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => { server.close(); resolve(false); });
    server.listen(port, "127.0.0.1");
  });
}
