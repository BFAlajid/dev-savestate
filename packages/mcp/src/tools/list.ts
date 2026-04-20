import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runCli, parseJsonStdout } from "../cli-runner.js";

export const listTool: Tool = {
  name: "list_savestates",
  description:
    "List all dev-savestate entries in the current project, most recent first. Each entry includes name, branch, commit hash, note, tags, timestamps, and load count. Use this to discover what save states exist before loading or inspecting.",
  inputSchema: {
    type: "object",
    properties: {
      archived: {
        type: "boolean",
        description: "Include archived save states. Default: false.",
      },
      limit: {
        type: "number",
        description:
          "Maximum number of entries to return. Default: 20. Entries are sorted most-recent-first, so the limit cuts off the oldest.",
      },
    },
  },
  annotations: {
    title: "List save states",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

interface ListInput {
  archived?: boolean;
  limit?: number;
}

function parseInput(raw: unknown): ListInput {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object") {
    throw new Error("list_savestates: arguments must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const out: ListInput = {};
  if (obj.archived !== undefined) {
    if (typeof obj.archived !== "boolean") {
      throw new Error("list_savestates: archived must be boolean");
    }
    out.archived = obj.archived;
  }
  if (obj.limit !== undefined) {
    if (typeof obj.limit !== "number" || !Number.isFinite(obj.limit) || obj.limit < 1) {
      throw new Error("list_savestates: limit must be a positive number");
    }
    out.limit = Math.floor(obj.limit);
  }
  return out;
}

export async function handleList(rawArgs: unknown): Promise<CallToolResult> {
  const input = parseInput(rawArgs);
  const limit = input.limit ?? 20;

  const args = ["list", "--json"];
  if (input.archived) args.push("--archived");

  const result = await runCli(args);

  if (result.code !== 0) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `dvs list failed (exit ${result.code}): ${result.stderr || result.stdout || "no output"}`,
        },
      ],
    };
  }

  const parsed = parseJsonStdout(result.stdout);
  if (!Array.isArray(parsed)) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `dvs list returned non-array JSON: ${JSON.stringify(parsed).slice(0, 300)}`,
        },
      ],
    };
  }

  // CLI's list command has no --limit flag; apply client-side.
  const truncated = parsed.slice(0, limit);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            total: parsed.length,
            returned: truncated.length,
            limit,
            states: truncated,
          },
          null,
          2
        ),
      },
    ],
  };
}
