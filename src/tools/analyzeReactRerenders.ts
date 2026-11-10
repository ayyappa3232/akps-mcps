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

type RerenderSeverity = "critical" | "high" | "medium" | "low" | "info";
type ComponentSeverity = RerenderSeverity | "none";

type RerenderCategory =
  | "loop"
  | "remount"
  | "memo"
  | "context"
  | "effects"
  | "state"
  | "lists"
  | "computation"
  | "cascade";

type RerenderRule =
  | "set-state-in-render"
  | "effect-set-state-loop"
  | "random-key"
  | "component-in-component"
  | "memo-defeated"
  | "context-value-unstable"
  | "unstable-hook-dependency"
  | "missing-deps-array"
  | "derived-state-in-effect"
  | "unused-state"
  | "too-much-state"
  | "index-key"
  | "expensive-computation"
  | "wide-cascade";

type ComponentKind = "function" | "arrow" | "memo" | "forwardRef" | "class";

type UnstableKind =
  | "object"
  | "array"
  | "function"
  | "instance"
  | "element"
  | "computed";

interface RerenderSuggestion {
  title: string;
  summary: string;
  steps: string[];
  /** Current code, shown next to `after`. */
  before?: string;
  /** Suggested replacement. Dependencies are inferred and must be reviewed. */
  after?: string;
  confidence: "high" | "medium" | "low";
  caveats: string[];
}

interface RerenderFinding {
  id: string;
  rule: RerenderRule;
  category: RerenderCategory;
  severity: RerenderSeverity;
  title: string;
  description: string;
  filePath: string;
  line: number;
  endLine: number;
  component: string;
  componentId: string;
  /** Rough number of components affected (or renders avoided by fixing it). */
  impact: number;
  /** Short facts such as the offending prop names. */
  detail: string[];
  snippet: string;
  snippetStartLine: number;
  highlightStart: number;
  highlightEnd: number;
  suggestion: RerenderSuggestion;
}

interface CascadeNode {
  name: string;
  filePath: string;
  depth: number;
  /** A memo component whose props stay stable, so the cascade stops here. */
  boundary: boolean;
  isMemo: boolean;
}

interface RenderCascade {
  /** Components that re-render when this one re-renders (boundaries excluded). */
  count: number;
  boundaries: number;
  nodes: CascadeNode[];
  truncated: boolean;
}

interface ChildEdge {
  name: string;
  componentId: string;
  filePath: string;
  line: number;
  isMemo: boolean;
  /** Props that get a new reference on every render, such as `onClick (inline function)`. */
  unstableProps: string[];
  uses: number;
}

interface ComponentRender {
  id: string;
  name: string;
  filePath: string;
  line: number;
  endLine: number;
  lines: number;
  kind: ComponentKind;
  isMemo: boolean;
  isExported: boolean;
  propsCount: number;
  stateCount: number;
  reducerCount: number;
  effectCount: number;
  stateNames: string[];
  contexts: string[];
  customHooks: string[];
  children: ChildEdge[];
  parents: string[];
  cascade: RenderCascade;
  findingCount: number;
  score: number;
  severity: ComponentSeverity;
}

interface RerenderHotspot {
  filePath: string;
  findingCount: number;
  severeCount: number;
  componentCount: number;
  worst: RerenderSeverity;
}

interface RuleCount {
  rule: RerenderRule;
  title: string;
  category: RerenderCategory;
  count: number;
}

interface RerenderReport {
  success: boolean;
  tool: "analyze_react_rerenders";
  projectPath: string;
  filePath?: string;
  minCascade: number;
  includeTests: boolean;
  filesScanned: number;
  componentsAnalyzed: number;
  memoComponents: number;
  /** Number of findings that are reported (after any file filter). */
  totalFindings: number;
  /** Findings for the whole project, before any filePath filter. */
  projectFindingCount: number;
  filesAffected: number;
  largestCascade: { component: string; filePath: string; count: number } | null;
  summary: Record<RerenderSeverity, number>;
  categories: Record<RerenderCategory, number>;
  rules: RuleCount[];
  findings: RerenderFinding[];
  components: ComponentRender[];
  hotspots: RerenderHotspot[];
  warnings: string[];
}

/* ---- Internal structures ---- */

interface ComponentDef {
  id: string;
  name: string;
  fileIndex: number;
  kind: ComponentKind;
  isMemo: boolean;
  isExported: boolean;
  /** Function whose body is the render output (the `render` method for classes). */
  fn?: ts.FunctionLikeDeclaration;
  declNode: ts.Node;
}

type ExportTarget =
  | { kind: "local"; name: string }
  | { kind: "from"; spec: string; name: string };

interface ImportBinding {
  spec: string;
  /** "default", "*" for namespace imports, or the exported name. */
  imported: string;
}

interface FileInfo {
  relPath: string;
  sourceFile: ts.SourceFile;
  lineCount: number;
  lines?: string[];
  imports: Map<string, ImportBinding>;
  exportsMap: Map<string, ExportTarget>;
  starFrom: string[];
  components: ComponentDef[];
  local: Map<string, ComponentDef>;
}

interface Registry {
  files: FileInfo[];
  fileByPath: Map<string, number>;
  defs: ComponentDef[];
  contextReaders: Map<string, Set<string>>;
}

interface UnstableInfo {
  kind: UnstableKind;
  /** Name of the local variable the value comes from, when it is not inline. */
  via?: string;
}

interface UnstableLocal {
  kind: UnstableKind;
  line: number;
  decl: ts.VariableDeclaration | ts.FunctionDeclaration;
}

interface RawEdge {
  def: ComponentDef;
  line: number;
  uses: number;
  unstable: Map<string, string>;
}

interface RawFinding extends Omit<RerenderFinding, "id" | "impact"> {
  impact: number;
  impactDef?: ComponentDef;
}

interface Analysis {
  edges: RawEdge[];
  findings: RawFinding[];
  propsCount: number;
  stateCount: number;
  reducerCount: number;
  effectCount: number;
  stateNames: string[];
  contexts: string[];
  customHooks: string[];
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
  ".tsx",
  ".ts",
  ".jsx",
  ".js",
  ".mts",
  ".mjs",
  ".cts",
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
const MAX_FINDINGS = 400;
const MAX_COMPONENTS = 500;
const MAX_CASCADE_NODES = 60;
const MAX_HOTSPOTS = 15;
const MAX_WARNINGS = 25;
const MAX_SNIPPET_LINES = 14;
const MAX_CODE_LINES = 24;
const MAX_DETAIL = 8;
const MAX_STATE_NAMES = 12;

const DEFAULT_MIN_CASCADE = 6;
const TOO_MUCH_STATE = 7;

const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);
const MEMO_HOOKS = new Set(["useMemo", "useCallback", "useImperativeHandle"]);

const BUILTIN_HOOKS = new Set([
  "useState",
  "useReducer",
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
  "useMemo",
  "useCallback",
  "useRef",
  "useContext",
  "useImperativeHandle",
  "useDeferredValue",
  "useTransition",
  "useId",
  "useSyncExternalStore",
  "useDebugValue",
  "useOptimistic",
  "useActionState",
  "useFormStatus",
  "use",
]);

const TRANSPARENT_TAGS = new Set([
  "Fragment",
  "React.Fragment",
  "Suspense",
  "React.Suspense",
  "StrictMode",
  "React.StrictMode",
  "Profiler",
  "React.Profiler",
]);

const ARRAY_PRODUCERS = new Set([
  "map",
  "filter",
  "slice",
  "concat",
  "flat",
  "flatMap",
  "toSorted",
  "toReversed",
  "toSpliced",
  "with",
]);

const COMPUTED_STATIC_CALLS = new Set([
  "Object.keys",
  "Object.values",
  "Object.entries",
  "Object.fromEntries",
  "Object.assign",
  "Array.from",
  "JSON.parse",
  "structuredClone",
]);

const RANDOM_KEY_CALLS = new Set([
  "Math.random",
  "Date.now",
  "crypto.randomUUID",
  "randomUUID",
  "uuid",
  "uuidv4",
  "nanoid",
  "uniqueId",
  "_.uniqueId",
]);

const RULES: Record<
  RerenderRule,
  { title: string; category: RerenderCategory; severity: RerenderSeverity }
> = {
  "set-state-in-render": {
    title: "State update during render",
    category: "loop",
    severity: "critical",
  },
  "effect-set-state-loop": {
    title: "Effect updates state on every render",
    category: "loop",
    severity: "critical",
  },
  "random-key": {
    title: "Random key remounts list items",
    category: "remount",
    severity: "critical",
  },
  "component-in-component": {
    title: "Component defined inside a component",
    category: "remount",
    severity: "high",
  },
  "memo-defeated": {
    title: "React.memo defeated by unstable props",
    category: "memo",
    severity: "high",
  },
  "context-value-unstable": {
    title: "Context value changes every render",
    category: "context",
    severity: "high",
  },
  "unstable-hook-dependency": {
    title: "Unstable hook dependency",
    category: "effects",
    severity: "high",
  },
  "missing-deps-array": {
    title: "Hook runs on every render",
    category: "effects",
    severity: "medium",
  },
  "derived-state-in-effect": {
    title: "Derived state set in an effect",
    category: "effects",
    severity: "medium",
  },
  "unused-state": {
    title: "State is never read",
    category: "state",
    severity: "medium",
  },
  "too-much-state": {
    title: "Many independent state variables",
    category: "state",
    severity: "low",
  },
  "index-key": {
    title: "Array index used as key",
    category: "lists",
    severity: "medium",
  },
  "expensive-computation": {
    title: "Heavy computation on every render",
    category: "computation",
    severity: "low",
  },
  "wide-cascade": {
    title: "Large re-render cascade",
    category: "cascade",
    severity: "medium",
  },
};

const SEVERITY_RANK: Record<RerenderSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

const SEVERITY_WEIGHT: Record<RerenderSeverity, number> = {
  critical: 40,
  high: 20,
  medium: 8,
  low: 3,
  info: 1,
};

const KIND_LABEL: Record<UnstableKind, string> = {
  object: "object literal",
  array: "array literal",
  function: "inline function",
  instance: "new instance",
  element: "JSX element",
  computed: "computed value",
};

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function isPascal(name: string | undefined): name is string {
  return Boolean(name) && /^[A-Z][A-Za-z0-9_$]*$/.test(name as string);
}

function toPascal(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

function scriptKindFor(file: string): ts.ScriptKind {
  const extension = path.extname(file);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    // Plain .js files in React projects usually contain JSX.
    return ts.ScriptKind.JSX;
  }
  return ts.ScriptKind.TS;
}

function skipOuter(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isFn(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function isJsxNode(node: ts.Node): boolean {
  return (
    ts.isJsxElement(node) ||
    ts.isJsxSelfClosingElement(node) ||
    ts.isJsxFragment(node)
  );
}

function containsJsx(node: ts.Node | undefined): boolean {
  if (!node) return false;
  const check = (child: ts.Node): boolean | undefined =>
    isJsxNode(child) ? true : ts.forEachChild(child, check);
  return isJsxNode(node) || Boolean(ts.forEachChild(node, check));
}

/** Visits `root` and its descendants without entering nested functions. */
function walkOwn(root: ts.Node, visit: (node: ts.Node) => void): void {
  const step = (node: ts.Node) => {
    visit(node);
    if (isFn(node)) return;
    ts.forEachChild(node, step);
  };
  step(root);
}

function walkAll(root: ts.Node, visit: (node: ts.Node) => boolean | void): void {
  const step = (node: ts.Node) => {
    if (visit(node) === false) return;
    ts.forEachChild(node, step);
  };
  step(root);
}

function lineOf(sourceFile: ts.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function startLineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return lineOf(sourceFile, node.getStart(sourceFile));
}

function endLineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return lineOf(sourceFile, Math.max(node.getStart(sourceFile), node.end - 1));
}

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

/** Removes the indentation that continuation lines inherit from the source. */
function reindent(text: string): string {
  const lines = text.split("\n");
  if (lines.length < 2) return text;

  let indent = Infinity;
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue;
    indent = Math.min(indent, line.match(/^[\t ]*/)![0].length);
  }

  if (!Number.isFinite(indent) || indent === 0) return text;
  return [
    lines[0],
    ...lines.slice(1).map((line) => line.slice(Math.min(indent, line.length))),
  ].join("\n");
}

function capLines(text: string, max = MAX_CODE_LINES): string {
  const lines = text.split("\n");
  if (lines.length <= max) return text;
  return [...lines.slice(0, max), "// …"].join("\n");
}

function indentBlock(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line === "" ? line : pad + line))
    .join("\n");
}

function calleeText(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.name)
  ) {
    const base = calleeText(expression.expression);
    return base ? `${base}.${expression.name.text}` : expression.name.text;
  }
  return "";
}

function hookNameOf(call: ts.CallExpression): string | undefined {
  const expression = call.expression;

  if (ts.isIdentifier(expression) && /^use[A-Z0-9]|^use$/.test(expression.text)) {
    return expression.text;
  }

  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "React" &&
    /^use[A-Z0-9]|^use$/.test(expression.name.text)
  ) {
    return expression.name.text;
  }

  return undefined;
}

function bindingNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return;
  }

  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    bindingNames(element.name, into);
  }
}

function isGuarded(node: ts.Node, root: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;

  while (current && current !== root) {
    if (
      ts.isIfStatement(current) ||
      ts.isConditionalExpression(current) ||
      ts.isSwitchStatement(current) ||
      (ts.isBinaryExpression(current) &&
        (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
    ) {
      return true;
    }
    current = current.parent;
  }

  return false;
}

/* -------------------------------------------------------------------------- */
/*  Discovery                                                                 */
/* -------------------------------------------------------------------------- */

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
/*  Pass 1: components, imports and exports per file                          */
/* -------------------------------------------------------------------------- */

function wrapperName(expression: ts.Expression): string {
  const text = calleeText(expression);
  if (text === "memo" || text === "React.memo") return "memo";
  if (text === "forwardRef" || text === "React.forwardRef") return "forwardRef";
  return "";
}

interface Unwrapped {
  fn?: ts.ArrowFunction | ts.FunctionExpression;
  kind: ComponentKind;
  isMemo: boolean;
  innerIdentifier?: string;
  wrapped: boolean;
}

function unwrapComponentInit(init: ts.Expression): Unwrapped | undefined {
  let expression = skipOuter(init);
  let isMemo = false;
  let kind: ComponentKind = "arrow";
  let wrapped = false;

  for (let guard = 0; guard < 4; guard++) {
    if (!ts.isCallExpression(expression)) break;

    const wrapper = wrapperName(expression.expression);
    if (!wrapper) return undefined;

    wrapped = true;
    if (wrapper === "memo") {
      isMemo = true;
      kind = "memo";
    } else if (!isMemo) {
      kind = "forwardRef";
    }

    const argument = expression.arguments[0];
    if (!argument) return undefined;
    expression = skipOuter(argument);
  }

  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    return {
      fn: expression,
      kind: wrapped ? kind : ts.isArrowFunction(expression) ? "arrow" : "function",
      isMemo,
      wrapped,
    };
  }

  if (ts.isIdentifier(expression) && wrapped) {
    return { innerIdentifier: expression.text, kind, isMemo, wrapped };
  }

  return undefined;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === kind))
  );
}

function classExtendsReact(
  node: ts.ClassDeclaration,
): "component" | "pure" | undefined {
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;

    for (const type of clause.types) {
      const text = calleeText(type.expression);
      if (text === "PureComponent" || text === "React.PureComponent") return "pure";
      if (text === "Component" || text === "React.Component") return "component";
    }
  }
  return undefined;
}

function collectFile(
  relPath: string,
  absolute: string,
  text: string,
  fileIndex: number,
  registry: Registry,
): FileInfo {
  const sourceFile = ts.createSourceFile(
    absolute,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(absolute),
  );

  const file: FileInfo = {
    relPath,
    sourceFile,
    lineCount: sourceFile.getLineAndCharacterOfPosition(text.length).line + 1,
    imports: new Map(),
    exportsMap: new Map(),
    starFrom: [],
    components: [],
    local: new Map(),
  };

  const pendingAliases: Array<{
    name: string;
    inner: string;
    isMemo: boolean;
    exported: boolean;
    node: ts.Node;
  }> = [];

  const addDef = (
    name: string,
    kind: ComponentKind,
    isMemo: boolean,
    isExported: boolean,
    fn: ts.FunctionLikeDeclaration | undefined,
    declNode: ts.Node,
  ): ComponentDef => {
    const def: ComponentDef = {
      id: createHash("sha1")
        .update(`${relPath}:${name}:${declNode.getStart(sourceFile)}`)
        .digest("hex")
        .slice(0, 10),
      name,
      fileIndex,
      kind,
      isMemo,
      isExported,
      fn,
      declNode,
    };
    file.components.push(def);
    file.local.set(name, def);
    registry.defs.push(def);
    return def;
  };

  const defaultName = () => {
    const base = path.posix.basename(relPath).replace(/\.[^.]+$/, "");
    const name = toPascal(base === "index" ? path.posix.basename(path.posix.dirname(relPath)) : base);
    return name || "Anonymous";
  };

  for (const statement of sourceFile.statements) {
    /* ---- Imports ---- */
    if (ts.isImportDeclaration(statement)) {
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const spec = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (!clause) continue;

      if (clause.name) {
        file.imports.set(clause.name.text, { spec, imported: "default" });
      }

      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          file.imports.set(clause.namedBindings.name.text, {
            spec,
            imported: "*",
          });
        } else {
          for (const element of clause.namedBindings.elements) {
            file.imports.set(element.name.text, {
              spec,
              imported: (element.propertyName ?? element.name).text,
            });
          }
        }
      }
      continue;
    }

    /* ---- Re-exports ---- */
    if (ts.isExportDeclaration(statement)) {
      const spec =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : undefined;

      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const original = (element.propertyName ?? element.name).text;
          file.exportsMap.set(
            element.name.text,
            spec
              ? { kind: "from", spec, name: original }
              : { kind: "local", name: original },
          );
        }
      } else if (!statement.exportClause && spec) {
        file.starFrom.push(spec);
      }
      continue;
    }

    /* ---- export default <expression> ---- */
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expression = skipOuter(statement.expression);

      if (ts.isIdentifier(expression)) {
        file.exportsMap.set("default", { kind: "local", name: expression.text });
        continue;
      }

      const unwrapped = unwrapComponentInit(expression);
      if (!unwrapped) continue;

      if (unwrapped.fn) {
        const name = defaultName();
        addDef(name, unwrapped.kind, unwrapped.isMemo, true, unwrapped.fn, statement);
        file.exportsMap.set("default", { kind: "local", name });
      } else if (unwrapped.innerIdentifier) {
        pendingAliases.push({
          name: "default",
          inner: unwrapped.innerIdentifier,
          isMemo: unwrapped.isMemo,
          exported: true,
          node: statement,
        });
      }
      continue;
    }

    /* ---- function Foo() {} ---- */
    if (ts.isFunctionDeclaration(statement) && statement.body) {
      const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
      const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
      const name = statement.name?.text ?? (isDefault ? defaultName() : undefined);

      if (name && isPascal(name) && containsJsx(statement.body)) {
        addDef(name, "function", false, exported, statement, statement);
        if (isDefault) file.exportsMap.set("default", { kind: "local", name });
        else if (exported) file.exportsMap.set(name, { kind: "local", name });
      }
      continue;
    }

    /* ---- class Foo extends Component {} ---- */
    if (ts.isClassDeclaration(statement)) {
      const flavor = classExtendsReact(statement);
      const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
      const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
      const name = statement.name?.text ?? (isDefault ? defaultName() : undefined);

      if (flavor && name && isPascal(name)) {
        const render = statement.members.find(
          (member): member is ts.MethodDeclaration =>
            ts.isMethodDeclaration(member) &&
            ts.isIdentifier(member.name) &&
            member.name.text === "render",
        );

        addDef(name, "class", flavor === "pure", exported, render, statement);
        if (isDefault) file.exportsMap.set("default", { kind: "local", name });
        else if (exported) file.exportsMap.set(name, { kind: "local", name });
      }
      continue;
    }

    /* ---- const Foo = () => {} / memo(...) / forwardRef(...) ---- */
    if (ts.isVariableStatement(statement)) {
      const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);

      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;

        const name = declaration.name.text;
        if (!isPascal(name)) continue;

        const unwrapped = unwrapComponentInit(declaration.initializer);
        if (!unwrapped) continue;

        if (unwrapped.fn) {
          if (!unwrapped.wrapped && !containsJsx(unwrapped.fn.body)) continue;
          addDef(name, unwrapped.kind, unwrapped.isMemo, exported, unwrapped.fn, declaration);
          if (exported) file.exportsMap.set(name, { kind: "local", name });
        } else if (unwrapped.innerIdentifier) {
          pendingAliases.push({
            name,
            inner: unwrapped.innerIdentifier,
            isMemo: unwrapped.isMemo,
            exported,
            node: declaration,
          });
        }
      }
    }
  }

  // `const Fast = memo(Slow)` and `export default memo(Slow)`.
  for (const alias of pendingAliases) {
    const target = file.local.get(alias.inner);
    if (!target) continue;

    if (alias.isMemo) target.isMemo = true;

    if (alias.name === "default") {
      file.exportsMap.set("default", { kind: "local", name: target.name });
    } else {
      file.local.set(alias.name, target);
      if (alias.exported) {
        file.exportsMap.set(alias.name, { kind: "local", name: alias.name });
      }
    }
  }

  // Remember which components read which contexts, by context name.
  for (const def of file.components) {
    if (!def.fn?.body) continue;

    walkOwn(def.fn.body, (node) => {
      if (!ts.isCallExpression(node) || hookNameOf(node) !== "useContext") return;
      const argument = node.arguments[0];
      if (!argument) return;
      const name = calleeText(argument as ts.Expression);
      if (!name) return;

      const readers = registry.contextReaders.get(name) ?? new Set<string>();
      readers.add(def.id);
      registry.contextReaders.set(name, readers);
    });
  }

  return file;
}

/* -------------------------------------------------------------------------- */
/*  Resolution (imports, barrel files, JSX tags)                              */
/* -------------------------------------------------------------------------- */

function resolveSpec(
  registry: Registry,
  fromRel: string,
  spec: string,
): number | undefined {
  const bases: string[] = [];

  if (spec.startsWith(".")) {
    bases.push(path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec)));
  } else if (spec.startsWith("@/") || spec.startsWith("~/")) {
    const rest = spec.slice(2);
    bases.push(`src/${rest}`, rest);
  } else if (spec.startsWith("src/")) {
    bases.push(spec);
  } else {
    return undefined;
  }

  for (const base of bases) {
    const direct = registry.fileByPath.get(base);
    if (direct !== undefined) return direct;

    const stripped = base.replace(/\.(m|c)?jsx?$/, "");

    for (const extension of RESOLVE_EXTENSIONS) {
      const hit = registry.fileByPath.get(`${stripped}${extension}`);
      if (hit !== undefined) return hit;
    }

    for (const extension of RESOLVE_EXTENSIONS) {
      const hit = registry.fileByPath.get(`${stripped}/index${extension}`);
      if (hit !== undefined) return hit;
    }
  }

  return undefined;
}

function resolveExport(
  registry: Registry,
  fileIndex: number,
  name: string,
  visited: Set<string> = new Set(),
  depth = 0,
): ComponentDef | undefined {
  const key = `${fileIndex}:${name}`;
  if (visited.has(key) || depth > 8) return undefined;
  visited.add(key);

  const file = registry.files[fileIndex];
  if (!file) return undefined;

  const target = file.exportsMap.get(name);

  if (target) {
    if (target.kind === "local") return file.local.get(target.name);

    const next = resolveSpec(registry, file.relPath, target.spec);
    if (next === undefined) return undefined;
    return resolveExport(registry, next, target.name, visited, depth + 1);
  }

  if (name !== "default") {
    for (const spec of file.starFrom) {
      const next = resolveSpec(registry, file.relPath, spec);
      if (next === undefined) continue;

      const hit = resolveExport(registry, next, name, visited, depth + 1);
      if (hit) return hit;
    }
  }

  return undefined;
}

function resolveTag(
  registry: Registry,
  file: FileInfo,
  tag: string,
): ComponentDef | undefined {
  if (tag.includes(".")) {
    const parts = tag.split(".");
    if (parts.length !== 2) return undefined;

    const binding = file.imports.get(parts[0]);
    if (!binding || binding.imported !== "*") return undefined;

    const index = resolveSpec(registry, file.relPath, binding.spec);
    return index === undefined
      ? undefined
      : resolveExport(registry, index, parts[1]);
  }

  const local = file.local.get(tag);
  if (local) return local;

  const binding = file.imports.get(tag);
  if (!binding) return undefined;

  const index = resolveSpec(registry, file.relPath, binding.spec);
  if (index === undefined) return undefined;

  return resolveExport(
    registry,
    index,
    binding.imported === "*" ? "default" : binding.imported,
  );
}

/* -------------------------------------------------------------------------- */
/*  Unstable value detection                                                  */
/* -------------------------------------------------------------------------- */

function unstableKindOf(
  expression: ts.Expression,
  locals: Map<string, UnstableLocal>,
  depth = 0,
): UnstableInfo | undefined {
  if (depth > 3) return undefined;
  const node = skipOuter(expression);

  if (ts.isObjectLiteralExpression(node)) return { kind: "object" };
  if (ts.isArrayLiteralExpression(node)) return { kind: "array" };
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return { kind: "function" };
  }
  if (ts.isNewExpression(node)) return { kind: "instance" };
  if (isJsxNode(node)) return { kind: "element" };

  if (ts.isIdentifier(node)) {
    const local = locals.get(node.text);
    return local ? { kind: local.kind, via: node.text } : undefined;
  }

  if (ts.isConditionalExpression(node)) {
    return (
      unstableKindOf(node.whenTrue, locals, depth + 1) ??
      unstableKindOf(node.whenFalse, locals, depth + 1)
    );
  }

  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
  ) {
    return unstableKindOf(node.right, locals, depth + 1);
  }

  if (ts.isCallExpression(node)) {
    const callee = node.expression;

    if (ts.isPropertyAccessExpression(callee)) {
      if (callee.name.text === "bind") return { kind: "function" };
      if (ARRAY_PRODUCERS.has(callee.name.text)) return { kind: "computed" };
    }

    if (COMPUTED_STATIC_CALLS.has(calleeText(callee))) return { kind: "computed" };
  }

  return undefined;
}

/* -------------------------------------------------------------------------- */
/*  Snippets and code generation                                              */
/* -------------------------------------------------------------------------- */

function fileLines(file: FileInfo): string[] {
  if (!file.lines) file.lines = file.sourceFile.text.split(/\r?\n/);
  return file.lines;
}

function buildSnippet(file: FileInfo, start: number, end: number) {
  const lines = fileLines(file);
  const first = Math.max(1, start - 2);
  const last = Math.min(
    lines.length,
    Math.min(Math.max(end, start) + 2, first + MAX_SNIPPET_LINES - 1),
  );

  return {
    snippet: dedent(lines.slice(first - 1, last)).join("\n"),
    snippetStartLine: first,
    highlightStart: Math.min(start, last),
    highlightEnd: Math.min(Math.max(end, start), last),
  };
}

function textOf(node: ts.Node, sourceFile: ts.SourceFile): string {
  return reindent(node.getText(sourceFile));
}

function formatDeps(deps: string[]): string {
  return deps.length > 0 ? `[${deps.join(", ")}]` : "[]";
}

/* -------------------------------------------------------------------------- */
/*  Pass 2: analyze one component                                             */
/* -------------------------------------------------------------------------- */

function analyzeComponent(registry: Registry, def: ComponentDef): Analysis {
  const file = registry.files[def.fileIndex];
  const sourceFile = file.sourceFile;
  const fn = def.fn;

  const analysis: Analysis = {
    edges: [],
    findings: [],
    propsCount: 0,
    stateCount: 0,
    reducerCount: 0,
    effectCount: 0,
    stateNames: [],
    contexts: [],
    customHooks: [],
  };

  if (!fn?.body) return analysis;

  const body = fn.body;
  const setters = new Set<string>();
  const stableNames = new Set<string>();
  const scopeNames = new Set<string>();
  const stateVars = new Map<
    string,
    { setter?: string; line: number; omitted: boolean }
  >();
  const unstableLocals = new Map<string, UnstableLocal>();
  const customHooks = new Set<string>();
  const contexts = new Set<string>();

  for (const parameter of fn.parameters) bindingNames(parameter.name, scopeNames);

  /* ---- Props count ---- */
  const firstParam = fn.parameters[0];
  if (firstParam) {
    if (ts.isObjectBindingPattern(firstParam.name)) {
      analysis.propsCount = firstParam.name.elements.length;
    } else if (ts.isIdentifier(firstParam.name)) {
      const identifier = firstParam.name.text;
      const names = new Set<string>();

      walkAll(body, (node) => {
        if (
          ts.isPropertyAccessExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === identifier
        ) {
          names.add(node.name.text);
        }

        if (
          ts.isVariableDeclaration(node) &&
          ts.isObjectBindingPattern(node.name) &&
          node.initializer &&
          ts.isIdentifier(node.initializer) &&
          node.initializer.text === identifier
        ) {
          for (const element of node.name.elements) {
            if (ts.isIdentifier(element.name)) names.add(element.name.text);
          }
        }
      });

      analysis.propsCount = names.size;
    }
  } else if (def.kind === "class") {
    const names = new Set<string>();
    walkAll(body, (node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
        node.expression.name.text === "props"
      ) {
        names.add(node.name.text);
      }
    });
    analysis.propsCount = names.size;
  }

  /* ---- Own-scope declarations and hooks ---- */
  const hookCalls: Array<{ call: ts.CallExpression; name: string }> = [];

  walkOwn(body, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node !== fn) {
      scopeNames.add(node.name.text);
      unstableLocals.set(node.name.text, {
        kind: "function",
        line: startLineOf(sourceFile, node),
        decl: node,
      });
      return;
    }

    if (ts.isCallExpression(node)) {
      const name = hookNameOf(node);
      if (name) {
        hookCalls.push({ call: node, name });
        if (!BUILTIN_HOOKS.has(name)) customHooks.add(name);

        if (name === "useContext" && node.arguments[0]) {
          const text = calleeText(node.arguments[0] as ts.Expression);
          if (text) contexts.add(text);
        }
      }
      return;
    }

    if (!ts.isVariableDeclaration(node)) return;

    bindingNames(node.name, scopeNames);
    const init = node.initializer && skipOuter(node.initializer);
    if (!init) return;

    if (ts.isCallExpression(init)) {
      const name = hookNameOf(init);

      if (
        (name === "useState" || name === "useReducer") &&
        ts.isArrayBindingPattern(node.name)
      ) {
        const [valueElement, setterElement] = node.name.elements;
        const setter =
          setterElement &&
          ts.isBindingElement(setterElement) &&
          ts.isIdentifier(setterElement.name)
            ? setterElement.name.text
            : undefined;

        if (setter) {
          setters.add(setter);
          stableNames.add(setter);
        }

        if (name === "useState") analysis.stateCount++;
        else analysis.reducerCount++;

        if (
          valueElement &&
          ts.isBindingElement(valueElement) &&
          ts.isIdentifier(valueElement.name)
        ) {
          stateVars.set(valueElement.name.text, {
            setter,
            line: startLineOf(sourceFile, node),
            omitted: false,
          });
          if (name === "useState" && analysis.stateNames.length < MAX_STATE_NAMES) {
            analysis.stateNames.push(valueElement.name.text);
          }
        } else if (name === "useState" && setter) {
          stateVars.set(`$omitted:${setter}`, {
            setter,
            line: startLineOf(sourceFile, node),
            omitted: true,
          });
        }
        return;
      }

      if (name === "useRef" && ts.isIdentifier(node.name)) {
        stableNames.add(node.name.text);
        return;
      }

      if (name) return;
    }

    if (ts.isIdentifier(node.name)) {
      const info = unstableKindOf(init, unstableLocals);
      if (info) {
        unstableLocals.set(node.name.text, {
          kind: info.kind,
          line: startLineOf(sourceFile, node),
          decl: node,
        });
      }
    }
  });

  analysis.contexts = [...contexts];
  analysis.customHooks = [...customHooks];
  analysis.effectCount = hookCalls.filter((hook) => EFFECT_HOOKS.has(hook.name)).length;

  /* ---- Helpers bound to this component ---- */

  const makeFinding = (
    rule: RerenderRule,
    anchor: ts.Node,
    overrides: {
      severity?: RerenderSeverity;
      title?: string;
      description: string;
      detail?: string[];
      suggestion: RerenderSuggestion;
      impact?: number;
      impactDef?: ComponentDef;
      endAnchor?: ts.Node;
    },
  ): RawFinding => {
    const start = startLineOf(sourceFile, anchor);
    const end = endLineOf(sourceFile, overrides.endAnchor ?? anchor);
    const meta = RULES[rule];

    return {
      rule,
      category: meta.category,
      severity: overrides.severity ?? meta.severity,
      title: overrides.title ?? meta.title,
      description: overrides.description,
      filePath: file.relPath,
      line: start,
      endLine: Math.max(start, end),
      component: def.name,
      componentId: def.id,
      impact: overrides.impact ?? 1,
      impactDef: overrides.impactDef,
      detail: (overrides.detail ?? []).slice(0, MAX_DETAIL),
      ...buildSnippet(file, start, Math.max(start, Math.min(end, start + 6))),
      suggestion: overrides.suggestion,
    };
  };

  const inferDeps = (expression: ts.Node): string[] => {
    const declaredInside = new Set<string>();
    const used: string[] = [];

    walkAll(expression, (node) => {
      if (ts.isParameter(node)) bindingNames(node.name, declaredInside);
      if (ts.isVariableDeclaration(node)) bindingNames(node.name, declaredInside);
      if (ts.isFunctionDeclaration(node) && node.name) declaredInside.add(node.name.text);
      if (ts.isTypeNode(node)) return false;
    });

    walkAll(expression, (node) => {
      if (ts.isTypeNode(node)) return false;
      if (!ts.isIdentifier(node)) return;

      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.name === node) return;
      if (ts.isPropertyAssignment(parent) && parent.name === node) return;
      if (ts.isJsxAttribute(parent) && parent.name === node) return;
      if (ts.isBindingElement(parent) && parent.propertyName === node) return;
      if (ts.isParameter(parent) && parent.name === node) return;

      const name = node.text;
      if (
        scopeNames.has(name) &&
        !stableNames.has(name) &&
        !declaredInside.has(name) &&
        !used.includes(name)
      ) {
        used.push(name);
      }
    });

    return used;
  };

  const jsxLocal = (name: string) => unstableLocals.get(name);

  const wrapLocal = (name: string): string | undefined => {
    const local = jsxLocal(name);
    if (!local) return undefined;

    const decl = local.decl;
    const deps = formatDeps(inferDeps(ts.isVariableDeclaration(decl) ? decl.initializer ?? decl : decl));

    if (ts.isFunctionDeclaration(decl)) {
      const expressionText = textOf(decl, sourceFile).replace(/^(async\s+)?function\s+\w+/, (m) =>
        m.replace(/\s+\w+$/, ""),
      );
      return `const ${name} = useCallback(${expressionText}, ${deps});`;
    }

    const init = decl.initializer ? skipOuter(decl.initializer) : undefined;
    if (!init) return undefined;

    const text = textOf(init, sourceFile);
    return ts.isArrowFunction(init) || ts.isFunctionExpression(init)
      ? `const ${name} = useCallback(${text}, ${deps});`
      : `const ${name} = useMemo(() => (${text}), ${deps});`;
  };

  const hoistFor = (
    propName: string,
    expression: ts.Expression,
    info: UnstableInfo,
  ): { declaration?: string; replacement: string } => {
    if (info.via) {
      return { replacement: `{${info.via}}` };
    }

    const deps = formatDeps(inferDeps(expression));
    const text = textOf(skipOuter(expression), sourceFile);

    if (info.kind === "function") {
      const name = /^on[A-Z]/.test(propName)
        ? `handle${propName.slice(2)}`
        : `${propName}Handler`;
      return {
        declaration: `const ${name} = useCallback(${text}, ${deps});`,
        replacement: `{${name}}`,
      };
    }

    const name = `memoized${toPascal(propName)}`;
    return {
      declaration: `const ${name} = useMemo(() => (${text}), ${deps});`,
      replacement: `{${name}}`,
    };
  };

  /* ---- Rule: setState called while rendering ---- */
  walkOwn(body, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isIdentifier(node.expression) ||
      !setters.has(node.expression.text)
    ) {
      return;
    }

    if (isGuarded(node, body)) return;

    const setter = node.expression.text;
    analysis.findings.push(
      makeFinding("set-state-in-render", node, {
        title: `${setter} is called while rendering`,
        description: `${setter}(…) runs on every render of ${def.name}. Each call schedules another render immediately, so the component re-renders in a loop until React throws "Too many re-renders".`,
        detail: [`${setter}(…) in the component body`],
        suggestion: {
          title: "Move the update out of the render phase",
          summary:
            "Update state from an event handler or an effect, or compute the value while rendering instead of storing it.",
          steps: [
            `If this is a reaction to a user action, call ${setter} inside the event handler.`,
            "If it reacts to a prop or state change, compute the value during render or use useMemo.",
            `If you really need to adjust state while rendering, guard the call with a condition that becomes false after the update.`,
          ],
          before: textOf(node, sourceFile),
          after: `const onChange = () => ${textOf(node, sourceFile)};\n// …\n<button onClick={onChange} />`,
          confidence: "high",
          caveats: [],
        },
      }),
    );
  });

  /* ---- Rules on hooks ---- */
  for (const { call, name } of hookCalls) {
    const isEffect = EFFECT_HOOKS.has(name);
    const isMemoHook = MEMO_HOOKS.has(name);
    if (!isEffect && !isMemoHook) continue;

    const callbackIndex = name === "useImperativeHandle" ? 1 : 0;
    const depsIndex = callbackIndex + 1;

    const callback = call.arguments[callbackIndex] && skipOuter(call.arguments[callbackIndex]);
    const callbackFn =
      callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
        ? callback
        : undefined;
    const depsNode = call.arguments[depsIndex] && skipOuter(call.arguments[depsIndex]);
    const depsArray =
      depsNode && ts.isArrayLiteralExpression(depsNode) ? depsNode : undefined;
    const hasDepsArgument = call.arguments.length > depsIndex;

    // Direct, synchronous setter calls inside the effect body.
    let setterCall: ts.CallExpression | undefined;
    let setterGuarded = true;
    if (isEffect && callbackFn) {
      walkOwn(callbackFn.body, (node) => {
        if (
          !setterCall ||
          (setterGuarded && !isGuarded(node, callbackFn.body))
        ) {
          if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            setters.has(node.expression.text)
          ) {
            const guarded = isGuarded(node, callbackFn.body);
            if (!setterCall || (setterGuarded && !guarded)) {
              setterCall = node;
              setterGuarded = guarded;
            }
          }
        }
      });
    }

    const emptyCallback =
      callbackFn &&
      ts.isBlock(callbackFn.body) &&
      callbackFn.body.statements.length === 0;

    /* -- No dependency array -- */
    if (!hasDepsArgument && name !== "useImperativeHandle" && !emptyCallback) {
      if (isEffect && setterCall) {
        const setter = (setterCall as ts.CallExpression).expression.getText(sourceFile);
        analysis.findings.push(
          makeFinding("effect-set-state-loop", call, {
            severity: setterGuarded ? "high" : "critical",
            title: `${name} calls ${setter} on every render`,
            description: `${name} has no dependency array, so it runs after every render. It calls ${setter}, which renders the component again and runs the effect again${
              setterGuarded
                ? ". The call sits behind a condition, so the loop only continues while that condition stays true."
                : ", a render loop unless React bails out because the value did not change."
            }`,
            detail: [`${setter}(…) inside ${name}`, "no dependency array"],
            endAnchor: callbackFn?.body,
            suggestion: {
              title: "Add a dependency array",
              summary:
                "List the values the effect reads so it only runs when they change. Use [] to run once on mount.",
              steps: [
                `Add a second argument to ${name} with the props and state it reads.`,
                `If ${setter} computes a value from them, compute it during render (or useMemo) instead.`,
                "Run the exhaustive-deps lint rule to confirm the list.",
              ],
              before: capLines(textOf(call, sourceFile), 12),
              after: capLines(
                textOf(call, sourceFile).replace(/\)\s*;?\s*$/, `, ${formatDeps(inferDeps(callbackFn?.body ?? call))})`),
                12,
              ),
              confidence: "high",
              caveats: [
                "If the state always gets the same primitive value, React skips the extra render and the loop stops after one pass.",
                "If the effect updates a value that is also in its own dependency list, it still loops. Use a functional update (setX(prev => …)) or move the update into an event handler.",
              ],
            },
          }),
        );
      } else {
        analysis.findings.push(
          makeFinding("missing-deps-array", call, {
            severity: isEffect ? "medium" : "low",
            title: `${name} has no dependency array`,
            description: isEffect
              ? `${name} runs after every render of ${def.name}, so any subscription, request or timer inside it is set up again each time.`
              : `${name} without a dependency array recomputes on every render, so it never caches anything.`,
            detail: [`${name}(…) with one argument`],
            endAnchor: callbackFn?.body,
            suggestion: {
              title: "Add a dependency array",
              summary: isEffect
                ? "Pass the values the effect depends on as the second argument."
                : "Pass the values the callback depends on, or remove the hook if no caching is needed.",
              steps: [
                `Add a second argument to ${name}.`,
                "Include every prop, state value and derived value used inside the callback.",
                "Use [] only when the callback reads nothing that changes.",
              ],
              before: capLines(textOf(call, sourceFile), 12),
              after: capLines(
                textOf(call, sourceFile).replace(/\)\s*;?\s*$/, `, ${formatDeps(inferDeps(callbackFn?.body ?? call))})`),
                12,
              ),
              confidence: "medium",
              caveats: ["Dependencies are inferred from the code. Check them with the exhaustive-deps lint rule."],
            },
          }),
        );
      }
      continue;
    }

    if (!depsArray) continue;

    /* -- Unstable dependencies -- */
    const unstable: Array<{ name: string; info: UnstableInfo; text: string }> = [];
    for (const element of depsArray.elements) {
      if (ts.isSpreadElement(element)) continue;
      const info = unstableKindOf(element, unstableLocals);
      if (info) {
        unstable.push({ name: element.getText(sourceFile), info, text: element.getText(sourceFile) });
      }
    }

    if (unstable.length > 0) {
      const loops = Boolean(setterCall) && !setterGuarded;
      const labels = unstable.map(
        (item) => `${item.name} (${item.info.via ? "local " : ""}${KIND_LABEL[item.info.kind]})`,
      );
      const firstLocal = unstable.find((item) => item.info.via);
      const wrapped = firstLocal ? wrapLocal(firstLocal.info.via!) : undefined;

      analysis.findings.push(
        makeFinding("unstable-hook-dependency", depsArray, {
          severity: loops ? "critical" : "high",
          title: `${name} depends on a value that changes every render`,
          description: isEffect
            ? `${unstable.map((item) => item.name).join(", ")} ${
                unstable.length === 1 ? "is" : "are"
              } created again on each render, so ${name} runs after every render of ${def.name}.${
                loops ? " The effect also updates state, which makes this a render loop." : ""
              }`
            : `${unstable.map((item) => item.name).join(", ")} ${
                unstable.length === 1 ? "is" : "are"
              } created again on each render, so ${name} never returns a cached value.`,
          detail: labels,
          impact: 1,
          suggestion: {
            title: "Stabilize the dependency",
            summary:
              "Wrap the value in useMemo or useCallback, move it outside the component, or depend on the primitives inside it.",
            steps: [
              "If the value does not use props or state, move it to module scope.",
              "Otherwise wrap it in useMemo (objects, arrays) or useCallback (functions).",
              "Or list only the primitive fields the hook reads, such as user.id instead of user.",
            ],
            before: firstLocal
              ? capLines(
                  textOf(
                    (() => {
                      const decl = jsxLocal(firstLocal.info.via!)!.decl;
                      return ts.isVariableDeclaration(decl) && ts.isVariableDeclarationList(decl.parent) && ts.isVariableStatement(decl.parent.parent)
                        ? decl.parent.parent
                        : decl;
                    })(),
                    sourceFile,
                  ),
                )
              : capLines(textOf(call, sourceFile), 12),
            after: wrapped ? capLines(wrapped) : undefined,
            confidence: firstLocal ? "high" : "medium",
            caveats: [
              "Dependencies are inferred from the code. Check them with the exhaustive-deps lint rule.",
            ],
          },
        }),
      );
      continue;
    }

    /* -- Derived state set in an effect -- */
    if (
      isEffect &&
      callbackFn &&
      ts.isBlock(callbackFn.body) &&
      depsArray.elements.length > 0 &&
      callbackFn.body.statements.length > 0 &&
      callbackFn.body.statements.every(
        (statement) =>
          ts.isExpressionStatement(statement) &&
          ts.isCallExpression(statement.expression) &&
          ts.isIdentifier(statement.expression.expression) &&
          setters.has(statement.expression.expression.text),
      )
    ) {
      const calls = callbackFn.body.statements.map(
        (statement) =>
          ((statement as ts.ExpressionStatement).expression as ts.CallExpression)
            .expression.getText(sourceFile),
      );

      analysis.findings.push(
        makeFinding("derived-state-in-effect", call, {
          title: `${[...new Set(calls)].join(", ")} set from an effect`,
          description: `${name} only copies values into state. Each change renders ${def.name} twice: once with stale state, then again after the effect updates it.`,
          detail: [`${[...new Set(calls)].join(", ")} called in ${name}`, `deps: ${depsArray.getText(sourceFile)}`],
          endAnchor: callbackFn.body,
          suggestion: {
            title: "Compute the value during render",
            summary:
              "Derive the value from props and state directly, or with useMemo when the work is expensive. Remove the extra state and the effect.",
            steps: [
              "Replace the state variable with a plain const computed from the same inputs.",
              "Delete the effect and the state setter.",
              "If the state should reset when an id changes, give the component a key={id} instead.",
            ],
            before: capLines(textOf(call, sourceFile), 12),
            after: `const derived = useMemo(() => /* compute from ${depsArray.elements
              .map((element) => element.getText(sourceFile))
              .join(", ")} */, ${depsArray.getText(sourceFile)});`,
            confidence: "medium",
            caveats: [
              "Keep the effect if it resets state in response to an external event rather than deriving a value.",
            ],
          },
        }),
      );
    }
  }

  /* ---- Rule: state that is never read ---- */
  if (stateVars.size > 0) {
    const counts = new Map<string, number>();
    walkAll(body, (node) => {
      if (ts.isIdentifier(node)) {
        counts.set(node.text, (counts.get(node.text) ?? 0) + 1);
      }
    });

    for (const [key, state] of stateVars) {
      if (!state.setter) continue;
      const setterUses = (counts.get(state.setter) ?? 0) - 1;
      if (setterUses < 1) continue;

      const valueName = state.omitted ? undefined : key;
      const valueUses = valueName ? (counts.get(valueName) ?? 0) - 1 : 0;
      if (valueUses > 0) continue;

      const declaration = hookCalls.find(
        (hook) =>
          hook.name === "useState" &&
          hook.call.parent &&
          ts.isVariableDeclaration(hook.call.parent) &&
          startLineOf(sourceFile, hook.call.parent) === state.line,
      );

      const anchor = declaration?.call.parent ?? body;
      const label = valueName ?? state.setter;

      analysis.findings.push(
        makeFinding("unused-state", anchor, {
          severity: state.omitted ? "low" : "medium",
          title: `${label} is written but never read`,
          description: `${state.setter} is called, but the state value is never used while rendering. Every update still re-renders ${def.name} (and its children) for no visible change.`,
          detail: [`${state.setter} called ${setterUses} time${setterUses === 1 ? "" : "s"}`],
          suggestion: {
            title: "Store it in a ref",
            summary:
              "A ref keeps a mutable value between renders without triggering a render when it changes.",
            steps: [
              "Replace useState with useRef.",
              `Assign to ref.current instead of calling ${state.setter}.`,
              "Keep useState only if the value is shown in the UI or used in an effect dependency.",
            ],
            before: declaration ? textOf(declaration.call.parent!, sourceFile) : undefined,
            after: `const ${valueName ?? "value"}Ref = useRef(/* initial value */);\n// ${valueName ?? "value"}Ref.current = nextValue;`,
            confidence: "medium",
            caveats: [
              state.omitted
                ? "The value is skipped on purpose here. If the setter is only used with an updater function (setX(prev => …)), the state still works as an accumulator, but it re-renders without showing anything."
                : "If a custom hook or child reads this state through context, keep it as state.",
            ],
          },
        }),
      );
    }
  }

  /* ---- Rule: too much state ---- */
  if (analysis.stateCount >= TOO_MUCH_STATE) {
    analysis.findings.push(
      makeFinding("too-much-state", fn.name ?? def.declNode, {
        title: `${def.name} keeps ${analysis.stateCount} separate state values`,
        description: `Each setter can re-render ${def.name} and everything below it. Unrelated values that change at different times make that more frequent.`,
        detail: analysis.stateNames,
        suggestion: {
          title: "Group or split the state",
          summary:
            "Put values that change together in one reducer or object, and move independent values into the child component that uses them.",
          steps: [
            "Group fields that always change together into useReducer.",
            "Move state used by only one part of the UI into that child component.",
            "Keep rarely-changing configuration out of the component that changes often.",
          ],
          confidence: "low",
          caveats: ["A long list of state values is not always a problem. Look at how often each one changes."],
        },
      }),
    );
  }

  /* ---- Rule: expensive computation during render ---- */
  walkOwn(body, (node) => {
    if (!ts.isVariableDeclaration(node) || !node.initializer) return;
    const init = skipOuter(node.initializer);
    if (isFn(init)) return;
    if (ts.isCallExpression(init) && hookNameOf(init)) return;

    let cost = 0;
    const methods: string[] = [];
    walkOwn(init, (child) => {
      if (!ts.isCallExpression(child)) return;
      const callee = child.expression;
      const text = calleeText(callee);
      const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : "";

      const weight =
        method === "sort" || method === "toSorted"
          ? 3
          : method === "reduce" || method === "flatMap"
            ? 2
            : method === "filter" || method === "map" || method === "find" || method === "some" || method === "every"
              ? 1
              : text === "JSON.parse" || text === "JSON.stringify" || text === "structuredClone"
                ? 3
                : 0;

      if (weight > 0) {
        cost += weight;
        methods.push(method || text);
      }
    });

    if (cost < 3) return;

    const name = ts.isIdentifier(node.name) ? node.name.text : "value";
    const deps = formatDeps(inferDeps(init));
    const text = textOf(init, sourceFile);

    analysis.findings.push(
      makeFinding("expensive-computation", node, {
        severity: cost >= 5 ? "medium" : "low",
        title: `${name} is recalculated on every render`,
        description: `${def.name} runs ${[...new Set(methods)].join(", ")} again on each render, even when the inputs have not changed.`,
        detail: [`${methods.length} array or parsing call${methods.length === 1 ? "" : "s"}`, `cost score ${cost}`],
        suggestion: {
          title: "Cache it with useMemo",
          summary:
            "Wrap the calculation in useMemo so it only runs when its inputs change.",
          steps: [
            "Wrap the expression in useMemo.",
            "Pass the values it reads as the dependency array.",
            "Measure first. For small lists the plain version may be faster.",
          ],
          before: capLines(
            textOf(
              ts.isVariableDeclarationList(node.parent) &&
                ts.isVariableStatement(node.parent.parent) &&
                node.parent.declarations.length === 1
                ? node.parent.parent
                : node,
              sourceFile,
            ),
            12,
          ),
          after: capLines(`const ${name} = useMemo(() => (${text}), ${deps});`, 12),
          confidence: "medium",
          caveats: [
            "useMemo has its own cost. Keep the plain code when the list is small or the component rarely re-renders.",
            "Dependencies are inferred from the code. Check them with the exhaustive-deps lint rule.",
          ],
        },
      }),
    );
  });

  /* ---- JSX analysis (render output, including callbacks inside it) ---- */

  const nestedComponents = new Map<string, ts.Node>();
  const usedTags = new Set<string>();
  const edges = new Map<string, RawEdge>();

  const classifyKey = (
    attribute: ts.JsxAttribute,
    element: ts.Node,
  ) => {
    const initializer = attribute.initializer;
    if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression) return;
    const expression = skipOuter(initializer.expression);

    const callName = ts.isCallExpression(expression) ? calleeText(expression.expression) : "";

    if (callName && RANDOM_KEY_CALLS.has(callName)) {
      analysis.findings.push(
        makeFinding("random-key", attribute, {
          title: `key uses ${callName}()`,
          description: `A new key on every render makes React throw away each item and mount a new one, so the list loses state, focus and animations and does the most work possible.`,
          detail: [`key={${expression.getText(sourceFile)}}`],
          impact: 1,
          suggestion: {
            title: "Use a stable id",
            summary:
              "Use an id that belongs to the data, or generate ids once when the data is created.",
            steps: [
              "Use a unique field from the item, such as item.id.",
              "If items have no id, assign one when you create them, not while rendering.",
            ],
            before: attribute.getText(sourceFile),
            after: "key={item.id}",
            confidence: "high",
            caveats: [],
          },
        }),
      );
      return;
    }

    // key={index} inside .map((item, index) => …)
    let current: ts.Node | undefined = element.parent;
    let indexName: string | undefined;

    while (current && current !== body) {
      if (
        isFn(current) &&
        current.parameters.length >= 2 &&
        ts.isIdentifier(current.parameters[1].name) &&
        current.parent &&
        ts.isCallExpression(current.parent) &&
        ts.isPropertyAccessExpression(current.parent.expression) &&
        ["map", "flatMap", "filter", "forEach"].includes(current.parent.expression.name.text)
      ) {
        indexName = (current.parameters[1].name as ts.Identifier).text;
        break;
      }
      current = current.parent;
    }

    if (!indexName) return;

    let usesIndex = false;
    let usesProperty = false;
    walkAll(expression, (node) => {
      if (ts.isIdentifier(node) && node.text === indexName) usesIndex = true;
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        usesProperty = true;
      }
    });

    if (!usesIndex || usesProperty) return;

    // `key={index}` is the real problem. A template that mixes the index with
    // other data is only unstable when the list is reordered.
    const pureIndex = ts.isIdentifier(expression) && expression.text === indexName;

    analysis.findings.push(
      makeFinding("index-key", attribute, {
        severity: pureIndex ? "medium" : "low",
        title: `key uses the array index (${indexName})`,
        description: `When the list is sorted, filtered or has items inserted, indexes move to different items. React then updates or re-renders the wrong rows and can keep stale state in them.`,
        detail: [`key={${expression.getText(sourceFile)}}`],
        suggestion: {
          title: "Use a stable id",
          summary: "Key each item by an id that stays with the item.",
          steps: [
            "Use a unique field from the item, such as item.id.",
            "Keep index keys only for static lists that are never reordered or filtered.",
          ],
          before: attribute.getText(sourceFile),
          after: "key={item.id}",
          confidence: "medium",
          caveats: ["Index keys are fine for lists that never change order."],
        },
      }),
    );
  };

  const handleProvider = (
    opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
    tag: string,
  ) => {
    for (const attribute of opening.attributes.properties) {
      if (
        !ts.isJsxAttribute(attribute) ||
        attribute.name.getText(sourceFile) !== "value" ||
        !attribute.initializer ||
        !ts.isJsxExpression(attribute.initializer) ||
        !attribute.initializer.expression
      ) {
        continue;
      }

      const expression = attribute.initializer.expression;
      const info = unstableKindOf(expression, unstableLocals);
      if (!info) continue;

      const contextName = tag.replace(/\.Provider$/, "");
      const readers = registry.contextReaders.get(contextName)?.size ?? 0;
      const hoisted = hoistFor("value", expression, info);
      const original = opening.getText(sourceFile);

      analysis.findings.push(
        makeFinding("context-value-unstable", attribute, {
          title: `${tag} gets a new value on every render`,
          description: `The value is ${info.via ? `the local ${info.via}, which is` : "an"} ${KIND_LABEL[info.kind]} created during render. Every time ${def.name} renders, all components that read ${contextName} re-render too, even through memo.${
            readers > 0 ? ` ${readers} component${readers === 1 ? "" : "s"} read it.` : ""
          }`,
          detail: [`value (${info.via ? "local " : ""}${KIND_LABEL[info.kind]})`, ...(readers > 0 ? [`${readers} reader${readers === 1 ? "" : "s"}`] : [])],
          impact: Math.max(1, readers),
          suggestion: {
            title: "Memoize the context value",
            summary:
              "Create the value once with useMemo (and useCallback for functions inside it) so consumers only update when the data changes.",
            steps: [
              "Build the value with useMemo and list the data it contains as dependencies.",
              "Wrap functions inside the value with useCallback.",
              "Consider splitting rarely-changing and frequently-changing data into two contexts.",
            ],
            before: capLines(original, 10),
            after: info.via
              ? capLines(wrapLocal(info.via) ?? `<${tag} value={${info.via}}>`, 12)
              : capLines(
                  `${hoisted.declaration ?? ""}\n\n${original.replace(
                    attribute.getText(sourceFile),
                    `value=${hoisted.replacement}`,
                  )}`.trim(),
                  14,
                ),
            confidence: "high",
            caveats: [
              "Dependencies are inferred from the code. Check them with the exhaustive-deps lint rule.",
            ],
          },
        }),
      );
    }
  };

  const handleComponentElement = (
    opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
    tag: string,
  ) => {
    const target = resolveTag(registry, file, tag);
    const unstableProps: Array<{
      name: string;
      info: UnstableInfo;
      expression: ts.Expression;
      attribute: ts.JsxAttribute;
    }> = [];

    for (const attribute of opening.attributes.properties) {
      if (!ts.isJsxAttribute(attribute)) continue;

      const name = attribute.name.getText(sourceFile);
      if (name === "key" || name === "ref") continue;
      if (
        !attribute.initializer ||
        !ts.isJsxExpression(attribute.initializer) ||
        !attribute.initializer.expression
      ) {
        continue;
      }

      const info = unstableKindOf(attribute.initializer.expression, unstableLocals);
      if (info) {
        unstableProps.push({
          name,
          info,
          expression: attribute.initializer.expression,
          attribute,
        });
      }
    }

    // JSX children are a new element tree on every render.
    let passesChildren = false;
    if (ts.isJsxOpeningElement(opening) && ts.isJsxElement(opening.parent)) {
      passesChildren = opening.parent.children.some(
        (child) =>
          ts.isJsxElement(child) ||
          ts.isJsxSelfClosingElement(child) ||
          ts.isJsxFragment(child) ||
          (ts.isJsxExpression(child) && child.expression !== undefined),
      );
    }

    const labels = unstableProps.map(
      (item) =>
        `${item.name} (${item.info.via ? `local ${item.info.via}` : KIND_LABEL[item.info.kind]})`,
    );
    if (passesChildren) labels.push("children (JSX)");

    if (target) {
      const edge = edges.get(target.id) ?? {
        def: target,
        line: startLineOf(sourceFile, opening),
        uses: 0,
        unstable: new Map<string, string>(),
      };

      edge.uses++;
      for (const label of labels) {
        const propName = label.split(" ")[0];
        edge.unstable.set(propName, label);
      }
      edges.set(target.id, edge);
    }

    if (target?.isMemo && labels.length > 0) {
      const lines: string[] = [];
      let replaced = opening.getText(sourceFile);
      const declarations: string[] = [];

      for (const item of unstableProps.slice(0, 4)) {
        const hoisted = hoistFor(item.name, item.expression, item.info);
        if (hoisted.declaration) declarations.push(hoisted.declaration);
        replaced = replaced.replace(
          item.attribute.initializer!.getText(sourceFile),
          hoisted.replacement,
        );
      }

      lines.push(...declarations, ...(declarations.length ? [""] : []), replaced);

      analysis.findings.push(
        makeFinding("memo-defeated", opening, {
          title: `${target.name} is memoized but gets new props every render`,
          description: `${target.name} is wrapped in memo, but ${def.name} passes ${labels
            .map((label) => label.split(" ")[0])
            .join(", ")} as ${labels.length === 1 ? "a new reference" : "new references"} on each render. React.memo compares props by reference, so it re-renders every time and the memo does nothing.`,
          detail: labels,
          impactDef: target,
          endAnchor: opening,
          suggestion: {
            title: "Pass stable references",
            summary:
              "Create each prop once with useCallback or useMemo (or move it out of the component) so memo can skip renders.",
            steps: [
              "Wrap inline functions in useCallback and objects, arrays or computed values in useMemo.",
              "Move values that never change to module scope.",
              passesChildren
                ? "For children, pass them from a parent that does not re-render, or accept that this memo cannot help."
                : "Import useCallback and useMemo from react.",
            ],
            before: capLines(opening.getText(sourceFile), 12),
            after: capLines(lines.join("\n"), MAX_CODE_LINES),
            confidence: unstableProps.length > 0 ? "high" : "low",
            caveats: [
              "Dependencies are inferred from the code. Check them with the exhaustive-deps lint rule.",
              ...(passesChildren
                ? ["JSX children create new elements each render, so memo only helps if the parent itself renders rarely."]
                : []),
            ],
          },
        }),
      );
    }
  };

  const visitJsx = (node: ts.Node): boolean | void => {
    // Components declared inside the render are noted and not analyzed as part of this one.
    if (
      node !== fn &&
      ts.isFunctionDeclaration(node) &&
      isPascal(node.name?.text) &&
      containsJsx(node.body)
    ) {
      nestedComponents.set(node.name!.text, node);
      return false;
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isPascal(node.name.text) &&
      node.initializer
    ) {
      const init = skipOuter(node.initializer);
      if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && containsJsx(init.body)) {
        nestedComponents.set(node.name.text, node);
        return false;
      }
    }

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sourceFile);

      for (const attribute of node.attributes.properties) {
        if (ts.isJsxAttribute(attribute) && attribute.name.getText(sourceFile) === "key") {
          classifyKey(attribute, node);
        }
      }

      if (/^[A-Z]/.test(tag)) {
        usedTags.add(tag);

        if (/\.Provider$/.test(tag)) {
          handleProvider(node, tag);
        } else if (!/\.Consumer$/.test(tag) && !TRANSPARENT_TAGS.has(tag)) {
          handleComponentElement(node, tag);
        }
      }
    }
  };

  walkAll(body, visitJsx);

  for (const [name, declaration] of nestedComponents) {
    if (!usedTags.has(name)) continue;

    const anchor = ts.isVariableDeclaration(declaration) ? declaration : declaration;
    analysis.findings.push(
      makeFinding("component-in-component", anchor, {
        title: `${name} is defined inside ${def.name}`,
        description: `${name} is a new component type on every render of ${def.name}. React sees a different component each time, unmounts the old one and mounts a new one, so its state, focus and DOM are lost on each render.`,
        detail: [`${name} declared in ${def.name}`],
        impact: 1,
        endAnchor: anchor,
        suggestion: {
          title: "Move it out of the component",
          summary:
            "Declare the component at module level and pass what it needs as props.",
          steps: [
            `Move ${name} above ${def.name}, outside any function.`,
            "Replace variables it reads from the parent with props.",
            `Or call it as a plain function, ${name[0].toLowerCase()}${name.slice(1)}(), if it is only a render helper.`,
          ],
          before: capLines(textOf(anchor, sourceFile), 12),
          after: `function ${name}(props) {\n  /* … */\n}\n\nfunction ${def.name}() {\n  return <${name} /* pass props here */ />;\n}`,
          confidence: "high",
          caveats: [],
        },
      }),
    );
  }

  analysis.edges = [...edges.values()].sort((a, b) => a.line - b.line);
  return analysis;
}

/* -------------------------------------------------------------------------- */
/*  Cascades                                                                  */
/* -------------------------------------------------------------------------- */

function computeCascade(
  root: ComponentDef,
  edgesOf: Map<string, RawEdge[]>,
  registry: Registry,
): RenderCascade {
  const nodes: CascadeNode[] = [];
  const visited = new Set<string>([root.id]);
  let count = 0;
  let boundaries = 0;
  let truncated = false;

  const visit = (def: ComponentDef, depth: number) => {
    for (const edge of edgesOf.get(def.id) ?? []) {
      const child = edge.def;
      const isBoundary = child.isMemo && edge.unstable.size === 0;

      if (visited.has(child.id)) continue;
      visited.add(child.id);

      if (isBoundary) boundaries++;
      else count++;

      if (nodes.length < MAX_CASCADE_NODES) {
        nodes.push({
          name: child.name,
          filePath: registry.files[child.fileIndex].relPath,
          depth,
          boundary: isBoundary,
          isMemo: child.isMemo,
        });
      } else {
        truncated = true;
      }

      if (!isBoundary) visit(child, depth + 1);
    }
  };

  visit(root, 1);
  return { count, boundaries, nodes, truncated };
}

/* -------------------------------------------------------------------------- */
/*  Main analysis                                                             */
/* -------------------------------------------------------------------------- */

export async function analyzeReactRerenders(
  projectPath: string,
  filePath?: string,
  options: {
    minCascade?: number;
    includeTests?: boolean;
  } = {},
): Promise<RerenderReport> {
  const minCascade = options.minCascade ?? DEFAULT_MIN_CASCADE;
  const includeTests = options.includeTests ?? false;

  if (
    filePath !== undefined &&
    (path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes(".."))
  ) {
    throw new Error("filePath must be relative to projectPath.");
  }

  if (!Number.isInteger(minCascade) || minCascade < 2 || minCascade > 100) {
    throw new Error("minCascade must be an integer between 2 and 100.");
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

  /* ---- Pass 1: parse ---- */

  const registry: Registry = {
    files: [],
    fileByPath: new Map(),
    defs: [],
    contextReaders: new Map(),
  };

  // Paths are registered first so imports can be resolved while collecting.
  const readable: Array<{ absolute: string; rel: string }> = [];
  for (const absolute of candidates) {
    readable.push({ absolute, rel: relative(absolute) });
  }
  readable.forEach((item, index) => registry.fileByPath.set(item.rel, index));

  const placeholders: Array<FileInfo | undefined> = new Array(readable.length);

  for (let index = 0; index < readable.length; index++) {
    const { absolute, rel } = readable[index];

    let text: string;
    try {
      if (fs.statSync(absolute).size > MAX_FILE_BYTES) {
        warn(`Skipped ${rel} because it is larger than 1 MB.`);
        continue;
      }
      text = fs.readFileSync(absolute, "utf8");
    } catch {
      warn(`Could not read ${rel}.`);
      continue;
    }

    try {
      placeholders[index] = collectFile(rel, absolute, text, index, registry);
    } catch {
      warn(`Could not parse ${rel}.`);
    }
  }

  // Keep indexes aligned with `fileByPath`; unreadable files become empty entries.
  registry.files = readable.map(
    (item, index) =>
      placeholders[index] ?? {
        relPath: item.rel,
        sourceFile: ts.createSourceFile(item.rel, "", ts.ScriptTarget.Latest),
        lineCount: 0,
        imports: new Map(),
        exportsMap: new Map(),
        starFrom: [],
        components: [],
        local: new Map(),
      },
  );

  if (registry.defs.length === 0) {
    warn("No React components were found in the analyzed files.");
  }

  /* ---- Pass 2: analyze components ---- */

  const analyses = new Map<string, Analysis>();

  for (const def of registry.defs) {
    try {
      analyses.set(def.id, analyzeComponent(registry, def));
    } catch (error) {
      warn(
        `Could not analyze ${def.name} in ${registry.files[def.fileIndex].relPath}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }

  const edgesOf = new Map<string, RawEdge[]>();
  const parentsOf = new Map<string, Set<string>>();

  for (const [id, analysis] of analyses) {
    edgesOf.set(id, analysis.edges);
    for (const edge of analysis.edges) {
      const set = parentsOf.get(edge.def.id) ?? new Set<string>();
      set.add(registry.defs.find((item) => item.id === id)?.name ?? id);
      parentsOf.set(edge.def.id, set);
    }
  }

  /* ---- Cascades ---- */

  const cascades = new Map<string, RenderCascade>();
  for (const def of registry.defs) {
    cascades.set(def.id, computeCascade(def, edgesOf, registry));
  }

  /* ---- Cascade findings and final impact ---- */

  const raw: RawFinding[] = [];

  for (const def of registry.defs) {
    const analysis = analyses.get(def.id);
    if (!analysis) continue;

    raw.push(...analysis.findings);

    const cascade = cascades.get(def.id)!;
    const triggers =
      analysis.stateCount + analysis.reducerCount + analysis.contexts.length;
    if (triggers === 0 || cascade.count < minCascade) continue;

    const file = registry.files[def.fileIndex];
    const sourceFile = file.sourceFile;
    const start = startLineOf(sourceFile, def.declNode);

    const heaviest = (edgesOf.get(def.id) ?? [])
      .map((edge) => ({
        edge,
        weight: 1 + (cascades.get(edge.def.id)?.count ?? 0),
      }))
      .filter((item) => !(item.edge.def.isMemo && item.edge.unstable.size === 0))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3);

    const severity: RerenderSeverity =
      cascade.count >= minCascade * 3 ? "high" : "medium";

    const sourceOfTrigger = [
      analysis.stateCount > 0 ? `${analysis.stateCount} state value${analysis.stateCount === 1 ? "" : "s"}` : "",
      analysis.reducerCount > 0 ? "a reducer" : "",
      analysis.contexts.length > 0 ? `context (${analysis.contexts.join(", ")})` : "",
    ]
      .filter(Boolean)
      .join(", ");

    raw.push({
      rule: "wide-cascade",
      category: RULES["wide-cascade"].category,
      severity,
      title: `A render of ${def.name} re-renders ${cascade.count} components`,
      description: `${def.name} has ${sourceOfTrigger}. Whenever it changes, ${cascade.count} component${
        cascade.count === 1 ? "" : "s"
      } below it re-render${cascade.count === 1 ? "s" : ""}${
        cascade.boundaries > 0
          ? `, and ${cascade.boundaries} memo boundar${cascade.boundaries === 1 ? "y stops" : "ies stop"} the spread`
          : ", and no memo boundary stops the spread"
      }.`,
      filePath: file.relPath,
      line: start,
      endLine: Math.max(start, Math.min(endLineOf(sourceFile, def.declNode), start + 3)),
      component: def.name,
      componentId: def.id,
      impact: cascade.count,
      detail: [
        `${cascade.count} components re-render`,
        `${cascade.boundaries} memo boundar${cascade.boundaries === 1 ? "y" : "ies"}`,
        ...heaviest.map(
          (item) => `${item.edge.def.name}: ${item.weight} component${item.weight === 1 ? "" : "s"}`,
        ),
      ],
      ...buildSnippet(file, start, start),
      suggestion: {
        title: "Cut the cascade",
        summary:
          "Keep frequently changing state close to the components that use it, and put memo boundaries above the heavy subtrees.",
        steps: [
          "Move state into the smallest child that actually reads it.",
          heaviest.length > 0
            ? `Wrap ${heaviest.map((item) => item.edge.def.name).join(", ")} in React.memo and pass stable props.`
            : "Wrap heavy children in React.memo and pass stable props.",
          "Pass slow subtrees as children from a component that does not own the changing state.",
          "Use the React DevTools Profiler to confirm which of these renders are actually slow.",
        ],
        confidence: "low",
        caveats: [
          "This is a static estimate. Many cheap re-renders are fine. Fix it only when the Profiler shows a slow render.",
        ],
      },
    });
  }

  const findings: RerenderFinding[] = raw.map((item) => {
    const { impactDef, impact, ...rest } = item;
    const resolvedImpact = impactDef
      ? 1 + (cascades.get(impactDef.id)?.count ?? 0)
      : impact;

    return {
      ...rest,
      id: createHash("sha1")
        .update(`${item.rule}|${item.filePath}|${item.line}|${item.component}|${item.title}`)
        .digest("hex")
        .slice(0, 10),
      impact: resolvedImpact,
    };
  });

  findings.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      b.impact - a.impact ||
      a.filePath.localeCompare(b.filePath) ||
      a.line - b.line,
  );

  const projectFindingCount = findings.length;

  /* ---- Components ---- */

  const findingsByComponent = new Map<string, RerenderFinding[]>();
  for (const finding of findings) {
    const list = findingsByComponent.get(finding.componentId) ?? [];
    list.push(finding);
    findingsByComponent.set(finding.componentId, list);
  }

  const allComponents: ComponentRender[] = [];
  const seen = new Set<string>();

  for (const def of registry.defs) {
    if (seen.has(def.id)) continue;
    seen.add(def.id);

    const analysis = analyses.get(def.id);
    if (!analysis) continue;

    const file = registry.files[def.fileIndex];
    const start = startLineOf(file.sourceFile, def.declNode);
    const end = endLineOf(file.sourceFile, def.declNode);
    const own = findingsByComponent.get(def.id) ?? [];
    const score = Math.min(
      100,
      own.reduce((sum, item) => sum + SEVERITY_WEIGHT[item.severity], 0),
    );

    allComponents.push({
      id: def.id,
      name: def.name,
      filePath: file.relPath,
      line: start,
      endLine: end,
      lines: end - start + 1,
      kind: def.kind,
      isMemo: def.isMemo,
      isExported: def.isExported,
      propsCount: analysis.propsCount,
      stateCount: analysis.stateCount,
      reducerCount: analysis.reducerCount,
      effectCount: analysis.effectCount,
      stateNames: analysis.stateNames,
      contexts: analysis.contexts,
      customHooks: analysis.customHooks,
      children: analysis.edges.map((edge) => ({
        name: edge.def.name,
        componentId: edge.def.id,
        filePath: registry.files[edge.def.fileIndex].relPath,
        line: edge.line,
        isMemo: edge.def.isMemo,
        unstableProps: [...edge.unstable.values()],
        uses: edge.uses,
      })),
      parents: [...(parentsOf.get(def.id) ?? [])].sort(),
      cascade: cascades.get(def.id)!,
      findingCount: own.length,
      score,
      severity: own.length > 0 ? own[0].severity : "none",
    });
  }

  allComponents.sort(
    (a, b) =>
      b.score - a.score ||
      b.cascade.count - a.cascade.count ||
      a.name.localeCompare(b.name),
  );

  const largest = [...allComponents].sort((a, b) => b.cascade.count - a.cascade.count)[0];

  /* ---- Focus filter ---- */

  const focusFile = filePath ? normalizePath(filePath) : undefined;

  if (focusFile && !registry.fileByPath.has(focusFile)) {
    warn(
      `${focusFile} was not found among the analyzed files, so no results can include it.`,
    );
  }

  const scopedFindings = focusFile
    ? findings.filter((item) => item.filePath === focusFile)
    : findings;

  const reported = scopedFindings.slice(0, MAX_FINDINGS);

  if (scopedFindings.length > reported.length) {
    warn(
      `Showing the top ${MAX_FINDINGS} of ${scopedFindings.length} findings, ranked by severity and impact.`,
    );
  }

  const scopedComponents = (
    focusFile
      ? allComponents.filter((item) => item.filePath === focusFile)
      : allComponents
  ).slice(0, MAX_COMPONENTS);

  /* ---- Summaries ---- */

  const summary: Record<RerenderSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };

  const categories: Record<RerenderCategory, number> = {
    loop: 0,
    remount: 0,
    memo: 0,
    context: 0,
    effects: 0,
    state: 0,
    lists: 0,
    computation: 0,
    cascade: 0,
  };

  const ruleCounts = new Map<RerenderRule, number>();
  const perFile = new Map<
    string,
    { count: number; severe: number; worst: RerenderSeverity }
  >();

  for (const finding of reported) {
    summary[finding.severity]++;
    categories[finding.category]++;
    ruleCounts.set(finding.rule, (ruleCounts.get(finding.rule) ?? 0) + 1);

    const entry = perFile.get(finding.filePath) ?? {
      count: 0,
      severe: 0,
      worst: "info" as RerenderSeverity,
    };
    entry.count++;
    if (finding.severity === "critical" || finding.severity === "high") entry.severe++;
    if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[entry.worst]) {
      entry.worst = finding.severity;
    }
    perFile.set(finding.filePath, entry);
  }

  const componentsPerFile = new Map<string, number>();
  for (const component of allComponents) {
    componentsPerFile.set(
      component.filePath,
      (componentsPerFile.get(component.filePath) ?? 0) + 1,
    );
  }

  const hotspots: RerenderHotspot[] = [...perFile.entries()]
    .map(([file, entry]) => ({
      filePath: file,
      findingCount: entry.count,
      severeCount: entry.severe,
      componentCount: componentsPerFile.get(file) ?? 0,
      worst: entry.worst,
    }))
    .sort(
      (a, b) =>
        b.severeCount - a.severeCount ||
        b.findingCount - a.findingCount ||
        a.filePath.localeCompare(b.filePath),
    )
    .slice(0, MAX_HOTSPOTS);

  const rules: RuleCount[] = [...ruleCounts.entries()]
    .map(([rule, count]) => ({
      rule,
      title: RULES[rule].title,
      category: RULES[rule].category,
      count,
    }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));

  return {
    success: true,
    tool: "analyze_react_rerenders",
    projectPath: root,
    filePath: focusFile,
    minCascade,
    includeTests,
    filesScanned: registry.files.length,
    componentsAnalyzed: allComponents.length,
    memoComponents: allComponents.filter((item) => item.isMemo).length,
    totalFindings: reported.length,
    projectFindingCount,
    filesAffected: perFile.size,
    largestCascade:
      largest && largest.cascade.count > 0
        ? {
            component: largest.name,
            filePath: largest.filePath,
            count: largest.cascade.count,
          }
        : null,
    summary,
    categories,
    rules,
    findings: reported,
    components: scopedComponents,
    hotspots,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/*  MCP registration                                                          */
/* -------------------------------------------------------------------------- */

export function registerAnalyzeReactRerendersTool(server: McpServer) {
  server.registerTool(
    "analyze_react_rerenders",
    {
      description:
        "Find avoidable re-renders in a React project. Parses every component with the TypeScript parser and reports render loops, unstable props that defeat React.memo, unstable context values and hook dependencies, components defined inside components, bad list keys, state that is never read, and heavy work done on every render. It also maps each component's re-render cascade (which children re-render when it does, and where memo boundaries stop the spread) and suggests a fix with example code for every finding.",
      inputSchema: z.object({
        projectPath: z
          .string()
          .describe("Absolute path to the project directory"),
        filePath: z
          .string()
          .optional()
          .describe(
            "Optional file, relative to projectPath. When set, only findings and components in this file are reported. The whole project is still analyzed so imports and memo boundaries resolve.",
          ),
        minCascade: z
          .number()
          .int()
          .min(2)
          .max(100)
          .optional()
          .describe(
            "Report a component whose state or context change re-renders at least this many components. Default 6.",
          ),
        includeTests: z
          .boolean()
          .optional()
          .describe("Include test, mock and story files. Default false."),
      }),
    },
    async ({ projectPath, filePath, minCascade, includeTests }) => {
      try {
        const report = await analyzeReactRerenders(projectPath, filePath, {
          minCascade,
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
                  tool: "analyze_react_rerenders",
                  error:
                    error instanceof Error
                      ? error.message
                      : "Failed to analyze React re-renders.",
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
