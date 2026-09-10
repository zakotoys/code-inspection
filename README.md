# Code Inspection

Code Inspection is a local workspace service for JavaScript and TypeScript quality checks. It runs the project's own ESLint and TypeScript installations, can run an explicitly configured build, publishes diagnostics through LSP on save, and exposes the same current results to agents through MCP.

The repository ships three usable surfaces:

- `@zakotoys/code-inspection-runtime`: CLI, local service, stdio MCP server, and stdio LSP server.
- VS Code extension: bundled LSP and MCP launchers, manual run/cancel commands, and workspace-trust integration.
- Zed extension: a small native launcher for the installed `code-inspection-lsp` executable. Zed MCP is configured through native context-server settings.

## Requirements

- Node.js 18.20 or newer.
- A project-local `eslint` for ESLint inspection.
- A project-local TypeScript version that exposes the compiler API for TypeScript inspection. TypeScript 6.x is supported by the included fixture.
- Rust with the `wasm32-wasip2` target only when building the Zed extension.

Inspection never installs project dependencies or silently substitutes bundled tools. Project plugins, configs, and build commands execute local code, so each workspace must be trusted explicitly.

## Quick Start

From a project containing ESLint and a flat config:

```text
npm install --global @zakotoys/code-inspection-runtime
code-inspection init
code-inspection trust .
code-inspection inspect --inspector eslint
```

`inspect` exits with `0` for a clean run, `1` when findings exist, `2` for an execution failure, and `3` for cancellation or supersession. Use `--json` for machine-readable output. `findings` reads the latest shared result set.

The optional `.code-inspection.json` file controls enabled inspectors, project working directories, source patterns, build command arrays, and timeouts:

```json
{
  "version": 1,
  "debounceMs": 300,
  "inspectors": {
    "eslint": {
      "enabled": true,
      "cwd": ".",
      "patterns": ["**/*.{js,jsx,ts,tsx}"]
    },
    "typescript": {
      "enabled": true,
      "cwd": ".",
      "project": "tsconfig.json"
    },
    "build": {
      "enabled": false,
      "cwd": ".",
      "command": ["npm", "run", "build"],
      "timeoutMs": 120000
    }
  }
}
```

Build commands are argument arrays rather than shell strings. They are serialized and are never inferred from empty output.

## MCP

Run the local stdio server from the workspace root:

```json
{
  "mcpServers": {
    "code-inspection": {
      "command": "code-inspection-mcp",
      "cwd": "/path/to/workspace"
    }
  }
}
```

The server exposes `run_inspection`, `get_run`, and `get_findings`. A run returns immediately with an ID; agents poll `get_run` and then read paginated findings. MCP stdout contains protocol messages only. The workspace must already be trusted with `code-inspection trust /path/to/workspace`.

## Editors

Build and install the VS Code package locally with:

```text
npm install
npm run package:vscode
```

Install the generated `artifacts/code-inspection-vscode-0.1.0.vsix`. The extension starts its bundled LSP and MCP runtime. A trusted VS Code workspace grants the matching local trust record; untrusted workspaces remain read-only and do not execute project tools.

For Zed development or distribution, install the runtime so `code-inspection-lsp` is on Zed's PATH, install the extension from `extensions/zed`, then trust the workspace with the CLI. See [the Zed extension guide](extensions/zed/README.md) for native MCP and language-server settings.

## Build And Test

```text
npm ci
npm run check
npm run smoke:lsp
npm run smoke:mcp
npm run package
npm run smoke:package
```

The package command creates the runtime/core npm tarballs, a self-contained VSIX, and the Zed WASM artifact under `artifacts/`. The smoke commands exercise real LSP/MCP child processes and a clean consumer install from those tarballs. CI runs the Node test/build workflow on Windows, macOS, and Linux and compiles the Zed target on Linux.

See [PLAN.md](PLAN.md) for the original research, architectural decisions, and acceptance criteria.
