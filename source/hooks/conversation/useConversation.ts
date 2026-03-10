import type React from 'react';
import {encoding_for_model} from 'tiktoken';
import type {ChatMessage} from '../../api/chat.js';
import {mainAgentManager} from '../../utils/MainAgentManager.js';
import {
	collectAllMCPTools,
	getMCPServicesInfo,
	getTodoService,
	getUsefulInfoService,
	type MCPTool,
} from '../../utils/execution/mcpToolsManager.js';
import {filterToolsByMainAgent} from '../../utils/core/toolFilterUtils.js';
import {toolSearchService} from '../../utils/execution/toolSearchService.js';
import {
	executeToolCalls,
	type ToolCall,
} from '../../utils/execution/toolExecutor.js';
import type {SubAgentMessage} from '../../utils/execution/subAgentExecutor.js';
import {getOpenAiConfig} from '../../utils/config/apiConfig.js';
import {getToolSearchEnabled} from '../../utils/config/projectSettings.js';
import {sessionManager} from '../../utils/session/sessionManager.js';
import {formatTodoContext} from '../../utils/core/todoPreprocessor.js';
import {formatUsefulInfoContext} from '../../utils/core/usefulInfoPreprocessor.js';
import {formatFolderNotebookContext} from '../../utils/core/folderNotebookPreprocessor.js';
import {translations} from '../../i18n/translations.js';
import {getCurrentLanguage} from '../../utils/config/languageConfig.js';
import {
	findInsertPositionBeforeNthAssistantFromEnd,
	insertMessagesAtPosition,
} from '../../utils/message/messageUtils.js';
import type {Message} from '../../ui/components/chat/MessageList.js';
import {
	createEmptyResponseError,
	isEmptyResponse,
} from '../../utils/core/emptyResponseDetector.js';
import {estimateFullRequestTokens} from '../../utils/core/tokenEstimator.js';
import {resourceMonitor} from '../../utils/core/resourceMonitor.js';
import type {ConfirmationResult} from '../../ui/components/tools/ToolConfirmation.js';
import {connectionManager} from '../../utils/connection/ConnectionManager.js';
import {cleanOrphanedToolCalls} from './utils/messageCleanup.js';
import {extractThinkingContent} from './utils/thinkingExtractor.js';
import {buildEditorContextContent} from './core/editorContextBuilder.js';
import {handleAutoCompression} from './core/autoCompressHandler.js';
import {handleOnStopHooks} from './core/onStopHookHandler.js';
import {handlePendingMessages} from './core/pendingMessagesHandler.js';
import {initializeConversationSession} from './core/sessionInitializer.js';
import {createStreamGenerator} from './core/streamFactory.js';
import {SubAgentUIHandler} from './core/subAgentMessageHandler.js';
import {processToolCallsAfterStream} from './core/toolCallProcessor.js';
import {resolveToolConfirmations} from './core/toolConfirmationFlow.js';
import {buildToolResultMessages} from './core/toolResultDisplay.js';

/**
 * 交互提问结果.
 */
export type UserQuestionResult = {
	selected: string | string[];
	customInput?: string;
};

/**
 * 会话执行处理参数.
 */
export type ConversationHandlerOptions = {
	userContent: string;
	editorContext?: {
		workspaceFolder?: string;
		activeFile?: string;
		cursorPosition?: {line: number; character: number};
		selectedText?: string;
	};
	imageContents:
		| Array<{type: 'image'; data: string; mimeType: string}>
		| undefined;
	controller: AbortController;
	messages: Message[];
	saveMessage: (message: any) => Promise<void>;
	setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
	setStreamTokenCount: React.Dispatch<React.SetStateAction<number>>;
	requestToolConfirmation: (
		toolCall: ToolCall,
		batchToolNames?: string,
		allTools?: ToolCall[],
	) => Promise<ConfirmationResult>;
	requestUserQuestion: (
		question: string,
		options: string[],
		toolCall: ToolCall,
		multiSelect?: boolean,
	) => Promise<UserQuestionResult>;
	isToolAutoApproved: (toolName: string) => boolean;
	addMultipleToAlwaysApproved: (toolNames: string[]) => void;
	yoloModeRef: React.MutableRefObject<boolean>;
	setContextUsage: React.Dispatch<React.SetStateAction<any>>;
	useBasicModel?: boolean;
	getPendingMessages?: () => Array<{
		text: string;
		images?: Array<{data: string; mimeType: string}>;
	}>;
	clearPendingMessages?: () => void;
	setIsStreaming?: React.Dispatch<React.SetStateAction<boolean>>;
	setIsReasoning?: React.Dispatch<React.SetStateAction<boolean>>;
	setRetryStatus?: React.Dispatch<
		React.SetStateAction<{
			isRetrying: boolean;
			attempt: number;
			nextDelay: number;
			remainingSeconds?: number;
			errorMessage?: string;
		} | null>
	>;
	clearSavedMessages?: () => void;
	setRemountKey?: React.Dispatch<React.SetStateAction<number>>;
	setSnapshotFileCount?: React.Dispatch<
		React.SetStateAction<Map<number, number>>
	>; // Clear snapshot counts after compression
	getCurrentContextPercentage?: () => number; // Get current context percentage from ChatInput
	setCurrentModel?: React.Dispatch<React.SetStateAction<string | null>>; // Set current model name for display
	setIsStopping?: React.Dispatch<React.SetStateAction<boolean>>; // Control stopping state
	/**
	 * Sync AbortController to streamingState.
	 * Used during retry to update controller reference,ensuring ESC interrupt can target the current active controller.
	 */
	setAbortController?: (controller: AbortController) => void;
	onRawSubAgentMessage?: (message: SubAgentMessage) => void; // 可选: 原始子代理消息透传回调(SSE 服务端用于转发事件)
};

/**
 * 执行带工具调用的流式会话,并返回本轮用量统计.
 */
export async function handleConversationWithTools(
	options: ConversationHandlerOptions,
): Promise<{usage: any | null}> {
	const {controller, setRetryStatus, saveMessage, userContent, imageContents} =
		options;

	// Save user message before retry loop to prevent duplicates caused by timing alignment
	try {
		await saveMessage({
			role: 'user',
			content: userContent,
			images: imageContents,
		});
	} catch (error) {
		console.error('Failed to save user message:', error);
	}

	const MAX_RETRIES = 10;
	const RETRY_DELAY = 5000;
	let retryCount = 0;
	let lastError: Error | null = null;

	while (retryCount <= MAX_RETRIES) {
		try {
			// 检查是否是用户主动中断
			if (controller.signal.aborted) {
				throw new Error('Request aborted by user');
			}

			// 重试时创建新controller并同步到streamingState
			// 确保重试/流消费/ESC中断三方使用同一controller引用
			if (retryCount > 0) {
				const newController = new AbortController();
				options.controller = newController;
				// 同步更新到streamingState,确保ESC中断能命中当前有效controller
				if (options.setAbortController) {
					options.setAbortController(newController);
				}
			}

			if (retryCount > 0 && setRetryStatus) {
				setRetryStatus(null);
			}

			// 重试时确保isStreaming状态为true
			if (retryCount > 0 && options.setIsStreaming) {
				options.setIsStreaming(true);
			}

			return await executeWithInternalRetry(options);
		} catch (error) {
			lastError = error as Error;

			const errorMessage = (error as Error).message.toLowerCase();
			const errorCode = (error as any).code;
			const isRetriable =
				errorMessage.includes('timeout') ||
				errorMessage.includes('network') ||
				errorMessage.includes('connection') ||
				errorMessage.includes('ENOTFOUND') ||
				errorMessage.includes('ECONNRESET') ||
				errorMessage.includes('ECONNREFUSED') ||
				errorMessage.includes('500') ||
				errorMessage.includes('502') ||
				errorMessage.includes('503') ||
				errorMessage.includes('504') ||
				errorMessage.includes('fetch failed') ||
				errorMessage.includes('fetcherror') ||
				errorCode === 'EMPTY_RESPONSE' ||
				errorMessage.includes('empty response');

			if (!isRetriable || retryCount >= MAX_RETRIES) {
				throw error;
			}

			retryCount++;
			if (setRetryStatus) {
				const currentLanguage = getCurrentLanguage();
				const t = translations[currentLanguage].chatScreen;
				setRetryStatus({
					isRetrying: true,
					attempt: retryCount,
					nextDelay: RETRY_DELAY,
					remainingSeconds: Math.floor(RETRY_DELAY / 1000),
					errorMessage: t.retryResending
						.replace('{current}', String(retryCount))
						.replace('{max}', String(MAX_RETRIES)),
				});
			}

			// 重试延迟期间保持isStreaming=true,避免"思考中"显示消失
			if (options.setIsStreaming) {
				options.setIsStreaming(true);
			}

			await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
		}
	}

	throw lastError || new Error('Unknown error occurred');
}

function stripSpecialUserMessages(messages: ChatMessage[]): ChatMessage[] {
	return messages.filter(msg => !msg.specialUserMessage);
}

async function refreshMainAgentSpecialUserMessages(
	messages: ChatMessage[],
	sessionId: string,
): Promise<ChatMessage[]> {
	const baseMessages = stripSpecialUserMessages(messages);
	const specialUserMessages: ChatMessage[] = [];

	const currentAgentConfig = mainAgentManager.getCurrentAgentConfig();
	if (currentAgentConfig && currentAgentConfig.mainAgentRole) {
		specialUserMessages.push({
			role: 'user',
			content: mainAgentManager.getMainAgentUserRolePrompt(),
			specialUserMessage: true,
		});
	}

	const todoService = getTodoService();
	const latestTodoList = await todoService.getTodoList(sessionId);
	if (latestTodoList && latestTodoList.todos.length > 0) {
		const todoContext = formatTodoContext(latestTodoList.todos);
		specialUserMessages.push({
			role: 'user',
			content: todoContext,
			specialUserMessage: true,
		});
	}

	const usefulInfoService = getUsefulInfoService();
	const usefulInfoList = await usefulInfoService.getUsefulInfoList(sessionId);
	if (usefulInfoList && usefulInfoList.items.length > 0) {
		const usefulInfoContext = await formatUsefulInfoContext(
			usefulInfoList.items,
		);
		specialUserMessages.push({
			role: 'user',
			content: usefulInfoContext,
			specialUserMessage: true,
		});
	}

	const folderNotebookContext = formatFolderNotebookContext();
	if (folderNotebookContext) {
		specialUserMessages.push({
			role: 'user',
			content: folderNotebookContext,
			specialUserMessage: true,
		});
	}

	if (specialUserMessages.length === 0) {
		return baseMessages;
	}

	const insertPosition = findInsertPositionBeforeNthAssistantFromEnd(
		baseMessages,
		3,
	);
	const safeInsertPosition = Math.max(1, insertPosition);
	return insertMessagesAtPosition(
		baseMessages,
		specialUserMessages,
		safeInsertPosition,
	);
}

async function executeWithInternalRetry(
	options: ConversationHandlerOptions,
): Promise<{usage: any | null}> {
	const {
		userContent,
		editorContext,
		imageContents,
		controller,
		saveMessage,
		setMessages,
		setStreamTokenCount,
		requestToolConfirmation,
		requestUserQuestion,
		isToolAutoApproved,
		addMultipleToAlwaysApproved,
		yoloModeRef,
		setContextUsage,
		setIsReasoning,
		setRetryStatus,
	} = options;

	const addToAlwaysApproved = (toolName: string) => {
		addMultipleToAlwaysApproved([toolName]);
	};

	// Initialize session and TODO context
	let {conversationMessages} = await initializeConversationSession();

	// Collect all MCP tools,按主代理权限过滤并划分初始暴露/可搜索集合后再接入 Tool Search.
	const allMcpTools = await collectAllMCPTools();
	const {allowedTools, initialTools} = filterToolsByMainAgent({
		tools: allMcpTools,
	});
	const allowedMcpTools = allowedTools as MCPTool[];
	const initialMcpTools = initialTools as MCPTool[];

	const servicesInfo = await getMCPServicesInfo();
	toolSearchService.updateRegistry(allowedMcpTools, servicesInfo);

	let activeTools: MCPTool[];
	let discoveredToolNames: Set<string>;
	const useToolSearch = getToolSearchEnabled();

	if (useToolSearch) {
		discoveredToolNames = toolSearchService.extractUsedToolNames(
			conversationMessages as any[],
		);
		activeTools = toolSearchService.buildActiveTools({
			discoveredToolNames,
			initialTools: initialMcpTools,
		});
	} else {
		discoveredToolNames = new Set<string>();
		activeTools = allowedMcpTools;
	}

	cleanOrphanedToolCalls(conversationMessages);

	// ── Build and save user message ──

	const finalUserContent = buildEditorContextContent(
		editorContext,
		userContent,
	);

	conversationMessages.push({
		role: 'user',
		content: finalUserContent,
		images: imageContents,
	});

	// NOTE: User message is saved in handleConversationWithTools BEFORE retry loop
	// to prevent duplicate saves when network errors trigger retries

	// Set conversation context for on-demand snapshot system
	try {
		const {setConversationContext} = await import(
			'../../utils/codebase/conversationContext.js'
		);
		const updatedSession = sessionManager.getCurrentSession();
		if (updatedSession) {
			const {convertSessionMessagesToUI} = await import(
				'../../utils/session/sessionConverter.js'
			);
			const uiMessages = convertSessionMessagesToUI(updatedSession.messages);
			setConversationContext(updatedSession.id, uiMessages.length);
		}
	} catch (error) {
		console.error('Failed to set conversation context:', error);
	}

	// ── Initialize encoder ──

	let encoder: any;
	let encoderFreed = false;
	const freeEncoder = () => {
		if (!encoderFreed && encoder) {
			try {
				encoder.free();
				encoderFreed = true;
				resourceMonitor.trackEncoderFreed();
			} catch (e) {
				console.error('Failed to free encoder:', e);
			}
		}
	};

	// Timer reference for retry status cleanup
	let retryStatusClearTimer: NodeJS.Timeout | null = null;

	try {
		encoder = encoding_for_model('gpt-5');
		resourceMonitor.trackEncoderCreated();
	} catch {
		encoder = encoding_for_model('gpt-3.5-turbo');
		resourceMonitor.trackEncoderCreated();
	}
	setStreamTokenCount(0);

	const config = getOpenAiConfig();
	const model = options.useBasicModel
		? config.basicModel || config.advancedModel || 'gpt-5'
		: config.advancedModel || 'gpt-5';

	if (options.setCurrentModel) {
		options.setCurrentModel(model);
	}

	// ── Main conversation loop ──

	let accumulatedUsage: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
		cache_creation_input_tokens?: number;
		cache_read_input_tokens?: number;
		cached_tokens?: number;
	} | null = null;

	const sessionApprovedTools = new Set<string>();

	try {
		while (true) {
			if (controller.signal.aborted) {
				freeEncoder();
				break;
			}

			const latestSession = sessionManager.getCurrentSession();
			if (latestSession?.id) {
				conversationMessages = await refreshMainAgentSpecialUserMessages(
					conversationMessages,
					latestSession.id,
				);
			}

			const streamResult = await processStreamRound({
				config,
				model,
				conversationMessages,
				activeTools,
				controller,
				encoder,
				setStreamTokenCount,
				setMessages,
				setIsReasoning,
				setRetryStatus,
				setContextUsage,
				options,
			});

			setStreamTokenCount(0);
			accumulatedUsage = mergeUsage(accumulatedUsage, streamResult.roundUsage);

			// ── Handle tool calls ──
			if (
				(!streamResult.streamedContent ||
					isEmptyResponse(streamResult.streamedContent)) &&
				(!streamResult.receivedToolCalls ||
					streamResult.receivedToolCalls.length === 0)
			) {
				freeEncoder();
				throw createEmptyResponseError(streamResult.streamedContent || '');
			}

			if (
				streamResult.receivedToolCalls &&
				streamResult.receivedToolCalls.length > 0
			) {
				const toolLoopResult = await handleToolCallRound({
					streamResult,
					conversationMessages,
					activeTools,
					discoveredToolNames,
					useToolSearch,
					controller,
					encoder,
					accumulatedUsage,
					sessionApprovedTools,
					freeEncoder,
					saveMessage,
					setMessages,
					setStreamTokenCount,
					setContextUsage,
					requestToolConfirmation,
					requestUserQuestion,
					isToolAutoApproved,
					addMultipleToAlwaysApproved,
					addToAlwaysApproved,
					yoloModeRef,
					options,
				});

				if (toolLoopResult.type === 'break') {
					if (toolLoopResult.accumulatedUsage !== undefined) {
						accumulatedUsage = toolLoopResult.accumulatedUsage;
					}
					freeEncoder();
					break;
				}
				if (toolLoopResult.type === 'return') {
					return {usage: toolLoopResult.accumulatedUsage};
				}
				if (toolLoopResult.accumulatedUsage !== undefined) {
					accumulatedUsage = toolLoopResult.accumulatedUsage;
				}
				continue;
			}

			// ── No tool calls — final text response ──
			if (streamResult.streamedContent.trim()) {
				if (!streamResult.hasStreamedLines) {
					const finalAssistantMessage: Message = {
						role: 'assistant',
						content: streamResult.streamedContent.trim(),
						streaming: false,
						discontinued: controller.signal.aborted,
						thinking: extractThinkingContent(
							streamResult.receivedThinking,
							streamResult.receivedReasoning,
							streamResult.receivedReasoningContent,
						),
					};
					setMessages(prev => [...prev, finalAssistantMessage]);
				}

				const assistantMessage: ChatMessage = {
					role: 'assistant',
					content: streamResult.streamedContent.trim(),
					reasoning: streamResult.receivedReasoning,
					thinking: streamResult.receivedThinking,
					reasoning_content: streamResult.receivedReasoningContent,
				};
				conversationMessages.push(assistantMessage);
				saveMessage(assistantMessage).catch(error => {
					console.error('Failed to save assistant message:', error);
				});
			}

			// ── onStop hooks ──
			if (!controller.signal.aborted) {
				const hookResult = await handleOnStopHooks({
					conversationMessages,
					saveMessage,
					setMessages,
				});
				if (hookResult.shouldContinue) {
					continue;
				}
			}

			break;
		}

		freeEncoder();
	} finally {
		if (retryStatusClearTimer) {
			clearTimeout(retryStatusClearTimer);
			retryStatusClearTimer = null;
		}

		if (options.setIsStreaming) {
			options.setIsStreaming(false);
		}
		if (options.setIsStopping) {
			options.setIsStopping(false);
		}

		try {
			await connectionManager.notifyMessageProcessingCompleted();
		} catch {
			// Ignore notification errors
		}

		try {
			const {clearConversationContext} = await import(
				'../../utils/codebase/conversationContext.js'
			);
			clearConversationContext();
		} catch {
			// Ignore errors during cleanup
		}

		freeEncoder();
	}

	return {usage: accumulatedUsage};
}

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

type StreamRoundResult = {
	streamedContent: string;
	receivedToolCalls: ToolCall[] | undefined;
	receivedReasoning: any;
	receivedThinking:
		| {type: 'thinking'; thinking: string; signature?: string}
		| undefined;
	receivedReasoningContent: string | undefined;
	roundUsage: typeof tmpUsage | null;
	hasStreamedLines: boolean;
};

// Placeholder type for usage — mirrors the accumulated shape
const tmpUsage = {
	prompt_tokens: 0,
	completion_tokens: 0,
	total_tokens: 0,
	cache_creation_input_tokens: undefined as number | undefined,
	cache_read_input_tokens: undefined as number | undefined,
	cached_tokens: undefined as number | undefined,
};

async function processStreamRound(ctx: {
	config: any;
	model: string;
	conversationMessages: ChatMessage[];
	activeTools: MCPTool[];
	controller: AbortController;
	encoder: any;
	setStreamTokenCount: React.Dispatch<React.SetStateAction<number>>;
	setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
	setIsReasoning?: React.Dispatch<React.SetStateAction<boolean>>;
	setRetryStatus?: React.Dispatch<React.SetStateAction<any>>;
	setContextUsage: React.Dispatch<React.SetStateAction<any>>;
	options: ConversationHandlerOptions;
}): Promise<StreamRoundResult> {
	const {
		config,
		model,
		conversationMessages,
		activeTools,
		controller,
		encoder,
		setStreamTokenCount,
		setMessages,
		setIsReasoning,
		setRetryStatus,
		setContextUsage,
		options,
	} = ctx;

	let streamedContent = '';
	let receivedToolCalls: ToolCall[] | undefined;
	let receivedReasoning: any;
	let receivedThinking:
		| {type: 'thinking'; thinking: string; signature?: string}
		| undefined;
	let receivedReasoningContent: string | undefined;
	let hasStartedReasoning = false;
	let currentTokenCount = 0;
	let lastTokenUpdateTime = 0;
	const TOKEN_UPDATE_INTERVAL = 100;
	let chunkCount = 0;
	let roundUsage: typeof tmpUsage | null = null;

	const streamingEnabled = config.streamingDisplay !== false;

	let thinkingLineBuffer = '';
	let contentLineBuffer = '';
	let isFirstStreamLine = true;
	let hasEmittedThinkingLines = false;
	let hasStartedContent = false;
	let hasStreamedLines = false;

	const pendingStreamLines: Message[] = [];
	let lastFlushTime = 0;
	const STREAM_FLUSH_INTERVAL = 80;

	const flushStreamLines = () => {
		if (pendingStreamLines.length === 0) return;
		const batch = [...pendingStreamLines];
		pendingStreamLines.length = 0;
		setMessages(prev => [...prev, ...batch]);
		lastFlushTime = Date.now();
	};

	const emitStreamLine = (content: string, isThinking: boolean) => {
		if (!streamingEnabled) return;
		const isFirst = isFirstStreamLine;
		const isFirstContent = !isThinking && !hasStartedContent;
		if (isFirst) isFirstStreamLine = false;
		if (isFirstContent) hasStartedContent = true;
		if (isThinking) hasEmittedThinkingLines = true;
		hasStreamedLines = true;
		pendingStreamLines.push({
			role: 'assistant' as const,
			content,
			streamingLine: true,
			isThinkingLine: isThinking,
			isFirstStreamLine: isFirst,
			isFirstContentLine: isFirstContent,
		});
		const now = Date.now();
		if (now - lastFlushTime >= STREAM_FLUSH_INTERVAL) {
			flushStreamLines();
		}
	};

	let inCodeBlock = false;
	let codeBlockBuffer = '';
	let tableBuffer = '';
	let listBuffer = '';

	const isTableRow = (line: string): boolean => {
		const t = line.trim();
		return t.startsWith('|') && t.endsWith('|') && t.length > 2;
	};

	const isListItemLine = (line: string): boolean =>
		/^\s*\d+[.)]\s/.test(line) || /^\s*[-*+]\s/.test(line);

	const processContentLine = (line: string) => {
		if (inCodeBlock) {
			codeBlockBuffer += line + '\n';
			if (line.trimStart().startsWith('```')) {
				inCodeBlock = false;
				emitStreamLine(codeBlockBuffer.trimEnd(), false);
				codeBlockBuffer = '';
			}
			return;
		}
		if (line.trimStart().startsWith('```')) {
			if (tableBuffer) {
				emitStreamLine(tableBuffer.trimEnd(), false);
				tableBuffer = '';
			}
			if (listBuffer) {
				emitStreamLine(listBuffer.trimEnd(), false);
				listBuffer = '';
			}
			inCodeBlock = true;
			codeBlockBuffer = line + '\n';
			return;
		}
		if (isTableRow(line)) {
			if (listBuffer) {
				emitStreamLine(listBuffer.trimEnd(), false);
				listBuffer = '';
			}
			tableBuffer += line + '\n';
			return;
		}
		if (tableBuffer) {
			emitStreamLine(tableBuffer.trimEnd(), false);
			tableBuffer = '';
		}
		if (isListItemLine(line)) {
			listBuffer += line + '\n';
			return;
		}
		if (listBuffer && (line.trim() === '' || /^\s{2,}/.test(line))) {
			listBuffer += line + '\n';
			return;
		}
		if (listBuffer) {
			emitStreamLine(listBuffer.trimEnd(), false);
			listBuffer = '';
		}
		emitStreamLine(line, false);
	};

	const currentSession = sessionManager.getCurrentSession();

	const onRetry = (error: Error, attempt: number, nextDelay: number) => {
		if (setRetryStatus) {
			setRetryStatus({
				isRetrying: true,
				attempt,
				nextDelay,
				errorMessage: error.message,
			});
		}
	};

	try {
		const estimatedPromptTokens = await estimateFullRequestTokens(
			conversationMessages,
			activeTools.length > 0 ? activeTools : undefined,
			model,
		);
		const maxTokens = config.maxContextTokens || config.maxTokens || 200000;
		const percentage = Math.min(
			100,
			Math.floor((estimatedPromptTokens / maxTokens) * 100),
		);
		setContextUsage({
			prompt_tokens: estimatedPromptTokens,
			completion_tokens: 0,
			total_tokens: estimatedPromptTokens,
			percentage,
			maxTokens,
		});
	} catch {
		// Ignore estimation failures and keep previous context usage.
	}

	const streamGenerator = createStreamGenerator({
		config,
		model,
		conversationMessages,
		activeTools,
		sessionId: currentSession?.id,
		useBasicModel: options.useBasicModel,
		signal: controller.signal,
		onRetry,
	});

	const countTokens = (text: string) => {
		try {
			const deltaTokens = encoder.encode(text);
			currentTokenCount += deltaTokens.length;
			const now = Date.now();
			if (now - lastTokenUpdateTime >= TOKEN_UPDATE_INTERVAL) {
				setStreamTokenCount(currentTokenCount);
				lastTokenUpdateTime = now;
			}
		} catch {
			// Ignore encoding errors
		}
	};

	for await (const chunk of streamGenerator) {
		if (controller.signal.aborted) break;

		chunkCount++;
		if (setRetryStatus && chunkCount === 1) {
			setTimeout(() => setRetryStatus(null), 500);
		}

		if (chunk.type === 'reasoning_started') {
			setIsReasoning?.(true);
		} else if (chunk.type === 'reasoning_delta' && chunk.delta) {
			if (!hasStartedReasoning) {
				setIsReasoning?.(true);
				hasStartedReasoning = true;
			}
			countTokens(chunk.delta);

			thinkingLineBuffer += chunk.delta;
			const thinkLines = thinkingLineBuffer.split('\n');
			for (let i = 0; i < thinkLines.length - 1; i++) {
				const cleaned = (thinkLines[i] ?? '').replace(
					/\s*<\/?think(?:ing)?>\s*/gi,
					'',
				);
				if (cleaned || hasStreamedLines) {
					emitStreamLine(cleaned, true);
				}
			}
			thinkingLineBuffer = thinkLines[thinkLines.length - 1] ?? '';
		} else if (chunk.type === 'content' && chunk.content) {
			setIsReasoning?.(false);
			streamedContent += chunk.content;
			countTokens(chunk.content);

			if (hasEmittedThinkingLines && !hasStartedContent) {
				if (thinkingLineBuffer) {
					const cleaned = thinkingLineBuffer.replace(
						/\s*<\/?think(?:ing)?>\s*/gi,
						'',
					);
					if (cleaned.trim()) {
						emitStreamLine(cleaned, true);
					}
					thinkingLineBuffer = '';
				}
			}

			contentLineBuffer += chunk.content;
			const contentLines = contentLineBuffer.split('\n');
			for (let i = 0; i < contentLines.length - 1; i++) {
				processContentLine(contentLines[i] ?? '');
			}
			contentLineBuffer = contentLines[contentLines.length - 1] ?? '';
		} else if (chunk.type === 'tool_call_delta' && chunk.delta) {
			setIsReasoning?.(false);
			countTokens(chunk.delta);
		} else if (chunk.type === 'tool_calls' && chunk.tool_calls) {
			receivedToolCalls = chunk.tool_calls;
		} else if (chunk.type === 'reasoning_data' && chunk.reasoning) {
			receivedReasoning = chunk.reasoning;
		} else if (chunk.type === 'done') {
			if ((chunk as any).thinking) {
				receivedThinking = (chunk as any).thinking;
			}
			if ((chunk as any).reasoning_content) {
				receivedReasoningContent = (chunk as any).reasoning_content;
			}
		} else if (chunk.type === 'usage' && chunk.usage) {
			setContextUsage(chunk.usage);
			roundUsage = {
				prompt_tokens: chunk.usage.prompt_tokens || 0,
				completion_tokens: chunk.usage.completion_tokens || 0,
				total_tokens: chunk.usage.total_tokens || 0,
				cache_creation_input_tokens: chunk.usage.cache_creation_input_tokens,
				cache_read_input_tokens: chunk.usage.cache_read_input_tokens,
				cached_tokens: chunk.usage.cached_tokens,
			};
		}
	}

	if (thinkingLineBuffer) {
		const cleaned = thinkingLineBuffer.replace(
			/\s*<\/?think(?:ing)?>\s*/gi,
			'',
		);
		if (cleaned.trim()) {
			emitStreamLine(cleaned, true);
		}
	}
	if (contentLineBuffer.trim()) {
		processContentLine(contentLineBuffer);
		contentLineBuffer = '';
	}
	if (codeBlockBuffer) {
		emitStreamLine(codeBlockBuffer.trimEnd(), false);
	}
	if (tableBuffer) {
		emitStreamLine(tableBuffer.trimEnd(), false);
	}
	if (listBuffer) {
		emitStreamLine(listBuffer.trimEnd(), false);
	}
	flushStreamLines();

	return {
		streamedContent,
		receivedToolCalls,
		receivedReasoning,
		receivedThinking,
		receivedReasoningContent,
		roundUsage,
		hasStreamedLines,
	};
}

function mergeUsage(accumulated: any | null, round: any | null): any | null {
	if (!round) return accumulated;
	if (!accumulated) return round;
	return {
		prompt_tokens: accumulated.prompt_tokens + (round.prompt_tokens || 0),
		completion_tokens:
			accumulated.completion_tokens + (round.completion_tokens || 0),
		total_tokens: accumulated.total_tokens + (round.total_tokens || 0),
		cache_creation_input_tokens:
			round.cache_creation_input_tokens !== undefined
				? (accumulated.cache_creation_input_tokens || 0) +
				  round.cache_creation_input_tokens
				: accumulated.cache_creation_input_tokens,
		cache_read_input_tokens:
			round.cache_read_input_tokens !== undefined
				? (accumulated.cache_read_input_tokens || 0) +
				  round.cache_read_input_tokens
				: accumulated.cache_read_input_tokens,
		cached_tokens:
			round.cached_tokens !== undefined
				? (accumulated.cached_tokens || 0) + round.cached_tokens
				: accumulated.cached_tokens,
	};
}

type ToolCallRoundResult =
	| {type: 'continue'; accumulatedUsage?: any}
	| {type: 'break'; accumulatedUsage?: any}
	| {type: 'return'; accumulatedUsage: any};

async function handleToolCallRound(ctx: {
	streamResult: StreamRoundResult;
	conversationMessages: any[];
	activeTools: MCPTool[];
	discoveredToolNames: Set<string>;
	useToolSearch: boolean;
	controller: AbortController;
	encoder: any;
	accumulatedUsage: any;
	sessionApprovedTools: Set<string>;
	freeEncoder: () => void;
	saveMessage: (message: any) => Promise<void>;
	setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
	setStreamTokenCount: React.Dispatch<React.SetStateAction<number>>;
	setContextUsage: React.Dispatch<React.SetStateAction<any>>;
	requestToolConfirmation: (
		toolCall: ToolCall,
		batchToolNames?: string,
		allTools?: ToolCall[],
	) => Promise<ConfirmationResult>;
	requestUserQuestion: (
		question: string,
		options: string[],
		toolCall: ToolCall,
		multiSelect?: boolean,
	) => Promise<UserQuestionResult>;
	isToolAutoApproved: (toolName: string) => boolean;
	addMultipleToAlwaysApproved: (toolNames: string[]) => void;
	addToAlwaysApproved: (toolName: string) => void;
	yoloModeRef: React.MutableRefObject<boolean>;
	options: ConversationHandlerOptions;
}): Promise<ToolCallRoundResult> {
	const {
		streamResult,
		conversationMessages,
		activeTools,
		discoveredToolNames,
		useToolSearch,
		controller,
		encoder,
		sessionApprovedTools,
		freeEncoder,
		saveMessage,
		setMessages,
		setStreamTokenCount,
		setContextUsage,
		requestToolConfirmation,
		requestUserQuestion,
		isToolAutoApproved,
		addMultipleToAlwaysApproved,
		addToAlwaysApproved,
		yoloModeRef,
		options,
	} = ctx;
	let {accumulatedUsage} = ctx;

	const receivedToolCalls = streamResult.receivedToolCalls!;

	// Save assistant message with tool_calls
	const {parallelGroupId} = await processToolCallsAfterStream({
		receivedToolCalls,
		streamedContent: streamResult.streamedContent,
		receivedReasoning: streamResult.receivedReasoning,
		receivedThinking: streamResult.receivedThinking,
		receivedReasoningContent: streamResult.receivedReasoningContent,
		conversationMessages,
		saveMessage,
		setMessages,
		extractThinkingContent,
		hasStreamedLines: streamResult.hasStreamedLines,
	});

	// ── Resolve tool confirmations ──

	const confirmResult = await resolveToolConfirmations({
		receivedToolCalls,
		isToolAutoApproved,
		sessionApprovedTools,
		yoloMode: yoloModeRef.current,
		requestToolConfirmation,
		addMultipleToAlwaysApproved,
		conversationMessages,
		accumulatedUsage,
		saveMessage,
		setMessages,
		setIsStreaming: options.setIsStreaming
			? (v: boolean) => options.setIsStreaming!(v)
			: undefined,
		freeEncoder,
	});

	if (confirmResult.type === 'rejected') {
		if (confirmResult.shouldContinue) {
			return {type: 'continue'};
		}
		return {type: 'return', accumulatedUsage: confirmResult.accumulatedUsage};
	}

	const approvedTools = confirmResult.approvedTools;

	// ── Check abort before execution ──

	if (controller.signal.aborted) {
		for (const toolCall of approvedTools) {
			const abortedResult = {
				role: 'tool' as const,
				tool_call_id: toolCall.id,
				content: 'Tool execution aborted by user',
				messageStatus: 'error' as const,
			};
			conversationMessages.push(abortedResult);
			await saveMessage(abortedResult);
		}
		freeEncoder();
		return {type: 'break'};
	}

	// ── Execute tools ──

	const subAgentHandler = new SubAgentUIHandler(
		encoder,
		setStreamTokenCount,
		saveMessage,
	);

	const toolResults = await executeToolCalls(
		approvedTools,
		controller.signal,
		setStreamTokenCount,
		async subAgentMessage => {
			setMessages(prev => subAgentHandler.handleMessage(prev, subAgentMessage));
		},
		async (toolCall, batchToolNames, allTools) => {
			if (connectionManager.isConnected()) {
				await connectionManager.notifyToolConfirmationNeeded(
					toolCall.function.name,
					toolCall.function.arguments,
					toolCall.id,
					allTools?.map(t => ({
						name: t.function.name,
						arguments: t.function.arguments,
					})),
				);
			}
			return requestToolConfirmation(toolCall, batchToolNames, allTools);
		},
		isToolAutoApproved,
		yoloModeRef.current,
		addToAlwaysApproved,
		async (question: string, opts: string[], multiSelect?: boolean) => {
			if (connectionManager.isConnected()) {
				await connectionManager.notifyUserInteractionNeeded(
					question,
					opts,
					'fake-tool-call',
					multiSelect,
				);
			}
			return await requestUserQuestion(
				question,
				opts,
				{
					id: 'fake-tool-call',
					type: 'function' as const,
					function: {name: 'askuser', arguments: '{}'},
				},
				multiSelect,
			);
		},
	);

	// ── Check abort during execution ──

	if (controller.signal.aborted) {
		if (receivedToolCalls.length > 0) {
			for (const toolCall of receivedToolCalls) {
				const abortedResult = {
					role: 'tool' as const,
					tool_call_id: toolCall.id,
					content: 'Error: Tool execution aborted by user',
					messageStatus: 'error' as const,
				};
				conversationMessages.push(abortedResult);
				try {
					await saveMessage(abortedResult);
				} catch (error) {
					console.error('Failed to save aborted tool result:', error);
				}
			}
		}
		freeEncoder();
		return {type: 'break'};
	}

	// ── Hook failure check ──

	const hookFailedResult = toolResults.find(r => r.hookFailed);
	if (hookFailedResult) {
		for (const result of toolResults) {
			const {hookFailed, ...resultWithoutFlag} = result;
			conversationMessages.push(resultWithoutFlag);
			saveMessage(resultWithoutFlag).catch(error => {
				console.error('Failed to save tool result:', error);
			});
		}
		setMessages(prev => [
			...prev,
			{
				role: 'assistant',
				content: '',
				streaming: false,
				hookError: hookFailedResult.hookErrorDetails,
			},
		]);
		if (options.setIsStreaming) {
			options.setIsStreaming(false);
		}
		freeEncoder();
		return {type: 'break'};
	}

	// ── Progressive tool loading ──

	if (useToolSearch && receivedToolCalls) {
		for (const tc of receivedToolCalls) {
			if (tc.function.name === 'tool_search') {
				try {
					const searchArgs = JSON.parse(tc.function.arguments || '{}');
					const {matchedToolNames} = toolSearchService.search(
						searchArgs.query || '',
					);
					for (const name of matchedToolNames) {
						if (!discoveredToolNames.has(name)) {
							discoveredToolNames.add(name);
							const tool = toolSearchService.getToolByName(name);
							if (tool) {
								activeTools.push(tool);
							}
						}
					}
				} catch {
					// Ignore parse errors
				}
			}
		}
	}

	// ── Save tool results ──

	for (const result of toolResults) {
		const isError = result.content.startsWith('Error:');
		const resultToSave = {
			...result,
			messageStatus: isError ? 'error' : 'success',
		};
		conversationMessages.push(resultToSave as any);
		try {
			await saveMessage(resultToSave as any);
		} catch (error) {
			console.error('Failed to save tool result before compression:', error);
		}
	}

	// ── Auto-compression after tool execution ──

	const autoCompressOpts = {
		getCurrentContextPercentage: options.getCurrentContextPercentage,
		setMessages,
		clearSavedMessages: options.clearSavedMessages,
		setRemountKey: options.setRemountKey,
		setContextUsage,
		setSnapshotFileCount: options.setSnapshotFileCount,
		setIsStreaming: options.setIsStreaming,
		freeEncoder,
		compressingLabel:
			'✵ Auto-compressing context before sending tool results...',
	};

	const compressResult = await handleAutoCompression(autoCompressOpts);

	if (compressResult.hookFailed) {
		setMessages(prev => [
			...prev,
			{
				role: 'assistant',
				content: '',
				streaming: false,
				hookError: compressResult.hookErrorDetails,
			},
		]);
		if (options.setIsStreaming) {
			options.setIsStreaming(false);
		}
		freeEncoder();
		return {type: 'break'};
	}

	if (compressResult.compressed && compressResult.updatedConversationMessages) {
		conversationMessages.length = 0;
		conversationMessages.push(...compressResult.updatedConversationMessages);
		if (compressResult.accumulatedUsage) {
			accumulatedUsage = compressResult.accumulatedUsage;
		}
	}

	// ── Update UI with tool results ──

	setMessages(prev =>
		prev.filter(
			m =>
				m.role !== 'subagent' ||
				m.toolCall !== undefined ||
				m.toolResult !== undefined ||
				m.subAgentInternal === true,
		),
	);

	const resultMessages = buildToolResultMessages(
		toolResults,
		receivedToolCalls,
		parallelGroupId,
	);

	if (resultMessages.length > 0) {
		setMessages(prev => [...prev, ...resultMessages]);
	}

	// ── Inject spawned sub-agent results ──

	try {
		const {runningSubAgentTracker} = await import(
			'../../utils/execution/runningSubAgentTracker.js'
		);
		const spawnedResults = runningSubAgentTracker.drainSpawnedResults();
		if (spawnedResults.length > 0) {
			for (const sr of spawnedResults) {
				const statusIcon = sr.success ? '✓' : '✗';
				const resultSummary = sr.success
					? sr.result.length > 500
						? sr.result.substring(0, 500) + '...'
						: sr.result
					: sr.error || 'Unknown error';

				const spawnedContent = `[Spawned Sub-Agent Result] ${statusIcon} ${sr.agentName} (${sr.agentId}) — spawned by ${sr.spawnedBy.agentName}\nPrompt: ${sr.prompt}\nResult: ${resultSummary}`;

				conversationMessages.push({role: 'user', content: spawnedContent});
				try {
					await saveMessage({role: 'user', content: spawnedContent});
				} catch (error) {
					console.error('Failed to save spawned agent result:', error);
				}

				const uiMsg: Message = {
					role: 'subagent',
					content: `\x1b[38;2;150;120;255m⚇${statusIcon} Spawned ${
						sr.agentName
					}\x1b[0m (by ${sr.spawnedBy.agentName}): ${
						sr.success ? 'completed' : 'failed'
					}`,
					streaming: false,
					messageStatus: sr.success ? 'success' : 'error',
					subAgent: {
						agentId: sr.agentId,
						agentName: sr.agentName,
						isComplete: true,
					},
					subAgentInternal: true,
				};
				setMessages(prev => [...prev, uiMsg]);
			}
		}
	} catch (error) {
		console.error('Failed to process spawned agent results:', error);
	}

	// ── Handle pending messages ──

	const pendingResult = await handlePendingMessages({
		getPendingMessages: options.getPendingMessages,
		clearPendingMessages: options.clearPendingMessages,
		conversationMessages,
		saveMessage,
		setMessages,
		autoCompressOptions: autoCompressOpts,
	});

	if (pendingResult.hookFailed) {
		setMessages(prev => [
			...prev,
			{
				role: 'assistant',
				content: '',
				streaming: false,
				hookError: pendingResult.hookErrorDetails,
			},
		]);
		if (options.setIsStreaming) {
			options.setIsStreaming(false);
		}
		freeEncoder();
		return {type: 'break'};
	}

	if (pendingResult.accumulatedUsage) {
		accumulatedUsage = pendingResult.accumulatedUsage;
	}

	return {type: 'continue', accumulatedUsage};
}
