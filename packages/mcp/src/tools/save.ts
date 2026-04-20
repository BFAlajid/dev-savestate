import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runCli, parseJsonStdout } from "../cli-runner.js";

export const saveTool: Tool = {
  name: "save_current_context",
  description:
    "Capture the current git state (branch, commit, uncommitted diff) and managed processes into a named save state with a human-readable note. Use this to checkpoint work-in-progress before switching tasks. Does not affect git history or working tree. The `note` parameter is required — it's the 'what was I doing' reminder shown when the state is loaded later. Editor state (open files, cursor positions) is only captured if the VS Code extension is also active; otherwise omitted.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Name for the save state (letters, digits, hyphens, underscores). If omitted, the CLI generates a timestamped name.",
      },
      note: {
        type: "string",
        description:
          "Required. What you're working on. Shown when the state is later loaded or inspected. Keep it short — a sentence or two.",
      },
    },
    required: ["note"],
  },
  annotations: {
    title: "Save current context",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

interface SaveInput {
  name?: string;
  note: string;
}

function parseInput(raw: unknown): SaveInput {
  if (raw === undefined || raw === null || typeof raw !== "object") {
    throw new Error("save_current_context: arguments must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.note !== "string" || obj.note.trim().length === 0) {
    throw new Error("save_current_context: note is required and must be a non-empty string");
  }
  const out: SaveInput = { note: obj.note };
  if (obj.name !== undefined) {
    if (typeof obj.name !== "string") {
      throw new Error("save_current_context: name must be a string");
    }
    out.name = obj.name;
  }
  return out;
}

export async function handleSave(rawArgs: unknown): Promise<CallToolResult> {
  const input = parseInput(rawArgs);

  // CLI signature: `dvs save [name] [note] --json`
  // The CLI accepts positional note without TTY prompting when provided.
  const args: string[] = ["save"];
  if (input.name) args.push(input.name);
  args.push(input.note);
  args.push("--json");

  const result = await runCli(args);

  // The save command emits JSON to stdout on both success and failure when --json is set.
  let parsed: unknown;
  try {
    parsed = parseJsonStdout(result.stdout);
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `dvs save failed (exit ${result.code}): ${
            err instanceof Error ? err.message : String(err)
          }\nstderr: ${result.stderr}`,
        },
      ],
    };
  }

  const payload = parsed as { success?: boolean; error?: string };
  if (result.code !== 0 || payload.success === false) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `dvs save failed: ${payload.error ?? result.stderr ?? "unknown error"}`,
        },
      ],
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
  };
}
