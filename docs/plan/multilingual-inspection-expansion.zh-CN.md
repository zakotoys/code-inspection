# 多语言代码检查扩展计划

计划日期：2026-09-13
最后验证：2026-09-14
状态：v0.2.0 代码实现及全部技术门禁已完成；仅剩发布签核
目标版本：v0.2.0
前置版本：v0.1.0

实现状态：阶段 0–6 的代码路径已经落地，包括八种语言目录、v2 配置/协议、注册表、项目发现、Tool Runner、结构化解析器、内置检查器、项目级调度、递归 watcher、worker 隔离、动态 IPC/MCP/LSP/CLI、编辑器语言选择器、CI 工具矩阵和发布 smoke。本机代码、固定工具矩阵、生命周期/压力回归、打包、VS Code/Zed 八语言宿主门禁以及远端 Windows/macOS/Linux CI 均已通过；远端验收证据为 [GitHub Actions run 34773982868](https://github.com/zakotoys/code-inspection/actions/runs/34773982868)。

## 1. 目标

将当前只面向 JavaScript/TypeScript 的代码检查服务扩展为覆盖以下语言的统一诊断平台：

- JavaScript、TypeScript
- Python
- Java
- Go
- Rust
- C、C++

扩展后，CLI、VS Code、Zed 和 MCP 仍然读取同一个工作区服务中的结果。语言、检查器、项目边界和工具链由注册表驱动，不再在调度器和协议层写死。

本计划关注诊断检查，不把格式化、自动修复或完整语言服务器功能混入第一版多语言范围。

## 2. 当前基线和必须移除的硬编码

v0.1.0 已经具备以下可复用基础：

- 每个规范化工作区一个按需启动的本地服务；
- Unix socket/Windows named pipe、JSON-RPC 和服务内存中的共享结果集；
- ESLint、TypeScript Compiler API 和通用 build 检查；
- 保存防抖、运行合并、generation、stale 结果和取消；
- CLI、LSP、MCP、VS Code 和 Zed 适配器。

多语言扩展前必须删除以下固定假设：

| 位置 | 当前假设 | v0.2.0 改造 |
| --- | --- | --- |
| `packages/core/src/types.ts` | `InspectorId` 只有三个字面量 | 改为注册表校验的 `CheckId` 和 `LanguageId` |
| `packages/core/src/config.ts` | `inspectors` 是固定对象 | 使用新的 `version: 2` `checks` 映射 |
| `packages/core/src/engine.ts` | `if/else` 分派三个检查器 | 拆成 adapter、tool runner 和 parser |
| `packages/runtime/src/service.ts` | active/findings 只按 inspector 维护 | 按检查器、项目和范围维护 |
| `packages/runtime/src/protocol.ts`、`mcp.ts`、`cli.ts` | 输入校验固定枚举 | 从 Inspector Registry 动态验证 |
| `packages/runtime/src/lsp.ts` | 只根据 JS/TS 保存触发 | 根据 Language Catalog 和项目定位触发 |
| VS Code/Zed 扩展 | 只注册 JS/TS 语言 ID | 注册全部目标语言并保持与原生语言服务器并存 |

旧的 v1 配置和 v1 服务协议在升级后直接拒绝，不增加兼容分支、迁移层或静默回退。`init` 只生成 v2 配置。

## 3. 目标架构

```text
VS Code / Zed ── LSP stdio ──┐
CLI ─────────────────────────┼── Workspace Service
AI Agent ── MCP stdio ───────┘       │
                                    ├─ Language Catalog
                                    ├─ Project Locator
                                    ├─ Inspector Registry
                                    ├─ Scheduler / Freshness
                                    └─ Tool Runner + Parsers
                                         ├─ ESLint / TypeScript
                                         ├─ Ruff / Pyright
                                         ├─ Maven / Gradle
                                         ├─ go vet / golangci-lint
                                         ├─ cargo check / clippy
                                         └─ clang / clang-tidy
```

外部传输形态保持不变：LSP 和 MCP 各自使用 stdio；适配器通过认证的本地 IPC 连接工作区服务。工作区内部服务协议会升级到 v2。检查器不直接向编辑器或 MCP 输出结果。

## 4. 核心模型和模块边界

### 4.1 Language Catalog

新增统一的语言目录，每个定义至少包含：

- 稳定的 `languageId`；
- 扩展名列表；
- VS Code language ID；
- Zed language ID；
- 文件是否可作为保存触发源。

初始目录：

| `languageId` | 扩展名 |
| --- | --- |
| `javascript` | `.js`、`.jsx`、`.mjs`、`.cjs` |
| `typescript` | `.ts`、`.tsx`、`.mts`、`.cts` |
| `python` | `.py`、`.pyi` |
| `java` | `.java` |
| `go` | `.go` |
| `rust` | `.rs` |
| `c` | `.c`、`.h`* |
| `cpp` | `.cc`、`.cpp`、`.cxx`、`.hh`、`.hpp`、`.hxx`、`.h`* |

`*` `.h` 同时是 C/C++ 候选；其归属优先由编译数据库或显式配置决定，不能只依赖扩展名。

### 4.2 Inspector Registry

每个内置检查器注册：

- `id` 和显示名称；
- 支持的语言；
- 范围：`file`、`project` 或 `workspace`；
- 项目定位器；
- 工具解析器；
- 是否支持文件范围、取消和超时。

注册表是代码内置的，配置只能启用已注册的 adapter/parser。第一版不允许从工作区动态加载任意 JavaScript 插件。

### 4.3 Project Locator

新增 `ProjectContext`，把工作区根、项目根、语言和项目配置路径传给检查器。一个工作区可以包含多个项目，调度器不再假设一个工作区只有一份工具配置。

项目标志：

| 语言 | 优先查找的项目标志 |
| --- | --- |
| JavaScript/TypeScript | `package.json`、`tsconfig.json` |
| Python | `pyproject.toml`、`ruff.toml`、`pyrightconfig.json` |
| Java | `pom.xml`、`build.gradle`、`build.gradle.kts`、`mvnw`、`gradlew` |
| Go | `go.mod`、`go.work` |
| Rust | `Cargo.toml` |
| C/C++ | `compile_commands.json` 或 CMake 构建目录 |

无法确定必要项目配置时返回 `missing-configuration`，不猜测 include path、classpath、module root 或虚拟环境。

### 4.4 Tool Runner 和 Diagnostic Parser

把命令执行和结果解析分开：

- `ToolRunner` 负责可执行文件解析、参数数组、cwd、环境变量、超时、取消、输出上限和进程树清理；
- `DiagnosticParser` 把 JSON、SARIF、XML 或编译器文本转换成统一的 raw diagnostic；
- mapper 再把 raw diagnostic 转成 `Finding`。

解析器不得用脆弱的单一正则替代结构化解析。需要 XML/YAML 时使用维护中的解析库，并为每个工具保存 golden fixtures。

所有最终位置统一为零基 UTF-16。Rust 的 byte offset、Go/Java/Clang 的行列、SARIF/XML 的一基位置都必须在边界转换；非 ASCII 文件要有专门测试。

## 5. 语言和工具范围

| 语言 | 第一批检查器 | 项目/工具前提 | 结果格式 |
| --- | --- | --- | --- |
| JavaScript/TypeScript | ESLint、TypeScript Compiler API | 项目本地依赖和配置 | 原生 API |
| Python | Ruff、Pyright | `pyproject.toml` 等；项目已有 venv/uv 环境 | JSON |
| Java | Checkstyle、PMD、Maven/Gradle 编译检查 | 优先使用 `mvnw`/`gradlew` | XML、JSON、编译输出 |
| Go | `go vet`，可选 `golangci-lint` | `go.mod`/`go.work` | JSON/SARIF |
| Rust | `cargo check`，可选 `cargo clippy` | `Cargo.toml` | Cargo JSON |
| C/C++ | `clang-tidy`、Clang 编译诊断 | `clang-tidy` 要求 `compile_commands.json`；`clang-build` 要求配置提供显式 `command` | JSON/诊断输出 |

通用 `build` 检查器继续存在，但它是工作区构建检查，不计作某种语言的专用诊断器。

第一批不包含 `gofmt`、`rustfmt`、`clang-format` 等格式化动作，也不自动安装任何工具。工具缺失必须明确返回 `missing-tool`。

## 6. v2 配置

建议使用动态 `checks` 映射，检查器 ID 由注册表校验：

```json
{
  "version": 2,
  "debounceMs": 300,
  "maxFindings": 5000,
  "checks": {
    "eslint": {
      "adapter": "eslint",
      "enabled": true,
      "languages": ["javascript", "typescript"],
      "cwd": "."
    },
    "ruff": {
      "adapter": "ruff",
      "enabled": true,
      "languages": ["python"],
      "scope": "file",
      "cwd": "."
    },
    "pyright": {
      "adapter": "pyright",
      "enabled": true,
      "languages": ["python"],
      "scope": "project",
      "cwd": "."
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

配置规则：

- `adapter`、`parser`、`languages` 和 `scope` 必须通过注册表校验；
- `cwd` 必须位于规范化工作区内；
- 项目级检查可以声明项目配置路径或使用 Project Locator 自动发现；
- 工作区级 build 检查的 `languages` 可以为空，但必须显式启用；
- 配置中的命令仍然是可执行文件加参数数组，不接受 shell 表达式；`clang-build` 没有默认构建命令，必须显式提供 `command`；`java-build` 按项目标志选择 Maven/Gradle wrapper 或工具，也可以用 `command` 覆盖；
- v1 的 `inspectors` 结构、未知字段和未知 adapter 直接报配置错误；
- 配置内容变化会使现有 trust 失效。

## 7. 调度、结果和保存流程

将当前的 `active: Map<InspectorId, ...>` 改为按以下执行键管理：

```text
executionKey = checkId + projectRoot + scopeKind
```

调度规则：

- 文件保存只触发与该文件语言和项目相关的启用检查器；
- 文件级检查可以使用保存文件范围；
- TypeScript、Pyright、Go、Rust、Java 和多数 C/C++ 检查是项目级，多个保存请求合并为一次项目检查；
- 同一 execution key 不并发执行；全局并发数有上限；构建类检查使用独立资源组；
- 新文件变化递增对应项目 generation，并让旧运行 superseded；
- 过期运行不能替换新结果；
- 成功运行只替换自己的检查器/项目范围；
- 失败运行保留旧 finding，但标记为 stale；
- 删除文件会清除其 finding；
- 手动全量运行先枚举项目，再按资源组排队。

`Finding` 至少增加 `language`、`checkId` 和 `projectRoot`，保留 `runId`、`generation`、`source`、`code`、严重级别和统一位置。无文件位置的构建错误继续保留在运行摘要和工作区级 finding 中。

## 8. 协议和编辑器改造

### 服务协议

- 服务协议升级为 v2，服务身份同步升级；
- `runInspection` 接受动态 `checkId`，可选 `language`、`project` 和文件范围；
- `getFindings` 返回语言、项目和工具来源；
- 运行快照继续提供 outcome、summary、generation、dirty 文件和 stale 状态。

### MCP

保留 `run_inspection`、`get_run`、`get_findings` 三个核心工具，但去掉固定 inspector 枚举，由服务注册表验证。增加只读的 `list_inspectors`，让 Agent 能发现当前配置的检查器和语言能力；CLI 的 `capabilities` 命令暴露同一份信息。MCP 仍不能授予工作区信任。

### LSP、VS Code 和 Zed

- LSP 使用 Language Catalog 扩展保存触发和诊断发布；
- VS Code `documentSelector` 增加 Python、Java、Go、Rust、C、C++；
- Zed manifest 增加对应语言，Rust/WASM 启动器保持通用；
- 现有原生语言服务器继续运行，本项目只发布自己的诊断；
- LSP 仍然只负责诊断和保存事件，不实现补全、跳转或类型信息服务。

### CLI

`inspect -i`、`status` 和 JSON 输出改为读取动态注册表。增加查看可用检查器/语言的命令，避免用户必须手写工具 ID。

## 9. 信任、进程和跨平台要求

多语言工具会执行 Python 插件、Java 构建插件、Cargo build script、Go 工具和 C/C++ 编译命令，因此现有 trust 机制必须继续是执行前置条件，并覆盖 v2 配置中的完整命令定义。

实现要求：

- 所有外部命令使用 `shell: false` 和参数数组；
- 新增工具统一通过子进程/worker 执行，避免阻塞服务；
- Unix 使用进程组终止，Windows 清理整个进程树；
- stdout/stderr、队列长度、运行历史和全局并发均有上限；
- 不把 trust 当成安全沙箱，不自动安装依赖；
- 保持工作区路径、符号链接、非 ASCII 路径和 Windows 路径测试；
- 工具版本探测失败、工具缺失、配置缺失、解析失败和命令非零退出分别使用不同错误码。

Runtime 默认在独立 `worker_threads` 中执行每次检查，并对 worker 施加硬超时和取消；仅 source/test 环境在缺少编译后的 worker bundle 时允许受限的进程内 fallback。打包运行时缺少 worker bundle 会返回 `worker-unavailable`，不会静默降级。外部工具仍统一经过 `ToolRunner`，因此不会阻塞服务主线程。

## 10. 分阶段交付

每个阶段都必须留下可运行的产品，不把所有语言堆到最后一次合并。

| 阶段 | 主要工作 | 退出条件 | 当前状态 |
| --- | --- | --- | --- |
| 0. 注册表和 v2 基础 | Language Catalog、Inspector Registry、ProjectContext、配置 v2、协议 v2；拆分现有 engine；更新 CLI/MCP/LSP 类型 | 现有 ESLint/TypeScript/build 的 CLI、LSP、MCP 流程全部通过；v1 明确拒绝 | 已完成 |
| 1. 通用命令层 | Tool Runner、JSON/SARIF/XML parser 接口、项目级调度、进程组取消 | 缺工具、超时、取消、输出上限、Unicode 位置和 stale 结果测试通过 | 已完成 |
| 2. Python/Go/Rust | Ruff、Pyright、go vet、cargo check；各自 Project Locator 和 fixtures | 三种语言均能 CLI 检查、MCP 查询、LSP 保存触发和修复后清除 | 已完成；固定工具矩阵 strict smoke 和远端 CI 已通过 |
| 3. Java | Maven/Gradle wrapper、Checkstyle、PMD、编译诊断 parser | Maven 和 Gradle fixture 都能报告文件位置；无构建配置时返回明确错误 | 已完成；Maven/Gradle 固定版本 strict smoke 和远端 CI 已通过 |
| 4. C/C++ | compile database、clang/clang-tidy、C/C++ 语言分类和 parser | `clang-tidy` 使用 compile database；`clang-build` 使用显式命令；C 与 C++ fixture 均能解析编译/静态检查结果，缺少必要配置时不误报 | 已完成；clang/clang-tidy 固定版本 strict smoke 和远端 CI 已通过 |
| 5. 客户端和发布 | 动态 MCP discovery、VS Code/Zed selector、CLI capability 命令、打包和文档 | 所有入口看到同一结果；三平台 CI、安装包 smoke 和编辑器保存流程通过 | 已完成；功能、打包、真实 VS Code/Zed 保存流程和远端三平台门禁均已通过 |
| 6. 加固 | 旧路径清理、worker 隔离、性能和进程树清理、工具版本矩阵 | 无遗留固定 inspector 分支；并发、崩溃恢复和退出清理达到发布标准 | 已完成；跨平台生命周期、压力和工具矩阵均已通过 |

建议优先实现 Python、Go、Rust，再实现 Java 和 C/C++。前三者的机器可读输出和项目边界更稳定；Java 的构建生态和 C/C++ 的编译数据库需要更多项目级前提。

## 11. 测试和验收

### Fixture

新增每种语言的 `clean`、`broken`、`missing-tool`、`timeout`（适用时）项目，覆盖：

- 非 ASCII 文件内容和路径；
- 多文件/跨文件错误；
- monorepo 中相邻项目；
- 配置修改、文件删除、符号链接和生成目录；
- Maven/Gradle、Go module、Cargo workspace、C/C++ compile database；Clang build 另需显式命令 fixture。

### 单元和协议测试

- 每个 parser 使用真实工具输出的 golden fixture；
- 验证一基/零基、byte/rune/UTF-16 位置转换；
- 验证项目范围替换、队列合并、generation、取消和 stale 结果；
- 验证服务启动竞争、失效 owner、协议版本拒绝和 trust 失效；
- MCP stdout 只能包含协议消息；
- CLI、MCP 和 LSP 对同一次运行返回相同的 finding ID、位置和严重级别。

### 发布门槛

- Node 24 基线保持通过；
- CI 安装并固定 Python、JDK、Go、Rust、LLVM 工具链版本；
- Windows、macOS、Linux 都运行路径和进程生命周期测试；
- 每个语言至少有一次真实 CLI、MCP 和 LSP smoke；
- 保存触发延迟不超过 debounce 窗口加 500ms；
- 服务退出后不残留 worker、子进程、socket 或 discovery 文件；
- VSIX、npm tarball 和 Zed WASM 不捆绑项目编译器，只捆绑运行时和 adapter。

## 12. 风险和明确决策

| 风险 | 决策 |
| --- | --- |
| 工具输出格式随版本变化 | 记录最低支持版本，启动时做能力探测，parser 使用版本化 fixtures |
| Java 项目构建命令可能执行任意插件 | 只在 trust 后执行，优先使用仓库 wrapper，不自动下载依赖 |
| C/C++ 缺少编译数据库或构建命令时无法可靠解析 | `clang-tidy` 缺少 compile database 直接返回 `missing-configuration`；`clang-build` 缺少显式 `command` 返回 `configuration-error`；两者都不猜测编译参数 |
| 原生语言服务器产生重复诊断 | 本项目只发布自身来源，文档说明如何关闭重复检查 |
| 全项目类型检查过慢 | 项目级 execution key、保存合并、资源组和全局并发上限 |
| 动态插件系统扩大安全和维护面 | v0.2 只提供内置 adapter；外部插件协议另立计划 |

“支持一种语言”的定义是：该语言有目录条目、至少一个内置检查器、项目发现规则、结构化结果 parser、CLI/MCP/LSP 流程和 clean/broken fixture。仅仅增加文件扩展名不算支持。

## 13. 完成定义

代码实现和技术门禁已经完成；以下条件均已满足，v0.2.0 多语言扩展可以进入发布签核：

- Python、Java、Go、Rust、C、C++ 均能通过统一 finding 合约返回诊断；
- 同一工作区的 CLI、编辑器和 Agent 查询到同一份最新结果；
- 保存、修复、再次保存的 stale/clear 生命周期正确；
- 工具缺失、配置缺失、执行失败、超时和取消可区分；
- 多项目工作区不会重复或交叉覆盖结果；
- 非 ASCII 路径和 UTF-16 位置在三大操作系统正确；
- CLI、LSP、MCP、VS Code、Zed 及本机打包验收通过；
- 跨平台 CI、工具版本矩阵和进程生命周期验收通过；
- 旧 v1 配置、协议和固定 inspector 路径已删除，没有兼容回退代码。

## 14. 当前实现与验证记录

本仓库已经落地第 0–6 阶段的可运行实现，当前交付边界如下：

| 项目 | 当前结果 |
| --- | --- |
| 语言目录与项目发现 | JavaScript、TypeScript、Python、Java、Go、Rust、C、C++；`.h` 保持 C/C++ 双重候选，支持显式消歧 |
| 内置检查器 | ESLint、TypeScript、Ruff、Pyright、go vet、golangci-lint、Cargo check/clippy、Checkstyle、PMD、Java build、clang-tidy、Clang build、通用 command |
| 统一协议 | 服务协议 v2；CLI、LSP、MCP 共用 `checkId + projectRoot + scope` 结果集；旧 v1 配置/握手和字段别名直接拒绝 |
| 测试 | Core 58 项、Runtime 32 项；包含 parser golden、Maven 编译文本、Unicode/符号链接位置、取消/超时、stale、删除文件、项目发现、跨项目拒绝、watcher、协议边界、真实 IPC 无参 `getStatus`、并发边界、服务销毁竞态、查询过滤、失败运行可见性和 worker 崩溃恢复 |
| 进程级验证 | LSP smoke、MCP smoke、八种语言 CLI/protocol smoke、npm 消费者安装 smoke、生命周期 smoke 和压力 smoke 均通过；CI 固定工具矩阵的 14 组 clean/broken CLI/MCP/LSP strict smoke 全部通过 |
| 发布产物 | Core/runtime npm tarball、VSIX、Zed WASM 均已生成并通过本机打包命令 |
| 编辑器宿主 | VS Code 1.119.0 与 Zed Preview 1.20.0 均完成八语言错误态、MCP 一致性、修复清除和原生语言服务共存验收；退出后无残留 LSP、service、socket 或 discovery |

真实宿主验收矩阵如下。单元格中的“`UI = MCP -> 0`”表示错误态编辑器诊断数与 MCP finding 数一致，修复并再次保存后项目诊断与 MCP 均清零。

| 语言 | 检查器 / 编辑器来源 | VS Code 1.119.0 | Zed Preview 1.20.0 |
| --- | --- | --- | --- |
| JavaScript | `eslint` / `code-inspection/eslint` | `3 = 3 -> 0` | `3 = 3 -> 0` |
| TypeScript | `typescript` / `code-inspection/typescript` | `1 = 1 -> 0` | `1 = 1 -> 0` |
| Python | `ruff` / `code-inspection/ruff` | `2 = 2 -> 0` | `2 = 2 -> 0` |
| Go | `go-vet` / `code-inspection/go-vet` | `1 = 1 -> 0` | `1 = 1 -> 0` |
| Rust | `cargo-check` / `code-inspection/cargo-check` | `1 = 1 -> 0` | `1 = 1 -> 0` |
| Java | `java-build` / `code-inspection/java-build` | `1 = 1 -> 0` | `1 = 1 -> 0` |
| C | `clang-build` / `code-inspection/clang-build` | `1 = 1 -> 0` | `1 = 1 -> 0` |
| C++ | `clang-build` / `code-inspection/clang-build` | `1 = 1 -> 0` | `1 = 1 -> 0` |

原始结构化证据保存在 `/private/tmp/code-inspection-host-acceptance.qgjL0d/evidence/vscode-host.json` 和 `/private/tmp/code-inspection-host-acceptance.qgjL0d/evidence/zed-host.json`。VS Code 使用隔离的 user-data、extensions 和 service data 目录；Zed 使用官方 Preview bundle 及隔离的 HOME、user-data、runtime 和 service data 目录，未操作正在运行的 Zed Stable。Zed 中 ESLint/vtsls、Ruff/basedpyright、gopls、rust-analyzer、jdtls 和 clangd 均与 `code-inspection/*` 来源并存；jdtls 使用临时 JDK 26 设置启动到 `ServiceReady`，其 fixture classpath 警告独立于已清除的 `java-build` finding。

真实 MCP 连接还暴露了一个此前 smoke 未覆盖的 IPC 问题：无参数的 `getStatus()` 在服务端进入参数解析后会以 JSON-RPC `-32603` 失败。现在认证通过后会直接分派无参 `getStatus`，其余方法继续使用各自的协议解析器；`packages/runtime/test/runtime.test.ts` 已加入真实 socket 回归用例。本轮重新执行 `npm run check` 后 Core 58 项、Runtime 32 项全部通过。

本次验证命令：

```sh
npm run check
node scripts/smoke-lsp.mjs
node scripts/smoke-mcp.mjs
npm run smoke:languages
LANGUAGE_SMOKE_PROTOCOLS=1 node scripts/smoke-languages.mjs
STRICT_LANGUAGE_SMOKE=1 LANGUAGE_SMOKE_PROTOCOLS=1 node scripts/smoke-languages.mjs
npm run smoke:lifecycle
npm run smoke:pressure
npm run package:core
npm run package:runtime
npm run smoke:package
npm run package:vscode
npm run package:zed
git diff --check
```

本机默认 PATH 未提供 `pyright`、`golangci-lint`、Maven、Gradle 和 `clang-tidy`，已通过临时工具目录及 Homebrew LLVM 完成完整 strict CLI + MCP/LSP smoke：Ruff 0.15.1、Pyright 1.1.405、golangci-lint 2.1.6、Maven 3.9.9、Gradle 8.10.2、Go 1.26.3、Cargo 1.90.0、JDK 17.0.12、LLVM 20.1.8。覆盖所有 clean/broken 输出；缺工具行为也有独立覆盖。本轮还验证了服务销毁竞态、项目配置文件筛选、跨嵌套项目拒绝、预取消 worker、递归 watcher 并发注册保护、VS Code server 并发准备锁、Unicode/空格路径下的超时与取消进程树清理，以及 2 槽并发、build 资源组串行、100 项队列上限、dispose 清理和 worker 崩溃恢复。

远端 [GitHub Actions run 34773982868](https://github.com/zakotoys/code-inspection/actions/runs/34773982868) 已成功完成全部 6 个 job：Windows、macOS、Linux Node 任务均通过类型检查、Core 58 项、Runtime 32 项、协议、生命周期、压力、npm 包消费 smoke；VSIX 和 Zed WASM 打包成功。Ubuntu `language-tools` job 使用 Ruff 0.13.1、Pyright 1.1.405、Go 1.24.1、golangci-lint 2.1.6、Cargo 1.85.0、JDK 21.0.12.1、Maven 3.9.9、Gradle 8.10.2 和 LLVM 20.1.8，14 组 clean/broken CLI/MCP/LSP strict smoke 全部通过。

发布技术门禁已全部通过。当前仅剩发布签核：审阅变更日志、工具最低版本、信任说明和最终包内容，并由发布负责人确认 registry 上传。

## 15. 发布前执行清单

按以下顺序执行；每项都要保存命令输出或 CI 链接作为证据。未完成项不能把文档状态改为“可发布”。

| 状态 | 执行项 | 命令/环境 | 验收证据 |
| --- | --- | --- | --- |
| 已完成 | 类型检查、单元测试和协议边界 | `npm run check` | Core 58、Runtime 32 全部通过 |
| 已完成 | 默认工具 smoke | `node scripts/smoke-lsp.mjs`、`node scripts/smoke-mcp.mjs`、`npm run smoke:languages` | LSP/MCP 通过；缺失工具明确为 `missing-tool` |
| 已完成 | 生命周期与进程清理 smoke | `npm run smoke:lifecycle` | Unicode/空格路径、超时、取消、后代进程、符号链接越界和 idle discovery 清理通过 |
| 已完成 | 并发与 worker 恢复压力 smoke | `npm run smoke:pressure` | 全局并发不超过 2；build 资源组串行；队列不超过 100；dispose 和 worker 崩溃恢复通过 |
| 已完成 | 本机打包消费 | `npm run package:core`、`npm run package:runtime`、`npm run smoke:package`、`npm run package:vscode`、`npm run package:zed` | npm tarball、VSIX、Zed WASM 可生成并被临时消费者加载 |
| 已完成 | 固定工具矩阵 | 本机临时工具目录及 CI 运行 `STRICT_LANGUAGE_SMOKE=1 LANGUAGE_SMOKE_PROTOCOLS=1 node scripts/smoke-languages.mjs`；CI 固定 Ruff、Pyright、JDK/Maven/Gradle、Go/golangci-lint、Rust、LLVM | 本机与 CI 的八种语言 clean/broken、CLI/MCP/LSP 全部通过；证据：[run 34773982868](https://github.com/zakotoys/code-inspection/actions/runs/34773982868) |
| 已完成 | 三平台路径与进程树 | Windows、macOS、Linux CI；包含空格/非 ASCII 路径、符号链接、取消和超时 | 三平台均通过且无残留 worker、子进程、socket、discovery 文件；证据：[run 34773982868](https://github.com/zakotoys/code-inspection/actions/runs/34773982868) |
| 已完成 | 并发与恢复压力 | `npm run smoke:pressure`；远端三平台运行相同命令 | 不超过并发上限、资源组串行、100 项队列上限、dispose 和崩溃恢复均通过；证据：[run 34773982868](https://github.com/zakotoys/code-inspection/actions/runs/34773982868) |
| 已完成 | 编辑器宿主验收 | VS Code 1.119.0、Zed Preview 1.20.0；隔离多根工作区逐一保存 JavaScript、TypeScript、Python、Go、Rust、Java、C、C++ 文件 | 八语言诊断与 MCP 数量/来源一致；修复后 `code-inspection` 与 MCP 均清零；原生语言服务器并存；退出后无残留进程、socket 或 discovery |
| 待执行 | 发布签核 | 审阅变更日志、工具最低版本、信任说明和包内容 | 旧 v1 配置/协议路径不存在；发布负责人确认 registry 上传 |

发布签核完成后，将文档顶部状态更新为“可发布”并记录最终包审阅和 registry 上传确认。
