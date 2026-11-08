import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveProjectPath } from "../utils/projectResolver.js";

const execFileAsync = promisify(execFile);

type DependencyKind = "dependency" | "devDependency" | "peerDependency" | "optionalDependency";
type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";
type FindingCategory =
  | "missing"
  | "unused"
  | "duplicate"
  | "outdated"
  | "deprecated"
  | "placement"
  | "health";

interface DependencyFinding {
  id: string;
  severity: FindingSeverity;
  category: FindingCategory;
  packageName: string;
  title: string;
  description: string;
  recommendation: string;
  declaredVersion?: string;
  installedVersion?: string;
  latestVersion?: string;
  dependencyKind?: DependencyKind;
  filePath?: string;
  confidence: "high" | "medium" | "low";
}

interface DependencyInfo {
  name: string;
  version: string;
  kind: DependencyKind;
  resolvedVersion?: string;
  direct: true;
}

interface DuplicateDependency {
  packageName: string;
  versions: string[];
  locations: string[];
}

interface DependencyHealthReport {
  success: boolean;
  tool: "analyze_dependency_health";
  projectPath: string;
  packageManager: "npm" | "yarn" | "pnpm" | "bun" | "unknown";
  packageName?: string;
  packageVersion?: string;
  totalDependencies: number;
  directDependencies: number;
  devDependencies: number;
  peerDependencies: number;
  optionalDependencies: number;
  importedExternalPackages: number;
  missingDependencies: number;
  unusedDependencies: number;
  duplicateDependencies: number;
  outdatedDependencies: number;
  deprecatedDependencies: number;
  findings: DependencyFinding[];
  dependencies: DependencyInfo[];
  duplicates: DuplicateDependency[];
  scannedFiles: string[];
  warnings: string[];
}

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
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
]);

const NODE_BUILT_INS = new Set([
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "dns/promises",
  "domain",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "readline/promises",
  "repl",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "sys",
  "timers",
  "timers/promises",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

function normalize(value: string): string {
  return value.replaceAll("\\", "/");
}

function packageRoot(specifier: string): string | undefined {
  if (
    !specifier ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("node:")
  ) {
    return undefined;
  }

  const parts = specifier.split("/");
  if (specifier.startsWith("@") && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }

  return parts[0];
}

function walkSourceFiles(root: string): string[] {
  const files: string[] = [];

  function visit(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".storybook") {
        continue;
      }

      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) {
        continue;
      }

      const absolute = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        visit(absolute);
      } else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(path.extname(entry.name))
      ) {
        files.push(absolute);
      }
    }
  }

  visit(root);
  return files;
}

function readPackageJson(projectPath: string): Record<string, any> {
  const packagePath = path.join(projectPath, "package.json");

  try {
    return JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch {
    return {};
  }
}

function detectPackageManager(
  projectPath: string,
): DependencyHealthReport["packageManager"] {
  if (fs.existsSync(path.join(projectPath, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(projectPath, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(projectPath, "bun.lockb")) || fs.existsSync(path.join(projectPath, "bun.lock"))) {
    return "bun";
  }
  if (fs.existsSync(path.join(projectPath, "package-lock.json"))) return "npm";

  const pkg = readPackageJson(projectPath);
  if (pkg.packageManager?.startsWith("pnpm")) return "pnpm";
  if (pkg.packageManager?.startsWith("yarn")) return "yarn";
  if (pkg.packageManager?.startsWith("bun")) return "bun";
  if (pkg.packageManager?.startsWith("npm")) return "npm";

  return "unknown";
}

function collectDeclaredDependencies(
  pkg: Record<string, any>,
): Map<string, { version: string; kind: DependencyKind }> {
  const result = new Map<string, { version: string; kind: DependencyKind }>();

  const groups: [DependencyKind, Record<string, string> | undefined][] = [
    ["dependency", pkg.dependencies],
    ["devDependency", pkg.devDependencies],
    ["peerDependency", pkg.peerDependencies],
    ["optionalDependency", pkg.optionalDependencies],
  ];

  for (const [kind, deps] of groups) {
    for (const [name, version] of Object.entries(deps ?? {})) {
      result.set(name, { version: String(version), kind });
    }
  }

  return result;
}

const VALID_PACKAGE_NAME =
  /^(?:@[a-zA-Z0-9][a-zA-Z0-9._~-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._~-]*$/;

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

// Statement-level imports/exports. Anchored to the start of a line and limited
// to identifier characters, so text inside strings (YAML, shell snippets,
// string concatenation such as `" + name + "`) is not mistaken for an import.
const FROM_IMPORT_REGEX =
  /^[ \t]*(import|export)\s+(type\s+)?(?:[\w$\s,*]*\{[^{}]*\}[\w$\s,]*|[\w$\s,*]+)\s*from\s*["']([^"'\n]+)["']/gm;
const SIDE_EFFECT_IMPORT_REGEX = /^[ \t]*import\s*["']([^"'\n]+)["']/gm;
const CALL_IMPORT_REGEX =
  /\b(?:require|import)\s*\(\s*["']([^"'\n]+)["']\s*\)/g;

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\"'`])\/\/.*$/gm, "$1");
}

interface ImportedPackage {
  packageName: string;
  /** First file that imports the package. */
  filePath: string;
  /** Files that import it at runtime (not `import type`). */
  runtimeFiles: string[];
}

function collectImportedPackages(
  sourceFiles: string[],
  isLocalAlias: (root: string) => boolean,
): ImportedPackage[] {
  const imports = new Map<string, ImportedPackage>();

  function record(specifier: string, filePath: string, typeOnly: boolean) {
    const root = packageRoot(specifier);

    if (
      !root ||
      !VALID_PACKAGE_NAME.test(root) ||
      isLocalAlias(root)
    ) {
      return;
    }

    const entry = imports.get(root) ?? {
      packageName: root,
      filePath: normalize(filePath),
      runtimeFiles: [],
    };

    if (!typeOnly && !entry.runtimeFiles.includes(filePath)) {
      entry.runtimeFiles.push(filePath);
    }

    imports.set(root, entry);
  }

  for (const filePath of sourceFiles) {
    let source = "";

    try {
      if (fs.statSync(filePath).size > MAX_SOURCE_BYTES) continue;
      source = stripComments(fs.readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }

    for (const match of source.matchAll(FROM_IMPORT_REGEX)) {
      record(match[3], filePath, Boolean(match[2]));
    }

    for (const match of source.matchAll(SIDE_EFFECT_IMPORT_REGEX)) {
      record(match[1], filePath, false);
    }

    for (const match of source.matchAll(CALL_IMPORT_REGEX)) {
      record(match[1], filePath, false);
    }
  }

  return [...imports.values()];
}

function stripJsonComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
}

/** Creates a check for imports that point at tsconfig/jsconfig aliases or baseUrl folders. */
function createLocalAliasMatcher(projectPath: string): (root: string) => boolean {
  const prefixes = new Set<string>();
  const baseDirs: string[] = [];

  for (const name of ["tsconfig.json", "tsconfig.app.json", "jsconfig.json"]) {
    try {
      const config = JSON.parse(
        stripJsonComments(fs.readFileSync(path.join(projectPath, name), "utf8")),
      );
      const options = config.compilerOptions ?? {};

      for (const key of Object.keys(options.paths ?? {})) {
        prefixes.add(key.replace(/\/?\*$/, ""));
      }

      if (typeof options.baseUrl === "string") {
        baseDirs.push(path.resolve(projectPath, options.baseUrl));
      }
    } catch {
      // Missing or unparsable config: ignore.
    }
  }

  return (root) => {
    if (prefixes.has(root) || prefixes.has(`${root}/`)) return true;

    return baseDirs.some((dir) => {
      const candidate = path.join(dir, ...root.split("/"));
      return (
        fs.existsSync(candidate) ||
        [...SOURCE_EXTENSIONS].some((ext) => fs.existsSync(candidate + ext))
      );
    });
  };
}

const TOOLING_FILE_REGEX =
  /(^|\/)(?:[^/]*\.config(?:\.[^/]+)?\.[cm]?[jt]s|[^/]*\.(?:test|spec|stories)\.[cm]?[jt]sx?|__tests__\/|__mocks__\/|tests?\/|e2e\/|cypress\/|\.storybook\/|scripts\/)/;

function isToolingFile(relativePath: string): boolean {
  return TOOLING_FILE_REGEX.test(relativePath);
}

function typesPackageTarget(packageName: string): string | undefined {
  if (!packageName.startsWith("@types/")) return undefined;
  const base = packageName.slice("@types/".length);
  return base.includes("__") ? `@${base.replace("__", "/")}` : base;
}

function getBinNames(projectPath: string, packageName: string): string[] {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(projectPath, "node_modules", ...packageName.split("/"), "package.json"),
        "utf8",
      ),
    );

    if (typeof manifest.bin === "string") {
      return [packageName.split("/").pop() as string];
    }

    return manifest.bin && typeof manifest.bin === "object"
      ? Object.keys(manifest.bin)
      : [];
  } catch {
    return [];
  }
}

function getInstalledVersion(
  projectPath: string,
  packageName: string,
): string | undefined {
  const directPath = path.join(
    projectPath,
    "node_modules",
    ...packageName.split("/"),
    "package.json",
  );

  try {
    const packageJson = JSON.parse(
      fs.readFileSync(directPath, "utf8"),
    );

    return typeof packageJson.version === "string"
      ? packageJson.version
      : undefined;
  } catch {
    return undefined;
  }
}

function severityForUnused(kind: DependencyKind): FindingSeverity {
  return kind === "dependency" ? "medium" : "low";
}

function severityForMissing(packageName: string): FindingSeverity {
  if (
    packageName === "react" ||
    packageName === "react-dom" ||
    packageName.startsWith("@types/")
  ) {
    return "high";
  }

  return "medium";
}

function createFindingId(
  category: FindingCategory,
  packageName: string,
): string {
  return `${category}:${packageName}`;
}

async function runPackageManagerCommand(
  projectPath: string,
  packageManager: DependencyHealthReport["packageManager"],
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const command =
    packageManager === "yarn"
      ? "yarn"
      : packageManager === "pnpm"
        ? "pnpm"
        : packageManager === "bun"
          ? "bun"
          : "npm";

  try {
    return await execFileAsync(command, args, {
      cwd: projectPath,
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    // `npm outdated`, `pnpm outdated` and `npm ls` exit with a non-zero code
    // when they have something to report, but stdout still holds valid JSON.
    const failure = error as { stdout?: string; stderr?: string };
    if (typeof failure.stdout === "string" && failure.stdout.trim()) {
      return { stdout: failure.stdout, stderr: failure.stderr ?? "" };
    }
    throw error;
  }
}

async function detectOutdatedDependencies(
  projectPath: string,
  packageManager: DependencyHealthReport["packageManager"],
  declared: Map<string, { version: string; kind: DependencyKind }>,
  warnings: string[],
): Promise<Map<string, { current?: string; latest?: string }>> {
  const result = new Map<string, { current?: string; latest?: string }>();

  if (packageManager === "unknown" || declared.size === 0) {
    return result;
  }

  try {
    let stdout = "";

    if (packageManager === "npm") {
      const commandResult = await runPackageManagerCommand(
        projectPath,
        packageManager,
        ["outdated", "--json"],
      );
      stdout = commandResult.stdout;
    } else if (packageManager === "pnpm") {
      const commandResult = await runPackageManagerCommand(
        projectPath,
        packageManager,
        ["outdated", "--format", "json"],
      );
      stdout = commandResult.stdout;
    } else {
      warnings.push(
        `${packageManager} was detected. Latest-version checks are currently implemented for npm and pnpm; declaration and installation checks still ran.`,
      );
      return result;
    }

    const parsed = JSON.parse(stdout.trim() || "{}");

    for (const [packageName, value] of Object.entries(parsed)) {
      // npm reports an array when a package is outdated in several locations.
      const item = (Array.isArray(value) ? value[0] : value) as Record<string, unknown>;
      if (!item || typeof item !== "object") continue;
      result.set(packageName, {
        current:
          typeof item.current === "string"
            ? item.current
            : getInstalledVersion(projectPath, packageName),
        latest:
          typeof item.latest === "string"
            ? item.latest
            : undefined,
      });
    }
  } catch (error) {
    warnings.push(
      `Latest dependency versions could not be checked. ${error instanceof Error ? error.message : "Package manager command failed."}`,
    );
  }

  return result;
}

async function detectDuplicates(
  projectPath: string,
  packageManager: DependencyHealthReport["packageManager"],
  warnings: string[],
): Promise<DuplicateDependency[]> {
  if (packageManager !== "npm") {
    return [];
  }

  try {
    const { stdout } = await runPackageManagerCommand(
      projectPath,
      packageManager,
      ["ls", "--all", "--json", "--depth=20"],
    );

    const root = JSON.parse(stdout || "{}");
    const versions = new Map<string, Map<string, Set<string>>>();

    function visit(node: any, location: string) {
      if (!node || typeof node !== "object") return;

      const dependencies = node.dependencies ?? {};

      for (const [name, value] of Object.entries(dependencies)) {
        const dependency = value as any;
        if (!dependency || typeof dependency !== "object") continue;

        // Missing / invalid nodes have no version; they are not duplicates.
        if (typeof dependency.version !== "string") continue;
        const version = dependency.version;

        const packageLocations =
          versions.get(name) ?? new Map<string, Set<string>>();

        const locations =
          packageLocations.get(version) ?? new Set<string>();

        locations.add(
          dependency.path
            ? normalize(dependency.path)
            : location,
        );

        packageLocations.set(version, locations);
        versions.set(name, packageLocations);

        visit(dependency, dependency.path ?? location);
      }
    }

    visit(root, projectPath);

    return [...versions.entries()]
      .filter(([, versionMap]) => versionMap.size > 1)
      .map(([packageName, versionMap]) => ({
        packageName,
        versions: [...versionMap.keys()].sort(),
        locations: [...versionMap.values()]
          .flatMap((set) => [...set])
          .sort(),
      }));
  } catch (error) {
    warnings.push(
      `Duplicate dependency detection could not complete. ${error instanceof Error ? error.message : "npm ls failed."}`,
    );
    return [];
  }
}

function buildDependencies(
  declared: Map<string, { version: string; kind: DependencyKind }>,
  projectPath: string,
): DependencyInfo[] {
  return [...declared.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, info]) => ({
      name,
      version: info.version,
      kind: info.kind,
      resolvedVersion: getInstalledVersion(projectPath, name),
      direct: true,
    }));
}

export async function analyzeDependencyHealth(
  projectPath: string,
): Promise<DependencyHealthReport> {
  const resolvedProject = await resolveProjectPath(projectPath);
  const analysisPath = resolvedProject.projectPath;

  const packageJson = readPackageJson(analysisPath);

  if (!Object.keys(packageJson).length) {
    throw new Error(
      `package.json was not found or could not be parsed: ${analysisPath}`,
    );
  }

  const packageManager = detectPackageManager(analysisPath);
  const declared = collectDeclaredDependencies(packageJson);
  const sourceFiles = walkSourceFiles(analysisPath);
  const isLocalAlias = createLocalAliasMatcher(analysisPath);
  const ownPackageName =
    typeof packageJson.name === "string" ? packageJson.name : undefined;
  const importedPackages = collectImportedPackages(sourceFiles, isLocalAlias).filter(
    (item) =>
      item.packageName !== ownPackageName &&
      // Built-ins like "path" are not dependencies, unless a userland
      // package with the same name (e.g. "buffer", "events") is declared.
      (!NODE_BUILT_INS.has(item.packageName) || declared.has(item.packageName)),
  );
  const importedPackageNames = new Set(
    importedPackages.map((item) => item.packageName),
  );

  const findings: DependencyFinding[] = [];
  const warnings: string[] = [];

  for (const imported of importedPackages) {
    if (!declared.has(imported.packageName)) {
      findings.push({
        id: createFindingId("missing", imported.packageName),
        severity: severityForMissing(imported.packageName),
        category: "missing",
        packageName: imported.packageName,
        title: `Missing declared dependency: ${imported.packageName}`,
        description:
          `The source code imports "${imported.packageName}", but it is not declared in dependencies, devDependencies, peerDependencies, or optionalDependencies.`,
        recommendation:
          `Add "${imported.packageName}" to the appropriate dependency section of package.json and update the lockfile.`,
        filePath: normalize(path.relative(analysisPath, imported.filePath)),
        confidence: "high",
      });
    }
  }

  const scriptTokens = new Set(
    Object.values<unknown>(packageJson.scripts ?? {})
      .filter((value): value is string => typeof value === "string")
      .flatMap((value) => value.split(/[\s&|;()"'=]+/)),
  );

  for (const [packageName, info] of declared) {
    const typesTarget = typesPackageTarget(packageName);
    const usedByTypes =
      packageName === "@types/node" ||
      (typesTarget !== undefined && importedPackageNames.has(typesTarget));
    const usedByScripts =
      scriptTokens.has(packageName) ||
      getBinNames(analysisPath, packageName).some((bin) => scriptTokens.has(bin));

    if (!importedPackageNames.has(packageName) && !usedByTypes && !usedByScripts) {
      findings.push({
        id: createFindingId("unused", packageName),
        severity: severityForUnused(info.kind),
        category: "unused",
        packageName,
        title: `Possibly unused ${packageName}`,
        description:
          `The package is declared as a ${info.kind}, but no matching package import was found in scanned source files.`,
        recommendation:
          "Confirm whether the package is used by configuration, scripts, tooling, code generation, or runtime conventions before removing it.",
        declaredVersion: info.version,
        dependencyKind: info.kind,
        confidence: typesTarget ? "low" : "medium",
      });
    }
  }

  const outdated = await detectOutdatedDependencies(
    analysisPath,
    packageManager,
    declared,
    warnings,
  );

  for (const [packageName, versionInfo] of outdated) {
    const declaredInfo = declared.get(packageName);
    if (!declaredInfo) continue;

    if (
      versionInfo.current &&
      versionInfo.latest &&
      versionInfo.current !== versionInfo.latest
    ) {
      findings.push({
        id: createFindingId("outdated", packageName),
        severity:
          Number.parseInt(versionInfo.latest, 10) >
          Number.parseInt(versionInfo.current, 10)
            ? "medium"
            : "low",
        category: "outdated",
        packageName,
        title: `${packageName} has a newer version`,
        description:
          `Installed version ${versionInfo.current} is behind the latest registry version ${versionInfo.latest}.`,
        recommendation:
          "Review the release notes and compatibility requirements before upgrading, then update the lockfile.",
        declaredVersion: declaredInfo.version,
        installedVersion: versionInfo.current,
        latestVersion: versionInfo.latest,
        dependencyKind: declaredInfo.kind,
        confidence: "high",
      });
    }
  }

  const duplicates = await detectDuplicates(
    analysisPath,
    packageManager,
    warnings,
  );

  for (const duplicate of duplicates) {
    findings.push({
      id: createFindingId("duplicate", duplicate.packageName),
      // Transitive duplicates are common and usually harmless; direct ones matter more.
      severity: declared.has(duplicate.packageName) ? "medium" : "low",
      category: "duplicate",
      packageName: duplicate.packageName,
      title: `Multiple versions of ${duplicate.packageName}`,
      description:
        `The dependency tree contains multiple installed versions: ${duplicate.versions.join(", ")}.`,
      recommendation:
        "Check why different packages require different versions and use compatible upgrades or overrides/resolutions where appropriate.",
      installedVersion: duplicate.versions.join(", "),
      confidence: "high",
    });
  }

  for (const [packageName, info] of declared) {
    if (info.kind !== "devDependency") continue;

    const imported = importedPackages.find((item) => item.packageName === packageName);

    // Only application code counts: config, test, story and script files
    // legitimately use devDependencies.
    const appFile = imported?.runtimeFiles
      .map((file) => normalize(path.relative(analysisPath, file)))
      .find((relative) => !isToolingFile(relative));

    if (!appFile) continue;

    findings.push({
      id: createFindingId("placement", packageName),
      severity: "low",
      category: "placement",
      packageName,
      title: `${packageName} is imported by application source`,
      description:
        `The package is declared in devDependencies but was imported from ${appFile}.`,
      recommendation:
        "If this package is required at runtime in production, move it to dependencies. Keep it in devDependencies only when it is build-time/test-only.",
      declaredVersion: info.version,
      dependencyKind: info.kind,
      filePath: appFile,
      confidence: "medium",
    });
  }

  const installedMissing = importedPackages.filter(
    (item) => !getInstalledVersion(analysisPath, item.packageName),
  );

  if (installedMissing.length > 0) {
    warnings.push(
      `${installedMissing.length} imported package(s) are not currently resolvable from node_modules. This may indicate dependencies have not been installed.`,
    );
  }

  if (packageManager === "unknown") {
    warnings.push(
      "Package manager could not be determined from the lockfile or packageManager field.",
    );
  }

  if (sourceFiles.length === 0) {
    warnings.push(
      "No JavaScript/TypeScript source files were found for import analysis.",
    );
  }

  const dependencies = buildDependencies(declared, analysisPath);

  const summaryCounts = {
    missing: findings.filter((item) => item.category === "missing").length,
    unused: findings.filter((item) => item.category === "unused").length,
    duplicate: findings.filter((item) => item.category === "duplicate").length,
    outdated: findings.filter((item) => item.category === "outdated").length,
    deprecated: findings.filter((item) => item.category === "deprecated").length,
  };

  const severityOrder: Record<FindingSeverity, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
  };

  findings.sort(
    (a, b) =>
      severityOrder[a.severity] - severityOrder[b.severity] ||
      a.packageName.localeCompare(b.packageName),
  );

  return {
    success: true,
    tool: "analyze_dependency_health",
    projectPath: resolvedProject.originalPath,
    packageManager,
    packageName:
      typeof packageJson.name === "string"
        ? packageJson.name
        : undefined,
    packageVersion:
      typeof packageJson.version === "string"
        ? packageJson.version
        : undefined,
    totalDependencies: declared.size,
    directDependencies: [...declared.values()].filter(
      (item) => item.kind === "dependency",
    ).length,
    devDependencies: [...declared.values()].filter(
      (item) => item.kind === "devDependency",
    ).length,
    peerDependencies: [...declared.values()].filter(
      (item) => item.kind === "peerDependency",
    ).length,
    optionalDependencies: [...declared.values()].filter(
      (item) => item.kind === "optionalDependency",
    ).length,
    importedExternalPackages: importedPackages.length,
    missingDependencies: summaryCounts.missing,
    unusedDependencies: summaryCounts.unused,
    duplicateDependencies: summaryCounts.duplicate,
    outdatedDependencies: summaryCounts.outdated,
    deprecatedDependencies: summaryCounts.deprecated,
    findings,
    dependencies,
    duplicates,
    scannedFiles: sourceFiles.map((file) =>
      normalize(path.relative(analysisPath, file)),
    ),
    warnings,
  };
}

export function registerAnalyzeDependencyHealthTool(server: McpServer) {
  server.registerTool(
    "analyze_dependency_health",
    {
      description:
        "Analyze a JavaScript/TypeScript project's dependency health: missing and possibly unused dependencies, duplicate installed versions, outdated packages, dependency placement, package manager, and dependency inventory.",
      inputSchema: z.object({
        projectPath: z.string(),
      }),
    },
    async ({ projectPath }) => {
      try {
        const report = await analyzeDependencyHealth(projectPath);

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
                  tool: "analyze_dependency_health",
                  error:
                    error instanceof Error
                      ? error.message
                      : "Failed to analyze dependency health.",
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