import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveProjectPath } from "../utils/projectResolver.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

type DuplicateSeverity = "critical" | "high" | "medium" | "low" | "info";

/**
 * exact      - every token is identical (formatting and comments ignored).
 * renamed    - same structure, but identifiers and/or literals differ.
 */
type DuplicateType = "exact" | "renamed";

type DuplicateScope = "cross-file" | "same-file";

/**
 * exact      - tokens must match verbatim.
 * renamed    - identifiers are interchangeable, literals must match.
 * structural - identifiers and literals are interchangeable.
 */
type MatchMode = "exact" | "renamed" | "structural";

type RefactorStrategy =
  | "extract-function"
  | "extract-component"
  | "extract-shared-module"
  | "extract-local-helper"
  | "keep-one-copy";

interface DuplicateFragment {
  filePath: string;
  startLine: number;
  endLine: number;
  lines: number;
  tokens: number;
  /** Total number of lines in the file, used to draw the position bar. */
  fileLines: number;
  /** Nearest named function, method, class or component around the block. */
  symbol?: string;
  /** Dedented source, capped at MAX_SNIPPET_LINES. */
  snippet: string;
  snippetTruncated: boolean;
}

interface DuplicateSuggestion {
  strategy: RefactorStrategy;
  confidence: "high" | "medium" | "low";
  title: string;
  summary: string;
  steps: string[];
  suggestedName?: string;
  suggestedPath?: string;
  caveats: string[];
}

interface DuplicateGroup {
  id: string;
  severity: DuplicateSeverity;
  type: DuplicateType;
  scope: DuplicateScope;
  /** 0-100 impact score. */
  score: number;
  /** Median block size in lines. */
  lines: number;
  /** Median block size in tokens. */
  tokens: number;
  instanceCount: number;
  /** Lines you could delete by keeping one copy. */
  duplicatedLines: number;
  title: string;
  description: string;
  recommendation: string;
  fragments: DuplicateFragment[];
  /** Copies not included in `fragments` (display cap). */
  hiddenInstances: number;
  suggestion: DuplicateSuggestion;
}

interface DuplicateHotspot {
  filePath: string;
  duplicatedLines: number;
  groupCount: number;
  fileLines: number;
  percentage: number;
}

interface DuplicateCodeReport {
  success: boolean;
  tool: "detect_duplicate_code";
  projectPath: string;
  filePath?: string;
  matchMode: MatchMode;
  minTokens: number;
  minLines: number;
  includeTests: boolean;
  filesScanned: number;
  tokensAnalyzed: number;
  totalLines: number;
  totalGroups: number;
  /** Group count for the whole project, before any filePath filter. */
  projectGroupCount: number;
  totalCopies: number;
  duplicatedLines: number;
  duplicationPercentage: number;
  exactGroups: number;
  renamedGroups: number;
  crossFileGroups: number;
  sameFileGroups: number;
  filesAffected: number;
  summary: Record<DuplicateSeverity, number>;
  groups: DuplicateGroup[];
  hotspots: DuplicateHotspot[];
  warnings: string[];
}

interface SymbolRange {
  name: string;
  startLine: number;
  endLine: number;
}

interface FileTokens {
  relPath: string;
  lineCount: number;
  /** Normalized token ids, used for matching. */
  norm: Int32Array;
  /** Raw token ids, used to tell exact copies from renamed ones. */
  raw: Int32Array;
  startLine: Int32Array;
  endLine: Int32Array;
  symbols: SymbolRange[];
}

interface Fragment {
  file: number;
  tokenStart: number;
  tokenEnd: number; // inclusive
}

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "out",
  ".vite",
  "generated-diagrams",
]);

const TEST_FILE_PATTERN =
  /(^|\/)(__tests__|__mocks__|tests?|e2e|cypress)\/|\.(test|spec|stories)\.[cm]?[jt]sx?$/;

const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_TOKENS = 3_000_000;
const MAX_BUCKET_SIZE = 25;
const MAX_PAIR_WINDOWS = 2_000_000;
const MAX_GROUPS = 200;
const MAX_FRAGMENTS_PER_GROUP = 12;
const MAX_SNIPPET_LINES = 40;
const MAX_HOTSPOTS = 15;
const MAX_WARNINGS = 25;

const DEFAULT_MIN_TOKENS = 50;
const DEFAULT_MIN_LINES = 5;

// Rolling hash parameters. Every intermediate product stays below 2^53.
const MOD_A = 1_000_000_007;
const BASE_A = 1_000_003;
const MOD_B = 998_244_353;
const BASE_B = 999_983;
const TOKEN_HASH_RANGE = 1_000_003;
const FILE_STRIDE = 16_777_216; // token index space per file (2^24)

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function isLiteralKind(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.StringLiteral ||
    kind === ts.SyntaxKind.NumericLiteral ||
    kind === ts.SyntaxKind.BigIntLiteral ||
    kind === ts.SyntaxKind.RegularExpressionLiteral ||
    kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
    kind === ts.SyntaxKind.TemplateHead ||
    kind === ts.SyntaxKind.TemplateMiddle ||
    kind === ts.SyntaxKind.TemplateTail ||
    kind === ts.SyntaxKind.JsxText
  );
}

function isIdentifierKind(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.Identifier ||
    kind === ts.SyntaxKind.PrivateIdentifier
  );
}

function scriptKindFor(file: string): ts.ScriptKind {
  const extension = path.extname(file);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function discoverSourceFiles(root: string): {
  files: string[];
  truncated: boolean;
} {
  const files: string[] = [];
  let truncated = false;
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;

      const absolute = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) stack.push(absolute);
        continue;
      }

      if (!entry.isFile()) continue;

      if (
        !SOURCE_EXTENSIONS.has(path.extname(entry.name)) ||
        /\.d\.[cm]?ts$/.test(entry.name) ||
        /\.min\.[cm]?js$/.test(entry.name)
      ) {
        continue;
      }

      if (files.length >= MAX_FILES) {
        truncated = true;
        continue;
      }

      files.push(absolute);
    }
  }

  files.sort();
  return { files, truncated };
}

/* -------------------------------------------------------------------------- */
/*  Tokenizing                                                                */
/* -------------------------------------------------------------------------- */

class Interner {
  private readonly ids = new Map<string, number>();

  intern(value: string): number {
    let id = this.ids.get(value);
    if (id === undefined) {
      id = this.ids.size + 1;
      this.ids.set(value, id);
    }
    return id;
  }
}

function symbolNameFor(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): string | undefined {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.name
  ) {
    return node.name.getText(sourceFile);
  }

  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) ||
      ts.isFunctionExpression(node.initializer))
  ) {
    return node.name.text;
  }

  return undefined;
}

function tokenizeFile(
  absolute: string,
  relPath: string,
  text: string,
  mode: MatchMode,
  interner: Interner,
): FileTokens {
  const sourceFile = ts.createSourceFile(
    absolute,
    text,
    ts.ScriptTarget.Latest,
    false,
    scriptKindFor(absolute),
  );

  // Import and `export ... from` lines look alike everywhere and are not
  // worth deduplicating, so they are excluded from matching.
  const excluded: Array<[number, number]> = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) ||
      ts.isImportEqualsDeclaration(statement) ||
      (ts.isExportDeclaration(statement) && statement.moduleSpecifier)
    ) {
      excluded.push([statement.getStart(sourceFile), statement.end]);
    }
  }

  const norm: number[] = [];
  const raw: number[] = [];
  const startLine: number[] = [];
  const endLine: number[] = [];
  const symbols: SymbolRange[] = [];

  let excludedIndex = 0;

  const lineOf = (position: number) =>
    sourceFile.getLineAndCharacterOfPosition(position).line + 1;

  const emit = (node: ts.Node) => {
    const start = node.getStart(sourceFile);
    const end = node.end;

    if (end <= start) return;

    while (
      excludedIndex < excluded.length &&
      excluded[excludedIndex][1] <= start
    ) {
      excludedIndex++;
    }

    if (
      excludedIndex < excluded.length &&
      start >= excluded[excludedIndex][0] &&
      start < excluded[excludedIndex][1]
    ) {
      return;
    }

    const kind = node.kind;

    // Optional semicolons would make otherwise identical code differ.
    if (kind === ts.SyntaxKind.SemicolonToken) return;

    if (kind === ts.SyntaxKind.JsxText) {
      const content = text.slice(start, end);
      if (content.trim() === "") return;
    }

    const rawText = text.slice(start, end);
    const rawKey = `${kind}:${rawText}`;

    let normKey: string;
    if (mode === "exact") {
      normKey = rawKey;
    } else if (isIdentifierKind(kind)) {
      normKey = "$id";
    } else if (isLiteralKind(kind)) {
      normKey = mode === "structural" ? "$lit" : rawKey;
    } else {
      normKey = `${kind}`;
    }

    norm.push(interner.intern(`n|${normKey}`));
    raw.push(interner.intern(`r|${rawKey}`));
    startLine.push(lineOf(start));
    endLine.push(lineOf(Math.max(start, end - 1)));
  };

  const walk = (node: ts.Node) => {
    if (
      node.kind >= ts.SyntaxKind.FirstJSDocNode &&
      node.kind <= ts.SyntaxKind.LastJSDocNode
    ) {
      return;
    }

    if (node.kind === ts.SyntaxKind.EndOfFileToken) return;

    const name = symbolNameFor(node, sourceFile);
    if (name) {
      symbols.push({
        name,
        startLine: lineOf(node.getStart(sourceFile)),
        endLine: lineOf(Math.max(node.getStart(sourceFile), node.end - 1)),
      });
    }

    const children = node.getChildren(sourceFile);

    if (children.length === 0) {
      if (node.kind !== ts.SyntaxKind.SyntaxList) emit(node);
      return;
    }

    for (const child of children) walk(child);
  };

  walk(sourceFile);

  return {
    relPath,
    lineCount: sourceFile.getLineAndCharacterOfPosition(text.length).line + 1,
    norm: Int32Array.from(norm),
    raw: Int32Array.from(raw),
    startLine: Int32Array.from(startLine),
    endLine: Int32Array.from(endLine),
    symbols,
  };
}

/* -------------------------------------------------------------------------- */
/*  Clone detection                                                           */
/* -------------------------------------------------------------------------- */

interface RunRecord {
  fileA: number;
  fileB: number;
  diagonal: number; // tokenB - tokenA
  starts: number[]; // ascending token starts in fileA
}

function windowsEqual(
  a: Int32Array,
  aStart: number,
  b: Int32Array,
  bStart: number,
  length: number,
): boolean {
  for (let offset = 0; offset < length; offset++) {
    if (a[aStart + offset] !== b[bStart + offset]) return false;
  }
  return true;
}

function hasVariety(
  tokens: Int32Array,
  start: number,
  length: number,
): boolean {
  const seen = new Set<number>();
  for (let offset = 0; offset < length; offset++) {
    seen.add(tokens[start + offset]);
  }
  return seen.size >= Math.max(6, Math.floor(length * 0.15));
}

function findClonePairs(
  files: FileTokens[],
  minTokens: number,
  warn: (message: string) => void,
): Array<[Fragment, Fragment]> {
  const windowSize = minTokens;

  let powA = 1;
  let powB = 1;
  for (let index = 1; index < windowSize; index++) {
    powA = (powA * BASE_A) % MOD_A;
    powB = (powB * BASE_B) % MOD_B;
  }

  const buckets = new Map<number, number | number[]>();
  const trivial = new Set<number>();
  const runs = new Map<string, RunRecord>();
  let recordedWindows = 0;
  let cappedBuckets = 0;
  let truncated = false;

  for (let fileIndex = 0; fileIndex < files.length && !truncated; fileIndex++) {
    const tokens = files[fileIndex].norm;
    const total = tokens.length;
    if (total < windowSize) continue;

    let hashA = 0;
    let hashB = 0;

    for (let index = 0; index < windowSize; index++) {
      const value = (tokens[index] % TOKEN_HASH_RANGE) + 1;
      hashA = (hashA * BASE_A + value) % MOD_A;
      hashB = (hashB * BASE_B + value) % MOD_B;
    }

    for (let start = 0; start + windowSize <= total; start++) {
      if (start > 0) {
        const outgoing = (tokens[start - 1] % TOKEN_HASH_RANGE) + 1;
        const incoming =
          (tokens[start + windowSize - 1] % TOKEN_HASH_RANGE) + 1;

        hashA =
          (((hashA - ((outgoing * powA) % MOD_A) + MOD_A) % MOD_A) * BASE_A +
            incoming) %
          MOD_A;
        hashB =
          (((hashB - ((outgoing * powB) % MOD_B) + MOD_B) % MOD_B) * BASE_B +
            incoming) %
          MOD_B;
      }

      const key = hashA * 1_000_003 + (hashB % 1_000_003);

      if (trivial.has(key)) continue;

      const packed = fileIndex * FILE_STRIDE + start;
      const existing = buckets.get(key);

      if (existing === undefined) {
        buckets.set(key, packed);
        continue;
      }

      const list: number[] =
        typeof existing === "number" ? [existing] : existing;

      if (typeof existing === "number") {
        const firstFile = Math.floor(existing / FILE_STRIDE);
        const firstStart = existing % FILE_STRIDE;

        if (!hasVariety(files[firstFile].norm, firstStart, windowSize)) {
          trivial.add(key);
          buckets.delete(key);
          continue;
        }
      }

      if (list.length >= MAX_BUCKET_SIZE) {
        cappedBuckets++;
        continue;
      }

      for (const earlier of list) {
        const earlierFile = Math.floor(earlier / FILE_STRIDE);
        const earlierStart = earlier % FILE_STRIDE;

        if (
          !windowsEqual(
            files[earlierFile].norm,
            earlierStart,
            tokens,
            start,
            windowSize,
          )
        ) {
          continue;
        }

        const diagonal = start - earlierStart;
        const runKey = `${earlierFile}:${fileIndex}:${diagonal}`;
        let record = runs.get(runKey);

        if (!record) {
          record = {
            fileA: earlierFile,
            fileB: fileIndex,
            diagonal,
            starts: [],
          };
          runs.set(runKey, record);
        }

        record.starts.push(earlierStart);
        recordedWindows++;
      }

      list.push(packed);
      if (typeof existing === "number") buckets.set(key, list);

      if (recordedWindows >= MAX_PAIR_WINDOWS) {
        truncated = true;
        break;
      }
    }
  }

  if (truncated) {
    warn(
      "The project has a very large amount of repeated code, so matching stopped early. Raise the minimum token count or analyze a smaller folder for complete results.",
    );
  }

  if (cappedBuckets > 0) {
    warn(
      "Some blocks are repeated so many times that only the first copies were compared.",
    );
  }

  const pairs: Array<[Fragment, Fragment]> = [];

  for (const record of runs.values()) {
    const starts = record.starts;
    let runStart = starts[0];
    let previous = starts[0];

    const flush = (first: number, last: number) => {
      let length = last - first + windowSize;

      // Same-file clones must not overlap each other.
      if (record.fileA === record.fileB) {
        if (record.diagonal < windowSize) return;
        length = Math.min(length, record.diagonal);
      }

      pairs.push([
        {
          file: record.fileA,
          tokenStart: first,
          tokenEnd: first + length - 1,
        },
        {
          file: record.fileB,
          tokenStart: first + record.diagonal,
          tokenEnd: first + record.diagonal + length - 1,
        },
      ]);
    };

    for (let index = 1; index < starts.length; index++) {
      if (starts[index] === previous + 1) {
        previous = starts[index];
        continue;
      }

      flush(runStart, previous);
      runStart = starts[index];
      previous = starts[index];
    }

    flush(runStart, previous);
  }

  return pairs;
}

/* -------------------------------------------------------------------------- */
/*  Grouping                                                                  */
/* -------------------------------------------------------------------------- */

interface Region {
  file: number;
  tokenStart: number;
  tokenEnd: number;
}

class DisjointSet {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(value: number): number {
    let root = value;
    while (this.parent[root] !== root) root = this.parent[root];

    let current = value;
    while (this.parent[current] !== root) {
      const next = this.parent[current];
      this.parent[current] = root;
      current = next;
    }

    return root;
  }

  union(a: number, b: number) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[rootB] = rootA;
  }
}

function buildRegionGroups(
  files: FileTokens[],
  pairs: Array<[Fragment, Fragment]>,
  minLines: number,
): Region[][] {
  // Drop pairs whose blocks are too short to be worth reporting.
  const usable = pairs.filter(([a, b]) => {
    const linesA =
      files[a.file].endLine[a.tokenEnd] -
      files[a.file].startLine[a.tokenStart] +
      1;
    const linesB =
      files[b.file].endLine[b.tokenEnd] -
      files[b.file].startLine[b.tokenStart] +
      1;
    return linesA >= minLines && linesB >= minLines;
  });

  // Fragments from different pairs often overlap, so merge overlapping
  // fragments per file into one region first.
  const fragments: Fragment[] = [];
  for (const [a, b] of usable) {
    fragments.push(a, b);
  }

  const byFile = new Map<number, number[]>();
  fragments.forEach((fragment, index) => {
    const list = byFile.get(fragment.file) ?? [];
    list.push(index);
    byFile.set(fragment.file, list);
  });

  const regions: Region[] = [];
  const regionOfFragment = new Array<number>(fragments.length).fill(-1);

  for (const [file, indexes] of byFile) {
    indexes.sort(
      (a, b) =>
        fragments[a].tokenStart - fragments[b].tokenStart ||
        fragments[a].tokenEnd - fragments[b].tokenEnd,
    );

    let current: Region | undefined;

    for (const index of indexes) {
      const fragment = fragments[index];

      if (current && fragment.tokenStart <= current.tokenEnd) {
        current.tokenEnd = Math.max(current.tokenEnd, fragment.tokenEnd);
      } else {
        current = {
          file,
          tokenStart: fragment.tokenStart,
          tokenEnd: fragment.tokenEnd,
        };
        regions.push(current);
      }

      regionOfFragment[index] = regions.length - 1;
    }
  }

  const sets = new DisjointSet(regions.length);
  for (let index = 0; index < usable.length; index++) {
    sets.union(regionOfFragment[index * 2], regionOfFragment[index * 2 + 1]);
  }

  const grouped = new Map<number, Region[]>();
  regions.forEach((region, index) => {
    const root = sets.find(index);
    const list = grouped.get(root) ?? [];
    list.push(region);
    grouped.set(root, list);
  });

  return [...grouped.values()].filter((group) => group.length >= 2);
}

/* -------------------------------------------------------------------------- */
/*  Scoring and suggestions                                                   */
/* -------------------------------------------------------------------------- */

function scoreGroup(
  type: DuplicateType,
  lines: number,
  copies: number,
  duplicatedLines: number,
): number {
  const raw =
    9 * Math.log2(1 + duplicatedLines) +
    5 * (copies - 1) +
    (type === "exact" ? 6 : 0) +
    Math.min(8, lines / 10);

  return Math.max(1, Math.min(100, Math.round(raw)));
}

function severityFor(score: number): DuplicateSeverity {
  if (score >= 75) return "critical";
  if (score >= 58) return "high";
  if (score >= 40) return "medium";
  if (score >= 22) return "low";
  return "info";
}

function toCamelCase(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);

  if (words.length === 0) return "";

  return words
    .map((word, index) =>
      index === 0
        ? word.charAt(0).toLowerCase() + word.slice(1)
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join("");
}

function toPascalCase(value: string): string {
  const camel = toCamelCase(value);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

function commonDirectory(paths: string[]): string {
  const split = paths.map((item) => path.posix.dirname(item).split("/"));
  const first = split[0];
  const shared: string[] = [];

  for (let index = 0; index < first.length; index++) {
    if (split.every((parts) => parts[index] === first[index])) {
      shared.push(first[index]);
    } else {
      break;
    }
  }

  const joined = shared.join("/");
  return joined === "." ? "" : joined;
}

function looksLikeJsx(snippet: string): boolean {
  return /<\/?[A-Za-z][\w.]*(\s|>|\/)/.test(snippet);
}

function buildSuggestion(
  type: DuplicateType,
  scope: DuplicateScope,
  mode: MatchMode,
  fragments: DuplicateFragment[],
  instanceCount: number,
): DuplicateSuggestion {
  const jsxBlock =
    fragments.every((fragment) => /\.[jt]sx$/.test(fragment.filePath)) &&
    looksLikeJsx(fragments[0].snippet);

  const symbols = fragments
    .map((fragment) => fragment.symbol)
    .filter((symbol): symbol is string => Boolean(symbol));
  const sameSymbol =
    symbols.length === fragments.length && new Set(symbols).size === 1;

  const confidence: DuplicateSuggestion["confidence"] =
    type === "exact" ? "high" : mode === "structural" ? "low" : "medium";

  const caveats: string[] = [];

  if (type === "renamed") {
    caveats.push(
      "These copies are not identical. Compare them side by side and turn every difference into a parameter before merging.",
    );
  }

  if (mode === "structural") {
    caveats.push(
      "Structural matching ignores literal values, so similar-looking data tables can appear here. Confirm the logic is really shared.",
    );
  }

  const firstFragment = fragments[0];
  const location = `${firstFragment.filePath} (lines ${firstFragment.startLine}-${firstFragment.endLine})`;

  if (sameSymbol && scope === "cross-file" && type === "exact") {
    const name = symbols[0];
    return {
      strategy: "keep-one-copy",
      confidence,
      title: `Keep one copy of ${name}`,
      summary: `${name} is defined ${instanceCount} times with the same code. Keep a single exported definition and import it everywhere else.`,
      steps: [
        `Pick the best home for ${name}, for example the copy in ${firstFragment.filePath}.`,
        "Export it from there and delete the other definitions.",
        "Import it where the deleted copies were, then run your type-check and tests.",
      ],
      suggestedName: name,
      suggestedPath: firstFragment.filePath,
      caveats,
    };
  }

  if (scope === "same-file") {
    const base = symbols[0] ? toCamelCase(symbols[0]) : "sharedBlock";
    const helper = jsxBlock ? toPascalCase(base) || "SharedBlock" : `${base}Helper`;

    return {
      strategy: jsxBlock ? "extract-component" : "extract-local-helper",
      confidence,
      title: jsxBlock
        ? "Extract a component in this file"
        : "Extract a helper in this file",
      summary: `The same block appears ${instanceCount} times in ${firstFragment.filePath}. Move it into one ${jsxBlock ? "component" : "helper"} and call it from each place.`,
      steps: [
        `Create ${jsxBlock ? "a component" : "a function"} named ${helper} above the first copy.`,
        `Move the code from ${location} into it.`,
        `Turn anything that differs between the copies into ${jsxBlock ? "props" : "parameters"}.`,
        `Replace each copy with ${jsxBlock ? `<${helper} />` : `${helper}(...)`}.`,
        "Run your type-check and tests.",
      ],
      suggestedName: helper,
      caveats,
    };
  }

  const directory = commonDirectory(fragments.map((item) => item.filePath));
  const baseName = symbols[0]
    ? toCamelCase(symbols[0])
    : jsxBlock
      ? "sharedBlock"
      : "sharedLogic";
  const name = jsxBlock ? toPascalCase(baseName) : baseName;
  const fileName = `${name}${jsxBlock ? ".tsx" : ".ts"}`;
  const suggestedPath = directory
    ? path.posix.join(directory, "shared", fileName)
    : path.posix.join("shared", fileName);

  return {
    strategy: jsxBlock ? "extract-component" : "extract-shared-module",
    confidence,
    title: jsxBlock
      ? "Extract a shared component"
      : "Extract a shared function",
    summary: `${instanceCount} files contain the same ${jsxBlock ? "markup and logic" : "logic"}. Put it in one shared module so a fix only has to be made once.`,
    steps: [
      `Create ${suggestedPath} and export ${name} from it.`,
      `Move the code from ${location} into it.`,
      `Turn anything that differs between the copies into ${jsxBlock ? "props" : "parameters"}.`,
      `Import ${name} in each of the ${instanceCount} files and delete the duplicated block.`,
      "Run your type-check and tests.",
    ],
    suggestedName: name,
    suggestedPath,
    caveats,
  };
}

/* -------------------------------------------------------------------------- */
/*  Snippets                                                                  */
/* -------------------------------------------------------------------------- */

function dedent(lines: string[]): string[] {
  let indent = Infinity;

  for (const line of lines) {
    if (line.trim() === "") continue;
    const leading = line.match(/^[\t ]*/)![0].length;
    indent = Math.min(indent, leading);
  }

  if (!Number.isFinite(indent) || indent === 0) return lines;
  return lines.map((line) => line.slice(Math.min(indent, line.length)));
}

/* -------------------------------------------------------------------------- */
/*  Main analysis                                                             */
/* -------------------------------------------------------------------------- */

export async function detectDuplicateCode(
  projectPath: string,
  filePath?: string,
  options: {
    minTokens?: number;
    minLines?: number;
    matchMode?: MatchMode;
    includeTests?: boolean;
  } = {},
): Promise<DuplicateCodeReport> {
  const minTokens = options.minTokens ?? DEFAULT_MIN_TOKENS;
  const minLines = options.minLines ?? DEFAULT_MIN_LINES;
  const matchMode = options.matchMode ?? "renamed";
  const includeTests = options.includeTests ?? false;

  if (
    filePath !== undefined &&
    (path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes(".."))
  ) {
    throw new Error("filePath must be relative to projectPath.");
  }

  if (!Number.isInteger(minTokens) || minTokens < 20 || minTokens > 500) {
    throw new Error("minTokens must be an integer between 20 and 500.");
  }

  if (!Number.isInteger(minLines) || minLines < 2 || minLines > 100) {
    throw new Error("minLines must be an integer between 2 and 100.");
  }

  const resolvedProject = await resolveProjectPath(projectPath);
  const root = fs.realpathSync(resolvedProject.projectPath);
  const warnings: string[] = [];

  const warn = (message: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message);
    else if (warnings.length === MAX_WARNINGS) {
      warnings.push("Further warnings were omitted.");
    }
  };

  const discovered = discoverSourceFiles(root);

  if (discovered.truncated) {
    warn(
      `Only the first ${MAX_FILES} source files were analyzed. Narrow the project path for complete results.`,
    );
  }

  const relative = (absolute: string) =>
    normalizePath(path.relative(root, absolute));

  const candidates = discovered.files.filter(
    (file) => includeTests || !TEST_FILE_PATTERN.test(relative(file)),
  );

  if (candidates.length === 0) {
    throw new Error(
      `No JavaScript or TypeScript source files were found in ${root}.`,
    );
  }

  /* ---- Tokenize ---- */

  const interner = new Interner();
  const files: FileTokens[] = [];
  let tokensAnalyzed = 0;
  let totalLines = 0;

  for (const absolute of candidates) {
    let text: string;

    try {
      if (fs.statSync(absolute).size > MAX_FILE_BYTES) {
        warn(`Skipped ${relative(absolute)} because it is larger than 1 MB.`);
        continue;
      }
      text = fs.readFileSync(absolute, "utf8");
    } catch {
      warn(`Could not read ${relative(absolute)}.`);
      continue;
    }

    if (tokensAnalyzed >= MAX_TOTAL_TOKENS) {
      warn(
        "The token limit was reached, so the remaining files were skipped. Narrow the project path for complete results.",
      );
      break;
    }

    const tokenized = tokenizeFile(
      absolute,
      relative(absolute),
      text,
      matchMode,
      interner,
    );

    tokensAnalyzed += tokenized.norm.length;
    totalLines += tokenized.lineCount;
    files.push(tokenized);
  }

  /* ---- Detect ---- */

  const pairs = findClonePairs(files, minTokens, warn);
  const regionGroups = buildRegionGroups(files, pairs, minLines);

  const lineCache = new Map<number, string[]>();
  const readLines = (fileIndex: number): string[] => {
    let lines = lineCache.get(fileIndex);

    if (!lines) {
      try {
        lines = fs
          .readFileSync(path.join(root, files[fileIndex].relPath), "utf8")
          .split(/\r?\n/);
      } catch {
        lines = [];
      }
      lineCache.set(fileIndex, lines);
    }

    return lines;
  };

  const allGroups: DuplicateGroup[] = [];

  for (const regions of regionGroups) {
    regions.sort(
      (a, b) =>
        files[a.file].relPath.localeCompare(files[b.file].relPath) ||
        a.tokenStart - b.tokenStart,
    );

    const measured = regions.map((region) => {
      const file = files[region.file];
      const startLine = file.startLine[region.tokenStart];
      const endLine = file.endLine[region.tokenEnd];

      return {
        region,
        file,
        startLine,
        endLine,
        lines: endLine - startLine + 1,
        tokens: region.tokenEnd - region.tokenStart + 1,
      };
    });

    // Exact when every copy has the same raw token sequence.
    const signatures = new Set(
      measured.map(({ file, region }) => {
        const hash = createHash("sha1");
        const slice = file.raw.subarray(
          region.tokenStart,
          region.tokenEnd + 1,
        );
        hash.update(Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength));
        return hash.digest("hex");
      }),
    );

    const type: DuplicateType = signatures.size === 1 ? "exact" : "renamed";
    const scope: DuplicateScope =
      new Set(measured.map((item) => item.region.file)).size > 1
        ? "cross-file"
        : "same-file";

    const lineCounts = measured.map((item) => item.lines);
    const tokenCounts = measured.map((item) => item.tokens);
    const duplicatedLines =
      lineCounts.reduce((sum, value) => sum + value, 0) -
      Math.max(...lineCounts);
    const typicalLines = median(lineCounts);
    const instanceCount = measured.length;
    const score = scoreGroup(type, typicalLines, instanceCount, duplicatedLines);

    const fragments: DuplicateFragment[] = measured
      .slice(0, MAX_FRAGMENTS_PER_GROUP)
      .map((item) => {
        const source = readLines(item.region.file).slice(
          item.startLine - 1,
          item.endLine,
        );
        const capped = source.slice(0, MAX_SNIPPET_LINES);
        const symbol = item.file.symbols
          .filter(
            (candidate) =>
              candidate.startLine <= item.startLine &&
              candidate.endLine >= item.startLine,
          )
          .sort(
            (a, b) =>
              a.endLine - a.startLine - (b.endLine - b.startLine),
          )[0]?.name;

        return {
          filePath: item.file.relPath,
          startLine: item.startLine,
          endLine: item.endLine,
          lines: item.lines,
          tokens: item.tokens,
          fileLines: item.file.lineCount,
          symbol,
          snippet: dedent(capped).join("\n"),
          snippetTruncated: source.length > capped.length,
        };
      });

    const suggestion = buildSuggestion(
      type,
      scope,
      matchMode,
      fragments,
      instanceCount,
    );

    const fileCount = new Set(measured.map((item) => item.region.file)).size;
    const typeLabel = type === "exact" ? "Exact duplicate" : "Near duplicate";

    const id = createHash("sha1")
      .update(
        measured
          .map((item) => `${item.file.relPath}:${item.startLine}-${item.endLine}`)
          .join("|"),
      )
      .digest("hex")
      .slice(0, 10);

    allGroups.push({
      id,
      severity: severityFor(score),
      type,
      scope,
      score,
      lines: typicalLines,
      tokens: median(tokenCounts),
      instanceCount,
      duplicatedLines,
      title: `${typeLabel} · ${typicalLines} lines × ${instanceCount}`,
      description:
        scope === "same-file"
          ? `The same ${typicalLines}-line block appears ${instanceCount} times in ${fragments[0].filePath}. ${
              type === "exact"
                ? "The copies are identical apart from formatting and comments."
                : "The copies share the same structure but differ in names or values."
            }`
          : `The same ${typicalLines}-line block appears in ${fileCount} files (${instanceCount} copies). ${
              type === "exact"
                ? "The copies are identical apart from formatting and comments."
                : "The copies share the same structure but differ in names or values."
            } A bug fixed in one copy will stay in the others.`,
      recommendation: suggestion.summary,
      fragments,
      hiddenInstances: Math.max(0, instanceCount - fragments.length),
      suggestion,
    });
  }

  allGroups.sort(
    (a, b) =>
      b.score - a.score ||
      b.duplicatedLines - a.duplicatedLines ||
      a.id.localeCompare(b.id),
  );

  /* ---- Totals (before any focus filter) ---- */

  const projectGroupCount = allGroups.length;

  const focusFile = filePath ? normalizePath(filePath) : undefined;

  const scoped = focusFile
    ? allGroups.filter((group) =>
        group.fragments.some((fragment) => fragment.filePath === focusFile),
      )
    : allGroups;

  if (focusFile && !files.some((file) => file.relPath === focusFile)) {
    warn(
      `${focusFile} was not found among the analyzed files, so no groups can include it.`,
    );
  }

  const reported = scoped.slice(0, MAX_GROUPS);

  if (scoped.length > reported.length) {
    warn(
      `Showing the top ${MAX_GROUPS} of ${scoped.length} duplicate groups, ranked by impact.`,
    );
  }

  const perFile = new Map<
    string,
    { lines: number; groups: number; fileLines: number }
  >();

  const totalCopies = reported.reduce(
    (sum, group) => sum + group.instanceCount,
    0,
  );

  for (const group of reported) {
    for (const fragment of group.fragments) {
      const entry = perFile.get(fragment.filePath) ?? {
        lines: 0,
        groups: 0,
        fileLines: fragment.fileLines,
      };
      entry.lines += fragment.lines;
      entry.groups += 1;
      perFile.set(fragment.filePath, entry);
    }
  }

  const duplicatedLines = reported.reduce(
    (sum, group) => sum + group.duplicatedLines,
    0,
  );

  const summary: Record<DuplicateSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };

  for (const group of reported) summary[group.severity]++;

  const hotspots: DuplicateHotspot[] = [...perFile.entries()]
    .map(([file, entry]) => ({
      filePath: file,
      duplicatedLines: entry.lines,
      groupCount: entry.groups,
      fileLines: entry.fileLines,
      percentage: Math.min(
        100,
        Math.round((entry.lines / Math.max(1, entry.fileLines)) * 1000) / 10,
      ),
    }))
    .sort(
      (a, b) =>
        b.duplicatedLines - a.duplicatedLines ||
        a.filePath.localeCompare(b.filePath),
    )
    .slice(0, MAX_HOTSPOTS);

  return {
    success: true,
    tool: "detect_duplicate_code",
    projectPath: root,
    filePath: focusFile,
    matchMode,
    minTokens,
    minLines,
    includeTests,
    filesScanned: files.length,
    tokensAnalyzed,
    totalLines,
    totalGroups: reported.length,
    projectGroupCount,
    totalCopies,
    duplicatedLines,
    duplicationPercentage:
      totalLines === 0
        ? 0
        : Math.round((duplicatedLines / totalLines) * 1000) / 10,
    exactGroups: reported.filter((group) => group.type === "exact").length,
    renamedGroups: reported.filter((group) => group.type === "renamed").length,
    crossFileGroups: reported.filter((group) => group.scope === "cross-file")
      .length,
    sameFileGroups: reported.filter((group) => group.scope === "same-file")
      .length,
    filesAffected: perFile.size,
    summary,
    groups: reported,
    hotspots,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/*  MCP registration                                                          */
/* -------------------------------------------------------------------------- */

export function registerDetectDuplicateCodeTool(server: McpServer) {
  server.registerTool(
    "detect_duplicate_code",
    {
      description:
        "Detect duplicated code in a JavaScript/TypeScript project. Tokenizes every file with the TypeScript parser (ignoring comments, formatting and import lines), finds repeated token sequences, and reports clone groups as exact or renamed copies with the file locations, source snippets, an impact score, and a suggested refactor (extract a function, component or shared module).",
      inputSchema: z.object({
        projectPath: z
          .string()
          .describe("Absolute path to the project directory"),
        filePath: z
          .string()
          .optional()
          .describe(
            "Optional file, relative to projectPath. When set, only duplicate groups that include this file are reported.",
          ),
        minTokens: z
          .number()
          .int()
          .min(20)
          .max(500)
          .optional()
          .describe(
            "Minimum length of a duplicated block in tokens. Default 50.",
          ),
        minLines: z
          .number()
          .int()
          .min(2)
          .max(100)
          .optional()
          .describe(
            "Minimum length of a duplicated block in lines. Default 5.",
          ),
        matchMode: z
          .enum(["exact", "renamed", "structural"])
          .optional()
          .describe(
            "exact: identical tokens. renamed (default): identifiers may differ. structural: identifiers and literal values may differ.",
          ),
        includeTests: z
          .boolean()
          .optional()
          .describe(
            "Include test, mock and story files. Default false.",
          ),
      }),
    },
    async ({ projectPath, filePath, minTokens, minLines, matchMode, includeTests }) => {
      try {
        const report = await detectDuplicateCode(projectPath, filePath, {
          minTokens,
          minLines,
          matchMode,
          includeTests,
        });

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
                  tool: "detect_duplicate_code",
                  error:
                    error instanceof Error
                      ? error.message
                      : "Failed to detect duplicate code.",
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
