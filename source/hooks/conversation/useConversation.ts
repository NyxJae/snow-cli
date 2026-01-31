import {encoding_for_model} from 'tiktoken';
import {
	createStreamingChatCompletion,
	type ChatMessage,
} from '../../api/chat.js';
import {createStreamingResponse} from '../../api/responses.js';
import {createStreamingGeminiCompletion} from '../../api/gemini.js';
import {createStreamingAnthropicCompletion} from '../../api/anthropic.js';
import {mainAgentManager} from '../../utils/MainAgentManager.js';
import {
	collectAllMCPTools,
	getUsefulInfoService,
} from '../../utils/execution/mcpToolsManager.js';
import {filterToolsByMainAgent} from '../../utils/core/toolFilterUtils.js';
import {
	executeToolCalls,
	type ToolCall,
} from '../../utils/execution/toolExecutor.js';
import {getOpenAiConfig} from '../../utils/config/apiConfig.js';
import {sessionManager} from '../../utils/session/sessionManager.js';
import {unifiedHooksExecutor} from '../../utils/execution/unifiedHooksExecutor.js';
import {formatTodoContext} from '../../utils/core/todoPreprocessor.js';
import {formatUsefulInfoContext} from '../../utils/core/usefulInfoPreprocessor.js';
import type {Message} from '../../ui/components/chat/MessageList.js';
import {filterToolsBySensitivity} from '../../utils/execution/yoloPermissionChecker.js';
import {
	isEmptyResponse,
	createEmptyResponseError,
} from '../../utils/core/emptyResponseDetector.js';
import {formatToolCallMessage} from '../../utils/ui/messageFormatter.js';
import {resourceMonitor} from '../../utils/core/resourceMonitor.js';
import {isToolNeedTwoStepDisplay} from '../../utils/config/toolDisplayConfig.js';
import type {ConfirmationResult} from '../../ui/components/tools/ToolConfirmation.js';
import {
	shouldAutoCompress,
	performAutoCompression,
} from '../../utils/core/autoCompress.js';
import {
	cleanOrphanedToolCalls,
	simplifyOutdatedTerminalResults,
} from './utils/messageCleanup.js';
import {extractThinkingContent} from './utils/thinkingExtractor.js';
import {buildEditorContextContent} from './core/editorContextBuilder.js';
import {initializeConversationSession} from './core/sessionInitializer.js';
import {handleToolRejection} from './core/toolRejectionHandler.js';
import {processToolCallsAfterStream} from './core/toolCallProcessor.js';

export type UserQuestionResult = {
	selected: string | string[];
	customInput?: string;
};

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
	yoloMode: boolean;
	// planMode 和 vulnerabilityHuntingMode 已整合为 currentAgentName，不再需要独立状态
	setContextUsage: React.Dispatch<React.SetStateAction<any>>;
	useBasicModel?: boolean; // Optional flag to use basicModel instead of advancedModel
	getPendingMessages?: () => Array<{
		text: string;
		images?: Array<{data: string; mimeType: string}>;
	}>; // Get pending user messages
	clearPendingMessages?: () => void; // Clear pending messages after insertion
	setIsStreaming?: React.Dispatch<React.SetStateAction<boolean>>; // Control streaming state
	setIsReasoning?: React.Dispatch<React.SetStateAction<boolean>>; // Control reasoning state (Responses API only)
	setRetryStatus?: React.Dispatch<
		React.SetStateAction<{
			isRetrying: boolean;
			attempt: number;
			nextDelay: number;
			remainingSeconds?: number;
			errorMessage?: string;
		} | null>
	>; // Retry status
	clearSavedMessages?: () => void; // Clear saved messages for auto-compression
	setRemountKey?: React.Dispatch<React.SetStateAction<number>>; // Remount key for auto-compression
	setSnapshotFileCount?: React.Dispatch<
		React.SetStateAction<Map<number, number>>
	>; // Clear snapshot counts after compression
	getCurrentContextPercentage?: () => number; // Get current context percentage from ChatInput
	setCurrentModel?: React.Dispatch<React.SetStateAction<string | null>>; // Set current model name for display
	setIsStopping?: React.Dispatch<React.SetStateAction<boolean>>; // Control stopping state
	setSubAgentRunState?: React.Dispatch<
		React.SetStateAction<{
			parallel: boolean;
			agentName?: string;
		} | null>
	>;
};

/**
 * Handle conversation with streaming and tool calls
 * Returns the usage data collected during the conversation
 */
export async function handleConversationWithTools(
	options: ConversationHandlerOptions,
): Promise<{usage: any | null}> {
	const {controller, setRetryStatus, saveMessage, userContent, imageContents} =
		options;

	// Save user message ONCE before retry loop
	// This prevents duplicate user messages when network errors trigger retries
	// BUG FIX: Previously saved inside executeWithInternalRetry, causing duplicates
	// when retry delay (5s) aligned with dedup time window (5s)
	try {
		await saveMessage({
			role: 'user',
			content: userContent,
			images: imageContents,
		});
	} catch (error) {
		console.error('Failed to save user message:', error);
	}

	// 外层重试机制：最多10次，5秒间隔，确保流中断时自动重新发起请求
	const MAX_RETRIES = 10;
	const RETRY_DELAY = 5000; // 5秒间隔
	let retryCount = 0;
	let lastError: Error | null = null;

	// 外层重试循环
	while (retryCount <= MAX_RETRIES) {
		try {
			// 检查用户中止信号
			if (controller.signal.aborted) {
				throw new Error('Request aborted by user');
			}

			// 清除重试状态（如果存在）
			if (retryCount > 0 && setRetryStatus) {
				setRetryStatus(null);
			}

			// 执行内层逻辑（原有代码）
			return await executeWithInternalRetry(options);
		} catch (error) {
			lastError = error as Error;

			// 检查是否为可重试错误
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

			// 如果不可重试或已达到最大重试次数，抛出错误
			if (!isRetriable || retryCount >= MAX_RETRIES) {
				throw error;
			}

			// 更新重试状态
			retryCount++;
			if (setRetryStatus) {
				setRetryStatus({
					isRetrying: true,
					attempt: retryCount,
					nextDelay: RETRY_DELAY,
					remainingSeconds: Math.floor(RETRY_DELAY / 1000),
					errorMessage: `网络或服务错误，正在重试 (${retryCount}/${MAX_RETRIES})...`,
				});
			}

			// 等待重试
			await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
		}
	}

	// 不应该到达这里
	throw lastError || new Error('Unknown error occurred');
}

/**
 * 内层重试逻辑（原有代码）
 */
async function executeWithInternalRetry(
	options: ConversationHandlerOptions,
): Promise<{usage: any | null}> {
	const {
		userContent,
		editorContext,
		imageContents,
		controller,
		// messages, // No longer used - we load from session instead to get complete history with tool calls
		saveMessage,
		setMessages,
		setStreamTokenCount,
		requestToolConfirmation,
		requestUserQuestion,
		isToolAutoApproved,
		addMultipleToAlwaysApproved,
		yoloMode,
		setContextUsage,
		setIsReasoning,
		setRetryStatus,
	} = options;

	// Create a wrapper function for adding single tool to always-approved list
	const addToAlwaysApproved = (toolName: string) => {
		addMultipleToAlwaysApproved([toolName]);
	};

	// Initialize session and TODO context
	let {conversationMessages, existingTodoList} =
		await initializeConversationSession();

	// Collect all MCP tools and filter based on main agent configuration
	const allMcpTools = await collectAllMCPTools();
	const {filteredTools} = filterToolsByMainAgent({tools: allMcpTools});
	const mcpTools = filteredTools;

	// Add current user message (build editorContext if present)
	const finalUserContent = buildEditorContextContent(
		editorContext,
		userContent,
	);

	// Add to stored history (will be included in apiMessages on next loop iteration)
	const currentUserMessage: ChatMessage = {
		role: 'user',
		content: finalUserContent,
		images: imageContents,
	};
	conversationMessages.push(currentUserMessage);

	// NOTE: User message is saved in handleConversationWithTools BEFORE retry loop
	// to prevent duplicate saves when network errors trigger retries

	// Set conversation context for on-demand snapshot system
	// This provides sessionId and messageIndex to file operations
	// messageIndex is the index after saving the current user message
	try {
		const {setConversationContext} = await import(
			'../../utils/codebase/conversationContext.js'
		);
		// Use session.messages.length as messageIndex (after user message is saved)
		const updatedSession = sessionManager.getCurrentSession();
		if (updatedSession) {
			setConversationContext(updatedSession.id, updatedSession.messages.length);
		}
	} catch (error) {
		console.error('Failed to set conversation context:', error);
	}

	// Initialize token encoder with proper cleanup tracking
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

	try {
		encoder = encoding_for_model('gpt-5');
		resourceMonitor.trackEncoderCreated();
	} catch (e) {
		encoder = encoding_for_model('gpt-3.5-turbo');
		resourceMonitor.trackEncoderCreated();
	}
	setStreamTokenCount(0);

	const config = getOpenAiConfig();
	const model = options.useBasicModel
		? config.basicModel || config.advancedModel || 'gpt-5'
		: config.advancedModel || 'gpt-5';

	// Set current model for display in UI
	if (options.setCurrentModel) {
		options.setCurrentModel(model);
	}

	// Tool calling loop (no limit on rounds)
	let finalAssistantMessage: Message | null = null;
	// Accumulate usage data across all rounds
	let accumulatedUsage: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
		cache_creation_input_tokens?: number;
		cache_read_input_tokens?: number;
		cached_tokens?: number; // Keep for UI display
	} | null = null;

	// Local set to track approved tools in this conversation (solves async setState issue)
	const sessionApprovedTools = new Set<string>();

	try {
		while (true) {
			if (controller.signal.aborted) {
				freeEncoder();
				break;
			}

			// Build API messages for THIS round
			// IMPORTANT: Rebuild on each iteration to include newly added tool results
			// LAYER 3 PROTECTION: Clean orphaned tool_calls before sending to API
			const apiMessages = [...conversationMessages];
			cleanOrphanedToolCalls(apiMessages);

			// Simplify outdated terminal command results to reduce context usage
			// This only affects messages sent to API, not the stored history
			simplifyOutdatedTerminalResults(apiMessages);

			let streamedContent = '';
			let receivedToolCalls: ToolCall[] | undefined;
			let receivedReasoning:
				| {
						summary?: Array<{type: 'summary_text'; text: string}>;
						content?: any;
						encrypted_content?: string;
				  }
				| undefined;
			let receivedThinking:
				| {type: 'thinking'; thinking: string; signature?: string}
				| undefined; // Accumulate thinking content from all platforms
			let receivedReasoningContent: string | undefined; // DeepSeek R1 reasoning content
			let hasStartedReasoning = false; // Track if reasoning has started (for Gemini thinking)

			// Stream AI response - choose API based on config
			let toolCallAccumulator = ''; // Accumulate tool call deltas for token counting
			let reasoningAccumulator = ''; // Accumulate reasoning summary deltas for token counting (Responses API only)
			let chunkCount = 0; // Track number of chunks received (to delay clearing retry status)
			let currentTokenCount = 0; // Track current token count incrementally
			let lastTokenUpdateTime = 0; // Track last token update time for throttling
			const TOKEN_UPDATE_INTERVAL = 100; // Update token count every 100ms (10fps)

			// Get or create session for cache key
			const currentSession = sessionManager.getCurrentSession();
			// Use session ID as cache key to ensure same session requests share cache
			const cacheKey = currentSession?.id;

			// 重试回调函数
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

			const streamGenerator =
				config.requestMethod === 'anthropic'
					? createStreamingAnthropicCompletion(
							{
								model,
								messages: apiMessages,
								temperature: 0,
								max_tokens: config.maxTokens || 4096,
								tools: mcpTools.length > 0 ? mcpTools : undefined,
								sessionId: currentSession?.id,
								// Disable thinking for basicModel (e.g., init command)
								disableThinking: options.useBasicModel,
								// teamMode 已整合为 currentAgentName，API 直接从 MainAgentManager 获取状态
							},
							controller.signal,
							onRetry,
					  )
					: config.requestMethod === 'gemini'
					? createStreamingGeminiCompletion(
							{
								model,
								messages: apiMessages,
								temperature: 0,
								tools: mcpTools.length > 0 ? mcpTools : undefined,
								// teamMode 已整合为 currentAgentName，API 直接从 MainAgentManager 获取状态
							},
							controller.signal,
							onRetry,
					  )
					: config.requestMethod === 'responses'
					? createStreamingResponse(
							{
								model,
								messages: apiMessages,
								temperature: 0,
								tools: mcpTools.length > 0 ? mcpTools : undefined,
								tool_choice: 'auto',
								prompt_cache_key: cacheKey, // Use session ID as cache key
								// reasoning 参数已移除，API 使用默认配置
								// teamMode 已整合为 currentAgentName，API 直接从 MainAgentManager 获取状态
							},
							controller.signal,
							onRetry,
					  )
					: createStreamingChatCompletion(
							{
								model,
								messages: apiMessages,
								temperature: 0,
								tools: mcpTools.length > 0 ? mcpTools : undefined,
								// teamMode 已整合为 currentAgentName，API 直接从 MainAgentManager 获取状态
							},
							controller.signal,
							onRetry,
					  );

			for await (const chunk of streamGenerator) {
				if (controller.signal.aborted) break;

				// 首次接收数据后延迟清除重试状态，确保用户能看到重试提示
				chunkCount++;
				if (setRetryStatus && chunkCount === 1) {
					setTimeout(() => {
						setRetryStatus(null);
					}, 500);
				}

				if (chunk.type === 'reasoning_started') {
					// Reasoning started (Responses API only) - set reasoning state
					setIsReasoning?.(true);
				} else if (chunk.type === 'reasoning_delta' && chunk.delta) {
					// Handle reasoning delta from Gemini thinking
					// When reasoning_delta is received, set reasoning state if not already set
					if (!hasStartedReasoning) {
						setIsReasoning?.(true);
						hasStartedReasoning = true;
					}
					// Note: reasoning content is NOT sent back to AI, only counted for display
					reasoningAccumulator += chunk.delta;
					// Incremental token counting with throttling - only encode the new delta
					try {
						const deltaTokens = encoder.encode(chunk.delta);
						currentTokenCount += deltaTokens.length;
						// Throttle UI update to 10fps (100ms interval)
						const now = Date.now();
						if (now - lastTokenUpdateTime >= TOKEN_UPDATE_INTERVAL) {
							setStreamTokenCount(currentTokenCount);
							lastTokenUpdateTime = now;
						}
					} catch (e) {
						// Ignore encoding errors
					}
				} else if (chunk.type === 'content' && chunk.content) {
					// 内容开始时推理阶段结束
					setIsReasoning?.(false);
					streamedContent += chunk.content;
					// Incremental token counting with throttling - only encode the new delta
					try {
						const deltaTokens = encoder.encode(chunk.content);
						currentTokenCount += deltaTokens.length;
						// Throttle UI update to 10fps (100ms interval)
						const now = Date.now();
						if (now - lastTokenUpdateTime >= TOKEN_UPDATE_INTERVAL) {
							setStreamTokenCount(currentTokenCount);
							lastTokenUpdateTime = now;
						}
					} catch (e) {
						// Ignore encoding errors
					}
				} else if (chunk.type === 'tool_call_delta' && chunk.delta) {
					// 工具调用开始时推理阶段结束（OpenAI通常不会在工具调用期间输出文本内容）
					setIsReasoning?.(false);
					toolCallAccumulator += chunk.delta;
					// Incremental token counting with throttling - only encode the new delta
					try {
						const deltaTokens = encoder.encode(chunk.delta);
						currentTokenCount += deltaTokens.length;
						// Throttle UI update to 10fps (100ms interval)
						const now = Date.now();
						if (now - lastTokenUpdateTime >= TOKEN_UPDATE_INTERVAL) {
							setStreamTokenCount(currentTokenCount);
							lastTokenUpdateTime = now;
						}
					} catch (e) {
						// Ignore encoding errors
					}
				} else if (chunk.type === 'tool_calls' && chunk.tool_calls) {
					receivedToolCalls = chunk.tool_calls;
				} else if (chunk.type === 'reasoning_data' && chunk.reasoning) {
					// Capture reasoning data from Responses API
					receivedReasoning = chunk.reasoning;
				} else if (chunk.type === 'done') {
					// Capture thinking content from Anthropic (includes signature)
					if ((chunk as any).thinking) {
						receivedThinking = (chunk as any).thinking;
					}
					// Capture reasoning content from DeepSeek R1 models
					if ((chunk as any).reasoning_content) {
						receivedReasoningContent = (chunk as any).reasoning_content;
					}
				} else if (chunk.type === 'usage' && chunk.usage) {
					// Capture usage information both in state and locally
					setContextUsage(chunk.usage);

					// Usage已在API层保存，此处仅用于UI显示

					// Accumulate for final return (UI display purposes)
					if (!accumulatedUsage) {
						accumulatedUsage = {
							prompt_tokens: chunk.usage.prompt_tokens || 0,
							completion_tokens: chunk.usage.completion_tokens || 0,
							total_tokens: chunk.usage.total_tokens || 0,
							cache_creation_input_tokens:
								chunk.usage.cache_creation_input_tokens,
							cache_read_input_tokens: chunk.usage.cache_read_input_tokens,
							cached_tokens: chunk.usage.cached_tokens,
						};
					} else {
						// Add to existing usage for UI display
						accumulatedUsage.prompt_tokens += chunk.usage.prompt_tokens || 0;
						accumulatedUsage.completion_tokens +=
							chunk.usage.completion_tokens || 0;
						accumulatedUsage.total_tokens += chunk.usage.total_tokens || 0;

						if (chunk.usage.cache_creation_input_tokens !== undefined) {
							accumulatedUsage.cache_creation_input_tokens =
								(accumulatedUsage.cache_creation_input_tokens || 0) +
								chunk.usage.cache_creation_input_tokens;
						}
						if (chunk.usage.cache_read_input_tokens !== undefined) {
							accumulatedUsage.cache_read_input_tokens =
								(accumulatedUsage.cache_read_input_tokens || 0) +
								chunk.usage.cache_read_input_tokens;
						}
						if (chunk.usage.cached_tokens !== undefined) {
							accumulatedUsage.cached_tokens =
								(accumulatedUsage.cached_tokens || 0) +
								chunk.usage.cached_tokens;
						}
					}
				}
			}

			// Reset token count to 0 after stream ends
			// Force update to ensure the final token count is displayed
			setStreamTokenCount(0);

			// CRITICAL: Process tool calls even if aborted
			// This ensures tool calls are always saved to session and UI is properly updated
			// If user manually interrupted (ESC), the tool execution will be skipped later
			// but the assistant message with tool_calls MUST be persisted for conversation continuity
			const shouldProcessToolCalls =
				receivedToolCalls && receivedToolCalls.length > 0;

			// 检测空回复：如果既没有内容也没有工具调用，抛出错误以触发重试
			if (
				(!streamedContent || isEmptyResponse(streamedContent)) &&
				(!receivedToolCalls || receivedToolCalls.length === 0)
			) {
				freeEncoder();
				throw createEmptyResponseError(streamedContent || '');
			}

			// If there are tool calls, we need to handle them specially
			if (shouldProcessToolCalls) {
				const {parallelGroupId} = await processToolCallsAfterStream({
					receivedToolCalls: receivedToolCalls!,
					streamedContent,
					receivedReasoning,
					receivedThinking,
					receivedReasoningContent,
					conversationMessages,
					saveMessage,
					setMessages,
					extractThinkingContent,
				});

				// askuser-ask_question tools are now handled through normal executeToolCalls flow
				// No special interception needed - they will trigger UserInteractionNeededError
				// which will be caught and handled by executeToolCall()

				// Filter tools that need confirmation (not in always-approved list OR session-approved list)
				const toolsNeedingConfirmation: ToolCall[] = [];
				const autoApprovedTools: ToolCall[] = [];

				for (const toolCall of receivedToolCalls!) {
					// Check both global approved list and session-approved list
					const isApproved =
						isToolAutoApproved(toolCall.function.name) ||
						sessionApprovedTools.has(toolCall.function.name);

					// Check if this is a sensitive command (terminal-execute with sensitive pattern)
					let isSensitiveCommand = false;
					if (toolCall.function.name === 'terminal-execute') {
						try {
							const args = JSON.parse(toolCall.function.arguments);
							const {isSensitiveCommand: checkSensitiveCommand} = await import(
								'../../utils/execution/sensitiveCommandManager.js'
							).then(m => ({
								isSensitiveCommand: m.isSensitiveCommand,
							}));
							const sensitiveCheck = checkSensitiveCommand(args.command);
							isSensitiveCommand = sensitiveCheck.isSensitive;
						} catch {
							// If parsing fails, treat as normal command
						}
					}

					// If sensitive command, always require confirmation regardless of approval status
					if (isSensitiveCommand) {
						toolsNeedingConfirmation.push(toolCall);
					} else if (isApproved) {
						autoApprovedTools.push(toolCall);
					} else {
						toolsNeedingConfirmation.push(toolCall);
					}
				}

				// Request confirmation only once for all tools needing confirmation
				let approvedTools: ToolCall[] = [...autoApprovedTools];

				// In YOLO mode, auto-approve all tools EXCEPT sensitive commands
				if (yoloMode) {
					// Use the unified permission checker to filter tools
					const {sensitiveTools, nonSensitiveTools} =
						await filterToolsBySensitivity(toolsNeedingConfirmation, yoloMode);

					// Auto-approve non-sensitive tools
					approvedTools.push(...nonSensitiveTools);

					// If there are sensitive tools, still need confirmation even in YOLO mode
					if (sensitiveTools.length > 0) {
						const firstTool = sensitiveTools[0]!;
						const allTools =
							sensitiveTools.length > 1 ? sensitiveTools : undefined;

						const confirmation = await requestToolConfirmation(
							firstTool,
							undefined,
							allTools,
						);

						if (
							confirmation === 'reject' ||
							(typeof confirmation === 'object' &&
								confirmation.type === 'reject_with_reply')
						) {
							const result = await handleToolRejection({
								confirmation,
								toolsNeedingConfirmation: sensitiveTools,
								autoApprovedTools,
								nonSensitiveTools,
								conversationMessages,
								accumulatedUsage,
								saveMessage,
								setMessages,
								setIsStreaming: options.setIsStreaming,
								freeEncoder,
							});

							if (result.shouldContinue) {
								continue;
							} else {
								return {usage: result.accumulatedUsage};
							}
						}

						// Approved, add sensitive tools to approved list
						approvedTools.push(...sensitiveTools);
					}
				} else if (toolsNeedingConfirmation.length > 0) {
					const firstTool = toolsNeedingConfirmation[0]!;
					const allTools =
						toolsNeedingConfirmation.length > 1
							? toolsNeedingConfirmation
							: undefined;

					const confirmation = await requestToolConfirmation(
						firstTool,
						undefined,
						allTools,
					);

					if (
						confirmation === 'reject' ||
						(typeof confirmation === 'object' &&
							confirmation.type === 'reject_with_reply')
					) {
						const result = await handleToolRejection({
							confirmation,
							toolsNeedingConfirmation,
							autoApprovedTools,
							conversationMessages,
							accumulatedUsage,
							saveMessage,
							setMessages,
							setIsStreaming: options.setIsStreaming,
							freeEncoder,
						});

						if (result.shouldContinue) {
							continue;
						} else {
							return {usage: result.accumulatedUsage};
						}
					}

					// If approved_always, add ALL these tools to both global and session-approved sets
					if (confirmation === 'approve_always') {
						const toolNamesToAdd = toolsNeedingConfirmation.map(
							t => t.function.name,
						);
						// Add to global state (async, for future sessions)
						addMultipleToAlwaysApproved(toolNamesToAdd);
						// Add to local session set (sync, for this conversation)
						toolNamesToAdd.forEach(name => sessionApprovedTools.add(name));
					}

					// Add all tools to approved list
					approvedTools.push(...toolsNeedingConfirmation);
				}

				// CRITICAL: Check if user aborted before executing tools
				// If aborted, skip tool execution but the assistant message with tool_calls
				// has already been saved above, maintaining conversation continuity
				if (controller.signal.aborted) {
					// Create aborted tool results for all approved tools
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

					// Free encoder and exit loop
					freeEncoder();
					break;
				}

				// Execute approved tools with sub-agent message callback and terminal output callback
				// Track sub-agent content for token counting
				const subAgentTools = approvedTools.filter(toolCall =>
					toolCall.function.name.startsWith('subagent-'),
				);
				if (options.setSubAgentRunState) {
					if (subAgentTools.length === 0) {
						options.setSubAgentRunState(null);
					} else {
						const singleAgentName =
							subAgentTools.length === 1
								? subAgentTools[0]?.function.name.substring('subagent-'.length)
								: undefined;
						options.setSubAgentRunState({
							parallel: subAgentTools.length > 1,
							agentName: singleAgentName,
						});
					}
				}
				let subAgentContentAccumulator = '';
				const toolResults = await executeToolCalls(
					approvedTools,
					controller.signal,
					setStreamTokenCount,

					async subAgentMessage => {
						// Handle sub-agent messages - display and save to session
						setMessages(prev => {
							// Handle tool calls from sub-agent
							if (subAgentMessage.message.type === 'tool_calls') {
								const toolCalls = subAgentMessage.message.tool_calls;
								if (toolCalls && toolCalls.length > 0) {
									// Separate time-consuming tools and quick tools
									const timeConsumingTools = toolCalls.filter((tc: any) =>
										isToolNeedTwoStepDisplay(tc.function.name),
									);
									const quickTools = toolCalls.filter(
										(tc: any) => !isToolNeedTwoStepDisplay(tc.function.name),
									);

									const newMessages: any[] = [];

									// Display time-consuming tools individually with full details (Diff, etc.)
									for (const toolCall of timeConsumingTools) {
										const toolDisplay = formatToolCallMessage(toolCall);
										let toolArgs;
										try {
											toolArgs = JSON.parse(toolCall.function.arguments);
										} catch (e) {
											toolArgs = {};
										}

										// Build parameter display for terminal-execute
										let paramDisplay = '';
										if (
											toolCall.function.name === 'terminal-execute' &&
											toolArgs.command
										) {
											paramDisplay = ` "${toolArgs.command}"`;
										} else if (toolDisplay.args.length > 0) {
											const params = toolDisplay.args
												.map((arg: any) => `${arg.key}: ${arg.value}`)
												.join(', ');
											paramDisplay = ` (${params})`;
										}

										const uiMsg = {
											role: 'subagent' as const,
											content: `\x1b[38;2;184;122;206m⚇⚡ ${toolDisplay.toolName}${paramDisplay}\x1b[0m`,
											streaming: false,
											toolCall: {
												name: toolCall.function.name,
												arguments: toolArgs,
											},
											toolCallId: toolCall.id,
											toolPending: true,
											messageStatus: 'pending',
											subAgent: {
												agentId: subAgentMessage.agentId,
												agentName: subAgentMessage.agentName,
												isComplete: false,
											},
											subAgentInternal: true,
										};
										newMessages.push(uiMsg);
									}

									// Display quick tools in compact mode (single line)
									if (quickTools.length > 0) {
										// Format tools with tree structure and parameters
										const toolLines = quickTools.map((tc: any, index: any) => {
											const display = formatToolCallMessage(tc);
											const isLast = index === quickTools.length - 1;
											const prefix = isLast ? '└─' : '├─';

											// Build parameter display
											const params = display.args
												.map((arg: any) => `${arg.key}: ${arg.value}`)
												.join(', ');

											return `\n  \x1b[2m${prefix} ${display.toolName}${
												params ? ` (${params})` : ''
											}\x1b[0m`;
										});

										const uiMsg = {
											role: 'subagent' as const,
											content: `\x1b[36m⚇ ${
												subAgentMessage.agentName
											}\x1b[0m${toolLines.join('')}`,
											streaming: false,
											subAgent: {
												agentId: subAgentMessage.agentId,
												agentName: subAgentMessage.agentName,
												isComplete: false,
											},
											subAgentInternal: true,
											// Store pending tool call IDs for later status update
											pendingToolIds: quickTools.map((tc: any) => tc.id),
										};
										newMessages.push(uiMsg);
									}

									// Save all tool calls to session
									const sessionMsg = {
										role: 'assistant' as const,
										content: toolCalls
											.map((tc: any) => {
												const display = formatToolCallMessage(tc);
												return isToolNeedTwoStepDisplay(tc.function.name)
													? `⚇⚡ ${display.toolName}`
													: `⚇ ${display.toolName}`;
											})
											.join(', '),
										subAgentInternal: true,
										tool_calls: toolCalls,
									};
									saveMessage(sessionMsg).catch(err =>
										console.error('Failed to save sub-agent tool call:', err),
									);

									return [...prev, ...newMessages];
								}
							}

							// Handle tool results from sub-agent
							if (subAgentMessage.message.type === 'tool_result') {
								const msg = subAgentMessage.message as any;
								const isError = msg.content.startsWith('Error:');
								const isTimeConsumingTool = isToolNeedTwoStepDisplay(
									msg.tool_name,
								);

								// Save to session as 'tool' role for API compatibility
								const sessionMsg = {
									role: 'tool' as const,
									tool_call_id: msg.tool_call_id,
									content: msg.content,
									messageStatus: isError ? 'error' : 'success',
									subAgentInternal: true,
								};
								saveMessage(sessionMsg).catch(err =>
									console.error('Failed to save sub-agent tool result:', err),
								);

								// For time-consuming tools, always show result with full details (Diff, etc.)
								if (isTimeConsumingTool) {
									const statusIcon = isError ? '✗' : '✓';
									// UI only shows simple failure message, detailed error is sent to AI via msg.content
									const statusText = '';

									// For terminal-execute, try to extract terminal result data
									let terminalResultData:
										| {
												stdout?: string;
												stderr?: string;
												exitCode?: number;
												command?: string;
										  }
										| undefined;
									if (msg.tool_name === 'terminal-execute' && !isError) {
										try {
											const resultData = JSON.parse(msg.content);
											if (
												resultData.stdout !== undefined ||
												resultData.stderr !== undefined
											) {
												terminalResultData = {
													stdout: resultData.stdout,
													stderr: resultData.stderr,
													exitCode: resultData.exitCode,
													command: resultData.command,
												};
											}
										} catch (e) {
											// If parsing fails, just show regular result
										}
									}

									// For filesystem tools, extract diff data to display DiffViewer
									let fileToolData: any = undefined;
									if (
										!isError &&
										(msg.tool_name === 'filesystem-create' ||
											msg.tool_name === 'filesystem-edit' ||
											msg.tool_name === 'filesystem-edit_search')
									) {
										try {
											const resultData = JSON.parse(msg.content);

											// Handle different result formats
											if (resultData.content) {
												// filesystem-create result
												fileToolData = {
													name: msg.tool_name,
													arguments: {
														content: resultData.content,
														path: resultData.path || resultData.filename,
													},
												};
											} else if (
												resultData.oldContent &&
												resultData.newContent
											) {
												// Single file edit result
												fileToolData = {
													name: msg.tool_name,
													arguments: {
														oldContent: resultData.oldContent,
														newContent: resultData.newContent,
														filename:
															resultData.filePath ||
															resultData.path ||
															resultData.filename,
														completeOldContent: resultData.completeOldContent,
														completeNewContent: resultData.completeNewContent,
														contextStartLine: resultData.contextStartLine,
													},
												};
											} else if (
												resultData.batchResults &&
												Array.isArray(resultData.batchResults)
											) {
												// Batch edit results
												fileToolData = {
													name: msg.tool_name,
													arguments: {
														isBatch: true,
														batchResults: resultData.batchResults,
													},
												};
											}
										} catch (e) {
											// If parsing fails, just show regular result
										}
									}

									// Create completed tool result message for UI
									const uiMsg = {
										role: 'subagent' as const,
										content: `\x1b[38;2;0;186;255m⚇${statusIcon} ${msg.tool_name}\x1b[0m${statusText}`,
										streaming: false,
										messageStatus: isError ? 'error' : 'success',
										toolResult: !isError ? msg.content : undefined,
										terminalResult: terminalResultData,
										toolCall: terminalResultData
											? {
													name: msg.tool_name,
													arguments: terminalResultData,
											  }
											: fileToolData
											? fileToolData
											: undefined,
										subAgent: {
											agentId: subAgentMessage.agentId,
											agentName: subAgentMessage.agentName,
											isComplete: false,
										},
										subAgentInternal: true,
									};
									return [...prev, uiMsg];
								}

								// For quick tools, only show error results, success results update inline
								if (isError) {
									// UI only shows simple failure message, detailed error is sent to AI
									const uiMsg = {
										role: 'subagent' as const,
										content: `\x1b[38;2;255;100;100m⚇✗ ${msg.tool_name}\x1b[0m`,
										streaming: false,
										messageStatus: 'error' as const,
										subAgent: {
											agentId: subAgentMessage.agentId,
											agentName: subAgentMessage.agentName,
											isComplete: false,
										},
										subAgentInternal: true,
									};
									return [...prev, uiMsg];
								}

								// For success, update the pending tools message by removing this tool from pendingToolIds
								const pendingMsgIndex = prev.findIndex(
									m =>
										m.role === 'subagent' &&
										m.subAgent?.agentId === subAgentMessage.agentId &&
										!m.subAgent?.isComplete &&
										m.pendingToolIds?.includes(msg.tool_call_id),
								);

								if (pendingMsgIndex !== -1) {
									const updated = [...prev];
									const pendingMsg = updated[pendingMsgIndex];
									if (pendingMsg && pendingMsg.pendingToolIds) {
										// Remove this tool from pending list
										const newPendingIds = pendingMsg.pendingToolIds.filter(
											id => id !== msg.tool_call_id,
										);

										// Update pending tool IDs
										updated[pendingMsgIndex] = {
											...pendingMsg,
											pendingToolIds: newPendingIds,
										};
									}
									return updated;
								}

								return prev;
							}

							// Check if we already have a message for this agent
							const existingIndex = prev.findIndex(
								m =>
									m.role === 'subagent' &&
									m.subAgent?.agentId === subAgentMessage.agentId &&
									!m.subAgent?.isComplete &&
									!m.pendingToolIds, // Don't match pending tool messages
							);

							// Extract content from the sub-agent message
							let content = '';
							let messageRole = subAgentMessage.message.role || 'assistant'; // Default to assistant if role not specified
							if (subAgentMessage.message.type === 'content') {
								content = subAgentMessage.message.content;
								// Update token count for sub-agent content
								subAgentContentAccumulator += content;
								try {
									const tokens = encoder.encode(subAgentContentAccumulator);
									setStreamTokenCount(tokens.length);
								} catch (e) {
									// Ignore encoding errors
								}
							} else if (
								subAgentMessage.message.type === 'done' ||
								subAgentMessage.message.isResult
							) {
								// Handle completion message or result message
								if (subAgentMessage.message.isResult) {
									// This is a sub-agent result message - add as subagent-result type
									const resultData = subAgentMessage.message;
									return [
										...prev.filter(
											m =>
												m.role !== 'subagent' ||
												m.subAgent?.agentId !== subAgentMessage.agentId ||
												!m.subAgent?.isComplete,
										),
										{
											role: 'subagent-result' as const,
											content: resultData.content || '',
											streaming: false,
											subAgentResult: {
												agentType: resultData.agentType || 'general',
												originalContent: resultData.originalContent,
												timestamp: resultData.timestamp || Date.now(),
												executionTime: resultData.executionTime,
												status: resultData.status || 'success',
											},
										},
									];
								} else {
									// Regular done message - mark as complete and reset token counter
									subAgentContentAccumulator = '';
									setStreamTokenCount(0);
									if (existingIndex !== -1) {
										const updated = [...prev];
										const existing = updated[existingIndex];
										if (existing && existing.subAgent) {
											updated[existingIndex] = {
												...existing,
												subAgent: {
													...existing.subAgent,
													isComplete: true,
												},
											};
										}
										return updated;
									}
									return prev;
								}
							}

							if (existingIndex !== -1) {
								// Update existing message
								const updated = [...prev];
								const existing = updated[existingIndex];
								if (existing) {
									updated[existingIndex] = {
										...existing,
										content: (existing.content || '') + content,
										streaming: true,
									};
								}
								return updated;
							} else if (content) {
								// Add new message based on role
								if (messageRole === 'user') {
									// 子代理插嘴用户消息,仅用于展示,不进入 ESC 历史回退
									return [
										...prev,
										{
											role: 'user' as const,
											content,
											streaming: false,
											subAgentUserMessage: true,
											...(subAgentMessage.message.images && {
												images: subAgentMessage.message.images,
											}),
										},
									];
								} else {
									// Assistant message - display as subagent role
									return [
										...prev,
										{
											role: 'subagent' as const,
											content,
											streaming: true,
											subAgent: {
												agentId: subAgentMessage.agentId,
												agentName: subAgentMessage.agentName,
												isComplete: false,
											},
										},
									];
								}
							}

							return prev;
						});
					},
					requestToolConfirmation,
					isToolAutoApproved,
					yoloMode,
					addToAlwaysApproved,
					//添加 onUserInteractionNeeded 回调用于子代理 askuser 工具
					async (
						question: string,
						options: string[],
						multiSelect?: boolean,
					) => {
						return await requestUserQuestion(
							question,
							options,
							{
								id: 'fake-tool-call',
								type: 'function' as const,
								function: {
									name: 'askuser',
									arguments: '{}',
								},
							},
							multiSelect,
						);
					},
					options.getPendingMessages,
					options.clearPendingMessages,
				);
				options.setSubAgentRunState?.(null);

				// Check if aborted during tool execution
				if (controller.signal.aborted) {
					// Need to add tool results for all pending tool calls to complete conversation history
					// This is critical for sub-agents and any tools that were being executed
					if (receivedToolCalls && receivedToolCalls.length > 0) {
						// NOTE: Assistant message with tool_calls was already saved at line 588 (await saveMessage)
						// No need to save it again here to avoid duplicate assistant messages

						// Now add aborted tool results
						for (const toolCall of receivedToolCalls) {
							const abortedResult = {
								role: 'tool' as const,
								tool_call_id: toolCall.id,
								content: 'Error: Tool execution aborted by user',
								messageStatus: 'error' as const,
							};
							conversationMessages.push(abortedResult);
							try {
								// Use await to ensure aborted results are saved before exiting
								await saveMessage(abortedResult);
							} catch (error) {
								console.error('Failed to save aborted tool result:', error);
							}
						}
					}
					freeEncoder();
					break;
				}

				// Check if any hook failed during tool execution
				const hookFailedResult = toolResults.find(r => r.hookFailed);
				if (hookFailedResult) {
					// Add tool results to conversation and break the loop
					for (const result of toolResults) {
						const {hookFailed, ...resultWithoutFlag} = result;
						conversationMessages.push(resultWithoutFlag);
						saveMessage(resultWithoutFlag).catch(error => {
							console.error('Failed to save tool result:', error);
						});
					}

					// Display hook error using HookErrorDisplay component
					setMessages(prev => [
						...prev,
						{
							role: 'assistant',
							content: '', // Content will be rendered by HookErrorDisplay
							streaming: false,
							hookError: hookFailedResult.hookErrorDetails,
						},
					]);

					if (options.setIsStreaming) {
						options.setIsStreaming(false);
					}
					freeEncoder();
					break;
				}

				// CRITICAL: 在压缩前，必须先将 toolResults 保存到 conversationMessages 和会话文件
				// 这样压缩时读取的会话才包含完整的工具调用和结果
				// 否则新会话只有 tool_calls 没有对应的 tool results
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
						console.error(
							'Failed to save tool result before compression:',
							error,
						);
					}
				}

				// 在工具执行完成后、发送结果到AI前，检查是否需要压缩
				const config = getOpenAiConfig();
				if (
					config.enableAutoCompress !== false &&
					options.getCurrentContextPercentage &&
					shouldAutoCompress(options.getCurrentContextPercentage())
				) {
					try {
						// 显示压缩提示消息
						const compressingMessage: Message = {
							role: 'assistant',
							content:
								'✵ Auto-compressing context before sending tool results...',
							streaming: false,
						};
						setMessages(prev => [...prev, compressingMessage]);

						// 获取当前会话ID并传递给压缩函数
						const session = sessionManager.getCurrentSession();
						const compressionResult = await performAutoCompression(session?.id);

						// Check if beforeCompress hook failed
						if (compressionResult && (compressionResult as any).hookFailed) {
							// Hook failed, display error and abort AI flow
							setMessages(prev => [
								...prev,
								{
									role: 'assistant',
									content: '', // Content will be rendered by HookErrorDisplay
									streaming: false,
									hookError: (compressionResult as any).hookErrorDetails,
								},
							]);

							if (options.setIsStreaming) {
								options.setIsStreaming(false);
							}
							freeEncoder();
							break; // Abort AI flow
						}

						if (compressionResult && options.clearSavedMessages) {
							// 更新UI和token使用情况
							options.clearSavedMessages();
							setMessages(compressionResult.uiMessages);
							if (options.setRemountKey) {
								options.setRemountKey(prev => prev + 1);
							}

							// Only update usage if compressionResult has usage field
							if (compressionResult.usage) {
								options.setContextUsage(compressionResult.usage);
								// 更新累计的usage为压缩后的usage
								accumulatedUsage = compressionResult.usage;
							}

							// 压缩创建了新会话，新会话的快照系统是独立的
							// 清空当前的快照计数，因为新会话还没有快照
							if (options.setSnapshotFileCount) {
								options.setSnapshotFileCount(new Map());
							}

							// 压缩后需要重新构建conversationMessages
							conversationMessages = [];
							const session = sessionManager.getCurrentSession();

							// 1. 添加系统消息
							conversationMessages.push({
								role: 'system',
								content: mainAgentManager.getSystemPrompt(),
							});

							// 2. 如果有TODOs，添加TODO上下文
							if (existingTodoList && existingTodoList.todos.length > 0) {
								const todoContext = formatTodoContext(existingTodoList.todos);
								conversationMessages.push({
									role: 'user',
									content: todoContext,
								});
							}

							// 3. 压缩后重新获取并添加有用信息上下文
							const usefulInfoService = getUsefulInfoService();
							const updatedUsefulInfoList =
								await usefulInfoService.getUsefulInfoList(session?.id || '');

							if (
								updatedUsefulInfoList &&
								updatedUsefulInfoList.items.length > 0
							) {
								const usefulInfoContext = await formatUsefulInfoContext(
									updatedUsefulInfoList.items,
								);
								conversationMessages.push({
									role: 'user',
									content: usefulInfoContext,
								});
							}

							// 4. 添加压缩摘要
							conversationMessages.push({
								role: 'user',
								content: `[Context Summary from Previous Conversation]\n\n${compressionResult.summary}`,
							});

							// 5. 添加保留的消息（未完成的工具调用链）
							if (
								compressionResult.preservedMessages &&
								compressionResult.preservedMessages.length > 0
							) {
								for (const msg of compressionResult.preservedMessages) {
									conversationMessages.push(msg);
								}
							}

							// 6. 添加会话中的其他消息（排除已保留的）
							if (session && session.messages.length > 0) {
								// 获取已保留的消息ID集合，避免重复
								const preservedIds = new Set(
									compressionResult.preservedMessages?.map(
										msg =>
											msg.tool_call_id ||
											(msg.tool_calls && msg.tool_calls[0]?.id) ||
											`${msg.role}-${msg.content.slice(0, 20)}`,
									) || [],
								);

								for (const sessionMsg of session.messages) {
									const msgId =
										sessionMsg.tool_call_id ||
										(sessionMsg.tool_calls && sessionMsg.tool_calls[0]?.id) ||
										`${sessionMsg.role}-${sessionMsg.content.slice(0, 20)}`;

									// 跳过已保留的消息和工具消息
									if (!preservedIds.has(msgId) && sessionMsg.role !== 'tool') {
										conversationMessages.push({
											role: sessionMsg.role,
											content: sessionMsg.content,
											...(sessionMsg.tool_calls && {
												tool_calls: sessionMsg.tool_calls,
											}),
											...(sessionMsg.images && {images: sessionMsg.images}),
											...(sessionMsg.reasoning && {
												reasoning: sessionMsg.reasoning,
											}),
										});
									}
								}
							}
						}
					} catch (error) {
						console.error(
							'Auto-compression after tool execution failed:',
							error,
						);
						// 即使压缩失败也继续处理工具结果
					}
				}

				// Remove only streaming sub-agent content messages (not tool-related messages)
				// Keep sub-agent tool call and tool result messages for display
				setMessages(prev =>
					prev.filter(
						m =>
							m.role !== 'subagent' ||
							m.toolCall !== undefined ||
							m.toolResult !== undefined ||
							m.subAgentInternal === true,
					),
				);

				// Update existing tool call messages with results
				// Collect all result messages first, then add them in batch
				const resultMessages: any[] = [];
				for (const result of toolResults) {
					const toolCall = receivedToolCalls!.find(
						tc => tc.id === result.tool_call_id,
					);
					if (toolCall) {
						// Special handling for sub-agent tools - show completion message
						// Pass the full JSON result to ToolResultPreview for proper parsing
						if (toolCall.function.name.startsWith('subagent-')) {
							const isError = result.content.startsWith('Error:');
							const statusIcon = isError ? '✗' : '✓';
							// UI only shows simple failure message, detailed error is sent to AI via result.content
							const statusText = '';

							// Parse sub-agent result to extract usage information
							let usage: any = undefined;
							if (!isError) {
								try {
									const subAgentResult = JSON.parse(result.content);
									usage = subAgentResult.usage;
								} catch (e) {
									// Ignore parsing errors
								}
							}

							resultMessages.push({
								role: 'assistant',
								content: `${statusIcon} ${toolCall.function.name}${statusText}`,
								streaming: false,
								messageStatus: isError ? 'error' : 'success',
								// Pass the full result.content for ToolResultPreview to parse
								toolResult: !isError ? result.content : undefined,
								subAgentUsage: usage,
							});

							// Tool result already saved before compression check (line 1374-1384)
							// No need to save again here
							continue;
						}

						const isError = result.content.startsWith('Error:');
						const statusIcon = isError ? '✗' : '✓';
						// UI only shows simple failure message, detailed error is sent to AI via result.content
						const statusText = '';

						// Check if this is an edit tool with diff data
						let editDiffData:
							| {
									oldContent?: string;
									newContent?: string;
									filename?: string;
									completeOldContent?: string;
									completeNewContent?: string;
									contextStartLine?: number;
									batchResults?: any[];
									isBatch?: boolean;
							  }
							| undefined;
						if (
							(toolCall.function.name === 'filesystem-edit' ||
								toolCall.function.name === 'filesystem-edit_search') &&
							!isError
						) {
							try {
								const resultData = JSON.parse(result.content);
								// Handle single file edit
								if (resultData.oldContent && resultData.newContent) {
									editDiffData = {
										oldContent: resultData.oldContent,
										newContent: resultData.newContent,
										filename: JSON.parse(toolCall.function.arguments).filePath,
										completeOldContent: resultData.completeOldContent,
										completeNewContent: resultData.completeNewContent,
										contextStartLine: resultData.contextStartLine,
									};
								}
								// Handle batch edit
								else if (
									resultData.results &&
									Array.isArray(resultData.results)
								) {
									editDiffData = {
										batchResults: resultData.results,
										isBatch: true,
									};
								}
							} catch (e) {
								// If parsing fails, just show regular result
							}
						}

						// 处理工具执行结果的显示
						// - 耗时工具(两步显示):完成消息追加到静态区，之前的进行中消息已包含参数
						// - 普通工具(单步显示):完成消息需要包含参数和结果，使用 toolDisplay

						// 获取工具参数的格式化信息
						const toolDisplay = formatToolCallMessage(toolCall);
						const isNonTimeConsuming = !isToolNeedTwoStepDisplay(
							toolCall.function.name,
						);

						resultMessages.push({
							role: 'assistant',
							content: `${statusIcon} ${toolCall.function.name}${statusText}`,
							streaming: false,
							messageStatus: isError ? 'error' : 'success',
							toolCall: editDiffData
								? {
										name: toolCall.function.name,
										arguments: editDiffData,
								  }
								: undefined,
							// 为普通工具添加参数显示（耗时工具在进行中状态已经显示过参数）
							toolDisplay: isNonTimeConsuming ? toolDisplay : undefined,
							// Store tool result for preview rendering
							toolResult: !isError ? result.content : undefined,
							// Mark parallel group for ALL tools (time-consuming or not)
							parallelGroup: parallelGroupId,
						});
					}

					// Tool results already saved before compression check (line 1374-1384)
					// No need to save again here
				}

				// Add all result messages in batch to avoid intermediate renders
				if (resultMessages.length > 0) {
					setMessages(prev => [...prev, ...resultMessages]);
				}

				// Check if there are pending user messages to insert
				if (options.getPendingMessages && options.clearPendingMessages) {
					const pendingMessages = options.getPendingMessages();
					if (pendingMessages.length > 0) {
						// 检查 token 占用，如果 >= 80% 先执行自动压缩
						const config = getOpenAiConfig();
						if (
							config.enableAutoCompress !== false &&
							options.getCurrentContextPercentage &&
							shouldAutoCompress(options.getCurrentContextPercentage())
						) {
							try {
								// 显示压缩提示消息
								const compressingMessage: Message = {
									role: 'assistant',
									content:
										'✵ Auto-compressing context before processing pending messages...',
									streaming: false,
								};
								setMessages(prev => [...prev, compressingMessage]);

								// 获取当前会话ID并传递给压缩函数
								const session = sessionManager.getCurrentSession();
								const compressionResult = await performAutoCompression(
									session?.id,
								);

								// Check if beforeCompress hook failed
								if (
									compressionResult &&
									(compressionResult as any).hookFailed
								) {
									// Hook failed, display error and abort AI flow
									setMessages(prev => [
										...prev,
										{
											role: 'assistant',
											content: '', // Content will be rendered by HookErrorDisplay
											streaming: false,
											hookError: (compressionResult as any).hookErrorDetails,
										},
									]);

									if (options.setIsStreaming) {
										options.setIsStreaming(false);
									}
									freeEncoder();
									break; // Abort AI flow
								}

								if (compressionResult && options.clearSavedMessages) {
									// 更新UI和token使用情况
									options.clearSavedMessages();
									setMessages(compressionResult.uiMessages);
									if (options.setRemountKey) {
										options.setRemountKey(prev => prev + 1);
									}

									// Only update usage if compressionResult has usage field
									if (compressionResult.usage) {
										options.setContextUsage(compressionResult.usage);
										// 更新累计的usage为压缩后的usage
										accumulatedUsage = compressionResult.usage;
									}

									// 压缩后需要重新构建conversationMessages
									conversationMessages = [];
									const session = sessionManager.getCurrentSession();

									// 1. 添加系统消息
									conversationMessages.push({
										role: 'system',
										content: mainAgentManager.getSystemPrompt(),
									});

									// 2. 如果有TODOs，添加TODO上下文
									if (existingTodoList && existingTodoList.todos.length > 0) {
										const todoContext = formatTodoContext(
											existingTodoList.todos,
										);
										conversationMessages.push({
											role: 'user',
											content: todoContext,
										});
									}

									// 3. 压缩后重新获取并添加有用信息上下文
									const usefulInfoService = getUsefulInfoService();
									const updatedUsefulInfoList =
										await usefulInfoService.getUsefulInfoList(
											session?.id || '',
										);

									if (
										updatedUsefulInfoList &&
										updatedUsefulInfoList.items.length > 0
									) {
										const usefulInfoContext = await formatUsefulInfoContext(
											updatedUsefulInfoList.items,
										);
										conversationMessages.push({
											role: 'user',
											content: usefulInfoContext,
										});
									}

									// 4. 添加压缩摘要
									conversationMessages.push({
										role: 'user',
										content: `[Context Summary from Previous Conversation]\n\n${compressionResult.summary}`,
									});

									// 5. 添加保留的消息（未完成的工具调用链）
									if (
										compressionResult.preservedMessages &&
										compressionResult.preservedMessages.length > 0
									) {
										for (const msg of compressionResult.preservedMessages) {
											conversationMessages.push(msg);
										}
									}

									// 6. 添加会话中的其他消息（排除已保留的）
									if (session && session.messages.length > 0) {
										// 获取已保留的消息ID集合，避免重复
										const preservedIds = new Set(
											compressionResult.preservedMessages?.map(
												msg =>
													msg.tool_call_id ||
													(msg.tool_calls && msg.tool_calls[0]?.id) ||
													`${msg.role}-${msg.content.slice(0, 20)}`,
											) || [],
										);

										for (const sessionMsg of session.messages) {
											const msgId =
												sessionMsg.tool_call_id ||
												(sessionMsg.tool_calls &&
													sessionMsg.tool_calls[0]?.id) ||
												`${sessionMsg.role}-${sessionMsg.content.slice(0, 20)}`;

											// 跳过已保留的消息和工具消息
											if (
												preservedIds.has(msgId) ||
												sessionMsg.role === 'tool'
											) {
												continue;
											}

											conversationMessages.push(sessionMsg);
										}
									}
								}
							} catch (error) {
								console.error(
									'Auto-compression before pending messages failed:',
									error,
								);
								// 即使压缩失败也继续处理pending消息
							}
						}

						// Clear pending messages
						options.clearPendingMessages();

						// Combine multiple pending messages into one
						const combinedMessage = pendingMessages
							.map(m => m.text)
							.join('\n\n');

						// Collect all images from pending messages
						const allPendingImages = pendingMessages
							.flatMap(m => m.images || [])
							.map(img => ({
								type: 'image' as const,
								data: img.data,
								mimeType: img.mimeType,
							}));

						// Create snapshot before adding pending message to UI
						// NOTE: New on-demand backup system - no longer需要 need manual snapshot creation
						// Files will be automatically backed up when they are modified

						// Add user message to UI
						const userMessage: Message = {
							role: 'user',
							content: combinedMessage,
							images:
								allPendingImages.length > 0 ? allPendingImages : undefined,
						};
						setMessages(prev => [...prev, userMessage]);

						// Add user message to conversation history (using images field for image data)
						conversationMessages.push({
							role: 'user',
							content: combinedMessage,
							images:
								allPendingImages.length > 0 ? allPendingImages : undefined,
						});

						// Save user message
						try {
							await saveMessage({
								role: 'user',
								content: combinedMessage,
								images:
									allPendingImages.length > 0 ? allPendingImages : undefined,
							});

							// Set conversation context for pending message
							// This provides sessionId and messageIndex to file operations
							const {setConversationContext} = await import(
								'../../utils/codebase/conversationContext.js'
							);
							const updatedSession = sessionManager.getCurrentSession();
							if (updatedSession) {
								setConversationContext(
									updatedSession.id,
									updatedSession.messages.length,
								);
							}
						} catch (error) {
							console.error('Failed to save pending user message:', error);
						}
					}
				}

				// Continue loop to get next response
				continue;
			}

			// No tool calls - conversation is complete
			// Display text content if any
			if (streamedContent.trim()) {
				finalAssistantMessage = {
					role: 'assistant',
					content: streamedContent.trim(),
					streaming: false,
					discontinued: controller.signal.aborted,
					thinking: extractThinkingContent(
						receivedThinking,
						receivedReasoning,
						receivedReasoningContent,
					),
				};
				setMessages(prev => [...prev, finalAssistantMessage!]);

				// Add to conversation history and save
				const assistantMessage: ChatMessage = {
					role: 'assistant',
					content: streamedContent.trim(),
					reasoning: receivedReasoning, // Include reasoning data for caching (Responses API)
					thinking: receivedThinking, // Include thinking content (Anthropic/OpenAI)
					reasoning_content: receivedReasoningContent, // Include reasoning content (DeepSeek R1)
				};
				conversationMessages.push(assistantMessage);
				saveMessage(assistantMessage).catch(error => {
					console.error('Failed to save assistant message:', error);
				});
			}

			// ✅ 执行 onStop 钩子（在会话结束前，非用户中断）
			if (!controller.signal.aborted) {
				try {
					const hookResult = await unifiedHooksExecutor.executeHooks('onStop', {
						messages: conversationMessages,
					});

					// 处理钩子返回结果
					if (hookResult.results && hookResult.results.length > 0) {
						let shouldContinue = false;
						for (const result of hookResult.results) {
							if (result.type === 'command' && !result.success) {
								if (result.exitCode === 1) {
									// exitCode 1: 警告，显示给用户
									console.log(
										'[WARN] onStop hook warning:',
										result.error || result.output || '',
									);
								} else if (result.exitCode >= 2) {
									// exitCode >= 2: 错误，发送给 AI 继续处理
									const errorMessage: ChatMessage = {
										role: 'user',
										content: result.error || result.output || '未知错误',
									};
									conversationMessages.push(errorMessage);
									await saveMessage(errorMessage);
									setMessages(prev => [
										...prev,
										{
											role: 'user',
											content: errorMessage.content,
											streaming: false,
										},
									]);
									shouldContinue = true;
								}
							} else if (result.type === 'prompt' && result.response) {
								// 处理 prompt 类型
								if (result.response.ask === 'ai' && result.response.continue) {
									// 发送给 AI 继续处理
									const promptMessage: ChatMessage = {
										role: 'user',
										content: result.response.message,
									};
									conversationMessages.push(promptMessage);
									await saveMessage(promptMessage);
									setMessages(prev => [
										...prev,
										{
											role: 'user',
											content: promptMessage.content,
											streaming: false,
										},
									]);
									shouldContinue = true;
								} else if (
									result.response.ask === 'user' &&
									!result.response.continue
								) {
									// 显示给用户
									setMessages(prev => [
										...prev,
										{
											role: 'assistant',
											content: result.response!.message,
											streaming: false,
										},
									]);
								}
							}
						}

						// 如果需要继续，则不 break，让循环继续
						if (shouldContinue) {
							continue;
						}
					}
				} catch (error) {
					console.error('onStop hook execution failed:', error);
				}
			}

			// Conversation complete - exit the loop
			break;
		}

		// Free encoder
		freeEncoder();
	} finally {
		// CRITICAL: Ensure UI state is always cleaned up
		// This block MUST execute to prevent "Thinking..." from hanging
		// Even if an error occurs or the process is aborted
		if (options.setIsStreaming) {
			options.setIsStreaming(false);
		}

		// 重置停止状态 - 修复 ESC 后界面卡住的问题
		if (options.setIsStopping) {
			options.setIsStopping(false);
		}

		// 同步提交所有待处理快照 - 确保快照保存可靠性
		// NOTE: New on-demand backup system - snapshot management is now automatic
		// Files are backed up when they are created/modified
		// No need for manual commit process

		// Clear conversation context after tool execution completes
		try {
			const {clearConversationContext} = await import(
				'../../utils/codebase/conversationContext.js'
			);
			clearConversationContext();
		} catch (error) {
			// Ignore errors during cleanup
		}

		// ✅ 确保总是释放encoder资源，避免资源泄漏
		freeEncoder();
	}

	// Return the accumulated usage data
	return {usage: accumulatedUsage};
}
