import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".vite",
  "vendor",
]);

const IGNORED_FILES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  "serviceAccountKey.json",
  "id_rsa",
  "id_ed25519",
]);

const SEARCHABLE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".json",
  ".css",
  ".scss",
  ".html",
]);

const MAX_FILES = 10_000;
const MAX_MATCHES = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

interface ReferenceMatch {
  file: string;
  line: number;
  column: number;
  text: string;
}

interface FindReferencesReport {
  success: boolean;
  projectPath: string;
  symbol: string;
  totalMatches: number;
  filesSearched: number;
  truncated: boolean;
  matches: ReferenceMatch[];
  errors: string[];
}

export function registerFindReferencesTool(server: McpServer) {
  server.registerTool(
    "find_references",
    {
      description:
        "Search source files in a project for a symbol or text and return matching file paths, line numbers, and matching lines.",
      inputSchema: {
        projectPath: z.string().min(1).describe(
          "Absolute path to the project directory",
        ),
        symbol: z.string().min(1).max(200).describe(
          "Function, variable, component, method, or text to search for",
        ),
        caseSensitive: z.boolean().default(true).describe(
          "Whether the search should be case-sensitive",
        ),
        wholeWord: z.boolean().default(true).describe(
          "Match the symbol as a whole word rather than part of another word",
        ),
      },
    },
    async ({ projectPath, symbol, caseSensitive, wholeWord }) => {
      const errors: string[] = [];
      const matches: ReferenceMatch[] = [];
      let filesSearched = 0;
      let totalMatches = 0;
      let truncated = false;

      try {
        if (!path.isAbsolute(projectPath)) {
          throw new Error("projectPath must be an absolute path.");
        }

        const rootPath = await realpath(projectPath);
        const rootStats = await stat(rootPath);

        if (!rootStats.isDirectory()) {
          throw new Error("projectPath must point to a directory.");
        }

        const searchRegex = new RegExp(
          wholeWord
            ? `\\b${escapeRegex(symbol)}\\b`
            : escapeRegex(symbol),
          caseSensitive ? "g" : "gi",
        );

        async function walk(directory: string): Promise<void> {
          if (filesSearched >= MAX_FILES || totalMatches >= MAX_MATCHES) {
            truncated = true;
            return;
          }

          let entries;

          try {
            entries = await readdir(directory, { withFileTypes: true });
          } catch (error) {
            errors.push(
              `Cannot read directory ${path.relative(rootPath, directory)}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return;
          }

          for (const entry of entries) {
            if (filesSearched >= MAX_FILES || totalMatches >= MAX_MATCHES) {
              truncated = true;
              return;
            }

            const fullPath = path.join(directory, entry.name);

            if (entry.isSymbolicLink()) {
              continue;
            }

            if (entry.isDirectory()) {
              if (!IGNORED_DIRECTORIES.has(entry.name)) {
                await walk(fullPath);
              }
              continue;
            }

            if (!entry.isFile() || IGNORED_FILES.has(entry.name)) {
              continue;
            }

            if (!SEARCHABLE_EXTENSIONS.has(path.extname(entry.name))) {
              continue;
            }

            let fileStats;

            try {
              fileStats = await stat(fullPath);
            } catch {
              errors.push(
                `Cannot inspect file ${path.relative(rootPath, fullPath)}`,
              );
              continue;
            }

            if (fileStats.size > MAX_FILE_BYTES) {
              continue;
            }

            let content: string;

            try {
              content = await readFile(fullPath, "utf8");
            } catch {
              errors.push(
                `Cannot read file ${path.relative(rootPath, fullPath)}`,
              );
              continue;
            }

            filesSearched++;

            const lines = content.split(/\r?\n/);

            for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
              const lineText = lines[lineIndex];
              searchRegex.lastIndex = 0;

              let match: RegExpExecArray | null;

              while ((match = searchRegex.exec(lineText)) !== null) {
                totalMatches++;

                if (matches.length < MAX_MATCHES) {
                  matches.push({
                    file: path.relative(rootPath, fullPath),
                    line: lineIndex + 1,
                    column: match.index + 1,
                    text: lineText.trim().slice(0, 500),
                  });
                }

                if (totalMatches >= MAX_MATCHES) {
                  truncated = true;
                  return;
                }

                // Prevent an infinite loop if a future pattern can match empty text.
                if (match[0].length === 0) {
                  searchRegex.lastIndex++;
                }
              }
            }
          }
        }

        await walk(rootPath);

        const report: FindReferencesReport = {
          success: true,
          projectPath: rootPath,
          symbol,
          totalMatches,
          filesSearched,
          truncated,
          matches,
          errors,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(report, null, 2),
            },
          ],
          structuredContent: report,
        };
      } catch (error) {
        const report: FindReferencesReport = {
          success: false,
          projectPath,
          symbol,
          totalMatches: 0,
          filesSearched,
          truncated: false,
          matches: [],
          errors: [
            error instanceof Error ? error.message : String(error),
          ],
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(report, null, 2),
            },
          ],
          structuredContent: report,
        };
      }
    },
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}