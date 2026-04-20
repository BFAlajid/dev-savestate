import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runCli, parseJsonStdout } from "../cli-runner.js";

export const inspectTool: Tool = {
  name: "inspect_savestate",
  description:
    "Show full details for a single save state without loading it: branch, commit, note, next-step hint, tags, managed processes, editor state (open files + cursors), load history. Use this before load_savestate to confirm what you're about to restore.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Exact name of the save state to inspect.",
      },
    },
    required: ["name"],
  },
  annotations: {
    title: "Inspect save state",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

interface InspectInput {
  name: string;
}

function parseInput(raw: unknown): InspectInput {
  if (raw === undefined || raw === null || typeof raw !== "object") {
    throw new Error("inspect_savestate: arguments must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name.length === 0) {
    throw new Error("inspect_savestate: name is required and must be a non-empty string");
  }
  return { name: obj.name };
}

export async function handleInspect(rawArgs: unknown): Promise<CallToolResult> {
  const input = parseInput(rawArgs);

  const result = await runCli(["inspect", input.name, "--json"]);

  if (result.code !== 0) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `dvs inspect '${input.name}' failed (exit ${result.code}): ${
            result.stderr || result.stdout || "no output"
          }`,
        },
      ],
    };
  }

  const parsed = parseJsonStdout(result.stdout);
  return {
    content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
  };
}
