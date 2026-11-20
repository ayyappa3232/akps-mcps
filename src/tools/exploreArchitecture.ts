import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveProjectPath } from "../utils/projectResolver.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

type Severity = "critical" | "high" | "medium" | "low";

type FindingRule =
  | "cycle"
  | "forbidden-dependency"
  | "layer-violation"
  | "layer-skip"
  | "hub"
  | "deep-import"
  | "isolated";

interface Example {
  from: string;
  to: string;
}

interface ModuleImport {
  module: string;
  weight: number;
}

interface ModuleInfo {
  key: string;
  label: string;
  role?: string;
  rank?: number;
  files: number;
  lines: number;
  exports: number;
  abstractExports: number;
  level: number;
  order: number;
  /** Modules that depend on this one. */
  ca: number;
  /** Modules this one depends on. */
  ce: number;
  instability: number;
  abstractness: number;
  distance: number;
  imports: ModuleImport[];
  importedBy: ModuleImport[];
  publicApi: string[];
  indexFile?: string;
  topFiles: Array<{ path: string; importedByModules: number; lines: number }>;
  flags: string[];
  inCycle: boolean;
  findingCount: number;
}

interface ModuleEdge {
  from: string;
  to: string;
  weight: number;
  typeOnly: number;
  /** Part of a dependency cycle. */
  cycle: boolean;
  /** Points from a lower layer up to a higher one. */
  violation: boolean;
  /** Goes against the flow of layers (same level or upward). */
  back: boolean;
  examples: Example[];
}

interface LayerInfo {
  level: number;
  name: string;
  modules: string[];
}

interface ArchFinding {
  id: string;
  rule: FindingRule;
  severity: Severity;
  title: string;
  message: string;
  modules: string[];
  evidence: Example[];
  suggestion: string;
}

interface DrilldownNode {
  id: string;
  label: string;
  kind: "file" | "external-up" | "external-down";
  level: number;
  order: number;
  lines: number;
  exports: number;
}

interface DrilldownEdge {
  from: string;
  to: string;
  weight: number;
  back: boolean;
}

interface Drilldown {
  module: string;
  nodes: DrilldownNode[];
  edges: DrilldownEdge[];
  hiddenFiles: number;
}

interface ArchitectureReport {
  success: boolean;
  tool: "explore_architecture";
  projectPath: string;
  granularity: { requested: string; depth: number; moduleCount: number };
  summary: {
    files: number;
    lines: number;
    modules: number;
    edges: number;
    layers: number;
    cycles: number;
    findings: Record<Severity, number>;
    healthScore: number;
    scoreBreakdown: Array<{ label: string; points: number }>;
  };
  modules: ModuleInfo[];
  edges: ModuleEdge[];
  layers: LayerInfo[];
  findings: ArchFinding[];
  matrix: { order: string[]; cells: number[][] };
  forbiddenRules: Array<{ rule: string; violations: number }>;
  drilldown?: Drilldown;
  mermaid: string;
  markdown: string;
  warnings: string[];
}

/* ---- Internal ---- */

interface FileNode {
  path: string;
  module: string;
  lines: number;
  exportsConcrete: number;
  exportsAbstract: number;
  exportNames: string[];
  imports: Array<{ spec: string; typeOnly: boolean }>;
  isIndex: boolean;
}

interface PathPattern {
  prefix: string;
  suffix: string;
  wildcard: boolean;
  targets: string[];
}

interface PathConfig {
  dir: string;
  baseUrl?: string;
  paths: PathPattern[];
}

interface ForbiddenRule {
  text: string;
  from: string;
  to: string;
}

interface FileEdge {
  from: string;
  to: string;
  typeOnly: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "out",
  "storybook-static",
  "playwright-report",
  "test-results",
  "generated-diagrams",
  "vendor",
]);

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

const TEST_NAME_PATTERN = /\.(test|spec|cy|e2e)\.[cm]?[jt]sx?$/;
const TEST_DIR_PATTERN = /(^|\/)(__tests__|e2e|cypress|playwright)\//;

const ROLE_RULES: Array<[RegExp, string, number]> = [
  [/(^|\/)(components?|ui|pages?|views?|screens?|layouts?)(\/|$)/, "Presentation", 0],
  [/(^|\/)(routes?|api|controllers?|handlers?|endpoints?|middleware|hooks?)(\/|$)/, "API and entry", 1],
  [/(^|\/)(services?|features?|modules?|tools?|usecases?|domain|auth)(\/|$)/, "Application logic", 2],
  [/(^|\/)(models?|entities|schemas?|db|database|repositor(y|ies)|store|state|prisma)(\/|$)/, "Data", 3],
  [/(^|\/)(utils?|helpers?|lib|common|shared|types?|typings|config|constants)(\/|$)/, "Shared foundation", 4],
];

const MAX_FILES = 6_000;
const MAX_PARSE_BYTES = 400_000;
const MAX_MODULES = 40;
const MAX_EDGES = 400;
const MAX_FINDINGS = 80;
const MAX_EXAMPLES = 5;
const MAX_DRILLDOWN_FILES = 60;
const MAX_DRILLDOWN_EXTERNAL = 8;
const MAX_WARNINGS = 25;
const MAX_MERMAID_EDGES = 60;
const MAX_RULES = 20;

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function severityRank(severity: Severity): number {
  return ["critical", "high", "medium", "low"].indexOf(severity);
}

function scriptKindFor(file: string): ts.ScriptKind {
  const extension = path.posix.extname(file);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
    : false;
}

function parseRules(entries: string[] | undefined): ForbiddenRule[] {
  const rules: ForbiddenRule[] = [];

  for (const raw of entries ?? []) {
    const text = raw.trim();
    if (!text) continue;

    const match = /^(.+?)\s*(?:->|→|=>)\s*(.+)$/.exec(text);
    if (!match) {
      throw new Error(`Rule "${text}" must look like "src/ui -> src/db".`);
    }

    const from = normalizePath(match[1].trim()).replace(/\/+$/, "");
    const to = normalizePath(match[2].trim()).replace(/\/+$/, "");

    for (const side of [from, to]) {
      if (!side || path.isAbsolute(side) || side.split("/").includes("..")) {
        throw new Error(`Rule "${text}" must use relative folders inside the project.`);
      }
    }

    rules.push({ text: `${from} -> ${to}`, from, to });
  }

  if (rules.length > MAX_RULES) {
    throw new Error(`Use at most ${MAX_RULES} forbidden-dependency rules.`);
  }

  return rules;
}

function underPrefix(file: string, prefix: string): boolean {
  return file === prefix || file.startsWith(`${prefix}/`);
}

/* -------------------------------------------------------------------------- */
/*  Reading the project                                                       */
/* -------------------------------------------------------------------------- */

interface Discovered {
  codeFiles: string[];
  packageDirs: string[];
  tsconfigs: string[];
  truncated: boolean;
}

function discoverProject(root: string): Discovered {
  const codeFiles: string[] = [];
  const packageDirs: string[] = [];
  const tsconfigs: string[] = [];
  let truncated = false;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

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
      const absolute = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !IGNORED_DIRS.has(entry.name)) {
          stack.push({ dir: absolute, depth: depth + 1 });
        }
        continue;
      }

      if (!entry.isFile()) continue;

      const rel = normalizePath(path.relative(root, absolute));

      if (entry.name === "package.json" && depth >= 1 && depth <= 3) {
        packageDirs.push(normalizePath(path.dirname(rel)));
      }
      if (entry.name === "tsconfig.json" || entry.name === "jsconfig.json") tsconfigs.push(rel);

      const extension = path.posix.extname(entry.name).toLowerCase();
      if (!CODE_EXTENSIONS.has(extension) || entry.name.endsWith(".d.ts")) continue;

      if (codeFiles.length >= MAX_FILES) {
        truncated = true;
        continue;
      }

      codeFiles.push(rel);
    }
  }

  codeFiles.sort();
  packageDirs.sort((a, b) => b.length - a.length);
  return { codeFiles, packageDirs, tsconfigs, truncated };
}

/** Maps a file to a module: its package, then `src`, then `depth` folders. */
function moduleOf(file: string, depth: number, packageDirs: string[]): string {
  const directories = file.split("/").slice(0, -1);
  const pkg = packageDirs.find((dir) => file.startsWith(`${dir}/`));

  let base: string[] = [];
  let rest = directories;

  if (pkg) {
    base = pkg.split("/");
    rest = directories.slice(base.length);
  }

  if (rest[0] === "src") {
    base = [...base, "src"];
    rest = rest.slice(1);
  }

  const parts = [...base, ...rest.slice(0, depth)];
  return parts.length > 0 ? parts.join("/") : "(root)";
}

function parseFile(rel: string, text: string): Omit<FileNode, "module"> {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKindFor(rel));
  const imports: FileNode["imports"] = [];
  const exportNames: string[] = [];
  let exportsConcrete = 0;
  let exportsAbstract = 0;

  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      const allTypes =
        Boolean(clause?.isTypeOnly) ||
        Boolean(
          clause?.namedBindings &&
            ts.isNamedImports(clause.namedBindings) &&
            !clause.name &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((element) => element.isTypeOnly),
        );
      imports.push({ spec: statement.moduleSpecifier.text, typeOnly: allTypes });
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      imports.push({ spec: statement.moduleSpecifier.text, typeOnly: Boolean(statement.isTypeOnly) });

      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          exportNames.push(element.name.text);
          exportsConcrete++;
        }
      }
    }

    if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);

      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
        exportNames.push(statement.name.text);
        exportsAbstract++;
      } else if (ts.isClassDeclaration(statement)) {
        exportNames.push(isDefault ? "default" : (statement.name?.text ?? "default"));
        if (hasModifier(statement, ts.SyntaxKind.AbstractKeyword)) exportsAbstract++;
        else exportsConcrete++;
      } else if (ts.isFunctionDeclaration(statement) || ts.isEnumDeclaration(statement)) {
        exportNames.push(isDefault ? "default" : (statement.name?.text ?? "default"));
        exportsConcrete++;
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            exportNames.push(declaration.name.text);
            exportsConcrete++;
          }
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      exportNames.push("default");
      exportsConcrete++;
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        exportNames.push(element.name.text);
        exportsConcrete++;
      }
    }
  }

  // require() and import() count as dependencies too.
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const [first] = node.arguments;
      if (first && ts.isStringLiteral(first)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          imports.push({ spec: first.text, typeOnly: false });
        } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
          imports.push({ spec: first.text, typeOnly: false });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return {
    path: rel,
    lines: text.split("\n").length,
    exportsConcrete,
    exportsAbstract,
    exportNames: [...new Set(exportNames)],
    imports,
    isIndex: /^index\.[cm]?[jt]sx?$/.test(path.posix.basename(rel)),
  };
}

/* -------------------------------------------------------------------------- */
/*  Import resolution                                                         */
/* -------------------------------------------------------------------------- */

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const parsed = ts.readConfigFile(file, ts.sys.readFile);
    if (parsed.error || typeof parsed.config !== "object") return undefined;
    return parsed.config as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function loadPathConfigs(root: string, tsconfigs: string[]): Map<string, PathConfig> {
  const configs = new Map<string, PathConfig>();

  for (const rel of tsconfigs) {
    const absolute = path.join(root, rel);
    const seen = new Set<string>();
    let current: string | undefined = absolute;
    let baseUrl: string | undefined;
    let paths: Record<string, string[]> | undefined;
    let baseUrlDir = path.dirname(absolute);
    let pathsDir = path.dirname(absolute);

    for (let depth = 0; current && depth < 4 && !seen.has(current); depth++) {
      seen.add(current);
      const json = readJson(current);
      if (!json) break;

      const options = (json.compilerOptions ?? {}) as { baseUrl?: string; paths?: Record<string, string[]> };

      if (baseUrl === undefined && typeof options.baseUrl === "string") {
        baseUrl = options.baseUrl;
        baseUrlDir = path.dirname(current);
      }
      if (paths === undefined && options.paths) {
        paths = options.paths;
        pathsDir = path.dirname(current);
      }

      const parent: unknown = json.extends;
      if (typeof parent === "string" && parent.startsWith(".")) {
        const next = path.resolve(path.dirname(current), parent);
        current = fs.existsSync(next) ? next : fs.existsSync(`${next}.json`) ? `${next}.json` : undefined;
      } else {
        current = undefined;
      }
    }

    const dir = normalizePath(path.dirname(rel));
    const toRoot = (from: string, target: string) => normalizePath(path.relative(root, path.resolve(from, target)));

    const patterns: PathPattern[] = [];
    for (const [key, targets] of Object.entries(paths ?? {})) {
      const star = key.indexOf("*");
      patterns.push({
        prefix: star === -1 ? key : key.slice(0, star),
        suffix: star === -1 ? "" : key.slice(star + 1),
        wildcard: star !== -1,
        targets: targets.map((value) =>
          baseUrl !== undefined ? toRoot(baseUrlDir, path.join(baseUrl, value)) : toRoot(pathsDir, value),
        ),
      });
    }

    configs.set(dir === "." ? "" : dir, {
      dir: dir === "." ? "" : dir,
      baseUrl: baseUrl !== undefined ? toRoot(baseUrlDir, baseUrl) : undefined,
      paths: patterns,
    });
  }

  return configs;
}

function createResolver(fileSet: Set<string>, configs: Map<string, PathConfig>) {
  const tryFile = (base: string): string | undefined => {
    const stripped = base.replace(/\.[cm]?jsx?$/, "");
    const options = [
      base,
      ...RESOLVE_EXTENSIONS.map((extension) => `${stripped}${extension}`),
      ...RESOLVE_EXTENSIONS.map((extension) => `${base}${extension}`),
      ...RESOLVE_EXTENSIONS.map((extension) => `${base}/index${extension}`),
    ];
    return options.find((option) => fileSet.has(option));
  };

  const nearestConfig = (fromRel: string): PathConfig | undefined => {
    let dir = path.posix.dirname(fromRel);
    for (;;) {
      const key = dir === "." ? "" : dir;
      const found = configs.get(key);
      if (found) return found;
      if (!key) return undefined;
      dir = path.posix.dirname(dir);
    }
  };

  return (fromRel: string, spec: string): string | undefined => {
    if (spec.startsWith(".")) {
      return tryFile(path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec)));
    }

    const config = nearestConfig(fromRel);

    if (config) {
      for (const pattern of config.paths) {
        const matches = pattern.wildcard
          ? spec.startsWith(pattern.prefix) &&
            spec.endsWith(pattern.suffix) &&
            spec.length >= pattern.prefix.length + pattern.suffix.length
          : spec === pattern.prefix;

        if (!matches) continue;

        const captured = pattern.wildcard
          ? spec.slice(pattern.prefix.length, spec.length - pattern.suffix.length)
          : "";

        for (const target of pattern.targets) {
          const resolved = tryFile(normalizePath(path.posix.normalize(target.replace("*", captured))));
          if (resolved) return resolved;
        }
      }

      if (config.baseUrl !== undefined) {
        const resolved = tryFile(path.posix.normalize(path.posix.join(config.baseUrl || ".", spec)));
        if (resolved) return resolved;
      }
    }

    if (spec.startsWith("@/") || spec.startsWith("~/")) {
      for (const base of new Set(["src", config?.dir ? path.posix.join(config.dir, "src") : "src"])) {
        const resolved = tryFile(path.posix.normalize(path.posix.join(base, spec.slice(2))));
        if (resolved) return resolved;
      }
    }

    return undefined;
  };
}

/* -------------------------------------------------------------------------- */
/*  Graph algorithms                                                          */
/* -------------------------------------------------------------------------- */

function stronglyConnected(nodes: string[], adjacency: Map<string, string[]>): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  const connect = (node: string) => {
    index.set(node, counter);
    lowlink.set(node, counter);
    counter++;
    stack.push(node);
    onStack.add(node);

    for (const next of adjacency.get(node) ?? []) {
      if (!index.has(next)) {
        connect(next);
        lowlink.set(node, Math.min(lowlink.get(node)!, lowlink.get(next)!));
      } else if (onStack.has(next)) {
        lowlink.set(node, Math.min(lowlink.get(node)!, index.get(next)!));
      }
    }

    if (lowlink.get(node) === index.get(node)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      components.push(component.sort());
    }
  };

  for (const node of nodes) if (!index.has(node)) connect(node);
  return components;
}

interface LevelResult {
  level: Map<string, number>;
  component: Map<string, number>;
  cycles: string[][];
}

/**
 * Layers come from the graph itself: cycles collapse into one node, and each
 * node sits one level below the deepest thing that depends on it.
 */
function computeLevels(nodes: string[], edges: Array<[string, string]>): LevelResult {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node, []);
  for (const [from, to] of edges) adjacency.get(from)?.push(to);
  for (const list of adjacency.values()) list.sort();

  const components = stronglyConnected([...nodes].sort(), adjacency);
  const component = new Map<string, number>();
  components.forEach((members, id) => members.forEach((member) => component.set(member, id)));

  const outgoing = new Map<number, Set<number>>();
  const incomingCount = new Map<number, number>();
  components.forEach((_, id) => {
    outgoing.set(id, new Set());
    incomingCount.set(id, 0);
  });

  for (const [from, to] of edges) {
    const a = component.get(from);
    const b = component.get(to);
    if (a === undefined || b === undefined || a === b) continue;
    if (!outgoing.get(a)!.has(b)) {
      outgoing.get(a)!.add(b);
      incomingCount.set(b, (incomingCount.get(b) ?? 0) + 1);
    }
  }

  const componentLevel = new Map<number, number>();
  const queue: number[] = [];
  components.forEach((_, id) => {
    if ((incomingCount.get(id) ?? 0) === 0) {
      componentLevel.set(id, 0);
      queue.push(id);
    }
  });

  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    for (const next of [...(outgoing.get(id) ?? [])].sort((a, b) => a - b)) {
      componentLevel.set(next, Math.max(componentLevel.get(next) ?? 0, (componentLevel.get(id) ?? 0) + 1));
      incomingCount.set(next, (incomingCount.get(next) ?? 0) - 1);
      if ((incomingCount.get(next) ?? 0) === 0) queue.push(next);
    }
  }

  const level = new Map<string, number>();
  for (const node of nodes) level.set(node, componentLevel.get(component.get(node)!) ?? 0);

  return { level, component, cycles: components.filter((members) => members.length > 1) };
}

/** Orders nodes within each level to reduce crossing lines (barycenter heuristic). */
function orderLevels(
  nodes: string[],
  level: Map<string, number>,
  edges: Array<[string, string]>,
  tieBreak: (node: string) => number = () => 0,
): Map<string, number> {
  const neighbours = new Map<string, Set<string>>();
  for (const node of nodes) neighbours.set(node, new Set());
  for (const [from, to] of edges) {
    neighbours.get(from)?.add(to);
    neighbours.get(to)?.add(from);
  }

  const maxLevel = Math.max(0, ...level.values());
  const rows: string[][] = Array.from({ length: maxLevel + 1 }, () => []);
  for (const node of [...nodes].sort((a, b) => tieBreak(b) - tieBreak(a) || a.localeCompare(b))) {
    rows[level.get(node) ?? 0].push(node);
  }

  const position = new Map<string, number>();
  const refresh = () => rows.forEach((row) => row.forEach((node, index) => position.set(node, index)));
  refresh();

  const sweep = (rowIndex: number, reference: number) => {
    const row = rows[rowIndex];
    const scored = row.map((node, index) => {
      const near = [...(neighbours.get(node) ?? [])].filter((other) => level.get(other) === reference);
      const average = near.length > 0 ? near.reduce((sum, other) => sum + (position.get(other) ?? 0), 0) / near.length : index;
      return { node, average, index };
    });
    scored.sort((a, b) => a.average - b.average || a.index - b.index);
    rows[rowIndex] = scored.map((item) => item.node);
    refresh();
  };

  for (let iteration = 0; iteration < 4; iteration++) {
    for (let row = 1; row <= maxLevel; row++) sweep(row, row - 1);
    for (let row = maxLevel - 1; row >= 0; row--) sweep(row, row + 1);
  }

  const order = new Map<string, number>();
  rows.forEach((row) => row.forEach((node, index) => order.set(node, index)));
  return order;
}

/* -------------------------------------------------------------------------- */
/*  Choosing the module size                                                  */
/* -------------------------------------------------------------------------- */

function moduleSizesAt(files: string[], depth: number, packageDirs: string[]): number[] {
  const sizes = new Map<string, number>();
  for (const file of files) {
    const key = moduleOf(file, depth, packageDirs);
    sizes.set(key, (sizes.get(key) ?? 0) + 1);
  }
  return [...sizes.values()];
}

/**
 * Picks the shallowest module size that gives a readable, balanced map: enough
 * modules, but no single one holding most of the code.
 */
function chooseDepth(files: string[], packageDirs: string[]): number {
  const options = [1, 2, 3, 4].map((depth) => {
    const sizes = moduleSizesAt(files, depth, packageDirs);
    return {
      depth,
      count: sizes.length,
      largestShare: Math.max(...sizes) / Math.max(1, files.length),
    };
  });

  const maxShare = files.length < 15 ? 0.6 : 0.35;
  const balanced = options.find(
    (item) => item.count >= 6 && item.count <= 30 && item.largestShare <= maxShare,
  );
  if (balanced) return balanced.depth;

  const fitting = options.filter((item) => item.count <= 30);
  if (fitting.length === 0) return 1;

  // Nothing is perfectly balanced: take the most detailed map that still fits.
  return fitting.sort((a, b) => b.count - a.count || a.depth - b.depth)[0].depth;
}

/* -------------------------------------------------------------------------- */
/*  Building the architecture                                                 */
/* -------------------------------------------------------------------------- */

interface Built {
  modules: ModuleInfo[];
  edges: ModuleEdge[];
  layers: LayerInfo[];
  findings: ArchFinding[];
  forbiddenRules: Array<{ rule: string; violations: number }>;
  cycles: string[][];
  moduleCount: number;
  internalImports: number;
}

function stdDev(values: number[]): { mean: number; deviation: number } {
  if (values.length === 0) return { mean: 0, deviation: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { mean, deviation: Math.sqrt(variance) };
}

function buildArchitecture(
  files: FileNode[],
  fileEdges: FileEdge[],
  rules: ForbiddenRule[],
  warn: (message: string) => void,
): Built {
  const byPath = new Map(files.map((file) => [file.path, file]));

  // Fold rarely used modules together if there would be too many to read.
  const sizes = new Map<string, number>();
  for (const file of files) sizes.set(file.module, (sizes.get(file.module) ?? 0) + 1);

  if (sizes.size > MAX_MODULES) {
    const keep = new Set(
      [...sizes.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, MAX_MODULES - 1)
        .map(([key]) => key),
    );
    for (const file of files) if (!keep.has(file.module)) file.module = "(other)";
    warn(`There are more than ${MAX_MODULES} modules, so the smallest were grouped as "(other)". Use a coarser module size for a clearer map.`);
  }

  const moduleKeys = [...new Set(files.map((file) => file.module))].sort();
  const filesOf = new Map<string, FileNode[]>();
  for (const key of moduleKeys) filesOf.set(key, []);
  for (const file of files) filesOf.get(file.module)!.push(file);

  /* ---- Module edges ---- */

  interface EdgeAcc {
    weight: number;
    typeOnly: number;
    examples: Example[];
  }

  const edgeMap = new Map<string, EdgeAcc>();
  const indexOf = new Map<string, FileNode | undefined>();
  for (const key of moduleKeys) {
    const dir = key === "(root)" || key === "(other)" ? "" : key;
    indexOf.set(key, filesOf.get(key)!.find((file) => file.isIndex && path.posix.dirname(file.path) === (dir || ".")));
  }

  const deepImports = new Map<string, Example[]>();
  const importedFromModules = new Map<string, Map<string, number>>();
  let internalImports = 0;
  const ruleHits = new Map<string, { count: number; examples: Example[]; modules: Set<string> }>();

  for (const edge of fileEdges) {
    const from = byPath.get(edge.from);
    const to = byPath.get(edge.to);
    if (!from || !to) continue;

    for (const rule of rules) {
      if (underPrefix(edge.from, rule.from) && underPrefix(edge.to, rule.to)) {
        const hit = ruleHits.get(rule.text) ?? { count: 0, examples: [], modules: new Set<string>() };
        hit.count++;
        if (hit.examples.length < MAX_EXAMPLES) hit.examples.push({ from: edge.from, to: edge.to });
        hit.modules.add(from.module);
        hit.modules.add(to.module);
        ruleHits.set(rule.text, hit);
      }
    }

    if (from.module === to.module) {
      internalImports++;
      continue;
    }

    const key = `${from.module}\0${to.module}`;
    const acc = edgeMap.get(key) ?? { weight: 0, typeOnly: 0, examples: [] };
    acc.weight++;
    if (edge.typeOnly) acc.typeOnly++;
    if (acc.examples.length < MAX_EXAMPLES) acc.examples.push({ from: edge.from, to: edge.to });
    edgeMap.set(key, acc);

    const sources = importedFromModules.get(`${to.path}`) ?? new Map<string, number>();
    sources.set(from.module, (sources.get(from.module) ?? 0) + 1);
    importedFromModules.set(to.path, sources);

    const index = indexOf.get(to.module);
    if (index && !to.isIndex) {
      const list = deepImports.get(to.module) ?? [];
      list.push({ from: edge.from, to: edge.to });
      deepImports.set(to.module, list);
    }
  }

  const rawEdges = [...edgeMap.entries()].map(([key, acc]) => {
    const [from, to] = key.split("\0");
    return { from, to, ...acc };
  });

  /* ---- Layers ---- */

  const pairs = rawEdges.map((edge) => [edge.from, edge.to] as [string, string]);
  const { level, component, cycles } = computeLevels(moduleKeys, pairs);
  const importerCount = new Map<string, number>();
  for (const edge of rawEdges) importerCount.set(edge.to, (importerCount.get(edge.to) ?? 0) + edge.weight);
  const order = orderLevels(moduleKeys, level, pairs, (node) => importerCount.get(node) ?? 0);

  /* ---- Roles ---- */

  const roles = new Map<string, { role?: string; rank?: number }>();
  for (const key of moduleKeys) {
    const group = filesOf.get(key)!;
    const reactShare = group.filter((file) => /\.(tsx|jsx)$/.test(file.path)).length / Math.max(1, group.length);
    let found: { role?: string; rank?: number } = {};

    for (const segment of key.toLowerCase().split("/").reverse()) {
      const rule = ROLE_RULES.find(([pattern]) => pattern.test(segment));
      if (rule) {
        found = { role: rule[1], rank: rule[2] };
        break;
      }
    }

    if (reactShare >= 0.6 && found.rank !== 1) found = { role: "Presentation", rank: 0 };
    roles.set(key, found);
  }

  /* ---- Edges with their flags ---- */

  const cycleOf = (key: string) => component.get(key);
  const cycleComponents = new Set(cycles.map((members) => component.get(members[0])));

  const edges: ModuleEdge[] = rawEdges
    .map((edge) => {
      const sameCycle = cycleOf(edge.from) === cycleOf(edge.to) && cycleComponents.has(cycleOf(edge.from));
      const fromRank = roles.get(edge.from)?.rank;
      const toRank = roles.get(edge.to)?.rank;

      return {
        from: edge.from,
        to: edge.to,
        weight: edge.weight,
        typeOnly: edge.typeOnly,
        cycle: sameCycle,
        violation: fromRank !== undefined && toRank !== undefined && fromRank > toRank,
        back: (level.get(edge.from) ?? 0) >= (level.get(edge.to) ?? 0),
        examples: edge.examples,
      };
    })
    .sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  /* ---- Modules ---- */

  const importsOf = new Map<string, ModuleImport[]>();
  const importedByOf = new Map<string, ModuleImport[]>();
  for (const key of moduleKeys) {
    importsOf.set(key, []);
    importedByOf.set(key, []);
  }
  for (const edge of edges) {
    importsOf.get(edge.from)!.push({ module: edge.to, weight: edge.weight });
    importedByOf.get(edge.to)!.push({ module: edge.from, weight: edge.weight });
  }

  const modules: ModuleInfo[] = moduleKeys.map((key) => {
    const group = filesOf.get(key)!;
    const imports = importsOf.get(key)!.sort((a, b) => b.weight - a.weight || a.module.localeCompare(b.module));
    const importedBy = importedByOf.get(key)!.sort((a, b) => b.weight - a.weight || a.module.localeCompare(b.module));
    const ca = importedBy.length;
    const ce = imports.length;
    const concrete = group.reduce((sum, file) => sum + file.exportsConcrete, 0);
    const abstract = group.reduce((sum, file) => sum + file.exportsAbstract, 0);
    const exportsTotal = concrete + abstract;
    const instability = ca + ce === 0 ? 0 : ce / (ca + ce);
    const abstractness = exportsTotal === 0 ? 0 : abstract / exportsTotal;
    const index = indexOf.get(key);

    const topFiles = group
      .map((file) => ({
        path: file.path,
        importedByModules: importedFromModules.get(file.path)?.size ?? 0,
        lines: file.lines,
      }))
      .sort((a, b) => b.importedByModules - a.importedByModules || b.lines - a.lines || a.path.localeCompare(b.path))
      .slice(0, 4);

    const publicApi = (index ? index.exportNames : group.flatMap((file) => file.exportNames))
      .filter((name, position, list) => list.indexOf(name) === position)
      .slice(0, 12);

    return {
      key,
      label: key,
      role: roles.get(key)?.role,
      rank: roles.get(key)?.rank,
      files: group.length,
      lines: group.reduce((sum, file) => sum + file.lines, 0),
      exports: exportsTotal,
      abstractExports: abstract,
      level: level.get(key) ?? 0,
      order: order.get(key) ?? 0,
      ca,
      ce,
      instability: Math.round(instability * 100) / 100,
      abstractness: Math.round(abstractness * 100) / 100,
      distance: Math.round(Math.abs(abstractness + instability - 1) * 100) / 100,
      imports,
      importedBy,
      publicApi,
      indexFile: index?.path,
      topFiles,
      flags: [],
      inCycle: cycleComponents.has(cycleOf(key)),
      findingCount: 0,
    };
  });

  const byKey = new Map(modules.map((module) => [module.key, module]));

  /* ---- Findings ---- */

  const findings: ArchFinding[] = [];
  const addFinding = (finding: Omit<ArchFinding, "id">) => {
    findings.push({
      id: createHash("sha1")
        .update(`${finding.rule}|${finding.modules.join(",")}|${finding.title}`)
        .digest("hex")
        .slice(0, 10),
      ...finding,
    });
  };

  // Cycles
  for (const members of cycles) {
    const inside = edges.filter((edge) => members.includes(edge.from) && members.includes(edge.to));
    const total = inside.reduce((sum, edge) => sum + edge.weight, 0);
    const weakest = [...inside].sort((a, b) => a.weight - b.weight || a.from.localeCompare(b.from))[0];

    const typesOnly = inside.length > 0 && inside.every((edge) => edge.typeOnly === edge.weight);

    addFinding({
      rule: "cycle",
      severity: typesOnly ? "low" : members.length >= 3 || total >= 10 ? "high" : "medium",
      title: `Dependency cycle between ${members.length} modules`,
      message: `${members.join(", ")} depend on each other, so none of them can be understood, tested or changed on its own. The ${plural(inside.length, "dependency", "dependencies")} in the loop carry ${plural(total, "import")}.${typesOnly ? " Every import in the loop is type-only, so nothing breaks at runtime, but the modules are still tied together." : ""}`,
      modules: members,
      evidence: weakest ? weakest.examples : [],
      suggestion: weakest
        ? `Break the loop at its weakest link: ${weakest.from} → ${weakest.to} has only ${plural(weakest.weight, "import")}. Move the shared code into a lower-level module, or pass the dependency in (a callback or an interface) instead of importing it.`
        : "Move the shared code into a lower-level module both sides can import.",
    });
  }

  // Layer problems from roles
  const violations = edges.filter((edge) => edge.violation).slice(0, 20);
  for (const edge of violations) {
    const from = byKey.get(edge.from)!;
    const to = byKey.get(edge.to)!;

    const typesOnly = edge.weight > 0 && edge.typeOnly === edge.weight;
    const wide = (from.rank ?? 0) - (to.rank ?? 0) >= 2;

    addFinding({
      rule: "layer-violation",
      severity: typesOnly ? (wide ? "medium" : "low") : wide ? "high" : "medium",
      title: `${edge.from} depends on ${edge.to}`,
      message: `${from.role} code (${edge.from}) imports ${to.role} code (${edge.to}), which sits in a higher layer. Foundations should not know about the things built on top of them.${typesOnly ? " Only types are imported, so the runtime is unaffected." : ""}`,
      modules: [edge.from, edge.to],
      evidence: edge.examples,
      suggestion:
        "Move what is shared down into the foundation module, or invert the dependency: let the higher layer pass in what the foundation needs.",
    });
  }

  for (const edge of edges.filter((item) => !item.violation).slice(0, 400)) {
    const from = byKey.get(edge.from)!;
    const to = byKey.get(edge.to)!;

    if (from.rank === 0 && to.rank !== undefined && to.rank >= 3) {
      addFinding({
        rule: "layer-skip",
        severity: "low",
        title: `${edge.from} reaches straight into ${edge.to}`,
        message: `${from.role} code talks to ${to.role} code directly, skipping the layers between them.`,
        modules: [edge.from, edge.to],
        evidence: edge.examples,
        suggestion: "Go through a service or API module so the UI does not depend on how data is stored.",
      });
    }
  }

  // Forbidden dependencies
  const forbiddenRules = rules.map((rule) => ({ rule: rule.text, violations: ruleHits.get(rule.text)?.count ?? 0 }));
  for (const rule of rules) {
    const hit = ruleHits.get(rule.text);
    if (!hit) continue;

    addFinding({
      rule: "forbidden-dependency",
      severity: "high",
      title: `Forbidden dependency: ${rule.text}`,
      message: `${plural(hit.count, "import")} break your rule that ${rule.from} must not depend on ${rule.to}.`,
      modules: [...hit.modules].sort(),
      evidence: hit.examples,
      suggestion: "Remove these imports, or route the call through an allowed module. If the rule is out of date, update it.",
    });
  }

  // Hubs
  const totals = modules.map((module) => module.ca + module.ce);
  const { mean, deviation } = stdDev(totals);
  const hubLimit = Math.max(6, mean + 1.5 * deviation);

  if (modules.length >= 5) {
    for (const module of modules) {
      if (module.ca + module.ce >= hubLimit) {
        module.flags.push("hub");
        addFinding({
          rule: "hub",
          severity: "medium",
          title: `${module.key} is a hub`,
          message: `${plural(module.ca, "module")} depend on it and it depends on ${plural(module.ce, "other module")}. A module that is connected to this much usually does too many things, and a change here ripples widely.`,
          modules: [module.key],
          evidence: [],
          suggestion: "Split it by responsibility so each part has fewer dependents, and keep only stable, general code at the center.",
        });
      }
    }
  }

  // Deep imports
  for (const [key, list] of deepImports) {
    if (list.length < 2) continue;
    const module = byKey.get(key)!;

    addFinding({
      rule: "deep-import",
      severity: "low",
      title: `${plural(list.length, "import")} bypass the public API of ${key}`,
      message: `${key} has an ${path.posix.basename(module.indexFile ?? "index")}, yet other modules import its internal files directly. That makes its inside part of its contract.`,
      modules: [key, ...new Set(list.map((item) => byPath.get(item.from)?.module ?? ""))].filter(Boolean),
      evidence: list.slice(0, MAX_EXAMPLES),
      suggestion: `Import from ${module.indexFile ?? `${key}/index`} instead, and export from there only what other modules should use.`,
    });
  }

  // Isolated modules
  if (modules.length >= 4) {
    for (const module of modules) {
      if (module.ca === 0 && module.ce === 0) {
        module.flags.push("isolated");
        addFinding({
          rule: "isolated",
          severity: "low",
          title: `${module.key} is isolated`,
          message: "No other module imports it and it imports nothing. It may be dead code, a standalone script, or an entry point the analysis cannot see.",
          modules: [module.key],
          evidence: [],
          suggestion: "Confirm it is used. If not, remove it; if it is an entry point, document it.",
        });
      }
    }
  }

  for (const module of modules) {
    if (module.inCycle) module.flags.push("cycle");
    if (module.instability < 0.3 && module.abstractness < 0.3 && module.ca >= 3 && module.files >= 3) {
      module.flags.push("stable-concrete");
    }
  }

  findings.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      a.rule.localeCompare(b.rule) ||
      a.title.localeCompare(b.title),
  );
  if (findings.length > MAX_FINDINGS) findings.length = MAX_FINDINGS;

  for (const finding of findings) {
    for (const key of finding.modules) {
      const module = byKey.get(key);
      if (module) module.findingCount++;
    }
  }

  /* ---- Layer names ---- */

  const maxLevel = Math.max(0, ...modules.map((module) => module.level));
  const layers: LayerInfo[] = [];

  for (let current = 0; current <= maxLevel; current++) {
    const members = modules
      .filter((module) => module.level === current)
      .sort((a, b) => a.order - b.order)
      .map((module) => module.key);
    if (members.length === 0) continue;

    const tally = new Map<string, number>();
    for (const key of members) {
      const role = byKey.get(key)?.role;
      if (role) tally.set(role, (tally.get(role) ?? 0) + 1);
    }
    // Name the layer after a role only when that role really describes most of it.
    const [topRole, topCount] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
    const top = topCount * 2 > members.length ? topRole : undefined;

    layers.push({
      level: current,
      name: `Layer ${current + 1}${current === 0 ? " (top)" : current === maxLevel && maxLevel > 0 ? " (foundation)" : ""}${top ? ` · ${top}` : ""}`,
      modules: members,
    });
  }

  return {
    modules: modules.sort((a, b) => a.level - b.level || a.order - b.order),
    edges: edges.slice(0, MAX_EDGES),
    layers,
    findings,
    forbiddenRules,
    cycles,
    moduleCount: modules.length,
    internalImports,
  };
}

/* -------------------------------------------------------------------------- */
/*  Drill-down: the files inside one module                                   */
/* -------------------------------------------------------------------------- */

function buildDrilldown(moduleKey: string, files: FileNode[], fileEdges: FileEdge[]): Drilldown | undefined {
  const inside = files.filter((file) => file.module === moduleKey);
  if (inside.length === 0) return undefined;

  const byPath = new Map(files.map((file) => [file.path, file]));
  const insideSet = new Set(inside.map((file) => file.path));

  const degree = new Map<string, number>();
  const internal: FileEdge[] = [];
  const up = new Map<string, number>();
  const down = new Map<string, number>();
  const upLinks: Array<{ from: string; file: string }> = [];
  const downLinks: Array<{ file: string; to: string }> = [];

  for (const edge of fileEdges) {
    const fromInside = insideSet.has(edge.from);
    const toInside = insideSet.has(edge.to);

    if (fromInside && toInside) {
      internal.push(edge);
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    } else if (fromInside && byPath.has(edge.to)) {
      const target = byPath.get(edge.to)!.module;
      down.set(target, (down.get(target) ?? 0) + 1);
      downLinks.push({ file: edge.from, to: target });
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    } else if (toInside && byPath.has(edge.from)) {
      const source = byPath.get(edge.from)!.module;
      up.set(source, (up.get(source) ?? 0) + 1);
      upLinks.push({ from: source, file: edge.to });
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    }
  }

  const shown = [...inside]
    .sort((a, b) => (degree.get(b.path) ?? 0) - (degree.get(a.path) ?? 0) || a.path.localeCompare(b.path))
    .slice(0, MAX_DRILLDOWN_FILES);
  const shownSet = new Set(shown.map((file) => file.path));

  const nodeIds = shown.map((file) => file.path).sort();
  const pairs = internal
    .filter((edge) => shownSet.has(edge.from) && shownSet.has(edge.to))
    .map((edge) => [edge.from, edge.to] as [string, string]);

  const { level } = computeLevels(nodeIds, pairs);
  const order = orderLevels(nodeIds, level, pairs, (node) => degree.get(node) ?? 0);

  const topExternals = (map: Map<string, number>) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_DRILLDOWN_EXTERNAL);

  const upShown = topExternals(up);
  const downShown = topExternals(down);
  const maxFileLevel = Math.max(0, ...nodeIds.map((id) => level.get(id) ?? 0));

  const nodes: DrilldownNode[] = [];

  upShown.forEach(([key], index) => {
    nodes.push({ id: `up:${key}`, label: key, kind: "external-up", level: 0, order: index, lines: 0, exports: 0 });
  });

  for (const file of shown) {
    nodes.push({
      id: file.path,
      label: path.posix.basename(file.path),
      kind: "file",
      level: (level.get(file.path) ?? 0) + (upShown.length > 0 ? 1 : 0),
      order: order.get(file.path) ?? 0,
      lines: file.lines,
      exports: file.exportNames.length,
    });
  }

  downShown.forEach(([key], index) => {
    nodes.push({
      id: `down:${key}`,
      label: key,
      kind: "external-down",
      level: maxFileLevel + 1 + (upShown.length > 0 ? 1 : 0),
      order: index,
      lines: 0,
      exports: 0,
    });
  });

  const levelOf = new Map(nodes.map((node) => [node.id, node.level]));
  const edgeWeights = new Map<string, number>();
  const bump = (from: string, to: string) => edgeWeights.set(`${from}\0${to}`, (edgeWeights.get(`${from}\0${to}`) ?? 0) + 1);

  for (const [from, to] of pairs) bump(from, to);
  for (const link of upLinks) {
    if (shownSet.has(link.file) && upShown.some(([key]) => key === link.from)) bump(`up:${link.from}`, link.file);
  }
  for (const link of downLinks) {
    if (shownSet.has(link.file) && downShown.some(([key]) => key === link.to)) bump(link.file, `down:${link.to}`);
  }

  const edges: DrilldownEdge[] = [...edgeWeights.entries()]
    .map(([key, weight]) => {
      const [from, to] = key.split("\0");
      return { from, to, weight, back: (levelOf.get(from) ?? 0) >= (levelOf.get(to) ?? 0) };
    })
    .sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from));

  return { module: moduleKey, nodes, edges, hiddenFiles: Math.max(0, inside.length - shown.length) };
}

/* -------------------------------------------------------------------------- */
/*  Health score                                                              */
/* -------------------------------------------------------------------------- */

function scoreHealth(
  findings: ArchFinding[],
  cycleCount: number,
): { score: number; breakdown: Array<{ label: string; points: number }> } {
  const count = (rule: FindingRule) => findings.filter((finding) => finding.rule === rule).length;
  const breakdown: Array<{ label: string; points: number }> = [];

  const add = (label: string, points: number) => {
    if (points > 0) breakdown.push({ label, points: -points });
  };

  add(`Dependency cycles (${cycleCount})`, Math.min(36, cycleCount * 12));
  add(`Forbidden dependencies (${count("forbidden-dependency")})`, Math.min(30, count("forbidden-dependency") * 10));
  add(`Layer violations (${count("layer-violation")})`, Math.min(24, count("layer-violation") * 6));
  add(`Hub modules (${count("hub")})`, Math.min(12, count("hub") * 4));
  add(`Layer skipping (${count("layer-skip")})`, Math.min(6, count("layer-skip") * 2));
  add(`Deep imports (${count("deep-import")})`, Math.min(6, count("deep-import") * 2));
  add(`Isolated modules (${count("isolated")})`, Math.min(4, count("isolated")));

  const total = breakdown.reduce((sum, item) => sum - item.points, 0);
  return { score: Math.max(0, 100 - total), breakdown };
}

/* -------------------------------------------------------------------------- */
/*  Mermaid and markdown                                                      */
/* -------------------------------------------------------------------------- */

function mermaidText(text: string): string {
  return text.replace(/[()]/g, "").replace(/["\[\]{}<>|]/g, "'");
}

function buildMermaid(built: Built): string {
  const ids = new Map(built.modules.map((module, index) => [module.key, `m${index}`]));
  const lines: string[] = ["flowchart TD", "  classDef cycle stroke:#f43f5e,stroke-width:2px;"];

  for (const layer of built.layers) {
    lines.push(`  subgraph L${layer.level}["${mermaidText(layer.name)}"]`);
    for (const key of layer.modules) {
      const module = built.modules.find((item) => item.key === key)!;
      lines.push(`    ${ids.get(key)}["${mermaidText(key)}<br/>${plural(module.files, "file")}"]`);
    }
    lines.push("  end");
  }

  const shown = built.edges.slice(0, MAX_MERMAID_EDGES);
  for (const edge of shown) {
    const arrow = edge.cycle || edge.back ? "-.->" : "-->";
    lines.push(`  ${ids.get(edge.from)} ${arrow}|${edge.weight}| ${ids.get(edge.to)}`);
  }

  if (built.edges.length > shown.length) {
    lines.push(`  %% ${built.edges.length - shown.length} lighter dependencies are not drawn`);
  }

  const inCycle = built.modules.filter((module) => module.inCycle).map((module) => ids.get(module.key));
  if (inCycle.length > 0) lines.push(`  class ${inCycle.join(",")} cycle;`);

  return lines.join("\n");
}

function buildMarkdown(name: string, built: Built, summary: ArchitectureReport["summary"], mermaid: string): string {
  const lines: string[] = [
    `# Architecture overview: ${name}`,
    "",
    `Health ${summary.healthScore}/100 · ${plural(summary.modules, "module")} · ${plural(summary.edges, "dependency", "dependencies")} · ${plural(summary.layers, "layer")}`,
    "",
    "## Layers",
    "",
  ];

  for (const layer of built.layers) {
    lines.push(`${layer.level + 1}. **${layer.name}**: ${layer.modules.map((key) => `\`${key}\``).join(", ")}`);
  }

  lines.push("", "## Modules", "", "| Module | Role | Files | Depends on | Used by | Instability |", "| --- | --- | ---: | --- | --- | ---: |");

  for (const module of built.modules) {
    const depends = module.imports.slice(0, 3).map((item) => `${item.module} (${item.weight})`).join(", ") || "-";
    const usedBy = module.importedBy.slice(0, 3).map((item) => `${item.module} (${item.weight})`).join(", ") || "-";
    lines.push(`| \`${module.key}\` | ${module.role ?? "-"} | ${module.files} | ${depends} | ${usedBy} | ${module.instability.toFixed(2)} |`);
  }

  lines.push("", "## Problems found", "");
  if (built.findings.length === 0) {
    lines.push("No architecture problems found.");
  } else {
    for (const finding of built.findings.slice(0, 12)) {
      lines.push(`- **[${finding.severity}]** ${finding.title}. ${finding.suggestion}`);
    }
    if (built.findings.length > 12) lines.push(`- ...and ${built.findings.length - 12} more`);
  }

  lines.push("", "## Diagram", "", "```mermaid", mermaid, "```");
  return `${lines.join("\n")}\n`;
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                      */
/* -------------------------------------------------------------------------- */

export async function exploreArchitecture(
  projectPath: string,
  options: {
    moduleDepth?: number;
    includeTests?: boolean;
    forbid?: string[];
    focusModule?: string;
  } = {},
): Promise<ArchitectureReport> {
  const includeTests = options.includeTests ?? false;
  const requestedDepth = options.moduleDepth;

  if (
    requestedDepth !== undefined &&
    (!Number.isInteger(requestedDepth) || requestedDepth < 1 || requestedDepth > 4)
  ) {
    throw new Error("moduleDepth must be a whole number from 1 to 4.");
  }

  const rules = parseRules(options.forbid);

  const focusModule = options.focusModule?.trim() ? normalizePath(options.focusModule.trim()).replace(/\/+$/, "") : undefined;
  if (focusModule && (focusModule.length > 300 || focusModule.split("/").includes(".."))) {
    throw new Error("focusModule must be a module name such as src/server/auth.");
  }

  const resolved = await resolveProjectPath(projectPath);
  const root = fs.realpathSync(resolved.projectPath);
  const warnings: string[] = [];

  const warn = (message: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message);
    else if (warnings.length === MAX_WARNINGS) warnings.push("Further warnings were omitted.");
  };

  const discovered = discoverProject(root);

  if (discovered.codeFiles.length === 0) {
    throw new Error("No JavaScript or TypeScript files were found in the project.");
  }

  if (discovered.truncated) {
    warn(`Only the first ${MAX_FILES} code files were analyzed. Narrow the project path for complete results.`);
  }

  const isTest = (file: string) => TEST_NAME_PATTERN.test(file) || TEST_DIR_PATTERN.test(file);
  const fileSet = new Set(discovered.codeFiles);
  const analyzable = discovered.codeFiles.filter((file) => includeTests || !isTest(file));

  const nodes: FileNode[] = [];
  let skipped = 0;

  for (const rel of analyzable) {
    try {
      const absolute = path.join(root, rel);
      if (fs.statSync(absolute).size > MAX_PARSE_BYTES) {
        skipped++;
        continue;
      }
      nodes.push({ ...parseFile(rel, fs.readFileSync(absolute, "utf8")), module: "" });
    } catch {
      warn(`Could not parse ${rel}.`);
    }
  }

  if (skipped > 0) warn(`${plural(skipped, "very large file")} ${skipped === 1 ? "was" : "were"} skipped.`);

  if (nodes.length === 0) {
    throw new Error("No analyzable source files were found. Test files are left out unless you include them.");
  }

  const depth = requestedDepth ?? chooseDepth(nodes.map((node) => node.path), discovered.packageDirs);
  for (const node of nodes) node.module = moduleOf(node.path, depth, discovered.packageDirs);

  /* ---- File-level dependencies ---- */

  const resolve = createResolver(fileSet, loadPathConfigs(root, discovered.tsconfigs));
  const nodePaths = new Set(nodes.map((node) => node.path));
  const edgeMap = new Map<string, FileEdge>();

  for (const node of nodes) {
    for (const item of node.imports) {
      const target = resolve(node.path, item.spec);
      if (!target || target === node.path || !nodePaths.has(target)) continue;

      const key = `${node.path}\0${target}`;
      const existing = edgeMap.get(key);
      if (existing) existing.typeOnly = existing.typeOnly && item.typeOnly;
      else edgeMap.set(key, { from: node.path, to: target, typeOnly: item.typeOnly });
    }
  }

  const fileEdges = [...edgeMap.values()];

  const built = buildArchitecture(nodes, fileEdges, rules, warn);

  /* ---- Summary ---- */

  const findingCounts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of built.findings) findingCounts[finding.severity]++;

  const health = scoreHealth(built.findings, built.cycles.length);

  const summary: ArchitectureReport["summary"] = {
    files: nodes.length,
    lines: nodes.reduce((sum, node) => sum + node.lines, 0),
    modules: built.moduleCount,
    edges: built.edges.length,
    layers: built.layers.length,
    cycles: built.cycles.length,
    findings: findingCounts,
    healthScore: health.score,
    scoreBreakdown: health.breakdown,
  };

  const order = built.modules.map((module) => module.key);
  const position = new Map(order.map((key, index) => [key, index]));
  const cells = order.map(() => order.map(() => 0));
  for (const edge of built.edges) {
    cells[position.get(edge.from)!][position.get(edge.to)!] = edge.weight;
  }

  let name = path.basename(root);
  try {
    const json = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { name?: unknown };
    if (typeof json.name === "string") name = json.name;
  } catch {
    /* the folder name is fine */
  }

  const mermaid = buildMermaid(built);

  let drilldown: Drilldown | undefined;
  if (focusModule) {
    drilldown = buildDrilldown(focusModule, nodes, fileEdges);
    if (!drilldown) warn(`There is no module called "${focusModule}". Pick one from the list.`);
  }

  if (built.moduleCount < 3) {
    warn("Fewer than three modules were found, so there is little structure to show. Try a finer module size.");
  }

  return {
    success: true,
    tool: "explore_architecture",
    projectPath: root,
    granularity: {
      requested: requestedDepth === undefined ? "auto" : String(requestedDepth),
      depth,
      moduleCount: built.moduleCount,
    },
    summary,
    modules: built.modules,
    edges: built.edges,
    layers: built.layers,
    findings: built.findings,
    matrix: { order, cells },
    forbiddenRules: built.forbiddenRules,
    drilldown,
    mermaid,
    markdown: buildMarkdown(name, built, summary, mermaid),
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/*  MCP registration                                                          */
/* -------------------------------------------------------------------------- */

export function registerExploreArchitectureTool(server: McpServer) {
  server.registerTool(
    "explore_architecture",
    {
      description:
        "Explore the architecture of a JavaScript/TypeScript codebase. Groups files into modules (automatically or at a chosen folder depth), builds the weighted module dependency graph with real file examples, derives layers from the graph itself, and reports coupling metrics (instability, abstractness, distance). Finds dependency cycles, layer violations, layer skipping, violations of your own forbidden-dependency rules, hub modules, deep imports that bypass a module's index, and isolated modules, each with evidence and a suggested fix. Returns an architecture health score, a dependency matrix, an optional drill-down into one module's files, a Mermaid diagram and a markdown overview.",
      inputSchema: z.object({
        projectPath: z.string().describe("Absolute path to the project directory"),
        moduleDepth: z
          .number()
          .int()
          .min(1)
          .max(4)
          .optional()
          .describe("Folders below src (or the package root) that define a module. Default: chosen automatically."),
        includeTests: z.boolean().optional().describe("Include test files in the graph. Default false."),
        forbid: z
          .array(z.string())
          .max(MAX_RULES)
          .optional()
          .describe('Forbidden dependencies such as "src/ui -> src/db". Folder prefixes, relative to the project.'),
        focusModule: z
          .string()
          .optional()
          .describe("A module name such as src/server/auth. Adds a drill-down of the files inside it."),
      }),
    },
    async ({ projectPath, moduleDepth, includeTests, forbid, focusModule }) => {
      try {
        const report = await exploreArchitecture(projectPath, {
          moduleDepth,
          includeTests,
          forbid,
          focusModule,
        });

        return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  tool: "explore_architecture",
                  error: error instanceof Error ? error.message : "Failed to explore the architecture.",
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
