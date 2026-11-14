import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  FileCode2,
  Flame,
  GitCommit,
  GitCompare,
  Search,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import SecuritySelect from "../security/SecuritySelect";
import "./analyze-git-changes.css";

type AnalysisMode = "recent" | "range" | "working";
type Risk = "critical" | "high" | "medium" | "low";

type ChangeCategory =
  | "feature"
  | "fix"
  | "refactor"
  | "docs"
  | "test"
  | "style"
  | "perf"
  | "build"
  | "ci"
  | "chore"
  | "revert"
  | "merge"
  | "other";

type FileKind =
  | "source"
  | "test"
  | "docs"
  | "config"
  | "lockfile"
  | "ci"
  | "generated"
  | "asset"
  | "other";

type FindingRule =
  | "conflict-marker"
  | "secret"
  | "sensitive-file"
  | "focused-test"
  | "debugger"
  | "console-log"
  | "todo"
  | "suppression"
  | "skipped-test"
  | "large-addition";

interface CommitFile {
  path: string;
  additions: number;
  deletions: number;
  kind: FileKind;
  binary: boolean;
}

interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  bodyPreview: string;
  isMerge: boolean;
  category: ChangeCategory;
  additions: number;
  deletions: number;
  fileCount: number;
  files: CommitFile[];
  areas: string[];
  score: number;
  risk: Risk;
  flags: Array<{ flag: string; message: string }>;
}

interface ChangedFileInfo {
  path: string;
  status: "added" | "modified" | "deleted";
  kind: FileKind;
  additions: number;
  deletions: number;
  binary: boolean;
}

interface FileHotspot {
  filePath: string;
  kind: FileKind;
  commits: number;
  additions: number;
  deletions: number;
  authors: number;
  fixCommits: number;
  lastChanged: string;
  score: number;
  risk: Risk;
  reasons: string[];
  changedNow: boolean;
  partners: Array<{ filePath: string; count: number; confidence: number }>;
}

interface CoupledPair {
  a: string;
  b: string;
  count: number;
  confidence: number;
  crossArea: boolean;
}

interface Companion {
  changedFile: string;
  partner: string;
  count: number;
  confidence: number;
}

interface AuthorStat {
  name: string;
  email: string;
  commits: number;
  additions: number;
  deletions: number;
  files: number;
  topCategory: ChangeCategory;
}

interface AreaStat {
  area: string;
  commits: number;
  files: number;
  additions: number;
  deletions: number;
}

interface Finding {
  id: string;
  rule: FindingRule;
  severity: Risk;
  filePath: string;
  line?: number;
  message: string;
  snippet?: string;
  suggestion: string;
}

interface SplitSuggestion {
  id: string;
  label: string;
  files: string[];
  commitMessage: string;
  command: string;
  confidence: "high" | "medium" | "low";
}

interface GitChangeReport {
  success: boolean;
  tool: "analyze_git_changes";
  projectPath: string;
  mode: AnalysisMode;
  branch?: string;
  pathFilter?: string;
  range: { label: string; from?: string; to?: string };
  totals: {
    commits: number;
    authors: number;
    filesChanged: number;
    additions: number;
    deletions: number;
    mergeCommits: number;
    days: number;
  };
  categories: Array<{ category: ChangeCategory; commits: number; lines: number }>;
  commits: CommitInfo[];
  changedFiles: ChangedFileInfo[];
  hotspots: FileHotspot[];
  coupling: CoupledPair[];
  companions: Companion[];
  authors: AuthorStat[];
  areas: AreaStat[];
  findings: Finding[];
  commitRisk: Record<Risk, number>;
  findingSummary: Record<Risk, number>;
  working?: {
    staged: number;
    unstaged: number;
    untracked: number;
    conflicted: number;
  };
  splits: SplitSuggestion[];
  pullRequest: { title: string; markdown: string };
  commitMessage?: { subject: string; body: string };
  warnings: string[];
}

interface AnalyzeGitChangesProps {
  projectPath: string;
  onProjectPathChange?: (value: string) => void;
  apiUrl?: string;
}

type ViewMode = "commits" | "files" | "hotspots" | "findings";
type SortKey = string;

const DEFAULT_API_URL = "http://127.0.0.1:4174/api/analyze-git-changes";

const REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.\-/@^~{}:]*$/;

const MODE_LABEL: Record<AnalysisMode, string> = {
  recent: "Recent commits",
  range: "Branch vs base",
  working: "Uncommitted changes",
};

const CATEGORY_LABEL: Record<ChangeCategory, string> = {
  feature: "Feature",
  fix: "Fix",
  refactor: "Refactor",
  docs: "Docs",
  test: "Test",
  style: "Style",
  perf: "Performance",
  build: "Build",
  ci: "CI",
  chore: "Chore",
  revert: "Revert",
  merge: "Merge",
  other: "Other",
};

const KIND_LABEL: Record<FileKind, string> = {
  source: "Source",
  test: "Test",
  docs: "Docs",
  config: "Config",
  lockfile: "Lockfile",
  ci: "CI",
  generated: "Generated",
  asset: "Asset",
  other: "Other",
};

const RULE_LABEL: Record<FindingRule, string> = {
  "conflict-marker": "Conflict marker",
  secret: "Possible secret",
  "sensitive-file": "Sensitive file",
  "focused-test": "Focused test",
  debugger: "Debugger",
  "console-log": "console.log",
  todo: "TODO",
  suppression: "Check disabled",
  "skipped-test": "Skipped test",
  "large-addition": "Large addition",
};

const VIEW_LABEL: Record<ViewMode, string> = {
  commits: "Commits",
  files: "Files",
  hotspots: "Hotspots",
  findings: "Findings",
};

function baseName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1];
}

function dirName(filePath: string): string {
  const parts = filePath.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
}

function formatDate(value: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  return new Date(time).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
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

export default function AnalyzeGitChanges({
  projectPath,
  onProjectPathChange,
  apiUrl = DEFAULT_API_URL,
}: AnalyzeGitChangesProps) {
  const [pathFilter, setPathFilter] = useState("");
  const [mode, setMode] = useState<AnalysisMode>("recent");
  const [commitCount, setCommitCount] = useState("100");
  const [baseRef, setBaseRef] = useState("");
  const [headRef, setHeadRef] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(true);

  const [report, setReport] = useState<GitChangeReport | null>(null);
  const [view, setView] = useState<ViewMode>("commits");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [levelFilter, setLevelFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("default");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function analyze() {
    if (!projectPath.trim()) {
      setError("Enter a project path before starting the analysis.");
      return;
    }

    const count = Number(commitCount);
    const base = baseRef.trim();
    const head = headRef.trim();

    if (mode !== "working" && (!Number.isInteger(count) || count < 1 || count > 500)) {
      setError("Enter a whole number of commits from 1 to 500.");
      return;
    }

    for (const [label, value] of [
      ["Base branch", mode === "range" ? base : ""],
      ["Branch", mode !== "working" ? head : ""],
    ] as const) {
      if (value && !REF_PATTERN.test(value)) {
        setError(
          `${label} must be a branch, tag or commit, for example main, v1.2.0 or a commit hash.`
        );
        return;
      }
    }

    setLoading(true);
    setError("");

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: projectPath.trim(),
          mode,
          baseRef: mode === "range" ? base || undefined : undefined,
          headRef: mode !== "working" ? head || undefined : undefined,
          maxCommits: Number.isInteger(count) && count >= 1 && count <= 500 ? count : 100,
          pathFilter: pathFilter.trim() || undefined,
          includeUntracked,
        }),
      });

      const data = await response.json();

      if (!response.ok || data.success === false) {
        throw new Error(data.error || "Git change analysis failed.");
      }

      const next = data as GitChangeReport;
      const nextView: ViewMode = next.mode === "working" ? "files" : "commits";

      setReport(next);
      setView(nextView);
      setSelectedId(
        nextView === "files"
          ? (next.changedFiles[0]?.path ?? null)
          : (next.commits[0]?.hash ?? null)
      );
      setSearch("");
      setLevelFilter("all");
      setSortKey("default");
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

  function firstIdOf(next: ViewMode, source: GitChangeReport): string | null {
    if (next === "commits") return source.commits[0]?.hash ?? null;
    if (next === "files") return source.changedFiles[0]?.path ?? null;
    if (next === "hotspots") return source.hotspots[0]?.filePath ?? null;
    return source.findings[0]?.id ?? null;
  }

  function switchView(next: ViewMode) {
    if (!report) return;
    setView(next);
    setLevelFilter("all");
    setSortKey("default");
    setSearch("");
    setSelectedId(firstIdOf(next, report));
  }

  const findingsByFile = useMemo(() => {
    const map = new Map<string, Finding[]>();
    for (const finding of report?.findings ?? []) {
      const list = map.get(finding.filePath) ?? [];
      list.push(finding);
      map.set(finding.filePath, list);
    }
    return map;
  }, [report]);

  const hotspotByFile = useMemo(
    () => new Map((report?.hotspots ?? []).map((item) => [item.filePath, item])),
    [report]
  );

  const query = search.trim().toLowerCase();

  const visibleCommits = useMemo(() => {
    if (!report) return [];

    const filtered = report.commits.filter((commit) => {
      if (levelFilter !== "all" && commit.risk !== levelFilter) return false;
      if (!query) return true;
      return [
        commit.subject,
        commit.author,
        commit.shortHash,
        commit.category,
        ...commit.files.map((file) => file.path),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

    if (sortKey === "risk") return [...filtered].sort((a, b) => b.score - a.score);
    if (sortKey === "size") {
      return [...filtered].sort(
        (a, b) => b.additions + b.deletions - (a.additions + a.deletions)
      );
    }
    return filtered;
  }, [report, query, levelFilter, sortKey]);

  const visibleFiles = useMemo(() => {
    if (!report) return [];

    const filtered = report.changedFiles.filter((file) => {
      if (levelFilter !== "all" && file.status !== levelFilter) return false;
      return !query || file.path.toLowerCase().includes(query);
    });

    return sortKey === "name"
      ? [...filtered].sort((a, b) => a.path.localeCompare(b.path))
      : filtered;
  }, [report, query, levelFilter, sortKey]);

  const visibleHotspots = useMemo(() => {
    if (!report) return [];

    const filtered = report.hotspots.filter((item) => {
      if (levelFilter !== "all" && item.risk !== levelFilter) return false;
      return !query || item.filePath.toLowerCase().includes(query);
    });

    if (sortKey === "commits") return [...filtered].sort((a, b) => b.commits - a.commits);
    if (sortKey === "name") {
      return [...filtered].sort((a, b) => a.filePath.localeCompare(b.filePath));
    }
    return filtered;
  }, [report, query, levelFilter, sortKey]);

  const visibleFindings = useMemo(() => {
    if (!report) return [];

    const filtered = report.findings.filter((finding) => {
      if (levelFilter !== "all" && finding.severity !== levelFilter) return false;
      return (
        !query ||
        [finding.filePath, finding.message, RULE_LABEL[finding.rule]]
          .join(" ")
          .toLowerCase()
          .includes(query)
      );
    });

    return sortKey === "file"
      ? [...filtered].sort((a, b) => a.filePath.localeCompare(b.filePath))
      : filtered;
  }, [report, query, levelFilter, sortKey]);

  const counts: Record<ViewMode, number> = {
    commits: visibleCommits.length,
    files: visibleFiles.length,
    hotspots: visibleHotspots.length,
    findings: visibleFindings.length,
  };

  const selectedCommit =
    view === "commits"
      ? (visibleCommits.find((item) => item.hash === selectedId) ?? visibleCommits[0] ?? null)
      : null;
  const selectedFile =
    view === "files"
      ? (visibleFiles.find((item) => item.path === selectedId) ?? visibleFiles[0] ?? null)
      : null;
  const selectedHotspot =
    view === "hotspots"
      ? (visibleHotspots.find((item) => item.filePath === selectedId) ??
        visibleHotspots[0] ??
        null)
      : null;
  const selectedFinding =
    view === "findings"
      ? (visibleFindings.find((item) => item.id === selectedId) ?? visibleFindings[0] ?? null)
      : null;

  const isWorking = report?.mode === "working";

  const hasUrgent =
    (report?.findingSummary.critical ?? 0) > 0 ||
    (report?.commitRisk.critical ?? 0) > 0 ||
    (report?.working?.conflicted ?? 0) > 0;

  const nothingToShow =
    report !== null &&
    report.totals.filesChanged === 0 &&
    report.commits.length === 0 &&
    report.findings.length === 0;

  const levelOptions =
    view === "files"
      ? [
          { value: "all", label: "All changes" },
          { value: "added", label: "Added" },
          { value: "modified", label: "Modified" },
          { value: "deleted", label: "Deleted" },
        ]
      : [
          { value: "all", label: view === "findings" ? "All severities" : "All risks" },
          ...(["critical", "high", "medium", "low"] as const).map((risk) => ({
            value: risk,
            label: risk.charAt(0).toUpperCase() + risk.slice(1),
          })),
        ];

  const sortOptions =
    view === "commits"
      ? [
          { value: "default", label: "Sort: newest" },
          { value: "risk", label: "Sort: risk" },
          { value: "size", label: "Sort: size" },
        ]
      : view === "files"
        ? [
            { value: "default", label: "Sort: most changed" },
            { value: "name", label: "Sort: name" },
          ]
        : view === "hotspots"
          ? [
              { value: "default", label: "Sort: score" },
              { value: "commits", label: "Sort: commits" },
              { value: "name", label: "Sort: name" },
            ]
          : [
              { value: "default", label: "Sort: severity" },
              { value: "file", label: "Sort: file" },
            ];

  const availableViews = (Object.keys(VIEW_LABEL) as ViewMode[]).filter(
    (item) => !(isWorking && item === "commits")
  );

  return (
    <div className="gca-analyzer">
      <div className="gca-title-row">
        <div className="gca-title-icon">
          <GitCommit size={24} />
        </div>

        <div>
          <h1>Git Change Analyzer</h1>
          <p>
            Understand recent commits, a branch or your uncommitted work: what
            changed, how risky it is, what to fix before committing, and a
            ready-made pull request summary.
          </p>
        </div>
      </div>

      <section className="gca-input-card">
        <div className="gca-field gca-field-wide">
          <label htmlFor="gca-project-path">Project path</label>
          <input
            id="gca-project-path"
            value={projectPath}
            onChange={(event) => onProjectPathChange?.(event.target.value)}
            placeholder="/path/to/your/project"
          />
        </div>

        <div className="gca-field">
          <label htmlFor="gca-path-filter">Limit to folder (optional)</label>
          <input
            id="gca-path-filter"
            value={pathFilter}
            onChange={(event) => setPathFilter(event.target.value)}
            placeholder="src/api"
          />
        </div>

        <button
          type="button"
          className="gca-analyze-button"
          onClick={analyze}
          disabled={loading}
        >
          {loading ? (
            <>
              <span className="gca-spinner" />
              Analyzing...
            </>
          ) : (
            <>
              <GitCommit size={17} />
              Analyze Changes
            </>
          )}
        </button>

        <div className="gca-options">
          <div className="gca-field">
            <span className="gca-field-label">What to analyze</span>
            <SecuritySelect
              ariaLabel="What to analyze"
              value={mode}
              onChange={setMode}
              options={(Object.keys(MODE_LABEL) as AnalysisMode[]).map((item) => ({
                value: item,
                label: MODE_LABEL[item],
              }))}
            />
          </div>

          {mode === "recent" && (
            <>
              <div className="gca-field">
                <label htmlFor="gca-commit-count">Commits to read</label>
                <input
                  id="gca-commit-count"
                  inputMode="numeric"
                  value={commitCount}
                  onChange={(event) => setCommitCount(event.target.value)}
                  placeholder="100"
                />
              </div>

              <div className="gca-field">
                <label htmlFor="gca-head-ref">Branch (optional)</label>
                <input
                  id="gca-head-ref"
                  value={headRef}
                  onChange={(event) => setHeadRef(event.target.value)}
                  placeholder="Current branch"
                />
              </div>
            </>
          )}

          {mode === "range" && (
            <>
              <div className="gca-field">
                <label htmlFor="gca-base-ref">Base branch</label>
                <input
                  id="gca-base-ref"
                  value={baseRef}
                  onChange={(event) => setBaseRef(event.target.value)}
                  placeholder="main (detected if empty)"
                />
              </div>

              <div className="gca-field">
                <label htmlFor="gca-range-head">Compare branch</label>
                <input
                  id="gca-range-head"
                  value={headRef}
                  onChange={(event) => setHeadRef(event.target.value)}
                  placeholder="Current branch"
                />
              </div>
            </>
          )}

          {mode === "working" && (
            <div className="gca-field gca-field-wide">
              <span className="gca-field-label">Scope</span>
              <p className="gca-field-hint">
                Staged, unstaged and untracked files compared with the last
                commit. Past commits are only used to find risky files.
              </p>
            </div>
          )}
        </div>

        <div className="gca-options gca-options-secondary">
          <label className="gca-check">
            <input
              type="checkbox"
              checked={includeUntracked}
              disabled={mode !== "working"}
              onChange={(event) => setIncludeUntracked(event.target.checked)}
            />
            Include new untracked files
          </label>
        </div>
      </section>

      {error && (
        <div className="gca-error" role="alert">
          <XCircle size={18} />
          {error}
        </div>
      )}

      {report && (
        <>
          <div className="gca-status-row">
            <div className={`gca-success ${hasUrgent ? "has-groups" : ""}`}>
              {hasUrgent ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
              <strong>{isWorking ? report.totals.filesChanged : report.totals.commits}</strong>
              <span>
                {isWorking
                  ? report.totals.filesChanged === 1
                    ? "uncommitted file"
                    : "uncommitted files"
                  : report.totals.commits === 1
                    ? "commit analyzed"
                    : "commits analyzed"}
                {report.pathFilter ? ` in ${report.pathFilter}` : ""}
              </span>
            </div>

            <div className="gca-status-right">
              {report.branch && (
                <span className="gca-saved branch">on {report.branch}</span>
              )}
              <span className="gca-scope">
                {report.range.label}
                {!isWorking && report.totals.authors > 0
                  ? ` · ${plural(report.totals.authors, "author")}`
                  : ""}
                {report.totals.days > 0 ? ` · ${plural(report.totals.days, "day")}` : ""}
              </span>
            </div>
          </div>

          {report.working && report.working.conflicted > 0 && (
            <section className="gca-runall" role="alert">
              <AlertTriangle size={18} />
              <div>
                <h3>
                  {plural(report.working.conflicted, "file")} still{" "}
                  {report.working.conflicted === 1 ? "has" : "have"} merge conflicts
                </h3>
                <p>Resolve them before committing.</p>
              </div>
            </section>
          )}

          <div className="gca-summary-grid">
            {isWorking ? (
              <button
                type="button"
                className={`gca-summary-card gca-tone-a ${view === "files" ? "active" : ""}`}
                onClick={() => switchView("files")}
                aria-pressed={view === "files"}
              >
                <div className="gca-summary-icon">
                  <FileCode2 size={17} />
                </div>
                <div>
                  <strong>{report.totals.filesChanged}</strong>
                  <span>Uncommitted files</span>
                  <span className="gca-summary-sub">
                    {report.working?.staged ?? 0} staged · {report.working?.unstaged ?? 0}{" "}
                    modified · {report.working?.untracked ?? 0} new
                  </span>
                </div>
              </button>
            ) : (
              <button
                type="button"
                className={`gca-summary-card gca-tone-a ${view === "commits" ? "active" : ""}`}
                onClick={() => switchView("commits")}
                aria-pressed={view === "commits"}
              >
                <div className="gca-summary-icon">
                  <GitCommit size={17} />
                </div>
                <div>
                  <strong>{report.totals.commits}</strong>
                  <span>Commits</span>
                  <span className="gca-summary-sub">
                    {report.commitRisk.critical + report.commitRisk.high} high risk ·{" "}
                    {report.totals.mergeCommits} merges
                  </span>
                </div>
              </button>
            )}

            <button
              type="button"
              className={`gca-summary-card gca-tone-b ${view === "hotspots" ? "active" : ""}`}
              onClick={() => switchView("hotspots")}
              aria-pressed={view === "hotspots"}
            >
              <div className="gca-summary-icon">
                <Flame size={17} />
              </div>
              <div>
                <strong>{report.hotspots.length}</strong>
                <span>Hotspots</span>
                <span className="gca-summary-sub">Files that change often</span>
              </div>
            </button>

            <button
              type="button"
              className={`gca-summary-card gca-tone-a ${view === "findings" ? "active" : ""}`}
              onClick={() => switchView("findings")}
              aria-pressed={view === "findings"}
            >
              <div className="gca-summary-icon">
                <ShieldAlert size={17} />
              </div>
              <div>
                <strong>{report.findings.length}</strong>
                <span>Findings</span>
                <span className="gca-summary-sub">
                  {report.findingSummary.critical} critical · {report.findingSummary.high} high
                </span>
              </div>
            </button>

            <button
              type="button"
              className={`gca-summary-card gca-tone-b ${
                view === "files" && !isWorking ? "active" : ""
              }`}
              onClick={() => switchView("files")}
              aria-pressed={view === "files"}
            >
              <div className="gca-summary-icon">
                <GitCompare size={17} />
              </div>
              <div>
                <strong>{report.totals.filesChanged}</strong>
                <span>Files changed</span>
                <span className="gca-summary-sub">
                  +{report.totals.additions} / −{report.totals.deletions} lines
                </span>
              </div>
            </button>
          </div>

          {report.companions.length > 0 && (
            <section className="gca-runall" role="note">
              <AlertTriangle size={18} />
              <div>
                <h3>Files that usually change together are missing</h3>
                {report.companions.slice(0, 4).map((item) => (
                  <p key={`${item.changedFile}-${item.partner}`}>
                    You changed <strong>{item.changedFile}</strong>, but not{" "}
                    <strong>{item.partner}</strong>, which changed with it in{" "}
                    {item.count} of the recent commits.
                  </p>
                ))}
              </div>
            </section>
          )}

          {nothingToShow ? (
            <section className="gca-clean">
              <CheckCircle2 size={38} />
              <h3>{isWorking ? "No uncommitted changes" : "No commits found"}</h3>
              <p>
                {isWorking
                  ? "The working tree matches the last commit."
                  : "No commits matched this selection. Check the branch and folder, or read more commits."}
              </p>
            </section>
          ) : (
            <section className="gca-workspace">
              <div className="gca-groups-panel">
                <div className="gca-panel-header">
                  <div>
                    <h2>{VIEW_LABEL[view]}</h2>
                    <p>
                      {counts[view]} of{" "}
                      {view === "commits"
                        ? report.commits.length
                        : view === "files"
                          ? report.changedFiles.length
                          : view === "hotspots"
                            ? report.hotspots.length
                            : report.findings.length}{" "}
                      items
                    </p>
                  </div>

                  <div className="gca-count-pill">{counts[view]}</div>
                </div>

                <div className="gca-filters">
                  <div className="gca-search">
                    <Search size={17} />
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search..."
                      aria-label="Search"
                    />
                  </div>

                  <div className="gca-filter-row">
                    <div className="gca-type-filter" role="group" aria-label="Choose a list">
                      {availableViews.map((item) => (
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

                    <div className="gca-sort">
                      <SecuritySelect
                        ariaLabel="Filter"
                        value={levelFilter}
                        onChange={setLevelFilter}
                        options={levelOptions}
                      />
                    </div>

                    <div className="gca-sort">
                      <SecuritySelect
                        ariaLabel="Sort"
                        value={sortKey}
                        onChange={setSortKey}
                        options={sortOptions}
                      />
                    </div>
                  </div>
                </div>

                <div className="gca-groups-list">
                  {counts[view] === 0 ? (
                    <div className="gca-empty">
                      <GitCommit size={34} />
                      <h3>Nothing here</h3>
                      <p>No items match the current filters.</p>
                    </div>
                  ) : view === "commits" ? (
                    visibleCommits.map((commit) => (
                      <button
                        type="button"
                        key={commit.hash}
                        className={`gca-group ${
                          selectedCommit?.hash === commit.hash ? "selected" : ""
                        }`}
                        onClick={() => setSelectedId(commit.hash)}
                      >
                        <div className={`gca-group-icon gca-severity-${commit.risk}`}>
                          <GitCommit size={17} />
                        </div>
                        <div className="gca-group-content">
                          <div className="gca-group-top">
                            <span className={`gca-badge gca-badge-${commit.risk}`}>
                              {commit.risk}
                            </span>
                            <span className="gca-kind-badge">
                              {CATEGORY_LABEL[commit.category]}
                            </span>
                            <span className="gca-hash gca-mono">{commit.shortHash}</span>
                          </div>
                          <h3>{commit.subject || "(no message)"}</h3>
                          <p className="gca-places">
                            {commit.author} · {formatDate(commit.date)} · +{commit.additions}{" "}
                            −{commit.deletions} · {plural(commit.fileCount, "file")}
                          </p>
                        </div>
                      </button>
                    ))
                  ) : view === "files" ? (
                    visibleFiles.map((file) => {
                      const hot = hotspotByFile.get(file.path);
                      const found = findingsByFile.get(file.path)?.length ?? 0;

                      return (
                        <button
                          type="button"
                          key={file.path}
                          className={`gca-group ${
                            selectedFile?.path === file.path ? "selected" : ""
                          }`}
                          onClick={() => setSelectedId(file.path)}
                        >
                          <div
                            className={`gca-group-icon gca-severity-${
                              found > 0 ? "high" : hot ? hot.risk : "info"
                            }`}
                          >
                            <FileCode2 size={17} />
                          </div>
                          <div className="gca-group-content">
                            <div className="gca-group-top">
                              <span className="gca-kind-badge">{file.status}</span>
                              <span className="gca-kind-badge">{KIND_LABEL[file.kind]}</span>
                              {hot && <span className="gca-kind-badge">hotspot</span>}
                              {found > 0 && (
                                <span className="gca-badge gca-badge-high">
                                  {plural(found, "finding")}
                                </span>
                              )}
                            </div>
                            <h3>{baseName(file.path)}</h3>
                            <p className="gca-places">
                              {dirName(file.path)} · +{file.additions} −{file.deletions}
                            </p>
                          </div>
                        </button>
                      );
                    })
                  ) : view === "hotspots" ? (
                    visibleHotspots.map((item) => (
                      <button
                        type="button"
                        key={item.filePath}
                        className={`gca-group ${
                          selectedHotspot?.filePath === item.filePath ? "selected" : ""
                        }`}
                        onClick={() => setSelectedId(item.filePath)}
                      >
                        <div className={`gca-group-icon gca-severity-${item.risk}`}>
                          <Flame size={17} />
                        </div>
                        <div className="gca-group-content">
                          <div className="gca-group-top">
                            <span className={`gca-badge gca-badge-${item.risk}`}>
                              {item.risk}
                            </span>
                            {item.changedNow && (
                              <span className="gca-kind-badge">changing now</span>
                            )}
                          </div>
                          <h3>{baseName(item.filePath)}</h3>
                          <p className="gca-places">
                            {dirName(item.filePath)} · {plural(item.commits, "commit")} ·{" "}
                            {plural(item.fixCommits, "fix", "fixes")}
                          </p>
                        </div>
                      </button>
                    ))
                  ) : (
                    visibleFindings.map((finding) => (
                      <button
                        type="button"
                        key={finding.id}
                        className={`gca-group ${
                          selectedFinding?.id === finding.id ? "selected" : ""
                        }`}
                        onClick={() => setSelectedId(finding.id)}
                      >
                        <div className={`gca-group-icon gca-severity-${finding.severity}`}>
                          <ShieldAlert size={17} />
                        </div>
                        <div className="gca-group-content">
                          <div className="gca-group-top">
                            <span className={`gca-badge gca-badge-${finding.severity}`}>
                              {finding.severity}
                            </span>
                            <span className="gca-kind-badge">{RULE_LABEL[finding.rule]}</span>
                          </div>
                          <h3>{baseName(finding.filePath)}</h3>
                          <p className="gca-places">
                            {finding.filePath}
                            {finding.line ? `:${finding.line}` : ""}
                          </p>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>

              <aside className="gca-inspector">
                <div className="gca-panel-header">
                  <div>
                    <h2>Inspector</h2>
                    <p>Details, risks and what to do next</p>
                  </div>
                </div>

                {selectedCommit ? (
                  <div className="gca-inspector-body">
                    <div className="gca-inspector-title">
                      <div className={`gca-inspector-icon gca-severity-${selectedCommit.risk}`}>
                        <GitCommit size={20} />
                      </div>
                      <div>
                        <span className={`gca-badge gca-badge-${selectedCommit.risk}`}>
                          {selectedCommit.risk}
                        </span>
                        <h3>{selectedCommit.subject || "(no message)"}</h3>
                      </div>
                    </div>

                    <div className="gca-detail-grid">
                      <div>
                        <span>Category</span>
                        <strong>{CATEGORY_LABEL[selectedCommit.category]}</strong>
                      </div>
                      <div>
                        <span>Author</span>
                        <strong>{selectedCommit.author}</strong>
                      </div>
                      <div>
                        <span>Date</span>
                        <strong>{formatDate(selectedCommit.date)}</strong>
                      </div>
                      <div>
                        <span>Commit</span>
                        <strong className="gca-mono">{selectedCommit.shortHash}</strong>
                      </div>
                    </div>

                    <section className="gca-box">
                      <h4>Risk flags</h4>
                      {selectedCommit.flags.length === 0 ? (
                        <p>No risk flags. This commit looks routine.</p>
                      ) : (
                        <ul className="gca-flags">
                          {selectedCommit.flags.map((flag) => (
                            <li key={flag.flag}>
                              <AlertTriangle size={13} />
                              {flag.message}
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>

                    {selectedCommit.bodyPreview && (
                      <section className="gca-box">
                        <h4>Message</h4>
                        <p>{selectedCommit.bodyPreview}</p>
                      </section>
                    )}

                    <section className="gca-box">
                      <h4>
                        Files ({selectedCommit.fileCount}) · +{selectedCommit.additions} −
                        {selectedCommit.deletions}
                      </h4>
                      {selectedCommit.files.length === 0 ? (
                        <p>This commit changed no files directly.</p>
                      ) : (
                        <ul className="gca-files">
                          {selectedCommit.files.map((file) => (
                            <li key={file.path}>
                              <span title={file.path}>{file.path}</span>
                              <span className="gca-kind-badge">{KIND_LABEL[file.kind]}</span>
                              <span className="gca-add">+{file.additions}</span>
                              <span className="gca-del">−{file.deletions}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {selectedCommit.fileCount > selectedCommit.files.length && (
                        <p className="gca-more">
                          +{selectedCommit.fileCount - selectedCommit.files.length} more not shown
                        </p>
                      )}
                    </section>
                  </div>
                ) : selectedFile ? (
                  <div className="gca-inspector-body">
                    <div className="gca-inspector-title">
                      <div className="gca-inspector-icon gca-severity-info">
                        <FileCode2 size={20} />
                      </div>
                      <div>
                        <span className="gca-kind-badge">{selectedFile.status}</span>
                        <h3>{selectedFile.path}</h3>
                      </div>
                    </div>

                    <div className="gca-detail-grid">
                      <div>
                        <span>Status</span>
                        <strong>{selectedFile.status}</strong>
                      </div>
                      <div>
                        <span>Kind</span>
                        <strong>{KIND_LABEL[selectedFile.kind]}</strong>
                      </div>
                      <div>
                        <span>Added</span>
                        <strong>+{selectedFile.additions}</strong>
                      </div>
                      <div>
                        <span>Removed</span>
                        <strong>−{selectedFile.deletions}</strong>
                      </div>
                    </div>

                    {(() => {
                      const hot = hotspotByFile.get(selectedFile.path);
                      const found = findingsByFile.get(selectedFile.path) ?? [];
                      const missing = report.companions.filter(
                        (item) => item.changedFile === selectedFile.path
                      );

                      return (
                        <>
                          {found.length > 0 && (
                            <section className="gca-box">
                              <h4>Problems in the added lines</h4>
                              <ul className="gca-flags">
                                {found.map((finding) => (
                                  <li key={finding.id}>
                                    <AlertTriangle size={13} />
                                    <span>
                                      <strong>{RULE_LABEL[finding.rule]}</strong>
                                      {finding.line ? ` line ${finding.line}` : ""}:{" "}
                                      {finding.message}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </section>
                          )}

                          {hot && (
                            <section className="gca-box">
                              <h4>Frequently changed file</h4>
                              <ul className="gca-flags">
                                {hot.reasons.map((reason) => (
                                  <li key={reason}>
                                    <Flame size={13} />
                                    {reason}
                                  </li>
                                ))}
                              </ul>
                            </section>
                          )}

                          {missing.length > 0 && (
                            <section className="gca-box">
                              <h4>Usually changes with</h4>
                              <ul className="gca-files">
                                {missing.map((item) => (
                                  <li key={item.partner}>
                                    <span title={item.partner}>{item.partner}</span>
                                    <em className="gca-hash">{item.count}x together</em>
                                  </li>
                                ))}
                              </ul>
                              <p className="gca-more">Not part of this change.</p>
                            </section>
                          )}

                          {found.length === 0 && !hot && missing.length === 0 && (
                            <section className="gca-box">
                              <h4>Review</h4>
                              <p>Nothing unusual found for this file.</p>
                            </section>
                          )}
                        </>
                      );
                    })()}
                  </div>
                ) : selectedHotspot ? (
                  <div className="gca-inspector-body">
                    <div className="gca-inspector-title">
                      <div className={`gca-inspector-icon gca-severity-${selectedHotspot.risk}`}>
                        <Flame size={20} />
                      </div>
                      <div>
                        <span className={`gca-badge gca-badge-${selectedHotspot.risk}`}>
                          {selectedHotspot.risk}
                        </span>
                        <h3>{selectedHotspot.filePath}</h3>
                      </div>
                    </div>

                    <div className="gca-detail-grid">
                      <div>
                        <span>Commits</span>
                        <strong>{selectedHotspot.commits}</strong>
                      </div>
                      <div>
                        <span>Bug fixes</span>
                        <strong>{selectedHotspot.fixCommits}</strong>
                      </div>
                      <div>
                        <span>Authors</span>
                        <strong>{selectedHotspot.authors}</strong>
                      </div>
                      <div>
                        <span>Last changed</span>
                        <strong>{formatDate(selectedHotspot.lastChanged)}</strong>
                      </div>
                    </div>

                    <section className="gca-box">
                      <h4>Why it is a hotspot</h4>
                      <ul className="gca-flags">
                        {selectedHotspot.reasons.map((reason) => (
                          <li key={reason}>
                            <Flame size={13} />
                            {reason}
                          </li>
                        ))}
                      </ul>
                      {selectedHotspot.changedNow && (
                        <p className="gca-more">You are changing this file in the current work.</p>
                      )}
                    </section>

                    {selectedHotspot.partners.length > 0 && (
                      <section className="gca-box">
                        <h4>Usually changes together with</h4>
                        <ul className="gca-files">
                          {selectedHotspot.partners.map((partner) => (
                            <li key={partner.filePath}>
                              <span title={partner.filePath}>{partner.filePath}</span>
                              <em className="gca-hash">
                                {partner.count}x · {Math.round(partner.confidence * 100)}%
                              </em>
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}
                  </div>
                ) : selectedFinding ? (
                  <div className="gca-inspector-body">
                    <div className="gca-inspector-title">
                      <div className={`gca-inspector-icon gca-severity-${selectedFinding.severity}`}>
                        <ShieldAlert size={20} />
                      </div>
                      <div>
                        <span className={`gca-badge gca-badge-${selectedFinding.severity}`}>
                          {selectedFinding.severity}
                        </span>
                        <h3>{RULE_LABEL[selectedFinding.rule]}</h3>
                      </div>
                    </div>

                    <div className="gca-detail-grid">
                      <div>
                        <span>Severity</span>
                        <strong>{selectedFinding.severity}</strong>
                      </div>
                      <div>
                        <span>Rule</span>
                        <strong>{RULE_LABEL[selectedFinding.rule]}</strong>
                      </div>
                      <div>
                        <span>File</span>
                        <strong title={selectedFinding.filePath}>
                          {baseName(selectedFinding.filePath)}
                        </strong>
                      </div>
                      <div>
                        <span>Line</span>
                        <strong>{selectedFinding.line ?? "-"}</strong>
                      </div>
                    </div>

                    <section className="gca-box">
                      <h4>What was found</h4>
                      <p>{selectedFinding.message}</p>
                      <p className="gca-more">
                        {selectedFinding.filePath}
                        {selectedFinding.line ? `:${selectedFinding.line}` : ""}
                      </p>
                      {selectedFinding.snippet && (
                        <pre className="gca-snippet gca-mono">
                          <code>{selectedFinding.snippet}</code>
                        </pre>
                      )}
                    </section>

                    <section className="gca-box">
                      <h4>What to do</h4>
                      <p>{selectedFinding.suggestion}</p>
                    </section>
                  </div>
                ) : (
                  <div className="gca-inspector-empty">
                    <GitCommit size={38} />
                    <h3>Select an item</h3>
                    <p>Choose something from the list to see the details.</p>
                  </div>
                )}
              </aside>
            </section>
          )}

          <section className="gca-deliver">
            <h2>Pull request summary</h2>
            <p>
              A starting description generated from the analysis. Replace the
              placeholder in the title and add context before you share it.
            </p>

            <div className="gca-command">
              <pre>
                <code>{report.pullRequest.title}</code>
              </pre>
              <CopyButton value={report.pullRequest.title} label="Copy title" />
            </div>

            <pre className="gca-markdown">{report.pullRequest.markdown}</pre>

            <div className="gca-deliver-actions">
              <CopyButton value={report.pullRequest.markdown} label="Copy summary" />
            </div>
          </section>

          {report.commitMessage && (
            <section className="gca-deliver">
              <h2>Suggested commit message</h2>
              <p>
                Edit the type if it does not fit, and replace the placeholder with
                one line about the change.
              </p>

              <pre className="gca-markdown">
                {report.commitMessage.subject}
                {report.commitMessage.body ? `\n\n${report.commitMessage.body}` : ""}
              </pre>

              <div className="gca-deliver-actions">
                <CopyButton
                  value={`${report.commitMessage.subject}${
                    report.commitMessage.body ? `\n\n${report.commitMessage.body}` : ""
                  }`}
                  label="Copy message"
                />
              </div>
            </section>
          )}

          {report.splits.length > 0 && (
            <section className="gca-deliver">
              <h2>Split into smaller commits</h2>
              <p>
                These changes cover separate concerns. Small, focused commits are
                easier to review and to undo. Run each block in order.
              </p>

              {report.splits.map((split) => (
                <div className="gca-split" key={split.id}>
                  <div className="gca-split-head">
                    <strong>{split.label}</strong>
                    <span className="gca-kind-badge">{plural(split.files.length, "file")}</span>
                    <span className={`gca-confidence gca-confidence-${split.confidence}`}>
                      {split.confidence} confidence
                    </span>
                  </div>

                  <ul className="gca-pill-list">
                    {split.files.map((file) => (
                      <li key={file} title={file}>
                        {file}
                      </li>
                    ))}
                  </ul>

                  <div className="gca-deliver-actions">
                    <div className="gca-command">
                      <pre>
                        <code>{split.command}</code>
                      </pre>
                      <CopyButton value={split.command} label="Copy" />
                    </div>
                  </div>
                </div>
              ))}
            </section>
          )}

          {(report.coupling.length > 0 ||
            report.authors.length > 0 ||
            report.areas.length > 0) && (
            <section className="gca-insights">
              {report.coupling.length > 0 && (
                <div className="gca-insight">
                  <h2>Hidden coupling</h2>
                  <p>Files that keep changing in the same commits.</p>
                  <ul className="gca-rows">
                    {report.coupling.slice(0, 6).map((pair) => (
                      <li key={`${pair.a}-${pair.b}`}>
                        <span title={`${pair.a} and ${pair.b}`}>
                          {baseName(pair.a)} + {baseName(pair.b)}
                        </span>
                        <em>{Math.round(pair.confidence * 100)}%</em>
                        <strong>{pair.count}x</strong>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {report.authors.length > 0 && (
                <div className="gca-insight">
                  <h2>Contributors</h2>
                  <p>Who changed the most.</p>
                  <ul className="gca-rows">
                    {report.authors.slice(0, 6).map((author) => (
                      <li key={author.email}>
                        <span title={author.email}>{author.name}</span>
                        <em>
                          +{author.additions} −{author.deletions}
                        </em>
                        <strong>{author.commits}</strong>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {report.areas.length > 0 && (
                <div className="gca-insight">
                  <h2>Areas</h2>
                  <p>Where the changes landed.</p>
                  <ul className="gca-rows">
                    {report.areas.slice(0, 6).map((area) => (
                      <li key={area.area}>
                        <span title={area.area}>{area.area}</span>
                        <em>
                          +{area.additions} −{area.deletions}
                        </em>
                        <strong>{area.files}</strong>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {report.warnings.length > 0 && (
            <section className="gca-analysis-notes">
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
