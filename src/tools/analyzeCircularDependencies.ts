import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveProjectPath } from "../utils/projectResolver.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

type CycleSeverity = "critical" | "high" | "medium" | "low" | "info";

/**
 * runtime   - every import in the loop is evaluated when modules load.
 * lazy      - at least one link is a dynamic import(), so the loop is broken
 *             at load time.
 * type-only - at least one link is `import type` (or only imports types), so
 *             the loop is erased by the compiler.
 */
type CycleKind = "runtime" | "lazy" | "type-only";

type ImportKind =
  | "import"
  | "side-effect"
  | "re-export"
  | "dynamic"
  | "require";

interface CycleEdge {
  from: string;
  to: string;
  line: number;
  column: number;
  kind: ImportKind;
  mode: CycleKind;
  bindings: number;
  statement: string;
}

interface CycleWeakestLink {
  from: string;
  to: string;
  line: number;
  reason: string;
}

interface CircularDependencyCycle {
  id: string;
  severity: CycleSeverity;
  kind: CycleKind;
  score: number;
  length: number;
  title: string;
  description: string;
  recommendation: string;
  /** Files in import order. The last file imports the first one. */
  files: string[];
  /** edges[i] goes from files[i] to files[(i + 1) % files.length]. */
  edges: CycleEdge[];
  groupId: string;
  groupSize: number;
  involvesBarrel: boolean;
  weakestLink: CycleWeakestLink;
}

interface CycleGroup {
  id: string;
  kind: CycleKind;
  size: number;
  files: string[];
  cycleCount: number;
}

interface EntangledFile {
  filePath: string;
  cycleCount: number;
  runtimeCycleCount: number;
}

interface CircularDependencyReport {
  success: boolean;
  tool: "analyze_circular_dependencies";
  projectPath: string;
  filePath?: string;
  filesScanned: number;
  importEdges: number;
  unresolvedImports: number;
  totalCycles: number;
  runtimeCycles: number;
  lazyCycles: number;
  typeOnlyCycles: number;
  cycleGroups: number;
  filesInCycles: number;
  longestCycle: number;
  /** Cycle count for the whole project, before any filePath filter. */
  projectCycleCount: number;
  summary: Record<CycleSeverity, number>;
  cycles: CircularDependencyCycle[];
  groups: CycleGroup[];
  entangledFiles: EntangledFile[];
  warnings: string[];
}

interface RawImport {
  specifier: string;
  kind: ImportKind;
  typeOnly: boolean;
  line: number;
  column: number;
  bindings: number;
  statement: string;
}

interface AliasConfig {
  dir: string;
  baseUrl?: string;
  pathsBase?: string;
  paths: Array<[pattern: string, targets: string[]]>;
}

interface RawAliasOptions {
  baseUrl?: string;
  pathsBase?: string;
  paths?: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

const SOURCE_EXTENSION_SET = new Set(SOURCE_EXTENSIONS);

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "out",
  ".vite",
  "generated-diagrams",
]);

/** Relative imports with these extensions are assets, not modules. */
const ASSET_EXTENSIONS = new Set([
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".json",
  ".md",
  ".mdx",
  ".html",
  ".txt",
  ".woff",
  ".woff2",
  ".ttf",
  ".mp4",
  ".mp3",
  ".wasm",
  ".csv",
  ".yaml",
  ".yml",
  ".graphql",
  ".gql",
]);

const JS_TO_TS_SWAPS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

const MAX_FILES = 8_000;
const MAX_FILE_BYTES = 1_500_000;
const MAX_CYCLES = 300;
const MAX_CYCLES_PER_GROUP = 60;
const MAX_WARNINGS = 25;
const CONFIG_MAX_DEPTH = 4;
const MAX_ENTANGLED_FILES = 15;

const MODE_RANK: Record<CycleKind, number> = {
  "type-only": 0,
  lazy: 1,
  runtime: 2,
};

const LAYERS: Array<{ kind: CycleKind; include: (mode: CycleKind) => boolean }> =
  [
    // Cycles made only of load-time imports.
    { kind: "runtime", include: (mode) => mode === "runtime" },
    // Cycles that need at least one dynamic import() to exist.
    { kind: "lazy", include: (mode) => mode !== "type-only" },
    // Cycles that need at least one type-only import to exist.
    { kind: "type-only", include: () => true },
  ];

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

function normalize(value: string): string {
  return value.replaceAll("\\", "/");
}

function isBarrelFile(filePath: string): boolean {
  return /^index\.[cm]?[jt]sx?$/.test(path.posix.basename(filePath));
}

function shortName(filePath: string): string {
  const parts = filePath.split("/");
  const name = parts[parts.length - 1];

  if (isBarrelFile(filePath) && parts.length > 1) {
    return `${parts[parts.length - 2]}/${name}`;
  }

  return name;
}

function occurrenceMode(occurrence: RawImport): CycleKind {
  if (occurrence.typeOnly) return "type-only";
  if (occurrence.kind === "dynamic") return "lazy";
  return "runtime";
}

/* -------------------------------------------------------------------------- */
/*  File discovery                                                            */
/* -------------------------------------------------------------------------- */

function discoverProjectFiles(root: string): {
  sources: string[];
  configs: string[];
  truncated: boolean;
} {
  const sources: string[] = [];
  const configs: string[] = [];
  let truncated = false;

  const stack: Array<{ dir: string; depth: number }> = [
    { dir: root, depth: 0 },
  ];

  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;

      const absolute = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          stack.push({ dir: absolute, depth: depth + 1 });
        }
        continue;
      }

      if (!entry.isFile()) continue;

      if (
        depth <= CONFIG_MAX_DEPTH &&
        /^(ts|js)config(\..+)?\.json$/.test(entry.name)
      ) {
        configs.push(absolute);
        continue;
      }

      const extension = path.extname(entry.name);

      if (
        !SOURCE_EXTENSION_SET.has(extension) ||
        /\.d\.[cm]?ts$/.test(entry.name)
      ) {
        continue;
      }

      if (sources.length >= MAX_FILES) {
        truncated = true;
        continue;
      }

      sources.push(absolute);
    }
  }

  sources.sort();
  return { sources, configs, truncated };
}

/* -------------------------------------------------------------------------- */
/*  tsconfig path aliases                                                     */
/* -------------------------------------------------------------------------- */

function readAliasOptions(configPath: string, depth = 0): RawAliasOptions {
  if (depth > 5) return {};

  const read = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
  if (read.error || !read.config || typeof read.config !== "object") {
    return {};
  }

  const config = read.config as {
    extends?: unknown;
    compilerOptions?: { baseUrl?: unknown; paths?: unknown };
  };
  const dir = path.dirname(configPath);

  let result: RawAliasOptions = {};

  if (typeof config.extends === "string" && config.extends.startsWith(".")) {
    let parent = path.resolve(dir, config.extends);
    if (!parent.endsWith(".json")) parent += ".json";
    result = readAliasOptions(parent, depth + 1);
  }

  const options = config.compilerOptions;

  if (options && typeof options.baseUrl === "string") {
    result.baseUrl = path.resolve(dir, options.baseUrl);
  }

  if (options && options.paths && typeof options.paths === "object") {
    result.paths = options.paths as Record<string, unknown>;
    result.pathsBase = result.baseUrl ?? dir;
  }

  return result;
}

function loadAliasConfigs(configFiles: string[]): AliasConfig[] {
  const configs: AliasConfig[] = [];

  for (const configPath of configFiles) {
    const options = readAliasOptions(configPath);
    if (!options.baseUrl && !options.paths) continue;

    const paths: Array<[string, string[]]> = Object.entries(
      options.paths ?? {},
    )
      .filter(
        (entry): entry is [string, string[]] =>
          Array.isArray(entry[1]) &&
          entry[1].every((target) => typeof target === "string"),
      )
      // TypeScript prefers the longest matching pattern.
      .sort((a, b) => b[0].length - a[0].length);

    configs.push({
      dir: path.dirname(configPath),
      baseUrl: options.baseUrl,
      pathsBase: options.pathsBase,
      paths,
    });
  }

  return configs;
}

function matchPattern(pattern: string, specifier: string): string | undefined {
  const star = pattern.indexOf("*");

  if (star === -1) {
    return pattern === specifier ? "" : undefined;
  }

  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);

  if (
    specifier.length >= prefix.length + suffix.length &&
    specifier.startsWith(prefix) &&
    specifier.endsWith(suffix)
  ) {
    return specifier.slice(prefix.length, specifier.length - suffix.length);
  }

  return undefined;
}

/* -------------------------------------------------------------------------- */
/*  Module resolution                                                         */
/* -------------------------------------------------------------------------- */

function tryResolveFile(base: string, fileSet: Set<string>): string | undefined {
  if (fileSet.has(base)) return base;

  const extension = path.extname(base);
  const swaps = JS_TO_TS_SWAPS[extension];

  if (swaps) {
    const stem = base.slice(0, -extension.length);
    for (const swap of swaps) {
      if (fileSet.has(stem + swap)) return stem + swap;
    }
  }

  for (const candidate of SOURCE_EXTENSIONS) {
    if (fileSet.has(base + candidate)) return base + candidate;
  }

  for (const candidate of SOURCE_EXTENSIONS) {
    const indexFile = path.join(base, `index${candidate}`);
    if (fileSet.has(indexFile)) return indexFile;
  }

  return undefined;
}

function createResolver(
  root: string,
  fileSet: Set<string>,
  aliasConfigs: AliasConfig[],
) {
  const configCache = new Map<string, AliasConfig[]>();

  function configsFor(dir: string): AliasConfig[] {
    const cached = configCache.get(dir);
    if (cached) return cached;

    const applicable = aliasConfigs
      .filter(
        (config) => dir === config.dir || dir.startsWith(config.dir + path.sep),
      )
      .sort((a, b) => b.dir.length - a.dir.length);

    configCache.set(dir, applicable);
    return applicable;
  }

  function ancestorDirs(fromDir: string): string[] {
    const dirs: string[] = [];
    let current = fromDir;

    while (current.startsWith(root)) {
      dirs.push(current);
      if (current === root) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    return dirs;
  }

  return function resolve(
    fromFile: string,
    specifier: string,
  ): string | undefined {
    const fromDir = path.dirname(fromFile);

    if (specifier.startsWith(".")) {
      return tryResolveFile(path.resolve(fromDir, specifier), fileSet);
    }

    if (specifier.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
      return undefined;
    }

    for (const config of configsFor(fromDir)) {
      for (const [pattern, targets] of config.paths) {
        const captured = matchPattern(pattern, specifier);
        if (captured === undefined) continue;

        for (const target of targets) {
          const base = path.resolve(
            config.pathsBase ?? config.dir,
            target.replace("*", captured),
          );
          const hit = tryResolveFile(base, fileSet);
          if (hit) return hit;
        }
      }

      if (config.baseUrl) {
        const hit = tryResolveFile(
          path.resolve(config.baseUrl, specifier),
          fileSet,
        );
        if (hit) return hit;
      }
    }

    // Common bundler convention: "@/x" or "~/x" -> "<project>/src/x".
    if (specifier.startsWith("@/") || specifier.startsWith("~/")) {
      const rest = specifier.slice(2);
      for (const dir of ancestorDirs(fromDir)) {
        const hit = tryResolveFile(path.join(dir, "src", rest), fileSet);
        if (hit) return hit;
      }
    }

    return undefined;
  };
}

/* -------------------------------------------------------------------------- */
/*  Import extraction (TypeScript AST)                                        */
/* -------------------------------------------------------------------------- */

function extractImports(sourceFile: ts.SourceFile): RawImport[] {
  const imports: RawImport[] = [];

  function position(node: ts.Node): { line: number; column: number } {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    return { line: line + 1, column: character + 1 };
  }

  function statementText(node: ts.Node): string {
    return node.getText(sourceFile).replace(/\s+/g, " ").trim().slice(0, 240);
  }

  function add(
    node: ts.Node,
    specifier: string,
    kind: ImportKind,
    typeOnly: boolean,
    bindings: number,
  ) {
    imports.push({
      specifier,
      kind,
      typeOnly,
      bindings,
      statement: statementText(node),
      ...position(node),
    });
  }

  function visit(node: ts.Node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.importClause;
      let typeOnly = false;
      let bindings = 0;
      let kind: ImportKind = "import";

      if (!clause) {
        kind = "side-effect";
      } else {
        typeOnly = clause.isTypeOnly;
        if (clause.name) bindings++;

        const named = clause.namedBindings;
        if (named) {
          if (ts.isNamespaceImport(named)) {
            bindings++;
          } else {
            bindings += named.elements.length;
            if (
              !typeOnly &&
              !clause.name &&
              named.elements.length > 0 &&
              named.elements.every((element) => element.isTypeOnly)
            ) {
              typeOnly = true;
            }
          }
        }
      }

      add(node, node.moduleSpecifier.text, kind, typeOnly, bindings);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      let typeOnly = node.isTypeOnly;
      // `export * from` re-exports an unknown number of bindings.
      let bindings = 99;
      const clause = node.exportClause;

      if (clause && ts.isNamedExports(clause)) {
        bindings = clause.elements.length;
        if (
          !typeOnly &&
          clause.elements.length > 0 &&
          clause.elements.every((element) => element.isTypeOnly)
        ) {
          typeOnly = true;
        }
      } else if (clause && ts.isNamespaceExport(clause)) {
        bindings = 1;
      }

      add(node, node.moduleSpecifier.text, "re-export", typeOnly, bindings);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      add(
        node,
        node.moduleReference.expression.text,
        "require",
        node.isTypeOnly,
        1,
      );
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const argument = node.arguments[0];

      if (ts.isStringLiteralLike(argument)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          add(node, argument.text, "dynamic", false, 1);
        } else if (
          ts.isIdentifier(node.expression) &&
          node.expression.text === "require"
        ) {
          add(node, argument.text, "require", false, 1);
        }
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      add(node, node.argument.literal.text, "import", true, 1);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return imports;
}

/* -------------------------------------------------------------------------- */
/*  Graph algorithms                                                          */
/* -------------------------------------------------------------------------- */

/** Iterative Tarjan so very deep import chains cannot overflow the stack. */
function stronglyConnectedComponents(
  nodes: string[],
  adjacency: Map<string, string[]>,
): string[][] {
  let counter = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  for (const root of nodes) {
    if (indices.has(root)) continue;

    const work: Array<{ node: string; next: number }> = [
      { node: root, next: 0 },
    ];

    indices.set(root, counter);
    lowLinks.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const neighbors = adjacency.get(frame.node) ?? [];

      if (frame.next < neighbors.length) {
        const neighbor = neighbors[frame.next++];

        if (!indices.has(neighbor)) {
          indices.set(neighbor, counter);
          lowLinks.set(neighbor, counter);
          counter++;
          stack.push(neighbor);
          onStack.add(neighbor);
          work.push({ node: neighbor, next: 0 });
        } else if (onStack.has(neighbor)) {
          lowLinks.set(
            frame.node,
            Math.min(lowLinks.get(frame.node)!, indices.get(neighbor)!),
          );
        }
        continue;
      }

      if (lowLinks.get(frame.node) === indices.get(frame.node)) {
        const component: string[] = [];
        let member: string;

        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);

        components.push(component);
      }

      work.pop();

      const parent = work[work.length - 1];
      if (parent) {
        lowLinks.set(
          parent.node,
          Math.min(lowLinks.get(parent.node)!, lowLinks.get(frame.node)!),
        );
      }
    }
  }

  return components;
}

function rotateToSmallest(nodes: string[]): string[] {
  let smallest = 0;
  for (let index = 1; index < nodes.length; index++) {
    if (nodes[index] < nodes[smallest]) smallest = index;
  }
  return [...nodes.slice(smallest), ...nodes.slice(0, smallest)];
}

/**
 * For every file in the component, find the shortest import loop through it.
 * This yields readable, representative cycles without enumerating the
 * (potentially exponential) set of all simple cycles.
 */
function findShortestCycles(
  component: string[],
  adjacency: Map<string, string[]>,
  limit: number,
): { cycles: string[][]; truncated: boolean } {
  const members = new Set(component);
  const found = new Map<string, string[]>();
  let truncated = false;

  for (const start of [...component].sort()) {
    if (found.size >= limit) {
      truncated = true;
      break;
    }

    const parent = new Map<string, string | null>([[start, null]]);
    const queue: string[] = [start];
    let head = 0;
    let closing: string | undefined;

    search: while (head < queue.length) {
      const current = queue[head++];

      for (const next of adjacency.get(current) ?? []) {
        if (!members.has(next)) continue;

        if (next === start) {
          closing = current;
          break search;
        }

        if (!parent.has(next)) {
          parent.set(next, current);
          queue.push(next);
        }
      }
    }

    if (closing === undefined) continue;

    const nodes: string[] = [];
    for (
      let node: string | null = closing;
      node !== null;
      node = parent.get(node) ?? null
    ) {
      nodes.push(node);
    }
    nodes.reverse();

    const rotated = rotateToSmallest(nodes);
    const key = rotated.join("\0");
    if (!found.has(key)) found.set(key, rotated);
  }

  return { cycles: [...found.values()], truncated };
}

/* -------------------------------------------------------------------------- */
/*  Scoring and wording                                                       */
/* -------------------------------------------------------------------------- */

function classifyCycle(edges: CycleEdge[]): CycleKind {
  if (edges.some((edge) => edge.mode === "type-only")) return "type-only";
  if (edges.some((edge) => edge.mode === "lazy")) return "lazy";
  return "runtime";
}

function scoreCycle(
  kind: CycleKind,
  length: number,
  involvesBarrel: boolean,
  groupSize: number,
): number {
  if (kind === "type-only") return 10 + Math.min(length, 5);
  if (kind === "lazy") return 20 + Math.min(length * 2, 14);

  let score = 40 + (length - 1) * 6;
  if (involvesBarrel) score += 12;
  if (groupSize > length) score += 8;
  return Math.min(100, score);
}

function severityFor(kind: CycleKind, score: number): CycleSeverity {
  if (kind === "type-only") return "info";
  if (kind === "lazy") return "low";
  if (score >= 85) return "critical";
  if (score >= 65) return "high";
  return "medium";
}

function pickWeakestLink(edges: CycleEdge[]): CycleWeakestLink {
  const cost = (edge: CycleEdge) =>
    edge.kind === "re-export" ? 50 + edge.bindings : Math.max(1, edge.bindings);

  let best = edges[0];
  for (const edge of edges) {
    if (cost(edge) < cost(best)) best = edge;
  }

  let reason: string;
  if (best.kind === "re-export") {
    reason =
      "Re-export link. Importing from the defining module directly removes it.";
  } else if (best.kind === "side-effect") {
    reason =
      "Side-effect import. It may be removable or replaceable with an explicit init call.";
  } else {
    const count = Math.max(1, best.bindings);
    reason = `Pulls in only ${count} binding${count === 1 ? "" : "s"}, so it is the cheapest link to extract or invert.`;
  }

  return { from: best.from, to: best.to, line: best.line, reason };
}

function describeCycle(
  kind: CycleKind,
  files: string[],
): { title: string; description: string } {
  const length = files.length;
  const loop = [...files, files[0]].map(shortName).join(" → ");

  if (length === 1) {
    return {
      title: `Self-import in ${shortName(files[0])}`,
      description: `${files[0]} imports itself.`,
    };
  }

  if (kind === "type-only") {
    return {
      title: `Type-only import cycle (${length} files)`,
      description: `${loop}. The loop exists only in type positions and is erased when the code is compiled.`,
    };
  }

  if (kind === "lazy") {
    return {
      title: `Lazy import cycle (${length} files)`,
      description: `${loop}. At least one link is a dynamic import(), so the modules do not evaluate each other during startup.`,
    };
  }

  return {
    title: `Runtime import cycle (${length} files)`,
    description: `${loop}. These imports run at load time, so a module can observe undefined exports depending on which file loads first.`,
  };
}

function buildRecommendation(
  kind: CycleKind,
  length: number,
  involvesBarrel: boolean,
  weakest: CycleWeakestLink,
): string {
  const link = `${shortName(weakest.from)} → ${shortName(weakest.to)} (line ${weakest.line})`;

  if (kind === "type-only") {
    return "This loop only exists in type positions and is erased at compile time, so it is harmless at runtime. To clear it anyway, move the shared types or interfaces into a separate types module that both files import.";
  }

  if (kind === "lazy") {
    return "A dynamic import() breaks this loop at load time. Keep that boundary deliberate (for example route-level code splitting). Otherwise move the shared code into a third module so no lazy escape hatch is needed.";
  }

  if (length === 1) {
    return "Remove the self-import and reference the symbol directly.";
  }

  if (involvesBarrel) {
    return `A barrel (index) file is part of this loop. Import from the module that defines the symbol instead of the barrel, and avoid re-exporting modules that import their own barrel. Start with ${link}.`;
  }

  if (length === 2) {
    return `Extract what both files need (shared helpers, constants, types) into a third module and have both import from it. The cheapest link to cut is ${link}.`;
  }

  return `Break the loop at its weakest link, ${link}. Move shared code into a leaf module that imports nothing from this loop, or invert the dependency by passing the value in as a parameter or callback.`;
}

/* -------------------------------------------------------------------------- */
/*  Analysis                                                                  */
/* -------------------------------------------------------------------------- */

export async function analyzeCircularDependencies(
  projectPath: string,
  filePath?: string,
): Promise<CircularDependencyReport> {
  if (
    filePath !== undefined &&
    (path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes(".."))
  ) {
    throw new Error("filePath must be relative to projectPath.");
  }

  const resolvedProject = await resolveProjectPath(projectPath);
  const root = fs.realpathSync(resolvedProject.projectPath);
  const warnings: string[] = [];

  const warn = (message: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message);
    else if (warnings.length === MAX_WARNINGS) {
      warnings.push("Further warnings were omitted.");
    }
  };

  const discovered = discoverProjectFiles(root);

  if (discovered.truncated) {
    warn(
      `Only the first ${MAX_FILES} source files were analyzed. Narrow the project path for complete results.`,
    );
  }

  if (discovered.sources.length === 0) {
    throw new Error(
      `No JavaScript or TypeScript source files were found in ${root}.`,
    );
  }

  const relative = (absolute: string) =>
    normalize(path.relative(root, absolute));

  const fileSet = new Set(discovered.sources);
  const resolve = createResolver(
    root,
    fileSet,
    loadAliasConfigs(discovered.configs),
  );

  /* ---- Build the file graph ---- */

  const edgeMap = new Map<string, CycleEdge>();
  let unresolvedImports = 0;

  for (const file of discovered.sources) {
    let text: string;

    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) {
        warn(`Skipped ${relative(file)} because it is larger than 1.5 MB.`);
        continue;
      }
      text = fs.readFileSync(file, "utf8");
    } catch {
      warn(`Could not read ${relative(file)}.`);
      continue;
    }

    const sourceFile = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      false,
    );

    for (const occurrence of extractImports(sourceFile)) {
      const specifier = occurrence.specifier.split("?")[0];
      const target = resolve(file, specifier);

      if (!target) {
        if (
          specifier.startsWith(".") &&
          !ASSET_EXTENSIONS.has(path.extname(specifier).toLowerCase())
        ) {
          unresolvedImports++;
          warn(
            `Unresolved import "${occurrence.specifier}" in ${relative(file)}:${occurrence.line}.`,
          );
        }
        continue;
      }

      const from = relative(file);
      const to = relative(target);
      const mode = occurrenceMode(occurrence);
      const key = `${from}\0${to}`;
      const existing = edgeMap.get(key);

      if (!existing) {
        edgeMap.set(key, {
          from,
          to,
          line: occurrence.line,
          column: occurrence.column,
          kind: occurrence.kind,
          mode,
          bindings: occurrence.bindings,
          statement: occurrence.statement,
        });
        continue;
      }

      existing.bindings += occurrence.bindings;

      // Show the import that matters most: a load-time import beats a lazy
      // one, which beats a type-only one.
      if (MODE_RANK[mode] > MODE_RANK[existing.mode]) {
        existing.mode = mode;
        existing.kind = occurrence.kind;
        existing.line = occurrence.line;
        existing.column = occurrence.column;
        existing.statement = occurrence.statement;
      }
    }
  }

  const allEdges = [...edgeMap.values()];

  /* ---- Find cycles layer by layer ---- */

  const cycles: CircularDependencyCycle[] = [];
  const groups: CycleGroup[] = [];
  const seenCycles = new Set<string>();
  let reachedCycleLimit = false;
  let reachedGroupLimit = false;

  for (const layer of LAYERS) {
    const adjacency = new Map<string, string[]>();

    for (const edge of allEdges) {
      if (!layer.include(edge.mode)) continue;
      const list = adjacency.get(edge.from);
      if (list) list.push(edge.to);
      else adjacency.set(edge.from, [edge.to]);
    }

    const nodes = new Set<string>(adjacency.keys());
    for (const targets of adjacency.values()) {
      for (const target of targets) nodes.add(target);
    }

    const components = stronglyConnectedComponents(
      [...nodes].sort(),
      adjacency,
    ).filter(
      (component) =>
        component.length > 1 ||
        (adjacency.get(component[0]) ?? []).includes(component[0]),
    );

    components.sort((a, b) => a.length - b.length || a[0].localeCompare(b[0]));

    for (const component of components) {
      if (cycles.length >= MAX_CYCLES) {
        reachedCycleLimit = true;
        break;
      }

      const found = findShortestCycles(
        component,
        adjacency,
        MAX_CYCLES_PER_GROUP,
      );
      if (found.truncated) reachedGroupLimit = true;

      const groupId = `${layer.kind}-group-${groups.length + 1}`;
      let added = 0;

      for (const nodesInCycle of found.cycles) {
        const edges = nodesInCycle.map(
          (file, index) =>
            edgeMap.get(
              `${file}\0${nodesInCycle[(index + 1) % nodesInCycle.length]}`,
            )!,
        );

        // A cycle that also exists in a stricter layer was already reported.
        if (classifyCycle(edges) !== layer.kind) continue;

        const key = nodesInCycle.join("\0");
        if (seenCycles.has(key)) continue;
        seenCycles.add(key);

        const length = nodesInCycle.length;
        const involvesBarrel = nodesInCycle.some(isBarrelFile);
        const score = scoreCycle(
          layer.kind,
          length,
          involvesBarrel,
          component.length,
        );
        const weakestLink = pickWeakestLink(edges);
        const { title, description } = describeCycle(layer.kind, nodesInCycle);

        cycles.push({
          id: `cycle-${createHash("sha1").update(key).digest("hex").slice(0, 10)}`,
          severity: severityFor(layer.kind, score),
          kind: layer.kind,
          score,
          length,
          title,
          description,
          recommendation: buildRecommendation(
            layer.kind,
            length,
            involvesBarrel,
            weakestLink,
          ),
          files: nodesInCycle,
          edges,
          groupId,
          groupSize: component.length,
          involvesBarrel,
          weakestLink,
        });

        added++;
        if (cycles.length >= MAX_CYCLES) {
          reachedCycleLimit = true;
          break;
        }
      }

      if (added > 0) {
        groups.push({
          id: groupId,
          kind: layer.kind,
          size: component.length,
          files: [...component].sort(),
          cycleCount: added,
        });
      }
    }
  }

  if (reachedCycleLimit) {
    warn(
      `Reporting stopped at ${MAX_CYCLES} cycles. Fix the highest-severity ones and re-run to see the rest.`,
    );
  }

  if (reachedGroupLimit) {
    warn(
      `Some tightly connected groups contain more than ${MAX_CYCLES_PER_GROUP} distinct loops, so only the shortest loop through each file is listed.`,
    );
  }

  const projectCycleCount = cycles.length;

  /* ---- Optional focus on one file ---- */

  let focusFile: string | undefined;

  if (filePath !== undefined && filePath.trim() !== "") {
    focusFile = normalize(
      path.relative(root, path.resolve(root, filePath.trim())),
    );

    const known = new Set(discovered.sources.map(relative));
    if (!known.has(focusFile)) {
      throw new Error(
        `File "${filePath}" was not found among the ${known.size} analyzed source files.`,
      );
    }
  }

  const reported = focusFile
    ? cycles.filter((cycle) => cycle.files.includes(focusFile!))
    : cycles;

  reported.sort(
    (a, b) =>
      b.score - a.score ||
      a.length - b.length ||
      a.files[0].localeCompare(b.files[0]),
  );

  /* ---- Summaries ---- */

  const summary: Record<CycleSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  const perFile = new Map<string, { all: number; runtime: number }>();
  const reportedGroupIds = new Set<string>();

  for (const cycle of reported) {
    summary[cycle.severity]++;
    reportedGroupIds.add(cycle.groupId);

    for (const file of cycle.files) {
      const entry = perFile.get(file) ?? { all: 0, runtime: 0 };
      entry.all++;
      if (cycle.kind === "runtime") entry.runtime++;
      perFile.set(file, entry);
    }
  }

  const entangledFiles: EntangledFile[] = [...perFile.entries()]
    .map(([file, counts]) => ({
      filePath: file,
      cycleCount: counts.all,
      runtimeCycleCount: counts.runtime,
    }))
    .sort(
      (a, b) =>
        b.runtimeCycleCount - a.runtimeCycleCount ||
        b.cycleCount - a.cycleCount ||
        a.filePath.localeCompare(b.filePath),
    )
    .slice(0, MAX_ENTANGLED_FILES);

  return {
    success: true,
    tool: "analyze_circular_dependencies",
    projectPath: root,
    filePath: focusFile,
    filesScanned: discovered.sources.length,
    importEdges: allEdges.length,
    unresolvedImports,
    totalCycles: reported.length,
    runtimeCycles: reported.filter((cycle) => cycle.kind === "runtime").length,
    lazyCycles: reported.filter((cycle) => cycle.kind === "lazy").length,
    typeOnlyCycles: reported.filter((cycle) => cycle.kind === "type-only")
      .length,
    cycleGroups: reportedGroupIds.size,
    filesInCycles: perFile.size,
    longestCycle: reported.reduce((max, cycle) => Math.max(max, cycle.length), 0),
    projectCycleCount,
    summary,
    cycles: reported,
    groups: groups.filter((group) => reportedGroupIds.has(group.id)),
    entangledFiles,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/*  MCP registration                                                          */
/* -------------------------------------------------------------------------- */

export function registerAnalyzeCircularDependenciesTool(server: McpServer) {
  server.registerTool(
    "analyze_circular_dependencies",
    {
      description:
        "Detect circular imports in a JavaScript/TypeScript project. Builds the file import graph with the TypeScript AST (static imports, re-exports, dynamic import(), require, tsconfig path aliases), finds strongly connected groups, and reports concrete import loops classified as runtime, lazy (dynamic import), or type-only, with the exact import lines, a suggested weakest link to cut, and a recommended fix.",
      inputSchema: z.object({
        projectPath: z
          .string()
          .describe("Absolute path to the project directory"),
        filePath: z
          .string()
          .optional()
          .describe(
            "Optional file, relative to projectPath. When set, only cycles that include this file are reported.",
          ),
      }),
    },
    async ({ projectPath, filePath }) => {
      try {
        const report = await analyzeCircularDependencies(projectPath, filePath);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(report, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  tool: "analyze_circular_dependencies",
                  error:
                    error instanceof Error
                      ? error.message
                      : "Failed to analyze circular dependencies.",
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
