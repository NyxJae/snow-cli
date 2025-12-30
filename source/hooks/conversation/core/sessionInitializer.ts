import type {ChatMessage} from '../../../api/chat.js';
import {sessionManager} from '../../../utils/session/sessionManager.js';
import {getTodoService} from '../../../utils/execution/mcpToolsManager.js';
import {formatTodoContext} from '../../../utils/core/todoPreprocessor.js';
import {mainAgentManager} from '../../../utils/MainAgentManager.js';
import {getUsefulInfoService} from '../../../utils/execution/mcpToolsManager.js';
import {formatUsefulInfoContext} from '../../../utils/core/usefulInfoPreprocessor.js';
import {formatFolderNotebookContext} from '../../../utils/core/folderNotebookPreprocessor.js';

/**
 * Initialize conversation session and TODO context
 *
 * @returns Initialized conversation messages and session info
 * @deprecated planMode and vulnerabilityHuntingMode parameters are removed.
 * The agent states are now managed by mainAgentManager.
 */
export async function initializeConversationSession(): Promise<{
	conversationMessages: ChatMessage[];
	currentSession: any;
	existingTodoList: any;
}> {
	// Step 1: Ensure session exists and get existing TODOs
	let currentSession = sessionManager.getCurrentSession();
	if (!currentSession) {
		// Check if running in task mode (temporary session)
		const isTaskMode = process.env['SNOW_TASK_MODE'] === 'true';

		currentSession = await sessionManager.createNewSession(isTaskMode);
	}

	const todoService = getTodoService();
	const existingTodoList = await todoService.getTodoList(currentSession.id);

	// Build conversation history with system prompt from mainAgentManager
	const conversationMessages: ChatMessage[] = [
		{
			role: 'system',
			content: mainAgentManager.getSystemPrompt(),
		},
	];

	// If there are TODOs, add pinned context message at the front
	if (existingTodoList && existingTodoList.todos.length > 0) {
		const todoContext = formatTodoContext(existingTodoList.todos);
		conversationMessages.push({
			role: 'user',
			content: todoContext,
		});
	}

	// Add useful information context if available
	const usefulInfoService = getUsefulInfoService();
	const usefulInfoList = await usefulInfoService.getUsefulInfoList(
		currentSession.id,
	);

	if (usefulInfoList && usefulInfoList.items.length > 0) {
		const usefulInfoContext = await formatUsefulInfoContext(
			usefulInfoList.items,
		);
		conversationMessages.push({
			role: 'user',
			content: usefulInfoContext,
		});
	}

	// Add folder notebook context if available (notes from folders of read files)
	const folderNotebookContext = formatFolderNotebookContext();
	if (folderNotebookContext) {
		conversationMessages.push({
			role: 'user',
			content: folderNotebookContext,
		});
	}

	// Add history messages from session (includes tool_calls and tool results)
	// Filter out internal sub-agent messages (marked with subAgentInternal: true)
	const session = sessionManager.getCurrentSession();
	if (session && session.messages.length > 0) {
		const filteredMessages = session.messages.filter(
			msg => !msg.subAgentInternal,
		);
		conversationMessages.push(...filteredMessages);
	}

	return {conversationMessages, currentSession, existingTodoList};
}
