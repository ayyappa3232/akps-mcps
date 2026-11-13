import express from "express";
import path from "node:path";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { resolveProjectPath } from "./utils/projectResolver.js";

import { generateDependencyTrace } from "./tools/traceDependencies.js";
import { explainMethod } from "./tools/explainMethod.js";
import { analyzeChangeImpact } from "./tools/analyzeChangeImpact.js";
import { analyzeCodeQuality } from "./tools/analyzeCodeQuality.js";
import { analyzeDeadCode } from "./tools/analyzeDeadCode.js";
import {
  analyzeApiEndpoints,
  readSourceSnippet,
  traceCallers,
} from "./tools/analyzeApiEndpoints.js";
import { analyzeSecurity } from "./tools/analyzeSecurity.js";
import { analyzeTestCoverage } from "./tools/analyzeTestCoverage.js";
import { analyzeDependencyHealth } from "./tools/analyzeDependencyHealth.js";
import { analyzeCircularDependencies } from "./tools/analyzeCircularDependencies.js";
import { detectDuplicateCode } from "./tools/detectDuplicateCode.js";
import { detectBreakingApiChanges } from "./tools/detectBreakingApiChanges.js";
import { analyzeReactComponents } from "./tools/analyzeReactComponents.js";
import { analyzeReactRerenders } from "./tools/analyzeReactRerenders.js";
import { analyzeHookDependencies } from "./tools/analyzeHookDependencies.js";
import { analyzeApiContracts } from "./tools/analyzeApiContracts.js";
import { analyzeStateFlow } from "./tools/analyzeStateFlow.js";
import { analyzeTestImpact } from "./tools/analyzeTestImpact.js";
import { detectSecrets } from "./tools/detectSecrets.js";
import { generateTests } from "./tools/generateTests.js";

const app = express();
const PORT = 4174;

app.use(express.json({ limit: "1mb" }));

// Allow requests from the local Vite viewer.
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (
    origin === "http://127.0.0.1:4173" ||
    origin === "http://localhost:4173"
  ) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});

app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    service: "developer-productivity-mcp-http-bridge",
  });
});

app.post("/api/dependencies", async (req, res) => {
  try {
    let {
      projectPath,
      filePath,
      maxDepth = 5,
      maxNodes = 150,
    } = req.body ?? {};

    if (
      typeof projectPath !== "string" ||
      typeof filePath !== "string"
    ) {
      res.status(400).json({
        success: false,
        error: "projectPath and filePath must be strings.",
      });
      return;
    }

    try {
      projectPath = (await resolveProjectPath(projectPath)).projectPath;
    } catch (error) {
      return res.status(400).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Invalid project path or repository URL.",
      });
    }

    if (
      typeof maxDepth !== "number" ||
      !Number.isInteger(maxDepth) ||
      maxDepth < 0 ||
      maxDepth > 10
    ) {
      res.status(400).json({
        success: false,
        error: "maxDepth must be an integer between 0 and 10.",
      });
      return;
    }

    if (
      typeof maxNodes !== "number" ||
      !Number.isInteger(maxNodes) ||
      maxNodes < 1 ||
      maxNodes > 1000
    ) {
      res.status(400).json({
        success: false,
        error: "maxNodes must be an integer between 1 and 1000.",
      });
      return;
    }

    if (
      path.isAbsolute(filePath) ||
      filePath.split(/[\\/]/).includes("..")
    ) {
      res.status(400).json({
        success: false,
        error: "filePath must be relative to projectPath.",
      });
      return;
    }

    const root = realpathSync(projectPath);
    const entry = resolve(root, filePath);
    const relativePath = relative(root, entry);

    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      res.status(400).json({
        success: false,
        error: "Entry file must be inside the project directory.",
      });
      return;
    }

    const realEntry = realpathSync(entry);
    const realRelative = relative(root, realEntry);

    if (
      realRelative === ".." ||
      realRelative.startsWith(`..${sep}`) ||
      isAbsolute(realRelative)
    ) {
      res.status(400).json({
        success: false,
        error: "Entry file resolves outside the project directory.",
      });
      return;
    }

    if (!statSync(realEntry).isFile()) {
      res.status(400).json({
        success: false,
        error: "Entry path must be a file.",
      });
      return;
    }

    const result = generateDependencyTrace(
      root,
      filePath,
      maxDepth,
      maxNodes
    );

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to generate dependency graph.",
    });
  }
});

app.post("/api/explain-method", async (req, res) => {
  try {
    let {
      projectPath,
      symbol,
      filePath,
      includeSource = true,
    } = req.body ?? {};

    if (
      typeof projectPath !== "string" ||
      typeof symbol !== "string"
    ) {
      res.status(400).json({
        success: false,
        error: "projectPath and symbol must be strings.",
      });
      return;
    }

    try {
      projectPath = (await resolveProjectPath(projectPath)).projectPath;
    } catch (error) {
      return res.status(400).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Invalid project path or repository URL.",
      });
    }

    if (
      filePath !== undefined &&
      typeof filePath !== "string"
    ) {
      res.status(400).json({
        success: false,
        error: "filePath must be a string when provided.",
      });
      return;
    }

    if (typeof includeSource !== "boolean") {
      res.status(400).json({
        success: false,
        error: "includeSource must be a boolean.",
      });
      return;
    }

    const result = await explainMethod(
      projectPath,
      symbol,
      filePath,
      includeSource
    );

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to explain method.",
    });
  }
});

app.post("/api/analyze-change-impact", async (req, res) => {
  try {
    let {
      projectPath,
      filePath,
      symbol,
      caseSensitive = true,
    } = req.body ?? {};

    if (typeof projectPath !== "string" || projectPath.trim() === "") {
      res.status(400).json({
        success: false,
        error: "projectPath must be a non-empty string.",
      });
      return;
    }

    if (filePath !== undefined && typeof filePath !== "string") {
      res.status(400).json({
        success: false,
        error: "filePath must be a string when provided.",
      });
      return;
    }

    if (symbol !== undefined && typeof symbol !== "string") {
      res.status(400).json({
        success: false,
        error: "symbol must be a string when provided.",
      });
      return;
    }

    if (filePath === undefined && symbol === undefined) {
      res.status(400).json({
        success: false,
        error: "At least one of filePath or symbol must be supplied.",
      });
      return;
    }

    try {
      projectPath = (await resolveProjectPath(projectPath)).projectPath;
    } catch (error) {
      return res.status(400).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Invalid project path or repository URL.",
      });
    }

    if (
      filePath !== undefined &&
      (
        path.isAbsolute(filePath) ||
        filePath.split(/[\\/]/).includes("..")
      )
    ) {
      res.status(400).json({
        success: false,
        error: "filePath must be relative to projectPath.",
      });
      return;
    }

    if (typeof caseSensitive !== "boolean") {
      res.status(400).json({
        success: false,
        error: "caseSensitive must be a boolean.",
      });
      return;
    }

    const result = await analyzeChangeImpact(
      projectPath,
      filePath,
      symbol,
      caseSensitive,
    );

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      tool: "analyze_change_impact",
      error:
        error instanceof Error
          ? error.message
          : "Failed to analyze change impact.",
    });
  }
});

app.post("/api/analyze-code-quality", async (req, res) => {
  try {
    let { projectPath, filePath, symbol } = req.body ?? {};
    if (typeof projectPath !== "string" || !projectPath.trim()) {
      return res.status(400).json({ success: false, error: "projectPath must be a non-empty string." });
    }
    if (filePath !== undefined && typeof filePath !== "string") {
      return res.status(400).json({ success: false, error: "filePath must be a string when provided." });
    }
    if (symbol !== undefined && typeof symbol !== "string") {
      return res.status(400).json({ success: false, error: "symbol must be a string when provided." });
    }
    try {
      projectPath = (await resolveProjectPath(projectPath)).projectPath;
    } catch (error) {
      return res.status(400).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Invalid project path or repository URL.",
      });
    }
    if (filePath !== undefined && (path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes(".."))) {
      return res.status(400).json({ success: false, error: "filePath must be relative to projectPath." });
    }
    res.json(await analyzeCodeQuality(projectPath, filePath, symbol));
  } catch (error) {
    res.status(500).json({ success: false, tool: "analyze_code_quality", error: error instanceof Error ? error.message : "Failed to analyze code quality." });
  }
});

app.post("/api/analyze-dead-code", async (req, res) => {
  try {
    let {
      projectPath,
      filePath,
      symbol,
    } = req.body;

    if (!projectPath) {
      return res.status(400).json({
        success: false,
        error: "projectPath is required",
      });
    }

    const report =
      await analyzeDeadCode(
        projectPath,
        filePath,
        symbol
      );

    return res.json(report);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    return res.status(500).json({
      success: false,
      error: message,
    });
  }
});

app.post("/api/analyze-api-endpoints", async (req, res) => {
  try {
    let {
      projectPath,
      filePath,
    } = req.body ?? {};

    if (
      typeof projectPath !== "string" ||
      !projectPath.trim()
    ) {
      return res.status(400).json({
        success: false,
        error:
          "projectPath must be a non-empty string.",
      });
    }

    if (
      filePath !== undefined &&
      typeof filePath !== "string"
    ) {
      return res.status(400).json({
        success: false,
        error:
          "filePath must be a string when provided.",
      });
    }

    try {
      projectPath = (await resolveProjectPath(projectPath)).projectPath;
    } catch (error) {
      return res.status(400).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Invalid project path or repository URL.",
      });
    }

    if (
      filePath !== undefined &&
      (
        path.isAbsolute(filePath) ||
        filePath
          .split(/[\\/]/)
          .includes("..")
      )
    ) {
      return res.status(400).json({
        success: false,
        error:
          "filePath must be relative to projectPath.",
      });
    }

    const report =
      await analyzeApiEndpoints(
        projectPath,
        filePath
      );

    return res.json(report);

  } catch (error) {
    return res.status(500).json({
      success: false,
      tool: "analyze_api_endpoints",
      error:
        error instanceof Error
          ? error.message
          : "Failed to analyze API endpoints.",
    });
  }
});

app.post("/api/view-source", async (req, res) => {
  try {
    let { projectPath, filePath, line, full = false } = req.body ?? {};

    if (typeof projectPath !== "string" || !projectPath.trim()) {
      return res.status(400).json({
        success: false,
        error: "projectPath must be a non-empty string.",
      });
    }

    try {
      projectPath = (await resolveProjectPath(projectPath)).projectPath;
    } catch (error) {
      return res.status(400).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Invalid project path or repository URL.",
      });
    }

    if (typeof filePath !== "string" || !filePath.trim()) {
      return res.status(400).json({
        success: false,
        error: "filePath must be a non-empty string.",
      });
    }

    if (path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes("..")) {
      return res.status(400).json({
        success: false,
        error: "filePath must be relative to projectPath.",
      });
    }

    if (!Number.isInteger(line) || line < 1) {
      return res.status(400).json({
        success: false,
        error: "line must be a positive integer.",
      });
    }

    if (typeof full !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "full must be a boolean.",
      });
    }

    return res.json(
      await readSourceSnippet(projectPath, filePath, line, { full })
    );
  } catch (error) {
    return res.status(500).json({
      success: false,
      tool: "view_source",
      error:
        error instanceof Error
          ? error.message
          : "Failed to read source file.",
    });
  }
});

app.post("/api/trace-callers", async (req, res) => {
  try {
    let {
      projectPath,
      filePath,
      line,
      column,
      maxDepth = 4,
      maxNodes = 80,
    } = req.body ?? {};

    if (typeof projectPath !== "string" || !projectPath.trim()) {
      return res.status(400).json({
        success: false,
        error: "projectPath must be a non-empty string.",
      });
    }

    try {
      projectPath = (await resolveProjectPath(projectPath)).projectPath;
    } catch (error) {
      return res.status(400).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Invalid project path or repository URL.",
      });
    }

    if (typeof filePath !== "string" || !filePath.trim()) {
      return res.status(400).json({
        success: false,
        error: "filePath must be a non-empty string.",
      });
    }

    if (path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes("..")) {
      return res.status(400).json({
        success: false,
        error: "filePath must be relative to projectPath.",
      });
    }

    if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
      return res.status(400).json({
        success: false,
        error: "line and column must be positive integers.",
      });
    }

    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 8) {
      return res.status(400).json({
        success: false,
        error: "maxDepth must be an integer between 1 and 8.",
      });
    }

    if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 200) {
      return res.status(400).json({
        success: false,
        error: "maxNodes must be an integer between 1 and 200.",
      });
    }

    return res.json(
      await traceCallers(projectPath, filePath, line, column, maxDepth, maxNodes)
    );
  } catch (error) {
    return res.status(500).json({
      success: false,
      tool: "trace_callers",
      error:
        error instanceof Error
          ? error.message
          : "Failed to trace callers.",
    });
  }
});

app.post("/api/analyze-security", async (req, res) => {
  try {
    let {
      projectPath,
      filePath,
    } = req.body ?? {};

    if (
      typeof projectPath !== "string" ||
      !projectPath.trim()
    ) {
      return res.status(400).json({
        success: false,
        error: "projectPath must be a non-empty string.",
      });
    }

    if (
      filePath !== undefined &&
      typeof filePath !== "string"
    ) {
      return res.status(400).json({
        success: false,
        error: "filePath must be a string when provided.",
      });
    }

    try {
      projectPath = (await resolveProjectPath(projectPath)).projectPath;
    } catch (error) {
      return res.status(400).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Invalid project path or repository URL.",
      });
    }

    if (
      filePath !== undefined &&
      (
        path.isAbsolute(filePath) ||
        filePath
          .split(/[\\/]/)
          .includes("..")
      )
    ) {
      return res.status(400).json({
        success: false,
        error: "filePath must be relative to projectPath.",
      });
    }

    const report = await analyzeSecurity(
      projectPath,
      filePath,
    );

    return res.json(report);

  } catch (error) {
    return res.status(500).json({
      success: false,
      tool: "analyze_security",
      error:
        error instanceof Error
          ? error.message
          : "Failed to analyze project security.",
    });
  }
});

app.post("/api/analyze-test-coverage", async (req, res) => {
  try {
    let { projectPath, filePath } = req.body ?? {};

    if (typeof projectPath !== "string" || !projectPath.trim()) {
      return res.status(400).json({
        success: false,
        error: "projectPath must be a non-empty string.",
      });
    }

    if (filePath !== undefined && typeof filePath !== "string") {
      return res.status(400).json({
        success: false,
        error: "filePath must be a string when provided.",
      });
    }

    try {
      projectPath = (await resolveProjectPath(projectPath)).projectPath;
    } catch (error) {
      return res.status(400).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Invalid project path or repository URL.",
      });
    }

    if (
      filePath !== undefined &&
      (path.isAbsolute(filePath) ||
        filePath.split(/[\\/]/).includes(".."))
    ) {
      return res.status(400).json({
        success: false,
        error: "filePath must be relative to projectPath.",
      });
    }

    const report = await analyzeTestCoverage(projectPath, filePath);
    return res.json(report);
  } catch (error) {
    return res.status(500).json({
      success: false,
      tool: "analyze_test_coverage",
      error:
        error instanceof Error
          ? error.message
          : "Failed to analyze test coverage.",
    });
  }
});

app.post("/api/analyze-dependency-health", async (req, res) => {
  try {
    let { projectPath } = req.body ?? {};

    if (typeof projectPath !== "string" || !projectPath.trim()) {
      return res.status(400).json({
        success: false,
        error: "projectPath must be a non-empty string.",
      });
    }

    try {
      projectPath = (await resolveProjectPath(projectPath)).projectPath;
    } catch (error) {
      return res.status(400).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Invalid project path or repository URL.",
      });
    }

    const report = await analyzeDependencyHealth(projectPath);
    return res.json(report);
  } catch (error) {
    return res.status(500).json({
      success: false,
      tool: "analyze_dependency_health",
      error:
        error instanceof Error
          ? error.message
          : "Failed to analyze dependency health.",
    });
  }
});

app.post("/api/analyze-circular-dependencies", async (req, res) => {
  try {
    let { projectPath, filePath } = req.body ?? {};

    if (typeof projectPath !== "string" || !projectPath.trim()) {
      return res.status(400).json({
        success: false,
        error: "projectPath must be a non-empty string.",
      });
    }

    if (filePath !== undefined && typeof filePath !== "string") {
      return res.status(400).json({
        success: false,
        error: "filePath must be a string when provided.",
      });
    }

    try {
      projectPath = (await resolveProjectPath(projectPath)).projectPath;
    } catch (error) {
      return res.status(400).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Invalid project path or repository URL.",
      });
    }

    if (
      typeof filePath === "string" &&
      (path.isAbsolute(filePath) ||
        filePath.split(/[\\/]/).includes(".."))
    ) {
      return res.status(400).json({
        success: false,
        error: "filePath must be relative to projectPath.",
      });
    }

    const report = await analyzeCircularDependencies(
      projectPath,
      typeof filePath === "string" && filePath.trim()
        ? filePath.trim()
        : undefined,
    );

    return res.json(report);
  } catch (error) {
    return res.status(500).json({
      success: false,
      tool: "analyze_circular_dependencies",
      error:
        error instanceof Error
          ? error.message
          : "Failed to analyze circular dependencies.",
    });
  }
});

app.post("/api/detect-duplicate-code", async (req, res) => {
  try {
    let {
      projectPath,
      filePath,
      minTokens = 50,
      minLines = 5,
      matchMode = "renamed",
      includeTests = false,
    } = req.body ?? {};

    if (typeof projectPath !== "string" || !projectPath.trim()) {
      return res.status(400).json({
        success: false,
        error: "projectPath must be a non-empty string.",
      });
    }

    if (filePath !== undefined && typeof filePath !== "string") {
      return res.status(400).json({
        success: false,
        error: "filePath must be a string when provided.",
      });
    }

    if (
      typeof minTokens !== "number" ||
      !Number.isInteger(minTokens) ||
      minTokens < 20 ||
      minTokens > 500
    ) {
      return res.status(400).json({
        success: false,
        error: "minTokens must be an integer between 20 and 500.",
      });
    }

    if (
      typeof minLines !== "number" ||
      !Number.isInteger(minLines) ||
      minLines < 2 ||
      minLines > 100
    ) {
      return res.status(400).json({
        success: false,
        error: "minLines must be an integer between 2 and 100.",
      });
    }

    if (!["exact", "renamed", "structural"].includes(matchMode)) {
      return res.status(400).json({
        success: false,
        error: "matchMode must be one of exact, renamed, or structural.",
      });
    }

    if (typeof includeTests !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "includeTests must be a boolean.",
      });
    }

    try {
      projectPath = (await resolveProjectPath(projectPath)).projectPath;
    } catch (error) {
      return res.status(400).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Invalid project path or repository URL.",
      });
    }

    if (
      typeof filePath === "string" &&
      (path.isAbsolute(filePath) ||
        filePath.split(/[\\/]/).includes(".."))
    ) {
      return res.status(400).json({
        success: false,
        error: "filePath must be relative to projectPath.",
      });
    }

    const report = await detectDuplicateCode(
      projectPath,
      typeof filePath === "string" && filePath.trim()
        ? filePath.trim()
        : undefined,
      { minTokens, minLines, matchMode, includeTests },
    );

    return res.json(report);
  } catch (error) {
    return res.status(500).json({
      success: false,
      tool: "detect_duplicate_code",
      error:
        error instanceof Error
          ? error.message
          : "Failed to detect duplicate code.",
    });
  }
});

app.post("/api/detect-breaking-api-changes", async (req, res) => {
  try {
    let {
      projectPath,
      filePath,
      baseRef,
      headRef,
      baselinePath,
      scope = "all",
      entryFiles,
      includeNonBreaking = false,
      includeTests = false,
    } = req.body ?? {};

    if (typeof projectPath !== "string" || !projectPath.trim()) {
      return res.status(400).json({
        success: false,
        error: "projectPath must be a non-empty string.",
      });
    }

    if (filePath !== undefined && typeof filePath !== "string") {
      return res.status(400).json({
        success: false,
        error: "filePath must be a string when provided.",
      });
    }

    for (const [name, value] of [
      ["baseRef", baseRef],
      ["headRef", headRef],
      ["baselinePath", baselinePath],
    ] as const) {
      if (value !== undefined && typeof value !== "string") {
        return res.status(400).json({
          success: false,
          error: `${name} must be a string when provided.`,
        });
      }
    }

    if (!["all", "exports", "routes"].includes(scope)) {
      return res.status(400).json({
        success: false,
        error: "scope must be one of all, exports, or routes.",
      });
    }

    if (
      entryFiles !== undefined &&
      (!Array.isArray(entryFiles) ||
        entryFiles.length > 50 ||
        entryFiles.some(
          (entry: unknown) =>
            typeof entry !== "string" ||
            !entry.trim() ||
            path.isAbsolute(entry) ||
            entry.split(/[\\/]/).includes(".."),
        ))
    ) {
      return res.status(400).json({
        success: false,
        error:
          "entryFiles must be an array of up to 50 relative file paths.",
      });
    }

    if (typeof includeNonBreaking !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "includeNonBreaking must be a boolean.",
      });
    }

    if (typeof includeTests !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "includeTests must be a boolean.",
      });
    }

    const cleanBaseRef =
      typeof baseRef === "string" && baseRef.trim() ? baseRef.trim() : undefined;
    const cleanHeadRef =
      typeof headRef === "string" && headRef.trim() ? headRef.trim() : undefined;
    const cleanBaselinePath =
      typeof baselinePath === "string" && baselinePath.trim()
        ? baselinePath.trim()
        : undefined;

    const refPattern = /^[A-Za-z0-9_][A-Za-z0-9_.\-/@^~{}:]*$/;

    for (const [name, value] of [
      ["baseRef", cleanBaseRef],
      ["headRef", cleanHeadRef],
    ] as const) {
      if (value !== undefined && (value.length > 200 || !refPattern.test(value))) {
        return res.status(400).json({
          success: false,
          error: `${name} must be a git branch, tag or commit (letters, digits and . _ - / @ ^ ~ only).`,
        });
      }
    }

    if (cleanBaselinePath && (cleanBaseRef || cleanHeadRef)) {
      return res.status(400).json({
        success: false,
        error: "Use either baselinePath or baseRef/headRef, not both.",
      });
    }

    try {
      projectPath = (await resolveProjectPath(projectPath)).projectPath;
    } catch (error) {
      return res.status(400).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Invalid project path or repository URL.",
      });
    }

    if (
      typeof filePath === "string" &&
      (path.isAbsolute(filePath) ||
        filePath.split(/[\\/]/).includes(".."))
    ) {
      return res.status(400).json({
        success: false,
        error: "filePath must be relative to projectPath.",
      });
    }

    const report = await detectBreakingApiChanges(projectPath, {
      baseRef: cleanBaseRef,
      headRef: cleanHeadRef,
      baselinePath: cleanBaselinePath,
      filePath:
        typeof filePath === "string" && filePath.trim()
          ? filePath.trim()
          : undefined,
      scope,
      entryFiles: entryFiles?.map((entry: string) => entry.trim()),
      includeNonBreaking,
      includeTests,
    });

    return res.json(report);
  } catch (error) {
    return res.status(500).json({
      success: false,
      tool: "detect_breaking_api_changes",
      error:
        error instanceof Error
          ? error.message
          : "Failed to detect breaking API changes.",
    });
  }
});

app.post("/api/analyze-test-impact", async (req, res) => {
  try {
    let {
      projectPath,
      baseRef,
      changedFiles,
      testTypes = "all",
      maxDepth,
      includeTypeOnly = true,
      includeUntracked = true,
    } = req.body ?? {};

    if (typeof projectPath !== "string" || !projectPath.trim()) {
      return res.status(400).json({
        success: false,
        error: "projectPath must be a non-empty string.",
      });
    }

    if (baseRef !== undefined && typeof baseRef !== "string") {
      return res.status(400).json({
        success: false,
        error: "baseRef must be a string when provided.",
      });
    }

    const cleanBaseRef =
      typeof baseRef === "string" && baseRef.trim() ? baseRef.trim() : undefined;

    if (
      cleanBaseRef !== undefined &&
      (cleanBaseRef.length > 200 ||
        !/^[A-Za-z0-9_][A-Za-z0-9_.\-/@^~{}:]*$/.test(cleanBaseRef))
    ) {
      return res.status(400).json({
        success: false,
        error:
          "baseRef must be a git branch, tag or commit (letters, digits and . _ - / @ ^ ~ only).",
      });
    }

    if (
      changedFiles !== undefined &&
      (!Array.isArray(changedFiles) ||
        changedFiles.length > 200 ||
        changedFiles.some(
          (file: unknown) =>
            typeof file !== "string" ||
            !file.trim() ||
            path.isAbsolute(file) ||
            file.split(/[\\/]/).includes(".."),
        ))
    ) {
      return res.status(400).json({
        success: false,
        error:
          "changedFiles must be an array of up to 200 relative file paths.",
      });
    }

    if (!["all", "unit", "e2e"].includes(testTypes)) {
      return res.status(400).json({
        success: false,
        error: "testTypes must be one of all, unit, or e2e.",
      });
    }

    if (
      maxDepth !== undefined &&
      (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 50)
    ) {
      return res.status(400).json({
        success: false,
        error: "maxDepth must be a whole number from 1 to 50.",
      });
    }

    if (typeof includeTypeOnly !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "includeTypeOnly must be a boolean.",
      });
    }

    if (typeof includeUntracked !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "includeUntracked must be a boolean.",
      });
    }

    try {
      projectPath = (await resolveProjectPath(projectPath)).projectPath;
    } catch (error) {
      return res.status(400).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Invalid project path or repository URL.",
      });
    }

    const report = await analyzeTestImpact(projectPath, {
      baseRef: cleanBaseRef,
      changedFiles: changedFiles?.map((file: string) => file.trim()),
      testTypes,
      maxDepth,
      includeTypeOnly,
      includeUntracked,
    });

    return res.json(report);
  } catch (error) {
    return res.status(500).json({
      success: false,
      tool: "analyze_test_impact",
      error:
        error instanceof Error
          ? error.message
          : "Failed to analyze test impact.",
    });
  }
});

app.post("/api/analyze-react-components", async (req, res) => {
  try {
    let {
      projectPath,
      filePath,
      maxLines = 150,
      maxProps = 7,
      includeTests = false,
    } = req.body ?? {};

    if (typeof projectPath !== "string" || !projectPath.trim()) {
      return res.status(400).json({
        success: false,
        error: "projectPath must be a non-empty string.",
      });
    }

    if (filePath !== undefined && typeof filePath !== "string") {
      return res.status(400).json({
        success: false,
        error: "filePath must be a string when provided.",
      });
    }

    if (
      typeof maxLines !== "number" ||
      !Number.isInteger(maxLines) ||
      maxLines < 30 ||
      maxLines > 2000
    ) {
      return res.status(400).json({
        success: false,
        error: "maxLines must be an integer between 30 and 2000.",
      });
    }

    if (
      typeof maxProps !== "number" ||
      !Number.isInteger(maxProps) ||
      maxProps < 1 ||
      maxProps > 50
    ) {
      return res.status(400).json({
        success: false,
        error: "maxProps must be an integer between 1 and 50.",
      });
    }

    if (typeof includeTests !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "includeTests must be a boolean.",
      });
    }

    try {
      projectPath = (await resolveProjectPath(projectPath)).projectPath;
    } catch (error) {
      return res.status(400).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Invalid project path or repository URL.",
      });
    }

    if (
      typeof filePath === "string" &&
      (path.isAbsolute(filePath) ||
        filePath.split(/[\\/]/).includes(".."))
    ) {
      return res.status(400).json({
        success: false,
        error: "filePath must be relative to projectPath.",
      });
    }

    const report = await analyzeReactComponents(
      projectPath,
      typeof filePath === "string" && filePath.trim()
        ? filePath.trim()
        : undefined,
      { maxLines, maxProps, includeTests },
    );

    return res.json(report);
  } catch (error) {
    return res.status(500).json({
      success: false,
      tool: "analyze_react_components",
      error:
        error instanceof Error
          ? error.message
          : "Failed to analyze React components.",
    });
  }
});

app.post("/api/analyze-react-rerenders", async (req, res) => {
  try {
    let {
      projectPath,
      filePath,
      minCascade = 6,
      includeTests = false,
    } = req.body ?? {};

    if (typeof projectPath !== "string" || !projectPath.trim()) {
      return res.status(400).json({
        success: false,
        error: "projectPath must be a non-empty string.",
      });
    }

    if (filePath !== undefined && typeof filePath !== "string") {
      return res.status(400).json({
        success: false,
        error: "filePath must be a string when provided.",
      });
    }

    if (
      typeof minCascade !== "number" ||
      !Number.isInteger(minCascade) ||
      minCascade < 2 ||
      minCascade > 100
    ) {
      return res.status(400).json({
        success: false,
        error: "minCascade must be an integer between 2 and 100.",
      });
    }

    if (typeof includeTests !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "includeTests must be a boolean.",
      });
    }

    try {
      projectPath = (await resolveProjectPath(projectPath)).projectPath;
    } catch (error) {
      return res.status(400).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Invalid project path or repository URL.",
      });
    }

    if (
      typeof filePath === "string" &&
      (path.isAbsolute(filePath) ||
        filePath.split(/[\\/]/).includes(".."))
    ) {
      return res.status(400).json({
        success: false,
        error: "filePath must be relative to projectPath.",
      });
    }

    const report = await analyzeReactRerenders(
      projectPath,
      typeof filePath === "string" && filePath.trim()
        ? filePath.trim()
        : undefined,
      { minCascade, includeTests },
    );

    return res.json(report);
  } catch (error) {
    return res.status(500).json({
      success: false,
      tool: "analyze_react_rerenders",
      error:
        error instanceof Error
          ? error.message
          : "Failed to analyze React re-renders.",
    });
  }
});

app.post("/api/analyze-hook-dependencies", async (req, res) => {
  try {
    let {
      projectPath,
      filePath,
      hookScope = "all",
      minSeverity = "info",
      includeTests = false,
    } = req.body ?? {};

    if (typeof projectPath !== "string" || !projectPath.trim()) {
      return res.status(400).json({
        success: false,
        error: "projectPath must be a non-empty string.",
      });
    }

    if (filePath !== undefined && typeof filePath !== "string") {
      return res.status(400).json({
        success: false,
        error: "filePath must be a string when provided.",
      });
    }

    if (!["all", "effects", "memoization"].includes(hookScope)) {
      return res.status(400).json({
        success: false,
        error: "hookScope must be one of all, effects, or memoization.",
      });
    }

    if (!["critical", "high", "medium", "low", "info"].includes(minSeverity)) {
      return res.status(400).json({
        success: false,
        error: "minSeverity must be one of critical, high, medium, low, or info.",
      });
    }

    if (typeof includeTests !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "includeTests must be a boolean.",
      });
    }

    try {
      projectPath = (await resolveProjectPath(projectPath)).projectPath;
    } catch (error) {
      return res.status(400).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Invalid project path or repository URL.",
      });
    }

    if (
      typeof filePath === "string" &&
      (path.isAbsolute(filePath) ||
        filePath.split(/[\\/]/).includes(".."))
    ) {
      return res.status(400).json({
        success: false,
        error: "filePath must be relative to projectPath.",
      });
    }

    const report = await analyzeHookDependencies(
      projectPath,
      typeof filePath === "string" && filePath.trim()
        ? filePath.trim()
        : undefined,
      { hookScope, minSeverity, includeTests },
    );

    return res.json(report);
  } catch (error) {
    return res.status(500).json({
      success: false,
      tool: "analyze_hook_dependencies",
      error:
        error instanceof Error
          ? error.message
          : "Failed to analyze hook dependencies.",
    });
  }
});

app.post("/api/analyze-api-contracts", async (req, res) => {
  try {
    let {
      projectPath,
      filePath,
      pathPrefix,
      includeUnused = true,
      includeTests = false,
    } = req.body ?? {};
 
    if (typeof projectPath !== "string" || !projectPath.trim()) {
      return res.status(400).json({
        success: false,
        error: "projectPath must be a non-empty string.",
      });
    }
 
    if (filePath !== undefined && typeof filePath !== "string") {
      return res.status(400).json({
        success: false,
        error: "filePath must be a string when provided.",
      });
    }
 
    if (pathPrefix !== undefined && typeof pathPrefix !== "string") {
      return res.status(400).json({
        success: false,
        error: "pathPrefix must be a string when provided.",
      });
    }
 
    if (
      typeof pathPrefix === "string" &&
      pathPrefix.trim() &&
      !/^\/?[A-Za-z0-9._~\-/:]*$/.test(pathPrefix.trim())
    ) {
      return res.status(400).json({
        success: false,
        error:
          "pathPrefix may only contain letters, numbers, and / . _ ~ - :",
      });
    }
 
    if (typeof includeUnused !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "includeUnused must be a boolean.",
      });
    }
 
    if (typeof includeTests !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "includeTests must be a boolean.",
      });
    }
 
    try {
      projectPath = (await resolveProjectPath(projectPath)).projectPath;
    } catch (error) {
      return res.status(400).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Invalid project path or repository URL.",
      });
    }
 
    if (
      typeof filePath === "string" &&
      (path.isAbsolute(filePath) ||
        filePath.split(/[\\/]/).includes(".."))
    ) {
      return res.status(400).json({
        success: false,
        error: "filePath must be relative to projectPath.",
      });
    }
 
    const report = await analyzeApiContracts(
      projectPath,
      typeof filePath === "string" && filePath.trim()
        ? filePath.trim()
        : undefined,
      {
        pathPrefix:
          typeof pathPrefix === "string" && pathPrefix.trim()
            ? pathPrefix.trim()
            : undefined,
        includeUnused,
        includeTests,
      },
    );
 
    return res.json(report);
  } catch (error) {
    return res.status(500).json({
      success: false,
      tool: "analyze_api_contracts",
      error:
        error instanceof Error
          ? error.message
          : "Failed to analyze API contracts.",
    });
  }
});


app.post("/api/analyze-state-flow", async (req, res) => {
  try {
    let {
      projectPath,
      filePath,
      minDrillDepth = 2,
      includeTests = false,
    } = req.body ?? {};
 
    if (typeof projectPath !== "string" || !projectPath.trim()) {
      return res.status(400).json({
        success: false,
        error: "projectPath must be a non-empty string.",
      });
    }
 
    if (filePath !== undefined && typeof filePath !== "string") {
      return res.status(400).json({
        success: false,
        error: "filePath must be a string when provided.",
      });
    }
 
    if (
      !Number.isInteger(minDrillDepth) ||
      minDrillDepth < 1 ||
      minDrillDepth > 10
    ) {
      return res.status(400).json({
        success: false,
        error: "minDrillDepth must be an integer between 1 and 10.",
      });
    }
 
    if (typeof includeTests !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "includeTests must be a boolean.",
      });
    }
 
    try {
      projectPath = (await resolveProjectPath(projectPath)).projectPath;
    } catch (error) {
      return res.status(400).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Invalid project path or repository URL.",
      });
    }
 
    if (
      typeof filePath === "string" &&
      (path.isAbsolute(filePath) ||
        filePath.split(/[\\/]/).includes(".."))
    ) {
      return res.status(400).json({
        success: false,
        error: "filePath must be relative to projectPath.",
      });
    }
 
    const report = await analyzeStateFlow(
      projectPath,
      typeof filePath === "string" && filePath.trim()
        ? filePath.trim()
        : undefined,
      { minDrillDepth, includeTests },
    );
 
    return res.json(report);
  } catch (error) {
    return res.status(500).json({
      success: false,
      tool: "analyze_state_flow",
      error:
        error instanceof Error
          ? error.message
          : "Failed to analyze state flow.",
    });
  }
});

app.post("/api/detect-secrets", async (req, res) => {
  try {
    let {
      projectPath,
      filePath,
      sensitivity = "balanced",
      includeTests = true,
    } = req.body ?? {};
 
    if (typeof projectPath !== "string" || !projectPath.trim()) {
      return res.status(400).json({
        success: false,
        error: "projectPath must be a non-empty string.",
      });
    }
 
    if (filePath !== undefined && typeof filePath !== "string") {
      return res.status(400).json({
        success: false,
        error: "filePath must be a string when provided.",
      });
    }
 
    if (
      sensitivity !== "strict" &&
      sensitivity !== "balanced" &&
      sensitivity !== "thorough"
    ) {
      return res.status(400).json({
        success: false,
        error: "sensitivity must be strict, balanced, or thorough.",
      });
    }
 
    if (typeof includeTests !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "includeTests must be a boolean.",
      });
    }
 
    try {
      projectPath = (await resolveProjectPath(projectPath)).projectPath;
    } catch (error) {
      return res.status(400).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Invalid project path or repository URL.",
      });
    }
 
    if (
      typeof filePath === "string" &&
      (path.isAbsolute(filePath) ||
        filePath.split(/[\\/]/).includes(".."))
    ) {
      return res.status(400).json({
        success: false,
        error: "filePath must be relative to projectPath.",
      });
    }
 
    const report = await detectSecrets(
      projectPath,
      typeof filePath === "string" && filePath.trim()
        ? filePath.trim()
        : undefined,
      { sensitivity, includeTests },
    );
 
    return res.json(report);
  } catch (error) {
    return res.status(500).json({
      success: false,
      tool: "detect_secrets",
      error:
        error instanceof Error
          ? error.message
          : "Failed to scan for secrets.",
    });
  }
});

app.post("/api/generate-tests", async (req, res) => {
  try {
    let {
      projectPath,
      filePath,
      framework = "auto",
      includeTested = false,
    } = req.body ?? {};
 
    if (typeof projectPath !== "string" || !projectPath.trim()) {
      return res.status(400).json({
        success: false,
        error: "projectPath must be a non-empty string.",
      });
    }
 
    if (filePath !== undefined && typeof filePath !== "string") {
      return res.status(400).json({
        success: false,
        error: "filePath must be a string when provided.",
      });
    }
 
    if (!["auto", "vitest", "jest"].includes(framework)) {
      return res.status(400).json({
        success: false,
        error: "framework must be auto, vitest, or jest.",
      });
    }
 
    if (typeof includeTested !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "includeTested must be a boolean.",
      });
    }
 
    try {
      projectPath = (await resolveProjectPath(projectPath)).projectPath;
    } catch (error) {
      return res.status(400).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Invalid project path or repository URL.",
      });
    }
 
    if (
      typeof filePath === "string" &&
      (path.isAbsolute(filePath) ||
        filePath.split(/[\\/]/).includes(".."))
    ) {
      return res.status(400).json({
        success: false,
        error: "filePath must be relative to projectPath.",
      });
    }
 
    const report = await generateTests(
      projectPath,
      typeof filePath === "string" && filePath.trim()
        ? filePath.trim()
        : undefined,
      { framework, includeTested },
    );
 
    return res.json(report);
  } catch (error) {
    return res.status(500).json({
      success: false,
      tool: "generate_tests",
      error:
        error instanceof Error
          ? error.message
          : "Failed to generate tests.",
    });
  }
});


app.listen(PORT, "127.0.0.1", () => {
  console.log(
    `Dependency viewer HTTP bridge running at http://127.0.0.1:${PORT}`
  );
});