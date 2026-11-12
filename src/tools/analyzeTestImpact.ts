import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import ts from "typescript";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveProjectPath } from "../utils/projectResolver.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

type Priority = "critical" | "high" | "medium" | "low";
type GapSeverity = "high" | "medium" | "low";
type TestKind = "unit" | "integration" | "e2e";
type TestTypeFilter = "all" | "unit" | "e2e";

type TestFramework =
  | "vitest"
  | "jest"
  | "playwright"
  | "cypress"
  | "mocha"
  | "node-test"
  | "unknown";

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";
type ChangedKind = "source" | "test" | "config" | "asset";

type Relation =
  | "changed-test"
  | "direct"
  | "transitive"
  | "type-only"
  | "mock"
  | "snapshot"
  | "naming"
  | "stale-import";

type EdgeKind = "static" | "dynamic" | "require" | "reexport" | "type" | "mock";

interface ChangedFile {
  path: string;
  status: ChangeStatus;
  oldPath?: string;
  kind: ChangedKind;
  /** Runtime exports, to show what the change can affect. */
  exports: string[];
  impactedTests: number;
}

interface ImpactReason {
  changedFile: string;
  changeStatus: ChangeStatus;
  relation: Relation;
  /** Imports between the test and the changed file (0 = the test itself changed). */
  distance: number;
  /** Test first, changed file last. */
  via: string[];
}

interface ImpactedTest {
  id: string;
  filePath: string;
  kind: TestKind;
  framework: TestFramework;
  testCases: number;
  priority: Priority;
  summary: string;
  nearestDistance: number;
  changedFilesReached: number;
  reasonCount: number;
  reasons: ImpactReason[];
}

interface CoverageGap {
  id: string;
  filePath: string;
  status: ChangeStatus;
  severity: GapSeverity;
  reason: string;
  runtimeExports: string[];
  suggestedTestPath: string;
  skeleton: string;
  /** Existing tests in the same folder, useful as a style example. */
  neighborTests: string[];
}

interface RunCommand {
  label: string;
  command: string;
  description: string;
  testCount: number;
}

interface BlastRadiusFile {
  filePath: string;
  status: ChangeStatus;
  impactedTests: number;
  directTests: number;
}

interface TestImpactReport {
  success: boolean;
  tool: "analyze_test_impact";
  projectPath: string;
  baseline: { kind: "git-ref" | "files"; label: string; commit?: string };
  testTypes: TestTypeFilter;
  maxDepth?: number;
  includeTypeOnly: boolean;
  includeUntracked: boolean;
  runner: {
    unit: TestFramework;
    e2e: TestFramework;
    packageManager: PackageManager;
    detected: boolean;
  };
  totalFiles: number;
  totalTests: number;
  totalTestCases: number;
  changedFileCount: number;
  ignoredChangeCount: number;
  changedFiles: ChangedFile[];
  impactedTestCount: number;
  impactedTestCases: number;
  skippedTests: number;
  reductionPercent: number;
  impactedTests: ImpactedTest[];
  coverageGaps: CoverageGap[];
  commands: RunCommand[];
  runAll: { required: boolean; reasons: string[] };
  summary: Record<Priority, number>;
  blastRadius: BlastRadiusFile[];
  warnings: string[];
}

/* ---- Internal model ---- */

interface RawEdge {
  spec: string;
  kind: EdgeKind;
  names: string[] | "*";
  reexport?: { star: boolean; map: Array<[string, string]> };
}

interface ExportInfo {
  name: string;
  runtime: boolean;
}

interface FileInfo {
  rel: string;
  isTest: boolean;
  testCases: number;
  framework?: TestFramework;
  edges: RawEdge[];
  exports: ExportInfo[];
  hasStarExport: boolean;
  isBarrel: boolean;
  lineCount: number;
}

interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
  names: Set<string> | "*";
  reexport?: { star: boolean; map: Map<string, string> };
  stale?: boolean;
}

type Flow = "*" | Set<string>;

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

interface Resolution {
  resolved?: string;
  candidates: string[];
}

interface RawChange {
  path: string;
  status: ChangeStatus;
  oldPath?: string;
}

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const ASSET_EXTENSIONS = new Set([
  ".json",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".svg",
  ".graphql",
  ".gql",
  ".snap",
]);

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
]);

const RESOLVE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
];

const TEST_NAME_PATTERN = /\.(test|spec|cy|e2e|pw)\.[cm]?[jt]sx?$/;
const TEST_DIR_PATTERN = /(^|\/)(__tests__|e2e|tests?|cypress|playwright)\//;
const TEST_HELPER_PATTERN =
  /(helper|util|fixture|mock|setup|factory|support|stub|constants)/i;

const GLOBAL_CONFIG_PATTERN =
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|tsconfig[^/]*\.json|jsconfig\.json|(jest|vitest|vite|playwright|cypress|babel|mocha|karma|webpack|rollup)\.config\.[cm]?[jt]s|\.babelrc|\.mocharc\.[a-z]+|setupTests\.[cm]?[jt]sx?|(jest|vitest)\.setup\.[cm]?[jt]sx?)$/;

const STRONG_EDGE_KINDS = new Set<EdgeKind>([
  "static",
  "dynamic",
  "require",
  "reexport",
]);

const PRIORITY_ORDER: Priority[] = ["critical", "high", "medium", "low"];

const MAX_FILES = 8_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_TRACED_CHANGES = 300;
const MAX_LISTED_TESTS = 500;
const MAX_REASONS = 8;
const MAX_GAPS = 100;
const MAX_HOTSPOTS = 15;
const MAX_WARNINGS = 25;
const MAX_COMMAND_FILES = 200;
const MAX_VIA_LENGTH = 8;

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.\-/@^~{}:]*$/;

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function scriptKindFor(file: string): ts.ScriptKind {
  const extension = path.extname(file);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function priorityRank(priority: Priority): number {
  return PRIORITY_ORDER.indexOf(priority);
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

function validateRef(value: string): string {
  const trimmed = value.trim();

  if (!trimmed || trimmed.length > 200 || !REF_PATTERN.test(trimmed)) {
    throw new Error(
      "baseRef must be a git branch, tag or commit (letters, digits and . _ - / @ ^ ~ only).",
    );
  }

  return trimmed;
}

function validateRelative(value: string, label: string): string {
  const cleaned = normalizePath(value.trim());

  if (
    !cleaned ||
    path.isAbsolute(cleaned) ||
    cleaned.split("/").includes("..")
  ) {
    throw new Error(`${label} must contain relative paths inside the project.`);
  }

  return cleaned;
}

function isCodeFile(rel: string): boolean {
  return CODE_EXTENSIONS.has(path.posix.extname(rel));
}

function isAssetFile(rel: string): boolean {
  return ASSET_EXTENSIONS.has(path.posix.extname(rel));
}

/* -------------------------------------------------------------------------- */
/*  Reading the project                                                       */
/* -------------------------------------------------------------------------- */

interface Discovered {
  codeFiles: string[];
  assetFiles: string[];
  configFiles: string[];
  truncated: boolean;
}

function discoverFiles(root: string): Discovered {
  const codeFiles: string[] = [];
  const assetFiles: string[] = [];
  const configFiles: string[] = [];
  let truncated = false;
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;

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
        if (!IGNORED_DIRS.has(entry.name)) stack.push(absolute);
        continue;
      }

      if (!entry.isFile()) continue;

      const rel = normalizePath(path.relative(root, absolute));

      if (entry.name === "tsconfig.json" || entry.name === "jsconfig.json") {
        configFiles.push(rel);
      }

      const isCode = isCodeFile(rel);
      const isAsset = isAssetFile(rel);
      if (!isCode && !isAsset) continue;

      if (codeFiles.length + assetFiles.length >= MAX_FILES) {
        truncated = true;
        continue;
      }

      (isCode ? codeFiles : assetFiles).push(rel);
    }
  }

  codeFiles.sort();
  assetFiles.sort();
  return { codeFiles, assetFiles, configFiles, truncated };
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const parsed = ts.readConfigFile(file, ts.sys.readFile);
    if (parsed.error || typeof parsed.config !== "object") return undefined;
    return parsed.config as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function loadPathConfigs(
  root: string,
  configFiles: string[],
): Map<string, PathConfig> {
  const configs = new Map<string, PathConfig>();

  for (const rel of configFiles) {
    const absolute = path.join(root, rel);
    const seen = new Set<string>();
    let current: string | undefined = absolute;
    let baseUrl: string | undefined;
    let paths: Record<string, string[]> | undefined;
    let baseUrlDir = path.dirname(absolute);
    let pathsDir = path.dirname(absolute);

    // Follow a short `extends` chain so inherited aliases still resolve.
    for (let depth = 0; current && depth < 4 && !seen.has(current); depth++) {
      seen.add(current);
      const json = readJson(current);
      if (!json) break;

      const options = (json.compilerOptions ?? {}) as {
        baseUrl?: string;
        paths?: Record<string, string[]>;
      };

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
        current = fs.existsSync(next)
          ? next
          : fs.existsSync(`${next}.json`)
            ? `${next}.json`
            : undefined;
      } else {
        current = undefined;
      }
    }

    const dir = normalizePath(path.dirname(rel));
    const configDir = dir === "." ? "" : dir;
    const toRoot = (from: string, target: string) =>
      normalizePath(path.relative(root, path.resolve(from, target)));

    const patterns: PathPattern[] = [];
    for (const [key, targets] of Object.entries(paths ?? {})) {
      const star = key.indexOf("*");
      patterns.push({
        prefix: star === -1 ? key : key.slice(0, star),
        suffix: star === -1 ? "" : key.slice(star + 1),
        wildcard: star !== -1,
        targets: targets.map((target) =>
          toRoot(baseUrl !== undefined ? baseUrlDir : pathsDir, baseUrl !== undefined ? path.join(baseUrl, target) : target),
        ),
      });
    }

    configs.set(configDir, {
      dir: configDir,
      baseUrl:
        baseUrl !== undefined ? toRoot(baseUrlDir, baseUrl) : undefined,
      paths: patterns,
    });
  }

  return configs;
}

function createResolver(fileSet: Set<string>, configs: Map<string, PathConfig>) {
  const tryFile = (base: string, into: string[]): string | undefined => {
    const stripped = base.replace(/\.[cm]?jsx?$/, "");
    const options = [
      base,
      ...RESOLVE_EXTENSIONS.map((extension) => `${stripped}${extension}`),
      ...RESOLVE_EXTENSIONS.map((extension) => `${base}${extension}`),
      ...RESOLVE_EXTENSIONS.map((extension) => `${base}/index${extension}`),
    ];

    for (const option of options) {
      into.push(option);
      if (fileSet.has(option)) return option;
    }

    return undefined;
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

  return (fromRel: string, spec: string): Resolution => {
    const candidates: string[] = [];

    if (spec.startsWith(".")) {
      const joined = path.posix.normalize(
        path.posix.join(path.posix.dirname(fromRel), spec),
      );
      return { resolved: tryFile(joined, candidates), candidates };
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
          const base = normalizePath(
            path.posix.normalize(target.replace("*", captured)),
          );
          const resolved = tryFile(base, candidates);
          if (resolved) return { resolved, candidates };
        }
      }

      if (config.baseUrl !== undefined) {
        const base = path.posix.normalize(
          path.posix.join(config.baseUrl || ".", spec),
        );
        const resolved = tryFile(base, candidates);
        if (resolved) return { resolved, candidates };
      }
    }

    // Common bundler alias: "@/x" and "~/x" point at the nearest src folder.
    if (spec.startsWith("@/") || spec.startsWith("~/")) {
      const roots = new Set<string>(["src"]);
      if (config?.dir) roots.add(path.posix.join(config.dir, "src"));

      for (const rootDir of roots) {
        const resolved = tryFile(
          path.posix.normalize(path.posix.join(rootDir, spec.slice(2))),
          candidates,
        );
        if (resolved) return { resolved, candidates };
      }
    }

    return { candidates };
  };
}

/* -------------------------------------------------------------------------- */
/*  Finding what changed                                                      */
/* -------------------------------------------------------------------------- */

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        maxBuffer: GIT_MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || "").trim();
          reject(new Error(detail || error.message || "git command failed."));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function ensureGitRepository(root: string): Promise<void> {
  try {
    await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";

    if (/ENOENT/.test(message)) {
      throw new Error("Git is not installed or is not on the PATH.");
    }

    throw new Error(
      "The project is not inside a git repository. Pass changedFiles to analyze specific files instead.",
    );
  }
}

function parseNameStatus(output: string): RawChange[] {
  const tokens = output.split("\0");
  const changes: RawChange[] = [];

  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index++];
    if (!status) continue;

    const letter = status[0];

    if (letter === "R" || letter === "C") {
      const oldPath = tokens[index++];
      const next = tokens[index++];
      if (!next) continue;

      changes.push(
        letter === "R"
          ? { path: normalizePath(next), status: "renamed", oldPath: normalizePath(oldPath) }
          : { path: normalizePath(next), status: "added" },
      );
      continue;
    }

    const file = tokens[index++];
    if (!file) continue;

    changes.push({
      path: normalizePath(file),
      status: letter === "A" ? "added" : letter === "D" ? "deleted" : "modified",
    });
  }

  return changes;
}

async function gitChanges(
  root: string,
  baseRef: string,
  includeUntracked: boolean,
): Promise<{ changes: RawChange[]; commit: string }> {
  let commit = "";

  try {
    commit = (
      await runGit(root, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`])
    ).trim();
  } catch {
    commit = "";
  }

  if (!commit) {
    throw new Error(
      `Git could not find "${baseRef}" in this repository. Use a branch, tag or commit that exists, and make sure the repository has at least one commit.`,
    );
  }

  // For a branch ref, compare from where this work diverged so that
  // commits that only exist on the other branch are not counted.
  let from = commit;
  try {
    const mergeBase = (await runGit(root, ["merge-base", commit, "HEAD"])).trim();
    if (mergeBase) from = mergeBase;
  } catch {
    from = commit;
  }

  const tracked = parseNameStatus(
    await runGit(root, [
      "diff",
      "--name-status",
      "-z",
      "-M",
      "--relative",
      "--no-color",
      from,
    ]),
  );

  const changes = new Map<string, RawChange>();
  for (const change of tracked) changes.set(change.path, change);

  if (includeUntracked) {
    const untracked = await runGit(root, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);

    for (const file of untracked.split("\0")) {
      if (!file) continue;
      const rel = normalizePath(file);
      if (!changes.has(rel)) changes.set(rel, { path: rel, status: "untracked" });
    }
  }

  return { changes: [...changes.values()], commit: commit.slice(0, 10) };
}

function isTestPath(rel: string): boolean {
  return TEST_NAME_PATTERN.test(rel);
}

function classifyChanged(rel: string, isKnownTest: boolean): ChangedKind | undefined {
  if (GLOBAL_CONFIG_PATTERN.test(rel)) return "config";
  if (isKnownTest || isTestPath(rel)) return "test";
  if (isCodeFile(rel)) return "source";
  if (isAssetFile(rel)) return "asset";
  return undefined;
}

/* -------------------------------------------------------------------------- */
/*  Parsing a file                                                            */
/* -------------------------------------------------------------------------- */

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
    : false;
}

const TEST_CALL_MODIFIERS = new Set([
  "only",
  "skip",
  "concurrent",
  "fails",
  "fixme",
  "each",
  "failing",
  "serial",
]);

function isTestCaseCall(node: ts.CallExpression): boolean {
  let callee: ts.Expression = node.expression;
  // it.each(table)("name", fn)
  if (ts.isCallExpression(callee)) callee = callee.expression;

  const names: string[] = [];
  while (ts.isPropertyAccessExpression(callee)) {
    names.unshift(callee.name.text);
    callee = callee.expression;
  }

  if (!ts.isIdentifier(callee)) return false;
  if (callee.text !== "it" && callee.text !== "test") return false;
  if (!names.every((name) => TEST_CALL_MODIFIERS.has(name))) return false;

  return node.arguments.length >= 2;
}

function detectFramework(specs: string[], rel: string): TestFramework | undefined {
  if (/\.cy\.[cm]?[jt]sx?$/.test(rel)) return "cypress";

  for (const spec of specs) {
    if (spec === "vitest" || spec.startsWith("vitest/")) return "vitest";
    if (spec === "@jest/globals") return "jest";
    if (spec === "@playwright/test") return "playwright";
    if (spec === "cypress") return "cypress";
    if (spec === "node:test") return "node-test";
    if (spec === "mocha" || spec === "chai") return "mocha";
  }

  return undefined;
}

function parseFile(rel: string, text: string): FileInfo {
  const sf = ts.createSourceFile(
    rel,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(rel),
  );

  const edges: RawEdge[] = [];
  const exports: ExportInfo[] = [];
  const typeDeclarations = new Set<string>();
  let hasStarExport = false;
  let testCases = 0;
  let onlyModuleLinks = true;

  const addNames = (
    kind: EdgeKind,
    spec: string,
    runtime: string[],
    types: string[],
    sideEffect: boolean,
  ) => {
    if (runtime.length > 0) edges.push({ spec, kind, names: runtime });
    if (types.length > 0) edges.push({ spec, kind: "type", names: types });
    if (sideEffect) edges.push({ spec, kind, names: "*" });
  };

  for (const statement of sf.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      typeDeclarations.add(statement.name.text);
    }

    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const spec = statement.moduleSpecifier.text;
      const clause = statement.importClause;

      if (!clause) {
        addNames("static", spec, [], [], true);
        continue;
      }

      const runtime: string[] = [];
      const types: string[] = [];
      const bucket = (isType: boolean) => (isType ? types : runtime);

      if (clause.name) bucket(clause.isTypeOnly).push("default");

      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          bucket(clause.isTypeOnly).push("*");
        } else {
          for (const element of clause.namedBindings.elements) {
            bucket(clause.isTypeOnly || element.isTypeOnly).push(
              element.propertyName?.text ?? element.name.text,
            );
          }
        }
      }

      addNames("static", spec, runtime, types, runtime.length + types.length === 0);
      continue;
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const spec = statement.moduleSpecifier.text;
      const clause = statement.exportClause;
      const kind: EdgeKind = statement.isTypeOnly ? "type" : "reexport";

      if (!clause) {
        hasStarExport = true;
        edges.push({
          spec,
          kind,
          names: [],
          reexport: { star: true, map: [] },
        });
      } else if (ts.isNamespaceExport(clause)) {
        exports.push({ name: clause.name.text, runtime: !statement.isTypeOnly });
        edges.push({
          spec,
          kind,
          names: [],
          reexport: { star: false, map: [["*", clause.name.text]] },
        });
      } else {
        const runtimeMap: Array<[string, string]> = [];
        const typeMap: Array<[string, string]> = [];

        for (const element of clause.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          const exported = element.name.text;
          const isType = statement.isTypeOnly || element.isTypeOnly;

          exports.push({ name: exported, runtime: !isType });
          (isType ? typeMap : runtimeMap).push([imported, exported]);
        }

        if (runtimeMap.length > 0) {
          edges.push({
            spec,
            kind: "reexport",
            names: [],
            reexport: { star: false, map: runtimeMap },
          });
        }
        if (typeMap.length > 0) {
          edges.push({
            spec,
            kind: "type",
            names: [],
            reexport: { star: false, map: typeMap },
          });
        }
      }
      continue;
    }

    if (ts.isEmptyStatement(statement)) continue;
    onlyModuleLinks = false;
  }

  // Own exports (declarations and `export { a, b as c }`).
  for (const statement of sf.statements) {
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);

    if (exported) {
      if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
        exports.push({
          name: isDefault ? "default" : (statement.name?.text ?? "default"),
          runtime: true,
        });
      } else if (ts.isEnumDeclaration(statement)) {
        exports.push({ name: statement.name.text, runtime: true });
      } else if (
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)
      ) {
        exports.push({ name: statement.name.text, runtime: false });
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            exports.push({ name: declaration.name.text, runtime: true });
          }
        }
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        const local = element.propertyName?.text ?? element.name.text;
        exports.push({
          name: element.name.text,
          runtime: !statement.isTypeOnly && !element.isTypeOnly && !typeDeclarations.has(local),
        });
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      exports.push({ name: "default", runtime: true });
    }
  }

  // Calls anywhere in the file: require(), import(), jest.mock(), test cases.
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const [first] = node.arguments;
      const literal =
        first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
          ? first.text
          : undefined;

      if (literal !== undefined) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          edges.push({ spec: literal, kind: "dynamic", names: "*" });
        } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
          edges.push({ spec: literal, kind: "require", names: "*" });
        } else if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          (node.expression.expression.text === "jest" ||
            node.expression.expression.text === "vi")
        ) {
          const method = node.expression.name.text;

          if (["mock", "doMock", "unmock", "dontMock"].includes(method)) {
            edges.push({ spec: literal, kind: "mock", names: "*" });
          } else if (method === "requireActual") {
            edges.push({ spec: literal, kind: "require", names: "*" });
          } else if (method === "importActual") {
            edges.push({ spec: literal, kind: "dynamic", names: "*" });
          }
        }
      }

      if (isTestCaseCall(node)) testCases++;
    }

    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      edges.push({
        spec: node.moduleReference.expression.text,
        kind: "require",
        names: "*",
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);

  const specs = edges.map((edge) => edge.spec);

  const nameTest = TEST_NAME_PATTERN.test(rel);
  const dirCandidate =
    TEST_DIR_PATTERN.test(rel) && !TEST_HELPER_PATTERN.test(path.posix.basename(rel));

  return {
    rel,
    isTest: nameTest || (dirCandidate && testCases > 0),
    testCases,
    framework: detectFramework(specs, rel),
    edges,
    exports,
    hasStarExport,
    isBarrel: onlyModuleLinks && edges.some((edge) => edge.reexport),
    lineCount: text.split("\n").length,
  };
}

/* -------------------------------------------------------------------------- */
/*  Import graph                                                              */
/* -------------------------------------------------------------------------- */

interface Graph {
  incoming: Map<string, Edge[]>;
  /** importer|target pairs that use the module for more than re-exporting. */
  usedDirectly: Set<string>;
  jsExtensionStyle: boolean;
}

function buildGraph(
  infos: Map<string, FileInfo>,
  resolve: (fromRel: string, spec: string) => Resolution,
  deleted: Set<string>,
): Graph {
  const incoming = new Map<string, Edge[]>();
  const usedDirectly = new Set<string>();
  let withJsExtension = 0;
  let withoutExtension = 0;

  const push = (target: string, edge: Edge) => {
    const list = incoming.get(target);
    if (list) list.push(edge);
    else incoming.set(target, [edge]);
  };

  for (const info of infos.values()) {
    for (const raw of info.edges) {
      const resolution = resolve(info.rel, raw.spec);
      let target = resolution.resolved;
      let stale = false;

      if (!target) {
        target = resolution.candidates.find((candidate) => deleted.has(candidate));
        stale = target !== undefined;
      }

      if (!target || target === info.rel) continue;

      if (raw.spec.startsWith(".") && resolution.resolved) {
        if (/\.[cm]?jsx?$/.test(raw.spec) && /\.[cm]?tsx?$/.test(resolution.resolved)) {
          withJsExtension++;
        } else if (!/\.[a-z]+$/.test(path.posix.basename(raw.spec))) {
          withoutExtension++;
        }
      }

      const edge: Edge = {
        from: info.rel,
        to: target,
        kind: raw.kind,
        names: raw.names === "*" ? "*" : new Set(raw.names),
        reexport: raw.reexport
          ? { star: raw.reexport.star, map: new Map(raw.reexport.map) }
          : undefined,
        stale: stale || undefined,
      };

      if (!raw.reexport) usedDirectly.add(`${info.rel}|${target}`);
      push(target, edge);
    }
  }

  return {
    incoming,
    usedDirectly,
    jsExtensionStyle: withJsExtension > withoutExtension,
  };
}

function exportFlow(info: FileInfo | undefined): Flow {
  if (!info || info.hasStarExport || info.exports.length === 0) return "*";
  return new Set(info.exports.map((item) => item.name));
}

function edgeAffects(edge: Edge, flow: Flow): boolean {
  if (flow === "*") return true;

  if (edge.reexport) {
    if (edge.reexport.star) return true;
    for (const imported of edge.reexport.map.keys()) {
      if (imported === "*" || flow.has(imported)) return true;
    }
    return false;
  }

  if (edge.names === "*") return true;

  for (const name of edge.names) {
    if (name === "*" || flow.has(name)) return true;
  }

  return false;
}

function nextFlow(edge: Edge, flow: Flow, graph: Graph): Flow {
  if (edge.reexport && !graph.usedDirectly.has(`${edge.from}|${edge.to}`)) {
    if (edge.reexport.star) return flow;

    const next = new Set<string>();
    for (const [imported, exported] of edge.reexport.map) {
      if (flow === "*" || imported === "*" || flow.has(imported)) next.add(exported);
    }
    return next;
  }

  return "*";
}

interface TraceHit {
  distance: number;
  via: string[];
  weak?: "type" | "mock";
  stale: boolean;
}

/**
 * Walks importers backwards from a changed file. Re-export barrels only pass
 * on the names they actually re-export, so an unrelated import of the same
 * barrel does not pull in a test.
 */
function trace(
  graph: Graph,
  start: string,
  startFlow: Flow,
  strongOnly: boolean,
  maxDepth: number,
  testFiles: Set<string>,
): Map<string, TraceHit> {
  interface Visit {
    flow: Flow;
    distance: number;
    prev?: string;
    weak?: "type" | "mock";
    stale: boolean;
  }

  const visited = new Map<string, Visit>();
  visited.set(start, { flow: startFlow, distance: 0, stale: false });

  const queue: string[] = [start];

  for (let head = 0; head < queue.length; head++) {
    const file = queue[head];
    const state = visited.get(file)!;

    if (state.distance >= maxDepth) continue;

    for (const edge of graph.incoming.get(file) ?? []) {
      if (strongOnly && !STRONG_EDGE_KINDS.has(edge.kind)) continue;
      if (!edgeAffects(edge, state.flow)) continue;

      const flow = nextFlow(edge, state.flow, graph);
      if (flow !== "*" && flow.size === 0) continue;

      const weak: "type" | "mock" | undefined =
        state.weak === "type" || edge.kind === "type"
          ? "type"
          : state.weak === "mock" || edge.kind === "mock"
            ? "mock"
            : undefined;

      const importer = edge.from;
      const existing = visited.get(importer);

      if (!existing) {
        visited.set(importer, {
          flow,
          distance: state.distance + 1,
          prev: file,
          weak,
          stale: state.distance === 0 && Boolean(edge.stale),
        });
        // A test is a leaf: nothing meaningful imports it.
        if (!testFiles.has(importer)) queue.push(importer);
        continue;
      }

      if (existing.flow === "*" || testFiles.has(importer)) continue;

      let grew = false;
      if (flow === "*") {
        existing.flow = "*";
        grew = true;
      } else {
        for (const name of flow) {
          if (!existing.flow.has(name)) {
            existing.flow.add(name);
            grew = true;
          }
        }
      }

      if (grew) queue.push(importer);
    }
  }

  const hits = new Map<string, TraceHit>();

  for (const [file, state] of visited) {
    if (file === start || !testFiles.has(file)) continue;

    const via: string[] = [];
    let current: string | undefined = file;
    while (current !== undefined && via.length < 64) {
      via.push(current);
      current = visited.get(current)?.prev;
    }

    hits.set(file, {
      distance: state.distance,
      via,
      weak: state.weak,
      stale: state.stale,
    });
  }

  return hits;
}

/* -------------------------------------------------------------------------- */
/*  Test runner and project conventions                                       */
/* -------------------------------------------------------------------------- */

function readPackage(root: string): {
  deps: Set<string>;
  scripts: Record<string, string>;
} {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    return {
      deps: new Set([
        ...Object.keys(parsed.dependencies ?? {}),
        ...Object.keys(parsed.devDependencies ?? {}),
      ]),
      scripts: parsed.scripts ?? {},
    };
  } catch {
    return { deps: new Set(), scripts: {} };
  }
}

function detectRunners(
  pkg: { deps: Set<string>; scripts: Record<string, string> },
  infos: FileInfo[],
): { unit: TestFramework; e2e: TestFramework } {
  const has = (...names: string[]) => names.some((name) => pkg.deps.has(name));
  const script = pkg.scripts.test ?? "";

  let unit: TestFramework = "unknown";
  if (has("vitest") || /vitest/.test(script)) unit = "vitest";
  else if (
    has("jest", "ts-jest", "babel-jest", "@jest/core", "jest-cli", "@swc/jest") ||
    /\bjest\b/.test(script)
  ) {
    unit = "jest";
  } else if (has("mocha") || /mocha/.test(script)) unit = "mocha";
  else if (/node\s+--test/.test(script) || infos.some((info) => info.framework === "node-test")) {
    unit = "node-test";
  }

  let e2e: TestFramework = "unknown";
  if (has("@playwright/test", "playwright")) e2e = "playwright";
  else if (has("cypress")) e2e = "cypress";

  return { unit, e2e };
}

function detectPackageManager(root: string): PackageManager {
  const exists = (name: string) => fs.existsSync(path.join(root, name));

  if (exists("pnpm-lock.yaml")) return "pnpm";
  if (exists("yarn.lock")) return "yarn";
  if (exists("bun.lockb") || exists("bun.lock")) return "bun";
  return "npm";
}

function executorFor(manager: PackageManager): string {
  switch (manager) {
    case "pnpm":
      return "pnpm exec";
    case "yarn":
      return "yarn";
    case "bun":
      return "bunx";
    default:
      return "npx";
  }
}

function testScriptFor(manager: PackageManager): string {
  return manager === "bun" ? "bun run test" : `${manager} test`;
}

function testKindOf(rel: string, framework: TestFramework | undefined): TestKind {
  if (
    framework === "playwright" ||
    framework === "cypress" ||
    /(^|\/)(e2e|cypress|playwright)\//.test(rel) ||
    /\.(e2e|cy|pw)\.[cm]?[jt]sx?$/.test(rel)
  ) {
    return "e2e";
  }

  if (/(^|\/)integration\//.test(rel) || /\.integration\.[cm]?[jt]sx?$/.test(rel)) {
    return "integration";
  }

  return "unit";
}

/* -------------------------------------------------------------------------- */
/*  Impact assembly                                                           */
/* -------------------------------------------------------------------------- */

function priorityFor(reasons: ImpactReason[]): Priority {
  if (reasons.some((reason) => reason.relation === "stale-import")) {
    return "critical";
  }

  if (
    reasons.some(
      (reason) =>
        reason.relation === "changed-test" ||
        reason.relation === "snapshot" ||
        reason.relation === "direct",
    )
  ) {
    return "high";
  }

  const transitive = reasons.filter((reason) => reason.relation === "transitive");
  if (transitive.length > 0) {
    return Math.min(...transitive.map((reason) => reason.distance)) <= 3
      ? "medium"
      : "low";
  }

  return "low";
}

const RELATION_ORDER: Relation[] = [
  "stale-import",
  "changed-test",
  "snapshot",
  "direct",
  "transitive",
  "type-only",
  "mock",
  "naming",
];

function summarize(reasons: ImpactReason[], reached: number): string {
  const best = [...reasons].sort(
    (a, b) =>
      RELATION_ORDER.indexOf(a.relation) - RELATION_ORDER.indexOf(b.relation) ||
      a.distance - b.distance,
  )[0];

  let text: string;

  switch (best.relation) {
    case "stale-import":
      text = `Imports ${best.changedFile}, which was deleted or renamed, so it will fail.`;
      break;
    case "changed-test":
      text = "This test file was changed.";
      break;
    case "snapshot":
      text = "Its snapshot file was changed.";
      break;
    case "direct":
      text = `Imports ${best.changedFile} directly.`;
      break;
    case "transitive":
      text = `Depends on ${best.changedFile} through ${plural(
        best.distance,
        "import",
      )}.`;
      break;
    case "type-only":
      text = `Only uses types from ${best.changedFile}.`;
      break;
    case "mock":
      text = `Mocks a module that depends on ${best.changedFile}.`;
      break;
    default:
      text = `Its name matches ${best.changedFile}.`;
  }

  return reached > 1 ? `${text} Also reaches ${plural(reached - 1, "other changed file")}.` : text;
}

function exportsLabel(info: FileInfo | undefined): string[] {
  return (info?.exports ?? [])
    .filter((item) => item.runtime)
    .map((item) => item.name);
}

/* -------------------------------------------------------------------------- */
/*  Coverage gaps and generated tests                                         */
/* -------------------------------------------------------------------------- */

function toPascal(value: string): string {
  const cleaned = value
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9]+(.)?/g, (_, char: string | undefined) =>
      (char ?? "").toUpperCase(),
    );
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1) || "Subject";
}

function relativeSpec(fromFile: string, toFile: string, jsStyle: boolean): string {
  let relative = path.posix.relative(path.posix.dirname(fromFile), toFile);
  const isTs = /\.[cm]?tsx?$/.test(relative);
  relative = relative.replace(/\.[cm]?[jt]sx?$/, "");
  if (jsStyle && isTs) relative += ".js";
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function suggestTestPath(
  file: string,
  convention: { mirrorFolder: boolean; suffix: "test" | "spec" },
): string {
  const dir = path.posix.dirname(file);
  const extension = path.posix.extname(file);
  const base = path.posix.basename(file, extension);
  const testExtension = extension === ".tsx" || extension === ".jsx" ? extension : extension.replace(/^\.[cm]/, ".");
  const folder = dir === "." ? "" : `${dir}/`;

  return convention.mirrorFolder
    ? `${folder}__tests__/${base}.${convention.suffix}${testExtension}`
    : `${folder}${base}.${convention.suffix}${testExtension}`;
}

function buildSkeleton(options: {
  file: string;
  testPath: string;
  runtimeExports: string[];
  framework: TestFramework;
  jsStyle: boolean;
  hasTestingLibrary: boolean;
}): string {
  const { file, testPath, runtimeExports, framework, jsStyle, hasTestingLibrary } = options;
  const spec = relativeSpec(testPath, file, jsStyle);
  const subject = toPascal(path.posix.basename(file));
  const named = runtimeExports.filter((name) => name !== "default").slice(0, 6);
  const hasDefault = runtimeExports.includes("default");
  const isComponentFile = /\.[jt]sx$/.test(file);

  const imports: string[] = [];

  if (framework === "vitest") {
    imports.push('import { describe, expect, it } from "vitest";');
  } else if (framework === "node-test") {
    imports.push('import { describe, it } from "node:test";');
    imports.push('import assert from "node:assert/strict";');
  }

  if (isComponentFile && hasTestingLibrary) {
    imports.push('import { render, screen } from "@testing-library/react";');
  }

  const importNames = [hasDefault ? subject : "", named.length ? `{ ${named.join(", ")} }` : ""]
    .filter(Boolean)
    .join(", ");

  if (importNames) imports.push(`import ${importNames} from "${spec}";`);

  const assertFor = (value: string) =>
    framework === "node-test"
      ? `assert.ok(${value});`
      : `expect(${value}).toBeDefined();`;

  const cases: string[] = [];
  const subjects = [...(hasDefault ? [subject] : []), ...named];

  for (const name of subjects) {
    const isComponent = isComponentFile && /^[A-Z]/.test(name);

    if (isComponent && hasTestingLibrary) {
      cases.push(
        `  it("renders ${name}", () => {\n    render(<${name} />);\n    // TODO: assert what the user should see, for example screen.getByRole(...)\n    ${assertFor("screen")}\n  });`,
      );
    } else {
      cases.push(
        `  it("${name} returns the expected result", () => {\n    // TODO: arrange the input\n    // TODO: act by calling ${name}\n    ${assertFor(name)}\n  });`,
      );
    }
  }

  if (cases.length === 0) {
    cases.push('  it("works", () => {\n    // TODO: add assertions\n  });');
  }

  return `${imports.join("\n")}${imports.length ? "\n\n" : ""}describe("${path.posix.basename(file)}", () => {\n${cases.join("\n\n")}\n});\n`;
}

/* -------------------------------------------------------------------------- */
/*  Run commands                                                              */
/* -------------------------------------------------------------------------- */

function buildCommands(options: {
  tests: ImpactedTest[];
  changedSources: string[];
  runner: { unit: TestFramework; e2e: TestFramework };
  manager: PackageManager;
  runAll: boolean;
  hasTestScript: boolean;
}): RunCommand[] {
  const { tests, changedSources, runner, manager, runAll, hasTestScript } = options;
  const exec = executorFor(manager);
  const commands: RunCommand[] = [];

  if (runAll && hasTestScript) {
    commands.push({
      label: "Run the full suite",
      command: testScriptFor(manager),
      description:
        "A configuration or dependency file changed, so any test could be affected.",
      testCount: 0,
    });
  }

  const groups = new Map<TestFramework, string[]>();
  for (const test of tests) {
    const list = groups.get(test.framework) ?? [];
    list.push(test.filePath);
    groups.set(test.framework, list);
  }

  const frameworkLabel: Record<TestFramework, string> = {
    vitest: "Vitest",
    jest: "Jest",
    playwright: "Playwright",
    cypress: "Cypress",
    mocha: "Mocha",
    "node-test": "Node test runner",
    unknown: "test runner",
  };

  for (const [framework, files] of groups) {
    const listed = files.slice(0, MAX_COMMAND_FILES);
    const args = listed.map(shellQuote).join(" ");
    let command: string;

    switch (framework) {
      case "vitest":
        command = `${exec} vitest run ${args}`;
        break;
      case "jest":
        command = `${exec} jest ${args}`;
        break;
      case "mocha":
        command = `${exec} mocha ${args}`;
        break;
      case "node-test":
        command = `node --test ${args}`;
        break;
      case "playwright":
        command = `${exec} playwright test ${args}`;
        break;
      case "cypress":
        command = `${exec} cypress run --spec ${shellQuote(listed.join(","))}`;
        break;
      default:
        command = listed.join("\n");
    }

    commands.push({
      label:
        framework === "unknown"
          ? "Impacted test files"
          : `Run impacted ${frameworkLabel[framework]} tests`,
      command,
      description:
        framework === "unknown"
          ? "No test runner was detected, so these are the files to run with your own runner."
          : `Run from the project folder.${
              files.length > listed.length
                ? ` Showing the first ${listed.length} of ${files.length} files.`
                : ""
            }`,
      testCount: files.length,
    });
  }

  if (
    (runner.unit === "vitest" || runner.unit === "jest") &&
    changedSources.length > 0 &&
    changedSources.length <= 40
  ) {
    const args = changedSources.map(shellQuote).join(" ");

    commands.push({
      label: "Let the runner find related tests",
      command:
        runner.unit === "vitest"
          ? `${exec} vitest related --run ${args}`
          : `${exec} jest --findRelatedTests ${args} --passWithNoTests`,
      description:
        "A cross-check: the runner works out related tests from its own module graph.",
      testCount: 0,
    });
  }

  return commands;
}

/* -------------------------------------------------------------------------- */
/*  Main analysis                                                             */
/* -------------------------------------------------------------------------- */

const CONFIG_REASON: Array<[RegExp, string]> = [
  [/package\.json$/, "package.json changed: dependency or script changes can affect every test."],
  [/(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/, "A lockfile changed, so installed dependency versions may differ."],
  [/tsconfig[^/]*\.json$|jsconfig\.json$/, "A TypeScript configuration changed, which can change how every file compiles."],
  [/setupTests|\.setup\./, "A test setup file changed, and it runs before every test."],
  [/\.config\.|\.babelrc|\.mocharc/, "A build or test runner configuration changed."],
];

function configReason(file: string): string {
  return (
    CONFIG_REASON.find(([pattern]) => pattern.test(file))?.[1] ??
    `${file} is a configuration file and may affect every test.`
  );
}

export async function analyzeTestImpact(
  projectPath: string,
  options: {
    baseRef?: string;
    changedFiles?: string[];
    testTypes?: TestTypeFilter;
    maxDepth?: number;
    includeTypeOnly?: boolean;
    includeUntracked?: boolean;
  } = {},
): Promise<TestImpactReport> {
  const testTypes = options.testTypes ?? "all";
  const includeTypeOnly = options.includeTypeOnly ?? true;
  const includeUntracked = options.includeUntracked ?? true;
  const maxDepth = options.maxDepth;

  if (!["all", "unit", "e2e"].includes(testTypes)) {
    throw new Error("testTypes must be one of all, unit, or e2e.");
  }

  if (
    maxDepth !== undefined &&
    (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 50)
  ) {
    throw new Error("maxDepth must be a whole number from 1 to 50.");
  }

  const explicit = (options.changedFiles ?? [])
    .map((file) => file.trim())
    .filter(Boolean)
    .map((file) => validateRelative(file, "changedFiles"));

  if (explicit.length > 200) {
    throw new Error("changedFiles can contain at most 200 files.");
  }

  const resolved = await resolveProjectPath(projectPath);
  const root = fs.realpathSync(resolved.projectPath);
  const warnings: string[] = [];

  const warn = (message: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message);
    else if (warnings.length === MAX_WARNINGS) {
      warnings.push("Further warnings were omitted.");
    }
  };

  /* ---- Read the project ---- */

  const discovered = discoverFiles(root);

  if (discovered.codeFiles.length === 0) {
    throw new Error("No JavaScript or TypeScript files were found in the project.");
  }

  if (discovered.truncated) {
    warn(
      `Only the first ${MAX_FILES} files were analyzed. Narrow the project path for complete results.`,
    );
  }

  /* ---- Find what changed ---- */

  let rawChanges: RawChange[];
  let baseline: TestImpactReport["baseline"];

  if (explicit.length > 0) {
    rawChanges = [...new Set(explicit)].map((file) => {
      const exists = fs.existsSync(path.join(root, file));
      if (!exists) warn(`${file} does not exist, so it is treated as a deleted file.`);
      return { path: file, status: exists ? "modified" : "deleted" } as RawChange;
    });
    baseline = { kind: "files", label: `${plural(rawChanges.length, "specified file")}` };
  } else {
    await ensureGitRepository(root);
    const baseRef = validateRef(options.baseRef ?? "HEAD");
    const result = await gitChanges(root, baseRef, includeUntracked);
    rawChanges = result.changes;
    baseline = { kind: "git-ref", label: baseRef, commit: result.commit };
  }

  const deleted = new Set<string>();
  for (const change of rawChanges) {
    if (change.status === "deleted") deleted.add(change.path);
    if (change.status === "renamed" && change.oldPath) deleted.add(change.oldPath);
  }

  /* ---- Parse every file ---- */

  const infos = new Map<string, FileInfo>();

  for (const rel of discovered.codeFiles) {
    try {
      const absolute = path.join(root, rel);
      if (fs.statSync(absolute).size > MAX_FILE_BYTES) {
        warn(`Skipped ${rel} because it is larger than 1 MB.`);
        continue;
      }
      infos.set(rel, parseFile(rel, fs.readFileSync(absolute, "utf8")));
    } catch {
      warn(`Could not parse ${rel}.`);
    }
  }

  const testInfos = [...infos.values()].filter((info) => info.isTest);
  const testFiles = new Set(testInfos.map((info) => info.rel));

  const fileSet = new Set<string>([...discovered.codeFiles, ...discovered.assetFiles]);
  const configs = loadPathConfigs(root, discovered.configFiles);
  const resolve = createResolver(fileSet, configs);
  const graph = buildGraph(infos, resolve, deleted);

  const pkg = readPackage(root);
  const runner = detectRunners(pkg, testInfos);
  const manager = detectPackageManager(root);
  const runnerDetected = runner.unit !== "unknown" || runner.e2e !== "unknown";

  if (testInfos.length === 0) {
    warn(
      "No test files were found. Test files are detected by names like *.test.ts and *.spec.ts or by folders such as __tests__ and e2e.",
    );
  } else if (!runnerDetected) {
    warn(
      "No test runner was found in package.json, so commands list the files without a runner.",
    );
  }

  /* ---- Classify the changes ---- */

  const changedFiles: ChangedFile[] = [];
  let ignoredChangeCount = 0;
  const changeByPath = new Map<string, ChangedFile>();

  for (const change of rawChanges) {
    const segments = change.path.split("/");
    const hidden = segments.some(
      (segment) => segment.startsWith(".") && !GLOBAL_CONFIG_PATTERN.test(segment),
    );
    const inIgnored = segments.some((segment) => IGNORED_DIRS.has(segment));
    const kind = hidden || inIgnored ? undefined : classifyChanged(change.path, testFiles.has(change.path));

    if (!kind) {
      ignoredChangeCount++;
      continue;
    }

    const entry: ChangedFile = {
      path: change.path,
      status: change.status,
      oldPath: change.oldPath,
      kind,
      exports: exportsLabel(infos.get(change.path)).slice(0, 12),
      impactedTests: 0,
    };

    changedFiles.push(entry);
    changeByPath.set(entry.path, entry);
  }

  if (ignoredChangeCount > 0) {
    warn(
      `Ignored ${plural(ignoredChangeCount, "changed file")} that ${ignoredChangeCount === 1 ? "is" : "are"} not code, tests, assets or configuration.`,
    );
  }

  changedFiles.sort((a, b) => a.path.localeCompare(b.path));

  const traced = changedFiles.slice(0, MAX_TRACED_CHANGES);
  if (changedFiles.length > traced.length) {
    warn(
      `${changedFiles.length} files changed. Only the first ${MAX_TRACED_CHANGES} were traced to tests.`,
    );
  }

  /* ---- Trace changes to tests ---- */

  const reasonsByTest = new Map<string, ImpactReason[]>();
  const hitsByChanged = new Map<string, Set<string>>();
  const reasonsByChanged = new Map<string, ImpactReason[]>();
  const runAllReasons: string[] = [];

  const addReason = (test: string, reason: ImpactReason) => {
    const list = reasonsByTest.get(test) ?? [];
    list.push(reason);
    reasonsByTest.set(test, list);

    const set = hitsByChanged.get(reason.changedFile) ?? new Set<string>();
    set.add(test);
    hitsByChanged.set(reason.changedFile, set);

    const byChanged = reasonsByChanged.get(reason.changedFile) ?? [];
    byChanged.push(reason);
    reasonsByChanged.set(reason.changedFile, byChanged);
  };

  const testsByBase = new Map<string, string[]>();
  for (const info of testInfos) {
    const base = path.posix
      .basename(info.rel)
      .replace(/\.(test|spec|cy|e2e|pw)\.[cm]?[jt]sx?$/, "")
      .replace(/\.[cm]?[jt]sx?$/, "");
    const list = testsByBase.get(base) ?? [];
    list.push(info.rel);
    testsByBase.set(base, list);
  }

  const depthLimit = maxDepth ?? Number.POSITIVE_INFINITY;

  for (const change of traced) {
    if (change.kind === "config") {
      runAllReasons.push(configReason(change.path));
      continue;
    }

    if (change.kind === "test") {
      if (change.status !== "deleted" && testFiles.has(change.path)) {
        addReason(change.path, {
          changedFile: change.path,
          changeStatus: change.status,
          relation: "changed-test",
          distance: 0,
          via: [change.path],
        });
      }
      continue;
    }

    if (change.path.endsWith(".snap")) {
      const snapDir = path.posix.dirname(change.path);
      const parent = path.posix.dirname(snapDir);
      const name = path.posix.basename(change.path, ".snap");
      const candidate = [
        snapDir.endsWith("__snapshots__") ? `${parent === "." ? "" : `${parent}/`}${name}` : `${snapDir === "." ? "" : `${snapDir}/`}${name}`,
      ].find((file) => testFiles.has(file));

      if (candidate) {
        addReason(candidate, {
          changedFile: change.path,
          changeStatus: change.status,
          relation: "snapshot",
          distance: 0,
          via: [candidate, change.path],
        });
      }
      continue;
    }

    const startFlow: Flow =
      change.status === "deleted" || change.kind === "asset"
        ? "*"
        : exportFlow(infos.get(change.path));

    const starts = [change.path];
    if (change.status === "renamed" && change.oldPath) starts.push(change.oldPath);

    const merged = new Map<string, TraceHit>();

    for (const start of starts) {
      const flow: Flow = start === change.oldPath ? "*" : startFlow;
      const strong = trace(graph, start, flow, true, depthLimit, testFiles);

      for (const [test, hit] of strong) {
        if (!merged.has(test)) merged.set(test, hit);
      }

      if (includeTypeOnly) {
        const all = trace(graph, start, flow, false, depthLimit, testFiles);
        for (const [test, hit] of all) {
          if (!strong.has(test) && !merged.has(test) && hit.weak) merged.set(test, hit);
        }
      }
    }

    for (const [test, hit] of merged) {
      const relation: Relation = hit.stale
        ? "stale-import"
        : hit.weak === "type"
          ? "type-only"
          : hit.weak === "mock"
            ? "mock"
            : hit.distance === 1
              ? "direct"
              : "transitive";

      addReason(test, {
        changedFile: change.path,
        changeStatus: change.status,
        relation,
        distance: hit.distance,
        via: hit.via.slice(0, MAX_VIA_LENGTH),
      });
    }

    // Naming convention: foo.ts is tested by foo.test.ts even without an import.
    if (change.status !== "deleted" && change.kind === "source") {
      const base = path.posix.basename(change.path).replace(/\.[cm]?[jt]sx?$/, "");

      for (const test of testsByBase.get(base) ?? []) {
        if (merged.has(test)) continue;
        if (reasonsByTest.get(test)?.some((reason) => reason.changedFile === change.path)) continue;

        addReason(test, {
          changedFile: change.path,
          changeStatus: change.status,
          relation: "naming",
          distance: 0,
          via: [test, change.path],
        });
      }
    }
  }

  /* ---- Build the impacted tests ---- */

  const allImpacted: ImpactedTest[] = [];

  for (const [file, reasons] of reasonsByTest) {
    const info = infos.get(file);
    if (!info) continue;

    const kind = testKindOf(file, info.framework);
    const framework: TestFramework =
      info.framework ?? (kind === "e2e" ? runner.e2e : runner.unit);

    const ordered = [...reasons].sort(
      (a, b) =>
        RELATION_ORDER.indexOf(a.relation) - RELATION_ORDER.indexOf(b.relation) ||
        a.distance - b.distance ||
        a.changedFile.localeCompare(b.changedFile),
    );

    const reached = new Set(reasons.map((reason) => reason.changedFile)).size;
    const strongDistances = reasons
      .filter((reason) => ["direct", "transitive", "stale-import"].includes(reason.relation))
      .map((reason) => reason.distance);

    allImpacted.push({
      id: createHash("sha1").update(file).digest("hex").slice(0, 10),
      filePath: file,
      kind,
      framework,
      testCases: info.testCases,
      priority: priorityFor(reasons),
      summary: summarize(reasons, reached),
      nearestDistance: strongDistances.length ? Math.min(...strongDistances) : 0,
      changedFilesReached: reached,
      reasonCount: reasons.length,
      reasons: ordered.slice(0, MAX_REASONS),
    });
  }

  const matchesFilter = (kind: TestKind) =>
    testTypes === "all" || (testTypes === "e2e" ? kind === "e2e" : kind !== "e2e");

  const universe = testInfos.filter((info) =>
    matchesFilter(testKindOf(info.rel, info.framework)),
  );

  const impacted = allImpacted
    .filter((test) => matchesFilter(test.kind))
    .sort(
      (a, b) =>
        priorityRank(a.priority) - priorityRank(b.priority) ||
        b.changedFilesReached - a.changedFilesReached ||
        a.nearestDistance - b.nearestDistance ||
        a.filePath.localeCompare(b.filePath),
    );

  const listed = impacted.slice(0, MAX_LISTED_TESTS);
  if (impacted.length > listed.length) {
    warn(`Showing the first ${MAX_LISTED_TESTS} of ${impacted.length} impacted tests.`);
  }

  for (const [file, hits] of hitsByChanged) {
    const entry = changeByPath.get(file);
    if (entry) {
      entry.impactedTests = [...hits].filter((test) => {
        const kind = testKindOf(test, infos.get(test)?.framework);
        return matchesFilter(kind);
      }).length;
    }
  }

  /* ---- Coverage gaps ---- */

  const placementCounts = { mirror: 0, colocated: 0, spec: 0, test: 0 };
  for (const info of testInfos) {
    if (/(^|\/)__tests__\//.test(info.rel)) placementCounts.mirror++;
    else placementCounts.colocated++;
    if (/\.spec\./.test(info.rel)) placementCounts.spec++;
    else if (/\.test\./.test(info.rel)) placementCounts.test++;
  }

  const convention = {
    mirrorFolder: placementCounts.mirror > placementCounts.colocated,
    suffix: (placementCounts.spec > placementCounts.test ? "spec" : "test") as "test" | "spec",
  };

  const gaps: CoverageGap[] = [];

  for (const change of changedFiles) {
    if (change.kind !== "source" || change.status === "deleted") continue;
    if (/\.d\.[cm]?ts$/.test(change.path) || TEST_DIR_PATTERN.test(change.path)) continue;
    if (/\.(stories|config)\.[cm]?[jt]sx?$/.test(change.path)) continue;

    const info = infos.get(change.path);
    if (!info || info.isBarrel) continue;

    const runtimeExports = exportsLabel(info);
    if (runtimeExports.length === 0) continue;

    const reasons = reasonsByChanged.get(change.path) ?? [];
    const hasStrong = reasons.some((reason) =>
      ["direct", "transitive", "changed-test", "snapshot", "stale-import"].includes(reason.relation),
    );

    if (hasStrong) continue;

    const isNew = change.status === "added" || change.status === "untracked";
    const weakOnly = reasons.length > 0;
    const severity: GapSeverity = weakOnly ? "low" : isNew ? "high" : "medium";

    const testPath = suggestTestPath(change.path, convention);
    const dir = path.posix.dirname(change.path);

    gaps.push({
      id: createHash("sha1").update(`gap:${change.path}`).digest("hex").slice(0, 10),
      filePath: change.path,
      status: change.status,
      severity,
      reason: weakOnly
        ? "Tests only reach this file through type-only imports, mocks or a matching name, so its behavior is not exercised."
        : isNew
          ? `New file with ${plural(runtimeExports.length, "export")} and no test that reaches it.`
          : "Changed file that no test imports, directly or through other modules.",
      runtimeExports: runtimeExports.slice(0, 12),
      suggestedTestPath: testPath,
      skeleton: buildSkeleton({
        file: change.path,
        testPath,
        runtimeExports,
        framework: runner.unit === "unknown" ? "jest" : runner.unit,
        jsStyle: graph.jsExtensionStyle,
        hasTestingLibrary: pkg.deps.has("@testing-library/react"),
      }),
      neighborTests: testInfos
        .filter((test) => path.posix.dirname(test.rel) === dir || path.posix.dirname(test.rel) === `${dir}/__tests__`)
        .map((test) => test.rel)
        .slice(0, 3),
    });
  }

  const gapRank: Record<GapSeverity, number> = { high: 0, medium: 1, low: 2 };
  gaps.sort(
    (a, b) =>
      gapRank[a.severity] - gapRank[b.severity] ||
      b.runtimeExports.length - a.runtimeExports.length ||
      a.filePath.localeCompare(b.filePath),
  );

  const listedGaps = gaps.slice(0, MAX_GAPS);

  /* ---- Run commands and totals ---- */

  const runAllRequired = runAllReasons.length > 0;

  const changedSources = changedFiles
    .filter((change) => change.kind === "source" && change.status !== "deleted")
    .map((change) => change.path);

  const commands = buildCommands({
    tests: impacted,
    changedSources,
    runner,
    manager,
    runAll: runAllRequired,
    hasTestScript: Boolean(pkg.scripts.test),
  });

  const summary: Record<Priority, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const test of impacted) summary[test.priority]++;

  const totalTestCases = universe.reduce((sum, info) => sum + info.testCases, 0);
  const impactedTestCases = impacted.reduce((sum, test) => sum + test.testCases, 0);

  const reductionPercent =
    universe.length > 0
      ? Math.max(0, Math.round((1 - impacted.length / universe.length) * 100))
      : 0;

  const blastRadius: BlastRadiusFile[] = changedFiles
    .filter((change) => change.kind === "source" || change.kind === "asset")
    .map((change) => {
      const tests = hitsByChanged.get(change.path) ?? new Set<string>();
      const direct = [...tests].filter((test) =>
        reasonsByTest
          .get(test)
          ?.some(
            (reason) =>
              reason.changedFile === change.path &&
              (reason.relation === "direct" || reason.relation === "stale-import"),
          ),
      ).length;

      return {
        filePath: change.path,
        status: change.status,
        impactedTests: change.impactedTests,
        directTests: direct,
      };
    })
    .filter((item) => item.impactedTests > 0)
    .sort(
      (a, b) =>
        b.impactedTests - a.impactedTests ||
        b.directTests - a.directTests ||
        a.filePath.localeCompare(b.filePath),
    )
    .slice(0, MAX_HOTSPOTS);

  return {
    success: true,
    tool: "analyze_test_impact",
    projectPath: root,
    baseline,
    testTypes,
    maxDepth,
    includeTypeOnly,
    includeUntracked,
    runner: { unit: runner.unit, e2e: runner.e2e, packageManager: manager, detected: runnerDetected },
    totalFiles: discovered.codeFiles.length,
    totalTests: universe.length,
    totalTestCases,
    changedFileCount: changedFiles.length,
    ignoredChangeCount,
    changedFiles,
    impactedTestCount: impacted.length,
    impactedTestCases,
    skippedTests: Math.max(0, universe.length - impacted.length),
    reductionPercent,
    impactedTests: listed,
    coverageGaps: listedGaps,
    commands,
    runAll: { required: runAllRequired, reasons: runAllReasons },
    summary,
    blastRadius,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/*  MCP registration                                                          */
/* -------------------------------------------------------------------------- */

export function registerAnalyzeTestImpactTool(server: McpServer) {
  server.registerTool(
    "analyze_test_impact",
    {
      description:
        "Find which tests are affected by the code that changed. Uses git changes since a baseline ref (default HEAD, including untracked files) or an explicit list of files, builds an import graph with the TypeScript parser (aliases, barrel files, type-only imports, mocks, deleted files), and returns the tests to run ranked by priority with the dependency chain that explains each one, changed files that no test covers with a starter test, and copy-ready commands for the detected test runner.",
      inputSchema: z.object({
        projectPath: z
          .string()
          .describe("Absolute path to the project directory"),
        baseRef: z
          .string()
          .optional()
          .describe(
            "Git branch, tag or commit to compare against. Default HEAD (uncommitted changes). For a branch, only changes since the branches diverged are used.",
          ),
        changedFiles: z
          .array(z.string())
          .max(200)
          .optional()
          .describe(
            "Files, relative to projectPath, to analyze instead of reading git. Useful to ask which tests cover a file.",
          ),
        testTypes: z
          .enum(["all", "unit", "e2e"])
          .optional()
          .describe("Which tests to include: all (default), unit and integration, or e2e."),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum number of imports between a test and a changed file. Default unlimited."),
        includeTypeOnly: z
          .boolean()
          .optional()
          .describe("Also list tests linked only by type imports or mocks, at low priority. Default true."),
        includeUntracked: z
          .boolean()
          .optional()
          .describe("Include new files that git does not track yet. Default true."),
      }),
    },
    async ({
      projectPath,
      baseRef,
      changedFiles,
      testTypes,
      maxDepth,
      includeTypeOnly,
      includeUntracked,
    }) => {
      try {
        const report = await analyzeTestImpact(projectPath, {
          baseRef,
          changedFiles,
          testTypes,
          maxDepth,
          includeTypeOnly,
          includeUntracked,
        });

        return {
          content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
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
                  tool: "analyze_test_impact",
                  error:
                    error instanceof Error
                      ? error.message
                      : "Failed to analyze test impact.",
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
