import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveProjectPath } from "../utils/projectResolver.js";

/* -------------------------------------------------------------------------- */
/*  Report types                                                              */
/* -------------------------------------------------------------------------- */

type Severity = "critical" | "high" | "medium" | "low" | "info";

/**
 * useState / useReducer - state declared inside a component or custom hook.
 * redux                 - a Redux Toolkit slice (createSlice).
 * zustand               - a Zustand store (create).
 * jotai                 - a Jotai atom (atom).
 */
type StateKind = "useState" | "useReducer" | "redux" | "zustand" | "jotai";

/**
 * value   - the state itself.
 * derived - something computed from the state.
 * setter  - the state setter or dispatch function.
 * handler - a function that eventually calls a setter.
 */
type FlowRole = "value" | "derived" | "setter" | "handler";

type IssueType =
  | "prop-drilling"
  | "unused-state"
  | "write-only-state"
  | "never-updated"
  | "derived-state"
  | "state-too-high"
  | "direct-mutation"
  | "render-phase-update"
  | "unstable-context-value"
  | "scattered-updates"
  | "stale-update";

type HopKind = "prop" | "context" | "hook" | "store";

type NodeBehavior =
  | "state"
  | "owner"
  | "pass-through"
  | "reader"
  | "writer"
  | "reader-writer"
  | "idle"
  | "context"
  | "store"
  | "external";

interface StateAccess {
  component: string;
  filePath: string;
  line: number;
  /** Local name or prop that was used, e.g. "count" or "props.count". */
  via: string;
  detail: string;
}

interface FlowHop {
  fromId: string;
  from: string;
  toId: string;
  to: string;
  prop: string;
  role: FlowRole;
  kind: HopKind;
  line: number;
  depth: number;
}

interface FlowNode {
  id: string;
  label: string;
  filePath?: string;
  type: "state" | "component" | "context" | "store" | "hook";
  behavior: NodeBehavior;
  depth: number;
  reads: number;
  writes: number;
}

interface FlowEdge {
  from: string;
  to: string;
  label: string;
  role: FlowRole;
  kind: HopKind;
}

interface IssueSuggestion {
  title: string;
  summary: string;
  steps: string[];
  /** Ready-to-paste example, written with the names found in the project. */
  code?: string;
  caveats: string[];
}

interface StateIssue {
  id: string;
  type: IssueType;
  severity: Severity;
  title: string;
  description: string;
  filePath: string;
  line: number;
  snippet?: string;
  suggestion: IssueSuggestion;
}

interface StateUnit {
  id: string;
  name: string;
  kind: StateKind;
  filePath: string;
  line: number;
  /** Component, hook or module that declares the state. */
  owner: string;
  setter?: string;
  initial?: string;
  /** Contexts the state travels through. */
  viaContexts: string[];
  /** Worst issue severity, or "info" when there are no issues. */
  severity: Severity;
  /** 0-100 combined risk score. */
  riskScore: number;
  issueCount: number;
  issues: StateIssue[];
  reads: StateAccess[];
  writes: StateAccess[];
  hiddenReads: number;
  hiddenWrites: number;
  readerComponents: number;
  writerComponents: number;
  /** Components that read or update the state. */
  consumerCount: number;
  /** Most pass-through components on a single path. */
  drillDepth: number;
  passThroughComponents: string[];
  flow: FlowHop[];
  graph: { nodes: FlowNode[]; edges: FlowEdge[]; hiddenNodes: number };
}

interface ComponentHotspot {
  name: string;
  filePath: string;
  line: number;
  ownedStates: number;
  passThroughs: number;
  statesTouched: number;
}

interface StateFlowReport {
  success: boolean;
  tool: "analyze_state_flow";
  projectPath: string;
  filePath?: string;
  minDrillDepth: number;
  includeTests: boolean;
  filesScanned: number;
  componentsAnalyzed: number;
  hooksAnalyzed: number;
  totalStates: number;
  /** State count for the whole project, before any filePath filter. */
  projectStateCount: number;
  localStates: number;
  storeStates: number;
  contextCount: number;
  statesWithIssues: number;
  drillingStates: number;
  deepestDrill: number;
  sharedStates: number;
  totalIssues: number;
  summary: Record<Severity, number>;
  kindCounts: Record<StateKind, number>;
  units: StateUnit[];
  hotspots: ComponentHotspot[];
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/*  Internal types                                                            */
/* -------------------------------------------------------------------------- */

type Role = FlowRole;
type FunctionNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction;

interface Seeds {
  /** Local names that carry the state, with the role each one plays. */
  names: Map<string, Role>;
  /** Objects (props, context values, hook results) keyed by member name. */
  objects: Map<string, Map<string, Role>>;
}

interface Shape {
  obj?: Map<string, Role>;
  arr?: Array<Role | undefined>;
  single?: Role;
}

type Binding =
  | { kind: "names"; map: Map<string, string>; rest?: string }
  | { kind: "object"; name: string }
  | { kind: "array"; names: Array<string | undefined> }
  | { kind: "return" }
  | { kind: "none" };

interface PropsParam {
  named: Map<string, string>;
  rest?: string;
  objectName?: string;
}

interface ImportInfo {
  spec: string;
  imported: string;
}

interface ReExport {
  spec: string;
  star: boolean;
  names: Map<string, string>;
}

interface ParsedFile {
  relPath: string;
  sf: ts.SourceFile;
  lineCount: number;
  imports: Map<string, ImportInfo>;
  reexports: ReExport[];
  components: ComponentDef[];
  compsByName: Map<string, ComponentDef>;
  compFns: Set<ts.Node>;
  defaultName?: string;
}

interface ComponentDef {
  id: string;
  name: string;
  kind: "component" | "hook";
  filePath: string;
  file: ParsedFile;
  fn: FunctionNode;
  body: ts.Node;
  line: number;
  props: PropsParam;
  calls: ts.CallExpression[];
  decls: ts.VariableDeclaration[];
}

interface ChannelUse {
  channelKey: string;
  comp: ComponentDef;
  binding: Binding;
  line: number;
}

interface StoreInfo {
  kind: "zustand" | "jotai" | "redux";
  name: string;
  filePath: string;
  line: number;
  /** Zustand keys, marked as state or action. */
  keys: Map<string, "value" | "action">;
  /** Redux reducer names. */
  actionNames: Set<string>;
  sliceName?: string;
  initial?: string;
}

interface Project {
  root: string;
  files: Map<string, ParsedFile>;
  fileSet: Set<string>;
  comps: ComponentDef[];
  compsByName: Map<string, ComponentDef[]>;
  hooksByName: Map<string, ComponentDef[]>;
  contexts: Map<string, { filePath: string; line: number }>;
  channelUses: Map<string, ChannelUse[]>;
  stores: StoreInfo[];
  selectorSlices: Map<string, string>;
}

interface Ref {
  node: ts.Node;
  /** Binding or member name that was matched. */
  name: string;
  role: Role | "object";
  via: string;
}

interface RawAccess {
  line: number;
  via: string;
  detail: string;
}

interface Forward {
  tag: string;
  prop: string;
  role: Role;
  direct: boolean;
  line: number;
  via: string;
}

interface Provide {
  contextName: string;
  shape: Shape;
  stable: boolean;
  line: number;
}

interface Problem {
  kind: "mutation" | "render-write" | "stale-update";
  line: number;
  snippet: string;
  name: string;
}

interface CompResult {
  reads: RawAccess[];
  writes: RawAccess[];
  forwards: Forward[];
  provides: Provide[];
  problems: Problem[];
  returns?: Shape;
}

interface NodeAcc {
  id: string;
  label: string;
  filePath?: string;
  type: FlowNode["type"];
  depth: number;
  reads: number;
  writes: number;
  forwardsOut: number;
  isOwner: boolean;
  isExternal: boolean;
}

interface ProblemRec extends Problem {
  component: string;
  filePath: string;
}

interface ContextRec {
  name: string;
  stable: boolean;
  line: number;
  filePath: string;
  component: string;
  consumers: Set<string>;
}

interface Flow {
  nodes: Map<string, NodeAcc>;
  hops: FlowHop[];
  reads: StateAccess[];
  writes: StateAccess[];
  problems: ProblemRec[];
  contexts: Map<string, ContextRec>;
  truncated: boolean;
}

interface Task {
  comp: ComponentDef;
  seeds: Seeds;
  depth: number;
  isOwner: boolean;
}

interface UnitDef {
  id: string;
  name: string;
  kind: StateKind;
  filePath: string;
  line: number;
  owner: string;
  setter?: string;
  valueName?: string;
  initial?: string;
  ownerComp?: ComponentDef;
  store?: StoreInfo;
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

const RESOLVE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs"];

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

const MAX_FILES = 3_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_UNITS = 400;
const MAX_TASKS_PER_UNIT = 250;
const MAX_FLOW_DEPTH = 14;
const MAX_ACCESSES_SHOWN = 40;
const MAX_GRAPH_NODES = 60;
const MAX_HOTSPOTS = 12;
const MAX_WARNINGS = 25;
const MAX_MUTATION_ISSUES = 4;

const DEFAULT_MIN_DRILL_DEPTH = 2;

const HOOK_CALLBACK_NAMES = new Set([
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
  "useMemo",
  "useCallback",
  "useImperativeHandle",
]);

const COMPONENT_WRAPPERS = new Set(["memo", "forwardRef", "observer"]);

const MUTATING_METHODS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
]);

const PURE_METHODS = new Set([
  "map",
  "filter",
  "reduce",
  "slice",
  "concat",
  "join",
  "includes",
  "find",
  "findIndex",
  "some",
  "every",
  "flat",
  "flatMap",
  "keys",
  "values",
  "entries",
  "trim",
  "toLowerCase",
  "toUpperCase",
  "toString",
  "toFixed",
  "split",
  "replace",
  "startsWith",
  "endsWith",
  "indexOf",
  "at",
]);

const PURE_GLOBALS = new Set([
  "Math",
  "JSON",
  "Object",
  "Array",
  "Number",
  "String",
  "Boolean",
]);

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 40,
  high: 25,
  medium: 12,
  low: 5,
  info: 2,
};

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

const DECLARATION_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.EnumMember,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.JsxAttribute,
  ts.SyntaxKind.LabeledStatement,
]);

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function clip(value: string, length = 60): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

function hashId(...parts: Array<string | number>): string {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 10);
}

function pascal(value: string): string {
  const cleaned = value.replace(/^(use|set)(?=[A-Z])/, "");
  const result = cleaned
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
  return result || "State";
}

function isWriteRole(role: Role | "object"): boolean {
  return role === "setter" || role === "handler";
}

function scriptKindFor(file: string): ts.ScriptKind {
  const extension = path.extname(file);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    // Plain .js files in React projects routinely contain JSX.
    return ts.ScriptKind.JSX;
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

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/* -------------------------------------------------------------------------- */
/*  AST helpers                                                               */
/* -------------------------------------------------------------------------- */

function unwrapExpr(node: ts.Expression): ts.Expression {
  let current: ts.Expression = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Walks up through parentheses, `as` casts and `!` so a node can be compared with its parent's slot. */
function climbWrappers(node: ts.Node): ts.Node {
  let current = node;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent))
  ) {
    current = current.parent;
  }
  return current;
}

function calleeName(expression: ts.Expression): string | undefined {
  const target = unwrapExpr(expression);
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return undefined;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];

  const names: string[] = [];
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) names.push(...bindingNames(element.name));
  }
  return names;
}

function containsJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (current: ts.Node) => {
    if (found) return;
    if (
      ts.isJsxElement(current) ||
      ts.isJsxSelfClosingElement(current) ||
      ts.isJsxFragment(current)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function forEachNode(root: ts.Node, callback: (node: ts.Node) => void): void {
  const visit = (node: ts.Node) => {
    callback(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
}

/** Visits `root` without entering other components defined in the same file. */
function walkOwn(
  root: ts.Node,
  compFns: Set<ts.Node>,
  callback: (node: ts.Node) => void,
): void {
  const visit = (node: ts.Node) => {
    if (node !== root && compFns.has(node)) return;
    callback(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
}

function isComponentTag(tag: string): boolean {
  return /^[A-Z]/.test(tag) || tag.includes(".");
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

function isStateHookCall(expression: ts.Expression): boolean {
  if (!ts.isCallExpression(expression)) return false;
  const name = calleeName(expression.expression);
  return (
    !!name &&
    /^use[A-Z]/.test(name) &&
    name !== "useMemo" &&
    name !== "useCallback" &&
    name !== "useDeferredValue"
  );
}

/* -------------------------------------------------------------------------- */
/*  Parsing                                                                   */
/* -------------------------------------------------------------------------- */

function unwrapComponentInit(
  expression: ts.Expression,
): FunctionNode | undefined {
  const target = unwrapExpr(expression);

  if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) {
    return target;
  }

  if (ts.isCallExpression(target)) {
    const name = calleeName(target.expression);
    if (name && COMPONENT_WRAPPERS.has(name) && target.arguments[0]) {
      return unwrapComponentInit(target.arguments[0]);
    }
  }

  return undefined;
}

function parsePropsParam(fn: FunctionNode): PropsParam {
  const named = new Map<string, string>();
  const first = fn.parameters[0];

  if (!first) return { named };

  if (ts.isIdentifier(first.name)) {
    return { named, objectName: first.name.text };
  }

  let rest: string | undefined;

  if (ts.isObjectBindingPattern(first.name)) {
    for (const element of first.name.elements) {
      if (!ts.isIdentifier(element.name)) continue;

      if (element.dotDotDotToken) {
        rest = element.name.text;
        continue;
      }

      const key = element.propertyName
        ? propertyNameText(element.propertyName)
        : element.name.text;

      if (key) named.set(key, element.name.text);
    }
  }

  return { named, rest };
}

function fileBaseComponentName(relPath: string): string {
  const base = path.basename(relPath).replace(/\.[^.]+$/, "");
  const name = pascal(base === "index" ? path.basename(path.dirname(relPath)) : base);
  return /^[A-Z]/.test(name) ? name : `Default${name}`;
}

function parseFile(
  absolute: string,
  relPath: string,
  text: string,
): ParsedFile {
  const sf = ts.createSourceFile(
    absolute,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(absolute),
  );

  const file: ParsedFile = {
    relPath,
    sf,
    lineCount: sf.getLineAndCharacterOfPosition(text.length).line + 1,
    imports: new Map(),
    reexports: [],
    components: [],
    compsByName: new Map(),
    compFns: new Set(),
  };

  for (const statement of sf.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const spec = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (!clause) continue;

      if (clause.name) {
        file.imports.set(clause.name.text, { spec, imported: "default" });
      }

      if (clause.namedBindings) {
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            file.imports.set(element.name.text, {
              spec,
              imported: (element.propertyName ?? element.name).text,
            });
          }
        } else {
          file.imports.set(clause.namedBindings.name.text, {
            spec,
            imported: "*",
          });
        }
      }
      continue;
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const reexport: ReExport = {
        spec: statement.moduleSpecifier.text,
        star: !statement.exportClause,
        names: new Map(),
      };

      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          reexport.names.set(
            element.name.text,
            (element.propertyName ?? element.name).text,
          );
        }
      }

      file.reexports.push(reexport);
      continue;
    }

    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      let target = unwrapExpr(statement.expression);

      while (
        ts.isCallExpression(target) &&
        target.arguments[0] &&
        COMPONENT_WRAPPERS.has(calleeName(target.expression) ?? "")
      ) {
        target = unwrapExpr(target.arguments[0]);
      }

      if (ts.isIdentifier(target)) file.defaultName = target.text;
    }
  }

  const register = (
    fn: FunctionNode,
    name: string,
    isDefault: boolean,
  ): void => {
    if (!fn.body) return;
    if (file.compFns.has(fn)) return;

    const isHook = /^use[A-Z0-9]/.test(name);
    const isComponent = /^[A-Z]/.test(name) && containsJsx(fn.body);

    if (!isHook && !isComponent) return;

    let id = `${relPath}#${name}`;
    if (file.compsByName.has(name) || file.components.some((c) => c.id === id)) {
      id = `${id}:${lineOf(sf, fn)}`;
    }

    const comp: ComponentDef = {
      id,
      name,
      kind: isHook ? "hook" : "component",
      filePath: relPath,
      file,
      fn,
      body: fn.body,
      line: lineOf(sf, fn),
      props: parsePropsParam(fn),
      calls: [],
      decls: [],
    };

    file.components.push(comp);
    file.compFns.add(fn);
    if (!file.compsByName.has(name)) file.compsByName.set(name, comp);
    if (isDefault && !file.defaultName) file.defaultName = name;
  };

  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.body) {
      const modifiers = ts.canHaveModifiers(node)
        ? ts.getModifiers(node)
        : undefined;
      const isDefault = !!modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
      );

      if (node.name) register(node, node.name.text, isDefault);
      else if (isDefault) {
        register(node, fileBaseComponentName(relPath), true);
      }
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const fn = unwrapComponentInit(node.initializer);
      if (fn) register(fn, node.name.text, false);
    } else if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const fn = unwrapComponentInit(node.expression);
      if (fn) register(fn, fileBaseComponentName(relPath), true);
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);

  for (const comp of file.components) {
    walkOwn(comp.body, file.compFns, (node) => {
      if (ts.isCallExpression(node)) comp.calls.push(node);
      else if (ts.isVariableDeclaration(node)) comp.decls.push(node);
    });
  }

  return file;
}

/* -------------------------------------------------------------------------- */
/*  Module and component resolution                                           */
/* -------------------------------------------------------------------------- */

function isLocalSpec(spec: string): boolean {
  return (
    spec.startsWith(".") ||
    spec.startsWith("@/") ||
    spec.startsWith("~/") ||
    spec.startsWith("src/") ||
    spec.startsWith("/")
  );
}

function resolveModule(
  fromRel: string,
  spec: string,
  fileSet: Set<string>,
): string | undefined {
  let base: string;

  if (spec.startsWith(".")) {
    base = path.posix.normalize(
      path.posix.join(path.posix.dirname(fromRel), spec),
    );
  } else if (spec.startsWith("@/") || spec.startsWith("~/")) {
    base = `src/${spec.slice(2)}`;
  } else if (spec.startsWith("src/")) {
    base = spec;
  } else {
    return undefined;
  }

  const stripped = base.replace(/\.(m|c)?jsx?$/, "");
  const bases = stripped === base ? [base] : [base, stripped];

  for (const candidateBase of bases) {
    if (fileSet.has(candidateBase)) return candidateBase;

    for (const extension of RESOLVE_EXTENSIONS) {
      if (fileSet.has(`${candidateBase}${extension}`)) {
        return `${candidateBase}${extension}`;
      }
    }

    for (const extension of RESOLVE_EXTENSIONS) {
      if (fileSet.has(`${candidateBase}/index${extension}`)) {
        return `${candidateBase}/index${extension}`;
      }
    }
  }

  return undefined;
}

function findExport(
  project: Project,
  relFile: string,
  exportName: string,
  depth: number,
): ComponentDef | undefined {
  const file = project.files.get(relFile);
  if (!file || depth > 4) return undefined;

  if (exportName === "default") {
    if (file.defaultName) {
      const found = file.compsByName.get(file.defaultName);
      if (found) return found;
    }
  } else {
    const found = file.compsByName.get(exportName);
    if (found) return found;
  }

  for (const reexport of file.reexports) {
    const target = resolveModule(file.relPath, reexport.spec, project.fileSet);
    if (!target) continue;

    if (reexport.star) {
      if (exportName === "default") continue;
      const found = findExport(project, target, exportName, depth + 1);
      if (found) return found;
    } else {
      const original = reexport.names.get(exportName);
      if (!original) continue;
      const found = findExport(project, target, original, depth + 1);
      if (found) return found;
    }
  }

  return undefined;
}

function resolveTag(
  from: ParsedFile,
  tag: string,
  project: Project,
): ComponentDef | undefined {
  const direct = from.compsByName.get(tag);
  if (direct && direct.kind === "component") return direct;

  const name = tag.includes(".") ? tag.split(".").pop()! : tag;
  const head = tag.split(".")[0];
  const imported = from.imports.get(head);

  if (imported) {
    if (!isLocalSpec(imported.spec)) return undefined;

    const target = resolveModule(from.relPath, imported.spec, project.fileSet);

    if (target && !tag.includes(".")) {
      const found = findExport(
        project,
        target,
        imported.imported === "default" ? "default" : imported.imported,
        0,
      );
      if (found && found.kind === "component") return found;
    } else if (target && tag.includes(".")) {
      const found = findExport(project, target, name, 0);
      if (found && found.kind === "component") return found;
    }
  }

  const candidates = (project.compsByName.get(name) ?? []).filter(
    (candidate) => candidate.kind === "component",
  );

  return candidates.length === 1 ? candidates[0] : undefined;
}

/* -------------------------------------------------------------------------- */
/*  Reference tracking inside one component                                   */
/* -------------------------------------------------------------------------- */

function emptySeeds(): Seeds {
  return { names: new Map(), objects: new Map() };
}

function seedsEmpty(seeds: Seeds): boolean {
  return seeds.names.size === 0 && seeds.objects.size === 0;
}

function seedSignature(seeds: Seeds): string {
  const names = [...seeds.names.entries()]
    .map(([key, role]) => `${key}=${role}`)
    .sort()
    .join(",");

  const objects = [...seeds.objects.entries()]
    .map(
      ([key, members]) =>
        `${key}{${[...members.entries()]
          .map(([member, role]) => `${member}=${role}`)
          .sort()
          .join(",")}}`,
    )
    .sort()
    .join(",");

  return `${names}|${objects}`;
}

function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;

  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false;
  }

  if (ts.isBindingElement(parent)) {
    return parent.name !== node && parent.propertyName !== node;
  }

  if (ts.isShorthandPropertyAssignment(parent)) return true;

  if (
    DECLARATION_KINDS.has(parent.kind) &&
    (parent as ts.Node & { name?: ts.Node }).name === node
  ) {
    return false;
  }

  if (
    (ts.isJsxOpeningElement(parent) ||
      ts.isJsxSelfClosingElement(parent) ||
      ts.isJsxClosingElement(parent)) &&
    parent.tagName === node
  ) {
    return false;
  }

  return true;
}

function collectParamNames(fn: ts.SignatureDeclarationBase): Set<string> {
  const names = new Set<string>();
  for (const parameter of fn.parameters) {
    for (const name of bindingNames(parameter.name)) names.add(name);
  }
  return names;
}

/** Finds every reference to a tracked name, or to a tracked member such as `props.count`. */
function findRefs(root: ts.Node, scope: Seeds): Ref[] {
  const found: Ref[] = [];

  const visit = (node: ts.Node, shadow: Set<string> | undefined) => {
    if (ts.isTypeNode(node)) return;

    let activeShadow = shadow;

    if (ts.isFunctionLike(node)) {
      const params = collectParamNames(node as ts.SignatureDeclarationBase);
      if (params.size > 0) {
        activeShadow = new Set([...(shadow ?? []), ...params]);
      }
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      scope.objects.has(node.expression.text) &&
      !activeShadow?.has(node.expression.text)
    ) {
      const role = scope.objects.get(node.expression.text)!.get(node.name.text);

      if (role) {
        found.push({
          node,
          name: node.name.text,
          role,
          via: `${node.expression.text}.${node.name.text}`,
        });
        return;
      }
    }

    if (ts.isIdentifier(node)) {
      if (isReferenceIdentifier(node) && !activeShadow?.has(node.text)) {
        const role = scope.names.get(node.text);

        if (role) {
          found.push({ node, name: node.text, role, via: node.text });
        } else if (scope.objects.has(node.text)) {
          found.push({ node, name: node.text, role: "object", via: node.text });
        }
      }
      return;
    }

    ts.forEachChild(node, (child) => visit(child, activeShadow));
  };

  visit(root, undefined);
  return found;
}

function roleFromRefs(expression: ts.Node, refs: Ref[]): Role {
  if (refs.some((ref) => isWriteRole(ref.role))) {
    return containsJsx(expression) ? "derived" : "handler";
  }
  return "derived";
}

function roleOfExpr(expression: ts.Expression, scope: Seeds): Role | undefined {
  const refs = findRefs(expression, scope);
  if (refs.length === 0) return undefined;

  const target = unwrapExpr(expression);
  if (refs.length === 1 && refs[0].node === target && refs[0].role !== "object") {
    return refs[0].role;
  }

  return roleFromRefs(expression, refs);
}

function shapeOf(expression: ts.Expression, scope: Seeds): Shape {
  const target = unwrapExpr(expression);

  if (ts.isObjectLiteralExpression(target)) {
    const obj = new Map<string, Role>();

    for (const property of target.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        const role = scope.names.get(property.name.text);
        if (role) obj.set(property.name.text, role);
      } else if (ts.isPropertyAssignment(property)) {
        const key = propertyNameText(property.name);
        const role = roleOfExpr(property.initializer, scope);
        if (key && role) obj.set(key, role);
      } else if (ts.isSpreadAssignment(property)) {
        const spread = unwrapExpr(property.expression);
        if (ts.isIdentifier(spread) && scope.objects.has(spread.text)) {
          for (const [key, role] of scope.objects.get(spread.text)!) {
            obj.set(key, role);
          }
        }
      } else if (ts.isMethodDeclaration(property)) {
        const key = propertyNameText(property.name);
        const refs = findRefs(property, scope);
        if (key && refs.length > 0) obj.set(key, roleFromRefs(property, refs));
      }
    }

    return obj.size > 0 ? { obj } : {};
  }

  if (ts.isArrayLiteralExpression(target)) {
    const arr = target.elements.map((element) =>
      ts.isSpreadElement(element) || ts.isOmittedExpression(element)
        ? undefined
        : roleOfExpr(element, scope),
    );
    return arr.some(Boolean) ? { arr } : {};
  }

  if (ts.isIdentifier(target) && scope.objects.has(target.text)) {
    return { obj: scope.objects.get(target.text)! };
  }

  const single = roleOfExpr(target, scope);
  return single ? { single } : {};
}

function isEmptyShape(shape: Shape): boolean {
  return !shape.obj && !shape.arr && !shape.single;
}

function shapeKeys(shape: Shape): string[] {
  if (shape.obj) return [...shape.obj.keys()];
  if (shape.arr) return shape.arr.map((_, index) => `[${index}]`);
  return [];
}

function shapeRole(shape: Shape): Role {
  const roles = shape.obj
    ? [...shape.obj.values()]
    : shape.arr
      ? shape.arr.filter((role): role is Role => !!role)
      : shape.single
        ? [shape.single]
        : [];

  return roles.find((role) => role === "value") ?? roles[0] ?? "value";
}

function describeWhere(node: ts.Node, boundary: ts.Node) {
  let inFunction = false;
  let conditional = false;
  let hook: string | undefined;

  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== boundary;
    current = current.parent
  ) {
    if (ts.isFunctionLike(current)) {
      inFunction = true;
    } else if (
      ts.isIfStatement(current) ||
      ts.isConditionalExpression(current) ||
      ts.isSwitchStatement(current) ||
      (ts.isBinaryExpression(current) &&
        (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
    ) {
      conditional = true;
    } else if (ts.isCallExpression(current) && !hook) {
      const name = calleeName(current.expression);
      if (name && HOOK_CALLBACK_NAMES.has(name)) hook = name;
    }
  }

  return { inFunction, conditional, hook };
}

function isDependencyEntry(node: ts.Node): boolean {
  const outer = climbWrappers(node);
  const array = outer.parent;
  if (!array || !ts.isArrayLiteralExpression(array)) return false;

  const call = array.parent;
  if (!call || !ts.isCallExpression(call)) return false;

  const name = calleeName(call.expression);
  return !!name && HOOK_CALLBACK_NAMES.has(name) && call.arguments[1] === array;
}

function detectMutation(node: ts.Node): string | undefined {
  let current: ts.Node = climbWrappers(node);
  let depth = 0;

  while (
    current.parent &&
    ((ts.isPropertyAccessExpression(current.parent) &&
      current.parent.expression === current) ||
      (ts.isElementAccessExpression(current.parent) &&
        current.parent.expression === current))
  ) {
    current = current.parent;
    depth++;
  }

  if (depth === 0) return undefined;

  const parent = current.parent;
  if (!parent) return undefined;

  if (
    ts.isCallExpression(parent) &&
    parent.expression === current &&
    ts.isPropertyAccessExpression(current) &&
    MUTATING_METHODS.has(current.name.text)
  ) {
    return `${clip(current.getText())}(…)`;
  }

  if (
    ts.isBinaryExpression(parent) &&
    parent.left === current &&
    isAssignmentOperator(parent.operatorToken.kind)
  ) {
    return `${clip(current.getText())} ${parent.operatorToken.getText()} …`;
  }

  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return clip(parent.getText());
  }

  if (ts.isDeleteExpression(parent)) return clip(parent.getText());

  return undefined;
}

function describeUpdate(call: ts.CallExpression): string {
  const argument = call.arguments[0];
  if (!argument) return "update";

  if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
    return "functional update";
  }

  if (ts.isObjectLiteralExpression(argument)) {
    for (const property of argument.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        propertyNameText(property.name) === "type" &&
        ts.isStringLiteralLike(property.initializer)
      ) {
        return `action "${property.initializer.text}"`;
      }
    }
    return "object update";
  }

  if (ts.isCallExpression(argument)) {
    return `${calleeName(argument.expression) ?? "action"}()`;
  }

  return "direct update";
}

function isStableContextValue(
  expression: ts.Expression,
  topInits: Map<string, ts.Expression>,
): boolean {
  const target = unwrapExpr(expression);

  const isInline = (candidate: ts.Expression) => {
    const value = unwrapExpr(candidate);
    return (
      ts.isObjectLiteralExpression(value) ||
      ts.isArrayLiteralExpression(value) ||
      ts.isArrowFunction(value) ||
      ts.isFunctionExpression(value)
    );
  };

  if (isInline(target)) return false;

  if (ts.isIdentifier(target)) {
    const init = topInits.get(target.text);
    if (init && isInline(init)) return false;
  }

  return true;
}

/* -------------------------------------------------------------------------- */
/*  Component analysis                                                        */
/* -------------------------------------------------------------------------- */

function analyzeComponent(
  comp: ComponentDef,
  seeds: Seeds,
  isOwner: boolean,
  contextNames: Set<string>,
): CompResult {
  const sf = comp.file.sf;
  const scope: Seeds = {
    names: new Map(seeds.names),
    objects: new Map(seeds.objects),
  };

  const result: CompResult = {
    reads: [],
    writes: [],
    forwards: [],
    provides: [],
    problems: [],
  };

  const computedAliases = new Set<string>();
  const skipNodes = new Set<ts.Node>();
  const topInits = new Map<string, ts.Expression>();
  const topDecls: ts.VariableDeclaration[] = [];

  if (ts.isBlock(comp.body)) {
    for (const statement of comp.body.statements) {
      if (!ts.isVariableStatement(statement)) continue;

      for (const declaration of statement.declarationList.declarations) {
        topDecls.push(declaration);
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          topInits.set(declaration.name.text, declaration.initializer);
        }
      }
    }
  }

  /* ---- Aliases: values and handlers derived from tracked names ---- */

  for (let pass = 0; pass < 2; pass++) {
    for (const declaration of topDecls) {
      if (!declaration.initializer) continue;
      const init = unwrapExpr(declaration.initializer);

      if (ts.isObjectBindingPattern(declaration.name)) {
        if (ts.isIdentifier(init) && scope.objects.has(init.text)) {
          const members = scope.objects.get(init.text)!;
          const taken = new Set<string>();
          let rest: string | undefined;

          for (const element of declaration.name.elements) {
            if (element.dotDotDotToken) {
              if (ts.isIdentifier(element.name)) rest = element.name.text;
              continue;
            }

            if (!ts.isIdentifier(element.name)) continue;

            const key = element.propertyName
              ? propertyNameText(element.propertyName)
              : element.name.text;

            if (key && members.has(key)) {
              scope.names.set(element.name.text, members.get(key)!);
              taken.add(key);
            }
          }

          if (rest) {
            scope.objects.set(
              rest,
              new Map([...members].filter(([key]) => !taken.has(key))),
            );
          }

          skipNodes.add(init);
          continue;
        }
      }

      if (
        ts.isObjectBindingPattern(declaration.name) ||
        ts.isArrayBindingPattern(declaration.name)
      ) {
        const refs = findRefs(init, scope);

        if (
          refs.length === 1 &&
          refs[0].node === init &&
          refs[0].role !== "object"
        ) {
          const role: Role = isWriteRole(refs[0].role) ? "handler" : "derived";
          for (const name of bindingNames(declaration.name)) {
            scope.names.set(name, role);
          }
          skipNodes.add(init);
        }
        continue;
      }

      if (!ts.isIdentifier(declaration.name)) continue;

      const local = declaration.name.text;
      if (seeds.names.has(local) || seeds.objects.has(local)) continue;
      if (isStateHookCall(init)) continue;

      if (ts.isIdentifier(init) && scope.objects.has(init.text)) {
        scope.objects.set(local, scope.objects.get(init.text)!);
        skipNodes.add(init);
        continue;
      }

      const refs = findRefs(init, scope);
      if (refs.length === 0) continue;

      if (
        refs.length === 1 &&
        refs[0].node === init &&
        refs[0].role !== "object"
      ) {
        scope.names.set(local, refs[0].role);
        skipNodes.add(init);
        continue;
      }

      scope.names.set(local, roleFromRefs(init, refs));
      computedAliases.add(local);
    }
  }

  /* ---- Classify every reference ---- */

  const refs = findRefs(comp.body, scope);
  const attributeGroups = new Map<ts.JsxAttribute, Ref[]>();

  const nearestAttribute = (node: ts.Node): ts.JsxAttribute | undefined => {
    for (
      let current: ts.Node | undefined = node.parent;
      current && current !== comp.fn;
      current = current.parent
    ) {
      if (ts.isJsxAttribute(current)) return current;
    }
    return undefined;
  };

  const elementOf = (
    attribute: ts.JsxAttribute,
  ): ts.JsxOpeningLikeElement | undefined => {
    const element = attribute.parent?.parent;
    return element &&
      (ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element))
      ? element
      : undefined;
  };

  for (const ref of refs) {
    if (skipNodes.has(ref.node)) continue;

    const outer = climbWrappers(ref.node);

    if (ref.role === "object" && outer.parent && ts.isJsxSpreadAttribute(outer.parent)) {
      continue;
    }

    // `props.children` and other members that carry no tracked state.
    if (
      ref.role === "object" &&
      outer.parent &&
      ((ts.isPropertyAccessExpression(outer.parent) &&
        outer.parent.expression === outer) ||
        (ts.isElementAccessExpression(outer.parent) &&
          outer.parent.expression === outer))
    ) {
      continue;
    }

    const attribute = nearestAttribute(ref.node);
    const element = attribute ? elementOf(attribute) : undefined;
    const isCustom = element ? isComponentTag(element.tagName.getText(sf)) : false;

    if (attribute && element && attribute.name.getText(sf) === "value") {
      const tagNode = element.tagName;
      const isProvider =
        (ts.isPropertyAccessExpression(tagNode) && tagNode.name.text === "Provider") ||
        (ts.isIdentifier(tagNode) && contextNames.has(tagNode.text));
      if (isProvider) continue;
    }

    if (attribute && element && isCustom) {
      const group = attributeGroups.get(attribute) ?? [];
      group.push(ref);
      attributeGroups.set(attribute, group);

      const initializer = attribute.initializer;
      if (
        initializer &&
        ts.isJsxExpression(initializer) &&
        initializer.expression &&
        unwrapExpr(initializer.expression) === ref.node
      ) {
        continue;
      }
    }

    // Usage of a computed alias was already counted where it was defined.
    if (
      computedAliases.has(ref.name) &&
      ref.role !== "object" &&
      ref.via === ref.name
    ) {
      continue;
    }

    const line = lineOf(sf, ref.node);
    const where = describeWhere(ref.node, comp.fn);
    const parent = outer.parent;

    if (ref.role === "object") {
      result.reads.push({ line, via: ref.via, detail: "object passed as a whole" });
      continue;
    }

    if (ref.role === "value") {
      const mutation = detectMutation(ref.node);
      if (mutation) {
        result.problems.push({
          kind: "mutation",
          line,
          snippet: mutation,
          name: ref.via,
        });
      }
    }

    if (isWriteRole(ref.role)) {
      if (parent && ts.isCallExpression(parent) && parent.expression === outer) {
        const argument = parent.arguments[0];
        const functional =
          !!argument &&
          (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));

        result.writes.push({ line, via: ref.via, detail: describeUpdate(parent) });

        if (ref.role === "setter") {
          if (!where.inFunction && !where.conditional) {
            result.problems.push({
              kind: "render-write",
              line,
              snippet: clip(parent.getText()),
              name: ref.via,
            });
          }

          if (isOwner && argument && !functional) {
            const uses = findRefs(argument, scope).filter(
              (use) => use.role === "value",
            );

            if (uses.length > 0) {
              result.problems.push({
                kind: "stale-update",
                line,
                snippet: clip(parent.getText()),
                name: ref.via,
              });
            }
          }
        }
        continue;
      }

      if (attribute && element && !isCustom) {
        result.writes.push({
          line,
          via: ref.via,
          detail: `${attribute.name.getText(sf)} on <${element.tagName.getText(sf)}>`,
        });
        continue;
      }

      if (isDependencyEntry(ref.node)) continue;

      result.writes.push({
        line,
        via: ref.via,
        detail: where.hook ? `passed inside ${where.hook}` : "passed to a function",
      });
      continue;
    }

    result.reads.push({
      line,
      via: ref.via,
      detail: where.hook
        ? `inside ${where.hook}`
        : where.inFunction
          ? "in a callback"
          : "during render",
    });
  }

  /* ---- Props handed to child components ---- */

  for (const [attribute, group] of attributeGroups) {
    const element = elementOf(attribute);
    const initializer = attribute.initializer;

    if (
      !element ||
      !initializer ||
      !ts.isJsxExpression(initializer) ||
      !initializer.expression
    ) {
      continue;
    }

    const direct =
      group.length === 1 && unwrapExpr(initializer.expression) === group[0].node;

    let role: Role;
    if (direct) role = group[0].role === "object" ? "derived" : group[0].role;
    else role = roleFromRefs(initializer.expression, group);

    result.forwards.push({
      tag: element.tagName.getText(sf),
      prop: attribute.name.getText(sf),
      role,
      direct,
      line: lineOf(sf, attribute),
      via: group[0].via,
    });
  }

  forEachNode(comp.body, (node) => {
    if (!ts.isJsxSpreadAttribute(node)) return;

    const spread = unwrapExpr(node.expression);
    if (!ts.isIdentifier(spread) || !scope.objects.has(spread.text)) return;

    const element = node.parent?.parent;
    if (
      !element ||
      !(ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element))
    ) {
      return;
    }

    const tag = element.tagName.getText(sf);
    const line = lineOf(sf, node);

    for (const [key, role] of scope.objects.get(spread.text)!) {
      if (isComponentTag(tag)) {
        result.forwards.push({
          tag,
          prop: key,
          role,
          direct: true,
          line,
          via: `${spread.text}.${key}`,
        });
      } else if (isWriteRole(role)) {
        result.writes.push({
          line,
          via: `${spread.text}.${key}`,
          detail: `spread onto <${tag}>`,
        });
      } else {
        result.reads.push({
          line,
          via: `${spread.text}.${key}`,
          detail: `spread onto <${tag}>`,
        });
      }
    }
  });

  /* ---- Context providers ---- */

  forEachNode(comp.body, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;

    const tag = node.tagName;
    let contextName: string | undefined;

    if (
      ts.isPropertyAccessExpression(tag) &&
      tag.name.text === "Provider" &&
      ts.isIdentifier(tag.expression)
    ) {
      contextName = tag.expression.text;
    } else if (ts.isIdentifier(tag) && contextNames.has(tag.text)) {
      contextName = tag.text;
    }

    if (!contextName) return;

    for (const property of node.attributes.properties) {
      if (
        !ts.isJsxAttribute(property) ||
        property.name.getText(sf) !== "value" ||
        !property.initializer ||
        !ts.isJsxExpression(property.initializer) ||
        !property.initializer.expression
      ) {
        continue;
      }

      const expression = property.initializer.expression;
      const shape = shapeOf(expression, scope);
      if (isEmptyShape(shape)) continue;

      result.provides.push({
        contextName,
        shape,
        stable: isStableContextValue(expression, topInits),
        line: lineOf(sf, node),
      });
    }
  });

  /* ---- What a custom hook hands back to its callers ---- */

  if (comp.kind === "hook") {
    const returned: ts.Expression[] = [];

    if (ts.isBlock(comp.body)) {
      const visit = (node: ts.Node) => {
        if (ts.isFunctionLike(node)) return;
        if (ts.isReturnStatement(node) && node.expression) {
          returned.push(node.expression);
        }
        ts.forEachChild(node, visit);
      };

      for (const statement of comp.body.statements) visit(statement);
    } else {
      returned.push(comp.body as ts.Expression);
    }

    for (const expression of returned) {
      const shape = shapeOf(expression, scope);
      if (!isEmptyShape(shape)) {
        result.returns = shape;
        break;
      }
    }
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/*  Bindings, channels (context and hooks) and seeds                          */
/* -------------------------------------------------------------------------- */

function bindingForCall(call: ts.CallExpression): Binding {
  const outer = climbWrappers(call);
  const parent = outer.parent;

  if (!parent) return { kind: "none" };

  if (ts.isVariableDeclaration(parent) && parent.initializer === outer) {
    const name = parent.name;

    if (ts.isIdentifier(name)) return { kind: "object", name: name.text };

    if (ts.isObjectBindingPattern(name)) {
      const map = new Map<string, string>();
      let rest: string | undefined;

      for (const element of name.elements) {
        if (!ts.isIdentifier(element.name)) continue;

        if (element.dotDotDotToken) {
          rest = element.name.text;
          continue;
        }

        const key = element.propertyName
          ? propertyNameText(element.propertyName)
          : element.name.text;

        if (key) map.set(key, element.name.text);
      }

      return { kind: "names", map, rest };
    }

    return {
      kind: "array",
      names: name.elements.map((element) =>
        ts.isBindingElement(element) && ts.isIdentifier(element.name)
          ? element.name.text
          : undefined,
      ),
    };
  }

  if (ts.isReturnStatement(parent)) return { kind: "return" };
  if (ts.isArrowFunction(parent) && parent.body === outer) {
    return { kind: "return" };
  }

  return { kind: "none" };
}

function derivedOf(role: Role): Role {
  return isWriteRole(role) ? "handler" : "derived";
}

/** Copies what a shape carries into the local names of a consumer. Returns the shape when the consumer simply returns it. */
function applyShape(
  binding: Binding,
  shape: Shape,
  seeds: Seeds,
): Shape | undefined {
  switch (binding.kind) {
    case "names": {
      for (const [key, local] of binding.map) {
        const role =
          shape.obj?.get(key) ??
          (shape.single ? derivedOf(shape.single) : undefined);
        if (role) seeds.names.set(local, role);
      }

      if (binding.rest && shape.obj) {
        seeds.objects.set(
          binding.rest,
          new Map([...shape.obj].filter(([key]) => !binding.map.has(key))),
        );
      }
      return undefined;
    }

    case "object": {
      if (shape.obj) {
        seeds.objects.set(binding.name, shape.obj);
      } else if (shape.arr) {
        seeds.objects.set(
          binding.name,
          new Map(
            shape.arr.flatMap((role, index) =>
              role ? [[String(index), role] as [string, Role]] : [],
            ),
          ),
        );
      } else if (shape.single) {
        seeds.names.set(binding.name, shape.single);
      }
      return undefined;
    }

    case "array": {
      binding.names.forEach((local, index) => {
        if (!local) return;
        const role = shape.arr?.[index] ?? shape.obj?.get(String(index));
        if (role) seeds.names.set(local, role);
      });
      return undefined;
    }

    case "return":
      return shape;

    default:
      return undefined;
  }
}

function buildChannelUses(project: Project): void {
  for (const comp of project.comps) {
    for (const call of comp.calls) {
      const name = calleeName(call.expression);
      if (!name) continue;

      let key: string | undefined;

      if ((name === "useContext" || name === "use") && call.arguments[0]) {
        const argument = unwrapExpr(call.arguments[0]);
        const contextName = ts.isIdentifier(argument)
          ? argument.text
          : ts.isPropertyAccessExpression(argument)
            ? argument.name.text
            : undefined;

        if (contextName) key = `context:${contextName}`;
      } else if (project.hooksByName.has(name) && name !== comp.name) {
        key = `hook:${name}`;
      }

      if (!key) continue;

      const uses = project.channelUses.get(key) ?? [];
      uses.push({
        channelKey: key,
        comp,
        binding: bindingForCall(call),
        line: lineOf(comp.file.sf, call),
      });
      project.channelUses.set(key, uses);
    }
  }
}

function seedsForChild(child: ComponentDef, forwards: Forward[]): Seeds {
  const seeds = emptySeeds();
  const propRoles = new Map<string, Role>();

  for (const forward of forwards) {
    if (!propRoles.has(forward.prop)) propRoles.set(forward.prop, forward.role);
  }

  const consumed = new Set<string>();

  for (const [prop, role] of propRoles) {
    const local = child.props.named.get(prop);
    if (local) {
      seeds.names.set(local, role);
      consumed.add(prop);
    }
  }

  if (child.props.objectName) {
    seeds.objects.set(child.props.objectName, new Map(propRoles));
  }

  if (child.props.rest) {
    seeds.objects.set(
      child.props.rest,
      new Map([...propRoles].filter(([key]) => !consumed.has(key))),
    );
  }

  return seeds;
}

/* -------------------------------------------------------------------------- */
/*  Project-level discovery: contexts, stores, selectors                      */
/* -------------------------------------------------------------------------- */

function collectContexts(project: Project): void {
  for (const file of project.files.values()) {
    for (const statement of file.sf.statements) {
      if (!ts.isVariableStatement(statement)) continue;

      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;

        const init = unwrapExpr(declaration.initializer);
        if (
          ts.isCallExpression(init) &&
          calleeName(init.expression) === "createContext"
        ) {
          project.contexts.set(declaration.name.text, {
            filePath: file.relPath,
            line: lineOf(file.sf, declaration),
          });
        }
      }
    }
  }
}

function findCreatorObject(
  args: readonly ts.Expression[],
): ts.ObjectLiteralExpression | undefined {
  for (const argument of args) {
    const value = unwrapExpr(argument);

    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
      if (ts.isBlock(value.body)) {
        for (const statement of value.body.statements) {
          if (ts.isReturnStatement(statement) && statement.expression) {
            const returned = unwrapExpr(statement.expression);
            if (ts.isObjectLiteralExpression(returned)) return returned;
          }
        }
      } else {
        const body = unwrapExpr(value.body);
        if (ts.isObjectLiteralExpression(body)) return body;
      }
    } else if (ts.isCallExpression(value)) {
      const nested = findCreatorObject(value.arguments);
      if (nested) return nested;
    }
  }

  return undefined;
}

function collectStores(project: Project): void {
  for (const file of project.files.values()) {
    for (const statement of file.sf.statements) {
      if (!ts.isVariableStatement(statement)) continue;

      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;

        const init = unwrapExpr(declaration.initializer);
        if (!ts.isCallExpression(init)) continue;

        const head = unwrapExpr(init.expression);
        const calleeText = ts.isCallExpression(head)
          ? calleeName(head.expression)
          : calleeName(init.expression);

        if (!calleeText) continue;

        const imported = file.imports.get(calleeText);
        if (!imported) continue;

        const line = lineOf(file.sf, declaration);

        if (
          imported.spec.startsWith("zustand") &&
          ["create", "createStore", "createWithEqualityFn"].includes(imported.imported)
        ) {
          const object = findCreatorObject(init.arguments);
          const keys = new Map<string, "value" | "action">();

          for (const property of object?.properties ?? []) {
            if (ts.isMethodDeclaration(property)) {
              const key = propertyNameText(property.name);
              if (key) keys.set(key, "action");
            } else if (ts.isPropertyAssignment(property)) {
              const key = propertyNameText(property.name);
              if (!key) continue;
              const value = unwrapExpr(property.initializer);
              keys.set(
                key,
                ts.isArrowFunction(value) || ts.isFunctionExpression(value)
                  ? "action"
                  : "value",
              );
            } else if (ts.isShorthandPropertyAssignment(property)) {
              keys.set(property.name.text, "value");
            }
          }

          project.stores.push({
            kind: "zustand",
            name: declaration.name.text,
            filePath: file.relPath,
            line,
            keys,
            actionNames: new Set(),
          });
        } else if (
          imported.spec.startsWith("jotai") &&
          [
            "atom",
            "atomWithStorage",
            "atomWithReset",
            "atomWithDefault",
          ].includes(imported.imported)
        ) {
          const first = init.arguments[0];

          project.stores.push({
            kind: "jotai",
            name: declaration.name.text,
            filePath: file.relPath,
            line,
            keys: new Map(),
            actionNames: new Set(),
            initial: first ? clip(first.getText(), 50) : undefined,
          });
        } else if (
          imported.spec.startsWith("@reduxjs/toolkit") &&
          imported.imported === "createSlice"
        ) {
          const config = init.arguments[0];
          if (!config || !ts.isObjectLiteralExpression(config)) continue;

          let sliceName = declaration.name.text;
          const actionNames = new Set<string>();
          let initial: string | undefined;

          for (const property of config.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            const key = propertyNameText(property.name);

            if (key === "name" && ts.isStringLiteralLike(property.initializer)) {
              sliceName = property.initializer.text;
            } else if (key === "initialState") {
              initial = clip(property.initializer.getText(), 50);
            } else if (
              key === "reducers" &&
              ts.isObjectLiteralExpression(property.initializer)
            ) {
              for (const reducer of property.initializer.properties) {
                const reducerName =
                  ts.isMethodDeclaration(reducer) ||
                  ts.isPropertyAssignment(reducer)
                    ? propertyNameText(reducer.name)
                    : ts.isShorthandPropertyAssignment(reducer)
                      ? reducer.name.text
                      : undefined;

                if (reducerName) actionNames.add(reducerName);
              }
            }
          }

          project.stores.push({
            kind: "redux",
            name: sliceName,
            filePath: file.relPath,
            line,
            keys: new Map(),
            actionNames,
            sliceName,
            initial,
          });
        }
      }
    }
  }

  // Named selectors such as `selectCount = (state) => state.counter.value`.
  const slices = project.stores.filter((store) => store.kind === "redux");

  if (slices.length > 0) {
    for (const file of project.files.values()) {
      for (const statement of file.sf.statements) {
        if (!ts.isVariableStatement(statement)) continue;

        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
          if (!/^(select|get)[A-Z]/.test(declaration.name.text)) continue;

          const text = declaration.initializer.getText();

          for (const slice of slices) {
            if (new RegExp(`\\.${slice.sliceName}\\b`).test(text)) {
              project.selectorSlices.set(declaration.name.text, slice.sliceName!);
              break;
            }
          }
        }
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Flow propagation                                                          */
/* -------------------------------------------------------------------------- */

function newFlow(): Flow {
  return {
    nodes: new Map(),
    hops: [],
    reads: [],
    writes: [],
    problems: [],
    contexts: new Map(),
    truncated: false,
  };
}

function propagate(
  stateNode: { id: string; label: string; type: "state" | "store" },
  starts: Array<Task & { prop: string; role: Role; line: number }>,
  project: Project,
  cache: Map<string, CompResult>,
  contextNames: Set<string>,
): Flow {
  const flow = newFlow();
  const queue: Task[] = [];
  const queued = new Set<string>();
  const hopKeys = new Set<string>();
  const accessKeys = new Set<string>();
  const problemKeys = new Set<string>();
  const delivered = new Set<string>();

  flow.nodes.set(stateNode.id, {
    id: stateNode.id,
    label: stateNode.label,
    type: stateNode.type === "store" ? "store" : "state",
    depth: 0,
    reads: 0,
    writes: 0,
    forwardsOut: 0,
    isOwner: false,
    isExternal: false,
  });

  const ensureCompNode = (comp: ComponentDef, depth: number): NodeAcc => {
    const existing = flow.nodes.get(comp.id);
    if (existing) {
      existing.depth = Math.min(existing.depth, depth);
      return existing;
    }

    const node: NodeAcc = {
      id: comp.id,
      label: comp.name,
      filePath: comp.filePath,
      type: comp.kind === "hook" ? "hook" : "component",
      depth,
      reads: 0,
      writes: 0,
      forwardsOut: 0,
      isOwner: false,
      isExternal: false,
    };
    flow.nodes.set(comp.id, node);
    return node;
  };

  const addHop = (hop: FlowHop) => {
    const key = `${hop.fromId}|${hop.toId}|${hop.prop}|${hop.kind}`;
    if (hopKeys.has(key)) return;
    hopKeys.add(key);
    flow.hops.push(hop);
  };

  const enqueue = (task: Task) => {
    if (task.depth > MAX_FLOW_DEPTH) {
      flow.truncated = true;
      return;
    }

    const key = `${task.comp.id}|${task.isOwner ? 1 : 0}|${seedSignature(task.seeds)}`;
    if (queued.has(key)) return;
    queued.add(key);
    queue.push(task);
  };

  const deliver = (
    channelKey: string,
    shape: Shape,
    fromId: string,
    fromLabel: string,
    depth: number,
    kind: HopKind,
  ) => {
    const guard = `${channelKey}|${fromId}`;
    if (delivered.has(guard)) return;
    delivered.add(guard);

    for (const use of project.channelUses.get(channelKey) ?? []) {
      const seeds = emptySeeds();
      const returned = applyShape(use.binding, shape, seeds);

      if (returned) {
        if (use.comp.kind === "hook") {
          const node = ensureCompNode(use.comp, depth + 1);

          addHop({
            fromId,
            from: fromLabel,
            toId: node.id,
            to: node.label,
            prop: `${channelKey.split(":")[1]}()`,
            role: shapeRole(returned),
            kind,
            line: use.line,
            depth: depth + 1,
          });

          deliver(
            `hook:${use.comp.name}`,
            returned,
            node.id,
            node.label,
            depth + 1,
            "hook",
          );
        }
        continue;
      }

      if (seedsEmpty(seeds)) continue;

      const node = ensureCompNode(use.comp, depth + 1);

      addHop({
        fromId,
        from: fromLabel,
        toId: node.id,
        to: node.label,
        prop:
          kind === "context"
            ? `useContext(${channelKey.split(":")[1]})`
            : `${channelKey.split(":")[1]}()`,
        role: shapeRole(shape),
        kind,
        line: use.line,
        depth: depth + 1,
      });

      const contextName =
        kind === "context" ? channelKey.split(":")[1] : undefined;
      if (contextName) flow.contexts.get(contextName)?.consumers.add(use.comp.id);

      enqueue({ comp: use.comp, seeds, depth: depth + 1, isOwner: false });
    }
  };

  for (const start of starts) {
    const node = ensureCompNode(start.comp, start.depth);
    node.isOwner = start.isOwner;

    addHop({
      fromId: stateNode.id,
      from: stateNode.label,
      toId: node.id,
      to: node.label,
      prop: start.prop,
      role: start.role,
      kind: stateNode.type === "store" ? "store" : "prop",
      line: start.line,
      depth: start.depth,
    });

    enqueue(start);
  }

  let steps = 0;

  while (queue.length > 0) {
    const task = queue.shift()!;

    if (++steps > MAX_TASKS_PER_UNIT) {
      flow.truncated = true;
      break;
    }

    const cacheKey = `${task.comp.id}|${task.isOwner ? 1 : 0}|${seedSignature(task.seeds)}`;
    let result = cache.get(cacheKey);

    if (!result) {
      result = analyzeComponent(task.comp, task.seeds, task.isOwner, contextNames);
      cache.set(cacheKey, result);
    }

    const node = ensureCompNode(task.comp, task.depth);

    const record = (
      list: StateAccess[],
      accesses: RawAccess[],
      counter: "reads" | "writes",
    ) => {
      for (const access of accesses) {
        const key = `${task.comp.id}|${counter}|${access.line}|${access.via}|${access.detail}`;
        if (accessKeys.has(key)) continue;
        accessKeys.add(key);
        node[counter]++;
        list.push({
          component: task.comp.name,
          filePath: task.comp.filePath,
          line: access.line,
          via: access.via,
          detail: access.detail,
        });
      }
    };

    record(flow.reads, result.reads, "reads");
    record(flow.writes, result.writes, "writes");

    for (const problem of result.problems) {
      const key = `${task.comp.id}|${problem.kind}|${problem.line}`;
      if (problemKeys.has(key)) continue;
      problemKeys.add(key);
      flow.problems.push({
        ...problem,
        component: task.comp.name,
        filePath: task.comp.filePath,
      });
    }

    /* ---- Props handed to children ---- */

    const byChild = new Map<string, { child: ComponentDef; items: Forward[] }>();

    for (const forward of result.forwards) {
      const child = resolveTag(task.comp.file, forward.tag, project);

      if (!child) {
        if (!forward.direct) continue;

        const detail = `passed to <${forward.tag}> as ${forward.prop}`;
        const access: RawAccess = {
          line: forward.line,
          via: forward.via,
          detail,
        };

        if (isWriteRole(forward.role)) record(flow.writes, [access], "writes");
        else record(flow.reads, [access], "reads");

        const externalId = `ext:${forward.tag}`;
        if (!flow.nodes.has(externalId)) {
          flow.nodes.set(externalId, {
            id: externalId,
            label: forward.tag,
            type: "component",
            depth: task.depth + 1,
            reads: 0,
            writes: 0,
            forwardsOut: 0,
            isOwner: false,
            isExternal: true,
          });
        }

        node.forwardsOut++;
        addHop({
          fromId: node.id,
          from: node.label,
          toId: externalId,
          to: forward.tag,
          prop: forward.prop,
          role: forward.role,
          kind: "prop",
          line: forward.line,
          depth: task.depth + 1,
        });
        continue;
      }

      const group = byChild.get(child.id) ?? { child, items: [] };
      group.items.push(forward);
      byChild.set(child.id, group);
    }

    for (const { child, items } of byChild.values()) {
      const childNode = ensureCompNode(child, task.depth + 1);
      node.forwardsOut += items.length;

      for (const item of items) {
        addHop({
          fromId: node.id,
          from: node.label,
          toId: childNode.id,
          to: childNode.label,
          prop: item.prop,
          role: item.role,
          kind: "prop",
          line: item.line,
          depth: task.depth + 1,
        });
      }

      const seeds = seedsForChild(child, items);
      if (seedsEmpty(seeds)) continue;

      enqueue({ comp: child, seeds, depth: task.depth + 1, isOwner: false });
    }

    /* ---- Context providers ---- */

    for (const provided of result.provides) {
      const contextId = `ctx:${provided.contextName}`;
      const depth = task.depth + 1;

      if (!flow.nodes.has(contextId)) {
        flow.nodes.set(contextId, {
          id: contextId,
          label: provided.contextName,
          filePath: project.contexts.get(provided.contextName)?.filePath,
          type: "context",
          depth,
          reads: 0,
          writes: 0,
          forwardsOut: 0,
          isOwner: false,
          isExternal: false,
        });
      }

      if (!flow.contexts.has(provided.contextName)) {
        flow.contexts.set(provided.contextName, {
          name: provided.contextName,
          stable: provided.stable,
          line: provided.line,
          filePath: task.comp.filePath,
          component: task.comp.name,
          consumers: new Set(),
        });
      }

      node.forwardsOut++;
      addHop({
        fromId: node.id,
        from: node.label,
        toId: contextId,
        to: provided.contextName,
        prop: shapeKeys(provided.shape).slice(0, 3).join(", ") || "value",
        role: shapeRole(provided.shape),
        kind: "context",
        line: provided.line,
        depth,
      });

      deliver(
        `context:${provided.contextName}`,
        provided.shape,
        contextId,
        provided.contextName,
        depth,
        "context",
      );
    }

    /* ---- Hook results ---- */

    if (task.comp.kind === "hook" && result.returns) {
      deliver(
        `hook:${task.comp.name}`,
        result.returns,
        node.id,
        node.label,
        task.depth,
        "hook",
      );
    }
  }

  return flow;
}

/* -------------------------------------------------------------------------- */
/*  Store consumers (Redux, Zustand, Jotai)                                   */
/* -------------------------------------------------------------------------- */

function storeStarts(
  store: StoreInfo,
  project: Project,
): {
  starts: Array<Task & { prop: string; role: Role; line: number }>;
  extraReads: Array<{ comp: ComponentDef; access: RawAccess }>;
  extraWrites: Array<{ comp: ComponentDef; access: RawAccess }>;
} {
  const starts: Array<Task & { prop: string; role: Role; line: number }> = [];
  const extraReads: Array<{ comp: ComponentDef; access: RawAccess }> = [];
  const extraWrites: Array<{ comp: ComponentDef; access: RawAccess }> = [];

  for (const comp of project.comps) {
    const sf = comp.file.sf;
    const seeds = emptySeeds();
    let prop = "";
    let role: Role = "value";
    let firstLine = comp.line;

    const markStart = (line: number, label: string, kindRole: Role) => {
      if (!prop) {
        prop = label;
        role = kindRole;
        firstLine = line;
      }
    };

    for (const call of comp.calls) {
      const name = calleeName(call.expression);
      if (!name) continue;
      const line = lineOf(sf, call);
      const binding = bindingForCall(call);

      if (store.kind === "zustand" && name === store.name) {
        const selector = call.arguments[0];
        const before = seeds.names.size + seeds.objects.size;

        if (selector && (ts.isArrowFunction(selector) || ts.isFunctionExpression(selector))) {
          const param = selector.parameters[0]?.name;
          const body = ts.isBlock(selector.body) ? undefined : unwrapExpr(selector.body);

          if (
            param &&
            ts.isIdentifier(param) &&
            body &&
            ts.isPropertyAccessExpression(body) &&
            ts.isIdentifier(body.expression) &&
            body.expression.text === param.text &&
            binding.kind === "object"
          ) {
            const field = body.name.text;
            const fieldRole: Role =
              store.keys.get(field) === "action" ? "setter" : "value";
            seeds.names.set(binding.name, fieldRole);
            markStart(line, field, fieldRole);
          } else if (binding.kind === "object") {
            seeds.names.set(binding.name, "derived");
            markStart(line, "selector", "derived");
          }
        } else if (!selector) {
          const all = new Map<string, Role>(
            [...store.keys].map(([key, kind]) => [
              key,
              kind === "action" ? "setter" : "value",
            ]),
          );

          if (binding.kind === "names") {
            for (const [key, local] of binding.map) {
              const keyRole = all.get(key);
              if (keyRole) seeds.names.set(local, keyRole);
            }
            markStart(line, [...binding.map.keys()].slice(0, 3).join(", "), "value");
          } else if (binding.kind === "object") {
            seeds.objects.set(binding.name, all);
            markStart(line, `${store.name}()`, "value");
          }
        }

        if (seeds.names.size + seeds.objects.size === before) {
          extraReads.push({
            comp,
            access: { line, via: store.name, detail: `subscribes with ${store.name}()` },
          });
          markStart(line, `${store.name}()`, "value");
        }
      } else if (store.kind === "jotai") {
        const argument = call.arguments[0];
        const usesAtom =
          argument && ts.isIdentifier(unwrapExpr(argument)) &&
          (unwrapExpr(argument) as ts.Identifier).text === store.name;

        if (!usesAtom) continue;

        if (name === "useAtom") {
          if (binding.kind === "array") {
            if (binding.names[0]) seeds.names.set(binding.names[0], "value");
            if (binding.names[1]) seeds.names.set(binding.names[1], "setter");
          }
          markStart(line, "useAtom", "value");
        } else if (name === "useAtomValue") {
          if (binding.kind === "object") seeds.names.set(binding.name, "value");
          else
            extraReads.push({
              comp,
              access: { line, via: store.name, detail: "useAtomValue" },
            });
          markStart(line, "useAtomValue", "value");
        } else if (name === "useSetAtom") {
          if (binding.kind === "object") seeds.names.set(binding.name, "setter");
          markStart(line, "useSetAtom", "setter");
        }
      } else if (store.kind === "redux") {
        const selectorHooks = /^use(App)?Selector$/;

        if (selectorHooks.test(name)) {
          const argument = call.arguments[0];
          if (!argument) continue;

          const value = unwrapExpr(argument);
          const matches = ts.isIdentifier(value)
            ? project.selectorSlices.get(value.text) === store.sliceName
            : new RegExp(`\\.${store.sliceName}\\b`).test(value.getText());

          if (!matches) continue;

          if (binding.kind === "object") seeds.names.set(binding.name, "value");
          else if (binding.kind === "names") {
            for (const local of binding.map.values()) seeds.names.set(local, "derived");
          } else {
            extraReads.push({
              comp,
              access: { line, via: store.name, detail: `${name}()` },
            });
          }

          markStart(line, `${name}()`, "value");
        } else if (name === "dispatch" || name.endsWith("Dispatch")) {
          const action = call.arguments[0];
          if (!action) continue;

          const value = unwrapExpr(action);
          if (!ts.isCallExpression(value)) continue;

          const actionName = calleeName(value.expression);
          if (actionName && store.actionNames.has(actionName)) {
            extraWrites.push({
              comp,
              access: {
                line,
                via: "dispatch",
                detail: `${actionName}()`,
              },
            });
            markStart(line, `dispatch(${actionName})`, "setter");
          }
        }
      }
    }

    if (prop) {
      starts.push({
        comp,
        seeds,
        depth: 1,
        isOwner: false,
        prop,
        role,
        line: firstLine,
      });
    }
  }

  return { starts, extraReads, extraWrites };
}

/* -------------------------------------------------------------------------- */
/*  Issue detection                                                           */
/* -------------------------------------------------------------------------- */

function severityOfMax(issues: StateIssue[]): Severity {
  for (const severity of SEVERITY_ORDER) {
    if (issues.some((issue) => issue.severity === severity)) return severity;
  }
  return "info";
}

function makeIssue(
  type: IssueType,
  severity: Severity,
  filePath: string,
  line: number,
  title: string,
  description: string,
  suggestion: IssueSuggestion,
  snippet?: string,
  discriminator = "",
): StateIssue {
  return {
    id: hashId(type, filePath, line, discriminator),
    type,
    severity,
    title,
    description,
    filePath,
    line,
    snippet,
    suggestion,
  };
}

function isPureEffect(
  callback: ts.Node,
  setterNames: Set<string>,
): boolean {
  let pure = true;

  forEachNode(callback, (node) => {
    if (!pure) return;

    if (
      ts.isAwaitExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isYieldExpression(node)
    ) {
      pure = false;
      return;
    }

    if (ts.isReturnStatement(node) && node.expression) {
      const value = unwrapExpr(node.expression);
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
        pure = false;
      }
      return;
    }

    if (!ts.isCallExpression(node)) return;

    const callee = unwrapExpr(node.expression);

    if (ts.isIdentifier(callee)) {
      if (!setterNames.has(callee.text)) pure = false;
      return;
    }

    if (ts.isPropertyAccessExpression(callee)) {
      const object = unwrapExpr(callee.expression);
      if (
        PURE_METHODS.has(callee.name.text) ||
        (ts.isIdentifier(object) && PURE_GLOBALS.has(object.text))
      ) {
        return;
      }
    }

    pure = false;
  });

  return pure;
}

function detectDerivedState(
  def: UnitDef,
): Array<{ line: number; kind: "from-props" | "effect-copy"; snippet: string }> {
  const found: Array<{
    line: number;
    kind: "from-props" | "effect-copy";
    snippet: string;
  }> = [];

  const comp = def.ownerComp;
  if (!comp || def.kind !== "useState" || !def.setter) return found;

  const sf = comp.file.sf;
  const propLocals = new Set(comp.props.named.values());
  const propObject = comp.props.objectName;

  const setterNames = new Set<string>();
  for (const declaration of comp.decls) {
    if (
      ts.isArrayBindingPattern(declaration.name) &&
      declaration.initializer &&
      ts.isCallExpression(unwrapExpr(declaration.initializer)) &&
      calleeName((unwrapExpr(declaration.initializer) as ts.CallExpression).expression) ===
        "useState"
    ) {
      const second = declaration.name.elements[1];
      if (second && ts.isBindingElement(second) && ts.isIdentifier(second.name)) {
        setterNames.add(second.name.text);
      }
    }
  }

  for (const declaration of comp.decls) {
    if (
      !ts.isArrayBindingPattern(declaration.name) ||
      !declaration.initializer
    ) {
      continue;
    }

    const call = unwrapExpr(declaration.initializer);
    if (!ts.isCallExpression(call) || calleeName(call.expression) !== "useState") {
      continue;
    }

    const second = declaration.name.elements[1];
    const isThisState =
      second &&
      ts.isBindingElement(second) &&
      ts.isIdentifier(second.name) &&
      second.name.text === def.setter;

    if (!isThisState || !call.arguments[0]) continue;

    let copiedProp: string | undefined;

    forEachNode(call.arguments[0], (node) => {
      if (copiedProp) return;

      if (
        ts.isIdentifier(node) &&
        propLocals.has(node.text) &&
        isReferenceIdentifier(node)
      ) {
        copiedProp = node.text;
      } else if (
        ts.isPropertyAccessExpression(node) &&
        propObject &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === propObject
      ) {
        copiedProp = node.name.text;
      }
    });

    if (copiedProp && !/^(initial|default)/i.test(copiedProp)) {
      found.push({
        line: lineOf(sf, declaration),
        kind: "from-props",
        snippet: clip(declaration.getText()),
      });
    }
  }

  for (const call of comp.calls) {
    const name = calleeName(call.expression);
    if (name !== "useEffect" && name !== "useLayoutEffect") continue;

    const callback = call.arguments[0];
    const deps = call.arguments[1];

    if (
      !callback ||
      !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ||
      !deps ||
      !ts.isArrayLiteralExpression(deps) ||
      deps.elements.length === 0
    ) {
      continue;
    }

    let callsSetter = false;
    forEachNode(callback.body, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === def.setter
      ) {
        callsSetter = true;
      }
    });

    if (callsSetter && isPureEffect(callback.body, setterNames)) {
      found.push({
        line: lineOf(sf, call),
        kind: "effect-copy",
        snippet: clip(call.getText(), 80),
      });
    }
  }

  return found;
}

function suggestionDrilling(
  def: UnitDef,
  chain: string[],
  consumers: string[],
): IssueSuggestion {
  const base = pascal(def.name);
  const value = def.valueName ?? def.name;
  const setter = def.setter ?? `set${base}`;
  const isStore = def.kind === "redux" || def.kind === "zustand" || def.kind === "jotai";

  if (isStore) {
    return {
      title: "Read the store where it is used",
      summary: `${def.name} already lives in a shared store, so ${chain.join(
        ", ",
      )} do not need to forward it. Subscribe in the components that render it.`,
      steps: [
        `Remove the ${value} prop from ${chain.join(", ")}.`,
        `Select only the field you need inside ${consumers.join(", ") || "the consuming component"}.`,
        "Keep selectors narrow so unrelated store updates do not re-render the component.",
      ],
      caveats: [
        "Components that read from a store directly are harder to reuse outside that store.",
      ],
    };
  }

  const code = `type ${base}ContextValue = {
  ${value}: unknown; // use the real type
  ${setter}: React.Dispatch<React.SetStateAction<unknown>>;
};

const ${base}Context = createContext<${base}ContextValue | null>(null);

export function ${base}Provider({ children }: { children: React.ReactNode }) {
  const [${value}, ${setter}] = useState(${def.initial ?? "undefined"});
  const api = useMemo(() => ({ ${value}, ${setter} }), [${value}]);

  return (
    <${base}Context.Provider value={api}>{children}</${base}Context.Provider>
  );
}

export function use${base}() {
  const context = useContext(${base}Context);
  if (!context) throw new Error("use${base} must be used inside <${base}Provider>");
  return context;
}

// In ${consumers[0] ?? "the consuming component"}:
// const { ${value}, ${setter} } = use${base}();`;

  return {
    title: "Share the state with a context or restructure the tree",
    summary: `${chain.join(" → ")} only forward ${def.name}. Move it to a context, or pass the finished UI down as children so the middle layers stop caring.`,
    steps: [
      `Create a ${base}Context and a ${base}Provider that owns the state.`,
      `Wrap the part of the tree that needs it in <${base}Provider>.`,
      `Read it with use${base}() in ${consumers.join(", ") || "the consuming components"}.`,
      `Delete the ${def.name} props from ${chain.join(", ")}.`,
    ],
    code,
    caveats: [
      "Every consumer re-renders when the context value changes. Split read and write contexts if the value updates often.",
      "If only one or two levels are involved, passing the element itself as children or a render prop can be simpler than a context.",
    ],
  };
}

function buildIssues(
  def: UnitDef,
  flow: Flow,
  drillDepth: number,
  passThrough: string[],
  minDrillDepth: number,
  consumerNames: string[],
): StateIssue[] {
  const issues: StateIssue[] = [];
  const isLocal = def.kind === "useState" || def.kind === "useReducer";
  const base = pascal(def.name);
  const value = def.valueName ?? def.name;
  const setter = def.setter ?? `set${base}`;

  const readCount = flow.reads.length;
  const writeCount = flow.writes.length;
  const writerComponents = new Set(flow.writes.map((item) => item.filePath + item.component));

  /* ---- Prop drilling ---- */

  if (drillDepth >= minDrillDepth) {
    issues.push(
      makeIssue(
        "prop-drilling",
        drillDepth >= 3 ? "high" : "medium",
        def.filePath,
        def.line,
        `Passed through ${drillDepth} components that never use it`,
        `${def.name} is declared in ${def.owner} and handed down through ${passThrough.join(
          " → ",
        )} before it is used${
          consumerNames.length > 0 ? ` in ${consumerNames.join(", ")}` : ""
        }. Each of those components has to know about a value it does not need, so renaming or changing it means editing every layer.`,
        suggestionDrilling(def, passThrough, consumerNames),
        undefined,
        def.name,
      ),
    );
  }

  /* ---- Unused, write-only and constant state ---- */

  if (isLocal && def.setter) {
    const hasValue = !!def.valueName;

    if (hasValue && readCount === 0 && writeCount === 0) {
      issues.push(
        makeIssue(
          "unused-state",
          "medium",
          def.filePath,
          def.line,
          "State is never read or updated",
          `${value} and ${setter} are declared in ${def.owner} but nothing reads the value or calls the setter, including components it is passed to.`,
          {
            title: "Remove the state",
            summary: "Unused state still costs a hook slot and confuses readers.",
            steps: [
              `Delete the ${def.kind} call for ${value}.`,
              "Remove any props or imports that only existed for it.",
            ],
            caveats: [
              "If it is read through a pattern the analyzer cannot follow (for example eval or string keys), keep it.",
            ],
          },
          undefined,
          def.name,
        ),
      );
    } else if (hasValue && readCount === 0 && writeCount > 0) {
      issues.push(
        makeIssue(
          "write-only-state",
          "medium",
          def.filePath,
          def.line,
          "State is updated but never read",
          `${setter} is called ${writeCount} time${writeCount === 1 ? "" : "s"} but nothing renders or uses ${value}. Each update schedules a re-render that shows nothing different.`,
          {
            title: "Use a ref instead of state",
            summary:
              "A value that does not affect the UI belongs in a ref, which updates without re-rendering.",
            steps: [
              `Replace the state with const ${value}Ref = useRef(${def.initial ?? "undefined"}).`,
              `Change ${setter}(next) to ${value}Ref.current = next.`,
              "If nothing needs the value at all, delete it.",
            ],
            code: `// before\nconst [${value}, ${setter}] = useState(${def.initial ?? "undefined"});\n\n// after\nconst ${value}Ref = useRef(${def.initial ?? "undefined"});\n${value}Ref.current = nextValue;`,
            caveats: [
              "Refs do not trigger renders. If the UI should react to the value later, keep it as state.",
            ],
          },
          undefined,
          def.name,
        ),
      );
    } else if (readCount > 0 && writeCount === 0) {
      issues.push(
        makeIssue(
          "never-updated",
          "low",
          def.filePath,
          def.line,
          "State is never updated",
          `${value} is read in ${readCount} place${readCount === 1 ? "" : "s"} but ${setter} is never called or passed anywhere, so it always holds ${def.initial ?? "its initial value"}.`,
          {
            title: "Turn it into a constant or a prop",
            summary:
              "State that never changes adds noise. A constant or a prop says what it really is.",
            steps: [
              `Replace the useState call with const ${value} = ${def.initial ?? "…"}.`,
              "Move the constant outside the component if it does not depend on props.",
            ],
            caveats: [
              "If a child component updates it through a pattern the analyzer cannot see, keep the state.",
            ],
          },
          undefined,
          def.name,
        ),
      );
    }
  }

  /* ---- Derived state ---- */

  for (const derived of detectDerivedState(def)) {
    if (derived.kind === "from-props") {
      issues.push(
        makeIssue(
          "derived-state",
          "low",
          def.filePath,
          derived.line,
          "State is initialised from a prop",
          `${value} starts as a copy of a prop. When the prop changes later, this state keeps the old value, which is a common source of stale UI.`,
          {
            title: "Use the prop directly, or reset with a key",
            summary:
              "Read the prop during render. If the user edits a local copy, reset it by giving the component a key that changes with the prop.",
            steps: [
              "If the copy is never edited, delete the state and use the prop.",
              "If it is edited, name the prop initialX and render <Component key={id} initialX={…} /> so it remounts when the source changes.",
            ],
            caveats: ["Props named initial… or default… are skipped by this check."],
          },
          derived.snippet,
          `${def.name}:init`,
        ),
      );
    } else {
      issues.push(
        makeIssue(
          "derived-state",
          "medium",
          def.filePath,
          derived.line,
          "State is copied from other values in an effect",
          `An effect recomputes ${value} whenever its dependencies change. That causes an extra render with stale data in between, and it can drift out of sync.`,
          {
            title: "Compute the value during render",
            summary:
              "A value that can be calculated from props or other state does not need its own state.",
            steps: [
              `Delete ${value}, ${setter} and the effect.`,
              `Compute ${value} inline, or wrap it in useMemo if it is expensive.`,
            ],
            code: `// before\nconst [${value}, ${setter}] = useState(…);\nuseEffect(() => {\n  ${setter}(compute(deps));\n}, [deps]);\n\n// after\nconst ${value} = useMemo(() => compute(deps), [deps]);`,
            caveats: [
              "Keep the effect if it also talks to something outside React, such as a network call or a subscription.",
            ],
          },
          derived.snippet,
          `${def.name}:effect`,
        ),
      );
    }
  }

  /* ---- State declared too high ---- */

  if (isLocal) {
    const owner = [...flow.nodes.values()].find((node) => node.isOwner);
    const consumers = [...flow.nodes.values()].filter(
      (node) => node.type !== "state" && !node.isOwner && (node.reads > 0 || node.writes > 0),
    );

    if (
      owner &&
      owner.reads === 0 &&
      owner.writes === 0 &&
      owner.forwardsOut > 0 &&
      flow.contexts.size === 0 &&
      consumers.length === 1 &&
      !consumers[0].isExternal
    ) {
      const target = consumers[0].label;
      issues.push(
        makeIssue(
          "state-too-high",
          drillDepth > 0 ? "medium" : "low",
          def.filePath,
          def.line,
          `${def.owner} only passes this state to ${target}`,
          `${def.owner} never reads or updates ${def.name}. Every use happens in ${target}, so the state sits higher than it needs to.`,
          {
            title: `Move the state into ${target}`,
            summary:
              "State should live in the lowest component that needs it. That also keeps updates from re-rendering the parent.",
            steps: [
              `Cut the ${def.kind} call from ${def.owner} and paste it into ${target}.`,
              `Remove the ${def.name} props from ${def.owner} and any components between them.`,
            ],
            caveats: [
              `If another component will need ${def.name} soon, keep it where it is.`,
            ],
          },
          undefined,
          def.name,
        ),
      );
    }
  }

  /* ---- Direct mutation, render-phase updates, non-functional updates ---- */

  const mutations = flow.problems.filter((problem) => problem.kind === "mutation");

  for (const problem of mutations.slice(0, MAX_MUTATION_ISSUES)) {
    const method = /\.(\w+)\(…\)$/.exec(problem.snippet)?.[1];
    const fix =
      method === "push"
        ? `${setter}((prev) => [...prev, item])`
        : method === "splice"
          ? `${setter}((prev) => prev.filter((_, i) => i !== index))`
          : method === "sort" || method === "reverse"
            ? `${setter}((prev) => [...prev].${method}())`
            : `${setter}((prev) => ({ ...prev, key: nextValue }))`;

    issues.push(
      makeIssue(
        "direct-mutation",
        "high",
        problem.filePath,
        problem.line,
        "State is changed in place",
        `${problem.snippet} in ${problem.component} changes the existing ${def.name} object or array. React compares by reference, so it may not re-render, and other components holding the same reference see the change unexpectedly.`,
        {
          title: "Create a new value instead",
          summary: "Copy the array or object, change the copy, and pass it to the setter.",
          steps: [
            "Replace the in-place change with a copy: spread for objects and arrays, filter or map for removals and edits.",
            `Pass the new value to ${setter} or dispatch an action.`,
            "Use [...items].sort() so sorting does not reorder the original.",
          ],
          code: `// before\n${problem.snippet}\n\n// after\n${fix}`,
          caveats: [
            "Nested objects need nested copies, or a helper such as Immer, to stay immutable.",
          ],
        },
        problem.snippet,
        `${def.name}:${problem.snippet}`,
      ),
    );
  }

  for (const problem of flow.problems.filter((item) => item.kind === "render-write")) {
    issues.push(
      makeIssue(
        "render-phase-update",
        "critical",
        problem.filePath,
        problem.line,
        "State is updated while rendering",
        `${problem.snippet} runs every time ${problem.component} renders and is not inside a handler, an effect, or a condition. Updating state during render triggers another render, which calls it again, so this can loop forever.`,
        {
          title: "Move the update out of render",
          summary:
            "Update state in an event handler or an effect, or compute the value during render instead.",
          steps: [
            "If it reacts to a user action, call it from the event handler.",
            "If it reacts to a prop or state change, derive the value during render instead of storing it.",
            "If you must adjust state from props, guard it with a condition that becomes false after one update.",
          ],
          caveats: [],
        },
        problem.snippet,
        problem.snippet,
      ),
    );
  }

  const stale = flow.problems.filter((problem) => problem.kind === "stale-update");

  if (stale.length > 0) {
    const first = stale[0];
    issues.push(
      makeIssue(
        "stale-update",
        "info",
        first.filePath,
        first.line,
        `New state is built from the current value ${stale.length === 1 ? "once" : `${stale.length} times`}`,
        `${first.snippet} reads ${value} from the render it was created in. When several updates run in a row, or the call runs in a timer or effect, it can overwrite newer changes.`,
        {
          title: "Use a functional update",
          summary:
            "Pass a function to the setter so React hands you the latest value.",
          steps: [
            `Change ${setter}(${value} + 1) to ${setter}((prev) => prev + 1).`,
            "Apply the same change to the other updates listed in this file.",
          ],
          code: `${setter}((prev) => /* compute next from prev */ prev);`,
          caveats: [
            "Not needed when the new value does not depend on the old one.",
          ],
        },
        first.snippet,
        def.name,
      ),
    );
  }

  /* ---- Context value identity ---- */

  for (const context of flow.contexts.values()) {
    if (context.stable) continue;

    const consumers = context.consumers.size;

    issues.push(
      makeIssue(
        "unstable-context-value",
        consumers >= 6 ? "high" : consumers >= 3 ? "medium" : "low",
        context.filePath,
        context.line,
        `${context.name} value is a new object on every render`,
        `${context.component} passes an inline object or function as the value of ${context.name}.Provider. It gets a new identity on every render, so all ${consumers} consumer${consumers === 1 ? "" : "s"} re-render each time ${context.component} does, even when ${def.name} did not change.`,
        {
          title: "Memoize the context value",
          summary:
            "Wrap the value in useMemo, and wrap function members in useCallback, so the identity only changes with the data.",
          steps: [
            "Build the value with useMemo and list the state it contains as dependencies.",
            "Wrap functions in the value in useCallback.",
            "If some consumers only need the setters, split them into a second context so they skip updates.",
          ],
          code: `const api = useMemo(() => ({ ${value}, ${setter} }), [${value}]);\n\nreturn <${context.name}.Provider value={api}>{children}</${context.name}.Provider>;`,
          caveats: [
            "useMemo only helps when the provider re-renders for other reasons. If it renders only when the state changes, the gain is small.",
          ],
        },
        undefined,
        context.name,
      ),
    );
  }

  /* ---- Scattered updates ---- */

  const scatterLimit = isLocal ? 4 : 6;

  if (writerComponents.size >= scatterLimit) {
    issues.push(
      makeIssue(
        "scattered-updates",
        "low",
        def.filePath,
        def.line,
        `${writerComponents.size} components update this state`,
        `${def.name} is changed from ${writerComponents.size} different components. With that many writers it is hard to see which rule produced the current value.`,
        {
          title: "Centralise the update logic",
          summary:
            "Expose a small set of named actions instead of letting every component set the raw value.",
          steps: [
            isLocal
              ? "Move the state into a useReducer with named actions, or into a context that exposes functions like addItem and removeItem."
              : "Add named actions to the store and call those instead of setting fields from components.",
            "Replace direct setter calls in the writers with the named actions.",
          ],
          caveats: [
            "Many writers are fine when they all perform the same simple update, such as a toggle.",
          ],
        },
        undefined,
        def.name,
      ),
    );
  }

  const seen = new Set<string>();
  return issues.filter((issue) => {
    if (seen.has(issue.id)) return false;
    seen.add(issue.id);
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/*  Graph assembly                                                            */
/* -------------------------------------------------------------------------- */

function classifyNode(node: NodeAcc): NodeBehavior {
  if (node.type === "state") return "state";
  if (node.type === "store") return "store";
  if (node.type === "context") return "context";
  if (node.isExternal) return "external";
  if (node.isOwner) return "owner";
  if (node.type === "hook" && node.reads === 0 && node.writes === 0) {
    return "pass-through";
  }
  if (node.forwardsOut > 0 && node.reads === 0 && node.writes === 0) {
    return "pass-through";
  }
  if (node.reads > 0 && node.writes > 0) return "reader-writer";
  if (node.reads > 0) return "reader";
  if (node.writes > 0) return "writer";
  return "idle";
}

function measureFlow(flow: Flow): {
  drillDepth: number;
  passThrough: string[];
  behaviors: Map<string, NodeBehavior>;
} {
  const behaviors = new Map<string, NodeBehavior>();
  for (const node of flow.nodes.values()) behaviors.set(node.id, classifyNode(node));

  const isPassThrough = (id: string) =>
    behaviors.get(id) === "pass-through" && flow.nodes.get(id)?.type !== "hook";

  const adjacency = new Map<string, string[]>();
  const hasIncoming = new Set<string>();

  for (const hop of flow.hops) {
    if (hop.kind !== "prop") continue;
    const list = adjacency.get(hop.fromId) ?? [];
    list.push(hop.toId);
    adjacency.set(hop.fromId, list);
    hasIncoming.add(hop.toId);
  }

  const memo = new Map<string, number>();
  const trail = new Set<string>();

  const longest = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;

    trail.add(id);
    let best = 0;

    for (const next of adjacency.get(id) ?? []) {
      if (trail.has(next)) continue;
      best = Math.max(best, (isPassThrough(next) ? 1 : 0) + longest(next));
    }

    trail.delete(id);
    memo.set(id, best);
    return best;
  };

  let drillDepth = 0;
  for (const node of flow.nodes.values()) {
    if (!hasIncoming.has(node.id)) {
      drillDepth = Math.max(drillDepth, (isPassThrough(node.id) ? 1 : 0) + longest(node.id));
    }
  }

  const passThrough = [...flow.nodes.values()]
    .filter((node) => isPassThrough(node.id))
    .sort((a, b) => a.depth - b.depth)
    .map((node) => node.label);

  return { drillDepth, passThrough, behaviors };
}

function buildGraph(
  flow: Flow,
  behaviors: Map<string, NodeBehavior>,
): StateUnit["graph"] {
  const all = [...flow.nodes.values()].sort(
    (a, b) => a.depth - b.depth || a.label.localeCompare(b.label),
  );

  const kept = all.slice(0, MAX_GRAPH_NODES);
  const keptIds = new Set(kept.map((node) => node.id));

  const nodes: FlowNode[] = kept.map((node) => ({
    id: node.id,
    label: node.label,
    filePath: node.filePath,
    type: node.type,
    behavior: behaviors.get(node.id) ?? "idle",
    depth: node.depth,
    reads: node.reads,
    writes: node.writes,
  }));

  const edges: FlowEdge[] = flow.hops
    .filter((hop) => keptIds.has(hop.fromId) && keptIds.has(hop.toId))
    .map((hop) => ({
      from: hop.fromId,
      to: hop.toId,
      label: hop.prop,
      role: hop.role,
      kind: hop.kind,
    }));

  return { nodes, edges, hiddenNodes: all.length - kept.length };
}

function sortAccesses(list: StateAccess[]): StateAccess[] {
  return [...list].sort(
    (a, b) =>
      a.filePath.localeCompare(b.filePath) ||
      a.line - b.line ||
      a.via.localeCompare(b.via),
  );
}

/* -------------------------------------------------------------------------- */
/*  Main analysis                                                             */
/* -------------------------------------------------------------------------- */

export async function analyzeStateFlow(
  projectPath: string,
  filePath?: string,
  options: {
    minDrillDepth?: number;
    includeTests?: boolean;
  } = {},
): Promise<StateFlowReport> {
  const minDrillDepth = options.minDrillDepth ?? DEFAULT_MIN_DRILL_DEPTH;
  const includeTests = options.includeTests ?? false;

  if (
    filePath !== undefined &&
    (path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes(".."))
  ) {
    throw new Error("filePath must be relative to projectPath.");
  }

  if (
    !Number.isInteger(minDrillDepth) ||
    minDrillDepth < 1 ||
    minDrillDepth > 10
  ) {
    throw new Error("minDrillDepth must be an integer between 1 and 10.");
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

  /* ---- Parse ---- */

  const project: Project = {
    root,
    files: new Map(),
    fileSet: new Set(candidates.map(relative)),
    comps: [],
    compsByName: new Map(),
    hooksByName: new Map(),
    contexts: new Map(),
    channelUses: new Map(),
    stores: [],
    selectorSlices: new Map(),
  };

  let classComponents = 0;

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

    const parsed = parseFile(absolute, relative(absolute), text);
    project.files.set(parsed.relPath, parsed);

    if (/\bextends\s+(React\.)?(Pure)?Component\b/.test(text)) classComponents++;

    for (const comp of parsed.components) {
      project.comps.push(comp);

      const index = comp.kind === "hook" ? project.hooksByName : project.compsByName;
      const list = index.get(comp.name) ?? [];
      list.push(comp);
      index.set(comp.name, list);

      // Hooks are also looked up by name when a JSX-free helper uses them.
      if (comp.kind === "component") {
        const all = project.compsByName.get(comp.name);
        if (all && !all.includes(comp)) all.push(comp);
      }
    }
  }

  if (classComponents > 0) {
    warn(
      `${classComponents} file${classComponents === 1 ? "" : "s"} contain class components. Only function components and hooks are analyzed.`,
    );
  }

  collectContexts(project);
  collectStores(project);
  buildChannelUses(project);

  const contextNames = new Set(project.contexts.keys());

  /* ---- Build the list of state items ---- */

  const defs: UnitDef[] = [];

  for (const comp of project.comps) {
    for (const declaration of comp.decls) {
      if (
        !ts.isArrayBindingPattern(declaration.name) ||
        !declaration.initializer
      ) {
        continue;
      }

      const call = unwrapExpr(declaration.initializer);
      if (!ts.isCallExpression(call)) continue;

      const hook = calleeName(call.expression);
      if (hook !== "useState" && hook !== "useReducer") continue;

      const first = declaration.name.elements[0];
      const second = declaration.name.elements[1];

      const valueNames: string[] =
        first && ts.isBindingElement(first) ? bindingNames(first.name) : [];
      const setter =
        second && ts.isBindingElement(second) && ts.isIdentifier(second.name)
          ? second.name.text
          : undefined;

      if (valueNames.length === 0 && !setter) continue;

      const line = lineOf(comp.file.sf, declaration);
      const name = valueNames[0] ?? setter ?? "state";
      const initialArgument = hook === "useReducer" ? call.arguments[1] : call.arguments[0];

      defs.push({
        id: hashId(comp.filePath, line, name),
        name,
        kind: hook,
        filePath: comp.filePath,
        line,
        owner: comp.name,
        setter,
        valueName: valueNames[0],
        initial: initialArgument ? clip(initialArgument.getText(), 50) : undefined,
        ownerComp: comp,
      });
    }
  }

  for (const store of project.stores) {
    defs.push({
      id: hashId(store.filePath, store.line, store.name),
      name: store.name,
      kind: store.kind,
      filePath: store.filePath,
      line: store.line,
      owner: path.posix.basename(store.filePath),
      initial: store.initial,
      store,
    });
  }

  const projectStateCount = defs.length;

  if (defs.length > MAX_UNITS) {
    warn(
      `Found ${defs.length} state items. Only the first ${MAX_UNITS} were traced. Use a focus file or a narrower project path.`,
    );
    defs.length = MAX_UNITS;
  }

  /* ---- Trace each state item ---- */

  const cache = new Map<string, CompResult>();
  const units: StateUnit[] = [];
  const hotspotMap = new Map<
    string,
    { comp: { name: string; filePath: string; line: number }; owned: number; pass: number; touched: number }
  >();

  const touch = (
    id: string,
    name: string,
    filePathValue: string,
    line: number,
    key: "owned" | "pass" | "touched",
  ) => {
    const entry = hotspotMap.get(id) ?? {
      comp: { name, filePath: filePathValue, line },
      owned: 0,
      pass: 0,
      touched: 0,
    };
    entry[key]++;
    hotspotMap.set(id, entry);
  };

  for (const def of defs) {
    const stateNode = {
      id: `state:${def.id}`,
      label: def.name,
      type: (def.store ? "store" : "state") as "state" | "store",
    };

    let starts: Array<Task & { prop: string; role: Role; line: number }> = [];
    let extraReads: Array<{ comp: ComponentDef; access: RawAccess }> = [];
    let extraWrites: Array<{ comp: ComponentDef; access: RawAccess }> = [];

    if (def.ownerComp) {
      const seeds = emptySeeds();
      if (def.valueName) seeds.names.set(def.valueName, "value");
      if (def.setter) seeds.names.set(def.setter, "setter");

      const declaredNames = def.ownerComp.decls
        .filter((declaration) => ts.isArrayBindingPattern(declaration.name))
        .flatMap((declaration) =>
          lineOf(def.ownerComp!.file.sf, declaration) === def.line
            ? bindingNames(declaration.name)
            : [],
        );

      for (const extra of declaredNames) {
        if (!seeds.names.has(extra) && extra !== def.setter) {
          seeds.names.set(extra, "value");
        }
      }

      starts = [
        {
          comp: def.ownerComp,
          seeds,
          depth: 1,
          isOwner: true,
          prop: def.setter ? `${def.valueName ?? "_"}, ${def.setter}` : def.name,
          role: "value",
          line: def.line,
        },
      ];
    } else if (def.store) {
      const found = storeStarts(def.store, project);
      starts = found.starts;
      extraReads = found.extraReads;
      extraWrites = found.extraWrites;
    }

    const flow = propagate(stateNode, starts, project, cache, contextNames);

    const addExtra = (
      items: Array<{ comp: ComponentDef; access: RawAccess }>,
      list: StateAccess[],
      counter: "reads" | "writes",
    ) => {
      for (const { comp, access } of items) {
        const node = flow.nodes.get(comp.id);
        if (node) node[counter]++;
        list.push({
          component: comp.name,
          filePath: comp.filePath,
          line: access.line,
          via: access.via,
          detail: access.detail,
        });

        if (!node) {
          flow.nodes.set(comp.id, {
            id: comp.id,
            label: comp.name,
            filePath: comp.filePath,
            type: comp.kind === "hook" ? "hook" : "component",
            depth: 1,
            reads: counter === "reads" ? 1 : 0,
            writes: counter === "writes" ? 1 : 0,
            forwardsOut: 0,
            isOwner: false,
            isExternal: false,
          });
          flow.hops.push({
            fromId: stateNode.id,
            from: stateNode.label,
            toId: comp.id,
            to: comp.name,
            prop: access.detail,
            role: counter === "writes" ? "setter" : "value",
            kind: "store",
            line: access.line,
            depth: 1,
          });
        }
      }
    };

    addExtra(extraReads, flow.reads, "reads");
    addExtra(extraWrites, flow.writes, "writes");

    if (flow.truncated) {
      warn(
        `The flow for ${def.name} (${def.filePath}) was cut short. The component tree is deeper or wider than the analyzer follows.`,
      );
    }

    const measured = measureFlow(flow);

    const consumerNodes = [...flow.nodes.values()].filter(
      (node) =>
        (node.type === "component" || node.type === "hook") &&
        !node.isExternal &&
        (node.reads > 0 || node.writes > 0),
    );

    const consumerNames = consumerNodes
      .filter((node) => !node.isOwner)
      .map((node) => node.label)
      .slice(0, 3);

    const issues = buildIssues(
      def,
      flow,
      measured.drillDepth,
      measured.passThrough,
      minDrillDepth,
      consumerNames,
    );

    const readerComponents = new Set(flow.reads.map((item) => item.filePath + item.component)).size;
    const writerComponents = new Set(flow.writes.map((item) => item.filePath + item.component)).size;

    const riskScore = Math.min(
      100,
      issues.reduce((sum, issue) => sum + SEVERITY_WEIGHT[issue.severity], 0) +
        Math.min(15, consumerNodes.length) +
        Math.min(15, measured.drillDepth * 5),
    );

    const sortedReads = sortAccesses(flow.reads);
    const sortedWrites = sortAccesses(flow.writes);

    for (const node of flow.nodes.values()) {
      if (node.type !== "component" && node.type !== "hook") continue;
      if (node.isExternal) continue;

      const comp = project.comps.find((item) => item.id === node.id);
      if (!comp) continue;

      if (node.isOwner) touch(node.id, node.label, comp.filePath, comp.line, "owned");
      if (measured.behaviors.get(node.id) === "pass-through") {
        touch(node.id, node.label, comp.filePath, comp.line, "pass");
      }
      if (node.reads > 0 || node.writes > 0 || node.isOwner || measured.behaviors.get(node.id) === "pass-through") {
        touch(node.id, node.label, comp.filePath, comp.line, "touched");
      }
    }

    units.push({
      id: def.id,
      name: def.name,
      kind: def.kind,
      filePath: def.filePath,
      line: def.line,
      owner: def.owner,
      setter: def.setter,
      initial: def.initial,
      viaContexts: [...flow.contexts.keys()],
      severity: severityOfMax(issues),
      riskScore,
      issueCount: issues.length,
      issues,
      reads: sortedReads.slice(0, MAX_ACCESSES_SHOWN),
      writes: sortedWrites.slice(0, MAX_ACCESSES_SHOWN),
      hiddenReads: Math.max(0, sortedReads.length - MAX_ACCESSES_SHOWN),
      hiddenWrites: Math.max(0, sortedWrites.length - MAX_ACCESSES_SHOWN),
      readerComponents,
      writerComponents,
      consumerCount: consumerNodes.length,
      drillDepth: measured.drillDepth,
      passThroughComponents: measured.passThrough,
      flow: [...flow.hops].sort((a, b) => a.depth - b.depth),
      graph: buildGraph(flow, measured.behaviors),
    });
  }

  units.sort(
    (a, b) =>
      b.riskScore - a.riskScore ||
      b.consumerCount - a.consumerCount ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );

  /* ---- Focus filter ---- */

  const focusFile = filePath ? normalizePath(filePath) : undefined;

  if (focusFile && !project.files.has(focusFile)) {
    warn(
      `${focusFile} was not found among the analyzed files, so no state can be linked to it.`,
    );
  }

  const scoped = focusFile
    ? units.filter(
        (unit) =>
          unit.filePath === focusFile ||
          unit.reads.some((item) => item.filePath === focusFile) ||
          unit.writes.some((item) => item.filePath === focusFile) ||
          unit.graph.nodes.some((node) => node.filePath === focusFile),
      )
    : units;

  /* ---- Totals ---- */

  const uniqueIssues = new Map<string, StateIssue>();
  for (const unit of scoped) {
    for (const issue of unit.issues) uniqueIssues.set(issue.id, issue);
  }

  const summary: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const issue of uniqueIssues.values()) summary[issue.severity]++;

  const kindCounts: Record<StateKind, number> = {
    useState: 0,
    useReducer: 0,
    redux: 0,
    zustand: 0,
    jotai: 0,
  };
  for (const unit of scoped) kindCounts[unit.kind]++;

  const hotspots: ComponentHotspot[] = [...hotspotMap.values()]
    .map((entry) => ({
      name: entry.comp.name,
      filePath: entry.comp.filePath,
      line: entry.comp.line,
      ownedStates: entry.owned,
      passThroughs: entry.pass,
      statesTouched: entry.touched,
    }))
    .filter((entry) => !focusFile || entry.filePath === focusFile || entry.statesTouched > 1)
    .sort(
      (a, b) =>
        b.statesTouched - a.statesTouched ||
        b.passThroughs - a.passThroughs ||
        a.name.localeCompare(b.name),
    )
    .slice(0, MAX_HOTSPOTS);

  return {
    success: true,
    tool: "analyze_state_flow",
    projectPath: root,
    filePath: focusFile,
    minDrillDepth,
    includeTests,
    filesScanned: project.files.size,
    componentsAnalyzed: project.comps.filter((comp) => comp.kind === "component").length,
    hooksAnalyzed: project.comps.filter((comp) => comp.kind === "hook").length,
    totalStates: scoped.length,
    projectStateCount,
    localStates: scoped.filter((unit) => unit.kind === "useState" || unit.kind === "useReducer").length,
    storeStates: scoped.filter((unit) => unit.kind !== "useState" && unit.kind !== "useReducer").length,
    contextCount: project.contexts.size,
    statesWithIssues: scoped.filter((unit) => unit.issueCount > 0).length,
    drillingStates: scoped.filter((unit) => unit.drillDepth >= minDrillDepth).length,
    deepestDrill: scoped.reduce((max, unit) => Math.max(max, unit.drillDepth), 0),
    sharedStates: scoped.filter(
      (unit) =>
        unit.viaContexts.length > 0 ||
        (unit.kind !== "useState" && unit.kind !== "useReducer"),
    ).length,
    totalIssues: uniqueIssues.size,
    summary,
    kindCounts,
    units: scoped,
    hotspots,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/*  MCP registration                                                          */
/* -------------------------------------------------------------------------- */

export function registerAnalyzeStateFlowTool(server: McpServer) {
  server.registerTool(
    "analyze_state_flow",
    {
      description:
        "Trace how React state moves through a JavaScript/TypeScript project. Finds every useState, useReducer, Redux Toolkit slice, Zustand store and Jotai atom, follows each one through props, context and custom hooks, and reports which components read it, which components update it, and where it is passed through components that never use it. Flags prop drilling, unused or write-only state, state copied from props, direct mutation, updates during render, unstable context values and scattered updates, each with a suggested fix.",
      inputSchema: z.object({
        projectPath: z
          .string()
          .describe("Absolute path to the project directory"),
        filePath: z
          .string()
          .optional()
          .describe(
            "Optional file, relative to projectPath. When set, only state that is declared in, read in, or updated in this file is reported.",
          ),
        minDrillDepth: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe(
            "Number of pass-through components on one path before prop drilling is reported. Default 2.",
          ),
        includeTests: z
          .boolean()
          .optional()
          .describe("Include test, mock and story files. Default false."),
      }),
    },
    async ({ projectPath, filePath, minDrillDepth, includeTests }) => {
      try {
        const report = await analyzeStateFlow(projectPath, filePath, {
          minDrillDepth,
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
                  tool: "analyze_state_flow",
                  error:
                    error instanceof Error
                      ? error.message
                      : "Failed to analyze state flow.",
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
