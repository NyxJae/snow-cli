# 多模态工具返回 Bug 修复记录

## 问题概述

外部 MCP 工具返回图片时,在某些 API 适配器中未正确以多模态格式发送给上游 API,导致图片被截断或无法显示.

## 已修复

### 1. `isMultimodalResult` 无法识别裸数组

**根因**: 外部 MCP 服务返回的是裸数组 `[{type:'image',...}]`,不是 `{content: [...]}` 对象结构。

**修复文件**: `source/utils/execution/tokenLimiter.ts`

```typescript
function isMultimodalResult(result: any): boolean {
	if (!result || typeof result !== 'object') return false;

	// 外部 MCP 服务可能返回裸数组: [{type:'image', data:'...', mimeType:'...'}]
	const items = Array.isArray(result) ? result : result.content;
	if (!Array.isArray(items)) return false;

	return items.some(
		(item: any) =>
			item &&
			typeof item === 'object' &&
			(item.type === 'image' || item.type === 'document'),
	);
}
```

### 2. Anthropic 适配器 tool_result 内嵌图片导致中转平台不支持

**根因**: 中转平台通常不支持 `tool_result` 里的多模态图片内容。

**修复策略**: tool_result 只放纯文本,图片作为同一 user 消息的**兄弟 content block** 发送。

**修复文件**: `source/api/anthropic.ts`, 约 line 253-310

```typescript
if (msg.images && msg.images.length > 0) {
	// 中转平台通常不支持 tool_result.content 内嵌图片
	// 策略: tool_result 只放文本, 图片作为同一 user 消息的兄弟 content block
	const textOutput = msg.content || '[Tool returned image(s)]';

	const contentBlocks: any[] = [
		{
			type: 'tool_result',
			tool_use_id: msg.tool_call_id,
			content: textOutput,
		},
		{
			type: 'text',
			text: `[Tool Result Image] The tool "${msg.tool_call_id}" returned the following image(s):`,
		},
	];

	for (const image of msg.images) {
		const imageSource = toAnthropicImageSource(image);
		if (imageSource) {
			if (imageSource.type === 'url') {
				contentBlocks.push({
					type: 'image',
					source: {type: 'url', url: imageSource.url},
				});
			} else {
				contentBlocks.push({
					type: 'image',
					source: imageSource,
				});
			}
		}
	}

	anthropicMessages.push({
		role: 'user',
		content: contentBlocks,
	});
}
```

---

## 待修复 (将来需要时再参考)

### Chat (OpenAI) 适配器

**文件**: `source/api/chat.ts`, `convertToOpenAIMessages` 函数, 约 line 176-222

**现状问题**: 图片直接放在 tool role 消息的 content 数组中(`image_url` 类型),通过中转平台时可能无法正确显示。

**参考实现** (`source/api/responses.ts` line 302-332):

```typescript
// tool 结果只放文本
messages.push({
	role: 'tool',
	tool_call_id: msg.tool_call_id,
	content: msg.content || '',
});

// 图片追加为独立 user 消息
if (msg.images && msg.images.length > 0) {
	const imageContent: any[] = [
		{
			type: 'text',
			text: `[Tool Result Image] The tool "${msg.tool_call_id}" returned the following image(s):`,
		},
	];
	for (const image of msg.images) {
		const imageUrl = toResponseImageUrl(image);
		if (imageUrl) {
			imageContent.push({
				type: 'input_image',
				image_url: imageUrl,
			});
		}
	}
	messages.push({
		role: 'user',
		content: imageContent,
	});
}
```

**Chat 适配器需要修改的位置**:

- 搜索 `case 'tool':` 的处理逻辑
- 当前做法: `content.push({ type: 'image_url', image_url: { url: image.url } })`
- 需要改为: tool 消息只放文本,图片分离到后续的 user 消息中

---

### Gemini 适配器

**文件**: `source/api/gemini.ts`, `convertToGeminiMessages` 函数, 约 line 270-372

**现状问题**: 图片通过 `toGeminiImagePart` 直接放在 tool response 的 parts 中。

**参考实现** (anthropic.ts):

- 检测 `msg.images && msg.images.length > 0`
- tool_result 只放文本
- 图片作为独立的 user message parts

**Gemini 适配器需要修改的位置**:

- 搜索 `role: 'tool'` 的处理逻辑
- 当前做法: parts 中直接包含 image part
- 需要改为: tool role 的 parts 只放文本,图片分离到独立的 user role 消息中

---

## 关键数据流

```
1. mcpToolsManager.ts:1869 - client.callTool() → MCP SDK 返回 CallToolResult
2. mcpToolsManager.ts:1882 - return result.content (裸数组 [{type:'image',...}])
3. mcpToolsManager.ts:1816 - wrapToolResultWithTokenLimit(result, toolName)
4. tokenLimiter.ts - isMultimodalResult(result) 检测是否跳过截断
5. toolExecutor.ts:415 - extractMultimodalContent(toolResult) 提取 {textContent, images}
6. useConversation.ts:1670 - ...result 展开保存到 conversationMessages (保留 images 字段)
7. API 适配器层 - convertToXxxMessages 构建最终发送给 API 的消息
```

---

_修复状态: Anthropic 已修复, Chat/Gemini 待将来按需修复_
