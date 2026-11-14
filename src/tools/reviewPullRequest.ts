import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import ts from "typescript";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveProjectPath } from "../utils/projectResolver.js";
import { analyzeGitChanges } from "./analyzeGitChanges.js";
import { detectBreakingApiChanges } from "./detectBreakingApiChanges.js";
import { analyzeTestImpact } from "./analyzeTestImpact.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

type Severity = "blocker" | "major" | "minor" | "nit";
type Strictness = "relaxed" | "normal" | "strict";
type Decision = "approve" | "approve-with-comments" | "request-changes";
type CheckStatus = "pass" | "warn" | "fail" | "skipped";

type CommentCategory =
  | "bug"
  | "security"
  | "performance"
  | "maintainability"
  | "testing"
  | "api"
  | "dependencies"
  | "history"
  | "docs";

type CommentSource = "static" | "git" | "api" | "tests" | "dependencies" | "pr";

type SourceStatus = "ran" | "skipped" | "failed";

type SizeLabel = "XS" | "S" | "M" | "L" | "XL";

interface ReviewComment {
  id: string;
  severity: Severity;
  category: CommentCategory;
  source: CommentSource;
  rule: string;
  title: string;
  message: string;
  suggestion?: string;
  filePath?: string;
  line?: number;
  /** The offending line. Secret values are already redacted upstream. */
  snippet?: string;
}

interface ChecklistItem {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

interface ReviewerSuggestion {
  name: string;
  email: string;
  commits: number;
}

interface CodeOwnerGroup {
  owner: string;
  files: number;
  samples: string[];
}

interface ReviewedFile {
  path: string;
  status: "added" | "modified" | "deleted";
  kind: string;
  additions: number;
  deletions: number;
  comments: number;
}

interface ReviewedCommit {
  shortHash: string;
  subject: string;
  author: string;
  risk: string;
  flags: string[];
}

interface SourceRun {
  name: string;
  status: SourceStatus;
  detail: string;
}

interface PullRequestReview {
  success: boolean;
  tool: "review_pull_request";
  projectPath: string;
  strictness: Strictness;
  pr: {
    base: { ref: string; commit: string };
    head: { ref: string; commit: string };
    mergeBase: string;
    branch?: string;
    ahead: number;
    behind: number;
    mergeable: boolean | null;
    conflictFiles: string[];
    authors: string[];
    title: string;
    description: string;
    size: {
      label: SizeLabel;
      lines: number;
      files: number;
      additions: number;
      deletions: number;
    };
  };
  verdict: {
    decision: Decision;
    score: number;
    headline: string;
    reasons: string[];
  };
  counts: Record<Severity, number>;
  categoryCounts: Record<CommentCategory, number>;
  comments: ReviewComment[];
  checklist: ChecklistItem[];
  reviewers: { suggested: ReviewerSuggestion[]; codeOwners: CodeOwnerGroup[] };
  tests: {
    ran: boolean;
    impacted: number;
    total: number;
    gaps: number;
    commands: Array<{ label: string; command: string }>;
  };
  api: { ran: boolean; breaking: number; bump?: string };
  files: ReviewedFile[];
  commits: ReviewedCommit[];
  reviewMarkdown: string;
  sources: SourceRun[];
  warnings: string[];
}

interface DiffEntry {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  binary: boolean;
}

interface FileDiff {
  added: Array<{ line: number; text: string }>;
  ranges: Array<[number, number]>;
}

type GitReport = Awaited<ReturnType<typeof analyzeGitChanges>>;
type ApiReport = Awaited<ReturnType<typeof detectBreakingApiChanges>>;
type ImpactReport = Awaited<ReturnType<typeof analyzeTestImpact>>;

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const GIT_TIMEOUT_MS = 90_000;
const GIT_MAX_BUFFER = 512 * 1024 * 1024;
const REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.\-/@^~{}:]*$/;

const MAX_COMMENTS = 300;
const MAX_COMMENTS_PER_RULE_FILE = 5;
const MAX_REVIEWED_FILES = 150;
const MAX_SOURCE_BYTES = 500_000;
const MAX_DIFF_CHARS = 8_000_000;
const MAX_LISTED_FILES = 200;
const MAX_LISTED_COMMITS = 50;
const MAX_WARNINGS = 25;
const MAX_COMMITS_READ = 200;

const SEVERITY_ORDER: Severity[] = ["blocker", "major", "minor", "nit"];

const CATEGORY_LIST: CommentCategory[] = [
  "bug",
  "security",
  "performance",
  "maintainability",
  "testing",
  "api",
  "dependencies",
  "history",
  "docs",
];

const REVIEWABLE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

const LOCKFILE_PATTERN =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/;

const NOISE_PATTERN =
  /(^|\/)(dist|build|coverage|out|\.next)\//;

const DEPRECATED_PACKAGES: Record<string, string> = {
  request: "request is deprecated; use fetch, undici or axios",
  "request-promise": "request-promise is deprecated; use fetch or axios",
  moment: "moment is in maintenance mode; consider date-fns, dayjs or Temporal",
  "node-uuid": "node-uuid is deprecated; use uuid or crypto.randomUUID()",
  "left-pad": "left-pad is unnecessary; use String.prototype.padStart",
  "babel-eslint": "babel-eslint is deprecated; use @babel/eslint-parser",
  tslint: "tslint is deprecated; use ESLint with typescript-eslint",
  "node-sass": "node-sass is deprecated; use sass",
};

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity);
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

function isNoise(file: string): boolean {
  return LOCKFILE_PATTERN.test(file) || NOISE_PATTERN.test(file) || /\.(min\.[cm]?js|map)$/.test(file);
}

function sizeLabel(lines: number): SizeLabel {
  if (lines <= 10) return "XS";
  if (lines <= 100) return "S";
  if (lines <= 300) return "M";
  if (lines <= 800) return "L";
  return "XL";
}

function fileKind(file: string): string {
  if (LOCKFILE_PATTERN.test(file)) return "lockfile";
  if (/(\.(test|spec|cy|e2e)\.[cm]?[jt]sx?$)|(^|\/)(__tests__|e2e|cypress|playwright)\//.test(file)) return "test";
  if (/\.(md|mdx|rst|txt|adoc)$/i.test(file) || /(^|\/)docs?\//.test(file)) return "docs";
  if (/^\.github\//.test(file)) return "ci";
  if (REVIEWABLE_EXTENSIONS.has(path.posix.extname(file))) return "source";
  if (/\.(json|ya?ml|toml|ini)$/.test(file)) return "config";
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
      { cwd, maxBuffer: GIT_MAX_BUFFER, timeout: GIT_TIMEOUT_MS, encoding: "utf8" },
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
    throw new Error(`Git could not find "${ref}" for ${label}. Use a branch, tag or commit that exists.`);
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

async function showFile(root: string, commit: string, file: string): Promise<string | undefined> {
  try {
    return await runGit(root, ["show", `${commit}:${file}`]);
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/*  Reading the pull request diff                                             */
/* -------------------------------------------------------------------------- */

async function readEntries(root: string, from: string, to: string): Promise<DiffEntry[]> {
  const statusOutput = await runGit(root, ["diff", "--name-status", "--no-renames", "-z", from, to]);
  const numstat = await runGit(root, ["diff", "--numstat", "--no-renames", from, to]);

  const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (const line of numstat.split("\n")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match) continue;
    const binary = match[1] === "-";
    counts.set(normalizePath(match[3]), {
      additions: binary ? 0 : Number(match[1]),
      deletions: binary ? 0 : Number(match[2]),
      binary,
    });
  }

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

function parseDiff(diff: string): Map<string, FileDiff> {
  const files = new Map<string, FileDiff>();
  let current: FileDiff | undefined;
  let line = 0;

  for (const text of diff.split("\n")) {
    if (text.startsWith("+++ ")) {
      const target = text.slice(4).split("\t")[0];

      if (target === "/dev/null") {
        current = undefined;
      } else {
        const file = normalizePath(target.replace(/^b\//, ""));
        current = files.get(file) ?? { added: [], ranges: [] };
        files.set(file, current);
      }
      continue;
    }

    if (text.startsWith("--- ") || text.startsWith("diff ") || text.startsWith("index ")) continue;

    if (text.startsWith("@@")) {
      const match = /\+(\d+)(?:,(\d+))?/.exec(text);
      line = match ? Number(match[1]) : 0;
      const count = match && match[2] !== undefined ? Number(match[2]) : 1;
      if (current && count > 0) current.ranges.push([line, line + count - 1]);
      continue;
    }

    if (text.startsWith("+") && current) {
      current.added.push({ line, text: text.slice(1) });
      line++;
    }
  }

  return files;
}

function touches(diff: FileDiff | undefined, from: number, to: number): boolean {
  return Boolean(diff?.ranges.some(([start, end]) => start <= to && end >= from));
}

/* -------------------------------------------------------------------------- */
/*  Merge check (read-only: does not touch the working tree or the index)     */
/* -------------------------------------------------------------------------- */

async function checkMergeable(
  root: string,
  mergeBase: string,
  base: string,
  head: string,
): Promise<{ mergeable: boolean | null; files: string[] }> {
  let output: string;

  try {
    output = await runGit(root, ["merge-tree", mergeBase, base, head]);
  } catch {
    return { mergeable: null, files: [] };
  }

  const files: string[] = [];
  let section: string[] = [];

  const flush = () => {
    if (section.length === 0) return;
    const conflict = section.some((line) => line.startsWith("+<<<<<<<"));
    if (conflict) {
      const location = section.find((line) => /^\s+(our|their|result)\s/.test(line));
      const file = location?.trim().split(/\s+/).pop();
      if (file) files.push(normalizePath(file));
    }
    section = [];
  };

  for (const line of output.split("\n")) {
    if (/^(added in both|changed in both|added in remote|added in local|removed in local|removed in remote)/.test(line)) {
      flush();
    }
    section.push(line);
  }
  flush();

  const conflicted = [...new Set(files)];
  return { mergeable: conflicted.length === 0, files: conflicted };
}

/* -------------------------------------------------------------------------- */
/*  Comment collection                                                        */
/* -------------------------------------------------------------------------- */

class CommentCollector {
  readonly comments: ReviewComment[] = [];
  truncated = false;
  private readonly perRuleFile = new Map<string, number>();
  private readonly seen = new Set<string>();

  add(comment: Omit<ReviewComment, "id">) {
    const key = `${comment.rule}|${comment.filePath ?? ""}`;
    const used = this.perRuleFile.get(key) ?? 0;
    if (used >= MAX_COMMENTS_PER_RULE_FILE) return;

    const id = createHash("sha1")
      .update(`${comment.rule}|${comment.filePath ?? ""}|${comment.line ?? 0}|${comment.title}`)
      .digest("hex")
      .slice(0, 10);

    if (this.seen.has(id)) return;

    if (this.comments.length >= MAX_COMMENTS) {
      this.truncated = true;
      return;
    }

    this.seen.add(id);
    this.perRuleFile.set(key, used + 1);
    this.comments.push({ id, ...comment });
  }

  sorted(): ReviewComment[] {
    return [...this.comments].sort(
      (a, b) =>
        severityRank(a.severity) - severityRank(b.severity) ||
        (a.filePath ?? "").localeCompare(b.filePath ?? "") ||
        (a.line ?? 0) - (b.line ?? 0),
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Reviewing changed JavaScript and TypeScript                               */
/* -------------------------------------------------------------------------- */

const SECRET_NAME_PATTERN = /token|secret|password|passwd|nonce|salt|session|api[_-]?key/i;
const SQL_PATTERN = /\b(select|insert|update|delete|from|where|values)\b/i;
const SQL_CALLS = new Set(["query", "execute", "raw", "queryRawUnsafe", "$queryRawUnsafe", "executeRawUnsafe", "$executeRawUnsafe"]);
const INSECURE_URL_PATTERN =
  /^http:\/\/(?!localhost|127\.|0\.0\.0\.0|\[::1\]|(www\.)?w3\.org|schemas\.|example\.|xmlns|json-schema\.org)/i;

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function scriptKindFor(file: string): ts.ScriptKind {
  const extension = path.posix.extname(file);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function calleeName(node: ts.CallExpression): string {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return "";
}

function isStaticString(node: ts.Node | undefined): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return Boolean(node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)));
}

function functionName(node: FunctionLike, sf: ts.SourceFile): string {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
    return node.name.getText(sf);
  }
  if (ts.isConstructorDeclaration(node)) return "constructor";

  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return node.name.getText(sf);
  return "anonymous function";
}

function jsxReturnedBy(callback: ts.ArrowFunction | ts.FunctionExpression): ts.Node | undefined {
  const unwrap = (node: ts.Node): ts.Node => (ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node);

  if (ts.isArrowFunction(callback) && !ts.isBlock(callback.body)) {
    const body = unwrap(callback.body);
    return ts.isJsxElement(body) || ts.isJsxSelfClosingElement(body) || ts.isJsxFragment(body) ? body : undefined;
  }

  if (ts.isBlock(callback.body)) {
    for (const statement of callback.body.statements) {
      if (ts.isReturnStatement(statement) && statement.expression) {
        const value = unwrap(statement.expression);
        if (ts.isJsxElement(value) || ts.isJsxSelfClosingElement(value) || ts.isJsxFragment(value)) return value;
      }
    }
  }

  return undefined;
}

function hasKeyAttribute(node: ts.Node): boolean {
  if (ts.isJsxFragment(node)) return false;

  const opening = ts.isJsxElement(node) ? node.openingElement : (node as ts.JsxSelfClosingElement);
  return opening.attributes.properties.some(
    (property) => ts.isJsxAttribute(property) && property.name.getText() === "key",
  );
}

function reviewSource(
  rel: string,
  text: string,
  diff: FileDiff,
  collector: CommentCollector,
) {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKindFor(rel));
  const lines = text.split("\n");

  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const changed = (node: ts.Node) => touches(diff, lineOf(node), lineOf(node));
  const snippetOf = (line: number) => lines[line - 1]?.trim().slice(0, 160);

  const report = (
    node: ts.Node,
    severity: Severity,
    category: CommentCategory,
    rule: string,
    title: string,
    message: string,
    suggestion: string,
  ) => {
    const line = lineOf(node);
    collector.add({
      severity,
      category,
      source: "static",
      rule,
      title,
      message,
      suggestion,
      filePath: rel,
      line,
      snippet: snippetOf(line),
    });
  };

  let anyCount = 0;
  let anyFirst: ts.Node | undefined;

  interface FnState {
    complexity: number;
    depth: number;
    maxDepth: number;
  }

  const visit = (node: ts.Node, fn: FnState | undefined, loopDepth: number, nested: boolean) => {
    if (isFunctionLike(node)) {
      const state: FnState = { complexity: 1, depth: 0, maxDepth: 0 };

      ts.forEachChild(node, (child) => visit(child, state, 0, false));

      const start = lineOf(node);
      const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

      if (touches(diff, start, end) && node.body) {
        const length = end - start + 1;
        const params = node.parameters.length;
        const name = functionName(node, sf);
        const problems: string[] = [];
        let severity: Severity = "nit";

        if (state.complexity > 15) {
          problems.push(`complexity ${state.complexity}`);
          severity = "major";
        } else if (state.complexity > 10) {
          problems.push(`complexity ${state.complexity}`);
          severity = "minor";
        }

        if (length > 200) {
          problems.push(`${length} lines long`);
          severity = severity === "major" ? severity : "major";
        } else if (length > 100) {
          problems.push(`${length} lines long`);
          if (severity === "nit") severity = "minor";
        }

        if (state.maxDepth > 4) {
          problems.push(`nesting ${state.maxDepth} levels deep`);
          if (severity === "nit") severity = "minor";
        }

        if (params > 5) {
          problems.push(`${params} parameters`);
        }

        if (problems.length > 0) {
          report(
            node,
            severity,
            "maintainability",
            "function-size",
            `\`${name}\` is hard to follow`,
            `\`${name}\` has ${problems.join(", ")}. Large, branching functions hide bugs and are hard to test.`,
            "Extract the distinct steps into smaller functions, return early to cut nesting, and group many parameters into one options object.",
          );
        }
      }

      return;
    }

    if (node.kind === ts.SyntaxKind.AnyKeyword && changed(node)) {
      anyCount++;
      anyFirst ??= node;
    }

    // Complexity and nesting.
    let opensBlock = false;
    if (fn) {
      if (ts.isIfStatement(node)) {
        fn.complexity++;
        opensBlock = !(ts.isIfStatement(node.parent) && node.parent.elseStatement === node);
      } else if (
        ts.isConditionalExpression(node) ||
        ts.isCaseClause(node) ||
        ts.isCatchClause(node)
      ) {
        fn.complexity++;
        opensBlock = ts.isCatchClause(node);
      } else if (
        ts.isForStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isWhileStatement(node) ||
        ts.isDoStatement(node)
      ) {
        fn.complexity++;
        opensBlock = true;
      } else if (ts.isSwitchStatement(node) || ts.isTryStatement(node)) {
        opensBlock = true;
      } else if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
      ) {
        fn.complexity++;
      }

      if (opensBlock) {
        fn.depth++;
        fn.maxDepth = Math.max(fn.maxDepth, fn.depth);
      }
    }

    const insideLoop =
      (ts.isForStatement(node) ||
        ts.isWhileStatement(node) ||
        ts.isDoStatement(node) ||
        ts.isForInStatement(node) ||
        (ts.isForOfStatement(node) && !node.awaitModifier));

    /* ---- Security ---- */

    if (ts.isCallExpression(node) && changed(node)) {
      const name = calleeName(node);
      const [first, second] = node.arguments;

      if (ts.isIdentifier(node.expression) && node.expression.text === "eval") {
        report(
          node,
          "major",
          "security",
          "eval",
          "`eval` runs arbitrary code",
          "eval executes a string as code, which is dangerous if any part of it can be influenced by a user.",
          "Parse data with JSON.parse, or replace eval with an explicit lookup or function.",
        );
      }

      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(sf) === "document" &&
        name === "write"
      ) {
        report(
          node,
          "minor",
          "security",
          "document-write",
          "`document.write` can enable XSS",
          "Writing HTML with document.write is unsafe with untrusted input and blocks rendering.",
          "Create nodes with the DOM API and set textContent instead.",
        );
      }

      if (
        (name === "exec" || name === "execSync") &&
        first &&
        (ts.isTemplateExpression(first) || (ts.isBinaryExpression(first) && first.operatorToken.kind === ts.SyntaxKind.PlusToken))
      ) {
        report(
          node,
          "major",
          "security",
          "command-injection",
          "Shell command is built from variables",
          "Building a shell command with string concatenation or a template lets input escape into the shell.",
          "Use execFile or spawn with an argument array, and validate or allow-list any value that reaches a command.",
        );
      }

      if (SQL_CALLS.has(name) && first) {
        const dynamicTemplate =
          ts.isTemplateExpression(first) &&
          SQL_PATTERN.test([first.head.text, ...first.templateSpans.map((span) => span.literal.text)].join(" "));
        const concatenated =
          ts.isBinaryExpression(first) &&
          first.operatorToken.kind === ts.SyntaxKind.PlusToken &&
          SQL_PATTERN.test(first.getText(sf));

        if (dynamicTemplate || concatenated) {
          report(
            node,
            "major",
            "security",
            "sql-injection",
            "SQL query is built from variables",
            "Joining values into a SQL string allows SQL injection.",
            "Pass values as bound parameters, for example query(\"... WHERE id = $1\", [id]).",
          );
        }
      }

      if (name === "createHash" && isStaticString(first) && /^(md5|sha1)$/i.test(first.text)) {
        report(
          node,
          "minor",
          "security",
          "weak-hash",
          `${first.text.toUpperCase()} is a weak hash`,
          "MD5 and SHA-1 are broken for security uses such as passwords, signatures and integrity checks.",
          "Use SHA-256 or better, and a password hash such as bcrypt, scrypt or argon2 for passwords.",
        );
      }

      if (name === "random" && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(sf) === "Math") {
        let cursor: ts.Node | undefined = node.parent;
        let hit = false;

        while (cursor && !ts.isStatement(cursor)) {
          if (
            (ts.isVariableDeclaration(cursor) && SECRET_NAME_PATTERN.test(cursor.name.getText(sf))) ||
            (ts.isPropertyAssignment(cursor) && SECRET_NAME_PATTERN.test(cursor.name.getText(sf))) ||
            (ts.isBinaryExpression(cursor) &&
              cursor.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              SECRET_NAME_PATTERN.test(cursor.left.getText(sf)))
          ) {
            hit = true;
          }
          cursor = cursor.parent;
        }

        if (!hit && cursor && ts.isVariableStatement(cursor)) {
          hit = cursor.declarationList.declarations.some((declaration) =>
            SECRET_NAME_PATTERN.test(declaration.name.getText(sf)),
          );
        }

        if (hit) {
          report(
            node,
            "major",
            "security",
            "weak-random",
            "Math.random is not secure",
            "Math.random is predictable, so tokens, salts and secrets made with it can be guessed.",
            "Use crypto.randomUUID(), crypto.randomBytes() or crypto.getRandomValues().",
          );
        }
      }

      if (
        (name === "setHeader" || name === "header" || name === "set") &&
        isStaticString(first) &&
        first.text.toLowerCase() === "access-control-allow-origin" &&
        isStaticString(second) &&
        second.text === "*"
      ) {
        report(
          node,
          "minor",
          "security",
          "cors-wildcard",
          "CORS allows every origin",
          "A wildcard origin lets any website call this endpoint from a browser.",
          "Allow only the origins you trust, and avoid combining a wildcard with credentials.",
        );
      }

      /* ---- Bugs and performance ---- */

      if (name === "forEach" && first && (ts.isArrowFunction(first) || ts.isFunctionExpression(first))) {
        if (first.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
          report(
            node,
            "major",
            "bug",
            "async-foreach",
            "forEach does not wait for async callbacks",
            "forEach ignores the promises its async callback returns, so the code after it runs before the work finishes and errors go unhandled.",
            "Use for...of with await, or await Promise.all(items.map(async (item) => ...)).",
          );
        }
      }

      if ((name === "useEffect" || name === "useLayoutEffect") && first && (ts.isArrowFunction(first) || ts.isFunctionExpression(first))) {
        if (first.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
          report(
            node,
            "major",
            "bug",
            "async-effect",
            "useEffect callback must not be async",
            "An async effect returns a promise instead of a cleanup function, so React cannot clean up and warns at runtime.",
            "Define an async function inside the effect and call it, returning a cleanup function if needed.",
          );
        }
      }

      if (name === "parseInt" && node.arguments.length === 1) {
        report(
          node,
          "nit",
          "bug",
          "parseint-radix",
          "parseInt without a radix",
          "Without a radix, parseInt may guess the base from the string.",
          "Pass the radix explicitly: parseInt(value, 10), or use Number(value).",
        );
      }

      if (
        name === "parse" &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(sf) === "JSON" &&
        first &&
        ts.isCallExpression(first) &&
        first.expression.getText(sf) === "JSON.stringify"
      ) {
        report(
          node,
          "nit",
          "performance",
          "json-clone",
          "Deep copy through JSON",
          "JSON.parse(JSON.stringify(x)) is slow and drops dates, undefined, Maps and Sets.",
          "Use structuredClone(x).",
        );
      }

      if (name === "map" && first && (ts.isArrowFunction(first) || ts.isFunctionExpression(first))) {
        const returned = jsxReturnedBy(first);
        if (returned && !hasKeyAttribute(returned)) {
          report(
            returned,
            "minor",
            "bug",
            "missing-key",
            "List items are missing a key",
            "Elements rendered from an array need a stable key, or React cannot track them and may show wrong state.",
            "Add key={item.id} (or another stable unique value) to the outermost element returned by the callback.",
          );
        }
      }
    }

    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function" && changed(node)) {
      report(
        node,
        "major",
        "security",
        "eval",
        "`new Function` runs arbitrary code",
        "new Function compiles a string into code, which is as dangerous as eval with untrusted input.",
        "Replace it with an explicit function or a lookup table.",
      );
    }

    if (ts.isBinaryExpression(node) && changed(node)) {
      const operator = node.operatorToken.kind;

      if (
        operator === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        (node.left.name.text === "innerHTML" || node.left.name.text === "outerHTML") &&
        !isStaticString(node.right)
      ) {
        report(
          node,
          "major",
          "security",
          "inner-html",
          `${node.left.name.text} is set from a variable`,
          "Assigning dynamic HTML is a common source of cross-site scripting.",
          "Set textContent, build nodes with the DOM API, or sanitize the HTML first.",
        );
      }

      if (
        operator === ts.SyntaxKind.EqualsToken &&
        node.left.getText(sf).includes("NODE_TLS_REJECT_UNAUTHORIZED") &&
        isStaticString(node.right) &&
        node.right.text === "0"
      ) {
        report(
          node,
          "major",
          "security",
          "tls-disabled",
          "TLS certificate checks are disabled",
          "Turning off certificate verification makes every HTTPS request open to interception.",
          "Remove it and trust the right certificate authority instead.",
        );
      }

      if (
        [
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.EqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsToken,
        ].includes(operator) &&
        ((ts.isIdentifier(node.left) && node.left.text === "NaN") || (ts.isIdentifier(node.right) && node.right.text === "NaN"))
      ) {
        report(
          node,
          "major",
          "bug",
          "nan-comparison",
          "Comparing with NaN never works",
          "NaN is not equal to anything, including itself, so this comparison is always the same.",
          "Use Number.isNaN(value).",
        );
      }
    }

    if (
      (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) &&
      ts.isBinaryExpression(node.expression) &&
      node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      changed(node)
    ) {
      report(
        node,
        "minor",
        "bug",
        "assignment-in-condition",
        "Assignment inside a condition",
        "A single = in a condition assigns instead of comparing, which is usually a typo for ===.",
        "Use === to compare, or move the assignment out of the condition.",
      );
    }

    if (ts.isPropertyAssignment(node) && changed(node)) {
      const key = node.name.getText(sf);

      if (key === "rejectUnauthorized" && node.initializer.kind === ts.SyntaxKind.FalseKeyword) {
        report(
          node,
          "major",
          "security",
          "tls-disabled",
          "TLS certificate checks are disabled",
          "rejectUnauthorized: false accepts any certificate, so connections can be intercepted.",
          "Remove it and trust the right certificate authority instead.",
        );
      }

      if (key === "origin" && isStaticString(node.initializer) && node.initializer.text === "*") {
        report(
          node,
          "minor",
          "security",
          "cors-wildcard",
          "CORS allows every origin",
          "A wildcard origin lets any website call this endpoint from a browser.",
          "Allow only the origins you trust, and avoid combining a wildcard with credentials.",
        );
      }
    }

    if (ts.isJsxAttribute(node) && node.name.getText(sf) === "dangerouslySetInnerHTML" && changed(node)) {
      report(
        node,
        "minor",
        "security",
        "dangerous-html",
        "dangerouslySetInnerHTML needs sanitized input",
        "This inserts raw HTML, so any unsanitized value becomes a cross-site scripting hole.",
        "Sanitize the HTML with a trusted library such as DOMPurify, or render it as text.",
      );
    }

    if (ts.isCatchClause(node) && ts.isBlock(node.block) && node.block.statements.length === 0 && changed(node)) {
      const inner = text.slice(node.block.getStart(sf) + 1, node.block.getEnd() - 1);

      if (!/\S/.test(inner)) {
        report(
          node,
          "minor",
          "bug",
          "empty-catch",
          "Error is silently swallowed",
          "An empty catch block hides failures, which makes problems hard to find later.",
          "Handle or log the error, or add a comment explaining why it is safe to ignore.",
        );
      }
    }

    if (ts.isThrowStatement(node) && node.expression && (isStaticString(node.expression) || ts.isTemplateExpression(node.expression)) && changed(node)) {
      report(
        node,
        "minor",
        "bug",
        "throw-string",
        "A string is thrown instead of an Error",
        "Thrown strings have no stack trace and break instanceof checks.",
        "Throw new Error(message) or a custom error class.",
      );
    }

    if (ts.isAwaitExpression(node) && loopDepth > 0 && changed(node)) {
      report(
        node,
        "minor",
        "performance",
        "await-in-loop",
        "await inside a loop runs one at a time",
        "Each iteration waits for the previous one, so independent work is serialized.",
        "If the iterations are independent, start them together with Promise.all(items.map(...)). Keep the loop only when order matters.",
      );
    }

    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && INSECURE_URL_PATTERN.test(node.text) && changed(node)) {
      report(
        node,
        "minor",
        "security",
        "insecure-url",
        "Plain http:// URL",
        "Traffic over http can be read and changed on the network.",
        "Use https:// unless this is a local address.",
      );
    }

    ts.forEachChild(node, (child) => visit(child, fn, insideLoop ? loopDepth + 1 : loopDepth, nested));

    if (fn && opensBlock) fn.depth--;
  };

  visit(sf, undefined, 0, false);

  if (anyCount > 0 && anyFirst) {
    report(
      anyFirst,
      "nit",
      "maintainability",
      "any-type",
      `${plural(anyCount, "use")} of \`any\` added`,
      "any turns off type checking for the value, so mistakes surface at runtime instead of in the editor.",
      "Use a specific type, a generic, or unknown with a type guard.",
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Dependencies                                                              */
/* -------------------------------------------------------------------------- */

function majorOf(range: string): number | undefined {
  const match = /(\d+)\./.exec(range) ?? /^[\^~>=<\s]*(\d+)$/.exec(range);
  return match ? Number(match[1]) : undefined;
}

async function reviewDependencies(
  root: string,
  mergeBase: string,
  head: string,
  entries: DiffEntry[],
  diffs: Map<string, FileDiff>,
  collector: CommentCollector,
): Promise<{ added: string[]; upgraded: string[]; removed: string[] }> {
  const result = { added: [] as string[], upgraded: [] as string[], removed: [] as string[] };

  const [baseText, headText] = await Promise.all([
    showFile(root, mergeBase, "package.json"),
    showFile(root, head, "package.json"),
  ]);

  const parse = (text: string | undefined) => {
    if (!text) return undefined;
    try {
      return JSON.parse(text) as Record<string, Record<string, string> | undefined>;
    } catch {
      return undefined;
    }
  };

  const baseJson = parse(baseText);
  const headJson = parse(headText);

  const lockChanged = entries.some((entry) => LOCKFILE_PATTERN.test(entry.path));

  if (baseJson && headJson) {
    const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
    const lineFor = (name: string) =>
      diffs.get("package.json")?.added.find((added) => added.text.includes(`"${name}"`))?.line;

    for (const section of sections) {
      const before = baseJson[section] ?? {};
      const after = headJson[section] ?? {};

      for (const [name, range] of Object.entries(after)) {
        const line = lineFor(name);
        const previous = before[name];
        const runtime = section === "dependencies";

        if (previous === undefined) {
          result.added.push(name);

          collector.add({
            severity: runtime ? "minor" : "nit",
            category: "dependencies",
            source: "dependencies",
            rule: "new-dependency",
            title: `New ${runtime ? "runtime " : ""}dependency \`${name}\``,
            message: `\`${name}@${range}\` was added to ${section}. ${
              runtime ? "Runtime dependencies add to the bundle size and the supply-chain risk." : "Check that the team needs it."
            }`,
            suggestion: "Confirm its license, maintenance status and size, and check whether the platform or an existing dependency already covers it.",
            filePath: "package.json",
            line,
          });
        } else if (previous !== range) {
          const from = majorOf(previous);
          const to = majorOf(range);

          if (from !== undefined && to !== undefined && to > from) {
            result.upgraded.push(name);

            collector.add({
              severity: "minor",
              category: "dependencies",
              source: "dependencies",
              rule: "major-upgrade",
              title: `Major upgrade of \`${name}\` (${previous} → ${range})`,
              message: "A major version can contain breaking changes.",
              suggestion: "Read the release notes and run the full test suite before merging.",
              filePath: "package.json",
              line,
            });
          }
        }

        if (previous !== range && /^(\*|latest|next|x)$/i.test(range.trim())) {
          collector.add({
            severity: "minor",
            category: "dependencies",
            source: "dependencies",
            rule: "unpinned-dependency",
            title: `\`${name}\` is not pinned to a version`,
            message: `\`${range}\` lets any future release be installed, including a breaking or malicious one.`,
            suggestion: "Use an exact version or a caret range, and rely on the lockfile.",
            filePath: "package.json",
            line,
          });
        } else if (previous !== range && /^(git[+:]|github:|https?:|file:|link:)/i.test(range.trim())) {
          collector.add({
            severity: "minor",
            category: "dependencies",
            source: "dependencies",
            rule: "untrusted-source",
            title: `\`${name}\` is installed from outside the registry`,
            message: `\`${range}\` bypasses the registry's checks, and the code can change without a version bump.`,
            suggestion: "Publish it to a registry, or pin it to a commit hash.",
            filePath: "package.json",
            line,
          });
        }

        if (previous === undefined && DEPRECATED_PACKAGES[name]) {
          collector.add({
            severity: "minor",
            category: "dependencies",
            source: "dependencies",
            rule: "deprecated-dependency",
            title: `\`${name}\` is deprecated`,
            message: DEPRECATED_PACKAGES[name],
            suggestion: "Choose the maintained alternative.",
            filePath: "package.json",
            line,
          });
        }
      }

      for (const name of Object.keys(before)) {
        if (!(name in after)) result.removed.push(name);
      }
    }
  }

  const changedDependencies =
    result.added.length + result.upgraded.length + result.removed.length > 0;
  const packageChanged = entries.some((entry) => entry.path === "package.json");

  if (changedDependencies && !lockChanged) {
    const hasLockfile = (
      await Promise.all(
        ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"].map((file) =>
          showFile(root, head, file),
        ),
      )
    ).some((content) => content !== undefined);

    if (hasLockfile) {
      collector.add({
        severity: "minor",
        category: "dependencies",
        source: "dependencies",
        rule: "lockfile-not-updated",
        title: "Dependencies changed but the lockfile did not",
        message: "Installs will resolve different versions than the ones you tested.",
        suggestion: "Run the package manager's install command and commit the updated lockfile.",
        filePath: "package.json",
      });
    }
  } else if (lockChanged && !packageChanged) {
    collector.add({
      severity: "nit",
      category: "dependencies",
      source: "dependencies",
      rule: "lockfile-only",
      title: "Lockfile changed without package.json",
      message: "Versions were updated indirectly. This is easy to do by accident and hard to review.",
      suggestion: "Confirm the lockfile change is intended, and describe it in the pull request.",
      filePath: entries.find((entry) => LOCKFILE_PATTERN.test(entry.path))?.path,
    });
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/*  Reviewers                                                                 */
/* -------------------------------------------------------------------------- */

function patternToRegex(pattern: string): RegExp | undefined {
  let value = pattern.trim();
  if (!value) return undefined;

  const anchored = value.startsWith("/");
  if (anchored) value = value.slice(1);
  if (value.endsWith("/")) value = value.slice(0, -1);

  const hasSlash = value.includes("/");

  const body = value
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, "[^/]");

  try {
    return new RegExp(`${anchored || hasSlash ? "^" : "(^|.*/)"}${body}(/.*)?$`);
  } catch {
    return undefined;
  }
}

function loadCodeOwners(root: string): Array<{ regex: RegExp; owners: string[] }> {
  for (const candidate of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(root, candidate), "utf8");
    } catch {
      continue;
    }

    const rules: Array<{ regex: RegExp; owners: string[] }> = [];

    for (const raw of content.split("\n")) {
      const line = raw.replace(/#.*/, "").trim();
      if (!line) continue;

      const [pattern, ...owners] = line.split(/\s+/);
      const regex = patternToRegex(pattern);
      if (regex && owners.length > 0) rules.push({ regex, owners });
    }

    return rules;
  }

  return [];
}

function codeOwnerGroups(
  rules: Array<{ regex: RegExp; owners: string[] }>,
  files: string[],
): CodeOwnerGroup[] {
  const groups = new Map<string, CodeOwnerGroup>();

  for (const file of files) {
    let owners: string[] | undefined;
    for (const rule of rules) {
      if (rule.regex.test(file)) owners = rule.owners;
    }

    for (const owner of owners ?? []) {
      const group = groups.get(owner) ?? { owner, files: 0, samples: [] };
      group.files++;
      if (group.samples.length < 3) group.samples.push(file);
      groups.set(owner, group);
    }
  }

  return [...groups.values()].sort((a, b) => b.files - a.files || a.owner.localeCompare(b.owner));
}

async function suggestReviewers(
  root: string,
  mergeBase: string,
  files: string[],
  authorEmails: Set<string>,
): Promise<ReviewerSuggestion[]> {
  if (files.length === 0) return [];

  let output: string;
  try {
    output = await runGit(root, [
      "log",
      "--format=%an%x1f%ae",
      "-n",
      "300",
      mergeBase,
      "--",
      ...files.slice(0, 50),
    ]);
  } catch {
    return [];
  }

  const counts = new Map<string, ReviewerSuggestion>();

  for (const line of output.split("\n")) {
    const [name, rawEmail] = line.split("\x1f");
    const email = (rawEmail ?? "").toLowerCase();
    if (!name || !email || authorEmails.has(email)) continue;

    const entry = counts.get(email) ?? { name, email, commits: 0 };
    entry.commits++;
    counts.set(email, entry);
  }

  return [...counts.values()]
    .sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name))
    .slice(0, 3);
}

/* -------------------------------------------------------------------------- */
/*  Converting the other tools' results into review comments                  */
/* -------------------------------------------------------------------------- */

const FINDING_RULES: Record<
  string,
  { severity: Severity; category: CommentCategory; title: string }
> = {
  "conflict-marker": { severity: "blocker", category: "bug", title: "Merge conflict marker left in the code" },
  secret: { severity: "blocker", category: "security", title: "Possible secret committed" },
  "sensitive-file": { severity: "blocker", category: "security", title: "Credentials or key file in the change" },
  "focused-test": { severity: "major", category: "testing", title: "Focused test (.only) skips the rest of the suite" },
  debugger: { severity: "major", category: "bug", title: "debugger statement left in" },
  "skipped-test": { severity: "minor", category: "testing", title: "Test disabled with .skip" },
  "large-addition": { severity: "minor", category: "maintainability", title: "Very large addition to one file" },
  "console-log": { severity: "nit", category: "maintainability", title: "console.log left in" },
  todo: { severity: "nit", category: "maintainability", title: "TODO or FIXME added" },
  suppression: { severity: "nit", category: "maintainability", title: "Type or lint check disabled" },
};

function addGitComments(git: GitReport, collector: CommentCollector) {
  for (const finding of git.findings) {
    const rule = FINDING_RULES[finding.rule];
    if (!rule) continue;

    collector.add({
      severity: rule.severity,
      category: rule.category,
      source: "git",
      rule: finding.rule,
      title: rule.title,
      message: finding.message,
      suggestion: finding.suggestion,
      filePath: finding.filePath,
      line: finding.line,
      snippet: finding.snippet,
    });
  }

  const bad = git.commits.filter((commit) =>
    commit.flags.some((flag) => ["wip", "vague-message"].includes(flag.flag)),
  );

  if (bad.length > 0) {
    collector.add({
      severity: "minor",
      category: "history",
      source: "git",
      rule: "commit-messages",
      title: `${plural(bad.length, "commit")} with a vague or work-in-progress message`,
      message: bad
        .slice(0, 3)
        .map((commit) => `${commit.shortHash} "${commit.subject}"`)
        .join("; "),
      suggestion: "Squash or reword them so the history explains each change.",
    });
  }

  const merges = git.commits.filter((commit) => commit.isMerge);
  if (merges.length > 0) {
    collector.add({
      severity: "nit",
      category: "history",
      source: "git",
      rule: "merge-commits",
      title: `${plural(merges.length, "merge commit")} inside the branch`,
      message: "Merging the base into the branch clutters the history.",
      suggestion: "Rebase onto the base branch instead, if your team prefers a linear history.",
    });
  }
}

const API_SEVERITY: Record<string, Severity> = {
  critical: "blocker",
  high: "major",
  medium: "minor",
  low: "nit",
};

function addApiComments(api: ApiReport, collector: CommentCollector) {
  for (const change of api.changes.filter((item) => item.breaking).slice(0, 40)) {
    collector.add({
      severity: API_SEVERITY[change.severity] ?? "minor",
      category: "api",
      source: "api",
      rule: `api-${change.category}`,
      title: change.title,
      message: change.description,
      suggestion: `${change.suggestion.title}. ${change.suggestion.summary}`,
      filePath: change.filePath,
      line: change.headLine ?? change.baselineLine,
    });
  }
}

/** True when every added line is a comment, a blank line or an import. */
function isTrivialChange(diff: FileDiff | undefined): boolean {
  if (!diff || diff.added.length === 0) return false;
  return diff.added.every((line) => /^\s*(\/\/|\/\*|\*|\*\/|#|import\s|$)/.test(line.text));
}

function addTestComments(
  impact: ImpactReport,
  diffs: Map<string, FileDiff>,
  collector: CommentCollector,
) {
  for (const test of impact.impactedTests.filter((item) => item.priority === "critical")) {
    collector.add({
      severity: "blocker",
      category: "testing",
      source: "tests",
      rule: "test-imports-deleted-file",
      title: "Test imports a file this change deletes",
      message: test.summary,
      suggestion: "Update the import, or delete the test if it is obsolete.",
      filePath: test.filePath,
    });
  }

  for (const gap of impact.coverageGaps) {
    if (isTrivialChange(diffs.get(gap.filePath))) continue;

    collector.add({
      severity: gap.severity === "high" ? "major" : gap.severity === "medium" ? "minor" : "nit",
      category: "testing",
      source: "tests",
      rule: "no-test",
      title: `No test covers ${gap.filePath.split("/").pop()}`,
      message: `${gap.reason} Exports without tests: ${gap.runtimeExports.slice(0, 5).join(", ")}.`,
      suggestion: `Add ${gap.suggestedTestPath}. The Test Impact tool can generate a starter test.`,
      filePath: gap.filePath,
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Checklist, verdict and review text                                        */
/* -------------------------------------------------------------------------- */

function countBy<T extends string>(values: T[], keys: readonly T[]): Record<T, number> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
  for (const value of values) counts[value]++;
  return counts;
}

function buildChecklist(input: {
  comments: ReviewComment[];
  mergeable: boolean | null;
  conflictFiles: string[];
  behind: number;
  size: { label: SizeLabel; lines: number };
  testsRan: boolean;
  gaps: number;
  impacted: number;
  apiRan: boolean;
  apiBreaking: number;
  dependenciesChanged: number;
  docsChanged: boolean;
}): ChecklistItem[] {
  const { comments } = input;
  const withRule = (...rules: string[]) => comments.filter((comment) => rules.includes(comment.rule));
  const item = (
    id: string,
    label: string,
    status: CheckStatus,
    detail: string,
  ): ChecklistItem => ({ id, label, status, detail });

  const items: ChecklistItem[] = [];

  items.push(
    input.mergeable === null
      ? item("merge", "Merges cleanly into the base branch", "skipped", "Git could not check this.")
      : input.mergeable
        ? item("merge", "Merges cleanly into the base branch", "pass", "No conflicts with the base branch.")
        : item("merge", "Merges cleanly into the base branch", "fail", `Conflicts in ${input.conflictFiles.join(", ") || "some files"}.`),
  );

  const secrets = withRule("secret", "sensitive-file");
  items.push(
    secrets.length > 0
      ? item("secrets", "No secrets or credential files", "fail", `${plural(secrets.length, "problem")} found. Rotate anything that was ever pushed.`)
      : item("secrets", "No secrets or credential files", "pass", "None found in the added lines."),
  );

  const security = comments.filter((comment) => comment.category === "security" && comment.source === "static");
  items.push(
    security.some((comment) => comment.severity === "major" || comment.severity === "blocker")
      ? item("security", "No risky security patterns", "fail", `${plural(security.length, "issue")}, such as injection or disabled TLS.`)
      : security.length > 0
        ? item("security", "No risky security patterns", "warn", `${plural(security.length, "minor issue")} to review.`)
        : item("security", "No risky security patterns", "pass", "No injection, XSS or TLS problems in the changed lines."),
  );

  const debug = withRule("debugger", "focused-test", "conflict-marker");
  const logs = withRule("console-log");
  items.push(
    debug.length > 0
      ? item("debug", "No leftover debug code", "fail", `${plural(debug.length, "leftover")}: debugger, .only or a conflict marker.`)
      : logs.length > 0
        ? item("debug", "No leftover debug code", "warn", `${plural(logs.length, "console.log call")} added.`)
        : item("debug", "No leftover debug code", "pass", "Clean."),
  );

  items.push(
    !input.testsRan
      ? item("tests", "Tests cover the changed code", "skipped", "Test impact was not run.")
      : input.gaps === 0
        ? item("tests", "Tests cover the changed code", "pass", `${plural(input.impacted, "existing test")} reach the change.`)
        : item(
            "tests",
            "Tests cover the changed code",
            comments.some((comment) => comment.rule === "no-test" && comment.severity === "major") ? "fail" : "warn",
            `${plural(input.gaps, "changed file")} ${input.gaps === 1 ? "has" : "have"} no test.`,
          ),
  );

  items.push(
    !input.apiRan
      ? item("api", "No breaking API changes", "skipped", "The API check was not run.")
      : input.apiBreaking === 0
        ? item("api", "No breaking API changes", "pass", "Exports and routes stay compatible.")
        : item(
            "api",
            "No breaking API changes",
            comments.some((comment) => comment.source === "api" && (comment.severity === "blocker" || comment.severity === "major")) ? "fail" : "warn",
            `${plural(input.apiBreaking, "breaking change")} found.`,
          ),
  );

  items.push(
    input.dependenciesChanged === 0
      ? item("dependencies", "Dependencies reviewed", "pass", "No dependency changes.")
      : item("dependencies", "Dependencies reviewed", "warn", `${plural(input.dependenciesChanged, "dependency change")} to verify.`),
  );

  const complexity = withRule("function-size");
  items.push(
    complexity.length === 0
      ? item("complexity", "Code stays easy to follow", "pass", "No oversized or deeply nested functions in the changes.")
      : item("complexity", "Code stays easy to follow", "warn", `${plural(complexity.length, "function")} too complex or long.`),
  );

  const history = withRule("commit-messages", "merge-commits");
  items.push(
    history.length === 0
      ? item("history", "Commit history is clean", "pass", "Messages describe the changes.")
      : item("history", "Commit history is clean", "warn", "Some commits should be squashed or reworded."),
  );

  items.push(
    input.size.label === "XL"
      ? item("size", "Reviewable size", "fail", `${input.size.lines} changed lines is too much for one review.`)
      : input.size.label === "L"
        ? item("size", "Reviewable size", "warn", `${input.size.lines} changed lines. Consider splitting it.`)
        : item("size", "Reviewable size", "pass", `${input.size.lines} changed lines (${input.size.label}).`),
  );

  items.push(
    input.behind > 20
      ? item("fresh", "Up to date with the base branch", "warn", `${plural(input.behind, "commit")} behind the base.`)
      : item("fresh", "Up to date with the base branch", "pass", input.behind === 0 ? "Up to date." : `${plural(input.behind, "commit")} behind.`),
  );

  items.push(
    (input.apiBreaking > 0 || withRule("breaking-docs").length > 0) && !input.docsChanged
      ? item("docs", "Documentation updated", "warn", "A breaking change has no documentation or changelog update.")
      : item("docs", "Documentation updated", "pass", input.docsChanged ? "Documentation changed with the code." : "No documentation needed."),
  );

  return items;
}

function decide(
  counts: Record<Severity, number>,
  strictness: Strictness,
  mergeable: boolean | null,
  comments: ReviewComment[],
): PullRequestReview["verdict"] {
  const { blocker, major, minor, nit } = counts;

  const score = Math.max(0, Math.min(100, 100 - blocker * 30 - major * 12 - minor * 3 - nit));

  let decision: Decision;
  if (blocker > 0 || mergeable === false) decision = "request-changes";
  else if (strictness === "relaxed") decision = major + minor + nit > 0 ? "approve-with-comments" : "approve";
  else if (strictness === "strict") {
    decision = major > 0 || minor >= 5 ? "request-changes" : minor + nit > 0 ? "approve-with-comments" : "approve";
  } else {
    decision = major > 0 ? "request-changes" : minor + nit > 0 ? "approve-with-comments" : "approve";
  }

  const reasons = comments
    .filter((comment) => comment.severity === "blocker" || comment.severity === "major")
    .slice(0, 4)
    .map((comment) => `${comment.title}${comment.filePath ? ` (${comment.filePath}${comment.line ? `:${comment.line}` : ""})` : ""}`);

  if (mergeable === false) reasons.unshift("The branch has merge conflicts with the base.");

  const headline =
    decision === "approve"
      ? "Looks good to merge"
      : decision === "approve-with-comments"
        ? `Good to merge after a look at ${plural(minor + nit + major, "comment")}`
        : "Changes are needed before this can merge";

  return { decision, score, headline, reasons };
}

function buildReviewMarkdown(
  review: Pick<PullRequestReview, "verdict" | "comments" | "checklist" | "reviewers" | "pr">,
): string {
  const label: Record<Decision, string> = {
    approve: "Approve",
    "approve-with-comments": "Approve with comments",
    "request-changes": "Request changes",
  };

  const where = (comment: ReviewComment) =>
    comment.filePath ? `\`${comment.filePath}${comment.line ? `:${comment.line}` : ""}\`` : "Pull request";

  const lines: string[] = [
    `## Review: ${label[review.verdict.decision]}`,
    "",
    `**${review.verdict.headline}.** Readiness score ${review.verdict.score}/100.`,
    "",
  ];

  const groups: Array<[Severity, string]> = [
    ["blocker", "Must fix"],
    ["major", "Should fix"],
    ["minor", "Worth a look"],
  ];

  for (const [severity, heading] of groups) {
    const list = review.comments.filter((comment) => comment.severity === severity);
    if (list.length === 0) continue;

    lines.push(`### ${heading} (${list.length})`, "");
    for (const comment of list.slice(0, 10)) {
      lines.push(`- ${where(comment)}: **${comment.title}**${comment.suggestion ? `. ${comment.suggestion}` : ""}`);
    }
    if (list.length > 10) lines.push(`- ...and ${list.length - 10} more`);
    lines.push("");
  }

  const nits = review.comments.filter((comment) => comment.severity === "nit").length;
  if (nits > 0) lines.push(`_${plural(nits, "small suggestion")} not listed here._`, "");

  lines.push("### Checklist", "");
  for (const check of review.checklist) {
    const mark = check.status === "pass" ? "x" : " ";
    const note = check.status === "skipped" ? " (not checked)" : check.status === "pass" ? "" : `: ${check.detail}`;
    lines.push(`- [${mark}] ${check.label}${note}`);
  }

  const reviewers = [
    ...review.reviewers.codeOwners.slice(0, 3).map((group) => group.owner),
    ...review.reviewers.suggested.map((person) => person.name),
  ];
  if (reviewers.length > 0) {
    lines.push("", `**Suggested reviewers:** ${[...new Set(reviewers)].join(", ")}`);
  }

  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/*  Main analysis                                                             */
/* -------------------------------------------------------------------------- */

async function runSource<T>(
  name: string,
  enabled: boolean,
  skippedReason: string,
  sources: SourceRun[],
  run: () => Promise<T>,
  describe: (result: T) => string,
): Promise<T | undefined> {
  if (!enabled) {
    sources.push({ name, status: "skipped", detail: skippedReason });
    return undefined;
  }

  try {
    const result = await run();
    sources.push({ name, status: "ran", detail: describe(result) });
    return result;
  } catch (error) {
    sources.push({
      name,
      status: "failed",
      detail: error instanceof Error ? error.message : "The analysis failed.",
    });
    return undefined;
  }
}

export async function reviewPullRequest(
  projectPath: string,
  options: {
    baseRef?: string;
    headRef?: string;
    strictness?: Strictness;
    runTestImpact?: boolean;
    runBreakingApi?: boolean;
  } = {},
): Promise<PullRequestReview> {
  const strictness = options.strictness ?? "normal";
  const runTestImpact = options.runTestImpact ?? true;
  const runBreakingApi = options.runBreakingApi ?? true;

  if (!["relaxed", "normal", "strict"].includes(strictness)) {
    throw new Error("strictness must be one of relaxed, normal, or strict.");
  }

  const resolved = await resolveProjectPath(projectPath);
  const root = fs.realpathSync(resolved.projectPath);
  const warnings: string[] = [];

  const warn = (message: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message);
    else if (warnings.length === MAX_WARNINGS) warnings.push("Further warnings were omitted.");
  };

  await ensureGitRepository(root);

  const currentHead = await tryGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!currentHead) {
    throw new Error("This repository has no commits yet, so there is nothing to review.");
  }

  /* ---- Find the pull request ---- */

  const headRef = options.headRef?.trim() ? validateRef(options.headRef, "headRef") : "HEAD";
  const headCommit = await resolveCommit(root, headRef, "headRef");

  const baseRef = options.baseRef?.trim()
    ? validateRef(options.baseRef, "baseRef")
    : await defaultBaseRef(root);

  if (!baseRef) {
    throw new Error("Could not find a base branch such as main or master. Enter one in the base ref field.");
  }

  const baseCommit = await resolveCommit(root, baseRef, "baseRef");
  const mergeBase = await tryGit(root, ["merge-base", baseCommit, headCommit]);

  if (!mergeBase) {
    throw new Error(`"${baseRef}" and "${headRef}" share no history, so there is nothing to compare.`);
  }

  const ahead = Number((await tryGit(root, ["rev-list", "--count", `${baseCommit}..${headCommit}`])) ?? 0);
  const behind = Number((await tryGit(root, ["rev-list", "--count", `${headCommit}..${baseCommit}`])) ?? 0);

  if (ahead === 0) {
    throw new Error(
      `"${headRef}" has no commits beyond "${baseRef}", so there is nothing to review. Check out or select the branch with the changes.`,
    );
  }

  const branchName = await tryGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch =
    headRef === "HEAD" ? (branchName && branchName !== "HEAD" ? branchName : "(detached HEAD)") : headRef;

  const isCheckedOut = headCommit === currentHead;
  const dirty = ((await tryGit(root, ["status", "--porcelain"])) ?? "").split("\n").filter(Boolean).length;

  if (dirty > 0) {
    warn(`${plural(dirty, "uncommitted file")} ${dirty === 1 ? "is" : "are"} not part of this review.`);
  }

  /* ---- The diff ---- */

  const entries = await readEntries(root, mergeBase, headCommit);
  let diffText = await runGit(root, [
    "diff",
    "-U0",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    mergeBase,
    headCommit,
  ]);

  if (diffText.length > MAX_DIFF_CHARS) {
    warn("The diff is very large, so only the first part was reviewed line by line.");
    diffText = diffText.slice(0, MAX_DIFF_CHARS);
  }

  const diffs = parseDiff(diffText);

  const additions = entries.reduce((sum, entry) => sum + (isNoise(entry.path) ? 0 : entry.additions), 0);
  const deletions = entries.reduce((sum, entry) => sum + (isNoise(entry.path) ? 0 : entry.deletions), 0);
  const size = {
    label: sizeLabel(additions + deletions),
    lines: additions + deletions,
    files: entries.length,
    additions,
    deletions,
  };

  /* ---- Run the other analyses ---- */

  const sources: SourceRun[] = [];

  const [git, api, impact] = await Promise.all([
    runSource<GitReport>(
      "Git Change Analyzer",
      true,
      "",
      sources,
      () =>
        analyzeGitChanges(root, {
          mode: "range",
          baseRef: baseCommit,
          headRef: headCommit,
          maxCommits: MAX_COMMITS_READ,
          includeUntracked: false,
        }),
      (result) => `${plural(result.totals.commits, "commit")}, ${plural(result.findings.length, "finding")}`,
    ),
    runSource<ApiReport>(
      "Breaking API Change Detector",
      runBreakingApi,
      "Turned off.",
      sources,
      () =>
        detectBreakingApiChanges(root, {
          baseRef: mergeBase,
          headRef: headCommit,
          scope: "all",
        }),
      (result) => `${plural(result.breakingChanges, "breaking change")}, bump ${result.recommendedBump}`,
    ),
    runSource<ImpactReport>(
      "Test Impact Analyzer",
      runTestImpact && isCheckedOut,
      runTestImpact
        ? `Needs the branch checked out, because tests are read from the working tree. Check out ${branch} to include it.`
        : "Turned off.",
      sources,
      () => analyzeTestImpact(root, { baseRef: baseCommit, includeUntracked: false }),
      (result) => `${plural(result.impactedTestCount, "test")} affected, ${plural(result.coverageGaps.length, "coverage gap")}`,
    ),
  ]);

  for (const source of sources) {
    if (source.status === "failed") warn(`${source.name} could not run: ${source.detail}`);
  }

  /* ---- Review the changed lines ---- */

  const collector = new CommentCollector();

  if (git) addGitComments(git, collector);

  const reviewable = entries
    .filter(
      (entry) =>
        entry.status !== "deleted" &&
        !entry.binary &&
        REVIEWABLE_EXTENSIONS.has(path.posix.extname(entry.path)) &&
        !isNoise(entry.path) &&
        diffs.has(entry.path),
    )
    .slice(0, MAX_REVIEWED_FILES);

  if (entries.filter((entry) => REVIEWABLE_EXTENSIONS.has(path.posix.extname(entry.path))).length > MAX_REVIEWED_FILES) {
    warn(`Only the first ${MAX_REVIEWED_FILES} changed code files were reviewed line by line.`);
  }

  for (const entry of reviewable) {
    const text = await showFile(root, headCommit, entry.path);
    if (text === undefined || text.length > MAX_SOURCE_BYTES) continue;

    try {
      reviewSource(entry.path, text, diffs.get(entry.path)!, collector);
    } catch {
      warn(`Could not parse ${entry.path} for the line-by-line review.`);
    }
  }

  const dependencies = await reviewDependencies(root, mergeBase, headCommit, entries, diffs, collector);

  if (api) addApiComments(api, collector);
  if (impact) addTestComments(impact, diffs, collector);

  /* ---- Pull-request-level checks ---- */

  const merge = await checkMergeable(root, mergeBase, baseCommit, headCommit);
  if (merge.mergeable === null) warn("Git could not check whether the branch merges cleanly.");

  if (merge.mergeable === false) {
    collector.add({
      severity: "blocker",
      category: "history",
      source: "pr",
      rule: "merge-conflict",
      title: `Merge conflicts with ${baseRef}`,
      message: `Conflicting files: ${merge.files.join(", ") || "see git for details"}.`,
      suggestion: `Rebase or merge ${baseRef} into the branch and resolve the conflicts.`,
    });
  }

  if (size.label === "XL" || size.label === "L") {
    collector.add({
      severity: size.label === "XL" ? "major" : "minor",
      category: "maintainability",
      source: "pr",
      rule: "pr-size",
      title: `${size.label === "XL" ? "Very large" : "Large"} pull request (${size.lines} lines)`,
      message: "Big pull requests get shallow reviews, and bugs slip through.",
      suggestion: "Split it into smaller pull requests that each do one thing.",
    });
  }

  if (behind > 20) {
    collector.add({
      severity: "nit",
      category: "history",
      source: "pr",
      rule: "behind-base",
      title: `Branch is ${plural(behind, "commit")} behind ${baseRef}`,
      message: "The longer a branch drifts, the harder the final merge.",
      suggestion: `Rebase onto ${baseRef} to catch conflicts early.`,
    });
  }

  const testFilesChanged = entries.some((entry) => fileKind(entry.path) === "test");
  const sourceAdded = entries
    .filter((entry) => fileKind(entry.path) === "source")
    .reduce((sum, entry) => sum + entry.additions, 0);

  if (!impact && !testFilesChanged && sourceAdded > 100) {
    collector.add({
      severity: "major",
      category: "testing",
      source: "pr",
      rule: "no-test-changes",
      title: "Source code changed with no test changes",
      message: `${sourceAdded} lines of source were added and no test file was touched.`,
      suggestion: "Add or update tests for the new behavior.",
    });
  }

  const docsChanged = entries.some((entry) => fileKind(entry.path) === "docs");
  const breakingBlocking = (api?.changes ?? []).some(
    (change) => change.breaking && (change.severity === "critical" || change.severity === "high"),
  );

  if (breakingBlocking && !docsChanged) {
    collector.add({
      severity: "minor",
      category: "docs",
      source: "pr",
      rule: "breaking-docs",
      title: "Breaking change without a documentation update",
      message: "Consumers will not know what changed or how to migrate.",
      suggestion: "Update the README or changelog and describe the migration.",
    });
  }

  if (collector.truncated) warn(`Showing the first ${MAX_COMMENTS} review comments.`);

  const comments = collector.sorted();

  /* ---- Reviewers ---- */

  const changedPaths = entries.filter((entry) => entry.status !== "deleted").map((entry) => entry.path);
  const authorEmails = new Set((git?.commits ?? []).map((commit) => commit.email.toLowerCase()));
  const authorNames = [...new Set((git?.commits ?? []).map((commit) => commit.author))].slice(0, 8);

  const [suggested, owners] = await Promise.all([
    suggestReviewers(root, mergeBase, changedPaths, authorEmails),
    Promise.resolve(codeOwnerGroups(loadCodeOwners(root), changedPaths)),
  ]);

  /* ---- Verdict and text ---- */

  const counts = countBy(
    comments.map((comment) => comment.severity),
    SEVERITY_ORDER,
  );
  const categoryCounts = countBy(
    comments.map((comment) => comment.category),
    CATEGORY_LIST,
  );

  const checklist = buildChecklist({
    comments,
    mergeable: merge.mergeable,
    conflictFiles: merge.files,
    behind,
    size,
    testsRan: Boolean(impact),
    gaps: impact?.coverageGaps.length ?? 0,
    impacted: impact?.impactedTestCount ?? 0,
    apiRan: Boolean(api),
    apiBreaking: api?.breakingChanges ?? 0,
    dependenciesChanged: dependencies.added.length + dependencies.upgraded.length,
    docsChanged,
  });

  const verdict = decide(counts, strictness, merge.mergeable, comments);

  const perFile = new Map<string, number>();
  for (const comment of comments) {
    if (comment.filePath) perFile.set(comment.filePath, (perFile.get(comment.filePath) ?? 0) + 1);
  }

  const files: ReviewedFile[] = [...entries]
    .sort(
      (a, b) =>
        (perFile.get(b.path) ?? 0) - (perFile.get(a.path) ?? 0) ||
        b.additions + b.deletions - (a.additions + a.deletions) ||
        a.path.localeCompare(b.path),
    )
    .slice(0, MAX_LISTED_FILES)
    .map((entry) => ({
      path: entry.path,
      status: entry.status,
      kind: fileKind(entry.path),
      additions: entry.additions,
      deletions: entry.deletions,
      comments: perFile.get(entry.path) ?? 0,
    }));

  const reviewers = { suggested, codeOwners: owners.slice(0, 8) };
  const pr = {
    base: { ref: baseRef, commit: baseCommit.slice(0, 10) },
    head: { ref: headRef, commit: headCommit.slice(0, 10) },
    mergeBase: mergeBase.slice(0, 10),
    branch,
    ahead,
    behind,
    mergeable: merge.mergeable,
    conflictFiles: merge.files,
    authors: authorNames,
    title: git?.pullRequest.title ?? `Changes from ${branch}`,
    description:
      git?.pullRequest.markdown ??
      `## Summary\n\n${plural(ahead, "commit")} from ${branch}, ${plural(entries.length, "file")} changed.`,
    size,
  };

  return {
    success: true,
    tool: "review_pull_request",
    projectPath: root,
    strictness,
    pr,
    verdict,
    counts,
    categoryCounts,
    comments,
    checklist,
    reviewers,
    tests: {
      ran: Boolean(impact),
      impacted: impact?.impactedTestCount ?? 0,
      total: impact?.totalTests ?? 0,
      gaps: impact?.coverageGaps.length ?? 0,
      commands: (impact?.commands ?? []).slice(0, 3).map((command) => ({
        label: command.label,
        command: command.command,
      })),
    },
    api: { ran: Boolean(api), breaking: api?.breakingChanges ?? 0, bump: api?.recommendedBump },
    files,
    commits: (git?.commits ?? []).slice(0, MAX_LISTED_COMMITS).map((commit) => ({
      shortHash: commit.shortHash,
      subject: commit.subject,
      author: commit.author,
      risk: commit.risk,
      flags: commit.flags.map((flag) => flag.flag),
    })),
    reviewMarkdown: buildReviewMarkdown({ verdict, comments, checklist, reviewers, pr }),
    sources,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/*  MCP registration                                                          */
/* -------------------------------------------------------------------------- */

export function registerReviewPullRequestTool(server: McpServer) {
  server.registerTool(
    "review_pull_request",
    {
      description:
        "Review a branch against its base branch the way a careful reviewer would, using only local git. Combines the Git Change, Breaking API and Test Impact analyses with a line-by-line review of the changed JavaScript and TypeScript (security, bugs, performance, complexity), dependency changes, pull request size and commit hygiene. Returns a verdict (approve, approve with comments, request changes), a 0-100 readiness score, severity-ranked review comments with suggested fixes, a pass/warn/fail checklist, suggested reviewers from CODEOWNERS and git history, and a review summary and PR description ready to paste.",
      inputSchema: z.object({
        projectPath: z.string().describe("Absolute path to the project directory"),
        baseRef: z
          .string()
          .optional()
          .describe("Base branch the pull request targets. Default: the repository's main branch."),
        headRef: z
          .string()
          .optional()
          .describe("Branch with the changes. Default HEAD (the checked-out branch)."),
        strictness: z
          .enum(["relaxed", "normal", "strict"])
          .optional()
          .describe("How readily the verdict asks for changes. Default normal."),
        runTestImpact: z
          .boolean()
          .optional()
          .describe("Include test impact and coverage gaps. Needs the branch checked out. Default true."),
        runBreakingApi: z
          .boolean()
          .optional()
          .describe("Include the breaking API change check. Default true."),
      }),
    },
    async ({ projectPath, baseRef, headRef, strictness, runTestImpact, runBreakingApi }) => {
      try {
        const report = await reviewPullRequest(projectPath, {
          baseRef,
          headRef,
          strictness,
          runTestImpact,
          runBreakingApi,
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
                  tool: "review_pull_request",
                  error: error instanceof Error ? error.message : "Failed to review the pull request.",
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
