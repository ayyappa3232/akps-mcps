import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export type ApiUsageCategory =
  | "http"
  | "firebase-firestore"
  | "firebase-auth"
  | "firebase-storage"
  | "firebase-functions";

export interface ApiEndpointUsage {
  id: string;
  category: ApiUsageCategory;
  method: string;
  endpoint: string;

  /**
   * The original URL expression when the endpoint was resolved from a
   * variable / template (e.g. "apiUrl" resolved to "http://.../api/x").
   */
  urlExpression?: string;

  operation?: string;
  resource?: string;
  filePath: string;
  line: number;
  column: number;
  caller?: string;
  library: string;
  expression: string;
  confidence: "high" | "medium" | "low";
}

export interface ApiEndpointReport {
  success: boolean;
  projectPath: string;
  filePath?: string;
  totalEndpoints: number;
  endpoints: ApiEndpointUsage[];
  summary: {
    GET: number;
    POST: number;
    PUT: number;
    PATCH: number;
    DELETE: number;
    OTHER: number;
    FIREBASE_FIRESTORE: number;
    FIREBASE_AUTH: number;
    FIREBASE_STORAGE: number;
    FIREBASE_FUNCTIONS: number;
  };
  warnings: string[];
}

interface SourceFileInfo {
  sourceFile: ts.SourceFile;
  absolutePath: string;
  relativePath: string;
}

const SUPPORTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
]);

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".next",
  ".turbo",
  ".cache",
]);

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function getScriptKind(filePath: string): ts.ScriptKind {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case ".tsx":
      return ts.ScriptKind.TSX;

    case ".jsx":
      return ts.ScriptKind.JSX;

    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;

    case ".ts":
    case ".mts":
    case ".cts":
    default:
      return ts.ScriptKind.TS;
  }
}

function getCallerName(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (
      ts.isFunctionDeclaration(current) &&
      current.name
    ) {
      return current.name.getText();
    }

    if (
      ts.isMethodDeclaration(current) &&
      current.name
    ) {
      return current.name.getText();
    }

    if (
      ts.isGetAccessorDeclaration(current) &&
      current.name
    ) {
      return current.name.getText();
    }

    if (
      ts.isSetAccessorDeclaration(current) &&
      current.name
    ) {
      return current.name.getText();
    }

    if (
      ts.isConstructorDeclaration(current)
    ) {
      return "constructor";
    }

    if (
      ts.isVariableDeclaration(current) &&
      current.initializer &&
      (
        ts.isArrowFunction(current.initializer) ||
        ts.isFunctionExpression(current.initializer)
      )
    ) {
      return current.name.getText();
    }

    current = current.parent;
  }

  return undefined;
}

function getStringValue(
  expression: ts.Expression
): string | undefined {
  if (ts.isStringLiteral(expression)) {
    return expression.text;
  }

  if (ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }

  if (ts.isTemplateExpression(expression)) {
    let result = expression.head.text;

    for (const span of expression.templateSpans) {
      result += `\${${span.expression.getText()}}`;
      result += span.literal.text;
    }

    return result;
  }

  return undefined;
}


function isLikelyHttpClientExpression(
  expression: ts.Expression
): boolean {

  // Only treat a property named get/post/put/patch/delete as HTTP
  // when the receiver looks like an HTTP client.
  //
  // Examples accepted:
  //   axios.get(...)
  //   apiClient.get(...)
  //   httpClient.post(...)
  //   userApi.get(...)
  //   this.apiClient.get(...)
  //
  // Examples rejected:
  //   this.audioCache.get(...)
  //   this.sounds.get(...)
  //   cache.get(...)
  //   map.get(...)
  //   state.get(...)
  if (ts.isIdentifier(expression)) {
    return /^(axios|api|http|client|request)(client)?$/i.test(
      expression.text
    ) || /(?:api|client|http|request)$/i.test(expression.text);
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return /(?:api|client|http|request)$/i.test(
      expression.name.text
    );
  }

  return false;
}

function getHttpMethod(
  propertyName: string
): string | undefined {
  const method = propertyName.toLowerCase();

  switch (method) {
    case "get":
      return "GET";

    case "post":
      return "POST";

    case "put":
      return "PUT";

    case "patch":
      return "PATCH";

    case "delete":
      return "DELETE";

    case "head":
      return "HEAD";

    case "options":
      return "OPTIONS";

    default:
      return undefined;
  }
}

interface FirebaseImportInfo {
  module: string;
  localName: string;
  importedName: string;
  kind: "named" | "namespace" | "default";
}

function collectFirebaseImports(
  sourceFile: ts.SourceFile
): Map<string, FirebaseImportInfo> {
  const imports = new Map<string, FirebaseImportInfo>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }

    const specifier = statement.moduleSpecifier;

    if (!ts.isStringLiteral(specifier)) {
      continue;
    }

    const moduleName = specifier.text;

    if (!moduleName.startsWith("firebase/")) {
      continue;
    }

    const clause = statement.importClause;

    if (!clause) {
      continue;
    }

    if (clause.name) {
      imports.set(clause.name.text, {
        module: moduleName,
        localName: clause.name.text,
        importedName: "default",
        kind: "default",
      });
    }

    const bindings = clause.namedBindings;

    if (!bindings) {
      continue;
    }

    if (ts.isNamespaceImport(bindings)) {
      imports.set(bindings.name.text, {
        module: moduleName,
        localName: bindings.name.text,
        importedName: "*",
        kind: "namespace",
      });
      continue;
    }

    for (const element of bindings.elements) {
      const importedName =
        element.propertyName?.text ?? element.name.text;

      imports.set(element.name.text, {
        module: moduleName,
        localName: element.name.text,
        importedName,
        kind: "named",
      });
    }
  }

  return imports;
}

function firebaseCategory(
  moduleName: string
): ApiUsageCategory | undefined {
  if (moduleName === "firebase/firestore") {
    return "firebase-firestore";
  }

  if (moduleName === "firebase/auth") {
    return "firebase-auth";
  }

  if (moduleName === "firebase/storage") {
    return "firebase-storage";
  }

  if (
    moduleName === "firebase/functions" ||
    moduleName === "firebase/functions/https"
  ) {
    return "firebase-functions";
  }

  return undefined;
}

function firebaseOperation(
  importedName: string,
  moduleName: string
): string | undefined {
  const category = firebaseCategory(moduleName);

  if (!category) {
    return undefined;
  }

  const operations: Record<string, Set<string>> = {
    "firebase-firestore": new Set([
      "getDoc",
      "getDocs",
      "setDoc",
      "addDoc",
      "updateDoc",
      "deleteDoc",
      "onSnapshot",
      "getCountFromServer",
      "getAggregateFromServer",
      "runTransaction",
      "writeBatch",
    ]),
    "firebase-auth": new Set([
      "signInWithEmailAndPassword",
      "createUserWithEmailAndPassword",
      "signOut",
      "signInWithPopup",
      "signInWithRedirect",
      "sendPasswordResetEmail",
      "updateProfile",
      "updateEmail",
      "updatePassword",
      "deleteUser",
      "reauthenticateWithCredential",
      "onAuthStateChanged",
      "onIdTokenChanged",
    ]),
    "firebase-storage": new Set([
      "uploadBytes",
      "uploadBytesResumable",
      "getDownloadURL",
      "deleteObject",
      "getMetadata",
      "updateMetadata",
      "list",
      "listAll",
    ]),
    "firebase-functions": new Set([
      "httpsCallable",
      "httpsCallableFromURL",
    ]),
  };

  return operations[category]?.has(importedName)
    ? importedName
    : undefined;
}

function findFirebaseResource(
  node: ts.CallExpression,
  operation: string
): string | undefined {
  function walk(expression: ts.Expression): string | undefined {
    if (ts.isCallExpression(expression)) {
      const name = expression.expression.getText();

      if (
        name === "collection" ||
        name.endsWith(".collection") ||
        name === "doc" ||
        name.endsWith(".doc")
      ) {
        const values = expression.arguments
          .map(getStringValue)
          .filter(
            (value): value is string =>
              value !== undefined
          );

        if (values.length > 0) {
          return values.join("/");
        }
      }

      for (const argument of expression.arguments) {
        const nested = walk(argument);

        if (nested) {
          return nested;
        }
      }
    }

    return getStringValue(expression);
  }

  const firstArgument = node.arguments[0];

  if (!firstArgument) {
    return undefined;
  }

  if (
    operation === "getDoc" ||
    operation === "getDocs" ||
    operation === "setDoc" ||
    operation === "addDoc" ||
    operation === "updateDoc" ||
    operation === "deleteDoc" ||
    operation === "onSnapshot"
  ) {
    return walk(firstArgument);
  }

  return getStringValue(firstArgument);
}

function getFirebaseCallInfo(
  node: ts.CallExpression,
  imports: Map<string, FirebaseImportInfo>
): {
  category: ApiUsageCategory;
  method: string;
  endpoint: string;
  operation: string;
  resource?: string;
  library: string;
  confidence: "high" | "medium" | "low";
} | undefined {
  const expression = node.expression;

  let importedName: string | undefined;
  let moduleName: string | undefined;

  if (ts.isIdentifier(expression)) {
    const info = imports.get(expression.text);

    if (!info) {
      return undefined;
    }

    importedName = info.importedName;
    moduleName = info.module;
  } else if (ts.isPropertyAccessExpression(expression)) {
    const object = expression.expression;

    if (!ts.isIdentifier(object)) {
      return undefined;
    }

    const info = imports.get(object.text);

    if (!info || info.kind !== "namespace") {
      return undefined;
    }

    importedName = expression.name.text;
    moduleName = info.module;
  }

  if (!importedName || !moduleName) {
    return undefined;
  }

  const operation =
    firebaseOperation(
      importedName,
      moduleName
    );

  if (!operation) {
    return undefined;
  }

  const category =
    firebaseCategory(moduleName);

  if (!category) {
    return undefined;
  }

  const resource =
    findFirebaseResource(
      node,
      operation
    );

  return {
    category,
    method: category.toUpperCase(),
    endpoint:
      resource ?? operation,
    operation,
    resource,
    library: moduleName,
    confidence: "high",
  };
}

/* =========================================================
   URL / method resolution
   ========================================================= */

type Confidence = "high" | "medium" | "low";

interface ResolvedString {
  text: string;

  /** Every part of the string was statically known. */
  complete: boolean;

  /** The value came from a const / default parameter, not a literal. */
  viaVariable: boolean;
}

interface HttpCallInfo {
  category: ApiUsageCategory;
  method: string;
  endpoint: string;
  urlExpression?: string;
  operation?: string;
  resource?: string;
  library: string;
  confidence: Confidence;
}

const CONFIDENCE_ORDER: Confidence[] = ["low", "medium", "high"];

function lowerConfidence(value: Confidence): Confidence {
  return CONFIDENCE_ORDER[
    Math.max(0, CONFIDENCE_ORDER.indexOf(value) - 1)
  ];
}

function capConfidence(
  value: Confidence,
  cap: Confidence
): Confidence {
  return CONFIDENCE_ORDER.indexOf(value) >
    CONFIDENCE_ORDER.indexOf(cap)
    ? cap
    : value;
}

function unwrapExpression(
  expression: ts.Expression
): ts.Expression {
  let current = expression;

  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }

  return current;
}

/**
 * Looks for `name = "x"` in a binding pattern:
 *   ({ apiUrl = "x" }: Props)  /  const { apiUrl = "x" } = props
 */
function findInBindingName(
  bindingName: ts.BindingName,
  name: string
): ts.Expression | undefined {
  if (ts.isIdentifier(bindingName)) {
    return undefined;
  }

  for (const element of bindingName.elements) {
    if (ts.isOmittedExpression(element)) {
      continue;
    }

    if (ts.isIdentifier(element.name)) {
      if (element.name.text === name && element.initializer) {
        return element.initializer;
      }
    } else {
      const nested = findInBindingName(element.name, name);

      if (nested) {
        return nested;
      }
    }
  }

  return undefined;
}

/**
 * Finds what an identifier was initialised with, walking outwards through
 * the enclosing scopes:
 *   - function parameters (including destructured props with defaults)
 *   - `const` declarations in the enclosing block / module
 */
function findScopedInitializer(
  identifier: ts.Identifier
): ts.Expression | undefined {
  const name = identifier.text;

  let current: ts.Node | undefined = identifier.parent;

  while (current) {
    if (ts.isFunctionLike(current)) {
      for (const parameter of current.parameters) {
        if (
          ts.isIdentifier(parameter.name) &&
          parameter.name.text === name &&
          parameter.initializer
        ) {
          return parameter.initializer;
        }

        const fromPattern = findInBindingName(
          parameter.name,
          name
        );

        if (fromPattern) {
          return fromPattern;
        }
      }
    }

    if (
      ts.isBlock(current) ||
      ts.isSourceFile(current) ||
      ts.isModuleBlock(current)
    ) {
      for (const statement of current.statements) {
        if (
          !ts.isVariableStatement(statement) ||
          (statement.declarationList.flags &
            ts.NodeFlags.Const) === 0
        ) {
          continue;
        }

        for (const declaration of statement.declarationList
          .declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === name &&
            declaration.initializer
          ) {
            return declaration.initializer;
          }

          const fromPattern = findInBindingName(
            declaration.name,
            name
          );

          if (fromPattern) {
            return fromPattern;
          }
        }
      }
    }

    current = current.parent;
  }

  return undefined;
}

/**
 * Statically evaluates a URL expression:
 *   "/users"                      literal
 *   `${BASE}/users/${id}`         template (unknown parts stay as ${...})
 *   apiUrl / API_URL              const or default parameter
 *   BASE + "/users"               concatenation
 */
function resolveStringExpression(
  input: ts.Expression,
  depth = 0
): ResolvedString | undefined {
  if (depth > 6) {
    return undefined;
  }

  const expression = unwrapExpression(input);

  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return {
      text: expression.text,
      complete: true,
      viaVariable: false,
    };
  }

  if (ts.isTemplateExpression(expression)) {
    let text = expression.head.text;
    let complete = true;
    let viaVariable = false;

    for (const span of expression.templateSpans) {
      const inner = resolveStringExpression(
        span.expression,
        depth + 1
      );

      if (inner) {
        text += inner.text;
        complete = complete && inner.complete;
        viaVariable = viaVariable || inner.viaVariable;
      } else {
        text += `\${${span.expression.getText()}}`;
        complete = false;
      }

      text += span.literal.text;
    }

    return { text, complete, viaVariable };
  }

  if (ts.isIdentifier(expression)) {
    const initializer = findScopedInitializer(expression);

    if (!initializer) {
      return undefined;
    }

    const resolved = resolveStringExpression(
      initializer,
      depth + 1
    );

    return resolved
      ? { ...resolved, viaVariable: true }
      : undefined;
  }

  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = resolveStringExpression(
      expression.left,
      depth + 1
    );

    const right = resolveStringExpression(
      expression.right,
      depth + 1
    );

    if (!left && !right) {
      return undefined;
    }

    return {
      text:
        (left?.text ??
          `\${${expression.left.getText()}}`) +
        (right?.text ??
          `\${${expression.right.getText()}}`),
      complete:
        Boolean(left?.complete) && Boolean(right?.complete),
      viaVariable:
        Boolean(left?.viaVariable) ||
        Boolean(right?.viaVariable),
    };
  }

  return undefined;
}

/**
 * Reads `method` from fetch's options argument, even when the URL itself
 * is dynamic:  fetch(apiUrl, { method: "POST" })
 */
function getFetchMethod(
  options: ts.Expression | undefined
): { method: string; certain: boolean } {
  if (!options) {
    return { method: "GET", certain: true };
  }

  const literal = unwrapExpression(options);

  if (!ts.isObjectLiteralExpression(literal)) {
    return { method: "GET", certain: false };
  }

  let certain = true;

  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) {
      certain = false;
      continue;
    }

    const isMethodProperty =
      (ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property)) &&
      (ts.isIdentifier(property.name) ||
        ts.isStringLiteral(property.name)) &&
      property.name.text.toLowerCase() === "method";

    if (!isMethodProperty) {
      continue;
    }

    const valueExpression = ts.isPropertyAssignment(property)
      ? property.initializer
      : property.name;

    const value = resolveStringExpression(valueExpression);

    if (value && value.complete) {
      return { method: value.text.toUpperCase(), certain };
    }

    // `method` is present but not statically known.
    return { method: "OTHER", certain: false };
  }

  return { method: "GET", certain };
}

function buildHttpInfo(input: {
  method: string;
  library: string;
  urlArgument: ts.Expression;
  certain: boolean;
  cap: Confidence;
}): HttpCallInfo {
  const { method, library, urlArgument, certain, cap } = input;

  const resolved = resolveStringExpression(urlArgument);

  let confidence: Confidence;

  if (!resolved) {
    confidence = "low";
  } else if (!resolved.complete) {
    // /api/users/${id}: a static prefix is still a useful endpoint.
    confidence = /^(https?:|\/)/.test(resolved.text)
      ? "medium"
      : "low";
  } else {
    confidence = resolved.viaVariable ? "medium" : "high";
  }

  if (!certain) {
    confidence = lowerConfidence(confidence);
  }

  const original = urlArgument.getText();

  const isPlainLiteral =
    ts.isStringLiteral(urlArgument) ||
    ts.isNoSubstitutionTemplateLiteral(urlArgument);

  return {
    category: "http",
    method,
    endpoint: resolved?.text ?? original,
    urlExpression:
      resolved && !isPlainLiteral && resolved.text !== original
        ? original
        : undefined,
    library,
    confidence: capConfidence(confidence, cap),
  };
}

function getHttpCallInfo(
  node: ts.CallExpression
): HttpCallInfo | undefined {
  const expression = node.expression;

  /*
   * fetch("/users")
   * fetch(apiUrl, { method: "POST" })
   */
  if (
    ts.isIdentifier(expression) &&
    expression.text === "fetch"
  ) {
    const urlArgument = node.arguments[0];

    if (!urlArgument) {
      return undefined;
    }

    const methodInfo = getFetchMethod(node.arguments[1]);

    return buildHttpInfo({
      method: methodInfo.method,
      library: "fetch",
      urlArgument,
      certain: methodInfo.certain,
      cap: "high",
    });
  }

  /*
   * axios.get("/users")
   * apiClient.post(url)
   * userApi.delete(`/users/${id}`)
   */
  if (ts.isPropertyAccessExpression(expression)) {
    const method = getHttpMethod(expression.name.text);

    if (
      !method ||
      !isLikelyHttpClientExpression(expression.expression)
    ) {
      return undefined;
    }

    const urlArgument = node.arguments[0];

    if (!urlArgument) {
      return undefined;
    }

    const objectName = expression.expression.getText();

    const library = /^(axios|http|client|api|request)$/.test(
      objectName
    )
      ? objectName
      : `${objectName}.${method.toLowerCase()}`;

    return buildHttpInfo({
      method,
      library,
      urlArgument,
      certain: true,
      cap: objectName === "axios" ? "high" : "medium",
    });
  }

  return undefined;
}

/*
 * axios({ url: "/users", method: "POST" })
 */
function getAxiosConfigCallInfo(
  node: ts.CallExpression
): HttpCallInfo | undefined {
  if (
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== "axios"
  ) {
    return undefined;
  }

  const config = node.arguments[0];

  if (!config || !ts.isObjectLiteralExpression(config)) {
    return undefined;
  }

  let urlExpression: ts.Expression | undefined;
  let method = "GET";
  let certain = true;

  for (const property of config.properties) {
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isShorthandPropertyAssignment(property)
    ) {
      continue;
    }

    if (
      !ts.isIdentifier(property.name) &&
      !ts.isStringLiteral(property.name)
    ) {
      continue;
    }

    const propertyName = property.name.text.toLowerCase();

    const valueExpression = ts.isPropertyAssignment(property)
      ? property.initializer
      : property.name;

    if (propertyName === "url") {
      urlExpression = valueExpression;
    }

    if (propertyName === "method") {
      const value = resolveStringExpression(valueExpression);

      if (value?.complete) {
        method = value.text.toUpperCase();
      } else {
        certain = false;
      }
    }
  }

  if (!urlExpression) {
    return undefined;
  }

  return buildHttpInfo({
    method,
    library: "axios",
    urlArgument: urlExpression,
    certain,
    cap: "high",
  });
}

function getCallExpressionInfo(
  node: ts.CallExpression,
  firebaseImports: Map<string, FirebaseImportInfo>
): HttpCallInfo | undefined {
  return (
    getFirebaseCallInfo(node, firebaseImports) ??
    getHttpCallInfo(node) ??
    getAxiosConfigCallInfo(node)
  );
}

function collectSourceFiles(
  projectPath: string,
  requestedFilePath?: string
): SourceFileInfo[] {
  if (requestedFilePath) {
    const absolutePath =
      path.resolve(
        projectPath,
        requestedFilePath
      );

    if (!fs.existsSync(absolutePath)) {
      throw new Error(
        `File not found: ${requestedFilePath}`
      );
    }

    const sourceText =
      fs.readFileSync(
        absolutePath,
        "utf8"
      );

    const sourceFile =
      ts.createSourceFile(
        absolutePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        getScriptKind(absolutePath)
      );

    return [
      {
        sourceFile,
        absolutePath,
        relativePath:
          normalizePath(
            path.relative(
              projectPath,
              absolutePath
            )
          ),
      },
    ];
  }

  const result: SourceFileInfo[] = [];

  function walk(directory: string): void {
    const entries =
      fs.readdirSync(
        directory,
        { withFileTypes: true }
      );

    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        IGNORED_DIRECTORIES.has(entry.name)
      ) {
        continue;
      }

      const absolutePath =
        path.join(
          directory,
          entry.name
        );

      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension =
        path.extname(entry.name)
          .toLowerCase();

      if (
        !SUPPORTED_EXTENSIONS.has(extension)
      ) {
        continue;
      }

      const sourceText =
        fs.readFileSync(
          absolutePath,
          "utf8"
        );

      const sourceFile =
        ts.createSourceFile(
          absolutePath,
          sourceText,
          ts.ScriptTarget.Latest,
          true,
          getScriptKind(absolutePath)
        );

      result.push({
        sourceFile,
        absolutePath,
        relativePath:
          normalizePath(
            path.relative(
              projectPath,
              absolutePath
            )
          ),
      });
    }
  }

  walk(projectPath);

  return result;
}

function analyzeSourceFile(
  source: SourceFileInfo
): ApiEndpointUsage[] {
  const results: ApiEndpointUsage[] = [];
  const firebaseImports =
    collectFirebaseImports(
      source.sourceFile
    );

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const info =
        getCallExpressionInfo(
          node,
          firebaseImports
        );

      if (info) {
        const position =
          source.sourceFile.getLineAndCharacterOfPosition(
            node.getStart(source.sourceFile)
          );

        const caller =
          getCallerName(node);

        const id =
          [
            source.relativePath,
            position.line + 1,
            position.character + 1,
            info.method,
            info.endpoint,
          ].join(":");

        results.push({
          id,
          category: info.category,
          method: info.method,
          endpoint: info.endpoint,
          urlExpression: info.urlExpression,
          operation: info.operation,
          resource: info.resource,
          filePath: source.relativePath,
          line: position.line + 1,
          column: position.character + 1,
          caller,
          library: info.library,
          expression:
            node.getText(source.sourceFile),
          confidence:
            info.confidence,
        });
      }
    }

    ts.forEachChild(
      node,
      visit
    );
  }

  visit(source.sourceFile);

  return results;
}

export async function analyzeApiEndpoints(
  projectPath: string,
  filePath?: string
): Promise<ApiEndpointReport> {
  const absoluteProjectPath =
    path.resolve(projectPath);

  if (
    !fs.existsSync(
      absoluteProjectPath
    )
  ) {
    throw new Error(
      `Project path not found: ${projectPath}`
    );
  }

  const sources =
    collectSourceFiles(
      absoluteProjectPath,
      filePath
    );

  const endpoints =
    sources.flatMap(
      analyzeSourceFile
    );

  const summary = {
    GET: 0,
    POST: 0,
    PUT: 0,
    PATCH: 0,
    DELETE: 0,
    OTHER: 0,
    FIREBASE_FIRESTORE: 0,
    FIREBASE_AUTH: 0,
    FIREBASE_STORAGE: 0,
    FIREBASE_FUNCTIONS: 0,
  };

  for (const endpoint of endpoints) {
    switch (endpoint.category) {
      case "firebase-firestore":
        summary.FIREBASE_FIRESTORE += 1;
        continue;

      case "firebase-auth":
        summary.FIREBASE_AUTH += 1;
        continue;

      case "firebase-storage":
        summary.FIREBASE_STORAGE += 1;
        continue;

      case "firebase-functions":
        summary.FIREBASE_FUNCTIONS += 1;
        continue;
    }

    switch (endpoint.method) {
      case "GET":
        summary.GET += 1;
        break;

      case "POST":
        summary.POST += 1;
        break;

      case "PUT":
        summary.PUT += 1;
        break;

      case "PATCH":
        summary.PATCH += 1;
        break;

      case "DELETE":
        summary.DELETE += 1;
        break;

      default:
        summary.OTHER += 1;
        break;
    }
  }

  return {
    success: true,
    projectPath:
      absoluteProjectPath,
    filePath,
    totalEndpoints:
      endpoints.length,
    endpoints,
    summary,
    warnings: [
      "Static analysis may not detect URLs or Firebase resources constructed dynamically at runtime.",
      "Generated API clients and external libraries may hide endpoint definitions.",
      "Variable-based URLs or Firebase resource paths are reported with lower confidence.",
      "Firebase SDK operations are reported as service operations rather than invented HTTP endpoints.",
    ],
  };
}

/* =========================================================
   View source
   ========================================================= */

const MAX_VIEW_BYTES = 2 * 1024 * 1024;
const MAX_FULL_LINES = 5000;
const DEFAULT_CONTEXT_LINES = 40;

export interface SourceSnippet {
  success: boolean;
  filePath: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  highlightLine: number;

  /** Lines startLine..endLine (inclusive), without line terminators. */
  lines: string[];

  /** The file was cut because it is very large. */
  truncated: boolean;
}

/**
 * Resolves a project-relative path to a real file that is guaranteed to be
 * inside the project (symlinks resolved) and of a supported source type.
 */
function resolveProjectFile(
  projectPath: string,
  filePath: string
): { root: string; absolute: string; relative: string } {
  if (
    path.isAbsolute(filePath) ||
    filePath.split(/[\\/]/).includes("..")
  ) {
    throw new Error("filePath must be relative to projectPath.");
  }

  if (!fs.existsSync(projectPath)) {
    throw new Error(`Project path not found: ${projectPath}`);
  }

  const root = fs.realpathSync(path.resolve(projectPath));
  const candidate = path.resolve(root, filePath);

  if (!fs.existsSync(candidate)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const absolute = fs.realpathSync(candidate);
  const relative = path.relative(root, absolute);

  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("File must be inside the project directory.");
  }

  if (!fs.statSync(absolute).isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }

  if (
    !SUPPORTED_EXTENSIONS.has(
      path.extname(absolute).toLowerCase()
    )
  ) {
    throw new Error(`Unsupported file type: ${filePath}`);
  }

  return {
    root,
    absolute,
    relative: normalizePath(relative),
  };
}

export async function readSourceSnippet(
  projectPath: string,
  filePath: string,
  line: number,
  options: { context?: number; full?: boolean } = {}
): Promise<SourceSnippet> {
  const { absolute, relative } = resolveProjectFile(
    projectPath,
    filePath
  );

  if (fs.statSync(absolute).size > MAX_VIEW_BYTES) {
    throw new Error(
      "File is too large to display (limit 2 MB)."
    );
  }

  const allLines = fs
    .readFileSync(absolute, "utf8")
    .split(/\r?\n/);

  const totalLines = allLines.length;
  const highlightLine = Math.min(Math.max(1, line), totalLines);

  let startLine: number;
  let endLine: number;
  let truncated = false;

  if (options.full) {
    startLine = 1;
    endLine = Math.min(totalLines, MAX_FULL_LINES);
    truncated = totalLines > MAX_FULL_LINES;

    // Keep the highlighted line inside a truncated window.
    if (highlightLine > endLine) {
      startLine = Math.max(1, highlightLine - MAX_FULL_LINES / 2);
      endLine = Math.min(totalLines, startLine + MAX_FULL_LINES - 1);
    }
  } else {
    const context = Math.min(
      Math.max(1, options.context ?? DEFAULT_CONTEXT_LINES),
      400
    );

    startLine = Math.max(1, highlightLine - context);
    endLine = Math.min(totalLines, highlightLine + context);
  }

  return {
    success: true,
    filePath: relative,
    startLine,
    endLine,
    totalLines,
    highlightLine,
    lines: allLines.slice(startLine - 1, endLine),
    truncated,
  };
}

/* =========================================================
   Trace callers (TypeScript call hierarchy)
   ========================================================= */

export interface CallTraceNode {
  name: string;
  kind: string;
  filePath: string;
  line: number;
  column: number;

  /** Where inside this function the traced function is called. */
  callSites: Array<{ line: number; column: number }>;

  callers: CallTraceNode[];

  /**
   * "call"      the function is invoked here
   * "reference" it is passed as a value here (onClick={fn}, callbacks)
   */
  relation: "call" | "reference";

  /** This function is already on the path above (recursion cycle). */
  isCircular?: boolean;
}

export interface CallTraceReport {
  success: boolean;
  projectPath: string;
  target: {
    name: string;
    kind: string;
    filePath: string;
    line: number;
    column: number;
  };
  callers: CallTraceNode[];
  totalNodes: number;
  truncated: boolean;
  notes: string[];
}

const TRACE_SERVICE_TTL_MS = 2 * 60 * 1000;
const MAX_TRACE_FILES = 5000;

const traceServices = new Map<
  string,
  { service: ts.LanguageService; createdAt: number }
>();

function listSourceFiles(root: string): string[] {
  const files: string[] = [];

  function walk(directory: string): void {
    if (files.length >= MAX_TRACE_FILES) {
      return;
    }

    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(directory, {
        withFileTypes: true,
      });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          walk(absolutePath);
        }
        continue;
      }

      if (
        entry.isFile() &&
        SUPPORTED_EXTENSIONS.has(
          path.extname(entry.name).toLowerCase()
        ) &&
        !/\.d\.[cm]?ts$/i.test(entry.name)
      ) {
        files.push(absolutePath);
      }
    }
  }

  walk(root);

  return files;
}

function loadTraceCompilerOptions(
  root: string
): ts.CompilerOptions {
  let base: ts.CompilerOptions = {};

  const tsconfigPath = path.join(root, "tsconfig.json");

  if (fs.existsSync(tsconfigPath)) {
    const config = ts.readConfigFile(
      tsconfigPath,
      ts.sys.readFile
    );

    if (!config.error) {
      base = ts.parseJsonConfigFileContent(
        config.config,
        ts.sys,
        root
      ).options;
    }
  }

  return {
    ...base,

    // The project may mix a NodeNext backend with a bundler-based
    // front end (e.g. Vite), whose imports have no file extensions.
    // "Bundler" resolves both styles.
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    jsx: base.jsx ?? ts.JsxEmit.ReactJSX,
    allowJs: true,
    noEmit: true,
    skipLibCheck: true,
    composite: false,
    incremental: false,
    declaration: false,
    declarationMap: false,
    tsBuildInfoFile: undefined,
  };
}

function getTraceService(root: string): ts.LanguageService {
  const cached = traceServices.get(root);

  if (
    cached &&
    Date.now() - cached.createdAt < TRACE_SERVICE_TTL_MS
  ) {
    return cached.service;
  }

  const files = listSourceFiles(root);
  const options = loadTraceCompilerOptions(root);

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => files,
    getScriptVersion: (fileName) => {
      try {
        return String(fs.statSync(fileName).mtimeMs);
      } catch {
        return "0";
      }
    },
    getScriptSnapshot: (fileName) => {
      const text = ts.sys.readFile(fileName);

      return text === undefined
        ? undefined
        : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (compilerOptions) =>
      ts.getDefaultLibFilePath(compilerOptions),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };

  const service = ts.createLanguageService(
    host,
    ts.createDocumentRegistry()
  );

  traceServices.set(root, { service, createdAt: Date.now() });

  // Keep the cache small.
  if (traceServices.size > 4) {
    const oldest = [...traceServices.entries()].sort(
      (a, b) => a[1].createdAt - b[1].createdAt
    )[0];

    if (oldest && oldest[0] !== root) {
      traceServices.delete(oldest[0]);
    }
  }

  return service;
}

function findDeepestNodeAt(
  sourceFile: ts.SourceFile,
  position: number
): ts.Node {
  let best: ts.Node = sourceFile;

  function visit(node: ts.Node): void {
    if (
      position >= node.getFullStart() &&
      position < node.getEnd()
    ) {
      best = node;
      ts.forEachChild(node, visit);
    }
  }

  ts.forEachChild(sourceFile, visit);

  return best;
}

/**
 * The name node of the nearest *named* function around `node`
 * (function declaration, method, or `const name = () => {}`).
 *
 * `anonymousInside` is set when the call sits in an anonymous callback
 * (an inline `onClick={() => ...}`, `useEffect(() => ...)`, ...), which
 * has no callers of its own: it is traced through its named parent.
 */
function findNamedFunction(node: ts.Node): {
  nameNode: ts.Node;
  anonymousInside: boolean;
} | undefined {
  let anonymousInside = false;
  let current: ts.Node | undefined = node;

  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      if (current.name) {
        return { nameNode: current.name, anonymousInside };
      }
    }

    if (ts.isConstructorDeclaration(current)) {
      return { nameNode: current, anonymousInside };
    }

    if (
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current)
    ) {
      const parent: ts.Node = current.parent;

      if (
        ts.isVariableDeclaration(parent) &&
        parent.initializer === current &&
        ts.isIdentifier(parent.name)
      ) {
        return { nameNode: parent.name, anonymousInside };
      }

      anonymousInside = true;
    }

    current = current.parent;
  }

  return undefined;
}

export async function traceCallers(
  projectPath: string,
  filePath: string,
  line: number,
  column: number,
  maxDepth = 4,
  maxNodes = 80
): Promise<CallTraceReport> {
  const { root, absolute, relative } = resolveProjectFile(
    projectPath,
    filePath
  );

  const service = getTraceService(root);
  const program = service.getProgram();
  const sourceFile = program?.getSourceFile(absolute);

  if (!program || !sourceFile) {
    throw new Error(
      `Unable to load ${relative} into the TypeScript program.`
    );
  }

  const toLocation = (
    file: string,
    position: number
  ): { filePath: string; line: number; column: number } => {
    const target = program.getSourceFile(file);

    const resolved =
      target?.getLineAndCharacterOfPosition(position) ??
      { line: 0, character: 0 };

    return {
      filePath: normalizePath(
        path.relative(root, path.normalize(file))
      ),
      line: resolved.line + 1,
      column: resolved.character + 1,
    };
  };

  const notes: string[] = [];

  const position = sourceFile.getPositionOfLineAndCharacter(
    Math.max(0, line - 1),
    Math.max(0, column - 1)
  );

  const start = findNamedFunction(
    findDeepestNodeAt(sourceFile, position)
  );

  const emptyTarget = {
    name: "(module top level)",
    kind: "module",
    filePath: relative,
    line,
    column,
  };

  if (!start) {
    notes.push(
      "This call is at module top level, so it has no enclosing function to trace."
    );

    return {
      success: true,
      projectPath: root,
      target: emptyTarget,
      callers: [],
      totalNodes: 0,
      truncated: false,
      notes,
    };
  }

  const prepared = service.prepareCallHierarchy(
    absolute,
    start.nameNode.getStart(sourceFile)
  );

  const rootItem = Array.isArray(prepared)
    ? prepared[0]
    : prepared;

  if (!rootItem) {
    notes.push(
      "The enclosing function could not be resolved by the TypeScript call hierarchy."
    );

    return {
      success: true,
      projectPath: root,
      target: emptyTarget,
      callers: [],
      totalNodes: 0,
      truncated: false,
      notes,
    };
  }

  if (start.anonymousInside) {
    notes.push(
      `The call is inside an anonymous callback, so callers are traced through its enclosing function "${rootItem.name}".`
    );
  }

  let totalNodes = 0;
  let truncated = false;

  const ancestors = new Set<string>();

  const keyOf = (item: ts.CallHierarchyItem): string =>
    `${path.normalize(item.file)}:${item.selectionSpan.start}`;

  const isProjectFile = (file: string): boolean => {
    const relativeToRoot = path.relative(
      root,
      path.normalize(file)
    );

    return (
      !relativeToRoot.startsWith("..") &&
      !relativeToRoot.split(path.sep).includes("node_modules")
    );
  };

  interface Caller {
    from: ts.CallHierarchyItem;
    spans: ts.TextSpan[];
    relation: "call" | "reference";
  }

  /**
   * Functions that pass `item` around without calling it:
   *   <button onClick={generateGraph} />   items.map(render)
   */
  function referencingFunctions(
    item: ts.CallHierarchyItem
  ): Caller[] {
    const references =
      service.getReferencesAtPosition(
        item.file,
        item.selectionSpan.start
      ) ?? [];

    const grouped = new Map<string, Caller>();

    for (const reference of references) {
      // Skip the declaration itself (its own name) and non-project files.
      const isDeclarationName =
        path.normalize(reference.fileName) ===
          path.normalize(item.file) &&
        reference.textSpan.start >= item.selectionSpan.start &&
        reference.textSpan.start <
          item.selectionSpan.start + item.selectionSpan.length;

      if (
        isDeclarationName ||
        !isProjectFile(reference.fileName)
      ) {
        continue;
      }

      const file = program!.getSourceFile(reference.fileName);

      if (!file) {
        continue;
      }

      const named = findNamedFunction(
        findDeepestNodeAt(file, reference.textSpan.start)
      );

      if (!named) {
        continue;
      }

      const prepared = service.prepareCallHierarchy(
        reference.fileName,
        named.nameNode.getStart(file)
      );

      const from = Array.isArray(prepared)
        ? prepared[0]
        : prepared;

      if (!from || keyOf(from) === keyOf(item)) {
        continue;
      }

      const key = keyOf(from);
      const existing = grouped.get(key);

      if (existing) {
        existing.spans.push(reference.textSpan);
      } else {
        grouped.set(key, {
          from,
          spans: [reference.textSpan],
          relation: "reference",
        });
      }
    }

    return [...grouped.values()];
  }

  function callersOf(item: ts.CallHierarchyItem): Caller[] {
    // A module has no callers (and position 0 would resolve to its
    // first import, not to the module).
    if (item.kind === "module") {
      return [];
    }

    const calls: Caller[] = service
      .provideCallHierarchyIncomingCalls(
        item.file,
        item.selectionSpan.start
      )
      .map((call) => ({
        from: call.from,
        spans: call.fromSpans,
        relation: "call" as const,
      }));

    const seen = new Set(calls.map((call) => keyOf(call.from)));

    // Event handlers / callbacks are referenced, not called.
    for (const reference of referencingFunctions(item)) {
      if (!seen.has(keyOf(reference.from))) {
        calls.push(reference);
      }
    }

    return calls.filter((call) => isProjectFile(call.from.file));
  }

  function collect(
    item: ts.CallHierarchyItem,
    depth: number
  ): CallTraceNode[] {
    if (depth >= maxDepth) {
      return [];
    }

    const nodes: CallTraceNode[] = [];

    for (const call of callersOf(item)) {
      if (totalNodes >= maxNodes) {
        truncated = true;
        break;
      }

      totalNodes += 1;

      const from = call.from;
      const key = keyOf(from);
      const location = toLocation(
        from.file,
        from.selectionSpan.start
      );

      const node: CallTraceNode = {
        // Source files are reported by their absolute path.
        name:
          from.kind === "module"
            ? location.filePath
            : from.name,
        kind: from.kind,
        ...location,
        relation: call.relation,
        callSites: call.spans.map((span) => {
          const site = toLocation(from.file, span.start);

          return { line: site.line, column: site.column };
        }),
        callers: [],
      };

      if (ancestors.has(key)) {
        node.isCircular = true;
      } else {
        ancestors.add(key);
        node.callers = collect(from, depth + 1);
        ancestors.delete(key);
      }

      nodes.push(node);
    }

    return nodes;
  }

  ancestors.add(keyOf(rootItem));

  const callers = collect(rootItem, 0);

  if (callers.length === 0) {
    notes.push(
      "No static callers were found. The function may be an entry point, an event handler, or be called dynamically."
    );
  }

  if (truncated) {
    notes.push(
      `The trace was limited to ${maxNodes} nodes.`
    );
  }

  const rootLocation = toLocation(
    rootItem.file,
    rootItem.selectionSpan.start
  );

  return {
    success: true,
    projectPath: root,
    target: {
      name: rootItem.name,
      kind: rootItem.kind,
      ...rootLocation,
    },
    callers,
    totalNodes,
    truncated,
    notes,
  };
}

export function registerAnalyzeApiEndpointsTool(
    server: McpServer
): void {
    server.registerTool(
        "analyze_api_endpoints",
        {
            description:
                "Discover HTTP API calls used by a TypeScript or JavaScript project.",

            inputSchema: z.object({
                projectPath: z
                    .string()
                    .describe(
                        "Absolute path to the target project."
                    ),

                filePath: z
                    .string()
                    .optional()
                    .describe(
                        "Optional source file path relative to the project."
                    ),
            }),
        },

        async ({
            projectPath,
            filePath,
        }) => {
            try {
                const report =
                    await analyzeApiEndpoints(
                        projectPath,
                        filePath
                    );

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify(
                                report,
                                null,
                                2
                            ),
                        },
                    ],
                };
            } catch (error) {
                const message =
                    error instanceof Error
                        ? error.message
                        : String(error);

                return {
                    isError: true,

                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify(
                                {
                                    success: false,
                                    error: message,
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