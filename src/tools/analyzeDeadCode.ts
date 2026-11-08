import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

/* =========================================================
   Types
   ========================================================= */

type DeadCodeSeverity = "info" | "low" | "medium" | "high";

type DeadCodeKind =
    | "unused-import"
    | "unused-variable"
    | "unused-function"
    | "unused-class"
    | "unused-type"
    | "unused-interface"
    | "unused-enum"
    | "unused-export";

export interface DeadCodeIssue {
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
}

export interface DeadCodeSummary {
    unusedImports: number;
    unusedVariables: number;
    unusedFunctions: number;
    unusedClasses: number;
    unusedTypes: number;
    unusedInterfaces: number;
    unusedEnums: number;
    unusedExports: number;
    totalIssues: number;
}

export interface DeadCodeReport {
    success: boolean;
    projectPath: string;
    filePath?: string;
    symbol?: string;
    summary: DeadCodeSummary;
    issues: DeadCodeIssue[];
    warnings: string[];
    recommendations: string[];
}

export interface AnalyzeDeadCodeOptions {
    /**
     * Also report exported declarations that no other analyzed file
     * imports or re-exports. Off by default because exports are often
     * public API or entry points.
     */
    includeExports?: boolean;

    /** Maximum number of source files to analyze. */
    maxFiles?: number;
}

/** A tracked declaration (function, class, variable, type, ...). */
interface SymbolInfo {
    name: string;
    kind: DeadCodeKind;
    filePath: string;
    line: number;
    column: number;

    /** Exported via an `export` modifier on the declaration itself. */
    exported: boolean;

    declaration: ts.Node;
    nameNode: ts.Identifier;
}

/**
 * All declarations that share one TypeScript symbol (overloads,
 * interface merging, class + namespace merging, ...) plus the
 * reference counts for that symbol.
 */
interface SymbolGroup {
    symbol: ts.Symbol;
    infos: SymbolInfo[];

    /** References excluding the declaration itself and self-references. */
    total: number;

    /** References coming from files other than the declaring file(s). */
    external: number;
}

interface ImportBinding {
    localName: string;
    node: ts.Identifier;
    symbol: ts.Symbol;
    filePath: string;
    references: number;
}

interface FileInfo {
    absolutePath: string;
    relativePath: string;
    sourceFile: ts.SourceFile;
    declarations: SymbolInfo[];
    imports: ImportBinding[];
}

/* =========================================================
   Configuration
   ========================================================= */

const SUPPORTED_EXTENSIONS = new Set([
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
]);

const IGNORED_DIRECTORIES = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".output",
    ".svelte-kit",
    ".expo",
    ".turbo",
    ".cache",
    ".yarn",
    "coverage",
]);

const DEFAULT_MAX_FILES = 500;
const HARD_MAX_FILES = 5000;

/* =========================================================
   Path helpers
   ========================================================= */

function normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, "/");
}

function isDeclarationFile(filePath: string): boolean {
    return /\.d\.[cm]?ts$/i.test(filePath);
}

function isSupportedSourceFile(filePath: string): boolean {
    return (
        SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase()) &&
        !isDeclarationFile(filePath)
    );
}

function isJsxFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ext === ".tsx" || ext === ".jsx";
}

/* =========================================================
   Source file collection
   ========================================================= */

function collectSourceFiles(
    projectPath: string,
    maxFiles: number
): { files: string[]; truncated: boolean } {
    const files: string[] = [];
    let truncated = false;

    function walk(directory: string): void {
        if (truncated) {
            return;
        }

        let entries: fs.Dirent[];

        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            return;
        }

        // Deterministic order => deterministic truncation and output.
        entries.sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
            if (truncated) {
                return;
            }

            const absolutePath = path.join(directory, entry.name);

            if (entry.isDirectory()) {
                if (!IGNORED_DIRECTORIES.has(entry.name)) {
                    walk(absolutePath);
                }
                continue;
            }

            if (!entry.isFile() || !isSupportedSourceFile(absolutePath)) {
                continue;
            }

            if (files.length >= maxFiles) {
                truncated = true;
                return;
            }

            files.push(absolutePath);
        }
    }

    walk(projectPath);

    return { files, truncated };
}

/* =========================================================
   AST helpers
   ========================================================= */

function getLineAndColumn(
    sourceFile: ts.SourceFile,
    node: ts.Node
): { line: number; column: number } {
    const position = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile)
    );

    return {
        line: position.line + 1,
        column: position.character + 1,
    };
}

/**
 * `export` lives on the VariableStatement, not on the
 * VariableDeclaration, so we have to look one level up for variables.
 */
function isExportedDeclaration(node: ts.Node): boolean {
    let target: ts.Node = node;

    if (
        ts.isVariableDeclaration(node) &&
        ts.isVariableDeclarationList(node.parent) &&
        ts.isVariableStatement(node.parent.parent)
    ) {
        target = node.parent.parent;
    }

    if (!ts.canHaveModifiers(target)) {
        return false;
    }

    return Boolean(
        ts
            .getModifiers(target)
            ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    );
}

function getDeclarationNameNode(node: ts.Node): ts.Identifier | undefined {
    if (
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)
    ) {
        return node.name && ts.isIdentifier(node.name)
            ? node.name
            : undefined;
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        return node.name;
    }

    return undefined;
}

function getDeclarationKind(node: ts.Node): DeadCodeKind | undefined {
    if (ts.isFunctionDeclaration(node)) return "unused-function";
    if (ts.isClassDeclaration(node)) return "unused-class";
    if (ts.isInterfaceDeclaration(node)) return "unused-interface";
    if (ts.isTypeAliasDeclaration(node)) return "unused-type";
    if (ts.isEnumDeclaration(node)) return "unused-enum";
    if (ts.isVariableDeclaration(node)) return "unused-variable";
    return undefined;
}

/**
 * True for `declare ...` declarations and anything nested inside one
 * (e.g. `declare global { ... }`, `declare namespace X { ... }`).
 */
function isInAmbientContext(node: ts.Node): boolean {
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
        if (
            ts.canHaveModifiers(current) &&
            ts
                .getModifiers(current)
                ?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)
        ) {
            return true;
        }
    }

    return false;
}

/**
 * Decides whether a declaration should be tracked at all.
 */
function shouldTrackDeclaration(
    node: ts.Node,
    nameNode: ts.Identifier
): boolean {
    // `declare ...` and anything inside an ambient context.
    if (isInAmbientContext(node)) {
        return false;
    }

    // Overload signatures: the implementation is the real declaration.
    if (ts.isFunctionDeclaration(node) && !node.body) {
        return false;
    }

    if (ts.isVariableDeclaration(node)) {
        // catch (error) {}
        if (ts.isCatchClause(node.parent)) {
            return false;
        }

        // for (const item of items) {}
        if (
            ts.isVariableDeclarationList(node.parent) &&
            (ts.isForOfStatement(node.parent.parent) ||
                ts.isForInStatement(node.parent.parent))
        ) {
            return false;
        }

        // Convention for "intentionally unused".
        if (nameNode.text.startsWith("_")) {
            return false;
        }
    }

    return true;
}

/** Names that introduce a declaration (never a reference). */
function isDeclarationName(node: ts.Identifier): boolean {
    const parent = node.parent;

    return (
        (ts.isFunctionDeclaration(parent) ||
            ts.isClassDeclaration(parent) ||
            ts.isInterfaceDeclaration(parent) ||
            ts.isTypeAliasDeclaration(parent) ||
            ts.isEnumDeclaration(parent) ||
            ts.isVariableDeclaration(parent) ||
            ts.isModuleDeclaration(parent) ||
            ts.isParameter(parent)) &&
        parent.name === node
    );
}

/** Identifiers that are part of an import statement itself. */
function isImportBindingName(node: ts.Identifier): boolean {
    const parent = node.parent;

    return (
        ts.isImportSpecifier(parent) ||
        ts.isNamespaceImport(parent) ||
        (ts.isImportClause(parent) && parent.name === node) ||
        (ts.isImportEqualsDeclaration(parent) && parent.name === node)
    );
}

/** `x = value` (plain assignment) is a write, not a read. */
function isPlainAssignmentTarget(node: ts.Identifier): boolean {
    const parent = node.parent;

    return (
        ts.isBinaryExpression(parent) &&
        parent.left === node &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    );
}

/* =========================================================
   Compiler options
   ========================================================= */

function loadCompilerOptions(projectPath: string): {
    options: ts.CompilerOptions;
    warnings: string[];
} {
    const warnings: string[] = [];

    const fallback: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        jsx: ts.JsxEmit.ReactJSX,
        allowJs: true,
        noEmit: true,
        skipLibCheck: true,
    };

    const tsconfigPath = path.join(projectPath, "tsconfig.json");

    if (!fs.existsSync(tsconfigPath)) {
        warnings.push(
            "No tsconfig.json found in the project root; default compiler options were used. Path aliases may not resolve."
        );
        return { options: fallback, warnings };
    }

    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);

    if (configFile.error) {
        warnings.push(
            "tsconfig.json could not be read; default compiler options were used."
        );
        return { options: fallback, warnings };
    }

    const parsed = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        projectPath
    );

    return {
        options: {
            ...parsed.options,

            // Allow JS/JSX to be analyzed by the TypeScript compiler.
            allowJs: true,

            // We only read; never emit or write build info.
            noEmit: true,
            composite: false,
            incremental: false,
            declaration: false,
            declarationMap: false,
            tsBuildInfoFile: undefined,

            skipLibCheck: true,
        },
        warnings,
    };
}

/* =========================================================
   Symbol helpers
   ========================================================= */

/**
 * Resolves aliases (imports / re-exports) and maps local symbols of
 * exported declarations to their export symbol, so every reference to
 * the same declaration ends up with the same Symbol object.
 */
function canonicalSymbol(
    checker: ts.TypeChecker,
    symbol: ts.Symbol
): ts.Symbol {
    let current = symbol;

    if (current.flags & ts.SymbolFlags.Alias) {
        current = checker.getAliasedSymbol(current);
    }

    return checker.getExportSymbolOfSymbol(current);
}

/**
 * `{ foo }` is a shorthand property: getSymbolAtLocation returns the
 * *property* symbol, so we must ask for the value symbol explicitly.
 */
function getReferencedSymbol(
    checker: ts.TypeChecker,
    node: ts.Identifier
): ts.Symbol | undefined {
    const parent = node.parent;

    if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
        return checker.getShorthandAssignmentValueSymbol(parent);
    }

    return checker.getSymbolAtLocation(node);
}

function isInsideOwnDeclaration(
    group: SymbolGroup,
    file: FileInfo,
    node: ts.Node
): boolean {
    return group.infos.some(
        (info) =>
            info.filePath === file.relativePath &&
            node.pos >= info.declaration.pos &&
            node.end <= info.declaration.end
    );
}

/* =========================================================
   Declaration + import collection
   ========================================================= */

function collectDeclarations(
    sourceFile: ts.SourceFile,
    relativePath: string
): SymbolInfo[] {
    const declarations: SymbolInfo[] = [];

    function visit(node: ts.Node): void {
        const kind = getDeclarationKind(node);

        if (kind) {
            const nameNode = getDeclarationNameNode(node);

            if (nameNode && shouldTrackDeclaration(node, nameNode)) {
                const location = getLineAndColumn(sourceFile, nameNode);

                declarations.push({
                    name: nameNode.text,
                    kind,
                    filePath: relativePath,
                    line: location.line,
                    column: location.column,
                    exported: isExportedDeclaration(node),
                    declaration: node,
                    nameNode,
                });
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);

    return declarations;
}

function collectImports(
    sourceFile: ts.SourceFile,
    relativePath: string,
    checker: ts.TypeChecker
): ImportBinding[] {
    const bindings: ImportBinding[] = [];

    const add = (name: ts.Identifier): void => {
        const symbol = checker.getSymbolAtLocation(name);

        if (symbol) {
            bindings.push({
                localName: name.text,
                node: name,
                symbol,
                filePath: relativePath,
                references: 0,
            });
        }
    };

    for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement)) {
            const clause = statement.importClause;

            // import "./styles.css"  (side-effect only; never reported)
            if (!clause) {
                continue;
            }

            if (clause.name) {
                add(clause.name);
            }

            const named = clause.namedBindings;

            if (named) {
                if (ts.isNamespaceImport(named)) {
                    add(named.name);
                } else {
                    for (const element of named.elements) {
                        add(element.name);
                    }
                }
            }
        } else if (
            ts.isImportEqualsDeclaration(statement) &&
            ts.isExternalModuleReference(statement.moduleReference) &&
            !isExportedDeclaration(statement)
        ) {
            // import foo = require("foo")
            add(statement.name);
        }
    }

    return bindings;
}

function createFileInfo(
    projectPath: string,
    absolutePath: string,
    program: ts.Program,
    checker: ts.TypeChecker
): FileInfo | undefined {
    const sourceFile = program.getSourceFile(absolutePath);

    if (!sourceFile) {
        return undefined;
    }

    const relativePath = normalizePath(
        path.relative(projectPath, absolutePath)
    );

    return {
        absolutePath,
        relativePath,
        sourceFile,
        declarations: collectDeclarations(sourceFile, relativePath),
        imports: collectImports(sourceFile, relativePath, checker),
    };
}

/* =========================================================
   Reference counting
   ========================================================= */

function buildSymbolGroups(
    files: FileInfo[],
    checker: ts.TypeChecker
): Map<ts.Symbol, SymbolGroup> {
    const groups = new Map<ts.Symbol, SymbolGroup>();

    for (const file of files) {
        for (const declaration of file.declarations) {
            const raw = checker.getSymbolAtLocation(declaration.nameNode);

            if (!raw) {
                continue;
            }

            const symbol = canonicalSymbol(checker, raw);

            let group = groups.get(symbol);

            if (!group) {
                group = { symbol, infos: [], total: 0, external: 0 };
                groups.set(symbol, group);
            }

            group.infos.push(declaration);
        }
    }

    return groups;
}

/**
 * Single pass over every identifier in the program.
 *
 * Returns the set of symbols exported through `export { x }` or
 * `export default x` (these have no `export` modifier on the
 * declaration itself).
 */
function countReferences(
    files: FileInfo[],
    checker: ts.TypeChecker,
    groups: Map<ts.Symbol, SymbolGroup>
): Set<ts.Symbol> {
    const exportedSymbols = new Set<ts.Symbol>();

    // Imports are matched by alias-symbol identity, which stays correct
    // even when the module cannot be resolved.
    const importBySymbol = new Map<ts.Symbol, ImportBinding>();

    for (const file of files) {
        for (const binding of file.imports) {
            importBySymbol.set(binding.symbol, binding);
        }
    }

    const recordUse = (
        symbol: ts.Symbol,
        node: ts.Node,
        file: FileInfo
    ): void => {
        const group = groups.get(canonicalSymbol(checker, symbol));

        if (!group || isInsideOwnDeclaration(group, file, node)) {
            return;
        }

        group.total++;

        if (group.infos.every((info) => info.filePath !== file.relativePath)) {
            group.external++;
        }
    };

    /**
     * `export { local }` / `export default local`
     *
     * - local declaration  => it becomes exported (not a "use")
     * - imported binding   => re-export, which IS a use of the import
     *                         and of the original declaration
     */
    const handleLocalExport = (
        local: ts.Symbol | undefined,
        node: ts.Node,
        file: FileInfo
    ): void => {
        if (!local) {
            return;
        }

        if (local.flags & ts.SymbolFlags.Alias) {
            const binding = importBySymbol.get(local);

            if (binding) {
                binding.references++;
            }

            recordUse(local, node, file);
            return;
        }

        exportedSymbols.add(canonicalSymbol(checker, local));
    };

    for (const file of files) {
        const visit = (node: ts.Node): void => {
            if (ts.isIdentifier(node)) {
                visitIdentifier(node, file);
            }

            ts.forEachChild(node, visit);
        };

        const visitIdentifier = (node: ts.Identifier, owner: FileInfo): void => {
            if (isDeclarationName(node) || isImportBindingName(node)) {
                return;
            }

            const parent = node.parent;

            if (ts.isExportSpecifier(parent)) {
                // `export { a as b }`: handle once, via the source name.
                if (parent.propertyName && parent.name === node) {
                    return;
                }

                const isReExportFromModule =
                    parent.parent.parent.moduleSpecifier !== undefined;

                if (!isReExportFromModule) {
                    handleLocalExport(
                        checker.getExportSpecifierLocalTargetSymbol(parent),
                        node,
                        owner
                    );
                    return;
                }
                // `export { a } from "./a"` falls through and counts as a use.
            }

            if (ts.isExportAssignment(parent) && parent.expression === node) {
                handleLocalExport(
                    checker.getSymbolAtLocation(node),
                    node,
                    owner
                );
                return;
            }

            const raw = getReferencedSymbol(checker, node);

            if (!raw) {
                return;
            }

            if (isPlainAssignmentTarget(node)) {
                return;
            }

            const binding = importBySymbol.get(raw);

            if (binding) {
                binding.references++;
            }

            recordUse(raw, node, owner);
        };

        visit(file.sourceFile);
    }

    return exportedSymbols;
}

/* =========================================================
   Issue detection
   ========================================================= */

function isImplicitJsxFactoryImport(
    binding: ImportBinding,
    compilerOptions: ts.CompilerOptions
): boolean {
    if (!isJsxFile(binding.filePath)) {
        return false;
    }

    // With the automatic runtime React does not need to be imported.
    if (
        compilerOptions.jsx === ts.JsxEmit.ReactJSX ||
        compilerOptions.jsx === ts.JsxEmit.ReactJSXDev
    ) {
        return false;
    }

    const factory = (compilerOptions.jsxFactory ?? "React").split(".")[0];
    const fragment = (compilerOptions.jsxFragmentFactory ?? "").split(".")[0];

    return binding.localName === factory || binding.localName === fragment;
}

function detectIssues(
    files: FileInfo[],
    groups: Map<ts.Symbol, SymbolGroup>,
    exportedSymbols: Set<ts.Symbol>,
    compilerOptions: ts.CompilerOptions,
    includeExports: boolean
): DeadCodeIssue[] {
    const issues: DeadCodeIssue[] = [];

    /* ---- Declarations (one issue per symbol, not per overload) ---- */

    for (const group of groups.values()) {
        const info = group.infos[0];

        const exported =
            group.infos.some((i) => i.exported) ||
            exportedSymbols.has(group.symbol);

        const label = info.kind.replace(/^unused-/, "");

        if (!exported && group.total === 0) {
            issues.push({
                id: [info.kind, info.filePath, info.name, info.line, info.column].join(":"),
                kind: info.kind,
                severity:
                    info.kind === "unused-function" ||
                    info.kind === "unused-class"
                        ? "medium"
                        : "low",
                name: info.name,
                filePath: info.filePath,
                line: info.line,
                column: info.column,
                message: `${label} "${info.name}" appears to be unused.`,
                reason: `No references to "${info.name}" were found in the analyzed TypeScript/JavaScript program.`,
                suggestion: `Verify that "${info.name}" is not used dynamically or externally. If it is truly unused, consider removing it.`,
                exported: false,
                references: 0,
            });
            continue;
        }

        if (exported && includeExports && group.external === 0) {
            issues.push({
                id: ["unused-export", info.filePath, info.name, info.line, info.column].join(":"),
                kind: "unused-export",
                severity: "info",
                name: info.name,
                filePath: info.filePath,
                line: info.line,
                column: info.column,
                message: `Exported ${label} "${info.name}" is not imported by any other analyzed file.`,
                reason:
                    group.total > 0
                        ? `"${info.name}" is only used inside its own file, so the export may be unnecessary.`
                        : `"${info.name}" is exported but has no references anywhere in the analyzed program.`,
                suggestion: `If "${info.name}" is not part of a public API or entry point, remove the export (or the declaration if it is also unused locally).`,
                exported: true,
                references: group.total,
            });
        }
    }

    /* ---- Imports ---- */

    for (const file of files) {
        for (const binding of file.imports) {
            if (binding.references > 0) {
                continue;
            }

            if (isImplicitJsxFactoryImport(binding, compilerOptions)) {
                continue;
            }

            const location = getLineAndColumn(file.sourceFile, binding.node);

            issues.push({
                id: ["unused-import", file.relativePath, binding.localName, location.line, location.column].join(":"),
                kind: "unused-import",
                severity: "low",
                name: binding.localName,
                filePath: file.relativePath,
                line: location.line,
                column: location.column,
                message: `Imported symbol "${binding.localName}" appears to be unused.`,
                reason: `The imported binding "${binding.localName}" has no references in this file.`,
                suggestion:
                    "Remove the unused import if it is not required for side effects or special module behavior.",
                exported: false,
                references: 0,
            });
        }
    }

    issues.sort(
        (a, b) =>
            a.filePath.localeCompare(b.filePath) ||
            a.line - b.line ||
            a.column - b.column
    );

    return issues;
}

/* =========================================================
   Summary + recommendations
   ========================================================= */

function buildSummary(issues: DeadCodeIssue[]): DeadCodeSummary {
    const summary: DeadCodeSummary = {
        unusedImports: 0,
        unusedVariables: 0,
        unusedFunctions: 0,
        unusedClasses: 0,
        unusedTypes: 0,
        unusedInterfaces: 0,
        unusedEnums: 0,
        unusedExports: 0,
        totalIssues: issues.length,
    };

    for (const issue of issues) {
        switch (issue.kind) {
            case "unused-import":
                summary.unusedImports++;
                break;
            case "unused-variable":
                summary.unusedVariables++;
                break;
            case "unused-function":
                summary.unusedFunctions++;
                break;
            case "unused-class":
                summary.unusedClasses++;
                break;
            case "unused-type":
                summary.unusedTypes++;
                break;
            case "unused-interface":
                summary.unusedInterfaces++;
                break;
            case "unused-enum":
                summary.unusedEnums++;
                break;
            case "unused-export":
                summary.unusedExports++;
                break;
        }
    }

    return summary;
}

function buildRecommendations(summary: DeadCodeSummary): string[] {
    const recommendations: string[] = [];

    if (summary.unusedImports > 0) {
        recommendations.push(
            "Remove confirmed unused imports to reduce noise and improve maintainability."
        );
    }

    if (summary.unusedFunctions + summary.unusedClasses > 0) {
        recommendations.push(
            "Review unused functions and classes before deletion because dynamic usage may not be visible to static analysis."
        );
    }

    if (
        summary.unusedVariables +
            summary.unusedTypes +
            summary.unusedInterfaces +
            summary.unusedEnums >
        0
    ) {
        recommendations.push(
            "Review unused declarations and remove them when they are no longer part of the application's intended API."
        );
    }

    if (summary.unusedExports > 0) {
        recommendations.push(
            "Review unused exports: keep those that are public API or entry points, and un-export or delete the rest."
        );
    }

    if (summary.totalIssues === 0) {
        recommendations.push(
            "No static dead-code candidates were detected for the selected analysis scope."
        );
    }

    recommendations.push(
        "Re-run the analyzer after cleanup and validate TypeScript compilation and tests before committing changes."
    );

    return recommendations;
}

/* =========================================================
   Validation
   ========================================================= */

function validateProjectPath(projectPath: string): string {
    const resolved = path.resolve(projectPath);

    if (!fs.existsSync(resolved)) {
        throw new Error(`Project path does not exist: ${projectPath}`);
    }

    const real = fs.realpathSync(resolved);

    if (!fs.statSync(real).isDirectory()) {
        throw new Error(`Project path is not a directory: ${projectPath}`);
    }

    return real;
}

function validateFilePath(projectPath: string, filePath: string): string {
    const resolved = path.resolve(projectPath, filePath);

    if (!fs.existsSync(resolved)) {
        throw new Error(`File path does not exist: ${filePath}`);
    }

    // Resolve symlinks so a link cannot point outside the project.
    const absolutePath = fs.realpathSync(resolved);
    const relative = path.relative(projectPath, absolutePath);

    if (
        relative === "" ||
        relative.startsWith("..") ||
        path.isAbsolute(relative)
    ) {
        throw new Error(`File path must be inside the project: ${filePath}`);
    }

    if (!fs.statSync(absolutePath).isFile()) {
        throw new Error(`File path is not a file: ${filePath}`);
    }

    if (!isSupportedSourceFile(absolutePath)) {
        throw new Error(
            `Unsupported source file type (supported: ${[...SUPPORTED_EXTENSIONS].join(", ")}; declaration files excluded): ${filePath}`
        );
    }

    return absolutePath;
}

/* =========================================================
   Main analyzer
   ========================================================= */

export async function analyzeDeadCode(
    projectPath: string,
    filePath?: string,
    symbol?: string,
    options: AnalyzeDeadCodeOptions = {}
): Promise<DeadCodeReport> {
    const includeExports = options.includeExports === true;

    const maxFiles = Math.min(
        Math.max(1, Math.floor(options.maxFiles ?? DEFAULT_MAX_FILES)),
        HARD_MAX_FILES
    );

    const absoluteProjectPath = validateProjectPath(projectPath);

    const { files: collected, truncated } = collectSourceFiles(
        absoluteProjectPath,
        maxFiles
    );

    const requestedAbsolutePath = filePath
        ? validateFilePath(absoluteProjectPath, filePath)
        : undefined;

    /*
     * The whole project is always loaded so that references from OTHER
     * files are visible. A requested file only narrows what is REPORTED.
     */
    const rootNames = new Set<string>(collected);

    if (requestedAbsolutePath) {
        rootNames.add(requestedAbsolutePath);
    }

    if (rootNames.size === 0) {
        throw new Error(
            "No supported TypeScript or JavaScript source files were found."
        );
    }

    const { options: compilerOptions, warnings: configWarnings } =
        loadCompilerOptions(absoluteProjectPath);

    const program = ts.createProgram({
        rootNames: [...rootNames],
        options: compilerOptions,
    });

    const checker = program.getTypeChecker();

    const files: FileInfo[] = [];

    for (const sourceFilePath of rootNames) {
        const info = createFileInfo(
            absoluteProjectPath,
            sourceFilePath,
            program,
            checker
        );

        if (info) {
            files.push(info);
        }
    }

    if (files.length === 0) {
        throw new Error(
            "Unable to create TypeScript source file information."
        );
    }

    const groups = buildSymbolGroups(files, checker);
    const exportedSymbols = countReferences(files, checker, groups);

    let issues = detectIssues(
        files,
        groups,
        exportedSymbols,
        compilerOptions,
        includeExports
    );

    /* ---- Scope: file ---- */

    let scopedFiles = files;

    if (requestedAbsolutePath) {
        const requestedRelative = normalizePath(
            path.relative(absoluteProjectPath, requestedAbsolutePath)
        );

        scopedFiles = files.filter(
            (file) => file.relativePath === requestedRelative
        );

        issues = issues.filter(
            (issue) => issue.filePath === requestedRelative
        );
    }

    /* ---- Scope: symbol ---- */

    const requestedSymbol = symbol?.trim();
    const warnings: string[] = [...configWarnings];

    if (requestedSymbol) {
        const knownNames = new Set<string>();

        for (const file of scopedFiles) {
            for (const declaration of file.declarations) {
                knownNames.add(declaration.name);
            }
            for (const binding of file.imports) {
                knownNames.add(binding.localName);
            }
        }

        issues = issues.filter((issue) => issue.name === requestedSymbol);

        if (issues.length === 0) {
            warnings.push(
                knownNames.has(requestedSymbol)
                    ? `"${requestedSymbol}" exists but is not reported as dead code: it is referenced, intentionally ignored, or exported (enable includeExports to check exports).`
                    : `"${requestedSymbol}" was not found as a tracked declaration or import in the analyzed scope.`
            );
        }
    }

    /* ---- Warnings ---- */

    if (truncated) {
        warnings.push(
            `Analysis was limited to ${maxFiles} source files; references from omitted files are not counted, so results may be incomplete (especially for exports).`
        );
    }

    if (includeExports) {
        warnings.push(
            "Unused-export findings may be public API, package entry points, or used by consumers outside the analyzed project."
        );
    }

    if (issues.length > 0) {
        warnings.push(
            "Static analysis cannot reliably detect dynamic imports, runtime reflection, generated code, or consumers outside the analyzed project."
        );
    }

    const summary = buildSummary(issues);

    return {
        success: true,
        projectPath: absoluteProjectPath,
        filePath,
        symbol,
        summary,
        issues,
        warnings,
        recommendations: buildRecommendations(summary),
    };
}

/* =========================================================
   MCP registration
   ========================================================= */

export function registerAnalyzeDeadCodeTool(server: McpServer): void {
    server.registerTool(
        "analyze_dead_code",
        {
            description:
                "Analyze a TypeScript/JavaScript project (.ts, .tsx, .js, .jsx, .mts, .cts, .mjs, .cjs) for potentially unused imports, variables, functions, classes, types, interfaces, and enums. Optionally reports exports that no other file uses. Other languages are not supported.",

            inputSchema: z.object({
                projectPath: z
                    .string()
                    .describe("Absolute path to the target project."),

                filePath: z
                    .string()
                    .optional()
                    .describe(
                        "Optional source file path relative to the project. Narrows the report to this file; the whole project is still analyzed for references."
                    ),

                symbol: z
                    .string()
                    .optional()
                    .describe("Optional symbol name to analyze."),

                includeExports: z
                    .boolean()
                    .optional()
                    .describe(
                        "Also report exported declarations that no other analyzed file imports. Default false."
                    ),

                maxFiles: z
                    .number()
                    .int()
                    .min(1)
                    .max(HARD_MAX_FILES)
                    .optional()
                    .describe(
                        `Maximum number of source files to analyze. Default ${DEFAULT_MAX_FILES}.`
                    ),
            }),
        },

        async ({ projectPath, filePath, symbol, includeExports, maxFiles }) => {
            try {
                const report = await analyzeDeadCode(
                    projectPath,
                    filePath,
                    symbol,
                    { includeExports, maxFiles }
                );

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify(report, null, 2),
                        },
                    ],
                };
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);

                return {
                    isError: true,
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify(
                                { success: false, error: message },
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