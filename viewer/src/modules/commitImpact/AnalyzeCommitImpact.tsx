import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  FileCode2,
  GitBranch,
  GitCommit,
  History,
  Network,
  Package,
  Search,
  ShieldAlert,
  Users,
  XCircle,
} from "lucide-react";
import SecuritySelect from "../security/SecuritySelect";
import "./analyze-commit-impact.css";

type Severity = "critical" | "high" | "medium" | "low" | "info";
type Mode = "commit" | "range" | "staged" | "working";
type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange";
type RiskLevel = "low" | "medium" | "high" | "critical";

type FileCategory =
  | "source"
  | "test"
  | "config"
  | "docs"
  | "style"
  | "asset"
  | "migration"
  | "dependency"
  | "lockfile"
  | "ci"
  | "generated"
  | "other";

type SymbolKind =
  | "function"
  | "component"
  | "class"
  | "method"
  | "variable"
  | "type"
  | "interface"
  | "enum"
  | "namespace";

type SymbolChangeKind = "added" | "removed" | "modified" | "signature" | "exported" | "unexported";

interface CommitInfo {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  author: string;
  date: string;
  parents: string[];
  isMerge: boolean;
  refs: string[];
}

interface SymbolChange {
  name: string;
  kind: SymbolKind;
  change: SymbolChangeKind;
  exported: boolean;
  exportNames: string[];
  before?: string;
  after?: string;
  line?: number;
}

interface Dependent {
  filePath: string;
  depth: number;
  via?: string;
  imports: string[];
  affectedSymbols: string[];
  usageLines: number[];
  isTest: boolean;
}

interface FileHistory {
  commits90d: number;
  fixes90d: number;
  authors: number;
  lastChanged?: string;
}

interface Risk {
  id: string;
  severity: Severity;
  title: string;
  description: string;
  filePath?: string;
  related?: string[];
}

interface FileImpact {
  filePath: string;
  oldPath?: string;
  status: ChangeStatus;
  category: FileCategory;
  language?: string;
  additions: number;
  deletions: number;
  binary: boolean;
  symbols: SymbolChange[];
  hiddenSymbols: number;
  formattingOnly: boolean;
  directDependents: number;
  transitiveDependents: number;
  dependents: Dependent[];
  hiddenDependents: number;
  affectedTests: string[];
  history: FileHistory;
  isEntryPoint: boolean;
  risks: Risk[];
  riskScore: number;
  severity: Severity;
}

interface ApiChange {
  filePath: string;
  name: string;
  change: SymbolChangeKind;
  kind: SymbolKind;
  before?: string;
  after?: string;
  dependentFiles: number;
}

interface RouteChange {
  filePath: string;
  route: string;
  change: "added" | "removed";
}

interface DependencyChange {
  manifest: string;
  name: string;
  section: string;
  change: "added" | "removed" | "changed";
  from?: string;
  to?: string;
  bump?: "major" | "minor" | "patch" | "downgrade" | "unknown";
  stillUsedBy?: string[];
}

interface ManifestChange {
  manifest: string;
  field: string;
  before?: string;
  after?: string;
}

interface Reviewer {
  name: string;
  commits: number;
  files: number;
  lastActive: string;
}

interface ChecklistItem {
  text: string;
  severity: Severity;
}

interface RecentCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}

interface CommitImpactReport {
  success: boolean;
  tool: "analyze_commit_impact";
  projectPath: string;
  repoRoot: string;
  mode: Mode;
  commit: CommitInfo;
  baseLabel: string;
  headLabel: string;
  rangeCommitCount: number;
  stats: { files: number; additions: number; deletions: number };
  files: FileImpact[];
  blastRadius: {
    directFiles: number;
    transitiveFiles: number;
    byDepth: number[];
    testFiles: number;
  };
  tests: { affected: string[]; changed: string[]; untestedSources: string[] };
  api: {
    removed: ApiChange[];
    changed: ApiChange[];
    added: ApiChange[];
    routes: RouteChange[];
  };
  dependencyChanges: DependencyChange[];
  manifestChanges: ManifestChange[];
  newEnvVars: string[];
  risks: Risk[];
  riskScore: number;
  riskLevel: RiskLevel;
  reviewers: Reviewer[];
  checklist: ChecklistItem[];
  recentCommits: RecentCommit[];
  categoryCounts: Record<FileCategory, number>;
  graph: { filesInGraph: number; unresolvedImports: number; languages: string[] };
  warnings: string[];
}

interface AnalyzeCommitImpactProps {
  projectPath: string;
  onProjectPathChange?: (value: string) => void;
  apiUrl?: string;
}

type TypeFilter = "all" | "source" | "test" | "other";
type FocusFilter = "all" | "impact" | "risks" | "untested";
type SortKey = "impact" | "risk" | "size" | "name";

const DEFAULT_API_URL = "http://127.0.0.1:4174/api/analyze-commit-impact";

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

const MODE_OPTIONS: Array<{ value: Mode; label: string }> = [
  { value: "commit", label: "A commit" },
  { value: "range", label: "A branch or range" },
  { value: "staged", label: "Staged changes" },
  { value: "working", label: "All uncommitted changes" },
];

const STATUS_LETTER: Record<ChangeStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
};

const STATUS_LABEL: Record<ChangeStatus, string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  typechange: "Type changed",
};

const CATEGORY_LABEL: Record<FileCategory, string> = {
  source: "source",
  test: "test",
  config: "config",
  docs: "docs",
  style: "style",
  asset: "asset",
  migration: "migration",
  dependency: "dependency",
  lockfile: "lockfile",
  ci: "CI",
  generated: "generated",
  other: "other",
};

const TYPE_FILTER_LABEL: Record<TypeFilter, string> = {
  all: "All",
  source: "Source",
  test: "Tests",
  other: "Config & other",
};

const FOCUS_NOTE: Record<Exclude<FocusFilter, "all">, string> = {
  impact: "that other files depend on",
  risks: "with critical or high risks",
  untested: "without a related test",
};

const SYMBOL_CHANGE_LABEL: Record<SymbolChangeKind, string> = {
  added: "added",
  removed: "removed",
  modified: "body changed",
  signature: "signature changed",
  exported: "now public",
  unexported: "now private",
};

const MODE_NOTE: Record<Mode, string> = {
  commit: "compared with its first parent",
  range: "compared with the merge base",
  staged: "staged in the index",
  working: "not yet committed",
};

function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

function splitPath(filePath: string): { dir: string; base: string } {
  const index = filePath.lastIndexOf("/");
  return index === -1
    ? { dir: "", base: filePath }
    : { dir: filePath.slice(0, index + 1), base: filePath.slice(index + 1) };
}

function relativeTime(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";

  const days = Math.floor((Date.now() - time) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

function toMarkdown(report: CommitImpactReport): string {
  const title =
    report.mode === "commit" || report.mode === "range"
      ? `${report.commit.shortHash} ${report.commit.subject}`
      : report.commit.subject;

  const lines = [
    `## Review checklist: ${title}`,
    "",
    `${plural(report.stats.files, "file")} changed, +${report.stats.additions} −${report.stats.deletions}. Risk ${report.riskScore}/100 (${report.riskLevel}).`,
    "",
    ...report.checklist.map((item) => `- [ ] ${item.text}`),
  ];

  if (report.reviewers.length > 0) {
    lines.push("", `Suggested reviewers: ${report.reviewers.map((item) => item.name).join(", ")}`);
  }

  return lines.join("\n");
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
    <button type="button" className="cm-copy" onClick={copy}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? "Copied" : label}
    </button>
  );
}

function PathText({ filePath }: { filePath: string }) {
  const { dir, base } = splitPath(filePath);

  return (
    <span className="cm-path" title={filePath}>
      <span className="cm-path-dir">{dir}</span>
      <span className="cm-path-base">{base}</span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  View                                                                      */
/* -------------------------------------------------------------------------- */

export default function AnalyzeCommitImpact({
  projectPath,
  onProjectPathChange,
  apiUrl = DEFAULT_API_URL,
}: AnalyzeCommitImpactProps) {
  const [mode, setMode] = useState<Mode>("commit");
  const [commitRef, setCommitRef] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [headRef, setHeadRef] = useState("");
  const [maxDepth, setMaxDepth] = useState("5");

  const [report, setReport] = useState<CommitImpactReport | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [focus, setFocus] = useState<FocusFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("impact");
  const [showAllRisks, setShowAllRisks] = useState(false);
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copyFailed, setCopyFailed] = useState(false);

  async function analyze(override?: { mode: Mode; commit: string }) {
    if (!projectPath.trim()) {
      setError("Enter a project path before starting the analysis.");
      return;
    }

    const depth = Number(maxDepth);

    if (!Number.isInteger(depth) || depth < 1 || depth > 8) {
      setError("Follow dependents must be a whole number between 1 and 8.");
      return;
    }

    const activeMode = override?.mode ?? mode;

    setLoading(true);
    setError("");

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: projectPath.trim(),
          mode: activeMode,
          commit: override ? override.commit : commitRef.trim() || undefined,
          base: baseRef.trim() || undefined,
          head: headRef.trim() || undefined,
          maxDepth: depth,
        }),
      });

      const data = await response.json();

      if (!response.ok || data.success === false) {
        throw new Error(data.error || "Commit analysis failed.");
      }

      const next = data as CommitImpactReport;
      setReport(next);
      setSelectedPath(next.files[0]?.filePath ?? null);
      setSearch("");
      setTypeFilter("all");
      setFocus("all");
      setSortKey("impact");
      setShowAllRisks(false);
      setChecked({});

      if (override) {
        setMode(override.mode);
        setCommitRef(override.commit);
      }
    } catch (analysisError) {
      setError(
        analysisError instanceof Error
          ? analysisError.message
          : "Unable to analyze the repository."
      );
    } finally {
      setLoading(false);
    }
  }

  const visibleFiles = useMemo(() => {
    if (!report) return [];

    const query = search.trim().toLowerCase();
    const untested = new Set(report.tests.untestedSources);

    const filtered = report.files.filter((file) => {
      if (typeFilter === "source" && file.category !== "source") return false;
      if (typeFilter === "test" && file.category !== "test") return false;
      if (typeFilter === "other" && (file.category === "source" || file.category === "test")) {
        return false;
      }

      if (focus === "impact" && file.transitiveDependents === 0) return false;
      if (focus === "risks" && file.severity !== "critical" && file.severity !== "high") {
        return false;
      }
      if (focus === "untested" && !untested.has(file.filePath)) return false;

      if (!query) return true;

      return [file.filePath, file.oldPath ?? "", CATEGORY_LABEL[file.category], ...file.symbols.map((item) => item.name)]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

    return [...filtered].sort((a, b) => {
      if (sortKey === "name") return a.filePath.localeCompare(b.filePath);
      if (sortKey === "size") {
        return b.additions + b.deletions - (a.additions + a.deletions);
      }
      if (sortKey === "risk") {
        return (
          SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
          b.riskScore - a.riskScore
        );
      }
      return (
        b.transitiveDependents - a.transitiveDependents ||
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
        a.filePath.localeCompare(b.filePath)
      );
    });
  }, [report, search, typeFilter, focus, sortKey]);

  const selected =
    visibleFiles.find((file) => file.filePath === selectedPath) ?? visibleFiles[0] ?? null;

  function toggleFocus(next: Exclude<FocusFilter, "all">) {
    setFocus(focus === next ? "all" : next);
  }

  function selectFile(filePath: string | undefined) {
    if (!filePath || !report) return;
    if (!report.files.some((file) => file.filePath === filePath)) return;

    setSearch("");
    setTypeFilter("all");
    setFocus("all");
    setSelectedPath(filePath);
  }

  const risksShown = report
    ? showAllRisks
      ? report.risks
      : report.risks.filter((risk) => risk.severity !== "info").slice(0, 6)
    : [];

  const hiddenRisks = report
    ? report.risks.filter((risk) => risk.severity !== "info").length - risksShown.length
    : 0;

  const infoRisks = report ? report.risks.filter((risk) => risk.severity === "info") : [];

  const severityCount = (severity: Severity) =>
    report ? report.risks.filter((risk) => risk.severity === severity).length : 0;

  const hasApi = report
    ? report.api.removed.length + report.api.changed.length + report.api.added.length > 0
    : false;

  return (
    <div className="cm-analyzer">
      <div className="cm-title-row">
        <div className="cm-title-icon">
          <GitCommit size={24} />
        </div>

        <div>
          <h1>Commit Impact Analyzer</h1>
          <p>
            See what a commit, a branch, or your uncommitted work really
            changes: which symbols moved, which files depend on them, which
            tests cover them, and what to check before it ships.
          </p>
        </div>
      </div>

      <section className="cm-input-card">
        <div className="cm-field cm-field-wide">
          <label htmlFor="cm-project-path">Project path</label>
          <input
            id="cm-project-path"
            value={projectPath}
            onChange={(event) => onProjectPathChange?.(event.target.value)}
            placeholder="/path/to/your/repository"
          />
        </div>

        <div className="cm-field">
          <span className="cm-field-label">Analyze</span>
          <SecuritySelect
            ariaLabel="What to analyze"
            value={mode}
            onChange={setMode}
            options={MODE_OPTIONS}
          />
        </div>

        <button
          type="button"
          className="cm-analyze-button"
          onClick={() => void analyze()}
          disabled={loading}
        >
          {loading ? (
            <>
              <span className="cm-spinner" />
              Analyzing...
            </>
          ) : (
            <>
              <GitCommit size={17} />
              Analyze Commit
            </>
          )}
        </button>

        <div className="cm-options">
          {mode === "commit" && (
            <div className="cm-field">
              <label htmlFor="cm-commit">Commit (optional)</label>
              <input
                id="cm-commit"
                value={commitRef}
                onChange={(event) => setCommitRef(event.target.value)}
                placeholder="HEAD, a hash, a branch, or a tag"
                spellCheck={false}
              />
            </div>
          )}

          {mode === "range" && (
            <>
              <div className="cm-field">
                <label htmlFor="cm-base">Base (optional)</label>
                <input
                  id="cm-base"
                  value={baseRef}
                  onChange={(event) => setBaseRef(event.target.value)}
                  placeholder="main or master"
                  spellCheck={false}
                />
              </div>
              <div className="cm-field">
                <label htmlFor="cm-head">Head (optional)</label>
                <input
                  id="cm-head"
                  value={headRef}
                  onChange={(event) => setHeadRef(event.target.value)}
                  placeholder="HEAD"
                  spellCheck={false}
                />
              </div>
            </>
          )}

          <div className="cm-field cm-field-small">
            <label htmlFor="cm-depth">Follow dependents (levels)</label>
            <input
              id="cm-depth"
              type="number"
              min={1}
              max={8}
              value={maxDepth}
              onChange={(event) => setMaxDepth(event.target.value)}
            />
          </div>
        </div>
      </section>

      {error && (
        <div className="cm-error" role="alert">
          <XCircle size={18} />
          {error}
        </div>
      )}

      {report && (
        <>
          <section className="cm-commit-card">
            <div className="cm-commit-main">
              <div className="cm-commit-top">
                <span className="cm-hash">
                  <GitCommit size={14} />
                  {report.commit.shortHash}
                </span>

                {report.commit.hash && (
                  <CopyButton
                    label="Copy hash"
                    value={report.commit.hash}
                    onFail={() => setCopyFailed(true)}
                  />
                )}

                {report.commit.refs.slice(0, 4).map((ref) => (
                  <span className="cm-ref" key={ref}>
                    <GitBranch size={11} />
                    {ref.replace("HEAD -> ", "")}
                  </span>
                ))}

                {report.commit.isMerge && <span className="cm-ref">merge</span>}
              </div>

              <h2>{report.commit.subject || "(no message)"}</h2>

              <p className="cm-commit-meta">
                {report.commit.author && <>{report.commit.author} · </>}
                {report.commit.date && relativeTime(report.commit.date)} ·{" "}
                {MODE_NOTE[report.mode]}
                {report.mode === "range" && ` · ${plural(report.rangeCommitCount, "commit")}`}
              </p>

              <p className="cm-compare">
                {report.baseLabel} <ArrowRight size={12} /> {report.headLabel}
              </p>

              {report.commit.body && <p className="cm-commit-body">{report.commit.body}</p>}
            </div>

            <div className={`cm-gauge cm-level-${report.riskLevel}`}>
              <span className="cm-gauge-label">Risk</span>
              <strong>{report.riskScore}</strong>
              <span className="cm-gauge-level">{report.riskLevel}</span>
              <div className="cm-gauge-bar" aria-hidden="true">
                <i style={{ width: `${Math.max(4, report.riskScore)}%` }} />
              </div>
            </div>
          </section>

          <div className="cm-summary-grid">
            <div className="cm-summary-card static">
              <div className="cm-summary-icon tone-total">
                <FileCode2 size={17} />
              </div>
              <div>
                <strong>{report.stats.files}</strong>
                <span>
                  Files changed · +{report.stats.additions} −{report.stats.deletions}
                </span>
              </div>
            </div>

            <button
              type="button"
              className={`cm-summary-card ${focus === "impact" ? "active" : ""}`}
              onClick={() => toggleFocus("impact")}
              aria-pressed={focus === "impact"}
            >
              <div className="cm-summary-icon tone-impact">
                <Network size={17} />
              </div>
              <div>
                <strong>{report.blastRadius.transitiveFiles}</strong>
                <span>
                  Files affected · {report.blastRadius.directFiles} direct ·{" "}
                  {plural(report.blastRadius.testFiles, "test")}
                </span>
              </div>
            </button>

            <button
              type="button"
              className={`cm-summary-card ${focus === "risks" ? "active" : ""}`}
              onClick={() => toggleFocus("risks")}
              aria-pressed={focus === "risks"}
            >
              <div className="cm-summary-icon tone-risk">
                <ShieldAlert size={17} />
              </div>
              <div>
                <strong>{severityCount("critical") + severityCount("high")}</strong>
                <span>
                  Critical and high risks · {severityCount("critical")} critical
                </span>
              </div>
            </button>

            <button
              type="button"
              className={`cm-summary-card ${focus === "untested" ? "active" : ""}`}
              onClick={() => toggleFocus("untested")}
              aria-pressed={focus === "untested"}
            >
              <div className="cm-summary-icon tone-tests">
                <CheckCircle2 size={17} />
              </div>
              <div>
                <strong>{report.tests.affected.length}</strong>
                <span>
                  Affected tests · {report.tests.untestedSources.length} files
                  without one
                </span>
              </div>
            </button>
          </div>

          <div className="cm-top-grid">
            <section className="cm-panel">
              <div className="cm-panel-header">
                <div>
                  <h2>Review checklist</h2>
                  <p>What to check before this ships</p>
                </div>

                <CopyButton
                  label="Copy as Markdown"
                  value={toMarkdown(report)}
                  onFail={() => setCopyFailed(true)}
                />
              </div>

              {report.checklist.length === 0 ? (
                <p className="cm-panel-empty">
                  Nothing in particular stands out. A quick read of the diff is
                  enough.
                </p>
              ) : (
                <ul className="cm-checklist">
                  {report.checklist.map((item, index) => (
                    <li key={index} className={checked[index] ? "done" : ""}>
                      <label>
                        <input
                          type="checkbox"
                          checked={!!checked[index]}
                          onChange={(event) =>
                            setChecked({ ...checked, [index]: event.target.checked })
                          }
                        />
                        <span className={`cm-dot cm-dot-${item.severity}`} />
                        <span>{item.text}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div className="cm-side-column">
              <section className="cm-panel">
                <div className="cm-panel-header">
                  <div>
                    <h2>Suggested reviewers</h2>
                    <p>Who changed these files before</p>
                  </div>
                  <Users size={17} />
                </div>

                {report.reviewers.length === 0 ? (
                  <p className="cm-panel-empty">No earlier history was found for these files.</p>
                ) : (
                  <ul className="cm-reviewers">
                    {report.reviewers.map((person) => (
                      <li key={person.name}>
                        <strong>{person.name}</strong>
                        <span>
                          {plural(person.commits, "commit")} · {plural(person.files, "file")} ·{" "}
                          {relativeTime(person.lastActive)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {report.recentCommits.length > 0 && (
                <section className="cm-panel">
                  <div className="cm-panel-header">
                    <div>
                      <h2>Recent commits</h2>
                      <p>Select one to analyze it</p>
                    </div>
                    <History size={17} />
                  </div>

                  <ul className="cm-recent">
                    {report.recentCommits.slice(0, 12).map((item) => (
                      <li key={item.hash}>
                        <button
                          type="button"
                          className={item.hash === report.commit.hash ? "current" : ""}
                          onClick={() => void analyze({ mode: "commit", commit: item.hash })}
                          disabled={loading}
                        >
                          <code>{item.shortHash}</code>
                          <span title={item.subject}>{item.subject}</span>
                          <em>{relativeTime(item.date)}</em>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </div>

          {report.risks.length > 0 && (
            <section className="cm-panel cm-risks">
              <div className="cm-panel-header">
                <div>
                  <h2>Risks</h2>
                  <p>
                    {plural(report.risks.filter((risk) => risk.severity !== "info").length, "finding")}
                    , most serious first
                  </p>
                </div>
                <div className="cm-count-pill">
                  <ShieldAlert size={15} />
                  {report.risks.filter((risk) => risk.severity !== "info").length}
                </div>
              </div>

              <ul className="cm-risk-list">
                {risksShown.map((risk) => (
                  <li key={risk.id}>
                    <div className="cm-risk-head">
                      <span className={`cm-badge cm-badge-${risk.severity}`}>{risk.severity}</span>
                      <strong>{risk.title}</strong>
                    </div>
                    <p>{risk.description}</p>
                    {risk.filePath && report.files.some((file) => file.filePath === risk.filePath) && (
                      <button
                        type="button"
                        className="cm-link"
                        onClick={() => selectFile(risk.filePath)}
                      >
                        <FileCode2 size={13} />
                        {risk.filePath}
                      </button>
                    )}
                  </li>
                ))}
              </ul>

              <div className="cm-risk-actions">
                {hiddenRisks > 0 && !showAllRisks && (
                  <button type="button" onClick={() => setShowAllRisks(true)}>
                    Show {hiddenRisks} more
                    {infoRisks.length > 0 ? ` and ${plural(infoRisks.length, "note")}` : ""}
                  </button>
                )}
                {!showAllRisks && hiddenRisks <= 0 && infoRisks.length > 0 && (
                  <button type="button" onClick={() => setShowAllRisks(true)}>
                    Show {plural(infoRisks.length, "note")}
                  </button>
                )}
                {showAllRisks && (
                  <button type="button" onClick={() => setShowAllRisks(false)}>
                    Show less
                  </button>
                )}
              </div>
            </section>
          )}

          <section className="cm-workspace">
            <div className="cm-groups-panel">
              <div className="cm-panel-header">
                <div>
                  <h2>Changed files</h2>
                  <p>
                    {visibleFiles.length} of {report.files.length} files
                    {focus !== "all" ? ` ${FOCUS_NOTE[focus]}` : ""}
                  </p>
                </div>

                <div className="cm-count-pill">
                  <FileCode2 size={15} />
                  {visibleFiles.length}
                </div>
              </div>

              <div className="cm-filters">
                <div className="cm-search">
                  <Search size={17} />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search by file or symbol..."
                    aria-label="Search changed files"
                  />
                </div>

                <div className="cm-filter-row">
                  <div className="cm-type-filter" role="group" aria-label="Filter by kind of file">
                    {(Object.keys(TYPE_FILTER_LABEL) as TypeFilter[]).map((option) => (
                      <button
                        type="button"
                        key={option}
                        className={typeFilter === option ? "active" : ""}
                        aria-pressed={typeFilter === option}
                        onClick={() => setTypeFilter(option)}
                      >
                        {TYPE_FILTER_LABEL[option]}
                      </button>
                    ))}
                  </div>

                  <div className="cm-sort">
                    <SecuritySelect
                      ariaLabel="Sort changed files"
                      value={sortKey}
                      onChange={setSortKey}
                      options={[
                        { value: "impact", label: "Sort: impact" },
                        { value: "risk", label: "Sort: risk" },
                        { value: "size", label: "Sort: lines changed" },
                        { value: "name", label: "Sort: name" },
                      ]}
                    />
                  </div>
                </div>
              </div>

              <div className="cm-groups-list">
                {visibleFiles.length === 0 ? (
                  <div className="cm-empty">
                    <FileCode2 size={34} />
                    <h3>No matching files</h3>
                    <p>No changed files match the current filters.</p>
                  </div>
                ) : (
                  visibleFiles.map((file) => (
                    <button
                      type="button"
                      key={file.filePath}
                      className={`cm-group ${selected?.filePath === file.filePath ? "selected" : ""}`}
                      onClick={() => setSelectedPath(file.filePath)}
                    >
                      <div className={`cm-group-icon cm-status cm-status-${file.status}`}>
                        {STATUS_LETTER[file.status]}
                      </div>

                      <div className="cm-group-content">
                        <div className="cm-group-top">
                          {file.severity !== "info" && (
                            <span className={`cm-badge cm-badge-${file.severity}`}>
                              {file.severity}
                            </span>
                          )}
                          <span className="cm-kind-badge">{CATEGORY_LABEL[file.category]}</span>
                          {file.isEntryPoint && <span className="cm-kind-badge cm-api-badge">public API</span>}
                          {file.formattingOnly && <span className="cm-kind-badge">formatting only</span>}
                        </div>

                        <h3>
                          <PathText filePath={file.filePath} />
                        </h3>

                        <p className="cm-places">
                          <span className="cm-add">+{file.additions}</span>{" "}
                          <span className="cm-del">−{file.deletions}</span>
                          {file.transitiveDependents > 0 &&
                            ` · ${plural(file.transitiveDependents, "dependent")}`}
                          {file.symbols.length > 0 &&
                            ` · ${plural(file.symbols.length + file.hiddenSymbols, "symbol")}`}
                        </p>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>

            <aside className="cm-inspector">
              <div className="cm-panel-header">
                <div>
                  <h2>Inspector</h2>
                  <p>What changed in this file and what depends on it</p>
                </div>
              </div>

              {selected ? (
                <div className="cm-inspector-body">
                  <div className="cm-inspector-title">
                    <div className={`cm-inspector-icon cm-status cm-status-${selected.status}`}>
                      {STATUS_LETTER[selected.status]}
                    </div>

                    <div>
                      {selected.severity !== "info" && (
                        <span className={`cm-badge cm-badge-${selected.severity}`}>
                          {selected.severity}
                        </span>
                      )}
                      <h3>
                        <PathText filePath={selected.filePath} />
                      </h3>
                      {selected.oldPath && (
                        <p className="cm-renamed">
                          from <code>{selected.oldPath}</code>
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="cm-detail-grid">
                    <div>
                      <span>Change</span>
                      <strong>{STATUS_LABEL[selected.status]}</strong>
                      <em>
                        +{selected.additions} −{selected.deletions} ·{" "}
                        {CATEGORY_LABEL[selected.category]}
                        {selected.language ? ` · ${selected.language}` : ""}
                      </em>
                    </div>
                    <div>
                      <span>Files that depend on it</span>
                      <strong>{selected.transitiveDependents}</strong>
                      <em>{selected.directDependents} import it directly</em>
                    </div>
                    <div>
                      <span>Related tests</span>
                      <strong>{selected.affectedTests.length}</strong>
                      <em>
                        {selected.affectedTests.length === 0 && selected.category === "source"
                          ? "none found"
                          : "import it or share its name"}
                      </em>
                    </div>
                    <div>
                      <span>Recent history</span>
                      <strong>{plural(selected.history.commits90d, "commit")}</strong>
                      <em>
                        {selected.history.fixes90d > 0
                          ? `${plural(selected.history.fixes90d, "fix", "fixes")} in 90 days`
                          : "in the last 90 days"}
                      </em>
                    </div>
                  </div>

                  {selected.risks.length > 0 && (
                    <>
                      <h4 className="cm-section-title">Risks in this file ({selected.risks.length})</h4>
                      {selected.risks.map((risk) => (
                        <section className="cm-box cm-risk-box" key={risk.id}>
                          <div className="cm-risk-head">
                            <span className={`cm-badge cm-badge-${risk.severity}`}>{risk.severity}</span>
                            <strong>{risk.title}</strong>
                          </div>
                          <p>{risk.description}</p>
                        </section>
                      ))}
                    </>
                  )}

                  {selected.symbols.length > 0 && (
                    <section className="cm-box">
                      <h4>
                        Changed symbols ({selected.symbols.length + selected.hiddenSymbols})
                      </h4>

                      <ul className="cm-symbols">
                        {selected.symbols.map((symbol, index) => (
                          <li key={`${symbol.name}-${symbol.change}-${index}`}>
                            <div className="cm-symbol-head">
                              <span className={`cm-symbol-change cm-change-${symbol.change}`}>
                                {SYMBOL_CHANGE_LABEL[symbol.change]}
                              </span>
                              <code className="cm-symbol-name">{symbol.name}</code>
                              <span className="cm-symbol-kind">
                                {symbol.kind}
                                {symbol.exported ? " · public" : ""}
                              </span>
                            </div>

                            {(symbol.before || symbol.after) && symbol.change !== "modified" && (
                              <pre className="cm-signature">
                                {symbol.before ? `− ${symbol.name}${symbol.before}` : ""}
                                {symbol.before && symbol.after ? "\n" : ""}
                                {symbol.after ? `+ ${symbol.name}${symbol.after}` : ""}
                              </pre>
                            )}
                          </li>
                        ))}

                        {selected.hiddenSymbols > 0 && (
                          <li className="cm-more">+{selected.hiddenSymbols} more not shown</li>
                        )}
                      </ul>
                    </section>
                  )}

                  <section className="cm-box">
                    <h4>
                      What depends on it ({selected.transitiveDependents})
                    </h4>

                    {selected.dependents.length === 0 ? (
                      <p>
                        {selected.status === "deleted"
                          ? "The file no longer exists, so nothing can import it. Files that still did are listed under Risks."
                          : selected.category === "source"
                            ? "No file in the dependency graph imports it."
                            : "Dependencies are only traced for JavaScript and TypeScript source files."}
                      </p>
                    ) : (
                      <ul className="cm-dependents">
                        {selected.dependents.map((dependent) => (
                          <li key={dependent.filePath}>
                            <div className="cm-dependent-head">
                              <span className="cm-depth" title={`${dependent.depth} level${dependent.depth === 1 ? "" : "s"} away`}>
                                {dependent.depth}
                              </span>
                              <PathText filePath={dependent.filePath} />
                              {dependent.isTest && <span className="cm-kind-badge">test</span>}
                            </div>

                            <p className="cm-dependent-meta">
                              {dependent.depth === 1
                                ? dependent.imports.length > 0
                                  ? `imports ${dependent.imports.join(", ")}`
                                  : "imports the module"
                                : `through ${dependent.via ?? "another file"}`}
                              {dependent.affectedSymbols.length > 0 && (
                                <>
                                  {" · "}
                                  <strong>uses changed: {dependent.affectedSymbols.join(", ")}</strong>
                                </>
                              )}
                              {dependent.usageLines.length > 0 &&
                                ` · lines ${dependent.usageLines.join(", ")}`}
                            </p>
                          </li>
                        ))}

                        {selected.hiddenDependents > 0 && (
                          <li className="cm-more">+{selected.hiddenDependents} more not shown</li>
                        )}
                      </ul>
                    )}
                  </section>

                  {selected.affectedTests.length > 0 && (
                    <section className="cm-box">
                      <h4>Tests to run ({selected.affectedTests.length})</h4>
                      <ul className="cm-test-list">
                        {selected.affectedTests.map((test) => (
                          <li key={test}>
                            <CheckCircle2 size={13} />
                            <PathText filePath={test} />
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  {(selected.history.commits90d > 0 || selected.history.authors > 0) && (
                    <section className="cm-box">
                      <h4>History</h4>
                      <p>
                        {plural(selected.history.commits90d, "commit")} touched this file in the
                        90 days before this change
                        {selected.history.fixes90d > 0
                          ? `, ${selected.history.fixes90d} of them look like bug fixes`
                          : ""}
                        . {plural(selected.history.authors, "person", "people")} changed it in the
                        last year
                        {selected.history.lastChanged
                          ? `, most recently ${relativeTime(selected.history.lastChanged)}`
                          : ""}
                        .
                      </p>
                    </section>
                  )}
                </div>
              ) : (
                <div className="cm-inspector-empty">
                  <FileCode2 size={38} />
                  <h3>Select a file</h3>
                  <p>
                    Choose a changed file to see which symbols changed, what
                    depends on them, and which tests to run.
                  </p>
                </div>
              )}
            </aside>
          </section>

          {(hasApi ||
            report.api.routes.length > 0 ||
            report.dependencyChanges.length > 0 ||
            report.manifestChanges.length > 0 ||
            report.newEnvVars.length > 0) && (
            <section className="cm-panel cm-changes">
              <div className="cm-panel-header">
                <div>
                  <h2>API, dependency and environment changes</h2>
                  <p>Things other code, other teams, or other environments rely on</p>
                </div>
                <Package size={17} />
              </div>

              <div className="cm-changes-grid">
                {hasApi && (
                  <div className="cm-change-block">
                    <h4>Public API</h4>
                    <ul>
                      {[...report.api.removed, ...report.api.changed, ...report.api.added]
                        .slice(0, 14)
                        .map((item, index) => (
                          <li key={`${item.filePath}-${item.name}-${item.change}-${index}`}>
                            <span className={`cm-symbol-change cm-change-${item.change}`}>
                              {SYMBOL_CHANGE_LABEL[item.change]}
                            </span>
                            <code>{item.name}</code>
                            <em title={item.filePath}>
                              {splitPath(item.filePath).base}
                              {item.dependentFiles > 0 ? ` · ${plural(item.dependentFiles, "user")}` : ""}
                            </em>
                          </li>
                        ))}
                    </ul>
                  </div>
                )}

                {report.api.routes.length > 0 && (
                  <div className="cm-change-block">
                    <h4>HTTP routes</h4>
                    <ul>
                      {report.api.routes.slice(0, 14).map((item, index) => (
                        <li key={`${item.route}-${item.change}-${index}`}>
                          <span className={`cm-symbol-change cm-change-${item.change}`}>{item.change}</span>
                          <code>{item.route}</code>
                          <em title={item.filePath}>{splitPath(item.filePath).base}</em>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {report.dependencyChanges.length > 0 && (
                  <div className="cm-change-block">
                    <h4>Dependencies</h4>
                    <ul>
                      {report.dependencyChanges.slice(0, 14).map((item, index) => (
                        <li key={`${item.name}-${item.section}-${index}`}>
                          <span
                            className={`cm-symbol-change cm-change-${
                              item.change === "removed" ? "removed" : item.change === "added" ? "added" : item.bump === "major" ? "signature" : "modified"
                            }`}
                          >
                            {item.change === "changed" ? item.bump ?? "changed" : item.change}
                          </span>
                          <code>{item.name}</code>
                          <em>
                            {item.change === "changed"
                              ? `${item.from} → ${item.to}`
                              : item.change === "added"
                                ? item.to
                                : item.from}
                            {item.stillUsedBy ? " · still imported" : ""}
                          </em>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {report.manifestChanges.length > 0 && (
                  <div className="cm-change-block">
                    <h4>package.json fields</h4>
                    <ul>
                      {report.manifestChanges.slice(0, 14).map((item, index) => (
                        <li key={`${item.field}-${index}`}>
                          <code>{item.field}</code>
                          <em title={`${item.before ?? ""} → ${item.after ?? ""}`}>
                            {item.before ?? "(unset)"} → {item.after ?? "(unset)"}
                          </em>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {report.newEnvVars.length > 0 && (
                  <div className="cm-change-block">
                    <h4>New environment variables</h4>
                    <div className="cm-chips">
                      {report.newEnvVars.map((name) => (
                        <code key={name} className="cm-chip">
                          {name}
                        </code>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {copyFailed && (
            <p className="cm-fine-print">
              The browser blocked clipboard access. Select the text and copy it manually.
            </p>
          )}

          {report.warnings.length > 0 && (
            <section className="cm-analysis-notes">
              <AlertTriangle size={18} />
              <div>
                <h3>Analysis notes</h3>
                {report.warnings.map((warning, index) => (
                  <p key={`${index}-${warning}`}>• {warning}</p>
                ))}
                {report.graph.unresolvedImports > 0 && (
                  <p>
                    • {plural(report.graph.unresolvedImports, "import")} in the project could not be resolved to a file. Some of
                    them may be the ones this change broke.
                  </p>
                )}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
