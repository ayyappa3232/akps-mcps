import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import * as ts from "typescript";

const MAX_FILES = 5000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MATCHES = 500;
const MAX_IMPACTED_FILES = 200;

const EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs",
]);

const IGNORED = new Set([
  "node_modules", ".git", "dist", "build", "coverage",
  ".next", ".vite", ".turbo", ".vercel", "vendor",
]);

const BLOCKED = new Set([
  ".env", ".env.local", ".env.development", ".env.production",
  "serviceAccountKey.json", "id_rsa", "id_ed25519",
]);

type ImpactLevel = "low" | "medium" | "high" | "critical";

interface Reference {
  filePath: string;
  line: number;
  column: number;
  text: string;
  kind: "import" | "reference" | "definition" | "export";
}

interface ImpactedFile {
  filePath: string;
  impact: "direct" | "indirect";
  score: number;
  reasons: string[];
  references: Reference[];
}

interface SymbolInfo {
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface ChangeImpactReport {
  success: boolean;
  tool: "analyze_change_impact";
  projectPath: string;
  target: { filePath?: string; symbol?: string };
  summary: {
    risk: ImpactLevel;
    riskScore: number;
    directFiles: number;
    indirectFiles: number;
    affectedFiles: number;
    affectedSymbols: number;
    referenceCount: number;
  };
  directImpact: ImpactedFile[];
  indirectImpact: ImpactedFile[];
  affectedSymbols: SymbolInfo[];
  recommendations: string[];
  warnings: string[];
}

interface Source {
  filePath: string;
  content: string;
  ast: ts.SourceFile;
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function blocked(file: string): boolean {
  const name = path.basename(file);
  return BLOCKED.has(name) || name.startsWith(".env.") || name.startsWith(".");
}

async function sourceFiles(root: string): Promise<string[]> {
  const result: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (result.length >= MAX_FILES) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (result.length >= MAX_FILES || entry.isSymbolicLink()) return;

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED.has(entry.name) && !entry.name.startsWith(".")) {
          await walk(full);
        }
      } else if (
        entry.isFile() &&
        EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
        !blocked(full)
      ) {
        result.push(full);
      }
    }
  }

  await walk(root);
  return result;
}

async function loadSources(root: string, files: string[], warnings: string[]): Promise<Source[]> {
  const result: Source[] = [];

  for (const file of files) {
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;

      const content = await readFile(file, "utf8");
      const ext = path.extname(file).toLowerCase();
      const kind =
        ext === ".tsx" || ext === ".jsx"
          ? ts.ScriptKind.TSX
          : [".js", ".mjs", ".cjs"].includes(ext)
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS;

      result.push({
        filePath: relative(root, file),
        content,
        ast: ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind),
      });
    } catch {
      warnings.push(`Unable to inspect ${relative(root, file)}.`);
    }
  }

  return result;
}

function nodeName(node: ts.Node): string | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  ) {
    return node.name?.getText(node.getSourceFile());
  }

  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }

  if (
    ts.isPropertyAssignment(node) &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
  ) {
    return node.name.text;
  }

  return undefined;
}

function collectSymbols(ast: ts.SourceFile, filePath: string): SymbolInfo[] {
  const result: SymbolInfo[] = [];

  function visit(node: ts.Node): void {
    const name = nodeName(node);

    if (
      name &&
      (
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isPropertyAssignment(node)
      )
    ) {
      const start = ast.getLineAndCharacterOfPosition(node.getStart(ast));
      const end = ast.getLineAndCharacterOfPosition(node.getEnd());
      const holder = ts.isVariableDeclaration(node) ? node.parent?.parent : node;
      const exported =
        Boolean(holder) &&
        ts.canHaveModifiers(holder!) &&
        (ts.getModifiers(holder!)?.some(
          m => m.kind === ts.SyntaxKind.ExportKeyword ||
               m.kind === ts.SyntaxKind.DefaultKeyword,
        ) ?? false);

      result.push({
        name,
        kind: ts.isClassDeclaration(node)
          ? "class"
          : ts.isMethodDeclaration(node)
            ? "method"
            : ts.isGetAccessorDeclaration(node)
              ? "getter"
              : ts.isSetAccessorDeclaration(node)
                ? "setter"
                : ts.isConstructorDeclaration(node)
                  ? "constructor"
                  : ts.isVariableDeclaration(node)
                    ? "function-or-variable"
                    : "property-function",
        filePath,
        startLine: start.line + 1,
        endLine: end.line + 1,
        exported,
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(ast);
  return result;
}

function referenceKind(node: ts.Node, symbol: string): Reference["kind"] {
  const ast = node.getSourceFile();

  for (let current: ts.Node | undefined = node.parent;
       current && current !== ast;
       current = current.parent) {
    if (ts.isImportSpecifier(current) || ts.isImportClause(current) ||
        ts.isImportDeclaration(current)) return "import";
    if (ts.isExportSpecifier(current) || ts.isExportAssignment(current)) return "export";
  }

  for (let current: ts.Node | undefined = node;
       current && current !== ast;
       current = current.parent) {
    if (
      (
        ts.isFunctionDeclaration(current) ||
        ts.isClassDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isVariableDeclaration(current) ||
        ts.isPropertyAssignment(current)
      ) &&
      nodeName(current) === symbol
    ) {
      return "definition";
    }
  }

  return "reference";
}

function findSymbolReferences(
  source: Source,
  symbol: string,
  caseSensitive: boolean,
): Reference[] {
  const result: Reference[] = [];
  const lines = source.content.split(/\r?\n/);

  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) || ts.isStringLiteral(node)) {
      const value = node.text;
      const equal = caseSensitive
        ? value === symbol
        : value.toLowerCase() === symbol.toLowerCase();

      if (equal) {
        const start = source.ast.getLineAndCharacterOfPosition(node.getStart(source.ast));
        result.push({
          filePath: source.filePath,
          line: start.line + 1,
          column: start.character + 1,
          text: lines[start.line]?.trim().slice(0, 500) ?? "",
          kind: referenceKind(node, symbol),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source.ast);
  return result;
}

function matchesImport(importPath: string, targetFile: string): boolean {
  if (!importPath.startsWith(".")) return false;

  const target = targetFile.replace(/\\/g, "/");
  const imported = importPath.replace(/\\/g, "/");
  const strip = (value: string) =>
    value.replace(/\.(tsx?|jsx?|mts|cts|mjs|cjs)$/i, "");

  const targetNoExt = strip(target);
  const importNoExt = strip(imported);

  return targetNoExt.endsWith(`/${importNoExt}`) ||
    target.endsWith(`/${imported}`) ||
    path.posix.basename(targetNoExt) === path.posix.basename(importNoExt);
}

function findFileImports(source: Source, targetFile: string): Reference[] {
  const result: Reference[] = [];
  const lines = source.content.split(/\r?\n/);

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      matchesImport(node.moduleSpecifier.text, targetFile)
    ) {
      const start = source.ast.getLineAndCharacterOfPosition(node.getStart(source.ast));
      result.push({
        filePath: source.filePath,
        line: start.line + 1,
        column: start.character + 1,
        text: lines[start.line]?.trim().slice(0, 500) ?? "",
        kind: "import",
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(source.ast);
  return result;
}

function dedupe(items: Reference[]): Reference[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = `${item.filePath}:${item.line}:${item.column}:${item.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function score(refs: Reference[], exported: boolean): number {
  let value = 50;

  for (const ref of refs) {
    if (ref.kind === "import") value += 20;
    if (ref.kind === "reference") value += 10;
    if (ref.kind === "export") value += 15;
  }

  if (exported) value += 15;
  return Math.min(100, value);
}

function risk(scoreValue: number, files: number, exported: boolean): ImpactLevel {
  if (scoreValue >= 85 || (exported && files >= 10)) return "critical";
  if (scoreValue >= 65 || files >= 6) return "high";
  if (scoreValue >= 40 || files >= 3) return "medium";
  return "low";
}

function recommendations(
  filePath: string | undefined,
  symbol: string | undefined,
  direct: ImpactedFile[],
  indirect: ImpactedFile[],
  exported: boolean,
): string[] {
  const result: string[] = [];

  if (symbol) {
    result.push(`Review every direct reference to ${symbol} before changing its signature or behavior.`);
  }

  if (filePath) {
    result.push(`Run focused tests for ${filePath} and its direct consumers.`);
  }

  if (exported) {
    result.push("The target is exported; check all consumers before changing its contract.");
  }

  if (direct.length) {
    result.push(`Review ${direct.length} directly impacted file${direct.length === 1 ? "" : "s"} first.`);
  }

  if (indirect.length) {
    result.push(`Then review ${indirect.length} indirectly impacted file${indirect.length === 1 ? "" : "s"} for downstream behavior.`);
  }

  if (direct.some(f => f.filePath.includes("test"))) {
    result.push("Existing tests reference the target; update or extend them when behavior changes.");
  }

  if (direct.some(f => /\.(tsx|jsx)$/.test(f.filePath))) {
    result.push("React files are affected; verify rendering, props, state, and interaction flows.");
  }

  if (!result.length) {
    result.push("No downstream references were detected. Review the target implementation and local tests manually.");
  }

  return [...new Set(result)];
}

export async function analyzeChangeImpact(
  projectPathInput: string,
  filePathInput?: string,
  symbol?: string,
  caseSensitive = true,
): Promise<ChangeImpactReport> {
  if (!path.isAbsolute(projectPathInput)) {
    throw new Error("projectPath must be an absolute path.");
  }

  const root = await realpath(projectPathInput);
  if (!(await stat(root)).isDirectory()) {
    throw new Error("projectPath must point to a directory.");
  }

  if (!filePathInput && !symbol) {
    throw new Error("At least one of filePath or symbol must be supplied.");
  }

  const warnings: string[] = [];
  const files = await sourceFiles(root);
  const sources = await loadSources(root, files, warnings);
  const allSymbols = sources.flatMap(s => collectSymbols(s.ast, s.filePath));

  let targetFile: string | undefined;
  let targetSymbols: SymbolInfo[] = [];
  let exported = false;

  if (filePathInput) {
    if (path.isAbsolute(filePathInput)) {
      throw new Error("filePath must be relative to the project directory.");
    }

    const resolved = await realpath(path.resolve(root, filePathInput));

    if (!inside(root, resolved)) {
      throw new Error("filePath resolves outside the project directory.");
    }

    if (blocked(resolved)) {
      throw new Error("Reading this potentially sensitive file is blocked.");
    }

    if (!EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      throw new Error("filePath must point to a JavaScript or TypeScript source file.");
    }

    targetFile = relative(root, resolved);
    targetSymbols = allSymbols.filter(s => s.filePath === targetFile);
    exported = targetSymbols.some(s => s.exported);
  }

  if (symbol) {
    const matches = allSymbols.filter(s =>
      caseSensitive ? s.name === symbol : s.name.toLowerCase() === symbol.toLowerCase(),
    );

    if (!matches.length) {
      throw new Error(`Could not find symbol "${symbol}" in the project.`);
    }

    if (targetFile) {
      targetSymbols = matches.filter(s => s.filePath === targetFile);
      if (!targetSymbols.length) {
        throw new Error(`Could not find symbol "${symbol}" in ${targetFile}.`);
      }
    } else if (matches.length === 1) {
      targetFile = matches[0].filePath;
      targetSymbols = matches;
    } else {
      warnings.push(`Symbol "${symbol}" appears in ${matches.length} locations.`);
      targetSymbols = matches;
    }

    exported = targetSymbols.some(s => s.exported);
  }

  const directMap = new Map<string, ImpactedFile>();

  for (const source of sources) {
    let refs = symbol
      ? findSymbolReferences(source, symbol, caseSensitive)
      : [];

    if (targetFile && source.filePath !== targetFile) {
      refs = refs.concat(findFileImports(source, targetFile));
    }

    refs = dedupe(refs);
    if (!refs.length) continue;

    if (
      source.filePath === targetFile &&
      refs.every(ref => ref.kind === "definition")
    ) {
      continue;
    }

    const reasons = new Set<string>();
    if (refs.some(r => r.kind === "import")) reasons.add("imports or re-exports the target");
    if (refs.some(r => r.kind === "reference")) reasons.add("references the target symbol");
    if (refs.some(r => r.kind === "export")) reasons.add("exports the target symbol");

    directMap.set(source.filePath, {
      filePath: source.filePath,
      impact: "direct",
      score: score(refs, exported),
      reasons: [...reasons],
      references: refs.slice(0, MAX_MATCHES),
    });
  }

  if (targetFile) directMap.delete(targetFile);

  const directImpact = [...directMap.values()]
    .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
    .slice(0, MAX_IMPACTED_FILES);

  const directPaths = new Set(directImpact.map(i => i.filePath));
  const indirectMap = new Map<string, ImpactedFile>();

  for (const direct of directImpact) {
    const source = sources.find(s => s.filePath === direct.filePath);
    if (!source) continue;

    for (const candidate of collectSymbols(source.ast, source.filePath).slice(0, 50)) {
      for (const downstream of sources) {
        if (
          downstream.filePath === direct.filePath ||
          downstream.filePath === targetFile ||
          directPaths.has(downstream.filePath)
        ) continue;

        const refs = findSymbolReferences(downstream, candidate.name, caseSensitive);
        if (!refs.length) continue;

        const existing = indirectMap.get(downstream.filePath);
        if (existing) {
          existing.references = dedupe([...existing.references, ...refs]).slice(0, MAX_MATCHES);
          existing.reasons = [
            ...new Set([...existing.reasons, `references ${candidate.name} from ${direct.filePath}`]),
          ];
          existing.score = Math.min(100, existing.score + Math.min(15, refs.length * 3));
        } else {
          indirectMap.set(downstream.filePath, {
            filePath: downstream.filePath,
            impact: "indirect",
            score: Math.min(100, 20 + refs.length * 5),
            reasons: [`references ${candidate.name} from ${direct.filePath}`],
            references: refs.slice(0, MAX_MATCHES),
          });
        }
      }
    }
  }

  const indirectImpact = [...indirectMap.values()]
    .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
    .slice(0, MAX_IMPACTED_FILES);

  const affectedSymbols = [
    ...targetSymbols,
    ...directImpact.flatMap(i => allSymbols.filter(s => s.filePath === i.filePath)),
  ].filter((item, index, array) =>
    array.findIndex(x =>
      x.name === item.name &&
      x.filePath === item.filePath &&
      x.startLine === item.startLine,
    ) === index,
  ).slice(0, MAX_IMPACTED_FILES);

  const referenceCount =
    directImpact.reduce((n, i) => n + i.references.length, 0) +
    indirectImpact.reduce((n, i) => n + i.references.length, 0);

  const highest = Math.max(
    0,
    ...directImpact.map(i => i.score),
    ...indirectImpact.map(i => i.score),
  );

  const affectedFiles = directImpact.length + indirectImpact.length;
  const riskScore = Math.min(
    100,
    highest + Math.min(20, directImpact.length * 2) + Math.min(15, indirectImpact.length),
  );

  return {
    success: true,
    tool: "analyze_change_impact",
    projectPath: root,
    target: {
      ...(targetFile ? { filePath: targetFile } : {}),
      ...(symbol ? { symbol } : {}),
    },
    summary: {
      risk: risk(riskScore, affectedFiles, exported),
      riskScore,
      directFiles: directImpact.length,
      indirectFiles: indirectImpact.length,
      affectedFiles,
      affectedSymbols: affectedSymbols.length,
      referenceCount,
    },
    directImpact,
    indirectImpact,
    affectedSymbols,
    recommendations: recommendations(
      targetFile,
      symbol,
      directImpact,
      indirectImpact,
      exported,
    ),
    warnings,
  };
}

export function registerAnalyzeChangeImpactTool(server: McpServer): void {
  server.registerTool(
    "analyze_change_impact",
    {
      description:
        "Analyze the likely impact of changing a JavaScript or TypeScript file or symbol. Finds direct references/imports, estimates indirect downstream impact, identifies affected symbols, calculates a risk level, and provides review recommendations. Read-only.",
      inputSchema: {
        projectPath: z.string().min(1).describe("Absolute path to the target project directory."),
        filePath: z.string().min(1).optional().describe("Optional source file path relative to projectPath."),
        symbol: z.string().min(1).max(200).optional().describe("Optional function, component, class, method, or variable name."),
        caseSensitive: z.boolean().default(true).describe("Whether symbol matching should be case-sensitive."),
      },
    },
    async ({ projectPath, filePath, symbol, caseSensitive }) => {
      try {
        const result = await analyzeChangeImpact(
          projectPath,
          filePath,
          symbol,
          caseSensitive,
        );

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        const result = {
          success: false,
          tool: "analyze_change_impact",
          projectPath,
          target: {
            ...(filePath ? { filePath } : {}),
            ...(symbol ? { symbol } : {}),
          },
          error: error instanceof Error ? error.message : String(error),
        };

        return {
          isError: true,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      }
    },
  );
}
