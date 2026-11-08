import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  FileCode2,
  Package,
  Search,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import SecuritySelect, { type SecuritySelectOption } from "../security/SecuritySelect";
import "./analyze-dependency-health.css";

const API_URL = "http://127.0.0.1:4174/api/analyze-dependency-health";
const PAGE_SIZE = 100;
const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];
const CATEGORIES: Category[] = [
  "missing",
  "unused",
  "duplicate",
  "outdated",
  "deprecated",
  "placement",
  "health",
];

type Severity = "critical" | "high" | "medium" | "low" | "info";
type Category =
  | "missing"
  | "unused"
  | "duplicate"
  | "outdated"
  | "deprecated"
  | "placement"
  | "health";

type Finding = {
  id: string;
  severity: Severity;
  category: Category;
  packageName: string;
  title: string;
  description: string;
  recommendation: string;
  declaredVersion?: string;
  installedVersion?: string;
  latestVersion?: string;
  dependencyKind?: string;
  filePath?: string;
  confidence: "high" | "medium" | "low";
};

type DependencyInfo = {
  name: string;
  version: string;
  kind: string;
  resolvedVersion?: string;
};

type DuplicateDependency = {
  packageName: string;
  versions: string[];
  locations: string[];
};

type Report = {
  success: boolean;
  tool: "analyze_dependency_health";
  projectPath: string;
  packageManager: string;
  packageName?: string;
  packageVersion?: string;
  totalDependencies: number;
  directDependencies: number;
  devDependencies: number;
  peerDependencies: number;
  optionalDependencies: number;
  importedExternalPackages: number;
  missingDependencies: number;
  unusedDependencies: number;
  duplicateDependencies: number;
  outdatedDependencies: number;
  deprecatedDependencies: number;
  findings: Finding[];
  dependencies: DependencyInfo[];
  duplicates: DuplicateDependency[];
  scannedFiles: string[];
  warnings: string[];
};

interface AnalyzeDependencyHealthProps {
  projectPath: string;
  onProjectPathChange?: (value: string) => void;
}

function severityIcon(severity: Severity) {
  if (severity === "critical") return <XCircle size={16} />;
  if (severity === "high") return <ShieldAlert size={16} />;
  if (severity === "medium") return <AlertTriangle size={16} />;
  return <CircleAlert size={16} />;
}

function categoryLabel(category: Category) {
  return category
    .replace(/-/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function severityLabel(severity: Severity) {
  return severity.charAt(0).toUpperCase() + severity.slice(1);
}

export default function AnalyzeDependencyHealth({
  projectPath,
  onProjectPathChange,
}: AnalyzeDependencyHealthProps) {
  const [report, setReport] = useState<Report | null>(null);
  const [search, setSearch] = useState("");
  const [severity, setSeverity] = useState<"all" | Severity>("all");
  const [category, setCategory] = useState<"all" | Category>("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Start from the first page whenever the filters change.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [search, severity, category, report]);

  async function analyze() {
    if (!projectPath.trim()) {
      setError("Enter a project path before starting the analysis.");
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError("");
    setReport(null);
    setExpandedId(null);
    setSearch("");
    setSeverity("all");
    setCategory("all");

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectPath: projectPath.trim(),
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || data.success === false) {
        throw new Error(
          data.error || "Dependency health analysis failed.",
        );
      }

      setReport(data as Report);
    } catch (analysisError) {
      if (controller.signal.aborted) return;
      setError(
        analysisError instanceof Error
          ? analysisError.message
          : "Unable to analyze the project.",
      );
    } finally {
      if (abortRef.current === controller) setLoading(false);
    }
  }

  const filteredFindings = useMemo(() => {
    if (!report) return [];

    const query = search.trim().toLowerCase();

    return report.findings.filter((finding) => {
      const matchesSearch =
        !query ||
        [
          finding.packageName,
          finding.title,
          finding.description,
          finding.recommendation,
          finding.filePath ?? "",
          finding.category,
          finding.dependencyKind ?? "",
        ]
          .join(" ")
          .toLowerCase()
          .includes(query);

      const matchesSeverity =
        severity === "all" || finding.severity === severity;

      const matchesCategory =
        category === "all" || finding.category === category;

      return matchesSearch && matchesSeverity && matchesCategory;
    });
  }, [report, search, severity, category]);

  const { severityOptions, categoryOptions } = useMemo(() => {
    const severityCounts: Record<string, number> = {};
    const categoryCounts: Record<string, number> = {};

    for (const finding of report?.findings ?? []) {
      severityCounts[finding.severity] =
        (severityCounts[finding.severity] ?? 0) + 1;
      categoryCounts[finding.category] =
        (categoryCounts[finding.category] ?? 0) + 1;
    }

    const total = report?.findings.length ?? 0;

    const severityOptions: SecuritySelectOption<"all" | Severity>[] = [
      { value: "all", label: "All severities", count: total },
      ...SEVERITIES.map((item) => ({
        value: item,
        label: severityLabel(item),
        tone: item,
        count: severityCounts[item] ?? 0,
      })),
    ];

    const categoryOptions: SecuritySelectOption<"all" | Category>[] = [
      { value: "all", label: "All categories", count: total },
      ...CATEGORIES.map((item) => ({
        value: item,
        label: categoryLabel(item),
        count: categoryCounts[item] ?? 0,
      })),
    ];

    return { severityOptions, categoryOptions };
  }, [report]);

  const visibleFindings = filteredFindings.slice(0, visibleCount);

  return (
    <div className="dependency-health-analyzer">
      <div className="dependency-health-title-row">
        <div className="dependency-health-title-icon">
          <Package size={24} />
        </div>

        <div>
          <h1>Dependency Health Analyzer</h1>
          <p>
            Find missing, unused, duplicate, outdated, and incorrectly placed
            dependencies across your JavaScript or TypeScript project.
          </p>
        </div>
      </div>

      <section className="dependency-health-input-card">
        <div className="dependency-health-field">
          <label htmlFor="dependency-health-project-path">Project path</label>
          <input
            id="dependency-health-project-path"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !loading) void analyze();
            }}
            value={projectPath}
            onChange={(event) =>
              onProjectPathChange?.(event.target.value)
            }
            placeholder="/path/to/your/project or public GitHub URL"
          />
        </div>

        <button
          type="button"
          className="dependency-health-analyze-button"
          onClick={analyze}
          disabled={loading}
        >
          {loading ? (
            <>
              <span className="dependency-health-spinner" />
              Analyzing...
            </>
          ) : (
            <>
              <Package size={17} />
              Analyze Dependencies
            </>
          )}
        </button>
      </section>

      {error && (
        <div className="dependency-health-error">
          <XCircle size={18} />
          <span>{error}</span>
        </div>
      )}

      {report && (
        <>
          <div className="dependency-health-status-row">
            <div className="dependency-health-success">
              <CheckCircle2 size={18} />
              <strong>{report.totalDependencies}</strong>
              <span>declared packages</span>
            </div>

            <div className="dependency-health-status-meta">
              <span>{report.packageManager}</span>
              {report.packageName && (
                <span>
                  {report.packageName}
                  {report.packageVersion
                    ? ` · ${report.packageVersion}`
                    : ""}
                </span>
              )}
            </div>
          </div>

          <div className="dependency-health-summary-grid">
            {(
              [
                [
                  "missing",
                  "Missing",
                  report.missingDependencies,
                  ShieldAlert,
                ],
                [
                  "unused",
                  "Possibly unused",
                  report.unusedDependencies,
                  CircleAlert,
                ],
                [
                  "duplicate",
                  "Duplicates",
                  report.duplicateDependencies,
                  Package,
                ],
                [
                  "outdated",
                  "Outdated",
                  report.outdatedDependencies,
                  AlertTriangle,
                ],
              ] as const
            ).map(([key, label, count, Icon]) => (
              <button
                type="button"
                key={key}
                className={`dependency-health-summary-card is-${key}${
                  category === key ? " is-active" : ""
                }`}
                aria-pressed={category === key}
                onClick={() =>
                  setCategory(
                    category === key ? "all" : (key as Category),
                  )
                }
              >
                <div className="dependency-health-summary-icon">
                  <Icon size={19} />
                </div>

                <div>
                  <strong>{count}</strong>
                  <span>{label}</span>
                </div>
              </button>
            ))}
          </div>

          <div className="dependency-health-metrics">
            <div>
              <span>Runtime</span>
              <strong>{report.directDependencies}</strong>
            </div>
            <div>
              <span>Development</span>
              <strong>{report.devDependencies}</strong>
            </div>
            <div>
              <span>Peer</span>
              <strong>{report.peerDependencies}</strong>
            </div>
            <div>
              <span>Imported</span>
              <strong>{report.importedExternalPackages}</strong>
            </div>
          </div>

          <section className="dependency-health-workspace">
            <div className="dependency-health-findings-panel">
              <div className="dependency-health-panel-header">
                <div>
                  <h2>Dependency Findings</h2>
                  <p>
                    {filteredFindings.length} of {report.findings.length}{" "}
                    findings
                  </p>
                </div>

                <div className="dependency-health-count">
                  <Package size={15} />
                  {filteredFindings.length}
                </div>
              </div>

              <div className="dependency-health-filters">
                <div className="dependency-health-search">
                  <Search size={17} />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search packages, findings, files..."
                  />
                </div>

                <SecuritySelect
                  value={severity}
                  options={severityOptions}
                  onChange={setSeverity}
                  ariaLabel="Filter by severity"
                />

                <SecuritySelect
                  value={category}
                  options={categoryOptions}
                  onChange={setCategory}
                  ariaLabel="Filter by category"
                />
              </div>

              <div className="dependency-health-list">
                {filteredFindings.length > 0 ? (
                  <>
                  {visibleFindings.map((finding) => {
                    const expanded = expandedId === finding.id;

                    return (
                      <article
                        key={finding.id}
                        className={`dependency-health-finding ${
                          expanded ? "is-expanded" : ""
                        }`}
                      >
                        <button
                          type="button"
                          className="dependency-health-finding-toggle"
                          aria-expanded={expanded}
                          onClick={() =>
                            setExpandedId(
                              expanded ? null : finding.id,
                            )
                          }
                        >
                        <div className="dependency-health-finding-main">
                          <div
                            className={`dependency-health-severity ${finding.severity}`}
                          >
                            {severityIcon(finding.severity)}
                          </div>

                          <div className="dependency-health-finding-copy">
                            <div className="dependency-health-finding-topline">
                              <strong>{finding.packageName}</strong>
                              <span
                                className={`dependency-health-badge ${finding.severity}`}
                              >
                                {severityLabel(finding.severity)}
                              </span>
                              <span className="dependency-health-category">
                                {categoryLabel(finding.category)}
                              </span>
                            </div>

                            <h3>{finding.title}</h3>
                            <p>{finding.description}</p>

                            {finding.filePath && (
                              <span className="dependency-health-file">
                                <FileCode2 size={13} />
                                {finding.filePath}
                              </span>
                            )}
                          </div>

                          <div className="dependency-health-chevron">
                            {expanded ? (
                              <ChevronUp size={18} />
                            ) : (
                              <ChevronDown size={18} />
                            )}
                          </div>
                        </div>
                        </button>

                        {expanded && (
                          <div className="dependency-health-detail">
                            <div>
                              <span>Recommendation</span>
                              <p>{finding.recommendation}</p>
                            </div>

                            <div className="dependency-health-detail-grid">
                              {finding.declaredVersion && (
                                <div>
                                  <span>Declared</span>
                                  <strong>
                                    {finding.declaredVersion}
                                  </strong>
                                </div>
                              )}

                              {finding.installedVersion && (
                                <div>
                                  <span>Installed</span>
                                  <strong>
                                    {finding.installedVersion}
                                  </strong>
                                </div>
                              )}

                              {finding.latestVersion && (
                                <div>
                                  <span>Latest</span>
                                  <strong>
                                    {finding.latestVersion}
                                  </strong>
                                </div>
                              )}

                              {finding.dependencyKind && (
                                <div>
                                  <span>Declared as</span>
                                  <strong>
                                    {finding.dependencyKind}
                                  </strong>
                                </div>
                              )}

                              <div>
                                <span>Confidence</span>
                                <strong>
                                  {finding.confidence}
                                </strong>
                              </div>
                            </div>
                          </div>
                        )}
                      </article>
                    );
                  })}
                  {filteredFindings.length > visibleCount && (
                    <button
                      type="button"
                      className="dependency-health-show-more"
                      onClick={() =>
                        setVisibleCount((count) => count + PAGE_SIZE)
                      }
                    >
                      Show {Math.min(PAGE_SIZE, filteredFindings.length - visibleCount)} more
                      ({filteredFindings.length - visibleCount} remaining)
                    </button>
                  )}
                  </>
                ) : (
                  <div className="dependency-health-empty">
                    <CheckCircle2 size={22} />
                    <strong>No matching findings</strong>
                    <span>
                      {report.findings.length === 0
                        ? "Dependency inventory looks healthy based on the checks available."
                        : "Try a different search or filter."}
                    </span>
                  </div>
                )}
              </div>
            </div>

            <aside className="dependency-health-inventory-panel">
              <div className="dependency-health-panel-header">
                <div>
                  <h2>Dependency Inventory</h2>
                  <p>
                    {report.dependencies.length} declared packages
                  </p>
                </div>
              </div>

              <div className="dependency-health-panel-body">
              <div className="dependency-health-inventory">
                {report.dependencies.map((dependency) => (
                  <div
                    key={`${dependency.name}-${dependency.kind}`}
                    className="dependency-health-inventory-item"
                  >
                    <div>
                      <strong>{dependency.name}</strong>
                      <span>
                        {dependency.kind}
                        {dependency.resolvedVersion
                          ? ` · ${dependency.resolvedVersion}`
                          : ""}
                      </span>
                    </div>

                    <code>{dependency.version}</code>
                  </div>
                ))}
              </div>

              {report.duplicates.length > 0 && (
                <div className="dependency-health-duplicates">
                  <div className="dependency-health-subheading">
                    Duplicate versions
                  </div>

                  {report.duplicates.map((duplicate) => (
                    <div
                      key={duplicate.packageName}
                      className="dependency-health-duplicate"
                    >
                      <strong>{duplicate.packageName}</strong>
                      <span>
                        {duplicate.versions.join(" · ")}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {report.warnings.length > 0 && (
                <div className="dependency-health-warnings">
                  <div className="dependency-health-subheading">
                    Analyzer notes
                  </div>

                  {report.warnings.map((warning, index) => (
                    <div
                      key={`${warning}-${index}`}
                      className="dependency-health-warning"
                    >
                      <AlertTriangle size={15} />
                      <span>{warning}</span>
                    </div>
                  ))}
                </div>
              )}
              </div>
            </aside>
          </section>
        </>
      )}
    </div>
  );
}