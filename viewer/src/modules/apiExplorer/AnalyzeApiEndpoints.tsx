import { useMemo, useState } from "react";
import {
  Activity,
  Check,
  CheckCircle2,
  Copy,
  Database,
  FileCode2,
  Filter,
  Flame,
  KeyRound,
  List,
  Search,
  Server,
  ShieldCheck,
  UploadCloud,
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

type Props = {
  projectPath: string;
  apiUrl?: string;
  defaultFilePath?: string;
};

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

  const summaryCards = report
    ? [
        {
          value: report.summary.GET,
          label: "GET",
          icon: <Activity size={18} />,
          className: "blue",
        },

        {
          value: report.summary.POST,
          label: "POST",
          icon: <Zap size={18} />,
          className: "green",
        },

        {
          value: report.summary.PUT,
          label: "PUT",
          icon: <Server size={18} />,
          className: "orange",
        },

        {
          value: report.summary.PATCH,
          label: "PATCH",
          icon: <ShieldCheck size={18} />,
          className: "purple",
        },

        {
          value: report.summary.DELETE,
          label: "DELETE",
          icon: <Filter size={18} />,
          className: "red",
        },

        {
          value:
            report.summary.FIREBASE_FIRESTORE,
          label: "Firestore",
          icon: <Database size={18} />,
          className: "purple",
        },

        {
          value: report.summary.FIREBASE_AUTH,
          label: "Firebase Auth",
          icon: <KeyRound size={18} />,
          className: "blue",
        },
      ]
    : [];

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
              <div
                className={`api-stat api-stat-${card.className}`}
                key={card.label}
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
              </div>
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
                      title="Source navigation will be connected next"
                    >
                      <FileCode2
                        size={14}
                      />

                      View source
                    </button>

                    <button
                      type="button"
                      title="Caller tracing will be connected next"
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
    </div>
  );
}