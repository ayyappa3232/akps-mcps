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

type HookSeverity = "critical" | "high" | "medium" | "low" | "info";

type HookName =
  | "useEffect"
  | "useLayoutEffect"
  | "useInsertionEffect"
  | "useMemo"
  | "useCallback"
  | "useImperativeHandle";

type HookCategory = "effect" | "memoization";

/** Which hooks to analyze. */
type HookScope = "all" | "effects" | "memoization";

type OwnerKind = "component" | "custom-hook" | "function";

type IssueKind =
  | "missing-dependency"
  | "missing-dependency-array"
  | "unstable-dependency"
  | "unnecessary-dependency"
  | "extra-dependency"
  | "duplicate-dependency"
  | "ref-current-dependency"
  | "complex-dependency"
  | "async-effect"
  | "missing-cleanup"
  | "infinite-loop-risk";

/**
 * missing  - a value is read but not listed (or there is no array at all).
 * unstable - a dependency changes identity on every render.
 * effects  - effect bugs: missing cleanup, async callbacks, update loops.
 * unneeded - entries that should not be in the array.
 */
type IssueGroup = "missing" | "unstable" | "effects" | "unneeded";

type DependencyStatus =
  | "ok"
  | "missing"
  | "unstable"
  | "extra"
  | "outer-scope"
  | "ref-current"
  | "duplicate"
  | "complex";

type FixStrategy =
  | "update-dependencies"
  | "stabilize-dependency"
  | "remove-dependency"
  | "add-dependency-array"
  | "add-cleanup"
  | "fix-async-effect"
  | "break-update-loop";

interface HookIssue {
  kind: IssueKind;
  severity: HookSeverity;
  title: string;
  message: string;
  /** Lines (in the file) the issue points at. */
  lines: number[];
  /** Dependencies the issue is about. */
  dependencies: string[];
}

interface DependencyRow {
  expression: string;
  status: DependencyStatus;
  /** Where the value is read inside the callback. */
  usedLines: number[];
  note: string;
}

interface HookSuggestion {
  strategy: FixStrategy;
  confidence: "high" | "medium" | "low";
  title: string;
  summary: string;
  steps: string[];
  /** The dependency array this hook should probably have. */
  suggestedDeps?: string[];
  /** A small, copyable example of the fix. */
  exampleCode?: string;
  caveats: string[];
}

interface HookFinding {
  id: string;
  severity: HookSeverity;
  hook: HookName;
  category: HookCategory;
  /** Name of the component, custom hook, or function that calls the hook. */
  owner: string;
  ownerKind: OwnerKind;
  filePath: string;
  startLine: number;
  endLine: number;
  /** 0-100 impact score. */
  score: number;
  issueCount: number;
  groups: IssueGroup[];
  title: string;
  description: string;
  /** Present when the dependency array is an array literal. */
  declaredDeps: string[] | null;
  /** Values the callback reads that can change between renders. */
  reads: string[];
  dependencies: DependencyRow[];
  issues: HookIssue[];
  /** Original dependency array and the suggested one. */
  depsChange?: { before: string; after: string; line: number };
  snippet: string;
  snippetStartLine: number;
  snippetTruncated: boolean;
  highlightLines: number[];
  suggestion: HookSuggestion;
}

interface HookHotspot {
  filePath: string;
  findingCount: number;
  issueCount: number;
  hookCount: number;
  percentage: number;
}

interface HookTypeStat {
  hook: HookName;
  analyzed: number;
  withIssues: number;
}

interface HookDependencyReport {
  success: boolean;
  tool: "analyze_hook_dependencies";
  projectPath: string;
  filePath?: string;
  hookScope: HookScope;
  minSeverity: HookSeverity;
  includeTests: boolean;
  filesScanned: number;
  filesWithHooks: number;
  hooksAnalyzed: number;
  hooksWithIssues: number;
  healthyHooks: number;
  totalIssues: number;
  /** Findings that include each kind of problem. */
  groupCounts: Record<IssueGroup, number>;
  issueCounts: Record<IssueKind, number>;
  hookStats: HookTypeStat[];
  summary: Record<HookSeverity, number>;
  findings: HookFinding[];
  hotspots: HookHotspot[];
  warnings: string[];
}

/* ---- Scope analysis ---- */

type BindingKind =
  | "param"
  | "state"
  | "stable"
  | "constant"
  | "memoized"
  | "function"
  | "fresh"
  | "value";

type StableRole = "setter" | "dispatch" | "ref" | "other";

interface Binding {
  name: string;
  kind: BindingKind;
  /** Why a `function` or `fresh` binding changes on every render. */
  reason?: string;
  role?: StableRole;
  /** For setters, the state variable they update. */
  stateName?: string;
}

interface FreeReference {
  root: string;
  path: string;
  line: number;
  position: number;
}

interface NeededValue {
  path: string;
  root: string;
  lines: number[];
}

interface DepEntry {
  text: string;
  expression: ts.Expression;
  line: number;
  kind: "reference" | "fresh" | "complex";
  norm: string;
  root?: string;
  segments: string[];
  freshReason?: string;
}

interface FileContext {
  sf: ts.SourceFile;
  text: string;
  relPath: string;
  lines: string[];
}

interface ScanStats {
  analyzed: Map<HookName, number>;
  withIssues: Map<HookName, number>;
}

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const HOOK_NAMES: HookName[] = [
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
  "useMemo",
  "useCallback",
  "useImperativeHandle",
];

const HOOK_SET = new Set<string>(HOOK_NAMES);

const EFFECT_HOOKS = new Set<HookName>([
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
]);

const HOOK_QUICK_TEST =
  /\buse(?:Effect|LayoutEffect|InsertionEffect|Memo|Callback|ImperativeHandle)\b/;

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

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
  "android",
  "ios",
  "Pods",
]);

const TEST_FILE_PATTERN =
  /(^|\/)(__tests__|__mocks__|tests?|e2e|cypress)\/|\.(test|spec|stories)\.[cm]?[jt]sx?$/;

const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_FINDINGS = 300;
const MAX_SNIPPET_LINES = 40;
const MAX_HOTSPOTS = 15;
const MAX_WARNINGS = 25;

/** Hooks that return `[value, stableFunction, ...]`. */
const STATE_PAIR_HOOKS = new Set([
  "useState",
  "useReducer",
  "useTransition",
  "useOptimistic",
  "useActionState",
]);

/** Hooks whose return value keeps the same identity for the component's life. */
const STABLE_HOOK_ROLES: Record<string, StableRole> = {
  useRef: "ref",
  useSharedValue: "ref",
  useAnimatedRef: "ref",
  useNavigationContainerRef: "ref",
  useDispatch: "dispatch",
  useAppDispatch: "dispatch",
  useId: "other",
  useQueryClient: "other",
};

const FRESH_ARRAY_METHODS = new Set([
  "map",
  "filter",
  "flat",
  "flatMap",
  "toSorted",
  "toReversed",
  "toSpliced",
]);

const FRESH_STATIC_CALLS = new Set([
  "Object.keys",
  "Object.values",
  "Object.entries",
  "Object.assign",
  "Object.fromEntries",
  "Array.from",
  "JSON.parse",
]);

const SEVERITY_RANK: Record<HookSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

const SEVERITY_SCORE: Record<HookSeverity, number> = {
  critical: 90,
  high: 70,
  medium: 50,
  low: 30,
  info: 12,
};

const ISSUE_GROUP: Record<IssueKind, IssueGroup> = {
  "missing-dependency": "missing",
  "missing-dependency-array": "missing",
  "unstable-dependency": "unstable",
  "missing-cleanup": "effects",
  "infinite-loop-risk": "effects",
  "async-effect": "effects",
  "unnecessary-dependency": "unneeded",
  "extra-dependency": "unneeded",
  "duplicate-dependency": "unneeded",
  "ref-current-dependency": "unneeded",
  "complex-dependency": "unneeded",
};

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function scriptKindFor(file: string): ts.ScriptKind {
  const extension = path.extname(file);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    // React code often keeps JSX inside .js files.
    return ts.ScriptKind.JSX;
  }
  return ts.ScriptKind.TS;
}

function unwrap(expression: ts.Expression): ts.Expression {
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

function calleeName(
  call: ts.CallExpression | ts.NewExpression,
): string | undefined {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function lineOf(ctx: FileContext, node: ts.Node): number {
  return ctx.sf.getLineAndCharacterOfPosition(node.getStart(ctx.sf)).line + 1;
}

function endLineOf(ctx: FileContext, node: ts.Node): number {
  return (
    ctx.sf.getLineAndCharacterOfPosition(Math.max(node.getStart(ctx.sf), node.end - 1))
      .line + 1
  );
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function listNames(values: string[]): string {
  if (values.length <= 1) return values.join("");
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
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

function dedent(lines: string[]): string[] {
  let indent = Infinity;

  for (const line of lines) {
    if (line.trim() === "") continue;
    indent = Math.min(indent, line.match(/^[\t ]*/)![0].length);
  }

  if (!Number.isFinite(indent) || indent === 0) return lines;
  return lines.map((line) => line.slice(Math.min(indent, line.length)));
}

/* -------------------------------------------------------------------------- */
/*  Fresh values (new identity on every render)                               */
/* -------------------------------------------------------------------------- */

function freshReason(expression: ts.Expression): string | undefined {
  const expr = unwrap(expression);

  if (ts.isObjectLiteralExpression(expr)) return "an object literal";
  if (ts.isArrayLiteralExpression(expr)) return "an array literal";
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    return "a function";
  }
  if (ts.isNewExpression(expr)) {
    return `a new ${collapse(expr.expression.getText())} instance`;
  }
  if (ts.isClassExpression(expr)) return "a class";
  if (
    ts.isJsxElement(expr) ||
    ts.isJsxSelfClosingElement(expr) ||
    ts.isJsxFragment(expr)
  ) {
    return "a JSX element";
  }

  if (ts.isCallExpression(expr)) {
    const callee = unwrap(expr.expression);

    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      if (FRESH_ARRAY_METHODS.has(method)) return `the result of .${method}()`;
      if (method === "bind") return "a bound function";

      const full = `${collapse(callee.expression.getText())}.${method}`;
      if (FRESH_STATIC_CALLS.has(full)) return `the result of ${full}()`;
    } else if (ts.isIdentifier(callee) && callee.text === "structuredClone") {
      return "a cloned object";
    }

    return undefined;
  }

  if (ts.isConditionalExpression(expr)) {
    return freshReason(expr.whenTrue) ?? freshReason(expr.whenFalse);
  }

  if (ts.isBinaryExpression(expr)) {
    const operator = expr.operatorToken.kind;

    if (
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken ||
      operator === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      const right = freshReason(expr.right);
      if (right) return `${right} used as a fallback`;
    }
  }

  return undefined;
}

function isLiteralConstant(expression: ts.Expression): boolean {
  const expr = unwrap(expression);

  return (
    ts.isStringLiteral(expr) ||
    ts.isNumericLiteral(expr) ||
    ts.isNoSubstitutionTemplateLiteral(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isPrefixUnaryExpression(expr) && ts.isNumericLiteral(expr.operand))
  );
}

/* -------------------------------------------------------------------------- */
/*  Owner scope (what the component declares)                                 */
/* -------------------------------------------------------------------------- */

function declareBindingName(
  name: ts.BindingName,
  bind: (identifier: ts.Identifier) => void,
): void {
  if (ts.isIdentifier(name)) {
    bind(name);
    return;
  }

  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    declareBindingName(element.name, bind);
  }
}

function classifyInitializer(name: string, initializer: ts.Expression, isConst: boolean): Binding {
  const init = unwrap(initializer);

  if (ts.isCallExpression(init)) {
    const callee = calleeName(init);

    if (callee && STABLE_HOOK_ROLES[callee]) {
      return { name, kind: "stable", role: STABLE_HOOK_ROLES[callee] };
    }

    if (callee === "useMemo" || callee === "useCallback") {
      return { name, kind: "memoized" };
    }
  }

  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
    return {
      name,
      kind: "function",
      reason: "a function that is created again on every render",
    };
  }

  if (isConst && isLiteralConstant(init)) return { name, kind: "constant" };

  const reason = freshReason(init);
  if (reason) {
    return { name, kind: "fresh", reason: `${reason} that is created again on every render` };
  }

  return { name, kind: "value" };
}

function buildOwnerScope(owner: ts.FunctionLikeDeclaration): Map<string, Binding> {
  const scope = new Map<string, Binding>();

  for (const parameter of owner.parameters) {
    declareBindingName(parameter.name, (id) => {
      scope.set(id.text, { name: id.text, kind: "param" });
    });
  }

  if (!owner.body || !ts.isBlock(owner.body)) return scope;

  for (const statement of owner.body.statements) {
    if (ts.isVariableStatement(statement)) {
      const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;

      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer ? unwrap(declaration.initializer) : undefined;

        if (
          ts.isArrayBindingPattern(declaration.name) &&
          init &&
          ts.isCallExpression(init) &&
          STATE_PAIR_HOOKS.has(calleeName(init) ?? "")
        ) {
          const elements = declaration.name.elements;
          const first = elements[0];
          const stateName =
            first && !ts.isOmittedExpression(first) && ts.isIdentifier(first.name)
              ? first.name.text
              : undefined;
          const callee = calleeName(init);

          elements.forEach((element, index) => {
            if (ts.isOmittedExpression(element)) return;

            declareBindingName(element.name, (id) => {
              if (index === 0) {
                scope.set(id.text, { name: id.text, kind: "state" });
              } else {
                const isDispatch = callee === "useReducer" && index === 1;
                scope.set(id.text, {
                  name: id.text,
                  kind: "stable",
                  role: isDispatch ? "dispatch" : "setter",
                  stateName: isDispatch ? undefined : stateName,
                });
              }
            });
          });

          continue;
        }

        if (ts.isIdentifier(declaration.name)) {
          scope.set(
            declaration.name.text,
            declaration.initializer
              ? classifyInitializer(declaration.name.text, declaration.initializer, isConst)
              : { name: declaration.name.text, kind: "value" },
          );
          continue;
        }

        declareBindingName(declaration.name, (id) => {
          scope.set(id.text, { name: id.text, kind: "value" });
        });
      }

      continue;
    }

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      scope.set(statement.name.text, {
        name: statement.name.text,
        kind: "function",
        reason: "a function that is created again on every render",
      });
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      scope.set(statement.name.text, { name: statement.name.text, kind: "value" });
    }
  }

  return scope;
}

function isReactive(binding: Binding | undefined): binding is Binding {
  return Boolean(binding) && binding!.kind !== "stable" && binding!.kind !== "constant";
}

function isUnstable(binding: Binding | undefined): boolean {
  return binding?.kind === "function" || binding?.kind === "fresh";
}

/* -------------------------------------------------------------------------- */
/*  Free references inside a callback                                         */
/* -------------------------------------------------------------------------- */

interface Chain {
  root: ts.Identifier;
  segments: string[];
}

function readChain(node: ts.Expression): Chain | undefined {
  const segments: string[] = [];
  let current: ts.Expression = node;

  for (;;) {
    if (ts.isPropertyAccessExpression(current)) {
      segments.unshift(current.name.text);
      current = current.expression;
    } else if (ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else {
      break;
    }
  }

  return ts.isIdentifier(current) ? { root: current, segments } : undefined;
}

function collectFreeReferences(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  ctx: FileContext,
): FreeReference[] {
  const refs: FreeReference[] = [];
  const scopes: Set<string>[] = [];

  const isLocal = (name: string) => scopes.some((scope) => scope.has(name));

  const hoist = (statements: readonly ts.Statement[], into: Set<string>) => {
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          declareBindingName(declaration.name, (id) => into.add(id.text));
        }
      } else if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isEnumDeclaration(statement)) &&
        statement.name
      ) {
        into.add(statement.name.text);
      }
    }
  };

  const record = (root: ts.Identifier, segments: string[], node: ts.Node) => {
    if (isLocal(root.text)) return;

    const parent = node.parent;
    const isCallee =
      parent !== undefined &&
      ts.isCallExpression(parent) &&
      parent.expression === node;

    // `props.onSave()` needs `props`; `a.b.c()` needs `a.b`.
    const used = isCallee && segments.length > 0 ? segments.slice(0, -1) : segments;

    refs.push({
      root: root.text,
      path: [root.text, ...used].join("."),
      line: lineOf(ctx, root),
      position: root.getStart(ctx.sf),
    });
  };

  const walkBindingInitializers = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) return;

    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;

      if (element.propertyName && ts.isComputedPropertyName(element.propertyName)) {
        visit(element.propertyName.expression);
      }
      if (element.initializer) visit(element.initializer);
      walkBindingInitializers(element.name);
    }
  };

  const enterFunction = (fn: ts.FunctionLikeDeclaration) => {
    const scope = new Set<string>();

    if (ts.isFunctionExpression(fn) && fn.name) scope.add(fn.name.text);

    for (const parameter of fn.parameters) {
      declareBindingName(parameter.name, (id) => scope.add(id.text));
    }

    if (fn.body && ts.isBlock(fn.body)) hoist(fn.body.statements, scope);

    scopes.push(scope);

    for (const parameter of fn.parameters) {
      walkBindingInitializers(parameter.name);
      if (parameter.initializer) visit(parameter.initializer);
    }

    if (fn.body) {
      if (ts.isBlock(fn.body)) fn.body.statements.forEach(visit);
      else visit(fn.body);
    }

    scopes.pop();
  };

  const withScope = (names: Set<string>, run: () => void) => {
    scopes.push(names);
    run();
    scopes.pop();
  };

  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return;
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;

    if (ts.isIdentifier(node)) {
      record(node, [], node);
      return;
    }

    if (ts.isPropertyAccessExpression(node)) {
      const chain = readChain(node);

      if (chain) record(chain.root, chain.segments, node);
      else visit(node.expression);
      return;
    }

    if (ts.isElementAccessExpression(node)) {
      visit(node.expression);
      visit(node.argumentExpression);
      return;
    }

    if (
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isParenthesizedExpression(node)
    ) {
      visit(node.expression);
      return;
    }

    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isConstructorDeclaration(node)
    ) {
      enterFunction(node);
      return;
    }

    if (
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      if (ts.isComputedPropertyName(node.name)) visit(node.name.expression);
      enterFunction(node);
      return;
    }

    if (ts.isPropertyAssignment(node)) {
      if (ts.isComputedPropertyName(node.name)) visit(node.name.expression);
      visit(node.initializer);
      return;
    }

    if (ts.isShorthandPropertyAssignment(node)) {
      record(node.name, [], node.name);
      if (node.objectAssignmentInitializer) visit(node.objectAssignmentInitializer);
      return;
    }

    if (ts.isPropertyDeclaration(node)) {
      if (ts.isComputedPropertyName(node.name)) visit(node.name.expression);
      if (node.initializer) visit(node.initializer);
      return;
    }

    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      node.members.forEach(visit);
      return;
    }

    if (ts.isVariableDeclaration(node)) {
      walkBindingInitializers(node.name);
      if (node.initializer) visit(node.initializer);
      return;
    }

    if (ts.isJsxAttribute(node)) {
      if (node.initializer) visit(node.initializer);
      return;
    }

    if (ts.isJsxClosingElement(node)) return;

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName;

      if (ts.isIdentifier(tag)) {
        // Lowercase tags (`div`) are built-in elements, not references.
        if (/^[A-Z_$]/.test(tag.text)) record(tag, [], tag);
      } else if (ts.isPropertyAccessExpression(tag)) {
        visit(tag);
      }

      visit(node.attributes);
      return;
    }

    if (ts.isLabeledStatement(node)) {
      visit(node.statement);
      return;
    }

    if (ts.isBreakOrContinueStatement(node) || ts.isMetaProperty(node)) return;

    if (ts.isBlock(node)) {
      const scope = new Set<string>();
      hoist(node.statements, scope);
      withScope(scope, () => node.statements.forEach(visit));
      return;
    }

    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      const scope = new Set<string>();

      if (node.initializer && ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) {
          declareBindingName(declaration.name, (id) => scope.add(id.text));
        }
      }

      withScope(scope, () => ts.forEachChild(node, visit));
      return;
    }

    if (ts.isCatchClause(node)) {
      const scope = new Set<string>();

      if (node.variableDeclaration) {
        declareBindingName(node.variableDeclaration.name, (id) => scope.add(id.text));
      }

      withScope(scope, () => visit(node.block));
      return;
    }

    if (ts.isCaseBlock(node)) {
      const scope = new Set<string>();

      for (const clause of node.clauses) hoist(clause.statements, scope);
      withScope(scope, () => node.clauses.forEach(visit));
      return;
    }

    ts.forEachChild(node, visit);
  };

  enterFunction(callback);
  return refs;
}

/** Group references by path, drop paths that a shorter path already covers. */
function summarizeReferences(refs: FreeReference[]): NeededValue[] {
  const byPath = new Map<string, NeededValue & { first: number }>();

  for (const ref of refs) {
    const entry = byPath.get(ref.path) ?? {
      path: ref.path,
      root: ref.root,
      lines: [],
      first: ref.position,
    };

    entry.lines.push(ref.line);
    entry.first = Math.min(entry.first, ref.position);
    byPath.set(ref.path, entry);
  }

  const all = [...byPath.values()].sort((a, b) => a.first - b.first);

  return all
    .filter(
      (value) =>
        !all.some(
          (other) => other !== value && value.path.startsWith(`${other.path}.`),
        ),
    )
    .map(({ path: valuePath, root, lines }) => ({
      path: valuePath,
      root,
      lines: unique(lines).sort((a, b) => a - b),
    }));
}

function covers(declared: string, needed: string): boolean {
  return needed === declared || needed.startsWith(`${declared}.`);
}

/* -------------------------------------------------------------------------- */
/*  Effect body checks                                                        */
/* -------------------------------------------------------------------------- */

type CleanupKind =
  | "firebase"
  | "interval"
  | "event-listener"
  | "subscription"
  | "listener"
  | "socket"
  | "observer"
  | "timeout"
  | "animation-frame";

interface Subscription {
  kind: CleanupKind;
  callee: string;
  line: number;
}

const FIREBASE_LISTENERS = new Set([
  "onSnapshot",
  "onAuthStateChanged",
  "onIdTokenChanged",
  "onValue",
  "onChildAdded",
  "onChildChanged",
  "onChildRemoved",
  "onChildMoved",
]);

const OBSERVERS = new Set([
  "IntersectionObserver",
  "ResizeObserver",
  "MutationObserver",
  "PerformanceObserver",
]);

const CLEANUP_REQUIREMENT: Partial<Record<CleanupKind, RegExp>> = {
  interval: /clearInterval/,
  "event-listener": /removeEventListener|\.remove\(|unsubscribe|\.off\(/,
  socket: /\.close\(/,
  observer: /disconnect|unobserve/,
  "animation-frame": /cancelAnimationFrame/,
};

const CLEANUP_LABEL: Record<CleanupKind, string> = {
  firebase: "a live Firebase listener",
  interval: "a repeating timer",
  "event-listener": "an event listener",
  subscription: "a subscription",
  listener: "a listener",
  socket: "a network connection",
  observer: "an observer",
  timeout: "a timer",
  "animation-frame": "an animation frame request",
};

const CLEANUP_SEVERITY: Record<CleanupKind, HookSeverity> = {
  firebase: "high",
  interval: "high",
  socket: "high",
  "event-listener": "medium",
  subscription: "medium",
  listener: "medium",
  observer: "medium",
  timeout: "low",
  "animation-frame": "low",
};

const CLEANUP_UNDO: Record<CleanupKind, string> = {
  firebase: "call the unsubscribe function it returns",
  interval: "call clearInterval",
  "event-listener": "call removeEventListener (or the subscription's remove())",
  subscription: "call unsubscribe()",
  listener: "call the function it returns, or remove the listener",
  socket: "call close()",
  observer: "call disconnect()",
  timeout: "call clearTimeout",
  "animation-frame": "call cancelAnimationFrame",
};

function findSubscriptions(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  ctx: FileContext,
): Subscription[] {
  const found: Subscription[] = [];

  const add = (kind: CleanupKind, callee: string, node: ts.Node) => {
    found.push({ kind, callee, line: lineOf(ctx, node) });
  };

  const visit = (node: ts.Node, nested: boolean) => {
    if (ts.isTypeNode(node)) return;

    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const callee = unwrap(node.expression);
      const isMember = ts.isPropertyAccessExpression(callee);

      if (name) {
        if (FIREBASE_LISTENERS.has(name)) add("firebase", name, node);
        else if (name === "setInterval") add("interval", name, node);
        else if (name === "addEventListener") add("event-listener", name, node);
        else if (name === "subscribe" && isMember) add("subscription", name, node);
        else if (name === "addListener" && isMember) add("listener", name, node);
        else if (
          name === "on" &&
          isMember &&
          node.arguments[0] &&
          ts.isStringLiteralLike(node.arguments[0])
        ) {
          add("listener", name, node);
        } else if (!nested && name === "setTimeout") add("timeout", name, node);
        else if (!nested && name === "requestAnimationFrame") {
          add("animation-frame", name, node);
        }
      }
    }

    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;

      if (name === "WebSocket" || name === "EventSource") add("socket", name, node);
      else if (OBSERVERS.has(name)) add("observer", name, node);
    }

    const isFunction =
      node !== callback &&
      (ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node));

    ts.forEachChild(node, (child) => visit(child, nested || isFunction));
  };

  visit(callback, false);
  return found;
}

/** Text of everything the effect returns directly (the cleanup), if anything. */
function readCleanup(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  ctx: FileContext,
): { hasCleanup: boolean; text: string } {
  if (!ts.isBlock(callback.body)) {
    return { hasCleanup: true, text: callback.body.getText(ctx.sf) };
  }

  const returned: string[] = [];

  const visit = (node: ts.Node) => {
    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isClassDeclaration(node)
    ) {
      return;
    }

    if (ts.isReturnStatement(node) && node.expression) {
      const value = unwrap(node.expression);
      const isNothing =
        (ts.isIdentifier(value) && value.text === "undefined") ||
        value.kind === ts.SyntaxKind.NullKeyword ||
        ts.isVoidExpression(value);

      if (!isNothing) returned.push(value.getText(ctx.sf));
      return;
    }

    ts.forEachChild(node, visit);
  };

  callback.body.statements.forEach(visit);

  return { hasCleanup: returned.length > 0, text: returned.join("\n") };
}

interface UpdateCall {
  callee: string;
  role: StableRole;
  stateName?: string;
  line: number;
}

/** State setters and dispatch calls made directly in the effect body. */
function findTopLevelUpdates(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  scope: Map<string, Binding>,
  ctx: FileContext,
): UpdateCall[] {
  const statements: readonly ts.Node[] = ts.isBlock(callback.body)
    ? callback.body.statements
    : [callback.body];

  const updates: UpdateCall[] = [];

  for (const statement of statements) {
    const expression = ts.isExpressionStatement(statement)
      ? unwrap(statement.expression)
      : ts.isExpression(statement)
        ? unwrap(statement as ts.Expression)
        : undefined;

    if (!expression || !ts.isCallExpression(expression)) continue;

    const callee = unwrap(expression.expression);
    if (!ts.isIdentifier(callee)) continue;

    const binding = scope.get(callee.text);

    if (binding?.kind === "stable" && (binding.role === "setter" || binding.role === "dispatch")) {
      updates.push({
        callee: callee.text,
        role: binding.role,
        stateName: binding.stateName,
        line: lineOf(ctx, expression),
      });
    }
  }

  return updates;
}

/* -------------------------------------------------------------------------- */
/*  Fix examples                                                              */
/* -------------------------------------------------------------------------- */

function depsText(deps: string[] | undefined): string {
  return `[${(deps ?? []).join(", ")}]`;
}

function cleanupExample(kind: CleanupKind, hook: HookName, deps?: string[]): string {
  const close = depsText(deps);

  switch (kind) {
    case "firebase":
      return `${hook}(() => {\n  const unsubscribe = onSnapshot(queryRef, (snapshot) => {\n    // update state from snapshot\n  });\n\n  return () => unsubscribe();\n}, ${close});`;
    case "interval":
      return `${hook}(() => {\n  const id = setInterval(tick, 1000);\n\n  return () => clearInterval(id);\n}, ${close});`;
    case "event-listener":
      return `${hook}(() => {\n  const onChange = () => {\n    // handle the event\n  };\n  target.addEventListener("change", onChange);\n\n  return () => target.removeEventListener("change", onChange);\n}, ${close});`;
    case "subscription":
      return `${hook}(() => {\n  const subscription = source.subscribe(handleValue);\n\n  return () => subscription.unsubscribe();\n}, ${close});`;
    case "listener":
      return `${hook}(() => {\n  const subscription = target.addListener("event", handleEvent);\n\n  return () => subscription.remove();\n}, ${close});`;
    case "socket":
      return `${hook}(() => {\n  const socket = new WebSocket(url);\n\n  return () => socket.close();\n}, ${close});`;
    case "observer":
      return `${hook}(() => {\n  const observer = new ResizeObserver(handleResize);\n  observer.observe(element);\n\n  return () => observer.disconnect();\n}, ${close});`;
    case "timeout":
      return `${hook}(() => {\n  const id = setTimeout(run, 500);\n\n  return () => clearTimeout(id);\n}, ${close});`;
    case "animation-frame":
      return `${hook}(() => {\n  const id = requestAnimationFrame(step);\n\n  return () => cancelAnimationFrame(id);\n}, ${close});`;
  }
}

function asyncExample(hook: HookName, deps?: string[]): string {
  return `${hook}(() => {\n  let cancelled = false;\n\n  async function load() {\n    const result = await fetchData();\n    if (!cancelled) setData(result);\n  }\n\n  load();\n\n  return () => {\n    cancelled = true;\n  };\n}, ${depsText(deps)});`;
}

function stabilizeExample(name: string, binding: Binding | undefined): string {
  if (binding?.kind === "function") {
    return `const ${name} = useCallback(() => {\n  // ...same body as before\n}, [/* values it reads */]);`;
  }

  return `const ${name} = useMemo(() => {\n  // ...same value as before\n  return value;\n}, [/* values it reads */]);`;
}

function loopExample(hook: HookName, update: UpdateCall | undefined, deps?: string[]): string {
  const call = update ? `${update.callee}(next)` : "setValue(next)";
  const compare = update?.stateName ?? "value";

  return `${hook}(() => {\n  if (next !== ${compare}) {\n    ${call};\n  }\n}, ${depsText(deps)});`;
}

/* -------------------------------------------------------------------------- */
/*  Hook analysis                                                             */
/* -------------------------------------------------------------------------- */

function hookNameOf(call: ts.CallExpression): HookName | undefined {
  const callee = call.expression;

  if (ts.isIdentifier(callee) && HOOK_SET.has(callee.text)) {
    return callee.text as HookName;
  }

  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "React" &&
    HOOK_SET.has(callee.name.text)
  ) {
    return callee.name.text as HookName;
  }

  return undefined;
}

function findOwner(call: ts.CallExpression): ts.FunctionLikeDeclaration | undefined {
  let node: ts.Node | undefined = call.parent;

  while (node) {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      return node;
    }
    node = node.parent;
  }

  return undefined;
}

function ownerNameOf(fn: ts.FunctionLikeDeclaration): string {
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) {
    return fn.name.text;
  }

  if (ts.isMethodDeclaration(fn) && ts.isIdentifier(fn.name)) return fn.name.text;

  let node: ts.Node = fn;

  while (node.parent) {
    const parent: ts.Node = node.parent;

    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
    if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
    if (ts.isExportAssignment(parent)) return "default export";

    // memo(...), forwardRef(...), observer(...), casts, parentheses.
    if (
      ts.isCallExpression(parent) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isNonNullExpression(parent)
    ) {
      node = parent;
      continue;
    }

    break;
  }

  return "(anonymous)";
}

function ownerKindOf(name: string): OwnerKind {
  if (/^use[A-Z0-9]/.test(name)) return "custom-hook";
  if (/^[A-Z]/.test(name)) return "component";
  return "function";
}

function hookWordFor(hook: HookName): string {
  if (EFFECT_HOOKS.has(hook)) return "effect";
  if (hook === "useMemo") return "memoized value";
  if (hook === "useCallback") return "callback";
  return "handle";
}

function parseDependencyEntries(array: ts.ArrayLiteralExpression, ctx: FileContext): DepEntry[] {
  return array.elements.map((element) => {
    const expression = unwrap(element);
    const text = collapse(element.getText(ctx.sf));
    const line = lineOf(ctx, element);

    const reason = freshReason(expression);
    if (reason) {
      return {
        text,
        expression,
        line,
        kind: "fresh" as const,
        norm: text,
        segments: [],
        freshReason: reason,
      };
    }

    const chain = readChain(expression);
    if (chain) {
      return {
        text,
        expression,
        line,
        kind: "reference" as const,
        norm: [chain.root.text, ...chain.segments].join("."),
        root: chain.root.text,
        segments: chain.segments,
      };
    }

    return { text, expression, line, kind: "complex" as const, norm: text, segments: [] };
  });
}

function strongest(issues: HookIssue[]): HookSeverity {
  return issues.reduce<HookSeverity>(
    (best, issue) => (SEVERITY_RANK[issue.severity] > SEVERITY_RANK[best] ? issue.severity : best),
    "info",
  );
}

function analyzeHook(
  call: ts.CallExpression,
  hook: HookName,
  owner: ts.FunctionLikeDeclaration,
  ctx: FileContext,
  minSeverity: HookSeverity,
): HookFinding | null {
  const isEffect = EFFECT_HOOKS.has(hook);
  const word = hookWordFor(hook);
  const callbackIndex = hook === "useImperativeHandle" ? 1 : 0;
  const depsIndex = callbackIndex + 1;

  const callbackArg = call.arguments[callbackIndex]
    ? unwrap(call.arguments[callbackIndex])
    : undefined;
  const callback =
    callbackArg && (ts.isArrowFunction(callbackArg) || ts.isFunctionExpression(callbackArg))
      ? callbackArg
      : undefined;

  const depsArg = call.arguments[depsIndex] ? unwrap(call.arguments[depsIndex]) : undefined;

  type DepsState = "none" | "array" | "dynamic";
  let depsState: DepsState;

  if (
    !depsArg ||
    (ts.isIdentifier(depsArg) && depsArg.text === "undefined")
  ) {
    depsState = "none";
  } else if (
    ts.isArrayLiteralExpression(depsArg) &&
    !depsArg.elements.some((element) => ts.isSpreadElement(element))
  ) {
    depsState = "array";
  } else {
    depsState = "dynamic";
  }

  const scope = buildOwnerScope(owner);
  const issues: HookIssue[] = [];
  const rows: DependencyRow[] = [];

  /* ---- What the callback reads ---- */

  const needed: NeededValue[] = callback
    ? summarizeReferences(collectFreeReferences(callback, ctx)).filter((value) =>
        isReactive(scope.get(value.root)),
      )
    : [];

  const usedLinesFor = (expression: string): number[] =>
    unique(
      needed
        .filter((value) => covers(expression, value.path) || covers(value.path, expression))
        .flatMap((value) => value.lines),
    ).sort((a, b) => a - b);

  /* ---- Dependency array ---- */

  let entries: DepEntry[] = [];
  let suggestedDeps: string[] | undefined;
  let missing: NeededValue[] = [];

  if (depsState === "array") {
    entries = parseDependencyEntries(depsArg as ts.ArrayLiteralExpression, ctx);

    const seen = new Set<string>();
    const duplicates: string[] = [];
    const outerScope: DepEntry[] = [];
    const extras: DepEntry[] = [];
    const complex: DepEntry[] = [];
    const keep: DepEntry[] = [];

    for (const entry of entries) {
      let status: DependencyStatus = "ok";
      let note = callback ? "Read inside the callback." : "Listed in the array.";

      if (entry.kind === "complex") {
        status = "complex";
        note = "Complex expression. Move it into a variable above the hook.";
        complex.push(entry);
        rows.push({ expression: entry.text, status, usedLines: [], note });
        continue;
      }

      if (entry.kind === "fresh") {
        status = "unstable";
        note = `${entry.freshReason} is created again on every render.`;
        issues.push({
          kind: "unstable-dependency",
          severity: isEffect ? "high" : "medium",
          title: `Unstable dependency: ${entry.text.length > 28 ? `${entry.text.slice(0, 28)}…` : entry.text}`,
          message: isEffect
            ? `The dependency array contains ${entry.freshReason}, which is a new value on every render, so this effect runs after every render.`
            : `The dependency array contains ${entry.freshReason}, which is a new value on every render, so ${hook} recalculates every time and memoization has no effect.`,
          lines: [entry.line],
          dependencies: [entry.text],
        });
        keep.push(entry);
        rows.push({ expression: entry.text, status, usedLines: [], note });
        continue;
      }

      const binding = entry.root ? scope.get(entry.root) : undefined;
      const lastSegment = entry.segments[entry.segments.length - 1];

      if (seen.has(entry.norm)) {
        status = "duplicate";
        note = "Already listed earlier in the array.";
        duplicates.push(entry.text);
      } else {
        seen.add(entry.norm);

        if (lastSegment === "current") {
          status = "ref-current";
          note = "Changing ref.current does not re-render, so it cannot trigger this hook.";
          issues.push({
            kind: "ref-current-dependency",
            severity: "medium",
            title: `ref.current in dependencies: ${entry.text}`,
            message: `Changing ${entry.text} does not re-render the component, so listing it will not re-run this ${word}. Track the value with state, or read it inside the callback and remove it from the array.`,
            lines: [entry.line],
            dependencies: [entry.text],
          });
        } else if (!binding || binding.kind === "constant") {
          status = "outer-scope";
          note =
            binding?.kind === "constant"
              ? "A constant that never changes."
              : "Defined outside the component, so it never triggers a re-run.";
          outerScope.push(entry);
        } else if (binding.kind === "stable") {
          status = "ok";
          note = "Stable value. It is safe to keep and is never required.";
          keep.push(entry);
        } else if (isUnstable(binding) && entry.segments.length === 0) {
          status = "unstable";
          note = `${entry.text} is ${binding.reason}.`;
          issues.push({
            kind: "unstable-dependency",
            severity: isEffect ? "high" : "medium",
            title: `Unstable dependency: ${entry.text}`,
            message: isEffect
              ? `${entry.text} is ${binding.reason}, so its identity changes on every render and this effect runs after every render.`
              : `${entry.text} is ${binding.reason}, so ${hook} recalculates on every render and memoization has no effect.`,
            lines: [entry.line, ...usedLinesFor(entry.norm).slice(0, 1)],
            dependencies: [entry.text],
          });
          keep.push(entry);
        } else if (callback && usedLinesFor(entry.norm).length === 0) {
          status = "extra";
          note = isEffect
            ? "Not read inside the effect. It only works as a re-run trigger."
            : "Not read inside the callback, so it can be removed.";
          extras.push(entry);
          if (isEffect) keep.push(entry);
        } else {
          keep.push(entry);
        }
      }

      rows.push({
        expression: entry.text,
        status,
        usedLines: status === "ok" ? usedLinesFor(entry.norm) : [],
        note,
      });
    }

    /* Missing: needed values no valid entry covers. */
    const validEntries = entries.filter((entry) => entry.kind === "reference");
    missing = needed.filter(
      (value) => !validEntries.some((entry) => covers(entry.norm, value.path)),
    );

    if (callback && missing.length > 0) {
      const names = missing.map((value) => value.path);
      const unstableMissing = missing.filter((value) =>
        isUnstable(scope.get(value.root)) && value.path === value.root,
      );

      const lead =
        entries.length === 0
          ? `This ${word} reads ${listNames(names)} but its dependency array is empty, so it keeps using the values from the first render.`
          : `This ${word} reads ${listNames(names)} but ${names.length === 1 ? "it is" : "they are"} not in the dependency array, so it can use stale values.`;

      const tail =
        unstableMissing.length > 0
          ? ` ${listNames(unstableMissing.map((value) => value.path))} ${unstableMissing.length === 1 ? "is" : "are"} recreated on every render, so stabilize ${unstableMissing.length === 1 ? "it" : "them"} first or the ${word} will run every time.`
          : "";

      issues.push({
        kind: "missing-dependency",
        severity: "high",
        title:
          names.length === 1
            ? `Missing dependency: ${names[0]}`
            : `Missing ${names.length} dependencies`,
        message: `${lead}${tail}`,
        lines: unique(missing.flatMap((value) => value.lines.slice(0, 2))).sort((a, b) => a - b),
        dependencies: names,
      });

      for (const value of missing) {
        rows.push({
          expression: value.path,
          status: "missing",
          usedLines: value.lines,
          note: `Read on ${value.lines.length === 1 ? "line" : "lines"} ${value.lines.join(", ")} but not listed.`,
        });
      }
    }

    /* Aggregated "remove" issues. */
    if (duplicates.length > 0) {
      issues.push({
        kind: "duplicate-dependency",
        severity: "low",
        title: `Duplicate ${duplicates.length === 1 ? "dependency" : "dependencies"}: ${duplicates.join(", ")}`,
        message: `${listNames(unique(duplicates))} ${duplicates.length === 1 ? "is" : "are"} listed more than once. Keep a single entry.`,
        lines: entries.filter((entry) => duplicates.includes(entry.text)).map((entry) => entry.line),
        dependencies: unique(duplicates),
      });
    }

    if (outerScope.length > 0) {
      const names = outerScope.map((entry) => entry.text);

      issues.push({
        kind: "unnecessary-dependency",
        severity: "low",
        title: `Unnecessary ${names.length === 1 ? "dependency" : "dependencies"}: ${names.join(", ")}`,
        message: `${listNames(names)} ${names.length === 1 ? "is" : "are"} defined outside the component or never change${names.length === 1 ? "s" : ""}, so ${names.length === 1 ? "it" : "they"} can never re-run this ${word}. Remove ${names.length === 1 ? "it" : "them"} from the array.`,
        lines: outerScope.map((entry) => entry.line),
        dependencies: names,
      });
    }

    if (complex.length > 0) {
      const names = complex.map((entry) => entry.text);

      issues.push({
        kind: "complex-dependency",
        severity: "low",
        title: `Complex ${names.length === 1 ? "dependency" : "dependencies"}`,
        message: `The dependency array has ${names.length === 1 ? "an expression" : "expressions"} that React cannot track well (${listNames(names)}). Move ${names.length === 1 ? "it" : "them"} into a variable above the hook and list that variable.`,
        lines: complex.map((entry) => entry.line),
        dependencies: names,
      });
    }

    if (extras.length > 0) {
      const names = extras.map((entry) => entry.text);

      issues.push({
        kind: "extra-dependency",
        severity: isEffect ? "info" : "low",
        title: `${isEffect ? "Unused" : "Unnecessary"} ${names.length === 1 ? "dependency" : "dependencies"}: ${names.join(", ")}`,
        message: isEffect
          ? `${listNames(names)} ${names.length === 1 ? "is" : "are"} listed but not read inside the effect. The effect re-runs when ${names.length === 1 ? "it changes" : "they change"}. Keep ${names.length === 1 ? "it" : "them"} only if that is intentional.`
          : `${listNames(names)} ${names.length === 1 ? "is" : "are"} listed but not read inside the callback, so ${hook} recalculates for no reason. Remove ${names.length === 1 ? "it" : "them"}.`,
        lines: extras.map((entry) => entry.line),
        dependencies: names,
      });
    }

    suggestedDeps = [
      ...keep
        .filter(
          (entry) =>
            !(
              entry.kind === "reference" &&
              needed.some(
                (value) => value.path !== entry.norm && entry.norm.startsWith(`${value.path}.`),
              )
            ),
        )
        .map((entry) => entry.text),
      ...missing.map((value) => value.path),
    ];
    suggestedDeps = unique(suggestedDeps);
  }

  /* ---- No dependency array ---- */

  const callLine = lineOf(ctx, call);

  if (depsState === "none") {
    suggestedDeps = needed.map((value) => value.path);

    if (isEffect) {
      issues.push({
        kind: "missing-dependency-array",
        severity: "low",
        title: "No dependency array",
        message:
          "This effect has no dependency array, so it runs after every render. Add [] to run once, or list the values it reads.",
        lines: [callLine],
        dependencies: [],
      });
    } else if (hook === "useMemo" || hook === "useCallback") {
      issues.push({
        kind: "missing-dependency-array",
        severity: "high",
        title: "No dependency array",
        message: `${hook} without a dependency array does nothing: the ${hook === "useMemo" ? "value is recalculated" : "function is recreated"} on every render. Pass the values it reads as the second argument.`,
        lines: [callLine],
        dependencies: [],
      });
    } else {
      issues.push({
        kind: "missing-dependency-array",
        severity: "low",
        title: "No dependency array",
        message:
          "useImperativeHandle without a dependency array recreates the handle after every render. Pass the values it reads.",
        lines: [callLine],
        dependencies: [],
      });
    }
  }

  /* ---- Effect-only checks ---- */

  let cleanupKinds: CleanupKind[] = [];
  let loopUpdate: UpdateCall | undefined;
  const isAsync = Boolean(
    callback?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword),
  );

  if (isEffect && callback) {
    if (isAsync) {
      issues.push({
        kind: "async-effect",
        severity: "high",
        title: "Async effect callback",
        message:
          "The effect callback is async, so it returns a Promise. React expects a cleanup function (or nothing), so cleanup never runs. Define an async function inside the effect and call it.",
        lines: [lineOf(ctx, callback)],
        dependencies: [],
      });
    }

    const updates = findTopLevelUpdates(callback, scope, ctx);

    if (depsState === "none" && updates.length > 0) {
      loopUpdate = updates[0];
      const isSetter = loopUpdate.role === "setter";

      issues.push({
        kind: "infinite-loop-risk",
        severity: isSetter ? "critical" : "high",
        title: `Possible render loop: ${loopUpdate.callee}()`,
        message: isSetter
          ? `This effect has no dependency array and calls ${loopUpdate.callee}() every time it runs. Each state update re-renders the component, which runs the effect again, and this can loop forever.`
          : `This effect has no dependency array and calls ${loopUpdate.callee}() on every render. If the dispatched action changes anything this component reads, it re-renders and dispatches again.`,
        lines: updates.map((update) => update.line),
        dependencies: [],
      });
    } else if (depsState === "array") {
      const looped = updates.find(
        (update) =>
          update.role === "setter" &&
          update.stateName &&
          entries.some(
            (entry) =>
              entry.kind === "reference" &&
              entry.root === update.stateName &&
              entry.segments.length === 0,
          ),
      );

      if (looped) {
        loopUpdate = looped;

        issues.push({
          kind: "infinite-loop-risk",
          severity: "high",
          title: `Possible render loop: ${looped.callee}()`,
          message: `This effect depends on ${looped.stateName} and calls ${looped.callee}() unconditionally. Updating ${looped.stateName} re-runs the effect, which can loop. Guard the update with a condition or derive the value during render.`,
          lines: [looped.line],
          dependencies: [looped.stateName!],
        });
      }
    }

    if (!isAsync) {
      const subscriptions = findSubscriptions(callback, ctx);
      const cleanup = readCleanup(callback, ctx);
      const byKind = new Map<CleanupKind, Subscription>();

      for (const subscription of subscriptions) {
        if (!byKind.has(subscription.kind)) byKind.set(subscription.kind, subscription);
      }

      for (const [kind, subscription] of byKind) {
        const requirement = CLEANUP_REQUIREMENT[kind];
        const undone = cleanup.hasCleanup && (!requirement || requirement.test(cleanup.text));

        if (undone) continue;

        // A timeout that is never cleared is only worth mentioning when there is no cleanup at all.
        if (kind === "timeout" && cleanup.hasCleanup) continue;

        cleanupKinds.push(kind);

        issues.push({
          kind: "missing-cleanup",
          severity: CLEANUP_SEVERITY[kind],
          title: `Missing cleanup: ${subscription.callee}()`,
          message: cleanup.hasCleanup
            ? `${subscription.callee}() starts ${CLEANUP_LABEL[kind]}, but the cleanup function does not stop it. Inside the cleanup, ${CLEANUP_UNDO[kind]}.`
            : `${subscription.callee}() starts ${CLEANUP_LABEL[kind]} that keeps running after the component unmounts or the dependencies change. Return a cleanup function that will ${CLEANUP_UNDO[kind]}.`,
          lines: [subscription.line],
          dependencies: [],
        });
      }
    }
  }

  /* ---- Filter and finish ---- */

  const visibleIssues = issues
    .filter((issue) => SEVERITY_RANK[issue.severity] >= SEVERITY_RANK[minSeverity])
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

  if (visibleIssues.length === 0) return null;

  const severity = strongest(visibleIssues);
  const groups = unique(visibleIssues.map((issue) => ISSUE_GROUP[issue.kind]));

  const startLine = lineOf(ctx, call);
  const endLine = endLineOf(ctx, call);

  const sourceLines = ctx.lines.slice(startLine - 1, endLine);
  const cappedLines = sourceLines.slice(0, MAX_SNIPPET_LINES);

  const highlightLines = unique(
    visibleIssues
      .flatMap((issue) => issue.lines)
      .filter((line) => line >= startLine && line < startLine + cappedLines.length),
  ).sort((a, b) => a - b);

  const ownerName = ownerNameOf(owner);
  const ownerKind = ownerKindOf(ownerName);

  /* ---- Suggested fix ---- */

  const has = (kind: IssueKind) => visibleIssues.some((issue) => issue.kind === kind);
  const issueOf = (kind: IssueKind) => visibleIssues.find((issue) => issue.kind === kind);

  const currentDeps = depsState === "array" ? entries.map((entry) => entry.text) : null;
  const depsChanged =
    suggestedDeps !== undefined &&
    (currentDeps === null ||
      currentDeps.length !== suggestedDeps.length ||
      currentDeps.some((value, index) => value !== suggestedDeps![index]));

  const unstableIssues = visibleIssues.filter((issue) => issue.kind === "unstable-dependency");
  const unstableMissing = missing.filter(
    (value) => isUnstable(scope.get(value.root)) && value.path === value.root,
  );

  const steps: string[] = [];
  const caveats: string[] = [];
  let strategy: FixStrategy = "update-dependencies";
  let title = "Update the dependency array";
  let summary = "";
  let exampleCode: string | undefined;
  let confidence: HookSuggestion["confidence"] = "high";

  if (has("infinite-loop-risk")) {
    strategy = "break-update-loop";
    title = "Break the update loop";
    summary =
      "Only update state when the value actually changes, or move the update out of the effect.";
    confidence = "low";
    exampleCode = loopExample(hook, loopUpdate, suggestedDeps);
    steps.push(
      loopUpdate?.role === "dispatch"
        ? "Add a dependency array so the action is dispatched only when its inputs change."
        : "Compare with the current value before calling the setter, or compute the value during render instead.",
    );
    caveats.push("Check the surrounding logic: only you know which value should trigger the update.");
  } else if (has("async-effect")) {
    strategy = "fix-async-effect";
    title = "Move the async work inside the effect";
    summary =
      "Keep the effect callback synchronous, define an async function inside it, and call that function.";
    confidence = "high";
    exampleCode = asyncExample(hook, suggestedDeps);
    steps.push(
      "Remove async from the effect callback.",
      "Declare an async function inside the effect and call it right away.",
      "Return a cleanup function that ignores results once the effect is stale.",
    );
  } else if (unstableIssues.length > 0 || unstableMissing.length > 0) {
    strategy = "stabilize-dependency";
    title = "Stabilize the changing value";
    summary = `Give ${listNames(
      unique([
        ...unstableIssues.flatMap((issue) => issue.dependencies),
        ...unstableMissing.map((value) => value.path),
      ]),
    )} a stable identity so the ${word} only re-runs when its inputs change.`;
    confidence = "medium";

    const firstName = unstableIssues[0]?.dependencies[0] ?? unstableMissing[0]?.path;
    const firstBinding = firstName ? scope.get(firstName) : undefined;
    if (firstName && firstBinding) exampleCode = stabilizeExample(firstName, firstBinding);
  } else if (has("missing-dependency")) {
    strategy = "update-dependencies";
    title = "Add the missing dependencies";
    summary = `Use ${depsText(suggestedDeps)} so the ${word} always sees the latest values.`;
    confidence = "high";
  } else if (has("missing-cleanup")) {
    strategy = "add-cleanup";
    title = "Return a cleanup function";
    summary = `Stop ${listNames(unique(cleanupKinds.map((kind) => CLEANUP_LABEL[kind])))} when the effect re-runs or the component unmounts.`;
    confidence = "medium";
    exampleCode = cleanupExample(cleanupKinds[0], hook, suggestedDeps ?? currentDeps ?? []);
  } else if (has("missing-dependency-array")) {
    strategy = "add-dependency-array";
    title = "Add a dependency array";
    summary = `Pass ${depsText(suggestedDeps)} as the second argument.`;
    confidence = isEffect ? "medium" : "high";
  } else {
    strategy = "remove-dependency";
    title = "Clean up the dependency array";
    summary = depsChanged
      ? `Use ${depsText(suggestedDeps)}.`
      : "Keep the extra dependencies only if you want the effect to re-run when they change. Otherwise remove them.";
    confidence = "high";
  }

  if (strategy !== "stabilize-dependency") {
    for (const issue of unstableIssues) {
      steps.push(`Stabilize ${listNames(issue.dependencies)} before relying on it.`);
    }
  }

  if (strategy === "stabilize-dependency") {
    for (const name of unique([
      ...unstableIssues.flatMap((issue) => issue.dependencies),
      ...unstableMissing.map((value) => value.path),
    ])) {
      const binding = scope.get(name);
      const fresh = binding?.kind === "function";

      steps.push(
        binding
          ? fresh
            ? `Wrap ${name} in useCallback, move it into the ${word}, or move it outside the component if it uses no props or state.`
            : `Wrap ${name} in useMemo, move it outside the component if it is constant, or create it inside the ${word}.`
          : `Replace the inline value with a variable that keeps the same identity (useMemo or useCallback).`,
      );
    }
  }

  if (has("missing-dependency") && strategy !== "update-dependencies") {
    steps.push(`Add ${listNames(issueOf("missing-dependency")!.dependencies)} to the dependency array.`);
  } else if (strategy === "update-dependencies") {
    steps.push(`Add ${listNames(issueOf("missing-dependency")!.dependencies)} to the dependency array.`);
  }

  if (has("missing-cleanup") && strategy !== "add-cleanup") {
    steps.push("Return a cleanup function that stops everything the effect starts.");
  } else if (strategy === "add-cleanup") {
    for (const kind of unique(cleanupKinds)) {
      steps.push(`For ${CLEANUP_LABEL[kind]}, ${CLEANUP_UNDO[kind]} in the cleanup function.`);
    }
  }

  if (has("missing-dependency-array") && strategy !== "add-dependency-array") {
    steps.push("Add a dependency array so the hook does not run on every render.");
  } else if (strategy === "add-dependency-array") {
    steps.push(
      isEffect
        ? "Add [] to run once after mount, or list the values the effect reads."
        : "Pass the values the callback reads as the second argument.",
    );
  }

  const removable = unique(
    visibleIssues
      .filter((issue) =>
        ["unnecessary-dependency", "ref-current-dependency", "duplicate-dependency", "complex-dependency"].includes(
          issue.kind,
        ),
      )
      .flatMap((issue) => issue.dependencies),
  );

  if (removable.length > 0) {
    steps.push(`Remove ${listNames(removable)} from the dependency array.`);
  }

  if (has("extra-dependency")) {
    const names = issueOf("extra-dependency")!.dependencies;
    steps.push(
      isEffect
        ? `Keep ${listNames(names)} only if the effect should re-run when ${names.length === 1 ? "it changes" : "they change"}.`
        : `Remove ${listNames(names)} from the dependency array.`,
    );
  }

  steps.push("Run your tests and check that the screen still behaves the same.");

  if (isEffect && has("missing-dependency")) {
    caveats.push(
      "Adding dependencies makes the effect run more often. Check that every run is safe, with no duplicate requests and no update loops.",
    );
  }

  if (unstableMissing.length > 0 && strategy !== "stabilize-dependency") {
    caveats.push(
      `${listNames(unstableMissing.map((value) => value.path))} changes on every render. Adding it as-is makes the ${word} run every time.`,
    );
  }

  if (has("extra-dependency") && isEffect) {
    caveats.push("An unused dependency is allowed on purpose when you want to re-run an effect.");
  }

  const suggestion: HookSuggestion = {
    strategy,
    confidence,
    title,
    summary,
    steps: unique(steps),
    suggestedDeps: depsChanged ? suggestedDeps : undefined,
    exampleCode,
    caveats,
  };

  /* ---- Titles ---- */

  const primary = visibleIssues[0];
  const ownerLabel =
    ownerKind === "component"
      ? `component ${ownerName}`
      : ownerKind === "custom-hook"
        ? `hook ${ownerName}`
        : ownerName === "(anonymous)"
          ? "an anonymous function"
          : `function ${ownerName}`;

  const score = Math.min(
    100,
    SEVERITY_SCORE[severity] + Math.min(8, (visibleIssues.length - 1) * 3),
  );

  const id = createHash("sha1")
    .update(`${ctx.relPath}:${startLine}:${hook}`)
    .digest("hex")
    .slice(0, 10);

  return {
    id,
    severity,
    hook,
    category: isEffect ? "effect" : "memoization",
    owner: ownerName,
    ownerKind,
    filePath: ctx.relPath,
    startLine,
    endLine,
    score,
    issueCount: visibleIssues.length,
    groups,
    title: `${hook} · ${primary.title}`,
    description: `${hook} in ${ownerLabel} (${ctx.relPath}:${startLine}) has ${visibleIssues.length} ${visibleIssues.length === 1 ? "issue" : "issues"}. ${primary.message}`,
    declaredDeps: currentDeps,
    reads: needed.map((value) => value.path),
    dependencies: rows,
    issues: visibleIssues,
    depsChange: depsChanged
      ? {
          before: depsArg && depsState === "array" ? collapse(depsArg.getText(ctx.sf)) : "(no dependency array)",
          after: depsText(suggestedDeps),
          line: depsState === "array" ? lineOf(ctx, depsArg!) : endLine,
        }
      : undefined,
    snippet: dedent(cappedLines).join("\n"),
    snippetStartLine: startLine,
    snippetTruncated: sourceLines.length > cappedLines.length,
    highlightLines,
    suggestion,
  };
}

/* -------------------------------------------------------------------------- */
/*  File scanning                                                             */
/* -------------------------------------------------------------------------- */

function scanFile(
  absolute: string,
  relPath: string,
  text: string,
  hookScope: HookScope,
  minSeverity: HookSeverity,
  stats: ScanStats,
): { findings: HookFinding[]; hookCount: number } {
  const sf = ts.createSourceFile(
    absolute,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(absolute),
  );

  const ctx: FileContext = { sf, text, relPath, lines: text.split(/\r?\n/) };
  const findings: HookFinding[] = [];
  let hookCount = 0;

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const hook = hookNameOf(node);

      if (hook) {
        const isEffect = EFFECT_HOOKS.has(hook);
        const wanted =
          hookScope === "all" ||
          (hookScope === "effects" && isEffect) ||
          (hookScope === "memoization" && !isEffect);
        const owner = findOwner(node);

        if (wanted && owner) {
          hookCount++;
          stats.analyzed.set(hook, (stats.analyzed.get(hook) ?? 0) + 1);

          const finding = analyzeHook(node, hook, owner, ctx, minSeverity);

          if (finding) {
            findings.push(finding);
            stats.withIssues.set(hook, (stats.withIssues.get(hook) ?? 0) + 1);
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return { findings, hookCount };
}

/* -------------------------------------------------------------------------- */
/*  Main analysis                                                             */
/* -------------------------------------------------------------------------- */

export async function analyzeHookDependencies(
  projectPath: string,
  filePath?: string,
  options: {
    hookScope?: HookScope;
    minSeverity?: HookSeverity;
    includeTests?: boolean;
  } = {},
): Promise<HookDependencyReport> {
  const hookScope = options.hookScope ?? "all";
  const minSeverity = options.minSeverity ?? "info";
  const includeTests = options.includeTests ?? false;

  if (
    filePath !== undefined &&
    (path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes(".."))
  ) {
    throw new Error("filePath must be relative to projectPath.");
  }

  if (!["all", "effects", "memoization"].includes(hookScope)) {
    throw new Error("hookScope must be one of all, effects, or memoization.");
  }

  if (!(minSeverity in SEVERITY_RANK)) {
    throw new Error("minSeverity must be one of critical, high, medium, low, or info.");
  }

  const resolvedProject = await resolveProjectPath(projectPath);
  const root = fs.realpathSync(resolvedProject.projectPath);
  const warnings: string[] = [];

  const warn = (message: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message);
    else if (warnings.length === MAX_WARNINGS) warnings.push("Further warnings were omitted.");
  };

  const relative = (absolute: string) => normalizePath(path.relative(root, absolute));

  let candidates: string[];

  if (filePath) {
    const absolute = path.resolve(root, filePath);
    const inside = relative(absolute);

    if (inside.startsWith("..") || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(`${normalizePath(filePath)} was not found in the project.`);
    }

    if (!SOURCE_EXTENSIONS.has(path.extname(absolute))) {
      throw new Error(`${normalizePath(filePath)} is not a JavaScript or TypeScript file.`);
    }

    candidates = [absolute];
  } else {
    const discovered = discoverSourceFiles(root);

    if (discovered.truncated) {
      warn(
        `Only the first ${MAX_FILES} source files were analyzed. Narrow the project path for complete results.`,
      );
    }

    candidates = discovered.files.filter(
      (file) => includeTests || !TEST_FILE_PATTERN.test(relative(file)),
    );
  }

  if (candidates.length === 0) {
    throw new Error(`No JavaScript or TypeScript source files were found in ${root}.`);
  }

  const stats: ScanStats = { analyzed: new Map(), withIssues: new Map() };
  const allFindings: HookFinding[] = [];
  const perFile = new Map<string, { hooks: number; findings: number; issues: number }>();

  let filesScanned = 0;
  let filesWithHooks = 0;

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

    filesScanned++;

    if (!HOOK_QUICK_TEST.test(text)) continue;

    try {
      const result = scanFile(absolute, relative(absolute), text, hookScope, minSeverity, stats);

      if (result.hookCount === 0) continue;

      filesWithHooks++;
      allFindings.push(...result.findings);
      perFile.set(relative(absolute), {
        hooks: result.hookCount,
        findings: result.findings.length,
        issues: result.findings.reduce((sum, finding) => sum + finding.issueCount, 0),
      });
    } catch {
      warn(`Could not analyze ${relative(absolute)}.`);
    }
  }

  allFindings.sort(
    (a, b) =>
      b.score - a.score ||
      a.filePath.localeCompare(b.filePath) ||
      a.startLine - b.startLine,
  );

  const reported = allFindings.slice(0, MAX_FINDINGS);

  if (allFindings.length > reported.length) {
    warn(
      `Showing the top ${MAX_FINDINGS} of ${allFindings.length} hooks with issues, ranked by impact.`,
    );
  }

  const hooksAnalyzed = [...stats.analyzed.values()].reduce((sum, value) => sum + value, 0);

  const summary: Record<HookSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const finding of reported) summary[finding.severity]++;

  const issueCounts = Object.fromEntries(
    (Object.keys(ISSUE_GROUP) as IssueKind[]).map((kind) => [kind, 0]),
  ) as Record<IssueKind, number>;

  const groupCounts: Record<IssueGroup, number> = {
    missing: 0,
    unstable: 0,
    effects: 0,
    unneeded: 0,
  };

  for (const finding of reported) {
    for (const issue of finding.issues) issueCounts[issue.kind]++;
    for (const group of finding.groups) groupCounts[group]++;
  }

  const hotspots: HookHotspot[] = [...perFile.entries()]
    .filter(([, entry]) => entry.findings > 0)
    .map(([file, entry]) => ({
      filePath: file,
      findingCount: entry.findings,
      issueCount: entry.issues,
      hookCount: entry.hooks,
      percentage: Math.round((entry.findings / Math.max(1, entry.hooks)) * 1000) / 10,
    }))
    .sort(
      (a, b) =>
        b.issueCount - a.issueCount ||
        b.findingCount - a.findingCount ||
        a.filePath.localeCompare(b.filePath),
    )
    .slice(0, MAX_HOTSPOTS);

  const hookStats: HookTypeStat[] = HOOK_NAMES.map((hook) => ({
    hook,
    analyzed: stats.analyzed.get(hook) ?? 0,
    withIssues: stats.withIssues.get(hook) ?? 0,
  })).filter((entry) => entry.analyzed > 0);

  return {
    success: true,
    tool: "analyze_hook_dependencies",
    projectPath: root,
    filePath: filePath ? normalizePath(filePath) : undefined,
    hookScope,
    minSeverity,
    includeTests,
    filesScanned,
    filesWithHooks,
    hooksAnalyzed,
    hooksWithIssues: allFindings.length,
    healthyHooks: Math.max(0, hooksAnalyzed - allFindings.length),
    totalIssues: reported.reduce((sum, finding) => sum + finding.issueCount, 0),
    groupCounts,
    issueCounts,
    hookStats,
    summary,
    findings: reported,
    hotspots,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/*  MCP registration                                                          */
/* -------------------------------------------------------------------------- */

export function registerAnalyzeHookDependenciesTool(server: McpServer) {
  server.registerTool(
    "analyze_hook_dependencies",
    {
      description:
        "Analyze React hook dependency arrays in a JavaScript/TypeScript project (React and React Native). Checks useEffect, useLayoutEffect, useInsertionEffect, useMemo, useCallback and useImperativeHandle for missing, unnecessary, duplicate and unstable dependencies, async effects, missing cleanup (event listeners, timers, Firebase listeners), and update loops. Uses the TypeScript parser with scope analysis and reports each hook with its issues, the values it reads, and a suggested fix with the corrected dependency array.",
      inputSchema: z.object({
        projectPath: z
          .string()
          .describe("Absolute path to the project directory"),
        filePath: z
          .string()
          .optional()
          .describe(
            "Optional file, relative to projectPath. When set, only this file is analyzed.",
          ),
        hookScope: z
          .enum(["all", "effects", "memoization"])
          .optional()
          .describe(
            "all (default), effects (useEffect, useLayoutEffect, useInsertionEffect), or memoization (useMemo, useCallback, useImperativeHandle).",
          ),
        minSeverity: z
          .enum(["critical", "high", "medium", "low", "info"])
          .optional()
          .describe("Lowest severity to report. Default info (everything)."),
        includeTests: z
          .boolean()
          .optional()
          .describe("Include test, mock and story files. Default false."),
      }),
    },
    async ({ projectPath, filePath, hookScope, minSeverity, includeTests }) => {
      try {
        const report = await analyzeHookDependencies(projectPath, filePath, {
          hookScope,
          minSeverity,
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
                  tool: "analyze_hook_dependencies",
                  error:
                    error instanceof Error
                      ? error.message
                      : "Failed to analyze hook dependencies.",
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
