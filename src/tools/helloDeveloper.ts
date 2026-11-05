import type {McpServer} from '@modelcontextprotocol/server'
import * as z from 'zod/v4';

export function registerHelloDeveloperTool(server: McpServer) {
    server.registerTool(
        "hello_developer",
        {
            description: "Returns a welcome message for a developer.",
            inputSchema: z.object({}),
        },
        async () => ({
            content: [
                {
                    type: "text",
                    text: "Hello, developer! Your Developer Productivity MCP is working.",
                }
            ]
        })
    )
}