import { useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  MarkerType,
  MiniMap,
  Position,
  useReactFlow,
  useViewport,
  type Edge,
  type Node,
} from "@xyflow/react";
import {
  AlertTriangle,
  ArrowRight,
  Box,
  Check,
  CheckCircle2,
  Copy,
  Crosshair,
  Database,
  FileCode2,
  GitBranch,
  Layers,
  Maximize,
  Maximize2,
  Minimize2,
  Search,
  Share2,
  Tag,
  Wrench,
  XCircle,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import SecuritySelect from "../security/SecuritySelect";
import "./analyze-state-flow.css";

type Severity = "critical" | "high" | "medium" | "low" | "info";
type StateKind = "useState" | "useReducer" | "redux" | "zustand" | "jotai";
type FlowRole = "value" | "derived" | "setter" | "handler";
type HopKind = "prop" | "context" | "hook" | "store";

type IssueType =
  | "prop-drilling"
  | "unused-state"
  | "write-only-state"
  | "never-updated"
  | "derived-state"
  | "state-too-high"
  | "direct-mutation"
  | "render-phase-update"
  | "unstable-context-value"
  | "scattered-updates"
  | "stale-update";

type NodeBehavior =
  | "state"
  | "owner"
  | "pass-through"
  | "reader"
  | "writer"
  | "reader-writer"
  | "idle"
  | "context"
  | "store"
  | "external";

interface StateAccess {
  component: string;
  filePath: string;
  line: number;
  via: string;
  detail: string;
}

interface FlowHop {
  fromId: string;
  from: string;
  toId: string;
  to: string;
  prop: string;
  role: FlowRole;
  kind: HopKind;
  line: number;
  depth: number;
}

interface FlowNode {
  id: string;
  label: string;
  filePath?: string;
  type: "state" | "component" | "context" | "store" | "hook";
  behavior: NodeBehavior;
  depth: number;
  reads: number;
  writes: number;
}

interface FlowEdge {
  from: string;
  to: string;
  label: string;
  role: FlowRole;
  kind: HopKind;
}

interface IssueSuggestion {
  title: string;
  summary: string;
  steps: string[];
  code?: string;
  caveats: string[];
}

interface StateIssue {
  id: string;
  type: IssueType;
  severity: Severity;
  title: string;
  description: string;
  filePath: string;
  line: number;
  snippet?: string;
  suggestion: IssueSuggestion;
}

interface StateUnit {
  id: string;
  name: string;
  kind: StateKind;
  filePath: string;
  line: number;
  owner: string;
  setter?: string;
  initial?: string;
  viaContexts: string[];
  severity: Severity;
  riskScore: number;
  issueCount: number;
  issues: StateIssue[];
  reads: StateAccess[];
  writes: StateAccess[];
  hiddenReads: number;
  hiddenWrites: number;
  readerComponents: number;
  writerComponents: number;
  consumerCount: number;
  drillDepth: number;
  passThroughComponents: string[];
  flow: FlowHop[];
  graph: { nodes: FlowNode[]; edges: FlowEdge[]; hiddenNodes: number };
}

interface ComponentHotspot {
  name: string;
  filePath: string;
  line: number;
  ownedStates: number;
  passThroughs: number;
  statesTouched: number;
}

interface StateFlowReport {
  success: boolean;
  tool: "analyze_state_flow";
  projectPath: string;
  filePath?: string;
  minDrillDepth: number;
  includeTests: boolean;
  filesScanned: number;
  componentsAnalyzed: number;
  hooksAnalyzed: number;
  totalStates: number;
  projectStateCount: number;
  localStates: number;
  storeStates: number;
  contextCount: number;
  statesWithIssues: number;
  drillingStates: number;
  deepestDrill: number;
  sharedStates: number;
  totalIssues: number;
  summary: Record<Severity, number>;
  kindCounts: Record<StateKind, number>;
  units: StateUnit[];
  hotspots: ComponentHotspot[];
  warnings: string[];
}

interface AnalyzeStateFlowProps {
  projectPath: string;
  onProjectPathChange?: (value: string) => void;
  apiUrl?: string;
}

type KindFilter = "all" | "useState" | "useReducer" | "store";
type FocusFilter = "all" | "issues" | "drilling" | "shared";
type SortKey = "risk" | "reach" | "drilling" | "name";

const DEFAULT_API_URL = "http://127.0.0.1:4174/api/analyze-state-flow";

const KIND_LABEL: Record<StateKind, string> = {
  useState: "useState",
  useReducer: "useReducer",
  redux: "Redux slice",
  zustand: "Zustand store",
  jotai: "Jotai atom",
};

const KIND_FILTER_LABEL: Record<KindFilter, string> = {
  all: "All",
  useState: "useState",
  useReducer: "useReducer",
  store: "Stores",
};

const ISSUE_LABEL: Record<IssueType, string> = {
  "prop-drilling": "Prop drilling",
  "unused-state": "Unused",
  "write-only-state": "Write only",
  "never-updated": "Never updated",
  "derived-state": "Derived state",
  "state-too-high": "Too high",
  "direct-mutation": "Mutation",
  "render-phase-update": "Update in render",
  "unstable-context-value": "Context value",
  "scattered-updates": "Scattered updates",
  "stale-update": "Stale update",
};

const ROLE_LABEL: Record<FlowRole, string> = {
  value: "state",
  derived: "derived value",
  setter: "setter",
  handler: "callback",
};

const BEHAVIOR_CAPTION: Record<NodeBehavior, string> = {
  state: "state",
  owner: "owns the state",
  "pass-through": "only passes it on",
  reader: "reads it",
  writer: "updates it",
  "reader-writer": "reads and updates",
  idle: "receives, ignores",
  context: "context",
  store: "shared store",
  external: "library component",
};

const FOCUS_NOTE: Record<Exclude<FocusFilter, "all">, string> = {
  issues: "with issues",
  drilling: "with prop drilling",
  shared: "shared through context or a store",
};

function isStoreKind(kind: StateKind): boolean {
  return kind === "redux" || kind === "zustand" || kind === "jotai";
}

function baseName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1];
}

function statusOf(unit: StateUnit): string {
  return unit.issueCount === 0 ? "clean" : unit.severity;
}

function kindIcon(kind: StateKind, size = 17) {
  if (kind === "useReducer") return <Layers size={size} />;
  if (isStoreKind(kind)) return <Database size={size} />;
  return <Box size={size} />;
}

function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

function describeUnit(unit: StateUnit): string {
  const parts = [
    `${unit.name} is a ${KIND_LABEL[unit.kind]} ${
      isStoreKind(unit.kind) ? "defined" : "declared"
    } in ${unit.owner}.`,
    `It is read in ${plural(unit.readerComponents, "component")} and updated from ${plural(
      unit.writerComponents,
      "component"
    )}.`,
  ];

  if (unit.viaContexts.length > 0) {
    parts.push(`It travels through ${unit.viaContexts.join(", ")}.`);
  }

  if (unit.passThroughComponents.length > 0) {
    parts.push(
      `${unit.passThroughComponents.join(", ")} ${
        unit.passThroughComponents.length === 1 ? "only passes" : "only pass"
      } it along without using it.`
    );
  }

  return parts.join(" ");
}

/* -------------------------------------------------------------------------- */
/*  Flow diagram                                                              */
/* -------------------------------------------------------------------------- */

interface NodeTone {
  border: string;
  background: string;
  dashed?: boolean;
}

const NODE_TONE: Record<NodeBehavior, NodeTone> = {
  state: { border: "#8176ff", background: "rgba(91, 78, 213, 0.32)" },
  store: { border: "#8176ff", background: "rgba(91, 78, 213, 0.32)" },
  owner: { border: "#8176ff", background: "#111625" },
  "pass-through": {
    border: "#f5cf79",
    background: "rgba(145, 107, 30, 0.2)",
    dashed: true,
  },
  reader: { border: "#78b8ff", background: "rgba(37, 83, 160, 0.22)" },
  writer: { border: "#ffab7d", background: "rgba(159, 76, 35, 0.2)" },
  "reader-writer": { border: "#63d894", background: "rgba(54, 140, 94, 0.18)" },
  idle: { border: "#66738c", background: "#111625", dashed: true },
  context: {
    border: "#b4adff",
    background: "rgba(91, 78, 213, 0.14)",
    dashed: true,
  },
  external: { border: "#66738c", background: "#0d1322", dashed: true },
};

const NODE_WIDTH = 190;
const NODE_HEIGHT = 50;
const ROW_GAP = 68;
const COLUMN_GAP = 250;
const COLUMN_GAP_LABELED = 340;
const GROUP_MIN = 4;
const FIT_OPTIONS = { padding: 0.15, minZoom: 0.4, duration: 250 };

const LEAF_BEHAVIORS = new Set<NodeBehavior>([
  "reader",
  "writer",
  "reader-writer",
  "idle",
]);

interface LayoutNode {
  id: string;
  label: string;
  caption: string;
  tone: NodeTone;
  depth: number;
  title: string;
  stacked: boolean;
}

interface LayoutEdge {
  id: string;
  from: string;
  to: string;
  labels: string[];
  hasWrite: boolean;
  hasValue: boolean;
}

interface Simplified {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  /** Leaf components that can be folded into a group node. */
  groupableCount: number;
}

function nodeCaption(node: FlowNode): string {
  return node.type === "hook" && node.behavior === "pass-through"
    ? "hook relays it"
    : BEHAVIOR_CAPTION[node.behavior];
}

/**
 * Optionally folds leaf components that hang off the same parent into one
 * node, and merges parallel edges, so wide fan-outs stay readable.
 */
function simplifyGraph(graph: StateUnit["graph"], grouped: boolean): Simplified {
  const incoming = new Map<string, FlowEdge[]>();
  const outgoing = new Map<string, FlowEdge[]>();

  for (const edge of graph.edges) {
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  }

  const leavesByParent = new Map<string, FlowNode[]>();

  for (const node of graph.nodes) {
    if (!LEAF_BEHAVIORS.has(node.behavior)) continue;
    if ((outgoing.get(node.id)?.length ?? 0) > 0) continue;

    // Several props from the same parent still count as one parent.
    const parents = new Set((incoming.get(node.id) ?? []).map((edge) => edge.from));
    if (parents.size !== 1) continue;

    const [parentId] = [...parents];
    const list = leavesByParent.get(parentId) ?? [];
    list.push(node);
    leavesByParent.set(parentId, list);
  }

  const groupable = [...leavesByParent.entries()].filter(
    ([, list]) => list.length >= GROUP_MIN
  );
  const groupableCount = groupable.reduce(
    (sum, [, list]) => sum + list.length,
    0
  );

  const replacement = new Map<string, string>();
  const nodes: LayoutNode[] = [];

  if (grouped) {
    for (const [parentId, list] of groupable) {
      const groupId = `group:${parentId}`;
      for (const child of list) replacement.set(child.id, groupId);

      const reads = list.some((node) => node.reads > 0);
      const writes = list.some((node) => node.writes > 0);
      const behavior: NodeBehavior =
        reads && writes ? "reader-writer" : writes ? "writer" : "reader";

      nodes.push({
        id: groupId,
        label: `${list.length} components`,
        caption: reads && writes ? "read or update it" : writes ? "update it" : "read it",
        tone: NODE_TONE[behavior],
        depth: Math.min(...list.map((node) => node.depth)),
        title: list.map((node) => node.label).join(", "),
        stacked: true,
      });
    }
  }

  for (const node of graph.nodes) {
    if (replacement.has(node.id)) continue;

    nodes.push({
      id: node.id,
      label: node.label,
      caption: nodeCaption(node),
      tone: NODE_TONE[node.behavior],
      depth: node.depth,
      title: node.filePath ?? node.label,
      stacked: false,
    });
  }

  const merged = new Map<string, LayoutEdge>();

  for (const edge of graph.edges) {
    const from = replacement.get(edge.from) ?? edge.from;
    const to = replacement.get(edge.to) ?? edge.to;
    if (from === to) continue;

    const key = `${from}>${to}`;
    const entry = merged.get(key) ?? {
      id: key,
      from,
      to,
      labels: [],
      hasWrite: false,
      hasValue: false,
    };

    if (!entry.labels.includes(edge.label)) entry.labels.push(edge.label);
    if (edge.role === "setter" || edge.role === "handler") entry.hasWrite = true;
    else entry.hasValue = true;

    merged.set(key, entry);
  }

  return { nodes, edges: [...merged.values()], groupableCount };
}

function edgeLabel(labels: string[]): string {
  const joined = labels.join(", ");
  if (joined.length <= 34) return joined;
  return `${labels[0].slice(0, 28)}${labels[0].length > 28 ? "…" : ""} +${
    labels.length - 1
  }`;
}

function buildFlowElements(
  layout: Simplified,
  options: { labels: boolean; hovered: string | null }
): { nodes: Node[]; edges: Edge[]; rows: number } {
  const columns = new Map<number, LayoutNode[]>();

  for (const node of layout.nodes) {
    const column = columns.get(node.depth) ?? [];
    column.push(node);
    columns.set(node.depth, column);
  }

  const gap = options.labels ? COLUMN_GAP_LABELED : COLUMN_GAP;

  const connected = new Set<string>();
  if (options.hovered) {
    connected.add(options.hovered);
    for (const edge of layout.edges) {
      if (edge.from === options.hovered) connected.add(edge.to);
      if (edge.to === options.hovered) connected.add(edge.from);
    }
  }

  const nodes: Node[] = [];
  let rows = 1;

  for (const [depth, list] of columns) {
    rows = Math.max(rows, list.length);

    list.forEach((node, index) => {
      const dimmed = !!options.hovered && !connected.has(node.id);

      nodes.push({
        id: node.id,
        position: {
          x: depth * gap,
          y: (index - (list.length - 1) / 2) * ROW_GAP,
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        draggable: false,
        connectable: false,
        data: {
          color: node.tone.border,
          label: (
            <div className="sf-node" title={node.title}>
              <strong>{node.label}</strong>
              <span>{node.caption}</span>
            </div>
          ),
        },
        style: {
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          padding: "7px 10px",
          borderRadius: 10,
          border: `1px ${node.tone.dashed ? "dashed" : "solid"} ${node.tone.border}`,
          background: node.tone.background,
          color: "#e8edf8",
          fontSize: 12,
          opacity: dimmed ? 0.3 : 1,
          boxShadow: node.stacked
            ? `5px 5px 0 -1px #0a101d, 5px 5px 0 0 ${node.tone.border}`
            : undefined,
          transition: "opacity 0.15s ease",
        },
      });
    });
  }

  const edges: Edge[] = layout.edges.map((edge): Edge => {
    const writesOnly = edge.hasWrite && !edge.hasValue;
    const color = writesOnly ? "#f5cf79" : "#8176ff";
    const touches =
      !options.hovered ||
      edge.from === options.hovered ||
      edge.to === options.hovered;

    return {
      id: edge.id,
      source: edge.from,
      target: edge.to,
      label: options.labels ? edgeLabel(edge.labels) : undefined,
      type: "smoothstep",
      animated: writesOnly && touches,
      markerEnd: { type: MarkerType.ArrowClosed, color },
      style: {
        stroke: color,
        strokeWidth: options.hovered && touches ? 2.4 : 1.5,
        strokeDasharray: writesOnly ? "5 4" : undefined,
        opacity: touches ? 1 : 0.12,
        transition: "opacity 0.15s ease",
      },
      labelStyle: { fill: "#cbd4e5", fontSize: 11, fontWeight: 600 },
      labelBgStyle: { fill: "#0b1221", fillOpacity: 0.95 },
      labelBgPadding: [6, 4] as [number, number],
      labelBgBorderRadius: 5,
    };
  });

  return { nodes, edges, rows };
}

function GraphCanvas({ graph }: { graph: StateUnit["graph"] }) {
  const flow = useReactFlow();
  const { zoom } = useViewport();

  const base = useMemo(() => simplifyGraph(graph, false), [graph]);
  const canGroup = base.groupableCount > 0;

  const [grouped, setGrouped] = useState(canGroup && graph.nodes.length > 12);
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);

  const layout = useMemo(() => simplifyGraph(graph, grouped), [graph, grouped]);

  const [labels, setLabels] = useState(layout.edges.length <= 10);

  const { nodes, edges, rows } = useMemo(
    () => buildFlowElements(layout, { labels, hovered }),
    [layout, labels, hovered]
  );

  const flowRef = useRef(flow);
  flowRef.current = flow;

  // Re-fit after anything that changes the layout or the canvas size.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void flowRef.current.fitView(FIT_OPTIONS);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [grouped, labels, expanded]);

  useEffect(() => {
    if (!expanded) return undefined;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const stateNode = graph.nodes.find(
    (node) => node.type === "state" || node.type === "store"
  );

  function focusState() {
    const target = nodes.find((node) => node.id === stateNode?.id);
    if (!target) return;

    void flowRef.current.setCenter(
      target.position.x + NODE_WIDTH / 2,
      target.position.y + NODE_HEIGHT / 2,
      { zoom: 1, duration: 300 }
    );
  }

  const height = Math.min(520, Math.max(280, rows * ROW_GAP + 90));
  const hiddenByGroup = graph.nodes.length - layout.nodes.length;

  return (
    <div
      className="sf-graph-slot"
      style={expanded ? { height: height + 96 } : undefined}
    >
      <div className={`sf-graph-shell ${expanded ? "expanded" : ""}`}>
        {expanded && (
          <button
            type="button"
            className="sf-graph-backdrop"
            aria-label="Close expanded diagram"
            onClick={() => setExpanded(false)}
          />
        )}

        <div className="sf-graph-panel">
          <div className="sf-graph-toolbar" role="toolbar" aria-label="Diagram controls">
            <div className="sf-tool-group">
              <button type="button" onClick={() => void flow.fitView(FIT_OPTIONS)}>
                <Maximize size={14} /> Fit view
              </button>
              <button type="button" onClick={focusState}>
                <Crosshair size={14} /> Focus state
              </button>
            </div>

            <div className="sf-tool-group">
              <button
                type="button"
                className="icon"
                aria-label="Zoom out"
                onClick={() => void flow.zoomOut({ duration: 200 })}
              >
                <ZoomOut size={15} />
              </button>
              <button
                type="button"
                className="zoom-reset"
                aria-label="Reset zoom to 100%"
                onClick={() => void flow.zoomTo(1, { duration: 200 })}
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                className="icon"
                aria-label="Zoom in"
                onClick={() => void flow.zoomIn({ duration: 200 })}
              >
                <ZoomIn size={15} />
              </button>
            </div>

            <div className="sf-tool-group">
              {canGroup && (
                <button
                  type="button"
                  className={grouped ? "active" : ""}
                  aria-pressed={grouped}
                  onClick={() => setGrouped(!grouped)}
                  title="Fold components that only read or update the state into one node"
                >
                  <Layers size={14} /> Group components
                </button>
              )}
              <button
                type="button"
                className={labels ? "active" : ""}
                aria-pressed={labels}
                onClick={() => setLabels(!labels)}
                title="Show the prop name on each arrow"
              >
                <Tag size={14} /> Labels
              </button>
            </div>

            <button
              type="button"
              className="sf-tool-expand"
              aria-pressed={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              {expanded ? "Close" : "Expand"}
            </button>
          </div>

          <div
            className="sf-graph"
            style={expanded ? undefined : { height }}
            role="img"
            aria-label={`Flow diagram with ${layout.nodes.length} nodes`}
          >
            <ReactFlow
              nodes={nodes}
              edges={edges}
              colorMode="dark"
              fitView
              fitViewOptions={FIT_OPTIONS}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              zoomOnScroll={expanded}
              preventScrolling={expanded}
              minZoom={0.15}
              maxZoom={1.8}
              onNodeMouseEnter={(_event, node) => setHovered(node.id)}
              onNodeMouseLeave={() => setHovered(null)}
            >
              <Background gap={22} size={1} color="rgba(120, 135, 170, 0.16)" />
              {expanded && (
                <MiniMap
                  pannable
                  zoomable
                  nodeColor={(node) => String(node.data.color ?? "#8176ff")}
                  maskColor="rgba(10, 16, 29, 0.72)"
                />
              )}
            </ReactFlow>
          </div>

          <ul className="sf-legend" aria-label="Diagram legend">
            <li>
              <i className="sf-legend-line" /> state passed down
            </li>
            <li>
              <i className="sf-legend-line dashed" /> setter or callback
            </li>
            <li>
              <i className="sf-legend-box owner" /> owner
            </li>
            <li>
              <i className="sf-legend-box pass" /> only passes it on
            </li>
            <li>
              <i className="sf-legend-box reader" /> reads
            </li>
            <li>
              <i className="sf-legend-box writer" /> updates
            </li>
            {grouped && hiddenByGroup > 0 && (
              <li>
                <i className="sf-legend-box group" /> group of components
              </li>
            )}
          </ul>

          <p className="sf-fine-print-inline">
            {grouped && hiddenByGroup > 0
              ? `${hiddenByGroup} components are folded into groups. Hover a group to see their names, or turn off Group components to draw each one.`
              : "Hover a node to highlight its connections."}
            {graph.hiddenNodes > 0 &&
              ` ${graph.hiddenNodes} more ${
                graph.hiddenNodes === 1 ? "node was" : "nodes were"
              } left out of the data.`}
            {expanded ? " Press Esc to close." : ""}
          </p>
        </div>
      </div>
    </div>
  );
}

function StateFlowGraph({ graph }: { graph: StateUnit["graph"] }) {
  return (
    <ReactFlowProvider>
      <GraphCanvas graph={graph} />
    </ReactFlowProvider>
  );
}

/* -------------------------------------------------------------------------- */
/*  Flow path and access lists                                                */
/* -------------------------------------------------------------------------- */

const MAX_HOPS_SHOWN = 16;

function FlowPath({ hops }: { hops: FlowHop[] }) {
  const shown = hops.slice(0, MAX_HOPS_SHOWN);

  return (
    <ol className="sf-hops">
      {shown.map((hop, index) => (
        <li key={`${hop.fromId}-${hop.toId}-${hop.prop}-${index}`}>
          <span className="sf-hop-name" title={hop.from}>
            {hop.from}
          </span>
          <ArrowRight size={13} />
          <span className="sf-hop-name" title={hop.to}>
            {hop.to}
          </span>
          <span className="sf-prop" title={hop.prop}>
            {hop.prop}
          </span>
          <span className={`sf-role role-${hop.role}`}>
            {ROLE_LABEL[hop.role]}
          </span>
        </li>
      ))}

      {hops.length > shown.length && (
        <li className="sf-hops-more">
          +{hops.length - shown.length} more steps not shown
        </li>
      )}
    </ol>
  );
}

function AccessList({
  title,
  empty,
  items,
  hidden,
}: {
  title: string;
  empty: string;
  items: StateAccess[];
  hidden: number;
}) {
  const groups = useMemo(() => {
    const map = new Map<
      string,
      { component: string; filePath: string; items: StateAccess[] }
    >();

    for (const item of items) {
      const key = `${item.filePath}#${item.component}`;
      const group = map.get(key) ?? {
        component: item.component,
        filePath: item.filePath,
        items: [],
      };
      group.items.push(item);
      map.set(key, group);
    }

    return [...map.values()];
  }, [items]);

  return (
    <section className="sf-box sf-access">
      <h4>{title}</h4>

      {groups.length === 0 ? (
        <p>{empty}</p>
      ) : (
        <ul>
          {groups.map((group) => (
            <li key={`${group.filePath}#${group.component}`}>
              <div className="sf-access-head">
                <FileCode2 size={13} />
                <strong>{group.component}</strong>
                <span title={group.filePath}>{baseName(group.filePath)}</span>
              </div>

              <ul className="sf-access-lines">
                {group.items.map((item, index) => (
                  <li key={`${item.line}-${item.via}-${index}`}>
                    <em>line {item.line}</em>
                    <span>{item.detail}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}

          {hidden > 0 && (
            <li className="sf-access-more">+{hidden} more not shown</li>
          )}
        </ul>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Issue with suggested fix                                                  */
/* -------------------------------------------------------------------------- */

function IssueCard({ issue }: { issue: StateIssue }) {
  const [copied, setCopied] = useState<"" | "code" | "place">("");
  const [copyFailed, setCopyFailed] = useState(false);
  const { suggestion } = issue;

  async function copy(kind: "code" | "place", value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      setCopyFailed(false);
      window.setTimeout(() => setCopied(""), 2000);
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    <section className="sf-box sf-issue">
      <div className="sf-issue-head">
        <span className={`sf-badge sf-badge-${issue.severity}`}>
          {issue.severity}
        </span>
        <span className="sf-kind-badge">{ISSUE_LABEL[issue.type]}</span>
      </div>

      <p className="sf-issue-title">{issue.title}</p>
      <p>{issue.description}</p>

      <p className="sf-issue-place" title={issue.filePath}>
        <FileCode2 size={12} />
        {issue.filePath}:{issue.line}
      </p>

      {issue.snippet && <pre className="sf-snippet">{issue.snippet}</pre>}

      <div className="sf-fix">
        <h5>
          <Wrench size={13} /> Suggested fix
        </h5>

        <p className="sf-refactor-title">{suggestion.title}</p>
        <p>{suggestion.summary}</p>

        <ol className="sf-steps">
          {suggestion.steps.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>

        {suggestion.code && (
          <pre className="sf-code-block">
            <code>{suggestion.code}</code>
          </pre>
        )}

        <div className="sf-actions">
          {suggestion.code && (
            <button
              type="button"
              onClick={() => copy("code", suggestion.code!)}
            >
              {copied === "code" ? <Check size={14} /> : <Copy size={14} />}
              {copied === "code" ? "Copied" : "Copy example"}
            </button>
          )}

          <button
            type="button"
            onClick={() => copy("place", `${issue.filePath}:${issue.line}`)}
          >
            {copied === "place" ? <Check size={14} /> : <Copy size={14} />}
            {copied === "place" ? "Copied" : "Copy location"}
          </button>
        </div>

        {copyFailed && (
          <p className="sf-fine-print">
            The browser blocked clipboard access. Select the text and copy it
            manually.
          </p>
        )}

        {suggestion.caveats.length > 0 && (
          <ul className="sf-caveats">
            {suggestion.caveats.map((caveat, index) => (
              <li key={index}>{caveat}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  View                                                                      */
/* -------------------------------------------------------------------------- */

export default function AnalyzeStateFlow({
  projectPath,
  onProjectPathChange,
  apiUrl = DEFAULT_API_URL,
}: AnalyzeStateFlowProps) {
  const [focusFile, setFocusFile] = useState("");
  const [minDrillDepth, setMinDrillDepth] = useState("2");
  const [includeTests, setIncludeTests] = useState(false);

  const [report, setReport] = useState<StateFlowReport | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [focus, setFocus] = useState<FocusFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("risk");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function analyze() {
    if (!projectPath.trim()) {
      setError("Enter a project path before starting the analysis.");
      return;
    }

    const depth = Number(minDrillDepth);

    if (!Number.isInteger(depth) || depth < 1 || depth > 10) {
      setError("Drilling threshold must be a whole number between 1 and 10.");
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
          minDrillDepth: depth,
          includeTests,
        }),
      });

      const data = await response.json();

      if (!response.ok || data.success === false) {
        throw new Error(data.error || "State flow analysis failed.");
      }

      const nextReport = data as StateFlowReport;
      setReport(nextReport);
      setSelectedId(nextReport.units[0]?.id ?? null);
      setSearch("");
      setKindFilter("all");
      setFocus("all");
      setSortKey("risk");
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

  const visibleUnits = useMemo(() => {
    if (!report) return [];

    const query = search.trim().toLowerCase();

    const filtered = report.units.filter((unit) => {
      if (kindFilter === "store" && !isStoreKind(unit.kind)) return false;
      if (
        (kindFilter === "useState" || kindFilter === "useReducer") &&
        unit.kind !== kindFilter
      ) {
        return false;
      }

      if (focus === "issues" && unit.issueCount === 0) return false;
      if (focus === "drilling" && unit.drillDepth < report.minDrillDepth) {
        return false;
      }
      if (
        focus === "shared" &&
        unit.viaContexts.length === 0 &&
        !isStoreKind(unit.kind)
      ) {
        return false;
      }

      if (!query) return true;

      return [
        unit.name,
        unit.owner,
        unit.filePath,
        KIND_LABEL[unit.kind],
        ...unit.viaContexts,
        ...unit.graph.nodes.map((node) => node.label),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

    return [...filtered].sort((a, b) => {
      if (sortKey === "reach") {
        return b.consumerCount - a.consumerCount || b.riskScore - a.riskScore;
      }
      if (sortKey === "drilling") {
        return b.drillDepth - a.drillDepth || b.riskScore - a.riskScore;
      }
      if (sortKey === "name") return a.name.localeCompare(b.name);
      return b.riskScore - a.riskScore;
    });
  }, [report, search, kindFilter, focus, sortKey]);

  const selectedUnit =
    visibleUnits.find((unit) => unit.id === selectedId) ??
    visibleUnits[0] ??
    null;

  function toggleFocus(next: Exclude<FocusFilter, "all">) {
    setFocus(focus === next ? "all" : next);
  }

  return (
    <div className="sf-analyzer">
      <div className="sf-title-row">
        <div className="sf-title-icon">
          <GitBranch size={24} />
        </div>

        <div>
          <h1>State Flow Analyzer</h1>
          <p>
            Follow every piece of state from where it is declared to the
            components that read and update it, and find where it is passed
            through layers that never use it.
          </p>
        </div>
      </div>

      <section className="sf-input-card">
        <div className="sf-field sf-field-wide">
          <label htmlFor="sf-project-path">Project path</label>
          <input
            id="sf-project-path"
            value={projectPath}
            onChange={(event) => onProjectPathChange?.(event.target.value)}
            placeholder="/path/to/your/project"
          />
        </div>

        <div className="sf-field">
          <label htmlFor="sf-focus-file">Focus file (optional)</label>
          <input
            id="sf-focus-file"
            value={focusFile}
            onChange={(event) => setFocusFile(event.target.value)}
            placeholder="src/App.tsx"
          />
        </div>

        <button
          type="button"
          className="sf-analyze-button"
          onClick={analyze}
          disabled={loading}
        >
          {loading ? (
            <>
              <span className="sf-spinner" />
              Tracing...
            </>
          ) : (
            <>
              <GitBranch size={17} />
              Trace State
            </>
          )}
        </button>

        <div className="sf-options">
          <div className="sf-field">
            <label htmlFor="sf-min-drill">
              Report drilling after (components)
            </label>
            <input
              id="sf-min-drill"
              type="number"
              min={1}
              max={10}
              value={minDrillDepth}
              onChange={(event) => setMinDrillDepth(event.target.value)}
            />
          </div>

          <label className="sf-check">
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
        <div className="sf-error" role="alert">
          <XCircle size={18} />
          {error}
        </div>
      )}

      {report && (
        <>
          <div className="sf-status-row">
            <div
              className={`sf-success ${
                report.statesWithIssues === 0 ? "" : "has-groups"
              }`}
            >
              {report.statesWithIssues === 0 ? (
                <CheckCircle2 size={18} />
              ) : (
                <AlertTriangle size={18} />
              )}
              <strong>{report.totalStates}</strong>
              <span>
                state {report.totalStates === 1 ? "item" : "items"} traced
                {report.statesWithIssues > 0
                  ? `, ${report.statesWithIssues} with issues`
                  : ""}
                {report.filePath ? ` involving ${report.filePath}` : ""}
              </span>
            </div>

            <span className="sf-scope">
              {report.filesScanned} files · {report.componentsAnalyzed}{" "}
              components · {report.hooksAnalyzed} hooks
              {report.filePath
                ? ` · ${report.projectStateCount} state items project-wide`
                : ""}
            </span>
          </div>

          <div className="sf-summary-grid">
            <div className="sf-summary-card static">
              <div className="sf-summary-icon tone-total">
                <Layers size={17} />
              </div>
              <div>
                <strong>{report.totalStates}</strong>
                <span>
                  State items · {report.localStates} local ·{" "}
                  {report.storeStates} in stores
                </span>
              </div>
            </div>

            <button
              type="button"
              className={`sf-summary-card ${focus === "issues" ? "active" : ""}`}
              onClick={() => toggleFocus("issues")}
              aria-pressed={focus === "issues"}
            >
              <div className="sf-summary-icon tone-issues">
                <AlertTriangle size={17} />
              </div>
              <div>
                <strong>{report.statesWithIssues}</strong>
                <span>Need attention · {plural(report.totalIssues, "issue")}</span>
              </div>
            </button>

            <button
              type="button"
              className={`sf-summary-card ${focus === "drilling" ? "active" : ""}`}
              onClick={() => toggleFocus("drilling")}
              aria-pressed={focus === "drilling"}
            >
              <div className="sf-summary-icon tone-drill">
                <ArrowRight size={17} />
              </div>
              <div>
                <strong>{report.drillingStates}</strong>
                <span>Prop drilling · deepest chain {report.deepestDrill}</span>
              </div>
            </button>

            <button
              type="button"
              className={`sf-summary-card ${focus === "shared" ? "active" : ""}`}
              onClick={() => toggleFocus("shared")}
              aria-pressed={focus === "shared"}
            >
              <div className="sf-summary-icon tone-shared">
                <Share2 size={17} />
              </div>
              <div>
                <strong>{report.sharedStates}</strong>
                <span>
                  Shared state · {plural(report.contextCount, "context")} in
                  project
                </span>
              </div>
            </button>
          </div>

          {report.totalStates === 0 ? (
            <section className="sf-clean">
              <CheckCircle2 size={38} />
              <h3>No state found</h3>
              <p>
                None of the {report.filesScanned} analyzed files declare
                useState, useReducer, a Redux slice, a Zustand store, or a
                Jotai atom
                {report.filePath ? ` that involves ${report.filePath}` : ""}.
              </p>
            </section>
          ) : (
            <section className="sf-workspace">
              <div className="sf-groups-panel">
                <div className="sf-panel-header">
                  <div>
                    <h2>State Items</h2>
                    <p>
                      {visibleUnits.length} of {report.units.length} items
                      {focus !== "all" ? ` ${FOCUS_NOTE[focus]}` : ""}
                    </p>
                  </div>

                  <div className="sf-count-pill">
                    <GitBranch size={15} />
                    {visibleUnits.length}
                  </div>
                </div>

                <div className="sf-filters">
                  <div className="sf-search">
                    <Search size={17} />
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search by state, component, or file..."
                      aria-label="Search state items"
                    />
                  </div>

                  <div className="sf-filter-row">
                    <div
                      className="sf-type-filter"
                      role="group"
                      aria-label="Filter by state type"
                    >
                      {(Object.keys(KIND_FILTER_LABEL) as KindFilter[]).map(
                        (option) => (
                          <button
                            type="button"
                            key={option}
                            className={kindFilter === option ? "active" : ""}
                            aria-pressed={kindFilter === option}
                            onClick={() => setKindFilter(option)}
                          >
                            {KIND_FILTER_LABEL[option]}
                          </button>
                        )
                      )}
                    </div>

                    <div className="sf-sort">
                      <SecuritySelect
                        ariaLabel="Sort state items"
                        value={sortKey}
                        onChange={setSortKey}
                        options={[
                          { value: "risk", label: "Sort: risk" },
                          { value: "reach", label: "Sort: components using it" },
                          { value: "drilling", label: "Sort: drilling depth" },
                          { value: "name", label: "Sort: name" },
                        ]}
                      />
                    </div>
                  </div>
                </div>

                <div className="sf-groups-list">
                  {visibleUnits.length === 0 ? (
                    <div className="sf-empty">
                      <GitBranch size={34} />
                      <h3>No matching state</h3>
                      <p>No state items match the current filters.</p>
                    </div>
                  ) : (
                    visibleUnits.map((unit) => (
                      <button
                        type="button"
                        key={unit.id}
                        className={`sf-group ${
                          selectedUnit?.id === unit.id ? "selected" : ""
                        }`}
                        onClick={() => setSelectedId(unit.id)}
                      >
                        <div
                          className={`sf-group-icon sf-severity-${statusOf(unit)}`}
                        >
                          {kindIcon(unit.kind)}
                        </div>

                        <div className="sf-group-content">
                          <div className="sf-group-top">
                            <span
                              className={`sf-badge sf-badge-${statusOf(unit)}`}
                            >
                              {statusOf(unit)}
                            </span>
                            <span className="sf-kind-badge">
                              {KIND_LABEL[unit.kind]}
                            </span>
                            {unit.drillDepth >= report.minDrillDepth && (
                              <span className="sf-kind-badge sf-drill-badge">
                                drilled ×{unit.drillDepth}
                              </span>
                            )}
                            {unit.viaContexts.length > 0 && (
                              <span className="sf-kind-badge">context</span>
                            )}
                          </div>

                          <h3>{unit.name}</h3>
                          <p className="sf-places">
                            {unit.owner} · {baseName(unit.filePath)}:{unit.line}
                            {" · "}
                            {plural(unit.readerComponents, "reader")},{" "}
                            {plural(unit.writerComponents, "updater")}
                            {unit.issueCount > 0 &&
                              ` · ${plural(unit.issueCount, "issue")}`}
                          </p>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>

              <aside className="sf-inspector">
                <div className="sf-panel-header">
                  <div>
                    <h2>Inspector</h2>
                    <p>How this state moves and what to fix</p>
                  </div>
                </div>

                {selectedUnit ? (
                  <div className="sf-inspector-body">
                    <div className="sf-inspector-title">
                      <div
                        className={`sf-inspector-icon sf-severity-${statusOf(
                          selectedUnit
                        )}`}
                      >
                        {kindIcon(selectedUnit.kind, 20)}
                      </div>

                      <div>
                        <span
                          className={`sf-badge sf-badge-${statusOf(selectedUnit)}`}
                        >
                          {statusOf(selectedUnit)}
                        </span>
                        <h3>{selectedUnit.name}</h3>
                      </div>
                    </div>

                    <div className="sf-detail-grid">
                      <div>
                        <span>Type</span>
                        <strong>{KIND_LABEL[selectedUnit.kind]}</strong>
                      </div>
                      <div>
                        <span>Declared in</span>
                        <strong title={selectedUnit.filePath}>
                          {baseName(selectedUnit.filePath)}:{selectedUnit.line}
                        </strong>
                      </div>
                      <div>
                        <span>Components using it</span>
                        <strong>{selectedUnit.consumerCount}</strong>
                      </div>
                      <div>
                        <span>Risk score</span>
                        <strong>{selectedUnit.riskScore} / 100</strong>
                      </div>
                    </div>

                    <section className="sf-box">
                      <h4>What this means</h4>
                      <p>{describeUnit(selectedUnit)}</p>
                    </section>

                    <section className="sf-box">
                      <h4>Flow diagram</h4>
                      <StateFlowGraph
                        key={`graph-${selectedUnit.id}`}
                        graph={selectedUnit.graph}
                      />
                    </section>

                    {selectedUnit.flow.length > 0 && (
                      <section className="sf-box">
                        <h4>How it moves</h4>
                        <FlowPath hops={selectedUnit.flow} />
                      </section>
                    )}

                    <div className="sf-access-grid">
                      <AccessList
                        title="Where it is read"
                        empty="Nothing reads this value."
                        items={selectedUnit.reads}
                        hidden={selectedUnit.hiddenReads}
                      />
                      <AccessList
                        title="Where it is updated"
                        empty="Nothing updates this value."
                        items={selectedUnit.writes}
                        hidden={selectedUnit.hiddenWrites}
                      />
                    </div>

                    {selectedUnit.issues.length === 0 ? (
                      <section className="sf-box sf-ok">
                        <CheckCircle2 size={18} />
                        <p>
                          No problems found. This state is declared close to
                          where it is used and is updated in a predictable way.
                        </p>
                      </section>
                    ) : (
                      <>
                        <h4 className="sf-section-title">
                          Issues ({selectedUnit.issues.length})
                        </h4>
                        {selectedUnit.issues.map((issue) => (
                          <IssueCard
                            key={`${selectedUnit.id}-${issue.id}`}
                            issue={issue}
                          />
                        ))}
                      </>
                    )}
                  </div>
                ) : (
                  <div className="sf-inspector-empty">
                    <GitBranch size={38} />
                    <h3>Select a state item</h3>
                    <p>
                      Choose a state item from the list to see how it flows
                      through your components and how to fix any problems.
                    </p>
                  </div>
                )}
              </aside>
            </section>
          )}

          {report.hotspots.length > 0 && (
            <section className="sf-hotspots">
              <div className="sf-panel-header">
                <div>
                  <h2>Busiest components</h2>
                  <p>
                    Components that own, relay, or use the most state. Select
                    one to filter.
                  </p>
                </div>
              </div>

              <ul>
                {report.hotspots.map((component) => (
                  <li key={`${component.filePath}#${component.name}`}>
                    <button
                      type="button"
                      onClick={() => {
                        setSearch(component.name);
                        setKindFilter("all");
                        setFocus("all");
                      }}
                    >
                      <FileCode2 size={14} />
                      <span title={component.filePath}>{component.name}</span>
                      <em>
                        {component.passThroughs > 0
                          ? `${component.passThroughs} relayed · `
                          : ""}
                        {baseName(component.filePath)}
                      </em>
                      <strong>{component.statesTouched}</strong>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {report.warnings.length > 0 && (
            <section className="sf-analysis-notes">
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