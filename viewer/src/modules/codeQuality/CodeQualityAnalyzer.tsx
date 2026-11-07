import { useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileCode2,
  Gauge,
  Info,
  Layers3,
  Lightbulb,
  List,
  Search,
  ShieldAlert,
  Sparkles,
  Activity,
  Clipboard,
  Check,
} from "lucide-react";
import "./code-quality.css";

type Severity = "info" | "low" | "medium" | "high" | "critical";
type Grade = "A" | "B" | "C" | "D" | "F";

type Issue = {
  id: string;
  severity: Severity;
  kind: string;
  title: string;
  message: string;
  suggestion: string;
  filePath: string;
  symbol?: string;
  startLine: number;
  endLine: number;
  metric?: number;
  priority: "now" | "soon" | "later";
  whyItMatters: string;
  fixSteps: string[];
  confidence: "high" | "medium" | "low";
};

type MetricRecord = Record<string, unknown>;

type Report = {
  success: boolean;
  projectPath: string;
  target: {
    filePath?: string;
    symbol?: string;
  };
  summary: {
    score: number;
    grade: Grade;
    issueCount: number;
    highSeverityCount: number;
    complexity: number;
    maxNestingDepth: number;
    lines: number;
    functions: number;
    parameters: number;
    callCount: number;
    reactSignals: number;
    asyncOperations: number;
  };
  issues: Issue[];
  metrics: MetricRecord[];
  suggestions: string[];
  warnings: string[];
  error?: string;
};

type CodeQualityAnalyzerProps = {
  projectPath: string;
  apiUrl?: string;
  defaultFilePath?: string;
  defaultSymbol?: string;
};

type Tab = "overview" | "issues" | "metrics" | "suggestions";

type SeverityCounts = Record<Severity, number>;

const severityOrder: Severity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
];

export default function CodeQualityAnalyzer({
  projectPath,
  apiUrl = "http://127.0.0.1:4174/api/analyze-code-quality",
  defaultFilePath = "viewer/src/App.tsx",
  defaultSymbol = "generateGraph",
}: CodeQualityAnalyzerProps) {
  const [filePath, setFilePath] = useState(defaultFilePath);
  const [symbol, setSymbol] = useState(defaultSymbol);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  async function analyze(): Promise<void> {
    setLoading(true);
    setError("");
    setSelectedIssue(null);

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectPath: projectPath.trim(),
          filePath: filePath.trim() || undefined,
          symbol: symbol.trim() || undefined,
        }),
      });

      const data = (await response.json()) as Report;

      if (!response.ok || !data.success) {
        throw new Error(
          data.error ?? `Request failed with status ${response.status}`,
        );
      }

      setReport(data);
      setTab("overview");
    } catch (reason) {
      setReport(null);
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to analyze code quality.",
      );
    } finally {
      setLoading(false);
    }
  }

  const counts: SeverityCounts = useMemo(() => {
    const initial: SeverityCounts = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    };

    if (!report) {
      return initial;
    }

    return report.issues.reduce<SeverityCounts>((accumulator, issue) => {
      accumulator[issue.severity] += 1;
      return accumulator;
    }, initial);
  }, [report]);

  function selectTab(nextTab: Tab): void {
    setSelectedIssue(null);
    setCopiedPrompt(false);
    setTab(nextTab);
  }

  async function copyFixPrompt(issue: Issue): Promise<void> {
    const prompt = buildFixPrompt(issue, report);

    try {
      await navigator.clipboard.writeText(prompt);
      setCopiedPrompt(true);
      window.setTimeout(() => setCopiedPrompt(false), 2200);
    } catch {
      setCopiedPrompt(false);
    }
  }

  const statusText = loading
    ? "Analyzing…"
    : report
      ? "Analysis ready"
      : "Ready";

  return (
    <div className="aci cqa">
      <header className="aci-heading cqa-heading">
        <div>
          <div className="cqa-title-row">
            <Gauge size={18} />
            <h2>Code Quality Analyzer</h2>
          </div>

          <p>
            Assess complexity, maintainability, React activity, and structural
            hotspots before you refactor.
          </p>
        </div>

        <span className="aci-ready">
          {statusText}
        </span>
      </header>

      <div className="aci-howto cqa-howto">
        <Lightbulb size={16} />
        <div>
          <strong>How to use it:</strong>{" "}
          Enter the source file and optional symbol, then run the analyzer.
          Review the score, findings, metrics, and suggestions before changing
          the code.
        </div>
      </div>

      <div className="aci-controls-panel">
        <div className="aci-controls cqa-controls">
          <label>
            <span>File path</span>
            <small>
              Relative path of the TypeScript/JavaScript file.
            </small>
            <input
              value={filePath}
              onChange={(event) => setFilePath(event.target.value)}
              placeholder="src/App.tsx"
            />
          </label>

          <label>
            <span>Symbol / function / component</span>
            <small>
              Optional function, component, method, class, or variable.
            </small>
            <input
              value={symbol}
              onChange={(event) => setSymbol(event.target.value)}
              placeholder="generateGraph"
            />
          </label>

          <button
            className="aci-primary cqa-analyze"
            type="button"
            onClick={() => void analyze()}
            disabled={loading || !projectPath.trim()}
          >
            <Search size={16} />
            {loading ? "Analyzing…" : "Analyze quality"}
          </button>
        </div>
      </div>

      {error && (
        <div className="aci-message error">
          <AlertTriangle size={16} />
          <span>{error}</span>
        </div>
      )}

      {!report && !error && !loading && (
        <div className="aci-empty-state cqa-empty-state">
          <div className="aci-empty-icon">
            <Sparkles size={20} />
          </div>
          <h3>Ready to analyze code quality</h3>
          <p>
            Enter a file and optional symbol above. The analyzer will calculate
            a heuristic quality score and identify structural hotspots.
          </p>
        </div>
      )}

      {report && (
        <>
          <div className="aci-status cqa-status">
            <span className="aci-status-pill aci-risk-low">
              <CheckCircle2 size={14} />
              Analysis complete
            </span>

            <span className="aci-target-line">
              {report.target.filePath ?? "Project"}
              {report.target.symbol ? ` · ${report.target.symbol}` : ""}
            </span>

            {report.warnings.length > 0 && (
              <span className="cqa-warning">
                {report.warnings.length} warning(s)
              </span>
            )}
          </div>

          <section className="aci-stats cqa-stats">
            <Metric
              icon={<Gauge size={20} />}
              value={report.summary.score}
              label="Quality score"
              detail="/ 100"
              className="cqa-score-stat"
            />
            <Metric
              icon={<ShieldAlert size={20} />}
              value={report.summary.grade}
              label="Grade"
              detail="overall"
              className={`cqa-grade-stat grade-${report.summary.grade.toLowerCase()}`}
            />
            <Metric
              icon={<AlertTriangle size={20} />}
              value={report.summary.issueCount}
              label="Issues"
              detail={`${report.summary.highSeverityCount} high severity`}
            />
            <Metric
              icon={<Activity size={20} />}
              value={report.summary.complexity}
              label="Complexity"
              detail="average"
            />
            <Metric
              icon={<FileCode2 size={20} />}
              value={report.summary.functions}
              label="Functions"
              detail={`${report.summary.lines} lines`}
            />
            <Metric
              icon={<Layers3 size={20} />}
              value={report.summary.reactSignals}
              label="React activity"
              detail={`${report.summary.asyncOperations} async`}
            />
          </section>

          <div className="aci-workspace cqa-workspace">
            <section className="aci-graph-panel cqa-main">
              <div className="aci-panel-toolbar cqa-panel-toolbar">
                <div>
                  <h3>Code Quality Overview</h3>
                  <p>
                    Review the quality score and structural signals detected in
                    the selected target.
                  </p>
                </div>
              </div>

              <div className="cqa-main-content">
                <div className="cqa-tabs">
                  <TabButton
                    active={tab === "overview"}
                    onClick={() => selectTab("overview")}
                    label="Overview"
                  />
                  <TabButton
                    active={tab === "issues"}
                    onClick={() => selectTab("issues")}
                    label={`Issues (${report.summary.issueCount})`}
                  />
                  <TabButton
                    active={tab === "metrics"}
                    onClick={() => selectTab("metrics")}
                    label="Metrics"
                  />
                  <TabButton
                    active={tab === "suggestions"}
                    onClick={() => selectTab("suggestions")}
                    label="Suggestions"
                  />
                </div>

                {tab === "overview" && (
                  <OverviewPanel report={report} />
                )}

                {tab === "issues" && (
                  <IssuesPanel
                    report={report}
                    selectedIssue={selectedIssue}
                    onSelect={setSelectedIssue}
                    copiedPrompt={copiedPrompt}
                    onCopyPrompt={(issue) => void copyFixPrompt(issue)}
                  />
                )}

                {tab === "metrics" && (
                  <MetricsPanel metrics={report.metrics} />
                )}

                {tab === "suggestions" && (
                  <SuggestionsPanel suggestions={report.suggestions} />
                )}
              </div>
            </section>

            <aside className="aci-inspector cqa-inspector">
              <div className="aci-inspector-head cqa-inspector-head">
                <div>
                  <span>Quality Inspector</span>
                  <small>Static analysis summary</small>
                </div>

                <span
                  className={`cqa-grade grade-${report.summary.grade.toLowerCase()}`}
                >
                  {report.summary.grade}
                </span>
              </div>

              <div className="cqa-inspector-body">
                <InspectorSection title="Target">
                  <strong>
                    {report.target.symbol ?? "File analysis"}
                  </strong>
                  <code>
                    {report.target.filePath ?? "Project"}
                  </code>
                </InspectorSection>

                <InspectorSection title="Severity">
                  {severityOrder.map((severity) => (
                    <div className="cqa-severity-row" key={severity}>
                      <span
                        className={`cqa-severity-dot severity-${severity}`}
                      />
                      <span>{severity}</span>
                      <strong>{counts[severity]}</strong>
                    </div>
                  ))}
                </InspectorSection>

                <InspectorSection title="Recommended order">
                  <div className="cqa-recommendation">
                    <strong>1. Fix critical/high findings</strong>
                    <span>Then address repeated medium findings that share the same category.</span>
                  </div>
                </InspectorSection>

                <InspectorSection title="What does this mean?">
                  <p>
                    The score is heuristic. Use it to identify areas worth
                    reviewing, then combine it with Method Explorer and Change
                    Impact Analyzer before refactoring.
                  </p>
                </InspectorSection>

                <InspectorSection title="Before you change the code">
                  <ul className="cqa-check-list">
                    <li>Review critical and high findings first.</li>
                    <li>Check complexity and deep nesting hotspots.</li>
                    <li>Review affected behavior with Method Explorer.</li>
                    <li>Check downstream consumers with Change Impact.</li>
                  </ul>
                </InspectorSection>
              </div>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

function buildFixPrompt(issue: Issue, report: Report | null): string {
  const target = report?.target.filePath ?? issue.filePath;
  const symbol = report?.target.symbol ?? issue.symbol ?? "the affected code";

  return `You are fixing a code-quality finding in an existing ${target.endsWith(".tsx") || target.endsWith(".jsx") ? "React" : "TypeScript/JavaScript"} codebase.

TASK
Fix only this code-quality issue:
- Issue: ${issue.title}
- Severity: ${issue.severity}
- Kind: ${issue.kind}
- File: ${issue.filePath}
- Lines: ${issue.startLine}-${issue.endLine}
- Symbol: ${symbol}
- Finding: ${issue.message}
- Why it matters: ${issue.whyItMatters}
- Suggested improvement: ${issue.suggestion}

RECOMMENDED APPROACH
${issue.fixSteps.map((step, index) => `${index + 1}. ${step}`).join("\n")}

SAFE REFACTORING RULES
1. Preserve the existing functional behavior. Do not intentionally change business rules, user flows, API contracts, data formats, navigation behavior, state semantics, error handling, or externally observable behavior unless the finding itself makes that change unavoidable.
2. Make the smallest focused change that resolves this finding. Do not perform unrelated cleanup, formatting, renaming, dependency upgrades, or architectural rewrites.
3. Before editing, inspect the affected code and its immediate callers/consumers so the fix does not break existing usage.
4. Preserve existing public interfaces, exported names, props, function signatures, and module boundaries unless changing one is strictly necessary for the fix.
5. If the safest fix requires a behavior, API, or contract change, do not silently make that change. Clearly explain what must change, why it is necessary, and what behavior would be affected.
6. Reuse existing utilities, patterns, types, and conventions in the project instead of introducing unnecessary abstractions or dependencies.
7. Keep the fix scoped to the reported issue and avoid changing unrelated files.
8. Preserve accessibility, error handling, loading states, and edge-case behavior.
9. After the change, run the relevant type-check/build/tests or explain if they cannot be run.
10. Re-check the original finding and confirm whether it is actually resolved.

VALIDATION
After making the fix, report:
- Files changed
- What was changed and why
- Confirmation that existing behavior was preserved
- Tests/type-check/build results
- Any behavior or API change that was unavoidable
- Whether this specific code-quality finding should now disappear or improve on the next analysis

Do not change anything outside the scope of this finding unless it is required to make the fix safe and correct.`;
}

function Metric({
  icon,
  value,
  label,
  detail,
  className = "",
}: {
  icon: ReactNode;
  value: ReactNode;
  label: string;
  detail: string;
  className?: string;
}) {
  return (
    <div className={`aci-stat cqa-stat ${className}`}>
      <div className="aci-stat-icon">{icon}</div>
      <div className="aci-stat-text">
        <strong>{value}</strong>
        <small>{label}</small>
        <em>{detail}</em>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`cqa-tab ${active ? "active" : ""}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function OverviewPanel({ report }: { report: Report }) {
  return (
    <div className="cqa-overview">
      <div className="cqa-score-hero">
        <div className="cqa-score-ring">
          <strong>{report.summary.score}</strong>
          <span>/100</span>
        </div>

        <div>
          <span className="cqa-kicker">Overall quality</span>
          <h3>
            Grade {report.summary.grade}
          </h3>
          <p>
            This score is a prioritized engineering signal, not a pass/fail
            judgment. Fix critical/high findings first, then use Method
            Explorer and Change Impact to validate the refactor.
          </p>
        </div>
      </div>

      <div className="cqa-score-guidance">
        <div>
          <strong>How to read the score</strong>
          <span>Higher is better. Repeated findings are weighted with diminishing impact so one hotspot does not incorrectly drive the score to zero.</span>
        </div>
        <div className="cqa-score-scale">
          <span><b>A/B</b> Healthy</span>
          <span><b>C</b> Review</span>
          <span><b>D/F</b> Refactor priority</span>
        </div>
      </div>

      <div className="cqa-info-grid">
        <InfoCard
          title="Complexity"
          value={String(report.summary.complexity)}
          text="Average decision-point complexity."
        />
        <InfoCard
          title="Nesting"
          value={String(report.summary.maxNestingDepth)}
          text="Maximum control-flow nesting depth."
        />
        <InfoCard
          title="Parameters"
          value={String(report.summary.parameters)}
          text="Parameters detected across analyzed functions."
        />
        <InfoCard
          title="Calls"
          value={String(report.summary.callCount)}
          text="Function and method calls detected."
        />
        <InfoCard
          title="Async"
          value={String(report.summary.asyncOperations)}
          text="Await operations detected."
        />
        <InfoCard
          title="React activity"
          value={String(report.summary.reactSignals)}
          text="Hook/state-related operations detected."
        />
      </div>
    </div>
  );
}

function IssuesPanel({
  report,
  selectedIssue,
  onSelect,
  copiedPrompt,
  onCopyPrompt,
}: {
  report: Report;
  selectedIssue: Issue | null;
  onSelect: (issue: Issue | null) => void;
  copiedPrompt: boolean;
  onCopyPrompt: (issue: Issue) => void;
}) {
  if (selectedIssue) {
    return (
      <div className="cqa-detail">
        <button
          type="button"
          className="cqa-back"
          onClick={() => onSelect(null)}
        >
          ← Back to Issues
        </button>

        <div className={`cqa-detail-header severity-${selectedIssue.severity}`}>
          <div className="cqa-detail-icon">
            <ShieldAlert size={18} />
          </div>
          <div>
            <span>{selectedIssue.severity.toUpperCase()}</span>
            <h3>{selectedIssue.title}</h3>
          </div>
        </div>

        <p className="cqa-detail-message">
          {selectedIssue.message}
        </p>

        <div className="cqa-fix-summary">
          <div className="cqa-fix-meta">
            <span className={`cqa-priority priority-${selectedIssue.priority}`}>
              Fix {selectedIssue.priority}
            </span>
            <span className="cqa-confidence">{selectedIssue.confidence} confidence</span>
          </div>

          <div className="cqa-detail-box">
            <div>
              <Info size={16} />
              <strong>Why it matters</strong>
            </div>
            <p>{selectedIssue.whyItMatters}</p>
          </div>

          <div className="cqa-detail-box">
            <div>
              <Lightbulb size={16} />
              <strong>Suggested improvement</strong>
            </div>
            <p>{selectedIssue.suggestion}</p>
          </div>

          <div className="cqa-fix-steps">
            <strong>Recommended fix steps</strong>
            <ol>
              {selectedIssue.fixSteps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          </div>

          <div className="cqa-ai-fix-panel">
            <div className="cqa-ai-fix-head">
              <div>
                <div className="cqa-ai-fix-title">
                  <Sparkles size={16} />
                  <strong>Developer Fix Prompt</strong>
                </div>
                <p>
                  Copy this prompt into GitHub Copilot, ChatGPT, or another coding assistant.
                  It tells the assistant to fix the finding without silently changing existing behavior.
                </p>
              </div>

              <button
                type="button"
                className={`cqa-copy-prompt ${copiedPrompt ? "copied" : ""}`}
                onClick={() => onCopyPrompt(selectedIssue)}
              >
                {copiedPrompt ? <Check size={14} /> : <Clipboard size={14} />}
                {copiedPrompt ? "Copied" : "Copy prompt"}
              </button>
            </div>

            <pre className="cqa-ai-fix-prompt">{buildFixPrompt(selectedIssue, report)}</pre>
          </div>
        </div>

        <div className="cqa-location">
          <FileCode2 size={15} />
          <code>{selectedIssue.filePath}</code>
          <span>
            Lines {selectedIssue.startLine}-{selectedIssue.endLine}
          </span>
        </div>
      </div>
    );
  }

  if (report.issues.length === 0) {
    return (
      <div className="aci-empty-state cqa-empty-state">
        <div className="aci-empty-icon">
          <CheckCircle2 size={20} />
        </div>
        <h3>No issues found</h3>
        <p>
          The current analyzer did not detect any structural quality issues
          for this target.
        </p>
      </div>
    );
  }

  return (
    <div className="cqa-issues-list">
      {report.issues.map((issue) => (
        <button
          type="button"
          className="cqa-issue-row"
          key={issue.id}
          onClick={() => onSelect(issue)}
        >
          <span className={`cqa-issue-severity severity-${issue.severity}`}>
            <AlertTriangle size={16} />
          </span>

          <span className="cqa-issue-copy">
            <strong>{issue.title}</strong>
            <small>{issue.message}</small>
            <span className={`cqa-issue-priority priority-${issue.priority}`}>Fix {issue.priority}</span>
            <code>
              {issue.filePath}:{issue.startLine}
            </code>
          </span>

          <span className="cqa-issue-arrow">›</span>
        </button>
      ))}
    </div>
  );
}

function MetricsPanel({ metrics }: { metrics: MetricRecord[] }) {
  if (metrics.length === 0) {
    return (
      <div className="aci-empty-state cqa-empty-state">
        <Info size={20} />
        <h3>No detailed metrics available</h3>
        <p>
          The analyzer did not return per-symbol metrics for this target.
        </p>
      </div>
    );
  }

  return (
    <div className="cqa-table-wrap">
      <table className="cqa-table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Kind</th>
            <th>Lines</th>
            <th>Complexity</th>
            <th>Nesting</th>
            <th>Params</th>
            <th>Calls</th>
            <th>Async</th>
          </tr>
        </thead>
        <tbody>
          {metrics.map((metric, index) => (
            <tr key={index}>
              <td>{String(metric.symbol ?? "File")}</td>
              <td>{String(metric.kind ?? "source")}</td>
              <td>{String(metric.lines ?? "-")}</td>
              <td>{String(metric.complexity ?? "-")}</td>
              <td>{String(metric.nestingDepth ?? "-")}</td>
              <td>{String(metric.parameters ?? "-")}</td>
              <td>{String(metric.callCount ?? "-")}</td>
              <td>{String(metric.asyncOperations ?? "-")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SuggestionsPanel({
  suggestions,
}: {
  suggestions: string[];
}) {
  if (suggestions.length === 0) {
    return (
      <div className="aci-empty-state cqa-empty-state">
        <Lightbulb size={20} />
        <h3>No additional suggestions</h3>
        <p>
          The analyzer did not generate additional recommendations for this
          target.
        </p>
      </div>
    );
  }

  return (
    <div className="cqa-suggestions">
      {suggestions.map((suggestion, index) => (
        <div className="cqa-suggestion" key={index}>
          <span className="cqa-suggestion-icon">
            <List size={15} />
          </span>
          <p>{suggestion}</p>
        </div>
      ))}
    </div>
  );
}

function InfoCard({
  title,
  value,
  text,
}: {
  title: string;
  value: string;
  text: string;
}) {
  return (
    <div className="cqa-info-card">
      <span>{title}</span>
      <strong>{value}</strong>
      <p>{text}</p>
    </div>
  );
}

function InspectorSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="cqa-inspector-section">
      <span className="cqa-section-title">{title}</span>
      {children}
    </section>
  );
}
