import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveProjectPath } from "../utils/projectResolver.js";

/* -------------------------------------------------------------------------- */
/*  Report types                                                              */
/* -------------------------------------------------------------------------- */

type Severity = "critical" | "high" | "medium" | "low" | "info";

/**
 * latest     - the newest stable version on the registry.
 * next-major - the newest version of the next major, or the newest in the
 *              current major when the project is already on the latest major.
 * compatible - the newest version that the declared range already allows.
 */
type Strategy = "latest" | "next-major" | "compatible";

type Bump = "major" | "minor" | "patch" | "none" | "unknown";

/**
 * up-to-date - nothing newer was found.
 * safe       - a minor or patch update with no known problems.
 * review     - a major update, or a medium problem. Read the release notes.
 * risky      - something in your code or setup is known to break.
 * blocked    - the upgrade will fail as things stand.
 * unknown    - no target version could be determined.
 */
type Verdict = "up-to-date" | "safe" | "review" | "risky" | "blocked" | "unknown";

type DepKind = "dependencies" | "devDependencies" | "optionalDependencies";
type VersionSource = "node_modules" | "lockfile" | "manifest" | "unknown";
type PackageManager = "npm" | "yarn" | "pnpm" | "bun" | "unknown";

type TargetSource =
  | "override"
  | "registry-latest"
  | "registry-next-major"
  | "registry-compatible"
  | "known-change"
  | "none";

type ConflictKind =
  | "peer-dependent"
  | "peer-unmet"
  | "peer-missing"
  | "engines"
  | "types"
  | "deprecated"
  | "notice";

interface UsageLocation {
  filePath: string;
  line: number;
  kind: "import" | "require" | "dynamic" | "export" | "mock";
  isTest: boolean;
}

interface ApiUse {
  name: string;
  fileCount: number;
}

interface PackageUsage {
  fileCount: number;
  importCount: number;
  testFileCount: number;
  apis: ApiUse[];
  hiddenApis: number;
  locations: UsageLocation[];
  hiddenLocations: number;
  /** package.json scripts that run one of this package's commands. */
  viaScripts: string[];
  /** Config files that mention the package. */
  viaConfig: string[];
  /** Nothing in the project appears to use it. */
  unused: boolean;
  /** Only imported as types. */
  typeOnly: boolean;
}

interface BreakingLocation {
  filePath: string;
  line: number;
  snippet: string;
}

interface BreakingChange {
  id: string;
  title: string;
  severity: Severity;
  description: string;
  /** First version that contains the change. */
  breaksIn: string;
  locations: BreakingLocation[];
  hiddenLocations: number;
  count: number;
  before?: string;
  after?: string;
  docs?: string;
}

interface Conflict {
  id: string;
  kind: ConflictKind;
  severity: Severity;
  title: string;
  description: string;
  /** Another package involved, when there is one. */
  related?: string;
}

interface UpgradePlan {
  title: string;
  summary: string;
  steps: string[];
  /** Install command for the chosen package manager. */
  commands: string;
  caveats: string[];
}

interface UpgradePackage {
  id: string;
  name: string;
  kind: DepKind;
  declaredRange: string;
  workspaces: string[];
  installed?: string;
  installedSource: VersionSource;
  latest?: string;
  target?: string;
  targetSource: TargetSource;
  bump: Bump;
  /** How many major versions the project is behind the target. */
  majorsBehind: number;
  verdict: Verdict;
  severity: Severity;
  /** 0-100 combined risk score. */
  riskScore: number;
  summary: string;
  /** Message when the installed version is deprecated. */
  deprecated?: string;
  usage: PackageUsage;
  breaking: BreakingChange[];
  breakingCount: number;
  conflicts: Conflict[];
  plan: UpgradePlan;
}

interface FileHotspot {
  filePath: string;
  breakingCount: number;
  packages: string[];
  topSeverity: Severity;
}

interface SafeBatch {
  count: number;
  /** Install commands, one for dependencies and one for dev dependencies. */
  commands: string[];
  packages: Array<{ name: string; from: string; to: string; dev: boolean }>;
}

interface UpgradeReport {
  success: boolean;
  tool: "analyze_upgrade_impact";
  projectPath: string;
  packageName?: string;
  strategy: Strategy;
  checkRegistry: boolean;
  includeDev: boolean;
  registryStatus: "not-requested" | "ok" | "partial" | "unavailable";
  registryFailures: number;
  packageManager: PackageManager;
  nodeVersion: string;
  nodeVersionSource: "nvmrc" | "engines" | "tool-versions" | "running";
  workspaces: string[];
  filesScanned: number;
  totalDependencies: number;
  outdatedCount: number;
  majorCount: number;
  minorCount: number;
  patchCount: number;
  upToDateCount: number;
  unknownCount: number;
  breakingPackageCount: number;
  breakingTotal: number;
  conflictPackageCount: number;
  deprecatedCount: number;
  unusedCount: number;
  summary: Record<Verdict, number>;
  packages: UpgradePackage[];
  safeBatch: SafeBatch;
  hotspots: FileHotspot[];
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage", ".next", ".nuxt", ".turbo",
  ".cache", "out", ".vite", ".yarn", ".pnpm-store", "generated-diagrams",
]);

const TEST_PATH_PATTERN =
  /(^|\/)(__tests__|__mocks__|tests?|e2e|cypress|fixtures?|stories)\/|\.(test|spec|stories)\.[cm]?[jt]sx?$/i;

const CONFIG_FILE_PATTERN =
  /(^|\/)(\.eslintrc[^/]*|eslint\.config\.[cm]?js|\.babelrc[^/]*|babel\.config\.[cm]?js|jest\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|webpack\.config\.[cm]?js|vite\.config\.[cm]?[jt]s|rollup\.config\.[cm]?[jt]s|tsconfig[^/]*\.json|postcss\.config\.[cm]?js|\.postcssrc[^/]*|tailwind\.config\.[cm]?[jt]s|\.prettierrc[^/]*|prettier\.config\.[cm]?js|\.stylelintrc[^/]*|next\.config\.[cm]?js|\.mocharc[^/]*|karma\.conf\.[cm]?js|cypress\.config\.[cm]?[jt]s|playwright\.config\.[cm]?[jt]s)$/i;

const MAX_FILES = 4_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_INSTALLED_PACKAGES = 6_000;
const MAX_WORKSPACES = 200;
const MAX_LOCATIONS = 12;
const MAX_HITS_PER_RULE = 60;
const MAX_APIS = 14;
const MAX_HOTSPOTS = 12;
const MAX_WARNINGS = 25;
const MAX_DEPENDENCIES = 400;

const REGISTRY_URL = "https://registry.npmjs.org";
const REGISTRY_TIMEOUT_MS = 12_000;
const REGISTRY_BUDGET_MS = 90_000;
const REGISTRY_CONCURRENCY = 8;
const REGISTRY_CACHE_MS = 10 * 60 * 1000;

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 30,
  high: 18,
  medium: 8,
  low: 3,
  info: 1,
};

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function clip(value: string, length = 140): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

function worstSeverity(items: Severity[]): Severity {
  for (const severity of SEVERITY_ORDER) {
    if (items.includes(severity)) return severity;
  }
  return "info";
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function readJson<T>(file: string): T | undefined {
  const text = readText(file);
  if (text === undefined) return undefined;

  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/*  Semver                                                                    */
/* -------------------------------------------------------------------------- */

interface Ver {
  major: number;
  minor: number;
  patch: number;
  pre: Array<string | number>;
}

interface Comparator {
  op: "<" | "<=" | ">" | ">=" | "=";
  v: Ver;
}

type RangeSet = Comparator[];

const VERSION_PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parsePre(text: string | undefined): Array<string | number> {
  if (!text) return [];
  return text.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

function parseVersion(text: string): Ver | null {
  const match = VERSION_PATTERN.exec(text.trim());
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: parsePre(match[4]),
  };
}

function coerceVersion(text: string): Ver | null {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text);
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    pre: [],
  };
}

function formatVersion(v: Ver): string {
  return `${v.major}.${v.minor}.${v.patch}${v.pre.length > 0 ? `-${v.pre.join(".")}` : ""}`;
}

function comparePre(a: Array<string | number>, b: Array<string | number>): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const left = a[i];
    const right = b[i];

    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;

    const leftNumber = typeof left === "number";
    const rightNumber = typeof right === "number";

    if (leftNumber && rightNumber) return (left as number) < (right as number) ? -1 : 1;
    if (leftNumber) return -1;
    if (rightNumber) return 1;
    return (left as string) < (right as string) ? -1 : 1;
  }

  return 0;
}

function compareVersions(a: Ver, b: Ver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePre(a.pre, b.pre);
}

interface Partial {
  major?: number;
  minor?: number;
  patch?: number;
  pre?: string;
}

function parsePartial(token: string): Partial | null {
  const cleaned = token.replace(/^[=v]+/, "");
  const match =
    /^(\*|[xX]|\d+)(?:\.(\*|[xX]|\d+))?(?:\.(\*|[xX]|\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      cleaned,
    );
  if (!match) return null;

  const number = (value: string | undefined) =>
    value === undefined || /^[*xX]$/.test(value) ? undefined : Number(value);

  const major = number(match[1]);
  const minor = major === undefined ? undefined : number(match[2]);
  const patch = minor === undefined ? undefined : number(match[3]);

  return { major, minor, patch, pre: match[4] };
}

function ver(major: number, minor: number, patch: number, pre?: string): Ver {
  return { major, minor, patch, pre: parsePre(pre) };
}

function desugar(op: string, partial: Partial): Comparator[] {
  const { major, minor, patch, pre } = partial;
  const lowest: Comparator = { op: ">=", v: ver(0, 0, 0) };

  if (major === undefined) {
    if (op === ">" || op === "<") return [{ op: "<", v: ver(0, 0, 0) }];
    return [lowest];
  }

  switch (op) {
    case "":
    case "=": {
      if (minor === undefined) {
        return [{ op: ">=", v: ver(major, 0, 0) }, { op: "<", v: ver(major + 1, 0, 0) }];
      }
      if (patch === undefined) {
        return [{ op: ">=", v: ver(major, minor, 0) }, { op: "<", v: ver(major, minor + 1, 0) }];
      }
      return [{ op: "=", v: ver(major, minor, patch, pre) }];
    }

    case ">": {
      if (minor === undefined) return [{ op: ">=", v: ver(major + 1, 0, 0) }];
      if (patch === undefined) return [{ op: ">=", v: ver(major, minor + 1, 0) }];
      return [{ op: ">", v: ver(major, minor, patch, pre) }];
    }

    case ">=":
      return [{ op: ">=", v: ver(major, minor ?? 0, patch ?? 0, pre) }];

    case "<":
      return [{ op: "<", v: ver(major, minor ?? 0, patch ?? 0, pre) }];

    case "<=": {
      if (minor === undefined) return [{ op: "<", v: ver(major + 1, 0, 0) }];
      if (patch === undefined) return [{ op: "<", v: ver(major, minor + 1, 0) }];
      return [{ op: "<=", v: ver(major, minor, patch, pre) }];
    }

    case "~": {
      if (minor === undefined) {
        return [{ op: ">=", v: ver(major, 0, 0) }, { op: "<", v: ver(major + 1, 0, 0) }];
      }
      return [
        { op: ">=", v: ver(major, minor, patch ?? 0, pre) },
        { op: "<", v: ver(major, minor + 1, 0) },
      ];
    }

    case "^": {
      const lower: Comparator = { op: ">=", v: ver(major, minor ?? 0, patch ?? 0, pre) };

      if (major > 0) return [lower, { op: "<", v: ver(major + 1, 0, 0) }];

      if (minor === undefined) return [lower, { op: "<", v: ver(1, 0, 0) }];
      if (patch === undefined) return [lower, { op: "<", v: ver(0, minor + 1, 0) }];
      if (minor > 0) return [lower, { op: "<", v: ver(0, minor + 1, 0) }];
      return [lower, { op: "<", v: ver(0, 0, patch + 1) }];
    }

    default:
      return [lowest];
  }
}

function parseRange(range: string): RangeSet[] | null {
  const sets: RangeSet[] = [];

  for (const rawPart of range.split("||")) {
    const part = rawPart.trim();

    if (part === "" || part === "*" || part === "latest") {
      sets.push([{ op: ">=", v: ver(0, 0, 0) }]);
      continue;
    }

    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(part);

    if (hyphen) {
      const from = parsePartial(hyphen[1]);
      const to = parsePartial(hyphen[2]);
      if (!from || !to) return null;

      const set: RangeSet = [...desugar(">=", from)];

      if (to.major === undefined) {
        // A wildcard upper bound has no limit.
      } else if (to.minor === undefined || to.patch === undefined) {
        set.push(...desugar("<=", to));
      } else {
        set.push({ op: "<=", v: ver(to.major, to.minor, to.patch, to.pre) });
      }

      sets.push(set);
      continue;
    }

    const normalized = part
      .replace(/(<=|>=|<|>|=|\^|~>|~)\s+/g, "$1")
      .replace(/~>/g, "~");

    const set: RangeSet = [];

    for (const token of normalized.split(/\s+/).filter(Boolean)) {
      const match = /^(<=|>=|<|>|=|\^|~)?(.*)$/.exec(token);
      if (!match) return null;

      const partial = parsePartial(match[2]);
      if (!partial) return null;

      set.push(...desugar(match[1] ?? "", partial));
    }

    sets.push(set);
  }

  return sets.length > 0 ? sets : null;
}

function testComparator(version: Ver, comparator: Comparator): boolean {
  const result = compareVersions(version, comparator.v);

  switch (comparator.op) {
    case "<": return result < 0;
    case "<=": return result <= 0;
    case ">": return result > 0;
    case ">=": return result >= 0;
    default: return result === 0;
  }
}

function satisfiesSets(version: Ver, sets: RangeSet[]): boolean {
  return sets.some((set) => {
    if (!set.every((comparator) => testComparator(version, comparator))) return false;
    if (version.pre.length === 0) return true;

    return set.some(
      (comparator) =>
        comparator.v.pre.length > 0 &&
        comparator.v.major === version.major &&
        comparator.v.minor === version.minor &&
        comparator.v.patch === version.patch,
    );
  });
}

/** True when the version satisfies the range. A range that cannot be parsed is treated as satisfied. */
function satisfies(version: string, range: string): boolean {
  const parsed = parseVersion(version) ?? coerceVersion(version);
  const sets = parseRange(range);
  if (!parsed || !sets) return true;
  return satisfiesSets(parsed, sets);
}

function maxSatisfying(versions: string[], range: string): string | undefined {
  const sets = parseRange(range);
  if (!sets) return undefined;

  let best: { text: string; v: Ver } | undefined;

  for (const text of versions) {
    const v = parseVersion(text);
    if (!v || !satisfiesSets(v, sets)) continue;
    if (!best || compareVersions(v, best.v) > 0) best = { text, v };
  }

  return best?.text;
}

function lowestBound(range: string): Ver | null {
  const sets = parseRange(range);
  if (!sets) return null;

  let lowest: Ver | null = null;

  for (const set of sets) {
    let lower: Ver = ver(0, 0, 0);

    for (const comparator of set) {
      if (
        (comparator.op === ">=" || comparator.op === ">" || comparator.op === "=") &&
        compareVersions(comparator.v, lower) > 0
      ) {
        lower = comparator.v;
      }
    }

    if (!lowest || compareVersions(lower, lowest) < 0) lowest = lower;
  }

  return lowest;
}

function bumpBetween(from: string, to: string): Bump {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) return "unknown";

  if (compareVersions(b, a) <= 0) return "none";
  if (a.major !== b.major) return "major";
  if (a.minor !== b.minor) return "minor";
  return "patch";
}

function isStable(text: string): boolean {
  const v = parseVersion(text);
  return !!v && v.pre.length === 0;
}

/* -------------------------------------------------------------------------- */
/*  Manifests, workspaces and installed versions                              */
/* -------------------------------------------------------------------------- */

interface Manifest {
  name?: string;
  version?: string;
  type?: string;
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  scripts?: Record<string, string>;
  engines?: { node?: string };
  workspaces?: string[] | { packages?: string[] };
  bin?: string | Record<string, string>;
  deprecated?: string;
  eslintConfig?: unknown;
}

interface Workspace {
  name: string;
  dir: string;
  rel: string;
  manifest: Manifest;
}

interface InstalledPackage {
  name: string;
  version: string;
  peerDependencies: Record<string, string>;
  peerOptional: Set<string>;
  deprecated?: string;
  bins: string[];
}

interface Declared {
  name: string;
  kind: DepKind;
  range: string;
  workspace: string;
}

function listSubdirectories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function expandWorkspacePattern(root: string, pattern: string): string[] {
  const cleaned = normalizePath(pattern).replace(/\/+$/, "");
  if (cleaned.startsWith("!")) return [];

  if (cleaned.endsWith("/**")) {
    const base = path.join(root, cleaned.slice(0, -3));
    const found: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 3) return;
      for (const child of listSubdirectories(dir)) {
        if (fs.existsSync(path.join(child, "package.json"))) found.push(child);
        walk(child, depth + 1);
      }
    };
    walk(base, 0);
    return found;
  }

  if (cleaned.endsWith("/*")) {
    const base = path.join(root, cleaned.slice(0, -2));
    return listSubdirectories(base).filter((dir) =>
      fs.existsSync(path.join(dir, "package.json")),
    );
  }

  if (cleaned.includes("*")) return [];

  const dir = path.join(root, cleaned);
  return fs.existsSync(path.join(dir, "package.json")) ? [dir] : [];
}

function readWorkspacePatterns(root: string, manifest: Manifest): string[] {
  const fromManifest = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : manifest.workspaces?.packages ?? [];

  const patterns = [...fromManifest];

  const pnpm = readText(path.join(root, "pnpm-workspace.yaml"));
  if (pnpm) {
    for (const match of pnpm.matchAll(/^\s*-\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)) {
      patterns.push(match[1]);
    }
  }

  return patterns;
}

function detectPackageManager(root: string, manifest: Manifest): PackageManager {
  const declared = manifest.packageManager?.split("@")[0];
  if (declared === "npm" || declared === "yarn" || declared === "pnpm" || declared === "bun") {
    return declared;
  }

  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(root, "bun.lockb")) || fs.existsSync(path.join(root, "bun.lock"))) return "bun";
  if (
    fs.existsSync(path.join(root, "package-lock.json")) ||
    fs.existsSync(path.join(root, "npm-shrinkwrap.json"))
  ) {
    return "npm";
  }
  return "unknown";
}

function packageDirectory(root: string, name: string): string {
  return path.join(root, "node_modules", ...name.split("/"));
}

function readInstalled(dirs: string[], name: string): InstalledPackage | undefined {
  for (const dir of dirs) {
    const manifest = readJson<Manifest>(path.join(packageDirectory(dir, name), "package.json"));
    if (!manifest || typeof manifest.version !== "string") continue;

    const bins = !manifest.bin
      ? []
      : typeof manifest.bin === "string"
        ? [name.split("/").pop()!]
        : Object.keys(manifest.bin);

    return {
      name,
      version: manifest.version,
      peerDependencies: manifest.peerDependencies ?? {},
      peerOptional: new Set(
        Object.entries(manifest.peerDependenciesMeta ?? {})
          .filter(([, meta]) => meta?.optional)
          .map(([key]) => key),
      ),
      deprecated: typeof manifest.deprecated === "string" ? manifest.deprecated : undefined,
      bins,
    };
  }

  return undefined;
}

/** Reads the top level of node_modules so peer dependency checks need no network. */
function scanInstalled(root: string): Map<string, InstalledPackage> {
  const found = new Map<string, InstalledPackage>();
  const base = path.join(root, "node_modules");

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return found;
  }

  const names: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    if (entry.name.startsWith("@")) {
      try {
        for (const child of fs.readdirSync(path.join(base, entry.name))) {
          names.push(`${entry.name}/${child}`);
        }
      } catch {
        // An unreadable scope folder is skipped.
      }
    } else {
      names.push(entry.name);
    }
  }

  for (const name of names) {
    if (found.size >= MAX_INSTALLED_PACKAGES) break;
    const installed = readInstalled([root], name);
    if (installed) found.set(name, installed);
  }

  return found;
}

/* ---- Lockfiles (a fallback when node_modules is missing) ---- */

interface LockInfo {
  versions: Map<string, string>;
  /** Packages whose lockfile entry points somewhere other than the public registry. */
  private: Set<string>;
}

function parseYarnLock(text: string, declared: Map<string, string>): Map<string, string> {
  const byName = new Map<string, Map<string, string>>();
  let headers: string[] = [];

  for (const line of text.split("\n")) {
    if (/^\S.*:$/.test(line) && !line.startsWith("#")) {
      headers = line
        .slice(0, -1)
        .split(",")
        .map((part) => part.trim().replace(/^"|"$/g, ""));
      continue;
    }

    const version = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
    if (version && headers.length > 0) {
      for (const header of headers) {
        const at = header.lastIndexOf("@");
        if (at <= 0) continue;
        const name = header.slice(0, at);
        const spec = header.slice(at + 1).replace(/^npm:/, "");

        const entry = byName.get(name) ?? new Map<string, string>();
        entry.set(spec, version[1]);
        byName.set(name, entry);
      }
      headers = [];
    }
  }

  const result = new Map<string, string>();

  for (const [name, specs] of byName) {
    const wanted = declared.get(name);
    const exact = wanted !== undefined ? specs.get(wanted) : undefined;

    if (exact) {
      result.set(name, exact);
      continue;
    }

    const all = [...specs.values()]
      .map((text) => parseVersion(text))
      .filter((item): item is Ver => item !== null)
      .sort(compareVersions);

    if (all.length > 0) result.set(name, formatVersion(all[all.length - 1]));
  }

  return result;
}

function parsePnpmLock(text: string): Map<string, string> {
  const result = new Map<string, string>();

  for (const match of text.matchAll(
    /^[ ]{4,}['"]?([^\s'":]+)['"]?:\n[ ]+specifier:[^\n]*\n[ ]+version:\s*([^\s(\n]+)/gm,
  )) {
    if (!result.has(match[1])) result.set(match[1], match[2]);
  }

  if (result.size === 0) {
    let section = false;
    for (const line of text.split("\n")) {
      if (/^(dependencies|devDependencies|optionalDependencies):\s*$/.test(line)) {
        section = true;
        continue;
      }
      if (/^\S/.test(line)) section = false;

      const entry = section ? /^[ ]{2}['"]?([^\s'":]+)['"]?:\s*([^\s(]+)/.exec(line) : null;
      if (entry && !result.has(entry[1])) result.set(entry[1], entry[2]);
    }
  }

  return result;
}

function readLockfile(root: string, declared: Map<string, string>): LockInfo {
  const info: LockInfo = { versions: new Map(), private: new Set() };

  for (const file of ["package-lock.json", "npm-shrinkwrap.json"]) {
    const lock = readJson<{
      packages?: Record<string, { version?: string; resolved?: string }>;
      dependencies?: Record<string, { version?: string; resolved?: string }>;
    }>(path.join(root, file));

    if (!lock) continue;

    const note = (name: string, entry: { version?: string; resolved?: string }) => {
      if (entry.version && !info.versions.has(name)) info.versions.set(name, entry.version);
      if (entry.resolved && /^https?:\/\//.test(entry.resolved) && !entry.resolved.startsWith(REGISTRY_URL)) {
        info.private.add(name);
      }
    };

    for (const [key, entry] of Object.entries(lock.packages ?? {})) {
      const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
      if (match) note(match[1], entry);
    }

    for (const [name, entry] of Object.entries(lock.dependencies ?? {})) note(name, entry);
    if (info.versions.size > 0) return info;
  }

  const yarn = readText(path.join(root, "yarn.lock"));
  if (yarn) {
    for (const [name, version] of parseYarnLock(yarn, declared)) info.versions.set(name, version);
    return info;
  }

  const pnpm = readText(path.join(root, "pnpm-lock.yaml"));
  if (pnpm) {
    for (const [name, version] of parsePnpmLock(pnpm)) info.versions.set(name, version);
  }

  return info;
}

/* ---- Private registries (never queried, never sent a name) ---- */

const PUBLIC_REGISTRY_HOSTS = new Set(["registry.npmjs.org", "registry.yarnpkg.com"]);

function isPublicRegistry(url: string): boolean {
  try {
    return PUBLIC_REGISTRY_HOSTS.has(new URL(url.trim().replace(/^["']|["']$/g, "")).host);
  } catch {
    return false;
  }
}

interface RegistryConfig {
  /** True when unscoped packages come from a registry other than the public one. */
  defaultIsPrivate: boolean;
  /** Scopes (for example "@corp") that come from a private registry. */
  privateScopes: Set<string>;
}

function readRegistryConfig(root: string): RegistryConfig {
  const config: RegistryConfig = { defaultIsPrivate: false, privateScopes: new Set() };

  const npmrc = readText(path.join(root, ".npmrc"));
  if (npmrc) {
    for (const line of npmrc.split(/\r?\n/)) {
      const match = /^\s*(@[^:\s]+:)?registry\s*=\s*(\S+)/.exec(line);
      if (!match || isPublicRegistry(match[2])) continue;

      if (match[1]) config.privateScopes.add(match[1].slice(0, -1));
      else config.defaultIsPrivate = true;
    }
  }

  const yarnrc = readText(path.join(root, ".yarnrc.yml"));
  if (yarnrc) {
    const server = /^npmRegistryServer:\s*(\S+)/m.exec(yarnrc);
    if (server && !isPublicRegistry(server[1])) config.defaultIsPrivate = true;

    for (const scope of yarnrc.matchAll(/^\s{2}["']?(@?[\w.-]+)["']?:\s*\n(?:\s{4}.*\n)*?\s{4}npmRegistryServer:\s*(\S+)/gm)) {
      if (!isPublicRegistry(scope[2])) config.privateScopes.add(scope[1].startsWith("@") ? scope[1] : `@${scope[1]}`);
    }
  }

  return config;
}

function usesPrivateRegistry(name: string, config: RegistryConfig): boolean {
  if (name.startsWith("@")) {
    const scope = name.split("/")[0];
    if (config.privateScopes.has(scope)) return true;
  }
  return config.defaultIsPrivate;
}

/* -------------------------------------------------------------------------- */
/*  Node version of the project                                               */
/* -------------------------------------------------------------------------- */

function detectNodeVersion(
  root: string,
  manifest: Manifest,
): { version: string; source: UpgradeReport["nodeVersionSource"]; declared: boolean } {
  for (const file of [".nvmrc", ".node-version"]) {
    const text = readText(path.join(root, file))?.trim();
    const version = text ? coerceVersion(text) : null;
    if (version && /^v?\d/.test(text!)) {
      return { version: formatVersion(version), source: "nvmrc", declared: true };
    }
  }

  const toolVersions = readText(path.join(root, ".tool-versions"));
  const tool = toolVersions ? /^\s*nodejs\s+(\S+)/m.exec(toolVersions) : null;
  const toolVersion = tool ? coerceVersion(tool[1]) : null;
  if (toolVersion) {
    return { version: formatVersion(toolVersion), source: "tool-versions", declared: true };
  }

  if (manifest.engines?.node) {
    const bound = lowestBound(manifest.engines.node);
    if (bound) return { version: formatVersion(bound), source: "engines", declared: true };
  }

  return { version: process.versions.node, source: "running", declared: false };
}

/* -------------------------------------------------------------------------- */
/*  npm registry                                                              */
/* -------------------------------------------------------------------------- */

interface RegistryVersionInfo {
  deprecated?: string;
  engineNode?: string;
  peers: Record<string, string>;
  peerOptional: Set<string>;
}

interface RegistryDoc {
  name: string;
  tags: Record<string, string>;
  versions: Map<string, RegistryVersionInfo>;
}

interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type FetchFunction = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<FetchResponse>;

const registryCache = new Map<string, { at: number; doc: RegistryDoc | null }>();

function getFetch(): FetchFunction | undefined {
  return (globalThis as unknown as { fetch?: FetchFunction }).fetch;
}

async function fetchRegistryDoc(
  name: string,
): Promise<{ doc: RegistryDoc | null; failed: boolean }> {
  const cached = registryCache.get(name);
  if (cached && Date.now() - cached.at < REGISTRY_CACHE_MS) {
    return { doc: cached.doc, failed: false };
  }

  const fetchImpl = getFetch();
  if (!fetchImpl) return { doc: null, failed: true };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);

  try {
    const response = await fetchImpl(`${REGISTRY_URL}/${name.replace("/", "%2F")}`, {
      headers: {
        Accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8",
      },
      signal: controller.signal,
    });

    if (response.status === 404 || response.status === 401 || response.status === 403) {
      registryCache.set(name, { at: Date.now(), doc: null });
      return { doc: null, failed: false };
    }

    if (!response.ok) return { doc: null, failed: true };

    const body = (await response.json()) as {
      "dist-tags"?: Record<string, string>;
      versions?: Record<
        string,
        {
          deprecated?: string;
          engines?: { node?: string } | string[];
          peerDependencies?: Record<string, string>;
          peerDependenciesMeta?: Record<string, { optional?: boolean }>;
        }
      >;
    };

    const versions = new Map<string, RegistryVersionInfo>();

    for (const [version, info] of Object.entries(body.versions ?? {})) {
      const engines = info.engines && !Array.isArray(info.engines) ? info.engines : undefined;

      versions.set(version, {
        deprecated: typeof info.deprecated === "string" ? info.deprecated : undefined,
        engineNode: typeof engines?.node === "string" ? engines.node : undefined,
        peers: info.peerDependencies ?? {},
        peerOptional: new Set(
          Object.entries(info.peerDependenciesMeta ?? {})
            .filter(([, meta]) => meta?.optional)
            .map(([key]) => key),
        ),
      });
    }

    const doc: RegistryDoc = { name, tags: body["dist-tags"] ?? {}, versions };
    registryCache.set(name, { at: Date.now(), doc });
    return { doc, failed: false };
  } catch {
    return { doc: null, failed: true };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAllRegistryDocs(
  names: string[],
): Promise<{ docs: Map<string, RegistryDoc>; failures: number; skipped: number }> {
  const docs = new Map<string, RegistryDoc>();
  let failures = 0;
  let skipped = 0;
  let index = 0;
  const started = Date.now();

  const worker = async () => {
    while (index < names.length) {
      const name = names[index++];

      if (Date.now() - started > REGISTRY_BUDGET_MS) {
        skipped++;
        continue;
      }

      const result = await fetchRegistryDoc(name);
      if (result.doc) docs.set(name, result.doc);
      if (result.failed) failures++;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(REGISTRY_CONCURRENCY, names.length) }, worker),
  );

  return { docs, failures, skipped };
}

function stableVersions(doc: RegistryDoc): string[] {
  return [...doc.versions.keys()].filter(
    (version) => isStable(version) && !doc.versions.get(version)?.deprecated,
  );
}

function allStableVersions(doc: RegistryDoc): string[] {
  return [...doc.versions.keys()].filter(isStable);
}

function highestOf(versions: string[]): string | undefined {
  let best: { text: string; v: Ver } | undefined;

  for (const text of versions) {
    const v = parseVersion(text);
    if (v && (!best || compareVersions(v, best.v) > 0)) best = { text, v };
  }

  return best?.text;
}

/* -------------------------------------------------------------------------- */
/*  File discovery                                                            */
/* -------------------------------------------------------------------------- */

interface ProjectFile {
  rel: string;
  abs: string;
  size: number;
}

function discoverFiles(root: string): { files: ProjectFile[]; truncated: boolean } {
  const files: ProjectFile[] = [];
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
      const abs = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) stack.push(abs);
        continue;
      }

      if (!entry.isFile()) continue;

      if (files.length >= 30_000) {
        truncated = true;
        continue;
      }

      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch {
        continue;
      }

      files.push({ rel: normalizePath(path.relative(root, abs)), abs, size });
    }
  }

  return { files, truncated };
}

/* -------------------------------------------------------------------------- */
/*  Reading imports and usage from source files                               */
/* -------------------------------------------------------------------------- */

interface ImportRecord {
  pkg: string;
  spec: string;
  /** Part of the import path after the package name, without a leading slash. */
  subpath: string;
  line: number;
  kind: UsageLocation["kind"];
  typeOnly: boolean;
  names: Array<{ imported: string; local: string }>;
  defaultLocal?: string;
  namespaceLocal?: string;
}

interface JsxUse {
  local: string;
  member?: string;
  line: number;
  props: Map<string, number>;
}

interface FileUsage {
  filePath: string;
  isTest: boolean;
  text: string;
  lines?: string[];
  lineStarts?: number[];
  imports: ImportRecord[];
  refs: Map<string, number[]>;
  members: Map<string, Map<string, number[]>>;
  jsx: JsxUse[];
}

const BUILTIN_MODULES = new Set<string>([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants",
  "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http",
  "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process",
  "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "sys",
  "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi",
  "worker_threads", "zlib",
]);

function splitSpecifier(spec: string): { pkg: string; subpath: string } | null {
  if (
    !spec ||
    spec.startsWith(".") ||
    spec.startsWith("/") ||
    spec.startsWith("#") ||
    spec.startsWith("~") ||
    spec.startsWith("@/") ||
    spec.includes(":")
  ) {
    return null;
  }

  const parts = spec.split("/");

  if (spec.startsWith("@")) {
    if (parts.length < 2) return null;
    return { pkg: `${parts[0]}/${parts[1]}`, subpath: parts.slice(2).join("/") };
  }

  if (BUILTIN_MODULES.has(parts[0])) return null;
  return { pkg: parts[0], subpath: parts.slice(1).join("/") };
}

function scriptKindFor(file: string): ts.ScriptKind {
  const extension = path.extname(file);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") return ts.ScriptKind.TS;
  return ts.ScriptKind.JSX;
}

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
  ts.SyntaxKind.ImportSpecifier,
  ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.NamespaceImport,
  ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.ExportSpecifier,
]);

function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;

  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;

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
    return true;
  }

  return true;
}

const MOCK_CALLEES = new Set([
  "jest.mock", "jest.doMock", "jest.unmock", "jest.requireActual", "jest.requireMock",
  "vi.mock", "vi.doMock", "vi.importActual",
]);

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function addLine(map: Map<string, number[]>, key: string, line: number, cap = 8): void {
  const list = map.get(key) ?? [];
  if (list.length < cap && !list.includes(line)) list.push(line);
  map.set(key, list);
}

function analyzeSource(rel: string, text: string, isTest: boolean): FileUsage {
  const usage: FileUsage = {
    filePath: rel,
    isTest,
    text,
    imports: [],
    refs: new Map(),
    members: new Map(),
    jsx: [],
  };

  if (!/\b(import|require|export)\b/.test(text)) return usage;

  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKindFor(rel));

  const named = new Map<string, ImportRecord>();
  const namespaced = new Map<string, ImportRecord>();

  const record = (
    spec: string,
    node: ts.Node,
    kind: ImportRecord["kind"],
    typeOnly = false,
  ): ImportRecord | undefined => {
    const split = splitSpecifier(spec);
    if (!split) return undefined;

    const entry: ImportRecord = {
      pkg: split.pkg,
      spec,
      subpath: split.subpath,
      line: lineOf(sf, node),
      kind,
      typeOnly,
      names: [],
    };
    usage.imports.push(entry);
    return entry;
  };

  const bindFromDeclaration = (entry: ImportRecord, node: ts.Node) => {
    let current: ts.Node | undefined = node.parent;
    while (current && (ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current) || ts.isAsExpression(current))) {
      current = current.parent;
    }

    if (!current || !ts.isVariableDeclaration(current)) return;

    if (ts.isIdentifier(current.name)) {
      entry.defaultLocal = current.name.text;
    } else if (ts.isObjectBindingPattern(current.name)) {
      for (const element of current.name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        const imported = element.propertyName && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : element.name.text;
        entry.names.push({ imported, local: element.name.text });
      }
    }
  };

  const collect = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const entry = record(node.moduleSpecifier.text, node, "import", !!clause?.isTypeOnly);

      if (entry && clause) {
        if (clause.name) entry.defaultLocal = clause.name.text;

        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            entry.namespaceLocal = clause.namedBindings.name.text;
          } else {
            for (const element of clause.namedBindings.elements) {
              entry.names.push({
                imported: (element.propertyName ?? element.name).text,
                local: element.name.text,
              });
            }
          }
        }
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const entry = record(node.moduleSpecifier.text, node, "export", !!node.isTypeOnly);

      if (entry && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          entry.names.push({
            imported: (element.propertyName ?? element.name).text,
            local: element.name.text,
          });
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      const entry = record(node.moduleReference.expression.text, node, "require");
      if (entry) entry.defaultLocal = node.name.text;
    } else if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      const spec = node.arguments[0].text;

      if (ts.isIdentifier(callee) && callee.text === "require") {
        const entry = record(spec, node, "require");
        if (entry) bindFromDeclaration(entry, node);
      } else if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        const entry = record(spec, node, "dynamic");
        if (entry) bindFromDeclaration(entry, node);
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression)
      ) {
        const name = `${callee.expression.text}.${callee.name.text}`;
        if (name === "require.resolve") record(spec, node, "require");
        else if (MOCK_CALLEES.has(name)) record(spec, node, "mock");
      }
    }

    ts.forEachChild(node, collect);
  };

  collect(sf);

  for (const entry of usage.imports) {
    for (const item of entry.names) named.set(item.local, entry);
    if (entry.defaultLocal) namespaced.set(entry.defaultLocal, entry);
    if (entry.namespaceLocal) namespaced.set(entry.namespaceLocal, entry);
  }

  if (named.size === 0 && namespaced.size === 0) return usage;

  const jsxFrom = (node: ts.JsxOpeningElement | ts.JsxSelfClosingElement) => {
    const tag = node.tagName;
    let local: string | undefined;
    let member: string | undefined;

    if (ts.isIdentifier(tag)) {
      local = tag.text;
    } else if (ts.isPropertyAccessExpression(tag) && ts.isIdentifier(tag.expression)) {
      local = tag.expression.text;
      member = tag.name.text;
    }

    if (!local || (!named.has(local) && !namespaced.has(local))) return;

    const props = new Map<string, number>();
    for (const property of node.attributes.properties) {
      if (ts.isJsxAttribute(property)) props.set(property.name.getText(sf), lineOf(sf, property));
    }

    usage.jsx.push({ local, member, line: lineOf(sf, node), props });
  };

  const walk = (node: ts.Node) => {
    if (ts.isTypeNode(node)) return;

    if (ts.isIdentifier(node)) {
      if ((named.has(node.text) || namespaced.has(node.text)) && isReferenceIdentifier(node)) {
        addLine(usage.refs, node.text, lineOf(sf, node));
      }
      return;
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaced.has(node.expression.text)
    ) {
      const members = usage.members.get(node.expression.text) ?? new Map<string, number[]>();
      addLine(members, node.name.text, lineOf(sf, node));
      usage.members.set(node.expression.text, members);
    }

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) jsxFrom(node);

    ts.forEachChild(node, walk);
  };

  walk(sf);
  return usage;
}

function linesOf(file: FileUsage): string[] {
  if (!file.lines) file.lines = file.text.split(/\r?\n/);
  return file.lines;
}

function lineAtIndex(file: FileUsage, index: number): number {
  if (!file.lineStarts) {
    file.lineStarts = [0];
    for (let i = 0; i < file.text.length; i++) {
      if (file.text.charCodeAt(i) === 10) file.lineStarts.push(i + 1);
    }
  }

  let low = 0;
  let high = file.lineStarts.length - 1;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (file.lineStarts[middle] <= index) low = middle;
    else high = middle - 1;
  }

  return low + 1;
}

/* -------------------------------------------------------------------------- */
/*  Breaking-change rules                                                     */
/* -------------------------------------------------------------------------- */

type Matcher =
  /** A named import, or a member of a default or namespace import. */
  | { kind: "api"; names?: string[]; subpaths?: string[] }
  /** The package is loaded with require(). */
  | { kind: "require"; tsImportsToo?: boolean }
  /** A prop on a component imported from the package. */
  | { kind: "jsx-prop"; tag: string; props: string[] }
  /** A pattern in files that import the package, or in all source files. */
  | { kind: "text"; pattern: RegExp; scope: "importers" | "all-source"; fullText?: boolean }
  /** A file with a matching path exists. */
  | { kind: "file"; pattern: RegExp }
  /** A pattern inside files with matching paths. */
  | { kind: "config-text"; files: RegExp; pattern: RegExp };

interface UpgradeRule {
  id: string;
  packages: string[];
  /** First version that contains the change. */
  breaksIn: string;
  title: string;
  severity: Severity;
  description: string;
  match: Matcher;
  before?: string;
  after?: string;
  docs?: string;
  /** Rule ids that already cover this one when they also apply. */
  supersededBy?: string[];
  /** The change is harmless on this Node range. */
  unlessNode?: string;
}

const ESM_ONLY: Array<[string, string]> = [
  ["chalk", "5.0.0"],
  ["nanoid", "4.0.0"],
  ["execa", "6.0.0"],
  ["got", "12.0.0"],
  ["node-fetch", "3.0.0"],
  ["p-limit", "4.0.0"],
  ["p-map", "5.0.0"],
  ["ora", "6.0.0"],
  ["globby", "12.0.0"],
  ["del", "7.0.0"],
  ["find-up", "6.0.0"],
  ["strip-ansi", "7.0.0"],
  ["string-width", "5.0.0"],
  ["wrap-ansi", "8.0.0"],
];

const ESM_RULES: UpgradeRule[] = ESM_ONLY.map(([name, version]) => ({
  id: `${name}-esm-only`,
  packages: [name],
  breaksIn: version,
  title: `${name} ${version.split(".")[0]} only works as an ES module`,
  severity: "high",
  description: `From ${version}, ${name} no longer ships CommonJS. Loading it with require() fails with ERR_REQUIRE_ESM on older Node versions. TypeScript projects that compile to CommonJS turn import statements into require() calls, so they fail the same way.`,
  match: { kind: "require", tsImportsToo: true },
  before: `const ${name.replace(/[^a-zA-Z]/g, "")} = require("${name}");`,
  after: `// Option 1: make the project ESM ("type": "module") and use import\nimport ${name.replace(/[^a-zA-Z]/g, "")} from "${name}";\n\n// Option 2: load it with a dynamic import\nconst { default: ${name.replace(/[^a-zA-Z]/g, "")} } = await import("${name}");\n\n// Option 3: stay on the previous major`,
  unlessNode: ">=22.12.0",
}));

const RULES: UpgradeRule[] = [
  /* ---- React ---- */
  {
    id: "react-dom-render-removed",
    packages: ["react-dom"],
    breaksIn: "19.0.0",
    title: "ReactDOM.render and ReactDOM.hydrate were removed",
    severity: "critical",
    description:
      "React 19 no longer includes the legacy root API. An app that still calls ReactDOM.render or ReactDOM.hydrate fails when it starts.",
    match: { kind: "api", names: ["render", "hydrate"], subpaths: [""] },
    before: `import ReactDOM from "react-dom";\n\nReactDOM.render(<App />, document.getElementById("root"));`,
    after: `import { createRoot } from "react-dom/client";\n\ncreateRoot(document.getElementById("root")!).render(<App />);`,
    docs: "https://react.dev/blog/2024/04/25/react-19-upgrade-guide",
  },
  {
    id: "react-dom-unmount-removed",
    packages: ["react-dom"],
    breaksIn: "19.0.0",
    title: "unmountComponentAtNode and findDOMNode were removed",
    severity: "high",
    description:
      "Both functions are gone in React 19. Keep the root returned by createRoot and call root.unmount(), and use refs instead of findDOMNode.",
    match: { kind: "api", names: ["unmountComponentAtNode", "findDOMNode"], subpaths: [""] },
    before: `ReactDOM.unmountComponentAtNode(container);\nconst node = ReactDOM.findDOMNode(this);`,
    after: `root.unmount();\nconst node = this.myRef.current;`,
    docs: "https://react.dev/blog/2024/04/25/react-19-upgrade-guide",
  },
  {
    id: "react-dom-render-legacy",
    packages: ["react-dom"],
    breaksIn: "18.0.0",
    title: "ReactDOM.render runs in legacy mode",
    severity: "medium",
    description:
      "React 18 still runs ReactDOM.render but logs a warning and turns off concurrent features, including automatic batching outside event handlers. Switch to createRoot.",
    match: { kind: "api", names: ["render", "hydrate", "unmountComponentAtNode"], subpaths: [""] },
    before: `ReactDOM.render(<App />, container);`,
    after: `import { createRoot } from "react-dom/client";\n\ncreateRoot(container).render(<App />);`,
    supersededBy: ["react-dom-render-removed", "react-dom-unmount-removed"],
  },
  {
    id: "react-proptypes-defaultprops",
    packages: ["react"],
    breaksIn: "19.0.0",
    title: "propTypes and defaultProps stop working on function components",
    severity: "medium",
    description:
      "React 19 ignores propTypes and no longer supports defaultProps on function components. Class components keep defaultProps, so matches inside classes can be ignored.",
    match: { kind: "text", pattern: /\.(propTypes|defaultProps)\s*=/, scope: "importers" },
    before: `function Button({ size }) { /* ... */ }\nButton.defaultProps = { size: "md" };`,
    after: `function Button({ size = "md" }: { size?: string }) { /* ... */ }`,
    docs: "https://react.dev/blog/2024/04/25/react-19-upgrade-guide",
  },
  {
    id: "react-string-refs",
    packages: ["react"],
    breaksIn: "19.0.0",
    title: "String refs were removed",
    severity: "high",
    description: "ref=\"name\" is not supported in React 19. Use useRef, createRef, or a callback ref.",
    match: { kind: "text", pattern: /\bref\s*=\s*["']/, scope: "importers" },
    before: `<input ref="email" />`,
    after: `const emailRef = useRef(null);\n<input ref={emailRef} />`,
  },
  {
    id: "react-legacy-context",
    packages: ["react"],
    breaksIn: "19.0.0",
    title: "Legacy context was removed",
    severity: "high",
    description:
      "contextTypes, childContextTypes and getChildContext no longer work. Use createContext and useContext.",
    match: { kind: "text", pattern: /\b(contextTypes|childContextTypes|getChildContext)\b/, scope: "importers" },
  },
  {
    id: "react-create-factory",
    packages: ["react"],
    breaksIn: "19.0.0",
    title: "React.createFactory was removed",
    severity: "medium",
    description: "Use JSX or React.createElement instead.",
    match: { kind: "api", names: ["createFactory"], subpaths: [""] },
    before: `const factory = React.createFactory("div");`,
    after: `const element = <div />;`,
  },
  {
    id: "react-dom-test-utils",
    packages: ["react-dom"],
    breaksIn: "19.0.0",
    title: "react-dom/test-utils helpers were removed",
    severity: "medium",
    description:
      "Most helpers in react-dom/test-utils are gone, and act now comes from the react package.",
    match: { kind: "api", subpaths: ["test-utils"] },
    before: `import { act } from "react-dom/test-utils";`,
    after: `import { act } from "react";`,
    docs: "https://react.dev/blog/2024/04/25/react-19-upgrade-guide",
  },
  {
    id: "react-test-renderer-shallow",
    packages: ["react-test-renderer"],
    breaksIn: "19.0.0",
    title: "react-test-renderer/shallow was removed",
    severity: "high",
    description:
      "The shallow renderer was removed from react-test-renderer in React 19. Use React Testing Library to test rendered output.",
    match: { kind: "api", subpaths: ["shallow"] },
  },

  /* ---- React Router ---- */
  {
    id: "router-v5-api",
    packages: ["react-router-dom", "react-router"],
    breaksIn: "6.0.0",
    title: "React Router v5 APIs were removed",
    severity: "high",
    description:
      "Switch, Redirect, useHistory, useRouteMatch, withRouter and Prompt do not exist in v6. They became Routes, Navigate, useNavigate and useMatch.",
    match: {
      kind: "api",
      names: ["Switch", "Redirect", "useHistory", "useRouteMatch", "withRouter", "Prompt"],
      subpaths: [""],
    },
    before: `import { Switch, Redirect, useHistory } from "react-router-dom";\nconst history = useHistory();\nhistory.push("/home");`,
    after: `import { Routes, Navigate, useNavigate } from "react-router-dom";\nconst navigate = useNavigate();\nnavigate("/home");`,
    docs: "https://reactrouter.com/en/main/upgrading/v5",
  },
  {
    id: "router-v5-route-props",
    packages: ["react-router-dom", "react-router"],
    breaksIn: "6.0.0",
    title: "<Route component>, render and exact no longer exist",
    severity: "high",
    description:
      "In v6 a route takes an element, matching is exact by default, and render props were removed.",
    match: { kind: "jsx-prop", tag: "Route", props: ["component", "render", "exact"] },
    before: `<Route exact path="/about" component={About} />`,
    after: `<Route path="/about" element={<About />} />`,
    docs: "https://reactrouter.com/en/main/upgrading/v5",
  },

  /* ---- Express ---- */
  {
    id: "express-app-del",
    packages: ["express"],
    breaksIn: "5.0.0",
    title: "app.del() was removed",
    severity: "high",
    description: "Express 5 only has app.delete().",
    match: { kind: "text", pattern: /\bapp\.del\s*\(/, scope: "importers" },
    before: `app.del("/items/:id", handler);`,
    after: `app.delete("/items/:id", handler);`,
    docs: "https://expressjs.com/en/guide/migrating-5.html",
  },
  {
    id: "express-req-param",
    packages: ["express"],
    breaksIn: "5.0.0",
    title: "req.param() was removed",
    severity: "high",
    description: "Read the value from req.params, req.body or req.query explicitly.",
    match: { kind: "text", pattern: /\breq\.param\s*\(/, scope: "importers" },
    before: `const id = req.param("id");`,
    after: `const id = req.params.id;`,
    docs: "https://expressjs.com/en/guide/migrating-5.html",
  },
  {
    id: "express-status-argument",
    packages: ["express"],
    breaksIn: "5.0.0",
    title: "A status code can no longer be the first argument of send, json or jsonp",
    severity: "high",
    description: "Set the status first with res.status().",
    match: { kind: "text", pattern: /\bres\.(send|json|jsonp)\(\s*\d{3}\s*[,)]/, scope: "importers" },
    before: `res.send(404, "Not found");\nres.json(500, { error });`,
    after: `res.status(404).send("Not found");\nres.status(500).json({ error });`,
    docs: "https://expressjs.com/en/guide/migrating-5.html",
  },
  {
    id: "express-redirect-back",
    packages: ["express"],
    breaksIn: "5.0.0",
    title: "res.redirect(\"back\") was removed",
    severity: "medium",
    description: "Redirect to the Referer header explicitly.",
    match: { kind: "text", pattern: /\bres\.redirect\(\s*['"]back['"]/, scope: "importers" },
    before: `res.redirect("back");`,
    after: `res.redirect(req.get("Referrer") || "/");`,
    docs: "https://expressjs.com/en/guide/migrating-5.html",
  },
  {
    id: "express-sendfile",
    packages: ["express"],
    breaksIn: "5.0.0",
    title: "res.sendfile() was removed",
    severity: "high",
    description: "Use res.sendFile() with an absolute path.",
    match: { kind: "text", pattern: /\bres\.sendfile\s*\(/, scope: "importers" },
    before: `res.sendfile(file);`,
    after: `res.sendFile(path.resolve(file));`,
  },
  {
    id: "express-path-syntax",
    packages: ["express"],
    breaksIn: "5.0.0",
    title: "Route paths use a stricter syntax",
    severity: "medium",
    description:
      "Express 5 uses path-to-regexp 8. A bare * must be named, optional parameters use braces, and regular-expression groups in a path string are not supported.",
    match: {
      kind: "text",
      pattern: /\.(get|post|put|patch|delete|all|use)\(\s*['"`][^'"`]*(?:\*|\([^'"`]*\)|\w\?)/,
      scope: "importers",
    },
    before: `app.get("*", handler);\napp.get("/user/:id?", handler);`,
    after: `app.get("/*splat", handler);\napp.get("/user{/:id}", handler);`,
    docs: "https://expressjs.com/en/guide/migrating-5.html",
  },

  /* ---- TanStack Query ---- */
  {
    id: "tanstack-object-signature",
    packages: ["@tanstack/react-query"],
    breaksIn: "5.0.0",
    title: "useQuery(key, fn, options) was replaced by a single options object",
    severity: "high",
    description: "Version 5 only accepts the object form for queries.",
    match: { kind: "text", pattern: /\b(?:useQuery|useInfiniteQuery)\s*\(\s*(?:\[|['"`])/, scope: "importers" },
    before: `useQuery(["todos"], fetchTodos, { staleTime: 5000 });`,
    after: `useQuery({ queryKey: ["todos"], queryFn: fetchTodos, staleTime: 5000 });`,
    docs: "https://tanstack.com/query/v5/docs/framework/react/guides/migrating-to-v5",
  },
  {
    id: "tanstack-cachetime",
    packages: ["@tanstack/react-query"],
    breaksIn: "5.0.0",
    title: "cacheTime was renamed gcTime",
    severity: "medium",
    description: "The option still exists under a new name, and the old name is ignored.",
    match: { kind: "text", pattern: /\bcacheTime\b/, scope: "importers" },
    before: `cacheTime: 1000 * 60 * 5`,
    after: `gcTime: 1000 * 60 * 5`,
    docs: "https://tanstack.com/query/v5/docs/framework/react/guides/migrating-to-v5",
  },
  {
    id: "tanstack-keep-previous-data",
    packages: ["@tanstack/react-query"],
    breaksIn: "5.0.0",
    title: "keepPreviousData became placeholderData",
    severity: "medium",
    description: "Use placeholderData with the keepPreviousData helper.",
    match: { kind: "text", pattern: /\bkeepPreviousData\b/, scope: "importers" },
    before: `useQuery({ queryKey, queryFn, keepPreviousData: true });`,
    after: `import { keepPreviousData } from "@tanstack/react-query";\n\nuseQuery({ queryKey, queryFn, placeholderData: keepPreviousData });`,
    docs: "https://tanstack.com/query/v5/docs/framework/react/guides/migrating-to-v5",
  },
  {
    id: "tanstack-query-callbacks",
    packages: ["@tanstack/react-query"],
    breaksIn: "5.0.0",
    title: "onSuccess, onError and onSettled were removed from useQuery",
    severity: "medium",
    description:
      "Queries no longer take these callbacks (mutations still do). Move the logic into an effect or into the component that reads the data.",
    match: {
      kind: "text",
      pattern: /\buseQuery\s*\(\s*\{[^;]{0,400}?\bon(?:Success|Error|Settled)\s*:/g,
      scope: "importers",
      fullText: true,
    },
    docs: "https://tanstack.com/query/v5/docs/framework/react/guides/migrating-to-v5",
  },
  {
    id: "tanstack-is-loading",
    packages: ["@tanstack/react-query"],
    breaksIn: "5.0.0",
    title: "isLoading changed meaning and the loading status became pending",
    severity: "low",
    description:
      "isLoading is now isFetching and isPending together. For \"no data yet\" use isPending.",
    match: { kind: "text", pattern: /\bisLoading\b/, scope: "importers" },
  },
  {
    id: "tanstack-error-boundary",
    packages: ["@tanstack/react-query"],
    breaksIn: "5.0.0",
    title: "useErrorBoundary was renamed throwOnError",
    severity: "medium",
    description: "Rename the option.",
    match: { kind: "text", pattern: /\buseErrorBoundary\b/, scope: "importers" },
  },

  /* ---- Redux Toolkit ---- */
  {
    id: "rtk-extrareducers-object",
    packages: ["@reduxjs/toolkit"],
    breaksIn: "2.0.0",
    title: "The object form of extraReducers was removed",
    severity: "high",
    description: "Use the builder callback.",
    match: { kind: "text", pattern: /\bextraReducers\s*:\s*\{/, scope: "importers" },
    before: `extraReducers: {\n  [fetchUser.fulfilled]: (state, action) => { /* ... */ },\n}`,
    after: `extraReducers: (builder) => {\n  builder.addCase(fetchUser.fulfilled, (state, action) => { /* ... */ });\n}`,
    docs: "https://redux-toolkit.js.org/usage/migrating-rtk-2",
  },
  {
    id: "rtk-createreducer-object",
    packages: ["@reduxjs/toolkit"],
    breaksIn: "2.0.0",
    title: "The object form of createReducer was removed",
    severity: "high",
    description: "Use the builder callback.",
    match: { kind: "text", pattern: /\bcreateReducer\s*\(\s*[\w.$]+\s*,\s*\{/, scope: "importers" },
    docs: "https://redux-toolkit.js.org/usage/migrating-rtk-2",
  },
  {
    id: "rtk-middleware-array",
    packages: ["@reduxjs/toolkit"],
    breaksIn: "2.0.0",
    title: "configureStore no longer accepts a middleware array",
    severity: "high",
    description: "Pass a callback that receives getDefaultMiddleware.",
    match: {
      kind: "text",
      pattern: /\bconfigureStore\s*\([\s\S]{0,500}?\bmiddleware\s*:\s*\[/g,
      scope: "importers",
      fullText: true,
    },
    before: `configureStore({ reducer, middleware: [logger] });`,
    after: `configureStore({\n  reducer,\n  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(logger),\n});`,
    docs: "https://redux-toolkit.js.org/usage/migrating-rtk-2",
  },

  /* ---- Mongoose ---- */
  {
    id: "mongoose-removed-options",
    packages: ["mongoose"],
    breaksIn: "6.0.0",
    title: "useCreateIndex and useFindAndModify were removed",
    severity: "high",
    description: "Mongoose 6 throws when these connection options are passed.",
    match: { kind: "text", pattern: /\b(useCreateIndex|useFindAndModify)\b/, scope: "importers" },
    docs: "https://mongoosejs.com/docs/migrating_to_6.html",
  },
  {
    id: "mongoose-unneeded-options",
    packages: ["mongoose"],
    breaksIn: "6.0.0",
    title: "useNewUrlParser and useUnifiedTopology are no longer needed",
    severity: "low",
    description: "They are always on in Mongoose 6, so they can be deleted.",
    match: { kind: "text", pattern: /\b(useNewUrlParser|useUnifiedTopology)\b/, scope: "importers" },
  },
  {
    id: "mongoose-callbacks",
    packages: ["mongoose"],
    breaksIn: "7.0.0",
    title: "Callbacks were removed from Mongoose functions",
    severity: "high",
    description: "Model and query methods return promises. Use async and await.",
    match: {
      kind: "text",
      pattern: /(?:function\s*\(\s*(?:err|error)\b|\(\s*(?:err|error)\s*(?:,\s*[\w$]+)?\s*\)\s*=>)/,
      scope: "importers",
    },
    before: `User.find({}, function (err, users) { /* ... */ });`,
    after: `const users = await User.find({});`,
    docs: "https://mongoosejs.com/docs/migrating_to_7.html",
  },

  /* ---- TypeScript ---- */
  {
    id: "typescript-deprecated-options",
    packages: ["typescript"],
    breaksIn: "5.0.0",
    title: "Deprecated compiler options report errors",
    severity: "high",
    description:
      "TypeScript 5.0 deprecated these tsconfig options. They produce an error unless \"ignoreDeprecations\": \"5.0\" is set, and TypeScript 5.5 removes them.",
    match: {
      kind: "config-text",
      files: /(^|\/)tsconfig[^/]*\.json$/,
      pattern: /"(importsNotUsedAsValues|preserveValueImports|suppressImplicitAnyIndexErrors|noImplicitUseStrict|keyofStringsOnly|noStrictGenericChecks|suppressExcessPropertyErrors|charset|out)"\s*:/,
    },
    docs: "https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-0.html",
  },
  {
    id: "typescript-target-es3",
    packages: ["typescript"],
    breaksIn: "5.0.0",
    title: "target ES3 was removed",
    severity: "medium",
    description: "Use ES5 or newer.",
    match: { kind: "config-text", files: /(^|\/)tsconfig[^/]*\.json$/, pattern: /"target"\s*:\s*"es3"/i },
  },

  /* ---- ESLint ---- */
  {
    id: "eslint-eslintrc",
    packages: ["eslint"],
    breaksIn: "9.0.0",
    title: "ESLint 9 does not read .eslintrc files",
    severity: "high",
    description:
      "Flat config (eslint.config.js) is the default. A legacy .eslintrc file is ignored unless ESLINT_USE_FLAT_CONFIG=false is set.",
    match: { kind: "file", pattern: /(^|\/)\.eslintrc(\.(js|cjs|json|yml|yaml))?$/ },
    docs: "https://eslint.org/docs/latest/use/migrate-to-9.0.0",
  },
  {
    id: "eslint-package-config",
    packages: ["eslint"],
    breaksIn: "9.0.0",
    title: "The eslintConfig field in package.json is ignored",
    severity: "high",
    description: "Move the configuration to eslint.config.js.",
    match: { kind: "config-text", files: /(^|\/)package\.json$/, pattern: /"eslintConfig"\s*:/ },
    docs: "https://eslint.org/docs/latest/use/migrate-to-9.0.0",
  },
  {
    id: "eslint-eslintignore",
    packages: ["eslint"],
    breaksIn: "9.0.0",
    title: ".eslintignore is no longer read",
    severity: "medium",
    description: "Move the patterns into the ignores setting of eslint.config.js.",
    match: { kind: "file", pattern: /(^|\/)\.eslintignore$/ },
    docs: "https://eslint.org/docs/latest/use/migrate-to-9.0.0",
  },

  /* ---- Tailwind CSS ---- */
  {
    id: "tailwind-directives",
    packages: ["tailwindcss"],
    breaksIn: "4.0.0",
    title: "@tailwind directives were replaced by @import",
    severity: "high",
    description: "Tailwind 4 loads its layers with a single import.",
    match: { kind: "config-text", files: /\.(css|scss|pcss)$/, pattern: /@tailwind\s+(base|components|utilities)\b/ },
    before: `@tailwind base;\n@tailwind components;\n@tailwind utilities;`,
    after: `@import "tailwindcss";`,
    docs: "https://tailwindcss.com/docs/upgrade-guide",
  },
  {
    id: "tailwind-postcss-plugin",
    packages: ["tailwindcss"],
    breaksIn: "4.0.0",
    title: "The PostCSS plugin moved to @tailwindcss/postcss",
    severity: "high",
    description: "tailwindcss can no longer be used directly as a PostCSS plugin.",
    match: {
      kind: "config-text",
      files: /(^|\/)(postcss\.config\.[cm]?js|\.postcssrc[^/]*)$/,
      pattern: /\btailwindcss\b/,
    },
    before: `plugins: { tailwindcss: {}, autoprefixer: {} }`,
    after: `plugins: { "@tailwindcss/postcss": {} }`,
    docs: "https://tailwindcss.com/docs/upgrade-guide",
  },
  {
    id: "tailwind-config-file",
    packages: ["tailwindcss"],
    breaksIn: "4.0.0",
    title: "tailwind.config.js is no longer picked up automatically",
    severity: "medium",
    description: "Configuration now lives in CSS. To keep using the file, load it with @config.",
    match: { kind: "file", pattern: /(^|\/)tailwind\.config\.[cm]?[jt]s$/ },
    after: `@import "tailwindcss";\n@config "../tailwind.config.js";`,
    docs: "https://tailwindcss.com/docs/upgrade-guide",
  },
  {
    id: "tailwind-opacity-utilities",
    packages: ["tailwindcss"],
    breaksIn: "4.0.0",
    title: "The *-opacity-* utilities were removed",
    severity: "medium",
    description: "Use the slash syntax, for example bg-black/50.",
    match: { kind: "text", pattern: /\b(?:bg|text|border|divide|ring|placeholder)-opacity-\d+/, scope: "all-source" },
    before: `<div class="bg-black bg-opacity-50">`,
    after: `<div class="bg-black/50">`,
  },
  {
    id: "tailwind-renamed-utilities",
    packages: ["tailwindcss"],
    breaksIn: "4.0.0",
    title: "flex-shrink-* and flex-grow-* were renamed",
    severity: "low",
    description: "Use shrink-* and grow-*.",
    match: { kind: "text", pattern: /\bflex-(?:shrink|grow)(?:-\d+)?\b/, scope: "all-source" },
  },
  {
    id: "tailwind-outline-none",
    packages: ["tailwindcss"],
    breaksIn: "4.0.0",
    title: "outline-none now removes the outline completely",
    severity: "low",
    description: "For the old behavior, which keeps a focus outline for high-contrast mode, use outline-hidden.",
    match: { kind: "text", pattern: /\boutline-none\b/, scope: "all-source" },
  },

  /* ---- Next.js ---- */
  {
    id: "next-link-anchor",
    packages: ["next"],
    breaksIn: "13.0.0",
    title: "<Link> no longer needs a child <a>",
    severity: "medium",
    description: "Link renders the anchor itself in Next 13, and a nested <a> is an error unless legacyBehavior is set.",
    match: { kind: "text", pattern: /<Link\b[^>]*>\s*<a\b/g, scope: "importers", fullText: true },
    before: `<Link href="/about"><a>About</a></Link>`,
    after: `<Link href="/about">About</Link>`,
  },
  {
    id: "next-export-command",
    packages: ["next"],
    breaksIn: "14.0.0",
    title: "The next export command was removed",
    severity: "high",
    description: "Set output: \"export\" in next.config.js and run next build.",
    match: { kind: "config-text", files: /(^|\/)package\.json$/, pattern: /\bnext export\b/ },
  },
  {
    id: "next-async-request-apis",
    packages: ["next"],
    breaksIn: "15.0.0",
    title: "cookies(), headers() and draftMode() are asynchronous",
    severity: "medium",
    description: "They return promises in Next 15. Synchronous access still works with a warning for now, and is removed later.",
    match: { kind: "api", names: ["cookies", "headers", "draftMode"], subpaths: ["headers"] },
    before: `const token = cookies().get("token");`,
    after: `const token = (await cookies()).get("token");`,
    docs: "https://nextjs.org/docs/app/building-your-application/upgrading/version-15",
  },

  /* ---- Build tools and formatting ---- */
  {
    id: "vite-cjs-api",
    packages: ["vite"],
    breaksIn: "5.0.0",
    title: "Vite's CommonJS Node API is deprecated",
    severity: "low",
    description: "Loading Vite with require() prints a deprecation warning. Use an ESM config (vite.config.mjs or \"type\": \"module\").",
    match: { kind: "require" },
  },
  {
    id: "prettier-format-async",
    packages: ["prettier"],
    breaksIn: "3.0.0",
    title: "prettier.format returns a promise",
    severity: "medium",
    description: "Code that uses the formatted result without await gets a Promise.",
    match: { kind: "text", pattern: /(?<!await\s+)\bprettier\.format\s*\(/, scope: "importers" },
    before: `const output = prettier.format(code, options);`,
    after: `const output = await prettier.format(code, options);`,
  },
  {
    id: "webpack-node-empty",
    packages: ["webpack"],
    breaksIn: "5.0.0",
    title: "node: { fs: \"empty\" } is no longer valid",
    severity: "high",
    description: "Webpack 5 no longer polyfills Node modules. Use resolve.fallback with false or a browser package.",
    match: { kind: "config-text", files: /(^|\/)webpack[^/]*\.config\.[cm]?js$/, pattern: /\bnode\s*:\s*\{[^}]*['"]empty['"]/ },
    before: `node: { fs: "empty" }`,
    after: `resolve: { fallback: { fs: false } }`,
  },
];

const ALL_RULES: UpgradeRule[] = [...RULES, ...ESM_RULES];

interface Notice {
  package: string;
  severity: Severity;
  title: string;
  description: string;
}

const NOTICES: Notice[] = [
  { package: "react-query", severity: "medium", title: "react-query was renamed", description: "Versions after 3.x are published as @tanstack/react-query. The old package is no longer developed." },
  { package: "@material-ui/core", severity: "medium", title: "Material-UI was renamed", description: "Version 5 and later are published as @mui/material. The old package no longer receives updates." },
  { package: "request", severity: "high", title: "request is deprecated", description: "It has not been maintained since 2020. Use the built-in fetch, undici, got or axios." },
  { package: "node-sass", severity: "medium", title: "node-sass is deprecated", description: "Use the sass package (Dart Sass) instead." },
  { package: "tslint", severity: "medium", title: "TSLint is deprecated", description: "Use ESLint with typescript-eslint instead." },
  { package: "babel-eslint", severity: "medium", title: "babel-eslint is deprecated", description: "Use @babel/eslint-parser instead." },
  { package: "@babel/polyfill", severity: "medium", title: "@babel/polyfill is deprecated", description: "Use core-js and regenerator-runtime directly." },
  { package: "node-uuid", severity: "medium", title: "node-uuid is deprecated", description: "Use the uuid package instead." },
  { package: "enzyme", severity: "medium", title: "Enzyme has no official adapter for React 17 or newer", description: "Plan a move to React Testing Library before upgrading React." },
  { package: "moment", severity: "low", title: "Moment is in maintenance mode", description: "It still works, but its maintainers recommend newer libraries such as date-fns, Luxon or Day.js for new code." },
];

/* -------------------------------------------------------------------------- */
/*  Evaluating rules against the project                                      */
/* -------------------------------------------------------------------------- */

interface Hit {
  filePath: string;
  line: number;
  snippet: string;
}

interface Importer {
  file: FileUsage;
  record: ImportRecord;
}

interface ProjectContext {
  root: string;
  files: ProjectFile[];
  usages: FileUsage[];
  importers: Map<string, Importer[]>;
  /** True when TypeScript compiles imports to require(). */
  cjsEmit: boolean;
}

function hitAt(file: FileUsage, line: number): Hit {
  return { filePath: file.filePath, line, snippet: clip(linesOf(file)[line - 1] ?? "") };
}

function findHits(rule: UpgradeRule, pkg: string, context: ProjectContext): Hit[] {
  const hits: Hit[] = [];
  const seen = new Set<string>();

  const add = (hit: Hit) => {
    const key = `${hit.filePath}:${hit.line}`;
    if (seen.has(key) || hits.length >= MAX_HITS_PER_RULE) return;
    seen.add(key);
    hits.push(hit);
  };

  const importers = context.importers.get(pkg) ?? [];
  const match = rule.match;

  switch (match.kind) {
    case "api": {
      for (const { file, record } of importers) {
        if (record.typeOnly) continue;
        if (match.subpaths && !match.subpaths.includes(record.subpath)) continue;

        if (!match.names || match.names.length === 0) {
          add(hitAt(file, record.line));
          continue;
        }

        for (const item of record.names) {
          if (!match.names.includes(item.imported)) continue;

          const lines = (file.refs.get(item.local) ?? []).filter((line) => line !== record.line);
          if (lines.length === 0) add(hitAt(file, record.line));
          for (const line of lines) add(hitAt(file, line));
        }

        for (const local of [record.defaultLocal, record.namespaceLocal]) {
          if (!local) continue;
          const members = file.members.get(local);
          for (const name of match.names) {
            for (const line of members?.get(name) ?? []) add(hitAt(file, line));
          }
        }
      }
      break;
    }

    case "require": {
      for (const { file, record } of importers) {
        const viaRequire = record.kind === "require";
        const viaCompiledImport =
          !!match.tsImportsToo &&
          context.cjsEmit &&
          record.kind === "import" &&
          !record.typeOnly &&
          /\.(ts|tsx|cts)$/.test(file.filePath);

        if (viaRequire || viaCompiledImport) add(hitAt(file, record.line));
      }
      break;
    }

    case "jsx-prop": {
      for (const { file, record } of importers) {
        const named = record.names.filter((item) => item.imported === match.tag).map((item) => item.local);
        const namespaces = [record.defaultLocal, record.namespaceLocal].filter(
          (local): local is string => !!local,
        );

        for (const use of file.jsx) {
          const matches =
            (named.includes(use.local) && use.member === undefined) ||
            (namespaces.includes(use.local) && use.member === match.tag);
          if (!matches) continue;

          for (const prop of match.props) {
            const line = use.props.get(prop);
            if (line !== undefined) add(hitAt(file, line));
          }
        }
      }
      break;
    }

    case "text": {
      const files =
        match.scope === "all-source"
          ? context.usages
          : [...new Set(importers.map((item) => item.file))];

      for (const file of files) {
        if (match.fullText) {
          const pattern = new RegExp(match.pattern.source, match.pattern.flags.includes("g") ? match.pattern.flags : `${match.pattern.flags}g`);
          for (const found of file.text.matchAll(pattern)) {
            if (found.index !== undefined) add(hitAt(file, lineAtIndex(file, found.index)));
          }
        } else {
          const pattern = new RegExp(match.pattern.source, match.pattern.flags.replace("g", ""));
          const lines = linesOf(file);
          for (let index = 0; index < lines.length; index++) {
            if (lines[index].length < 4000 && pattern.test(lines[index])) add(hitAt(file, index + 1));
          }
        }
      }
      break;
    }

    case "file": {
      for (const file of context.files) {
        if (match.pattern.test(file.rel)) {
          add({ filePath: file.rel, line: 1, snippet: path.posix.basename(file.rel) });
        }
      }
      break;
    }

    case "config-text": {
      for (const file of context.files) {
        if (!match.files.test(file.rel) || file.size > MAX_FILE_BYTES) continue;

        const text = readText(file.abs);
        if (!text) continue;

        const pattern = new RegExp(match.pattern.source, match.pattern.flags.replace("g", ""));
        const lines = text.split(/\r?\n/);

        for (let index = 0; index < lines.length; index++) {
          if (lines[index].length < 4000 && pattern.test(lines[index])) {
            add({ filePath: file.rel, line: index + 1, snippet: clip(lines[index]) });
          }
        }
      }
      break;
    }

    default:
      break;
  }

  return hits.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line);
}

function evaluateRules(
  pkg: string,
  installed: Ver,
  target: Ver,
  context: ProjectContext,
  node: { version: string; declared: boolean },
): BreakingChange[] {
  const crossed = ALL_RULES.filter((rule) => {
    if (!rule.packages.includes(pkg)) return false;
    const breaksIn = parseVersion(rule.breaksIn);
    return (
      !!breaksIn &&
      compareVersions(installed, breaksIn) < 0 &&
      compareVersions(target, breaksIn) >= 0
    );
  });

  const crossedIds = new Set(crossed.map((rule) => rule.id));
  const results: BreakingChange[] = [];

  for (const rule of crossed) {
    if (rule.supersededBy?.some((id) => crossedIds.has(id))) continue;

    const hits = findHits(rule, pkg, context);
    if (hits.length === 0) continue;

    let severity = rule.severity;
    let description = rule.description;

    if (rule.unlessNode && node.declared && satisfies(node.version, rule.unlessNode)) {
      severity = "low";
      description += ` Your declared Node version (${node.version}) can load ES modules with require(), so this may still work, but only for modules without top-level await.`;
    }

    results.push({
      id: rule.id,
      title: rule.title,
      severity,
      description,
      breaksIn: rule.breaksIn,
      locations: hits.slice(0, MAX_LOCATIONS),
      hiddenLocations: Math.max(0, hits.length - MAX_LOCATIONS),
      count: hits.length,
      before: rule.before,
      after: rule.after,
      docs: rule.docs,
    });
  }

  return results.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      b.count - a.count ||
      a.title.localeCompare(b.title),
  );
}

/** The lowest version above `installed` that contains a change this tool knows about. */
function nextKnownChange(pkg: string, installed: Ver): string | undefined {
  let best: Ver | undefined;

  for (const rule of ALL_RULES) {
    if (!rule.packages.includes(pkg)) continue;
    const breaksIn = parseVersion(rule.breaksIn);
    if (!breaksIn || compareVersions(breaksIn, installed) <= 0) continue;
    if (!best || compareVersions(breaksIn, best) < 0) best = breaksIn;
  }

  return best ? formatVersion(best) : undefined;
}

/* -------------------------------------------------------------------------- */
/*  Where a package is used                                                   */
/* -------------------------------------------------------------------------- */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildUsage(
  importers: Importer[],
  viaScripts: string[],
  viaConfig: string[],
  mayBeUnused: boolean,
): PackageUsage {
  const files = new Set(importers.map((item) => item.file.filePath));
  const testFiles = new Set(
    importers.filter((item) => item.file.isTest).map((item) => item.file.filePath),
  );

  const apiFiles = new Map<string, Set<string>>();
  const addApi = (name: string, file: string) => {
    const set = apiFiles.get(name) ?? new Set<string>();
    set.add(file);
    apiFiles.set(name, set);
  };

  for (const { file, record } of importers) {
    if (record.subpath) addApi(`/${record.subpath}`, file.filePath);

    for (const item of record.names) {
      if (item.imported !== "default") addApi(item.imported, file.filePath);
    }

    for (const local of [record.defaultLocal, record.namespaceLocal]) {
      if (!local) continue;
      const members = file.members.get(local);
      if (members) for (const member of members.keys()) addApi(member, file.filePath);
    }
  }

  const apis = [...apiFiles.entries()]
    .map(([name, set]) => ({ name, fileCount: set.size }))
    .sort((a, b) => b.fileCount - a.fileCount || a.name.localeCompare(b.name));

  const locations = importers
    .map(
      ({ file, record }): UsageLocation => ({
        filePath: file.filePath,
        line: record.line,
        kind: record.kind,
        isTest: file.isTest,
      }),
    )
    .sort(
      (a, b) =>
        Number(a.isTest) - Number(b.isTest) ||
        a.filePath.localeCompare(b.filePath) ||
        a.line - b.line,
    );

  return {
    fileCount: files.size,
    importCount: importers.length,
    testFileCount: testFiles.size,
    apis: apis.slice(0, MAX_APIS),
    hiddenApis: Math.max(0, apis.length - MAX_APIS),
    locations: locations.slice(0, MAX_LOCATIONS),
    hiddenLocations: Math.max(0, locations.length - MAX_LOCATIONS),
    viaScripts,
    viaConfig,
    unused:
      importers.length === 0 &&
      viaScripts.length === 0 &&
      viaConfig.length === 0 &&
      mayBeUnused,
    typeOnly: importers.length > 0 && importers.every((item) => item.record.typeOnly),
  };
}

/** Maps each command name in package.json scripts to the script names that run it. */
function collectScriptTokens(workspaces: Workspace[]): Map<string, Set<string>> {
  const tokens = new Map<string, Set<string>>();

  for (const workspace of workspaces) {
    for (const [scriptName, command] of Object.entries(workspace.manifest.scripts ?? {})) {
      for (const part of command.split(/&&|\|\||[;|&]/)) {
        for (const raw of part.trim().split(/\s+/)) {
          const token = raw.replace(/^['"]|['"]$/g, "");
          if (!token || token.startsWith("-") || token.includes("=")) continue;

          const set = tokens.get(token) ?? new Set<string>();
          set.add(scriptName);
          tokens.set(token, set);
        }
      }
    }
  }

  return tokens;
}

function configNameForms(name: string): string[] {
  const forms = [name];

  const prefixes: Array<[RegExp, string]> = [
    [/^eslint-plugin-(.+)$/, ""],
    [/^eslint-config-(.+)$/, ""],
    [/^babel-plugin-(.+)$/, ""],
    [/^babel-preset-(.+)$/, ""],
    [/^(@babel)\/plugin-(.+)$/, "@babel/"],
    [/^(@babel)\/preset-(.+)$/, "@babel/"],
    [/^(@[^/]+)\/eslint-plugin(?:-(.+))?$/, "scoped"],
  ];

  for (const [pattern, mode] of prefixes) {
    const match = pattern.exec(name);
    if (!match) continue;

    if (mode === "scoped") forms.push(match[2] ? `${match[1]}/${match[2]}` : match[1]);
    else if (mode === "@babel/") forms.push(`@babel/${match[2]}`);
    else forms.push(match[1]);
  }

  return forms;
}

function implicitlyUsed(name: string, files: ProjectFile[], manifest: Manifest): boolean {
  if (name.startsWith("@types/")) return true;

  const has = (pattern: RegExp) => files.some((file) => pattern.test(file.rel));

  switch (name) {
    case "typescript": return has(/(^|\/)tsconfig[^/]*\.json$/);
    case "husky": return has(/(^|\/)\.husky\//) || "husky" in (manifest as Record<string, unknown>);
    case "lint-staged": return has(/(^|\/)\.lintstagedrc/) || "lint-staged" in (manifest as Record<string, unknown>);
    case "prettier": return has(/(^|\/)(\.prettierrc|prettier\.config)/);
    case "eslint": return has(/(^|\/)(\.eslintrc|eslint\.config)/) || !!manifest.eslintConfig;
    case "tailwindcss": return has(/(^|\/)tailwind\.config\./) || has(/\.css$/);
    case "postcss":
    case "autoprefixer": return has(/(^|\/)(postcss\.config|\.postcssrc)/);
    case "sass": return has(/\.s[ac]ss$/);
    default: return false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Compatibility                                                             */
/* -------------------------------------------------------------------------- */

interface PeerDependent {
  name: string;
  version: string;
  range: string;
  optional: boolean;
}

interface ConflictInput {
  name: string;
  installed?: string;
  target?: string;
  bump: Bump;
  doc?: RegistryDoc;
  installedPkg?: InstalledPackage;
  dependents: PeerDependent[];
  installedMap: Map<string, InstalledPackage>;
  lock: LockInfo;
  node: { version: string; declared: boolean; source: string };
}

function buildConflicts(input: ConflictInput): Conflict[] {
  const conflicts: Conflict[] = [];
  const { name, target, installed, doc } = input;
  const targetInfo = target ? doc?.versions.get(target) : undefined;

  if (target) {
    /* Installed packages that declare a peer dependency on this one. */
    const blocked = input.dependents.filter((item) => !satisfies(target, item.range));

    for (const item of blocked.slice(0, 8)) {
      conflicts.push({
        id: `peer-dependent:${item.name}`,
        kind: "peer-dependent",
        severity: item.optional ? "low" : "high",
        title: `${item.name} does not support ${name} ${target}`,
        description: `${item.name}@${item.version} lists ${name} ${item.range} as a peer dependency${
          item.optional ? " (optional)" : ""
        }. Update it to a release that supports ${name} ${target}, or replace it, before upgrading.`,
        related: item.name,
      });
    }

    if (blocked.length > 8) {
      conflicts.push({
        id: "peer-dependent:more",
        kind: "peer-dependent",
        severity: "high",
        title: `${blocked.length - 8} more installed packages do not support ${name} ${target}`,
        description: `Examples: ${blocked.slice(8, 12).map((item) => item.name).join(", ")}.`,
      });
    }

    /* Peer dependencies of the target version. */
    if (targetInfo) {
      for (const [peer, range] of Object.entries(targetInfo.peers)) {
        if (targetInfo.peerOptional.has(peer) || peer === name) continue;

        const peerVersion =
          input.installedMap.get(peer)?.version ?? input.lock.versions.get(peer);

        if (peerVersion && !satisfies(peerVersion, range)) {
          conflicts.push({
            id: `peer-unmet:${peer}`,
            kind: "peer-unmet",
            severity: "high",
            title: `${name} ${target} needs ${peer} ${range}`,
            description: `${peer} ${peerVersion} is installed. Upgrade ${peer} together with ${name}.`,
            related: peer,
          });
        } else if (!peerVersion) {
          conflicts.push({
            id: `peer-missing:${peer}`,
            kind: "peer-missing",
            severity: "low",
            title: `${name} ${target} needs ${peer} ${range}`,
            description: `${peer} is not installed. npm 7 and later install peer dependencies automatically, but yarn and pnpm only warn.`,
            related: peer,
          });
        }
      }

      /* Node version. */
      if (targetInfo.engineNode && !satisfies(input.node.version, targetInfo.engineNode)) {
        conflicts.push({
          id: "engines",
          kind: "engines",
          severity: input.node.declared ? "high" : "medium",
          title: `${name} ${target} requires Node ${targetInfo.engineNode}`,
          description: `The project uses Node ${input.node.version}${
            input.node.declared
              ? ` (from ${input.node.source})`
              : " (the Node running this tool, because the project does not declare one)"
          }. Raise the Node version first.`,
        });
      }
    }

    /* Matching @types package. */
    if (input.bump === "major") {
      const typesName = `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;
      const typesVersion =
        input.installedMap.get(typesName)?.version ?? input.lock.versions.get(typesName);
      const typesParsed = typesVersion ? parseVersion(typesVersion) ?? coerceVersion(typesVersion) : null;
      const targetParsed = parseVersion(target);

      if (typesParsed && targetParsed && typesParsed.major !== targetParsed.major) {
        conflicts.push({
          id: `types:${typesName}`,
          kind: "types",
          severity: "medium",
          title: `${typesName} is on ${typesParsed.major}.x`,
          description: `${typesName} ${typesVersion} is installed. A matching major version is usually needed after upgrading ${name} to ${targetParsed.major}.x. If ${name} now ships its own types, remove ${typesName}.`,
          related: typesName,
        });
      }
    }

    if (targetInfo?.deprecated) {
      conflicts.push({
        id: "deprecated:target",
        kind: "deprecated",
        severity: "medium",
        title: `${name} ${target} is deprecated`,
        description: clip(targetInfo.deprecated, 240),
      });
    }
  }

  const installedDeprecated =
    input.installedPkg?.deprecated ?? (installed ? doc?.versions.get(installed)?.deprecated : undefined);

  if (installedDeprecated) {
    conflicts.push({
      id: "deprecated:installed",
      kind: "deprecated",
      severity: "medium",
      title: `${name} ${installed ?? ""} is deprecated`.replace("  ", " "),
      description: clip(installedDeprecated, 240),
    });
  }

  for (const notice of NOTICES) {
    if (notice.package !== name) continue;
    conflicts.push({
      id: `notice:${name}`,
      kind: "notice",
      severity: notice.severity,
      title: notice.title,
      description: notice.description,
    });
  }

  return conflicts.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      a.title.localeCompare(b.title),
  );
}

/* -------------------------------------------------------------------------- */
/*  Choosing a target version                                                 */
/* -------------------------------------------------------------------------- */

function resolveTarget(
  name: string,
  installed: string | undefined,
  range: string,
  doc: RegistryDoc | undefined,
  strategy: Strategy,
  override: string | undefined,
): { target?: string; source: TargetSource; warning?: string } {
  const installedVersion = installed ? parseVersion(installed) : null;

  if (override) {
    const tagged = doc?.tags[override];
    if (tagged) return { target: tagged, source: "override" };

    const exact = parseVersion(override);
    if (exact) {
      const clean = formatVersion(exact);
      const warning =
        doc && !doc.versions.has(clean)
          ? `${name}@${clean} was not found on the registry.`
          : undefined;
      return { target: clean, source: "override", warning };
    }

    if (doc) {
      const best = maxSatisfying(allStableVersions(doc), override);
      if (best) return { target: best, source: "override" };
      return { source: "none", warning: `No version of ${name} matches "${override}".` };
    }

    return {
      source: "none",
      warning: `"${override}" is not an exact version. Enter a version such as 2.1.0, or turn on the registry check.`,
    };
  }

  if (doc) {
    const stable = stableVersions(doc);
    const pool = stable.length > 0 ? stable : allStableVersions(doc);
    const tagLatest = doc.tags.latest;
    const latest = tagLatest && isStable(tagLatest) ? tagLatest : highestOf(pool);

    let pick: string | undefined;
    let source: TargetSource = "registry-latest";

    if (strategy === "compatible") {
      pick = maxSatisfying(pool, range);
      source = "registry-compatible";
    } else if (strategy === "next-major" && installedVersion) {
      pick = highestOf(pool.filter((version) => parseVersion(version)!.major === installedVersion.major + 1));
      source = "registry-next-major";
      if (!pick) {
        pick = latest;
        source = "registry-latest";
      }
    } else {
      pick = latest;
    }

    if (pick && installedVersion && compareVersions(parseVersion(pick)!, installedVersion) <= 0) {
      return { source: "none" };
    }

    return pick ? { target: pick, source } : { source: "none" };
  }

  if (installedVersion) {
    const known = nextKnownChange(name, installedVersion);
    if (known) return { target: known, source: "known-change" };
  }

  return { source: "none" };
}

/* -------------------------------------------------------------------------- */
/*  Risk, verdict and the upgrade plan                                        */
/* -------------------------------------------------------------------------- */

function decideVerdict(
  bump: Bump,
  severities: Severity[],
  hasTarget: boolean,
): { verdict: Verdict; severity: Severity } {
  const worst = worstSeverity(severities);

  if (!hasTarget && bump === "unknown") {
    return { verdict: severities.length > 0 && worst !== "info" ? "review" : "unknown", severity: worst };
  }

  if (worst === "critical") return { verdict: "blocked", severity: worst };
  if (worst === "high") return { verdict: "risky", severity: worst };
  if (worst === "medium" || bump === "major") {
    return { verdict: "review", severity: worst === "info" && bump === "major" ? "low" : worst };
  }
  if (bump === "none") return { verdict: "up-to-date", severity: worst };
  return { verdict: "safe", severity: worst };
}

function scoreRisk(
  bump: Bump,
  majorsBehind: number,
  breaking: BreakingChange[],
  conflicts: Conflict[],
  fileCount: number,
): number {
  const bumpWeight =
    bump === "major" ? Math.min(36, 20 + Math.max(0, majorsBehind - 1) * 8)
    : bump === "minor" ? 4
    : bump === "patch" ? 1
    : bump === "unknown" ? 5
    : 0;

  const breakingWeight = Math.min(
    60,
    breaking.reduce((sum, item) => sum + SEVERITY_WEIGHT[item.severity], 0),
  );
  const conflictWeight = Math.min(
    40,
    conflicts.reduce((sum, item) => sum + SEVERITY_WEIGHT[item.severity], 0),
  );

  return Math.min(100, bumpWeight + breakingWeight + conflictWeight + Math.min(10, fileCount));
}

function installCommand(
  manager: PackageManager,
  items: Array<{ name: string; version: string }>,
  dev: boolean,
): string {
  const list = items.map((item) => `${item.name}@${item.version}`).join(" ");

  switch (manager) {
    case "yarn": return `yarn add ${dev ? "-D " : ""}${list}`;
    case "pnpm": return `pnpm add ${dev ? "-D " : ""}${list}`;
    case "bun": return `bun add ${dev ? "-d " : ""}${list}`;
    default: return `npm install ${dev ? "-D " : ""}${list}`;
  }
}

function buildPlan(input: {
  name: string;
  dev: boolean;
  installed?: string;
  target?: string;
  bump: Bump;
  breaking: BreakingChange[];
  conflicts: Conflict[];
  manager: PackageManager;
  workspaces: string[];
  fileCount: number;
}): UpgradePlan {
  const { name, target, installed, bump, breaking, conflicts } = input;

  const replaceable = conflicts.filter(
    (item) => item.kind === "notice" || item.kind === "deprecated",
  );

  if (bump === "none" && replaceable.length > 0) {
    return {
      title: "Plan a replacement",
      summary: `${name} has no newer version, but it needs attention: ${replaceable[0].title}.`,
      steps: [
        ...replaceable.map((item) => `${item.title}. ${item.description}`),
        "Replace the usages one file at a time, starting with the ones that have tests.",
        "Remove the package once nothing imports it.",
      ],
      commands: "",
      caveats: [],
    };
  }

  if (!target || bump === "none" || bump === "unknown") {
    return {
      title: bump === "none" ? "Nothing to upgrade" : "No target version",
      summary:
        bump === "none"
          ? `${name} is already on the newest version this strategy selects.`
          : "No newer version could be determined. Turn on the registry check, or enter a version to analyze.",
      steps: [],
      commands: "",
      caveats: [],
    };
  }

  const steps: string[] = [];

  if (bump !== "patch") {
    steps.push("Start from a clean branch and make sure the tests, the type check and the build pass on the current version.");
  }

  for (const conflict of conflicts) {
    if (conflict.kind === "peer-unmet" && conflict.related) {
      steps.push(`Upgrade ${conflict.related} first or together with ${name}. ${conflict.title}.`);
    } else if (conflict.kind === "peer-dependent" && conflict.related) {
      steps.push(`Update ${conflict.related} to a release that supports ${name} ${target}, or replace it.`);
    } else if (conflict.kind === "types" && conflict.related) {
      steps.push(`Upgrade ${conflict.related} alongside ${name}.`);
    } else if (conflict.kind === "engines") {
      steps.push(`Raise the project's Node version. ${conflict.title}.`);
    }
  }

  const command = installCommand(
    input.manager,
    [{ name, version: target }],
    input.dev,
  );
  steps.push(`Install the new version with \`${command}\`.`);

  for (const change of breaking) {
    steps.push(
      `Fix ${change.count} ${change.count === 1 ? "place" : "places"}: ${change.title}.`,
    );
  }

  steps.push("Run the type check, the tests and a production build.");

  const caveats: string[] = [];

  if (bump === "major") {
    caveats.push(
      `This tool checks a limited set of known breaking changes${
        breaking.length === 0 ? ", and none of them apply to your code" : ""
      }. Read the release notes for every version between ${installed ?? "the installed version"} and ${target} before merging.`,
    );
  }

  if (input.workspaces.length > 0) {
    caveats.push(`Declared in: ${input.workspaces.join(", ")}. Run the command in the right workspace.`);
  }

  const changeCount = breaking.reduce((sum, item) => sum + item.count, 0);
  const noteCount = conflicts.filter((item) => item.severity !== "info").length;
  const from = installed ?? "the installed version";

  const parts: string[] = [];
  if (changeCount > 0) {
    parts.push(`${changeCount} known ${changeCount === 1 ? "change" : "changes"} to make in your code`);
  }
  if (noteCount > 0) {
    parts.push(`${noteCount} compatibility ${noteCount === 1 ? "note" : "notes"}`);
  }

  const summary =
    parts.length === 0
      ? `A ${bump} update from ${from} to ${target} with no known problems${
          input.fileCount > 0
            ? ` across the ${input.fileCount} ${input.fileCount === 1 ? "file that uses" : "files that use"} it`
            : ""
        }.`
      : `Upgrade ${from} to ${target}: ${parts.join(" and ")}.`;

  return {
    title: bump === "major" ? "Major upgrade plan" : "Upgrade plan",
    summary,
    steps,
    commands: command,
    caveats,
  };
}

function summarize(
  name: string,
  verdict: Verdict,
  bump: Bump,
  installed: string | undefined,
  target: string | undefined,
  breakingCount: number,
  conflicts: Conflict[],
  fileCount: number,
): string {
  switch (verdict) {
    case "unknown":
      return "No target version is known. Turn on the registry check or enter a version to analyze.";
    case "up-to-date":
      return conflicts.length > 0
        ? `Already on the newest version, but there ${conflicts.length === 1 ? "is a note" : "are notes"} worth reading.`
        : "Already on the newest version for this strategy.";
    case "safe":
      return fileCount === 0
        ? `A ${bump} update to ${target}. No source file imports ${name} directly, and nothing known breaks.`
        : `A ${bump} update to ${target}. Nothing known breaks in the ${fileCount} ${
            fileCount === 1 ? "file that uses" : "files that use"
          } ${name}.`;
    default: {
      if (!target) {
        const first = conflicts[0];
        return `Already on the newest version, but ${
          conflicts.length === 1 ? "one note needs" : `${conflicts.length} notes need`
        } attention${first ? `: ${first.title}.` : "."}`;
      }

      const parts: string[] = [];
      if (breakingCount > 0) {
        parts.push(`${breakingCount} known ${breakingCount === 1 ? "change" : "changes"} in your code`);
      }
      if (conflicts.length > 0) {
        parts.push(`${conflicts.length} compatibility ${conflicts.length === 1 ? "note" : "notes"}`);
      }
      const detail = parts.length > 0 ? `${parts.join(" and ")}.` : "No known problems, but major versions can change behavior.";
      return `${installed ?? "?"} → ${target ?? "?"}: ${detail}`;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Main analysis                                                             */
/* -------------------------------------------------------------------------- */

interface DeclaredPackage {
  name: string;
  kind: DepKind;
  ranges: string[];
  workspaces: string[];
}

const KIND_RANK: Record<DepKind, number> = {
  dependencies: 0,
  optionalDependencies: 1,
  devDependencies: 2,
};

const SKIPPED_SPEC =
  /^(workspace:|file:|link:|portal:|patch:|git\+|git:|github:|https?:|npm:)|^[\w.-]+\/[\w.-]+(#.*)?$/;

function collectDeclared(
  workspaces: Workspace[],
  includeDev: boolean,
): { declared: Map<string, DeclaredPackage>; skipped: number } {
  const internal = new Set(workspaces.map((workspace) => workspace.manifest.name).filter(Boolean));
  const declared = new Map<string, DeclaredPackage>();
  let skipped = 0;

  const kinds: DepKind[] = includeDev
    ? ["dependencies", "optionalDependencies", "devDependencies"]
    : ["dependencies", "optionalDependencies"];

  for (const workspace of workspaces) {
    for (const kind of kinds) {
      for (const [name, range] of Object.entries(workspace.manifest[kind] ?? {})) {
        if (internal.has(name)) continue;

        if (typeof range !== "string" || SKIPPED_SPEC.test(range.trim())) {
          skipped++;
          continue;
        }

        const entry = declared.get(name) ?? { name, kind, ranges: [], workspaces: [] };

        if (KIND_RANK[kind] < KIND_RANK[entry.kind]) entry.kind = kind;
        if (!entry.ranges.includes(range)) entry.ranges.push(range);
        if (!entry.workspaces.includes(workspace.rel)) entry.workspaces.push(workspace.rel);

        declared.set(name, entry);
      }
    }
  }

  return { declared, skipped };
}

export async function analyzeUpgradeImpact(
  projectPath: string,
  packageName?: string,
  options: {
    strategy?: Strategy;
    checkRegistry?: boolean;
    includeDev?: boolean;
    targets?: Record<string, string>;
  } = {},
): Promise<UpgradeReport> {
  const strategy = options.strategy ?? "latest";
  const checkRegistry = options.checkRegistry ?? true;
  const includeDev = options.includeDev ?? true;
  const targets = options.targets ?? {};

  if (strategy !== "latest" && strategy !== "next-major" && strategy !== "compatible") {
    throw new Error("strategy must be latest, next-major, or compatible.");
  }

  if (packageName !== undefined && (typeof packageName !== "string" || packageName.length > 214)) {
    throw new Error("packageName must be a package name.");
  }

  const targetEntries = Object.entries(targets);
  if (
    targetEntries.length > 100 ||
    targetEntries.some(([key, value]) => key.length > 214 || typeof value !== "string" || value.length > 80)
  ) {
    throw new Error("targets must map package names to versions.");
  }

  const resolvedProject = await resolveProjectPath(projectPath);
  const root = fs.realpathSync(resolvedProject.projectPath);
  const warnings: string[] = [];

  const warn = (message: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message);
    else if (warnings.length === MAX_WARNINGS) warnings.push("Further warnings were omitted.");
  };

  /* ---- Manifests and workspaces ---- */

  const rootManifest = readJson<Manifest>(path.join(root, "package.json"));
  if (!rootManifest) {
    throw new Error(`No readable package.json was found in ${root}.`);
  }

  const workspaces: Workspace[] = [
    { name: rootManifest.name ?? "root", dir: root, rel: ".", manifest: rootManifest },
  ];

  for (const pattern of readWorkspacePatterns(root, rootManifest)) {
    for (const dir of expandWorkspacePattern(root, pattern)) {
      if (workspaces.length > MAX_WORKSPACES) break;
      if (workspaces.some((item) => item.dir === dir)) continue;

      const manifest = readJson<Manifest>(path.join(dir, "package.json"));
      if (manifest) {
        workspaces.push({
          name: manifest.name ?? path.basename(dir),
          dir,
          rel: normalizePath(path.relative(root, dir)),
          manifest,
        });
      }
    }
  }

  const manager = detectPackageManager(root, rootManifest);
  const node = detectNodeVersion(root, rootManifest);

  const { declared, skipped } = collectDeclared(workspaces, includeDev);

  if (skipped > 0) {
    warn(
      `${skipped} ${skipped === 1 ? "dependency uses" : "dependencies use"} a git, file, workspace or alias version and ${
        skipped === 1 ? "was" : "were"
      } skipped.`,
    );
  }

  let names = [...declared.keys()].sort();

  if (packageName) {
    if (!declared.has(packageName)) {
      throw new Error(
        `"${packageName}" is not a direct dependency of this project${includeDev ? "" : " (dev dependencies are excluded)"}.`,
      );
    }
    names = [packageName];
  }

  if (names.length > MAX_DEPENDENCIES) {
    warn(`Only the first ${MAX_DEPENDENCIES} of ${names.length} dependencies were analyzed.`);
    names = names.slice(0, MAX_DEPENDENCIES);
  }

  /* ---- Installed versions ---- */

  const rangeByName = new Map<string, string>();
  for (const entry of declared.values()) rangeByName.set(entry.name, entry.ranges[0]);

  const lock = readLockfile(root, rangeByName);
  const installedMap = scanInstalled(root);

  if (installedMap.size === 0) {
    warn(
      "node_modules was not found. Installed versions come from the lockfile, and peer dependency checks on installed packages are skipped. Install dependencies for a complete analysis.",
    );
  }

  const peerDependents = new Map<string, PeerDependent[]>();
  for (const installed of installedMap.values()) {
    for (const [peer, range] of Object.entries(installed.peerDependencies)) {
      const list = peerDependents.get(peer) ?? [];
      list.push({
        name: installed.name,
        version: installed.version,
        range,
        optional: installed.peerOptional.has(peer),
      });
      peerDependents.set(peer, list);
    }
  }

  /* ---- Source files ---- */

  const discovered = discoverFiles(root);
  if (discovered.truncated) warn("Only the first 30,000 files were listed.");

  const sourceFiles = discovered.files.filter(
    (file) => SOURCE_EXTENSIONS.has(path.extname(file.rel)) && !/\.d\.[cm]?ts$/.test(file.rel),
  );

  if (sourceFiles.length > MAX_FILES) {
    warn(`Only the first ${MAX_FILES} source files were scanned.`);
  }

  const usages: FileUsage[] = [];

  for (const file of sourceFiles.slice(0, MAX_FILES)) {
    if (file.size > MAX_FILE_BYTES) continue;
    const text = readText(file.abs);
    if (text === undefined) continue;

    usages.push(analyzeSource(file.rel, text, TEST_PATH_PATTERN.test(file.rel)));
  }

  const importers = new Map<string, Importer[]>();
  for (const file of usages) {
    for (const record of file.imports) {
      const list = importers.get(record.pkg) ?? [];
      list.push({ file, record });
      importers.set(record.pkg, list);
    }
  }

  const tsconfigModule = (() => {
    for (const file of discovered.files) {
      if (!/(^|\/)tsconfig\.json$/.test(file.rel)) continue;
      const text = readText(file.abs);
      const match = text ? /"module"\s*:\s*"([^"]+)"/i.exec(text) : null;
      if (match) return match[1].toLowerCase();
    }
    return undefined;
  })();

  const context: ProjectContext = {
    root,
    files: discovered.files,
    usages,
    importers,
    cjsEmit:
      rootManifest.type !== "module" &&
      (tsconfigModule === "commonjs" || tsconfigModule === "node16" || tsconfigModule === "nodenext"),
  };

  /* ---- Tooling usage (scripts and config files) ---- */

  const scriptTokens = collectScriptTokens(workspaces);

  const configTexts: Array<{ rel: string; text: string }> = [];
  for (const file of discovered.files) {
    if (file.size > MAX_FILE_BYTES) continue;

    if (CONFIG_FILE_PATTERN.test(file.rel)) {
      const text = readText(file.abs);
      if (text) configTexts.push({ rel: file.rel, text });
    } else if (/(^|\/)package\.json$/.test(file.rel)) {
      const manifest = readJson<Record<string, unknown>>(file.abs);
      if (manifest) {
        for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "scripts"]) {
          delete manifest[key];
        }
        configTexts.push({ rel: file.rel, text: JSON.stringify(manifest) });
      }
    }
  }

  /* ---- Registry ---- */

  let docs = new Map<string, RegistryDoc>();
  let registryFailures = 0;
  let registryStatus: UpgradeReport["registryStatus"] = "not-requested";

  if (checkRegistry) {
    const registryConfig = readRegistryConfig(root);
    const lookups = names.filter(
      (name) => !lock.private.has(name) && !usesPrivateRegistry(name, registryConfig),
    );
    const privateCount = names.length - lookups.length;

    if (privateCount > 0) {
      warn(
        `${privateCount} ${privateCount === 1 ? "package comes" : "packages come"} from a private registry and ${
          privateCount === 1 ? "was" : "were"
        } not looked up. Only names of public packages are sent to registry.npmjs.org.`,
      );
    }

    if (!getFetch()) {
      registryStatus = "unavailable";
      warn("This Node version has no fetch, so the registry check was skipped.");
    } else {
      const result = await fetchAllRegistryDocs(lookups);
      docs = result.docs;
      registryFailures = result.failures + result.skipped;

      if (lookups.length > 0 && docs.size === 0 && registryFailures > 0) {
        registryStatus = "unavailable";
        warn(
          "The npm registry could not be reached, so newest versions are unknown. Results use installed versions and the built-in list of known breaking changes only.",
        );
      } else if (registryFailures > 0) {
        registryStatus = "partial";
        warn(`${registryFailures} registry ${registryFailures === 1 ? "lookup" : "lookups"} failed or timed out.`);
      } else {
        registryStatus = "ok";
      }
    }
  }

  /* ---- Analyze each package ---- */

  const packages: UpgradePackage[] = [];

  for (const name of names) {
    const entry = declared.get(name)!;
    const range = entry.ranges[0];

    const dirs = [
      ...entry.workspaces.filter((rel) => rel !== ".").map((rel) => path.join(root, rel)),
      root,
    ];

    const installedPkg = readInstalled(dirs, name);
    let installedVersion: string | undefined;
    let installedSource: VersionSource = "unknown";

    if (installedPkg) {
      installedVersion = installedPkg.version;
      installedSource = "node_modules";
    } else if (lock.versions.has(name)) {
      installedVersion = lock.versions.get(name);
      installedSource = "lockfile";
    } else {
      const bound = lowestBound(range);
      if (bound) {
        installedVersion = formatVersion(bound);
        installedSource = "manifest";
      }
    }

    const doc = docs.get(name);
    const tagLatest = doc?.tags.latest;
    const latest = doc
      ? tagLatest && isStable(tagLatest) ? tagLatest : highestOf(allStableVersions(doc))
      : undefined;

    const resolved = resolveTarget(name, installedVersion, range, doc, strategy, targets[name]);
    if (resolved.warning) warn(resolved.warning);

    let target = resolved.target;
    let bump: Bump = "unknown";
    let majorsBehind = 0;

    if (installedVersion && target) {
      bump = bumpBetween(installedVersion, target);
      const a = parseVersion(installedVersion);
      const b = parseVersion(target);
      if (a && b) majorsBehind = Math.max(0, b.major - a.major);
      if (bump === "none") target = undefined;
    } else if (doc && installedVersion && resolved.source === "none") {
      bump = "none";
    }

    const importerList = importers.get(name) ?? [];

    const bins = new Set<string>([...(installedPkg?.bins ?? []), name, name.split("/").pop()!]);
    const viaScripts = new Set<string>();
    for (const bin of bins) {
      for (const script of scriptTokens.get(bin) ?? []) viaScripts.add(script);
    }

    const viaConfig: string[] = [];
    const patterns = configNameForms(name).map(
      (form) => new RegExp(`(?:["'\`:/]|^)${escapeRegExp(form)}(?:["'\`/]|$)`),
    );
    for (const config of configTexts) {
      if (patterns.some((pattern) => pattern.test(config.text))) {
        viaConfig.push(config.rel);
        if (viaConfig.length >= 4) break;
      }
    }

    const dependents = (peerDependents.get(name) ?? []).filter((item) => item.name !== name);

    const usage = buildUsage(
      importerList,
      [...viaScripts].sort(),
      viaConfig,
      dependents.length === 0 && !implicitlyUsed(name, discovered.files, rootManifest),
    );

    let breaking: BreakingChange[] = [];
    const installedParsed = installedVersion ? parseVersion(installedVersion) : null;
    const targetParsed = target ? parseVersion(target) : null;

    if (installedParsed && targetParsed) {
      breaking = evaluateRules(name, installedParsed, targetParsed, context, node);
    }

    const conflicts = buildConflicts({
      name,
      installed: installedVersion,
      target,
      bump,
      doc,
      installedPkg,
      dependents,
      installedMap,
      lock,
      node,
    });

    const { verdict, severity } = decideVerdict(
      bump,
      [...breaking.map((item) => item.severity), ...conflicts.map((item) => item.severity)],
      target !== undefined,
    );

    const breakingCount = breaking.reduce((sum, item) => sum + item.count, 0);

    const deprecated =
      installedPkg?.deprecated ??
      (installedVersion ? doc?.versions.get(installedVersion)?.deprecated : undefined);

    packages.push({
      id: name,
      name,
      kind: entry.kind,
      declaredRange: range,
      workspaces: entry.workspaces,
      installed: installedVersion,
      installedSource,
      latest,
      target,
      targetSource: target ? resolved.source : "none",
      bump,
      majorsBehind,
      verdict,
      severity,
      riskScore: scoreRisk(bump, majorsBehind, breaking, conflicts, usage.fileCount),
      summary: summarize(name, verdict, bump, installedVersion, target, breakingCount, conflicts, usage.fileCount),
      deprecated: deprecated ? clip(deprecated, 240) : undefined,
      usage,
      breaking,
      breakingCount,
      conflicts,
      plan: buildPlan({
        name,
        dev: entry.kind === "devDependencies",
        installed: installedVersion,
        target,
        bump,
        breaking,
        conflicts,
        manager,
        workspaces: entry.workspaces.filter((rel) => rel !== "."),
        fileCount: usage.fileCount,
      }),
    });
  }

  packages.sort(
    (a, b) =>
      b.riskScore - a.riskScore ||
      Number(b.bump === "major") - Number(a.bump === "major") ||
      a.name.localeCompare(b.name),
  );

  /* ---- Safe batch ---- */

  const safe = packages.filter(
    (item) =>
      item.verdict === "safe" &&
      item.target !== undefined &&
      item.installed !== undefined &&
      item.conflicts.every((conflict) => conflict.severity === "info" || conflict.severity === "low"),
  );

  const batchCommand = (dev: boolean) => {
    const items = safe
      .filter((item) => (item.kind === "devDependencies") === dev)
      .map((item) => ({ name: item.name, version: item.target! }));
    return items.length > 0 ? installCommand(manager, items, dev) : undefined;
  };

  const safeBatch: SafeBatch = {
    count: safe.length,
    commands: [batchCommand(false), batchCommand(true)].filter((command): command is string => !!command),
    packages: safe.map((item) => ({
      name: item.name,
      from: item.installed!,
      to: item.target!,
      dev: item.kind === "devDependencies",
    })),
  };

  /* ---- Hotspots ---- */

  const hotspotMap = new Map<string, FileHotspot>();

  for (const item of packages) {
    for (const change of item.breaking) {
      for (const location of change.locations) {
        const spot = hotspotMap.get(location.filePath) ?? {
          filePath: location.filePath,
          breakingCount: 0,
          packages: [],
          topSeverity: "info" as Severity,
        };

        spot.breakingCount++;
        if (!spot.packages.includes(item.name)) spot.packages.push(item.name);
        spot.topSeverity = worstSeverity([spot.topSeverity, change.severity]);
        hotspotMap.set(location.filePath, spot);
      }
    }
  }

  const hotspots = [...hotspotMap.values()]
    .sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.topSeverity) - SEVERITY_ORDER.indexOf(b.topSeverity) ||
        b.breakingCount - a.breakingCount ||
        a.filePath.localeCompare(b.filePath),
    )
    .slice(0, MAX_HOTSPOTS);

  /* ---- Totals ---- */

  const summary: Record<Verdict, number> = {
    "up-to-date": 0,
    safe: 0,
    review: 0,
    risky: 0,
    blocked: 0,
    unknown: 0,
  };
  for (const item of packages) summary[item.verdict]++;

  return {
    success: true,
    tool: "analyze_upgrade_impact",
    projectPath: root,
    packageName,
    strategy,
    checkRegistry,
    includeDev,
    registryStatus,
    registryFailures,
    packageManager: manager,
    nodeVersion: node.version,
    nodeVersionSource: node.source,
    workspaces: workspaces.filter((item) => item.rel !== ".").map((item) => item.rel),
    filesScanned: usages.length,
    totalDependencies: packages.length,
    outdatedCount: packages.filter((item) => item.bump !== "none" && item.bump !== "unknown").length,
    majorCount: packages.filter((item) => item.bump === "major").length,
    minorCount: packages.filter((item) => item.bump === "minor").length,
    patchCount: packages.filter((item) => item.bump === "patch").length,
    upToDateCount: packages.filter((item) => item.bump === "none").length,
    unknownCount: packages.filter((item) => item.bump === "unknown").length,
    breakingPackageCount: packages.filter((item) => item.breakingCount > 0).length,
    breakingTotal: packages.reduce((sum, item) => sum + item.breakingCount, 0),
    conflictPackageCount: packages.filter((item) => item.conflicts.some((c) => c.severity !== "info")).length,
    deprecatedCount: packages.filter((item) => item.deprecated || item.conflicts.some((c) => c.kind === "deprecated" || c.kind === "notice")).length,
    unusedCount: packages.filter((item) => item.usage.unused).length,
    summary,
    packages,
    safeBatch,
    hotspots,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/*  MCP registration                                                          */
/* -------------------------------------------------------------------------- */

export function registerAnalyzeUpgradeImpactTool(server: McpServer) {
  server.registerTool(
    "analyze_upgrade_impact",
    {
      description:
        "Estimate what will break if you upgrade npm dependencies. For every direct dependency it finds the installed and newest versions, how your code uses the package, which known breaking changes (React 19, React Router 6, Express 5, TanStack Query 5, Redux Toolkit 2, Tailwind 4, ESM-only packages and more) match code in your project with file and line, peer dependency, Node engine and @types conflicts, and deprecations. It returns a risk score, a verdict, a step-by-step upgrade plan with install commands, and a batch of upgrades that look safe to apply together. Checking newest versions sends only public package names to registry.npmjs.org.",
      inputSchema: z.object({
        projectPath: z
          .string()
          .describe("Absolute path to the project directory (the folder with package.json)"),
        packageName: z
          .string()
          .optional()
          .describe("Optional. Analyze only this direct dependency, for example react."),
        strategy: z
          .enum(["latest", "next-major", "compatible"])
          .optional()
          .describe(
            "Which version to analyze. latest (default): newest stable. next-major: the next major only. compatible: newest the declared range already allows.",
          ),
        checkRegistry: z
          .boolean()
          .optional()
          .describe("Look up newest versions on registry.npmjs.org. Default true."),
        includeDev: z
          .boolean()
          .optional()
          .describe("Include devDependencies. Default true."),
        targets: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Optional map of package name to the exact version, range or dist-tag to analyze instead of the strategy, for example { \"react\": \"19.0.0\" }.",
          ),
      }),
    },
    async ({ projectPath, packageName, strategy, checkRegistry, includeDev, targets }) => {
      try {
        const report = await analyzeUpgradeImpact(projectPath, packageName, {
          strategy,
          checkRegistry,
          includeDev,
          targets,
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
                  tool: "analyze_upgrade_impact",
                  error:
                    error instanceof Error
                      ? error.message
                      : "Failed to analyze upgrade impact.",
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
