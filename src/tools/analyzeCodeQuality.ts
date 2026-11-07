import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import * as ts from "typescript";

const EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
]);

const IGNORED = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".vite",
  ".turbo",
  ".vercel",
  "vendor",
]);

const MAX_FILES = 3000;
const MAX_ISSUES = 100;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

type Severity = "info" | "low" | "medium" | "high" | "critical";

type SourceRange = {
  startLine: number;
  endLine: number;
};

export interface QualityIssue {
  id: string;
  severity: Severity;
  kind: string;
  title: string;
  message: string;
  suggestion: string;
  filePath: string;
  symbol?: string;
  startLine: number;
  endLine: number;
  metric?: number;
  priority: "now" | "soon" | "later";
  whyItMatters: string;
  fixSteps: string[];
  confidence: "high" | "medium" | "low";
}

export interface CodeQualityReport {
  success: boolean;
  tool: "analyze_code_quality";
  projectPath: string;
  target: {
    filePath?: string;
    symbol?: string;
  };
  summary: {
    score: number;
    grade: "A" | "B" | "C" | "D" | "F";
    issueCount: number;
    highSeverityCount: number;
    complexity: number;
    maxNestingDepth: number;
    lines: number;
    functions: number;
    parameters: number;
    callCount: number;
    reactSignals: number;
    asyncOperations: number;
  };
  issues: QualityIssue[];
  metrics: Array<Record<string, unknown>>;
  suggestions: string[];
  warnings: string[];
  error?: string;
}

interface Candidate {
  name: string;
  kind: string;
  node: ts.Node;
}

interface FunctionMetrics extends SourceRange {
  lines: number;
  complexity: number;
  nestingDepth: number;
  parameters: number;
  callCount: number;
  asyncOperations: number;
  reactSignals: number;
}

function isInsideProject(root: string, target: string): boolean {
  const relative = path.relative(root, target);

  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function relativePath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

async function collectSourceFiles(root: string): Promise<string[]> {
  const result: string[] = [];

  async function walk(directory: string): Promise<void> {
    if (result.length >= MAX_FILES) {
      return;
    }

    let entries;

    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (
        result.length >= MAX_FILES ||
        entry.isSymbolicLink() ||
        IGNORED.has(entry.name)
      ) {
        continue;
      }

      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (
        entry.isFile() &&
        EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
        !entry.name.startsWith(".")
      ) {
        result.push(fullPath);
      }
    }
  }

  await walk(root);
  return result;
}

function getRange(sourceFile: ts.SourceFile, node: ts.Node): SourceRange {
  return {
    startLine:
      sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
      1,
    endLine:
      sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
  };
}

function collectCandidates(sourceFile: ts.SourceFile): Candidate[] {
  const candidates: Candidate[] = [];

  const add = (name: string, kind: string, node: ts.Node): void => {
    candidates.push({ name, kind, node });
  };

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      add(node.name.text, "function", node);
    } else if (ts.isMethodDeclaration(node) && node.name) {
      add(node.name.getText(sourceFile), "method", node);
    } else if (ts.isGetAccessorDeclaration(node) && node.name) {
      add(node.name.getText(sourceFile), "getter", node);
    } else if (ts.isSetAccessorDeclaration(node) && node.name) {
      add(node.name.getText(sourceFile), "setter", node);
    } else if (ts.isConstructorDeclaration(node)) {
      add("constructor", "constructor", node);
    } else if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      ts.isVariableDeclaration(node.parent) &&
      ts.isIdentifier(node.parent.name)
    ) {
      add(
        node.parent.name.text,
        ts.isArrowFunction(node) ? "arrow-function" : "function-expression",
        node,
      );
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return candidates;
}

function calculateFunctionMetrics(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): FunctionMetrics {
  let complexity = 1;
  let maxNestingDepth = 0;
  let callCount = 0;
  let asyncOperations = 0;
  let reactSignals = 0;

  const parameters = ts.isFunctionLike(node) ? node.parameters.length : 0;

  function visit(current: ts.Node, depth: number): void {
    const increasesNesting =
      ts.isIfStatement(current) ||
      ts.isConditionalExpression(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current) ||
      ts.isCaseClause(current) ||
      ts.isCatchClause(current);

    if (increasesNesting) {
      complexity += 1;
      maxNestingDepth = Math.max(maxNestingDepth, depth + 1);
    }

    if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
      callCount += 1;
    }

    if (ts.isAwaitExpression(current)) {
      asyncOperations += 1;
    }

    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      (/^use[A-Z]/.test(current.expression.text) ||
        current.expression.text === "dispatch" ||
        current.expression.text === "setState")
    ) {
      reactSignals += 1;
    }

    ts.forEachChild(current, (child) =>
      visit(child, increasesNesting ? depth + 1 : depth),
    );
  }

  visit(node, 0);

  const range = getRange(sourceFile, node);

  return {
    ...range,
    lines: range.endLine - range.startLine + 1,
    complexity,
    nestingDepth: maxNestingDepth,
    parameters,
    callCount,
    asyncOperations,
    reactSignals,
  };
}

function grade(score: number): CodeQualityReport["summary"]["grade"] {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

function remediationFor(kind: string, severity: Severity): {
  priority: QualityIssue["priority"];
  whyItMatters: string;
  fixSteps: string[];
  confidence: QualityIssue["confidence"];
} {
  const priority: QualityIssue["priority"] =
    severity === "critical" || severity === "high" ? "now" :
    severity === "medium" ? "soon" : "later";

  const map: Record<string, { whyItMatters: string; fixSteps: string[]; confidence: QualityIssue["confidence"] }> = {
    complexity: {
      whyItMatters: "Complex branching is harder to test, review, and safely modify because more execution paths must be understood.",
      fixSteps: [
        "Identify independent decision branches.",
        "Extract cohesive branches into small named functions.",
        "Prefer guard clauses and early returns where they improve readability.",
        "Add or update tests around the extracted behavior.",
      ],
      confidence: "high",
    },
    length: {
      whyItMatters: "Large functions usually mix multiple responsibilities, making changes harder to reason about and increasing regression risk.",
      fixSteps: [
        "Group the function body into logical responsibilities.",
        "Extract one responsibility at a time into named helpers or hooks.",
        "Keep data flow explicit between the extracted units.",
        "Run existing tests after each extraction.",
      ],
      confidence: "high",
    },
    nesting: {
      whyItMatters: "Deep nesting makes the happy path difficult to see and increases the mental effort required to understand control flow.",
      fixSteps: [
        "Identify the main happy path.",
        "Move invalid or exceptional cases into guard clauses.",
        "Extract deeply nested blocks into focused helpers when appropriate.",
      ],
      confidence: "high",
    },
    parameters: {
      whyItMatters: "Many parameters make APIs harder to call correctly and increase the chance of passing the wrong value.",
      fixSteps: [
        "Group related inputs into a typed options object.",
        "Give the object properties meaningful names.",
        "Keep required and optional fields explicit in the type.",
      ],
      confidence: "high",
    },
    calls: {
      whyItMatters: "A function coordinating many operations can become an orchestration hotspot that is difficult to test and change safely.",
      fixSteps: [
        "Separate orchestration from business rules.",
        "Extract repeated or cohesive operations into helpers.",
        "Keep the top-level function focused on sequencing work.",
      ],
      confidence: "medium",
    },
    async: {
      whyItMatters: "Several sequential awaits can increase latency and make failure handling harder when some operations are independent.",
      fixSteps: [
        "Identify independent async operations.",
        "Use Promise.all or Promise.allSettled only when the operations are truly independent.",
        "Preserve explicit error handling and ordering where required.",
      ],
      confidence: "medium",
    },
    react: {
      whyItMatters: "High hook/state activity can indicate a component is coordinating too many responsibilities and may be harder to reason about.",
      fixSteps: [
        "Group related state and effects by responsibility.",
        "Extract reusable stateful logic into a custom hook.",
        "Keep rendering focused on presentation and composition.",
      ],
      confidence: "medium",
    },
    maintainability: {
      whyItMatters: "Large source files make navigation, ownership, testing, and change impact harder as the codebase grows.",
      fixSteps: [
        "Identify cohesive responsibilities in the file.",
        "Move reusable logic into focused modules.",
        "Keep the original module as a thin composition layer when possible.",
      ],
      confidence: "high",
    },
  };

  return {
    priority,
    ...(map[kind] ?? {
      whyItMatters: "This structural signal is worth reviewing because it may increase maintenance or change risk.",
      fixSteps: ["Review the highlighted code and confirm whether the finding represents a real design problem.", "Make the smallest focused refactor that improves clarity without changing behavior."],
      confidence: "medium" as const,
    }),
  };
}

function createIssue(
  id: string,
  severity: Severity,
  kind: string,
  title: string,
  message: string,
  suggestion: string,
  filePath: string,
  range: SourceRange,
  symbol?: string,
  metric?: number,
): QualityIssue {
  const remediation = remediationFor(kind, severity);

  return {
    id,
    severity,
    kind,
    title,
    message,
    suggestion,
    filePath,
    startLine: range.startLine,
    endLine: range.endLine,
    ...(symbol ? { symbol } : {}),
    ...(metric !== undefined ? { metric } : {}),
    ...remediation,
  };
}

function calculateScore(issues: QualityIssue[]): number {
  const basePenalty: Record<Severity, number> = {
    info: 0,
    low: 2,
    medium: 6,
    high: 11,
    critical: 18,
  };

  const seenByKind = new Map<string, number>();
  let penalty = 0;

  for (const issue of issues) {
    const occurrence = seenByKind.get(issue.kind) ?? 0;
    const repetitionFactor = 1 + Math.min(occurrence, 3) * 0.25;
    penalty += basePenalty[issue.severity] * repetitionFactor;
    seenByKind.set(issue.kind, occurrence + 1);
  }

  return Math.round(Math.max(15, Math.min(100, 100 - Math.min(85, penalty))));
}

export async function analyzeCodeQuality(
  projectPath: string,
  filePath?: string,
  symbol?: string,
): Promise<CodeQualityReport> {
  if (!path.isAbsolute(projectPath)) {
    throw new Error("projectPath must be an absolute path.");
  }

  const root = path.resolve(projectPath);
  const rootStats = await stat(root);

  if (!rootStats.isDirectory()) {
    throw new Error("projectPath must point to a directory.");
  }

  const targets = filePath
    ? [path.resolve(root, filePath)]
    : await collectSourceFiles(root);

  if (filePath) {
    const target = targets[0];

    if (!isInsideProject(root, target)) {
      throw new Error("filePath must stay inside projectPath.");
    }

    let targetStats;

    try {
      targetStats = await stat(target);
    } catch {
      throw new Error(
        `File does not exist: ${relativePath(root, target)}.`,
      );
    }

    if (!targetStats.isFile()) {
      throw new Error(
        `The specified path is not a file: ${relativePath(root, target)}.`,
      );
    }

    if (targetStats.size > MAX_FILE_BYTES) {
      throw new Error(
        `File is too large to analyze: ${relativePath(root, target)}. Maximum supported size is ${MAX_FILE_BYTES} bytes.`,
      );
    }
  } else if (targets.length === 0) {
    throw new Error("No TypeScript/JavaScript source files were found in the project.");
  } else {
    for (const target of targets) {
      if (!isInsideProject(root, target)) {
        throw new Error("filePath must stay inside projectPath.");
      }
    }
  }

  const issues: QualityIssue[] = [];
  const metrics: CodeQualityReport["metrics"] = [];
  const warnings: string[] = [];

  let lines = 0;
  let functions = 0;
  let totalComplexity = 0;
  let maxNestingDepth = 0;
  let parameters = 0;
  let callCount = 0;
  let reactSignals = 0;
  let asyncOperations = 0;

  for (const file of targets) {
    if (issues.length >= MAX_ISSUES) {
      break;
    }

    let content: string;

    try {
      const fileStats = await stat(file);

      if (!fileStats.isFile()) {
        if (filePath) {
          throw new Error(
            `The specified path is not a file: ${relativePath(root, file)}.`,
          );
        }

        warnings.push(
          `Skipped ${relativePath(root, file)} because it is not a file.`,
        );
        continue;
      }

      if (fileStats.size > MAX_FILE_BYTES) {
        if (filePath) {
          throw new Error(
            `File is too large to analyze: ${relativePath(root, file)}. Maximum supported size is ${MAX_FILE_BYTES} bytes.`,
          );
        }

        warnings.push(
          `Skipped ${relativePath(root, file)} because it is too large.`,
        );
        continue;
      }

      content = await readFile(file, "utf8");
    } catch (error) {
      if (filePath) {
        if (error instanceof Error && error.message.startsWith("File is too large")) {
          throw error;
        }
        if (error instanceof Error && error.message.startsWith("The specified path is not a file")) {
          throw error;
        }
        throw new Error(
          `Could not read ${relativePath(root, file)}.`,
        );
      }

      warnings.push(`Could not read ${relativePath(root, file)}.`);
      continue;
    }

    const sourceFile = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );

    const candidates = collectCandidates(sourceFile);
    const selectedCandidates = symbol
      ? candidates.filter((candidate) => candidate.name === symbol)
      : candidates;

    if (symbol && selectedCandidates.length === 0) {
      throw new Error(
        `Symbol "${symbol}" was not found in ${relativePath(root, file)}.`,
      );
    }

    lines += content.split(/\r?\n/).length;

    for (const candidate of selectedCandidates) {
      const metric = calculateFunctionMetrics(sourceFile, candidate.node);

      metrics.push({
        filePath: relativePath(root, file),
        symbol: candidate.name,
        kind: candidate.kind,
        ...metric,
      });

      functions += 1;
      totalComplexity += metric.complexity;
      maxNestingDepth = Math.max(
        maxNestingDepth,
        metric.nestingDepth,
      );
      parameters += metric.parameters;
      callCount += metric.callCount;
      reactSignals += metric.reactSignals;
      asyncOperations += metric.asyncOperations;

      if (metric.complexity >= 15) {
        issues.push(
          createIssue(
            `cx-${file}-${metric.startLine}`,
            "critical",
            "complexity",
            "Very high complexity",
            `${candidate.name} has about ${metric.complexity} decision points.`,
            "Extract conditional logic into focused functions.",
            relativePath(root, file),
            metric,
            candidate.name,
            metric.complexity,
          ),
        );
      } else if (metric.complexity >= 10) {
        issues.push(
          createIssue(
            `cx-${file}-${metric.startLine}`,
            "high",
            "complexity",
            "High complexity",
            `${candidate.name} has about ${metric.complexity} decision points.`,
            "Split complex branches into smaller helpers.",
            relativePath(root, file),
            metric,
            candidate.name,
            metric.complexity,
          ),
        );
      } else if (metric.complexity >= 7) {
        issues.push(
          createIssue(
            `cx-${file}-${metric.startLine}`,
            "medium",
            "complexity",
            "Moderate complexity",
            `${candidate.name} has about ${metric.complexity} decision points.`,
            "Review whether the decision logic can be simplified.",
            relativePath(root, file),
            metric,
            candidate.name,
            metric.complexity,
          ),
        );
      }

      if (metric.lines >= 150) {
        issues.push(
          createIssue(
            `len-${file}-${metric.startLine}`,
            "high",
            "length",
            "Very long function",
            `${candidate.name} spans ${metric.lines} lines.`,
            "Split the function into focused units.",
            relativePath(root, file),
            metric,
            candidate.name,
            metric.lines,
          ),
        );
      } else if (metric.lines >= 80) {
        issues.push(
          createIssue(
            `len-${file}-${metric.startLine}`,
            "medium",
            "length",
            "Long function",
            `${candidate.name} spans ${metric.lines} lines.`,
            "Extract cohesive blocks into helper functions or hooks.",
            relativePath(root, file),
            metric,
            candidate.name,
            metric.lines,
          ),
        );
      }

      if (metric.nestingDepth >= 5) {
        issues.push(
          createIssue(
            `nest-${file}-${metric.startLine}`,
            "high",
            "nesting",
            "Deep nesting",
            `${candidate.name} reaches nesting depth ${metric.nestingDepth}.`,
            "Use guard clauses or extract nested logic.",
            relativePath(root, file),
            metric,
            candidate.name,
            metric.nestingDepth,
          ),
        );
      } else if (metric.nestingDepth >= 3) {
        issues.push(
          createIssue(
            `nest-${file}-${metric.startLine}`,
            "medium",
            "nesting",
            "Nested control flow",
            `${candidate.name} reaches nesting depth ${metric.nestingDepth}.`,
            "Simplify nested branches where possible.",
            relativePath(root, file),
            metric,
            candidate.name,
            metric.nestingDepth,
          ),
        );
      }

      if (metric.parameters >= 6) {
        issues.push(
          createIssue(
            `par-${file}-${metric.startLine}`,
            "high",
            "parameters",
            "Too many parameters",
            `${candidate.name} accepts ${metric.parameters} parameters.`,
            "Group related inputs into a typed object.",
            relativePath(root, file),
            metric,
            candidate.name,
            metric.parameters,
          ),
        );
      } else if (metric.parameters >= 4) {
        issues.push(
          createIssue(
            `par-${file}-${metric.startLine}`,
            "medium",
            "parameters",
            "Many parameters",
            `${candidate.name} accepts ${metric.parameters} parameters.`,
            "Consider a parameter object when inputs form a cohesive group.",
            relativePath(root, file),
            metric,
            candidate.name,
            metric.parameters,
          ),
        );
      }

      if (metric.callCount >= 25) {
        issues.push(
          createIssue(
            `call-${file}-${metric.startLine}`,
            "medium",
            "calls",
            "Many operations",
            `${candidate.name} contains about ${metric.callCount} call/new operations.`,
            "Separate orchestration from business logic where appropriate.",
            relativePath(root, file),
            metric,
            candidate.name,
            metric.callCount,
          ),
        );
      }

      if (metric.asyncOperations >= 5) {
        issues.push(
          createIssue(
            `async-${file}-${metric.startLine}`,
            "medium",
            "async",
            "Many async operations",
            `${candidate.name} contains ${metric.asyncOperations} await operations.`,
            "Review sequential awaits and parallelize independent work when safe.",
            relativePath(root, file),
            metric,
            candidate.name,
            metric.asyncOperations,
          ),
        );
      }

      if (metric.reactSignals >= 8) {
        issues.push(
          createIssue(
            `react-${file}-${metric.startLine}`,
            "medium",
            "react",
            "High React hook/state activity",
            `${candidate.name} contains ${metric.reactSignals} detected hook/state operations.`,
            "Consider extracting a custom hook or splitting responsibilities.",
            relativePath(root, file),
            metric,
            candidate.name,
            metric.reactSignals,
          ),
        );
      }
    }

    if (!symbol && lines >= 500 && file === targets[0]) {
      const fileRange: SourceRange = {
        startLine: 1,
        endLine: lines,
      };

      issues.push(
        createIssue(
          `file-${file}`,
          "medium",
          "maintainability",
          "Large source file",
          `${relativePath(root, file)} contains ${lines} lines.`,
          "Separate unrelated responsibilities into focused modules.",
          relativePath(root, file),
          fileRange,
          undefined,
          lines,
        ),
      );
    }
  }

  const limitedIssues = issues.slice(0, MAX_ISSUES);
  const qualityScore = calculateScore(limitedIssues);
  const suggestions = [
    ...new Set(limitedIssues.slice(0, 8).map((issue) => issue.suggestion)),
  ];

  if (suggestions.length === 0) {
    suggestions.push(
      "No major structural issues were detected by the current heuristics.",
    );
  }

  return {
    success: true,
    tool: "analyze_code_quality",
    projectPath: root,
    target: {
      ...(filePath
        ? { filePath: relativePath(root, path.resolve(root, filePath)) }
        : {}),
      ...(symbol ? { symbol } : {}),
    },
    summary: {
      score: qualityScore,
      grade: grade(qualityScore),
      issueCount: limitedIssues.length,
      highSeverityCount: limitedIssues.filter(
        (issue) => issue.severity === "high" || issue.severity === "critical",
      ).length,
      complexity:
        functions > 0
          ? Math.round((totalComplexity / functions) * 10) / 10
          : 0,
      maxNestingDepth,
      lines,
      functions,
      parameters,
      callCount,
      reactSignals,
      asyncOperations,
    },
    issues: limitedIssues,
    metrics,
    suggestions,
    warnings,
  };
}

export function registerAnalyzeCodeQualityTool(server: McpServer): void {
  server.registerTool(
    "analyze_code_quality",
    {
      description:
        "Analyze TypeScript/JavaScript code for complexity, length, nesting, parameters, React activity, async activity, and maintainability concerns. Read-only.",
      inputSchema: {
        projectPath: z.string().min(1),
        filePath: z.string().min(1).optional(),
        symbol: z.string().min(1).max(200).optional(),
      },
    },
    async ({ projectPath, filePath, symbol }) => {
      try {
        const result = await analyzeCodeQuality(
          projectPath,
          filePath,
          symbol,
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
        const result = {
          success: false,
          tool: "analyze_code_quality",
          projectPath,
          error: error instanceof Error ? error.message : String(error),
        };

        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
          structuredContent: result,
        };
      }
    },
  );
}
