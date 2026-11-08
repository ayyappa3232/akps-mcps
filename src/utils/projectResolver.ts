import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CACHE_ROOT = path.join(
  os.tmpdir(),
  "developer-productivity-mcp",
  "repositories",
);

export type ProjectSource = "local" | "github";

export interface ResolvedProject {
  originalPath: string;
  projectPath: string;
  source: ProjectSource;
  repositoryUrl?: string;
  cached: boolean;
}

function isGitHubUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "github.com" || url.hostname === "www.github.com")
    );
  } catch {
    return false;
  }
}

function normalizeGitHubUrl(value: string): string {
  const url = new URL(value);
  const segments = url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length !== 2) {
    throw new Error(
      "Only public GitHub repository URLs are supported, for example https://github.com/owner/repository.git",
    );
  }

  const owner = segments[0];
  const repository = segments[1].replace(/\.git$/i, "");

  if (!owner || !repository) {
    throw new Error("The GitHub repository URL is invalid.");
  }

  return `https://github.com/${owner}/${repository}.git`;
}

function repositoryCachePath(repositoryUrl: string): string {
  const key = crypto
    .createHash("sha256")
    .update(repositoryUrl)
    .digest("hex")
    .slice(0, 16);

  const repositoryName = repositoryUrl
    .split("/")
    .pop()
    ?.replace(/\.git$/i, "")
    .replace(/[^a-zA-Z0-9._-]/g, "-") || "repository";

  return path.join(CACHE_ROOT, `${repositoryName}-${key}`);
}

function looksLikeGitRepository(directory: string): boolean {
  return fs.existsSync(path.join(directory, ".git"));
}

async function clonePublicGitHubRepository(
  repositoryUrl: string,
): Promise<ResolvedProject> {
  const target = repositoryCachePath(repositoryUrl);

  if (looksLikeGitRepository(target)) {
    return {
      originalPath: repositoryUrl,
      projectPath: target,
      source: "github",
      repositoryUrl,
      cached: true,
    };
  }

  fs.mkdirSync(CACHE_ROOT, { recursive: true });

  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }

  try {
    await execFileAsync("git", [
      "clone",
      "--depth",
      "1",
      repositoryUrl,
      target,
    ]);
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr || "")
        : "";

    throw new Error(
      `Unable to clone the public GitHub repository. ${stderr.trim() || "Make sure the repository is public and the URL is correct."}`,
    );
  }

  return {
    originalPath: repositoryUrl,
    projectPath: target,
    source: "github",
    repositoryUrl,
    cached: false,
  };
}

/**
 * Accepts either a local absolute project directory or a public GitHub URL.
 * All analyzers can continue working with the returned local projectPath.
 */
export async function resolveProjectPath(
  projectSource: string,
): Promise<ResolvedProject> {
  const value = projectSource.trim();

  if (!value) {
    throw new Error("projectPath is required.");
  }

  if (isGitHubUrl(value)) {
    return clonePublicGitHubRepository(normalizeGitHubUrl(value));
  }

  if (!path.isAbsolute(value)) {
    throw new Error(
      "Project path must be an absolute local path or a public GitHub repository URL.",
    );
  }

  if (!fs.existsSync(value)) {
    throw new Error(`Project path does not exist: ${value}`);
  }

  if (!fs.statSync(value).isDirectory()) {
    throw new Error(`Project path is not a directory: ${value}`);
  }

  return {
    originalPath: value,
    projectPath: fs.realpathSync(value),
    source: "local",
    cached: false,
  };
}
