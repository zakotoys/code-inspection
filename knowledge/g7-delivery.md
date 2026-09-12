# G7：从开发扩展到可安装 VSIX 与 CI

更新：2026-09-12。Windows 本机的构建、打包和独立安装验证通过；GitHub 工作流已编写，尚未推送或在 GitHub 执行。

## 1. F5 成功为什么还不等于能交付

F5 会加载仓库代码，仓库里有 node_modules、测试代码和编译产物。队友安装扩展时不会有你的整个开发目录。如果打包缺了运行依赖，F5 可能成功而安装后失败。

现在采用同一个运行入口 dist/extension.cjs：TypeScript 编译用于类型/测试，esbuild 将扩展及运行依赖合并成 bundle，VS Code 自己提供的 vscode 模块不打进去。F5 和安装包都运行这个入口，避免两套实现漂移。

bundle 是将需要一起执行的模块打包成运行文件，不是生成一个新的 VS Code。VSIX 是编辑器可安装的扩展归档包，不是整个编辑器安装器。

## 2. 给队友的安装材料

构建产物：artifacts/code-inspection-0.0.1.vsix。演示目录：artifacts/example，也可直接复制仓库 examples/。无需让队友安装 Node 或运行 npm 才能使用扩展；开发和构建才需要 Node。

要求桌面 VS Code >=1.137.0，当前实际验证为 Windows x64 / VS Code 1.137.0。没有验证更早版本，不承诺降低引擎要求后仍能正常工作。

安装步骤：

1. 在普通 VS Code 扩展面板打开右上角菜单，选择“从 VSIX 安装 / Install from VSIX”，选中产物。
2. 若提示重载窗口，按提示重载。
3. 将 examples/ 复制到可写目录，用“打开文件夹”打开；不要只打开单个 sample.ts，否则没有工作区范围。
4. 执行“查看检测器状态”激活扩展；检查 ready。
5. 在 sample.ts 中将 number 值改为字符串 "wrong"，确认 TS2322，再修复。
6. 按 G4/G5 文档验证保存基线、新增/消失、MCP 续读；按 G6 文档验证暂停/恢复。

本扩展使用命令激活；安装后不运行命令不会回放此前的保存。MCP 仍由命令启动。初次使用后，当前实例持续采集，重载后需重新激活。

不要同时用旧 F5 开发宿主判断“安装包是否成功”：开发宿主可能优先加载本地开发版本。普通安装体验请在普通窗口完成，自动测试则使用隔离目录验证产品路径。

## 3. 开发者如何构建

Node 22.16.0 是本机与 CI 固定版本。使用锁文件安装依赖：

```sh
npm ci
npm run verify
```

verify 顺序执行：

```text
check：类型检查 → Biome → 编译/bundle → 单元/协议测试 → 开发宿主测试
package：重新编译/bundle → 官方 vsce 打包 → 清单白名单检查
 test:installed：安装 VSIX 到隔离目录 → 真实宿主测试安装版本
```

可单独运行 npm run package 生成 VSIX；单独运行 npm run test:installed 前需已有当前构建的包及编译测试文件。npm run watch 持续更新 bundle，静态类型检查仍使用 typecheck；F5 默认先执行 compile。

本机可指定已经安装的同版本编辑器，避免测试下载：

```powershell
$env:CODE_INSPECTION_VSCODE_EXECUTABLE = 'G:\Microsoft VS Code\Code.exe'
npm run verify
```

测试默认下载固定 VS Code 1.137.0。真实宿主需要桌面环境；Linux CI 使用 xvfb-run 提供虚拟显示。

## 4. 包里到底有什么

.vscodeignore 使用白名单，只包含：package.json、README、Apache LICENSE、dist/extension.cjs、第三方许可文件、knowledge/*.md 和干净的 examples/ 三个文件。

不会包含 node_modules、src、tests、.test-output、research、.git、工作区笔记 docs、调试配置、sourcemap 或连接配置。SDK 和 Zod 等运行依赖已经进入 bundle，无需把整个 node_modules 放进包。

scripts/build.cjs 从实际打包依赖生成 THIRD_PARTY_NOTICES.txt，保留第三方许可声明。scripts/package.cjs 使用官方 @vscode/vsce 打包并核对文件白名单，输出 artifacts/package-files.json；vsce 的默认包安全检查没有被关闭。许可和安全扫描不等于证明任何未来改动都无问题，包清单和安装测试仍随每次交付执行。

## 5. “干净安装测试”怎么做

scripts/test-extension.cjs --installed 创建新的用户配置和扩展目录，通过 VS Code CLI 安装刚生成的 VSIX。开发模式只加载一个空的测试驱动扩展，产品 code-inspection 必须从隔离安装目录加载。

测试首先断言真实产品路径在安装目录中，再执行实际 TS2322 引入/修复、MCP 当前诊断与历史、暂停恢复、重启、退出后端口关闭。产品不是通过 extensionDevelopmentPath 指向仓库；否则不能证明 VSIX 可独立运行。

测试脚本保留临时目录和日志供诊断，不修改用户的日常扩展目录，不写演示样例或用户代码。产品安装没有全局覆盖。

## 6. CI 是什么

CI（持续集成）是在提交或 PR 触发时，自动安装依赖、构建并验证代码的流程。本仓库 .github/workflows/check.yml 在 push、pull_request 或手动触发时执行。

当前配置使用 Ubuntu 24.04、Node 22.16.0、npm ci 和 xvfb-run -a npm run verify。成功后上传 artifacts/，供评审者下载 VSIX、示例和包清单。权限只有 contents:read；action 使用核实过的固定提交 SHA。没有自动发布市场、创建评论或请求机器人评审。

工作流文件存在不代表 GitHub 上已经绿灯。本轮没有提交/推送，因此没有远端 CI 运行记录；本机 Windows 已验证同一 verify 脚本，Linux 运行情况需首次 GitHub 工作流确认。

## 7. 当前证据与限制

本地完整 verify 成功：25 个状态/协议测试、3 个开发宿主场景和 2 个独立安装场景。运行依赖已打入包，安装后真实错误与修复可见。VSIX 只读白名单归档检查会在文档更新后的最终包上再次执行。

尚未验证：队友机器、真实 Agent 客户端、Linux CI 的实际执行、远程/Web 环境和 VS Code 市场发布。当前是可安装开发预览，不是正式市场版本。

常见故障：VS Code 版本低于 engines 要求会拒绝安装；只打开文件而没有工作区时采集范围为空；没有先激活命令就保存，不会补录历史；旧客户端令牌或游标失效时需要按 G3/G5 说明更新连接或重新同步。
