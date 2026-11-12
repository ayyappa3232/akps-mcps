import { Fragment, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  FileCode2,
  FileWarning,
  FlaskConical,
  Gauge,
  Search,
  Terminal,
  XCircle,
} from "lucide-react";
import SecuritySelect from "../security/SecuritySelect";
import "./analyze-test-impact.css";

type Priority = "critical" | "high" | "medium" | "low";
type GapSeverity = "high" | "medium" | "low";
type TestKind = "unit" | "integration" | "e2e";
type TestTypeFilter = "all" | "unit" | "e2e";
type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

type TestFramework =
  | "vitest"
  | "jest"
  | "playwright"
  | "cypress"
  | "mocha"
  | "node-test"
  | "unknown";

type Relation =
  | "changed-test"
  | "direct"
  | "transitive"
  | "type-only"
  | "mock"
  | "snapshot"
  | "naming"
  | "stale-import";

interface ChangedFile {
  path: string;
  status: ChangeStatus;
  oldPath?: string;
  kind: "source" | "test" | "config" | "asset";
  exports: string[];
  impactedTests: number;
}

interface ImpactReason {
  changedFile: string;
  changeStatus: ChangeStatus;
  relation: Relation;
  distance: number;
  via: string[];
}

interface ImpactedTest {
  id: string;
  filePath: string;
  kind: TestKind;
  framework: TestFramework;
  testCases: number;
  priority: Priority;
  summary: string;
  nearestDistance: number;
  changedFilesReached: number;
  reasonCount: number;
  reasons: ImpactReason[];
}

interface CoverageGap {
  id: string;
  filePath: string;
  status: ChangeStatus;
  severity: GapSeverity;
  reason: string;
  runtimeExports: string[];
  suggestedTestPath: string;
  skeleton: string;
  neighborTests: string[];
}

interface RunCommand {
  label: string;
  command: string;
  description: string;
  testCount: number;
}

interface BlastRadiusFile {
  filePath: string;
  status: ChangeStatus;
  impactedTests: number;
  directTests: number;
}

interface TestImpactReport {
  success: boolean;
  tool: "analyze_test_impact";
  projectPath: string;
  baseline: { kind: "git-ref" | "files"; label: string; commit?: string };
  testTypes: TestTypeFilter;
  maxDepth?: number;
  includeTypeOnly: boolean;
  includeUntracked: boolean;
  runner: {
    unit: TestFramework;
    e2e: TestFramework;
    packageManager: PackageManager;
    detected: boolean;
  };
  totalFiles: number;
  totalTests: number;
  totalTestCases: number;
  changedFileCount: number;
  ignoredChangeCount: number;
  changedFiles: ChangedFile[];
  impactedTestCount: number;
  impactedTestCases: number;
  skippedTests: number;
  reductionPercent: number;
  impactedTests: ImpactedTest[];
  coverageGaps: CoverageGap[];
  commands: RunCommand[];
  runAll: { required: boolean; reasons: string[] };
  summary: Record<Priority, number>;
  blastRadius: BlastRadiusFile[];
  warnings: string[];
}

interface AnalyzeTestImpactProps {
  projectPath: string;
  onProjectPathChange?: (value: string) => void;
  apiUrl?: string;
}

type ViewMode = "tests" | "gaps";
type LevelFilter = "all" | Priority;
type SortKey = "priority" | "distance" | "cases" | "name";
type DepthOption = "unlimited" | "3" | "1";

const DEFAULT_API_URL = "http://127.0.0.1:4174/api/analyze-test-impact";

const REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.\-/@^~{}:]*$/;

const TEST_TYPE_LABEL: Record<TestTypeFilter, string> = {
  all: "All tests",
  unit: "Unit and integration",
  e2e: "End-to-end only",
};

const DEPTH_LABEL: Record<DepthOption, string> = {
  unlimited: "Any depth",
  "3": "Up to 3 imports",
  "1": "Direct imports only",
};

const KIND_LABEL: Record<TestKind, string> = {
  unit: "Unit",
  integration: "Integration",
  e2e: "End-to-end",
};

const FRAMEWORK_LABEL: Record<TestFramework, string> = {
  vitest: "Vitest",
  jest: "Jest",
  playwright: "Playwright",
  cypress: "Cypress",
  mocha: "Mocha",
  "node-test": "Node test",
  unknown: "Unknown runner",
};

const RELATION_LABEL: Record<Relation, string> = {
  "changed-test": "Test changed",
  direct: "Direct import",
  transitive: "Indirect import",
  "type-only": "Types only",
  mock: "Mocked",
  snapshot: "Snapshot changed",
  naming: "Name match",
  "stale-import": "Imports deleted file",
};

const STATUS_LABEL: Record<ChangeStatus, string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  untracked: "New file",
};

const EXECUTOR: Record<PackageManager, string> = {
  npm: "npx",
  pnpm: "pnpm exec",
  yarn: "yarn",
  bun: "bunx",
};

function baseName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1];
}

function dirName(filePath: string): string {
  const parts = filePath.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
}

function quote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandForTest(test: ImpactedTest, manager: PackageManager): string {
  const exec = EXECUTOR[manager];
  const file = quote(test.filePath);

  switch (test.framework) {
    case "vitest":
      return `${exec} vitest run ${file}`;
    case "jest":
      return `${exec} jest ${file}`;
    case "mocha":
      return `${exec} mocha ${file}`;
    case "node-test":
      return `node --test ${file}`;
    case "playwright":
      return `${exec} playwright test ${file}`;
    case "cypress":
      return `${exec} cypress run --spec ${file}`;
    default:
      return test.filePath;
  }
}

function distanceLabel(test: ImpactedTest): string {
  const first = test.reasons[0];
  if (!first) return "-";
  if (first.relation === "changed-test") return "Test itself";
  if (first.relation === "snapshot") return "Snapshot";
  if (test.nearestDistance === 0) return "Name match";
  return test.nearestDistance === 1
    ? "Direct"
    : `${test.nearestDistance} imports`;
}

/* -------------------------------------------------------------------------- */
/*  Copy button                                                               */
/* -------------------------------------------------------------------------- */

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setFailed(false);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setFailed(true);
    }
  }

  return (
    <button type="button" onClick={copy} title={failed ? "Clipboard blocked" : label}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? "Copied" : failed ? "Select and copy" : label}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*  Dependency chain                                                          */
/* -------------------------------------------------------------------------- */

function Chain({ via }: { via: string[] }) {
  return (
    <div className="tia-chain" aria-label="Dependency chain">
      {via.map((file, index) => (
        <Fragment key={`${file}-${index}`}>
          {index > 0 && <ArrowRight size={12} className="tia-chain-arrow" />}
          <code
            className={`tia-chain-node ${
              index === 0 ? "first" : index === via.length - 1 ? "last" : ""
            }`}
            title={file}
          >
            {baseName(file)}
          </code>
        </Fragment>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  View                                                                      */
/* -------------------------------------------------------------------------- */

export default function AnalyzeTestImpact({
  projectPath,
  onProjectPathChange,
  apiUrl = DEFAULT_API_URL,
}: AnalyzeTestImpactProps) {
  const [changedInput, setChangedInput] = useState("");
  const [baseRef, setBaseRef] = useState("HEAD");
  const [testTypes, setTestTypes] = useState<TestTypeFilter>("all");
  const [depth, setDepth] = useState<DepthOption>("unlimited");
  const [includeTypeOnly, setIncludeTypeOnly] = useState(true);
  const [includeUntracked, setIncludeUntracked] = useState(true);

  const [report, setReport] = useState<TestImpactReport | null>(null);
  const [view, setView] = useState<ViewMode>("tests");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("priority");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const specifiedFiles = useMemo(
    () =>
      changedInput
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    [changedInput]
  );

  async function analyze() {
    if (!projectPath.trim()) {
      setError("Enter a project path before starting the analysis.");
      return;
    }

    const base = baseRef.trim();

    if (specifiedFiles.length === 0 && base && !REF_PATTERN.test(base)) {
      setError(
        "Baseline ref must be a branch, tag or commit, for example HEAD, main, v1.2.0 or a commit hash."
      );
      return;
    }

    if (specifiedFiles.length > 200) {
      setError("Enter at most 200 changed files.");
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
          baseRef: specifiedFiles.length === 0 ? base || undefined : undefined,
          changedFiles: specifiedFiles.length > 0 ? specifiedFiles : undefined,
          testTypes,
          maxDepth: depth === "unlimited" ? undefined : Number(depth),
          includeTypeOnly,
          includeUntracked,
        }),
      });

      const data = await response.json();

      if (!response.ok || data.success === false) {
        throw new Error(data.error || "Test impact analysis failed.");
      }

      const next = data as TestImpactReport;
      const nextView: ViewMode =
        next.impactedTests.length === 0 && next.coverageGaps.length > 0
          ? "gaps"
          : "tests";

      setReport(next);
      setView(nextView);
      setSelectedId(
        nextView === "tests"
          ? (next.impactedTests[0]?.id ?? null)
          : (next.coverageGaps[0]?.id ?? null)
      );
      setSearch("");
      setLevelFilter("all");
      setSortKey("priority");
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

  function switchView(next: ViewMode) {
    if (!report) return;
    setView(next);
    setLevelFilter("all");
    setSearch("");
    setSelectedId(
      next === "tests"
        ? (report.impactedTests[0]?.id ?? null)
        : (report.coverageGaps[0]?.id ?? null)
    );
  }

  const visibleTests = useMemo(() => {
    if (!report) return [];

    const query = search.trim().toLowerCase();

    const filtered = report.impactedTests.filter((test) => {
      if (levelFilter !== "all" && test.priority !== levelFilter) return false;
      if (!query) return true;

      return [
        test.filePath,
        test.summary,
        ...test.reasons.map((reason) => reason.changedFile),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

    if (sortKey === "priority") return filtered;

    return [...filtered].sort((a, b) => {
      if (sortKey === "distance") return a.nearestDistance - b.nearestDistance;
      if (sortKey === "cases") return b.testCases - a.testCases;
      return a.filePath.localeCompare(b.filePath);
    });
  }, [report, search, levelFilter, sortKey]);

  const visibleGaps = useMemo(() => {
    if (!report) return [];

    const query = search.trim().toLowerCase();

    const filtered = report.coverageGaps.filter((gap) => {
      if (levelFilter !== "all" && gap.severity !== levelFilter) return false;
      if (!query) return true;
      return [gap.filePath, gap.reason, gap.suggestedTestPath]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

    if (sortKey === "name") {
      return [...filtered].sort((a, b) => a.filePath.localeCompare(b.filePath));
    }

    if (sortKey === "cases") {
      return [...filtered].sort(
        (a, b) => b.runtimeExports.length - a.runtimeExports.length
      );
    }

    return filtered;
  }, [report, search, levelFilter, sortKey]);

  const selectedTest =
    view === "tests"
      ? (visibleTests.find((test) => test.id === selectedId) ??
        visibleTests[0] ??
        null)
      : null;

  const selectedGap =
    view === "gaps"
      ? (visibleGaps.find((gap) => gap.id === selectedId) ??
        visibleGaps[0] ??
        null)
      : null;

  const hasUrgent =
    (report?.summary.critical ?? 0) > 0 || (report?.runAll.required ?? false);

  const counts = useMemo(() => {
    const tally = { modified: 0, added: 0, deleted: 0 };
    for (const file of report?.changedFiles ?? []) {
      if (file.status === "deleted") tally.deleted++;
      else if (file.status === "added" || file.status === "untracked") {
        tally.added++;
      } else tally.modified++;
    }
    return tally;
  }, [report]);

  const nothingToShow =
    report !== null &&
    report.impactedTests.length === 0 &&
    report.coverageGaps.length === 0;

  return (
    <div className="tia-analyzer">
      <div className="tia-title-row">
        <div className="tia-title-icon">
          <FlaskConical size={24} />
        </div>

        <div>
          <h1>Test Impact Analyzer</h1>
          <p>
            Find the tests affected by the code you changed, see why each one
            matters, run only those, and spot changed code that has no test.
          </p>
        </div>
      </div>

      <section className="tia-input-card">
        <div className="tia-field tia-field-wide">
          <label htmlFor="tia-project-path">Project path</label>
          <input
            id="tia-project-path"
            value={projectPath}
            onChange={(event) => onProjectPathChange?.(event.target.value)}
            placeholder="/path/to/your/project"
          />
        </div>

        <div className="tia-field">
          <label htmlFor="tia-changed-files">Changed files (optional)</label>
          <input
            id="tia-changed-files"
            value={changedInput}
            onChange={(event) => setChangedInput(event.target.value)}
            placeholder="src/utils/format.ts, src/api/users.ts"
          />
        </div>

        <button
          type="button"
          className="tia-analyze-button"
          onClick={analyze}
          disabled={loading}
        >
          {loading ? (
            <>
              <span className="tia-spinner" />
              Analyzing...
            </>
          ) : (
            <>
              <FlaskConical size={17} />
              Find Impacted Tests
            </>
          )}
        </button>

        <div className="tia-options">
          <div className="tia-field">
            <label htmlFor="tia-base-ref">Changes since</label>
            <input
              id="tia-base-ref"
              value={baseRef}
              onChange={(event) => setBaseRef(event.target.value)}
              placeholder="HEAD, main or v1.2.0"
              disabled={specifiedFiles.length > 0}
            />
            <p className="tia-field-hint">
              {specifiedFiles.length > 0
                ? "Ignored while specific files are entered."
                : "HEAD means your uncommitted changes."}
            </p>
          </div>

          <div className="tia-field">
            <span className="tia-field-label">Test types</span>
            <SecuritySelect
              ariaLabel="Test types"
              value={testTypes}
              onChange={setTestTypes}
              options={(Object.keys(TEST_TYPE_LABEL) as TestTypeFilter[]).map(
                (item) => ({ value: item, label: TEST_TYPE_LABEL[item] })
              )}
            />
          </div>

          <div className="tia-field">
            <span className="tia-field-label">Search depth</span>
            <SecuritySelect
              ariaLabel="Search depth"
              value={depth}
              onChange={setDepth}
              options={(Object.keys(DEPTH_LABEL) as DepthOption[]).map(
                (item) => ({ value: item, label: DEPTH_LABEL[item] })
              )}
            />
          </div>
        </div>

        <div className="tia-options tia-options-secondary">
          <label className="tia-check">
            <input
              type="checkbox"
              checked={includeTypeOnly}
              onChange={(event) => setIncludeTypeOnly(event.target.checked)}
            />
            Include type-only and mocked links
          </label>

          <label className="tia-check">
            <input
              type="checkbox"
              checked={includeUntracked}
              onChange={(event) => setIncludeUntracked(event.target.checked)}
            />
            Include new untracked files
          </label>
        </div>
      </section>

      {error && (
        <div className="tia-error" role="alert">
          <XCircle size={18} />
          {error}
        </div>
      )}

      {report && (
        <>
          <div className="tia-status-row">
            <div className={`tia-success ${hasUrgent ? "has-groups" : ""}`}>
              {hasUrgent ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
              <strong>{report.impactedTestCount}</strong>
              <span>
                of {report.totalTests}{" "}
                {report.totalTests === 1 ? "test needs" : "tests need"} to run
              </span>
            </div>

            <div className="tia-status-right">
              <span
                className={`tia-saved ${report.runAll.required ? "all" : ""}`}
                title={`${report.skippedTests} tests can be skipped`}
              >
                {report.runAll.required
                  ? "Run the full suite"
                  : report.totalTests === 0
                    ? "No tests found"
                    : `${report.reductionPercent}% fewer tests`}
              </span>

              <span className="tia-scope">
                {report.baseline.kind === "git-ref"
                  ? `${report.baseline.label}${
                      report.baseline.commit ? ` (${report.baseline.commit})` : ""
                    } → working tree`
                  : report.baseline.label}{" "}
                · {report.changedFileCount} changed{" "}
                {report.changedFileCount === 1 ? "file" : "files"}
              </span>
            </div>
          </div>

          {report.runAll.required && (
            <section className="tia-runall" role="alert">
              <AlertTriangle size={18} />
              <div>
                <h3>A shared file changed, so run the full suite</h3>
                {report.runAll.reasons.map((reason, index) => (
                  <p key={`${index}-${reason}`}>{reason}</p>
                ))}
              </div>
            </section>
          )}

          <div className="tia-summary-grid">
            <button
              type="button"
              className={`tia-summary-card tia-view-tests ${
                view === "tests" ? "active" : ""
              }`}
              onClick={() => switchView("tests")}
              aria-pressed={view === "tests"}
            >
              <div className="tia-summary-icon">
                <FlaskConical size={17} />
              </div>
              <div>
                <strong>{report.impactedTestCount}</strong>
                <span>Tests to run</span>
                <span className="tia-summary-sub">
                  {report.impactedTestCases} of {report.totalTestCases} test cases
                </span>
              </div>
            </button>

            <button
              type="button"
              className={`tia-summary-card tia-view-gaps ${
                view === "gaps" ? "active" : ""
              }`}
              onClick={() => switchView("gaps")}
              aria-pressed={view === "gaps"}
            >
              <div className="tia-summary-icon">
                <FileWarning size={17} />
              </div>
              <div>
                <strong>{report.coverageGaps.length}</strong>
                <span>Coverage gaps</span>
                <span className="tia-summary-sub">Changed code with no test</span>
              </div>
            </button>

            <div className="tia-summary-card static">
              <div className="tia-summary-icon neutral">
                <FileCode2 size={17} />
              </div>
              <div>
                <strong>{report.changedFileCount}</strong>
                <span>Changed files</span>
                <span className="tia-summary-sub">
                  {counts.modified} modified · {counts.added} new ·{" "}
                  {counts.deleted} deleted
                </span>
              </div>
            </div>

            <div className="tia-summary-card static">
              <div className="tia-summary-icon neutral">
                <Gauge size={17} />
              </div>
              <div>
                <strong>{report.skippedTests}</strong>
                <span>Tests skipped</span>
                <span className="tia-summary-sub">
                  {report.reductionPercent}% of {report.totalTests} tests
                </span>
              </div>
            </div>
          </div>

          {report.commands.length > 0 && (
            <section className="tia-run">
              <div className="tia-run-head">
                <div>
                  <h2>Run only what matters</h2>
                  <p>
                    Copy a command and run it from the project folder.
                    {report.runner.detected
                      ? ` Detected ${FRAMEWORK_LABEL[report.runner.unit]}${
                          report.runner.e2e !== "unknown"
                            ? ` and ${FRAMEWORK_LABEL[report.runner.e2e]}`
                            : ""
                        } with ${report.runner.packageManager}.`
                      : ""}
                  </p>
                </div>
                <Terminal size={20} />
              </div>

              <div className="tia-run-list">
                {report.commands.map((command, index) => (
                  <div className="tia-run-item" key={`${command.label}-${index}`}>
                    <div className="tia-run-label">
                      {command.label}
                      {command.testCount > 0 && (
                        <em>
                          {command.testCount}{" "}
                          {command.testCount === 1 ? "file" : "files"}
                        </em>
                      )}
                    </div>

                    <div className="tia-command">
                      <pre>
                        <code>{command.command}</code>
                      </pre>
                      <CopyButton value={command.command} label="Copy" />
                    </div>

                    <p className="tia-run-note">{command.description}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {nothingToShow ? (
            <section className="tia-clean">
              <CheckCircle2 size={38} />
              <h3>
                {report.changedFileCount === 0
                  ? "No changed code found"
                  : "No tests are affected"}
              </h3>
              <p>
                {report.changedFileCount === 0
                  ? "There are no code changes compared with the baseline. Make a change, pick an older baseline such as HEAD~1, or enter specific files above."
                  : `None of the ${report.changedFileCount} changed ${
                      report.changedFileCount === 1 ? "file" : "files"
                    } is reached by a test, and none has exports that need one.`}
              </p>
            </section>
          ) : (
            <section className="tia-workspace">
              <div className="tia-groups-panel">
                <div className="tia-panel-header">
                  <div>
                    <h2>{view === "tests" ? "Impacted Tests" : "Coverage Gaps"}</h2>
                    <p>
                      {view === "tests"
                        ? `${visibleTests.length} of ${report.impactedTests.length} tests`
                        : `${visibleGaps.length} of ${report.coverageGaps.length} files`}
                    </p>
                  </div>

                  <div className="tia-count-pill">
                    {view === "tests" ? (
                      <FlaskConical size={15} />
                    ) : (
                      <FileWarning size={15} />
                    )}
                    {view === "tests" ? visibleTests.length : visibleGaps.length}
                  </div>
                </div>

                <div className="tia-filters">
                  <div className="tia-search">
                    <Search size={17} />
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder={
                        view === "tests"
                          ? "Search by test, changed file or reason..."
                          : "Search by file or reason..."
                      }
                      aria-label="Search"
                    />
                  </div>

                  <div className="tia-filter-row">
                    <div
                      className="tia-type-filter"
                      role="group"
                      aria-label="Choose a list"
                    >
                      <button
                        type="button"
                        className={view === "tests" ? "active" : ""}
                        aria-pressed={view === "tests"}
                        onClick={() => switchView("tests")}
                      >
                        Tests
                      </button>
                      <button
                        type="button"
                        className={view === "gaps" ? "active" : ""}
                        aria-pressed={view === "gaps"}
                        onClick={() => switchView("gaps")}
                      >
                        Gaps
                      </button>
                    </div>

                    <div className="tia-sort">
                      <SecuritySelect
                        ariaLabel="Filter by priority"
                        value={levelFilter}
                        onChange={setLevelFilter}
                        options={
                          view === "tests"
                            ? [
                                { value: "all", label: "All priorities" },
                                { value: "critical", label: "Critical" },
                                { value: "high", label: "High" },
                                { value: "medium", label: "Medium" },
                                { value: "low", label: "Low" },
                              ]
                            : [
                                { value: "all", label: "All severities" },
                                { value: "high", label: "High" },
                                { value: "medium", label: "Medium" },
                                { value: "low", label: "Low" },
                              ]
                        }
                      />
                    </div>

                    <div className="tia-sort">
                      <SecuritySelect
                        ariaLabel="Sort"
                        value={sortKey}
                        onChange={setSortKey}
                        options={
                          view === "tests"
                            ? [
                                { value: "priority", label: "Sort: priority" },
                                { value: "distance", label: "Sort: distance" },
                                { value: "cases", label: "Sort: test cases" },
                                { value: "name", label: "Sort: name" },
                              ]
                            : [
                                { value: "priority", label: "Sort: severity" },
                                { value: "cases", label: "Sort: exports" },
                                { value: "name", label: "Sort: name" },
                              ]
                        }
                      />
                    </div>
                  </div>
                </div>

                <div className="tia-groups-list">
                  {(view === "tests" ? visibleTests.length : visibleGaps.length) ===
                  0 ? (
                    <div className="tia-empty">
                      <FlaskConical size={34} />
                      <h3>Nothing matches</h3>
                      <p>No items match the current filters.</p>
                    </div>
                  ) : view === "tests" ? (
                    visibleTests.map((test) => (
                      <button
                        type="button"
                        key={test.id}
                        className={`tia-group ${
                          selectedTest?.id === test.id ? "selected" : ""
                        }`}
                        onClick={() => setSelectedId(test.id)}
                      >
                        <div
                          className={`tia-group-icon tia-severity-${test.priority}`}
                        >
                          <FlaskConical size={17} />
                        </div>

                        <div className="tia-group-content">
                          <div className="tia-group-top">
                            <span className={`tia-badge tia-badge-${test.priority}`}>
                              {test.priority}
                            </span>
                            <span className="tia-kind-badge">
                              {KIND_LABEL[test.kind]}
                            </span>
                            <span className="tia-kind-badge">
                              {FRAMEWORK_LABEL[test.framework]}
                            </span>
                          </div>

                          <h3>{baseName(test.filePath)}</h3>
                          <p className="tia-places">
                            {dirName(test.filePath)} · {test.testCases}{" "}
                            {test.testCases === 1 ? "case" : "cases"} ·{" "}
                            {distanceLabel(test)}
                          </p>
                        </div>
                      </button>
                    ))
                  ) : (
                    visibleGaps.map((gap) => (
                      <button
                        type="button"
                        key={gap.id}
                        className={`tia-group ${
                          selectedGap?.id === gap.id ? "selected" : ""
                        }`}
                        onClick={() => setSelectedId(gap.id)}
                      >
                        <div
                          className={`tia-group-icon tia-severity-${gap.severity}`}
                        >
                          <FileWarning size={17} />
                        </div>

                        <div className="tia-group-content">
                          <div className="tia-group-top">
                            <span className={`tia-badge tia-badge-${gap.severity}`}>
                              {gap.severity}
                            </span>
                            <span className="tia-kind-badge">
                              {STATUS_LABEL[gap.status]}
                            </span>
                          </div>

                          <h3>{baseName(gap.filePath)}</h3>
                          <p className="tia-places">
                            {dirName(gap.filePath)} · {gap.runtimeExports.length}{" "}
                            {gap.runtimeExports.length === 1 ? "export" : "exports"}
                          </p>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>

              <aside className="tia-inspector">
                <div className="tia-panel-header">
                  <div>
                    <h2>Inspector</h2>
                    <p>
                      {view === "tests"
                        ? "Why the test runs and how to run it"
                        : "Why it needs a test and a starting point"}
                    </p>
                  </div>
                </div>

                {selectedTest ? (
                  <div className="tia-inspector-body">
                    <div className="tia-inspector-title">
                      <div
                        className={`tia-inspector-icon tia-severity-${selectedTest.priority}`}
                      >
                        <FlaskConical size={20} />
                      </div>

                      <div>
                        <span
                          className={`tia-badge tia-badge-${selectedTest.priority}`}
                        >
                          {selectedTest.priority}
                        </span>
                        <h3>{selectedTest.filePath}</h3>
                      </div>
                    </div>

                    <div className="tia-detail-grid">
                      <div>
                        <span>Type</span>
                        <strong>{KIND_LABEL[selectedTest.kind]}</strong>
                      </div>
                      <div>
                        <span>Runner</span>
                        <strong>{FRAMEWORK_LABEL[selectedTest.framework]}</strong>
                      </div>
                      <div>
                        <span>Test cases</span>
                        <strong>{selectedTest.testCases}</strong>
                      </div>
                      <div>
                        <span>Link</span>
                        <strong>{distanceLabel(selectedTest)}</strong>
                      </div>
                    </div>

                    <section className="tia-box">
                      <h4>Why this test runs</h4>
                      <p>{selectedTest.summary}</p>

                      <ul className="tia-reasons">
                        {selectedTest.reasons.map((reason, index) => (
                          <li
                            className="tia-reason"
                            key={`${reason.changedFile}-${reason.relation}-${index}`}
                          >
                            <div className="tia-reason-head">
                              <span className="tia-kind-badge">
                                {RELATION_LABEL[reason.relation]}
                              </span>
                              <span className="tia-kind-badge">
                                {STATUS_LABEL[reason.changeStatus]}
                              </span>
                              <span
                                className="tia-reason-file"
                                title={reason.changedFile}
                              >
                                {reason.changedFile}
                              </span>
                            </div>
                            <Chain via={reason.via} />
                          </li>
                        ))}
                      </ul>

                      {selectedTest.reasonCount > selectedTest.reasons.length && (
                        <p className="tia-more">
                          +{selectedTest.reasonCount - selectedTest.reasons.length}{" "}
                          more links not shown
                        </p>
                      )}
                    </section>

                    <section className="tia-box">
                      <h4>Run this test</h4>
                      <div className="tia-command">
                        <pre>
                          <code>
                            {commandForTest(
                              selectedTest,
                              report.runner.packageManager
                            )}
                          </code>
                        </pre>
                        <CopyButton
                          value={commandForTest(
                            selectedTest,
                            report.runner.packageManager
                          )}
                          label="Copy"
                        />
                      </div>
                      <p className="tia-run-note">
                        Run from the project folder.
                      </p>
                    </section>
                  </div>
                ) : selectedGap ? (
                  <div className="tia-inspector-body">
                    <div className="tia-inspector-title">
                      <div
                        className={`tia-inspector-icon tia-severity-${selectedGap.severity}`}
                      >
                        <FileWarning size={20} />
                      </div>

                      <div>
                        <span className={`tia-badge tia-badge-${selectedGap.severity}`}>
                          {selectedGap.severity}
                        </span>
                        <h3>{selectedGap.filePath}</h3>
                      </div>
                    </div>

                    <div className="tia-detail-grid">
                      <div>
                        <span>Status</span>
                        <strong>{STATUS_LABEL[selectedGap.status]}</strong>
                      </div>
                      <div>
                        <span>Exports</span>
                        <strong>{selectedGap.runtimeExports.length}</strong>
                      </div>
                      <div>
                        <span>Tests reaching it</span>
                        <strong>0</strong>
                      </div>
                      <div>
                        <span>Severity</span>
                        <strong>{selectedGap.severity}</strong>
                      </div>
                    </div>

                    <section className="tia-box">
                      <h4>Why it needs a test</h4>
                      <p>{selectedGap.reason}</p>
                    </section>

                    <section className="tia-box">
                      <h4>Exports without tests</h4>
                      <ul className="tia-pill-list">
                        {selectedGap.runtimeExports.map((name) => (
                          <li key={name} title={name}>
                            {name}
                          </li>
                        ))}
                      </ul>
                    </section>

                    <section className="tia-box tia-refactor">
                      <div className="tia-refactor-head">
                        <h4>Suggested test</h4>
                        <div className="tia-refactor-badges">
                          <span className="tia-kind-badge">Starter template</span>
                        </div>
                      </div>

                      <p>
                        Create <code>{selectedGap.suggestedTestPath}</code> and
                        replace the TODO comments with real assertions.
                      </p>

                      <pre className="tia-example">
                        <code>{selectedGap.skeleton}</code>
                      </pre>

                      <div className="tia-actions">
                        <CopyButton value={selectedGap.skeleton} label="Copy test" />
                        <CopyButton
                          value={selectedGap.suggestedTestPath}
                          label="Copy test path"
                        />
                      </div>

                      {selectedGap.neighborTests.length > 0 && (
                        <>
                          <p className="tia-example-label">
                            Existing tests nearby to copy the style from
                          </p>
                          <ul className="tia-pill-list">
                            {selectedGap.neighborTests.map((file) => (
                              <li key={file} title={file}>
                                {file}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </section>
                  </div>
                ) : (
                  <div className="tia-inspector-empty">
                    <FlaskConical size={38} />
                    <h3>Select an item</h3>
                    <p>
                      Choose a test to see why it runs, or a gap to get a starter
                      test for it.
                    </p>
                  </div>
                )}
              </aside>
            </section>
          )}

          {report.blastRadius.length > 0 && (
            <section className="tia-hotspots">
              <div className="tia-panel-header">
                <div>
                  <h2>Highest blast radius</h2>
                  <p>
                    Changed files that reach the most tests. Select one to
                    filter the list.
                  </p>
                </div>
              </div>

              <ul>
                {report.blastRadius.map((file) => (
                  <li key={file.filePath}>
                    <button
                      type="button"
                      onClick={() => {
                        setView("tests");
                        setLevelFilter("all");
                        setSearch(file.filePath);
                        setSelectedId(null);
                      }}
                    >
                      <FileCode2 size={14} />
                      <span title={file.filePath}>{file.filePath}</span>
                      <em>{file.directTests} direct</em>
                      <strong>{file.impactedTests}</strong>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {report.warnings.length > 0 && (
            <section className="tia-analysis-notes">
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
