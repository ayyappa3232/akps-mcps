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
  // React Native / Expo / Firebase / misc tooling output
  "Pods", ".expo", ".gradle", ".firebase", ".nx", ".parcel-cache",
  ".svelte-kit", "storybook-static",
]);

// Generated or minified files produce noise rather than actionable findings.
const IGNORED_FILE_PATTERN = /\.min\.[cm]?js$|\.d\.[cm]?ts$/i;

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
  return (
    SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase()) &&
    !IGNORED_FILE_PATTERN.test(filePath)
  );
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

    let content: string;

    try {
      content = fs.readFileSync(absolutePath, "utf8");
    } catch {
      // Unreadable file (permissions, broken symlink): skip, don't abort.
      return;
    }

    files.push({
      absolutePath,
      relativePath: normalizePath(path.relative(projectPath, absolutePath)),
      sourceFile: ts.createSourceFile(
        absolutePath,
        content,
        ts.ScriptTarget.Latest,
        true,
        scriptKind(absolutePath)
      ),
    });
  }

  if (requestedFile) {
    const absolutePath = path.resolve(projectPath, requestedFile);
    const relativeToProject = path.relative(projectPath, absolutePath);

    // The report echoes source snippets, so never read outside the project.
    if (
      relativeToProject.startsWith("..") ||
      path.isAbsolute(relativeToProject)
    ) {
      throw new Error(`File is outside the project: ${requestedFile}`);
    }

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

const SEVERITY_ORDER: SecuritySeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
];

function downgradeSeverity(severity: SecuritySeverity): SecuritySeverity {
  const index = SEVERITY_ORDER.indexOf(severity);
  return SEVERITY_ORDER[Math.min(index + 1, SEVERITY_ORDER.length - 1)];
}

// Findings in these locations are usually illustrative, not live code.
const TEST_OR_EXAMPLE_PATH =
  /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests?|specs?|mocks?|fixtures?|examples?|samples?|demos?|stories|storybook|docs?)(?:\/|$)|\.(?:test|spec|stories|mock|fixture|example)\.[cm]?[jt]sx?$/i;

// Values that are obviously not real credentials (AWS's documented
// AKIAIOSFODNN7EXAMPLE key, "your-api-key-here", "xxxxxxxx", "${VAR}", ...).
const PLACEHOLDER_VALUE =
  /example|sample|dummy|placeholder|changeme|fake|your[_-]|\btest\b|\bmock\b|x{6,}|\*{4,}|<[^>]+>|\$\{/i;

const SENSITIVE_KEY =
  /pass(?:word|wd)?|secret|token|jwt|credential|private.?key|api.?key|session|auth/i;

const LOOPBACK_URL =
  /^http:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i;

function skipOuter(expression: ts.Expression): ts.Expression {
  let current = expression;

  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }

  return current;
}

/** "abc" and `abc` (no substitutions) are fully static strings. */
function isStaticString(
  expression: ts.Expression | undefined
): expression is ts.StringLiteralLike {
  return (
    expression !== undefined &&
    ts.isStringLiteralLike(skipOuter(expression))
  );
}

/** Text known at parse time: a full string, or the head of a template. */
function staticPrefix(
  expression: ts.Expression | undefined
): string | undefined {
  if (!expression) return undefined;
  const inner = skipOuter(expression);

  if (ts.isStringLiteralLike(inner)) return inner.text;
  if (ts.isTemplateExpression(inner)) return inner.head.text;
  return undefined;
}

function propertyKey(name: ts.PropertyName): string {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteralLike(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }

  return name.getText();
}

function calleeName(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.getText();
  }
  return "";
}

function maskSecret(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}${"*".repeat(Math.min(12, value.length - 4))}`;
}

function lineText(sourceFile: ts.SourceFile, zeroBasedLine: number): string {
  const starts = sourceFile.getLineStarts();
  if (zeroBasedLine < 0 || zeroBasedLine >= starts.length) return "";

  const end =
    zeroBasedLine + 1 < starts.length
      ? starts[zeroBasedLine + 1]
      : sourceFile.text.length;

  return sourceFile.text.slice(starts[zeroBasedLine], end);
}

/**
 * `// security-ignore` suppresses a finding when it trails the same line, or
 * sits on its own comment line directly above it.
 */
function isSuppressed(source: SourceFileInfo, line: number): boolean {
  const marker = /security-ignore/i;
  const previous = lineText(source.sourceFile, line - 2).trim();

  return (
    marker.test(lineText(source.sourceFile, line - 1)) ||
    (/^(?:\/\/|\/\*|\*)/.test(previous) && marker.test(previous))
  );
}

type FindingData = Omit<
  SecurityFinding,
  "id" | "filePath" | "line" | "column" | "expression"
>;

function addFinding(
  findings: SecurityFinding[],
  source: SourceFileInfo,
  node: ts.Node,
  data: FindingData,
  redactions: string[] = []
): void {
  const position = location(source.sourceFile, node);

  if (isSuppressed(source, position.line)) return;

  let { severity, confidence, description } = data;

  if (TEST_OR_EXAMPLE_PATH.test(source.relativePath)) {
    severity = downgradeSeverity(severity);
    confidence = "low";
    description = `${description} (Found in a test, mock, fixture, or example file.)`;
  }

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

  // Never echo full secrets back to the UI or the MCP client.
  let expression = node.getText(source.sourceFile);
  for (const secret of redactions) {
    expression = expression.split(secret).join(maskSecret(secret));
  }

  findings.push({
    id,
    filePath: source.relativePath,
    line: position.line,
    column: position.column,
    expression: expression.slice(0, 500),
    ...data,
    severity,
    confidence,
    description,
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

interface SecretPattern {
  name: string;
  pattern: RegExp;
  severity: SecuritySeverity;
  description: string;
  recommendation: string;
  /** Mask the matched value in evidence (false for public markers). */
  mask: boolean;
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    name: "AWS access key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    severity: "critical",
    description: "A value resembles an AWS access key.",
    recommendation:
      "Remove it from source control, rotate it immediately, and load credentials from a secure secret store.",
    mask: true,
  },
  {
    name: "Hardcoded API key or token",
    pattern:
      /\b(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token)\s*[:=]\s*["'][^"']{12,}["']/i,
    severity: "high",
    description:
      "A source assignment appears to contain a hardcoded credential.",
    recommendation:
      "Move the credential to secure environment configuration or a secret manager and rotate the exposed value.",
    mask: true,
  },
  {
    name: "Bearer token",
    pattern:
      /\bAuthorization\s*[:=]\s*["']Bearer\s+[A-Za-z0-9._~+/=-]{16,}["']/i,
    severity: "high",
    description:
      "A bearer token appears to be embedded directly in source code.",
    recommendation:
      "Remove the token from source control and use short-lived runtime credentials.",
    mask: true,
  },
  {
    name: "Private key",
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
    severity: "critical",
    description: "A private cryptographic key appears in source code.",
    recommendation:
      "Remove and revoke or rotate the exposed key immediately.",
    mask: false,
  },
  {
    name: "GitHub token",
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/,
    severity: "critical",
    description: "A value resembles a GitHub personal access token.",
    recommendation:
      "Revoke the token in GitHub settings and use a secret store or CI-provided credentials.",
    mask: true,
  },
  {
    name: "Slack token",
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
    severity: "high",
    description: "A value resembles a Slack API token.",
    recommendation:
      "Revoke the token in Slack and load it from a secret store.",
    mask: true,
  },
  {
    name: "Stripe live secret key",
    pattern: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/,
    severity: "critical",
    description: "A value resembles a live Stripe secret key.",
    recommendation:
      "Roll the key in the Stripe dashboard and keep it on the server only.",
    mask: true,
  },
];

function analyzeSecrets(
  source: SourceFileInfo,
  findings: SecurityFinding[]
): void {
  const text = source.sourceFile.getFullText();

  for (const item of SECRET_PATTERNS) {
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

      const node = nodeAtPosition(source.sourceFile, match.index);

      if (!node) continue;

      // For assignments, the secret is the quoted value, not the key name.
      const quoted = /["']([^"']+)["']\s*$/.exec(match[0])?.[1];
      const secret = quoted ?? match[0];
      const isPlaceholder = item.mask && PLACEHOLDER_VALUE.test(secret);

      const evidence = item.mask
        ? match[0].replace(secret, maskSecret(secret)).slice(0, 180)
        : match[0].slice(0, 180);

      addFinding(
        findings,
        source,
        node,
        {
          severity: isPlaceholder ? "info" : item.severity,
          category: "secrets",
          title: item.name,
          description: isPlaceholder
            ? `${item.description} The value looks like a placeholder or documented example.`
            : item.description,
          recommendation: item.recommendation,
          evidence,
          confidence: isPlaceholder ? "low" : "high",
          cwe: "CWE-798",
          owasp: "A07:2021 Identification and Authentication Failures",
        },
        item.mask ? [secret] : []
      );
    }
  }
}

const PROCESS_FUNCTIONS = new Set([
  "exec",
  "execSync",
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
]);

// `exec` is also RegExp.prototype.exec, so a bare `.exec(` is only treated
// as a process call when the receiver looks like child_process.
const PROCESS_RECEIVERS = /^(?:cp|child_?process|childProcess|shell|shelljs)$/i;

function isProcessCall(name: string, fileImportsProcessApi: boolean): boolean {
  if (!fileImportsProcessApi) return false;

  const parts = name.split(".");
  const fn = parts.pop() || "";

  if (!PROCESS_FUNCTIONS.has(fn)) return false;
  if (parts.length === 0) return true;
  if (fn === "exec") return PROCESS_RECEIVERS.test(parts[parts.length - 1]);
  return true;
}

function analyzeCalls(
  source: SourceFileInfo,
  findings: SecurityFinding[]
): void {
  const fullText = source.sourceFile.getFullText();
  const importsProcessApi = /child_process|\bexeca\b|shelljs/.test(fullText);
  const usesSanitizer =
    /DOMPurify|sanitize-html|sanitizeHtml|isomorphic-dompurify/.test(fullText);

  function checkFunctionConstructor(
    node: ts.CallExpression | ts.NewExpression
  ): void {
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

  function checkHtmlSink(
    node: ts.Node,
    title: string,
    description: string,
    isStaticValue: boolean
  ): void {
    addFinding(findings, source, node, {
      severity: isStaticValue ? "low" : "high",
      category: "xss",
      title,
      description: isStaticValue
        ? `${description} The assigned value is a constant string.`
        : description,
      recommendation:
        "Use textContent or safe framework rendering. Sanitize HTML when raw HTML is required.",
      confidence: isStaticValue ? "low" : "high",
      cwe: "CWE-79",
      owasp: "A03:2021 Injection",
    });
  }

  function checkCall(node: ts.CallExpression): void {
    const name = callName(node);
    const expression = node.getText(source.sourceFile);
    const firstArgument = node.arguments[0];

    if (/^(?:(?:window|globalThis|global|self)\.)?eval$/.test(name)) {
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

    if (/^(?:(?:window|globalThis|global|self)\.)?Function$/.test(name)) {
      checkFunctionConstructor(node);
    }

    if (
      (name === "setTimeout" || name === "setInterval") &&
      firstArgument &&
      (isStaticString(firstArgument) ||
        ts.isTemplateExpression(skipOuter(firstArgument)))
    ) {
      addFinding(findings, source, node, {
        severity: "high",
        category: "unsafe-code",
        title: "String-based timer execution",
        description:
          "A string is passed to a timer API and may be evaluated as code.",
        recommendation: "Pass a function to the timer instead of a string.",
        confidence: "high",
        cwe: "CWE-95",
        owasp: "A03:2021 Injection",
      });
    }

    if (name === "document.write" || name === "document.writeln") {
      addFinding(findings, source, node, {
        severity: "high",
        category: "xss",
        title: "document.write usage",
        description:
          "document.write can become an injection sink when content is influenced by external input.",
        recommendation: "Prefer safe DOM APIs or framework rendering.",
        confidence: "medium",
        cwe: "CWE-79",
        owasp: "A03:2021 Injection",
      });
    }

    if (name.endsWith(".insertAdjacentHTML")) {
      checkHtmlSink(
        node,
        "insertAdjacentHTML usage",
        "HTML is inserted into the DOM without escaping.",
        isStaticString(node.arguments[1])
      );
    }

    // Web storage and React Native AsyncStorage.
    const isWebStorage = /(?:^|\.)(?:localStorage|sessionStorage)\.setItem$/.test(
      name
    );
    const isAsyncStorage = /(?:^|\.)AsyncStorage\.setItem$/.test(name);

    if (isWebStorage || isAsyncStorage) {
      const key = staticPrefix(firstArgument) ?? "";
      const sensitiveKey = SENSITIVE_KEY.test(key);

      if (isWebStorage) {
        addFinding(findings, source, node, {
          severity: sensitiveKey ? "high" : "medium",
          category: "storage",
          title: sensitiveKey
            ? "Sensitive value in browser storage"
            : "Data stored in browser storage",
          description:
            "Browser storage is accessible to JavaScript running in the page and can expose sensitive values during XSS.",
          recommendation:
            "Do not store passwords, private keys, or long-lived sensitive tokens in localStorage or sessionStorage.",
          confidence: sensitiveKey ? "high" : "medium",
          cwe: "CWE-922",
          owasp: "A05:2021 Security Misconfiguration",
        });
      } else if (sensitiveKey) {
        addFinding(findings, source, node, {
          severity: "high",
          category: "storage",
          title: "Sensitive value in unencrypted AsyncStorage",
          description:
            "AsyncStorage is unencrypted on-device storage and the key name suggests a credential or token.",
          recommendation:
            "Store credentials with react-native-keychain or expo-secure-store (Keychain / Keystore).",
          confidence: "medium",
          cwe: "CWE-312",
          owasp: "A02:2021 Cryptographic Failures",
        });
      }
    }

    if (
      [
        "console.log",
        "console.error",
        "console.warn",
        "console.info",
        "console.debug",
      ].includes(name) &&
      /(password|passwd|token|secret|authorization|cookie|private.?key|api.?key)/i.test(
        expression
      )
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

    if (isProcessCall(name, importsProcessApi)) {
      const dynamic = !!firstArgument && !isStaticString(firstArgument);

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

    const isHttpClient =
      name === "fetch" ||
      name === "axios" ||
      /\.(?:get|post|put|patch|delete|request)$/.test(name);
    const url = staticPrefix(firstArgument);

    if (
      isHttpClient &&
      url !== undefined &&
      /^http:\/\//i.test(url) &&
      !LOOPBACK_URL.test(url)
    ) {
      addFinding(findings, source, node, {
        severity: "medium",
        category: "network",
        title: "Insecure HTTP endpoint",
        description: "A network request uses unencrypted HTTP.",
        recommendation:
          "Use HTTPS for production traffic and avoid transmitting sensitive data over plain HTTP.",
        evidence: url,
        confidence: "high",
        cwe: "CWE-319",
        owasp: "A02:2021 Cryptographic Failures",
      });
    }

    // Weak hashes: only real hash calls, never arbitrary text containing "md5(".
    const simpleName = (name.split(".").pop() || "").toLowerCase();
    const algorithm = isStaticString(firstArgument)
      ? (skipOuter(firstArgument) as ts.StringLiteralLike).text
      : "";

    const weakHash =
      (/(?:^|\.)createHash$/.test(name) && /^(?:md5|sha-?1)$/i.test(algorithm)) ||
      (name.endsWith(".digest") && /^sha-?1$/i.test(algorithm)) ||
      simpleName === "md5" ||
      simpleName === "sha1";

    if (weakHash) {
      addFinding(findings, source, node, {
        severity: "medium",
        category: "crypto",
        title: "Weak cryptographic hash",
        description: "MD5 or SHA-1 appears to be used in application code.",
        recommendation:
          "Use SHA-256 or stronger for integrity, and bcrypt/scrypt/argon2 for passwords.",
        confidence: "medium",
        cwe: "CWE-328",
        owasp: "A02:2021 Cryptographic Failures",
      });
    }

    if (/(?:^|\.)create(?:De)?[cC]ipher$/.test(name)) {
      addFinding(findings, source, node, {
        severity: "medium",
        category: "crypto",
        title: "Deprecated cipher API",
        description:
          "createCipher/createDecipher derive keys weakly and use no random IV.",
        recommendation:
          "Use createCipheriv with a random IV and an authenticated mode such as aes-256-gcm.",
        confidence: "high",
        cwe: "CWE-327",
        owasp: "A02:2021 Cryptographic Failures",
      });
    } else if (
      /(?:^|\.)create(?:De)?[cC]ipheriv$/.test(name) &&
      /ecb|^des(?!-?ede3)|rc4|rc2|blowfish/i.test(algorithm)
    ) {
      addFinding(findings, source, node, {
        severity: "medium",
        category: "crypto",
        title: "Weak cipher algorithm or mode",
        description: `The cipher "${algorithm}" is weak or uses an insecure mode.`,
        recommendation: "Use AES-256-GCM or ChaCha20-Poly1305.",
        confidence: "high",
        cwe: "CWE-327",
        owasp: "A02:2021 Cryptographic Failures",
      });
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      checkCall(node);
    }

    // `new Function("...")` is a NewExpression, not a CallExpression.
    if (
      ts.isNewExpression(node) &&
      /^(?:(?:window|globalThis|global|self)\.)?Function$/.test(
        calleeName(node.expression)
      )
    ) {
      checkFunctionConstructor(node);
    }

    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "dangerouslySetInnerHTML"
    ) {
      let staticHtml = false;
      const initializer = node.initializer;

      if (
        initializer &&
        ts.isJsxExpression(initializer) &&
        initializer.expression &&
        ts.isObjectLiteralExpression(skipOuter(initializer.expression))
      ) {
        const object = skipOuter(
          initializer.expression
        ) as ts.ObjectLiteralExpression;

        staticHtml = object.properties.some(
          (property) =>
            ts.isPropertyAssignment(property) &&
            propertyKey(property.name) === "__html" &&
            isStaticString(property.initializer)
        );
      }

      addFinding(findings, source, node, {
        severity: staticHtml ? "low" : usesSanitizer ? "medium" : "high",
        category: "xss",
        title: "React dangerouslySetInnerHTML",
        description: staticHtml
          ? "Raw HTML is injected, but the value is a constant string."
          : usesSanitizer
            ? "Raw HTML is injected; this file references an HTML sanitizer, so verify it is applied to this value."
            : "Raw HTML is being injected into a React component.",
        recommendation:
          "Avoid raw HTML when possible. Sanitize HTML with a trusted sanitizer before rendering.",
        confidence: staticHtml || usesSanitizer ? "low" : "high",
        cwe: "CWE-79",
        owasp: "A03:2021 Injection",
      });
    }

    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) &&
      ts.isPropertyAccessExpression(node.left) &&
      ["innerHTML", "outerHTML"].includes(node.left.name.text)
    ) {
      const right = skipOuter(node.right);
      const emptyString = ts.isStringLiteralLike(right) && right.text === "";

      // `el.innerHTML = ""` is the standard way to clear a node.
      if (!emptyString) {
        checkHtmlSink(
          node,
          `${node.left.name.text} assignment`,
          `A value is assigned directly to ${node.left.name.text}.`,
          isStaticString(node.right)
        );
      }
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
      const propertyName = propertyKey(node.name);
      const value = skipOuter(node.initializer);

      if (
        /cors|origin/i.test(propertyName) &&
        ts.isStringLiteralLike(value) &&
        value.text === "*"
      ) {
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
      } else if (
        /^origin$/i.test(propertyName) &&
        value.kind === ts.SyntaxKind.TrueKeyword
      ) {
        addFinding(findings, source, node, {
          severity: "low",
          category: "configuration",
          title: "CORS reflects any origin",
          description:
            "origin: true reflects the request origin, effectively allowing every site.",
          recommendation:
            "Use an explicit allowlist of origins, especially when credentials are enabled.",
          confidence: "low",
          cwe: "CWE-942",
          owasp: "A05:2021 Security Misconfiguration",
        });
      }

      if (
        propertyName === "rejectUnauthorized" &&
        value.kind === ts.SyntaxKind.FalseKeyword
      ) {
        addFinding(findings, source, node, {
          severity: "high",
          category: "network",
          title: "TLS certificate validation disabled",
          description:
            "rejectUnauthorized: false accepts any certificate, enabling man-in-the-middle attacks.",
          recommendation:
            "Remove the option and trust a proper CA bundle for private certificates.",
          confidence: "high",
          cwe: "CWE-295",
          owasp: "A07:2021 Identification and Authentication Failures",
        });
      }
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      /NODE_TLS_REJECT_UNAUTHORIZED/.test(node.left.getText(source.sourceFile)) &&
      ts.isStringLiteralLike(skipOuter(node.right)) &&
      (skipOuter(node.right) as ts.StringLiteralLike).text === "0"
    ) {
      addFinding(findings, source, node, {
        severity: "high",
        category: "network",
        title: "TLS certificate validation disabled",
        description:
          "NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate validation for the whole process.",
        recommendation: "Remove it and fix the certificate chain instead.",
        confidence: "high",
        cwe: "CWE-295",
        owasp: "A07:2021 Identification and Authentication Failures",
      });
    }

    if (
      ts.isCallExpression(node) &&
      /(?:^|\.)(?:setHeader|header|set|append)$/.test(callName(node)) &&
      isStaticString(node.arguments[0]) &&
      (skipOuter(node.arguments[0]) as ts.StringLiteralLike).text.toLowerCase() ===
        "access-control-allow-origin" &&
      isStaticString(node.arguments[1]) &&
      (skipOuter(node.arguments[1]) as ts.StringLiteralLike).text === "*"
    ) {
      addFinding(findings, source, node, {
        severity: "medium",
        category: "configuration",
        title: "Wildcard CORS configuration",
        description:
          "The Access-Control-Allow-Origin header is set to allow all origins.",
        recommendation:
          "Restrict allowed origins to the domains that actually require access.",
        confidence: "medium",
        cwe: "CWE-942",
        owasp: "A05:2021 Security Misconfiguration",
      });
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
  // TypeScript 7 ships without the JavaScript compiler API this tool needs.
  if (typeof ts.createSourceFile !== "function") {
    throw new Error(
      "The installed 'typescript' package has no compiler API (TypeScript 7+). " +
        "Install TypeScript 6 for this tool: npm i -D typescript@npm:@typescript/typescript6@^6.0.2"
    );
  }

  const absoluteProjectPath = path.resolve(projectPath);

  if (!fs.existsSync(absoluteProjectPath)) {
    throw new Error(`Project path does not exist: ${projectPath}`);
  }

  if (!fs.statSync(absoluteProjectPath).isDirectory()) {
    throw new Error(`Project path is not a directory: ${projectPath}`);
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