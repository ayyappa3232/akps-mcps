





# Developer Productivity MCP

A reusable **Model Context Protocol (MCP) server** for developer

productivity and code intelligence in modern TypeScript/React projects.

It provides MCP tools for project discovery, file/reference analysis,

dependency tracing, method/function analysis, and change-impact

analysis. A local React/Vite viewer visualizes the results.

## Table of Contents

- [Overview](#overview)

- [Architecture](#architecture)

- [Current MCP Tools](#current-mcp-tools)

- [Viewer](#viewer)

- [Project Structure](#project-structure)

- [Prerequisites](#prerequisites)

- [Installation](#installation)

- [Running](#running)

- [MCP Inspector](#mcp-inspector)

- [HTTP API](#http-api)

- [Dependency Explorer](#dependency-explorer)

- [Method Explorer](#method-explorer)

- [Change Impact Analyzer](#change-impact-analyzer)

- [How the Tools Work Together](#how-the-tools-work-together)

- [Troubleshooting](#troubleshooting)

- [Future MCP Roadmap](#future-mcp-roadmap)

- [Development Guidelines](#development-guidelines)

## Overview

The project is designed to give an AI coding assistant structured

information about a real codebase instead of requiring it to manually

inspect large numbers of files.

The three main analysis areas are:

1. **Dependency Intelligence** --- what depends on what?

2. **Method Intelligence** --- what does this function/method/component

do?

3. **Change Impact Intelligence** --- what could be affected if it

changes?

## Architecture

``` text

AI Assistant / MCP Client

|

| MCP / stdio

v

+-------------------------------+

| developer-productivity-mcp |

| |

| Project / File / Reference |

| Dependency / Method / Impact |

| TypeScript AST analysis |

+---------------+---------------+

|

+--------+--------+

| |

v v

MCP Inspector HTTP Bridge :4174

|

v

React/Vite :4173

|

+-----------+-----------+

| | |

Dependency Method Change

Explorer Explorer Impact

```

## Current MCP Tools

### 1. Hello Developer

Basic MCP connectivity/testing tool.

### 2. Scan Project

Scans a project and provides project-level information such as project

structure and source files.

### 3. Find Files

Locates files by name/pattern within a project.

Useful for finding components, hooks, services, utilities, routes,

tests, and configuration files.

### 4. Find References

Finds references/usages of a file or symbol. This is an important

foundation for change-impact analysis.

### 5. Read File

Reads project source files in a controlled manner so other analysis

tools can inspect source code.

### 6. Trace Dependencies

Builds a dependency tree from an entry file.

Example:

``` text

App.tsx

├── Layout.tsx

│ ├── Header.tsx

│ └── Sidebar.tsx

└── Dashboard.tsx

├── Chart.tsx

└── api.ts

```

Supports configurable maximum depth and node limits.

The scanner uses TypeScript AST-based import extraction to avoid false

imports from comments.

### 7. Generate Dependency Diagram

Produces graph data for visual dependency exploration, including nodes,

edges, shared dependencies, and circular dependency information.

### 8. Explain Method

Analyzes a function, method, class method, getter, setter, constructor,

arrow function, function expression, or relevant React

function/component.

It can expose:

- Symbol type

- Signature

- Documentation

- Parameters

- Return type

- Async status

- Export status

- Source

- Calls

- Conditions

- Loops

- Awaits

- Throws

- Returns

- Assignments

- React state hooks

- Effects

- Related symbols

- Callers

- Recursion

### 9. Analyze Change Impact

Analyzes the possible consequences of changing a selected symbol.

It can report:

- Risk level

- Risk score

- Direct impacted files

- Indirect/downstream files

- Affected symbols

- References

- Impact graph

- Recommendations

## Viewer

The local viewer provides four main modes:

``` text

Tree View

Graph View

Method Explorer

Change Impact

```

### Dependency Explorer

The main dependency-analysis area. Inputs include:

- Project absolute path

- Entry file

- Search files

- Maximum depth

- Maximum nodes

### Tree View

Shows dependencies hierarchically.

Use it to answer:

> What imports what?

### Graph View

Shows dependency relationships as an interactive graph.

It is useful for:

- Large dependency relationships

- Shared dependencies

- Circular relationships

- Visual exploration

### Method Explorer

Method Explorer answers:

> What does this function do?

It provides:

- Method/function/component input

- File path

- Symbol metrics

- Call Graph

- Call Tree

- Method Details

- Source

- Callers

- Call list

- Branches

- Awaits

- Effects

Example:

``` text

generateGraph()

├── setLoading()

├── fetch()

├── json()

├── countDependencies()

├── createProgressiveFlowLayout()

└── setFlowNodes()

```

### Change Impact Analyzer

Change Impact answers:

> What could be affected if I change this?

Its layout follows the Method Explorer philosophy:

``` text

Controls

↓

Status

↓

Impact metrics

↓

Graph + inspector

↓

References / Symbols / Recommendations

```

Main metrics:

- Risk

- Risk score

- Direct files

- Indirect files

- Affected symbols

- References

The graph should be read as:

``` text

Target

↓

Direct consumers

↓

Indirect / downstream files

```

The **References** area provides concrete evidence such as:

``` text

src/main.tsx

DIRECT

Line 3 · import

import App from "./App";

```

The **Symbols** area shows affected symbols. **Recommendations** is

intended to guide the developer before making a change.

## Project Structure

A simplified structure is:

``` text

developer-productivity-mcp/

├── src/

│ ├── index.ts

│ ├── httpServer.ts

│ └── tools/

│ ├── helloDeveloper.ts

│ ├── scanProject.ts

│ ├── findFiles.ts

│ ├── findReferences.ts

│ ├── readFile.ts

│ ├── traceDependencies.ts

│ ├── generateDependencyDiagram.ts

│ ├── explainMethod.ts

│ └── analyzeChangeImpact.ts

├── viewer/

│ └── src/

│ ├── App.tsx

│ └── styles.css

├── package.json

└── README.md

```

The exact file list can evolve as new tools are added.

## Prerequisites

Recommended environment:

- Node.js 22+

- npm

- VS Code or another MCP-compatible client

- macOS, Windows, or Linux

The current development setup uses TypeScript, Node.js, Express, Vite,

React, and React Flow.

## Installation

Clone/open the project and install dependencies:

``` bash

cd /Users/ayyappakumar/Desktop/Ayyappa/Projects/Developer/developer-productivity-mcp

npm install

```

Build to verify TypeScript:

``` bash

npm run build

```

## Running

The normal development workflow uses three terminals.

### Terminal 1 --- MCP Server

``` bash

cd /Users/ayyappakumar/Desktop/Ayyappa/Projects/Developer/developer-productivity-mcp

npm run dev

```

### Terminal 2 --- HTTP Bridge

``` bash

cd /Users/ayyappakumar/Desktop/Ayyappa/Projects/Developer/developer-productivity-mcp

npm run http

```

The HTTP bridge is expected at:

``` text

http://127.0.0.1:4174

```

### Terminal 3 --- Viewer

``` bash

cd /Users/ayyappakumar/Desktop/Ayyappa/Projects/Developer/developer-productivity-mcp

npm run viewer

```

Open:

``` text

http://127.0.0.1:4173

```

### Production-style MCP server

``` bash

npm run build

npm start

```

## MCP Inspector

The project includes:

``` bash

npm run start-mcp-inspector

```

Use the Inspector to verify:

- MCP server registration

- Available tools

- Tool schemas

- Tool execution

- Tool responses

If the server does not appear, restart the MCP client/Inspector after

changing the MCP configuration.

## HTTP API

The local HTTP bridge exposes capabilities used by the viewer.

### Dependency Analysis

``` http

POST /api/dependencies

```

Example:

``` json

{

"projectPath": "/path/to/project",

"filePath": "src/App.tsx",

"maxDepth": 3,

"maxNodes": 300

}

```

### Method Analysis

``` http

POST /api/explain-method

```

Example:

``` json

{

"projectPath": "/path/to/project",

"symbol": "generateGraph",

"filePath": "viewer/src/App.tsx",

"includeSource": true

}

```

### Change Impact

``` http

POST /api/analyze-change-impact

```

The exact request/response contract should be kept aligned with the

current implementation in `src/httpServer.ts` and the change-impact

analyzer module.

## Dependency Explorer

Typical workflow:

1. Enter the target project absolute path.

2. Enter an entry file such as `src/App.tsx`.

3. Choose maximum depth.

4. Choose maximum nodes.

5. Generate the tree.

6. Switch between Tree View and Graph View.

7. Use Method Explorer for a specific function.

8. Use Change Impact before modifying an important symbol.

For large repositories, begin with:

``` text

Maximum depth: 3

Maximum nodes: 300

```

and increase gradually.

## Method Explorer

Use Method Explorer when you need to understand the implementation of

one symbol.

Example:

``` text

Symbol: generateGraph

File: viewer/src/App.tsx

```

It is intended to answer:

- What calls does this function make?

- Does it perform asynchronous work?

- Does it contain branches?

- Does it contain loops?

- Is it recursive?

- Which project functions does it call?

- Who calls this function?

- What source code implements it?

## Change Impact Analyzer

Use Change Impact when you are about to modify an important symbol.

Example:

``` text

File:

viewer/src/App.tsx

Symbol:

generateGraph

```

The analyzer should help answer:

> If I change `generateGraph`, which consumers and downstream files

> should I review?

The **References** tab provides concrete source references. The detail

view supports returning to the reference list with **Back to

References**.

## How the Tools Work Together

The intended developer workflow is:

``` text

Project

|

v

Scan Project

|

v

Find Files

|

v

Find References

/ v v

Trace Dependencies Explain Method

| |

v v

Dependency Graph Call Graph

\ /

\ /

v v

Change Impact

|

v

Risk Analysis

|

v

Recommendations

```

The distinction is intentional:

- **Dependency Explorer** --- What depends on what?

- **Method Explorer** --- What does this function do?

- **Change Impact** --- What could be affected if I change it?

## Safety and Validation

Analysis tools should use safeguards such as:

- Project-path validation

- File-path validation

- Maximum dependency depth

- Maximum graph size

- Controlled source-file discovery

- Warnings for unresolved imports

Large projects can produce very large graphs, so depth/node limits are

important.

## Dependency Resolution Notes

TypeScript AST analysis is used for import extraction. This avoids

incorrectly treating import-like text inside comments as real

dependencies.

For example:

``` tsx

/**

* Example:

* import Something from "./Something";

*/

```

should not become a dependency.

External packages may also be resolved from the target project's

installed dependency tree. A transitive package can therefore appear in

analysis even when it is not directly declared by the application's

package manifest.

## Troubleshooting

### Viewer does not open

Run:

``` bash

npm run viewer

```

Then visit:

``` text

http://127.0.0.1:4173

```

### API request fails

Make sure the HTTP bridge is running:

``` bash

npm run http

```

Expected port:

``` text

4174

```

### MCP server is not visible

Check:

``` bash

npm run dev

```

Then verify the MCP configuration and restart/reload the MCP client.

### Dependency graph is too large

Reduce:

``` text

Maximum depth

Maximum nodes

```

For example:

``` text

Depth = 2

Nodes = 100

```

Then increase them gradually.

### Import cannot be resolved

A warning can be caused by:

- Bundler aliases

- Virtual modules

- Generated files

- Non-standard module resolution

- Conditional package exports

- Missing direct dependency declarations

Review the warning before treating it as an application error.

## Future MCP Roadmap

The following are planned/proposed capabilities. They are roadmap items

and should not be considered implemented unless the corresponding tool

exists in the codebase.

### Phase 1 --- Code Intelligence

#### Code Quality Analyzer

Detect:

- Long functions

- Large components

- Deep nesting

- High complexity

- Duplicate logic

- Dead code

- Unused exports

#### Dead Code Detector

Find unused:

- Functions

- Exports

- Components

- Files

- Imports

#### Duplicate Code Detector

Find repeated code across components, hooks, utilities, and services.

#### Circular Dependency Analyzer

Detect cycles such as:

``` text

A.ts → B.ts → C.ts → A.ts

```

and show the cycle path.

### Phase 2 --- React Intelligence

#### React Component Analyzer

Analyze:

- Component hierarchy

- Props

- State

- Context

- Hooks

- Effects

- Child components

#### React Re-render Analyzer

Identify possible unnecessary renders caused by:

- Object identity

- Function identity

- Context updates

- Parent renders

- Missing memoization

#### Hook Dependency Analyzer

Analyze:

``` text

useEffect

useMemo

useCallback

```

for dependency and stale-closure risks.

#### State Flow Analyzer

Visualize:

``` text

State

↓

Parent

↓

Props

↓

Child

↓

Event

↓

State update

```

### Phase 3 --- API Intelligence

#### API Dependency Analyzer

Trace:

``` text

React component

↓

Service

↓

API client

↓

Endpoint

↓

Backend service

```

#### API Contract Analyzer

Compare frontend types with API/OpenAPI contracts.

#### Breaking API Change Detector

Detect:

- Removed fields

- Renamed fields

- Changed types

- Newly required fields

- Removed endpoints

### Phase 4 --- Testing Intelligence

#### Test Impact Analyzer

Answer:

> Which tests should I run after changing this code?

#### Test Coverage Explorer

Connect:

``` text

Source file

↓

Function

↓

Test

```

#### Test Generator Assistant

Suggest tests based on the analyzed method and its branches/inputs.

### Phase 5 --- Security Intelligence

#### Security Analyzer

Potentially detect:

- Hardcoded secrets

- Unsafe API usage

- Dangerous DOM operations

- Insecure configuration

- Suspicious dependencies

#### Secret Detector

Identify likely:

- API keys

- Tokens

- Passwords

- Credentials

Secrets should never be exposed unnecessarily in tool output.

### Phase 6 --- Package Intelligence

#### Package Analyzer

Analyze:

- Direct dependencies

- Transitive dependencies

- Duplicate versions

- Unused packages

- Missing direct declarations

#### Dependency Upgrade Impact Analyzer

Before upgrading a package, identify potentially affected files, APIs,

tests, and breaking changes.

### Phase 7 --- Git Intelligence

#### Git Change Analyzer

Analyze a `git diff` and explain:

- What changed

- Which symbols changed

- Potential risks

- Potentially affected consumers

- Tests to review

#### Commit Impact Analyzer

Analyze a commit and map changed symbols to consumers and downstream

files.

#### PR Review MCP

Review pull requests for:

- Code quality

- Change risk

- Dependency changes

- Missing tests

- Breaking changes

- Architecture concerns

### Phase 8 --- AI Developer Intelligence

#### Codebase Context MCP

Produce structured context for an AI assistant:

``` text

Architecture

Relevant files

Relevant symbols

Dependencies

Call relationships

Tests

API relationships

```

This can reduce unnecessary source-code context.

#### Architecture Explorer

Infer architecture such as:

``` text

UI

↓

Hooks

↓

State

↓

Services

↓

API

↓

Infrastructure

```

and identify possible architectural violations.

#### Refactoring Assistant

Suggest refactoring opportunities such as:

``` text

Large component

↓

Extract hook

↓

Extract service

↓

Extract reusable component

```

### Phase 9 --- Developer Workflow Intelligence

#### Debugging Assistant

Trace:

``` text

Error

↓

File

↓

Function

↓

Dependency

↓

Likely root cause

```

#### Log Analyzer

Connect application errors/logs to likely source locations.

#### Performance Analyzer

Identify:

- Expensive functions

- Repeated calculations

- Large dependency chains

- Excessive React renders

- Unnecessary network calls

### Phase 10 --- Documentation Intelligence

#### Code Documentation MCP

Generate/update:

- JSDoc

- README sections

- API documentation

- Architecture documentation

- Function descriptions

#### Architecture Documentation Generator

Generate architecture diagrams and documentation from source code.

## Long-Term Vision

The long-term goal is a unified developer-intelligence system:

``` text

Codebase

|

v

Developer Productivity MCP

|

+-----------------+-----------------+

| | |

v v v

Dependency Method Change Impact

Intelligence Intelligence Intelligence

| | |

+-----------------+-----------------+

|

v

Code Intelligence

|

+-----------------+-----------------+

| | |

v v v

Testing Security Performance

|

v

AI Code Assistant

```

The important architectural principle is that future tools should reuse

the existing analysis foundation rather than duplicating AST/reference

logic.

## Recommended Development Order

``` text

1. Dependency Explorer

↓

2. Method Explorer

↓

3. Change Impact

↓

4. Test Impact

↓

5. React Intelligence

↓

6. API Intelligence

↓

7. Git Intelligence

↓

8. Security Intelligence

↓

9. Performance Intelligence

↓

10. AI Codebase Context

```

## Development Guidelines

### Preserve MCP contracts

When adding tools:

- Keep existing tool names stable.

- Avoid breaking existing response fields.

- Prefer additive response changes.

- Keep MCP and HTTP responsibilities separated.

### Reuse analysis

Prefer:

``` text

findReferences()

↓

Change Impact

traceDependencies()

↓

Dependency Graph

explainMethod()

↓

Method Explorer

findFiles()

↓

Project discovery

```

Do not duplicate the same AST analysis in every future tool.

### Prefer AST analysis

Use the TypeScript AST for structural TypeScript/JavaScript analysis

whenever possible. Use regex only for simple textual tasks where it is

appropriate.

### Separate UI and MCP responsibilities

The MCP layer should focus on:

``` text

Analysis

Validation

Structured results

```

The viewer should focus on:

``` text

Visualization

Navigation

Filtering

Interaction

```

This keeps the MCP tools reusable from other MCP clients.

## Quick Start

``` bash

cd /Users/ayyappakumar/Desktop/Ayyappa/Projects/Developer/developer-productivity-mcp

npm install

```

Terminal 1:

``` bash

npm run dev

```

Terminal 2:

``` bash

npm run http

```

Terminal 3:

``` bash

npm run viewer

```

Then:

``` text

http://127.0.0.1:4173

```

## Current Status

Current foundation includes:

- MCP server

- Project scanning

- File discovery

- Reference discovery

- File reading

- Dependency tracing

- Dependency graph visualization

- Method/function analysis

- Method call graph visualization

- Change impact analysis

- Risk visualization

- Local HTTP integration

- React/Vite developer UI

- MCP Inspector support

Future capabilities in this README are roadmap items and should be

marked implemented only after their corresponding MCP/tool code is added

and verified.

## Implementation Status Tracker

Use this section as the project checklist. Update the status from `[ ]` to `[x]` whenever a capability is completed and verified.

### Current MCP Tools — Implemented

- [x] `helloDeveloper.ts` — MCP connectivity/testing
- [x] `scanProject.ts` — Project scanning and discovery
- [x] `findFiles.ts` — File discovery
- [x] `findReferences.ts` — Reference/usages discovery
- [x] `readFile.ts` — Controlled source-file reading
- [x] `traceDependencies.ts` — Dependency tree tracing
- [x] `generateDependencyDiagram.ts` — Dependency graph data generation
- [x] `explainMethod.ts` — Function/method/component analysis
- [x] `analyzeChangeImpact.ts` — Change-impact and risk analysis
- [x] `analyzeCodeQuality.ts` — Code quality analysis
- [x] `analyzeDeadCode.ts` — Dead-code analysis
- [x] `analyzeApiEndpoints.ts` — API endpoint analysis
- [x] `analyzeTestCoverage.ts` — Test coverage analysis
- [x] `analyzeSecurity.ts` — Security analysis
- [x] `analyzeDependencyHealth.ts` — Dependency health analysis

**Current MCP tool count: 15**

### Roadmap Completion Tracker

#### Phase 1 — Code Intelligence

- [x] Code Quality Analyzer — `analyzeCodeQuality.ts`
- [x] Dead Code Detector — `analyzeDeadCode.ts`
- [x] Duplicate Code Detector - `detectDuplicateCode.ts`
- [x] Circular Dependency Analyzer - `analyzeCircularDependencies.ts`

**Phase 1: 2/4 complete**

#### Phase 2 — React Intelligence

- [x] React Component Analyzer - `analyzeReactComponent.ts`
- [x] React Re-render Analyzer - `analyzeReactRerender.ts`
- [x] Hook Dependency Analyzer - `analyzeHookDependencies.ts`
- [x] State Flow Analyzer - `analyzeStateFlow`

**Phase 2: 0/4 complete**

#### Phase 3 — API Intelligence

- [x] API Dependency Analyzer — `analyzeApiEndpoints.ts`
- [x] API Contract Analyzer - `analyzeApiContracts.ts`
- [x] Breaking API Change Detector - `detectBreakingApiChanges.ts`

**Phase 3: 1/3 complete**

#### Phase 4 — Testing Intelligence

- [x] Test Coverage Explorer — `analyzeTestCoverage.ts`
- [x] Test Impact Analyzer - `analyzeTestImpact.ts`
- [ ] Test Generator Assistant - Inprogress

**Phase 4: 1/3 complete**

#### Phase 5 — Security Intelligence

- [x] Security Analyzer — `analyzeSecurity.ts`
- [x] Secret Detector - `detectSecrets.ts`

**Phase 5: 1/2 complete**

#### Phase 6 — Package Intelligence

- [x] Package / Dependency Health Analyzer — `analyzeDependencyHealth.ts`
- [ ] Dependency Upgrade Impact Analyzer

**Phase 6: 1/2 complete**

#### Phase 7 — Git Intelligence

- [ ] Git Change Analyzer
- [ ] Commit Impact Analyzer
- [ ] PR Review MCP

**Phase 7: 0/3 complete**

#### Phase 8 — AI Developer Intelligence

- [ ] Codebase Context MCP
- [ ] Architecture Explorer
- [ ] Refactoring Assistant

**Phase 8: 0/3 complete**

#### Phase 9 — Developer Workflow Intelligence

- [ ] Debugging Assistant
- [ ] Log Analyzer
- [ ] Performance Analyzer

**Phase 9: 0/3 complete**

#### Phase 10 — Documentation Intelligence

- [ ] Code Documentation MCP
- [ ] Architecture Documentation Generator

**Phase 10: 0/2 complete**

### Overall Roadmap Status

| Phase | Capability | Done | Pending | Status |
|---|---|---:|---:|---|
| Phase 1 | Code Intelligence | 2 | 2 | 🟡 In progress |
| Phase 2 | React Intelligence | 0 | 4 | ⚪ Not started |
| Phase 3 | API Intelligence | 1 | 2 | 🟡 In progress |
| Phase 4 | Testing Intelligence | 1 | 2 | 🟡 In progress |
| Phase 5 | Security Intelligence | 1 | 1 | 🟡 In progress |
| Phase 6 | Package Intelligence | 1 | 1 | 🟡 In progress |
| Phase 7 | Git Intelligence | 0 | 3 | ⚪ Not started |
| Phase 8 | AI Developer Intelligence | 0 | 3 | ⚪ Not started |
| Phase 9 | Developer Workflow Intelligence | 0 | 3 | ⚪ Not started |
| Phase 10 | Documentation Intelligence | 0 | 2 | ⚪ Not started |
| **Total** | **29 roadmap capabilities** | **6** | **23** | **21% complete** |

> **Important:** The roadmap tracker counts only the capabilities defined in the Future MCP Roadmap. The current MCP tool count is separate because the project already contains foundational tools such as `scanProject`, `findFiles`, `findReferences`, `readFile`, `traceDependencies`, `generateDependencyDiagram`, `explainMethod`, and `analyzeChangeImpact`.

### How to Update This Section

When a new capability is completed and verified:

1. Change its checkbox from `[ ]` to `[x]`.
2. Add the actual tool filename after the capability name.
3. Update the **Done** and **Pending** counts for that phase.
4. Update the **Overall Roadmap Status** table.
5. Update the **Current MCP tool count** if a new MCP tool file was added.

Example:

```text
- [x] React Component Analyzer — `analyzeReactComponent.ts`
```

## License

Add the intended project license before publishing the repository.

## Author

Developer Productivity MCP

Built as a reusable developer-intelligence foundation for TypeScript and

React codebases.




Draggable item chatgpt:project:g-p-689ce0d331c48191b8c60a240e61fe49 was dropped over droppable area chatgpt:project:g-p-689ce0d331c48191b8c60a240e61fe49