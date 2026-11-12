import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  EyeOff,
  FileCode2,
  GitCommit,
  Key,
  Lock,
  Search,
  ShieldAlert,
  Wrench,
  XCircle,
} from "lucide-react";
import SecuritySelect from "../security/SecuritySelect";
import "./detect-secrets.css";

type Severity = "critical" | "high" | "medium" | "low" | "info";
type Confidence = "high" | "medium" | "low";
type Sensitivity = "strict" | "balanced" | "thorough";
type Exposure = "committed" | "untracked" | "ignored" | "unknown";

type SecretCategory =
  | "provider-key"
  | "token"
  | "credential"
  | "private-key"
  | "generic"
  | "sensitive-file";

interface SecretLocation {
  filePath: string;
  line: number;
  lineText: string;
  exposure: Exposure;
  severity: Severity;
  isTest: boolean;
  isDoc: boolean;
  isEnvFile: boolean;
}

interface SecretRemediation {
  title: string;
  summary: string;
  steps: string[];
  code?: string;
  caveats: string[];
}

interface SecretFinding {
  id: string;
  ruleId: string;
  name: string;
  provider?: string;
  category: SecretCategory;
  severity: Severity;
  confidence: Confidence;
  masked: string;
  length: number;
  entropy: number;
  description: string;
  note?: string;
  exposure: Exposure;
  committed: boolean;
  locations: SecretLocation[];
  hiddenLocations: number;
  locationCount: number;
  fileCount: number;
  remediation: SecretRemediation;
}

interface FileHotspot {
  filePath: string;
  count: number;
  topSeverity: Severity;
  committed: boolean;
}

interface Safeguards {
  gitRepository: boolean;
  envFilesIgnored: boolean;
  preCommitScanner: boolean;
  ciScanner: boolean;
}

interface SecretReport {
  success: boolean;
  tool: "detect_secrets";
  projectPath: string;
  filePath?: string;
  sensitivity: Sensitivity;
  includeTests: boolean;
  redacted: true;
  filesScanned: number;
  filesSkipped: number;
  bytesScanned: number;
  gitDetected: boolean;
  gitTrackingKnown: boolean;
  totalSecrets: number;
  totalLocations: number;
  committedCount: number;
  criticalHighCount: number;
  sensitiveFileCount: number;
  safeSensitiveFiles: number;
  summary: Record<Severity, number>;
  categoryCounts: Record<SecretCategory, number>;
  findings: SecretFinding[];
  hotspots: FileHotspot[];
  safeguards: Safeguards;
  warnings: string[];
}

interface DetectSecretsProps {
  projectPath: string;
  onProjectPathChange?: (value: string) => void;
  apiUrl?: string;
}

type TypeFilter = "all" | "provider" | "credential" | "keys" | "generic";
type FocusFilter = "all" | "critical" | "committed" | "files";
type SortKey = "severity" | "confidence" | "locations" | "name";

const DEFAULT_API_URL = "http://127.0.0.1:4174/api/detect-secrets";

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];
const CONFIDENCE_ORDER: Confidence[] = ["high", "medium", "low"];

const CATEGORY_LABEL: Record<SecretCategory, string> = {
  "provider-key": "Provider key",
  token: "Token",
  credential: "Credential",
  "private-key": "Private key",
  generic: "Generic",
  "sensitive-file": "Sensitive file",
};

const TYPE_FILTER_LABEL: Record<TypeFilter, string> = {
  all: "All",
  provider: "Provider keys",
  credential: "Credentials",
  keys: "Keys & files",
  generic: "Generic",
};

const TYPE_FILTER_CATEGORIES: Record<
  Exclude<TypeFilter, "all">,
  SecretCategory[]
> = {
  provider: ["provider-key"],
  credential: ["credential", "token"],
  keys: ["private-key", "sensitive-file"],
  generic: ["generic"],
};

const EXPOSURE_LABEL: Record<Exposure, string> = {
  committed: "Committed to git",
  untracked: "Not ignored by git",
  ignored: "Git-ignored",
  unknown: "Git status unknown",
};

const EXPOSURE_SHORT: Record<Exposure, string> = {
  committed: "committed",
  untracked: "not ignored",
  ignored: "git-ignored",
  unknown: "git unknown",
};

const FOCUS_NOTE: Record<Exclude<FocusFilter, "all">, string> = {
  critical: "that are critical or high",
  committed: "committed to git",
  files: "that are sensitive files",
};

const SENSITIVITY_OPTIONS: Array<{ value: Sensitivity; label: string }> = [
  { value: "strict", label: "Strict: known providers only" },
  { value: "balanced", label: "Balanced: adds passwords and keywords" },
  { value: "thorough", label: "Thorough: adds random-looking strings" },
];

function baseName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1];
}

function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function findingIcon(finding: SecretFinding, size = 17) {
  return finding.category === "sensitive-file" ? (
    <Lock size={size} />
  ) : (
    <Key size={size} />
  );
}

/* -------------------------------------------------------------------------- */
/*  Where it appears                                                          */
/* -------------------------------------------------------------------------- */

function LocationList({ finding }: { finding: SecretFinding }) {
  return (
    <ul className="sd-locations">
      {finding.locations.map((location, index) => (
        <li key={`${location.filePath}:${location.line}:${index}`}>
          <div className="sd-location-head">
            <FileCode2 size={13} />
            <strong title={location.filePath}>
              {location.filePath}:{location.line}
            </strong>

            <span className="sd-location-flags">
              <span className={`sd-exposure sd-exposure-${location.exposure}`}>
                {EXPOSURE_SHORT[location.exposure]}
              </span>
              {location.isTest && <span className="sd-flag">test file</span>}
              {location.isDoc && <span className="sd-flag">docs</span>}
            </span>
          </div>

          <pre className="sd-line">{location.lineText}</pre>
        </li>
      ))}

      {finding.hiddenLocations > 0 && (
        <li className="sd-locations-more">
          +{finding.hiddenLocations} more{" "}
          {finding.hiddenLocations === 1 ? "location" : "locations"} not shown
        </li>
      )}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/*  How to fix                                                                */
/* -------------------------------------------------------------------------- */

function FixPanel({ finding }: { finding: SecretFinding }) {
  const [copied, setCopied] = useState<"" | "code" | "place">("");
  const [copyFailed, setCopyFailed] = useState(false);
  const { remediation } = finding;
  const first = finding.locations[0];

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
    <section className="sd-box sd-fix">
      <h4>
        <Wrench size={14} /> How to fix
      </h4>

      <p className="sd-refactor-title">{remediation.title}</p>
      <p>{remediation.summary}</p>

      <ol className="sd-steps">
        {remediation.steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>

      {remediation.code && (
        <pre className="sd-code-block">
          <code>{remediation.code}</code>
        </pre>
      )}

      <div className="sd-actions">
        {remediation.code && (
          <button
            type="button"
            onClick={() => copy("code", remediation.code!)}
          >
            {copied === "code" ? <Check size={14} /> : <Copy size={14} />}
            {copied === "code" ? "Copied" : "Copy example"}
          </button>
        )}

        {first && (
          <button
            type="button"
            onClick={() => copy("place", `${first.filePath}:${first.line}`)}
          >
            {copied === "place" ? <Check size={14} /> : <Copy size={14} />}
            {copied === "place" ? "Copied" : "Copy location"}
          </button>
        )}
      </div>

      {copyFailed && (
        <p className="sd-fine-print">
          The browser blocked clipboard access. Select the text and copy it
          manually.
        </p>
      )}

      {remediation.caveats.length > 0 && (
        <ul className="sd-caveats">
          {remediation.caveats.map((caveat, index) => (
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

export default function DetectSecrets({
  projectPath,
  onProjectPathChange,
  apiUrl = DEFAULT_API_URL,
}: DetectSecretsProps) {
  const [focusFile, setFocusFile] = useState("");
  const [sensitivity, setSensitivity] = useState<Sensitivity>("balanced");
  const [includeTests, setIncludeTests] = useState(true);

  const [report, setReport] = useState<SecretReport | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [focus, setFocus] = useState<FocusFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("severity");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function analyze() {
    if (!projectPath.trim()) {
      setError("Enter a project path before starting the scan.");
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
          sensitivity,
          includeTests,
        }),
      });

      const data = await response.json();

      if (!response.ok || data.success === false) {
        throw new Error(data.error || "Secret scan failed.");
      }

      const nextReport = data as SecretReport;
      setReport(nextReport);
      setSelectedId(nextReport.findings[0]?.id ?? null);
      setSearch("");
      setTypeFilter("all");
      setFocus("all");
      setSortKey("severity");
    } catch (analysisError) {
      setError(
        analysisError instanceof Error
          ? analysisError.message
          : "Unable to scan the project."
      );
    } finally {
      setLoading(false);
    }
  }

  const visibleFindings = useMemo(() => {
    if (!report) return [];

    const query = search.trim().toLowerCase();

    const filtered = report.findings.filter((finding) => {
      if (
        typeFilter !== "all" &&
        !TYPE_FILTER_CATEGORIES[typeFilter].includes(finding.category)
      ) {
        return false;
      }

      if (
        focus === "critical" &&
        finding.severity !== "critical" &&
        finding.severity !== "high"
      ) {
        return false;
      }
      if (focus === "committed" && !finding.committed) return false;
      if (focus === "files" && finding.category !== "sensitive-file") {
        return false;
      }

      if (!query) return true;

      return [
        finding.name,
        finding.provider ?? "",
        finding.masked,
        CATEGORY_LABEL[finding.category],
        ...finding.locations.map((location) => location.filePath),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

    return [...filtered].sort((a, b) => {
      if (sortKey === "confidence") {
        return (
          CONFIDENCE_ORDER.indexOf(a.confidence) -
            CONFIDENCE_ORDER.indexOf(b.confidence) ||
          SEVERITY_ORDER.indexOf(a.severity) -
            SEVERITY_ORDER.indexOf(b.severity)
        );
      }
      if (sortKey === "locations") {
        return (
          b.locationCount - a.locationCount ||
          SEVERITY_ORDER.indexOf(a.severity) -
            SEVERITY_ORDER.indexOf(b.severity)
        );
      }
      if (sortKey === "name") return a.name.localeCompare(b.name);
      return (
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
      );
    });
  }, [report, search, typeFilter, focus, sortKey]);

  const selected =
    visibleFindings.find((finding) => finding.id === selectedId) ??
    visibleFindings[0] ??
    null;

  function toggleFocus(next: Exclude<FocusFilter, "all">) {
    setFocus(focus === next ? "all" : next);
  }

  return (
    <div className="sd-analyzer">
      <div className="sd-title-row">
        <div className="sd-title-icon">
          <ShieldAlert size={24} />
        </div>

        <div>
          <h1>Secret Detector</h1>
          <p>
            Find API keys, passwords, tokens, and private keys left in your
            project, see whether git already has them, and get the steps to
            rotate and remove each one.
          </p>
        </div>
      </div>

      <section className="sd-input-card">
        <div className="sd-field sd-field-wide">
          <label htmlFor="sd-project-path">Project path</label>
          <input
            id="sd-project-path"
            value={projectPath}
            onChange={(event) => onProjectPathChange?.(event.target.value)}
            placeholder="/path/to/your/project"
          />
        </div>

        <div className="sd-field">
          <label htmlFor="sd-focus-file">Focus file or folder (optional)</label>
          <input
            id="sd-focus-file"
            value={focusFile}
            onChange={(event) => setFocusFile(event.target.value)}
            placeholder="src/config"
          />
        </div>

        <button
          type="button"
          className="sd-analyze-button"
          onClick={analyze}
          disabled={loading}
        >
          {loading ? (
            <>
              <span className="sd-spinner" />
              Scanning...
            </>
          ) : (
            <>
              <ShieldAlert size={17} />
              Scan for Secrets
            </>
          )}
        </button>

        <div className="sd-options">
          <div className="sd-field">
            <span className="sd-field-label">Sensitivity</span>
            <SecuritySelect
              ariaLabel="Scan sensitivity"
              value={sensitivity}
              onChange={setSensitivity}
              options={SENSITIVITY_OPTIONS}
            />
          </div>

          <label className="sd-check">
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
        <div className="sd-error" role="alert">
          <XCircle size={18} />
          {error}
        </div>
      )}

      {report && (
        <>
          <div className="sd-status-row">
            <div
              className={`sd-success ${
                report.totalSecrets === 0 ? "" : "has-groups"
              }`}
            >
              {report.totalSecrets === 0 ? (
                <CheckCircle2 size={18} />
              ) : (
                <AlertTriangle size={18} />
              )}
              <strong>{report.totalSecrets}</strong>
              <span>
                {report.totalSecrets === 1
                  ? "potential secret found"
                  : "potential secrets found"}
                {report.totalSecrets > 0
                  ? ` in ${plural(report.totalLocations, "place")}`
                  : ""}
              </span>
            </div>

            <span className="sd-scope">
              {report.filesScanned} files scanned ·{" "}
              {formatBytes(report.bytesScanned)} ·{" "}
              {report.gitDetected ? "git repository found" : "no git repository"}
            </span>
          </div>

          <div className="sd-summary-grid">
            <div className="sd-summary-card static">
              <div className="sd-summary-icon tone-total">
                <Key size={17} />
              </div>
              <div>
                <strong>{report.totalSecrets}</strong>
                <span>
                  Secrets found · {plural(report.totalLocations, "location")}
                </span>
              </div>
            </div>

            <button
              type="button"
              className={`sd-summary-card ${focus === "critical" ? "active" : ""}`}
              onClick={() => toggleFocus("critical")}
              aria-pressed={focus === "critical"}
            >
              <div className="sd-summary-icon tone-critical">
                <ShieldAlert size={17} />
              </div>
              <div>
                <strong>{report.criticalHighCount}</strong>
                <span>
                  Critical and high · {report.summary.critical} critical
                </span>
              </div>
            </button>

            <button
              type="button"
              className={`sd-summary-card ${focus === "committed" ? "active" : ""}`}
              onClick={() => toggleFocus("committed")}
              aria-pressed={focus === "committed"}
            >
              <div className="sd-summary-icon tone-committed">
                <GitCommit size={17} />
              </div>
              <div>
                <strong>{report.committedCount}</strong>
                <span>
                  {report.gitTrackingKnown
                    ? "Committed to git"
                    : "Committed to git (not confirmed)"}
                </span>
              </div>
            </button>

            <button
              type="button"
              className={`sd-summary-card ${focus === "files" ? "active" : ""}`}
              onClick={() => toggleFocus("files")}
              aria-pressed={focus === "files"}
            >
              <div className="sd-summary-icon tone-files">
                <Lock size={17} />
              </div>
              <div>
                <strong>{report.sensitiveFileCount}</strong>
                <span>Sensitive files not ignored</span>
              </div>
            </button>
          </div>

          {report.totalSecrets === 0 ? (
            <section className="sd-clean">
              <CheckCircle2 size={38} />
              <h3>No secrets found</h3>
              <p>
                {report.filesScanned} files were scanned at{" "}
                {report.sensitivity} sensitivity
                {report.safeSensitiveFiles > 0
                  ? `, and ${plural(report.safeSensitiveFiles, "sensitive file")} ${
                      report.safeSensitiveFiles === 1 ? "is" : "are"
                    } correctly ignored by git`
                  : ""}
                .{" "}
                {report.sensitivity !== "thorough"
                  ? "Try Thorough sensitivity to also check random-looking strings."
                  : ""}
              </p>
            </section>
          ) : (
            <section className="sd-workspace">
              <div className="sd-groups-panel">
                <div className="sd-panel-header">
                  <div>
                    <h2>Findings</h2>
                    <p>
                      {visibleFindings.length} of {report.findings.length}{" "}
                      findings
                      {focus !== "all" ? ` ${FOCUS_NOTE[focus]}` : ""}
                    </p>
                  </div>

                  <div className="sd-count-pill">
                    <Key size={15} />
                    {visibleFindings.length}
                  </div>
                </div>

                <div className="sd-filters">
                  <div className="sd-search">
                    <Search size={17} />
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search by type, provider, or file..."
                      aria-label="Search findings"
                    />
                  </div>

                  <div className="sd-filter-row">
                    <div
                      className="sd-type-filter"
                      role="group"
                      aria-label="Filter by secret type"
                    >
                      {(Object.keys(TYPE_FILTER_LABEL) as TypeFilter[]).map(
                        (option) => (
                          <button
                            type="button"
                            key={option}
                            className={typeFilter === option ? "active" : ""}
                            aria-pressed={typeFilter === option}
                            onClick={() => setTypeFilter(option)}
                          >
                            {TYPE_FILTER_LABEL[option]}
                          </button>
                        )
                      )}
                    </div>

                    <div className="sd-sort">
                      <SecuritySelect
                        ariaLabel="Sort findings"
                        value={sortKey}
                        onChange={setSortKey}
                        options={[
                          { value: "severity", label: "Sort: severity" },
                          { value: "confidence", label: "Sort: confidence" },
                          { value: "locations", label: "Sort: locations" },
                          { value: "name", label: "Sort: name" },
                        ]}
                      />
                    </div>
                  </div>
                </div>

                <div className="sd-groups-list">
                  {visibleFindings.length === 0 ? (
                    <div className="sd-empty">
                      <Key size={34} />
                      <h3>No matching findings</h3>
                      <p>No findings match the current filters.</p>
                    </div>
                  ) : (
                    visibleFindings.map((finding) => (
                      <button
                        type="button"
                        key={finding.id}
                        className={`sd-group ${
                          selected?.id === finding.id ? "selected" : ""
                        }`}
                        onClick={() => setSelectedId(finding.id)}
                      >
                        <div
                          className={`sd-group-icon sd-severity-${finding.severity}`}
                        >
                          {findingIcon(finding)}
                        </div>

                        <div className="sd-group-content">
                          <div className="sd-group-top">
                            <span
                              className={`sd-badge sd-badge-${finding.severity}`}
                            >
                              {finding.severity}
                            </span>
                            <span
                              className={`sd-confidence sd-confidence-${finding.confidence}`}
                            >
                              {finding.confidence} confidence
                            </span>
                            <span
                              className={`sd-exposure sd-exposure-${finding.exposure}`}
                            >
                              {EXPOSURE_SHORT[finding.exposure]}
                            </span>
                          </div>

                          <h3>{finding.name}</h3>

                          {finding.length > 0 && (
                            <code className="sd-mask sd-mask-inline">
                              {finding.masked}
                            </code>
                          )}

                          <p className="sd-places">
                            {finding.locations[0].filePath}:
                            {finding.locations[0].line}
                            {finding.locationCount > 1 &&
                              ` · +${finding.locationCount - 1} more`}
                          </p>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>

              <aside className="sd-inspector">
                <div className="sd-panel-header">
                  <div>
                    <h2>Inspector</h2>
                    <p>Where it is, how exposed it is, and how to fix it</p>
                  </div>
                </div>

                {selected ? (
                  <div className="sd-inspector-body">
                    <div className="sd-inspector-title">
                      <div
                        className={`sd-inspector-icon sd-severity-${selected.severity}`}
                      >
                        {findingIcon(selected, 20)}
                      </div>

                      <div>
                        <span
                          className={`sd-badge sd-badge-${selected.severity}`}
                        >
                          {selected.severity}
                        </span>
                        <h3>{selected.name}</h3>
                      </div>
                    </div>

                    <div className="sd-detail-grid">
                      <div>
                        <span>Type</span>
                        <strong>
                          {selected.provider
                            ? `${selected.provider} · ${CATEGORY_LABEL[selected.category]}`
                            : CATEGORY_LABEL[selected.category]}
                        </strong>
                      </div>
                      <div>
                        <span>Confidence</span>
                        <strong>{selected.confidence}</strong>
                      </div>
                      <div>
                        <span>Found in</span>
                        <strong>
                          {plural(selected.locationCount, "place")},{" "}
                          {plural(selected.fileCount, "file")}
                        </strong>
                      </div>
                      <div>
                        <span>Git exposure</span>
                        <strong>{EXPOSURE_LABEL[selected.exposure]}</strong>
                      </div>
                    </div>

                    <section className="sd-box">
                      <h4>{selected.length > 0 ? "Redacted value" : "File"}</h4>

                      {selected.length > 0 ? (
                        <>
                          <code className="sd-mask">{selected.masked}</code>
                          <p className="sd-mask-meta">
                            {selected.length} characters · entropy{" "}
                            {selected.entropy} bits per character
                          </p>
                          <p className="sd-privacy">
                            <EyeOff size={13} />
                            The full value is never shown here and is never
                            sent to this page.
                          </p>
                        </>
                      ) : (
                        <code className="sd-mask">
                          {selected.locations[0].filePath}
                        </code>
                      )}
                    </section>

                    <section className="sd-box">
                      <h4>Why this was flagged</h4>
                      <p>{selected.description}</p>
                      {selected.note && (
                        <p className="sd-note">{selected.note}</p>
                      )}
                    </section>

                    <section className="sd-box">
                      <h4>Where it appears</h4>
                      <LocationList finding={selected} />
                    </section>

                    <FixPanel
                      key={`fix-${selected.id}`}
                      finding={selected}
                    />
                  </div>
                ) : (
                  <div className="sd-inspector-empty">
                    <Key size={38} />
                    <h3>Select a finding</h3>
                    <p>
                      Choose a finding from the list to see where it appears,
                      how exposed it is, and how to fix it.
                    </p>
                  </div>
                )}
              </aside>
            </section>
          )}

          <section className="sd-safeguards">
            <div className="sd-panel-header">
              <div>
                <h2>Safeguards</h2>
                <p>Protections that stop the next secret from being committed</p>
              </div>
            </div>

            <ul>
              <li className={report.safeguards.gitRepository ? "ok" : "missing"}>
                {report.safeguards.gitRepository ? (
                  <CheckCircle2 size={16} />
                ) : (
                  <XCircle size={16} />
                )}
                <span>
                  {report.safeguards.gitRepository
                    ? "Git repository found, so exposure is checked against what is committed."
                    : "No git repository found, so exposure cannot be checked."}
                </span>
              </li>
              <li
                className={report.safeguards.envFilesIgnored ? "ok" : "missing"}
              >
                {report.safeguards.envFilesIgnored ? (
                  <CheckCircle2 size={16} />
                ) : (
                  <XCircle size={16} />
                )}
                <span>
                  {report.safeguards.envFilesIgnored
                    ? ".env files are ignored by .gitignore."
                    : ".env files are not covered by .gitignore."}
                </span>
              </li>
              <li
                className={report.safeguards.preCommitScanner ? "ok" : "missing"}
              >
                {report.safeguards.preCommitScanner ? (
                  <CheckCircle2 size={16} />
                ) : (
                  <XCircle size={16} />
                )}
                <span>
                  {report.safeguards.preCommitScanner
                    ? "A secret scanner runs before commits."
                    : "No secret scanner runs before commits (for example gitleaks or detect-secrets in a pre-commit hook)."}
                </span>
              </li>
              <li className={report.safeguards.ciScanner ? "ok" : "missing"}>
                {report.safeguards.ciScanner ? (
                  <CheckCircle2 size={16} />
                ) : (
                  <XCircle size={16} />
                )}
                <span>
                  {report.safeguards.ciScanner
                    ? "A secret scanner runs in CI."
                    : "No secret scanner runs in CI."}
                </span>
              </li>
            </ul>
          </section>

          {report.hotspots.length > 0 && (
            <section className="sd-hotspots">
              <div className="sd-panel-header">
                <div>
                  <h2>Files with the most secrets</h2>
                  <p>Select a file to filter the findings.</p>
                </div>
              </div>

              <ul>
                {report.hotspots.map((file) => (
                  <li key={file.filePath}>
                    <button
                      type="button"
                      onClick={() => {
                        setSearch(file.filePath);
                        setTypeFilter("all");
                        setFocus("all");
                      }}
                    >
                      <FileCode2 size={14} />
                      <span title={file.filePath}>{baseName(file.filePath)}</span>
                      <em>
                        {file.committed ? "committed · " : ""}
                        {file.topSeverity}
                      </em>
                      <strong>{file.count}</strong>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {report.warnings.length > 0 && (
            <section className="sd-analysis-notes">
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
