import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { listTool, handleList } from "./tools/list.js";
import { saveTool, handleSave } from "./tools/save.js";
import { loadTool, handleLoad } from "./tools/load.js";
import { inspectTool, handleInspect } from "./tools/inspect.js";

// MCP uses stdout for JSON-RPC. All diagnostics go to stderr.
const log = (...args: unknown[]): void => {
  console.error("[dvs-mcp]", ...args);
};

// Support --help / --version for user sanity. Everything else falls through
// to the stdio server loop.
function handleCliArgs(): boolean {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      [
        "dvs-mcp — Model Context Protocol server for dev-savestate",
        "",
        "Usage: dvs-mcp",
        "",
        "This is a stdio MCP server. It is intended to be launched by an MCP",
        "client (Claude Desktop, Claude Code, Cursor, etc.) — not run directly.",
        "",
        "Environment:",
        "  DVS_CLI_PATH   Explicit path to the dvs CLI binary. If unset, the",
        "                 server looks for ./node_modules/.bin/dvs under the",
        "                 current working directory, then falls back to 'dvs'",
        "                 on PATH.",
        "",
        "The MCP client must launch this server with CWD set to the project",
        "root you want to manage save states for. See the README for config",
        "examples.",
        "",
      ].join("\n")
    );
    return true;
  }
  if (argv.includes("--version") || argv.includes("-V")) {
    // Keep in sync with package.json. Hardcoded because tsup bundles ESM
    // without a runtime package.json read path.
    process.stdout.write("0.1.0\n");
    return true;
  }
  return false;
}

type ToolHandler = (rawArgs: unknown) => Promise<CallToolResult>;

const TOOLS: Tool[] = [listTool, saveTool, loadTool, inspectTool];

const HANDLERS: Record<string, ToolHandler> = {
  [listTool.name]: handleList,
  [saveTool.name]: handleSave,
  [loadTool.name]: handleLoad,
  [inspectTool.name]: handleInspect,
};

async function main(): Promise<void> {
  if (handleCliArgs()) return;

  const server = new Server(
    {
      name: "dev-savestate",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const handler = HANDLERS[toolName];
    if (!handler) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
      };
    }
    try {
      return await handler(request.params.arguments);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`tool '${toolName}' threw:`, message);
      return {
        isError: true,
        content: [{ type: "text", text: message }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`connected over stdio (cwd=${process.cwd()})`);
}

main().catch((err) => {
  log("fatal:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
