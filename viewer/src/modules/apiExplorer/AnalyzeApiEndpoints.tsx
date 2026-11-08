import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Activity,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerDownRight,
  Database,
  FileCode2,
  Filter,
  Flame,
  KeyRound,
  Layers,
  List,
  Loader2,
  Search,
  Server,
  ShieldCheck,
  UploadCloud,
  X,
  Zap,
} from "lucide-react";

import "./analyze-api-endpoints.css";

type ApiUsageCategory =
  | "http"
  | "firebase-firestore"
  | "firebase-auth"
  | "firebase-storage"
  | "firebase-functions";

type ApiEndpointUsage = {
  id: string;
  category: ApiUsageCategory;
  method: string;
  endpoint: string;
  urlExpression?: string;
  operation?: string;
  resource?: string;
  filePath: string;
  line: number;
  column: number;
  caller?: string;
  library: string;
  expression: string;
  confidence: "high" | "medium" | "low";
};

type ApiReport = {
  success: boolean;
  tool: "analyze_api_endpoints";
  projectPath: string;
  filePath?: string;

  summary: {
    GET: number;
    POST: number;
    PUT: number;
    PATCH: number;
    DELETE: number;
    OTHER: number;

    FIREBASE_FIRESTORE: number;
    FIREBASE_AUTH: number;
    FIREBASE_STORAGE: number;
    FIREBASE_FUNCTIONS: number;
  };

  endpoints: ApiEndpointUsage[];

  warnings: string[];

  error?: string;
};

type SourceSnippet = {
  success: boolean;
  filePath: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  highlightLine: number;
  lines: string[];
  truncated: boolean;
  error?: string;
};

type CallTraceNode = {
  name: string;
  kind: string;
  filePath: string;
  line: number;
  column: number;
  callSites: Array<{ line: number; column: number }>;
  callers: CallTraceNode[];
  relation: "call" | "reference";
  isCircular?: boolean;
};

type CallTraceReport = {
  success: boolean;
  target: {
    name: string;
    kind: string;
    filePath: string;
    line: number;
    column: number;
  };
  callers: CallTraceNode[];
  totalNodes: number;
  truncated: boolean;
  notes: string[];
  error?: string;
};

type SourceState = {
  filePath: string;
  line: number;
  full: boolean;
  loading: boolean;
  error: string;
  data: SourceSnippet | null;
};

type TraceState = {
  item: ApiEndpointUsage;
  loading: boolean;
  error: string;
  data: CallTraceReport | null;
};

type Props = {
  projectPath: string;
  apiUrl?: string;
  /** Defaults to the same bridge as apiUrl: .../api/view-source */
  viewSourceUrl?: string;
  /** Defaults to the same bridge as apiUrl: .../api/trace-callers */
  traceCallersUrl?: string;
  defaultFilePath?: string;
};

type TileFilter = {
  category: "all" | ApiUsageCategory;
  method: string;
};

async function postJson<
  T extends { success: boolean; error?: string },
>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const result = (await response.json()) as T;

  if (!response.ok || !result.success) {
    throw new Error(
      result.error ||
        `Request failed with status ${response.status}`,
    );
  }

  return result;
}

const categoryLabel: Record<ApiUsageCategory, string> = {
  http: "HTTP",
  "firebase-firestore": "Firestore",
  "firebase-auth": "Auth",
  "firebase-storage": "Storage",
  "firebase-functions": "Functions",
};

function categoryIcon(category: ApiUsageCategory) {
  if (category === "firebase-firestore") {
    return <Database size={15} />;
  }

  if (category === "firebase-auth") {
    return <KeyRound size={15} />;
  }

  if (category === "firebase-storage") {
    return <UploadCloud size={15} />;
  }

  if (category === "firebase-functions") {
    return <Zap size={15} />;
  }

  return <Server size={15} />;
}

function shortPath(filePath: string) {
  const parts = filePath.split(/[\\/]/).filter(Boolean);

  if (parts.length <= 3) {
    return filePath;
  }

  return `${parts[parts.length - 3]}/${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function methodClass(method: string) {
  return `api-method-${method.toLowerCase()}`;
}

function categoryClass(category: ApiUsageCategory) {
  return `api-category-${category.replace("firebase-", "")}`;
}

function formatOperation(item: ApiEndpointUsage) {
  if (item.category === "http") {
    return `${item.method} ${item.endpoint}`;
  }

  return `${categoryLabel[item.category]} · ${
    item.operation || item.method
  }`;
}

export default function AnalyzeApiEndpoints({
  projectPath,
  apiUrl = "http://127.0.0.1:4174/api/analyze-api-endpoints",
  viewSourceUrl = apiUrl.replace(
    /\/analyze-api-endpoints\/?$/,
    "/view-source",
  ),
  traceCallersUrl = apiUrl.replace(
    /\/analyze-api-endpoints\/?$/,
    "/trace-callers",
  ),
  defaultFilePath = "",
}: Props) {
  const [filePath, setFilePath] = useState(defaultFilePath);

  const [report, setReport] = useState<ApiReport | null>(null);

  const [selected, setSelected] =
    useState<ApiEndpointUsage | null>(null);

  const [search, setSearch] = useState("");

  const [category, setCategory] = useState<
    "all" | ApiUsageCategory
  >("all");

  const [method, setMethod] = useState("all");

  const [loading, setLoading] = useState(false);

  const [error, setError] = useState("");

  const [copied, setCopied] = useState(false);

  const [sourceView, setSourceView] =
    useState<SourceState | null>(null);

  const [trace, setTrace] = useState<TraceState | null>(null);

  // Ignore responses that arrive after a newer request started.
  const sourceRequest = useRef(0);
  const traceRequest = useRef(0);

  async function analyze() {
    setLoading(true);
    setError("");
    setSelected(null);

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },

        body: JSON.stringify({
          projectPath: projectPath.trim(),
          filePath: filePath.trim() || undefined,
        }),
      });

      const result = (await response.json()) as ApiReport;

      if (!response.ok || !result.success) {
        throw new Error(
          result.error ||
            `Request failed with status ${response.status}`,
        );
      }

      setReport(result);
    } catch (err) {
      setReport(null);

      setError(
        err instanceof Error
          ? err.message
          : "Unable to analyze API usage.",
      );
    } finally {
      setLoading(false);
    }
  }

  const filtered = useMemo(() => {
    if (!report) {
      return [];
    }

    const query = search.trim().toLowerCase();

    return report.endpoints.filter((item) => {
      const categoryMatch =
        category === "all" ||
        item.category === category;

      const methodMatch =
        method === "all" ||
        item.method === method;

      if (!categoryMatch || !methodMatch) {
        return false;
      }

      if (!query) {
        return true;
      }

      return [
        item.endpoint,
        item.operation,
        item.resource,
        item.filePath,
        item.caller,
        item.library,
        item.expression,
        categoryLabel[item.category],
      ]
        .filter(Boolean)
        .some((value) =>
          String(value)
            .toLowerCase()
            .includes(query),
        );
    });
  }, [
    report,
    search,
    category,
    method,
  ]);

  const methods = useMemo(() => {
    if (!report) {
      return [];
    }

    return Array.from(
      new Set(
        report.endpoints.map(
          (item) => item.method,
        ),
      ),
    ).sort();
  }, [report]);

  // Counted from the discovered operations themselves, so the tiles
  // always agree with the list below.
  const counts = useMemo(() => {
    const result = {
      GET: 0,
      POST: 0,
      PUT: 0,
      PATCH: 0,
      DELETE: 0,
      OTHER: 0,
      firestore: 0,
      auth: 0,
      storage: 0,
      functions: 0,
    };

    for (const item of report?.endpoints ?? []) {
      switch (item.category) {
        case "firebase-firestore":
          result.firestore += 1;
          continue;
        case "firebase-auth":
          result.auth += 1;
          continue;
        case "firebase-storage":
          result.storage += 1;
          continue;
        case "firebase-functions":
          result.functions += 1;
          continue;
      }

      switch (item.method) {
        case "GET":
        case "POST":
        case "PUT":
        case "PATCH":
        case "DELETE":
          result[item.method] += 1;
          break;
        default:
          result.OTHER += 1;
      }
    }

    return result;
  }, [report]);

  const summaryCards: Array<{
    value: number;
    label: string;
    icon: ReactNode;
    className: string;
    filter: TileFilter;
  }> = report
    ? [
        {
          value: counts.GET,
          label: "GET",
          icon: <Activity size={18} />,
          className: "blue",
          filter: { category: "http", method: "GET" },
        },
        {
          value: counts.POST,
          label: "POST",
          icon: <Zap size={18} />,
          className: "green",
          filter: { category: "http", method: "POST" },
        },
        {
          value: counts.PUT,
          label: "PUT",
          icon: <Server size={18} />,
          className: "orange",
          filter: { category: "http", method: "PUT" },
        },
        {
          value: counts.PATCH,
          label: "PATCH",
          icon: <ShieldCheck size={18} />,
          className: "purple",
          filter: { category: "http", method: "PATCH" },
        },
        {
          value: counts.DELETE,
          label: "DELETE",
          icon: <Filter size={18} />,
          className: "red",
          filter: { category: "http", method: "DELETE" },
        },
        {
          value: counts.OTHER,
          label: "Other / dynamic",
          icon: <Layers size={18} />,
          className: "gray",
          filter: { category: "http", method: "OTHER" },
        },
        {
          value: counts.firestore,
          label: "Firestore",
          icon: <Database size={18} />,
          className: "purple",
          filter: { category: "firebase-firestore", method: "all" },
        },
        {
          value: counts.auth,
          label: "Firebase Auth",
          icon: <KeyRound size={18} />,
          className: "blue",
          filter: { category: "firebase-auth", method: "all" },
        },
        {
          value: counts.storage,
          label: "Storage",
          icon: <UploadCloud size={18} />,
          className: "orange",
          filter: { category: "firebase-storage", method: "all" },
        },
        {
          value: counts.functions,
          label: "Functions",
          icon: <Zap size={18} />,
          className: "green",
          filter: { category: "firebase-functions", method: "all" },
        },
      ]
    : [];

  function applyTileFilter(filter: TileFilter) {
    const active =
      category === filter.category && method === filter.method;

    // Clicking the active tile clears the filter.
    setCategory(active ? "all" : filter.category);
    setMethod(active ? "all" : filter.method);
  }

  async function copyExpression() {
    if (!selected) {
      return;
    }

    await navigator.clipboard.writeText(
      selected.expression,
    );

    setCopied(true);

    window.setTimeout(() => {
      setCopied(false);
    }, 1400);
  }

  async function openSource(
    targetFilePath: string,
    line: number,
    full = false,
  ) {
    const requestId = ++sourceRequest.current;

    setSourceView({
      filePath: targetFilePath,
      line,
      full,
      loading: true,
      error: "",
      data: null,
    });

    try {
      const data = await postJson<SourceSnippet>(viewSourceUrl, {
        projectPath: projectPath.trim(),
        filePath: targetFilePath,
        line,
        full,
      });

      if (requestId === sourceRequest.current) {
        setSourceView({
          filePath: targetFilePath,
          line,
          full,
          loading: false,
          error: "",
          data,
        });
      }
    } catch (err) {
      if (requestId === sourceRequest.current) {
        setSourceView({
          filePath: targetFilePath,
          line,
          full,
          loading: false,
          error:
            err instanceof Error
              ? err.message
              : "Unable to load the source file.",
          data: null,
        });
      }
    }
  }

  async function traceCaller(item: ApiEndpointUsage) {
    const requestId = ++traceRequest.current;

    setTrace({ item, loading: true, error: "", data: null });

    try {
      const data = await postJson<CallTraceReport>(
        traceCallersUrl,
        {
          projectPath: projectPath.trim(),
          filePath: item.filePath,
          line: item.line,
          column: item.column,
        },
      );

      if (requestId === traceRequest.current) {
        setTrace({ item, loading: false, error: "", data });
      }
    } catch (err) {
      if (requestId === traceRequest.current) {
        setTrace({
          item,
          loading: false,
          error:
            err instanceof Error
              ? err.message
              : "Unable to trace callers.",
          data: null,
        });
      }
    }
  }

  function closeSource() {
    sourceRequest.current += 1;
    setSourceView(null);
  }

  function closeTrace() {
    traceRequest.current += 1;
    setTrace(null);
  }

  // Escape closes the top-most dialog first.
  useEffect(() => {
    if (!sourceView && !trace) {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      if (sourceView) {
        closeSource();
      } else {
        closeTrace();
      }
    }

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sourceView, trace]);

  return (
    <div className="api-explorer">
      <header className="api-heading">
        <div>
          <h2>
            API / Backend Communication Explorer
          </h2>

          <p>
            Discover HTTP requests and Firebase
            operations used throughout your project.
            Review where each operation is called and
            inspect the source expression.
          </p>
        </div>

        <span className="api-ready">
          {loading
            ? "Analyzing…"
            : report
              ? "Analysis ready"
              : "Ready"}
        </span>
      </header>

      <div className="api-howto">
        <Activity size={16} />

        <div>
          <strong>
            How to use it:
          </strong>{" "}
          analyze the project, then search or filter
          the discovered operations. HTTP calls are
          shown as HTTP methods; Firebase calls are
          shown as service operations rather than
          artificial HTTP endpoints.
        </div>
      </div>

      <div className="api-controls">
        <label>
          <span>
            Project path
          </span>

          <small>
            Project currently supplied by the viewer.
          </small>

          <input
            value={projectPath}
            readOnly
          />
        </label>

        <label>
          <span>
            File path
          </span>

          <small>
            Optional relative path to analyze one file.
          </small>

          <input
            value={filePath}
            onChange={(event) =>
              setFilePath(event.target.value)
            }
            placeholder="src/services/userService.ts"
          />
        </label>

        <button
          className="api-primary"
          type="button"
          onClick={() => void analyze()}
          disabled={
            loading ||
            !projectPath.trim()
          }
        >
          {loading
            ? "Analyzing APIs…"
            : "Analyze API usage"}
        </button>
      </div>

      {error && (
        <div className="api-message error">
          <strong>
            Analysis failed:
          </strong>{" "}
          {error}
        </div>
      )}

      {report && (
        <>
          <div className="api-status">
            <span className="api-status-pill">
              <CheckCircle2 size={15} />

              {report.endpoints.length}{" "}
              operations discovered
            </span>

            <span className="api-target-line">
              {report.filePath
                ? `File: ${report.filePath}`
                : "Project-wide analysis"}
            </span>
          </div>

          <div className="api-stats">
            {summaryCards.map((card) => (
              <button
                type="button"
                className={`api-stat api-stat-${card.className} ${
                  category === card.filter.category &&
                  method === card.filter.method
                    ? "active"
                    : ""
                }`}
                key={card.label}
                onClick={() => applyTileFilter(card.filter)}
                title={`Show ${card.label} operations`}
              >
                <span className="api-stat-icon">
                  {card.icon}
                </span>

                <span className="api-stat-text">
                  <strong>
                    {card.value}
                  </strong>

                  <small>
                    {card.label}
                  </small>
                </span>
              </button>
            ))}
          </div>

          <div className="api-workspace">
            <section className="api-list-panel">
              <div className="api-panel-toolbar">
                <div>
                  <h3>
                    Operations
                  </h3>

                  <p>
                    {filtered.length} of{" "}
                    {report.endpoints.length}{" "}
                    discovered operations
                  </p>
                </div>

                <span className="api-toolbar-badge">
                  <List size={13} />

                  {filtered.length}
                </span>
              </div>

              <div className="api-filter-bar">
                <label className="api-search">
                  <Search size={14} />

                  <input
                    value={search}
                    onChange={(event) =>
                      setSearch(
                        event.target.value,
                      )
                    }
                    placeholder="Search endpoint, operation, file, caller…"
                  />
                </label>

                <label>
                  <select
                    value={category}
                    onChange={(event) =>
                      setCategory(
                        event.target.value as
                          | "all"
                          | ApiUsageCategory,
                      )
                    }
                  >
                    <option value="all">
                      All categories
                    </option>

                    <option value="http">
                      HTTP
                    </option>

                    <option value="firebase-firestore">
                      Firestore
                    </option>

                    <option value="firebase-auth">
                      Auth
                    </option>

                    <option value="firebase-storage">
                      Storage
                    </option>

                    <option value="firebase-functions">
                      Functions
                    </option>
                  </select>
                </label>

                <label>
                  <select
                    value={method}
                    onChange={(event) =>
                      setMethod(
                        event.target.value,
                      )
                    }
                  >
                    <option value="all">
                      All methods
                    </option>

                    {methods.map((item) => (
                      <option
                        key={item}
                        value={item}
                      >
                        {item}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="api-list">
                {filtered.length ? (
                  filtered.map((item) => (
                    <button
                      type="button"
                      className={`api-row ${
                        selected?.id === item.id
                          ? "selected"
                          : ""
                      }`}
                      key={item.id}
                      onClick={() =>
                        setSelected(item)
                      }
                    >
                      <span
                        className={`api-row-icon ${categoryClass(
                          item.category,
                        )}`}
                      >
                        {categoryIcon(
                          item.category,
                        )}
                      </span>

                      <span className="api-row-main">
                        <span className="api-row-top">
                          {item.category ===
                          "http" ? (
                            <span
                              className={`api-method ${methodClass(
                                item.method,
                              )}`}
                            >
                              {item.method}
                            </span>
                          ) : (
                            <span
                              className={`api-category ${categoryClass(
                                item.category,
                              )}`}
                            >
                              {
                                categoryLabel[
                                  item.category
                                ]
                              }
                            </span>
                          )}

                          <strong
                            title={formatOperation(
                              item,
                            )}
                          >
                            {item.category ===
                            "http"
                              ? item.endpoint
                              : item.operation ||
                                item.method}
                          </strong>
                        </span>

                        <span className="api-row-meta">
                          {shortPath(
                            item.filePath,
                          )}{" "}
                          · line{" "}
                          {item.line}
                          {item.caller
                            ? ` · ${item.caller}`
                            : ""}
                        </span>
                      </span>

                      <span
                        className={`api-confidence ${item.confidence}`}
                      >
                        {item.confidence}
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="api-empty">
                    No operations match the
                    current filters.
                  </div>
                )}
              </div>
            </section>

            <aside className="api-inspector">
              <div className="api-panel-toolbar">
                <div>
                  <h3>
                    Inspector
                  </h3>

                  <p>
                    Details for the selected
                    operation
                  </p>
                </div>
              </div>

              {selected ? (
                <div className="api-inspector-body">
                  <div className="api-inspector-heading">
                    <span
                      className={`api-large-icon ${categoryClass(
                        selected.category,
                      )}`}
                    >
                      {categoryIcon(
                        selected.category,
                      )}
                    </span>

                    <div>
                      <span
                        className={`api-category ${categoryClass(
                          selected.category,
                        )}`}
                      >
                        {
                          categoryLabel[
                            selected.category
                          ]
                        }
                      </span>

                      <h3>
                        {formatOperation(
                          selected,
                        )}
                      </h3>
                    </div>
                  </div>

                  <div className="api-facts">
                    <div>
                      <span>
                        Category
                      </span>

                      <strong>
                        {
                          categoryLabel[
                            selected.category
                          ]
                        }
                      </strong>
                    </div>

                    <div>
                      <span>
                        Method
                      </span>

                      <strong>
                        {selected.method}
                      </strong>
                    </div>

                    {selected.operation && (
                      <div>
                        <span>
                          Operation
                        </span>

                        <strong>
                          {
                            selected.operation
                          }
                        </strong>
                      </div>
                    )}

                    {selected.resource && (
                      <div>
                        <span>
                          Resource
                        </span>

                        <strong
                          title={
                            selected.resource
                          }
                        >
                          {
                            selected.resource
                          }
                        </strong>
                      </div>
                    )}

                    <div>
                      <span>
                        File
                      </span>

                      <strong
                        title={
                          selected.filePath
                        }
                      >
                        {
                          selected.filePath
                        }
                      </strong>
                    </div>

                    <div>
                      <span>
                        Location
                      </span>

                      <strong>
                        {selected.line}:
                        {selected.column}
                      </strong>
                    </div>

                    <div>
                      <span>
                        Caller
                      </span>

                      <strong>
                        {selected.caller ||
                          "Unknown"}
                      </strong>
                    </div>

                    <div>
                      <span>
                        Library
                      </span>

                      <strong>
                        {
                          selected.library
                        }
                      </strong>
                    </div>

                    <div>
                      <span>
                        Confidence
                      </span>

                      <strong>
                        {
                          selected.confidence
                        }
                      </strong>
                    </div>

                    {selected.urlExpression && (
                      <div>
                        <span>
                          Resolved from
                        </span>

                        <strong
                          title={
                            selected.urlExpression
                          }
                        >
                          {
                            selected.urlExpression
                          }
                        </strong>
                      </div>
                    )}
                  </div>

                  <div className="api-expression">
                    <div className="api-expression-head">
                      <span>
                        Source expression
                      </span>

                      <button
                        type="button"
                        onClick={() =>
                          void copyExpression()
                        }
                      >
                        {copied ? (
                          <Check
                            size={13}
                          />
                        ) : (
                          <Copy
                            size={13}
                          />
                        )}

                        {copied
                          ? "Copied"
                          : "Copy"}
                      </button>
                    </div>

                    <pre>
                      {
                        selected.expression
                      }
                    </pre>
                  </div>

                  <div className="api-actions">
                    <button
                      type="button"
                      title="Open the source file at this location"
                      onClick={() =>
                        void openSource(
                          selected.filePath,
                          selected.line,
                        )
                      }
                    >
                      <FileCode2
                        size={14}
                      />

                      View source
                    </button>

                    <button
                      type="button"
                      title="Show which functions lead to this call"
                      onClick={() =>
                        void traceCaller(selected)
                      }
                    >
                      <List
                        size={14}
                      />

                      Trace caller
                    </button>
                  </div>
                </div>
              ) : (
                <div className="api-inspector-empty">
                  <div className="api-empty-icon">
                    <Server
                      size={25}
                    />
                  </div>

                  <h3>
                    Select an operation
                  </h3>

                  <p>
                    Choose an HTTP or
                    Firebase operation
                    from the list to
                    inspect its source
                    location, caller,
                    resource, and
                    expression.
                  </p>
                </div>
              )}
            </aside>
          </div>

          {report.warnings.length >
            0 && (
            <div className="api-warnings">
              <div>
                <Flame size={15} />

                <strong>
                  Analysis notes
                </strong>
              </div>

              <ul>
                {report.warnings.map(
                  (
                    warning,
                    index,
                  ) => (
                    <li
                      key={`${warning}-${index}`}
                    >
                      {warning}
                    </li>
                  ),
                )}
              </ul>
            </div>
          )}
        </>
      )}

      {!report &&
        !error &&
        !loading && (
          <div className="api-empty-state">
            <div className="api-empty-icon">
              <Server size={29} />
            </div>

            <h3>
              API / Backend
              Communication
              Explorer
            </h3>

            <p>
              Analyze your project
              to discover HTTP
              requests, Firestore
              operations, Firebase
              Authentication,
              Storage, and Cloud
              Functions usage.
            </p>
          </div>
        )}

      {trace && (
        <TraceDialog
          state={trace}
          onClose={closeTrace}
          onOpenSource={(file, line) =>
            void openSource(file, line)
          }
        />
      )}

      {sourceView && (
        <SourceDialog
          state={sourceView}
          onClose={closeSource}
          onShowFull={() =>
            void openSource(
              sourceView.filePath,
              sourceView.line,
              true,
            )
          }
        />
      )}
    </div>
  );
}

/* =========================================================
   View source dialog
   ========================================================= */

function SourceDialog({
  state,
  onClose,
  onShowFull,
}: {
  state: SourceState;
  onClose: () => void;
  onShowFull: () => void;
}) {
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState(false);

  const data = state.data;

  useEffect(() => {
    highlightRef.current?.scrollIntoView({ block: "center" });
  }, [data?.startLine, data?.endLine, data?.highlightLine]);

  const partial =
    data !== null &&
    (data.startLine > 1 || data.endLine < data.totalLines);

  return (
    <div
      className="api-modal-backdrop api-modal-top"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="api-modal api-source-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Source of ${state.filePath}`}
      >
        <header className="api-modal-head">
          <div>
            <h3>
              <FileCode2 size={15} />
              {state.filePath}
            </h3>

            <p>
              {data
                ? `Lines ${data.startLine}–${data.endLine} of ${data.totalLines} · highlighted line ${data.highlightLine}`
                : `Line ${state.line}`}
            </p>
          </div>

          <div className="api-modal-tools">
            {partial && !state.loading && (
              <button type="button" onClick={onShowFull}>
                Show whole file
              </button>
            )}

            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(
                  state.filePath,
                );
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? "Copied" : "Copy path"}
            </button>

            <button
              type="button"
              className="api-icon-button"
              onClick={onClose}
              aria-label="Close"
            >
              <X size={15} />
            </button>
          </div>
        </header>

        <div className="api-modal-body">
          {state.loading && (
            <div className="api-modal-status">
              <Loader2 size={16} className="api-spin" />
              Loading source…
            </div>
          )}

          {state.error && (
            <div className="api-message error">
              <strong>Unable to open source:</strong>{" "}
              {state.error}
            </div>
          )}

          {data && (
            <div className="api-source-code">
              {data.lines.map((text, index) => {
                const number = data.startLine + index;
                const highlighted =
                  number === data.highlightLine;

                return (
                  <div
                    key={number}
                    ref={highlighted ? highlightRef : undefined}
                    className={`api-source-line ${
                      highlighted ? "highlight" : ""
                    }`}
                  >
                    <span className="api-source-no">
                      {number}
                    </span>

                    <code>{text === "" ? " " : text}</code>
                  </div>
                );
              })}

              {data.truncated && (
                <div className="api-modal-status">
                  Very large file: only part of it is shown.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   Trace caller dialog
   ========================================================= */

function TraceDialog({
  state,
  onClose,
  onOpenSource,
}: {
  state: TraceState;
  onClose: () => void;
  onOpenSource: (filePath: string, line: number) => void;
}) {
  const data = state.data;

  return (
    <div
      className="api-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="api-modal api-trace-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Caller trace"
      >
        <header className="api-modal-head">
          <div>
            <h3>
              <List size={15} />
              Trace caller
            </h3>

            <p>
              {formatOperation(state.item)} ·{" "}
              {shortPath(state.item.filePath)}:{state.item.line}
            </p>
          </div>

          <div className="api-modal-tools">
            <button
              type="button"
              className="api-icon-button"
              onClick={onClose}
              aria-label="Close"
            >
              <X size={15} />
            </button>
          </div>
        </header>

        <div className="api-modal-body">
          {state.loading && (
            <div className="api-modal-status">
              <Loader2 size={16} className="api-spin" />
              Tracing callers… the first trace builds the
              project index and can take a few seconds.
            </div>
          )}

          {state.error && (
            <div className="api-message error">
              <strong>Trace failed:</strong> {state.error}
            </div>
          )}

          {data && (
            <>
              <button
                type="button"
                className="api-trace-target"
                onClick={() =>
                  onOpenSource(
                    data.target.filePath,
                    data.target.line,
                  )
                }
              >
                <span className="api-trace-label">
                  Function containing this call
                </span>

                <strong>{data.target.name}</strong>

                <small>
                  {data.target.filePath}:{data.target.line}
                </small>
              </button>

              {data.callers.length > 0 ? (
                <ul className="api-trace-tree">
                  {data.callers.map((node, index) => (
                    <TraceNode
                      key={`${node.filePath}:${node.line}:${index}`}
                      node={node}
                      depth={0}
                      onOpenSource={onOpenSource}
                    />
                  ))}
                </ul>
              ) : (
                <div className="api-modal-status">
                  No callers found.
                </div>
              )}

              {data.notes.length > 0 && (
                <ul className="api-trace-notes">
                  {data.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TraceNode({
  node,
  depth,
  onOpenSource,
}: {
  node: CallTraceNode;
  depth: number;
  onOpenSource: (filePath: string, line: number) => void;
}) {
  const [open, setOpen] = useState(depth < 2);

  const hasChildren = node.callers.length > 0;

  // Jump to where this function uses the traced function.
  const jumpLine = node.callSites[0]?.line ?? node.line;

  return (
    <li className="api-trace-node">
      <div className="api-trace-line">
        {hasChildren ? (
          <button
            type="button"
            className="api-trace-toggle"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? "Collapse" : "Expand"}
          >
            {open ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )}
          </button>
        ) : (
          <span className="api-trace-toggle placeholder">
            <CornerDownRight size={13} />
          </span>
        )}

        <button
          type="button"
          className="api-trace-row"
          onClick={() => onOpenSource(node.filePath, jumpLine)}
          title="Open source at the call site"
        >
          <strong>{node.name}</strong>

          {node.relation === "reference" && (
            <span className="api-trace-badge">
              passed as callback
            </span>
          )}

          {node.isCircular && (
            <span className="api-trace-badge warn">
              recursion
            </span>
          )}

          <small>
            {node.filePath}:{jumpLine}
          </small>
        </button>
      </div>

      {hasChildren && open && (
        <ul className="api-trace-tree nested">
          {node.callers.map((child, index) => (
            <TraceNode
              key={`${child.filePath}:${child.line}:${index}`}
              node={child}
              depth={depth + 1}
              onOpenSource={onOpenSource}
            />
          ))}
        </ul>
      )}
    </li>
  );
}