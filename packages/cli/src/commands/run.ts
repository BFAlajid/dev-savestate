import { Command } from "commander";
import { runProcess } from "../lib/process.js";

export const runCommand = new Command("run")
  .description("Run a process under dvs management")
  .argument("<label>", "Label for the process")
  .argument("<command...>", "Command to run (use -- before command)")
  .option("-p, --port <port>", "Port the process uses", parseInt)
  .action(async (label: string, commandArgs: string[], opts: { port?: number }) => {
    try {
      const cmd = commandArgs[0];
      const args = commandArgs.slice(1);
      const cwd = process.cwd();

      const proc = runProcess(label, cmd, args, cwd, opts.port);
      console.log(`Started '${label}': ${cmd} ${args.join(" ")} (PID: ${proc.pid})`);

      await new Promise<void>((resolve) => {
        proc.child?.on("exit", (code) => {
          console.log(`Process '${label}' exited with code ${code}`);
          resolve();
        });
      });
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    }
  });
