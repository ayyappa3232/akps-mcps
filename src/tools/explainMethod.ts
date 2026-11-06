import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import * as ts from "typescript";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SOURCE_LINES = 250;
const MAX_SEARCH_FILES = 5000;
/** How many levels of project-function calls are expanded under each call. */
const MAX_CALL_TREE_DEPTH = 2;

const IGNORED_DIRECTORIES = new Set([
  "node_modules", ".git", "dist", "build", "coverage",
  ".next", ".vite", ".turbo", ".vercel",
]);

const BLOCKED_FILENAMES = new Set([
  ".env", ".env.local", ".env.development", ".env.production",
  "serviceAccountKey.json", "id_rsa", "id_ed25519",
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs",
]);

type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "arrow-function"
  | "function-expression"
  | "variable"
  | "getter"
  | "setter"
  | "constructor"
  | "unknown";

type CallCategory =
  | "recursive"
  | "project-symbol"
  | "class-method"
  | "react-hook"
  | "state-setter"
  | "external"
  | "builtin"
  | "local-function"
  | "unknown";

interface SymbolCandidate {
  name: string;
  kind: SymbolKind;
  node: ts.Node;
  filePath: string;
  sourceFile: ts.SourceFile;
  startLine: number;
  endLine: number;
  className?: string;
  static?: boolean;
  modifiers: string[];
}

interface ParameterInfo {
  name: string;
  type: string;
  optional: boolean;
  rest: boolean;
  defaultValue?: string;
}

interface CallInfo {
  name: string;
  category: CallCategory;
  expression: string;
  line: number;
  filePath: string;
  awaited: boolean;
  description: string;
  target?: string;
  targetFilePath?: string;
  targetKind?: SymbolKind;
  targetClassName?: string;
  /** Calls made by the target function (project functions only, depth-limited). */
  children?: CallInfo[];
}

interface CallerInfo {
  name: string;
  filePath: string;
  line: number;
  kind: SymbolKind;
  className?: string;
  expression: string;
}

interface BranchDetail {
  kind: "if" | "ternary" | "switch";
  line: number;
  text: string;
}

interface AwaitDetail {
  line: number;
  text: string;
}

interface MethodExplanation {
  success: boolean;
  projectPath: string;
  symbol: string;
  filePath: string;
  kind: SymbolKind;
  summary: string;
  signature: string;
  documentation: string;
  parameters: ParameterInfo[];
  returnType: string;
  async: boolean;
  exported: boolean;
  startLine: number;
  endLine: number;
  source?: string;
  behavior: {
    calls: string[];
    conditions: number;
    loops: number;
    awaits: number;
    throws: number;
    returns: number;
    assignments: number;
    stateHooks: string[];
    effects: string[];
    branchDetails: BranchDetail[];
    awaitDetails: AwaitDetail[];
  };
  relatedSymbols: string[];
  warnings: string[];
  callDetails: CallInfo[];
  recursive: boolean;
  recursiveCalls: number;
  className?: string;
  modifiers: string[];
  static: boolean;
  callers: CallerInfo[];
}

interface FileAnalysis {
  sourceFile: ts.SourceFile;
  content: string;
  candidates: SymbolCandidate[];
}

interface AnalysisIndex {
  files: FileAnalysis[];
  candidates: SymbolCandidate[];
  byName: Map<string, SymbolCandidate[]>;
}

const REACT_HOOKS = new Set([
  "useState", "useEffect", "useLayoutEffect", "useInsertionEffect",
  "useMemo", "useCallback", "useRef", "useContext", "useReducer",
  "useId", "useTransition", "useDeferredValue", "useSyncExternalStore",
  "useImperativeHandle", "useDebugValue", "useOptimistic", "useActionState",
  "useFormStatus",
]);

/** Global JS/TS objects and functions. */
const BUILTIN_CALLS = new Set([
  "Array", "Boolean", "Date", "Error", "Map", "Object", "Promise", "RegExp",
  "Set", "String", "Number", "parseInt", "parseFloat", "isNaN", "JSON",
  "Math", "console", "setTimeout", "setInterval", "clearTimeout",
  "clearInterval", "requestAnimationFrame", "cancelAnimationFrame",
]);

/** Methods that live on built-in types (Array, String, JSON, Map, ...). */
const BUILTIN_METHODS = new Set([
  "trim", "trimStart", "trimEnd", "endsWith", "startsWith", "includes",
  "indexOf", "lastIndexOf", "find", "findIndex", "findLast", "filter", "map",
  "flatMap", "flat", "reduce", "reduceRight", "forEach", "some", "every",
  "join", "split", "slice", "splice", "sort", "reverse", "concat", "push",
  "pop", "shift", "unshift", "replace", "replaceAll", "match", "toLowerCase",
  "toUpperCase", "toString", "toFixed", "toLocaleString", "stringify",
  "parse", "keys", "values", "entries", "has", "add", "from", "isArray",
  "assign", "freeze", "floor", "ceil", "round", "min", "max", "abs",
]);

/** Network / framework calls that leave the project. */
const COMMON_EXTERNAL_CALLS = new Set([
  "fetch", "axios", "get", "post", "put", "patch", "delete", "request",
  "dispatch", "navigate", "json", "then", "catch", "finally",
  "addEventListener", "removeEventListener",
]);

function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function isBlockedFile(filePath: string): boolean {
  const name = path.basename(filePath);
  return BLOCKED_FILENAMES.has(name) || name.startsWith(".env.") || name.startsWith(".");
}

function getNodeName(node: ts.Node): string | undefined {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node)) &&
    node.name
  ) {
    return node.name.getText();
  }

  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }

  if (ts.isPropertyAssignment(node)) {
    return node.name.getText().replace(/^['"]|['"]$/g, "");
  }

  return undefined;
}

function getKind(node: ts.Node): SymbolKind {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return "method";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isGetAccessorDeclaration(node)) return "getter";
  if (ts.isSetAccessorDeclaration(node)) return "setter";
  if (ts.isConstructorDeclaration(node)) return "constructor";

  if (ts.isVariableDeclaration(node)) {
    if (node.initializer && ts.isArrowFunction(node.initializer)) return "arrow-function";
    if (node.initializer && ts.isFunctionExpression(node.initializer)) return "function-expression";
    return "variable";
  }

  if (
    ts.isPropertyAssignment(node) &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return ts.isArrowFunction(node.initializer) ? "arrow-function" : "function-expression";
  }

  return "unknown";
}

function getCallableNode(node: ts.Node): ts.Node {
  if (ts.isVariableDeclaration(node) && node.initializer) return node.initializer;
  if (ts.isPropertyAssignment(node)) return node.initializer;
  return node;
}

function getParameters(node: ts.Node): readonly ts.ParameterDeclaration[] {
  const callable = getCallableNode(node);
  if (ts.isFunctionLike(callable) && "parameters" in callable) return callable.parameters;
  return [];
}

function getReturnType(node: ts.Node): string {
  const callable = getCallableNode(node);
  if (ts.isFunctionLike(callable) && "type" in callable && callable.type) {
    return callable.type.getText();
  }
  if (ts.isClassDeclaration(node)) return node.name?.text ?? "anonymous class";
  return "Not explicitly declared";
}

function getDocumentation(node: ts.Node): string {
  const docs = ts.getJSDocCommentsAndTags(node);
  const comments = docs
    .filter(ts.isJSDoc)
    .map((doc) => doc.comment)
    .filter(
      (comment): comment is string | ts.NodeArray<ts.JSDocComment> =>
        comment !== undefined,
    )
    .map((comment) =>
      typeof comment === "string"
        ? comment
        : comment.map((part) => part.text).join(""),
    );

  if (comments.length > 0) return comments.join("\n");

  const fullText = node.getFullText();
  const leading = fullText.match(/^\s*\/\*\*([\s\S]*?)\*\//);
  return leading
    ? leading[1].replace(/^\s*\* ?/gm, "").trim()
    : "";
}

function getModifiers(node: ts.Node): string[] {
  if (!ts.canHaveModifiers(node)) return [];
  return (ts.getModifiers(node) ?? []).map((modifier) => modifier.getText());
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)
    : false;
}

function findContainingClass(node: ts.Node): ts.ClassDeclaration | ts.ClassExpression | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) return current;
    if (ts.isSourceFile(current)) return undefined;
    current = current.parent;
  }
  return undefined;
}

function getClassName(node: ts.Node): string | undefined {
  return findContainingClass(node)?.name?.text;
}

/**
 * A symbol is exported only when it is a top-level declaration that is
 * exported directly (`export function x`, `export const x = ...`,
 * `export default function x`) or re-exported by a top-level statement
 * (`export { x }`, `export default x`).
 *
 * Nested functions, such as a handler inside an exported component,
 * are NOT exported.
 */
function isExported(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  // For `const x = () => {}` the modifiers live on the VariableStatement.
  const holder: ts.Node | undefined = ts.isVariableDeclaration(node)
    ? node.parent?.parent
    : node;

  if (!holder || holder.parent !== sourceFile) return false;

  if (
    hasModifier(holder, ts.SyntaxKind.ExportKeyword) ||
    hasModifier(holder, ts.SyntaxKind.DefaultKeyword)
  ) {
    return true;
  }

  const name = getNodeName(node);
  if (!name) return false;

  return sourceFile.statements.some((statement) => {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      return statement.exportClause.elements.some(
        (element) => (element.propertyName ?? element.name).text === name,
      );
    }
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      return statement.expression.text === name;
    }
    return false;
  });
}

function collectCandidates(sourceFile: ts.SourceFile, filePath: string): SymbolCandidate[] {
  const candidates: SymbolCandidate[] = [];

  const add = (node: ts.Node, name: string | undefined) => {
    if (!name) return;
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

    candidates.push({
      name,
      kind: getKind(node),
      node,
      filePath,
      sourceFile,
      startLine: start.line + 1,
      endLine: end.line + 1,
      className: getClassName(node),
      static: hasModifier(node, ts.SyntaxKind.StaticKeyword),
      modifiers: getModifiers(node),
    });
  };

  const visit = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node)
    ) {
      add(node, getNodeName(node));
    } else if (ts.isVariableDeclaration(node)) {
      if (
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        add(node, getNodeName(node));
      }
    } else if (
      ts.isPropertyAssignment(node) &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      add(node, getNodeName(node));
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return candidates;
}

async function findSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  const walk = async (directory: string): Promise<void> => {
    if (files.length >= MAX_SEARCH_FILES) return;

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (files.length >= MAX_SEARCH_FILES) return;
      if (entry.isSymbolicLink()) continue;

      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) {
          await walk(absolutePath);
        }
        continue;
      }

      if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
        !isBlockedFile(absolutePath)
      ) {
        files.push(absolutePath);
      }
    }
  };

  await walk(root);
  return files;
}

function getCallName(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression)) {
    return expression.argumentExpression?.getText() ?? expression.getText();
  }
  return expression.getText();
}

function getCallExpressionText(expression: ts.Expression): string {
  return expression.getText();
}

function isStateSetter(name: string): boolean {
  return /^set[A-Z]/.test(name);
}

function getCandidateTarget(
  name: string,
  expression: ts.Expression,
  current: SymbolCandidate,
  index: AnalysisIndex,
): SymbolCandidate | undefined {
  const candidates = index.byName.get(name) ?? [];
  if (candidates.length === 0) return undefined;

  const propertyAccess = ts.isPropertyAccessExpression(expression);
  const receiverText = propertyAccess ? expression.expression.getText() : "";

  if (receiverText === "this" && current.className) {
    return (
      candidates.find(
        (candidate) =>
          candidate.className === current.className &&
          ["method", "getter", "setter", "constructor", "arrow-function", "function-expression"].includes(candidate.kind),
      ) ?? candidates.find((candidate) => candidate.className === current.className)
    );
  }

  if (propertyAccess && current.className && receiverText !== "this") {
    const sameClass = candidates.find((candidate) => candidate.className === current.className);
    if (sameClass) return sameClass;
  }

  if (candidates.some((candidate) => candidate.filePath === current.filePath)) {
    return candidates.find((candidate) => candidate.filePath === current.filePath);
  }

  return candidates[0];
}

function categorizeCall(
  name: string,
  expression: ts.Expression,
  current: SymbolCandidate,
  index: AnalysisIndex,
): { category: CallCategory; target?: SymbolCandidate } {
  if (name === current.name && (!current.className || expression.getText() === current.name)) {
    return { category: "recursive", target: current };
  }

  if (REACT_HOOKS.has(name) || /^use[A-Z]/.test(name)) {
    return { category: "react-hook" };
  }

  if (isStateSetter(name)) return { category: "state-setter" };

  // JS/TS built-ins (find, endsWith, JSON.stringify, ...) are purple "Built-in".
  if (BUILTIN_CALLS.has(name) || BUILTIN_METHODS.has(name)) {
    return { category: "builtin" };
  }

  // Network / framework calls (fetch, json, axios, ...) are blue "External".
  if (COMMON_EXTERNAL_CALLS.has(name)) {
    return { category: "external" };
  }

  const target = getCandidateTarget(name, expression, current, index);
  if (target) {
    if (target === current) return { category: "recursive", target };
    if (target.filePath === current.filePath && target.className === current.className) {
      return { category: "class-method", target };
    }
    if (target.filePath === current.filePath) return { category: "local-function", target };
    return { category: "project-symbol", target };
  }

  if (ts.isPropertyAccessExpression(expression)) return { category: "external" };
  if (/^[a-zA-Z_$][\w$]*$/.test(name)) return { category: "unknown" };
  return { category: "external" };
}

/** One-line, human-readable description shown in the "Details" column. */
function describeCall(
  name: string,
  category: CallCategory,
  awaited: boolean,
  target?: SymbolCandidate,
): string {
  let text: string;

  switch (category) {
    case "recursive":
      text = "Calls itself recursively";
      break;
    case "project-symbol":
    case "local-function":
    case "class-method": {
      const doc = target
        ? getDocumentation(target.node).split("\n")[0].trim()
        : "";
      text =
        doc ||
        (target
          ? `Defined in ${target.filePath}:${target.startLine}`
          : "Project function");
      break;
    }
    case "react-hook":
      text = "React hook";
      break;
    case "state-setter":
      text = "React state setter";
      break;
    case "builtin":
      text = "JS/TS built-in method";
      break;
    case "external":
      text = name === "fetch" ? "Network request" : "External / library call";
      break;
    default:
      text = "Unresolved call";
  }

  return awaited ? `${text} (await)` : text;
}

function analyzeCalls(
  node: ts.Node,
  current: SymbolCandidate,
  index: AnalysisIndex,
  depth = 0,
  seen: Set<ts.Node> = new Set([current.node]),
): CallInfo[] {
  const calls: CallInfo[] = [];
  const callable = getCallableNode(node);

  const visit = (child: ts.Node) => {
    if (ts.isCallExpression(child)) {
      const name = getCallName(child.expression);
      const result = categorizeCall(name, child.expression, current, index);
      const line = current.sourceFile.getLineAndCharacterOfPosition(
        child.getStart(current.sourceFile),
      ).line + 1;
      const awaited = ts.isAwaitExpression(child.parent);

      const info: CallInfo = {
        name,
        category: result.category,
        expression: getCallExpressionText(child.expression),
        line,
        filePath: current.filePath,
        awaited,
        description: describeCall(name, result.category, awaited, result.target),
        ...(result.target
          ? {
              target: result.target.name,
              targetFilePath: result.target.filePath,
              targetKind: result.target.kind,
              ...(result.target.className ? { targetClassName: result.target.className } : {}),
            }
          : {}),
      };

      // Expand project functions one more level (cycle-safe, depth-limited).
      const target = result.target;
      if (
        target &&
        result.category !== "recursive" &&
        depth < MAX_CALL_TREE_DEPTH &&
        !seen.has(target.node)
      ) {
        const children = analyzeCalls(
          target.node,
          target,
          index,
          depth + 1,
          new Set(seen).add(target.node),
        );
        if (children.length > 0) info.children = children;
      }

      calls.push(info);
    }

    ts.forEachChild(child, visit);
  };

  visit(callable);
  return calls;
}

function analyzeBehavior(
  node: ts.Node,
  callDetails: CallInfo[],
): MethodExplanation["behavior"] {
  const calls = new Set<string>();
  const stateHooks = new Set<string>();
  const effects = new Set<string>();
  const branchDetails: BranchDetail[] = [];
  const awaitDetails: AwaitDetail[] = [];
  let conditions = 0;
  let loops = 0;
  let awaits = 0;
  let throws = 0;
  let returns = 0;
  let assignments = 0;

  const sourceFile = node.getSourceFile();
  const lineOf = (target: ts.Node) =>
    sourceFile.getLineAndCharacterOfPosition(target.getStart(sourceFile)).line + 1;
  const snippet = (target: ts.Node) =>
    target.getText(sourceFile).replace(/\s+/g, " ").slice(0, 90);

  for (const call of callDetails) {
    calls.add(call.name);
    if (call.category === "react-hook") stateHooks.add(call.name);
    if (["useEffect", "useLayoutEffect", "useInsertionEffect"].includes(call.name)) {
      effects.add(call.name);
    }
  }

  const visit = (child: ts.Node) => {
    if (ts.isIfStatement(child)) {
      conditions++;
      branchDetails.push({ kind: "if", line: lineOf(child), text: snippet(child.expression) });
    } else if (ts.isConditionalExpression(child)) {
      conditions++;
      branchDetails.push({ kind: "ternary", line: lineOf(child), text: snippet(child.condition) });
    } else if (ts.isSwitchStatement(child)) {
      conditions++;
      branchDetails.push({ kind: "switch", line: lineOf(child), text: snippet(child.expression) });
    }

    if (
      ts.isForStatement(child) ||
      ts.isForInStatement(child) ||
      ts.isForOfStatement(child) ||
      ts.isWhileStatement(child) ||
      ts.isDoStatement(child)
    ) loops++;

    if (ts.isAwaitExpression(child)) {
      awaits++;
      awaitDetails.push({ line: lineOf(child), text: snippet(child.expression) });
    }
    if (ts.isThrowStatement(child)) throws++;
    if (ts.isReturnStatement(child)) returns++;

    if (
      ts.isBinaryExpression(child) &&
      [
        ts.SyntaxKind.EqualsToken,
        ts.SyntaxKind.PlusEqualsToken,
        ts.SyntaxKind.MinusEqualsToken,
        ts.SyntaxKind.AsteriskEqualsToken,
        ts.SyntaxKind.SlashEqualsToken,
      ].includes(child.operatorToken.kind)
    ) {
      assignments++;
    }

    ts.forEachChild(child, visit);
  };

  visit(getCallableNode(node));

  return {
    calls: [...calls].sort(),
    conditions,
    loops,
    awaits,
    throws,
    returns,
    assignments,
    stateHooks: [...stateHooks].sort(),
    effects: [...effects].sort(),
    branchDetails,
    awaitDetails,
  };
}

function buildSignature(candidate: SymbolCandidate): string {
  const { node, sourceFile } = candidate;
  const callable = getCallableNode(node);

  if (ts.isClassDeclaration(node)) {
    const heritage = node.heritageClauses?.map((clause) => clause.getText(sourceFile));
    return `class ${node.name?.text ?? candidate.name}${heritage?.length ? ` ${heritage.join(" ")}` : ""}`;
  }

  if (ts.isFunctionLike(callable)) {
    const asyncPrefix = hasModifier(callable, ts.SyntaxKind.AsyncKeyword) ? "async " : "";
    const parameters = getParameters(node)
      .map((parameter) => parameter.getText(sourceFile))
      .join(", ");
    const returnType =
      "type" in callable && callable.type ? `: ${callable.type.getText(sourceFile)}` : "";

    // async function generateGraph(): Promise<void>
    if (candidate.kind === "function") {
      return `${asyncPrefix}function ${candidate.name}(${parameters})${returnType}`;
    }

    // const handle = async (event: Event) => {…}
    if (candidate.kind === "arrow-function" && ts.isVariableDeclaration(node)) {
      return `const ${candidate.name} = ${asyncPrefix}(${parameters})${returnType} => {…}`;
    }

    const accessorPrefix =
      candidate.kind === "getter" ? "get " :
      candidate.kind === "setter" ? "set " : "";

    return `${asyncPrefix}${accessorPrefix}${candidate.name}(${parameters})${returnType}`;
  }

  return node.getText(sourceFile).split("{")[0].trim();
}

function createSummary(
  candidate: SymbolCandidate,
  behavior: MethodExplanation["behavior"],
  callDetails: CallInfo[],
): string {
  const kindLabel = candidate.kind.replace("-", " ");
  const details: string[] = [`${candidate.name} is a ${kindLabel}.`];

  if (candidate.className) details.push(`It belongs to class ${candidate.className}.`);
  if (candidate.static) details.push("It is static.");
  if (hasModifier(candidate.node, ts.SyntaxKind.AsyncKeyword)) details.push("It is asynchronous.");

  if (behavior.calls.length) {
    details.push(
      `It calls ${behavior.calls.slice(0, 8).join(", ")}${behavior.calls.length > 8 ? ", and other functions" : ""}.`,
    );
  }

  const categories = new Map<CallCategory, number>();
  for (const call of callDetails) {
    categories.set(call.category, (categories.get(call.category) ?? 0) + 1);
  }

  const categorySummary = [...categories.entries()]
    .filter(([category]) => category !== "unknown")
    .map(([category, count]) => `${count} ${category} call${count === 1 ? "" : "s"}`)
    .join(", ");

  if (categorySummary) details.push(`Calls include ${categorySummary}.`);
  if (behavior.conditions) details.push(`It contains ${behavior.conditions} conditional branch(es).`);
  if (behavior.loops) details.push(`It contains ${behavior.loops} loop(s).`);
  if (behavior.awaits) details.push(`It performs ${behavior.awaits} await operation(s).`);
  if (behavior.stateHooks.length) {
    details.push(`It uses React-style hooks: ${behavior.stateHooks.join(", ")}.`);
  }
  if (callDetails.some((call) => call.category === "recursive")) {
    details.push("It makes a recursive call to itself.");
  }

  return details.join(" ");
}

function getRelatedSymbols(
  candidate: SymbolCandidate,
  allCandidates: SymbolCandidate[],
  callDetails: CallInfo[],
): string[] {
  const names = new Set<string>();

  for (const call of callDetails) {
    if (call.target && call.target !== candidate.name) names.add(call.target);
  }

  const text = candidate.node.getText(candidate.sourceFile);
  for (const other of allCandidates) {
    if (other === candidate || other.name === candidate.name) continue;
    const escaped = other.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`).test(text)) names.add(other.name);
  }

  return [...names].slice(0, 30);
}

function findContainingSymbol(
  position: number,
  sourceFile: ts.SourceFile,
  candidates: SymbolCandidate[],
): SymbolCandidate | undefined {
  return candidates
    .filter(
      (candidate) =>
        candidate.node.getStart(sourceFile) <= position &&
        candidate.node.getEnd() >= position &&
        candidate.kind !== "class",
    )
    .sort(
      (a, b) =>
        (a.node.getEnd() - a.node.getStart()) -
        (b.node.getEnd() - b.node.getStart()),
    )[0];
}

function findCallers(
  candidate: SymbolCandidate,
  index: AnalysisIndex,
): CallerInfo[] {
  const callers: CallerInfo[] = [];

  for (const file of index.files) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const name = getCallName(node.expression);
        if (name === candidate.name) {
          const caller = findContainingSymbol(node.getStart(file.sourceFile), file.sourceFile, file.candidates);
          if (
            caller &&
            caller.node !== candidate.node &&
            caller.name !== candidate.name
          ) {
            const line =
              file.sourceFile.getLineAndCharacterOfPosition(node.getStart(file.sourceFile)).line + 1;

            callers.push({
              name: caller.name,
              filePath: caller.filePath,
              line,
              kind: caller.kind,
              ...(caller.className ? { className: caller.className } : {}),
              expression: node.expression.getText(file.sourceFile),
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(file.sourceFile);
  }

  const seen = new Set<string>();
  return callers.filter((caller) => {
    const key = `${caller.filePath}:${caller.line}:${caller.name}:${caller.expression}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 50);
}

async function buildAnalysisIndex(files: string[], root: string, warnings: string[]): Promise<AnalysisIndex> {
  const analyses: FileAnalysis[] = [];
  const allCandidates: SymbolCandidate[] = [];

  for (const file of files) {
    try {
      const fileStats = await stat(file);
      if (!fileStats.isFile() || fileStats.size > MAX_FILE_BYTES) {
        warnings.push(`Skipped large or non-file source: ${path.relative(root, file)}`);
        continue;
      }

      const content = await readFile(file, "utf8");
      const extension = path.extname(file).toLowerCase();
      const scriptKind =
        extension === ".tsx" || extension === ".jsx"
          ? ts.ScriptKind.TSX
          : [".js", ".mjs", ".cjs"].includes(extension)
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS;

      const sourceFile = ts.createSourceFile(
        file,
        content,
        ts.ScriptTarget.Latest,
        true,
        scriptKind,
      );

      const relativeFile = path.relative(root, file).split(path.sep).join("/");
      const candidates = collectCandidates(sourceFile, relativeFile);

      analyses.push({ sourceFile, content, candidates });
      allCandidates.push(...candidates);
    } catch {
      warnings.push(`Unable to inspect: ${path.relative(root, file)}`);
    }
  }

  const byName = new Map<string, SymbolCandidate[]>();
  for (const candidate of allCandidates) {
    const existing = byName.get(candidate.name) ?? [];
    existing.push(candidate);
    byName.set(candidate.name, existing);
  }

  return { files: analyses, candidates: allCandidates, byName };
}

export const explainMethod = async (
  projectPathInput: string,
  symbol: string,
  filePathInput: string | undefined,
  includeSource: boolean,
): Promise<MethodExplanation> => {
  if (!path.isAbsolute(projectPathInput)) {
    throw new Error("projectPath must be an absolute path.");
  }

  const root = await realpath(projectPathInput);
  const rootStats = await stat(root);
  if (!rootStats.isDirectory()) {
    throw new Error("projectPath must point to a directory.");
  }

  const warnings: string[] = [];
  let files: string[];

  if (filePathInput) {
    if (path.isAbsolute(filePathInput)) {
      throw new Error("filePath must be relative to the project directory.");
    }

    const requested = path.resolve(root, filePathInput);
    const resolved = await realpath(requested);

    if (!isInsideRoot(root, resolved)) {
      throw new Error("Access outside the project directory is blocked.");
    }
    if (isBlockedFile(resolved)) {
      throw new Error("Reading this potentially sensitive file is blocked.");
    }
    if (!SOURCE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      throw new Error("filePath must point to a JavaScript or TypeScript source file.");
    }

    files = [resolved];
  } else {
    files = await findSourceFiles(root);
    if (files.length >= MAX_SEARCH_FILES) {
      warnings.push(`Search stopped at the ${MAX_SEARCH_FILES}-file safety limit.`);
    }
  }

  const index = await buildAnalysisIndex(files, root, warnings);
  const matches = index.byName.get(symbol) ?? [];

  if (matches.length === 0) {
    throw new Error(
      `Could not find a function, method, class, getter, setter, constructor, or arrow function named "${symbol}".`,
    );
  }

  if (matches.length > 1 && !filePathInput) {
    const locations = matches
      .slice(0, 20)
      .map((match) => `${match.filePath}:${match.startLine}`);

    throw new Error(
      `Found ${matches.length} matches for "${symbol}". Supply filePath to select one. Matches: ${locations.join("; ")}`,
    );
  }

  const candidate = matches[0];
  const callDetails = analyzeCalls(candidate.node, candidate, index);
  const behavior = analyzeBehavior(candidate.node, callDetails);
  const sourceText = candidate.node.getText(candidate.sourceFile);
  const sourceLines = sourceText.split(/\r?\n/);
  let source: string | undefined;

  if (includeSource) {
    if (sourceLines.length > MAX_SOURCE_LINES) {
      source = sourceLines.slice(0, MAX_SOURCE_LINES).join("\n");
      warnings.push(`Source excerpt limited to ${MAX_SOURCE_LINES} lines.`);
    } else {
      source = sourceText;
    }
  }

  const parameters: ParameterInfo[] = getParameters(candidate.node).map((parameter) => ({
    name: parameter.name.getText(candidate.sourceFile),
    type: parameter.type?.getText(candidate.sourceFile) ?? "Not explicitly declared",
    optional: Boolean(parameter.questionToken || parameter.initializer),
    rest: Boolean(parameter.dotDotDotToken),
    ...(parameter.initializer
      ? { defaultValue: parameter.initializer.getText(candidate.sourceFile) }
      : {}),
  }));

  const callableNode = getCallableNode(candidate.node);
  const isAsync = hasModifier(callableNode, ts.SyntaxKind.AsyncKeyword);
  const callers = findCallers(candidate, index);
  const recursiveCalls = callDetails.filter((call) => call.category === "recursive").length;
  const relatedSymbols = getRelatedSymbols(candidate, index.candidates, callDetails);

  return {
    success: true,
    projectPath: root,
    symbol,
    filePath: candidate.filePath,
    kind: candidate.kind,
    summary: createSummary(candidate, behavior, callDetails),
    signature: buildSignature(candidate),
    documentation: getDocumentation(candidate.node),
    parameters,
    returnType: getReturnType(candidate.node),
    async: isAsync,
    exported: isExported(candidate.node, candidate.sourceFile),
    startLine: candidate.startLine,
    endLine: candidate.endLine,
    ...(source !== undefined ? { source } : {}),
    behavior,
    relatedSymbols,
    warnings,
    callDetails,
    recursive: recursiveCalls > 0,
    recursiveCalls,
    ...(candidate.className ? { className: candidate.className } : {}),
    modifiers: candidate.modifiers,
    static: candidate.static ?? false,
    callers,
  };
}

export function registerExplainMethodTool(server: McpServer): void {
  server.registerTool(
    "explain_method",
    {
      description:
        "Inspect a JavaScript or TypeScript function, class, method, constructor, getter, setter, React component, or arrow-function property using the TypeScript AST. Returns its signature, parameters, documentation, source excerpt, categorized calls (with nested project-function calls), recursion detection, callers, control-flow details, React hooks, and related project symbols. Read-only.",
      inputSchema: {
        projectPath: z.string().min(1).describe(
          "Absolute path to the target project directory.",
        ),
        symbol: z.string().min(1).max(200).describe(
          "Exact function, method, class, getter, setter, constructor, component, or arrow-function variable/property name.",
        ),
        filePath: z.string().min(1).optional().describe(
          "Optional source file path relative to projectPath. Recommended when the symbol name is not unique.",
        ),
        includeSource: z.boolean().default(true).describe(
          "Whether to include the source excerpt in the result.",
        ),
      },
    },
    async ({ projectPath, symbol, filePath, includeSource }) => {
      try {
        const result = await explainMethod(
          projectPath,
          symbol,
          filePath,
          includeSource,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        const result = {
          success: false,
          tool: "explain_method",
          symbol,
          error: error instanceof Error ? error.message : String(error),
        };

        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
          structuredContent: result,
        };
      }
    },
  );
}