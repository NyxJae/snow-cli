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
import {
	createIdleTimeoutGuard,
	StreamIdleTimeoutError,
} from '../utils/core/streamGuards.js';
import type {ChatMessage, ChatCompletionTool, UsageInfo} from './types.js';
import {logger} from '../utils/core/logger.js';
import {addProxyToFetchOptions} from '../utils/core/proxyUtils.js';
import {saveUsageToFile} from '../utils/core/usageLogger.js';
import {getVersionHeader} from '../utils/core/version.js';

export interface GeminiOptions {
	model: string;
	messages: ChatMessage[];
	temperature?: number;
	tools?: ChatCompletionTool[];
	includeBuiltinSystemPrompt?: boolean; // 控制是否添加内置系统提示词（默认 true）
	teamMode?: boolean; // 启用 Team 模式（使用 Team 模式系统提示词）
	// 子代理配置覆盖
	configProfile?: string; // 子代理配置文件名（覆盖模型等设置）
	customSystemPromptId?: string; // 自定义系统提示词 ID
	customHeaders?: Record<string, string>; // 自定义请求头
	subAgentSystemPrompt?: string; // 子代理组装好的完整提示词（包含role等信息）
}

/**
 * Gemini API流式响应块
 */
export interface GeminiStreamChunk {
	type:
		| 'content'
		| 'tool_calls'
		| 'tool_call_delta'
		| 'done'
		| 'usage'
		| 'reasoning_started'
		| 'reasoning_delta'; // 响应类型：文本、工具调用、完成、使用量、推理开始、推理增量
	content?: string; // 文本内容
	tool_calls?: Array<{
		id: string;
		type: 'function';
		function: {
			name: string;
			arguments: string;
		};
	}>; // 工具调用列表
	delta?: string;
	usage?: UsageInfo;
	thinking?: {
		type: 'thinking';
		thinking: string;
	};
}

// 已弃用：不再使用，保留作为参考
// @ts-ignore - Variable kept for backward compatibility with resetGeminiClient export
let geminiConfig: {
	apiKey: string;
	baseUrl: string;
	customHeaders: Record<string, string>;
	geminiThinking?: {
		enabled: boolean;
		budget: number;
	};
} | null = null;
// 已弃用:新的配置加载方式不再需要客户端重置
export function resetGeminiClient(): void {
	geminiConfig = null;
}

/**
 * 将图片数据转换为 Gemini API 所需的格式
 * 处理三种情况：
 * 1. 远程 URL (http/https): 返回 fileData 格式
 * 2. 已经是 data URL: 返回 inlineData 格式，并确保 data 带 data: 头
 * 3. 纯 base64 数据: 使用提供的 mimeType 补齐 data URL 格式
 */
function toGeminiImagePart(image: {
	data: string;
	mimeType?: string;
}):
	| {inlineData: {mimeType: string; data: string}}
	| {fileData: {mimeType: string; fileUri: string}}
	| null {
	const data = image.data?.trim() || '';
	if (!data) return null;

	// 远程 URL (http/https) - Gemini 支持通过 fileData 提供
	if (/^https?:\/\//i.test(data)) {
		return {
			fileData: {
				mimeType: image.mimeType?.trim() || 'image/png',
				fileUri: data,
			},
		};
	}

	// 已经是 data URL 格式，直接使用原值作为 data
	const dataUrlMatch = data.match(/^data:([^;]+);base64,(.+)$/);
	if (dataUrlMatch) {
		return {
			inlineData: {
				mimeType: dataUrlMatch[1] || image.mimeType || 'image/png',
				data: image.data, // 保留完整的 data URL
			},
		};
	}

	// 纯 base64 数据，补齐 data URL 格式
	const mimeType = image.mimeType?.trim() || 'image/png';
	return {
		inlineData: {
			mimeType,
			data: `data:${mimeType};base64,${data}`, // 补齐 data: 头
		},
	};
}

/**
 * Convert OpenAI-style tools to Gemini function declarations
 */
function convertToolsToGemini(tools?: ChatCompletionTool[]): any[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}

	const functionDeclarations = tools
		.filter(tool => tool.type === 'function' && 'function' in tool)
		.map(tool => {
			if (tool.type === 'function' && 'function' in tool) {
				// 将 OpenAI 参数 schema 转换为 Gemini 格式
				const params = tool.function.parameters as any;

				return {
					name: tool.function.name,
					description: tool.function.description || '',
					parametersJsonSchema: {
						type: 'object',
						properties: params.properties || {},
						required: params.required || [],
					},
				};
			}
			throw new Error('Invalid tool format');
		});

	return [{functionDeclarations}];
}

/**
 * 将我们的ChatMessage格式转换为Gemini格式
 *
 * @param messages - 要转换的消息数组
 * @param includeBuiltinSystemPrompt - 是否包含内置系统提示词（默认true）
 * @param customSystemPromptOverride - 自定义系统提示词（用于子代理）
 * @param isSubAgentCall - 是否为子代理调用
 * @param subAgentSystemPrompt - 子代理组装好的完整提示词
 * @returns 转换后的对象，包含systemInstruction和contents
 */
function convertToGeminiMessages(
	messages: ChatMessage[],
	includeBuiltinSystemPrompt: boolean = true,
	customSystemPromptOverride?: string, // 允许子代理覆盖
	isSubAgentCall: boolean = false, // 是否为子代理调用
	subAgentSystemPrompt?: string, // 子代理组装的提示词
	// 当为 true 时,使用 Team 模式系统提示词(已弃用)
): {
	systemInstruction?: string;
	contents: any[];
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

	let systemInstruction: string | undefined;
	const contents: any[] = [];

	// 构建 tool_call_id 到 function_name 的映射,用于并行调用
	const toolCallIdToFunctionName = new Map<string, string>();

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg) continue;

		// 提取 system 消息作为 systemInstruction
		if (msg.role === 'system') {
			systemInstruction = msg.content;
			continue;
		}

		// 处理 assistant 消息中的工具调用 - 先构建映射
		if (
			msg.role === 'assistant' &&
			msg.tool_calls &&
			msg.tool_calls.length > 0
		) {
			const parts: any[] = [];

			// 如果存在 thinking 内容,先添加(Gemini thinking 模式要求)
			if (msg.thinking) {
				parts.push({
					thought: true,
					text: msg.thinking.thinking,
				});
			}

			// 添加文本内容
			if (msg.content) {
				parts.push({
					text: msg.content,
				});
			}

			for (const toolCall of msg.tool_calls) {
				// 存储 tool_call_id -> function_name 映射
				toolCallIdToFunctionName.set(toolCall.id, toolCall.function.name);

				const argsParseResult = parseJsonWithFix(toolCall.function.arguments, {
					toolName: `Gemini function call: ${toolCall.function.name}`,
					fallbackValue: {},
					logWarning: true,
					logError: true,
				});

				const functionCallPart: any = {
					functionCall: {
						name: toolCall.function.name,
						args: argsParseResult.data,
					},
				};

				// 在 part 级别包含 thoughtSignature(与 functionCall 同级,不在其内部)
				// 根据 Gemini 文档,thinking 模式下的函数调用需要 thoughtSignature
				const signature =
					(toolCall as any).thoughtSignature ||
					(toolCall as any).thought_signature;
				if (signature) {
					functionCallPart.thoughtSignature = signature;
				}

				parts.push(functionCallPart);
			}

			contents.push({
				role: 'model',
				parts,
			});
			continue;
		}

		// 处理工具结果 - 收集连续的工具消息
		if (msg.role === 'tool') {
			// 从当前位置开始收集所有连续的工具消息
			const toolResponses: Array<{
				tool_call_id: string;
				content: string;
				images?: any[];
				timestamp?: number;
			}> = [];

			let j = i;
			while (j < messages.length && messages[j]?.role === 'tool') {
				const toolMsg = messages[j];
				if (toolMsg) {
					toolResponses.push({
						tool_call_id: toolMsg.tool_call_id || '',
						content: toolMsg.content || '',
						images: toolMsg.images,
						timestamp: toolMsg.timestamp,
					});
				}
				j++;
			}

			// 更新循环索引以跳过已处理的工具消息
			i = j - 1;

			// 构建包含多个 functionResponse 部分的单个 user 消息
			const parts: any[] = [];

			for (const toolResp of toolResponses) {
				// 使用 tool_call_id 查找正确的函数名
				const functionName =
					toolCallIdToFunctionName.get(toolResp.tool_call_id) ||
					'unknown_function';

				// 工具响应必须是 Gemini API 的有效对象
				let responseData: any;

				if (!toolResp.content) {
					responseData = {};
				} else {
					let contentToParse = toolResp.content;

					// 有时内容会被双重编码为 JSON
					// 首先,尝试解析一次
					const firstParseResult = parseJsonWithFix(contentToParse, {
						toolName: 'Gemini tool response (first parse)',
						logWarning: false,
						logError: false,
					});

					if (
						firstParseResult.success &&
						typeof firstParseResult.data === 'string'
					) {
						// 如果是字符串,可能是双重编码,再次尝试解析
						contentToParse = firstParseResult.data;
					}

					// 现在解析或包装最终内容
					const finalParseResult = parseJsonWithFix(contentToParse, {
						toolName: 'Gemini tool response (final parse)',
						logWarning: false,
						logError: false,
					});

					if (finalParseResult.success) {
						const parsed = finalParseResult.data;
						// 如果解析结果是对象(非数组、非 null),直接使用
						if (
							typeof parsed === 'object' &&
							parsed !== null &&
							!Array.isArray(parsed)
						) {
							responseData = parsed;
						} else {
							// 如果是基本类型、数组或 null,包装它
							responseData = {content: parsed};
						}
					} else {
						// 不是有效的 JSON,包装原始字符串
						responseData = {content: contentToParse};
					}
				}

				// 添加 functionResponse 部分
				parts.push({
					functionResponse: {
						name: functionName,
						response: responseData,
					},
				});

				// 处理工具结果中的图片
				if (toolResp.images && toolResp.images.length > 0) {
					for (const image of toolResp.images) {
						const imagePart = toGeminiImagePart(image);
						if (imagePart) {
							parts.push(imagePart);
						}
					}
				}
			}

			// 推送包含所有函数响应的单个 user 消息
			contents.push({
				role: 'user',
				parts,
			});
			continue;
		}

		// 为常规 user/assistant 消息构建消息部分
		const parts: any[] = [];

		// 如果存在文本内容则添加
		if (msg.content) {
			parts.push({
				text: msg.content,
			});
		}

		// 为 user 消息添加图片
		if (msg.role === 'user' && msg.images && msg.images.length > 0) {
			for (const image of msg.images) {
				const imagePart = toGeminiImagePart(image);
				if (imagePart) {
					parts.push(imagePart);
				}
			}
		}

		// 添加到 contents
		const role = msg.role === 'assistant' ? 'model' : 'user';
		contents.push({role, parts});
	}

	// 统一的系统提示词逻辑
	// 1. 子代理调用且有自定义系统提示词：使用自定义系统提示词
	if (isSubAgentCall && customSystemPrompt) {
		systemInstruction = customSystemPrompt;
		// subAgentSystemPrompt 会作为 user 消息保留在 messages 中（已在第一条或特殊user位置）
	}
	// 2. 子代理调用且没有自定义系统提示词：使用子代理组装的提示词
	else if (isSubAgentCall && subAgentSystemPrompt) {
		systemInstruction = subAgentSystemPrompt;
		// finalPrompt 会同时在 system 和 user 中存在（已在 contents 第一条）
	}
	// 3. 主代理调用且有自定义系统提示词：使用自定义系统提示词，不添加主代理角色定义
	else if (customSystemPrompt && !isSubAgentCall) {
		systemInstruction = customSystemPrompt;
		// 不再添加 mainAgentManager.getSystemPrompt()，让自定义系统提示词完全替代
		// 主代理角色定义会在 sessionInitializer.ts 中作为特殊 user 消息动态插入
	}
	// 4. 主代理调用且没有自定义系统提示词：使用主代理角色定义
	else if (effectiveIncludeBuiltinSystemPrompt) {
		systemInstruction = mainAgentManager.getSystemPrompt();
	}

	return {systemInstruction, contents};
}

/**
 * 使用Gemini API创建流式聊天补全
 *
 * @param options - Gemini API调用选项
 * @param abortSignal - 中断信号，用于取消请求
 * @param onRetry - 重试回调函数，在重试时调用
 * @returns 流式响应生成器
 */
export async function* createStreamingGeminiCompletion(
	options: GeminiOptions,
	abortSignal?: AbortSignal,
	onRetry?: (error: Error, attempt: number, nextDelay: number) => void,
): AsyncGenerator<GeminiStreamChunk, void, unknown> {
	// 加载配置:如果指定了 configProfile,则加载它;否则使用主配置
	let config: ReturnType<typeof getOpenAiConfig>;
	if (options.configProfile) {
		try {
			const {loadProfile} = await import('../utils/config/configManager.js');
			const profileConfig = loadProfile(options.configProfile);
			if (profileConfig?.snowcfg) {
				config = profileConfig.snowcfg;
			} else {
				// 未找到配置文件,回退到主配置
				config = getOpenAiConfig();
				const {logger} = await import('../utils/core/logger.js');
				logger.warn(
					`Profile ${options.configProfile} not found, using main config`,
				);
			}
		} catch (error) {
			// 如果加载配置文件失败,回退到主配置
			config = getOpenAiConfig();
			const {logger} = await import('../utils/core/logger.js');
			logger.warn(
				`Failed to load profile ${options.configProfile}, using main config:`,
				error,
			);
		}
	} else {
		// 未指定 configProfile,使用主配置
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

	// 使用重试包装生成器
	yield* withRetryGenerator(
		async function* () {
			const {systemInstruction, contents} = convertToGeminiMessages(
				options.messages,
				options.includeBuiltinSystemPrompt !== false, // 默认为 true
				customSystemPromptContent, // 传递自定义系统提示词
				!!options.customSystemPromptId || !!options.subAgentSystemPrompt, // 子代理调用的判断：只要有customSystemPromptId或subAgentSystemPrompt就认为是子代理调用
				options.subAgentSystemPrompt,
				// 传递 teamMode 以使用正确的系统提示词(已弃用)
			);

			// 构建请求负载
			const requestBody: any = {
				contents,
				systemInstruction: systemInstruction
					? {parts: [{text: systemInstruction}]}
					: undefined,
			};

			// 如果启用了 thinking 配置则添加
			// 仅在 thinking 启用时包含 generationConfig
			if (config.geminiThinking?.enabled) {
				requestBody.generationConfig = {
					thinkingConfig: {
						thinkingBudget: config.geminiThinking.budget,
					},
				};
			}

			// 如果提供了工具则添加
			const geminiTools = convertToolsToGemini(options.tools);
			if (geminiTools) {
				requestBody.tools = geminiTools;
			}

			// 从 options.model 中提取模型名称(例如 "gemini-pro" 或 "models/gemini-pro")
			const effectiveModel = options.model || config.advancedModel || '';
			const modelName = effectiveModel.startsWith('models/')
				? effectiveModel
				: `models/${effectiveModel}`;

			// 使用配置的 baseUrl 或默认 Gemini URL
			const baseUrl =
				config.baseUrl && config.baseUrl !== 'https://api.openai.com/v1'
					? config.baseUrl
					: 'https://generativelanguage.googleapis.com/v1beta';

			const urlObj = new URL(`${baseUrl}/${modelName}:streamGenerateContent`);
			urlObj.searchParams.set('alt', 'sse');
			const url = urlObj.toString();

			// 如果提供了自定义请求头则使用,否则从当前配置获取(支持配置文件覆盖)
			const customHeaders =
				options.customHeaders || getCustomHeadersForConfig(config);

			const fetchOptions = addProxyToFetchOptions(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${config.apiKey}`,
					'x-goog-api-key': config.apiKey,
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
					`Gemini API fetch failed: ${errorMessage}\n` +
						`URL: ${url}\n` +
						`Model: ${effectiveModel}\n` +
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
				const errorMsg = `[API_ERROR] Gemini API HTTP ${response.status}: ${response.statusText} - ${errorText}`;
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
					'[API_ERROR] No response body from Gemini API (empty response)';
				logger.error(errorMsg, {
					url,
					model: requestBody.model,
				});
				throw new Error(errorMsg);
			}

			let contentBuffer = '';
			let thinkingTextBuffer = ''; // 累积 thinking 文本内容
			let sharedThoughtSignature: string | undefined; // 存储第一个 thoughtSignature 以供重用
			let toolCallsBuffer: Array<{
				id: string;
				type: 'function';
				function: {
					name: string;
					arguments: string;
				};
				thoughtSignature?: string; // 用于 Gemini thinking 模式
			}> = [];
			let hasToolCalls = false;
			let toolCallIndex = 0;
			let totalTokens = {prompt: 0, completion: 0, total: 0};

			// 解析 SSE 流
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			// 创建空闲超时保护器
			const guard = createIdleTimeoutGuard({
				reader,
				onTimeout: () => {
					throw new StreamIdleTimeoutError('No data received for 180000ms');
				},
			});

			try {
				while (true) {
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
							// 连接异常中断，抛出明确错误
							const errorMsg = `[API_ERROR] [RETRIABLE] Gemini stream terminated unexpectedly with incomplete data`;
							const bufferPreview = buffer.substring(0, 100);
							logger.error(errorMsg, {
								bufferLength: buffer.length,
								bufferPreview,
							});
							throw new Error(`${errorMsg}: ${bufferPreview}...`);
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
							break;
						}

						// 处理 "event: " 和 "event:" 两种格式
						if (trimmed.startsWith('event:')) {
							// 事件类型,后面会跟随数据
							continue;
						}

						// 处理 "data: " 和 "data:" 两种格式
						if (trimmed.startsWith('data:')) {
							const data = trimmed.startsWith('data: ')
								? trimmed.slice(6)
								: trimmed.slice(5);
							const parseResult = parseJsonWithFix(data, {
								toolName: 'Gemini SSE stream',
								logWarning: false,
								logError: true,
							});

							if (parseResult.success) {
								const chunk = parseResult.data;

								// 处理候选结果
								if (chunk.candidates && chunk.candidates.length > 0) {
									const candidate = chunk.candidates[0];
									if (candidate.content && candidate.content.parts) {
										for (const part of candidate.content.parts) {
											// 处理 thought 内容(Gemini thinking)
											// 当 part.thought === true 时,text 字段包含 thinking 内容
											if (part.thought === true && part.text) {
												thinkingTextBuffer += part.text;
												if (!guard.isAbandoned()) {
													yield {
														type: 'reasoning_delta',
														delta: part.text,
													};
												}
											}
											// 处理常规文本内容(当 thought 不为 true 时)
											else if (part.text) {
												contentBuffer += part.text;
												if (!guard.isAbandoned()) {
													yield {
														type: 'content',
														content: part.text,
													};
												}
											}

											// 处理函数调用
											if (part.functionCall) {
												hasToolCalls = true;
												const fc = part.functionCall;

												const toolCall: any = {
													id: `call_${toolCallIndex++}`,
													type: 'function' as const,
													function: {
														name: fc.name,
														arguments: JSON.stringify(fc.args || {}),
													},
												};

												// 从 part 级别捕获 thoughtSignature(Gemini thinking 模式)
												// 根据 Gemini 文档,thoughtSignature 在 part 级别,与 functionCall 同级
												// 重要提示:Gemini 只在第一个函数调用时返回 thoughtSignature
												// 我们需要保存它并在所有后续函数调用中重用
												const partSignature =
													part.thoughtSignature || part.thought_signature;
												if (partSignature) {
													// 保存第一个签名以供重用
													if (!sharedThoughtSignature) {
														sharedThoughtSignature = partSignature;
													}
													toolCall.thoughtSignature = partSignature;
												} else if (sharedThoughtSignature) {
													// 对后续函数调用使用共享签名
													toolCall.thoughtSignature = sharedThoughtSignature;
												}

												toolCallsBuffer.push(toolCall);

												// 产出 delta 用于 token 计数
												const deltaText =
													fc.name + JSON.stringify(fc.args || {});
												if (!guard.isAbandoned()) {
													yield {
														type: 'tool_call_delta',
														delta: deltaText,
													};
												}
											}
										}
									}
								}

								// 跟踪使用量信息
								if (chunk.usageMetadata) {
									totalTokens = {
										prompt: chunk.usageMetadata.promptTokenCount || 0,
										completion: chunk.usageMetadata.candidatesTokenCount || 0,
										total: chunk.usageMetadata.totalTokenCount || 0,
									};
								}
							}
						}
					}
				}
			} catch (error) {
				logger.error(
					'[API_ERROR] [RETRIABLE] Gemini SSE stream parsing error:',
					{
						error: error instanceof Error ? error.message : 'Unknown error',
						remainingBuffer: buffer.substring(0, 200),
					},
				);
				throw error;
			} finally {
				// 清理 idle timeout 定时器
				guard.dispose();
			}

			// 如果有工具调用则产出
			if (hasToolCalls && toolCallsBuffer.length > 0) {
				yield {
					type: 'tool_calls',
					tool_calls: toolCallsBuffer,
				};
			}

			// 产出使用量信息
			if (totalTokens.total > 0) {
				const usageData = {
					prompt_tokens: totalTokens.prompt,
					completion_tokens: totalTokens.completion,
					total_tokens: totalTokens.total,
				};

				// 在 API 层保存使用量到文件系统
				saveUsageToFile(options.model, usageData);
				yield {
					type: 'usage',
					usage: usageData,
				};
			}

			// 如果存在 thinking 内容则返回完整的 thinking 块
			const thinkingBlock = thinkingTextBuffer
				? {
						type: 'thinking' as const,
						thinking: thinkingTextBuffer,
				  }
				: undefined;

			// 发送完成信号
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
