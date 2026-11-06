import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  ReactFlow,
  Controls,
  MarkerType,
  Position,
  type Edge,
  type Node,
  type ReactFlowInstance
} from "@xyflow/react";
import {
  AlertTriangle,
  CheckCircle2,
  FileCode2,
  GitBranch,
  Info,
  Layers3,
  ShieldAlert,
  Target,
  Users,
  ArrowDownRight,
  Lightbulb,
  List,
  Maximize2,
  Network,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import "@xyflow/react/dist/style.css";
import "./analyze-change-impact.css";

type Reference = {
  filePath: string;
  line: number;
  column: number;
  text: string;
  kind: "import" | "reference" | "definition" | "export";
};

type ImpactedFile = {
  filePath: string;
  impact: "direct" | "indirect";
  score: number;
  reasons: string[];
  references: Reference[];
};

type SymbolInfo = {
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
  exported: boolean;
};

type ChangeImpactReport = {
  success: boolean;
  tool: "analyze_change_impact";
  projectPath: string;
  target: { filePath?: string; symbol?: string };
  summary: {
    risk: "low" | "medium" | "high" | "critical";
    riskScore: number;
    directFiles: number;
    indirectFiles: number;
    affectedFiles: number;
    affectedSymbols: number;
    referenceCount: number;
  };
  directImpact: ImpactedFile[];
  indirectImpact: ImpactedFile[];
  affectedSymbols: SymbolInfo[];
  recommendations: string[];
  warnings: string[];
  error?: string;
};

type AnalyzeChangeImpactProps = {
  projectPath: string;
  apiUrl?: string;
  defaultFilePath?: string;
  defaultSymbol?: string;
};

const riskClass = (risk: ChangeImpactReport["summary"]["risk"]) => `aci-risk-${risk}`;

function RiskIcon({ risk }: { risk: ChangeImpactReport["summary"]["risk"] }) {
  if (risk === "low") return <CheckCircle2 size={21} />;
  if (risk === "critical") return <ShieldAlert size={21} />;
  return <AlertTriangle size={21} />;
}

function ImpactNode({
  label,
  subtitle,
  variant,
  score
}: {
  label: string;
  subtitle: string;
  variant: "target" | "direct" | "indirect";
  score?: number;
}) {
  return (
    <div className={`aci-node aci-node-${variant}`}>
      <div className="aci-node-icon">
        {variant === "target" ? <Target size={18} /> : <FileCode2 size={17} />}
      </div>
      <div className="aci-node-copy">
        <strong title={label}>{label}</strong>
        <span title={subtitle}>{subtitle}</span>
      </div>
      {score !== undefined && <span className="aci-node-score">{score}</span>}
    </div>
  );
}

function shortPath(filePath: string) {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return filePath;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function buildImpactGraph(report: ChangeImpactReport): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const rootId = "impact-target";
  const targetName = report.target.symbol || report.target.filePath || "Target";

  nodes.push({
    id: rootId,
    type: "default",
    position: { x: 40, y: 260 },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    data: {
      label: (
        <ImpactNode
          label={targetName}
          subtitle={report.target.filePath || "Symbol target"}
          variant="target"
        />
      )
    },
    style: { width: 300, padding: 0, border: "0", background: "transparent" }
  });

  const directX = 430;
  const indirectX = 820;
  const directSpacing = 104;
  const indirectSpacing = 104;
  const directStart = 180 - Math.max(0, report.directImpact.length - 1) * directSpacing / 2;
  const indirectStart = 180 - Math.max(0, report.indirectImpact.length - 1) * indirectSpacing / 2;

  report.directImpact.forEach((item, index) => {
    const id = `direct-${index}`;
    nodes.push({
      id,
      position: { x: directX, y: directStart + index * directSpacing },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        label: (
          <ImpactNode
            label={shortPath(item.filePath)}
            subtitle={item.reasons[0] || "Direct impact"}
            variant="direct"
            score={item.score}
          />
        )
      },
      style: { width: 330, padding: 0, border: "0", background: "transparent" }
    });
    edges.push({
      id: `edge-target-${id}`,
      source: rootId,
      target: id,
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: "#60a5fa", strokeWidth: 1.8 }
    });
  });

  report.indirectImpact.slice(0, 40).forEach((item, index) => {
    const id = `indirect-${index}`;
    nodes.push({
      id,
      position: { x: indirectX, y: indirectStart + index * indirectSpacing },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        label: (
          <ImpactNode
            label={shortPath(item.filePath)}
            subtitle={item.reasons[0] || "Indirect impact"}
            variant="indirect"
            score={item.score}
          />
        )
      },
      style: { width: 330, padding: 0, border: "0", background: "transparent" }
    });

    if (report.directImpact.length) {
      const parent = report.directImpact[index % report.directImpact.length];
      const parentIndex = report.directImpact.indexOf(parent);
      edges.push({
        id: `edge-${parentIndex}-${id}`,
        source: `direct-${parentIndex}`,
        target: id,
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: "#a78bfa", strokeWidth: 1.5, strokeDasharray: "6 4" }
      });
    } else {
      edges.push({
        id: `edge-target-${id}`,
        source: rootId,
        target: id,
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: "#a78bfa", strokeWidth: 1.5, strokeDasharray: "6 4" }
      });
    }
  });

  return { nodes, edges };
}

export default function AnalyzeChangeImpact({
  projectPath,
  apiUrl = "http://127.0.0.1:4174/api/analyze-change-impact",
  defaultFilePath = "viewer/src/App.tsx",
  defaultSymbol = "generateGraph"
}: AnalyzeChangeImpactProps) {
  const [filePath, setFilePath] = useState(defaultFilePath);
  const [symbol, setSymbol] = useState(defaultSymbol);
  const [caseSensitive, setCaseSensitive] = useState(true);
  const [report, setReport] = useState<ChangeImpactReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"overview" | "references" | "symbols" | "recommendations">("overview");
  const [selectedImpact, setSelectedImpact] = useState<ImpactedFile | null>(null);
  const [viewMode, setViewMode] = useState<"graph" | "tree">("graph");
  const graphPanelRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<ReactFlowInstance | null>(null);

  async function analyze() {
    setLoading(true);
    setError("");

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: projectPath.trim(),
          filePath: filePath.trim() || undefined,
          symbol: symbol.trim() || undefined,
          caseSensitive
        })
      });

      const result = (await response.json()) as ChangeImpactReport;
      if (!response.ok || !result.success) {
        throw new Error(result.error || `Request failed with status ${response.status}`);
      }

      setReport(result);
      setTab("overview");
      setSelectedImpact(null);
    } catch (err) {
      setReport(null);
      setError(err instanceof Error ? err.message : "Unable to analyze change impact.");
    } finally {
      setLoading(false);
    }
  }

  const graph = useMemo(() => (report ? buildImpactGraph(report) : { nodes: [], edges: [] }), [report]);

  useEffect(() => {
    if (!report || viewMode !== "graph") return;
    const timer = window.setTimeout(() => {
      flowRef.current?.fitView({ padding: 0.2, duration: 250, maxZoom: 1 });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [report, viewMode]);

  function fitGraph() {
    flowRef.current?.fitView({ padding: 0.2, duration: 250, maxZoom: 1 });
  }

  function zoomIn() {
    flowRef.current?.zoomIn({ duration: 180 });
  }

  function zoomOut() {
    flowRef.current?.zoomOut({ duration: 180 });
  }

  function toggleFullscreen() {
    const element = graphPanelRef.current;
    if (!element) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void element.requestFullscreen?.();
  }

  function openInspectorTab(nextTab: "overview" | "references" | "symbols" | "recommendations") {
    setSelectedImpact(null);
    setTab(nextTab);
  }
  const references = useMemo(() => {
    if (!report) return [] as { impact: "direct" | "indirect"; item: ImpactedFile; reference: Reference }[];
    return [
      ...report.directImpact.flatMap(item => item.references.map(reference => ({ impact: "direct" as const, item, reference }))),
      ...report.indirectImpact.flatMap(item => item.references.map(reference => ({ impact: "indirect" as const, item, reference })))
    ];
  }, [report]);

  const summaryCards = report
    ? [
        { icon: <RiskIcon risk={report.summary.risk} />, value: report.summary.risk.toUpperCase(), label: "Risk", className: riskClass(report.summary.risk) },
        { icon: <ShieldAlert size={21} />, value: report.summary.riskScore, label: "Risk score", className: "aci-score" },
        { icon: <GitBranch size={21} />, value: report.summary.directFiles, label: "Direct files", className: "aci-blue" },
        { icon: <Layers3 size={21} />, value: report.summary.indirectFiles, label: "Indirect files", className: "aci-purple" },
        { icon: <Users size={21} />, value: report.summary.affectedSymbols, label: "Affected symbols", className: "aci-neutral" },
        { icon: <Info size={21} />, value: report.summary.referenceCount, label: "References", className: "aci-neutral" }
      ]
    : [];

  return (
    <div className="aci">
      <header className="aci-heading">
        <div>
          <h2>Change Impact Analyzer</h2>
          <p>Inspect what may break or require review before you change a file, function, component, or symbol.</p>
        </div>
        <span className="aci-ready">{loading ? "Analyzing…" : report ? "Analysis ready" : "Ready"}</span>
      </header>

      <div className="aci-howto">
        <Lightbulb size={16} />
        <div><strong>How to use it:</strong> enter the source file and symbol you plan to change, then run the analysis. Direct files are immediate consumers; indirect files are downstream consumers that may be affected through those relationships.</div>
      </div>

      <div className="aci-controls-panel">
      <div className="aci-controls">
        <label>
          <span>File path</span>
          <small>Relative path of the code you plan to change.</small>
          <input value={filePath} onChange={e => setFilePath(e.target.value)} placeholder="src/App.tsx" />
        </label>
        <label>
          <span>Symbol / function / component</span>
          <small>Name of the function, component, class, or symbol.</small>
          <input value={symbol} onChange={e => setSymbol(e.target.value)} placeholder="generateGraph" />
        </label>
        <label className="aci-check">
          <span>Matching</span>
          <button type="button" className={caseSensitive ? "is-on" : ""} onClick={() => setCaseSensitive(v => !v)}>
            {caseSensitive ? "Case sensitive" : "Case insensitive"}
          </button>
        </label>
        <button className="aci-primary" type="button" onClick={() => void analyze()} disabled={loading || !projectPath.trim()}>
          {loading ? "Analyzing impact…" : "Analyze change impact"}
        </button>
      </div>
      </div>

      {error && <div className="aci-message error"><strong>Analysis failed:</strong> {error}</div>}

      {report && (
        <>
          <div className="aci-status">
            <span className={`aci-status-pill ${riskClass(report.summary.risk)}`}>
              <RiskIcon risk={report.summary.risk} />
              {report.summary.risk.toUpperCase()} risk · {report.summary.riskScore}/100
            </span>
            <span className="aci-target-line">
              {report.target.filePath || "Project"}{report.target.symbol ? ` · ${report.target.symbol}` : ""}
            </span>
          </div>

          <div className="aci-stats">
            {summaryCards.map(card => (
              <div className={`aci-stat ${card.className}`} key={card.label}>
                <span className="aci-stat-icon">{card.icon}</span>
                <span><strong>{card.value}</strong><small>{card.label}</small></span>
              </div>
            ))}
          </div>

          <div className="aci-workspace">
            <section className="aci-graph-panel" ref={graphPanelRef}>
              <div className="aci-panel-toolbar">
                <div>
                  <h3>Impact graph</h3>
                  <p>Target → direct consumers → downstream files</p>
                </div>
                <div className="aci-graph-toolbar">
                  <div className="aci-mode-switch">
                    <button type="button" className={viewMode === "graph" ? "active" : ""} onClick={() => setViewMode("graph")}><Network size={14} /> Graph</button>
                    <button type="button" className={viewMode === "tree" ? "active" : ""} onClick={() => setViewMode("tree")}><List size={14} /> Tree</button>
                  </div>
                  {viewMode === "graph" && (
                    <div className="aci-flow-tools">
                      <button type="button" onClick={fitGraph} title="Fit graph"><Maximize2 size={14} /><span>Fit</span></button>
                      <button type="button" onClick={zoomOut} title="Zoom out"><ZoomOut size={15} /></button>
                      <button type="button" onClick={zoomIn} title="Zoom in"><ZoomIn size={15} /></button>
                      <button type="button" onClick={toggleFullscreen} title="Fullscreen"><Maximize2 size={15} /></button>
                    </div>
                  )}
                </div>
              </div>
              <div className="aci-graph-description"><ArrowDownRight size={15} /><span><strong>How to read:</strong> the target is the code you plan to change. Blue nodes are direct consumers. Purple nodes are downstream files that may be affected indirectly. Click a node to inspect why it is affected.</span></div>
              <div className="aci-canvas">
                {viewMode === "graph" ? (
                <ReactFlow
                  nodes={graph.nodes}
                  edges={graph.edges}
                  onInit={(instance) => { flowRef.current = instance; }}
                  fitView
                  fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
                  minZoom={0.15}
                  maxZoom={1.5}
                  nodesDraggable
                  nodesConnectable={false}
                  elementsSelectable
                  onNodeClick={(_, node) => {
                    if (node.id === "impact-target") return;
                    const prefix = node.id.startsWith("direct-") ? "direct-" : "indirect-";
                    const index = Number(node.id.slice(prefix.length));
                    const source = prefix === "direct-" ? report.directImpact[index] : report.indirectImpact[index];
                    if (source) {
                      setSelectedImpact(source);
                      setTab("overview");
                    }
                  }}
                  proOptions={{ hideAttribution: true }}
                  colorMode="dark"
                >
                  <Background gap={22} size={1} color="#26364d" />
                  <Controls showInteractive={false} />
                </ReactFlow>
                ) : (
                  <div className="aci-tree-wrap">
                    <div className="aci-tree-intro"><List size={16} /><div><strong>Impact tree</strong><span>Scan the same impact relationships as a simple hierarchy.</span></div></div>
                    <div className="aci-tree">
                      <button type="button" className="aci-tree-row target" onClick={() => { setSelectedImpact(null); setTab("overview"); }}>
                        <span className="aci-tree-icon target"><Target size={14} /></span>
                        <span className="aci-tree-copy"><strong>{report.target.symbol || report.target.filePath || "Target"}</strong><small>{report.target.filePath || "Target file"}</small></span>
                        <span className="aci-mini-pill target">target</span>
                      </button>
                      <div className="aci-tree-group"><div className="aci-tree-group-title"><span>Direct impact</span><strong>{report.directImpact.length}</strong></div>
                        {report.directImpact.map((item, index) => (
                          <button type="button" className="aci-tree-row" key={`tree-direct-${index}`} onClick={() => setSelectedImpact(item)}>
                            <span className="aci-tree-icon direct"><FileCode2 size={14} /></span><span className="aci-tree-copy"><strong>{shortPath(item.filePath)}</strong><small>{item.reasons[0] || "Direct consumer"} · score {item.score}</small></span><span className="aci-mini-pill direct">direct</span>
                          </button>
                        ))}
                      </div>
                      <div className="aci-tree-group"><div className="aci-tree-group-title"><span>Indirect impact</span><strong>{report.indirectImpact.length}</strong></div>
                        {report.indirectImpact.map((item, index) => (
                          <button type="button" className="aci-tree-row" key={`tree-indirect-${index}`} onClick={() => setSelectedImpact(item)}>
                            <span className="aci-tree-icon indirect"><FileCode2 size={14} /></span><span className="aci-tree-copy"><strong>{shortPath(item.filePath)}</strong><small>{item.reasons[0] || "Downstream impact"} · score {item.score}</small></span><span className="aci-mini-pill indirect">indirect</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
              <div className="aci-legend">
                <div className="aci-legend-title">How to read the graph</div>
                <div className="aci-legend-items">
                  <div><span className="aci-legend-icon target"><Target size={14} /></span><span><strong>Target</strong><small>Code you plan to change</small></span></div>
                  <div><span className="aci-legend-icon direct"><FileCode2 size={14} /></span><span><strong>Direct impact</strong><small>Immediate consumer or reference</small></span></div>
                  <div><span className="aci-legend-icon indirect"><Layers3 size={14} /></span><span><strong>Indirect impact</strong><small>Downstream dependency</small></span></div>
                </div>
              </div>
            </section>

            <aside className="aci-inspector">
              <div className="aci-inspector-tabs">
                {(["overview", "references", "symbols", "recommendations"] as const).map(item => (
                  <button key={item} type="button" className={tab === item ? "active" : ""} onClick={() => openInspectorTab(item)}>
                    {item === "overview" ? "Overview" : item === "references" ? `References (${references.length})` : item === "symbols" ? `Symbols (${report.affectedSymbols.length})` : "Recommendations"}
                  </button>
                ))}
              </div>

              <div className="aci-inspector-body">
                {selectedImpact ? (
                  <div className="aci-selected-impact">
                    <button
                      type="button"
                      className="aci-back-references"
                      onClick={() => {
                        setSelectedImpact(null);
                        setTab("references");
                      }}
                    >
                      ← Back to References
                    </button>
                    <div className="aci-selected-heading">
                      <FileCode2 size={20} />
                      <div><strong>{shortPath(selectedImpact.filePath)}</strong><span>{selectedImpact.impact} impact · score {selectedImpact.score}</span></div>
                    </div>
                    <p>{selectedImpact.reasons.join(" · ")}</p>
                    <h4>References</h4>
                    {selectedImpact.references.map((reference, index) => (
                      <div className="aci-reference-card" key={`${reference.filePath}-${reference.line}-${index}`}>
                        <div><span>{reference.kind}</span><span>Line {reference.line}</span></div>
                        <code>{reference.text}</code>
                      </div>
                    ))}
                  </div>
                ) : tab === "overview" ? (
                  <div className="aci-overview">
                    <div className="aci-risk-banner">
                      <RiskIcon risk={report.summary.risk} />
                      <div><strong>{report.summary.risk.toUpperCase()} change risk</strong><span>Risk score {report.summary.riskScore}/100 based on reference depth and affected consumers.</span></div>
                    </div>
                    <div className="aci-fact"><span>Target</span><strong>{report.target.symbol || "File change"}</strong></div>
                    <div className="aci-fact"><span>Direct impact</span><strong>{report.summary.directFiles} file{report.summary.directFiles === 1 ? "" : "s"}</strong></div>
                    <div className="aci-fact"><span>Downstream impact</span><strong>{report.summary.indirectFiles} file{report.summary.indirectFiles === 1 ? "" : "s"}</strong></div>
                    <div className="aci-fact"><span>References inspected</span><strong>{report.summary.referenceCount}</strong></div>
                  </div>
                ) : tab === "references" ? (
                  <div className="aci-list">
                    {references.length ? references.map((entry, index) => (
                      <button type="button" className="aci-reference-row" key={`${entry.reference.filePath}-${entry.reference.line}-${index}`} onClick={() => setSelectedImpact(entry.item)}>
                        <span className={`aci-mini-pill ${entry.impact}`}>{entry.impact}</span>
                        <div><strong>{shortPath(entry.reference.filePath)}</strong><span>Line {entry.reference.line} · {entry.reference.kind}</span><code>{entry.reference.text}</code></div>
                      </button>
                    )) : <p className="aci-empty">No references found.</p>}
                  </div>
                ) : tab === "symbols" ? (
                  <div className="aci-list">
                    {report.affectedSymbols.map((item, index) => (
                      <div className="aci-symbol-row" key={`${item.filePath}-${item.name}-${item.startLine}-${index}`}>
                        <div><strong>{item.name}</strong><span>{item.kind} · {shortPath(item.filePath)}</span></div>
                        <span>Lines {item.startLine}–{item.endLine}{item.exported ? " · exported" : ""}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="aci-list">
                    {report.recommendations.map((recommendation, index) => (
                      <div className="aci-recommendation" key={index}><span>{index + 1}</span><p>{recommendation}</p></div>
                    ))}
                  </div>
                )}
              </div>
            </aside>
          </div>
        </>
      )}

      {report && (
        <section className="aci-data-panel">
          <div className="aci-data-header">
            <div><h3>Impact details</h3><p>Review the files and references behind the graph.</p></div>
            <div className="aci-data-tabs">
              <button type="button" className={tab === "overview" ? "active" : ""} onClick={() => openInspectorTab("overview")}>Overview</button>
              <button type="button" className={tab === "references" ? "active" : ""} onClick={() => openInspectorTab("references")}>References ({references.length})</button>
              <button type="button" className={tab === "symbols" ? "active" : ""} onClick={() => openInspectorTab("symbols")}>Symbols ({report.affectedSymbols.length})</button>
              <button type="button" className={tab === "recommendations" ? "active" : ""} onClick={() => openInspectorTab("recommendations")}>Recommendations</button>
            </div>
          </div>
          <div className="aci-impact-table-wrap">
            {tab === "references" ? (
              <table className="aci-impact-table"><thead><tr><th>#</th><th>Impact</th><th>File</th><th>Line</th><th>Kind</th><th>Reference</th></tr></thead><tbody>
                {references.map((entry, index) => <tr key={`${entry.reference.filePath}-${entry.reference.line}-${index}`}><td>{index + 1}</td><td><span className={`aci-mini-pill ${entry.impact}`}>{entry.impact}</span></td><td>{shortPath(entry.reference.filePath)}</td><td>{entry.reference.line}</td><td>{entry.reference.kind}</td><td><code>{entry.reference.text}</code></td></tr>)}
              </tbody></table>
            ) : tab === "symbols" ? (
              <table className="aci-impact-table"><thead><tr><th>#</th><th>Symbol</th><th>Kind</th><th>File</th><th>Lines</th><th>Exported</th></tr></thead><tbody>
                {report.affectedSymbols.map((item, index) => <tr key={`${item.filePath}-${item.name}-${index}`}><td>{index + 1}</td><td><strong>{item.name}</strong></td><td>{item.kind}</td><td>{shortPath(item.filePath)}</td><td>{item.startLine}–{item.endLine}</td><td>{item.exported ? "Yes" : "No"}</td></tr>)}
              </tbody></table>
            ) : (
              <table className="aci-impact-table"><thead><tr><th>#</th><th>File</th><th>Impact</th><th>Score</th><th>Why affected</th><th>References</th></tr></thead><tbody>
                {[...report.directImpact, ...report.indirectImpact].map((item, index) => <tr key={`${item.filePath}-${index}`} onClick={() => setSelectedImpact(item)}><td>{index + 1}</td><td><strong>{shortPath(item.filePath)}</strong><span>{item.filePath}</span></td><td><span className={`aci-mini-pill ${item.impact}`}>{item.impact}</span></td><td><strong>{item.score}</strong></td><td>{item.reasons.join(" · ")}</td><td>{item.references.length}</td></tr>)}
              </tbody></table>
            )}
          </div>
        </section>
      )}

      {report && (
        <div className="aci-bottom-summary">
          <div><strong>Before you change the code</strong><span>Review direct consumers first, inspect high-score downstream files, and run focused tests around the target and its affected consumers.</span></div>
          <span className={`aci-bottom-risk ${riskClass(report.summary.risk)}`}>{report.summary.risk.toUpperCase()} · {report.summary.riskScore}/100</span>
        </div>
      )}

      {!report && !error && !loading && (
        <div className="aci-empty-state">
          <div className="aci-empty-icon"><Target size={28} /></div>
          <h3>Change Impact Analyzer</h3>
          <p>Enter a source file and symbol to see direct consumers, downstream impact, risk, affected symbols, and review recommendations.</p>
        </div>
      )}
    </div>
  );
}
