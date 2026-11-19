import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import ts from "typescript";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveProjectPath } from "../utils/projectResolver.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

type ContextMode = "task" | "focus" | "orientation";
type FileKind = "source" | "test";
type IncludedAs = "full" | "outline" | "listed" | "omitted";
type Confidence = "high" | "medium" | "low";
type DetailLevel = "auto" | "outline";

interface ContextFile {
  path: string;
  area: string;
  kind: FileKind;
  lines: number;
  score: number;
  relevance: number;
  centrality: number;
  proximity: number;
  recency: number;
  reasons: string[];
  exports: string[];
  imports: string[];
  importedBy: string[];
  importCount: number;
  importedByCount: number;
  includedAs: IncludedAs;
  tokens: { full: number; outline: number };
  doc?: string;
  isEntry: boolean;
  /** Exactly what the context pack contains for this file (secrets removed). */
  content?: string;
}

interface AreaInfo {
  area: string;
  role: string;
  files: number;
  lines: number;
  dependsOn: string[];
  usedBy: string[];
  topFiles: string[];
}

interface Convention {
  id: string;
  label: string;
  value: string;
  evidence: string;
  confidence: Confidence;
}

interface FrameworkInfo {
  name: string;
  category: string;
}

interface ProjectProfile {
  name: string;
  description?: string;
  packageManager: string;
  languages: Array<{ language: string; files: number; lines: number }>;
  frameworks: FrameworkInfo[];
  testRunner?: string;
  scripts: Array<{ name: string; command: string }>;
  entryPoints: string[];
  packages: Array<{ name: string; dir: string }>;
  totalFiles: number;
  totalLines: number;
  readmeSummary?: string;
}

interface RecentChange {
  hash: string;
  subject: string;
  date: string;
  files: string[];
}

interface ContextReport {
  success: boolean;
  tool: "build_codebase_context";
  projectPath: string;
  mode: ContextMode;
  task?: string;
  focusFiles: string[];
  queryTerms: string[];
  matchedTerms: string[];
  tokens: {
    budget: number;
    used: number;
    overview: number;
    files: number;
    remaining: number;
  };
  project: ProjectProfile;
  areas: AreaInfo[];
  areaLinks: Array<{ from: string; to: string; count: number }>;
  conventions: Convention[];
  files: ContextFile[];
  includedCount: number;
  omittedCount: number;
  recentChanges: RecentChange[];
  contextMarkdown: string;
  guideMarkdown: string;
  redactions: number;
  warnings: string[];
}

/* ---- Internal ---- */

interface ImportInfo {
  spec: string;
  names: string[];
  typeOnly: boolean;
}

interface FileFacts {
  path: string;
  ext: string;
  kind: FileKind;
  area: string;
  lines: number;
  bytes: number;
  exports: string[];
  importInfos: ImportInfo[];
  doc: string;
  hasJsx: boolean;
  routes: string[];
  words: Map<string, number>;
  isEntry: boolean;
  /** Style counters used to infer conventions. */
  style: {
    defaultExports: number;
    namedExports: number;
    jsExtensionImports: number;
    bareRelativeImports: number;
    aliasImports: number;
    typeImports: number;
    functionComponents: number;
    arrowComponents: number;
    classComponents: number;
    thenCalls: number;
    awaits: number;
    doubleQuotes: number;
    singleQuotes: number;
    semicolons: number;
    noSemicolons: number;
    indentTwo: number;
    indentFour: number;
    indentTab: number;
  };
}

interface PathPattern {
  prefix: string;
  suffix: string;
  wildcard: boolean;
  targets: string[];
}

interface PathConfig {
  dir: string;
  baseUrl?: string;
  paths: PathPattern[];
  strict?: boolean;
  target?: string;
  moduleKind?: string;
}

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript (React)",
  ".mts": "TypeScript",
  ".cts": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript (React)",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".rb": "Ruby",
  ".php": "PHP",
  ".cs": "C#",
  ".swift": "Swift",
  ".css": "CSS",
  ".scss": "SCSS",
  ".html": "HTML",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".sql": "SQL",
};

const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "out",
  "storybook-static",
  "playwright-report",
  "test-results",
  "generated-diagrams",
  "vendor",
  "target",
  "__pycache__",
]);

const SENSITIVE_FILE_PATTERN =
  /(^|\/)(\.env(\.(?!example|sample|template)[^/]*)?|id_rsa|id_dsa|id_ed25519|[^/]*\.(pem|p12|pfx|key|keystore|jks)|[^/]*service[-_]?account[^/]*\.json|credentials(\.json)?|\.npmrc|\.netrc)$/i;

const TEST_NAME_PATTERN = /\.(test|spec|cy|e2e)\.[cm]?[jt]sx?$/;
const TEST_DIR_PATTERN = /(^|\/)(__tests__|e2e|cypress|playwright)\//;

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

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

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "are", "was", "will", "can", "all",
  "any", "not", "but", "you", "your", "our", "has", "have", "had", "its", "into", "than",
  "then", "them", "they", "out", "use", "uses", "used", "using", "new", "add", "make",
  "should", "would", "could", "how", "what", "when", "where", "why", "which", "also",
  "const", "let", "var", "function", "return", "import", "export", "default", "async",
  "await", "type", "interface", "class", "extends", "implements", "true", "false", "null",
  "undefined", "string", "number", "boolean", "void", "any", "unknown", "never", "get",
  "set", "props", "key", "value", "index", "item", "data", "args", "arg", "err", "error",
  "res", "req", "src", "obj", "tmp", "ret", "result", "results", "name", "names", "file",
  "files", "path", "paths", "text", "line", "lines", "node", "nodes", "list", "map", "fn",
  "need", "needs", "want", "please", "implement", "feature", "code", "change", "update",
  "fix", "bug", "issue", "work", "works", "like", "just", "about", "some", "more",
  "does", "did", "doing", "done", "why", "there", "here", "makes", "show", "shows", "find",
  "see", "look", "looking", "understand", "explain", "returns", "getting", "being", "been",
]);

const MAX_FILES = 6_000;
const MAX_PARSE_BYTES = 400_000;
const MAX_RETURNED_FILES = 60;
const MAX_CONTENT_CHARS = 60_000;
const MAX_WARNINGS = 25;
const MAX_IDENTIFIER_WORDS = 400;

const MIN_BUDGET = 1_000;
const MAX_BUDGET = 100_000;
const DEFAULT_BUDGET = 8_000;

const GIT_TIMEOUT_MS = 30_000;

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function validateRelative(value: string, label: string): string {
  const cleaned = normalizePath(value.trim());

  if (!cleaned || path.isAbsolute(cleaned) || cleaned.split("/").includes("..")) {
    throw new Error(`${label} must contain relative paths inside the project.`);
  }

  return cleaned;
}

function scriptKindFor(file: string): ts.ScriptKind {
  const extension = path.posix.extname(file);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function areaOf(file: string): string {
  const segments = file.split("/");
  if (segments.length === 1) return "(root)";
  if (AREA_PREFIXES.has(segments[0]) && segments.length > 2) return `${segments[0]}/${segments[1]}`;
  return segments[0];
}

function stem(word: string): string {
  let value = word.toLowerCase();

  if (value.length > 5 && value.endsWith("ing")) value = value.slice(0, -3);
  else if (value.length > 4 && value.endsWith("ed")) value = value.slice(0, -2);
  else if (value.length > 4 && value.endsWith("ies")) value = `${value.slice(0, -3)}y`;
  else if (value.length > 4 && value.endsWith("s") && !value.endsWith("ss")) value = value.slice(0, -1);

  if (value.length > 4 && value.endsWith("e")) value = value.slice(0, -1);
  return value;
}

function splitWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word) && !/^\d+$/.test(word))
    .map(stem);
}

function addWords(words: Map<string, number>, text: string, weight: number) {
  for (const word of splitWords(text)) {
    words.set(word, (words.get(word) ?? 0) + weight);
  }
}

/* -------------------------------------------------------------------------- */
/*  Keeping secrets out of the context                                        */
/* -------------------------------------------------------------------------- */

const REDACTION_PATTERNS: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

const ASSIGNMENT_PATTERN =
  /(\b(?:api[_-]?key|secret|token|passwd|password|private[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*["'])([^"'\s]{12,})(["'])/gi;

const PLACEHOLDER_PATTERN =
  /^(process\.|import\.meta|<|your|example|changeme|xxx|\*{3,}|placeholder|dummy|sample|fake)|\$\{/i;

function redact(text: string): { text: string; count: number } {
  let count = 0;
  let output = text;

  for (const pattern of REDACTION_PATTERNS) {
    output = output.replace(pattern, () => {
      count++;
      return "[REDACTED]";
    });
  }

  output = output.replace(ASSIGNMENT_PATTERN, (match, before: string, value: string, after: string) => {
    if (PLACEHOLDER_PATTERN.test(value)) return match;
    count++;
    return `${before}[REDACTED]${after}`;
  });

  return { text: output, count };
}

/* -------------------------------------------------------------------------- */
/*  Reading the project                                                       */
/* -------------------------------------------------------------------------- */

interface Discovered {
  codeFiles: string[];
  languageStats: Map<string, { files: number; lines: number }>;
  packageJsons: string[];
  tsconfigs: string[];
  configNames: Set<string>;
  truncated: boolean;
}

function discoverProject(root: string): Discovered {
  const codeFiles: string[] = [];
  const languageStats = new Map<string, { files: number; lines: number }>();
  const packageJsons: string[] = [];
  const tsconfigs: string[] = [];
  const configNames = new Set<string>();
  let truncated = false;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !IGNORED_DIRS.has(entry.name)) {
          stack.push({ dir: absolute, depth: depth + 1 });
        }
        continue;
      }

      if (!entry.isFile()) continue;

      const rel = normalizePath(path.relative(root, absolute));

      if (entry.name === "package.json" && depth <= 3) packageJsons.push(rel);
      if (entry.name === "tsconfig.json" || entry.name === "jsconfig.json") tsconfigs.push(rel);

      if (
        /^(\.prettierrc|\.eslintrc|eslint\.config|prettier\.config|vite\.config|vitest\.config|jest\.config|playwright\.config|cypress\.config|tailwind\.config|next\.config|\.editorconfig)/.test(
          entry.name,
        ) ||
        ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "package-lock.json", "Dockerfile", "docker-compose.yml"].includes(
          entry.name,
        )
      ) {
        configNames.add(entry.name);
      }

      if (SENSITIVE_FILE_PATTERN.test(rel)) continue;

      const extension = path.posix.extname(entry.name).toLowerCase();
      const language = LANGUAGE_BY_EXTENSION[extension];
      if (!language) continue;

      let lineCount = 0;
      try {
        const stat = fs.statSync(absolute);
        lineCount = Math.max(1, Math.round(stat.size / 38));
      } catch {
        continue;
      }

      const stats = languageStats.get(language) ?? { files: 0, lines: 0 };
      stats.files++;
      // Code files are counted exactly after parsing; other languages are estimated from size.
      if (!CODE_EXTENSIONS.has(extension)) stats.lines += lineCount;
      languageStats.set(language, stats);

      if (CODE_EXTENSIONS.has(extension) && !entry.name.endsWith(".d.ts")) {
        if (codeFiles.length >= MAX_FILES) {
          truncated = true;
          continue;
        }
        codeFiles.push(rel);
      }
    }
  }

  codeFiles.sort();
  return { codeFiles, languageStats, packageJsons, tsconfigs, configNames, truncated };
}

/* -------------------------------------------------------------------------- */
/*  Parsing one file                                                          */
/* -------------------------------------------------------------------------- */

function emptyStyle(): FileFacts["style"] {
  return {
    defaultExports: 0,
    namedExports: 0,
    jsExtensionImports: 0,
    bareRelativeImports: 0,
    aliasImports: 0,
    typeImports: 0,
    functionComponents: 0,
    arrowComponents: 0,
    classComponents: 0,
    thenCalls: 0,
    awaits: 0,
    doubleQuotes: 0,
    singleQuotes: 0,
    semicolons: 0,
    noSemicolons: 0,
    indentTwo: 0,
    indentFour: 0,
    indentTab: 0,
  };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
    : false;
}

function leadingDoc(text: string): string {
  const ranges = ts.getLeadingCommentRanges(text, 0) ?? [];

  for (const range of ranges) {
    const raw = text.slice(range.pos, range.end);
    if (/copyright|license|eslint-disable|@ts-|use strict/i.test(raw)) continue;

    const cleaned = raw
      .replace(/^\/\*+|\*+\/$/g, "")
      .split("\n")
      .map((line) => line.replace(/^\s*(\/\/+|\*+)\s?/, "").trim())
      .filter((line) => line && !line.startsWith("@"))
      .join(" ")
      .trim();

    if (cleaned.length >= 12) return cleaned.slice(0, 200);
  }

  return "";
}

function isComponentName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

function containsJsx(node: ts.Node): boolean {
  let found = false;

  const visit = (child: ts.Node) => {
    if (found) return;
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };

  visit(node);
  return found;
}

function parseFacts(rel: string, text: string, isEntryHint: (rel: string) => boolean): FileFacts {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKindFor(rel));
  const lines = text.split("\n");
  const style = emptyStyle();
  const words = new Map<string, number>();
  const exports: string[] = [];
  const importInfos: ImportInfo[] = [];
  const routes: string[] = [];
  let hasJsx = false;
  let identifierWords = 0;

  const kind: FileKind = TEST_NAME_PATTERN.test(rel) || TEST_DIR_PATTERN.test(rel) ? "test" : "source";

  const doc = leadingDoc(text);

  addWords(words, rel.replace(/\.[^.]+$/, ""), 3);
  if (doc) addWords(words, doc, 1.5);

  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const spec = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      const names: string[] = [];
      const typeOnly = Boolean(clause?.isTypeOnly);

      if (clause?.name) names.push("default");
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) names.push("*");
        else for (const element of clause.namedBindings.elements) names.push(element.propertyName?.text ?? element.name.text);
      }

      importInfos.push({ spec, names, typeOnly });

      if (typeOnly) style.typeImports++;
      if (spec.startsWith(".")) {
        if (/\.[cm]?jsx?$/.test(spec)) style.jsExtensionImports++;
        else if (!/\.[a-z]+$/.test(path.posix.basename(spec))) style.bareRelativeImports++;
      } else if (/^[@~]\//.test(spec)) {
        style.aliasImports++;
      }

      if (!spec.startsWith(".")) addWords(words, spec.replace(/^@/, ""), 0.7);
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      importInfos.push({ spec: statement.moduleSpecifier.text, names: ["*"], typeOnly: Boolean(statement.isTypeOnly) });

      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) exports.push(element.name.text);
      }
    }

    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);

    if (exported) {
      if (isDefault) style.defaultExports++;
      else style.namedExports++;

      if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
        const name = isDefault ? (statement.name?.text ?? "default") : (statement.name?.text ?? "default");
        exports.push(isDefault ? "default" : name);
        if (statement.name) addWords(words, statement.name.text, 3);

        if (statement.name && isComponentName(statement.name.text) && containsJsx(statement)) {
          if (ts.isClassDeclaration(statement)) style.classComponents++;
          else style.functionComponents++;
        }
      } else if (
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)
      ) {
        exports.push(statement.name.text);
        addWords(words, statement.name.text, 3);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) continue;
          exports.push(declaration.name.text);
          addWords(words, declaration.name.text, 3);

          if (
            isComponentName(declaration.name.text) &&
            declaration.initializer &&
            (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) &&
            containsJsx(declaration.initializer)
          ) {
            style.arrowComponents++;
          }
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      style.defaultExports++;
      exports.push("default");
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        exports.push(element.name.text);
        addWords(words, element.name.text, 3);
        style.namedExports++;
      }
    }

    if (
      ts.isImportDeclaration(statement) ||
      ts.isVariableStatement(statement) ||
      ts.isExpressionStatement(statement) ||
      ts.isReturnStatement(statement) ||
      ts.isExportAssignment(statement)
    ) {
      const source = statement.getText(sf).trimEnd();
      if (source.endsWith(";")) style.semicolons++;
      else if (source.endsWith("}") || source.endsWith(")") || /["'`\w]$/.test(source)) style.noSemicolons++;
    }
  }

  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) hasJsx = true;

    if (ts.isIdentifier(node) && identifierWords < MAX_IDENTIFIER_WORDS) {
      addWords(words, node.text, 0.3);
      identifierWords++;
    }

    if (ts.isAwaitExpression(node)) style.awaits++;

    if (ts.isStringLiteral(node) && style.doubleQuotes + style.singleQuotes < 300) {
      const first = text[node.getStart(sf)];
      if (first === '"') style.doubleQuotes++;
      else if (first === "'") style.singleQuotes++;
    }

    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (method === "then") style.thenCalls++;

        if (
          ["get", "post", "put", "patch", "delete", "all"].includes(method) &&
          node.arguments.length >= 2 &&
          ts.isStringLiteral(node.arguments[0]) &&
          node.arguments[0].text.startsWith("/") &&
          routes.length < 40
        ) {
          const route = `${method.toUpperCase()} ${node.arguments[0].text}`;
          routes.push(route);
          addWords(words, node.arguments[0].text, 2);
        }
      }

      if (ts.isIdentifier(node.expression) && node.expression.text === "require" && ts.isStringLiteral(node.arguments[0] ?? node)) {
        importInfos.push({ spec: (node.arguments[0] as ts.StringLiteral).text, names: ["*"], typeOnly: false });
      }

      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0] ?? node)) {
        importInfos.push({ spec: (node.arguments[0] as ts.StringLiteral).text, names: ["*"], typeOnly: false });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);

  for (const line of lines.slice(0, 600)) {
    if (/^\t+\S/.test(line)) style.indentTab++;
    else if (/^ {2}\S/.test(line)) style.indentTwo++;
    else if (/^ {4}\S/.test(line)) style.indentFour++;
  }

  return {
    path: rel,
    ext: path.posix.extname(rel),
    kind,
    area: areaOf(rel),
    lines: lines.length,
    bytes: text.length,
    exports: [...new Set(exports)],
    importInfos,
    doc,
    hasJsx,
    routes,
    words,
    isEntry: isEntryHint(rel),
    style,
  };
}

/* -------------------------------------------------------------------------- */
/*  Outlines: signatures without bodies                                       */
/* -------------------------------------------------------------------------- */

function headerOf(node: ts.Node, body: ts.Node | undefined, sf: ts.SourceFile): string {
  const start = node.getStart(sf);
  const end = body ? body.getStart(sf) : node.getEnd();
  return sf.text.slice(start, end).replace(/\s+/g, " ").trim().replace(/\s*=>$/, " =>").replace(/\{$/, "").trim();
}

function shortDoc(node: ts.Node, sf: ts.SourceFile): string {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? [];
  const last = ranges[ranges.length - 1];
  if (!last) return "";

  const cleaned = sf.text
    .slice(last.pos, last.end)
    .replace(/^\/\*+|\*+\/$/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(\/\/+|\*+)\s?/, "").trim())
    .filter((line) => line && !line.startsWith("@"))[0];

  return cleaned ? cleaned.slice(0, 140) : "";
}

function clipBlock(text: string, maxLines: number, summary: string): string {
  const lines = text.split("\n");
  return lines.length <= maxLines ? text : `${lines.slice(0, 1).join("\n")} { ${summary} }`;
}

/** Keeps one big file from using the whole budget; says how much was left out. */
function capOutline(outline: string, maxTokens: number): string {
  if (estimateTokens(outline) <= maxTokens) return outline;

  const lines = outline.split("\n");
  const kept: string[] = [];
  let chars = 0;

  for (const line of lines) {
    if (chars + line.length + 1 > maxTokens * 4) break;
    kept.push(line);
    chars += line.length + 1;
  }

  return `${kept.join("\n")}\n// ... ${plural(lines.length - kept.length, "more line")} of this outline not shown`;
}

function outlineOf(rel: string, text: string): string {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKindFor(rel));
  const out: string[] = [];

  const imports = new Set<string>();
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.add(statement.moduleSpecifier.text);
    }
  }
  if (imports.size > 0) out.push(`// imports: ${[...imports].slice(0, 14).join(", ")}${imports.size > 14 ? ", ..." : ""}`);

  const note = (node: ts.Node) => {
    const doc = shortDoc(node, sf);
    if (doc) out.push(`// ${doc}`);
  };

  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) || ts.isEmptyStatement(statement)) continue;

    if (ts.isFunctionDeclaration(statement)) {
      note(statement);
      out.push(`${headerOf(statement, statement.body, sf)};`);
    } else if (ts.isClassDeclaration(statement)) {
      note(statement);
      const header = headerOf(statement, undefined, sf).replace(/\{[\s\S]*$/, "").trim();
      const members: string[] = [];

      for (const member of statement.members) {
        if (hasModifier(member, ts.SyntaxKind.PrivateKeyword)) continue;
        if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
          members.push(`  ${headerOf(member, member.body, sf)};`);
        } else if (ts.isPropertyDeclaration(member)) {
          members.push(`  ${headerOf(member, member.initializer, sf).replace(/\s*=$/, "")};`);
        }
      }

      out.push(`${header} {`, ...members.slice(0, 40), ...(members.length > 40 ? [`  // ... ${members.length - 40} more members`] : []), "}");
    } else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      note(statement);
      const raw = statement.getText(sf);
      out.push(clipBlock(raw, 14, "..."));
    } else if (ts.isEnumDeclaration(statement)) {
      note(statement);
      const raw = statement.getText(sf);
      out.push(clipBlock(raw, 14, statement.members.map((member) => member.name.getText(sf)).slice(0, 12).join(", ")));
    } else if (ts.isVariableStatement(statement)) {
      note(statement);
      const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword) ? "export " : "";

      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(sf);
        const init = declaration.initializer;

        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          const header = `${sf.text.slice(declaration.getStart(sf), init.body.getStart(sf)).replace(/\s+/g, " ").trim()}`;
          out.push(`${exported}const ${header.replace(/\{$/, "").trim()};`);
        } else {
          const type = declaration.type ? `: ${declaration.type.getText(sf).replace(/\s+/g, " ")}` : "";
          const value = init && !declaration.type ? ` = ${init.getText(sf).replace(/\s+/g, " ").slice(0, 70)}${init.getText(sf).length > 70 ? "..." : ""}` : "";
          out.push(`${exported}const ${name}${type}${value};`);
        }
      }
    } else if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) {
      out.push(statement.getText(sf).replace(/\s+/g, " "));
    } else if (ts.isExpressionStatement(statement)) {
      // Routes and other top-level calls tell a reader what the module does.
      const expression = statement.expression;
      if (
        ts.isCallExpression(expression) &&
        ts.isPropertyAccessExpression(expression.expression) &&
        ["get", "post", "put", "patch", "delete", "use", "all", "listen"].includes(expression.expression.name.text) &&
        expression.arguments.length > 0
      ) {
        const first = expression.arguments[0];
        out.push(
          ts.isStringLiteral(first)
            ? `// route: ${expression.expression.name.text.toUpperCase()} ${first.text}`
            : `// call: ${expression.expression.getText(sf)}(...)`,
        );
      }
    }
  }

  return out.join("\n");
}

/* -------------------------------------------------------------------------- */
/*  Path aliases and import resolution                                        */
/* -------------------------------------------------------------------------- */

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const parsed = ts.readConfigFile(file, ts.sys.readFile);
    if (parsed.error || typeof parsed.config !== "object") return undefined;
    return parsed.config as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function loadPathConfigs(root: string, tsconfigs: string[]): Map<string, PathConfig> {
  const configs = new Map<string, PathConfig>();

  for (const rel of tsconfigs) {
    const absolute = path.join(root, rel);
    const seen = new Set<string>();
    let current: string | undefined = absolute;
    let baseUrl: string | undefined;
    let paths: Record<string, string[]> | undefined;
    let strict: boolean | undefined;
    let target: string | undefined;
    let moduleKind: string | undefined;
    let baseUrlDir = path.dirname(absolute);
    let pathsDir = path.dirname(absolute);

    for (let depth = 0; current && depth < 4 && !seen.has(current); depth++) {
      seen.add(current);
      const json = readJson(current);
      if (!json) break;

      const options = (json.compilerOptions ?? {}) as {
        baseUrl?: string;
        paths?: Record<string, string[]>;
        strict?: boolean;
        target?: string;
        module?: string;
      };

      if (baseUrl === undefined && typeof options.baseUrl === "string") {
        baseUrl = options.baseUrl;
        baseUrlDir = path.dirname(current);
      }
      if (paths === undefined && options.paths) {
        paths = options.paths;
        pathsDir = path.dirname(current);
      }
      if (strict === undefined && typeof options.strict === "boolean") strict = options.strict;
      if (target === undefined && typeof options.target === "string") target = options.target;
      if (moduleKind === undefined && typeof options.module === "string") moduleKind = options.module;

      const parent: unknown = json.extends;
      if (typeof parent === "string" && parent.startsWith(".")) {
        const next = path.resolve(path.dirname(current), parent);
        current = fs.existsSync(next) ? next : fs.existsSync(`${next}.json`) ? `${next}.json` : undefined;
      } else {
        current = undefined;
      }
    }

    const dir = normalizePath(path.dirname(rel));
    const configDir = dir === "." ? "" : dir;
    const toRoot = (from: string, target2: string) =>
      normalizePath(path.relative(root, path.resolve(from, target2)));

    const patterns: PathPattern[] = [];
    for (const [key, targets] of Object.entries(paths ?? {})) {
      const star = key.indexOf("*");
      patterns.push({
        prefix: star === -1 ? key : key.slice(0, star),
        suffix: star === -1 ? "" : key.slice(star + 1),
        wildcard: star !== -1,
        targets: targets.map((value) =>
          baseUrl !== undefined
            ? toRoot(baseUrlDir, path.join(baseUrl, value))
            : toRoot(pathsDir, value),
        ),
      });
    }

    configs.set(configDir, {
      dir: configDir,
      baseUrl: baseUrl !== undefined ? toRoot(baseUrlDir, baseUrl) : undefined,
      paths: patterns,
      strict,
      target,
      moduleKind,
    });
  }

  return configs;
}

function createResolver(fileSet: Set<string>, configs: Map<string, PathConfig>) {
  const tryFile = (base: string): string | undefined => {
    const stripped = base.replace(/\.[cm]?jsx?$/, "");
    const options = [
      base,
      ...RESOLVE_EXTENSIONS.map((extension) => `${stripped}${extension}`),
      ...RESOLVE_EXTENSIONS.map((extension) => `${base}${extension}`),
      ...RESOLVE_EXTENSIONS.map((extension) => `${base}/index${extension}`),
    ];
    return options.find((option) => fileSet.has(option));
  };

  const nearestConfig = (fromRel: string): PathConfig | undefined => {
    let dir = path.posix.dirname(fromRel);
    for (;;) {
      const key = dir === "." ? "" : dir;
      const found = configs.get(key);
      if (found) return found;
      if (!key) return undefined;
      dir = path.posix.dirname(dir);
    }
  };

  return (fromRel: string, spec: string): string | undefined => {
    if (spec.startsWith(".")) {
      return tryFile(path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec)));
    }

    const config = nearestConfig(fromRel);

    if (config) {
      for (const pattern of config.paths) {
        const matches = pattern.wildcard
          ? spec.startsWith(pattern.prefix) &&
            spec.endsWith(pattern.suffix) &&
            spec.length >= pattern.prefix.length + pattern.suffix.length
          : spec === pattern.prefix;

        if (!matches) continue;

        const captured = pattern.wildcard
          ? spec.slice(pattern.prefix.length, spec.length - pattern.suffix.length)
          : "";

        for (const target of pattern.targets) {
          const resolved = tryFile(normalizePath(path.posix.normalize(target.replace("*", captured))));
          if (resolved) return resolved;
        }
      }

      if (config.baseUrl !== undefined) {
        const resolved = tryFile(path.posix.normalize(path.posix.join(config.baseUrl || ".", spec)));
        if (resolved) return resolved;
      }
    }

    if (spec.startsWith("@/") || spec.startsWith("~/")) {
      for (const base of new Set(["src", config?.dir ? path.posix.join(config.dir, "src") : "src"])) {
        const resolved = tryFile(path.posix.normalize(path.posix.join(base, spec.slice(2))));
        if (resolved) return resolved;
      }
    }

    return undefined;
  };
}

/* -------------------------------------------------------------------------- */
/*  Import graph and importance                                               */
/* -------------------------------------------------------------------------- */

interface Graph {
  outgoing: Map<string, Set<string>>;
  incoming: Map<string, Set<string>>;
  externalImports: Map<string, number>;
}

function buildGraph(
  facts: FileFacts[],
  resolve: (fromRel: string, spec: string) => string | undefined,
): Graph {
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  const externalImports = new Map<string, number>();

  for (const file of facts) {
    outgoing.set(file.path, outgoing.get(file.path) ?? new Set());

    for (const info of file.importInfos) {
      const target = resolve(file.path, info.spec);

      if (!target) {
        if (!info.spec.startsWith(".")) {
          const name = info.spec.startsWith("@")
            ? info.spec.split("/").slice(0, 2).join("/")
            : info.spec.split("/")[0];
          if (!name.startsWith("node:")) {
            externalImports.set(name, (externalImports.get(name) ?? 0) + 1);
          }
        }
        continue;
      }

      if (target === file.path) continue;

      outgoing.get(file.path)!.add(target);
      const set = incoming.get(target) ?? new Set<string>();
      set.add(file.path);
      incoming.set(target, set);
    }
  }

  return { outgoing, incoming, externalImports };
}

function pageRank(nodes: string[], graph: Graph): Map<string, number> {
  const nodeSet = new Set(nodes);
  const rank = new Map<string, number>();
  const count = Math.max(1, nodes.length);

  for (const node of nodes) rank.set(node, 1 / count);

  for (let iteration = 0; iteration < 25; iteration++) {
    const next = new Map<string, number>();
    let dangling = 0;

    for (const node of nodes) {
      const targets = [...(graph.outgoing.get(node) ?? [])].filter((target) => nodeSet.has(target));
      if (targets.length === 0) dangling += rank.get(node) ?? 0;
    }

    for (const node of nodes) next.set(node, (0.15 + 0.85 * dangling) / count);

    for (const node of nodes) {
      const targets = [...(graph.outgoing.get(node) ?? [])].filter((target) => nodeSet.has(target));
      if (targets.length === 0) continue;

      const share = (0.85 * (rank.get(node) ?? 0)) / targets.length;
      for (const target of targets) next.set(target, (next.get(target) ?? 0) + share);
    }

    for (const [node, value] of next) rank.set(node, value);
  }

  const max = Math.max(...rank.values(), 1e-9);
  const normalized = new Map<string, number>();
  for (const [node, value] of rank) normalized.set(node, value / max);
  return normalized;
}

/** Distance in imports from a set of seed files, in either direction. */
function proximityFrom(seeds: string[], graph: Graph, maxDepth = 2): Map<string, number> {
  const distance = new Map<string, number>();
  let frontier = seeds.filter((seed) => graph.outgoing.has(seed) || graph.incoming.has(seed));

  for (const seed of frontier) distance.set(seed, 0);

  for (let depth = 1; depth <= maxDepth; depth++) {
    const next: string[] = [];

    for (const file of frontier) {
      for (const neighbour of [...(graph.outgoing.get(file) ?? []), ...(graph.incoming.get(file) ?? [])]) {
        if (!distance.has(neighbour)) {
          distance.set(neighbour, depth);
          next.push(neighbour);
        }
      }
    }

    frontier = next;
  }

  return distance;
}

/* -------------------------------------------------------------------------- */
/*  Project profile                                                           */
/* -------------------------------------------------------------------------- */

const FRAMEWORKS: Array<[string, string, string]> = [
  ["react", "React", "Frontend"],
  ["next", "Next.js", "Frontend"],
  ["vue", "Vue", "Frontend"],
  ["svelte", "Svelte", "Frontend"],
  ["@angular/core", "Angular", "Frontend"],
  ["express", "Express", "Backend"],
  ["fastify", "Fastify", "Backend"],
  ["koa", "Koa", "Backend"],
  ["hono", "Hono", "Backend"],
  ["@nestjs/core", "NestJS", "Backend"],
  ["@modelcontextprotocol/sdk", "Model Context Protocol", "Backend"],
  ["@modelcontextprotocol/server", "Model Context Protocol", "Backend"],
  ["zod", "Zod", "Validation"],
  ["typescript", "TypeScript", "Language"],
  ["tailwindcss", "Tailwind CSS", "Styling"],
  ["styled-components", "styled-components", "Styling"],
  ["@prisma/client", "Prisma", "Data"],
  ["mongoose", "Mongoose", "Data"],
  ["firebase", "Firebase", "Data"],
  ["firebase-admin", "Firebase Admin", "Data"],
  ["pg", "PostgreSQL", "Data"],
  ["redux", "Redux", "State"],
  ["@reduxjs/toolkit", "Redux Toolkit", "State"],
  ["zustand", "Zustand", "State"],
  ["@tanstack/react-query", "React Query", "State"],
  ["axios", "Axios", "HTTP"],
  ["vite", "Vite", "Build"],
  ["webpack", "Webpack", "Build"],
  ["esbuild", "esbuild", "Build"],
  ["vitest", "Vitest", "Testing"],
  ["jest", "Jest", "Testing"],
  ["mocha", "Mocha", "Testing"],
  ["@playwright/test", "Playwright", "Testing"],
  ["cypress", "Cypress", "Testing"],
  ["@testing-library/react", "Testing Library", "Testing"],
  ["eslint", "ESLint", "Tooling"],
  ["prettier", "Prettier", "Tooling"],
  ["lucide-react", "Lucide icons", "UI"],
];

interface PackageInfo {
  dir: string;
  name: string;
  description?: string;
  scripts: Record<string, string>;
  deps: Set<string>;
  json: Record<string, unknown>;
}

function readPackage(root: string, rel: string): PackageInfo | undefined {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(root, rel), "utf8")) as Record<string, unknown>;
    const dir = normalizePath(path.dirname(rel));

    return {
      dir: dir === "." ? "" : dir,
      name: typeof json.name === "string" ? json.name : path.posix.basename(dir === "." ? "project" : dir),
      description: typeof json.description === "string" ? json.description : undefined,
      scripts: (json.scripts ?? {}) as Record<string, string>,
      deps: new Set([
        ...Object.keys((json.dependencies ?? {}) as object),
        ...Object.keys((json.devDependencies ?? {}) as object),
      ]),
      json,
    };
  } catch {
    return undefined;
  }
}

function collectStrings(value: unknown, into: string[]) {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into);
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, into);
}

function mapToSource(target: string, fileSet: Set<string>, base: string): string | undefined {
  const cleaned = normalizePath(target).replace(/^\.\//, "");
  if (!cleaned || cleaned.includes("*")) return undefined;

  const withoutExtension = cleaned.replace(/(\.d)?\.[cm]?[jt]sx?$/, "");
  const prefixed = (value: string) => (base ? `${base}/${value}` : value);
  const roots = new Set<string>([
    prefixed(withoutExtension),
    prefixed(withoutExtension.replace(/^(dist|build|lib|out|esm|cjs)\//, "")),
    prefixed(`src/${withoutExtension.replace(/^(dist|build|lib|out|esm|cjs)\//, "")}`),
  ]);

  for (const rootPath of roots) {
    for (const extension of RESOLVE_EXTENSIONS) {
      if (fileSet.has(`${rootPath}${extension}`)) return `${rootPath}${extension}`;
      if (fileSet.has(`${rootPath}/index${extension}`)) return `${rootPath}/index${extension}`;
    }
  }

  return undefined;
}

function detectEntryPoints(root: string, packages: PackageInfo[], fileSet: Set<string>): string[] {
  const entries = new Set<string>();

  for (const pkg of packages) {
    const strings: string[] = [];
    for (const field of ["main", "module", "bin", "exports"]) collectStrings(pkg.json[field], strings);

    for (const value of strings) {
      const mapped = mapToSource(value, fileSet, pkg.dir);
      if (mapped) entries.add(mapped);
    }

    // A Vite or similar app names its entry in index.html.
    try {
      const html = fs.readFileSync(path.join(root, pkg.dir, "index.html"), "utf8");
      const match = /<script[^>]+src=["']\/?([^"']+)["']/.exec(html);
      if (match) {
        const mapped = mapToSource(match[1], fileSet, pkg.dir) ?? (fileSet.has(path.posix.join(pkg.dir, match[1])) ? path.posix.join(pkg.dir, match[1]) : undefined);
        if (mapped) entries.add(mapped);
      }
    } catch {
      /* no index.html */
    }

    for (const name of ["src/main", "src/index", "src/server", "src/app", "src/App", "server", "app", "index", "main"]) {
      const candidate = mapToSource(name, fileSet, pkg.dir);
      if (candidate && candidate.split("/").length - (pkg.dir ? pkg.dir.split("/").length : 0) <= 2) {
        entries.add(candidate);
      }
    }
  }

  return [...entries].sort();
}

function buildProfile(
  root: string,
  discovered: Discovered,
  packages: PackageInfo[],
  totals: { files: number; lines: number },
  entryPoints: string[],
): ProjectProfile {
  const rootPackage = packages.find((pkg) => pkg.dir === "") ?? packages[0];
  const allDeps = new Set<string>();
  for (const pkg of packages) for (const dep of pkg.deps) allDeps.add(dep);

  const frameworks: FrameworkInfo[] = [];
  const seen = new Set<string>();
  for (const [dependency, name, category] of FRAMEWORKS) {
    if (allDeps.has(dependency) && !seen.has(name)) {
      seen.add(name);
      frameworks.push({ name, category });
    }
  }

  const script = Object.values(rootPackage?.scripts ?? {}).join(" ");
  let testRunner: string | undefined;
  if (allDeps.has("vitest") || /vitest/.test(script)) testRunner = "Vitest";
  else if (allDeps.has("jest") || /\bjest\b/.test(script)) testRunner = "Jest";
  else if (allDeps.has("mocha")) testRunner = "Mocha";
  else if (allDeps.has("@playwright/test")) testRunner = "Playwright";
  else if (allDeps.has("cypress")) testRunner = "Cypress";

  const names = discovered.configNames;
  const packageManager = names.has("pnpm-lock.yaml")
    ? "pnpm"
    : names.has("yarn.lock")
      ? "yarn"
      : names.has("bun.lockb") || names.has("bun.lock")
        ? "bun"
        : "npm";

  const scripts: Array<{ name: string; command: string }> = [];
  const priority = ["dev", "start", "build", "test", "lint", "typecheck", "format", "preview"];

  for (const pkg of packages.slice(0, 4)) {
    const prefix = pkg.dir ? `${pkg.dir}: ` : "";
    const names2 = Object.keys(pkg.scripts).sort(
      (a, b) =>
        (priority.indexOf(a) === -1 ? 99 : priority.indexOf(a)) -
          (priority.indexOf(b) === -1 ? 99 : priority.indexOf(b)) || a.localeCompare(b),
    );

    for (const name of names2.slice(0, 8)) {
      scripts.push({ name: `${prefix}${name}`, command: pkg.scripts[name].slice(0, 140) });
    }
  }

  let readmeSummary: string | undefined;
  for (const candidate of ["README.md", "readme.md", "Readme.md"]) {
    try {
      const text = fs.readFileSync(path.join(root, candidate), "utf8");
      const paragraphs = text
        .split(/\n\s*\n/)
        .map((block) => block.replace(/[#>*`_]/g, "").replace(/\s+/g, " ").trim())
        .filter((block) => block.length > 40 && !/^(\[!\[|!\[|<)/.test(block));
      if (paragraphs[0]) readmeSummary = redact(paragraphs[0].slice(0, 280)).text;
      break;
    } catch {
      /* try the next name */
    }
  }

  const languages = [...discovered.languageStats.entries()]
    .map(([language, stats]) => ({ language, files: stats.files, lines: stats.lines }))
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 6);

  return {
    name: rootPackage?.name ?? path.basename(root),
    description: rootPackage?.description,
    packageManager,
    languages,
    frameworks,
    testRunner,
    scripts,
    entryPoints: entryPoints.slice(0, 8),
    packages: packages
      .filter((pkg) => pkg.dir !== "")
      .map((pkg) => ({ name: pkg.name, dir: pkg.dir }))
      .slice(0, 12),
    totalFiles: totals.files,
    totalLines: totals.lines,
    readmeSummary,
  };
}

/* -------------------------------------------------------------------------- */
/*  Areas and conventions                                                     */
/* -------------------------------------------------------------------------- */

const ROLE_BY_NAME: Array<[RegExp, string]> = [
  [/(^|\/)(auth|authentication|login|session|sessions|security)(\/|$)/, "Authentication and sessions"],
  [/(^|\/)(components?|ui)(\/|$)/, "UI components"],
  [/(^|\/)(pages?|views?|screens?)(\/|$)/, "Pages and views"],
  [/(^|\/)(routes?|api|controllers?|handlers?|endpoints?)(\/|$)/, "API routes and handlers"],
  [/(^|\/)(services?)(\/|$)/, "Services and business logic"],
  [/(^|\/)(models?|schemas?|entities)(\/|$)/, "Data models"],
  [/(^|\/)(store|state|reducers?|slices?)(\/|$)/, "State management"],
  [/(^|\/)hooks?(\/|$)/, "React hooks"],
  [/(^|\/)(utils?|helpers?|lib|common|shared)(\/|$)/, "Shared utilities"],
  [/(^|\/)(types?|typings)(\/|$)/, "Type definitions"],
  [/(^|\/)(config|settings)(\/|$)/, "Configuration"],
  [/(^|\/)tools?(\/|$)/, "Tools and commands"],
  [/(^|\/)middleware(\/|$)/, "Middleware"],
  [/(^|\/)(db|database|prisma|migrations?)(\/|$)/, "Database"],
  [/(^|\/)scripts?(\/|$)/, "Scripts"],
  [/(^|\/)(tests?|__tests__|e2e|spec)(\/|$)/, "Tests"],
  [/(^|\/)(modules?|features?)(\/|$)/, "Feature modules"],
];

function buildAreas(
  facts: FileFacts[],
  graph: Graph,
  rank: Map<string, number>,
): { areas: AreaInfo[]; links: Array<{ from: string; to: string; count: number }> } {
  interface Acc {
    files: FileFacts[];
    lines: number;
    depends: Map<string, number>;
    usedBy: Map<string, number>;
  }

  const byArea = new Map<string, Acc>();
  const areaOfFile = new Map(facts.map((file) => [file.path, file.area]));

  for (const file of facts) {
    const acc: Acc = byArea.get(file.area) ?? { files: [], lines: 0, depends: new Map<string, number>(), usedBy: new Map<string, number>() };
    acc.files.push(file);
    acc.lines += file.lines;
    byArea.set(file.area, acc);
  }

  const linkCounts = new Map<string, number>();

  for (const [from, targets] of graph.outgoing) {
    const fromArea = areaOfFile.get(from);
    if (!fromArea) continue;

    for (const target of targets) {
      const toArea = areaOfFile.get(target);
      if (!toArea || toArea === fromArea) continue;

      const key = `${fromArea}\0${toArea}`;
      linkCounts.set(key, (linkCounts.get(key) ?? 0) + 1);
      byArea.get(fromArea)!.depends.set(toArea, (byArea.get(fromArea)!.depends.get(toArea) ?? 0) + 1);
      byArea.get(toArea)!.usedBy.set(fromArea, (byArea.get(toArea)!.usedBy.get(fromArea) ?? 0) + 1);
    }
  }

  const topKeys = (map: Map<string, number>) =>
    [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4).map(([name]) => name);

  const areas: AreaInfo[] = [...byArea.entries()]
    .map(([area, acc]) => {
      const named = ROLE_BY_NAME.find(([pattern]) => pattern.test(area))?.[1];
      const testShare = acc.files.filter((file) => file.kind === "test").length / acc.files.length;
      const jsxShare = acc.files.filter((file) => file.hasJsx).length / acc.files.length;
      const hasRoutes = acc.files.some((file) => file.routes.length > 0);

      const role =
        named ??
        (testShare > 0.6 ? "Tests" : jsxShare > 0.5 ? "UI code" : hasRoutes ? "API routes and handlers" : "Source code");

      return {
        area,
        role,
        files: acc.files.length,
        lines: acc.lines,
        dependsOn: topKeys(acc.depends),
        usedBy: topKeys(acc.usedBy),
        topFiles: [...acc.files]
          .filter((file) => file.kind === "source")
          .sort((a, b) => (rank.get(b.path) ?? 0) - (rank.get(a.path) ?? 0))
          .slice(0, 3)
          .map((file) => file.path),
      };
    })
    .sort((a, b) => b.lines - a.lines || a.area.localeCompare(b.area))
    .slice(0, 16);

  const links = [...linkCounts.entries()]
    .map(([key, count]) => {
      const [from, to] = key.split("\0");
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  return { areas, links };
}

function classifyName(file: string): string {
  const base = path.posix.basename(file).replace(/\.(test|spec|cy|e2e)(?=\.)/, "").replace(/\.[^.]+$/, "");
  if (/^[A-Z][A-Za-z0-9]*$/.test(base) && /[a-z]/.test(base)) return "PascalCase";
  if (/^[a-z][a-z0-9]*([A-Z][a-z0-9]*)+$/.test(base)) return "camelCase";
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(base)) return "kebab-case";
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(base)) return "snake_case";
  return "lowercase";
}

function confidenceFor(share: number, samples: number): Confidence {
  if (samples >= 10 && share >= 0.85) return "high";
  if (samples >= 4 && share >= 0.65) return "medium";
  return "low";
}

function percent(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 100);
}

function detectConventions(
  facts: FileFacts[],
  configs: Map<string, PathConfig>,
  discovered: Discovered,
  profile: ProjectProfile,
): Convention[] {
  const conventions: Convention[] = [];
  const sources = facts.filter((file) => file.kind === "source");
  const tests = facts.filter((file) => file.kind === "test");

  const sum = (key: keyof FileFacts["style"], list = facts) =>
    list.reduce((total, file) => total + file.style[key], 0);

  const add = (id: string, label: string, value: string, evidence: string, confidence: Confidence) =>
    conventions.push({ id, label, value, evidence, confidence });

  // File naming. Single-word lowercase names fit every style, so they say nothing.
  const nameGroups: Array<[string, string, FileFacts[]]> = [
    ["file-naming", "File names", sources.filter((file) => !/\.(tsx|jsx)$/.test(file.path))],
    ["component-naming", "Component file names", sources.filter((file) => /\.(tsx|jsx)$/.test(file.path))],
  ];

  for (const [id, label, group] of nameGroups) {
    const informative = group.filter(
      (file) => !/^index\./.test(path.posix.basename(file.path)) && classifyName(file.path) !== "lowercase",
    );
    if (informative.length < 2) continue;

    const classes = new Map<string, string[]>();
    for (const file of informative) {
      const key = classifyName(file.path);
      const list = classes.get(key) ?? [];
      list.push(path.posix.basename(file.path));
      classes.set(key, list);
    }

    const [top, examples] = [...classes.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    add(
      id,
      label,
      `${top} (${percent(examples.length, informative.length)}%)`,
      `For example ${examples.slice(0, 3).join(", ")}.${id === "file-naming" ? " Single-word names are lowercase." : ""}`,
      confidenceFor(examples.length / informative.length, informative.length),
    );
  }

  // Exports
  const named_ = sum("namedExports", sources);
  const defaults = sum("defaultExports", sources);
  if (named_ + defaults > 0) {
    const preferred = named_ >= defaults ? "Named exports" : "Default exports";
    const share = Math.max(named_, defaults) / (named_ + defaults);
    add(
      "exports",
      "Exports",
      `${preferred} (${percent(Math.max(named_, defaults), named_ + defaults)}%)`,
      `${named_} named and ${defaults} default exports.`,
      confidenceFor(share, named_ + defaults),
    );
  }

  // Imports
  const js = sum("jsExtensionImports");
  const bare = sum("bareRelativeImports");
  if (js + bare >= 3) {
    const esm = js > bare;
    add(
      "import-extensions",
      "Relative imports",
      esm ? "Include the .js extension" : "Leave the extension off",
      `${js} imports with .js, ${bare} without.`,
      confidenceFor(Math.max(js, bare) / (js + bare), js + bare),
    );
  }

  const alias = sum("aliasImports");
  if (alias > 0) {
    const configured = [...configs.values()].flatMap((config) => config.paths.map((pattern) => pattern.prefix + (pattern.wildcard ? "*" : "")));
    add(
      "alias",
      "Path aliases",
      configured.length > 0 ? [...new Set(configured)].slice(0, 3).join(", ") : "@/ style aliases",
      `${plural(alias, "import")} use an alias.`,
      "medium",
    );
  }

  const typeImports = sum("typeImports");
  if (typeImports > 0) {
    add("type-imports", "Type-only imports", "Use `import type` for types", `${plural(typeImports, "type-only import")}.`, typeImports >= 5 ? "medium" : "low");
  }

  // Components
  const functionComponents = sum("functionComponents");
  const arrowComponents = sum("arrowComponents");
  const classComponents = sum("classComponents");
  const components = functionComponents + arrowComponents + classComponents;
  if (components >= 2) {
    const style =
      functionComponents >= arrowComponents && functionComponents >= classComponents
        ? "Function declarations"
        : arrowComponents >= classComponents
          ? "Arrow functions"
          : "Classes";
    add(
      "components",
      "React components",
      `${style} (${percent(Math.max(functionComponents, arrowComponents, classComponents), components)}%)`,
      `${functionComponents} function, ${arrowComponents} arrow, ${classComponents} class components.`,
      confidenceFor(Math.max(functionComponents, arrowComponents, classComponents) / components, components),
    );
  }

  // Async
  const awaits = sum("awaits");
  const thens = sum("thenCalls");
  if (awaits + thens >= 5) {
    add(
      "async",
      "Asynchronous code",
      awaits >= thens ? "async/await" : ".then() chains",
      `${awaits} await expressions, ${thens} .then calls.`,
      confidenceFor(Math.max(awaits, thens) / (awaits + thens), awaits + thens),
    );
  }

  // Formatting
  const double = sum("doubleQuotes");
  const single = sum("singleQuotes");
  if (double + single >= 20) {
    add(
      "quotes",
      "Quotes",
      double >= single ? "Double quotes" : "Single quotes",
      `${double} double and ${single} single quoted strings.`,
      confidenceFor(Math.max(double, single) / (double + single), double + single),
    );
  }

  const semi = sum("semicolons");
  const noSemi = sum("noSemicolons");
  if (semi + noSemi >= 20) {
    add(
      "semicolons",
      "Semicolons",
      semi >= noSemi ? "Used" : "Omitted",
      `${semi} statements end with one, ${noSemi} do not.`,
      confidenceFor(Math.max(semi, noSemi) / (semi + noSemi), semi + noSemi),
    );
  }

  const two = sum("indentTwo");
  const four = sum("indentFour");
  const tabs = sum("indentTab");
  if (two + four + tabs >= 30) {
    const winner = tabs > two && tabs > four ? "Tabs" : two >= four ? "2 spaces" : "4 spaces";
    add(
      "indent",
      "Indentation",
      winner,
      `${two} lines at 2 spaces, ${four} at 4, ${tabs} with tabs.`,
      confidenceFor(Math.max(two, four, tabs) / (two + four + tabs), two + four + tabs),
    );
  }

  // Tests
  if (tests.length > 0) {
    const inFolder = tests.filter((file) => /(^|\/)__tests__\//.test(file.path)).length;
    const topLevel = tests.filter((file) => /(^|\/)(tests?|e2e|cypress|playwright)\//.test(file.path) && !/__tests__/.test(file.path)).length;
    const colocated = tests.length - inFolder - topLevel;
    const layout =
      colocated >= inFolder && colocated >= topLevel
        ? "Next to the code they test"
        : inFolder >= topLevel
          ? "In __tests__ folders"
          : "In a top-level tests folder";
    const suffixTest = tests.filter((file) => /\.test\./.test(file.path)).length;
    const suffixSpec = tests.filter((file) => /\.spec\./.test(file.path)).length;

    add(
      "tests",
      "Tests",
      `${profile.testRunner ?? "Test runner not detected"}. ${layout}${suffixTest + suffixSpec > 0 ? `, named *.${suffixTest >= suffixSpec ? "test" : "spec"}.*` : ""}`,
      `${plural(tests.length, "test file")} across ${plural(new Set(tests.map((file) => file.area)).size, "area")}.`,
      tests.length >= 5 ? "high" : "medium",
    );
  } else {
    add("tests", "Tests", "No test files found", "Nothing matched *.test.* or *.spec.* or a tests folder.", "high");
  }

  // TypeScript
  const rootConfig = configs.get("") ?? [...configs.values()][0];
  if (rootConfig) {
    const parts = [
      rootConfig.strict === undefined ? undefined : rootConfig.strict ? "strict mode on" : "strict mode off",
      rootConfig.target ? `target ${rootConfig.target}` : undefined,
      rootConfig.moduleKind ? `module ${rootConfig.moduleKind}` : undefined,
    ].filter(Boolean);

    if (parts.length > 0) {
      add("typescript", "TypeScript", parts.join(", "), "From tsconfig.json.", "high");
    }
  }

  // Tooling
  const tooling = [...discovered.configNames].filter((name) => /^(\.prettierrc|prettier\.config|\.eslintrc|eslint\.config|tailwind\.config|Dockerfile|docker-compose)/.test(name));
  if (tooling.length > 0) {
    add("tooling", "Tooling config", tooling.slice(0, 5).join(", "), "Configuration files found at the project root.", "high");
  }

  return conventions;
}

/* -------------------------------------------------------------------------- */
/*  Recent git activity (optional)                                            */
/* -------------------------------------------------------------------------- */

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
      { cwd, maxBuffer: 64 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message).trim()));
        else resolve(stdout);
      },
    );
  });
}

async function readRecentActivity(
  root: string,
): Promise<{ counts: Map<string, number>; commits: RecentChange[] } | undefined> {
  try {
    const output = await runGit(root, [
      "log",
      "-n",
      "200",
      "--no-renames",
      "--name-only",
      "--format=%x1e%h%x1f%s%x1f%aI",
    ]);

    const counts = new Map<string, number>();
    const commits: RecentChange[] = [];

    for (const chunk of output.split("\x1e")) {
      if (!chunk.trim()) continue;
      const [header, ...rest] = chunk.split("\n");
      const [hash, subject, date] = header.split("\x1f");
      const files = rest.map((line) => normalizePath(line.trim())).filter(Boolean);

      for (const file of files) counts.set(file, (counts.get(file) ?? 0) + 1);
      commits.push({ hash: hash ?? "", subject: subject ?? "", date: date ?? "", files });
    }

    return { counts, commits };
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/*  Relevance                                                                 */
/* -------------------------------------------------------------------------- */

function buildIndex(facts: FileFacts[]): Map<string, Map<string, number>> {
  const index = new Map<string, Map<string, number>>();

  for (const file of facts) {
    for (const [term, weight] of file.words) {
      const postings = index.get(term) ?? new Map<string, number>();
      postings.set(file.path, weight);
      index.set(term, postings);
    }
  }

  return index;
}

function termMatches(query: string, term: string): number {
  if (term === query) return 1;
  if (query.length >= 4 && term.startsWith(query)) return 0.6;
  if (term.length >= 4 && query.startsWith(term)) return 0.5;
  return 0;
}

function scoreRelevance(
  terms: string[],
  fileCount: number,
  index: Map<string, Map<string, number>>,
): { scores: Map<string, number>; matched: string[] } {
  const scores = new Map<string, number>();
  const matched: string[] = [];

  for (const query of terms) {
    const weights = new Map<string, number>();

    for (const [term, postings] of index) {
      const factor = termMatches(query, term);
      if (factor === 0) continue;

      for (const [file, weight] of postings) {
        weights.set(file, (weights.get(file) ?? 0) + weight * factor);
      }
    }

    if (weights.size === 0) continue;
    matched.push(query);

    const idf = Math.log(1 + fileCount / weights.size);
    for (const [file, weight] of weights) {
      scores.set(file, (scores.get(file) ?? 0) + idf * (weight / (weight + 1.5)));
    }
  }

  const max = Math.max(...scores.values(), 1e-9);
  for (const [file, value] of scores) scores.set(file, value / max);

  return { scores, matched };
}

type Intent = "api" | "ui" | "data";

const INTENT_WORDS: Array<[Intent, RegExp]> = [
  ["api", /\b(endpoints?|routes?|api|handlers?|server|backend|requests?|responses?|middleware|controllers?|rest|http)\b/i],
  ["ui", /\b(components?|pages?|forms?|buttons?|ui|views?|screens?|render|hooks?|frontend|css|layout|modal)\b/i],
  ["data", /\b(database|db|models?|schemas?|quer(y|ies)|migrations?|tables?|repository)\b/i],
];

function detectIntents(task: string): Intent[] {
  return INTENT_WORDS.filter(([, pattern]) => pattern.test(task)).map(([intent]) => intent);
}

function fitsIntent(file: FileFacts, intents: Intent[]): Intent | undefined {
  return intents.find((intent) => {
    if (intent === "api") return file.routes.length > 0 || /(^|\/)(routes?|api|controllers?|handlers?|middleware|server)(\/|\.|$)/.test(file.path);
    if (intent === "ui") return file.hasJsx || /(^|\/)(components?|pages?|hooks?|views?)(\/|$)/.test(file.path);
    return /(^|\/)(db|database|models?|schemas?|store|repositor(y|ies))(\/|\.|$)/.test(file.path);
  });
}

const INTENT_LABEL: Record<Intent, string> = {
  api: "Fits an API change",
  ui: "Fits a UI change",
  data: "Fits a data change",
};

function explainMatch(file: FileFacts, terms: string[]): string[] {
  const reasons: string[] = [];

  const hit = (source: string, label: string) => {
    const words = new Set(splitWords(source));
    const found = terms.filter((term) => [...words].some((word) => termMatches(term, word) > 0));
    if (found.length > 0) reasons.push(`${label}: ${found.slice(0, 4).join(", ")}`);
  };

  hit(file.path.replace(/\.[^.]+$/, ""), "Path matches");
  hit(file.exports.join(" "), "Exports match");
  if (file.doc) hit(file.doc, "Comment mentions");
  hit(file.routes.join(" "), "Routes match");

  if (reasons.length === 0) {
    const found = terms.filter((term) => [...file.words.keys()].some((word) => termMatches(term, word) > 0));
    if (found.length > 0) reasons.push(`Code uses: ${found.slice(0, 4).join(", ")}`);
  }

  return reasons;
}

/* -------------------------------------------------------------------------- */
/*  Markdown                                                                  */
/* -------------------------------------------------------------------------- */

function fenceFor(content: string): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

function languageTag(file: string): string {
  const extension = path.posix.extname(file);
  if (extension === ".tsx") return "tsx";
  if (extension === ".jsx") return "jsx";
  if ([".ts", ".mts", ".cts"].includes(extension)) return "ts";
  return "js";
}

function commandFor(profile: ProjectProfile, name: string): string {
  const manager = profile.packageManager;
  const match = /^(.*): (.+)$/.exec(name);
  const scriptName = match ? match[2] : name;
  const dir = match ? match[1] : "";

  const run =
    scriptName === "test" || scriptName === "start"
      ? `${manager} ${scriptName}`
      : manager === "yarn"
        ? `yarn ${scriptName}`
        : `${manager} run ${scriptName}`;

  return dir ? `cd ${dir} && ${run}` : run;
}

function renderOverview(
  level: 0 | 1 | 2,
  input: {
    profile: ProjectProfile;
    areas: AreaInfo[];
    links: Array<{ from: string; to: string; count: number }>;
    conventions: Convention[];
    recent: RecentChange[];
    task?: string;
    focus: string[];
    budget: number;
  },
): string {
  const { profile, areas, links, conventions, recent, task, focus, budget } = input;
  const lines: string[] = [`# Codebase context: ${profile.name}`, ""];

  if (task) lines.push(`> Task: ${task.replace(/\s+/g, " ").slice(0, 400)}`);
  if (focus.length > 0) lines.push(`> Focus: ${focus.slice(0, 6).join(", ")}`);
  lines.push(`> Token budget: about ${budget.toLocaleString("en-US")} (estimated at 4 characters per token)`, "");

  lines.push("## Project", "");
  const about = profile.description ?? profile.readmeSummary;
  if (about) lines.push(about, "");

  const stack = profile.frameworks.slice(0, level === 2 ? 6 : 14).map((item) => item.name);
  if (stack.length > 0) lines.push(`- Stack: ${stack.join(", ")}`);

  lines.push(
    `- Languages: ${
      profile.languages
        .slice(0, 4)
        .map((item) => `${item.language} (${plural(item.files, "file")})`)
        .join(", ") || "none detected"
    }`,
  );
  lines.push(
    `- Package manager: ${profile.packageManager}${profile.testRunner ? ` · Test runner: ${profile.testRunner}` : ""}`,
  );

  if (profile.packages.length > 0 && level < 2) {
    lines.push(`- Packages: ${profile.packages.map((item) => `${item.name} (${item.dir}/)`).join(", ")}`);
  }

  if (profile.entryPoints.length > 0) {
    lines.push(`- Entry points: ${profile.entryPoints.slice(0, 5).map((entry) => `\`${entry}\``).join(", ")}`);
  }

  const scripts = profile.scripts.slice(0, level === 0 ? 8 : level === 1 ? 5 : 3);
  if (scripts.length > 0) {
    lines.push("- Commands:");
    for (const script of scripts) {
      lines.push(`  - \`${commandFor(profile, script.name)}\`${level === 2 ? "" : ` runs \`${script.command}\``}`);
    }
  }

  lines.push("", "## Architecture", "");
  for (const area of areas.slice(0, level === 0 ? 12 : level === 1 ? 8 : 5)) {
    const relations = [
      area.dependsOn.length > 0 && level < 2 ? `uses ${area.dependsOn.slice(0, 3).join(", ")}` : "",
      area.usedBy.length > 0 && level === 0 ? `used by ${area.usedBy.slice(0, 3).join(", ")}` : "",
    ].filter(Boolean);

    lines.push(
      `- \`${area.area}\`: ${area.role}, ${plural(area.files, "file")}, ${area.lines.toLocaleString("en-US")} lines${relations.length ? `. ${relations.join("; ")}.` : ""}`,
    );
  }

  if (links.length > 0 && level < 2) {
    lines.push("", `Strongest links: ${links.slice(0, 4).map((link) => `${link.from} → ${link.to} (${link.count})`).join("; ")}`);
  }

  const shown = conventions.slice(0, level === 0 ? 12 : level === 1 ? 7 : 4);
  if (shown.length > 0) {
    lines.push("", "## Conventions", "");
    for (const convention of shown) {
      lines.push(`- **${convention.label}:** ${convention.value}${level === 0 ? `. ${convention.evidence}` : ""}`);
    }
  }

  if (recent.length > 0 && level === 0) {
    lines.push("", "## Recent changes to the relevant files", "");
    for (const change of recent.slice(0, 5)) lines.push(`- ${change.hash} ${change.subject}`);
  }

  return `${lines.join("\n")}\n`;
}

function renderGuide(input: {
  profile: ProjectProfile;
  areas: AreaInfo[];
  links: Array<{ from: string; to: string; count: number }>;
  conventions: Convention[];
  keyFiles: ContextFile[];
}): string {
  const { profile, conventions, keyFiles } = input;

  const base = renderOverview(0, {
    profile,
    areas: input.areas,
    links: input.links,
    conventions,
    recent: [],
    focus: [],
    budget: 0,
  })
    .replace(/^# Codebase context: (.*)$/m, "# $1: project guide")
    .replace(/^> Token budget:.*\n\n?/m, "");

  const lines = [base.trimEnd(), "", "## Key files", ""];

  for (const file of keyFiles.slice(0, 12)) {
    const exportsText = file.exports
      .slice(0, 4)
      .map((name) => (name === "default" ? "default export" : name))
      .join(", ");
    const note = file.doc
      ? ` ${file.doc.slice(0, 110)}`
      : file.isEntry
        ? " Entry point."
        : exportsText
          ? ` Exports ${exportsText}.`
          : "";
    lines.push(`- \`${file.path}\`:${note}${file.importedByCount > 0 ? ` (imported by ${file.importedByCount})` : ""}`);
  }

  lines.push(
    "",
    "## Working agreements",
    "",
    "- Follow the conventions above instead of introducing a new style.",
    `- Run \`${profile.testRunner ? commandFor(profile, "test") : "the project's tests"}\` before finishing a change.`,
    "- Keep changes small and match the surrounding code.",
  );

  return `${lines.join("\n")}\n`;
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                      */
/* -------------------------------------------------------------------------- */

export async function buildCodebaseContext(
  projectPath: string,
  options: {
    task?: string;
    focusFiles?: string[];
    tokenBudget?: number;
    detail?: DetailLevel;
    includeTests?: boolean;
    includeGit?: boolean;
  } = {},
): Promise<ContextReport> {
  const budget = options.tokenBudget ?? DEFAULT_BUDGET;
  const detail = options.detail ?? "auto";
  const includeTests = options.includeTests ?? false;
  const includeGit = options.includeGit ?? true;
  const task = options.task?.trim() ? options.task.trim() : undefined;

  if (!Number.isInteger(budget) || budget < MIN_BUDGET || budget > MAX_BUDGET) {
    throw new Error(`tokenBudget must be a whole number from ${MIN_BUDGET} to ${MAX_BUDGET}.`);
  }

  if (!["auto", "outline"].includes(detail)) {
    throw new Error("detail must be auto or outline.");
  }

  if (task && task.length > 2000) {
    throw new Error("task must be at most 2000 characters.");
  }

  const requestedFocus = (options.focusFiles ?? [])
    .map((file) => file.trim())
    .filter(Boolean)
    .map((file) => validateRelative(file, "focusFiles"));

  if (requestedFocus.length > 20) {
    throw new Error("focusFiles can contain at most 20 paths.");
  }

  const resolved = await resolveProjectPath(projectPath);
  const root = fs.realpathSync(resolved.projectPath);
  const warnings: string[] = [];

  const warn = (message: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message);
    else if (warnings.length === MAX_WARNINGS) warnings.push("Further warnings were omitted.");
  };

  /* ---- Read the project ---- */

  const discovered = discoverProject(root);

  if (discovered.codeFiles.length === 0) {
    throw new Error("No JavaScript or TypeScript files were found in the project.");
  }

  if (discovered.truncated) {
    warn(`Only the first ${MAX_FILES} code files were analyzed. Narrow the project path for complete results.`);
  }

  const fileSet = new Set(discovered.codeFiles);
  const packages = discovered.packageJsons
    .map((rel) => readPackage(root, rel))
    .filter((pkg): pkg is PackageInfo => pkg !== undefined)
    .sort((a, b) => a.dir.length - b.dir.length);

  const entryPoints = detectEntryPoints(root, packages, fileSet);
  const entrySet = new Set(entryPoints);

  const facts: FileFacts[] = [];
  let skipped = 0;

  for (const rel of discovered.codeFiles) {
    try {
      const absolute = path.join(root, rel);
      if (fs.statSync(absolute).size > MAX_PARSE_BYTES) {
        skipped++;
        continue;
      }
      facts.push(parseFacts(rel, fs.readFileSync(absolute, "utf8"), (file) => entrySet.has(file)));
    } catch {
      warn(`Could not parse ${rel}.`);
    }
  }

  if (skipped > 0) warn(`${plural(skipped, "very large file")} ${skipped === 1 ? "was" : "were"} skipped.`);

  // Code files are counted exactly here; other languages are estimated from file size.
  for (const file of facts) {
    const language = LANGUAGE_BY_EXTENSION[file.ext];
    const stats = language ? discovered.languageStats.get(language) : undefined;
    if (stats) stats.lines += file.lines;
  }

  // Split large areas one level deeper so the architecture shows real modules.
  const areaSizes = new Map<string, number>();
  for (const file of facts) areaSizes.set(file.area, (areaSizes.get(file.area) ?? 0) + 1);
  for (const file of facts) {
    const segments = file.path.split("/");
    if ((areaSizes.get(file.area) ?? 0) > 8 && segments.length > file.area.split("/").length + 1) {
      file.area = segments.slice(0, file.area.split("/").length + 1).join("/");
    }
  }

  const factByPath = new Map(facts.map((file) => [file.path, file]));
  const configs = loadPathConfigs(root, discovered.tsconfigs);
  const graph = buildGraph(facts, createResolver(fileSet, configs));

  const sourceFacts = facts.filter((file) => file.kind === "source");
  const centrality = pageRank(
    sourceFacts.map((file) => file.path),
    graph,
  );

  const totals = {
    files: [...discovered.languageStats.values()].reduce((sum, stats) => sum + stats.files, 0),
    lines: [...discovered.languageStats.values()].reduce((sum, stats) => sum + stats.lines, 0),
  };

  const profile = buildProfile(root, discovered, packages, totals, entryPoints);
  const { areas, links } = buildAreas(facts, graph, centrality);
  const conventions = detectConventions(facts, configs, discovered, profile);

  const activity = includeGit ? await readRecentActivity(root) : undefined;
  if (includeGit && !activity) warn("Git history was not available, so recent activity was left out of the ranking.");

  /* ---- What is the question about? ---- */

  const focus = new Set<string>();
  const focusReasons = new Map<string, string>();

  const addFocus = (file: string, reason: string) => {
    if (focus.size < 12 && factByPath.has(file)) {
      focus.add(file);
      focusReasons.set(file, reason);
    }
  };

  for (const requested of requestedFocus) {
    if (factByPath.has(requested)) addFocus(requested, "Selected as a focus file");
    else {
      const inside = facts.filter((file) => file.path.startsWith(`${requested.replace(/\/$/, "")}/`));
      if (inside.length === 0) warn(`${requested} was not found among the analyzed files.`);
      for (const file of inside.slice(0, 12)) addFocus(file.path, `Inside the focus folder ${requested}`);
    }
  }

  if (task) {
    for (const mention of task.match(/[\w@./-]+\.[cm]?[jt]sx?\b/g) ?? []) {
      const clean = normalizePath(mention);
      const found = facts.find((file) => file.path === clean || file.path.endsWith(`/${clean}`));
      if (found) addFocus(found.path, "Named in the task");
    }
  }

  // File paths named in the task already became focus files, so their words are not search terms.
  const wordsOfTask = task ? task.replace(/[\w@./-]+\.[cm]?[jt]sx?\b/g, " ") : "";
  const queryTerms = task ? [...new Set(splitWords(wordsOfTask))].slice(0, 16) : [];
  const intents = task ? detectIntents(wordsOfTask) : [];
  const index = buildIndex(facts);
  const relevance = queryTerms.length > 0 ? scoreRelevance(queryTerms, facts.length, index) : { scores: new Map<string, number>(), matched: [] as string[] };

  const mode: ContextMode = task ? "task" : focus.size > 0 ? "focus" : "orientation";

  if (task && relevance.matched.length === 0 && focus.size === 0) {
    warn("No file matched the words in the task, so the most central files are shown instead. Try different words or select focus files.");
  }

  /* ---- Rank ---- */

  const topByRelevance = [...relevance.scores.entries()]
    .filter(([file]) => factByPath.get(file)?.kind === "source")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([file]) => file);

  const focusDistance = proximityFrom([...focus], graph);
  const seedDistance = proximityFrom(topByRelevance, graph);
  const closeness = (distance: number | undefined) =>
    distance === undefined ? 0 : distance === 0 ? 1 : distance === 1 ? 0.6 : 0.3;

  const candidates = facts.filter((file) => includeTests || file.kind === "source");
  const noMatches = mode === "task" && relevance.matched.length === 0 && focus.size === 0;

  const rankings = candidates.map((file) => {
    const rel = relevance.scores.get(file.path) ?? 0;
    const cent = centrality.get(file.path) ?? 0;
    const rec = Math.min(1, (activity?.counts.get(file.path) ?? 0) / 6);
    const entry = file.isEntry ? 1 : 0;
    const prox = Math.max(closeness(focusDistance.get(file.path)), closeness(seedDistance.get(file.path)) * 0.7);

    let score: number;
    if (mode === "task" && !noMatches) {
      const intent = intents.length > 0 && rel > 0 && fitsIntent(file, intents) ? 1 : 0;
      score = 0.55 * rel + 0.12 * intent + 0.13 * cent + 0.12 * prox + 0.04 * rec + 0.04 * entry;
      if (focus.has(file.path)) score = Math.max(score, 0.9);
    } else if (mode === "focus") {
      score = 0.6 * prox + 0.2 * cent + 0.1 * rec + 0.1 * entry;
    } else {
      score = 0.5 * cent + 0.25 * entry + 0.15 * rec + 0.1 * Math.min(1, file.exports.length / 10);
    }

    return { file, score, rel, cent, rec, prox };
  });

  rankings.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
  const ranked = rankings.filter((item) => item.score > 0.001 || mode === "orientation").slice(0, 120);

  /* ---- Pack into the budget ---- */

  const keyFiles: ContextFile[] = [];
  let redactions = 0;

  const toContextFile = (item: (typeof ranked)[number], includedAs: IncludedAs): ContextFile => {
    const { file } = item;
    const reasons: string[] = [];

    if (focusReasons.has(file.path)) reasons.push(focusReasons.get(file.path)!);
    if (relevance.scores.has(file.path) && queryTerms.length > 0) reasons.push(...explainMatch(file, queryTerms));
    if (mode === "task" && intents.length > 0 && item.rel > 0) {
      const fit = fitsIntent(file, intents);
      if (fit) reasons.push(INTENT_LABEL[fit]);
    }
    if (focus.size > 0 && !focus.has(file.path) && focusDistance.has(file.path)) {
      reasons.push(`${focusDistance.get(file.path) === 1 ? "Directly connected" : "Two imports away"} from a focus file`);
    } else if (seedDistance.has(file.path) && !focus.has(file.path) && item.rel < 0.3 && mode === "task") {
      reasons.push("Connected to the best matches");
    }
    if (file.isEntry) reasons.push("Entry point");
    const importers = graph.incoming.get(file.path)?.size ?? 0;
    if (importers >= 3 && item.cent >= 0.3) reasons.push(`Central module, imported by ${importers} files`);
    if ((activity?.counts.get(file.path) ?? 0) >= 3) reasons.push(`Changed in ${activity!.counts.get(file.path)} recent commits`);
    if (reasons.length === 0) {
      reasons.push(
        importers > 0
          ? `Imported by ${plural(importers, "file")}`
          : file.exports.length > 0
            ? `Exports ${file.exports.slice(0, 3).join(", ")}`
            : "Related by structure",
      );
    }

    return {
      path: file.path,
      area: file.area,
      kind: file.kind,
      lines: file.lines,
      score: Math.round(item.score * 1000) / 1000,
      relevance: Math.round(item.rel * 1000) / 1000,
      centrality: Math.round(item.cent * 1000) / 1000,
      proximity: Math.round(item.prox * 1000) / 1000,
      recency: Math.round(item.rec * 1000) / 1000,
      reasons: reasons.slice(0, 5),
      exports: file.exports.slice(0, 14),
      imports: [...(graph.outgoing.get(file.path) ?? [])].slice(0, 8),
      importedBy: [...(graph.incoming.get(file.path) ?? [])].slice(0, 8),
      importCount: graph.outgoing.get(file.path)?.size ?? 0,
      importedByCount: graph.incoming.get(file.path)?.size ?? 0,
      includedAs,
      tokens: { full: 0, outline: 0 },
      doc: file.doc || undefined,
      isEntry: file.isEntry,
    };
  };

  const recentForRanked = (paths: Set<string>): RecentChange[] =>
    (activity?.commits ?? []).filter((commit) => commit.files.some((file) => paths.has(file))).slice(0, 5);

  const overviewInput = (recent: RecentChange[]) => ({
    profile,
    areas,
    links,
    conventions,
    recent,
    task,
    focus: [...focus],
    budget,
  });

  const topPaths = new Set(ranked.slice(0, 8).map((item) => item.file.path));
  const recent = recentForRanked(topPaths);

  let level: 0 | 1 | 2 = 0;
  let overview = renderOverview(0, overviewInput(recent));
  while (estimateTokens(overview) > budget * 0.4 && level < 2) {
    level = (level + 1) as 1 | 2;
    overview = renderOverview(level, overviewInput(recent));
  }

  const overviewTokens = estimateTokens(overview);
  const reserve = 140;
  let remaining = Math.max(0, budget - overviewTokens - reserve);

  interface Packed {
    item: (typeof ranked)[number];
    context: ContextFile;
    full: string;
    outline: string;
    chosen: IncludedAs;
  }

  const packed: Packed[] = [];
  let omittedByBudget = 0;
  let listedCount = 0;

  for (const [position, item] of ranked.entries()) {
    const { file } = item;

    let fullText = "";
    try {
      const raw = fs.readFileSync(path.join(root, file.path), "utf8");
      const cleaned = redact(raw);
      fullText = cleaned.text.length <= MAX_CONTENT_CHARS ? cleaned.text.trimEnd() : "";
      let outlineText = "";
      try {
        outlineText = capOutline(redact(outlineOf(file.path, raw)).text.trim(), Math.max(600, Math.floor(budget * 0.35)));
      } catch {
        outlineText = "";
      }

      const context = toContextFile(item, "omitted");
      context.tokens = {
        full: fullText ? estimateTokens(fullText) + 24 : 0,
        outline: outlineText ? estimateTokens(outlineText) + 24 : 0,
      };

      let chosen: IncludedAs = "omitted";
      const fullCost = context.tokens.full;
      const outlineCost = context.tokens.outline;
      const listCost = 28;

      const wantsFull =
        detail === "auto" &&
        fullCost > 0 &&
        position < 4 &&
        (fullCost <= 1500 || (position < 2 && fullCost <= 2600)) &&
        fullCost <= Math.max(400, remaining * 0.35);

      if (wantsFull) {
        chosen = "full";
        remaining -= fullCost;
      } else if (outlineCost > 0 && outlineCost <= remaining && position < 40) {
        chosen = "outline";
        remaining -= outlineCost;
      } else if (listedCount < 25 && listCost <= remaining) {
        chosen = "listed";
        listedCount++;
        remaining -= listCost;
      } else {
        omittedByBudget++;
      }

      context.includedAs = chosen;
      packed.push({ item, context, full: fullText, outline: outlineText, chosen });
    } catch {
      /* unreadable files are skipped */
    }
  }

  // Spend any leftover budget on showing the best files in full.
  if (detail === "auto") {
    for (const entry of packed) {
      if (entry.chosen !== "outline" || entry.context.tokens.full === 0) continue;

      const extra = entry.context.tokens.full - entry.context.tokens.outline;
      if (entry.context.tokens.full <= 2600 && extra <= remaining * 0.6) {
        entry.chosen = "full";
        entry.context.includedAs = "full";
        remaining -= extra;
      }
    }
  }

  const includedEntries = packed.filter((entry) => entry.chosen !== "omitted");

  for (const entry of includedEntries) {
    entry.context.content = entry.chosen === "full" ? entry.full : entry.chosen === "outline" ? entry.outline : undefined;
  }

  // Count what was removed from the included content.
  for (const entry of includedEntries.filter((value) => value.chosen !== "listed")) {
    try {
      const raw = fs.readFileSync(path.join(root, entry.item.file.path), "utf8");
      redactions += redact(raw).count;
    } catch {
      /* ignore */
    }
  }

  /* ---- Render the context pack ---- */

  const renderBody = (entries: Packed[], omitted: number): string => {
    const body: string[] = ["## Relevant files (ranked)", ""];
    let ordinal = 0;

    for (const entry of entries.filter((value) => value.chosen !== "listed")) {
      ordinal++;
      const { context } = entry;
      const content = entry.chosen === "full" ? entry.full : entry.outline;
      const fence = fenceFor(content);

      body.push(
        `### ${ordinal}. ${context.path} (${entry.chosen === "full" ? "full source" : "outline: signatures only"})`,
        `_Why: ${context.reasons.slice(0, 3).join("; ")}._`,
        "",
        `${fence}${languageTag(context.path)}`,
        content,
        fence,
        "",
      );
    }

    const listed = entries.filter((value) => value.chosen === "listed");
    if (listed.length > 0) {
      body.push("## Also relevant (not shown)", "");
      for (const entry of listed) {
        body.push(
          `- \`${entry.context.path}\`${entry.context.exports.length > 0 ? `: exports ${entry.context.exports.slice(0, 4).join(", ")}` : ""}`,
        );
      }
      body.push("");
    }

    const shownPaths = new Set(entries.map((entry) => entry.context.path));
    const relatedTests = new Set<string>();
    for (const file of shownPaths) {
      for (const importer of graph.incoming.get(file) ?? []) {
        if (factByPath.get(importer)?.kind === "test" && !shownPaths.has(importer)) relatedTests.add(importer);
      }
    }

    if (relatedTests.size > 0) {
      body.push("## Related tests", "", ...[...relatedTests].slice(0, 8).map((test) => `- \`${test}\``), "");
    }

    if (omitted > 0) {
      body.push(
        `_${plural(omitted, "lower-ranked file")} did not fit in the budget. Raise the token budget or add focus files to see more._`,
        "",
      );
    }

    return `${overview}\n${body.join("\n")}`.trimEnd() + "\n";
  };

  // The budget is a hard limit: drop the lowest-ranked files until the pack fits.
  let fitted = includedEntries.slice();
  let contextMarkdown = renderBody(fitted, omittedByBudget);

  while (estimateTokens(contextMarkdown) > budget && fitted.length > 1) {
    const dropped = fitted.pop();
    if (dropped) {
      dropped.chosen = "omitted";
      dropped.context.includedAs = "omitted";
      dropped.context.content = undefined;
      omittedByBudget++;
    }
    contextMarkdown = renderBody(fitted, omittedByBudget);
  }

  includedEntries.length = 0;
  includedEntries.push(...fitted);

  const guideFiles = [...sourceFacts]
    .sort(
      (a, b) =>
        (centrality.get(b.path) ?? 0) + (b.isEntry ? 0.5 : 0) - ((centrality.get(a.path) ?? 0) + (a.isEntry ? 0.5 : 0)),
    )
    .slice(0, 12)
    .map((file) => toContextFile({ file, score: centrality.get(file.path) ?? 0, rel: 0, cent: centrality.get(file.path) ?? 0, rec: 0, prox: 0 }, "listed"));

  const guideMarkdown = renderGuide({ profile, areas, links, conventions, keyFiles: guideFiles });
  keyFiles.push(...guideFiles);

  const usedTokens = estimateTokens(contextMarkdown);

  if (usedTokens > budget) {
    warn(`The pack is about ${usedTokens} tokens, a little over the ${budget} budget, because the project overview alone is large.`);
  }

  const files = packed
    .map((entry) => entry.context)
    .slice(0, MAX_RETURNED_FILES);

  return {
    success: true,
    tool: "build_codebase_context",
    projectPath: root,
    mode,
    task,
    focusFiles: [...focus],
    queryTerms,
    matchedTerms: relevance.matched,
    tokens: {
      budget,
      used: usedTokens,
      overview: overviewTokens,
      files: Math.max(0, usedTokens - overviewTokens),
      remaining: Math.max(0, budget - usedTokens),
    },
    project: profile,
    areas,
    areaLinks: links,
    conventions,
    files,
    includedCount: includedEntries.length,
    omittedCount: omittedByBudget + Math.max(0, packed.length - MAX_RETURNED_FILES),
    recentChanges: recent,
    contextMarkdown,
    guideMarkdown,
    redactions,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/*  MCP registration                                                          */
/* -------------------------------------------------------------------------- */

export function registerBuildCodebaseContextTool(server: McpServer) {
  server.registerTool(
    "build_codebase_context",
    {
      description:
        "Build the right context about a codebase for an AI assistant within a token budget. Parses the project with the TypeScript parser, detects the stack, scripts, entry points, architecture areas and real coding conventions, ranks files by relevance to a task (word match, import-graph importance, closeness to focus files, entry points, recent git activity), and packs the best ones as full source or signature-only outlines. Returns a task-specific context pack in markdown, a reusable project guide (CLAUDE.md or AGENTS.md style), and the ranked files with the reason for each. Credential files are skipped and secrets are redacted.",
      inputSchema: z.object({
        projectPath: z.string().describe("Absolute path to the project directory"),
        task: z
          .string()
          .max(2000)
          .optional()
          .describe("What you want to do or understand, in plain words. Leave empty for a general overview."),
        focusFiles: z
          .array(z.string())
          .max(20)
          .optional()
          .describe("Files or folders, relative to projectPath, that the task is about."),
        tokenBudget: z
          .number()
          .int()
          .min(MIN_BUDGET)
          .max(MAX_BUDGET)
          .optional()
          .describe(`Approximate size of the context pack in tokens. Default ${DEFAULT_BUDGET}.`),
        detail: z
          .enum(["auto", "outline"])
          .optional()
          .describe("auto shows the best files in full and the rest as outlines. outline never shows full source."),
        includeTests: z.boolean().optional().describe("Rank test files too. Default false."),
        includeGit: z
          .boolean()
          .optional()
          .describe("Use recent git activity as a ranking signal when a repository is available. Default true."),
      }),
    },
    async ({ projectPath, task, focusFiles, tokenBudget, detail, includeTests, includeGit }) => {
      try {
        const report = await buildCodebaseContext(projectPath, {
          task,
          focusFiles,
          tokenBudget,
          detail,
          includeTests,
          includeGit,
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
                  tool: "build_codebase_context",
                  error: error instanceof Error ? error.message : "Failed to build the codebase context.",
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
