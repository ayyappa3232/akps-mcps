import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Directories that should not be scanned.
 *
 * These directories commonly contain generated files,
 * dependencies, build output, or version-control data.
 */
const IGNORED_DIRECTORIES = new Set([
    "node_modules",
    ".git",
    ".next",
    ".nuxt",
    ".output",
    ".turbo",
    ".vite",
    ".vercel",
    "dist",
    "build",
    "coverage",
    "vendor",
    "__pycache__"
]);

/**
 * Files whose names should not be included in the report.
 *
 * The scanner does not read file contents, but omitting
 * sensitive filenames makes the report safer to share.
 */
const IGNORED_FILES = new Set([
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    "serviceAccountKey.json",
    "id_rsa",
    "id_ed25519"
]);

/**
 * Configuration files useful for identifying a project.
 */
const CONFIGURATION_FILES = new Set([
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "tsconfig.json",
    "jsconfig.json",
    "vite.config.js",
    "vite.config.ts",
    "next.config.js",
    "next.config.ts",
    "next.config.mjs",
    "webpack.config.js",
    "webpack.config.ts",
    "eslint.config.js",
    ".eslintrc.json",
    "tailwind.config.js",
    "tailwind.config.ts",
    "postcss.config.js",
    "postcss.config.mjs",
    "angular.json",
    "vue.config.js",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "requirements.txt",
    "pom.xml",
    "build.gradle",
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml"
]);

/**
 * Describes the structure of a scanned directory.
 */
interface FolderNode {
    files: string[];
    folders: Record<string, FolderNode>;
}

/**
 * Describes a discovered project configuration.
 */
interface ConfigurationFile {
    name: string;
    relativePath: string;
}

/**
 * Tracks the scan so we can limit its size.
 */
interface ScanContext {
    visitedEntries: number;
    maxEntries: number;
    truncated: boolean;
}

/**
 * Recursively reads directory names without reading file contents.
 *
 * @param directoryPath Absolute path of the directory.
 * @param relativePath Relative path from the project root.
 * @param context Shared scan limits.
 */
async function getFolderStructure(
    directoryPath: string,
    relativePath: string,
    context: ScanContext
): Promise<FolderNode> {
    const files: string[] = [];
    const folders: Record<string, FolderNode> = {};

    let entries;

    try {
        entries = await readdir(directoryPath, {
            withFileTypes: true
        });
    } catch {
        // A directory may be inaccessible or disappear during scanning.
        return {
            files,
            folders
        };
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
        if (context.visitedEntries >= context.maxEntries) {
            context.truncated = true;
            break;
        }

        context.visitedEntries += 1;

        if (entry.isSymbolicLink()) {
            // Do not follow symbolic links outside the project.
            continue;
        }

        const entryRelativePath = relativePath
            ? path.join(relativePath, entry.name)
            : entry.name;

        if (entry.isDirectory()) {
            if (IGNORED_DIRECTORIES.has(entry.name)) {
                continue;
            }

            folders[entry.name] = await getFolderStructure(
                path.join(directoryPath, entry.name),
                entryRelativePath,
                context
            );

            if (context.truncated) {
                break;
            }

            continue;
        }

        if (entry.isFile()) {
            if (IGNORED_FILES.has(entry.name)) {
                continue;
            }

            files.push(entry.name);
        }
    }

    return {
        files,
        folders
    };
}

/**
 * Recursively discovers recognized configuration files.
 */
function findConfigurationFiles(
    node: FolderNode,
    relativePath = ""
): ConfigurationFile[] {
    const results: ConfigurationFile[] = [];

    for (const fileName of node.files) {
        if (CONFIGURATION_FILES.has(fileName)) {
            results.push({
                name: fileName,
                relativePath: relativePath
                    ? path.join(relativePath, fileName)
                    : fileName
            });
        }
    }

    for (const [folderName, childNode] of Object.entries(node.folders)) {
        const childPath = relativePath
            ? path.join(relativePath, folderName)
            : folderName;

        results.push(
            ...findConfigurationFiles(childNode, childPath)
        );
    }

    return results;
}

/**
 * Determines likely technologies using configuration filenames.
 */
function detectTechnology(folderStructure: FolderNode): string[] {
    const configurationFiles = findConfigurationFiles(folderStructure);

    const names = new Set(
        configurationFiles.map((file) => file.name)
    );

    const technologies: string[] = [];

    if (
        names.has("package.json") ||
        names.has("vite.config.js") ||
        names.has("vite.config.ts") ||
        names.has("next.config.js") ||
        names.has("next.config.ts") ||
        names.has("next.config.mjs")
    ) {
        technologies.push("JavaScript/TypeScript");
    }

    if (names.has("tsconfig.json")) {
        technologies.push("TypeScript");
    }

    if (names.has("angular.json")) {
        technologies.push("Angular");
    }

    if (
        names.has("vite.config.js") ||
        names.has("vite.config.ts") ||
        names.has("next.config.js") ||
        names.has("next.config.ts") ||
        names.has("next.config.mjs")
    ) {
        // These tools can be used by React or other frameworks.
        // Their presence alone does not prove the project uses React.
        technologies.push("Vite/Next.js tooling");
    }

    if (names.has("Cargo.toml")) {
        technologies.push("Rust");
    }

    if (names.has("go.mod")) {
        technologies.push("Go");
    }

    if (
        names.has("pyproject.toml") ||
        names.has("requirements.txt")
    ) {
        technologies.push("Python");
    }

    if (
        names.has("pom.xml") ||
        names.has("build.gradle")
    ) {
        technologies.push("Java/JVM");
    }

    return [...new Set(technologies)];
}

/**
 * Counts files and folders in the nested structure.
 */
function countStructure(node: FolderNode): {
    fileCount: number;
    folderCount: number;
} {
    let fileCount = node.files.length;
    let folderCount = Object.keys(node.folders).length;

    for (const childNode of Object.values(node.folders)) {
        const childCounts = countStructure(childNode);

        fileCount += childCounts.fileCount;
        folderCount += childCounts.folderCount;
    }

    return {
        fileCount,
        folderCount
    };
}

/**
 * Registers the scan_project MCP tool.
 */
export function registerScanProjectTool(server: McpServer): void {
    server.registerTool(
        "scan_project",
        {
            description:
                "Recursively inspect a project directory. Returns nested folders, filenames, detected configuration files, likely technologies, and scan statistics. Read-only; does not read source file contents.",

            inputSchema: {
                projectPath: z
                    .string()
                    .min(1)
                    .describe(
                        "Absolute path to the project directory to scan."
                    )
            }
        },

        async ({ projectPath }) => {
            try {
                // Resolve the selected path to its real filesystem path.
                const resolvedProjectPath = await realpath(
                    path.resolve(projectPath)
                );

                // Ensure the selected path is a directory.
                const projectStats = await stat(resolvedProjectPath);

                if (!projectStats.isDirectory()) {
                    throw new Error(
                        "The supplied projectPath is not a directory."
                    );
                }

                // Create a shared limit to avoid scanning an enormous tree.
                const context: ScanContext = {
                    visitedEntries: 0,
                    maxEntries: 20000,
                    truncated: false
                };

                // Recursively scan the directory.
                const folderStructure = await getFolderStructure(
                    resolvedProjectPath,
                    "",
                    context
                );

                // Identify root-level files and folders.
                const topLevelFiles = folderStructure.files;
                const topLevelFolders = Object.keys(
                    folderStructure.folders
                );

                // Find recognized configuration files at any depth.
                const detectedConfigurationFiles =
                    findConfigurationFiles(folderStructure);

                // Infer likely technologies from configuration filenames.
                const technology = detectTechnology(folderStructure);

                // Calculate totals for the scanned directory tree.
                const counts = countStructure(folderStructure);

                const report = {
                    projectName: path.basename(resolvedProjectPath),
                    projectPath: resolvedProjectPath,

                    technology,

                    topLevelFolders,
                    topLevelFiles,

                    detectedConfigurationFiles,

                    folderStructure,

                    statistics: {
                        files: counts.fileCount,
                        folders: counts.folderCount,
                        entriesVisited: context.visitedEntries,
                        maxEntries: context.maxEntries,
                        truncated: context.truncated
                    },

                    readOnly: true
                };

                // Return readable JSON and structured JSON.
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
                                    tool: "scan_project",
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