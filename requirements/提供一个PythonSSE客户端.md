# 需求文档：Python SSE 客户端

## 1. 项目现状与核心目标

### 1.1 项目现状

Snow CLI 已支持 SSE (Server-Sent Events) 服务模式，允许将 Snow CLI 作为后端服务运行，为外部应用程序提供 AI 能力。现有文档(`docs/usage/zh/20.SSE服务模式.md`) 中已提供了 JavaScript 和 Python 示例代码，但 Python 示例较为简单，缺乏完整的命令行工具功能。

### 1.2 核心目标

在 `skills/codeWithSnow/scripts` 下提供一个可直接运行的 Python 脚本(`skills/codeWithSnow/scripts/snow_client.py`)，作为 SSE 客户端命令行工具，供外部 AI 便捷地使用 Snow CLI 的 SSE 模式。该客户端需功能完善、对 AI 友好，支持完整的 SSE API 功能。

---

## 2. 范围与边界

### 2.1 功能点简述

| 功能点           | 描述                                                                 | 优先级 |
| ---------------- | -------------------------------------------------------------------- | ------ |
| [ ] 连接管理     | 建立/断开 SSE 连接，处理连接错误；**支持自定义端口**（避免端口冲突） | P0     |
| [ ] 文本消息发送 | 发送普通文本消息给 AI                                                | P0     |
| [ ] 流式响应接收 | 实时接收并输出 AI 的流式回复                                         | P0     |
| [ ] 连续对话     | 支持通过 Session ID 维持对话上下文                                   | P0     |
| [ ] 图片消息     | 支持发送图片（本地文件路径或 URL）                                   | P1     |
| [ ] 自动工具确认 | 自动批准安全的工具（非敏感命令）                                     | P0     |
| [ ] YOLO 模式    | 非敏感工具自动批准，敏感工具/提问抛出来需确认，可用 `--no-yolo` 禁用 | P0     |
| [ ] 任务中断     | 支持中断正在执行的任务                                               | P1     |
| [ ] 会话管理     | 列出、加载、删除会话                                                 | P1     |
| [ ] 主代理切换   | 切换当前会话使用的主代理                                             | P1     |
| [ ] 回滚功能     | 支持会话回滚到指定消息点                                             | P2     |
| [ ] 健康检查     | 检查 SSE 服务器状态                                                  | P2     |
| [ ] 工作目录配置 | 由 SSE 服务端启动参数 `--work-dir` 指定,客户端不单独提供该参数       | P0     |

### 2.2 "对 AI 友好"的具体要求

| 特性       | 描述                                                                          |
| ---------- | ----------------------------------------------------------------------------- |
| 简洁接口   | 一行命令即可启动对话，AI 无需关心底层连接细节                                 |
| 结构化输出 | 所有输出采用 JSON 格式，便于 AI 解析处理，输出到 stdout                       |
| 详细日志   | 可选的详细日志模式，输出到 stderr，不影响 stdout JSON 解析                    |
| 清晰错误   | 错误信息明确，包含可能的解决方案建议                                          |
| 自动交互   | **非敏感工具自动批准**；**敏感工具抛出来需要确认**；**AI 提问抛出来需要回答** |
| 中文支持   | 完整支持中文输入输出，无乱码问题                                              |

### 2.3 排除项

- 不支持交互式 UI（TUI 界面）
- 不支持 Plan 模式（项目计划模式）
- 不内置认证机制（假设 SSE 服务器在本地或可信网络）
- 不支持复杂的配置文件（通过命令行参数配置即可）

---

## 3. 使用场景举例

### 例 1: 基础对话

**场景**: AI 想要快速询问 Snow CLI 项目中的一个技术问题.

**输入**:

```bash
python snow_client.py --message "Snow CLI 的 SSE 服务端核心实现文件在哪里?"
```

**预期输出** (JSON 格式):

```json
{
	"status": "success",
	"session_id": "sess_abc123",
	"messages": [
		{
			"role": "user",
			"content": "Snow CLI 的 SSE 服务端核心实现文件在哪里?"
		},
		{
			"role": "assistant",
			"content": "Snow CLI 的 SSE 服务端核心实现文件位于 `source/api/sse-server.ts`。该文件定义了 SSE 事件类型、客户端消息结构以及服务端协议边界。另外还有 `source/utils/sse/sseManager.ts` 负责服务编排和会话交互管理。"
		}
	],
	"usage": {
		"input_tokens": 25,
		"output_tokens": 65
	}
}
```

### 例 2: 连续对话

**场景**: AI 需要进行多轮对话，基于之前的上下文继续提问.

**输入**:

```bash
# 第一轮对话，获取 session_id
python snow_client.py --message "帮我分析这个项目的架构"

# 第二轮对话，使用同一 session 继续
python snow_client.py --message "详细说明 SSE 服务端是如何处理工具确认的?" --session sess_abc123
```

**预期输出**:

```json
{
	"status": "success",
	"session_id": "sess_abc123",
	"messages": [
		{"role": "user", "content": "帮我分析这个项目的架构"},
		{"role": "assistant", "content": "..."},
		{"role": "user", "content": "详细说明 SSE 服务端是如何处理工具确认的?"},
		{"role": "assistant", "content": "SSE 服务端处理工具确认的流程如下..."}
	],
	"usage": {
		"input_tokens": 150,
		"output_tokens": 320
	}
}
```

### 例 3: 发送图片

**场景**: AI 想要让 Snow AI 分析一张图片.

**输入**:

```bash
python snow_client.py --message "分析这张架构图" --image ./diagram.png
```

**预期输出**:

```json
{
	"status": "success",
	"session_id": "sess_def456",
	"messages": [
		{
			"role": "user",
			"content": "分析这张架构图",
			"images": ["diagram.png"]
		},
		{
			"role": "assistant",
			"content": "从这张架构图可以看出，系统采用了..."
		}
	],
	"usage": {
		"input_tokens": 1200,
		"output_tokens": 180
	}
}
```

### 例 4: 会话管理

**场景**: AI 需要列出所有历史会话并加载其中一个.

**输入**:

```bash
# 列出所有会话
python snow_client.py --list-sessions

# 加载特定会话
python snow_client.py --load-session sess_abc123 --message "继续之前的讨论"

# 删除会话
python snow_client.py --delete-session sess_old456
```

**预期输出** (列出会话):

```json
{
	"status": "success",
	"sessions": [
		{
			"id": "sess_abc123",
			"created_at": "2025-12-30T10:00:00Z",
			"updated_at": "2025-12-30T11:30:00Z",
			"message_count": 8,
			"first_message": "帮我分析这个项目的架构"
		},
		{
			"id": "sess_def456",
			"created_at": "2025-12-29T15:20:00Z",
			"updated_at": "2025-12-29T16:00:00Z",
			"message_count": 4,
			"first_message": "分析这张架构图"
		}
	],
	"total": 2
}
```

### 例 5: 主代理切换

**场景**: AI 需要根据任务类型切换到不同的主代理.

**输入**:

```bash
# 先查看可用主代理列表
python snow_client.py --list-agents

# 切换到 Debugger 主代理
python snow_client.py --session sess_abc123 --switch-agent debugger --message "帮我调试这个错误"
```

**预期输出** (列出主代理):

```json
{
	"status": "success",
	"agents": [
		{
			"id": "general",
			"name": "General",
			"description": "通用主代理，适合大多数任务"
		},
		{"id": "debugger", "name": "Debugger", "description": "调试专用主代理"},
		{
			"id": "requirement_analyzer",
			"name": "Requirement Analyzer",
			"description": "需求分析专用主代理"
		}
	]
}
```

说明: `current_agent_id` 为可选字段,仅在服务端事件中可确定当前主代理时返回.

### 例 6: 任务中断

**场景**: AI 发现当前执行的任务需要取消.

**输入**:

```bash
python snow_client.py --abort --session sess_abc123
```

**预期输出**:

```json
{
	"status": "success",
	"message": "任务已中断",
	"session_id": "sess_abc123"
}
```

### 例 7: 边缘情况 - 服务器未启动

**场景**: SSE 服务器未启动时尝试连接.

**输入**:

```bash
python snow_client.py --message "测试连接"
```

**预期输出**:

```json
{
	"status": "error",
	"error_code": "connection_failed",
	"message": "无法连接到 SSE 服务器 (localhost:9001)",
	"suggestion": "请确保 SSE 服务器已启动: snow --sse --sse-port 9001"
}
```

### 例 8: 边缘情况 - 工具执行（自动批准）

**场景**: AI 发送消息触发了非敏感工具调用，客户端自动批准.

**输入**:

```bash
python snow_client.py --message "读取 README.md 文件"
```

**预期输出** (包含工具调用过程):

```json
{
	"status": "success",
	"session_id": "sess_ghi789",
	"messages": [{"role": "user", "content": "读取 README.md 文件"}],
	"tool_calls": [
		{
			"name": "filesystem-read",
			"arguments": {"filePath": "README.md"},
			"status": "auto_approved",
			"result": "..."
		}
	],
	"assistant_response": "README.md 文件内容如下...",
	"usage": {
		"input_tokens": 45,
		"output_tokens": 230
	}
}
```

### 例 9: 边缘情况 - 敏感命令需要确认

**场景**: AI 的请求触发敏感命令（如删除文件），客户端抛出来需要确认.

**第一轮输入**:

```bash
python snow_client.py --message "删除 temp 目录"
```

**第一轮输出** - 客户端抛出需要确认的状态:

```json
{
	"status": "requires_confirmation",
	"session_id": "sess_jkl012",
	"request_id": "req_abc123",
	"tool_call": {
		"function": {
			"name": "terminal-execute",
			"arguments": "{\"command\":\"rm -rf temp\"}"
		}
	},
	"available_options": [
		{"value": "approve", "label": "Approve once"},
		{"value": "reject", "label": "Reject"},
		{"value": "reject_with_reply", "label": "Reject with reply"}
	],
	"message": "需要确认工具执行: terminal-execute"
}
```

**第二轮输入** - 外部 AI 确认执行:

```bash
python snow_client.py --confirm --request-id req_abc123 --session sess_jkl012
```

**第二轮输出** - 继续执行并得到最终结果:

```json
{
	"status": "success",
	"session_id": "sess_jkl012",
	"messages": [
		{"role": "user", "content": "删除 temp 目录"},
		{"role": "assistant", "content": "已删除 temp 目录"}
	],
	"usage": {
		"input_tokens": 15,
		"output_tokens": 8
	}
}
```

**注意**: 敏感判定由服务端处理，客户端只透传服务端返回的 `tool_confirmation_request` 事件内容。外部 AI 需要根据 `request_id` 和 `session_id` 发送确认/拒绝响应。

---

### 例 10: AI 提问需要回答

**场景**: AI 在处理过程中需要向用户提问（如选择选项）.

**第一轮输入**:

```bash
python snow_client.py --message "帮我创建一个项目"
```

**第一轮输出** - AI 需要提问:

```json
{
	"status": "requires_question",
	"session_id": "sess_question789",
	"request_id": "req_question456",
	"question": "请选择项目类型",
	"options": ["React", "Vue", "Angular", "原生 JS"],
	"multi_select": false,
	"message": "AI 需要您回答一个问题"
}
```

**第二轮输入** - 外部 AI 回答问题:

```bash
python snow_client.py --answer --request-id req_question456 --answer-text "React" --session sess_question789
```

**第二轮输出** - 继续执行并得到结果:

```json
{
	"status": "success",
	"session_id": "sess_question789",
	"messages": [
		{"role": "user", "content": "帮我创建一个项目"},
		{"role": "assistant", "content": "好的，我来为您创建一个 React 项目..."}
	],
	"usage": {
		"input_tokens": 20,
		"output_tokens": 150
	}
}
```

---

### 例 11: 提问超时后用普通消息回复

**场景**: 外部 AI 收到提问后转问用户,但用户 5 分钟后才回复,`--answer` 参数已失效.

**第一轮** - AI 提问(同例 10):

```json
{
	"status": "requires_question",
	"session_id": "sess_question789",
	"request_id": "req_question456",
	"question": "请选择项目类型",
	"options": ["React", "Vue", "Angular"],
	"multi_select": false
}
```

**外部 AI 转问用户**: "请选择项目类型: 1.React 2.Vue 3.Angular"

**5 分钟后...用户回复**: "选 React"

**第二轮输入** - 用普通消息继续会话(不用 `--answer`,因为 request_id 已超时):

```bash
python snow_client.py --session sess_question789 --message "选 React"
```

**第二轮输出** - Snow AI 理解上下文并继续:

```json
{
	"status": "success",
	"session_id": "sess_question789",
	"messages": [
		{"role": "user", "content": "帮我创建一个项目"},
		{"role": "assistant", "content": "好的,请选项目类型"},
		{"role": "user", "content": "选 React"},
		{"role": "assistant", "content": "好的,我来为您创建一个 React 项目..."}
	],
	"usage": {
		"input_tokens": 35,
		"output_tokens": 200
	}
}
```

**关键点**:

- 外部 AI 收到 `requires_question` 时保存了问题和选项
- 即使用户回复延迟导致 `request_id` 超时,外部 AI 也知道要回答什么
- 用普通 `--message` 继续会话,Snow AI 能从上下文理解意图

---

### 例 12: 中文支持

**场景**: AI 使用中文进行对话，验证中文输入输出无乱码.

**输入**:

```bash
python snow_client.py --message "请用中文解释 SSE 的工作原理"
```

**预期输出** (JSON 格式，中文正常显示无乱码):

```json
{
	"status": "success",
	"session_id": "sess_chinese456",
	"messages": [
		{
			"role": "user",
			"content": "请用中文解释 SSE 的工作原理"
		},
		{
			"role": "assistant",
			"content": "SSE（Server-Sent Events，服务器发送事件）是一种允许服务器向浏览器推送实时数据的技术..."
		}
	],
	"usage": {
		"input_tokens": 18,
		"output_tokens": 250
	}
}
```

**编码要求**:

- Python 脚本文件本身使用 UTF-8 编码
- 输出到 stdout 的 JSON 使用 UTF-8 编码
- Windows 环境下正确处理控制台编码（chcp 65001）

---

## 4. 命令行接口规范

### 4.1 基本用法

```
python skills/codeWithSnow/scripts/snow_client.py [OPTIONS]
```

### 4.2 参数说明

| 参数               | 简写 | 描述                                                     | 示例                                                                 |
| ------------------ | ---- | -------------------------------------------------------- | -------------------------------------------------------------------- |
| `--message`        | `-m` | 发送的消息内容                                           | `--message "分析代码"`                                               |
| `--session`        | `-s` | 会话 ID，用于连续对话                                    | `--session sess_abc123`                                              |
| `--image`          | `-i` | 图片路径（可多次使用）                                   | `--image pic1.png --image pic2.jpg`                                  |
| `--no-yolo`        |      | 禁用 YOLO 模式（非敏感工具也需确认）                     | `--no-yolo`                                                          |
| `--confirm`        |      | 确认工具执行（需配合 `--request-id`）                    | `--confirm --request-id req_abc --session sess`                      |
| `--reject`         |      | 拒绝工具执行（需配合 `--request-id`）                    | `--reject --request-id req_abc --session sess`                       |
| `--answer`         |      | 回答 AI 提问（需配合 `--request-id` 和 `--answer-text`） | `--answer --request-id req_abc --answer-text "选项A" --session sess` |
| `--request-id`     |      | 请求 ID（用于确认/拒绝/回答）                            | `--request-id req_abc123`                                            |
| `--answer-text`    |      | 回答内容（配合 `--answer` 使用）                         | `--answer-text "我的回答"`                                           |
| `--host`           | `-H` | SSE 服务器地址                                           | `--host localhost`                                                   |
| `--port`           | `-p` | SSE 服务器端口                                           | `--port 9001`                                                        |
| `--list-sessions`  |      | 列出所有会话                                             | `--list-sessions`                                                    |
| `--load-session`   |      | 加载指定会话                                             | `--load-session sess_abc123`                                         |
| `--delete-session` |      | 删除指定会话                                             | `--delete-session sess_abc123`                                       |
| `--abort`          | `-a` | 中断当前会话任务                                         | `--abort --session sess_abc123`                                      |
| `--list-agents`    |      | 列出可用主代理                                           | `--list-agents`                                                      |
| `--switch-agent`   |      | 切换当前会话的主代理                                     | `--switch-agent debugger`                                            |
| `--verbose`        | `-v` | 详细日志模式                                             | `--verbose`                                                          |
| `--help`           | `-h` | 显示帮助信息                                             | `--help`                                                             |

### 4.3 组合使用示例

```bash
# 基础对话（非敏感工具自动批准，敏感工具/提问会抛出来）
python snow_client.py -m "帮我写个函数"

# 禁用自动批准（所有工具都需要确认）
python snow_client.py -m "帮我写个函数" --no-yolo

# 指定服务器地址
python snow_client.py -H 192.168.1.100 -p 9001 -m "分析代码"

# 发送消息并获取详细日志（日志输出到 stderr）
python snow_client.py -m "分析架构" -v

# 创建新会话并发送带图片的消息（本地图片自动转为 base64）
python snow_client.py -m "分析这张图" -i ./screenshot.png

# 继续之前会话的对话
python snow_client.py -s sess_abc123 -m "继续"

# 确认敏感工具执行
python snow_client.py --confirm --request-id req_abc123 --session sess_abc123

# 回答 AI 提问
python snow_client.py --answer --request-id req_question456 --answer-text "选项A" --session sess_abc123

# 列出所有会话
python snow_client.py --list-sessions
```

---

## 5. 默认行为

### 5.1 自动批准策略

| 场景                               | 行为                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 非敏感工具（如 `filesystem-read`） | **默认自动批准**；使用 `--no-yolo` 时抛出来需要确认                                                  |
| 敏感工具（如 `rm -rf`）            | **抛出来需要确认**，输出 `requires_confirmation` 状态，外部 AI 需调用 `--confirm` 或 `--reject` 响应 |
| AI 提问                            | **抛出来需要回答**，输出 `requires_question` 状态，外部 AI 需调用 `--answer` 响应                    |

### 5.2 连接默认配置

| 配置项           | 默认值           |
| ---------------- | ---------------- |
| Host             | `localhost`      |
| Port             | `9001`           |
| 连接超时         | 30 秒            |
| 单次请求完成超时 | 300 秒（5 分钟） |

### 5.3 输出流契约

| 流     | 输出内容       | 说明                                               |
| ------ | -------------- | -------------------------------------------------- |
| stdout | 业务 JSON 数据 | 最终结果，可被 AI 直接解析                         |
| stderr | 日志、调试信息 | 仅在使用 `-v/--verbose` 时输出，不影响 stdout 解析 |

**重要**: AI 解析输出时应只读取 stdout，stderr 用于人工调试。

---

## 6. 错误处理规范

| 错误码                    | 描述               | 示例输出                                                                                                                                                         |
| ------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection_failed`       | 无法连接服务器     | 见例 7                                                                                                                                                           |
| `session_not_found`       | 会话不存在         | `{"status": "error", "error_code": "session_not_found", "message": "No session associated with this connection", "available_agents": [...]}`                     |
| `timeout`                 | 请求超时           | `{"status": "error", "error_code": "timeout", "message": "请求超时（5分钟）"}`                                                                                   |
| `invalid_agent_id`        | 未提供主代理 ID    | `{"status": "error", "error_code": "invalid_agent_id", "message": "agentId cannot be empty", "available_agents": [...]}`                                         |
| `invalid_agent_id_format` | 主代理 ID 格式非法 | `{"status": "error", "error_code": "invalid_agent_id_format", "message": "agentId contains invalid characters. Allowed: [a-z0-9_-]", "available_agents": [...]}` |
| `agent_not_found`         | 主代理不存在       | `{"status": "error", "error_code": "agent_not_found", "message": "Agent not found: xxx", "available_agents": [...]}`                                             |
| `agent_busy`              | 当前主代理忙碌中   | `{"status": "error", "error_code": "agent_busy", "message": "Session is busy with an ongoing task. Please abort first.", "available_agents": [...]}`             |
| `requires_confirmation`   | 需要手动确认       | 见例 9                                                                                                                                                           |

说明: 服务端 SSE error 事件使用 camelCase 字段(如 `errorCode`,`availableAgents`),客户端 stdout JSON 会映射为 snake_case 字段(如 `error_code`,`available_agents`).

---

## 7. 文件位置

| 文件   | 位置                                         | 说明                       |
| ------ | -------------------------------------------- | -------------------------- |
| 主脚本 | `skills/codeWithSnow/scripts/snow_client.py` | 该目录下可直接运行脚本入口 |

---

## 8. 依赖要求

Python 3.8+

默认实现仅依赖 Python 标准库,不要求安装第三方包.

说明: 文档 `docs/usage/zh/20.SSE服务模式.md` 中保留了基于 `requests` + `sseclient` 的示例,仅作可选参考实现,不是本客户端交付的运行前置依赖.

---

## 9. 协议对照表

### 9.1 客户端消息类型 (ClientMessage.type)

参考 `source/api/sse-server.ts` 第 36-62 行:

| type                         | 用途                                       | CLI 参数         |
| ---------------------------- | ------------------------------------------ | ---------------- |
| `chat`                       | 发送普通文本消息                           | `--message`      |
| `image`                      | 发送图片（实际用 `chat` 带 `images` 字段） | `--image`        |
| `tool_confirmation_response` | 响应工具确认请求                           | 内部处理         |
| `user_question_response`     | 响应用户问题请求                           | 内部处理         |
| `abort`                      | 中断当前任务                               | `--abort`        |
| `rollback`                   | 回滚会话                                   | 需补充参数       |
| `switch_agent`               | 切换主代理                                 | `--switch-agent` |

### 9.2 服务端事件类型 (SSEEventType)

参考 `source/api/sse-server.ts` 第 7-21 行:

| 事件类型                    | 说明                | 客户端处理                                   |
| --------------------------- | ------------------- | -------------------------------------------- |
| `connected`                 | 连接成功            | 保存 connectionId                            |
| `message`                   | 消息事件（用户/AI） | 流式输出 AI 回复                             |
| `tool_call`                 | 工具调用通知        | 透传到输出                                   |
| `tool_result`               | 工具执行结果        | 透传到输出                                   |
| `thinking`                  | AI 思考过程         | 可选输出                                     |
| `usage`                     | Token 使用情况      | 汇总到最终结果                               |
| `error`                     | 错误信息            | 输出错误 JSON                                |
| `complete`                  | 对话完成            | 输出最终结果                                 |
| `tool_confirmation_request` | 请求确认工具执行    | 默认自动处理,使用 `--no-yolo` 时输出确认请求 |
| `user_question_request`     | AI 询问用户         | 默认自动处理,使用 `--no-yolo` 时输出问题     |
| `rollback_request`          | 回滚请求            | 透传到输出                                   |
| `rollback_result`           | 回滚结果            | 透传到输出                                   |
| `agent_list`                | 可用主代理列表      | `--list-agents` 时输出                       |
| `agent_switched`            | 主代理切换成功      | 透传到输出                                   |

### 9.3 API 端点对照

参考 `docs/usage/zh/20.SSE服务模式.md`:

| 端点                       | 方法   | 用途           | CLI 参数                  |
| -------------------------- | ------ | -------------- | ------------------------- |
| `/events`                  | GET    | SSE 事件流     | 内部使用                  |
| `/message`                 | POST   | 发送消息       | `--message`, `--abort` 等 |
| `/session/create`          | POST   | 创建新会话     | 内部自动调用              |
| `/session/load`            | POST   | 加载已有会话   | `--load-session`          |
| `/session/list`            | GET    | 获取会话列表   | `--list-sessions`         |
| `/session/rollback-points` | GET    | 获取回滚点列表 | 需补充                    |
| `/session/{id}`            | DELETE | 删除会话       | `--delete-session`        |
| `/health`                  | GET    | 健康检查       | 内部使用                  |

---

## 10. 待补充事项

### 10.1 回滚功能 CLI 设计

服务端 `ClientMessage.rollback` 结构（`source/api/sse-server.ts`）:

```typescript
rollback?: {
    messageIndex: number;
    rollbackFiles: boolean;
    selectedFiles?: string[];
};
```

需要设计 CLI 参数支持回滚操作，例如:

```bash
# 列出回滚点
python snow_client.py --list-rollback-points --session sess_abc123

# 回滚到指定消息索引
python snow_client.py --rollback-to 5 --session sess_abc123

# 回滚并恢复文件
python snow_client.py --rollback-to 5 --rollback-files --session sess_abc123
```

### 10.2 图片处理说明

服务端 `ClientMessage.images` 需要 `base64 data URI` 格式:

```typescript
images?: Array<{
    data: string;      // base64 data URI (data:image/png;base64,...)
    mimeType: string;
}>;
```

客户端处理逻辑:

- 本地图片文件: 读取文件内容，转换为 base64 data URI
- URL: 下载图片内容，转换为 base64 data URI（暂不支持，仅支持本地文件）

---

## 11. 验收标准

- [ ] 脚本可直接运行 `python snow_client.py`
- [ ] 支持所有例 1-9 的使用场景
- [ ] 输出符合 JSON 格式规范
- [ ] 错误信息清晰明确
- [ ] 代码结构清晰，易于维护
- [ ] 有基本的注释说明
- [ ] 遵循协议对照表中的服务端协


 F:/Projects/snow-cli/skills/codeWithSnow/scripts/snow_client.py  和snow 的 sse 有个问题, 似乎是触发了敏感命令后 并没收到批准申请,我们不知道要审批,snow一直等不到审批,就卡住了...你看是 snow sse的问题还是 py脚本的问题...需要的话你可以加日志 
测试方法是 你让snow 后台服务 提交本仓库的暂存区 就能触发敏感命令,当然为了测试,你先别通过审批,先不提交.