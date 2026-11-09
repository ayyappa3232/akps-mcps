import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveProjectPath } from "../utils/projectResolver.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

type Severity = "critical" | "high" | "medium" | "low" | "info";
type ComponentSeverity = Severity | "healthy";

/** How the component is written. */
type ComponentKind = "function" | "arrow" | "class";

/** Wrappers such as memo(...) or forwardRef(...) around the component. */
type ComponentWrapper = "memo" | "forwardRef" | "observer";

/**
 * web    - renders DOM elements (div, span, ...).
 * native - renders React Native components.
 * shared - renders neither directly (logic or wrapper components).
 */
type ComponentPlatform = "web" | "native" | "shared";

type ExportKind = "default" | "named" | "none";

type HookCategory = "react" | "redux" | "query" | "navigation" | "custom";

type Integration = "redux" | "query" | "firebase" | "navigation";

type RuleId =
  | "conditional-hook"
  | "nested-component"
  | "async-effect-callback"
  | "effect-missing-cleanup"
  | "effect-no-deps"
  | "missing-key"
  | "index-as-key"
  | "dangerous-html"
  | "whole-state-selector"
  | "new-object-selector"
  | "large-component"
  | "too-many-props"
  | "too-many-state"
  | "deep-jsx-nesting"
  | "high-complexity"
  | "prop-drilling"
  | "unused-prop"
  | "firebase-in-component"
  | "inline-styles-native"
  | "scrollview-map"
  | "unused-component"
  | "class-component";

interface ComponentProp {
  name: string;
  type?: string;
  optional: boolean;
  hasDefault: boolean;
  /** False when the prop is declared but never read in the component. */
  used: boolean;
  /** True when the prop is only forwarded to children as `x={x}`. */
  passThrough: boolean;
}

interface HookUse {
  name: string;
  count: number;
  category: HookCategory;
}

interface ComponentFinding {
  rule: RuleId;
  severity: Severity;
  title: string;
  message: string;
  line: number;
  suggestion: string;
}

interface ComponentRef {
  id: string;
  name: string;
  filePath: string;
}

interface ComponentInfo {
  id: string;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  lines: number;
  kind: ComponentKind;
  wrappers: ComponentWrapper[];
  exportKind: ExportKind;
  platform: ComponentPlatform;
  severity: ComponentSeverity;
  /** 0-100. Higher means more worth looking at. */
  riskScore: number;
  props: ComponentProp[];
  propCount: number;
  hooks: HookUse[];
  hookCount: number;
  stateCount: number;
  effectCount: number;
  jsxElements: number;
  maxJsxDepth: number;
  complexity: number;
  inlineHandlers: number;
  integrations: Integration[];
  renders: ComponentRef[];
  renderedBy: ComponentRef[];
  /** Library or unresolved elements rendered, e.g. View, Text, Link. */
  externalElements: string[];
  findings: ComponentFinding[];
  snippet: string;
  snippetTruncated: boolean;
}

interface HookUsage {
  name: string;
  category: HookCategory;
  count: number;
  componentCount: number;
}

interface CustomHookInfo {
  name: string;
  filePath: string;
  line: number;
  usedByComponents: number;
}

interface RuleCount {
  rule: RuleId;
  title: string;
  severity: Severity;
  count: number;
}

interface ReactComponentReport {
  success: boolean;
  tool: "analyze_react_components";
  projectPath: string;
  filePath?: string;
  includeTests: boolean;
  maxLines: number;
  maxProps: number;
  filesScanned: number;
  filesWithComponents: number;
  totalLines: number;
  /** Components found in the whole project, before any filePath filter. */
  projectComponentCount: number;
  totalComponents: number;
  componentsWithIssues: number;
  healthyComponents: number;
  averageLines: number;
  totalHooks: number;
  totalFindings: number;
  summary: Record<Severity, number>;
  kindCounts: Record<ComponentKind, number>;
  platformCounts: Record<ComponentPlatform, number>;
  integrationCounts: Record<Integration, number>;
  ruleCounts: RuleCount[];
  components: ComponentInfo[];
  hookUsage: HookUsage[];
  customHooks: CustomHookInfo[];
  warnings: string[];
}

interface ImportBinding {
  module: string;
  /** "default", "*" for a namespace import, or the exported name. */
  imported: string;
}

interface ReExport {
  exportName: string; // "*" for `export * from`
  importedName: string;
  module: string;
}

interface Candidate {
  localName: string;
  displayName: string;
  node: ComponentFn | ts.ClassDeclaration;
  declNode: ts.Node;
  kind: ComponentKind;
  wrappers: ComponentWrapper[];
  typeAnnotation?: ts.TypeNode;
}

type ComponentFn = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

interface FileContext {
  sf: ts.SourceFile;
  text: string;
  relPath: string;
  imports: Map<string, ImportBinding>;
  nativeBindings: Set<string>;
  firebaseBindings: Set<string>;
  interfaces: Map<string, ts.InterfaceDeclaration>;
  typeAliases: Map<string, ts.TypeAliasDeclaration>;
}

interface Limits {
  maxLines: number;
  maxProps: number;
}

interface RawComponent {
  localName: string;
  displayName: string;
  kind: ComponentKind;
  wrappers: ComponentWrapper[];
  startLine: number;
  endLine: number;
  props: ComponentProp[];
  hooks: Map<string, number>;
  stateCount: number;
  effectCount: number;
  jsxElements: number;
  maxJsxDepth: number;
  complexity: number;
  inlineHandlers: number;
  /** Full JSX tag name (e.g. "Stack.Screen") to usage count. */
  tags: Map<string, number>;
  platform: ComponentPlatform;
  integrations: Set<Integration>;
  findings: ComponentFinding[];
  snippet: string;
  snippetTruncated: boolean;
}

interface FileAnalysis {
  relPath: string;
  lineCount: number;
  imports: Map<string, ImportBinding>;
  reExports: ReExport[];
  /** Export name to local name. */
  exportMap: Map<string, string>;
  aliases: Map<string, string>;
  components: RawComponent[];
  customHooks: Array<{ name: string; line: number }>;
  /** Times each identifier is used as a value or JSX tag (not declared or exported). */
  refCounts: Map<string, number>;
  dynamicImports: string[];
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

const RESOLVE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".mts", ".cts"];

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
  ".expo",
  "android",
  "ios",
  "generated-diagrams",
]);

const TEST_FILE_PATTERN =
  /(^|\/)(__tests__|__mocks__|tests?|e2e|cypress)\/|\.(test|spec|stories)\.[cm]?[jt]sx?$/;

const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_COMPONENTS = 400;
const MAX_SNIPPET_LINES = 40;
const MAX_WARNINGS = 25;
const MAX_HOOK_USAGE = 30;
const MAX_CUSTOM_HOOKS = 60;
const MAX_EXTERNAL_ELEMENTS = 24;
const MAX_TYPE_LENGTH = 80;

const DEFAULT_MAX_LINES = 150;
const DEFAULT_MAX_PROPS = 7;

const REACT_HOOKS = new Set([
  "useState",
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
  "useMemo",
  "useCallback",
  "useRef",
  "useContext",
  "useReducer",
  "useImperativeHandle",
  "useDebugValue",
  "useId",
  "useTransition",
  "useDeferredValue",
  "useSyncExternalStore",
  "useOptimistic",
  "useActionState",
  "useFormStatus",
]);

const REDUX_HOOKS = new Set([
  "useSelector",
  "useDispatch",
  "useStore",
  "useAppSelector",
  "useAppDispatch",
  "useAppStore",
]);

const NAVIGATION_HOOKS = new Set([
  "useNavigate",
  "useParams",
  "useLocation",
  "useSearchParams",
  "useNavigation",
  "useRoute",
  "useRouter",
  "usePathname",
  "useSegments",
  "useLocalSearchParams",
  "useFocusEffect",
  "useIsFocused",
  "useNavigationState",
  "useMatch",
  "useHistory",
]);

const QUERY_HOOK_PATTERN = /^use\w*(Query|Mutation|Subscription)$/;

const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);

/** Calls that start something which must be stopped when the component unmounts. */
const SUBSCRIPTION_CALLS = new Set([
  "addEventListener",
  "addListener",
  "setInterval",
  "subscribe",
  "on",
  "onSnapshot",
  "onAuthStateChanged",
  "onIdTokenChanged",
  "onValue",
  "onChildAdded",
  "onChildChanged",
  "onChildRemoved",
]);

const FIREBASE_MODULE = /^(firebase|@firebase|@react-native-firebase|react-firebase-hooks)(\/|$)/;

const NATIVE_MODULE =
  /^(react-native|@react-native|react-native-|expo|@expo\/)(\/|-|$|.)/;

const HTML_TAGS = new Set([
  "a", "abbr", "article", "aside", "audio", "b", "blockquote", "body", "br", "button",
  "canvas", "code", "dd", "details", "div", "dl", "dt", "em", "fieldset", "figcaption",
  "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i",
  "iframe", "img", "input", "label", "legend", "li", "main", "nav", "ol", "option",
  "p", "pre", "section", "select", "small", "span", "strong", "sub", "summary", "sup",
  "svg", "table", "tbody", "td", "textarea", "tfoot", "th", "thead", "tr", "u", "ul", "video",
]);

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 30,
  high: 18,
  medium: 9,
  low: 4,
  info: 1,
};

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

const RULES: Record<RuleId, { title: string; severity: Severity; advice: string }> = {
  "conditional-hook": {
    title: "Hook called conditionally",
    severity: "high",
    advice:
      "Hooks must run in the same order on every render. Move the hook above any condition, loop or early return, and put the condition inside the hook instead.",
  },
  "nested-component": {
    title: "Component defined inside a component",
    severity: "high",
    advice:
      "A component created during render is a new type every time, so React remounts it and loses its state. Move it to module scope and pass what it needs as props.",
  },
  "async-effect-callback": {
    title: "Async effect callback",
    severity: "medium",
    advice:
      "An effect callback must return nothing or a cleanup function, not a promise. Define an async function inside the effect and call it.",
  },
  "effect-missing-cleanup": {
    title: "Subscription without cleanup",
    severity: "high",
    advice:
      "Return a cleanup function from the effect that unsubscribes (for Firebase, `return onSnapshot(...)` or call the unsubscribe handle) so listeners and timers are not leaked on unmount.",
  },
  "effect-no-deps": {
    title: "Effect without a dependency array",
    severity: "low",
    advice:
      "Without a dependency array the effect runs after every render. Add an array with the values it reads, or [] to run it once.",
  },
  "missing-key": {
    title: "List item without a key",
    severity: "medium",
    advice:
      "Give the root element returned from .map() a stable `key` taken from the data, such as an id.",
  },
  "index-as-key": {
    title: "Array index used as key",
    severity: "low",
    advice:
      "Index keys cause wrong updates when the list is reordered, filtered or inserted into. Use a stable id from the data instead.",
  },
  "dangerous-html": {
    title: "dangerouslySetInnerHTML",
    severity: "high",
    advice:
      "Injecting raw HTML can allow cross-site scripting. Render the content as React elements, or sanitize it first (for example with DOMPurify).",
  },
  "whole-state-selector": {
    title: "Selector reads the whole store",
    severity: "medium",
    advice:
      "Selecting the entire state re-renders this component on every store update. Select only the slice or fields it needs.",
  },
  "new-object-selector": {
    title: "Selector returns a new object each time",
    severity: "medium",
    advice:
      "A selector that builds a new object or array (literals, .map, .filter) re-renders on every store update. Use createSelector from Redux Toolkit, or select primitives separately.",
  },
  "large-component": {
    title: "Large component",
    severity: "low",
    advice:
      "Split it into smaller components and move data logic into custom hooks so each piece has one job and is easier to test.",
  },
  "too-many-props": {
    title: "Too many props",
    severity: "low",
    advice:
      "Group related props into an object, use composition (children or render props), or split the component by responsibility.",
  },
  "too-many-state": {
    title: "Too much local state",
    severity: "low",
    advice:
      "Combine related values with useReducer, move shared state to a Redux slice, or extract the state logic into a custom hook.",
  },
  "deep-jsx-nesting": {
    title: "Deeply nested JSX",
    severity: "low",
    advice:
      "Extract inner blocks into named components so the markup stays shallow and readable.",
  },
  "high-complexity": {
    title: "High complexity",
    severity: "low",
    advice:
      "Too many branches in one place makes behavior hard to follow. Extract branches into helper functions, custom hooks or child components.",
  },
  "prop-drilling": {
    title: "Props only passed down",
    severity: "low",
    advice:
      "These props are not used here, only forwarded. Consider React context, a Redux selector in the child that needs them, or composition.",
  },
  "unused-prop": {
    title: "Unused prop",
    severity: "low",
    advice:
      "Remove the prop from the type and from every caller, or use it. Unused props make the component harder to understand.",
  },
  "firebase-in-component": {
    title: "Firebase called directly from a component",
    severity: "info",
    advice:
      "Move Firebase calls into a service module, thunk or RTK Query endpoint. Components stay simpler, and the data layer becomes easy to mock and reuse.",
  },
  "inline-styles-native": {
    title: "Many inline styles",
    severity: "low",
    advice:
      "Move style objects into StyleSheet.create so they are created once instead of on every render.",
  },
  "scrollview-map": {
    title: "List rendered inside a ScrollView",
    severity: "low",
    advice:
      "ScrollView renders every item at once. Use FlatList or SectionList so long lists are virtualized.",
  },
  "unused-component": {
    title: "Component is never used",
    severity: "low",
    advice:
      "Nothing in the project renders or references this component. Confirm it is not a route or screen registered elsewhere, then delete it.",
  },
  "class-component": {
    title: "Class component",
    severity: "info",
    advice:
      "Function components with hooks are the current standard and are easier to share logic between. Convert it when you next touch the file.",
  },
};

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function isPascal(value: string): boolean {
  return /^[A-Z]/.test(value) && /[a-z]/.test(value);
}

function isHookName(value: string): boolean {
  return /^use[A-Z0-9]/.test(value);
}

function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
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

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function endLineOf(sf: ts.SourceFile, node: ts.Node): number {
  return (
    sf.getLineAndCharacterOfPosition(Math.max(node.getStart(sf), node.end - 1)).line + 1
  );
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
  );
}

function skipOuter(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isFunctionExpressionLike(
  node: ts.Node,
): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/** The last name of a callee: `useState` for `React.useState`. */
function calleeName(expression: ts.Expression): string | undefined {
  const target = skipOuter(expression);
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return undefined;
}

/** The leftmost identifier of a call chain: `firestore` for `firestore().collection()`. */
function rootIdentifier(expression: ts.Expression): string | undefined {
  let current: ts.Expression = expression;

  for (let guard = 0; guard < 50; guard++) {
    if (ts.isIdentifier(current)) return current.text;
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current) ||
      ts.isCallExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isAwaitExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return undefined;
  }

  return undefined;
}

/** `useX(...)` or `React.useX(...)`. */
function hookNameOf(expression: ts.Expression): string | undefined {
  const target = skipOuter(expression);

  if (ts.isIdentifier(target) && isHookName(target.text)) return target.text;

  if (
    ts.isPropertyAccessExpression(target) &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === "React" &&
    isHookName(target.name.text)
  ) {
    return target.name.text;
  }

  return undefined;
}

function hookCategory(name: string): HookCategory {
  if (REACT_HOOKS.has(name)) return "react";
  if (REDUX_HOOKS.has(name)) return "redux";
  if (NAVIGATION_HOOKS.has(name)) return "navigation";
  if (QUERY_HOOK_PATTERN.test(name)) return "query";
  return "custom";
}

function containsJsx(root: ts.Node): boolean {
  let found = false;

  const visit = (node: ts.Node) => {
    if (found) return;

    if (
      ts.isJsxElement(node) ||
      ts.isJsxSelfClosingElement(node) ||
      ts.isJsxFragment(node)
    ) {
      found = true;
      return;
    }

    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name === "createElement" || name === "cloneElement") {
        found = true;
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(root);
  return found;
}

function callsHook(root: ts.Node): boolean {
  let found = false;

  const visit = (node: ts.Node) => {
    if (found) return;

    if (ts.isCallExpression(node) && hookNameOf(node.expression)) {
      found = true;
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(root);
  return found;
}

function looksLikeComponent(fn: ts.Node): boolean {
  return containsJsx(fn) || callsHook(fn);
}

function toPascalCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

function nameFromFile(relPath: string): string {
  const parsed = path.posix.parse(relPath);
  const base =
    parsed.name === "index" ? path.posix.basename(parsed.dir) || "Index" : parsed.name;
  return toPascalCase(base) || "Anonymous";
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
/*  Reference and declaration checks                                          */
/* -------------------------------------------------------------------------- */

/** True when an identifier reads a value, as opposed to naming something. */
function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;

  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent)) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isJsxAttribute(parent) && parent.name === node) return false;
  if (ts.isBindingElement(parent)) return false;
  if (ts.isParameter(parent) && parent.name === node) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return false;
  if (ts.isFunctionExpression(parent) && parent.name === node) return false;
  if (ts.isClassDeclaration(parent) && parent.name === node) return false;
  if (ts.isClassExpression(parent) && parent.name === node) return false;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return false;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return false;
  if (ts.isGetAccessorDeclaration(parent) && parent.name === node) return false;
  if (ts.isSetAccessorDeclaration(parent) && parent.name === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent)) return false;
  if (ts.isNamespaceImport(parent) || ts.isExportSpecifier(parent)) return false;
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
  if (ts.isEnumMember(parent) && parent.name === node) return false;
  if (ts.isTypeReferenceNode(parent)) return false;

  return true;
}

/**
 * True when `node` is the value of a JSX attribute (or a spread) on a component
 * element, such as `<Card title={title} />`. Attributes on DOM elements and
 * React Native primitives are real use, not forwarding.
 */
function isForwardedToComponent(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;

  let attribute: ts.Node | undefined;

  if (ts.isJsxSpreadAttribute(parent)) attribute = parent;
  else if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)) attribute = parent.parent;

  const element = attribute?.parent?.parent;

  if (
    !element ||
    !(ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element))
  ) {
    return false;
  }

  const tag = element.tagName;
  const rootName = ts.isIdentifier(tag)
    ? tag.text
    : ts.isPropertyAccessExpression(tag)
      ? rootIdentifier(tag)
      : undefined;

  return Boolean(rootName && /^[A-Z]/.test(rootName));
}

function isPassThroughReference(node: ts.Identifier): boolean {
  return isForwardedToComponent(node);
}

/* -------------------------------------------------------------------------- */
/*  Props                                                                     */
/* -------------------------------------------------------------------------- */

interface PropMember {
  type?: string;
  optional: boolean;
}

function propertyKeyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

/** Collects members of a props type. Returns false when part of it could not be read. */
function collectTypeMembers(
  type: ts.TypeNode | undefined,
  ctx: FileContext,
  out: Map<string, PropMember>,
  depth = 0,
): boolean {
  if (!type || depth > 6) return false;

  if (ts.isParenthesizedTypeNode(type)) {
    return collectTypeMembers(type.type, ctx, out, depth + 1);
  }

  if (ts.isTypeLiteralNode(type)) {
    addMembers(type.members, ctx, out);
    return true;
  }

  if (ts.isIntersectionTypeNode(type)) {
    let complete = true;
    for (const part of type.types) {
      if (!collectTypeMembers(part, ctx, out, depth + 1)) complete = false;
    }
    return complete;
  }

  if (ts.isTypeReferenceNode(type)) {
    const name = type.typeName.getText(ctx.sf);

    if (
      /^(React\.)?(PropsWithChildren|PropsWithoutRef|Readonly)$/.test(name) &&
      type.typeArguments?.[0]
    ) {
      if (name.endsWith("PropsWithChildren") && !out.has("children")) {
        out.set("children", { type: "ReactNode", optional: true });
      }
      return collectTypeMembers(type.typeArguments[0], ctx, out, depth + 1);
    }

    const declared = ctx.interfaces.get(name);
    if (declared) {
      addMembers(declared.members, ctx, out);
      let complete = true;

      for (const heritage of declared.heritageClauses ?? []) {
        if (heritage.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const parent of heritage.types) {
          const parentName = parent.expression.getText(ctx.sf);
          const parentDecl = ctx.interfaces.get(parentName);
          const parentAlias = ctx.typeAliases.get(parentName);

          if (parentDecl) {
            addMembers(parentDecl.members, ctx, out);
          } else if (parentAlias) {
            if (!collectTypeMembers(parentAlias.type, ctx, out, depth + 1)) complete = false;
          } else {
            complete = false;
          }
        }
      }

      return complete;
    }

    const alias = ctx.typeAliases.get(name);
    if (alias) return collectTypeMembers(alias.type, ctx, out, depth + 1);

    return false;
  }

  return false;
}

function addMembers(
  members: ts.NodeArray<ts.TypeElement>,
  ctx: FileContext,
  out: Map<string, PropMember>,
) {
  for (const member of members) {
    if (!ts.isPropertySignature(member) && !ts.isMethodSignature(member)) continue;

    const name = propertyKeyName(member.name);
    if (!name) continue;

    out.set(name, {
      type: member.type ? truncate(member.type.getText(ctx.sf), MAX_TYPE_LENGTH) : undefined,
      optional: Boolean(member.questionToken),
    });
  }
}

const FC_TYPE = /^(React\.)?(FC|FunctionComponent|VFC|VoidFunctionComponent)$/;

function propsTypeNode(candidate: Candidate, ctx: FileContext): ts.TypeNode | undefined {
  const node = candidate.node;

  if (ts.isClassDeclaration(node)) {
    const heritage = node.heritageClauses?.find(
      (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
    );
    return heritage?.types[0]?.typeArguments?.[0];
  }

  const param = node.parameters[0];
  if (param?.type) return param.type;

  const annotation = candidate.typeAnnotation;
  if (!annotation) return undefined;

  if (ts.isTypeReferenceNode(annotation)) {
    const name = annotation.typeName.getText(ctx.sf);
    if (FC_TYPE.test(name)) return annotation.typeArguments?.[0];
  }

  return annotation;
}

interface PropsInfo {
  declared: Map<string, PropMember>;
  /** Local variable name to prop name, for destructured parameters. */
  destructured: Map<string, { prop: string; hasDefault: boolean }>;
  paramName?: string;
  hasRest: boolean;
  /** Props destructured into a nested pattern, which are always treated as used. */
  nestedProps: Set<string>;
  /** True when every prop could be read from the types. */
  complete: boolean;
}

function extractProps(candidate: Candidate, ctx: FileContext): PropsInfo {
  const info: PropsInfo = {
    declared: new Map(),
    destructured: new Map(),
    hasRest: false,
    nestedProps: new Set(),
    complete: true,
  };

  const typeNode = propsTypeNode(candidate, ctx);
  if (typeNode) {
    info.complete = collectTypeMembers(typeNode, ctx, info.declared);
  } else {
    info.complete = true;
  }

  const node = candidate.node;

  if (ts.isClassDeclaration(node)) {
    // Props are read through `this.props`, which is not tracked.
    info.complete = false;
    return info;
  }

  const param = node.parameters[0];
  if (!param) return info;

  if (ts.isIdentifier(param.name)) {
    info.paramName = param.name.text;
    return info;
  }

  if (ts.isObjectBindingPattern(param.name)) {
    for (const element of param.name.elements) {
      if (element.dotDotDotToken) {
        info.hasRest = true;
        continue;
      }

      const prop = element.propertyName
        ? ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName)
          ? element.propertyName.text
          : undefined
        : ts.isIdentifier(element.name)
          ? element.name.text
          : undefined;

      if (!prop) continue;

      const local = ts.isIdentifier(element.name) ? element.name.text : undefined;

      if (local) {
        info.destructured.set(local, { prop, hasDefault: Boolean(element.initializer) });
      } else {
        info.nestedProps.add(prop);
      }

      if (!info.declared.has(prop)) {
        info.declared.set(prop, { optional: Boolean(element.initializer) });
        if (!typeNode) info.complete = true;
      }
    }
  }

  return info;
}

/* -------------------------------------------------------------------------- */
/*  Component discovery                                                       */
/* -------------------------------------------------------------------------- */

interface Unwrapped {
  fn?: ts.ArrowFunction | ts.FunctionExpression;
  identifier?: string;
  wrappers: ComponentWrapper[];
  genericProps?: ts.TypeNode;
}

/** Unwraps memo(...), forwardRef(...) and observer(...) around a component. */
function unwrapComponentExpression(expression: ts.Expression): Unwrapped {
  const wrappers: ComponentWrapper[] = [];
  let genericProps: ts.TypeNode | undefined;
  let current = skipOuter(expression);

  while (ts.isCallExpression(current)) {
    const name = calleeName(current.expression);

    if (name !== "memo" && name !== "forwardRef" && name !== "observer") break;

    wrappers.push(name);

    if (name === "forwardRef" && current.typeArguments?.[1]) {
      genericProps = current.typeArguments[1];
    }

    const argument = current.arguments[0];
    if (!argument) break;

    current = skipOuter(argument);
  }

  if (isFunctionExpressionLike(current)) {
    return { fn: current, wrappers, genericProps };
  }

  if (ts.isIdentifier(current)) {
    return { identifier: current.text, wrappers, genericProps };
  }

  return { wrappers, genericProps };
}

/** Finds which known component an expression like connect(...)(Foo) refers to. */
function findComponentName(
  expression: ts.Expression,
  known: (name: string) => string | undefined,
  depth = 0,
): string | undefined {
  if (depth > 6) return undefined;

  const target = skipOuter(expression);

  if (ts.isIdentifier(target)) return known(target.text);

  if (ts.isCallExpression(target)) {
    for (let index = target.arguments.length - 1; index >= 0; index--) {
      const found = findComponentName(target.arguments[index], known, depth + 1);
      if (found) return found;
    }
    return findComponentName(target.expression, known, depth + 1);
  }

  return undefined;
}

function isClassComponent(node: ts.ClassDeclaration): boolean {
  const heritage = node.heritageClauses?.find(
    (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
  );
  const base = heritage?.types[0]?.expression;
  if (!base) return false;

  const text = base.getText();
  return /(^|\.)(Pure)?Component$/.test(text);
}

function analyzeSourceFile(
  absolute: string,
  relPath: string,
  text: string,
  limits: Limits,
): FileAnalysis {
  const sf = ts.createSourceFile(
    absolute,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(absolute),
  );

  const ctx: FileContext = {
    sf,
    text,
    relPath,
    imports: new Map(),
    nativeBindings: new Set(),
    firebaseBindings: new Set(),
    interfaces: new Map(),
    typeAliases: new Map(),
  };

  const analysis: FileAnalysis = {
    relPath,
    lineCount: sf.getLineAndCharacterOfPosition(text.length).line + 1,
    imports: ctx.imports,
    reExports: [],
    exportMap: new Map(),
    aliases: new Map(),
    components: [],
    customHooks: [],
    refCounts: new Map(),
    dynamicImports: [],
  };

  const candidates: Candidate[] = [];
  const pendingAliases: Array<{ alias: string; expression: ts.Expression }> = [];
  const pendingDefaults: ts.Expression[] = [];

  /* ---- Pass 1: imports, types, candidates ---- */

  for (const statement of sf.statements) {
    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteral(statement.moduleReference.expression)
    ) {
      const module = statement.moduleReference.expression.text;
      const local = statement.name.text;
      ctx.imports.set(local, { module, imported: "default" });
      if (NATIVE_MODULE.test(module)) ctx.nativeBindings.add(local);
      if (FIREBASE_MODULE.test(module)) ctx.firebaseBindings.add(local);
      continue;
    }

    if (ts.isImportDeclaration(statement)) {
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const module = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (!clause) continue;

      const bind = (local: string, imported: string) => {
        ctx.imports.set(local, { module, imported });
        if (NATIVE_MODULE.test(module)) ctx.nativeBindings.add(local);
        if (FIREBASE_MODULE.test(module)) ctx.firebaseBindings.add(local);
      };

      if (clause.name) bind(clause.name.text, "default");

      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          bind(clause.namedBindings.name.text, "*");
        } else {
          for (const element of clause.namedBindings.elements) {
            bind(element.name.text, (element.propertyName ?? element.name).text);
          }
        }
      }
      continue;
    }

    if (ts.isInterfaceDeclaration(statement)) {
      ctx.interfaces.set(statement.name.text, statement);
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      ctx.typeAliases.set(statement.name.text, statement);
    }
  }

  for (const statement of sf.statements) {
    const isExported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);

    if (ts.isFunctionDeclaration(statement) && statement.body) {
      const name = statement.name?.text;

      if (name && isHookName(name)) {
        analysis.customHooks.push({ name, line: lineOf(sf, statement) });
      } else if (
        ((name && isPascal(name)) || (!name && isDefault)) &&
        looksLikeComponent(statement)
      ) {
        candidates.push({
          localName: name ?? "__default",
          displayName: name ?? nameFromFile(relPath),
          node: statement,
          declNode: statement,
          kind: "function",
          wrappers: [],
        });
      }

      if (isDefault) analysis.exportMap.set("default", name ?? "__default");
      else if (isExported && name) analysis.exportMap.set(name, name);
      continue;
    }

    if (ts.isClassDeclaration(statement)) {
      const name = statement.name?.text;

      if (isClassComponent(statement) && (name || isDefault)) {
        candidates.push({
          localName: name ?? "__default",
          displayName: name ?? nameFromFile(relPath),
          node: statement,
          declNode: statement,
          kind: "class",
          wrappers: [],
        });
      }

      if (isDefault) analysis.exportMap.set("default", name ?? "__default");
      else if (isExported && name) analysis.exportMap.set(name, name);
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const declarations = statement.declarationList.declarations;

      for (const declaration of declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;

        const name = declaration.name.text;
        const unwrapped = unwrapComponentExpression(declaration.initializer);

        if (isExported) analysis.exportMap.set(name, name);

        if (unwrapped.fn) {
          if (isHookName(name)) {
            analysis.customHooks.push({ name, line: lineOf(sf, declaration) });
            continue;
          }

          if (isPascal(name) && looksLikeComponent(unwrapped.fn)) {
            candidates.push({
              localName: name,
              displayName: name,
              node: unwrapped.fn,
              declNode: declarations.length === 1 ? statement : declaration,
              kind: ts.isArrowFunction(unwrapped.fn) ? "arrow" : "function",
              wrappers: unwrapped.wrappers,
              typeAnnotation: declaration.type ?? unwrapped.genericProps,
            });
          }
          continue;
        }

        if (isPascal(name)) {
          pendingAliases.push({ alias: name, expression: declaration.initializer });
        }
      }
      continue;
    }

    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      statement.expression.left.getText(sf) === "module.exports"
    ) {
      pendingDefaults.push(statement.expression.right);
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      const unwrapped = unwrapComponentExpression(statement.expression);

      if (unwrapped.fn && looksLikeComponent(unwrapped.fn)) {
        candidates.push({
          localName: "__default",
          displayName: nameFromFile(relPath),
          node: unwrapped.fn,
          declNode: statement,
          kind: ts.isArrowFunction(unwrapped.fn) ? "arrow" : "function",
          wrappers: unwrapped.wrappers,
          typeAnnotation: unwrapped.genericProps,
        });
        analysis.exportMap.set("default", "__default");
      } else {
        pendingDefaults.push(statement.expression);
      }
      continue;
    }

    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const clause = statement.exportClause;
      const module =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : undefined;

      if (!clause) {
        if (module) {
          analysis.reExports.push({ exportName: "*", importedName: "*", module });
        }
        continue;
      }

      if (ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          const exported = element.name.text;
          const original = (element.propertyName ?? element.name).text;

          if (module) {
            analysis.reExports.push({
              exportName: exported,
              importedName: original,
              module,
            });
          } else {
            analysis.exportMap.set(exported, original);
          }
        }
      }
    }
  }

  /* ---- Resolve aliases and `export default expr` ---- */

  const candidateNames = new Set(candidates.map((candidate) => candidate.localName));

  const knownName = (name: string): string | undefined => {
    if (candidateNames.has(name)) return name;
    const alias = analysis.aliases.get(name);
    if (alias && candidateNames.has(alias)) return alias;
    return ctx.imports.has(name) ? name : undefined;
  };

  for (let round = 0; round < 2; round++) {
    for (const { alias, expression } of pendingAliases) {
      if (analysis.aliases.has(alias)) continue;
      const target = findComponentName(expression, (name) =>
        candidateNames.has(name) || analysis.aliases.has(name)
          ? (analysis.aliases.get(name) ?? name)
          : undefined,
      );
      if (target) analysis.aliases.set(alias, target);
    }
  }

  for (const expression of pendingDefaults) {
    const target = findComponentName(expression, knownName);
    if (target) analysis.exportMap.set("default", target);
  }

  /* ---- Pass 2: reference counts and dynamic imports ---- */

  const countRef = (name: string) =>
    analysis.refCounts.set(name, (analysis.refCounts.get(name) ?? 0) + 1);

  const scanRefs = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isTypeNode(node)) return;
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) {
        analysis.dynamicImports.push(argument.text);
      }
    }

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName;
      const root = ts.isIdentifier(tag)
        ? tag.text
        : ts.isPropertyAccessExpression(tag)
          ? rootIdentifier(tag)
          : undefined;
      if (root && isPascal(root)) countRef(root);
    }

    if (ts.isIdentifier(node) && isReferenceIdentifier(node)) {
      const parent = node.parent;

      const isExportPosition =
        (parent && ts.isExportAssignment(parent)) ||
        (parent && ts.isExportSpecifier(parent));

      const isAssignmentTarget =
        parent &&
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        parent.parent &&
        ts.isBinaryExpression(parent.parent) &&
        parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.parent.left === parent;

      const isJsxTagName =
        parent &&
        (ts.isJsxOpeningElement(parent) ||
          ts.isJsxSelfClosingElement(parent) ||
          ts.isJsxClosingElement(parent));

      if (!isExportPosition && !isAssignmentTarget && !isJsxTagName) countRef(node.text);
    }

    ts.forEachChild(node, scanRefs);
  };

  scanRefs(sf);

  /* ---- Analyze each component ---- */

  const lines = text.split(/\r?\n/);

  for (const candidate of candidates) {
    analysis.components.push(analyzeCandidate(ctx, candidate, limits, lines));
  }

  return analysis;
}

/* -------------------------------------------------------------------------- */
/*  Component analysis                                                        */
/* -------------------------------------------------------------------------- */

interface VisitState {
  fnDepth: number;
  conditional?: string;
  jsxDepth: number;
}

function collectReturnedExpressions(fn: ts.ArrowFunction | ts.FunctionExpression): ts.Expression[] {
  if (!ts.isBlock(fn.body)) return [fn.body];

  const results: ts.Expression[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node) && node !== fn) return;
    if (ts.isReturnStatement(node) && node.expression) results.push(node.expression);
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(fn.body, visit);
  return results;
}

function jsxRoots(expression: ts.Expression, depth = 0): Array<ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment> {
  if (depth > 5) return [];

  const target = skipOuter(expression);

  if (ts.isJsxElement(target) || ts.isJsxSelfClosingElement(target) || ts.isJsxFragment(target)) {
    return [target];
  }

  if (ts.isConditionalExpression(target)) {
    return [
      ...jsxRoots(target.whenTrue, depth + 1),
      ...jsxRoots(target.whenFalse, depth + 1),
    ];
  }

  if (
    ts.isBinaryExpression(target) &&
    (target.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      target.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return jsxRoots(target.right, depth + 1);
  }

  return [];
}

function containsMapCall(root: ts.Node): boolean {
  let found = false;

  const visit = (node: ts.Node) => {
    if (found) return;

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "map"
    ) {
      found = true;
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(root);
  return found;
}

function scanEffectCallback(callback: ts.Expression | undefined): {
  subscribes: string[];
  hasCleanup: boolean;
} {
  if (!callback || !isFunctionExpressionLike(skipOuter(callback))) {
    return { subscribes: [], hasCleanup: true };
  }

  const fn = skipOuter(callback) as ts.ArrowFunction | ts.FunctionExpression;
  const subscribes: string[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name && SUBSCRIPTION_CALLS.has(name)) {
        // `.on(` is only a subscription when called on something.
        if (name !== "on" || ts.isPropertyAccessExpression(skipOuter(node.expression))) {
          subscribes.push(name);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(fn.body);

  let hasCleanup: boolean;

  if (!ts.isBlock(fn.body)) {
    const body = skipOuter(fn.body);
    const name = ts.isCallExpression(body) ? calleeName(body.expression) : undefined;
    hasCleanup = Boolean(name && SUBSCRIPTION_CALLS.has(name)) || isFunctionExpressionLike(body);
  } else {
    hasCleanup = collectReturnedExpressions(fn).length > 0;
  }

  return { subscribes, hasCleanup };
}

function analyzeCandidate(
  ctx: FileContext,
  candidate: Candidate,
  limits: Limits,
  fileLines: string[],
): RawComponent {
  const { sf } = ctx;
  const root = candidate.node;
  const startLine = lineOf(sf, candidate.declNode);
  const endLine = endLineOf(sf, candidate.declNode);

  const findings: ComponentFinding[] = [];

  const add = (
    rule: RuleId,
    where: ts.Node | number,
    message: string,
    severity?: Severity,
  ) => {
    findings.push({
      rule,
      severity: severity ?? RULES[rule].severity,
      title: RULES[rule].title,
      message,
      line: typeof where === "number" ? where : lineOf(sf, where),
      suggestion: RULES[rule].advice,
    });
  };

  const propsInfo = extractProps(candidate, ctx);
  const propRefs = new Map<string, { total: number; passThrough: number }>();
  let wholePropsUsed = false;

  const noteProp = (prop: string, passThrough: boolean) => {
    const entry = propRefs.get(prop) ?? { total: 0, passThrough: 0 };
    entry.total++;
    if (passThrough) entry.passThrough++;
    propRefs.set(prop, entry);
  };

  const hooks = new Map<string, number>();
  const tags = new Map<string, number>();
  const integrations = new Set<Integration>();

  let stateCount = 0;
  let effectCount = 0;
  let jsxElements = 0;
  let maxJsxDepth = 0;
  let complexity = 1;
  let inlineHandlers = 0;
  let inlineStyles = 0;
  let domTags = 0;
  let nativeTags = 0;
  let firebaseCalls = 0;
  let firstFirebaseLine = 0;
  let earlyReturn = false;

  const visit = (node: ts.Node, st: VisitState): void => {
    if (ts.isTypeNode(node)) return;

    /* ---- Components defined inside this one ---- */

    if (node !== root) {
      let nestedName: string | undefined;

      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        node.body &&
        isPascal(node.name.text) &&
        containsJsx(node)
      ) {
        nestedName = node.name.text;
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        isPascal(node.name.text)
      ) {
        const unwrapped = unwrapComponentExpression(node.initializer);
        if (unwrapped.fn && containsJsx(unwrapped.fn)) nestedName = node.name.text;
      }

      if (nestedName) {
        add(
          "nested-component",
          node,
          `${nestedName} is created inside ${candidate.displayName}, so it is re-created on every render and remounts.`,
        );
        return;
      }
    }

    /* ---- Destructuring of the whole props object ---- */

    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      node.initializer.text === propsInfo.paramName
    ) {
      for (const element of node.name.elements) {
        if (element.dotDotDotToken) {
          wholePropsUsed = true;
          continue;
        }
        const prop = element.propertyName
          ? ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : undefined
          : ts.isIdentifier(element.name)
            ? element.name.text
            : undefined;
        if (prop) noteProp(prop, false);
      }
      return;
    }

    /* ---- props.x ---- */

    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === propsInfo.paramName
    ) {
      noteProp(node.name.text, isPassThroughReferenceExpression(node));
      return;
    }

    /* ---- Identifiers ---- */

    if (ts.isIdentifier(node)) {
      if (!isReferenceIdentifier(node)) return;

      const destructured = propsInfo.destructured.get(node.text);
      if (destructured) {
        noteProp(destructured.prop, isPassThroughReference(node));
      } else if (node.text === propsInfo.paramName) {
        wholePropsUsed = true;
      }
      return;
    }

    /* ---- Complexity ---- */

    switch (node.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ConditionalExpression:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CatchClause:
        complexity++;
        break;
      case ts.SyntaxKind.CaseClause:
        complexity++;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const operator = (node as ts.BinaryExpression).operatorToken.kind;
        if (
          operator === ts.SyntaxKind.AmpersandAmpersandToken ||
          operator === ts.SyntaxKind.BarBarToken ||
          operator === ts.SyntaxKind.QuestionQuestionToken
        ) {
          complexity++;
        }
        break;
      }
      default:
        break;
    }

    /* ---- Control flow that makes hooks conditional ---- */

    if (ts.isIfStatement(node)) {
      visit(node.expression, st);
      const inner: VisitState = { ...st, conditional: st.conditional ?? "an if statement" };
      visit(node.thenStatement, inner);
      if (node.elseStatement) visit(node.elseStatement, inner);
      return;
    }

    if (ts.isConditionalExpression(node)) {
      visit(node.condition, st);
      const inner: VisitState = { ...st, conditional: st.conditional ?? "a ternary expression" };
      visit(node.whenTrue, inner);
      visit(node.whenFalse, inner);
      return;
    }

    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      visit(node.left, st);
      visit(node.right, {
        ...st,
        conditional: st.conditional ?? "a short-circuit expression",
      });
      return;
    }

    if (
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)
    ) {
      const inner: VisitState = { ...st, conditional: st.conditional ?? "a loop" };
      ts.forEachChild(node, (child) => visit(child, inner));
      return;
    }

    if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      const inner: VisitState = { ...st, conditional: st.conditional ?? "a switch case" };
      ts.forEachChild(node, (child) => visit(child, inner));
      return;
    }

    /* ---- Nested functions ---- */

    if (node !== root && ts.isFunctionLike(node)) {
      const inner: VisitState = { ...st, fnDepth: st.fnDepth + 1 };
      ts.forEachChild(node, (child) => visit(child, inner));
      return;
    }

    /* ---- JSX ---- */

    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      jsxElements++;
      const depth = st.jsxDepth + 1;
      if (depth > maxJsxDepth) maxJsxDepth = depth;

      if (ts.isJsxSelfClosingElement(node)) {
        recordTag(node.tagName);
        if (node.tagName.getText(sf) === "ScrollView" && containsMapCall(node)) {
          add("scrollview-map", node, "A ScrollView renders a list with .map().");
        }
      }

      if (ts.isJsxElement(node)) {
        recordTag(node.openingElement.tagName);
        if (node.openingElement.tagName.getText(sf) === "ScrollView" && containsMapCall(node)) {
          add("scrollview-map", node, "A ScrollView renders a list with .map().");
        }
      }

      const inner: VisitState = { ...st, jsxDepth: depth };
      ts.forEachChild(node, (child) => visit(child, inner));
      return;
    }

    if (ts.isJsxAttribute(node)) {
      const name = ts.isIdentifier(node.name) ? node.name.text : undefined;
      const initializer = node.initializer;

      if (name === "dangerouslySetInnerHTML") {
        add("dangerous-html", node, "Raw HTML is injected with dangerouslySetInnerHTML.");
      }

      if (initializer && ts.isJsxExpression(initializer) && initializer.expression) {
        const expression = skipOuter(initializer.expression);

        if (isFunctionExpressionLike(expression)) inlineHandlers++;

        if (name === "style" && ts.isObjectLiteralExpression(expression)) inlineStyles++;
      }
    }

    /* ---- Calls ---- */

    if (ts.isCallExpression(node)) {
      handleCall(node, st);
    }

    /* ---- Statements that may end the function early ---- */

    ts.forEachChild(node, (child) => visit(child, st));
  };

  function isPassThroughReferenceExpression(node: ts.PropertyAccessExpression): boolean {
    return isForwardedToComponent(node);
  }

  function recordTag(tagName: ts.JsxTagNameExpression) {
    const full = tagName.getText(sf);
    const rootName = full.split(".")[0];

    if (/^[a-z]/.test(rootName) && !full.includes(".")) {
      if (HTML_TAGS.has(full)) domTags++;
      return;
    }

    if (!isPascal(rootName) && !/^[A-Z]/.test(rootName)) return;

    tags.set(full, (tags.get(full) ?? 0) + 1);
    if (ctx.nativeBindings.has(rootName)) nativeTags++;
  }

  function handleCall(node: ts.CallExpression, st: VisitState) {
    const hook = hookNameOf(node.expression);

    if (hook && st.fnDepth === 0) {
      hooks.set(hook, (hooks.get(hook) ?? 0) + 1);

      if (st.conditional) {
        add(
          "conditional-hook",
          node,
          `${hook} is called inside ${st.conditional}, so the hook order can change between renders.`,
        );
      }

      if (hook === "useState" || hook === "useReducer") stateCount++;

      const category = hookCategory(hook);
      if (category === "redux") integrations.add("redux");
      if (category === "query") integrations.add("query");
      if (category === "navigation") integrations.add("navigation");

      const rootName = rootIdentifier(node.expression);
      if (rootName && ctx.firebaseBindings.has(rootName)) integrations.add("firebase");

      if (EFFECT_HOOKS.has(hook)) {
        effectCount++;
        checkEffect(node, hook);
      }

      if (/^use(App)?Selector$/.test(hook) || /^use\w*Selector$/.test(hook)) {
        checkSelector(node);
      }
    }

    if (!hook) {
      const rootName = rootIdentifier(node.expression);
      if (rootName && ctx.firebaseBindings.has(rootName)) {
        firebaseCalls++;
        integrations.add("firebase");
        if (!firstFirebaseLine) firstFirebaseLine = lineOf(sf, node);
      }
    }

    if (
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "map" &&
      node.arguments[0] &&
      isFunctionExpressionLike(skipOuter(node.arguments[0]))
    ) {
      checkMapCallback(node);
    }
  }

  function checkEffect(node: ts.CallExpression, hook: string) {
    const callback = node.arguments[0];
    const target = callback ? skipOuter(callback) : undefined;

    if (target && isFunctionExpressionLike(target)) {
      if (target.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
        add(
          "async-effect-callback",
          node,
          `${hook} receives an async function, which returns a promise instead of a cleanup function.`,
        );
      }

      const hasBody = ts.isBlock(target.body) ? target.body.statements.length > 0 : true;

      if (node.arguments.length === 1 && hasBody) {
        add("effect-no-deps", node, `${hook} has no dependency array, so it runs after every render.`);
      }
    }

    const scan = scanEffectCallback(callback);

    if (scan.subscribes.length > 0 && !scan.hasCleanup) {
      const names = [...new Set(scan.subscribes)].join(", ");
      add(
        "effect-missing-cleanup",
        node,
        `${hook} starts ${names} but does not return a cleanup function.`,
      );
    }
  }

  function checkSelector(node: ts.CallExpression) {
    const selector = node.arguments[0] ? skipOuter(node.arguments[0]) : undefined;
    if (!selector || !isFunctionExpressionLike(selector)) return;

    const param = selector.parameters[0];
    const paramName = param && ts.isIdentifier(param.name) ? param.name.text : undefined;

    const returned = collectReturnedExpressions(selector).map((expression) =>
      skipOuter(expression),
    );

    for (const expression of returned) {
      if (paramName && ts.isIdentifier(expression) && expression.text === paramName) {
        add("whole-state-selector", node, "The selector returns the entire Redux state.");
        return;
      }

      if (ts.isObjectLiteralExpression(expression) || ts.isArrayLiteralExpression(expression)) {
        add("new-object-selector", node, "The selector returns a new object or array literal.");
        return;
      }

      if (
        ts.isCallExpression(expression) &&
        ts.isPropertyAccessExpression(expression.expression) &&
        ["map", "filter", "slice", "sort", "reduce", "flatMap"].includes(
          expression.expression.name.text,
        )
      ) {
        add(
          "new-object-selector",
          node,
          `The selector calls .${expression.expression.name.text}(), which creates a new value on every store update.`,
        );
        return;
      }
    }
  }

  function checkMapCallback(node: ts.CallExpression) {
    const access = node.expression as ts.PropertyAccessExpression;
    const callback = skipOuter(node.arguments[0]) as ts.ArrowFunction | ts.FunctionExpression;

    const receiver = access.expression.getText(sf);
    if (/Array\s*(\.from)?\s*\(/.test(receiver)) return;

    const indexParam = callback.parameters[1];
    const indexName =
      indexParam && ts.isIdentifier(indexParam.name) ? indexParam.name.text : undefined;

    for (const returned of collectReturnedExpressions(callback)) {
      for (const element of jsxRoots(returned)) {
        if (ts.isJsxFragment(element)) {
          add(
            "missing-key",
            element,
            "A <> fragment returned from .map() cannot take a key. Use <React.Fragment key={...}>.",
          );
          continue;
        }

        const opening = ts.isJsxElement(element) ? element.openingElement : element;
        const properties = opening.attributes.properties;

        const keyAttribute = properties.find(
          (property): property is ts.JsxAttribute =>
            ts.isJsxAttribute(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === "key",
        );

        if (!keyAttribute) {
          if (properties.some((property) => ts.isJsxSpreadAttribute(property))) continue;

          add(
            "missing-key",
            element,
            `The <${opening.tagName.getText(sf)}> returned from .map() has no key.`,
          );
          continue;
        }

        if (indexName && keyAttribute.initializer) {
          const keyText = keyAttribute.initializer.getText(sf);
          if (new RegExp(`\\b${indexName}\\b`).test(keyText)) {
            add(
              "index-as-key",
              keyAttribute,
              `The key is built from the array index (${indexName}).`,
            );
          }
        }
      }
    }
  }

  /* ---- Walk the component ---- */

  if (ts.isClassDeclaration(root)) {
    add("class-component", root, `${candidate.displayName} is a class component.`);

    for (const member of root.members) {
      visit(member, { fnDepth: -1, jsxDepth: 0 });
    }
  } else {
    const body = root.body;
    const state: VisitState = { fnDepth: 0, jsxDepth: 0 };

    for (const parameter of root.parameters) {
      if (parameter.initializer) visit(parameter.initializer, state);
    }

    if (body && ts.isBlock(body)) {
      for (const statement of body.statements) {
        const inner: VisitState =
          earlyReturn && !state.conditional
            ? { ...state, conditional: "code after an early return" }
            : state;

        visit(statement, inner);

        if (ts.isIfStatement(statement) && containsOwnReturn(statement)) earlyReturn = true;
      }
    } else if (body) {
      visit(body, state);
    }
  }

  /* ---- Props ---- */

  // Usage can only be judged when every prop is visible: not for classes (this.props),
  // not when the whole props object or a rest element is passed on, and not when part
  // of the type comes from another file.
  const canJudgeUnused =
    !ts.isClassDeclaration(root) &&
    !wholePropsUsed &&
    !propsInfo.hasRest &&
    propsInfo.complete &&
    (propsInfo.destructured.size > 0 || propsInfo.paramName !== undefined);

  const props: ComponentProp[] = [];

  for (const [name, member] of propsInfo.declared) {
    const refs = propRefs.get(name);
    const destructuredEntry = [...propsInfo.destructured.values()].find(
      (entry) => entry.prop === name,
    );

    props.push({
      name,
      type: member.type,
      optional: member.optional,
      hasDefault: destructuredEntry?.hasDefault ?? false,
      used:
        Boolean(refs && refs.total > 0) || !canJudgeUnused || propsInfo.nestedProps.has(name),
      passThrough: Boolean(refs && refs.total > 0 && refs.passThrough === refs.total),
    });
  }

  if (canJudgeUnused) {
    const unused = props.filter((prop) => !prop.used && prop.name !== "children");
    if (unused.length > 0) {
      add(
        "unused-prop",
        startLine,
        `${unused.map((prop) => prop.name).join(", ")} ${unused.length === 1 ? "is" : "are"} declared but never used.`,
      );
    }
  }

  const passThrough = props.filter((prop) => prop.passThrough);
  if (passThrough.length >= 3) {
    add(
      "prop-drilling",
      startLine,
      `${passThrough.map((prop) => prop.name).join(", ")} ${passThrough.length === 1 ? "is" : "are"} only passed down to children.`,
      passThrough.length >= 5 ? "medium" : "low",
    );
  }

  /* ---- Size and shape ---- */

  const lines = endLine - startLine + 1;

  if (lines > limits.maxLines) {
    add(
      "large-component",
      startLine,
      `${lines} lines, above the ${limits.maxLines}-line limit.`,
      lines > limits.maxLines * 2.7 ? "high" : lines > limits.maxLines * 1.7 ? "medium" : "low",
    );
  }

  if (props.length > limits.maxProps) {
    add(
      "too-many-props",
      startLine,
      `${props.length} props, above the limit of ${limits.maxProps}.`,
      props.length > limits.maxProps * 1.5 ? "medium" : "low",
    );
  }

  if (stateCount >= 5) {
    add(
      "too-many-state",
      startLine,
      `${stateCount} useState/useReducer calls in one component.`,
      stateCount >= 8 ? "medium" : "low",
    );
  }

  if (maxJsxDepth >= 8) {
    add(
      "deep-jsx-nesting",
      startLine,
      `JSX is nested ${maxJsxDepth} levels deep.`,
      maxJsxDepth >= 12 ? "medium" : "low",
    );
  }

  if (complexity >= 15) {
    add(
      "high-complexity",
      startLine,
      `Cyclomatic complexity is ${complexity}.`,
      complexity >= 40 ? "high" : complexity >= 25 ? "medium" : "low",
    );
  }

  if (firebaseCalls > 0) {
    add(
      "firebase-in-component",
      firstFirebaseLine || startLine,
      `${firebaseCalls} Firebase ${firebaseCalls === 1 ? "call is" : "calls are"} made directly in this component.`,
      firebaseCalls >= 3 ? "low" : "info",
    );
  }

  if (inlineStyles >= 4 && nativeTags > 0) {
    add(
      "inline-styles-native",
      startLine,
      `${inlineStyles} inline style objects are created on every render.`,
    );
  }

  /* ---- Platform ---- */

  let platform: ComponentPlatform;
  if (domTags > 0) platform = "web";
  else if (nativeTags > 0 || (ctx.nativeBindings.size > 0 && tags.size > 0)) platform = "native";
  else platform = "shared";

  /* ---- Snippet ---- */

  const source = fileLines.slice(startLine - 1, endLine);
  const capped = source.slice(0, MAX_SNIPPET_LINES);

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      a.line - b.line,
  );

  return {
    localName: candidate.localName,
    displayName: candidate.displayName,
    kind: candidate.kind,
    wrappers: candidate.wrappers,
    startLine,
    endLine,
    props,
    hooks,
    stateCount,
    effectCount,
    jsxElements,
    maxJsxDepth,
    complexity,
    inlineHandlers,
    tags,
    platform,
    integrations,
    findings,
    snippet: dedent(capped).join("\n"),
    snippetTruncated: source.length > capped.length,
  };
}

function containsOwnReturn(root: ts.Node): boolean {
  let found = false;

  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(root, visit);
  return found;
}

/* -------------------------------------------------------------------------- */
/*  Project-wide resolution                                                   */
/* -------------------------------------------------------------------------- */

interface PathAliases {
  baseUrl?: string;
  paths: Array<{ prefix: string; suffix: string; wildcard: boolean; targets: string[] }>;
}

function loadPathAliases(root: string): PathAliases {
  const aliases: PathAliases = { paths: [] };

  for (const name of ["tsconfig.json", "tsconfig.app.json", "jsconfig.json"]) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;

    try {
      const parsed = ts.readConfigFile(file, ts.sys.readFile);
      const options = parsed.config?.compilerOptions as
        | { baseUrl?: string; paths?: Record<string, string[]> }
        | undefined;

      if (!options) continue;

      if (options.baseUrl && aliases.baseUrl === undefined) {
        aliases.baseUrl = normalizePath(options.baseUrl).replace(/^\.\//, "").replace(/\/$/, "");
        if (aliases.baseUrl === ".") aliases.baseUrl = "";
      }

      for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
        const star = pattern.indexOf("*");
        aliases.paths.push({
          prefix: star === -1 ? pattern : pattern.slice(0, star),
          suffix: star === -1 ? "" : pattern.slice(star + 1),
          wildcard: star !== -1,
          targets: targets.map((target) => normalizePath(target)),
        });
      }
    } catch {
      // An unreadable tsconfig only reduces how many aliases can be resolved.
    }
  }

  return aliases;
}

class ProjectIndex {
  private readonly byPath = new Map<string, FileAnalysis>();
  private readonly aliases: PathAliases;
  private readonly specifierCache = new Map<string, string | null>();

  constructor(
    files: FileAnalysis[],
    aliases: PathAliases,
    private readonly idOf: (file: string, localName: string) => string | undefined,
  ) {
    for (const file of files) this.byPath.set(file.relPath, file);
    this.aliases = aliases;
  }

  private findFile(candidate: string): string | undefined {
    const clean = path.posix.normalize(candidate);
    const stripped = clean.replace(/\.(js|jsx|mjs|cjs)$/, "");
    const bases = stripped === clean ? [clean] : [clean, stripped];

    for (const base of bases) {
      if (this.byPath.has(base)) return base;

      for (const extension of RESOLVE_EXTENSIONS) {
        if (this.byPath.has(base + extension)) return base + extension;
      }

      for (const extension of RESOLVE_EXTENSIONS) {
        const index = `${base}/index${extension}`;
        if (this.byPath.has(index)) return index;
      }
    }

    return undefined;
  }

  resolveSpecifier(fromFile: string, specifier: string): string | undefined {
    const key = `${fromFile}\0${specifier}`;
    const cached = this.specifierCache.get(key);
    if (cached !== undefined) return cached ?? undefined;

    let result: string | undefined;

    if (specifier.startsWith(".")) {
      result = this.findFile(path.posix.join(path.posix.dirname(fromFile), specifier));
    } else {
      for (const entry of this.aliases.paths) {
        if (!specifier.startsWith(entry.prefix)) continue;
        if (entry.suffix && !specifier.endsWith(entry.suffix)) continue;
        if (!entry.wildcard && specifier !== entry.prefix) continue;

        const matched = entry.wildcard
          ? specifier.slice(entry.prefix.length, specifier.length - entry.suffix.length)
          : "";

        for (const target of entry.targets) {
          const replaced = target.replace("*", matched).replace(/^\.\//, "");
          const base = this.aliases.baseUrl ? path.posix.join(this.aliases.baseUrl, replaced) : replaced;
          result = this.findFile(base);
          if (result) break;
        }

        if (result) break;
      }

      if (!result && this.aliases.baseUrl !== undefined) {
        result = this.findFile(path.posix.join(this.aliases.baseUrl, specifier));
      }

      if (!result && /^(@|~|#)\//.test(specifier)) {
        const rest = specifier.slice(2);
        result = this.findFile(path.posix.join("src", rest)) ?? this.findFile(rest);
      }

      if (!result && specifier.startsWith("src/")) result = this.findFile(specifier);
    }

    this.specifierCache.set(key, result ?? null);
    return result;
  }

  resolveExport(file: string, exportName: string, depth = 0): string | undefined {
    const analysis = this.byPath.get(file);
    if (!analysis || depth > 8) return undefined;

    const local = analysis.exportMap.get(exportName);

    if (local) {
      const target = analysis.aliases.get(local) ?? local;
      const id = this.idOf(file, target);
      if (id) return id;

      const binding = analysis.imports.get(target);
      if (binding) return this.resolveBinding(file, binding, depth + 1);
    }

    for (const reExport of analysis.reExports) {
      if (reExport.exportName !== exportName) continue;
      const source = this.resolveSpecifier(file, reExport.module);
      if (!source) continue;
      const id = this.resolveExport(source, reExport.importedName, depth + 1);
      if (id) return id;
    }

    if (exportName !== "default") {
      for (const reExport of analysis.reExports) {
        if (reExport.exportName !== "*") continue;
        const source = this.resolveSpecifier(file, reExport.module);
        if (!source) continue;
        const id = this.resolveExport(source, exportName, depth + 1);
        if (id) return id;
      }
    }

    return undefined;
  }

  resolveBinding(file: string, binding: ImportBinding, depth = 0): string | undefined {
    const source = this.resolveSpecifier(file, binding.module);
    if (!source || binding.imported === "*") return undefined;
    return this.resolveExport(source, binding.imported, depth);
  }

  /** Resolves a JSX tag such as `Card`, `Stack.Screen` or `ui.Card` used inside `file`. */
  resolveTag(file: string, fullTag: string): string | undefined {
    const analysis = this.byPath.get(file);
    if (!analysis) return undefined;

    const [rootName, member] = fullTag.split(".");

    const localTarget = analysis.aliases.get(rootName) ?? rootName;
    const localId = this.idOf(file, localTarget);
    if (localId) return localId;

    const binding = analysis.imports.get(rootName);
    if (!binding) return undefined;

    if (binding.imported === "*") {
      if (!member) return undefined;
      const source = this.resolveSpecifier(file, binding.module);
      return source ? this.resolveExport(source, member) : undefined;
    }

    return this.resolveBinding(file, binding);
  }

  resolveDynamicImport(file: string, specifier: string): string | undefined {
    const source = this.resolveSpecifier(file, specifier);
    return source ? this.resolveExport(source, "default") : undefined;
  }
}

/* -------------------------------------------------------------------------- */
/*  Scoring                                                                   */
/* -------------------------------------------------------------------------- */

function riskScoreFor(findings: ComponentFinding[], lines: number, complexity: number): number {
  const weighted = findings.reduce((sum, finding) => sum + SEVERITY_WEIGHT[finding.severity], 0);
  const raw = weighted + Math.min(10, lines / 60) + Math.min(10, complexity / 5);
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function worstSeverity(findings: ComponentFinding[]): ComponentSeverity {
  if (findings.length === 0) return "healthy";
  for (const severity of SEVERITY_ORDER) {
    if (findings.some((finding) => finding.severity === severity)) return severity;
  }
  return "healthy";
}

/** Files that frameworks load by convention, so nothing imports them. */
function isConventionEntry(relPath: string): boolean {
  const base = path.posix.basename(relPath).replace(/\.[^.]+$/, "");

  if (["index", "main", "App", "_app", "_document", "page", "layout", "loading", "error", "not-found", "template", "route"].includes(base)) {
    return true;
  }

  return /(^|\/)(pages|app|routes)\//.test(relPath);
}

/* -------------------------------------------------------------------------- */
/*  Main analysis                                                             */
/* -------------------------------------------------------------------------- */

export async function analyzeReactComponents(
  projectPath: string,
  filePath?: string,
  options: {
    maxLines?: number;
    maxProps?: number;
    includeTests?: boolean;
  } = {},
): Promise<ReactComponentReport> {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxProps = options.maxProps ?? DEFAULT_MAX_PROPS;
  const includeTests = options.includeTests ?? false;

  if (
    filePath !== undefined &&
    (path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes(".."))
  ) {
    throw new Error("filePath must be relative to projectPath.");
  }

  if (!Number.isInteger(maxLines) || maxLines < 30 || maxLines > 2000) {
    throw new Error("maxLines must be an integer between 30 and 2000.");
  }

  if (!Number.isInteger(maxProps) || maxProps < 1 || maxProps > 50) {
    throw new Error("maxProps must be an integer between 1 and 50.");
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

  const relative = (absolute: string) => normalizePath(path.relative(root, absolute));

  const candidates = discovered.files.filter(
    (file) => includeTests || !TEST_FILE_PATTERN.test(relative(file)),
  );

  if (candidates.length === 0) {
    throw new Error(`No JavaScript or TypeScript source files were found in ${root}.`);
  }

  /* ---- Parse and analyze each file ---- */

  const limits: Limits = { maxLines, maxProps };
  const analyses: FileAnalysis[] = [];
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

    try {
      const analysis = analyzeSourceFile(absolute, relative(absolute), text, limits);
      totalLines += analysis.lineCount;
      analyses.push(analysis);
    } catch (error) {
      warn(
        `Could not analyze ${relative(absolute)}: ${
          error instanceof Error ? error.message : "unknown error"
        }.`,
      );
    }
  }

  /* ---- Resolve relationships ---- */

  const idLookup = new Map<string, string>();
  for (const analysis of analyses) {
    for (const component of analysis.components) {
      idLookup.set(
        `${analysis.relPath}\0${component.localName}`,
        `${analysis.relPath}#${component.displayName}`,
      );
    }
  }

  const index = new ProjectIndex(analyses, loadPathAliases(root), (file, localName) =>
    idLookup.get(`${file}\0${localName}`),
  );

  interface Entry {
    id: string;
    file: FileAnalysis;
    raw: RawComponent;
    renders: Set<string>;
    external: Set<string>;
    renderedBy: Set<string>;
    referenced: boolean;
  }

  const entries = new Map<string, Entry>();

  for (const file of analyses) {
    for (const raw of file.components) {
      const id = `${file.relPath}#${raw.displayName}`;

      // Two anonymous or same-named components in one file would collide.
      let uniqueId = id;
      let suffix = 2;
      while (entries.has(uniqueId)) uniqueId = `${id}~${suffix++}`;

      entries.set(uniqueId, {
        id: uniqueId,
        file,
        raw,
        renders: new Set(),
        external: new Set(),
        renderedBy: new Set(),
        referenced: false,
      });
    }
  }

  for (const entry of entries.values()) {
    for (const [tag] of entry.raw.tags) {
      const target = index.resolveTag(entry.file.relPath, tag);

      if (target && entries.has(target)) {
        entry.renders.add(target);
        entries.get(target)!.renderedBy.add(entry.id);
      } else {
        entry.external.add(tag);
      }
    }
  }

  // Components used as values (`component={Home}`) or imported dynamically.
  for (const file of analyses) {
    for (const [name, count] of file.refCounts) {
      if (count === 0) continue;

      const binding = file.imports.get(name);
      if (binding) {
        const target = index.resolveBinding(file.relPath, binding);
        if (target && entries.has(target)) entries.get(target)!.referenced = true;
        continue;
      }

      const localId = idLookup.get(`${file.relPath}\0${file.aliases.get(name) ?? name}`);
      if (localId && entries.has(localId)) entries.get(localId)!.referenced = true;
    }

    for (const specifier of file.dynamicImports) {
      const target = index.resolveDynamicImport(file.relPath, specifier);
      if (target && entries.has(target)) entries.get(target)!.referenced = true;
    }

    // Namespace imports and re-exports can reach components in ways not tracked above.
    for (const reExport of file.reExports) {
      const source = index.resolveSpecifier(file.relPath, reExport.module);
      if (!source) continue;
      const target =
        reExport.importedName === "*" ? undefined : index.resolveExport(source, reExport.importedName);
      if (target && entries.has(target)) entries.get(target)!.referenced = true;
    }
  }

  /* ---- Flag components nothing uses ---- */

  for (const entry of entries.values()) {
    const { raw } = entry;
    const exported = [...entry.file.exportMap.values()].some(
      (local) => (entry.file.aliases.get(local) ?? local) === raw.localName,
    );

    const locallyUsed =
      (entry.file.refCounts.get(raw.localName) ?? 0) > 0 ||
      [...entry.file.aliases.entries()].some(
        ([alias, target]) => target === raw.localName && (entry.file.refCounts.get(alias) ?? 0) > 0,
      );

    if (entry.renderedBy.size > 0 || entry.referenced) continue;
    if (isConventionEntry(entry.file.relPath)) continue;

    if (!exported && !locallyUsed) {
      raw.findings.push({
        rule: "unused-component",
        severity: "medium",
        title: RULES["unused-component"].title,
        message: `${raw.displayName} is not exported and nothing in its file uses it.`,
        line: raw.startLine,
        suggestion: RULES["unused-component"].advice,
      });
    } else if (exported && !locallyUsed) {
      raw.findings.push({
        rule: "unused-component",
        severity: "low",
        title: RULES["unused-component"].title,
        message: `No file in the project renders or references ${raw.displayName}. It may be an entry point or a route registered elsewhere.`,
        line: raw.startLine,
        suggestion: RULES["unused-component"].advice,
      });
    }
  }

  /* ---- Build the report ---- */

  const refOf = (id: string): ComponentRef => {
    const entry = entries.get(id)!;
    return { id, name: entry.raw.displayName, filePath: entry.file.relPath };
  };

  const hookTotals = new Map<string, { count: number; components: number; category: HookCategory }>();
  const hookUsedBy = new Map<string, number>();

  const all: ComponentInfo[] = [];

  for (const entry of entries.values()) {
    const { raw, file } = entry;

    const findings = [...raw.findings].sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
        a.line - b.line,
    );

    const hooksList: HookUse[] = [...raw.hooks.entries()]
      .map(([name, count]) => ({ name, count, category: hookCategory(name) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    for (const hook of hooksList) {
      const total = hookTotals.get(hook.name) ?? { count: 0, components: 0, category: hook.category };
      total.count += hook.count;
      total.components += 1;
      hookTotals.set(hook.name, total);
      hookUsedBy.set(hook.name, (hookUsedBy.get(hook.name) ?? 0) + 1);
    }

    const exportedAs = [...file.exportMap.entries()].filter(
      ([, local]) => (file.aliases.get(local) ?? local) === raw.localName,
    );

    const exportKind: ExportKind = exportedAs.some(([name]) => name === "default")
      ? "default"
      : exportedAs.length > 0
        ? "named"
        : "none";

    const lines = raw.endLine - raw.startLine + 1;

    all.push({
      id: entry.id,
      name: raw.displayName,
      filePath: file.relPath,
      startLine: raw.startLine,
      endLine: raw.endLine,
      lines,
      kind: raw.kind,
      wrappers: raw.wrappers,
      exportKind,
      platform: raw.platform,
      severity: worstSeverity(findings),
      riskScore: riskScoreFor(findings, lines, raw.complexity),
      props: raw.props,
      propCount: raw.props.length,
      hooks: hooksList,
      hookCount: hooksList.reduce((sum, hook) => sum + hook.count, 0),
      stateCount: raw.stateCount,
      effectCount: raw.effectCount,
      jsxElements: raw.jsxElements,
      maxJsxDepth: raw.maxJsxDepth,
      complexity: raw.complexity,
      inlineHandlers: raw.inlineHandlers,
      integrations: [...raw.integrations].sort(),
      renders: [...entry.renders].map(refOf).sort((a, b) => a.name.localeCompare(b.name)),
      renderedBy: [...entry.renderedBy].map(refOf).sort((a, b) => a.name.localeCompare(b.name)),
      externalElements: [...entry.external].sort().slice(0, MAX_EXTERNAL_ELEMENTS),
      findings,
      snippet: raw.snippet,
      snippetTruncated: raw.snippetTruncated,
    });
  }

  all.sort(
    (a, b) =>
      b.riskScore - a.riskScore ||
      b.lines - a.lines ||
      a.filePath.localeCompare(b.filePath) ||
      a.name.localeCompare(b.name),
  );

  const projectComponentCount = all.length;
  const focusFile = filePath ? normalizePath(filePath) : undefined;

  if (focusFile && !analyses.some((file) => file.relPath === focusFile)) {
    warn(`${focusFile} was not found among the analyzed files, so no components can come from it.`);
  }

  const scoped = focusFile ? all.filter((component) => component.filePath === focusFile) : all;
  const reported = scoped.slice(0, MAX_COMPONENTS);

  if (scoped.length > reported.length) {
    warn(
      `Showing the ${MAX_COMPONENTS} highest-risk components of ${scoped.length}. Use a focus file or a smaller project path to see the rest.`,
    );
  }

  /* ---- Totals ---- */

  const summary: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const kindCounts: Record<ComponentKind, number> = { function: 0, arrow: 0, class: 0 };
  const platformCounts: Record<ComponentPlatform, number> = { web: 0, native: 0, shared: 0 };
  const integrationCounts: Record<Integration, number> = {
    redux: 0,
    query: 0,
    firebase: 0,
    navigation: 0,
  };
  const ruleMap = new Map<RuleId, RuleCount>();

  let totalFindings = 0;
  let totalHooks = 0;
  let totalComponentLines = 0;
  let healthy = 0;

  for (const component of reported) {
    kindCounts[component.kind]++;
    platformCounts[component.platform]++;
    totalHooks += component.hookCount;
    totalComponentLines += component.lines;
    if (component.severity === "healthy") healthy++;

    for (const integration of component.integrations) integrationCounts[integration]++;

    for (const finding of component.findings) {
      summary[finding.severity]++;
      totalFindings++;

      const entry = ruleMap.get(finding.rule) ?? {
        rule: finding.rule,
        title: finding.title,
        severity: RULES[finding.rule].severity,
        count: 0,
      };
      entry.count++;
      ruleMap.set(finding.rule, entry);
    }
  }

  const ruleCounts = [...ruleMap.values()].sort(
    (a, b) =>
      b.count - a.count ||
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );

  const hookUsage: HookUsage[] = [...hookTotals.entries()]
    .map(([name, total]) => ({
      name,
      category: total.category,
      count: total.count,
      componentCount: total.components,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, MAX_HOOK_USAGE);

  const customHooks: CustomHookInfo[] = analyses
    .flatMap((file) =>
      file.customHooks.map((hook) => ({
        name: hook.name,
        filePath: file.relPath,
        line: hook.line,
        usedByComponents: hookUsedBy.get(hook.name) ?? 0,
      })),
    )
    .sort(
      (a, b) =>
        b.usedByComponents - a.usedByComponents ||
        a.name.localeCompare(b.name) ||
        a.filePath.localeCompare(b.filePath),
    )
    .slice(0, MAX_CUSTOM_HOOKS);

  return {
    success: true,
    tool: "analyze_react_components",
    projectPath: root,
    filePath: focusFile,
    includeTests,
    maxLines,
    maxProps,
    filesScanned: analyses.length,
    filesWithComponents: analyses.filter((file) => file.components.length > 0).length,
    totalLines,
    projectComponentCount,
    totalComponents: reported.length,
    componentsWithIssues: reported.length - healthy,
    healthyComponents: healthy,
    averageLines: reported.length === 0 ? 0 : Math.round(totalComponentLines / reported.length),
    totalHooks,
    totalFindings,
    summary,
    kindCounts,
    platformCounts,
    integrationCounts,
    ruleCounts,
    components: reported,
    hookUsage,
    customHooks,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/*  MCP registration                                                          */
/* -------------------------------------------------------------------------- */

export function registerAnalyzeReactComponentsTool(server: McpServer) {
  server.registerTool(
    "analyze_react_components",
    {
      description:
        "Analyze the React and React Native components in a project. Finds every function, arrow, class, memo and forwardRef component with the TypeScript parser, then reports its props, hooks, state, effects, JSX size, complexity, which components it renders and which render it, plus findings such as conditional hooks, components defined inside components, effects that leak subscriptions (including Firebase listeners), missing list keys, unstable Redux selectors, oversized components, unused props, and components nothing uses. Each finding includes a suggested fix.",
      inputSchema: z.object({
        projectPath: z.string().describe("Absolute path to the project directory"),
        filePath: z
          .string()
          .optional()
          .describe(
            "Optional file, relative to projectPath. When set, only components defined in this file are reported.",
          ),
        maxLines: z
          .number()
          .int()
          .min(30)
          .max(2000)
          .optional()
          .describe("Lines above which a component is reported as large. Default 150."),
        maxProps: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Props above which a component is reported as having too many. Default 7."),
        includeTests: z
          .boolean()
          .optional()
          .describe("Include test, mock and story files. Default false."),
      }),
    },
    async ({ projectPath, filePath, maxLines, maxProps, includeTests }) => {
      try {
        const report = await analyzeReactComponents(projectPath, filePath, {
          maxLines,
          maxProps,
          includeTests,
        });

        return {
          content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
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
                  tool: "analyze_react_components",
                  error:
                    error instanceof Error
                      ? error.message
                      : "Failed to analyze React components.",
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
