# Code Inspection: Plan Overview

Research date: 2026-09-08. Status: v0.1.0 implementation complete and locally distributable; public registry publication remains an external release action. The proposed multilingual follow-up is documented in [多语言代码检查扩展计划](multilingual-inspection-expansion.zh-CN.md).

## Starting Point

The repository contains README.md, AGENTS.md, and an Apache 2.0 license file. There is no application code, package manifest, build configuration, test suite, or commit history. These existing files are untracked at the time of exploration.

The README describes a monorepo distributed through Zed and VS Code extensions, with a local MCP server exposing code-quality and build inspection to agents and triggering inspections on save. This plan interprets `vsoe` as VS Code. The architecture and initial language scope below are recommendations, not requirements already specified by the README.

## Product Outcome and Scope

A developer saves a supported source file. Inspection runs without blocking the save, findings appear in the editor, and an agent can query the same current results or request another inspection through MCP. Fixing and saving the file clears resolved findings. Missing tools, failed execution, and outdated results are distinguishable from a successful clean inspection.

Recommended first release:

- Local filesystem workspaces on Windows, macOS, and Linux; one canonical workspace root per service instance.
- JavaScript/TypeScript lint inspection using the project's ESLint installation and configuration.
- TypeScript project checking, followed by explicitly configured build commands.
- Zed and VS Code diagnostics, save-triggered inspection, and manual execution.
- MCP tools for running inspections and reading findings and run status.
- A CLI usable independently of either editor.

Defer remote workspaces, browser extensions, arbitrary language coverage, automatic fixes, hosted services, persistent result history, custom dashboards, and autonomous agent invocation. MCP access lets agents consume inspection results; it does not by itself make an idle agent start a conversation after each save. That would require a separately specified host integration. MCP tools are invoked by clients/models. [S7]

## Research Findings

| Finding | Planning Consequence | Evidence |
| --- | --- | --- | --- |
| Zed supports language-server extensions; the inspected Extension trait has no general document-save callback. | Use an auxiliary LSP server for save events and diagnostics. Validate attachment alongside existing language servers before building the full adapter. The lack of a callback is an inference from the documented API surface. | [S1], [S2] |
| Zed plans to deprecate MCP server extensions in favor of the official MCP registry. | Keep the Zed extension for LSP integration. Distribute MCP through a standalone package and native MCP configuration/registry; do not build a new MCP-only extension wrapper. | [S3], [S4] |
| LSP defines client save notifications and a server capability requesting them. | Advertise save synchronization and use `textDocument/didSave` in both editors. File watching is not an equivalent editor-save hook. | [S5] |
| VS Code can register stdio MCP definitions from extensions. | Provide workspace-specific launch definitions through the supported provider API. | [S6] |
| The official TypeScript MCP SDK identifies v2 as its stable release line. | Start with v2 and its current package layout. Pin versions during implementation and test actual target clients; do not copy v1 examples or add custom legacy transports. | [S8] |
| ESLint returns structured lint results; TypeScript exposes compiler diagnostics through its API. | Normalize structured results instead of parsing human-oriented console output for these inspectors. | [S9], [S10] |
| Node supports local IPC with Windows named pipes and Unix domain sockets. | Use local IPC to share one scheduler and result store between editor and MCP processes without opening a TCP listener. | [S11] |
| VS Code exposes workspace-trust integration. | Disable executable inspection in untrusted workspaces; enforce equivalent explicit local trust for Zed and standalone use. | [S12] |

Research establishes API feasibility, not a tested integration. Installed-editor behavior, packaging, and cross-platform lifecycle remain implementation acceptance gates.

## Proposed Architecture

Use TypeScript for the inspection engine, runtime, CLI, MCP adapter, and VS Code extension. Keep Rust limited to the Zed extension's required launcher. Use npm workspaces initially: the repository has no existing dependency or package-manager convention requiring a more elaborate build system.

```text
VS Code extension -> LSP client ----+
                                   +-> LSP adapter --+
Zed extension -> LSP launch --------+                 |
                                                     v
CLI command ---------------------------------> Workspace service
                                                     ^
Agent host -> MCP stdio adapter ----------------------+
                                                     |
                                               Inspection engine
                                                     |
                                           Project tools / workers
```

Each LSP or MCP adapter owns its protocol connection. They communicate with the same workspace service through a small typed JSON-RPC interface. Reuse Microsoft's JSON-RPC/LSP packages for framing, request correlation, and cancellation; do not invent a wire format. [S13] MCP remains standard stdio externally; internal IPC is not a new MCP transport.

The service owns scheduling, run state, and the latest findings in memory. This ownership is needed because independently launched editor and agent processes must not run duplicate builds or disagree about the latest results. No database or disk result cache is needed for the first release.

Proposed module boundaries, created only when their phase needs them:

| Location | Responsibility |
| --- | --- |
| `packages/core` | Inspection contracts, normalization, scheduling rules, inspector implementations; no editor/protocol imports. |
| `packages/runtime` | Workspace service, IPC client, process lifecycle, CLI, and separate LSP/MCP adapter modules. |
| `extensions/vscode` | LSP startup, trust, commands, output channel, MCP definition provider. |
| `extensions/zed` | Rust/WASM manifest and LSP launcher for supported language identifiers. |
| `tests/fixtures` | Small broken/clean projects, configuration failures, slow and failing processes. |

Use the official MCP v2 SDK and its supported schema library, `vscode-languageserver`, `vscode-languageclient`, and their JSON-RPC support. Resolve supported project-local ESLint and TypeScript versions explicitly; report missing or unsupported versions with actionable errors. Do not install project dependencies automatically or silently substitute bundled tool versions. Lock runtime dependencies and declare supported editor/runtime minimums after the first integration check.

### Service Lifecycle

- Identify a workspace by its canonical filesystem path, respecting platform path semantics and symlinks. Reject paths escaping that root and unsupported URI schemes. Nested projects use explicit inspector working directories within the root.
- A connecting adapter starts the service only when no healthy owner exists. Use exclusive ownership and a startup handshake to handle simultaneous launches. Store discovery metadata in user-local application state, not repository files.
- Authenticate local connections with a per-instance secret stored with user-only access; protect Unix socket permissions and verify Windows pipe access behavior. Do not treat a predictable pipe name as authorization.
- Include the runtime build identity in the handshake. Reject incompatible peers with a restart/update instruction; do not create compatibility shims or concurrent services for the same root.
- Keep active-client leases. Exit after all clients disconnect and pending work finishes, with a bounded idle period. On timeout or shutdown, terminate inspector workers and descendant build processes.
- Recover from a crashed owner using a verified failed connection and ownership check. Never delete another live instance's endpoint based only on a stale PID.
- Standalone CLI and MCP calls can start the same service. Save-triggered operation requires an attached editor. Multi-root editor windows create one connection per root.

### Inspection and Result Contract

An inspector has an ID, supported scope, and an execution function accepting a validated request and cancellation signal. Start with concrete implementations; do not create a dynamic plugin system.

Each run records `runId`, workspace, inspector, scope, trigger, generation, start/end time, and outcome. Outcomes distinguish queued, running, completed, failed, cancelled, and superseded. A completed inspection may contain error findings; a failed inspector is an execution failure.

Each finding records inspector/source, rule or compiler code where available, severity, message, file URI and optional range, plus run provenance. Use zero-based UTF-16 positions internally for LSP alignment and normalize tool-specific positions at the boundary. Findings without file locations stay in the run summary.

- Debounce repeated saves and allow at most one execution per inspector/project scope. Merge queued file scopes; a pending project check covers its files.
- Track document changes to mark saved findings stale while a buffer is dirty. Run lint on saved content; TypeScript checks the containing configured project rather than pretending a single file is a project build.
- Assign generations before execution. New relevant changes invalidate in-flight results; outdated completion must not replace newer state. Label results by inspected generation rather than claiming an atomic snapshot of a concurrently changing project.
- Observe relevant external source/configuration changes to invalidate project state, with generated/dependency directories excluded. Such events invalidate results; editor save events remain the automatic trigger.
- Replace findings only for the completed inspector scope. A successful clean run clears that scope; a failed run retains previous findings explicitly marked stale. Clear deleted-file findings and remove them from editor diagnostics.
- Isolate project tool execution in workers/processes so timeouts are enforceable and tool failures cannot block protocol handling. Bound output, queue size, and retained completed-run metadata.

### MCP and Editor Surface

Expose three tools initially: `run_inspection` accepts configured inspector IDs and a bounded scope, returning a run ID; `get_run` returns progress/outcome; `get_findings` returns filtered, paginated findings and freshness metadata. Validate inputs and output schemas. Avoid arbitrary command strings, unrestricted filesystem tools, and mandatory optional MCP capabilities.

LSP publishes diagnostics belonging to this product and sends empty lists when findings resolve. Do not harvest other extensions' diagnostics and promise Zed parity. Offer manual run, cancel, and output/status access through supported editor mechanisms. Avoid separate VS Code save listeners when LSP already supplies the trigger.

Use one small declarative workspace configuration for inspector enablement, working directories, include/exclude scope, and build command executable/argument arrays. Reuse ESLint/TypeScript configuration for their own settings. Readable configuration is not execution permission: project plugins and build commands execute code. Keep trust grants outside the repository and invalidate execution authorization when executable configuration changes. The MCP client cannot grant trust through tool arguments.

For generic builds, report exit status and bounded logs first. Only attach file diagnostics when a supported structured reporter is configured; never infer success from empty output or fabricate source locations. Automatic builds must be explicitly enabled and serialized.

## Delivery Plan

Every phase leaves a usable product. The v0.1.0 implementation below covers the planned local runtime, editor integrations, and distributable artifacts.

| Phase | Deliverable | Acceptance Gate | v0.1.0 status |
| --- | --- | --- |
| 1. CLI inspection | Minimal workspace setup, result types, project-local ESLint runner, trust handling, human/JSON CLI output. | A fixture produces a known lint finding; a fix clears it; missing configuration and missing tool return execution errors; paths with spaces work on Windows. CLI exit codes distinguish clean, findings, and execution failure. | Complete: CLI, fixtures, trust/config hash, JSON output, and exit codes. |
| 2. Shared runtime and MCP | Workspace service, lifecycle, queue, in-memory results, stdio MCP adapter, the three tools. | Two clients attach to one owner, overlapping requests coalesce, a stale run cannot overwrite a newer one, cancellation stops work, crash/restart is recoverable, and MCP stdout contains protocol messages only. | Complete: authenticated local IPC, coalescing, generations, cancellation, stale-owner recovery, schemas, and `smoke:mcp`. |
| 3. Save integration in both editors | LSP adapter, VS Code dev extension and MCP provider, Zed dev extension and native MCP launch configuration. | In each editor, save a broken file, see diagnostics, query matching MCP results, fix/save, and see findings clear. Existing language servers keep working. Test multiple roots, dirty buffers, trust denial, and editor exit. | Complete: shared LSP save flow, VS Code multi-root/trust support, Zed launcher, and packaged LSP smoke. Zed UI testing remains an editor-host release check. |
| 4. Type and build inspection | TypeScript project diagnostics and explicitly configured build execution. | Cross-file type errors, project references, build failure without file locations, timeout, and process-tree cleanup are represented correctly. Rapid saves do not start parallel builds. | Complete: compiler API diagnostics, bounded build execution, timeout/cancellation, and build fixtures. |
| 5. Distribution | Versioned runtime package, VSIX, Zed extension packaging, MCP registry metadata, installation docs and CI. | Clean-machine installs on Windows/macOS/Linux pass the same save-to-MCP workflow without a development checkout. Packaged launch paths and declared minimum versions are verified. | Complete for local distribution: npm tarballs, self-contained VSIX, Zed WASM, CI, docs, `smoke:package`; public registry submission is external. |

Before investing in the complete Phase 3 adapter, run a focused Zed integration check: attach an auxiliary server to existing JavaScript/TypeScript languages, confirm `didSave`, verify diagnostic clearing, and confirm runtime acquisition and trust behavior. Retain useful integration fixtures. If a required capability is unavailable, document the exact limitation and revise the affected release scope; do not silently replace save events with a filesystem watcher.

## Verification and Release Criteria

- Test scheduler ordering, scope replacement, stale results, path confinement, and structured diagnostic mapping at the core boundary.
- Exercise real MCP and LSP clients against child processes; include disconnects, malformed input, startup races, cancellation, and protocol-output purity.
- Run execution fixtures with missing tools, thrown plugins, nonzero builds, oversized output, configuration changes, deleted files, and cross-file errors.
- Use automated VS Code extension checks and a recorded Zed dev-extension smoke procedure. Do not claim Zed UI coverage from server-only tests.
- Run CI on all three target operating systems, including paths with spaces/non-ASCII characters and symlink behavior where supported.
- Measure save-to-queue delay and inspection duration on a documented fixture. Target scheduling within 500 ms after the debounce window; report tool time separately. Measure idle CPU/memory and confirm no workers remain after shutdown.
- A release is ready only when both editor workflows and standalone MCP use the same current results, installation is reproducible, and all documented lifecycle/trust cases pass.

## Assumptions and Remaining Decisions

These items do not block the initial CLI phase. Resolve them before the dependent phase rather than spreading configuration for every possible answer.

| Item | Recommended Default | Resolve By |
| --- | --- | --- |
| Initial languages and inspections | JS/TS plus ESLint, then TypeScript and configured builds. | Phase 1 fixture selection. |
| Meaning of agent contact | Agent queries/runs through MCP; no unsolicited agent startup. | Before adding any agent automation requirement. |
| Supported editor/runtime versions | Current stable releases proven by integration tests; one supported dependency line. | Phase 3 integration check. |
| Zed executable trust and installation | Explicit local authorization; documented runtime package acquisition with pinned release. | Phase 3 integration check. |
| Duplicate diagnostics from existing linters | Product publishes only its own enabled inspectors; document disabling overlapping inspection sources. | Phase 3 UX check. |
| Public package IDs, publisher identities, registry ownership | Choose consistent available names; publication remains a separate release action. | Phase 5 packaging. |

Release follow-up: publish the generated artifacts to the intended npm, VS Code, Zed, and MCP registries after ownership and credentials are available. The repository remains usable directly from the local artifacts without a development checkout.

## Sources

Official documentation and upstream sources consulted on 2026-09-08:

- [S1: Zed language extensions](https://zed.dev/docs/extensions/languages)
- [S2: Zed Extension trait](https://docs.rs/zed_extension_api/latest/zed_extension_api/trait.Extension.html)
- [S3: Zed MCP extension deprecation notice](https://zed.dev/docs/extensions/mcp-extensions)
- [S4: Zed native MCP configuration](https://zed.dev/docs/ai/mcp)
- [S5: LSP didSave specification source](https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.17/textDocument/didSave.md)
- [S6: VS Code MCP developer guide](https://code.visualstudio.com/api/extension-guides/ai/mcp)
- [S7: MCP tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [S8: Official MCP TypeScript SDK and release guidance](https://github.com/modelcontextprotocol/typescript-sdk)
- [S9: ESLint Node.js API](https://eslint.org/docs/latest/integrate/nodejs-api)
- [S10: TypeScript compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)
- [S11: Node local IPC support](https://nodejs.org/api/net.html#ipc-support)
- [S12: VS Code workspace trust](https://code.visualstudio.com/api/extension-guides/workspace-trust)
- [S13: Microsoft LSP and JSON-RPC libraries](https://github.com/microsoft/vscode-languageserver-node)
