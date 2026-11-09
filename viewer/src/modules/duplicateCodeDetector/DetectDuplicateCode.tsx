import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Braces,
  Check,
  CheckCircle2,
  Copy,
  FileCode2,
  Layers,
  Search,
  Wrench,
  XCircle,
} from "lucide-react";
import SecuritySelect from "../security/SecuritySelect";
import "./detect-duplicate-code.css";

type DuplicateSeverity = "critical" | "high" | "medium" | "low" | "info";
type DuplicateType = "exact" | "renamed";
type DuplicateScope = "cross-file" | "same-file";
type MatchMode = "exact" | "renamed" | "structural";

type RefactorStrategy =
  | "extract-function"
  | "extract-component"
  | "extract-shared-module"
  | "extract-local-helper"
  | "keep-one-copy";

interface DuplicateFragment {
  filePath: string;
  startLine: number;
  endLine: number;
  lines: number;
  tokens: number;
  fileLines: number;
  symbol?: string;
  snippet: string;
  snippetTruncated: boolean;
}

interface DuplicateSuggestion {
  strategy: RefactorStrategy;
  confidence: "high" | "medium" | "low";
  title: string;
  summary: string;
  steps: string[];
  suggestedName?: string;
  suggestedPath?: string;
  caveats: string[];
}

interface DuplicateGroup {
  id: string;
  severity: DuplicateSeverity;
  type: DuplicateType;
  scope: DuplicateScope;
  score: number;
  lines: number;
  tokens: number;
  instanceCount: number;
  duplicatedLines: number;
  title: string;
  description: string;
  recommendation: string;
  fragments: DuplicateFragment[];
  hiddenInstances: number;
  suggestion: DuplicateSuggestion;
}

interface DuplicateHotspot {
  filePath: string;
  duplicatedLines: number;
  groupCount: number;
  fileLines: number;
  percentage: number;
}

interface DuplicateCodeReport {
  success: boolean;
  tool: "detect_duplicate_code";
  projectPath: string;
  filePath?: string;
  matchMode: MatchMode;
  minTokens: number;
  minLines: number;
  includeTests: boolean;
  filesScanned: number;
  tokensAnalyzed: number;
  totalLines: number;
  totalGroups: number;
  projectGroupCount: number;
  totalCopies: number;
  duplicatedLines: number;
  duplicationPercentage: number;
  exactGroups: number;
  renamedGroups: number;
  crossFileGroups: number;
  sameFileGroups: number;
  filesAffected: number;
  summary: Record<DuplicateSeverity, number>;
  groups: DuplicateGroup[];
  hotspots: DuplicateHotspot[];
  warnings: string[];
}

interface DetectDuplicateCodeProps {
  projectPath: string;
  onProjectPathChange?: (value: string) => void;
  apiUrl?: string;
}

type TypeFilter = "all" | DuplicateType;
type SortKey = "impact" | "lines" | "copies";

const DEFAULT_API_URL = "http://127.0.0.1:4174/api/detect-duplicate-code";

const TYPE_LABEL: Record<DuplicateType, string> = {
  exact: "Exact",
  renamed: "Near duplicate",
};

const SCOPE_LABEL: Record<DuplicateScope, string> = {
  "cross-file": "Across files",
  "same-file": "Same file",
};

const STRATEGY_LABEL: Record<RefactorStrategy, string> = {
  "extract-function": "Extract function",
  "extract-component": "Extract component",
  "extract-shared-module": "Shared module",
  "extract-local-helper": "Local helper",
  "keep-one-copy": "Keep one copy",
};

const MODE_LABEL: Record<MatchMode, string> = {
  exact: "Exact tokens",
  renamed: "Renamed identifiers",
  structural: "Structural (ignore values)",
};

function baseName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1];
}

/** Last folder plus file name, e.g. "ATSResumeEngine/ats_part2.tsx". */
function shortPath(filePath: string): string {
  return filePath.split("/").slice(-2).join("/");
}

function placeLabel(fragment: DuplicateFragment): string {
  return `${baseName(fragment.filePath)}:${fragment.startLine}-${fragment.endLine}`;
}

function typeIcon(type: DuplicateType, size = 17) {
  return type === "exact" ? <Copy size={size} /> : <Braces size={size} />;
}

/* -------------------------------------------------------------------------- */
/*  Line diff (marks which lines differ between two copies)                   */
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
/*  Where each copy sits inside its file                                      */
/* -------------------------------------------------------------------------- */

function FragmentMap({ group }: { group: DuplicateGroup }) {
  return (
    <ul className="dup-map">
      {group.fragments.map((fragment, index) => {
        const total = Math.max(1, fragment.fileLines);
        const left = ((fragment.startLine - 1) / total) * 100;
        const width = Math.max(2, (fragment.lines / total) * 100);

        return (
          <li key={`${fragment.filePath}:${fragment.startLine}`}>
            <div className="dup-map-head">
              <span className="dup-map-index">{index + 1}</span>
              <FileCode2 size={13} />
              <span className="dup-map-path" title={fragment.filePath}>
                {fragment.filePath}
              </span>
            </div>

            <div className="dup-map-meta">
              <span>
                lines {fragment.startLine}-{fragment.endLine}
              </span>
              {fragment.symbol && <span>in {fragment.symbol}</span>}
              <span>
                {fragment.lines} of {fragment.fileLines} lines
              </span>
            </div>

            <div
              className="dup-map-track"
              role="img"
              aria-label={`Lines ${fragment.startLine} to ${fragment.endLine} of ${fragment.fileLines}`}
            >
              <span
                className="dup-map-fill"
                style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
              />
            </div>
          </li>
        );
      })}

      {group.hiddenInstances > 0 && (
        <li className="dup-map-more">
          +{group.hiddenInstances} more{" "}
          {group.hiddenInstances === 1 ? "copy" : "copies"} not shown
        </li>
      )}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/*  Side-by-side comparison                                                   */
/* -------------------------------------------------------------------------- */

function CodePane({
  fragments,
  selectedIndex,
  onSelect,
  changed,
  label,
}: {
  fragments: DuplicateFragment[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  changed: boolean[];
  label: string;
}) {
  const fragment = fragments[selectedIndex];
  const lines = fragment.snippet.split("\n");

  return (
    <div className="dup-pane">
      <div className="dup-pane-select">
        <SecuritySelect
          ariaLabel={label}
          value={String(selectedIndex)}
          onChange={(next) => onSelect(Number(next))}
          options={fragments.map((item, index) => ({
            value: String(index),
            label: `${index + 1}. ${shortPath(item.filePath)}:${item.startLine}-${item.endLine}`,
          }))}
        />
      </div>

      <div className="dup-code" role="region" aria-label={`${label} code`}>
        {lines.map((line, index) => (
          <div
            key={index}
            className={`dup-code-line ${changed[index] ? "changed" : ""}`}
          >
            <span className="dup-code-number">
              {fragment.startLine + index}
            </span>
            <code>{line || " "}</code>
          </div>
        ))}

        {fragment.snippetTruncated && (
          <div className="dup-code-more">
            … {fragment.lines - lines.length} more lines in this block
          </div>
        )}
      </div>
    </div>
  );
}

function CompareView({ group }: { group: DuplicateGroup }) {
  const fragments = group.fragments;
  const [leftIndex, setLeftIndex] = useState(0);
  const [rightIndex, setRightIndex] = useState(Math.min(1, fragments.length - 1));

  const left = fragments[leftIndex];
  const right = fragments[rightIndex];

  const diff = useMemo(
    () => diffLines(left.snippet.split("\n"), right.snippet.split("\n")),
    [left, right]
  );

  const differingLines = Math.max(
    diff.leftChanged.filter(Boolean).length,
    diff.rightChanged.filter(Boolean).length
  );

  const truncated = left.snippetTruncated || right.snippetTruncated;

  return (
    <section className="dup-box">
      <div className="dup-compare-head">
        <h4>Compare copies</h4>
        <span className="dup-compare-note">
          {leftIndex === rightIndex
            ? "Both sides show the same copy."
            : differingLines === 0
              ? "These two copies match line by line."
              : `${differingLines} ${
                  differingLines === 1 ? "line differs" : "lines differ"
                }${truncated ? " in the first lines shown" : ""}.`}
        </span>
      </div>

      <div className="dup-compare">
        <CodePane
          fragments={fragments}
          selectedIndex={leftIndex}
          onSelect={setLeftIndex}
          changed={diff.leftChanged}
          label="Left copy"
        />
        <CodePane
          fragments={fragments}
          selectedIndex={rightIndex}
          onSelect={setRightIndex}
          changed={diff.rightChanged}
          label="Right copy"
        />
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Suggested refactor                                                        */
/* -------------------------------------------------------------------------- */

function RefactorPanel({ group }: { group: DuplicateGroup }) {
  const [copied, setCopied] = useState<"" | "code" | "path">("");
  const [copyFailed, setCopyFailed] = useState(false);
  const suggestion = group.suggestion;
  const first = group.fragments[0];

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
    <section className="dup-box dup-refactor">
      <div className="dup-refactor-head">
        <h4>
          <Wrench size={14} /> Suggested refactor
        </h4>

        <div className="dup-refactor-badges">
          <span className="dup-kind-badge">
            {STRATEGY_LABEL[suggestion.strategy]}
          </span>
          <span
            className={`dup-confidence confidence-${suggestion.confidence}`}
          >
            {suggestion.confidence} confidence
          </span>
        </div>
      </div>

      <p className="dup-refactor-title">{suggestion.title}</p>
      <p>{suggestion.summary}</p>

      {(suggestion.suggestedName || suggestion.suggestedPath) && (
        <dl className="dup-suggested">
          {suggestion.suggestedName && (
            <div>
              <dt>Name</dt>
              <dd>{suggestion.suggestedName}</dd>
            </div>
          )}
          {suggestion.suggestedPath && (
            <div>
              <dt>File</dt>
              <dd title={suggestion.suggestedPath}>{suggestion.suggestedPath}</dd>
            </div>
          )}
        </dl>
      )}

      <ol className="dup-steps">
        {suggestion.steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>

      <div className="dup-actions">
        <button type="button" onClick={() => copy("code", first.snippet)}>
          {copied === "code" ? <Check size={14} /> : <Copy size={14} />}
          {copied === "code" ? "Copied" : "Copy first copy"}
        </button>

        {suggestion.suggestedPath && (
          <button
            type="button"
            onClick={() => copy("path", suggestion.suggestedPath!)}
          >
            {copied === "path" ? <Check size={14} /> : <Copy size={14} />}
            {copied === "path" ? "Copied" : "Copy file path"}
          </button>
        )}

        {first.snippetTruncated && (
          <span className="dup-actions-note">
            Only the first {first.snippet.split("\n").length} lines are copied.
          </span>
        )}
      </div>

      {copyFailed && (
        <p className="dup-fine-print">
          The browser blocked clipboard access. Select the code in the
          comparison above and copy it manually.
        </p>
      )}

      {suggestion.caveats.length > 0 && (
        <ul className="dup-caveats">
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

export default function DetectDuplicateCode({
  projectPath,
  onProjectPathChange,
  apiUrl = DEFAULT_API_URL,
}: DetectDuplicateCodeProps) {
  const [focusFile, setFocusFile] = useState("");
  const [minTokens, setMinTokens] = useState("50");
  const [minLines, setMinLines] = useState("5");
  const [matchMode, setMatchMode] = useState<MatchMode>("renamed");
  const [includeTests, setIncludeTests] = useState(false);

  const [report, setReport] = useState<DuplicateCodeReport | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("impact");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function analyze() {
    if (!projectPath.trim()) {
      setError("Enter a project path before starting the analysis.");
      return;
    }

    const tokens = Number(minTokens);
    const lines = Number(minLines);

    if (!Number.isInteger(tokens) || tokens < 20 || tokens > 500) {
      setError("Minimum tokens must be a whole number between 20 and 500.");
      return;
    }

    if (!Number.isInteger(lines) || lines < 2 || lines > 100) {
      setError("Minimum lines must be a whole number between 2 and 100.");
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
          minTokens: tokens,
          minLines: lines,
          matchMode,
          includeTests,
        }),
      });

      const data = await response.json();

      if (!response.ok || data.success === false) {
        throw new Error(data.error || "Duplicate code detection failed.");
      }

      const nextReport = data as DuplicateCodeReport;
      setReport(nextReport);
      setSelectedId(nextReport.groups[0]?.id ?? null);
      setSearch("");
      setTypeFilter("all");
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

  const visibleGroups = useMemo(() => {
    if (!report) return [];

    const query = search.trim().toLowerCase();

    const filtered = report.groups.filter((group) => {
      if (typeFilter !== "all" && group.type !== typeFilter) return false;
      if (!query) return true;

      return [
        group.title,
        group.description,
        ...group.fragments.map(
          (fragment) => `${fragment.filePath} ${fragment.symbol ?? ""}`
        ),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

    return [...filtered].sort((a, b) => {
      if (sortKey === "lines") {
        return b.duplicatedLines - a.duplicatedLines || b.score - a.score;
      }
      if (sortKey === "copies") {
        return b.instanceCount - a.instanceCount || b.score - a.score;
      }
      return b.score - a.score;
    });
  }, [report, search, typeFilter, sortKey]);

  const selectedGroup =
    visibleGroups.find((group) => group.id === selectedId) ??
    visibleGroups[0] ??
    null;

  return (
    <div className="dup-analyzer">
      <div className="dup-title-row">
        <div className="dup-title-icon">
          <Copy size={24} />
        </div>

        <div>
          <h1>Duplicate Code Detector</h1>
          <p>
            Find blocks of code that are copied across your project, compare
            the copies side by side, and see where to merge them.
          </p>
        </div>
      </div>

      <section className="dup-input-card">
        <div className="dup-field dup-field-wide">
          <label htmlFor="dup-project-path">Project path</label>
          <input
            id="dup-project-path"
            value={projectPath}
            onChange={(event) => onProjectPathChange?.(event.target.value)}
            placeholder="/path/to/your/project"
          />
        </div>

        <div className="dup-field">
          <label htmlFor="dup-focus-file">Focus file (optional)</label>
          <input
            id="dup-focus-file"
            value={focusFile}
            onChange={(event) => setFocusFile(event.target.value)}
            placeholder="src/App.tsx"
          />
        </div>

        <button
          type="button"
          className="dup-analyze-button"
          onClick={analyze}
          disabled={loading}
        >
          {loading ? (
            <>
              <span className="dup-spinner" />
              Scanning...
            </>
          ) : (
            <>
              <Copy size={17} />
              Find Duplicates
            </>
          )}
        </button>

        <div className="dup-options">
          <div className="dup-field">
            <label htmlFor="dup-min-tokens">Minimum tokens</label>
            <input
              id="dup-min-tokens"
              type="number"
              min={20}
              max={500}
              value={minTokens}
              onChange={(event) => setMinTokens(event.target.value)}
            />
          </div>

          <div className="dup-field">
            <label htmlFor="dup-min-lines">Minimum lines</label>
            <input
              id="dup-min-lines"
              type="number"
              min={2}
              max={100}
              value={minLines}
              onChange={(event) => setMinLines(event.target.value)}
            />
          </div>

          <div className="dup-field">
            <span className="dup-field-label">Matching</span>
            <SecuritySelect
              ariaLabel="Matching mode"
              value={matchMode}
              onChange={setMatchMode}
              options={(Object.keys(MODE_LABEL) as MatchMode[]).map((mode) => ({
                value: mode,
                label: MODE_LABEL[mode],
              }))}
            />
          </div>

          <label className="dup-check">
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
        <div className="dup-error" role="alert">
          <XCircle size={18} />
          {error}
        </div>
      )}

      {report && (
        <>
          <div className="dup-status-row">
            <div
              className={`dup-success ${
                report.totalGroups === 0 ? "" : "has-groups"
              }`}
            >
              {report.totalGroups === 0 ? (
                <CheckCircle2 size={18} />
              ) : (
                <AlertTriangle size={18} />
              )}
              <strong>{report.totalGroups}</strong>
              <span>
                duplicate {report.totalGroups === 1 ? "group" : "groups"} found
                {report.filePath ? ` involving ${report.filePath}` : ""}
              </span>
            </div>

            <span className="dup-scope">
              {report.filesScanned} files · {report.totalLines.toLocaleString()}{" "}
              lines · {MODE_LABEL[report.matchMode].toLowerCase()}
              {report.filePath
                ? ` · ${report.projectGroupCount} groups project-wide`
                : ""}
            </span>
          </div>

          <div className="dup-summary-grid">
            <button
              type="button"
              className={`dup-summary-card type-exact ${
                typeFilter === "exact" ? "active" : ""
              }`}
              onClick={() =>
                setTypeFilter(typeFilter === "exact" ? "all" : "exact")
              }
              aria-pressed={typeFilter === "exact"}
            >
              <div className="dup-summary-icon">{typeIcon("exact")}</div>
              <div>
                <strong>{report.exactGroups}</strong>
                <span>Exact copies</span>
              </div>
            </button>

            <button
              type="button"
              className={`dup-summary-card type-renamed ${
                typeFilter === "renamed" ? "active" : ""
              }`}
              onClick={() =>
                setTypeFilter(typeFilter === "renamed" ? "all" : "renamed")
              }
              aria-pressed={typeFilter === "renamed"}
            >
              <div className="dup-summary-icon">{typeIcon("renamed")}</div>
              <div>
                <strong>{report.renamedGroups}</strong>
                <span>Near duplicates</span>
              </div>
            </button>

            <div className="dup-summary-card static">
              <div className="dup-summary-icon neutral">
                <Layers size={17} />
              </div>
              <div>
                <strong>{report.duplicatedLines.toLocaleString()}</strong>
                <span>
                  Removable lines · {report.duplicationPercentage}% of code
                </span>
              </div>
            </div>

            <div className="dup-summary-card static">
              <div className="dup-summary-icon neutral">
                <FileCode2 size={17} />
              </div>
              <div>
                <strong>{report.filesAffected}</strong>
                <span>
                  Files affected · {report.totalCopies} copies
                </span>
              </div>
            </div>
          </div>

          {report.totalGroups === 0 ? (
            <section className="dup-clean">
              <CheckCircle2 size={38} />
              <h3>No duplicated code found</h3>
              <p>
                None of the {report.filesScanned} analyzed files repeat a block
                of at least {report.minTokens} tokens and {report.minLines}{" "}
                lines
                {report.filePath ? ` that includes ${report.filePath}` : ""}.
                Lower the minimums to look for smaller repeats.
              </p>
            </section>
          ) : (
            <section className="dup-workspace">
              <div className="dup-groups-panel">
                <div className="dup-panel-header">
                  <div>
                    <h2>Duplicate Groups</h2>
                    <p>
                      {visibleGroups.length} of {report.groups.length} groups
                    </p>
                  </div>

                  <div className="dup-count-pill">
                    <Copy size={15} />
                    {visibleGroups.length}
                  </div>
                </div>

                <div className="dup-filters">
                  <div className="dup-search">
                    <Search size={17} />
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search by file or function..."
                      aria-label="Search duplicate groups"
                    />
                  </div>

                  <div className="dup-filter-row">
                    <div
                      className="dup-type-filter"
                      role="group"
                      aria-label="Filter by duplicate type"
                    >
                      {(["all", "exact", "renamed"] as const).map((option) => (
                        <button
                          type="button"
                          key={option}
                          className={typeFilter === option ? "active" : ""}
                          aria-pressed={typeFilter === option}
                          onClick={() => setTypeFilter(option)}
                        >
                          {option === "all" ? "All" : TYPE_LABEL[option]}
                        </button>
                      ))}
                    </div>

                    <div className="dup-sort">
                      <SecuritySelect
                        ariaLabel="Sort groups"
                        value={sortKey}
                        onChange={setSortKey}
                        options={[
                          { value: "impact", label: "Sort: impact" },
                          { value: "lines", label: "Sort: removable lines" },
                          { value: "copies", label: "Sort: copies" },
                        ]}
                      />
                    </div>
                  </div>
                </div>

                <div className="dup-groups-list">
                  {visibleGroups.length === 0 ? (
                    <div className="dup-empty">
                      <Copy size={34} />
                      <h3>No matching groups</h3>
                      <p>No duplicate groups match the current filters.</p>
                    </div>
                  ) : (
                    visibleGroups.map((group) => {
                      const [first, second] = group.fragments;

                      return (
                        <button
                          type="button"
                          key={group.id}
                          className={`dup-group ${
                            selectedGroup?.id === group.id ? "selected" : ""
                          }`}
                          onClick={() => setSelectedId(group.id)}
                        >
                          <div
                            className={`dup-group-icon severity-${group.severity}`}
                          >
                            {typeIcon(group.type)}
                          </div>

                          <div className="dup-group-content">
                            <div className="dup-group-top">
                              <span
                                className={`dup-badge badge-${group.severity}`}
                              >
                                {group.severity}
                              </span>
                              <span className="dup-kind-badge">
                                {TYPE_LABEL[group.type]}
                              </span>
                              <span className="dup-kind-badge">
                                {SCOPE_LABEL[group.scope]}
                              </span>
                            </div>

                            <h3>{group.title}</h3>
                            <p className="dup-places">
                              {placeLabel(first)}
                              {second && ` ↔ ${placeLabel(second)}`}
                              {group.instanceCount > 2 &&
                                ` · +${group.instanceCount - 2} more`}
                            </p>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              <aside className="dup-inspector">
                <div className="dup-panel-header">
                  <div>
                    <h2>Inspector</h2>
                    <p>Where the copies live and how to merge them</p>
                  </div>
                </div>

                {selectedGroup ? (
                  <div className="dup-inspector-body">
                    <div className="dup-inspector-title">
                      <div
                        className={`dup-inspector-icon severity-${selectedGroup.severity}`}
                      >
                        {typeIcon(selectedGroup.type, 20)}
                      </div>

                      <div>
                        <span
                          className={`dup-badge badge-${selectedGroup.severity}`}
                        >
                          {selectedGroup.severity}
                        </span>
                        <h3>{selectedGroup.title}</h3>
                      </div>
                    </div>

                    <div className="dup-detail-grid">
                      <div>
                        <span>Match</span>
                        <strong>{TYPE_LABEL[selectedGroup.type]}</strong>
                      </div>
                      <div>
                        <span>Copies</span>
                        <strong>{selectedGroup.instanceCount}</strong>
                      </div>
                      <div>
                        <span>Removable lines</span>
                        <strong>{selectedGroup.duplicatedLines}</strong>
                      </div>
                      <div>
                        <span>Impact score</span>
                        <strong>{selectedGroup.score} / 100</strong>
                      </div>
                    </div>

                    <section className="dup-box">
                      <h4>What this means</h4>
                      <p>{selectedGroup.description}</p>
                    </section>

                    <section className="dup-box">
                      <h4>Where the copies are</h4>
                      <FragmentMap group={selectedGroup} />
                    </section>

                    <CompareView key={selectedGroup.id} group={selectedGroup} />

                    <RefactorPanel key={`fix-${selectedGroup.id}`} group={selectedGroup} />
                  </div>
                ) : (
                  <div className="dup-inspector-empty">
                    <Copy size={38} />
                    <h3>Select a group</h3>
                    <p>
                      Choose a duplicate group from the list to compare its
                      copies and see how to merge them.
                    </p>
                  </div>
                )}
              </aside>
            </section>
          )}

          {report.hotspots.length > 0 && (
            <section className="dup-hotspots">
              <div className="dup-panel-header">
                <div>
                  <h2>Most duplicated files</h2>
                  <p>
                    Files with the most lines inside duplicate groups. Select
                    one to filter.
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
                        setTypeFilter("all");
                      }}
                    >
                      <FileCode2 size={14} />
                      <span title={file.filePath}>{file.filePath}</span>
                      <em>
                        {file.duplicatedLines} lines · {file.percentage}%
                      </em>
                      <strong>{file.groupCount}</strong>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {report.warnings.length > 0 && (
            <section className="dup-analysis-notes">
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