import fs from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export type SecuritySeverity = "critical" | "high" | "medium" | "low" | "info";

export type SecurityCategory =
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

export interface SecurityFinding {
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

export interface SecuritySummary {
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

export interface SecurityReport {
  success: boolean;
  tool: "analyze_security";
  projectPath: string;
  filePath?: string;
  totalFindings: number;
  findings: SecurityFinding[];
  summary: SecuritySummary;
  warnings: string[];
}

interface SourceFileInfo {
  absolutePath: string;
  relativePath: string;
  sourceFile: ts.SourceFile;
}

const SUPPORTED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs",
]);

const IGNORED_DIRECTORIES = new Set([
  "node_modules", "dist", "build", "coverage", ".git",
  ".next", ".turbo", ".cache", ".vite",
]);

function scriptKind(filePath: string): ts.ScriptKind {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if ([".js", ".mjs", ".cjs"].includes(extension)) {
    return ts.ScriptKind.JS;
  }

  return ts.ScriptKind.TS;
}

function isSupportedFile(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function collectSourceFiles(
  projectPath: string,
  requestedFile?: string
): SourceFileInfo[] {
  const files: SourceFileInfo[] = [];

  function addFile(absolutePath: string): void {
    if (!requestedFile) {
      try {
        if (fs.statSync(absolutePath).size > 2_000_000) return;
      } catch {
        return;
      }
    }

    files.push({
      absolutePath,
      relativePath: normalizePath(path.relative(projectPath, absolutePath)),
      sourceFile: ts.createSourceFile(
        absolutePath,
        fs.readFileSync(absolutePath, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        scriptKind(absolutePath)
      ),
    });
  }

  if (requestedFile) {
    const absolutePath = path.resolve(projectPath, requestedFile);

    if (!fs.existsSync(absolutePath)) {
      throw new Error(`File does not exist: ${requestedFile}`);
    }

    if (!isSupportedFile(absolutePath)) {
      throw new Error(`Unsupported source file type: ${requestedFile}`);
    }

    addFile(absolutePath);
    return files;
  }

  function walk(directory: string): void {
    let entries: Dirent[];

    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          walk(fullPath);
        }
        continue;
      }

      if (entry.isFile() && isSupportedFile(fullPath)) {
        addFile(fullPath);
      }
    }
  }

  walk(projectPath);
  return files;
}

function location(
  sourceFile: ts.SourceFile,
  node: ts.Node
): { line: number; column: number } {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));

  return {
    line: position.line + 1,
    column: position.character + 1,
  };
}

function callName(node: ts.CallExpression): string {
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text;
  }

  if (ts.isPropertyAccessExpression(node.expression)) {
    return node.expression.getText();
  }

  return "";
}

function isStringLiteralArg(
  argument: ts.Expression | undefined
): argument is ts.StringLiteral {
  return argument !== undefined && ts.isStringLiteral(argument);
}

function addFinding(
  findings: SecurityFinding[],
  source: SourceFileInfo,
  node: ts.Node,
  data: Omit<SecurityFinding, "id" | "filePath" | "line" | "column" | "expression">
): void {
  const position = location(source.sourceFile, node);

  const id = [
    source.relativePath,
    position.line,
    position.column,
    data.category,
    data.title,
  ].join(":");

  if (findings.some((item) => item.id === id)) {
    return;
  }

  findings.push({
    id,
    filePath: source.relativePath,
    line: position.line,
    column: position.column,
    expression: node.getText(source.sourceFile).slice(0, 500),
    ...data,
  });
}

function nodeAtPosition(
  sourceFile: ts.SourceFile,
  position: number
): ts.Node | undefined {
  let result: ts.Node | undefined;

  function visit(node: ts.Node): void {
    if (
      position >= node.getStart(sourceFile) &&
      position <= node.getEnd()
    ) {
      result = node;
      node.forEachChild(visit);
    }
  }

  visit(sourceFile);
  return result;
}

function analyzeSecrets(
  source: SourceFileInfo,
  findings: SecurityFinding[]
): void {
  const patterns = [
    {
      name: "AWS access key",
      pattern: /\bAKIA[0-9A-Z]{16}\b/,
      severity: "critical" as SecuritySeverity,
      description: "A value resembles an AWS access key.",
      recommendation:
        "Remove it from source control, rotate it immediately, and load credentials from a secure secret store.",
    },
    {
      name: "Hardcoded API key or token",
      pattern:
        /\b(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token)\s*[:=]\s*["'][^"']{12,}["']/i,
      severity: "high" as SecuritySeverity,
      description:
        "A source assignment appears to contain a hardcoded credential.",
      recommendation:
        "Move the credential to secure environment configuration or a secret manager and rotate the exposed value.",
    },
    {
      name: "Bearer token",
      pattern:
        /\bAuthorization\s*[:=]\s*["']Bearer\s+[A-Za-z0-9._~+/=-]{16,}["']/i,
      severity: "high" as SecuritySeverity,
      description:
        "A bearer token appears to be embedded directly in source code.",
      recommendation:
        "Remove the token from source control and use short-lived runtime credentials.",
    },
    {
      name: "Private key",
      pattern:
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
      severity: "critical" as SecuritySeverity,
      description: "A private cryptographic key appears in source code.",
      recommendation:
        "Remove and revoke or rotate the exposed key immediately.",
    },
  ];

  const text = source.sourceFile.getFullText();

  for (const item of patterns) {
    // The "g" flag is required: without it exec() always returns the same
    // match and the while loop below never terminates.
    const flags = item.pattern.flags.includes("g")
      ? item.pattern.flags
      : `${item.pattern.flags}g`;
    const regex = new RegExp(item.pattern.source, flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      if (match[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }

      const node = nodeAtPosition(
        source.sourceFile,
        match.index
      );

      if (!node) continue;

      addFinding(findings, source, node, {
        severity: item.severity,
        category: "secrets",
        title: item.name,
        description: item.description,
        recommendation: item.recommendation,
        evidence: match[0].slice(0, 180),
        confidence: "high",
        cwe: "CWE-798",
        owasp: "A07:2021 Identification and Authentication Failures",
      });
    }
  }
}

function analyzeCalls(
  source: SourceFileInfo,
  findings: SecurityFinding[]
): void {
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const name = callName(node);
      const expression = node.getText(source.sourceFile);

      if (name === "eval") {
        addFinding(findings, source, node, {
          severity: "critical",
          category: "unsafe-code",
          title: "Dynamic code execution with eval",
          description:
            "eval() executes a string as JavaScript and can turn untrusted input into executable code.",
          recommendation:
            "Avoid eval(). Use explicit functions, structured data parsing, or a safe expression parser.",
          confidence: "high",
          cwe: "CWE-95",
          owasp: "A03:2021 Injection",
        });
      }

      if (name === "Function") {
        addFinding(findings, source, node, {
          severity: "high",
          category: "unsafe-code",
          title: "Dynamic Function constructor",
          description:
            "The Function constructor dynamically creates executable JavaScript.",
          recommendation:
            "Avoid dynamic code generation and use normal functions instead.",
          confidence: "high",
          cwe: "CWE-95",
          owasp: "A03:2021 Injection",
        });
      }

      if (
        (name === "setTimeout" || name === "setInterval") &&
        isStringLiteralArg(node.arguments[0])
      ) {
        addFinding(findings, source, node, {
          severity: "high",
          category: "unsafe-code",
          title: "String-based timer execution",
          description:
            "A string is passed to a timer API and may be evaluated as code.",
          recommendation:
            "Pass a function to the timer instead of a string.",
          confidence: "high",
          cwe: "CWE-95",
          owasp: "A03:2021 Injection",
        });
      }

      if (name === "document.write") {
        addFinding(findings, source, node, {
          severity: "high",
          category: "xss",
          title: "document.write usage",
          description:
            "document.write can become an injection sink when content is influenced by external input.",
          recommendation:
            "Prefer safe DOM APIs or framework rendering.",
          confidence: "medium",
          cwe: "CWE-79",
          owasp: "A03:2021 Injection",
        });
      }

      if (name === "localStorage.setItem" || name === "sessionStorage.setItem") {
        addFinding(findings, source, node, {
          severity: "medium",
          category: "storage",
          title: "Data stored in browser storage",
          description:
            "Browser storage is accessible to JavaScript running in the page and can expose sensitive values during XSS.",
          recommendation:
            "Do not store passwords, private keys, or long-lived sensitive tokens in localStorage or sessionStorage.",
          confidence: "medium",
          cwe: "CWE-922",
          owasp: "A05:2021 Security Misconfiguration",
        });
      }

      if (
        ["console.log", "console.error", "console.warn", "console.info"].includes(name) &&
        /(password|passwd|token|secret|authorization|cookie|private.?key|api.?key)/i.test(expression)
      ) {
        addFinding(findings, source, node, {
          severity: "high",
          category: "logging",
          title: "Potential sensitive data in logs",
          description:
            "A console statement appears to include a security-sensitive value.",
          recommendation:
            "Remove secrets and authentication material from logs. Log redacted identifiers instead.",
          confidence: "medium",
          cwe: "CWE-532",
          owasp: "A09:2021 Security Logging and Monitoring Failures",
        });
      }

      const processFunctions = new Set([
        "exec", "execSync", "spawn", "spawnSync", "execFile", "execFileSync",
      ]);

      const simpleName = name.includes(".")
        ? name.split(".").pop() || name
        : name;

      if (processFunctions.has(simpleName)) {
        const firstArgument = node.arguments[0];
        const dynamic = !!firstArgument && !ts.isStringLiteral(firstArgument);

        addFinding(findings, source, node, {
          severity: dynamic ? "high" : "medium",
          category: "injection",
          title: dynamic
            ? "Potential command injection sink"
            : "Process execution API",
          description: dynamic
            ? "A process execution API receives a dynamic argument that may be influenced by external input."
            : "The application executes a system process.",
          recommendation:
            "Never pass untrusted input directly to process execution APIs. Prefer fixed commands and strict allowlists.",
          confidence: dynamic ? "medium" : "low",
          cwe: "CWE-78",
          owasp: "A03:2021 Injection",
        });
      }

      if (
        (name === "fetch" ||
          name.endsWith(".get") ||
          name.endsWith(".post") ||
          name.endsWith(".put") ||
          name.endsWith(".patch") ||
          name.endsWith(".delete")) &&
        isStringLiteralArg(node.arguments[0]) &&
        node.arguments[0].text.startsWith("http://")
      ) {
        addFinding(findings, source, node, {
          severity: "medium",
          category: "network",
          title: "Insecure HTTP endpoint",
          description:
            "A network request uses unencrypted HTTP.",
          recommendation:
            "Use HTTPS for production traffic and avoid transmitting sensitive data over plain HTTP.",
          evidence: node.arguments[0].text,
          confidence: "high",
          cwe: "CWE-319",
          owasp: "A02:2021 Cryptographic Failures",
        });
      }

      if (expression.toLowerCase().includes("md5(") ||
          expression.toLowerCase().includes("sha1(")) {
        addFinding(findings, source, node, {
          severity: "medium",
          category: "crypto",
          title: "Weak cryptographic hash",
          description:
            "MD5 or SHA-1 appears to be used in application code.",
          recommendation:
            "Use a modern cryptographic algorithm appropriate for the security requirement.",
          confidence: "medium",
          cwe: "CWE-328",
          owasp: "A02:2021 Cryptographic Failures",
        });
      }
    }

    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "dangerouslySetInnerHTML"
    ) {
      addFinding(findings, source, node, {
        severity: "high",
        category: "xss",
        title: "React dangerouslySetInnerHTML",
        description:
          "Raw HTML is being injected into a React component.",
        recommendation:
          "Avoid raw HTML when possible. Sanitize HTML with a trusted sanitizer before rendering.",
        confidence: "high",
        cwe: "CWE-79",
        owasp: "A03:2021 Injection",
      });
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken?.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.getText(source.sourceFile) === "innerHTML"
    ) {
      addFinding(findings, source, node, {
        severity: "high",
        category: "xss",
        title: "innerHTML assignment",
        description:
          "A value is assigned directly to innerHTML.",
        recommendation:
          "Use textContent or safe framework rendering. Sanitize HTML when raw HTML is required.",
        confidence: "high",
        cwe: "CWE-79",
        owasp: "A03:2021 Injection",
      });
    }

    node.forEachChild(visit);
  }

  visit(source.sourceFile);
}

function analyzeConfiguration(
  source: SourceFileInfo,
  findings: SecurityFinding[]
): void {
  function visit(node: ts.Node): void {
    if (ts.isPropertyAssignment(node)) {
      const propertyName = node.name.getText(source.sourceFile);
      const value = node.initializer.getText(source.sourceFile);

      if (/cors/i.test(propertyName) && value === `"*"`) {
        addFinding(findings, source, node, {
          severity: "medium",
          category: "configuration",
          title: "Wildcard CORS configuration",
          description:
            "A CORS-related configuration appears to allow all origins.",
          recommendation:
            "Restrict allowed origins to the domains that actually require access.",
          confidence: "medium",
          cwe: "CWE-942",
          owasp: "A05:2021 Security Misconfiguration",
        });
      }
    }

    node.forEachChild(visit);
  }

  visit(source.sourceFile);
}

function emptySummary(): SecuritySummary {
  return {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
    secrets: 0,
    xss: 0,
    injection: 0,
    unsafeCode: 0,
    storage: 0,
    network: 0,
    crypto: 0,
    logging: 0,
    configuration: 0,
    other: 0,
  };
}

function summarize(
  findings: SecurityFinding[]
): SecuritySummary {
  const summary = emptySummary();

  for (const finding of findings) {
    summary[finding.severity] += 1;

    switch (finding.category) {
      case "secrets":
        summary.secrets += 1;
        break;
      case "xss":
        summary.xss += 1;
        break;
      case "injection":
        summary.injection += 1;
        break;
      case "unsafe-code":
        summary.unsafeCode += 1;
        break;
      case "storage":
        summary.storage += 1;
        break;
      case "network":
        summary.network += 1;
        break;
      case "crypto":
        summary.crypto += 1;
        break;
      case "logging":
        summary.logging += 1;
        break;
      case "configuration":
        summary.configuration += 1;
        break;
      default:
        summary.other += 1;
        break;
    }
  }

  return summary;
}

export async function analyzeSecurity(
  projectPath: string,
  filePath?: string
): Promise<SecurityReport> {
  const absoluteProjectPath = path.resolve(projectPath);

  if (!fs.existsSync(absoluteProjectPath)) {
    throw new Error(`Project path does not exist: ${projectPath}`);
  }

  const sourceFiles = collectSourceFiles(
    absoluteProjectPath,
    filePath
  );

  const findings: SecurityFinding[] = [];
  const scanWarnings: string[] = [];

  for (const source of sourceFiles) {
    try {
      findings.push(...analyzeFile(source));
    } catch (error) {
      // One problematic file must not abort the whole scan.
      scanWarnings.push(
        `Skipped ${source.relativePath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  findings.sort((a, b) => {
    const severityRank: Record<SecuritySeverity, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
      info: 4,
    };

    return (
      severityRank[a.severity] -
        severityRank[b.severity] ||
      a.filePath.localeCompare(b.filePath) ||
      a.line - b.line
    );
  });

  return {
    success: true,
    tool: "analyze_security",
    projectPath: absoluteProjectPath,
    filePath,
    totalFindings: findings.length,
    findings,
    summary: summarize(findings),
    warnings: [
      ...scanWarnings,
      "Static analysis identifies potentially risky patterns and does not prove exploitability.",
      "Runtime behavior, external infrastructure, server configuration, and complete dependency advisories are outside this source scan.",
      "Hardcoded secret detection can produce false positives for examples, tests, and placeholders.",
      "Security findings should be reviewed before remediation.",
    ],
  };
}

function analyzeFile(
  source: SourceFileInfo
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  analyzeSecrets(source, findings);
  analyzeCalls(source, findings);
  analyzeConfiguration(source, findings);

  return findings;
}

export function registerAnalyzeSecurityTool(
  server: McpServer
): void {
  server.registerTool(
    "analyze_security",
    {
      description:
        "Analyze TypeScript, JavaScript, and React source code for potentially insecure patterns such as hardcoded secrets, XSS sinks, unsafe dynamic execution, insecure browser storage, weak cryptography, command injection, sensitive logging, insecure HTTP, and security misconfiguration.",
      inputSchema: z.object({
        projectPath: z.string().min(1),
        filePath: z.string().optional(),
      }),
    },
    async ({ projectPath, filePath }) => {
      try {
        const report = await analyzeSecurity(
          projectPath,
          filePath
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                report,
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  tool: "analyze_security",
                  error:
                    error instanceof Error
                      ? error.message
                      : "Security analysis failed.",
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );
}