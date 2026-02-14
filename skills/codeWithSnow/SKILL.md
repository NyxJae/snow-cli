---
name: codeWithSnow
description: 在指定目录启动 Snow SSE 服务,使用 Python 客户端交互,并关闭指定 SSE 实例.
---

# CodeWithSnow SSE Quick Start

## 1. 在指定目录启动 SSE 服务

```bash
# 后台守护进程模式,推荐
snow --sse-daemon --sse-port 9001 --work-dir F:/Projects/snow-cli

# 在任意目录启动,但让 SSE 面向 E 盘项目工作
snow --sse-daemon --sse-port 9001 --work-dir E:/YourProject

# 查看所有 SSE 守护进程状态
snow --sse-status
```

## 2. 使用 Python 脚本与 SSE 服务交互

脚本位置: `skills/codeWithSnow/scripts/snow_client.py`

以下命令默认在仓库根目录 `F:/Projects/snow-cli` 执行.

说明:

- `--host` 非必填,默认即 `localhost`.
- `stdout` 输出 JSON 结果,请从返回体中提取 `session_id` 和 `request_id` 继续交互.

### 2.1 基础连通与对话

```bash
# 健康检查
uv run skills/codeWithSnow/scripts/snow_client.py --port 9001 --health

# 发起对话
uv run skills/codeWithSnow/scripts/snow_client.py --port 9001 -m "请分析当前项目结构"

# 继续会话
uv run skills/codeWithSnow/scripts/snow_client.py --port 9001 -s <session_id> -m "继续"

# 列出主代理
uv run skills/codeWithSnow/scripts/snow_client.py --port 9001 --list-agents
```

### 2.2 切换主代理

```bash
# 仅切换主代理
uv run skills/codeWithSnow/scripts/snow_client.py --port 9001 -s <session_id> --switch-agent debugger

# 切换后立即发送跟进消息
uv run skills/codeWithSnow/scripts/snow_client.py --port 9001 -s <session_id> --switch-agent debugger -m "请继续定位这个报错"
```

### 2.3 工具/敏感命令审批(确认/拒绝)

```bash
# 第1步: 触发审批事件(返回 status=requires_confirmation)
uv run skills/codeWithSnow/scripts/snow_client.py --port 9001 -s <session_id> -m "请删除 temp 目录"

# 第2步A: 同意执行(使用上一步返回的 request_id)
uv run skills/codeWithSnow/scripts/snow_client.py --port 9001 --confirm --request-id <request_id> --session <session_id>

# 第2步B: 拒绝执行
uv run skills/codeWithSnow/scripts/snow_client.py --port 9001 --reject --request-id <request_id> --session <session_id>
```

### 2.4 回答 AI 追问

```bash
# 第1步: 触发提问场景(返回 status=requires_question)
uv run skills/codeWithSnow/scripts/snow_client.py --port 9001 -s <session_id> -m "帮我初始化一个前端项目,技术栈你先问我"

# 第2步: 用 --answer 回答(使用返回的 request_id)
uv run skills/codeWithSnow/scripts/snow_client.py --port 9001 --answer --request-id <request_id> --answer-text "React + TypeScript" --session <session_id>
```

### 2.5 会话管理与中断

```bash
# 列出会话
uv run skills/codeWithSnow/scripts/snow_client.py --port 9001 --list-sessions

# 加载会话并继续
uv run skills/codeWithSnow/scripts/snow_client.py --port 9001 --load-session <session_id> -m "继续上次任务"

# 中断当前会话中的任务
uv run skills/codeWithSnow/scripts/snow_client.py --port 9001 --abort --session <session_id>
```

### 2.6 跨盘(E 盘)项目交互示例

```bash
uv run skills/codeWithSnow/scripts/snow_client.py --port 9001 -m "分析当前 E 盘项目"
```

前提: SSE 已通过 `--work-dir E:/YourProject` 启动,客户端只需连接同一端口即可.

## 3. 关闭指定 SSE 服务

```bash
# 按端口关闭
snow --sse-stop --sse-port 9001

# 或按 PID 关闭
snow --sse-stop <pid>

# 再次确认状态
snow --sse-status
```

## 4. 备注

- `snow --sse-status` 仅显示通过 `--sse-daemon` 启动的守护进程实例.
- `snow --sse-stop` 仅用于停止 `--sse-daemon` 启动的实例.
- 若端口冲突,更换 `--sse-port` 后重试.
- 因为 AI 交互一般时间较长,故当使用命令工具运行 snow_client.py 脚本时,请将超时时间设置为 1个小时以上.
