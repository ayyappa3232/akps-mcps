import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileCode2,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import SecuritySelect, {
  type SecuritySelectOption,
} from "./SecuritySelect";
import "./analyze-security.css";

type SecuritySeverity =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "info";

type SecurityCategory =
  | "secrets"
  | "xss"
  | "injection"
  | "unsafe-code"
  | "storage"
  | "network"
  | "crypto"
  | "logging"
  | "configuration"
  | "other";

interface SecurityFinding {
  id: string;
  severity: SecuritySeverity;
  category: SecurityCategory;
  title: string;
  description: string;
  recommendation: string;
  filePath: string;
  line: number;
  column: number;
  expression: string;
  evidence?: string;
  confidence: "high" | "medium" | "low";
  cwe?: string;
  owasp?: string;
}

interface SecuritySummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
  secrets: number;
  xss: number;
  injection: number;
  unsafeCode: number;
  storage: number;
  network: number;
  crypto: number;
  logging: number;
  configuration: number;
  other: number;
}

interface SecurityReport {
  success: boolean;
  tool: "analyze_security";
  projectPath: string;
  totalFindings: number;
  findings: SecurityFinding[];
  summary: SecuritySummary;
  warnings: string[];
}

interface AnalyzeSecurityProps {
  projectPath: string;
  onProjectPathChange?: (value: string) => void;
}

function severityIcon(severity: SecuritySeverity) {
  if (severity === "critical") return <XCircle size={17} />;
  if (severity === "high") return <ShieldAlert size={17} />;
  if (severity === "medium") return <AlertTriangle size={17} />;
  return <Shield size={17} />;
}

function categoryLabel(category: SecurityCategory): string {
  return category
    .replace(/-/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const SEVERITY_OPTIONS: {
  value: "all" | SecuritySeverity;
  label: string;
}[] = [
  { value: "all", label: "All severities" },
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "info", label: "Info" },
];

const CATEGORY_OPTIONS: {
  value: "all" | SecurityCategory;
  label: string;
}[] = [
  { value: "all", label: "All categories" },
  { value: "secrets", label: "Secrets" },
  { value: "xss", label: "XSS" },
  { value: "injection", label: "Injection" },
  { value: "unsafe-code", label: "Unsafe Code" },
  { value: "storage", label: "Storage" },
  { value: "network", label: "Network" },
  { value: "crypto", label: "Cryptography" },
  { value: "logging", label: "Logging" },
  { value: "configuration", label: "Configuration" },
  { value: "other", label: "Other" },
];

export default function AnalyzeSecurity({
  projectPath,
  onProjectPathChange,
}: AnalyzeSecurityProps) {
  const [report, setReport] = useState<SecurityReport | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [severity, setSeverity] =
    useState<"all" | SecuritySeverity>("all");
  const [category, setCategory] =
    useState<"all" | SecurityCategory>("all");
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
      const response = await fetch(
        "http://127.0.0.1:4174/api/analyze-security",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            projectPath: projectPath.trim(),
          }),
        }
      );

      const data = await response.json();

      if (!response.ok || data.success === false) {
        throw new Error(
          data.error || "Security analysis failed."
        );
      }

      const nextReport = data as SecurityReport;
      setReport(nextReport);
      setSelectedFindingId(
        nextReport.findings[0]?.id || null
      );
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

  const filteredFindings = useMemo(() => {
    if (!report) return [];

    const query = search.trim().toLowerCase();

    return report.findings.filter((finding) => {
      const matchesSearch =
        !query ||
        [
          finding.title,
          finding.description,
          finding.filePath,
          finding.category,
          finding.expression,
          finding.evidence || "",
        ]
          .join(" ")
          .toLowerCase()
          .includes(query);

      return (
        matchesSearch &&
        (severity === "all" ||
          finding.severity === severity) &&
        (category === "all" ||
          finding.category === category)
      );
    });
  }, [report, search, severity, category]);

  const severityOptions = useMemo<
    SecuritySelectOption<"all" | SecuritySeverity>[]
  >(
    () =>
      SEVERITY_OPTIONS.map((option) => ({
        ...option,
        tone: option.value === "all" ? undefined : option.value,
        count: report
          ? option.value === "all"
            ? report.findings.length
            : report.summary[option.value]
          : undefined,
      })),
    [report]
  );

  const categoryOptions = useMemo<
    SecuritySelectOption<"all" | SecurityCategory>[]
  >(() => {
    if (!report) return CATEGORY_OPTIONS;

    const counts: Record<string, number> = {};
    for (const finding of report.findings) {
      counts[finding.category] = (counts[finding.category] || 0) + 1;
    }

    return CATEGORY_OPTIONS.map((option) => ({
      ...option,
      count:
        option.value === "all"
          ? report.findings.length
          : counts[option.value] || 0,
    }));
  }, [report]);

  const selectedFinding =
    filteredFindings.find(
      (finding) => finding.id === selectedFindingId
    ) ||
    filteredFindings[0] ||
    null;

  return (
    <div className="security-analyzer">
      <div className="security-title-row">
        <div className="security-title-icon">
          <ShieldCheck size={24} />
        </div>

        <div>
          <h1>Security &amp; Vulnerability Analyzer</h1>
          <p>
            Find potentially insecure patterns, exposed secrets,
            injection risks, and security misconfigurations.
          </p>
        </div>
      </div>

      <section className="security-input-card">
        <div className="security-field">
          <label>Project path</label>
          <input
            value={projectPath}
            onChange={(event) =>
              onProjectPathChange?.(event.target.value)
            }
            placeholder="/path/to/your/project"
          />
        </div>

        <button
          type="button"
          className="security-analyze-button"
          onClick={analyze}
          disabled={loading}
        >
          {loading ? (
            <>
              <span className="security-spinner" />
              Analyzing...
            </>
          ) : (
            <>
              <Shield size={17} />
              Analyze Security
            </>
          )}
        </button>
      </section>

      {error && (
        <div className="security-error">
          <XCircle size={18} />
          {error}
        </div>
      )}

      {report && (
        <>
          <div className="security-status-row">
            <div className="security-success">
              <CheckCircle2 size={18} />
              <strong>{report.totalFindings}</strong>
              <span>findings discovered</span>
            </div>

            <span className="security-scope">
              Project-wide analysis
            </span>
          </div>

          <div className="security-summary-grid">
            {(
              [
                ["critical", "Critical", report.summary.critical],
                ["high", "High", report.summary.high],
                ["medium", "Medium", report.summary.medium],
                ["low", "Low", report.summary.low],
              ] as const
            ).map(([key, label, count]) => (
              <button
                type="button"
                key={key}
                className={`security-summary-card security-${key}`}
                onClick={() =>
                  setSeverity(
                    severity === key ? "all" : key
                  )
                }
              >
                <div className="security-summary-icon">
                  {severityIcon(key)}
                </div>

                <div>
                  <strong>{count}</strong>
                  <span>{label}</span>
                </div>
              </button>
            ))}
          </div>

          <section className="security-workspace">
            <div className="security-findings-panel">
              <div className="security-panel-header">
                <div>
                  <h2>Security Findings</h2>
                  <p>
                    {filteredFindings.length} of{" "}
                    {report.findings.length} findings
                  </p>
                </div>

                <div className="security-finding-count">
                  <Shield size={15} />
                  {filteredFindings.length}
                </div>
              </div>

              <div className="security-filters">
                <div className="security-search">
                  <Search size={17} />
                  <input
                    value={search}
                    onChange={(event) =>
                      setSearch(event.target.value)
                    }
                    placeholder="Search findings, files, categories..."
                  />
                </div>

                <SecuritySelect
                  ariaLabel="Filter by severity"
                  value={severity}
                  options={severityOptions}
                  onChange={setSeverity}
                />

                <SecuritySelect
                  ariaLabel="Filter by category"
                  value={category}
                  options={categoryOptions}
                  onChange={setCategory}
                />
              </div>

              <div className="security-findings-list">
                {filteredFindings.length === 0 ? (
                  <div className="security-empty">
                    <ShieldCheck size={34} />
                    <h3>No findings</h3>
                    <p>
                      No findings match the current filters.
                    </p>
                  </div>
                ) : (
                  filteredFindings.map((finding) => (
                    <button
                      type="button"
                      key={finding.id}
                      className={`security-finding ${
                        selectedFinding?.id === finding.id
                          ? "selected"
                          : ""
                      }`}
                      onClick={() =>
                        setSelectedFindingId(finding.id)
                      }
                    >
                      <div
                        className={`security-finding-icon security-${finding.severity}`}
                      >
                        {severityIcon(finding.severity)}
                      </div>

                      <div className="security-finding-content">
                        <div className="security-finding-top">
                          <span
                            className={`security-badge security-badge-${finding.severity}`}
                          >
                            {finding.severity}
                          </span>

                          <span className="security-category-badge">
                            {categoryLabel(finding.category)}
                          </span>
                        </div>

                        <h3>{finding.title}</h3>

                        <p>{finding.description}</p>

                        <div className="security-location">
                          <FileCode2 size={13} />
                          <span>{finding.filePath}</span>
                          <span>
                            line {finding.line}:{finding.column}
                          </span>
                        </div>
                      </div>

                      <div className="security-finding-arrow">
                        <ChevronDown size={16} />
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>

            <aside className="security-inspector">
              <div className="security-panel-header">
                <div>
                  <h2>Inspector</h2>
                  <p>
                    Details for the selected security finding
                  </p>
                </div>
              </div>

              {selectedFinding ? (
                <div className="security-inspector-body">
                  <div className="security-inspector-title">
                    <div
                      className={`security-inspector-icon security-${selectedFinding.severity}`}
                    >
                      {severityIcon(selectedFinding.severity)}
                    </div>

                    <div>
                      <span
                        className={`security-badge security-badge-${selectedFinding.severity}`}
                      >
                        {selectedFinding.severity}
                      </span>

                      <h3>{selectedFinding.title}</h3>
                    </div>
                  </div>

                  <div className="security-detail-grid">
                    <div>
                      <span>Category</span>
                      <strong>
                        {categoryLabel(selectedFinding.category)}
                      </strong>
                    </div>

                    <div>
                      <span>Confidence</span>
                      <strong>
                        {selectedFinding.confidence}
                      </strong>
                    </div>

                    <div>
                      <span>File</span>
                      <strong>{selectedFinding.filePath}</strong>
                    </div>

                    <div>
                      <span>Location</span>
                      <strong>
                        {selectedFinding.line}:
                        {selectedFinding.column}
                      </strong>
                    </div>
                  </div>

                  <section className="security-detail-box">
                    <h4>Description</h4>
                    <p>{selectedFinding.description}</p>
                  </section>

                  <section className="security-detail-box security-recommendation">
                    <h4>Recommended fix</h4>
                    <p>{selectedFinding.recommendation}</p>
                  </section>

                  <section className="security-detail-box">
                    <h4>Source expression</h4>
                    <pre>{selectedFinding.expression}</pre>
                  </section>

                  {selectedFinding.evidence && (
                    <section className="security-detail-box">
                      <h4>Evidence</h4>
                      <pre>{selectedFinding.evidence}</pre>
                    </section>
                  )}

                  <div className="security-reference-row">
                    {selectedFinding.cwe && (
                      <span>{selectedFinding.cwe}</span>
                    )}
                    {selectedFinding.owasp && (
                      <span>{selectedFinding.owasp}</span>
                    )}
                  </div>
                </div>
              ) : (
                <div className="security-inspector-empty">
                  <Shield size={38} />
                  <h3>Select a finding</h3>
                  <p>
                    Choose a security finding from the list to
                    inspect its source location and recommended
                    remediation.
                  </p>
                </div>
              )}
            </aside>
          </section>

          <section className="security-analysis-notes">
            <AlertTriangle size={18} />
            <div>
              <h3>Analysis notes</h3>
              {report.warnings.map((warning, index) => (
                <p key={`${index}-${warning}`}>• {warning}</p>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}