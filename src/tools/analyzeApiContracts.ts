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

type ContractSeverity = "critical" | "high" | "medium" | "low" | "info";
type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";
type EndpointMethod = HttpMethod | "ALL";
type CallMethod = HttpMethod | "UNKNOWN";
type ClientKind = "fetch" | "axios" | "ky" | "angular" | "swr" | "rtk" | "http";
type Framework = "express" | "fastify" | "koa" | "hono" | "nest" | "next";

/**
 * mismatch - a client call and a backend route disagree.
 * unused   - a backend route that no client call reaches.
 * route    - a problem between backend routes (duplicates, shadowing).
 */
type IssueGroup = "mismatch" | "unused" | "route";

type IssueKind =
  | "method-mismatch"
  | "missing-endpoint"
  | "missing-body"
  | "missing-body-field"
  | "extra-body-field"
  | "missing-query-param"
  | "extra-query-param"
  | "response-field-mismatch"
  | "unused-endpoint"
  | "duplicate-route"
  | "route-shadowed";

type FixStrategy =
  | "update-client-call"
  | "add-backend-route"
  | "update-client-payload"
  | "update-backend-handler"
  | "align-response"
  | "reorder-routes"
  | "remove-duplicate-route"
  | "remove-or-document";

interface ContractEvidence {
  role: "frontend" | "backend";
  label: string;
  filePath: string;
  startLine: number;
  endLine: number;
  /** Total number of lines in the file, used to draw the position bar. */
  fileLines: number;
  symbol?: string;
  /** Dedented source, capped at MAX_SNIPPET_LINES. */
  snippet: string;
  snippetTruncated: boolean;
  /** Absolute line numbers inside the snippet that relate to the issue. */
  highlightLines: number[];
}

interface FieldRow {
  name: string;
  client: boolean;
  server: boolean;
  required?: boolean;
  status: "match" | "missing-on-server" | "missing-on-client" | "optional";
}

interface FieldComparison {
  area: "body" | "query" | "response";
  clientLabel: string;
  serverLabel: string;
  rows: FieldRow[];
}

interface ContractSuggestion {
  strategy: FixStrategy;
  confidence: "high" | "medium" | "low";
  title: string;
  summary: string;
  steps: string[];
  /** Ready-to-paste code (stub, before/after lines, or corrected snippet). */
  patch?: string;
  suggestedPath?: string;
  caveats: string[];
}

interface ContractIssue {
  id: string;
  kind: IssueKind;
  group: IssueGroup;
  severity: ContractSeverity;
  /** 0-100 impact score. */
  score: number;
  method: string;
  path: string;
  title: string;
  description: string;
  recommendation: string;
  /** Number of client calls affected. */
  callCount: number;
  evidence: ContractEvidence[];
  comparison?: FieldComparison;
  suggestion: ContractSuggestion;
}

interface ApiEndpointSummary {
  id: string;
  method: EndpointMethod;
  path: string;
  framework: Framework;
  filePath: string;
  line: number;
  symbol?: string;
  handlerResolved: boolean;
  callers: number;
  bodyFields: string[];
  queryFields: string[];
  responseFields: string[];
  /** False when the router this route lives on was never found mounted. */
  mountConfirmed: boolean;
  issueCount: number;
}

interface ContractHotspot {
  filePath: string;
  issueCount: number;
  role: "frontend" | "backend" | "both";
  worstSeverity: ContractSeverity;
}

interface ApiContractReport {
  success: boolean;
  tool: "analyze_api_contracts";
  projectPath: string;
  filePath?: string;
  includeTests: boolean;
  includeUnused: boolean;
  pathPrefix?: string;
  filesScanned: number;
  totalLines: number;
  frameworks: string[];
  endpointCount: number;
  callCount: number;
  matchedCalls: number;
  externalCalls: number;
  unresolvedCalls: number;
  unverifiableCalls: number;
  unusedEndpoints: number;
  /** Share of backend endpoints with at least one client caller. */
  coveragePercentage: number;
  totalIssues: number;
  /** Issue count for the whole project, before any filePath filter. */
  projectIssueCount: number;
  mismatchIssues: number;
  unusedIssues: number;
  routeIssues: number;
  filesAffected: number;
  summary: Record<ContractSeverity, number>;
  issues: ContractIssue[];
  endpoints: ApiEndpointSummary[];
  hotspots: ContractHotspot[];
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
  imports: Map<string, ImportRef>;
  importSpecs: Set<string>;
  topLevel: Map<string, ts.Node>;
  exportsDefault?: string;
  exportedNames: Map<string, string>;
  reexports: Map<string, { specifier: string; name: string }>;
  starReexports: string[];
  /** Identifiers that hold a router/app (declared via express(), Router(), ...). */
  backendNames: Set<string>;
}

interface Decl {
  file: ParsedFile;
  node: ts.Node;
  name: string;
}

interface Ctx {
  root: string;
  files: ParsedFile[];
  byAbs: Map<string, ParsedFile>;
  moduleCache: Map<string, ParsedFile | null>;
}

type UrlPart = { text: string } | { dynamic: string; env?: boolean };

interface ComposedUrl {
  /** Path with `{{name}}` markers where the client inserts a value. */
  template: string;
  query: string[];
  queryOpaque: boolean;
  external: boolean;
  absolute: boolean;
  unresolved: boolean;
}

type Seg =
  | { k: "lit"; v: string }
  | { k: "param"; v: string; opt: boolean }
  | { k: "mixed"; v: string; re: RegExp }
  | { k: "splat" };

interface FieldRead {
  required: boolean;
  line: number;
}

interface RootReads {
  fields: Map<string, FieldRead>;
  opaque: boolean;
  touched: boolean;
}

interface ResponseFacts {
  /** Top-level key -> nested keys (null when the nested shape is unknown). */
  fields: Map<string, Set<string> | null>;
  fieldLines: Map<string, number>;
  objectCount: number;
  unknownCount: number;
  open: boolean;
  statuses: Set<number>;
  firstLine?: number;
}

interface HandlerFacts {
  resolved: boolean;
  fn?: ts.Node;
  file?: ParsedFile;
  body: RootReads;
  query: RootReads;
  response: ResponseFacts;
}

interface RawEndpoint {
  method: EndpointMethod;
  localPath: string;
  routerId: string;
  absolute: boolean;
  framework: Framework;
  file: ParsedFile;
  regNode: ts.Node;
  handler?: { fn: FnNode; file: ParsedFile };
  nestMethod?: { node: ts.MethodDeclaration; file: ParsedFile };
  order: number;
  unresolvedBase: boolean;
}

interface FinalEndpoint {
  id: string;
  method: EndpointMethod;
  path: string;
  segs: Seg[];
  raw: RawEndpoint;
  facts: HandlerFacts;
  mountConfirmed: boolean;
  callers: number;
  issueCount: number;
}

interface ApiCall {
  id: string;
  method: CallMethod;
  path: string;
  segs: Seg[];
  client: ClientKind;
  file: ParsedFile;
  node: ts.Node;
  line: number;
  endLine: number;
  symbol?: string;
  hasBody: boolean;
  bodyKeys: string[] | null;
  bodyLine?: number;
  queryKeys: string[];
  queryOpaque: boolean;
  responsePaths: Map<string, number>;
  rawUrl: string;
}

interface MountEdge {
  parent: string;
  prefix: string;
  child: string;
  unresolvedBase: boolean;
}

interface State {
  ctx: Ctx;
  endpoints: RawEndpoint[];
  calls: ApiCall[];
  edges: MountEdge[];
  parents: Map<string, MountEdge[]>;
  roots: Set<string>;
  ownPrefix: Map<string, string>;
  opaquePrefixes: Set<string>;
  nestGlobalPrefix: string;
  rtkBase: string;
  pathPrefix: string;
  externalCalls: number;
  unresolvedCalls: number;
  unresolvedSamples: string[];
  skippedRoutes: number;
  order: number;
  warn: (message: string) => void;
}

interface IssueDraft {
  kind: IssueKind;
  key: string;
  method: string;
  path: string;
  title: string;
  description: string;
  evidence: ContractEvidence[];
  callCount: number;
  comparison?: FieldComparison;
  suggestion: ContractSuggestion;
  endpointId?: string;
  scoreBoost?: number;
  severityOverride?: ContractSeverity;
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

const RESOLVE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

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
const MAX_ISSUES = 300;
const MAX_ENDPOINTS_LISTED = 500;
const MAX_EVIDENCE_PER_SIDE = 5;
const MAX_SNIPPET_LINES = 40;
const MAX_HOTSPOTS = 15;
const MAX_WARNINGS = 25;

const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const ROUTE_VERBS = new Set([...HTTP_VERBS, "all"]);
const HTTP_METHODS = new Set<string>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

const SERVER_NAME =
  /^(app|router|routes?|server|fastify|[a-z]\w*Router|[a-z]\w*Routes?|[a-z]\w*App)$/;
const CLIENT_NAME =
  /^(api|apiClient|apiService|http|httpClient|client|request|requester|fetcher|axiosInstance|instance|backend)$/i;
const BACKEND_FACTORY =
  /^(?:express(?:\.Router)?|(?:\w+\.)?Router|fastify|Fastify|Hono|createRouter|polka|createApp|Koa)$/;
const ROOT_FACTORY = /^(?:express|fastify|Fastify|Hono|polka|createApp|Koa)$/;
const SERVER_IMPORTS =
  /^(express|fastify|koa|@koa\/router|koa-router|hono|restify|polka|@nestjs\/.+|@fastify\/.+|h3)$/;

const BASE_NAME =
  /(base|url|host|origin|api|server|endpoint|domain|root|prefix|gateway|backend)/i;
const PARAM_NAME = /(id|slug|key|uuid|name|code)$/i;

const OBJECT_MEMBERS = new Set([
  "hasOwnProperty",
  "toString",
  "valueOf",
  "constructor",
  "isPrototypeOf",
]);

/** Members of arrays and objects that are not response fields. */
const PAYLOAD_MEMBERS = new Set([
  ...OBJECT_MEMBERS,
  "length",
  "map",
  "filter",
  "forEach",
  "find",
  "findIndex",
  "some",
  "every",
  "reduce",
  "slice",
  "splice",
  "concat",
  "join",
  "includes",
  "indexOf",
  "push",
  "pop",
  "shift",
  "sort",
  "flat",
  "flatMap",
  "at",
  "keys",
  "values",
  "entries",
  "then",
  "catch",
  "finally",
]);

const STATIC_ASSET =
  /\.(json|png|jpe?g|gif|svg|webp|ico|css|js|mjs|map|txt|xml|csv|md|pdf|woff2?|ttf|mp4|mp3|wasm)$/i;

const QUIET_ENDPOINT =
  /(^|\/)(health|healthz|ready|readyz|live|livez|ping|status|metrics|webhooks?|callback|docs|swagger|openapi|favicon\.ico|robots\.txt)(\/|$)/i;

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
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return ts.ScriptKind.JS;
  }
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

/** Removes parentheses, `as`, `!`, `<T>` and `satisfies` wrappers. */
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

function isWrapperParent(parent: ts.Node, child: ts.Node): boolean {
  return (
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isAwaitExpression(parent)) &&
    parent.expression === child
  );
}

/** Moves up through wrappers (including `await`). */
function climb(node: ts.Node): ts.Node {
  let current = node;
  while (current.parent && isWrapperParent(current.parent, current)) {
    current = current.parent;
  }
  return current;
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

function propertyNameText(
  name: ts.PropertyName | ts.BindingName | undefined,
): string | undefined {
  if (!name) return undefined;
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isPrivateIdentifier(name)
  ) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return undefined;
}

function propOf(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === name) {
      return property.initializer;
    }
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) {
      return property.name;
    }
  }
  return undefined;
}

function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) {
    return false;
  }
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isPropertySignature(parent) && parent.name === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
  if (ts.isJsxAttribute(parent) && parent.name === node) return false;
  return true;
}

function symbolAt(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isClassDeclaration(current)) &&
      current.name
    ) {
      const name = current.name.getText();
      if (
        ts.isMethodDeclaration(current) &&
        ts.isClassLike(current.parent) &&
        current.parent.name
      ) {
        return `${current.parent.name.text}.${name}`;
      }
      return name;
    }

    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      current.initializer &&
      isFnNode(unwrapExpr(current.initializer))
    ) {
      return current.name.text;
    }

    current = current.parent;
  }

  return undefined;
}

function isNamed(expression: ts.Expression | undefined, name: string | undefined): boolean {
  if (!expression || !name) return false;
  const inner = unwrapExpr(expression);
  return ts.isIdentifier(inner) && inner.text === name;
}

function joinPaths(...parts: string[]): string {
  const joined = parts
    .filter((part) => part && part !== "/")
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return `/${joined}`;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return previous[b.length];
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

function discoverSourceFiles(root: string): { files: string[]; truncated: boolean } {
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
/*  File indexing, imports and declaration lookup                             */
/* -------------------------------------------------------------------------- */

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

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)
    : false;
}

function stripAwait(expression: ts.Expression): ts.Expression {
  let current = unwrapExpr(expression);
  while (ts.isAwaitExpression(current)) current = unwrapExpr(current.expression);
  return current;
}

function scopePosOfDeclaration(node: ts.Node): number {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isBlock(current) ||
      ts.isSourceFile(current) ||
      ts.isModuleBlock(current) ||
      ts.isCaseClause(current) ||
      ts.isDefaultClause(current)
    ) {
      return current.pos;
    }
    current = current.parent;
  }
  return 0;
}

/** Position of the scope that declares `name`, as seen from `node`. */
function declScopePos(node: ts.Node, name: string): number {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (
      ts.isFunctionLike(current) &&
      current.parameters.some(
        (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name,
      )
    ) {
      return current.pos;
    }

    if (
      ts.isBlock(current) ||
      ts.isSourceFile(current) ||
      ts.isModuleBlock(current)
    ) {
      for (const statement of current.statements) {
        if (
          ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some(
            (declaration) =>
              ts.isIdentifier(declaration.name) && declaration.name.text === name,
          )
        ) {
          return current.pos;
        }
      }
    }

    current = current.parent;
  }

  return 0;
}

function routerId(file: ParsedFile, name: string, scopePos: number): string {
  return `${file.index}:${name}:${scopePos}`;
}

function indexFile(file: ParsedFile, ctx: Ctx, st: { roots: Set<string> }): void {
  const sf = file.sf;

  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      file.importSpecs.add(specifier);
      const clause = statement.importClause;
      if (!clause) continue;

      if (clause.name) {
        file.imports.set(clause.name.text, { specifier, imported: "default" });
      }

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

    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteralLike(statement.moduleReference.expression)
    ) {
      const specifier = statement.moduleReference.expression.text;
      file.importSpecs.add(specifier);
      file.imports.set(statement.name.text, { specifier, imported: "default" });
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);

      for (const declaration of statement.declarationList.declarations) {
        const required = parseRequire(declaration.initializer);

        if (required) file.importSpecs.add(required.specifier);

        if (ts.isIdentifier(declaration.name)) {
          if (required) {
            file.imports.set(declaration.name.text, {
              specifier: required.specifier,
              imported: required.member ?? "default",
            });
          } else {
            file.topLevel.set(declaration.name.text, declaration);
          }
          if (exported) file.exportedNames.set(declaration.name.text, declaration.name.text);
        } else if (ts.isObjectBindingPattern(declaration.name) && required) {
          for (const element of declaration.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            file.imports.set(element.name.text, {
              specifier: required.specifier,
              imported: (element.propertyName
                ? propertyNameText(element.propertyName)
                : element.name.text) ?? element.name.text,
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

    if (ts.isExportDeclaration(statement)) {
      const specifier =
        statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : undefined;

      if (specifier) file.importSpecs.add(specifier);

      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const exported = element.name.text;
          const local = (element.propertyName ?? element.name).text;

          if (specifier) {
            file.reexports.set(exported, { specifier, name: local });
          } else if (exported === "default") {
            file.exportsDefault = local;
          } else {
            file.exportedNames.set(exported, local);
          }
        }
      } else if (specifier && !statement.exportClause) {
        file.starReexports.push(specifier);
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
        } else {
          file.topLevel.set("default", right);
          file.exportsDefault = "default";

          if (ts.isObjectLiteralExpression(right)) {
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
        }
      } else {
        const match = /^(?:module\.)?exports\.(\w+)$/.exec(left);
        if (match) {
          if (ts.isIdentifier(right)) {
            file.exportedNames.set(match[1], right.text);
          } else {
            file.topLevel.set(`exports.${match[1]}`, right);
            file.exportedNames.set(match[1], `exports.${match[1]}`);
          }
        }
      }
    }
  }

  // Router and app variables, anywhere in the file.
  walk(sf, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = stripAwait(node.initializer);
      const factory = ts.isCallExpression(init)
        ? init.expression.getText()
        : ts.isNewExpression(init)
          ? init.expression.getText()
          : undefined;

      if (factory && BACKEND_FACTORY.test(factory)) {
        file.backendNames.add(node.name.text);

        if (ROOT_FACTORY.test(factory)) {
          st.roots.add(routerId(file, node.name.text, scopePosOfDeclaration(node)));
        }
      }
    }

    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.type) {
      if (
        /\b(Express|Application|Router|IRouter|FastifyInstance|FastifyPluginAsync|Hono)\b/.test(
          node.type.getText(),
        )
      ) {
        file.backendNames.add(node.name.text);
      }
    }
  });

  ctx.byAbs.set(file.abs, file);
}

function resolveModule(
  from: ParsedFile,
  specifier: string,
  ctx: Ctx,
): ParsedFile | undefined {
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

function lookupExport(
  file: ParsedFile,
  exported: string,
  ctx: Ctx,
  depth = 0,
): Decl | undefined {
  if (depth > 6) return undefined;

  if (exported === "*") return { file, node: file.sf, name: "*" };

  if (exported === "default") {
    const local = file.exportsDefault;
    if (!local) return undefined;
    const node = file.topLevel.get(local);
    if (node) return { file, node, name: local };
    if (file.imports.has(local)) return lookupDecl(file, local, ctx, depth + 1);
    return undefined;
  }

  const local = file.exportedNames.get(exported);
  if (local) {
    const node = file.topLevel.get(local);
    if (node) return { file, node, name: local };
    if (file.imports.has(local)) return lookupDecl(file, local, ctx, depth + 1);
  }

  const reexport = file.reexports.get(exported);
  if (reexport) {
    const target = resolveModule(file, reexport.specifier, ctx);
    if (target) return lookupExport(target, reexport.name, ctx, depth + 1);
  }

  for (const specifier of file.starReexports) {
    const target = resolveModule(file, specifier, ctx);
    const hit = target ? lookupExport(target, exported, ctx, depth + 1) : undefined;
    if (hit) return hit;
  }

  return undefined;
}

function lookupDecl(
  file: ParsedFile,
  name: string,
  ctx: Ctx,
  depth = 0,
): Decl | undefined {
  if (depth > 6) return undefined;

  const local = file.topLevel.get(name);
  if (local) return { file, node: local, name };

  const reference = file.imports.get(name);
  if (!reference) return undefined;

  const target = resolveModule(file, reference.specifier, ctx);
  if (!target) return undefined;

  return lookupExport(target, reference.imported, ctx, depth + 1);
}

function functionFromExpression(expression: ts.Expression): FnNode | undefined {
  const inner = unwrapExpr(expression);
  if (isFnNode(inner)) return inner;

  // asyncHandler(async (req, res) => {}), fp(plugin), catchAsync(fn) ...
  if (ts.isCallExpression(inner)) {
    for (const argument of inner.arguments) {
      const candidate = unwrapExpr(argument);
      if (isFnNode(candidate)) return candidate;
    }
  }

  return undefined;
}

function functionFromNode(node: ts.Node): FnNode | undefined {
  if (isFnNode(node)) return node;
  if (ts.isVariableDeclaration(node) && node.initializer) {
    return functionFromExpression(node.initializer);
  }
  if (ts.isPropertyAssignment(node)) return functionFromExpression(node.initializer);
  if (ts.isPropertyDeclaration(node) && node.initializer) {
    return functionFromExpression(node.initializer);
  }
  if (ts.isCallExpression(node)) return functionFromExpression(node);
  return undefined;
}

function classMethod(
  declaration: ts.ClassLikeDeclaration,
  name: string,
): FnNode | undefined {
  for (const member of declaration.members) {
    if (propertyNameText(member.name) !== name) continue;
    if (ts.isMethodDeclaration(member)) return member;
    if (ts.isPropertyDeclaration(member) && member.initializer) {
      return functionFromExpression(member.initializer);
    }
  }
  return undefined;
}

function objectMember(
  declaration: Decl,
  member: string,
  ctx: Ctx,
): { fn?: FnNode; file: ParsedFile; node?: ts.Node } | undefined {
  const node = declaration.node;

  if (ts.isClassDeclaration(node)) {
    const fn = classMethod(node, member);
    return fn ? { fn, file: declaration.file, node: fn } : undefined;
  }

  let initializer: ts.Expression | undefined;

  if (ts.isVariableDeclaration(node) && node.initializer) {
    initializer = unwrapExpr(node.initializer);
  } else if (ts.isObjectLiteralExpression(node)) {
    initializer = node;
  }

  if (!initializer) return undefined;

  if (ts.isObjectLiteralExpression(initializer)) {
    for (const property of initializer.properties) {
      if (propertyNameText(property.name) !== member) continue;

      if (ts.isMethodDeclaration(property)) {
        return { fn: property, file: declaration.file, node: property };
      }

      if (ts.isPropertyAssignment(property)) {
        const fn = functionFromExpression(property.initializer);
        if (fn) return { fn, file: declaration.file, node: property };

        const value = unwrapExpr(property.initializer);
        if (ts.isIdentifier(value)) {
          const hit = lookupDecl(declaration.file, value.text, ctx);
          const resolved = hit ? functionFromNode(hit.node) : undefined;
          if (hit && resolved) return { fn: resolved, file: hit.file, node: resolved };
        }
        return { file: declaration.file, node: property.initializer };
      }

      if (ts.isShorthandPropertyAssignment(property)) {
        const hit = lookupDecl(declaration.file, property.name.text, ctx);
        const resolved = hit ? functionFromNode(hit.node) : undefined;
        if (hit && resolved) return { fn: resolved, file: hit.file, node: resolved };
      }
    }
    return undefined;
  }

  // const controller = new UserController()
  if (ts.isNewExpression(initializer) && ts.isIdentifier(initializer.expression)) {
    const hit = lookupDecl(declaration.file, initializer.expression.text, ctx);
    if (hit && ts.isClassDeclaration(hit.node)) {
      const fn = classMethod(hit.node, member);
      return fn ? { fn, file: hit.file, node: fn } : undefined;
    }
  }

  return undefined;
}

function resolveMemberFunction(
  objectExpression: ts.Expression,
  member: string,
  file: ParsedFile,
  ctx: Ctx,
): { fn: FnNode; file: ParsedFile } | undefined {
  const object = unwrapExpr(objectExpression);
  if (!ts.isIdentifier(object)) return undefined;

  const declaration = lookupDecl(file, object.text, ctx);

  if (declaration) {
    // import * as controller from "./controller"
    if (ts.isSourceFile(declaration.node)) {
      const hit = lookupExport(declaration.file, member, ctx);
      const fn = hit ? functionFromNode(hit.node) : undefined;
      if (hit && fn) return { fn, file: hit.file };
      return undefined;
    }

    const found = objectMember(declaration, member, ctx);
    if (found?.fn) return { fn: found.fn, file: found.file };
  }

  // const controller = require("./controller") -> module.exports = { create }
  const reference = file.imports.get(object.text);
  if (reference) {
    const target = resolveModule(file, reference.specifier, ctx);
    if (target) {
      const hit = lookupExport(target, member, ctx);
      const fn = hit ? functionFromNode(hit.node) : undefined;
      if (hit && fn) return { fn, file: hit.file };
    }
  }

  return undefined;
}

function resolveCalleeFunction(
  callee: ts.Expression,
  file: ParsedFile,
  ctx: Ctx,
): { fn: FnNode; file: ParsedFile } | undefined {
  const expression = unwrapExpr(callee);

  if (ts.isIdentifier(expression)) {
    const declaration = lookupDecl(file, expression.text, ctx);
    const fn = declaration ? functionFromNode(declaration.node) : undefined;
    return declaration && fn ? { fn, file: declaration.file } : undefined;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return resolveMemberFunction(expression.expression, expression.name.text, file, ctx);
  }

  // require("./routes")(app)
  if (ts.isCallExpression(expression)) {
    const required = parseRequire(expression);
    if (required) {
      const target = resolveModule(file, required.specifier, ctx);
      const hit = target
        ? lookupExport(target, required.member ?? "default", ctx)
        : undefined;
      const fn = hit ? functionFromNode(hit.node) : undefined;
      if (hit && fn) return { fn, file: hit.file };
    }
  }

  return undefined;
}

function resolveHandler(
  argument: ts.Expression,
  file: ParsedFile,
  ctx: Ctx,
  depth = 0,
): { fn: FnNode; file: ParsedFile } | undefined {
  if (depth > 3) return undefined;

  const expression = unwrapExpr(argument);
  const direct = functionFromExpression(expression);
  if (direct) return { fn: direct, file };

  if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
    return resolveCalleeFunction(expression, file, ctx);
  }

  if (ts.isCallExpression(expression)) {
    const callee = unwrapExpr(expression.expression);

    // controller.create.bind(controller)
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "bind") {
      return resolveHandler(callee.expression, file, ctx, depth + 1);
    }

    // wrap(controller.create), asyncHandler(create)
    for (const inner of expression.arguments) {
      const hit = resolveHandler(inner, file, ctx, depth + 1);
      if (hit) return hit;
    }
  }

  return undefined;
}

function returnedExpression(fn: FnNode): ts.Expression | undefined {
  if (!fn.body) return undefined;
  if (!ts.isBlock(fn.body)) return fn.body;

  for (const statement of fn.body.statements) {
    if (ts.isReturnStatement(statement) && statement.expression) return statement.expression;
  }

  return undefined;
}

function findLocalVariable(from: ts.Node, name: string): ts.VariableDeclaration | undefined {
  let current: ts.Node | undefined = from.parent;

  while (current) {
    if (
      ts.isBlock(current) ||
      ts.isSourceFile(current) ||
      ts.isModuleBlock(current) ||
      ts.isCaseClause(current) ||
      ts.isDefaultClause(current)
    ) {
      for (const statement of current.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
            return declaration;
          }
        }
      }
    }
    current = current.parent;
  }

  return undefined;
}

function resolveObjectLiteral(
  expression: ts.Expression,
  file: ParsedFile,
  ctx: Ctx,
): ts.ObjectLiteralExpression | undefined {
  const inner = stripAwait(expression);
  if (ts.isObjectLiteralExpression(inner)) return inner;

  if (ts.isIdentifier(inner)) {
    const local = findLocalVariable(inner, inner.text);
    if (local?.initializer) {
      const value = unwrapExpr(local.initializer);
      if (ts.isObjectLiteralExpression(value)) return value;
    }

    const declaration = lookupDecl(file, inner.text, ctx);
    if (
      declaration &&
      ts.isVariableDeclaration(declaration.node) &&
      declaration.node.initializer
    ) {
      const value = unwrapExpr(declaration.node.initializer);
      if (ts.isObjectLiteralExpression(value)) return value;
    }
  }

  return undefined;
}

/* -------------------------------------------------------------------------- */
/*  URL evaluation                                                            */
/* -------------------------------------------------------------------------- */

function isEnvAccess(expression: ts.Expression): boolean {
  return /^(process\.env|import\.meta\.env|window\.__ENV__|window\.env|Deno\.env)\b/.test(
    expression.getText(),
  );
}

function dynamicPart(expression: ts.Expression): UrlPart {
  const inner = unwrapExpr(expression);
  let name = "param";

  if (ts.isIdentifier(inner)) {
    name = inner.text;
  } else if (ts.isPropertyAccessExpression(inner)) {
    name = inner.name.text;
  } else if (ts.isCallExpression(inner) && inner.arguments[0]) {
    return dynamicPart(inner.arguments[0]);
  } else if (
    ts.isElementAccessExpression(inner) &&
    ts.isStringLiteralLike(inner.argumentExpression)
  ) {
    name = inner.argumentExpression.text;
  }

  return {
    dynamic: name.replace(/[^A-Za-z0-9_]/g, "") || "param",
    env: isEnvAccess(inner),
  };
}

/**
 * Finds what an identifier refers to inside the current function or block:
 * a parameter (with its default), a destructured prop such as
 * `({ apiUrl = DEFAULT_API_URL })`, or a local `const`.
 */
function resolveLocalBinding(
  identifier: ts.Identifier,
): { found: boolean; init?: ts.Expression } {
  const name = identifier.text;
  let current: ts.Node | undefined = identifier.parent;

  while (current) {
    if (isFnNode(current)) {
      for (const parameter of current.parameters) {
        if (ts.isIdentifier(parameter.name) && parameter.name.text === name) {
          return { found: true, init: parameter.initializer };
        }

        if (ts.isObjectBindingPattern(parameter.name)) {
          for (const element of parameter.name.elements) {
            if (
              !element.dotDotDotToken &&
              ts.isIdentifier(element.name) &&
              element.name.text === name
            ) {
              return { found: true, init: element.initializer };
            }
          }
        }
      }
    }

    if (ts.isBlock(current) || ts.isSourceFile(current) || ts.isModuleBlock(current)) {
      for (const statement of current.statements) {
        if (!ts.isVariableStatement(statement)) continue;

        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
            return { found: true, init: declaration.initializer };
          }

          if (ts.isObjectBindingPattern(declaration.name)) {
            for (const element of declaration.name.elements) {
              if (
                !element.dotDotDotToken &&
                ts.isIdentifier(element.name) &&
                element.name.text === name
              ) {
                return { found: true, init: element.initializer };
              }
            }
          }
        }
      }
    }

    current = current.parent;
  }

  return { found: false };
}

function evalUrl(
  expression: ts.Expression,
  file: ParsedFile,
  ctx: Ctx,
  depth = 0,
): UrlPart[] | undefined {
  if (depth > 6) return undefined;

  const expr = unwrapExpr(expression);

  if (ts.isStringLiteralLike(expr)) return [{ text: expr.text }];

  if (ts.isTemplateExpression(expr)) {
    const parts: UrlPart[] = [{ text: expr.head.text }];
    for (const span of expr.templateSpans) {
      parts.push(...(evalUrl(span.expression, file, ctx, depth + 1) ?? [dynamicPart(span.expression)]));
      parts.push({ text: span.literal.text });
    }
    return parts;
  }

  if (ts.isBinaryExpression(expr)) {
    const operator = expr.operatorToken.kind;

    if (operator === ts.SyntaxKind.PlusToken) {
      return [
        ...(evalUrl(expr.left, file, ctx, depth + 1) ?? [dynamicPart(expr.left)]),
        ...(evalUrl(expr.right, file, ctx, depth + 1) ?? [dynamicPart(expr.right)]),
      ];
    }

    if (
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken
    ) {
      const left = evalUrl(expr.left, file, ctx, depth + 1);
      if (left && left.every((part) => "text" in part)) return left;

      // import.meta.env.VITE_API || "http://localhost:4000"
      const right = evalUrl(expr.right, file, ctx, depth + 1);
      if (right && right.every((part) => "text" in part)) return right;

      return left ?? right;
    }
  }

  if (ts.isConditionalExpression(expr)) return [dynamicPart(expr)];

  if (ts.isIdentifier(expr)) {
    const local = resolveLocalBinding(expr);

    if (local.found) {
      if (local.init) {
        const resolved = evalUrl(local.init, file, ctx, depth + 1);
        if (resolved) return resolved;
      }
      return [{ dynamic: expr.text.replace(/[^A-Za-z0-9_]/g, "") || "param" }];
    }

    const declaration = lookupDecl(file, expr.text, ctx);

    if (
      declaration &&
      ts.isVariableDeclaration(declaration.node) &&
      declaration.node.initializer
    ) {
      const resolved = evalUrl(declaration.node.initializer, declaration.file, ctx, depth + 1);
      if (resolved) return resolved;
    }

    return [{ dynamic: expr.text.replace(/[^A-Za-z0-9_]/g, "") || "param" }];
  }

  if (ts.isPropertyAccessExpression(expr)) {
    if (isEnvAccess(expr)) return [{ dynamic: expr.name.text, env: true }];

    const owner = unwrapExpr(expr.expression);

    if (ts.isIdentifier(owner)) {
      const declaration = lookupDecl(file, owner.text, ctx);

      if (declaration) {
        const member = ts.isSourceFile(declaration.node)
          ? (() => {
              const hit = lookupExport(declaration.file, expr.name.text, ctx);
              return hit && ts.isVariableDeclaration(hit.node) && hit.node.initializer
                ? { file: hit.file, node: hit.node.initializer }
                : undefined;
            })()
          : (() => {
              const object = resolveObjectLiteral(owner, file, ctx);
              const value = object ? propOf(object, expr.name.text) : undefined;
              return value ? { file: declaration.file, node: value } : undefined;
            })();

        if (member) {
          const resolved = evalUrl(member.node as ts.Expression, member.file, ctx, depth + 1);
          if (resolved) return resolved;
        }
      }
    }

    return [dynamicPart(expr)];
  }

  if (ts.isCallExpression(expr)) {
    const callee = unwrapExpr(expr.expression);
    const calleeText = callee.getText();

    if (/^(encodeURIComponent|encodeURI|String|Number|parseInt)$/.test(calleeText) && expr.arguments[0]) {
      return [dynamicPart(expr.arguments[0])];
    }

    if (
      ts.isPropertyAccessExpression(callee) &&
      /^(toString|toLowerCase|toUpperCase|trim)$/.test(callee.name.text)
    ) {
      return [dynamicPart(callee.expression)];
    }

    const target = resolveCalleeFunction(callee, file, ctx);
    const returned = target ? returnedExpression(target.fn) : undefined;

    if (target && returned) {
      const resolved = evalUrl(returned, target.file, ctx, depth + 1);
      if (resolved) return resolved;
    }

    return [dynamicPart(expr)];
  }

  return undefined;
}

function composeUrl(inputParts: UrlPart[]): ComposedUrl {
  let list = [...inputParts];
  let absolute = false;

  // A leading variable is almost always a base URL, not a path value.
  const first = list[0];
  if (first && "dynamic" in first) {
    const next = list[1];
    const nextText = next && "text" in next ? next.text : undefined;

    if (
      first.env ||
      BASE_NAME.test(first.dynamic) ||
      (nextText?.startsWith("/") && !PARAM_NAME.test(first.dynamic))
    ) {
      list = list.slice(1);
    }
  }

  let raw = list
    .map((part) => ("text" in part ? part.text : `{{${part.dynamic}}}`))
    .join("");

  let external = false;

  const origin = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)(.*)$/is.exec(raw);

  if (origin) {
    absolute = true;
    const host = origin[1].replace(/^.*@/, "").replace(/:\d*$/, "");

    if (host.includes("{{") || host === "") {
      raw = origin[2];
    } else if (["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(host.toLowerCase())) {
      raw = origin[2];
    } else {
      external = true;
    }
  } else if (/^[a-z][a-z0-9+.-]*:(?!\/\/)/i.test(raw) && !raw.startsWith("{{")) {
    external = true;
  }

  const split = raw.search(/[?#]/);
  const pathPart = split < 0 ? raw : raw.slice(0, split);
  const queryPart =
    split >= 0 && raw[split] === "?" ? raw.slice(split + 1).split("#")[0] : "";

  const query: string[] = [];
  let queryOpaque = false;

  if (queryPart) {
    for (const piece of queryPart.split("&")) {
      const key = piece.split("=")[0];
      if (!key) continue;
      if (key.includes("{{")) {
        queryOpaque = true;
        continue;
      }
      try {
        query.push(decodeURIComponent(key).replace(/\[\]$/, ""));
      } catch {
        query.push(key.replace(/\[\]$/, ""));
      }
    }
  }

  let template = pathPart.replace(/^\.\//, "");
  if (!template.startsWith("/")) template = `/${template}`;
  template = template.replace(/\/{2,}/g, "/");
  if (template.length > 1) template = template.replace(/\/+$/, "");

  const segments = template.split("/").filter(Boolean);
  const unresolved =
    list.length === 0 ||
    (segments.length > 0 && segments.every((segment) => /^\{\{[^}]*\}\}$/.test(segment)));

  return { template, query, queryOpaque, external, absolute, unresolved };
}

function displayPath(template: string): string {
  return template.replace(/\{\{([^}]*)\}\}/g, ":$1");
}

/** Evaluates the path argument of a route registration (arrays expand to many). */
function evalRoutePaths(
  expression: ts.Expression,
  file: ParsedFile,
  ctx: Ctx,
): Array<{ path: string; unresolvedBase: boolean }> | undefined {
  const inner = unwrapExpr(expression);

  if (ts.isArrayLiteralExpression(inner)) {
    const out: Array<{ path: string; unresolvedBase: boolean }> = [];
    for (const element of inner.elements) {
      const resolved = evalRoutePaths(element, file, ctx);
      if (resolved) out.push(...resolved);
    }
    return out.length ? out : undefined;
  }

  const parts = evalUrl(inner, file, ctx);
  if (!parts) return undefined;

  const unresolvedBase = parts[0] !== undefined && "dynamic" in parts[0];
  const composed = composeUrl(parts);

  if (composed.external || composed.unresolved) return undefined;

  return [{ path: displayPath(composed.template), unresolvedBase }];
}

/* -------------------------------------------------------------------------- */
/*  Path segments and matching                                                */
/* -------------------------------------------------------------------------- */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseRouteSegments(routePath: string): Seg[] {
  return routePath
    .split("/")
    .filter(Boolean)
    .map((segment): Seg => {
      if (segment === "*" || segment === "**" || segment === "(.*)" || segment.startsWith("*")) {
        return { k: "splat" };
      }

      if (segment.startsWith(":")) {
        const optional = /\?$/.test(segment);
        return {
          k: "param",
          v: segment.slice(1).replace(/\(.*\)$/, "").replace(/[?+*]$/, ""),
          opt: optional,
        };
      }

      return { k: "lit", v: segment.toLowerCase() };
    });
}

function parseCallSegments(template: string): Seg[] {
  return template
    .split("/")
    .filter(Boolean)
    .map((segment): Seg => {
      const whole = /^\{\{([^}]*)\}\}$/.exec(segment);
      if (whole) return { k: "param", v: whole[1], opt: false };

      if (segment.includes("{{")) {
        const pattern = segment
          .split(/\{\{[^}]*\}\}/)
          .map((piece) => escapeRegExp(piece))
          .join("[^/]+");
        return { k: "mixed", v: segment, re: new RegExp(`^${pattern}$`, "i") };
      }

      return { k: "lit", v: segment.toLowerCase() };
    });
}

function segmentScore(callSeg: Seg, routeSeg: Seg): number {
  if (routeSeg.k === "param") return callSeg.k === "lit" ? 1 : 2;

  if (routeSeg.k === "lit") {
    if (callSeg.k === "lit") return callSeg.v === routeSeg.v ? 3 : -1;
    if (callSeg.k === "param") return 1;
    if (callSeg.k === "mixed") return callSeg.re.test(routeSeg.v) ? 2 : -1;
  }

  return -1;
}

/** Returns a match score (higher is better) or -1 when the paths cannot match. */
function matchSegments(call: Seg[], route: Seg[], ci = 0, ri = 0): number {
  if (ri === route.length) return ci === call.length ? 0 : -1;

  const routeSeg = route[ri];

  if (routeSeg.k === "splat") return 0;

  if (ci === call.length) {
    return routeSeg.k === "param" && routeSeg.opt
      ? matchSegments(call, route, ci, ri + 1)
      : -1;
  }

  let best = -1;
  const score = segmentScore(call[ci], routeSeg);

  if (score >= 0) {
    const rest = matchSegments(call, route, ci + 1, ri + 1);
    if (rest >= 0) best = score + rest;
  }

  if (routeSeg.k === "param" && routeSeg.opt) {
    best = Math.max(best, matchSegments(call, route, ci, ri + 1));
  }

  return best;
}

function patternKey(segments: Seg[]): string {
  return `/${segments
    .map((segment) =>
      segment.k === "lit" ? segment.v : segment.k === "splat" ? "*" : ":p",
    )
    .join("/")}`;
}

/* -------------------------------------------------------------------------- */
/*  Handler analysis                                                          */
/* -------------------------------------------------------------------------- */

function isOptionalUse(node: ts.Node): boolean {
  const current = climb(node);
  const parent = current.parent;
  if (!parent) return false;

  if (ts.isBinaryExpression(parent) && parent.left === current) {
    const kind = parent.operatorToken.kind;
    if (
      kind === ts.SyntaxKind.BarBarToken ||
      kind === ts.SyntaxKind.QuestionQuestionToken ||
      kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      return true;
    }
  }

  if (
    ts.isPrefixUnaryExpression(parent) &&
    parent.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return true;
  }

  if (ts.isIfStatement(parent) && parent.expression === current) return true;
  if (ts.isConditionalExpression(parent) && parent.condition === current) return true;

  return false;
}

type GuardKind = "tolerant" | "absent-check";

/** How one reference to a local variable is used in a condition, if at all. */
function guardKindOf(node: ts.Node): GuardKind | undefined {
  const current = climb(node);
  const parent = current.parent;
  if (!parent) return undefined;

  const operatorOf = (binary: ts.BinaryExpression) => binary.operatorToken.kind;
  const isNullish = (expression: ts.Expression) => {
    const inner = unwrapExpr(expression);
    return (
      inner.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(inner) && inner.text === "undefined")
    );
  };

  // value ?? x, value || x, value && x, value?.x
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === current &&
    (operatorOf(parent) === ts.SyntaxKind.BarBarToken ||
      operatorOf(parent) === ts.SyntaxKind.QuestionQuestionToken ||
      operatorOf(parent) === ts.SyntaxKind.AmpersandAmpersandToken)
  ) {
    return "tolerant";
  }

  if (ts.isPropertyAccessExpression(parent) && parent.expression === current && parent.questionDotToken) {
    return "tolerant";
  }

  // if (value) / value ? a : b
  if (
    (ts.isIfStatement(parent) && parent.expression === current) ||
    (ts.isConditionalExpression(parent) && parent.condition === current)
  ) {
    return "tolerant";
  }

  // !value
  if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) {
    return "absent-check";
  }

  // typeof value === "string" / typeof value !== "string"
  if (ts.isTypeOfExpression(parent) && parent.expression === current) {
    const comparison = parent.parent;
    if (comparison && ts.isBinaryExpression(comparison)) {
      const kind = operatorOf(comparison);
      if (kind === ts.SyntaxKind.EqualsEqualsEqualsToken || kind === ts.SyntaxKind.EqualsEqualsToken) {
        return "tolerant";
      }
      if (kind === ts.SyntaxKind.ExclamationEqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsToken) {
        return "absent-check";
      }
    }
    return undefined;
  }

  // value === undefined / value == null / value !== undefined
  if (ts.isBinaryExpression(parent)) {
    const other = parent.left === current ? parent.right : parent.left;
    if (isNullish(other)) {
      const kind = operatorOf(parent);
      if (kind === ts.SyntaxKind.ExclamationEqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsToken) {
        return "tolerant";
      }
      if (kind === ts.SyntaxKind.EqualsEqualsEqualsToken || kind === ts.SyntaxKind.EqualsEqualsToken) {
        return "absent-check";
      }
    }
  }

  return undefined;
}

function returnsOrThrows(statement: ts.Statement): boolean {
  let found = false;
  walkOwn(statement, (node) => {
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) found = true;
  });
  return found;
}

/**
 * Decides whether a destructured or aliased field is really required.
 * It is required when it is used without any guard, or when the handler
 * rejects the request (return/throw) if the field is absent. It is optional
 * when it is never used, or only used behind a guard that tolerates absence.
 */
function localIsRequired(local: string, scope: ts.Node): boolean {
  let referenced = false;
  let tolerant = false;
  let rejecting = false;

  const tolerantIn = (root: ts.Node): boolean => {
    let hit = false;
    walk(root, (node) => {
      if (
        ts.isIdentifier(node) &&
        node.text === local &&
        isReferenceIdentifier(node) &&
        guardKindOf(node) === "tolerant"
      ) {
        hit = true;
      }
    });
    return hit;
  };

  walk(scope, (node) => {
    if (!ts.isIdentifier(node) || node.text !== local || !isReferenceIdentifier(node)) return;

    referenced = true;
    const kind = guardKindOf(node);

    if (kind === "tolerant") {
      tolerant = true;
      return;
    }

    if (kind !== "absent-check") return;

    // Climb to the whole condition this check belongs to.
    let check: ts.Node = climb(node);
    if (check.parent && ts.isTypeOfExpression(check.parent)) check = check.parent;
    if (check.parent && ts.isBinaryExpression(check.parent)) check = check.parent;

    let tolerated = false;

    for (;;) {
      const parent = check.parent;
      if (!parent) break;

      if (ts.isParenthesizedExpression(parent)) {
        check = parent;
      } else if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken
      ) {
        check = parent;
      } else if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        if (parent.right === check && tolerantIn(parent.left)) {
          tolerated = true;
          break;
        }
        check = parent;
      } else {
        break;
      }
    }

    const owner = check.parent;
    if (
      !tolerated &&
      owner &&
      ts.isIfStatement(owner) &&
      owner.expression === check &&
      returnsOrThrows(owner.thenStatement)
    ) {
      rejecting = true;
    }
  });

  if (!referenced) return false;
  return rejecting || !tolerant;
}

function emptyReads(): RootReads {
  return { fields: new Map(), opaque: false, touched: false };
}

/**
 * Finds every place a value is read inside `scope` and reports which fields
 * are read from it. `isRoot` recognises the value (for example `req.body`);
 * variables it is assigned to are followed.
 */
function collectRootReads(
  scope: ts.Node | undefined,
  isRoot: (node: ts.Node) => boolean,
  seedAliases: string[] = [],
): RootReads {
  const out = emptyReads();
  if (!scope) return out;

  const aliases = new Set<string>(seedAliases);
  const handled = new Set<ts.Node>();
  const locals = new Map<string, string>();
  const hardRequired = new Set<string>();

  const add = (name: string, required: boolean, node: ts.Node, local?: string) => {
    const previous = out.fields.get(name);
    out.fields.set(name, {
      required: (previous?.required ?? false) || required,
      line: previous?.line ?? startLineOf(node),
    });

    if (local) locals.set(name, local);
    else if (required) hardRequired.add(name);
  };

  const readPattern = (pattern: ts.ObjectBindingPattern) => {
    for (const element of pattern.elements) {
      if (element.dotDotDotToken) {
        out.opaque = true;
        continue;
      }

      const key = element.propertyName
        ? propertyNameText(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : undefined;

      if (!key) {
        out.opaque = true;
        continue;
      }

      add(
        key,
        !element.initializer,
        element,
        ts.isIdentifier(element.name) ? element.name.text : undefined,
      );
    }
  };

  const use = (node: ts.Node): void => {
    const current = climb(node);
    const parent = current.parent;

    if (!parent) {
      out.opaque = true;
      return;
    }

    if (ts.isPropertyAccessExpression(parent) && parent.expression === current) {
      const name = parent.name.text;
      if (OBJECT_MEMBERS.has(name)) return;

      // const filePath = req.body.filePath
      const read = climb(parent);
      const declaration = read.parent;
      const local =
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer === read &&
        ts.isIdentifier(declaration.name)
          ? declaration.name.text
          : undefined;

      add(name, !parent.questionDotToken && !isOptionalUse(parent), parent, local);
      return;
    }

    if (ts.isElementAccessExpression(parent) && parent.expression === current) {
      const argument = parent.argumentExpression;
      if (ts.isStringLiteralLike(argument)) add(argument.text, !isOptionalUse(parent), parent);
      else out.opaque = true;
      return;
    }

    if (ts.isVariableDeclaration(parent) && parent.initializer === current) {
      if (ts.isIdentifier(parent.name)) aliases.add(parent.name.text);
      else if (ts.isObjectBindingPattern(parent.name)) readPattern(parent.name);
      else out.opaque = true;
      return;
    }

    if (ts.isBinaryExpression(parent)) {
      const operator = parent.operatorToken.kind;

      // req.body || {}
      if (
        (operator === ts.SyntaxKind.BarBarToken ||
          operator === ts.SyntaxKind.QuestionQuestionToken) &&
        parent.left === current
      ) {
        use(parent);
        return;
      }

      // ({ a, b } = req.body)
      if (
        operator === ts.SyntaxKind.EqualsToken &&
        parent.right === current &&
        ts.isObjectLiteralExpression(parent.left)
      ) {
        for (const property of parent.left.properties) {
          if (ts.isShorthandPropertyAssignment(property)) add(property.name.text, true, property);
          else if (ts.isPropertyAssignment(property) && propertyNameText(property.name)) {
            add(propertyNameText(property.name)!, true, property);
          } else out.opaque = true;
        }
        return;
      }

      // "email" in req.body
      if (
        operator === ts.SyntaxKind.InKeyword &&
        parent.right === current &&
        ts.isStringLiteralLike(parent.left)
      ) {
        add(parent.left.text, false, parent);
        return;
      }
    }

    // Passed along as a whole (argument, spread, return ...).
    out.opaque = true;
  };

  for (let round = 0; round < 4; round++) {
    const before = aliases.size;

    walk(scope, (node) => {
      if (handled.has(node)) return;

      const hit =
        isRoot(node) ||
        (ts.isIdentifier(node) && aliases.has(node.text) && isReferenceIdentifier(node));

      if (!hit) return;

      handled.add(node);
      out.touched = true;
      use(node);
    });

    if (aliases.size === before) break;
  }

  // A field read into a local variable is only required if that variable
  // is used without a guard, or the handler rejects requests without it.
  for (const [name, read] of out.fields) {
    const local = locals.get(name);
    if (read.required && local && !hardRequired.has(name)) {
      read.required = localIsRequired(local, scope);
    }
  }

  return out;
}

function mergeReads(into: RootReads, from: RootReads): void {
  into.touched ||= from.touched;
  into.opaque ||= from.opaque;
  for (const [name, read] of from.fields) {
    const previous = into.fields.get(name);
    into.fields.set(name, {
      required: (previous?.required ?? false) || read.required,
      line: previous?.line ?? read.line,
    });
  }
}

type Payload =
  | { kind: "object"; fields: Map<string, Set<string> | null>; open: boolean; line: number }
  | { kind: "array" }
  | { kind: "primitive" }
  | { kind: "unknown" };

function classifyPayload(
  expression: ts.Expression,
  scope: ts.Node | undefined,
  depth = 0,
): Payload {
  const expr = stripAwait(expression);

  if (ts.isObjectLiteralExpression(expr)) {
    const fields = new Map<string, Set<string> | null>();
    let open = false;

    for (const property of expr.properties) {
      if (ts.isSpreadAssignment(property)) {
        open = true;
        continue;
      }

      const name = propertyNameText(property.name);
      if (!name) {
        open = true;
        continue;
      }

      let nested: Set<string> | null = null;

      if (ts.isPropertyAssignment(property)) {
        const value = unwrapExpr(property.initializer);
        if (ts.isObjectLiteralExpression(value)) {
          const keys = new Set<string>();
          let nestedOpen = false;
          for (const inner of value.properties) {
            const key = ts.isSpreadAssignment(inner) ? undefined : propertyNameText(inner.name);
            if (key) keys.add(key);
            else nestedOpen = true;
          }
          nested = nestedOpen ? null : keys;
        }
      }

      fields.set(name, nested);
    }

    return { kind: "object", fields, open, line: startLineOf(expr) };
  }

  if (ts.isArrayLiteralExpression(expr)) return { kind: "array" };

  if (
    ts.isStringLiteralLike(expr) ||
    ts.isNumericLiteral(expr) ||
    ts.isTemplateExpression(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(expr) && expr.text === "undefined")
  ) {
    return { kind: "primitive" };
  }

  if (
    ts.isCallExpression(expr) &&
    expr.expression.getText() === "JSON.stringify" &&
    expr.arguments[0]
  ) {
    return classifyPayload(expr.arguments[0], scope, depth + 1);
  }

  if (ts.isIdentifier(expr) && depth < 2 && scope) {
    const local = findLocalVariable(expr, expr.text);
    if (local?.initializer) return classifyPayload(local.initializer, scope, depth + 1);
  }

  return { kind: "unknown" };
}

function statusFromChain(expression: ts.Expression, out: Set<number>): void {
  let current: ts.Expression = expression;

  for (;;) {
    current = unwrapExpr(current);

    if (ts.isCallExpression(current)) {
      const callee = unwrapExpr(current.expression);

      if (
        ts.isPropertyAccessExpression(callee) &&
        (callee.name.text === "status" || callee.name.text === "code") &&
        current.arguments[0] &&
        ts.isNumericLiteral(current.arguments[0])
      ) {
        out.add(Number(current.arguments[0].text));
      }

      current = ts.isPropertyAccessExpression(callee) ? callee.expression : callee;
    } else if (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
    } else {
      return;
    }
  }
}

function chainRoot(expression: ts.Expression): ts.Expression {
  let current = unwrapExpr(expression);

  for (;;) {
    if (ts.isCallExpression(current)) current = unwrapExpr(current.expression);
    else if (ts.isPropertyAccessExpression(current)) current = unwrapExpr(current.expression);
    else return current;
  }
}

type HandlerStyle = "express" | "next" | "nest";

function collectResponses(fn: FnNode, style: HandlerStyle): ResponseFacts {
  const facts: ResponseFacts = {
    fields: new Map(),
    fieldLines: new Map(),
    objectCount: 0,
    unknownCount: 0,
    open: false,
    statuses: new Set(),
  };

  if (!fn.body) return facts;

  const first = fn.parameters[0];
  const second = fn.parameters[1];
  const firstName = first && ts.isIdentifier(first.name) ? first.name.text : undefined;
  const secondName = second && ts.isIdentifier(second.name) ? second.name.text : undefined;

  const responseNames = new Set<string>();
  if (style === "express") {
    if (secondName) responseNames.add(secondName);
    if (firstName && /^(c|ctx|context)$/.test(firstName)) responseNames.add(firstName);
  }

  const koaContext = firstName && /^(ctx|context)$/.test(firstName) ? firstName : undefined;
  const allowReturns =
    style === "nest" ||
    (style === "express" && (!secondName || /^(reply|rep)$/.test(secondName)));

  const addPayload = (payloadExpression: ts.Expression | undefined) => {
    if (!payloadExpression) return;

    const payload = classifyPayload(payloadExpression, fn.body);
    facts.firstLine ??= startLineOf(payloadExpression);

    if (payload.kind === "unknown") {
      facts.unknownCount++;
      return;
    }

    if (payload.kind !== "object") return;

    facts.objectCount++;
    if (payload.open) facts.open = true;

    for (const [key, nested] of payload.fields) {
      const existing = facts.fields.get(key);

      if (existing === undefined && !facts.fields.has(key)) {
        facts.fields.set(key, nested ? new Set(nested) : null);
        facts.fieldLines.set(key, payload.line);
      } else if (existing && nested) {
        nested.forEach((item) => existing.add(item));
      } else if (existing && !nested) {
        facts.fields.set(key, null);
      }
    }
  };

  walk(fn.body, (node) => {
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpr(node.expression);
      if (!ts.isPropertyAccessExpression(callee)) return;

      const name = callee.name.text;
      const root = chainRoot(callee.expression);
      const rootName = ts.isIdentifier(root) ? root.text : undefined;

      if ((name === "json" || name === "send" || name === "jsonp") && rootName && responseNames.has(rootName)) {
        statusFromChain(callee.expression, facts.statuses);
        addPayload(node.arguments[0]);
        return;
      }

      if (name === "sendStatus" && rootName && responseNames.has(rootName)) {
        const code = node.arguments[0];
        if (code && ts.isNumericLiteral(code)) facts.statuses.add(Number(code.text));
        return;
      }

      // NextResponse.json(data, { status }) / Response.json(data)
      if (
        name === "json" &&
        ts.isIdentifier(callee.expression) &&
        (callee.expression.text === "NextResponse" || callee.expression.text === "Response")
      ) {
        addPayload(node.arguments[0]);
        const init = node.arguments[1];
        if (init && ts.isObjectLiteralExpression(init)) {
          const status = propOf(init, "status");
          if (status && ts.isNumericLiteral(status)) facts.statuses.add(Number(status.text));
        }
      }
      return;
    }

    // new Response(JSON.stringify({ ... }))
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === "Response" || node.expression.text === "NextResponse") &&
      node.arguments?.[0]
    ) {
      const argument = unwrapExpr(node.arguments[0]);
      if (
        ts.isCallExpression(argument) &&
        argument.expression.getText() === "JSON.stringify"
      ) {
        addPayload(argument.arguments[0]);
      }
      return;
    }

    // ctx.body = { ... }
    if (
      koaContext &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      isNamed(node.left.expression, koaContext)
    ) {
      if (node.left.name.text === "body") addPayload(node.right);
      if (node.left.name.text === "status" && ts.isNumericLiteral(node.right)) {
        facts.statuses.add(Number(node.right.text));
      }
    }
  });

  if (allowReturns) {
    walkOwn(fn, (node) => {
      if (ts.isReturnStatement(node) && node.expression) {
        const expression = stripAwait(node.expression);
        // `return reply.send(...)` is already handled above.
        if (
          ts.isCallExpression(expression) &&
          ts.isPropertyAccessExpression(unwrapExpr(expression.expression))
        ) {
          const root = chainRoot(expression);
          if (ts.isIdentifier(root) && responseNames.has(root.text)) return;
        }
        addPayload(node.expression);
      }
    });

    // Concise arrow body: async () => ({ ok: true })
    if (!ts.isBlock(fn.body)) addPayload(fn.body);
  }

  return facts;
}

function dtoFields(
  typeNode: ts.TypeNode | undefined,
  file: ParsedFile,
  ctx: Ctx,
): { reads: RootReads } | undefined {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) {
    return undefined;
  }

  const declaration = lookupDecl(file, typeNode.typeName.text, ctx);
  if (!declaration) return undefined;

  const reads = emptyReads();
  reads.touched = true;

  const node = declaration.node;
  const addMember = (member: ts.ClassElement | ts.TypeElement) => {
    const name = propertyNameText(member.name as ts.PropertyName | undefined);
    if (!name) return;

    const optional =
      !!(member as ts.PropertyDeclaration | ts.PropertySignature).questionToken ||
      (ts.canHaveDecorators(member) &&
        (ts.getDecorators(member) ?? []).some((decorator) =>
          /IsOptional/.test(decorator.expression.getText()),
        ));

    reads.fields.set(name, { required: !optional, line: startLineOf(member) });
  };

  if (ts.isClassDeclaration(node)) {
    if (node.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)) {
      reads.opaque = true;
    }
    for (const member of node.members) {
      if (ts.isPropertyDeclaration(member)) addMember(member);
    }
    return { reads };
  }

  if (ts.isInterfaceDeclaration(node)) {
    if (node.heritageClauses?.length) reads.opaque = true;
    for (const member of node.members) {
      if (ts.isPropertySignature(member)) addMember(member);
    }
    return { reads };
  }

  if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
    for (const member of node.type.members) {
      if (ts.isPropertySignature(member)) addMember(member);
    }
    return { reads };
  }

  return undefined;
}

function emptyFacts(): HandlerFacts {
  return {
    resolved: false,
    body: emptyReads(),
    query: emptyReads(),
    response: {
      fields: new Map(),
      fieldLines: new Map(),
      objectCount: 0,
      unknownCount: 0,
      open: false,
      statuses: new Set(),
    },
  };
}

function analyzeHandler(
  fn: FnNode,
  file: ParsedFile,
  ctx: Ctx,
  style: HandlerStyle,
): HandlerFacts {
  const first = fn.parameters[0];
  const reqName = first && ts.isIdentifier(first.name) ? first.name.text : undefined;

  const bodySeeds: string[] = [];
  const querySeeds: string[] = [];

  // handler({ body, query }, reply)
  if (first && ts.isObjectBindingPattern(first.name)) {
    for (const element of first.name.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const key = element.propertyName ? propertyNameText(element.propertyName) : element.name.text;
      if (key === "body") bodySeeds.push(element.name.text);
      if (key === "query") querySeeds.push(element.name.text);
    }
  }

  const requestLike = (expression: ts.Expression): boolean => {
    if (isNamed(expression, reqName)) return true;
    const inner = unwrapExpr(expression);
    return (
      ts.isPropertyAccessExpression(inner) &&
      (inner.name.text === "request" || inner.name.text === "req") &&
      isNamed(inner.expression, reqName)
    );
  };

  const isBodyRoot = (node: ts.Node): boolean => {
    if (ts.isPropertyAccessExpression(node)) {
      return node.name.text === "body" && requestLike(node.expression);
    }
    if (ts.isCallExpression(node) && node.arguments.length === 0) {
      const callee = unwrapExpr(node.expression);
      return (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "json" &&
        requestLike(callee.expression)
      );
    }
    return false;
  };

  const isQueryRoot = (node: ts.Node): boolean =>
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "query" &&
    requestLike(node.expression);

  const body = collectRootReads(fn.body, isBodyRoot, bodySeeds);
  const query = collectRootReads(fn.body, isQueryRoot, querySeeds);

  // request.nextUrl.searchParams.get("q")
  if (fn.body) {
    walk(fn.body, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = unwrapExpr(node.expression);
      if (!ts.isPropertyAccessExpression(callee)) return;
      if (!["get", "getAll", "has"].includes(callee.name.text)) return;

      const owner = unwrapExpr(callee.expression);
      const isSearchParams =
        (ts.isIdentifier(owner) && owner.text === "searchParams") ||
        (ts.isPropertyAccessExpression(owner) && owner.name.text === "searchParams");

      const key = node.arguments[0];
      if (isSearchParams && key && ts.isStringLiteralLike(key)) {
        query.touched = true;
        if (!query.fields.has(key.text)) {
          query.fields.set(key.text, { required: false, line: startLineOf(node) });
        }
      }
    });
  }

  // (req: Request<Params, ResBody, CreateUserDto>, res)
  if (first?.type && ts.isTypeReferenceNode(first.type) && first.type.typeArguments?.length) {
    const bodyType = first.type.typeArguments[2];
    const typed = dtoFields(bodyType, file, ctx);
    if (typed) mergeReads(body, typed.reads);
  }

  return {
    resolved: true,
    fn,
    file,
    body,
    query,
    response: collectResponses(fn, style),
  };
}

function decoratorName(decorator: ts.Decorator): string | undefined {
  const expression = decorator.expression;
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    return expression.expression.text;
  }
  if (ts.isIdentifier(expression)) return expression.text;
  return undefined;
}

function decoratorsOf(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

function decoratorPath(decorator: ts.Decorator): string {
  const expression = decorator.expression;
  if (!ts.isCallExpression(expression)) return "";

  const argument = expression.arguments[0];
  if (!argument) return "";

  if (ts.isStringLiteralLike(argument)) return argument.text;

  if (ts.isObjectLiteralExpression(argument)) {
    const value = propOf(argument, "path");
    if (value && ts.isStringLiteralLike(value)) return value.text;
  }

  if (ts.isArrayLiteralExpression(argument) && argument.elements[0]) {
    const value = argument.elements[0];
    if (ts.isStringLiteralLike(value)) return value.text;
  }

  return "";
}

function analyzeNestMethod(
  method: ts.MethodDeclaration,
  file: ParsedFile,
  ctx: Ctx,
): HandlerFacts {
  const body = emptyReads();
  const query = emptyReads();

  for (const parameter of method.parameters) {
    for (const decorator of decoratorsOf(parameter)) {
      const name = decoratorName(decorator);
      if (name !== "Body" && name !== "Query") continue;

      const target = name === "Body" ? body : query;
      target.touched = true;

      const call = decorator.expression;
      const key =
        ts.isCallExpression(call) && call.arguments[0] && ts.isStringLiteralLike(call.arguments[0])
          ? call.arguments[0].text
          : undefined;

      if (key) {
        target.fields.set(key, { required: true, line: startLineOf(parameter) });
        continue;
      }

      const typed = dtoFields(parameter.type, file, ctx);
      if (typed) mergeReads(target, typed.reads);
      else target.opaque = true;
    }
  }

  return {
    resolved: true,
    fn: method,
    file,
    body,
    query,
    response: collectResponses(method, "nest"),
  };
}

/* -------------------------------------------------------------------------- */
/*  Backend discovery                                                         */
/* -------------------------------------------------------------------------- */

function frameworkOf(file: ParsedFile): Framework {
  const specs = [...file.importSpecs];
  if (specs.some((spec) => spec.startsWith("@nestjs/"))) return "nest";
  if (specs.some((spec) => spec === "fastify" || spec.startsWith("@fastify/"))) return "fastify";
  if (specs.some((spec) => spec === "koa" || spec === "@koa/router" || spec === "koa-router")) {
    return "koa";
  }
  if (specs.some((spec) => spec === "hono" || spec.startsWith("hono/"))) return "hono";
  if (specs.some((spec) => spec === "next" || spec.startsWith("next/"))) return "next";
  return "express";
}

function isBackendReceiver(expression: ts.Expression, file: ParsedFile): boolean {
  const inner = unwrapExpr(expression);

  if (ts.isIdentifier(inner)) {
    return file.backendNames.has(inner.text) || SERVER_NAME.test(inner.text);
  }

  if (ts.isPropertyAccessExpression(inner)) {
    return file.backendNames.has(inner.name.text) || SERVER_NAME.test(inner.name.text);
  }

  return false;
}

function receiverId(expression: ts.Expression, file: ParsedFile): string {
  const inner = unwrapExpr(expression);

  if (ts.isIdentifier(inner)) {
    return routerId(file, inner.text, declScopePos(inner, inner.text));
  }

  if (ts.isPropertyAccessExpression(inner)) return routerId(file, inner.name.text, 0);

  return routerId(file, "?", 0);
}

function findReturnedIdentifier(fn: FnNode): ts.Identifier | undefined {
  if (!fn.body) return undefined;

  let found: ts.Identifier | undefined;

  if (!ts.isBlock(fn.body)) {
    const expression = unwrapExpr(fn.body);
    return ts.isIdentifier(expression) ? expression : undefined;
  }

  walkOwn(fn, (node) => {
    if (found || !ts.isReturnStatement(node) || !node.expression) return;
    const expression = unwrapExpr(node.expression);
    if (ts.isIdentifier(expression)) found = expression;
  });

  return found;
}

function resolveRouterRef(
  expression: ts.Expression,
  file: ParsedFile,
  ctx: Ctx,
): string | undefined {
  const inner = unwrapExpr(expression);

  if (ts.isIdentifier(inner)) {
    if (!file.imports.has(inner.text)) {
      return routerId(file, inner.text, declScopePos(inner, inner.text));
    }
    const declaration = lookupDecl(file, inner.text, ctx);
    return declaration ? routerId(declaration.file, declaration.name, 0) : undefined;
  }

  if (ts.isCallExpression(inner)) {
    const callee = unwrapExpr(inner.expression);

    // koa: app.use(router.routes())
    if (
      ts.isPropertyAccessExpression(callee) &&
      (callee.name.text === "routes" || callee.name.text === "middleware")
    ) {
      return resolveRouterRef(callee.expression, file, ctx);
    }

    // app.use("/x", require("./routes/x"))
    const required = parseRequire(inner);
    if (required) {
      const target = resolveModule(file, required.specifier, ctx);
      const declaration = target
        ? lookupExport(target, required.member ?? "default", ctx)
        : undefined;
      return declaration ? routerId(declaration.file, declaration.name, 0) : undefined;
    }

    // app.use("/x", createUserRouter())
    const target = resolveCalleeFunction(callee, file, ctx);
    const returned = target ? findReturnedIdentifier(target.fn) : undefined;
    if (target && returned) {
      return routerId(target.file, returned.text, declScopePos(returned, returned.text));
    }
  }

  return undefined;
}

function addEdge(st: State, edge: MountEdge): void {
  st.edges.push(edge);
  const list = st.parents.get(edge.child) ?? [];
  list.push(edge);
  st.parents.set(edge.child, list);
}

function handleServerCall(call: ts.CallExpression, file: ParsedFile, st: State): void {
  const { ctx } = st;
  const callee = unwrapExpr(call.expression);

  /* ---- fn(app) style registrars ------------------------------------- */
  if (ts.isIdentifier(callee) || ts.isCallExpression(callee) || ts.isPropertyAccessExpression(callee)) {
    const receivers = call.arguments
      .map((argument, index) => ({ argument: unwrapExpr(argument), index }))
      .filter(
        ({ argument }) => ts.isIdentifier(argument) && isBackendReceiver(argument, file),
      );

    if (receivers.length > 0 && !(ts.isPropertyAccessExpression(callee) && isBackendReceiver(callee.expression, file))) {
      const target = resolveCalleeFunction(callee, file, ctx);

      if (target) {
        for (const { argument, index } of receivers) {
          const parameter = target.fn.parameters[index];
          if (parameter && ts.isIdentifier(parameter.name)) {
            addEdge(st, {
              parent: receiverId(argument, file),
              prefix: "",
              child: routerId(target.file, parameter.name.text, target.fn.pos),
              unresolvedBase: false,
            });
          }
        }
      }
    }
  }

  if (!ts.isPropertyAccessExpression(callee)) return;

  const name = callee.name.text;
  const receiver = callee.expression;

  /* ---- fastify.route({ method, url, handler }) ----------------------- */
  if (name === "route" && call.arguments[0] && ts.isObjectLiteralExpression(call.arguments[0])) {
    if (!isBackendReceiver(receiver, file)) return;

    const options = call.arguments[0];
    const urlExpression = propOf(options, "url") ?? propOf(options, "path");
    const methodExpression = propOf(options, "method");
    const handlerExpression = propOf(options, "handler");
    if (!urlExpression) return;

    const paths = evalRoutePaths(urlExpression, file, ctx);
    if (!paths) return;

    const methods: EndpointMethod[] = [];
    const collect = (expression: ts.Expression | undefined) => {
      if (!expression) return;
      const inner = unwrapExpr(expression);
      if (ts.isStringLiteralLike(inner) && HTTP_METHODS.has(inner.text.toUpperCase())) {
        methods.push(inner.text.toUpperCase() as HttpMethod);
      } else if (ts.isArrayLiteralExpression(inner)) {
        inner.elements.forEach(collect);
      }
    };
    collect(methodExpression);
    if (methods.length === 0) methods.push("ALL");

    const handler = handlerExpression ? resolveHandler(handlerExpression, file, ctx) : undefined;

    for (const route of paths) {
      for (const method of methods) {
        st.endpoints.push({
          method,
          localPath: route.path,
          routerId: receiverId(receiver, file),
          absolute: false,
          framework: frameworkOf(file),
          file,
          regNode: call,
          handler,
          order: st.order++,
          unresolvedBase: route.unresolvedBase,
        });
      }
    }
    return;
  }

  /* ---- router.get("/x", handler) ------------------------------------- */
  if (ROUTE_VERBS.has(name)) {
    let receiverExpression: ts.Expression = receiver;
    let pathExpression: ts.Expression | undefined = call.arguments[0];
    let handlerArguments = call.arguments.slice(1);
    const methods: EndpointMethod[] = [];

    // router.route("/x").get(h).post(h)
    const chain: string[] = [name];
    let cursor: ts.Expression = unwrapExpr(receiver);
    let routeCall: ts.CallExpression | undefined;

    for (let hops = 0; hops < 8; hops++) {
      if (!ts.isCallExpression(cursor)) break;
      const inner = unwrapExpr(cursor.expression);
      if (!ts.isPropertyAccessExpression(inner)) break;

      if (inner.name.text === "route") {
        routeCall = cursor;
        break;
      }

      if (!ROUTE_VERBS.has(inner.name.text)) break;
      chain.push(inner.name.text);
      cursor = unwrapExpr(inner.expression);
    }

    if (routeCall) {
      const routeCallee = unwrapExpr(routeCall.expression) as ts.PropertyAccessExpression;
      receiverExpression = routeCallee.expression;
      pathExpression = routeCall.arguments[0];
      handlerArguments = call.arguments.slice(0);
    }

    if (!pathExpression) return;
    if (!routeCall && call.arguments.length < 2) return;

    if (!isBackendReceiver(receiverExpression, file)) return;

    const inner = unwrapExpr(pathExpression);

    if (ts.isRegularExpressionLiteral(inner)) {
      st.skippedRoutes++;
      return;
    }

    const paths = evalRoutePaths(inner, file, ctx);
    if (!paths) return;

    const verb = name.toUpperCase();
    methods.push(verb === "ALL" ? "ALL" : (verb as HttpMethod));

    const lastHandler = handlerArguments[handlerArguments.length - 1];
    const handler = lastHandler ? resolveHandler(lastHandler, file, ctx) : undefined;

    for (const route of paths) {
      if (!route.path.startsWith("/") && route.path !== "*") continue;

      for (const method of methods) {
        st.endpoints.push({
          method,
          localPath: route.path,
          routerId: receiverId(receiverExpression, file),
          absolute: false,
          framework: frameworkOf(file),
          file,
          regNode: call,
          handler,
          order: st.order++,
          unresolvedBase: route.unresolvedBase,
        });
      }
    }
    return;
  }

  /* ---- app.use("/prefix", router) ------------------------------------ */
  if (name === "use" && isBackendReceiver(receiver, file)) {
    const parent = receiverId(receiver, file);
    let prefix = "";
    let unresolvedBase = false;
    let rest = [...call.arguments];

    if (rest[0]) {
      const maybePath = evalRoutePaths(rest[0], file, ctx);
      const firstInner = unwrapExpr(rest[0]);
      const looksLikePath =
        ts.isStringLiteralLike(firstInner) ||
        ts.isTemplateExpression(firstInner) ||
        ts.isArrayLiteralExpression(firstInner) ||
        (ts.isBinaryExpression(firstInner) &&
          firstInner.operatorToken.kind === ts.SyntaxKind.PlusToken);

      if (looksLikePath && maybePath?.[0]) {
        prefix = maybePath[0].path;
        unresolvedBase = maybePath[0].unresolvedBase;
        rest = rest.slice(1);
      }
    }

    const candidates: ts.Expression[] = [];
    for (const argument of rest) {
      const inner = unwrapExpr(argument);
      if (ts.isArrayLiteralExpression(inner)) candidates.push(...inner.elements);
      else candidates.push(inner);
    }

    for (const candidate of candidates) {
      const child = resolveRouterRef(candidate, file, ctx);

      if (child) {
        addEdge(st, { parent, prefix, child, unresolvedBase });
        continue;
      }

      // A router-looking import we could not follow: stay quiet about its paths.
      const inner = unwrapExpr(candidate);
      if (prefix && ts.isIdentifier(inner)) {
        const reference = file.imports.get(inner.text);
        if (/rout/i.test(inner.text) || (reference && /rout/i.test(reference.specifier))) {
          st.opaquePrefixes.add(prefix);
        }
      }
    }
    return;
  }

  /* ---- fastify.register(plugin, { prefix }) -------------------------- */
  if (name === "register" && isBackendReceiver(receiver, file) && call.arguments[0]) {
    const plugin = resolveHandler(call.arguments[0], file, ctx);
    const options = call.arguments[1];
    let prefix = "";
    let unresolvedBase = false;

    if (options && ts.isObjectLiteralExpression(options)) {
      const value = propOf(options, "prefix");
      const resolved = value ? evalRoutePaths(value, file, ctx) : undefined;
      if (resolved?.[0]) {
        prefix = resolved[0].path;
        unresolvedBase = resolved[0].unresolvedBase;
      }
    }

    const parameter = plugin?.fn.parameters[0];
    if (plugin && parameter && ts.isIdentifier(parameter.name)) {
      addEdge(st, {
        parent: receiverId(receiver, file),
        prefix,
        child: routerId(plugin.file, parameter.name.text, plugin.fn.pos),
        unresolvedBase,
      });
    }
    return;
  }

  /* ---- router.prefix("/x") (koa-router) ------------------------------ */
  if (name === "prefix" && isBackendReceiver(receiver, file) && call.arguments[0]) {
    const resolved = evalRoutePaths(call.arguments[0], file, ctx);
    if (resolved?.[0]) st.ownPrefix.set(receiverId(receiver, file), resolved[0].path);
    return;
  }

  /* ---- app.setGlobalPrefix("api") (nest) ----------------------------- */
  if (name === "setGlobalPrefix" && call.arguments[0]) {
    const argument = unwrapExpr(call.arguments[0]);
    if (ts.isStringLiteralLike(argument)) st.nestGlobalPrefix = argument.text;
  }
}

function collectRouterOptions(node: ts.VariableDeclaration, file: ParsedFile, st: State): void {
  if (!ts.isIdentifier(node.name) || !node.initializer) return;

  const init = stripAwait(node.initializer);
  if (!ts.isNewExpression(init) && !ts.isCallExpression(init)) return;

  const argument = init.arguments?.[0];
  if (!argument || !ts.isObjectLiteralExpression(argument)) return;

  const value = propOf(argument, "prefix");
  const resolved = value ? evalRoutePaths(value, file, st.ctx) : undefined;

  if (resolved?.[0]) {
    st.ownPrefix.set(
      routerId(file, node.name.text, scopePosOfDeclaration(node)),
      resolved[0].path,
    );
  }
}

function collectNestEndpoints(file: ParsedFile, st: State): void {
  const verbs: Record<string, EndpointMethod> = {
    Get: "GET",
    Post: "POST",
    Put: "PUT",
    Patch: "PATCH",
    Delete: "DELETE",
    Head: "HEAD",
    Options: "OPTIONS",
    All: "ALL",
  };

  for (const statement of file.sf.statements) {
    if (!ts.isClassDeclaration(statement)) continue;

    const controller = decoratorsOf(statement).find(
      (decorator) => decoratorName(decorator) === "Controller",
    );
    if (!controller) continue;

    const base = decoratorPath(controller);

    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member)) continue;

      for (const decorator of decoratorsOf(member)) {
        const verb = verbs[decoratorName(decorator) ?? ""];
        if (!verb) continue;

        st.endpoints.push({
          method: verb,
          localPath: joinPaths(base, decoratorPath(decorator)),
          routerId: "",
          absolute: true,
          framework: "nest",
          file,
          regNode: member,
          nestMethod: { node: member, file },
          order: st.order++,
          unresolvedBase: false,
        });
      }
    }
  }
}

function nextSegment(segment: string): string | undefined {
  if (/^\(.*\)$/.test(segment) || segment.startsWith("@")) return undefined;
  if (/^\[\[\.\.\..+\]\]$/.test(segment) || /^\[\.\.\..+\]$/.test(segment)) return "*";
  const dynamic = /^\[(.+)\]$/.exec(segment);
  if (dynamic) return `:${dynamic[1]}`;
  return segment;
}

function collectNextEndpoints(file: ParsedFile, st: State): void {
  const parts = file.rel.split("/");
  const fileName = parts[parts.length - 1];

  /* ---- app router: app/**\/route.ts --------------------------------- */
  const appIndex = parts.indexOf("app");

  if (appIndex >= 0 && /^route\.[cm]?[jt]sx?$/.test(fileName)) {
    const segments = parts
      .slice(appIndex + 1, -1)
      .map(nextSegment)
      .filter((segment): segment is string => Boolean(segment));
    const routePath = joinPaths(...segments);

    for (const exported of file.exportedNames.keys()) {
      if (!HTTP_METHODS.has(exported)) continue;

      const declaration = lookupExport(file, exported, st.ctx);
      const fn = declaration ? functionFromNode(declaration.node) : undefined;
      if (!declaration) continue;

      st.endpoints.push({
        method: exported as HttpMethod,
        localPath: routePath,
        routerId: "",
        absolute: true,
        framework: "next",
        file,
        regNode: fn ?? declaration.node,
        handler: fn ? { fn, file: declaration.file } : undefined,
        order: st.order++,
        unresolvedBase: false,
      });
    }
    return;
  }

  /* ---- pages router: pages/api/** ----------------------------------- */
  const pagesIndex = parts.indexOf("pages");

  if (pagesIndex >= 0 && parts[pagesIndex + 1] === "api") {
    const segments = parts
      .slice(pagesIndex + 1)
      .map((segment, index, all) =>
        index === all.length - 1 ? segment.replace(/\.[cm]?[jt]sx?$/, "") : segment,
      )
      .map(nextSegment)
      .filter((segment): segment is string => Boolean(segment) && segment !== "index");

    const declaration = lookupExport(file, "default", st.ctx);
    const fn = declaration ? functionFromNode(declaration.node) : undefined;
    if (!declaration || !fn) return;

    const methods = new Set<EndpointMethod>();
    const addMethod = (value: string) => {
      if (HTTP_METHODS.has(value.toUpperCase())) methods.add(value.toUpperCase() as HttpMethod);
    };

    if (fn.body) {
      walk(fn.body, (node) => {
        if (
          ts.isBinaryExpression(node) &&
          /\.method$/.test(node.left.getText()) &&
          ts.isStringLiteralLike(node.right)
        ) {
          addMethod(node.right.text);
        }
        if (
          ts.isCaseClause(node) &&
          ts.isStringLiteralLike(node.expression) &&
          ts.isSwitchStatement(node.parent.parent) &&
          /\.method$/.test(node.parent.parent.expression.getText())
        ) {
          addMethod(node.expression.text);
        }
      });
    }

    if (methods.size === 0) methods.add("ALL");

    for (const method of methods) {
      st.endpoints.push({
        method,
        localPath: joinPaths(...segments),
        routerId: "",
        absolute: true,
        framework: "next",
        file,
        regNode: fn,
        handler: { fn, file: declaration.file },
        order: st.order++,
        unresolvedBase: false,
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Frontend discovery                                                        */
/* -------------------------------------------------------------------------- */

interface ClientInfo {
  kind: ClientKind;
  /** True when the receiver is known to be an HTTP client (not just named like one). */
  definite: boolean;
  base: string;
  baseExternal: boolean;
}

function baseFromConfig(
  config: ts.ObjectLiteralExpression | undefined,
  file: ParsedFile,
  ctx: Ctx,
): { base: string; external: boolean } {
  if (!config) return { base: "", external: false };

  const value =
    propOf(config, "baseURL") ??
    propOf(config, "baseUrl") ??
    propOf(config, "prefixUrl") ??
    propOf(config, "prefix");

  if (!value) return { base: "", external: false };

  const parts = evalUrl(value, file, ctx);
  if (!parts) return { base: "", external: false };

  const composed = composeUrl(parts);
  if (composed.external) return { base: "", external: true };
  if (composed.unresolved) return { base: "", external: false };

  return { base: composed.template === "/" ? "" : composed.template, external: false };
}

function describeClient(
  receiver: ts.Expression,
  file: ParsedFile,
  ctx: Ctx,
): ClientInfo | undefined {
  const inner = unwrapExpr(receiver);

  if (ts.isIdentifier(inner)) {
    if (inner.text === "axios" || inner.text === "$axios") {
      return { kind: "axios", definite: true, base: "", baseExternal: false };
    }
    if (inner.text === "ky" || inner.text === "got") {
      return { kind: "ky", definite: true, base: "", baseExternal: false };
    }

    const declaration = lookupDecl(file, inner.text, ctx);

    if (
      declaration &&
      ts.isVariableDeclaration(declaration.node) &&
      declaration.node.initializer
    ) {
      const init = stripAwait(declaration.node.initializer);

      if (ts.isCallExpression(init)) {
        const text = init.expression.getText();
        const factory = /^(axios|ky|got)\.(create|extend)$/.exec(text);

        if (factory) {
          const config = init.arguments[0];
          const resolved = baseFromConfig(
            config && ts.isObjectLiteralExpression(config) ? config : undefined,
            declaration.file,
            ctx,
          );
          return {
            kind: factory[1] === "axios" ? "axios" : "ky",
            definite: true,
            base: resolved.base,
            baseExternal: resolved.external,
          };
        }
      }
    }

    if (CLIENT_NAME.test(inner.text)) {
      return { kind: "http", definite: false, base: "", baseExternal: false };
    }
    return undefined;
  }

  if (
    ts.isPropertyAccessExpression(inner) &&
    inner.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    if (/^(http|httpClient)$/i.test(inner.name.text)) {
      return { kind: "angular", definite: true, base: "", baseExternal: false };
    }
    if (CLIENT_NAME.test(inner.name.text)) {
      return { kind: "http", definite: false, base: "", baseExternal: false };
    }
  }

  return undefined;
}

function keysOf(
  expression: ts.Expression | undefined,
  file: ParsedFile,
  ctx: Ctx,
): { keys: string[] | null; line?: number } {
  if (!expression) return { keys: null };

  let inner = stripAwait(expression);

  if (
    ts.isCallExpression(inner) &&
    inner.expression.getText() === "JSON.stringify" &&
    inner.arguments[0]
  ) {
    inner = stripAwait(inner.arguments[0]);
  }

  const object = resolveObjectLiteral(inner, file, ctx);
  if (!object) return { keys: null };

  const keys: string[] = [];

  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) return { keys: null };

    if (ts.isShorthandPropertyAssignment(property)) {
      keys.push(property.name.text);
    } else if (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
      const key = propertyNameText(property.name);
      if (!key) return { keys: null };
      keys.push(key);
    } else {
      return { keys: null };
    }
  }

  return { keys, line: startLineOf(object) };
}

function readMethodExpression(
  expression: ts.Expression | undefined,
  file: ParsedFile,
  ctx: Ctx,
): CallMethod | undefined {
  if (!expression) return undefined;

  const parts = evalUrl(expression, file, ctx);
  if (!parts || !parts.every((part) => "text" in part)) return undefined;

  const text = parts.map((part) => ("text" in part ? part.text : "")).join("").toUpperCase();
  return HTTP_METHODS.has(text) ? (text as HttpMethod) : undefined;
}

function isNullish(expression: ts.Expression | undefined): boolean {
  if (!expression) return true;
  const inner = unwrapExpr(expression);
  return (
    inner.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(inner) && inner.text === "undefined")
  );
}

/** Outermost call of a promise chain: fetch(...).then(...).then(...) */
function chainTop(call: ts.Node): ts.Node {
  let current: ts.Node = climb(call);

  for (;;) {
    const parent = current.parent;
    const grand = parent?.parent;

    if (
      parent &&
      grand &&
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === current &&
      ts.isCallExpression(grand) &&
      grand.expression === parent
    ) {
      current = climb(grand);
    } else {
      return current;
    }
  }
}

function statementOf(node: ts.Node): ts.Node {
  let current = node;

  while (current.parent) {
    const parent = current.parent;
    if (
      ts.isBlock(parent) ||
      ts.isSourceFile(parent) ||
      ts.isModuleBlock(parent) ||
      ts.isCaseClause(parent) ||
      ts.isDefaultClause(parent)
    ) {
      return current;
    }
    current = parent;
  }

  return current;
}

/* ---- Response consumption ---------------------------------------------- */

function trackResponseUse(call: ts.CallExpression, client: ClientKind): Map<string, number> {
  const paths = new Map<string, number>();
  const visited = new Set<ts.Node>();
  let budget = 300;

  const axiosLike = client === "axios" || client === "http";

  const addPath = (value: string, node: ts.Node) => {
    if (!paths.has(value)) paths.set(value, startLineOf(node));
  };

  const bindingPaths = (pattern: ts.ObjectBindingPattern) => {
    for (const element of pattern.elements) {
      if (element.dotDotDotToken) continue;

      const key = element.propertyName
        ? propertyNameText(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : undefined;

      if (!key || PAYLOAD_MEMBERS.has(key)) continue;

      if (ts.isObjectBindingPattern(element.name)) {
        for (const nested of element.name.elements) {
          const nestedKey = nested.propertyName
            ? propertyNameText(nested.propertyName)
            : ts.isIdentifier(nested.name)
              ? nested.name.text
              : undefined;
          if (nestedKey && !PAYLOAD_MEMBERS.has(nestedKey)) addPath(`${key}.${nestedKey}`, nested);
        }
      } else {
        addPath(key, element);
      }
    }
  };

  const returnedOf = (fn: FnNode): ts.Expression | undefined => {
    const returned = returnedExpression(fn);
    return returned ? (climb(returned) as ts.Expression) : undefined;
  };

  const trackIdentifier = (
    name: ts.Identifier,
    scopeFrom: ts.Node,
    kind: "payload" | "response",
  ) => {
    let scope: ts.Node | undefined = isFnNode(scopeFrom) ? scopeFrom.body : undefined;

    if (!scope) {
      let current: ts.Node | undefined = scopeFrom.parent;
      while (current && !isFnNode(current) && !ts.isSourceFile(current)) current = current.parent;
      scope = current && isFnNode(current) ? (current.body ?? current) : current;
    }

    if (!scope) return;

    walk(scope, (node) => {
      if (
        ts.isIdentifier(node) &&
        node !== name &&
        node.text === name.text &&
        isReferenceIdentifier(node) &&
        !visited.has(node) &&
        budget-- > 0
      ) {
        visited.add(node);
        if (kind === "payload") usePayload(node);
        else useResponse(node);
      }
    });
  };

  const handleThen = (thenCall: ts.CallExpression, kind: "payload" | "response") => {
    const callback = thenCall.arguments[0];
    const fn = callback ? functionFromExpression(callback) : undefined;
    if (!fn) return;

    const parameter = fn.parameters[0];
    if (!parameter) return;

    if (kind === "payload") {
      if (ts.isIdentifier(parameter.name)) trackIdentifier(parameter.name, fn, "payload");
      else if (ts.isObjectBindingPattern(parameter.name)) bindingPaths(parameter.name);
      return;
    }

    if (ts.isIdentifier(parameter.name)) {
      const local = parameter.name;
      trackIdentifier(local, fn, "response");

      const returned = returnedOf(fn);
      if (returned) {
        const inner = unwrapExpr(returned);

        const isJson =
          ts.isCallExpression(inner) &&
          ts.isPropertyAccessExpression(unwrapExpr(inner.expression)) &&
          (unwrapExpr(inner.expression) as ts.PropertyAccessExpression).name.text === "json" &&
          isNamed((unwrapExpr(inner.expression) as ts.PropertyAccessExpression).expression, local.text);

        const isData =
          ts.isPropertyAccessExpression(inner) &&
          inner.name.text === "data" &&
          isNamed(inner.expression, local.text);

        if ((isJson && !axiosLike) || (isData && axiosLike)) usePayload(thenCall);
      }
    } else if (ts.isObjectBindingPattern(parameter.name) && axiosLike) {
      for (const element of parameter.name.elements) {
        const key = element.propertyName
          ? propertyNameText(element.propertyName)
          : ts.isIdentifier(element.name)
            ? element.name.text
            : undefined;
        if (key !== "data") continue;
        if (ts.isIdentifier(element.name)) trackIdentifier(element.name, fn, "payload");
        else if (ts.isObjectBindingPattern(element.name)) bindingPaths(element.name);
      }
    }
  };

  function usePayload(node: ts.Node): void {
    const current = climb(node);
    const parent = current.parent;
    if (!parent) return;

    if (ts.isPropertyAccessExpression(parent) && parent.expression === current) {
      const first = parent.name.text;
      const grand = parent.parent;

      if (first === "then" && grand && ts.isCallExpression(grand) && grand.expression === parent) {
        handleThen(grand, "payload");
        return;
      }

      if (PAYLOAD_MEMBERS.has(first)) return;

      const outer = climb(parent);
      const next = outer.parent;

      if (
        next &&
        ts.isPropertyAccessExpression(next) &&
        next.expression === outer &&
        !PAYLOAD_MEMBERS.has(next.name.text)
      ) {
        addPath(`${first}.${next.name.text}`, next);
      } else {
        addPath(first, parent);
      }
      return;
    }

    if (
      ts.isElementAccessExpression(parent) &&
      parent.expression === current &&
      ts.isStringLiteralLike(parent.argumentExpression)
    ) {
      addPath(parent.argumentExpression.text, parent);
      return;
    }

    if (ts.isVariableDeclaration(parent) && parent.initializer === current) {
      if (ts.isIdentifier(parent.name)) trackIdentifier(parent.name, parent, "payload");
      else if (ts.isObjectBindingPattern(parent.name)) bindingPaths(parent.name);
    }
  }

  function useResponse(node: ts.Node): void {
    const current = climb(node);
    const parent = current.parent;
    if (!parent) return;

    if (ts.isPropertyAccessExpression(parent) && parent.expression === current) {
      const name = parent.name.text;
      const grand = parent.parent;

      if (name === "data" && axiosLike) {
        usePayload(parent);
        return;
      }

      if (name === "json" && grand && ts.isCallExpression(grand) && grand.expression === parent) {
        usePayload(grand);
        return;
      }

      if (name === "then" && grand && ts.isCallExpression(grand) && grand.expression === parent) {
        handleThen(grand, "response");
      }
      return;
    }

    if (ts.isVariableDeclaration(parent) && parent.initializer === current) {
      if (ts.isIdentifier(parent.name)) {
        trackIdentifier(parent.name, parent, "response");
      } else if (ts.isObjectBindingPattern(parent.name) && axiosLike) {
        for (const element of parent.name.elements) {
          const key = element.propertyName
            ? propertyNameText(element.propertyName)
            : ts.isIdentifier(element.name)
              ? element.name.text
              : undefined;
          if (key !== "data") continue;
          if (ts.isIdentifier(element.name)) trackIdentifier(element.name, parent, "payload");
          else if (ts.isObjectBindingPattern(element.name)) bindingPaths(element.name);
        }
      }
    }
  }

  if (client !== "angular") useResponse(call);

  return paths;
}

/* ---- Call registration ------------------------------------------------- */

interface CallSpec {
  file: ParsedFile;
  node: ts.Node;
  tracked?: ts.CallExpression;
  client: ClientKind;
  method: CallMethod;
  urlExpression: ts.Expression;
  base: string;
  baseExternal: boolean;
  dataExpression?: ts.Expression;
  hasBody: boolean;
  paramsExpression?: ts.Expression;
}

function registerCall(st: State, spec: CallSpec): void {
  const { ctx } = st;

  if (spec.baseExternal) {
    st.externalCalls++;
    return;
  }

  const parts = evalUrl(spec.urlExpression, spec.file, ctx);

  const noteUnresolved = () => {
    st.unresolvedCalls++;
    if (st.unresolvedSamples.length < 3) {
      st.unresolvedSamples.push(`${spec.file.rel}:${startLineOf(spec.node)}`);
    }
  };

  if (!parts) {
    noteUnresolved();
    return;
  }

  const composed = composeUrl(parts);

  if (composed.external) {
    st.externalCalls++;
    return;
  }

  if (composed.unresolved) {
    noteUnresolved();
    return;
  }

  let template = composed.template;

  if (!composed.absolute && spec.base) template = joinPaths(spec.base, template);
  if (st.pathPrefix) template = joinPaths(st.pathPrefix, template);

  if (STATIC_ASSET.test(template.split("{{")[0])) {
    st.externalCalls++;
    return;
  }

  const body = spec.hasBody ? keysOf(spec.dataExpression, spec.file, ctx) : { keys: null };

  const queryKeys = [...composed.query];
  let queryOpaque = composed.queryOpaque;

  if (spec.paramsExpression) {
    const params = keysOf(spec.paramsExpression, spec.file, ctx);
    if (params.keys) queryKeys.push(...params.keys);
    else queryOpaque = true;
  }

  const responsePaths = spec.tracked
    ? trackResponseUse(spec.tracked, spec.client)
    : new Map<string, number>();

  const top = spec.tracked ? chainTop(spec.tracked) : spec.node;
  const anchor = statementOf(top);
  const startLine = Math.min(startLineOf(spec.node), startLineOf(anchor));

  const callLine = startLineOf(spec.node);
  const lineStart = callLine - startLine <= 3 ? startLine : callLine;

  const sf = spec.file.sf;
  const endLine = Math.max(
    lineOf(sf, Math.max(top.getStart(), top.end - 1)),
    endLineOf(spec.node),
  );

  const segs = parseCallSegments(template);

  st.calls.push({
    id: shortHash(spec.file.rel, String(callLine), template, spec.method),
    method: spec.method,
    path: displayPath(template),
    segs,
    client: spec.client,
    file: spec.file,
    node: spec.node,
    line: lineStart,
    endLine,
    symbol: symbolAt(spec.node),
    hasBody: spec.hasBody,
    bodyKeys: body.keys,
    bodyLine: body.line,
    queryKeys,
    queryOpaque,
    responsePaths,
    rawUrl: spec.urlExpression.getText().slice(0, 120),
  });
}

function handleClientCall(call: ts.CallExpression, file: ParsedFile, st: State): void {
  const { ctx } = st;
  const callee = unwrapExpr(call.expression);
  const args = call.arguments;

  const config = (index: number): ts.ObjectLiteralExpression | undefined => {
    const value = args[index];
    return value ? resolveObjectLiteral(value, file, ctx) : undefined;
  };

  /* ---- fetch ---------------------------------------------------------- */
  const isFetch =
    (ts.isIdentifier(callee) && callee.text === "fetch") ||
    (ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "fetch" &&
      /^(window|globalThis|self)$/.test(callee.expression.getText()));

  if (isFetch && args[0]) {
    let urlExpression = unwrapExpr(args[0]);

    if (
      (ts.isNewExpression(urlExpression) &&
        ts.isIdentifier(urlExpression.expression) &&
        /^(Request|URL)$/.test(urlExpression.expression.text)) &&
      urlExpression.arguments?.[0]
    ) {
      urlExpression = urlExpression.arguments[0];
    }

    const init = config(1);
    const methodValue = init ? propOf(init, "method") : undefined;
    const method =
      readMethodExpression(methodValue, file, ctx) ??
      (args[1] && !init ? "UNKNOWN" : methodValue ? "UNKNOWN" : "GET");

    const bodyValue = init ? propOf(init, "body") : undefined;

    registerCall(st, {
      file,
      node: call,
      tracked: call,
      client: "fetch",
      method,
      urlExpression,
      base: "",
      baseExternal: false,
      dataExpression: bodyValue,
      hasBody: !isNullish(bodyValue),
    });
    return;
  }

  /* ---- useSWR("/api/x", fetcher) ------------------------------------- */
  if (ts.isIdentifier(callee) && /^useSWR(Immutable)?$/.test(callee.text) && args[0]) {
    let key = unwrapExpr(args[0]);
    if (ts.isArrayLiteralExpression(key) && key.elements[0]) key = unwrapExpr(key.elements[0]);

    if (ts.isStringLiteralLike(key) || ts.isTemplateExpression(key)) {
      registerCall(st, {
        file,
        node: call,
        client: "swr",
        method: "GET",
        urlExpression: key,
        base: "",
        baseExternal: false,
        hasBody: false,
      });
    }
    return;
  }

  /* ---- axios(config) / axios(url, config) ----------------------------- */
  if (ts.isIdentifier(callee)) {
    const info = describeClient(callee, file, ctx);

    if (info?.definite && (info.kind === "axios" || info.kind === "ky") && args[0]) {
      const first = resolveObjectLiteral(args[0], file, ctx);
      const options = first ?? config(1);
      const urlExpression = first ? propOf(first, "url") : args[0];
      if (!urlExpression) return;

      const method = readMethodExpression(options ? propOf(options, "method") : undefined, file, ctx) ?? "GET";
      const data = options ? (propOf(options, "data") ?? propOf(options, "json") ?? propOf(options, "body")) : undefined;
      const resolvedBase = first ? baseFromConfig(first, file, ctx) : { base: info.base, external: info.baseExternal };

      registerCall(st, {
        file,
        node: call,
        tracked: call,
        client: info.kind,
        method,
        urlExpression,
        base: resolvedBase.base || info.base,
        baseExternal: resolvedBase.external || info.baseExternal,
        dataExpression: data,
        hasBody: !isNullish(data),
        paramsExpression: options ? (propOf(options, "params") ?? propOf(options, "searchParams")) : undefined,
      });
    }
    return;
  }

  /* ---- client.get(url) / client.post(url, data) / client.request({}) -- */
  if (!ts.isPropertyAccessExpression(callee)) return;

  const name = callee.name.text;
  if (!HTTP_VERBS.has(name) && name !== "request") return;

  const info = describeClient(callee.expression, file, ctx);
  if (!info) return;

  // `api.get("/x", handler)` is a route registration, not a client call.
  if (!info.definite && isBackendReceiver(callee.expression, file)) return;
  if (!info.definite && args.some((argument) => functionFromExpression(argument))) return;

  let urlExpression: ts.Expression | undefined;
  let method: CallMethod = "UNKNOWN";
  let dataExpression: ts.Expression | undefined;
  let hasBody = false;
  let paramsExpression: ts.Expression | undefined;
  let options: ts.ObjectLiteralExpression | undefined;
  let base = info.base;
  let baseExternal = info.baseExternal;

  if (name === "request") {
    options = config(0);
    if (!options) return;
    urlExpression = propOf(options, "url");
    method = readMethodExpression(propOf(options, "method"), file, ctx) ?? "GET";
    dataExpression = propOf(options, "data") ?? propOf(options, "json") ?? propOf(options, "body");
    hasBody = !isNullish(dataExpression);
    paramsExpression = propOf(options, "params") ?? propOf(options, "searchParams");
    const own = baseFromConfig(options, file, ctx);
    base = own.base || base;
    baseExternal = own.external || baseExternal;
  } else {
    urlExpression = args[0];
    method = name.toUpperCase() as HttpMethod;

    const takesBody = name === "post" || name === "put" || name === "patch";

    if (info.kind === "ky") {
      options = config(1);
      dataExpression = options ? (propOf(options, "json") ?? propOf(options, "body")) : undefined;
      paramsExpression = options ? propOf(options, "searchParams") : undefined;
      hasBody = !isNullish(dataExpression);
    } else {
      if (takesBody) {
        dataExpression = args[1];
        hasBody = args.length >= 2 && !isNullish(dataExpression);
        options = config(2);
      } else {
        options = config(1);
        dataExpression = options ? propOf(options, "data") : undefined;
        hasBody = !isNullish(dataExpression);
      }
      paramsExpression = options ? propOf(options, "params") : undefined;
    }
  }

  if (!urlExpression) return;

  // A name-based guess needs a path-like first argument.
  if (!info.definite) {
    const parts = evalUrl(urlExpression, file, ctx);
    const firstPart = parts?.[0];
    const looksLikeUrl =
      firstPart && "text" in firstPart && (firstPart.text.startsWith("/") || /^https?:/i.test(firstPart.text));
    if (!looksLikeUrl) return;
  }

  registerCall(st, {
    file,
    node: call,
    tracked: info.kind === "angular" ? undefined : call,
    client: info.kind,
    method,
    urlExpression,
    base,
    baseExternal,
    dataExpression,
    hasBody,
    paramsExpression,
  });
}

function handleRtkQuery(node: ts.PropertyAssignment, file: ParsedFile, st: State): void {
  if (!ts.isIdentifier(node.name) || node.name.text !== "query") return;

  const object = node.parent;
  if (!ts.isObjectLiteralExpression(object)) return;

  const call = object.parent;
  if (!ts.isCallExpression(call)) return;

  const callee = unwrapExpr(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return;
  if (!["query", "mutation", "infiniteQuery"].includes(callee.name.text)) return;

  const fn = functionFromExpression(node.initializer);
  const returned = fn ? returnedExpression(fn) : undefined;
  if (!returned) return;

  const value = unwrapExpr(returned);

  if (ts.isObjectLiteralExpression(value)) {
    const urlExpression = propOf(value, "url");
    if (!urlExpression) return;

    const bodyValue = propOf(value, "body");

    registerCall(st, {
      file,
      node: value,
      client: "rtk",
      method: readMethodExpression(propOf(value, "method"), file, st.ctx) ?? "GET",
      urlExpression,
      base: st.rtkBase,
      baseExternal: false,
      dataExpression: bodyValue,
      hasBody: !isNullish(bodyValue),
      paramsExpression: propOf(value, "params"),
    });
    return;
  }

  if (ts.isStringLiteralLike(value) || ts.isTemplateExpression(value)) {
    registerCall(st, {
      file,
      node: value,
      client: "rtk",
      method: "GET",
      urlExpression: value,
      base: st.rtkBase,
      baseExternal: false,
      hasBody: false,
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Prefix resolution                                                         */
/* -------------------------------------------------------------------------- */

function prefixesFor(
  id: string,
  st: State,
  seen: Set<string> = new Set(),
  depth = 0,
): Array<{ prefix: string; rooted: boolean }> {
  const own = st.ownPrefix.get(id) ?? "";
  const parents = st.parents.get(id);

  if (!parents || parents.length === 0 || depth > 10 || seen.has(id)) {
    return [{ prefix: own, rooted: st.roots.has(id) }];
  }

  const nextSeen = new Set(seen).add(id);
  const out: Array<{ prefix: string; rooted: boolean }> = [];

  for (const edge of parents) {
    for (const up of prefixesFor(edge.parent, st, nextSeen, depth + 1)) {
      out.push({
        prefix: joinPaths(up.prefix, edge.prefix, own),
        rooted: up.rooted && !edge.unresolvedBase,
      });
      if (out.length >= 12) return out;
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/*  Evidence and snippets                                                     */
/* -------------------------------------------------------------------------- */

function fileLinesOf(file: ParsedFile): string[] {
  file.lines ??= file.text.split(/\r?\n/);
  return file.lines;
}

function makeEvidence(
  role: "frontend" | "backend",
  label: string,
  file: ParsedFile,
  startLine: number,
  endLine: number,
  highlight: number[],
  symbol?: string,
): ContractEvidence {
  let start = Math.max(1, startLine);
  const end = Math.max(start, endLine);
  const lines = fileLinesOf(file);

  const inside = highlight.filter((line) => line >= start && line <= end);

  // Make sure the first highlighted line stays inside the capped window.
  if (inside.length > 0 && Math.min(...inside) > start + MAX_SNIPPET_LINES - 1) {
    start = Math.max(start, Math.min(...inside) - 2);
  }

  const source = lines.slice(start - 1, end);
  const capped = source.slice(0, MAX_SNIPPET_LINES);
  const visibleEnd = start + capped.length - 1;

  return {
    role,
    label,
    filePath: file.rel,
    startLine: start,
    endLine: Math.min(end, Math.max(visibleEnd, end)),
    fileLines: file.lineCount,
    symbol,
    snippet: dedent(capped).join("\n"),
    snippetTruncated: source.length > capped.length,
    highlightLines: [...new Set(highlight)].filter((line) => line >= start && line <= visibleEnd),
  };
}

function callEvidence(call: ApiCall, highlight: number[] = []): ContractEvidence {
  return makeEvidence(
    "frontend",
    `${call.method === "UNKNOWN" ? "CALL" : call.method} ${call.path}`,
    call.file,
    call.line,
    call.endLine,
    highlight.length ? highlight : [startLineOf(call.node)],
    call.symbol,
  );
}

function routeEvidence(endpoint: FinalEndpoint, highlight: number[] = []): ContractEvidence {
  const node = endpoint.raw.regNode;
  const start = startLineOf(node);
  const end = endLineOf(node);

  return makeEvidence(
    "backend",
    `${endpoint.method} ${endpoint.path}`,
    endpoint.raw.file,
    start,
    end,
    highlight.length ? highlight : [start],
    symbolAt(node),
  );
}

function handlerEvidence(endpoint: FinalEndpoint, highlight: number[]): ContractEvidence {
  const facts = endpoint.facts;

  if (!facts.fn || !facts.file) return routeEvidence(endpoint);

  const start = startLineOf(facts.fn);
  const end = endLineOf(facts.fn);

  return makeEvidence(
    "backend",
    `${endpoint.method} ${endpoint.path}`,
    facts.file,
    start,
    end,
    highlight.length ? highlight : [start],
    symbolAt(facts.fn) ?? (ts.isMethodDeclaration(facts.fn) ? facts.fn.name.getText() : undefined),
  );
}

/* -------------------------------------------------------------------------- */
/*  Issue construction                                                        */
/* -------------------------------------------------------------------------- */

const KIND_GROUP: Record<IssueKind, IssueGroup> = {
  "method-mismatch": "mismatch",
  "missing-endpoint": "mismatch",
  "missing-body": "mismatch",
  "missing-body-field": "mismatch",
  "extra-body-field": "mismatch",
  "missing-query-param": "mismatch",
  "extra-query-param": "mismatch",
  "response-field-mismatch": "mismatch",
  "unused-endpoint": "unused",
  "duplicate-route": "route",
  "route-shadowed": "route",
};

const KIND_BASE_SCORE: Record<IssueKind, number> = {
  "method-mismatch": 92,
  "missing-endpoint": 76,
  "missing-body": 70,
  "missing-body-field": 72,
  "response-field-mismatch": 56,
  "duplicate-route": 52,
  "route-shadowed": 50,
  "missing-query-param": 44,
  "extra-body-field": 30,
  "unused-endpoint": 24,
  "extra-query-param": 14,
};

function severityFor(score: number): ContractSeverity {
  if (score >= 85) return "critical";
  if (score >= 65) return "high";
  if (score >= 40) return "medium";
  if (score >= 20) return "low";
  return "info";
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function routeStub(call: ApiCall): string {
  const verb = call.method === "UNKNOWN" ? "get" : call.method.toLowerCase();
  const destructure =
    call.bodyKeys && call.bodyKeys.length
      ? `  const { ${call.bodyKeys.join(", ")} } = req.body;\n`
      : "";

  const top = [...new Set([...call.responsePaths.keys()].map((value) => value.split(".")[0]))];
  const payload = top.length
    ? `{ ${top.map((key) => `${key}: null`).join(", ")} }`
    : "{ ok: true }";

  return `router.${verb}("${call.path}", async (req, res) => {\n${destructure}  // TODO: implement\n  res.json(${payload});\n});`;
}

function replaceMethodInSnippet(
  evidence: ContractEvidence,
  from: string,
  to: string,
): string | undefined {
  const lines = evidence.snippet.split("\n");

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    const verbPattern = new RegExp(`\\.${from.toLowerCase()}\\(`);
    const optionPattern = new RegExp(`(method\\s*:\\s*)(['"\`])${from}\\2`, "i");

    if (verbPattern.test(line)) {
      return `- ${line.trim()}\n+ ${line.replace(verbPattern, `.${to.toLowerCase()}(`).trim()}`;
    }

    if (optionPattern.test(line)) {
      return `- ${line.trim()}\n+ ${line.replace(optionPattern, `$1$2${to}$2`).trim()}`;
    }
  }

  return undefined;
}

function buildIssueDrafts(
  st: State,
  endpoints: FinalEndpoint[],
  options: { includeUnused: boolean },
): { drafts: IssueDraft[]; matchedCalls: number; unverifiable: number } {
  const drafts: IssueDraft[] = [];
  let matchedCalls = 0;
  let unverifiable = 0;

  const noBackend = endpoints.length === 0;
  const noClient = st.calls.length === 0;

  if (!noBackend) {
    const groupedMissing = new Map<string, ApiCall[]>();
    const groupedMethod = new Map<string, { calls: ApiCall[]; candidates: FinalEndpoint[] }>();
    const groupedFields = new Map<string, { calls: ApiCall[]; endpoint: FinalEndpoint; draft: IssueDraft }>();

    for (const call of st.calls) {
      if (call.method === "OPTIONS") continue;

      const pathMatches = endpoints
        .map((endpoint) => ({ endpoint, score: matchSegments(call.segs, endpoint.segs) }))
        .filter((entry) => entry.score >= 0);

      const methodOk = pathMatches.filter(({ endpoint }) =>
        endpoint.method === "ALL" ||
        endpoint.method === call.method ||
        call.method === "UNKNOWN" ||
        (call.method === "HEAD" && endpoint.method === "GET"),
      );

      /* ---- matched ---- */
      if (methodOk.length > 0) {
        matchedCalls++;

        const best = Math.max(...methodOk.map((entry) => entry.score));
        const winners = methodOk
          .filter((entry) => entry.score === best)
          .sort((a, b) => Number(a.endpoint.method === "ALL") - Number(b.endpoint.method === "ALL"));

        winners.forEach((entry) => entry.endpoint.callers++);
        const endpoint = winners[0].endpoint;

        compareContract(call, endpoint, groupedFields, drafts);
        continue;
      }

      /* ---- same path, wrong method ---- */
      if (pathMatches.length > 0) {
        const key = `${call.method} ${call.path}`;
        const entry = groupedMethod.get(key) ?? { calls: [], candidates: [] };
        entry.calls.push(call);
        for (const { endpoint } of pathMatches) {
          if (!entry.candidates.includes(endpoint)) entry.candidates.push(endpoint);
        }
        groupedMethod.set(key, entry);
        continue;
      }

      /* ---- router never found mounted: allow a suffix match ---- */
      const loose = endpoints.filter(
        (endpoint) =>
          !endpoint.mountConfirmed &&
          endpoint.segs.length >= call.segs.length &&
          call.segs.length > 0 &&
          (endpoint.method === "ALL" ||
            endpoint.method === call.method ||
            call.method === "UNKNOWN") &&
          matchSegments(call.segs, endpoint.segs.slice(endpoint.segs.length - call.segs.length)) >= 0,
      );

      if (loose.length > 0) {
        matchedCalls++;
        loose.forEach((endpoint) => endpoint.callers++);
        continue;
      }

      /* ---- under a router we could not follow ---- */
      const opaque = [...st.opaquePrefixes].some((prefix) => {
        const callPath = `/${call.segs.map((segment) => (segment.k === "lit" ? segment.v : ":p")).join("/")}`;
        return callPath.toLowerCase().startsWith(prefix.toLowerCase());
      });

      if (opaque) {
        unverifiable++;
        continue;
      }

      const key = `${call.method} ${call.path}`;
      const list = groupedMissing.get(key) ?? [];
      list.push(call);
      groupedMissing.set(key, list);
    }

    /* ---- method mismatches ---- */
    for (const [key, entry] of groupedMethod) {
      const first = entry.calls[0];
      const allowed = [...new Set(entry.candidates.map((endpoint) => endpoint.method))];
      const target = allowed.find((method) => method !== "ALL") ?? allowed[0];
      const calls = entry.calls.slice(0, MAX_EVIDENCE_PER_SIDE);

      const clientEvidence = calls.map((call) => callEvidence(call));
      const patch =
        target && target !== "ALL"
          ? replaceMethodInSnippet(clientEvidence[0], first.method, target)
          : undefined;

      drafts.push({
        kind: "method-mismatch",
        key,
        method: first.method,
        path: first.path,
        title: `${first.method} ${first.path} — server expects ${allowed.join(" or ")}`,
        description: `The client sends ${first.method} to ${first.path}, but the backend only defines ${allowed.join(", ")} for that path. The request will fail with 404 or 405.`,
        callCount: entry.calls.length,
        endpointId: entry.candidates[0]?.id,
        evidence: [
          ...clientEvidence,
          ...entry.candidates.slice(0, MAX_EVIDENCE_PER_SIDE).map((endpoint) => routeEvidence(endpoint)),
        ],
        suggestion: {
          strategy: "update-client-call",
          confidence: "high",
          title: `Call this route with ${target}`,
          summary: `Change the client to send ${target} (the method the backend defines), or add a ${first.method} handler on the server if the client is right.`,
          steps: [
            `Open ${first.file.rel} at line ${first.line}.`,
            `Change the HTTP method from ${first.method} to ${target}.`,
            `If the client is correct instead, register ${first.method} ${first.path} next to the existing route in ${entry.candidates[0].raw.file.rel}.`,
            "Re-run the analysis to confirm the call matches.",
          ],
          patch,
          caveats: [],
        },
      });
    }

    /* ---- missing endpoints ---- */
    let similarBudget = 100;

    for (const [key, calls] of groupedMissing) {
      const first = calls[0];
      let similar: FinalEndpoint | undefined;

      if (similarBudget-- > 0) {
        const callKey = patternKey(first.segs);

        similar = endpoints.find((endpoint) => {
          const route = endpoint.segs;
          return (
            route.length > first.segs.length &&
            matchSegments(first.segs, route.slice(route.length - first.segs.length)) >= 0
          );
        });

        if (!similar) {
          let bestDistance = Infinity;
          for (const endpoint of endpoints) {
            const distance = levenshtein(callKey, patternKey(endpoint.segs));
            if (distance < bestDistance && distance <= Math.max(2, Math.floor(callKey.length * 0.2))) {
              bestDistance = distance;
              similar = endpoint;
            }
          }
        }
      }

      const hint = similar ? ` The closest route is ${similar.method} ${similar.path}.` : "";

      drafts.push({
        kind: "missing-endpoint",
        key,
        method: first.method,
        path: first.path,
        title: `No backend route for ${first.method === "UNKNOWN" ? "" : `${first.method} `}${first.path}`.replace("  ", " "),
        description: `The client calls ${first.method === "UNKNOWN" ? "" : `${first.method} `}${first.path}, but no backend route matches that path.${hint} Requests will fail with 404.`,
        callCount: calls.length,
        endpointId: similar?.id,
        evidence: [
          ...calls.slice(0, MAX_EVIDENCE_PER_SIDE).map((call) => callEvidence(call)),
          ...(similar ? [routeEvidence(similar)] : []),
        ],
        suggestion: {
          strategy: "add-backend-route",
          confidence: similar ? "medium" : "high",
          title: similar ? `Use ${similar.path} or add the missing route` : "Add the missing route",
          summary: similar
            ? `Either point the client at ${similar.method} ${similar.path}, or add a new route for ${first.path}.`
            : `Add a ${first.method === "UNKNOWN" ? "GET" : first.method} route for ${first.path}, or remove the call if the feature is gone.`,
          steps: [
            similar
              ? `Check whether ${first.path} should be ${similar.path} (a missing prefix or typo is the usual cause).`
              : "Check the path for typos and for a missing prefix such as /api.",
            "If the route should exist, add it to your router using the stub below.",
            "Mount the router (for example app.use('/api', router)) so the full path matches.",
            "Re-run the analysis to confirm the call matches.",
          ],
          patch: routeStub(first),
          suggestedPath: similar?.raw.file.rel,
          caveats: [
            "If this call goes to a service outside this repository, set the client base URL to its full address so it is skipped.",
          ],
        },
      });
    }
  }

  /* ---- unused endpoints ---- */
  if (options.includeUnused && !noBackend && !noClient) {
    for (const endpoint of endpoints) {
      if (endpoint.callers > 0) continue;
      if (endpoint.method === "OPTIONS" || endpoint.method === "HEAD") continue;
      if (!endpoint.mountConfirmed && st.opaquePrefixes.size > 0) continue;

      const quiet = QUIET_ENDPOINT.test(endpoint.path);

      drafts.push({
        kind: "unused-endpoint",
        key: endpoint.id,
        method: endpoint.method,
        path: endpoint.path,
        title: `${endpoint.method} ${endpoint.path} is never called`,
        description: `No client call in this project reaches ${endpoint.method} ${endpoint.path}. It may be dead code, or it may be used by something outside this repository (a mobile app, a webhook, another service).${
          st.unresolvedCalls > 0
            ? ` ${st.unresolvedCalls} client call(s) could not be resolved, so one of them may be the caller.`
            : ""
        }`,
        callCount: 0,
        endpointId: endpoint.id,
        scoreBoost: (quiet ? -12 : 0) + (st.unresolvedCalls > 0 ? -6 : 0),
        evidence: [routeEvidence(endpoint)],
        suggestion: {
          strategy: "remove-or-document",
          confidence: quiet ? "low" : "medium",
          title: "Remove it or document who uses it",
          summary: quiet
            ? "Health checks, webhooks and docs routes are normally called from outside the app, so this is usually fine."
            : "If nothing uses this route, delete it. If an external client does, note that next to the route so it is not removed by mistake.",
          steps: [
            "Search other repositories and API gateway logs for this path.",
            "Delete the route and its handler if nothing uses it.",
            "Otherwise add a comment naming the external caller.",
          ],
          caveats: [
            "Calls built from values the analyzer could not resolve are not counted, so a caller may exist.",
          ],
        },
      });
    }
  }

  /* ---- duplicate and shadowed routes ---- */
  const byPattern = new Map<string, FinalEndpoint[]>();
  for (const endpoint of endpoints) {
    if (endpoint.method === "ALL") continue;
    const key = `${endpoint.method} ${patternKey(endpoint.segs)}`;
    const list = byPattern.get(key) ?? [];
    list.push(endpoint);
    byPattern.set(key, list);
  }

  for (const [key, list] of byPattern) {
    const distinct = uniqueBy(list, (endpoint) => `${endpoint.raw.file.rel}:${startLineOf(endpoint.raw.regNode)}`);
    if (distinct.length < 2) continue;

    const first = distinct[0];

    drafts.push({
      kind: "duplicate-route",
      key,
      method: first.method,
      path: first.path,
      title: `${first.method} ${first.path} is defined ${distinct.length} times`,
      description: `${distinct.length} routes answer ${first.method} ${first.path}. Only the first one registered will run, so the others are unreachable and may hide a bug.`,
      callCount: first.callers,
      endpointId: first.id,
      evidence: distinct.slice(0, MAX_EVIDENCE_PER_SIDE).map((endpoint) => routeEvidence(endpoint)),
      suggestion: {
        strategy: "remove-duplicate-route",
        confidence: "high",
        title: "Keep one definition",
        summary: "Decide which handler should win, move any logic you still need into it, and delete the other registrations.",
        steps: [
          `Compare the handlers in ${distinct.map((endpoint) => endpoint.raw.file.rel).join(" and ")}.`,
          "Keep the one the client expects and merge anything unique from the others.",
          "Delete the unreachable registrations.",
        ],
        caveats: ["Routes mounted under different prefixes are not duplicates; this one resolves to the same final path."],
      },
    });
  }

  const byRouter = new Map<string, FinalEndpoint[]>();
  for (const endpoint of endpoints) {
    if (endpoint.raw.absolute || !endpoint.raw.routerId) continue;
    const list = byRouter.get(endpoint.raw.routerId) ?? [];
    list.push(endpoint);
    byRouter.set(endpoint.raw.routerId, list);
  }

  for (const list of byRouter.values()) {
    const ordered = [...list].sort((a, b) => a.raw.order - b.raw.order);

    for (let i = 0; i < ordered.length; i++) {
      const wide = ordered[i];
      if (!wide.segs.some((segment) => segment.k === "param")) continue;

      for (let j = i + 1; j < ordered.length; j++) {
        const narrow = ordered[j];

        const sameMethod = wide.method === narrow.method || wide.method === "ALL";
        const comparable =
          wide.segs.length === narrow.segs.length &&
          narrow.segs.some((segment) => segment.k === "lit") &&
          narrow.segs.every((segment) => segment.k !== "splat");

        if (!sameMethod || !comparable || wide === narrow) continue;
        if (patternKey(wide.segs) === patternKey(narrow.segs)) continue;

        const shadows = wide.segs.every((segment, index) => {
          const other = narrow.segs[index];
          if (segment.k === "param") return true;
          return segment.k === "lit" && other.k === "lit" && segment.v === other.v;
        });

        if (!shadows) continue;

        drafts.push({
          kind: "route-shadowed",
          key: `${wide.id}>${narrow.id}`,
          method: narrow.method,
          path: narrow.path,
          title: `${narrow.method} ${narrow.path} is shadowed by ${wide.path}`,
          description: `${wide.method} ${wide.path} is registered first and also matches ${narrow.path}, so the more specific route never runs.`,
          callCount: narrow.callers,
          endpointId: narrow.id,
          evidence: [routeEvidence(wide), routeEvidence(narrow)],
          suggestion: {
            strategy: "reorder-routes",
            confidence: "high",
            title: "Register the specific route first",
            summary: `Move ${narrow.path} above ${wide.path} so it is checked first.`,
            steps: [
              `Cut the ${narrow.method} ${narrow.path} registration from ${narrow.raw.file.rel}.`,
              `Paste it above ${wide.method} ${wide.path}.`,
              "Re-run the analysis.",
            ],
            caveats: [],
          },
        });
      }
    }
  }

  return { drafts, matchedCalls, unverifiable };
}

/** Compares one matched call against its endpoint and records field-level drafts. */
function compareContract(
  call: ApiCall,
  endpoint: FinalEndpoint,
  grouped: Map<string, { calls: ApiCall[]; endpoint: FinalEndpoint; draft: IssueDraft }>,
  drafts: IssueDraft[],
): void {
  const facts = endpoint.facts;
  if (!facts.resolved) return;

  const bodyReads = facts.body;
  const canCompareBody = !bodyReads.opaque && bodyReads.touched;
  const writes = call.method === "POST" || call.method === "PUT" || call.method === "PATCH";

  const push = (draft: IssueDraft, groupKey: string) => {
    const existing = grouped.get(groupKey);
    if (existing) {
      existing.calls.push(call);
      existing.draft.callCount = existing.calls.length;
      if (existing.draft.evidence.filter((item) => item.role === "frontend").length < MAX_EVIDENCE_PER_SIDE) {
        existing.draft.evidence.splice(
          existing.draft.evidence.filter((item) => item.role === "frontend").length,
          0,
          callEvidence(call, draft.evidence[0]?.highlightLines),
        );
      }
      return;
    }

    grouped.set(groupKey, { calls: [call], endpoint, draft });
    drafts.push(draft);
  };

  const target = `${endpoint.method === "ALL" ? call.method : endpoint.method} ${endpoint.path}`;

  /* ---- request body ---- */
  if (writes && !call.hasBody && canCompareBody) {
    const required = [...bodyReads.fields.entries()].filter(([, read]) => read.required);

    if (required.length > 0) {
      const names = required.map(([name]) => name);

      push(
        {
          kind: "missing-body",
          key: `${endpoint.id}|${call.id}`,
          method: call.method,
          path: call.path,
          title: `${target} needs a request body`,
          description: `The handler reads ${names.map((name) => `"${name}"`).join(", ")} from the request body, but this ${call.method} call sends no body.`,
          callCount: 1,
          endpointId: endpoint.id,
          comparison: {
            area: "body",
            clientLabel: "Client sends",
            serverLabel: "Server reads",
            rows: [...bodyReads.fields.entries()].map(([name, read]) => ({
              name,
              client: false,
              server: true,
              required: read.required,
              status: read.required ? "missing-on-client" : "optional",
            })),
          },
          evidence: [
            callEvidence(call),
            handlerEvidence(endpoint, required.map(([, read]) => read.line)),
          ],
          suggestion: {
            strategy: "update-client-payload",
            confidence: "high",
            title: "Send the body the server expects",
            summary: `Include a JSON body with ${names.join(", ")} in this request.`,
            steps: [
              `Open ${call.file.rel} at line ${call.line}.`,
              `Add a body with ${names.join(", ")}.`,
              "Set the Content-Type header to application/json if you use fetch.",
            ],
            patch: `body: JSON.stringify({ ${names.join(", ")} })`,
            caveats: [],
          },
        },
        `missing-body|${endpoint.id}|${names.join(",")}`,
      );
    }
  }

  if (call.hasBody && call.bodyKeys && canCompareBody && writes) {
    const sent = new Set(call.bodyKeys);
    const missingRequired: string[] = [];
    const missingOptional: string[] = [];

    for (const [name, read] of bodyReads.fields) {
      if (sent.has(name)) continue;
      (read.required ? missingRequired : missingOptional).push(name);
    }

    const extra = call.bodyKeys.filter((key) => !bodyReads.fields.has(key));

    const rows: FieldRow[] = [
      ...[...bodyReads.fields.entries()].map(([name, read]): FieldRow => ({
        name,
        client: sent.has(name),
        server: true,
        required: read.required,
        status: sent.has(name) ? "match" : read.required ? "missing-on-client" : "optional",
      })),
      ...extra.map((name): FieldRow => ({
        name,
        client: true,
        server: false,
        status: "missing-on-server",
      })),
    ];

    const comparison: FieldComparison = {
      area: "body",
      clientLabel: "Client sends",
      serverLabel: "Server reads",
      rows,
    };

    if (missingRequired.length > 0) {
      push(
        {
          kind: "missing-body-field",
          key: `${endpoint.id}|${call.id}`,
          method: call.method,
          path: call.path,
          title: `${target} — body is missing ${missingRequired.join(", ")}`,
          description: `The handler reads ${missingRequired.map((name) => `"${name}"`).join(", ")} from the request body, but this call does not send ${missingRequired.length === 1 ? "it" : "them"}. The handler will receive undefined.`,
          callCount: 1,
          endpointId: endpoint.id,
          comparison,
          evidence: [
            callEvidence(call, call.bodyLine ? [call.bodyLine] : undefined),
            handlerEvidence(
              endpoint,
              missingRequired.map((name) => bodyReads.fields.get(name)!.line),
            ),
          ],
          suggestion: {
            strategy: "update-client-payload",
            confidence: "high",
            title: `Send ${missingRequired.join(", ")}`,
            summary: `Add ${missingRequired.join(", ")} to the request body, or stop reading ${missingRequired.length === 1 ? "it" : "them"} on the server if ${missingRequired.length === 1 ? "it is" : "they are"} no longer needed.`,
            steps: [
              `Open ${call.file.rel} at line ${call.bodyLine ?? call.line}.`,
              `Add ${missingRequired.join(", ")} to the object you send.`,
              `Or remove the read from ${facts.file?.rel ?? endpoint.raw.file.rel} if the field was dropped on purpose.`,
              "Re-run the analysis.",
            ],
            patch: `{ ${[...call.bodyKeys, ...missingRequired].join(", ")} }`,
            caveats: [
              "A field is treated as required when the handler reads it without a default or a guard.",
            ],
          },
        },
        `missing-body-field|${endpoint.id}|${missingRequired.join(",")}`,
      );
    }

    if (extra.length > 0 && bodyReads.fields.size > 0) {
      push(
        {
          kind: "extra-body-field",
          key: `${endpoint.id}|${call.id}`,
          method: call.method,
          path: call.path,
          title: `${target} — ${extra.join(", ")} is never read`,
          description: `This call sends ${extra.map((name) => `"${name}"`).join(", ")}, but the handler never reads ${extra.length === 1 ? "it" : "them"}. The data is ignored.`,
          callCount: 1,
          endpointId: endpoint.id,
          comparison,
          evidence: [
            callEvidence(call, call.bodyLine ? [call.bodyLine] : undefined),
            handlerEvidence(endpoint, [...bodyReads.fields.values()].map((read) => read.line)),
          ],
          suggestion: {
            strategy: "update-backend-handler",
            confidence: "medium",
            title: `Read or stop sending ${extra.join(", ")}`,
            summary: `Either read ${extra.join(", ")} in the handler, or remove ${extra.length === 1 ? "it" : "them"} from the client request.`,
            steps: [
              `Decide whether the server should use ${extra.join(", ")}.`,
              `If yes, destructure ${extra.length === 1 ? "it" : "them"} from req.body in ${facts.file?.rel ?? endpoint.raw.file.rel}.`,
              `If no, remove ${extra.length === 1 ? "it" : "them"} from the object sent in ${call.file.rel}.`,
            ],
            caveats: [
              "Validation middleware or a schema may read these fields before the handler runs; the analyzer cannot see that.",
            ],
          },
        },
        `extra-body-field|${endpoint.id}|${extra.join(",")}`,
      );
    }
  }

  /* ---- query params ---- */
  const queryReads = facts.query;

  if (!call.queryOpaque && !queryReads.opaque && queryReads.touched) {
    const sent = new Set(call.queryKeys);

    const missing = [...queryReads.fields.entries()]
      .filter(([name, read]) => read.required && !sent.has(name))
      .map(([name]) => name);

    const extra = call.queryKeys.filter((key) => !queryReads.fields.has(key));

    const rows: FieldRow[] = [
      ...[...queryReads.fields.entries()].map(([name, read]): FieldRow => ({
        name,
        client: sent.has(name),
        server: true,
        required: read.required,
        status: sent.has(name) ? "match" : read.required ? "missing-on-client" : "optional",
      })),
      ...extra.map((name): FieldRow => ({
        name,
        client: true,
        server: false,
        status: "missing-on-server",
      })),
    ];

    const comparison: FieldComparison = {
      area: "query",
      clientLabel: "Client sends",
      serverLabel: "Server reads",
      rows,
    };

    if (missing.length > 0) {
      push(
        {
          kind: "missing-query-param",
          key: `${endpoint.id}|${call.id}`,
          method: call.method,
          path: call.path,
          title: `${target} — query is missing ${missing.join(", ")}`,
          description: `The handler reads ${missing.map((name) => `"${name}"`).join(", ")} from the query string, but this call does not send ${missing.length === 1 ? "it" : "them"}.`,
          callCount: 1,
          endpointId: endpoint.id,
          comparison,
          evidence: [
            callEvidence(call),
            handlerEvidence(endpoint, missing.map((name) => queryReads.fields.get(name)!.line)),
          ],
          suggestion: {
            strategy: "update-client-payload",
            confidence: "medium",
            title: `Send ${missing.join(", ")} in the query`,
            summary: `Add ${missing.join(", ")} to the request URL or params object.`,
            steps: [
              `Open ${call.file.rel} at line ${call.line}.`,
              `Add ${missing.map((name) => `${name}=...`).join("&")} to the query string, or to the params option.`,
            ],
            patch: `params: { ${[...call.queryKeys, ...missing].join(", ")} }`,
            caveats: [],
          },
        },
        `missing-query-param|${endpoint.id}|${missing.join(",")}`,
      );
    }

    if (extra.length > 0) {
      push(
        {
          kind: "extra-query-param",
          key: `${endpoint.id}|${call.id}`,
          method: call.method,
          path: call.path,
          title: `${target} — ${extra.join(", ")} is ignored`,
          description: `This call sends ${extra.map((name) => `"${name}"`).join(", ")} in the query, but the handler never reads ${extra.length === 1 ? "it" : "them"}.`,
          callCount: 1,
          endpointId: endpoint.id,
          comparison,
          evidence: [
            callEvidence(call),
            handlerEvidence(endpoint, [...queryReads.fields.values()].map((read) => read.line)),
          ],
          suggestion: {
            strategy: "update-backend-handler",
            confidence: "low",
            title: "Read it or stop sending it",
            summary: `Read ${extra.join(", ")} on the server, or remove ${extra.length === 1 ? "it" : "them"} from the client call.`,
            steps: [
              "Check whether filtering or pagination was meant to work with this parameter.",
              "Add the read in the handler, or delete the parameter from the client.",
            ],
            caveats: ["Middleware may read these before the handler runs."],
          },
        },
        `extra-query-param|${endpoint.id}|${extra.join(",")}`,
      );
    }
  }

  /* ---- response fields ---- */
  const response = facts.response;
  const known = response.objectCount >= 1 && response.unknownCount === 0 && !response.open;

  if (known && call.responsePaths.size > 0) {
    const missing: string[] = [];

    for (const fieldPath of call.responsePaths.keys()) {
      const [top, nested] = fieldPath.split(".");

      if (!response.fields.has(top)) {
        missing.push(fieldPath);
        continue;
      }

      const children = response.fields.get(top);
      if (nested && children && !children.has(nested)) missing.push(fieldPath);
    }

    if (missing.length > 0) {
      const provided = [...response.fields.keys()];

      const rows: FieldRow[] = [
        ...[...call.responsePaths.keys()].map((name): FieldRow => ({
          name,
          client: true,
          server: !missing.includes(name),
          status: missing.includes(name) ? "missing-on-server" : "match",
        })),
        ...provided
          .filter((name) => ![...call.responsePaths.keys()].some((used) => used.split(".")[0] === name))
          .map((name): FieldRow => ({
            name,
            client: false,
            server: true,
            status: "missing-on-client",
          })),
      ];

      push(
        {
          kind: "response-field-mismatch",
          key: `${endpoint.id}|${call.id}`,
          method: call.method,
          path: call.path,
          title: `${target} — response has no ${missing.join(", ")}`,
          description: `The client reads ${missing.map((name) => `"${name}"`).join(", ")} from the response, but the handler only returns ${provided.length ? provided.map((name) => `"${name}"`).join(", ") : "other data"}. The value will be undefined.`,
          callCount: 1,
          endpointId: endpoint.id,
          comparison: {
            area: "response",
            clientLabel: "Client reads",
            serverLabel: "Server returns",
            rows,
          },
          evidence: [
            callEvidence(call, missing.map((name) => call.responsePaths.get(name)!)),
            handlerEvidence(
              endpoint,
              response.firstLine ? [response.firstLine] : [],
            ),
          ],
          suggestion: {
            strategy: "align-response",
            confidence: "medium",
            title: `Return ${missing[0].split(".")[0]} or read the right field`,
            summary: `Make the response and the client agree: return ${missing.join(", ")} from the handler, or change the client to read one of ${provided.join(", ") || "the returned fields"}.`,
            steps: [
              `Open ${facts.file?.rel ?? endpoint.raw.file.rel} and check what the handler returns.`,
              `Add ${missing.join(", ")} to the response, or rename the field the client reads in ${call.file.rel}.`,
              "Re-run the analysis.",
            ],
            patch: `res.json({ ${[...provided, ...missing.map((name) => name.split(".")[0])]
              .filter((name, index, all) => all.indexOf(name) === index)
              .join(", ")} });`,
            caveats: [
              "Only object literals passed to res.json/res.send are compared. Responses built elsewhere are skipped, never guessed.",
            ],
          },
        },
        `response-field-mismatch|${endpoint.id}|${missing.join(",")}`,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Main analysis                                                             */
/* -------------------------------------------------------------------------- */

export async function analyzeApiContracts(
  projectPath: string,
  filePath?: string,
  options: {
    includeTests?: boolean;
    includeUnused?: boolean;
    pathPrefix?: string;
  } = {},
): Promise<ApiContractReport> {
  const includeTests = options.includeTests ?? false;
  const includeUnused = options.includeUnused ?? true;

  if (
    filePath !== undefined &&
    (path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes(".."))
  ) {
    throw new Error("filePath must be relative to projectPath.");
  }

  let pathPrefix = "";

  if (options.pathPrefix !== undefined && options.pathPrefix.trim() !== "") {
    pathPrefix = options.pathPrefix.trim();
    if (!/^\/?[A-Za-z0-9._~\-/:]*$/.test(pathPrefix)) {
      throw new Error("pathPrefix may only contain letters, numbers, and / . _ ~ - :");
    }
    pathPrefix = joinPaths(pathPrefix);
    if (pathPrefix === "/") pathPrefix = "";
  }

  const resolvedProject = await resolveProjectPath(projectPath);
  const root = fs.realpathSync(resolvedProject.projectPath);
  const warnings: string[] = [];

  const warn = (message: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message);
    else if (warnings.length === MAX_WARNINGS) warnings.push("Further warnings were omitted.");
  };

  const discovered = discoverSourceFiles(root);

  if (discovered.truncated) {
    warn(
      `Only the first ${MAX_FILES} source files were analyzed. Narrow the project path for complete results.`,
    );
  }

  const relative = (absolute: string) => normalizeFsPath(path.relative(root, absolute));

  const candidates = discovered.files.filter(
    (file) => includeTests || !TEST_FILE_PATTERN.test(relative(file)),
  );

  if (candidates.length === 0) {
    throw new Error(`No JavaScript or TypeScript source files were found in ${root}.`);
  }

  const ctx: Ctx = {
    root,
    files: [],
    byAbs: new Map(),
    moduleCache: new Map(),
  };

  const st: State = {
    ctx,
    endpoints: [],
    calls: [],
    edges: [],
    parents: new Map(),
    roots: new Set(),
    ownPrefix: new Map(),
    opaquePrefixes: new Set(),
    nestGlobalPrefix: "",
    rtkBase: "",
    pathPrefix,
    externalCalls: 0,
    unresolvedCalls: 0,
    unresolvedSamples: [],
    skippedRoutes: 0,
    order: 0,
    warn,
  };

  /* ---- Parse and index ---- */

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

    const sf = ts.createSourceFile(
      absolute,
      text,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(absolute),
    );

    const file: ParsedFile = {
      index: ctx.files.length,
      abs: absolute,
      rel: relative(absolute),
      text,
      sf,
      lineCount: sf.getLineAndCharacterOfPosition(text.length).line + 1,
      imports: new Map(),
      importSpecs: new Set(),
      topLevel: new Map(),
      exportedNames: new Map(),
      reexports: new Map(),
      starReexports: [],
      backendNames: new Set(),
    };

    totalLines += file.lineCount;
    ctx.files.push(file);
    indexFile(file, ctx, st);
  }

  /* ---- Pre-pass: RTK Query base URL ---- */

  for (const file of ctx.files) {
    if (!file.text.includes("fetchBaseQuery")) continue;

    let done = false;

    walk(file.sf, (node) => {
      if (done || !ts.isCallExpression(node)) return;
      if (!ts.isIdentifier(node.expression) || node.expression.text !== "fetchBaseQuery") return;

      const config = node.arguments[0];
      if (!config || !ts.isObjectLiteralExpression(config)) return;

      const resolved = baseFromConfig(config, file, ctx);
      st.rtkBase = resolved.base;
      done = true;
    });

    if (done) break;
  }

  /* ---- Discover endpoints and calls ---- */

  for (const file of ctx.files) {
    walk(file.sf, (node) => {
      if (ts.isCallExpression(node)) {
        const callee = unwrapExpr(node.expression);
        const receiver = ts.isPropertyAccessExpression(callee) ? callee.expression : undefined;
        const client = receiver ? describeClient(receiver, file, ctx) : undefined;

        // A known HTTP client is never a route registrar.
        if (!(client?.definite && ts.isPropertyAccessExpression(callee) && ROUTE_VERBS.has(callee.name.text))) {
          handleServerCall(node, file, st);
        }

        handleClientCall(node, file, st);
      } else if (ts.isPropertyAssignment(node)) {
        handleRtkQuery(node, file, st);
      } else if (ts.isVariableDeclaration(node)) {
        collectRouterOptions(node, file, st);
      }
    });
  }

  for (const file of ctx.files) {
    if (file.importSpecs.size > 0 && [...file.importSpecs].some((spec) => spec.startsWith("@nestjs/"))) {
      collectNestEndpoints(file, st);
    }
    collectNextEndpoints(file, st);
  }

  if (st.skippedRoutes > 0) {
    warn(`${st.skippedRoutes} route(s) defined with a regular expression were skipped.`);
  }

  /* ---- Expand routers into final endpoints ---- */

  const serverFiles = new Set<ParsedFile>();
  for (const raw of st.endpoints) serverFiles.add(raw.file);
  for (const file of ctx.files) {
    if ([...file.importSpecs].some((spec) => SERVER_IMPORTS.test(spec))) serverFiles.add(file);
  }

  // Calls made by server code usually go to other services.
  const clientCalls = st.calls.filter((call) => !serverFiles.has(call.file));
  st.externalCalls += st.calls.length - clientCalls.length;
  st.calls = clientCalls;

  const finalEndpoints: FinalEndpoint[] = [];
  const seenEndpoints = new Set<string>();
  const facts = new Map<string, HandlerFacts>();

  for (const raw of st.endpoints) {
    let variants: Array<{ path: string; rooted: boolean }>;

    if (raw.absolute) {
      const prefixed =
        raw.framework === "nest" && st.nestGlobalPrefix
          ? joinPaths(st.nestGlobalPrefix, raw.localPath)
          : raw.localPath;
      variants = [{ path: prefixed, rooted: true }];
    } else {
      variants = prefixesFor(raw.routerId, st).map(({ prefix, rooted }) => ({
        path: joinPaths(prefix, raw.localPath === "*" ? "/*" : raw.localPath),
        rooted,
      }));
    }

    const factKey = `${raw.file.index}:${raw.regNode.pos}:${raw.method}`;
    let handlerFacts = facts.get(factKey);

    if (!handlerFacts) {
      if (raw.nestMethod) {
        handlerFacts = analyzeNestMethod(raw.nestMethod.node, raw.nestMethod.file, ctx);
      } else if (raw.handler) {
        handlerFacts = analyzeHandler(
          raw.handler.fn,
          raw.handler.file,
          ctx,
          raw.framework === "next" ? "next" : "express",
        );
      } else {
        handlerFacts = emptyFacts();
      }
      facts.set(factKey, handlerFacts);
    }

    for (const variant of variants) {
      const full = variant.path;
      const id = shortHash(raw.file.rel, String(startLineOf(raw.regNode)), raw.method, full);

      if (seenEndpoints.has(id)) continue;
      seenEndpoints.add(id);

      finalEndpoints.push({
        id,
        method: raw.method,
        path: full,
        segs: parseRouteSegments(full),
        raw,
        facts: handlerFacts,
        mountConfirmed: raw.absolute || variant.rooted,
        callers: 0,
        issueCount: 0,
      });
    }
  }

  /* ---- Warnings about what could not be checked ---- */

  if (finalEndpoints.length === 0) {
    warn(
      "No backend routes were found, so client calls could not be checked. Run the analysis on the folder that contains your server code, or on the whole repository.",
    );
  }

  if (st.calls.length === 0) {
    warn(
      "No client API calls were found, so unused routes are not reported. This looks like a backend-only project.",
    );
  }

  if (st.unresolvedCalls > 0) {
    warn(
      `${st.unresolvedCalls} client call(s) were skipped because their URL is built from values the analyzer cannot resolve (for example ${st.unresolvedSamples.join(", ")}). Routes they use may appear unused.`,
    );
  }

  const unmounted = finalEndpoints.filter((endpoint) => !endpoint.mountConfirmed).length;
  if (unmounted > 0) {
    warn(
      `${unmounted} route(s) belong to a router that was never found mounted. They are matched by their ending only, so check their prefix.`,
    );
  }

  /* ---- Build issues ---- */

  const { drafts, matchedCalls, unverifiable } = buildIssueDrafts(st, finalEndpoints, {
    includeUnused,
  });

  if (unverifiable > 0) {
    warn(
      `${unverifiable} client call(s) go to a router the analyzer could not follow, so they were not checked.`,
    );
  }

  const issues: ContractIssue[] = drafts.map((draft) => {
    const group = KIND_GROUP[draft.kind];
    const score = Math.max(
      1,
      Math.min(
        100,
        KIND_BASE_SCORE[draft.kind] +
          Math.min(8, Math.max(0, draft.callCount - 1) * 2) +
          (draft.scoreBoost ?? 0),
      ),
    );

    if (draft.endpointId) {
      const endpoint = finalEndpoints.find((item) => item.id === draft.endpointId);
      if (endpoint) endpoint.issueCount++;
    }

    return {
      id: shortHash(draft.kind, draft.key),
      kind: draft.kind,
      group,
      severity: draft.severityOverride ?? severityFor(score),
      score,
      method: draft.method,
      path: draft.path,
      title: draft.title,
      description: draft.description,
      recommendation: draft.suggestion.summary,
      callCount: draft.callCount,
      evidence: draft.evidence,
      comparison: draft.comparison,
      suggestion: draft.suggestion,
    };
  });

  issues.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  /* ---- Totals (before any focus filter) ---- */

  const projectIssueCount = issues.length;
  const focusFile = filePath ? normalizeFsPath(filePath) : undefined;

  const scoped = focusFile
    ? issues.filter((issue) => issue.evidence.some((item) => item.filePath === focusFile))
    : issues;

  if (focusFile && !ctx.files.some((file) => file.rel === focusFile)) {
    warn(`${focusFile} was not found among the analyzed files, so no issues can include it.`);
  }

  const reported = scoped.slice(0, MAX_ISSUES);

  if (scoped.length > reported.length) {
    warn(`Showing the top ${MAX_ISSUES} of ${scoped.length} issues, ranked by impact.`);
  }

  const summary: Record<ContractSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };

  for (const issue of reported) summary[issue.severity]++;

  const severityRank: Record<ContractSeverity, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
    info: 0,
  };

  const perFile = new Map<
    string,
    { count: number; roles: Set<"frontend" | "backend">; worst: ContractSeverity }
  >();

  for (const issue of reported) {
    for (const item of uniqueBy(issue.evidence, (evidence) => `${evidence.role}:${evidence.filePath}`)) {
      const entry = perFile.get(item.filePath) ?? {
        count: 0,
        roles: new Set<"frontend" | "backend">(),
        worst: "info" as ContractSeverity,
      };
      entry.count++;
      entry.roles.add(item.role);
      if (severityRank[issue.severity] > severityRank[entry.worst]) entry.worst = issue.severity;
      perFile.set(item.filePath, entry);
    }
  }

  const hotspots: ContractHotspot[] = [...perFile.entries()]
    .map(([file, entry]) => ({
      filePath: file,
      issueCount: entry.count,
      role: (entry.roles.size > 1 ? "both" : [...entry.roles][0]) as ContractHotspot["role"],
      worstSeverity: entry.worst,
    }))
    .sort(
      (a, b) =>
        b.issueCount - a.issueCount ||
        severityRank[b.worstSeverity] - severityRank[a.worstSeverity] ||
        a.filePath.localeCompare(b.filePath),
    )
    .slice(0, MAX_HOTSPOTS);

  const endpointSummaries: ApiEndpointSummary[] = [...finalEndpoints]
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
    .slice(0, MAX_ENDPOINTS_LISTED)
    .map((endpoint) => ({
      id: endpoint.id,
      method: endpoint.method,
      path: endpoint.path,
      framework: endpoint.raw.framework,
      filePath: endpoint.raw.file.rel,
      line: startLineOf(endpoint.raw.regNode),
      symbol: symbolAt(endpoint.raw.regNode),
      handlerResolved: endpoint.facts.resolved,
      callers: endpoint.callers,
      bodyFields: [...endpoint.facts.body.fields.keys()],
      queryFields: [...endpoint.facts.query.fields.keys()],
      responseFields: [...endpoint.facts.response.fields.keys()],
      mountConfirmed: endpoint.mountConfirmed,
      issueCount: endpoint.issueCount,
    }));

  if (finalEndpoints.length > MAX_ENDPOINTS_LISTED) {
    warn(`Showing ${MAX_ENDPOINTS_LISTED} of ${finalEndpoints.length} endpoints in the API surface list.`);
  }

  const withCallers = finalEndpoints.filter((endpoint) => endpoint.callers > 0).length;
  const unusedCount = finalEndpoints.filter(
    (endpoint) =>
      endpoint.callers === 0 && endpoint.method !== "OPTIONS" && endpoint.method !== "HEAD",
  ).length;

  const frameworks = [...new Set(finalEndpoints.map((endpoint) => endpoint.raw.framework))].sort();

  return {
    success: true,
    tool: "analyze_api_contracts",
    projectPath: root,
    filePath: focusFile,
    includeTests,
    includeUnused,
    pathPrefix: pathPrefix || undefined,
    filesScanned: ctx.files.length,
    totalLines,
    frameworks,
    endpointCount: finalEndpoints.length,
    callCount: st.calls.length,
    matchedCalls,
    externalCalls: st.externalCalls,
    unresolvedCalls: st.unresolvedCalls,
    unverifiableCalls: unverifiable,
    unusedEndpoints: unusedCount,
    coveragePercentage:
      finalEndpoints.length === 0
        ? 0
        : Math.round((withCallers / finalEndpoints.length) * 1000) / 10,
    totalIssues: reported.length,
    projectIssueCount,
    mismatchIssues: reported.filter((issue) => issue.group === "mismatch").length,
    unusedIssues: reported.filter((issue) => issue.group === "unused").length,
    routeIssues: reported.filter((issue) => issue.group === "route").length,
    filesAffected: perFile.size,
    summary,
    issues: reported,
    endpoints: endpointSummaries,
    hotspots,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/*  MCP registration                                                          */
/* -------------------------------------------------------------------------- */

export function registerAnalyzeApiContractsTool(server: McpServer) {
  server.registerTool(
    "analyze_api_contracts",
    {
      description:
        "Compare what a JavaScript/TypeScript frontend calls with what the backend serves. Finds backend routes (Express, Fastify, Koa, Hono, NestJS, Next.js) and client calls (fetch, axios, ky, Angular HttpClient, SWR, RTK Query), matches them by method and path, and reports contract problems: missing routes, wrong HTTP methods, request body and query fields that do not line up, response fields the client reads but the server never returns, unused routes, and duplicate or shadowed routes. Each issue includes evidence snippets, a field comparison and a suggested fix.",
      inputSchema: z.object({
        projectPath: z
          .string()
          .describe("Absolute path to the project directory"),
        filePath: z
          .string()
          .optional()
          .describe(
            "Optional file, relative to projectPath. When set, only issues that involve this file are reported.",
          ),
        pathPrefix: z
          .string()
          .optional()
          .describe(
            "Optional prefix added to every client call, for example /api when the client base URL comes from an environment variable.",
          ),
        includeUnused: z
          .boolean()
          .optional()
          .describe("Report backend routes that no client call uses. Default true."),
        includeTests: z
          .boolean()
          .optional()
          .describe("Include test, mock and story files. Default false."),
      }),
    },
    async ({ projectPath, filePath, pathPrefix, includeUnused, includeTests }) => {
      try {
        const report = await analyzeApiContracts(projectPath, filePath, {
          pathPrefix,
          includeUnused,
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
                  tool: "analyze_api_contracts",
                  error:
                    error instanceof Error
                      ? error.message
                      : "Failed to analyze API contracts.",
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