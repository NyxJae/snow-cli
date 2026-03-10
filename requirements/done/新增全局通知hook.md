c:\Users\Administrator\.snow\hooks
参考项目代码和已有的 hook 脚本

以下是完整的 **Claude Code Hook 协议** 与 **飞书 Webhook 协议** 详细规范，以及可直接复用的 Python 实现。

## 1. Claude Code Hook 事件协议

当 Claude Code 触发 Hook 时，会通过 **stdin** 向脚本发送 JSON 数据：

### 1.1 事件类型与数据结构

| 事件名          | 触发时机         | 数据结构                                   |
| --------------- | ---------------- | ------------------------------------------ |
| `TaskCompleted` | 用户任务执行完毕 | 包含任务主题、描述、ID、耗时、工具调用统计 |
| `TaskStarted`   | 用户任务开始执行 | 包含任务主题、时间戳                       |
| `PreToolUse`    | 工具调用前       | 包含工具名、输入参数                       |
| `PostToolUse`   | 工具调用后       | 包含工具名、输入输出、执行时长             |
| `Notification`  | 需要用户注意时   | 包含标题、内容、级别                       |
| `SessionStart`  | 新会话开始       | 包含工作目录                               |
| `SessionEnd`    | 会话结束         | 包含会话时长统计                           |

### 1.2 TaskCompleted 详细结构（最常用）

```json
{
	"hook_event_name": "TaskCompleted",
	"task_id": "uuid-string",
	"task_subject": "用户输入的原始请求",
	"task_description": "AI 生成的任务描述摘要",
	"start_time": "2026-03-06T10:30:00Z",
	"end_time": "2026-03-06T10:32:15Z",
	"duration_ms": 135000,
	"tools_used": [
		{
			"tool_name": "Read",
			"count": 5
		},
		{
			"tool_name": "Edit",
			"count": 2
		}
	],
	"exit_code": 0,
	"working_directory": "/home/user/project",
	"git_branch": "main",
	"git_commit": "abc123"
}
```

### 1.3 其他 CLI 的适配要点

如果你的类 Claude Code 工具 Hook 机制不同，需要确认：

- **数据传递方式**：stdin (Claude Code) vs 环境变量 vs 命令行参数
- **事件字段名**：是否包含 `hook_event_name`、`task_subject` 等
- **退出码要求**：Claude Code 要求脚本返回 exit code 0，否则认为 Hook 失败

---

## 2. 飞书 Webhook 协议详解

### 2.1 基础请求规范

| 项目             | 规范                                                   |
| ---------------- | ------------------------------------------------------ |
| **HTTP Method**  | POST                                                   |
| **Content-Type** | `application/json`                                     |
| **URL**          | `https://open.feishu.cn/open-apis/bot/v2/hook/{token}` |
| **字符编码**     | UTF-8                                                  |
| **超时建议**     | 10-30 秒                                               |

### 2.2 安全校验机制（签名校验）

如果你开启了"签名校验"，必须在请求体中添加 `timestamp` 和 `sign`：

#### 签名算法步骤：

1. **获取当前时间戳**（秒级）

   ```python
   timestamp = str(int(time.time()))
   ```

2. **构造签名字符串**

   ```
   {timestamp}\n{secret}
   ```

   - `timestamp`：当前时间戳字符串
   - `secret`：飞书机器人设置中的密钥
   - **注意**：中间有换行符 `\n`

3. **HMAC-SHA256 加密**

   ```python
   string_to_sign = f"{timestamp}\n{secret}"
   hmac_obj = hmac.new(
       string_to_sign.encode('utf-8'),
       digestmod=hashlib.sha256
   )
   ```

4. **Base64 编码**

   ```python
   sign = base64.b64encode(hmac_obj.digest()).decode('utf-8')
   ```

5. **完整请求体示例**
   ```json
   {
   	"timestamp": "1709712000",
   	"sign": "Base64EncodedSignature",
   	"msg_type": "text",
   	"content": {
   		"text": "消息内容"
   	}
   }
   ```

#### 时间戳限制：

- 飞书要求 `timestamp` 与服务器当前时间相差 **不超过 1 小时**（3600 秒）
- 如果超时，会返回 `code: 19024, msg: "sign is invalid"`

### 2.3 消息类型与结构体

飞书支持多种消息格式，以下是常用类型：

#### 类型 A：纯文本（text）

最简格式，不支持 Markdown。

```json
{
	"msg_type": "text",
	"content": {
		"text": "任务完成\n项目: xxx\n耗时: 5分钟"
	}
}
```

#### 类型 B：富文本（post）

支持 Markdown、@用户、颜色等，最适合任务通知。

```json
{
	"msg_type": "post",
	"content": {
		"post": {
			"zh_cn": {
				"title": "🤖 Claude Code 任务完成",
				"content": [
					[
						{
							"tag": "text",
							"text": "任务: 重构用户模块"
						}
					],
					[
						{
							"tag": "text",
							"text": "耗时: "
						},
						{
							"tag": "text",
							"text": "5分32秒",
							"style": ["bold", "color"]
						}
					],
					[
						{
							"tag": "a",
							"href": "https://github.com/xxx/commit/abc123",
							"text": "查看提交"
						}
					]
				]
			}
		}
	}
}
```

**支持的 tag 类型**：

- `text`：普通文本，可加 `style`（bold/italic/underline/strikethrough/color）
- `a`：超链接，需 `href`
- `at`：@用户，需 `user_id`（`all` 表示 @所有人）
- `img`：图片（需先上传获取 image_key）

#### 类型 C：交互式卡片（interactive）

最丰富格式，支持按钮、布局、图标等。

```json
{
	"msg_type": "interactive",
	"card": {
		"config": {
			"wide_screen_mode": true
		},
		"header": {
			"title": {
				"tag": "plain_text",
				"content": "✅ 任务执行成功"
			},
			"template": "green"
		},
		"elements": [
			{
				"tag": "div",
				"text": {
					"tag": "lark_md",
					"content": "**任务:** 代码重构\n**分支:** main"
				}
			},
			{
				"tag": "hr"
			},
			{
				"tag": "action",
				"actions": [
					{
						"tag": "button",
						"text": {
							"tag": "plain_text",
							"content": "查看详情"
						},
						"type": "primary",
						"url": "https://github.com/xxx/commit/abc123"
					}
				]
			}
		]
	}
}
```

**header.template** 颜色：

- `red`：错误/警告
- `orange`：提醒
- `green`：成功
- `blue`：信息
- `indigo`/`purple`/`turquoise`/`grey`：其他

### 2.4 响应数据结构

飞书返回统一格式：

```json
{
	"code": 0,
	"msg": "success",
	"data": {}
}
```

**常见错误码**：

- `0`：成功
- `9499`：请求方式错误（需 POST）
- `95004`：IP 不在白名单
- `19021`：timestamp 无效
- `19022`：sign 不匹配
- `19024`：sign 过期（时间差超过 1 小时）

---

## 3. 完整 Python 实现（生产级）

以下代码可直接用于其他 CLI 工具，只需调整 `stdin` 读取部分：

```python
#!/usr/bin/env python3
"""
Claude Code Hook -> 飞书通知适配器
兼容其他 CLI 工具，只需修改 parse_input() 函数
"""

import json
import sys
import os
import hmac
import hashlib
import base64
import time
import urllib.request
import urllib.error
from datetime import datetime
from typing import Dict, Any, Optional

# ============ 配置区（环境变量方式，更安全） ============
FEISHU_WEBHOOK = os.environ.get("FEISHU_WEBHOOK", "")
FEISHU_SECRET = os.environ.get("FEISHU_SECRET", "")

# 如果未设置环境变量，使用硬编码（仅测试用）
if not FEISHU_WEBHOOK:
    FEISHU_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/你的TOKEN"
    FEISHU_SECRET = "你的SECRET"

# ============ Claude Code 事件协议解析 ============

def parse_input() -> Dict[str, Any]:
    """
    从 stdin 读取 Claude Code 传递的事件数据
    适配其他 CLI：修改此函数，从对应来源读取事件
    """
    try:
        input_str = sys.stdin.read()
        if not input_str:
            # 测试模式：模拟 TaskCompleted 事件
            return {
                "hook_event_name": "TaskCompleted",
                "task_subject": "测试任务",
                "task_description": "这是一个测试消息",
                "task_id": "test-123",
                "duration_ms": 125000,
                "tools_used": [{"tool_name": "Read", "count": 3}],
                "git_branch": "main"
            }
        return json.loads(input_str)
    except json.JSONDecodeError as e:
        print(f"[ERROR] JSON 解析失败: {e}", file=sys.stderr)
        sys.exit(1)

def format_duration(ms: int) -> str:
    """格式化毫秒为可读时间"""
    seconds = ms // 1000
    if seconds < 60:
        return f"{seconds}秒"
    minutes = seconds // 60
    secs = seconds % 60
    return f"{minutes}分{secs}秒"

# ============ 飞书协议实现 ============

class FeishuNotifier:
    def __init__(self, webhook: str, secret: Optional[str] = None):
        self.webhook = webhook
        self.secret = secret

    def _gen_sign(self) -> tuple[str, str]:
        """生成飞书签名（算法见文档）"""
        timestamp = str(int(time.time()))
        if not self.secret:
            return timestamp, ""

        # 构造字符串：timestamp\nsecret
        string_to_sign = f"{timestamp}\n{self.secret}"
        hmac_obj = hmac.new(
            string_to_sign.encode("utf-8"),
            digestmod=hashlib.sha256
        )
        sign = base64.b64encode(hmac_obj.digest()).decode("utf-8")
        return timestamp, sign

    def _build_payload(self, event_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        根据事件类型构造飞书消息体
        支持 text/post/interactive 三种格式，可切换
        """
        event_name = event_data.get("hook_event_name", "Unknown")
        task_subject = event_data.get("task_subject", "未命名任务")
        task_desc = event_data.get("task_description", "")
        duration = event_data.get("duration_ms", 0)
        task_id = event_data.get("task_id", "")[:8]  # 取前8位

        # 根据事件类型选择颜色和标题
        if event_name == "TaskCompleted":
            title = "✅ 任务完成"
            template = "green"
        elif event_name == "TaskStarted":
            title = "🚀 任务开始"
            template = "blue"
        elif event_name == "SessionEnd":
            title = "👋 会话结束"
            template = "grey"
        else:
            title = f"📌 {event_name}"
            template = "orange"

        # ===== 方案 1：富文本格式（推荐，平衡简洁与美观）=====
        content_lines = [
            f"**任务:** {task_subject}",
        ]
        if task_desc:
            content_lines.append(f"**描述:** {task_desc}")
        if duration:
            content_lines.append(f"**耗时:** {format_duration(duration)}")
        if "git_branch" in event_data:
            content_lines.append(f"**分支:** `{event_data['git_branch']}`")
        if "tools_used" in event_data:
            tools_str = ", ".join([f"{t['tool_name']}({t['count']})" for t in event_data['tools_used']])
            content_lines.append(f"**工具:** {tools_str}")

        post_content = [[{"tag": "text", "text": line}] for line in content_lines]

        payload = {
            "msg_type": "post",
            "content": {
                "post": {
                    "zh_cn": {
                        "title": f"{title} | {task_id}",
                        "content": post_content
                    }
                }
            }
        }

        # ===== 方案 2：卡片格式（更美观，但 JSON 较大）=====
        # 取消注释以下部分使用卡片格式
        """
        elements = [
            {
                "tag": "div",
                "text": {
                    "tag": "lark_md",
                    "content": f"**{task_subject}**"
                }
            }
        ]

        if task_desc:
            elements.append({
                "tag": "div",
                "text": {
                    "tag": "lark_md",
                    "content": task_desc
                }
            })

        if duration:
            elements.append({
                "tag": "div",
                "text": {
                    "tag": "lark_md",
                    "content": f"⏱️ 耗时: {format_duration(duration)}"
                }
            })

        elements.append({"tag": "hr"})
        elements.append({
            "tag": "note",
            "elements": [{"tag": "plain_text", "content": f"ID: {task_id}"}]
        })

        payload = {
            "msg_type": "interactive",
            "card": {
                "header": {
                    "title": {"tag": "plain_text", "content": title},
                    "template": template
                },
                "elements": elements
            }
        }
        """

        # 添加签名（如启用）
        timestamp, sign = self._gen_sign()
        if sign:
            payload["timestamp"] = timestamp
            payload["sign"] = sign

        return payload

    def send(self, event_data: Dict[str, Any]) -> bool:
        """发送消息到飞书"""
        payload = self._build_payload(event_data)

        headers = {
            "Content-Type": "application/json; charset=utf-8"
        }

        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")

        try:
            req = urllib.request.Request(
                self.webhook,
                data=data,
                headers=headers,
                method="POST"
            )

            with urllib.request.urlopen(req, timeout=15) as resp:
                result = json.loads(resp.read().decode("utf-8"))

                if result.get("code") == 0:
                    print(f"[OK] 飞书通知发送成功 | Event: {event_data.get('hook_event_name')}", file=sys.stderr)
                    return True
                else:
                    error_msg = result.get("msg", "未知错误")
                    print(f"[ERROR] 飞书 API 返回错误: {error_msg} (code: {result.get('code')})", file=sys.stderr)
                    return False

        except urllib.error.HTTPError as e:
            print(f"[ERROR] HTTP 错误 {e.code}: {e.reason}", file=sys.stderr)
            try:
                error_body = e.read().decode("utf-8")
                print(f"[ERROR] 响应内容: {error_body}", file=sys.stderr)
            except:
                pass
            return False
        except Exception as e:
            print(f"[ERROR] 请求异常: {type(e).__name__}: {e}", file=sys.stderr)
            return False

# ============ 主流程 ============

def main():
    # 1. 解析输入（Claude Code 协议）
    event_data = parse_input()

    # 2. 过滤事件（可选）
    # 如果只想处理特定事件，取消注释以下代码
    # allowed_events = ["TaskCompleted", "SessionEnd"]
    # if event_data.get("hook_event_name") not in allowed_events:
    #     print(f"[SKIP] 忽略事件: {event_data.get('hook_event_name')}", file=sys.stderr)
    #     return 0

    # 3. 验证配置
    if not FEISHU_WEBHOOK or "你的TOKEN" in FEISHU_WEBHOOK:
        print("[ERROR] 未配置 FEISHU_WEBHOOK 环境变量", file=sys.stderr)
        return 1

    # 4. 发送通知
    notifier = FeishuNotifier(FEISHU_WEBHOOK, FEISHU_SECRET)
    success = notifier.send(event_data)

    # 5. 返回状态码（Claude Code 要求 0 表示成功）
    return 0 if success else 0  # 即使失败也返回 0，避免阻塞 Claude Code

if __name__ == "__main__":
    sys.exit(main())
```

---

## 4. 适配其他 CLI 工具的修改指南

如果你的工具不是 Claude Code，而是类似 Cursor、Copilot CLI 或自研工具，修改以下部分：

### 修改 1：输入源（第 44 行起）

```python
# 原：从 stdin 读取
def parse_input():
    input_str = sys.stdin.read()
    return json.loads(input_str)

# 改为：从环境变量读取（某些工具）
def parse_input():
    import os
    return {
        "hook_event_name": os.getenv("CLI_EVENT_NAME"),
        "task_subject": os.getenv("CLI_TASK_SUBJECT"),
        # ...
    }

# 改为：从命令行参数读取
def parse_input():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--event', required=True)
    parser.add_argument('--subject', required=True)
    args = parser.parse_args()
    return {
        "hook_event_name": args.event,
        "task_subject": args.subject,
    }
```

### 修改 2：事件字段映射

如果你的工具字段名不同，添加映射层：

```python
def normalize_event(raw_data: dict) -> dict:
    """将其他 CLI 的事件格式转换为 Claude Code 标准格式"""
    field_map = {
        "event": "hook_event_name",
        "task": "task_subject",
        "desc": "task_description",
        "time": "duration_ms"
    }
    return {field_map.get(k, k): v for k, v in raw_data.items()}
```

### 修改 3：配置文件方式

对于不支持 stdin 的工具，改用配置文件：

```python
# hook 触发时，CLI 将事件写入临时文件，然后调用脚本
# 脚本从文件读取
def parse_input():
    import sys
    if len(sys.argv) > 1:
        with open(sys.argv[1], 'r') as f:
            return json.load(f)
    # 回退到 stdin
    return json.load(sys.stdin)
```

---

## 5. 调试与测试

### 本地测试（不依赖 Claude Code）

```bash
# 1. 设置环境变量
export FEISHU_WEBHOOK="https://open.feishu.cn/open-apis/bot/v2/hook/xxxxx"
export FEISHU_SECRET="xxxxx"

# 2. 模拟 TaskCompleted 事件
echo '{
  "hook_event_name": "TaskCompleted",
  "task_subject": "重构订单模块",
  "task_description": "优化数据库查询，添加索引",
  "task_id": "uuid-1234",
  "duration_ms": 185000,
  "git_branch": "feature/order-optimize"
}' | python3 feishu_notify.py

# 3. 查看飞书群是否收到消息
```

### 验证签名算法

```bash
# 测试签名生成是否正确
python3 -c "
import hmac, hashlib, base64, time
secret = 'test-secret'
timestamp = str(int(time.time()))
string = f'{timestamp}\n{secret}'
sign = base64.b64encode(hmac.new(string.encode(), digestmod=hashlib.sha256).digest()).decode()
print(f'Timestamp: {timestamp}')
print(f'Sign: {sign}')
"
```

以上是我搜到的指导

我的需求是在现有的提问和完成任务肯德基础上，在下面新增了一个飞书通知
如果需要什么 ID 或者 Key 啥的，等到最后去来询问我又

---

# 正式需求整理

## 1. 项目现状与核心目标

当前文档前半部分保留为参考资料,用于说明 Claude Code Hook 协议与飞书 Webhook 的实现方式.在此基础上,本次新增的正式需求是: 在现有通知机制保持不变的前提下,补充一个飞书通知渠道,让用户在飞书中同步收到关键事件提醒.

本次整理的目标不是替换现有通知,而是在现有能力之上新增飞书通知,并明确消息内容,来源标识和异常兜底规则,让开发时没有理解偏差.

## 2. 范围与边界

**功能点简述**:

- [ ] 新增飞书通知渠道.
- [ ] 保留现有提问通知和任务完成通知的原有行为.
- [ ] 在提问事件发生时,向飞书发送本次用户提问全文.
- [ ] 在任务完成事件发生时,向飞书发送本次任务最后一条完成信息.
- [ ] 每条飞书消息都要携带当前工作项目名,用于区分多个同时运行的 Snow 实例.
- [ ] 飞书所需 webhook, key, secret 等敏感配置允许后置确认,本轮先明确需求口径.

**排除项**:

- 不替换现有通知机制.
- 不要求在本需求中确定最终的 webhook, token, key 或 secret 实际值.
- 不要求在本需求中扩展到更多无关事件类型.
- 不要求在本需求中设计复杂审批流,交互卡片操作或多级消息分发逻辑.

## 3. 详细需求说明

### 3.1 提问通知

当系统进入"提问"场景时,需要新增一条飞书通知.

该通知的正文必须发送用户本次提问的全文,不能只发送摘要,也不能只发送标题.这样做的原因是,用户希望即使同时开着多个 Snow 实例,也能直接在飞书里看到完整提问内容,不用再回到终端逐个确认.

### 3.2 完成通知

当系统进入"任务完成"场景时,需要新增一条飞书通知.

该通知应优先发送本次任务最后一条完成信息.这里的"最后一条完成信息"指用户在终端最终看到的完成结果文本,而不是通用的任务摘要,也不是自动生成的简短标题.

为避免实现理解偏差,本需求进一步约束为: 完成通知不应默认假设 `TaskCompleted` 事件中天然包含最终完成文本.如果运行环境提供可用于读取最终回复的记录路径或等价来源,应优先从该来源提取最后一条 assistant 完成信息; 只有在无法提取时,才使用统一兜底文案.

如果系统因事件结构限制,暂时拿不到这条最后完成信息,则必须使用统一兜底文案发送通知,例如:"任务已完成".

### 3.3 项目名展示规则

每条飞书消息都必须带项目名.

项目名的展示规则已经明确为: 只显示当前工作目录的最后一级目录名,不显示完整路径.

例如:

- 工作目录为 `F:/Projects/snow-cli`, 飞书中显示项目名 `snow-cli`.
- 工作目录为 `/home/user/demo-app`, 飞书中显示项目名 `demo-app`.

如果 `working_directory` 缺失,为空,或无法正常解析出目录名,则项目名必须使用统一兜底显示 `未识别项目`,不得留空,也不得由开发自行决定其他文案.

这样做是为了在多个 Snow 实例同时运行时,用户能快速判断是哪一个项目发来的消息.

### 3.4 新增而非替换

飞书通知属于新增渠道,不是替换渠道.

也就是说,现有提问通知和任务完成通知如果本来已经存在,仍应继续保留原行为.飞书通知是在此基础上并行增加的一份额外通知.

## 4. 消息内容要求

### 4.1 提问通知内容

至少应包含:

- 事件类型,例如"提问通知".
- 项目名.
- 用户提问全文.

### 4.2 完成通知内容

至少应包含:

- 事件类型,例如"任务完成".
- 项目名.
- 最后一条完成信息,或在取不到时使用兜底文案.

### 4.3 消息格式要求

- 本期飞书通知统一使用 `post` 消息格式,不再使用纯 `text` 作为默认展示方案.
- 这样做的目的是让标题,项目名和正文层次更清晰,飞书中的观感更好,便于快速识别不同事件.
- 提问通知和完成通知都应遵循同一套 `post` 展示风格,避免不同事件的飞书样式差异过大.

### 4.4 内容风格要求

- 内容应以易读为主,不要仅保留技术字段名.
- 应在 `post` 中加入清晰标题,便于快速识别事件类型.
- 标题和正文应有明确层次,至少让用户一眼看出这是提问通知还是完成通知,以及来自哪个项目.

### 4.5 发送失败说明

- 如果飞书通知因 webhook 配置错误,网络异常或飞书服务端返回错误而发送失败,不应影响 Snow 原有任务执行与完成流程.
- 本轮需求只要求明确失败不影响主流程,不要求在需求文档中细化重试,告警或日志策略.

## 5. 举例覆盖需求和边缘情况

**例 1: 单个项目正常提问**

- 当前项目目录: `snow-cli`.
- 用户提问全文: `帮我分析一下当前 requirements 目录里和 hook 相关的文档`.
- 期望飞书消息: 明确显示这是提问通知,项目名为 `snow-cli`, 正文中带完整提问内容.

**例 2: 单个项目正常完成**

- 当前项目目录: `snow-cli`.
- 终端最后一条完成信息: `飞书通知需求已经整理完成,并补充了异常兜底规则`.
- 期望飞书消息: 明确显示这是任务完成通知,项目名为 `snow-cli`, 正文中带这条完成信息.

**例 3: 完成信息暂时无法提取**

- 当前项目目录: `snow-cli`.
- 系统无法拿到最后一条完成信息.
- 期望飞书消息: 仍然发送任务完成通知,项目名为 `snow-cli`, 正文使用兜底文案,例如 `任务已完成`.

**例 4: 多个 Snow 实例同时运行**

- 实例 A 工作目录: `F:/Projects/snow-cli`.
- 实例 B 工作目录: `F:/Projects/another-app`.
- 期望结果: 两边发到飞书的消息都必须带各自项目名,用户看到 `snow-cli` 和 `another-app` 后能立即区分来源.

**例 5: 不应误解为替换现有通知**

- 当前系统本来已有其他通知方式.
- 期望结果: 新增飞书通知后,原有通知能力仍保留,而不是只剩飞书通知.

**例 6: 飞书发送失败**

- 当前项目目录: `snow-cli`.
- 任务本身已经正常完成,但飞书 webhook 配置错误或网络异常,导致飞书发送失败.
- 期望结果: Snow 原有任务流程仍然正常结束,不因为飞书发送失败而把任务整体判定为失败.

**例 7: 项目名无法识别**

- 当前运行环境没有提供可用的 `working_directory`,或该字段无法解析出目录名.
- 期望结果: 飞书消息仍然正常发送,项目名位置统一显示 `未识别项目`,而不是留空.

## 6. 验收口径

以下条件同时满足时,可视为本需求被正确实现:

- 提问事件会新增飞书通知.
- 提问通知中包含用户提问全文.
- 完成事件会新增飞书通知.
- 完成通知中优先包含最后一条完成信息.
- 当最后一条完成信息无法获取时,会发送统一兜底文案.
- 飞书通知统一使用 `post` 消息格式.
- 飞书发送失败不会影响 Snow 原有主流程.
- 每条飞书消息都带项目名,且项目名优先取工作目录最后一级目录名,无法提取时显示 `未识别项目`.
- 现有通知机制未被替换或删除.
- 敏感配置项可在开发落地前最后补充,不影响当前需求定义.

## 7. 待后续补充的信息

以下信息本轮先不阻塞需求整理,可在开发前最后确认:

- 飞书 webhook 地址.
- 是否启用飞书签名 secret.
- 若启用签名,对应 secret 的实际值.
- 如需额外展示时间,分支名或其他字段,届时再单独确认.
