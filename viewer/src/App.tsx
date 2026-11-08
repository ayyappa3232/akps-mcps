import { useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  Position,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { List, Network } from "lucide-react";
import "./styles.css";
import MethodExplorer from "./modules/methodExplorer/MethodExplorer";
import AnalyzeChangeImpact from "./modules/changeImpact/AnalyzeChangeImpact";
import CodeQualityAnalyzer from "./modules/codeQuality/CodeQualityAnalyzer";
import DeadCodeAnalyzer from "./modules/deadCode/DeadCodeAnalyzer";
import AnalyzeApiEndpoints from "./modules/apiExplorer/AnalyzeApiEndpoints";
import AnalyzeSecurity from "./modules/security/AnalyzeSecurity";
import AnalyzeTestCoverage from "./modules/testCoverage/AnalyzeTestCoverage";


const defaultProjectPath =
  "/Users/ayyappakumar/Desktop/Ayyappa/Projects/React/My_Projects/PORTFOLIO_PROJECTS/learning-coding-hub";

const API_URL = "http://127.0.0.1:4174/api/dependencies";

type GraphData = {
  nodes: {
    id: string;
    label: string;
    filePath: string;
  }[];
  edges: {
    from: string;
    to: string;
  }[];
};

type DependencyNode = {
  file: string;
  absolutePath: string;
  depth: number;
  dependencies: DependencyNode[];
  isShared?: boolean;
  isCircular?: boolean;
  referenceTo?: string;
};

type DependencyResponse = {
  success: boolean;
  projectPath: string;
  entryFile: string;
  maxDepth: number;
  maxNodes: number;
  uniqueFileCount: number;
  dependencyRelationshipCount: number;
  sharedDependencyCount: number;
  circularDependencyCount: number;
  dependencyTree: DependencyNode;
  warnings: string[];
  error?: string;
  graph: GraphData;
};

type DependencyStats = {
  uniqueFileCount: number;
  dependencyRelationshipCount: number;
  sharedDependencyCount: number;
  circularDependencyCount: number;
};

function countDependencies(node: DependencyNode): number {
  return node.dependencies.reduce(
    (total, dependency) => total + 1 + countDependencies(dependency),
    0
  );
}

function getShortLabel(filePath: string): string {
  const parts = filePath.split(/[\\\\/]/).filter(Boolean);
  if (parts.length <= 2) return filePath;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function createProgressiveFlowLayout(
  graph: GraphData,
  entryFile: string,
  expandedIds: Set<string>
) {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, number>();

  graph.nodes.forEach((node) => {
    outgoing.set(node.id, []);
    incoming.set(node.id, 0);
  });

  graph.edges.forEach((edge) => {
    outgoing.get(edge.from)?.push(edge.to);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  });

  const root =
    graph.nodes.find(
      (node) =>
        node.filePath === entryFile ||
        node.filePath.endsWith(`/${entryFile}`) ||
        node.label === entryFile
    ) ?? graph.nodes[0];

  if (!root) return { nodes: [] as Node[], edges: [] as Edge[] };

  // Only reveal the root and children of nodes the user has expanded.
  const visibleIds = new Set<string>([root.id]);
  const depths = new Map<string, number>([[root.id, 0]]);
  const queue = [root.id];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (!expandedIds.has(current)) continue;

    for (const childId of outgoing.get(current) ?? []) {
      if (!nodeById.has(childId)) continue;
      visibleIds.add(childId);
      if (!depths.has(childId)) {
        depths.set(childId, (depths.get(current) ?? 0) + 1);
        queue.push(childId);
      }
    }
  }

  const levels = new Map<number, string[]>();
  visibleIds.forEach((id) => {
    const depth = depths.get(id) ?? 0;
    const level = levels.get(depth) ?? [];
    level.push(id);
    levels.set(depth, level);
  });

  const nodes: Node[] = [...visibleIds].map((id) => {
    const item = nodeById.get(id)!;
    const depth = depths.get(id) ?? 0;
    const row = (levels.get(depth) ?? []).indexOf(id);
    const isShared = (incoming.get(id) ?? 0) > 1;
    const hasChildren = (outgoing.get(id) ?? []).length > 0;
    const isExpanded = expandedIds.has(id);
    const shortLabel = getShortLabel(item.filePath);

    return {
      id,
      position: { x: depth * 360, y: row * 112 },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        label: `${shortLabel}${isShared ? "  ·  SHARED" : ""}${hasChildren ? (isExpanded ? "  ·  COLLAPSE" : "  ·  + EXPAND") : ""
          }`
      },
      style: {
        width: 300,
        minHeight: 58,
        padding: "12px 14px",
        borderRadius: 12,
        border: isShared ? "2px solid #3b82f6" : "1px solid #64748b",
        background: isShared ? "#172f50" : "#1e293b",
        color: "#e5e7eb",
        fontSize: 13,
        fontWeight: 600,
        lineHeight: 1.5,
        whiteSpace: "normal",
        overflowWrap: "anywhere"
      }
    };
  });

  const visibleEdges: Edge[] = graph.edges
    .filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to))
    .map((edge, index) => {
      const isBackEdge = (depths.get(edge.to) ?? 0) <= (depths.get(edge.from) ?? 0);
      return {
        id: `edge-${edge.from}-${edge.to}-${index}`,
        source: edge.from,
        target: edge.to,
        type: "smoothstep",
        animated: false,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isBackEdge ? "#f87171" : "#94a3b8"
        },
        style: {
          stroke: isBackEdge ? "#ef4444" : "#94a3b8",
          strokeWidth: isBackEdge ? 2 : 1.5,
          strokeDasharray: isBackEdge ? "6 4" : undefined
        }
      };
    });

  return { nodes, edges: visibleEdges };
}

type DeveloperTool = {
  value: "method" | "impact" | "quality" | "deadCode" | "apiExplorer" | "security" | "testCoverage";
  label: string;
  icon: string;
};

const developerTools: DeveloperTool[] = [
  { value: "method", label: "Method Explorer", icon: "ƒ" },
  { value: "impact", label: "Change Impact", icon: "↯" },
  { value: "quality", label: "Code Quality", icon: "◈" },
  { value: "deadCode", label: "Dead Code", icon: "◌" },
  { value: "apiExplorer", label: "API Explorer", icon: "⇄" },
  { value: "security", label: "Security", icon: "🔒" },
  { value: "testCoverage", label: "Test Coverage", icon: "🧪" }
];

function DeveloperToolsSelect({
  value,
  onChange
}: {
  value: DeveloperTool["value"] | null;
  onChange: (value: DeveloperTool["value"]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const selectedTool = developerTools.find((tool) => tool.value === value);
  const filteredTools = developerTools.filter((tool) =>
    tool.label.toLowerCase().includes(search.trim().toLowerCase())
  );

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!(event.target instanceof Element) || !rootRef.current?.contains(event.target)) {
        setOpen(false);
        setSearch("");
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        setSearch("");
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (open) {
      window.requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [open]);

  function chooseTool(tool: DeveloperTool) {
    onChange(tool.value);
    setOpen(false);
    setSearch("");
  }

  return (
    <div
      className={`developer-tools-select ${open ? "is-open" : ""}`}
      ref={rootRef}
    >
      <button
        type="button"
        className={`developer-tools-trigger ${selectedTool ? "has-selection" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="developer-tools-trigger-content">
          <span className="developer-tools-trigger-icon">
            {selectedTool?.icon ?? "⌘"}
          </span>
          <span>{selectedTool?.label ?? "Developer Tools"}</span>
        </span>
        <span className="developer-tools-chevron" aria-hidden="true" />
      </button>

      {open && (
        <div
          className="developer-tools-menu"
          role="listbox"
          aria-label="Developer tools"
        >
          <div className="developer-tools-search">
            <span aria-hidden="true">⌕</span>
            <input
              ref={searchInputRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search developer tools..."
              aria-label="Search developer tools"
            />
          </div>

          <div className="developer-tools-options">
            {filteredTools.length > 0 ? (
              filteredTools.map((tool) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={tool.value === value}
                  key={tool.value}
                  className={`developer-tools-option ${tool.value === value ? "is-selected" : ""
                    }`}
                  onClick={() => chooseTool(tool)}
                >
                  <span className="developer-tools-option-icon">
                    {tool.icon}
                  </span>
                  <span className="developer-tools-option-label">
                    {tool.label}
                  </span>
                  {tool.value === value && (
                    <span className="developer-tools-check" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </button>
              ))
            ) : (
              <div className="developer-tools-empty">
                No developer tools found.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type ThemeSelectOption = {
  value: number;
  label: string;
};

function ThemeSelect({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: number;
  options: ThemeSelectOption[];
  onChange: (value: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(
    Math.max(0, options.findIndex((option) => option.value === value))
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedOption = options.find((option) => option.value === value);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!(event.target instanceof Element) || !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));
  }, [value]);

  function choose(option: ThemeSelectOption) {
    onChange(option.value);
    setActiveIndex(options.findIndex((item) => item.value === option.value));
    setOpen(false);
  }

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) =>
        event.key === "ArrowDown"
          ? Math.min(current + 1, options.length - 1)
          : Math.max(current - 1, 0)
      );
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen((current) => !current);
    }
  }

  return (
    <div className="toolbar-field">
      <span className="toolbar-field-label">{label}</span>
      <div className={`theme-select ${open ? "is-open" : ""}`} ref={rootRef}>
        <button
          type="button"
          className="theme-select-trigger"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          onKeyDown={handleTriggerKeyDown}
        >
          <span>{selectedOption?.label ?? value}</span>
          <span className="theme-select-chevron" aria-hidden="true" />
        </button>

        {open && (
          <div className="theme-select-menu" role="listbox" aria-label={label}>
            {options.map((option, index) => (
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                key={option.value}
                className={`theme-select-option ${option.value === value ? "is-selected" : ""
                  } ${index === activeIndex ? "is-active" : ""}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(option)}
              >
                <span>{option.label}</span>
                {option.value === value && (
                  <span className="theme-select-check" aria-hidden="true">✓</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [projectPath, setProjectPath] = useState(defaultProjectPath);
  const [entryFile, setEntryFile] = useState("src/App.tsx");
  const [search, setSearch] = useState("");
  const [maxDepth, setMaxDepth] = useState(3);
  const [maxNodes, setMaxNodes] = useState(500);

  const [tree, setTree] = useState<DependencyNode | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [stats, setStats] = useState<DependencyStats | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeView, setActiveView] =
    useState<
      "tree" |
      "graph" |
      "method" |
      "impact" |
      "quality" |
      "deadCode" |
      "apiExplorer" |
      "security" |
      "testCoverage"
    >("tree");
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [, setExpandedGraphNodes] = useState<Set<string>>(new Set());
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string | null>(null);

  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<Node>([]);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState<Edge>([]);

  async function generateGraph() {
    setLoading(true);
    setError("");
    setWarnings([]);
    setTree(null);
    setStats(null);
    setExpanded(new Set());
    setStatus("Scanning dependencies...");

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          projectPath: projectPath.trim(),
          filePath: entryFile.trim(),
          maxDepth,
          maxNodes
        })
      });

      const result = (await response.json()) as DependencyResponse;

      if (!response.ok || !result.success) {
        throw new Error(result.error || `Request failed with status ${response.status}`);
      }

      if (!result.dependencyTree) {
        throw new Error("The API did not return a dependency tree.");
      }

      setTree(result.dependencyTree);

      if (result.graph) {
        setGraphData(result.graph);
        const root =
          result.graph.nodes.find(
            (node) =>
              node.filePath === result.entryFile ||
              node.filePath.endsWith(`/${result.entryFile}`)
          ) ?? result.graph.nodes[0];
        const initialExpanded = new Set<string>(root ? [root.id] : []);
        setExpandedGraphNodes(initialExpanded);
        setSelectedGraphNodeId(root?.id ?? null);
        const layout = createProgressiveFlowLayout(
          result.graph,
          result.entryFile,
          initialExpanded
        );
        setFlowNodes(layout.nodes);
        setFlowEdges(layout.edges);
      }

      setWarnings(result.warnings ?? []);

      setStats({
        uniqueFileCount: result.uniqueFileCount ?? 0,
        dependencyRelationshipCount: result.dependencyRelationshipCount ?? 0,
        sharedDependencyCount: result.sharedDependencyCount ?? 0,
        circularDependencyCount: result.circularDependencyCount ?? 0
      });

      setStatus(`Loaded ${countDependencies(result.dependencyTree) + 1} tree entries`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to generate the dependency tree.");
      setStatus("Generation failed");
    } finally {
      setLoading(false);
    }
  }

  function handleGraphNodeClick(nodeId: string) {
    if (!graphData) return;
    setSelectedGraphNodeId(nodeId);
    setExpandedGraphNodes((previous) => {
      const next = new Set(previous);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      const layout = createProgressiveFlowLayout(graphData, entryFile, next);
      setFlowNodes(layout.nodes);
      setFlowEdges(layout.edges);
      return next;
    });
  }

  function resetGraphView() {
    if (!graphData) return;
    const root =
      graphData.nodes.find(
        (node) => node.filePath === entryFile || node.filePath.endsWith(`/${entryFile}`)
      ) ?? graphData.nodes[0];
    const next = new Set<string>(root ? [root.id] : []);
    setExpandedGraphNodes(next);
    setSelectedGraphNodeId(root?.id ?? null);
    const layout = createProgressiveFlowLayout(graphData, entryFile, next);
    setFlowNodes(layout.nodes);
    setFlowEdges(layout.edges);
  }

  function toggleNode(file: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  }

  function expandAll() {
    if (!tree) return;
    const allExpandable = new Set<string>();

    function visit(node: DependencyNode) {
      if (node.dependencies.length > 0) allExpandable.add(node.file);
      node.dependencies.forEach(visit);
    }

    visit(tree);
    setExpanded(allExpandable);
  }

  function collapseAll() {
    setExpanded(new Set());
  }

  const selectedGraphNode = useMemo(() => {
    if (!graphData || !selectedGraphNodeId) return null;
    const node = graphData.nodes.find((item) => item.id === selectedGraphNodeId);
    if (!node) return null;

    const outgoing = graphData.edges
      .filter((edge) => edge.from === node.id)
      .map((edge) => graphData.nodes.find((item) => item.id === edge.to))
      .filter((item): item is GraphData["nodes"][number] => Boolean(item));

    const incoming = graphData.edges
      .filter((edge) => edge.to === node.id)
      .map((edge) => graphData.nodes.find((item) => item.id === edge.from))
      .filter((item): item is GraphData["nodes"][number] => Boolean(item));

    // A node participates in a cycle when one of its dependencies can reach it again.
    const adjacency = new Map<string, string[]>();
    graphData.nodes.forEach((item) => adjacency.set(item.id, []));
    graphData.edges.forEach((edge) => adjacency.get(edge.from)?.push(edge.to));
    const visited = new Set<string>();
    const stack = [...(adjacency.get(node.id) ?? [])];
    let isCircular = false;
    while (stack.length) {
      const current = stack.pop()!;
      if (current === node.id) {
        isCircular = true;
        break;
      }
      if (visited.has(current)) continue;
      visited.add(current);
      stack.push(...(adjacency.get(current) ?? []));
    }

    return {
      ...node,
      dependencies: outgoing,
      importedBy: incoming,
      isShared: incoming.length > 1,
      isCircular
    };
  }, [graphData, selectedGraphNodeId]);

  const normalizedSearch = search.trim().toLowerCase();

  const matchingFiles = useMemo(() => {
    const matches = new Set<string>();
    if (!tree || !normalizedSearch) return matches;

    function visit(node: DependencyNode) {
      if (node.file.toLowerCase().includes(normalizedSearch)) matches.add(node.file);
      node.dependencies.forEach(visit);
    }

    visit(tree);
    return matches;
  }, [tree, normalizedSearch]);

  function renderNode(
    node: DependencyNode,
    level: number,
    ancestors: string[] = []
  ): React.ReactNode {
    const hasChildren = node.dependencies.length > 0;
    const isExpanded = expanded.has(node.file);
    const isMatch = normalizedSearch.length > 0 && matchingFiles.has(node.file);

    const visibleDependencies = normalizedSearch
      ? node.dependencies.filter(
        (dependency) =>
          matchingFiles.has(dependency.file) ||
          dependency.dependencies.some((child) => matchingFiles.has(child.file))
      )
      : node.dependencies;

    const showChildren = normalizedSearch.length > 0 || isExpanded;

    return (
      <div className="tree-branch" key={`${ancestors.join("/")}/${node.file}`}>
        <div
          className={`tree-row ${isMatch ? "tree-row-match" : ""}`}
          style={{ paddingLeft: `${level * 24 + 12}px` }}
        >
          <button
            type="button"
            className={`tree-toggle ${hasChildren ? "" : "tree-toggle-empty"}`}
            onClick={() => hasChildren && toggleNode(node.file)}
            disabled={!hasChildren}
            aria-label={
              hasChildren
                ? `${isExpanded ? "Collapse" : "Expand"} ${node.file}`
                : `${node.file} has no dependencies`
            }
          >
            {hasChildren ? (isExpanded ? "▼" : "▶") : "•"}
          </button>

          <span className="tree-file-icon">{hasChildren ? "📁" : "📄"}</span>

          <span className="tree-file-name" title={node.file}>
            {node.file}
          </span>

          {hasChildren && <span className="tree-count">{node.dependencies.length}</span>}

          {node.isShared && (
            <span
              className="dependency-badge shared-badge"
              title="This file is imported by multiple files."
            >
              SHARED
            </span>
          )}

          {node.isCircular && (
            <span
              className="dependency-badge circular-badge"
              title={`Circular reference to ${node.referenceTo ?? node.file}`}
            >
              CIRCULAR
            </span>
          )}
        </div>

        {showChildren &&
          visibleDependencies.map((dependency) =>
            renderNode(dependency, level + 1, [...ancestors, node.file])
          )}
      </div>
    );
  }

  return (
    <main className="app">
      <header className="header">
        <div>
          <h1>Dependency Explorer</h1>
          <p>Explore project dependencies as an expandable tree.</p>
        </div>

        <span className="status">{status}</span>
      </header>

      <section className="toolbar">
        <label>
          Project absolute path
          <input
            value={projectPath}
            onChange={(event) => setProjectPath(event.target.value)}
            placeholder="/absolute/path/to/project"
          />
        </label>

        <label>
          Entry file
          <input
            value={entryFile}
            onChange={(event) => setEntryFile(event.target.value)}
            placeholder="src/App.tsx"
          />
        </label>

        <label>
          Search files
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by filename"
          />
        </label>

        <ThemeSelect
          label="Maximum depth"
          value={maxDepth}
          onChange={setMaxDepth}
          options={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((depth) => ({
            value: depth,
            label: String(depth)
          }))}
        />

        <ThemeSelect
          label="Maximum nodes"
          value={maxNodes}
          onChange={setMaxNodes}
          options={[150, 300, 500, 1000].map((limit) => ({
            value: limit,
            label: limit.toLocaleString()
          }))}
        />

        <button type="button" onClick={generateGraph} disabled={loading}>
          {loading ? "Scanning..." : "Generate tree"}
        </button>
      </section>

      {error && (
        <section className="message error" role="alert">
          <strong>Error:</strong> {error}
        </section>
      )}

      {warnings.length > 0 && (
        <section className="message warning">
          <strong>Warnings ({warnings.length})</strong>
          <ul>
            {warnings.map((warning, index) => (
              <li key={`${warning}-${index}`}>{warning}</li>
            ))}
          </ul>
        </section>
      )}

      {stats && (
        <section className="dependency-stats">
          <div className="stat-card">
            <strong>{stats.uniqueFileCount}</strong>
            <span>Unique files</span>
          </div>

          <div className="stat-card">
            <strong>{stats.dependencyRelationshipCount}</strong>
            <span>Relationships</span>
          </div>

          <div className="stat-card shared-stat">
            <strong>{stats.sharedDependencyCount}</strong>
            <span>Shared dependencies</span>
          </div>

          <div className="stat-card circular-stat">
            <strong>{stats.circularDependencyCount}</strong>
            <span>Circular references</span>
          </div>
        </section>
      )}

      <section className="graph-panel">
        <div className="view-tabs">
          <button
            type="button"
            className={activeView === "tree" ? "active" : ""}
            onClick={() => setActiveView("tree")}
          >
            <List size={15} /> Tree View
          </button>

          <button
            type="button"
            className={activeView === "graph" ? "active" : ""}
            onClick={() => setActiveView("graph")}
            disabled={!graphData}
          >
            <Network size={15} /> Graph View
          </button>

          <DeveloperToolsSelect
            value={
              activeView === "method" ||
                activeView === "impact" ||
                activeView === "quality" ||
                activeView === "deadCode" ||
                activeView === "apiExplorer" ||
                activeView === "security" ||
                activeView === "testCoverage"
                ? activeView
                : null
            }
            onChange={setActiveView}
          />
        </div>

        <div className="graph-heading">
          <div>
            <h2>
              {activeView === "tree"
                ? "Dependency tree"
                : activeView === "graph"
                  ? "Dependency graph"
                  : activeView === "method"
                    ? "Method Explorer"
                    : activeView === "impact"
                      ? "Change Impact Analyzer"
                      : activeView === "quality"
                        ? "Code Quality Analyzer"
                        : activeView === "deadCode"
                          ? "Dead Code Analyzer"
                          : "API Explorer"}
            </h2>

            <p>
              {activeView === "tree"
                ? "Expand a folder or file to explore its dependencies."
                : activeView === "graph"
                  ? "Click a node to reveal or hide its direct dependencies. Full paths are available on hover."
                  : activeView === "method"
                    ? "Inspect a function, component, or method as an interactive call tree and graph."
                    : activeView === "impact"
                      ? "Analyze direct consumers, downstream impact, risk, and affected symbols before changing code."
                      : activeView === "quality"
                        ? "Assess complexity, maintainability, React activity, and structural hotspots before you refactor."
                        : activeView === "deadCode"
                          ? "Find potentially unused declarations and review them before cleanup or removal."
                          : "Explore HTTP and Firebase backend communication used by your application."}
            </p>
          </div>

          {activeView !== "method" && (
            <span>{tree ? `${countDependencies(tree) + 1} entries` : "No tree loaded"}</span>
          )}
        </div>

        {activeView !== "method" && (
          <div className="tree-actions">
            <button type="button" onClick={expandAll} disabled={!tree}>
              Expand all
            </button>

            <button type="button" onClick={collapseAll} disabled={!tree}>
              Collapse all
            </button>

            {normalizedSearch && <span>{matchingFiles.size} matching file(s)</span>}
          </div>
        )}

        {stats && activeView !== "method" && (
          <div className="dependency-legend">
            <span>
              <span className="dependency-badge shared-badge">SHARED</span>
              Imported by multiple files
            </span>

            <span>
              <span className="dependency-badge circular-badge">CIRCULAR</span>
              Points back to an ancestor
            </span>
          </div>
        )}

        {activeView === "tree" && (
          <div className="dependency-tree">
            {!tree && !loading && (
              <p className="tree-empty">Enter your project details and click Generate tree.</p>
            )}

            {loading && <p className="tree-empty">Scanning project dependencies...</p>}

            {tree && renderNode(tree, 0)}
          </div>
        )}

        {activeView === "graph" && (
          <div className="graph-workspace">
            <div className="dependency-flow graph-view-progressive">
              {graphData ? (
                <>
                  <div className="graph-toolbar">
                    <span className="graph-hint">
                      Showing {flowNodes.length} of {graphData.nodes.length} files. Select a node to
                      inspect it; click again to expand or collapse its dependencies.
                    </span>

                    <button type="button" onClick={resetGraphView}>
                      Reset graph
                    </button>
                  </div>

                  <ReactFlow
                    style={{ flex: 1, minHeight: 0 }}
                    nodes={flowNodes}
                    edges={flowEdges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onNodeClick={(_, node) => handleGraphNodeClick(node.id)}
                    fitView
                    fitViewOptions={{ padding: 0.25, minZoom: 0.35, maxZoom: 1 }}
                    minZoom={0.15}
                    maxZoom={1.5}
                    nodesDraggable
                    nodesConnectable={false}
                    elementsSelectable
                  >
                    <Background gap={22} size={1} />
                    <Controls />
                    <MiniMap
                      pannable
                      zoomable
                      nodeColor={(node) =>
                        String(node.data.label).includes("SHARED") ? "#3b82f6" : "#64748b"
                      }
                    />
                  </ReactFlow>
                </>
              ) : (
                <p className="tree-empty">Generate a dependency tree first.</p>
              )}
            </div>

            <aside className="file-details-panel">
              {selectedGraphNode ? (
                <>
                  <div className="file-details-header">
                    <h3 style={{ margin: 0, fontSize: 18 }}>File details</h3>

                    <button
                      className="file-details-close"
                      type="button"
                      onClick={() => setSelectedGraphNodeId(null)}
                      aria-label="Close file details"
                    >
                      ×
                    </button>
                  </div>

                  <h4 className="file-details-title">
                    {selectedGraphNode.label || getShortLabel(selectedGraphNode.filePath)}
                  </h4>

                  <div className="file-details-path">
                    <strong>Full path</strong>
                    <br />
                    {selectedGraphNode.filePath}
                  </div>

                  <div className="file-details-meta">
                    <span className="tree-count">{selectedGraphNode.dependencies.length} imports</span>
                    <span className="tree-count">{selectedGraphNode.importedBy.length} imported by</span>
                    {selectedGraphNode.isShared && (
                      <span className="dependency-badge shared-badge">SHARED</span>
                    )}
                    {selectedGraphNode.isCircular && (
                      <span className="dependency-badge circular-badge">CIRCULAR</span>
                    )}
                  </div>

                  <section className="file-details-section">
                    <h4>Imports ({selectedGraphNode.dependencies.length})</h4>

                    {selectedGraphNode.dependencies.length ? (
                      <ul className="file-details-list">
                        {selectedGraphNode.dependencies.map((item) => (
                          <li key={item.id}>
                            <button
                              type="button"
                              onClick={() => setSelectedGraphNodeId(item.id)}
                              title={item.filePath}
                            >
                              {getShortLabel(item.filePath)}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="file-details-empty">No outgoing dependencies found.</p>
                    )}
                  </section>

                  <section className="file-details-section">
                    <h4>Imported by ({selectedGraphNode.importedBy.length})</h4>

                    {selectedGraphNode.importedBy.length ? (
                      <ul className="file-details-list">
                        {selectedGraphNode.importedBy.map((item) => (
                          <li key={item.id}>
                            <button
                              type="button"
                              onClick={() => setSelectedGraphNodeId(item.id)}
                              title={item.filePath}
                            >
                              {getShortLabel(item.filePath)}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="file-details-empty">No importing files found.</p>
                    )}
                  </section>

                  {selectedGraphNode.isCircular && (
                    <p className="file-details-circular-note">
                      A dependency path from this file eventually leads back to itself.
                    </p>
                  )}
                </>
              ) : (
                <div className="file-details-empty-state">
                  <h3>File details</h3>
                  Select a node in the graph to inspect its imports, importing files, and
                  dependency relationships.
                </div>
              )}
            </aside>
          </div>
        )}

        {activeView === "method" && (
          <MethodExplorer
            projectPath={projectPath}
          // optional overrides:
          // apiUrl="http://127.0.0.1:4174/api/explain-method"
          // defaultSymbol="generateGraph"
          // defaultFilePath="viewer/src/App.tsx"
          />
        )}

        {activeView === "impact" && (
          <AnalyzeChangeImpact
            projectPath={projectPath}
          // optional overrides:
          // apiUrl="http://127.0.0.1:4174/api/analyze-change-impact"
          // defaultFilePath="viewer/src/App.tsx"
          // defaultSymbol="generateGraph"
          />
        )}

        {activeView === "quality" && (
          <CodeQualityAnalyzer
            projectPath={projectPath}
          // apiUrl="http://127.0.0.1:4174/api/analyze-code-quality"
          // defaultFilePath="viewer/src/App.tsx"
          // defaultSymbol="generateGraph"
          />
        )}

        {activeView === "deadCode" && (
          <DeadCodeAnalyzer
            projectPath={projectPath}
            defaultFilePath=""
            defaultSymbol=""
          />
        )}

        {activeView === "apiExplorer" && (
          <AnalyzeApiEndpoints
            projectPath={projectPath}
          />
        )}

        {activeView === "security" && (
          <AnalyzeSecurity
            projectPath={projectPath}
          />
        )}

        {activeView === "testCoverage" && (
          <AnalyzeTestCoverage
            projectPath={projectPath}
            onProjectPathChange={setProjectPath}
          />
        )}

        <footer>
          <span>Project: {projectPath || "Not selected"}</span>
          <span>Entry file: {entryFile || "Not selected"}</span>
        </footer>
      </section>
    </main>
  );
}