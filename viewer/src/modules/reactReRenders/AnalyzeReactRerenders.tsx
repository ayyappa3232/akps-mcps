import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Cpu,
  FileCode2,
  GitBranch,
  Layers,
  ListOrdered,
  Network,
  Repeat,
  RefreshCw,
  Search,
  Shield,
  Wrench,
  XCircle,
  Zap,
} from "lucide-react";
import SecuritySelect from "../security/SecuritySelect";
import "./analyze-react-rerenders.css";

type RerenderSeverity = "critical" | "high" | "medium" | "low" | "info";
type ComponentSeverity = RerenderSeverity | "none";

type RerenderCategory =
  | "loop"
  | "remount"
  | "memo"
  | "context"
  | "effects"
  | "state"
  | "lists"
  | "computation"
  | "cascade";

type RerenderRule =
  | "set-state-in-render"
  | "effect-set-state-loop"
  | "random-key"
  | "component-in-component"
  | "memo-defeated"
  | "context-value-unstable"
  | "unstable-hook-dependency"
  | "missing-deps-array"
  | "derived-state-in-effect"
  | "unused-state"
  | "too-much-state"
  | "index-key"
  | "expensive-computation"
  | "wide-cascade";

type ComponentKind = "function" | "arrow" | "memo" | "forwardRef" | "class";

interface RerenderSuggestion {
  title: string;
  summary: string;
  steps: string[];
  before?: string;
  after?: string;
  confidence: "high" | "medium" | "low";
  caveats: string[];
}

interface RerenderFinding {
  id: string;
  rule: RerenderRule;
  category: RerenderCategory;
  severity: RerenderSeverity;
  title: string;
  description: string;
  filePath: string;
  line: number;
  endLine: number;
  component: string;
  componentId: string;
  impact: number;
  detail: string[];
  snippet: string;
  snippetStartLine: number;
  highlightStart: number;
  highlightEnd: number;
  suggestion: RerenderSuggestion;
}

interface CascadeNode {
  name: string;
  filePath: string;
  depth: number;
  boundary: boolean;
  isMemo: boolean;
}

interface RenderCascade {
  count: number;
  boundaries: number;
  nodes: CascadeNode[];
  truncated: boolean;
}

interface ChildEdge {
  name: string;
  componentId: string;
  filePath: string;
  line: number;
  isMemo: boolean;
  unstableProps: string[];
  uses: number;
}

interface ComponentRender {
  id: string;
  name: string;
  filePath: string;
  line: number;
  endLine: number;
  lines: number;
  kind: ComponentKind;
  isMemo: boolean;
  isExported: boolean;
  propsCount: number;
  stateCount: number;
  reducerCount: number;
  effectCount: number;
  stateNames: string[];
  contexts: string[];
  customHooks: string[];
  children: ChildEdge[];
  parents: string[];
  cascade: RenderCascade;
  findingCount: number;
  score: number;
  severity: ComponentSeverity;
}

interface RerenderHotspot {
  filePath: string;
  findingCount: number;
  severeCount: number;
  componentCount: number;
  worst: RerenderSeverity;
}

interface RuleCount {
  rule: RerenderRule;
  title: string;
  category: RerenderCategory;
  count: number;
}

interface RerenderReport {
  success: boolean;
  tool: "analyze_react_rerenders";
  projectPath: string;
  filePath?: string;
  minCascade: number;
  includeTests: boolean;
  filesScanned: number;
  componentsAnalyzed: number;
  memoComponents: number;
  totalFindings: number;
  projectFindingCount: number;
  filesAffected: number;
  largestCascade: { component: string; filePath: string; count: number } | null;
  summary: Record<RerenderSeverity, number>;
  categories: Record<RerenderCategory, number>;
  rules: RuleCount[];
  findings: RerenderFinding[];
  components: ComponentRender[];
  hotspots: RerenderHotspot[];
  warnings: string[];
}

interface AnalyzeReactRerendersProps {
  projectPath: string;
  onProjectPathChange?: (value: string) => void;
  apiUrl?: string;
}

type ViewMode = "issues" | "components";
type SeverityFilter = "all" | "critical" | "high" | "medium" | "low";
type CategoryFilter = "all" | RerenderCategory;
type IssueSort = "impact" | "severity" | "file";
type ComponentSort = "problems" | "cascade" | "name";

const DEFAULT_API_URL = "http://127.0.0.1:4174/api/analyze-react-rerenders";

const SEVERITY_RANK: Record<RerenderSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

const CATEGORY_LABEL: Record<RerenderCategory, string> = {
  loop: "Render loops",
  remount: "Remounting",
  memo: "Broken memo",
  context: "Context",
  effects: "Effects",
  state: "State",
  lists: "Lists and keys",
  computation: "Computation",
  cascade: "Cascades",
};

const KIND_LABEL: Record<ComponentKind, string> = {
  function: "Function",
  arrow: "Arrow function",
  memo: "memo",
  forwardRef: "forwardRef",
  class: "Class",
};

function categoryIcon(category: RerenderCategory, size = 17) {
  switch (category) {
    case "loop":
      return <Repeat size={size} />;
    case "remount":
      return <RefreshCw size={size} />;
    case "memo":
      return <Shield size={size} />;
    case "context":
      return <Network size={size} />;
    case "effects":
      return <Zap size={size} />;
    case "state":
      return <Layers size={size} />;
    case "lists":
      return <ListOrdered size={size} />;
    case "computation":
      return <Cpu size={size} />;
    case "cascade":
      return <GitBranch size={size} />;
  }
}

function baseName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1];
}

function shortPath(filePath: string): string {
  return filePath.split("/").slice(-2).join("/");
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/* -------------------------------------------------------------------------- */
/*  Clipboard                                                                 */
/* -------------------------------------------------------------------------- */

function useCopy() {
  const [copied, setCopied] = useState("");
  const [failed, setFailed] = useState(false);

  async function copy(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setFailed(false);
      window.setTimeout(() => setCopied(""), 2000);
    } catch {
      setFailed(true);
    }
  }

  return { copied, failed, copy };
}

/* -------------------------------------------------------------------------- */
/*  Source frame                                                              */
/* -------------------------------------------------------------------------- */

function CodeFrame({ finding }: { finding: RerenderFinding }) {
  const lines = finding.snippet.split("\n");

  return (
    <div
      className="rr-code"
      role="region"
      aria-label={`Source of ${baseName(finding.filePath)} near line ${finding.line}`}
    >
      {lines.map((line, index) => {
        const number = finding.snippetStartLine + index;
        const hit = number >= finding.highlightStart && number <= finding.highlightEnd;

        return (
          <div key={number} className={`rr-code-line ${hit ? "hit" : "near"}`}>
            <span className="rr-code-number">{number}</span>
            <code>{line || " "}</code>
          </div>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Cascade                                                                   */
/* -------------------------------------------------------------------------- */

function CascadeList({
  component,
  onOpen,
  limit,
}: {
  component: ComponentRender;
  onOpen: (name: string, filePath: string) => void;
  limit?: number;
}) {
  const { cascade } = component;
  const nodes = limit ? cascade.nodes.slice(0, limit) : cascade.nodes;
  const hidden = cascade.count + cascade.boundaries - nodes.length;

  if (cascade.nodes.length === 0) {
    return (
      <div className="rr-cascade">
        <p className="rr-cascade-empty">
          {component.name} does not render any other project components, so
          nothing below it re-renders.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="rr-cascade-summary">
        <span className={`rr-chip ${cascade.count > 0 ? "warn" : "ok"}`}>
          {plural(cascade.count, "component")} re-render
        </span>
        <span className="rr-chip ok">
          {plural(cascade.boundaries, "memo boundary", "memo boundaries")}
        </span>
      </div>

      <ul className="rr-cascade" aria-label={`Components that re-render with ${component.name}`}>
        <li className="rr-cascade-root">
          <span className="rr-tree-mark" aria-hidden="true" />
          {component.name}
        </li>

        {nodes.map((node, index) => (
          <li
            key={`${node.filePath}:${node.name}:${index}`}
            className={`rr-cascade-item ${node.boundary ? "boundary" : ""}`}
            style={{ paddingLeft: `${12 + node.depth * 16}px` }}
          >
            <span className="rr-tree-mark" aria-hidden="true">
              {node.boundary ? "■" : "↻"}
            </span>
            <button
              type="button"
              onClick={() => onOpen(node.name, node.filePath)}
              title={node.filePath}
            >
              <span className="rr-cascade-name">{node.name}</span>
            </button>
            <span className="rr-cascade-file">{shortPath(node.filePath)}</span>
            {node.boundary && <span className="rr-cascade-tag">stops here</span>}
          </li>
        ))}

        {(cascade.truncated || hidden > 0) && (
          <li className="rr-cascade-more">
            {hidden > 0 ? `+${hidden} more not shown` : "More components not shown"}
          </li>
        )}
      </ul>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Suggested fix                                                             */
/* -------------------------------------------------------------------------- */

function FixPanel({ finding }: { finding: RerenderFinding }) {
  const { copied, failed, copy } = useCopy();
  const { suggestion } = finding;
  const hasBefore = Boolean(suggestion.before);
  const hasAfter = Boolean(suggestion.after);

  return (
    <section className="rr-box rr-refactor">
      <div className="rr-refactor-head">
        <h4>
          <Wrench size={14} /> Suggested fix
        </h4>

        <div className="rr-refactor-badges">
          <span className={`rr-confidence confidence-${suggestion.confidence}`}>
            {suggestion.confidence} confidence
          </span>
        </div>
      </div>

      <p className="rr-refactor-title">{suggestion.title}</p>
      <p>{suggestion.summary}</p>

      <ol className="rr-steps">
        {suggestion.steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>

      {(hasBefore || hasAfter) && (
        <div className={`rr-diff ${hasBefore && hasAfter ? "" : "single"}`}>
          {hasBefore && (
            <div className="rr-diff-pane before">
              <div className="rr-diff-label">Before</div>
              <pre>
                <code>{suggestion.before}</code>
              </pre>
            </div>
          )}

          {hasAfter && (
            <div className="rr-diff-pane after">
              <div className="rr-diff-label">After</div>
              <pre>
                <code>{suggestion.after}</code>
              </pre>
            </div>
          )}
        </div>
      )}

      <div className="rr-actions">
        {hasAfter && (
          <button type="button" onClick={() => copy("after", suggestion.after!)}>
            {copied === "after" ? <Check size={14} /> : <Copy size={14} />}
            {copied === "after" ? "Copied" : "Copy suggested code"}
          </button>
        )}

        <button
          type="button"
          onClick={() => copy("path", `${finding.filePath}:${finding.line}`)}
        >
          {copied === "path" ? <Check size={14} /> : <Copy size={14} />}
          {copied === "path" ? "Copied" : "Copy file:line"}
        </button>
      </div>

      {failed && (
        <p className="rr-fine-print">
          The browser blocked clipboard access. Select the code above and copy
          it manually.
        </p>
      )}

      {suggestion.caveats.length > 0 && (
        <ul className="rr-caveats">
          {suggestion.caveats.map((caveat, index) => (
            <li key={index}>{caveat}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Inspectors                                                                */
/* -------------------------------------------------------------------------- */

function FindingInspector({
  finding,
  component,
  onOpenComponent,
  onOpenByName,
}: {
  finding: RerenderFinding;
  component?: ComponentRender;
  onOpenComponent: (id: string) => void;
  onOpenByName: (name: string, filePath: string) => void;
}) {
  return (
    <div className="rr-inspector-body">
      <div className="rr-inspector-title">
        <div className={`rr-inspector-icon severity-${finding.severity}`}>
          {categoryIcon(finding.category, 20)}
        </div>

        <div>
          <span className={`rr-badge badge-${finding.severity}`}>
            {finding.severity}
          </span>
          <h3>{finding.title}</h3>
        </div>
      </div>

      <div className="rr-detail-grid">
        <div>
          <span>Category</span>
          <strong>{CATEGORY_LABEL[finding.category]}</strong>
        </div>
        <div>
          <span>Component</span>
          <strong>{finding.component}</strong>
        </div>
        <div>
          <span>{finding.rule === "memo-defeated" ? "Renders avoidable" : "Components affected"}</span>
          <strong>{finding.impact}</strong>
        </div>
        <div>
          <span>Location</span>
          <strong>
            {baseName(finding.filePath)}:{finding.line}
          </strong>
        </div>
      </div>

      <section className="rr-box">
        <h4>What is happening</h4>
        <p>{finding.description}</p>

        {finding.detail.length > 0 && (
          <>
            <span className="rr-box-label">Details</span>
            <ul className="rr-chips">
              {finding.detail.map((item, index) => (
                <li key={`${index}-${item}`} className="rr-chip warn" title={item}>
                  {item}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="rr-box">
        <h4>Where</h4>
        <p className="rr-location">
          <FileCode2 size={13} />
          <span title={finding.filePath}>
            {finding.filePath}:{finding.line}
            {finding.endLine > finding.line ? `-${finding.endLine}` : ""}
          </span>
        </p>
        <CodeFrame finding={finding} />
      </section>

      {component && component.cascade.nodes.length > 0 && (
        <section className="rr-box">
          <h4>
            What re-renders with{" "}
            <button
              type="button"
              className="rr-link-button"
              onClick={() => onOpenComponent(component.id)}
            >
              {component.name}
            </button>
          </h4>
          <CascadeList component={component} onOpen={onOpenByName} limit={14} />
        </section>
      )}

      <FixPanel key={`fix-${finding.id}`} finding={finding} />
    </div>
  );
}

function ComponentInspector({
  component,
  findings,
  onOpenFinding,
  onOpenByName,
  onOpenById,
}: {
  component: ComponentRender;
  findings: RerenderFinding[];
  onOpenFinding: (id: string) => void;
  onOpenByName: (name: string, filePath: string) => void;
  onOpenById: (id: string) => void;
}) {
  const triggers =
    component.stateCount +
    component.reducerCount +
    component.contexts.length +
    component.customHooks.length;

  return (
    <div className="rr-inspector-body">
      <div className="rr-inspector-title">
        <div className={`rr-inspector-icon severity-${component.severity}`}>
          <Layers size={20} />
        </div>

        <div>
          <span className={`rr-badge badge-${component.severity}`}>
            {component.severity === "none" ? "no issues" : component.severity}
          </span>
          <h3>{component.name}</h3>
        </div>
      </div>

      <div className="rr-detail-grid">
        <div>
          <span>Kind</span>
          <strong>{KIND_LABEL[component.kind]}</strong>
        </div>
        <div>
          <span>Memoized</span>
          <strong>{component.isMemo ? "Yes" : "No"}</strong>
        </div>
        <div>
          <span>Props</span>
          <strong>{component.propsCount}</strong>
        </div>
        <div>
          <span>Re-renders below it</span>
          <strong>{component.cascade.count}</strong>
        </div>
      </div>

      <section className="rr-box">
        <h4>What makes it render</h4>
        <p className="rr-location">
          <FileCode2 size={13} />
          <span title={component.filePath}>
            {component.filePath}:{component.line}-{component.endLine}
          </span>
        </p>

        <p>
          It re-renders whenever its parent does
          {component.isMemo ? " and its props change (memo skips the rest)" : ""}
          {triggers > 0 ? ", or when its own state or context changes." : "."}
        </p>

        {component.stateNames.length > 0 && (
          <>
            <span className="rr-box-label">State</span>
            <ul className="rr-chips">
              {component.stateNames.map((name) => (
                <li key={name} className="rr-chip teal">
                  {name}
                </li>
              ))}
              {component.reducerCount > 0 && (
                <li className="rr-chip teal">
                  {plural(component.reducerCount, "reducer")}
                </li>
              )}
            </ul>
          </>
        )}

        {component.stateNames.length === 0 && component.reducerCount > 0 && (
          <>
            <span className="rr-box-label">State</span>
            <ul className="rr-chips">
              <li className="rr-chip teal">
                {plural(component.reducerCount, "reducer")}
              </li>
            </ul>
          </>
        )}

        {component.contexts.length > 0 && (
          <>
            <span className="rr-box-label">Context</span>
            <ul className="rr-chips">
              {component.contexts.map((name) => (
                <li key={name} className="rr-chip teal">
                  {name}
                </li>
              ))}
            </ul>
          </>
        )}

        {component.customHooks.length > 0 && (
          <>
            <span className="rr-box-label">Custom hooks (may hold state)</span>
            <ul className="rr-chips">
              {component.customHooks.map((name) => (
                <li key={name} className="rr-chip">
                  {name}
                </li>
              ))}
            </ul>
          </>
        )}

        {component.parents.length > 0 && (
          <>
            <span className="rr-box-label">Rendered by</span>
            <ul className="rr-chips">
              {component.parents.map((name) => (
                <li key={name} className="rr-chip">
                  {name}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="rr-box">
        <h4>When {component.name} re-renders</h4>
        <CascadeList component={component} onOpen={onOpenByName} />
      </section>

      {component.children.length > 0 && (
        <section className="rr-box">
          <h4>Components it renders</h4>
          <ul className="rr-children">
            {component.children.map((child) => (
              <li key={child.componentId}>
                <div className="rr-child-head">
                  <button
                    type="button"
                    className="rr-link-button"
                    onClick={() => onOpenById(child.componentId)}
                  >
                    {child.name}
                  </button>
                  {child.isMemo && (
                    <span
                      className={`rr-chip ${child.unstableProps.length > 0 ? "warn" : "ok"}`}
                    >
                      {child.unstableProps.length > 0 ? "memo defeated" : "memo"}
                    </span>
                  )}
                </div>
                <p className="rr-child-file" title={child.filePath}>
                  {child.filePath}:{child.line}
                  {child.uses > 1 ? ` · used ${child.uses}×` : ""}
                </p>

                {child.unstableProps.length > 0 && (
                  <ul className="rr-chips">
                    {child.unstableProps.map((prop) => (
                      <li key={prop} className="rr-chip warn" title="New reference on every render">
                        {prop}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rr-box">
        <h4>Issues in this component</h4>
        {findings.length === 0 ? (
          <p>No avoidable re-render problems were found here.</p>
        ) : (
          <ul className="rr-chips">
            {findings.map((finding) => (
              <li key={finding.id}>
                <button
                  type="button"
                  className={`rr-chip rr-finding-chip badge-${finding.severity}`}
                  onClick={() => onOpenFinding(finding.id)}
                  title={finding.title}
                >
                  {finding.severity} · {finding.title}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  View                                                                      */
/* -------------------------------------------------------------------------- */

export default function AnalyzeReactRerenders({
  projectPath,
  onProjectPathChange,
  apiUrl = DEFAULT_API_URL,
}: AnalyzeReactRerendersProps) {
  const [focusFile, setFocusFile] = useState("");
  const [minCascade, setMinCascade] = useState("6");
  const [includeTests, setIncludeTests] = useState(false);

  const [report, setReport] = useState<RerenderReport | null>(null);
  const [view, setView] = useState<ViewMode>("issues");
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [selectedComponentId, setSelectedComponentId] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [issueSort, setIssueSort] = useState<IssueSort>("severity");
  const [componentSort, setComponentSort] = useState<ComponentSort>("problems");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function analyze() {
    if (!projectPath.trim()) {
      setError("Enter a project path before starting the analysis.");
      return;
    }

    const cascade = Number(minCascade);

    if (!Number.isInteger(cascade) || cascade < 2 || cascade > 100) {
      setError("Cascade threshold must be a whole number between 2 and 100.");
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
          minCascade: cascade,
          includeTests,
        }),
      });

      const data = await response.json();

      if (!response.ok || data.success === false) {
        throw new Error(data.error || "Re-render analysis failed.");
      }

      const next = data as RerenderReport;
      setReport(next);
      setSelectedFindingId(next.findings[0]?.id ?? null);
      setSelectedComponentId(next.components[0]?.id ?? null);
      setView(next.findings.length > 0 ? "issues" : "components");
      setSearch("");
      setSeverityFilter("all");
      setCategoryFilter("all");
      setIssueSort("severity");
      setComponentSort("problems");
    } catch (analysisError) {
      setError(
        analysisError instanceof Error
          ? analysisError.message
          : "Unable to analyze the project.",
      );
    } finally {
      setLoading(false);
    }
  }

  const componentById = useMemo(
    () => new Map((report?.components ?? []).map((item) => [item.id, item])),
    [report],
  );

  const findingsByComponent = useMemo(() => {
    const map = new Map<string, RerenderFinding[]>();
    for (const finding of report?.findings ?? []) {
      const list = map.get(finding.componentId) ?? [];
      list.push(finding);
      map.set(finding.componentId, list);
    }
    return map;
  }, [report]);

  const severityCounts = useMemo(() => {
    const counts: Record<SeverityFilter, number> = {
      all: report?.findings.length ?? 0,
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };
    for (const finding of report?.findings ?? []) {
      if (finding.severity !== "info") counts[finding.severity]++;
    }
    return counts;
  }, [report]);

  const visibleFindings = useMemo(() => {
    if (!report) return [];
    const query = search.trim().toLowerCase();

    const filtered = report.findings.filter((finding) => {
      if (severityFilter !== "all" && finding.severity !== severityFilter) return false;
      if (categoryFilter !== "all" && finding.category !== categoryFilter) return false;
      if (!query) return true;

      return [
        finding.title,
        finding.description,
        finding.component,
        finding.filePath,
        finding.rule,
        ...finding.detail,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

    return [...filtered].sort((a, b) => {
      if (issueSort === "impact") {
        return b.impact - a.impact || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      }
      if (issueSort === "file") {
        return a.filePath.localeCompare(b.filePath) || a.line - b.line;
      }
      return (
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.impact - a.impact
      );
    });
  }, [report, search, severityFilter, categoryFilter, issueSort]);

  const visibleComponents = useMemo(() => {
    if (!report) return [];
    const query = search.trim().toLowerCase();

    const filtered = report.components.filter((component) => {
      if (!query) return true;
      return `${component.name} ${component.filePath}`.toLowerCase().includes(query);
    });

    return [...filtered].sort((a, b) => {
      if (componentSort === "cascade") {
        return b.cascade.count - a.cascade.count || b.score - a.score;
      }
      if (componentSort === "name") return a.name.localeCompare(b.name);
      return b.score - a.score || b.cascade.count - a.cascade.count;
    });
  }, [report, search, componentSort]);

  const selectedFinding =
    visibleFindings.find((item) => item.id === selectedFindingId) ??
    visibleFindings[0] ??
    null;

  const selectedComponent =
    visibleComponents.find((item) => item.id === selectedComponentId) ??
    visibleComponents[0] ??
    null;

  function openComponentById(id: string) {
    if (!componentById.has(id)) return;
    setView("components");
    setSearch("");
    setSelectedComponentId(id);
  }

  function openComponentByName(name: string, filePath: string) {
    const match = report?.components.find(
      (item) => item.name === name && item.filePath === filePath,
    );
    if (match) openComponentById(match.id);
  }

  function openFinding(id: string) {
    setView("issues");
    setSearch("");
    setSeverityFilter("all");
    setCategoryFilter("all");
    setSelectedFindingId(id);
  }

  const maxCascade = Math.max(
    1,
    ...(report?.components ?? []).map((item) => item.cascade.count),
  );

  const topCascades = (report?.components ?? [])
    .filter((item) => item.cascade.count > 0)
    .sort((a, b) => b.cascade.count - a.cascade.count)
    .slice(0, 10);

  const severeCount = report ? report.summary.critical + report.summary.high : 0;

  return (
    <div className="rr-analyzer">
      <div className="rr-title-row">
        <div className="rr-title-icon">
          <RefreshCw size={24} />
        </div>

        <div>
          <h1>React Re-render Analyzer</h1>
          <p>
            Find the code that makes React render more than it needs to, see
            which components re-render together, and get a fix for each problem.
          </p>
        </div>
      </div>

      <section className="rr-input-card">
        <div className="rr-field rr-field-wide">
          <label htmlFor="rr-project-path">Project path</label>
          <input
            id="rr-project-path"
            value={projectPath}
            onChange={(event) => onProjectPathChange?.(event.target.value)}
            placeholder="/path/to/your/project"
          />
        </div>

        <div className="rr-field">
          <label htmlFor="rr-focus-file">Focus file (optional)</label>
          <input
            id="rr-focus-file"
            value={focusFile}
            onChange={(event) => setFocusFile(event.target.value)}
            placeholder="src/App.tsx"
          />
        </div>

        <button
          type="button"
          className="rr-analyze-button"
          onClick={analyze}
          disabled={loading}
        >
          {loading ? (
            <>
              <span className="rr-spinner" />
              Analyzing...
            </>
          ) : (
            <>
              <RefreshCw size={17} />
              Analyze Re-renders
            </>
          )}
        </button>

        <div className="rr-options">
          <div className="rr-field">
            <label htmlFor="rr-min-cascade">Cascade threshold</label>
            <input
              id="rr-min-cascade"
              type="number"
              min={2}
              max={100}
              value={minCascade}
              onChange={(event) => setMinCascade(event.target.value)}
            />
          </div>

          <label className="rr-check">
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
        <div className="rr-error" role="alert">
          <XCircle size={18} />
          {error}
        </div>
      )}

      {report && (
        <>
          <div className="rr-status-row">
            <div
              className={`rr-success ${report.totalFindings === 0 ? "" : "has-groups"}`}
            >
              {report.totalFindings === 0 ? (
                <CheckCircle2 size={18} />
              ) : (
                <AlertTriangle size={18} />
              )}
              <strong>{report.totalFindings}</strong>
              <span>
                re-render {report.totalFindings === 1 ? "issue" : "issues"} found
                {report.filePath ? ` in ${report.filePath}` : ""}
              </span>
            </div>

            <span className="rr-scope">
              {report.filesScanned} files · {report.componentsAnalyzed} components
              · {report.memoComponents} memoized
              {report.filePath
                ? ` · ${report.projectFindingCount} issues project-wide`
                : ""}
            </span>
          </div>

          <div className="rr-summary-grid">
            <button
              type="button"
              className={`rr-summary-card ${severityFilter === "high" ? "active" : ""}`}
              onClick={() => {
                setView("issues");
                setSeverityFilter(severityFilter === "critical" ? "all" : "critical");
              }}
              aria-pressed={severityFilter === "critical"}
            >
              <div className="rr-summary-icon tone-severe">
                <AlertTriangle size={17} />
              </div>
              <div>
                <strong>{severeCount}</strong>
                <span>
                  Critical and high · {report.summary.critical} critical
                </span>
              </div>
            </button>

            <div className="rr-summary-card static">
              <div className="rr-summary-icon tone-teal">
                <Layers size={17} />
              </div>
              <div>
                <strong>{report.componentsAnalyzed}</strong>
                <span>Components · {report.memoComponents} memoized</span>
              </div>
            </div>

            <button
              type="button"
              className="rr-summary-card"
              disabled={!report.largestCascade}
              onClick={() => {
                if (report.largestCascade) {
                  openComponentByName(
                    report.largestCascade.component,
                    report.largestCascade.filePath,
                  );
                }
              }}
            >
              <div className="rr-summary-icon tone-sky">
                <GitBranch size={17} />
              </div>
              <div>
                <strong>{report.largestCascade?.count ?? 0}</strong>
                <span className="rr-summary-sub">
                  Largest cascade
                  {report.largestCascade ? ` · ${report.largestCascade.component}` : ""}
                </span>
              </div>
            </button>

            <div className="rr-summary-card static">
              <div className="rr-summary-icon neutral">
                <FileCode2 size={17} />
              </div>
              <div>
                <strong>{report.filesAffected}</strong>
                <span>Files with issues</span>
              </div>
            </div>
          </div>

          <section className="rr-workspace">
            <div className="rr-groups-panel">
              <div className="rr-panel-header">
                <div>
                  <h2>{view === "issues" ? "Re-render Issues" : "Components"}</h2>
                  <p>
                    {view === "issues"
                      ? `${visibleFindings.length} of ${report.findings.length} issues`
                      : `${visibleComponents.length} of ${report.components.length} components`}
                  </p>
                </div>

                <div className="rr-count-pill">
                  {view === "issues" ? <AlertTriangle size={15} /> : <Layers size={15} />}
                  {view === "issues" ? visibleFindings.length : visibleComponents.length}
                </div>
              </div>

              <div className="rr-filters">
                <div className="rr-view-tabs" role="tablist" aria-label="List view">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={view === "issues"}
                    className={view === "issues" ? "active" : ""}
                    onClick={() => setView("issues")}
                  >
                    <AlertTriangle size={14} /> Issues
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={view === "components"}
                    className={view === "components" ? "active" : ""}
                    onClick={() => setView("components")}
                  >
                    <Layers size={14} /> Components
                  </button>
                </div>

                <div className="rr-search">
                  <Search size={17} />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={
                      view === "issues"
                        ? "Search by file, component or rule..."
                        : "Search by component or file..."
                    }
                    aria-label={view === "issues" ? "Search issues" : "Search components"}
                  />
                </div>

                {view === "issues" ? (
                  <>
                    <div
                      className="rr-type-filter"
                      role="group"
                      aria-label="Filter by severity"
                    >
                      {(["all", "critical", "high", "medium", "low"] as const).map(
                        (option) => (
                          <button
                            type="button"
                            key={option}
                            className={severityFilter === option ? "active" : ""}
                            aria-pressed={severityFilter === option}
                            onClick={() => setSeverityFilter(option)}
                          >
                            {option === "all"
                              ? "All"
                              : option.charAt(0).toUpperCase() + option.slice(1)}
                            <span className="rr-chip-count">{severityCounts[option]}</span>
                          </button>
                        ),
                      )}
                    </div>

                    <div className="rr-filter-selects">
                      <SecuritySelect
                        ariaLabel="Filter by category"
                        value={categoryFilter}
                        onChange={setCategoryFilter}
                        options={[
                          { value: "all", label: "All categories" },
                          ...(Object.keys(CATEGORY_LABEL) as RerenderCategory[])
                            .filter((category) => report.categories[category] > 0)
                            .map((category) => ({
                              value: category,
                              label: `${CATEGORY_LABEL[category]} (${report.categories[category]})`,
                            })),
                        ]}
                      />

                      <SecuritySelect
                        ariaLabel="Sort issues"
                        value={issueSort}
                        onChange={setIssueSort}
                        options={[
                          { value: "severity", label: "Sort: severity" },
                          { value: "impact", label: "Sort: impact" },
                          { value: "file", label: "Sort: file" },
                        ]}
                      />
                    </div>
                  </>
                ) : (
                  <div className="rr-filter-selects">
                    <SecuritySelect
                      ariaLabel="Sort components"
                      value={componentSort}
                      onChange={setComponentSort}
                      options={[
                        { value: "problems", label: "Sort: most problems" },
                        { value: "cascade", label: "Sort: largest cascade" },
                        { value: "name", label: "Sort: name" },
                      ]}
                    />
                  </div>
                )}
              </div>

              <div className="rr-groups-list">
                {view === "issues" ? (
                  report.findings.length === 0 ? (
                    <div className="rr-empty">
                      <CheckCircle2 size={34} />
                      <h3>No re-render issues found</h3>
                      <p>
                        Open the Components tab to see how renders spread through
                        your tree.
                      </p>
                    </div>
                  ) : visibleFindings.length === 0 ? (
                    <div className="rr-empty">
                      <RefreshCw size={34} />
                      <h3>No matching issues</h3>
                      <p>No issues match the current filters.</p>
                    </div>
                  ) : (
                    visibleFindings.map((finding) => (
                      <button
                        type="button"
                        key={finding.id}
                        className={`rr-item rr-sev-${finding.severity} ${
                          selectedFinding?.id === finding.id ? "selected" : ""
                        }`}
                        onClick={() => setSelectedFindingId(finding.id)}
                      >
                        <div className={`rr-item-icon severity-${finding.severity}`}>
                          {categoryIcon(finding.category)}
                        </div>

                        <div className="rr-item-content">
                          <div className="rr-group-top">
                            <span className={`rr-badge badge-${finding.severity}`}>
                              {finding.severity}
                            </span>
                            <span className="rr-kind-badge">
                              {CATEGORY_LABEL[finding.category]}
                            </span>
                          </div>

                          <h3>{finding.title}</h3>
                          <p className="rr-item-meta">
                            {finding.component} · {shortPath(finding.filePath)}:
                            {finding.line}
                          </p>
                        </div>

                        <span className="rr-item-stat" title="Components affected">
                          {finding.impact}
                          <small>affected</small>
                        </span>
                      </button>
                    ))
                  )
                ) : visibleComponents.length === 0 ? (
                  <div className="rr-empty">
                    <Layers size={34} />
                    <h3>No components found</h3>
                    <p>
                      No React components match. Check the project path or clear
                      the search.
                    </p>
                  </div>
                ) : (
                  visibleComponents.map((component) => (
                    <button
                      type="button"
                      key={component.id}
                      className={`rr-item rr-sev-${component.severity} ${
                        selectedComponent?.id === component.id ? "selected" : ""
                      }`}
                      onClick={() => setSelectedComponentId(component.id)}
                    >
                      <div className={`rr-item-icon severity-${component.severity}`}>
                        <Layers size={17} />
                      </div>

                      <div className="rr-item-content">
                        <div className="rr-group-top">
                          <span className={`rr-badge badge-${component.severity}`}>
                            {component.severity === "none"
                              ? "clean"
                              : plural(component.findingCount, "issue")}
                          </span>
                          {component.isMemo && <span className="rr-kind-badge">memo</span>}
                          {component.kind === "class" && (
                            <span className="rr-kind-badge">class</span>
                          )}
                        </div>

                        <h3>{component.name}</h3>
                        <p className="rr-item-meta">
                          {shortPath(component.filePath)}:{component.line} ·{" "}
                          {plural(component.stateCount + component.reducerCount, "state value")} ·{" "}
                          {plural(component.children.length, "child", "children")}
                        </p>
                      </div>

                      <span className="rr-item-stat" title="Components that re-render below it">
                        {component.cascade.count}
                        <small>below</small>
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>

            <aside className="rr-inspector">
              <div className="rr-panel-header">
                <div>
                  <h2>Inspector</h2>
                  <p>
                    {view === "issues"
                      ? "Why it renders too often and how to fix it"
                      : "What triggers this component and what renders with it"}
                  </p>
                </div>
              </div>

              {view === "issues" && selectedFinding ? (
                <FindingInspector
                  key={selectedFinding.id}
                  finding={selectedFinding}
                  component={componentById.get(selectedFinding.componentId)}
                  onOpenComponent={openComponentById}
                  onOpenByName={openComponentByName}
                />
              ) : view === "components" && selectedComponent ? (
                <ComponentInspector
                  key={selectedComponent.id}
                  component={selectedComponent}
                  findings={findingsByComponent.get(selectedComponent.id) ?? []}
                  onOpenFinding={openFinding}
                  onOpenByName={openComponentByName}
                  onOpenById={openComponentById}
                />
              ) : (
                <div className="rr-inspector-empty">
                  <RefreshCw size={38} />
                  <h3>{view === "issues" ? "Select an issue" : "Select a component"}</h3>
                  <p>
                    {view === "issues"
                      ? "Choose an issue from the list to see the code, what it affects and a suggested fix."
                      : "Choose a component to see what makes it render and which components render with it."}
                  </p>
                </div>
              )}
            </aside>
          </section>

          {topCascades.length > 0 && (
            <section className="rr-hotspots rr-bars-section">
              <div className="rr-panel-header">
                <div>
                  <h2>Largest re-render cascades</h2>
                  <p>
                    Components that pull the most others into a render. Select
                    one to inspect it.
                  </p>
                </div>
              </div>

              <ul className="rr-bars">
                {topCascades.map((component) => (
                  <li key={component.id}>
                    <button
                      type="button"
                      onClick={() => openComponentById(component.id)}
                    >
                      <span className="rr-bars-name" title={component.filePath}>
                        {component.name}
                      </span>
                      <span className="rr-bars-value">{component.cascade.count}</span>
                      <span className="rr-bars-track" aria-hidden="true">
                        <span
                          className="rr-bars-fill"
                          style={{
                            width: `${Math.max(4, (component.cascade.count / maxCascade) * 100)}%`,
                          }}
                        />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {report.hotspots.length > 0 && (
            <section className="rr-hotspots">
              <div className="rr-panel-header">
                <div>
                  <h2>Files with the most issues</h2>
                  <p>Select one to filter the issue list.</p>
                </div>
              </div>

              <ul>
                {report.hotspots.map((file) => (
                  <li key={file.filePath}>
                    <button
                      type="button"
                      onClick={() => {
                        setView("issues");
                        setSearch(file.filePath);
                        setSeverityFilter("all");
                        setCategoryFilter("all");
                      }}
                    >
                      <FileCode2 size={14} />
                      <span title={file.filePath}>{file.filePath}</span>
                      <em>
                        {file.severeCount > 0
                          ? `${file.severeCount} severe`
                          : file.worst}
                      </em>
                      <strong>{file.findingCount}</strong>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {report.warnings.length > 0 && (
            <section className="rr-analysis-notes">
              <AlertTriangle size={18} />
              <div>
                <h3>Analysis notes</h3>
                {report.warnings.map((warning, index) => (
                  <p key={`${index}-${warning}`}>• {warning}</p>
                ))}
              </div>
            </section>
          )}

          <section className="rr-analysis-notes">
            <AlertTriangle size={18} />
            <div>
              <h3>About these results</h3>
              <p>
                This is a static analysis. It finds patterns that commonly cause
                extra renders, but it cannot tell how slow a render is or how
                often it happens. Confirm with the React DevTools Profiler before
                optimizing.
              </p>
            </div>
          </section>
        </>
      )}
    </div>
  );
}