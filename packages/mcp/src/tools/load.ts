import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runCli } from "../cli-runner.js";

export const loadTool: Tool = {
  name: "load_savestate",
  description:
    "WARNING: state-mutating. Restore a previously-saved context by checking out the saved branch, applying the uncommitted diff, and restarting managed processes. If the working tree is dirty this will fail unless `force` is true (which discards local changes — destructive). Always confirm with the user before calling this if there's any chance of losing work. A pre-load checkpoint is stored, so `dvs back` on the CLI can undo.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Exact name of the save state to load. Use list_savestates to discover names.",
      },
      force: {
        type: "boolean",
        description:
          "Skip the dirty-working-tree check. Destructive — local uncommitted changes will be overwritten by the saved patch. Default: false.",
      },
    },
    required: ["name"],
  },
  annotations: {
    title: "Load save state",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
};

interface LoadInput {
  name: string;
  force?: boolean;
}

function parseInput(raw: unknown): LoadInput {
  if (raw === undefined || raw === null || typeof raw !== "object") {
    throw new Error("load_savestate: arguments must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name.length === 0) {
    throw new Error("load_savestate: name is required and must be a non-empty string");
  }
  const out: LoadInput = { name: obj.name };
  if (obj.force !== undefined) {
    if (typeof obj.force !== "boolean") {
      throw new Error("load_savestate: force must be boolean");
    }
    out.force = obj.force;
  }
  return out;
}

export async function handleLoad(rawArgs: unknown): Promise<CallToolResult> {
  const input = parseInput(rawArgs);

  // NOTE: `dvs load` does not currently support --json, so we return the
  // plain-text output as-is. The CLI exits non-zero on failure; stderr
  // holds the human-readable error message.
  const args: string[] = ["load", input.name];
  if (input.force) args.push("--force");

  const result = await runCli(args);

  if (result.code !== 0) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `dvs load '${input.name}' failed (exit ${result.code}): ${
            result.stderr || result.stdout || "no output"
          }`,
        },
      ],
    };
  }

  // Success — stdout contains the mental-stack printout plus any process
  // restoration messages. Pass it straight to the model.
  return {
    content: [
      {
        type: "text",
        text: result.stdout || `Loaded save state '${input.name}'.`,
      },
    ],
  };
}
