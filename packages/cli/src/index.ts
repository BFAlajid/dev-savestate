import { Command } from "commander";
import { saveCommand } from "./commands/save.js";
import { loadCommand } from "./commands/load.js";
import { listCommand } from "./commands/list.js";
import { deleteCommand } from "./commands/delete.js";
import { backCommand } from "./commands/back.js";
import { inspectCommand } from "./commands/inspect.js";
import { diffCommand } from "./commands/diff.js";
import { shareCommand, importCommand } from "./commands/share.js";
import { searchCommand } from "./commands/search.js";
import { timelineCommand } from "./commands/timeline.js";
import { statsCommand } from "./commands/stats.js";
import { openCommand } from "./commands/open.js";
import { archiveCommand, unarchiveCommand } from "./commands/archive.js";
import { runCommand } from "./commands/run.js";
import { stopCommand } from "./commands/stop.js";
import { statusCommand } from "./commands/status.js";
import { hooksCommand } from "./commands/hooks.js";
import { recoverCommand } from "./commands/recover.js";
import { unlockCommand } from "./commands/unlock.js";

const program = new Command();

program
  .name("dvs")
  .description("Emulator save states for development environments")
  .version("1.0.0");

// Core
program.addCommand(saveCommand);
program.addCommand(loadCommand);
program.addCommand(listCommand);
program.addCommand(deleteCommand);
program.addCommand(backCommand);

// Inspect & compare
program.addCommand(inspectCommand);
program.addCommand(diffCommand);

// Search & analytics
program.addCommand(searchCommand);
program.addCommand(timelineCommand);
program.addCommand(statsCommand);
program.addCommand(openCommand);

// Organization
program.addCommand(archiveCommand);
program.addCommand(unarchiveCommand);

// Sharing
program.addCommand(shareCommand);
program.addCommand(importCommand);

// Process management
program.addCommand(runCommand);
program.addCommand(stopCommand);
program.addCommand(statusCommand);

// Git hooks
program.addCommand(hooksCommand);

// Recovery & maintenance
program.addCommand(recoverCommand);
program.addCommand(unlockCommand);

program.parse();
