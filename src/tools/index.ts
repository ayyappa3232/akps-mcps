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
}
