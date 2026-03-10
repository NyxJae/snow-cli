# 单层工具 Hook 架构优化需求

## 1. 背景

当前工具调用链存在两处工具 Hook 执行逻辑:

- `source/utils/execution/toolExecutor.ts`.
- `source/utils/execution/mcpToolsManager.ts`.

历史上两处都可执行 `beforeToolCall` 和 `afterToolCall`,在主流程 `toolExecutor -> executeMCPTool` 路径上会产生重复触发风险. 已通过 `skipToolHooks` 做了止血,但代码仍有冗余,维护成本较高.

本需求目标是从架构根源收敛为单层工具 Hook 执行,并保留现有能力与兼容行为.

## 2. 目标

- 统一工具 Hook 执行职责到单一层.
- 主流程和子代理流程都复用同一 Hook 执行编排能力.
- 消除当前双处 Hook 逻辑复制,降低回归概率.
- 保持 Hook 的退出码语义,错误传播语义,以及用户可见行为一致.
- 保持工具参数归一化规则一致,避免 Hook 入参与工具执行入参漂移.

## 3. 非目标

- 不修改 Hook 配置文件格式.
- 不新增新的 Hook 类型.
- 不改变 `onStop` 等非工具 Hook 机制.
- 不在本需求中改造通知脚本本身.

## 4. 现状与问题

### 4.1 现状调用链

1. 主流程: `useConversation -> executeToolCalls -> executeToolCall(toolExecutor) -> executeMCPTool(mcpToolsManager)`.
2. 子代理流程: `subAgentExecutor -> executeMCPTool`.

### 4.2 当前止血方案

- 在 `MCPExecutionContext` 增加 `skipToolHooks?: boolean`.
- 主流程传 `skipToolHooks: true`,避免 mcpToolsManager 内部再执行 Hook.
- 子代理直调传 `skipToolHooks: false`,保留该路径 Hook.

### 4.3 根本问题

- Hook 业务逻辑在两个文件重复实现,未来变更容易只改一处.
- 需要依赖调用方正确传 `skipToolHooks`,存在使用姿势风险.
- 可读性和职责边界不够清晰.

## 5. 目标架构

采用 `单一 Hook 执行器 + 多调用路径复用` 方案.

### 5.1 职责归一

- `toolExecutor` 负责工具生命周期编排,包括:
  - 参数解析与参数归一化.
  - before Hook 调用.
  - 工具实际执行调用.
  - after Hook 调用.
- `mcpToolsManager` 仅负责工具路由与执行,不再包含工具 Hook 逻辑.

### 5.2 子代理统一入口

子代理工具执行应尽量复用 `executeToolCall` 统一生命周期,而不是直接绕过到 `executeMCPTool`.

若短期无法完全复用,则应引入统一公共 Hook 运行模块,保证逻辑单源,禁止复制实现.

### 5.3 参数统一

- 保留 `normalizeToolArgs` 作为单一归一化函数.
- Hook 入参与真实执行参数都基于同一份已归一化参数对象.

## 6. 方案约束

- 所有公开类,方法,字段必须有规范文档注释.
- 内联注释只解释 why,不写开发日志式注释.
- 任何新增调用点不得引入第二处 Hook 执行链.
- 若存在必要的兼容开关,必须标注淘汰计划.

## 7. 详细改造要求

### 7.1 mcpToolsManager 改造

- 删除 `beforeToolCall` 与 `afterToolCall` 执行逻辑.
- 保留工具路由,执行,错误包装,token limit 等职责.
- 保留并导出 `normalizeToolArgs`.

### 7.2 toolExecutor 改造

- 成为唯一工具 Hook 执行层.
- 抽离可复用的 Hook 执行函数,如 `runBeforeToolHooks` 和 `runAfterToolHooks`.
- 保持当前退出码语义:
  - `0`: success.
  - `1`: warning and continue.
  - `>=2 or <0`: failure.

### 7.3 subAgentExecutor 改造

- 优先复用 `executeToolCall`.
- 若保留直调,必须通过统一 Hook runner,不得重复实现 Hook 逻辑.

### 7.4 防回归守卫

- 增加静态约束或单测,确保全仓仅存在一套工具 Hook 执行实现.
- 增加最小行为回归用例:
  - `askuser-ask_question` before Hook 仅触发 1 次.
  - 普通工具 before/after 各 1 次.
  - 子代理路径触发次数符合预期且不重复.

## 8. 验收标准

### 8.1 功能验收

- 主流程单次工具调用只触发一层 Hook.
- 子代理路径不出现双触发.
- Hook 退出码行为与当前一致.
- Hook 入参中的 args 与实际执行参数一致.

### 8.2 工程验收

- `npm run build` 通过.
- 相关文件 IDE diagnostics 无 error.
- 关键架构注释齐全.
- 无重复 Hook 实现代码块残留.

## 9. 分阶段实施计划

1. 阶段 A: 抽取统一 Hook runner,并在现有两路径接入同一实现,先消除逻辑复制.
2. 阶段 B: 子代理路径收敛到统一生命周期入口.
3. 阶段 C: 移除 mcpToolsManager 中工具 Hook 代码与兼容开关.
4. 阶段 D: 完成回归验证与文档收敛.

## 10. 风险与回滚

- 风险 1: 子代理路径行为差异导致交互异常.
  - 缓解: 先引入统一 runner 再迁移入口,分阶段验证.
- 风险 2: Hook 错误语义变化影响用户体验.
  - 缓解: 保持退出码与错误展示策略完全一致.
- 风险 3: 改造范围大导致短期不稳定.
  - 缓解: 保留小步提交与阶段回滚点.

## 11. 交付物

- 单层工具 Hook 最终代码实现.
- 回归验证记录.
- 架构蓝图笔记更新,明确唯一 Hook 执行层职责.
