import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveProjectPath } from "../utils/projectResolver.js";

export interface TestCoverageReport {
  success: boolean;
  tool: "analyze_test_coverage";
  projectPath: string;
  totalSourceFiles: number;
  totalTestFiles: number;
  totalTests: number;
  sourceFilesWithTests: number;
  sourceFilesWithoutTests: number;
  coverage: {
    line?: number;
    statement?: number;
    branch?: number;
    function?: number;
  };
  testFrameworks: string[];
  testFiles: {
    filePath: string;
    testCount: number;
    matchingSourceFiles: string[];
  }[];
  untestedSourceFiles: string[];
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
  if (deps.vitest) result.push("Vitest");
  if (deps.jest) result.push("Jest");
  if (deps["@playwright/test"]) result.push("Playwright");
  if (deps.cypress) result.push("Cypress");
  if (deps.mocha) result.push("Mocha");
  if (deps.jasmine) result.push("Jasmine");
  if (deps["@testing-library/react"]) result.push("React Testing Library");

  return result;
}

function countTests(source: string): number {
  return (
    (source.match(/\b(?:it|test)\s*\(/g) ?? []).length +
    (source.match(/\b(?:it|test)\.(?:only|skip|todo)\s*\(/g) ?? []).length
  );
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

  return candidates.find((candidate) => fs.existsSync(candidate));
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
      imports.push(path.relative(projectPath, resolved));
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


function findCoverageSummary(projectPath: string): string | undefined {
  const candidates = [
    path.join(projectPath, "coverage", "coverage-summary.json"),
    path.join(projectPath, "coverage", "coverage-final.json"),
    path.join(projectPath, "coverage", "coverage.json"),
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
  const files = Object.values(json);

  let linesFound = 0;
  let linesHit = 0;
  let statementsFound = 0;
  let statementsHit = 0;
  let branchesFound = 0;
  let branchesHit = 0;
  let functionsFound = 0;
  let functionsHit = 0;

  for (const file of files) {
    const lineMap = file?.l ?? {};
    const statementMap = file?.s ?? {};
    const branchMap = file?.b ?? {};
    const functionMap = file?.f ?? {};

    const lineValues = Object.values(lineMap) as number[];
    const statementValues = Object.values(statementMap) as number[];
    const branchValues = Object.values(branchMap) as number[];
    const functionValues = Object.values(functionMap) as number[];

    linesFound += lineValues.length;
    linesHit += lineValues.filter((value) => value > 0).length;

    statementsFound += statementValues.length;
    statementsHit += statementValues.filter((value) => value > 0).length;

    for (const value of branchValues) {
      const counts = Array.isArray(value) ? value : [];
      branchesFound += counts.length;
      branchesHit += counts.filter((count) => count > 0).length;
    }

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

function readCoverageFile(
  coveragePath: string,
): TestCoverageReport["coverage"] {
  try {
    const json = JSON.parse(fs.readFileSync(coveragePath, "utf8"));

    if (json.total) {
      return {
        line: normalizeCoverageValue(json.total.lines?.pct),
        statement: normalizeCoverageValue(json.total.statements?.pct),
        branch: normalizeCoverageValue(json.total.branches?.pct),
        function: normalizeCoverageValue(json.total.functions?.pct),
      };
    }

    if (coveragePath.endsWith("coverage-final.json")) {
      return calculateCoverageFromFinalJson(json);
    }

    return {};
  } catch {
    return {};
  }
}

function detectCoverageProvider(projectPath: string): string | undefined {
  const pkg = readPackage(projectPath);
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };

  if (deps["@vitest/coverage-v8"]) return "@vitest/coverage-v8";
  if (deps["@vitest/coverage-istanbul"]) {
    return "@vitest/coverage-istanbul";
  }

  return undefined;
}

function hasLocalVitest(projectPath: string): boolean {
  return fs.existsSync(
    path.join(projectPath, "node_modules", ".bin", "vitest"),
  );
}

function generateVitestCoverage(
  projectPath: string,
  warnings: string[],
): string | undefined {
  const provider = detectCoverageProvider(projectPath);

  if (!provider) {
    warnings.push(
      "Vitest was detected, but no Vitest coverage provider is installed. Install @vitest/coverage-v8 or @vitest/coverage-istanbul to generate coverage.",
    );
    return undefined;
  }

  if (!hasLocalVitest(projectPath)) {
    warnings.push(
      "Vitest coverage was not generated because project dependencies are not installed in the analyzed project.",
    );
    return undefined;
  }

  try {
    execFileSync(
      path.join(projectPath, "node_modules", ".bin", "vitest"),
      ["run", "--coverage"],
      {
        cwd: projectPath,
        encoding: "utf8",
        timeout: 120_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CI: "true",
        },
      },
    );
  } catch (error) {
    const details =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "").trim()
        : "";

    warnings.push(
      details
        ? `Vitest coverage generation failed: ${details.slice(0, 1000)}`
        : "Vitest coverage generation failed.",
    );
    return undefined;
  }

  return findCoverageSummary(projectPath);
}

function readCoverage(projectPath: string) {
  const warnings: string[] = [];

  let coveragePath = findCoverageSummary(projectPath);

  if (!coveragePath) {
    const frameworks = detectFrameworks(projectPath);

    if (frameworks.includes("Vitest")) {
      coveragePath = generateVitestCoverage(projectPath, warnings);
    }
  }

  if (!coveragePath) {
    warnings.push(
      "No usable coverage report was found. Test files and test relationships are reported, but coverage percentages are unavailable.",
    );
    return { coverage: {}, warnings };
  }

  const coverage = readCoverageFile(coveragePath);

  if (
    coverage.line === undefined &&
    coverage.statement === undefined &&
    coverage.branch === undefined &&
    coverage.function === undefined
  ) {
    warnings.push(
      `Coverage report was found at ${path.relative(projectPath, coveragePath)}, but no coverage percentages could be read.`,
    );
    return { coverage: {}, warnings };
  }

  return { coverage, warnings };
}

export async function analyzeTestCoverage(
  projectPath: string,
  filePath?: string,
): Promise<TestCoverageReport> {
  const resolvedProject = await resolveProjectPath(projectPath);
  const analysisPath = resolvedProject.projectPath;

  const allFiles = walkFiles(analysisPath);
  const testFiles = allFiles.filter(isTestFile);
  const sourceFiles = allFiles.filter((file) => !isTestFile(file));
  const sourceSet = new Set(sourceFiles);

  const testReports = testFiles.map((testFile) => ({
    filePath: path.relative(analysisPath, testFile),
    testCount: (() => {
      try {
        return countTests(fs.readFileSync(testFile, "utf8"));
      } catch {
        return 0;
      }
    })(),
    matchingSourceFiles: findMatchingSourceFiles(testFile, analysisPath, sourceSet),
  }));

  const testedSourceFiles = new Set(
    testReports.flatMap((item) => item.matchingSourceFiles),
  );

  let untestedSourceFiles = sourceFiles
    .filter((file) => {
      const relativeFile = path
        .relative(analysisPath, file)
        .replaceAll("\\", "/");

      return !testedSourceFiles.has(relativeFile);
    })
    .map((file) =>
      path.relative(analysisPath, file).replaceAll("\\", "/"),
    );

  let scopedTests = testReports;
  let scopedSources = sourceFiles;

  if (filePath?.trim()) {
    scopedSources = sourceFiles.filter(
      (file) => path.relative(analysisPath, file) === filePath.trim(),
    );
    scopedTests = testReports.filter((test) =>
      test.matchingSourceFiles.includes(filePath.trim()),
    );
    untestedSourceFiles = untestedSourceFiles.filter(
      (file) => file === filePath.trim(),
    );
  }

  const coverageResult = readCoverage(analysisPath);

  return {
    success: true,
    tool: "analyze_test_coverage",
    projectPath: resolvedProject.originalPath,
    totalSourceFiles: scopedSources.length,
    totalTestFiles: scopedTests.length,
    totalTests: scopedTests.reduce((sum, item) => sum + item.testCount, 0),
    sourceFilesWithTests:
      scopedSources.length - untestedSourceFiles.length,
    sourceFilesWithoutTests: untestedSourceFiles.length,
    coverage: coverageResult.coverage,
    testFrameworks: detectFrameworks(analysisPath),
    testFiles: scopedTests,
    untestedSourceFiles,
    warnings: coverageResult.warnings,
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
