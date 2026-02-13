import {createHash, randomUUID} from 'crypto';
import {
	getOpenAiConfig,
	getCustomSystemPromptForConfig,
	getCustomHeadersForConfig,
	getCustomSystemPrompt,
	type ThinkingConfig,
} from '../utils/config/apiConfig.js';
import {mainAgentManager} from '../utils/MainAgentManager.js';

import {
	withRetryGenerator,
	parseJsonWithFix,
} from '../utils/core/retryUtils.js';
import {
	createIdleTimeoutGuard,
	StreamIdleTimeoutError,
} from '../utils/core/streamGuards.js';
import type {ChatMessage, ChatCompletionTool, UsageInfo} from './types.js';
import {logger} from '../utils/core/logger.js';
import {addProxyToFetchOptions} from '../utils/core/proxyUtils.js';
import {saveUsageToFile} from '../utils/core/usageLogger.js';
import {isDevMode, getDevUserId} from '../utils/core/devMode.js';
import {getVersionHeader} from '../utils/core/version.js';

export interface AnthropicOptions {
	model: string;
	messages: ChatMessage[];
	temperature?: number;
	max_tokens?: number;
	tools?: ChatCompletionTool[];
	sessionId?: string; // 用于用户跟踪和缓存的会话 ID
	includeBuiltinSystemPrompt?: boolean; // 控制是否添加内置系统提示词（默认 true）
	disableThinking?: boolean; // 禁用 Extended Thinking 功能（用于 agents 等场景，默认 false）
	teamMode?: boolean; // 启用 Team 模式（使用 Team 模式系统提示词）
	// 子代理配置覆盖
	configProfile?: string; // 子代理配置文件名（覆盖模型等设置）
	customSystemPromptId?: string; // 自定义系统提示词 ID
	customHeaders?: Record<string, string>; // 自定义请求头
	subAgentSystemPrompt?: string; // 子代理组装好的完整提示词（包含role等信息）
}

export interface AnthropicStreamChunk {
	type:
		| 'content'
		| 'tool_calls'
		| 'tool_call_delta'
		| 'done'
		| 'usage'
		| 'reasoning_started'
		| 'reasoning_delta';
	content?: string;
	tool_calls?: Array<{
		id: string;
		type: 'function';
		function: {
			name: string;
			arguments: string;
		};
	}>;
	delta?: string;
	usage?: UsageInfo;
	thinking?: {
		type: 'thinking';
		thinking: string;
		signature?: string;
	};
}

export interface AnthropicTool {
	name: string;
	description: string;
	input_schema: any;
	cache_control?: {type: 'ephemeral'; ttl?: '5m' | '1h'};
}

export interface AnthropicMessageParam {
	role: 'user' | 'assistant';
	content: string | Array<any>;
}

// 已弃用: 不再使用,保留以向后兼容
// @ts-ignore - 为向后兼容 resetAnthropicClient 导出而保留的变量
let anthropicConfig: {
	apiKey: string;
	baseUrl: string;
	customHeaders: Record<string, string>;
	anthropicBeta?: boolean;
	thinking?: ThinkingConfig;
} | null = null;

// 持久化 userId,在应用重启前保持不变
let persistentUserId: string | null = null;

/**
 * 将图片数据转换为 Anthropic API 所需的格式
 * 处理三种情况：
 * 1. 远程 URL (http/https): 返回 URL 类型（Anthropic 支持某些图片 URL）
 * 2. 已经是 data URL: 解析出 media_type 和 base64 数据
 * 3. 纯 base64 数据: 使用提供的 mimeType 补齐为完整格式
 */
function toAnthropicImageSource(image: {
	data: string;
	mimeType?: string;
}):
	| {type: 'base64'; media_type: string; data: string}
	| {type: 'url'; url: string}
	| null {
	const data = image.data?.trim() || '';
	if (!data) return null;

	// 远程 URL (http/https) - Anthropic 支持某些图片 URL
	if (/^https?:\/\//i.test(data)) {
		return {
			type: 'url',
			url: data,
		};
	}

	// 已经是 data URL 格式，解析它
	const dataUrlMatch = data.match(/^data:([^;]+);base64,(.+)$/);
	if (dataUrlMatch) {
		return {
			type: 'base64',
			media_type: dataUrlMatch[1] || image.mimeType || 'image/png',
			data: dataUrlMatch[2] || '',
		};
	}

	// 纯 base64 数据，补齐格式
	const mimeType = image.mimeType?.trim() || 'image/png';
	return {
		type: 'base64',
		media_type: mimeType,
		data: data,
	};
}

// 已弃用: 新的配置加载方式不再需要客户端重置
export function resetAnthropicClient(): void {
	anthropicConfig = null;
	persistentUserId = null; // 客户端重置时重置 userId
}

/**
 * 生成持久化 user_id,在应用重启前保持不变
 * 格式: user_<hash>_account__session_<uuid>
 * 这符合 Anthropic 预期的跟踪和缓存格式
 *
 * 在开发模式(--dev 标志)下,使用 ~/.snow/dev-user-id 中的持久化 userId
 * 而不是每次会话生成新的
 */
function getPersistentUserId(): string {
	// 检查是否启用开发模式
	if (isDevMode()) {
		return getDevUserId();
	}

	// 普通模式: 每次会话生成 userId
	if (!persistentUserId) {
		const sessionId = randomUUID();
		const hash = createHash('sha256')
			.update(`anthropic_user_${sessionId}`)
			.digest('hex');
		persistentUserId = `user_${hash}_account__session_${sessionId}`;
	}
	return persistentUserId;
}

/**
 * Convert OpenAI-style tools to Anthropic tool format
 * Adds cache_control to the last tool for prompt caching
 */
function convertToolsToAnthropic(
	tools?: ChatCompletionTool[],
): AnthropicTool[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}

	const convertedTools = tools
		.filter(tool => tool.type === 'function' && 'function' in tool)
		.map(tool => {
			if (tool.type === 'function' && 'function' in tool) {
				return {
					name: tool.function.name,
					description: tool.function.description || '',
					input_schema: tool.function.parameters as any,
				};
			}
			throw new Error('Invalid tool format');
		});

	// 不为工具添加 cache_control,以避免 TTL 排序问题
	// if (convertedTools.length > 0) {
	// 	const lastTool = convertedTools[convertedTools.length - 1];
	// 	(lastTool as any).cache_control = {type: 'ephemeral', ttl: '5m'};
	// }
	return convertedTools;
}

/**
 * 将我们的ChatMessage格式转换为Anthropic格式
 * 为系统提示词和最后一条user消息添加cache_control以支持提示词缓存
 * @param messages - 要转换的消息数组
 * @param includeBuiltinSystemPrompt - 是否包含内置系统提示词(默认true)
 * @param customSystemPromptOverride - 允许子代理覆盖
 * @param cacheTTL - 提示词缓存的TTL(默认: '5m')
 */
function convertToAnthropicMessages(
	messages: ChatMessage[],
	includeBuiltinSystemPrompt: boolean = true,
	customSystemPromptOverride?: string, // 允许子代理覆盖
	isSubAgentCall: boolean = false, // 是否为子代理调用
	subAgentSystemPrompt?: string, // 子代理组装的提示词
	cacheTTL: '5m' | '1h' = '5m', // 缓存 TTL 配置
	disableThinking: boolean = false, // 为 true 时,从消息中移除 thinking 块
): {
	system?: any;
	messages: AnthropicMessageParam[];
} {
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

	let systemContent: string | undefined;
	const anthropicMessages: AnthropicMessageParam[] = [];

	for (const msg of messages) {
		if (msg.role === 'system') {
			systemContent = msg.content;
			continue;
		}

		if (msg.role === 'tool' && msg.tool_call_id) {
			// 构建工具结果内容 - 可以是文本或包含图片的数组
			let toolResultContent: string | any[];

			if (msg.images && msg.images.length > 0) {
				// 包含图片的多模态工具结果
				const contentArray: any[] = [];

				// 先添加文本内容
				if (msg.content) {
					contentArray.push({
						type: 'text',
						text: msg.content,
					});
				}

				// 添加图片 - 使用辅助函数处理各种格式的图片数据
				for (const image of msg.images) {
					const imageSource = toAnthropicImageSource(image);
					if (imageSource) {
						if (imageSource.type === 'url') {
							contentArray.push({
								type: 'image',
								source: {
									type: 'url',
									url: imageSource.url,
								},
							});
						} else {
							contentArray.push({
								type: 'image',
								source: imageSource,
							});
						}
					}
				}

				toolResultContent = contentArray;
			} else {
				// 纯文本工具结果
				toolResultContent = msg.content || '';
			}

			anthropicMessages.push({
				role: 'user',
				content: [
					{
						type: 'tool_result',
						tool_use_id: msg.tool_call_id,
						content: toolResultContent,
					},
				],
			});
			continue;
		}

		if (msg.role === 'user' && msg.images && msg.images.length > 0) {
			const content: any[] = [];

			if (msg.content) {
				content.push({
					type: 'text',
					text: msg.content,
				});
			}

			// 使用辅助函数处理各种格式的图片数据，补齐纯 base64 数据
			for (const image of msg.images) {
				const imageSource = toAnthropicImageSource(image);
				if (imageSource) {
					if (imageSource.type === 'url') {
						content.push({
							type: 'image',
							source: {
								type: 'url',
								url: imageSource.url,
							},
						});
					} else {
						content.push({
							type: 'image',
							source: imageSource,
						});
					}
				}
			}

			anthropicMessages.push({
				role: 'user',
				content,
			});
			continue;
		}

		if (
			msg.role === 'assistant' &&
			msg.tool_calls &&
			msg.tool_calls.length > 0
		) {
			const content: any[] = [];

			// 启用 thinking 时,thinking 块必须放在最前面
			// 当 disableThinking 为 true 时跳过 thinking 块
			if (msg.thinking && !disableThinking) {
				// 使用完整的 thinking 块对象(包含签名)
				content.push(msg.thinking);
			}

			if (msg.content) {
				content.push({
					type: 'text',
					text: msg.content,
				});
			}

			for (const toolCall of msg.tool_calls) {
				content.push({
					type: 'tool_use',
					id: toolCall.id,
					name: toolCall.function.name,
					input: JSON.parse(toolCall.function.arguments),
				});
			}

			anthropicMessages.push({
				role: 'assistant',
				content,
			});
			continue;
		}

		if (msg.role === 'user' || msg.role === 'assistant') {
			// 对于包含 thinking 的助手消息,转换为结构化格式
			// 当 disableThinking 为 true 时跳过 thinking 块
			if (msg.role === 'assistant' && msg.thinking && !disableThinking) {
				const content: any[] = [];

				// Thinking 块必须放在最前面 - 使用完整的块对象(包含签名)
				content.push(msg.thinking);

				// 然后是文本内容
				if (msg.content) {
					content.push({
						type: 'text',
						text: msg.content,
					});
				}

				anthropicMessages.push({
					role: 'assistant',
					content,
				});
			} else {
				anthropicMessages.push({
					role: msg.role,
					content: msg.content,
				});
			}
		}
	}

	// 统一的系统提示词逻辑
	// 1. 子代理调用且有自定义系统提示词：使用自定义系统提示词
	if (isSubAgentCall && customSystemPrompt) {
		systemContent = customSystemPrompt;
		// subAgentSystemPrompt 会作为 user 消息保留在 messages 中（已在第一条或特殊user位置）
	}
	// 2. 子代理调用且没有自定义系统提示词：使用子代理组装的提示词
	else if (isSubAgentCall && subAgentSystemPrompt) {
		systemContent = subAgentSystemPrompt;
		// finalPrompt 会同时在 system 和 user 中存在（已在 messages 第一条）
	}
	// 3. 主代理调用且有自定义系统提示词：使用自定义系统提示词，不添加主代理角色定义
	else if (customSystemPrompt && !isSubAgentCall) {
		systemContent = customSystemPrompt;
		// 不再添加 mainAgentManager.getSystemPrompt()，让自定义系统提示词完全替代
		// 主代理角色定义会在 sessionInitializer.ts 中作为特殊 user 消息动态插入
	}
	// 4. 主代理调用且没有自定义系统提示词：使用主代理角色定义
	else if (effectiveIncludeBuiltinSystemPrompt) {
		systemContent = mainAgentManager.getSystemPrompt();
	}

	let lastUserMessageIndex = -1;
	for (let i = anthropicMessages.length - 1; i >= 0; i--) {
		if (anthropicMessages[i]?.role === 'user') {
			lastUserMessageIndex = i;
			break;
		}
	}

	if (lastUserMessageIndex >= 0) {
		const lastMessage = anthropicMessages[lastUserMessageIndex];
		if (lastMessage && lastMessage.role === 'user') {
			if (typeof lastMessage.content === 'string') {
				lastMessage.content = [
					{
						type: 'text',
						text: lastMessage.content,
						cache_control: {type: 'ephemeral', ttl: cacheTTL},
					} as any,
				];
			} else if (Array.isArray(lastMessage.content)) {
				const lastContentIndex = lastMessage.content.length - 1;
				if (lastContentIndex >= 0) {
					const lastContent = lastMessage.content[lastContentIndex] as any;
					lastContent.cache_control = {type: 'ephemeral', ttl: cacheTTL};
				}
			}
		}
	}

	const system = systemContent
		? [
				{
					type: 'text',
					text: systemContent,
					cache_control: {type: 'ephemeral', ttl: cacheTTL},
				},
		  ]
		: undefined;

	return {system, messages: anthropicMessages};
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
				// 检查buffer是否有残留数据
				if (buffer.trim()) {
					// 连接异常中断，抛出明确错误，并包含断点信息
					const errorContext = {
						dataCount,
						lastEventType,
						bufferLength: buffer.length,
						bufferPreview: buffer.substring(0, 200),
					};

					const errorMessage = `[API_ERROR] [RETRIABLE] Anthropic stream terminated unexpectedly with incomplete data`;
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

				// 处理 "event: " 和 "event:" 两种格式
				if (trimmed.startsWith('event:')) {
					// 记录事件类型用于断点恢复
					lastEventType = trimmed.startsWith('event: ')
						? trimmed.slice(7)
						: trimmed.slice(6);
					continue;
				}

				// 处理 "data: " 和 "data:" 两种格式
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
						// yield前检查是否已被丢弃
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
			'[API_ERROR] [RETRIABLE] Anthropic SSE stream parsing error with checkpoint context:',
			errorContext,
		);
		throw error;
	} finally {
		guard.dispose();
	}
}

/**
 * Create streaming Anthropic completion with retry support
 */
export async function* createStreamingAnthropicCompletion(
	options: AnthropicOptions,
	abortSignal?: AbortSignal,
	onRetry?: (error: Error, attempt: number, nextDelay: number) => void,
): AsyncGenerator<AnthropicStreamChunk, void, unknown> {
	yield* withRetryGenerator(
		async function* () {
			// 加载配置: 如果指定了 configProfile,则加载它; 否则使用主配置
			let config: ReturnType<typeof getOpenAiConfig>;
			if (options.configProfile) {
				try {
					const {loadProfile} = await import(
						'../utils/config/configManager.js'
					);
					const profileConfig = loadProfile(options.configProfile);
					if (profileConfig?.snowcfg) {
						config = profileConfig.snowcfg;
					} else {
						// 配置文件未找到,回退到主配置
						config = getOpenAiConfig();
						logger.warn(
							`Profile ${options.configProfile} not found, using main config`,
						);
					}
				} catch (error) {
					// 如果加载配置文件失败,回退到主配置
					config = getOpenAiConfig();
					logger.warn(
						`Failed to load profile ${options.configProfile}, using main config:`,
						error,
					);
				}
			} else {
				// 未指定 configProfile, 使用主配置
				config = getOpenAiConfig();
			}

			// 获取系统提示词(支持自定义覆盖)
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

			const {system, messages} = convertToAnthropicMessages(
				options.messages,
				options.includeBuiltinSystemPrompt !== false, // 默认为 true
				customSystemPromptContent, // 传递自定义系统提示词
				!!options.customSystemPromptId || !!options.subAgentSystemPrompt, // 子代理调用的判断：只要有customSystemPromptId或subAgentSystemPrompt就认为是子代理调用
				options.subAgentSystemPrompt,
				config.anthropicCacheTTL || '5m', // 使用配置的 TTL，默认 5m
				options.disableThinking || false, // 当 thinking 被禁用时移除 thinking 块
				// 如果启用,使用 Team 模式系统提示词(已弃用)
			);

			// 使用持久化 userId,在应用重启前保持不变
			const userId = getPersistentUserId();

			const requestBody: any = {
				model: options.model || config.advancedModel,
				max_tokens: options.max_tokens || 4096,
				system,
				messages,
				tools: convertToolsToAnthropic(options.tools),
				metadata: {
					user_id: userId,
				},
				stream: true,
			};

			// 如果启用且未明确禁用,则添加 thinking 配置
			// 启用 thinking 时,temperature 必须为 1
			// 注意: agents 和其他内部工具应设置 disableThinking=true
			// Debug: 记录 thinking 决策以供故障排除
			if (config.thinking) {
				logger.debug('Thinking config check:', {
					configThinking: !!config.thinking,
					disableThinking: options.disableThinking,
					willEnableThinking: config.thinking && !options.disableThinking,
				});
			}
			if (config.thinking && !options.disableThinking) {
				requestBody.thinking = config.thinking;
				requestBody.temperature = 1;
			}

			// 如果提供了自定义 headers 则使用,否则从当前配置获取(支持配置文件覆盖)
			const customHeaders =
				options.customHeaders || getCustomHeadersForConfig(config);

			// 准备 headers
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				'x-api-key': config.apiKey,
				Authorization: `Bearer ${config.apiKey}`,
				'anthropic-version': '2023-06-01',
				'x-snow': getVersionHeader(),
				...customHeaders,
			};

			// 如果配置了 beta 参数则添加
			// if (config.anthropicBeta) {
			// 	headers['anthropic-beta'] = 'prompt-caching-2024-07-31';
			// }

			// 使用配置的 baseUrl 或默认 Anthropic URL
			//移除末尾斜杠，避免拼接时出现双斜杠（如 /v1//messages）
			const baseUrl = (
				config.baseUrl && config.baseUrl !== 'https://api.openai.com/v1'
					? config.baseUrl
					: 'https://api.anthropic.com/v1'
			).replace(/\/+$/, '');

			const url = config.anthropicBeta
				? `${baseUrl}/messages?beta=true`
				: `${baseUrl}/messages`;

			const fetchOptions = addProxyToFetchOptions(url, {
				method: 'POST',
				headers,
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
					`Anthropic API fetch failed: ${errorMessage}\n` +
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
				const errorMsg = `[API_ERROR] Anthropic API HTTP ${response.status}: ${response.statusText} - ${errorText}`;
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
					'[API_ERROR] No response body from Anthropic API (empty response)';
				logger.error(errorMsg, {
					url,
					model: requestBody.model,
				});
				throw new Error(errorMsg);
			}

			let contentBuffer = '';
			let thinkingTextBuffer = ''; // 累积 thinking 文本内容
			let thinkingSignature = ''; // 累积 thinking 签名
			let toolCallsBuffer: Map<
				string,
				{
					id: string;
					type: 'function';
					function: {
						name: string;
						arguments: string;
					};
				}
			> = new Map();
			let hasToolCalls = false;
			let usageData: UsageInfo | undefined;
			let blockIndexToId: Map<number, string> = new Map();
			let blockIndexToType: Map<number, string> = new Map(); // 跟踪块类型(text, thinking, tool_use)
			let completedToolBlocks = new Set<string>(); // 跟踪哪些工具块已完成流式传输

			for await (const event of parseSSEStream(
				response.body.getReader(),
				abortSignal,
			)) {
				// 原有外层 abort 检查可移除,已内置于 parseSSEStream
				if (event.type === 'content_block_start') {
					const block = event.content_block;
					const blockIndex = event.index;

					// 跟踪块类型以供后续参考
					blockIndexToType.set(blockIndex, block.type);

					if (block.type === 'tool_use') {
						hasToolCalls = true;
						blockIndexToId.set(blockIndex, block.id);

						toolCallsBuffer.set(block.id, {
							id: block.id,
							type: 'function',
							function: {
								name: block.name,
								arguments: '',
							},
						});

						yield {
							type: 'tool_call_delta',
							delta: block.name,
						};
					}
					// 处理 thinking 块开始(扩展思考功能)
					else if (block.type === 'thinking') {
						// Thinking 块已开始 - 发送 reasoning_started 事件
						yield {
							type: 'reasoning_started',
						};
					}
				} else if (event.type === 'content_block_delta') {
					const delta = event.delta;

					if (delta.type === 'text_delta') {
						const text = delta.text;
						contentBuffer += text;
						yield {
							type: 'content',
							content: text,
						};
					}

					// 处理 thinking_delta(扩展思考功能)
					// 为 thinking 内容发送 reasoning_delta 事件
					if (delta.type === 'thinking_delta') {
						const thinkingText = delta.thinking;
						thinkingTextBuffer += thinkingText; // 累积 thinking 文本
						yield {
							type: 'reasoning_delta',
							delta: thinkingText,
						};
					}

					// 处理 signature_delta(扩展思考功能)
					// 签名是 thinking 块所必需的
					if (delta.type === 'signature_delta') {
						thinkingSignature += delta.signature; // 累积签名
					}

					if (delta.type === 'input_json_delta') {
						const jsonDelta = delta.partial_json;
						const blockIndex = event.index;
						const toolId = blockIndexToId.get(blockIndex);

						if (toolId) {
							const toolCall = toolCallsBuffer.get(toolId);
							if (toolCall) {
								// 过滤掉可能混入 JSON delta 中的任何类 XML 标签
								// 当模型输出包含被解释为 JSON 的 XML 时,可能会发生这种情况
								const cleanedDelta = jsonDelta.replace(
									/<\\?\/?parameter[^>]*>/g,
									'',
								);

								if (cleanedDelta) {
									toolCall.function.arguments += cleanedDelta;

									yield {
										type: 'tool_call_delta',
										delta: cleanedDelta,
									};
								}
							}
						}
					}
				} else if (event.type === 'content_block_stop') {
					// 标记此块已完成
					const blockIndex = event.index;
					const toolId = blockIndexToId.get(blockIndex);
					if (toolId) {
						completedToolBlocks.add(toolId);
					}
				} else if (event.type === 'message_start') {
					if (event.message.usage) {
						usageData = {
							prompt_tokens: event.message.usage.input_tokens || 0,
							completion_tokens: event.message.usage.output_tokens || 0,
							total_tokens:
								(event.message.usage.input_tokens || 0) +
								(event.message.usage.output_tokens || 0),
							cache_creation_input_tokens: (event.message.usage as any)
								.cache_creation_input_tokens,
							cache_read_input_tokens: (event.message.usage as any)
								.cache_read_input_tokens,
						};
					}
				} else if (event.type === 'message_delta') {
					if (event.usage) {
						if (!usageData) {
							usageData = {
								prompt_tokens: 0,
								completion_tokens: 0,
								total_tokens: 0,
							};
						}
						// 如果 message_delta 中存在 prompt_tokens,则更新
						if (event.usage.input_tokens !== undefined) {
							usageData.prompt_tokens = event.usage.input_tokens;
						}
						usageData.completion_tokens = event.usage.output_tokens || 0;
						usageData.total_tokens =
							usageData.prompt_tokens + usageData.completion_tokens;
						if (
							(event.usage as any).cache_creation_input_tokens !== undefined
						) {
							usageData.cache_creation_input_tokens = (
								event.usage as any
							).cache_creation_input_tokens;
						}
						if ((event.usage as any).cache_read_input_tokens !== undefined) {
							usageData.cache_read_input_tokens = (
								event.usage as any
							).cache_read_input_tokens;
						}
					}
				}
			}

			if (hasToolCalls && toolCallsBuffer.size > 0) {
				const toolCalls = Array.from(toolCallsBuffer.values());
				for (const toolCall of toolCalls) {
					// 规范化参数
					let args = toolCall.function.arguments.trim();

					// 如果参数为空,使用空对象
					if (!args) {
						args = '{}';
					}

					// 尝试使用统一的 parseJsonWithFix 工具解析 JSON
					if (completedToolBlocks.has(toolCall.id)) {
						// 工具块已完成,使用修复和日志记录进行解析
						const parseResult = parseJsonWithFix(args, {
							toolName: toolCall.function.name,
							fallbackValue: {},
							logWarning: true,
							logError: true,
						});

						// 使用解析的数据或回退值
						toolCall.function.arguments = JSON.stringify(parseResult.data);
					} else {
						// 工具块未完成,可能是中断的流
						// 尝试解析而不记录错误(预期会有不完整的数据)
						const parseResult = parseJsonWithFix(args, {
							toolName: toolCall.function.name,
							fallbackValue: {},
							logWarning: false,
							logError: false,
						});

						if (!parseResult.success) {
							logger.warn(
								`Warning: Tool call ${toolCall.function.name} (${toolCall.id}) was incomplete. Using fallback data.`,
							);
						}

						toolCall.function.arguments = JSON.stringify(parseResult.data);
					}
				}

				yield {
					type: 'tool_calls',
					tool_calls: toolCalls,
				};
			}

			if (usageData) {
				// 在 API 层将使用情况保存到文件系统
				saveUsageToFile(options.model, usageData);

				yield {
					type: 'usage',
					usage: usageData,
				};
			}
			// 如果存在 thinking 内容,则返回带签名的完整 thinking 块
			const thinkingBlock = thinkingTextBuffer
				? {
						type: 'thinking' as const,
						thinking: thinkingTextBuffer,
						signature: thinkingSignature || undefined,
				  }
				: undefined;

			yield {
				type: 'done',
				thinking: thinkingBlock,
			};
		},
		{
			abortSignal,
			onRetry,
		},
	);
}
