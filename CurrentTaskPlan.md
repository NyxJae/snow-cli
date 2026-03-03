# CurrentTaskPlan: 子代理协作工具注入按 availableSubAgents 裁剪(P0)

## 需求基线(SSoT)

- 需求文档: `requirements/子代理调用子代理的工具筛选.md`.
- 范围: 仅约束子代理请求的 `tools` 中协作工具的注入规则与 spawn 范围组装,不修改工具内部逻辑.
- 相关代码:
  - `source/utils/execution/subAgentExecutor.ts`(运行态 tools 注入与 spawn 白名单/description/参数范围组装).
  - `source/ui/pages/SubAgentConfigScreen.tsx`(编辑态排除自身与过滤无效 id).
  - `source/utils/config/subAgentConfig.ts`(保存/读取 availableSubAgents 的规范化入口,以及运行态兜底清理的职责归属约束).

## 架构蓝图更新(长期约束,必须落地)

1. 语义收敛.

- `availableSubAgents?: string[]` 的语义是“允许 spawn 的子代理白名单”,不是“协作工具开关”.
- `undefined` 与 `[]` 与“清理后为空”三者等价: 表示“没有任何可 spawn 的子代理”.

2. 运行态兜底清理是硬约束.

- 运行态必须计算 `effectiveAvailableSubAgents`:
  - 基于 `agent.availableSubAgents`.
  - 过滤掉当前不存在的子代理 id.
  - 排除自身 id.
- 不允许只依赖 UI 保存时过滤,因为配置可能来自历史残留或手工编辑.

3. 协作工具注入规则(只控制 tools 列表).

- `send_message_to_agent` 与 `query_agents_status` 是自带协作工具,始终全局可见,始终出现在子代理请求的 tools 中,不受 availableSubAgents 开关影响.
- 仅 `spawn_sub_agent` 受 `effectiveAvailableSubAgents` 与运行时深度门禁影响:
  - effective 为空(包含 `availableSubAgents: []`)时,tools 中不包含 spawn_sub_agent.
  - effective 非空且运行时允许 spawn(深度门禁)时,tools 中包含 spawn_sub_agent.
  - spawn_sub_agent.parameters.agent_id 可选范围必须严格等于 effectiveAvailableSubAgents.
  - spawn_sub_agent.description 中展示的“Available agents you can spawn”列表必须严格等于 effectiveAvailableSubAgents(并排除自身).

## 短线开发计划(P0)

### 步骤 1: 运行态裁剪策略落地(subAgentExecutor.ts)

- 目标: send/query 始终注入; `spawn_sub_agent` 的注入与范围完全对齐 `effectiveAvailableSubAgents`.
- 交付物:
  - 运行态计算 effectiveAvailableSubAgents 的函数/逻辑(清理无效 id + 排除自身).
  - tools 注入门禁: effective 为空则不注入 `spawn_sub_agent`(但 send/query 仍注入).
  - `spawn_sub_agent.parameters.agent_id` 可选范围与 `spawn_sub_agent.description` 列表严格受 effective 约束.
- 完成标准:
  - 满足需求文档 4.3 的所有示例与边界情况.
  - 新增验收点: description 中的“Available agents you can spawn”列表与 parameters.agent_id 可选范围一致,且两者都严格等于 effectiveAvailableSubAgents.

### 步骤 2: 配置保存与读取的规范化(subAgentConfig.ts)

- 目标: 将 availableSubAgents 的“保存时清理”职责沉淀到配置层(不只在 UI).
- 交付物:
  - 保存/更新时过滤 invalid id,并排除自身(若传入).
  - 明确: 即使保存时已清理,subAgentExecutor 仍必须运行态兜底清理.
- 完成标准:
  - 历史配置/手工编辑的脏数据不会导致运行态出现不一致或越权 spawn.

### 步骤 3: UI 编辑体验保持一致(SubAgentConfigScreen.tsx)

- 目标: 编辑态持续排除自身,并仅展示有效子代理.
- 交付物:
  - 加载既有配置时继续过滤 invalid id.
  - 保存时传递的 availableSubAgents 不包含自身.
- 完成标准:
  - UI 显示与运行态 effective 清理后的结果语义一致(即: UI 不会展示“不可用但已保存”的幽灵 id).

### 步骤 4: 构建验收

- 命令: `npm run build`.
- 验收要点(手工):
  - send_message_to_agent/query_agents_status 始终在 tools 中(不受 availableSubAgents 影响).
  - availableSubAgents 为 `undefined`/`[]`/清理后空时,tools 中不包含 spawn_sub_agent.
  - availableSubAgents 非空且深度门禁允许时,tools 中包含 spawn_sub_agent.
  - spawn_sub_agent.parameters.agent_id 仅允许 effective 列表(无无效 id,无自身).
  - spawn_sub_agent.description 的可用子代理列表严格等于 effective 列表,且与 parameters.agent_id 范围一致.

## 风险与避坑

- “空白名单=不限制”历史语义回归风险: 必须用 explicit gate 覆盖,并补充用例覆盖 undefined/[].
- 只在 UI 清理导致运行态漂移: 必须把运行态兜底清理视为安全边界,不可省略.
- 自身 id 泄漏风险: 清理逻辑必须在所有路径(保存,读取,运行态)排除自身,避免死配置与潜在递归调用.
