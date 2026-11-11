import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  FileCode2,
  GitCompare,
  Globe,
  Package,
  Search,
  Users,
  Wrench,
  XCircle,
} from "lucide-react";
import SecuritySelect from "../security/SecuritySelect";
import "./detect-breaking-api-changes.css";

type ChangeSeverity = "critical" | "high" | "medium" | "low" | "info";
type Confidence = "high" | "medium" | "low";
type ApiSurface = "export" | "route";
type AnalysisScope = "all" | "exports" | "routes";
type Exposure = "entry" | "module" | "route";
type SemverBump = "major" | "minor" | "patch";
type CompareMode = "ref" | "folder";

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
  kind: string;
  severity: ChangeSeverity;
  breaking: boolean;
  confidence: Confidence;
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

interface ApiChange {
  id: string;
  surface: ApiSurface;
  category: ChangeCategory;
  severity: ChangeSeverity;
  breaking: boolean;
  exposure: Exposure;
  symbolKind: string;
  name: string;
  filePath: string;
  baselineFilePath?: string;
  headFilePath?: string;
  baselineLine?: number;
  headLine?: number;
  title: string;
  description: string;
  issues: ChangeIssue[];
  before?: string;
  after?: string;
  deprecatedInBaseline: boolean;
  consumers: { count: number; files: string[]; hidden: number };
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

interface DetectBreakingApiChangesProps {
  projectPath: string;
  onProjectPathChange?: (value: string) => void;
  apiUrl?: string;
}

type SurfaceFilter = "all" | ApiSurface;
type SeverityFilter = "all" | Exclude<ChangeSeverity, "info">;
type SortKey = "severity" | "importers" | "name";

const DEFAULT_API_URL =
  "http://127.0.0.1:4174/api/detect-breaking-api-changes";

const REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.\-/@^~{}:]*$/;

const SURFACE_LABEL: Record<ApiSurface, string> = {
  export: "Exports",
  route: "Routes",
};

const CATEGORY_LABEL: Record<ChangeCategory, string> = {
  removed: "Removed",
  renamed: "Renamed",
  moved: "Moved",
  signature: "Signature",
  type: "Type",
  members: "Members",
  enum: "Enum",
  route: "Route",
  compatible: "Compatible",
};

const EXPOSURE_LABEL: Record<Exposure, string> = {
  entry: "Public API",
  module: "Internal",
  route: "HTTP route",
};

const SCOPE_LABEL: Record<AnalysisScope, string> = {
  all: "Exports and routes",
  exports: "Exports only",
  routes: "HTTP routes only",
};

const COMPARE_LABEL: Record<CompareMode, string> = {
  ref: "Git ref",
  folder: "Another folder",
};

const BUMP_LABEL: Record<SemverBump, string> = {
  major: "Major",
  minor: "Minor",
  patch: "Patch",
};

const BUMP_NOTE: Record<SemverBump, string> = {
  major: "breaking changes found",
  minor: "only compatible additions",
  patch: "no API changes",
};

const STRATEGY_LABEL: Record<MigrationStrategy, string> = {
  "restore-export": "Restore export",
  "deprecated-alias": "Deprecated alias",
  "re-export": "Re-export",
  "optional-parameter": "Optional parameter",
  "keep-parameter": "Keep parameter",
  "widen-type": "Widen type",
  "keep-member": "Keep member",
  "keep-enum-member": "Keep enum member",
  "keep-route": "Keep route",
  "optional-field": "Optional field",
  "keep-response-field": "Keep response field",
  "bump-major": "Major release",
  "no-action": "No action",
};

function baseName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1];
}

function placeLabel(change: ApiChange): string {
  const line = change.headLine ?? change.baselineLine;
  return `${baseName(change.filePath)}${line ? `:${line}` : ""}`;
}

function surfaceIcon(surface: ApiSurface, size = 17) {
  return surface === "export" ? <Package size={size} /> : <Globe size={size} />;
}

function sideLabel(side: ComparisonSide): string {
  if (side.kind === "git-ref") {
    return side.commit ? `${side.label} (${side.commit})` : side.label;
  }
  return side.label;
}

/* -------------------------------------------------------------------------- */
/*  Line diff (marks which lines differ between before and after)             */
/* -------------------------------------------------------------------------- */

function diffLines(
  left: string[],
  right: string[]
): { leftChanged: boolean[]; rightChanged: boolean[] } {
  const clean = (line: string) => line.replace(/\s+/g, " ").trim();
  const a = left.map(clean);
  const b = right.map(clean);
  const n = a.length;
  const m = b.length;

  const table = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const leftChanged = a.map((line) => line !== "");
  const rightChanged = b.map((line) => line !== "");

  let i = 0;
  let j = 0;

  while (i < n && j < m) {
    if (a[i] === b[j]) {
      leftChanged[i] = false;
      rightChanged[j] = false;
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  return { leftChanged, rightChanged };
}

/* -------------------------------------------------------------------------- */
/*  Before / after comparison                                                 */
/* -------------------------------------------------------------------------- */

function CodePane({
  text,
  changed,
  tone,
  emptyText,
  label,
}: {
  text?: string;
  changed: boolean[];
  tone: "removed" | "added";
  emptyText: string;
  label: string;
}) {
  const lines = text ? text.split("\n") : [];

  return (
    <div className="bac-code" role="region" aria-label={`${label} code`}>
      {lines.length === 0 ? (
        <div className="bac-code-empty">{emptyText}</div>
      ) : (
        lines.map((line, index) => (
          <div
            key={index}
            className={`bac-code-line ${changed[index] ? tone : ""}`}
          >
            <span className="bac-code-number">{index + 1}</span>
            <code>{line || " "}</code>
          </div>
        ))
      )}
    </div>
  );
}

function CompareView({
  change,
  report,
}: {
  change: ApiChange;
  report: BreakingApiReport;
}) {
  const beforeLines = useMemo(
    () => (change.before ? change.before.split("\n") : []),
    [change.before]
  );
  const afterLines = useMemo(
    () => (change.after ? change.after.split("\n") : []),
    [change.after]
  );

  const diff = useMemo(() => diffLines(beforeLines, afterLines), [
    beforeLines,
    afterLines,
  ]);

  const differing = Math.max(
    diff.leftChanged.filter(Boolean).length,
    diff.rightChanged.filter(Boolean).length
  );

  let note: string;
  if (!change.before) note = "This declaration is new.";
  else if (!change.after) note = "This declaration no longer exists.";
  else if (differing === 0) note = "The declaration text is unchanged.";
  else
    note = `${differing} ${differing === 1 ? "line differs" : "lines differ"}.`;

  const beforeWhere = change.baselineFilePath
    ? `${change.baselineFilePath}${
        change.baselineLine ? `:${change.baselineLine}` : ""
      }`
    : "not present";
  const afterWhere = change.headFilePath
    ? `${change.headFilePath}${change.headLine ? `:${change.headLine}` : ""}`
    : "not present";

  return (
    <section className="bac-box">
      <div className="bac-compare-head">
        <h4>Before and after</h4>
        <span className="bac-compare-note">{note}</span>
      </div>

      <div className="bac-compare">
        <div className="bac-pane">
          <div className="bac-pane-label before" title={beforeWhere}>
            <XCircle size={13} />
            Baseline
            <em>
              {sideLabel(report.baseline)} · {beforeWhere}
            </em>
          </div>
          <CodePane
            text={change.before}
            changed={diff.leftChanged}
            tone="removed"
            emptyText="Not present in the baseline."
            label="Baseline"
          />
        </div>

        <div className="bac-pane">
          <div className="bac-pane-label after" title={afterWhere}>
            <CheckCircle2 size={13} />
            Current
            <em>
              {sideLabel(report.head)} · {afterWhere}
            </em>
          </div>
          <CodePane
            text={change.after}
            changed={diff.rightChanged}
            tone="added"
            emptyText="Not present in the current version."
            label="Current"
          />
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Migration suggestion                                                      */
/* -------------------------------------------------------------------------- */

function MigrationPanel({ change }: { change: ApiChange }) {
  const [copied, setCopied] = useState<"" | "code" | "path">("");
  const [copyFailed, setCopyFailed] = useState(false);
  const suggestion = change.suggestion;

  async function copy(kind: "code" | "path", value: string) {
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
    <section className="bac-box bac-refactor">
      <div className="bac-refactor-head">
        <h4>
          <Wrench size={14} /> Suggested migration
        </h4>

        <div className="bac-refactor-badges">
          <span className="bac-kind-badge">
            {STRATEGY_LABEL[suggestion.strategy]}
          </span>
          <span
            className={`bac-confidence bac-confidence-${suggestion.confidence}`}
          >
            {suggestion.confidence} confidence
          </span>
        </div>
      </div>

      <p className="bac-refactor-title">{suggestion.title}</p>
      <p>{suggestion.summary}</p>

      <ol className="bac-steps">
        {suggestion.steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>

      {suggestion.codeExample && (
        <>
          <p className="bac-example-label">Example</p>
          <pre className="bac-example">
            <code>{suggestion.codeExample}</code>
          </pre>
        </>
      )}

      <div className="bac-actions">
        {suggestion.codeExample && (
          <button
            type="button"
            onClick={() => copy("code", suggestion.codeExample!)}
          >
            {copied === "code" ? <Check size={14} /> : <Copy size={14} />}
            {copied === "code" ? "Copied" : "Copy example"}
          </button>
        )}

        <button type="button" onClick={() => copy("path", change.filePath)}>
          {copied === "path" ? <Check size={14} /> : <Copy size={14} />}
          {copied === "path" ? "Copied" : "Copy file path"}
        </button>
      </div>

      {copyFailed && (
        <p className="bac-fine-print">
          The browser blocked clipboard access. Select the text above and copy
          it manually.
        </p>
      )}

      {suggestion.caveats.length > 0 && (
        <ul className="bac-caveats">
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

export default function DetectBreakingApiChanges({
  projectPath,
  onProjectPathChange,
  apiUrl = DEFAULT_API_URL,
}: DetectBreakingApiChangesProps) {
  const [focusFile, setFocusFile] = useState("");
  const [compareMode, setCompareMode] = useState<CompareMode>("ref");
  const [baseRef, setBaseRef] = useState("HEAD");
  const [headRef, setHeadRef] = useState("");
  const [baselinePath, setBaselinePath] = useState("");
  const [scope, setScope] = useState<AnalysisScope>("all");
  const [entryFiles, setEntryFiles] = useState("");
  const [includeNonBreaking, setIncludeNonBreaking] = useState(false);
  const [includeTests, setIncludeTests] = useState(false);

  const [report, setReport] = useState<BreakingApiReport | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [surfaceFilter, setSurfaceFilter] = useState<SurfaceFilter>("all");
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("severity");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function analyze() {
    if (!projectPath.trim()) {
      setError("Enter a project path before starting the analysis.");
      return;
    }

    const base = baseRef.trim();
    const head = headRef.trim();
    const folder = baselinePath.trim();

    if (compareMode === "ref") {
      if (base && !REF_PATTERN.test(base)) {
        setError(
          "Baseline ref must be a branch, tag or commit, for example HEAD, main, v1.2.0 or a commit hash."
        );
        return;
      }

      if (head && !REF_PATTERN.test(head)) {
        setError(
          "Compare-to ref must be a branch, tag or commit. Leave it empty to use the working tree."
        );
        return;
      }
    } else if (!folder) {
      setError("Enter the folder that contains the baseline version.");
      return;
    }

    const entries = entryFiles
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (entries.length > 50) {
      setError("Enter at most 50 public entry files.");
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
          baseRef: compareMode === "ref" ? base || undefined : undefined,
          headRef: compareMode === "ref" ? head || undefined : undefined,
          baselinePath: compareMode === "folder" ? folder : undefined,
          scope,
          entryFiles: entries.length > 0 ? entries : undefined,
          includeNonBreaking,
          includeTests,
        }),
      });

      const data = await response.json();

      if (!response.ok || data.success === false) {
        throw new Error(data.error || "Breaking API change detection failed.");
      }

      const nextReport = data as BreakingApiReport;
      setReport(nextReport);
      setSelectedId(nextReport.changes[0]?.id ?? null);
      setSearch("");
      setSurfaceFilter("all");
      setSeverityFilter("all");
      setSortKey("severity");
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

  const visibleChanges = useMemo(() => {
    if (!report) return [];

    const query = search.trim().toLowerCase();

    const filtered = report.changes.filter((change) => {
      if (surfaceFilter !== "all" && change.surface !== surfaceFilter) {
        return false;
      }
      if (severityFilter !== "all" && change.severity !== severityFilter) {
        return false;
      }
      if (!query) return true;

      return [
        change.title,
        change.name,
        change.description,
        change.filePath,
        change.baselineFilePath ?? "",
        change.headFilePath ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

    if (sortKey === "severity") return filtered;

    return [...filtered].sort((a, b) => {
      if (sortKey === "importers") {
        return b.consumers.count - a.consumers.count;
      }
      return a.name.localeCompare(b.name);
    });
  }, [report, search, surfaceFilter, severityFilter, sortKey]);

  const selectedChange =
    visibleChanges.find((change) => change.id === selectedId) ??
    visibleChanges[0] ??
    null;

  const hasBreaking = (report?.breakingChanges ?? 0) > 0;

  return (
    <div className="bac-analyzer">
      <div className="bac-title-row">
        <div className="bac-title-icon">
          <GitCompare size={24} />
        </div>

        <div>
          <h1>Breaking API Change Detector</h1>
          <p>
            Compare a baseline version with your current code to find exports
            and HTTP routes that would break consumers, see who is affected,
            and get a safe way to migrate.
          </p>
        </div>
      </div>

      <section className="bac-input-card">
        <div className="bac-field bac-field-wide">
          <label htmlFor="bac-project-path">Project path</label>
          <input
            id="bac-project-path"
            value={projectPath}
            onChange={(event) => onProjectPathChange?.(event.target.value)}
            placeholder="/path/to/your/project"
          />
        </div>

        <div className="bac-field">
          <label htmlFor="bac-focus-file">Focus file (optional)</label>
          <input
            id="bac-focus-file"
            value={focusFile}
            onChange={(event) => setFocusFile(event.target.value)}
            placeholder="src/api/users.ts"
          />
        </div>

        <button
          type="button"
          className="bac-analyze-button"
          onClick={analyze}
          disabled={loading}
        >
          {loading ? (
            <>
              <span className="bac-spinner" />
              Comparing...
            </>
          ) : (
            <>
              <GitCompare size={17} />
              Detect Changes
            </>
          )}
        </button>

        <div className="bac-options">
          <div className="bac-field">
            <span className="bac-field-label">Baseline source</span>
            <SecuritySelect
              ariaLabel="Baseline source"
              value={compareMode}
              onChange={setCompareMode}
              options={(Object.keys(COMPARE_LABEL) as CompareMode[]).map(
                (mode) => ({ value: mode, label: COMPARE_LABEL[mode] })
              )}
            />
          </div>

          {compareMode === "ref" ? (
            <>
              <div className="bac-field">
                <label htmlFor="bac-base-ref">Baseline ref</label>
                <input
                  id="bac-base-ref"
                  value={baseRef}
                  onChange={(event) => setBaseRef(event.target.value)}
                  placeholder="HEAD, main or v1.2.0"
                />
              </div>

              <div className="bac-field">
                <label htmlFor="bac-head-ref">Compare to (optional)</label>
                <input
                  id="bac-head-ref"
                  value={headRef}
                  onChange={(event) => setHeadRef(event.target.value)}
                  placeholder="Empty = working tree"
                />
              </div>
            </>
          ) : (
            <div className="bac-field bac-field-wide">
              <label htmlFor="bac-baseline-path">Baseline folder</label>
              <input
                id="bac-baseline-path"
                value={baselinePath}
                onChange={(event) => setBaselinePath(event.target.value)}
                placeholder="/path/to/previous/release"
              />
            </div>
          )}
        </div>

        <div className="bac-options bac-options-secondary">
          <div className="bac-field">
            <span className="bac-field-label">What to compare</span>
            <SecuritySelect
              ariaLabel="What to compare"
              value={scope}
              onChange={setScope}
              options={(Object.keys(SCOPE_LABEL) as AnalysisScope[]).map(
                (item) => ({ value: item, label: SCOPE_LABEL[item] })
              )}
            />
          </div>

          <div className="bac-field">
            <label htmlFor="bac-entry-files">Public entry files (optional)</label>
            <input
              id="bac-entry-files"
              value={entryFiles}
              onChange={(event) => setEntryFiles(event.target.value)}
              placeholder="Detected from package.json, or src/index.ts"
            />
          </div>

          <label className="bac-check">
            <input
              type="checkbox"
              checked={includeNonBreaking}
              onChange={(event) => setIncludeNonBreaking(event.target.checked)}
            />
            Show compatible changes
          </label>

          <label className="bac-check">
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
        <div className="bac-error" role="alert">
          <XCircle size={18} />
          {error}
        </div>
      )}

      {report && (
        <>
          <div className="bac-status-row">
            <div className={`bac-success ${hasBreaking ? "has-groups" : ""}`}>
              {hasBreaking ? (
                <AlertTriangle size={18} />
              ) : (
                <CheckCircle2 size={18} />
              )}
              <strong>{report.breakingChanges}</strong>
              <span>
                breaking {report.breakingChanges === 1 ? "change" : "changes"}{" "}
                found
                {report.filePath ? ` involving ${report.filePath}` : ""}
              </span>
            </div>

            <div className="bac-status-right">
              <span
                className={`bac-semver bump-${report.recommendedBump}`}
                title={`Recommended version bump: ${BUMP_NOTE[report.recommendedBump]}`}
              >
                {BUMP_LABEL[report.recommendedBump]} bump ·{" "}
                {BUMP_NOTE[report.recommendedBump]}
              </span>

              <span className="bac-scope">
                {sideLabel(report.baseline)} → {sideLabel(report.head)} ·{" "}
                {report.headFiles} files
                {report.filePath
                  ? ` · ${report.projectChangeCount} changes project-wide`
                  : ""}
              </span>
            </div>
          </div>

          <div className="bac-summary-grid">
            <button
              type="button"
              className={`bac-summary-card bac-surface-export ${
                surfaceFilter === "export" ? "active" : ""
              }`}
              onClick={() =>
                setSurfaceFilter(surfaceFilter === "export" ? "all" : "export")
              }
              aria-pressed={surfaceFilter === "export"}
            >
              <div className="bac-summary-icon">{surfaceIcon("export")}</div>
              <div>
                <strong>{report.exportChanges}</strong>
                <span>Export changes</span>
                <span className="bac-summary-sub">
                  {report.baselineExports} → {report.headExports} exports
                </span>
              </div>
            </button>

            <button
              type="button"
              className={`bac-summary-card bac-surface-route ${
                surfaceFilter === "route" ? "active" : ""
              }`}
              onClick={() =>
                setSurfaceFilter(surfaceFilter === "route" ? "all" : "route")
              }
              aria-pressed={surfaceFilter === "route"}
            >
              <div className="bac-summary-icon">{surfaceIcon("route")}</div>
              <div>
                <strong>{report.routeChanges}</strong>
                <span>Route changes</span>
                <span className="bac-summary-sub">
                  {report.baselineRoutes} → {report.headRoutes} routes
                </span>
              </div>
            </button>

            <div className="bac-summary-card static">
              <div className="bac-summary-icon neutral">
                <AlertTriangle size={17} />
              </div>
              <div>
                <strong>{report.summary.critical + report.summary.high}</strong>
                <span>Critical and high</span>
                <span className="bac-summary-sub">
                  {report.summary.critical} critical · {report.summary.high} high
                  · {report.summary.medium + report.summary.low} lower
                </span>
              </div>
            </div>

            <div className="bac-summary-card static">
              <div className="bac-summary-icon neutral">
                <Users size={17} />
              </div>
              <div>
                <strong>{report.filesAffected}</strong>
                <span>Files changed</span>
                <span className="bac-summary-sub">
                  {report.consumersAffected} importing{" "}
                  {report.consumersAffected === 1 ? "file" : "files"}
                </span>
              </div>
            </div>
          </div>

          {report.totalChanges === 0 ? (
            <section className="bac-clean">
              <CheckCircle2 size={38} />
              <h3>
                {report.includeNonBreaking
                  ? "No API changes found"
                  : "No breaking API changes found"}
              </h3>
              <p>
                Compared {report.baselineExports} exports and{" "}
                {report.baselineRoutes} routes in {sideLabel(report.baseline)}{" "}
                with {report.headExports} exports and {report.headRoutes} routes
                in {sideLabel(report.head)}
                {report.filePath ? `, filtered to ${report.filePath}` : ""}. The
                recommended release is a{" "}
                <strong>{report.recommendedBump}</strong> version
                {report.compatibleChanges === 0 &&
                report.projectChangeCount === 0 &&
                report.recommendedBump === "minor"
                  ? ". Turn on “Show compatible changes” to see the additions."
                  : "."}
              </p>
            </section>
          ) : (
            <section className="bac-workspace">
              <div className="bac-groups-panel">
                <div className="bac-panel-header">
                  <div>
                    <h2>API Changes</h2>
                    <p>
                      {visibleChanges.length} of {report.changes.length} changes
                    </p>
                  </div>

                  <div className="bac-count-pill">
                    <GitCompare size={15} />
                    {visibleChanges.length}
                  </div>
                </div>

                <div className="bac-filters">
                  <div className="bac-search">
                    <Search size={17} />
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search by name, file or message..."
                      aria-label="Search API changes"
                    />
                  </div>

                  <div className="bac-filter-row">
                    <div
                      className="bac-type-filter"
                      role="group"
                      aria-label="Filter by API surface"
                    >
                      {(["all", "export", "route"] as const).map((option) => (
                        <button
                          type="button"
                          key={option}
                          className={surfaceFilter === option ? "active" : ""}
                          aria-pressed={surfaceFilter === option}
                          onClick={() => setSurfaceFilter(option)}
                        >
                          {option === "all" ? "All" : SURFACE_LABEL[option]}
                        </button>
                      ))}
                    </div>

                    <div className="bac-sort">
                      <SecuritySelect
                        ariaLabel="Filter by severity"
                        value={severityFilter}
                        onChange={setSeverityFilter}
                        options={[
                          { value: "all", label: "All severities" },
                          { value: "critical", label: "Critical" },
                          { value: "high", label: "High" },
                          { value: "medium", label: "Medium" },
                          { value: "low", label: "Low" },
                        ]}
                      />
                    </div>

                    <div className="bac-sort">
                      <SecuritySelect
                        ariaLabel="Sort changes"
                        value={sortKey}
                        onChange={setSortKey}
                        options={[
                          { value: "severity", label: "Sort: severity" },
                          { value: "importers", label: "Sort: importers" },
                          { value: "name", label: "Sort: name" },
                        ]}
                      />
                    </div>
                  </div>
                </div>

                <div className="bac-groups-list">
                  {visibleChanges.length === 0 ? (
                    <div className="bac-empty">
                      <GitCompare size={34} />
                      <h3>No matching changes</h3>
                      <p>No API changes match the current filters.</p>
                    </div>
                  ) : (
                    visibleChanges.map((change) => (
                      <button
                        type="button"
                        key={change.id}
                        className={`bac-group ${
                          selectedChange?.id === change.id ? "selected" : ""
                        }`}
                        onClick={() => setSelectedId(change.id)}
                      >
                        <div
                          className={`bac-group-icon bac-severity-${change.severity}`}
                        >
                          {surfaceIcon(change.surface)}
                        </div>

                        <div className="bac-group-content">
                          <div className="bac-group-top">
                            <span
                              className={`bac-badge bac-badge-${change.severity}`}
                            >
                              {change.breaking ? change.severity : "compatible"}
                            </span>
                            <span className="bac-kind-badge">
                              {CATEGORY_LABEL[change.category]}
                            </span>
                            <span className="bac-kind-badge">
                              {EXPOSURE_LABEL[change.exposure]}
                            </span>
                          </div>

                          <h3>{change.title}</h3>
                          <p className="bac-places">
                            {placeLabel(change)}
                            {change.consumers.count > 0 &&
                              ` · ${change.consumers.count} ${
                                change.consumers.count === 1
                                  ? "importer"
                                  : "importers"
                              }`}
                            {change.stillReferenced && " · still imported"}
                          </p>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>

              <aside className="bac-inspector">
                <div className="bac-panel-header">
                  <div>
                    <h2>Inspector</h2>
                    <p>What changed, who is affected and how to migrate</p>
                  </div>
                </div>

                {selectedChange ? (
                  <div className="bac-inspector-body">
                    <div className="bac-inspector-title">
                      <div
                        className={`bac-inspector-icon bac-severity-${selectedChange.severity}`}
                      >
                        {surfaceIcon(selectedChange.surface, 20)}
                      </div>

                      <div>
                        <span
                          className={`bac-badge bac-badge-${selectedChange.severity}`}
                        >
                          {selectedChange.breaking
                            ? selectedChange.severity
                            : "compatible"}
                        </span>
                        <h3>{selectedChange.title}</h3>
                      </div>
                    </div>

                    <div className="bac-detail-grid">
                      <div>
                        <span>Kind</span>
                        <strong>{selectedChange.symbolKind}</strong>
                      </div>
                      <div>
                        <span>Exposure</span>
                        <strong>{EXPOSURE_LABEL[selectedChange.exposure]}</strong>
                      </div>
                      <div>
                        <span>Importers</span>
                        <strong>{selectedChange.consumers.count}</strong>
                      </div>
                      <div>
                        <span>Breaking issues</span>
                        <strong>
                          {selectedChange.issues.filter((i) => i.breaking).length}
                        </strong>
                      </div>
                    </div>

                    <section className="bac-box">
                      <h4>What this means</h4>
                      <p>{selectedChange.description}</p>
                      {selectedChange.deprecatedInBaseline && (
                        <p className="bac-fine-print">
                          This was marked @deprecated in the baseline.
                        </p>
                      )}
                    </section>

                    <section className="bac-box">
                      <h4>
                        {selectedChange.issues.length === 1
                          ? "The change"
                          : `The ${selectedChange.issues.length} changes`}
                      </h4>
                      <ul className="bac-issues">
                        {selectedChange.issues.map((item, index) => (
                          <li className="bac-issue" key={`${item.kind}-${index}`}>
                            <div className="bac-issue-head">
                              <span
                                className={`bac-badge bac-badge-${item.severity}`}
                              >
                                {item.breaking ? item.severity : "compatible"}
                              </span>
                              <span
                                className="bac-issue-path"
                                title={item.path}
                              >
                                {item.path}
                              </span>
                            </div>
                            <p>{item.message}</p>

                            {(item.before || item.after) && (
                              <div className="bac-issue-diff">
                                {item.before && (
                                  <code className="before">− {item.before}</code>
                                )}
                                {item.after && (
                                  <code className="after">+ {item.after}</code>
                                )}
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </section>

                    <CompareView
                      key={selectedChange.id}
                      change={selectedChange}
                      report={report}
                    />

                    {selectedChange.consumers.count > 0 && (
                      <section className="bac-box">
                        <h4>
                          {selectedChange.category === "removed" ||
                          selectedChange.category === "renamed" ||
                          selectedChange.category === "moved"
                            ? "Imported this in the baseline"
                            : "Files that import this"}
                        </h4>
                        <ul className="bac-consumers">
                          {selectedChange.consumers.files.map((file) => (
                            <li key={file}>
                              <FileCode2 size={13} />
                              <span title={file}>{file}</span>
                            </li>
                          ))}
                          {selectedChange.consumers.hidden > 0 && (
                            <li className="bac-consumers-more">
                              +{selectedChange.consumers.hidden} more not shown
                            </li>
                          )}
                        </ul>

                        {selectedChange.stillReferenced && (
                          <div className="bac-stale" role="alert">
                            <AlertTriangle size={14} />
                            Files in the current version still import the old
                            name, so they fail right now.
                          </div>
                        )}
                      </section>
                    )}

                    <MigrationPanel
                      key={`fix-${selectedChange.id}`}
                      change={selectedChange}
                    />
                  </div>
                ) : (
                  <div className="bac-inspector-empty">
                    <GitCompare size={38} />
                    <h3>Select a change</h3>
                    <p>
                      Choose a change from the list to see what broke, who
                      imports it, and how to keep it backward compatible.
                    </p>
                  </div>
                )}
              </aside>
            </section>
          )}

          {report.hotspots.length > 0 && (
            <section className="bac-hotspots">
              <div className="bac-panel-header">
                <div>
                  <h2>Most affected files</h2>
                  <p>
                    Files with the most API changes. Select one to filter.
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
                        setSurfaceFilter("all");
                        setSeverityFilter("all");
                      }}
                    >
                      <FileCode2 size={14} />
                      <span title={file.filePath}>{file.filePath}</span>
                      <em>{file.breakingChanges} breaking</em>
                      <strong>{file.totalChanges}</strong>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {report.warnings.length > 0 && (
            <section className="bac-analysis-notes">
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
