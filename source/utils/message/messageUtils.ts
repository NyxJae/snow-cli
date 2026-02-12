import type {ChatMessage} from '../../api/types.js';

/**
 * 对话中的工具调用块定义
 * 工具调用块: assistant消息(包含tool_calls) + 所有关联的tool响应消息
 * 识别工具调用块可以确保在插入新消息时不会打断工具调用的完整性
 */
export interface ToolCallBlock {
	startIndex: number; // assistant消息索引
	endIndex: number; // 最后一个tool响应消息索引
	toolCallIds: string[]; // 此块中的tool_call_id列表
}

/**
 * 识别消息序列中的所有工具调用块
 * 工具调用块需要保持完整性，确保在插入新消息时不会打断工具调用的逻辑
 *
 * 工具调用块包含:
 * - 一个包含tool_calls的assistant消息
 * - 所有匹配tool_call_id的后续tool响应消息
 *
 * @param messages - 聊天消息数组
 * @returns 所有工具调用块的列表，每个块包含起始索引、结束索引和tool_call_id
 *
 * @example
 * ```typescript
 * const blocks = identifyToolCallBlocks(messages);
 * // 返回: [{ startIndex: 5, endIndex: 7, toolCallIds: ['call_123'] }]
 * ```
 */
export function identifyToolCallBlocks(
	messages: ChatMessage[],
): ToolCallBlock[] {
	const blocks: ToolCallBlock[] = [];

	// 遍历消息序列，查找所有工具调用块
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		// 查找包含tool_calls的assistant消息
		if (
			msg?.role === 'assistant' &&
			msg.tool_calls &&
			msg.tool_calls.length > 0
		) {
			// 从assistant消息中提取所有tool_call_ids
			const toolCallIds = msg.tool_calls.map(tc => tc.id);

			// 查找此工具调用块的结束位置
			// 通过查找所有匹配tool_call_id的后续tool消息
			let endIndex = i;
			for (let j = i + 1; j < messages.length; j++) {
				const nextMsg = messages[j];
				if (
					nextMsg?.role === 'tool' &&
					nextMsg.tool_call_id &&
					toolCallIds.includes(nextMsg.tool_call_id)
				) {
					endIndex = j;
				} else if (nextMsg?.role === 'tool') {
					// tool_call_id不同的tool消息 - 不属于此块
					// 但继续扫描其他tool响应
					continue;
				} else {
					// 非tool消息 - 块结束
					break;
				}
			}

			blocks.push({
				startIndex: i,
				endIndex,
				toolCallIds,
			});

			// 跳到此块的结束位置
			i = endIndex;
		}
	}

	return blocks;
}

/**
 * 计算从数组末尾开始的索引位置
 * 此函数用于确定动态插入特殊user消息的目标位置，提高模型注意力和KV缓存命中率
 *
 * @param messages - 聊天消息数组
 * @param fromEnd - 从末尾开始的位置（例如5表示倒数第5条）
 * @returns 计算后的索引位置，如果消息总数不足则返回末尾位置
 *
 * @example
 * ```typescript
 * // 消息总数10条
 * calculateReversePosition(messages, 1); // 返回: 9 (倒数第1条)
 * calculateReversePosition(messages, 5); // 返回: 5 (倒数第5条)
 * calculateReversePosition(messages, 15); // 返回: 10 (不足15条，返回末尾位置)
 * ```
 */
export function calculateReversePosition(
	messages: ChatMessage[],
	fromEnd: number,
): number {
	if (messages.length === 0) {
		return 0;
	}
	const calculatedIndex = messages.length - fromEnd;
	// 如果消息总数不足fromEnd，返回末尾位置（而不是0），避免插入到头部
	if (calculatedIndex < 0) {
		return messages.length;
	}
	return calculatedIndex;
}

/**
 * 查找安全位置插入新消息，确保不打断工具调用块
 * 通过计算倒数第N条位置并避开工具调用块，保证assistant(tool_calls)和tool消息保持相邻
 *
 * @param messages - 聊天消息数组
 * @param targetIndexFromEnd - 从末尾开始的目标位置（默认: 3）
 * @returns 安全的插入位置，如果落在工具调用块内则返回块之前的索引
 *
 * @example
 * ```typescript
 * // 在倒数第3条位置插入，自动避开工具调用块
 * const position = findSafeInsertPosition(messages, 3);
 * ```
 */
export function findSafeInsertPosition(
	messages: ChatMessage[],
	targetIndexFromEnd: number = 3,
): number {
	// 如果没有消息,插入到开头
	if (messages.length === 0) {
		return 0;
	}

	// 计算从末尾开始的目标位置
	let insertPosition = calculateReversePosition(messages, targetIndexFromEnd);

	// 识别所有工具调用块
	const toolCallBlocks = identifyToolCallBlocks(messages);

	// 检查insertPosition是否在任何工具调用块内
	// 如果是,移动到该块之前
	for (const block of toolCallBlocks) {
		if (
			insertPosition >= block.startIndex &&
			insertPosition <= block.endIndex
		) {
			insertPosition = block.startIndex;
			break;
		}
	}

	return insertPosition;
}

/**
 * 查找倒数第N条assistant消息之前的安全插入位置
 *
 * 规则:
 * 1. 从后向前查找倒数第N条assistant消息
 * 2. 插入位置默认是该assistant消息之前
 * 3. 若assistant数量不足N条,回退到第一条assistant之前(若不存在则回退到消息末尾)
 *
 * @param messages - 聊天消息数组
 * @param targetAssistantFromEnd - 倒数第几条assistant消息（默认: 3）
 * @returns 安全的插入位置
 *
 * @example
 * ```typescript
 * // 在倒数第3条assistant之前插入
 * const position = findInsertPositionBeforeNthAssistantFromEnd(messages, 3);
 * ```
 */
export function findInsertPositionBeforeNthAssistantFromEnd(
	messages: ChatMessage[],
	targetAssistantFromEnd: number = 3,
): number {
	if (messages.length === 0) {
		return 0;
	}

	let assistantCount = 0;
	let targetAssistantIndex = -1;

	// 从后向前查找倒数第N条assistant消息
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === 'assistant') {
			assistantCount++;
			if (assistantCount === targetAssistantFromEnd) {
				targetAssistantIndex = i;
				break;
			}
		}
	}

	if (targetAssistantIndex === -1) {
		// assistant数量不足N条时，回退到第一条assistant之前
		for (let i = 0; i < messages.length; i++) {
			if (messages[i]?.role === 'assistant') {
				return i;
			}
		}
		// 没有assistant消息，插入到末尾
		return messages.length;
	}

	// 返回目标assistant消息之前的索引位置
	return targetAssistantIndex;
}

/**
 * 安全地在指定位置插入新消息块
 * 使用不可变操作创建新数组，避免直接修改原数组带来的副作用
 *
 * @param messages - 原始消息数组 (不会被修改)
 * @param newMessages - 要插入的新消息
 * @param insertPosition - 插入位置 (默认: 数组末尾)
 * @returns 插入消息后的新数组
 *
 * @example
 * ```typescript
 * // 在位置5插入两条新消息，返回新数组而非修改原数组
 * const result = insertMessagesAtPosition(messages, newMessages, 5);
 * ```
 */
export function insertMessagesAtPosition(
	messages: ChatMessage[],
	newMessages: ChatMessage[],
	insertPosition: number = messages.length,
): ChatMessage[] {
	// 处理边缘情况
	if (newMessages.length === 0) {
		return [...messages];
	}

	if (messages.length === 0) {
		return [...newMessages];
	}

	// 将insertPosition限制在有效范围内
	const safePosition = Math.max(0, Math.min(insertPosition, messages.length));

	// 创建新数组,在指定位置插入消息
	return [
		...messages.slice(0, safePosition),
		...newMessages,
		...messages.slice(safePosition),
	];
}
