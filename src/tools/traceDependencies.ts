
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  existsSync,
  realpathSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import * as ts from "typescript";

type DependencyNode = {
  file: string;
  absolutePath: string;
  depth: number;
  dependencies: DependencyNode[];

  // New dependency metadata
  isShared?: boolean;
  isCircular?: boolean;
  referenceTo?: string;
};

type GraphNode = {
  id: string;
  label: string;
  filePath: string;
};

type GraphEdge = {
  from: string;
  to: string;
};

type TraceResult = {
  success: boolean;
  projectPath: string;
  entryFile: string;
  maxDepth: number;
  maxNodes: number;
  // New statistics
  uniqueFileCount: number;
  dependencyRelationshipCount: number;
  sharedDependencyCount: number;
  circularDependencyCount: number;
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
  dependencyTree: DependencyNode;
  mermaid: string;
  warnings: string[];
};

type TypeScriptAliases = {
  baseUrl: string;
  paths: Record<string, string[]>;
};

const SOURCE_EXTENSIONS = [
  ".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".mts", ".cts",
] as const;

const RESOLVABLE_EXTENSIONS = [
  ...SOURCE_EXTENSIONS,
  ".json",
] as const;

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
]);

const DEFAULT_MAX_NODES = 150;
const HARD_MAX_NODES = 1000;
const MAX_FILE_SIZE = 1024 * 1024;

function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);

  return (
    relative === "" ||
    (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    )
  );
}

function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const name = path.basename(normalized);

  return (
    name.startsWith(".env") ||
    name === "serviceAccountKey.json" ||
    name === "id_rsa" ||
    name === "id_ed25519" ||
    normalized.includes("/.ssh/") ||
    normalized.includes("/.aws/")
  );
}

function relativePath(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

/**
 * Generate collision-resistant graph node IDs.
 */
function toNodeId(file: string): string {
  return `file_${Buffer.from(file, "utf8").toString("hex")}`;
}

function escapeLabel(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/[<>]/g, "")
    .replace(/\r?\n/g, " ");
}

/**
 * Extract JavaScript/TypeScript imports using the TypeScript AST.
 *
 * Supports:
 * - import declarations
 * - export declarations
 * - import()
 * - require()
 * - import equals
 *
 * Comments and string examples are not treated as imports.
 */
function extractImports(source: string): string[] {
  const imports = new Set<string>();

  const sourceFile = ts.createSourceFile(
    "dependency-scan.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) ||
        ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      imports.add(node.moduleSpecifier.text);
    }

    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      imports.add(node.moduleReference.expression.text);
    }

    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (
          ts.isIdentifier(node.expression) &&
          node.expression.text === "require"
        )
      )
    ) {
      imports.add(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return [...imports];
}

/**
 * Read TypeScript path aliases from tsconfig.json.
 */
function loadTypeScriptAliases(root: string): TypeScriptAliases {
  const configPath = ts.findConfigFile(
    root,
    ts.sys.fileExists,
    "tsconfig.json",
  );

  if (!configPath) {
    return {
      baseUrl: root,
      paths: {},
    };
  }

  const configFile = ts.readConfigFile(
    configPath,
    ts.sys.readFile,
  );

  if (configFile.error) {
    return {
      baseUrl: path.dirname(configPath),
      paths: {},
    };
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
    {},
    configPath,
  );

  return {
    baseUrl: parsed.options.baseUrl ?? path.dirname(configPath),
    paths: parsed.options.paths ?? {},
  };
}

/**
 * Resolve local imports.
 *
 * Supports:
 * - Relative imports
 * - TypeScript path aliases
 * - baseUrl imports
 * - JSON imports
 * - index files
 */
function resolveImport(
  importer: string,
  importPath: string,
  root: string,
  aliases: TypeScriptAliases,
): string | undefined {
  const candidates: string[] = [];

  function addCandidates(base: string): void {
    candidates.push(
      base,
      ...RESOLVABLE_EXTENSIONS.map((ext) => base + ext),
      ...RESOLVABLE_EXTENSIONS.map((ext) =>
        path.join(base, `index${ext}`),
      ),
    );

    candidates.push(base + ".json");
  }

  if (importPath.startsWith(".")) {
    addCandidates(
      path.resolve(path.dirname(importer), importPath),
    );
  } else {
    for (const [pattern, replacements] of Object.entries(
      aliases.paths,
    )) {
      const wildcardIndex = pattern.indexOf("*");

      if (wildcardIndex === -1) {
        if (pattern === importPath) {
          for (const replacement of replacements) {
            addCandidates(
              path.resolve(aliases.baseUrl, replacement),
            );
          }
        }

        continue;
      }

      const prefix = pattern.slice(0, wildcardIndex);
      const suffix = pattern.slice(wildcardIndex + 1);

      if (
        !importPath.startsWith(prefix) ||
        !importPath.endsWith(suffix) ||
        importPath.length < prefix.length + suffix.length
      ) {
        continue;
      }

      const matchedPart = importPath.slice(
        prefix.length,
        importPath.length - suffix.length,
      );

      for (const replacement of replacements) {
        addCandidates(
          path.resolve(
            aliases.baseUrl,
            replacement.replace("*", matchedPart),
          ),
        );
      }
    }

    addCandidates(
      path.resolve(aliases.baseUrl, importPath),
    );
  }

  for (const candidate of [...new Set(candidates)]) {
    if (!existsSync(candidate)) {
      continue;
    }

    try {
      const resolved = realpathSync(candidate);

      if (
        !isInsideRoot(root, resolved) ||
        isSensitivePath(resolved) ||
        !statSync(resolved).isFile()
      ) {
        continue;
      }

      if (
        !(RESOLVABLE_EXTENSIONS as readonly string[]).includes(
          path.extname(resolved).toLowerCase(),
        )
      ) {
        continue;
      }

      const parts = relativePath(root, resolved).split("/");

      if (
        parts.some((part) => IGNORED_DIRECTORIES.has(part))
      ) {
        continue;
      }

      return resolved;
    } catch {
      // Try the next candidate.
    }
  }

  return undefined;
}

/**
 * Read declared npm dependencies from package.json.
 */
function getDeclaredPackageNames(root: string): Set<string> {
  const packageJsonPath = path.join(root, "package.json");

  if (!existsSync(packageJsonPath)) {
    return new Set();
  }

  try {
    const packageJson = JSON.parse(
      readFileSync(packageJsonPath, "utf8"),
    );

    const dependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
      ...packageJson.peerDependencies,
      ...packageJson.optionalDependencies,
    };

    return new Set(Object.keys(dependencies));
  } catch {
    return new Set();
  }
}

/**
 * Extract the root npm package name.
 *
 * Examples:
 * react -> react
 * lodash/get -> lodash
 * @reduxjs/toolkit -> @reduxjs/toolkit
 * @scope/package/subpath -> @scope/package
 */
function getPackageName(
  importPath: string,
): string | undefined {
  if (
    importPath.startsWith(".") ||
    importPath.startsWith("/") ||
    importPath.startsWith("#") ||
    /^[a-zA-Z]:[\\/]/.test(importPath)
  ) {
    return undefined;
  }

  const parts = importPath.split("/");

  if (importPath.startsWith("@")) {
    return parts.length >= 2
      ? `${parts[0]}/${parts[1]}`
      : undefined;
  }

  return parts[0] || undefined;
}

/**
 * Identify external npm dependencies.
 *
 * Checks:
 * 1. package.json declarations
 * 2. Actual package resolution from the target project
 * 3. node_modules fallback
 */
function isExternalPackage(
  root: string,
  importPath: string,
  declaredPackages: Set<string>,
): boolean {
  const packageName = getPackageName(importPath);

  if (!packageName) {
    return false;
  }

  if (declaredPackages.has(packageName)) {
    return true;
  }

  try {
    const requireFromProject = createRequire(
      path.join(root, "__dependency_scanner__.cjs"),
    );

    requireFromProject.resolve(packageName);

    return true;
  } catch {
    return existsSync(
      path.join(
        root,
        "node_modules",
        ...packageName.split("/"),
      ),
    );
  }
}

/**
 * Main dependency scanning implementation.
 */
function traceProject(
  projectPathInput: string,
  entryFileInput: string,
  maxDepthInput: number,
  maxNodesInput: number,
): TraceResult {
  if (!path.isAbsolute(projectPathInput)) {
    throw new Error(
      "projectPath must be an absolute path.",
    );
  }

  if (
    path.isAbsolute(entryFileInput) ||
    entryFileInput.split(/[\\/]/).includes("..")
  ) {
    throw new Error(
      "entryFile must be a relative path inside the project.",
    );
  }

  const requestedRoot = path.resolve(projectPathInput);

  if (
    !existsSync(requestedRoot) ||
    !statSync(requestedRoot).isDirectory()
  ) {
    throw new Error(
      "The project directory does not exist.",
    );
  }

  const root = realpathSync(requestedRoot);
  const requestedEntry = path.resolve(
    root,
    entryFileInput,
  );

  if (
    !existsSync(requestedEntry) ||
    !statSync(requestedEntry).isFile()
  ) {
    throw new Error(
      "The entry file does not exist.",
    );
  }

  const entry = realpathSync(requestedEntry);

  if (
    !isInsideRoot(root, entry) ||
    isSensitivePath(entry)
  ) {
    throw new Error(
      "The entry file is outside the permitted project.",
    );
  }

  const entryParts = relativePath(root, entry).split("/");

  if (
    entryParts.some((part) => IGNORED_DIRECTORIES.has(part))
  ) {
    throw new Error(
      "The entry file is inside an excluded directory.",
    );
  }

  const maxDepth = Math.max(
    0,
    Math.min(10, Math.floor(maxDepthInput)),
  );

  const maxNodes = Math.max(
    1,
    Math.min(HARD_MAX_NODES, Math.floor(maxNodesInput)),
  );

  const warnings: string[] = [];

  const aliases = loadTypeScriptAliases(root);
  const declaredPackages = getDeclaredPackageNames(root);

  const visited = new Set<string>();
  const graphNodes = new Map<string, GraphNode>();
  const graphEdges = new Map<string, GraphEdge>();

  function visit(
    absoluteFile: string,
    depth: number,
    ancestors: Set<string> = new Set(),
  ): DependencyNode {
    const relativeFile = relativePath(
      root,
      absoluteFile,
    );

    const node: DependencyNode = {
      file: relativeFile,
      absolutePath: absoluteFile,
      depth,
      dependencies: [],
    };

    if (visited.has(absoluteFile)) {
      return node;
    }

    if (visited.size >= maxNodes) {
      const warning =
        `Maximum graph size reached (${maxNodes} nodes).`;

      if (!warnings.includes(warning)) {
        warnings.push(warning);
      }

      return node;
    }

    visited.add(absoluteFile);
    const currentAncestors = new Set(ancestors);
    currentAncestors.add(absoluteFile);

    const nodeId = toNodeId(relativeFile);

    graphNodes.set(nodeId, {
      id: nodeId,
      label: relativeFile,
      filePath: relativeFile,
    });

    if (depth >= maxDepth) {
      return node;
    }

    let source: string;

    try {
      if (statSync(absoluteFile).size > MAX_FILE_SIZE) {
        warnings.push(
          `Skipped large file: ${relativeFile}`,
        );

        return node;
      }

      source = readFileSync(absoluteFile, "utf8");
    } catch {
      warnings.push(
        `Unable to read: ${relativeFile}`,
      );

      return node;
    }

    for (const importPath of extractImports(source)) {
      const resolved = resolveImport(
        absoluteFile,
        importPath,
        root,
        aliases,
      );

      if (!resolved) {
        if (
          isExternalPackage(
            root,
            importPath,
            declaredPackages,
          )
        ) {
          continue;
        }

        if (
          !importPath.startsWith(".") &&
          !importPath.startsWith("/")
        ) {
          warnings.push(
            `Could not resolve "${importPath}" imported by ${relativeFile}. ` +
            "It may be an undeclared package, bundler-only alias, or virtual module.",
          );
        } else {
          warnings.push(
            `Could not resolve "${importPath}" imported by ${relativeFile}.`,
          );
        }

        continue;
      }

      const dependencyRelative = relativePath(
        root,
        resolved,
      );

      const dependencyId = toNodeId(
        dependencyRelative,
      );

      if (
        !graphNodes.has(dependencyId) &&
        graphNodes.size >= maxNodes
      ) {
        const warning =
          `Maximum graph size reached (${maxNodes} nodes).`;

        if (!warnings.includes(warning)) {
          warnings.push(warning);
        }

        break;
      }

      graphNodes.set(dependencyId, {
        id: dependencyId,
        label: dependencyRelative,
        filePath: dependencyRelative,
      });

      graphEdges.set(
        `${nodeId}->${dependencyId}`,
        {
          from: nodeId,
          to: dependencyId,
        },
      );

      const isCircular = currentAncestors.has(resolved);
      const isShared = visited.has(resolved) && !isCircular;

      if (!visited.has(resolved)) {
        node.dependencies.push(
          visit(
            resolved,
            depth + 1,
            currentAncestors,
          ),
        );
      } else {
        node.dependencies.push({
          file: dependencyRelative,
          absolutePath: resolved,
          depth: depth + 1,
          dependencies: [],
          isCircular,
          isShared,
          referenceTo: dependencyRelative,
        });
      }
    }

    return node;
  }

  const dependencyTree = visit(entry, 0);

  const nodes = [...graphNodes.values()];
  const edges = [...graphEdges.values()];

  // Count incoming references for every unique file.
  const incomingReferences = new Map<string, number>();

  for (const edge of edges) {
    incomingReferences.set(
      edge.to,
      (incomingReferences.get(edge.to) ?? 0) + 1
    );
  }

  // Update every occurrence in the dependency tree.
  function annotateTree(node: DependencyNode): void {
    const nodeId = toNodeId(
      relativePath(root, node.absolutePath)
    );

    node.isShared =
      (incomingReferences.get(nodeId) ?? 0) > 1;

    node.dependencies.forEach(annotateTree);
  }

  annotateTree(dependencyTree);

  let circularDependencyCount = 0;

  function countCircularReferences(node: DependencyNode): void {
    if (node.isCircular) {
      circularDependencyCount++;
    }

    node.dependencies.forEach(countCircularReferences);
  }

  countCircularReferences(dependencyTree);

  const sharedDependencyCount = [...incomingReferences.values()]
    .filter((count) => count > 1).length;

  const mermaidLines = ["flowchart TD"];

  for (const node of nodes) {
    mermaidLines.push(
      `  ${node.id}["${escapeLabel(node.label)}"]`,
    );
  }

  for (const edge of edges) {
    mermaidLines.push(
      `  ${edge.from} --> ${edge.to}`,
    );
  }

  return {
    success: true,
    projectPath: root,
    entryFile: relativePath(root, entry),
    maxDepth,
    maxNodes,
    uniqueFileCount: nodes.length,
    dependencyRelationshipCount: edges.length,
    circularDependencyCount,
    sharedDependencyCount,
    dependencyTree,
    graph: {
      nodes,
      edges,
    },
    mermaid: mermaidLines.join("\n"),
    warnings: [...new Set(warnings)],
  };
}

/**
 * Public function used by the HTTP bridge and other modules.
 */
export function generateDependencyTrace(
  projectPath: string,
  filePath: string,
  maxDepth: number,
  maxNodes = DEFAULT_MAX_NODES,
): TraceResult {
  return traceProject(
    projectPath,
    filePath,
    maxDepth,
    maxNodes,
  );
}

/**
 * Register the dependency tracing MCP tool.
 */
export function registerTraceDependenciesTool(
  server: McpServer,
): void {
  server.registerTool(
    "trace_dependencies",
    {
      description:
        "Trace local JavaScript and TypeScript dependencies from an entry file. Returns a dependency tree, graph data and Mermaid diagram source. Supports relative imports and TypeScript tsconfig paths aliases; graph size is configurable.",

      inputSchema: {
        projectPath: z.string().describe(
          "Absolute path to the project directory.",
        ),

        filePath: z.string().describe(
          "Entry file relative to the project, for example src/App.tsx.",
        ),

        maxDepth: z.number().int().min(0).max(10).default(5).describe(
          "Maximum dependency traversal depth.",
        ),

        maxNodes: z.number().int().min(1).max(HARD_MAX_NODES)
          .default(DEFAULT_MAX_NODES)
          .describe(
            "Maximum number of graph nodes (default 150, hard limit 1000).",
          ),
      },
    },

    async ({ projectPath, filePath, maxDepth, maxNodes }) => {
      try {
        const result = traceProject(
          projectPath,
          filePath,
          maxDepth,
          maxNodes,
        );

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
                  error: message,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );
}
