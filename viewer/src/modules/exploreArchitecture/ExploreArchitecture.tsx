import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Boxes,
  Check,
  CheckCircle2,
  Copy,
  Layers,
  Network,
  Search,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import SecuritySelect from "../security/SecuritySelect";
import "./explore-architecture.css";

type Severity = "critical" | "high" | "medium" | "low";

type FindingRule =
  | "cycle"
  | "forbidden-dependency"
  | "layer-violation"
  | "layer-skip"
  | "hub"
  | "deep-import"
  | "isolated";

interface Example {
  from: string;
  to: string;
}

interface ModuleInfo {
  key: string;
  label: string;
  role?: string;
  rank?: number;
  files: number;
  lines: number;
  exports: number;
  abstractExports: number;
  level: number;
  order: number;
  ca: number;
  ce: number;
  instability: number;
  abstractness: number;
  distance: number;
  imports: Array<{ module: string; weight: number }>;
  importedBy: Array<{ module: string; weight: number }>;
  publicApi: string[];
  indexFile?: string;
  topFiles: Array<{ path: string; importedByModules: number; lines: number }>;
  flags: string[];
  inCycle: boolean;
  findingCount: number;
}

interface ModuleEdge {
  from: string;
  to: string;
  weight: number;
  typeOnly: number;
  cycle: boolean;
  violation: boolean;
  back: boolean;
  examples: Example[];
}

interface LayerInfo {
  level: number;
  name: string;
  modules: string[];
}

interface ArchFinding {
  id: string;
  rule: FindingRule;
  severity: Severity;
  title: string;
  message: string;
  modules: string[];
  evidence: Example[];
  suggestion: string;
}

interface DrilldownNode {
  id: string;
  label: string;
  kind: "file" | "external-up" | "external-down";
  level: number;
  order: number;
  lines: number;
  exports: number;
}

interface Drilldown {
  module: string;
  nodes: DrilldownNode[];
  edges: Array<{ from: string; to: string; weight: number; back: boolean }>;
  hiddenFiles: number;
}

interface ArchitectureReport {
  success: boolean;
  tool: "explore_architecture";
  projectPath: string;
  granularity: { requested: string; depth: number; moduleCount: number };
  summary: {
    files: number;
    lines: number;
    modules: number;
    edges: number;
    layers: number;
    cycles: number;
    findings: Record<Severity, number>;
    healthScore: number;
    scoreBreakdown: Array<{ label: string; points: number }>;
  };
  modules: ModuleInfo[];
  edges: ModuleEdge[];
  layers: LayerInfo[];
  findings: ArchFinding[];
  matrix: { order: string[]; cells: number[][] };
  forbiddenRules: Array<{ rule: string; violations: number }>;
  drilldown?: Drilldown;
  mermaid: string;
  markdown: string;
  warnings: string[];
}

interface ExploreArchitectureProps {
  projectPath: string;
  onProjectPathChange?: (value: string) => void;
  apiUrl?: string;
}

type ViewMode = "modules" | "findings";
type DepthOption = "auto" | "1" | "2" | "3" | "4";

const DEFAULT_API_URL = "http://127.0.0.1:4174/api/explore-architecture";

const DEPTH_LABEL: Record<DepthOption, string> = {
  auto: "Automatic",
  "1": "Broad (1 folder level)",
  "2": "Medium (2 levels)",
  "3": "Detailed (3 levels)",
  "4": "Very detailed (4 levels)",
};

const VIEW_LABEL: Record<ViewMode, string> = {
  modules: "Modules",
  findings: "Findings",
};

const RULE_LABEL: Record<FindingRule, string> = {
  cycle: "Cycle",
  "forbidden-dependency": "Forbidden",
  "layer-violation": "Layer violation",
  "layer-skip": "Layer skipping",
  hub: "Hub",
  "deep-import": "Deep import",
  isolated: "Isolated",
};

const RULE_PATTERN = /^.+?\s*(->|→|=>)\s*.+$/;

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function baseName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1];
}

function shortLabel(label: string, max = 24): string {
  const parts = label.split("/");
  const text = parts.length > 2 ? parts.slice(-2).join("/") : label;
  return text.length > max ? `…${text.slice(text.length - max + 1)}` : text;
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
/*  The map                                                                   */
/* -------------------------------------------------------------------------- */

type NodeTone = "normal" | "cycle" | "hub" | "external";
type EdgeTone = "normal" | "cycle" | "violation" | "back";

interface MapNode {
  id: string;
  title: string;
  sub: string;
  tooltip: string;
  level: number;
  order: number;
  tone: NodeTone;
}

interface MapEdge {
  from: string;
  to: string;
  weight: number;
  tone: EdgeTone;
}

const NODE_W = 184;
const NODE_H = 52;
const H_GAP = 30;
const V_GAP = 84;
const PAD = 30;

function ArchitectureMap({
  nodes,
  edges,
  rowLabels,
  selectedId,
  problemsOnly,
  onSelect,
  onOpen,
}: {
  nodes: MapNode[];
  edges: MapEdge[];
  rowLabels: Map<number, string>;
  selectedId: string | null;
  problemsOnly: boolean;
  onSelect: (id: string) => void;
  onOpen?: (id: string) => void;
}) {
  const [hoverId, setHoverId] = useState<string | null>(null);

  const layout = useMemo(() => {
    const levels = [...new Set(nodes.map((node) => node.level))].sort((a, b) => a - b);
    const rowOf = new Map(levels.map((level, index) => [level, index]));
    const rows = levels.map((level) =>
      nodes.filter((node) => node.level === level).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    );

    const widest = Math.max(1, ...rows.map((row) => row.length));
    const width = Math.max(680, PAD * 2 + widest * NODE_W + (widest - 1) * H_GAP);
    const height = PAD * 2 + rows.length * NODE_H + Math.max(0, rows.length - 1) * V_GAP + 46;

    const positions = new Map<string, { x: number; y: number; row: number }>();
    rows.forEach((row, rowIndex) => {
      const rowWidth = row.length * NODE_W + (row.length - 1) * H_GAP;
      const startX = (width - rowWidth) / 2;
      row.forEach((node, index) => {
        positions.set(node.id, {
          x: startX + index * (NODE_W + H_GAP),
          y: PAD + rowIndex * (NODE_H + V_GAP),
          row: rowIndex,
        });
      });
    });

    return { levels, rowOf, rows, width, height, positions };
  }, [nodes]);

  const neighbours = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (!map.has(edge.from)) map.set(edge.from, new Set());
      if (!map.has(edge.to)) map.set(edge.to, new Set());
      map.get(edge.from)!.add(edge.to);
      map.get(edge.to)!.add(edge.from);
    }
    return map;
  }, [edges]);

  const active = hoverId ?? selectedId;

  const shownEdges = problemsOnly ? edges.filter((edge) => edge.tone !== "normal") : edges;

  if (nodes.length === 0) {
    return <div className="arx-map-empty">Nothing to draw.</div>;
  }

  const pathFor = (edge: MapEdge) => {
    const from = layout.positions.get(edge.from);
    const to = layout.positions.get(edge.to);
    if (!from || !to) return undefined;

    if (to.row > from.row) {
      const startX = from.x + NODE_W / 2;
      const startY = from.y + NODE_H;
      const endX = to.x + NODE_W / 2;
      const endY = to.y;
      const dy = Math.max(26, (endY - startY) / 2);
      return {
        d: `M ${startX} ${startY} C ${startX} ${startY + dy}, ${endX} ${endY - dy}, ${endX} ${endY}`,
        labelX: (startX + endX) / 2,
        labelY: (startY + endY) / 2,
      };
    }

    if (to.row === from.row) {
      const startX = from.x + NODE_W / 2;
      const endX = to.x + NODE_W / 2;
      const y = from.y + NODE_H;
      return {
        d: `M ${startX} ${y} C ${startX} ${y + 44}, ${endX} ${y + 44}, ${endX} ${y}`,
        labelX: (startX + endX) / 2,
        labelY: y + 34,
      };
    }

    const bulge = 44 + 16 * (from.row - to.row);
    const startX = from.x + NODE_W;
    const startY = from.y + NODE_H / 2;
    const endX = to.x + NODE_W;
    const endY = to.y + NODE_H / 2;
    return {
      d: `M ${startX} ${startY} C ${startX + bulge} ${startY}, ${endX + bulge} ${endY}, ${endX} ${endY}`,
      labelX: Math.max(startX, endX) + bulge * 0.72,
      labelY: (startY + endY) / 2,
    };
  };

  const arrowFor = (tone: EdgeTone, hot: boolean) => (hot ? "hot" : tone);

  return (
    <div className="arx-canvas">
      <svg
        className="arx-svg"
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="group"
        aria-label="Architecture map"
      >
        <defs>
          {(
            [
              ["normal", "#5f6b83"],
              ["cycle", "#f1657e"],
              ["violation", "#f1aa65"],
              ["back", "#b78a4a"],
              ["hot", "#9fb0ff"],
            ] as const
          ).map(([name, color]) => (
            <marker
              key={name}
              id={`arx-arrow-${name}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
            </marker>
          ))}
        </defs>

        {layout.rows.map((row, rowIndex) => (
          <g key={`band-${rowIndex}`}>
            <rect
              className="arx-layer-band"
              x={0}
              y={PAD + rowIndex * (NODE_H + V_GAP) - 14}
              width={layout.width}
              height={NODE_H + 28}
              rx={6}
            />
            <text
              className="arx-layer-label"
              x={10}
              y={PAD + rowIndex * (NODE_H + V_GAP) - 18}
            >
              {rowLabels.get(layout.levels[rowIndex]) ?? ""}
            </text>
            {row.length === 0 && null}
          </g>
        ))}

        {shownEdges.map((edge) => {
          const geometry = pathFor(edge);
          if (!geometry) return null;

          const hot = active !== null && (edge.from === active || edge.to === active);
          const dim = active !== null && !hot;

          return (
            <g
              key={`${edge.from}->${edge.to}`}
              className={`arx-edge ${edge.tone} ${hot ? "hot" : ""} ${dim ? "dim" : ""}`}
            >
              <path
                d={geometry.d}
                strokeWidth={1 + Math.min(4, Math.log2(edge.weight + 1))}
                markerEnd={`url(#arx-arrow-${arrowFor(edge.tone, hot)})`}
              />
              {(hot || edge.weight >= 3) && (
                <text
                  className="arx-edge-label"
                  x={geometry.labelX}
                  y={geometry.labelY}
                  textAnchor="middle"
                >
                  {edge.weight}
                </text>
              )}
            </g>
          );
        })}

        {nodes.map((node) => {
          const position = layout.positions.get(node.id);
          if (!position) return null;

          const related = active === null || node.id === active || neighbours.get(active)?.has(node.id);

          return (
            <g
              key={node.id}
              className={`arx-node ${node.tone} ${selectedId === node.id ? "selected" : ""} ${
                related ? "" : "dim"
              }`}
              transform={`translate(${position.x}, ${position.y})`}
              role="button"
              tabIndex={0}
              aria-label={`${node.tooltip}. ${node.sub}`}
              onClick={() => onSelect(node.id)}
              onDoubleClick={() => onOpen?.(node.id)}
              onMouseEnter={() => setHoverId(node.id)}
              onMouseLeave={() => setHoverId(null)}
              onFocus={() => setHoverId(node.id)}
              onBlur={() => setHoverId(null)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(node.id);
                }
              }}
            >
              <title>{node.tooltip}</title>
              <rect width={NODE_W} height={NODE_H} rx={9} />
              <text className="arx-node-title" x={12} y={21}>
                {node.title}
              </text>
              <text className="arx-node-sub" x={12} y={38}>
                {node.sub}
              </text>
              {node.tone === "cycle" && (
                <text className="arx-node-badge" x={NODE_W - 12} y={21} textAnchor="end">
                  CYCLE
                </text>
              )}
              {node.tone === "hub" && (
                <text className="arx-node-badge" x={NODE_W - 12} y={21} textAnchor="end">
                  HUB
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  View                                                                      */
/* -------------------------------------------------------------------------- */

export default function ExploreArchitecture({
  projectPath,
  onProjectPathChange,
  apiUrl = DEFAULT_API_URL,
}: ExploreArchitectureProps) {
  const [forbidInput, setForbidInput] = useState("");
  const [depth, setDepth] = useState<DepthOption>("auto");
  const [includeTests, setIncludeTests] = useState(false);

  const [report, setReport] = useState<ArchitectureReport | null>(null);
  const [view, setView] = useState<ViewMode>("modules");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [levelFilter, setLevelFilter] = useState("all");
  const [sortKey, setSortKey] = useState("default");
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [drilling, setDrilling] = useState(false);
  const [drillSelected, setDrillSelected] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<{ from: string; to: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const rules = useMemo(
    () =>
      forbidInput
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    [forbidInput]
  );

  async function analyze(focusModule?: string) {
    if (!projectPath.trim()) {
      setError("Enter a project path before exploring.");
      return;
    }

    if (rules.length > 20) {
      setError("Enter at most 20 forbidden-dependency rules.");
      return;
    }

    const badRule = rules.find((rule) => !RULE_PATTERN.test(rule));
    if (badRule) {
      setError(`Write each rule like "src/ui -> src/db". "${badRule}" has no arrow.`);
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
          moduleDepth: depth === "auto" ? undefined : Number(depth),
          includeTests,
          forbid: rules.length > 0 ? rules : undefined,
          focusModule,
        }),
      });

      const data = await response.json();

      if (!response.ok || data.success === false) {
        throw new Error(data.error || "Exploring the architecture failed.");
      }

      const next = data as ArchitectureReport;
      setReport(next);
      setDrilling(Boolean(focusModule && next.drilldown));
      setDrillSelected(null);
      setSelectedEdge(null);

      if (focusModule) {
        setView("modules");
        setSelectedId(focusModule);
      } else {
        setView("modules");
        setSelectedId(next.modules[0]?.key ?? null);
        setSearch("");
        setLevelFilter("all");
        setSortKey("default");
      }
    } catch (analysisError) {
      setError(
        analysisError instanceof Error ? analysisError.message : "Unable to explore the project."
      );
    } finally {
      setLoading(false);
    }
  }

  function switchView(next: ViewMode) {
    if (!report) return;
    setView(next);
    setLevelFilter("all");
    setSortKey("default");
    setSearch("");
    setSelectedId(next === "modules" ? (report.modules[0]?.key ?? null) : (report.findings[0]?.id ?? null));
  }

  function openModule(key: string) {
    setView("modules");
    setLevelFilter("all");
    setSearch("");
    setSelectedId(key);
  }

  const query = search.trim().toLowerCase();

  const visibleModules = useMemo(() => {
    if (!report) return [];

    const filtered = report.modules.filter((module) => {
      if (levelFilter === "problems" && module.findingCount === 0) return false;
      if (levelFilter === "cycle" && !module.inCycle) return false;
      if (levelFilter === "hub" && !module.flags.includes("hub")) return false;
      return !query || `${module.key} ${module.role ?? ""}`.toLowerCase().includes(query);
    });

    const sorted = [...filtered];
    if (sortKey === "problems") sorted.sort((a, b) => b.findingCount - a.findingCount);
    else if (sortKey === "size") sorted.sort((a, b) => b.files - a.files);
    else if (sortKey === "coupling") sorted.sort((a, b) => b.ca + b.ce - (a.ca + a.ce));
    else if (sortKey === "name") sorted.sort((a, b) => a.key.localeCompare(b.key));
    return sorted;
  }, [report, query, levelFilter, sortKey]);

  const visibleFindings = useMemo(() => {
    if (!report) return [];

    const filtered = report.findings.filter((finding) => {
      if (levelFilter !== "all" && finding.severity !== levelFilter) return false;
      return !query || `${finding.title} ${finding.message} ${finding.modules.join(" ")}`.toLowerCase().includes(query);
    });

    return sortKey === "type"
      ? [...filtered].sort((a, b) => a.rule.localeCompare(b.rule))
      : filtered;
  }, [report, query, levelFilter, sortKey]);

  const counts: Record<ViewMode, number> = {
    modules: visibleModules.length,
    findings: visibleFindings.length,
  };

  const selectedModule =
    view === "modules"
      ? (visibleModules.find((item) => item.key === selectedId) ?? visibleModules[0] ?? null)
      : null;
  const selectedFinding =
    view === "findings"
      ? (visibleFindings.find((item) => item.id === selectedId) ?? visibleFindings[0] ?? null)
      : null;

  const moduleByKey = useMemo(
    () => new Map((report?.modules ?? []).map((module) => [module.key, module])),
    [report]
  );

  const edgeByKey = useMemo(
    () => new Map((report?.edges ?? []).map((edge) => [`${edge.from}\0${edge.to}`, edge])),
    [report]
  );

  const mapNodes: MapNode[] = useMemo(() => {
    if (!report) return [];

    if (drilling && report.drilldown) {
      return report.drilldown.nodes.map((node) => ({
        id: node.id,
        title: node.kind === "file" ? shortLabel(node.label, 24) : shortLabel(node.label, 22),
        sub:
          node.kind === "file"
            ? `${formatNumber(node.lines)} lines · ${node.exports} exports`
            : node.kind === "external-up"
              ? "uses this module"
              : "used by this module",
        tooltip: node.label,
        level: node.level,
        order: node.order,
        tone: node.kind === "file" ? "normal" : "external",
      }));
    }

    return report.modules.map((module) => ({
      id: module.key,
      title: shortLabel(module.key),
      sub: `${plural(module.files, "file")} · ${module.role ?? `layer ${module.level + 1}`}`,
      tooltip: module.key,
      level: module.level,
      order: module.order,
      tone: module.inCycle ? "cycle" : module.flags.includes("hub") ? "hub" : "normal",
    }));
  }, [report, drilling]);

  const mapEdges: MapEdge[] = useMemo(() => {
    if (!report) return [];

    if (drilling && report.drilldown) {
      return report.drilldown.edges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        weight: edge.weight,
        tone: edge.back ? "back" : "normal",
      }));
    }

    return report.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      weight: edge.weight,
      tone: edge.cycle ? "cycle" : edge.violation ? "violation" : edge.back ? "back" : "normal",
    }));
  }, [report, drilling]);

  const rowLabels = useMemo(() => {
    const labels = new Map<number, string>();
    if (!report) return labels;

    if (drilling && report.drilldown) {
      const levels = report.drilldown.nodes;
      for (const node of levels) {
        if (node.kind === "external-up") labels.set(node.level, "Modules that use it");
        else if (node.kind === "external-down") labels.set(node.level, "Modules it uses");
        else if (!labels.has(node.level)) labels.set(node.level, "Files");
      }
      return labels;
    }

    for (const layer of report.layers) labels.set(layer.level, layer.name);
    return labels;
  }, [report, drilling]);

  const drillNode = report?.drilldown?.nodes.find((node) => node.id === drillSelected);

  const levelOptions =
    view === "modules"
      ? [
          { value: "all", label: "All modules" },
          { value: "problems", label: "With problems" },
          { value: "cycle", label: "In a cycle" },
          { value: "hub", label: "Hubs" },
        ]
      : [
          { value: "all", label: "All severities" },
          { value: "critical", label: "Critical" },
          { value: "high", label: "High" },
          { value: "medium", label: "Medium" },
          { value: "low", label: "Low" },
        ];

  const sortOptions =
    view === "modules"
      ? [
          { value: "default", label: "Sort: layer" },
          { value: "problems", label: "Sort: problems" },
          { value: "coupling", label: "Sort: coupling" },
          { value: "size", label: "Sort: size" },
          { value: "name", label: "Sort: name" },
        ]
      : [
          { value: "default", label: "Sort: severity" },
          { value: "type", label: "Sort: type" },
        ];

  const maxCell = useMemo(
    () => Math.max(1, ...(report?.matrix.cells.flat() ?? [0])),
    [report]
  );

  const urgent = (report?.summary.findings.critical ?? 0) + (report?.summary.findings.high ?? 0) > 0;

  return (
    <div className="arx-analyzer">
      <div className="arx-title-row">
        <div className="arx-title-icon">
          <Network size={24} />
        </div>

        <div>
          <h1>Architecture Explorer</h1>
          <p>
            See how your code is really structured: the layers, which modules
            depend on which, and where that structure breaks down, with an
            interactive map you can explore.
          </p>
        </div>
      </div>

      <section className="arx-input-card">
        <div className="arx-field arx-field-wide">
          <label htmlFor="arx-project-path">Project path</label>
          <input
            id="arx-project-path"
            value={projectPath}
            onChange={(event) => onProjectPathChange?.(event.target.value)}
            placeholder="/path/to/your/project"
          />
        </div>

        <div className="arx-field">
          <label htmlFor="arx-forbid">Forbidden dependencies (optional)</label>
          <input
            id="arx-forbid"
            value={forbidInput}
            onChange={(event) => setForbidInput(event.target.value)}
            placeholder="src/ui -> src/db, viewer -> src/server"
          />
        </div>

        <button
          type="button"
          className="arx-analyze-button"
          onClick={() => analyze()}
          disabled={loading}
        >
          {loading ? (
            <>
              <span className="arx-spinner" />
              Exploring...
            </>
          ) : (
            <>
              <Network size={17} />
              Explore Architecture
            </>
          )}
        </button>

        <div className="arx-options">
          <div className="arx-field">
            <span className="arx-field-label">Module size</span>
            <SecuritySelect
              ariaLabel="Module size"
              value={depth}
              onChange={setDepth}
              options={(Object.keys(DEPTH_LABEL) as DepthOption[]).map((item) => ({
                value: item,
                label: DEPTH_LABEL[item],
              }))}
            />
            <p className="arx-field-hint">
              How many folder levels make up one module. Automatic picks a
              readable map.
            </p>
          </div>
        </div>

        <div className="arx-options arx-options-secondary">
          <label className="arx-check">
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
        <div className="arx-error" role="alert">
          <XCircle size={18} />
          {error}
        </div>
      )}

      {report && (
        <>
          <div className="arx-status-row">
            <div className={`arx-success ${urgent ? "has-groups" : ""}`}>
              {urgent ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
              <strong>{report.summary.healthScore}/100</strong>
              <span>architecture health</span>
            </div>

            <div className="arx-status-right">
              <span className="arx-saved branch">
                {plural(report.summary.modules, "module")} ·{" "}
                {plural(report.summary.edges, "dependency", "dependencies")} ·{" "}
                {plural(report.summary.layers, "layer")}
              </span>
              <span className="arx-scope">
                {formatNumber(report.summary.files)} files ·{" "}
                {formatNumber(report.summary.lines)} lines · module size{" "}
                {report.granularity.requested === "auto"
                  ? `automatic (${report.granularity.depth})`
                  : report.granularity.depth}
              </span>
            </div>
          </div>

          <div className="arx-summary-grid">
            <button
              type="button"
              className={`arx-summary-card arx-tone-a ${view === "modules" ? "active" : ""}`}
              onClick={() => switchView("modules")}
              aria-pressed={view === "modules"}
            >
              <div className="arx-summary-icon">
                <Boxes size={17} />
              </div>
              <div>
                <strong>{report.summary.modules}</strong>
                <span>Modules</span>
                <span className="arx-summary-sub">
                  {formatNumber(report.summary.files)} files
                </span>
              </div>
            </button>

            <button
              type="button"
              className={`arx-summary-card arx-tone-b ${view === "findings" ? "active" : ""}`}
              onClick={() => switchView("findings")}
              aria-pressed={view === "findings"}
            >
              <div className="arx-summary-icon">
                <ShieldAlert size={17} />
              </div>
              <div>
                <strong>{report.findings.length}</strong>
                <span>Problems found</span>
                <span className="arx-summary-sub">
                  {report.summary.cycles} cycles · {report.summary.findings.high} high
                </span>
              </div>
            </button>

            <div className="arx-summary-card static">
              <div className="arx-summary-icon neutral">
                <Layers size={17} />
              </div>
              <div>
                <strong>{report.summary.layers}</strong>
                <span>Layers</span>
                <span className="arx-summary-sub">Worked out from the imports</span>
              </div>
            </div>

            <div className="arx-summary-card static">
              <div className="arx-summary-icon neutral">
                <CheckCircle2 size={17} />
              </div>
              <div>
                <strong>{report.summary.healthScore}</strong>
                <span>Health score</span>
                <span className="arx-summary-sub">
                  {report.summary.scoreBreakdown[0]?.label ?? "No deductions"}
                </span>
              </div>
            </div>
          </div>

          <section className="arx-map" aria-label="Architecture map">
            <div className="arx-map-head">
              <div>
                <h2>
                  {drilling && report.drilldown
                    ? `Inside ${report.drilldown.module}`
                    : "Architecture map"}
                </h2>
                <p>
                  {drilling && report.drilldown
                    ? `${plural(report.drilldown.nodes.filter((node) => node.kind === "file").length, "file")} shown${
                        report.drilldown.hiddenFiles > 0
                          ? `, ${report.drilldown.hiddenFiles} less connected hidden`
                          : ""
                      }. Dashed boxes are other modules.`
                    : "Top of the picture is code nothing else depends on; the bottom is what everything builds on. Click a box to inspect it, double-click to look inside."}
                </p>
              </div>

              <div className="arx-toolbar">
                {drilling ? (
                  <button type="button" onClick={() => setDrilling(false)}>
                    <ArrowLeft size={14} />
                    Back to overview
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className={!problemsOnly ? "active" : ""}
                      aria-pressed={!problemsOnly}
                      onClick={() => setProblemsOnly(false)}
                    >
                      All dependencies
                    </button>
                    <button
                      type="button"
                      className={problemsOnly ? "active" : ""}
                      aria-pressed={problemsOnly}
                      onClick={() => setProblemsOnly(true)}
                    >
                      Problems only
                    </button>
                  </>
                )}
              </div>
            </div>

            <ArchitectureMap
              nodes={mapNodes}
              edges={mapEdges}
              rowLabels={rowLabels}
              selectedId={drilling ? drillSelected : (selectedModule?.key ?? selectedId)}
              problemsOnly={!drilling && problemsOnly}
              onSelect={(id) => {
                if (drilling) setDrillSelected(id);
                else openModule(id);
              }}
              onOpen={(id) => {
                if (!drilling && moduleByKey.has(id)) void analyze(id);
              }}
            />

            {drilling && drillNode && (
              <div className="arx-edge-detail">
                <strong>{drillNode.label}</strong>
                {drillNode.kind === "file"
                  ? ` · ${formatNumber(drillNode.lines)} lines · ${plural(drillNode.exports, "export")}`
                  : drillNode.kind === "external-up"
                    ? " uses code inside this module."
                    : " is used by code inside this module."}
              </div>
            )}

            <div className="arx-legend">
              <span>
                <i /> Dependency (thicker means more imports)
              </span>
              <span>
                <i className="cycle" /> Part of a cycle
              </span>
              <span>
                <i className="violation" /> Foundation depends on a higher layer
              </span>
              <span>
                <i className="back" /> Goes against the flow
              </span>
            </div>
          </section>

          <section className="arx-workspace">
            <div className="arx-groups-panel">
              <div className="arx-panel-header">
                <div>
                  <h2>{VIEW_LABEL[view]}</h2>
                  <p>
                    {counts[view]} of{" "}
                    {view === "modules" ? report.modules.length : report.findings.length} items
                  </p>
                </div>

                <div className="arx-count-pill">{counts[view]}</div>
              </div>

              <div className="arx-filters">
                <div className="arx-search">
                  <Search size={17} />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search..."
                    aria-label="Search"
                  />
                </div>

                <div className="arx-filter-row">
                  <div className="arx-type-filter" role="group" aria-label="Choose a list">
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

                  <div className="arx-sort">
                    <SecuritySelect
                      ariaLabel="Filter"
                      value={levelFilter}
                      onChange={setLevelFilter}
                      options={levelOptions}
                    />
                  </div>

                  <div className="arx-sort">
                    <SecuritySelect
                      ariaLabel="Sort"
                      value={sortKey}
                      onChange={setSortKey}
                      options={sortOptions}
                    />
                  </div>
                </div>
              </div>

              <div className="arx-groups-list">
                {counts[view] === 0 ? (
                  <div className="arx-empty">
                    <Network size={34} />
                    <h3>{view === "findings" && report.findings.length === 0 ? "No problems" : "Nothing here"}</h3>
                    <p>
                      {view === "findings" && report.findings.length === 0
                        ? "No architecture problems were found."
                        : "No items match the current filters."}
                    </p>
                  </div>
                ) : view === "modules" ? (
                  visibleModules.map((module) => (
                    <button
                      type="button"
                      key={module.key}
                      className={`arx-group ${selectedModule?.key === module.key ? "selected" : ""}`}
                      onClick={() => setSelectedId(module.key)}
                    >
                      <div
                        className={`arx-group-icon arx-severity-${
                          module.inCycle ? "critical" : module.findingCount > 0 ? "medium" : "info"
                        }`}
                      >
                        <Boxes size={17} />
                      </div>
                      <div className="arx-group-content">
                        <div className="arx-group-top">
                          <span className="arx-kind-badge">Layer {module.level + 1}</span>
                          {module.role && <span className="arx-kind-badge">{module.role}</span>}
                          {module.findingCount > 0 && (
                            <span className="arx-badge arx-badge-high">
                              {plural(module.findingCount, "problem")}
                            </span>
                          )}
                        </div>
                        <h3>{module.key}</h3>
                        <p className="arx-places">
                          {plural(module.files, "file")} · {formatNumber(module.lines)} lines · uses {module.ce}, used by {module.ca}
                        </p>
                      </div>
                    </button>
                  ))
                ) : (
                  visibleFindings.map((finding) => (
                    <button
                      type="button"
                      key={finding.id}
                      className={`arx-group ${selectedFinding?.id === finding.id ? "selected" : ""}`}
                      onClick={() => setSelectedId(finding.id)}
                    >
                      <div className={`arx-group-icon arx-severity-${finding.severity}`}>
                        <ShieldAlert size={17} />
                      </div>
                      <div className="arx-group-content">
                        <div className="arx-group-top">
                          <span className={`arx-badge arx-badge-${finding.severity}`}>
                            {finding.severity}
                          </span>
                          <span className="arx-kind-badge">{RULE_LABEL[finding.rule]}</span>
                        </div>
                        <h3>{finding.title}</h3>
                        <p className="arx-places">{finding.modules.slice(0, 3).join(", ")}</p>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>

            <aside className="arx-inspector">
              <div className="arx-panel-header">
                <div>
                  <h2>Inspector</h2>
                  <p>What it is, what it touches and what is wrong</p>
                </div>
              </div>

              {selectedModule ? (
                <div className="arx-inspector-body">
                  <div className="arx-inspector-title">
                    <div
                      className={`arx-inspector-icon arx-severity-${
                        selectedModule.inCycle ? "critical" : selectedModule.findingCount > 0 ? "medium" : "info"
                      }`}
                    >
                      <Boxes size={20} />
                    </div>
                    <div>
                      <span className="arx-kind-badge">
                        {selectedModule.role ?? `Layer ${selectedModule.level + 1}`}
                      </span>
                      <h3>{selectedModule.key}</h3>
                    </div>
                  </div>

                  <div className="arx-detail-grid">
                    <div>
                      <span>Layer</span>
                      <strong>{selectedModule.level + 1}</strong>
                    </div>
                    <div>
                      <span>Files</span>
                      <strong>{selectedModule.files}</strong>
                    </div>
                    <div>
                      <span>Lines</span>
                      <strong>{formatNumber(selectedModule.lines)}</strong>
                    </div>
                    <div>
                      <span>Exports</span>
                      <strong>{selectedModule.exports}</strong>
                    </div>
                  </div>

                  {selectedModule.flags.length > 0 && (
                    <section className="arx-box">
                      <h4>Flags</h4>
                      <ul className="arx-flags">
                        {selectedModule.flags.map((flag) => (
                          <li key={flag}>
                            <AlertTriangle size={13} />
                            {flag === "hub"
                              ? "Hub: connected to many modules, so changes here ripple widely."
                              : flag === "cycle"
                                ? "Part of a dependency cycle."
                                : flag === "isolated"
                                  ? "Isolated: nothing imports it and it imports nothing."
                                  : "Many modules depend on it and it is mostly concrete code, so it is costly to change."}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  <section className="arx-box">
                    <h4>Coupling</h4>
                    <div className="arx-score-row">
                      {(
                        [
                          ["Instability", selectedModule.instability],
                          ["Abstractness", selectedModule.abstractness],
                          ["Distance", selectedModule.distance],
                        ] as const
                      ).map(([label, value]) => (
                        <div key={label}>
                          <span>{label}</span>
                          <div className="arx-score-track">
                            <i style={{ width: `${Math.round(value * 100)}%` }} />
                          </div>
                          <strong>{value.toFixed(2)}</strong>
                        </div>
                      ))}
                    </div>
                    <p className="arx-hint">
                      {selectedModule.instability >= 0.7
                        ? "It depends on many modules and few depend on it, so it is cheap to change."
                        : selectedModule.instability <= 0.3 && selectedModule.ca > 0
                          ? "Many modules depend on it and it depends on few, so changes here ripple outward."
                          : "It is balanced between depending on others and being depended on."}{" "}
                      {Math.round(selectedModule.abstractness * 100)}% of its exports are types
                      and interfaces.
                    </p>
                  </section>

                  <section className="arx-box">
                    <h4>Depends on ({selectedModule.imports.length})</h4>
                    {selectedModule.imports.length === 0 ? (
                      <p>It does not import any other module.</p>
                    ) : (
                      <ul className="arx-link-list">
                        {selectedModule.imports.map((item) => (
                          <li key={item.module}>
                            <button type="button" onClick={() => openModule(item.module)}>
                              <span title={item.module}>{item.module}</span>
                              <em>{plural(item.weight, "import")}</em>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <section className="arx-box">
                    <h4>Used by ({selectedModule.importedBy.length})</h4>
                    {selectedModule.importedBy.length === 0 ? (
                      <p>No other module imports it.</p>
                    ) : (
                      <ul className="arx-link-list">
                        {selectedModule.importedBy.map((item) => (
                          <li key={item.module}>
                            <button type="button" onClick={() => openModule(item.module)}>
                              <span title={item.module}>{item.module}</span>
                              <em>{plural(item.weight, "import")}</em>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  {selectedModule.publicApi.length > 0 && (
                    <section className="arx-box">
                      <h4>
                        {selectedModule.indexFile ? "Public API (index file)" : "Main exports"}
                      </h4>
                      <ul className="arx-pill-list">
                        {selectedModule.publicApi.map((name) => (
                          <li key={name}>{name}</li>
                        ))}
                      </ul>
                    </section>
                  )}

                  {selectedModule.topFiles.length > 0 && (
                    <section className="arx-box">
                      <h4>Most used files</h4>
                      <ul className="arx-rows">
                        {selectedModule.topFiles.map((file) => (
                          <li key={file.path}>
                            <span title={file.path}>{baseName(file.path)}</span>
                            <em>{formatNumber(file.lines)} lines</em>
                            <strong>{file.importedByModules}</strong>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  <section className="arx-box">
                    <h4>Look closer</h4>
                    <div className="arx-deliver-actions">
                      <button type="button" onClick={() => void analyze(selectedModule.key)}>
                        <Network size={14} />
                        Open inside
                      </button>
                      <CopyButton value={selectedModule.key} label="Copy name" />
                    </div>
                  </section>
                </div>
              ) : selectedFinding ? (
                <div className="arx-inspector-body">
                  <div className="arx-inspector-title">
                    <div className={`arx-inspector-icon arx-severity-${selectedFinding.severity}`}>
                      <ShieldAlert size={20} />
                    </div>
                    <div>
                      <span className={`arx-badge arx-badge-${selectedFinding.severity}`}>
                        {selectedFinding.severity}
                      </span>
                      <h3>{selectedFinding.title}</h3>
                    </div>
                  </div>

                  <section className="arx-box">
                    <h4>What is wrong</h4>
                    <p>{selectedFinding.message}</p>
                  </section>

                  <section className="arx-box">
                    <h4>Modules involved</h4>
                    <ul className="arx-link-list">
                      {selectedFinding.modules.map((key) => (
                        <li key={key}>
                          <button
                            type="button"
                            disabled={!moduleByKey.has(key)}
                            onClick={() => openModule(key)}
                          >
                            <span title={key}>{key}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>

                  {selectedFinding.evidence.length > 0 && (
                    <section className="arx-box">
                      <h4>Where it happens</h4>
                      <ul className="arx-evidence arx-mono">
                        {selectedFinding.evidence.map((example) => (
                          <li key={`${example.from}-${example.to}`} title={`${example.from} → ${example.to}`}>
                            {example.from} → {example.to}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  <section className="arx-box">
                    <h4>How to fix it</h4>
                    <p>{selectedFinding.suggestion}</p>
                    <div className="arx-deliver-actions">
                      <CopyButton
                        value={`${selectedFinding.title}\n\n${selectedFinding.message}\n\nFix: ${selectedFinding.suggestion}`}
                        label="Copy as ticket"
                      />
                    </div>
                  </section>
                </div>
              ) : (
                <div className="arx-inspector-empty">
                  <Network size={38} />
                  <h3>Select an item</h3>
                  <p>Choose something from the list or click a box on the map.</p>
                </div>
              )}
            </aside>
          </section>

          <section className="arx-deliver">
            <h2>Dependency matrix</h2>
            <p>
              Each row depends on the columns where a number appears. Rows and
              columns follow the layers, so numbers below the diagonal go against
              the flow. Click a cell for details.
            </p>

            <div className="arx-matrix-wrap">
              <div
                className="arx-matrix"
                style={{
                  gridTemplateColumns: `200px repeat(${report.matrix.order.length}, 30px)`,
                }}
              >
                <div className="arx-matrix-corner" />
                {report.matrix.order.map((key, index) => (
                  <div className="arx-matrix-colhead" key={`col-${key}`} title={key}>
                    {index + 1}
                  </div>
                ))}

                {report.matrix.order.map((rowKey, rowIndex) => (
                  <MatrixRow
                    key={`row-${rowKey}`}
                    rowKey={rowKey}
                    rowIndex={rowIndex}
                    order={report.matrix.order}
                    cells={report.matrix.cells[rowIndex]}
                    maxCell={maxCell}
                    edgeByKey={edgeByKey}
                    selected={selectedEdge}
                    onSelect={setSelectedEdge}
                  />
                ))}
              </div>
            </div>

            {selectedEdge && edgeByKey.get(`${selectedEdge.from}\0${selectedEdge.to}`) && (
              <div className="arx-edge-detail">
                {(() => {
                  const edge = edgeByKey.get(`${selectedEdge.from}\0${selectedEdge.to}`)!;
                  return (
                    <>
                      <strong>{edge.from}</strong> depends on <strong>{edge.to}</strong>:{" "}
                      {plural(edge.weight, "import")}
                      {edge.typeOnly > 0 ? ` (${edge.typeOnly} type-only)` : ""}
                      {edge.cycle ? ". Part of a cycle." : ""}
                      {edge.violation ? ". A foundation depending on a higher layer." : ""}
                      <ul className="arx-evidence arx-mono">
                        {edge.examples.map((example) => (
                          <li key={`${example.from}-${example.to}`} title={`${example.from} → ${example.to}`}>
                            {example.from} → {example.to}
                          </li>
                        ))}
                      </ul>
                    </>
                  );
                })()}
              </div>
            )}
          </section>

          <section className="arx-deliver">
            <h2>Architecture overview</h2>
            <p>
              A markdown summary of the layers, modules and problems with the
              diagram included. Paste it into a README, a wiki or an ADR.
            </p>

            <pre className="arx-markdown">{report.markdown}</pre>

            <div className="arx-deliver-actions">
              <CopyButton value={report.markdown} label="Copy overview" />
            </div>
          </section>

          <section className="arx-deliver">
            <h2>Mermaid diagram</h2>
            <p>
              Renders on GitHub, GitLab and most documentation tools. Dashed
              lines go against the flow of layers.
            </p>

            <pre className="arx-markdown">{report.mermaid}</pre>

            <div className="arx-deliver-actions">
              <CopyButton value={report.mermaid} label="Copy diagram" />
            </div>
          </section>

          <section className="arx-insights">
            <div className="arx-insight">
              <h2>Health breakdown</h2>
              <p>What lowered the score of {report.summary.healthScore}/100.</p>
              {report.summary.scoreBreakdown.length === 0 ? (
                <p>Nothing was deducted.</p>
              ) : (
                <ul className="arx-breakdown">
                  {report.summary.scoreBreakdown.map((item) => (
                    <li key={item.label}>
                      <span>{item.label}</span>
                      <strong>{item.points}</strong>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="arx-insight">
              <h2>Layers</h2>
              <p>Top to bottom, from the imports.</p>
              <ul className="arx-rows">
                {report.layers.map((layer) => (
                  <li key={layer.level}>
                    <span title={layer.modules.join(", ")}>{layer.name}</span>
                    <strong>{layer.modules.length}</strong>
                  </li>
                ))}
              </ul>
            </div>

            <div className="arx-insight">
              <h2>Your rules</h2>
              <p>Forbidden dependencies you entered.</p>
              {report.forbiddenRules.length === 0 ? (
                <p>None yet. Add rules such as src/ui -&gt; src/db above and run again.</p>
              ) : (
                <ul className="arx-rows">
                  {report.forbiddenRules.map((item) => (
                    <li key={item.rule}>
                      <span title={item.rule}>{item.rule}</span>
                      <em>{item.violations === 0 ? "respected" : "broken"}</em>
                      <strong>{item.violations}</strong>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {report.warnings.length > 0 && (
            <section className="arx-analysis-notes">
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

/* -------------------------------------------------------------------------- */
/*  Matrix row                                                                */
/* -------------------------------------------------------------------------- */

function MatrixRow({
  rowKey,
  rowIndex,
  order,
  cells,
  maxCell,
  edgeByKey,
  selected,
  onSelect,
}: {
  rowKey: string;
  rowIndex: number;
  order: string[];
  cells: number[];
  maxCell: number;
  edgeByKey: Map<string, ModuleEdge>;
  selected: { from: string; to: string } | null;
  onSelect: (value: { from: string; to: string }) => void;
}) {
  return (
    <>
      <div className="arx-matrix-rowhead" title={rowKey}>
        {rowIndex + 1}. {rowKey}
      </div>

      {cells.map((weight, columnIndex) => {
        const columnKey = order[columnIndex];

        if (rowIndex === columnIndex) {
          return <div className="arx-matrix-cell diagonal" key={`${rowKey}-${columnKey}`} />;
        }

        if (weight === 0) {
          return <div className="arx-matrix-cell" key={`${rowKey}-${columnKey}`} />;
        }

        const edge = edgeByKey.get(`${rowKey}\0${columnKey}`);
        const problem = Boolean(edge && (edge.cycle || edge.violation || edge.back));
        const alpha = Math.min(0.9, 0.22 + (weight / maxCell) * 0.68);
        const isSelected = selected?.from === rowKey && selected?.to === columnKey;

        return (
          <button
            type="button"
            key={`${rowKey}-${columnKey}`}
            className={`arx-matrix-cell has ${problem ? "problem" : ""} ${isSelected ? "selected" : ""}`}
            style={{
              background: problem
                ? `rgba(241, 101, 126, ${alpha})`
                : `rgba(122, 107, 255, ${alpha})`,
            }}
            title={`${rowKey} → ${columnKey}: ${plural(weight, "import")}`}
            onClick={() => onSelect({ from: rowKey, to: columnKey })}
          >
            {weight}
          </button>
        );
      })}
    </>
  );
}
