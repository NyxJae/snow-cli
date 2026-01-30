import type {ChatMessage} from '../../../api/chat.js';

/**
 * LAYER 3 PROTECTION: Clean orphaned tool_calls from conversation messages
 *
 * Removes two types of problematic messages:
 * 1. Assistant messages with tool_calls that have no corresponding tool results
 * 2. Tool result messages that have no corresponding tool_calls
 *
 * This prevents OpenAI API errors when sessions have incomplete tool_calls
 * due to force quit (Ctrl+C/ESC) during tool execution.
 *
 * @param messages - Array of conversation messages (will be modified in-place)
 */
export function cleanOrphanedToolCalls(messages: ChatMessage[]): void {
	// Build map of tool_call_ids that have results
	const toolResultIds = new Set<string>();
	for (const msg of messages) {
		if (msg.role === 'tool' && msg.tool_call_id) {
			toolResultIds.add(msg.tool_call_id);
		}
	}

	// Build map of tool_call_ids that are declared in assistant messages
	const declaredToolCallIds = new Set<string>();
	for (const msg of messages) {
		if (msg.role === 'assistant' && msg.tool_calls) {
			for (const tc of msg.tool_calls) {
				declaredToolCallIds.add(tc.id);
			}
		}
	}

	// Find indices to remove (iterate backwards for safe removal)
	const indicesToRemove: number[] = [];

	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg) continue; // Skip undefined messages (should never happen, but TypeScript requires check)

		// Check for orphaned assistant messages with tool_calls
		if (msg.role === 'assistant' && msg.tool_calls) {
			const hasAllResults = msg.tool_calls.every(tc =>
				toolResultIds.has(tc.id),
			);

			if (!hasAllResults) {
				const orphanedIds = msg.tool_calls
					.filter(tc => !toolResultIds.has(tc.id))
					.map(tc => tc.id);

				console.warn(
					'[cleanOrphanedToolCalls] Removing assistant message with orphaned tool_calls',
					{
						messageIndex: i,
						toolCallIds: msg.tool_calls.map(tc => tc.id),
						orphanedIds,
					},
				);

				indicesToRemove.push(i);
			}
		}

		// Check for orphaned tool result messages
		if (msg.role === 'tool' && msg.tool_call_id) {
			if (!declaredToolCallIds.has(msg.tool_call_id)) {
				console.warn('[cleanOrphanedToolCalls] Removing orphaned tool result', {
					messageIndex: i,
					toolCallId: msg.tool_call_id,
				});

				indicesToRemove.push(i);
			}
		}
	}

	// Remove messages in reverse order (from end to start) to preserve indices
	for (const idx of indicesToRemove) {
		messages.splice(idx, 1);
	}

	if (indicesToRemove.length > 0) {
		console.log(
			`[cleanOrphanedToolCalls] Removed ${indicesToRemove.length} orphaned messages from conversation`,
		);
	}
}

/**
 * 检查消息是否来自命令行工具(terminal-execute)
 * 通过检查content是否包含命令执行结果的特征字段来判断
 */
function isTerminalToolResult(message: ChatMessage): boolean {
	if (!message.content || typeof message.content !== 'string') {
		return false;
	}
	const content = message.content;
	// 检查是否包含命令执行结果的特征字段
	return (
		content.includes('"stdout":') ||
		content.includes('"stderr":') ||
		content.includes('"exitCode":')
	);
}

/**
 * 检查消息是否为错误返回
 * 满足以下任一条件即为错误返回:
 * 1. content以"Error:"开头
 * 2. messageStatus === 'error'
 * 3. stderr非空(对于命令行工具)
 */
function isErrorResult(message: ChatMessage): boolean {
	// 方法1: 检查content前缀
	if (
		message.content &&
		typeof message.content === 'string' &&
		message.content.trim().startsWith('Error:')
	) {
		return true;
	}

	// 方法2: 检查messageStatus
	if (message.messageStatus === 'error') {
		return true;
	}

	// 方法3: 检查命令行工具的stderr
	if (isTerminalToolResult(message)) {
		try {
			const result = JSON.parse(message.content);
			if (result.stderr && result.stderr.length > 0) {
				return true;
			}
		} catch {
			// JSON解析失败,忽略
		}
	}

	return false;
}

/**
 * 动态精简过时的命令行工具返回内容
 *
 * 精简规则:
 * 1. 只精简超过15分钟的命令行工具返回内容
 * 2. 保留最近5个工具调用返回内容(无论类型)
 * 3. 保留所有错误返回
 * 4. 将过时的命令返回替换为"此命令返回内容已过时"
 *
 * 重要: 此函数修改传入的消息数组,调用方应确保传入的是副本而非原始数据
 * 这样可以确保精简操作只影响发送给API的消息,不修改存储的历史消息
 *
 * @param messages - Array of conversation messages (will be modified in-place)
 */
export function simplifyOutdatedTerminalResults(messages: ChatMessage[]): void {
	const now = Date.now();
	const TIMEOUT_THRESHOLD = 15 * 60 * 1000; // 15分钟(毫秒)
	const KEEP_RECENT_COUNT = 5; // 保留最近5个工具调用

	// 步骤1: 收集所有工具返回消息(按消息顺序,从后往前)
	interface ToolResultInfo {
		index: number;
		timestamp: number;
		isError: boolean;
		isTerminalTool: boolean;
	}

	const toolResultsByOrder: ToolResultInfo[] = [];

	// 从后往前收集,保持消息顺序(最后的是最近的)
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		// 只处理有timestamp的tool消息
		if (!msg) continue; // 跳过undefined
		if (msg.role === 'tool' && typeof msg.timestamp === 'number') {
			toolResultsByOrder.push({
				index: i,
				timestamp: msg.timestamp,
				isError: isErrorResult(msg),
				isTerminalTool: isTerminalToolResult(msg),
			});
		}
	}

	// 步骤2: 找出需要精简的消息索引
	const indicesToSimplify: number[] = [];

	for (let i = 0; i < toolResultsByOrder.length; i++) {
		const result = toolResultsByOrder[i];
		if (!result) continue; // 跳过undefined

		// 保留最近5个工具调用(无论类型)
		if (i < KEEP_RECENT_COUNT) {
			continue;
		}

		// 保留所有错误返回
		if (result.isError) {
			continue;
		}

		// 只精简命令行工具返回
		if (!result.isTerminalTool) {
			continue;
		}

		// 精简超过15分钟的结果
		if (now - result.timestamp > TIMEOUT_THRESHOLD) {
			indicesToSimplify.push(result.index);
		}
	}

	// 步骤3: 执行精简
	for (const index of indicesToSimplify) {
		const msg = messages[index];
		if (msg) {
			msg.content = '此命令返回内容已过时';
		}
	}

	// 步骤4: 日志记录
	if (indicesToSimplify.length > 0) {
		console.log(
			`[simplifyOutdatedTerminalResults] Simplified ${indicesToSimplify.length} outdated terminal command results`,
		);
	}
}
