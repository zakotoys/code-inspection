# Code Inspection

**English** | [简体中文](README.zh-CN.md) | [日本語](README.ja-JP.md)

Local multi-language inspection shared by your editor, terminal, and AI agents. Run project-local analyzers for JavaScript/TypeScript, Python, Java, Go, Rust, C, and C++, then read one normalized finding set through the CLI, Model Context Protocol (MCP), or Language Server Protocol (LSP).

## Features

| Capability | Behavior |
| --- | --- |
| JavaScript/TypeScript | ESLint plus TypeScript Compiler API diagnostics. Project-local packages and `tsconfig.json` are used without emitting files. |
| Python | Ruff JSON diagnostics and optional Pyright JSON diagnostics. |
| Java | Checkstyle/PMD through Maven or Gradle wrappers, plus explicit Java build commands. |
| Go | `go vet` JSON diagnostics and optional `golangci-lint`. |
| Rust | `cargo check` and optional `cargo clippy` Cargo JSON diagnostics. |
| C/C++ | Clang/clang-tidy diagnostics; clang-tidy requires a `compile_commands.json` database. |
| Builds | Any configured executable/argument array with cwd, environment, timeout, bounded output, and process-group cancellation. |
| Shared service | CLI, LSP, and MCP connect to one service per canonical workspace root using authenticated local IPC: Windows named pipes or Unix sockets. |
| Inspection on save | LSP saves queue only enabled checks matching the file language/project. Saves are debounced, project requests coalesce, and superseded runs cannot overwrite newer results. |
| Findings and freshness | Findings carry source, code, severity, optional file/range, run ID, and generation. Edits and observed filesystem changes invalidate results; successful checks replace findings in their scope. |
| CLI | Initialize configuration, grant/revoke trust, inspect, query findings/status, and cancel runs. Human-readable/JSON inspection output and meaningful exit codes. |
| MCP | Dynamic capability discovery plus tools for queuing inspections, reading run state, and querying paginated findings. Structured JSON or Markdown; protocol-only stdout. |
| VS Code | Bundled runtime, diagnostics, multiple workspace folders, manual run/cancel, output channel, workspace trust, and MCP definitions. |
| Zed | Rust/WASM launcher for the installed LSP executable, attached to all supported languages. Native MCP configuration is separate. |
| Distribution | Core/runtime npm tarballs, self-contained VSIX, Zed WASM, and automated build, test, protocol, and package checks. |

## Requirements

- Core/runtime manifests declare Node.js `>=18.20`. Development and CI use Node.js 24; installed project tools may require a newer Node version than the runtime minimum.
- Install the analyzer used by each enabled check yourself: ESLint/TypeScript, Ruff/Pyright, JDK (and Maven/Gradle when needed), Go, Rust/Cargo, and Clang. The runtime never downloads tools.
- VS Code `1.103.0` or newer for the extension.
- Rust with `wasm32-wasip2` only when building the Zed extension.

Inspection never installs project dependencies automatically or replaces them with bundled lint/compiler tools.

## Quick start

Install the runtime from npm. It provides the CLI, MCP, and LSP executables and installs core as a dependency:

```sh
npm install --global @zakotoys/code-inspection-runtime
```

Switch to the project to inspect, with its ESLint dependency and configuration already installed:

```sh
cd /path/to/your-project
code-inspection init
code-inspection trust .
code-inspection inspect --check eslint
code-inspection findings
```

`init` creates a version 2 `.code-inspection.json` with every built-in check listed; ESLint is enabled and the other checks are disabled. It refuses to overwrite an existing file. Enable a check only after installing its tool and reviewing its command.

Install `@zakotoys/code-inspection-core` as a project dependency when embedding the protocol-independent engine instead of using the runtime executables.

## CLI reference

| Command | Purpose |
| --- | --- |
| `init` | Create configuration. |
| `trust` / `revoke` | Grant/remove the local execution trust record. |
| `inspect` | Run selected dynamic check IDs and wait; defaults to every enabled check. Project-scoped checks enumerate nested projects before running. |
| `findings` | Read up to 500 findings; `--include-stale` includes outdated results. |
| `capabilities` | List configured checks, supported languages, scopes, and project markers. |
| `projects` | List nested projects discovered for a check or language. |
| `status` | Print JSON with trust, active/latest runs, and finding count. |
| `cancel --run-id <id>` | Cancel a queued or active run. |
| `help` / `--version` | Show usage/version. |

Commands default to the current directory. Select another root with `--workspace` (`-w`) or a positional path. Quote paths containing spaces.

```sh
code-inspection capabilities -w /path/to/project
code-inspection inspect -w /path/to/project --check eslint,ruff,cargo-check --json
code-inspection inspect --check ruff -f src/app.py
code-inspection projects --check cargo-check --json
code-inspection findings --json --include-stale
code-inspection status
code-inspection cancel --run-id <run-id>
code-inspection revoke /path/to/project
```

`--check` (`-i`) accepts comma-separated dynamic IDs or repeated options; `--file` (`-f`) repeats, with at most 100 files per request. Project-scoped checks inspect their discovered project even when a file is supplied. `inspect --trust` persists a trust grant. Disabled checks are skipped with a warning.

| `inspect` exit code | Meaning |
| --- | --- |
| `0` | No findings in performed runs; also returned if every selected check was skipped. |
| `1` | Findings, including warnings or a build's nonzero exit. |
| `2` | Execution/request failure, such as missing tools or missing trust. |
| `3` | Cancelled or superseded. |

## Configuration

`.code-inspection.json` is optional; without it the default checks are ESLint enabled and TypeScript/build disabled. A check is a registry ID mapped to an adapter, language set, scope, and optional tool command:

```json
{
  "version": 2,
  "debounceMs": 300,
  "maxFindings": 2000,
  "checks": {
    "eslint": {
      "adapter": "eslint",
      "enabled": true,
      "languages": ["javascript", "typescript"],
      "scope": "file",
      "cwd": ".",
      "patterns": ["**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"]
    },
    "typescript": {
      "adapter": "typescript",
      "enabled": true,
      "languages": ["javascript", "typescript"],
      "scope": "project",
      "cwd": ".",
      "project": "tsconfig.json"
    },
    "ruff": {
      "adapter": "ruff",
      "enabled": true,
      "languages": ["python"],
      "scope": "file",
      "cwd": ".",
      "command": ["ruff", "check", "--output-format", "json"]
    }
  }
}
```

| Setting | Default and behavior |
| --- | --- |
| `version` | `2`; v1 `inspectors` configurations are rejected. Unknown keys are rejected. |
| `debounceMs` | `300`; save scheduling delay, `0`–`10000` ms. |
| `maxFindings` | `2000`; output cap per inspection, `1`–`10000`. Summaries count retained findings. |
| `checks.<id>.adapter` | Required built-in adapter: `eslint`, `typescript`, `ruff`, `pyright`, `go-vet`, `golangci-lint`, `cargo-check`, `cargo-clippy`, `checkstyle`, `pmd`, `java-build`, `clang-tidy`, `clang-build`, or `command`. |
| `checks.<id>.languages` | Language IDs: `javascript`, `typescript`, `python`, `java`, `go`, `rust`, `c`, `cpp`. Omit to use the adapter defaults; an empty list is valid for workspace commands. `.h` is classified as both C and C++. |
| `checks.<id>.scope` | `file`, `project`, or `workspace`; defaults to the adapter's scope. Project roots are discovered from language markers. |
| `checks.<id>.cwd` | `.`; workspace-relative execution/tool resolution directory. Paths may not escape the workspace. |
| `checks.<id>.command` | Executable plus argument array, never a shell expression. Required for `command` and explicit build adapters. |
| `checks.<id>.parser` | `text`, `build`, `ruff-json`, `pyright-json`, `go-json`, `golangci-json`, `rust-json`, `checkstyle-xml`, `pmd-json`, `sarif-json`, or `clang-json`. |
| `checks.<id>.timeoutMs` / `env` | Timeout `1000`–`600000` ms and environment overrides for external tools. stdout/stderr are capped at 200,000 characters per stream. |
| `checks.<id>.exclude` / `patterns` | Workspace-relative minimatch globs applied before invocation and to every parsed finding. Invalid globs are rejected. |
| `checks.<id>.options.reportFile` | Optional Java Checkstyle/PMD report path relative to the detected project root. Reports are parsed before command logs. |

Build logs are capped at 200,000 characters per stream. Build findings have no fabricated file locations; read logs and exit status through CLI JSON or MCP.

## Trust, lifecycle, and freshness

Project plugins/configuration and build commands execute local code. Grant trust after reviewing the workspace; MCP cannot grant it. Trust is stored outside the repository and tied to the exact contents of `.code-inspection.json`. After creating/editing that file, run `code-inspection trust .` again. The hash does not cover every dependency or tool configuration.

The service starts on demand and normally exits after 30 seconds without clients and with no active runs. Findings/run history are in memory and disappear when it restarts. A global scheduler allows at most two active runs; build/resource groups can impose a lower limit. Each packaged run executes in an isolated worker with a hard timeout and descendant-process cleanup. A timeout is a failed run with error code `timeout`, not a finding. Filesystem events invalidate results; automatic execution requires an editor save notification.

| Environment variable | Purpose |
| --- | --- |
| `CODE_INSPECTION_DATA_DIR` | Override trust/service discovery storage. Defaults to local application data on Windows, Application Support on macOS, or XDG state on Linux. |
| `CODE_INSPECTION_IDLE_TIMEOUT_MS` | Override the default `30000` ms idle timeout. |
| `CODE_INSPECTION_WORKER_PATH` | Override the packaged worker bundle path for embedding and release tests. |

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
| `list_inspectors` | Read-only dynamic list of configured checks and all supported language IDs. |
| `list_projects` | Read-only nested project discovery, optionally filtered by check or language. |
| `run_inspection` | Required dynamic `check_id`; optional `language`, `project`, and `files` (max 100). Immediately returns a run record with `runId`. |
| `get_run` | Required `run_id`. Returns run state, summary/error, findings, and freshness metadata. |
| `get_findings` | Optional `check_id`, `language`, `project`, `file`, `offset` (default `0`), `limit` (default `50`, max `500`), `include_stale` (default `false`). Returns a page plus latest runs. Follow `nextOffset` while `hasMore` is true. |

All tools accept `workspace` and `response_format` (`json` by default, or `markdown`), and return structured content in either format.

1. Call `list_inspectors` and select an enabled check.
2. Call `run_inspection` with `{"workspace":"/path/to/project","check_id":"eslint"}`.
3. Pass its `runId` as `run_id` to `get_run` for the same workspace.
4. Poll until `completed`, `failed`, `cancelled`, or `superseded`; `queued` and `running` are nonterminal.
5. Read `get_findings` and check freshness. A completed run may contain errors. Failed runs retain previous findings as stale; these are hidden by default.

There is no MCP cancellation/trust tool; use the CLI. Finding ranges use zero-based UTF-16 positions; displayed CLI/Markdown locations are one-based.

## Editors

### VS Code

After `npm ci` and `npm run build`:

```sh
npm run package:vscode
code --install-extension artifacts/code-inspection-vscode-0.2.0.vsix
```

Open a local workspace and grant Workspace Trust. The extension launches its bundled LSP, grants the matching local trust record, and provides a bundled MCP definition per workspace folder. Save supported JavaScript, TypeScript, Python, Java, Go, Rust, C, or C++ files to inspect; fix/save to clear resolved diagnostics. Untrusted editor sessions do not execute LSP inspections or expose MCP definitions.

| Command/setting | Purpose |
| --- | --- |
| `Code Inspection: Run` | Request the configured default check in the active workspace. |
| `Code Inspection: Cancel Last Run` | Request cancellation of the last manually started run. |
| `codeInspection.defaultCheck` | Dynamic configured check ID, `eslint` by default. |
| `codeInspection.runtimePath` | Optional external LSP executable; empty uses the bundle. Does not replace the bundled MCP executable. |

The **Code Inspection** output channel contains launcher/manual-command messages. Other extensions may publish overlapping diagnostics.

### Zed

Install the runtime tarballs above, put `code-inspection-lsp` on Zed's PATH, and trust the workspace through the CLI. Install `extensions/zed` as a development extension. The [Zed guide](extensions/zed/README.md) contains language-server/native MCP settings. Pass `workspace` in MCP calls if the host working directory differs.

The extension launches an installed runtime; it does not download one. Server smoke tests do not verify the complete Zed UI workflow; installed-editor checks remain a manual release step.

## Monorepo and development

```text
CLI ----------------------+
MCP stdio ----------------+--> Workspace service --> language adapters/tools
VS Code / Zed --> LSP -----+    shared scheduling and in-memory findings
```

| Path | Responsibility |
| --- | --- |
| [packages/core](packages/core) | `@zakotoys/code-inspection-core`: language catalog, project discovery, config/trust, registry, tool runner, parsers, and adapters; no editor/MCP dependency. |
| [packages/runtime](packages/runtime) | `@zakotoys/code-inspection-runtime`: CLI, IPC, service, MCP, LSP. |
| [extensions/vscode](extensions/vscode) | VS Code client, commands, trust, MCP provider. |
| [extensions/zed](extensions/zed) | Rust/WASM launcher and manifest. |
| [tests/fixtures](tests/fixtures) | Clean/broken fixtures for every supported language and tool output. |
| [scripts](scripts) | Packaging and process-level smoke checks. |
| [.github/workflows/ci.yml](.github/workflows/ci.yml) | Node 24 checks on Windows/macOS/Linux plus a pinned Ubuntu language-tool matrix and editor packaging. |
| [.github/workflows/release.yml](.github/workflows/release.yml) | Tag-triggered npm publication and GitHub Release creation. |

```sh
npm ci
npm run check
npm run smoke:lsp
npm run smoke:mcp
npm run smoke:languages
npm run package:core
npm run package:runtime
npm run smoke:package
```

`check` builds npm workspaces and runs tests. `smoke:languages` runs clean/broken CLI checks for all supported languages and probes the external tool matrix; set `STRICT_LANGUAGE_SMOKE=1` and `LANGUAGE_SMOKE_PROTOCOLS=1` in CI to require every tool plus MCP/LSP flows. Protocol smoke checks use real child processes. Package smoke installs local tarballs into a temporary consumer and checks trust, shared findings, paths with spaces, and idle shutdown.

For all distribution artifacts:

```sh
rustup target add wasm32-wasip2
npm run package
```

Output in `artifacts/`: `zakotoys-code-inspection-core-0.2.0.tgz`, `zakotoys-code-inspection-runtime-0.2.0.tgz`, `code-inspection-vscode-0.2.0.vsix`, and `code-inspection-zed-0.2.0.wasm`. Individual core/runtime/VS Code packaging commands require an existing build; `package:zed` runs Cargo itself.

Maintainers publish by pushing a `vX.Y.Z` tag after CI succeeds for the corresponding `main` commit. The **Publish release** workflow verifies the tag against the npm workspace, runtime dependency, Cargo, Zed, and runtime versions; repeats the tests and protocol smoke checks; builds the four artifacts; publishes core before runtime with npm provenance; and uses `softprops/action-gh-release` to create the GitHub Release. Stable versions use the npm `latest` tag and prereleases use `next`. The release contains both npm tarballs, the VSIX, the Zed WASM, and `SHA256SUMS`. npm publication uses GitHub OIDC trusted publishing; a repository `NPM_TOKEN` is needed only to bootstrap packages that do not yet exist.

## Troubleshooting and scope

| Symptom | Check |
| --- | --- |
| Untrusted after a config edit | Review the file and grant trust again. |
| `missing-tool` / `unsupported-tool` | Project dependency resolution at `cwd`, exposed API, and Node requirements. |
| `missing-configuration` | Analyzer project configuration, such as `tsconfig.json`, `pyproject.toml`, a Java wrapper, or a C/C++ compilation database. |
| Empty findings | `status`, inspector enablement, stale filtering, and service restarts. Empty results alone do not prove a successful check. |
| No source diagnostics for a failed build | Build findings are workspace-level; read run JSON/MCP output. |
| Service handshake rejected | Ensure CLI/editor runtime versions match and restart old clients/service after updating. |

Scope: local filesystem workspaces and normalized diagnostics for JavaScript/TypeScript, Python, Java, Go, Rust, C, and C++. No automatic fixing, persistent history, remote/browser workspaces, or arbitrary language plugin loading. External tools run with `shell: false`, bounded output, timeout, cancellation, and process-tree cleanup where the platform permits.

The [architecture and delivery plan](docs/plan/code-inspection-architecture-and-delivery.md) records original research and acceptance criteria. The [multilingual expansion plan](docs/plan/multilingual-inspection-expansion.zh-CN.md) records the v0.2.0 language and tool architecture.

## License

[Apache-2.0](LICENSE)
