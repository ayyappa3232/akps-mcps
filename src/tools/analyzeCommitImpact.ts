import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import ts from "typescript";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveProjectPath } from "../utils/projectResolver.js";

/* -------------------------------------------------------------------------- */
/*  Report types                                                              */
/* -------------------------------------------------------------------------- */

type Severity = "critical" | "high" | "medium" | "low" | "info";

/**
 * commit  - one commit, compared with its first parent.
 * range   - a branch or range, compared with the merge base of base and head.
 * staged  - changes added to the index.
 * working - every uncommitted change, including new untracked files.
 */
type Mode = "commit" | "range" | "staged" | "working";

type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange";

type FileCategory =
  | "source"
  | "test"
  | "config"
  | "docs"
  | "style"
  | "asset"
  | "migration"
  | "dependency"
  | "lockfile"
  | "ci"
  | "generated"
  | "other";

type SymbolKind =
  | "function"
  | "component"
  | "class"
  | "method"
  | "variable"
  | "type"
  | "interface"
  | "enum"
  | "namespace";

/**
 * added       - a new symbol.
 * removed     - a symbol no longer exists.
 * modified    - the body changed, the signature did not.
 * signature   - the signature or shape changed.
 * exported    - the symbol became public.
 * unexported  - the symbol is no longer public.
 */
type SymbolChangeKind = "added" | "removed" | "modified" | "signature" | "exported" | "unexported";

type RiskLevel = "low" | "medium" | "high" | "critical";

interface CommitInfo {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  author: string;
  date: string;
  parents: string[];
  isMerge: boolean;
  refs: string[];
}

interface SymbolChange {
  name: string;
  kind: SymbolKind;
  change: SymbolChangeKind;
  exported: boolean;
  /** Public names, for example "default" or "parseConfig". */
  exportNames: string[];
  before?: string;
  after?: string;
  line?: number;
}

interface Dependent {
  filePath: string;
  /** 1 means the file imports the changed file directly. */
  depth: number;
  /** The file it reaches the change through, for indirect dependents. */
  via?: string;
  /** Names it imports from the changed file. */
  imports: string[];
  /** Changed symbols that this file actually imports. */
  affectedSymbols: string[];
  usageLines: number[];
  isTest: boolean;
}

interface FileHistory {
  /** Commits that touched the file in the 90 days before this change. */
  commits90d: number;
  /** Of those, commits whose message looks like a bug fix. */
  fixes90d: number;
  /** Different authors in the last year. */
  authors: number;
  lastChanged?: string;
}

interface Risk {
  id: string;
  severity: Severity;
  title: string;
  description: string;
  filePath?: string;
  related?: string[];
}

interface FileImpact {
  filePath: string;
  oldPath?: string;
  status: ChangeStatus;
  category: FileCategory;
  language?: string;
  additions: number;
  deletions: number;
  binary: boolean;
  symbols: SymbolChange[];
  hiddenSymbols: number;
  /** Only whitespace or comments changed. */
  formattingOnly: boolean;
  directDependents: number;
  transitiveDependents: number;
  dependents: Dependent[];
  hiddenDependents: number;
  affectedTests: string[];
  history: FileHistory;
  isEntryPoint: boolean;
  risks: Risk[];
  riskScore: number;
  severity: Severity;
}

interface ApiChange {
  filePath: string;
  name: string;
  change: SymbolChangeKind;
  kind: SymbolKind;
  before?: string;
  after?: string;
  dependentFiles: number;
}

interface RouteChange {
  filePath: string;
  route: string;
  change: "added" | "removed";
}

interface DependencyChange {
  manifest: string;
  name: string;
  section: string;
  change: "added" | "removed" | "changed";
  from?: string;
  to?: string;
  bump?: "major" | "minor" | "patch" | "downgrade" | "unknown";
  /** For a removed package: files that still import it. */
  stillUsedBy?: string[];
}

interface ManifestChange {
  manifest: string;
  field: string;
  before?: string;
  after?: string;
}

interface Reviewer {
  name: string;
  commits: number;
  files: number;
  lastActive: string;
}

interface ChecklistItem {
  text: string;
  severity: Severity;
}

interface RecentCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}

interface CommitImpactReport {
  success: boolean;
  tool: "analyze_commit_impact";
  projectPath: string;
  repoRoot: string;
  mode: Mode;
  /** The commit, the tip of the range, or a description of uncommitted changes. */
  commit: CommitInfo;
  baseLabel: string;
  headLabel: string;
  rangeCommitCount: number;
  stats: { files: number; additions: number; deletions: number };
  files: FileImpact[];
  blastRadius: {
    directFiles: number;
    transitiveFiles: number;
    byDepth: number[];
    testFiles: number;
  };
  tests: {
    affected: string[];
    changed: string[];
    untestedSources: string[];
  };
  api: {
    removed: ApiChange[];
    changed: ApiChange[];
    added: ApiChange[];
    routes: RouteChange[];
  };
  dependencyChanges: DependencyChange[];
  manifestChanges: ManifestChange[];
  newEnvVars: string[];
  risks: Risk[];
  riskScore: number;
  riskLevel: RiskLevel;
  reviewers: Reviewer[];
  checklist: ChecklistItem[];
  recentCommits: RecentCommit[];
  categoryCounts: Record<FileCategory, number>;
  graph: { filesInGraph: number; unresolvedImports: number; languages: string[] };
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbf2158";

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 35,
  high: 20,
  medium: 9,
  low: 3,
  info: 0,
};

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 128 * 1024 * 1024;
const MAX_CHANGED_FILES = 1_500;
const MAX_GRAPH_FILES = 6_000;
const MAX_BLOB_BYTES = 400_000;
const MAX_UNTRACKED = 500;
const MAX_SYMBOLS_PER_FILE = 40;
const MAX_DEPENDENTS_SHOWN = 24;
const MAX_DEPENDENTS_TOTAL = 3_000;
const MAX_USAGE_LINES = 5;
const MAX_HISTORY_COMMITS = 1_500;
const MAX_RECENT_COMMITS = 30;
const MAX_REVIEWERS = 4;
const MAX_WARNINGS = 25;
const DEFAULT_MAX_DEPTH = 5;
const CHURN_WINDOW_DAYS = 90;

const CODE_EXTENSIONS: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
  ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".py": "Python", ".go": "Go", ".java": "Java", ".kt": "Kotlin", ".kts": "Kotlin",
  ".rb": "Ruby", ".php": "PHP", ".cs": "C#", ".rs": "Rust", ".swift": "Swift",
  ".c": "C", ".h": "C", ".cpp": "C++", ".cc": "C++", ".hpp": "C++",
  ".scala": "Scala", ".vue": "Vue", ".svelte": "Svelte", ".sh": "Shell",
};

const JS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

const SENSITIVE_PATH_PATTERN =
  /(^|[/_.-])(auth|authn|authz|login|logout|signin|signup|passwords?|passwd|secrets?|tokens?|credentials?|crypto|encrypt|decrypt|payments?|billing|checkout|stripe|permissions?|acl|rbac|security|sessions?|oauth|jwt|csrf|cors)([/_.-]|$)/i;

const FIX_MESSAGE_PATTERN = /\b(fix(e[sd])?|bug(fix)?|hotfix|patch|regression|revert|crash|broken)\b/i;

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function clip(value: string, length = 140): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

function hashOf(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function worstSeverity(items: Severity[]): Severity {
  for (const severity of SEVERITY_ORDER) {
    if (items.includes(severity)) return severity;
  }
  return "info";
}

function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

/* -------------------------------------------------------------------------- */
/*  Running git safely                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Settings that stop a repository's own configuration from running programs:
 * no filesystem monitor hook, no external diff driver, no text conversion.
 */
const SAFE_GIT_CONFIG = [
  "-c", "core.fsmonitor=false",
  "-c", "core.quotepath=off",
  "-c", "diff.external=",
  "-c", "core.pager=cat",
];

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    LC_ALL: "C",
  };

  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_EXTERNAL_DIFF"]) {
    delete env[key];
  }

  return env;
}

class GitError extends Error {}

function explainGitFailure(stderr: string): string {
  const text = stderr.trim();

  if (/dubious ownership/i.test(text)) {
    return "Git refuses to read this repository because its folder is owned by another user. Run `git config --global --add safe.directory <path>` if you trust it.";
  }
  if (/not a git repository/i.test(text)) return "This folder is not inside a git repository.";
  if (/unknown revision|bad revision|ambiguous argument|not a valid object/i.test(text)) {
    return "That commit, branch, or tag was not found in this repository.";
  }

  return clip(text || "git failed.", 300);
}

function runGit(
  cwd: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...SAFE_GIT_CONFIG, ...args],
      {
        cwd,
        env: gitEnvironment(),
        maxBuffer: GIT_MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          if (options.allowFailure) {
            resolve("");
            return;
          }

          const code = (error as NodeJS.ErrnoException).code;
          reject(
            new GitError(
              code === "ENOENT"
                ? "git is not installed or is not on the PATH."
                : explainGitFailure(stderr || error.message),
            ),
          );
          return;
        }

        resolve(stdout);
      },
    );
  });
}

/** Reads many objects with a single `git cat-file --batch` process. Missing objects map to null. */
function readObjects(cwd: string, specs: string[]): Promise<Map<string, Buffer | null>> {
  return new Promise((resolve, reject) => {
    const clean = specs.filter((spec) => !/[\n\r\0]/.test(spec));
    const result = new Map<string, Buffer | null>();

    if (clean.length === 0) {
      resolve(result);
      return;
    }

    const child = spawn("git", [...SAFE_GIT_CONFIG, "cat-file", "--batch"], {
      cwd,
      env: gitEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > GIT_MAX_BUFFER) {
        failed = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new GitError(error.message));
    });

    child.on("close", () => {
      clearTimeout(timer);

      if (failed) {
        reject(new GitError("The repository is too large to read in one pass."));
        return;
      }

      const buffer = Buffer.concat(chunks);
      let position = 0;

      for (const spec of clean) {
        const newline = buffer.indexOf(10, position);
        if (newline === -1) break;

        const header = buffer.toString("utf8", position, newline);
        position = newline + 1;

        if (/ (missing|ambiguous)$/.test(header)) {
          result.set(spec, null);
          continue;
        }

        const size = Number(header.split(" ")[2]);
        if (!Number.isFinite(size) || position + size > buffer.length) break;

        result.set(spec, buffer.subarray(position, position + size));
        position += size + 1;
      }

      resolve(result);
    });

    child.stdin.on("error", () => {
      // The process may exit early on a bad repository. The close handler reports it.
    });
    child.stdin.end(`${clean.join("\n")}\n`);
  });
}

/** Refs are checked before they reach git so a value can never be read as an option. */
function assertSafeRef(value: string, label: string): string {
  const ref = value.trim();

  if (
    ref.length === 0 ||
    ref.length > 200 ||
    ref.startsWith("-") ||
    !/^[A-Za-z0-9._/~^@{}+-]+$/.test(ref) ||
    ref.includes("..")
  ) {
    throw new Error(`${label} is not a valid commit, branch, or tag name.`);
  }

  return ref;
}

async function resolveCommit(cwd: string, ref: string, label: string): Promise<string> {
  const safe = assertSafeRef(ref, label);
  const out = (
    await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${safe}^{commit}`], {
      allowFailure: true,
    })
  ).trim();

  if (!/^[0-9a-f]{40}$/.test(out)) {
    throw new Error(`${label} "${safe}" was not found in this repository.`);
  }

  return out;
}

async function hasCommits(cwd: string): Promise<boolean> {
  const out = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
    allowFailure: true,
  });
  return /^[0-9a-f]{40}/.test(out.trim());
}

/* -------------------------------------------------------------------------- */
/*  Classifying files                                                         */
/* -------------------------------------------------------------------------- */

const LOCK_FILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
  "bun.lock", "Cargo.lock", "poetry.lock", "Pipfile.lock", "Gemfile.lock", "composer.lock",
  "go.sum", "packages.lock.json",
]);

const DEPENDENCY_FILES = /(^|\/)(package\.json|requirements[^/]*\.txt|Pipfile|pyproject\.toml|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|\.csproj)$/;

function languageOf(filePath: string): string | undefined {
  return CODE_EXTENSIONS[path.posix.extname(filePath).toLowerCase()];
}

function isTestPath(filePath: string): boolean {
  return (
    /(^|\/)(__tests__|__mocks__|tests?|spec|e2e|cypress|testing)\//i.test(filePath) ||
    /\.(test|spec|e2e)\.[cm]?[jt]sx?$/i.test(filePath) ||
    /(^|\/)test_[^/]+\.py$|_test\.(py|go)$/i.test(filePath) ||
    /Tests?\.(java|kt|cs)$/.test(filePath)
  );
}

function categoryOf(filePath: string): FileCategory {
  const base = path.posix.basename(filePath);
  const extension = path.posix.extname(base).toLowerCase();

  if (LOCK_FILES.has(base)) return "lockfile";
  if (/(^|\/)\.github\/(workflows|actions)\//.test(filePath) || /^(\.gitlab-ci\.yml|Jenkinsfile|azure-pipelines\.ya?ml|\.travis\.yml)$/.test(base) || /(^|\/)\.circleci\//.test(filePath)) return "ci";
  if (/(^|\/)(migrations?|db\/migrate|alembic\/versions|prisma\/migrations|flyway)\//i.test(filePath) || extension === ".sql") return "migration";
  if (/(^|\/)(__snapshots__|__generated__|generated)\//.test(filePath) || /\.(snap|min\.js|min\.css|map)$/.test(base) || /\.generated\./.test(base)) return "generated";
  if (isTestPath(filePath)) return "test";
  if (DEPENDENCY_FILES.test(filePath)) return "dependency";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".mp4", ".pdf", ".zip"].includes(extension)) return "asset";
  if ([".css", ".scss", ".sass", ".less", ".styl"].includes(extension)) return "style";
  if ([".md", ".mdx", ".rst", ".adoc"].includes(extension) || /^(LICENSE|CHANGELOG|README|CONTRIBUTING)/i.test(base) || /(^|\/)docs?\//.test(filePath)) return "docs";
  if (
    /^(Dockerfile|docker-compose[^/]*|Makefile|Procfile|\.env[^/]*|\.gitignore|\.dockerignore|\.editorconfig|\.nvmrc|\.node-version)$/.test(base) ||
    /^(tsconfig|jsconfig)[^/]*\.json$/.test(base) ||
    /\.config\.[cm]?[jt]s$/.test(base) ||
    /^\.(eslintrc|prettierrc|babelrc|stylelintrc)/.test(base) ||
    [".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".tf", ".properties"].includes(extension)
  ) {
    return "config";
  }
  if (CODE_EXTENSIONS[extension]) return "source";
  if (extension === ".json") return "config";
  return "other";
}

function isCodeCategory(category: FileCategory): boolean {
  return category === "source" || category === "test";
}

/* -------------------------------------------------------------------------- */
/*  Reading what changed                                                      */
/* -------------------------------------------------------------------------- */

interface RawChange {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

interface DiffSpec {
  mode: Mode;
  /** A commit hash, or the empty tree when there is nothing to compare with. */
  baseRev: string;
  /** A commit hash for commit and range mode. */
  headRev?: string;
  baseLabel: string;
  headLabel: string;
}

function parseNumstat(
  output: string,
): Map<string, { additions: number; deletions: number; binary: boolean; oldPath?: string }> {
  const tokens = output.split("\0");
  const result = new Map<string, { additions: number; deletions: number; binary: boolean; oldPath?: string }>();
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(token);

    if (!match) {
      index++;
      continue;
    }

    const binary = match[1] === "-";
    const entry = {
      additions: binary ? 0 : Number(match[1]),
      deletions: binary ? 0 : Number(match[2]),
      binary,
    };

    if (match[3] === "") {
      const oldPath = tokens[index + 1];
      const newPath = tokens[index + 2];
      if (newPath) result.set(newPath, { ...entry, oldPath });
      index += 3;
    } else {
      result.set(match[3], entry);
      index++;
    }
  }

  return result;
}

const STATUS_MAP: Record<string, ChangeStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typechange",
};

function parseNameStatus(output: string): Array<{ status: ChangeStatus; path: string; oldPath?: string }> {
  const tokens = output.split("\0");
  const entries: Array<{ status: ChangeStatus; path: string; oldPath?: string }> = [];
  let index = 0;

  while (index < tokens.length) {
    const code = tokens[index];

    if (!code) {
      index++;
      continue;
    }

    const letter = code[0];

    if (letter === "R" || letter === "C") {
      const oldPath = tokens[index + 1];
      const newPath = tokens[index + 2];
      if (newPath) entries.push({ status: STATUS_MAP[letter], path: newPath, oldPath });
      index += 3;
    } else {
      const file = tokens[index + 1];
      const status = STATUS_MAP[letter];
      if (file && status) entries.push({ status, path: file });
      index += 2;
    }
  }

  return entries;
}

async function describeNewFile(cwd: string, file: string): Promise<RawChange> {
  let additions = 0;
  let binary = false;

  try {
    const absolute = path.join(cwd, file);
    const stat = fs.statSync(absolute);

    if (stat.isFile() && stat.size <= MAX_BLOB_BYTES) {
      const buffer = fs.readFileSync(absolute);
      binary = buffer.subarray(0, 8000).includes(0);
      if (!binary) {
        additions = buffer.toString("utf8").split("\n").length - (buffer[buffer.length - 1] === 10 ? 1 : 0);
      }
    } else if (stat.isFile()) {
      binary = true;
    }
  } catch {
    // An unreadable file is still listed as added.
  }

  return { path: file, status: "added", additions, deletions: 0, binary };
}

async function gatherChanges(
  cwd: string,
  spec: DiffSpec,
  warn: (message: string) => void,
): Promise<RawChange[]> {
  /* The empty tree is not always present in a repository, so it is never passed to git. */
  const unborn = spec.baseRev === EMPTY_TREE;
  let changes: RawChange[] = [];

  if (spec.mode === "working" && unborn) {
    const all = (await runGit(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]))
      .split("\0")
      .filter(Boolean);

    if (all.length > MAX_UNTRACKED) {
      warn(`Only the first ${MAX_UNTRACKED} of ${all.length} files are included.`);
    }

    for (const file of all.slice(0, MAX_UNTRACKED)) changes.push(await describeNewFile(cwd, file));
  } else {
    const common = ["-z", "-M", "--no-ext-diff", "--no-textconv", "--no-color"];
    const rootCommit = spec.mode === "commit" && unborn;

    const command = (flag: string): string[] => {
      if (rootCommit) return ["diff-tree", "--root", "--no-commit-id", "-r", ...common, flag, spec.headRev!];
      if (spec.mode === "commit" || spec.mode === "range") return ["diff", ...common, flag, spec.baseRev, spec.headRev!];
      if (spec.mode === "staged") return ["diff", "--cached", ...common, flag, ...(unborn ? [] : [spec.baseRev])];
      return ["diff", ...common, flag, spec.baseRev];
    };

    const [numstat, nameStatus] = await Promise.all([
      runGit(cwd, command("--numstat")),
      runGit(cwd, command("--name-status")),
    ]);

    const counts = parseNumstat(numstat);

    for (const entry of parseNameStatus(nameStatus)) {
      const count = counts.get(entry.path);

      changes.push({
        path: entry.path,
        oldPath: entry.oldPath ?? count?.oldPath,
        status: entry.status,
        additions: count?.additions ?? 0,
        deletions: count?.deletions ?? 0,
        binary: count?.binary ?? false,
      });
    }

    if (spec.mode === "working") {
      const untracked = (await runGit(cwd, ["ls-files", "-z", "--others", "--exclude-standard"]))
        .split("\0")
        .filter(Boolean);

      if (untracked.length > MAX_UNTRACKED) {
        warn(`Only the first ${MAX_UNTRACKED} of ${untracked.length} untracked files are included.`);
      }

      for (const file of untracked.slice(0, MAX_UNTRACKED)) changes.push(await describeNewFile(cwd, file));
    }
  }

  changes.sort((a, b) => a.path.localeCompare(b.path));

  if (changes.length > MAX_CHANGED_FILES) {
    warn(`This change touches ${changes.length} files. Only the first ${MAX_CHANGED_FILES} are analyzed.`);
    changes = changes.slice(0, MAX_CHANGED_FILES);
  }

  return changes;
}

async function readCommitInfo(cwd: string, hash: string): Promise<CommitInfo> {
  const out = await runGit(cwd, [
    "show", "-s",
    "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%P%x1f%D%x1f%s%x1f%b",
    hash,
  ]);

  const parts = out.replace(/\n$/, "").split("\x1f");
  const parents = (parts[4] ?? "").split(" ").filter(Boolean);

  return {
    hash: parts[0] ?? hash,
    shortHash: parts[1] ?? hash.slice(0, 7),
    author: parts[2] ?? "",
    date: parts[3] ?? "",
    parents,
    isMerge: parents.length > 1,
    refs: (parts[5] ?? "").split(",").map((ref) => ref.trim()).filter(Boolean),
    subject: parts[6] ?? "",
    body: parts.slice(7).join("\x1f").trim(),
  };
}

async function readRecentCommits(cwd: string): Promise<RecentCommit[]> {
  const out = await runGit(
    cwd,
    ["log", "-n", String(MAX_RECENT_COMMITS), "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s"],
    { allowFailure: true },
  );

  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, author, date, subject] = line.split("\x1f");
      return { hash, shortHash, author, date, subject };
    });
}

interface HistoryCommit {
  author: string;
  email: string;
  date: number;
  subject: string;
  files: string[];
}

async function readHistory(cwd: string, tip: string | undefined): Promise<HistoryCommit[]> {
  if (!tip || tip === EMPTY_TREE) return [];

  const out = await runGit(
    cwd,
    [
      "log", "--no-merges", "-n", String(MAX_HISTORY_COMMITS), "--since=365.days.ago",
      "--name-only", "--format=%x1e%an%x1f%ae%x1f%aI%x1f%s", tip,
    ],
    { allowFailure: true },
  );

  const commits: HistoryCommit[] = [];

  for (const record of out.split("\x1e")) {
    if (!record.trim()) continue;

    const newline = record.indexOf("\n");
    const header = (newline === -1 ? record : record.slice(0, newline)).split("\x1f");
    const files = newline === -1 ? [] : record.slice(newline + 1).split("\n").filter((line) => line && !line.startsWith('"'));

    const date = Date.parse(header[2] ?? "");
    if (Number.isNaN(date)) continue;

    commits.push({
      author: header[0] ?? "",
      email: (header[1] ?? "").toLowerCase(),
      date,
      subject: header[3] ?? "",
      files,
    });
  }

  return commits;
}

/* -------------------------------------------------------------------------- */
/*  Reading code                                                              */
/* -------------------------------------------------------------------------- */

interface TreeFile {
  path: string;
  size: number;
}

async function listHeadFiles(cwd: string, spec: DiffSpec): Promise<TreeFile[]> {
  const files: TreeFile[] = [];

  if (spec.headRev) {
    const out = await runGit(cwd, ["ls-tree", "-r", "-z", "-l", spec.headRev]);

    for (const entry of out.split("\0")) {
      const tab = entry.indexOf("\t");
      if (tab === -1) continue;

      const meta = entry.slice(0, tab).split(/\s+/);
      if (meta[1] !== "blob") continue;

      files.push({ path: entry.slice(tab + 1), size: Number(meta[3]) || 0 });
    }

    return files;
  }

  const out = await runGit(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);

  for (const file of out.split("\0").filter(Boolean)) {
    try {
      const stat = fs.statSync(path.join(cwd, file));
      if (stat.isFile()) files.push({ path: file, size: stat.size });
    } catch {
      // A file deleted from disk but still in the index is skipped.
    }
  }

  return files;
}

function decode(buffer: Buffer | null | undefined): string | undefined {
  if (!buffer || buffer.length > MAX_BLOB_BYTES) return undefined;
  if (buffer.subarray(0, 8000).includes(0)) return undefined;
  return buffer.toString("utf8");
}

async function readHeadContents(
  cwd: string,
  spec: DiffSpec,
  paths: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  if (spec.headRev) {
    const specs = paths.map((file) => `${spec.headRev}:${file}`);
    const objects = await readObjects(cwd, specs);

    paths.forEach((file, index) => {
      const text = decode(objects.get(specs[index]));
      if (text !== undefined) result.set(file, text);
    });

    return result;
  }

  for (const file of paths) {
    try {
      const text = decode(fs.readFileSync(path.join(cwd, file)));
      if (text !== undefined) result.set(file, text);
    } catch {
      // Deleted or unreadable.
    }
  }

  return result;
}

/** The content of changed files as the change leaves them. Staged changes read the index, not the disk. */
async function readNewContents(
  cwd: string,
  spec: DiffSpec,
  paths: string[],
): Promise<Map<string, string>> {
  if (spec.mode !== "staged") return readHeadContents(cwd, spec, paths);

  const specs = paths.map((file) => `:${file}`);
  const objects = await readObjects(cwd, specs);
  const result = new Map<string, string>();

  paths.forEach((file, index) => {
    const text = decode(objects.get(specs[index]));
    if (text !== undefined) result.set(file, text);
  });

  return result;
}

async function readOldContents(
  cwd: string,
  spec: DiffSpec,
  paths: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (spec.baseRev === EMPTY_TREE) return result;

  const specs = paths.map((file) => `${spec.baseRev}:${file}`);
  const objects = await readObjects(cwd, specs);

  paths.forEach((file, index) => {
    const text = decode(objects.get(specs[index]));
    if (text !== undefined) result.set(file, text);
  });

  return result;
}

/* -------------------------------------------------------------------------- */
/*  Reading symbols and imports from JavaScript and TypeScript                */
/* -------------------------------------------------------------------------- */

interface ModuleImport {
  spec: string;
  line: number;
  kind: "import" | "require" | "dynamic" | "export";
  typeOnly: boolean;
  /** Names taken from the module. "*" means the whole module. */
  names: string[];
}

interface Binding {
  spec: string;
  imported: string;
  local: string;
  lines: number[];
}

interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  exported: boolean;
  exportNames: string[];
  signature: string;
  hash: string;
  line: number;
}

interface ModuleInfo {
  filePath: string;
  imports: ModuleImport[];
  bindings: Binding[];
  symbols: Map<string, SymbolInfo>;
  exportNames: Set<string>;
  /** Specifiers of `export * from`. The exported names are unknown. */
  exportStars: string[];
  fileHash: string;
  envVars: Set<string>;
  routes: Set<string>;
}

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

function normalizedText(node: ts.Node, sf: ts.SourceFile): string {
  return printer.printNode(ts.EmitHint.Unspecified, node, sf).replace(/\s+/g, " ").trim();
}

/** The same text without `export`, `default` or `declare`, so becoming public does not look like a body change. */
function declarationText(node: ts.Node, sf: ts.SourceFile): string {
  return normalizedText(node, sf).replace(/^((export|default|declare)\s+)+/, "");
}

function scriptKindFor(file: string): ts.ScriptKind {
  const extension = path.posix.extname(file);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") return ts.ScriptKind.TS;
  return ts.ScriptKind.JSX;
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!modifiers?.some((modifier) => modifier.kind === kind);
}

function containsJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (current: ts.Node) => {
    if (found) return;
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current) || ts.isJsxFragment(current)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function splitSpecifier(spec: string): string | null {
  if (!spec || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("#") || spec.includes(":")) {
    return null;
  }
  const parts = spec.split("/");
  return spec.startsWith("@") ? (parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null) : parts[0];
}

function functionSignature(
  node: ts.FunctionLikeDeclaration,
  sf: ts.SourceFile,
): string {
  const isAsync = hasModifier(node, ts.SyntaxKind.AsyncKeyword) ? "async " : "";
  const generics = node.typeParameters
    ? `<${node.typeParameters.map((parameter) => parameter.getText(sf)).join(", ")}>`
    : "";
  const params = node.parameters.map((parameter) => parameter.getText(sf).replace(/\s+/g, " ")).join(", ");
  const ret = node.type ? `: ${node.type.getText(sf).replace(/\s+/g, " ")}` : "";
  return `${isAsync}${generics}(${params})${ret}`;
}

const ENV_PATTERNS = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /process\.env\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g,
  /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
];

const ROUTE_PATTERN =
  /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|all)\(\s*(['"`])(\/[^'"`]*)\3/g;

const DECORATOR_ROUTE_PATTERN = /@(Get|Post|Put|Patch|Delete)\(\s*(['"`])([^'"`]*)\2\s*\)/g;

function analyzeModule(filePath: string, text: string): ModuleInfo {
  const info: ModuleInfo = {
    filePath,
    imports: [],
    bindings: [],
    symbols: new Map(),
    exportNames: new Set(),
    exportStars: [],
    fileHash: "",
    envVars: new Set(),
    routes: new Set(),
  };

  for (const pattern of ENV_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (match[1] !== "NODE_ENV") info.envVars.add(match[1]);
    }
  }

  for (const match of text.matchAll(ROUTE_PATTERN)) {
    if (/(app|router|server|api|route|routes)$/i.test(match[1])) {
      info.routes.add(`${match[2].toUpperCase()} ${match[4]}`);
    }
  }

  for (const match of text.matchAll(DECORATOR_ROUTE_PATTERN)) {
    info.routes.add(`${match[1].toUpperCase()} /${match[3].replace(/^\//, "")} (controller)`);
  }

  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKindFor(filePath));
  info.fileHash = hashOf(normalizedText(sf, sf));

  const localToBinding = new Map<string, Binding>();
  const namespaceLocals = new Map<string, string>();

  const addBinding = (spec: string, imported: string, local: string) => {
    const binding: Binding = { spec, imported, local, lines: [] };
    info.bindings.push(binding);
    localToBinding.set(local, binding);
  };

  const addSymbol = (
    name: string,
    kind: SymbolKind,
    exported: boolean,
    signature: string,
    hashSource: string,
    line: number,
    exportNames: string[] = exported ? [name] : [],
  ) => {
    info.symbols.set(name, {
      name,
      kind,
      exported,
      exportNames,
      signature: clip(signature, 220),
      hash: hashOf(hashSource),
      line,
    });
    for (const exportName of exportNames) info.exportNames.add(exportName);
  };

  const addClass = (node: ts.ClassDeclaration | ts.ClassExpression, name: string, exported: boolean, exportNames: string[]) => {
    const header = node
      .getText(sf)
      .split("{")[0]
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^((export|default|declare)\s+)+/, "");
    addSymbol(name, "class", exported, header, header, lineOf(sf, node), exportNames);

    for (const member of node.members) {
      let memberName: string | undefined;
      let signature = "";

      if (ts.isMethodDeclaration(member) && member.name) {
        memberName = member.name.getText(sf);
        const flags = [
          hasModifier(member, ts.SyntaxKind.StaticKeyword) ? "static " : "",
          hasModifier(member, ts.SyntaxKind.PrivateKeyword) ? "private " : "",
          hasModifier(member, ts.SyntaxKind.ProtectedKeyword) ? "protected " : "",
        ].join("");
        signature = `${flags}${memberName}${functionSignature(member, sf)}`;
      } else if (ts.isPropertyDeclaration(member) && member.name) {
        memberName = member.name.getText(sf);
        signature = `${memberName}${member.type ? `: ${member.type.getText(sf)}` : ""}`;
      } else if (ts.isConstructorDeclaration(member)) {
        memberName = "constructor";
        signature = `constructor${functionSignature(member, sf)}`;
      } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
        memberName = member.name.getText(sf);
        signature = `${ts.isGetAccessorDeclaration(member) ? "get" : "set"} ${memberName}`;
      }

      if (memberName) {
        addSymbol(
          `${name}.${memberName}`,
          "method",
          exported,
          signature,
          normalizedText(member, sf),
          lineOf(sf, member),
          exported ? exportNames.map((exportName) => `${exportName}.${memberName}`) : [],
        );
      }
    }
  };

  const collectCalls = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      const spec = node.arguments[0].text;
      const line = lineOf(sf, node);

      const kind: ModuleImport["kind"] | undefined =
        ts.isIdentifier(callee) && callee.text === "require"
          ? "require"
          : callee.kind === ts.SyntaxKind.ImportKeyword
            ? "dynamic"
            : undefined;

      if (kind) {
        const names: string[] = [];
        let current: ts.Node | undefined = node.parent;
        while (current && (ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current))) {
          current = current.parent;
        }

        if (current && ts.isVariableDeclaration(current)) {
          if (ts.isIdentifier(current.name)) {
            names.push("*");
            namespaceLocals.set(current.name.text, spec);
          } else if (ts.isObjectBindingPattern(current.name)) {
            for (const element of current.name.elements) {
              if (!ts.isIdentifier(element.name)) continue;
              const imported =
                element.propertyName && ts.isIdentifier(element.propertyName)
                  ? element.propertyName.text
                  : element.name.text;
              names.push(imported);
              addBinding(spec, imported, element.name.text);
            }
          }
        }

        info.imports.push({ spec, line, kind, typeOnly: false, names: names.length > 0 ? names : ["*"] });
      }
    }

    ts.forEachChild(node, collectCalls);
  };

  /* ---- Top-level statements ---- */

  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const spec = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      const names: string[] = [];

      if (clause?.name) {
        names.push("default");
        addBinding(spec, "default", clause.name.text);
      }

      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          names.push("*");
          namespaceLocals.set(clause.namedBindings.name.text, spec);
        } else {
          for (const element of clause.namedBindings.elements) {
            const imported = (element.propertyName ?? element.name).text;
            names.push(imported);
            addBinding(spec, imported, element.name.text);
          }
        }
      }

      info.imports.push({
        spec,
        line: lineOf(sf, statement),
        kind: "import",
        typeOnly: !!clause?.isTypeOnly,
        names,
      });
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const spec = statement.moduleSpecifier.text;
        const names: string[] = [];

        if (!statement.exportClause) {
          names.push("*");
          info.exportStars.push(spec);
        } else if (ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            names.push((element.propertyName ?? element.name).text);
            info.exportNames.add(element.name.text);
          }
        } else {
          names.push("*");
          info.exportNames.add(statement.exportClause.name.text);
        }

        info.imports.push({
          spec,
          line: lineOf(sf, statement),
          kind: "export",
          typeOnly: !!statement.isTypeOnly,
          names,
        });
      } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const local = (element.propertyName ?? element.name).text;
          info.exportNames.add(element.name.text);

          const symbol = info.symbols.get(local);
          if (symbol) {
            symbol.exported = true;
            if (!symbol.exportNames.includes(element.name.text)) symbol.exportNames.push(element.name.text);
          }
        }
      }
      continue;
    }

    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);

    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text ?? "default";
      const exportNames = exported ? [isDefault ? "default" : name] : [];
      const component = /^[A-Z]/.test(name) && statement.body ? containsJsx(statement.body) : false;

      addSymbol(
        name,
        component ? "component" : "function",
        exported,
        functionSignature(statement, sf),
        declarationText(statement, sf),
        lineOf(sf, statement),
        exportNames,
      );
    } else if (ts.isClassDeclaration(statement)) {
      const name = statement.name?.text ?? "default";
      addClass(statement, name, exported, exported ? [isDefault ? "default" : name] : []);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;

        const name = declaration.name.text;
        const init = declaration.initializer;
        const keyword = statement.declarationList.flags & ts.NodeFlags.Const ? "const" : "let";
        const type = declaration.type ? `: ${declaration.type.getText(sf).replace(/\s+/g, " ")}` : "";

        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          const component = /^[A-Z]/.test(name) && containsJsx(init);
          addSymbol(
            name,
            component ? "component" : "function",
            exported,
            `${functionSignature(init, sf)}`,
            normalizedText(declaration, sf),
            lineOf(sf, declaration),
          );
        } else {
          addSymbol(
            name,
            "variable",
            exported,
            `${keyword} ${name}${type}`,
            normalizedText(declaration, sf),
            lineOf(sf, declaration),
          );
        }
      }
    } else if (ts.isInterfaceDeclaration(statement)) {
      const text = declarationText(statement, sf);
      addSymbol(statement.name.text, "interface", exported, text, text, lineOf(sf, statement));
    } else if (ts.isTypeAliasDeclaration(statement)) {
      const text = declarationText(statement, sf);
      addSymbol(statement.name.text, "type", exported, text, text, lineOf(sf, statement));
    } else if (ts.isEnumDeclaration(statement)) {
      const text = declarationText(statement, sf);
      addSymbol(statement.name.text, "enum", exported, text, text, lineOf(sf, statement));
    } else if (ts.isModuleDeclaration(statement)) {
      const text = declarationText(statement, sf);
      addSymbol(statement.name.getText(sf), "namespace", exported, text, text, lineOf(sf, statement));
    } else if (ts.isExportAssignment(statement)) {
      const expression = statement.expression;

      if (ts.isIdentifier(expression)) {
        info.exportNames.add("default");
        const target = info.symbols.get(expression.text);
        if (target) {
          target.exported = true;
          if (!target.exportNames.includes("default")) target.exportNames.push("default");
        }
      } else {
        const kind: SymbolKind =
          ts.isArrowFunction(expression) || ts.isFunctionExpression(expression) ? "function" : "variable";
        const signature =
          ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)
            ? functionSignature(expression, sf)
            : "default export";

        addSymbol("default", kind, true, signature, normalizedText(statement, sf), lineOf(sf, statement), ["default"]);
      }
    }
  }

  collectCalls(sf);

  /* ---- Where the imported names are used ---- */

  const walkReferences = (node: ts.Node) => {
    if (ts.isTypeNode(node)) return;

    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const declaration =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) ||
        (ts.isVariableDeclaration(parent) && parent.name === node) ||
        (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) ||
        (ts.isPropertyAssignment(parent) && parent.name === node);

      if (!declaration) {
        const binding = localToBinding.get(node.text);
        if (binding && binding.lines.length < MAX_USAGE_LINES) {
          const line = lineOf(sf, node);
          if (!binding.lines.includes(line)) binding.lines.push(line);
        }
      }
      return;
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaceLocals.has(node.expression.text)
    ) {
      const spec = namespaceLocals.get(node.expression.text)!;
      const line = lineOf(sf, node);
      let binding = info.bindings.find(
        (item) => item.spec === spec && item.imported === node.name.text && item.local === node.expression.getText(sf),
      );

      if (!binding) {
        binding = { spec, imported: node.name.text, local: node.expression.getText(sf), lines: [] };
        info.bindings.push(binding);
      }

      if (binding.lines.length < MAX_USAGE_LINES && !binding.lines.includes(line)) binding.lines.push(line);
    }

    ts.forEachChild(node, walkReferences);
  };

  if (localToBinding.size > 0 || namespaceLocals.size > 0) walkReferences(sf);

  return info;
}

/* -------------------------------------------------------------------------- */
/*  Import graph                                                              */
/* -------------------------------------------------------------------------- */

interface ResolveConfig {
  baseUrl?: string;
  paths: Array<{ prefix: string; suffix: string; targets: string[] }>;
  workspaces: Map<string, string>;
}

interface GraphEdge {
  from: string;
  to: string;
  imp: ModuleImport;
}

interface Graph {
  modules: Map<string, ModuleInfo>;
  reverse: Map<string, GraphEdge[]>;
  forward: Map<string, GraphEdge[]>;
  unresolved: Array<{ from: string; spec: string; line: number }>;
}

function readResolveConfig(
  configs: Map<string, string>,
  manifests: Map<string, { name?: string; main?: string; module?: string }>,
): ResolveConfig {
  const config: ResolveConfig = { paths: [], workspaces: new Map() };

  for (const [file, text] of configs) {
    if (path.posix.dirname(file) !== ".") continue;

    const parsed = ts.parseConfigFileTextToJson(file, text).config as
      | { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }
      | undefined;

    const options = parsed?.compilerOptions;
    if (!options) continue;

    if (options.baseUrl) config.baseUrl = normalizePath(path.posix.normalize(options.baseUrl)).replace(/^\.\/?$/, "");

    for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
      const star = pattern.indexOf("*");
      config.paths.push({
        prefix: star === -1 ? pattern : pattern.slice(0, star),
        suffix: star === -1 ? "" : pattern.slice(star + 1),
        targets,
      });
    }
  }

  for (const [file, manifest] of manifests) {
    if (manifest.name && file !== "package.json") {
      config.workspaces.set(manifest.name, path.posix.dirname(file));
    }
  }

  return config;
}

function resolveFile(base: string, files: Set<string>): string | null {
  const clean = path.posix.normalize(base).replace(/^\.\//, "");
  if (files.has(clean)) return clean;

  for (const extension of RESOLVE_EXTENSIONS) {
    if (files.has(`${clean}${extension}`)) return `${clean}${extension}`;
  }

  for (const extension of RESOLVE_EXTENSIONS) {
    if (files.has(`${clean}/index${extension}`)) return `${clean}/index${extension}`;
  }

  const swapped = clean.replace(/\.(m|c)?jsx?$/, "");
  if (swapped !== clean) {
    for (const extension of [".ts", ".tsx", ".mts", ".cts"]) {
      if (files.has(`${swapped}${extension}`)) return `${swapped}${extension}`;
    }
  }

  return null;
}

/** Returns the project file a specifier points at, "external" for a package, or null when it cannot be found. */
function resolveSpecifier(
  from: string,
  spec: string,
  files: Set<string>,
  config: ResolveConfig,
): string | "external" | null {
  if (spec.startsWith(".")) {
    return resolveFile(path.posix.join(path.posix.dirname(from), spec), files);
  }

  for (const entry of config.paths) {
    if (!spec.startsWith(entry.prefix) || !spec.endsWith(entry.suffix)) continue;

    const rest = spec.slice(entry.prefix.length, spec.length - entry.suffix.length);

    for (const target of entry.targets) {
      const mapped = target.replace("*", rest);
      const resolved = resolveFile(path.posix.join(config.baseUrl ?? "", mapped), files);
      if (resolved) return resolved;
    }
  }

  if (config.baseUrl !== undefined) {
    const resolved = resolveFile(path.posix.join(config.baseUrl, spec), files);
    if (resolved) return resolved;
  }

  if (spec.startsWith("@/") || spec.startsWith("~/")) {
    return resolveFile(`src/${spec.slice(2)}`, files);
  }

  const packageName = splitSpecifier(spec);
  if (packageName && config.workspaces.has(packageName)) {
    const directory = config.workspaces.get(packageName)!;
    const sub = spec.slice(packageName.length).replace(/^\//, "");

    const candidates = sub
      ? [path.posix.join(directory, sub), path.posix.join(directory, "src", sub)]
      : [path.posix.join(directory, "src/index"), path.posix.join(directory, "index"), path.posix.join(directory, "src")];

    for (const candidate of candidates) {
      const resolved = resolveFile(candidate, files);
      if (resolved) return resolved;
    }
    return null;
  }

  return "external";
}

function buildGraph(
  modules: Map<string, ModuleInfo>,
  allFiles: Set<string>,
  config: ResolveConfig,
): Graph {
  const graph: Graph = { modules, reverse: new Map(), forward: new Map(), unresolved: [] };

  for (const [from, info] of modules) {
    for (const imp of info.imports) {
      const target = resolveSpecifier(from, imp.spec, allFiles, config);

      if (target === "external") continue;

      if (target === null) {
        if (imp.spec.startsWith(".") || imp.spec.startsWith("@/") || imp.spec.startsWith("~/")) {
          graph.unresolved.push({ from, spec: imp.spec, line: imp.line });
        }
        continue;
      }

      if (!modules.has(target)) continue;

      const edge: GraphEdge = { from, to: target, imp };
      graph.forward.set(from, [...(graph.forward.get(from) ?? []), edge]);
      graph.reverse.set(target, [...(graph.reverse.get(target) ?? []), edge]);
    }
  }

  return graph;
}

/** Files that depend on `target`, directly or through other files, up to `maxDepth` levels. */
function findDependents(
  graph: Graph,
  target: string,
  maxDepth: number,
): Array<{ path: string; depth: number; via?: string; edges: GraphEdge[] }> {
  const seen = new Map<string, { path: string; depth: number; via?: string; edges: GraphEdge[] }>();
  seen.set(target, { path: target, depth: 0, edges: [] });
  let frontier = [target];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];

    for (const current of frontier) {
      for (const edge of graph.reverse.get(current) ?? []) {
        const existing = seen.get(edge.from);

        if (existing) {
          if (existing.depth === depth && existing.via === current) existing.edges.push(edge);
          continue;
        }

        if (seen.size > MAX_DEPENDENTS_TOTAL) return [...seen.values()].slice(1);

        seen.set(edge.from, {
          path: edge.from,
          depth,
          via: depth === 1 ? undefined : current,
          edges: [edge],
        });
        next.push(edge.from);
      }
    }

    frontier = next;
  }

  return [...seen.values()].slice(1);
}

/* -------------------------------------------------------------------------- */
/*  Comparing symbols                                                         */
/* -------------------------------------------------------------------------- */

const CHANGE_RANK: Record<SymbolChangeKind, number> = {
  removed: 0,
  signature: 1,
  unexported: 2,
  exported: 3,
  modified: 4,
  added: 5,
};

function diffSymbols(before: ModuleInfo | undefined, after: ModuleInfo | undefined): SymbolChange[] {
  const changes: SymbolChange[] = [];
  const old = before?.symbols ?? new Map<string, SymbolInfo>();
  const current = after?.symbols ?? new Map<string, SymbolInfo>();

  for (const [name, symbol] of current) {
    const previous = old.get(name);

    if (!previous) {
      changes.push({
        name,
        kind: symbol.kind,
        change: "added",
        exported: symbol.exported,
        exportNames: symbol.exportNames,
        after: symbol.signature,
        line: symbol.line,
      });
      continue;
    }

    if (previous.hash !== symbol.hash) {
      changes.push({
        name,
        kind: symbol.kind,
        change: previous.signature !== symbol.signature ? "signature" : "modified",
        exported: symbol.exported,
        exportNames: symbol.exportNames.length > 0 ? symbol.exportNames : previous.exportNames,
        before: previous.signature,
        after: symbol.signature,
        line: symbol.line,
      });
    }

    if (previous.exported !== symbol.exported) {
      changes.push({
        name,
        kind: symbol.kind,
        change: symbol.exported ? "exported" : "unexported",
        exported: symbol.exported,
        exportNames: symbol.exported ? symbol.exportNames : previous.exportNames,
        before: previous.signature,
        after: symbol.signature,
        line: symbol.line,
      });
    }
  }

  for (const [name, symbol] of old) {
    if (current.has(name)) continue;

    changes.push({
      name,
      kind: symbol.kind,
      change: "removed",
      exported: symbol.exported,
      exportNames: symbol.exportNames,
      before: symbol.signature,
    });
  }

  return changes.sort(
    (a, b) =>
      Number(b.exported) - Number(a.exported) ||
      CHANGE_RANK[a.change] - CHANGE_RANK[b.change] ||
      a.name.localeCompare(b.name),
  );
}

/* -------------------------------------------------------------------------- */
/*  Dependencies and manifests                                                */
/* -------------------------------------------------------------------------- */

interface Manifest {
  name?: string;
  main?: string;
  module?: string;
  type?: string;
  bin?: unknown;
  exports?: unknown;
  engines?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

function parseManifest(text: string | undefined): Manifest | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? (value as Manifest) : undefined;
  } catch {
    return undefined;
  }
}

function versionParts(range: string): [number, number, number] | null {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range);
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null;
}

function bumpOf(from: string, to: string): DependencyChange["bump"] {
  const a = versionParts(from);
  const b = versionParts(to);
  if (!a || !b) return "unknown";

  for (let index = 0; index < 3; index++) {
    if (b[index] > a[index]) return (["major", "minor", "patch"] as const)[index];
    if (b[index] < a[index]) return "downgrade";
  }
  return "unknown";
}

function stableStringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function diffManifests(
  file: string,
  before: Manifest | undefined,
  after: Manifest | undefined,
): { dependencies: DependencyChange[]; fields: ManifestChange[] } {
  const dependencies: DependencyChange[] = [];
  const fields: ManifestChange[] = [];

  for (const section of DEPENDENCY_SECTIONS) {
    const old = before?.[section] ?? {};
    const current = after?.[section] ?? {};

    for (const name of new Set([...Object.keys(old), ...Object.keys(current)])) {
      if (!(name in old)) {
        dependencies.push({ manifest: file, name, section, change: "added", to: current[name] });
      } else if (!(name in current)) {
        dependencies.push({ manifest: file, name, section, change: "removed", from: old[name] });
      } else if (old[name] !== current[name]) {
        dependencies.push({
          manifest: file,
          name,
          section,
          change: "changed",
          from: old[name],
          to: current[name],
          bump: bumpOf(old[name], current[name]),
        });
      }
    }
  }

  for (const field of ["type", "main", "module", "bin", "exports", "engines"] as const) {
    const a = stableStringify(before?.[field]);
    const b = stableStringify(after?.[field]);
    if (a !== b) {
      fields.push({
        manifest: file,
        field,
        before: a === undefined ? undefined : clip(a, 120),
        after: b === undefined ? undefined : clip(b, 120),
      });
    }
  }

  const oldScripts = before?.scripts ?? {};
  const newScripts = after?.scripts ?? {};
  for (const name of new Set([...Object.keys(oldScripts), ...Object.keys(newScripts)])) {
    if (oldScripts[name] !== newScripts[name]) {
      fields.push({
        manifest: file,
        field: `scripts.${name}`,
        before: oldScripts[name] === undefined ? undefined : clip(oldScripts[name], 120),
        after: newScripts[name] === undefined ? undefined : clip(newScripts[name], 120),
      });
    }
  }

  return { dependencies, fields };
}

const NODE_BUILTINS = new Set<string>(builtinModules.flatMap((name) => [name, `node:${name}`]));

/* -------------------------------------------------------------------------- */
/*  Test matching                                                             */
/* -------------------------------------------------------------------------- */

function testStem(file: string): string {
  return path.posix
    .basename(file)
    .replace(/\.(test|spec|e2e)(\.[^.]+)$/i, "$2")
    .replace(/^test_/, "")
    .replace(/_test(\.[^.]+)$/, "$1")
    .replace(/\.[^.]+$/, "")
    .toLowerCase();
}

function relatedByName(source: string, tests: string[]): string[] {
  const stem = path.posix.basename(source).replace(/\.[^.]+$/, "").toLowerCase();
  if (!stem || stem === "index") return [];

  const sourceDirectories = path.posix.dirname(source).split("/").filter((part) => part && part !== "." && part !== "src");

  return tests.filter((test) => {
    if (testStem(test) !== stem) return false;
    const testDirectories = new Set(path.posix.dirname(test).split("/"));
    return sourceDirectories.length === 0 || sourceDirectories.some((part) => testDirectories.has(part));
  });
}

/* -------------------------------------------------------------------------- */
/*  Risk helpers                                                              */
/* -------------------------------------------------------------------------- */

function makeRisk(
  id: string,
  severity: Severity,
  title: string,
  description: string,
  filePath?: string,
  related?: string[],
): Risk {
  return { id, severity, title, description, filePath, related: related?.slice(0, 6) };
}

function scoreRisks(risks: Risk[]): number {
  return Math.min(100, risks.reduce((sum, risk) => sum + SEVERITY_WEIGHT[risk.severity], 0));
}

function levelFor(score: number): RiskLevel {
  if (score >= 70) return "critical";
  if (score >= 45) return "high";
  if (score >= 20) return "medium";
  return "low";
}

function joinNames(items: string[], limit = 3): string {
  const shown = items.slice(0, limit).join(", ");
  return items.length > limit ? `${shown} and ${items.length - limit} more` : shown;
}

/* -------------------------------------------------------------------------- */
/*  Main analysis                                                             */
/* -------------------------------------------------------------------------- */

export async function analyzeCommitImpact(
  projectPath: string,
  options: {
    mode?: Mode;
    commit?: string;
    base?: string;
    head?: string;
    maxDepth?: number;
  } = {},
): Promise<CommitImpactReport> {
  const mode = options.mode ?? "commit";
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  if (mode !== "commit" && mode !== "range" && mode !== "staged" && mode !== "working") {
    throw new Error("mode must be commit, range, staged, or working.");
  }

  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 8) {
    throw new Error("maxDepth must be an integer between 1 and 8.");
  }

  for (const [label, value] of [
    ["commit", options.commit],
    ["base", options.base],
    ["head", options.head],
  ] as const) {
    if (value !== undefined && typeof value !== "string") {
      throw new Error(`${label} must be a string.`);
    }
  }

  const resolvedProject = await resolveProjectPath(projectPath);
  const projectRoot = fs.realpathSync(resolvedProject.projectPath);
  const warnings: string[] = [];

  const warn = (message: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message);
    else if (warnings.length === MAX_WARNINGS) warnings.push("Further warnings were omitted.");
  };

  /* ---- Repository ---- */

  const repoRoot = fs.realpathSync((await runGit(projectRoot, ["rev-parse", "--show-toplevel"])).trim());
  const prefix = normalizePath(path.relative(repoRoot, projectRoot));
  const inProject = (file: string) => !prefix || file === prefix || file.startsWith(`${prefix}/`);

  const headExists = await hasCommits(repoRoot);

  const shallow = (
    await runGit(repoRoot, ["rev-parse", "--is-shallow-repository"], { allowFailure: true })
  ).trim() === "true";

  if (shallow) {
    warn(
      "This is a shallow clone. The oldest commits in it look like new files, and history-based signals such as churn and reviewers are limited. Run `git fetch --unshallow` for complete results.",
    );
  }

  /* ---- What to compare ---- */

  let spec: DiffSpec;
  let commit: CommitInfo;
  let rangeCommitCount = 0;

  if (mode === "commit") {
    if (!headExists) throw new Error("This repository has no commits yet.");

    const hash = await resolveCommit(repoRoot, options.commit?.trim() || "HEAD", "Commit");
    const parents = (await runGit(repoRoot, ["rev-list", "--parents", "-n", "1", hash]))
      .trim()
      .split(" ")
      .slice(1);

    commit = await readCommitInfo(repoRoot, hash);
    rangeCommitCount = 1;

    spec = {
      mode,
      baseRev: parents[0] ?? EMPTY_TREE,
      headRev: hash,
      baseLabel: parents[0] ? parents[0].slice(0, 7) : "empty tree",
      headLabel: commit.shortHash,
    };
  } else if (mode === "range") {
    if (!headExists) throw new Error("This repository has no commits yet.");

    const headHash = await resolveCommit(repoRoot, options.head?.trim() || "HEAD", "Head");

    let baseRef = options.base?.trim();
    if (!baseRef) {
      const remoteHead = (
        await runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
          allowFailure: true,
        })
      ).trim();

      const candidates = [remoteHead, "main", "master", "develop", "origin/main", "origin/master"].filter(Boolean);

      for (const candidate of candidates) {
        const found = (
          await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], {
            allowFailure: true,
          })
        ).trim();

        if (found && found !== headHash) {
          baseRef = candidate;
          break;
        }
      }

      if (!baseRef) {
        throw new Error("No base branch was found. Enter a base branch, tag, or commit to compare with.");
      }
    }

    const baseHash = await resolveCommit(repoRoot, baseRef, "Base");
    const mergeBase =
      (await runGit(repoRoot, ["merge-base", baseHash, headHash], { allowFailure: true })).trim() || baseHash;

    commit = await readCommitInfo(repoRoot, headHash);
    rangeCommitCount =
      Number((await runGit(repoRoot, ["rev-list", "--count", `${mergeBase}..${headHash}`], { allowFailure: true })).trim()) || 0;

    spec = {
      mode,
      baseRev: mergeBase,
      headRev: headHash,
      baseLabel: `${baseRef} (${mergeBase.slice(0, 7)})`,
      headLabel: `${options.head?.trim() || "HEAD"} (${headHash.slice(0, 7)})`,
    };
  } else {
    const headHash = headExists
      ? (await runGit(repoRoot, ["rev-parse", "HEAD"])).trim()
      : EMPTY_TREE;
    const author = (await runGit(repoRoot, ["config", "user.name"], { allowFailure: true })).trim();

    commit = {
      hash: "",
      shortHash: mode,
      subject: mode === "staged" ? "Staged changes" : "Uncommitted changes",
      body: "",
      author,
      date: new Date().toISOString(),
      parents: [],
      isMerge: false,
      refs: [],
    };

    spec = {
      mode,
      baseRev: headHash,
      baseLabel: headExists ? `HEAD (${headHash.slice(0, 7)})` : "empty tree",
      headLabel: mode === "staged" ? "index" : "working tree",
    };
  }

  /* ---- Changes ---- */

  const changes = (await gatherChanges(repoRoot, spec, warn)).filter(
    (change) => inProject(change.path) || (change.oldPath ? inProject(change.oldPath) : false),
  );

  if (changes.length === 0) {
    throw new Error(
      mode === "working" || mode === "staged"
        ? "There are no changes to analyze."
        : "This comparison has no file changes.",
    );
  }

  const changedPaths = new Set(changes.map((change) => change.path));
  const removedPaths = new Set<string>();
  for (const change of changes) {
    if (change.status === "deleted") removedPaths.add(change.path);
    if (change.oldPath && change.status === "renamed") removedPaths.add(change.oldPath);
  }

  /* ---- The project as the change leaves it ---- */

  const tree = await listHeadFiles(repoRoot, spec);
  const allPaths = new Set(tree.map((file) => file.path));

  const codeCandidates = tree
    .filter(
      (file) =>
        JS_EXTENSIONS.has(path.posix.extname(file.path).toLowerCase()) &&
        file.size <= MAX_BLOB_BYTES &&
        !/(^|\/)node_modules\//.test(file.path) &&
        !/\.d\.[cm]?ts$/.test(file.path),
    )
    .map((file) => file.path);

  if (codeCandidates.length > MAX_GRAPH_FILES) {
    warn(`Only ${MAX_GRAPH_FILES} of ${codeCandidates.length} code files were read for the dependency graph.`);
    codeCandidates.length = MAX_GRAPH_FILES;
  }

  const manifestPaths = tree
    .filter((file) => /(^|\/)package\.json$/.test(file.path) && !/(^|\/)node_modules\//.test(file.path))
    .map((file) => file.path);

  const configPaths = ["tsconfig.json", "jsconfig.json"].filter((file) => allPaths.has(file));

  const contents = await readHeadContents(repoRoot, spec, [...codeCandidates, ...manifestPaths, ...configPaths]);

  const modules = new Map<string, ModuleInfo>();
  for (const file of codeCandidates) {
    const text = contents.get(file);
    if (text !== undefined) modules.set(file, analyzeModule(file, text));
  }

  const manifests = new Map<string, Manifest>();
  for (const file of manifestPaths) {
    const manifest = parseManifest(contents.get(file));
    if (manifest) manifests.set(file, manifest);
  }

  const configTexts = new Map<string, string>();
  for (const file of configPaths) {
    const text = contents.get(file);
    if (text !== undefined) configTexts.set(file, text);
  }

  const resolveConfig = readResolveConfig(configTexts, manifests);
  const graph = buildGraph(modules, allPaths, resolveConfig);

  if (codeCandidates.length === 0) {
    warn("No JavaScript or TypeScript files were found, so symbol and dependency analysis is limited to file-level changes.");
  }

  /* ---- Old and new content of changed files ---- */

  const analyzable = changes.filter(
    (change) =>
      !change.binary &&
      (JS_EXTENSIONS.has(path.posix.extname(change.path).toLowerCase()) || /(^|\/)package\.json$/.test(change.path)),
  );

  const newTexts = await readNewContents(
    repoRoot,
    spec,
    analyzable.filter((change) => change.status !== "deleted").map((change) => change.path),
  );

  const oldTexts = await readOldContents(
    repoRoot,
    spec,
    analyzable.filter((change) => change.status !== "added").map((change) => change.oldPath ?? change.path),
  );

  /* ---- History ---- */

  const historyTip = spec.baseRev === EMPTY_TREE ? undefined : spec.baseRev;
  const history = await readHistory(repoRoot, historyTip);
  const referenceDate = mode === "commit" || mode === "range" ? Date.parse(commit.date) || Date.now() : Date.now();
  const windowStart = referenceDate - CHURN_WINDOW_DAYS * 86_400_000;

  const historyByFile = new Map<string, HistoryCommit[]>();
  const trackedNames = new Set<string>();
  for (const change of changes) {
    trackedNames.add(change.path);
    if (change.oldPath) trackedNames.add(change.oldPath);
  }

  for (const entry of history) {
    for (const file of entry.files) {
      if (!trackedNames.has(file)) continue;
      const list = historyByFile.get(file) ?? [];
      list.push(entry);
      historyByFile.set(file, list);
    }
  }

  /* ---- Per-file analysis ---- */

  const allTests = [...new Set([...allPaths].filter((file) => isTestPath(file) && JS_EXTENSIONS.has(path.posix.extname(file))))];
  const manifestDeps = new Map<string, Set<string>>();

  for (const [file, manifest] of manifests) {
    const names = new Set<string>();
    if (manifest.name) names.add(manifest.name);
    for (const section of DEPENDENCY_SECTIONS) {
      for (const name of Object.keys(manifest[section] ?? {})) names.add(name);
    }
    manifestDeps.set(path.posix.dirname(file), names);
  }

  const declaredFor = (file: string): Set<string> => {
    const merged = new Set<string>();
    let directory = path.posix.dirname(file);

    for (let depth = 0; depth < 12; depth++) {
      for (const name of manifestDeps.get(directory) ?? []) merged.add(name);
      if (directory === "." || directory === "/") break;
      directory = path.posix.dirname(directory);
    }
    return merged;
  };

  const files: FileImpact[] = [];
  const apiRemoved: ApiChange[] = [];
  const apiChanged: ApiChange[] = [];
  const apiAdded: ApiChange[] = [];
  const routeChanges: RouteChange[] = [];
  const dependencyChanges: DependencyChange[] = [];
  const manifestChanges: ManifestChange[] = [];
  const newEnvVars = new Set<string>();
  const risks: Risk[] = [];

  const allDependents = new Map<string, number>();
  const allTestDependents = new Set<string>();
  const affectedTestSet = new Set<string>();
  const untestedSources: string[] = [];
  const brokenByTarget = new Map<string, Array<{ from: string; line: number; name?: string }>>();

  const entryPoints = new Set<string>();
  for (const [file, manifest] of manifests) {
    const directory = path.posix.dirname(file);
    const candidates: string[] = [];
    for (const value of [manifest.main, manifest.module]) if (typeof value === "string") candidates.push(value);
    if (typeof manifest.bin === "string") candidates.push(manifest.bin);

    const collect = (value: unknown) => {
      if (typeof value === "string") candidates.push(value);
      else if (value && typeof value === "object") Object.values(value).forEach(collect);
    };
    collect(manifest.exports);

    for (const candidate of candidates) {
      const joined = path.posix.join(directory === "." ? "" : directory, candidate.replace(/^\.\//, ""));
      const resolved = resolveFile(joined, allPaths) ?? resolveFile(joined.replace(/^(dist|build|lib)\//, "src/"), allPaths);
      if (resolved) entryPoints.add(resolved);
    }
  }

  /* Files whose exports reach other projects: entry points and what they re-export. */
  const publicApi = new Set<string>(entryPoints);
  const apiQueue = [...entryPoints];
  while (apiQueue.length > 0) {
    const current = apiQueue.pop()!;
    for (const edge of graph.forward.get(current) ?? []) {
      if (edge.imp.kind === "export" && !publicApi.has(edge.to)) {
        publicApi.add(edge.to);
        apiQueue.push(edge.to);
      }
    }
  }

  for (const change of changes) {
    const category = categoryOf(change.path);
    const language = languageOf(change.path);
    const oldPath = change.oldPath ?? change.path;
    const isJs = JS_EXTENSIONS.has(path.posix.extname(change.path).toLowerCase());

    const oldText = oldTexts.get(oldPath);
    const newText = newTexts.get(change.path);

    const oldModule = isJs && oldText !== undefined ? analyzeModule(oldPath, oldText) : undefined;
    const newModule = isJs && newText !== undefined ? analyzeModule(change.path, newText) : undefined;

    const symbolsAll = isJs ? diffSymbols(oldModule, newModule) : [];
    const formattingOnly =
      isJs &&
      !!oldModule &&
      !!newModule &&
      oldModule.fileHash === newModule.fileHash &&
      oldText !== newText;

    const symbols = symbolsAll.slice(0, MAX_SYMBOLS_PER_FILE);

    /* ---- Routes and environment variables ---- */

    if (isJs) {
      for (const route of newModule?.routes ?? []) {
        if (!oldModule?.routes.has(route)) routeChanges.push({ filePath: change.path, route, change: "added" });
      }
      for (const route of oldModule?.routes ?? []) {
        if (!newModule?.routes.has(route)) routeChanges.push({ filePath: change.path, route, change: "removed" });
      }
      for (const name of newModule?.envVars ?? []) {
        if (!oldModule?.envVars.has(name)) newEnvVars.add(name);
      }
    }

    /* ---- Manifests ---- */

    if (/(^|\/)package\.json$/.test(change.path)) {
      const diff = diffManifests(change.path, parseManifest(oldText), parseManifest(newText));
      dependencyChanges.push(...diff.dependencies);
      manifestChanges.push(...diff.fields);
    }

    /* ---- Who depends on it ---- */

    const dependents: Dependent[] = [];
    let directCount = 0;
    let transitiveCount = 0;
    const affectedBySymbol = new Map<string, Set<string>>();
    const changedPublic = symbolsAll.filter((item) => item.change !== "added" && item.exportNames.length > 0);

    if (isJs && graph.modules.has(change.path) && category !== "test") {
      const found = findDependents(graph, change.path, maxDepth);
      transitiveCount = found.length;
      directCount = found.filter((item) => item.depth === 1).length;

      for (const item of found) {
        const edges = item.edges.filter((edge) => edge.to === (item.via ?? change.path));
        const imports = [...new Set(edges.flatMap((edge) => edge.imp.names))];
        const isTest = isTestPath(item.path);

        let affected: string[] = [];
        const usageLines: number[] = [];

        if (item.depth === 1) {
          const dependentModule = graph.modules.get(item.path);
          const specs = new Set(edges.map((edge) => edge.imp.spec));
          const used = new Map<string, number[]>();

          for (const binding of dependentModule?.bindings ?? []) {
            if (specs.has(binding.spec)) used.set(binding.imported, [...(used.get(binding.imported) ?? []), ...binding.lines]);
          }

          const star = imports.includes("*") && used.size === 0;

          for (const symbol of changedPublic) {
            // A changed class member matters to every file that imports the class.
            const names = symbol.exportNames.flatMap((name) => (name.includes(".") ? [name, name.split(".")[0]] : [name]));
            const hit = star || names.some((name) => imports.includes(name) || used.has(name));
            if (!hit) continue;

            affected.push(symbol.name);
            const set = affectedBySymbol.get(symbol.name) ?? new Set<string>();
            set.add(item.path);
            affectedBySymbol.set(symbol.name, set);

            for (const name of names) {
              for (const line of used.get(name) ?? []) {
                if (!usageLines.includes(line) && usageLines.length < MAX_USAGE_LINES) usageLines.push(line);
              }
            }
          }

          affected = [...new Set(affected)];
        }

        dependents.push({
          filePath: item.path,
          depth: item.depth,
          via: item.via,
          imports: imports.slice(0, 8),
          affectedSymbols: affected.slice(0, 6),
          usageLines: usageLines.sort((a, b) => a - b),
          isTest,
        });

        allDependents.set(item.path, Math.min(allDependents.get(item.path) ?? 99, item.depth));
        if (isTest) {
          allTestDependents.add(item.path);
          affectedTestSet.add(item.path);
        }
      }

      dependents.sort(
        (a, b) =>
          a.depth - b.depth ||
          b.affectedSymbols.length - a.affectedSymbols.length ||
          a.filePath.localeCompare(b.filePath),
      );
    }

    /* ---- Tests ---- */

    const testsHere = new Set<string>(dependents.filter((item) => item.isTest).map((item) => item.filePath));
    if (category === "source") {
      for (const test of relatedByName(change.path, allTests)) testsHere.add(test);
    }
    for (const test of testsHere) affectedTestSet.add(test);

    /* ---- API ---- */

    for (const symbol of symbolsAll) {
      if (symbol.exportNames.length === 0 && symbol.change !== "unexported") continue;

      const entry: ApiChange = {
        filePath: change.path,
        name: symbol.name,
        change: symbol.change,
        kind: symbol.kind,
        before: symbol.before,
        after: symbol.after,
        dependentFiles: affectedBySymbol.get(symbol.name)?.size ?? 0,
      };

      if (symbol.change === "removed") apiRemoved.push(entry);
      else if (symbol.change === "added") apiAdded.push(entry);
      else apiChanged.push(entry);
    }

    /* ---- Undeclared packages in new imports ---- */

    if (isJs && newModule && category !== "generated") {
      const declared = declaredFor(change.path);
      const oldSpecs = new Set((oldModule?.imports ?? []).map((imp) => imp.spec));
      const missing = new Set<string>();

      for (const imp of newModule.imports) {
        if (oldSpecs.has(imp.spec) || imp.typeOnly) continue;

        const target = resolveSpecifier(change.path, imp.spec, allPaths, resolveConfig);
        if (target !== "external") continue;

        const name = splitSpecifier(imp.spec);
        if (!name || NODE_BUILTINS.has(name) || NODE_BUILTINS.has(imp.spec) || name.startsWith("@types/")) continue;
        if (declared.has(name) || declared.has(`@types/${name}`)) continue;
        if (/^(virtual|astro|bun|deno):/.test(imp.spec)) continue;

        missing.add(name);
      }

      if (missing.size > 0) {
        risks.push(
          makeRisk(
            `undeclared:${change.path}`,
            "medium",
            "Imports a package that is not in package.json",
            `${change.path} now imports ${joinNames([...missing])}, which no package.json above it lists. If it is not a path alias, installs from a clean checkout will fail.`,
            change.path,
            [...missing],
          ),
        );
      }
    }

    /* ---- History ---- */

    const entries = [...(historyByFile.get(change.path) ?? []), ...(change.oldPath ? historyByFile.get(change.oldPath) ?? [] : [])];
    const recent = entries.filter((entry) => entry.date >= windowStart);
    const fileHistory: FileHistory = {
      commits90d: recent.length,
      fixes90d: recent.filter((entry) => FIX_MESSAGE_PATTERN.test(entry.subject)).length,
      authors: new Set(entries.map((entry) => entry.email)).size,
      lastChanged: entries.length > 0 ? new Date(Math.max(...entries.map((entry) => entry.date))).toISOString() : undefined,
    };

    /* ---- Risks for this file ---- */

    const fileRisks: Risk[] = [];
    const isPublicApi = publicApi.has(change.path);
    const publicRemovals = symbolsAll.filter((item) => item.change === "removed" && item.exportNames.length > 0);
    const signatureChanges = symbolsAll.filter((item) => item.change === "signature" && item.exportNames.length > 0);
    const unexported = symbolsAll.filter((item) => item.change === "unexported");

    if (change.status === "deleted" && isJs && (graph.reverse.get(change.path)?.length ?? 0) > 0) {
      // Imports of this file are reported with the dangling imports below.
    }

    if (publicRemovals.length > 0) {
      const used = publicRemovals.filter((item) => (affectedBySymbol.get(item.name)?.size ?? 0) > 0);
      fileRisks.push(
        makeRisk(
          `removed-export:${change.path}`,
          change.status === "deleted" ? "medium" : used.length > 0 || isPublicApi ? "high" : "low",
          change.status === "deleted"
            ? "A file with public exports was deleted"
            : `${plural(publicRemovals.length, "public export")} removed`,
          `${joinNames(publicRemovals.map((item) => item.name))} ${publicRemovals.length === 1 ? "is" : "are"} no longer exported from ${change.path}. ${
            isPublicApi ? "This file is re-exported from the package entry point, so it is part of the public API. " : ""
          }Anything outside this repository that imports ${publicRemovals.length === 1 ? "it" : "them"} will break.`,
          change.path,
          publicRemovals.map((item) => item.name),
        ),
      );
    }

    for (const symbol of signatureChanges) {
      const count = affectedBySymbol.get(symbol.name)?.size ?? 0;
      fileRisks.push(
        makeRisk(
          `signature:${change.path}:${symbol.name}`,
          count >= 5 || isPublicApi ? "high" : count >= 1 ? "medium" : "low",
          `The shape of ${symbol.name} changed`,
          `${symbol.before ?? ""} → ${symbol.after ?? ""}. ${
            count > 0 ? `${plural(count, "file")} import${count === 1 ? "s" : ""} it, so check every caller.` : "No file in this repository imports it, but outside callers may."
          }${isPublicApi ? " It is part of this package's public API." : ""}`,
          change.path,
          [...(affectedBySymbol.get(symbol.name) ?? [])],
        ),
      );
    }

    if (unexported.length > 0) {
      fileRisks.push(
        makeRisk(
          `unexported:${change.path}`,
          "medium",
          `${plural(unexported.length, "symbol")} no longer public`,
          `${joinNames(unexported.map((item) => item.name))} ${unexported.length === 1 ? "was" : "were"} exported and ${unexported.length === 1 ? "is" : "are"} now private.`,
          change.path,
        ),
      );
    }

    if (
      (directCount >= 10 || transitiveCount >= 50) &&
      symbolsAll.some((item) => (item.change === "modified" || item.change === "signature") && item.exportNames.length > 0)
    ) {
      fileRisks.push(
        makeRisk(
          `wide:${change.path}`,
          "medium",
          "Behavior changed in a widely used file",
          `${plural(directCount, "file")} import ${path.posix.basename(change.path)} directly and ${plural(transitiveCount, "file")} depend on it through ${maxDepth === 1 ? "1 level" : `up to ${maxDepth} levels`} of imports.`,
          change.path,
        ),
      );
    }

    if (formattingOnly) {
      fileRisks.push(
        makeRisk(
          `formatting:${change.path}`,
          "info",
          "Only formatting or comments changed",
          "The code is identical once whitespace and comments are ignored.",
          change.path,
        ),
      );
    }

    if (fileHistory.fixes90d >= 3) {
      fileRisks.push(
        makeRisk(
          `bug-prone:${change.path}`,
          "medium",
          "This file keeps needing fixes",
          `${plural(fileHistory.fixes90d, "commit")} that look like bug fixes touched it in the last ${CHURN_WINDOW_DAYS} days.`,
          change.path,
        ),
      );
    } else if (fileHistory.commits90d >= 10) {
      fileRisks.push(
        makeRisk(
          `churn:${change.path}`,
          "low",
          "This file changes very often",
          `${plural(fileHistory.commits90d, "commit")} touched it in the last ${CHURN_WINDOW_DAYS} days, so conflicts and regressions are more likely.`,
          change.path,
        ),
      );
    }

    if (category === "source" && SENSITIVE_PATH_PATTERN.test(change.path) && !formattingOnly) {
      fileRisks.push(
        makeRisk(
          `sensitive:${change.path}`,
          "medium",
          "Touches a security-sensitive area",
          "The path suggests authentication, payments, permissions, or cryptography. Ask someone who knows this code to review it.",
          change.path,
        ),
      );
    }

    if (category === "migration") {
      fileRisks.push(
        makeRisk(
          `migration:${change.path}`,
          "high",
          "Database migration",
          "Check that it can run on production-sized data without long locks, and that there is a way back.",
          change.path,
        ),
      );
    }

    if (category === "ci" || (category === "config" && change.status !== "added")) {
      fileRisks.push(
        makeRisk(
          `config:${change.path}`,
          category === "ci" ? "medium" : "low",
          category === "ci" ? "Build or deploy pipeline changed" : "Configuration changed",
          category === "ci"
            ? "Pipeline changes affect every later build and deploy. Confirm a run succeeds."
            : "Configuration changes can behave differently across environments.",
          change.path,
        ),
      );
    }

    if (category === "generated" && change.status !== "deleted") {
      fileRisks.push(
        makeRisk(
          `generated:${change.path}`,
          "info",
          "Generated file in the change",
          "Generated files are usually rebuilt, so review the source that produces it instead.",
          change.path,
        ),
      );
    }

    if (change.additions >= 500 && change.status === "added" && category === "source") {
      fileRisks.push(
        makeRisk(
          `large-file:${change.path}`,
          "low",
          "Large new file",
          `${change.additions} lines in a single new file are hard to review in one pass.`,
          change.path,
        ),
      );
    }

    if (
      category === "source" &&
      change.status !== "deleted" &&
      !formattingOnly &&
      testsHere.size === 0 &&
      change.additions + change.deletions > 0
    ) {
      untestedSources.push(change.path);
    }

    const fileScore = Math.min(100, scoreRisks(fileRisks));
    risks.push(...fileRisks);

    files.push({
      filePath: change.path,
      oldPath: change.oldPath,
      status: change.status,
      category,
      language,
      additions: change.additions,
      deletions: change.deletions,
      binary: change.binary,
      symbols,
      hiddenSymbols: Math.max(0, symbolsAll.length - symbols.length),
      formattingOnly,
      directDependents: directCount,
      transitiveDependents: transitiveCount,
      dependents: dependents.slice(0, MAX_DEPENDENTS_SHOWN),
      hiddenDependents: Math.max(0, dependents.length - MAX_DEPENDENTS_SHOWN),
      affectedTests: [...testsHere].sort().slice(0, 12),
      history: fileHistory,
      isEntryPoint: isPublicApi,
      risks: fileRisks.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)),
      riskScore: fileScore,
      severity: worstSeverity(fileRisks.map((risk) => risk.severity)),
    });
  }

  /* ---- Imports the change leaves broken ---- */

  const removedModules = new Map<string, ModuleInfo>();
  for (const change of changes) {
    if (change.status === "deleted" || change.status === "renamed") {
      const text = oldTexts.get(change.oldPath ?? change.path);
      if (text !== undefined && JS_EXTENSIONS.has(path.posix.extname(change.oldPath ?? change.path))) {
        removedModules.set(change.oldPath ?? change.path, analyzeModule(change.oldPath ?? change.path, text));
      }
    }
  }

  for (const [target, edges] of graph.reverse) {
    if (!changedPaths.has(target)) continue;

    const targetModule = graph.modules.get(target);
    const change = changes.find((item) => item.path === target);
    const previous = oldTexts.get(change?.oldPath ?? target);
    if (!targetModule || previous === undefined) continue;

    const oldExports = analyzeModule(change?.oldPath ?? target, previous).exportNames;
    if (targetModule.exportStars.length > 0) continue;

    for (const edge of edges) {
      for (const name of edge.imp.names) {
        if (name === "*" || targetModule.exportNames.has(name) || !oldExports.has(name)) continue;

        const list = brokenByTarget.get(target) ?? [];
        list.push({ from: edge.from, line: edge.imp.line, name });
        brokenByTarget.set(target, list);
      }
    }
  }

  if (removedPaths.size > 0) {
    for (const item of graph.unresolved) {
      const hit = resolveSpecifier(item.from, item.spec, removedPaths, resolveConfig);
      if (hit && hit !== "external") {
        const list = brokenByTarget.get(hit) ?? [];
        list.push({ from: item.from, line: item.line });
        brokenByTarget.set(hit, list);
      }
    }
  }

  for (const [target, list] of brokenByTarget) {
    const names = [...new Set(list.map((item) => item.name).filter((name): name is string => !!name))];
    const importers = [...new Set(list.map((item) => item.from))];
    const first = list[0];

    risks.push(
      makeRisk(
        `broken:${target}`,
        "critical",
        names.length > 0 ? `Imports of ${joinNames(names)} will fail` : "Imports of a deleted or moved file will fail",
        `${plural(importers.length, "file")} still import${importers.length === 1 ? "s" : ""} ${
          names.length > 0 ? `${joinNames(names)} from` : ""
        } ${target}, which ${names.length > 0 ? "no longer exports it" : "no longer exists at that path"} (first: ${first.from}:${first.line}). The project will not build until they are updated.`,
        target,
        importers,
      ),
    );
  }

  /* ---- Dependencies ---- */

  const usedPackages = new Map<string, string[]>();
  for (const [file, info] of modules) {
    for (const imp of info.imports) {
      const name = splitSpecifier(imp.spec);
      if (!name) continue;
      const list = usedPackages.get(name) ?? [];
      if (list.length < 5 && !list.includes(file)) list.push(file);
      usedPackages.set(name, list);
    }
  }

  const addedManifests = new Set(
    changes.filter((change) => change.status === "added" && /(^|\/)package\.json$/.test(change.path)).map((change) => change.path),
  );

  for (const dependency of dependencyChanges) {
    if (addedManifests.has(dependency.manifest)) continue;

    if (dependency.change === "removed") {
      const users = usedPackages.get(dependency.name);
      if (users && users.length > 0) {
        dependency.stillUsedBy = users;
        risks.push(
          makeRisk(
            `dep-removed-in-use:${dependency.name}`,
            "critical",
            `${dependency.name} was removed but is still imported`,
            `${joinNames(users)} still import ${dependency.name}. A clean install will fail.`,
            dependency.manifest,
            users,
          ),
        );
      }
    } else if (dependency.change === "changed" && dependency.bump === "major") {
      risks.push(
        makeRisk(
          `dep-major:${dependency.name}`,
          "high",
          `${dependency.name} jumps a major version`,
          `${dependency.from} → ${dependency.to} in ${dependency.manifest}. Major versions can remove APIs. Read the changelog.`,
          dependency.manifest,
        ),
      );
    } else if (dependency.change === "changed" && dependency.bump === "downgrade") {
      risks.push(
        makeRisk(
          `dep-downgrade:${dependency.name}`,
          "medium",
          `${dependency.name} was downgraded`,
          `${dependency.from} → ${dependency.to} in ${dependency.manifest}.`,
          dependency.manifest,
        ),
      );
    }
  }

  const addedProd = dependencyChanges.filter(
    (item) => item.change === "added" && item.section === "dependencies" && !addedManifests.has(item.manifest),
  );
  if (addedProd.length > 0) {
    risks.push(
      makeRisk(
        "dep-added",
        addedProd.length >= 5 ? "medium" : "low",
        `${plural(addedProd.length, "new runtime dependency", "new runtime dependencies")}`,
        `${joinNames(addedProd.map((item) => item.name), 5)}. Each one adds code you ship and have to keep updated.`,
        addedProd[0].manifest,
      ),
    );
  }

  const manifestChanged = changes.some((change) => /(^|\/)package\.json$/.test(change.path));
  const lockChanged = changes.some((change) => categoryOf(change.path) === "lockfile");
  const hasLock = [...allPaths].some((file) => LOCK_FILES.has(path.posix.basename(file)));

  if (dependencyChanges.length > 0 && !lockChanged && hasLock) {
    risks.push(
      makeRisk(
        "lock-out-of-sync",
        "medium",
        "package.json changed but the lockfile did not",
        "Installs from the lockfile will not match package.json. Run your package manager's install and commit the lockfile.",
      ),
    );
  } else if (lockChanged && !manifestChanged) {
    risks.push(
      makeRisk(
        "lock-only",
        "low",
        "The lockfile changed without package.json",
        "Dependency versions moved without a declared reason. Check what was updated.",
      ),
    );
  }

  for (const field of manifestChanges) {
    if (addedManifests.has(field.manifest)) continue;

    if (field.field === "type") {
      risks.push(
        makeRisk(
          `manifest-type:${field.manifest}`,
          "critical",
          'The module "type" in package.json changed',
          `${field.before ?? "(unset)"} → ${field.after ?? "(unset)"}. Switching between CommonJS and ES modules changes how every file in the package loads.`,
          field.manifest,
        ),
      );
    } else if (["main", "module", "exports", "bin"].includes(field.field)) {
      risks.push(
        makeRisk(
          `manifest-entry:${field.manifest}:${field.field}`,
          "high",
          `Package entry point "${field.field}" changed`,
          `This changes what other projects get when they import this package.`,
          field.manifest,
        ),
      );
    } else if (field.field === "engines") {
      risks.push(
        makeRisk(
          `manifest-engines:${field.manifest}`,
          "medium",
          "Supported Node versions changed",
          `${field.before ?? "(unset)"} → ${field.after ?? "(unset)"}.`,
          field.manifest,
        ),
      );
    }
  }

  /* ---- Routes and environment ---- */

  const removedRoutes = routeChanges.filter((item) => item.change === "removed" && !routeChanges.some((other) => other.change === "added" && other.route === item.route));
  if (removedRoutes.length > 0) {
    risks.push(
      makeRisk(
        "routes-removed",
        "high",
        `${plural(removedRoutes.length, "HTTP route")} removed`,
        `${joinNames(removedRoutes.map((item) => item.route))}. Clients that still call ${removedRoutes.length === 1 ? "it" : "them"} will get errors.`,
        removedRoutes[0].filePath,
      ),
    );
  }

  if (newEnvVars.size > 0) {
    risks.push(
      makeRisk(
        "env-added",
        "medium",
        `${plural(newEnvVars.size, "new environment variable")} required`,
        `${joinNames([...newEnvVars], 6)}. Every environment that runs this code needs ${newEnvVars.size === 1 ? "it" : "them"}.`,
      ),
    );
  }

  /* ---- The commit as a whole ---- */

  const stats = {
    files: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
  const changedLines = stats.additions + stats.deletions;

  if (stats.files >= 120 || changedLines >= 3000) {
    risks.push(makeRisk("large", "high", "Very large change", `${plural(stats.files, "file")} and ${changedLines} changed lines. Large changes hide bugs. Consider splitting by concern.`));
  } else if (stats.files >= 40 || changedLines >= 1000) {
    risks.push(makeRisk("large", "medium", "Large change", `${plural(stats.files, "file")} and ${changedLines} changed lines are hard to review thoroughly.`));
  }

  const concerns = new Set(files.map((file) => file.category).filter((category) => ["source", "dependency", "config", "migration", "ci"].includes(category)));
  const directories = new Set(files.map((file) => file.filePath.split("/")[0]));
  if (concerns.size >= 3 && directories.size >= 4 && stats.files > 8) {
    risks.push(makeRisk("mixed", "low", "Mixes unrelated kinds of change", "Source, configuration, and dependency changes in one commit are harder to review and to revert separately."));
  }

  const codeChanged = files.filter((file) => file.category === "source" && !file.formattingOnly && file.status !== "deleted");
  const testChanged = files.filter((file) => file.category === "test");
  if (codeChanged.length > 0 && testChanged.length === 0 && affectedTestSet.size === 0 && changedLines >= 20) {
    risks.push(
      makeRisk(
        "no-tests",
        codeChanged.length >= 3 ? "medium" : "low",
        "No tests cover this change",
        `No test file changed, and none of the ${plural(codeChanged.length, "changed source file")} is imported by a test or has a test with a matching name.`,
        undefined,
        codeChanged.map((file) => file.filePath),
      ),
    );
  }

  if (commit.isMerge) {
    risks.push(makeRisk("merge", "info", "Merge commit", "The changes shown are what the merge brought in compared with its first parent."));
  }

  if (mode === "commit" || mode === "range") {
    const subject = commit.subject.trim();
    if (subject.length < 10 || /^(wip|fix|update|updates|changes?|stuff|misc|tmp|test|\.+)$/i.test(subject)) {
      risks.push(makeRisk("message", "low", "The commit message says little", `"${subject}" does not tell a reviewer what changed or why.`));
    } else if (stats.files > 20 && !commit.body) {
      risks.push(makeRisk("message", "info", "A large change has no description", "A body explaining why helps reviewers and the next person who reads the history."));
    }
    if (/^(fixup|squash)!/.test(subject)) {
      risks.push(makeRisk("fixup", "info", "Fixup commit", "This commit is meant to be squashed into an earlier one before merging."));
    }
  }

  risks.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      a.title.localeCompare(b.title),
  );

  const seen = new Set<string>();
  const uniqueRisks = risks.filter((risk) => (seen.has(risk.id) ? false : (seen.add(risk.id), true)));

  for (const file of files) {
    const own = uniqueRisks.filter(
      (risk) => risk.filePath === file.filePath || (file.oldPath !== undefined && risk.filePath === file.oldPath),
    );
    file.risks = own;
    file.riskScore = Math.min(100, scoreRisks(own.filter((risk) => risk.severity !== "info")));
    file.severity = worstSeverity(own.map((risk) => risk.severity));
  }

  const sizeFactor = Math.min(10, Math.floor(Math.log2(1 + changedLines / 50) * 2));
  const riskScore = Math.min(100, scoreRisks(uniqueRisks.filter((risk) => risk.severity !== "info")) + sizeFactor);

  /* ---- Reviewers ---- */

  const commitAuthor = commit.author.trim().toLowerCase();
  const reviewerMap = new Map<string, { name: string; score: number; commits: number; files: Set<string>; last: number }>();
  const reviewFiles = new Set(files.filter((file) => !["generated", "lockfile", "docs"].includes(file.category)).flatMap((file) => [file.filePath, file.oldPath ?? ""]));

  for (const entry of history) {
    if (entry.author.trim().toLowerCase() === commitAuthor) continue;
    const touched = entry.files.filter((file) => reviewFiles.has(file));
    if (touched.length === 0) continue;

    const age = Math.max(0, referenceDate - entry.date) / (365 * 86_400_000);
    const record = reviewerMap.get(entry.email) ?? { name: entry.author, score: 0, commits: 0, files: new Set<string>(), last: 0 };
    record.score += Math.min(touched.length, 5) * (1 - age * 0.5);
    record.commits += 1;
    for (const file of touched) record.files.add(file);
    record.last = Math.max(record.last, entry.date);
    reviewerMap.set(entry.email, record);
  }

  const reviewers: Reviewer[] = [...reviewerMap.values()]
    .sort((a, b) => b.score - a.score || b.commits - a.commits)
    .slice(0, MAX_REVIEWERS)
    .map((record) => ({
      name: record.name,
      commits: record.commits,
      files: record.files.size,
      lastActive: new Date(record.last).toISOString(),
    }));

  /* ---- Checklist ---- */

  const checklist: ChecklistItem[] = [];

  for (const risk of uniqueRisks) {
    if (risk.severity === "critical") {
      checklist.push({
        severity: "critical",
        text: `Fix before merging: ${risk.title}${risk.filePath ? ` (${risk.filePath})` : ""}.`,
      });
    }
  }

  const brokenCallers = uniqueRisks.filter((risk) => risk.id.startsWith("signature:") && (risk.related?.length ?? 0) > 0);
  for (const risk of brokenCallers.slice(0, 3)) {
    checklist.push({
      severity: risk.severity,
      text: `${risk.title}. Check the callers: ${joinNames(risk.related ?? [], 3)}.`,
    });
  }

  for (const risk of uniqueRisks) {
    if (risk.id.startsWith("removed-export:") && risk.severity !== "low") {
      checklist.push({ severity: risk.severity, text: `Confirm nothing outside this repository uses the removed exports from ${risk.filePath}.` });
    }
    if (risk.id.startsWith("migration:")) {
      checklist.push({ severity: "high", text: `Review the migration ${risk.filePath}: locks, data volume, and a rollback.` });
    }
  }

  if (removedRoutes.length > 0) {
    checklist.push({ severity: "high", text: `Confirm no client calls the removed routes: ${joinNames(removedRoutes.map((item) => item.route))}.` });
  }

  if (newEnvVars.size > 0) {
    checklist.push({ severity: "medium", text: `Add ${joinNames([...newEnvVars], 5)} to every environment, including CI and deployment config.` });
  }

  const majors = dependencyChanges.filter((item) => item.bump === "major");
  if (majors.length > 0) {
    checklist.push({ severity: "high", text: `Read the changelogs for: ${joinNames(majors.map((item) => `${item.name} ${item.from} → ${item.to}`))}.` });
  }

  if (affectedTestSet.size > 0) {
    checklist.push({ severity: "medium", text: `Run the ${plural(affectedTestSet.size, "affected test file")}: ${joinNames([...affectedTestSet].sort())}.` });
  }

  if (untestedSources.length > 0) {
    checklist.push({ severity: "medium", text: `Add or update tests for ${joinNames(untestedSources)}.` });
  }

  if (uniqueRisks.some((risk) => risk.id.startsWith("sensitive:"))) {
    checklist.push({ severity: "medium", text: "Have someone who knows the authentication, payment, or security code review those files." });
  }

  if (uniqueRisks.some((risk) => risk.id === "large")) {
    checklist.push({ severity: "low", text: "Consider splitting this into smaller changes, one concern at a time." });
  }

  if (uniqueRisks.some((risk) => risk.id.startsWith("config:") && risk.severity === "medium")) {
    checklist.push({ severity: "medium", text: "Confirm the build and deploy pipeline still runs after the CI changes." });
  }

  const checklistSeen = new Set<string>();
  const dedupedChecklist = checklist
    .filter((item) => (checklistSeen.has(item.text) ? false : (checklistSeen.add(item.text), true)))
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));

  /* ---- Totals ---- */

  const byDepth: number[] = [];
  for (const depth of allDependents.values()) byDepth[depth - 1] = (byDepth[depth - 1] ?? 0) + 1;
  for (let index = 0; index < byDepth.length; index++) byDepth[index] = byDepth[index] ?? 0;

  const categoryCounts: Record<FileCategory, number> = {
    source: 0, test: 0, config: 0, docs: 0, style: 0, asset: 0, migration: 0,
    dependency: 0, lockfile: 0, ci: 0, generated: 0, other: 0,
  };
  for (const file of files) categoryCounts[file.category]++;

  files.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      b.transitiveDependents - a.transitiveDependents ||
      b.additions + b.deletions - (a.additions + a.deletions) ||
      a.filePath.localeCompare(b.filePath),
  );

  const languages = new Map<string, number>();
  for (const file of files) if (file.language) languages.set(file.language, (languages.get(file.language) ?? 0) + 1);

  const apiSort = (a: ApiChange, b: ApiChange) => b.dependentFiles - a.dependentFiles || a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name);

  return {
    success: true,
    tool: "analyze_commit_impact",
    projectPath: projectRoot,
    repoRoot,
    mode,
    commit,
    baseLabel: spec.baseLabel,
    headLabel: spec.headLabel,
    rangeCommitCount,
    stats,
    files,
    blastRadius: {
      directFiles: byDepth[0] ?? 0,
      transitiveFiles: allDependents.size,
      byDepth,
      testFiles: allTestDependents.size,
    },
    tests: {
      affected: [...affectedTestSet].sort().slice(0, 40),
      changed: testChanged.map((file) => file.filePath),
      untestedSources: untestedSources.slice(0, 40),
    },
    api: {
      removed: apiRemoved.sort(apiSort).slice(0, 60),
      changed: apiChanged.sort(apiSort).slice(0, 60),
      added: apiAdded.sort(apiSort).slice(0, 60),
      routes: routeChanges.slice(0, 60),
    },
    dependencyChanges: dependencyChanges.slice(0, 100),
    manifestChanges: manifestChanges.slice(0, 60),
    newEnvVars: [...newEnvVars].sort(),
    risks: uniqueRisks,
    riskScore,
    riskLevel: levelFor(riskScore),
    reviewers,
    checklist: dedupedChecklist,
    recentCommits: await readRecentCommits(repoRoot),
    categoryCounts,
    graph: {
      filesInGraph: modules.size,
      unresolvedImports: graph.unresolved.length,
      languages: [...languages.keys()],
    },
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/*  MCP registration                                                          */
/* -------------------------------------------------------------------------- */

export function registerAnalyzeCommitImpactTool(server: McpServer) {
  server.registerTool(
    "analyze_commit_impact",
    {
      description:
        "Analyze what a git change actually affects. Works on one commit, a branch or range compared with its merge base, staged changes, or all uncommitted changes. Reports every changed file with its added, removed, and modified symbols (JavaScript and TypeScript), the files that import the changed code directly and indirectly, the tests that exercise it, public API and HTTP route changes, dependency and package.json changes, new environment variables, imports the change leaves broken, risks ranked by severity with a risk score, the people who changed the same files before, and a review checklist. It reads the repository with read-only git commands and never modifies it.",
      inputSchema: z.object({
        projectPath: z
          .string()
          .describe("Absolute path to the project directory (inside a git repository)"),
        mode: z
          .enum(["commit", "range", "staged", "working"])
          .optional()
          .describe(
            "commit (default): one commit against its first parent. range: head against the merge base with base. staged: changes in the index. working: all uncommitted changes.",
          ),
        commit: z
          .string()
          .optional()
          .describe("Commit hash, branch, or tag for commit mode. Default HEAD."),
        base: z
          .string()
          .optional()
          .describe("Base branch, tag, or commit for range mode. Default: origin's default branch, main, or master."),
        head: z
          .string()
          .optional()
          .describe("Head branch, tag, or commit for range mode. Default HEAD."),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(8)
          .optional()
          .describe("How many levels of importing files to follow. Default 5."),
      }),
    },
    async ({ projectPath, mode, commit, base, head, maxDepth }) => {
      try {
        const report = await analyzeCommitImpact(projectPath, { mode, commit, base, head, maxDepth });

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
                  tool: "analyze_commit_impact",
                  error:
                    error instanceof Error
                      ? error.message
                      : "Failed to analyze commit impact.",
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
