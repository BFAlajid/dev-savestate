import { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import { findProjectRoot } from "../lib/git.js";

const HOOK_MARKER_START = "# >>> dvs auto-save hook";
const HOOK_MARKER_END = "# <<< dvs auto-save hook";

function getHookScript(): string {
  return `
${HOOK_MARKER_START}
if [ "$3" = "1" ]; then
  PREV_BRANCH=$(git rev-parse --abbrev-ref "$1" 2>/dev/null || echo "unknown")
  if command -v dvs >/dev/null 2>&1; then
    dvs save "_autosave-$PREV_BRANCH" "Auto-saved on branch switch" 2>/dev/null || true
  fi
fi
${HOOK_MARKER_END}
`;
}

const hooksCommand = new Command("hooks").description("Manage git hooks for auto-save");

hooksCommand
  .command("install")
  .description("Install post-checkout hook for auto-save on branch switch")
  .action(async () => {
    try {
      const projectRoot = await findProjectRoot(process.cwd());
      const hooksDir = path.join(projectRoot, ".git", "hooks");
      const hookFile = path.join(hooksDir, "post-checkout");
      await fs.mkdir(hooksDir, { recursive: true });

      let existing = "";
      try { existing = await fs.readFile(hookFile, "utf-8"); } catch {}

      if (existing.includes(HOOK_MARKER_START)) {
        console.log("Hook already installed.");
        return;
      }

      let content = existing || "#!/bin/sh\n";
      if (!content.endsWith("\n")) content += "\n";
      content += getHookScript();

      await fs.writeFile(hookFile, content);
      try { await fs.chmod(hookFile, 0o755); } catch {}

      console.log("Installed post-checkout hook for auto-save on branch switch.");
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    }
  });

hooksCommand
  .command("uninstall")
  .description("Remove dvs post-checkout hook")
  .action(async () => {
    try {
      const projectRoot = await findProjectRoot(process.cwd());
      const hookFile = path.join(projectRoot, ".git", "hooks", "post-checkout");

      let content: string;
      try { content = await fs.readFile(hookFile, "utf-8"); } catch {
        console.log("No hook installed.");
        return;
      }

      if (!content.includes(HOOK_MARKER_START)) {
        console.log("No dvs hook found.");
        return;
      }

      const regex = new RegExp(`\\n?${HOOK_MARKER_START}[\\s\\S]*?${HOOK_MARKER_END}\\n?`, "g");
      const newContent = content.replace(regex, "\n");

      if (newContent.trim() === "#!/bin/sh") {
        await fs.unlink(hookFile);
      } else {
        await fs.writeFile(hookFile, newContent);
      }
      console.log("Removed dvs post-checkout hook.");
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    }
  });

hooksCommand
  .command("status")
  .description("Show installed dvs hooks")
  .action(async () => {
    try {
      const projectRoot = await findProjectRoot(process.cwd());
      const hookFile = path.join(projectRoot, ".git", "hooks", "post-checkout");

      let content: string;
      try { content = await fs.readFile(hookFile, "utf-8"); } catch {
        console.log("No hooks installed.");
        return;
      }

      if (content.includes(HOOK_MARKER_START)) {
        console.log("post-checkout: installed (auto-save on branch switch)");
      } else {
        console.log("No dvs hooks installed.");
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    }
  });

export { hooksCommand };
