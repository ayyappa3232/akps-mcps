import { useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  FileCode2,
  FlaskConical,
  Search,
} from "lucide-react";
import "./analyze-test-coverage.css";

type TestCoverageReport = {
  success: boolean;
  tool?: "analyze_test_coverage";
  projectPath: string;
  totalSourceFiles: number;
  totalTestFiles: number;
  totalTests: number;
  sourceFilesWithTests: number;
  sourceFilesWithoutTests: number;
  coverage: {
    line?: number;
    statement?: number;
    branch?: number;
    function?: number;
  };
  testFrameworks: string[];
  testFiles: {
    filePath: string;
    testCount: number;
    matchingSourceFiles: string[];
  }[];
  untestedSourceFiles: string[];
  warnings: string[];
};

interface AnalyzeTestCoverageProps {
  projectPath: string;
  onProjectPathChange?: (value: string) => void;
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

export default function AnalyzeTestCoverage({
  projectPath,
  onProjectPathChange,
}: AnalyzeTestCoverageProps) {
  const [filePath, setFilePath] = useState("");
  const [search, setSearch] = useState("");
  const [report, setReport] = useState<TestCoverageReport | null>(null);
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
        "http://127.0.0.1:4174/api/analyze-test-coverage",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            projectPath: projectPath.trim(),
            filePath: filePath.trim() || undefined,
          }),
        },
      );

      const data = await response.json();

      if (!response.ok || data.success === false) {
        throw new Error(
          data.error || "Test coverage analysis failed.",
        );
      }

      setReport(data as TestCoverageReport);
    } catch (analysisError) {
      setReport(null);
      setError(
        analysisError instanceof Error
          ? analysisError.message
          : "Unable to analyze the project.",
      );
    } finally {
      setLoading(false);
    }
  }

  const filteredFiles = useMemo(() => {
    if (!report) return [];

    const query = search.trim().toLowerCase();

    if (!query) {
      return report.untestedSourceFiles;
    }

    return report.untestedSourceFiles.filter((file) =>
      file.toLowerCase().includes(query),
    );
  }, [report, search]);

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
            placeholder="/path/to/your/project"
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

      {error && (
        <div className="test-coverage-error">
          <AlertTriangle size={18} />
          <span>{error}</span>
        </div>
      )}

      {report && (
        <>
          <div className="test-coverage-status-row">
            <div className="test-coverage-success">
              <CheckCircle2 size={18} />
              <strong>{report.totalTests}</strong>
              <span>tests discovered</span>
            </div>

            <span className="test-coverage-scope">
              Project-wide analysis
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
                  <h2>Untested Source Files</h2>
                  <p>
                    {report.sourceFilesWithoutTests} of{" "}
                    {report.totalSourceFiles} source files have no
                    detected test relationship.
                  </p>
                </div>

                <div className="test-coverage-count">
                  {report.sourceFilesWithoutTests}
                </div>
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
                {filteredFiles.length === 0 ? (
                  <div className="test-coverage-empty">
                    <CheckCircle2 size={34} />
                    <h3>No untested source files</h3>
                    <p>
                      Every scanned source file has a detected test
                      relationship.
                    </p>
                  </div>
                ) : (
                  filteredFiles.map((file) => (
                    <div className="test-coverage-file" key={file}>
                      <div className="test-coverage-file-icon">
                        <FileCode2 size={17} />
                      </div>

                      <div className="test-coverage-file-content">
                        <strong>{file}</strong>
                        <span>
                          Recommended candidate for adding tests
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <aside className="test-coverage-panel">
              <div className="test-coverage-panel-header">
                <div>
                  <h2>Coverage Overview</h2>
                  <p>
                    Values come from supported project coverage reports.
                  </p>
                </div>
              </div>

              <div className="test-coverage-metrics">
                <CoverageMetric
                  label="Lines"
                  value={report.coverage.line}
                />
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

              <div className="test-coverage-frameworks">
                <div className="test-coverage-section-label">
                  Test frameworks
                </div>

                {report.testFrameworks.length > 0 ? (
                  <div className="test-coverage-chip-list">
                    {report.testFrameworks.map((framework) => (
                      <span
                        className="test-coverage-chip"
                        key={framework}
                      >
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
                  Test relationship
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
                  <span>
                    of source files linked to at least one test
                  </span>
                </div>
              </div>
            </aside>
          </div>

          <section className="test-coverage-panel test-coverage-tests">
            <div className="test-coverage-panel-header">
              <div>
                <h2>Test Files</h2>
                <p>
                  {report.testFiles.length} test files discovered.
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
                {report.testFiles.map((testFile) => (
                  <div
                    className="test-coverage-test-row"
                    key={testFile.filePath}
                  >
                    <div className="test-coverage-test-icon">
                      <FlaskConical size={16} />
                    </div>

                    <div className="test-coverage-test-content">
                      <strong>{testFile.filePath}</strong>
                      <span>
                        {testFile.testCount} tests ·{" "}
                        {testFile.matchingSourceFiles.length} linked
                        source files
                      </span>
                    </div>
                  </div>
                ))}
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
