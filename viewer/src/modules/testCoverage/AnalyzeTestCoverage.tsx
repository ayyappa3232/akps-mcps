import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ChevronRight,
  FileCode2,
  FlaskConical,
  Info,
  Search,
  X,
  XCircle,
} from "lucide-react";
import "./analyze-test-coverage.css";

const API_URL = "http://127.0.0.1:4174/api/analyze-test-coverage";

type CoverageMetrics = {
  line?: number;
  statement?: number;
  branch?: number;
  function?: number;
};

type LineRange = { start: number; end: number };

type SourceFileSummary = {
  filePath: string;
  linkedTestFiles: string[];
  coverage?: CoverageMetrics;
  uncoveredLineCount?: number;
};

type FileCoverageDetail = {
  filePath: string;
  linkedTestFiles: string[];
  coverage?: CoverageMetrics;
  hasLineDetail: boolean;
  neverExecuted?: boolean;
  uncoveredLines: LineRange[];
  uncoveredFunctions: { name: string; line: number }[];
  uncoveredBranches: { line: number; type: string }[];
  source?: string;
  sourceTruncated?: boolean;
};

type CoverageStatus = {
  available: boolean;
  source: "existing-report" | "generated" | "none";
  reportPath?: string;
  reason?:
    | "no-test-framework"
    | "no-active-tests"
    | "no-coverage-report"
    | "generation-failed"
    | "unsupported-runner"
    | "unreadable-report";
  title?: string;
  message?: string;
  suggestions: string[];
};

type TestFileReport = {
  filePath: string;
  testCount: number;
  matchingSourceFiles: string[];
};

type TestCoverageReport = {
  success: boolean;
  tool?: "analyze_test_coverage";
  projectPath: string;
  totalSourceFiles: number;
  totalTestFiles: number;
  totalTests: number;
  sourceFilesWithTests: number;
  sourceFilesWithoutTests: number;
  coverage: CoverageMetrics;
  testFrameworks: string[];
  testFiles: TestFileReport[];
  untestedSourceFiles: string[];
  coverageStatus?: CoverageStatus;
  sourceFiles?: SourceFileSummary[];
  fileDetail?: FileCoverageDetail;
  scope?: "project" | "file";
  warnings: string[];
};

type Selection = { kind: "source" | "test"; path: string } | null;

interface AnalyzeTestCoverageProps {
  projectPath: string;
  onProjectPathChange?: (value: string) => void;
}

async function requestAnalysis(
  projectPath: string,
  filePath: string | undefined,
  signal: AbortSignal,
): Promise<TestCoverageReport> {
  const response = await fetch(API_URL, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectPath, filePath }),
  });

  const data = await response.json();

  if (!response.ok || data.success === false) {
    throw new Error(data.error || "Test coverage analysis failed.");
  }

  return data as TestCoverageReport;
}

function formatPercentage(value?: number): string {
  return value === undefined ? "—" : `${value}%`;
}

function getCoverageTone(value?: number): string {
  if (value === undefined) return "unknown";
  if (value >= 80) return "good";
  if (value >= 60) return "medium";
  return "low";
}

function baseName(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

// Renders `code` segments (backticks) from backend messages as <code>.
function renderInlineCode(text: string): ReactNode {
  return text.split("`").map((part, index) =>
    index % 2 === 1 ? <code key={index}>{part}</code> : part,
  );
}

function formatRange(range: LineRange): string {
  return range.start === range.end
    ? `L${range.start}`
    : `L${range.start}–${range.end}`;
}

export default function AnalyzeTestCoverage({
  projectPath,
  onProjectPathChange,
}: AnalyzeTestCoverageProps) {
  const [filePath, setFilePath] = useState("");
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"untested" | "tested">("untested");
  const [report, setReport] = useState<TestCoverageReport | null>(null);
  const [analyzedPath, setAnalyzedPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const [selection, setSelection] = useState<Selection>(null);
  const [detail, setDetail] = useState<FileCoverageDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);
  const detailPanelRef = useRef<HTMLElement | null>(null);

  // Elapsed-time counter so a long first run (clone + install + tests) is visible.
  useEffect(() => {
    if (!loading) return;

    setElapsedSeconds(0);
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [loading]);

  // Abort in-flight requests when the component unmounts.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      detailAbortRef.current?.abort();
    },
    [],
  );

  // Bring the detail panel into view whenever a file or test is selected.
  useEffect(() => {
    if (selection) {
      detailPanelRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
  }, [selection]);

  function cancelAnalysis() {
    abortRef.current?.abort();
  }

  function clearSelection() {
    detailAbortRef.current?.abort();
    setSelection(null);
    setDetail(null);
    setDetailError("");
    setDetailLoading(false);
  }

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
    // Never keep showing the previous project's results while a new one runs.
    setReport(null);
    setSearch("");
    clearSelection();

    try {
      const data = await requestAnalysis(
        projectPath.trim(),
        filePath.trim() || undefined,
        controller.signal,
      );

      setAnalyzedPath(projectPath.trim());
      setReport(data);
    } catch (analysisError) {
      setReport(null);

      if (controller.signal.aborted) {
        // Replaced by a newer request, or cancelled by the user.
        if (abortRef.current === controller) setError("Analysis cancelled.");
        return;
      }

      setError(
        analysisError instanceof Error
          ? analysisError.message
          : "Unable to analyze the project.",
      );
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setLoading(false);
      }
    }
  }

  // Source file detail (uncovered lines + code) is fetched on demand. The
  // backend reuses its cached clone and coverage report, so this is fast.
  async function openSource(sourcePath: string) {
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;

    setSelection({ kind: "source", path: sourcePath });
    setDetail(null);
    setDetailError("");
    setDetailLoading(true);

    try {
      const data = await requestAnalysis(
        analyzedPath,
        sourcePath,
        controller.signal,
      );

      if (!data.fileDetail) {
        throw new Error(
          "The server did not return file details. Restart it so it loads the latest analyzer.",
        );
      }

      setDetail(data.fileDetail);
    } catch (detailFetchError) {
      if (controller.signal.aborted) return;
      setDetailError(
        detailFetchError instanceof Error
          ? detailFetchError.message
          : "Unable to load file details.",
      );
    } finally {
      if (detailAbortRef.current === controller) {
        detailAbortRef.current = null;
        setDetailLoading(false);
      }
    }
  }

  function openTest(testPath: string) {
    detailAbortRef.current?.abort();
    setDetail(null);
    setDetailError("");
    setDetailLoading(false);
    setSelection({ kind: "test", path: testPath });
  }

  const sourceMap = useMemo(() => {
    const map = new Map<string, SourceFileSummary>();
    for (const file of report?.sourceFiles ?? []) map.set(file.filePath, file);
    return map;
  }, [report]);

  const untestedFiles = useMemo(() => {
    if (!report) return [];
    return report.untestedSourceFiles.map(
      (file) =>
        sourceMap.get(file) ?? { filePath: file, linkedTestFiles: [] },
    );
  }, [report, sourceMap]);

  const testedFiles = useMemo(() => {
    const files = (report?.sourceFiles ?? []).filter(
      (file) => file.linkedTestFiles.length > 0,
    );

    // Weakest coverage first: that is where the next test is most useful.
    return files.sort(
      (a, b) =>
        (a.coverage?.line ?? -1) - (b.coverage?.line ?? -1) ||
        a.filePath.localeCompare(b.filePath),
    );
  }, [report]);

  const visibleFiles = useMemo(() => {
    const list = tab === "untested" ? untestedFiles : testedFiles;
    const query = search.trim().toLowerCase();
    if (!query) return list;
    return list.filter((file) => file.filePath.toLowerCase().includes(query));
  }, [tab, untestedFiles, testedFiles, search]);

  // Older backends don't send coverageStatus: fall back to "any value present".
  const coverageAvailable = report
    ? (report.coverageStatus?.available ??
      Object.values(report.coverage).some((value) => value !== undefined))
    : false;

  const totalLinkedSourceFiles = report?.sourceFilesWithTests ?? 0;
  const testRelationshipPercentage =
    report && report.totalSourceFiles > 0
      ? Math.round(
          (totalLinkedSourceFiles / report.totalSourceFiles) * 100,
        )
      : undefined;

  return (
    <div className="test-coverage-analyzer">
      <div className="test-coverage-title-row">
        <div className="test-coverage-title-icon">
          <FlaskConical size={24} />
        </div>

        <div>
          <h1>Test Coverage Analyzer</h1>
          <p>
            Find untested source files, inspect test relationships, and
            review available coverage reports.
          </p>
        </div>
      </div>

      <section className="test-coverage-input-card">
        <div className="test-coverage-field">
          <label>Project path</label>
          <input
            value={projectPath}
            onChange={(event) =>
              onProjectPathChange?.(event.target.value)
            }
            placeholder="/absolute/path/to/project or https://github.com/owner/repo"
          />
        </div>

        <div className="test-coverage-field">
          <label>
            File path <span>Optional</span>
          </label>
          <input
            value={filePath}
            onChange={(event) => setFilePath(event.target.value)}
            placeholder="src/components/App.tsx"
          />
        </div>

        <button
          type="button"
          className="test-coverage-analyze-button"
          onClick={analyze}
          disabled={loading}
        >
          {loading ? (
            <>
              <span className="test-coverage-spinner" />
              Analyzing...
            </>
          ) : (
            <>
              <FlaskConical size={17} />
              Analyze Test Coverage
            </>
          )}
        </button>
      </section>

      {loading && (
        <div className="test-coverage-progress" role="status">
          <span className="test-coverage-spinner" />

          <div className="test-coverage-progress-text">
            <strong>Analyzing project… {elapsedSeconds}s</strong>
            <span>
              For a GitHub URL the first run clones the repository,
              installs dependencies and runs the tests with coverage,
              which can take a few minutes. Repeat runs use the cached
              clone and are much faster.
            </span>
          </div>

          <button
            type="button"
            className="test-coverage-cancel-button"
            onClick={cancelAnalysis}
          >
            <XCircle size={15} />
            Cancel
          </button>
        </div>
      )}

      {error && (
        <div className="test-coverage-error">
          <AlertTriangle size={18} />
          <span>{error}</span>
        </div>
      )}

      {report && (
        <>
          <div className="test-coverage-status-row">
            <div
              className={`test-coverage-success${
                report.totalTests === 0 ? " is-empty" : ""
              }`}
            >
              {report.totalTests === 0 ? (
                <AlertTriangle size={18} />
              ) : (
                <CheckCircle2 size={18} />
              )}
              <strong>{report.totalTests}</strong>
              <span>
                {report.totalTests === 0
                  ? "active tests discovered"
                  : "tests discovered"}
              </span>
            </div>

            <span className="test-coverage-scope">
              {report.scope === "file"
                ? "Single-file analysis"
                : "Project-wide analysis"}
            </span>
          </div>

          <div className="test-coverage-summary-grid">
            <SummaryCard
              value={report.totalSourceFiles}
              label="Source Files"
              icon={<FileCode2 size={18} />}
            />

            <SummaryCard
              value={report.totalTestFiles}
              label="Test Files"
              icon={<FlaskConical size={18} />}
            />

            <SummaryCard
              value={report.sourceFilesWithTests}
              label="With Tests"
              icon={<CheckCircle2 size={18} />}
            />

            <SummaryCard
              value={report.sourceFilesWithoutTests}
              label="Without Tests"
              icon={<AlertTriangle size={18} />}
            />
          </div>

          <div className="test-coverage-workspace">
            <section className="test-coverage-panel">
              <div className="test-coverage-panel-header">
                <div>
                  <h2>
                    {tab === "untested"
                      ? "Untested Source Files"
                      : "Files With Tests"}
                  </h2>
                  <p>
                    {tab === "untested"
                      ? `${report.sourceFilesWithoutTests} of ${report.totalSourceFiles} source files have no detected test relationship.`
                      : `${testedFiles.length} files are linked to at least one test. Lowest coverage first. Click a file for details.`}
                  </p>
                </div>

                <div className="test-coverage-count">
                  {tab === "untested"
                    ? report.sourceFilesWithoutTests
                    : testedFiles.length}
                </div>
              </div>

              <div className="test-coverage-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "untested"}
                  className={tab === "untested" ? "is-active" : ""}
                  onClick={() => setTab("untested")}
                >
                  Untested ({untestedFiles.length})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "tested"}
                  className={tab === "tested" ? "is-active" : ""}
                  onClick={() => setTab("tested")}
                >
                  With tests ({testedFiles.length})
                </button>
              </div>

              <div className="test-coverage-toolbar">
                <div className="test-coverage-search">
                  <Search size={17} />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search files..."
                  />
                </div>
              </div>

              <div className="test-coverage-file-list">
                {visibleFiles.length === 0 ? (
                  <div className="test-coverage-empty">
                    <CheckCircle2 size={34} />
                    <h3>
                      {tab === "untested"
                        ? "No untested source files"
                        : "No files with tests"}
                    </h3>
                    <p>
                      {tab === "untested"
                        ? "Every scanned source file has a detected test relationship."
                        : "No source file is linked to a test that contains active test cases."}
                    </p>
                  </div>
                ) : (
                  visibleFiles.map((file) => (
                    <FileRow
                      key={file.filePath}
                      file={file}
                      subtitle={fileSubtitle(file, tab)}
                      selected={
                        selection?.kind === "source" &&
                        selection.path === file.filePath
                      }
                      onClick={() => openSource(file.filePath)}
                    />
                  ))
                )}
              </div>
            </section>

            <aside className="test-coverage-panel">
              <div className="test-coverage-panel-header">
                <div>
                  <h2>Coverage Overview</h2>
                  <p>
                    {coverageAvailable && report.coverageStatus?.reportPath
                      ? `Values read from ${report.coverageStatus.reportPath}${
                          report.coverageStatus.source === "generated"
                            ? " (generated during analysis)."
                            : "."
                        }`
                      : "Values come from supported project coverage reports."}
                  </p>
                </div>
              </div>

              {coverageAvailable ? (
                <div className="test-coverage-metrics">
                  <CoverageMetric label="Lines" value={report.coverage.line} />
                  <CoverageMetric
                    label="Statements"
                    value={report.coverage.statement}
                  />
                  <CoverageMetric
                    label="Branches"
                    value={report.coverage.branch}
                  />
                  <CoverageMetric
                    label="Functions"
                    value={report.coverage.function}
                  />
                </div>
              ) : (
                <CoverageUnavailable status={report.coverageStatus} />
              )}

              <div className="test-coverage-frameworks">
                <div className="test-coverage-section-label">
                  Test frameworks
                </div>

                {report.testFrameworks.length > 0 ? (
                  <div className="test-coverage-chip-list">
                    {report.testFrameworks.map((framework) => (
                      <span className="test-coverage-chip" key={framework}>
                        {framework}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="test-coverage-muted">
                    No framework detected
                  </span>
                )}
              </div>

              <div className="test-coverage-relationship">
                <div className="test-coverage-section-label">
                  {coverageAvailable
                    ? "Test relationship"
                    : "Test relationship (estimate)"}
                </div>

                <div className="test-coverage-relationship-bar">
                  <div
                    className="test-coverage-relationship-fill"
                    style={{
                      width: `${Math.min(
                        100,
                        Math.max(0, testRelationshipPercentage ?? 0),
                      )}%`,
                    }}
                  />
                </div>

                <div className="test-coverage-relationship-value">
                  <strong>
                    {testRelationshipPercentage === undefined
                      ? "—"
                      : `${testRelationshipPercentage}%`}
                  </strong>
                  <span>of source files linked to at least one test</span>
                </div>

                {!coverageAvailable && (
                  <p className="test-coverage-estimate-note">
                    Static estimate from test file names and imports. It
                    shows which files have tests, not how much of their
                    code is executed.
                  </p>
                )}
              </div>
            </aside>
          </div>

          {selection && (
            <section
              className="test-coverage-panel test-coverage-detail"
              ref={detailPanelRef}
            >
              {selection.kind === "source" ? (
                <SourceDetail
                  filePath={selection.path}
                  detail={detail}
                  loading={detailLoading}
                  error={detailError}
                  coverageAvailable={coverageAvailable}
                  onOpenTest={openTest}
                  onClose={clearSelection}
                />
              ) : (
                <TestDetail
                  test={report.testFiles.find(
                    (item) => item.filePath === selection.path,
                  )}
                  sourceMap={sourceMap}
                  coverageAvailable={coverageAvailable}
                  onOpenSource={openSource}
                  onClose={clearSelection}
                />
              )}
            </section>
          )}

          <section className="test-coverage-panel test-coverage-tests">
            <div className="test-coverage-panel-header">
              <div>
                <h2>Test Files</h2>
                <p>
                  {report.testFiles.length} test files discovered. Click one
                  to see the coverage of the files it tests.
                </p>
              </div>

              <div className="test-coverage-panel-icon">
                <BarChart3 size={17} />
              </div>
            </div>

            {report.testFiles.length === 0 ? (
              <div className="test-coverage-empty test-coverage-empty-small">
                <FlaskConical size={30} />
                <h3>No test files detected</h3>
                <p>
                  No supported test files were found in the scanned
                  project.
                </p>
              </div>
            ) : (
              <div className="test-coverage-test-list">
                {report.testFiles.map((testFile) => {
                  const linked = testFile.matchingSourceFiles
                    .map((file) => sourceMap.get(file)?.coverage?.line)
                    .filter((value): value is number => value !== undefined);
                  const average = linked.length
                    ? Number(
                        (
                          linked.reduce((sum, value) => sum + value, 0) /
                          linked.length
                        ).toFixed(1),
                      )
                    : undefined;

                  return (
                    <button
                      type="button"
                      className={`test-coverage-test-row is-clickable${
                        selection?.kind === "test" &&
                        selection.path === testFile.filePath
                          ? " is-selected"
                          : ""
                      }`}
                      key={testFile.filePath}
                      onClick={() => openTest(testFile.filePath)}
                    >
                      <div className="test-coverage-test-icon">
                        <FlaskConical size={16} />
                      </div>

                      <div className="test-coverage-test-content">
                        <strong>{testFile.filePath}</strong>
                        <span>
                          {testFile.testCount} tests ·{" "}
                          {testFile.matchingSourceFiles.length} linked source
                          files
                          {testFile.testCount === 0 && (
                            <em className="test-coverage-tag-warn">
                              No active tests
                            </em>
                          )}
                        </span>
                      </div>

                      <CoveragePill value={average} />
                      <ChevronRight
                        size={16}
                        className="test-coverage-chevron"
                      />
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {report.warnings.length > 0 && (
            <section className="test-coverage-notes">
              <AlertTriangle size={18} />

              <div>
                <h3>Analysis Notes</h3>

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

function fileSubtitle(file: SourceFileSummary, tab: "untested" | "tested") {
  if (tab === "tested") {
    const names = file.linkedTestFiles.map(baseName).join(", ");
    const missed =
      file.uncoveredLineCount !== undefined
        ? ` · ${file.uncoveredLineCount} uncovered lines`
        : "";
    return `Tested by ${names}${missed}`;
  }

  if (file.coverage?.line !== undefined && file.coverage.line > 0) {
    return "No linked test · partly executed through other tests";
  }

  return "Recommended candidate for adding tests";
}

function FileRow({
  file,
  subtitle,
  selected,
  onClick,
}: {
  file: SourceFileSummary;
  subtitle: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`test-coverage-file is-clickable${
        selected ? " is-selected" : ""
      }`}
      onClick={onClick}
    >
      <div className="test-coverage-file-icon">
        <FileCode2 size={17} />
      </div>

      <div className="test-coverage-file-content">
        <strong>{file.filePath}</strong>
        <span>{subtitle}</span>
      </div>

      <CoveragePill value={file.coverage?.line} />
      <ChevronRight size={16} className="test-coverage-chevron" />
    </button>
  );
}

function CoveragePill({ value }: { value?: number }) {
  return (
    <span
      className={`test-coverage-pill test-coverage-pill-${getCoverageTone(value)}`}
      title={value === undefined ? "No coverage data" : "Line coverage"}
    >
      {value === undefined ? "no data" : `${value}%`}
    </span>
  );
}

function SourceDetail({
  filePath,
  detail,
  loading,
  error,
  coverageAvailable,
  onOpenTest,
  onClose,
}: {
  filePath: string;
  detail: FileCoverageDetail | null;
  loading: boolean;
  error: string;
  coverageAvailable: boolean;
  onOpenTest: (testPath: string) => void;
  onClose: () => void;
}) {
  const [focused, setFocused] = useState(true);

  return (
    <>
      <div className="test-coverage-panel-header">
        <div>
          <h2>{filePath}</h2>
          <p>Coverage and uncovered code for this file.</p>
        </div>

        <button
          type="button"
          className="test-coverage-close-button"
          onClick={onClose}
          aria-label="Close details"
        >
          <X size={16} />
        </button>
      </div>

      {loading && (
        <div className="test-coverage-detail-body test-coverage-detail-loading">
          <span className="test-coverage-spinner" />
          Loading file details…
        </div>
      )}

      {error && (
        <div className="test-coverage-detail-body">
          <div className="test-coverage-error">
            <AlertTriangle size={18} />
            <span>{error}</span>
          </div>
        </div>
      )}

      {detail && (
        <div className="test-coverage-detail-body">
          <div className="test-coverage-section-label">Covered by tests</div>
          {detail.linkedTestFiles.length > 0 ? (
            <div className="test-coverage-chip-list">
              {detail.linkedTestFiles.map((testPath) => (
                <button
                  type="button"
                  key={testPath}
                  className="test-coverage-chip test-coverage-chip-button"
                  onClick={() => onOpenTest(testPath)}
                >
                  {testPath}
                </button>
              ))}
            </div>
          ) : (
            <span className="test-coverage-muted">
              No test file is linked to this file by name or import.
            </span>
          )}

          {!coverageAvailable ? (
            <p className="test-coverage-detail-note">
              No coverage report is available for this project, so
              percentages and uncovered lines cannot be shown. See the
              Coverage Overview for how to enable it.
            </p>
          ) : !detail.coverage ? (
            <p className="test-coverage-detail-note">
              This file is not in the coverage report. It was probably not
              imported by any executed test, or it is excluded by the
              coverage <code>include</code> / <code>exclude</code> settings.
            </p>
          ) : (
            <>
              <div className="test-coverage-metrics test-coverage-metrics-flush">
                <CoverageMetric label="Lines" value={detail.coverage.line} />
                <CoverageMetric
                  label="Statements"
                  value={detail.coverage.statement}
                />
                <CoverageMetric
                  label="Branches"
                  value={detail.coverage.branch}
                />
                <CoverageMetric
                  label="Functions"
                  value={detail.coverage.function}
                />
              </div>

              {detail.neverExecuted && (
                <p className="test-coverage-detail-note">
                  No test executes any line of this file. Every line is
                  uncovered.
                </p>
              )}

              {!detail.hasLineDetail ? (
                <p className="test-coverage-detail-note">
                  The report only contains percentages (
                  <code>coverage-summary.json</code>). Add the{" "}
                  <code>json</code> or <code>lcov</code> reporter to also see
                  which lines, functions and branches are uncovered.
                </p>
              ) : (
                <>
                  <div className="test-coverage-section-label">
                    Uncovered lines
                  </div>
                  {detail.uncoveredLines.length > 0 ? (
                    <div className="test-coverage-chip-list">
                      {detail.uncoveredLines.map((range) => (
                        <span
                          key={range.start}
                          className="test-coverage-chip test-coverage-chip-danger"
                        >
                          {formatRange(range)}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="test-coverage-muted">
                      Every line is covered.
                    </span>
                  )}

                  {detail.uncoveredFunctions.length > 0 && (
                    <>
                      <div className="test-coverage-section-label test-coverage-gap-top">
                        Functions never called
                      </div>
                      <ul className="test-coverage-detail-list">
                        {detail.uncoveredFunctions.map((fn) => (
                          <li key={`${fn.name}-${fn.line}`}>
                            <code>{fn.name}</code>
                            <span>line {fn.line}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}

                  {detail.uncoveredBranches.length > 0 && (
                    <>
                      <div className="test-coverage-section-label test-coverage-gap-top">
                        Branches never taken
                      </div>
                      <ul className="test-coverage-detail-list">
                        {detail.uncoveredBranches.map((branch, index) => (
                          <li key={`${branch.line}-${index}`}>
                            <code>{branch.type}</code>
                            <span>line {branch.line}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}

                  {detail.source !== undefined && (
                    <>
                      <div className="test-coverage-code-header">
                        <div className="test-coverage-section-label">
                          Source
                        </div>

                        {detail.uncoveredLines.length > 0 && (
                          <label className="test-coverage-toggle">
                            <input
                              type="checkbox"
                              checked={focused}
                              onChange={(event) =>
                                setFocused(event.target.checked)
                              }
                            />
                            Uncovered lines only (with context)
                          </label>
                        )}
                      </div>

                      <CodeViewer
                        source={detail.source}
                        ranges={detail.uncoveredLines}
                        focused={focused}
                      />

                      {detail.sourceTruncated && (
                        <p className="test-coverage-detail-note">
                          The file is large, so only the first part of the
                          source is shown.
                        </p>
                      )}
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}

function TestDetail({
  test,
  sourceMap,
  coverageAvailable,
  onOpenSource,
  onClose,
}: {
  test?: TestFileReport;
  sourceMap: Map<string, SourceFileSummary>;
  coverageAvailable: boolean;
  onOpenSource: (filePath: string) => void;
  onClose: () => void;
}) {
  if (!test) return null;

  return (
    <>
      <div className="test-coverage-panel-header">
        <div>
          <h2>{test.filePath}</h2>
          <p>
            {test.testCount} tests · {test.matchingSourceFiles.length} linked
            source files. Click a file to see what is still uncovered.
          </p>
        </div>

        <button
          type="button"
          className="test-coverage-close-button"
          onClick={onClose}
          aria-label="Close details"
        >
          <X size={16} />
        </button>
      </div>

      <div className="test-coverage-detail-body">
        {test.matchingSourceFiles.length === 0 ? (
          <span className="test-coverage-muted">
            This test file is not linked to any source file by name or import.
          </span>
        ) : (
          <div className="test-coverage-linked-list">
            {test.matchingSourceFiles.map((file) => {
              const summary = sourceMap.get(file);

              return (
                <button
                  type="button"
                  className="test-coverage-linked-row"
                  key={file}
                  onClick={() => onOpenSource(file)}
                >
                  <div className="test-coverage-file-content">
                    <strong>{file}</strong>
                    <span>
                      {summary?.uncoveredLineCount !== undefined
                        ? `${summary.uncoveredLineCount} uncovered lines`
                        : "Click for details"}
                    </span>
                  </div>

                  <CoveragePill value={summary?.coverage?.line} />
                  <ChevronRight size={16} className="test-coverage-chevron" />
                </button>
              );
            })}
          </div>
        )}

        <p className="test-coverage-detail-note">
          {coverageAvailable
            ? "Coverage is measured for the whole test run, not per test file, so a source file's percentage includes every test that executes it."
            : "No coverage report is available, so percentages cannot be shown."}
        </p>
      </div>
    </>
  );
}

function CodeViewer({
  source,
  ranges,
  focused,
}: {
  source: string;
  ranges: LineRange[];
  focused: boolean;
}) {
  const lines = useMemo(() => source.split(/\r?\n/), [source]);

  const uncovered = useMemo(() => {
    const set = new Set<number>();
    for (const range of ranges) {
      for (let line = range.start; line <= range.end; line++) set.add(line);
    }
    return set;
  }, [ranges]);

  const visible = useMemo(() => {
    if (!focused || uncovered.size === 0) return null;

    const CONTEXT = 3;
    const keep = new Set<number>();
    for (const line of uncovered) {
      for (let n = line - CONTEXT; n <= line + CONTEXT; n++) {
        if (n >= 1 && n <= lines.length) keep.add(n);
      }
    }
    return keep;
  }, [focused, uncovered, lines.length]);

  const rows: ReactNode[] = [];
  let previous = 0;

  lines.forEach((text, index) => {
    const lineNumber = index + 1;

    if (visible && !visible.has(lineNumber)) return;

    if (visible && previous > 0 && lineNumber - previous > 1) {
      rows.push(
        <div className="test-coverage-code-gap" key={`gap-${lineNumber}`}>
          ⋯ {lineNumber - previous - 1} covered lines hidden ⋯
        </div>,
      );
    }

    previous = lineNumber;

    rows.push(
      <div
        key={lineNumber}
        className={`test-coverage-code-line${
          uncovered.has(lineNumber) ? " is-uncovered" : ""
        }`}
      >
        <span className="test-coverage-code-no">{lineNumber}</span>
        <code>{text === "" ? " " : text}</code>
      </div>,
    );
  });

  return <div className="test-coverage-code">{rows}</div>;
}

function SummaryCard({
  value,
  label,
  icon,
}: {
  value: string | number;
  label: string;
  icon: ReactNode;
}) {
  return (
    <div className="test-coverage-summary-card">
      <div className="test-coverage-summary-icon">{icon}</div>

      <div>
        <strong>{value}</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}

function CoverageMetric({
  label,
  value,
}: {
  label: string;
  value?: number;
}) {
  const tone = getCoverageTone(value);

  return (
    <div className={`test-coverage-metric test-coverage-${tone}`}>
      <div>
        <span>{label}</span>
        <BarChart3 size={15} />
      </div>

      <strong>{formatPercentage(value)}</strong>
    </div>
  );
}

function CoverageUnavailable({ status }: { status?: CoverageStatus }) {
  const title = status?.title ?? "No coverage report available";
  const message =
    status?.message ??
    "No coverage report was found for this project, so percentages cannot be shown.";
  const suggestions = status?.suggestions ?? [];

  return (
    <div className="test-coverage-unavailable" role="status">
      <div className="test-coverage-unavailable-icon">
        <Info size={20} />
      </div>

      <div className="test-coverage-unavailable-body">
        <h3>{title}</h3>
        <p>{message}</p>

        {suggestions.length > 0 && (
          <>
            <div className="test-coverage-section-label">How to fix</div>
            <ol>
              {suggestions.map((suggestion) => (
                <li key={suggestion}>{renderInlineCode(suggestion)}</li>
              ))}
            </ol>
          </>
        )}
      </div>
    </div>
  );
}