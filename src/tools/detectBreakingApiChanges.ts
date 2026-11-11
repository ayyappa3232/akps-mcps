import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import ts from "typescript";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveProjectPath } from "../utils/projectResolver.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

type ChangeSeverity = "critical" | "high" | "medium" | "low" | "info";
type Confidence = "high" | "medium" | "low";

type ApiSurface = "export" | "route";
type AnalysisScope = "all" | "exports" | "routes";

/**
 * entry  - reachable from a package entry point (the real public API).
 * module - exported from a file that is not an entry point (internal API).
 * route  - an HTTP endpoint.
 */
type Exposure = "entry" | "module" | "route";

type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "namespace"
  | "reexport";

type ChangeCategory =
  | "removed"
  | "renamed"
  | "moved"
  | "signature"
  | "type"
  | "members"
  | "enum"
  | "route"
  | "compatible";

type SemverBump = "major" | "minor" | "patch";

type IssueKind =
  | "removed"
  | "renamed"
  | "moved"
  | "kind-changed"
  | "param-removed"
  | "param-added"
  | "param-optional-to-required"
  | "param-type-changed"
  | "return-type-changed"
  | "async-changed"
  | "type-params-changed"
  | "member-removed"
  | "member-added"
  | "member-optional-to-required"
  | "member-type-changed"
  | "member-readonly-added"
  | "member-visibility-reduced"
  | "member-abstract-added"
  | "enum-member-removed"
  | "enum-value-changed"
  | "type-changed"
  | "heritage-changed"
  | "route-removed"
  | "route-method-changed"
  | "request-field-required"
  | "response-field-removed"
  | "auth-added"
  | "relaxed"
  | "added";

type MigrationStrategy =
  | "restore-export"
  | "deprecated-alias"
  | "re-export"
  | "optional-parameter"
  | "keep-parameter"
  | "widen-type"
  | "keep-member"
  | "keep-enum-member"
  | "keep-route"
  | "optional-field"
  | "keep-response-field"
  | "bump-major"
  | "no-action";

interface ChangeIssue {
  kind: IssueKind;
  severity: ChangeSeverity;
  /** False for compatible changes (new exports, optional parameters). */
  breaking: boolean;
  confidence: Confidence;
  /** Where inside the declaration the change sits, e.g. `parameter 2 "options"`. */
  path: string;
  message: string;
  before?: string;
  after?: string;
}

interface ChangeSuggestion {
  strategy: MigrationStrategy;
  confidence: Confidence;
  title: string;
  summary: string;
  steps: string[];
  codeExample?: string;
  caveats: string[];
}

interface ConsumerInfo {
  count: number;
  files: string[];
  hidden: number;
}

interface ApiChange {
  id: string;
  surface: ApiSurface;
  category: ChangeCategory;
  severity: ChangeSeverity;
  breaking: boolean;
  exposure: Exposure;
  /** function, class, interface, type, enum, constant, route ... */
  symbolKind: string;
  name: string;
  /** File the change is attributed to (head file, or baseline file when removed). */
  filePath: string;
  baselineFilePath?: string;
  headFilePath?: string;
  baselineLine?: number;
  headLine?: number;
  title: string;
  description: string;
  issues: ChangeIssue[];
  /** Declaration in the baseline, rendered as readable text. */
  before?: string;
  /** Declaration now, rendered as readable text. */
  after?: string;
  deprecatedInBaseline: boolean;
  /** Files that import this symbol. */
  consumers: ConsumerInfo;
  /** Removed symbol that files in the current version still import. */
  stillReferenced: boolean;
  suggestion: ChangeSuggestion;
}

interface ApiHotspot {
  filePath: string;
  breakingChanges: number;
  totalChanges: number;
}

interface ComparisonSide {
  kind: "git-ref" | "working-tree" | "path";
  label: string;
  commit?: string;
}

interface BreakingApiReport {
  success: boolean;
  tool: "detect_breaking_api_changes";
  projectPath: string;
  filePath?: string;
  baseline: ComparisonSide;
  head: ComparisonSide;
  scope: AnalysisScope;
  includeNonBreaking: boolean;
  includeTests: boolean;
  baselineFiles: number;
  headFiles: number;
  baselineExports: number;
  headExports: number;
  baselineRoutes: number;
  headRoutes: number;
  entryFiles: string[];
  publicEntryDetected: boolean;
  recommendedBump: SemverBump;
  totalChanges: number;
  /** Count across the whole comparison, before any filePath filter. */
  projectChangeCount: number;
  breakingChanges: number;
  compatibleChanges: number;
  exportChanges: number;
  routeChanges: number;
  filesAffected: number;
  consumersAffected: number;
  summary: Record<ChangeSeverity, number>;
  changes: ApiChange[];
  hotspots: ApiHotspot[];
  warnings: string[];
}

/* ---- Extracted API model ---- */

interface TypeParamModel {
  name: string;
  constraint?: string;
  hasDefault: boolean;
}

interface TypeModel {
  text: string;
  norm: string;
  /** Present when the type is an object type literal. */
  members?: Map<string, MemberModel>;
  /** Normalized members when the type is a union. */
  union?: string[];
}

interface ParamModel {
  name: string;
  type?: TypeModel;
  optional: boolean;
  rest: boolean;
  defaulted: boolean;
}

interface SignatureModel {
  typeParams: TypeParamModel[];
  params: ParamModel[];
  returns?: TypeModel;
  async: boolean;
}

type MemberKind =
  | "property"
  | "method"
  | "constructor"
  | "index"
  | "call"
  | "construct";

type Visibility = "public" | "protected" | "private";

interface MemberModel {
  key: string;
  name: string;
  kind: MemberKind;
  isStatic: boolean;
  optional: boolean;
  readonly: boolean;
  abstract: boolean;
  visibility: Visibility;
  type?: TypeModel;
  signatures: SignatureModel[];
}

interface EnumMemberModel {
  name: string;
  value?: string;
}

interface SymbolModel {
  key: string;
  name: string;
  filePath: string;
  line: number;
  kind: SymbolKind;
  deprecated: boolean;
  signatures: SignatureModel[];
  type?: TypeModel;
  typeParams: TypeParamModel[];
  heritage: { extends: string[]; implements: string[] };
  members: Map<string, MemberModel>;
  enumMembers: EnumMemberModel[];
  constEnum?: boolean;
  abstract?: boolean;
  declKind?: "const" | "let" | "var";
  reexport?: { from: string; imported: string; star: boolean };
  rendered: string;
  shape: string;
}

interface RequestField {
  source: "body" | "query";
  name: string;
  defaulted: boolean;
  validated: boolean;
}

interface RouteModel {
  key: string;
  method: string;
  path: string;
  normPath: string;
  filePath: string;
  line: number;
  middleware: string[];
  requestFields: Map<string, RequestField>;
  responseFields: Set<string>;
  handlerInspected: boolean;
  rendered: string;
}

interface ImportRef {
  spec: string;
  names: string[];
}

interface ReexportRef {
  spec: string;
  star: boolean;
  names: Array<{ imported: string; exported: string }>;
}

interface FileApi {
  rel: string;
  exports: SymbolModel[];
  imports: ImportRef[];
  reexports: ReexportRef[];
  routes: RouteModel[];
  hasMountedRouters: boolean;
}

interface SourceFile {
  rel: string;
  text: string;
}

interface SourceSet {
  side: ComparisonSide;
  files: SourceFile[];
  packageJson?: string;
  truncated: boolean;
}

interface Snapshot {
  files: Map<string, FileApi>;
  symbols: Map<string, SymbolModel>;
  routes: Map<string, RouteModel>;
  entryFiles: string[];
  publicKeys: Set<string>;
  importIndex: Map<string, Set<string>>;
  unannotatedReturns: number;
  hasMountedRouters: boolean;
}

interface Candidate {
  surface: ApiSurface;
  category: ChangeCategory;
  base?: SymbolModel;
  head?: SymbolModel;
  baseRoute?: RouteModel;
  headRoute?: RouteModel;
  issues: ChangeIssue[];
  fileRemoved?: boolean;
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

const RESOLVE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

const SEVERITY_ORDER: ChangeSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
];

const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_CHANGES = 400;
const MAX_CONSUMERS = 8;
const MAX_HOTSPOTS = 15;
const MAX_WARNINGS = 25;
const MAX_ISSUES_PER_CHANGE = 40;
const MAX_REEXPORT_DEPTH = 6;

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 512 * 1024 * 1024;
const REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.\-/@^~{}:]*$/;

const KIND_LABEL: Record<SymbolKind, string> = {
  function: "function",
  class: "class",
  interface: "interface",
  type: "type alias",
  enum: "enum",
  variable: "constant",
  namespace: "namespace",
  reexport: "re-export",
};

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Spacing, quote style and separator differences must not count as changes. */
function normType(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}()[\]<>,;:|&=?])\s*/g, "$1")
    .replace(/'([^'\\]*)'/g, '"$1"')
    .replace(/;/g, ",")
    .replace(/,(?=[}\]])/g, "")
    .trim();
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

function isIgnoredPath(rel: string): boolean {
  const segments = rel.split("/");
  return segments.some(
    (segment) => IGNORED_DIRS.has(segment) || segment.startsWith("."),
  );
}

function isSourcePath(rel: string): boolean {
  return (
    SOURCE_EXTENSIONS.has(path.posix.extname(rel)) &&
    !/\.min\.[cm]?js$/.test(rel)
  );
}

function severityRank(severity: ChangeSeverity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

function quoteList(values: string[], limit = 4): string {
  const shown = values.slice(0, limit).map((value) => `\`${value}\``);
  const extra = values.length - shown.length;
  return extra > 0 ? `${shown.join(", ")} and ${extra} more` : shown.join(", ");
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

/* -------------------------------------------------------------------------- */
/*  Reading a version of the project                                          */
/* -------------------------------------------------------------------------- */

function discoverDiskFiles(root: string): { files: string[]; truncated: boolean } {
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

      if (!entry.isFile() || !isSourcePath(entry.name)) continue;

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

function loadDiskSources(
  root: string,
  side: ComparisonSide,
  includeTests: boolean,
  warn: (message: string) => void,
): SourceSet {
  const discovered = discoverDiskFiles(root);
  const files: SourceFile[] = [];

  for (const absolute of discovered.files) {
    const rel = normalizePath(path.relative(root, absolute));

    if (!includeTests && TEST_FILE_PATTERN.test(rel)) continue;

    try {
      if (fs.statSync(absolute).size > MAX_FILE_BYTES) {
        warn(`Skipped ${rel} (${side.label}) because it is larger than 1 MB.`);
        continue;
      }
      files.push({ rel, text: fs.readFileSync(absolute, "utf8") });
    } catch {
      warn(`Could not read ${rel} (${side.label}).`);
    }
  }

  let packageJson: string | undefined;
  try {
    packageJson = fs.readFileSync(path.join(root, "package.json"), "utf8");
  } catch {
    packageJson = undefined;
  }

  return { side, files, packageJson, truncated: discovered.truncated };
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        maxBuffer: GIT_MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
        encoding: "utf8",
      },
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

/** Reads many blobs through a single `git cat-file --batch` process. */
function readGitBlobs(
  cwd: string,
  shas: string[],
): Promise<Array<string | undefined>> {
  return new Promise((resolve, reject) => {
    if (shas.length === 0) {
      resolve([]);
      return;
    }

    const child = spawn("git", ["cat-file", "--batch"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Reading files from git timed out."));
    }, GIT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (code !== 0) {
        reject(new Error(stderr.trim() || "git cat-file failed."));
        return;
      }

      const output = Buffer.concat(chunks);
      const results: Array<string | undefined> = [];
      let position = 0;

      for (let index = 0; index < shas.length; index++) {
        const newline = output.indexOf(0x0a, position);

        if (newline === -1) {
          results.push(undefined);
          continue;
        }

        const header = output.toString("utf8", position, newline).split(" ");
        position = newline + 1;

        if (header[1] !== "blob") {
          results.push(undefined);
          continue;
        }

        const size = Number(header[2]);
        results.push(output.toString("utf8", position, position + size));
        position += size + 1;
      }

      resolve(results);
    });

    child.stdin.on("error", () => {
      /* git exited early; the close handler reports why */
    });
    child.stdin.end(`${shas.join("\n")}\n`);
  });
}

async function loadGitSources(
  root: string,
  ref: string,
  includeTests: boolean,
  warn: (message: string) => void,
): Promise<SourceSet> {
  let commit: string;

  try {
    commit = (
      await runGit(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
    ).trim();
  } catch {
    commit = "";
  }

  if (!commit) {
    throw new Error(
      `Git could not find "${ref}" in this repository. Use a branch, tag or commit that exists.`,
    );
  }

  // Run from the project folder so a project inside a larger repository
  // only lists its own files, with paths relative to the project.
  const listing = await runGit(root, ["ls-tree", "-r", "-l", "-z", commit]);

  const wanted: Array<{ rel: string; sha: string }> = [];
  let packageSha: string | undefined;
  let truncated = false;

  for (const record of listing.split("\0")) {
    if (!record) continue;

    const tab = record.indexOf("\t");
    if (tab === -1) continue;

    const [, type, sha, sizeText] = record.slice(0, tab).split(/\s+/);
    const rel = normalizePath(record.slice(tab + 1));

    if (type !== "blob") continue;

    if (rel === "package.json") {
      packageSha = sha;
      continue;
    }

    if (!isSourcePath(rel) || isIgnoredPath(rel)) continue;
    if (!includeTests && TEST_FILE_PATTERN.test(rel)) continue;

    if (Number(sizeText) > MAX_FILE_BYTES) {
      warn(`Skipped ${rel} (${ref}) because it is larger than 1 MB.`);
      continue;
    }

    if (wanted.length >= MAX_FILES) {
      truncated = true;
      continue;
    }

    wanted.push({ rel, sha });
  }

  wanted.sort((a, b) => a.rel.localeCompare(b.rel));

  const blobs = await readGitBlobs(root, [
    ...wanted.map((item) => item.sha),
    ...(packageSha ? [packageSha] : []),
  ]);

  const files: SourceFile[] = [];
  wanted.forEach((item, index) => {
    const text = blobs[index];
    if (text !== undefined) files.push({ rel: item.rel, text });
  });

  return {
    side: {
      kind: "git-ref",
      label: ref,
      commit: commit.slice(0, 10),
    },
    files,
    packageJson: packageSha ? blobs[wanted.length] : undefined,
    truncated,
  };
}

/* -------------------------------------------------------------------------- */
/*  Extracting declarations                                                   */
/* -------------------------------------------------------------------------- */

function modifiersOf(node: ts.Node): readonly ts.Modifier[] {
  return ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return modifiersOf(node).some((modifier) => modifier.kind === kind);
}

function isDeprecated(node: ts.Node): boolean {
  try {
    return ts
      .getJSDocTags(node)
      .some((tag) => tag.tagName.text === "deprecated");
  } catch {
    return false;
  }
}

function propertyNameText(
  name: ts.PropertyName | ts.BindingName,
  sf: ts.SourceFile,
): string | undefined {
  if (ts.isPrivateIdentifier(name)) return undefined;
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  return collapse(name.getText(sf));
}

function describeType(
  node: ts.TypeNode | undefined,
  sf: ts.SourceFile,
): TypeModel | undefined {
  if (!node) return undefined;

  let inner: ts.TypeNode = node;
  while (ts.isParenthesizedTypeNode(inner)) inner = inner.type;

  const text = collapse(node.getText(sf));
  const model: TypeModel = { text, norm: normType(text) };

  if (ts.isTypeLiteralNode(inner)) {
    model.members = membersFromElements(inner.members, sf);
  } else if (ts.isUnionTypeNode(inner)) {
    model.union = inner.types.map((member) => normType(member.getText(sf)));
  }

  return model;
}

function typeParamsFrom(
  list: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
  sf: ts.SourceFile,
): TypeParamModel[] {
  return (list ?? []).map((param) => ({
    name: param.name.text,
    constraint: param.constraint
      ? collapse(param.constraint.getText(sf))
      : undefined,
    hasDefault: Boolean(param.default),
  }));
}

function paramFrom(param: ts.ParameterDeclaration, sf: ts.SourceFile): ParamModel {
  return {
    name: ts.isIdentifier(param.name)
      ? param.name.text
      : collapse(param.name.getText(sf)),
    type: describeType(param.type, sf),
    optional: Boolean(param.questionToken),
    rest: Boolean(param.dotDotDotToken),
    defaulted: Boolean(param.initializer),
  };
}

function signatureFrom(
  node: ts.SignatureDeclaration,
  sf: ts.SourceFile,
): SignatureModel {
  return {
    typeParams: typeParamsFrom(node.typeParameters, sf),
    params: node.parameters
      .filter(
        (param) => !(ts.isIdentifier(param.name) && param.name.text === "this"),
      )
      .map((param) => paramFrom(param, sf)),
    returns: describeType(node.type, sf),
    async: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
  };
}

function newMember(
  name: string,
  kind: MemberKind,
  overrides: Partial<MemberModel> = {},
): MemberModel {
  return {
    key: name,
    name,
    kind,
    isStatic: false,
    optional: false,
    readonly: false,
    abstract: false,
    visibility: "public",
    signatures: [],
    ...overrides,
  };
}

function addMethodSignature(
  members: Map<string, MemberModel>,
  member: MemberModel,
  signature: SignatureModel,
  isOverload: boolean,
  overloaded: Set<string>,
) {
  const existing = members.get(member.key);

  if (!existing) {
    member.signatures.push(signature);
    members.set(member.key, member);
    if (isOverload) overloaded.add(member.key);
    return;
  }

  if (isOverload) {
    existing.signatures.push(signature);
    overloaded.add(member.key);
  } else if (!overloaded.has(member.key)) {
    existing.signatures.push(signature);
  }
}

function membersFromElements(
  elements: ts.NodeArray<ts.TypeElement>,
  sf: ts.SourceFile,
): Map<string, MemberModel> {
  const members = new Map<string, MemberModel>();
  const overloaded = new Set<string>();

  for (const element of elements) {
    if (ts.isPropertySignature(element)) {
      const name = propertyNameText(element.name, sf);
      if (!name) continue;

      members.set(
        name,
        newMember(name, "property", {
          optional: Boolean(element.questionToken),
          readonly: hasModifier(element, ts.SyntaxKind.ReadonlyKeyword),
          type: describeType(element.type, sf),
        }),
      );
    } else if (ts.isMethodSignature(element)) {
      const name = propertyNameText(element.name, sf);
      if (!name) continue;

      addMethodSignature(
        members,
        newMember(name, "method", { optional: Boolean(element.questionToken) }),
        signatureFrom(element, sf),
        true,
        overloaded,
      );
    } else if (ts.isCallSignatureDeclaration(element)) {
      addMethodSignature(
        members,
        newMember("()", "call"),
        signatureFrom(element, sf),
        true,
        overloaded,
      );
    } else if (ts.isConstructSignatureDeclaration(element)) {
      addMethodSignature(
        members,
        newMember("new()", "construct"),
        signatureFrom(element, sf),
        true,
        overloaded,
      );
    } else if (ts.isIndexSignatureDeclaration(element)) {
      const keyType = element.parameters[0]?.type
        ? normType(element.parameters[0].type.getText(sf))
        : "string";
      const name = `[${keyType}]`;

      members.set(
        name,
        newMember(name, "index", {
          readonly: hasModifier(element, ts.SyntaxKind.ReadonlyKeyword),
          type: describeType(element.type, sf),
        }),
      );
    } else if (
      ts.isGetAccessorDeclaration(element) ||
      ts.isSetAccessorDeclaration(element)
    ) {
      const name = propertyNameText(element.name, sf);
      if (!name) continue;

      const type = ts.isGetAccessorDeclaration(element)
        ? describeType(element.type, sf)
        : describeType(element.parameters[0]?.type, sf);

      if (!members.has(name)) {
        members.set(name, newMember(name, "property", { type }));
      }
    }
  }

  return members;
}

function visibilityOf(node: ts.Node): Visibility {
  if (hasModifier(node, ts.SyntaxKind.PrivateKeyword)) return "private";
  if (hasModifier(node, ts.SyntaxKind.ProtectedKeyword)) return "protected";
  return "public";
}

function classMembers(
  node: ts.ClassDeclaration,
  sf: ts.SourceFile,
): Map<string, MemberModel> {
  const members = new Map<string, MemberModel>();
  const overloaded = new Set<string>();
  const getters = new Set<string>();
  const setters = new Set<string>();

  for (const member of node.members) {
    const isStatic = hasModifier(member, ts.SyntaxKind.StaticKeyword);
    const visibility = visibilityOf(member);
    const abstract = hasModifier(member, ts.SyntaxKind.AbstractKeyword);
    const readonly = hasModifier(member, ts.SyntaxKind.ReadonlyKeyword);

    if (ts.isConstructorDeclaration(member)) {
      addMethodSignature(
        members,
        newMember("constructor", "constructor", { visibility }),
        signatureFrom(member, sf),
        !member.body,
        overloaded,
      );

      // `constructor(private x: T, public y: U)` also declares properties.
      for (const param of member.parameters) {
        const parameterVisibility = visibilityOf(param);
        const isParameterProperty =
          modifiersOf(param).length > 0 && ts.isIdentifier(param.name);

        if (!isParameterProperty || parameterVisibility === "private") continue;

        const name = (param.name as ts.Identifier).text;
        members.set(
          name,
          newMember(name, "property", {
            optional: Boolean(param.questionToken),
            readonly: hasModifier(param, ts.SyntaxKind.ReadonlyKeyword),
            visibility: parameterVisibility,
            type: describeType(param.type, sf),
          }),
        );
      }
      continue;
    }

    if (
      ts.isIndexSignatureDeclaration(member) ||
      ts.isClassStaticBlockDeclaration(member) ||
      ts.isSemicolonClassElement(member)
    ) {
      if (ts.isIndexSignatureDeclaration(member)) {
        const keyType = member.parameters[0]?.type
          ? normType(member.parameters[0].type.getText(sf))
          : "string";
        const name = `[${keyType}]`;
        members.set(
          name,
          newMember(name, "index", {
            readonly,
            type: describeType(member.type, sf),
          }),
        );
      }
      continue;
    }

    const rawName = member.name;
    if (!rawName || ts.isPrivateIdentifier(rawName)) continue;

    const name = propertyNameText(rawName, sf);
    if (!name || visibility === "private") continue;

    const key = `${isStatic ? "static " : ""}${name}`;

    if (ts.isPropertyDeclaration(member)) {
      members.set(
        key,
        newMember(name, "property", {
          key,
          isStatic,
          optional: Boolean(member.questionToken),
          readonly,
          abstract,
          visibility,
          type: describeType(member.type, sf),
        }),
      );
    } else if (ts.isMethodDeclaration(member)) {
      addMethodSignature(
        members,
        newMember(name, "method", {
          key,
          isStatic,
          optional: Boolean(member.questionToken),
          abstract,
          visibility,
        }),
        signatureFrom(member, sf),
        !member.body && !abstract,
        overloaded,
      );
    } else if (
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member)
    ) {
      if (ts.isGetAccessorDeclaration(member)) getters.add(key);
      else setters.add(key);

      const type = ts.isGetAccessorDeclaration(member)
        ? describeType(member.type, sf)
        : describeType(member.parameters[0]?.type, sf);

      const existing = members.get(key);
      members.set(
        key,
        newMember(name, "property", {
          key,
          isStatic,
          abstract,
          visibility,
          type: existing?.type ?? type,
        }),
      );
    }
  }

  for (const key of getters) {
    if (!setters.has(key)) {
      const member = members.get(key);
      if (member) member.readonly = true;
    }
  }

  return members;
}

function heritageFrom(
  clauses: ts.NodeArray<ts.HeritageClause> | undefined,
  sf: ts.SourceFile,
): { extends: string[]; implements: string[] } {
  const result = { extends: [] as string[], implements: [] as string[] };

  for (const clause of clauses ?? []) {
    const target =
      clause.token === ts.SyntaxKind.ExtendsKeyword
        ? result.extends
        : result.implements;

    for (const type of clause.types) target.push(collapse(type.getText(sf)));
  }

  return result;
}

function enumMembersFrom(
  node: ts.EnumDeclaration,
  sf: ts.SourceFile,
): EnumMemberModel[] {
  const members: EnumMemberModel[] = [];
  let next: number | undefined = 0;

  for (const member of node.members) {
    const name = propertyNameText(member.name, sf) ?? "?";
    const initializer = member.initializer;
    let value: string | undefined;

    if (!initializer) {
      value = next === undefined ? undefined : String(next);
      next = next === undefined ? undefined : next + 1;
    } else if (ts.isNumericLiteral(initializer)) {
      const numeric = Number(initializer.text);
      value = String(numeric);
      next = numeric + 1;
    } else if (
      ts.isPrefixUnaryExpression(initializer) &&
      initializer.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(initializer.operand)
    ) {
      const numeric = -Number(initializer.operand.text);
      value = String(numeric);
      next = numeric + 1;
    } else if (
      ts.isStringLiteral(initializer) ||
      ts.isNoSubstitutionTemplateLiteral(initializer)
    ) {
      value = JSON.stringify(initializer.text);
      next = undefined;
    } else {
      value = `expr:${collapse(initializer.getText(sf))}`;
      next = undefined;
    }

    members.push({ name, value });
  }

  return members;
}

interface LocalDecl {
  sym: SymbolModel;
  exportNames: Set<string>;
  overloads: boolean;
}

function newSymbol(
  rel: string,
  name: string,
  kind: SymbolKind,
  node: ts.Node,
  sf: ts.SourceFile,
): SymbolModel {
  return {
    key: `${rel}#${name}`,
    name,
    filePath: rel,
    line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    kind,
    deprecated: isDeprecated(node),
    signatures: [],
    typeParams: [],
    heritage: { extends: [], implements: [] },
    members: new Map(),
    enumMembers: [],
    rendered: "",
    shape: "",
  };
}

function isFunctionInitializer(
  node: ts.Expression | undefined,
): node is ts.ArrowFunction | ts.FunctionExpression {
  return Boolean(
    node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node)),
  );
}

interface ImportBinding {
  spec: string;
  imported: string;
}

function collectImports(sf: ts.SourceFile): {
  imports: ImportRef[];
  bindings: Map<string, ImportBinding>;
} {
  const imports: ImportRef[] = [];
  const bindings = new Map<string, ImportBinding>();

  for (const statement of sf.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const spec = statement.moduleSpecifier.text;
      const names: string[] = [];
      const clause = statement.importClause;

      if (clause?.name) {
        names.push("default");
        bindings.set(clause.name.text, { spec, imported: "default" });
      }

      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          names.push("*");
          bindings.set(clause.namedBindings.name.text, { spec, imported: "*" });
        } else {
          for (const element of clause.namedBindings.elements) {
            const imported = element.propertyName?.text ?? element.name.text;
            names.push(imported);
            bindings.set(element.name.text, { spec, imported });
          }
        }
      }

      if (!clause) names.push("*");
      imports.push({ spec, names });
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const spec = statement.moduleSpecifier.text;
      const names: string[] = [];
      const clause = statement.exportClause;

      if (!clause || ts.isNamespaceExport(clause)) names.push("*");
      else {
        for (const element of clause.elements) {
          names.push(element.propertyName?.text ?? element.name.text);
        }
      }

      imports.push({ spec, names });
    }
  }

  return { imports, bindings };
}

function extractExports(
  sf: ts.SourceFile,
  rel: string,
  api: FileApi,
  bindings: Map<string, ImportBinding>,
) {
  const locals = new Map<string, LocalDecl>();
  const extra: SymbolModel[] = [];
  const pending: Array<{ local: string; exported: string; node: ts.Node }> = [];

  const ensure = (
    name: string,
    kind: SymbolKind,
    node: ts.Node,
  ): LocalDecl => {
    let local = locals.get(name);

    if (!local) {
      local = {
        sym: newSymbol(rel, name, kind, node, sf),
        exportNames: new Set(),
        overloads: false,
      };
      locals.set(name, local);
    }

    return local;
  };

  const markExported = (
    local: LocalDecl,
    name: string,
    isExported: boolean,
    isDefault: boolean,
  ) => {
    if (!isExported) return;
    local.exportNames.add(isDefault ? "default" : name);
  };

  for (const statement of sf.statements) {
    const isExported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);

    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text ?? (isDefault ? "default" : undefined);
      if (!name) continue;

      const local = ensure(name, "function", statement);
      const signature = signatureFrom(statement, sf);

      if (!statement.body) {
        local.overloads = true;
        local.sym.signatures.push(signature);
      } else if (!local.overloads) {
        local.sym.signatures.push(signature);
      }

      if (isDeprecated(statement)) local.sym.deprecated = true;
      markExported(local, name, isExported, isDefault);
    } else if (ts.isClassDeclaration(statement)) {
      const name = statement.name?.text ?? (isDefault ? "default" : undefined);
      if (!name) continue;

      const local = ensure(name, "class", statement);
      local.sym.kind = "class";
      local.sym.abstract = hasModifier(statement, ts.SyntaxKind.AbstractKeyword);
      local.sym.typeParams = typeParamsFrom(statement.typeParameters, sf);
      local.sym.heritage = heritageFrom(statement.heritageClauses, sf);
      local.sym.members = classMembers(statement, sf);
      markExported(local, name, isExported, isDefault);
    } else if (ts.isInterfaceDeclaration(statement)) {
      const local = ensure(statement.name.text, "interface", statement);

      if (local.sym.typeParams.length === 0) {
        local.sym.typeParams = typeParamsFrom(statement.typeParameters, sf);
      }

      const heritage = heritageFrom(statement.heritageClauses, sf);
      for (const base of heritage.extends) {
        if (!local.sym.heritage.extends.includes(base)) {
          local.sym.heritage.extends.push(base);
        }
      }

      const overloaded = new Set<string>();
      for (const [key, member] of membersFromElements(statement.members, sf)) {
        const existing = local.sym.members.get(key);
        if (existing && member.kind === "method") {
          existing.signatures.push(...member.signatures);
          overloaded.add(key);
        } else if (!existing) {
          local.sym.members.set(key, member);
        }
      }

      markExported(local, statement.name.text, isExported, false);
    } else if (ts.isTypeAliasDeclaration(statement)) {
      const local = ensure(statement.name.text, "type", statement);
      local.sym.typeParams = typeParamsFrom(statement.typeParameters, sf);
      local.sym.type = describeType(statement.type, sf);
      markExported(local, statement.name.text, isExported, false);
    } else if (ts.isEnumDeclaration(statement)) {
      const local = ensure(statement.name.text, "enum", statement);
      local.sym.enumMembers = enumMembersFrom(statement, sf);
      local.sym.constEnum = hasModifier(statement, ts.SyntaxKind.ConstKeyword);
      markExported(local, statement.name.text, isExported, false);
    } else if (ts.isVariableStatement(statement)) {
      const flags = statement.declarationList.flags;
      const declKind: "const" | "let" | "var" =
        flags & ts.NodeFlags.Const
          ? "const"
          : flags & ts.NodeFlags.Let
            ? "let"
            : "var";

      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;

        const name = declaration.name.text;
        const functionLike =
          !declaration.type && isFunctionInitializer(declaration.initializer);

        const local = ensure(
          name,
          functionLike ? "function" : "variable",
          statement,
        );
        local.sym.declKind = declKind;

        if (functionLike && isFunctionInitializer(declaration.initializer)) {
          local.sym.signatures.push(signatureFrom(declaration.initializer, sf));
        } else {
          local.sym.type = describeType(declaration.type, sf);
        }

        markExported(local, name, isExported, false);
      }
    } else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
      const local = ensure(statement.name.text, "namespace", statement);

      if (statement.body && ts.isModuleBlock(statement.body)) {
        for (const inner of statement.body.statements) {
          if (!hasModifier(inner, ts.SyntaxKind.ExportKeyword)) continue;

          const names: string[] = [];
          if (
            (ts.isFunctionDeclaration(inner) ||
              ts.isClassDeclaration(inner) ||
              ts.isInterfaceDeclaration(inner) ||
              ts.isTypeAliasDeclaration(inner) ||
              ts.isEnumDeclaration(inner)) &&
            inner.name
          ) {
            names.push(inner.name.text);
          } else if (ts.isVariableStatement(inner)) {
            for (const declaration of inner.declarationList.declarations) {
              if (ts.isIdentifier(declaration.name)) {
                names.push(declaration.name.text);
              }
            }
          }

          for (const name of names) {
            local.sym.members.set(name, newMember(name, "property"));
          }
        }
      }

      markExported(local, statement.name.text, isExported, false);
    } else if (ts.isExportDeclaration(statement)) {
      if (
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const spec = statement.moduleSpecifier.text;
        const clause = statement.exportClause;

        if (!clause) {
          api.reexports.push({ spec, star: true, names: [] });
          const symbol = newSymbol(rel, `*:${spec}`, "reexport", statement, sf);
          symbol.reexport = { from: spec, imported: "*", star: true };
          extra.push(symbol);
        } else if (ts.isNamespaceExport(clause)) {
          const symbol = newSymbol(rel, clause.name.text, "reexport", statement, sf);
          symbol.reexport = { from: spec, imported: "*", star: false };
          extra.push(symbol);
        } else {
          const names: Array<{ imported: string; exported: string }> = [];

          for (const element of clause.elements) {
            const exported = element.name.text;
            const imported = element.propertyName?.text ?? exported;
            names.push({ imported, exported });

            const symbol = newSymbol(rel, exported, "reexport", element, sf);
            symbol.reexport = { from: spec, imported, star: false };
            extra.push(symbol);
          }

          api.reexports.push({ spec, star: false, names });
        }
      } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          pending.push({
            local: element.propertyName?.text ?? element.name.text,
            exported: element.name.text,
            node: element,
          });
        }
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      if (ts.isIdentifier(statement.expression)) {
        pending.push({
          local: statement.expression.text,
          exported: "default",
          node: statement,
        });
      } else {
        const symbol = newSymbol(rel, "default", "variable", statement, sf);
        extra.push(symbol);
      }
    }
  }

  for (const item of pending) {
    const local = locals.get(item.local);

    if (local) {
      local.exportNames.add(item.exported);
      continue;
    }

    const binding = bindings.get(item.local);
    if (!binding) continue;

    const symbol = newSymbol(rel, item.exported, "reexport", item.node, sf);
    symbol.reexport = {
      from: binding.spec,
      imported: binding.imported,
      star: false,
    };
    extra.push(symbol);
    api.reexports.push({
      spec: binding.spec,
      star: false,
      names: [{ imported: binding.imported, exported: item.exported }],
    });
  }

  const finished: SymbolModel[] = [];

  for (const local of locals.values()) {
    for (const exportName of local.exportNames) {
      const clone: SymbolModel = {
        ...local.sym,
        name: exportName,
        key: `${rel}#${exportName}`,
      };
      finished.push(clone);
    }
  }

  for (const symbol of extra) finished.push(symbol);

  const unique = new Map<string, SymbolModel>();
  for (const symbol of finished) {
    symbol.rendered = renderSymbol(symbol);
    symbol.shape = `${symbol.kind}|${symbol.rendered.split(symbol.name).join("§")}`;
    if (!unique.has(symbol.key)) unique.set(symbol.key, symbol);
  }

  api.exports = [...unique.values()];
}

/* -------------------------------------------------------------------------- */
/*  Rendering declarations as readable text                                   */
/* -------------------------------------------------------------------------- */

function renderTypeParams(params: TypeParamModel[]): string {
  if (params.length === 0) return "";

  return `<${params
    .map(
      (param) =>
        `${param.name}${param.constraint ? ` extends ${param.constraint}` : ""}${
          param.hasDefault ? " = …" : ""
        }`,
    )
    .join(", ")}>`;
}

function renderParam(param: ParamModel): string {
  return `${param.rest ? "..." : ""}${param.name}${param.optional ? "?" : ""}${
    param.type ? `: ${param.type.text}` : ""
  }${param.defaulted ? " = …" : ""}`;
}

function renderSignature(prefix: string, signature: SignatureModel): string {
  const head = `${signature.async && !signature.returns ? "async " : ""}${prefix}${renderTypeParams(
    signature.typeParams,
  )}`;
  const params = signature.params.map(renderParam);
  const returns = signature.returns ? `: ${signature.returns.text}` : "";

  if (params.length <= 1 && params.join("").length < 64) {
    return `${head}(${params.join(", ")})${returns}`;
  }

  return `${head}(\n${params.map((param) => `  ${param}`).join(",\n")}\n)${returns}`;
}

function indentBlock(text: string, pad = "  "): string {
  return text
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}

function renderMember(member: MemberModel): string[] {
  const mods = `${member.isStatic ? "static " : ""}${
    member.visibility === "public" ? "" : `${member.visibility} `
  }${member.abstract ? "abstract " : ""}${member.readonly ? "readonly " : ""}`;

  if (member.kind === "property") {
    return [
      `${mods}${member.name}${member.optional ? "?" : ""}${
        member.type ? `: ${member.type.text}` : ""
      }`,
    ];
  }

  if (member.kind === "index") {
    return [`${mods}${member.name}${member.type ? `: ${member.type.text}` : ""}`];
  }

  const label =
    member.kind === "constructor"
      ? "constructor"
      : member.kind === "call"
        ? ""
        : member.kind === "construct"
          ? "new "
          : `${member.name}${member.optional ? "?" : ""}`;

  return member.signatures.map((signature) =>
    `${mods}${renderSignature(label, signature)}`,
  );
}

function renderMembers(members: Map<string, MemberModel>): string {
  const lines: string[] = [];

  for (const member of members.values()) {
    for (const line of renderMember(member)) lines.push(indentBlock(line));
  }

  return lines.join("\n");
}

function renderTypeBody(type: TypeModel | undefined): string {
  if (!type) return "unknown";

  if (type.members) {
    const body = renderMembers(type.members);
    return body ? `{\n${body}\n}` : "{}";
  }

  if (type.union && type.union.length > 1) {
    return `\n${type.union.map((member) => `  | ${member}`).join("\n")}`;
  }

  return type.text;
}

function renderSymbol(symbol: SymbolModel): string {
  const typeParams = renderTypeParams(symbol.typeParams);

  switch (symbol.kind) {
    case "function":
      return symbol.signatures
        .map((signature) => renderSignature(`function ${symbol.name}`, signature))
        .join("\n");

    case "variable":
      return `${symbol.declKind ?? "const"} ${symbol.name}${
        symbol.type ? `: ${symbol.type.text}` : ""
      }`;

    case "class": {
      const heritage = `${
        symbol.heritage.extends.length
          ? ` extends ${symbol.heritage.extends.join(", ")}`
          : ""
      }${
        symbol.heritage.implements.length
          ? ` implements ${symbol.heritage.implements.join(", ")}`
          : ""
      }`;
      const body = renderMembers(symbol.members);
      return `${symbol.abstract ? "abstract " : ""}class ${symbol.name}${typeParams}${heritage} {${
        body ? `\n${body}\n` : ""
      }}`;
    }

    case "interface": {
      const heritage = symbol.heritage.extends.length
        ? ` extends ${symbol.heritage.extends.join(", ")}`
        : "";
      const body = renderMembers(symbol.members);
      return `interface ${symbol.name}${typeParams}${heritage} {${
        body ? `\n${body}\n` : ""
      }}`;
    }

    case "type": {
      const body = renderTypeBody(symbol.type);
      return `type ${symbol.name}${typeParams} =${body.startsWith("\n") ? "" : " "}${body}`;
    }

    case "enum": {
      const lines = symbol.enumMembers.map(
        (member) =>
          `  ${member.name}${member.value !== undefined ? ` = ${member.value.replace(/^expr:/, "")}` : ""}`,
      );
      return `${symbol.constEnum ? "const " : ""}enum ${symbol.name} {${
        lines.length ? `\n${lines.join("\n")}\n` : ""
      }}`;
    }

    case "namespace": {
      const names = [...symbol.members.keys()].map((name) => `  ${name}`);
      return `namespace ${symbol.name} {${names.length ? `\n${names.join("\n")}\n` : ""}}`;
    }

    case "reexport": {
      const target = symbol.reexport;
      if (!target) return `export ${symbol.name}`;
      if (target.star) return `export * from "${target.from}"`;
      if (target.imported === "*") {
        return `export * as ${symbol.name} from "${target.from}"`;
      }
      return `export { ${target.imported}${
        target.imported === symbol.name ? "" : ` as ${symbol.name}`
      } } from "${target.from}"`;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Extracting HTTP routes                                                    */
/* -------------------------------------------------------------------------- */

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "all",
]);

const SERVER_MODULE_PATTERN =
  /^(express|fastify|koa|koa-router|@koa\/router|hono|@hono\/.+|@hapi\/hapi|restify|polka|itty-router)$/;

const ROUTER_NAME_PATTERN =
  /^(app|router|server|fastify|route|routes|\w+Router|\w+App|\w+Server)$/i;

const CLIENT_NAME_PATTERN =
  /^(axios|ky|got|http|https|request|superagent|fetcher|client|supertest|agent|\w+Client|\w+Http)$/i;

const AUTH_NAME_PATTERN =
  /auth|protect|guard|jwt|session|permission|role|login|token|apikey/i;

function receiverName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function pathFromArgument(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }

  if (ts.isTemplateExpression(node)) {
    return (
      node.head.text +
      node.templateSpans.map((span) => `:param${span.literal.text}`).join("")
    );
  }

  return undefined;
}

function normalizeRoutePath(value: string): string {
  let normalized = value
    .replace(/\{[^}]+\}/g, ":param")
    .replace(/:[A-Za-z0-9_]+(\?)?/g, (_, optional) =>
      optional ? ":param?" : ":param",
    );

  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, "");
  return normalized || "/";
}

function calleeText(node: ts.Expression, sf: ts.SourceFile): string {
  if (ts.isCallExpression(node)) return calleeText(node.expression, sf);
  return collapse(node.getText(sf));
}

function unwrapRequestSource(
  expression: ts.Expression,
  requestName: string,
): "body" | "query" | undefined {
  let current = expression;

  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isAsExpression(current)) current = current.expression;
    else if (ts.isNonNullExpression(current)) current = current.expression;
    else if (
      ts.isBinaryExpression(current) &&
      (current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      current = current.left;
    } else break;
  }

  if (
    ts.isPropertyAccessExpression(current) &&
    ts.isIdentifier(current.expression) &&
    current.expression.text === requestName &&
    (current.name.text === "body" || current.name.text === "query")
  ) {
    return current.name.text;
  }

  return undefined;
}

function inspectHandler(
  handler: ts.ArrowFunction | ts.FunctionExpression,
  sf: ts.SourceFile,
): { fields: Map<string, RequestField>; responseFields: Set<string> } {
  const fields = new Map<string, RequestField>();
  const responseFields = new Set<string>();
  const validated = new Set<string>();

  const firstParam = handler.parameters[0];
  const requestName =
    firstParam && ts.isIdentifier(firstParam.name) ? firstParam.name.text : "";

  const addField = (
    source: "body" | "query",
    name: string,
    defaulted: boolean,
  ) => {
    const key = `${source}.${name}`;
    const existing = fields.get(key);

    fields.set(key, {
      source,
      name,
      defaulted: existing ? existing.defaulted && defaulted : defaulted,
      validated: false,
    });
  };

  const isErrorChain = (expression: ts.Expression): boolean => {
    let current: ts.Expression = expression;

    while (
      ts.isCallExpression(current) ||
      ts.isPropertyAccessExpression(current)
    ) {
      if (
        ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression) &&
        (current.expression.name.text === "status" ||
          current.expression.name.text === "code")
      ) {
        const code = current.arguments[0];
        if (code && ts.isNumericLiteral(code) && Number(code.text) >= 400) {
          return true;
        }
      }

      current = ts.isCallExpression(current)
        ? current.expression
        : current.expression;
    }

    return false;
  };

  const collectIdentifiers = (node: ts.Node) => {
    if (ts.isIdentifier(node)) validated.add(node.text);
    ts.forEachChild(node, collectIdentifiers);
  };

  const visit = (node: ts.Node) => {
    if (requestName && ts.isVariableDeclaration(node) && node.initializer) {
      const source = unwrapRequestSource(node.initializer, requestName);

      if (source && ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (element.dotDotDotToken) continue;

          const name = element.propertyName
            ? propertyNameText(element.propertyName, sf)
            : ts.isIdentifier(element.name)
              ? element.name.text
              : undefined;

          if (name) addField(source, name, Boolean(element.initializer));
        }
      }
    }

    if (
      requestName &&
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === requestName &&
      (node.expression.name.text === "body" ||
        node.expression.name.text === "query")
    ) {
      const parent = node.parent;
      const defaulted =
        ts.isBinaryExpression(parent) &&
        parent.left === node &&
        (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          parent.operatorToken.kind === ts.SyntaxKind.BarBarToken);

      addField(node.expression.name.text as "body" | "query", node.name.text, defaulted);
    }

    if (ts.isIfStatement(node)) {
      const thenText = node.thenStatement.getText(sf);
      if (/\.(status|sendStatus)\(\s*4\d\d\s*\)/.test(thenText)) {
        collectIdentifiers(node.expression);
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === "json" ||
        node.expression.name.text === "send") &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0]) &&
      !isErrorChain(node.expression.expression)
    ) {
      for (const property of node.arguments[0].properties) {
        if (ts.isPropertyAssignment(property)) {
          const name = propertyNameText(property.name, sf);
          if (name) responseFields.add(name);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          responseFields.add(property.name.text);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(handler.body);

  for (const field of fields.values()) {
    field.validated = validated.has(field.name);
  }

  return { fields, responseFields };
}

function fieldLabel(field: RequestField): string {
  if (field.defaulted) return "default";
  return field.validated ? "required" : "optional";
}

function renderRoute(route: RouteModel): string {
  const lines = [`${route.method} ${route.path}`];

  if (route.middleware.length > 0) {
    lines.push(`  middleware: ${route.middleware.join(", ")}`);
  }

  const fields = [...route.requestFields.values()].sort((a, b) =>
    `${a.source}.${a.name}`.localeCompare(`${b.source}.${b.name}`),
  );
  for (const field of fields) {
    lines.push(`  ${field.source}.${field.name}: ${fieldLabel(field)}`);
  }

  for (const name of [...route.responseFields].sort()) {
    lines.push(`  response.${name}`);
  }

  return lines.join("\n");
}

function extractRoutes(
  sf: ts.SourceFile,
  rel: string,
  api: FileApi,
  importsServerFramework: boolean,
) {
  const seen = new Map<string, number>();

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const method = node.expression.name.text;
      const receiver = receiverName(node.expression.expression);
      const looksLikeServer =
        receiver !== undefined &&
        (ROUTER_NAME_PATTERN.test(receiver) ||
          (importsServerFramework && !CLIENT_NAME_PATTERN.test(receiver)));

      if (
        method === "use" &&
        looksLikeServer &&
        node.arguments.length >= 2 &&
        pathFromArgument(node.arguments[0])?.startsWith("/")
      ) {
        api.hasMountedRouters = true;
      }

      if (
        HTTP_METHODS.has(method) &&
        looksLikeServer &&
        receiver !== undefined &&
        !(CLIENT_NAME_PATTERN.test(receiver) && !ROUTER_NAME_PATTERN.test(receiver)) &&
        node.arguments.length >= 2
      ) {
        const rawPath = pathFromArgument(node.arguments[0]);
        const handlers = node.arguments.slice(1);
        const hasHandler = handlers.some(
          (argument) =>
            !ts.isObjectLiteralExpression(argument) &&
            !ts.isStringLiteral(argument) &&
            !ts.isNumericLiteral(argument),
        );

        if (rawPath && rawPath.startsWith("/") && hasHandler) {
          const httpMethod = method.toUpperCase();
          const normPath = normalizeRoutePath(rawPath);

          const middleware = handlers
            .slice(0, -1)
            .filter(
              (argument) =>
                ts.isIdentifier(argument) ||
                ts.isCallExpression(argument) ||
                ts.isPropertyAccessExpression(argument),
            )
            .map((argument) => calleeText(argument, sf));

          const last = handlers[handlers.length - 1];
          const inline =
            last && (ts.isArrowFunction(last) || ts.isFunctionExpression(last))
              ? inspectHandler(last, sf)
              : undefined;

          const baseKey = `${httpMethod} ${normPath}`;
          const count = (seen.get(baseKey) ?? 0) + 1;
          seen.set(baseKey, count);

          const route: RouteModel = {
            key: count === 1 ? baseKey : `${baseKey} #${count}`,
            method: httpMethod,
            path: rawPath,
            normPath,
            filePath: rel,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            middleware,
            requestFields: inline?.fields ?? new Map(),
            responseFields: inline?.responseFields ?? new Set(),
            handlerInspected: Boolean(inline),
            rendered: "",
          };

          route.rendered = renderRoute(route);
          api.routes.push(route);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
}

function parseApiFile(
  rel: string,
  text: string,
  scope: AnalysisScope,
): FileApi {
  const sf = ts.createSourceFile(
    rel,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(rel),
  );

  const api: FileApi = {
    rel,
    exports: [],
    imports: [],
    reexports: [],
    routes: [],
    hasMountedRouters: false,
  };

  const { imports, bindings } = collectImports(sf);
  api.imports = imports;

  if (scope !== "routes") extractExports(sf, rel, api, bindings);

  if (scope !== "exports") {
    const importsServerFramework = imports.some((item) =>
      SERVER_MODULE_PATTERN.test(item.spec),
    );
    extractRoutes(sf, rel, api, importsServerFramework);
  }

  return api;
}

/* -------------------------------------------------------------------------- */
/*  Building a snapshot of one version                                        */
/* -------------------------------------------------------------------------- */

function resolveSpecifier(
  fromRel: string,
  spec: string,
  fileSet: Set<string>,
): string | undefined {
  if (!spec.startsWith(".")) return undefined;

  const joined = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromRel), spec),
  );
  // TypeScript ESM projects import "./x.js" for "./x.ts".
  const stripped = joined.replace(/\.[cm]?jsx?$/, "");

  const candidates = [
    joined,
    ...RESOLVE_EXTENSIONS.map((extension) => `${stripped}${extension}`),
    ...RESOLVE_EXTENSIONS.map((extension) => `${joined}${extension}`),
    ...RESOLVE_EXTENSIONS.map((extension) => `${joined}/index${extension}`),
  ];

  return candidates.find((candidate) => fileSet.has(candidate));
}

function collectPackageStrings(value: unknown, into: string[]) {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) collectPackageStrings(item, into);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectPackageStrings(item, into);
    }
  }
}

function mapToSource(target: string, fileSet: Set<string>): string | undefined {
  const cleaned = normalizePath(target).replace(/^\.\//, "");
  if (!cleaned || cleaned.includes("*")) return undefined;

  const withoutExtension = cleaned.replace(
    /(\.d)?\.[cm]?[jt]sx?$/,
    "",
  );

  const roots = new Set<string>([withoutExtension]);
  const swapped = withoutExtension.replace(
    /^(dist|build|lib|out|esm|cjs)\//,
    "",
  );
  roots.add(swapped);
  roots.add(`src/${swapped}`);

  for (const root of roots) {
    for (const extension of RESOLVE_EXTENSIONS) {
      if (fileSet.has(`${root}${extension}`)) return `${root}${extension}`;
    }
    for (const extension of RESOLVE_EXTENSIONS) {
      if (fileSet.has(`${root}/index${extension}`)) {
        return `${root}/index${extension}`;
      }
    }
  }

  return undefined;
}

function detectEntryFiles(
  fileSet: Set<string>,
  packageJson: string | undefined,
  override: string[] | undefined,
): string[] {
  if (override && override.length > 0) {
    return override
      .map((entry) => normalizePath(entry).replace(/^\.\//, ""))
      .filter((entry) => fileSet.has(entry));
  }

  const entries = new Set<string>();

  if (packageJson) {
    try {
      const parsed = JSON.parse(packageJson) as Record<string, unknown>;
      const strings: string[] = [];

      for (const field of ["main", "module", "types", "typings", "bin", "exports"]) {
        collectPackageStrings(parsed[field], strings);
      }

      for (const value of strings) {
        const mapped = mapToSource(value, fileSet);
        if (mapped) entries.add(mapped);
      }
    } catch {
      /* an unreadable package.json just means no declared entry points */
    }
  }

  if (entries.size === 0) {
    for (const candidate of [
      "src/index.ts",
      "src/index.tsx",
      "src/index.mts",
      "src/index.js",
      "src/index.jsx",
      "index.ts",
      "index.js",
      "lib/index.ts",
      "lib/index.js",
    ]) {
      if (fileSet.has(candidate)) entries.add(candidate);
    }
  }

  return [...entries].sort();
}

function buildSnapshot(
  set: SourceSet,
  scope: AnalysisScope,
  entryOverride: string[] | undefined,
  warn: (message: string) => void,
): Snapshot {
  const files = new Map<string, FileApi>();

  for (const source of set.files) {
    try {
      files.set(source.rel, parseApiFile(source.rel, source.text, scope));
    } catch {
      warn(`Could not parse ${source.rel} (${set.side.label}).`);
    }
  }

  const fileSet = new Set(files.keys());
  const symbols = new Map<string, SymbolModel>();
  const routes = new Map<string, RouteModel>();
  let unannotatedReturns = 0;
  let hasMountedRouters = false;

  for (const api of files.values()) {
    for (const symbol of api.exports) {
      symbols.set(symbol.key, symbol);

      if (symbol.kind === "function") {
        unannotatedReturns += symbol.signatures.filter(
          (signature) => !signature.returns,
        ).length;
      }
    }

    for (const route of api.routes) routes.set(route.key, route);
    if (api.hasMountedRouters) hasMountedRouters = true;
  }

  const entryFiles = detectEntryFiles(fileSet, set.packageJson, entryOverride);

  // Everything an entry file exports, directly or through re-exports.
  const publicKeys = new Set<string>();
  const visited = new Set<string>();

  const expose = (rel: string, only: Set<string> | null, depth: number) => {
    const token = `${rel}|${only ? [...only].sort().join(",") : "*"}`;
    if (visited.has(token) || depth > MAX_REEXPORT_DEPTH) return;
    visited.add(token);

    const api = files.get(rel);
    if (!api) return;

    for (const symbol of api.exports) {
      if (!only || only.has(symbol.name)) publicKeys.add(symbol.key);
    }

    for (const reexport of api.reexports) {
      const target = resolveSpecifier(rel, reexport.spec, fileSet);
      if (!target) continue;

      if (reexport.star) {
        expose(target, only, depth + 1);
      } else {
        for (const name of reexport.names) {
          if (!only || only.has(name.exported)) {
            expose(target, new Set([name.imported]), depth + 1);
          }
        }
      }
    }
  };

  for (const entry of entryFiles) expose(entry, null, 0);

  // Who imports what, so every change can list the files it affects.
  const importIndex = new Map<string, Set<string>>();

  for (const api of files.values()) {
    for (const reference of api.imports) {
      const target = resolveSpecifier(api.rel, reference.spec, fileSet);
      if (!target || target === api.rel) continue;

      for (const name of reference.names) {
        const key = `${target}#${name}`;
        let importers = importIndex.get(key);
        if (!importers) {
          importers = new Set();
          importIndex.set(key, importers);
        }
        importers.add(api.rel);
      }
    }
  }

  return {
    files,
    symbols,
    routes,
    entryFiles,
    publicKeys,
    importIndex,
    unannotatedReturns,
    hasMountedRouters,
  };
}

function findExport(
  snapshot: Snapshot,
  rel: string,
  name: string,
  depth: number,
): SymbolModel | undefined {
  if (depth > MAX_REEXPORT_DEPTH) return undefined;

  const direct = snapshot.symbols.get(`${rel}#${name}`);
  if (direct) return direct;

  const api = snapshot.files.get(rel);
  if (!api) return undefined;

  const fileSet = new Set(snapshot.files.keys());

  for (const reexport of api.reexports) {
    if (!reexport.star) continue;

    const target = resolveSpecifier(rel, reexport.spec, fileSet);
    if (!target) continue;

    const found = findExport(snapshot, target, name, depth + 1);
    if (found) return found;
  }

  return undefined;
}

/** Follows `export { x } from "./y"` to the declaration that defines x. */
function resolveConcrete(
  snapshot: Snapshot,
  symbol: SymbolModel,
  depth = 0,
): SymbolModel | undefined {
  if (symbol.kind !== "reexport") return symbol;
  if (!symbol.reexport || symbol.reexport.star || symbol.reexport.imported === "*") {
    return undefined;
  }
  if (depth > MAX_REEXPORT_DEPTH) return undefined;

  const target = resolveSpecifier(
    symbol.filePath,
    symbol.reexport.from,
    new Set(snapshot.files.keys()),
  );
  if (!target) return undefined;

  const found = findExport(snapshot, target, symbol.reexport.imported, 0);
  return found ? resolveConcrete(snapshot, found, depth + 1) : undefined;
}

function consumersOf(snapshot: Snapshot, key: string): string[] {
  const [file, name] = [key.slice(0, key.indexOf("#")), key.slice(key.indexOf("#") + 1)];
  const importers = new Set<string>();

  for (const lookup of [`${file}#${name}`, `${file}#*`]) {
    for (const importer of snapshot.importIndex.get(lookup) ?? []) {
      if (importer !== file) importers.add(importer);
    }
  }

  return [...importers].sort();
}

/* -------------------------------------------------------------------------- */
/*  Comparing declarations                                                    */
/* -------------------------------------------------------------------------- */

type Direction = "input" | "output" | "both";
type Owner = "class" | "object";

function issue(
  kind: IssueKind,
  severity: ChangeSeverity,
  confidence: Confidence,
  where: string,
  message: string,
  before?: string,
  after?: string,
): ChangeIssue {
  return {
    kind,
    severity,
    breaking: severity !== "info",
    confidence,
    path: where,
    message,
    before,
    after,
  };
}

function joinPath(prefix: string, rest: string): string {
  return prefix ? `${prefix} · ${rest}` : rest;
}

function compareShape(
  oldType: TypeModel | undefined,
  newType: TypeModel | undefined,
  direction: Direction,
  where: string,
  kind: IssueKind,
  out: ChangeIssue[],
) {
  if (!oldType || !newType || oldType.norm === newType.norm) return;

  if (oldType.members && newType.members) {
    compareMembers(oldType.members, newType.members, "object", direction, where, out);
    return;
  }

  if (
    direction === "input" &&
    (newType.norm === "any" || newType.norm === "unknown")
  ) {
    out.push(
      issue(
        "relaxed",
        "info",
        "high",
        where,
        `${where} now accepts any value.`,
        oldType.text,
        newType.text,
      ),
    );
    return;
  }

  if (oldType.union || newType.union) {
    const oldUnion = oldType.union ?? [oldType.norm];
    const newUnion = newType.union ?? [newType.norm];
    const removed = oldUnion.filter((member) => !newUnion.includes(member));
    const added = newUnion.filter((member) => !oldUnion.includes(member));

    if (removed.length === 0 && added.length > 0) {
      if (direction === "input") {
        out.push(
          issue(
            "relaxed",
            "info",
            "high",
            where,
            `${where} now also accepts ${quoteList(added)}.`,
            oldType.text,
            newType.text,
          ),
        );
      } else {
        out.push(
          issue(
            kind,
            "medium",
            "medium",
            where,
            `${where} now also allows ${quoteList(added)}. Code that handles every case may need an update.`,
            oldType.text,
            newType.text,
          ),
        );
      }
      return;
    }

    if (added.length === 0 && removed.length > 0) {
      if (direction === "output") {
        out.push(
          issue(
            "relaxed",
            "info",
            "high",
            where,
            `${where} can no longer be ${quoteList(removed)}.`,
            oldType.text,
            newType.text,
          ),
        );
      } else {
        out.push(
          issue(
            kind,
            "high",
            "high",
            where,
            `${where} no longer allows ${quoteList(removed)}.`,
            oldType.text,
            newType.text,
          ),
        );
      }
      return;
    }

    out.push(
      issue(
        kind,
        "medium",
        "medium",
        where,
        `${where} changed: removed ${quoteList(removed)}, added ${quoteList(added)}.`,
        oldType.text,
        newType.text,
      ),
    );
    return;
  }

  out.push(
    issue(
      kind,
      "medium",
      "medium",
      where,
      `${where} changed from \`${oldType.text}\` to \`${newType.text}\`.`,
      oldType.text,
      newType.text,
    ),
  );
}

function compareTypeParams(
  oldParams: TypeParamModel[],
  newParams: TypeParamModel[],
  where: string,
  out: ChangeIssue[],
) {
  if (oldParams.length === 0 && newParams.length === 0) return;

  const label = joinPath(where, "type parameters");

  if (newParams.length > oldParams.length) {
    const extra = newParams.slice(oldParams.length);
    if (extra.some((param) => !param.hasDefault)) {
      out.push(
        issue(
          "type-params-changed",
          "high",
          "high",
          label,
          "A generic type parameter without a default was added, so existing uses no longer compile.",
          renderTypeParams(oldParams) || "(none)",
          renderTypeParams(newParams),
        ),
      );
    } else {
      out.push(
        issue(
          "relaxed",
          "info",
          "high",
          label,
          "A generic type parameter with a default was added.",
          renderTypeParams(oldParams) || "(none)",
          renderTypeParams(newParams),
        ),
      );
    }
  } else if (newParams.length < oldParams.length) {
    out.push(
      issue(
        "type-params-changed",
        "high",
        "high",
        label,
        "A generic type parameter was removed.",
        renderTypeParams(oldParams),
        renderTypeParams(newParams) || "(none)",
      ),
    );
  }

  for (let index = 0; index < Math.min(oldParams.length, newParams.length); index++) {
    if (
      normType(oldParams[index].constraint ?? "") !==
      normType(newParams[index].constraint ?? "")
    ) {
      out.push(
        issue(
          "type-params-changed",
          "medium",
          "medium",
          label,
          `The constraint on type parameter \`${newParams[index].name}\` changed.`,
          renderTypeParams(oldParams),
          renderTypeParams(newParams),
        ),
      );
    }
  }
}

function compareSignature(
  oldSignature: SignatureModel,
  newSignature: SignatureModel,
  where: string,
): ChangeIssue[] {
  const out: ChangeIssue[] = [];

  compareTypeParams(oldSignature.typeParams, newSignature.typeParams, where, out);

  if (
    oldSignature.async !== newSignature.async &&
    (!oldSignature.returns || !newSignature.returns)
  ) {
    out.push(
      issue(
        "async-changed",
        "high",
        "high",
        joinPath(where, "return type"),
        newSignature.async
          ? "The function became async, so it now returns a Promise."
          : "The function is no longer async, so it no longer returns a Promise.",
        oldSignature.async ? "async" : "sync",
        newSignature.async ? "async" : "sync",
      ),
    );
  }

  const count = Math.max(oldSignature.params.length, newSignature.params.length);

  for (let index = 0; index < count; index++) {
    const oldParam = oldSignature.params[index];
    const newParam = newSignature.params[index];
    const position = index + 1;

    if (oldParam && !newParam) {
      const restCovers = newSignature.params.some(
        (param, at) => param.rest && at <= index,
      );
      if (restCovers) continue;

      const optional = oldParam.optional || oldParam.defaulted || oldParam.rest;
      out.push(
        issue(
          "param-removed",
          optional ? "medium" : "high",
          "high",
          joinPath(where, `parameter ${position} "${oldParam.name}"`),
          `Parameter \`${oldParam.name}\` (position ${position}) was removed, so callers that pass it no longer compile.`,
          renderParam(oldParam),
          undefined,
        ),
      );
      continue;
    }

    if (!oldParam && newParam) {
      if (newParam.optional || newParam.defaulted || newParam.rest) {
        out.push(
          issue(
            "relaxed",
            "info",
            "high",
            joinPath(where, `parameter ${position} "${newParam.name}"`),
            `Optional parameter \`${newParam.name}\` was added.`,
            undefined,
            renderParam(newParam),
          ),
        );
      } else {
        out.push(
          issue(
            "param-added",
            "high",
            "high",
            joinPath(where, `parameter ${position} "${newParam.name}"`),
            `Required parameter \`${newParam.name}\` was added, so every existing call is now missing an argument.`,
            undefined,
            renderParam(newParam),
          ),
        );
      }
      continue;
    }

    if (!oldParam || !newParam) continue;

    const label = joinPath(where, `parameter ${position} "${newParam.name}"`);

    if (oldParam.rest !== newParam.rest) {
      out.push(
        issue(
          "param-type-changed",
          "medium",
          "medium",
          label,
          newParam.rest
            ? "The parameter became a rest parameter."
            : "The rest parameter became a single parameter.",
          renderParam(oldParam),
          renderParam(newParam),
        ),
      );
    }

    const oldOptional = oldParam.optional || oldParam.defaulted || oldParam.rest;
    const newOptional = newParam.optional || newParam.defaulted || newParam.rest;

    if (oldOptional && !newOptional) {
      out.push(
        issue(
          "param-optional-to-required",
          "high",
          "high",
          label,
          `Parameter \`${newParam.name}\` used to be optional and is now required.`,
          renderParam(oldParam),
          renderParam(newParam),
        ),
      );
    } else if (!oldOptional && newOptional) {
      out.push(
        issue(
          "relaxed",
          "info",
          "high",
          label,
          `Parameter \`${newParam.name}\` is now optional.`,
          renderParam(oldParam),
          renderParam(newParam),
        ),
      );
    }

    compareShape(
      oldParam.type,
      newParam.type,
      "input",
      label,
      "param-type-changed",
      out,
    );
  }

  compareShape(
    oldSignature.returns,
    newSignature.returns,
    "output",
    joinPath(where, "return type"),
    "return-type-changed",
    out,
  );

  return out;
}

function breakingWeight(issues: ChangeIssue[]): number {
  return issues.filter((item) => item.breaking).length;
}

function compareSignatureSets(
  oldSignatures: SignatureModel[],
  newSignatures: SignatureModel[],
  where: string,
  out: ChangeIssue[],
) {
  if (oldSignatures.length === 0 || newSignatures.length === 0) return;

  oldSignatures.forEach((oldSignature, index) => {
    const ordered = [
      newSignatures[index],
      ...newSignatures.filter((_, at) => at !== index),
    ].filter((signature): signature is SignatureModel => Boolean(signature));

    let best: ChangeIssue[] | undefined;

    for (const candidate of ordered) {
      const issues = compareSignature(oldSignature, candidate, where);
      if (!best || breakingWeight(issues) < breakingWeight(best)) best = issues;
      if (breakingWeight(issues) === 0) break;
    }

    if (best) out.push(...best);
  });

  if (newSignatures.length > oldSignatures.length) {
    out.push(
      issue(
        "added",
        "info",
        "high",
        where,
        "A new overload was added.",
        undefined,
        undefined,
      ),
    );
  }
}

const VISIBILITY_RANK: Record<Visibility, number> = {
  public: 0,
  protected: 1,
  private: 2,
};

function describeMember(member: MemberModel): string {
  if (member.kind === "method") return `Method \`${member.name}\``;
  if (member.kind === "constructor") return "The constructor";
  if (member.kind === "index") return `Index signature \`${member.name}\``;
  return `Property \`${member.name}\``;
}

function compareMember(
  oldMember: MemberModel,
  newMember: MemberModel,
  owner: Owner,
  direction: Direction,
  where: string,
  out: ChangeIssue[],
) {
  const label = where;

  if (
    oldMember.kind !== newMember.kind &&
    (oldMember.kind === "method" || newMember.kind === "method")
  ) {
    out.push(
      issue(
        "member-type-changed",
        "high",
        "high",
        label,
        `\`${newMember.name}\` changed from a ${oldMember.kind} to a ${newMember.kind}.`,
        renderMember(oldMember).join("\n"),
        renderMember(newMember).join("\n"),
      ),
    );
    return;
  }

  if (VISIBILITY_RANK[newMember.visibility] > VISIBILITY_RANK[oldMember.visibility]) {
    out.push(
      issue(
        "member-visibility-reduced",
        "high",
        "high",
        label,
        `\`${newMember.name}\` went from ${oldMember.visibility} to ${newMember.visibility}.`,
        oldMember.visibility,
        newMember.visibility,
      ),
    );
  }

  if (oldMember.abstract !== newMember.abstract) {
    out.push(
      newMember.abstract
        ? issue(
            "member-abstract-added",
            "high",
            "high",
            label,
            `\`${newMember.name}\` became abstract, so existing subclasses must implement it.`,
          )
        : issue("relaxed", "info", "high", label, `\`${newMember.name}\` is no longer abstract.`),
    );
  }

  if (!oldMember.optional && newMember.optional) {
    out.push(
      direction === "input"
        ? issue("relaxed", "info", "high", label, `\`${newMember.name}\` is now optional.`)
        : issue(
            "member-type-changed",
            "medium",
            "medium",
            label,
            `\`${newMember.name}\` is now optional, so code that reads it must handle undefined.`,
            renderMember(oldMember).join("\n"),
            renderMember(newMember).join("\n"),
          ),
    );
  } else if (oldMember.optional && !newMember.optional) {
    out.push(
      direction === "output"
        ? issue("relaxed", "info", "high", label, `\`${newMember.name}\` is now always present.`)
        : issue(
            "member-optional-to-required",
            "high",
            "high",
            label,
            `\`${newMember.name}\` used to be optional and is now required.`,
            renderMember(oldMember).join("\n"),
            renderMember(newMember).join("\n"),
          ),
    );
  }

  if (!oldMember.readonly && newMember.readonly && direction !== "output") {
    out.push(
      issue(
        "member-readonly-added",
        "medium",
        "high",
        label,
        `\`${newMember.name}\` became readonly, so code that assigns to it no longer compiles.`,
      ),
    );
  }

  if (oldMember.kind === "property" || oldMember.kind === "index") {
    compareShape(
      oldMember.type,
      newMember.type,
      direction,
      label,
      "member-type-changed",
      out,
    );
  } else {
    compareSignatureSets(
      oldMember.signatures,
      newMember.signatures,
      oldMember.kind === "constructor" ? "constructor" : `${oldMember.name}()`,
      out,
    );
  }

  void owner;
}

function compareMembers(
  oldMembers: Map<string, MemberModel>,
  newMembers: Map<string, MemberModel>,
  owner: Owner,
  direction: Direction,
  where: string,
  out: ChangeIssue[],
) {
  for (const [key, oldMember] of oldMembers) {
    const label = joinPath(where, oldMember.name);
    const newMember = newMembers.get(key);

    if (!newMember) {
      const optionalProperty = oldMember.optional && owner !== "class";
      out.push(
        issue(
          "member-removed",
          optionalProperty ? "medium" : "high",
          "high",
          label,
          `${describeMember(oldMember)} was removed.`,
          renderMember(oldMember).join("\n"),
          undefined,
        ),
      );
      continue;
    }

    compareMember(oldMember, newMember, owner, direction, label, out);
  }

  for (const [key, newMember] of newMembers) {
    if (oldMembers.has(key)) continue;

    const label = joinPath(where, newMember.name);

    if (owner === "class" && newMember.abstract) {
      out.push(
        issue(
          "member-abstract-added",
          "high",
          "high",
          label,
          `Abstract ${describeMember(newMember).toLowerCase()} was added, so existing subclasses must implement it.`,
          undefined,
          renderMember(newMember).join("\n"),
        ),
      );
    } else if (owner === "object" && !newMember.optional) {
      if (direction === "input") {
        out.push(
          issue(
            "member-added",
            "high",
            "high",
            label,
            `${describeMember(newMember)} is required, so every existing caller is now missing it.`,
            undefined,
            renderMember(newMember).join("\n"),
          ),
        );
      } else if (direction === "both") {
        out.push(
          issue(
            "member-added",
            "medium",
            "medium",
            label,
            `${describeMember(newMember)} is required, so code that builds or implements this type must add it.`,
            undefined,
            renderMember(newMember).join("\n"),
          ),
        );
      } else {
        out.push(
          issue(
            "added",
            "info",
            "high",
            label,
            `${describeMember(newMember)} was added.`,
            undefined,
            renderMember(newMember).join("\n"),
          ),
        );
      }
    } else {
      out.push(
        issue(
          "added",
          "info",
          "high",
          label,
          `${describeMember(newMember)} was added.`,
          undefined,
          renderMember(newMember).join("\n"),
        ),
      );
    }
  }
}

function compareHeritage(
  base: SymbolModel,
  head: SymbolModel,
  out: ChangeIssue[],
) {
  for (const parent of base.heritage.extends) {
    if (
      !head.heritage.extends.some((item) => normType(item) === normType(parent))
    ) {
      out.push(
        issue(
          "heritage-changed",
          "medium",
          "medium",
          "extends",
          `No longer extends \`${parent}\`, so inherited members may disappear.`,
          base.heritage.extends.join(", ") || "(none)",
          head.heritage.extends.join(", ") || "(none)",
        ),
      );
    }
  }

  if (base.kind === "interface") {
    for (const parent of head.heritage.extends) {
      if (
        !base.heritage.extends.some((item) => normType(item) === normType(parent))
      ) {
        out.push(
          issue(
            "heritage-changed",
            "low",
            "medium",
            "extends",
            `Now extends \`${parent}\`, so implementers must provide its members.`,
            base.heritage.extends.join(", ") || "(none)",
            head.heritage.extends.join(", "),
          ),
        );
      }
    }
  }
}

function compareSymbols(base: SymbolModel, head: SymbolModel): ChangeIssue[] {
  const out: ChangeIssue[] = [];

  if (base.kind !== head.kind) {
    const baseObject =
      base.kind === "interface" ? base.members : base.type?.members;
    const headObject =
      head.kind === "interface" ? head.members : head.type?.members;
    const interchangeable =
      (base.kind === "interface" || base.kind === "type") &&
      (head.kind === "interface" || head.kind === "type") &&
      baseObject &&
      headObject;

    if (interchangeable) {
      compareMembers(baseObject, headObject, "object", "both", "", out);
      return out;
    }

    out.push(
      issue(
        "kind-changed",
        "high",
        "high",
        "declaration",
        `Changed from ${KIND_LABEL[base.kind]} to ${KIND_LABEL[head.kind]}.`,
        KIND_LABEL[base.kind],
        KIND_LABEL[head.kind],
      ),
    );
    return out;
  }

  switch (base.kind) {
    case "function":
      compareTypeParams(base.typeParams, head.typeParams, "", out);
      compareSignatureSets(base.signatures, head.signatures, "", out);
      break;

    case "variable":
      compareShape(base.type, head.type, "both", "type", "type-changed", out);
      break;

    case "class":
      compareTypeParams(base.typeParams, head.typeParams, "", out);
      compareHeritage(base, head, out);

      if (!base.abstract && head.abstract) {
        out.push(
          issue(
            "kind-changed",
            "high",
            "high",
            "declaration",
            "The class became abstract, so it can no longer be instantiated directly.",
            "class",
            "abstract class",
          ),
        );
      }

      compareMembers(base.members, head.members, "class", "both", "", out);
      break;

    case "interface":
      compareTypeParams(base.typeParams, head.typeParams, "", out);
      compareHeritage(base, head, out);
      compareMembers(base.members, head.members, "object", "both", "", out);
      break;

    case "type":
      compareTypeParams(base.typeParams, head.typeParams, "", out);
      compareShape(base.type, head.type, "both", "type", "type-changed", out);
      break;

    case "enum": {
      const headMembers = new Map(
        head.enumMembers.map((member) => [member.name, member]),
      );

      for (const member of base.enumMembers) {
        const next = headMembers.get(member.name);

        if (!next) {
          out.push(
            issue(
              "enum-member-removed",
              "high",
              "high",
              `member ${member.name}`,
              `Enum member \`${member.name}\` was removed.`,
              `${member.name}${member.value !== undefined ? ` = ${member.value}` : ""}`,
              undefined,
            ),
          );
        } else if (
          member.value !== undefined &&
          next.value !== undefined &&
          member.value !== next.value
        ) {
          out.push(
            issue(
              "enum-value-changed",
              "high",
              "high",
              `member ${member.name}`,
              `The value of \`${member.name}\` changed, so stored or serialized values no longer match.`,
              `${member.name} = ${member.value}`,
              `${member.name} = ${next.value}`,
            ),
          );
        }
      }

      const baseNames = new Set(base.enumMembers.map((member) => member.name));
      for (const member of head.enumMembers) {
        if (!baseNames.has(member.name)) {
          out.push(
            issue(
              "added",
              "info",
              "high",
              `member ${member.name}`,
              `Enum member \`${member.name}\` was added.`,
              undefined,
              member.name,
            ),
          );
        }
      }

      if (base.constEnum !== head.constEnum) {
        out.push(
          issue(
            "kind-changed",
            "medium",
            "medium",
            "declaration",
            head.constEnum
              ? "The enum became a const enum, so it no longer exists at runtime."
              : "The const enum became a regular enum.",
          ),
        );
      }
      break;
    }

    case "namespace":
      compareMembers(base.members, head.members, "class", "both", "", out);
      break;

    case "reexport":
      break;
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/*  Diffing two snapshots                                                     */
/* -------------------------------------------------------------------------- */

function diffExports(base: Snapshot, head: Snapshot): Candidate[] {
  const candidates: Candidate[] = [];
  const removed: SymbolModel[] = [];
  const added: SymbolModel[] = [];
  const consumedHead = new Set<string>();

  for (const [key, baseSymbol] of base.symbols) {
    const headSymbol = head.symbols.get(key);

    if (!headSymbol) {
      removed.push(baseSymbol);
      continue;
    }

    if (baseSymbol.kind === "reexport" && headSymbol.kind === "reexport") continue;

    let from = baseSymbol;
    let to = headSymbol;
    let relocated: SymbolModel | undefined;

    if (headSymbol.kind === "reexport") {
      const target = resolveConcrete(head, headSymbol);
      if (!target) continue;
      to = target;
      relocated = target;
      consumedHead.add(target.key);
    } else if (baseSymbol.kind === "reexport") {
      const target = resolveConcrete(base, baseSymbol);
      if (!target) continue;
      from = target;
    }

    const issues = compareSymbols(from, to);

    if (relocated) {
      issues.push(
        issue(
          "added",
          "info",
          "high",
          "location",
          `Now defined in ${relocated.filePath} and re-exported from ${headSymbol.filePath}, so existing imports keep working.`,
        ),
      );
    }

    if (issues.length > 0) {
      candidates.push({
        surface: "export",
        category: categorize(issues),
        base: baseSymbol,
        head: headSymbol,
        issues,
      });
    }
  }

  for (const [key, headSymbol] of head.symbols) {
    if (!base.symbols.has(key) && !consumedHead.has(key)) added.push(headSymbol);
  }

  const addedByShape = new Map<string, SymbolModel[]>();
  const addedByName = new Map<string, SymbolModel[]>();

  for (const symbol of added) {
    if (symbol.kind === "reexport") continue;

    const shape = addedByShape.get(symbol.shape) ?? [];
    shape.push(symbol);
    addedByShape.set(symbol.shape, shape);

    const named = addedByName.get(symbol.name) ?? [];
    named.push(symbol);
    addedByName.set(symbol.name, named);
  }

  const used = new Set<string>();

  for (const symbol of removed) {
    const fileRemoved = !head.files.has(symbol.filePath);

    if (symbol.kind !== "reexport") {
      const renamedTo = (addedByShape.get(symbol.shape) ?? []).filter(
        (item) => item.filePath === symbol.filePath && !used.has(item.key),
      );

      if (renamedTo.length === 1 && symbol.name !== renamedTo[0].name) {
        const target = renamedTo[0];
        used.add(target.key);

        candidates.push({
          surface: "export",
          category: "renamed",
          base: symbol,
          head: target,
          issues: [
            issue(
              "renamed",
              "critical",
              "high",
              "name",
              `\`${symbol.name}\` was renamed to \`${target.name}\`, so existing imports of the old name fail.`,
              symbol.name,
              target.name,
            ),
          ],
        });
        continue;
      }

      const movedTo = (addedByName.get(symbol.name) ?? []).filter(
        (item) =>
          item.kind === symbol.kind &&
          item.filePath !== symbol.filePath &&
          !used.has(item.key),
      );

      if (movedTo.length === 1) {
        const target = movedTo[0];
        used.add(target.key);

        candidates.push({
          surface: "export",
          category: "moved",
          base: symbol,
          head: target,
          issues: [
            issue(
              "moved",
              "high",
              "high",
              "location",
              `\`${symbol.name}\` moved from ${symbol.filePath} to ${target.filePath}, so imports of the old path fail.`,
              symbol.filePath,
              target.filePath,
            ),
            ...compareSymbols(symbol, target),
          ],
        });
        continue;
      }
    }

    candidates.push({
      surface: "export",
      category: "removed",
      base: symbol,
      issues: [
        issue(
          "removed",
          "critical",
          "high",
          "declaration",
          fileRemoved
            ? `\`${symbol.name}\` is gone because ${symbol.filePath} was deleted.`
            : `\`${symbol.name}\` is no longer exported from ${symbol.filePath}.`,
          symbol.rendered,
          undefined,
        ),
      ],
      fileRemoved,
    });
  }

  for (const symbol of added) {
    if (used.has(symbol.key) || symbol.kind === "reexport") continue;

    candidates.push({
      surface: "export",
      category: "compatible",
      head: symbol,
      issues: [
        issue(
          "added",
          "info",
          "high",
          "declaration",
          `New ${KIND_LABEL[symbol.kind]} \`${symbol.name}\` is exported from ${symbol.filePath}.`,
          undefined,
          symbol.rendered,
        ),
      ],
    });
  }

  return candidates;
}

function categorize(issues: ChangeIssue[]): ChangeCategory {
  const breaking = issues.filter((item) => item.breaking);
  if (breaking.length === 0) return "compatible";

  const kinds = new Set(breaking.map((item) => item.kind));

  if (
    kinds.has("param-removed") ||
    kinds.has("param-added") ||
    kinds.has("param-optional-to-required") ||
    kinds.has("param-type-changed") ||
    kinds.has("return-type-changed") ||
    kinds.has("async-changed")
  ) {
    return "signature";
  }

  if (kinds.has("enum-member-removed") || kinds.has("enum-value-changed")) {
    return "enum";
  }

  if (
    kinds.has("member-removed") ||
    kinds.has("member-added") ||
    kinds.has("member-optional-to-required") ||
    kinds.has("member-type-changed") ||
    kinds.has("member-readonly-added") ||
    kinds.has("member-visibility-reduced") ||
    kinds.has("member-abstract-added")
  ) {
    return "members";
  }

  return "type";
}

function diffRoutes(base: Snapshot, head: Snapshot): Candidate[] {
  const candidates: Candidate[] = [];
  const removed: RouteModel[] = [];
  const added: RouteModel[] = [];

  for (const [key, baseRoute] of base.routes) {
    const headRoute = head.routes.get(key);

    if (!headRoute) {
      removed.push(baseRoute);
      continue;
    }

    const issues: ChangeIssue[] = [];

    const baseAuth = baseRoute.middleware.filter((name) => AUTH_NAME_PATTERN.test(name));
    const headAuth = headRoute.middleware.filter((name) => AUTH_NAME_PATTERN.test(name));
    const newAuth = headAuth.filter((name) => !baseAuth.includes(name));

    if (newAuth.length > 0) {
      issues.push(
        issue(
          "auth-added",
          "high",
          "medium",
          "middleware",
          `${quoteList(newAuth)} now guards this route, so unauthenticated clients may be rejected.`,
          baseRoute.middleware.join(", ") || "(none)",
          headRoute.middleware.join(", "),
        ),
      );
    }

    for (const [fieldKey, field] of headRoute.requestFields) {
      const previous = baseRoute.requestFields.get(fieldKey);
      const where = `${field.source}.${field.name}`;

      if (!previous) {
        if (field.validated && !field.defaulted) {
          issues.push(
            issue(
              "request-field-required",
              "high",
              "medium",
              where,
              `The ${field.source} field \`${field.name}\` is new and the handler rejects requests without it.`,
              undefined,
              `${where}: required`,
            ),
          );
        } else {
          issues.push(
            issue(
              "added",
              "info",
              "medium",
              where,
              `The ${field.source} field \`${field.name}\` is new and optional.`,
              undefined,
              `${where}: ${fieldLabel(field)}`,
            ),
          );
        }
      } else if (
        field.validated &&
        !field.defaulted &&
        !(previous.validated && !previous.defaulted)
      ) {
        issues.push(
          issue(
            "request-field-required",
            "medium",
            "low",
            where,
            `The ${field.source} field \`${field.name}\` used to be optional and is now validated as required.`,
            `${where}: ${fieldLabel(previous)}`,
            `${where}: ${fieldLabel(field)}`,
          ),
        );
      }
    }

    for (const [fieldKey, field] of baseRoute.requestFields) {
      if (!headRoute.requestFields.has(fieldKey)) {
        issues.push(
          issue(
            "relaxed",
            "info",
            "low",
            `${field.source}.${field.name}`,
            `The ${field.source} field \`${field.name}\` is no longer read; clients that send it are unaffected.`,
            `${field.source}.${field.name}: ${fieldLabel(field)}`,
          ),
        );
      }
    }

    for (const name of baseRoute.responseFields) {
      if (!headRoute.responseFields.has(name)) {
        issues.push(
          issue(
            "response-field-removed",
            "high",
            "medium",
            `response.${name}`,
            `The response no longer includes \`${name}\`, so clients that read it get undefined.`,
            `response.${name}`,
          ),
        );
      }
    }

    for (const name of headRoute.responseFields) {
      if (!baseRoute.responseFields.has(name)) {
        issues.push(
          issue(
            "added",
            "info",
            "medium",
            `response.${name}`,
            `The response now includes \`${name}\`.`,
            undefined,
            `response.${name}`,
          ),
        );
      }
    }

    if (issues.length > 0) {
      candidates.push({
        surface: "route",
        category: issues.some((item) => item.breaking) ? "route" : "compatible",
        baseRoute,
        headRoute,
        issues,
      });
    }
  }

  for (const [key, headRoute] of head.routes) {
    if (!base.routes.has(key)) added.push(headRoute);
  }

  const used = new Set<string>();

  for (const route of removed) {
    const sameResource = added.filter(
      (item) =>
        item.normPath === route.normPath &&
        item.method !== route.method &&
        !used.has(item.key),
    );

    if (sameResource.length === 1) {
      const target = sameResource[0];
      used.add(target.key);

      candidates.push({
        surface: "route",
        category: "route",
        baseRoute: route,
        headRoute: target,
        issues: [
          issue(
            "route-method-changed",
            "critical",
            "medium",
            "method",
            `${route.path} used to answer ${route.method} and now answers ${target.method}, so existing clients get 404 or 405.`,
            route.method,
            target.method,
          ),
        ],
      });
      continue;
    }

    candidates.push({
      surface: "route",
      category: "route",
      baseRoute: route,
      issues: [
        issue(
          "route-removed",
          "critical",
          "high",
          "route",
          `${route.method} ${route.path} is no longer served, so existing clients get 404.`,
          route.rendered,
          undefined,
        ),
      ],
    });
  }

  for (const route of added) {
    if (used.has(route.key)) continue;

    candidates.push({
      surface: "route",
      category: "compatible",
      headRoute: route,
      issues: [
        issue(
          "added",
          "info",
          "high",
          "route",
          `New route ${route.method} ${route.path}.`,
          undefined,
          route.rendered,
        ),
      ],
    });
  }

  return candidates;
}

/* -------------------------------------------------------------------------- */
/*  Severity                                                                  */
/* -------------------------------------------------------------------------- */

function shiftSeverity(severity: ChangeSeverity, steps: number): ChangeSeverity {
  if (severity === "info") return "info";
  const rank = Math.min(severityRank(severity) + steps, severityRank("low"));
  return SEVERITY_ORDER[Math.max(0, rank)];
}

const REMOVAL_KINDS = new Set<IssueKind>(["removed", "renamed", "moved"]);

function adjustSeverity(
  item: ChangeIssue,
  exposure: Exposure,
  consumerCount: number,
  stillReferenced: boolean,
  deprecated: boolean,
): ChangeSeverity {
  if (!item.breaking) return "info";

  let severity = item.severity;

  if (exposure === "module") {
    if (REMOVAL_KINDS.has(item.kind)) {
      // Importers inside the project that still use the old name fail right now.
      severity = stillReferenced ? "critical" : shiftSeverity(severity, 2);
    } else if (consumerCount === 0) {
      severity = shiftSeverity(severity, 1);
    }
  }

  if (deprecated && REMOVAL_KINDS.has(item.kind)) {
    severity = shiftSeverity(severity, 1);
  }

  return severity;
}

/* -------------------------------------------------------------------------- */
/*  Migration suggestions                                                     */
/* -------------------------------------------------------------------------- */

function makeOptional(line: string): string {
  return line.replace(/^(\.\.\.)?(readonly\s+)?([^?:\s]+)(\?)?:/, "$1$2$3?:");
}

function relativeImport(fromFile: string, toFile: string): string {
  let relative = path.posix.relative(path.posix.dirname(fromFile), toFile);
  relative = relative.replace(/\.[cm]?tsx?$/, ".js");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function deprecatedStub(symbol: SymbolModel): string {
  const tag = "/** @deprecated Will be removed in the next major version. */";

  if (symbol.kind === "function" && symbol.signatures.length === 1) {
    return `${tag}\nexport ${symbol.rendered} {\n  // forward to the replacement\n}`;
  }

  if (symbol.kind === "variable") {
    return `${tag}\nexport ${symbol.rendered} = /* previous value */;`;
  }

  return `${tag}\nexport ${symbol.rendered}`;
}

function aliasExample(base: SymbolModel, head: SymbolModel): string {
  const tag = `/** @deprecated Use \`${head.name}\` instead. */`;

  if (base.kind === "interface" || base.kind === "type") {
    return `${tag}\nexport type ${base.name} = ${head.name};`;
  }

  if (base.kind === "class" || base.kind === "enum") {
    return `${tag}\nexport const ${base.name} = ${head.name};\nexport type ${base.name} = ${head.name};`;
  }

  return `${tag}\nexport const ${base.name} = ${head.name};`;
}

function buildSuggestion(
  candidate: Candidate,
  primary: ChangeIssue | undefined,
  info: {
    exposure: Exposure;
    consumerCount: number;
    deprecated: boolean;
    name: string;
    file: string;
  },
): ChangeSuggestion {
  const caveats: string[] = [];

  if (info.exposure === "module" && info.consumerCount === 0) {
    caveats.push(
      "No other file in the project imports this symbol. If the project is never published, this change may be safe.",
    );
  }

  if (info.deprecated) {
    caveats.push("It was already marked @deprecated, so this removal was announced.");
  }

  if (candidate.surface === "route") {
    caveats.push(
      "Route analysis is static: fields read through helper functions or validation libraries are not seen.",
    );
  }

  if (!primary || !primary.breaking) {
    return {
      strategy: "no-action",
      confidence: "high",
      title: "No migration needed",
      summary:
        "This change is backward compatible. Existing consumers keep working, so it only needs a minor version bump.",
      steps: ["Mention it in the changelog so consumers can discover it."],
      caveats: [],
    };
  }

  const confidence = primary.confidence;
  const base = candidate.base;
  const head = candidate.head;
  const baseRoute = candidate.baseRoute;
  const headRoute = candidate.headRoute;

  switch (primary.kind) {
    case "removed":
      return {
        strategy: "restore-export",
        confidence,
        title: "Keep the export through a deprecation period",
        summary: `Restore \`${info.name}\` and mark it @deprecated so importers keep working while they migrate.`,
        steps: [
          `Add \`${info.name}\` back to ${info.file}.`,
          "Tag it @deprecated and name its replacement.",
          "Delete it in the next major release and list it in the changelog.",
        ],
        codeExample: base ? deprecatedStub(base) : undefined,
        caveats,
      };

    case "renamed":
      return {
        strategy: "deprecated-alias",
        confidence,
        title: "Keep the old name as a deprecated alias",
        summary: `Export \`${base?.name}\` as an alias of \`${head?.name}\` so existing imports keep working.`,
        steps: [
          "Add the alias next to the new declaration.",
          "Tag the alias @deprecated and point to the new name.",
          "Remove the alias in the next major release.",
        ],
        codeExample: base && head ? aliasExample(base, head) : undefined,
        caveats,
      };

    case "moved":
      return {
        strategy: "re-export",
        confidence,
        title: "Re-export from the old location",
        summary: `Leave a re-export in ${base?.filePath} so imports of the old path keep resolving.`,
        steps: [
          `Add a re-export of \`${info.name}\` to ${base?.filePath}.`,
          "Update internal imports to the new path.",
          "Remove the re-export in the next major release.",
        ],
        codeExample:
          base && head
            ? `/** @deprecated Import from "${relativeImport(base.filePath, head.filePath)}" instead. */\nexport { ${info.name} } from "${relativeImport(base.filePath, head.filePath)}";`
            : undefined,
        caveats: [
          ...caveats,
          "Match the import style your project uses (with or without a file extension).",
        ],
      };

    case "param-added":
    case "param-optional-to-required":
      return {
        strategy: "optional-parameter",
        confidence,
        title: "Make the parameter optional",
        summary:
          "Give the parameter a default (or make it optional) so every existing call keeps compiling.",
        steps: [
          "Mark the parameter optional or give it a default value.",
          "Handle the missing value inside the function.",
          "Make it required only in the next major version.",
        ],
        codeExample: primary.after
          ? `// Existing calls keep working\n${makeOptional(primary.after)}`
          : undefined,
        caveats,
      };

    case "param-removed":
      return {
        strategy: "keep-parameter",
        confidence,
        title: "Keep accepting the old parameter",
        summary:
          "Leave the parameter in the signature, optional and ignored, so existing callers still compile.",
        steps: [
          "Put the parameter back as optional.",
          "Ignore its value and tag it @deprecated.",
          "Remove it in the next major release.",
        ],
        codeExample: primary.before
          ? `// Still accepted, but no longer used\n${makeOptional(primary.before)}`
          : undefined,
        caveats,
      };

    case "param-type-changed":
    case "return-type-changed":
    case "async-changed":
    case "type-changed":
    case "member-type-changed":
    case "type-params-changed":
      return {
        strategy: "widen-type",
        confidence,
        title: "Accept both the old and the new shape",
        summary:
          "Widen the type to a union, or add an overload, so existing code keeps compiling next to the new form.",
        steps: [
          "Widen the type to cover the old and the new shape, or add an overload.",
          "Mark the old form @deprecated.",
          "Narrow it again in the next major version.",
        ],
        codeExample:
          primary.before && primary.after && !primary.before.includes("\n")
            ? `// Old and new values both fit\n${primary.before} | ${primary.after}`
            : undefined,
        caveats,
      };

    case "member-removed":
      return {
        strategy: "keep-member",
        confidence,
        title: "Keep the member, deprecated",
        summary: "Keep the member (optional if needed) and mark it @deprecated until the next major version.",
        steps: [
          "Add the member back.",
          "Tag it @deprecated and name its replacement.",
          "Delete it in the next major release.",
        ],
        codeExample: primary.before
          ? `/** @deprecated */\n${makeOptional(primary.before.split("\n")[0])}`
          : undefined,
        caveats,
      };

    case "member-added":
    case "member-optional-to-required":
    case "member-readonly-added":
    case "member-visibility-reduced":
    case "member-abstract-added":
      return {
        strategy: "keep-member",
        confidence,
        title: "Keep the member backward compatible",
        summary:
          "Make new members optional (or give classes a default implementation) so existing implementers and callers keep working.",
        steps: [
          "Mark the member optional, or provide a default implementation.",
          "Keep previous visibility and mutability.",
          "Tighten it in the next major version.",
        ],
        codeExample: primary.after
          ? `// Optional, so existing code still compiles\n${makeOptional(primary.after.split("\n")[0])}`
          : undefined,
        caveats,
      };

    case "enum-member-removed":
    case "enum-value-changed":
      return {
        strategy: "keep-enum-member",
        confidence,
        title: "Keep the enum member and its value",
        summary:
          "Keep the member with its original value and mark it @deprecated so stored values still map correctly.",
        steps: [
          "Restore the member with its previous value.",
          "Tag it @deprecated.",
          "Remove it in the next major release, with a data migration if it was persisted.",
        ],
        codeExample: primary.before
          ? `/** @deprecated */\n${primary.before},`
          : undefined,
        caveats,
      };

    case "route-removed":
      return {
        strategy: "keep-route",
        confidence,
        title: "Keep the old route answering",
        summary:
          "Keep serving the old path, or redirect it with a 308 that preserves the method and body, until clients migrate.",
        steps: [
          "Re-register the old path.",
          "Redirect it to its replacement, or route it to the same handler.",
          "Remove it in the next major version or behind a new API version.",
        ],
        codeExample: baseRoute
          ? `app.${baseRoute.method.toLowerCase()}("${baseRoute.path}", (req, res) => {\n  // 308 keeps the method and body, so clients can follow it unchanged\n  res.redirect(308, "/replacement/path");\n});`
          : undefined,
        caveats,
      };

    case "route-method-changed":
      return {
        strategy: "keep-route",
        confidence,
        title: "Answer both methods",
        summary: "Register the old method on the same handler while clients move to the new one.",
        steps: [
          "Register the old method again.",
          "Point both methods at the same handler.",
          "Remove the old method in the next major version.",
        ],
        codeExample:
          baseRoute && headRoute
            ? `app.${baseRoute.method.toLowerCase()}("${baseRoute.path}", handler);\napp.${headRoute.method.toLowerCase()}("${headRoute.path}", handler);`
            : undefined,
        caveats,
      };

    case "request-field-required":
      return {
        strategy: "optional-field",
        confidence,
        title: "Make the new field optional",
        summary:
          "Give the field a default instead of rejecting requests that omit it, so existing clients keep working.",
        steps: [
          "Replace the validation error with a default value.",
          "Document the field as optional.",
          "Require it only in a new API version, for example /api/v2.",
        ],
        codeExample: `const { ${primary.path.split(".").pop()} = /* default value */ } = req.body ?? {};`,
        caveats,
      };

    case "response-field-removed":
      return {
        strategy: "keep-response-field",
        confidence,
        title: "Keep returning the field",
        summary:
          "Keep the field in the response, marked deprecated in your docs, until the next major version.",
        steps: [
          "Return the field again with its previous value.",
          "Note the deprecation in the API documentation.",
          "Remove it in the next major version.",
        ],
        codeExample: `res.json({\n  // ...current fields\n  ${primary.path.replace(/^response\./, "")}: /* previous value */,\n});`,
        caveats,
      };

    default:
      return {
        strategy: "bump-major",
        confidence,
        title: "Plan this as a major release",
        summary:
          "There is no drop-in compatibility shim for this change. Release it in the next major version and document the migration.",
        steps: [
          "Bump the major version.",
          "Describe the old and new behaviour in the changelog.",
          "Offer a codemod or a short migration guide if many callers are affected.",
        ],
        caveats,
      };
  }
}

/* -------------------------------------------------------------------------- */
/*  Turning candidates into reported changes                                  */
/* -------------------------------------------------------------------------- */

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function buildChange(
  candidate: Candidate,
  base: Snapshot,
  head: Snapshot,
): ApiChange {
  const isRoute = candidate.surface === "route";
  const baseSymbol = candidate.base;
  const headSymbol = candidate.head;
  const baseRoute = candidate.baseRoute;
  const headRoute = candidate.headRoute;

  const removalLike =
    candidate.category === "removed" ||
    candidate.category === "renamed" ||
    candidate.category === "moved";

  let exposure: Exposure = "route";
  let consumers: string[] = [];
  let stillReferenced = false;

  if (!isRoute) {
    const isPublic =
      (baseSymbol ? base.publicKeys.has(baseSymbol.key) : false) ||
      (headSymbol ? head.publicKeys.has(headSymbol.key) : false);

    exposure = isPublic ? "entry" : "module";

    if (removalLike && baseSymbol) {
      consumers = consumersOf(base, baseSymbol.key);
      stillReferenced = consumersOf(head, baseSymbol.key).length > 0;
    } else if (headSymbol) {
      consumers = consumersOf(head, headSymbol.key);
    }
  }

  const deprecated = Boolean(baseSymbol?.deprecated);

  const issues = candidate.issues
    .slice(0, MAX_ISSUES_PER_CHANGE)
    .map((item) => {
      const severity = adjustSeverity(
        item,
        exposure,
        consumers.length,
        stillReferenced,
        deprecated,
      );
      return { ...item, severity, breaking: severity !== "info" };
    })
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  const breakingIssues = issues.filter((item) => item.breaking);
  const severity: ChangeSeverity = issues[0]?.severity ?? "info";
  const breaking = breakingIssues.length > 0;

  const symbolKind = isRoute
    ? "route"
    : KIND_LABEL[(headSymbol ?? baseSymbol)!.kind];

  const name = isRoute
    ? `${(headRoute ?? baseRoute)!.method} ${(headRoute ?? baseRoute)!.path}`
    : (headSymbol ?? baseSymbol)!.name;

  const filePath = isRoute
    ? (headRoute ?? baseRoute)!.filePath
    : removalLike && baseSymbol
      ? baseSymbol.filePath
      : (headSymbol ?? baseSymbol)!.filePath;

  const primary = breakingIssues[0] ?? issues[0];
  const onlyAdded = candidate.category === "compatible" && !baseSymbol && !baseRoute;

  let title: string;
  switch (candidate.category) {
    case "removed":
      title = isRoute ? `Removed route ${name}` : `Removed ${symbolKind} ${name}`;
      break;
    case "renamed":
      title = `${baseSymbol?.name} renamed to ${headSymbol?.name}`;
      break;
    case "moved":
      title = `${name} moved to ${headSymbol?.filePath}`;
      break;
    default:
      if (onlyAdded) {
        title = isRoute ? `New route ${name}` : `New ${symbolKind} ${name}`;
      } else if (isRoute && primary?.kind === "route-method-changed") {
        title = `${baseRoute?.path}: ${baseRoute?.method} → ${headRoute?.method}`;
      } else if (breaking) {
        title = `${isRoute ? "Route" : capitalize(symbolKind)} ${name} · ${plural(
          breakingIssues.length,
          "breaking change",
        )}`;
      } else {
        title = `${isRoute ? "Route" : capitalize(symbolKind)} ${name} · compatible change`;
      }
  }

  const consumerSentence =
    consumers.length > 0
      ? removalLike
        ? ` ${plural(consumers.length, "file")} imported it in the baseline: ${consumers
            .slice(0, 3)
            .join(", ")}${consumers.length > 3 ? ", …" : ""}.`
        : ` ${plural(consumers.length, "file")} import${consumers.length === 1 ? "s" : ""} it: ${consumers
            .slice(0, 3)
            .join(", ")}${consumers.length > 3 ? ", …" : ""}.`
      : "";

  const stillSentence = stillReferenced
    ? " Files in the current version still import the old name, so they fail right now."
    : "";

  const extraIssues = breakingIssues.length - 1;
  const description = `${primary?.message ?? title}${
    extraIssues > 0 ? ` Plus ${plural(extraIssues, "more breaking change")}.` : ""
  }${consumerSentence}${stillSentence}`;

  const suggestion = buildSuggestion(candidate, breaking ? breakingIssues[0] : undefined, {
    exposure,
    consumerCount: consumers.length,
    deprecated,
    name,
    file: filePath,
  });

  const id = createHash("sha1")
    .update(
      `${candidate.surface}|${baseSymbol?.key ?? baseRoute?.key ?? ""}|${
        headSymbol?.key ?? headRoute?.key ?? ""
      }|${issues.map((item) => item.kind).join(",")}`,
    )
    .digest("hex")
    .slice(0, 10);

  return {
    id,
    surface: candidate.surface,
    category: candidate.category,
    severity,
    breaking,
    exposure,
    symbolKind,
    name,
    filePath,
    baselineFilePath: (baseSymbol ?? baseRoute)?.filePath,
    headFilePath: (headSymbol ?? headRoute)?.filePath,
    baselineLine: (baseSymbol ?? baseRoute)?.line,
    headLine: (headSymbol ?? headRoute)?.line,
    title,
    description,
    issues,
    before: baseSymbol?.rendered ?? baseRoute?.rendered,
    after: headSymbol?.rendered ?? headRoute?.rendered,
    deprecatedInBaseline: deprecated,
    consumers: {
      count: consumers.length,
      files: consumers.slice(0, MAX_CONSUMERS),
      hidden: Math.max(0, consumers.length - MAX_CONSUMERS),
    },
    stillReferenced,
    suggestion,
  };
}

/* -------------------------------------------------------------------------- */
/*  Main analysis                                                             */
/* -------------------------------------------------------------------------- */

async function ensureGitRepository(root: string): Promise<void> {
  try {
    await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";

    if (/ENOENT/.test(message)) {
      throw new Error("Git is not installed or is not on the PATH.");
    }

    throw new Error(
      "The project is not inside a git repository. Pass baselinePath to compare against another folder instead.",
    );
  }
}

export async function detectBreakingApiChanges(
  projectPath: string,
  options: {
    baseRef?: string;
    headRef?: string;
    baselinePath?: string;
    filePath?: string;
    scope?: AnalysisScope;
    entryFiles?: string[];
    includeNonBreaking?: boolean;
    includeTests?: boolean;
  } = {},
): Promise<BreakingApiReport> {
  const scope = options.scope ?? "all";
  const includeNonBreaking = options.includeNonBreaking ?? false;
  const includeTests = options.includeTests ?? false;
  const filePath = options.filePath;

  if (!["all", "exports", "routes"].includes(scope)) {
    throw new Error("scope must be one of all, exports, or routes.");
  }

  if (
    filePath !== undefined &&
    (path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes(".."))
  ) {
    throw new Error("filePath must be relative to projectPath.");
  }

  for (const entry of options.entryFiles ?? []) {
    if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) {
      throw new Error("entryFiles must be relative to projectPath.");
    }
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

  let baselineSet: SourceSet;
  let headSet: SourceSet;

  if (options.baselinePath !== undefined && options.baselinePath.trim()) {
    if (options.baseRef || options.headRef) {
      throw new Error("Use either baselinePath or baseRef/headRef, not both.");
    }

    const resolvedBaseline = await resolveProjectPath(options.baselinePath);
    const baselineRoot = fs.realpathSync(resolvedBaseline.projectPath);

    if (baselineRoot === root) {
      throw new Error("baselinePath must be a different folder than projectPath.");
    }

    baselineSet = loadDiskSources(
      baselineRoot,
      { kind: "path", label: path.basename(baselineRoot) || baselineRoot },
      includeTests,
      warn,
    );
    headSet = loadDiskSources(
      root,
      { kind: "working-tree", label: "working tree" },
      includeTests,
      warn,
    );
  } else {
    await ensureGitRepository(root);

    const baseRef = validateRef(options.baseRef ?? "HEAD", "baseRef");
    baselineSet = await loadGitSources(root, baseRef, includeTests, warn);

    headSet = options.headRef
      ? await loadGitSources(
          root,
          validateRef(options.headRef, "headRef"),
          includeTests,
          warn,
        )
      : loadDiskSources(
          root,
          { kind: "working-tree", label: "working tree" },
          includeTests,
          warn,
        );
  }

  if (baselineSet.files.length === 0) {
    throw new Error(
      `No JavaScript or TypeScript files were found in the baseline (${baselineSet.side.label}).`,
    );
  }

  if (headSet.files.length === 0) {
    throw new Error(
      `No JavaScript or TypeScript files were found in the current version (${headSet.side.label}).`,
    );
  }

  for (const set of [baselineSet, headSet]) {
    if (set.truncated) {
      warn(
        `Only the first ${MAX_FILES} source files of ${set.side.label} were analyzed. Narrow the project path for complete results.`,
      );
    }
  }

  const baseSnapshot = buildSnapshot(baselineSet, scope, options.entryFiles, warn);
  const headSnapshot = buildSnapshot(headSet, scope, options.entryFiles, warn);

  /* ---- Notes ---- */

  const publicEntryDetected =
    headSnapshot.entryFiles.length > 0 || baseSnapshot.entryFiles.length > 0;

  if (scope !== "routes" && !publicEntryDetected) {
    warn(
      "No package entry point was found, so every export is treated as internal API. Pass entryFiles to mark the real public API.",
    );
  }

  if (scope !== "routes" && headSnapshot.unannotatedReturns > 0) {
    warn(
      `${plural(headSnapshot.unannotatedReturns, "exported function")} in the current version ${
        headSnapshot.unannotatedReturns === 1 ? "has" : "have"
      } no explicit return type, so return-type changes cannot be detected for ${
        headSnapshot.unannotatedReturns === 1 ? "it" : "them"
      }.`,
    );
  }

  if (
    scope !== "exports" &&
    (baseSnapshot.hasMountedRouters || headSnapshot.hasMountedRouters)
  ) {
    warn(
      "Mounted routers (app.use('/prefix', router)) are not prefix-resolved, so routes are compared by the path written in each file.",
    );
  }

  if (
    baseSnapshot.symbols.size === 0 &&
    baseSnapshot.routes.size === 0
  ) {
    warn(
      `The baseline (${baselineSet.side.label}) exposes no exports or routes in the selected scope, so there is nothing to compare against.`,
    );
  }

  /* ---- Diff ---- */

  const candidates: Candidate[] = [
    ...(scope !== "routes" ? diffExports(baseSnapshot, headSnapshot) : []),
    ...(scope !== "exports" ? diffRoutes(baseSnapshot, headSnapshot) : []),
  ];

  const everyChange = candidates
    .map((candidate) => buildChange(candidate, baseSnapshot, headSnapshot))
    .sort(
      (a, b) =>
        severityRank(a.severity) - severityRank(b.severity) ||
        b.consumers.count - a.consumers.count ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );

  const breakingTotal = everyChange.filter((change) => change.breaking).length;
  const compatibleTotal = everyChange.length - breakingTotal;

  const recommendedBump: SemverBump =
    breakingTotal > 0 ? "major" : compatibleTotal > 0 ? "minor" : "patch";

  const listed = includeNonBreaking
    ? everyChange
    : everyChange.filter((change) => change.breaking);

  const focusFile = filePath ? normalizePath(filePath) : undefined;

  const scoped = focusFile
    ? listed.filter(
        (change) =>
          change.baselineFilePath === focusFile ||
          change.headFilePath === focusFile ||
          change.filePath === focusFile,
      )
    : listed;

  if (
    focusFile &&
    !baseSnapshot.files.has(focusFile) &&
    !headSnapshot.files.has(focusFile)
  ) {
    warn(
      `${focusFile} was not found among the analyzed files, so no changes can include it.`,
    );
  }

  const reported = scoped.slice(0, MAX_CHANGES);

  if (scoped.length > reported.length) {
    warn(
      `Showing the top ${MAX_CHANGES} of ${scoped.length} changes, ranked by severity.`,
    );
  }

  const summary: Record<ChangeSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };

  for (const change of reported) summary[change.severity]++;

  const perFile = new Map<string, { breaking: number; total: number }>();
  const consumerFiles = new Set<string>();

  for (const change of reported) {
    const entry = perFile.get(change.filePath) ?? { breaking: 0, total: 0 };
    entry.total += 1;
    if (change.breaking) entry.breaking += 1;
    perFile.set(change.filePath, entry);

    for (const file of change.consumers.files) consumerFiles.add(file);
  }

  const hotspots: ApiHotspot[] = [...perFile.entries()]
    .map(([file, entry]) => ({
      filePath: file,
      breakingChanges: entry.breaking,
      totalChanges: entry.total,
    }))
    .sort(
      (a, b) =>
        b.breakingChanges - a.breakingChanges ||
        b.totalChanges - a.totalChanges ||
        a.filePath.localeCompare(b.filePath),
    )
    .slice(0, MAX_HOTSPOTS);

  return {
    success: true,
    tool: "detect_breaking_api_changes",
    projectPath: root,
    filePath: focusFile,
    baseline: baselineSet.side,
    head: headSet.side,
    scope,
    includeNonBreaking,
    includeTests,
    baselineFiles: baselineSet.files.length,
    headFiles: headSet.files.length,
    baselineExports: baseSnapshot.symbols.size,
    headExports: headSnapshot.symbols.size,
    baselineRoutes: baseSnapshot.routes.size,
    headRoutes: headSnapshot.routes.size,
    entryFiles: headSnapshot.entryFiles.length
      ? headSnapshot.entryFiles
      : baseSnapshot.entryFiles,
    publicEntryDetected,
    recommendedBump,
    totalChanges: reported.length,
    projectChangeCount: listed.length,
    breakingChanges: reported.filter((change) => change.breaking).length,
    compatibleChanges: reported.filter((change) => !change.breaking).length,
    exportChanges: reported.filter((change) => change.surface === "export").length,
    routeChanges: reported.filter((change) => change.surface === "route").length,
    filesAffected: perFile.size,
    consumersAffected: consumerFiles.size,
    summary,
    changes: reported,
    hotspots,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/*  MCP registration                                                          */
/* -------------------------------------------------------------------------- */

export function registerDetectBreakingApiChangesTool(server: McpServer) {
  server.registerTool(
    "detect_breaking_api_changes",
    {
      description:
        "Detect breaking API changes between a baseline version and the current version of a JavaScript/TypeScript project. Compares a git ref (default HEAD), a second ref, or another folder against the working tree using the TypeScript parser. Reports removed, renamed or moved exports, signature, type, member and enum changes, and removed or changed HTTP routes, each with a severity, the files that import it, a before/after view, a migration suggestion, and a recommended semver bump.",
      inputSchema: z.object({
        projectPath: z
          .string()
          .describe("Absolute path to the project directory"),
        baseRef: z
          .string()
          .optional()
          .describe(
            "Git branch, tag or commit to use as the baseline. Default HEAD (compares uncommitted changes).",
          ),
        headRef: z
          .string()
          .optional()
          .describe(
            "Git ref for the current version. Default is the working tree. Combine with baseRef to compare two releases.",
          ),
        baselinePath: z
          .string()
          .optional()
          .describe(
            "Folder containing the baseline version, for projects without git history. Cannot be combined with baseRef or headRef.",
          ),
        filePath: z
          .string()
          .optional()
          .describe(
            "Optional file, relative to projectPath. When set, only changes in this file are reported.",
          ),
        scope: z
          .enum(["all", "exports", "routes"])
          .optional()
          .describe(
            "What to compare: all (default), exports only, or HTTP routes only.",
          ),
        entryFiles: z
          .array(z.string())
          .max(50)
          .optional()
          .describe(
            "Files, relative to projectPath, that define the public API. Default: detected from package.json or src/index.",
          ),
        includeNonBreaking: z
          .boolean()
          .optional()
          .describe("Also list compatible changes such as new exports. Default false."),
        includeTests: z
          .boolean()
          .optional()
          .describe("Include test, mock and story files. Default false."),
      }),
    },
    async ({
      projectPath,
      baseRef,
      headRef,
      baselinePath,
      filePath,
      scope,
      entryFiles,
      includeNonBreaking,
      includeTests,
    }) => {
      try {
        const report = await detectBreakingApiChanges(projectPath, {
          baseRef,
          headRef,
          baselinePath,
          filePath,
          scope,
          entryFiles,
          includeNonBreaking,
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
                  tool: "detect_breaking_api_changes",
                  error:
                    error instanceof Error
                      ? error.message
                      : "Failed to detect breaking API changes.",
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
