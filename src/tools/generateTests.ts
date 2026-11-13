import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveProjectPath } from "../utils/projectResolver.js";

/* -------------------------------------------------------------------------- */
/*  Public types                                                              */
/* -------------------------------------------------------------------------- */

type TestSeverity = "critical" | "high" | "medium" | "low" | "info";
type UnitKind = "function" | "method" | "component" | "hook";
type TestStatus = "untested" | "partial" | "tested";
type FrameworkName = "vitest" | "jest";
type FrameworkChoice = "auto" | FrameworkName;

type ScenarioCategory =
  | "happy"
  | "branch"
  | "edge"
  | "error"
  | "async"
  | "render"
  | "interaction"
  | "state";

/**
 * exact    - the expected value comes straight from the source code.
 * shape    - checks a type or "does not throw"; correct without knowing the value.
 * scaffold - the developer must add the expected value.
 */
type AssertionLevel = "exact" | "shape" | "scaffold";

interface ParamInfo {
  name: string;
  type: string;
  optional: boolean;
  defaultValue?: string;
  rest: boolean;
}

interface TestScenario {
  id: string;
  title: string;
  category: ScenarioCategory;
  assertion: AssertionLevel;
  /** Plain-language reason this test exists. */
  reason: string;
  line?: number;
}

interface SourceSnippet {
  startLine: number;
  endLine: number;
  snippet: string;
  truncated: boolean;
}

interface TestTarget {
  id: string;
  name: string;
  kind: UnitKind;
  exportKind: "named" | "default";
  filePath: string;
  startLine: number;
  endLine: number;
  fileLines: number;
  signature: string;
  async: boolean;
  params: ParamInfo[];
  complexity: number;
  branches: number;
  throwsCount: number;
  /** Things the generated tests replace or fake (network, timers, modules ...). */
  mocks: string[];
  status: TestStatus;
  existingTests: number;
  existingTestFile?: string;
  priority: TestSeverity;
  score: number;
  title: string;
  description: string;
  scenarios: TestScenario[];
  source: SourceSnippet;
  testPath: string;
  testAction: "create" | "append";
  /** Imports, mocks and environment line needed by this unit's tests. */
  setupCode: string;
  /** The describe block for this unit. */
  testCode: string;
  runCommand: string;
  caveats: string[];
}

interface GeneratedTestFile {
  sourcePath: string;
  testPath: string;
  action: "create" | "append";
  framework: FrameworkName;
  units: number;
  scenarios: number;
  needsReview: number;
  content: string;
  runCommand: string;
}

interface TestSetup {
  packagePath: string;
  detected: FrameworkName | "none";
  framework: FrameworkName;
  frameworkSource: string;
  libraries: string[];
  hasTestScript: boolean;
  placement: "colocated" | "tests-folder" | "mirror";
  existingTestFiles: number;
  units: number;
  missing: string[];
  installCommand?: string;
  notes: string[];
}

interface TestHotspot {
  filePath: string;
  untested: number;
  complexity: number;
  worstPriority: TestSeverity;
}

interface TestGeneratorReport {
  success: boolean;
  tool: "generate_tests";
  projectPath: string;
  filePath?: string;
  framework: FrameworkChoice;
  includeTested: boolean;
  filesScanned: number;
  totalLines: number;
  testFilesFound: number;
  unitsFound: number;
  untestedUnits: number;
  partialUnits: number;
  testedUnits: number;
  /** Share of units that already have enough tests. */
  coveragePercentage: number;
  totalTargets: number;
  scenariosGenerated: number;
  scenariosNeedingReview: number;
  filesToWrite: number;
  summary: Record<TestSeverity, number>;
  targets: TestTarget[];
  files: GeneratedTestFile[];
  setups: TestSetup[];
  hotspots: TestHotspot[];
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/*  Internal types                                                            */
/* -------------------------------------------------------------------------- */

type FnNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration;

interface ImportRef {
  specifier: string;
  imported: string;
}

interface ParsedFile {
  index: number;
  abs: string;
  rel: string;
  text: string;
  sf: ts.SourceFile;
  lineCount: number;
  lines?: string[];
  isTest: boolean;
  isTs: boolean;
  imports: Map<string, ImportRef>;
  topLevel: Map<string, ts.Node>;
  exportedNames: Map<string, string>;
  exportsDefault?: string;
}

interface Ctx {
  root: string;
  files: ParsedFile[];
  byAbs: Map<string, ParsedFile>;
  moduleCache: Map<string, ParsedFile | null>;
}

interface Dialect {
  name: FrameworkName;
  /** The mocking global: `vi` or `jest`. */
  vi: "vi" | "jest";
}

interface SampleCtx {
  file: ParsedFile;
  ctx: Ctx;
  d: Dialect;
}

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

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
  /(^|\/)(__tests__|__mocks__|tests?|e2e|cypress)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const IGNORED_SOURCE_PATTERN =
  /\.stories\.[cm]?[jt]sx?$|(^|\/)[\w.-]*\.config\.[cm]?[jt]s$|\.d\.[cm]?ts$|\.min\.[cm]?js$/;

const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_TARGETS = 150;
const MAX_FILES_OUTPUT = 60;
const MAX_SCENARIOS_PER_UNIT = 14;
const MAX_SNIPPET_LINES = 40;
const MAX_HOTSPOTS = 15;
const MAX_WARNINGS = 25;
const MAX_METHODS_PER_CLASS = 12;

const NODE_IO_MODULES = new Set([
  "fs",
  "node:fs",
  "fs/promises",
  "node:fs/promises",
  "child_process",
  "node:child_process",
  "http",
  "node:http",
  "https",
  "node:https",
  "net",
  "node:net",
]);

const IO_PACKAGES =
  /^(axios|node-fetch|got|ky|pg|mysql2?|mongodb|mongoose|redis|ioredis|@prisma\/client|@aws-sdk\/.+|firebase(\/.+)?|firebase-admin(\/.+)?)$/;

const IO_RELATIVE = /(api|client|service|http|fetch|db|database|repo|repository|storage|firebase)/i;

const ROUTER_HOOKS = new Set([
  "useNavigate",
  "useParams",
  "useLocation",
  "useSearchParams",
  "Link",
  "NavLink",
  "Navigate",
  "Outlet",
]);

const BUILTIN_TYPE_SAMPLES: Record<string, string> = {
  Date: 'new Date("2024-01-01T00:00:00.000Z")',
  Map: "new Map()",
  Set: "new Set()",
  RegExp: "/test/",
  Error: 'new Error("error")',
  URL: 'new URL("https://example.com")',
  ReactNode: '"content"',
  ReactElement: '"content"',
  Element: '"content"',
  CSSProperties: "{}",
};

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

function normalizeFsPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function shortHash(...parts: string[]): string {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 10);
}

function lineOf(sf: ts.SourceFile, position: number): number {
  return sf.getLineAndCharacterOfPosition(position).line + 1;
}

function startLineOf(node: ts.Node): number {
  return lineOf(node.getSourceFile(), node.getStart());
}

function endLineOf(node: ts.Node): number {
  return lineOf(node.getSourceFile(), Math.max(node.getStart(), node.end - 1));
}

function scriptKindFor(file: string): ts.ScriptKind {
  const extension = path.extname(file);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isFnNode(node: ts.Node): node is FnNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

function unwrapExpr(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

function walk(node: ts.Node, visit: (node: ts.Node) => boolean | void): void {
  if (visit(node) === false) return;
  ts.forEachChild(node, (child) => {
    walk(child, visit);
  });
}

/** Like `walk`, but does not enter nested functions. */
function walkOwn(root: ts.Node, visit: (node: ts.Node) => void): void {
  const step = (node: ts.Node) => {
    if (node !== root && isFnNode(node)) return;
    visit(node);
    ts.forEachChild(node, step);
  };
  step(root);
}

function propertyNameText(name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return undefined;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)
    : false;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function indentLines(lines: string[], spaces: number): string[] {
  const pad = " ".repeat(spaces);
  return lines.map((line) => (line === "" ? "" : pad + line));
}

function dedent(lines: string[]): string[] {
  let indent = Infinity;
  for (const line of lines) {
    if (line.trim() === "") continue;
    indent = Math.min(indent, line.match(/^[\t ]*/)![0].length);
  }
  if (!Number.isFinite(indent) || indent === 0) return lines;
  return lines.map((line) => line.slice(Math.min(indent, line.length)));
}

function titleCase(value: string): string {
  return value
    .replace(/[^A-Za-z0-9]+(.)?/g, (_, next: string | undefined) => (next ? next.toUpperCase() : ""))
    .replace(/^./, (first) => first.toUpperCase());
}

function shorten(value: string, max = 60): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function fileLinesOf(file: ParsedFile): string[] {
  file.lines ??= file.text.split(/\r?\n/);
  return file.lines;
}

/* -------------------------------------------------------------------------- */
/*  Discovery, parsing and indexing                                           */
/* -------------------------------------------------------------------------- */

function discoverFiles(root: string): {
  files: string[];
  packageJsons: string[];
  truncated: boolean;
} {
  const files: string[] = [];
  const packageJsons: string[] = [];
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
        if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
        stack.push({ dir: absolute, depth: depth + 1 });
        continue;
      }

      if (!entry.isFile()) continue;

      if (entry.name === "package.json" && depth <= 4) {
        packageJsons.push(absolute);
        continue;
      }

      if (entry.name.startsWith(".") || !SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;

      if (files.length >= MAX_FILES) {
        truncated = true;
        continue;
      }

      files.push(absolute);
    }
  }

  files.sort();
  packageJsons.sort();
  return { files, packageJsons, truncated };
}

function parseRequire(
  expression: ts.Expression | undefined,
): { specifier: string; member?: string } | undefined {
  if (!expression) return undefined;

  let current = unwrapExpr(expression);
  let member: string | undefined;

  if (ts.isPropertyAccessExpression(current)) {
    member = current.name.text;
    current = unwrapExpr(current.expression);
  }

  if (
    ts.isCallExpression(current) &&
    ts.isIdentifier(current.expression) &&
    current.expression.text === "require" &&
    current.arguments.length >= 1 &&
    ts.isStringLiteralLike(current.arguments[0])
  ) {
    return { specifier: current.arguments[0].text, member };
  }

  return undefined;
}

function indexFile(file: ParsedFile): void {
  for (const statement of file.sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (!clause) continue;

      if (clause.name) file.imports.set(clause.name.text, { specifier, imported: "default" });

      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          file.imports.set(clause.namedBindings.name.text, { specifier, imported: "*" });
        } else {
          for (const element of clause.namedBindings.elements) {
            file.imports.set(element.name.text, {
              specifier,
              imported: (element.propertyName ?? element.name).text,
            });
          }
        }
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);

      for (const declaration of statement.declarationList.declarations) {
        const required = parseRequire(declaration.initializer);

        if (ts.isIdentifier(declaration.name)) {
          if (required) {
            file.imports.set(declaration.name.text, {
              specifier: required.specifier,
              imported: required.member ?? "default",
            });
          } else {
            file.topLevel.set(declaration.name.text, declaration);
            if (exported) file.exportedNames.set(declaration.name.text, declaration.name.text);
          }
        } else if (ts.isObjectBindingPattern(declaration.name) && required) {
          for (const element of declaration.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            file.imports.set(element.name.text, {
              specifier: required.specifier,
              imported:
                (element.propertyName ? propertyNameText(element.propertyName) : undefined) ??
                element.name.text,
            });
          }
        }
      }
      continue;
    }

    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      const name = statement.name?.text;
      const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
      const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);

      if (name) file.topLevel.set(name, statement);

      if (exported && isDefault) {
        if (name) {
          file.exportsDefault = name;
        } else {
          file.topLevel.set("default", statement);
          file.exportsDefault = "default";
        }
      } else if (exported && name) {
        file.exportedNames.set(name, name);
      }
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      const expression = unwrapExpr(statement.expression);
      if (ts.isIdentifier(expression)) {
        file.exportsDefault = expression.text;
      } else {
        file.topLevel.set("default", expression);
        file.exportsDefault = "default";
      }
      continue;
    }

    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const exported = element.name.text;
          const local = (element.propertyName ?? element.name).text;
          if (exported === "default") file.exportsDefault = local;
          else file.exportedNames.set(exported, local);
        }
      }
      continue;
    }

    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const left = statement.expression.left.getText();
      const right = unwrapExpr(statement.expression.right);

      if (left === "module.exports") {
        if (ts.isIdentifier(right)) {
          file.exportsDefault = right.text;
        } else if (ts.isObjectLiteralExpression(right)) {
          for (const property of right.properties) {
            if (ts.isShorthandPropertyAssignment(property)) {
              file.exportedNames.set(property.name.text, property.name.text);
            } else if (ts.isPropertyAssignment(property)) {
              const key = propertyNameText(property.name);
              const value = unwrapExpr(property.initializer);
              if (key && ts.isIdentifier(value)) file.exportedNames.set(key, value.text);
            }
          }
        }
      } else {
        const match = /^(?:module\.)?exports\.(\w+)$/.exec(left);
        if (match && ts.isIdentifier(right)) file.exportedNames.set(match[1], right.text);
      }
    }
  }
}

function resolveModule(from: ParsedFile, specifier: string, ctx: Ctx): ParsedFile | undefined {
  const cacheKey = `${from.abs}|${specifier}`;
  const cached = ctx.moduleCache.get(cacheKey);
  if (cached !== undefined) return cached ?? undefined;

  const bases: string[] = [];

  if (specifier.startsWith(".")) {
    bases.push(path.resolve(path.dirname(from.abs), specifier));
  } else if (/^[@~]\//.test(specifier)) {
    const rest = specifier.slice(2);
    bases.push(path.join(ctx.root, "src", rest), path.join(ctx.root, rest));
  } else if (specifier.startsWith("src/")) {
    bases.push(path.join(ctx.root, specifier));
  }

  let found: ParsedFile | undefined;

  for (const base of bases) {
    const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
    const candidates = [
      base,
      ...RESOLVE_EXTENSIONS.map((extension) => base + extension),
      ...RESOLVE_EXTENSIONS.map((extension) => stripped + extension),
      ...RESOLVE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
    ];

    for (const candidate of candidates) {
      const hit = ctx.byAbs.get(candidate);
      if (hit) {
        found = hit;
        break;
      }
    }
    if (found) break;
  }

  ctx.moduleCache.set(cacheKey, found ?? null);
  return found;
}

/** Finds a top-level declaration (type, class, function ...) by name, following imports. */
function lookupTopLevel(
  file: ParsedFile,
  name: string,
  ctx: Ctx,
  depth = 0,
): { file: ParsedFile; node: ts.Node } | undefined {
  if (depth > 5) return undefined;

  const local = file.topLevel.get(name);
  if (local) return { file, node: local };

  const reference = file.imports.get(name);
  if (!reference) return undefined;

  const target = resolveModule(file, reference.specifier, ctx);
  if (!target) return undefined;

  if (reference.imported === "default") {
    const defaultName = target.exportsDefault;
    return defaultName ? lookupTopLevel(target, defaultName, ctx, depth + 1) : undefined;
  }

  const exportedLocal = target.exportedNames.get(reference.imported) ?? reference.imported;
  return lookupTopLevel(target, exportedLocal, ctx, depth + 1);
}

/* -------------------------------------------------------------------------- */
/*  Sample values                                                             */
/* -------------------------------------------------------------------------- */

const NAME_SAMPLES: Array<[RegExp, string]> = [
  [/email/i, '"user@example.com"'],
  [/(url|href|link|endpoint)/i, '"https://example.com"'],
  [/password/i, '"Passw0rd!"'],
  [/(token|secret|apikey)/i, '"token-123"'],
  [/(^id$|Id$|_id$)/, '"id-1"'],
  [/(name|title|label)/i, '"Test name"'],
  [/(path|file|dir)/i, '"src/index.ts"'],
  [/(date|time)/i, '"2024-01-01"'],
  [/phone/i, '"555-0100"'],
];

function sampleForName(name: string): string {
  for (const [pattern, value] of NAME_SAMPLES) {
    if (pattern.test(name)) return value;
  }
  return '"sample"';
}

function sampleNumber(name: string): string {
  if (/(price|total|amount|cost)/i.test(name)) return "10";
  if (/(timeout|delay|ms)$/i.test(name)) return "100";
  return "1";
}

function castAny(value: string, sc: SampleCtx): string {
  return sc.file.isTs ? `${value} as any` : value;
}

function typeName(node: ts.TypeReferenceNode): string {
  return ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.right.text;
}

type ValueKind = "string" | "number" | "boolean" | "array" | "object" | "function" | "unknown";

function valueKindOf(node: ts.TypeNode | undefined, name: string): ValueKind {
  if (!node) {
    if (/^(on|handle)[A-Z]/.test(name)) return "function";
    if (/^(is|has|should|can|show|enable|disable)[A-Z]|^(disabled|loading|open|visible|checked)$/.test(name)) {
      return "boolean";
    }
    if (/(count|page|limit|index|size|total|amount|price|age|num)/i.test(name)) return "number";
    if (/(list|items|rows|users|ids|tags)$/i.test(name)) return "array";
    return "string";
  }

  switch (node.kind) {
    case ts.SyntaxKind.StringKeyword:
      return "string";
    case ts.SyntaxKind.NumberKeyword:
    case ts.SyntaxKind.BigIntKeyword:
      return "number";
    case ts.SyntaxKind.BooleanKeyword:
      return "boolean";
    case ts.SyntaxKind.ArrayType:
    case ts.SyntaxKind.TupleType:
      return "array";
    case ts.SyntaxKind.FunctionType:
      return "function";
    case ts.SyntaxKind.TypeLiteral:
      return "object";
    default:
      break;
  }

  if (ts.isLiteralTypeNode(node)) {
    if (ts.isStringLiteral(node.literal)) return "string";
    if (ts.isNumericLiteral(node.literal)) return "number";
    return "boolean";
  }

  if (ts.isParenthesizedTypeNode(node)) return valueKindOf(node.type, name);

  if (ts.isUnionTypeNode(node)) {
    const first = node.types.find(
      (member) =>
        member.kind !== ts.SyntaxKind.NullKeyword &&
        member.kind !== ts.SyntaxKind.UndefinedKeyword &&
        !(ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword),
    );
    return valueKindOf(first, name);
  }

  if (ts.isTypeReferenceNode(node)) {
    const reference = typeName(node);
    if (reference === "Array" || reference === "ReadonlyArray") return "array";
    if (reference === "Promise") return "object";
    return "object";
  }

  return "unknown";
}

function typeAllowsUndefined(node: ts.TypeNode | undefined): boolean {
  if (!node) return false;
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) return true;
  if (ts.isUnionTypeNode(node)) return node.types.some(typeAllowsUndefined);
  return false;
}

function membersOf(
  node: ts.Node,
): ReadonlyArray<ts.TypeElement | ts.ClassElement> | undefined {
  if (ts.isInterfaceDeclaration(node)) return node.members;
  if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) return node.type.members;
  if (ts.isTypeLiteralNode(node)) return node.members;
  return undefined;
}

function objectSample(
  members: ReadonlyArray<ts.TypeElement | ts.ClassElement>,
  file: ParsedFile,
  sc: SampleCtx,
  depth: number,
): string {
  const entries: string[] = [];

  for (const member of members) {
    if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
      if (member.questionToken) continue;
      const key = propertyNameText(member.name);
      if (!key) continue;
      const rendered = /^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key);
      entries.push(`${rendered}: ${sampleFromType(member.type, key, { ...sc, file }, depth + 1)}`);
    } else if (ts.isMethodSignature(member)) {
      const key = propertyNameText(member.name);
      if (key) entries.push(`${key}: ${sc.d.vi}.fn()`);
    }
  }

  return entries.length ? `{ ${entries.join(", ")} }` : "{}";
}

function sampleFromType(
  node: ts.TypeNode | undefined,
  name: string,
  sc: SampleCtx,
  depth = 0,
): string {
  if (!node) {
    const kind = valueKindOf(undefined, name);
    if (kind === "function") return `${sc.d.vi}.fn()`;
    if (kind === "boolean") return "true";
    if (kind === "number") return sampleNumber(name);
    if (kind === "array") return "[]";
    return sampleForName(name);
  }

  if (depth > 3) return castAny("{}", sc);

  switch (node.kind) {
    case ts.SyntaxKind.StringKeyword:
      return sampleForName(name);
    case ts.SyntaxKind.NumberKeyword:
      return sampleNumber(name);
    case ts.SyntaxKind.BigIntKeyword:
      return "1n";
    case ts.SyntaxKind.BooleanKeyword:
      return "true";
    case ts.SyntaxKind.NullKeyword:
      return "null";
    case ts.SyntaxKind.UndefinedKeyword:
    case ts.SyntaxKind.VoidKeyword:
    case ts.SyntaxKind.NeverKeyword:
      return "undefined";
    case ts.SyntaxKind.AnyKeyword:
    case ts.SyntaxKind.UnknownKeyword:
    case ts.SyntaxKind.ObjectKeyword:
      return sampleForName(name);
    default:
      break;
  }

  if (ts.isLiteralTypeNode(node)) {
    const literal = node.literal;
    if (ts.isStringLiteral(literal)) return quote(literal.text);
    if (ts.isNumericLiteral(literal)) return literal.text;
    if (literal.kind === ts.SyntaxKind.TrueKeyword) return "true";
    if (literal.kind === ts.SyntaxKind.FalseKeyword) return "false";
    if (literal.kind === ts.SyntaxKind.NullKeyword) return "null";
    if (ts.isPrefixUnaryExpression(literal)) return literal.getText();
    return "undefined";
  }

  if (ts.isParenthesizedTypeNode(node)) return sampleFromType(node.type, name, sc, depth);

  if (ts.isArrayTypeNode(node)) return `[${sampleFromType(node.elementType, name, sc, depth + 1)}]`;

  if (ts.isTupleTypeNode(node)) {
    return `[${node.elements
      .map((element) =>
        sampleFromType(ts.isNamedTupleMember(element) ? element.type : element, name, sc, depth + 1),
      )
      .join(", ")}]`;
  }

  if (ts.isTypeLiteralNode(node)) return objectSample(node.members, sc.file, sc, depth);

  if (ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node)) return `${sc.d.vi}.fn()`;

  if (ts.isUnionTypeNode(node)) {
    const preferred =
      node.types.find((member) => ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) ??
      node.types.find(
        (member) =>
          member.kind !== ts.SyntaxKind.NullKeyword &&
          member.kind !== ts.SyntaxKind.UndefinedKeyword &&
          !(ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword),
      );
    return preferred ? sampleFromType(preferred, name, sc, depth) : "undefined";
  }

  if (ts.isIntersectionTypeNode(node)) {
    return sampleFromType(node.types[0], name, sc, depth + 1);
  }

  if (ts.isTypeReferenceNode(node)) {
    const reference = typeName(node);
    const args = node.typeArguments ?? [];

    if (reference === "Array" || reference === "ReadonlyArray") {
      return `[${sampleFromType(args[0], name, sc, depth + 1)}]`;
    }
    if (reference === "Promise") return `Promise.resolve(${sampleFromType(args[0], name, sc, depth + 1)})`;
    if (reference === "Record") return `{ key: ${sampleFromType(args[1], name, sc, depth + 1)} }`;
    if (reference === "Partial") return "{}";
    if (reference === "Readonly" || reference === "Required" || reference === "Pick" || reference === "Omit") {
      return sampleFromType(args[0], name, sc, depth + 1);
    }
    if (reference === "Function") return `${sc.d.vi}.fn()`;
    if (BUILTIN_TYPE_SAMPLES[reference]) return BUILTIN_TYPE_SAMPLES[reference];

    const declaration = ts.isIdentifier(node.typeName)
      ? lookupTopLevel(sc.file, node.typeName.text, sc.ctx)
      : undefined;

    if (declaration) {
      const target = declaration.node;
      const members = membersOf(target);

      if (members) return objectSample(members, declaration.file, sc, depth);

      if (ts.isTypeAliasDeclaration(target)) {
        return sampleFromType(target.type, name, { ...sc, file: declaration.file }, depth + 1);
      }

      if (ts.isEnumDeclaration(target)) {
        const first = target.members[0];
        if (first?.initializer && (ts.isStringLiteral(first.initializer) || ts.isNumericLiteral(first.initializer))) {
          return first.initializer.getText();
        }
        return "0";
      }
    }

    return castAny("{}", sc);
  }

  return castAny("{}", sc);
}

function falsyForKind(kind: ValueKind, optional: boolean, sc: SampleCtx): string {
  if (kind === "string") return '""';
  if (kind === "number") return "0";
  if (kind === "boolean") return "false";
  if (optional) return "undefined";
  return castAny("null", sc);
}


/* -------------------------------------------------------------------------- */
/*  Units                                                                     */
/* -------------------------------------------------------------------------- */

interface Unit {
  name: string;
  callName: string;
  exportedAs: string;
  exportKind: "named" | "default";
  kind: UnitKind;
  fn: FnNode;
  file: ParsedFile;
  node: ts.Node;
  className?: string;
  methodName?: string;
  isStatic?: boolean;
  classNode?: ts.ClassDeclaration;
  propsTypeNode?: ts.TypeNode;
}

function containsJsx(node: ts.Node | undefined): boolean {
  if (!node) return false;
  let found = false;
  walk(node, (current) => {
    if (found) return false;
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current) || ts.isJsxFragment(current)) {
      found = true;
      return false;
    }
    return undefined;
  });
  return found;
}

function fnFromInitializer(expression: ts.Expression | undefined, depth = 0): FnNode | undefined {
  if (!expression || depth > 3) return undefined;
  const inner = unwrapExpr(expression);

  if (isFnNode(inner)) return inner;

  if (ts.isCallExpression(inner) && /^(React\.)?(memo|forwardRef)$/.test(inner.expression.getText())) {
    return fnFromInitializer(inner.arguments[0], depth + 1);
  }

  return undefined;
}

function extractUnits(file: ParsedFile): Unit[] {
  const units: Unit[] = [];
  const entries: Array<{ exportedAs: string; local: string }> = [];

  for (const [exported, local] of file.exportedNames) entries.push({ exportedAs: exported, local });
  if (file.exportsDefault) entries.push({ exportedAs: "default", local: file.exportsDefault });

  const baseName = titleCase(path.basename(file.rel).replace(/\.[^.]+$/, ""));

  // One function can be exported twice (`export function X` plus `export default X`).
  // It is still one unit, so only the first export (named ones come first) is used.
  const handledLocals = new Set<string>();

  for (const { exportedAs, local } of entries) {
    const node = file.topLevel.get(local);
    if (!node) continue;

    if (handledLocals.has(local)) continue;
    handledLocals.add(local);

    const isDefault = exportedAs === "default";
    const callName = isDefault ? (local === "default" ? baseName : local) : exportedAs;

    let fn: FnNode | undefined;
    let propsTypeNode: ts.TypeNode | undefined;

    if (ts.isFunctionDeclaration(node)) {
      fn = node.body ? node : undefined;
    } else if (ts.isVariableDeclaration(node)) {
      fn = fnFromInitializer(node.initializer);
      const annotation = node.type;
      if (annotation && ts.isTypeReferenceNode(annotation) && annotation.typeArguments?.[0]) {
        propsTypeNode = annotation.typeArguments[0];
      }
    } else if (ts.isClassDeclaration(node)) {
      const extendsComponent = node.heritageClauses?.some(
        (clause) =>
          clause.token === ts.SyntaxKind.ExtendsKeyword &&
          /Component$/.test(clause.types[0]?.expression.getText() ?? ""),
      );
      if (extendsComponent) continue;

      let count = 0;

      for (const member of node.members) {
        if (count >= MAX_METHODS_PER_CLASS) break;
        if (!ts.isMethodDeclaration(member) || !member.body) continue;
        if (!ts.isIdentifier(member.name)) continue;
        if (
          hasModifier(member, ts.SyntaxKind.PrivateKeyword) ||
          hasModifier(member, ts.SyntaxKind.ProtectedKeyword)
        ) {
          continue;
        }

        count++;
        units.push({
          name: `${callName}.${member.name.text}`,
          callName,
          exportedAs,
          exportKind: isDefault ? "default" : "named",
          kind: "method",
          fn: member,
          file,
          node: member,
          className: callName,
          methodName: member.name.text,
          isStatic: hasModifier(member, ts.SyntaxKind.StaticKeyword),
          classNode: node,
        });
      }
      continue;
    } else {
      fn = fnFromInitializer(node as ts.Expression);
    }

    if (!fn || !fn.body) continue;

    const kind: UnitKind =
      /^use[A-Z0-9]/.test(callName)
        ? "hook"
        : /^[A-Z]/.test(callName) && containsJsx(fn.body)
          ? "component"
          : "function";

    units.push({
      name: callName,
      callName,
      exportedAs,
      exportKind: isDefault ? "default" : "named",
      kind,
      fn,
      file,
      node: ts.isVariableDeclaration(node) ? node.parent.parent : node,
      propsTypeNode,
    });
  }

  return units;
}

/* -------------------------------------------------------------------------- */
/*  Environment                                                               */
/* -------------------------------------------------------------------------- */

interface Libs {
  rtl: boolean;
  userEvent: boolean;
  routerPackage?: string;
}

interface Env {
  ctx: Ctx;
  file: ParsedFile;
  d: Dialect;
  sc: SampleCtx;
  testAbs: string;
  useJsExt: boolean;
  libs: Libs;
  reactImport: boolean;
}

interface Needs {
  named: Set<string>;
  defaultName?: string;
  extraImports: Set<string>;
  moduleMocks: Set<string>;
  jsdom: boolean;
  router?: string;
}

function emptyNeeds(): Needs {
  return { named: new Set(), extraImports: new Set(), moduleMocks: new Set(), jsdom: false };
}

function importPathTo(env: Env, targetAbs: string): string {
  let relative = normalizeFsPath(path.relative(path.dirname(env.testAbs), targetAbs));
  relative = relative.replace(/\.(tsx?|jsx?|mts|cts|mjs|cjs)$/, "");
  if (env.useJsExt) relative += ".js";
  if (!relative.startsWith(".")) relative = `./${relative}`;
  return relative;
}

/* -------------------------------------------------------------------------- */
/*  Analysis                                                                  */
/* -------------------------------------------------------------------------- */

interface IoModule {
  spec: string;
  target?: ParsedFile;
  names: Array<{ local: string; imported: string }>;
  awaited: string[];
}

interface Deps {
  fetch: boolean;
  timers: boolean;
  date: boolean;
  random: boolean;
  consoleMethods: Set<string>;
  env: Set<string>;
  dom: boolean;
  axiosVerbs: string[];
  io: IoModule[];
  routerNames: string[];
  providerHooks: string[];
  hookCalls: string[];
}

interface Analysis {
  isAsync: boolean;
  complexity: number;
  throwsCount: number;
  hasTryCatch: boolean;
  tryStatement?: ts.TryStatement;
  returnsValue: boolean;
  returnType?: ts.TypeNode;
  chains: IfChain[];
  switches: ts.SwitchStatement[];
  deps: Deps;
}

interface IfChain {
  branches: Array<{ cond: ts.Expression; then: ts.Statement; node: ts.IfStatement }>;
  otherwise?: ts.Statement;
  isGuard: boolean;
}

function analyzeFunction(unit: Unit, ctx: Ctx): Analysis {
  const { fn, file } = unit;
  let complexity = 1;
  let throwsCount = 0;
  let returnsValue = false;
  let tryStatement: ts.TryStatement | undefined;
  const chains: IfChain[] = [];
  const switches: ts.SwitchStatement[] = [];

  const deps: Deps = {
    fetch: false,
    timers: false,
    date: false,
    random: false,
    consoleMethods: new Set(),
    env: new Set(),
    dom: false,
    axiosVerbs: [],
    io: [],
    routerNames: [],
    providerHooks: [],
    hookCalls: [],
  };

  const ioByModule = new Map<string, IoModule>();

  const noteImport = (local: string, node: ts.Node) => {
    const reference = file.imports.get(local);
    if (!reference) return;

    const spec = reference.specifier;

    if (/^react-router(-dom)?$/.test(spec) && ROUTER_HOOKS.has(reference.imported)) {
      if (!deps.routerNames.includes(reference.imported)) deps.routerNames.push(reference.imported);
      return;
    }

    if (/^(react-redux|@tanstack\/react-query|react-query|swr)$/.test(spec)) {
      if (!deps.providerHooks.includes(reference.imported)) deps.providerHooks.push(reference.imported);
      return;
    }

    if (spec === "axios") return;

    let mock = NODE_IO_MODULES.has(spec) || IO_PACKAGES.test(spec);
    let target: ParsedFile | undefined;

    if (!mock && (spec.startsWith(".") || /^[@~]\//.test(spec))) {
      target = resolveModule(file, spec, ctx);
      mock = !!target && IO_RELATIVE.test(spec);
    }

    if (!mock) return;

    const entry = ioByModule.get(spec) ?? { spec, target, names: [], awaited: [] };
    if (!entry.names.some((name) => name.local === local)) {
      entry.names.push({ local, imported: reference.imported });
    }
    if (ts.isAwaitExpression(node.parent?.parent ?? node)) entry.awaited.push(local);
    ioByModule.set(spec, entry);
  };

  walkOwn(fn, (node) => {
    if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) complexity++;
    else if (ts.isCaseClause(node)) complexity++;
    else if (ts.isCatchClause(node)) complexity++;
    else if (
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)
    ) {
      complexity++;
    } else if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      if (
        kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        kind === ts.SyntaxKind.BarBarToken ||
        kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        complexity++;
      }
    }

    if (ts.isThrowStatement(node)) throwsCount++;
    if (ts.isReturnStatement(node) && node.expression) returnsValue = true;
    if (ts.isTryStatement(node) && node.catchClause && !tryStatement) tryStatement = node;
    if (ts.isSwitchStatement(node)) switches.push(node);

  });

  walk(fn, (node) => {
    if (ts.isIdentifier(node)) {
      if (node.text === "localStorage" || node.text === "sessionStorage" || node.text === "document" || node.text === "window") {
        deps.dom = true;
      }
      if (file.imports.has(node.text) && isUsage(node)) noteImport(node.text, node);
    }

    if (ts.isCallExpression(node)) {
      const callee = unwrapExpr(node.expression);
      const text = callee.getText();

      if (text === "fetch" || text === "window.fetch" || text === "globalThis.fetch") deps.fetch = true;
      if (/^(setTimeout|setInterval|clearTimeout|clearInterval|requestAnimationFrame)$/.test(text)) deps.timers = true;
      if (text === "Date.now" || text === "performance.now") deps.date = true;
      if (text === "Math.random") deps.random = true;

      const consoleMatch = /^console\.(log|info|warn|error|debug)$/.exec(text);
      if (consoleMatch) deps.consoleMethods.add(consoleMatch[1]);

      const axiosMatch = /^axios\.(get|post|put|patch|delete)$/.exec(text);
      if (axiosMatch && !deps.axiosVerbs.includes(axiosMatch[1])) deps.axiosVerbs.push(axiosMatch[1]);

      if (ts.isIdentifier(callee)) {
        if (/^use[A-Z]/.test(callee.text) && !deps.hookCalls.includes(callee.text)) deps.hookCalls.push(callee.text);
        if (callee.text === "useContext" && !deps.providerHooks.includes("useContext")) {
          deps.providerHooks.push("useContext");
        }
      }
    }

    if (ts.isNewExpression(node) && node.expression.getText() === "Date" && (node.arguments?.length ?? 0) === 0) {
      deps.date = true;
    }

    if (ts.isPropertyAccessExpression(node)) {
      const match = /^process\.env\.(\w+)$/.exec(node.getText());
      if (match) deps.env.add(match[1]);
    }
  });

  deps.io = [...ioByModule.values()];

  // Axios identifier alone (e.g. axios(config)) still needs the module mocked.
  if (file.imports.get("axios")?.specifier === "axios" && deps.axiosVerbs.length === 0) {
    let usesAxios = false;
    walk(fn, (node) => {
      if (ts.isIdentifier(node) && node.text === "axios" && isUsage(node)) usesAxios = true;
    });
    if (usesAxios) deps.axiosVerbs.push("get");
  }

  // Collect if/else-if chains (top two nesting levels).
  walkOwn(fn, (node) => {
    if (!ts.isIfStatement(node)) return;
    if (node.parent && ts.isIfStatement(node.parent) && node.parent.elseStatement === node) return;

    let depth = 0;
    let cursor: ts.Node | undefined = node.parent;
    while (cursor && cursor !== fn) {
      if (ts.isIfStatement(cursor)) depth++;
      cursor = cursor.parent;
    }
    if (depth > 1 || chains.length >= 8) return;

    const branches: IfChain["branches"] = [];
    let current: ts.IfStatement | undefined = node;
    let otherwise: ts.Statement | undefined;

    while (current) {
      branches.push({ cond: current.expression, then: current.thenStatement, node: current });
      const next: ts.Statement | undefined = current.elseStatement;
      if (next && ts.isIfStatement(next)) {
        current = next;
      } else {
        otherwise = next;
        current = undefined;
      }
    }

    const isGuard =
      !otherwise &&
      branches.length === 1 &&
      outcomeOf(branches[0].then).kind !== "none";

    chains.push({ branches, otherwise, isGuard });
  });

  let returnType = fn.type;
  const isAsync = !!fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);

  if (returnType && isAsync && ts.isTypeReferenceNode(returnType) && typeName(returnType) === "Promise") {
    returnType = returnType.typeArguments?.[0];
  }

  return {
    isAsync,
    complexity,
    throwsCount,
    hasTryCatch: !!tryStatement,
    tryStatement,
    returnsValue,
    returnType,
    chains,
    switches,
    deps,
  };
}

function isUsage(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent)) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  return true;
}

/* ---- Outcomes of a branch ---------------------------------------------- */

type Outcome =
  | { kind: "return"; literal?: string; hasValue: boolean }
  | { kind: "throw"; message?: string }
  | { kind: "none" };

function literalText(expression: ts.Expression): string | undefined {
  const inner = unwrapExpr(expression);

  if (ts.isStringLiteralLike(inner)) return quote(inner.text);
  if (ts.isNumericLiteral(inner)) return inner.text;
  if (inner.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (inner.kind === ts.SyntaxKind.FalseKeyword) return "false";
  if (inner.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isIdentifier(inner) && inner.text === "undefined") return "undefined";

  if (
    ts.isPrefixUnaryExpression(inner) &&
    inner.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(inner.operand)
  ) {
    return `-${inner.operand.text}`;
  }

  if (ts.isArrayLiteralExpression(inner)) {
    const parts = inner.elements.map((element) => (ts.isSpreadElement(element) ? undefined : literalText(element)));
    return parts.every((part) => part !== undefined) ? `[${parts.join(", ")}]` : undefined;
  }

  if (ts.isObjectLiteralExpression(inner)) {
    const parts: string[] = [];
    for (const property of inner.properties) {
      if (!ts.isPropertyAssignment(property)) return undefined;
      const key = propertyNameText(property.name);
      const value = literalText(property.initializer);
      if (!key || value === undefined) return undefined;
      parts.push(`${/^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key)}: ${value}`);
    }
    return parts.length ? `{ ${parts.join(", ")} }` : "{}";
  }

  return undefined;
}

function outcomeOf(statement: ts.Statement | undefined): Outcome {
  if (!statement) return { kind: "none" };
  return outcomeOfList(ts.isBlock(statement) ? statement.statements : [statement]);
}

function outcomeOfList(statements: readonly ts.Statement[]): Outcome {
  for (const current of statements) {
    if (ts.isReturnStatement(current)) {
      if (!current.expression) return { kind: "return", literal: "undefined", hasValue: false };
      return { kind: "return", literal: literalText(current.expression), hasValue: true };
    }

    if (ts.isThrowStatement(current)) {
      const thrown = unwrapExpr(current.expression);
      const message =
        ts.isNewExpression(thrown) && thrown.arguments?.[0] && ts.isStringLiteralLike(thrown.arguments[0])
          ? thrown.arguments[0].text
          : undefined;
      return { kind: "throw", message };
    }

    // Anything that can branch or loop before the return makes the outcome uncertain.
    if (
      ts.isIfStatement(current) ||
      ts.isSwitchStatement(current) ||
      ts.isTryStatement(current) ||
      ts.isForStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current)
    ) {
      return { kind: "none" };
    }
  }

  return { kind: "none" };
}

/* -------------------------------------------------------------------------- */
/*  Turning conditions into inputs                                            */
/* -------------------------------------------------------------------------- */

interface PlanParam {
  id: string;
  name: string;
  typeNode?: ts.TypeNode;
  typeFile: ParsedFile;
  optional: boolean;
  rest: boolean;
  /** Kind and sample inferred from a default value when there is no type. */
  kindHint?: ValueKind;
  sampleHint?: string;
  fields?: Array<{
    key: string;
    local: string;
    hasDefault: boolean;
    typeNode?: ts.TypeNode;
    kindHint?: ValueKind;
    sampleHint?: string;
  }>;
}

function hintFromDefault(
  initializer: ts.Expression | undefined,
  name: string,
): { kindHint?: ValueKind; sampleHint?: string } {
  if (!initializer) return {};

  const literal = literalInfo(initializer);
  if (literal?.kind === "boolean") return { kindHint: "boolean", sampleHint: literal.text === "true" ? "false" : "true" };
  if (literal?.kind === "number") return { kindHint: "number", sampleHint: String((literal.number ?? 0) + 1) };
  if (literal?.kind === "string") return { kindHint: "string", sampleHint: sampleForName(name) };

  const inner = unwrapExpr(initializer);
  if (ts.isArrayLiteralExpression(inner)) return { kindHint: "array", sampleHint: "[]" };

  return {};
}

interface Plan {
  values: Map<string, string>;
  props: Map<string, Map<string, string>>;
}

interface Subject {
  id: string;
  prop?: string;
  sampleHint?: string;
  kind: ValueKind;
  optional: boolean;
  typeNode?: ts.TypeNode;
  typeFile: ParsedFile;
  name: string;
}

interface PlanScope {
  params: PlanParam[];
  sc: SampleCtx;
  resolveIdent(name: string): Subject | undefined;
  resolveMember(objectName: string, prop: string): Subject | undefined;
}

function newPlan(): Plan {
  return { values: new Map(), props: new Map() };
}

function mergePlan(a: Plan | undefined, b: Plan | undefined): Plan | undefined {
  if (!a || !b) return undefined;

  const out = newPlan();

  for (const source of [a, b]) {
    for (const [key, value] of source.values) {
      const existing = out.values.get(key);
      if (existing !== undefined && existing !== value) return undefined;
      out.values.set(key, value);
    }

    for (const [id, props] of source.props) {
      const target = out.props.get(id) ?? new Map<string, string>();
      for (const [prop, value] of props) {
        const existing = target.get(prop);
        if (existing !== undefined && existing !== value) return undefined;
        target.set(prop, value);
      }
      out.props.set(id, target);
    }
  }

  return out;
}

function resolveMembers(
  node: ts.TypeNode | undefined,
  file: ParsedFile,
  ctx: Ctx,
  depth = 0,
): { members: ReadonlyArray<ts.TypeElement | ts.ClassElement>; file: ParsedFile } | undefined {
  if (!node || depth > 3) return undefined;

  if (ts.isTypeLiteralNode(node)) return { members: node.members, file };

  if (ts.isParenthesizedTypeNode(node)) return resolveMembers(node.type, file, ctx, depth + 1);
  if (ts.isIntersectionTypeNode(node)) return resolveMembers(node.types[0], file, ctx, depth + 1);

  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const declaration = lookupTopLevel(file, node.typeName.text, ctx);
    if (!declaration) return undefined;

    const members = membersOf(declaration.node);
    if (members) return { members, file: declaration.file };

    if (ts.isTypeAliasDeclaration(declaration.node)) {
      return resolveMembers(declaration.node.type, declaration.file, ctx, depth + 1);
    }
  }

  return undefined;
}

function memberTypeOf(
  members: ReadonlyArray<ts.TypeElement | ts.ClassElement> | undefined,
  key: string,
): { typeNode?: ts.TypeNode; optional: boolean } | undefined {
  if (!members) return undefined;

  for (const member of members) {
    if (propertyNameText(member.name as ts.PropertyName | undefined) !== key) continue;

    if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
      return { typeNode: member.type, optional: !!member.questionToken };
    }

    if (ts.isMethodSignature(member)) return { typeNode: undefined, optional: !!member.questionToken };
  }

  return undefined;
}

function planParams(fn: { parameters: ts.NodeArray<ts.ParameterDeclaration> }, sc: SampleCtx): PlanParam[] {
  return fn.parameters.map((parameter, index): PlanParam => {
    const typeNode = parameter.type;
    const optional =
      !!parameter.questionToken || !!parameter.initializer || typeAllowsUndefined(typeNode);

    if (ts.isObjectBindingPattern(parameter.name)) {
      const resolved = resolveMembers(typeNode, sc.file, sc.ctx);
      const fields: NonNullable<PlanParam["fields"]> = [];

      for (const element of parameter.name.elements) {
        if (element.dotDotDotToken) continue;

        const key = element.propertyName
          ? propertyNameText(element.propertyName)
          : ts.isIdentifier(element.name)
            ? element.name.text
            : undefined;
        if (!key) continue;

        const memberType = memberTypeOf(resolved?.members, key)?.typeNode;

        fields.push({
          key,
          local: ts.isIdentifier(element.name) ? element.name.text : key,
          hasDefault: !!element.initializer,
          typeNode: memberType,
          ...(memberType ? {} : hintFromDefault(element.initializer, key)),
        });
      }

      return {
        id: `$${index}`,
        name: `{ ${fields.map((field) => field.key).join(", ")} }`,
        typeNode,
        typeFile: resolved?.file ?? sc.file,
        optional,
        rest: false,
        fields,
      };
    }

    const paramName = ts.isIdentifier(parameter.name) ? parameter.name.text : `arg${index}`;

    return {
      id: ts.isIdentifier(parameter.name) ? parameter.name.text : `$${index}`,
      name: paramName,
      typeNode,
      typeFile: sc.file,
      optional,
      rest: !!parameter.dotDotDotToken,
      ...(typeNode ? {} : hintFromDefault(parameter.initializer, paramName)),
    };
  });
}

function functionScope(params: PlanParam[], sc: SampleCtx): PlanScope {
  const subjectFor = (
    param: PlanParam,
    prop?: string,
    typeNode?: ts.TypeNode,
    optional?: boolean,
    hint?: ValueKind,
  ): Subject => ({
    id: param.id,
    prop,
    sampleHint: prop ? param.fields?.find((field) => field.key === prop)?.sampleHint : param.sampleHint,
    kind: hint ?? valueKindOf(typeNode, prop ?? param.name),
    optional: optional ?? param.optional,
    typeNode,
    typeFile: param.typeFile,
    name: prop ?? param.name,
  });

  return {
    params,
    sc,
    resolveIdent(name) {
      for (const param of params) {
        if (param.fields) {
          const field = param.fields.find((entry) => entry.local === name);
          if (field) return subjectFor(param, field.key, field.typeNode, field.hasDefault, field.kindHint);
        } else if (param.name === name) {
          return subjectFor(param, undefined, param.typeNode, undefined, param.kindHint);
        }
      }
      return undefined;
    },
    resolveMember(objectName, prop) {
      const param = params.find((entry) => !entry.fields && entry.name === objectName);
      if (!param) return undefined;

      const resolved = resolveMembers(param.typeNode, param.typeFile, sc.ctx);
      const member = memberTypeOf(resolved?.members, prop);
      return subjectFor(param, prop, member?.typeNode, member?.optional ?? true);
    },
  };
}

function subjectOf(expression: ts.Expression, scope: PlanScope): Subject | undefined {
  const inner = unwrapExpr(expression);

  if (ts.isIdentifier(inner)) return scope.resolveIdent(inner.text);

  if (ts.isPropertyAccessExpression(inner)) {
    const owner = unwrapExpr(inner.expression);
    if (ts.isIdentifier(owner)) return scope.resolveMember(owner.text, inner.name.text);
  }

  return undefined;
}

function setSubject(subject: Subject, value: string | undefined): Plan | undefined {
  if (value === undefined) return undefined;

  const plan = newPlan();

  if (subject.prop) plan.props.set(subject.id, new Map([[subject.prop, value]]));
  else plan.values.set(subject.id, value);

  return plan;
}

function subjectSample(subject: Subject, scope: PlanScope): string {
  if (!subject.typeNode && subject.sampleHint) return subject.sampleHint;
  return sampleFromType(subject.typeNode, subject.name, { ...scope.sc, file: subject.typeFile });
}

function truthyValue(subject: Subject, scope: PlanScope): string {
  const sample = subjectSample(subject, scope);
  return sample === '""' || sample === "0" || sample === "false" || sample === "undefined" ? '"sample"' : sample;
}

function falsyValue(subject: Subject, scope: PlanScope): string {
  return falsyForKind(subject.kind, subject.optional, scope.sc);
}

function literalInfo(
  expression: ts.Expression,
): { text: string; kind: "string" | "number" | "boolean" | "null" | "undefined"; number?: number } | undefined {
  const inner = unwrapExpr(expression);

  if (ts.isStringLiteralLike(inner)) return { text: quote(inner.text), kind: "string" };
  if (ts.isNumericLiteral(inner)) return { text: inner.text, kind: "number", number: Number(inner.text) };

  if (
    ts.isPrefixUnaryExpression(inner) &&
    inner.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(inner.operand)
  ) {
    return { text: `-${inner.operand.text}`, kind: "number", number: -Number(inner.operand.text) };
  }

  if (inner.kind === ts.SyntaxKind.TrueKeyword) return { text: "true", kind: "boolean" };
  if (inner.kind === ts.SyntaxKind.FalseKeyword) return { text: "false", kind: "boolean" };
  if (inner.kind === ts.SyntaxKind.NullKeyword) return { text: "null", kind: "null" };
  if (ts.isIdentifier(inner) && inner.text === "undefined") return { text: "undefined", kind: "undefined" };

  return undefined;
}

function lengthValue(subject: Subject, length: number, scope: PlanScope): string {
  if (subject.kind === "array") {
    const typeNode = subject.typeNode && ts.isArrayTypeNode(subject.typeNode) ? subject.typeNode.elementType : undefined;
    const element = typeNode ? sampleFromType(typeNode, subject.name, { ...scope.sc, file: subject.typeFile }) : "1";
    return `[${Array.from({ length: Math.min(length, 10) }, () => element).join(", ")}]`;
  }
  return quote("a".repeat(Math.max(0, Math.min(length, 40))));
}

function differentFrom(literal: NonNullable<ReturnType<typeof literalInfo>>, subject: Subject, scope: PlanScope): string {
  switch (literal.kind) {
    case "string":
      return literal.text === '"other-value"' ? '"other-value-2"' : '"other-value"';
    case "number":
      return String((literal.number ?? 0) + 1);
    case "boolean":
      return literal.text === "true" ? "false" : "true";
    case "null":
    case "undefined":
      return truthyValue(subject, scope);
  }
}

function planCondition(expression: ts.Expression, want: boolean, scope: PlanScope): Plan | undefined {
  const expr = unwrapExpr(expression);

  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
    return planCondition(expr.operand, !want, scope);
  }

  if (ts.isBinaryExpression(expr)) {
    const operator = expr.operatorToken.kind;
    const { left, right } = expr;

    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
      return want
        ? mergePlan(planCondition(left, true, scope), planCondition(right, true, scope))
        : (planCondition(left, false, scope) ??
            mergePlan(planCondition(left, true, scope), planCondition(right, false, scope)));
    }

    if (operator === ts.SyntaxKind.BarBarToken) {
      return want
        ? (planCondition(left, true, scope) ?? planCondition(right, true, scope))
        : mergePlan(planCondition(left, false, scope), planCondition(right, false, scope));
    }

    const isEquality =
      operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      operator === ts.SyntaxKind.EqualsEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsToken;

    const relational: Record<number, ">" | ">=" | "<" | "<="> = {
      [ts.SyntaxKind.GreaterThanToken]: ">",
      [ts.SyntaxKind.GreaterThanEqualsToken]: ">=",
      [ts.SyntaxKind.LessThanToken]: "<",
      [ts.SyntaxKind.LessThanEqualsToken]: "<=",
    };

    if (isEquality || relational[operator]) {
      const negated =
        operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        operator === ts.SyntaxKind.ExclamationEqualsToken;
      const wantEqual = isEquality ? (negated ? !want : want) : want;

      // Put the variable on the left and the literal on the right.
      let variable = unwrapExpr(left);
      let literalSide = unwrapExpr(right);
      let flipped = false;

      if (literalInfo(variable) && !literalInfo(literalSide)) {
        [variable, literalSide] = [literalSide, variable];
        flipped = true;
      }

      const literal = literalInfo(literalSide);

      // typeof x === "string"
      if (isEquality && ts.isTypeOfExpression(variable) && literal?.kind === "string") {
        const subject = subjectOf(variable.expression, scope);
        if (!subject) return undefined;

        const wanted = JSON.parse(literal.text) as string;
        const samples: Record<string, string> = {
          string: sampleForName(subject.name),
          number: "1",
          boolean: "true",
          object: "{}",
          function: `${scope.sc.d.vi}.fn()`,
          undefined: "undefined",
        };

        if (wantEqual) return setSubject(subject, samples[wanted]);
        return setSubject(subject, castAny(wanted === "string" ? "42" : '"text"', scope.sc));
      }

      // x.length === n
      if (
        ts.isPropertyAccessExpression(variable) &&
        variable.name.text === "length" &&
        literal?.kind === "number"
      ) {
        const subject = subjectOf(variable.expression, scope);
        if (!subject) return undefined;

        const n = literal.number ?? 0;
        let target: number;

        if (isEquality) {
          target = wantEqual ? n : n + 1;
        } else {
          target = relationalTarget(relational[operator], flipped, want, n);
        }

        return setSubject(subject, lengthValue(subject, target, scope));
      }

      const subject = subjectOf(variable, scope);
      if (!subject || !literal) return undefined;

      if (isEquality) {
        if (literal.kind === "null" || literal.kind === "undefined") {
          return setSubject(
            subject,
            wantEqual ? "undefined" : truthyValue(subject, scope),
          );
        }
        if (wantEqual) return setSubject(subject, literal.text);

        const other = differentFrom(literal, subject, scope);
        const literalUnion =
          !!subject.typeNode &&
          (ts.isLiteralTypeNode(subject.typeNode) ||
            (ts.isUnionTypeNode(subject.typeNode) && subject.typeNode.types.some((member) => ts.isLiteralTypeNode(member))));

        return setSubject(subject, literalUnion ? castAny(other, scope.sc) : other);
      }

      if (literal.kind !== "number") return undefined;

      return setSubject(subject, String(relationalTarget(relational[operator], flipped, want, literal.number ?? 0)));
    }

    return undefined;
  }

  const subject = subjectOf(expr, scope);
  if (subject) return setSubject(subject, want ? truthyValue(subject, scope) : falsyValue(subject, scope));

  if (ts.isCallExpression(expr)) {
    const callee = unwrapExpr(expr.expression);
    const argument = expr.arguments[0];

    if (callee.getText() === "Array.isArray" && argument) {
      const target = subjectOf(argument, scope);
      return target ? setSubject(target, want ? "[1]" : castAny('"text"', scope.sc)) : undefined;
    }

    if (ts.isPropertyAccessExpression(callee) && argument) {
      const target = subjectOf(callee.expression, scope);
      const literal = literalInfo(argument);
      const method = callee.name.text;

      if (target && literal && ["includes", "startsWith", "endsWith"].includes(method)) {
        if (literal.kind === "number") return setSubject(target, want ? `[${literal.text}]` : "[]");
        if (literal.kind !== "string") return undefined;

        const raw = JSON.parse(literal.text) as string;
        if (!want) return setSubject(target, raw === "sample" ? '"other-value"' : '"sample"');

        const text =
          method === "startsWith" ? `${raw}-sample` : method === "endsWith" ? `sample-${raw}` : `a-${raw}-b`;
        return setSubject(target, quote(text));
      }
    }
  }

  return undefined;
}

function relationalTarget(
  operator: ">" | ">=" | "<" | "<=",
  flipped: boolean,
  want: boolean,
  n: number,
): number {
  // `5 < x` is the same as `x > 5`.
  const effective = flipped ? ({ ">": "<", ">=": "<=", "<": ">", "<=": ">=" } as const)[operator] : operator;

  switch (effective) {
    case ">":
      return want ? n + 1 : n;
    case ">=":
      return want ? n : n - 1;
    case "<":
      return want ? n - 1 : n;
    case "<=":
      return want ? n : n + 1;
  }
}

function renderParam(param: PlanParam, plan: Plan, sc: SampleCtx): string {
  const whole = plan.values.get(param.id);
  const overrides = plan.props.get(param.id);
  const typed: SampleCtx = { ...sc, file: param.typeFile };

  if (param.fields && whole === undefined) {
    const entries: string[] = [];

    for (const field of param.fields) {
      const override = overrides?.get(field.key);

      if (override !== undefined) entries.push(`${field.key}: ${override}`);
      else if (!field.hasDefault) {
        entries.push(`${field.key}: ${!field.typeNode && field.sampleHint ? field.sampleHint : sampleFromType(field.typeNode, field.key, typed)}`);
      }
    }

    return entries.length ? `{ ${entries.join(", ")} }` : "{}";
  }

  let base =
    whole ??
    (!param.typeNode && param.sampleHint ? param.sampleHint : sampleFromType(param.typeNode, param.name, typed));

  if (overrides && overrides.size > 0) {
    base = `{ ...${base}, ${[...overrides].map(([key, value]) => `${key}: ${value}`).join(", ")} }`;
  }

  return base;
}

function callArguments(params: PlanParam[], plan: Plan, sc: SampleCtx): string {
  const usable = params.filter((param) => !param.rest);
  let end = usable.length;

  while (
    end > 0 &&
    usable[end - 1].optional &&
    !plan.values.has(usable[end - 1].id) &&
    !plan.props.has(usable[end - 1].id)
  ) {
    end--;
  }

  return usable
    .slice(0, end)
    .map((param) => renderParam(param, plan, sc))
    .join(", ");
}

/* -------------------------------------------------------------------------- */
/*  Scenario building blocks                                                  */
/* -------------------------------------------------------------------------- */

interface ScenarioCode extends TestScenario {
  lines: string[];
}

interface SetupPiece {
  moduleLevel: string[];
  before: string[];
  after: string[];
}

interface DepSetup {
  piece: SetupPiece;
  mocks: string[];
  caveats: string[];
  failing: string[];
  failingLabel?: string;
}

function itBlock(title: string, isAsync: boolean, body: string[]): string[] {
  return [`it(${quote(title)}, ${isAsync ? "async " : ""}() => {`, ...indentLines(body, 2), "});"];
}

function expectLiteral(literal: string): string {
  if (literal === "null") return "expect(result).toBeNull();";
  if (literal === "undefined") return "expect(result).toBeUndefined();";
  if (literal.startsWith("[") || literal.startsWith("{")) return `expect(result).toEqual(${literal});`;
  return `expect(result).toBe(${literal});`;
}

function fetchStubLine(env: Env, ok: boolean): string {
  const response = `{ ok: ${ok}, status: ${ok ? 200 : 500}, json: async () => ({}), text: async () => "" }`;

  return env.d.name === "vitest"
    ? `vi.stubGlobal("fetch", vi.fn().mockResolvedValue(${response}));`
    : `global.fetch = jest.fn().mockResolvedValue(${response})${env.file.isTs ? " as unknown as typeof fetch" : ""};`;
}

function buildDepSetup(deps: Deps, env: Env, needs: Needs): DepSetup {
  const { d } = env;
  const vi = d.vi;
  const piece: SetupPiece = { moduleLevel: [], before: [], after: [] };
  const mocks: string[] = [];
  const caveats: string[] = [];
  const failing: string[] = [];
  let failingLabel: string | undefined;
  let restore = false;
  const tsCast = env.file.isTs ? " as any" : "";

  if (deps.fetch) {
    const okResponse = '{ ok: true, status: 200, json: async () => ({}), text: async () => "" }';

    if (d.name === "vitest") {
      piece.before.push(`vi.stubGlobal("fetch", vi.fn().mockResolvedValue(${okResponse}));`);
      piece.after.push("vi.unstubAllGlobals();");
      failing.push('vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));');
    } else {
      piece.moduleLevel.push("const originalFetch = global.fetch;");
      piece.before.push(`global.fetch = jest.fn().mockResolvedValue(${okResponse})${env.file.isTs ? " as unknown as typeof fetch" : ""};`);
      piece.after.push("global.fetch = originalFetch;");
      failing.push(`global.fetch = jest.fn().mockRejectedValue(new Error("network down"))${env.file.isTs ? " as unknown as typeof fetch" : ""};`);
    }

    mocks.push("fetch (stubbed)");
    failingLabel = "the network request fails";
    caveats.push("fetch is stubbed to return an empty JSON object. Change the stubbed body if the code reads fields from the response.");
  }

  if (deps.axiosVerbs.length > 0) {
    needs.extraImports.add('import axios from "axios";');
    needs.moduleMocks.add(`${vi}.mock("axios");`);

    for (const verb of deps.axiosVerbs) {
      piece.before.push(`${vi}.mocked(axios.${verb}).mockResolvedValue({ data: {} }${tsCast});`);
    }

    failing.push(`${vi}.mocked(axios.${deps.axiosVerbs[0]}).mockRejectedValue(new Error("network down"));`);
    failingLabel ??= "the axios request fails";
    mocks.push("axios (module mock)");
    caveats.push("axios is mocked to return { data: {} }. Change it if the code reads fields from response.data.");
  }

  for (const module of deps.io) {
    const spec = module.target ? importPathTo(env, module.target.abs) : module.spec;
    needs.moduleMocks.add(`${vi}.mock(${quote(spec)});`);
    mocks.push(`${module.spec} (module mock)`);

    const first = module.names[0];
    if (first && module.target && failing.length === 0) {
      const clause =
        first.imported === "default"
          ? `import ${first.local} from ${quote(spec)};`
          : first.local === first.imported
            ? `import { ${first.local} } from ${quote(spec)};`
            : `import { ${first.imported} as ${first.local} } from ${quote(spec)};`;
      needs.extraImports.add(clause);
      failing.push(`${vi}.mocked(${first.local}).mockRejectedValue(new Error("dependency failed"));`);
      failingLabel = `${first.local} fails`;
    }

    piece.before.push(
      `// TODO: configure ${module.names.map((name) => name.local).join(", ")} (automocked from ${module.spec}), e.g. ${vi}.mocked(${first?.local ?? "fn"}).mockResolvedValue(...)`,
    );
    caveats.push(`${module.spec} is automocked, so its functions return undefined until you configure them.`);
  }

  if (deps.timers || deps.date) {
    piece.before.push(`${vi}.useFakeTimers();`);
    if (deps.date) piece.before.push(`${vi}.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));`);
    piece.after.push(`${vi}.useRealTimers();`);
    mocks.push(deps.date ? "fake timers and system time" : "fake timers");
  }

  if (deps.random) {
    piece.before.push(`${vi}.spyOn(Math, "random").mockReturnValue(0.5);`);
    mocks.push("Math.random");
    restore = true;
  }

  for (const method of deps.consoleMethods) {
    piece.before.push(`${vi}.spyOn(console, ${quote(method)}).mockImplementation(() => {});`);
    mocks.push(`console.${method}`);
    restore = true;
  }

  if (deps.env.size > 0) {
    if (d.name === "vitest") {
      for (const name of deps.env) piece.before.push(`vi.stubEnv(${quote(name)}, "test-value");`);
      piece.after.push("vi.unstubAllEnvs();");
    } else {
      piece.moduleLevel.push("const originalEnv = process.env;");
      piece.before.push(
        `process.env = { ...originalEnv, ${[...deps.env].map((name) => `${name}: "test-value"`).join(", ")} };`,
      );
      piece.after.push("process.env = originalEnv;");
    }
    mocks.push(`process.env.${[...deps.env].join(", ")}`);
  }

  if (deps.dom) {
    needs.jsdom = true;
    caveats.push("This code uses browser globals, so the generated file runs in a jsdom environment.");
  }

  if (restore) piece.after.push(`${vi}.restoreAllMocks();`);

  return { piece, mocks, caveats, failing, failingLabel };
}


/* -------------------------------------------------------------------------- */
/*  Function and method scenarios                                             */
/* -------------------------------------------------------------------------- */

interface BuiltUnit {
  scenarios: ScenarioCode[];
  piece: SetupPiece;
  /** Lines placed at the top of the describe block (shared constants). */
  top: string[];
  mocks: string[];
  caveats: string[];
}

type Expectation =
  | { type: "literal"; literal: string }
  | { type: "throw"; message?: string }
  | { type: "value" }
  | { type: "nothrow" };

function typeAssertion(
  returnType: ts.TypeNode | undefined,
  returnsValue: boolean,
): { lines: string[]; level: AssertionLevel } {
  if (returnType) {
    const kind = valueKindOf(returnType, "result");

    if (returnType.kind === ts.SyntaxKind.VoidKeyword || returnType.kind === ts.SyntaxKind.UndefinedKeyword) {
      return { lines: ["expect(result).toBeUndefined();"], level: "shape" };
    }
    if (kind === "string") return { lines: ['expect(typeof result).toBe("string");'], level: "shape" };
    if (kind === "number") return { lines: ['expect(typeof result).toBe("number");'], level: "shape" };
    if (kind === "boolean") return { lines: ['expect(typeof result).toBe("boolean");'], level: "shape" };
    if (kind === "array") return { lines: ["expect(Array.isArray(result)).toBe(true);"], level: "shape" };
  }

  if (!returnsValue) return { lines: ["expect(result).toBeUndefined();"], level: "shape" };

  return {
    lines: ["// TODO: replace with the value you expect for these inputs", "expect(result).toBeDefined();"],
    level: "scaffold",
  };
}

function constructorArguments(unit: Unit, env: Env): string {
  const constructor = unit.classNode?.members.find(ts.isConstructorDeclaration);
  if (!constructor) return "";

  const params = planParams(constructor, env.sc);
  return callArguments(params, newPlan(), env.sc);
}

function buildFunctionScenarios(unit: Unit, an: Analysis, env: Env, needs: Needs): BuiltUnit {
  const sc = env.sc;
  const params = planParams(unit.fn, sc);
  const scope = functionScope(params, sc);
  const dep = buildDepSetup(an.deps, env, needs);
  const scenarios: ScenarioCode[] = [];
  const titles = new Set<string>();
  const wait = an.isAsync ? "await " : "";

  const prelude: string[] = [];
  if (unit.kind === "method" && !unit.isStatic) {
    prelude.push(`const instance = new ${unit.callName}(${constructorArguments(unit, env)});`);
  }

  const target =
    unit.kind === "method"
      ? unit.isStatic
        ? `${unit.callName}.${unit.methodName}`
        : `instance.${unit.methodName}`
      : unit.callName;

  const callOf = (plan: Plan) => `${target}(${callArguments(params, plan, sc)})`;

  const bodyFor = (
    plan: Plan,
    expectation: Expectation,
    extra: string[] = [],
  ): { lines: string[]; level: AssertionLevel; title: string } => {
    const expr = callOf(plan);
    const lines = [...extra, ...prelude];

    switch (expectation.type) {
      case "literal":
        lines.push(`const result = ${wait}${expr};`, expectLiteral(expectation.literal));
        return { lines, level: "exact", title: `returns ${shorten(expectation.literal, 30)}` };

      case "throw": {
        const argument = expectation.message ? quote(expectation.message) : "";
        lines.push(
          an.isAsync
            ? `await expect(${expr}).rejects.toThrow(${argument});`
            : `expect(() => ${expr}).toThrow(${argument});`,
        );
        return {
          lines,
          level: "exact",
          title: expectation.message ? `throws ${quote(shorten(expectation.message, 40))}` : "throws",
        };
      }

      case "value": {
        const assertion = typeAssertion(an.returnType, an.returnsValue);
        lines.push(`const result = ${wait}${expr};`, ...assertion.lines);
        return { lines, level: assertion.level, title: "returns a result" };
      }

      case "nothrow":
        lines.push(
          an.isAsync
            ? `await expect(${expr}).resolves.not.toBeInstanceOf(Error);`
            : `expect(() => ${expr}).not.toThrow();`,
        );
        return { lines, level: "shape", title: "runs without throwing" };
    }
  };

  const add = (input: {
    title: string;
    category: ScenarioCategory;
    level: AssertionLevel;
    reason: string;
    line?: number;
    lines: string[];
  }) => {
    if (scenarios.length >= MAX_SCENARIOS_PER_UNIT) return;

    let title = input.title;
    let suffix = 2;
    while (titles.has(title)) title = `${input.title} (${suffix++})`;
    titles.add(title);

    scenarios.push({
      id: `s${scenarios.length + 1}`,
      title,
      category: input.category,
      assertion: input.level,
      reason: input.reason,
      line: input.line,
      lines: itBlock(title, an.isAsync || input.lines.some((line) => line.includes("await ")), input.lines),
    });
  };

  const expectationFromOutcome = (outcome: Outcome): Expectation => {
    if (outcome.kind === "return") {
      if (outcome.literal !== undefined) return { type: "literal", literal: outcome.literal };
      return outcome.hasValue ? { type: "value" } : { type: "nothrow" };
    }
    if (outcome.kind === "throw") return { type: "throw", message: outcome.message };
    return { type: "nothrow" };
  };

  /* ---- 1. happy path ---- */
  {
    const onlyReturn = (() => {
      if (an.complexity !== 1 || !unit.fn.body || !ts.isBlock(unit.fn.body)) return undefined;
      const statements = unit.fn.body.statements.filter((statement) => !ts.isVariableStatement(statement));
      const last = statements[statements.length - 1];
      return last && ts.isReturnStatement(last) && last.expression ? literalText(last.expression) : undefined;
    })();

    const expectation: Expectation = onlyReturn
      ? { type: "literal", literal: onlyReturn }
      : an.returnsValue
        ? { type: "value" }
        : { type: "nothrow" };

    const built = bodyFor(newPlan(), expectation);
    const title = onlyReturn
      ? built.title
      : an.returnsValue
        ? "returns a result for typical input"
        : "runs without throwing for typical input";

    add({
      title,
      category: an.isAsync ? "async" : "happy",
      level: built.level,
      reason: "The main path through the code with typical inputs.",
      line: startLineOf(unit.fn),
      lines: built.lines,
    });
  }

  /* ---- 2. every if / else-if / else branch ---- */
  const guardPlans: Array<Plan | undefined> = [];
  let guardAcc: Plan | undefined = newPlan();
  const coveredValues = new Set<string>();
  const remember = (plan: Plan | undefined) => {
    if (!plan) return;
    for (const [id, value] of plan.values) coveredValues.add(`${id}=${value}`);
  };

  an.chains.forEach((chain, chainIndex) => {
    const before = guardAcc;

    chain.branches.forEach((branch, branchIndex) => {
      const condText = shorten(branch.cond.getText(), 50);
      let plan: Plan | undefined = before;

      for (let earlier = 0; earlier < branchIndex; earlier++) {
        plan = mergePlan(plan, planCondition(chain.branches[earlier].cond, false, scope));
      }

      // `if (!res.ok)` after fetch(): the stubbed response decides the branch.
      const okCondition = an.deps.fetch ? /^(!)?\s*[\w$]+\.ok$/.exec(branch.cond.getText().trim()) : null;
      const arrange = okCondition ? [fetchStubLine(env, !okCondition[1])] : [];

      if (!okCondition) plan = mergePlan(plan, planCondition(branch.cond, true, scope));

      const certain = !!plan;
      const usePlan = plan ?? mergePlan(newPlan(), planCondition(branch.cond, true, scope)) ?? newPlan();
      remember(usePlan);
      const outcome = outcomeOf(branch.then);

      let expectation = expectationFromOutcome(outcome);
      if (!certain && expectation.type !== "nothrow") {
        expectation = outcome.kind === "throw" || (outcome.kind === "return" && outcome.hasValue) ? { type: "value" } : { type: "nothrow" };
      }

      const built = bodyFor(
        usePlan,
        expectation,
        certain ? arrange : [`// TODO: choose inputs so that \`${condText}\` is true`],
      );
      const verb = built.title;

      add({
        title: `${verb} when ${condText}`,
        category: "branch",
        level: certain ? built.level : "scaffold",
        reason: certain
          ? `Covers the branch taken when ${condText}.`
          : `Could not derive inputs for ${condText} automatically; adjust them.`,
        line: startLineOf(branch.node),
        lines: built.lines,
      });
    });

    if (chain.otherwise || (chain.branches.length > 1 && !chain.isGuard)) {
      let plan: Plan | undefined = before;
      for (const branch of chain.branches) plan = mergePlan(plan, planCondition(branch.cond, false, scope));

      const certain = !!plan;
      remember(plan);
      const outcome = chain.otherwise ? outcomeOf(chain.otherwise) : ({ kind: "none" } as Outcome);
      let expectation = expectationFromOutcome(outcome);
      if (!certain && expectation.type !== "nothrow") expectation = { type: "value" };

      const built = bodyFor(plan ?? newPlan(), expectation, certain ? [] : ["// TODO: choose inputs so that every condition above is false"]);
      const label = chain.branches.length === 1 ? `not (${shorten(chain.branches[0].cond.getText(), 40)})` : "none of the conditions above match";

      add({
        title: `${built.title} when ${label}`,
        category: "branch",
        level: certain ? built.level : "scaffold",
        reason: "Covers the else path.",
        line: startLineOf(chain.branches[0].node),
        lines: built.lines,
      });
    }

    guardPlans[chainIndex] = before;

    if (chain.isGuard) {
      guardAcc = mergePlan(guardAcc, planCondition(chain.branches[0].cond, false, scope));
    }
  });

  /* ---- 3. switch statements ---- */
  for (const statement of an.switches.slice(0, 2)) {
    const subject = subjectOf(statement.expression, scope);
    if (!subject) continue;

    const literals: string[] = [];

    for (const clause of statement.caseBlock.clauses) {
      if (ts.isCaseClause(clause)) {
        const literal = literalInfo(clause.expression);
        if (!literal) continue;
        literals.push(literal.text);

        const plan = setSubject(subject, literal.text);
        remember(plan);
        const outcome = outcomeOfList(clause.statements);
        const built = bodyFor(plan ?? newPlan(), expectationFromOutcome(outcome));

        add({
          title: `${built.title} when ${shorten(statement.expression.getText(), 30)} is ${literal.text}`,
          category: "branch",
          level: built.level,
          reason: `Covers case ${literal.text}.`,
          line: startLineOf(clause),
          lines: built.lines,
        });
      } else {
        const unmatched = castAny(subject.kind === "number" ? "9999" : '"unmatched-value"', sc);
        const outcome = outcomeOfList(clause.statements);
        const built = bodyFor(setSubject(subject, unmatched) ?? newPlan(), expectationFromOutcome(outcome));

        add({
          title: `${built.title} for an unknown ${shorten(statement.expression.getText(), 30)}`,
          category: "branch",
          level: built.level,
          reason: "Covers the default case.",
          line: startLineOf(clause),
          lines: built.lines,
        });
      }
    }
  }

  /* ---- 4. edge cases from parameter types ---- */
  let edges = 0;

  for (const param of params) {
    if (edges >= 3 || param.fields || param.rest) continue;

    const kind = param.kindHint ?? valueKindOf(param.typeNode, param.name);
    const isLiteralType =
      !!param.typeNode &&
      (ts.isLiteralTypeNode(param.typeNode) ||
        (ts.isUnionTypeNode(param.typeNode) && param.typeNode.types.some((member) => ts.isLiteralTypeNode(member))));
    if (isLiteralType) continue;

    const edgeValue =
      kind === "string" ? '""' : kind === "number" ? "0" : kind === "array" ? "[]" : undefined;

    if (edgeValue && !coveredValues.has(`${param.id}=${edgeValue}`)) {
      const plan = setSubject(
        { id: param.id, kind, optional: param.optional, typeFile: param.typeFile, name: param.name },
        edgeValue,
      );
      const built = bodyFor(plan ?? newPlan(), { type: "nothrow" });
      const label = kind === "string" ? `an empty ${param.name}` : kind === "number" ? `${param.name} = 0` : `an empty ${param.name} list`;

      add({
        title: `handles ${label}`,
        category: "edge",
        level: "shape",
        reason: `Edge case: ${label}. The test only checks that nothing throws.`,
        line: startLineOf(unit.fn),
        lines: built.lines,
      });
      edges++;
    }
  }

  const lastRequired = params.filter((param) => !param.rest);
  const optional = lastRequired[lastRequired.length - 1];
  if (optional && optional.optional && !optional.fields && edges < 4) {
    const built = bodyFor(newPlan(), { type: "nothrow" });
    add({
      title: `works without the optional ${optional.name}`,
      category: "edge",
      level: "shape",
      reason: `${optional.name} is optional, so the function should work without it.`,
      line: startLineOf(unit.fn),
      lines: built.lines,
    });
  }

  /* ---- 5. failing dependency ---- */
  if (dep.failing.length > 0 && an.isAsync) {
    const label = dep.failingLabel ?? "a dependency fails";

    if (an.tryStatement?.catchClause) {
      const outcome = outcomeOf(an.tryStatement.catchClause.block);
      const expectation = expectationFromOutcome(outcome);
      const built = bodyFor(newPlan(), expectation, dep.failing);

      add({
        title: `${built.title} when ${label}`,
        category: "error",
        level: built.level,
        reason: `The code catches errors; this checks the catch path when ${label}. Assumes the failing call is inside the try block.`,
        line: startLineOf(an.tryStatement),
        lines: built.lines,
      });
    } else {
      const built = bodyFor(newPlan(), { type: "throw", message: "network down" }, dep.failing);
      const lines = built.lines.map((line) =>
        line.includes("rejects.toThrow") && !line.includes("network down")
          ? line.replace("toThrow(", 'toThrow("network down"')
          : line,
      );

      add({
        title: `rejects when ${label}`,
        category: "error",
        level: "shape",
        reason: `There is no try/catch, so a failure should propagate. Check that the error is not wrapped.`,
        line: startLineOf(unit.fn),
        lines,
      });
    }
  }

  const caveats = [...dep.caveats];
  if (scenarios.some((scenario) => scenario.category === "edge")) {
    caveats.push('Edge-case tests only check that nothing throws. If one fails, either the code needs a guard or the test should expect the error.');
  }

  return { scenarios, piece: dep.piece, top: [], mocks: dep.mocks, caveats };
}

/* -------------------------------------------------------------------------- */
/*  React components                                                          */
/* -------------------------------------------------------------------------- */

interface PropFact {
  name: string;
  typeNode?: ts.TypeNode;
  optional: boolean;
}

function isStaticText(node: ts.JsxText): string | undefined {
  if (node.containsOnlyTriviaWhiteSpaces) return undefined;
  const text = node.text.replace(/\s+/g, " ").trim();
  return text.length >= 2 && text.length <= 50 ? text : undefined;
}

function firstStaticText(root: ts.Node): string | undefined {
  let found: string | undefined;

  walk(root, (node) => {
    if (found) return false;
    if (ts.isJsxText(node)) {
      const text = isStaticText(node);
      if (text) found = text;
    }
    return undefined;
  });

  return found;
}

function insideNestedFunction(node: ts.Node, root: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && current !== root) {
    if (isFnNode(current)) return true;
    current = current.parent;
  }
  return false;
}

function jsxAttribute(name: string, value: string): string {
  if (value === "true") return name;
  if (/^"[^"\\{}]*"$/.test(value)) return `${name}=${value}`;
  return `${name}={${value}}`;
}

function buildComponentScenarios(unit: Unit, an: Analysis, env: Env, needs: Needs): BuiltUnit {
  const sc = env.sc;
  const d = env.d;
  const vi = d.vi;
  const dep = buildDepSetup(an.deps, env, needs);
  const scenarios: ScenarioCode[] = [];
  const titles = new Set<string>();
  const caveats = [...dep.caveats];
  needs.jsdom = true;
  if (d.name === "vitest") dep.piece.after.unshift("cleanup();");

  /* ---- props ---- */
  const first = unit.fn.parameters[0];
  const typeNode = first?.type ?? unit.propsTypeNode;
  const resolved = resolveMembers(typeNode, env.file, env.ctx);
  const propsMap = new Map<string, PropFact>();
  let propsParam: string | undefined;

  if (resolved) {
    for (const member of resolved.members) {
      if (ts.isPropertySignature(member)) {
        const key = propertyNameText(member.name);
        if (key) propsMap.set(key, { name: key, typeNode: member.type, optional: !!member.questionToken });
      }
    }
  }

  if (first && ts.isObjectBindingPattern(first.name)) {
    for (const element of first.name.elements) {
      if (element.dotDotDotToken) continue;
      const key = element.propertyName
        ? propertyNameText(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : undefined;
      if (!key) continue;

      const existing = propsMap.get(key);
      if (existing) existing.optional ||= !!element.initializer;
      else propsMap.set(key, { name: key, optional: !!element.initializer });
    }
  } else if (first && ts.isIdentifier(first.name)) {
    propsParam = first.name.text;
    walkOwn(unit.fn, (node) => {
      if (ts.isPropertyAccessExpression(node) && isIdentifierNamed(node.expression, propsParam!)) {
        if (!propsMap.has(node.name.text)) propsMap.set(node.name.text, { name: node.name.text, optional: true });
      }
    });
  }

  const typedCtx: SampleCtx = { ...sc, file: resolved?.file ?? env.file };
  const planParamsList: PlanParam[] = [...propsMap.values()].map((prop) => ({
    id: prop.name,
    name: prop.name,
    typeNode: prop.typeNode,
    typeFile: resolved?.file ?? env.file,
    optional: prop.optional,
    rest: false,
  }));

  const scope: PlanScope = {
    params: planParamsList,
    sc: typedCtx,
    resolveIdent(name) {
      const prop = propsMap.get(name);
      if (!prop || propsParam) return propsParam ? undefined : undefined;
      return {
        id: name,
        kind: valueKindOf(prop.typeNode, name),
        optional: prop.optional,
        typeNode: prop.typeNode,
        typeFile: resolved?.file ?? env.file,
        name,
      };
    },
    resolveMember(objectName, propName) {
      if (!propsParam || objectName !== propsParam) return undefined;
      const prop = propsMap.get(propName);
      if (!prop) return undefined;
      return {
        id: propName,
        kind: valueKindOf(prop.typeNode, propName),
        optional: prop.optional,
        typeNode: prop.typeNode,
        typeFile: resolved?.file ?? env.file,
        name: propName,
      };
    },
  };

  // Properties named on* are always given a mock so interactions can be checked.
  const baseProps: string[] = [];
  for (const prop of propsMap.values()) {
    const isHandler = /^on[A-Z]/.test(prop.name);
    if (prop.optional && !isHandler) continue;
    baseProps.push(`${prop.name}: ${sampleFromType(prop.typeNode, prop.name, typedCtx)}`);
  }

  const hasProps = baseProps.length > 0;
  const top = hasProps ? [`const props = { ${baseProps.join(", ")} };`, ""] : [];

  /* ---- router wrapper ---- */
  const usesRouter = an.deps.routerNames.length > 0;
  const routerPackage = usesRouter ? env.libs.routerPackage : undefined;
  if (routerPackage) needs.router = routerPackage;
  if (usesRouter && !routerPackage) {
    caveats.push("This component uses React Router, but no router package was found in package.json. Wrap it in a router when rendering.");
  }
  if (an.deps.providerHooks.length > 0) {
    caveats.push(`Uses ${an.deps.providerHooks.join(", ")}. If the component needs a provider (store, query client, context), wrap it when rendering.`);
  }

  const renderCall = (overrides: Map<string, string> = new Map(), bindContainer = false): string => {
    const attributes: string[] = [];
    if (hasProps) attributes.push("{...props}");
    for (const [name, value] of overrides) attributes.push(jsxAttribute(name, value));

    const element = `<${unit.callName}${attributes.length ? ` ${attributes.join(" ")}` : ""} />`;
    const wrapped = routerPackage ? `<MemoryRouter>${element}</MemoryRouter>` : element;

    return `${bindContainer ? "const { container } = " : ""}render(${wrapped});`;
  };

  const add = (input: {
    title: string;
    category: ScenarioCategory;
    level: AssertionLevel;
    reason: string;
    line?: number;
    lines: string[];
  }) => {
    if (scenarios.length >= MAX_SCENARIOS_PER_UNIT) return;

    let title = input.title;
    let suffix = 2;
    while (titles.has(title)) title = `${input.title} (${suffix++})`;
    titles.add(title);

    scenarios.push({
      id: `s${scenarios.length + 1}`,
      title,
      category: input.category,
      assertion: input.level,
      reason: input.reason,
      line: input.line,
      lines: itBlock(title, input.lines.some((line) => line.includes("await ")), input.lines),
    });
  };

  /* ---- renders ---- */
  add({
    title: "renders without crashing",
    category: "render",
    level: "shape",
    reason: "Smoke test: the component mounts with typical props.",
    line: startLineOf(unit.fn),
    lines: [renderCall(new Map(), true), "expect(container.firstChild).not.toBeNull();"],
  });

  /* ---- static text ---- */
  const texts: string[] = [];

  walkOwn(unit.fn, (node) => {
    if (!ts.isJsxText(node) || texts.length >= 3) return;

    const text = isStaticText(node);
    if (!text || texts.includes(text)) return;

    let conditional = false;
    let cursor: ts.Node | undefined = node.parent;
    while (cursor && cursor !== unit.fn) {
      if (
        ts.isConditionalExpression(cursor) ||
        (ts.isBinaryExpression(cursor) &&
          (cursor.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            cursor.operatorToken.kind === ts.SyntaxKind.BarBarToken)) ||
        (cursor !== unit.fn && isFnNode(cursor))
      ) {
        conditional = true;
        break;
      }
      cursor = cursor.parent;
    }

    if (!conditional) texts.push(text);
  });

  for (const text of texts) {
    add({
      title: `shows ${quote(text)}`,
      category: "render",
      level: "exact",
      reason: `The component always renders the text ${quote(text)}.`,
      line: startLineOf(unit.fn),
      lines: [renderCall(), `expect(screen.getByText(${quote(text)})).toBeTruthy();`],
    });
  }

  /* ---- conditional rendering driven by props ---- */
  let conditionals = 0;

  walkOwn(unit.fn, (node) => {
    if (conditionals >= 3 || !ts.isJsxExpression(node) || !node.expression) return;
    if (insideNestedFunction(node, unit.fn)) return;

    const expr = unwrapExpr(node.expression);
    let cond: ts.Expression | undefined;
    let whenTrue: ts.Node | undefined;
    let whenFalse: ts.Node | undefined;

    if (
      ts.isBinaryExpression(expr) &&
      expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      containsJsx(expr.right)
    ) {
      cond = expr.left;
      whenTrue = expr.right;
    } else if (ts.isConditionalExpression(expr) && (containsJsx(expr.whenTrue) || containsJsx(expr.whenFalse))) {
      cond = expr.condition;
      whenTrue = expr.whenTrue;
      whenFalse = expr.whenFalse;
    }

    if (!cond || !whenTrue) return;

    const condText = shorten(cond.getText(), 45);
    const truthyPlan = planCondition(cond, true, scope);
    const falsyPlan = planCondition(cond, false, scope);
    if (!truthyPlan || !falsyPlan) return;

    const overridesFor = (plan: Plan): Map<string, string> => {
      const overrides = new Map<string, string>();
      const ids = new Set([...plan.values.keys(), ...plan.props.keys()]);
      for (const id of ids) {
        const param = planParamsList.find((entry) => entry.id === id);
        if (param) overrides.set(id, renderParam(param, plan, typedCtx));
      }
      return overrides;
    };

    const shownText = firstStaticText(whenTrue);
    const hiddenText = whenFalse ? firstStaticText(whenFalse) : undefined;

    conditionals++;

    add({
      title: shownText ? `shows ${quote(shownText)} when ${condText}` : `renders the extra content when ${condText}`,
      category: "render",
      level: shownText ? "exact" : "scaffold",
      reason: `Conditional rendering: the content appears when ${condText}.`,
      line: startLineOf(node),
      lines: [
        renderCall(overridesFor(truthyPlan)),
        shownText
          ? `expect(screen.getByText(${quote(shownText)})).toBeTruthy();`
          : `// TODO: assert the content that is shown when ${condText}`,
        ...(shownText ? [] : ["expect(document.body.firstChild).not.toBeNull();"]),
      ],
    });

    if (shownText && !hiddenText) {
      add({
        title: `hides ${quote(shownText)} when not (${condText})`,
        category: "render",
        level: "exact",
        reason: `Conditional rendering: the content is hidden when ${condText} is false.`,
        line: startLineOf(node),
        lines: [renderCall(overridesFor(falsyPlan)), `expect(screen.queryByText(${quote(shownText)})).toBeNull();`],
      });
    } else if (hiddenText) {
      add({
        title: `shows ${quote(hiddenText)} when not (${condText})`,
        category: "render",
        level: "exact",
        reason: `Conditional rendering: the alternative content appears when ${condText} is false.`,
        line: startLineOf(node),
        lines: [renderCall(overridesFor(falsyPlan)), `expect(screen.getByText(${quote(hiddenText)})).toBeTruthy();`],
      });
    }
  });

  /* ---- interactions ---- */
  const handlerNames = [...propsMap.keys()].filter((name) => /^on[A-Z]/.test(name));
  const seenInteractions = new Set<string>();
  let interactions = 0;
  const bang = env.file.isTs ? "!" : "";

  const locatorFor = (element: ts.JsxOpeningElement | ts.JsxSelfClosingElement): { code: string; needsContainer: boolean; tag: string; type?: string } | undefined => {
    const tag = element.tagName.getText();
    const isDom = /^[a-z]/.test(tag);

    const attributeValue = (name: string): string | undefined => {
      for (const attribute of element.attributes.properties) {
        if (ts.isJsxAttribute(attribute) && attribute.name.getText() === name && attribute.initializer) {
          if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text;
        }
      }
      return undefined;
    };

    const label = attributeValue("aria-label");
    if (label) return { code: `screen.getByLabelText(${quote(label)})`, needsContainer: false, tag };

    const placeholder = attributeValue("placeholder");
    if (placeholder) return { code: `screen.getByPlaceholderText(${quote(placeholder)})`, needsContainer: false, tag };

    const text = ts.isJsxOpeningElement(element) && ts.isJsxElement(element.parent) ? firstStaticText(element.parent) : undefined;
    if (text && !text.includes("{")) return { code: `screen.getByText(${quote(text)})`, needsContainer: false, tag };

    if (!isDom) return undefined;

    const type = attributeValue("type");
    const roles: Record<string, string> = { button: "button", a: "link", textarea: "textbox", select: "combobox" };

    if (tag === "input") {
      const role = type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : "textbox";
      return { code: `screen.getByRole(${quote(role)})`, needsContainer: false, tag, type };
    }

    if (tag === "form") return { code: `container.querySelector("form")${bang}`, needsContainer: true, tag };
    if (roles[tag]) return { code: `screen.getByRole(${quote(roles[tag])})`, needsContainer: false, tag };

    return undefined;
  };

  walkOwn(unit.fn, (node) => {
    if (interactions >= 3 || !ts.isJsxAttribute(node)) return;

    const event = node.name.getText();
    if (event !== "onClick" && event !== "onChange" && event !== "onSubmit") return;
    if (!node.initializer || !ts.isJsxExpression(node.initializer) || !node.initializer.expression) return;

    const expression = unwrapExpr(node.initializer.expression);
    const expressionText = expression.getText();

    const handler = handlerNames.find(
      (name) =>
        new RegExp(`\\b${name}\\b`).test(expressionText) ||
        (propsParam !== undefined && expressionText.includes(`${propsParam}.${name}`)),
    );
    if (!handler) return;

    const key = `${handler}:${event}`;
    if (seenInteractions.has(key)) return;

    const element = node.parent.parent;
    if (!ts.isJsxOpeningElement(element) && !ts.isJsxSelfClosingElement(element)) return;

    const locator = locatorFor(element);
    if (!locator) return;

    seenInteractions.add(key);
    interactions++;

    const direct =
      (ts.isIdentifier(expression) && expression.text === handler) ||
      (ts.isPropertyAccessExpression(expression) && expression.name.text === handler) ||
      (ts.isArrowFunction(expression) &&
        !ts.isBlock(expression.body) &&
        ts.isCallExpression(expression.body) &&
        expression.body.expression.getText().endsWith(handler));

    const useUserEvent = env.libs.userEvent;
    let action: string;

    if (event === "onClick") {
      action = useUserEvent ? `await userEvent.click(${locator.code});` : `fireEvent.click(${locator.code});`;
    } else if (event === "onSubmit") {
      action = `fireEvent.submit(${locator.code});`;
    } else if (locator.tag === "input" && locator.type !== "checkbox" && locator.type !== "radio" && useUserEvent) {
      action = `await userEvent.type(${locator.code}, "a");`;
    } else if (locator.type === "checkbox" || locator.type === "radio") {
      action = useUserEvent ? `await userEvent.click(${locator.code});` : `fireEvent.click(${locator.code});`;
    } else {
      action = `fireEvent.change(${locator.code}, { target: { value: "a" } });`;
    }

    const verb = event === "onClick" ? "clicked" : event === "onSubmit" ? "submitted" : "changed";

    add({
      title: `calls ${handler} when ${locator.tag === "form" ? "the form is" : "the control is"} ${verb}`,
      category: "interaction",
      level: direct ? "exact" : "scaffold",
      reason: `${event} on <${locator.tag}> is wired to the ${handler} prop.`,
      line: startLineOf(node),
      lines: [
        `const ${handler} = ${vi}.fn();`,
        renderCall(new Map([[handler, handler]]), locator.needsContainer),
        action,
        event === "onClick" && direct
          ? `expect(${handler}).toHaveBeenCalledTimes(1);`
          : `expect(${handler}).toHaveBeenCalled();`,
      ],
    });
  });

  if (handlerNames.length > 0 && interactions === 0) {
    caveats.push(`Handlers ${handlerNames.join(", ")} are passed as mocks, but no directly wired control was found. Add an interaction test for them.`);
  }

  /* ---- data loaded on mount ---- */
  if ((an.deps.fetch || an.deps.axiosVerbs.length > 0) && an.deps.hookCalls.includes("useEffect")) {
    const called = an.deps.fetch ? "fetch" : `axios.${an.deps.axiosVerbs[0]}`;

    add({
      title: "requests data when mounted",
      category: "state",
      level: "shape",
      reason: "The component fetches data in an effect.",
      line: startLineOf(unit.fn),
      lines: [renderCall(), `await waitFor(() => expect(${called}).toHaveBeenCalled());`],
    });

    add({
      title: "survives a failed request",
      category: "error",
      level: "shape",
      reason: "The request fails; the component should still render.",
      line: startLineOf(unit.fn),
      lines: [
        ...dep.failing,
        renderCall(new Map(), true),
        `await waitFor(() => expect(${called}).toHaveBeenCalled());`,
        "expect(container.firstChild).not.toBeNull();",
      ],
    });
  }

  if (an.deps.hookCalls.some((name) => !["useState", "useEffect", "useMemo", "useCallback", "useRef", "useContext", "useReducer", "useId"].includes(name) && !an.deps.routerNames.includes(name) && !an.deps.providerHooks.includes(name))) {
    caveats.push("It calls custom hooks. If they need providers or network access, wrap or mock them.");
  }

  return { scenarios, piece: dep.piece, top, mocks: dep.mocks, caveats };
}

function isIdentifierNamed(expression: ts.Expression, name: string): boolean {
  const inner = unwrapExpr(expression);
  return ts.isIdentifier(inner) && inner.text === name;
}

/* -------------------------------------------------------------------------- */
/*  Hooks                                                                     */
/* -------------------------------------------------------------------------- */

function buildHookScenarios(unit: Unit, an: Analysis, env: Env, needs: Needs): BuiltUnit {
  const sc = env.sc;
  const dep = buildDepSetup(an.deps, env, needs);
  const scenarios: ScenarioCode[] = [];
  const titles = new Set<string>();
  needs.jsdom = true;

  const params = planParams(unit.fn, sc);
  const args = callArguments(params, newPlan(), sc);
  const hookCall = `${unit.callName}(${args})`;
  const caveats = [...dep.caveats];
  if (env.d.name === "vitest") dep.piece.after.unshift("cleanup();");

  const add = (input: {
    title: string;
    category: ScenarioCategory;
    level: AssertionLevel;
    reason: string;
    line?: number;
    lines: string[];
  }) => {
    if (scenarios.length >= MAX_SCENARIOS_PER_UNIT || titles.has(input.title)) return;
    titles.add(input.title);

    scenarios.push({
      id: `s${scenarios.length + 1}`,
      title: input.title,
      category: input.category,
      assertion: input.level,
      reason: input.reason,
      line: input.line,
      lines: itBlock(input.title, input.lines.some((line) => line.includes("await ")), input.lines),
    });
  };

  // What does the hook return?
  let objectKeys: string[] = [];
  let tupleLength = 0;
  const localFunctions = new Map<string, FnNode>();

  if (unit.fn.body && ts.isBlock(unit.fn.body)) {
    for (const statement of unit.fn.body.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) localFunctions.set(statement.name.text, statement);

      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
          const initializer = unwrapExpr(declaration.initializer);
          const direct = fnFromInitializer(initializer);
          const wrapped =
            ts.isCallExpression(initializer) && /^(React\.)?useCallback$/.test(initializer.expression.getText())
              ? fnFromInitializer(initializer.arguments[0])
              : undefined;
          const found = direct ?? wrapped;
          if (found) localFunctions.set(declaration.name.text, found);
        }
      }
    }

    const returns = unit.fn.body.statements.filter(ts.isReturnStatement);
    const last = returns[returns.length - 1];
    const value = last?.expression ? unwrapExpr(last.expression) : undefined;

    if (value && ts.isObjectLiteralExpression(value)) {
      for (const property of value.properties) {
        const key = ts.isShorthandPropertyAssignment(property) || ts.isPropertyAssignment(property) ? propertyNameText(property.name) : undefined;
        if (key) objectKeys.push(key);
      }
    } else if (value && ts.isArrayLiteralExpression(value)) {
      tupleLength = value.elements.length;
    }
  } else if (unit.fn.body) {
    const value = unwrapExpr(unit.fn.body as ts.Expression);
    if (ts.isObjectLiteralExpression(value)) {
      for (const property of value.properties) {
        const key = ts.isShorthandPropertyAssignment(property) || ts.isPropertyAssignment(property) ? propertyNameText(property.name) : undefined;
        if (key) objectKeys.push(key);
      }
    }
  }

  objectKeys = objectKeys.slice(0, 8);
  const rendered = `const { result } = renderHook(() => ${hookCall});`;

  if (objectKeys.length > 0) {
    add({
      title: "returns the documented fields",
      category: "happy",
      level: "exact",
      reason: `The hook returns an object with ${objectKeys.join(", ")}.`,
      line: startLineOf(unit.fn),
      lines: [rendered, ...objectKeys.slice(0, 6).map((key) => `expect(result.current).toHaveProperty(${quote(key)});`)],
    });
  } else if (tupleLength > 0) {
    add({
      title: "returns a tuple",
      category: "happy",
      level: "exact",
      reason: `The hook returns an array of ${tupleLength} values.`,
      line: startLineOf(unit.fn),
      lines: [rendered, "expect(Array.isArray(result.current)).toBe(true);", `expect(result.current).toHaveLength(${tupleLength});`],
    });
  } else {
    add({
      title: "runs without throwing",
      category: "happy",
      level: "shape",
      reason: "Smoke test: the hook can be rendered with typical arguments.",
      line: startLineOf(unit.fn),
      lines: [rendered, "expect(result.current).toBeDefined();"],
    });
  }

  const actionPattern = /^(set|toggle|reset|increment|decrement|add|remove|update|clear|handle|open|close|select|refresh|load|fetch)/;
  const actions = objectKeys.filter((key) => localFunctions.has(key) || actionPattern.test(key)).slice(0, 3);

  for (const key of actions) {
    const fn = localFunctions.get(key);
    const actionParams = fn ? planParams(fn, sc) : [];
    const actionArgs = callArguments(actionParams, newPlan(), sc);
    const isAsyncAction = !!fn?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);

    add({
      title: `exposes ${key} as a function`,
      category: "state",
      level: "exact",
      reason: `${key} is returned by the hook and should be callable.`,
      line: fn ? startLineOf(fn) : startLineOf(unit.fn),
      lines: [rendered, `expect(typeof result.current.${key}).toBe("function");`],
    });

    add({
      title: `updates state when ${key} is called`,
      category: "state",
      level: "scaffold",
      reason: `Calls ${key} inside act(); add the state you expect afterwards.`,
      line: fn ? startLineOf(fn) : startLineOf(unit.fn),
      lines: [
        rendered,
        isAsyncAction ? "await act(async () => {" : "act(() => {",
        `  ${isAsyncAction ? "await " : ""}result.current.${key}(${actionArgs});`,
        "});",
        "// TODO: assert the state you expect after the update",
        "expect(result.current).toBeDefined();",
      ],
    });
  }

  if (tupleLength === 2) {
    add({
      title: "updates the value through the setter",
      category: "state",
      level: "scaffold",
      reason: "The hook returns [value, setter]; call the setter inside act().",
      line: startLineOf(unit.fn),
      lines: [
        rendered,
        "act(() => {",
        `  result.current[1](${sampleForName("value")});`,
        "});",
        "// TODO: assert the new value",
        "expect(result.current[0]).toBeDefined();",
      ],
    });
  }

  if (an.deps.fetch || an.deps.axiosVerbs.length > 0) {
    const called = an.deps.fetch ? "fetch" : `axios.${an.deps.axiosVerbs[0]}`;

    add({
      title: "requests data",
      category: "async",
      level: "shape",
      reason: "The hook performs a network request.",
      line: startLineOf(unit.fn),
      lines: [rendered, `await waitFor(() => expect(${called}).toHaveBeenCalled());`],
    });
  }

  if (an.deps.providerHooks.length > 0) {
    caveats.push(`Uses ${an.deps.providerHooks.join(", ")}. Pass a wrapper to renderHook if it needs a provider.`);
  }

  return { scenarios, piece: dep.piece, top: [], mocks: dep.mocks, caveats };
}

function buildScenarios(unit: Unit, an: Analysis, env: Env, needs: Needs): BuiltUnit {
  if (unit.kind === "component") return buildComponentScenarios(unit, an, env, needs);
  if (unit.kind === "hook") return buildHookScenarios(unit, an, env, needs);
  return buildFunctionScenarios(unit, an, env, needs);
}


/* -------------------------------------------------------------------------- */
/*  Existing tests                                                            */
/* -------------------------------------------------------------------------- */

interface TestBlock {
  title: string;
  text: string;
}

interface TestFileInfo {
  file: ParsedFile;
  byTarget: Map<string, { named: Map<string, string>; namespaces: string[] }>;
  blocks: TestBlock[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function indexTestFile(file: ParsedFile, ctx: Ctx): TestFileInfo {
  const byTarget: TestFileInfo["byTarget"] = new Map();

  for (const [local, reference] of file.imports) {
    const target = resolveModule(file, reference.specifier, ctx);
    if (!target || target.isTest) continue;

    const entry = byTarget.get(target.abs) ?? { named: new Map<string, string>(), namespaces: [] };
    if (reference.imported === "*") entry.namespaces.push(local);
    else entry.named.set(reference.imported, local);
    byTarget.set(target.abs, entry);
  }

  const blocks: TestBlock[] = [];

  walk(file.sf, (node) => {
    if (!ts.isCallExpression(node)) return;

    let callee = unwrapExpr(node.expression);
    if (ts.isCallExpression(callee)) callee = unwrapExpr(callee.expression); // it.each(table)(...)

    const base = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        ? callee.expression.text
        : undefined;

    if (base !== "it" && base !== "test" && base !== "specify") return;

    const title = node.arguments[0];
    if (!title || !ts.isStringLiteralLike(title)) return;

    blocks.push({ title: title.text, text: node.getText() });
  });

  return { file, byTarget, blocks };
}

function countExistingTests(
  unit: Unit,
  tests: TestFileInfo[],
  sourceAbs: string,
): { count: number; file?: string; anyFile?: string } {
  let count = 0;
  let file: string | undefined;
  let anyFile: string | undefined;

  for (const info of tests) {
    const entry = info.byTarget.get(sourceAbs);
    if (!entry) continue;

    anyFile ??= info.file.rel;

    const local = entry.named.get(unit.exportedAs);
    const subject = unit.kind === "method" ? unit.methodName! : unit.callName;

    for (const block of info.blocks) {
      let matches = false;

      if (local) {
        const usesLocal = new RegExp(`(?<![\\w$])${escapeRegExp(local)}(?![\\w$])`).test(block.text);
        matches = unit.kind === "method" ? usesLocal && block.text.includes(`.${subject}(`) : usesLocal;
      }

      if (!matches) {
        matches = entry.namespaces.some((namespace) => block.text.includes(`${namespace}.${unit.callName}`));
      }

      if (!matches) matches = block.title.includes(subject);

      if (matches) {
        count++;
        file ??= info.file.rel;
      }
    }
  }

  return { count, file, anyFile };
}

/* -------------------------------------------------------------------------- */
/*  Packages and test setup                                                   */
/* -------------------------------------------------------------------------- */

interface PackageInfo {
  dir: string;
  deps: Record<string, string>;
  scripts: Record<string, string>;
}

function readPackages(root: string, packageJsons: string[]): PackageInfo[] {
  const packages: PackageInfo[] = [];

  for (const absolute of packageJsons) {
    try {
      const parsed = JSON.parse(fs.readFileSync(absolute, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };

      const dir = normalizeFsPath(path.relative(root, path.dirname(absolute))) || ".";
      packages.push({
        dir,
        deps: { ...parsed.dependencies, ...parsed.devDependencies },
        scripts: parsed.scripts ?? {},
      });
    } catch {
      // A broken package.json is not fatal.
    }
  }

  if (!packages.some((entry) => entry.dir === ".")) packages.push({ dir: ".", deps: {}, scripts: {} });

  return packages.sort((a, b) => b.dir.length - a.dir.length);
}

function packageFor(rel: string, packages: PackageInfo[]): PackageInfo {
  return (
    packages.find((entry) => entry.dir !== "." && (rel === entry.dir || rel.startsWith(`${entry.dir}/`))) ??
    packages.find((entry) => entry.dir === ".")!
  );
}

function detectFramework(pkg: PackageInfo): FrameworkName | "none" {
  const has = (name: string) => name in pkg.deps;
  const jest = has("jest") || has("ts-jest") || has("@types/jest") || has("babel-jest") || has("@jest/globals");
  const vitest = has("vitest");

  if (vitest && jest) return /jest/.test(pkg.scripts.test ?? "") && !/vitest/.test(pkg.scripts.test ?? "") ? "jest" : "vitest";
  if (vitest) return "vitest";
  if (jest) return "jest";
  return "none";
}

function librariesOf(pkg: PackageInfo): Libs & { jestDom: boolean; jsdom: boolean } {
  const has = (name: string) => name in pkg.deps;

  return {
    rtl: has("@testing-library/react"),
    userEvent: has("@testing-library/user-event"),
    jestDom: has("@testing-library/jest-dom"),
    jsdom: has("jsdom") || has("happy-dom") || has("jest-environment-jsdom"),
    routerPackage: has("react-router-dom") ? "react-router-dom" : has("react-router") ? "react-router" : undefined,
  };
}

type Placement = "colocated" | "tests-folder" | "mirror";

function plannedTestPath(
  sourceRel: string,
  pkgDir: string,
  placement: Placement,
  suffix: ".test" | ".spec",
  hasJsx: boolean,
): string {
  const dir = path.posix.dirname(sourceRel);
  const extension = path.posix.extname(sourceRel);
  const base = path.posix.basename(sourceRel, extension);

  let testExtension = /^\.(tsx|jsx)$/.test(extension)
    ? extension
    : /^\.(ts|mts|cts)$/.test(extension)
      ? ".ts"
      : ".js";

  if (hasJsx && testExtension === ".ts") testExtension = ".tsx";
  if (hasJsx && testExtension === ".js") testExtension = ".jsx";

  const file = `${base}${suffix}${testExtension}`;

  if (placement === "tests-folder") return path.posix.join(dir, "__tests__", file);

  if (placement === "mirror") {
    const insidePackage = pkgDir === "." ? dir : dir.slice(pkgDir.length + 1);
    const withoutSrc = insidePackage.replace(/^src(\/|$)/, "");
    return path.posix.join(pkgDir === "." ? "" : pkgDir, "tests", withoutSrc, file);
  }

  return path.posix.join(dir, file);
}

function detectPlacement(testFiles: ParsedFile[], pkg: PackageInfo): { placement: Placement; suffix: ".test" | ".spec"; count: number } {
  const own = testFiles.filter((file) => packageFor(file.rel, [pkg, { dir: ".", deps: {}, scripts: {} }]) === pkg && (pkg.dir === "." || file.rel.startsWith(`${pkg.dir}/`)));

  const counts: Record<Placement, number> = { colocated: 0, "tests-folder": 0, mirror: 0 };
  let spec = 0;
  let test = 0;

  for (const file of own) {
    if (/\.spec\./.test(file.rel)) spec++;
    else if (/\.test\./.test(file.rel)) test++;

    if (file.rel.includes("/__tests__/") || file.rel.startsWith("__tests__/")) counts["tests-folder"]++;
    else if (/(^|\/)tests?\//.test(file.rel.slice(pkg.dir === "." ? 0 : pkg.dir.length + 1))) counts.mirror++;
    else counts.colocated++;
  }

  const placement = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0] as [Placement, number]);

  return {
    placement: placement[1] > 0 ? placement[0] : "colocated",
    suffix: spec > test ? ".spec" : ".test",
    count: own.length,
  };
}

/* -------------------------------------------------------------------------- */
/*  Rendering code                                                            */
/* -------------------------------------------------------------------------- */

function mergeNeeds(target: Needs, source: Needs): void {
  source.named.forEach((name) => target.named.add(name));
  if (source.defaultName) target.defaultName = source.defaultName;
  source.extraImports.forEach((line) => target.extraImports.add(line));
  source.moduleMocks.forEach((line) => target.moduleMocks.add(line));
  target.jsdom ||= source.jsdom;
  target.router ??= source.router;
}

function renderHeader(needs: Needs, body: string, env: Env, subjectPath: string): string {
  const lines: string[] = [];
  const used = (pattern: RegExp) => pattern.test(body);

  if (needs.jsdom) {
    lines.push(env.d.name === "vitest" ? "// @vitest-environment jsdom" : "/** @jest-environment jsdom */");
    lines.push("");
  }

  if (env.d.name === "vitest") {
    const names = [
      used(/\bdescribe\(/) && "describe",
      used(/\bit\(/) && "it",
      used(/\bexpect\b/) && "expect",
      used(/\bvi\./) && "vi",
      used(/\bbeforeEach\(/) && "beforeEach",
      used(/\bafterEach\(/) && "afterEach",
    ].filter(Boolean) as string[];

    if (names.length) lines.push(`import { ${names.join(", ")} } from "vitest";`);
  }

  const hasJsx = /<[A-Z]\w*[\s/>]/.test(body);
  if (hasJsx && env.reactImport) lines.push('import React from "react";');

  const rtl = [
    used(/\brender\(/) && "render",
    used(/\bscreen\./) && "screen",
    used(/\bfireEvent\./) && "fireEvent",
    used(/\bwaitFor\(/) && "waitFor",
    used(/\brenderHook\(/) && "renderHook",
    used(/\bact\(/) && "act",
    used(/\bcleanup\(/) && "cleanup",
  ].filter(Boolean) as string[];

  if (rtl.length) lines.push(`import { ${rtl.join(", ")} } from "@testing-library/react";`);
  if (used(/\buserEvent\./)) lines.push('import userEvent from "@testing-library/user-event";');
  if (needs.router && used(/<MemoryRouter>/)) lines.push(`import { MemoryRouter } from "${needs.router}";`);

  const named = [...needs.named].sort();
  const clause = [needs.defaultName, named.length ? `{ ${named.join(", ")} }` : undefined]
    .filter(Boolean)
    .join(", ");

  if (clause) lines.push(`import ${clause} from ${quote(subjectPath)};`);

  for (const extra of needs.extraImports) lines.push(extra);

  if (needs.moduleMocks.size > 0) {
    lines.push("");
    for (const mock of needs.moduleMocks) lines.push(mock);
  }

  return lines.join("\n");
}

function renderDescribe(unit: Unit, built: BuiltUnit): string[] {
  const inner: string[] = [];

  if (built.piece.moduleLevel.length) inner.push(...built.piece.moduleLevel, "");
  if (built.top.length) inner.push(...built.top);

  if (built.piece.before.length) {
    inner.push("beforeEach(() => {", ...indentLines(built.piece.before, 2), "});", "");
  }

  if (built.piece.after.length) {
    inner.push("afterEach(() => {", ...indentLines(built.piece.after, 2), "});", "");
  }

  built.scenarios.forEach((scenario, index) => {
    if (index > 0) inner.push("");
    inner.push(...scenario.lines);
  });

  return [`describe(${quote(unit.name)}, () => {`, ...indentLines(inner, 2), "});"];
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                      */
/* -------------------------------------------------------------------------- */

function severityFor(score: number): TestSeverity {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 40) return "medium";
  if (score >= 22) return "low";
  return "info";
}

const SEVERITY_RANK: Record<TestSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

const KIND_WORD: Record<UnitKind, string> = {
  function: "function",
  method: "method",
  component: "component",
  hook: "hook",
};

export async function generateTests(
  projectPath: string,
  filePath?: string,
  options: { framework?: FrameworkChoice; includeTested?: boolean } = {},
): Promise<TestGeneratorReport> {
  const frameworkChoice: FrameworkChoice = options.framework ?? "auto";
  const includeTested = options.includeTested ?? false;

  if (!["auto", "vitest", "jest"].includes(frameworkChoice)) {
    throw new Error("framework must be auto, vitest, or jest.");
  }

  if (filePath !== undefined && (path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes(".."))) {
    throw new Error("filePath must be relative to projectPath.");
  }

  const resolvedProject = await resolveProjectPath(projectPath);
  const root = fs.realpathSync(resolvedProject.projectPath);
  const warnings: string[] = [];

  const warn = (message: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message);
    else if (warnings.length === MAX_WARNINGS) warnings.push("Further warnings were omitted.");
  };

  const discovered = discoverFiles(root);

  if (discovered.truncated) {
    warn(`Only the first ${MAX_FILES} source files were analyzed. Narrow the project path for complete results.`);
  }

  const relative = (absolute: string) => normalizeFsPath(path.relative(root, absolute));
  const candidates = discovered.files.filter((file) => !IGNORED_SOURCE_PATTERN.test(relative(file)));

  if (candidates.length === 0) {
    throw new Error(`No JavaScript or TypeScript source files were found in ${root}.`);
  }

  const ctx: Ctx = { root, files: [], byAbs: new Map(), moduleCache: new Map() };
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

    const rel = relative(absolute);
    const sf = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true, scriptKindFor(absolute));

    const file: ParsedFile = {
      index: ctx.files.length,
      abs: absolute,
      rel,
      text,
      sf,
      lineCount: sf.getLineAndCharacterOfPosition(text.length).line + 1,
      isTest: TEST_FILE_PATTERN.test(rel),
      isTs: /\.(ts|tsx|mts|cts)$/.test(rel),
      imports: new Map(),
      topLevel: new Map(),
      exportedNames: new Map(),
    };

    if (!file.isTest) totalLines += file.lineCount;
    ctx.files.push(file);
    ctx.byAbs.set(absolute, file);
    indexFile(file);
  }

  const sourceFiles = ctx.files.filter((file) => !file.isTest);
  const testFiles = ctx.files.filter((file) => file.isTest);

  const testInfos = testFiles.map((file) => indexTestFile(file, ctx));
  const testsBySource = new Map<string, TestFileInfo[]>();

  for (const info of testInfos) {
    for (const target of info.byTarget.keys()) {
      const list = testsBySource.get(target) ?? [];
      list.push(info);
      testsBySource.set(target, list);
    }
  }

  const packages = readPackages(root, discovered.packageJsons);

  /* ---- per-package conventions ---- */
  const conventions = new Map<string, { placement: Placement; suffix: ".test" | ".spec"; count: number; useJsExt: boolean }>();

  for (const pkg of packages) {
    const detected = detectPlacement(testFiles, pkg);
    let withExtension = 0;
    let withoutExtension = 0;

    for (const file of sourceFiles) {
      if (packageFor(file.rel, packages) !== pkg) continue;
      for (const reference of file.imports.values()) {
        if (!reference.specifier.startsWith(".")) continue;
        if (/\.(js|jsx)$/.test(reference.specifier)) withExtension++;
        else if (!/\.\w+$/.test(path.posix.basename(reference.specifier))) withoutExtension++;
      }
    }

    conventions.set(pkg.dir, { ...detected, useJsExt: withExtension >= 3 && withExtension > withoutExtension });
  }

  /* ---- units ---- */
  const focus = filePath ? normalizeFsPath(filePath).replace(/\/+$/, "") : undefined;
  const inFocus = (rel: string) => !focus || rel === focus || rel.startsWith(`${focus}/`);

  if (focus && !ctx.files.some((file) => inFocus(file.rel) && !file.isTest)) {
    warn(`${focus} did not match any analyzed source file or folder.`);
  }

  interface Built {
    target: TestTarget;
    needs: Needs;
    describe: string[];
    pkg: PackageInfo;
    env: Env;
    sourceRel: string;
    hasJsx: boolean;
  }

  const built: Built[] = [];
  const unitsByPackage = new Map<string, { units: number; react: boolean }>();
  let unitsFound = 0;
  let untestedUnits = 0;
  let partialUnits = 0;
  let testedUnits = 0;

  for (const file of sourceFiles) {
    if (!inFocus(file.rel)) continue;

    const units = extractUnits(file);
    if (units.length === 0) continue;

    const pkg = packageFor(file.rel, packages);
    const convention = conventions.get(pkg.dir)!;
    const detected = detectFramework(pkg);
    const framework: FrameworkName = frameworkChoice === "auto" ? (detected === "none" ? "vitest" : detected) : frameworkChoice;
    const d: Dialect = { name: framework, vi: framework === "jest" ? "jest" : "vi" };
    const libs = librariesOf(pkg);

    const infos = testsBySource.get(file.abs) ?? [];
    const existingFile = infos[0]?.file.rel;
    const hasJsx = units.some((unit) => unit.kind === "component");

    const testRel =
      existingFile ?? plannedTestPath(file.rel, pkg.dir, convention.placement, convention.suffix, hasJsx);
    const testAction: "create" | "append" = existingFile ? "append" : "create";

    const env: Env = {
      ctx,
      file,
      d,
      sc: { file, ctx, d },
      testAbs: path.join(root, testRel),
      useJsExt: convention.useJsExt,
      libs: {
        ...libs,
        routerPackage:
          [...file.imports.values()].find((reference) => /^react-router(-dom)?$/.test(reference.specifier))?.specifier ??
          libs.routerPackage,
      },
      reactImport: file.imports.get("React")?.specifier === "react",
    };

    const packageStats = unitsByPackage.get(pkg.dir) ?? { units: 0, react: false };

    for (const unit of units) {
      unitsFound++;
      packageStats.units++;
      if (unit.kind === "component" || unit.kind === "hook") packageStats.react = true;

      const analysis = analyzeFunction(unit, ctx);
      const needs = emptyNeeds();

      if (unit.exportKind === "default") needs.defaultName = unit.callName;
      else needs.named.add(unit.callName);

      const result = buildScenarios(unit, analysis, env, needs);
      const existing = countExistingTests(unit, infos, file.abs);
      const needed = result.scenarios.length;

      const status: TestStatus =
        existing.count === 0
          ? "untested"
          : existing.count < Math.max(2, Math.ceil(needed / 2)) && analysis.complexity > 1
            ? "partial"
            : "tested";

      if (status === "untested") untestedUnits++;
      else if (status === "partial") partialUnits++;
      else testedUnits++;

      if (status === "tested" && !includeTested) continue;

      const describe = renderDescribe(unit, result);
      const subjectPath = importPathTo(env, file.abs);
      const body = describe.join("\n");
      const setupCode = renderHeader(needs, body, env, subjectPath);

      const mocks = [...new Set(result.mocks)];
      const branches = analysis.chains.reduce((total, chain) => total + chain.branches.length + (chain.otherwise ? 1 : 0), 0) +
        analysis.switches.reduce((total, statement) => total + statement.caseBlock.clauses.length, 0);

      let score =
        20 +
        Math.min(40, analysis.complexity * 4) +
        (analysis.throwsCount > 0 ? 6 : 0) +
        (analysis.isAsync ? 6 : 0) +
        (mocks.length > 0 ? 6 : 0) +
        (unit.kind === "component" ? 4 : 0) +
        Math.min(8, unit.fn.parameters.length * 2);

      score = Math.round(Math.min(100, score * (status === "untested" ? 1 : status === "partial" ? 0.65 : 0.3)));

      const exact = result.scenarios.filter((scenario) => scenario.assertion === "exact").length;
      const review = result.scenarios.filter((scenario) => scenario.assertion === "scaffold").length;

      const caveats = [...new Set(result.caveats)];
      if (review > 0) {
        caveats.push(`${review} test${review === 1 ? " has" : "s have"} a TODO assertion. Replace it with the value you expect.`);
      }
      if ((unit.kind === "component" || unit.kind === "hook") && !libs.rtl) {
        caveats.push("@testing-library/react is not in package.json. Install it before running these tests.");
      }
      if (existing.count > 0) {
        caveats.push(`${existing.count} existing test${existing.count === 1 ? "" : "s"} already cover this. Compare the scenarios below before adding duplicates.`);
      }

      const params: ParamInfo[] = unit.fn.parameters.map((parameter) => ({
        name: parameter.name.getText(),
        type: parameter.type?.getText() ?? "unknown",
        optional: !!parameter.questionToken || !!parameter.initializer,
        defaultValue: parameter.initializer?.getText(),
        rest: !!parameter.dotDotDotToken,
      }));

      const signature = `(${unit.fn.parameters.map((parameter) => parameter.getText()).join(", ")})${unit.fn.type ? `: ${unit.fn.type.getText()}` : ""}`;

      const startLine = startLineOf(unit.node);
      const endLine = endLineOf(unit.node);
      const sourceLines = fileLinesOf(file).slice(startLine - 1, endLine);
      const capped = sourceLines.slice(0, MAX_SNIPPET_LINES);

      const pkgRelativeTest = pkg.dir === "." ? testRel : testRel.slice(pkg.dir.length + 1);
      const runner = framework === "jest" ? "npx jest" : "npx vitest run";
      const runCommand = `${pkg.dir === "." ? "" : `cd ${pkg.dir} && `}${runner} ${pkgRelativeTest}`;

      const title =
        status === "untested"
          ? `${unit.name} has no tests`
          : status === "partial"
            ? `${unit.name} has ${existing.count} test${existing.count === 1 ? "" : "s"}, but ${needed} scenarios were found`
            : `${unit.name} already has ${existing.count} tests`;

      const description =
        `This ${KIND_WORD[unit.kind]} has complexity ${analysis.complexity} with ${branches} branch${branches === 1 ? "" : "es"}` +
        `${analysis.throwsCount ? ` and ${analysis.throwsCount} throw${analysis.throwsCount === 1 ? "" : "s"}` : ""}. ` +
        `${needed} test${needed === 1 ? " was" : "s were"} generated: ${exact} assert${exact === 1 ? "s" : ""} a value taken from the code, ` +
        `${review} need${review === 1 ? "s" : ""} your expected value, and the rest check types or that nothing throws.`;

      const target: TestTarget = {
        id: shortHash(file.rel, unit.name, String(startLine)),
        name: unit.name,
        kind: unit.kind,
        exportKind: unit.exportKind,
        filePath: file.rel,
        startLine,
        endLine,
        fileLines: file.lineCount,
        signature,
        async: analysis.isAsync,
        params,
        complexity: analysis.complexity,
        branches,
        throwsCount: analysis.throwsCount,
        mocks,
        status,
        existingTests: existing.count,
        existingTestFile: existing.file ?? existing.anyFile,
        priority: severityFor(score),
        score,
        title,
        description,
        scenarios: result.scenarios.map(({ lines: _lines, ...scenario }) => scenario),
        source: {
          startLine,
          endLine,
          snippet: dedent(capped).join("\n"),
          truncated: sourceLines.length > capped.length,
        },
        testPath: testRel,
        testAction,
        setupCode,
        testCode: body,
        runCommand,
        caveats,
      };

      built.push({ target, needs, describe, pkg, env, sourceRel: file.rel, hasJsx });
    }

    unitsByPackage.set(pkg.dir, packageStats);
  }

  if (unitsFound === 0) {
    warn("No exported functions, classes, components or hooks were found, so there is nothing to generate tests for.");
  }

  /* ---- order and cap ---- */
  built.sort((a, b) => b.target.score - a.target.score || a.target.name.localeCompare(b.target.name));
  const totalTargets = built.length;
  const reported = built.slice(0, MAX_TARGETS);

  if (totalTargets > reported.length) {
    warn(`Showing the ${MAX_TARGETS} highest-priority targets of ${totalTargets}.`);
  }

  /* ---- per-file bundles ---- */
  const bySource = new Map<string, Built[]>();
  for (const item of reported) {
    if (item.target.status === "tested") continue;
    const list = bySource.get(item.sourceRel) ?? [];
    list.push(item);
    bySource.set(item.sourceRel, list);
  }

  const files: GeneratedTestFile[] = [];

  for (const [sourceRel, items] of bySource) {
    const first = items[0];
    const merged = emptyNeeds();
    for (const item of items) mergeNeeds(merged, item.needs);

    const describes = items.flatMap((item, index) => (index > 0 ? ["", ...item.describe] : item.describe));
    const body = describes.join("\n");
    const header = renderHeader(merged, body, first.env, importPathTo(first.env, ctx.byAbs.get(path.join(root, sourceRel))!.abs));
    const scenarios = items.reduce((total, item) => total + item.target.scenarios.length, 0);
    const needsReview = items.reduce(
      (total, item) => total + item.target.scenarios.filter((scenario) => scenario.assertion === "scaffold").length,
      0,
    );

    files.push({
      sourcePath: sourceRel,
      testPath: first.target.testPath,
      action: first.target.testAction,
      framework: first.env.d.name,
      units: items.length,
      scenarios,
      needsReview,
      content: `${header}\n\n${body}\n`,
      runCommand: first.target.runCommand,
    });
  }

  files.sort((a, b) => b.scenarios - a.scenarios || a.sourcePath.localeCompare(b.sourcePath));
  const outputFiles = files.slice(0, MAX_FILES_OUTPUT);

  /* ---- setup report ---- */
  const setups: TestSetup[] = [];

  for (const pkg of packages) {
    const stats = unitsByPackage.get(pkg.dir);
    if (!stats) continue;

    const detected = detectFramework(pkg);
    const framework: FrameworkName = frameworkChoice === "auto" ? (detected === "none" ? "vitest" : detected) : frameworkChoice;
    const libs = librariesOf(pkg);
    const convention = conventions.get(pkg.dir)!;
    const missing: string[] = [];
    const notes: string[] = [];

    if (detected === "none" || detected !== framework) missing.push(framework);
    if (framework === "jest" && !("@types/jest" in pkg.deps)) missing.push("@types/jest");

    if (stats.react) {
      if (!libs.rtl) missing.push("@testing-library/react");
      if (!libs.jsdom) missing.push(framework === "vitest" ? "jsdom" : "jest-environment-jsdom");
      notes.push(
        framework === "vitest"
          ? "Component and hook tests start with a // @vitest-environment jsdom comment, so no config change is needed."
          : "Component and hook tests start with a @jest-environment jsdom docblock, so no config change is needed.",
      );
    }

    const testScript = pkg.scripts.test ?? "";
    const hasTestScript = testScript !== "" && !/no test specified/.test(testScript);
    if (!hasTestScript) {
      notes.push(`Add "test": "${framework === "jest" ? "jest" : "vitest run"}" to the scripts in ${pkg.dir === "." ? "package.json" : `${pkg.dir}/package.json`}.`);
    }

    notes.push(
      convention.count > 0
        ? `Test files are placed to match your existing ${convention.placement.replace("-", " ")} convention (${convention.suffix}).`
        : "No existing tests were found, so test files are placed next to the source files.",
    );

    const unique = [...new Set(missing)];

    setups.push({
      packagePath: pkg.dir,
      detected,
      framework,
      frameworkSource:
        frameworkChoice !== "auto"
          ? "chosen in the options"
          : detected === "none"
            ? "no test framework found, defaulting to Vitest"
            : `found in package.json`,
      libraries: [
        libs.rtl && "React Testing Library",
        libs.userEvent && "user-event",
        libs.jestDom && "jest-dom",
        libs.jsdom && "jsdom",
        libs.routerPackage,
      ].filter(Boolean) as string[],
      hasTestScript,
      placement: convention.placement,
      existingTestFiles: convention.count,
      units: stats.units,
      missing: unique,
      installCommand: unique.length
        ? `${pkg.dir === "." ? "" : `cd ${pkg.dir} && `}npm install -D ${unique.join(" ")}`
        : undefined,
      notes,
    });
  }

  setups.sort((a, b) => b.units - a.units);

  /* ---- summary and hotspots ---- */
  const summary: Record<TestSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const item of reported) summary[item.target.priority]++;

  const perFile = new Map<string, TestHotspot>();
  for (const item of reported) {
    if (item.target.status === "tested") continue;

    const entry = perFile.get(item.target.filePath) ?? {
      filePath: item.target.filePath,
      untested: 0,
      complexity: 0,
      worstPriority: "info" as TestSeverity,
    };

    entry.untested++;
    entry.complexity += item.target.complexity;
    if (SEVERITY_RANK[item.target.priority] > SEVERITY_RANK[entry.worstPriority]) {
      entry.worstPriority = item.target.priority;
    }
    perFile.set(item.target.filePath, entry);
  }

  const hotspots = [...perFile.values()]
    .sort(
      (a, b) =>
        b.untested - a.untested ||
        SEVERITY_RANK[b.worstPriority] - SEVERITY_RANK[a.worstPriority] ||
        a.filePath.localeCompare(b.filePath),
    )
    .slice(0, MAX_HOTSPOTS);

  for (const setup of setups) {
    if (setup.missing.length > 0) {
      warn(`${setup.packagePath === "." ? "The project" : setup.packagePath} is missing: ${setup.missing.join(", ")}. See Test setup.`);
    }
  }

  const targets = reported.map((item) => item.target);
  const scenariosGenerated = targets.reduce((total, target) => total + target.scenarios.length, 0);
  const scenariosNeedingReview = targets.reduce(
    (total, target) => total + target.scenarios.filter((scenario) => scenario.assertion === "scaffold").length,
    0,
  );

  return {
    success: true,
    tool: "generate_tests",
    projectPath: root,
    filePath: focus,
    framework: frameworkChoice,
    includeTested,
    filesScanned: sourceFiles.length,
    totalLines,
    testFilesFound: testFiles.length,
    unitsFound,
    untestedUnits,
    partialUnits,
    testedUnits,
    coveragePercentage: unitsFound === 0 ? 0 : Math.round((testedUnits / unitsFound) * 1000) / 10,
    totalTargets,
    scenariosGenerated,
    scenariosNeedingReview,
    filesToWrite: outputFiles.length,
    summary,
    targets,
    files: outputFiles,
    setups,
    hotspots,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/*  MCP registration                                                          */
/* -------------------------------------------------------------------------- */

export function registerGenerateTestsTool(server: McpServer) {
  server.registerTool(
    "generate_tests",
    {
      description:
        "Find exported functions, class methods, React components and hooks that lack tests, and generate runnable Vitest or Jest tests for them. Detects the project's test framework, libraries and file placement; maps existing tests to source files; and writes one scenario per branch with inputs derived from the conditions, plus edge cases, error cases and React render and interaction tests. Assertions are exact only when the expected value is a literal in the source; the rest are clearly marked. The tool never writes files: it returns the code, a suggested path, and whether to create or append.",
      inputSchema: z.object({
        projectPath: z.string().describe("Absolute path to the project directory"),
        filePath: z
          .string()
          .optional()
          .describe("Optional file or folder, relative to projectPath. Only code inside it is analyzed."),
        framework: z
          .enum(["auto", "vitest", "jest"])
          .optional()
          .describe("Test framework to generate for. Default auto (detected from package.json)."),
        includeTested: z
          .boolean()
          .optional()
          .describe("Also list code that already has enough tests. Default false."),
      }),
    },
    async ({ projectPath, filePath, framework, includeTested }) => {
      try {
        const report = await generateTests(projectPath, filePath, { framework, includeTested });

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
                  tool: "generate_tests",
                  error: error instanceof Error ? error.message : "Failed to generate tests.",
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