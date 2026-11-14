import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  FileCode2,
  Package,
  RotateCcw,
  Search,
  Wrench,
  XCircle,
} from "lucide-react";
import SecuritySelect from "../security/SecuritySelect";
import "./analyze-upgrade-impact.css";

type Severity = "critical" | "high" | "medium" | "low" | "info";
type Strategy = "latest" | "next-major" | "compatible";
type Bump = "major" | "minor" | "patch" | "none" | "unknown";
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
  viaScripts: string[];
  viaConfig: string[];
  unused: boolean;
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
  related?: string;
}

interface UpgradePlan {
  title: string;
  summary: string;
  steps: string[];
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
  majorsBehind: number;
  verdict: Verdict;
  severity: Severity;
  riskScore: number;
  summary: string;
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

interface AnalyzeUpgradeImpactProps {
  projectPath: string;
  onProjectPathChange?: (value: string) => void;
  apiUrl?: string;
}

type BumpFilter = "all" | "major" | "minor" | "current";
type FocusFilter = "all" | "major" | "breaking" | "conflicts";
type SortKey = "risk" | "name" | "usage" | "gap";

const DEFAULT_API_URL = "http://127.0.0.1:4174/api/analyze-upgrade-impact";

const VERDICT_LABEL: Record<Verdict, string> = {
  "up-to-date": "up to date",
  safe: "safe",
  review: "review",
  risky: "risky",
  blocked: "blocked",
  unknown: "unknown",
};

const VERDICT_RANK: Record<Verdict, number> = {
  blocked: 0,
  risky: 1,
  review: 2,
  safe: 3,
  unknown: 4,
  "up-to-date": 5,
};

const BUMP_LABEL: Record<Bump, string> = {
  major: "major",
  minor: "minor",
  patch: "patch",
  none: "current",
  unknown: "unknown",
};

const BUMP_FILTER_LABEL: Record<BumpFilter, string> = {
  all: "All",
  major: "Major",
  minor: "Minor & patch",
  current: "Up to date",
};

const FOCUS_NOTE: Record<Exclude<FocusFilter, "all">, string> = {
  major: "with a major upgrade",
  breaking: "with breaking changes in your code",
  conflicts: "with compatibility problems",
};

const STRATEGY_OPTIONS: Array<{ value: Strategy; label: string }> = [
  { value: "latest", label: "Latest version" },
  { value: "next-major", label: "Next major only" },
  { value: "compatible", label: "Within declared range" },
];

const TARGET_SOURCE_LABEL: Record<TargetSource, string> = {
  override: "your choice",
  "registry-latest": "newest on npm",
  "registry-next-major": "next major on npm",
  "registry-compatible": "newest in range",
  "known-change": "first known breaking version",
  none: "",
};

const INSTALLED_SOURCE_LABEL: Record<VersionSource, string> = {
  node_modules: "from node_modules",
  lockfile: "from the lockfile",
  manifest: "estimated from package.json",
  unknown: "unknown",
};

const CONFLICT_LABEL: Record<ConflictKind, string> = {
  "peer-dependent": "peer dependent",
  "peer-unmet": "peer requirement",
  "peer-missing": "missing peer",
  engines: "Node version",
  types: "types",
  deprecated: "deprecated",
  notice: "notice",
};

function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

function baseName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1];
}

function versionLine(item: UpgradePackage): string {
  if (!item.installed) return "version unknown";
  if (!item.target) return item.installed;
  return `${item.installed} → ${item.target}`;
}

/* -------------------------------------------------------------------------- */
/*  Small pieces                                                              */
/* -------------------------------------------------------------------------- */

function CopyButton({
  label,
  value,
  onFail,
}: {
  label: string;
  value: string;
  onFail?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      onFail?.();
    }
  }

  return (
    <button type="button" onClick={copy}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? "Copied" : label}
    </button>
  );
}

function TryVersion({
  item,
  overridden,
  loading,
  onApply,
  onReset,
}: {
  item: UpgradePackage;
  overridden: boolean;
  loading: boolean;
  onApply: (version: string) => void;
  onReset: () => void;
}) {
  const [value, setValue] = useState(overridden ? item.target ?? "" : "");

  function submit() {
    const trimmed = value.trim();
    if (trimmed) onApply(trimmed);
  }

  return (
    <section className="up-box up-try">
      <h4>Try another version</h4>

      <div className="up-try-row">
        <input
          aria-label={`Version of ${item.name} to analyze`}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event: { key: string }) => {
            if (event.key === "Enter") submit();
          }}
          placeholder={item.latest ? `for example ${item.latest}` : "for example 2.1.0"}
          spellCheck={false}
        />

        <button
          type="button"
          className="up-try-apply"
          onClick={submit}
          disabled={loading || !value.trim()}
        >
          {loading ? <span className="up-spinner" /> : <ArrowRight size={14} />}
          Analyze
        </button>

        {overridden && (
          <button type="button" onClick={onReset} disabled={loading}>
            <RotateCcw size={14} />
            Reset
          </button>
        )}
      </div>

      <p className="up-fine-print-inline">
        Enter an exact version, a range such as ^5.0.0, or a tag such as next.
        The whole project is checked against that version.
      </p>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  View                                                                      */
/* -------------------------------------------------------------------------- */

export default function AnalyzeUpgradeImpact({
  projectPath,
  onProjectPathChange,
  apiUrl = DEFAULT_API_URL,
}: AnalyzeUpgradeImpactProps) {
  const [focusPackage, setFocusPackage] = useState("");
  const [strategy, setStrategy] = useState<Strategy>("latest");
  const [checkRegistry, setCheckRegistry] = useState(true);
  const [includeDev, setIncludeDev] = useState(true);
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  const [report, setReport] = useState<UpgradeReport | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [bumpFilter, setBumpFilter] = useState<BumpFilter>("all");
  const [focus, setFocus] = useState<FocusFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("risk");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copyFailed, setCopyFailed] = useState(false);

  async function analyze(nextOverrides: Record<string, string>, keepView: boolean) {
    if (!projectPath.trim()) {
      setError("Enter a project path before starting the analysis.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: projectPath.trim(),
          packageName: focusPackage.trim() || undefined,
          strategy,
          checkRegistry,
          includeDev,
          targets: nextOverrides,
        }),
      });

      const data = await response.json();

      if (!response.ok || data.success === false) {
        throw new Error(data.error || "Upgrade analysis failed.");
      }

      const nextReport = data as UpgradeReport;
      setReport(nextReport);
      setOverrides(nextOverrides);

      if (!keepView) {
        setSelectedId(nextReport.packages[0]?.id ?? null);
        setSearch("");
        setBumpFilter("all");
        setFocus("all");
        setSortKey("risk");
      }
    } catch (analysisError) {
      setError(
        analysisError instanceof Error
          ? analysisError.message
          : "Unable to analyze the project."
      );
    } finally {
      setLoading(false);
    }
  }

  const visiblePackages = useMemo(() => {
    if (!report) return [];

    const query = search.trim().toLowerCase();

    const filtered = report.packages.filter((item) => {
      if (bumpFilter === "major" && item.bump !== "major") return false;
      if (bumpFilter === "minor" && item.bump !== "minor" && item.bump !== "patch") {
        return false;
      }
      if (bumpFilter === "current" && item.bump !== "none") return false;

      if (focus === "major" && item.bump !== "major") return false;
      if (focus === "breaking" && item.breakingCount === 0) return false;
      if (
        focus === "conflicts" &&
        !item.conflicts.some((conflict) => conflict.severity !== "info")
      ) {
        return false;
      }

      if (!query) return true;

      return [item.name, item.installed ?? "", item.target ?? "", ...item.workspaces]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

    return [...filtered].sort((a, b) => {
      if (sortKey === "name") return a.name.localeCompare(b.name);
      if (sortKey === "usage") {
        return b.usage.fileCount - a.usage.fileCount || b.riskScore - a.riskScore;
      }
      if (sortKey === "gap") {
        return b.majorsBehind - a.majorsBehind || b.riskScore - a.riskScore;
      }
      return (
        b.riskScore - a.riskScore ||
        VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] ||
        a.name.localeCompare(b.name)
      );
    });
  }, [report, search, bumpFilter, focus, sortKey]);

  const selected =
    visiblePackages.find((item) => item.id === selectedId) ??
    visiblePackages[0] ??
    null;

  function toggleFocus(next: Exclude<FocusFilter, "all">) {
    setFocus(focus === next ? "all" : next);
  }

  function applyVersion(name: string, version: string) {
    void analyze({ ...overrides, [name]: version }, true);
  }

  function resetVersion(name: string) {
    const next = { ...overrides };
    delete next[name];
    void analyze(next, true);
  }

  return (
    <div className="up-analyzer">
      <div className="up-title-row">
        <div className="up-title-icon">
          <Package size={24} />
        </div>

        <div>
          <h1>Dependency Upgrade Impact Analyzer</h1>
          <p>
            See what will break in your code before you upgrade a package: how
            you use it, which known breaking changes match, what else has to
            move with it, and the order to do it in.
          </p>
        </div>
      </div>

      <section className="up-input-card">
        <div className="up-field up-field-wide">
          <label htmlFor="up-project-path">Project path</label>
          <input
            id="up-project-path"
            value={projectPath}
            onChange={(event) => onProjectPathChange?.(event.target.value)}
            placeholder="/path/to/your/project"
          />
        </div>

        <div className="up-field">
          <label htmlFor="up-focus-package">Focus package (optional)</label>
          <input
            id="up-focus-package"
            value={focusPackage}
            onChange={(event) => setFocusPackage(event.target.value)}
            placeholder="react"
            spellCheck={false}
          />
        </div>

        <button
          type="button"
          className="up-analyze-button"
          onClick={() => void analyze({}, false)}
          disabled={loading}
        >
          {loading ? (
            <>
              <span className="up-spinner" />
              Analyzing...
            </>
          ) : (
            <>
              <Package size={17} />
              Analyze Upgrades
            </>
          )}
        </button>

        <div className="up-options">
          <div className="up-field">
            <span className="up-field-label">Upgrade to</span>
            <SecuritySelect
              ariaLabel="Which version to analyze"
              value={strategy}
              onChange={setStrategy}
              options={STRATEGY_OPTIONS}
            />
          </div>

          <label className="up-check">
            <input
              type="checkbox"
              checked={checkRegistry}
              onChange={(event) => setCheckRegistry(event.target.checked)}
            />
            Check the npm registry
          </label>

          <label className="up-check">
            <input
              type="checkbox"
              checked={includeDev}
              onChange={(event) => setIncludeDev(event.target.checked)}
            />
            Include dev dependencies
          </label>
        </div>
      </section>

      {error && (
        <div className="up-error" role="alert">
          <XCircle size={18} />
          {error}
        </div>
      )}

      {report && (
        <>
          <div className="up-status-row">
            <div
              className={`up-success ${
                report.summary.blocked + report.summary.risky > 0 ? "has-groups" : ""
              }`}
            >
              {report.summary.blocked + report.summary.risky > 0 ? (
                <AlertTriangle size={18} />
              ) : (
                <CheckCircle2 size={18} />
              )}
              <strong>{report.totalDependencies}</strong>
              <span>
                {report.totalDependencies === 1 ? "dependency" : "dependencies"}{" "}
                analyzed, {report.outdatedCount} can be upgraded
              </span>
            </div>

            <span className="up-scope">
              {report.filesScanned} files · {report.packageManager} · Node{" "}
              {report.nodeVersion}
              {report.nodeVersionSource === "running" ? " (this tool)" : ""} ·{" "}
              {report.registryStatus === "ok"
                ? "npm registry checked"
                : report.registryStatus === "partial"
                  ? `npm registry partly checked (${report.registryFailures} failed)`
                  : report.registryStatus === "unavailable"
                    ? "npm registry not reachable"
                    : "npm registry not checked"}
            </span>
          </div>

          <div className="up-summary-grid">
            <div className="up-summary-card static">
              <div className="up-summary-icon tone-total">
                <Package size={17} />
              </div>
              <div>
                <strong>{report.totalDependencies}</strong>
                <span>
                  Dependencies · {report.outdatedCount} outdated ·{" "}
                  {report.upToDateCount} current
                </span>
              </div>
            </div>

            <button
              type="button"
              className={`up-summary-card ${focus === "major" ? "active" : ""}`}
              onClick={() => toggleFocus("major")}
              aria-pressed={focus === "major"}
            >
              <div className="up-summary-icon tone-major">
                <AlertTriangle size={17} />
              </div>
              <div>
                <strong>{report.majorCount}</strong>
                <span>
                  Major upgrades · {report.minorCount} minor · {report.patchCount}{" "}
                  patch
                </span>
              </div>
            </button>

            <button
              type="button"
              className={`up-summary-card ${focus === "breaking" ? "active" : ""}`}
              onClick={() => toggleFocus("breaking")}
              aria-pressed={focus === "breaking"}
            >
              <div className="up-summary-icon tone-breaking">
                <XCircle size={17} />
              </div>
              <div>
                <strong>{report.breakingPackageCount}</strong>
                <span>
                  Breaking changes · {plural(report.breakingTotal, "place")} in
                  your code
                </span>
              </div>
            </button>

            <button
              type="button"
              className={`up-summary-card ${focus === "conflicts" ? "active" : ""}`}
              onClick={() => toggleFocus("conflicts")}
              aria-pressed={focus === "conflicts"}
            >
              <div className="up-summary-icon tone-conflicts">
                <Wrench size={17} />
              </div>
              <div>
                <strong>{report.conflictPackageCount}</strong>
                <span>
                  Compatibility problems · {report.deprecatedCount} deprecated
                </span>
              </div>
            </button>
          </div>

          <section className="up-batch">
            <div className="up-panel-header">
              <div>
                <h2>Safe to upgrade together</h2>
                <p>
                  Minor and patch updates with nothing known to break and no
                  compatibility problems.
                </p>
              </div>

              <div className="up-count-pill">
                <CheckCircle2 size={15} />
                {report.safeBatch.count}
              </div>
            </div>

            {report.safeBatch.count === 0 ? (
              <p className="up-batch-empty">
                No safe batch was found. Packages that are current, major, or
                have a problem are listed below.
              </p>
            ) : (
              <div className="up-batch-body">
                <ul className="up-batch-list">
                  {report.safeBatch.packages.map((item) => (
                    <li key={item.name}>
                      <strong>{item.name}</strong>
                      <span>
                        {item.from} → {item.to}
                      </span>
                      {item.dev && <em>dev</em>}
                    </li>
                  ))}
                </ul>

                {report.safeBatch.commands.map((command) => (
                  <div className="up-command" key={command}>
                    <code>{command}</code>
                    <CopyButton
                      label="Copy"
                      value={command}
                      onFail={() => setCopyFailed(true)}
                    />
                  </div>
                ))}

                {copyFailed && (
                  <p className="up-fine-print-inline">
                    The browser blocked clipboard access. Select the command and
                    copy it manually.
                  </p>
                )}
              </div>
            )}
          </section>

          {report.totalDependencies === 0 ? (
            <section className="up-clean">
              <CheckCircle2 size={38} />
              <h3>No dependencies found</h3>
              <p>
                package.json has no registry dependencies to analyze
                {includeDev ? "" : ", and dev dependencies are excluded"}.
              </p>
            </section>
          ) : (
            <section className="up-workspace">
              <div className="up-groups-panel">
                <div className="up-panel-header">
                  <div>
                    <h2>Dependencies</h2>
                    <p>
                      {visiblePackages.length} of {report.packages.length}{" "}
                      packages
                      {focus !== "all" ? ` ${FOCUS_NOTE[focus]}` : ""}
                    </p>
                  </div>

                  <div className="up-count-pill">
                    <Package size={15} />
                    {visiblePackages.length}
                  </div>
                </div>

                <div className="up-filters">
                  <div className="up-search">
                    <Search size={17} />
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search by package, version, or workspace..."
                      aria-label="Search dependencies"
                    />
                  </div>

                  <div className="up-filter-row">
                    <div
                      className="up-type-filter"
                      role="group"
                      aria-label="Filter by upgrade size"
                    >
                      {(Object.keys(BUMP_FILTER_LABEL) as BumpFilter[]).map(
                        (option) => (
                          <button
                            type="button"
                            key={option}
                            className={bumpFilter === option ? "active" : ""}
                            aria-pressed={bumpFilter === option}
                            onClick={() => setBumpFilter(option)}
                          >
                            {BUMP_FILTER_LABEL[option]}
                          </button>
                        )
                      )}
                    </div>

                    <div className="up-sort">
                      <SecuritySelect
                        ariaLabel="Sort dependencies"
                        value={sortKey}
                        onChange={setSortKey}
                        options={[
                          { value: "risk", label: "Sort: risk" },
                          { value: "gap", label: "Sort: versions behind" },
                          { value: "usage", label: "Sort: files using it" },
                          { value: "name", label: "Sort: name" },
                        ]}
                      />
                    </div>
                  </div>
                </div>

                <div className="up-groups-list">
                  {visiblePackages.length === 0 ? (
                    <div className="up-empty">
                      <Package size={34} />
                      <h3>No matching packages</h3>
                      <p>No dependencies match the current filters.</p>
                    </div>
                  ) : (
                    visiblePackages.map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        className={`up-group ${
                          selected?.id === item.id ? "selected" : ""
                        }`}
                        onClick={() => setSelectedId(item.id)}
                      >
                        <div className={`up-group-icon up-verdict-${item.verdict}`}>
                          <Package size={17} />
                        </div>

                        <div className="up-group-content">
                          <div className="up-group-top">
                            <span className={`up-verdict up-verdict-${item.verdict}`}>
                              {VERDICT_LABEL[item.verdict]}
                            </span>
                            {item.bump !== "none" && item.bump !== "unknown" && (
                              <span className="up-kind-badge">
                                {BUMP_LABEL[item.bump]}
                              </span>
                            )}
                            {item.kind === "devDependencies" && (
                              <span className="up-kind-badge">dev</span>
                            )}
                            {item.usage.unused && (
                              <span className="up-kind-badge up-unused-badge">
                                no usage found
                              </span>
                            )}
                          </div>

                          <h3>{item.name}</h3>
                          <p className="up-versions">{versionLine(item)}</p>
                          <p className="up-places">
                            {plural(item.usage.fileCount, "file")}
                            {item.breakingCount > 0 &&
                              ` · ${item.breakingCount} breaking`}
                            {item.conflicts.length > 0 &&
                              ` · ${plural(item.conflicts.length, "note")}`}
                          </p>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>

              <aside className="up-inspector">
                <div className="up-panel-header">
                  <div>
                    <h2>Inspector</h2>
                    <p>What changes, what breaks, and the order to do it</p>
                  </div>
                </div>

                {selected ? (
                  <div className="up-inspector-body">
                    <div className="up-inspector-title">
                      <div
                        className={`up-inspector-icon up-verdict-${selected.verdict}`}
                      >
                        <Package size={20} />
                      </div>

                      <div>
                        <span className={`up-verdict up-verdict-${selected.verdict}`}>
                          {VERDICT_LABEL[selected.verdict]}
                        </span>
                        <h3>{selected.name}</h3>
                      </div>
                    </div>

                    <div className="up-detail-grid">
                      <div>
                        <span>Installed</span>
                        <strong>{selected.installed ?? "unknown"}</strong>
                        <em>{INSTALLED_SOURCE_LABEL[selected.installedSource]}</em>
                      </div>
                      <div>
                        <span>Target</span>
                        <strong>{selected.target ?? "none"}</strong>
                        <em>
                          {selected.target
                            ? `${BUMP_LABEL[selected.bump]} · ${
                                TARGET_SOURCE_LABEL[selected.targetSource]
                              }`
                            : "no newer version"}
                        </em>
                      </div>
                      <div>
                        <span>Used in</span>
                        <strong>{plural(selected.usage.fileCount, "file")}</strong>
                        <em>
                          {selected.usage.viaScripts.length > 0
                            ? `scripts: ${selected.usage.viaScripts.join(", ")}`
                            : selected.kind === "devDependencies"
                              ? "dev dependency"
                              : "dependency"}
                        </em>
                      </div>
                      <div>
                        <span>Risk score</span>
                        <strong>{selected.riskScore} / 100</strong>
                        <em>{selected.declaredRange} declared</em>
                      </div>
                    </div>

                    <TryVersion
                      key={`try-${selected.id}-${overrides[selected.name] ?? ""}`}
                      item={selected}
                      overridden={selected.name in overrides}
                      loading={loading}
                      onApply={(version) => applyVersion(selected.name, version)}
                      onReset={() => resetVersion(selected.name)}
                    />

                    <section className="up-box">
                      <h4>What this means</h4>
                      <p>{selected.summary}</p>
                      {selected.deprecated && (
                        <p className="up-note">
                          Deprecated: {selected.deprecated}
                        </p>
                      )}
                      {selected.usage.unused && (
                        <p className="up-note">
                          Nothing in the code, the scripts, or the config files
                          appears to use this package, and no installed package
                          needs it. If that is right, you can remove it instead
                          of upgrading it.
                        </p>
                      )}
                    </section>

                    {selected.breaking.length > 0 && (
                      <>
                        <h4 className="up-section-title">
                          Breaking changes in your code ({selected.breakingCount})
                        </h4>

                        {selected.breaking.map((change) => (
                          <section className="up-box up-change" key={change.id}>
                            <div className="up-change-head">
                              <span className={`up-badge up-badge-${change.severity}`}>
                                {change.severity}
                              </span>
                              <span className="up-kind-badge">
                                since {change.breaksIn}
                              </span>
                              <span className="up-kind-badge">
                                {plural(change.count, "place")}
                              </span>
                            </div>

                            <p className="up-change-title">{change.title}</p>
                            <p>{change.description}</p>

                            <ul className="up-locations">
                              {change.locations.map((location, index) => (
                                <li key={`${location.filePath}:${location.line}:${index}`}>
                                  <div className="up-location-head">
                                    <FileCode2 size={13} />
                                    <strong title={location.filePath}>
                                      {location.filePath}:{location.line}
                                    </strong>
                                  </div>
                                  <pre className="up-line">{location.snippet}</pre>
                                </li>
                              ))}

                              {change.hiddenLocations > 0 && (
                                <li className="up-locations-more">
                                  +{change.hiddenLocations} more not shown
                                </li>
                              )}
                            </ul>

                            {(change.before || change.after) && (
                              <pre className="up-code-block">
                                <code>
                                  {change.before ? `// before\n${change.before}` : ""}
                                  {change.before && change.after ? "\n\n" : ""}
                                  {change.after ? `// after\n${change.after}` : ""}
                                </code>
                              </pre>
                            )}

                            <div className="up-actions">
                              {change.after && (
                                <CopyButton
                                  label="Copy example"
                                  value={change.after}
                                  onFail={() => setCopyFailed(true)}
                                />
                              )}
                              {change.docs && (
                                <a
                                  href={change.docs}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                  className="up-link-button"
                                >
                                  <ExternalLink size={14} />
                                  Migration guide
                                </a>
                              )}
                            </div>
                          </section>
                        ))}
                      </>
                    )}

                    {selected.conflicts.length > 0 && (
                      <>
                        <h4 className="up-section-title">
                          Compatibility ({selected.conflicts.length})
                        </h4>

                        {selected.conflicts.map((conflict) => (
                          <section className="up-box up-change" key={conflict.id}>
                            <div className="up-change-head">
                              <span
                                className={`up-badge up-badge-${conflict.severity}`}
                              >
                                {conflict.severity}
                              </span>
                              <span className="up-kind-badge">
                                {CONFLICT_LABEL[conflict.kind]}
                              </span>
                            </div>
                            <p className="up-change-title">{conflict.title}</p>
                            <p>{conflict.description}</p>
                          </section>
                        ))}
                      </>
                    )}

                    {selected.breaking.length === 0 &&
                      selected.conflicts.length === 0 &&
                      selected.target && (
                        <section className="up-box up-ok">
                          <CheckCircle2 size={18} />
                          <p>
                            No known breaking changes match your code and no
                            compatibility problems were found.
                            {selected.bump === "major"
                              ? " This is a major version, so still read the release notes: this tool only knows a limited set of changes."
                              : ""}
                          </p>
                        </section>
                      )}

                    <section className="up-box">
                      <h4>How it is used</h4>

                      {selected.usage.fileCount === 0 &&
                      selected.usage.viaScripts.length === 0 &&
                      selected.usage.viaConfig.length === 0 ? (
                        <p>No source file, script, or config file uses it.</p>
                      ) : (
                        <>
                          {selected.usage.apis.length > 0 && (
                            <div className="up-chips" aria-label="APIs used">
                              {selected.usage.apis.map((api) => (
                                <span key={api.name} className="up-chip">
                                  {api.name}
                                  <em>{api.fileCount}</em>
                                </span>
                              ))}
                              {selected.usage.hiddenApis > 0 && (
                                <span className="up-chip up-chip-more">
                                  +{selected.usage.hiddenApis} more
                                </span>
                              )}
                            </div>
                          )}

                          <ul className="up-usage-list">
                            {selected.usage.locations.map((location, index) => (
                              <li key={`${location.filePath}:${location.line}:${index}`}>
                                <FileCode2 size={13} />
                                <span title={location.filePath}>
                                  {location.filePath}:{location.line}
                                </span>
                                <em>
                                  {location.kind}
                                  {location.isTest ? " · test" : ""}
                                </em>
                              </li>
                            ))}
                            {selected.usage.hiddenLocations > 0 && (
                              <li className="up-usage-more">
                                +{selected.usage.hiddenLocations} more imports
                              </li>
                            )}
                          </ul>

                          {selected.usage.viaScripts.length > 0 && (
                            <p className="up-fine-print-inline">
                              Used by package.json scripts:{" "}
                              {selected.usage.viaScripts.join(", ")}.
                            </p>
                          )}
                          {selected.usage.viaConfig.length > 0 && (
                            <p className="up-fine-print-inline">
                              Mentioned in config:{" "}
                              {selected.usage.viaConfig.map(baseName).join(", ")}.
                            </p>
                          )}
                        </>
                      )}
                    </section>

                    <section className="up-box up-plan">
                      <h4>
                        <Wrench size={14} /> {selected.plan.title}
                      </h4>
                      <p>{selected.plan.summary}</p>

                      {selected.plan.steps.length > 0 && (
                        <ol className="up-steps">
                          {selected.plan.steps.map((step, index) => (
                            <li key={index}>{step}</li>
                          ))}
                        </ol>
                      )}

                      {selected.plan.commands && (
                        <div className="up-command">
                          <code>{selected.plan.commands}</code>
                          <CopyButton
                            label="Copy"
                            value={selected.plan.commands}
                            onFail={() => setCopyFailed(true)}
                          />
                        </div>
                      )}

                      {selected.plan.caveats.length > 0 && (
                        <ul className="up-caveats">
                          {selected.plan.caveats.map((caveat, index) => (
                            <li key={index}>{caveat}</li>
                          ))}
                        </ul>
                      )}
                    </section>
                  </div>
                ) : (
                  <div className="up-inspector-empty">
                    <Package size={38} />
                    <h3>Select a package</h3>
                    <p>
                      Choose a package from the list to see how it is used, what
                      would break, and how to upgrade it.
                    </p>
                  </div>
                )}
              </aside>
            </section>
          )}

          {report.hotspots.length > 0 && (
            <section className="up-hotspots">
              <div className="up-panel-header">
                <div>
                  <h2>Files with the most breaking changes</h2>
                  <p>Select a file to filter the packages that affect it.</p>
                </div>
              </div>

              <ul>
                {report.hotspots.map((file) => (
                  <li key={file.filePath}>
                    <button
                      type="button"
                      onClick={() => {
                        setSearch(file.packages[0] ?? file.filePath);
                        setBumpFilter("all");
                        setFocus("breaking");
                      }}
                    >
                      <FileCode2 size={14} />
                      <span title={file.filePath}>{baseName(file.filePath)}</span>
                      <em>
                        {file.packages.slice(0, 2).join(", ")}
                        {file.packages.length > 2 ? ` +${file.packages.length - 2}` : ""}
                      </em>
                      <strong>{file.breakingCount}</strong>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {report.warnings.length > 0 && (
            <section className="up-analysis-notes">
              <AlertTriangle size={18} />
              <div>
                <h3>Analysis notes</h3>
                {report.warnings.map((warning, index) => (
                  <p key={`${index}-${warning}`}>• {warning}</p>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
