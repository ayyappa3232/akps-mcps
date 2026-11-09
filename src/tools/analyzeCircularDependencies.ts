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

type FixStrategy =
  | "type-only-import"
  | "barrel-direct-import"
  | "extract-shared-module"
  | "remove-self-import"
  | "no-change-needed"
  | "manual";

interface FixChange {
  filePath: string;
  action: "modify" | "create";
  description: string;
  /** Unified-diff hunks (no file header) for display. */
  diff: string;
}

interface CycleFix {
  strategy: FixStrategy;
  confidence: "high" | "medium" | "low";
  title: string;
  summary: string;
  steps: string[];
  changes: FixChange[];
  /** Complete patch, ready for `git apply`. Empty when no change is proposed. */
  patch: string;
  caveats: string[];
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
  /** Concrete, applyable fix. Generated for the highest-ranked cycles. */
  fix?: CycleFix;
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

function edgeCost(edge: CycleEdge): number {
  return edge.kind === "re-export"
    ? 50 + edge.bindings
    : Math.max(1, edge.bindings);
}

function pickWeakestLink(edges: CycleEdge[]): CycleWeakestLink {
  let best = edges[0];
  for (const edge of edges) {
    if (edgeCost(edge) < edgeCost(best)) best = edge;
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
/*  Fix generation                                                            */
/* -------------------------------------------------------------------------- */

const MAX_FIX_CYCLES = 40;
const MAX_MOVED_DECLARATIONS = 15;
const MAX_MOVED_LINES = 250;

type FixAttempt = { fix: CycleFix } | { reason: string };

interface LineEdit {
  /** 1-based line. The edit replaces `deleteCount` lines starting here. */
  start: number;
  deleteCount: number;
  insert: string[];
}

interface ParsedFile {
  rel: string;
  abs: string;
  text: string;
  sf: ts.SourceFile;
  lines: string[];
  endsWithNewline: boolean;
  cr: string;
}

interface FixContext {
  root: string;
  resolve: (fromFile: string, specifier: string) => string | undefined;
  relative: (absolute: string) => string;
  runtimeAdjacency: Map<string, string[]>;
  knownFiles: Set<string>;
  cache: Map<string, ParsedFile | null>;
}

interface TopDecl {
  names: string[];
  node: ts.Statement;
  kind:
    | "function"
    | "class"
    | "const"
    | "mutable"
    | "interface"
    | "type"
    | "enum"
    | "other";
  exported: boolean;
  isDefault: boolean;
  typeLike: boolean;
}

interface ImportLocal {
  decl: ts.ImportDeclaration;
  kind: "default" | "namespace" | "named";
  element?: ts.ImportSpecifier;
}

function loadParsed(ctx: FixContext, rel: string): ParsedFile | undefined {
  if (ctx.cache.has(rel)) return ctx.cache.get(rel) ?? undefined;

  let parsed: ParsedFile | null = null;

  try {
    const abs = path.join(ctx.root, rel);
    const text = fs.readFileSync(abs, "utf8");
    const endsWithNewline = text.endsWith("\n");
    const lines = text.split("\n");
    if (endsWithNewline) lines.pop();

    parsed = {
      rel,
      abs,
      text,
      sf: ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true),
      lines,
      endsWithNewline,
      cr: text.includes("\r\n") ? "\r" : "",
    };
  } catch {
    parsed = null;
  }

  ctx.cache.set(rel, parsed);
  return parsed ?? undefined;
}

function lineAt(pf: ParsedFile, position: number): number {
  return pf.sf.getLineAndCharacterOfPosition(position).line + 1;
}

function nodeLines(
  pf: ParsedFile,
  node: ts.Node,
  includeDoc = false,
): { start: number; end: number } {
  return {
    start: lineAt(pf, node.getStart(pf.sf, includeDoc)),
    end: lineAt(pf, node.getEnd()),
  };
}

function modifiersOf(node: ts.Node): readonly ts.Modifier[] {
  return ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
}

function relativeSpecifier(
  fromRel: string,
  targetRel: string,
  jsExtension: boolean,
): string {
  let specifier = path.posix.relative(path.posix.dirname(fromRel), targetRel);
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;

  const extension = path.posix.extname(specifier);
  const mapped: Record<string, string> = {
    ".ts": ".js",
    ".tsx": ".js",
    ".mts": ".mjs",
    ".cts": ".cjs",
    ".js": ".js",
    ".jsx": ".jsx",
    ".mjs": ".mjs",
    ".cjs": ".cjs",
  };

  if (mapped[extension]) {
    specifier = specifier.slice(0, -extension.length);
    if (jsExtension) specifier += mapped[extension];
  }

  return specifier;
}

function canReach(
  adjacency: Map<string, string[]>,
  start: string,
  targets: Set<string>,
): boolean {
  if (targets.has(start)) return true;

  const seen = new Set<string>([start]);
  const queue = [start];

  for (let head = 0; head < queue.length; head++) {
    for (const next of adjacency.get(queue[head]) ?? []) {
      if (targets.has(next)) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }

  return false;
}

/* ---- Diff / patch building ---- */

function buildHunks(pf: ParsedFile, edits: LineEdit[]): string {
  const CONTEXT = 3;
  const sorted = [...edits].sort(
    (a, b) => a.start - b.start || a.deleteCount - b.deleteCount,
  );

  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1];
    if (sorted[index].start < previous.start + previous.deleteCount) {
      throw new Error("Overlapping edits while building a patch.");
    }
  }

  const groups: LineEdit[][] = [];
  for (const edit of sorted) {
    const group = groups[groups.length - 1];
    if (group) {
      const previous = group[group.length - 1];
      if (edit.start - (previous.start + previous.deleteCount) <= CONTEXT * 2) {
        group.push(edit);
        continue;
      }
    }
    groups.push([edit]);
  }

  const total = pf.lines.length;
  const noNewlineMarker = "\\ No newline at end of file";
  const out: string[] = [];
  let delta = 0;

  const pushOld = (prefix: string, lineNumber: number) => {
    out.push(prefix + pf.lines[lineNumber - 1]);
    if (!pf.endsWithNewline && lineNumber === total) out.push(noNewlineMarker);
  };

  for (const group of groups) {
    const first = group[0];
    const last = group[group.length - 1];
    const oldStart = Math.max(1, first.start - CONTEXT);
    const oldEnd = Math.min(total, last.start + last.deleteCount - 1 + CONTEXT);
    const deltaBefore = delta;
    let oldCount = 0;
    let newCount = 0;
    let line = oldStart;

    const header = out.length;
    out.push("");

    for (const edit of group) {
      while (line < edit.start) {
        pushOld(" ", line);
        line++;
        oldCount++;
        newCount++;
      }
      for (let k = 0; k < edit.deleteCount; k++) {
        pushOld("-", edit.start + k);
        oldCount++;
      }
      for (const inserted of edit.insert) {
        out.push(`+${inserted}${pf.cr}`);
        newCount++;
      }
      line = edit.start + edit.deleteCount;
      delta += edit.insert.length - edit.deleteCount;
    }

    while (line <= oldEnd) {
      pushOld(" ", line);
      line++;
      oldCount++;
      newCount++;
    }

    out[header] = `@@ -${oldStart},${oldCount} +${oldStart + deltaBefore},${newCount} @@`;
  }

  return out.join("\n");
}

function modifyChange(
  pf: ParsedFile,
  edits: LineEdit[],
  description: string,
): { change: FixChange; patch: string } {
  const hunks = buildHunks(pf, edits);

  return {
    change: {
      filePath: pf.rel,
      action: "modify",
      description,
      diff: hunks,
    },
    patch: `diff --git a/${pf.rel} b/${pf.rel}\n--- a/${pf.rel}\n+++ b/${pf.rel}\n${hunks}\n`,
  };
}

function createChange(
  rel: string,
  lines: string[],
  description: string,
  cr: string,
): { change: FixChange; patch: string } {
  const body = lines.map((line) => `+${line}${cr}`).join("\n");

  return {
    change: {
      filePath: rel,
      action: "create",
      description,
      diff: body,
    },
    patch: `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`,
  };
}

function assembleFix(
  fields: Omit<CycleFix, "changes" | "patch">,
  parts: Array<{ change: FixChange; patch: string }>,
): CycleFix {
  const crlf = parts.some((part) => part.patch.includes("\r"));

  return {
    ...fields,
    caveats: crlf
      ? [
          ...fields.caveats,
          "This file uses CRLF line endings. If `git apply` complains, run it with --ignore-whitespace.",
        ]
      : fields.caveats,
    changes: parts.map((part) => part.change),
    patch: parts.map((part) => part.patch).join(""),
  };
}

/* ---- AST helpers ---- */

function collectTopDecls(pf: ParsedFile): TopDecl[] {
  const decls: TopDecl[] = [];

  for (const statement of pf.sf.statements) {
    const modifiers = modifiersOf(statement);
    const exported = modifiers.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    const isDefault = modifiers.some(
      (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
    );

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      decls.push({
        names: [statement.name.text],
        node: statement,
        kind: "function",
        exported,
        isDefault,
        typeLike: false,
      });
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      decls.push({
        names: [statement.name.text],
        node: statement,
        kind: "class",
        exported,
        isDefault,
        typeLike: false,
      });
    } else if (ts.isInterfaceDeclaration(statement)) {
      decls.push({
        names: [statement.name.text],
        node: statement,
        kind: "interface",
        exported,
        isDefault,
        typeLike: true,
      });
    } else if (ts.isTypeAliasDeclaration(statement)) {
      decls.push({
        names: [statement.name.text],
        node: statement,
        kind: "type",
        exported,
        isDefault,
        typeLike: true,
      });
    } else if (ts.isEnumDeclaration(statement)) {
      decls.push({
        names: [statement.name.text],
        node: statement,
        kind: "enum",
        exported,
        isDefault,
        typeLike: false,
      });
    } else if (ts.isVariableStatement(statement)) {
      const names: string[] = [];
      let simple = true;

      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
        else simple = false;
      }

      const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;

      decls.push({
        names,
        node: statement,
        kind: !simple ? "other" : isConst ? "const" : "mutable",
        exported,
        isDefault,
        typeLike: false,
      });
    }
  }

  return decls;
}

function collectImportLocals(pf: ParsedFile): Map<string, ImportLocal> {
  const locals = new Map<string, ImportLocal>();

  for (const statement of pf.sf.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;

    const clause = statement.importClause;
    if (clause.name) {
      locals.set(clause.name.text, { decl: statement, kind: "default" });
    }

    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      locals.set(bindings.name.text, { decl: statement, kind: "namespace" });
    } else if (bindings) {
      for (const element of bindings.elements) {
        locals.set(element.name.text, {
          decl: statement,
          kind: "named",
          element,
        });
      }
    }
  }

  return locals;
}

function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;

  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;

  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isTypeParameterDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isJsxAttribute(parent)) &&
    (parent as { name?: ts.Node }).name === node
  ) {
    return false;
  }

  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;

  if (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent)
  ) {
    return false;
  }

  if (ts.isExportSpecifier(parent)) {
    const declaration = parent.parent.parent;
    return !declaration.moduleSpecifier;
  }

  return true;
}

function isInTypePosition(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isExpressionWithTypeArguments(current)) {
      const clause = current.parent;
      return (
        ts.isHeritageClause(clause) &&
        (clause.token === ts.SyntaxKind.ImplementsKeyword ||
          ts.isInterfaceDeclaration(clause.parent))
      );
    }

    if (ts.isTypeNode(current)) return true;
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false;
  }

  return false;
}

function hasValueUsage(pf: ParsedFile, local: string, skip: ts.Node): boolean {
  let found = false;

  const visit = (node: ts.Node) => {
    if (found || node === skip) return;

    if (
      ts.isIdentifier(node) &&
      node.text === local &&
      isReferenceIdentifier(node) &&
      !isInTypePosition(node)
    ) {
      found = true;
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(pf.sf);
  return found;
}

function referencedIdentifiers(root: ts.Node): string[] {
  const names: string[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && isReferenceIdentifier(node)) {
      names.push(node.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(root);
  return names;
}

function importDeclarationsTo(
  ctx: FixContext,
  pf: ParsedFile,
  targetRel: string,
): ts.ImportDeclaration[] {
  const declarations: ts.ImportDeclaration[] = [];

  for (const statement of pf.sf.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const target = ctx.resolve(
        pf.abs,
        statement.moduleSpecifier.text.split("?")[0],
      );

      if (target && ctx.relative(target) === targetRel) {
        declarations.push(statement);
      }
    }
  }

  return declarations;
}

/** True when `pf` still reaches `targetRel` at load time outside `handledLines`. */
function hasOtherRuntimeReferences(
  ctx: FixContext,
  pf: ParsedFile,
  targetRel: string,
  handledLines: Set<number>,
): boolean {
  for (const occurrence of extractImports(pf.sf)) {
    if (occurrenceMode(occurrence) !== "runtime") continue;

    const target = ctx.resolve(pf.abs, occurrence.specifier.split("?")[0]);
    if (
      target &&
      ctx.relative(target) === targetRel &&
      !handledLines.has(occurrence.line)
    ) {
      return true;
    }
  }

  return false;
}

function findDefiningFile(
  ctx: FixContext,
  rel: string,
  name: string,
  depth = 0,
  visited = new Set<string>(),
): string | undefined {
  const key = `${rel}\0${name}`;
  if (depth > 8 || visited.has(key)) return undefined;
  visited.add(key);

  const pf = loadParsed(ctx, rel);
  if (!pf) return undefined;

  const decls = collectTopDecls(pf);
  if (decls.some((decl) => decl.exported && decl.names.includes(name))) {
    return rel;
  }

  for (const statement of pf.sf.statements) {
    if (!ts.isExportDeclaration(statement)) continue;

    if (!statement.moduleSpecifier) {
      const clause = statement.exportClause;
      if (!clause || !ts.isNamedExports(clause)) continue;

      for (const element of clause.elements) {
        if (element.name.text !== name) continue;
        const original = element.propertyName?.text ?? element.name.text;

        if (decls.some((decl) => decl.names.includes(original))) return rel;

        const imported = collectImportLocals(pf).get(original);
        if (imported?.element && ts.isStringLiteral(imported.decl.moduleSpecifier)) {
          const target = ctx.resolve(pf.abs, imported.decl.moduleSpecifier.text);
          if (target) {
            return findDefiningFile(
              ctx,
              ctx.relative(target),
              imported.element.propertyName?.text ?? imported.element.name.text,
              depth + 1,
              visited,
            );
          }
        }
      }
      continue;
    }

    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;

    const target = ctx.resolve(pf.abs, statement.moduleSpecifier.text);
    if (!target) continue;
    const targetRel = ctx.relative(target);

    if (!statement.exportClause) {
      const found = findDefiningFile(ctx, targetRel, name, depth + 1, visited);
      if (found) return found;
    } else if (ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (element.name.text === name) {
          return findDefiningFile(
            ctx,
            targetRel,
            element.propertyName?.text ?? name,
            depth + 1,
            visited,
          );
        }
      }
    }
  }

  return undefined;
}

/* ---- Strategy 1: import type ---- */

function tryTypeOnlyFix(
  ctx: FixContext,
  _cycle: CircularDependencyCycle,
  edge: CycleEdge,
): FixAttempt {
  const pf = loadParsed(ctx, edge.from);
  if (!pf) return { reason: "" };

  const declarations = importDeclarationsTo(ctx, pf, edge.to);
  if (declarations.length === 0) return { reason: "" };

  const edits: LineEdit[] = [];
  const handledLines = new Set<number>();
  const converted: string[] = [];

  for (const decl of declarations) {
    const clause = decl.importClause;
    if (!clause) {
      return {
        reason: `${edge.from} imports ${edge.to} only for its side effects, which must stay at load time.`,
      };
    }
    if (clause.isTypeOnly) continue;
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      return {
        reason: `${edge.from} uses a namespace import of ${edge.to}, which cannot be made type-only automatically.`,
      };
    }

    const locals: string[] = [];
    if (clause.name) locals.push(clause.name.text);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (!element.isTypeOnly) locals.push(element.name.text);
      }
    }

    for (const local of locals) {
      if (hasValueUsage(pf, local, decl)) {
        return {
          reason: `"${local}" is used as a value in ${edge.from}, so that import has to stay at runtime.`,
        };
      }
    }

    const specifier = decl.moduleSpecifier.getText(pf.sf);
    const semi = decl.getText(pf.sf).trimEnd().endsWith(";") ? ";" : "";
    const named =
      clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        ? clause.namedBindings.elements.map((element) =>
            element.getText(pf.sf).replace(/^type\s+/, ""),
          )
        : [];

    const lines: string[] = [];
    if (clause.name) {
      lines.push(`import type ${clause.name.text} from ${specifier}${semi}`);
    }
    if (named.length > 0) {
      lines.push(`import type { ${named.join(", ")} } from ${specifier}${semi}`);
    }
    if (lines.length === 0) continue;

    const { start, end } = nodeLines(pf, decl);
    edits.push({ start, deleteCount: end - start + 1, insert: lines });
    handledLines.add(start);
    converted.push(...locals);
  }

  if (edits.length === 0) return { reason: "" };

  if (hasOtherRuntimeReferences(ctx, pf, edge.to, handledLines)) {
    return {
      reason: `${edge.from} also reaches ${edge.to} through another load-time import.`,
    };
  }

  const names = converted.length > 0 ? converted.join(", ") : "the imported names";
  const part = modifyChange(
    pf,
    edits,
    `Turn the import of ${names} from ${shortName(edge.to)} into \`import type\`.`,
  );

  return {
    fix: assembleFix(
      {
        strategy: "type-only-import",
        confidence: "high",
        title: "Make the import type-only",
        summary: `${shortName(edge.from)} only uses ${names} as types, so the import can be erased at compile time. That removes the load-time link ${shortName(edge.from)} → ${shortName(edge.to)} and breaks the loop without moving any code.`,
        steps: [
          `Open ${edge.from} (line ${edge.line}).`,
          `Change the import from ${shortName(edge.to)} to \`import type\` (see the diff).`,
          "Run your type-check. No runtime behavior changes.",
        ],
        caveats: [],
      },
      [part],
    ),
  };
}

/* ---- Strategy 2: skip the barrel ---- */

function tryBarrelFix(
  ctx: FixContext,
  _cycle: CircularDependencyCycle,
  edge: CycleEdge,
): FixAttempt {
  if (!isBarrelFile(edge.to) || edge.from === edge.to) return { reason: "" };

  const pf = loadParsed(ctx, edge.from);
  if (!pf) return { reason: "" };

  const declarations = importDeclarationsTo(ctx, pf, edge.to).filter(
    (decl) => !decl.importClause?.isTypeOnly,
  );
  if (declarations.length === 0) return { reason: "" };

  const edits: LineEdit[] = [];
  const handledLines = new Set<number>();
  const newTargets = new Set<string>();
  const redirected: string[] = [];

  for (const decl of declarations) {
    const clause = decl.importClause;

    if (
      !clause ||
      clause.name ||
      !clause.namedBindings ||
      !ts.isNamedImports(clause.namedBindings)
    ) {
      return {
        reason: `${edge.from} uses a default, namespace, or side-effect import of the barrel ${edge.to}, which cannot be redirected automatically.`,
      };
    }

    const groups = new Map<string, string[]>();

    for (const element of clause.namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      const definingFile = findDefiningFile(ctx, edge.to, imported);

      if (!definingFile || definingFile === edge.to || definingFile === edge.from) {
        return {
          reason: `Could not find which module defines "${imported}" behind the barrel ${edge.to}.`,
        };
      }

      const list = groups.get(definingFile) ?? [];
      list.push(element.getText(pf.sf));
      groups.set(definingFile, list);
      newTargets.add(definingFile);
      redirected.push(`${imported} → ${shortName(definingFile)}`);
    }

    const specifierNode = decl.moduleSpecifier as ts.StringLiteral;
    const quote = specifierNode.getText(pf.sf)[0];
    const jsExtension = /\.[cm]?jsx?$/.test(specifierNode.text);
    const semi = decl.getText(pf.sf).trimEnd().endsWith(";") ? ";" : "";

    const lines = [...groups].map(
      ([definingFile, specifiers]) =>
        `import { ${specifiers.join(", ")} } from ${quote}${relativeSpecifier(
          edge.from,
          definingFile,
          jsExtension,
        )}${quote}${semi}`,
    );

    const { start, end } = nodeLines(pf, decl);
    edits.push({ start, deleteCount: end - start + 1, insert: lines });
    handledLines.add(start);
  }

  if (edits.length === 0) return { reason: "" };

  if (hasOtherRuntimeReferences(ctx, pf, edge.to, handledLines)) {
    return {
      reason: `${edge.from} also reaches the barrel ${edge.to} through another load-time import.`,
    };
  }

  for (const target of newTargets) {
    if (canReach(ctx.runtimeAdjacency, target, new Set([edge.from]))) {
      return {
        reason: `${target} still leads back to ${edge.from}, so importing it directly would keep the loop.`,
      };
    }
  }

  const part = modifyChange(
    pf,
    edits,
    `Import ${redirected.join(", ")} directly instead of through ${shortName(edge.to)}.`,
  );

  return {
    fix: assembleFix(
      {
        strategy: "barrel-direct-import",
        confidence: "high",
        title: "Import from the defining module, not the barrel",
        summary: `${shortName(edge.from)} imports from the barrel ${shortName(edge.to)}, which re-exports ${shortName(edge.from)} and so closes the loop. Importing straight from the module that defines each symbol removes the link without moving any code.`,
        steps: [
          `Open ${edge.from} (line ${edge.line}).`,
          `Replace the import from ${shortName(edge.to)} with direct imports (see the diff): ${redirected.join(", ")}.`,
          "Prefer direct imports for files that live next to the barrel; keep the barrel for outside consumers.",
        ],
        caveats: [],
      },
      [part],
    ),
  };
}

/* ---- Strategy 3: extract shared declarations ---- */

function tryExtractSharedFix(
  ctx: FixContext,
  cycle: CircularDependencyCycle,
  edge: CycleEdge,
): FixAttempt {
  if (edge.from === edge.to) return { reason: "" };

  const from = loadParsed(ctx, edge.from);
  const to = loadParsed(ctx, edge.to);
  if (!from || !to) return { reason: "" };

  const importDecls = importDeclarationsTo(ctx, from, edge.to).filter(
    (decl) => !decl.importClause?.isTypeOnly,
  );
  if (importDecls.length === 0) return { reason: "" };

  const wanted = new Set<string>();
  const handledLines = new Set<number>();

  for (const decl of importDecls) {
    const clause = decl.importClause;

    if (
      !clause ||
      clause.name ||
      !clause.namedBindings ||
      !ts.isNamedImports(clause.namedBindings)
    ) {
      return {
        reason: `${edge.from} uses a default, namespace, or side-effect import of ${edge.to}, which cannot be moved automatically.`,
      };
    }

    for (const element of clause.namedBindings.elements) {
      wanted.add(element.propertyName?.text ?? element.name.text);
    }
    handledLines.add(lineAt(from, decl.getStart(from.sf)));
  }

  if (hasOtherRuntimeReferences(ctx, from, edge.to, handledLines)) {
    return {
      reason: `${edge.from} also reaches ${edge.to} through another load-time import.`,
    };
  }

  const topDecls = collectTopDecls(to);
  const byName = new Map<string, TopDecl>();
  for (const decl of topDecls) {
    for (const name of decl.names) byName.set(name, decl);
  }

  const importLocals = collectImportLocals(to);
  const moved = new Set<TopDecl>();
  const usedImports = new Set<string>();
  const queue: TopDecl[] = [];

  for (const name of wanted) {
    const decl = byName.get(name);
    if (!decl || !decl.exported || decl.isDefault) {
      return {
        reason: `"${name}" is not a plain named export declared in ${edge.to} (it may be re-exported or a default export), so it cannot be moved automatically.`,
      };
    }
    queue.push(decl);
  }

  while (queue.length > 0) {
    const decl = queue.pop()!;
    if (moved.has(decl)) continue;

    if (decl.kind === "mutable" || decl.kind === "other") {
      return {
        reason: `${decl.names.join(", ")} in ${edge.to} is a mutable or destructured variable, which is unsafe to move automatically.`,
      };
    }

    if (
      !decl.exported &&
      ts.canHaveDecorators(decl.node) &&
      (ts.getDecorators(decl.node)?.length ?? 0) > 0
    ) {
      return {
        reason: `${decl.names.join(", ")} in ${edge.to} uses decorators, which cannot be moved automatically.`,
      };
    }

    moved.add(decl);

    if (moved.size > MAX_MOVED_DECLARATIONS) {
      return {
        reason: `Extracting would move more than ${MAX_MOVED_DECLARATIONS} declarations out of ${edge.to}.`,
      };
    }

    for (const identifier of referencedIdentifiers(decl.node)) {
      const dependency = byName.get(identifier);
      if (dependency && dependency !== decl && !moved.has(dependency)) {
        queue.push(dependency);
      }
      if (importLocals.has(identifier)) usedImports.add(identifier);
    }
  }

  const movedRanges = [...moved].map((decl) => ({
    decl,
    ...nodeLines(to, decl.node, true),
  }));

  const movedLineCount = movedRanges.reduce(
    (sum, range) => sum + (range.end - range.start + 1),
    0,
  );
  if (movedLineCount > MAX_MOVED_LINES) {
    return {
      reason: `Extracting would move about ${movedLineCount} lines out of ${edge.to}.`,
    };
  }

  for (const statement of to.sf.statements) {
    if (topDecls.some((decl) => decl.node === statement && moved.has(decl))) {
      continue;
    }
    const range = nodeLines(to, statement, true);
    if (
      movedRanges.some(
        (moving) => range.start <= moving.end && range.end >= moving.start,
      )
    ) {
      return {
        reason: `A declaration to move shares a line with other code in ${edge.to}.`,
      };
    }
  }

  const neededImports = new Map<
    ts.ImportDeclaration,
    { def?: string; ns?: string; named: string[] }
  >();

  for (const [local, info] of importLocals) {
    if (!usedImports.has(local)) continue;

    const entry = neededImports.get(info.decl) ?? { named: [] };
    if (info.kind === "default") entry.def = local;
    else if (info.kind === "namespace") entry.ns = local;
    else entry.named.push(info.element!.getText(to.sf));
    neededImports.set(info.decl, entry);
  }

  for (const decl of neededImports.keys()) {
    if (decl.importClause?.isTypeOnly) continue;
    if (!ts.isStringLiteral(decl.moduleSpecifier)) continue;

    const target = ctx.resolve(to.abs, decl.moduleSpecifier.text.split("?")[0]);
    if (!target) continue;

    const targetRel = ctx.relative(target);
    if (
      canReach(
        ctx.runtimeAdjacency,
        targetRel,
        new Set([edge.from, edge.to]),
      )
    ) {
      return {
        reason: `The code to move depends on ${targetRel}, which leads back into this loop, so extracting it would recreate the cycle.`,
      };
    }
  }

  const movedNames = new Set([...moved].flatMap((decl) => decl.names));
  const usedLocally = new Set<string>();
  const remainingReferences = new Set<string>();

  for (const statement of to.sf.statements) {
    if (topDecls.some((decl) => decl.node === statement && moved.has(decl))) {
      continue;
    }
    if (ts.isImportDeclaration(statement)) continue;

    for (const identifier of referencedIdentifiers(statement)) {
      remainingReferences.add(identifier);
      if (!movedNames.has(identifier)) continue;

      if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier) {
        return {
          reason: `${edge.to} re-exports ${identifier} with a local export clause, which would conflict with the extraction.`,
        };
      }
      usedLocally.add(identifier);
    }
  }

  /* ---- Build the new shared module ---- */

  const directory = path.posix.dirname(edge.to);
  const extension = path.posix.extname(edge.to);
  const stem = path.posix.basename(edge.to, extension);
  const prefix = directory === "." ? "" : `${directory}/`;

  let sharedRel = `${prefix}${stem}.shared${extension}`;
  for (let suffix = 2; ctx.knownFiles.has(sharedRel); suffix++) {
    sharedRel = `${prefix}${stem}.shared${suffix}${extension}`;
  }

  const firstImport = to.sf.statements.find(ts.isImportDeclaration);
  const semi =
    !firstImport || firstImport.getText(to.sf).trimEnd().endsWith(";") ? ";" : "";
  const quote =
    firstImport && ts.isStringLiteral(firstImport.moduleSpecifier)
      ? firstImport.moduleSpecifier.getText(to.sf)[0]
      : '"';

  const importLines: string[] = [];
  for (const [decl, entry] of neededImports) {
    const typePrefix = decl.importClause?.isTypeOnly ? "type " : "";
    const parts: string[] = [];
    if (entry.def) parts.push(entry.def);
    if (entry.ns) parts.push(`* as ${entry.ns}`);
    else if (entry.named.length > 0) parts.push(`{ ${entry.named.join(", ")} }`);

    importLines.push(
      `import ${typePrefix}${parts.join(", ")} from ${decl.moduleSpecifier.getText(to.sf)}${semi}`,
    );
  }

  const orderedMoved = [...moved].sort(
    (a, b) => a.node.getStart(to.sf) - b.node.getStart(to.sf),
  );

  const declarationBlocks = orderedMoved.map((decl) => {
    const docStart = decl.node.getStart(to.sf, true);
    const nodeStart = decl.node.getStart(to.sf);
    const body = to.text.slice(docStart, nodeStart) +
      (decl.exported ? "" : "export ") +
      to.text.slice(nodeStart, decl.node.getEnd());
    return body.replace(/\r\n/g, "\n");
  });

  const sharedLines = [
    `// Extracted from ${shortName(edge.to)} to break an import cycle.`,
    ...importLines,
    "",
    ...declarationBlocks.join("\n\n").split("\n"),
  ];

  /* ---- Edits to the importing file ---- */

  const jsExtension = importDecls.some((decl) =>
    /\.[cm]?jsx?$/.test((decl.moduleSpecifier as ts.StringLiteral).text),
  );

  const fromEdits: LineEdit[] = importDecls.map((decl) => {
    const specifier = decl.moduleSpecifier;
    const declQuote = specifier.getText(from.sf)[0];
    const replaced =
      from.text.slice(decl.getStart(from.sf), specifier.getStart(from.sf)) +
      `${declQuote}${relativeSpecifier(edge.from, sharedRel, jsExtension)}${declQuote}` +
      from.text.slice(specifier.getEnd(), decl.getEnd());
    const { start, end } = nodeLines(from, decl);

    return {
      start,
      deleteCount: end - start + 1,
      insert: replaced.split(/\r?\n/),
    };
  });

  /* ---- Edits to the exporting file ---- */

  const sharedSpecifier = `${quote}${relativeSpecifier(edge.to, sharedRel, jsExtension)}${quote}`;
  const reexportValues = orderedMoved
    .filter((decl) => decl.exported && !decl.typeLike)
    .flatMap((decl) => decl.names);
  const reexportTypes = orderedMoved
    .filter((decl) => decl.exported && decl.typeLike)
    .flatMap((decl) => decl.names);
  const typeNames = new Set(
    orderedMoved.filter((decl) => decl.typeLike).flatMap((decl) => decl.names),
  );

  const toInsert: string[] = [];
  if (usedLocally.size > 0) {
    const items = [...usedLocally].map((name) =>
      typeNames.has(name) ? `type ${name}` : name,
    );
    toInsert.push(`import { ${items.join(", ")} } from ${sharedSpecifier}${semi}`);
  }
  if (reexportValues.length > 0) {
    toInsert.push(
      `export { ${reexportValues.join(", ")} } from ${sharedSpecifier}${semi}`,
    );
  }
  if (reexportTypes.length > 0) {
    toInsert.push(
      `export type { ${reexportTypes.join(", ")} } from ${sharedSpecifier}${semi}`,
    );
  }

  const lastImport = [...to.sf.statements].reverse().find(ts.isImportDeclaration);
  const insertAt = lastImport ? nodeLines(to, lastImport).end + 1 : 1;

  // Remove the moved declarations, plus any blank line that would otherwise be
  // left doubled up behind them.
  const removed = new Set<number>();
  const sortedRanges = [...movedRanges].sort((a, b) => a.start - b.start);

  for (const range of sortedRanges) {
    for (let line = range.start; line <= range.end; line++) removed.add(line);
  }

  for (const range of sortedRanges) {
    let probe = range.start - 1;
    while (probe >= 1 && removed.has(probe)) probe--;

    const previousKeptIsBlank =
      probe < 1 || to.lines[probe - 1].trim() === "";

    let next = range.end + 1;
    while (
      previousKeptIsBlank &&
      next <= to.lines.length &&
      !removed.has(next) &&
      to.lines[next - 1].trim() === ""
    ) {
      removed.add(next);
      next++;
    }
  }

  const toEdits: LineEdit[] = [];
  for (const line of [...removed].sort((a, b) => a - b)) {
    const last = toEdits[toEdits.length - 1];
    if (last && last.start + last.deleteCount === line) last.deleteCount++;
    else toEdits.push({ start: line, deleteCount: 1, insert: [] });
  }
  if (toInsert.length > 0) {
    toEdits.push({ start: insertAt, deleteCount: 0, insert: toInsert });
  }

  const movedLabel = orderedMoved.flatMap((decl) => decl.names).join(", ");
  const fromPart = modifyChange(
    from,
    fromEdits,
    `Import ${[...wanted].join(", ")} from ${shortName(sharedRel)} instead of ${shortName(edge.to)}.`,
  );
  const toPart = modifyChange(
    to,
    toEdits,
    `Move ${movedLabel} out and re-export it from ${shortName(sharedRel)} so existing importers keep working.`,
  );
  const sharedPart = createChange(
    sharedRel,
    sharedLines,
    `New module holding ${movedLabel}. It imports nothing from this loop.`,
    to.cr,
  );

  return {
    fix: assembleFix(
      {
        strategy: "extract-shared-module",
        confidence: "medium",
        title: "Extract the shared code into its own module",
        summary: `${shortName(edge.from)} needs ${[...wanted].join(", ")} from ${shortName(edge.to)}, while ${shortName(edge.to)} leads back to ${shortName(edge.from)}. Moving ${movedLabel} into ${shortName(sharedRel)} lets both files depend on a module that depends on neither.`,
        steps: [
          `Create ${sharedRel} with ${movedLabel} (see the diff).`,
          `In ${edge.to}, remove those declarations and re-export them from ${shortName(sharedRel)}, so other files that import them from ${shortName(edge.to)} keep working.`,
          `In ${edge.from}, import ${[...wanted].join(", ")} from ${shortName(sharedRel)}.`,
          "Run your type-check and tests. Later, point other importers at the new module and drop the re-export.",
        ],
        caveats: [
          `Generated by static analysis; run your type-check and tests after applying. The new file is named ${shortName(sharedRel)}. Rename it to something meaningful if you like.`,
          ...(() => {
            const leftover = [...usedImports].filter(
              (name) => !remainingReferences.has(name),
            );
            return leftover.length > 0
              ? [
                  `${shortName(edge.to)} no longer uses the import${leftover.length === 1 ? "" : "s"} ${leftover.join(", ")}. Remove ${leftover.length === 1 ? "it" : "them"} to keep your linter happy.`,
                ]
              : [];
          })(),
          ...(cycle.length > 2
            ? [
                `This breaks the link ${shortName(edge.from)} → ${shortName(edge.to)}. Other loops that do not use it are unaffected.`,
              ]
            : []),
        ],
      },
      [fromPart, toPart, sharedPart],
    ),
  };
}

/* ---- Strategy 4: self-import ---- */

function trySelfImportFix(ctx: FixContext, edge: CycleEdge): FixAttempt {
  const pf = loadParsed(ctx, edge.from);
  if (!pf) return { reason: "" };

  const declared = new Set(collectTopDecls(pf).flatMap((decl) => decl.names));
  const edits: LineEdit[] = [];

  for (const decl of importDeclarationsTo(ctx, pf, edge.from)) {
    const clause = decl.importClause;

    if (
      !clause ||
      clause.name ||
      !clause.namedBindings ||
      !ts.isNamedImports(clause.namedBindings) ||
      clause.namedBindings.elements.some(
        (element) => element.propertyName || !declared.has(element.name.text),
      )
    ) {
      return {
        reason: `${edge.from} imports itself in a way that cannot be removed automatically.`,
      };
    }

    const { start, end } = nodeLines(pf, decl);
    edits.push({ start, deleteCount: end - start + 1, insert: [] });
  }

  if (edits.length === 0) return { reason: "" };

  return {
    fix: assembleFix(
      {
        strategy: "remove-self-import",
        confidence: "high",
        title: "Remove the self-import",
        summary: `${shortName(edge.from)} imports names that it declares itself. The import is redundant and can be deleted.`,
        steps: [`Delete the import at line ${edge.line} of ${edge.from}.`],
        caveats: [],
      },
      [modifyChange(pf, edits, "Delete the redundant self-import.")],
    ),
  };
}

/* ---- Orchestration ---- */

function noChangeFix(cycle: CircularDependencyCycle): CycleFix {
  const lazy = cycle.kind === "lazy";

  return {
    strategy: "no-change-needed",
    confidence: "high",
    title: "No change required",
    summary: lazy
      ? "A dynamic import() already breaks this loop at load time, so the modules never evaluate each other during startup."
      : "This loop only exists in type positions and is erased by the compiler, so it has no runtime effect.",
    steps: [
      lazy
        ? "Keep the dynamic import() if it is deliberate code splitting."
        : "Optionally move the shared types into a separate types module if you want the import graph to be acyclic.",
    ],
    changes: [],
    patch: "",
    caveats: [],
  };
}

function manualFix(cycle: CircularDependencyCycle, reasons: string[]): CycleFix {
  const weakest = cycle.weakestLink;
  const edge =
    cycle.edges.find(
      (candidate) =>
        candidate.from === weakest.from && candidate.to === weakest.to,
    ) ?? cycle.edges[0];

  return {
    strategy: "manual",
    confidence: "low",
    title: "Manual refactor needed",
    summary: `No automatic fix was safe for this loop. The best place to cut is ${shortName(edge.from)} → ${shortName(edge.to)} (line ${edge.line}).`,
    steps: [
      `Open ${edge.from} at line ${edge.line}: ${edge.statement}`,
      `Move the code that ${shortName(edge.from)} needs from ${shortName(edge.to)} into a new module that imports nothing from this loop, or pass it into ${shortName(edge.from)} as a parameter or callback.`,
      "Re-run this analyzer to confirm the loop is gone.",
    ],
    changes: [],
    patch: "",
    caveats: reasons.filter(Boolean).slice(0, 4),
  };
}

function buildFix(ctx: FixContext, cycle: CircularDependencyCycle): CycleFix {
  if (cycle.kind !== "runtime") return noChangeFix(cycle);

  const reasons: string[] = [];

  if (cycle.length === 1) {
    const attempt = trySelfImportFix(ctx, cycle.edges[0]);
    if ("fix" in attempt) return attempt.fix;
    reasons.push(attempt.reason);
    return manualFix(cycle, reasons);
  }

  const edges = [...cycle.edges].sort((a, b) => edgeCost(a) - edgeCost(b));
  const strategies = [tryTypeOnlyFix, tryBarrelFix, tryExtractSharedFix];

  for (const strategy of strategies) {
    for (const edge of edges) {
      const attempt = strategy(ctx, cycle, edge);
      if ("fix" in attempt) return attempt.fix;
      if (attempt.reason && !reasons.includes(attempt.reason)) {
        reasons.push(attempt.reason);
      }
    }
  }

  return manualFix(cycle, reasons);
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

  let runtimeAdjacency = new Map<string, string[]>();

  for (const layer of LAYERS) {
    const adjacency = new Map<string, string[]>();

    for (const edge of allEdges) {
      if (!layer.include(edge.mode)) continue;
      const list = adjacency.get(edge.from);
      if (list) list.push(edge.to);
      else adjacency.set(edge.from, [edge.to]);
    }

    if (layer.kind === "runtime") runtimeAdjacency = adjacency;

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

  /* ---- Concrete fixes ---- */

  const fixContext: FixContext = {
    root,
    resolve,
    relative,
    runtimeAdjacency,
    knownFiles: new Set(discovered.sources.map(relative)),
    cache: new Map(),
  };

  let fixBudget = MAX_FIX_CYCLES;
  let skippedFixes = 0;

  for (const cycle of reported) {
    if (cycle.kind !== "runtime") {
      cycle.fix = noChangeFix(cycle);
      continue;
    }

    if (fixBudget <= 0) {
      skippedFixes++;
      continue;
    }

    fixBudget--;

    try {
      cycle.fix = buildFix(fixContext, cycle);
    } catch {
      cycle.fix = manualFix(cycle, [
        "The automatic fix generator hit an unexpected problem for this loop.",
      ]);
    }
  }

  if (skippedFixes > 0) {
    warn(
      `Ready-made fixes are generated for the ${MAX_FIX_CYCLES} highest-risk runtime cycles. Use the focus file option to get fixes for the other ${skippedFixes}.`,
    );
  }

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