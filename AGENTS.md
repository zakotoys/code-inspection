- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.

## 项目知识库维护

- 用户要求：后续每完成或修复一个功能，同步补充对应知识库，不只交付代码。
- 知识库入口为 `knowledge/README.md`，面向首次接触 Agent/MCP 的参与者，使用中文解释。
- 每块记录问题、必要概念、数据流、代码入口和选择、复现步骤、边界、验证与未完成事项；新增文档更新索引，行为变化更新旧说明。
- 区分方案、已实现、自动测试、用户体验、实际 Agent 联调；未经验证不能写成已完成。
