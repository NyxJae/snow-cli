# CurrentTaskPlan: Tool Search 白名单与权限适配详细开发计划(P0)

## 需求基线(SSoT)

- 主需求文档: `requirements/ToolSearch白名单与权限适配需求文档.md`.
- 关联需求文档:
  - `requirements/子代理调用子代理的工具筛选.md`
  - `requirements/合并到0.6.60冲突解决总需求文档.md`
- 本计划只服务本轮 Tool Search 架构收敛与落地实施,不作为长期需求来源.

## 本轮目标

1. 在不破坏 Tool Search 渐进暴露机制的前提下,引入两层代码内白名单:
   - 全局工具白名单.
   - 主代理跳过搜索子代理白名单.
2. 统一主代理,子代理,协作工具,subagent-xxx 的工具可见性模型.
3. 固化唯一规则: 先算 `allowedTools`,再划分 `initialTools` 与 `searchableTools`.
4. 避免权限判断,白名单判断,spawn 特判继续散落在多个模块中.
5. 给后续实施者一份按阶段推进的最小混乱开发顺序,确保每一步都可验收,可回退,可继续迭代.

## 本轮必须坚持的架构蓝图

### 1. 统一流水线

所有工具可见性都必须遵循同一流水线:

`rawTools -> allowedTools -> searchableTools -> initialTools -> execution fallback`

解释:

- `rawTools`: 当前运行上下文下可收集到的原始工具全集.
- `allowedTools`: 经主代理/子代理权限过滤后,当前代理真正允许看到的工具全集.
- `searchableTools`: `allowedTools` 中可通过 `tool_search` 发现的集合.
- `initialTools`: `allowedTools` 中首轮直接暴露给模型的集合.
- `execution fallback`: 执行期对越权调用和运行时约束的最终兜底.

### 2. 权限过滤与暴露策略分层

- 权限过滤先于白名单判断.
- 白名单只决定“是否跳过 Tool Search 渐进暴露”.
- 白名单绝不能扩权,也绝不能让无权限工具进入搜索结果.
- Tool Search registry MUST 基于 `allowedTools` 构建,不得基于 `rawTools` 构建.

### 3. 两层代码内白名单语义

- 全局工具白名单:
  - 对主代理和子代理都生效.
  - 可让命中的 allowed tool 在首轮直接暴露.
- 主代理跳过搜索子代理白名单:
  - 只对主代理生效.
  - 只用于主代理已授权的 `subagent-xxx` 工具首轮直出.
- 两份白名单默认都为空.
- 所有白名单条目都必须使用完整工具标识,并采用严格精确匹配.

### 4. 模块职责约束

- `source/utils/core/toolFilterUtils.ts`
  - 升级为统一工具访问决策核心.
  - 负责收敛 `allowedTools`,`searchableTools`,`initialTools` 等结果.
  - 不应夹带 UI 或命令层逻辑.
- `source/utils/execution/toolSearchService.ts`
  - 只负责在已授权 registry 上做搜索与已发现工具管理.
  - 不应自行推导权限.
- `source/hooks/conversation/useConversation.ts`
  - 只消费统一工具访问结果.
  - 不应再自己拼权限判断或白名单判断.
- `source/utils/execution/subAgentExecutor.ts`
  - 只负责子代理执行上下文组装与执行期兜底.
  - 不应再独立维护另一套可见性规则.
- `source/utils/MainAgentManager.ts`
  - 只负责提供 `availableTools`,`availableSubAgents` 等原始配置来源.
  - 不负责 Tool Search 暴露决策.
- `source/utils/config/subAgentConfig.ts`
  - 只负责子代理工具权限与 spawn 目标范围的配置来源.
  - 不承载白名单暴露策略.
- `source/utils/config/projectSettings.ts`
  - 若承载两层代码内白名单常量,其语义也只能是暴露策略,不能代替权限来源.
- `source/utils/commands/toolsearch.ts`,`source/hooks/ui/useCommandPanel.ts`
  - 只负责 `/tool-search` 能力入口与展示.
  - 不承载工具权限,白名单或 registry 构建语义.

### 5. 主代理/子代理/协作工具统一模型

- 普通工具,协作工具,`subagent-xxx` 都应视为统一的具名工具对象.
- `send_message_to_agent`,`query_agents_status`,`spawn_sub_agent` 与普通工具同级,直接受 `availableTools` 过滤.
- 仅 `spawn_sub_agent` 继续保留额外约束:
  - `availableTools` 允许.
  - `availableSubAgents` 过滤后非空.
  - 深度门禁允许.
  - 执行期 `agent_id` 仍需兜底校验.
- 主代理未授权的 `subagent-xxx`:
  - 不能首轮直出.
  - 不能被 Tool Search 搜到.
  - 不能被执行.

## 分阶段开发步骤(P0)

### Phase 1: 统一工具访问结果模型定稿

#### 目标

先定义唯一真值结构,让主代理链路,子代理链路,Tool Search,执行期兜底都围绕同一份结果工作.

#### 涉及模块

- `source/utils/core/toolFilterUtils.ts`
- 可能新增轻量类型定义文件,或在现有模块内整理类型.

#### 模块职责

- 定义统一结果结构,至少包含:
  - `allowedTools`
  - `searchableTools`
  - `initialTools`
  - 可选 `debugInfo`
- 明确工具完整标识生成与精确匹配口径.
- 明确主代理与子代理输入上下文的最小差异面.

#### 建议交付物

- 一个稳定的决策结果类型.
- 一组统一命名的辅助函数,用于:
  - 工具名标准化.
  - 完整标识精确匹配.
  - 白名单命中判断.

#### 完成标准

- 后续模块都以该结果为输入,不再各自重复推导“最终可见工具”.
- 后续评审时能明确指出: 哪个字段代表权限结果,哪个字段代表暴露结果.

#### 禁止事项

- 不要在此阶段提前把 UI 入口,命令层或具体执行调用细节揉进模型定义.
- 不要把白名单直接写成权限来源.

---

### Phase 2: 收敛 `toolFilterUtils.ts` 为统一决策核心

#### 目标

把主代理过滤,子代理过滤,协作工具权限过滤,`subagent-xxx` 权限过滤统一收敛到一个核心入口.

#### 涉及模块

- `source/utils/core/toolFilterUtils.ts`
- `source/utils/MainAgentManager.ts`
- `source/utils/config/subAgentConfig.ts`

#### 模块职责

- `MainAgentManager.ts` 只提供主代理原始权限来源:
  - `availableTools`
  - `availableSubAgents` 映射后的 `subagent-xxx`
- `subAgentConfig.ts` 只提供子代理原始权限来源:
  - `availableTools`
  - `availableSubAgents`
- `toolFilterUtils.ts` 统一负责:
  - 收集 `rawTools`
  - 解析 `allowedTools`
  - 过滤掉未授权普通工具,协作工具和 `subagent-xxx`

#### 建议交付物

- 主代理过滤入口 1 个.
- 子代理过滤入口 1 个.
- 共享精确匹配辅助逻辑 1 组.

#### 完成标准

- 权限过滤逻辑只在一个模块中维护.
- 所有匹配统一走完整标识精确匹配.
- 主代理未授权 `subagent-xxx` 时,该工具不会继续流入后续暴露层.
- 子代理未授权协作工具时,该工具不会继续流入后续暴露层.

#### 验收点

- 主代理 `availableTools` 缺失某工具时,该工具不进入 `allowedTools`.
- 主代理 `availableSubAgents` 未包含某子代理时,对应 `subagent-xxx` 不进入 `allowedTools`.
- 子代理 `availableTools` 未包含 send/query/spawn 时,这些工具不进入 `allowedTools`.

#### 禁止事项

- 不要在 `MainAgentManager.ts` 或 `subAgentConfig.ts` 中加入 Tool Search 暴露逻辑.
- 不要在 `toolFilterUtils.ts` 中掺入命令面板或文案逻辑.

---

### Phase 3: 引入白名单暴露策略层

#### 目标

把两层白名单落实为纯暴露策略,让代码结构能一眼看出“先权限,后白名单”.

#### 涉及模块

- `source/utils/core/toolFilterUtils.ts`
- `source/utils/config/projectSettings.ts`
- 可选新增轻量策略模块,如 `source/utils/core/toolExposurePolicy.ts`

#### 模块职责

- `projectSettings.ts` 或独立策略模块承载两份默认空白名单常量.
- 暴露策略层只负责回答:
  - 哪些 `allowedTools` 进入 `initialTools`
  - 哪些 `allowedTools` 留在 `searchableTools`
- 主代理跳过搜索子代理白名单只影响主代理上下文下的 `subagent-xxx`.

#### 建议交付物

- 两份默认空白名单常量.
- 1 组暴露划分函数:
  - 全局白名单判断.
  - 主代理子代理白名单判断.
  - `initial/searchable` 划分.

#### 完成标准

- 代码中能清晰看出“先权限,后白名单”的顺序.
- 白名单命中但未授权的工具,不会进入 `initialTools`.
- 主代理子代理白名单不会影响子代理侧普通工具或协作工具.

#### 验收点

- 两份白名单默认都为空.
- 白名单条目只接受完整标识精确匹配.
- 主代理下命中主代理子代理白名单的 `subagent-xxx`,若已授权,可进入 `initialTools`.
- 同名但未授权工具,即使在白名单中,仍不能进入 `initialTools`.

#### 禁止事项

- 不要把白名单实现成模糊匹配,前缀匹配或分类匹配.
- 不要把 `projectSettings.ts` 变成新的权限配置入口.

---

### Phase 4: 主代理链路接入统一结果

#### 目标

让主代理会话执行与 Tool Search registry 彻底改为只消费统一工具访问结果,封死无权限工具进入搜索结果的回归路径.

#### 涉及模块

- `source/hooks/conversation/useConversation.ts`
- `source/utils/execution/toolSearchService.ts`
- `source/utils/core/toolFilterUtils.ts`

#### 模块职责

- `useConversation.ts`:
  - 先收集 `rawTools`.
  - 再获取统一的 `allowed/searchable/initial` 结果.
  - 只用已授权结果初始化 Tool Search registry 和首轮 tools.
- `toolSearchService.ts`:
  - 只消费传入的已授权 registry.
  - 只处理搜索与已发现工具升级.
  - 不自行回查未授权工具全集.

#### 建议交付物

- 主代理链路完成从 `rawTools` 到统一结果的接入.
- Tool Search registry 初始化逻辑改为只接受 `allowedTools`.

#### 完成标准

- Tool Search 搜索范围与最终权限边界完全一致.
- 白名单工具即使已首轮直出,也只是已授权工具的提前暴露,不是额外授权.
- 主代理未授权的 `subagent-xxx` 既不会初始暴露,也不会出现在搜索结果.

#### 验收点

- `tool_search` 搜索不到主代理无权访问的普通工具.
- `tool_search` 搜索不到主代理无权访问的 `subagent-xxx`.
- 已授权且命中白名单的工具可以首轮直出.
- 已授权但未命中白名单的工具只能先通过 `tool_search` 被发现.

#### 禁止事项

- 不要在 `useConversation.ts` 内联第二套白名单判断.
- 不要在 `toolSearchService.ts` 内补一层“搜索时特判授权”.

---

### Phase 5: 子代理链路接入统一结果

#### 目标

让子代理侧普通工具,协作工具和 spawn 额外门禁同时对齐统一模型,避免“可见性一致了,执行期却没一致”的半收敛状态.

#### 涉及模块

- `source/utils/execution/subAgentExecutor.ts`
- `source/utils/config/subAgentConfig.ts`
- `source/utils/core/toolFilterUtils.ts`

#### 模块职责

- `subAgentConfig.ts` 继续只提供原始配置来源.
- `subAgentExecutor.ts`:
  - 消费统一过滤结果.
  - 基于统一结果构建子代理可见工具集.
  - 保留执行期最终兜底.
- `toolFilterUtils.ts`:
  - 为子代理生成 `allowed/searchable/initial` 结果.

#### 关键规则

- `send_message_to_agent`,`query_agents_status`,`spawn_sub_agent` 与普通工具同级受 `availableTools` 控制.
- `spawn_sub_agent` 仍继续受:
  - `availableSubAgents`
  - 深度门禁
  - 执行期目标校验

#### 建议交付物

- 子代理统一可见性结果接入.
- spawn 的执行期兜底与可见性边界保持一致.

#### 完成标准

- send/query 未授权时,既不出现在 tools 中,也不在 Tool Search 结果中,执行时也被拒绝.
- spawn 仍同时受 `availableTools`,`availableSubAgents`,深度门禁,执行期目标校验约束.
- `availableSubAgents` 为空时,即使子代理有 `spawn_sub_agent` 工具权限,该工具也不应暴露或可搜.

#### 验收点

- 子代理未授权 send/query/spawn 时,三者均不可见,不可搜,不可调.
- 子代理授权 spawn 但 `availableSubAgents` 清理后为空时,spawn 不可见.
- 子代理授权 spawn 且 `availableSubAgents` 非空,但深度超限时,spawn 不可见或执行拒绝.
- 子代理伪造未授权 `agent_id` 调用 spawn 时,执行期被拒绝.

#### 禁止事项

- 不要把 send/query 再视为天然全局可见.
- 不要因为统一模型而去掉 spawn 的安全边界.

---

### Phase 6: 入口层与配置层一致性收尾

#### 目标

确认命令入口,UI 入口,配置入口与执行链路口径一致,避免后续因为入口层“顺手加判断”导致架构回退.

#### 涉及模块

- `source/utils/commands/toolsearch.ts`
- `source/hooks/ui/useCommandPanel.ts`
- `source/utils/config/projectSettings.ts`
- `source/utils/MainAgentManager.ts`
- `source/utils/config/subAgentConfig.ts`

#### 模块职责

- 命令层与 UI 层只保留 Tool Search 能力入口.
- 配置层只提供权限来源或暴露策略常量.
- 不允许命令层,UI 层变成新的权限判断入口.

#### 完成标准

- 有 `/tool-search` 入口,不代表拥有越权搜索能力.
- UI 展示与运行态权限边界一致.
- 白名单配置位置明确,默认空,语义单一.

#### 验收点

- `useCommandPanel.ts` 只负责暴露命令,不内联白名单和权限判断.
- `toolsearch.ts` 只负责命令触发,不决定哪些工具可被搜索.
- `projectSettings.ts` 中若存在白名单常量,其命名与注释能明确看出“只负责首轮直出策略”.

#### 禁止事项

- 不要在命令或面板层增加“隐藏某些工具”的第二套逻辑.
- 不要在配置层引入用户可编辑的白名单 UI,超出本需求范围.

---

### Phase 7: 构建与行为验收

#### 目标

用最关键的行为场景确认统一模型没有被某个链路绕过.

#### 命令

- `npm run build`

#### 核心验收矩阵

1. 白名单默认态:
   - 两份白名单默认空时,系统仍保持现有渐进暴露行为.
2. 主代理普通工具权限:
   - 无权限工具,不出现在 `initialTools`,不出现在搜索结果,不能执行.
3. 主代理子代理工具权限:
   - 未授权 `subagent-xxx`,既不可见,也不可搜,也不可调.
4. 子代理普通工具权限:
   - 未授权普通工具,既不可见,也不可搜,也不可调.
5. 子代理协作工具权限:
   - 未授权 send/query/spawn,既不可见,也不可搜,也不可调.
6. spawn 额外门禁:
   - 即使有工具权限,在 `availableSubAgents` 为空或深度超限时,spawn 仍不可见且不可执行.
7. 白名单不扩权:
   - 白名单命中但无权限的工具,不出现在 `initialTools`,也不出现在搜索结果.
8. 精确匹配:
   - 白名单和权限名单都必须使用完整标识精确匹配,不存在前缀联动放大.

#### 工程完成标准

- `npm run build` 通过.
- 相关模块无“第二套可见性判断”残留.
- 蓝图笔记与计划书内容和代码落地方向保持一致.

## 风险与避坑

- 风险 1: 多处各自计算 `allowedTools`,导致主代理,子代理,Tool Search 结果不一致.
- 风险 2: 把白名单写进权限过滤层,造成“白名单扩权”误实现.
- 风险 3: `toolSearchService` 继续直接吃 `rawTools`,导致无权限工具仍可被搜到.
- 风险 4: 协作工具形式上纳入权限名单,但执行期仍保留旧全局可用分支,造成可见性和可执行性漂移.
- 风险 5: `spawn_sub_agent` 收敛后遗漏 `availableSubAgents` 或深度门禁,导致统一化过程中丢失安全边界.
- 风险 6: 入口层或配置层顺手补判断,重新制造第二套规则源.

## 本轮建议同步关注的蓝图/计划文件

### 蓝图笔记

- `source/utils/core/toolFilterUtils.ts`
- `source/utils/execution/toolSearchService.ts`
- `source/hooks/conversation/useConversation.ts`
- `source/utils/execution/subAgentExecutor.ts`
- `source/utils/MainAgentManager.ts`
- `source/utils/config/subAgentConfig.ts`
- `source/utils/config/projectSettings.ts`
- `source/utils/commands/toolsearch.ts`
- `source/hooks/ui/useCommandPanel.ts`
- `source/utils/execution/` 目录级笔记

### 计划与需求文件

- `CurrentTaskPlan.md`: 记录本轮分阶段实施顺序与验收口径.
- `requirements/ToolSearch白名单与权限适配需求文档.md`: 保持 SSoT,仅记录目标需求与验收标准,不记录开发过程.

## 对实施者的最后提醒

- 先收敛模型,再接主链路,再接子链路,最后做入口层一致性收尾.
- 任一阶段若发现某模块想“顺手自己算一遍”,优先回到统一决策核心补能力,不要局部打补丁.
- 本轮不是为了增加更多配置入口,而是为了让现有权限模型和 Tool Search 完整对齐.
