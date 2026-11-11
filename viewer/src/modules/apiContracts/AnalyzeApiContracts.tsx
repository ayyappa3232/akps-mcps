import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  Braces,
  Check,
  CheckCircle2,
  Copy,
  FileCode2,
  Layers,
  Monitor,
  Search,
  Server,
  Wrench,
  XCircle,
} from "lucide-react";
import SecuritySelect from "../security/SecuritySelect";
import "./analyze-api-contracts.css";

type ContractSeverity = "critical" | "high" | "medium" | "low" | "info";
type IssueGroup = "mismatch" | "unused" | "route";
type EvidenceRole = "frontend" | "backend";

type IssueKind =
  | "method-mismatch"
  | "missing-endpoint"
  | "missing-body"
  | "missing-body-field"
  | "extra-body-field"
  | "missing-query-param"
  | "extra-query-param"
  | "response-field-mismatch"
  | "unused-endpoint"
  | "duplicate-route"
  | "route-shadowed";

type FixStrategy =
  | "update-client-call"
  | "add-backend-route"
  | "update-client-payload"
  | "update-backend-handler"
  | "align-response"
  | "reorder-routes"
  | "remove-duplicate-route"
  | "remove-or-document";

interface ContractEvidence {
  role: EvidenceRole;
  label: string;
  filePath: string;
  startLine: number;
  endLine: number;
  fileLines: number;
  symbol?: string;
  snippet: string;
  snippetTruncated: boolean;
  highlightLines: number[];
}

interface FieldRow {
  name: string;
  client: boolean;
  server: boolean;
  required?: boolean;
  status: "match" | "missing-on-server" | "missing-on-client" | "optional";
}

interface FieldComparison {
  area: "body" | "query" | "response";
  clientLabel: string;
  serverLabel: string;
  rows: FieldRow[];
}

interface ContractSuggestion {
  strategy: FixStrategy;
  confidence: "high" | "medium" | "low";
  title: string;
  summary: string;
  steps: string[];
  patch?: string;
  suggestedPath?: string;
  caveats: string[];
}

interface ContractIssue {
  id: string;
  kind: IssueKind;
  group: IssueGroup;
  severity: ContractSeverity;
  score: number;
  method: string;
  path: string;
  title: string;
  description: string;
  recommendation: string;
  callCount: number;
  evidence: ContractEvidence[];
  comparison?: FieldComparison;
  suggestion: ContractSuggestion;
}

interface ApiEndpointSummary {
  id: string;
  method: string;
  path: string;
  framework: string;
  filePath: string;
  line: number;
  symbol?: string;
  handlerResolved: boolean;
  callers: number;
  bodyFields: string[];
  queryFields: string[];
  responseFields: string[];
  mountConfirmed: boolean;
  issueCount: number;
}

interface ContractHotspot {
  filePath: string;
  issueCount: number;
  role: "frontend" | "backend" | "both";
  worstSeverity: ContractSeverity;
}

interface ApiContractReport {
  success: boolean;
  tool: "analyze_api_contracts";
  projectPath: string;
  filePath?: string;
  includeTests: boolean;
  includeUnused: boolean;
  pathPrefix?: string;
  filesScanned: number;
  totalLines: number;
  frameworks: string[];
  endpointCount: number;
  callCount: number;
  matchedCalls: number;
  externalCalls: number;
  unresolvedCalls: number;
  unverifiableCalls: number;
  unusedEndpoints: number;
  coveragePercentage: number;
  totalIssues: number;
  projectIssueCount: number;
  mismatchIssues: number;
  unusedIssues: number;
  routeIssues: number;
  filesAffected: number;
  summary: Record<ContractSeverity, number>;
  issues: ContractIssue[];
  endpoints: ApiEndpointSummary[];
  hotspots: ContractHotspot[];
  warnings: string[];
}

interface AnalyzeApiContractsProps {
  projectPath: string;
  onProjectPathChange?: (value: string) => void;
  apiUrl?: string;
}

type TypeFilter = "all" | IssueGroup;
type KindFilter = "all" | IssueKind;
type SortKey = "impact" | "calls" | "file";

const DEFAULT_API_URL = "http://127.0.0.1:4174/api/analyze-api-contracts";
const SURFACE_PREVIEW = 12;

const GROUP_LABEL: Record<IssueGroup, string> = {
  mismatch: "Mismatches",
  unused: "Unused routes",
  route: "Route conflicts",
};

const KIND_LABEL: Record<IssueKind, string> = {
  "method-mismatch": "Wrong method",
  "missing-endpoint": "Missing route",
  "missing-body": "Missing body",
  "missing-body-field": "Missing body field",
  "extra-body-field": "Unread body field",
  "missing-query-param": "Missing query param",
  "extra-query-param": "Unread query param",
  "response-field-mismatch": "Response mismatch",
  "unused-endpoint": "Unused route",
  "duplicate-route": "Duplicate route",
  "route-shadowed": "Shadowed route",
};

const STRATEGY_LABEL: Record<FixStrategy, string> = {
  "update-client-call": "Fix client call",
  "add-backend-route": "Add route",
  "update-client-payload": "Fix client payload",
  "update-backend-handler": "Fix handler",
  "align-response": "Align response",
  "reorder-routes": "Reorder routes",
  "remove-duplicate-route": "Remove duplicate",
  "remove-or-document": "Remove or document",
};

const ROLE_LABEL: Record<EvidenceRole, string> = {
  frontend: "Client",
  backend: "Server",
};

function baseName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1];
}

/** Last folder plus file name, e.g. "components/Users.tsx". */
function shortPath(filePath: string): string {
  return filePath.split("/").slice(-2).join("/");
}

function placeLabel(evidence: ContractEvidence): string {
  return `${baseName(evidence.filePath)}:${evidence.startLine}`;
}

function kindIcon(kind: IssueKind, size = 17) {
  switch (kind) {
    case "method-mismatch":
      return <ArrowLeftRight size={size} />;
    case "missing-endpoint":
      return <XCircle size={size} />;
    case "unused-endpoint":
      return <Server size={size} />;
    case "duplicate-route":
    case "route-shadowed":
      return <Layers size={size} />;
    default:
      return <Braces size={size} />;
  }
}

function MethodBadge({ method }: { method: string }) {
  const name = method.toUpperCase();
  const known = ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(name);

  return (
    <span className={`apc-method ${known ? `apc-method-${name.toLowerCase()}` : ""}`}>
      {name === "UNKNOWN" ? "ANY" : name}
    </span>
  );
}

function RoleIcon({ role, size = 13 }: { role: EvidenceRole; size?: number }) {
  return role === "frontend" ? <Monitor size={size} /> : <Server size={size} />;
}

/* -------------------------------------------------------------------------- */
/*  Where the code lives                                                      */
/* -------------------------------------------------------------------------- */

function EvidenceMap({ issue }: { issue: ContractIssue }) {
  return (
    <ul className="apc-map">
      {issue.evidence.map((item, index) => {
        const total = Math.max(1, item.fileLines);
        const span = Math.max(1, item.endLine - item.startLine + 1);
        const left = ((item.startLine - 1) / total) * 100;
        const width = Math.max(2, (span / total) * 100);

        return (
          <li key={`${item.role}:${item.filePath}:${item.startLine}:${index}`}>
            <div className="apc-map-head">
              <span className="apc-map-index">{index + 1}</span>
              <span className={`apc-role apc-role-${item.role}`}>
                <RoleIcon role={item.role} size={11} />
                {ROLE_LABEL[item.role]}
              </span>
              <FileCode2 size={13} />
              <span className="apc-map-path" title={item.filePath}>
                {item.filePath}
              </span>
            </div>

            <div className="apc-map-meta">
              <span>
                lines {item.startLine}-{item.endLine}
              </span>
              {item.symbol && <span>in {item.symbol}</span>}
              <span>{item.label}</span>
            </div>

            <div
              className="apc-map-track"
              role="img"
              aria-label={`Lines ${item.startLine} to ${item.endLine} of ${item.fileLines}`}
            >
              <span
                className="apc-map-fill"
                style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/*  Client vs server comparison                                               */
/* -------------------------------------------------------------------------- */

function CodePane({
  role,
  items,
  selectedIndex,
  onSelect,
  emptyTitle,
  emptyText,
}: {
  role: EvidenceRole;
  items: ContractEvidence[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  emptyTitle: string;
  emptyText: string;
}) {
  const label = ROLE_LABEL[role];
  const item = items[selectedIndex];

  if (!item) {
    return (
      <div className="apc-pane">
        <div className="apc-pane-title">
          <span className={`apc-role apc-role-${role}`}>
            <RoleIcon role={role} size={11} />
            {label}
          </span>
        </div>
        <div className="apc-pane-empty">
          <strong>{emptyTitle}</strong>
          <span>{emptyText}</span>
        </div>
      </div>
    );
  }

  const lines = item.snippet.split("\n");
  const highlighted = new Set(item.highlightLines);
  const hidden = Math.max(0, item.endLine - item.startLine + 1 - lines.length);

  return (
    <div className="apc-pane">
      <div className="apc-pane-head">
        {items.length > 1 ? (
          <SecuritySelect
            ariaLabel={`${label} code`}
            value={String(selectedIndex)}
            onChange={(next) => onSelect(Number(next))}
            options={items.map((entry, index) => ({
              value: String(index),
              label: `${index + 1}. ${shortPath(entry.filePath)}:${entry.startLine}`,
            }))}
          />
        ) : (
          <div className="apc-pane-title" title={item.filePath}>
            <span className={`apc-role apc-role-${role}`}>
              <RoleIcon role={role} size={11} />
              {label}
            </span>
            <span>
              {shortPath(item.filePath)}:{item.startLine}
            </span>
          </div>
        )}
      </div>

      <div className="apc-code" role="region" aria-label={`${label} code`}>
        {lines.map((line, index) => {
          const number = item.startLine + index;

          return (
            <div
              key={index}
              className={`apc-code-line ${highlighted.has(number) ? "flagged" : ""}`}
            >
              <span className="apc-code-number">{number}</span>
              <code>{line || " "}</code>
            </div>
          );
        })}

        {(item.snippetTruncated || hidden > 0) && (
          <div className="apc-code-more">
            … {hidden > 0 ? `${hidden} more lines` : "more lines"} not shown
          </div>
        )}
      </div>
    </div>
  );
}

function CompareView({ issue }: { issue: ContractIssue }) {
  const frontend = issue.evidence.filter((item) => item.role === "frontend");
  const backend = issue.evidence.filter((item) => item.role === "backend");

  const [clientIndex, setClientIndex] = useState(0);
  const [serverIndex, setServerIndex] = useState(0);

  const flagged =
    (frontend[clientIndex]?.highlightLines.length ?? 0) +
    (backend[serverIndex]?.highlightLines.length ?? 0);

  return (
    <section className="apc-box">
      <div className="apc-compare-head">
        <h4>Client vs server</h4>
        <span className="apc-compare-note">
          {flagged > 0
            ? `${flagged} related ${flagged === 1 ? "line is" : "lines are"} highlighted.`
            : "Showing the code on each side."}
        </span>
      </div>

      <div className="apc-compare">
        <CodePane
          role="frontend"
          items={frontend}
          selectedIndex={Math.min(clientIndex, Math.max(0, frontend.length - 1))}
          onSelect={setClientIndex}
          emptyTitle="No client call found"
          emptyText="Nothing in this project calls this route."
        />
        <CodePane
          role="backend"
          items={backend}
          selectedIndex={Math.min(serverIndex, Math.max(0, backend.length - 1))}
          onSelect={setServerIndex}
          emptyTitle="No matching server route"
          emptyText="No backend route answers this method and path."
        />
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Field-by-field table                                                      */
/* -------------------------------------------------------------------------- */

const AREA_TITLE: Record<FieldComparison["area"], string> = {
  body: "Request body fields",
  query: "Query parameters",
  response: "Response fields",
};

function rowStatus(
  area: FieldComparison["area"],
  row: FieldRow
): { label: string; tone: "ok" | "bad" | "warn" | "neutral" } {
  if (row.status === "match") return { label: "Match", tone: "ok" };

  if (area === "response") {
    return row.status === "missing-on-server"
      ? { label: "Not returned", tone: "bad" }
      : { label: "Not used by client", tone: "neutral" };
  }

  if (row.status === "missing-on-client") return { label: "Not sent", tone: "bad" };
  if (row.status === "optional") return { label: "Optional", tone: "neutral" };
  return { label: "Ignored by server", tone: "warn" };
}

function Presence({ present, label }: { present: boolean; label: string }) {
  return present ? (
    <span className="apc-present" role="img" aria-label={`${label}: yes`}>
      <Check size={14} />
    </span>
  ) : (
    <span className="apc-absent" role="img" aria-label={`${label}: no`}>
      —
    </span>
  );
}

function FieldTable({ comparison }: { comparison: FieldComparison }) {
  return (
    <section className="apc-box">
      <h4>{AREA_TITLE[comparison.area]}</h4>

      <div className="apc-fields-wrap">
        <table className="apc-fields">
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">{comparison.clientLabel}</th>
              <th scope="col">{comparison.serverLabel}</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {comparison.rows.map((row) => {
              const status = rowStatus(comparison.area, row);

              return (
                <tr key={row.name}>
                  <td>
                    <code>{row.name}</code>
                    {row.server && row.required === false && (
                      <span className="apc-req">optional</span>
                    )}
                  </td>
                  <td>
                    <Presence present={row.client} label={comparison.clientLabel} />
                  </td>
                  <td>
                    <Presence present={row.server} label={comparison.serverLabel} />
                  </td>
                  <td>
                    <span className={`apc-chip apc-chip-${status.tone}`}>{status.label}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Suggested fix                                                             */
/* -------------------------------------------------------------------------- */

function PatchBlock({ patch }: { patch: string }) {
  return (
    <pre className="apc-patch" aria-label="Suggested code">
      {patch.split("\n").map((line, index) => {
        const tone = line.startsWith("+ ")
          ? "added"
          : line.startsWith("- ")
            ? "removed"
            : "";

        return (
          <code key={index} className={`apc-patch-line ${tone}`}>
            {line || " "}
          </code>
        );
      })}
    </pre>
  );
}

function FixPanel({ issue }: { issue: ContractIssue }) {
  const [copied, setCopied] = useState<"" | "patch" | "route">("");
  const [copyFailed, setCopyFailed] = useState(false);
  const suggestion = issue.suggestion;
  const route = `${issue.method === "UNKNOWN" ? "" : `${issue.method} `}${issue.path}`;

  async function copy(kind: "patch" | "route", value: string) {
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
    <section className="apc-box apc-refactor">
      <div className="apc-refactor-head">
        <h4>
          <Wrench size={14} /> Suggested fix
        </h4>

        <div className="apc-refactor-badges">
          <span className="apc-kind-badge">{STRATEGY_LABEL[suggestion.strategy]}</span>
          <span className={`apc-confidence apc-confidence-${suggestion.confidence}`}>
            {suggestion.confidence} confidence
          </span>
        </div>
      </div>

      <p className="apc-refactor-title">{suggestion.title}</p>
      <p>{suggestion.summary}</p>

      {suggestion.suggestedPath && (
        <dl className="apc-suggested">
          <div>
            <dt>File</dt>
            <dd title={suggestion.suggestedPath}>{suggestion.suggestedPath}</dd>
          </div>
        </dl>
      )}

      <ol className="apc-steps">
        {suggestion.steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>

      {suggestion.patch && (
        <>
          <p className="apc-patch-title">Suggested code</p>
          <PatchBlock patch={suggestion.patch} />
        </>
      )}

      <div className="apc-actions">
        {suggestion.patch && (
          <button type="button" onClick={() => copy("patch", suggestion.patch!)}>
            {copied === "patch" ? <Check size={14} /> : <Copy size={14} />}
            {copied === "patch" ? "Copied" : "Copy suggested code"}
          </button>
        )}

        <button type="button" onClick={() => copy("route", route)}>
          {copied === "route" ? <Check size={14} /> : <Copy size={14} />}
          {copied === "route" ? "Copied" : "Copy route"}
        </button>
      </div>

      {copyFailed && (
        <p className="apc-fine-print">
          The browser blocked clipboard access. Select the code above and copy it manually.
        </p>
      )}

      {suggestion.caveats.length > 0 && (
        <ul className="apc-caveats">
          {suggestion.caveats.map((caveat, index) => (
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

export default function AnalyzeApiContracts({
  projectPath,
  onProjectPathChange,
  apiUrl = DEFAULT_API_URL,
}: AnalyzeApiContractsProps) {
  const [focusFile, setFocusFile] = useState("");
  const [pathPrefix, setPathPrefix] = useState("");
  const [includeUnused, setIncludeUnused] = useState(true);
  const [includeTests, setIncludeTests] = useState(false);

  const [report, setReport] = useState<ApiContractReport | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("impact");
  const [showAllRoutes, setShowAllRoutes] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function analyze() {
    if (!projectPath.trim()) {
      setError("Enter a project path before starting the analysis.");
      return;
    }

    const prefix = pathPrefix.trim();

    if (prefix && !/^\/?[A-Za-z0-9._~\-/:]*$/.test(prefix)) {
      setError("Client path prefix may only contain letters, numbers, and / . _ ~ - :");
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
          pathPrefix: prefix || undefined,
          includeUnused,
          includeTests,
        }),
      });

      const data = await response.json();

      if (!response.ok || data.success === false) {
        throw new Error(data.error || "API contract analysis failed.");
      }

      const nextReport = data as ApiContractReport;
      setReport(nextReport);
      setSelectedId(nextReport.issues[0]?.id ?? null);
      setSearch("");
      setTypeFilter("all");
      setKindFilter("all");
      setSortKey("impact");
      setShowAllRoutes(false);
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

  const visibleIssues = useMemo(() => {
    if (!report) return [];

    const query = search.trim().toLowerCase();

    const filtered = report.issues.filter((issue) => {
      if (typeFilter !== "all" && issue.group !== typeFilter) return false;
      if (kindFilter !== "all" && issue.kind !== kindFilter) return false;
      if (!query) return true;

      return [
        issue.title,
        issue.description,
        issue.method,
        issue.path,
        KIND_LABEL[issue.kind],
        ...issue.evidence.map((item) => `${item.filePath} ${item.symbol ?? ""}`),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

    return [...filtered].sort((a, b) => {
      if (sortKey === "calls") {
        return b.callCount - a.callCount || b.score - a.score;
      }
      if (sortKey === "file") {
        return (
          (a.evidence[0]?.filePath ?? "").localeCompare(b.evidence[0]?.filePath ?? "") ||
          b.score - a.score
        );
      }
      return b.score - a.score;
    });
  }, [report, search, typeFilter, kindFilter, sortKey]);

  const kindOptions = useMemo(() => {
    const present = new Set(report?.issues.map((issue) => issue.kind) ?? []);

    const options: { value: KindFilter; label: string }[] = [
      { value: "all", label: "All issue types" },
    ];

    for (const kind of Object.keys(KIND_LABEL) as IssueKind[]) {
      if (present.has(kind)) options.push({ value: kind, label: KIND_LABEL[kind] });
    }

    return options;
  }, [report]);

  const selectedIssue =
    visibleIssues.find((issue) => issue.id === selectedId) ?? visibleIssues[0] ?? null;

  const surface = report?.endpoints ?? [];
  const shownSurface = showAllRoutes ? surface : surface.slice(0, SURFACE_PREVIEW);

  return (
    <div className="apc-analyzer">
      <div className="apc-title-row">
        <div className="apc-title-icon">
          <ArrowLeftRight size={24} />
        </div>

        <div>
          <h1>API Contract Analyzer</h1>
          <p>
            Compare what your frontend calls with what your backend serves, and
            fix mismatched routes, methods, and fields.
          </p>
        </div>
      </div>

      <section className="apc-input-card">
        <div className="apc-field apc-field-wide">
          <label htmlFor="apc-project-path">Project path</label>
          <input
            id="apc-project-path"
            value={projectPath}
            onChange={(event) => onProjectPathChange?.(event.target.value)}
            placeholder="/path/to/your/project"
          />
        </div>

        <div className="apc-field">
          <label htmlFor="apc-focus-file">Focus file (optional)</label>
          <input
            id="apc-focus-file"
            value={focusFile}
            onChange={(event) => setFocusFile(event.target.value)}
            placeholder="src/api/users.ts"
          />
        </div>

        <button
          type="button"
          className="apc-analyze-button"
          onClick={analyze}
          disabled={loading}
        >
          {loading ? (
            <>
              <span className="apc-spinner" />
              Scanning...
            </>
          ) : (
            <>
              <ArrowLeftRight size={17} />
              Check Contracts
            </>
          )}
        </button>

        <div className="apc-options">
          <div className="apc-field">
            <label htmlFor="apc-path-prefix">Client path prefix (optional)</label>
            <input
              id="apc-path-prefix"
              value={pathPrefix}
              onChange={(event) => setPathPrefix(event.target.value)}
              placeholder="/api"
            />
          </div>

          <label className="apc-check">
            <input
              type="checkbox"
              checked={includeUnused}
              onChange={(event) => setIncludeUnused(event.target.checked)}
            />
            Report unused routes
          </label>

          <label className="apc-check">
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
        <div className="apc-error" role="alert">
          <XCircle size={18} />
          {error}
        </div>
      )}

      {report && (
        <>
          <div className="apc-status-row">
            <div
              className={`apc-success ${report.totalIssues === 0 ? "" : "has-groups"}`}
            >
              {report.totalIssues === 0 ? (
                <CheckCircle2 size={18} />
              ) : (
                <AlertTriangle size={18} />
              )}
              <strong>{report.totalIssues}</strong>
              <span>
                contract {report.totalIssues === 1 ? "issue" : "issues"} found
                {report.filePath ? ` involving ${report.filePath}` : ""}
              </span>
            </div>

            <span className="apc-scope">
              {report.filesScanned} files · {report.totalLines.toLocaleString()} lines
              · {report.endpointCount} routes · {report.callCount} client calls
              {report.filePath ? ` · ${report.projectIssueCount} issues project-wide` : ""}
            </span>
          </div>

          <div className="apc-summary-grid">
            <button
              type="button"
              className={`apc-summary-card apc-type-mismatch ${
                typeFilter === "mismatch" ? "active" : ""
              }`}
              onClick={() => setTypeFilter(typeFilter === "mismatch" ? "all" : "mismatch")}
              aria-pressed={typeFilter === "mismatch"}
            >
              <div className="apc-summary-icon">
                <ArrowLeftRight size={17} />
              </div>
              <div>
                <strong>{report.mismatchIssues}</strong>
                <span>Client–server mismatches</span>
              </div>
            </button>

            <button
              type="button"
              className={`apc-summary-card apc-type-unused ${
                typeFilter === "unused" ? "active" : ""
              }`}
              onClick={() => setTypeFilter(typeFilter === "unused" ? "all" : "unused")}
              aria-pressed={typeFilter === "unused"}
            >
              <div className="apc-summary-icon">
                <Server size={17} />
              </div>
              <div>
                <strong>{report.unusedIssues}</strong>
                <span>Unused routes</span>
              </div>
            </button>

            <div className="apc-summary-card static">
              <div className="apc-summary-icon neutral">
                <Layers size={17} />
              </div>
              <div>
                <strong>{report.coveragePercentage}%</strong>
                <span>
                  Route coverage · {report.endpointCount}{" "}
                  {report.endpointCount === 1 ? "route" : "routes"}
                  {report.frameworks.length > 0 ? ` · ${report.frameworks.join(", ")}` : ""}
                </span>
              </div>
            </div>

            <div className="apc-summary-card static">
              <div className="apc-summary-icon neutral">
                <Monitor size={17} />
              </div>
              <div>
                <strong>{report.callCount}</strong>
                <span>
                  Client calls · {report.matchedCalls} matched · {report.externalCalls} external
                </span>
              </div>
            </div>
          </div>

          {report.totalIssues === 0 ? (
            <section className="apc-clean">
              <CheckCircle2 size={38} />
              {report.endpointCount === 0 ? (
                <>
                  <h3>No backend routes found</h3>
                  <p>
                    The analyzer could not find any server routes in the{" "}
                    {report.filesScanned} analyzed files, so there is nothing to
                    compare client calls against. Point it at the folder that
                    contains your server code, or at the whole repository.
                  </p>
                </>
              ) : report.callCount === 0 ? (
                <>
                  <h3>No client calls found</h3>
                  <p>
                    {report.endpointCount} backend routes were found, but no
                    frontend API calls. This looks like a backend-only project, so
                    there are no contracts to compare.
                  </p>
                </>
              ) : (
                <>
                  <h3>Client and server agree</h3>
                  <p>
                    All {report.matchedCalls} matched client calls line up with a
                    backend route
                    {report.filePath ? ` that involves ${report.filePath}` : ""}.
                    Methods, paths, and the fields the analyzer could read all
                    match.
                  </p>
                </>
              )}
            </section>
          ) : (
            <section className="apc-workspace">
              <div className="apc-groups-panel">
                <div className="apc-panel-header">
                  <div>
                    <h2>Contract Issues</h2>
                    <p>
                      {visibleIssues.length} of {report.issues.length} issues
                    </p>
                  </div>

                  <div className="apc-count-pill">
                    <ArrowLeftRight size={15} />
                    {visibleIssues.length}
                  </div>
                </div>

                <div className="apc-filters">
                  <div className="apc-search">
                    <Search size={17} />
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search by route, file or function..."
                      aria-label="Search contract issues"
                    />
                  </div>

                  <div className="apc-filter-row">
                    <div
                      className="apc-type-filter"
                      role="group"
                      aria-label="Filter by issue group"
                    >
                      {(["all", "mismatch", "unused", "route"] as const).map((option) => (
                        <button
                          type="button"
                          key={option}
                          className={typeFilter === option ? "active" : ""}
                          aria-pressed={typeFilter === option}
                          onClick={() => setTypeFilter(option)}
                        >
                          {option === "all" ? "All" : GROUP_LABEL[option]}
                        </button>
                      ))}
                    </div>

                    <div className="apc-sort">
                      <SecuritySelect
                        ariaLabel="Sort issues"
                        value={sortKey}
                        onChange={setSortKey}
                        options={[
                          { value: "impact", label: "Sort: impact" },
                          { value: "calls", label: "Sort: calls affected" },
                          { value: "file", label: "Sort: file" },
                        ]}
                      />
                    </div>
                  </div>

                  <div className="apc-kind">
                    <SecuritySelect
                      ariaLabel="Filter by issue type"
                      value={kindFilter}
                      onChange={setKindFilter}
                      options={kindOptions}
                    />
                  </div>
                </div>

                <div className="apc-groups-list">
                  {visibleIssues.length === 0 ? (
                    <div className="apc-empty">
                      <ArrowLeftRight size={34} />
                      <h3>No matching issues</h3>
                      <p>No contract issues match the current filters.</p>
                    </div>
                  ) : (
                    visibleIssues.map((issue) => {
                      const client = issue.evidence.find((item) => item.role === "frontend");
                      const server = issue.evidence.find((item) => item.role === "backend");

                      return (
                        <button
                          type="button"
                          key={issue.id}
                          className={`apc-group ${
                            selectedIssue?.id === issue.id ? "selected" : ""
                          }`}
                          onClick={() => setSelectedId(issue.id)}
                        >
                          <div
                            className={`apc-group-icon apc-severity-${issue.severity}`}
                          >
                            {kindIcon(issue.kind)}
                          </div>

                          <div className="apc-group-content">
                            <div className="apc-group-top">
                              <span className={`apc-badge apc-badge-${issue.severity}`}>
                                {issue.severity}
                              </span>
                              <span className="apc-kind-badge">{KIND_LABEL[issue.kind]}</span>
                              <MethodBadge method={issue.method} />
                            </div>

                            <h3>{issue.title}</h3>
                            <p className="apc-places">
                              {client && placeLabel(client)}
                              {client && server && " → "}
                              {server && placeLabel(server)}
                              {!client && !server && issue.path}
                              {issue.callCount > 1 && ` · ${issue.callCount} calls`}
                            </p>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              <aside className="apc-inspector">
                <div className="apc-panel-header">
                  <div>
                    <h2>Inspector</h2>
                    <p>What disagrees, where it lives and how to fix it</p>
                  </div>
                </div>

                {selectedIssue ? (
                  <div className="apc-inspector-body">
                    <div className="apc-inspector-title">
                      <div
                        className={`apc-inspector-icon apc-severity-${selectedIssue.severity}`}
                      >
                        {kindIcon(selectedIssue.kind, 20)}
                      </div>

                      <div>
                        <span className={`apc-badge apc-badge-${selectedIssue.severity}`}>
                          {selectedIssue.severity}
                        </span>
                        <h3>{selectedIssue.title}</h3>
                      </div>
                    </div>

                    <div className="apc-detail-grid">
                      <div>
                        <span>Problem</span>
                        <strong>{KIND_LABEL[selectedIssue.kind]}</strong>
                      </div>
                      <div>
                        <span>Route</span>
                        <strong title={selectedIssue.path}>
                          {selectedIssue.method === "UNKNOWN" ? "" : `${selectedIssue.method} `}
                          {selectedIssue.path}
                        </strong>
                      </div>
                      <div>
                        <span>Calls affected</span>
                        <strong>{selectedIssue.callCount}</strong>
                      </div>
                      <div>
                        <span>Impact score</span>
                        <strong>{selectedIssue.score} / 100</strong>
                      </div>
                    </div>

                    <section className="apc-box">
                      <h4>What this means</h4>
                      <p>{selectedIssue.description}</p>
                    </section>

                    <section className="apc-box">
                      <h4>Where this lives</h4>
                      <EvidenceMap issue={selectedIssue} />
                    </section>

                    <CompareView key={selectedIssue.id} issue={selectedIssue} />

                    {selectedIssue.comparison && (
                      <FieldTable
                        key={`fields-${selectedIssue.id}`}
                        comparison={selectedIssue.comparison}
                      />
                    )}

                    <FixPanel key={`fix-${selectedIssue.id}`} issue={selectedIssue} />
                  </div>
                ) : (
                  <div className="apc-inspector-empty">
                    <ArrowLeftRight size={38} />
                    <h3>Select an issue</h3>
                    <p>
                      Choose a contract issue from the list to compare the client
                      and server code and see how to fix it.
                    </p>
                  </div>
                )}
              </aside>
            </section>
          )}

          {report.hotspots.length > 0 && (
            <section className="apc-hotspots">
              <div className="apc-panel-header">
                <div>
                  <h2>Files with the most issues</h2>
                  <p>Client and server files involved in contract issues. Select one to filter.</p>
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
                        setKindFilter("all");
                      }}
                    >
                      <FileCode2 size={14} />
                      <span title={file.filePath}>{file.filePath}</span>
                      <em>{file.role === "both" ? "client + server" : ROLE_LABEL[file.role].toLowerCase()}</em>
                      <strong>{file.issueCount}</strong>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {surface.length > 0 && (
            <section className="apc-hotspots apc-surface">
              <div className="apc-panel-header">
                <div>
                  <h2>API surface</h2>
                  <p>
                    Every backend route that was found, with how many client calls reach
                    it. Select one with issues to filter.
                  </p>
                </div>
              </div>

              <ul>
                {shownSurface.map((endpoint) => (
                  <li key={endpoint.id}>
                    <button
                      type="button"
                      disabled={endpoint.issueCount === 0}
                      title={`${endpoint.filePath}:${endpoint.line}`}
                      onClick={() => {
                        setSearch(endpoint.path);
                        setTypeFilter("all");
                        setKindFilter("all");
                      }}
                    >
                      <MethodBadge method={endpoint.method} />
                      <code>{endpoint.path}</code>
                      <em>
                        {endpoint.callers} {endpoint.callers === 1 ? "call" : "calls"}
                      </em>
                      <strong className={endpoint.issueCount === 0 ? "apc-clean-count" : ""}>
                        {endpoint.issueCount === 0 ? "✓" : endpoint.issueCount}
                      </strong>
                    </button>
                  </li>
                ))}
              </ul>

              {surface.length > SURFACE_PREVIEW && (
                <button
                  type="button"
                  className="apc-surface-more"
                  onClick={() => setShowAllRoutes((current) => !current)}
                >
                  {showAllRoutes ? "Show fewer routes" : `Show all ${surface.length} routes`}
                </button>
              )}
            </section>
          )}

          {report.warnings.length > 0 && (
            <section className="apc-analysis-notes">
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
