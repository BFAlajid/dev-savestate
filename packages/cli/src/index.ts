import { Command } from "commander";
import { saveCommand } from "./commands/save.js";
import { loadCommand } from "./commands/load.js";
import { listCommand } from "./commands/list.js";
import { deleteCommand } from "./commands/delete.js";

const program = new Command();

program
  .name("dvs")
  .description("Emulator save states for development environments")
  .version("0.1.0");

program.addCommand(saveCommand);
program.addCommand(loadCommand);
program.addCommand(listCommand);
program.addCommand(deleteCommand);

program.parse();
