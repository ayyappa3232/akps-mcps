import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Atom,
  Check,
  CheckCircle2,
  Copy,
  FileCode2,
  Globe,
  Layers,
  Lightbulb,
  Search,
  Smartphone,
  Webhook,
  XCircle,
} from "lucide-react";
import SecuritySelect from "../security/SecuritySelect";
import "./react-component-analyzer.css";

type Severity = "critical" | "high" | "medium" | "low" | "info";
type ComponentSeverity = Severity | "healthy";
type ComponentKind = "function" | "arrow" | "class";
type ComponentWrapper = "memo" | "forwardRef" | "observer";
type ComponentPlatform = "web" | "native" | "shared";
type ExportKind = "default" | "named" | "none";
type HookCategory = "react" | "redux" | "query" | "navigation" | "custom";
type Integration = "redux" | "query" | "firebase" | "navigation";

interface ComponentProp {
  name: string;
  type?: string;
  optional: boolean;
  hasDefault: boolean;
  used: boolean;
  passThrough: boolean;
}

interface HookUse {
  name: string;
  count: number;
  category: HookCategory;
}

interface ComponentFinding {
  rule: string;
  severity: Severity;
  title: string;
  message: string;
  line: number;
  suggestion: string;
}

interface ComponentRef {
  id: string;
  name: string;
  filePath: string;
}

interface ComponentInfo {
  id: string;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  lines: number;
  kind: ComponentKind;
  wrappers: ComponentWrapper[];
  exportKind: ExportKind;
  platform: ComponentPlatform;
  severity: ComponentSeverity;
  riskScore: number;
  props: ComponentProp[];
  propCount: number;
  hooks: HookUse[];
  hookCount: number;
  stateCount: number;
  effectCount: number;
  jsxElements: number;
  maxJsxDepth: number;
  complexity: number;
  inlineHandlers: number;
  integrations: Integration[];
  renders: ComponentRef[];
  renderedBy: ComponentRef[];
  externalElements: string[];
  findings: ComponentFinding[];
  snippet: string;
  snippetTruncated: boolean;
}

interface HookUsage {
  name: string;
  category: HookCategory;
  count: number;
  componentCount: number;
}

interface CustomHookInfo {
  name: string;
  filePath: string;
  line: number;
  usedByComponents: number;
}

interface RuleCount {
  rule: string;
  title: string;
  severity: Severity;
  count: number;
}

interface ReactComponentReport {
  success: boolean;
  tool: "analyze_react_components";
  projectPath: string;
  filePath?: string;
  includeTests: boolean;
  maxLines: number;
  maxProps: number;
  filesScanned: number;
  filesWithComponents: number;
  totalLines: number;
  projectComponentCount: number;
  totalComponents: number;
  componentsWithIssues: number;
  healthyComponents: number;
  averageLines: number;
  totalHooks: number;
  totalFindings: number;
  summary: Record<Severity, number>;
  kindCounts: Record<ComponentKind, number>;
  platformCounts: Record<ComponentPlatform, number>;
  integrationCounts: Record<Integration, number>;
  ruleCounts: RuleCount[];
  components: ComponentInfo[];
  hookUsage: HookUsage[];
  customHooks: CustomHookInfo[];
  warnings: string[];
}

interface AnalyzeReactComponentsProps {
  projectPath: string;
  onProjectPathChange?: (value: string) => void;
  apiUrl?: string;
}

type StatusFilter = "all" | "issues" | "healthy";
type PlatformFilter = "all" | ComponentPlatform;
type SeverityFilter = "all" | Severity;
type SortKey = "risk" | "lines" | "props" | "hooks" | "usage";

const DEFAULT_API_URL = "http://127.0.0.1:4174/api/analyze-react-components";

const SEVERITY_LABEL: Record<ComponentSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
  healthy: "Healthy",
};

const KIND_LABEL: Record<ComponentKind, string> = {
  function: "Function",
  arrow: "Arrow",
  class: "Class",
};

const PLATFORM_LABEL: Record<ComponentPlatform, string> = {
  web: "Web",
  native: "React Native",
  shared: "Shared",
};

const EXPORT_LABEL: Record<ExportKind, string> = {
  default: "Default export",
  named: "Named export",
  none: "Not exported",
};

const INTEGRATION_LABEL: Record<Integration, string> = {
  redux: "Redux",
  query: "Data fetching",
  firebase: "Firebase",
  navigation: "Navigation",
};

const HOOK_CATEGORY_LABEL: Record<HookCategory, string> = {
  react: "React",
  redux: "Redux",
  query: "Query",
  navigation: "Navigation",
  custom: "Custom",
};

function baseName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1];
}

function shortPath(filePath: string): string {
  return filePath.split("/").slice(-2).join("/");
}

function platformIcon(platform: ComponentPlatform, size = 14) {
  if (platform === "web") return <Globe size={size} />;
  if (platform === "native") return <Smartphone size={size} />;
  return <Layers size={size} />;
}

function componentLabel(component: ComponentInfo): string {
  const wrappers = component.wrappers.length > 0 ? ` · ${component.wrappers.join(" + ")}` : "";
  return `${KIND_LABEL[component.kind]}${wrappers}`;
}

/* -------------------------------------------------------------------------- */
/*  Findings                                                                  */
/* -------------------------------------------------------------------------- */

function FindingsPanel({ component }: { component: ComponentInfo }) {
  if (component.findings.length === 0) {
    return (
      <section className="rca-box rca-box-clean">
        <h4>
          <CheckCircle2 size={14} /> No issues found
        </h4>
        <p>
          This component passed every check: hook order, effects, list keys,
          selectors, size and props.
        </p>
      </section>
    );
  }

  return (
    <section className="rca-box">
      <h4>
        <AlertTriangle size={14} /> Findings ({component.findings.length})
      </h4>

      <ul className="rca-findings">
        {component.findings.map((finding, index) => (
          <li key={`${finding.rule}:${finding.line}:${index}`} className={`rca-finding sev-${finding.severity}`}>
            <div className="rca-finding-head">
              <span className={`rca-badge badge-${finding.severity}`}>{finding.severity}</span>
              <strong>{finding.title}</strong>
              <span className="rca-line-ref">
                {baseName(component.filePath)}:{finding.line}
              </span>
            </div>
            <p>{finding.message}</p>
            <p className="rca-fix">
              <Lightbulb size={12} />
              <span>{finding.suggestion}</span>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Props, hooks and relations                                                */
/* -------------------------------------------------------------------------- */

function PropsPanel({ component }: { component: ComponentInfo }) {
  return (
    <section className="rca-box">
      <h4>Props ({component.props.length})</h4>

      {component.props.length === 0 ? (
        <p>This component takes no props.</p>
      ) : (
        <div className="rca-table-wrap">
          <table className="rca-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {component.props.map((prop) => (
                <tr key={prop.name}>
                  <td>
                    <code>{prop.name}</code>
                    {!prop.optional && !prop.hasDefault && <span className="rca-required">*</span>}
                  </td>
                  <td>
                    <code className="rca-type" title={prop.type}>
                      {prop.type ?? "-"}
                    </code>
                  </td>
                  <td>
                    <div className="rca-tags">
                      {prop.hasDefault && <span className="rca-tag">default</span>}
                      {prop.passThrough && <span className="rca-tag warn">only passed down</span>}
                      {!prop.used && <span className="rca-tag bad">unused</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function HooksPanel({ component }: { component: ComponentInfo }) {
  return (
    <section className="rca-box">
      <h4>Hooks ({component.hookCount})</h4>

      {component.hooks.length === 0 ? (
        <p>No hooks are called in this component.</p>
      ) : (
        <div className="rca-chips">
          {component.hooks.map((hook) => (
            <span key={hook.name} className={`rca-chip hook-${hook.category}`} title={HOOK_CATEGORY_LABEL[hook.category]}>
              {hook.name}
              {hook.count > 1 && <em>×{hook.count}</em>}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function RelationList({
  title,
  items,
  external,
  emptyText,
  onSelect,
  available,
}: {
  title: string;
  items: ComponentRef[];
  external?: string[];
  emptyText: string;
  onSelect: (id: string) => void;
  available: Set<string>;
}) {
  return (
    <div className="rca-relation">
      <h5>
        {title} ({items.length})
      </h5>

      {items.length === 0 && (!external || external.length === 0) ? (
        <p>{emptyText}</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                disabled={!available.has(item.id)}
                title={item.filePath}
              >
                <Atom size={12} />
                <span>{item.name}</span>
                <em>{shortPath(item.filePath)}</em>
              </button>
            </li>
          ))}
        </ul>
      )}

      {external && external.length > 0 && (
        <div className="rca-chips rca-external">
          {external.map((name) => (
            <span key={name} className="rca-chip">
              {name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Source                                                                    */
/* -------------------------------------------------------------------------- */

function SourcePanel({ component }: { component: ComponentInfo }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const lines = component.snippet.split("\n");
  const flagged = new Set(component.findings.map((finding) => finding.line));

  async function copy() {
    try {
      await navigator.clipboard.writeText(component.snippet);
      setCopied(true);
      setCopyFailed(false);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    <section className="rca-box">
      <div className="rca-source-head">
        <h4>Source</h4>
        <button type="button" className="rca-copy" onClick={copy}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <div className="rca-code" role="region" aria-label={`${component.name} source`}>
        {lines.map((line, index) => {
          const lineNumber = component.startLine + index;
          return (
            <div key={index} className={`rca-code-line ${flagged.has(lineNumber) ? "flagged" : ""}`}>
              <span className="rca-code-number">{lineNumber}</span>
              <code>{line || " "}</code>
            </div>
          );
        })}

        {component.snippetTruncated && (
          <div className="rca-code-more">
            … {component.lines - lines.length} more lines in this component
          </div>
        )}
      </div>

      {copyFailed && (
        <p className="rca-fine-print">
          The browser blocked clipboard access. Select the code above and copy it manually.
        </p>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  View                                                                      */
/* -------------------------------------------------------------------------- */

export default function AnalyzeReactComponents({
  projectPath,
  onProjectPathChange,
  apiUrl = DEFAULT_API_URL,
}: AnalyzeReactComponentsProps) {
  const [focusFile, setFocusFile] = useState("");
  const [maxLines, setMaxLines] = useState("150");
  const [maxProps, setMaxProps] = useState("7");
  const [includeTests, setIncludeTests] = useState(false);

  const [report, setReport] = useState<ReactComponentReport | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [ruleFilter, setRuleFilter] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("risk");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function analyze() {
    if (!projectPath.trim()) {
      setError("Enter a project path before starting the analysis.");
      return;
    }

    const lineLimit = Number(maxLines);
    const propLimit = Number(maxProps);

    if (!Number.isInteger(lineLimit) || lineLimit < 30 || lineLimit > 2000) {
      setError("Maximum lines must be a whole number between 30 and 2000.");
      return;
    }

    if (!Number.isInteger(propLimit) || propLimit < 1 || propLimit > 50) {
      setError("Maximum props must be a whole number between 1 and 50.");
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
          maxLines: lineLimit,
          maxProps: propLimit,
          includeTests,
        }),
      });

      const data = await response.json();

      if (!response.ok || data.success === false) {
        throw new Error(data.error || "React component analysis failed.");
      }

      const nextReport = data as ReactComponentReport;
      setReport(nextReport);
      setSelectedId(nextReport.components[0]?.id ?? null);
      setSearch("");
      setStatusFilter("all");
      setPlatformFilter("all");
      setSeverityFilter("all");
      setRuleFilter(null);
      setSortKey("risk");
    } catch (analysisError) {
      setError(
        analysisError instanceof Error ? analysisError.message : "Unable to analyze the project."
      );
    } finally {
      setLoading(false);
    }
  }

  const visibleComponents = useMemo(() => {
    if (!report) return [];

    const query = search.trim().toLowerCase();

    const filtered = report.components.filter((component) => {
      if (statusFilter === "issues" && component.severity === "healthy") return false;
      if (statusFilter === "healthy" && component.severity !== "healthy") return false;
      if (platformFilter !== "all" && component.platform !== platformFilter) return false;
      if (severityFilter !== "all" && component.severity !== severityFilter) return false;
      if (ruleFilter && !component.findings.some((finding) => finding.rule === ruleFilter)) {
        return false;
      }
      if (!query) return true;

      return [
        component.name,
        component.filePath,
        ...component.hooks.map((hook) => hook.name),
        ...component.findings.map((finding) => finding.title),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case "lines":
          return b.lines - a.lines || b.riskScore - a.riskScore;
        case "props":
          return b.propCount - a.propCount || b.riskScore - a.riskScore;
        case "hooks":
          return b.hookCount - a.hookCount || b.riskScore - a.riskScore;
        case "usage":
          return b.renderedBy.length - a.renderedBy.length || b.riskScore - a.riskScore;
        default:
          return b.riskScore - a.riskScore || b.lines - a.lines;
      }
    });
  }, [report, search, statusFilter, platformFilter, severityFilter, ruleFilter, sortKey]);

  const availableIds = useMemo(
    () => new Set(report?.components.map((component) => component.id) ?? []),
    [report]
  );

  // A component reached through the render tree may be hidden by the filters.
  const selectedComponent =
    report?.components.find((component) => component.id === selectedId) ??
    visibleComponents[0] ??
    null;

  const maxHookCount = report?.hookUsage[0]?.count ?? 1;
  const maxRuleCount = report?.ruleCounts[0]?.count ?? 1;
  const hasActiveFilters =
    statusFilter !== "all" ||
    platformFilter !== "all" ||
    severityFilter !== "all" ||
    ruleFilter !== null ||
    search.trim() !== "";

  function clearFilters() {
    setSearch("");
    setStatusFilter("all");
    setPlatformFilter("all");
    setSeverityFilter("all");
    setRuleFilter(null);
  }

  return (
    <div className="rca-analyzer">
      <div className="rca-title-row">
        <div className="rca-title-icon">
          <Atom size={24} />
        </div>

        <div>
          <h1>React Component Analyzer</h1>
          <p>
            Inspect every React and React Native component: its props, hooks, state, what it
            renders, and the problems worth fixing, from broken hook order to leaked Firebase
            listeners.
          </p>
        </div>
      </div>

      <section className="rca-input-card">
        <div className="rca-field rca-field-wide">
          <label htmlFor="rca-project-path">Project path</label>
          <input
            id="rca-project-path"
            value={projectPath}
            onChange={(event) => onProjectPathChange?.(event.target.value)}
            placeholder="/path/to/your/project"
          />
        </div>

        <div className="rca-field">
          <label htmlFor="rca-focus-file">Focus file (optional)</label>
          <input
            id="rca-focus-file"
            value={focusFile}
            onChange={(event) => setFocusFile(event.target.value)}
            placeholder="src/screens/Home.tsx"
          />
        </div>

        <button type="button" className="rca-analyze-button" onClick={analyze} disabled={loading}>
          {loading ? (
            <>
              <span className="rca-spinner" />
              Analyzing...
            </>
          ) : (
            <>
              <Atom size={17} />
              Analyze Components
            </>
          )}
        </button>

        <div className="rca-options">
          <div className="rca-field">
            <label htmlFor="rca-max-lines">Large component (lines)</label>
            <input
              id="rca-max-lines"
              type="number"
              min={30}
              max={2000}
              value={maxLines}
              onChange={(event) => setMaxLines(event.target.value)}
            />
          </div>

          <div className="rca-field">
            <label htmlFor="rca-max-props">Too many props (above)</label>
            <input
              id="rca-max-props"
              type="number"
              min={1}
              max={50}
              value={maxProps}
              onChange={(event) => setMaxProps(event.target.value)}
            />
          </div>

          <label className="rca-check">
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
        <div className="rca-error" role="alert">
          <XCircle size={18} />
          {error}
        </div>
      )}

      {report && (
        <>
          <div className="rca-status-row">
            <div className={`rca-success ${report.componentsWithIssues === 0 ? "" : "has-issues"}`}>
              {report.componentsWithIssues === 0 ? (
                <CheckCircle2 size={18} />
              ) : (
                <AlertTriangle size={18} />
              )}
              <strong>{report.totalComponents}</strong>
              <span>
                {report.totalComponents === 1 ? "component" : "components"} analyzed
                {report.filePath ? ` in ${report.filePath}` : ""}
              </span>
            </div>

            <span className="rca-scope">
              {report.filesScanned} files · {report.totalLines.toLocaleString()} lines
              {report.filePath ? ` · ${report.projectComponentCount} components project-wide` : ""}
            </span>
          </div>

          <div className="rca-summary-grid">
            <div className="rca-summary-card static">
              <div className="rca-summary-icon neutral">
                <Atom size={17} />
              </div>
              <div>
                <strong>{report.totalComponents}</strong>
                <span>
                  Components · avg {report.averageLines} lines
                </span>
              </div>
            </div>

            <button
              type="button"
              className={`rca-summary-card tone-issues ${statusFilter === "issues" ? "active" : ""}`}
              onClick={() => setStatusFilter(statusFilter === "issues" ? "all" : "issues")}
              aria-pressed={statusFilter === "issues"}
            >
              <div className="rca-summary-icon">
                <AlertTriangle size={17} />
              </div>
              <div>
                <strong>{report.componentsWithIssues}</strong>
                <span>With findings · {report.totalFindings} total</span>
              </div>
            </button>

            <button
              type="button"
              className={`rca-summary-card tone-healthy ${statusFilter === "healthy" ? "active" : ""}`}
              onClick={() => setStatusFilter(statusFilter === "healthy" ? "all" : "healthy")}
              aria-pressed={statusFilter === "healthy"}
            >
              <div className="rca-summary-icon">
                <CheckCircle2 size={17} />
              </div>
              <div>
                <strong>{report.healthyComponents}</strong>
                <span>Healthy</span>
              </div>
            </button>

            <div className="rca-summary-card static">
              <div className="rca-summary-icon neutral">
                <Webhook size={17} />
              </div>
              <div>
                <strong>{report.totalHooks}</strong>
                <span>Hook calls · {report.customHooks.length} custom</span>
              </div>
            </div>
          </div>

          <div className="rca-overview">
            <div className="rca-overview-group">
              <span className="rca-overview-title">Severity</span>
              <div className="rca-chips">
                {(["critical", "high", "medium", "low", "info"] as const).map((severity) => (
                  <button
                    type="button"
                    key={severity}
                    className={`rca-sev-chip badge-${severity} ${severityFilter === severity ? "active" : ""}`}
                    onClick={() => setSeverityFilter(severityFilter === severity ? "all" : severity)}
                    aria-pressed={severityFilter === severity}
                    disabled={report.summary[severity] === 0}
                  >
                    {report.summary[severity]} {severity}
                  </button>
                ))}
              </div>
            </div>

            <div className="rca-overview-group">
              <span className="rca-overview-title">Style</span>
              <div className="rca-chips">
                <span className="rca-chip">{report.kindCounts.function + report.kindCounts.arrow} function</span>
                <span className="rca-chip">{report.kindCounts.class} class</span>
              </div>
            </div>

            <div className="rca-overview-group">
              <span className="rca-overview-title">Platform</span>
              <div className="rca-chips">
                <span className="rca-chip">{report.platformCounts.web} web</span>
                <span className="rca-chip">{report.platformCounts.native} native</span>
                <span className="rca-chip">{report.platformCounts.shared} shared</span>
              </div>
            </div>

            <div className="rca-overview-group">
              <span className="rca-overview-title">Uses</span>
              <div className="rca-chips">
                {(Object.keys(INTEGRATION_LABEL) as Integration[]).map((integration) => (
                  <span key={integration} className="rca-chip">
                    {report.integrationCounts[integration]} {INTEGRATION_LABEL[integration]}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {report.totalComponents === 0 ? (
            <section className="rca-clean">
              <Atom size={38} />
              <h3>No React components found</h3>
              <p>
                None of the {report.filesScanned} analyzed files define a component
                {report.filePath ? ` in ${report.filePath}` : ""}. Check the project path, or point
                it at the folder that holds your components.
              </p>
            </section>
          ) : (
            <section className="rca-workspace">
              <div className="rca-list-panel">
                <div className="rca-panel-header">
                  <div>
                    <h2>Components</h2>
                    <p>
                      {visibleComponents.length} of {report.components.length} shown
                    </p>
                  </div>

                  <div className="rca-count-pill">
                    <Atom size={15} />
                    {visibleComponents.length}
                  </div>
                </div>

                <div className="rca-filters">
                  <div className="rca-search">
                    <Search size={17} />
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search by name, file, hook or issue..."
                      aria-label="Search components"
                    />
                  </div>

                  <div className="rca-filter-row">
                    <div className="rca-segment" role="group" aria-label="Filter by platform">
                      {(["all", "web", "native", "shared"] as const).map((option) => (
                        <button
                          type="button"
                          key={option}
                          className={platformFilter === option ? "active" : ""}
                          aria-pressed={platformFilter === option}
                          onClick={() => setPlatformFilter(option)}
                        >
                          {option === "all" ? "All" : option === "native" ? "Native" : PLATFORM_LABEL[option]}
                        </button>
                      ))}
                    </div>

                    <div className="rca-sort">
                      <SecuritySelect
                        ariaLabel="Sort components"
                        value={sortKey}
                        onChange={setSortKey}
                        options={[
                          { value: "risk", label: "Sort: risk" },
                          { value: "lines", label: "Sort: size" },
                          { value: "props", label: "Sort: props" },
                          { value: "hooks", label: "Sort: hooks" },
                          { value: "usage", label: "Sort: most used" },
                        ]}
                      />
                    </div>
                  </div>

                  {ruleFilter && (
                    <button type="button" className="rca-active-rule" onClick={() => setRuleFilter(null)}>
                      Issue: {report.ruleCounts.find((rule) => rule.rule === ruleFilter)?.title ?? ruleFilter}
                      <XCircle size={13} />
                    </button>
                  )}
                </div>

                <div className="rca-component-list">
                  {visibleComponents.length === 0 ? (
                    <div className="rca-empty">
                      <Atom size={34} />
                      <h3>No matching components</h3>
                      <p>No component matches the current filters.</p>
                      {hasActiveFilters && (
                        <button type="button" className="rca-link-button" onClick={clearFilters}>
                          Clear filters
                        </button>
                      )}
                    </div>
                  ) : (
                    visibleComponents.map((component) => (
                      <button
                        type="button"
                        key={component.id}
                        className={`rca-component ${selectedComponent?.id === component.id ? "selected" : ""}`}
                        onClick={() => setSelectedId(component.id)}
                      >
                        <div className={`rca-component-icon sev-${component.severity}`}>
                          {platformIcon(component.platform, 17)}
                        </div>

                        <div className="rca-component-content">
                          <div className="rca-component-top">
                            <span className={`rca-badge badge-${component.severity}`}>
                              {SEVERITY_LABEL[component.severity]}
                            </span>
                            <span className="rca-kind-badge">{componentLabel(component)}</span>
                          </div>

                          <h3>{component.name}</h3>
                          <p className="rca-places">{component.filePath}</p>

                          <div className="rca-component-stats">
                            <span>{component.lines} lines</span>
                            <span>{component.propCount} props</span>
                            <span>{component.hookCount} hooks</span>
                            {component.findings.length > 0 && (
                              <span className="rca-stat-issues">
                                {component.findings.length}{" "}
                                {component.findings.length === 1 ? "issue" : "issues"}
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>

              <aside className="rca-inspector">
                <div className="rca-panel-header">
                  <div>
                    <h2>Inspector</h2>
                    <p>Props, hooks, relations and what to fix</p>
                  </div>
                </div>

                {selectedComponent ? (
                  <div className="rca-inspector-body" key={selectedComponent.id}>
                    <div className="rca-inspector-title">
                      <div className={`rca-inspector-icon sev-${selectedComponent.severity}`}>
                        {platformIcon(selectedComponent.platform, 20)}
                      </div>

                      <div>
                        <span className={`rca-badge badge-${selectedComponent.severity}`}>
                          {SEVERITY_LABEL[selectedComponent.severity]}
                        </span>
                        <h3>{selectedComponent.name}</h3>
                        <p className="rca-inspector-path" title={selectedComponent.filePath}>
                          <FileCode2 size={12} />
                          {selectedComponent.filePath}:{selectedComponent.startLine}-{selectedComponent.endLine}
                        </p>
                      </div>
                    </div>

                    <div className="rca-tags rca-inspector-tags">
                      <span className="rca-tag">{componentLabel(selectedComponent)}</span>
                      <span className="rca-tag">{PLATFORM_LABEL[selectedComponent.platform]}</span>
                      <span className="rca-tag">{EXPORT_LABEL[selectedComponent.exportKind]}</span>
                      {selectedComponent.integrations.map((integration) => (
                        <span key={integration} className="rca-tag accent">
                          {INTEGRATION_LABEL[integration]}
                        </span>
                      ))}
                    </div>

                    <div className="rca-detail-grid">
                      <div>
                        <span>Risk score</span>
                        <strong>{selectedComponent.riskScore} / 100</strong>
                      </div>
                      <div>
                        <span>Size</span>
                        <strong>{selectedComponent.lines} lines</strong>
                      </div>
                      <div>
                        <span>State · effects</span>
                        <strong>
                          {selectedComponent.stateCount} · {selectedComponent.effectCount}
                        </strong>
                      </div>
                      <div>
                        <span>Complexity</span>
                        <strong>{selectedComponent.complexity}</strong>
                      </div>
                      <div>
                        <span>JSX elements</span>
                        <strong>
                          {selectedComponent.jsxElements} · depth {selectedComponent.maxJsxDepth}
                        </strong>
                      </div>
                      <div>
                        <span>Inline handlers</span>
                        <strong>{selectedComponent.inlineHandlers}</strong>
                      </div>
                    </div>

                    <FindingsPanel component={selectedComponent} />
                    <PropsPanel component={selectedComponent} />
                    <HooksPanel component={selectedComponent} />

                    <section className="rca-box">
                      <h4>Render tree</h4>
                      <div className="rca-relations">
                        <RelationList
                          title="Renders"
                          items={selectedComponent.renders}
                          external={selectedComponent.externalElements}
                          emptyText="Renders no other project components."
                          onSelect={setSelectedId}
                          available={availableIds}
                        />
                        <RelationList
                          title="Rendered by"
                          items={selectedComponent.renderedBy}
                          emptyText="No component renders this one."
                          onSelect={setSelectedId}
                          available={availableIds}
                        />
                      </div>
                    </section>

                    <SourcePanel component={selectedComponent} />
                  </div>
                ) : (
                  <div className="rca-inspector-empty">
                    <Atom size={38} />
                    <h3>Select a component</h3>
                    <p>Choose a component from the list to see its props, hooks and findings.</p>
                  </div>
                )}
              </aside>
            </section>
          )}

          {(report.ruleCounts.length > 0 || report.hookUsage.length > 0) && (
            <section className="rca-insights">
              {report.ruleCounts.length > 0 && (
                <div className="rca-insight-card">
                  <div className="rca-panel-header">
                    <div>
                      <h2>Most common issues</h2>
                      <p>Select one to filter the component list.</p>
                    </div>
                  </div>

                  <ul className="rca-bars">
                    {report.ruleCounts.map((rule) => (
                      <li key={rule.rule}>
                        <button
                          type="button"
                          className={ruleFilter === rule.rule ? "active" : ""}
                          aria-pressed={ruleFilter === rule.rule}
                          onClick={() => {
                            setRuleFilter(ruleFilter === rule.rule ? null : rule.rule);
                            setStatusFilter("all");
                            setSeverityFilter("all");
                          }}
                        >
                          <span className="rca-bar-label">
                            <span className={`rca-dot dot-${rule.severity}`} />
                            {rule.title}
                          </span>
                          <span className="rca-bar-track">
                            <span
                              className={`rca-bar-fill fill-${rule.severity}`}
                              style={{ width: `${Math.max(4, (rule.count / maxRuleCount) * 100)}%` }}
                            />
                          </span>
                          <strong>{rule.count}</strong>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {report.hookUsage.length > 0 && (
                <div className="rca-insight-card">
                  <div className="rca-panel-header">
                    <div>
                      <h2>Hook usage</h2>
                      <p>Calls across all components, with how many components use each.</p>
                    </div>
                  </div>

                  <ul className="rca-bars static">
                    {report.hookUsage.slice(0, 12).map((hook) => (
                      <li key={hook.name}>
                        <div className="rca-bar-row">
                          <span className="rca-bar-label">
                            <span className={`rca-dot hook-dot-${hook.category}`} />
                            {hook.name}
                          </span>
                          <span className="rca-bar-track">
                            <span
                              className={`rca-bar-fill hook-fill-${hook.category}`}
                              style={{ width: `${Math.max(4, (hook.count / maxHookCount) * 100)}%` }}
                            />
                          </span>
                          <strong title={`${hook.componentCount} components`}>{hook.count}</strong>
                        </div>
                      </li>
                    ))}
                  </ul>

                  {report.customHooks.length > 0 && (
                    <div className="rca-custom-hooks">
                      <h4>Custom hooks</h4>
                      <ul>
                        {report.customHooks.slice(0, 8).map((hook) => (
                          <li key={`${hook.filePath}:${hook.name}`}>
                            <span title={hook.filePath}>
                              <code>{hook.name}</code>
                              <em>{shortPath(hook.filePath)}</em>
                            </span>
                            <strong>
                              {hook.usedByComponents} {hook.usedByComponents === 1 ? "component" : "components"}
                            </strong>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {report.warnings.length > 0 && (
            <section className="rca-analysis-notes">
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
