import {
	getOpenAiConfig,
	getCustomHeadersForConfig,
	getCustomSystemPromptForConfig,
	getCustomSystemPrompt,
} from '../utils/config/apiConfig.js';
import {mainAgentManager} from '../utils/MainAgentManager.js';
import {
	withRetryGenerator,
	parseJsonWithFix,
} from '../utils/core/retryUtils.js';
import type {
	ChatMessage,
	ChatCompletionTool,
	ToolCall,
	UsageInfo,
	ImageContent,
} from './types.js';
import {logger} from '../utils/core/logger.js';
import {addProxyToFetchOptions} from '../utils/core/proxyUtils.js';
import {saveUsageToFile} from '../utils/core/usageLogger.js';
import {getVersionHeader} from '../utils/core/version.js';
import {
	createIdleTimeoutGuard,
	StreamIdleTimeoutError,
} from '../utils/core/streamGuards.js';

export type {
	ChatMessage,
	ChatCompletionTool,
	ToolCall,
	UsageInfo,
	ImageContent,
};

/**
 * Chat API调用选项
 */
export interface ChatCompletionOptions {
	model: string; // 使用的模型名称
	messages: ChatMessage[]; // 对话消息数组
	stream?: boolean; // 是否使用流式输出
	temperature?: number; // 采样温度，控制输出的随机性
	max_tokens?: number; // 最大生成token数
	tools?: ChatCompletionTool[]; // 可用的工具列表
	tool_choice?:
		| 'auto'
		| 'none'
		| 'required'
		| {type: 'function'; function: {name: string}};
	includeBuiltinSystemPrompt?: boolean; // 控制是否添加内置系统提示词（默认 true）
	teamMode?: boolean; // 启用 Team 模式（使用 Team 模式系统提示词）
	// 子代理配置覆盖
	configProfile?: string; // 子代理配置文件名（覆盖模型等设置）
	customSystemPromptId?: string; // 自定义系统提示词 ID
	customHeaders?: Record<string, string>; // 自定义请求头
	subAgentSystemPrompt?: string; // 子代理组装好的完整提示词（包含role等信息）
}

export interface ChatCompletionChunk {
	id: string;
	object: 'chat.completion.chunk';
	created: number;
	model: string;
	choices: Array<{
		index: number;
		delta: {
			role?: string;
			content?: string;
			tool_calls?: Array<{
				index?: number;
				id?: string;
				type?: 'function';
				function?: {
					name?: string;
					arguments?: string;
				};
			}>;
		};
		finish_reason?: string | null;
	}>;
}

export interface ChatCompletionMessageParam {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content:
		| string
		| Array<{
				type: 'text' | 'image_url';
				text?: string;
				image_url?: {url: string};
		  }>;
	tool_call_id?: string;
	tool_calls?: ToolCall[];
}

/**
 * 将我们的ChatMessage格式转换为OpenAI格式
 * 支持纯文本和多模态(文本+图片)消息
 * 系统提示词处理:
 * 1. 如果提供自定义系统提示词: 将其作为system消息,默认作为user消息
 * 2. 如果没有自定义系统提示词: 使用默认作为system
 * @param messages - 要转换的消息数组
 * @param includeBuiltinSystemPrompt - 是否包含内置系统提示词(默认true)
 * @param customSystemPromptOverride - 自定义系统提示词内容(用于子代理)
 */
function convertToOpenAIMessages(
	messages: ChatMessage[],
	includeBuiltinSystemPrompt: boolean = true,
	customSystemPromptOverride?: string,
	isSubAgentCall: boolean = false,
	subAgentSystemPrompt?: string,
	// 为 true 时,使用 Team 模式系统提示词(已弃用)
): ChatCompletionMessageParam[] {
	// 子代理调用：使用传递的 customSystemPrompt（由全局配置决定）
	// 如果没有 customSystemPrompt，则使用子代理自己组装的提示词
	// 子代理不会使用主代理自己组装的系统提示词
	const customSystemPrompt = isSubAgentCall
		? customSystemPromptOverride // 子代理使用传递的 customSystemPrompt（遵循全局配置）
		: customSystemPromptOverride || getCustomSystemPrompt(); // 主代理可以回退到默认的customSystemPrompt

	// 对于子代理调用，完全忽略includeBuiltinSystemPrompt参数
	const effectiveIncludeBuiltinSystemPrompt = isSubAgentCall
		? false
		: includeBuiltinSystemPrompt;

	let result = messages.map(msg => {
		// 如果消息包含图片，使用 content 数组格式
		if (msg.role === 'user' && msg.images && msg.images.length > 0) {
			const contentParts: Array<{
				type: 'text' | 'image_url';
				text?: string;
				image_url?: {url: string};
			}> = [];

			// 添加文本内容
			if (msg.content) {
				contentParts.push({
					type: 'text',
					text: msg.content,
				});
			}

			// 添加图片内容
			for (const image of msg.images) {
				contentParts.push({
					type: 'image_url',
					image_url: {
						url: image.data, // Base64 data URL
					},
				});
			}

			return {
				role: 'user',
				content: contentParts,
			} as ChatCompletionMessageParam;
		}

		const baseMessage = {
			role: msg.role,
			content: msg.content,
		};
		if (msg.role === 'assistant' && msg.tool_calls) {
			const result: any = {
				...baseMessage,
				tool_calls: msg.tool_calls,
			};
			// 为 DeepSeek R1 模型包含推理内容
			if ((msg as any).reasoning_content) {
				result.reasoning_content = (msg as any).reasoning_content;
			}
			return result as ChatCompletionMessageParam;
		}

		if (msg.role === 'tool' && msg.tool_call_id) {
			// 处理包含图片的多模态工具结果
			if (msg.images && msg.images.length > 0) {
				const content: Array<{
					type: 'text' | 'image_url';
					text?: string;
					image_url?: {url: string};
				}> = [];

				// 添加文本内容
				if (msg.content) {
					content.push({
						type: 'text',
						text: msg.content,
					});
				}

				// 添加 base64 编码的图片数据
				for (const image of msg.images) {
					const imageUrl =
						/^data:/i.test(image.data) || /^https?:\/\//i.test(image.data)
							? image.data
							: `data:${image.mimeType};base64,${image.data}`;
					content.push({
						type: 'image_url',
						image_url: {
							url: imageUrl,
						},
					});
				}

				return {
					role: 'tool',
					content,
					tool_call_id: msg.tool_call_id,
				} as ChatCompletionMessageParam;
			}

			return {
				role: 'tool',
				content: msg.content,
				tool_call_id: msg.tool_call_id,
			} as ChatCompletionMessageParam;
		}
		// 为助手消息包含推理内容(DeepSeek R1)
		if (msg.role === 'assistant' && (msg as any).reasoning_content) {
			return {
				...baseMessage,
				reasoning_content: (msg as any).reasoning_content,
			} as any;
		}

		return baseMessage as ChatCompletionMessageParam;
	});

	// 如果第一条消息已经是 system 消息，跳过
	if (result.length > 0 && result[0]?.role === 'system') {
		return result;
	}

	// 统一的系统提示词逻辑
	// 1. 子代理调用且有自定义系统提示词：使用自定义系统提示词
	if (isSubAgentCall && customSystemPrompt) {
		result = [
			{
				role: 'system',
				content: customSystemPrompt,
			} as ChatCompletionMessageParam,
			...result,
		];
		// subAgentSystemPrompt 会作为 user 消息保留在 messages 中（已在第一条或特殊user位置）
	}
	// 2. 子代理调用且没有自定义系统提示词：使用子代理组装的提示词
	else if (isSubAgentCall && subAgentSystemPrompt) {
		result = [
			{
				role: 'system',
				content: subAgentSystemPrompt,
			} as ChatCompletionMessageParam,
			...result,
		];
		// finalPrompt 会同时在 system 和 user 中存在（已在 messages 第一条）
	}
	// 3. 主代理调用且有自定义系统提示词：使用自定义系统提示词，不添加主代理角色定义
	else if (customSystemPrompt && !isSubAgentCall) {
		result = [
			{
				role: 'system',
				content: customSystemPrompt,
			} as ChatCompletionMessageParam,
			...result,
		];
		// 不再添加 mainAgentManager.getSystemPrompt()，让自定义系统提示词完全替代
		// 主代理角色定义会在 sessionInitializer.ts 中作为特殊 user 消息动态插入
	}
	// 4. 主代理调用且没有自定义系统提示词：使用主代理角色定义
	else if (effectiveIncludeBuiltinSystemPrompt) {
		result = [
			{
				role: 'system',
				content: mainAgentManager.getSystemPrompt(),
			} as ChatCompletionMessageParam,
			...result,
		];
	}

	return result;
}

export function resetOpenAIClient(): void {
	// No-op: kept for backward compatibility
}

export interface StreamChunk {
	type:
		| 'content'
		| 'tool_calls'
		| 'tool_call_delta'
		| 'reasoning_delta'
		| 'reasoning_started'
		| 'done'
		| 'usage';
	content?: string;
	tool_calls?: Array<{
		id: string;
		type: 'function';
		function: {
			name: string;
			arguments: string;
		};
	}>;
	delta?: string; // 用于工具调用流式分块或推理内容
	usage?: UsageInfo; // Token 使用信息
	reasoning_content?: string; // DeepSeek R1 模型的完整推理内容
}

/**
 * Parse Server-Sent Events (SSE) stream
 */
async function* parseSSEStream(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	abortSignal?: AbortSignal,
): AsyncGenerator<any, void, unknown> {
	const decoder = new TextDecoder();
	let buffer = '';
	let dataCount = 0; // 记录成功解析的数据块数量
	let lastEventType = ''; // 记录最后一个事件类型

	// 创建空闲超时保护器
	const guard = createIdleTimeoutGuard({
		reader,
		onTimeout: () => {
			throw new StreamIdleTimeoutError('No data received for 180000ms');
		},
	});

	try {
		while (true) {
			// 用户主动中断时立即标记丢弃,避免延迟消息外泄
			if (abortSignal?.aborted) {
				guard.abandon();
				return;
			}

			const {done, value} = await reader.read();

			// 更新活动时间
			guard.touch();

			// 检查是否有超时错误需要在读取循环中抛出(确保被正确的 try/catch 捕获)
			const timeoutError = guard.getTimeoutError();
			if (timeoutError) {
				throw timeoutError;
			}

			// 检查是否已被丢弃(竞态条件防护)
			if (guard.isAbandoned()) {
				continue;
			}

			if (done) {
				// 连接异常中断时,残留半包不应被静默丢弃,应抛出可重试错误
				if (buffer.trim()) {
					// 连接异常中断，抛出明确错误，包含更详细的断点信息
					const errorContext = {
						dataCount,
						lastEventType,
						bufferLength: buffer.length,
						bufferPreview: buffer.substring(0, 200),
					};

					const errorMessage = `[API_ERROR] [RETRIABLE] OpenAI stream terminated unexpectedly with incomplete data`;
					logger.error(errorMessage, errorContext);
					throw new Error(
						`${errorMessage}. Context: ${JSON.stringify(errorContext)}`,
					);
				}
				break; // 正常结束
			}

			buffer += decoder.decode(value, {stream: true});
			const lines = buffer.split('\n');
			buffer = lines.pop() || '';

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith(':')) continue;

				if (trimmed === 'data: [DONE]' || trimmed === 'data:[DONE]') {
					return;
				}

				// Handle both "event: " and "event:" formats
				if (trimmed.startsWith('event:')) {
					// 记录事件类型用于断点恢复
					lastEventType = trimmed.startsWith('event: ')
						? trimmed.slice(7)
						: trimmed.slice(6);
					continue;
				}

				// Handle both "data: " and "data:" formats
				if (trimmed.startsWith('data:')) {
					const data = trimmed.startsWith('data: ')
						? trimmed.slice(6)
						: trimmed.slice(5);
					const parseResult = parseJsonWithFix(data, {
						toolName: 'SSE stream',
						logWarning: false,
						logError: true,
					});

					if (parseResult.success) {
						dataCount++;
						// yield 前检查是否已被丢弃(竞态条件防护)
						if (!guard.isAbandoned()) {
							yield parseResult.data;
						}
					}
				}
			}
		}
	} catch (error) {
		const {logger} = await import('../utils/core/logger.js');

		// 增强错误日志，包含断点状态
		const errorContext = {
			error: error instanceof Error ? error.message : 'Unknown error',
			dataCount,
			lastEventType,
			bufferLength: buffer.length,
			bufferPreview: buffer.substring(0, 200),
		};
		logger.error(
			'[API_ERROR] [RETRIABLE] OpenAI SSE stream parsing error with checkpoint context:',
			errorContext,
		);
		throw error;
	} finally {
		// 清理 idle timeout 定时器
		guard.dispose();
	}
}

/**
 * Simple streaming chat completion - only handles OpenAI interaction
 * Tool execution should be handled by the caller
 */
export async function* createStreamingChatCompletion(
	options: ChatCompletionOptions,
	abortSignal?: AbortSignal,
	onRetry?: (error: Error, attempt: number, nextDelay: number) => void,
): AsyncGenerator<StreamChunk, void, unknown> {
	// Load configuration: if configProfile is specified, load it; otherwise use main config
	let config: ReturnType<typeof getOpenAiConfig>;
	if (options.configProfile) {
		try {
			const {loadProfile} = await import('../utils/config/configManager.js');
			const profileConfig = loadProfile(options.configProfile);
			if (profileConfig?.snowcfg) {
				config = profileConfig.snowcfg;
			} else {
				// Profile not found, fallback to main config
				config = getOpenAiConfig();
				const {logger} = await import('../utils/core/logger.js');
				logger.warn(
					`Profile ${options.configProfile} not found, using main config`,
				);
			}
		} catch (error) {
			// If loading profile fails, fallback to main config
			config = getOpenAiConfig();
			const {logger} = await import('../utils/core/logger.js');
			logger.warn(
				`Failed to load profile ${options.configProfile}, using main config:`,
				error,
			);
		}
	} else {
		// No configProfile specified, use main config
		config = getOpenAiConfig();
	}

	// Get system prompt (with custom override support)
	let customSystemPromptContent: string | undefined;
	if (options.customSystemPromptId) {
		const {getSystemPromptConfig} = await import(
			'../utils/config/apiConfig.js'
		);
		const systemPromptConfig = getSystemPromptConfig();
		const customPrompt = systemPromptConfig?.prompts.find(
			p => p.id === options.customSystemPromptId,
		);
		if (customPrompt) {
			customSystemPromptContent = customPrompt.content;
		}
	}

	// 如果没有显式的 customSystemPromptId，则按当前配置（含 profile 覆盖）解析
	customSystemPromptContent ||= getCustomSystemPromptForConfig(config);

	// 使用重试包装生成器
	yield* withRetryGenerator(
		async function* () {
			const requestBody = {
				model: options.model || config.advancedModel,
				messages: convertToOpenAIMessages(
					options.messages,
					options.includeBuiltinSystemPrompt !== false, // 默认为 true
					customSystemPromptContent,
					!!options.customSystemPromptId || !!options.subAgentSystemPrompt, // 子代理调用的判断：只要有customSystemPromptId或subAgentSystemPrompt就认为是子代理调用
					options.subAgentSystemPrompt,
					// Pass teamMode to use correct system prompt (deprecated)
				),
				stream: true,
				stream_options: {include_usage: true},
				temperature: options.temperature || 0.7,
				max_tokens: options.max_tokens,
				tools: options.tools,
				tool_choice: options.tool_choice,
			};

			const url = `${config.baseUrl}/chat/completions`;

			// Use custom headers from options if provided, otherwise get from current config (supports profile override)
			const customHeaders =
				options.customHeaders || getCustomHeadersForConfig(config);

			const fetchOptions = addProxyToFetchOptions(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${config.apiKey}`,
					'x-snow': getVersionHeader(),
					...customHeaders,
				},
				body: JSON.stringify(requestBody),
				signal: abortSignal,
			});

			let response: Response;
			try {
				response = await fetch(url, fetchOptions);
			} catch (error) {
				// 捕获 fetch 底层错误（网络错误、连接超时等）
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				throw new Error(
					`OpenAI API fetch failed: ${errorMessage}\n` +
						`URL: ${url}\n` +
						`Model: ${requestBody.model}\n` +
						`Error type: ${
							error instanceof TypeError
								? 'Network/Connection Error'
								: 'Unknown Error'
						}\n` +
						`Possible causes: Network unavailable, DNS resolution failed, proxy issues, or server unreachable`,
				);
			}

			if (!response.ok) {
				const errorText = await response.text();
				const errorMsg = `[API_ERROR] OpenAI API HTTP ${response.status}: ${response.statusText} - ${errorText}`;
				logger.error(errorMsg, {
					status: response.status,
					statusText: response.statusText,
					url,
					model: requestBody.model,
				});
				throw new Error(errorMsg);
			}

			if (!response.body) {
				const errorMsg =
					'[API_ERROR] No response body from OpenAI API (empty response)';
				logger.error(errorMsg, {
					url,
					model: requestBody.model,
				});
				throw new Error(errorMsg);
			}

			let contentBuffer = '';
			let toolCallsBuffer: {[index: number]: any} = {};
			let hasToolCalls = false;
			let usageData: UsageInfo | undefined;
			let reasoningStarted = false; // Track if reasoning has started
			let reasoningContentBuffer = ''; // Accumulate complete reasoning content for saving
			for await (const chunk of parseSSEStream(
				response.body.getReader(),
				abortSignal,
			)) {
				// 原有外层 abort 检查可移除,已内置于 parseSSEStream
				// Capture usage information if available (usually in the last chunk)
				const usageValue = (chunk as any).usage;
				if (usageValue !== null && usageValue !== undefined) {
					usageData = {
						prompt_tokens: usageValue.prompt_tokens || 0,
						completion_tokens: usageValue.completion_tokens || 0,
						total_tokens: usageValue.total_tokens || 0,
						// OpenAI Chat API: cached_tokens in prompt_tokens_details
						cached_tokens: usageValue.prompt_tokens_details?.cached_tokens,
					};
				}

				// Skip content processing if no choices (but usage is already captured above)
				const choice = chunk.choices[0];
				if (!choice) {
					continue;
				}

				// Stream content chunks
				const content = choice.delta?.content;
				if (content) {
					contentBuffer += content;
					yield {
						type: 'content',
						content,
					};
				}

				// Stream reasoning content (for o1 models, etc.)
				// Note: reasoning_content is NOT included in the response, only counted for tokens
				const reasoningContent = (choice.delta as any)?.reasoning_content;
				if (reasoningContent) {
					// Accumulate reasoning content for saving to message
					reasoningContentBuffer += reasoningContent;

					// Emit reasoning_started event on first reasoning content
					if (!reasoningStarted) {
						reasoningStarted = true;
						yield {
							type: 'reasoning_started',
						};
					}
					yield {
						type: 'reasoning_delta',
						delta: reasoningContent,
					};
				}
				// Accumulate tool calls and stream deltas
				const deltaToolCalls = choice.delta?.tool_calls;
				if (deltaToolCalls) {
					hasToolCalls = true;
					for (const deltaCall of deltaToolCalls) {
						const index = deltaCall.index ?? 0;

						if (!toolCallsBuffer[index]) {
							toolCallsBuffer[index] = {
								id: '',
								type: 'function',
								function: {
									name: '',
									arguments: '',
								},
							};
						}

						if (deltaCall.id) {
							toolCallsBuffer[index].id = deltaCall.id;
						}

						// Yield tool call deltas for token counting
						let deltaText = '';
						if (deltaCall.function?.name) {
							toolCallsBuffer[index].function.name += deltaCall.function.name;
							deltaText += deltaCall.function.name;
						}
						if (deltaCall.function?.arguments) {
							toolCallsBuffer[index].function.arguments +=
								deltaCall.function.arguments;
							deltaText += deltaCall.function.arguments;
						}

						// Stream the delta to frontend for real-time token counting
						if (deltaText) {
							yield {
								type: 'tool_call_delta',
								delta: deltaText,
							};
						}
					}
				}

				if (choice.finish_reason) {
					break;
				}
			}

			// If there are tool calls, yield them
			if (hasToolCalls) {
				yield {
					type: 'tool_calls',
					tool_calls: Object.values(toolCallsBuffer),
				};
			}

			// Yield usage information if available
			if (usageData) {
				// Save usage to file system at API layer
				saveUsageToFile(options.model, usageData);

				yield {
					type: 'usage',
					usage: usageData,
				};
			}

			// Signal completion with reasoning content (for DeepSeek R1, etc.)
			yield {
				type: 'done',
				reasoning_content: reasoningContentBuffer || undefined,
			};
		},
		{
			abortSignal,
			onRetry,
		},
	);
}

export function validateChatOptions(options: ChatCompletionOptions): string[] {
	const errors: string[] = [];

	if (!options.model || options.model.trim().length === 0) {
		errors.push('Model is required');
	}

	if (!options.messages || options.messages.length === 0) {
		errors.push('At least one message is required');
	}

	for (const message of options.messages || []) {
		if (
			!message.role ||
			!['system', 'user', 'assistant', 'tool'].includes(message.role)
		) {
			errors.push('Invalid message role');
		}

		// Tool messages must have tool_call_id
		if (message.role === 'tool' && !message.tool_call_id) {
			errors.push('Tool messages must have tool_call_id');
		}

		// Content can be empty for tool calls
		if (
			message.role !== 'tool' &&
			(!message.content || message.content.trim().length === 0)
		) {
			errors.push('Message content cannot be empty (except for tool messages)');
		}
	}

	return errors;
}
