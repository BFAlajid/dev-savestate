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

const managed: Map<string, ManagedProcess> = new Map();

export function runProcess(
  name: string,
  command: string,
  args: string[],
  cwd: string,
  port?: number
): ManagedProcess {
  const child = spawn(command, args, {
    cwd,
    stdio: "inherit",
    shell: true,
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
  return config.processes.commands.map((cmd) => ({
    name: cmd.name,
    command: cmd.command,
    args: [],
    cwd: cmd.cwd ? path.resolve(projectRoot, cmd.cwd) : projectRoot,
    port: cmd.port,
    source: "config" as const,
  }));
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
      runProcess(proc.name, proc.command, proc.args, cwd, proc.port);
      started.push(proc.name);
    } catch {
      skipped.push(`${proc.name} (failed to start)`);
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
