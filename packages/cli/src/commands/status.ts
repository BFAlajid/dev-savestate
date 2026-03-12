import { Command } from "commander";
import { getManagedProcesses } from "../lib/process.js";

export const statusCommand = new Command("status")
  .description("Show dvs-managed processes")
  .action(async () => {
    const procs = getManagedProcesses();
    if (procs.length === 0) {
      console.log("No managed processes running.");
      return;
    }
    console.log("Managed processes:");
    for (const proc of procs) {
      const port = proc.port ? ` → port ${proc.port}` : "";
      console.log(`  ${proc.name}: ${proc.command} ${proc.args.join(" ")} (PID: ${proc.pid})${port}`);
    }
  });
