# SSE 客户端适配主代理需求文档

## 1. 项目现状与核心目标

### 1.1 现状

服务端 SSE 功能已完成开发,支持以下特性:

- SSE 连接建立后自动推送 `agent_list` 事件,包含所有可用主代理(内置+用户自定义)
- 支持 `switch_agent` 消息用于切换会话的主代理
- 切换成功后推送 `agent_switched` 事件
- 完善的错误码体系用于处理各种异常情况

**当前问题**: SSE 客户端示例(`source/test/sse-client/`)尚未适配主代理功能,无法显示或切换主代理。

### 1.2 核心目标

为 SSE 客户端示例增加主代理支持,让用户能够:

1. 查看当前会话可用主代理列表
2. 了解当前会话正在使用的主代理
3. 在会话中切换主代理
4. 获得清晰的切换成功/失败反馈

---

## 2. 范围与边界

**功能点简述**:

- [ ] 接收并处理 `agent_list` 事件,存储主代理列表和当前主代理 ID
- [ ] 在聊天界面头部添加主代理选择器 UI
- [ ] 实现 `switch_agent` 消息发送功能
- [ ] 接收并处理 `agent_switched` 事件,更新 UI 显示
- [ ] 扩展 `error` 事件处理,针对主代理相关错误码给出明确提示

**排除项**:

- 不涉及主代理本身的增删改功能(在主代理配置界面完成)
- 不修改 SSE 服务端逻辑(已完成)
- 不涉及多会话同时切换的复杂场景

---

## 3. 需求详情

### 3.1 `agent_list` 事件处理

**事件数据结构**:

```javascript
{
  type: 'agent_list',
  data: {
    agents: [
      { id: 'general', name: 'General', description: '通用主代理' },
      { id: 'requirement_analyzer', name: 'Requirement Analyzer', description: '需求分析代理' }
    ],
    currentAgentId: 'general' // 可为 null,表示当前连接尚未绑定会话或服务端未确认当前代理
  }
}
```

**客户端行为**:

1. 接收到 `agent_list` 事件后,存储 `agents` 列表和 `currentAgentId`
2. 更新聊天界面头部的主代理选择器,填充下拉选项
3. 设置当前选中项为 `currentAgentId`

**例 1 - 连接后首次接收**:

```
1. 用户打开SSE客户端,点击"连接"按钮
2. EventSource连接建立,收到connected事件
3. 收到agent_list事件: agents=[general, debugger], currentAgentId=general
4. 头部下拉菜单显示: General (选中), Debugger (可选)
```

### 3.2 主代理选择器 UI

**UI 位置**: 聊天面板头部的右侧,紧挨着"新建会话"按钮

**UI 组件**:

- 下拉选择框(select 元素):
  - id 建议: `mainAgentSelect`
  - 显示所有可用主代理名称(name 字段)
  - 当前选中项高亮显示
  - 无可用代理时显示 disabled option: "(暂无可用主代理)"

**交互规则**:

- **触发方式**: 下拉框 change 事件直接触发切换(无需确认按钮)
- **切换中状态**:
  - 发送 switch_agent 后立即禁用下拉框,显示 loading 样式
  - 收到 agent_switched 或 error 后恢复可用
  - 若收到 error,回滚到下拉框到之前选中的主代理
- **未绑定会话时**: 支持预选主代理(示例客户端扩展行为)
  - 用户可在连接后、创建会话前选择主代理
  - 选择后主代理 ID 被记录为预选状态,不发送 switch_agent
  - 创建新会话时自动使用预选的主代理 ID 作为 initialAgentId
  - 提示:"已预选主代理: {name},新建会话时将自动使用该主代理"

**例 2 - 正常切换流程**:

```
用户场景: 用户想从 General 切换到 Code Reviewer

1. 用户从下拉菜单选择 "Code Reviewer"
2. 下拉框立即禁用,显示loading状态
3. 客户端发送 switch_agent 消息: { type: 'switch_agent', agentId: 'code_reviewer', sessionId: 'sess_xxx' }
4. 服务端返回 agent_switched 事件
5. 下拉框恢复可用,选中项更新为 "Code Reviewer"
6. 在聊天框显示系统消息: "主代理已切换: General → Code Reviewer"
```

**例 2b - 切换失败回滚**:

```
用户场景: 用户切换时遇到agent_busy错误

1. 当前选中 General,用户切换到 Debugger
2. 下拉框禁用,发送switch_agent消息
3. 服务端返回error: { errorCode: 'agent_busy', ... }
4. 下拉框恢复可用,但选中项回滚为 General(而非Debugger)
5. 弹出错误提示: "当前会话有进行中的任务..."
```

### 3.3 `switch_agent` 消息发送

**消息结构**:

```javascript
{
  type: 'switch_agent',
  agentId: 'debugger',      // 必填,目标主代理ID
  sessionId: 'sess_xxx'     // 必填,目标会话ID(客户端已知时必须携带)
}
```

**触发时机**:

- 用户从下拉菜单选择不同主代理时触发
- **已绑定会话时**: 发送 `switch_agent` 消息进行切换
- **未绑定会话时(预选模式)**: 记录预选的主代理 ID,创建新会话时作为 `initialAgentId` 传入

**发送策略**:

- 客户端始终携带 `sessionId` 字段(若已知),避免依赖连接绑定关系产生歧义
- 若 sessionId 为空,不发送切换消息,仅记录预选状态

### 3.4 `agent_switched` 事件处理

**事件数据结构**:

```javascript
{
  type: 'agent_switched',
  data: {
    previousAgentId: 'general',
    currentAgentId: 'code_reviewer',
    agentName: 'Code Reviewer'
  }
}
```

**客户端行为**:

1. 更新本地存储的 `currentAgentId`
2. 更新下拉选择器的选中项
3. 在聊天框添加一条系统消息,格式: "主代理已切换: {previousAgentName} → {agentName}"
4. 记录事件到事件日志(包含服务端返回的 timestamp,若缺失则使用本地接收时间)

**previousAgentName 获取策略**:

- 优先从本地 `agents` 缓存中根据 `previousAgentId` 查找 name 字段
- 若找不到匹配项,使用 `previousAgentId` 作为兜底显示

**例 3 - 切换成功后 UI 反馈**:

```
收到 agent_switched 事件:
  previousAgentId: general
  currentAgentId: code_reviewer
  agentName: Code Reviewer

客户端处理:
1. 更新 currentAgentId = 'code_reviewer'
2. 下拉菜单选中项变为 "Code Reviewer"
3. 聊天框新增消息: "[系统] 主代理已切换: General → Code Reviewer"
4. 事件日志新增: type=agent_switched 条目
```

### 3.5 错误处理

**支持的错误码及提示策略**:

| errorCode                 | 用户提示                                                                                 | 建议操作                                           |
| ------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `invalid_agent_id`        | "主代理 ID 不能为空"                                                                     | 选择有效的主代理                                   |
| `invalid_agent_id_format` | "主代理 ID 格式错误,只能包含小写字母、数字、下划线和连字符"                              | 检查主代理 ID 格式                                 |
| `agent_not_found`         | 使用服务端返回的 message 字段(开发者向,可能为英文),并列出 availableAgents 中的可用主代理 | 从下拉菜单选择可用主代理,客户端自动刷新 agent_list |
| `agent_busy`              | "当前会话有进行中的任务,请先终止对话后再切换主代理"                                      | 点击"终止"按钮,然后重试切换                        |
| `session_not_found`       | "会话不存在,请先创建或加载会话"                                                          | 点击"新建会话"或从列表加载会话                     |

**例 4 - agent_busy 错误处理**:

```
用户场景: 用户在有进行中对话时尝试切换主代理

1. 用户发送消息"帮我写个排序算法",AI正在回复中
2. 用户想切换到Debugger主代理
3. 用户选择Debugger,发送switch_agent消息
4. 服务端返回error事件: { errorCode: 'agent_busy', message: 'Session has ongoing task' }
5. 客户端弹出提示: "当前会话有进行中的任务,请先终止对话后再切换主代理"
6. 用户点击"终止"按钮,等待对话结束
7. 用户再次尝试切换,成功
```

**例 5 - agent_not_found 错误处理**:

```
用户场景: 用户尝试切换到一个已被删除的自定义主代理

1. 用户之前使用过自定义主代理 "my_custom_agent"
2. 该主代理配置文件被用户删除
3. 用户尝试切换到此主代理
4. 服务端返回error事件: {
     errorCode: 'agent_not_found',
     message: 'Agent not found: my_custom_agent',
     availableAgents: [
       { id: 'general', name: 'General', description: '...' },
       { id: 'debugger', name: 'Debugger', description: '...' }
     ],
     timestamp: '2025-12-30T15:30:00.000Z'
   }
5. 客户端弹出提示: "Agent not found: my_custom_agent"
6. 客户端使用 availableAgents 更新 agents 缓存和下拉菜单选项
7. 下拉菜单只显示可用主代理: General, Debugger
```

---

## 4. 事件日志记录

以下事件应被记录到事件日志面板:

| 事件类型            | 日志级别 | 显示内容                                                                             |
| ------------------- | -------- | ------------------------------------------------------------------------------------ |
| `agent_list`        | info     | 显示接收到的 agents 数量和 currentAgentId,包含服务端 timestamp(若缺失则使用本地时间) |
| `agent_switched`    | info     | 显示切换前后的主代理名称,包含服务端 timestamp                                        |
| `error`(主代理相关) | error    | 显示错误码、提示信息和 timestamp                                                     |

---

## 5. 边界情况处理

### 5.1 连接未建立时

- 主代理选择器应处于禁用状态(disabled)
- 显示提示: "请先连接服务器"

### 5.2 未绑定会话时

- 主代理选择器可用,支持预选功能(示例客户端扩展行为)
- 用户选择主代理后,记录为预选状态,不发送切换消息
- 创建新会话时,预选的主代理 ID 自动作为 `initialAgentId` 传入
- 提示:"已预选主代理: {name},新建会话时将自动使用该主代理"

### 5.3 只有一个主代理时

- 下拉菜单只显示一个选项
- 该选项保持可用状态(用户可以看到当前使用的主代理)

### 5.4 接收到的 agent_list 为空

- 下拉菜单显示 disabled option: "(暂无可用主代理)"
- 下拉框保持禁用状态
- 显示提示: "暂无可用的主代理,请检查服务端配置"

### 5.5 currentAgentId 不在 agents 列表中

- 当下拉菜单填充时,currentAgentId 对应的选项不在可用列表中
- 在下拉菜单顶部添加一个特殊选项: "未知/已失效 ({currentAgentId})"
- 提示用户: "当前主代理已失效,请重新选择可用主代理"

### 5.6 断线重连处理

- **onerror/onclose 时**:
  - 禁用主代理选择器
  - 清空本地 agents 缓存和 currentAgentId
  - 保留 `preferredAgentIdForNewSession` 预选状态,便于重连后继续以预选代理新建会话
  - 下拉菜单显示 disabled option: "(未连接)"
- **重连成功后**:
  - 等待新的 agent_list 事件到达
  - 收到后启用选择器并刷新列表

---

## 6. 相关文件

- **服务端实现**: `source/utils/sse/sseManager.ts` (已完成)
- **客户端入口**: `source/test/sse-client/index.html`
- **客户端逻辑**: `source/test/sse-client/app.js`
- **客户端样式**: `source/test/sse-client/style.css`
- **协议文档**: `docs/usage/zh/20.SSE服务模式.md`
- **前置需求**: `requirements/扩展现有sse.md`
