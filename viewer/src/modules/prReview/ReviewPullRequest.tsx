import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  FileCode2,
  GitPullRequest,
  MinusCircle,
  Search,
  ShieldAlert,
  Users,
  XCircle,
} from "lucide-react";
import SecuritySelect from "../security/SecuritySelect";
import "./review-pull-request.css";

type Severity = "blocker" | "major" | "minor" | "nit";
type Strictness = "relaxed" | "normal" | "strict";
type Decision = "approve" | "approve-with-comments" | "request-changes";
type CheckStatus = "pass" | "warn" | "fail" | "skipped";
type SizeLabel = "XS" | "S" | "M" | "L" | "XL";

type CommentCategory =
  | "bug"
  | "security"
  | "performance"
  | "maintainability"
  | "testing"
  | "api"
  | "dependencies"
  | "history"
  | "docs";

type CommentSource = "static" | "git" | "api" | "tests" | "dependencies" | "pr";

interface ReviewComment {
  id: string;
  severity: Severity;
  category: CommentCategory;
  source: CommentSource;
  rule: string;
  title: string;
  message: string;
  suggestion?: string;
  filePath?: string;
  line?: number;
  snippet?: string;
}

interface ChecklistItem {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

interface ReviewedFile {
  path: string;
  status: "added" | "modified" | "deleted";
  kind: string;
  additions: number;
  deletions: number;
  comments: number;
}

interface PullRequestReview {
  success: boolean;
  tool: "review_pull_request";
  projectPath: string;
  strictness: Strictness;
  pr: {
    base: { ref: string; commit: string };
    head: { ref: string; commit: string };
    mergeBase: string;
    branch?: string;
    ahead: number;
    behind: number;
    mergeable: boolean | null;
    conflictFiles: string[];
    authors: string[];
    title: string;
    description: string;
    size: {
      label: SizeLabel;
      lines: number;
      files: number;
      additions: number;
      deletions: number;
    };
  };
  verdict: {
    decision: Decision;
    score: number;
    headline: string;
    reasons: string[];
  };
  counts: Record<Severity, number>;
  categoryCounts: Record<CommentCategory, number>;
  comments: ReviewComment[];
  checklist: ChecklistItem[];
  reviewers: {
    suggested: Array<{ name: string; email: string; commits: number }>;
    codeOwners: Array<{ owner: string; files: number; samples: string[] }>;
  };
  tests: {
    ran: boolean;
    impacted: number;
    total: number;
    gaps: number;
    commands: Array<{ label: string; command: string }>;
  };
  api: { ran: boolean; breaking: number; bump?: string };
  files: ReviewedFile[];
  commits: Array<{
    shortHash: string;
    subject: string;
    author: string;
    risk: string;
    flags: string[];
  }>;
  reviewMarkdown: string;
  sources: Array<{ name: string; status: "ran" | "skipped" | "failed"; detail: string }>;
  warnings: string[];
}

interface ReviewPullRequestProps {
  projectPath: string;
  onProjectPathChange?: (value: string) => void;
  apiUrl?: string;
}

type ViewMode = "comments" | "checklist" | "files";

const DEFAULT_API_URL = "http://127.0.0.1:4174/api/review-pull-request";

const REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.\-/@^~{}:]*$/;

const STRICTNESS_LABEL: Record<Strictness, string> = {
  relaxed: "Relaxed",
  normal: "Normal",
  strict: "Strict",
};

const DECISION_LABEL: Record<Decision, string> = {
  approve: "Approve",
  "approve-with-comments": "Approve with comments",
  "request-changes": "Request changes",
};

const VIEW_LABEL: Record<ViewMode, string> = {
  comments: "Comments",
  checklist: "Checklist",
  files: "Files",
};

const SEVERITY_LABEL: Record<Severity, string> = {
  blocker: "Blocker",
  major: "Major",
  minor: "Minor",
  nit: "Nit",
};

/** The shared stylesheet colours by risk level, so review severities map onto it. */
const SEVERITY_TONE: Record<Severity, string> = {
  blocker: "critical",
  major: "high",
  minor: "medium",
  nit: "low",
};

const CATEGORY_LABEL: Record<CommentCategory, string> = {
  bug: "Bug",
  security: "Security",
  performance: "Performance",
  maintainability: "Maintainability",
  testing: "Testing",
  api: "API",
  dependencies: "Dependencies",
  history: "History",
  docs: "Docs",
};

const SOURCE_LABEL: Record<CommentSource, string> = {
  static: "Line-by-line review",
  git: "Git change analysis",
  api: "Breaking API check",
  tests: "Test impact",
  dependencies: "Dependency review",
  pr: "Pull request check",
};

const CHECK_TONE: Record<CheckStatus, string> = {
  pass: "info",
  warn: "medium",
  fail: "critical",
  skipped: "info",
};

const RELATED_RULES: Record<string, (comment: ReviewComment) => boolean> = {
  merge: (comment) => comment.rule === "merge-conflict",
  secrets: (comment) => comment.rule === "secret" || comment.rule === "sensitive-file",
  security: (comment) => comment.category === "security" && comment.source === "static",
  debug: (comment) => ["debugger", "focused-test", "conflict-marker", "console-log"].includes(comment.rule),
  tests: (comment) => comment.category === "testing",
  api: (comment) => comment.source === "api",
  dependencies: (comment) => comment.category === "dependencies",
  complexity: (comment) => comment.rule === "function-size",
  history: (comment) => comment.rule === "commit-messages" || comment.rule === "merge-commits",
  size: (comment) => comment.rule === "pr-size",
  fresh: (comment) => comment.rule === "behind-base",
  docs: (comment) => comment.rule === "breaking-docs",
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

function whereOf(comment: ReviewComment): string {
  if (!comment.filePath) return "Whole pull request";
  return `${comment.filePath}${comment.line ? `:${comment.line}` : ""}`;
}

function CheckIcon({ status, size = 17 }: { status: CheckStatus; size?: number }) {
  if (status === "pass") return <CheckCircle2 size={size} />;
  if (status === "warn") return <AlertTriangle size={size} />;
  if (status === "fail") return <XCircle size={size} />;
  return <MinusCircle size={size} />;
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

export default function ReviewPullRequest({
  projectPath,
  onProjectPathChange,
  apiUrl = DEFAULT_API_URL,
}: ReviewPullRequestProps) {
  const [baseRef, setBaseRef] = useState("");
  const [headRef, setHeadRef] = useState("");
  const [strictness, setStrictness] = useState<Strictness>("normal");
  const [runBreakingApi, setRunBreakingApi] = useState(true);
  const [runTestImpact, setRunTestImpact] = useState(true);

  const [report, setReport] = useState<PullRequestReview | null>(null);
  const [view, setView] = useState<ViewMode>("comments");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [levelFilter, setLevelFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function analyze() {
    if (!projectPath.trim()) {
      setError("Enter a project path before starting the review.");
      return;
    }

    const base = baseRef.trim();
    const head = headRef.trim();

    for (const [label, value] of [
      ["Base branch", base],
      ["Compare branch", head],
    ] as const) {
      if (value && !REF_PATTERN.test(value)) {
        setError(
          `${label} must be a branch, tag or commit, for example main, feature/login or a commit hash.`
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
          baseRef: base || undefined,
          headRef: head || undefined,
          strictness,
          runTestImpact,
          runBreakingApi,
        }),
      });

      const data = await response.json();

      if (!response.ok || data.success === false) {
        throw new Error(data.error || "Pull request review failed.");
      }

      const next = data as PullRequestReview;

      setReport(next);
      setView("comments");
      setSelectedId(next.comments[0]?.id ?? null);
      setSearch("");
      setLevelFilter("all");
      setCategoryFilter("all");
    } catch (reviewError) {
      setError(
        reviewError instanceof Error ? reviewError.message : "Unable to review the pull request."
      );
    } finally {
      setLoading(false);
    }
  }

  function firstIdOf(next: ViewMode, source: PullRequestReview): string | null {
    if (next === "comments") return source.comments[0]?.id ?? null;
    if (next === "checklist") {
      return (
        source.checklist.find((item) => item.status === "fail")?.id ??
        source.checklist[0]?.id ??
        null
      );
    }
    return source.files[0]?.path ?? null;
  }

  function switchView(next: ViewMode) {
    if (!report) return;
    setView(next);
    setLevelFilter("all");
    setCategoryFilter("all");
    setSearch("");
    setSelectedId(firstIdOf(next, report));
  }

  function openComment(comment: ReviewComment) {
    setView("comments");
    setLevelFilter("all");
    setCategoryFilter("all");
    setSearch("");
    setSelectedId(comment.id);
  }

  const query = search.trim().toLowerCase();

  const visibleComments = useMemo(() => {
    if (!report) return [];

    return report.comments.filter((comment) => {
      if (levelFilter !== "all" && comment.severity !== levelFilter) return false;
      if (categoryFilter !== "all" && comment.category !== categoryFilter) return false;
      if (!query) return true;

      return [comment.title, comment.message, comment.filePath ?? "", comment.rule]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [report, query, levelFilter, categoryFilter]);

  const visibleChecks = useMemo(() => {
    if (!report) return [];

    // Problems first, so the checks that need attention are at the top.
    const order: Record<CheckStatus, number> = { fail: 0, warn: 1, skipped: 2, pass: 3 };

    return report.checklist
      .filter((item) => {
        if (levelFilter !== "all" && item.status !== levelFilter) return false;
        return !query || `${item.label} ${item.detail}`.toLowerCase().includes(query);
      })
      .map((item, index) => ({ item, index }))
      .sort((a, b) => order[a.item.status] - order[b.item.status] || a.index - b.index)
      .map(({ item }) => item);
  }, [report, query, levelFilter]);

  const visibleFiles = useMemo(() => {
    if (!report) return [];

    return report.files.filter((file) => {
      if (levelFilter === "commented" && file.comments === 0) return false;
      return !query || file.path.toLowerCase().includes(query);
    });
  }, [report, query, levelFilter]);

  const counts: Record<ViewMode, number> = {
    comments: visibleComments.length,
    checklist: visibleChecks.length,
    files: visibleFiles.length,
  };

  const selectedComment =
    view === "comments"
      ? (visibleComments.find((item) => item.id === selectedId) ?? visibleComments[0] ?? null)
      : null;
  const selectedCheck =
    view === "checklist"
      ? (visibleChecks.find((item) => item.id === selectedId) ?? visibleChecks[0] ?? null)
      : null;
  const selectedFile =
    view === "files"
      ? (visibleFiles.find((item) => item.path === selectedId) ?? visibleFiles[0] ?? null)
      : null;

  const checkTally = useMemo(() => {
    const tally = { pass: 0, warn: 0, fail: 0, skipped: 0 };
    for (const item of report?.checklist ?? []) tally[item.status]++;
    return tally;
  }, [report]);

  const reviewerCount =
    (report?.reviewers.codeOwners.length ?? 0) + (report?.reviewers.suggested.length ?? 0);

  const levelOptions =
    view === "comments"
      ? [
          { value: "all", label: "All severities" },
          ...(["blocker", "major", "minor", "nit"] as const).map((item) => ({
            value: item,
            label: SEVERITY_LABEL[item],
          })),
        ]
      : view === "checklist"
        ? [
            { value: "all", label: "All checks" },
            { value: "fail", label: "Failing" },
            { value: "warn", label: "Warnings" },
            { value: "pass", label: "Passing" },
            { value: "skipped", label: "Not checked" },
          ]
        : [
            { value: "all", label: "All files" },
            { value: "commented", label: "With comments" },
          ];

  const categoryOptions = [
    { value: "all", label: "All categories" },
    ...(Object.keys(CATEGORY_LABEL) as CommentCategory[])
      .filter((item) => (report?.categoryCounts[item] ?? 0) > 0)
      .map((item) => ({
        value: item,
        label: `${CATEGORY_LABEL[item]} (${report?.categoryCounts[item]})`,
      })),
  ];

  return (
    <div className="prr-analyzer">
      <div className="prr-title-row">
        <div className="prr-title-icon">
          <GitPullRequest size={24} />
        </div>

        <div>
          <h1>PR Review</h1>
          <p>
            Review a branch against its base like a careful teammate: a verdict,
            line-level comments with fixes, a checklist, suggested reviewers and
            a summary you can paste into the pull request.
          </p>
        </div>
      </div>

      <section className="prr-input-card">
        <div className="prr-field prr-field-wide">
          <label htmlFor="prr-project-path">Project path</label>
          <input
            id="prr-project-path"
            value={projectPath}
            onChange={(event) => onProjectPathChange?.(event.target.value)}
            placeholder="/path/to/your/project"
          />
        </div>

        <div className="prr-field">
          <label htmlFor="prr-base-ref">Base branch (optional)</label>
          <input
            id="prr-base-ref"
            value={baseRef}
            onChange={(event) => setBaseRef(event.target.value)}
            placeholder="main (detected if empty)"
          />
        </div>

        <button
          type="button"
          className="prr-analyze-button"
          onClick={analyze}
          disabled={loading}
        >
          {loading ? (
            <>
              <span className="prr-spinner" />
              Reviewing...
            </>
          ) : (
            <>
              <GitPullRequest size={17} />
              Review Pull Request
            </>
          )}
        </button>

        <div className="prr-options">
          <div className="prr-field">
            <label htmlFor="prr-head-ref">Compare branch (optional)</label>
            <input
              id="prr-head-ref"
              value={headRef}
              onChange={(event) => setHeadRef(event.target.value)}
              placeholder="Current branch"
            />
          </div>

          <div className="prr-field">
            <span className="prr-field-label">How strict</span>
            <SecuritySelect
              ariaLabel="How strict"
              value={strictness}
              onChange={setStrictness}
              options={(Object.keys(STRICTNESS_LABEL) as Strictness[]).map((item) => ({
                value: item,
                label: STRICTNESS_LABEL[item],
              }))}
            />
          </div>
        </div>

        <div className="prr-options prr-options-secondary">
          <label className="prr-check">
            <input
              type="checkbox"
              checked={runBreakingApi}
              onChange={(event) => setRunBreakingApi(event.target.checked)}
            />
            Check for breaking API changes
          </label>

          <label className="prr-check">
            <input
              type="checkbox"
              checked={runTestImpact}
              onChange={(event) => setRunTestImpact(event.target.checked)}
            />
            Check test coverage (branch must be checked out)
          </label>
        </div>
      </section>

      {error && (
        <div className="prr-error" role="alert">
          <XCircle size={18} />
          {error}
        </div>
      )}

      {report && (
        <>
          <div className="prr-status-row">
            <div
              className={`prr-success ${
                report.verdict.decision === "approve" ? "" : "has-groups"
              }`}
            >
              {report.verdict.decision === "approve" ? (
                <CheckCircle2 size={18} />
              ) : report.verdict.decision === "request-changes" ? (
                <XCircle size={18} />
              ) : (
                <AlertTriangle size={18} />
              )}
              <strong>{DECISION_LABEL[report.verdict.decision]}</strong>
              <span>{report.verdict.headline}</span>
            </div>

            <div className="prr-status-right">
              <span className={`prr-verdict ${report.verdict.decision}`}>
                {report.verdict.score}/100 readiness
              </span>
              <span className="prr-scope">
                {report.pr.base.ref} ← {report.pr.branch ?? report.pr.head.ref} ·{" "}
                {plural(report.pr.ahead, "commit")} · size {report.pr.size.label}
              </span>
            </div>
          </div>

          {(report.verdict.reasons.length > 0 || report.pr.mergeable === false) && (
            <section className="prr-runall" role="alert">
              <AlertTriangle size={18} />
              <div>
                <h3>
                  {report.verdict.decision === "request-changes"
                    ? "What needs to change"
                    : "Worth a look"}
                </h3>
                <ul className="prr-reasons">
                  {report.verdict.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          <div className="prr-summary-grid">
            <button
              type="button"
              className={`prr-summary-card prr-tone-a ${view === "comments" ? "active" : ""}`}
              onClick={() => switchView("comments")}
              aria-pressed={view === "comments"}
            >
              <div className="prr-summary-icon">
                <ShieldAlert size={17} />
              </div>
              <div>
                <strong>{report.comments.length}</strong>
                <span>Review comments</span>
                <span className="prr-summary-sub">
                  {report.counts.blocker} blocker · {report.counts.major} major ·{" "}
                  {report.counts.minor} minor
                </span>
              </div>
            </button>

            <button
              type="button"
              className={`prr-summary-card prr-tone-b ${view === "checklist" ? "active" : ""}`}
              onClick={() => switchView("checklist")}
              aria-pressed={view === "checklist"}
            >
              <div className="prr-summary-icon">
                <CheckCircle2 size={17} />
              </div>
              <div>
                <strong>
                  {checkTally.pass} of {report.checklist.length}
                </strong>
                <span>Checks passing</span>
                <span className="prr-summary-sub">
                  {checkTally.fail} failing · {checkTally.warn} warnings
                </span>
              </div>
            </button>

            <button
              type="button"
              className={`prr-summary-card prr-tone-a ${view === "files" ? "active" : ""}`}
              onClick={() => switchView("files")}
              aria-pressed={view === "files"}
            >
              <div className="prr-summary-icon">
                <FileCode2 size={17} />
              </div>
              <div>
                <strong>{report.pr.size.files}</strong>
                <span>Files changed</span>
                <span className="prr-summary-sub">
                  +{report.pr.size.additions} / −{report.pr.size.deletions} lines
                </span>
              </div>
            </button>

            <div className="prr-summary-card static">
              <div className="prr-summary-icon neutral">
                <Users size={17} />
              </div>
              <div>
                <strong>{reviewerCount}</strong>
                <span>Suggested reviewers</span>
                <span className="prr-summary-sub">
                  {[
                    ...report.reviewers.codeOwners.map((group) => group.owner),
                    ...report.reviewers.suggested.map((person) => person.name),
                  ]
                    .slice(0, 2)
                    .join(", ") || "None found"}
                </span>
              </div>
            </div>
          </div>

          <section className="prr-workspace">
            <div className="prr-groups-panel">
              <div className="prr-panel-header">
                <div>
                  <h2>{VIEW_LABEL[view]}</h2>
                  <p>
                    {counts[view]} of{" "}
                    {view === "comments"
                      ? report.comments.length
                      : view === "checklist"
                        ? report.checklist.length
                        : report.files.length}{" "}
                    items
                  </p>
                </div>

                <div className="prr-count-pill">{counts[view]}</div>
              </div>

              <div className="prr-filters">
                <div className="prr-search">
                  <Search size={17} />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search..."
                    aria-label="Search"
                  />
                </div>

                <div className="prr-filter-row">
                  <div className="prr-type-filter" role="group" aria-label="Choose a list">
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

                  <div className="prr-sort">
                    <SecuritySelect
                      ariaLabel="Filter"
                      value={levelFilter}
                      onChange={setLevelFilter}
                      options={levelOptions}
                    />
                  </div>

                  {view === "comments" && (
                    <div className="prr-sort">
                      <SecuritySelect
                        ariaLabel="Category"
                        value={categoryFilter}
                        onChange={setCategoryFilter}
                        options={categoryOptions}
                      />
                    </div>
                  )}
                </div>
              </div>

              <div className="prr-groups-list">
                {counts[view] === 0 ? (
                  <div className="prr-empty">
                    <GitPullRequest size={34} />
                    <h3>{report.comments.length === 0 && view === "comments" ? "No comments" : "Nothing here"}</h3>
                    <p>
                      {report.comments.length === 0 && view === "comments"
                        ? "The review found nothing to comment on."
                        : "No items match the current filters."}
                    </p>
                  </div>
                ) : view === "comments" ? (
                  visibleComments.map((comment) => (
                    <button
                      type="button"
                      key={comment.id}
                      className={`prr-group ${
                        selectedComment?.id === comment.id ? "selected" : ""
                      }`}
                      onClick={() => setSelectedId(comment.id)}
                    >
                      <div
                        className={`prr-group-icon prr-severity-${SEVERITY_TONE[comment.severity]}`}
                      >
                        <ShieldAlert size={17} />
                      </div>
                      <div className="prr-group-content">
                        <div className="prr-group-top">
                          <span
                            className={`prr-badge prr-badge-${SEVERITY_TONE[comment.severity]}`}
                          >
                            {SEVERITY_LABEL[comment.severity]}
                          </span>
                          <span className="prr-kind-badge">
                            {CATEGORY_LABEL[comment.category]}
                          </span>
                        </div>
                        <h3>{comment.title}</h3>
                        <p className="prr-places">{whereOf(comment)}</p>
                      </div>
                    </button>
                  ))
                ) : view === "checklist" ? (
                  visibleChecks.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      className={`prr-group ${selectedCheck?.id === item.id ? "selected" : ""}`}
                      onClick={() => setSelectedId(item.id)}
                    >
                      <div
                        className={`prr-group-icon prr-severity-${CHECK_TONE[item.status]} prr-check-${item.status}`}
                      >
                        <CheckIcon status={item.status} />
                      </div>
                      <div className="prr-group-content">
                        <div className="prr-group-top">
                          <span className={`prr-kind-badge prr-check-${item.status}`}>
                            {item.status === "skipped" ? "not checked" : item.status}
                          </span>
                        </div>
                        <h3>{item.label}</h3>
                        <p className="prr-places">{item.detail}</p>
                      </div>
                    </button>
                  ))
                ) : (
                  visibleFiles.map((file) => (
                    <button
                      type="button"
                      key={file.path}
                      className={`prr-group ${selectedFile?.path === file.path ? "selected" : ""}`}
                      onClick={() => setSelectedId(file.path)}
                    >
                      <div
                        className={`prr-group-icon prr-severity-${file.comments > 0 ? "high" : "info"}`}
                      >
                        <FileCode2 size={17} />
                      </div>
                      <div className="prr-group-content">
                        <div className="prr-group-top">
                          <span className="prr-kind-badge">{file.status}</span>
                          <span className="prr-kind-badge">{file.kind}</span>
                          {file.comments > 0 && (
                            <span className="prr-badge prr-badge-high">
                              {plural(file.comments, "comment")}
                            </span>
                          )}
                        </div>
                        <h3>{baseName(file.path)}</h3>
                        <p className="prr-places">
                          {dirName(file.path)} · +{file.additions} −{file.deletions}
                        </p>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>

            <aside className="prr-inspector">
              <div className="prr-panel-header">
                <div>
                  <h2>Inspector</h2>
                  <p>What is wrong, why it matters and how to fix it</p>
                </div>
              </div>

              {selectedComment ? (
                <div className="prr-inspector-body">
                  <div className="prr-inspector-title">
                    <div
                      className={`prr-inspector-icon prr-severity-${SEVERITY_TONE[selectedComment.severity]}`}
                    >
                      <ShieldAlert size={20} />
                    </div>
                    <div>
                      <span
                        className={`prr-badge prr-badge-${SEVERITY_TONE[selectedComment.severity]}`}
                      >
                        {SEVERITY_LABEL[selectedComment.severity]}
                      </span>
                      <h3>{selectedComment.title}</h3>
                    </div>
                  </div>

                  <div className="prr-detail-grid">
                    <div>
                      <span>Severity</span>
                      <strong>{SEVERITY_LABEL[selectedComment.severity]}</strong>
                    </div>
                    <div>
                      <span>Category</span>
                      <strong>{CATEGORY_LABEL[selectedComment.category]}</strong>
                    </div>
                    <div>
                      <span>File</span>
                      <strong title={selectedComment.filePath}>
                        {selectedComment.filePath ? baseName(selectedComment.filePath) : "Whole PR"}
                      </strong>
                    </div>
                    <div>
                      <span>Line</span>
                      <strong>{selectedComment.line ?? "-"}</strong>
                    </div>
                  </div>

                  <section className="prr-box">
                    <h4>What is wrong</h4>
                    <p>{selectedComment.message}</p>
                    <p className="prr-more">{whereOf(selectedComment)}</p>
                    {selectedComment.snippet && (
                      <pre className="prr-snippet prr-mono">
                        <code>{selectedComment.snippet}</code>
                      </pre>
                    )}
                  </section>

                  {selectedComment.suggestion && (
                    <section className="prr-box">
                      <h4>Suggested fix</h4>
                      <p>{selectedComment.suggestion}</p>
                      <div className="prr-deliver-actions">
                        <CopyButton
                          value={`${selectedComment.title}\n${whereOf(selectedComment)}\n\n${selectedComment.message}\n\nFix: ${selectedComment.suggestion}`}
                          label="Copy as comment"
                        />
                      </div>
                    </section>
                  )}

                  <section className="prr-box">
                    <h4>Found by</h4>
                    <p>{SOURCE_LABEL[selectedComment.source]}</p>
                  </section>
                </div>
              ) : selectedCheck ? (
                <div className="prr-inspector-body">
                  <div className="prr-inspector-title">
                    <div
                      className={`prr-inspector-icon prr-severity-${CHECK_TONE[selectedCheck.status]} prr-check-${selectedCheck.status}`}
                    >
                      <CheckIcon status={selectedCheck.status} size={20} />
                    </div>
                    <div>
                      <span className={`prr-kind-badge prr-check-${selectedCheck.status}`}>
                        {selectedCheck.status === "skipped" ? "not checked" : selectedCheck.status}
                      </span>
                      <h3>{selectedCheck.label}</h3>
                    </div>
                  </div>

                  <section className="prr-box">
                    <h4>Result</h4>
                    <p>{selectedCheck.detail}</p>
                  </section>

                  {(() => {
                    const related = report.comments.filter(
                      RELATED_RULES[selectedCheck.id] ?? (() => false)
                    );

                    return related.length > 0 ? (
                      <section className="prr-box">
                        <h4>Related comments ({related.length})</h4>
                        <ul className="prr-link-list">
                          {related.slice(0, 8).map((comment) => (
                            <li key={comment.id}>
                              <button type="button" onClick={() => openComment(comment)}>
                                <span title={comment.title}>{comment.title}</span>
                                <span
                                  className={`prr-badge prr-badge-${SEVERITY_TONE[comment.severity]}`}
                                >
                                  {SEVERITY_LABEL[comment.severity]}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null;
                  })()}
                </div>
              ) : selectedFile ? (
                <div className="prr-inspector-body">
                  <div className="prr-inspector-title">
                    <div className="prr-inspector-icon prr-severity-info">
                      <FileCode2 size={20} />
                    </div>
                    <div>
                      <span className="prr-kind-badge">{selectedFile.status}</span>
                      <h3>{selectedFile.path}</h3>
                    </div>
                  </div>

                  <div className="prr-detail-grid">
                    <div>
                      <span>Status</span>
                      <strong>{selectedFile.status}</strong>
                    </div>
                    <div>
                      <span>Kind</span>
                      <strong>{selectedFile.kind}</strong>
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
                    const onFile = report.comments.filter(
                      (comment) => comment.filePath === selectedFile.path
                    );

                    return (
                      <section className="prr-box">
                        <h4>Comments on this file ({onFile.length})</h4>
                        {onFile.length === 0 ? (
                          <p>No review comments for this file.</p>
                        ) : (
                          <ul className="prr-link-list">
                            {onFile.map((comment) => (
                              <li key={comment.id}>
                                <button type="button" onClick={() => openComment(comment)}>
                                  <span title={comment.title}>
                                    {comment.line ? `Line ${comment.line}: ` : ""}
                                    {comment.title}
                                  </span>
                                  <span
                                    className={`prr-badge prr-badge-${SEVERITY_TONE[comment.severity]}`}
                                  >
                                    {SEVERITY_LABEL[comment.severity]}
                                  </span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </section>
                    );
                  })()}
                </div>
              ) : (
                <div className="prr-inspector-empty">
                  <GitPullRequest size={38} />
                  <h3>Select an item</h3>
                  <p>Choose something from the list to see the details.</p>
                </div>
              )}
            </aside>
          </section>

          <section className="prr-deliver">
            <h2>Review summary</h2>
            <p>
              The verdict, the comments that matter and the checklist, formatted
              for GitHub, GitLab or Bitbucket. Paste it as your review.
            </p>

            <pre className="prr-markdown">{report.reviewMarkdown}</pre>

            <div className="prr-deliver-actions">
              <CopyButton value={report.reviewMarkdown} label="Copy review" />
            </div>
          </section>

          <section className="prr-deliver">
            <h2>Pull request description</h2>
            <p>
              A starting description generated from the commits. Replace any
              placeholder in the title and add context before you share it.
            </p>

            <div className="prr-command">
              <pre>
                <code>{report.pr.title}</code>
              </pre>
              <CopyButton value={report.pr.title} label="Copy title" />
            </div>

            <pre className="prr-markdown">{report.pr.description}</pre>

            <div className="prr-deliver-actions">
              <CopyButton value={report.pr.description} label="Copy description" />
            </div>
          </section>

          {(reviewerCount > 0 || report.sources.length > 0) && (
            <section className="prr-insights">
              {reviewerCount > 0 && (
                <div className="prr-insight">
                  <h2>Who should review</h2>
                  <p>From CODEOWNERS and from who changed these files before.</p>
                  <ul className="prr-rows">
                    {report.reviewers.codeOwners.map((group) => (
                      <li key={group.owner}>
                        <span title={group.samples.join(", ")}>{group.owner}</span>
                        <em>owns {plural(group.files, "file")}</em>
                      </li>
                    ))}
                    {report.reviewers.suggested.map((person) => (
                      <li key={person.email}>
                        <span title={person.email}>{person.name}</span>
                        <em>{plural(person.commits, "recent commit")}</em>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="prr-insight">
                <h2>Pull request</h2>
                <p>Where this branch stands against its base.</p>
                <ul className="prr-rows">
                  <li>
                    <span>Ahead of {report.pr.base.ref}</span>
                    <strong>{report.pr.ahead}</strong>
                  </li>
                  <li>
                    <span>Behind {report.pr.base.ref}</span>
                    <strong>{report.pr.behind}</strong>
                  </li>
                  <li>
                    <span>Merges cleanly</span>
                    <strong>
                      {report.pr.mergeable === null ? "unknown" : report.pr.mergeable ? "yes" : "no"}
                    </strong>
                  </li>
                  <li>
                    <span>Size</span>
                    <strong>
                      {report.pr.size.label} · {report.pr.size.lines} lines
                    </strong>
                  </li>
                  {report.pr.authors.length > 0 && (
                    <li>
                      <span title={report.pr.authors.join(", ")}>Authors</span>
                      <em>{report.pr.authors.join(", ")}</em>
                    </li>
                  )}
                </ul>
              </div>

              <div className="prr-insight">
                <h2>What was checked</h2>
                <p>The analyses behind this review.</p>
                <ul className="prr-sources">
                  {report.sources.map((source) => (
                    <li className="prr-source-row" key={source.name}>
                      <strong>{source.name}</strong>
                      <span>
                        <span
                          className={`prr-status-text ${
                            source.status === "ran"
                              ? "prr-check-pass"
                              : source.status === "failed"
                                ? "prr-check-fail"
                                : "prr-check-skipped"
                          }`}
                        >
                          {source.status}
                        </span>
                        {" · "}
                        {source.detail}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          {report.warnings.length > 0 && (
            <section className="prr-analysis-notes">
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
