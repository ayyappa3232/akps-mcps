import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { registerAllTools } from "./tools/index.js";

const server = new McpServer({
  name: "developer-productivity-mcp",
  version: "1.0.0",
});

// Register every tool on this server.
registerAllTools(server);

// Start accepting MCP requests.
serveStdio(() => server);