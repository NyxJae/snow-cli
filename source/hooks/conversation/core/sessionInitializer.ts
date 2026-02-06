import type {ChatMessage} from '../../../api/chat.js';
import {sessionManager} from '../../../utils/session/sessionManager.js';
import {getTodoService} from '../../../utils/execution/mcpToolsManager.js';
import {formatTodoContext} from '../../../utils/core/todoPreprocessor.js';
import {mainAgentManager} from '../../../utils/MainAgentManager.js';
import {getUsefulInfoService} from '../../../utils/execution/mcpToolsManager.js';
import {formatUsefulInfoContext} from '../../../utils/core/usefulInfoPreprocessor.js';
import {formatFolderNotebookContext} from '../../../utils/core/folderNotebookPreprocessor.js';
import {
	findInsertPositionAfterNthToolFromEnd,
	insertMessagesAtPosition,
} from '../../../utils/message/messageUtils.js';
import {getCustomSystemPrompt} from '../../../utils/config/apiConfig.js';

/**
 * 初始化会话和TODO上下文
 *
 * @returns 初始化后的对话消息和会话信息
 * @deprecated planMode 和 vulnerabilityHuntingMode 参数已移除。
 * 现在由 mainAgentManager 管理代理状态。
 */
export async function initializeConversationSession(): Promise<{
	conversationMessages: ChatMessage[];
	currentSession: any;
	existingTodoList: any;
}> {
	// 步骤1: 确保会话存在并获取现有TODO
	let currentSession = sessionManager.getCurrentSession();
	if (!currentSession) {
		// 检查是否在任务模式(临时会话)中运行
		const isTaskMode = process.env['SNOW_TASK_MODE'] === 'true';

		const {clearReadFolders} = await import(
			'../../../utils/core/folderNotebookPreprocessor.js'
		);
		clearReadFolders();

		currentSession = await sessionManager.createNewSession(isTaskMode);
	}

	const todoService = getTodoService();
	const existingTodoList = await todoService.getTodoList(currentSession.id);

	// 步骤1: 构建对话历史，system消息始终为第一条
	// 根据是否有自定义系统提示词来决定 system 消息的内容
	const customSystemPrompt = getCustomSystemPrompt();
	const systemPrompt = customSystemPrompt || mainAgentManager.getSystemPrompt();

	const conversationMessages: ChatMessage[] = [
		{
			role: 'system',
			content: systemPrompt,
		},
	];

	// 添加会话历史消息（包含tool_calls和tool结果）
	// 过滤掉内部子代理消息（标记为subAgentInternal: true）
	// 只保留主代理和用户的消息，避免子代理内部逻辑干扰主代理上下文
	const session = sessionManager.getCurrentSession();
	if (session && session.messages.length > 0) {
		const filteredMessages = session.messages.filter(
			msg => !msg.subAgentInternal,
		);
		conversationMessages.push(...filteredMessages);
	}

	// 步骤2: 收集4类特殊用户消息
	// 这些消息需要动态插入到倒数第3条tool返回之后，提高模型注意力和KV缓存命中率
	const specialUserMessages: ChatMessage[] = [];

	// 1. Agent角色定义(包含mainAgentRole + AGENTS.md + 环境上下文 + 任务完成标识)
	// 确保主代理了解自己的角色和职责
	const currentAgentConfig = mainAgentManager.getCurrentAgentConfig();
	if (currentAgentConfig && currentAgentConfig.mainAgentRole) {
		specialUserMessages.push({
			role: 'user',
			content: mainAgentManager.getSystemPrompt(),
		});
	}

	// 2. TODO list
	if (existingTodoList && existingTodoList.todos.length > 0) {
		const todoContext = formatTodoContext(existingTodoList.todos);
		specialUserMessages.push({
			role: 'user',
			content: todoContext,
		});
	}

	// 3. Useful information
	const usefulInfoService = getUsefulInfoService();
	const usefulInfoList = await usefulInfoService.getUsefulInfoList(
		currentSession.id,
	);

	if (usefulInfoList && usefulInfoList.items.length > 0) {
		const usefulInfoContext = await formatUsefulInfoContext(
			usefulInfoList.items,
		);
		specialUserMessages.push({
			role: 'user',
			content: usefulInfoContext,
		});
	}

	// 4. Folder notebook context
	const folderNotebookContext = formatFolderNotebookContext();
	if (folderNotebookContext) {
		specialUserMessages.push({
			role: 'user',
			content: folderNotebookContext,
		});
	}

	// 步骤3: 在安全位置动态插入特殊用户消息
	if (specialUserMessages.length > 0) {
		// 插入到倒数第3条tool返回之后
		const insertPosition = findInsertPositionAfterNthToolFromEnd(
			conversationMessages,
			3,
		);

		// 确保插入位置至少在system之后（system在第0位）
		const safeInsertPosition = Math.max(1, insertPosition);

		// 使用insertMessagesAtPosition进行插入
		return {
			conversationMessages: insertMessagesAtPosition(
				conversationMessages,
				specialUserMessages,
				safeInsertPosition,
			),
			currentSession,
			existingTodoList,
		};
	}

	return {conversationMessages, currentSession, existingTodoList};
}
