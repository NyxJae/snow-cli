# responses 适配 in_progress 状态

## 现象

在第三方中转场景下, Responses API 不一定持续返回标准 SSE typed event, 可能直接返回 `object: "response"` 的快照对象, 例如:

```json
{
	"object": "response",
	"status": "in_progress",
	"output": []
}
```

或者:

```json
{
	"object": "response",
	"status": "in_progress",
	"output": [
		{
			"type": "function_call",
			"status": "completed"
		}
	]
}
```

旧逻辑的问题有 3 类:

1. `status: "in_progress"` 只被当成空结果, 没被当成 keepalive.
2. 无 `type` 的 `response` 快照对象不会被现有 typed-event 分支消费.
3. `output` 里已经带了 `function_call` / `message` / `reasoning` 时, 客户端仍可能把它当成"没有内容", 进而报 `Empty or insufficient response`.

## 判断结论

用户提供的这类响应, 不一定表示"客户端已经提前断开", 更常见的是:

1. 中转层没有继续按标准 typed SSE 事件往下发.
2. 而是直接回了一个 `response` 快照对象.
3. 快照对象本身已经包含阶段性产物, 只是旧客户端不会消费它.

也就是说, 问题不只是"断开过早", 还包括"协议兼容不完整".

## 本次修复

文件: `source/api/responses.ts`

### 1. keepalive 与 timeout 边界

只有真正产生业务输出时才执行 `guard.touch()`:

- `response.output_text.delta`
- `response.reasoning_summary_text.delta`
- `response.function_call_arguments.delta`
- `response.output_item.added` 中的 `function_call` / `message` / `reasoning`
- 无 `type` 的 `response` 快照中, `output` 已携带 `function_call` / `message` / `reasoning`

以下情况不会刷新 idle timeout:

- 纯 `response.created`
- 纯 `response.in_progress`
- 无 `type` 且 `output` 为空的 `object: "response"` 快照

这样可以保证: 模型如果只是重复汇报"还在处理中", 但长时间没有任何新业务数据, 仍会按超时逻辑停止并走重试/失败路径, 不会被空快照无限续命.

### 2. response 快照 output 兼容

当收到无 `type` 的 `response` 快照对象时, 若 `output` 中包含以下内容, 则转换成现有上层已支持的事件再继续复用原逻辑:

- `function_call` -> 合成为 `response.output_item.added` + `response.output_item.done`
- `reasoning` -> 合成为 `response.output_item.added` + `response.output_item.done`
- `message.content[].type === "output_text"` -> 合成为 `response.output_text.delta` + `response.output_text.done`

这样即使中转层不发 typed delta event, 客户端也能消费快照里的阶段性结果.

### 3. response 终态快照兼容

当收到无 `type` 的 `response` 快照对象且 `status` 为以下值时, 合成终态事件:

- `completed` -> `response.completed`
- `failed` -> `response.failed`
- `cancelled` -> `response.cancelled`

避免因为缺少 typed 终态事件而漏掉结束信号.

### 4. reviewer 指出的回归风险修正

后续 reviewer 指出一个高风险问题:

- 不能对所有 `object: "response"` 都做 output 合成.
- 否则某些本来就带 `type` 的原生事件如果顺带有 `output`, 可能被重复合成, 导致重复文本或重复 tool call.

最终修正为:

- 只有 `!event.type` 的"裸 response 快照对象"才做 output 合成和终态合成.
- 有 `type` 的原生事件继续按原协议透传.

## 修复经验

1. `status: "in_progress"` 不是错误, 而是"还在处理".
2. 对第三方中转要假设它可能返回"快照式 response 对象", 不能只依赖官方 typed SSE event.
3. 兼容层应尽量把特殊输入重新映射回现有事件模型, 复用上层逻辑, 减少改动面.
4. 合成逻辑必须严格收窄到目标场景, 否则很容易引入重复事件回归.
5. 这类问题必须同时看"是否提前断流"和"是否其实收到了数据但没被消费", 两种情况经常混在一起.

## 当前结论

本次问题本质上是:

- 部分是 keepalive 不足.
- 部分是对无 `type` 的 `response` 快照兼容不完整.
- 部分是上层空响应判定过于依赖正文和工具调用, 没把仅含 reasoning 的阶段性结果算作有效响应.

修复后, 客户端会把这类 `response` 快照视为处理中或阶段性结果, 而不是直接当成空响应失败.

## reasoning-only 快照补充说明

下面这种响应虽然没有正文, 也没有工具调用, 但仍然不应该被判定为 `Empty or insufficient response`:

```json
{
	"object": "response",
	"id": "resp_00256b768cec63a20169bbf09d9db881939571feaacd3b87df",
	"created_at": 1773924509,
	"model": "gpt-5.4",
	"output": [
		{
			"id": "rs_00256b768cec63a20169bbf0a2c2748193afaeebd2b2902281",
			"type": "reasoning",
			"status": "in_progress",
			"encrypted_content": "...",
			"summary": [
				{
					"text": "**Ensuring task completion integrity** ...",
					"type": "summary_text"
				}
			]
		}
	],
	"status": "in_progress"
}
```

原因:

1. 它已经携带了有效的 reasoning 对象和 summary.
2. 这说明模型仍在处理中, 而且阶段性思考结果已经返回.
3. 旧逻辑只看 `streamedContent` 和 `receivedToolCalls`, 会把这种 reasoning-only 结果误判为空响应.

本次修复同时补上了这层判定:

- 只要本轮收到了 `receivedReasoning` / `receivedThinking` / `receivedReasoningContent` 任一项, 就不再触发空响应错误.
- 这样可以兼容第三方中转只返回 reasoning 快照的情况.

补充样例 2:

```json
{
	"object": "response",
	"id": "resp_04034d413ddd4f510169be90376f24819a812825f6eeca6113",
	"created_at": 1774096439,
	"model": "gpt-5.4",
	"output": [
		{
			"id": "rs_04034d413ddd4f510169be90383668819aae8e95e2637f6ca9",
			"type": "reasoning",
			"status": "in_progress",
			"encrypted_content": "...",
			"summary": []
		}
	],
	"status": "in_progress"
}
```

这个样例说明:

1. 即使 `summary` 为空, 只要 `reasoning` 对象已经返回, 也说明模型仍在处理中.
2. 对客户端来说, 这类返回仍然属于有效阶段性结果, 不应被判定为 `Empty or insufficient response`.
3. 本次修复的目标不是解密 `encrypted_content`, 而是避免把这种 reasoning-only 快照误当成空响应.
