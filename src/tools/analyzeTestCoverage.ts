import fs from "node:fs";
import path from "node:path";
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

function readCoverage(projectPath: string) {
  const warnings: string[] = [];
  const summaryPath = path.join(
    projectPath,
    "coverage",
    "coverage-summary.json",
  );

  if (!fs.existsSync(summaryPath)) {
    warnings.push(
      "No coverage/coverage-summary.json was found. Test files were discovered, but code coverage percentages are unavailable until the project generates a coverage report.",
    );
    return { coverage: {}, warnings };
  }

  try {
    const json = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    const total = json.total;

    if (!total) {
      warnings.push("Coverage summary does not contain a total section.");
      return { coverage: {}, warnings };
    }

    return {
      coverage: {
        line: total.lines?.pct,
        statement: total.statements?.pct,
        branch: total.branches?.pct,
        function: total.functions?.pct,
      },
      warnings,
    };
  } catch {
    warnings.push("Coverage summary exists but could not be parsed.");
    return { coverage: {}, warnings };
  }
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
        "Analyze test files, test counts, source-to-test relationships, untested source files, test frameworks, and available coverage reports.",
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
