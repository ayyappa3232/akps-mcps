import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { generateDependencyTrace } from "./traceDependencies.js";

const MAX_OUTPUT_NAME_LENGTH = 100;

function sanitizeFileName(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_OUTPUT_NAME_LENGTH);

  return sanitized || "dependency-diagram";
}

export function registerGenerateDependencyDiagramTool(
  server: McpServer
): void {
  server.registerTool(
    "generate_dependency_diagram",
    {
      description:
        "Trace local JavaScript and TypeScript dependencies, generate Mermaid diagram source, and save it as an .mmd file inside the MCP server's generated-diagrams directory.",
      inputSchema: {
        projectPath: z
          .string()
          .describe("Absolute path to the target project directory."),
        filePath: z
          .string()
          .describe(
            "Entry file relative to projectPath, for example src/App.tsx."
          ),
        maxDepth: z
          .number()
          .int()
          .min(0)
          .max(10)
          .default(5)
          .describe("Maximum dependency traversal depth.")
      }
    },
    async ({ projectPath, filePath, maxDepth }) => {
      try {
        // Find the MCP project root.
        // Works when this module is executed from src/tools or dist/tools.
        const moduleDirectory = path.dirname(
          fileURLToPath(import.meta.url)
        );

        const projectRoot = path.resolve(moduleDirectory, "../..");

        // Store generated diagrams centrally, outside the target project.
        const outputDirectory = path.join(
          projectRoot,
          "generated-diagrams"
        );

        mkdirSync(outputDirectory, { recursive: true });

        // Reuse the dependency-tracing implementation.
        const result = generateDependencyTrace(
          projectPath,
          filePath,
          maxDepth
        );

        if (!result.success) {
          throw new Error("Dependency tracing did not succeed.");
        }

        // Create a readable, filesystem-safe output filename.
        const projectName = sanitizeFileName(
          path.basename(path.resolve(projectPath))
        );

        const entryName = sanitizeFileName(
          path.basename(filePath, path.extname(filePath))
        );

        const outputName = `${projectName}-${entryName}.mmd`;
        const outputPath = path.join(outputDirectory, outputName);

        // Save the Mermaid source.
        writeFileSync(outputPath, result.mermaid, {
          encoding: "utf8",
          flag: "w"
        });

        const response = {
          success: true,
          projectPath: result.projectPath,
          entryFile: result.entryFile,
          maxDepth: result.maxDepth,
          outputFile: outputPath,
          nodeCount: result.graph.nodes.length,
          edgeCount: result.graph.edges.length,
          mermaid: result.mermaid,
          warnings: result.warnings
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2)
            }
          ],
          structuredContent: response
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unknown error.";

        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  error: message
                },
                null,
                2
              )
            }
          ]
        };
      }
    }
  );
}