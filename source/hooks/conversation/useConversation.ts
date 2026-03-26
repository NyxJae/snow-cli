import type {ChatMessage} from '../../api/chat.js';
import {mainAgentManager} from '../../utils/MainAgentManager.js';
import {
	getTodoService,
	getUsefulInfoService,
} from '../../utils/execution/mcpToolsManager.js';
import {getOpenAiConfig} from '../../utils/config/apiConfig.js';
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
import {
	createEmptyResponseError,
	isEmptyResponse,
} from '../../utils/core/emptyResponseDetector.js';
import {connectionManager} from '../../utils/connection/ConnectionManager.js';
import {extractThinkingContent} from './utils/thinkingExtractor.js';
import {EncoderManager} from './core/encoderManager.js';
import {
	appendUserMessageAndSyncContext,
	prepareConversationSetup,
} from './core/conversationSetup.js';
import {processStreamRound} from './core/streamProcessor.js';
import {handleToolCallRound} from './core/toolCallRoundHandler.js';
import {handleOnStopHooks} from './core/onStopHookHandler.js';
import type {
	ConversationHandlerOptions,
	ConversationUsage,
} from './core/conversationTypes.js';

export type {
	ConversationHandlerOptions,
	UserQuestionResult,
} from './core/conversationTypes.js';

const DEFAULT_MAX_RETRIES = 10;
const EMPTY_RESPONSE_MAX_RETRIES = 20;
const BASE_DELAY_MS = 1000;
const EMPTY_RESPONSE_BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 15000;

function getIsEmptyResponseError(error: unknown): boolean {
	const err = error as any;
	const message = String(err?.message || '').toLowerCase();
	return (
		err?.code === 'EMPTY_RESPONSE' ||
		err?.isRetryable === true ||
		message.includes('empty response') ||
		message.includes('empty or insufficient response')
	);
}

function getIsRetriable(error: unknown): boolean {
	const err = error as any;
	if (err?.isRetryable === true) {
		return true;
	}

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
}

function calcNextDelay(attempt: number, isEmptyResponse: boolean): number {
	const base = isEmptyResponse ? EMPTY_RESPONSE_BASE_DELAY_MS : BASE_DELAY_MS;
	const cappedExp = Math.min(Math.max(0, attempt - 1), 6);
	const rawDelay = Math.min(base * Math.pow(2, cappedExp), MAX_DELAY_MS);
	const jitter = Math.floor(rawDelay * 0.2 * Math.random());
	return rawDelay + jitter;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
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
}

function stripSpecialUserMessages(messages: ChatMessage[]): ChatMessage[] {
	return messages.filter(message => !message.specialUserMessage);
}

async function refreshMainAgentSpecialUserMessages(
	messages: ChatMessage[],
	sessionId: string,
): Promise<ChatMessage[]> {
	const baseMessages = stripSpecialUserMessages(messages);
	const specialUserMessages: ChatMessage[] = [];

	const currentAgentConfig = mainAgentManager.getCurrentAgentConfig();
	if (currentAgentConfig?.mainAgentRole) {
		specialUserMessages.push({
			role: 'user',
			content: mainAgentManager.getMainAgentUserRolePrompt(),
			specialUserMessage: true,
		});
	}

	const todoService = getTodoService();
	const latestTodoList = await todoService.getTodoList(sessionId);
	if (latestTodoList?.todos.length) {
		specialUserMessages.push({
			role: 'user',
			content: formatTodoContext(latestTodoList.todos),
			specialUserMessage: true,
		});
	}

	const usefulInfoService = getUsefulInfoService();
	const usefulInfoList = await usefulInfoService.getUsefulInfoList(sessionId);
	if (usefulInfoList?.items.length) {
		specialUserMessages.push({
			role: 'user',
			content: await formatUsefulInfoContext(usefulInfoList.items),
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
	return insertMessagesAtPosition(
		baseMessages,
		specialUserMessages,
		Math.max(1, insertPosition),
	);
}

function mergeUsage(
	accumulated: ConversationUsage | null,
	round: ConversationUsage | null,
): ConversationUsage | null {
	if (!round) {
		return accumulated;
	}
	if (!accumulated) {
		return round;
	}

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

async function executeWithInternalRetry(
	options: ConversationHandlerOptions,
): Promise<{usage: ConversationUsage | null}> {
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

	const {
		conversationMessages: preparedConversationMessages,
		activeTools,
		discoveredToolNames,
		useToolSearch,
	} = await prepareConversationSetup();
	let conversationMessages = preparedConversationMessages;

	await appendUserMessageAndSyncContext({
		conversationMessages,
		userContent,
		editorContext,
		imageContents,
		saveMessage: async () => {
			// 用户消息已在外层重试循环前持久化,这里避免重试时重复写入.
		},
	});

	const encoderManager = new EncoderManager();
	const freeEncoder = () => {
		encoderManager.free();
	};

	setStreamTokenCount(0);
	const config = getOpenAiConfig();
	const model = options.useBasicModel
		? config.basicModel || config.advancedModel || 'gpt-5'
		: config.advancedModel || 'gpt-5';
	options.setCurrentModel?.(model);

	let accumulatedUsage: ConversationUsage | null = null;
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
				encoder: encoderManager,
				setStreamTokenCount,
				setMessages,
				setIsReasoning,
				setRetryStatus,
				setContextUsage,
				options,
			});

			setStreamTokenCount(0);
			accumulatedUsage = mergeUsage(accumulatedUsage, streamResult.roundUsage);

			if (
				(!streamResult.streamedContent ||
					isEmptyResponse(streamResult.streamedContent)) &&
				(!streamResult.receivedToolCalls ||
					streamResult.receivedToolCalls.length === 0) &&
				!streamResult.receivedReasoning &&
				!streamResult.receivedThinking &&
				!streamResult.receivedReasoningContent
			) {
				freeEncoder();
				throw createEmptyResponseError(streamResult.streamedContent || '');
			}

			if (streamResult.receivedToolCalls?.length) {
				const toolLoopResult = await handleToolCallRound({
					streamResult,
					conversationMessages,
					activeTools,
					discoveredToolNames,
					useToolSearch,
					controller,
					encoder: encoderManager,
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
					addToAlwaysApproved: toolName => {
						addMultipleToAlwaysApproved([toolName]);
					},
					yoloModeRef,
					streamingEnabled: config.streamingDisplay !== false,
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

			if (streamResult.streamedContent.trim()) {
				if (!streamResult.hasStreamedLines) {
					setMessages(prev => [
						...prev,
						{
							role: 'assistant',
							content: streamResult.streamedContent.trim(),
							streaming: false,
							discontinued: controller.signal.aborted,
							thinking: extractThinkingContent(
								streamResult.receivedThinking,
								streamResult.receivedReasoning,
								streamResult.receivedReasoningContent,
							),
						},
					]);
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
		options.setIsStreaming?.(false);
		options.setIsStopping?.(false);

		try {
			await connectionManager.notifyMessageProcessingCompleted();
		} catch {
			// 忽略通知阶段错误,避免覆盖主链路结果.
		}

		try {
			const {clearConversationContext} = await import(
				'../../utils/codebase/conversationContext.js'
			);
			clearConversationContext();
		} catch {
			// 忽略清理阶段错误,避免影响会话收尾.
		}

		freeEncoder();
	}

	return {usage: accumulatedUsage};
}

/**
 * 执行带工具调用的流式会话,并返回本轮累计用量统计.
 */
export async function handleConversationWithTools(
	options: ConversationHandlerOptions,
): Promise<{usage: ConversationUsage | null}> {
	const {setRetryStatus, saveMessage, userContent, imageContents} = options;

	try {
		await saveMessage({
			role: 'user',
			content: userContent,
			images: imageContents,
		});
	} catch (error) {
		console.error('Failed to save user message:', error);
	}

	let retryCount = 0;
	let lastError: Error | null = null;

	while (true) {
		const currentController = options.controller;

		try {
			if (currentController.signal.aborted) {
				throw new Error('Request aborted by user');
			}

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

			if (retryCount > 0) {
				setRetryStatus?.(null);
				options.setIsStreaming?.(true);
			}

			return await executeWithInternalRetry(options);
		} catch (error) {
			lastError = error as Error;
			if (String(lastError.message) === 'Request aborted by user') {
				throw lastError;
			}

			if (!getIsRetriable(error)) {
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

			options.setIsStreaming?.(true);
			await sleep(nextDelay, options.controller.signal);
		}
	}
}
