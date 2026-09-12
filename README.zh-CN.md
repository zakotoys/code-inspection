# Code Inspection

[English](README.md) | **简体中文** | [日本語](README.ja-JP.md)

让编辑器、终端和 AI 代理共享本地 JavaScript / TypeScript 检查结果。使用项目自己的 ESLint 和 TypeScript，执行显式配置的构建，并通过 CLI、模型上下文协议（MCP）或语言服务器协议（LSP）读取统一诊断。

## 功能

| 能力 | 行为 |
| --- | --- |
| ESLint | 从配置的项目目录加载 ESLint 及其配置，检查文件模式或指定文件，返回规则 ID、严重程度和位置。 |
| TypeScript | 对配置的项目收集编译器诊断，不输出编译文件。向编译器 API 传递项目引用，但不执行 `tsc --build` 构建编排。 |
| 构建检查 | 运行可执行文件与参数数组，支持工作目录、环境变量覆盖、超时和有上限的 stdout/stderr。非零退出码生成工作区级错误诊断。 |
| 共享服务 | CLI、LSP、MCP 按规范化工作区根目录连接同一个服务，通过经过身份验证的本地 IPC 通信：Windows 命名管道或 Unix socket。 |
| 保存触发 | LSP 保存通知触发已启用的检查器；保存请求防抖，合并排队中的文件范围，过期运行不能覆盖较新结果。 |
| 结果新鲜度 | 诊断包含来源、代码、严重程度、可选文件/范围、运行 ID 和代次。编辑及观察到的文件系统变化使结果失效，成功检查替换对应范围内的结果。 |
| CLI | 初始化配置、授予/撤销信任、检查、查询结果/状态和取消运行；支持可读文本、JSON 与明确的退出码。 |
| MCP | 三个工具负责发起检查、读取运行和分页查询诊断；提供结构化结果及 JSON/Markdown 文本，stdout 仅用于协议。 |
| VS Code | 内置运行时、诊断、多工作区目录、手动运行/取消、输出面板、工作区信任和 MCP 定义。 |
| Zed | Rust/WASM 启动器调用已安装的 LSP，支持 JavaScript、TypeScript 和 TSX；原生 MCP 单独配置。 |
| 分发 | Core/runtime npm 压缩包、独立 VSIX、Zed WASM，以及构建、测试、协议和安装包检查。 |

## 环境要求

- Core/runtime 声明 Node.js `>=18.20`；开发和 CI 使用 Node.js 24。项目中的工具可能要求更高版本。
- 项目本地安装提供 `ESLint` API 的 ESLint，和/或提供编译器 API 的 TypeScript。测试 fixture 使用 ESLint 10 和 TypeScript 6。
- VS Code 扩展要求 `1.103.0` 或更高版本。
- 仅构建 Zed 扩展时需要 Rust 和 `wasm32-wasip2` target。

检查服务不会自动安装项目依赖，也不会使用内置 lint/编译器替代项目工具。

## 从仓库快速开始

在本仓库根目录运行：

```sh
npm ci
npm run build
npm run package:core
npm run package:runtime
npm install --global ./artifacts/zakotoys-code-inspection-core-0.1.0.tgz ./artifacts/zakotoys-code-inspection-runtime-0.1.0.tgz
```

进入要检查的项目，确保已安装其 ESLint 依赖和配置：

```sh
cd /path/to/your-project
code-inspection init
code-inspection trust .
code-inspection inspect --inspector eslint
code-inspection findings
```

`init` 创建 `.code-inspection.json`，默认开启 ESLint，关闭 TypeScript 和构建；不会覆盖已有文件。使用其他检查器前先启用它们。

以上使用本地产物，不依赖公开 registry 发布。npm/编辑器市场发布是单独的发布操作；当前 CI 构建并上传编辑器产物，没有自动发布工作流。

## CLI 参考

| 命令 | 用途 |
| --- | --- |
| `init` | 创建配置。 |
| `trust` / `revoke` | 授予/删除本地执行信任记录。 |
| `inspect` | 执行所选检查器并等待完成，默认 `eslint`。 |
| `findings` | 读取最多 500 条诊断；`--include-stale` 包含过期结果。 |
| `status` | 输出信任状态、运行中/最近运行和诊断数量的 JSON。 |
| `cancel --run-id <id>` | 取消排队或活动运行。 |
| `help` / `--version` | 显示帮助/版本。 |

默认工作区为当前目录。使用 `--workspace`（`-w`）或位置参数指定其他路径；含空格的路径需加引号。

```sh
code-inspection inspect -w /path/to/project -i eslint,typescript --json
code-inspection inspect -i eslint -f src/index.ts -f src/app.ts
code-inspection findings --json --include-stale
code-inspection status
code-inspection cancel --run-id <run-id>
code-inspection revoke /path/to/project
```

`--inspector`（`-i`）接受逗号分隔的 ID 或重复参数；`--file`（`-f`）可重复，每个请求最多 100 个文件。TypeScript/构建仍检查完整项目。`inspect --trust` 会持久保存信任。CLI 跳过禁用的检查器并输出警告。

| `inspect` 退出码 | 含义 |
| --- | --- |
| `0` | 已执行的运行没有诊断；全部检查器被跳过时也返回此值。 |
| `1` | 存在诊断，包括警告或构建非零退出。 |
| `2` | 执行/请求失败，例如工具缺失或工作区未受信任。 |
| `3` | 已取消或被更新运行取代。 |

## 配置

`.code-inspection.json` 可选；不存在时只开启 ESLint。下面的示例同时开启 TypeScript：

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

| 配置项 | 默认值与行为 |
| --- | --- |
| `version` | `1`；拒绝未知配置键。 |
| `debounceMs` | `300`；保存调度延迟，范围 `0`–`10000` 毫秒。 |
| `maxFindings` | `2000`；每次检查输出上限，范围 `1`–`10000`，摘要仅统计保留的诊断。 |
| `inspectors.*.enabled` | 省略整个配置节时 ESLint 开启、TypeScript/构建关闭。添加配置节时请显式设置。启用构建也会使其在编辑器保存时执行。 |
| `inspectors.*.cwd` | `.`；相对工作区的执行/工具解析目录。每个工作区根目录的每类检查器只有一份配置。 |
| `eslint.patterns` | 上述源码 glob；指定文件的请求会替换此范围。 |
| `typescript.project` | `tsconfig.json`，相对该检查器的 `cwd`。 |
| `build.command` | `["npm", "run", "build"]`；可执行文件及参数，不是 shell 表达式。 |
| `build.timeoutMs` | `120000`；范围 `1000`–`600000` 毫秒。 |
| `build.env` | `{}`；合并到继承的环境变量。 |
| `inspectors.*.exclude` | Schema 接受此字段，但引擎目前未应用。请使用 ESLint ignore 和 TypeScript 项目配置控制范围。 |

构建日志每个输出流最多保留 200,000 个字符。构建诊断不虚构源码位置；通过 CLI JSON 或 MCP 读取日志及退出状态。

## 信任、生命周期与新鲜度

项目插件、配置及构建命令会执行本地代码。审查工作区后再授予信任；MCP 工具不能授予信任。记录存储在仓库外，并绑定 `.code-inspection.json` 的精确内容。创建或修改该文件后，再运行 `code-inspection trust .`。此哈希不覆盖所有依赖或工具配置。

服务按需启动，在没有客户端且没有活动运行时，通常于 30 秒后退出。诊断和运行历史仅保存在内存，服务重启后丢失。文件系统事件只使结果失效；自动执行需要编辑器保存通知。

| 环境变量 | 用途 |
| --- | --- |
| `CODE_INSPECTION_DATA_DIR` | 覆盖信任及服务发现记录目录。默认使用 Windows 本地应用数据、macOS Application Support 或 Linux XDG state。 |
| `CODE_INSPECTION_IDLE_TIMEOUT_MS` | 覆盖默认 `30000` 毫秒空闲超时。 |

## MCP 集成

使用已安装的可执行文件作为本地 stdio 服务：

```json
{
  "command": "code-inspection-mcp",
  "args": []
}
```

按客户端格式将此对象放入服务配置。若客户端支持，设置进程工作目录为目标工作区；否则每次工具调用传入绝对 `workspace`。默认使用服务进程的工作目录。一个 MCP 进程可连接多个已受信任的根目录，日志写入 stderr。

| 工具 | 输入与结果 |
| --- | --- |
| `run_inspection` | 必填 `inspector`：`eslint`、`typescript` 或 `build`；可选 `files`，最多 100 个。立即返回包含 `runId` 的运行记录。 |
| `get_run` | 必填 `run_id`。返回运行状态、摘要/错误、诊断和新鲜度信息。 |
| `get_findings` | 可选 `inspector`、`file`、`offset`（默认 `0`）、`limit`（默认 `50`，最大 `500`）、`include_stale`（默认 `false`）。返回分页及最近运行；`hasMore` 为 true 时继续使用 `nextOffset`。 |

所有工具接受 `workspace` 和 `response_format`（默认 `json`，也可为 `markdown`），两种格式均返回结构化内容。

1. 调用 `run_inspection`：`{"workspace":"/path/to/project","inspector":"eslint"}`。
2. 在同一工作区将返回的 `runId` 作为 `run_id` 传给 `get_run`。
3. 轮询直到 `completed`、`failed`、`cancelled` 或 `superseded`；`queued` 和 `running` 尚未结束。
4. 读取 `get_findings` 并检查新鲜度。完成的运行仍可能包含错误。失败运行保留旧诊断并标为过期，默认不显示。

MCP 没有取消/信任工具，请使用 CLI。诊断范围使用从零开始的 UTF-16 位置；CLI/Markdown 显示位置从一开始。

## 编辑器

### VS Code

执行 `npm ci` 和 `npm run build` 后：

```sh
npm run package:vscode
code --install-extension artifacts/code-inspection-vscode-0.1.0.vsix
```

打开本地工作区并授予 Workspace Trust。扩展启动内置 LSP、授予对应的本地信任，并为每个工作区目录提供内置 MCP 定义。保存支持的 JS/TS 文件触发检查，修复并再次保存以清除已解决诊断。未受信任的编辑器会话不会执行 LSP 检查或提供 MCP 定义。

| 命令/设置 | 用途 |
| --- | --- |
| `Code Inspection: Run` | 在当前工作区请求默认检查器。 |
| `Code Inspection: Cancel Last Run` | 请求取消上一次手动启动的运行。 |
| `codeInspection.defaultInspector` | 默认 `eslint`，也支持 `typescript`、`build`。 |
| `codeInspection.runtimePath` | 可选外部 LSP 可执行文件路径；留空使用内置版本。不会替换内置 MCP。 |

**Code Inspection** 输出面板记录启动及手动命令信息。其他扩展可能产生重复诊断。

### Zed

安装上面的 runtime 压缩包，确保 Zed 的 PATH 包含 `code-inspection-lsp`，并通过 CLI 信任工作区。将 `extensions/zed` 安装为开发扩展。[Zed 指南](extensions/zed/README.md) 提供语言服务器和原生 MCP 配置。宿主工作目录不同时，MCP 调用需传入 `workspace`。

扩展只启动已安装的运行时，不负责下载。服务端 smoke 测试不能验证完整 Zed UI 流程；安装后的编辑器检查仍是手动发布步骤。

## Monorepo 与开发

```text
CLI ----------------------+
MCP stdio ----------------+--> Workspace service --> ESLint / TypeScript / build
VS Code / Zed --> LSP -----+    shared scheduling and in-memory findings
```

| 路径 | 职责 |
| --- | --- |
| [packages/core](packages/core) | `@zakotoys/code-inspection-core`：配置、信任、数据契约、检查器；不依赖编辑器/MCP。 |
| [packages/runtime](packages/runtime) | `@zakotoys/code-inspection-runtime`：CLI、IPC、服务、MCP、LSP。 |
| [extensions/vscode](extensions/vscode) | VS Code 客户端、命令、信任、MCP provider。 |
| [extensions/zed](extensions/zed) | Rust/WASM 启动器和 manifest。 |
| [tests/fixtures](tests/fixtures) | 正常/有错误的 lint/type 项目及失败构建。 |
| [scripts](scripts) | 打包和进程级 smoke 检查。 |
| [.github/workflows/ci.yml](.github/workflows/ci.yml) | Windows/macOS/Linux 的 Node 24 检查；Linux 编辑器打包。 |

```sh
npm ci
npm run check
npm run smoke:lsp
npm run smoke:mcp
npm run package:core
npm run package:runtime
npm run smoke:package
```

`check` 构建 npm workspaces 并运行测试。协议 smoke 使用真实子进程。安装包 smoke 在临时消费项目安装本地 tarball，检查信任、共享结果、带空格路径和空闲退出。

生成所有分发产物：

```sh
rustup target add wasm32-wasip2
npm run package
```

`artifacts/` 包含 `zakotoys-code-inspection-core-0.1.0.tgz`、`zakotoys-code-inspection-runtime-0.1.0.tgz`、`code-inspection-vscode-0.1.0.vsix`、`code-inspection-zed-0.1.0.wasm`。单独运行 core/runtime/VS Code 打包命令前需先构建；`package:zed` 自行调用 Cargo。

## 故障排查与范围

| 现象 | 检查方法 |
| --- | --- |
| 修改配置后失去信任 | 审查配置并重新授予信任。 |
| `missing-tool` / `unsupported-tool` | 检查 `cwd` 下的依赖解析、导出的 API 和 Node 要求。 |
| `missing-configuration` | 检查 ESLint 配置或 TypeScript 项目路径。 |
| 结果为空 | 检查 `status`、检查器开关、过期过滤及服务是否重启。空结果本身不证明检查成功。 |
| 构建失败没有源码诊断 | 构建结果属于工作区级，读取运行 JSON/MCP 输出。 |
| 服务握手被拒绝 | 确保 CLI/编辑器运行时版本一致，更新后重启旧客户端/服务。 |

当前范围是本地文件系统工作区、JS/TS lint/type 诊断及配置的构建。不提供自动修复、持久历史、远程/浏览器工作区、任意语言检查器框架或主动唤醒代理。ESLint/TypeScript 在进程内运行，仅支持协作式取消，不使用隔离 worker。构建取消/超时会请求终止进程，但不保证清理所有平台上的全部后代进程。

[架构与交付计划](docs/plan/code-inspection-architecture-and-delivery.md) 记录原始研究及预期验收标准；本 README 描述实际实现，不将所有规划能力视为已交付。

## 许可证

[Apache-2.0](LICENSE)
