import type { McpServer } from "@modelcontextprotocol/server";

import { registerHelloDeveloperTool } from "./helloDeveloper.js";
import { registerScanProjectTool } from "./scanProject.js";
import { registerFindFilesTool } from "./findFiles.js";
import { registerFindReferencesTool } from "./findReferences.js";
import { registerReadFileTool } from "./readFile.js";
import { registerTraceDependenciesTool } from "./traceDependencies.js";
import { registerGenerateDependencyDiagramTool } from "./generateDependencyDiagram.js";
import { registerExplainMethodTool } from "./explainMethod.js";
import { registerAnalyzeChangeImpactTool } from "./analyzeChangeImpact.js";
import { registerAnalyzeCodeQualityTool } from "./analyzeCodeQuality.js";
import { registerAnalyzeDeadCodeTool } from "./analyzeDeadCode.js";
import { registerAnalyzeApiEndpointsTool } from "./analyzeApiEndpoints.js";
import { registerAnalyzeCircularDependenciesTool } from "./analyzeCircularDependencies.js";
import { registerDetectDuplicateCodeTool } from "./detectDuplicateCode.js";
import { registerDetectBreakingApiChangesTool } from "./detectBreakingApiChanges.js";
import { registerAnalyzeReactComponentsTool } from "./analyzeReactComponents.js";
import { registerAnalyzeReactRerendersTool } from "./analyzeReactRerenders.js";

export function registerAllTools(server: McpServer): void {
  registerHelloDeveloperTool(server);
  registerScanProjectTool(server);
  registerFindFilesTool(server);
  registerFindReferencesTool(server);
  registerReadFileTool(server);
  registerTraceDependenciesTool(server);
  registerGenerateDependencyDiagramTool(server);
  registerExplainMethodTool(server);
  registerAnalyzeChangeImpactTool(server);
  registerAnalyzeCodeQualityTool(server);
  registerAnalyzeDeadCodeTool(server);
  registerAnalyzeApiEndpointsTool(server);
  registerAnalyzeCircularDependenciesTool(server);
  registerDetectDuplicateCodeTool(server);
  registerDetectBreakingApiChangesTool(server);
  registerAnalyzeReactComponentsTool(server);
  registerAnalyzeReactRerendersTool(server);
}