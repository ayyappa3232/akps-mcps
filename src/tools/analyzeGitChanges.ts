import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveProjectPath } from "../utils/projectResolver.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

type AnalysisMode = "recent" | "range" | "working";
type Risk = "critical" | "high" | "medium" | "low";

type ChangeCategory =
  | "feature"
  | "fix"
  | "refactor"
  | "docs"
  | "test"
  | "style"
  | "perf"
  | "build"
  | "ci"
  | "chore"
  | "revert"
  | "merge"
  | "other";

type FileKind =
  | "source"
  | "test"
  | "docs"
  | "config"
  | "lockfile"
  | "ci"
  | "generated"
  | "asset"
  | "other";

type CommitFlag =
  | "large-commit"
  | "many-files"
  | "no-tests"
  | "dependency-change"
  | "sensitive-file"
  | "mixed-concerns"
  | "revert"
  | "vague-message"
  | "wip"
  | "breaking-change"
  | "mass-delete"
  | "binary-files"
  | "merge";

type FindingRule =
  | "conflict-marker"
  | "secret"
  | "sensitive-file"
  | "focused-test"
  | "debugger"
  | "console-log"
  | "todo"
  | "suppression"
  | "skipped-test"
  | "large-addition";

interface CommitFile {
  path: string;
  additions: number;
  deletions: number;
  kind: FileKind;
  binary: boolean;
}

interface CommitFlagInfo {
  flag: CommitFlag;
  message: string;
}

interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  bodyPreview: string;
  isMerge: boolean;
  category: ChangeCategory;
  additions: number;
  deletions: number;
  fileCount: number;
  files: CommitFile[];
  areas: string[];
  score: number;
  risk: Risk;
  flags: CommitFlagInfo[];
}

interface FileHotspot {
  filePath: string;
  kind: FileKind;
  commits: number;
  additions: number;
  deletions: number;
  authors: number;
  fixCommits: number;
  lastChanged: string;
  score: number;
  risk: Risk;
  reasons: string[];
  changedNow: boolean;
  partners: Array<{ filePath: string; count: number; confidence: number }>;
}

interface CoupledPair {
  a: string;
  b: string;
  count: number;
  confidence: number;
  crossArea: boolean;
}

interface Companion {
  changedFile: string;
  partner: string;
  count: number;
  confidence: number;
}

interface AuthorStat {
  name: string;
  email: string;
  commits: number;
  additions: number;
  deletions: number;
  files: number;
  firstDate: string;
  lastDate: string;
  topCategory: ChangeCategory;
}

interface AreaStat {
  area: string;
  commits: number;
  files: number;
  additions: number;
  deletions: number;
  authors: number;
}

interface Finding {
  id: string;
  rule: FindingRule;
  severity: Risk;
  filePath: string;
  line?: number;
  message: string;
  /** The offending line with any secret value removed. */
  snippet?: string;
  suggestion: string;
}

interface ChangedFileInfo {
  path: string;
  status: "added" | "modified" | "deleted";
  kind: FileKind;
  additions: number;
  deletions: number;
  binary: boolean;
}

interface WorkingFile {
  path: string;
  status: string;
  staged: boolean;
}

interface WorkingStatus {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  files: WorkingFile[];
}

interface SplitSuggestion {
  id: string;
  label: string;
  files: string[];
  commitMessage: string;
  command: string;
  confidence: "high" | "medium" | "low";
}

interface GitChangeReport {
  success: boolean;
  tool: "analyze_git_changes";
  projectPath: string;
  mode: AnalysisMode;
  branch?: string;
  pathFilter?: string;
  range: {
    label: string;
    from?: string;
    to?: string;
    oldest?: string;
    newest?: string;
  };
  totals: {
    commits: number;
    authors: number;
    filesChanged: number;
    additions: number;
    deletions: number;
    mergeCommits: number;
    days: number;
  };
  categories: Array<{ category: ChangeCategory; commits: number; lines: number }>;
  commits: CommitInfo[];
  changedFiles: ChangedFileInfo[];
  hotspots: FileHotspot[];
  coupling: CoupledPair[];
  companions: Companion[];
  authors: AuthorStat[];
  areas: AreaStat[];
  findings: Finding[];
  commitRisk: Record<Risk, number>;
  findingSummary: Record<Risk, number>;
  working?: WorkingStatus;
  splits: SplitSuggestion[];
  pullRequest: { title: string; markdown: string };
  commitMessage?: { subject: string; body: string };
  warnings: string[];
}

interface RawCommit {
  hash: string;
  author: string;
  email: string;
  date: string;
  parents: number;
  subject: string;
  body: string;
  files: Array<{ path: string; additions: number; deletions: number; binary: boolean }>;
}

interface NumstatEntry {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const LOG_FORMAT = "%x1e%H%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%s%x1f%b%x1d";

const GIT_TIMEOUT_MS = 90_000;
const GIT_MAX_BUFFER = 512 * 1024 * 1024;
const REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.\-/@^~{}:]*$/;

const DEFAULT_MAX_COMMITS = 100;
const MAX_COMMITS_LIMIT = 500;
const MAX_LISTED_COMMITS = 200;
const MAX_COMMIT_FILES = 40;
const MAX_HOTSPOTS = 25;
const MAX_COUPLING = 15;
const MAX_COMPANIONS = 10;
const MAX_AUTHORS = 15;
const MAX_AREAS = 12;
const MAX_FINDINGS = 200;
const MAX_FINDINGS_PER_RULE_FILE = 8;
const MAX_WORKING_FILES = 100;
const MAX_CHANGED_FILES = 200;
const MAX_DIFF_CHARS = 8_000_000;
const MAX_UNTRACKED_BYTES = 400_000;
const MAX_WARNINGS = 25;
const COUPLING_MAX_FILES_PER_COMMIT = 25;
const COUPLING_MIN_COUNT = 3;

const RISK_ORDER: Risk[] = ["critical", "high", "medium", "low"];

const AREA_PREFIXES = new Set([
  "src",
  "app",
  "apps",
  "packages",
  "lib",
  "libs",
  "viewer",
  "server",
  "client",
  "services",
  "modules",
]);

const CATEGORY_LABEL: Record<ChangeCategory, string> = {
  feature: "Features",
  fix: "Fixes",
  refactor: "Refactoring",
  docs: "Documentation",
  test: "Tests",
  style: "Style",
  perf: "Performance",
  build: "Build and dependencies",
  ci: "CI",
  chore: "Chores",
  revert: "Reverts",
  merge: "Merges",
  other: "Other changes",
};

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".vue", ".svelte", ".py", ".rb", ".go", ".rs", ".java", ".kt",
  ".swift", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".php",
  ".css", ".scss", ".sass", ".less", ".html", ".sh", ".sql",
]);

const ASSET_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".woff",
  ".woff2", ".ttf", ".eot", ".mp4", ".mp3", ".pdf", ".zip",
]);

const LOCKFILE_PATTERN =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/;

const SENSITIVE_FILE_PATTERN =
  /(^|\/)(\.env(\.(?!example|sample|template)[^/]*)?|id_rsa|id_dsa|id_ed25519|[^/]*\.(pem|p12|pfx|key|keystore|jks)|[^/]*service[-_]?account[^/]*\.json|credentials(\.json)?|\.npmrc|\.netrc)$/i;

const TEST_FILE_PATTERN =
  /(\.(test|spec|cy|e2e)\.[cm]?[jt]sx?$)|(^|\/)(__tests__|e2e|cypress|playwright)\//;

const VAGUE_SUBJECT_PATTERN =
  /^(wip|fix|fixes|fixed|update|updates|updated|change|changes|test|tests|temp|tmp|stuff|asdf|misc|minor|commit|save|more|again|\.+)$/i;

const WIP_PATTERN = /\b(wip|work in progress)\b|^(fixup|squash)!/i;

const CONVENTIONAL_PATTERN =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]*\))?(!)?:\s*/i;

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function riskRank(risk: Risk): number {
  return RISK_ORDER.indexOf(risk);
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

function validateRef(value: string, label: string): string {
  const trimmed = value.trim();

  if (!trimmed || trimmed.length > 200 || !REF_PATTERN.test(trimmed)) {
    throw new Error(
      `${label} must be a git branch, tag or commit (letters, digits and . _ - / @ ^ ~ only).`,
    );
  }

  return trimmed;
}

function validateRelative(value: string, label: string): string {
  const cleaned = normalizePath(value.trim());

  if (!cleaned || path.isAbsolute(cleaned) || cleaned.split("/").includes("..")) {
    throw new Error(`${label} must be a relative path inside the project.`);
  }

  return cleaned;
}

function areaOf(file: string): string {
  const segments = file.split("/");
  if (segments.length === 1) return "(root)";
  if (AREA_PREFIXES.has(segments[0]) && segments.length > 2) {
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0];
}

function fileKindOf(file: string): FileKind {
  if (LOCKFILE_PATTERN.test(file)) return "lockfile";

  if (
    /(^|\/)(dist|build|coverage|out|\.next)\//.test(file) ||
    /\.(min\.[cm]?js|map)$/.test(file) ||
    /(^|\/)[^/]*\.generated\./.test(file)
  ) {
    return "generated";
  }

  if (
    /^\.github\//.test(file) ||
    /^\.circleci\//.test(file) ||
    /(^|\/)(\.gitlab-ci\.yml|Jenkinsfile|azure-pipelines\.ya?ml|bitbucket-pipelines\.yml)$/.test(file)
  ) {
    return "ci";
  }

  if (TEST_FILE_PATTERN.test(file)) return "test";

  const extension = path.posix.extname(file).toLowerCase();

  if ([".md", ".mdx", ".rst", ".txt", ".adoc"].includes(extension) || /(^|\/)docs?\//.test(file)) {
    return "docs";
  }

  if (ASSET_EXTENSIONS.has(extension)) return "asset";

  if (
    /(^|\/)(package\.json|tsconfig[^/]*\.json|jsconfig\.json|Dockerfile|docker-compose[^/]*\.ya?ml|\.eslintrc[^/]*|\.prettierrc[^/]*|\.editorconfig|\.gitignore|\.env\.(example|sample|template))$/.test(file) ||
    /\.config\.[cm]?[jt]s$/.test(file) ||
    [".json", ".yml", ".yaml", ".toml", ".ini"].includes(extension)
  ) {
    return "config";
  }

  if (CODE_EXTENSIONS.has(extension)) return "source";
  return "other";
}

/* -------------------------------------------------------------------------- */
/*  Git access                                                                */
/* -------------------------------------------------------------------------- */

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
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

async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return (await runGit(cwd, args)).trim();
  } catch {
    return undefined;
  }
}

async function ensureGitRepository(root: string): Promise<void> {
  try {
    await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";

    if (/ENOENT/.test(message)) {
      throw new Error("Git is not installed or is not on the PATH.");
    }

    throw new Error("The project is not inside a git repository.");
  }
}

async function resolveCommit(root: string, ref: string, label: string): Promise<string> {
  const commit = await tryGit(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);

  if (!commit) {
    throw new Error(
      `Git could not find "${ref}" for ${label}. Use a branch, tag or commit that exists.`,
    );
  }

  return commit;
}

async function defaultBaseRef(root: string): Promise<string | undefined> {
  const remoteHead = await tryGit(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead) return remoteHead;

  for (const candidate of ["main", "master", "develop", "origin/main", "origin/master"]) {
    if (await tryGit(root, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`])) {
      return candidate;
    }
  }

  return undefined;
}

/* -------------------------------------------------------------------------- */
/*  Parsing git output                                                        */
/* -------------------------------------------------------------------------- */

function parseNumstatLine(line: string): NumstatEntry | undefined {
  const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
  if (!match) return undefined;

  const binary = match[1] === "-";

  return {
    path: normalizePath(match[3]),
    additions: binary ? 0 : Number(match[1]),
    deletions: binary ? 0 : Number(match[2]),
    binary,
  };
}

function parseLog(output: string): RawCommit[] {
  const commits: RawCommit[] = [];

  for (const chunk of output.split("\x1e")) {
    if (!chunk.trim()) continue;

    const end = chunk.indexOf("\x1d");
    if (end === -1) continue;

    const [hash, author, email, date, parents, subject, body] = chunk
      .slice(0, end)
      .split("\x1f");

    if (!hash) continue;

    const files = chunk
      .slice(end + 1)
      .split("\n")
      .map(parseNumstatLine)
      .filter((entry): entry is NumstatEntry => entry !== undefined);

    commits.push({
      hash,
      author: author ?? "",
      email: (email ?? "").toLowerCase(),
      date: date ?? "",
      parents: parents ? parents.split(" ").filter(Boolean).length : 0,
      subject: (subject ?? "").trim(),
      body: (body ?? "").trim().slice(0, 600),
      files,
    });
  }

  return commits;
}

function parseNumstat(output: string): NumstatEntry[] {
  return output
    .split("\n")
    .map(parseNumstatLine)
    .filter((entry): entry is NumstatEntry => entry !== undefined);
}

function parsePorcelain(output: string): WorkingFile[] {
  const tokens = output.split("\0");
  const files: WorkingFile[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.length < 4) continue;

    const x = token[0];
    const y = token[1];
    const file = normalizePath(token.slice(3));

    // A rename or copy is followed by its original path.
    if (x === "R" || x === "C") index++;

    if (x === "?" && y === "?") {
      files.push({ path: file, status: "untracked", staged: false });
      continue;
    }

    const conflict =
      x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");

    const label = (code: string) =>
      code === "M" ? "modified" : code === "A" ? "added" : code === "D" ? "deleted" : code === "R" ? "renamed" : code === "C" ? "copied" : "modified";

    if (conflict) {
      files.push({ path: file, status: "conflicted", staged: false });
      continue;
    }

    if (x !== " ") files.push({ path: file, status: label(x), staged: true });
    if (y !== " ") files.push({ path: file, status: label(y), staged: false });
  }

  return files;
}

/* -------------------------------------------------------------------------- */
/*  Commits                                                                   */
/* -------------------------------------------------------------------------- */

function categorizeCommit(raw: RawCommit, kinds: FileKind[]): ChangeCategory {
  // A keyword in the message is only trusted when the files agree with it.
  const total = raw.files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
  const share = (...wanted: FileKind[]) => {
    if (total === 0) return 1;
    const lines = raw.files
      .filter((file) => wanted.includes(fileKindOf(file.path)))
      .reduce((sum, file) => sum + file.additions + file.deletions, 0);
    return lines / total;
  };

  if (raw.parents > 1 || /^Merge\b/i.test(raw.subject)) return "merge";
  if (/^Revert\b/i.test(raw.subject)) return "revert";

  const conventional = CONVENTIONAL_PATTERN.exec(raw.subject);
  if (conventional) {
    const type = conventional[1].toLowerCase();
    return type === "feat" ? "feature" : (type as ChangeCategory);
  }

  const subject = raw.subject.toLowerCase();

  if (/\b(fix(es|ed)?|bug|hotfix|resolve[sd]?|patch(es|ed)?|crash|issue)\b/.test(subject)) return "fix";
  if (/\b(refactor\w*|clean ?up|rename[sd]?|restructur\w*|simplif\w*|reorganiz\w*|moved?)\b/.test(subject)) return "refactor";
  if (/\b(docs?|readme|documentation|changelog)\b/.test(subject) && share("docs") >= 0.5) return "docs";
  if (/\b(tests?|specs?|coverage)\b/.test(subject) && share("test") >= 0.5) return "test";
  if (/\b(bump|upgrade[sd]?|dependenc\w*|deps)\b/.test(subject) && share("lockfile", "config") >= 0.5) return "build";
  if (/\b(perf|performance|optimi[sz]\w*)\b/.test(subject)) return "perf";
  if (/\b(style|format\w*|lint\w*|prettier)\b/.test(subject) && share("source") >= 0.5) return "style";
  if (/\b(add(s|ed)?|implement\w*|create[sd]?|introduce[sd]?|new|support\w*|feature)\b/.test(subject)) return "feature";

  if (kinds.length > 0) {
    if (kinds.every((kind) => kind === "test")) return "test";
    if (kinds.every((kind) => kind === "docs")) return "docs";
    if (kinds.every((kind) => kind === "ci")) return "ci";
    if (kinds.every((kind) => kind === "lockfile" || kind === "config")) return "build";
  }

  return "other";
}

function riskFromScore(score: number): Risk {
  if (score >= 6) return "critical";
  if (score >= 4) return "high";
  if (score >= 2) return "medium";
  return "low";
}

function analyzeCommit(raw: RawCommit): CommitInfo {
  const files: CommitFile[] = raw.files.map((file) => ({
    path: file.path,
    additions: file.additions,
    deletions: file.deletions,
    binary: file.binary,
    kind: fileKindOf(file.path),
  }));

  const kinds = files.map((file) => file.kind);
  const category = categorizeCommit(raw, kinds);
  const isMerge = category === "merge";

  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const lines = additions + deletions;
  const areas = [...new Set(files.map((file) => areaOf(file.path)))];

  const flags: CommitFlagInfo[] = [];
  let score = 0;

  const flag = (name: CommitFlag, points: number, message: string) => {
    flags.push({ flag: name, message });
    score += points;
  };

  if (isMerge) {
    flags.push({ flag: "merge", message: "Merge commit." });
  }

  if (lines > 1000) flag("large-commit", 3, `${lines} lines changed in one commit.`);
  else if (lines > 400) flag("large-commit", 2, `${lines} lines changed in one commit.`);

  if (files.length > 30) flag("many-files", 2, `${files.length} files touched.`);
  else if (files.length > 15) flag("many-files", 1, `${files.length} files touched.`);

  const sourceLines = files
    .filter((file) => file.kind === "source")
    .reduce((sum, file) => sum + file.additions + file.deletions, 0);

  if (
    !isMerge &&
    sourceLines > 30 &&
    !kinds.includes("test") &&
    ["feature", "fix", "refactor", "perf", "other"].includes(category)
  ) {
    flag("no-tests", 2, `${sourceLines} lines of source changed with no test changes.`);
  }

  if (
    files.some(
      (file) => file.kind === "lockfile" || /(^|\/)package\.json$/.test(file.path),
    )
  ) {
    flag("dependency-change", 1, "Dependencies or the lockfile changed.");
  }

  const sensitive = files.filter(
    (file) => SENSITIVE_FILE_PATTERN.test(file.path) && file.additions > 0,
  );
  if (sensitive.length > 0) {
    flag(
      "sensitive-file",
      4,
      `Adds a file that may hold secrets: ${sensitive[0].path}.`,
    );
  }

  const concerns = new Set(
    kinds.filter((kind) => ["source", "docs", "config", "ci"].includes(kind)),
  );
  if (areas.length >= 3 && concerns.size >= 3) {
    flag("mixed-concerns", 1, "Mixes source, docs and configuration across several areas.");
  }

  if (category === "revert") flag("revert", 1, "Reverts an earlier change.");

  const subject = raw.subject.trim();
  if (WIP_PATTERN.test(subject)) {
    flag("wip", 1, "Message marks this as work in progress.");
  } else if (!isMerge && (subject.length < 8 || VAGUE_SUBJECT_PATTERN.test(subject))) {
    flag("vague-message", 1, "The message does not say what changed.");
  }

  const conventional = CONVENTIONAL_PATTERN.exec(subject);
  if ((conventional && conventional[3] === "!") || /BREAKING[ -]CHANGE/.test(raw.body)) {
    flag("breaking-change", 1, "Declares a breaking change.");
  }

  const deletedFiles = files.filter((file) => file.additions === 0 && file.deletions > 0);
  if (deletedFiles.length > 10) {
    flag("mass-delete", 1, `${deletedFiles.length} files were deleted or emptied.`);
  }

  if (files.some((file) => file.binary && file.kind !== "asset")) {
    flag("binary-files", 1, "Adds binary files that are not images or fonts.");
  }

  return {
    hash: raw.hash,
    shortHash: raw.hash.slice(0, 8),
    author: raw.author,
    email: raw.email,
    date: raw.date,
    subject,
    bodyPreview: raw.body.replace(/\s+/g, " ").slice(0, 200),
    isMerge,
    category,
    additions,
    deletions,
    fileCount: files.length,
    files: files.slice(0, MAX_COMMIT_FILES),
    areas,
    score,
    risk: riskFromScore(score),
    flags,
  };
}

/* -------------------------------------------------------------------------- */
/*  Hotspots, coupling, contributors, areas                                   */
/* -------------------------------------------------------------------------- */

function riskFromReasons(count: number): Risk {
  if (count >= 4) return "critical";
  if (count === 3) return "high";
  if (count === 2) return "medium";
  return "low";
}

function buildHotspots(
  raws: RawCommit[],
  infos: CommitInfo[],
  changedNow: Set<string>,
): FileHotspot[] {
  interface Acc {
    commits: number;
    additions: number;
    deletions: number;
    authors: Set<string>;
    fixes: number;
    last: string;
  }

  const byFile = new Map<string, Acc>();

  raws.forEach((raw, index) => {
    const category = infos[index].category;

    for (const file of raw.files) {
      const kind = fileKindOf(file.path);
      if (kind === "lockfile" || kind === "generated" || kind === "asset") continue;

      const acc = byFile.get(file.path) ?? {
        commits: 0,
        additions: 0,
        deletions: 0,
        authors: new Set<string>(),
        fixes: 0,
        last: "",
      };

      acc.commits++;
      acc.additions += file.additions;
      acc.deletions += file.deletions;
      acc.authors.add(raw.email || raw.author);
      if (category === "fix") acc.fixes++;
      if (raw.date > acc.last) acc.last = raw.date;
      byFile.set(file.path, acc);
    }
  });

  const hotspots: FileHotspot[] = [];

  for (const [filePath, acc] of byFile) {
    if (acc.commits < 2 && !changedNow.has(filePath)) continue;
    if (acc.commits < 2) continue;

    const lines = acc.additions + acc.deletions;
    const reasons: string[] = [];

    if (acc.commits >= 5) reasons.push(`Changed in ${acc.commits} commits`);
    if (acc.fixes >= 3 || (acc.commits >= 4 && acc.fixes / acc.commits >= 0.4)) {
      reasons.push(`${plural(acc.fixes, "bug-fix commit")} touched it`);
    }
    if (acc.authors.size >= 4) reasons.push(`${acc.authors.size} different authors`);
    if (lines >= 1000) reasons.push(`${lines} lines of churn`);

    const score =
      acc.commits * 2 +
      acc.fixes * 3 +
      Math.min(acc.authors.size, 6) * 2 +
      Math.min(Math.floor(lines / 200), 10) +
      (changedNow.has(filePath) ? 20 : 0);

    hotspots.push({
      filePath,
      kind: fileKindOf(filePath),
      commits: acc.commits,
      additions: acc.additions,
      deletions: acc.deletions,
      authors: acc.authors.size,
      fixCommits: acc.fixes,
      lastChanged: acc.last,
      score,
      risk: riskFromReasons(reasons.length),
      reasons:
        reasons.length > 0
          ? reasons
          : [`Changed in ${acc.commits} commits`],
      changedNow: changedNow.has(filePath),
      partners: [],
    });
  }

  return hotspots
    .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
    .slice(0, MAX_HOTSPOTS);
}

function testSourceBase(file: string): string {
  return path.posix
    .basename(file)
    .replace(/\.(test|spec|cy|e2e)(?=\.[^.]+$)/, "")
    .replace(/\.[^.]+$/, "");
}

interface CouplingResult {
  pairs: CoupledPair[];
  lookup: Map<string, Array<{ filePath: string; count: number; confidence: number }>>;
}

function buildCoupling(raws: RawCommit[]): CouplingResult {
  const fileCommits = new Map<string, number>();
  const pairCounts = new Map<string, number>();

  for (const raw of raws) {
    const files = [
      ...new Set(
        raw.files
          .map((file) => file.path)
          .filter((file) => ["source", "test", "config"].includes(fileKindOf(file))),
      ),
    ].sort();

    if (files.length < 2 || files.length > COUPLING_MAX_FILES_PER_COMMIT) continue;

    for (const file of files) fileCommits.set(file, (fileCommits.get(file) ?? 0) + 1);

    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = `${files[i]}\0${files[j]}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const pairs: CoupledPair[] = [];
  const lookup = new Map<
    string,
    Array<{ filePath: string; count: number; confidence: number }>
  >();

  for (const [key, count] of pairCounts) {
    if (count < COUPLING_MIN_COUNT) continue;

    const [a, b] = key.split("\0");

    // A test that changes with its own source file is expected, not hidden.
    if (testSourceBase(a) === testSourceBase(b)) continue;

    const confidence = count / Math.min(fileCommits.get(a) ?? count, fileCommits.get(b) ?? count);
    if (confidence < 0.5) continue;

    const rounded = Math.round(confidence * 100) / 100;
    pairs.push({ a, b, count, confidence: rounded, crossArea: areaOf(a) !== areaOf(b) });

    for (const [from, to] of [[a, b], [b, a]]) {
      const list = lookup.get(from) ?? [];
      list.push({ filePath: to, count, confidence: rounded });
      lookup.set(from, list);
    }
  }

  pairs.sort(
    (x, y) =>
      Number(y.crossArea) - Number(x.crossArea) ||
      y.count - x.count ||
      y.confidence - x.confidence ||
      x.a.localeCompare(y.a),
  );

  for (const list of lookup.values()) {
    list.sort((x, y) => y.count - x.count || y.confidence - x.confidence);
  }

  return { pairs, lookup };
}

function buildAuthors(raws: RawCommit[], infos: CommitInfo[]): AuthorStat[] {
  interface Acc {
    name: string;
    commits: number;
    additions: number;
    deletions: number;
    files: Set<string>;
    first: string;
    last: string;
    categories: Map<ChangeCategory, number>;
  }

  const byAuthor = new Map<string, Acc>();

  raws.forEach((raw, index) => {
    const info = infos[index];
    const key = raw.email || raw.author;

    const acc = byAuthor.get(key) ?? {
      name: raw.author,
      commits: 0,
      additions: 0,
      deletions: 0,
      files: new Set<string>(),
      first: raw.date,
      last: raw.date,
      categories: new Map<ChangeCategory, number>(),
    };

    acc.commits++;
    acc.additions += info.additions;
    acc.deletions += info.deletions;
    for (const file of raw.files) acc.files.add(file.path);
    if (raw.date < acc.first) acc.first = raw.date;
    if (raw.date > acc.last) acc.last = raw.date;
    acc.categories.set(info.category, (acc.categories.get(info.category) ?? 0) + 1);
    byAuthor.set(key, acc);
  });

  return [...byAuthor.entries()]
    .map(([email, acc]) => ({
      name: acc.name,
      email,
      commits: acc.commits,
      additions: acc.additions,
      deletions: acc.deletions,
      files: acc.files.size,
      firstDate: acc.first,
      lastDate: acc.last,
      topCategory:
        [...acc.categories.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "other",
    }))
    .sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name))
    .slice(0, MAX_AUTHORS);
}

function buildAreas(raws: RawCommit[]): AreaStat[] {
  interface Acc {
    commits: Set<string>;
    files: Set<string>;
    additions: number;
    deletions: number;
    authors: Set<string>;
  }

  const byArea = new Map<string, Acc>();

  for (const raw of raws) {
    for (const file of raw.files) {
      const area = areaOf(file.path);
      const acc = byArea.get(area) ?? {
        commits: new Set<string>(),
        files: new Set<string>(),
        additions: 0,
        deletions: 0,
        authors: new Set<string>(),
      };

      acc.commits.add(raw.hash);
      acc.files.add(file.path);
      acc.additions += file.additions;
      acc.deletions += file.deletions;
      acc.authors.add(raw.email || raw.author);
      byArea.set(area, acc);
    }
  }

  return [...byArea.entries()]
    .map(([area, acc]) => ({
      area,
      commits: acc.commits.size,
      files: acc.files.size,
      additions: acc.additions,
      deletions: acc.deletions,
      authors: acc.authors.size,
    }))
    .sort(
      (a, b) =>
        b.additions + b.deletions - (a.additions + a.deletions) ||
        a.area.localeCompare(b.area),
    )
    .slice(0, MAX_AREAS);
}

/* -------------------------------------------------------------------------- */
/*  Reviewing the added lines                                                 */
/* -------------------------------------------------------------------------- */

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp; group?: number }> = [
  { name: "an AWS access key id", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    name: "a private key",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
  },
  { name: "a GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: "a Slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "a Google API key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    name: "a payment or AI provider key",
    regex: /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}\b|\bsk-[A-Za-z0-9]{20,}\b/g,
  },
  {
    name: "a hard-coded credential",
    regex:
      /\b(?:api[_-]?key|secret|token|passwd|password|private[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*["']([^"'\s]{12,})["']/gi,
    group: 1,
  },
];

const PLACEHOLDER_PATTERN =
  /^(process\.|import\.meta|<|your|example|changeme|xxx|\*{3,}|placeholder|dummy|sample|fake)|\$\{/i;

interface LineHit {
  rule: FindingRule;
  severity: Risk;
  message: string;
  suggestion: string;
  snippet: string;
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
}

function scanLine(file: string, kind: FileKind, text: string): LineHit[] {
  if (kind === "lockfile" || kind === "generated" || kind === "asset") return [];

  const hits: LineHit[] = [];
  const isCode = kind === "source" || kind === "test";

  if (/^(<<<<<<< |>>>>>>> )/.test(text)) {
    hits.push({
      rule: "conflict-marker",
      severity: "critical",
      message: "A merge conflict marker was left in the file.",
      suggestion: "Resolve the conflict and remove the marker lines before committing.",
      snippet: clip(text),
    });
  }

  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    const match = pattern.regex.exec(text);
    if (!match) continue;

    const secret = pattern.group ? match[pattern.group] : match[0];
    if (pattern.group && PLACEHOLDER_PATTERN.test(secret)) continue;

    hits.push({
      rule: "secret",
      severity: kind === "test" ? "high" : "critical",
      message: `This line looks like ${pattern.name}.`,
      suggestion:
        "Move it to an environment variable or a secret manager, and rotate it if it was ever pushed.",
      snippet: clip(text.replace(secret, "[REDACTED]")),
    });
    break;
  }

  if (kind === "source" || kind === "test") {
    if (/\b(?:describe|it|test|context)\.only\s*\(|\b(?:fdescribe|fit)\s*\(/.test(text)) {
      hits.push({
        rule: "focused-test",
        severity: "high",
        message: "A focused test (.only) makes the runner skip every other test.",
        suggestion: "Remove .only so the whole suite runs.",
        snippet: clip(text),
      });
    }

    if (/\b(?:describe|it|test)\.skip\s*\(|\b(?:xdescribe|xit)\s*\(/.test(text)) {
      hits.push({
        rule: "skipped-test",
        severity: "medium",
        message: "A test was disabled with .skip.",
        suggestion: "Fix and re-enable it, or delete it if it is obsolete.",
        snippet: clip(text),
      });
    }
  }

  if (isCode && /(^|[\s;{])debugger\s*;?\s*($|\/\/)/.test(text)) {
    hits.push({
      rule: "debugger",
      severity: "medium",
      message: "A debugger statement pauses execution in the browser.",
      suggestion: "Remove the debugger statement.",
      snippet: clip(text),
    });
  }

  if (kind === "source" && /\bconsole\.(?:log|debug|trace)\s*\(/.test(text)) {
    hits.push({
      rule: "console-log",
      severity: "low",
      message: "A console.log call was added.",
      suggestion: "Remove it, or replace it with your logger if it should stay.",
      snippet: clip(text),
    });
  }

  if (isCode && /(\/\/|\/\*|#|<!--).*\b(?:TODO|FIXME|HACK|XXX)\b/.test(text)) {
    hits.push({
      rule: "todo",
      severity: "low",
      message: "A TODO or FIXME comment was added.",
      suggestion: "Finish it now, or track it in an issue so it is not forgotten.",
      snippet: clip(text),
    });
  }

  if (isCode && /@ts-(?:ignore|nocheck|expect-error)|eslint-disable|# type: ignore|# noqa/.test(text)) {
    hits.push({
      rule: "suppression",
      severity: "low",
      message: "A type or lint check was switched off here.",
      suggestion: "Fix the underlying problem if you can, and explain why if you cannot.",
      snippet: clip(text),
    });
  }

  void file;
  return hits;
}

class FindingCollector {
  readonly findings: Finding[] = [];
  private readonly perRuleFile = new Map<string, number>();
  truncated = false;

  add(
    rule: FindingRule,
    severity: Risk,
    filePath: string,
    line: number | undefined,
    message: string,
    suggestion: string,
    snippet?: string,
  ) {
    const key = `${rule}|${filePath}`;
    const used = this.perRuleFile.get(key) ?? 0;

    if (used >= MAX_FINDINGS_PER_RULE_FILE) return;

    if (this.findings.length >= MAX_FINDINGS) {
      this.truncated = true;
      return;
    }

    this.perRuleFile.set(key, used + 1);
    this.findings.push({
      id: createHash("sha1")
        .update(`${rule}|${filePath}|${line ?? 0}|${message}`)
        .digest("hex")
        .slice(0, 10),
      rule,
      severity,
      filePath,
      line,
      message,
      snippet,
      suggestion,
    });
  }

  scanAdded(file: string, line: number, text: string) {
    for (const hit of scanLine(file, fileKindOf(file), text)) {
      this.add(hit.rule, hit.severity, file, line, hit.message, hit.suggestion, hit.snippet);
    }
  }

  sorted(): Finding[] {
    return [...this.findings].sort(
      (a, b) =>
        riskRank(a.severity) - riskRank(b.severity) ||
        a.filePath.localeCompare(b.filePath) ||
        (a.line ?? 0) - (b.line ?? 0),
    );
  }
}

function scanDiff(diff: string, collector: FindingCollector) {
  let file = "";
  let line = 0;

  for (const text of diff.split("\n")) {
    if (text.startsWith("+++ ")) {
      const target = text.slice(4).split("\t")[0];
      file = target === "/dev/null" ? "" : normalizePath(target.replace(/^b\//, ""));
      continue;
    }

    if (text.startsWith("--- ") || text.startsWith("diff ") || text.startsWith("index ")) {
      continue;
    }

    if (text.startsWith("@@")) {
      const match = /\+(\d+)/.exec(text);
      line = match ? Number(match[1]) : 0;
      continue;
    }

    if (text.startsWith("+") && file) {
      collector.scanAdded(file, line, text.slice(1));
      line++;
    }
  }
}

function scanFileFindings(
  changed: Array<{ path: string; additions: number; deleted: boolean }>,
  collector: FindingCollector,
) {
  for (const file of changed) {
    if (file.deleted) continue;

    if (SENSITIVE_FILE_PATTERN.test(file.path)) {
      collector.add(
        "sensitive-file",
        "critical",
        file.path,
        undefined,
        "This looks like a credentials or key file.",
        "Keep it out of git: add it to .gitignore, and rotate anything it contains if it was ever pushed.",
      );
    }

    const kind = fileKindOf(file.path);
    if (file.additions >= 1500 && !["lockfile", "generated", "asset", "docs"].includes(kind)) {
      collector.add(
        "large-addition",
        "medium",
        file.path,
        undefined,
        `${file.additions} lines were added to this file.`,
        "Consider splitting it, or check that it is not generated or pasted data.",
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Generated text: commit message, PR summary, commit split                  */
/* -------------------------------------------------------------------------- */

interface DiffEntry {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  binary: boolean;
}

function scopeOf(files: string[]): string {
  const counts = new Map<string, number>();

  for (const file of files) {
    const area = areaOf(file);
    if (area === "(root)") continue;
    counts.set(area, (counts.get(area) ?? 0) + 1);
  }

  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return top ? top.split("/").pop()! : "";
}

function suggestType(entries: DiffEntry[]): ChangeCategory {
  const kinds = entries.map((entry) => fileKindOf(entry.path));

  if (kinds.length === 0) return "chore";
  if (kinds.every((kind) => kind === "test")) return "test";
  if (kinds.every((kind) => kind === "docs")) return "docs";
  if (kinds.every((kind) => kind === "ci")) return "ci";
  if (
    kinds.every((kind) => kind === "lockfile" || kind === "config") &&
    entries.some((entry) => /(^|\/)package\.json$/.test(entry.path) || fileKindOf(entry.path) === "lockfile")
  ) {
    return "build";
  }
  if (kinds.every((kind) => kind === "config" || kind === "lockfile")) return "chore";

  const source = entries.filter((entry) => fileKindOf(entry.path) === "source");
  if (source.some((entry) => entry.status === "added")) return "feature";
  if (source.length > 0 && source.every((entry) => entry.status === "deleted")) return "refactor";
  return "fix";
}

function typeWord(category: ChangeCategory): string {
  return category === "feature" ? "feat" : category;
}

function listFiles(label: string, files: string[]): string[] {
  if (files.length === 0) return [];
  const shown = files.slice(0, 6).map((file) => `- ${file}`);
  const extra = files.length - shown.length;
  return [`${label}:`, ...shown, ...(extra > 0 ? [`- ...and ${extra} more`] : [])];
}

function buildCommitMessage(
  entries: DiffEntry[],
  category?: ChangeCategory,
): { subject: string; body: string } {
  const type = category ?? suggestType(entries);
  const scope = scopeOf(entries.map((entry) => entry.path));

  return {
    subject: `${typeWord(type)}${scope ? `(${scope})` : ""}: <describe the change>`,
    body: [
      ...listFiles("Added", entries.filter((e) => e.status === "added").map((e) => e.path)),
      ...listFiles("Modified", entries.filter((e) => e.status === "modified").map((e) => e.path)),
      ...listFiles("Deleted", entries.filter((e) => e.status === "deleted").map((e) => e.path)),
    ].join("\n"),
  };
}

function buildSplits(entries: DiffEntry[]): SplitSuggestion[] {
  const groups = new Map<string, DiffEntry[]>();

  for (const entry of entries) {
    const kind = fileKindOf(entry.path);
    let key: string;

    if (kind === "lockfile" || /(^|\/)package\.json$/.test(entry.path)) key = "deps";
    else if (kind === "ci") key = "ci";
    else if (kind === "docs") key = "docs";
    else if (kind === "config" || kind === "generated") key = "config";
    else key = `area:${areaOf(entry.path)}`;

    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }

  if (groups.size < 2) return [];

  const areaGroups = [...groups.keys()].filter((key) => key.startsWith("area:")).length;
  const splits: SplitSuggestion[] = [];

  for (const [key, list] of groups) {
    const files = list.map((entry) => entry.path).sort();
    let label: string;
    let message: string;
    let confidence: SplitSuggestion["confidence"] = "high";

    if (key === "deps") {
      label = "Dependencies";
      message = "build(deps): update dependencies";
    } else if (key === "ci") {
      label = "CI pipeline";
      message = "ci: update the pipeline";
    } else if (key === "docs") {
      label = "Documentation";
      message = "docs: update documentation";
    } else if (key === "config") {
      label = "Configuration";
      message = "chore: update configuration";
    } else {
      const area = key.slice("area:".length);
      label = area === "(root)" ? "Project root" : area;
      message = `${buildCommitMessage(list).subject}`;
      confidence = areaGroups > 4 ? "low" : "medium";
    }

    splits.push({
      id: createHash("sha1").update(key).digest("hex").slice(0, 10),
      label,
      files,
      commitMessage: message,
      command: `git add -- ${files.map(shellQuote).join(" ")}\ngit commit -m ${shellQuote(message)}`,
      confidence,
    });
  }

  const order = (split: SplitSuggestion) =>
    split.confidence === "high" ? 1 : 0;

  return splits.sort(
    (a, b) => order(a) - order(b) || b.files.length - a.files.length || a.label.localeCompare(b.label),
  );
}

function cleanSubject(subject: string): string {
  return subject.replace(CONVENTIONAL_PATTERN, "").trim() || subject;
}

function buildPullRequest(input: {
  mode: AnalysisMode;
  commits: CommitInfo[];
  entries: DiffEntry[];
  areas: AreaStat[];
  findings: Finding[];
  companions: Companion[];
  commitRisk: Record<Risk, number>;
  suggestedSubject?: string;
}): { title: string; markdown: string } {
  const { mode, commits, entries, areas, findings, companions, commitRisk } = input;

  const byCategory = new Map<ChangeCategory, CommitInfo[]>();
  for (const commit of commits) {
    if (commit.category === "merge") continue;
    const list = byCategory.get(commit.category) ?? [];
    list.push(commit);
    byCategory.set(commit.category, list);
  }

  const dominant = [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length)[0]?.[0];
  const scope = scopeOf(entries.map((entry) => entry.path));

  let title: string;
  if (mode === "working") {
    title = input.suggestedSubject ?? "Update the project";
  } else if (commits.filter((c) => !c.isMerge).length === 1) {
    title = commits.find((c) => !c.isMerge)!.subject;
  } else {
    title = `${typeWord(dominant ?? "chore")}${scope ? `(${scope})` : ""}: <describe the change> (${plural(commits.length, "commit")})`;
  }

  const lines: string[] = ["## Summary", "", title, "", "## What changed", ""];

  if (mode === "working" || byCategory.size === 0) {
    const groups = new Map<string, DiffEntry[]>();
    for (const entry of entries) {
      const area = areaOf(entry.path);
      const list = groups.get(area) ?? [];
      list.push(entry);
      groups.set(area, list);
    }

    for (const [area, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
      const added = list.filter((e) => e.status === "added").length;
      const removed = list.filter((e) => e.status === "deleted").length;
      lines.push(
        `- \`${area}\`: ${plural(list.length, "file")}${added ? `, ${added} new` : ""}${removed ? `, ${removed} deleted` : ""}`,
      );
    }
  } else {
    for (const [category, list] of [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const subjects = list.slice(0, 4).map((commit) => cleanSubject(commit.subject));
      const extra = list.length - subjects.length;
      lines.push(
        `- **${CATEGORY_LABEL[category]}** (${list.length}): ${subjects.join("; ")}${extra > 0 ? `; and ${extra} more` : ""}`,
      );
    }
  }

  if (areas.length > 0) {
    lines.push("", "## Areas touched", "");
    for (const area of areas.slice(0, 6)) {
      lines.push(`- \`${area.area}\`: ${plural(area.files, "file")}, +${area.additions} / -${area.deletions}`);
    }
  }

  const risks: string[] = [];
  const untested = commits.filter((commit) => commit.flags.some((flag) => flag.flag === "no-tests")).length;
  if (untested > 0) risks.push(`${plural(untested, "commit")} changed source code without touching tests.`);
  if (commitRisk.critical + commitRisk.high > 0) {
    risks.push(`${plural(commitRisk.critical + commitRisk.high, "commit")} rated high or critical risk.`);
  }
  if (commits.some((commit) => commit.flags.some((flag) => flag.flag === "breaking-change"))) {
    risks.push("Includes a declared breaking change.");
  }
  if (commits.some((commit) => commit.flags.some((flag) => flag.flag === "dependency-change"))) {
    risks.push("Dependencies changed.");
  }
  const blocking = findings.filter((finding) => finding.severity === "critical" || finding.severity === "high");
  if (blocking.length > 0) {
    risks.push(`${plural(blocking.length, "finding")} to fix before merging (secrets, conflict markers or focused tests).`);
  }
  if (companions.length > 0) {
    risks.push(
      `Files that usually change with this work are untouched, for example ${companions[0].partner}.`,
    );
  }

  lines.push("", "## Risk notes", "");
  lines.push(...(risks.length > 0 ? risks.map((risk) => `- ${risk}`) : ["- No notable risks found."]));

  lines.push("", "## Testing", "", "- [ ] Run the tests for the changed files", "- [ ] Check the areas listed above manually");

  return { title, markdown: lines.join("\n") };
}

/* -------------------------------------------------------------------------- */
/*  Main analysis                                                             */
/* -------------------------------------------------------------------------- */

function emptyRisk(): Record<Risk, number> {
  return { critical: 0, high: 0, medium: 0, low: 0 };
}

async function readDiffEntries(
  root: string,
  range: string[],
  pathFilter: string | undefined,
): Promise<DiffEntry[]> {
  const suffix = pathFilter ? ["--", pathFilter] : [];

  const statusOutput = await runGit(root, [
    "diff",
    "--name-status",
    "--no-renames",
    "-z",
    ...range,
    ...suffix,
  ]);
  const numstat = parseNumstat(
    await runGit(root, ["diff", "--numstat", "--no-renames", ...range, ...suffix]),
  );
  const counts = new Map(numstat.map((entry) => [entry.path, entry]));

  const tokens = statusOutput.split("\0");
  const entries: DiffEntry[] = [];

  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const status = tokens[index];
    const file = normalizePath(tokens[index + 1]);
    if (!status || !file) continue;

    const count = counts.get(file);
    entries.push({
      path: file,
      status: status[0] === "A" ? "added" : status[0] === "D" ? "deleted" : "modified",
      additions: count?.additions ?? 0,
      deletions: count?.deletions ?? 0,
      binary: count?.binary ?? false,
    });
  }

  return entries;
}

async function readDiffText(
  root: string,
  range: string[],
  pathFilter: string | undefined,
  warn: (message: string) => void,
): Promise<string> {
  const output = await runGit(root, [
    "diff",
    "-U0",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    ...range,
    ...(pathFilter ? ["--", pathFilter] : []),
  ]);

  if (output.length > MAX_DIFF_CHARS) {
    warn("The diff is very large, so only the first part was scanned for problems.");
    return output.slice(0, MAX_DIFF_CHARS);
  }

  return output;
}

export async function analyzeGitChanges(
  projectPath: string,
  options: {
    mode?: AnalysisMode;
    baseRef?: string;
    headRef?: string;
    maxCommits?: number;
    pathFilter?: string;
    includeUntracked?: boolean;
  } = {},
): Promise<GitChangeReport> {
  const mode = options.mode ?? "recent";
  const maxCommits = options.maxCommits ?? DEFAULT_MAX_COMMITS;
  const includeUntracked = options.includeUntracked ?? true;

  if (!["recent", "range", "working"].includes(mode)) {
    throw new Error("mode must be one of recent, range, or working.");
  }

  if (!Number.isInteger(maxCommits) || maxCommits < 1 || maxCommits > MAX_COMMITS_LIMIT) {
    throw new Error(`maxCommits must be a whole number from 1 to ${MAX_COMMITS_LIMIT}.`);
  }

  const pathFilter = options.pathFilter?.trim()
    ? validateRelative(options.pathFilter, "pathFilter")
    : undefined;

  const resolved = await resolveProjectPath(projectPath);
  const root = fs.realpathSync(resolved.projectPath);
  const warnings: string[] = [];

  const warn = (message: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message);
    else if (warnings.length === MAX_WARNINGS) warnings.push("Further warnings were omitted.");
  };

  await ensureGitRepository(root);

  const headCommitFull = await tryGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!headCommitFull) {
    throw new Error("This repository has no commits yet. Make a first commit to analyze changes.");
  }

  if ((await tryGit(root, ["rev-parse", "--is-shallow-repository"])) === "true") {
    warn("This is a shallow clone, so older history is missing and counts may be incomplete.");
  }

  const branchName = await tryGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchName && branchName !== "HEAD" ? branchName : "(detached HEAD)";

  /* ---- Decide what to read ---- */

  let logRange: string | undefined;
  let diffRange: string[];
  let label: string;
  let from: string | undefined;
  let to: string | undefined;

  const headRef = options.headRef ? validateRef(options.headRef, "headRef") : "HEAD";

  if (mode === "working") {
    diffRange = ["HEAD"];
    label = "Uncommitted changes";
    from = headCommitFull.slice(0, 10);
    to = "working tree";
    logRange = "HEAD";
  } else if (mode === "range") {
    const baseRef = options.baseRef?.trim()
      ? validateRef(options.baseRef, "baseRef")
      : await defaultBaseRef(root);

    if (!baseRef) {
      throw new Error(
        "Could not find a base branch such as main or master. Enter one in the base ref field.",
      );
    }

    const baseCommit = await resolveCommit(root, baseRef, "baseRef");
    const headCommit = await resolveCommit(root, headRef, "headRef");
    const mergeBase = await tryGit(root, ["merge-base", baseCommit, headCommit]);

    if (!mergeBase) {
      throw new Error(`"${baseRef}" and "${headRef}" share no history, so there is nothing to compare.`);
    }

    logRange = `${baseCommit}..${headCommit}`;
    diffRange = [mergeBase, headCommit];
    label = `${baseRef}...${headRef}`;
    from = mergeBase.slice(0, 10);
    to = headCommit.slice(0, 10);
  } else {
    const headCommit = await resolveCommit(root, headRef, "headRef");
    logRange = headCommit;
    diffRange = [];
    label = `Last commits on ${headRef}`;
    to = headCommit.slice(0, 10);
  }

  /* ---- History ---- */

  const logOutput = await runGit(root, [
    "log",
    "--no-color",
    "--no-renames",
    "--numstat",
    `--format=${LOG_FORMAT}`,
    "-n",
    String(maxCommits),
    logRange,
    ...(pathFilter ? ["--", pathFilter] : []),
  ]);

  const raws = parseLog(logOutput);
  const infos = raws.map(analyzeCommit);

  if (mode !== "working" && raws.length === maxCommits) {
    warn(`Only the latest ${maxCommits} commits were analyzed. Raise the commit limit to see more.`);
  }

  if (mode === "recent" && raws.length > 0) {
    const oldest = raws[raws.length - 1].hash;
    const parent = await tryGit(root, ["rev-parse", "--verify", "--quiet", `${oldest}^`]);
    diffRange = [parent ?? EMPTY_TREE, logRange];
    from = (parent ?? "start of history").slice(0, 10);
  } else if (mode === "recent") {
    // No commits matched (for example, the path filter found nothing).
    diffRange = ["HEAD", "HEAD"];
  }

  /* ---- The combined change ---- */

  const entries = await readDiffEntries(root, diffRange, pathFilter);
  const collector = new FindingCollector();

  scanDiff(await readDiffText(root, diffRange, pathFilter, warn), collector);

  let working: WorkingStatus | undefined;

  if (mode === "working") {
    const porcelain = parsePorcelain(
      await runGit(root, ["status", "--porcelain=v1", "-z", ...(pathFilter ? ["--", pathFilter] : [])]),
    ).filter((file) => includeUntracked || file.status !== "untracked");

    working = {
      staged: porcelain.filter((file) => file.staged).length,
      unstaged: porcelain.filter((file) => !file.staged && file.status !== "untracked" && file.status !== "conflicted").length,
      untracked: porcelain.filter((file) => file.status === "untracked").length,
      conflicted: porcelain.filter((file) => file.status === "conflicted").length,
      files: porcelain.slice(0, MAX_WORKING_FILES),
    };

    if (includeUntracked) {
      const untracked = (
        await runGit(root, [
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
          ...(pathFilter ? ["--", pathFilter] : []),
        ])
      )
        .split("\0")
        .filter(Boolean)
        .map(normalizePath);

      for (const file of untracked.slice(0, 300)) {
        let content: string;
        try {
          const absolute = path.join(root, file);
          const stat = fs.statSync(absolute);
          if (!stat.isFile() || stat.size > MAX_UNTRACKED_BYTES) {
            entries.push({ path: file, status: "added", additions: 0, deletions: 0, binary: false });
            continue;
          }
          const buffer = fs.readFileSync(absolute);
          if (buffer.subarray(0, 8000).includes(0)) {
            entries.push({ path: file, status: "added", additions: 0, deletions: 0, binary: true });
            continue;
          }
          content = buffer.toString("utf8");
        } catch {
          continue;
        }

        const lines = content.split("\n");
        entries.push({ path: file, status: "added", additions: lines.length, deletions: 0, binary: false });
        lines.forEach((text, index) => collector.scanAdded(file, index + 1, text));
      }
    }
  }

  scanFileFindings(
    entries.map((entry) => ({
      path: entry.path,
      additions: entry.additions,
      deleted: entry.status === "deleted",
    })),
    collector,
  );

  if (collector.truncated) {
    warn(`Showing the first ${MAX_FINDINGS} findings.`);
  }

  const findings = collector.sorted();

  const changedFileList: ChangedFileInfo[] = [...entries]
    .sort(
      (a, b) =>
        b.additions + b.deletions - (a.additions + a.deletions) ||
        a.path.localeCompare(b.path),
    )
    .slice(0, MAX_CHANGED_FILES)
    .map((entry) => ({
      path: entry.path,
      status: entry.status,
      kind: fileKindOf(entry.path),
      additions: entry.additions,
      deletions: entry.deletions,
      binary: entry.binary,
    }));

  if (entries.length > MAX_CHANGED_FILES) {
    warn(`Listing the ${MAX_CHANGED_FILES} largest of ${entries.length} changed files.`);
  }

  /* ---- Hotspots, coupling, people ---- */

  const changedNow = new Set(
    mode === "recent" ? [] : entries.filter((entry) => entry.status !== "deleted").map((entry) => entry.path),
  );

  const hotspots = buildHotspots(raws, infos, changedNow);
  const coupling = buildCoupling(raws);

  for (const hotspot of hotspots) {
    hotspot.partners = (coupling.lookup.get(hotspot.filePath) ?? []).slice(0, 3);
  }

  const companions: Companion[] = [];

  if (mode !== "recent") {
    const seen = new Set<string>();

    for (const file of changedNow) {
      if (!["source", "config"].includes(fileKindOf(file))) continue;

      for (const partner of coupling.lookup.get(file) ?? []) {
        if (partner.count < COUPLING_MIN_COUNT || partner.confidence < 0.6) continue;
        if (changedNow.has(partner.filePath) || seen.has(partner.filePath)) continue;
        if (!fs.existsSync(path.join(root, partner.filePath))) continue;

        seen.add(partner.filePath);
        companions.push({
          changedFile: file,
          partner: partner.filePath,
          count: partner.count,
          confidence: partner.confidence,
        });
      }
    }

    companions.sort((a, b) => b.confidence - a.confidence || b.count - a.count);
    companions.length = Math.min(companions.length, MAX_COMPANIONS);
  }

  const authors = mode === "working" ? [] : buildAuthors(raws, infos);

  let areas: AreaStat[];
  if (mode === "working") {
    const byArea = new Map<string, AreaStat & { set: Set<string> }>();
    for (const entry of entries) {
      const area = areaOf(entry.path);
      const acc = byArea.get(area) ?? { area, commits: 0, files: 0, additions: 0, deletions: 0, authors: 0, set: new Set<string>() };
      acc.set.add(entry.path);
      acc.files = acc.set.size;
      acc.additions += entry.additions;
      acc.deletions += entry.deletions;
      byArea.set(area, acc);
    }
    areas = [...byArea.values()]
      .map(({ set, ...rest }) => { void set; return rest; })
      .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
      .slice(0, MAX_AREAS);
  } else {
    areas = buildAreas(raws);
  }

  /* ---- Totals ---- */

  const statRaws = mode === "working" ? [] : raws;
  const statInfos = mode === "working" ? [] : infos;

  const dates = statRaws.map((raw) => Date.parse(raw.date)).filter((value) => !Number.isNaN(value));
  const oldest = dates.length ? new Date(Math.min(...dates)).toISOString() : undefined;
  const newest = dates.length ? new Date(Math.max(...dates)).toISOString() : undefined;
  const days = dates.length
    ? Math.max(1, Math.ceil((Math.max(...dates) - Math.min(...dates)) / 86_400_000))
    : 0;

  const categoryMap = new Map<ChangeCategory, { commits: number; lines: number }>();
  for (const info of statInfos) {
    const entry = categoryMap.get(info.category) ?? { commits: 0, lines: 0 };
    entry.commits++;
    entry.lines += info.additions + info.deletions;
    categoryMap.set(info.category, entry);
  }

  const commitRisk = emptyRisk();
  const shownCommits = mode === "working" ? [] : infos;
  for (const info of shownCommits) commitRisk[info.risk]++;

  const findingSummary = emptyRisk();
  for (const finding of findings) findingSummary[finding.severity]++;

  const commitable = entries.filter((entry) => !SENSITIVE_FILE_PATTERN.test(entry.path));
  const heldBack = entries.length - commitable.length;
  if (mode === "working" && heldBack > 0) {
    warn(
      `${plural(heldBack, "file")} that look${heldBack === 1 ? "s" : ""} like credentials ${heldBack === 1 ? "was" : "were"} left out of the commit suggestions. Add ${heldBack === 1 ? "it" : "them"} to .gitignore.`,
    );
  }

  const splits = mode === "working" ? buildSplits(commitable) : [];
  const commitMessage =
    mode === "recent"
      ? undefined
      : buildCommitMessage(
          commitable,
          mode === "range"
            ? ([...categoryMap.entries()]
                .filter(([category]) => category !== "merge")
                .sort((a, b) => b[1].commits - a[1].commits)[0]?.[0] as ChangeCategory | undefined)
            : undefined,
        );

  const pullRequest = buildPullRequest({
    mode,
    commits: shownCommits,
    entries,
    areas,
    findings,
    companions,
    commitRisk,
    suggestedSubject: commitMessage?.subject,
  });

  return {
    success: true,
    tool: "analyze_git_changes",
    projectPath: root,
    mode,
    branch,
    pathFilter,
    range: { label, from, to, oldest, newest },
    totals: {
      commits: shownCommits.length,
      authors: new Set(statRaws.map((raw) => raw.email || raw.author)).size,
      filesChanged: entries.length,
      additions: entries.reduce((sum, entry) => sum + entry.additions, 0),
      deletions: entries.reduce((sum, entry) => sum + entry.deletions, 0),
      mergeCommits: statInfos.filter((info) => info.isMerge).length,
      days,
    },
    categories: [...categoryMap.entries()]
      .map(([category, value]) => ({ category, ...value }))
      .sort((a, b) => b.commits - a.commits),
    commits: shownCommits.slice(0, MAX_LISTED_COMMITS),
    changedFiles: changedFileList,
    hotspots,
    coupling: coupling.pairs.slice(0, MAX_COUPLING),
    companions,
    authors,
    areas,
    findings,
    commitRisk,
    findingSummary,
    working,
    splits,
    pullRequest,
    commitMessage,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/*  MCP registration                                                          */
/* -------------------------------------------------------------------------- */

export function registerAnalyzeGitChangesTool(server: McpServer) {
  server.registerTool(
    "analyze_git_changes",
    {
      description:
        "Analyze git changes in a project: the latest commits, a branch compared with its base, or uncommitted work. Reports commits with a category and risk flags (large, no tests, dependency or sensitive file changes, vague messages), churn hotspots, files that change together and usual partners missing from the current change, contributors, and problems in the added lines (secrets with values redacted, conflict markers, focused tests, debugger and console.log leftovers). Also returns a pull request summary, a suggested commit message and, for uncommitted work, a suggested split into separate commits.",
      inputSchema: z.object({
        projectPath: z.string().describe("Absolute path to the project directory"),
        mode: z
          .enum(["recent", "range", "working"])
          .optional()
          .describe(
            "recent = latest commits (default), range = a branch compared with a base, working = uncommitted changes.",
          ),
        baseRef: z
          .string()
          .optional()
          .describe("Base branch or ref for range mode. Default: the repository's main branch."),
        headRef: z
          .string()
          .optional()
          .describe("Branch or ref to analyze for recent and range modes. Default HEAD."),
        maxCommits: z
          .number()
          .int()
          .min(1)
          .max(MAX_COMMITS_LIMIT)
          .optional()
          .describe(`How many commits to read. Default ${DEFAULT_MAX_COMMITS}.`),
        pathFilter: z
          .string()
          .optional()
          .describe("Optional folder or file, relative to projectPath, to limit the analysis."),
        includeUntracked: z
          .boolean()
          .optional()
          .describe("Include new untracked files in working mode. Default true."),
      }),
    },
    async ({ projectPath, mode, baseRef, headRef, maxCommits, pathFilter, includeUntracked }) => {
      try {
        const report = await analyzeGitChanges(projectPath, {
          mode,
          baseRef,
          headRef,
          maxCommits,
          pathFilter,
          includeUntracked,
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
                  tool: "analyze_git_changes",
                  error:
                    error instanceof Error ? error.message : "Failed to analyze git changes.",
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
