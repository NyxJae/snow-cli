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
	>; // 压缩后清空快照计数
	getCurrentContextPercentage?: () => number; // 获取当前上下文占用比例
	setCurrentModel?: React.Dispatch<React.SetStateAction<string | null>>; // 用于展示当前模型名
	setIsStopping?: React.Dispatch<React.SetStateAction<boolean>>; // 控制停止态
	/**
	 * 将 AbortController 同步到 streamingState.
	 * 重试会替换 controller,这里同步引用,确保 ESC 中断命中当前有效请求.
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
	const {setRetryStatus, saveMessage, userContent, imageContents} = options;

	// 在重试循环前保存用户消息,避免网络重试导致重复写入.
	try {
		await saveMessage({
			role: 'user',
			content: userContent,
			images: imageContents,
		});
	} catch (error) {
		console.error('Failed to save user message:', error);
	}

	const DEFAULT_MAX_RETRIES = 10;
	const EMPTY_RESPONSE_MAX_RETRIES = 20;
	const BASE_DELAY_MS = 1000;
	const EMPTY_RESPONSE_BASE_DELAY_MS = 500;
	const MAX_DELAY_MS = 15000;

	const getIsEmptyResponseError = (error: unknown): boolean => {
		const err = error as any;
		const message = String(err?.message || '').toLowerCase();
		return (
			err?.code === 'EMPTY_RESPONSE' ||
			err?.isRetryable === true ||
			message.includes('empty response') ||
			message.includes('empty or insufficient response')
		);
	};

	const getIsRetriable = (error: unknown): boolean => {
		const err = error as any;
		if (err?.isRetryable === true) return true;

		const message = String(err?.message || '').toLowerCase();
		return (
			message.includes('timeout') ||
			message.includes('network') ||
			message.includes('connection') ||
			message.includes('enotfound') ||
			message.includes('econnreset') ||
			message.includes('econnrefused') ||
			message.includes('500') ||
			message.includes('502') ||
			message.includes('503') ||
			message.includes('504') ||
			message.includes('403') ||
			message.includes('forbidden') ||
			message.includes('fetch failed') ||
			message.includes('fetcherror') ||
			getIsEmptyResponseError(error)
		);
	};

	const calcNextDelay = (attempt: number, isEmptyResponse: boolean): number => {
		const base = isEmptyResponse ? EMPTY_RESPONSE_BASE_DELAY_MS : BASE_DELAY_MS;
		const cappedExp = Math.min(Math.max(0, attempt - 1), 6);
		const rawDelay = Math.min(base * Math.pow(2, cappedExp), MAX_DELAY_MS);
		const jitter = Math.floor(rawDelay * 0.2 * Math.random());
		return rawDelay + jitter;
	};

	const sleep = (ms: number, signal: AbortSignal) =>
		new Promise<void>((resolve, reject) => {
			if (signal.aborted) {
				reject(new Error('Request aborted by user'));
				return;
			}

			const timer = setTimeout(() => {
				cleanup();
				resolve();
			}, ms);

			const onAbort = () => {
				cleanup();
				reject(new Error('Request aborted by user'));
			};

			const cleanup = () => {
				clearTimeout(timer);
				signal.removeEventListener('abort', onAbort);
			};

			signal.addEventListener('abort', onAbort, {once: true});
		});

	let retryCount = 0;
	let lastError: Error | null = null;

	while (true) {
		// 每轮重新读取 AbortController,避免重试后继续引用已失效实例.
		const currentController = options.controller;

		try {
			if (currentController.signal.aborted) {
				throw new Error('Request aborted by user');
			}

			// 重试前同步新的 AbortController,并桥接旧实例的 abort,避免中断意图丢失.
			if (retryCount > 0) {
				const previousController = currentController;
				const newController = new AbortController();
				const bridgeAbort = () => newController.abort();
				previousController.signal.addEventListener('abort', bridgeAbort, {
					once: true,
				});
				if (previousController.signal.aborted) {
					bridgeAbort();
				}

				options.controller = newController;
				options.setAbortController?.(newController);

				if (newController.signal.aborted) {
					throw new Error('Request aborted by user');
				}
			}

			if (retryCount > 0 && setRetryStatus) {
				setRetryStatus(null);
			}

			if (retryCount > 0 && options.setIsStreaming) {
				options.setIsStreaming(true);
			}

			return await executeWithInternalRetry(options);
		} catch (error) {
			lastError = error as Error;

			// 用户主动中断必须短路退出,不得进入重试提示循环
			if (String(lastError.message) === 'Request aborted by user') {
				throw lastError;
			}

			const isRetriable = getIsRetriable(error);
			if (!isRetriable) {
				throw error;
			}

			const isEmptyResponse = getIsEmptyResponseError(error);
			const maxRetries = isEmptyResponse
				? EMPTY_RESPONSE_MAX_RETRIES
				: DEFAULT_MAX_RETRIES;

			if (retryCount >= maxRetries) {
				throw error;
			}

			retryCount++;
			const nextDelay = calcNextDelay(retryCount, isEmptyResponse);

			console.warn(
				`Retrying request (attempt ${retryCount}/${maxRetries}) after error: ${lastError.message}`,
			);

			if (setRetryStatus) {
				const currentLanguage = getCurrentLanguage();
				const t = translations[currentLanguage].chatScreen;
				setRetryStatus({
					isRetrying: true,
					attempt: retryCount,
					nextDelay,
					remainingSeconds: Math.floor(nextDelay / 1000),
					errorMessage: t.retryResending
						.replace('{current}', String(retryCount))
						.replace('{max}', String(maxRetries)),
				});
			}

			// 重试延迟期间保持流式状态,避免"思考中"提示消失
			if (options.setIsStreaming) {
				options.setIsStreaming(true);
			}

			await sleep(nextDelay, options.controller.signal);
		}
	}
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

	// 初始化会话与待办上下文
	let {conversationMessages} = await initializeConversationSession();

	// 收集所有 MCP 工具,按主代理权限过滤并划分初始暴露/可搜索集合后再接入 Tool Search.
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

	// ── 构建并追加用户消息 ──

	const finalUserContent = buildEditorContextContent(
		editorContext,
		userContent,
	);

	conversationMessages.push({
		role: 'user',
		content: finalUserContent,
		images: imageContents,
	});

	// 说明: 用户消息在外层重试循环前已保存.
	// 避免网络重试触发时重复写入.

	// 为按需快照系统设置会话上下文
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

	// ── 初始化编码器 ──

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

	// 重试状态清理计时器引用
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

	// ── 主会话循环 ──

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

			// ── 处理工具调用 ──
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

			// ── 无工具调用,最终文本回复 ──
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

			// ── 停止钩子 ──
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
			// 忽略通知阶段的错误
		}

		try {
			const {clearConversationContext} = await import(
				'../../utils/codebase/conversationContext.js'
			);
			clearConversationContext();
		} catch {
			// 忽略清理阶段的错误
		}

		freeEncoder();
	}

	return {usage: accumulatedUsage};
}

// ─────────────────────────────────────────────────────────────
// 内部辅助函数
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

// 用量占位类型,形状与 accumulatedUsage 保持一致
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
		// 忽略估算失败,保留上一轮上下文用量.
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
			// 忽略编码错误
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

	// 保存包含 tool_calls 的 assistant 消息
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

	// ── 处理工具确认 ──

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

	// ── 执行前检查中断 ──

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

	// ── 执行工具 ──

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

	// ── 执行中检查中断 ──

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

	// ── 检查 hook 失败 ──

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

	// ── 渐进式工具加载 ──

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
					// 忽略解析错误
				}
			}
		}
	}

	// ── 保存工具结果 ──

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

	// ── 工具执行后自动压缩 ──

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

	// ── 使用工具结果更新 UI ──

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

	// ── 注入已派生子代理结果 ──

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

	// ── 处理待发送消息 ──

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
