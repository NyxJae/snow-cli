# CurrentTaskPlan

## 1. 需求来源

- 需求文档: `requirements/编辑文件后缀名限制.md`.
- 定稿目标: 在主代理和子代理配置中新增 `editableFileSuffixes:string[]`,并在 `filesystem-edit` 与 `filesystem-edit_search` 执行前统一拦截.

## 2. 范围与边界

- 仅新增架构能力,不改动无关功能.
- 仅编辑工具受影响: `filesystem-edit`, `filesystem-edit_search`.
- 其他工具行为保持不变.
- `[]` 或未配置表示不限制,保持历史兼容.

## 3. 总体架构设计

### 3.1 配置层

- 主代理: 在 `source/types/MainAgentConfig.ts` 增加 `editableFileSuffixes?: string[]`.
- 子代理: 在 `source/utils/config/subAgentConfig.ts` 的 `SubAgent` 增加 `editableFileSuffixes?: string[]`.
- 读写兼容: 保持历史配置可读,未配置视为不限制.

### 3.2 规范化层

- 提供统一规范化函数,输入 `string[] | undefined`,输出规范化后数组.
- 规则:
  - trim 前后空格.
  - 支持 `md -> .md` 自动补点.
  - 忽略非法项,如空字符串或 `.`.
  - 小写归一化.
  - 去重.
  - 全部被忽略时等价于不限制.

### 3.3 执行拦截层

- 在 `source/mcp/filesystem.ts` 落地统一校验入口,供 `editFile` 与 `editFileBySearch` 共用.
- 生效前提: 仅当当前代理具备对应编辑工具权限(`filesystem-edit` 或 `filesystem-edit_search`)时,才执行后缀校验.
- 判定规则:
  - 后缀按文件名最后一个 `.` 判定,如 `.config.json -> .json`.
  - 无后缀文件在有限制时禁止.
  - 大小写不敏感.
- 拒绝文案固定为: `你没有权限编辑 xxx 类型文件的权限,请注意你的任务权限范围`.
- `xxx` 替换规则:
  - 常规文件: 展示判定后的后缀,如 `.py`.
  - 点开头文件: 仍按最后一个 `.` 判定后展示,如 `.env`.
  - 无后缀文件: 展示文件名.

### 3.4 上下文传递层

- `source/utils/execution/mcpToolsManager.ts` 负责把当前执行代理的 `editableFileSuffixes` 传入 filesystem 编辑调用.
- 主代理路径读取当前主代理运行态配置.
- 子代理路径由 `source/utils/execution/subAgentExecutor.ts` 提供子代理配置上下文.

### 3.5 TUI 层

- 主代理界面: `source/ui/pages/MainAgentConfigScreen.tsx`.
- 子代理界面: `source/ui/pages/SubAgentConfigScreen.tsx`.
- 输入规则:
  - 自定义文本输入.
  - 支持 `,` 和 `，` 分隔.
  - 空值表示不限制.
  - 保存后回显与规范化结果一致.

## 4. 分阶段实施顺序

### 阶段 A. 配置模型与持久化改造

- 修改主代理和子代理类型定义.
- 更新配置读写路径,确保字段可保存,可回读,可兼容历史数据.
- 产出: 配置层可表达并稳定存储 `editableFileSuffixes`.

### 阶段 B. 统一规范化能力落地

- 实现单一规范化函数,避免主代理,子代理,TUI,执行层各自实现导致语义漂移.
- 在保存前与执行前都复用同一规则.
- 产出: 规则一致性与可测试性.

### 阶段 C. 编辑执行拦截与批量语义

- 前置条件: 仅当代理具备 `filesystem-edit` 或 `filesystem-edit_search` 工具权限时,才参与后缀校验.
- 在 filesystem 编辑入口接入拦截.
- 单文件: 不允许即拒绝并返回固定提示,且 `xxx` 按需求文档 4.4 规则替换.
- 批量: 允许的继续执行,不允许的逐文件失败,整体支持部分成功.
- 产出: 满足需求文档第 4 章语义.

### 阶段 D. TUI 输入,保存,回显

- 增加主代理与子代理配置字段编辑入口.
- 增加字段说明,明确空值即不限制.
- 确保编辑模式与创建模式行为一致.
- 产出: 用户可在 TUI 完成配置闭环.

### 阶段 E. 验收与回归

- 用需求文档第 6,7 章用例做逐项验证.
- 执行 `npm run build` 并确保通过.
- 回归重点:
  - 未配置时行为完全兼容.
  - 两个编辑工具规则一致.
  - 批量返回含逐文件状态.
- 产出: 可交付验收记录.

## 5. 风险点与缓解策略

- 风险 1: 多处重复规范化导致行为不一致.
  - 缓解: 统一抽象规范化函数,禁止散落实现.
- 风险 2: `[]` 与 `undefined` 语义分叉.
  - 缓解: 统一视为不限制,在序列化和反序列化两端都做兜底.
- 风险 3: 批量模式异常传播导致全量失败.
  - 缓解: 逐文件错误收敛到 batch result,不抛全局异常.
- 风险 4: TUI 回显与真实生效不一致.
  - 缓解: UI 回显使用保存后的规范化值.

## 6. 开发完成定义

- 蓝图笔记已更新并通过用户审核.
- `CurrentTaskPlan.md` 已通过用户审核.
- 业务实现阶段完成后 build 通过.
- 用户重启应用进行 TUI 与编辑能力验证.
