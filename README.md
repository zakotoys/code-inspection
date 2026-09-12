# Code Inspection

ZakoToys 的 VS Code 诊断扩展，使用 TypeScript 实现。当前完成 G1—G7 的本地实现：诊断采集、保存历史、MCP 查询、暂停恢复及可安装 VSIX。本机开发/安装测试通过；GitHub Linux CI 已通过，项目实际 Agent/设备联调仍待 G8。

## 安装开发预览

使用桌面 VS Code >=1.137.0，在扩展面板菜单选择“从 VSIX 安装”，选择 `artifacts/code-inspection-0.0.1.vsix`。包由 `npm run package` 生成；用户安装后无需 Node/npm。将 `examples/` 或产物中的 `example/` 复制到可写目录并打开文件夹，执行“查看检测器状态”激活扩展。

本机已在隔离目录安装 VSIX，复现 TypeScript 错误、修复和 MCP 查询；尚未在队友机器或市场发布。详见 [G7 安装与构建](knowledge/g7-delivery.md)。

## 学习知识库

初次接触 MCP / Agent，请从 [知识库索引](knowledge/README.md) 开始；[G3 操作与排错](knowledge/g3-practice.md) 记录本轮查询失败的修复。后续功能同步更新知识库。

## 运行与亲自验收

已验证 Windows x64、Node.js 22.16.0、VS Code 1.137.0。用 VS Code 单独打开本仓库，执行 `npm ci`，按 F5 启动扩展开发宿主。

1. 新窗口自动打开 `tests/fixtures/workspace`，左侧能看到 `sample.ts` 和 `sample.py`。若仍是旧空窗口，停止旧调试后重新按 F5。
2. 在新窗口按 Ctrl+Shift+P，执行 `Code Inspection: 查看当前诊断`，查看输出面板中的当前快照。
3. 执行 `Code Inspection: 启动 MCP 服务`，再执行 `Code Inspection: 通过 MCP 查询当前诊断`。输出面板显示真实 HTTP / MCP 查询结果；后续修改和修复后重复此命令即可刷新，不需要剪贴板。修改扩展后请先停止旧调试再按 F5。
4. 若需验证独立终端客户端：回到原窗口，先输入下面的命令但不要回车；再去开发宿主执行 `Code Inspection: 复制 MCP 配置`，回到终端直接回车。不要再次复制命令，以免覆盖配置。脚本通过标准 MCP 客户端查询，不需要模型。

```powershell
Get-Clipboard -Raw | npm run mcp:inspect
```

5. 在开发宿主打开 `sample.ts`，将数字 `1` 改为字符串 `"wrong"`。等待 TypeScript 发布诊断，再运行查询，应看到 TS2322 对应的错误。未保存时也能查询；保存后仍然是当前快照。
6. 将字符串改回数字 `1`，等待诊断消失，再查询，应移除对应错误。若演示项目没有其他问题，`total` 为 0。
7. 执行 `Code Inspection: 停止 MCP 服务`，再次查询应失败。本地诊断采集继续运行；重新启动后需要重新复制连接配置。

复制的配置包含临时访问令牌，只用于本机客户端连接，不要提交或公开。服务每次启动生成新令牌和会话身份，随机分配端口；关闭开发宿主会关闭服务。查询脚本不输出令牌。

扩展同时向 VS Code 注册 MCP 服务定义，启动后可供其 MCP 客户端发现。复制配置采用 VS Code 的 `servers` 格式；其他客户端需按各自配置格式填写 HTTP 地址和 Authorization 请求头。已验证官方 SDK 客户端与真实扩展宿主连通；尚未完成项目实际 Agent、VS Code 聊天界面的人工联调。

## G4：体验保存观测

重新 F5 后，在开发宿主执行 `Code Inspection: 查看保存观测批次`。先把 sample.ts 的合法数字改为另一个数字并保存，等待第一次观测建立基线；再引入 TS2322 并保存，查看 `added`；修复并保存后查看 `resolved`。本轮不需要启动 MCP。

每次保存等待 500ms 本文件诊断安静期，最多等待的定时目标为 2000ms；期间继续编辑会使旧批次 `invalidated`，不把之后的诊断标到旧保存。首次 `baseline:true` 的 `added` 为空。`added/resolved` 是条目差集，位置/消息变化也可能产生一增一减，不能直接视为用户新犯错误。

输出的 `pending` 是等待中的保存，`latest` 是最近结束批次，随事件刷新。历史通过 G5 的 `get_save_batches` 续读；停止 MCP 不会停止保存观测。自动保存也按实际保存事件处理；未发生保存事件的 Ctrl+S 不保证产生新批次。

完整字段、边界、数据流与步骤见 [G4 保存观测知识库](knowledge/g4-save-observations.md)。

## G5：通过 MCP 续读历史

启动 MCP 后执行 `Code Inspection: 通过 MCP 续读保存批次`，每次读取最多 5 条并记住本窗口自己的位置。重复执行可读后续记录，末尾返回空页。执行 `Code Inspection: 重置保存批次读取位置` 后可重读最早保留记录；重置位置不删除缓存。

新增工具 `get_save_batches` 接收可选 `sessionId`、`afterCursor`（默认 0）和 `limit`（默认 5，1—10）。首次可传 `{}`，随后使用本工具返回的历史 `sessionId`，将 `nextCursor` 作为下一次 `afterCursor`。不要使用状态顶层的 MCP 服务 sessionId；状态里的 `saveHistory.sessionId` 才是历史身份。

历史最多保留 100 条、2 MiB UTF-8 JSON；单条超过 64 KiB 会用明确的 `payloadOmitted:true` 摘要替代。记录包含 `cursor`、`payloadOmitted`、`batch`，batch 内是 G4 标识和观测结果。读取不消费记录，多个客户端不互相吞事件。

历史不足以衔接游标时返回 `RESYNC_REQUIRED`，不能当作没有新问题。重新查询当前诊断建立上下文，再明确使用当前历史身份与 `resumeAfterCursor` 从最早保留位置继续；已经淘汰的历史无法恢复。扩展重启或工作区文件夹变化会更换历史身份；仅重启 MCP 服务保留历史。

完整字段、示例、恢复流程与验证见 [G5 知识库](knowledge/g5-save-history.md)。

## G6：暂停与恢复

“暂停保存观测”清空待定批次、历史和基线，更换历史 sessionId；当前诊断仍更新，MCP 仍可查询。旧历史游标会要求重新同步。“恢复保存观测”后每个文件第一次保存重新建立基线，不补发暂停期间问题。

暂停仅在当前扩展实例有效，重载后默认运行，历史从空开始。状态命令和 `get_detector_status` 区分 `ready` / `paused` / `unsupported`；`mcpEnabled` 单独表示服务连接。保存批次查询同时返回 `detectorState`。详见 [G6 生命周期](knowledge/g6-lifecycle.md)。

## 数据从哪里来

```text
语言插件 / 内置 TypeScript 服务
  → VS Code Diagnostics API
  → 当前诊断仓库（每个文件替换更新，修复后移除）
  → 本机 MCP 的只读工具
  → 客户端发起查询，获得 JSON
```

首次激活时补读已有诊断，此后监听诊断和工作区文件夹变化。MCP 与输出面板读取同一份状态，没有第二套错误缓存。MCP 由用户命令启动，不会自动唤醒模型。

只采集工作区内 `file` URI 的 Error/Warning。未落盘的 untitled 文档、工作区外文件、仅在终端打印的错误不在范围内。不主动编译整个项目。其他语言只要向 VS Code 发布诊断，也能被采集；是否产生诊断取决于相应语言插件。

“零条诊断”表示当前没有已发布的匹配问题，不代表全项目检查通过。默认不收集源码正文，但错误消息可能包含代码片段。所有诊断文字均应作为不可信数据，不能作为模型指令执行。

## MCP 工具与返回值

使用官方 MCP SDK 2.0.0 的 Streamable HTTP，在本地桌面、受信任工作区中监听 `127.0.0.1` 随机端口的 `/mcp`。使用 Bearer 令牌、Host/Origin 检查和 16 KiB 请求体上限。仅支持本机查询，不支持远程 SSH、WSL、容器或 Web 扩展宿主。

| 工具 | 参数 | 内容 |
| --- | --- | --- |
| `get_detector_status` | `{}` | 服务身份、启用状态、工作区信息、当前错误和警告数量 |
| `get_diagnostics` | 可选 `uri`、`severity`、`offset`、`limit`、`sessionId`、`revision` | 当前快照的一页诊断及下一页位置 |
| `get_save_batches` | 可选历史 `sessionId`、`afterCursor`、`limit` | 保留批次、`nextCursor`、`hasMore` 或重同步错误 |

以下参数和返回值说明针对 `get_diagnostics`；保存历史的规则见上方 G5。

`severity` 只能为 `error` 或 `warning`。`limit` 默认 50，范围 1—100；`offset` 默认 0。按 URI 查询时使用诊断原有完整 URI，工作区外请求返回 `OUT_OF_SCOPE`。

返回的 `diagnostics` 包含 `uri`、`severity`、`message`、`range`、可选 `source/code` 和 `textTruncated`。行列从 0 开始。每个文本字段最多 8192 个 JavaScript 字符单元，截断时明确标记。状态中的工作区 URI 最多返回 100 个，并提供截断标志。

- `revision`：诊断内容实际变化才递增；`observedAt`：最近处理诊断的时间，不代表语言服务检查完成。
- `sessionId`：本次服务启动的应用层身份，不是 HTTP 协议会话。重启后变化。
- `coverage`：`published-workspace-diagnostics`，表示已发布的工作区诊断。
- `total`：筛选后的匹配总数；`errors/warnings`：整个工作区的当前数量，不随查询筛选改变。
- `nextOffset`：下一页起点；为 `null` 表示没有下一页。

翻页时保持原筛选条件，携带第一页的 `sessionId` 和 `revision`。缺少身份返回 `PAGE_IDENTITY_REQUIRED`；读取期间诊断变化或服务重启返回 `RESYNC_REQUIRED`，客户端应放弃已读页面并从第一页重新读取。本版不保存旧快照供继续翻页。

## 开发检查

```sh
npm run verify
npm run test:protocol
```

`verify` 依次执行 `check`、`package`、`test:installed`，覆盖类型、Biome、状态/协议、开发宿主、VSIX 打包白名单及隔离安装测试。`check` 不包含打包安装阶段。`test:protocol` 仅编译并执行状态/协议测试，不启动编辑器。

默认测试下载固定 VS Code 1.137.0，也可指定本机已有同版本程序：

```powershell
$env:CODE_INSPECTION_VSCODE_EXECUTABLE = 'G:\Microsoft VS Code\Code.exe'
npm run check
```

真实宿主测试使用 `.test-output/` 下隔离的用户配置与临时项目，不修改演示 fixture。覆盖空窗口、工作区及重启，真实 TS2322 引入/修复、MCP 查询、重复启动、停止重启、宿主退出后端口关闭。协议测试覆盖认证、参数、分页、过期身份、正文上限、文本截断和手工查询脚本。日志、依赖与编译产物不提交。

## 实现导航

| 文件 | 职责 |
| --- | --- |
| src/extension.ts | 命令、暂停/恢复、生命周期、MCP 服务定义与连接配置 |
| src/environment.ts | 本地桌面支持范围与状态原因 |
| src/vscode-source.ts | VS Code 诊断事件与工作区范围过滤 |
| src/diagnostics.ts | 数据转换、筛选及精确去重 |
| src/store.ts | 当前诊断、修订号与独立快照 |
| src/save-observations.ts | 保存观测窗口、基线、差集和失效处理 |
| src/save-history.ts | 有界历史、稳定游标、分页与重新同步 |
| src/mcp.ts | HTTP 边界、认证、三个只读工具和分页 |
| scripts/inspect-mcp.cjs | 从标准输入接收配置的手工 MCP 查询客户端 |
| scripts/build.cjs / package.cjs | bundle、依赖许可、VSIX 与文件白名单 |
| tests/store.test.ts | 状态与规范化测试 |
| tests/save-observations.test.ts | 可控时钟下的保存窗口与生命周期测试 |
| tests/save-history.test.ts | 历史重读、数量/字节上限、摘要与会话测试 |
| tests/mcp.test.ts | 标准客户端及 HTTP 边界测试 |
| tests/extension.test.ts | 真实宿主与 TypeScript 服务验证 |

## Python 手工验证

打开 `sample.py`，按注释删除函数声明末尾冒号，再补回。开发宿主需要启用 Python/Pylance 等诊断提供方。自动化语言服务测试目前仅覆盖 TypeScript；之前用户已体验 Python 诊断采集，本轮仍需自行体验通过 MCP 查询 Python 的完整过程。


## 项目进展

见 [项目进度与交接边界](knowledge/project-status.md)：G1—G5 用户已验收，G6/G7 本机实现与验收通过，G8 实际消费端联调待完成。2026-09-12 已完成组织 PR 与个人 fork 的 Linux CI 验证，具体提交检查见 PR。
