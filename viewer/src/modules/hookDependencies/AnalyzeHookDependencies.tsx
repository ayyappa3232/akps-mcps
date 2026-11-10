import { useMemo, useState } from "react";
import {
  Anchor,
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  FileCode2,
  Layers,
  RefreshCw,
  Search,
  Wrench,
  XCircle,
  Zap,
} from "lucide-react";
import SecuritySelect from "../security/SecuritySelect";
import "./analyze-hook-dependencies.css";

type HookSeverity = "critical" | "high" | "medium" | "low" | "info";

type HookName =
  | "useEffect"
  | "useLayoutEffect"
  | "useInsertionEffect"
  | "useMemo"
  | "useCallback"
  | "useImperativeHandle";

type HookCategory = "effect" | "memoization";
type HookScope = "all" | "effects" | "memoization";
type OwnerKind = "component" | "custom-hook" | "function";
type IssueGroup = "missing" | "unstable" | "effects" | "unneeded";

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
  lines: number[];
  dependencies: string[];
}

interface DependencyRow {
  expression: string;
  status: DependencyStatus;
  usedLines: number[];
  note: string;
}

interface HookSuggestion {
  strategy: FixStrategy;
  confidence: "high" | "medium" | "low";
  title: string;
  summary: string;
  steps: string[];
  suggestedDeps?: string[];
  exampleCode?: string;
  caveats: string[];
}

interface HookFinding {
  id: string;
  severity: HookSeverity;
  hook: HookName;
  category: HookCategory;
  owner: string;
  ownerKind: OwnerKind;
  filePath: string;
  startLine: number;
  endLine: number;
  score: number;
  issueCount: number;
  groups: IssueGroup[];
  title: string;
  description: string;
  declaredDeps: string[] | null;
  reads: string[];
  dependencies: DependencyRow[];
  issues: HookIssue[];
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
  groupCounts: Record<IssueGroup, number>;
  issueCounts: Record<IssueKind, number>;
  hookStats: { hook: HookName; analyzed: number; withIssues: number }[];
  summary: Record<HookSeverity, number>;
  findings: HookFinding[];
  hotspots: HookHotspot[];
  warnings: string[];
}

interface AnalyzeHookDependenciesProps {
  projectPath: string;
  onProjectPathChange?: (value: string) => void;
  apiUrl?: string;
}

type GroupFilter = "all" | IssueGroup;
type SortKey = "impact" | "issues" | "location";

const DEFAULT_API_URL = "http://127.0.0.1:4174/api/analyze-hook-dependencies";

const GROUP_LABEL: Record<GroupFilter, string> = {
  all: "All",
  missing: "Missing",
  unstable: "Unstable",
  effects: "Effects",
  unneeded: "Unneeded",
};

const SCOPE_LABEL: Record<HookScope, string> = {
  all: "All hooks",
  effects: "Effects only",
  memoization: "useMemo & useCallback",
};

const SEVERITY_FILTER_LABEL: Record<HookSeverity, string> = {
  info: "Show everything",
  low: "Low and above",
  medium: "Medium and above",
  high: "High and above",
  critical: "Critical only",
};

const OWNER_LABEL: Record<OwnerKind, string> = {
  component: "Component",
  "custom-hook": "Custom hook",
  function: "Function",
};

const STATUS_LABEL: Record<DependencyStatus, string> = {
  ok: "OK",
  missing: "Missing",
  unstable: "Unstable",
  extra: "Unused",
  "outer-scope": "Outside component",
  "ref-current": "ref.current",
  duplicate: "Duplicate",
  complex: "Complex",
};

const STRATEGY_LABEL: Record<FixStrategy, string> = {
  "update-dependencies": "Update dependencies",
  "stabilize-dependency": "Stabilize value",
  "remove-dependency": "Clean up array",
  "add-dependency-array": "Add array",
  "add-cleanup": "Add cleanup",
  "fix-async-effect": "Fix async effect",
  "break-update-loop": "Break loop",
};

function baseName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1];
}

function placeLabel(finding: HookFinding): string {
  return `${baseName(finding.filePath)}:${finding.startLine}-${finding.endLine}`;
}

function hookIcon(category: HookCategory, size = 17) {
  return category === "effect" ? <Zap size={size} /> : <Layers size={size} />;
}

function formatLines(lines: number[]): string {
  if (lines.length === 0) return "";
  const shown = lines.slice(0, 3).join(", ");
  return lines.length > 3 ? `${shown}…` : shown;
}

/* -------------------------------------------------------------------------- */
/*  Issues                                                                    */
/* -------------------------------------------------------------------------- */

function IssueList({ finding }: { finding: HookFinding }) {
  return (
    <ul className="hook-issues">
      {finding.issues.map((issue, index) => (
        <li key={`${issue.kind}-${index}`}>
          <div className="hook-issue-head">
            <span className={`hook-badge hook-badge-${issue.severity}`}>
              {issue.severity}
            </span>
            <strong>{issue.title}</strong>
            {issue.lines.length > 0 && (
              <span className="hook-issue-line">
                {issue.lines.length === 1 ? "line" : "lines"}{" "}
                {formatLines(issue.lines)}
              </span>
            )}
          </div>
          <p>{issue.message}</p>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/*  Dependencies                                                              */
/* -------------------------------------------------------------------------- */

function DependencyPanel({ finding }: { finding: HookFinding }) {
  const hasArray = finding.declaredDeps !== null;

  return (
    <section className="hook-box">
      <h4>Dependencies</h4>

      {!hasArray && (
        <p>
          This hook has no dependency array, so React runs it after every
          render.
        </p>
      )}

      {hasArray && finding.dependencies.length === 0 && (
        <p>The dependency array is empty, so this hook runs once.</p>
      )}

      {finding.dependencies.length > 0 && (
        <ul className="hook-deps">
          {finding.dependencies.map((row, index) => (
            <li key={`${row.expression}-${index}`}>
              <code className="hook-mono">{row.expression}</code>
              <span className={`hook-status hook-status-${row.status}`}>
                {STATUS_LABEL[row.status]}
              </span>
              <span className="hook-dep-note">{row.note}</span>
            </li>
          ))}
        </ul>
      )}

      {finding.reads.length > 0 && (
        <>
          <p className="hook-reads-label">Values read inside this hook</p>
          <ul className="hook-reads">
            {finding.reads.map((read) => (
              <li key={read}>{read}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Source                                                                    */
/* -------------------------------------------------------------------------- */

function SourcePanel({ finding }: { finding: HookFinding }) {
  const lines = finding.snippet.split("\n");
  const flagged = new Set(finding.highlightLines);

  return (
    <section className="hook-box">
      <div className="hook-compare-head">
        <h4>Source</h4>
        <span className="hook-compare-note">
          {flagged.size === 0
            ? "No single line to point at."
            : `${flagged.size} ${flagged.size === 1 ? "line" : "lines"} highlighted.`}
        </span>
      </div>

      <div className="hook-code" role="region" aria-label="Hook source code">
        {lines.map((line, index) => {
          const number = finding.snippetStartLine + index;

          return (
            <div
              key={number}
              className={`hook-code-line ${flagged.has(number) ? "changed" : ""}`}
            >
              <span className="hook-code-number">{number}</span>
              <code>{line || " "}</code>
            </div>
          );
        })}

        {finding.snippetTruncated && (
          <div className="hook-code-more">
            … {finding.endLine - finding.startLine + 1 - lines.length} more
            lines in this hook
          </div>
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Suggested fix                                                             */
/* -------------------------------------------------------------------------- */

function FixPanel({ finding }: { finding: HookFinding }) {
  const [copied, setCopied] = useState<"" | "deps" | "example" | "location">("");
  const [copyFailed, setCopyFailed] = useState(false);
  const suggestion = finding.suggestion;

  async function copy(kind: "deps" | "example" | "location", value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      setCopyFailed(false);
      window.setTimeout(() => setCopied(""), 2000);
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    <section className="hook-box hook-refactor">
      <div className="hook-refactor-head">
        <h4>
          <Wrench size={14} /> Suggested fix
        </h4>

        <div className="hook-refactor-badges">
          <span className="hook-kind-badge">
            {STRATEGY_LABEL[suggestion.strategy]}
          </span>
          <span className={`hook-confidence hook-confidence-${suggestion.confidence}`}>
            {suggestion.confidence} confidence
          </span>
        </div>
      </div>

      <p className="hook-refactor-title">{suggestion.title}</p>
      <p>{suggestion.summary}</p>

      {finding.depsChange && (
        <div className="hook-compare" style={{ marginTop: 14 }}>
          <div className="hook-pane">
            <span className="hook-pane-label">
              Current (line {finding.depsChange.line})
            </span>
            <div className="hook-code hook-code-inline">
              <div className="hook-code-line removed">
                <span className="hook-code-number">−</span>
                <code>{finding.depsChange.before}</code>
              </div>
            </div>
          </div>

          <div className="hook-pane">
            <span className="hook-pane-label">Suggested</span>
            <div className="hook-code hook-code-inline">
              <div className="hook-code-line added">
                <span className="hook-code-number">+</span>
                <code>{finding.depsChange.after}</code>
              </div>
            </div>
          </div>
        </div>
      )}

      <ol className="hook-steps">
        {suggestion.steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>

      {suggestion.exampleCode && (
        <div className="hook-example">
          <span className="hook-pane-label">Example</span>
          <div className="hook-code" role="region" aria-label="Example fix">
            {suggestion.exampleCode.split("\n").map((line, index) => (
              <div key={index} className="hook-code-line">
                <span className="hook-code-number">{index + 1}</span>
                <code>{line || " "}</code>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="hook-actions">
        {finding.depsChange && (
          <button
            type="button"
            onClick={() => copy("deps", finding.depsChange!.after)}
          >
            {copied === "deps" ? <Check size={14} /> : <Copy size={14} />}
            {copied === "deps" ? "Copied" : "Copy dependency array"}
          </button>
        )}

        {suggestion.exampleCode && (
          <button
            type="button"
            onClick={() => copy("example", suggestion.exampleCode!)}
          >
            {copied === "example" ? <Check size={14} /> : <Copy size={14} />}
            {copied === "example" ? "Copied" : "Copy example"}
          </button>
        )}

        <button
          type="button"
          onClick={() =>
            copy("location", `${finding.filePath}:${finding.startLine}`)
          }
        >
          {copied === "location" ? <Check size={14} /> : <Copy size={14} />}
          {copied === "location" ? "Copied" : "Copy location"}
        </button>
      </div>

      {copyFailed && (
        <p className="hook-fine-print">
          The browser blocked clipboard access. Select the text above and copy
          it manually.
        </p>
      )}

      {suggestion.caveats.length > 0 && (
        <ul className="hook-caveats">
          {suggestion.caveats.map((caveat, index) => (
            <li key={index}>{caveat}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  View                                                                      */
/* -------------------------------------------------------------------------- */

export default function AnalyzeHookDependencies({
  projectPath,
  onProjectPathChange,
  apiUrl = DEFAULT_API_URL,
}: AnalyzeHookDependenciesProps) {
  const [focusFile, setFocusFile] = useState("");
  const [hookScope, setHookScope] = useState<HookScope>("all");
  const [minSeverity, setMinSeverity] = useState<HookSeverity>("info");
  const [includeTests, setIncludeTests] = useState(false);

  const [report, setReport] = useState<HookDependencyReport | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState<GroupFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("impact");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function analyze() {
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
          filePath: focusFile.trim() || undefined,
          hookScope,
          minSeverity,
          includeTests,
        }),
      });

      const data = await response.json();

      if (!response.ok || data.success === false) {
        throw new Error(data.error || "Hook dependency analysis failed.");
      }

      const nextReport = data as HookDependencyReport;
      setReport(nextReport);
      setSelectedId(nextReport.findings[0]?.id ?? null);
      setSearch("");
      setGroupFilter("all");
      setSortKey("impact");
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

  const visibleFindings = useMemo(() => {
    if (!report) return [];

    const query = search.trim().toLowerCase();

    const filtered = report.findings.filter((finding) => {
      if (groupFilter !== "all" && !finding.groups.includes(groupFilter)) {
        return false;
      }
      if (!query) return true;

      return [
        finding.title,
        finding.hook,
        finding.owner,
        finding.filePath,
        ...finding.issues.map(
          (issue) => `${issue.title} ${issue.dependencies.join(" ")}`
        ),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

    return [...filtered].sort((a, b) => {
      if (sortKey === "issues") {
        return b.issueCount - a.issueCount || b.score - a.score;
      }
      if (sortKey === "location") {
        return (
          a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine
        );
      }
      return b.score - a.score;
    });
  }, [report, search, groupFilter, sortKey]);

  const selectedFinding =
    visibleFindings.find((finding) => finding.id === selectedId) ??
    visibleFindings[0] ??
    null;

  function toggleGroup(group: IssueGroup) {
    setGroupFilter(groupFilter === group ? "all" : group);
  }

  return (
    <div className="hook-analyzer">
      <div className="hook-title-row">
        <div className="hook-title-icon">
          <Anchor size={24} />
        </div>

        <div>
          <h1>Hook Dependency Analyzer</h1>
          <p>
            Check useEffect, useMemo, and useCallback dependency arrays, spot
            stale values and missing cleanup, and get the corrected array.
          </p>
        </div>
      </div>

      <section className="hook-input-card">
        <div className="hook-field hook-field-wide">
          <label htmlFor="hook-project-path">Project path</label>
          <input
            id="hook-project-path"
            value={projectPath}
            onChange={(event) => onProjectPathChange?.(event.target.value)}
            placeholder="/path/to/your/project"
          />
        </div>

        <div className="hook-field">
          <label htmlFor="hook-focus-file">Focus file (optional)</label>
          <input
            id="hook-focus-file"
            value={focusFile}
            onChange={(event) => setFocusFile(event.target.value)}
            placeholder="src/screens/Profile.tsx"
          />
        </div>

        <button
          type="button"
          className="hook-analyze-button"
          onClick={analyze}
          disabled={loading}
        >
          {loading ? (
            <>
              <span className="hook-spinner" />
              Scanning...
            </>
          ) : (
            <>
              <Anchor size={17} />
              Analyze Hooks
            </>
          )}
        </button>

        <div className="hook-options">
          <div className="hook-field">
            <span className="hook-field-label">Hooks</span>
            <SecuritySelect
              ariaLabel="Hooks to analyze"
              value={hookScope}
              onChange={setHookScope}
              options={(Object.keys(SCOPE_LABEL) as HookScope[]).map((scope) => ({
                value: scope,
                label: SCOPE_LABEL[scope],
              }))}
            />
          </div>

          <div className="hook-field">
            <span className="hook-field-label">Minimum severity</span>
            <SecuritySelect
              ariaLabel="Minimum severity"
              value={minSeverity}
              onChange={setMinSeverity}
              options={(Object.keys(SEVERITY_FILTER_LABEL) as HookSeverity[]).map(
                (severity) => ({
                  value: severity,
                  label: SEVERITY_FILTER_LABEL[severity],
                })
              )}
            />
          </div>

          <label className="hook-check">
            <input
              type="checkbox"
              checked={includeTests}
              onChange={(event) => setIncludeTests(event.target.checked)}
            />
            Include test files
          </label>
        </div>
      </section>

      {error && (
        <div className="hook-error" role="alert">
          <XCircle size={18} />
          {error}
        </div>
      )}

      {report && (
        <>
          <div className="hook-status-row">
            <div
              className={`hook-success ${
                report.hooksWithIssues === 0 ? "" : "has-groups"
              }`}
            >
              {report.hooksWithIssues === 0 ? (
                <CheckCircle2 size={18} />
              ) : (
                <AlertTriangle size={18} />
              )}
              <strong>{report.hooksWithIssues}</strong>
              <span>
                {report.hooksWithIssues === 1 ? "hook has" : "hooks have"}{" "}
                issues
                {report.filePath ? ` in ${report.filePath}` : ""}
              </span>
            </div>

            <span className="hook-scope">
              {report.filesWithHooks} files with hooks ·{" "}
              {report.hooksAnalyzed} hooks checked · {report.totalIssues}{" "}
              {report.totalIssues === 1 ? "issue" : "issues"}
            </span>
          </div>

          <div className="hook-summary-grid">
            <button
              type="button"
              className={`hook-summary-card hook-type-missing ${
                groupFilter === "missing" ? "active" : ""
              }`}
              onClick={() => toggleGroup("missing")}
              aria-pressed={groupFilter === "missing"}
            >
              <div className="hook-summary-icon">
                <AlertTriangle size={17} />
              </div>
              <div>
                <strong>{report.groupCounts.missing}</strong>
                <span>Missing dependencies</span>
              </div>
            </button>

            <button
              type="button"
              className={`hook-summary-card hook-type-unstable ${
                groupFilter === "unstable" ? "active" : ""
              }`}
              onClick={() => toggleGroup("unstable")}
              aria-pressed={groupFilter === "unstable"}
            >
              <div className="hook-summary-icon">
                <RefreshCw size={17} />
              </div>
              <div>
                <strong>{report.groupCounts.unstable}</strong>
                <span>Unstable dependencies</span>
              </div>
            </button>

            <button
              type="button"
              className={`hook-summary-card hook-type-effects ${
                groupFilter === "effects" ? "active" : ""
              }`}
              onClick={() => toggleGroup("effects")}
              aria-pressed={groupFilter === "effects"}
            >
              <div className="hook-summary-icon">
                <Zap size={17} />
              </div>
              <div>
                <strong>{report.groupCounts.effects}</strong>
                <span>Effect bugs · cleanup, loops, async</span>
              </div>
            </button>

            <div className="hook-summary-card static">
              <div className="hook-summary-icon neutral">
                <CheckCircle2 size={17} />
              </div>
              <div>
                <strong>{report.healthyHooks}</strong>
                <span>Healthy of {report.hooksAnalyzed} hooks checked</span>
              </div>
            </div>
          </div>

          {report.findings.length === 0 ? (
            <section className="hook-clean">
              <CheckCircle2 size={38} />
              <h3>No hook dependency problems found</h3>
              <p>
                {report.hooksAnalyzed === 0
                  ? `No ${
                      report.hookScope === "all"
                        ? "hooks"
                        : SCOPE_LABEL[report.hookScope]
                    } were found in the ${report.filesScanned} analyzed files${
                      report.filePath ? ` (${report.filePath})` : ""
                    }.`
                  : `All ${report.hooksAnalyzed} hooks in ${report.filesWithHooks} files have complete, stable dependency arrays${
                      report.minSeverity === "info"
                        ? ""
                        : ` at ${report.minSeverity} severity and above`
                    }.`}
              </p>
            </section>
          ) : (
            <section className="hook-workspace">
              <div className="hook-groups-panel">
                <div className="hook-panel-header">
                  <div>
                    <h2>Hooks with issues</h2>
                    <p>
                      {visibleFindings.length} of {report.findings.length}{" "}
                      hooks
                    </p>
                  </div>

                  <div className="hook-count-pill">
                    <Anchor size={15} />
                    {visibleFindings.length}
                  </div>
                </div>

                <div className="hook-filters">
                  <div className="hook-search">
                    <Search size={17} />
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search by file, component, or value..."
                      aria-label="Search hooks"
                    />
                  </div>

                  <div className="hook-filter-row">
                    <div
                      className="hook-type-filter"
                      role="group"
                      aria-label="Filter by problem type"
                    >
                      {(Object.keys(GROUP_LABEL) as GroupFilter[]).map(
                        (option) => (
                          <button
                            type="button"
                            key={option}
                            className={groupFilter === option ? "active" : ""}
                            aria-pressed={groupFilter === option}
                            onClick={() => setGroupFilter(option)}
                          >
                            {GROUP_LABEL[option]}
                          </button>
                        )
                      )}
                    </div>

                    <div className="hook-sort">
                      <SecuritySelect
                        ariaLabel="Sort hooks"
                        value={sortKey}
                        onChange={setSortKey}
                        options={[
                          { value: "impact", label: "Sort: impact" },
                          { value: "issues", label: "Sort: issue count" },
                          { value: "location", label: "Sort: file order" },
                        ]}
                      />
                    </div>
                  </div>
                </div>

                <div className="hook-groups-list">
                  {visibleFindings.length === 0 ? (
                    <div className="hook-empty">
                      <Anchor size={34} />
                      <h3>No matching hooks</h3>
                      <p>No hooks match the current filters.</p>
                    </div>
                  ) : (
                    visibleFindings.map((finding) => (
                      <button
                        type="button"
                        key={finding.id}
                        className={`hook-group ${
                          selectedFinding?.id === finding.id ? "selected" : ""
                        }`}
                        onClick={() => setSelectedId(finding.id)}
                      >
                        <div
                          className={`hook-group-icon hook-severity-${finding.severity}`}
                        >
                          {hookIcon(finding.category)}
                        </div>

                        <div className="hook-group-content">
                          <div className="hook-group-top">
                            <span
                              className={`hook-badge hook-badge-${finding.severity}`}
                            >
                              {finding.severity}
                            </span>
                            <span className="hook-kind-badge">
                              {finding.hook}
                            </span>
                            {finding.issueCount > 1 && (
                              <span className="hook-kind-badge">
                                {finding.issueCount} issues
                              </span>
                            )}
                          </div>

                          <h3>{finding.title}</h3>
                          <p className="hook-places">
                            {placeLabel(finding)} · {finding.owner}
                          </p>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>

              <aside className="hook-inspector">
                <div className="hook-panel-header">
                  <div>
                    <h2>Inspector</h2>
                    <p>What is wrong with this hook and how to fix it</p>
                  </div>
                </div>

                {selectedFinding ? (
                  <div className="hook-inspector-body">
                    <div className="hook-inspector-title">
                      <div
                        className={`hook-inspector-icon hook-severity-${selectedFinding.severity}`}
                      >
                        {hookIcon(selectedFinding.category, 20)}
                      </div>

                      <div>
                        <span
                          className={`hook-badge hook-badge-${selectedFinding.severity}`}
                        >
                          {selectedFinding.severity}
                        </span>
                        <h3>{selectedFinding.title}</h3>
                      </div>
                    </div>

                    <div className="hook-detail-grid">
                      <div>
                        <span>Hook</span>
                        <strong className="hook-mono">
                          {selectedFinding.hook}
                        </strong>
                      </div>
                      <div>
                        <span>{OWNER_LABEL[selectedFinding.ownerKind]}</span>
                        <strong title={selectedFinding.owner}>
                          {selectedFinding.owner}
                        </strong>
                      </div>
                      <div>
                        <span>Issues</span>
                        <strong>{selectedFinding.issueCount}</strong>
                      </div>
                      <div>
                        <span>Impact score</span>
                        <strong>{selectedFinding.score} / 100</strong>
                      </div>
                    </div>

                    <section className="hook-box">
                      <h4>What this means</h4>
                      <p>{selectedFinding.description}</p>
                    </section>

                    <section className="hook-box">
                      <h4>
                        {selectedFinding.issueCount === 1
                          ? "Issue found"
                          : "Issues found"}
                      </h4>
                      <IssueList finding={selectedFinding} />
                    </section>

                    <DependencyPanel
                      key={`deps-${selectedFinding.id}`}
                      finding={selectedFinding}
                    />

                    <SourcePanel
                      key={`src-${selectedFinding.id}`}
                      finding={selectedFinding}
                    />

                    <FixPanel
                      key={`fix-${selectedFinding.id}`}
                      finding={selectedFinding}
                    />
                  </div>
                ) : (
                  <div className="hook-inspector-empty">
                    <Anchor size={38} />
                    <h3>Select a hook</h3>
                    <p>
                      Choose a hook from the list to see its dependencies and
                      the fix it needs.
                    </p>
                  </div>
                )}
              </aside>
            </section>
          )}

          {report.hotspots.length > 0 && (
            <section className="hook-hotspots">
              <div className="hook-panel-header">
                <div>
                  <h2>Files with the most issues</h2>
                  <p>
                    Files where hooks need the most attention. Select one to
                    filter.
                  </p>
                </div>
              </div>

              <ul>
                {report.hotspots.map((file) => (
                  <li key={file.filePath}>
                    <button
                      type="button"
                      onClick={() => {
                        setSearch(file.filePath);
                        setGroupFilter("all");
                      }}
                    >
                      <FileCode2 size={14} />
                      <span title={file.filePath}>{file.filePath}</span>
                      <em>
                        {file.issueCount}{" "}
                        {file.issueCount === 1 ? "issue" : "issues"} ·{" "}
                        {file.percentage}% of {file.hookCount} hooks
                      </em>
                      <strong>{file.findingCount}</strong>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {report.warnings.length > 0 && (
            <section className="hook-analysis-notes">
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
