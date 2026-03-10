# SSE 模式支持会话级主代理选择

## 1. 项目现状与核心目标

### 1.1 现状

- 本地已实现主代理系统，支持 `general`/`requirement_analyzer`/`debugger` 三种内置主代理
- 支持用户通过配置文件添加自定义主代理（存储在 `~/.snow/main-agents.toml`）
- 主代理通过 `MainAgentManager` 管理，默认所有会话共享同一主代理配置
- SSE 模式目前直接使用服务端 `MainAgentManager` 的当前配置，客户端无法选择主代理

### 1.2 核心目标

为 SSE 模式添加会话级别的主代理选择功能，使每个 SSE 会话（sessionId）可以独立选择和切换主代理，不同 sessionId 之间互不干扰。

## 2. 范围与边界

### 2.1 功能点

- [ ] SSE 连接建立时，服务端自动向客户端推送可用主代理列表（包含内置和用户自定义主代理）
- [ ] 支持客户端通过消息切换当前会话的主代理（可切换到任意可用主代理）
- [ ] 切换失败时返回错误事件，并附带合法主代理列表
- [ ] 每个会话独立维护主代理状态，多客户端互不干扰

**协议扩展说明**：

- 需扩展现有 `SSEEventType` 联合类型，新增 `agent_list` 和 `agent_switched` 事件类型
- 需扩展 `ClientMessage['type']` 联合类型，新增 `switch_agent` 消息类型
- 扩展需保持向后兼容，老客户端遇到未知事件应静默忽略

### 2.2 排除项

- 不支持 URL 参数指定初始主代理（通过连接后的消息切换）
- 无专门的客户端查询消息类型，主代理列表仅在连接时和切换失败时返回
- 不涉及主代理配置的修改（仅切换使用）
- 服务端主代理配置热更新时，已连接的客户端不会自动收到更新通知（需重连获取最新列表）

### 2.3 文档更新要求

- 功能实现后，需同步更新 `docs/usage/zh/20.SSE服务模式.md`，添加主代理选择相关的使用说明

## 3. 举例覆盖需求和边缘情况

### 3.1 连接建立推送主代理列表（包含用户自定义主代理）

**场景**: 用户已配置了一个自定义主代理 `code_reviewer`，客户端通过 `/events` 端点建立 SSE 连接

**预期行为**:

```
1. 客户端: GET /events
2. 服务端推送 connected 事件: { connectionId: "conn_xxx" }
3. 服务端推送 agent_list 事件，包含内置和用户自定义主代理: {
     agents: [
       { id: "general", name: "General", description: "通用主代理" },
       { id: "requirement_analyzer", name: "Requirement Analyzer", description: "需求分析代理" },
       { id: "debugger", name: "Debugger", description: "调试代理" },
       { id: "code_reviewer", name: "Code Reviewer", description: "代码审查专家" }
     ],
     currentAgentId: "general"
   }
```

### 3.2 正常切换主代理（切换到用户自定义主代理）

**场景**: 客户端想从 `general` 切换到用户自定义的 `code_reviewer` 主代理

**预期行为**:

```
1. 客户端发送消息: {
     type: "switch_agent",
     agentId: "code_reviewer"
   }
2. 服务端切换成功，推送 agent_switched 事件: {
     previousAgentId: "general",
     currentAgentId: "code_reviewer",
     agentName: "Code Reviewer"
   }
3. 后续对话使用 code_reviewer 主代理的配置（自定义的系统提示词、工具权限等）
```

### 3.3 切换到非法主代理 ID

**场景**: 客户端请求切换到不存在的 `hacker` 主代理

**预期行为**:

```
1. 客户端发送消息: { type: "switch_agent", agentId: "hacker" }
2. 服务端发现 `hacker` 不是合法主代理ID
3. 服务端推送 error 事件: {
     errorCode: "agent_not_found",
     message: "Invalid agent ID: hacker",
     availableAgents: [
       { id: "general", name: "General", description: "..." },
       { id: "requirement_analyzer", name: "...", description: "..." },
       { id: "debugger", name: "...", description: "..." }
     ]
   }
4. 当前会话保持原有主代理不变
```

### 3.4 多客户端独立切换

**场景**: 客户端 A 和客户端 B 同时连接到同一 SSE 服务端，各自使用不同的 session

**预期行为**:

```
1. 客户端 A 连接，创建 session A，默认使用 general 主代理
2. 客户端 B 连接，创建 session B，默认也使用 general 主代理
3. 客户端 A 切换到 debugger 主代理（仅影响 session A）
4. 客户端 B 仍使用 general 主代理（不受影响）
5. 两个客户端后续对话使用各自独立的主代理配置
```

### 3.5 切换时正在进行对话

**场景**: 客户端在对话进行过程中切换主代理

**预期行为**:

- 切换主代理只影响后续的新对话
- 当前正在进行的对话继续使用切换前的主代理配置完成
- 如果需要在当前对话中立即生效，客户端应先中断当前对话再切换

**并发处理规则**:

- 如果 session 存在进行中的任务（如等待工具确认、API 调用中），`switch_agent` 请求应返回错误，错误码为 `agent_busy`
- 客户端收到 `agent_busy` 错误后，应先发送 `abort` 消息中断当前任务，然后再尝试切换
- 切换成功后，新对话立即使用新主代理配置

### 3.6 切换到空或非法格式的主代理 ID

**场景**: 客户端发送 `switch_agent` 消息时 `agentId` 为空字符串或包含非法字符

**预期行为**:

```
1. 客户端发送消息: { type: "switch_agent", agentId: "" }
2. 服务端验证失败，推送 error 事件: {
     errorCode: "invalid_agent_id",
     message: "agentId cannot be empty",
     availableAgents: [...]
   }

或:

1. 客户端发送消息: { type: "switch_agent", agentId: "Agent@123" }
2. 服务端验证失败（包含非法字符 @），推送 error 事件: {
     errorCode: "invalid_agent_id_format",
     message: "agentId contains invalid characters. Allowed: [a-z0-9_-]",
     availableAgents: [...]
   }
```

## 4. 消息协议规范

### 4.1 新增客户端消息类型

| 消息类型       | 用途                 | 必填字段          | 可选字段             |
| -------------- | -------------------- | ----------------- | -------------------- |
| `switch_agent` | 切换当前会话的主代理 | `agentId: string` | `sessionId?: string` |

**消息结构说明**：

- `agentId`: 目标主代理的唯一标识符，大小写敏感，必须符合 `[a-z0-9_-]+` 格式
- `sessionId`: 目标会话 ID。如果未提供，使用连接关联的默认 session；如果连接未关联任何 session，返回错误

### 4.2 新增服务端事件类型

| 事件类型         | 触发时机           | 数据字段                                      |
| ---------------- | ------------------ | --------------------------------------------- |
| `agent_list`     | 连接建立后自动推送 | `agents: AgentInfo[], currentAgentId: string` |
| `agent_switched` | 主代理切换成功     | `previousAgentId, currentAgentId, agentName`  |
| `error` (扩展)   | 切换失败           | `errorCode, message, availableAgents?`        |

**错误事件错误码定义**：

| errorCode                 | 说明                           | 数据字段                   |
| ------------------------- | ------------------------------ | -------------------------- |
| `invalid_agent_id`        | agentId 为空                   | `message`                  |
| `invalid_agent_id_format` | agentId 格式非法               | `message`                  |
| `agent_not_found`         | 指定的主代理不存在             | `message, availableAgents` |
| `agent_busy`              | session 正忙（有进行中的任务） | `message`                  |
| `session_not_found`       | 指定的 sessionId 不存在        | `message`                  |

### 4.3 会话边界定义

采用 **sessionId 级隔离** 模型：

- 每个 `sessionId` 拥有独立的主代理状态
- 一个 `sessionId` 只对应一个 SSE 连接（当前实现为单对单映射）
- 切换主代理只影响该 `sessionId` 对应的连接
- 如果未提供 `sessionId`，切换操作作用于连接关联的默认 session

**连接与 Session 的绑定规则**：

- SSE 连接建立时（`connected` 事件），连接尚未绑定任何 session
- 客户端通过 `/session/create` 或 `/session/load` 端点创建/加载 session
- session 创建/加载成功后，自动绑定到当前连接
- 绑定后，`switch_agent` 消息可不提供 `sessionId`，自动作用于绑定的 session
- 如果连接未绑定任何 session 且 `switch_agent` 未提供 `sessionId`，返回 `session_not_found` 错误

**时序保证**：

- `connected` 事件发送后，立即发送 `agent_list` 事件
- `agent_list` 发送前，连接不接受任何客户端消息（除了心跳）

**agent_busy 判定标准**：

以服务端 `SSEManager` 中记录的 session 状态为准，以下任一条件成立即判定为"忙"：

- `sessionControllers` 中存在该 sessionId 对应的未完成的 `AbortController`
- `pendingInteractions` 中存在该 sessionId 对应的待处理交互请求（如等待工具确认）

### 4.4 数据结构

```
AgentInfo: {
  id: string,              // 主代理唯一标识，格式：[a-z0-9_-]+
  name: string,            // 显示名称
  description: string      // 描述信息
}

// switch_agent 消息结构
{
  type: "switch_agent",
  agentId: string,         // 目标主代理ID
  sessionId?: string       // 可选，目标会话ID
}

// agent_list 事件数据
{
  agents: AgentInfo[],     // 所有可用主代理列表
  currentAgentId: string   // 当前会话使用的主代理ID
}

// agent_switched 事件数据
{
  previousAgentId: string, // 切换前的主代理ID
  currentAgentId: string,  // 切换后的主代理ID
  agentName: string        // 切换后主代理的显示名称
}

// error 事件数据（切换失败时）
{
  errorCode: string,       // 错误码，见4.2节错误码定义
  message: string,         // 错误描述
  availableAgents?: AgentInfo[]  // 可选，可用主代理列表
}
```
