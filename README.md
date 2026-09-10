# Code Inspection

ZakoToys 的 VS Code 诊断扩展。当前支持读取当前工作区已发布的 Error/Warning，并在修复后移除。MCP、保存批次与模型调度尚未实现。

## 运行与亲自验收

环境：本机已验证 Windows x64、Node.js 22.16.0、VS Code 1.137.0。先在 VS Code 单独打开 code-inspection，执行 `npm ci`，按 F5 运行扩展开发宿主。

1. F5 配置会自动打开本仓库的 `tests/fixtures/workspace` 演示文件夹，左侧可看到 sample.ts 与 sample.py。如果仍是旧空窗口，先停止旧调试，再按 F5。
2. 按 Ctrl+Shift+P 执行 `Code Inspection: 查看当前诊断`，输出面板显示当前 JSON 快照，并在之后的诊断变化时自动更新。
3. 打开 sample.ts，把 `1` 改成 `"wrong"`。TypeScript 应出现类型错误；等待语言服务更新，输出中应有 `code: 2322`、`severity: "error"`、文件 URI 和 range。
4. 此时无需保存即可观察变化。保存文件也不会生成历史批次；G2 仅维护当前状态。
5. 改回 `1`，等待错误消失；输出中的对应诊断应移除。重复执行命令不会重复累计。
6. `Code Inspection: 查看检测器状态` 显示当前已知错误/警告数量，明确提示 MCP 尚未启用。

首次执行任一命令后才开始采集；激活时会补读 VS Code 已有诊断，此后监听诊断与工作区文件夹变化。只采集工作区内 file URI；未保存到磁盘的 untitled 文档、工作区外文件不在当前范围。

“零条诊断”表示当前没有已发布的匹配问题，不代表整个项目完成检查。语言服务启动可能需要时间；其他语言需要相应插件。默认不采集源代码正文，错误消息本身可能含代码片段。

## 数据说明

输出是当前快照：revision（内容发生变化才递增）、observedAt（最近处理诊断的时间）、coverage、errors、warnings、diagnostics。

每条问题保留 uri、severity、message、range、可选 source/code。range 行列从 0 开始，例如 line: 0 表示第一行。observedAt 不是语言服务已检查完毕的证明。历史事件、保存批次与 MCP 协议返回值尚不存在。

## 开发检查

```sh
npm run typecheck
npm run lint
npm run compile
npm test
```

`npm test` 先跑纯状态测试，再通过官方 @vscode/test-electron 启动真实宿主，包含真实 TypeScript 类型错误引入/修复。测试使用 `.test-output/` 内临时项目，不修改演示 fixture 或用户项目。

默认下载固定的 VS Code 1.137.0；本机可指定已有同版本 executable：

```powershell
$env:CODE_INSPECTION_VSCODE_EXECUTABLE = 'G:\Microsoft VS Code\Code.exe'
npm run check
```

真实宿主测试需要桌面环境，使用独立用户配置。测试依次覆盖空窗口、工作区和同配置重启，进程需成功退出。测试日志/依赖/编译产物已忽略，不提交。

## 实现导航

| 文件 | 职责 |
| --- | --- |
| src/extension.ts | 生命周期、两个查看命令、输出面板 |
| src/vscode-source.ts | VS Code 已有诊断及变化事件，工作区范围过滤 |
| src/diagnostics.ts | 纯数据转换、Error/Warning 筛选、精确重复去除 |
| src/store.ts | 按 URI 替换当前诊断，修订号与独立快照 |
| tests/store.test.ts | 数据边界与状态单元测试 |
| tests/extension.test.ts | 真实宿主测试及内置 TypeScript 服务验证 |

下一步接入 MCP；本提交只包含诊断采集与查看功能。

## Python 手工验证

打开演示目录的 sample.py，按文件注释删除函数声明末尾冒号，再补回。需要开发宿主中启用 Python/Pylance 等诊断提供方；只看终端打印的错误不会进入本扩展。维护者已反馈手工体验未发现问题；自动化语言服务测试目前仅覆盖 TypeScript，不据此宣称所有 Python 场景已验证。
