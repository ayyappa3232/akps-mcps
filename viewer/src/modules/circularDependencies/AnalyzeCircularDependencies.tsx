import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  Braces,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  FileCode2,
  Layers,
  Repeat,
  Scissors,
  Search,
  Wrench,
  XCircle,
} from "lucide-react";
import "./analyze-circular-dependencies.css";

type CycleSeverity = "critical" | "high" | "medium" | "low" | "info";
type CycleKind = "runtime" | "lazy" | "type-only";

interface CycleEdge {
  from: string;
  to: string;
  line: number;
  column: number;
  kind: "import" | "side-effect" | "re-export" | "dynamic" | "require";
  mode: CycleKind;
  bindings: number;
  statement: string;
}

interface CycleWeakestLink {
  from: string;
  to: string;
  line: number;
  reason: string;
}

type FixStrategy =
  | "type-only-import"
  | "barrel-direct-import"
  | "extract-shared-module"
  | "remove-self-import"
  | "no-change-needed"
  | "manual";

interface FixChange {
  filePath: string;
  action: "modify" | "create";
  description: string;
  diff: string;
}

interface CycleFix {
  strategy: FixStrategy;
  confidence: "high" | "medium" | "low";
  title: string;
  summary: string;
  steps: string[];
  changes: FixChange[];
  patch: string;
  caveats: string[];
}

interface CircularDependencyCycle {
  id: string;
  severity: CycleSeverity;
  kind: CycleKind;
  score: number;
  length: number;
  title: string;
  description: string;
  recommendation: string;
  files: string[];
  edges: CycleEdge[];
  groupId: string;
  groupSize: number;
  involvesBarrel: boolean;
  weakestLink: CycleWeakestLink;
  fix?: CycleFix;
}

interface EntangledFile {
  filePath: string;
  cycleCount: number;
  runtimeCycleCount: number;
}

interface CircularDependencyReport {
  success: boolean;
  tool: "analyze_circular_dependencies";
  projectPath: string;
  filePath?: string;
  filesScanned: number;
  importEdges: number;
  unresolvedImports: number;
  totalCycles: number;
  runtimeCycles: number;
  lazyCycles: number;
  typeOnlyCycles: number;
  cycleGroups: number;
  filesInCycles: number;
  longestCycle: number;
  projectCycleCount: number;
  summary: Record<CycleSeverity, number>;
  cycles: CircularDependencyCycle[];
  entangledFiles: EntangledFile[];
  warnings: string[];
}

interface AnalyzeCircularDependenciesProps {
  projectPath: string;
  onProjectPathChange?: (value: string) => void;
  apiUrl?: string;
}

const DEFAULT_API_URL =
  "http://127.0.0.1:4174/api/analyze-circular-dependencies";

const KIND_LABEL: Record<CycleKind, string> = {
  runtime: "Runtime",
  lazy: "Lazy",
  "type-only": "Type-only",
};

function shortName(filePath: string): string {
  const parts = filePath.split("/");
  const name = parts[parts.length - 1];

  if (/^index\.[cm]?[jt]sx?$/.test(name) && parts.length > 1) {
    return `${parts[parts.length - 2]}/${name}`;
  }

  return name;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function loopLabel(files: string[]): string {
  const names = files.map(shortName);
  const shown = names.length > 5 ? [...names.slice(0, 4), "…"] : names;
  return [...shown, names[0]].join(" → ");
}

function kindIcon(kind: CycleKind, size = 17) {
  if (kind === "lazy") return <Clock size={size} />;
  if (kind === "type-only") return <Braces size={size} />;
  return <Repeat size={size} />;
}

/* -------------------------------------------------------------------------- */
/*  Ring diagram                                                              */
/* -------------------------------------------------------------------------- */

const RING_WIDTH = 460;
const RING_HEIGHT = 300;
const RING_CX = RING_WIDTH / 2;
const RING_CY = RING_HEIGHT / 2 - 2;
const NODE_RADIUS = 15;

interface Point {
  x: number;
  y: number;
}

function ringPoints(count: number): Point[] {
  if (count === 1) return [{ x: RING_CX, y: RING_CY + 14 }];

  const radius =
    count === 2 ? 100 : Math.min(100, Math.max(70, 56 + count * 7));
  const start = count === 2 ? Math.PI : -Math.PI / 2;

  return Array.from({ length: count }, (_, index) => {
    const angle = start + (2 * Math.PI * index) / count;
    return {
      x: RING_CX + radius * Math.cos(angle),
      y: RING_CY + radius * Math.sin(angle),
    };
  });
}

function edgePath(
  from: Point,
  to: Point,
  count: number
): { d: string; mid: Point } {
  if (count === 1) {
    return {
      d: `M ${from.x - 8} ${from.y - 13} C ${from.x - 46} ${from.y - 72}, ${
        from.x + 46
      } ${from.y - 72}, ${from.x + 9} ${from.y - 19}`,
      mid: { x: from.x, y: from.y - 56 },
    };
  }

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;

  // Two-file loops bow in opposite directions; longer loops bow outward.
  const bulge = count === 2 ? 40 : -16;
  const control = {
    x: (from.x + to.x) / 2 + -uy * bulge,
    y: (from.y + to.y) / 2 + ux * bulge,
  };

  const toControl = Math.hypot(control.x - from.x, control.y - from.y) || 1;
  const fromControl = Math.hypot(to.x - control.x, to.y - control.y) || 1;

  const start = {
    x: from.x + ((control.x - from.x) / toControl) * (NODE_RADIUS + 1),
    y: from.y + ((control.y - from.y) / toControl) * (NODE_RADIUS + 1),
  };
  const end = {
    x: to.x - ((to.x - control.x) / fromControl) * (NODE_RADIUS + 5),
    y: to.y - ((to.y - control.y) / fromControl) * (NODE_RADIUS + 5),
  };

  return {
    d: `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`,
    mid: {
      x: 0.25 * start.x + 0.5 * control.x + 0.25 * end.x,
      y: 0.25 * start.y + 0.5 * control.y + 0.25 * end.y,
    },
  };
}

function CycleRing({ cycle }: { cycle: CircularDependencyCycle }) {
  const count = cycle.files.length;
  const points = ringPoints(count);
  const showLabels = count <= 8;

  return (
    <svg
      className="circular-ring"
      viewBox={`0 0 ${RING_WIDTH} ${RING_HEIGHT}`}
      role="img"
      aria-label={`Import loop: ${loopLabel(cycle.files)}`}
    >
      <defs>
        <marker
          id="circular-arrow"
          viewBox="0 0 8 8"
          refX="6"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0,0 L8,4 L0,8 z" className="circular-arrow-head" />
        </marker>
        <marker
          id="circular-arrow-weak"
          viewBox="0 0 8 8"
          refX="6"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0,0 L8,4 L0,8 z" className="circular-arrow-head weak" />
        </marker>
      </defs>

      {cycle.edges.map((edge, index) => {
        const from = points[index];
        const to = points[(index + 1) % count];
        const { d } = edgePath(from, to, count);
        const isWeak =
          edge.from === cycle.weakestLink.from &&
          edge.to === cycle.weakestLink.to;

        return (
          <path
            key={`${edge.from}->${edge.to}`}
            d={d}
            fill="none"
            className={`circular-ring-edge mode-${edge.mode} ${
              isWeak ? "weak" : ""
            }`}
            markerEnd={`url(#${
              isWeak ? "circular-arrow-weak" : "circular-arrow"
            })`}
          >
            <title>
              {`${edge.from} → ${edge.to} (line ${edge.line})`}
            </title>
          </path>
        );
      })}

      {cycle.files.map((file, index) => {
        const point = points[index];
        const angle =
          count === 1
            ? Math.PI / 2
            : Math.atan2(point.y - RING_CY, point.x - RING_CX);
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const anchor = cos > 0.35 ? "start" : cos < -0.35 ? "end" : "middle";

        return (
          <g key={file}>
            <circle
              cx={point.x}
              cy={point.y}
              r={NODE_RADIUS}
              className="circular-ring-node"
            />
            <text
              x={point.x}
              y={point.y}
              className="circular-ring-index"
              textAnchor="middle"
              dy="0.35em"
            >
              {index + 1}
            </text>
            {showLabels && (
              <text
                x={point.x + cos * (NODE_RADIUS + 9)}
                y={point.y + sin * (NODE_RADIUS + 14)}
                className="circular-ring-label"
                textAnchor={anchor}
                dy="0.35em"
              >
                {truncate(shortName(file), 18)}
                <title>{file}</title>
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/*  Ready-made fix                                                            */
/* -------------------------------------------------------------------------- */

const STRATEGY_LABEL: Record<FixStrategy, string> = {
  "type-only-import": "Type-only import",
  "barrel-direct-import": "Skip the barrel",
  "extract-shared-module": "Extract shared module",
  "remove-self-import": "Remove self-import",
  "no-change-needed": "No change needed",
  manual: "Manual refactor",
};

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="circular-diff">
      {diff.split("\n").map((rawLine, index) => {
        const line = rawLine.replace(/\r$/, "");
        const tone = line.startsWith("@@")
          ? "hunk"
          : line.startsWith("+")
            ? "add"
            : line.startsWith("-")
              ? "del"
              : "";

        return (
          <span key={index} className={tone}>
            {line || " "}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

function FixPanel({ cycle }: { cycle: CircularDependencyCycle }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const fix = cycle.fix;

  if (!fix) {
    return (
      <section className="circular-detail-box circular-recommendation">
        <h4>Recommended fix</h4>
        <p>{cycle.recommendation}</p>
        <p className="circular-weak-reason">
          A ready-made patch is generated for the highest-risk cycles. Enter a
          focus file that is part of this loop and analyze again to get one for
          this cycle.
        </p>
      </section>
    );
  }

  async function copyPatch() {
    try {
      await navigator.clipboard.writeText(fix!.patch);
      setCopied(true);
      setCopyFailed(false);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    <section className="circular-detail-box circular-recommendation circular-fix">
      <div className="circular-fix-head">
        <h4>
          <Wrench size={14} /> Ready-made fix
        </h4>
        <div className="circular-fix-badges">
          <span className="circular-kind-badge">
            {STRATEGY_LABEL[fix.strategy]}
          </span>
          <span className={`circular-confidence confidence-${fix.confidence}`}>
            {fix.confidence} confidence
          </span>
        </div>
      </div>

      <p className="circular-fix-title">{fix.title}</p>
      <p>{fix.summary}</p>

      {fix.strategy === "manual" && (
        <div className="circular-weak-link">
          <Scissors size={14} />
          <span>
            {shortName(cycle.weakestLink.from)} →{" "}
            {shortName(cycle.weakestLink.to)}
            <em> · line {cycle.weakestLink.line}</em>
          </span>
        </div>
      )}

      <ol className="circular-fix-steps">
        {fix.steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>

      {fix.changes.map((change) => (
        <div className="circular-change" key={change.filePath}>
          <div className="circular-change-head">
            <span
              className={`circular-change-action action-${change.action}`}
            >
              {change.action === "create" ? "New file" : "Modify"}
            </span>
            <span className="circular-change-path" title={change.filePath}>
              {change.filePath}
            </span>
          </div>
          <p className="circular-change-desc">{change.description}</p>
          <DiffView diff={change.diff} />
        </div>
      ))}

      {fix.patch && (
        <div className="circular-patch-actions">
          <button type="button" onClick={copyPatch}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Copied" : "Copy patch"}
          </button>
          <code>git apply --check fix.patch &amp;&amp; git apply fix.patch</code>
        </div>
      )}

      {copyFailed && (
        <p className="circular-weak-reason">
          The browser blocked clipboard access. Select the diffs above and copy
          them manually.
        </p>
      )}

      {fix.caveats.length > 0 && (
        <ul className="circular-caveats">
          {fix.caveats.map((caveat, index) => (
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

export default function AnalyzeCircularDependencies({
  projectPath,
  onProjectPathChange,
  apiUrl = DEFAULT_API_URL,
}: AnalyzeCircularDependenciesProps) {
  const [focusFile, setFocusFile] = useState("");
  const [report, setReport] = useState<CircularDependencyReport | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<"all" | CycleKind>("all");
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
        }),
      });

      const data = await response.json();

      if (!response.ok || data.success === false) {
        throw new Error(data.error || "Circular dependency analysis failed.");
      }

      const nextReport = data as CircularDependencyReport;
      setReport(nextReport);
      setSelectedId(nextReport.cycles[0]?.id ?? null);
      setSearch("");
      setKind("all");
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

  const filteredCycles = useMemo(() => {
    if (!report) return [];

    const query = search.trim().toLowerCase();

    return report.cycles.filter((cycle) => {
      if (kind !== "all" && cycle.kind !== kind) return false;
      if (!query) return true;

      return [cycle.title, cycle.description, cycle.files.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [report, search, kind]);

  const selectedCycle =
    filteredCycles.find((cycle) => cycle.id === selectedId) ??
    filteredCycles[0] ??
    null;

  const summaryCards: Array<{
    key: CycleKind;
    label: string;
    count: number;
  }> = report
    ? [
        { key: "runtime", label: "Runtime cycles", count: report.runtimeCycles },
        { key: "lazy", label: "Lazy cycles", count: report.lazyCycles },
        {
          key: "type-only",
          label: "Type-only cycles",
          count: report.typeOnlyCycles,
        },
      ]
    : [];

  return (
    <div className="circular-analyzer">
      <div className="circular-title-row">
        <div className="circular-title-icon">
          <Repeat size={24} />
        </div>

        <div>
          <h1>Circular Dependency Analyzer</h1>
          <p>
            Find files that import each other in a loop, see the exact import
            lines, and get the cheapest place to break each cycle.
          </p>
        </div>
      </div>

      <section className="circular-input-card">
        <div className="circular-field">
          <label htmlFor="circular-project-path">Project path</label>
          <input
            id="circular-project-path"
            value={projectPath}
            onChange={(event) => onProjectPathChange?.(event.target.value)}
            placeholder="/path/to/your/project"
          />
        </div>

        <div className="circular-field">
          <label htmlFor="circular-focus-file">Focus file (optional)</label>
          <input
            id="circular-focus-file"
            value={focusFile}
            onChange={(event) => setFocusFile(event.target.value)}
            placeholder="src/App.tsx"
          />
        </div>

        <button
          type="button"
          className="circular-analyze-button"
          onClick={analyze}
          disabled={loading}
        >
          {loading ? (
            <>
              <span className="circular-spinner" />
              Analyzing...
            </>
          ) : (
            <>
              <Repeat size={17} />
              Find Cycles
            </>
          )}
        </button>
      </section>

      {error && (
        <div className="circular-error" role="alert">
          <XCircle size={18} />
          {error}
        </div>
      )}

      {report && (
        <>
          <div className="circular-status-row">
            <div
              className={`circular-success ${
                report.totalCycles === 0 ? "" : "has-cycles"
              }`}
            >
              {report.totalCycles === 0 ? (
                <CheckCircle2 size={18} />
              ) : (
                <AlertTriangle size={18} />
              )}
              <strong>{report.totalCycles}</strong>
              <span>
                {report.totalCycles === 1 ? "cycle" : "cycles"} found
                {report.filePath ? ` involving ${report.filePath}` : ""}
              </span>
            </div>

            <span className="circular-scope">
              {report.filesScanned} files · {report.importEdges} import links
              {report.filePath
                ? ` · ${report.projectCycleCount} cycles project-wide`
                : ""}
            </span>
          </div>

          <div className="circular-summary-grid">
            {summaryCards.map((card) => (
              <button
                type="button"
                key={card.key}
                className={`circular-summary-card kind-${card.key} ${
                  kind === card.key ? "active" : ""
                }`}
                onClick={() => setKind(kind === card.key ? "all" : card.key)}
                aria-pressed={kind === card.key}
              >
                <div className="circular-summary-icon">
                  {kindIcon(card.key)}
                </div>
                <div>
                  <strong>{card.count}</strong>
                  <span>{card.label}</span>
                </div>
              </button>
            ))}

            <div className="circular-summary-card static">
              <div className="circular-summary-icon neutral">
                <Layers size={17} />
              </div>
              <div>
                <strong>{report.filesInCycles}</strong>
                <span>
                  Files in cycles
                  {report.longestCycle > 0
                    ? ` · longest ${report.longestCycle}`
                    : ""}
                </span>
              </div>
            </div>
          </div>

          {report.totalCycles === 0 ? (
            <section className="circular-clean">
              <CheckCircle2 size={38} />
              <h3>No circular dependencies</h3>
              <p>
                None of the {report.filesScanned} analyzed files import each
                other in a loop
                {report.filePath ? ` through ${report.filePath}` : ""}.
              </p>
            </section>
          ) : (
            <section className="circular-workspace">
              <div className="circular-cycles-panel">
                <div className="circular-panel-header">
                  <div>
                    <h2>Import Cycles</h2>
                    <p>
                      {filteredCycles.length} of {report.cycles.length} cycles
                    </p>
                  </div>

                  <div className="circular-count-pill">
                    <Repeat size={15} />
                    {filteredCycles.length}
                  </div>
                </div>

                <div className="circular-filters">
                  <div className="circular-search">
                    <Search size={17} />
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search by file or cycle..."
                      aria-label="Search cycles"
                    />
                  </div>

                  <div
                    className="circular-kind-filter"
                    role="group"
                    aria-label="Filter by cycle kind"
                  >
                    {(["all", "runtime", "lazy", "type-only"] as const).map(
                      (option) => (
                        <button
                          type="button"
                          key={option}
                          className={kind === option ? "active" : ""}
                          aria-pressed={kind === option}
                          onClick={() => setKind(option)}
                        >
                          {option === "all" ? "All" : KIND_LABEL[option]}
                        </button>
                      )
                    )}
                  </div>
                </div>

                <div className="circular-cycles-list">
                  {filteredCycles.length === 0 ? (
                    <div className="circular-empty">
                      <Repeat size={34} />
                      <h3>No matching cycles</h3>
                      <p>No cycles match the current filters.</p>
                    </div>
                  ) : (
                    filteredCycles.map((cycle) => (
                      <button
                        type="button"
                        key={cycle.id}
                        className={`circular-cycle ${
                          selectedCycle?.id === cycle.id ? "selected" : ""
                        }`}
                        onClick={() => setSelectedId(cycle.id)}
                      >
                        <div
                          className={`circular-cycle-icon severity-${cycle.severity}`}
                        >
                          {kindIcon(cycle.kind)}
                        </div>

                        <div className="circular-cycle-content">
                          <div className="circular-cycle-top">
                            <span
                              className={`circular-badge badge-${cycle.severity}`}
                            >
                              {cycle.severity}
                            </span>
                            <span className="circular-kind-badge">
                              {KIND_LABEL[cycle.kind]}
                            </span>
                            {cycle.involvesBarrel && (
                              <span className="circular-kind-badge">
                                Barrel
                              </span>
                            )}
                          </div>

                          <h3>{cycle.title}</h3>
                          <p className="circular-loop">
                            {loopLabel(cycle.files)}
                          </p>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>

              <aside className="circular-inspector">
                <div className="circular-panel-header">
                  <div>
                    <h2>Inspector</h2>
                    <p>Loop diagram and import lines for the selected cycle</p>
                  </div>
                </div>

                {selectedCycle ? (
                  <div className="circular-inspector-body">
                    <div className="circular-inspector-title">
                      <div
                        className={`circular-inspector-icon severity-${selectedCycle.severity}`}
                      >
                        {kindIcon(selectedCycle.kind, 20)}
                      </div>

                      <div>
                        <span
                          className={`circular-badge badge-${selectedCycle.severity}`}
                        >
                          {selectedCycle.severity}
                        </span>
                        <h3>{selectedCycle.title}</h3>
                      </div>
                    </div>

                    <div className="circular-ring-wrap">
                      <CycleRing cycle={selectedCycle} />
                      <div className="circular-legend">
                        <span>
                          <i className="legend-line" /> import link
                        </span>
                        <span>
                          <i className="legend-line weak" /> suggested cut
                        </span>
                        {selectedCycle.edges.some(
                          (edge) => edge.mode !== "runtime"
                        ) && (
                          <span>
                            <i className="legend-line soft" /> lazy / type-only
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="circular-detail-grid">
                      <div>
                        <span>Kind</span>
                        <strong>{KIND_LABEL[selectedCycle.kind]}</strong>
                      </div>
                      <div>
                        <span>Files in loop</span>
                        <strong>{selectedCycle.length}</strong>
                      </div>
                      <div>
                        <span>Risk score</span>
                        <strong>{selectedCycle.score} / 100</strong>
                      </div>
                      <div>
                        <span>Tangled group</span>
                        <strong>{selectedCycle.groupSize} files</strong>
                      </div>
                    </div>

                    <section className="circular-detail-box">
                      <h4>What this means</h4>
                      <p>{selectedCycle.description}</p>
                    </section>

                    <FixPanel key={selectedCycle.id} cycle={selectedCycle} />

                    <section className="circular-detail-box">
                      <h4>Import chain</h4>
                      <ol className="circular-steps">
                        {selectedCycle.edges.map((edge, index) => {
                          const isWeak =
                            edge.from === selectedCycle.weakestLink.from &&
                            edge.to === selectedCycle.weakestLink.to;

                          return (
                            <li
                              key={`${edge.from}->${edge.to}`}
                              className={isWeak ? "weak" : ""}
                            >
                              <div className="circular-step-file">
                                <span className="circular-step-index">
                                  {index + 1}
                                </span>
                                <FileCode2 size={13} />
                                <span title={edge.from}>{edge.from}</span>
                              </div>

                              <div className="circular-step-link">
                                <ArrowDown size={13} />
                                <span>
                                  line {edge.line}
                                  {edge.mode !== "runtime" &&
                                    ` · ${KIND_LABEL[edge.mode].toLowerCase()}`}
                                </span>
                              </div>

                              <pre>{edge.statement}</pre>
                            </li>
                          );
                        })}
                      </ol>
                      <p className="circular-steps-close">
                        …and {shortName(selectedCycle.files[0])} is imported
                        again, closing the loop.
                      </p>
                    </section>
                  </div>
                ) : (
                  <div className="circular-inspector-empty">
                    <Repeat size={38} />
                    <h3>Select a cycle</h3>
                    <p>
                      Choose a cycle from the list to see its loop diagram,
                      the import lines that form it, and how to break it.
                    </p>
                  </div>
                )}
              </aside>
            </section>
          )}

          {report.entangledFiles.length > 0 && (
            <section className="circular-entangled">
              <div className="circular-panel-header">
                <div>
                  <h2>Most entangled files</h2>
                  <p>Files that appear in the most cycles. Select one to filter.</p>
                </div>
              </div>

              <ul>
                {report.entangledFiles.map((file) => (
                  <li key={file.filePath}>
                    <button
                      type="button"
                      onClick={() => {
                        setSearch(file.filePath);
                        setKind("all");
                      }}
                    >
                      <FileCode2 size={14} />
                      <span title={file.filePath}>{file.filePath}</span>
                      <strong>{file.cycleCount}</strong>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {report.warnings.length > 0 && (
            <section className="circular-analysis-notes">
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