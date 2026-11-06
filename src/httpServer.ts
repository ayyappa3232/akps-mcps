import express from "express";
import path from "node:path";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { generateDependencyTrace } from "./tools/traceDependencies.js";
import { explainMethod } from "./tools/explainMethod.js";

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

app.post("/api/dependencies", (req, res) => {
  try {
    const {
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

    if (!isAbsolute(projectPath)) {
      res.status(400).json({
        success: false,
        error: "projectPath must be an absolute path.",
      });
      return;
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
    const {
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

    if (!isAbsolute(projectPath)) {
      res.status(400).json({
        success: false,
        error: "projectPath must be an absolute path.",
      });
      return;
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

app.listen(PORT, "127.0.0.1", () => {
  console.log(
    `Dependency viewer HTTP bridge running at http://127.0.0.1:${PORT}`
  );
});
