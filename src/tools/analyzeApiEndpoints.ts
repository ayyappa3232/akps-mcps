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

function getCallExpressionInfo(
  node: ts.CallExpression,
  firebaseImports: Map<string, FirebaseImportInfo>
): {
  category: ApiUsageCategory;
  method: string;
  endpoint: string;
  operation?: string;
  resource?: string;
  library: string;
  confidence: "high" | "medium" | "low";
} | undefined {
  const firebaseInfo =
    getFirebaseCallInfo(
      node,
      firebaseImports
    );

  if (firebaseInfo) {
    return firebaseInfo;
  }


  const expression = node.expression;

  /*
   * fetch("/users")
   * fetch("/users", { method: "POST" })
   */
  if (
    ts.isIdentifier(expression) &&
    expression.text === "fetch"
  ) {
    const firstArgument = node.arguments[0];

    if (!firstArgument) {
      return undefined;
    }

    const endpoint =
      getStringValue(firstArgument);

    if (!endpoint) {
      return {
        category: "http",
        method: "OTHER",
        endpoint: firstArgument.getText(),
        library: "fetch",
        confidence: "low",
      };
    }

    let method = "GET";

    if (node.arguments.length >= 2) {
      const options = node.arguments[1];

      if (ts.isObjectLiteralExpression(options)) {
        for (const property of options.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            (
              property.name &&
              (
                ts.isIdentifier(property.name) ||
                ts.isStringLiteral(property.name)
              )
            )
          ) {
            const propertyName =
              property.name.getText().replace(/["']/g, "");

            if (
              propertyName.toLowerCase() === "method"
            ) {
              const value =
                getStringValue(property.initializer);

              if (value) {
                method = value.toUpperCase();
              }
            }
          }
        }
      }
    }

    return {
      category: "http",
      method,
      endpoint,
      library: "fetch",
      confidence: "high",
    };
  }

  /*
   * axios.get("/users")
   * axios.post("/users")
   * apiClient.get("/users")
   * httpClient.get("/users")
   * userApi.get("/users")
   */
  if (
    ts.isPropertyAccessExpression(expression)
  ) {
    const method =
      getHttpMethod(
        expression.name.text
      );

    if (!method) {
      return undefined;
    }

    if (
      !isLikelyHttpClientExpression(
        expression.expression
      )
    ) {
      return undefined;
    }

    const objectName =
      expression.expression.getText();

    const firstArgument =
      node.arguments[0];

    if (!firstArgument) {
      return undefined;
    }

    const endpoint =
      getStringValue(firstArgument);

    if (!endpoint) {
      return {
        category: "http",
        method,
        endpoint: firstArgument.getText(),
        library: objectName,
        confidence: "low",
      };
    }

    let library = objectName;

    if (
      objectName === "axios" ||
      objectName === "http" ||
      objectName === "client" ||
      objectName === "api" ||
      objectName === "request"
    ) {
      library = objectName;
    } else {
      library = `${objectName}.${method.toLowerCase()}`;
    }

    return {
      category: "http",
      method,
      endpoint,
      library,
      confidence:
        objectName === "axios"
          ? "high"
          : "medium",
    };
  }

  /*
   * axios({
   *   url: "/users",
   *   method: "POST"
   * })
   */
  if (
    ts.isIdentifier(expression) &&
    expression.text === "axios"
  ) {
    const firstArgument =
      node.arguments[0];

    if (
      !firstArgument ||
      !ts.isObjectLiteralExpression(firstArgument)
    ) {
      return undefined;
    }

    let endpoint: string | undefined;
    let method = "GET";

    for (
      const property of firstArgument.properties
    ) {
      if (
        !ts.isPropertyAssignment(property) ||
        !property.name
      ) {
        continue;
      }

      const propertyName =
        property.name.getText()
          .replace(/["']/g, "")
          .toLowerCase();

      if (propertyName === "url") {
        endpoint =
          getStringValue(property.initializer);
      }

      if (propertyName === "method") {
        const value =
          getStringValue(property.initializer);

        if (value) {
          method =
            value.toUpperCase();
        }
      }
    }

    if (!endpoint) {
      return undefined;
    }

    return {
      category: "http",
      method,
      endpoint,
      library: "axios",
      confidence: "high",
    };
  }

  return undefined;
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