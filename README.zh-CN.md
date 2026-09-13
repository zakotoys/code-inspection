# Code Inspection

[English](README.md) | **简体中文** | [日本語](README.ja-JP.md)

Code Inspection 是一个本地、多入口共享的代码诊断服务。CLI、VS Code、Zed 和 MCP 都连接同一个工作区服务，因此同一份检查结果可以被编辑器、终端和 AI Agent 读取。

## 支持范围

| 语言 | 内置检查器 | 项目前提 |
| --- | --- | --- |
| JavaScript / TypeScript | ESLint、TypeScript Compiler API | 项目本地 `eslint`/`typescript` 和配置文件 |
| Python | Ruff、Pyright | `pyproject.toml`、`ruff.toml` 或 `pyrightconfig.json`，工具由用户安装 |
| Java | Checkstyle、PMD、Java 构建检查 | 优先使用仓库 `mvnw`/`gradlew`；也可配置显式命令 |
| Go | `go vet`、可选 `golangci-lint` | `go.mod` 或 `go.work` |
| Rust | `cargo check`、可选 `cargo clippy` | `Cargo.toml` |
| C / C++ | Clang 编译诊断、`clang-tidy` | `clang-tidy` 必须有 `compile_commands.json` |

通用 `command`/`build` 检查可执行任意显式命令，但不会被自动归入某种语言。项目不会自动安装工具、依赖或编译器；缺少工具返回 `missing-tool`，缺少项目配置返回 `missing-configuration`。

## 快速开始

在本仓库构建并安装本地包：

```sh
npm ci
npm run build
npm run package:core
npm run package:runtime
npm install --global ./artifacts/zakotoys-code-inspection-core-0.2.0.tgz ./artifacts/zakotoys-code-inspection-runtime-0.2.0.tgz
```

在待检查项目中：

```sh
code-inspection init
code-inspection trust .
code-inspection capabilities
code-inspection inspect --check eslint
code-inspection findings
```

`init` 生成 v2 配置，列出全部内置检查器，默认只启用 ESLint。它不会覆盖已有配置。启用其它检查器前先安装对应工具并审阅命令。

## CLI

```text
code-inspection init [--workspace <path>]
code-inspection trust|revoke [--workspace <path>]
code-inspection capabilities [--workspace <path>] [--json]
code-inspection projects [--workspace <path>] [--check <id>] [--language <id>] [--json]
code-inspection inspect [--workspace <path>] [--check <id>] [--language <id>] [--project <path>] [--file <path>] [--json] [--trust]
code-inspection findings [--workspace <path>] [--check <id>] [--json] [--include-stale]
code-inspection status [--workspace <path>]
code-inspection cancel --run-id <id> [--workspace <path>]
```

`--check` (`-i`) 接受配置中的动态检查 ID，可逗号分隔或重复传入；`--file` (`-f`) 最多 100 个。无文件运行项目级检查时，CLI 会先枚举嵌套项目再逐项执行。`inspect` 退出码：`0` 无 finding，`1` 有 finding，`2` 请求/执行失败，`3` 取消或被更新运行取代。

## v2 配置

`.code-inspection.json` 的顶层必须是 `version: 2` 和 `checks` 映射。v1 的 `inspectors` 结构会直接拒绝，不提供迁移或兼容回退。

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
    "ruff": {
      "adapter": "ruff",
      "enabled": true,
      "languages": ["python"],
      "scope": "file",
      "cwd": ".",
      "command": ["ruff", "check", "--output-format", "json"]
    },
    "cargo-check": {
      "adapter": "cargo-check",
      "enabled": true,
      "languages": ["rust"],
      "scope": "project",
      "cwd": "."
    }
  }
}
```

关键字段：

- `adapter` 必须是内置适配器：`eslint`、`typescript`、`ruff`、`pyright`、`go-vet`、`golangci-lint`、`cargo-check`、`cargo-clippy`、`checkstyle`、`pmd`、`java-build`、`clang-tidy`、`clang-build` 或 `command`。
- `languages` 可用 `javascript`、`typescript`、`python`、`java`、`go`、`rust`、`c`、`cpp`；省略时采用适配器默认值。`.h` 同时标记为 C 和 C++，可用显式语言或编译数据库消歧。
- `scope` 为 `file`、`project` 或 `workspace`，省略时采用适配器默认值。项目根按标志文件向上查找：`package.json`/`tsconfig.json`、Python 配置、`pom.xml`/Gradle、`go.mod`、`Cargo.toml`、CMake/编译数据库。
- `cwd`、`project` 和文件路径必须位于规范化工作区内；`command` 是可执行文件加参数的数组，不接受 shell 字符串。
- `parser` 可选：`text`、`build`、`ruff-json`、`pyright-json`、`go-json`、`golangci-json`、`rust-json`、`checkstyle-xml`、`pmd-json`、`sarif-json`、`clang-json`。
- `timeoutMs` 范围为 1000–600000；每个 stdout/stderr 流最多保留 200000 字符。所有位置统一为零基 UTF-16。
- `exclude` 和 `patterns` 使用 workspace-relative glob，在调用工具前及解析 finding 后都会生效；Java 可用 `options.reportFile` 指定 Checkstyle/PMD 报告路径。

## MCP

MCP 服务使用 stdio，日志只写 stderr。工具如下：

- `list_inspectors`：只读返回当前配置中的检查器、支持语言、作用域和项目标志。
- `list_projects`：只读枚举嵌套项目，可按检查器或语言过滤。
- `run_inspection`：传入 `workspace`、动态 `check_id`、可选 `language`、`project`、`files`，立即返回 `runId`。
- `get_run`：读取运行状态、摘要、错误、finding 和 stale 信息。
- `get_findings`：按检查器、语言、项目或文件分页读取规范化结果。

MCP 不能授予信任。先执行 `code-inspection trust <workspace>`，然后调用 `list_inspectors` 发现可用 ID。运行键为 `checkId + projectRoot + scope`，同键请求合并，旧结果不会覆盖新结果。

服务全局最多同时运行两个检查，构建资源组默认串行；打包运行时每次检查在独立 worker 中执行。超时是 `failed` 运行并带 `timeout` 错误码，不会伪装成 finding。

## 编辑器

VS Code 扩展的 document selector 覆盖 JavaScript、TypeScript、Python、Java、Go、Rust、C、C++，并按工作区启动独立 LSP 客户端。Zed 扩展提供相同语言集合的 Rust/WASM 启动器；工具链仍由本机 PATH 和项目配置提供。原生语言服务器继续运行，本项目只发布 `code-inspection/<check>` 来源的诊断。

```sh
npm run package:vscode
code --install-extension artifacts/code-inspection-vscode-0.2.0.vsix
```

## 原理和架构

```text
CLI / VS Code / Zed / MCP
            │  LSP/MCP stdio + authenticated local IPC
            ▼
       Workspace Service
        ├─ Language Catalog
        ├─ Project Locator
        ├─ Inspector Registry
        ├─ Scheduler / stale generation
        └─ Tool Runner → parser → normalized Finding
```

适配器只负责调用工具，parser 负责 JSON/XML/SARIF/编译器文本，服务统一处理信任、排队、取消、超时、结果替换和保存触发。工具执行使用 `shell: false`、参数数组和进程组清理；信任是执行前置条件，不是安全沙箱。

## 开发与验证

```sh
npm run check
node scripts/smoke-lsp.mjs
node scripts/smoke-mcp.mjs
npm run smoke:languages
npm run package:core
npm run package:runtime
npm run smoke:package
```

`tests/fixtures` 包含八类语言的 clean/broken 项目以及 parser golden 测试。`smoke:languages` 会运行所有语言的 CLI；CI 以 `STRICT_LANGUAGE_SMOKE=1 LANGUAGE_SMOKE_PROTOCOLS=1` 强制工具矩阵和 MCP/LSP 保存流程。完整打包还需要 `wasm32-wasip2` Rust target。

详细设计和验收标准见[多语言代码检查扩展计划](docs/plan/multilingual-inspection-expansion.zh-CN.md)。

## License

[Apache-2.0](LICENSE)
