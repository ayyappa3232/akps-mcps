import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  FileCode2,
  Layers,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Workflow,
  XCircle,
} from "lucide-react";
import SecuritySelect from "../security/SecuritySelect";
import "./build-codebase-context.css";

type ContextMode = "task" | "focus" | "orientation";
type FileKind = "source" | "test";
type IncludedAs = "full" | "outline" | "listed" | "omitted";
type Confidence = "high" | "medium" | "low";
type DetailLevel = "auto" | "outline";

interface ContextFile {
  path: string;
  area: string;
  kind: FileKind;
  lines: number;
  score: number;
  relevance: number;
  centrality: number;
  proximity: number;
  recency: number;
  reasons: string[];
  exports: string[];
  imports: string[];
  importedBy: string[];
  importCount: number;
  importedByCount: number;
  includedAs: IncludedAs;
  tokens: { full: number; outline: number };
  doc?: string;
  isEntry: boolean;
  content?: string;
}

interface AreaInfo {
  area: string;
  role: string;
  files: number;
  lines: number;
  dependsOn: string[];
  usedBy: string[];
  topFiles: string[];
}

interface Convention {
  id: string;
  label: string;
  value: string;
  evidence: string;
  confidence: Confidence;
}

interface ContextReport {
  success: boolean;
  tool: "build_codebase_context";
  projectPath: string;
  mode: ContextMode;
  task?: string;
  focusFiles: string[];
  queryTerms: string[];
  matchedTerms: string[];
  tokens: {
    budget: number;
    used: number;
    overview: number;
    files: number;
    remaining: number;
  };
  project: {
    name: string;
    description?: string;
    packageManager: string;
    languages: Array<{ language: string; files: number; lines: number }>;
    frameworks: Array<{ name: string; category: string }>;
    testRunner?: string;
    scripts: Array<{ name: string; command: string }>;
    entryPoints: string[];
    packages: Array<{ name: string; dir: string }>;
    totalFiles: number;
    totalLines: number;
    readmeSummary?: string;
  };
  areas: AreaInfo[];
  areaLinks: Array<{ from: string; to: string; count: number }>;
  conventions: Convention[];
  files: ContextFile[];
  includedCount: number;
  omittedCount: number;
  recentChanges: Array<{ hash: string; subject: string; date: string; files: string[] }>;
  contextMarkdown: string;
  guideMarkdown: string;
  redactions: number;
  warnings: string[];
}

interface BuildCodebaseContextProps {
  projectPath: string;
  onProjectPathChange?: (value: string) => void;
  apiUrl?: string;
}

type ViewMode = "files" | "areas" | "conventions";
type BudgetOption = "4000" | "8000" | "16000" | "32000" | "64000";

const DEFAULT_API_URL = "http://127.0.0.1:4174/api/build-codebase-context";

const BUDGET_LABEL: Record<BudgetOption, string> = {
  "4000": "4,000 tokens (small)",
  "8000": "8,000 tokens (default)",
  "16000": "16,000 tokens",
  "32000": "32,000 tokens",
  "64000": "64,000 tokens (large)",
};

const DETAIL_LABEL: Record<DetailLevel, string> = {
  auto: "Best files in full",
  outline: "Outlines only",
};

const MODE_LABEL: Record<ContextMode, string> = {
  task: "Task",
  focus: "Focus files",
  orientation: "Overview",
};

const VIEW_LABEL: Record<ViewMode, string> = {
  files: "Files",
  areas: "Areas",
  conventions: "Conventions",
};

const INCLUDED_LABEL: Record<IncludedAs, string> = {
  full: "Full source",
  outline: "Outline",
  listed: "Listed",
  omitted: "Not included",
};

/** The shared stylesheet colours by risk level, so each state maps onto it. */
const INCLUDED_TONE: Record<IncludedAs, string> = {
  full: "low",
  outline: "medium",
  listed: "info",
  omitted: "info",
};

const CONFIDENCE_TONE: Record<Confidence, string> = {
  high: "low",
  medium: "medium",
  low: "high",
};

function baseName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1];
}

function dirName(filePath: string): string {
  const parts = filePath.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function costOf(file: ContextFile): number {
  if (file.includedAs === "full") return file.tokens.full;
  if (file.includedAs === "outline") return file.tokens.outline;
  if (file.includedAs === "listed") return 28;
  return 0;
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
    <button type="button" onClick={copy}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? "Copied" : failed ? "Select and copy" : label}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*  View                                                                      */
/* -------------------------------------------------------------------------- */

export default function BuildCodebaseContext({
  projectPath,
  onProjectPathChange,
  apiUrl = DEFAULT_API_URL,
}: BuildCodebaseContextProps) {
  const [task, setTask] = useState("");
  const [focusInput, setFocusInput] = useState("");
  const [budget, setBudget] = useState<BudgetOption>("8000");
  const [detail, setDetail] = useState<DetailLevel>("auto");
  const [includeTests, setIncludeTests] = useState(false);
  const [includeGit, setIncludeGit] = useState(true);

  const [report, setReport] = useState<ContextReport | null>(null);
  const [view, setView] = useState<ViewMode>("files");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [levelFilter, setLevelFilter] = useState("all");
  const [sortKey, setSortKey] = useState("default");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const focusFiles = useMemo(
    () =>
      focusInput
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    [focusInput]
  );

  async function analyze() {
    if (!projectPath.trim()) {
      setError("Enter a project path before building the context.");
      return;
    }

    if (task.length > 2000) {
      setError("Describe the task in at most 2000 characters.");
      return;
    }

    if (focusFiles.length > 20) {
      setError("Enter at most 20 focus files or folders.");
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
          task: task.trim() || undefined,
          focusFiles: focusFiles.length > 0 ? focusFiles : undefined,
          tokenBudget: Number(budget),
          detail,
          includeTests,
          includeGit,
        }),
      });

      const data = await response.json();

      if (!response.ok || data.success === false) {
        throw new Error(data.error || "Building the codebase context failed.");
      }

      const next = data as ContextReport;

      setReport(next);
      setView("files");
      setSelectedId(next.files[0]?.path ?? null);
      setSearch("");
      setLevelFilter("all");
      setSortKey("default");
    } catch (analysisError) {
      setError(
        analysisError instanceof Error
          ? analysisError.message
          : "Unable to build the context."
      );
    } finally {
      setLoading(false);
    }
  }

  function firstIdOf(next: ViewMode, source: ContextReport): string | null {
    if (next === "files") return source.files[0]?.path ?? null;
    if (next === "areas") return source.areas[0]?.area ?? null;
    return source.conventions[0]?.id ?? null;
  }

  function switchView(next: ViewMode) {
    if (!report) return;
    setView(next);
    setLevelFilter("all");
    setSortKey("default");
    setSearch("");
    setSelectedId(firstIdOf(next, report));
  }

  function openFile(filePath: string) {
    if (!report?.files.some((file) => file.path === filePath)) return;
    setView("files");
    setLevelFilter("all");
    setSearch("");
    setSelectedId(filePath);
  }

  const query = search.trim().toLowerCase();

  const visibleFiles = useMemo(() => {
    if (!report) return [];

    const filtered = report.files.filter((file) => {
      if (levelFilter !== "all" && file.includedAs !== levelFilter) return false;
      return !query || `${file.path} ${file.reasons.join(" ")}`.toLowerCase().includes(query);
    });

    if (sortKey === "lines") return [...filtered].sort((a, b) => b.lines - a.lines);
    if (sortKey === "name") return [...filtered].sort((a, b) => a.path.localeCompare(b.path));
    return filtered;
  }, [report, query, levelFilter, sortKey]);

  const visibleAreas = useMemo(() => {
    if (!report) return [];
    return report.areas.filter(
      (area) => !query || `${area.area} ${area.role}`.toLowerCase().includes(query)
    );
  }, [report, query]);

  const visibleConventions = useMemo(() => {
    if (!report) return [];
    return report.conventions.filter((item) => {
      if (levelFilter !== "all" && item.confidence !== levelFilter) return false;
      return !query || `${item.label} ${item.value} ${item.evidence}`.toLowerCase().includes(query);
    });
  }, [report, query, levelFilter]);

  const counts: Record<ViewMode, number> = {
    files: visibleFiles.length,
    areas: visibleAreas.length,
    conventions: visibleConventions.length,
  };

  const selectedFile =
    view === "files"
      ? (visibleFiles.find((item) => item.path === selectedId) ?? visibleFiles[0] ?? null)
      : null;
  const selectedArea =
    view === "areas"
      ? (visibleAreas.find((item) => item.area === selectedId) ?? visibleAreas[0] ?? null)
      : null;
  const selectedConvention =
    view === "conventions"
      ? (visibleConventions.find((item) => item.id === selectedId) ??
        visibleConventions[0] ??
        null)
      : null;

  const meter = report
    ? {
        overview: Math.min(100, (report.tokens.overview / report.tokens.budget) * 100),
        files: Math.min(100, (report.tokens.files / report.tokens.budget) * 100),
      }
    : { overview: 0, files: 0 };

  const levelOptions =
    view === "files"
      ? [
          { value: "all", label: "All files" },
          { value: "full", label: "Full source" },
          { value: "outline", label: "Outlines" },
          { value: "listed", label: "Listed only" },
          { value: "omitted", label: "Not included" },
        ]
      : [
          { value: "all", label: "All confidence" },
          { value: "high", label: "High" },
          { value: "medium", label: "Medium" },
          { value: "low", label: "Low" },
        ];

  const sortOptions = [
    { value: "default", label: "Sort: rank" },
    { value: "lines", label: "Sort: size" },
    { value: "name", label: "Sort: name" },
  ];

  const stackByCategory = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const item of report?.project.frameworks ?? []) {
      const list = groups.get(item.category) ?? [];
      list.push(item.name);
      groups.set(item.category, list);
    }
    return [...groups.entries()];
  }, [report]);

  const highConfidence = report?.conventions.filter((item) => item.confidence === "high").length ?? 0;

  return (
    <div className="ctx-analyzer">
      <div className="ctx-title-row">
        <div className="ctx-title-icon">
          <Layers size={24} />
        </div>

        <div>
          <h1>Codebase Context</h1>
          <p>
            Give an AI assistant exactly the code it needs: the files that matter
            for your task, condensed to fit a token budget, with the project&apos;s
            stack, structure and conventions.
          </p>
        </div>
      </div>

      <section className="ctx-input-card">
        <div className="ctx-field ctx-field-wide">
          <label htmlFor="ctx-project-path">Project path</label>
          <input
            id="ctx-project-path"
            value={projectPath}
            onChange={(event) => onProjectPathChange?.(event.target.value)}
            placeholder="/path/to/your/project"
          />
        </div>

        <div className="ctx-field">
          <label htmlFor="ctx-task">What are you working on? (optional)</label>
          <input
            id="ctx-task"
            value={task}
            onChange={(event) => setTask(event.target.value)}
            placeholder="add rate limiting to the login endpoint"
          />
        </div>

        <button
          type="button"
          className="ctx-analyze-button"
          onClick={analyze}
          disabled={loading}
        >
          {loading ? (
            <>
              <span className="ctx-spinner" />
              Building...
            </>
          ) : (
            <>
              <Layers size={17} />
              Build Context
            </>
          )}
        </button>

        <div className="ctx-options">
          <div className="ctx-field">
            <span className="ctx-field-label">Token budget</span>
            <SecuritySelect
              ariaLabel="Token budget"
              value={budget}
              onChange={setBudget}
              options={(Object.keys(BUDGET_LABEL) as BudgetOption[]).map((item) => ({
                value: item,
                label: BUDGET_LABEL[item],
              }))}
            />
          </div>

          <div className="ctx-field">
            <label htmlFor="ctx-focus">Focus files or folders (optional)</label>
            <input
              id="ctx-focus"
              value={focusInput}
              onChange={(event) => setFocusInput(event.target.value)}
              placeholder="src/server/auth, src/app.ts"
            />
          </div>

          <div className="ctx-field">
            <span className="ctx-field-label">How much code to show</span>
            <SecuritySelect
              ariaLabel="How much code to show"
              value={detail}
              onChange={setDetail}
              options={(Object.keys(DETAIL_LABEL) as DetailLevel[]).map((item) => ({
                value: item,
                label: DETAIL_LABEL[item],
              }))}
            />
          </div>
        </div>

        <div className="ctx-options ctx-options-secondary">
          <label className="ctx-check">
            <input
              type="checkbox"
              checked={includeTests}
              onChange={(event) => setIncludeTests(event.target.checked)}
            />
            Include test files
          </label>

          <label className="ctx-check">
            <input
              type="checkbox"
              checked={includeGit}
              onChange={(event) => setIncludeGit(event.target.checked)}
            />
            Use recent git activity
          </label>
        </div>
      </section>

      {error && (
        <div className="ctx-error" role="alert">
          <XCircle size={18} />
          {error}
        </div>
      )}

      {report && (
        <>
          <div className="ctx-status-row">
            <div className="ctx-success">
              <CheckCircle2 size={18} />
              <strong>{formatNumber(report.tokens.used)}</strong>
              <span>
                of {formatNumber(report.tokens.budget)} tokens used by{" "}
                {plural(report.includedCount, "file")}
              </span>
            </div>

            <div className="ctx-status-right">
              <span className="ctx-saved branch">{MODE_LABEL[report.mode]} mode</span>
              <span className="ctx-scope">
                {report.project.name} · {formatNumber(report.project.totalFiles)} files ·{" "}
                {formatNumber(report.project.totalLines)} lines
              </span>
            </div>
          </div>

          {report.mode === "task" && report.matchedTerms.length === 0 && report.focusFiles.length === 0 && (
            <section className="ctx-runall" role="note">
              <AlertTriangle size={18} />
              <div>
                <h3>No file matched the words in your task</h3>
                <p>
                  Showing the most central files instead. Try different words, or
                  pick focus files to tell the tool where to look.
                </p>
              </div>
            </section>
          )}

          <section className="ctx-meter" aria-label="Token budget">
            <div className="ctx-meter-head">
              <h2>Token budget</h2>
              <span>
                {formatNumber(report.tokens.remaining)} tokens left · estimated at 4
                characters per token
              </span>
            </div>

            <div
              className="ctx-meter-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={report.tokens.budget}
              aria-valuenow={report.tokens.used}
            >
              <div className="ctx-meter-overview" style={{ width: `${meter.overview}%` }} />
              <div className="ctx-meter-files" style={{ width: `${meter.files}%` }} />
            </div>

            <div className="ctx-meter-legend">
              <span>
                <i style={{ background: "#4f8cff" }} />
                Project overview {formatNumber(report.tokens.overview)}
              </span>
              <span>
                <i style={{ background: "#7a6bff" }} />
                Code {formatNumber(report.tokens.files)}
              </span>
              {report.omittedCount > 0 && (
                <span>{plural(report.omittedCount, "file")} did not fit</span>
              )}
            </div>
          </section>

          <div className="ctx-summary-grid">
            <button
              type="button"
              className={`ctx-summary-card ctx-tone-a ${view === "files" ? "active" : ""}`}
              onClick={() => switchView("files")}
              aria-pressed={view === "files"}
            >
              <div className="ctx-summary-icon">
                <FileCode2 size={17} />
              </div>
              <div>
                <strong>{report.includedCount}</strong>
                <span>Files in the pack</span>
                <span className="ctx-summary-sub">
                  {report.omittedCount} did not fit
                </span>
              </div>
            </button>

            <button
              type="button"
              className={`ctx-summary-card ctx-tone-b ${view === "areas" ? "active" : ""}`}
              onClick={() => switchView("areas")}
              aria-pressed={view === "areas"}
            >
              <div className="ctx-summary-icon">
                <Workflow size={17} />
              </div>
              <div>
                <strong>{report.areas.length}</strong>
                <span>Areas</span>
                <span className="ctx-summary-sub">How the code is organized</span>
              </div>
            </button>

            <button
              type="button"
              className={`ctx-summary-card ctx-tone-a ${view === "conventions" ? "active" : ""}`}
              onClick={() => switchView("conventions")}
              aria-pressed={view === "conventions"}
            >
              <div className="ctx-summary-icon">
                <SlidersHorizontal size={17} />
              </div>
              <div>
                <strong>{report.conventions.length}</strong>
                <span>Conventions</span>
                <span className="ctx-summary-sub">{highConfidence} high confidence</span>
              </div>
            </button>

            <div className="ctx-summary-card static">
              <div className="ctx-summary-icon neutral">
                <ShieldCheck size={17} />
              </div>
              <div>
                <strong>{report.redactions}</strong>
                <span>Secrets removed</span>
                <span className="ctx-summary-sub">Credential files are skipped</span>
              </div>
            </div>
          </div>

          <section className="ctx-workspace">
            <div className="ctx-groups-panel">
              <div className="ctx-panel-header">
                <div>
                  <h2>{VIEW_LABEL[view]}</h2>
                  <p>
                    {counts[view]} of{" "}
                    {view === "files"
                      ? report.files.length
                      : view === "areas"
                        ? report.areas.length
                        : report.conventions.length}{" "}
                    items
                  </p>
                </div>

                <div className="ctx-count-pill">{counts[view]}</div>
              </div>

              <div className="ctx-filters">
                <div className="ctx-search">
                  <Search size={17} />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search..."
                    aria-label="Search"
                  />
                </div>

                <div className="ctx-filter-row">
                  <div className="ctx-type-filter" role="group" aria-label="Choose a list">
                    {(Object.keys(VIEW_LABEL) as ViewMode[]).map((item) => (
                      <button
                        type="button"
                        key={item}
                        className={view === item ? "active" : ""}
                        aria-pressed={view === item}
                        onClick={() => switchView(item)}
                      >
                        {VIEW_LABEL[item]}
                      </button>
                    ))}
                  </div>

                  {view !== "areas" && (
                    <div className="ctx-sort">
                      <SecuritySelect
                        ariaLabel="Filter"
                        value={levelFilter}
                        onChange={setLevelFilter}
                        options={levelOptions}
                      />
                    </div>
                  )}

                  {view === "files" && (
                    <div className="ctx-sort">
                      <SecuritySelect
                        ariaLabel="Sort"
                        value={sortKey}
                        onChange={setSortKey}
                        options={sortOptions}
                      />
                    </div>
                  )}
                </div>
              </div>

              <div className="ctx-groups-list">
                {counts[view] === 0 ? (
                  <div className="ctx-empty">
                    <Layers size={34} />
                    <h3>Nothing here</h3>
                    <p>No items match the current filters.</p>
                  </div>
                ) : view === "files" ? (
                  visibleFiles.map((file) => (
                    <button
                      type="button"
                      key={file.path}
                      className={`ctx-group ${selectedFile?.path === file.path ? "selected" : ""}`}
                      onClick={() => setSelectedId(file.path)}
                    >
                      <div className={`ctx-group-icon ctx-severity-${INCLUDED_TONE[file.includedAs]}`}>
                        <FileCode2 size={17} />
                      </div>
                      <div className="ctx-group-content">
                        <div className="ctx-group-top">
                          <span className={`ctx-badge ctx-badge-${INCLUDED_TONE[file.includedAs]}`}>
                            {INCLUDED_LABEL[file.includedAs]}
                          </span>
                          <span className="ctx-kind-badge">score {file.score.toFixed(2)}</span>
                          {file.isEntry && <span className="ctx-kind-badge">entry</span>}
                          {file.kind === "test" && <span className="ctx-kind-badge">test</span>}
                        </div>
                        <h3>{baseName(file.path)}</h3>
                        <p className="ctx-places">
                          {dirName(file.path)} · {plural(file.lines, "line")}
                          {costOf(file) > 0 ? ` · ${formatNumber(costOf(file))} tokens` : ""}
                        </p>
                      </div>
                    </button>
                  ))
                ) : view === "areas" ? (
                  visibleAreas.map((area) => (
                    <button
                      type="button"
                      key={area.area}
                      className={`ctx-group ${selectedArea?.area === area.area ? "selected" : ""}`}
                      onClick={() => setSelectedId(area.area)}
                    >
                      <div className="ctx-group-icon ctx-severity-info">
                        <Workflow size={17} />
                      </div>
                      <div className="ctx-group-content">
                        <div className="ctx-group-top">
                          <span className="ctx-kind-badge">{area.role}</span>
                        </div>
                        <h3>{area.area}</h3>
                        <p className="ctx-places">
                          {plural(area.files, "file")} · {formatNumber(area.lines)} lines
                        </p>
                      </div>
                    </button>
                  ))
                ) : (
                  visibleConventions.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      className={`ctx-group ${selectedConvention?.id === item.id ? "selected" : ""}`}
                      onClick={() => setSelectedId(item.id)}
                    >
                      <div className={`ctx-group-icon ctx-severity-${CONFIDENCE_TONE[item.confidence]}`}>
                        <SlidersHorizontal size={17} />
                      </div>
                      <div className="ctx-group-content">
                        <div className="ctx-group-top">
                          <span className={`ctx-confidence ctx-confidence-${item.confidence}`}>
                            {item.confidence} confidence
                          </span>
                        </div>
                        <h3>{item.label}</h3>
                        <p className="ctx-places">{item.value}</p>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>

            <aside className="ctx-inspector">
              <div className="ctx-panel-header">
                <div>
                  <h2>Inspector</h2>
                  <p>Why it is in the pack and what the assistant sees</p>
                </div>
              </div>

              {selectedFile ? (
                <div className="ctx-inspector-body">
                  <div className="ctx-inspector-title">
                    <div className={`ctx-inspector-icon ctx-severity-${INCLUDED_TONE[selectedFile.includedAs]}`}>
                      <FileCode2 size={20} />
                    </div>
                    <div>
                      <span className={`ctx-badge ctx-badge-${INCLUDED_TONE[selectedFile.includedAs]}`}>
                        {INCLUDED_LABEL[selectedFile.includedAs]}
                      </span>
                      <h3>{selectedFile.path}</h3>
                    </div>
                  </div>

                  <div className="ctx-detail-grid">
                    <div>
                      <span>Score</span>
                      <strong>{selectedFile.score.toFixed(2)}</strong>
                    </div>
                    <div>
                      <span>Lines</span>
                      <strong>{formatNumber(selectedFile.lines)}</strong>
                    </div>
                    <div>
                      <span>Tokens in pack</span>
                      <strong>{formatNumber(costOf(selectedFile))}</strong>
                    </div>
                    <div>
                      <span>Area</span>
                      <strong title={selectedFile.area}>{selectedFile.area}</strong>
                    </div>
                  </div>

                  <section className="ctx-box">
                    <h4>Why it is here</h4>
                    <ul className="ctx-flags">
                      {selectedFile.reasons.map((reason) => (
                        <li key={reason}>
                          <CheckCircle2 size={13} />
                          {reason}
                        </li>
                      ))}
                    </ul>

                    <div className="ctx-score-row">
                      {(
                        [
                          ["Word match", selectedFile.relevance],
                          ["Importance", selectedFile.centrality],
                          ["Closeness", selectedFile.proximity],
                          ["Recent activity", selectedFile.recency],
                        ] as const
                      ).map(([label, value]) => (
                        <div key={label}>
                          <span>{label}</span>
                          <div className="ctx-score-track">
                            <i style={{ width: `${Math.round(value * 100)}%` }} />
                          </div>
                          <strong>{value.toFixed(2)}</strong>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="ctx-box">
                    <h4>What the assistant sees</h4>
                    {selectedFile.content ? (
                      <>
                        <p className="ctx-more">
                          {selectedFile.includedAs === "full"
                            ? "The whole file, with any secrets removed."
                            : "Signatures only: exports, types and routes, without function bodies."}
                        </p>
                        <pre className="ctx-code ctx-mono">
                          <code>{selectedFile.content}</code>
                        </pre>
                        <div className="ctx-deliver-actions">
                          <CopyButton value={selectedFile.content} label="Copy this file" />
                        </div>
                      </>
                    ) : selectedFile.includedAs === "listed" ? (
                      <p>Only its name and exports are listed, to save tokens.</p>
                    ) : (
                      <p>
                        This file ranked high enough to consider but did not fit in
                        the budget. Raise the budget or add it as a focus file.
                      </p>
                    )}

                    {selectedFile.exports.length > 0 && (
                      <>
                        <p className="ctx-example-label">Exports</p>
                        <ul className="ctx-pill-list">
                          {selectedFile.exports.map((name) => (
                            <li key={name}>{name}</li>
                          ))}
                        </ul>
                      </>
                    )}
                  </section>

                  {(selectedFile.imports.length > 0 || selectedFile.importedBy.length > 0) && (
                    <section className="ctx-box">
                      <h4>Connections</h4>
                      {selectedFile.imports.length > 0 && (
                        <>
                          <p className="ctx-more">Imports ({selectedFile.importCount})</p>
                          <ul className="ctx-link-list">
                            {selectedFile.imports.map((file) => (
                              <li key={file}>
                                <button type="button" onClick={() => openFile(file)}>
                                  <span title={file}>{file}</span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                      {selectedFile.importedBy.length > 0 && (
                        <>
                          <p className="ctx-more">Imported by ({selectedFile.importedByCount})</p>
                          <ul className="ctx-link-list">
                            {selectedFile.importedBy.map((file) => (
                              <li key={file}>
                                <button type="button" onClick={() => openFile(file)}>
                                  <span title={file}>{file}</span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </section>
                  )}
                </div>
              ) : selectedArea ? (
                <div className="ctx-inspector-body">
                  <div className="ctx-inspector-title">
                    <div className="ctx-inspector-icon ctx-severity-info">
                      <Workflow size={20} />
                    </div>
                    <div>
                      <span className="ctx-kind-badge">{selectedArea.role}</span>
                      <h3>{selectedArea.area}</h3>
                    </div>
                  </div>

                  <div className="ctx-detail-grid">
                    <div>
                      <span>Files</span>
                      <strong>{selectedArea.files}</strong>
                    </div>
                    <div>
                      <span>Lines</span>
                      <strong>{formatNumber(selectedArea.lines)}</strong>
                    </div>
                    <div>
                      <span>Uses</span>
                      <strong>{selectedArea.dependsOn.length}</strong>
                    </div>
                    <div>
                      <span>Used by</span>
                      <strong>{selectedArea.usedBy.length}</strong>
                    </div>
                  </div>

                  <section className="ctx-box">
                    <h4>Depends on</h4>
                    {selectedArea.dependsOn.length === 0 ? (
                      <p>Nothing outside this area.</p>
                    ) : (
                      <ul className="ctx-pill-list">
                        {selectedArea.dependsOn.map((name) => (
                          <li key={name}>{name}</li>
                        ))}
                      </ul>
                    )}
                    <p className="ctx-example-label">Used by</p>
                    {selectedArea.usedBy.length === 0 ? (
                      <p>No other area imports it.</p>
                    ) : (
                      <ul className="ctx-pill-list">
                        {selectedArea.usedBy.map((name) => (
                          <li key={name}>{name}</li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <section className="ctx-box">
                    <h4>Most important files</h4>
                    <ul className="ctx-link-list">
                      {selectedArea.topFiles.map((file) => (
                        <li key={file}>
                          <button type="button" onClick={() => openFile(file)}>
                            <span title={file}>{file}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                </div>
              ) : selectedConvention ? (
                <div className="ctx-inspector-body">
                  <div className="ctx-inspector-title">
                    <div
                      className={`ctx-inspector-icon ctx-severity-${CONFIDENCE_TONE[selectedConvention.confidence]}`}
                    >
                      <SlidersHorizontal size={20} />
                    </div>
                    <div>
                      <span
                        className={`ctx-confidence ctx-confidence-${selectedConvention.confidence}`}
                      >
                        {selectedConvention.confidence} confidence
                      </span>
                      <h3>{selectedConvention.label}</h3>
                    </div>
                  </div>

                  <section className="ctx-box">
                    <h4>What the code does</h4>
                    <p>{selectedConvention.value}</p>
                  </section>

                  <section className="ctx-box">
                    <h4>Evidence</h4>
                    <p>{selectedConvention.evidence}</p>
                    <p className="ctx-more">
                      {selectedConvention.confidence === "low"
                        ? "Few examples or a mixed result, so treat this as a hint."
                        : "Seen consistently, so new code should follow it."}
                    </p>
                  </section>
                </div>
              ) : (
                <div className="ctx-inspector-empty">
                  <Layers size={38} />
                  <h3>Select an item</h3>
                  <p>Choose something from the list to see the details.</p>
                </div>
              )}
            </aside>
          </section>

          <section className="ctx-deliver">
            <h2>Context pack</h2>
            <p>
              Paste this into your AI assistant before you describe the task. It
              is about {formatNumber(report.tokens.used)} tokens.
              {report.redactions > 0
                ? ` ${plural(report.redactions, "secret")} removed.`
                : ""}
            </p>

            <pre className="ctx-markdown">{report.contextMarkdown}</pre>

            <div className="ctx-deliver-actions">
              <CopyButton value={report.contextMarkdown} label="Copy context pack" />
            </div>
          </section>

          <section className="ctx-deliver">
            <h2>Project guide</h2>
            <p>
              A reusable summary of the project with no task-specific code. Save
              it as CLAUDE.md or AGENTS.md so every session starts informed.
            </p>

            <pre className="ctx-markdown">{report.guideMarkdown}</pre>

            <div className="ctx-deliver-actions">
              <CopyButton value={report.guideMarkdown} label="Copy project guide" />
            </div>
          </section>

          <section className="ctx-insights">
            <div className="ctx-insight">
              <h2>Stack</h2>
              <p>Detected from package.json.</p>
              {stackByCategory.length === 0 ? (
                <p>No frameworks detected.</p>
              ) : (
                stackByCategory.map(([category, names]) => (
                  <div className="ctx-stack-group" key={category}>
                    <strong>{category}</strong>
                    {names.join(", ")}
                  </div>
                ))
              )}
              <ul className="ctx-rows">
                <li>
                  <span>Package manager</span>
                  <strong>{report.project.packageManager}</strong>
                </li>
                {report.project.testRunner && (
                  <li>
                    <span>Test runner</span>
                    <strong>{report.project.testRunner}</strong>
                  </li>
                )}
              </ul>
            </div>

            <div className="ctx-insight">
              <h2>Commands</h2>
              <p>From the scripts in package.json.</p>
              {report.project.scripts.length === 0 ? (
                <p>No scripts found.</p>
              ) : (
                <ul className="ctx-rows">
                  {report.project.scripts.slice(0, 8).map((script) => (
                    <li className="ctx-command-row" key={script.name}>
                      <code>{script.name}</code>
                      <span title={script.command}>{script.command}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="ctx-insight">
              <h2>Entry points</h2>
              <p>Where the code starts running.</p>
              {report.project.entryPoints.length === 0 ? (
                <p>None detected.</p>
              ) : (
                <ul className="ctx-link-list">
                  {report.project.entryPoints.map((file) => (
                    <li key={file}>
                      <button type="button" onClick={() => openFile(file)}>
                        <span title={file}>{file}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {report.project.packages.length > 0 && (
                <>
                  <p className="ctx-example-label">Packages</p>
                  <ul className="ctx-rows">
                    {report.project.packages.map((item) => (
                      <li key={item.dir}>
                        <span>{item.name}</span>
                        <em>{item.dir}/</em>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </section>

          {report.warnings.length > 0 && (
            <section className="ctx-analysis-notes">
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
