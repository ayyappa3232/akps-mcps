import { useMemo, useState } from "react";
import {
    AlertTriangle,
    CheckCircle2,
    FileCode2,
    FileWarning,
    FunctionSquare,
    Lightbulb,
    Search,
    ShieldAlert,
    Type,
    Variable,
} from "lucide-react";
import "./dead-code.css";

type DeadCodeSeverity = "info" | "low" | "medium" | "high";

type DeadCodeKind =
    | "unused-import"
    | "unused-variable"
    | "unused-function"
    | "unused-class"
    | "unused-type"
    | "unused-interface"
    | "unused-enum"
    | "unused-export"
    | "unused-file";

type DeadCodeIssue = {
    id: string;
    kind: DeadCodeKind;
    severity: DeadCodeSeverity;
    name: string;
    filePath: string;
    line: number;
    column: number;
    message: string;
    reason: string;
    suggestion: string;
    exported: boolean;
    references: number;
};

type DeadCodeSummary = {
    unusedFiles: number;
    unusedImports: number;
    unusedVariables: number;
    unusedFunctions: number;
    unusedClasses: number;
    unusedTypes: number;
    unusedInterfaces: number;
    unusedEnums: number;
    unusedExports: number;
    totalIssues: number;
};

type DeadCodeReport = {
    success: boolean;
    projectPath: string;
    filePath?: string;
    symbol?: string;
    summary: DeadCodeSummary;
    issues: DeadCodeIssue[];
    warnings: string[];
    recommendations: string[];
    error?: string;
};

type DeadCodeAnalyzerProps = {
    projectPath: string;
    apiUrl?: string;
    defaultFilePath?: string;
    defaultSymbol?: string;
};

type AnalyzerTab =
    | "overview"
    | "issues"
    | "recommendations";

function severityClass(
    severity: DeadCodeSeverity,
): string {
    return `dca-severity-${severity}`;
}

function kindLabel(
    kind: DeadCodeKind,
): string {
    const labels: Record<DeadCodeKind, string> = {
        "unused-import": "Unused import",
        "unused-variable": "Unused variable",
        "unused-function": "Unused function",
        "unused-class": "Unused class",
        "unused-type": "Unused type",
        "unused-interface": "Unused interface",
        "unused-enum": "Unused enum",
        "unused-export": "Unused export",
        "unused-file": "Unused file",
    };

    return labels[kind];
}

function kindIcon(
    kind: DeadCodeKind,
) {
    switch (kind) {
        case "unused-import":
            return <FileCode2 size={15} />;

        case "unused-function":
        case "unused-class":
            return <FunctionSquare size={15} />;

        case "unused-variable":
            return <Variable size={15} />;

        case "unused-type":
        case "unused-interface":
        case "unused-enum":
            return <Type size={15} />;

        default:
            return <FileWarning size={15} />;
    }
}

function shortPath(
    filePath: string,
): string {
    const parts =
        filePath.split(/[\\/]/).filter(Boolean);

    if (parts.length <= 2) {
        return filePath;
    }

    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

export default function DeadCodeAnalyzer({
    projectPath,
    apiUrl = "http://127.0.0.1:4174/api/analyze-dead-code",
    defaultFilePath = "",
    defaultSymbol = "",
}: DeadCodeAnalyzerProps) {
    const [filePath, setFilePath] =
        useState(defaultFilePath);

    const [symbol, setSymbol] =
        useState(defaultSymbol);

    const [report, setReport] =
        useState<DeadCodeReport | null>(null);

    const [loading, setLoading] =
        useState(false);

    const [error, setError] =
        useState("");

    const [tab, setTab] =
        useState<AnalyzerTab>("overview");

    const [selectedIssue, setSelectedIssue] =
        useState<DeadCodeIssue | null>(null);

    async function analyze(): Promise<void> {
        setLoading(true);
        setError("");
        setSelectedIssue(null);

        try {
            const response =
                await fetch(apiUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type":
                            "application/json",
                    },
                    body: JSON.stringify({
                        projectPath:
                            projectPath.trim(),

                        filePath:
                            filePath.trim() ||
                            undefined,

                        symbol:
                            symbol.trim() ||
                            undefined,
                    }),
                });

            const data =
                (await response.json()) as DeadCodeReport;

            if (
                !response.ok ||
                !data.success
            ) {
                throw new Error(
                    data.error ??
                    `Request failed with status ${response.status}`,
                );
            }

            setReport(data);
            setTab("overview");

            if (data.issues.length > 0) {
                setSelectedIssue(data.issues[0]);
            } else {
                setSelectedIssue(null);
            }
        } catch (reason) {
            setReport(null);

            setError(
                reason instanceof Error
                    ? reason.message
                    : "Unable to analyze dead code.",
            );
        } finally {
            setLoading(false);
        }
    }

    const severityCounts =
        useMemo(() => {
            const counts = {
                high: 0,
                medium: 0,
                low: 0,
                info: 0,
            };

            report?.issues.forEach(
                (issue) => {
                    counts[issue.severity] += 1;
                },
            );

            return counts;
        }, [report]);

    const summaryCards =
        report
            ? [
                {
                    icon: <FileWarning size={20} />,
                    value:
                        report.summary.totalIssues,
                    label: "Total issues",
                    className:
                        "dca-neutral",
                },
                {
                    icon: <FileCode2 size={20} />,
                    value:
                        report.summary.unusedImports,
                    label: "Unused imports",
                    className:
                        "dca-blue",
                },
                {
                    icon: <FunctionSquare size={20} />,
                    value:
                        report.summary.unusedFunctions +
                        report.summary.unusedClasses,
                    label: "Unused functions",
                    className:
                        "dca-purple",
                },
                {
                    icon: <Variable size={20} />,
                    value:
                        report.summary.unusedVariables,
                    label: "Unused variables",
                    className:
                        "dca-neutral",
                },
                {
                    icon: <Type size={20} />,
                    value:
                        report.summary.unusedTypes +
                        report.summary.unusedInterfaces +
                        report.summary.unusedEnums,
                    label: "Unused types",
                    className:
                        "dca-neutral",
                },
            ]
            : [];

    function selectTab(
        nextTab: AnalyzerTab,
    ): void {
        setSelectedIssue(null);
        setTab(nextTab);
    }

    return (
        <div className="aci dca">
            <header className="aci-heading dca-heading">
                <div>
                    <div className="dca-title-row">
                        <Search size={18} />
                        <h2>
                            Dead Code Analyzer
                        </h2>
                    </div>

                    <p>
                        Find potentially unused
                        imports, variables,
                        functions, classes, and
                        types before cleanup.
                    </p>
                </div>

                <span className="aci-ready">
                    {loading
                        ? "Analyzing…"
                        : report
                            ? "Analysis ready"
                            : "Ready"}
                </span>
            </header>

            <div className="aci-howto dca-howto">
                <Lightbulb size={16} />

                <div>
                    <strong>
                        How to use it:
                    </strong>{" "}
                    Enter a source file and
                    optional symbol, then run
                    the analyzer. Review every
                    finding before removing
                    code because static analysis
                    cannot detect every dynamic
                    or external usage.
                </div>
            </div>

            <div className="aci-controls-panel dca-controls-panel">
                <div className="aci-controls dca-controls">
                    <label>
                        <span>
                            File path
                        </span>

                        <small>
                            Optional. Leave empty to
                            scan the project.
                        </small>

                        <input
                            value={filePath}
                            onChange={(event) =>
                                setFilePath(
                                    event.target.value,
                                )
                            }
                            placeholder="src/App.tsx"
                        />
                    </label>

                    <label>
                        <span>
                            Symbol
                        </span>

                        <small>
                            Optional function,
                            component, class, or
                            declaration name.
                        </small>

                        <input
                            value={symbol}
                            onChange={(event) =>
                                setSymbol(
                                    event.target.value,
                                )
                            }
                            placeholder="generateGraph"
                        />
                    </label>

                    <button
                        className="aci-primary"
                        type="button"
                        onClick={() =>
                            void analyze()
                        }
                        disabled={
                            loading ||
                            !projectPath.trim()
                        }
                    >
                        {loading
                            ? "Analyzing dead code…"
                            : "Analyze dead code"}
                    </button>
                </div>
            </div>

            {error && (
                <div className="aci-message error">
                    <strong>
                        Analysis failed:
                    </strong>{" "}
                    {error}
                </div>
            )}

            {report && (
                <>
                    <div className="dca-status">
                        <span className="dca-status-pill">
                            {report.summary.totalIssues ===
                                0 ? (
                                <CheckCircle2
                                    size={17}
                                />
                            ) : (
                                <AlertTriangle
                                    size={17}
                                />
                            )}

                            {report.summary.totalIssues ===
                                0
                                ? "No unused-code candidates found"
                                : `${report.summary.totalIssues} candidate${report.summary.totalIssues === 1 ? "" : "s"} found`}
                        </span>

                        <span className="dca-target-line">
                            {report.filePath ||
                                "Project-wide analysis"}

                            {report.symbol
                                ? ` · ${report.symbol}`
                                : ""}
                        </span>
                    </div>

                    <div className="dca-stats">
                        {summaryCards.map(
                            (card) => (
                                <div
                                    className={`dca-stat ${card.className}`}
                                    key={
                                        card.label
                                    }
                                >
                                    <span className="dca-stat-icon">
                                        {card.icon}
                                    </span>

                                    <span>
                                        <strong>
                                            {
                                                card.value
                                            }
                                        </strong>

                                        <small>
                                            {
                                                card.label
                                            }
                                        </small>
                                    </span>
                                </div>
                            ),
                        )}
                    </div>

                    <div className="dca-workspace">
                        <section className="dca-main-panel">
                            <div className="dca-panel-toolbar">
                                <div>
                                    <h3>
                                        Dead code findings
                                    </h3>

                                    <p>
                                        Review static-analysis
                                        candidates before
                                        removing code.
                                    </p>
                                </div>

                                <div className="dca-severity-summary">
                                    <span className="dca-count high">
                                        High{" "}
                                        {severityCounts.high}
                                    </span>

                                    <span className="dca-count medium">
                                        Medium{" "}
                                        {severityCounts.medium}
                                    </span>

                                    <span className="dca-count low">
                                        Low{" "}
                                        {severityCounts.low}
                                    </span>

                                    <span className="dca-count info">
                                        Info{" "}
                                        {severityCounts.info}
                                    </span>
                                </div>
                            </div>

                            <div className="dca-tabs">
                                <button
                                    type="button"
                                    className={
                                        tab === "overview"
                                            ? "active"
                                            : ""
                                    }
                                    onClick={() =>
                                        selectTab(
                                            "overview",
                                        )
                                    }
                                >
                                    Overview
                                </button>

                                <button
                                    type="button"
                                    className={
                                        tab === "issues"
                                            ? "active"
                                            : ""
                                    }
                                    onClick={() =>
                                        selectTab(
                                            "issues",
                                        )
                                    }
                                >
                                    Issues
                                </button>

                                <button
                                    type="button"
                                    className={
                                        tab ===
                                            "recommendations"
                                            ? "active"
                                            : ""
                                    }
                                    onClick={() =>
                                        selectTab(
                                            "recommendations",
                                        )
                                    }
                                >
                                    Recommendations
                                </button>
                            </div>

                            <div className="dca-main-content">
                                {tab ===
                                    "overview" && (
                                        <div className="dca-overview">
                                            <div className="dca-overview-card">
                                                <ShieldAlert
                                                    size={18}
                                                />

                                                <div>
                                                    <strong>
                                                        Static analysis
                                                    </strong>

                                                    <p>
                                                        These findings
                                                        indicate code
                                                        that currently
                                                        has no detected
                                                        references in
                                                        the analyzed
                                                        TypeScript
                                                        program.
                                                    </p>
                                                </div>
                                            </div>

                                            <div className="dca-overview-grid">
                                                <div>
                                                    <span>
                                                        High
                                                    </span>

                                                    <strong>
                                                        {
                                                            severityCounts.high
                                                        }
                                                    </strong>
                                                </div>

                                                <div>
                                                    <span>
                                                        Medium
                                                    </span>

                                                    <strong>
                                                        {
                                                            severityCounts.medium
                                                        }
                                                    </strong>
                                                </div>

                                                <div>
                                                    <span>
                                                        Low
                                                    </span>

                                                    <strong>
                                                        {
                                                            severityCounts.low
                                                        }
                                                    </strong>
                                                </div>

                                                <div>
                                                    <span>
                                                        Info
                                                    </span>

                                                    <strong>
                                                        {
                                                            severityCounts.info
                                                        }
                                                    </strong>
                                                </div>
                                            </div>

                                            {report.warnings
                                                .length >
                                                0 && (
                                                    <div className="dca-warning-box">
                                                        <AlertTriangle
                                                            size={17}
                                                        />

                                                        <div>
                                                            <strong>
                                                                Analysis warnings
                                                            </strong>

                                                            {report.warnings.map(
                                                                (
                                                                    warning,
                                                                    index,
                                                                ) => (
                                                                    <p
                                                                        key={
                                                                            index
                                                                        }
                                                                    >
                                                                        {
                                                                            warning
                                                                        }
                                                                    </p>
                                                                ),
                                                            )}
                                                        </div>
                                                    </div>
                                                )}
                                        </div>
                                    )}

                                {tab ===
                                    "issues" && (
                                        <div className="dca-issues">
                                            {report.issues.length ===
                                                0 ? (
                                                <div className="dca-empty">
                                                    <CheckCircle2
                                                        size={28}
                                                    />

                                                    <h3>
                                                        No issues found
                                                    </h3>

                                                    <p>
                                                        The analyzer did
                                                        not identify
                                                        potentially
                                                        unused code.
                                                    </p>
                                                </div>
                                            ) : (
                                                report.issues.map(
                                                    (issue) => (
                                                        <button
                                                            type="button"
                                                            key={
                                                                issue.id
                                                            }
                                                            className={`dca-issue-row ${selectedIssue?.id ===
                                                                issue.id
                                                                ? "selected"
                                                                : ""
                                                                }`}
                                                            onClick={() =>
                                                                setSelectedIssue(
                                                                    issue,
                                                                )
                                                            }
                                                        >
                                                            <span
                                                                className={`dca-issue-icon ${severityClass(issue.severity)}`}
                                                            >
                                                                {kindIcon(
                                                                    issue.kind,
                                                                )}
                                                            </span>

                                                            <span className="dca-issue-copy">
                                                                <strong>
                                                                    {
                                                                        issue.name
                                                                    }
                                                                </strong>

                                                                <small>
                                                                    {
                                                                        kindLabel(
                                                                            issue.kind,
                                                                        )
                                                                    }{" "}
                                                                    ·{" "}
                                                                    {shortPath(
                                                                        issue.filePath,
                                                                    )}{" "}
                                                                    · line{" "}
                                                                    {
                                                                        issue.line
                                                                    }
                                                                </small>
                                                            </span>

                                                            <span
                                                                className={`dca-severity ${severityClass(issue.severity)}`}
                                                            >
                                                                {
                                                                    issue.severity
                                                                }
                                                            </span>
                                                        </button>
                                                    ),
                                                )
                                            )}
                                        </div>
                                    )}

                                {tab ===
                                    "recommendations" && (
                                        <div className="dca-recommendations">
                                            {report.recommendations.map(
                                                (
                                                    recommendation,
                                                    index,
                                                ) => (
                                                    <div
                                                        className="dca-recommendation"
                                                        key={
                                                            index
                                                        }
                                                    >
                                                        <Lightbulb
                                                            size={17}
                                                        />

                                                        <p>
                                                            {
                                                                recommendation
                                                            }
                                                        </p>
                                                    </div>
                                                ),
                                            )}
                                        </div>
                                    )}
                            </div>
                        </section>

                        <aside className="dca-inspector">
                            <div className="dca-inspector-head">
                                <div>
                                    <h3>
                                        Dead Code Inspector
                                    </h3>

                                    <p>
                                        Select a finding to
                                        inspect why it was
                                        reported.
                                    </p>
                                </div>
                            </div>

                            <div className="dca-inspector-body">
                                {selectedIssue ? (
                                    <>
                                        <div className="dca-detail-title">
                                            <span
                                                className={`dca-detail-icon ${severityClass(selectedIssue.severity)}`}
                                            >
                                                {kindIcon(
                                                    selectedIssue.kind,
                                                )}
                                            </span>

                                            <div>
                                                <h3>
                                                    {
                                                        selectedIssue.name
                                                    }
                                                </h3>

                                                <span
                                                    className={`dca-severity ${severityClass(selectedIssue.severity)}`}
                                                >
                                                    {
                                                        selectedIssue.severity
                                                    }
                                                </span>
                                            </div>
                                        </div>

                                        <section className="dca-detail-section">
                                            <h4>
                                                Type
                                            </h4>

                                            <p>
                                                {
                                                    kindLabel(
                                                        selectedIssue.kind,
                                                    )
                                                }
                                            </p>
                                        </section>

                                        <section className="dca-detail-section">
                                            <h4>
                                                Location
                                            </h4>

                                            <p className="dca-code-path">
                                                {
                                                    selectedIssue.filePath
                                                }
                                                <br />
                                                Line{" "}
                                                {
                                                    selectedIssue.line
                                                }
                                                , column{" "}
                                                {
                                                    selectedIssue.column
                                                }
                                            </p>
                                        </section>

                                        <section className="dca-detail-section">
                                            <h4>
                                                Why was this reported?
                                            </h4>

                                            <p>
                                                {
                                                    selectedIssue.reason
                                                }
                                            </p>
                                        </section>

                                        <section className="dca-detail-section">
                                            <h4>
                                                Suggested action
                                            </h4>

                                            <p>
                                                {
                                                    selectedIssue.suggestion
                                                }
                                            </p>
                                        </section>

                                        <section className="dca-detail-section">
                                            <h4>
                                                Reference count
                                            </h4>

                                            <div className="dca-reference-count">
                                                {
                                                    selectedIssue.references
                                                }
                                            </div>
                                        </section>

                                        {selectedIssue.exported && (
                                            <div className="dca-export-warning">
                                                <AlertTriangle
                                                    size={16}
                                                />

                                                <span>
                                                    This symbol is
                                                    exported. External
                                                    consumers may not
                                                    be visible to this
                                                    analyzer.
                                                </span>
                                            </div>
                                        )}
                                    </>
                                ) : (
                                    <div className="dca-inspector-empty">
                                        <FileWarning size={30} />

                                        <h3>
                                            No dead-code finding selected
                                        </h3>

                                        <p>
                                            Run the analyzer to identify
                                            potentially unused code.
                                            Select a finding to inspect
                                            its location, reason, and
                                            suggested action.
                                        </p>
                                    </div>
                                )}
                            </div>
                        </aside>
                    </div>
                </>
            )}
        </div>
    );
}