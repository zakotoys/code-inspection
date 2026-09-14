# Code Inspection

[English](README.md) | **简体中文** | [日本語](README.ja-JP.md)

由编辑器、终端和 AI Agent 共享的本地多语言代码检查服务。它使用项目本地的分析工具检查 JavaScript/TypeScript、Python、Java、Go、Rust、C 和 C++，再通过 CLI、模型上下文协议（MCP）或语言服务器协议（LSP）提供一套规范化的检查结果。

## 功能

| 能力 | 行为 |
| --- | --- |
| JavaScript/TypeScript | 使用 ESLint 和 TypeScript Compiler API 诊断。使用项目本地的软件包和 `tsconfig.json`，不会生成文件。 |
| Python | 使用 Ruff JSON 诊断，以及可选的 Pyright JSON 诊断。 |
| Java | 通过 Maven 或 Gradle Wrapper 运行 Checkstyle/PMD，也支持显式配置 Java 构建命令。 |
| Go | 使用 `go vet` JSON 诊断，以及可选的 `golangci-lint`。 |
| Rust | 使用 `cargo check`，以及可选的 `cargo clippy` Cargo JSON 诊断。 |
| C/C++ | 使用 Clang/clang-tidy 诊断；clang-tidy 需要 `compile_commands.json` 编译数据库。 |
| 构建 | 可执行任意已配置的“可执行文件/参数”数组，并支持工作目录、环境变量、超时、输出上限和进程组取消。 |
| 共享服务 | CLI、LSP 和 MCP 按规范化工作区根目录连接同一个服务，并使用经过身份验证的本地 IPC：Windows 命名管道或 Unix socket。 |
| 保存时检查 | LSP 保存事件只会排队执行与文件语言/项目匹配且已启用的检查。保存事件会防抖，同一项目的请求会合并，已被取代的运行不能覆盖较新的结果。 |
| 检查结果与时效性 | 检查结果包含来源、代码、严重级别、可选的文件/范围、运行 ID 和 generation。编辑和检测到的文件系统变更会使结果失效；成功的检查会替换其作用域内的结果。 |
| CLI | 初始化配置、授予/撤销信任、执行检查、查询检查结果/状态，以及取消运行。检查输出支持便于阅读的文本或 JSON，并提供有意义的退出码。 |
| MCP | 动态发现能力，并提供排队检查、读取运行状态和分页查询检查结果的工具。支持结构化 JSON 或 Markdown；stdout 只输出协议数据。 |
| VS Code | 内置运行时、诊断、多工作区文件夹、手动运行/取消、输出通道、工作区信任和 MCP 定义。 |
| Zed | 面向已安装 LSP 可执行文件的 Rust/WASM 启动器，并挂接到所有支持的语言。原生 MCP 配置需单独完成。 |
| 分发 | Core/runtime npm tarball、自包含 VSIX、Zed WASM，以及自动化的构建、测试、协议和打包检查。 |

## 环境要求

- Core/runtime manifest 声明支持 Node.js `>=18.20`。开发和 CI 使用 Node.js 24；项目中安装的工具可能要求高于运行时最低版本的 Node。
- 请自行安装每项已启用检查使用的分析工具：ESLint/TypeScript、Ruff/Pyright、JDK（以及需要时的 Maven/Gradle）、Go、Rust/Cargo 和 Clang。运行时不会下载工具。
- VS Code 扩展要求 VS Code `1.103.0` 或更高版本。
- 只有构建 Zed 扩展时才需要 Rust 和 `wasm32-wasip2` target。

检查过程绝不会自动安装项目依赖，也不会用内置的 lint/compiler 工具替换项目工具。

## 快速开始

从 npm 安装运行时。它提供 CLI、MCP 和 LSP 可执行文件，并自动安装 core 依赖：

```sh
npm install --global @zakotoys/code-inspection-runtime
```

切换到要检查的项目；该项目应已安装 ESLint 依赖并具有 ESLint 配置：

```sh
cd /path/to/your-project
code-inspection init
code-inspection trust .
code-inspection inspect --check eslint
code-inspection findings
```

`init` 会创建版本为 2 的 `.code-inspection.json`，其中列出所有内置检查；默认启用 ESLint，禁用其他检查。它会拒绝覆盖已有文件。只有在安装相应工具并审阅其命令后，才应启用该检查。

如果要嵌入与协议无关的检查引擎，而不是使用运行时可执行文件，请将 `@zakotoys/code-inspection-core` 安装为项目依赖。

## CLI 参考

| 命令 | 用途 |
| --- | --- |
| `init` | 创建配置。 |
| `trust` / `revoke` | 添加/移除本地执行信任记录。 |
| `inspect` | 运行选定的动态检查 ID 并等待完成；默认运行所有已启用检查。项目级检查会先枚举嵌套项目再运行。 |
| `findings` | 最多读取 500 条检查结果；`--include-stale` 会包含已过期结果。 |
| `capabilities` | 列出已配置检查、支持的语言、作用域和项目标志文件。 |
| `projects` | 列出为某个检查或语言发现的嵌套项目。 |
| `status` | 输出 JSON，其中包含信任状态、活动/最近运行和检查结果数量。 |
| `cancel --run-id <id>` | 取消已排队或正在执行的运行。 |
| `help` / `--version` | 显示用法/版本。 |

命令默认使用当前目录。使用 `--workspace`（`-w`）或位置参数选择其他根目录。包含空格的路径需要加引号。

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

`--check`（`-i`）接受逗号分隔的动态 ID，也可以重复指定；`--file`（`-f`）可以重复指定，每次请求最多 100 个文件。即使提供了文件，项目级检查仍会检查其所属的已发现项目。`inspect --trust` 会持久化信任授权。已禁用的检查会跳过并发出警告。

| `inspect` 退出码 | 含义 |
| --- | --- |
| `0` | 已执行的运行没有检查结果；如果所有选定检查都被跳过，也返回此退出码。 |
| `1` | 存在检查结果，包括警告或构建命令非零退出。 |
| `2` | 执行/请求失败，例如缺少工具或未授予信任。 |
| `3` | 已取消或已被取代。 |

## 配置

`.code-inspection.json` 是可选文件；没有该文件时，默认启用 ESLint 检查，禁用 TypeScript/build 检查。每项检查都是一个注册表 ID，映射到适配器、语言集合、作用域和可选工具命令：

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

| 设置 | 默认值和行为 |
| --- | --- |
| `version` | `2`；拒绝 v1 `inspectors` 配置。拒绝未知键。 |
| `debounceMs` | `300`；保存调度延迟，范围为 `0`–`10000` 毫秒。 |
| `maxFindings` | `2000`；每次检查的输出上限，范围为 `1`–`10000`。摘要按保留的检查结果计数。 |
| `checks.<id>.adapter` | 必填的内置适配器：`eslint`、`typescript`、`ruff`、`pyright`、`go-vet`、`golangci-lint`、`cargo-check`、`cargo-clippy`、`checkstyle`、`pmd`、`java-build`、`clang-tidy`、`clang-build` 或 `command`。 |
| `checks.<id>.languages` | 语言 ID：`javascript`、`typescript`、`python`、`java`、`go`、`rust`、`c`、`cpp`。省略时使用适配器默认值；空列表可用于工作区命令。`.h` 会同时归类为 C 和 C++。 |
| `checks.<id>.scope` | `file`、`project` 或 `workspace`；默认为适配器的作用域。项目根目录通过语言标志文件发现。 |
| `checks.<id>.cwd` | `.`；相对于工作区的执行/工具解析目录。路径不能离开工作区。 |
| `checks.<id>.command` | 可执行文件加参数组成的数组，绝不是 shell 表达式。`command` 和显式构建适配器必须配置此项。 |
| `checks.<id>.parser` | `text`、`build`、`ruff-json`、`pyright-json`、`go-json`、`golangci-json`、`rust-json`、`checkstyle-xml`、`pmd-json`、`sarif-json` 或 `clang-json`。 |
| `checks.<id>.timeoutMs` / `env` | 外部工具的超时时间为 `1000`–`600000` 毫秒，并可覆盖环境变量。每个 stdout/stderr 流最多保留 200,000 个字符。 |
| `checks.<id>.exclude` / `patterns` | 在调用前和解析后的每条检查结果上应用相对于工作区的 minimatch glob。无效 glob 会被拒绝。 |
| `checks.<id>.options.reportFile` | 可选的 Java Checkstyle/PMD 报告路径，相对于检测到的项目根目录。命令日志之前会先解析报告。 |

构建日志的每个 stdout/stderr 流最多保留 200,000 个字符。构建检查结果不会伪造文件位置；请通过 CLI JSON 或 MCP 读取日志和退出状态。

## 信任、生命周期与时效性

项目插件、配置和构建命令可能执行本地代码。请先审阅工作区再授予信任；MCP 不能授予信任。信任信息存储在仓库外部，并绑定到 `.code-inspection.json` 的精确内容。创建或修改该文件后，需要再次运行 `code-inspection trust .`。该哈希并不覆盖每项依赖或工具配置。

服务按需启动；没有客户端且没有活动运行时，通常会在 30 秒后退出。检查结果/运行历史保存在内存中，服务重启后会消失。全局调度器最多允许两个活动运行；构建/资源组可以设置更低的限制。打包版本中的每次运行都在隔离 worker 中执行，并具有硬超时和后代进程清理。超时会成为错误码为 `timeout` 的失败运行，而不是一条检查结果。文件系统事件会使结果失效；自动执行则需要编辑器保存通知。

| 环境变量 | 用途 |
| --- | --- |
| `CODE_INSPECTION_DATA_DIR` | 覆盖信任/服务发现数据的存储目录。默认使用 Windows 的本地应用数据目录、macOS 的 Application Support 或 Linux 的 XDG state。 |
| `CODE_INSPECTION_IDLE_TIMEOUT_MS` | 覆盖默认的 `30000` 毫秒空闲超时。 |
| `CODE_INSPECTION_WORKER_PATH` | 覆盖打包 worker bundle 的路径，用于嵌入和发布测试。 |

## MCP 集成

将已安装的可执行文件用作本地 stdio 服务：

```json
{
  "command": "code-inspection-mcp",
  "args": []
}
```

请按客户端要求的格式，将此对象放入其服务器配置。如果客户端支持，请将进程工作目录设置为工作区；否则应在每次工具调用中传入绝对 `workspace`。默认值是服务器进程的工作目录。一个 MCP 进程可以连接多个受信任的根目录。日志写入 stderr。

| 工具 | 输入和结果 |
| --- | --- |
| `list_inspectors` | 只读的动态列表，包含已配置检查和所有支持的语言 ID。 |
| `list_projects` | 只读的嵌套项目发现，可按检查或语言筛选。 |
| `run_inspection` | 必填动态 `check_id`；可选 `language`、`project` 和 `files`（最多 100 个）。立即返回包含 `runId` 的运行记录。 |
| `get_run` | 必填 `run_id`。返回运行状态、摘要/错误、检查结果和时效性元数据。 |
| `get_findings` | 可选 `check_id`、`language`、`project`、`file`、`offset`（默认 `0`）、`limit`（默认 `50`，最大 `500`）、`include_stale`（默认 `false`）。返回一页结果和最近的运行。只要 `hasMore` 为 true，就继续使用 `nextOffset` 翻页。 |

所有工具都接受 `workspace` 和 `response_format`（默认为 `json`，也可设为 `markdown`），并以相应格式返回结构化内容。

1. 调用 `list_inspectors` 并选择一个已启用的检查。
2. 使用 `{"workspace":"/path/to/project","check_id":"eslint"}` 调用 `run_inspection`。
3. 对同一工作区调用 `get_run`，将返回的 `runId` 作为 `run_id` 传入。
4. 轮询直到状态变为 `completed`、`failed`、`cancelled` 或 `superseded`；`queued` 和 `running` 不是终态。
5. 读取 `get_findings` 并检查时效性。已完成的运行仍可能包含错误。失败运行会将之前的检查结果保留为过期状态，默认隐藏这些结果。

MCP 不提供取消/信任工具；请使用 CLI。检查结果范围采用从零开始的 UTF-16 位置；CLI/Markdown 显示的位置从一开始。

## 编辑器

### VS Code

执行 `npm ci` 和 `npm run build` 后：

```sh
npm run package:vscode
code --install-extension artifacts/code-inspection-vscode-0.2.2.vsix
```

打开本地工作区并授予 Workspace Trust。扩展会启动内置 LSP、授予相应的本地信任记录，并为每个工作区文件夹提供内置 MCP 定义。保存支持的 JavaScript、TypeScript、Python、Java、Go、Rust、C 或 C++ 文件即可执行检查；修复并保存后，会清除已解决的诊断。未受信任的编辑器会话不会执行 LSP 检查，也不会提供 MCP 定义。

| 命令/设置 | 用途 |
| --- | --- |
| `Code Inspection: Run` | 请求在活动工作区运行已配置的默认检查。 |
| `Code Inspection: Cancel Last Run` | 请求取消最近一次手动启动的运行。 |
| `codeInspection.defaultCheck` | 动态配置的检查 ID，默认为 `eslint`。 |
| `codeInspection.runtimePath` | 可选的外部 LSP 可执行文件；留空时使用内置版本。它不会替换内置 MCP 可执行文件。 |

**Code Inspection** 输出通道包含启动器/手动命令消息。其他扩展可能发布重叠的诊断。

### Zed

安装上述 runtime tarball，确保 Zed 的 PATH 中包含 `code-inspection-lsp`，并通过 CLI 信任工作区。将 `extensions/zed` 安装为开发扩展。[Zed 指南](extensions/zed/README.md)包含语言服务器/原生 MCP 设置。如果宿主进程的工作目录不同，请在 MCP 调用中传入 `workspace`。

该扩展会启动已安装的运行时，不会自行下载。服务器冒烟测试不能验证完整的 Zed UI 工作流；使用已安装编辑器进行检查仍是手动发布步骤。

## Monorepo 与开发

```text
CLI ----------------------+
MCP stdio ----------------+--> 工作区服务 --> 语言适配器/工具
VS Code / Zed --> LSP -----+    共享调度和内存检查结果
```

| 路径 | 职责 |
| --- | --- |
| [packages/core](packages/core) | `@zakotoys/code-inspection-core`：语言目录、项目发现、配置/信任、注册表、工具运行器、parser 和适配器；不依赖编辑器/MCP。 |
| [packages/runtime](packages/runtime) | `@zakotoys/code-inspection-runtime`：CLI、IPC、服务、MCP、LSP。 |
| [extensions/vscode](extensions/vscode) | VS Code 客户端、命令、信任和 MCP provider。 |
| [extensions/zed](extensions/zed) | Rust/WASM 启动器和 manifest。 |
| [tests/fixtures](tests/fixtures) | 每种支持语言的正常/错误 fixture 和工具输出。 |
| [scripts](scripts) | 打包和进程级冒烟检查。 |
| [.github/workflows/ci.yml](.github/workflows/ci.yml) | 在 Windows/macOS/Linux 上执行 Node 24 检查，并运行固定版本的 Ubuntu 语言工具矩阵和编辑器打包。 |
| [.github/workflows/release.yml](.github/workflows/release.yml) | 由 tag 触发的 npm 发布与 GitHub Release 创建。 |

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

`check` 会构建 npm workspace 并运行测试。`smoke:languages` 会对所有支持语言运行正常/错误 CLI 检查，并探测外部工具矩阵；在 CI 中设置 `STRICT_LANGUAGE_SMOKE=1` 和 `LANGUAGE_SMOKE_PROTOCOLS=1`，会要求所有工具及 MCP/LSP 流程全部通过。协议冒烟检查使用真实子进程。软件包冒烟检查会将本地 tarball 安装到临时 consumer 中，并检查信任、共享检查结果、含空格路径和空闲关闭行为。

构建全部分发产物：

```sh
rustup target add wasm32-wasip2
npm run package
```

`artifacts/` 中会生成：`zakotoys-code-inspection-core-0.2.2.tgz`、`zakotoys-code-inspection-runtime-0.2.2.tgz`、`code-inspection-vscode-0.2.2.vsix` 和 `code-inspection-zed-0.2.2.wasm`。单独执行 core/runtime/VS Code 打包命令前必须已有构建结果；`package:zed` 会自行运行 Cargo。

发布前运行 `npm run version:set -- X.Y.Z` 即可同步全部发布元数据。该命令会更新 npm workspace 版本与 lockfile、runtime 对 core 的依赖、VS Code 和 Zed 版本、运行时版本常量，以及三份 README 中包含版本号的产物示例。

维护者应在对应的 `main` 提交通过 CI 后推送 `vX.Y.Z` tag。**Publish release** 工作流会校验 tag 与 npm workspace、runtime 依赖、Cargo、Zed 和运行时版本是否一致，再次执行测试和协议冒烟检查，构建四个产物，包含 npm provenance 地先发布 core 再发布 runtime，并使用 `softprops/action-gh-release` 创建 GitHub Release。稳定版本使用 npm `latest` tag，预发布版本使用 `next`。Release 包含两个 npm tarball、VSIX、Zed WASM 和 `SHA256SUMS`。npm 发布使用 GitHub OIDC Trusted Publishing；只有在首次创建尚不存在的软件包时才需要仓库级 `NPM_TOKEN`。

## 故障排查与范围

| 现象 | 检查项 |
| --- | --- |
| 修改配置后变为不受信任 | 审阅文件并重新授予信任。 |
| `missing-tool` / `unsupported-tool` | 检查 `cwd` 下的项目依赖解析、公开 API 和 Node 版本要求。 |
| `missing-configuration` | 检查分析工具的项目配置，例如 `tsconfig.json`、`pyproject.toml`、Java Wrapper 或 C/C++ 编译数据库。 |
| 检查结果为空 | 检查 `status`、检查器是否启用、过期结果筛选和服务重启。结果为空本身不能证明检查成功。 |
| 构建失败但没有源码诊断 | 构建检查结果属于工作区级别；请读取运行 JSON/MCP 输出。 |
| 服务握手被拒绝 | 确保 CLI/编辑器运行时版本一致，并在更新后重启旧客户端/服务。 |

范围：本地文件系统工作区，以及 JavaScript/TypeScript、Python、Java、Go、Rust、C 和 C++ 的规范化诊断。不提供自动修复、持久化历史、远程/浏览器工作区或任意语言插件加载。外部工具使用 `shell: false` 运行，并设有输出上限、超时、取消机制，以及平台允许时的进程树清理。

[架构与交付计划](docs/plan/code-inspection-architecture-and-delivery.md)记录了最初的研究和验收标准。[多语言扩展计划](docs/plan/multilingual-inspection-expansion.zh-CN.md)记录了 v0.2.0 的语言和工具架构。

## 许可证

[Apache-2.0](LICENSE)
