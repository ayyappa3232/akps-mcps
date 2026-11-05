import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

const IGNORED_DIRECTORIES = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "coverage",
    ".next",
    ".vite",
    ".vercel",
    "vendor",
    "__pycache__"
]);

const IGNORED_FILES = new Set([
    ".env",
    ".env.local",
    ".env.production",
    "serviceAccountKey.json",
    "id_rsa",
    "id_ed25519"
]);

const MAX_ENTRIES = 20000;

interface SearchResult {
    name: string;
    relativePath: string;
    absolutePath: string;
    extension: string;
    type: "file" | "directory";
}

function matchesPattern(
    value: string,
    pattern: string,
    caseSensitive: boolean
): boolean {
    const candidate = caseSensitive ? value : value.toLowerCase();
    const expected = caseSensitive ? pattern : pattern.toLowerCase();

    // Support simple wildcard patterns:
    // *.tsx, *Order*, Order*, and *.
    if (expected.includes("*") || expected.includes("?")) {
        const escaped = expected.replace(
            /[.+^${}()|[\]\\]/g,
            "\\$&"
        );

        const regexPattern = escaped
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".");

        return new RegExp(`^${regexPattern}$`).test(candidate);
    }

    return candidate.includes(expected);
}

async function searchDirectory(
    rootPath: string,
    currentPath: string,
    pattern: string,
    extension: string,
    includeDirectories: boolean,
    caseSensitive: boolean,
    results: SearchResult[],
    counter: { visited: number; truncated: boolean }
): Promise<void> {
    if (counter.visited >= MAX_ENTRIES) {
        counter.truncated = true;
        return;
    }

    let entries;

    try {
        entries = await readdir(currentPath, {
            withFileTypes: true
        });
    } catch {
        // Ignore inaccessible directories and continue.
        return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
        if (counter.visited >= MAX_ENTRIES) {
            counter.truncated = true;
            return;
        }

        counter.visited += 1;

        if (entry.isSymbolicLink()) {
            continue;
        }

        const absolutePath = path.join(currentPath, entry.name);
        const relativePath = path.relative(rootPath, absolutePath);

        if (entry.isDirectory()) {
            if (IGNORED_DIRECTORIES.has(entry.name)) {
                continue;
            }

            if (
                includeDirectories &&
                matchesPattern(entry.name, pattern, caseSensitive)
            ) {
                results.push({
                    name: entry.name,
                    relativePath,
                    absolutePath,
                    extension: "",
                    type: "directory"
                });
            }

            await searchDirectory(
                rootPath,
                absolutePath,
                pattern,
                extension,
                includeDirectories,
                caseSensitive,
                results,
                counter
            );

            if (counter.truncated) {
                return;
            }

            continue;
        }

        if (!entry.isFile() || IGNORED_FILES.has(entry.name)) {
            continue;
        }

        const fileExtension = path.extname(entry.name);

        const nameMatches = matchesPattern(
            entry.name,
            pattern,
            caseSensitive
        );

        const extensionMatches =
            !extension ||
            (caseSensitive
                ? fileExtension === extension
                : fileExtension.toLowerCase() === extension.toLowerCase());

        if (nameMatches && extensionMatches) {
            results.push({
                name: entry.name,
                relativePath,
                absolutePath,
                extension: fileExtension,
                type: "file"
            });
        }
    }
}

export function registerFindFilesTool(server: McpServer): void {
    server.registerTool(
        "find_files",
        {
            description:
                "Searches a project recursively for files matching a name or wildcard pattern, with an optional extension filter. Can also find matching directory names. Excludes common generated directories and selected sensitive filenames. Read-only.",

            inputSchema: {
                projectPath: z.string().min(1).describe(
                    "Absolute path to the project directory."
                ),

                pattern: z.string().default("*").describe(
                    "Filename or wildcard pattern. Examples: *Order*, *.tsx, Order*, or *service*."
                ),

                extension: z.string().default("").describe(
                    "Optional exact extension filter, such as .tsx, .ts, .jsx, or .js."
                ),

                includeDirectories: z.boolean().default(false).describe(
                    "Whether to include matching directory names in the results."
                ),

                caseSensitive: z.boolean().default(false).describe(
                    "Whether filename matching should be case-sensitive."
                )
            }
        },

        async ({
            projectPath,
            pattern,
            extension,
            includeDirectories,
            caseSensitive
        }) => {
            console.error("[find_files] Received arguments:", {
                projectPath,
                pattern,
                extension,
                includeDirectories,
                caseSensitive
            });

            try {
                const rootPath = await realpath(path.resolve(projectPath));
                const rootStats = await stat(rootPath);

                if (!rootStats.isDirectory()) {
                    throw new Error(
                        "The supplied projectPath is not a directory."
                    );
                }

                const results: SearchResult[] = [];

                const counter = {
                    visited: 0,
                    truncated: false
                };

                await searchDirectory(
                    rootPath,
                    rootPath,
                    pattern,
                    extension,
                    includeDirectories,
                    caseSensitive,
                    results,
                    counter
                );

                const report = {
                    success: true,
                    tool: "find_files",
                    projectPath: rootPath,
                    search: {
                        pattern,
                        extension: extension || null,
                        includeDirectories,
                        caseSensitive
                    },
                    totalMatches: results.length,
                    entriesVisited: counter.visited,
                    truncated: counter.truncated,
                    results
                };

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify(report, null, 2)
                        }
                    ],
                    structuredContent: report
                };
            } catch (error) {
                const message =
                    error instanceof Error
                        ? error.message
                        : String(error);

                return {
                    isError: true,
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify(
                                {
                                    success: false,
                                    tool: "find_files",
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