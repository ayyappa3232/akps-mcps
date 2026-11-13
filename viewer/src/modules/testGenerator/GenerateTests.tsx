import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Box,
  Braces,
  Check,
  CheckCircle2,
  Copy,
  FileCode2,
  FlaskConical,
  Layers,
  Search,
  Webhook,
  Wrench,
  XCircle,
} from "lucide-react";
import SecuritySelect from "../security/SecuritySelect";
import "./generate-tests.css";

type TestSeverity = "critical" | "high" | "medium" | "low" | "info";
type UnitKind = "function" | "method" | "component" | "hook";
type TestStatus = "untested" | "partial" | "tested";
type FrameworkName = "vitest" | "jest";
type FrameworkChoice = "auto" | FrameworkName;
type AssertionLevel = "exact" | "shape" | "scaffold";

type ScenarioCategory =
  | "happy"
  | "branch"
  | "edge"
  | "error"
  | "async"
  | "render"
  | "interaction"
  | "state";

interface ParamInfo {
  name: string;
  type: string;
  optional: boolean;
  defaultValue?: string;
  rest: boolean;
}

interface TestScenario {
  id: string;
  title: string;
  category: ScenarioCategory;
  assertion: AssertionLevel;
  reason: string;
  line?: number;
}

interface SourceSnippet {
  startLine: number;
  endLine: number;
  snippet: string;
  truncated: boolean;
}

interface TestTarget {
  id: string;
  name: string;
  kind: UnitKind;
  exportKind: "named" | "default";
  filePath: string;
  startLine: number;
  endLine: number;
  fileLines: number;
  signature: string;
  async: boolean;
  params: ParamInfo[];
  complexity: number;
  branches: number;
  throwsCount: number;
  mocks: string[];
  status: TestStatus;
  existingTests: number;
  existingTestFile?: string;
  priority: TestSeverity;
  score: number;
  title: string;
  description: string;
  scenarios: TestScenario[];
  source: SourceSnippet;
  testPath: string;
  testAction: "create" | "append";
  setupCode: string;
  testCode: string;
  runCommand: string;
  caveats: string[];
}

interface GeneratedTestFile {
  sourcePath: string;
  testPath: string;
  action: "create" | "append";
  framework: FrameworkName;
  units: number;
  scenarios: number;
  needsReview: number;
  content: string;
  runCommand: string;
}

interface TestSetup {
  packagePath: string;
  detected: FrameworkName | "none";
  framework: FrameworkName;
  frameworkSource: string;
  libraries: string[];
  hasTestScript: boolean;
  placement: "colocated" | "tests-folder" | "mirror";
  existingTestFiles: number;
  units: number;
  missing: string[];
  installCommand?: string;
  notes: string[];
}

interface TestHotspot {
  filePath: string;
  untested: number;
  complexity: number;
  worstPriority: TestSeverity;
}

interface TestGeneratorReport {
  success: boolean;
  tool: "generate_tests";
  projectPath: string;
  filePath?: string;
  framework: FrameworkChoice;
  includeTested: boolean;
  filesScanned: number;
  totalLines: number;
  testFilesFound: number;
  unitsFound: number;
  untestedUnits: number;
  partialUnits: number;
  testedUnits: number;
  coveragePercentage: number;
  totalTargets: number;
  scenariosGenerated: number;
  scenariosNeedingReview: number;
  filesToWrite: number;
  summary: Record<TestSeverity, number>;
  targets: TestTarget[];
  files: GeneratedTestFile[];
  setups: TestSetup[];
  hotspots: TestHotspot[];
  warnings: string[];
}

interface GenerateTestsProps {
  projectPath: string;
  onProjectPathChange?: (value: string) => void;
  apiUrl?: string;
}

type StatusFilter = "all" | TestStatus;
type KindFilter = "all" | UnitKind;
type SortKey = "priority" | "complexity" | "file";

const DEFAULT_API_URL = "http://127.0.0.1:4174/api/generate-tests";

const STATUS_LABEL: Record<TestStatus, string> = {
  untested: "Untested",
  partial: "Partly tested",
  tested: "Tested",
};

const KIND_LABEL: Record<UnitKind, string> = {
  function: "Function",
  method: "Method",
  component: "Component",
  hook: "Hook",
};

const CATEGORY_LABEL: Record<ScenarioCategory, string> = {
  happy: "Happy path",
  branch: "Branch",
  edge: "Edge case",
  error: "Error",
  async: "Async",
  render: "Render",
  interaction: "Interaction",
  state: "State",
};

const ASSERTION_LABEL: Record<AssertionLevel, { label: string; tone: "ok" | "neutral" | "warn" }> = {
  exact: { label: "Exact value", tone: "ok" },
  shape: { label: "Type or no-throw check", tone: "neutral" },
  scaffold: { label: "Add your value", tone: "warn" },
};

function baseName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1];
}

function kindIcon(kind: UnitKind, size = 17) {
  switch (kind) {
    case "method":
      return <Box size={size} />;
    case "component":
      return <Layers size={size} />;
    case "hook":
      return <Webhook size={size} />;
    default:
      return <Braces size={size} />;
  }
}

/* -------------------------------------------------------------------------- */
/*  Small building blocks                                                     */
/* -------------------------------------------------------------------------- */

function CopyButton({
  value,
  label,
  copiedLabel = "Copied",
  className = "",
}: {
  value: string;
  label: string;
  copiedLabel?: string;
  className?: string;
}) {
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
    <button type="button" className={className} onClick={copy} title={failed ? "Clipboard access was blocked" : undefined}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? copiedLabel : failed ? "Copy blocked" : label}
    </button>
  );
}

function CodeBlock({
  code,
  startLine = 1,
  label,
}: {
  code: string;
  startLine?: number;
  label: string;
}) {
  const lines = code.split("\n");

  return (
    <div className="tgn-code-wrap">
      <div className="tgn-code" role="region" aria-label={label} tabIndex={0}>
        {lines.map((line, index) => (
          <div key={index} className="tgn-code-line">
            <span className="tgn-code-number">{startLine + index}</span>
            <code>{line || " "}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlacementMap({ target }: { target: TestTarget }) {
  const total = Math.max(1, target.fileLines);
  const span = Math.max(1, target.endLine - target.startLine + 1);
  const left = ((target.startLine - 1) / total) * 100;
  const width = Math.max(2, (span / total) * 100);

  return (
    <ul className="tgn-map">
      <li>
        <div className="tgn-map-head">
          <span className="tgn-map-index">1</span>
          <span className="tgn-role">Source</span>
          <FileCode2 size={13} />
          <span className="tgn-map-path" title={target.filePath}>
            {target.filePath}
          </span>
        </div>

        <div className="tgn-map-meta">
          <span>
            lines {target.startLine}-{target.endLine}
          </span>
          <span>{target.exportKind === "default" ? "default export" : "named export"}</span>
          <span>{target.async ? "async" : "sync"}</span>
        </div>

        <div
          className="tgn-map-track"
          role="img"
          aria-label={`Lines ${target.startLine} to ${target.endLine} of ${target.fileLines}`}
        >
          <span
            className="tgn-map-fill"
            style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
          />
        </div>
      </li>

      <li>
        <div className="tgn-map-head">
          <span className="tgn-map-index">2</span>
          <span className="tgn-role tgn-role-test">Tests</span>
          <FileCode2 size={13} />
          <span className="tgn-map-path" title={target.testPath}>
            {target.testPath}
          </span>
        </div>

        <div className="tgn-map-meta">
          <span>{target.testAction === "create" ? "new file" : "add to the existing file"}</span>
          <span>
            {target.existingTests} existing {target.existingTests === 1 ? "test" : "tests"}
          </span>
        </div>
      </li>
    </ul>
  );
}

function ScenarioTable({ scenarios }: { scenarios: TestScenario[] }) {
  return (
    <div className="tgn-scenarios-wrap">
      <table className="tgn-scenarios">
        <thead>
          <tr>
            <th scope="col">Test</th>
            <th scope="col">Type</th>
            <th scope="col">Assertion</th>
          </tr>
        </thead>
        <tbody>
          {scenarios.map((scenario) => {
            const level = ASSERTION_LABEL[scenario.assertion];

            return (
              <tr key={scenario.id} title={scenario.reason}>
                <td>{scenario.title}</td>
                <td>{CATEGORY_LABEL[scenario.category]}</td>
                <td>
                  <span className={`tgn-chip tgn-chip-${level.tone}`}>{level.label}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TestPanel({ target, file }: { target: TestTarget; file?: GeneratedTestFile }) {
  return (
    <section className="tgn-box tgn-refactor">
      <div className="tgn-refactor-head">
        <h4>
          <Wrench size={14} /> Generated test
        </h4>

        <div className="tgn-refactor-badges">
          <span className="tgn-kind-badge">{target.testAction === "create" ? "New file" : "Add to existing file"}</span>
          <span className="tgn-kind-badge">{target.testPath.split(".").slice(-2).join(".")}</span>
        </div>
      </div>

      <p className="tgn-refactor-title">
        {target.testAction === "create" ? "Create" : "Add this to"} {target.testPath}
      </p>

      <ol className="tgn-steps">
        {target.testAction === "create" ? (
          <>
            <li>Create {target.testPath} and paste the full file (or the imports plus the test below).</li>
            <li>Replace every “TODO” assertion with the value you expect.</li>
            <li>Run the command below and fix anything that fails.</li>
          </>
        ) : (
          <>
            <li>Open {target.testPath}.</li>
            <li>Merge the imports below into the existing ones, then paste the test block.</li>
            <li>Replace every “TODO” assertion, then run the command below.</li>
          </>
        )}
      </ol>

      {target.mocks.length > 0 && (
        <ul className="tgn-mock-chips" aria-label="Things the tests replace">
          {target.mocks.map((mock) => (
            <li key={mock}>{mock}</li>
          ))}
        </ul>
      )}

      <p className="tgn-code-title">Imports and setup</p>
      <CodeBlock code={target.setupCode} label="Imports and setup" />

      <p className="tgn-code-title">Test</p>
      <CodeBlock code={target.testCode} label="Generated test" />

      <div className="tgn-run" aria-label="Command to run the test">
        <span>Run</span>
        <code>{target.runCommand}</code>
      </div>

      <div className="tgn-actions">
        <CopyButton value={target.testCode} label="Copy test" />
        <CopyButton value={target.setupCode} label="Copy imports" />
        {file && <CopyButton value={file.content} label={`Copy full file (${file.units} ${file.units === 1 ? "unit" : "units"})`} />}
        <CopyButton value={target.testPath} label="Copy path" />
        <CopyButton value={target.runCommand} label="Copy command" />
      </div>

      {target.caveats.length > 0 && (
        <ul className="tgn-caveats">
          {target.caveats.map((caveat, index) => (
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

export default function GenerateTests({
  projectPath,
  onProjectPathChange,
  apiUrl = DEFAULT_API_URL,
}: GenerateTestsProps) {
  const [focusFile, setFocusFile] = useState("");
  const [framework, setFramework] = useState<FrameworkChoice>("auto");
  const [includeTested, setIncludeTested] = useState(false);

  const [report, setReport] = useState<TestGeneratorReport | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("priority");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function generate() {
    if (!projectPath.trim()) {
      setError("Enter a project path before generating tests.");
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
          framework,
          includeTested,
        }),
      });

      const data = await response.json();

      if (!response.ok || data.success === false) {
        throw new Error(data.error || "Test generation failed.");
      }

      const next = data as TestGeneratorReport;
      setReport(next);
      setSelectedId(next.targets[0]?.id ?? null);
      setSearch("");
      setStatusFilter("all");
      setKindFilter("all");
      setSortKey("priority");
    } catch (generationError) {
      setError(
        generationError instanceof Error
          ? generationError.message
          : "Unable to analyze the project."
      );
    } finally {
      setLoading(false);
    }
  }

  const visibleTargets = useMemo(() => {
    if (!report) return [];

    const query = search.trim().toLowerCase();

    const filtered = report.targets.filter((target) => {
      if (statusFilter !== "all" && target.status !== statusFilter) return false;
      if (kindFilter !== "all" && target.kind !== kindFilter) return false;
      if (!query) return true;

      return [target.name, target.filePath, target.title, target.kind, target.testPath]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

    return [...filtered].sort((a, b) => {
      if (sortKey === "complexity") return b.complexity - a.complexity || b.score - a.score;
      if (sortKey === "file") return a.filePath.localeCompare(b.filePath) || b.score - a.score;
      return b.score - a.score;
    });
  }, [report, search, statusFilter, kindFilter, sortKey]);

  const kindOptions = useMemo(() => {
    const present = new Set(report?.targets.map((target) => target.kind) ?? []);
    const options: { value: KindFilter; label: string }[] = [{ value: "all", label: "All kinds of code" }];

    for (const kind of Object.keys(KIND_LABEL) as UnitKind[]) {
      if (present.has(kind)) options.push({ value: kind, label: `${KIND_LABEL[kind]}s` });
    }

    return options;
  }, [report]);

  const selected = visibleTargets.find((target) => target.id === selectedId) ?? visibleTargets[0] ?? null;
  const selectedFile = report?.files.find((file) => file.sourcePath === selected?.filePath);

  return (
    <div className="tgn-analyzer">
      <div className="tgn-title-row">
        <div className="tgn-title-icon">
          <FlaskConical size={24} />
        </div>

        <div>
          <h1>Test Generator Assistant</h1>
          <p>
            Find code without tests and generate runnable Vitest or Jest tests
            with branch, edge-case, and React interaction coverage.
          </p>
        </div>
      </div>

      <section className="tgn-input-card">
        <div className="tgn-field tgn-field-wide">
          <label htmlFor="tgn-project-path">Project path</label>
          <input
            id="tgn-project-path"
            value={projectPath}
            onChange={(event) => onProjectPathChange?.(event.target.value)}
            placeholder="/path/to/your/project"
          />
        </div>

        <div className="tgn-field">
          <label htmlFor="tgn-focus-file">Focus file or folder (optional)</label>
          <input
            id="tgn-focus-file"
            value={focusFile}
            onChange={(event) => setFocusFile(event.target.value)}
            placeholder="src/utils"
          />
        </div>

        <button
          type="button"
          className="tgn-analyze-button"
          onClick={generate}
          disabled={loading}
        >
          {loading ? (
            <>
              <span className="tgn-spinner" />
              Generating...
            </>
          ) : (
            <>
              <FlaskConical size={17} />
              Generate Tests
            </>
          )}
        </button>

        <div className="tgn-options">
          <div className="tgn-field">
            <label>Test framework</label>
            <SecuritySelect
              ariaLabel="Test framework"
              value={framework}
              onChange={setFramework}
              options={[
                { value: "auto", label: "Detect from package.json" },
                { value: "vitest", label: "Vitest" },
                { value: "jest", label: "Jest" },
              ]}
            />
          </div>

          <label className="tgn-check">
            <input
              type="checkbox"
              checked={includeTested}
              onChange={(event) => setIncludeTested(event.target.checked)}
            />
            Include code that already has tests
          </label>
        </div>
      </section>

      {error && (
        <div className="tgn-error" role="alert">
          <XCircle size={18} />
          {error}
        </div>
      )}

      {report && (
        <>
          <div className="tgn-status-row">
            <div
              className={`tgn-success ${report.untestedUnits + report.partialUnits === 0 ? "" : "has-groups"}`}
            >
              {report.untestedUnits + report.partialUnits === 0 ? (
                <CheckCircle2 size={18} />
              ) : (
                <AlertTriangle size={18} />
              )}
              <strong>{report.untestedUnits + report.partialUnits}</strong>
              <span>
                {report.untestedUnits + report.partialUnits === 1 ? "unit needs" : "units need"} tests
                {report.filePath ? ` in ${report.filePath}` : ""}
              </span>
            </div>

            <span className="tgn-scope">
              {report.filesScanned} source files · {report.totalLines.toLocaleString()} lines ·{" "}
              {report.testFilesFound} test files · {report.unitsFound} testable units
            </span>
          </div>

          <div className="tgn-summary-grid">
            <button
              type="button"
              className={`tgn-summary-card tgn-type-untested ${statusFilter === "untested" ? "active" : ""}`}
              onClick={() => setStatusFilter(statusFilter === "untested" ? "all" : "untested")}
              aria-pressed={statusFilter === "untested"}
            >
              <div className="tgn-summary-icon">
                <FlaskConical size={17} />
              </div>
              <div>
                <strong>{report.untestedUnits}</strong>
                <span>Untested units</span>
              </div>
            </button>

            <button
              type="button"
              className={`tgn-summary-card tgn-type-partial ${statusFilter === "partial" ? "active" : ""}`}
              onClick={() => setStatusFilter(statusFilter === "partial" ? "all" : "partial")}
              aria-pressed={statusFilter === "partial"}
            >
              <div className="tgn-summary-icon">
                <Layers size={17} />
              </div>
              <div>
                <strong>{report.partialUnits}</strong>
                <span>Partly tested</span>
              </div>
            </button>

            <div className="tgn-summary-card static">
              <div className="tgn-summary-icon neutral">
                <CheckCircle2 size={17} />
              </div>
              <div>
                <strong>{report.coveragePercentage}%</strong>
                <span>
                  Units with enough tests · {report.testedUnits} of {report.unitsFound}
                </span>
              </div>
            </div>

            <div className="tgn-summary-card static">
              <div className="tgn-summary-icon neutral">
                <Braces size={17} />
              </div>
              <div>
                <strong>{report.scenariosGenerated}</strong>
                <span>
                  Tests generated · {report.scenariosNeedingReview} need your value · {report.filesToWrite}{" "}
                  {report.filesToWrite === 1 ? "file" : "files"}
                </span>
              </div>
            </div>
          </div>

          {report.targets.length === 0 ? (
            <section className="tgn-clean">
              <CheckCircle2 size={38} />
              {report.unitsFound === 0 ? (
                <>
                  <h3>No testable code found</h3>
                  <p>
                    The analyzer found no exported functions, class methods,
                    components, or hooks
                    {report.filePath ? ` in ${report.filePath}` : ""}. Point it at a folder that contains source code.
                  </p>
                </>
              ) : (
                <>
                  <h3>Everything has tests</h3>
                  <p>
                    All {report.unitsFound} testable units already have enough
                    tests. Turn on “Include code that already has tests” to
                    review them anyway.
                  </p>
                </>
              )}
            </section>
          ) : (
            <section className="tgn-workspace">
              <div className="tgn-groups-panel">
                <div className="tgn-panel-header">
                  <div>
                    <h2>Test Targets</h2>
                    <p>
                      {visibleTargets.length} of {report.targets.length} targets
                    </p>
                  </div>

                  <div className="tgn-count-pill">
                    <FlaskConical size={15} />
                    {visibleTargets.length}
                  </div>
                </div>

                <div className="tgn-filters">
                  <div className="tgn-search">
                    <Search size={17} />
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search by name or file..."
                      aria-label="Search test targets"
                    />
                  </div>

                  <div className="tgn-filter-row">
                    <div className="tgn-type-filter" role="group" aria-label="Filter by test status">
                      {(["all", "untested", "partial", "tested"] as const).map((option) => (
                        <button
                          type="button"
                          key={option}
                          className={statusFilter === option ? "active" : ""}
                          aria-pressed={statusFilter === option}
                          onClick={() => setStatusFilter(option)}
                        >
                          {option === "all" ? "All" : STATUS_LABEL[option]}
                        </button>
                      ))}
                    </div>

                    <div className="tgn-sort">
                      <SecuritySelect
                        ariaLabel="Sort targets"
                        value={sortKey}
                        onChange={setSortKey}
                        options={[
                          { value: "priority", label: "Sort: priority" },
                          { value: "complexity", label: "Sort: complexity" },
                          { value: "file", label: "Sort: file" },
                        ]}
                      />
                    </div>
                  </div>

                  <div className="tgn-kind">
                    <SecuritySelect
                      ariaLabel="Filter by kind of code"
                      value={kindFilter}
                      onChange={setKindFilter}
                      options={kindOptions}
                    />
                  </div>
                </div>

                <div className="tgn-groups-list">
                  {visibleTargets.length === 0 ? (
                    <div className="tgn-empty">
                      <FlaskConical size={34} />
                      <h3>No matching targets</h3>
                      <p>No targets match the current filters.</p>
                    </div>
                  ) : (
                    visibleTargets.map((target) => (
                      <button
                        type="button"
                        key={target.id}
                        className={`tgn-group ${selected?.id === target.id ? "selected" : ""}`}
                        onClick={() => setSelectedId(target.id)}
                      >
                        <div className={`tgn-group-icon tgn-severity-${target.priority}`}>
                          {kindIcon(target.kind)}
                        </div>

                        <div className="tgn-group-content">
                          <div className="tgn-group-top">
                            <span className={`tgn-badge tgn-badge-${target.priority}`}>{target.priority}</span>
                            <span className={`tgn-status tgn-status-${target.status}`}>
                              {STATUS_LABEL[target.status]}
                            </span>
                            <span className="tgn-kind-badge">{KIND_LABEL[target.kind]}</span>
                          </div>

                          <h3>{target.name}</h3>
                          <p className="tgn-places">
                            {baseName(target.filePath)}:{target.startLine} · {target.scenarios.length} tests ·
                            complexity {target.complexity}
                          </p>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>

              <aside className="tgn-inspector">
                <div className="tgn-panel-header">
                  <div>
                    <h2>Inspector</h2>
                    <p>What needs testing, what the tests cover and the code to add</p>
                  </div>
                </div>

                {selected ? (
                  <div className="tgn-inspector-body">
                    <div className="tgn-inspector-title">
                      <div className={`tgn-inspector-icon tgn-severity-${selected.priority}`}>
                        {kindIcon(selected.kind, 20)}
                      </div>

                      <div>
                        <span className={`tgn-badge tgn-badge-${selected.priority}`}>{selected.priority}</span>
                        <h3>{selected.title}</h3>
                      </div>
                    </div>

                    <div className="tgn-detail-grid">
                      <div>
                        <span>Kind</span>
                        <strong>
                          {KIND_LABEL[selected.kind]}
                          {selected.async ? " (async)" : ""}
                        </strong>
                      </div>
                      <div>
                        <span>Status</span>
                        <strong>{STATUS_LABEL[selected.status]}</strong>
                      </div>
                      <div>
                        <span>Complexity</span>
                        <strong>
                          {selected.complexity} · {selected.branches} {selected.branches === 1 ? "branch" : "branches"}
                        </strong>
                      </div>
                      <div>
                        <span>Priority score</span>
                        <strong>{selected.score} / 100</strong>
                      </div>
                    </div>

                    <section className="tgn-box">
                      <h4>What this means</h4>
                      <p>{selected.description}</p>
                    </section>

                    <section className="tgn-box">
                      <h4>Where this lives</h4>
                      <PlacementMap target={selected} />
                    </section>

                    <section className="tgn-box">
                      <h4>Source</h4>
                      <p className="tgn-fine-print">
                        <code>
                          {selected.name}
                          {selected.signature}
                        </code>
                      </p>
                      <CodeBlock
                        code={selected.source.snippet}
                        startLine={selected.source.startLine}
                        label="Source code"
                      />
                      {selected.source.truncated && (
                        <p className="tgn-fine-print">The source is longer than the lines shown.</p>
                      )}
                    </section>

                    <section className="tgn-box">
                      <h4>What the tests cover ({selected.scenarios.length})</h4>
                      <ScenarioTable scenarios={selected.scenarios} />
                    </section>

                    <TestPanel key={selected.id} target={selected} file={selectedFile} />
                  </div>
                ) : (
                  <div className="tgn-inspector-empty">
                    <FlaskConical size={38} />
                    <h3>Select a target</h3>
                    <p>Choose a unit from the list to see its generated tests.</p>
                  </div>
                )}
              </aside>
            </section>
          )}

          {report.files.length > 0 && (
            <section className="tgn-hotspots tgn-files">
              <div className="tgn-panel-header">
                <div>
                  <h2>Test files to add</h2>
                  <p>One file per source file, ready to paste. Select a row to filter the list.</p>
                </div>
              </div>

              <ul>
                {report.files.slice(0, 12).map((file) => (
                  <li key={file.sourcePath}>
                    <button
                      type="button"
                      onClick={() => {
                        setSearch(file.sourcePath);
                        setStatusFilter("all");
                        setKindFilter("all");
                      }}
                    >
                      <FileCode2 size={14} />
                      <span title={file.testPath}>{file.testPath}</span>
                      <em>
                        {file.action === "create" ? "new" : "append"} · {file.scenarios} tests
                        {file.needsReview > 0 ? ` · ${file.needsReview} to review` : ""}
                      </em>
                      <strong>{file.units}</strong>
                    </button>
                    <CopyButton className="tgn-row-copy" value={file.content} label="Copy file" />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {report.hotspots.length > 0 && (
            <section className="tgn-hotspots">
              <div className="tgn-panel-header">
                <div>
                  <h2>Files with the most untested code</h2>
                  <p>Start here for the biggest gain. Select a file to filter the list.</p>
                </div>
              </div>

              <ul>
                {report.hotspots.map((file) => (
                  <li key={file.filePath}>
                    <button
                      type="button"
                      onClick={() => {
                        setSearch(file.filePath);
                        setStatusFilter("all");
                        setKindFilter("all");
                      }}
                    >
                      <FileCode2 size={14} />
                      <span title={file.filePath}>{file.filePath}</span>
                      <em>complexity {file.complexity}</em>
                      <strong>{file.untested}</strong>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {report.setups.length > 0 && (
            <section className="tgn-hotspots">
              <div className="tgn-panel-header">
                <div>
                  <h2>Test setup</h2>
                  <p>What was found in each package, and what is missing to run the generated tests.</p>
                </div>
              </div>

              <div className="tgn-setup-grid">
                {report.setups.map((setup) => (
                  <article key={setup.packagePath} className="tgn-setup-card">
                    <h3>
                      <code title={setup.packagePath}>{setup.packagePath === "." ? "project root" : setup.packagePath}</code>
                      <span className={`tgn-status ${setup.missing.length === 0 ? "tgn-status-tested" : "tgn-status-partial"}`}>
                        {setup.missing.length === 0 ? "Ready" : "Needs setup"}
                      </span>
                    </h3>

                    <dl>
                      <div>
                        <dt>Framework</dt>
                        <dd>
                          {setup.framework === "jest" ? "Jest" : "Vitest"} ({setup.frameworkSource})
                        </dd>
                      </div>
                      <div>
                        <dt>Libraries</dt>
                        <dd>{setup.libraries.length ? setup.libraries.join(", ") : "none found"}</dd>
                      </div>
                      <div>
                        <dt>Existing tests</dt>
                        <dd>{setup.existingTestFiles} files</dd>
                      </div>
                      <div>
                        <dt>Testable units</dt>
                        <dd>{setup.units}</dd>
                      </div>
                      {setup.missing.length > 0 && (
                        <div>
                          <dt>Missing</dt>
                          <dd>{setup.missing.join(", ")}</dd>
                        </div>
                      )}
                    </dl>

                    {setup.installCommand && (
                      <div className="tgn-actions">
                        <CopyButton value={setup.installCommand} label="Copy install command" />
                      </div>
                    )}

                    {setup.notes.length > 0 && (
                      <ul>
                        {setup.notes.map((note, index) => (
                          <li key={index}>{note}</li>
                        ))}
                      </ul>
                    )}
                  </article>
                ))}
              </div>
            </section>
          )}

          {report.warnings.length > 0 && (
            <section className="tgn-analysis-notes">
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
