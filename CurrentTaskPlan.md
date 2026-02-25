# CurrentTaskPlan - ace-text_search 与 filesystem-edit_search 联动替换

## 0. 需求基线(SSoT)

- 核心需求文档: `requirements/搜索替换工具和搜索工具联动.md`
- 相关代码范围:
  - `source/mcp/aceCodeSearch.ts`
  - `source/mcp/filesystem.ts`
  - `source/mcp/utils/aceCodeSearch/search.utils.ts`

## 1. 架构影响面

### 1.1 模块边界

1. `ace-text_search` 侧(`source/mcp/aceCodeSearch.ts`):
   - 扩展返回结构,为每个命中项提供可引用标识(`searchResultId` 或 `searchResultHash`).
   - 工具描述前置联动推荐,强调结果可立即用于替换.
2. `filesystem-edit_search` 侧(`source/mcp/filesystem.ts`):
   - 新增联动输入参数(`searchResultId/searchResultHash`)并识别联动模式.
   - 联动模式下直接基于引用命中做精确替换定位,不走 fuzzy 路径.
3. 工具辅助层(`source/mcp/utils/aceCodeSearch/search.utils.ts`):
   - 承接结果标识的规范化或可复算工具函数(如 hash 生成/解析).

### 1.2 数据流

1. 调用 `ace-text_search` 执行检索,返回命中项与引用标识.
2. 选择目标命中后,紧接调用 `filesystem-edit_search`.
3. `filesystem-edit_search` 根据 `searchResultId/searchResultHash` 定位待替换文本.
4. 定位成功则写入并返回既有结果结构,失败则沿用当前匹配失败语义.

### 1.3 兼容策略

- 联动优先: 有引用参数时优先联动模式.
- 旧模式兼容: `searchContent + replaceContent` 原流程保持可用.
- 失败语义兼容: 引用失效或不匹配时,复用当前失败逻辑,不新增分支流程.

## 2. 分阶段开发计划

### P0. 契约与类型先行(最高优先级)

- [ ] 1. 明确 `ace-text_search` 结果新增字段及唯一性规则.
- [ ] 2. 明确 `filesystem-edit_search` 新参数输入契约及互斥/优先级规则.
- [ ] 3. 明确联动模式与传统模式在批量场景下的统一参数解析策略.

验收:

- 两工具输入输出契约可在代码类型层表达清晰.
- 参数冲突场景有明确优先级定义并可复用到批量路径.

### P1. 联动核心链路实现(最高优先级)

- [ ] 1. 在 `ace-text_search` 返回中注入可引用标识.
- [ ] 2. 在 `filesystem-edit_search` 增加联动参数解析入口.
- [ ] 3. 联动模式下禁用 fuzzy 匹配路径,改为引用命中精确定位.
- [ ] 4. 联动定位失败时复用现有匹配失败返回逻辑.

验收:

- 可完成"先搜索,后引用替换"闭环.
- 联动模式下不会触发 fuzzy 匹配逻辑.
- 旧调用方式仍可正常替换.

### P2. 提示词文案改造(高优先级)

- [ ] 1. 精简 `ace-text_search` 描述,前置联动可用性说明.
- [ ] 2. 精简 `filesystem-edit_search` 描述,前置联动优先流程.
- [ ] 3. 固化 workflow 指导:
  - 想修改文件时,先新调用一次 `ace-text_search`.
  - 确认命中后紧接调用 `filesystem-edit_search` 并传 `searchResultId`.
  - 强调立即消费结果,避免结果过时.

验收:

- 工具描述可读性提升且更短,保留必要安全约束.
- workflow 指导在两个工具描述中语义一致.

### P3. 回归验证与发布就绪(中优先级)

- [ ] 1. 覆盖单文件与批量替换两类联动场景.
- [ ] 2. 验证兼容模式未回归(传统 `searchContent + replaceContent`).
- [ ] 3. 执行项目构建验证(`build` 通过).

验收:

- 联动模式成功与失败路径均符合预期口径.
- 构建通过,无新增类型错误.

## 3. 风险与回滚策略

### 3.1 主要风险

- 标识不稳定导致引用无法复现定位.
- 批量模式参数分流复杂,易出现联动/传统模式混用歧义.
- 文案精简过度导致安全边界表达不足.

### 3.2 控制措施

- 标识生成使用确定性规则,避免依赖运行时波动信息.
- 参数解析集中在统一入口,避免分散逻辑导致行为不一致.
- 文案采用"联动优先 + 兼容补充 + 核心约束"三段式模板.

### 3.3 回滚策略

- 联动逻辑采用可控分支接入,异常时可临时回退到仅传统模式入口.
- 保持旧参数与旧执行路径不删改,确保可快速降级.
- 文案层可独立回滚,不影响核心替换能力.

## 4. 提示词文案落地建议

- `ace-text_search`:
  - 强调"检索结果可直接用于后续替换引用".
  - 保留其"精确文本/正则定位"定位,删除冗长无关示例.
- `filesystem-edit_search`:
  - 将联动 workflow 放在描述前部,作为默认推荐流程.
  - 兼容模式降级描述为"传统方式,仅在无引用时使用".
  - 明确联动模式禁用 fuzzy 与"立即消费搜索结果"要求.

## 5. 执行顺序建议

- Day 1: 完成 P0 契约澄清与类型设计.
- Day 1-2: 完成 P1 联动链路开发与失败路径复用.
- Day 2: 完成 P2 文案改造.
- Day 2: 完成 P3 回归与 build 验证,进入提交阶段.

## 6. 完成定义(DoD)

- `ace-text_search` 已返回可引用结果标识.
- `filesystem-edit_search` 已支持引用参数并联动替换.
- 联动模式禁用 fuzzy,失败路径沿用既有逻辑.
- 旧模式兼容,构建通过,工具文案已完成联动优先精简改造.
