import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  isManagedRepositoryPath,
  resolveProjectPath,
} from "../utils/projectResolver.js";

const execFileAsync = promisify(execFile);

export type CoverageUnavailableReason =
  | "no-test-framework"
  | "no-active-tests"
  | "no-coverage-report"
  | "generation-failed"
  | "unsupported-runner"
  | "unreadable-report";

export interface CoverageStatus {
  available: boolean;
  source: "existing-report" | "generated" | "none";
  reportPath?: string;
  reason?: CoverageUnavailableReason;
  title?: string;
  message?: string;
  suggestions: string[];
}

export interface CoverageMetrics {
  line?: number;
  statement?: number;
  branch?: number;
  function?: number;
}

export interface LineRange {
  start: number;
  end: number;
}

export interface UncoveredFunction {
  name: string;
  line: number;
}

export interface UncoveredBranch {
  line: number;
  type: string;
}

export interface SourceFileSummary {
  filePath: string;
  linkedTestFiles: string[];
  coverage?: CoverageMetrics;
  uncoveredLineCount?: number;
}

export interface FileCoverageDetail {
  filePath: string;
  linkedTestFiles: string[];
  coverage?: CoverageMetrics;
  /** false when only coverage-summary.json exists (percentages, no line data). */
  hasLineDetail: boolean;
  /** true when no test ever executed any line of this file. */
  neverExecuted?: boolean;
  uncoveredLines: LineRange[];
  uncoveredFunctions: UncoveredFunction[];
  uncoveredBranches: UncoveredBranch[];
  source?: string;
  sourceTruncated?: boolean;
}

export interface TestCoverageReport {
  success: boolean;
  tool: "analyze_test_coverage";
  projectPath: string;
  totalSourceFiles: number;
  totalTestFiles: number;
  totalTests: number;
  sourceFilesWithTests: number;
  sourceFilesWithoutTests: number;
  coverage: CoverageMetrics;
  testFrameworks: string[];
  testFiles: {
    filePath: string;
    testCount: number;
    matchingSourceFiles: string[];
  }[];
  untestedSourceFiles: string[];
  coverageStatus: CoverageStatus;
  /** Per source file: linked tests and coverage (when a report is available). */
  sourceFiles: SourceFileSummary[];
  /** Only present when `filePath` is requested: full detail for that file. */
  fileDetail?: FileCoverageDetail;
  scope: "project" | "file";
  warnings: string[];
}

const TEST_PATTERNS = [
  /\.test\.[cm]?[jt]sx?$/i,
  /\.spec\.[cm]?[jt]sx?$/i,
  /(^|\/)__tests__(\/|$)/i,
];

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
]);

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage",
  ".next", ".turbo", ".cache", "out",
]);

function isTestFile(filePath: string): boolean {
  return TEST_PATTERNS.some((pattern) =>
    pattern.test(filePath.replaceAll("\\", "/")),
  );
}

function walkFiles(root: string): string[] {
  const files: string[] = [];

  function visit(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".storybook") continue;
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;

      const absolute = path.join(dir, entry.name);

      if (entry.isDirectory()) visit(absolute);
      else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(path.extname(entry.name))
      ) {
        files.push(absolute);
      }
    }
  }

  visit(root);
  return files;
}

function readPackage(projectPath: string): Record<string, any> {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(projectPath, "package.json"), "utf8"),
    );
  } catch {
    return {};
  }
}

function detectFrameworks(projectPath: string): string[] {
  const pkg = readPackage(projectPath);
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };

  const result: string[] = [];
  if (deps["react-scripts"]) result.push("Create React App");
  if (deps.vitest) result.push("Vitest");
  if (deps.jest || deps["react-scripts"]) result.push("Jest");
  if (deps["@playwright/test"]) result.push("Playwright");
  if (deps.cypress) result.push("Cypress");
  if (deps.mocha) result.push("Mocha");
  if (deps.jasmine) result.push("Jasmine");
  if (deps["@testing-library/react"]) result.push("React Testing Library");

  return result;
}

function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === quote || (quote !== "`" && ch === "\n")) quote = null;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      out += " ";
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

function countTests(source: string): number {
  const code = stripComments(source);
  return (
    code.match(
      /(?<![.\w$])(?:it|test)(?:\.(?:only|skip|todo|concurrent|each))?\s*\(/g,
    ) ?? []
  ).length;
}

function resolveRelativeImport(
  importer: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;

  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.js"),
    path.join(base, "index.jsx"),
  ];

  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function findSourceImports(
  testFile: string,
  projectPath: string,
  sourceFiles: Set<string>,
): string[] {
  let source = "";
  try {
    source = fs.readFileSync(testFile, "utf8");
  } catch {
    return [];
  }

  const imports: string[] = [];
  const regex =
    /(?:import\s+(?:[\s\S]*?\s+from\s+)?|require\s*\(\s*)["']([^"']+)["']/g;

  for (const match of source.matchAll(regex)) {
    const resolved = resolveRelativeImport(testFile, match[1]);
    if (resolved && sourceFiles.has(resolved)) {
      imports.push(path.relative(projectPath, resolved).replaceAll("\\", "/"));
    }
  }

  return [...new Set(imports)];
}

function findSourceByTestName(
  testFile: string,
  projectPath: string,
  sourceFiles: Set<string>,
): string[] {
  const testRelativePath = path
    .relative(projectPath, testFile)
    .replaceAll("\\", "/");

  const testName = path.basename(testRelativePath);
  const testDirectory = path.dirname(testRelativePath);

  const baseName = testName
    .replace(/\.(test|spec)\.[^.]+$/i, "")
    .replace(/\.[^.]+$/i, "");

  if (!baseName || baseName === testName) {
    return [];
  }

  const candidates = new Set<string>();

  // Example:
  // src/App.test.tsx -> src/App.tsx
  for (const extension of SOURCE_EXTENSIONS) {
    candidates.add(
      path.join(testDirectory, `${baseName}${extension}`),
    );
  }

  // Also support tests under __tests__:
  // src/__tests__/App.test.tsx -> src/App.tsx
  const normalizedDirectory = testDirectory.replaceAll("\\", "/");
  if (
    normalizedDirectory.endsWith("/__tests__") ||
    normalizedDirectory === "__tests__"
  ) {
    const parentDirectory = path.dirname(testDirectory);
    for (const extension of SOURCE_EXTENSIONS) {
      candidates.add(
        path.join(parentDirectory, `${baseName}${extension}`),
      );
    }
  }

  return [...candidates]
    .map((candidate) => path.normalize(candidate))
    .filter((candidate) => sourceFiles.has(path.resolve(projectPath, candidate)))
    .map((candidate) => candidate.replaceAll("\\", "/"));
}

function findMatchingSourceFiles(
  testFile: string,
  projectPath: string,
  sourceFiles: Set<string>,
): string[] {
  const importMatches = findSourceImports(
    testFile,
    projectPath,
    sourceFiles,
  );

  const nameMatches = findSourceByTestName(
    testFile,
    projectPath,
    sourceFiles,
  );

  return [...new Set([...importMatches, ...nameMatches])];
}


function findCoverageReport(projectPath: string): string | undefined {
  const candidates = [
    path.join(projectPath, "coverage", "coverage-summary.json"),
    path.join(projectPath, "coverage", "coverage-final.json"),
    path.join(projectPath, "coverage", "coverage.json"),
    path.join(projectPath, "coverage", "lcov.info"),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate));
}

function normalizeCoverageValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number(value.toFixed(2));
  }

  return undefined;
}

function calculateCoverageFromFinalJson(
  json: Record<string, any>,
): TestCoverageReport["coverage"] {
  let linesFound = 0;
  let linesHit = 0;
  let statementsFound = 0;
  let statementsHit = 0;
  let branchesFound = 0;
  let branchesHit = 0;
  let functionsFound = 0;
  let functionsHit = 0;

  for (const file of Object.values(json)) {
    const statementCounts = (file?.s ?? {}) as Record<string, number>;
    const statementMap = (file?.statementMap ?? {}) as Record<
      string,
      { start?: { line?: number } }
    >;

    // coverage-final.json has no line map: derive lines from the statement map.
    const lineHits = new Map<number, number>();
    for (const [id, location] of Object.entries(statementMap)) {
      const line = location?.start?.line;
      if (typeof line !== "number") continue;
      lineHits.set(
        line,
        Math.max(lineHits.get(line) ?? 0, statementCounts[id] ?? 0),
      );
    }

    const statementValues = Object.values(statementCounts);
    statementsFound += statementValues.length;
    statementsHit += statementValues.filter((value) => value > 0).length;

    if (lineHits.size > 0) {
      linesFound += lineHits.size;
      linesHit += [...lineHits.values()].filter((value) => value > 0).length;
    } else {
      // Older/odd reports that ship an explicit line map (`l`).
      const lineValues = Object.values(file?.l ?? {}) as number[];
      linesFound += lineValues.length;
      linesHit += lineValues.filter((value) => value > 0).length;
    }

    for (const value of Object.values(file?.b ?? {})) {
      const counts = Array.isArray(value) ? (value as number[]) : [];
      branchesFound += counts.length;
      branchesHit += counts.filter((count) => count > 0).length;
    }

    const functionValues = Object.values(file?.f ?? {}) as number[];
    functionsFound += functionValues.length;
    functionsHit += functionValues.filter((value) => value > 0).length;
  }

  const percentage = (hit: number, found: number) =>
    found > 0 ? Number(((hit / found) * 100).toFixed(2)) : undefined;

  return {
    line: percentage(linesHit, linesFound),
    statement: percentage(statementsHit, statementsFound),
    branch: percentage(branchesHit, branchesFound),
    function: percentage(functionsHit, functionsFound),
  };
}

function calculateCoverageFromLcov(
  content: string,
): TestCoverageReport["coverage"] {
  const totals = { LF: 0, LH: 0, FNF: 0, FNH: 0, BRF: 0, BRH: 0 };

  for (const rawLine of content.split(/\r?\n/)) {
    const match = rawLine.match(/^(LF|LH|FNF|FNH|BRF|BRH):(\d+)$/);
    if (match) totals[match[1] as keyof typeof totals] += Number(match[2]);
  }

  const percentage = (hit: number, found: number) =>
    found > 0 ? Number(((hit / found) * 100).toFixed(2)) : undefined;

  return {
    line: percentage(totals.LH, totals.LF),
    branch: percentage(totals.BRH, totals.BRF),
    function: percentage(totals.FNH, totals.FNF),
  };
}

function readCoverageFile(
  coveragePath: string,
): TestCoverageReport["coverage"] {
  try {
    const raw = fs.readFileSync(coveragePath, "utf8");

    if (coveragePath.endsWith(".info")) {
      return calculateCoverageFromLcov(raw);
    }

    const json = JSON.parse(raw);

    if (json.total) {
      return {
        line: normalizeCoverageValue(json.total.lines?.pct),
        statement: normalizeCoverageValue(json.total.statements?.pct),
        branch: normalizeCoverageValue(json.total.branches?.pct),
        function: normalizeCoverageValue(json.total.functions?.pct),
      };
    }

    if (!coveragePath.endsWith("coverage-summary.json")) {
      return calculateCoverageFromFinalJson(json);
    }

    return {};
  } catch {
    return {};
  }
}

interface FileCoverageData {
  metrics: CoverageMetrics;
  hasLineDetail: boolean;
  neverExecuted: boolean;
  uncoveredLines: number[];
  uncoveredFunctions: UncoveredFunction[];
  uncoveredBranches: UncoveredBranch[];
}

const MAX_SOURCE_CHARS = 300_000;

function safeRealpath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

// Report keys are absolute paths (or relative to the project). Map them to
// project-relative posix paths, tolerating symlinked roots (macOS /var vs /private/var).
function toProjectRelative(projectPath: string, key: string): string | undefined {
  const absolute = path.isAbsolute(key) ? key : path.resolve(projectPath, key);
  const roots = [projectPath, safeRealpath(projectPath)];

  for (const candidate of [absolute, safeRealpath(absolute)]) {
    for (const root of roots) {
      const relative = path.relative(root, candidate);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        return relative.replaceAll("\\", "/");
      }
    }
  }

  return undefined;
}

const percentOf = (hit: number, found: number): number | undefined =>
  found > 0 ? Number(((hit / found) * 100).toFixed(2)) : undefined;

function toRanges(lines: number[]): LineRange[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges: LineRange[] = [];

  for (const line of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && line === last.end + 1) last.end = line;
    else ranges.push({ start: line, end: line });
  }

  return ranges;
}

function parseSummaryFiles(
  json: Record<string, any>,
  projectPath: string,
  out: Map<string, FileCoverageData>,
) {
  for (const [key, value] of Object.entries(json)) {
    if (key === "total") continue;
    const relative = toProjectRelative(projectPath, key);
    if (!relative) continue;

    out.set(relative, {
      metrics: {
        line: normalizeCoverageValue(value?.lines?.pct),
        statement: normalizeCoverageValue(value?.statements?.pct),
        branch: normalizeCoverageValue(value?.branches?.pct),
        function: normalizeCoverageValue(value?.functions?.pct),
      },
      hasLineDetail: false,
      neverExecuted: false,
      uncoveredLines: [],
      uncoveredFunctions: [],
      uncoveredBranches: [],
    });
  }
}

function parseFinalJsonFiles(
  json: Record<string, any>,
  projectPath: string,
  out: Map<string, FileCoverageData>,
) {
  for (const [key, file] of Object.entries(json)) {
    const relative = toProjectRelative(projectPath, String(file?.path ?? key));
    if (!relative) continue;

    const statementCounts = (file?.s ?? {}) as Record<string, number>;
    const statementMap = (file?.statementMap ?? {}) as Record<string, any>;
    const lineHits = new Map<number, number>();

    for (const [id, location] of Object.entries(statementMap)) {
      const line = location?.start?.line;
      if (typeof line !== "number") continue;
      lineHits.set(line, Math.max(lineHits.get(line) ?? 0, statementCounts[id] ?? 0));
    }

    const uncoveredFunctions: UncoveredFunction[] = [];
    const functionCounts = (file?.f ?? {}) as Record<string, number>;
    const functionMap = (file?.fnMap ?? {}) as Record<string, any>;

    // Vitest/Istanbul emit a placeholder function for files no test ever loaded.
    const isEmptyReport = Object.values(functionMap).some(
      (meta) => meta?.name === "(empty-report)",
    );

    for (const [id, count] of Object.entries(functionCounts)) {
      if (count > 0 || isEmptyReport) continue;
      const meta = functionMap[id];
      uncoveredFunctions.push({
        name: meta?.name && meta.name !== "(anonymous)" ? String(meta.name) : "(anonymous)",
        line: Number(meta?.decl?.start?.line ?? meta?.loc?.start?.line ?? 0),
      });
    }

    const uncoveredBranches: UncoveredBranch[] = [];
    const branchCounts = (file?.b ?? {}) as Record<string, number[]>;
    const branchMap = (file?.branchMap ?? {}) as Record<string, any>;
    let branchesFound = 0;
    let branchesHit = 0;

    for (const [id, counts] of Object.entries(branchCounts)) {
      const meta = branchMap[id];
      (Array.isArray(counts) ? counts : []).forEach((count, index) => {
        if (isEmptyReport) return;
        branchesFound++;
        if (count > 0) {
          branchesHit++;
          return;
        }
        const line =
          meta?.locations?.[index]?.start?.line ?? meta?.loc?.start?.line ?? 0;
        uncoveredBranches.push({
          line: Number(line),
          type: String(meta?.type ?? "branch"),
        });
      });
    }

    const statementValues = Object.values(statementCounts);
    const lineValues = [...lineHits.values()];

    out.set(relative, {
      metrics: {
        line: percentOf(lineValues.filter((v) => v > 0).length, lineValues.length),
        statement: percentOf(
          statementValues.filter((v) => v > 0).length,
          statementValues.length,
        ),
        branch: percentOf(branchesHit, branchesFound),
        function: percentOf(
          Object.values(functionCounts).filter((v) => v > 0).length,
          Object.values(functionCounts).length,
        ),
      },
      hasLineDetail: true,
      neverExecuted:
        isEmptyReport || (lineValues.length > 0 && lineValues.every((v) => v === 0)),
      uncoveredLines: [...lineHits.entries()]
        .filter(([, hits]) => hits === 0)
        .map(([line]) => line),
      uncoveredFunctions,
      uncoveredBranches,
    });
  }
}

function parseLcovFiles(
  content: string,
  projectPath: string,
  out: Map<string, FileCoverageData>,
) {
  let record: {
    file: string;
    lines: Map<number, number>;
    functionLines: Map<string, number>;
    functionHits: Map<string, number>;
    branches: { line: number; taken: boolean }[];
  } | null = null;

  const finish = () => {
    if (!record) return;
    const relative = toProjectRelative(projectPath, record.file);

    if (relative) {
      const lineValues = [...record.lines.values()];
      const functionNames = [...record.functionLines.keys()];

      out.set(relative, {
        metrics: {
          line: percentOf(lineValues.filter((v) => v > 0).length, lineValues.length),
          branch: percentOf(
            record.branches.filter((b) => b.taken).length,
            record.branches.length,
          ),
          function: percentOf(
            functionNames.filter((n) => (record!.functionHits.get(n) ?? 0) > 0).length,
            functionNames.length,
          ),
        },
        hasLineDetail: true,
        neverExecuted: lineValues.length > 0 && lineValues.every((v) => v === 0),
        uncoveredLines: [...record.lines.entries()]
          .filter(([, hits]) => hits === 0)
          .map(([line]) => line),
        uncoveredFunctions: functionNames
          .filter((n) => (record!.functionHits.get(n) ?? 0) === 0)
          .map((n) => ({ name: n || "(anonymous)", line: record!.functionLines.get(n) ?? 0 })),
        uncoveredBranches: record.branches
          .filter((b) => !b.taken)
          .map((b) => ({ line: b.line, type: "branch" })),
      });
    }

    record = null;
  };

  for (const raw of content.split(/\r?\n/)) {
    if (raw.startsWith("SF:")) {
      finish();
      record = {
        file: raw.slice(3),
        lines: new Map(),
        functionLines: new Map(),
        functionHits: new Map(),
        branches: [],
      };
    } else if (!record) {
      continue;
    } else if (raw.startsWith("DA:")) {
      const [line, hits] = raw.slice(3).split(",");
      record.lines.set(Number(line), Number(hits));
    } else if (raw.startsWith("FN:")) {
      const separator = raw.indexOf(",");
      record.functionLines.set(raw.slice(separator + 1), Number(raw.slice(3, separator)));
    } else if (raw.startsWith("FNDA:")) {
      const separator = raw.indexOf(",");
      record.functionHits.set(raw.slice(separator + 1), Number(raw.slice(5, separator)));
    } else if (raw.startsWith("BRDA:")) {
      const [line, , , taken] = raw.slice(5).split(",");
      record.branches.push({
        line: Number(line),
        taken: taken !== "-" && Number(taken) > 0,
      });
    } else if (raw === "end_of_record") {
      finish();
    }
  }

  finish();
}

// Merge every report that exists: summary (percentages) < lcov < final json
// (the last two carry line-level detail, so they win).
function loadFileCoverage(projectPath: string): Map<string, FileCoverageData> {
  const out = new Map<string, FileCoverageData>();
  const dir = path.join(projectPath, "coverage");

  const readJson = (name: string): Record<string, any> | undefined => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      return undefined;
    }
  };

  const summary = readJson("coverage-summary.json");
  if (summary) parseSummaryFiles(summary, projectPath, out);

  try {
    parseLcovFiles(fs.readFileSync(path.join(dir, "lcov.info"), "utf8"), projectPath, out);
  } catch {
    // No lcov report.
  }

  const finalJson = readJson("coverage-final.json") ?? readJson("coverage.json");
  if (finalJson && !finalJson.total) parseFinalJsonFiles(finalJson, projectPath, out);

  return out;
}

function detectVitestCoverageProvider(
  projectPath: string,
): string | undefined {
  const pkg = readPackage(projectPath);
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };

  if (deps["@vitest/coverage-v8"]) return "@vitest/coverage-v8";
  if (deps["@vitest/coverage-istanbul"]) return "@vitest/coverage-istanbul";

  return undefined;
}

function isRemoteProject(projectPath: string): boolean {
  return /^(https?:\/\/|ssh:\/\/|git@)/i.test(projectPath.trim());
}

function getPackageManager(projectPath: string): {
  command: string;
  installArgs: string[];
  addDevArgs: string[];
} {
  if (fs.existsSync(path.join(projectPath, "pnpm-lock.yaml"))) {
    return {
      command: "pnpm",
      installArgs: ["install", "--frozen-lockfile"],
      addDevArgs: ["add", "-D"],
    };
  }

  if (fs.existsSync(path.join(projectPath, "yarn.lock"))) {
    return {
      command: "yarn",
      installArgs: ["install", "--frozen-lockfile"],
      addDevArgs: ["add", "-D"],
    };
  }

  return {
    command: "npm",
    installArgs: ["ci", "--ignore-scripts"],
    addDevArgs: ["install", "-D", "--ignore-scripts"],
  };
}

async function runCommand(
  command: string,
  args: string[],
  projectPath: string,
  timeout: number,
): Promise<{ success: boolean; stderr: string; stdout: string }> {
  const label = `${path.basename(command)} ${args.slice(0, 3).join(" ")}`;
  const startedAt = Date.now();
  // stderr (not stdout) so this is safe for stdio-based MCP transports.
  console.error(`[analyze-test-coverage] started: ${label}`);

  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd: projectPath,
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        CI: "true",
        // NODE_ENV=production would make npm skip devDependencies (vitest, jest).
        NODE_ENV: "test",
      },
    });

    console.error(
      `[analyze-test-coverage] finished: ${label} (${Math.round((Date.now() - startedAt) / 1000)}s)`,
    );
    return { success: true, stdout: String(stdout ?? ""), stderr: "" };
  } catch (error) {
    const failure = error as {
      stdout?: unknown;
      stderr?: unknown;
      killed?: boolean;
    };
    const timedOut = Boolean(failure.killed);

    console.error(
      `[analyze-test-coverage] ${timedOut ? "timed out" : "failed"}: ${label} (${Math.round((Date.now() - startedAt) / 1000)}s)`,
    );

    return {
      success: false,
      stdout: String(failure.stdout ?? ""),
      stderr: timedOut
        ? `Timed out after ${Math.round(timeout / 1000)}s.`
        : String(failure.stderr ?? "").trim(),
    };
  }
}

async function ensureRemoteDependencies(
  projectPath: string,
  warnings: string[],
): Promise<boolean> {
  if (fs.existsSync(path.join(projectPath, "node_modules"))) {
    return true;
  }

  const manager = getPackageManager(projectPath);
  const result = await runCommand(
    manager.command,
    manager.installArgs,
    projectPath,
    180_000,
  );

  if (!result.success) {
    warnings.push(
      result.stderr
        ? `Project dependency installation failed: ${result.stderr.slice(0, 1200)}`
        : "Project dependencies could not be installed in the temporary analyzed repository.",
    );
    return false;
  }

  return true;
}

async function installVitestCoverageProvider(
  projectPath: string,
  warnings: string[],
): Promise<boolean> {
  if (detectVitestCoverageProvider(projectPath)) return true;

  const pkg = readPackage(projectPath);
  const vitestVersion =
    pkg.dependencies?.vitest ?? pkg.devDependencies?.vitest;

  const installedVitestPath = path.join(
    projectPath,
    "node_modules",
    "vitest",
    "package.json",
  );

  let providerVersion = "";

  try {
    if (fs.existsSync(installedVitestPath)) {
      const installed = JSON.parse(fs.readFileSync(installedVitestPath, "utf8"));
      if (typeof installed.version === "string") {
        providerVersion = `@vitest/coverage-v8@${installed.version}`;
      }
    }
  } catch {
    // Fall back to the package's declared Vitest version below.
  }

  if (!providerVersion && typeof vitestVersion === "string") {
    const match = vitestVersion.match(/(\d+)\.(\d+)\.(\d+)/);
    if (match) {
      providerVersion = `@vitest/coverage-v8@^${match[1]}.${match[2]}.0`;
    }
  }

  if (!providerVersion) {
    providerVersion = "@vitest/coverage-v8";
  }

  const manager = getPackageManager(projectPath);
  const result = await runCommand(
    manager.command,
    [...manager.addDevArgs, providerVersion],
    projectPath,
    120_000,
  );

  if (!result.success) {
    warnings.push(
      result.stderr
        ? `Vitest coverage provider installation failed: ${result.stderr.slice(0, 1200)}`
        : "Vitest coverage provider could not be installed in the temporary analyzed repository.",
    );
    return false;
  }

  return true;
}

function hasLocalBinary(projectPath: string, binary: string): boolean {
  return fs.existsSync(path.join(projectPath, "node_modules", ".bin", binary));
}

async function runCoverageCommand(
  label: string,
  command: string,
  args: string[],
  projectPath: string,
  warnings: string[],
): Promise<string | undefined> {
  const result = await runCommand(command, args, projectPath, 180_000);
  const report = findCoverageReport(projectPath);

  if (!result.success) {
    warnings.push(
      report
        ? `${label} exited with a failure, but a coverage report was still produced.`
        : result.stderr
          ? `${label} coverage generation failed: ${result.stderr.slice(0, 1200)}`
          : `${label} coverage generation failed.`,
    );
  }

  return report;
}

// Only ever called for remote (cloned) projects, never for a user's local folder.
async function generateVitestCoverage(
  projectPath: string,
  warnings: string[],
): Promise<string | undefined> {
  if (!(await ensureRemoteDependencies(projectPath, warnings))) return undefined;

  if (
    !detectVitestCoverageProvider(projectPath) &&
    !(await installVitestCoverageProvider(projectPath, warnings))
  ) {
    return undefined;
  }

  if (!hasLocalBinary(projectPath, "vitest")) {
    warnings.push("Vitest is configured but the Vitest binary is unavailable.");
    return undefined;
  }

  return await runCoverageCommand(
    "Vitest",
    path.join(projectPath, "node_modules", ".bin", "vitest"),
    [
      "run",
      "--coverage",
      "--coverage.reporter=json-summary",
      "--coverage.reporter=json",
    ],
    projectPath,
    warnings,
  );
}

async function generateJestCoverage(
  projectPath: string,
  warnings: string[],
): Promise<string | undefined> {
  if (!(await ensureRemoteDependencies(projectPath, warnings))) return undefined;

  const pkg = readPackage(projectPath);
  const isCra = Boolean(
    pkg.dependencies?.["react-scripts"] || pkg.devDependencies?.["react-scripts"],
  );
  const reporters = [
    "--coverageReporters=json-summary",
    "--coverageReporters=json",
  ];

  if (isCra && hasLocalBinary(projectPath, "react-scripts")) {
    return await runCoverageCommand(
      "Jest",
      path.join(projectPath, "node_modules", ".bin", "react-scripts"),
      ["test", "--coverage", "--watchAll=false", ...reporters],
      projectPath,
      warnings,
    );
  }

  if (hasLocalBinary(projectPath, "jest")) {
    return await runCoverageCommand(
      "Jest",
      path.join(projectPath, "node_modules", ".bin", "jest"),
      ["--coverage", "--watch=false", "--runInBand", ...reporters],
      projectPath,
      warnings,
    );
  }

  warnings.push(
    "Jest was detected, but the Jest executable is not installed in the analyzed project.",
  );
  return undefined;
}

// Avoid re-running a failed install/test run on every request (e.g. every
// click on a file in the UI). Retried after a few minutes.
const GENERATION_RETRY_MS = 10 * 60 * 1000;
const generationFailures = new Map<string, { at: number; warnings: string[] }>();

const RUNNER_FRAMEWORKS = new Set([
  "Vitest",
  "Jest",
  "Mocha",
  "Jasmine",
  "Playwright",
  "Cypress",
]);

function buildUnavailableStatus(
  reason: CoverageUnavailableReason,
  projectPath: string,
): CoverageStatus {
  const pkg = readPackage(projectPath);
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };
  const isVite = Boolean(deps.vite);

  const runCoverageHint = deps.vitest
    ? "Run `npx vitest run --coverage --coverage.reporter=json-summary` in the project, then analyze again."
    : "Run your tests with coverage (for example `npx jest --coverage --coverageReporters=json-summary`), then analyze again.";

  const byReason: Record<
    CoverageUnavailableReason,
    { title: string; message: string; suggestions: string[] }
  > = {
    "no-test-framework": {
      title: "No test framework configured",
      message:
        "This project has no test runner in package.json, so there is nothing that can produce a coverage report.",
      suggestions: isVite
        ? [
            "Install Vitest with coverage: `npm install -D vitest @vitest/coverage-v8`.",
            'Add a script: `"test:coverage": "vitest run --coverage"`.',
            "Write at least one active test, then analyze again.",
          ]
        : [
            "Install a test runner such as Vitest or Jest, with a coverage provider.",
            "Write at least one active test, then analyze again.",
          ],
    },
    "no-active-tests": {
      title: "No active tests to measure",
      message:
        "Coverage needs executed tests. No active tests were found: test files are missing, empty, or fully commented out.",
      suggestions: [
        "Add or un-comment at least one `it(...)` / `test(...)` case.",
        "Then run the tests with coverage and analyze again.",
      ],
    },
    "no-coverage-report": {
      title: "No coverage report found",
      message:
        "A test runner was detected, but there is no report in the coverage/ folder. Local projects are never executed by the analyzer.",
      suggestions: [runCoverageHint],
    },
    "generation-failed": {
      title: "Coverage generation failed",
      message:
        "The analyzer tried to generate coverage in a temporary clone but the command failed. See Analysis Notes for the output.",
      suggestions: [
        "Clone the repo locally and run the tests with coverage there.",
        "Then analyze the local folder so the existing report is used.",
      ],
    },
    "unsupported-runner": {
      title: "Coverage generation not supported",
      message:
        "The detected test runner is not one the analyzer can run automatically (only Vitest and Jest are supported).",
      suggestions: [
        "Generate a coverage report with the `json-summary` or `lcov` reporter (for example with c8 or nyc).",
        "Place it in coverage/ and analyze the local folder.",
      ],
    },
    "unreadable-report": {
      title: "Coverage report is empty or unreadable",
      message:
        "A report exists in coverage/, but it contains no usable percentages. It is either empty or in an unsupported format.",
      suggestions: [
        "If it is empty, check the coverage `include` / `exclude` patterns in the test config: they may match no files.",
        "Otherwise use a supported format: `coverage-summary.json`, `coverage-final.json` or `lcov.info`.",
      ],
    },
  };

  return {
    available: false,
    source: "none",
    reason,
    ...byReason[reason],
  };
}

async function readCoverage(
  projectPath: string,
  isRemote: boolean,
  testStats: { totalTests: number },
): Promise<{
  coverage: TestCoverageReport["coverage"];
  warnings: string[];
  status: CoverageStatus;
}> {
  const warnings: string[] = [];
  const frameworks = detectFrameworks(projectPath);
  const hasRunner = frameworks.some((name) => RUNNER_FRAMEWORKS.has(name));
  const canGenerate =
    frameworks.includes("Vitest") ||
    frameworks.includes("Jest") ||
    frameworks.includes("Create React App");

  let coveragePath = findCoverageReport(projectPath);
  let source: "existing-report" | "generated" = "existing-report";
  let generationAttempted = false;

  // Generation executes project code, so it is limited to temporary clones
  // and skipped when there are no active tests to run.
  if (!coveragePath && isRemote && testStats.totalTests > 0 && canGenerate) {
    generationAttempted = true;
    const previousFailure = generationFailures.get(projectPath);

    if (previousFailure && Date.now() - previousFailure.at < GENERATION_RETRY_MS) {
      warnings.push(...previousFailure.warnings);
    } else {
      coveragePath = frameworks.includes("Vitest")
        ? await generateVitestCoverage(projectPath, warnings)
        : await generateJestCoverage(projectPath, warnings);
      source = "generated";

      if (coveragePath) generationFailures.delete(projectPath);
      else generationFailures.set(projectPath, { at: Date.now(), warnings: [...warnings] });
    }
  }

  if (coveragePath) {
    const coverage = readCoverageFile(coveragePath);
    const hasValue = Object.values(coverage).some((value) => value !== undefined);

    if (hasValue) {
      return {
        coverage,
        warnings,
        status: {
          available: true,
          source,
          reportPath: path
            .relative(projectPath, coveragePath)
            .replaceAll("\\", "/"),
          suggestions: [],
        },
      };
    }

    return {
      coverage: {},
      warnings,
      status: buildUnavailableStatus("unreadable-report", projectPath),
    };
  }

  let reason: CoverageUnavailableReason;
  if (!hasRunner) reason = "no-test-framework";
  else if (testStats.totalTests === 0) reason = "no-active-tests";
  else if (generationAttempted) reason = "generation-failed";
  else if (isRemote && !canGenerate) reason = "unsupported-runner";
  else reason = "no-coverage-report";

  return {
    coverage: {},
    warnings,
    status: buildUnavailableStatus(reason, projectPath),
  };
}

export async function analyzeTestCoverage(
  projectPath: string,
  filePath?: string,
): Promise<TestCoverageReport> {
  const resolvedProject = await resolveProjectPath(projectPath);
  const analysisPath = resolvedProject.projectPath;
  const toPosix = (value: string) => value.replaceAll("\\", "/");
  const relativeToProject = (file: string) =>
    toPosix(path.relative(analysisPath, file));

  const allFiles = walkFiles(analysisPath);
  const testFiles = allFiles.filter((file) =>
    isTestFile(relativeToProject(file)),
  );
  const testFileSet = new Set(testFiles);
  const sourceFiles = allFiles.filter((file) => !testFileSet.has(file));
  const sourceSet = new Set(sourceFiles);

  const warnings: string[] = [];

  const testReports = testFiles.map((testFile) => {
    let testCount = 0;
    try {
      testCount = countTests(fs.readFileSync(testFile, "utf8"));
    } catch {
      testCount = 0;
    }

    return {
      filePath: relativeToProject(testFile),
      testCount,
      matchingSourceFiles: findMatchingSourceFiles(
        testFile,
        analysisPath,
        sourceSet,
      ).map(toPosix),
    };
  });

  // A test file without active tests (empty / fully commented out) does not
  // actually exercise anything, so it must not mark source files as tested.
  for (const report of testReports) {
    if (report.testCount === 0) {
      warnings.push(
        `${report.filePath} contains no active tests (it may be empty or fully commented out), so it is not counted as covering ${
          report.matchingSourceFiles.length
            ? report.matchingSourceFiles.join(", ")
            : "any source file"
        }.`,
      );
    }
  }

  const testedSourceFiles = new Set(
    testReports
      .filter((item) => item.testCount > 0)
      .flatMap((item) => item.matchingSourceFiles),
  );

  let untestedSourceFiles = sourceFiles
    .map(relativeToProject)
    .filter((file) => !testedSourceFiles.has(file));

  let scopedTests = testReports;
  let scopedSources = sourceFiles;
  const requestedFile = filePath?.trim() ? toPosix(filePath.trim()) : undefined;

  if (requestedFile) {
    scopedSources = sourceFiles.filter(
      (file) => relativeToProject(file) === requestedFile,
    );
    scopedTests = testReports.filter((test) =>
      test.matchingSourceFiles.includes(requestedFile),
    );
    untestedSourceFiles = untestedSourceFiles.filter(
      (file) => file === requestedFile,
    );

    if (scopedSources.length === 0) {
      warnings.push(
        `File "${requestedFile}" was not found among the scanned source files.`,
      );
    }
  }

  const totalTests = testReports.reduce((sum, item) => sum + item.testCount, 0);

  // Remote = a GitHub URL, or an already-cloned path inside the resolver's
  // cache (the server may resolve the URL before calling this function).
  // The user's own local projects are never executed.
  const isRemote =
    resolvedProject.source === "github" ||
    isRemoteProject(projectPath) ||
    isManagedRepositoryPath(analysisPath);

  const coverageResult = await readCoverage(analysisPath, isRemote, {
    totalTests,
  });
  warnings.push(...coverageResult.warnings);

  const fileCoverage = coverageResult.status.available
    ? loadFileCoverage(analysisPath)
    : new Map<string, FileCoverageData>();

  const linkedTestsBySource = new Map<string, string[]>();
  for (const report of testReports) {
    if (report.testCount === 0) continue;
    for (const source of report.matchingSourceFiles) {
      linkedTestsBySource.set(source, [
        ...(linkedTestsBySource.get(source) ?? []),
        report.filePath,
      ]);
    }
  }

  const sourceSummaries: SourceFileSummary[] = scopedSources.map((file) => {
    const relative = relativeToProject(file);
    const data = fileCoverage.get(relative);

    return {
      filePath: relative,
      linkedTestFiles: linkedTestsBySource.get(relative) ?? [],
      coverage: data?.metrics,
      uncoveredLineCount: data?.hasLineDetail ? data.uncoveredLines.length : undefined,
    };
  });

  let fileDetail: FileCoverageDetail | undefined;

  if (requestedFile && scopedSources.length === 1) {
    const data = fileCoverage.get(requestedFile);
    let source: string | undefined;
    let sourceTruncated = false;

    try {
      const raw = fs.readFileSync(scopedSources[0], "utf8");
      sourceTruncated = raw.length > MAX_SOURCE_CHARS;
      source = sourceTruncated ? raw.slice(0, MAX_SOURCE_CHARS) : raw;
    } catch {
      source = undefined;
    }

    fileDetail = {
      filePath: requestedFile,
      linkedTestFiles: linkedTestsBySource.get(requestedFile) ?? [],
      coverage: data?.metrics,
      hasLineDetail: data?.hasLineDetail ?? false,
      neverExecuted: data?.neverExecuted ?? false,
      uncoveredLines: toRanges(data?.uncoveredLines ?? []),
      uncoveredFunctions: data?.uncoveredFunctions ?? [],
      uncoveredBranches: data?.uncoveredBranches ?? [],
      source,
      sourceTruncated,
    };
  }

  if (requestedFile && coverageResult.status.available && !fileDetail) {
    warnings.push(
      "Coverage percentages are project-wide, not limited to the selected file.",
    );
  }

  return {
    success: true,
    tool: "analyze_test_coverage",
    projectPath: resolvedProject.originalPath,
    totalSourceFiles: scopedSources.length,
    totalTestFiles: scopedTests.length,
    totalTests: scopedTests.reduce((sum, item) => sum + item.testCount, 0),
    sourceFilesWithTests: scopedSources.length - untestedSourceFiles.length,
    sourceFilesWithoutTests: untestedSourceFiles.length,
    coverage: coverageResult.coverage,
    testFrameworks: detectFrameworks(analysisPath),
    testFiles: scopedTests,
    untestedSourceFiles,
    coverageStatus: coverageResult.status,
    sourceFiles: sourceSummaries,
    fileDetail,
    scope: requestedFile ? "file" : "project",
    warnings,
  };
}

export function registerAnalyzeTestCoverageTool(server: McpServer) {
  server.registerTool(
    "analyze_test_coverage",
    {
      description:
        "Analyze test files, test counts, source-to-test relationships, untested source files, test frameworks, and available or generated coverage reports.",
      inputSchema: z.object({
        projectPath: z.string(),
        filePath: z.string().optional(),
      }),
    },
    async ({ projectPath, filePath }) => {
      try {
        const report = await analyzeTestCoverage(projectPath, filePath);

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
                  tool: "analyze_test_coverage",
                  error:
                    error instanceof Error
                      ? error.message
                      : "Failed to analyze test coverage.",
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