import type {ChatMessage} from '../../../api/chat.js';
import path from 'path';

/**
 * LAYER 3 PROTECTION: 清理会话消息中的孤立 tool_calls
 *
 * 移除两类有问题的消息:
 * 1. 包含 tool_calls 但没有对应工具结果的 assistant 消息
 * 2. 没有对应 tool_calls 的工具结果消息
 *
 * 这可以防止在工具执行期间强制退出(Ctrl+C/ESC)导致会话存在不完整的 tool_calls 时,
 * OpenAI API 报错.
 *
 * @param messages - 消息数组(将被就地修改)
 */
export function cleanOrphanedToolCalls(messages: ChatMessage[]): void {
	// 构建有工具结果的 tool_call_id 映射
	const toolResultIds = new Set<string>();
	for (const msg of messages) {
		if (msg.role === 'tool' && msg.tool_call_id) {
			toolResultIds.add(msg.tool_call_id);
		}
	}

	// 构建 assistant 消息中声明的 tool_call_id 映射
	const declaredToolCallIds = new Set<string>();
	for (const msg of messages) {
		if (msg.role === 'assistant' && msg.tool_calls) {
			for (const tc of msg.tool_calls) {
				declaredToolCallIds.add(tc.id);
			}
		}
	}

	// 找出需要删除的索引(从后往前遍历,安全删除)
	const indicesToRemove: number[] = [];

	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg) continue; // 跳过 undefined 消息(不应该发生,但 TypeScript 要求检查)

		// 检查包含 tool_calls 的孤立 assistant 消息
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

		// 检查孤立的工具结果消息
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

	// 按逆序删除消息(从末尾到开头)以保持索引有效
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
 * 从工具调用参数中提取文件路径列表
 * 支持单文件路径、文件路径数组、对象数组格式
 */
function extractFilePaths(filePathParam: unknown): string[] {
	// 支持单文件路径字符串
	if (typeof filePathParam === 'string') {
		// 过滤空字符串
		if (filePathParam) {
			return [filePathParam];
		}
		return [];
	}

	// 支持文件路径数组和对象数组格式
	if (Array.isArray(filePathParam)) {
		const paths: string[] = [];
		for (const item of filePathParam) {
			// 支持字符串路径
			if (typeof item === 'string' && item) {
				paths.push(item);
			}
			// 支持对象数组格式 {path: "file.ts"}
			else if (item && typeof item === 'object' && 'path' in item) {
				const pathValue = (item as {path: string}).path;
				if (typeof pathValue === 'string' && pathValue) {
					paths.push(pathValue);
				}
			}
		}
		return paths;
	}

	return [];
}

/**
 * 规范化文件路径
 * - 转换为相对路径(相对于项目根目录)
 * - 移除 "./" 前缀
 * - 规范化路径分隔符
 */
function normalizeFilePath(filePath: string): string {
	try {
		// 获取项目根目录
		const projectRoot = process.cwd();

		// 尝试转换为相对路径
		let relativePath = filePath;
		if (path.isAbsolute(filePath)) {
			try {
				relativePath = path.relative(projectRoot, filePath);
			} catch {
				// 无法转为相对路径,使用原路径
				relativePath = filePath;
			}
		}

		// 如果相对路径以 ".." 开头,说明不在项目内,使用原路径
		if (relativePath.startsWith('..')) {
			relativePath = filePath;
		}

		// 规范化路径
		const normalized = path.normalize(relativePath);

		// 移除 "./" 前缀
		if (normalized.startsWith('./')) {
			return normalized.slice(2);
		}

		return normalized;
	} catch {
		return ''; // 路径无效,返回空字符串
	}
}

/**
 * 检查消息是否为文件读取错误返回
 * 满足以下任一条件即为错误返回:
 * 1. content以"Error:"开头
 * 2. messageStatus === 'error'
 */
function isFileReadError(message: ChatMessage): boolean {
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

	return false;
}

/**
 * 动态精简历史文件读取内容
 *
 * 精简规则:
 * 1. 只精简 filesystem-read 工具的返回内容
 * 2. 每个文件保留最新的 5 次读取
 * 3. 保留所有错误读取
 * 4. 批量读取时,每个文件独立计数
 * 5. 将旧读取替换为"[该文件的历史读取内容已压缩,请参看最新读取结果]"
 *
 * 重要: 此函数修改传入的消息数组,调用方应确保传入的是副本而非原始数据
 * 这样可以确保精简操作只影响发送给API的消息,不修改存储的历史消息
 *
 * @param messages - 消息数组(将被就地修改)
 */
export function simplifyHistoricalFileReads(messages: ChatMessage[]): void {
	const KEEP_RECENT_COUNT = 5; // 每个文件保留最近5次读取

	// ========================================
	// 步骤1: 构建工具调用ID到参数的映射
	// ========================================
	interface ToolCallInfo {
		toolName: string;
		arguments: unknown;
	}

	const toolCallMap = new Map<string, ToolCallInfo>();

	for (const msg of messages) {
		if (msg.role === 'assistant' && msg.tool_calls) {
			for (const tc of msg.tool_calls) {
				try {
					const args = JSON.parse(tc.function.arguments);
					toolCallMap.set(tc.id, {
						toolName: tc.function.name,
						arguments: args,
					});
				} catch (error) {
					// JSON解析失败,跳过该工具调用
					console.warn(
						`[simplifyHistoricalFileReads] Failed to parse tool arguments for tool_call ${tc.id}`,
						error,
					);
				}
			}
		}
	}

	// ========================================
	// 步骤2: 收集所有 filesystem-read 工具返回,按文件分组
	// ========================================
	interface FileReadRecord {
		index: number;
		timestamp: number;
		isError: boolean;
	}

	const fileReadHistory = new Map<string, FileReadRecord[]>();

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg) continue;

		// 只处理有timestamp的tool消息
		if (msg.role !== 'tool' || typeof msg.timestamp !== 'number') {
			continue;
		}

		// 通过 tool_call_id 查找对应的工具调用
		const toolCall = toolCallMap.get(msg.tool_call_id || '');
		if (!toolCall || toolCall.toolName !== 'filesystem-read') {
			continue;
		}

		// 提取文件路径,安全访问 arguments
		let filePathParam: unknown = undefined;
		if (
			toolCall.arguments &&
			typeof toolCall.arguments === 'object' &&
			'filePath' in toolCall.arguments
		) {
			filePathParam = (toolCall.arguments as {filePath: unknown}).filePath;
		}

		const filePaths = extractFilePaths(filePathParam);

		for (const filePath of filePaths) {
			const normalizedPath = normalizeFilePath(filePath);

			// 无法识别的文件路径,跳过
			if (!normalizedPath) {
				continue;
			}

			// 初始化文件的历史记录
			if (!fileReadHistory.has(normalizedPath)) {
				fileReadHistory.set(normalizedPath, []);
			}

			// 判断是否错误
			const isError = isFileReadError(msg);

			// 添加到历史记录
			fileReadHistory.get(normalizedPath)!.push({
				index: i,
				timestamp: msg.timestamp,
				isError,
			});
		}
	}

	// ========================================
	// 步骤3: 对每个文件的读取记录按时间排序,标记需要精简的
	// ========================================
	const indicesToSimplify = new Set<number>();

	for (const [, records] of fileReadHistory) {
		// 按时间戳倒序排序(最新的在前)
		records.sort((a, b) => b.timestamp - a.timestamp);

		// 统计成功读取次数(错误不计入)
		let successCount = 0;
		const successIndices: number[] = [];

		for (const record of records) {
			if (!record.isError) {
				successCount++;
				successIndices.push(record.index);
			}
		}

		// 如果成功读取次数超过 5 次,标记超出部分
		if (successCount > KEEP_RECENT_COUNT) {
			const excessIndices = successIndices.slice(KEEP_RECENT_COUNT); // 从第6个开始
			for (const idx of excessIndices) {
				indicesToSimplify.add(idx);
			}
		}
	}

	// ========================================
	// 步骤4: 执行精简
	// ========================================
	for (const index of indicesToSimplify) {
		const msg = messages[index];
		if (msg) {
			msg.content = '[该文件的历史读取内容已压缩,请参看最新读取结果]';
		}
	}

	// ========================================
	// 步骤5: 日志记录
	// ========================================
	if (indicesToSimplify.size > 0) {
		console.log(
			`[simplifyHistoricalFileReads] Simplified ${indicesToSimplify.size} historical file read results`,
		);
	}
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
 * @param messages - 消息数组(将被就地修改)
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
