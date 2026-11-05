import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LINES_PER_REQUEST = 500;

const BLOCKED_FILENAMES = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  "serviceAccountKey.json",
  "id_rsa",
  "id_ed25519",
]);

export function registerReadFileTool(server: McpServer) {
  server.registerTool(
    "read_file",
    {
      description:
        "Read a text file within a project directory, optionally selecting a range of lines. Common secret files and paths outside the project are blocked.",
      inputSchema: {
        projectPath: z.string().min(1).describe(
          "Absolute path to the project directory",
        ),
        filePath: z.string().min(1).describe(
          "File path relative to the project directory",
        ),
        startLine: z.number().int().min(1).default(1).describe(
          "First line to read, starting at 1",
        ),
        endLine: z.number().int().min(1).optional().describe(
          "Last line to read, inclusive",
        ),
      },
    },
    async ({ projectPath, filePath, startLine, endLine }) => {
      try {
        if (!path.isAbsolute(projectPath)) {
          throw new Error("projectPath must be an absolute path.");
        }

        if (path.isAbsolute(filePath)) {
          throw new Error(
            "filePath must be relative to the project directory.",
          );
        }

        const rootPath = await realpath(projectPath);
        const rootStats = await stat(rootPath);

        if (!rootStats.isDirectory()) {
          throw new Error("projectPath must point to a directory.");
        }

        const normalizedRelativePath = path.normalize(filePath);

        if (
          normalizedRelativePath === ".." ||
          normalizedRelativePath.startsWith(`..${path.sep}`)
        ) {
          throw new Error("Access outside the project directory is blocked.");
        }

        const requestedPath = path.resolve(rootPath, normalizedRelativePath);
        const resolvedPath = await realpath(requestedPath);

        if (
          resolvedPath !== rootPath &&
          !resolvedPath.startsWith(rootPath + path.sep)
        ) {
          throw new Error("Access outside the project directory is blocked.");
        }

        const filename = path.basename(resolvedPath);

        if (
          BLOCKED_FILENAMES.has(filename) ||
          filename.startsWith(".env.")
        ) {
          throw new Error("Reading this potentially sensitive file is blocked.");
        }

        const fileStats = await stat(resolvedPath);

        if (!fileStats.isFile()) {
          throw new Error("The requested path is not a file.");
        }

        if (fileStats.size > MAX_FILE_BYTES) {
          throw new Error(
            "The file exceeds the 1 MB reading limit.",
          );
        }

        const content = await readFile(resolvedPath, "utf8");
        const lines = content.split(/\r?\n/);

        const requestedEndLine = endLine ?? lines.length;

        if (requestedEndLine < startLine) {
          throw new Error("endLine must be greater than or equal to startLine.");
        }

        if (requestedEndLine - startLine + 1 > MAX_LINES_PER_REQUEST) {
          throw new Error(
            `A maximum of ${MAX_LINES_PER_REQUEST} lines can be read per request.`,
          );
        }

        const selectedLines = lines.slice(startLine - 1, requestedEndLine);

        const result = {
          success: true,
          filePath: path.relative(rootPath, resolvedPath),
          totalLines: lines.length,
          startLine,
          endLine: Math.min(requestedEndLine, lines.length),
          linesReturned: selectedLines.length,
          content: selectedLines
            .map((line, index) => `${startLine + index}: ${line}`)
            .join("\n"),
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        const result = {
          success: false,
          filePath,
          error: error instanceof Error ? error.message : String(error),
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
          structuredContent: result,
        };
      }
    },
  );
}