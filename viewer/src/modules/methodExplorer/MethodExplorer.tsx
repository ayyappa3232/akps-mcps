import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Box,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Code,
  Copy,
  Eye,
  EyeOff,
  FileText,
  Focus,
  GitFork,
  Info,
  Layers,
  List,
  Maximize2,
  Minus,
  Network,
  Phone,
  Play,
  Plus,
  Repeat,
  RefreshCw,
  Users,
  Zap
} from "lucide-react";
import "./method-explorer.css";

/* ------------------------------------------------------------------ */
/* Types — these mirror what explain-method.ts returns                  */
/* ------------------------------------------------------------------ */

type CallInfo = {
  name: string;
  category: string;
  expression?: string;
  line?: number;
  filePath?: string;
  awaited?: boolean;
  description?: string;
  target?: string;
  targetFilePath?: string;
  children?: CallInfo[];
};

type CallerInfo = {
  name: string;
  filePath: string;
  line: number;
  kind?: string;
  className?: string;
  expression?: string;
};

type MethodExplanation = {
  success: boolean;
  symbol: string;
  filePath: string;
  kind: string;
  summary: string;
  signature: string;
  documentation: string;
  returnType: string;
  async: boolean;
  exported: boolean;
  startLine: number;
  endLine: number;
  source?: string;
  recursive?: boolean;
  recursiveCalls?: number;
  callDetails?: CallInfo[];
  callers?: (CallerInfo | string)[];
  behavior: {
    calls: string[];
    conditions: number;
    loops: number;
    awaits: number;
    throws: number;
    returns: number;
    assignments: number;
    stateHooks: string[];
    effects: string[];
    branchDetails?: { kind: string; line: number; text: string }[];
    awaitDetails?: { line: number; text: string }[];
  };
  warnings: string[];
  error?: string;
};

type Variant = "project" | "external" | "builtin" | "recursive" | "call";

type CallItem = {
  name: string;
  category: string;
  variant: Variant;
  count: number;
  awaited: boolean;
  line: number;
  description: string;
  children: CallItem[];
};

type MethodNodeData = {
  id: string;
  name: string;
  subtitle?: string;
  variant: Variant;
  awaited: boolean;
  count: number;
  expandable: boolean;
  expanded: boolean;
  selected: boolean;
  isRoot: boolean;
  onToggle: (id: string) => void;
};

type MethodNodeType = Node<MethodNodeData, "mx">;

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

const ROOT_ID = "root";
const NODE_SLOT = 66;
const ROOT_WIDTH = 250;
const NODE_WIDTH = 240;

function variantOf(category: string): Variant {
  switch (category) {
    case "recursive":
      return "recursive";
    case "project-symbol":
    case "local-function":
    case "class-method":
      return "project";
    case "external":
    case "react-hook":
    case "state-setter":
      return "external";
    case "builtin":
      return "builtin";
    default:
      return "call";
  }
}

const VARIANT_LABEL: Record<Variant, string> = {
  project: "Project function",
  external: "External / API",
  builtin: "Built-in method",
  recursive: "Recursive call",
  call: "Other call"
};

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function aggregate(calls: CallInfo[] | undefined): CallItem[] {
  const map = new Map<string, CallItem>();

  for (const call of calls ?? []) {
    const key = `${call.name}|${call.category}`;
    const existing = map.get(key);

    if (existing) {
      existing.count += 1;
      if (call.awaited) existing.awaited = true;
      if (!existing.children.length && call.children?.length) {
        existing.children = aggregate(call.children);
      }
      continue;
    }

    const variant = variantOf(call.category);
    map.set(key, {
      name: call.name,
      category: call.category,
      variant,
      count: 1,
      awaited: Boolean(call.awaited),
      line: call.line ?? 0,
      description: call.description ?? VARIANT_LABEL[variant],
      children: aggregate(call.children)
    });
  }

  return [...map.values()];
}

function findItem(items: CallItem[], id: string): CallItem | null {
  const parts = id.split("/").slice(1).map(Number);
  let list = items;
  let found: CallItem | null = null;

  for (const part of parts) {
    found = list[part] ?? null;
    if (!found) return null;
    list = found.children;
  }
  return found;
}

function buildFlow(
  method: MethodExplanation,
  items: CallItem[],
  expanded: Set<string>,
  selectedId: string,
  onToggle: (id: string) => void
) {
  const nodes: MethodNodeType[] = [];
  const edges: Edge[] = [];

  /*
   * Layered layout:
   *   - depth controls the horizontal direction
   *   - large sibling groups are wrapped into multiple columns
   *   - every layer has a bounded number of rows
   *
   * This prevents a method with 20+ calls from becoming one extremely
   * tall column after Fit. The visual result is much closer to the
   * Change Impact Explorer: root -> direct calls -> deeper calls.
   */
  const ROWS_PER_COLUMN = 8;
  const NODE_X_GAP = 72;
  const NODE_Y_GAP = 30;
  const LEVEL_GAP = 92;

  type VisibleNode = {
    id: string;
    item: CallItem;
    depth: number;
    order: number;
    parentId: string;
  };

  const visible: VisibleNode[] = [];

  const collect = (
    list: CallItem[],
    parentId: string,
    depth: number
  ) => {
    list.forEach((item, index) => {
      const id = `${parentId}/${index}`;

      visible.push({
        id,
        item,
        depth,
        order: visible.length,
        parentId
      });

      if (expanded.has(id) && item.children.length) {
        collect(item.children, id, depth + 1);
      }
    });
  };

  if (expanded.has(ROOT_ID)) {
    collect(items, ROOT_ID, 1);
  }

  const byDepth = new Map<number, VisibleNode[]>();

  for (const item of visible) {
    const list = byDepth.get(item.depth) ?? [];
    list.push(item);
    byDepth.set(item.depth, list);
  }

  const columnCount = new Map<number, number>();

  for (const [depth, list] of byDepth) {
    columnCount.set(
      depth,
      Math.max(1, Math.ceil(list.length / ROWS_PER_COLUMN))
    );
  }

  const maxDepth = byDepth.size
    ? Math.max(...byDepth.keys())
    : 1;

  const depthStartX = new Map<number, number>();
  let nextX = ROOT_WIDTH + LEVEL_GAP;

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    depthStartX.set(depth, nextX);

    const columns = columnCount.get(depth) ?? 1;

    nextX +=
      columns * NODE_WIDTH +
      Math.max(0, columns - 1) * NODE_X_GAP +
      LEVEL_GAP;
  }

  const yForIndex = (index: number) => {
    const row = index % ROWS_PER_COLUMN;
    return row * (NODE_SLOT + NODE_Y_GAP);
  };

  for (const [depth, list] of byDepth) {
    list.forEach((entry, index) => {
      const column = Math.floor(index / ROWS_PER_COLUMN);

      nodes.push({
        id: entry.id,
        type: "mx",
        position: {
          x:
            (depthStartX.get(depth) ?? nextX) +
            column * (NODE_WIDTH + NODE_X_GAP),
          y: yForIndex(index)
        },
        draggable: false,
        selectable: false,
        data: {
          id: entry.id,
          name: entry.item.name,
          variant: entry.item.variant,
          awaited: entry.item.awaited,
          count: entry.item.count,
          expandable: entry.item.children.length > 0,
          expanded: expanded.has(entry.id),
          selected: selectedId === entry.id,
          isRoot: false,
          onToggle
        }
      });

      const isRecursive = entry.item.variant === "recursive";

      edges.push({
        id: `e-${entry.parentId}-${entry.id}`,
        source: entry.parentId,
        target: entry.id,
        type: "smoothstep",
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color: isRecursive ? "#fb923c" : "#8fa0b8"
        },
        style: {
          stroke: isRecursive ? "#fb923c" : "#8fa0b8",
          strokeWidth: isRecursive ? 1.8 : 1.5,
          strokeDasharray: isRecursive ? "6 4" : undefined
        }
      });
    });
  }

  const rowsVisible = Math.min(
    ROWS_PER_COLUMN,
    Math.max(1, visible.length)
  );

  const rootY =
    visible.length > 0
      ? ((rowsVisible - 1) * (NODE_SLOT + NODE_Y_GAP)) / 2
      : 0;

  nodes.push({
    id: ROOT_ID,
    type: "mx",
    position: { x: 0, y: rootY },
    draggable: false,
    selectable: false,
    data: {
      id: ROOT_ID,
      name: method.symbol,
      subtitle: method.async ? "async" : method.kind,
      variant: "call",
      awaited: false,
      count: 1,
      expandable: items.length > 0,
      expanded: expanded.has(ROOT_ID),
      selected: selectedId === ROOT_ID,
      isRoot: true,
      onToggle
    }
  });

  return { nodes, edges };
}

/* ------------------------------------------------------------------ */
/* Small presentational pieces                                          */
/* ------------------------------------------------------------------ */

function VariantIcon({ variant, size = 15 }: { variant: Variant; size?: number }) {
  switch (variant) {
    case "project":
      return <span className="mx-fglyph">ƒ</span>;
    case "external":
      return <Box size={size} />;
    case "builtin":
      return <Braces size={size} />;
    case "recursive":
      return <RefreshCw size={size} />;
    default:
      return <Circle size={size - 4} />;
  }
}

function MethodNode({ data }: NodeProps<MethodNodeType>) {
  return (
    <div
      className={`mx-node mx-node-${data.isRoot ? "root" : data.variant} ${
        data.selected ? "is-selected" : ""
      }`}
    >
      <Handle type="target" position={Position.Left} className="mx-handle" />

      <span className={`mx-node-icon ${data.isRoot ? "root" : data.variant}`}>
        {data.isRoot ? <span className="mx-fglyph">ƒ</span> : <VariantIcon variant={data.variant} />}
      </span>

      <span className="mx-node-text">
        <span className="mx-node-name">{data.name}()</span>
        {data.subtitle && <span className="mx-node-sub">{data.subtitle}</span>}
      </span>

      {data.awaited && <span className="mx-await">await</span>}
      {data.count > 1 && <span className="mx-count">×{data.count}</span>}

      {data.expandable && (
        <button
          type="button"
          className="mx-node-toggle nodrag nopan"
          aria-label={`${data.expanded ? "Collapse" : "Expand"} ${data.name}`}
          onClick={(event) => {
            event.stopPropagation();
            data.onToggle(data.id);
          }}
        >
          <ChevronDown size={15} className={data.expanded ? "" : "is-closed"} />
        </button>
      )}

      <Handle type="source" position={Position.Right} className="mx-handle" />
    </div>
  );
}

const nodeTypes = { mx: MethodNode };

function CallTreeRows({
  items,
  parentId,
  depth,
  expanded,
  selectedId,
  onSelect,
  onToggle
}: {
  items: CallItem[];
  parentId: string;
  depth: number;
  expanded: Set<string>;
  selectedId: string;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  return (
    <>
      {items.map((item, index) => {
        const id = `${parentId}/${index}`;
        const open = expanded.has(id);
        const hasKids = item.children.length > 0;

        return (
          <div key={id}>
            <div
              className={`mx-tree-row ${selectedId === id ? "is-selected" : ""}`}
              style={{ paddingLeft: 12 + depth * 24 }}
              onClick={() => onSelect(id)}
            >
              <button
                type="button"
                className="mx-tree-toggle"
                disabled={!hasKids}
                aria-label={`${open ? "Collapse" : "Expand"} ${item.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggle(id);
                }}
              >
                {hasKids ? open ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : <span className="mx-dot" />}
              </button>
              <span className={`mx-chip-icon ${item.variant}`}>
                <VariantIcon variant={item.variant} size={13} />
              </span>
              <span className="mx-tree-name">{item.name}()</span>
              {item.awaited && <span className="mx-await">await</span>}
              {item.count > 1 && <span className="mx-count">×{item.count}</span>}
              <span className="mx-tree-line">{item.line ? `Line ${item.line}` : ""}</span>
            </div>
            {open && hasKids && (
              <CallTreeRows
                items={item.children}
                parentId={id}
                depth={depth + 1}
                expanded={expanded}
                selectedId={selectedId}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function Legend() {
  const entries: { variant: Variant | "await"; title: string; sub: string }[] = [
    { variant: "project", title: "Project function", sub: "Function in your codebase" },
    { variant: "external", title: "External / library call", sub: "Third-party or browser API" },
    { variant: "builtin", title: "Built-in method", sub: "JS/TS built-in (e.g., find, endsWith)" },
    { variant: "recursive", title: "Recursive call", sub: "Calls itself (directly or indirectly)" },
    { variant: "await", title: "Await call", sub: "Asynchronous operation" }
  ];

  return (
    <div className="mx-legend">
      <h4>Legend</h4>
      {entries.map((entry) => (
        <div className="mx-legend-row" key={entry.title}>
          {entry.variant === "await" ? (
            <span className="mx-await mx-await-lg">await</span>
          ) : (
            <span className={`mx-chip-icon lg ${entry.variant}`}>
              <VariantIcon variant={entry.variant} size={17} />
            </span>
          )}
          <span>
            <strong>{entry.title}</strong>
            <small>{entry.sub}</small>
          </span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Main component                                                       */
/* ------------------------------------------------------------------ */

type MethodExplorerProps = {
  projectPath: string;
  apiUrl?: string;
  defaultSymbol?: string;
  defaultFilePath?: string;
};

function MethodExplorerInner({
  projectPath,
  apiUrl = "http://127.0.0.1:4174/api/explain-method",
  defaultSymbol = "generateGraph",
  defaultFilePath = "viewer/src/App.tsx"
}: MethodExplorerProps) {
  const flow = useReactFlow();
  const graphPanelRef = useRef<HTMLDivElement>(null);

  const [symbol, setSymbol] = useState(defaultSymbol);
  const [filePath, setFilePath] = useState(defaultFilePath);
  const [method, setMethod] = useState<MethodExplanation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set([ROOT_ID]));
  const [selectedId, setSelectedId] = useState(ROOT_ID);
  const [mode, setMode] = useState<"graph" | "tree">("graph");
  const [inspectorTab, setInspectorTab] = useState<"details" | "source" | "callers">("details");
  const [dataTab, setDataTab] = useState<"calls" | "branches" | "awaits" | "effects">("calls");
  const [copied, setCopied] = useState(false);

  async function explain() {
    setLoading(true);
    setError("");
    setWarnings([]);

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: projectPath.trim(),
          symbol: symbol.trim(),
          filePath: filePath.trim() || undefined,
          includeSource: true
        })
      });

      const result = (await response.json()) as MethodExplanation;

      if (!response.ok || !result.success) {
        throw new Error(result.error || `Request failed with status ${response.status}`);
      }

      setMethod(result);
      setWarnings(result.warnings ?? []);
      setExpanded(new Set([ROOT_ID]));
      setSelectedId(ROOT_ID);
      setInspectorTab("details");
      setDataTab("calls");
    } catch (err) {
      setMethod(null);
      setError(err instanceof Error ? err.message : "Unable to explain the selected method.");
    } finally {
      setLoading(false);
    }
  }

  const items = useMemo(() => {
    if (!method) return [] as CallItem[];
    const details = method.callDetails?.length
      ? method.callDetails
      : method.behavior.calls.map((name) => ({ name, category: "unknown" }));
    return aggregate(details);
  }, [method]);

  const toggle = useCallback((id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const flowData = useMemo(
    () => (method ? buildFlow(method, items, expanded, selectedId, toggle) : { nodes: [], edges: [] }),
    [method, items, expanded, selectedId, toggle]
  );

  const fitMethodGraph = useCallback(() => {
    if (!method || mode !== "graph") return;

    window.setTimeout(() => {
      const visibleNodeCount = flow.getNodes().length;
      const padding = visibleNodeCount > 12 ? 0.12 : 0.2;

      flow.fitView({
        padding,
        duration: 300,
        minZoom: visibleNodeCount > 20 ? 0.28 : 0.35,
        maxZoom: visibleNodeCount > 20 ? 0.95 : 1.15
      });
    }, 40);
  }, [flow, method, mode]);

  useEffect(() => {
    if (!method || mode !== "graph") return;
    fitMethodGraph();
  }, [method, expanded, mode, fitMethodGraph]);

  const selectedItem = selectedId === ROOT_ID ? null : findItem(items, selectedId);

  function copySignature() {
    if (!method) return;
    navigator.clipboard?.writeText(method.signature).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  }

  function toggleFullscreen() {
    const element = graphPanelRef.current;
    if (!element) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void element.requestFullscreen?.();
  }

  const callers = (method?.callers ?? []).map((caller) =>
    typeof caller === "string"
      ? { name: caller, filePath: "", line: 0 }
      : caller
  );

  const awaitedNames = items.filter((item) => item.awaited).map((item) => item.name);

  const stats = method
    ? [
        { icon: <span className="mx-fglyph big">ƒ</span>, value: method.kind, label: "Symbol type" },
        { icon: <Layers size={22} />, value: items.length, label: "Total calls" },
        { icon: <GitFork size={22} />, value: method.behavior.conditions, label: "Branches" },
        { icon: <Code size={22} />, value: method.behavior.awaits, label: "Awaits" },
        { icon: <RefreshCw size={22} />, value: method.behavior.loops, label: "Loops" },
        { icon: <Repeat size={22} />, value: method.recursive ? "Yes" : "No", label: "Recursive" }
      ]
    : [];

  return (
    <div className="mx">
      {/* Controls */}
      <div
        className="mx-controls"
        onKeyDown={(event) => {
          if (event.key === "Enter" && !loading && symbol.trim()) void explain();
        }}
      >
        <label>
          Method / function / component
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="generateGraph" />
        </label>
        <label>
          File path
          <input value={filePath} onChange={(e) => setFilePath(e.target.value)} placeholder="viewer/src/App.tsx" />
        </label>
        <button type="button" className="mx-primary" onClick={explain} disabled={loading || !symbol.trim()}>
          <Play size={15} />
          {loading ? "Inspecting…" : "Explain method"}
        </button>
      </div>

      {/* Status */}
      {method && (
        <div className="mx-status-row">
          <span className="mx-status-pill">
            <Check size={14} /> Loaded {method.symbol}
          </span>
          <code className="mx-status-signature">
            {method.async && !method.signature.startsWith("async") ? "async " : ""}
            {method.symbol}()
          </code>
        </div>
      )}

      {error && (
        <div className="mx-message error" role="alert">
          <strong>Error:</strong> {error}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="mx-message warning">
          <strong>Warnings ({warnings.length})</strong>
          <ul>
            {warnings.map((warning, index) => (
              <li key={`${warning}-${index}`}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Stat cards */}
      {method && (
        <div className="mx-stats">
          {stats.map((stat) => (
            <div className="mx-stat" key={stat.label}>
              <span className="mx-stat-icon">{stat.icon}</span>
              <span className="mx-stat-text">
                <strong>{stat.value}</strong>
                <small>{stat.label}</small>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Workspace */}
      <div className="mx-workspace">
        <div className="mx-graph-panel" ref={graphPanelRef}>
          <div className="mx-graph-toolbar">
            <div className="mx-seg">
              <button type="button" className={mode === "graph" ? "active" : ""} onClick={() => setMode("graph")}>
                <Network size={15} /> Call Graph
              </button>
              <button type="button" className={mode === "tree" ? "active" : ""} onClick={() => setMode("tree")}>
                <List size={15} /> Call Tree
              </button>
            </div>

            {mode === "graph" && (
              <div className="mx-zoom">
                <button type="button" className="with-label" onClick={fitMethodGraph}>
                  <Focus size={15} /> Fit
                </button>
                <button type="button" aria-label="Zoom out" onClick={() => flow.zoomOut({ duration: 150 })}>
                  <Minus size={15} />
                </button>
                <button type="button" aria-label="Zoom in" onClick={() => flow.zoomIn({ duration: 150 })}>
                  <Plus size={15} />
                </button>
                <button type="button" aria-label="Toggle fullscreen" onClick={toggleFullscreen}>
                  <Maximize2 size={15} />
                </button>
              </div>
            )}
          </div>

          <div className="mx-canvas">
            {!method ? (
              <div className="mx-empty">
                <span className="mx-fglyph huge">ƒ</span>
                <h3>No method loaded</h3>
                <p>
                  Enter a function, component or class method, then choose <strong>Explain method</strong> to see what it calls.
                </p>
              </div>
            ) : mode === "graph" ? (
              <>
                <ReactFlow
                  nodes={flowData.nodes}
                  edges={flowData.edges}
                  nodeTypes={nodeTypes}
                  onNodeClick={(_, node) => setSelectedId(node.id)}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  fitView
                  fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
                  minZoom={0.2}
                  maxZoom={1.6}
                  colorMode="dark"
                  proOptions={{ hideAttribution: true }}
                >
                  <Background gap={22} size={1} color="#26364d" />
                </ReactFlow>
                <Legend />
              </>
            ) : (
              <div className="mx-tree">
                <div
                  className={`mx-tree-row root ${selectedId === ROOT_ID ? "is-selected" : ""}`}
                  onClick={() => setSelectedId(ROOT_ID)}
                >
                  <button
                    type="button"
                    className="mx-tree-toggle"
                    disabled={!items.length}
                    aria-label="Toggle root"
                    onClick={(event) => {
                      event.stopPropagation();
                      toggle(ROOT_ID);
                    }}
                  >
                    {items.length ? expanded.has(ROOT_ID) ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : <span className="mx-dot" />}
                  </button>
                  <span className="mx-chip-icon root"><span className="mx-fglyph">ƒ</span></span>
                  <span className="mx-tree-name">{method.symbol}()</span>
                  <span className="mx-tree-line">{method.async ? "async" : method.kind}</span>
                </div>
                {expanded.has(ROOT_ID) && (
                  <CallTreeRows
                    items={items}
                    parentId={ROOT_ID}
                    depth={1}
                    expanded={expanded}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    onToggle={toggle}
                  />
                )}
              </div>
            )}
          </div>
        </div>

        {/* Inspector */}
        <aside className="mx-inspector">
          <div className="mx-inspector-tabs">
            <button type="button" className={inspectorTab === "details" ? "active" : ""} onClick={() => setInspectorTab("details")}>
              <Info size={15} /> Method details
            </button>
            <button type="button" className={inspectorTab === "source" ? "active" : ""} onClick={() => setInspectorTab("source")}>
              <Code size={15} /> Source
            </button>
            <button type="button" className={inspectorTab === "callers" ? "active" : ""} onClick={() => setInspectorTab("callers")}>
              <Users size={15} /> Callers ({callers.length})
            </button>
          </div>

          <div className="mx-inspector-body">
            {!method && (
              <div className="mx-empty small">
                <h3>Method details</h3>
                <p>Load a method to see its location, signature and behavior.</p>
              </div>
            )}

            {method && inspectorTab === "details" && (
              <>
                <div className="mx-hero">
                  <span className="mx-hero-icon">
                    {selectedItem ? <VariantIcon variant={selectedItem.variant} size={20} /> : <span className="mx-fglyph big">ƒ</span>}
                  </span>
                  <h3>{selectedItem ? selectedItem.name : method.symbol}()</h3>
                  <span className={`mx-pill ${selectedItem ? selectedItem.variant : "project"}`}>
                    {selectedItem ? VARIANT_LABEL[selectedItem.variant] : method.kind}
                  </span>
                </div>

                {selectedItem ? (
                  <>
                    <div className="mx-facts">
                      <div>
                        <span>Called from</span>
                        <strong><FileText size={13} /> {method.filePath}</strong>
                      </div>
                      <div>
                        <span>First line</span>
                        <strong><Code size={13} /> {selectedItem.line || "—"}</strong>
                      </div>
                      <div>
                        <span>Times called</span>
                        <strong>{selectedItem.count}</strong>
                      </div>
                    </div>
                    <section className="mx-section">
                      <h4>Description</h4>
                      <p>{selectedItem.description}</p>
                    </section>
                    <button type="button" className="mx-link-button" onClick={() => setSelectedId(ROOT_ID)}>
                      ← Back to {method.symbol}()
                    </button>
                  </>
                ) : (
                  <>
                    <div className="mx-facts">
                      <div>
                        <span>Location</span>
                        <strong className="link"><FileText size={13} /> {method.filePath}</strong>
                      </div>
                      <div>
                        <span>Lines</span>
                        <strong><Code size={13} /> {method.startLine} – {method.endLine}</strong>
                      </div>
                      <div>
                        <span>Exported</span>
                        <strong>{method.exported ? <Eye size={13} /> : <EyeOff size={13} />} {method.exported ? "Yes" : "No"}</strong>
                      </div>
                    </div>

                    <section className="mx-section">
                      <h4>Signature</h4>
                      <div className="mx-signature">
                        <code>{method.signature}</code>
                        <button type="button" onClick={copySignature} aria-label="Copy signature">
                          {copied ? <Check size={15} /> : <Copy size={15} />}
                        </button>
                      </div>
                    </section>

                    <section className="mx-section">
                      <h4>Summary</h4>
                      <p>{method.documentation || method.summary}</p>
                    </section>

                    <section className="mx-section">
                      <h4>Behavior</h4>
                      <ul className="mx-bullets">
                        <li>Calls {plural(items.length, "function")}/methods</li>
                        <li>
                          {method.behavior.conditions
                            ? `Contains ${plural(method.behavior.conditions, "conditional branch")} (if/else, ternary, switch)`
                            : "No conditional branches"}
                        </li>
                        <li>
                          {method.behavior.awaits
                            ? `Uses ${plural(method.behavior.awaits, "await operation")}${awaitedNames.length ? ` (${awaitedNames.join(", ")})` : ""}`
                            : "No await operations"}
                        </li>
                        <li>{method.behavior.loops ? `Contains ${plural(method.behavior.loops, "loop")}` : "No loops"}</li>
                        <li>{method.recursive ? "Recursive" : "Not recursive"}</li>
                      </ul>
                    </section>
                  </>
                )}
              </>
            )}

            {method && inspectorTab === "source" && (
              <pre className="mx-source">
                <code>
                  {(method.source ?? "Source was not returned.").split("\n").map((line, index) => (
                    <div className="mx-source-line" key={index}>
                      <span className="mx-ln">{method.source ? method.startLine + index : ""}</span>
                      <span>{line || " "}</span>
                    </div>
                  ))}
                </code>
              </pre>
            )}

            {method && inspectorTab === "callers" && (
              <section className="mx-section flush">
                {callers.length ? (
                  <ul className="mx-callers">
                    {callers.map((caller, index) => (
                      <li key={`${caller.name}-${caller.line}-${index}`}>
                        <strong>{caller.name}()</strong>
                        {caller.filePath && (
                          <small>
                            {caller.filePath}:{caller.line}
                          </small>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No callers were detected.</p>
                )}
              </section>
            )}
          </div>
        </aside>
      </div>

      {/* Data tabs */}
      {method && (
        <div className="mx-data">
          <div className="mx-data-tabs">
            <button type="button" className={dataTab === "calls" ? "active" : ""} onClick={() => setDataTab("calls")}>
              <Phone size={15} /> Calls ({items.length})
            </button>
            <button type="button" className={dataTab === "branches" ? "active" : ""} onClick={() => setDataTab("branches")}>
              <GitFork size={15} /> Branches ({method.behavior.conditions})
            </button>
            <button type="button" className={dataTab === "awaits" ? "active" : ""} onClick={() => setDataTab("awaits")}>
              <Code size={15} /> Awaits ({method.behavior.awaits})
            </button>
            <button type="button" className={dataTab === "effects" ? "active" : ""} onClick={() => setDataTab("effects")}>
              <Zap size={15} /> Effects ({method.behavior.effects.length})
            </button>
          </div>

          <div className="mx-table-wrap">
            {dataTab === "calls" && (
              <table className="mx-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Called method</th>
                    <th>Category</th>
                    <th>Line</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, index) => (
                    <tr
                      key={`${item.name}-${index}`}
                      className={selectedId === `${ROOT_ID}/${index}` ? "is-selected" : ""}
                      onClick={() => {
                        setSelectedId(`${ROOT_ID}/${index}`);
                        setInspectorTab("details");
                      }}
                    >
                      <td>{index + 1}</td>
                      <td><strong>{item.name}</strong>{item.count > 1 && <em className="mx-times"> ×{item.count}</em>}</td>
                      <td><span className={`mx-pill ${item.variant}`}>{VARIANT_LABEL[item.variant]}</span></td>
                      <td>{item.line || "—"}</td>
                      <td>{item.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {dataTab === "branches" &&
              (method.behavior.branchDetails?.length ? (
                <table className="mx-table">
                  <thead>
                    <tr><th>#</th><th>Type</th><th>Line</th><th>Condition</th></tr>
                  </thead>
                  <tbody>
                    {method.behavior.branchDetails.map((branch, index) => (
                      <tr key={`${branch.line}-${index}`}>
                        <td>{index + 1}</td>
                        <td><span className="mx-pill call">{branch.kind}</span></td>
                        <td>{branch.line}</td>
                        <td><code>{branch.text}</code></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="mx-table-empty">
                  {method.behavior.conditions
                    ? `${plural(method.behavior.conditions, "conditional branch")} detected.`
                    : "No conditional branches detected."}
                </p>
              ))}

            {dataTab === "awaits" &&
              (method.behavior.awaitDetails?.length ? (
                <table className="mx-table">
                  <thead>
                    <tr><th>#</th><th>Line</th><th>Awaited expression</th></tr>
                  </thead>
                  <tbody>
                    {method.behavior.awaitDetails.map((item, index) => (
                      <tr key={`${item.line}-${index}`}>
                        <td>{index + 1}</td>
                        <td>{item.line}</td>
                        <td><code>{item.text}</code></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="mx-table-empty">No await operations detected.</p>
              ))}

            {dataTab === "effects" &&
              (method.behavior.effects.length ? (
                <ul className="mx-effects">
                  {method.behavior.effects.map((effect) => (
                    <li key={effect}><Zap size={14} /> {effect}</li>
                  ))}
                </ul>
              ) : (
                <p className="mx-table-empty">No React effects were detected for this method.</p>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function MethodExplorer(props: MethodExplorerProps) {
  return (
    <ReactFlowProvider>
      <MethodExplorerInner {...props} />
    </ReactFlowProvider>
  );
}