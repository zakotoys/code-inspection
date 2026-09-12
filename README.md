# Code Inspection

**English** | [简体中文](README.zh-CN.md) | [日本語](README.ja-JP.md)

Local JavaScript and TypeScript inspection shared by your editor, terminal, and AI agents. Run your project's ESLint and TypeScript, execute configured builds, and read normalized findings through the CLI, Model Context Protocol (MCP), or Language Server Protocol (LSP) editor diagnostics.

## Features

| Capability | Behavior |
| --- | --- |
| ESLint | Loads the project's ESLint and configuration. Checks source patterns or explicit files; reports rule IDs, severity, and locations. |
| TypeScript | Collects compiler diagnostics for the configured project without emitting files. Passes project references to the compiler API; does not orchestrate `tsc --build`. |
| Builds | Runs an executable/argument array with a working directory, environment overrides, timeout, and bounded stdout/stderr. Nonzero exits produce workspace-level error findings. |
| Shared service | CLI, LSP, and MCP connect to one service per canonical workspace root using authenticated local IPC: Windows named pipes or Unix sockets. |
| Inspection on save | LSP saves queue enabled inspectors. Saves are debounced, queued file scopes coalesce, and superseded runs cannot overwrite newer results. |
| Findings and freshness | Findings carry source, code, severity, optional file/range, run ID, and generation. Edits and observed filesystem changes invalidate results; successful checks replace findings in their scope. |
| CLI | Initialize configuration, grant/revoke trust, inspect, query findings/status, and cancel runs. Human-readable/JSON inspection output and meaningful exit codes. |
| MCP | Three tools for queuing inspections, reading run state, and querying paginated findings. Structured output with JSON or Markdown text; protocol-only stdout. |
| VS Code | Bundled runtime, diagnostics, multiple workspace folders, manual run/cancel, output channel, workspace trust, and MCP definitions. |
| Zed | Rust/WASM launcher for the installed LSP executable, attached to JavaScript, TypeScript, and TSX. Native MCP configuration is separate. |
| Distribution | Core/runtime npm tarballs, self-contained VSIX, Zed WASM, and automated build, test, protocol, and package checks. |

## Requirements

- Core/runtime manifests declare Node.js `>=18.20`. Development and CI use Node.js 24; installed project tools may require a newer Node version than the runtime minimum.
- Project-local ESLint exposing the `ESLint` API and/or TypeScript exposing its compiler API. Fixtures use ESLint 10 and TypeScript 6.
- VS Code `1.103.0` or newer for the extension.
- Rust with `wasm32-wasip2` only when building the Zed extension.

Inspection never installs project dependencies automatically or replaces them with bundled lint/compiler tools.

## Quick start from this repository

From the repository root:

```sh
npm ci
npm run build
npm run package:core
npm run package:runtime
npm install --global ./artifacts/zakotoys-code-inspection-core-0.1.0.tgz ./artifacts/zakotoys-code-inspection-runtime-0.1.0.tgz
```

Switch to the project to inspect, with its ESLint dependency and configuration already installed:

```sh
cd /path/to/your-project
code-inspection init
code-inspection trust .
code-inspection inspect --inspector eslint
code-inspection findings
```

`init` creates `.code-inspection.json` with ESLint enabled and TypeScript/build disabled. It refuses to overwrite an existing file. Enable other inspectors before requesting them.

These steps use local artifacts without requiring registry publication. Public npm/editor publication is a separate release action. The current CI builds/uploads editor artifacts; it has no publication workflow.

## CLI reference

| Command | Purpose |
| --- | --- |
| `init` | Create configuration. |
| `trust` / `revoke` | Grant/remove the local execution trust record. |
| `inspect` | Run selected inspectors and wait; defaults to `eslint`. |
| `findings` | Read up to 500 findings; `--include-stale` includes outdated results. |
| `status` | Print JSON with trust, active/latest runs, and finding count. |
| `cancel --run-id <id>` | Cancel a queued or active run. |
| `help` / `--version` | Show usage/version. |

Commands default to the current directory. Select another root with `--workspace` (`-w`) or a positional path. Quote paths containing spaces.

```sh
code-inspection inspect -w /path/to/project -i eslint,typescript --json
code-inspection inspect -i eslint -f src/index.ts -f src/app.ts
code-inspection findings --json --include-stale
code-inspection status
code-inspection cancel --run-id <run-id>
code-inspection revoke /path/to/project
```

`--inspector` (`-i`) accepts comma-separated IDs or repeated options; `--file` (`-f`) repeats, with at most 100 files per request. TypeScript/build still inspect their full project. `inspect --trust` persists a trust grant. Disabled inspectors are skipped with a warning by the CLI.

| `inspect` exit code | Meaning |
| --- | --- |
| `0` | No findings in performed runs; also returned if every selected inspector was skipped. |
| `1` | Findings, including warnings or a build's nonzero exit. |
| `2` | Execution/request failure, such as missing tools or missing trust. |
| `3` | Cancelled or superseded. |

## Configuration

`.code-inspection.json` is optional; without it only ESLint is enabled. This example also enables TypeScript:

```json
{
  "version": 1,
  "debounceMs": 300,
  "maxFindings": 2000,
  "inspectors": {
    "eslint": {
      "enabled": true,
      "cwd": ".",
      "patterns": ["**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"]
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
      "timeoutMs": 120000,
      "env": {}
    }
  }
}
```

| Setting | Default and behavior |
| --- | --- |
| `version` | `1`; unknown keys are rejected. |
| `debounceMs` | `300`; save scheduling delay, `0`–`10000` ms. |
| `maxFindings` | `2000`; output cap per inspection, `1`–`10000`. Summaries count retained findings. |
| `inspectors.*.enabled` | ESLint on, TypeScript/build off when sections are omitted. Set explicitly when adding sections. Enabling builds also enables them on editor saves. |
| `inspectors.*.cwd` | `.`; workspace-relative execution/tool resolution directory. One configuration per inspector per workspace root. |
| `eslint.patterns` | The source glob above; explicit file requests replace it. |
| `typescript.project` | `tsconfig.json`, relative to its inspector's `cwd`. |
| `build.command` | `["npm", "run", "build"]`; executable and arguments, not a shell expression. |
| `build.timeoutMs` | `120000`; accepts `1000`–`600000` ms. |
| `build.env` | `{}`; merged into inherited environment variables. |
| `inspectors.*.exclude` | Accepted by the schema but currently not applied by the engine. Use ESLint ignores and TypeScript project configuration for scope. |

Build logs are capped at 200,000 characters per stream. Build findings have no fabricated file locations; read logs and exit status through CLI JSON or MCP.

## Trust, lifecycle, and freshness

Project plugins/configuration and build commands execute local code. Grant trust after reviewing the workspace; MCP cannot grant it. Trust is stored outside the repository and tied to the exact contents of `.code-inspection.json`. After creating/editing that file, run `code-inspection trust .` again. The hash does not cover every dependency or tool configuration.

The service starts on demand and normally exits after 30 seconds without clients and with no active runs. Findings/run history are in memory and disappear when it restarts. Filesystem events invalidate results; automatic execution requires an editor save notification.

| Environment variable | Purpose |
| --- | --- |
| `CODE_INSPECTION_DATA_DIR` | Override trust/service discovery storage. Defaults to local application data on Windows, Application Support on macOS, or XDG state on Linux. |
| `CODE_INSPECTION_IDLE_TIMEOUT_MS` | Override the default `30000` ms idle timeout. |

## MCP integration

Use the installed executable as a local stdio server:

```json
{
  "command": "code-inspection-mcp",
  "args": []
}
```

Place this object in your client's server configuration using its format. Set the process working directory to the workspace if supported, or pass an absolute `workspace` in every tool call. The default is the server's process working directory. One MCP process can connect to multiple trusted roots. Logs go to stderr.

| Tool | Inputs and result |
| --- | --- |
| `run_inspection` | Required `inspector`: `eslint`, `typescript`, or `build`; optional `files` (max 100). Immediately returns a run record with `runId`. |
| `get_run` | Required `run_id`. Returns run state, summary/error, findings, and freshness metadata. |
| `get_findings` | Optional `inspector`, `file`, `offset` (default `0`), `limit` (default `50`, max `500`), `include_stale` (default `false`). Returns a page plus latest runs. Follow `nextOffset` while `hasMore` is true. |

All tools accept `workspace` and `response_format` (`json` by default, or `markdown`), and return structured content in either format.

1. Call `run_inspection` with `{"workspace":"/path/to/project","inspector":"eslint"}`.
2. Pass its `runId` as `run_id` to `get_run` for the same workspace.
3. Poll until `completed`, `failed`, `cancelled`, or `superseded`; `queued` and `running` are nonterminal.
4. Read `get_findings` and check freshness. A completed run may contain errors. Failed runs retain previous findings as stale; these are hidden by default.

There is no MCP cancellation/trust tool; use the CLI. Finding ranges use zero-based UTF-16 positions; displayed CLI/Markdown locations are one-based.

## Editors

### VS Code

After `npm ci` and `npm run build`:

```sh
npm run package:vscode
code --install-extension artifacts/code-inspection-vscode-0.1.0.vsix
```

Open a local workspace and grant Workspace Trust. The extension launches its bundled LSP, grants the matching local trust record, and provides a bundled MCP definition per workspace folder. Save supported JS/TS files to inspect; fix/save to clear resolved diagnostics. Untrusted editor sessions do not execute LSP inspections or expose MCP definitions.

| Command/setting | Purpose |
| --- | --- |
| `Code Inspection: Run` | Request the default inspector in the active workspace. |
| `Code Inspection: Cancel Last Run` | Request cancellation of the last manually started run. |
| `codeInspection.defaultInspector` | `eslint` by default; also `typescript` or `build`. |
| `codeInspection.runtimePath` | Optional external LSP executable; empty uses the bundle. Does not replace the bundled MCP executable. |

The **Code Inspection** output channel contains launcher/manual-command messages. Other extensions may publish overlapping diagnostics.

### Zed

Install the runtime tarballs above, put `code-inspection-lsp` on Zed's PATH, and trust the workspace through the CLI. Install `extensions/zed` as a development extension. The [Zed guide](extensions/zed/README.md) contains language-server/native MCP settings. Pass `workspace` in MCP calls if the host working directory differs.

The extension launches an installed runtime; it does not download one. Server smoke tests do not verify the complete Zed UI workflow; installed-editor checks remain a manual release step.

## Monorepo and development

```text
CLI ----------------------+
MCP stdio ----------------+--> Workspace service --> ESLint / TypeScript / build
VS Code / Zed --> LSP -----+    shared scheduling and in-memory findings
```

| Path | Responsibility |
| --- | --- |
| [packages/core](packages/core) | `@zakotoys/code-inspection-core`: configuration, trust, contracts, inspectors; no editor/MCP dependency. |
| [packages/runtime](packages/runtime) | `@zakotoys/code-inspection-runtime`: CLI, IPC, service, MCP, LSP. |
| [extensions/vscode](extensions/vscode) | VS Code client, commands, trust, MCP provider. |
| [extensions/zed](extensions/zed) | Rust/WASM launcher and manifest. |
| [tests/fixtures](tests/fixtures) | Clean/broken lint/type projects and failing builds. |
| [scripts](scripts) | Packaging and process-level smoke checks. |
| [.github/workflows/ci.yml](.github/workflows/ci.yml) | Node 24 checks on Windows/macOS/Linux; editor packaging on Linux. |

```sh
npm ci
npm run check
npm run smoke:lsp
npm run smoke:mcp
npm run package:core
npm run package:runtime
npm run smoke:package
```

`check` builds npm workspaces and runs tests. Protocol smoke checks use real child processes. Package smoke installs local tarballs into a temporary consumer and checks trust, shared findings, paths with spaces, and idle shutdown.

For all distribution artifacts:

```sh
rustup target add wasm32-wasip2
npm run package
```

Output in `artifacts/`: `zakotoys-code-inspection-core-0.1.0.tgz`, `zakotoys-code-inspection-runtime-0.1.0.tgz`, `code-inspection-vscode-0.1.0.vsix`, and `code-inspection-zed-0.1.0.wasm`. Individual core/runtime/VS Code packaging commands require an existing build; `package:zed` runs Cargo itself.

## Troubleshooting and scope

| Symptom | Check |
| --- | --- |
| Untrusted after a config edit | Review the file and grant trust again. |
| `missing-tool` / `unsupported-tool` | Project dependency resolution at `cwd`, exposed API, and Node requirements. |
| `missing-configuration` | ESLint configuration or TypeScript project path. |
| Empty findings | `status`, inspector enablement, stale filtering, and service restarts. Empty results alone do not prove a successful check. |
| No source diagnostics for a failed build | Build findings are workspace-level; read run JSON/MCP output. |
| Service handshake rejected | Ensure CLI/editor runtime versions match and restart old clients/service after updating. |

Scope: local filesystem workspaces, JS/TS lint/type diagnostics, and configured builds. No automatic fixing, persistent history, remote/browser workspaces, arbitrary language inspector framework, or unsolicited agent startup. ESLint/TypeScript run in process with cooperative cancellation, not isolated workers. Build cancellation/timeouts request termination; universal descendant-process cleanup is not guaranteed.

The [architecture and delivery plan](docs/plan/code-inspection-architecture-and-delivery.md) records original research and intended acceptance criteria. This README describes the implementation rather than treating every planned capability as shipped.

## License

[Apache-2.0](LICENSE)
