import { Command } from "commander";
import { stopAllProcesses } from "../lib/process.js";

export const stopCommand = new Command("stop")
  .description("Stop all dvs-managed processes")
  .action(async () => {
    const count = stopAllProcesses();
    if (count === 0) {
      console.log("No managed processes running.");
    } else {
      console.log(`Stopped ${count} process(es).`);
    }
  });
