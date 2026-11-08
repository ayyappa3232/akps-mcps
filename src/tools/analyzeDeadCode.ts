import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

/* =========================================================
   Types
   ========================================================= */

type DeadCodeSeverity = "info" | "low" | "medium" | "high";

type DeadCodeConfidence = "high" | "medium" | "low";

type DeadCodeKind =
    | "unused-import"
    | "unused-variable"
    | "unused-function"
    | "unused-class"
    | "unused-type"
    | "unused-interface"
    | "unused-enum"
    | "unused-enum-member"
    | "unused-member"
    | "unused-property"
    | "unused-export"
    | "unused-file";

export interface DeadCodeIssue {
    id: string;
    kind: DeadCodeKind;
    severity: DeadCodeSeverity;

    /**
     * high   = no references and no hint of dynamic use
     * medium = the name also appears as a string literal, or it is a public
     *          member that outside code could reach through an instance
     * low    = heuristic finding (unused-file)
     */
    confidence: DeadCodeConfidence;

    name: string;

    /** Owning class / enum / object for members and properties. */
    container?: string;

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
    unusedFiles: number;
    unusedImports: number;
    unusedVariables: number;
    unusedFunctions: number;
    unusedClasses: number;
    unusedTypes: number;
    unusedInterfaces: number;
    unusedEnums: number;
    unusedEnumMembers: number;
    unusedMembers: number;
    unusedProperties: number;
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
     * Report exported declarations (and public members of exported classes)
     * that nothing else in the project uses. Off by default because exports
     * are often public API. Package entry points are treated as public API.
     */
    includeExports?: boolean;

    /**
     * Report files that no other file imports and that are not entry points.
     */
    includeFiles?: boolean;

    /**
     * Extra entry points (relative to the project, or absolute). Their
     * exports are treated as public API and they are never "unused files".
     * package.json main / module / types / bin / exports / scripts are
     * detected automatically.
     */
    entryPoints?: string[];

    /** Maximum number of source files to analyze. */
    maxFiles?: number;
}

type NameNode = ts.Identifier | ts.PrivateIdentifier | ts.StringLiteral;

/** A tracked declaration (function, class, variable, member, ...). */
interface SymbolInfo {
    name: string;
    kind: DeadCodeKind;
    filePath: string;
    line: number;
    column: number;

    /** Exported via an `export` modifier on the declaration itself. */
    exported: boolean;

    declaration: ts.Node;
    nameNode: NameNode;

    /** Owning class / enum / object-literal variable (for members). */
    container?: SymbolInfo;
    memberKind?: "class" | "object" | "enum";
    isPrivate?: boolean;
    isParameterProperty?: boolean;

    /**
     * Object-literal variables and enums: their members are only reported
     * when the container never "escapes" (is never used as a whole value).
     */
    tracksMembers?: boolean;
}

/**
 * All declarations that share one TypeScript symbol (overloads,
 * interface merging, ...) plus the reference counts for that symbol.
 */
interface SymbolGroup {
    symbol: ts.Symbol;
    infos: SymbolInfo[];

    /** References excluding the declaration itself and self-references. */
    total: number;

    /** References coming from files other than the declaring file(s). */
    external: number;

    /** The container was used as a whole value (spread, passed, iterated...). */
    escaped: boolean;
}

interface ImportBinding {
    localName: string;
    node: ts.Identifier;
    symbol: ts.Symbol;
    filePath: string;
    isNamespace: boolean;
    references: number;
}

interface FileInfo {
    absolutePath: string;
    relativePath: string;
    sourceFile: ts.SourceFile;
    declarations: SymbolInfo[];
    imports: ImportBinding[];
}

interface ScanResult {
    /**
     * Declarations exported through `export { x }` / `export default x`.
     *
     * Declaration NODES are used as identity instead of Symbol objects:
     * the checker may hand back different (instantiated) Symbol objects for
     * the same class member or property at different use sites, but they
     * always point at the same declaration nodes.
     */
    exportedDeclarations: Set<ts.Node>;

    /** Declarations outside code may use (entry points, dynamic imports...). */
    usedDeclarations: Set<ts.Node>;

    /** Absolute paths of every file imported by some analyzed file. */
    importedFiles: Set<string>;

    /** Identifier-like string literals found anywhere in the project. */
    stringNames: Set<string>;
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

const SOURCE_EXTENSIONS = [...SUPPORTED_EXTENSIONS];

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

/** Files that tools (not imports) load, so "nobody imports it" is normal. */
const IMPLICIT_ENTRY_PATTERNS = [
    /\.(test|spec|stories|story|e2e|bench)\.[cm]?[jt]sx?$/i,
    /(^|\/)__(tests|mocks|fixtures)__\//,
    /(^|\/)[\w.-]*\.config\.[cm]?[jt]s$/i,
    /(^|\/)(setupTests|jest\.setup|vitest\.setup)\.[cm]?[jt]s$/i,
];

/** Members that the runtime or common protocols call implicitly. */
const IMPLICIT_MEMBER_NAMES = new Set([
    "toString",
    "toJSON",
    "valueOf",
    "then",
    "catch",
    "finally",
    "inspect",
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

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
    return (
        ts.canHaveModifiers(node) &&
        Boolean(ts.getModifiers(node)?.some((m) => m.kind === kind))
    );
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

    return hasModifier(target, ts.SyntaxKind.ExportKeyword);
}

/**
 * True for `declare ...` declarations and anything nested inside one
 * (e.g. `declare global { ... }`, `declare namespace X { ... }`).
 */
function isInAmbientContext(node: ts.Node): boolean {
    for (
        let current: ts.Node | undefined = node;
        current;
        current = current.parent
    ) {
        if (hasModifier(current, ts.SyntaxKind.DeclareKeyword)) {
            return true;
        }
    }

    return false;
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
function isDeclarationName(node: ts.Identifier | ts.PrivateIdentifier): boolean {
    const parent = node.parent;

    return (
        (ts.isFunctionDeclaration(parent) ||
            ts.isClassDeclaration(parent) ||
            ts.isInterfaceDeclaration(parent) ||
            ts.isTypeAliasDeclaration(parent) ||
            ts.isEnumDeclaration(parent) ||
            ts.isEnumMember(parent) ||
            ts.isVariableDeclaration(parent) ||
            ts.isBindingElement(parent) ||
            ts.isModuleDeclaration(parent) ||
            ts.isParameter(parent) ||
            ts.isPropertyAssignment(parent) ||
            ts.isMethodDeclaration(parent) ||
            ts.isPropertyDeclaration(parent) ||
            ts.isGetAccessorDeclaration(parent) ||
            ts.isSetAccessorDeclaration(parent)) &&
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

/**
 * `ns.x`, `obj["x"]`, `Enum.A` in a type position (`ns.Type`):
 * the container is accessed member-by-member, not used as a whole value.
 */
function isMemberAccessUse(node: ts.Node): boolean {
    const parent = node.parent;

    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        return true;
    }

    if (
        ts.isElementAccessExpression(parent) &&
        parent.expression === node &&
        ts.isStringLiteralLike(parent.argumentExpression)
    ) {
        return true;
    }

    return ts.isQualifiedName(parent) && parent.left === node;
}

/** Statement-level `x++`, `x += 1`: the resulting value is thrown away. */
function isDiscardedExpression(expression: ts.Node): boolean {
    let current: ts.Node = expression;

    while (ts.isParenthesizedExpression(current.parent)) {
        current = current.parent;
    }

    const parent = current.parent;

    return (
        ts.isExpressionStatement(parent) ||
        (ts.isForStatement(parent) && parent.incrementor === current)
    );
}

/**
 * True when the reference only WRITES the symbol and nothing reads it:
 *   x = 1            [a, b] = arr          ({ a: x } = obj)
 *   this.count = 1   x++;  x += 1;  (as statements)
 */
function isWriteOnlyReference(node: ts.Node): boolean {
    let current: ts.Node = node;

    const parent = current.parent;

    if (ts.isPropertyAccessExpression(parent) && parent.name === current) {
        current = parent;
    } else if (
        ts.isElementAccessExpression(parent) &&
        parent.argumentExpression === current
    ) {
        current = parent;
    }

    // Climb out of destructuring-assignment wrappers.
    for (;;) {
        const p: ts.Node = current.parent;

        if (
            ts.isParenthesizedExpression(p) ||
            ts.isArrayLiteralExpression(p) ||
            ts.isObjectLiteralExpression(p) ||
            ts.isSpreadElement(p) ||
            ts.isSpreadAssignment(p) ||
            (ts.isPropertyAssignment(p) && p.initializer === current) ||
            (ts.isShorthandPropertyAssignment(p) && p.name === current)
        ) {
            current = p;
            continue;
        }

        break;
    }

    const owner = current.parent;

    if (ts.isBinaryExpression(owner) && owner.left === current) {
        const operator = owner.operatorToken.kind;

        if (operator === ts.SyntaxKind.EqualsToken) {
            return true;
        }

        if (
            operator >= ts.SyntaxKind.FirstCompoundAssignment &&
            operator <= ts.SyntaxKind.LastCompoundAssignment
        ) {
            return isDiscardedExpression(owner);
        }

        return false;
    }

    if (
        (ts.isPostfixUnaryExpression(owner) ||
            ts.isPrefixUnaryExpression(owner)) &&
        (owner.operator === ts.SyntaxKind.PlusPlusToken ||
            owner.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
        return isDiscardedExpression(owner);
    }

    return false;
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
    node: ts.Node
): ts.Symbol | undefined {
    const parent = node.parent;

    if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
        return checker.getShorthandAssignmentValueSymbol(parent);
    }

    return checker.getSymbolAtLocation(node);
}

function addSymbolDeclarations(
    target: Set<ts.Node>,
    checker: ts.TypeChecker,
    symbol: ts.Symbol
): void {
    for (const declaration of canonicalSymbol(checker, symbol).declarations ?? []) {
        target.add(declaration);
    }
}

function hasSymbolDeclarations(
    target: Set<ts.Node>,
    symbol: ts.Symbol
): boolean {
    return (symbol.declarations ?? []).some((d) => target.has(d));
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
   Declaration collection
   ========================================================= */

/**
 * `const x = { ... }` / `{ ... } as const` / `{ ... } satisfies T`
 *
 * Only un-annotated `const` variables qualify: with a type annotation,
 * `x.prop` resolves to the annotation's property, not the literal's.
 */
function getTrackableObjectLiteral(
    node: ts.VariableDeclaration
): ts.ObjectLiteralExpression | undefined {
    if (
        !ts.isIdentifier(node.name) ||
        node.type ||
        !node.initializer ||
        !ts.isVariableDeclarationList(node.parent) ||
        (node.parent.flags & ts.NodeFlags.Const) === 0
    ) {
        return undefined;
    }

    let expression: ts.Expression = node.initializer;

    for (;;) {
        if (
            ts.isParenthesizedExpression(expression) ||
            ts.isSatisfiesExpression(expression)
        ) {
            expression = expression.expression;
            continue;
        }

        if (
            ts.isAsExpression(expression) &&
            ts.isTypeReferenceNode(expression.type) &&
            ts.isIdentifier(expression.type.typeName) &&
            expression.type.typeName.text === "const"
        ) {
            expression = expression.expression;
            continue;
        }

        break;
    }

    return ts.isObjectLiteralExpression(expression) ? expression : undefined;
}

function collectDeclarations(
    sourceFile: ts.SourceFile,
    relativePath: string
): SymbolInfo[] {
    const declarations: SymbolInfo[] = [];

    const add = (
        node: ts.Node,
        nameNode: NameNode,
        kind: DeadCodeKind,
        extra: Partial<SymbolInfo> = {}
    ): SymbolInfo => {
        const location = getLineAndColumn(sourceFile, nameNode);

        const info: SymbolInfo = {
            name: nameNode.text,
            kind,
            filePath: relativePath,
            line: location.line,
            column: location.column,
            exported: false,
            declaration: node,
            nameNode,
            ...extra,
        };

        declarations.push(info);

        return info;
    };

    /* ---- classes ---- */

    function collectClassMembers(
        node: ts.ClassDeclaration,
        owner: SymbolInfo
    ): void {
        const hasHeritage = (node.heritageClauses?.length ?? 0) > 0;

        for (const member of node.members) {
            // constructor(private foo: string)
            if (ts.isConstructorDeclaration(member)) {
                for (const parameter of member.parameters) {
                    if (
                        ts.isIdentifier(parameter.name) &&
                        hasModifier(parameter, ts.SyntaxKind.PrivateKeyword)
                    ) {
                        add(parameter, parameter.name, "unused-member", {
                            container: owner,
                            memberKind: "class",
                            isPrivate: true,
                            isParameterProperty: true,
                        });
                    }
                }
                continue;
            }

            if (
                !ts.isMethodDeclaration(member) &&
                !ts.isPropertyDeclaration(member) &&
                !ts.isGetAccessorDeclaration(member) &&
                !ts.isSetAccessorDeclaration(member)
            ) {
                continue;
            }

            const name = member.name;

            if (!ts.isIdentifier(name) && !ts.isPrivateIdentifier(name)) {
                continue;
            }

            if (
                IMPLICIT_MEMBER_NAMES.has(name.text) ||
                hasModifier(member, ts.SyntaxKind.AbstractKeyword) ||
                hasModifier(member, ts.SyntaxKind.OverrideKeyword) ||
                hasModifier(member, ts.SyntaxKind.DeclareKeyword) ||
                (ts.canHaveDecorators(member) &&
                    (ts.getDecorators(member)?.length ?? 0) > 0) ||
                (ts.isMethodDeclaration(member) && !member.body)
            ) {
                continue;
            }

            const isPrivate =
                ts.isPrivateIdentifier(name) ||
                hasModifier(member, ts.SyntaxKind.PrivateKeyword);

            // With extends/implements a public member may be an override or
            // an interface implementation reached through the base type.
            if (hasHeritage && !isPrivate) {
                continue;
            }

            add(member, name, "unused-member", {
                container: owner,
                memberKind: "class",
                isPrivate,
            });
        }
    }

    /* ---- enums ---- */

    function collectEnumMembers(
        node: ts.EnumDeclaration,
        owner: SymbolInfo
    ): void {
        for (const member of node.members) {
            if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) {
                owner.tracksMembers = true;

                add(member, member.name, "unused-enum-member", {
                    container: owner,
                    memberKind: "enum",
                });
            }
        }
    }

    /* ---- object literals ---- */

    function collectObjectMembers(
        literal: ts.ObjectLiteralExpression,
        owner: SymbolInfo
    ): void {
        for (const property of literal.properties) {
            if (
                !ts.isPropertyAssignment(property) &&
                !ts.isShorthandPropertyAssignment(property) &&
                !ts.isMethodDeclaration(property) &&
                !ts.isGetAccessorDeclaration(property) &&
                !ts.isSetAccessorDeclaration(property)
            ) {
                continue;
            }

            const name = property.name;

            if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) {
                continue;
            }

            owner.tracksMembers = true;

            add(property, name, "unused-property", {
                container: owner,
                memberKind: "object",
            });
        }
    }

    /* ---- destructuring: const { a, b: [c] } = x ---- */

    function collectBindingPattern(
        declaration: ts.VariableDeclaration,
        pattern: ts.BindingPattern
    ): void {
        // const { used, ...rest } = obj  =>  `used` exists to be omitted
        // from `rest`, so siblings of a rest element are never reported.
        const hasRestSibling =
            ts.isObjectBindingPattern(pattern) &&
            pattern.elements.some((element) => element.dotDotDotToken);

        for (const element of pattern.elements) {
            if (ts.isOmittedExpression(element)) {
                continue;
            }

            if (!ts.isIdentifier(element.name)) {
                collectBindingPattern(declaration, element.name);
                continue;
            }

            if (hasRestSibling && !element.dotDotDotToken) {
                continue;
            }

            if (shouldTrackDeclaration(declaration, element.name)) {
                add(declaration, element.name, "unused-variable", {
                    exported: isExportedDeclaration(declaration),
                });
            }
        }
    }

    function visit(node: ts.Node): void {
        const kind = getDeclarationKind(node);

        if (kind) {
            const nameNode = getDeclarationNameNode(node);

            if (nameNode) {
                if (shouldTrackDeclaration(node, nameNode)) {
                    const info = add(node, nameNode, kind, {
                        exported: isExportedDeclaration(node),
                    });

                    if (ts.isClassDeclaration(node)) {
                        collectClassMembers(node, info);
                    } else if (ts.isEnumDeclaration(node)) {
                        collectEnumMembers(node, info);
                    } else if (ts.isVariableDeclaration(node)) {
                        const literal = getTrackableObjectLiteral(node);

                        if (literal) {
                            collectObjectMembers(literal, info);
                        }
                    }
                }
            } else if (
                ts.isVariableDeclaration(node) &&
                !ts.isIdentifier(node.name)
            ) {
                collectBindingPattern(node, node.name);
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);

    return declarations;
}

/* =========================================================
   Import collection
   ========================================================= */

function collectImports(
    sourceFile: ts.SourceFile,
    relativePath: string,
    checker: ts.TypeChecker
): ImportBinding[] {
    const bindings: ImportBinding[] = [];

    const add = (name: ts.Identifier, isNamespace: boolean): void => {
        const symbol = checker.getSymbolAtLocation(name);

        if (symbol) {
            bindings.push({
                localName: name.text,
                node: name,
                symbol,
                filePath: relativePath,
                isNamespace,
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
                add(clause.name, false);
            }

            const named = clause.namedBindings;

            if (named) {
                if (ts.isNamespaceImport(named)) {
                    add(named.name, true);
                } else {
                    for (const element of named.elements) {
                        add(element.name, false);
                    }
                }
            }
        } else if (
            ts.isImportEqualsDeclaration(statement) &&
            ts.isExternalModuleReference(statement.moduleReference) &&
            !isExportedDeclaration(statement)
        ) {
            // import foo = require("foo")
            add(statement.name, false);
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
   Symbol groups
   ========================================================= */

function buildSymbolGroups(
    files: FileInfo[],
    checker: ts.TypeChecker
): {
    groups: Map<ts.Symbol, SymbolGroup>;
    infoToGroup: Map<SymbolInfo, SymbolGroup>;
    declToGroup: Map<ts.Node, SymbolGroup>;
} {
    const groups = new Map<ts.Symbol, SymbolGroup>();
    const infoToGroup = new Map<SymbolInfo, SymbolGroup>();
    const declToGroup = new Map<ts.Node, SymbolGroup>();

    for (const file of files) {
        for (const declaration of file.declarations) {
            let raw: ts.Symbol | undefined;

            if (declaration.isParameterProperty) {
                // [parameter symbol, property symbol]
                raw = checker.getSymbolsOfParameterPropertyDeclaration(
                    declaration.declaration as ts.ParameterDeclaration,
                    declaration.name
                )[1];
            } else {
                raw = checker.getSymbolAtLocation(declaration.nameNode);
            }

            if (!raw) {
                continue;
            }

            const symbol = canonicalSymbol(checker, raw);

            let group = groups.get(symbol);

            if (!group) {
                group = {
                    symbol,
                    infos: [],
                    total: 0,
                    external: 0,
                    escaped: false,
                };
                groups.set(symbol, group);

                for (const node of symbol.declarations ?? []) {
                    declToGroup.set(node, group);
                }
            }

            group.infos.push(declaration);
            infoToGroup.set(declaration, group);
        }
    }

    return { groups, infoToGroup, declToGroup };
}

/* =========================================================
   Package entry points
   ========================================================= */

function collectStrings(value: unknown, out: string[]): void {
    if (typeof value === "string") {
        out.push(value);
    } else if (Array.isArray(value)) {
        for (const item of value) {
            collectStrings(item, out);
        }
    } else if (value && typeof value === "object") {
        for (const item of Object.values(value)) {
            collectStrings(item, out);
        }
    }
}

/**
 * Entry-point candidates from package.json (main, module, types, bin,
 * exports, scripts) plus caller-provided entry points.
 */
function readEntryCandidates(
    projectPath: string,
    extra: string[]
): string[] {
    const candidates: string[] = [...extra];

    try {
        const packageJson = JSON.parse(
            fs.readFileSync(path.join(projectPath, "package.json"), "utf8")
        ) as Record<string, unknown>;

        for (const key of [
            "main",
            "module",
            "types",
            "typings",
            "browser",
            "bin",
            "exports",
        ]) {
            collectStrings(packageJson[key], candidates);
        }

        // "dev": "tsx src/server.ts"  =>  src/server.ts
        const scripts = packageJson.scripts;

        if (scripts && typeof scripts === "object") {
            for (const script of Object.values(scripts)) {
                if (typeof script !== "string") {
                    continue;
                }

                for (const match of script.matchAll(
                    /(?:^|[\s"'=])((?:\.{0,2}\/)?[\w@./-]+\.[cm]?[jt]sx?)(?=$|[\s"';&|])/g
                )) {
                    candidates.push(match[1]);
                }
            }
        }
    } catch {
        // No readable package.json: only explicit entry points are used.
    }

    return candidates.filter(
        (candidate) =>
            !candidate.includes("*") &&
            !/^(https?:|node:)/.test(candidate)
    );
}

/**
 * Maps `./dist/index.js` (or `./src/index`, `./lib/cli.d.ts`, ...) to the
 * analyzed source files it most likely corresponds to.
 */
function resolveEntryFiles(
    projectPath: string,
    compilerOptions: ts.CompilerOptions,
    analyzed: Map<string, FileInfo>,
    extra: string[]
): Set<FileInfo> {
    const result = new Set<FileInfo>();

    const outRoots = [
        compilerOptions.outDir,
        ...["dist", "build", "lib", "out"].map((d) =>
            path.join(projectPath, d)
        ),
    ].filter((root): root is string => Boolean(root));

    const sourceRoots = [
        compilerOptions.rootDir,
        path.join(projectPath, "src"),
        projectPath,
    ].filter((root): root is string => Boolean(root));

    for (const candidate of readEntryCandidates(projectPath, extra)) {
        const absolute = path.resolve(projectPath, candidate);

        const stem = isDeclarationFile(absolute)
            ? absolute.replace(/\.d\.[cm]?ts$/i, "")
            : absolute.slice(0, absolute.length - path.extname(absolute).length);

        const attempts = new Set<string>([absolute]);

        const addStem = (base: string): void => {
            for (const ext of SOURCE_EXTENSIONS) {
                attempts.add(base + ext);
                attempts.add(path.join(base, `index${ext}`));
            }
        };

        addStem(stem);
        addStem(absolute); // extension-less candidates like "./src/index"

        for (const outRoot of outRoots) {
            const relative = path.relative(outRoot, stem);

            if (relative.startsWith("..") || path.isAbsolute(relative)) {
                continue;
            }

            for (const sourceRoot of sourceRoots) {
                addStem(path.join(sourceRoot, relative));
            }
        }

        for (const attempt of attempts) {
            const file = analyzed.get(path.resolve(attempt));

            if (file) {
                result.add(file);
            }
        }
    }

    return result;
}

/* =========================================================
   Project scan (references, exports, imports, dynamic use)
   ========================================================= */

function scanProject(
    files: FileInfo[],
    program: ts.Program,
    checker: ts.TypeChecker,
    groups: Map<ts.Symbol, SymbolGroup>,
    declToGroup: Map<ts.Node, SymbolGroup>,
    compilerOptions: ts.CompilerOptions
): ScanResult {
    const exportedDeclarations = new Set<ts.Node>();
    const usedDeclarations = new Set<ts.Node>();
    const importedFiles = new Set<string>();
    const stringNames = new Set<string>();

    const resolutionCache = ts.createModuleResolutionCache(
        process.cwd(),
        (fileName) => fileName,
        compilerOptions
    );

    // Imports are matched by their own import-specifier node, which stays
    // correct even when the module cannot be resolved (every unresolved
    // alias would otherwise collapse into the same "unknown" symbol).
    const importByDeclaration = new Map<ts.Node, ImportBinding>();

    const findImport = (symbol: ts.Symbol): ImportBinding | undefined => {
        for (const declaration of symbol.declarations ?? []) {
            const binding = importByDeclaration.get(declaration);

            if (binding) {
                return binding;
            }
        }

        return undefined;
    };

    for (const file of files) {
        for (const binding of file.imports) {
            for (const declaration of binding.symbol.declarations ?? []) {
                importByDeclaration.set(declaration, binding);
            }
        }
    }

    const findGroup = (symbol: ts.Symbol): SymbolGroup | undefined => {
        const canonical = canonicalSymbol(checker, symbol);
        const direct = groups.get(canonical);

        if (direct) {
            return direct;
        }

        for (const declaration of canonical.declarations ?? []) {
            const group = declToGroup.get(declaration);

            if (group) {
                return group;
            }
        }

        return undefined;
    };

    /** Every export of this module may be used by code we cannot see. */
    const markModuleSymbolUsed = (moduleSymbol: ts.Symbol): void => {
        for (const exported of checker.getExportsOfModule(moduleSymbol)) {
            addSymbolDeclarations(usedDeclarations, checker, exported);
        }
    };

    const markModuleFileUsed = (resolvedFileName: string): void => {
        const sourceFile = program.getSourceFile(resolvedFileName);
        const moduleSymbol =
            sourceFile && checker.getSymbolAtLocation(sourceFile);

        if (moduleSymbol) {
            markModuleSymbolUsed(moduleSymbol);
        }
    };

    const noteModule = (
        specifier: string,
        from: FileInfo,
        markExportsUsed: boolean
    ): void => {
        const resolved = ts.resolveModuleName(
            specifier,
            from.absolutePath,
            compilerOptions,
            ts.sys,
            resolutionCache
        ).resolvedModule?.resolvedFileName;

        if (!resolved) {
            return;
        }

        importedFiles.add(path.resolve(resolved));

        if (markExportsUsed) {
            markModuleFileUsed(resolved);
        }
    };

    const recordUse = (
        symbol: ts.Symbol,
        node: ts.Node,
        file: FileInfo
    ): void => {
        const group = findGroup(symbol);

        if (!group) {
            return;
        }

        // Members of enums / object literals are only reportable while the
        // container is accessed member-by-member.
        if (
            group.infos[0].tracksMembers &&
            !isMemberAccessUse(node) &&
            !(
                group.infos[0].kind === "unused-enum" &&
                ts.isTypeReferenceNode(node.parent)
            )
        ) {
            group.escaped = true;
        }

        if (isInsideOwnDeclaration(group, file, node)) {
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
            const binding = findImport(local);

            if (binding) {
                binding.references++;

                // import * as ns; export { ns }  =>  whole module re-exported
                if (binding.isNamespace) {
                    markModuleSymbolUsed(checker.getAliasedSymbol(local));
                }
            }

            recordUse(local, node, file);
            return;
        }

        addSymbolDeclarations(exportedDeclarations, checker, local);
    };

    const scanModuleUsage = (node: ts.Node, file: FileInfo): void => {
        if (
            ts.isImportDeclaration(node) &&
            ts.isStringLiteral(node.moduleSpecifier)
        ) {
            noteModule(node.moduleSpecifier.text, file, false);
        } else if (
            ts.isExportDeclaration(node) &&
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier)
        ) {
            // export * as ns from "./x"  =>  consumers can reach everything
            noteModule(
                node.moduleSpecifier.text,
                file,
                Boolean(node.exportClause && ts.isNamespaceExport(node.exportClause))
            );
        } else if (
            ts.isImportEqualsDeclaration(node) &&
            ts.isExternalModuleReference(node.moduleReference) &&
            ts.isStringLiteralLike(node.moduleReference.expression)
        ) {
            noteModule(node.moduleReference.expression.text, file, false);
        } else if (
            ts.isImportTypeNode(node) &&
            ts.isLiteralTypeNode(node.argument) &&
            ts.isStringLiteral(node.argument.literal)
        ) {
            noteModule(node.argument.literal.text, file, true);
        } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
            // import("./x")  /  require("./x"): the result is a whole module
            const argument = node.arguments[0];

            if (
                ts.isStringLiteralLike(argument) &&
                (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                    (ts.isIdentifier(node.expression) &&
                        node.expression.text === "require"))
            ) {
                noteModule(argument.text, file, true);
            }
        }
    };

    const visitName = (
        node: ts.Identifier | ts.PrivateIdentifier,
        file: FileInfo
    ): void => {
        if (
            isDeclarationName(node) ||
            (ts.isIdentifier(node) && isImportBindingName(node))
        ) {
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
                    file
                );
                return;
            }
            // `export { a } from "./a"` falls through and counts as a use.
        }

        if (ts.isExportAssignment(parent) && parent.expression === node) {
            handleLocalExport(checker.getSymbolAtLocation(node), node, file);
            return;
        }

        const raw = getReferencedSymbol(checker, node);

        if (!raw) {
            return;
        }

        const binding = findImport(raw);

        if (binding) {
            binding.references++;

            // `ns` passed around / spread / iterated: any export may be used.
            if (binding.isNamespace && !isMemberAccessUse(node)) {
                markModuleSymbolUsed(checker.getAliasedSymbol(raw));
            }
        }

        if (isWriteOnlyReference(node)) {
            return;
        }

        recordUse(raw, node, file);
    };

    for (const file of files) {
        const visit = (node: ts.Node): void => {
            scanModuleUsage(node, file);

            if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
                visitName(node, file);
            } else if (ts.isStringLiteralLike(node)) {
                const parent = node.parent;

                if (
                    !ts.isImportDeclaration(parent) &&
                    !ts.isExportDeclaration(parent) &&
                    !ts.isExternalModuleReference(parent) &&
                    node.text.length <= 100 &&
                    /^[A-Za-z_$][\w$]*$/.test(node.text)
                ) {
                    stringNames.add(node.text);
                }

                // obj["member"]
                if (
                    ts.isElementAccessExpression(parent) &&
                    parent.argumentExpression === node
                ) {
                    const raw = checker.getSymbolAtLocation(node);

                    if (raw && !isWriteOnlyReference(node)) {
                        recordUse(raw, node, file);
                    }
                }
            }

            ts.forEachChild(node, visit);
        };

        visit(file.sourceFile);
    }

    return {
        exportedDeclarations,
        usedDeclarations,
        importedFiles,
        stringNames,
    };
}

/* =========================================================
   Issue detection
   ========================================================= */

interface IssueText {
    message: string;
    reason: string;
    suggestion: string;
}

function makeIssue(
    kind: DeadCodeKind,
    severity: DeadCodeSeverity,
    confidence: DeadCodeConfidence,
    where: {
        name: string;
        container?: string;
        filePath: string;
        line: number;
        column: number;
    },
    text: IssueText,
    exported: boolean,
    references: number
): DeadCodeIssue {
    return {
        id: [
            kind,
            where.filePath,
            where.container ?? "",
            where.name,
            where.line,
            where.column,
        ].join(":"),
        kind,
        severity,
        confidence,
        name: where.name,
        container: where.container,
        filePath: where.filePath,
        line: where.line,
        column: where.column,
        ...text,
        exported,
        references,
    };
}

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

interface DetectContext {
    files: FileInfo[];
    groups: Map<ts.Symbol, SymbolGroup>;
    infoToGroup: Map<SymbolInfo, SymbolGroup>;
    scan: ScanResult;
    entryFiles: Set<FileInfo>;
    compilerOptions: ts.CompilerOptions;
    includeExports: boolean;
    includeFiles: boolean;
}

function detectIssues(context: DetectContext): DeadCodeIssue[] {
    const {
        files,
        groups,
        infoToGroup,
        scan,
        entryFiles,
        compilerOptions,
        includeExports,
        includeFiles,
    } = context;

    const issues: DeadCodeIssue[] = [];

    const containerGroupOf = (group: SymbolGroup): SymbolGroup | undefined => {
        const container = group.infos[0].container;
        return container ? infoToGroup.get(container) : undefined;
    };

    const isExported = (group: SymbolGroup): boolean => {
        const info = group.infos[0];

        if (info.container) {
            if (info.isPrivate) {
                return false;
            }

            const containerGroup = containerGroupOf(group);
            return containerGroup ? isExported(containerGroup) : false;
        }

        return (
            group.infos.some((i) => i.exported) ||
            hasSymbolDeclarations(scan.exportedDeclarations, group.symbol)
        );
    };

    /** Entry-point exports, dynamically imported modules, escaped namespaces. */
    const isPublicApi = (group: SymbolGroup): boolean => {
        if (hasSymbolDeclarations(scan.usedDeclarations, group.symbol)) {
            return true;
        }

        const containerGroup = containerGroupOf(group);
        return containerGroup ? isPublicApi(containerGroup) : false;
    };

    const confidenceFor = (
        info: SymbolInfo,
        group: SymbolGroup
    ): DeadCodeConfidence => {
        if (scan.stringNames.has(info.name)) {
            return "medium";
        }

        // Instances can be handed to code we cannot see.
        if (info.memberKind === "class" && !info.isPrivate) {
            return "medium";
        }

        void group;
        return "high";
    };

    const dynamicHint = (info: SymbolInfo): string =>
        scan.stringNames.has(info.name)
            ? ` The name also appears as a string literal in the project, which may indicate dynamic or reflective use.`
            : "";

    /* ---- Declarations (one issue per symbol, not per overload) ---- */

    for (const group of groups.values()) {
        const info = group.infos[0];
        const container = info.container?.name;
        const label = info.kind.replace(/^unused-/, "").replace(/-/g, " ");
        const qualified = container ? `${container}.${info.name}` : info.name;

        if (isPublicApi(group)) {
            continue;
        }

        const where = {
            name: info.name,
            container,
            filePath: info.filePath,
            line: info.line,
            column: info.column,
        };

        // Enum members / object properties: only while the container is
        // always accessed member-by-member and never exported.
        if (info.memberKind === "object" || info.memberKind === "enum") {
            const containerGroup = containerGroupOf(group);

            if (
                !containerGroup ||
                containerGroup.escaped ||
                isExported(containerGroup) ||
                group.total > 0
            ) {
                continue;
            }

            issues.push(
                makeIssue(
                    info.kind,
                    "low",
                    confidenceFor(info, group),
                    where,
                    {
                        message: `${label} "${qualified}" appears to be unused.`,
                        reason: `"${container}" is only ever accessed member-by-member and nothing reads "${info.name}".${dynamicHint(info)}`,
                        suggestion: `Remove "${info.name}" if it is not read by serialization, reflection, or external code.`,
                    },
                    false,
                    0
                )
            );
            continue;
        }

        const exported = isExported(group);

        if (!exported && group.total === 0) {
            issues.push(
                makeIssue(
                    info.kind,
                    info.kind === "unused-function" ||
                        info.kind === "unused-class"
                        ? "medium"
                        : "low",
                    confidenceFor(info, group),
                    where,
                    {
                        message: `${label} "${qualified}" appears to be unused.`,
                        reason: `No references to "${qualified}" were found in the analyzed TypeScript/JavaScript program.${dynamicHint(info)}`,
                        suggestion: `Verify that "${qualified}" is not used dynamically or externally. If it is truly unused, consider removing it.`,
                    },
                    false,
                    0
                )
            );
            continue;
        }

        if (!includeExports || !exported) {
            continue;
        }

        // Public members of exported classes: only when nothing at all
        // (including the class itself) uses them.
        if (info.memberKind === "class") {
            if (group.total === 0) {
                issues.push(
                    makeIssue(
                        "unused-member",
                        "info",
                        "medium",
                        where,
                        {
                            message: `Public member "${qualified}" is not used anywhere in the analyzed project.`,
                            reason: `"${qualified}" belongs to an exported class but nothing in the project references it.${dynamicHint(info)}`,
                            suggestion: `If "${container}" is a public API, keep it. Otherwise remove the member.`,
                        },
                        true,
                        0
                    )
                );
            }
            continue;
        }

        if (group.external === 0) {
            issues.push(
                makeIssue(
                    "unused-export",
                    "info",
                    "medium",
                    where,
                    {
                        message: `Exported ${label} "${info.name}" is not imported by any other analyzed file.`,
                        reason:
                            group.total > 0
                                ? `"${info.name}" is only used inside its own file, so the export may be unnecessary.`
                                : `"${info.name}" is exported but has no references anywhere in the analyzed program.${dynamicHint(info)}`,
                        suggestion: `If "${info.name}" is not part of a public API or entry point, remove the export (or the declaration if it is also unused locally).`,
                    },
                    true,
                    group.total
                )
            );
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

            issues.push(
                makeIssue(
                    "unused-import",
                    "low",
                    "high",
                    {
                        name: binding.localName,
                        filePath: file.relativePath,
                        line: location.line,
                        column: location.column,
                    },
                    {
                        message: `Imported symbol "${binding.localName}" appears to be unused.`,
                        reason: `The imported binding "${binding.localName}" has no references in this file.`,
                        suggestion:
                            "Remove the unused import if it is not required for side effects or special module behavior.",
                    },
                    false,
                    0
                )
            );
        }
    }

    /* ---- Files nobody imports ---- */

    if (includeFiles) {
        for (const file of files) {
            if (
                entryFiles.has(file) ||
                scan.importedFiles.has(path.resolve(file.absolutePath)) ||
                IMPLICIT_ENTRY_PATTERNS.some((pattern) =>
                    pattern.test(file.relativePath)
                )
            ) {
                continue;
            }

            issues.push(
                makeIssue(
                    "unused-file",
                    "info",
                    entryFiles.size > 0 ? "medium" : "low",
                    {
                        name: path.basename(file.relativePath),
                        filePath: file.relativePath,
                        line: 1,
                        column: 1,
                    },
                    {
                        message: `File "${file.relativePath}" is not imported by any other analyzed file.`,
                        reason: `No import, re-export, require() or import() in the analyzed project resolves to this file, and it is not a detected entry point.`,
                        suggestion:
                            "If this file is a script, config, or entry point loaded by a tool, add it to entryPoints. Otherwise it may be removable.",
                    },
                    false,
                    0
                )
            );
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
        unusedFiles: 0,
        unusedImports: 0,
        unusedVariables: 0,
        unusedFunctions: 0,
        unusedClasses: 0,
        unusedTypes: 0,
        unusedInterfaces: 0,
        unusedEnums: 0,
        unusedEnumMembers: 0,
        unusedMembers: 0,
        unusedProperties: 0,
        unusedExports: 0,
        totalIssues: issues.length,
    };

    for (const issue of issues) {
        switch (issue.kind) {
            case "unused-file":
                summary.unusedFiles++;
                break;
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
            case "unused-enum-member":
                summary.unusedEnumMembers++;
                break;
            case "unused-member":
                summary.unusedMembers++;
                break;
            case "unused-property":
                summary.unusedProperties++;
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
            summary.unusedEnums +
            summary.unusedEnumMembers +
            summary.unusedMembers +
            summary.unusedProperties >
        0
    ) {
        recommendations.push(
            "Review unused declarations and members; start with issues marked confidence \"high\" and check \"medium\" ones for dynamic or external use."
        );
    }

    if (summary.unusedExports + summary.unusedFiles > 0) {
        recommendations.push(
            "Review unused exports and files: keep public API, entry points, and tool-loaded files; list them in entryPoints so they stop being reported."
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
            `Unsupported source file type (supported: ${SOURCE_EXTENSIONS.join(", ")}; declaration files excluded): ${filePath}`
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
    const includeFiles = options.includeFiles === true;

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
    const filesByPath = new Map<string, FileInfo>();

    for (const sourceFilePath of rootNames) {
        const info = createFileInfo(
            absoluteProjectPath,
            sourceFilePath,
            program,
            checker
        );

        if (info) {
            files.push(info);
            filesByPath.set(path.resolve(sourceFilePath), info);
        }
    }

    if (files.length === 0) {
        throw new Error(
            "Unable to create TypeScript source file information."
        );
    }

    const { groups, infoToGroup, declToGroup } = buildSymbolGroups(
        files,
        checker
    );

    const scan = scanProject(
        files,
        program,
        checker,
        groups,
        declToGroup,
        compilerOptions
    );

    /* ---- Entry points = public API ---- */

    const entryFiles = resolveEntryFiles(
        absoluteProjectPath,
        compilerOptions,
        filesByPath,
        options.entryPoints ?? []
    );

    for (const entry of entryFiles) {
        const moduleSymbol = checker.getSymbolAtLocation(entry.sourceFile);

        if (moduleSymbol) {
            for (const exported of checker.getExportsOfModule(moduleSymbol)) {
                addSymbolDeclarations(scan.usedDeclarations, checker, exported);
            }
        }
    }

    let issues = detectIssues({
        files,
        groups,
        infoToGroup,
        scan,
        entryFiles,
        compilerOptions,
        includeExports,
        includeFiles,
    });

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

    /* ---- Scope: symbol ("name" or "Container.name") ---- */

    const requestedSymbol = symbol?.trim();
    const warnings: string[] = [...configWarnings];

    if (requestedSymbol) {
        const knownNames = new Set<string>();

        for (const file of scopedFiles) {
            for (const declaration of file.declarations) {
                knownNames.add(declaration.name);

                if (declaration.container) {
                    knownNames.add(
                        `${declaration.container.name}.${declaration.name}`
                    );
                }
            }

            for (const binding of file.imports) {
                knownNames.add(binding.localName);
            }
        }

        issues = issues.filter(
            (issue) =>
                issue.name === requestedSymbol ||
                (issue.container !== undefined &&
                    `${issue.container}.${issue.name}` === requestedSymbol)
        );

        if (issues.length === 0) {
            warnings.push(
                knownNames.has(requestedSymbol)
                    ? `"${requestedSymbol}" exists but is not reported as dead code: it is referenced, intentionally ignored, public API, or exported (enable includeExports to check exports).`
                    : `"${requestedSymbol}" was not found as a tracked declaration, member, or import in the analyzed scope.`
            );
        }
    }

    /* ---- Warnings ---- */

    if (truncated) {
        warnings.push(
            `Analysis was limited to ${maxFiles} source files; references from omitted files are not counted, so results may be incomplete (especially for exports and files).`
        );
    }

    if ((includeExports || includeFiles) && entryFiles.size === 0) {
        warnings.push(
            "No entry points were detected (package.json main/module/types/bin/exports/scripts or the entryPoints option), so entry-point exports and files may be reported as unused."
        );
    }

    if (includeExports) {
        warnings.push(
            "Unused-export findings may be public API or used by consumers outside the analyzed project."
        );
    }

    if (issues.length > 0) {
        warnings.push(
            "Static analysis cannot reliably detect reflection, string-built property access, generated code, or consumers outside the analyzed project. Issues with confidence \"medium\" or \"low\" deserve extra scrutiny."
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
                "Analyze a TypeScript/JavaScript project (.ts, .tsx, .js, .jsx, .mts, .cts, .mjs, .cjs) for potentially unused imports, variables (including destructured ones), functions, classes, class members, object-literal properties, enums and enum members, types, and interfaces. Optionally reports unused exports and files that nothing imports. Package entry points are treated as public API. Other languages are not supported.",

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
                    .describe(
                        'Optional symbol name to analyze. Members can be addressed as "ClassName.member".'
                    ),

                includeExports: z
                    .boolean()
                    .optional()
                    .describe(
                        "Also report exported declarations (and public members of exported classes) that nothing else uses. Default false."
                    ),

                includeFiles: z
                    .boolean()
                    .optional()
                    .describe(
                        "Also report files that no other file imports and that are not entry points. Default false."
                    ),

                entryPoints: z
                    .array(z.string())
                    .optional()
                    .describe(
                        "Extra entry-point files (relative to the project). Their exports are public API and they are never reported as unused files. package.json entries are detected automatically."
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

        async ({
            projectPath,
            filePath,
            symbol,
            includeExports,
            includeFiles,
            entryPoints,
            maxFiles,
        }) => {
            try {
                const report = await analyzeDeadCode(
                    projectPath,
                    filePath,
                    symbol,
                    { includeExports, includeFiles, entryPoints, maxFiles }
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