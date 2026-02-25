import {createStreamingAnthropicCompletion} from '../../api/anthropic.js';
import {createStreamingResponse} from '../../api/responses.js';
import {createStreamingGeminiCompletion} from '../../api/gemini.js';
import {createStreamingChatCompletion} from '../../api/chat.js';
import {getSubAgent, getSubAgents} from '../config/subAgentConfig.js';
import {
	getAgentsPrompt,
	createSystemContext,
	// getTaskCompletionPrompt,
} from '../agentsPromptUtils.js';
import {
	collectAllMCPTools,
	executeMCPTool,
	getUsefulInfoService,
	getTodoService,
} from './mcpToolsManager.js';
import type {MCPExecutionContext} from './mcpToolsManager.js';
import {
	getModelSpecificPromptForConfig,
	getOpenAiConfig,
} from '../config/apiConfig.js';
import {sessionManager} from '../session/sessionManager.js';
import {unifiedHooksExecutor} from './unifiedHooksExecutor.js';
import {checkYoloPermission} from './yoloPermissionChecker.js';
import {
	shouldCompressSubAgentContext,
	getContextPercentage,
	compressSubAgentContext,
	countMessagesTokens,
} from '../core/subAgentContextCompressor.js';
import type {ConfirmationResult} from '../../ui/components/tools/ToolConfirmation.js';
import type {MCPTool} from './mcpToolsManager.js';
import type {ChatMessage} from '../../api/types.js';
import {formatUsefulInfoContext} from '../core/usefulInfoPreprocessor.js';
import {formatTodoContext} from '../core/todoPreprocessor.js';
import {
	formatFolderNotebookContext,
	getReadFolders,
	setReadFolders,
	clearReadFolders,
} from '../core/folderNotebookPreprocessor.js';
import {
	findInsertPositionBeforeNthAssistantFromEnd,
	insertMessagesAtPosition,
} from '../message/messageUtils.js';
import {formatLocalDateTime} from '../core/dateUtils.js';

/**
 * 子智能体消息事件
 * 用于流式返回子智能体的消息片段
 */
export interface SubAgentMessage {
	type: 'sub_agent_message';
	agentId: string;
	agentName: string;
	message: any; // 来自Anthropic API的流事件
}

/**
 * Token使用统计
 */
export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	cacheCreationInputTokens?: number;
	cacheReadInputTokens?: number;
}

/**
 * 子智能体执行结果
 */
export interface SubAgentResult {
	success: boolean;
	result: string;
	error?: string;
	usage?: TokenUsage;
	/** 子代理执行期间从主会话注入的用户消息 */
	injectedUserMessages?: string[];
}

/**
 * 工具确认回调
 * 用于需要用户确认敏感工具调用时
 */
export interface ToolConfirmationCallback {
	(toolName: string, toolArgs: any): Promise<ConfirmationResult>;
}

/**
 * 工具自动批准检查器
 * 用于检查工具是否已配置为自动批准
 */
export interface ToolApprovalChecker {
	(toolName: string): boolean;
}

/**
 * 添加到始终批准列表的回调
 */
export interface AddToAlwaysApprovedCallback {
	(toolName: string): void;
}

/**
 * 用户问题回调接口
 * 用于子智能体调用 askuser 工具时，请求主会话显示蓝色边框的 AskUserQuestion 组件
 * @param question - 问题文本
 * @param options - 选项列表
 * @param multiSelect - 是否多选模式
 * @returns 用户选择的结果
 */
export interface UserQuestionCallback {
	(question: string, options: string[], multiSelect?: boolean): Promise<{
		selected: string | string[];
		customInput?: string;
	}>;
}

function stripSpecialUserMessages(messages: ChatMessage[]): ChatMessage[] {
	return messages.filter(msg => !msg.specialUserMessage);
}

/**
 * 清理会话中的孤立 tool 调用消息,避免 Responses API 因缺少 function_call_output 报错.
 *
 * 处理两类异常:
 * 1. assistant(tool_calls) 没有对应 tool 结果
 * 2. tool 结果没有对应 assistant(tool_calls)
 */
function cleanOrphanedToolCallsInPlace(messages: ChatMessage[]): {
	removedAssistantWithToolCalls: number;
	removedOrphanToolResults: number;
	totalRemoved: number;
} {
	const toolResultIds = new Set<string>();
	for (const msg of messages) {
		if (msg.role === 'tool' && msg.tool_call_id) {
			toolResultIds.add(msg.tool_call_id);
		}
	}

	const declaredToolCallIds = new Set<string>();
	for (const msg of messages) {
		if (msg.role === 'assistant' && msg.tool_calls) {
			for (const tc of msg.tool_calls) {
				declaredToolCallIds.add(tc.id);
			}
		}
	}

	const indicesToRemove = new Set<number>();
	let removedAssistantWithToolCalls = 0;
	let removedOrphanToolResults = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg) continue;

		if (msg.role === 'assistant' && msg.tool_calls) {
			const hasAllResults = msg.tool_calls.every(tc =>
				toolResultIds.has(tc.id),
			);
			if (!hasAllResults) {
				indicesToRemove.add(i);
				removedAssistantWithToolCalls++;
			}
		}

		if (msg.role === 'tool' && msg.tool_call_id) {
			if (!declaredToolCallIds.has(msg.tool_call_id)) {
				indicesToRemove.add(i);
				removedOrphanToolResults++;
			}
		}
	}

	const sortedIndices = Array.from(indicesToRemove).sort((a, b) => b - a);
	for (const idx of sortedIndices) {
		messages.splice(idx, 1);
	}

	return {
		removedAssistantWithToolCalls,
		removedOrphanToolResults,
		totalRemoved: sortedIndices.length,
	};
}

async function refreshSubAgentSpecialUserMessages(
	messages: ChatMessage[],
	sessionId: string | undefined,
	finalPrompt?: string,
): Promise<ChatMessage[]> {
	const baseMessages = stripSpecialUserMessages(messages);
	const specialUserMessages: ChatMessage[] = [];

	// finalPrompt must be injected as specialUserMessage to be properly filtered by stripSpecialUserMessages
	if (finalPrompt) {
		specialUserMessages.push({
			role: 'user',
			content: finalPrompt,
			specialUserMessage: true,
		});
	}

	if (sessionId) {
		const todoService = getTodoService();
		const existingTodoList = await todoService.getTodoList(sessionId);
		if (existingTodoList && existingTodoList.todos.length > 0) {
			const todoContext = formatTodoContext(existingTodoList.todos, true);
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
	const safeInsertPosition =
		baseMessages.length > 0 && baseMessages[0]?.role === 'system'
			? Math.max(1, insertPosition)
			: Math.max(0, insertPosition);

	const mergedMessages = insertMessagesAtPosition(
		baseMessages,
		specialUserMessages,
		safeInsertPosition,
	);

	return mergedMessages;
}

/**
 * Maximum spawn depth to prevent infinite recursive spawning.
 * A sub-agent at depth >= MAX_SPAWN_DEPTH cannot spawn further sub-agents.
 */
const MAX_SPAWN_DEPTH = 1;

/**
 * 执行子智能体作为工具
 * @param agentId - 子智能体 ID
 * @param prompt - 发送给子智能体的任务提示
 * @param onMessage - 流式消息回调（用于 UI 显示）
 * @param abortSignal - 可选的中止信号
 * @param requestToolConfirmation - 工具确认回调
 * @param isToolAutoApproved - 检查工具是否自动批准
 * @param yoloMode - 是否启用 YOLO 模式（自动批准所有工具）
 * @param addToAlwaysApproved - 添加工具到始终批准列表的回调
 * @param requestUserQuestion - 用户问题回调，用于子智能体调用 askuser 工具时显示主会话的蓝色边框 UI
 * @param spawnDepth - 当前 spawn 嵌套深度（0 = 主流程直接调起的子代理）
 * @returns 子智能体的最终结果
 */
export async function executeSubAgent(
	agentId: string,
	prompt: string,
	onMessage?: (message: SubAgentMessage) => void,
	abortSignal?: AbortSignal,
	requestToolConfirmation?: ToolConfirmationCallback,
	isToolAutoApproved?: ToolApprovalChecker,
	yoloMode?: boolean,
	addToAlwaysApproved?: AddToAlwaysApprovedCallback,
	requestUserQuestion?: UserQuestionCallback,
	instanceId?: string,
	spawnDepth: number = 0,
): Promise<SubAgentResult> {
	const mainAgentReadFolders = getReadFolders();
	clearReadFolders();

	try {
		const agent = getSubAgent(agentId);
		if (!agent) {
			return {
				success: false,
				result: '',
				error: `Sub-agent with ID "${agentId}" not found`,
			};
		}

		// 获取子代理的可编辑文件后缀配置
		const editableFileSuffixes = agent.editableFileSuffixes;

		// 获取所有可用工具
		const allTools = await collectAllMCPTools();

		// 根据子代理允许的工具进行过滤
		const allowedTools = allTools.filter((tool: MCPTool) => {
			const toolName = tool.function.name;
			const normalizedToolName = toolName.replace(/_/g, '-');
			const builtInPrefixes = new Set([
				'todo-',
				'notebook-',
				'filesystem-',
				'terminal-',
				'ace-',
				'websearch-',
				'ide-',
				'codebase-',
				'askuser-',
				'skill-',
				'subagent-',
			]);

			return (agent.tools ?? []).some((allowedTool: string) => {
				// 标准化两个工具名称：将下划线替换为连字符进行比较
				const normalizedAllowedTool = allowedTool.replace(/_/g, '-');
				const isQualifiedAllowed =
					normalizedAllowedTool.includes('-') ||
					Array.from(builtInPrefixes).some(prefix =>
						normalizedAllowedTool.startsWith(prefix),
					);

				// 支持精确匹配和前缀匹配（例如，"filesystem" 匹配 "filesystem-read"）
				if (
					normalizedToolName === normalizedAllowedTool ||
					normalizedToolName.startsWith(`${normalizedAllowedTool}-`)
				) {
					return true;
				}

				// 向后兼容：允许非限定的外部工具名称（缺少服务前缀）
				const isExternalTool = !Array.from(builtInPrefixes).some(prefix =>
					normalizedToolName.startsWith(prefix),
				);
				if (
					!isQualifiedAllowed &&
					isExternalTool &&
					normalizedToolName.endsWith(`-${normalizedAllowedTool}`)
				) {
					return true;
				}

				return false;
			});
		});

		if (allowedTools.length === 0) {
			return {
				success: false,
				result: '',
				error: `Sub-agent "${agent.name}" has no valid tools configured`,
			};
		}

		// 构建子代理的对话历史
		let messages: ChatMessage[] = [];

		// 检查是否配置了 subAgentRole（必需）
		if (!agent.subAgentRole) {
			return {
				success: false,
				result: '',
				error: `Sub-agent "${agent.name}" missing subAgentRole configuration`,
			};
		}

		// 注入子代理协作工具（不属于 MCP tools）
		const {runningSubAgentTracker} = await import(
			'./runningSubAgentTracker.js'
		);

		const sendMessageTool: MCPTool = {
			type: 'function' as const,
			function: {
				name: 'send_message_to_agent',
				description:
					"Send a message to another running sub-agent. Use this to share information, findings, or coordinate work with other agents that are executing in parallel. The message will be injected into the target agent's context. IMPORTANT: Use query_agents_status first to check if the target agent is still running before sending.",
				parameters: {
					type: 'object',
					properties: {
						target_agent_id: {
							type: 'string',
							description:
								'The agent ID (type) of the target sub-agent (e.g., "agent_explore", "agent_general"). If multiple instances of the same type are running, the message is sent to the first found instance.',
						},
						target_instance_id: {
							type: 'string',
							description:
								'(Optional) The specific instance ID of the target sub-agent. Use this for precise targeting when multiple instances of the same agent type are running.',
						},
						message: {
							type: 'string',
							description:
								'The message content to send to the target agent. Be clear and specific about what information you are sharing or what action you are requesting.',
						},
					},
					required: ['message'],
				},
			},
		};

		const queryAgentsStatusTool: MCPTool = {
			type: 'function' as const,
			function: {
				name: 'query_agents_status',
				description:
					'Query the current status of all running sub-agents. Returns a list of currently active agents with their IDs, names, prompts, and how long they have been running. Use this to check if a target agent is still running before sending it a message, or to discover new agents that have started.',
				parameters: {
					type: 'object',
					properties: {},
					required: [],
				},
			},
		};

		// 动态构建可 spawn 的子代理列表(排除自身, 并根据白名单过滤)
		const allSubAgents = getSubAgents();
		const allowedSubAgentIds = agent.availableSubAgents;
		const hasSpawnWhitelist =
			Array.isArray(allowedSubAgentIds) && allowedSubAgentIds.length > 0;

		const spawnableAgents = allSubAgents
			.filter(a => a.id !== agent.id) // 排除自身
			.filter(a => !hasSpawnWhitelist || allowedSubAgentIds.includes(a.id)); // 白名单过滤

		// 构建可用子代理描述列表
		const agentDescriptions = spawnableAgents
			.map(a => `- **${a.id}**: ${a.name} — ${a.description}`)
			.join('\n');

		const agentIdList = spawnableAgents.map(a => a.id).join(', ');

		const spawnSubAgentTool: MCPTool = {
			type: 'function' as const,
			function: {
				name: 'spawn_sub_agent',
				description: `Spawn a NEW sub-agent of a DIFFERENT type to get specialized help. The spawned agent runs in parallel and results are reported back automatically.

**WHEN TO USE** — Only spawn when you genuinely need a different agent's specialization.

**WHEN NOT TO USE** — Do NOT spawn to offload YOUR OWN work:
- NEVER spawn an agent of the same type as yourself to delegate your task — that is lazy and wasteful
- NEVER spawn an agent just to "break work into pieces" if you can do it yourself
- NEVER spawn when you are simply stuck — try harder or ask the user instead
- If you can complete the task with your own tools, DO IT YOURSELF

**Available agents you can spawn:**
${agentDescriptions || '(none)'}`,
				parameters: {
					type: 'object',
					properties: {
						agent_id: {
							type: 'string',
							description: `The agent ID to spawn. Must be a DIFFERENT type from yourself. Available: ${
								agentIdList || 'none'
							}.`,
						},
						prompt: {
							type: 'string',
							description:
								'CRITICAL: The task prompt for the spawned agent. Must include COMPLETE context since the spawned agent has NO access to your conversation history. Include all relevant file paths, findings, constraints, and requirements.',
						},
					},
					required: ['agent_id', 'prompt'],
				},
			},
		};

		allowedTools.push(sendMessageTool, queryAgentsStatusTool);
		if (spawnDepth < MAX_SPAWN_DEPTH) {
			allowedTools.push(spawnSubAgentTool);
		}

		// 构建并行子代理协作上下文
		const otherAgents = runningSubAgentTracker
			.getRunningAgents()
			.filter(a => a.instanceId !== instanceId);

		const canSpawn = spawnDepth < MAX_SPAWN_DEPTH;
		let collaborationContext = '';
		if (otherAgents.length > 0) {
			const agentList = otherAgents
				.map(
					a =>
						`- ${a.agentName} (id: ${a.agentId}, instance: ${a.instanceId}): "${
							a.prompt ? a.prompt.substring(0, 120) : 'N/A'
						}"`,
				)
				.join('\n');
			const spawnHint = canSpawn
				? ', or `spawn_sub_agent` to request a DIFFERENT type of agent for specialized help'
				: '';
			const spawnAdvice = canSpawn
				? '\n\n**Spawn rules**: Only spawn agents of a DIFFERENT type for work you CANNOT do with your own tools. Complete your own task first — do NOT delegate it.'
				: '';
			collaborationContext = `\n\n## Currently Running Peer Agents
The following sub-agents are running in parallel with you. You can use \`query_agents_status\` to get real-time status, \`send_message_to_agent\` to communicate${spawnHint}.

${agentList}

If you discover information useful to another agent, proactively share it.${spawnAdvice}`;
		} else {
			const spawnToolLine = canSpawn
				? '\n- `spawn_sub_agent`: Spawn a DIFFERENT type of agent for specialized help (do NOT spawn your own type to offload work)'
				: '';
			const spawnUsage = canSpawn
				? '\n\n**Spawn rules**: Only use `spawn_sub_agent` when you genuinely need a different agent\'s specialization (e.g., you are read-only but need code changes). NEVER spawn to delegate your own task or to "parallelize" work you should do yourself.'
				: '';
			collaborationContext = `\n\n## Agent Collaboration Tools
You have access to these collaboration tools:
- \`query_agents_status\`: Check which sub-agents are currently running
- \`send_message_to_agent\`: Send a message to a running peer agent (check status first!)${spawnToolLine}${spawnUsage}`;
		}

		// 获取子代理配置
		// 如果子代理有 configProfile，则加载；否则使用主配置
		let config;
		let model;
		if (agent.configProfile) {
			try {
				const {loadProfile} = await import('../config/configManager.js');
				const profileConfig = loadProfile(agent.configProfile);
				if (profileConfig?.snowcfg) {
					config = profileConfig.snowcfg;
					model = config.advancedModel || 'gpt-5';
				} else {
					// 未找到配置文件，回退到主配置
					config = getOpenAiConfig();
					model = config.advancedModel || 'gpt-5';
					console.warn(
						`Profile ${agent.configProfile} not found for sub-agent, using main config`,
					);
				}
			} catch (error) {
				// 如果加载配置文件失败，回退到主配置
				config = getOpenAiConfig();
				model = config.advancedModel || 'gpt-5';
				console.warn(
					`Failed to load profile ${agent.configProfile} for sub-agent, using main config:`,
					error,
				);
			}
		} else {
			// 未指定 configProfile，使用主配置
			config = getOpenAiConfig();
			model = config.advancedModel || 'gpt-5';
		}

		// 构建最终提示词: 子代理配置subAgentRole + 模型专属提示词 + AGENTS.md + 系统环境 + 平台指导 + 任务提示词(最后)
		let finalPrompt = '';

		// 1. 如果配置了代理特定角色，则追加
		if (agent.subAgentRole) {
			finalPrompt = agent.subAgentRole;
		}

		// 2. 如果配置了模型专属提示词，则追加
		const modelSpecificPrompt = getModelSpecificPromptForConfig(config);
		if (modelSpecificPrompt) {
			finalPrompt = finalPrompt
				? `${finalPrompt}\n\n${modelSpecificPrompt}`
				: modelSpecificPrompt;
		}

		// 3. 如果有 AGENTS.md 内容，则追加
		const agentsPrompt = getAgentsPrompt();
		if (agentsPrompt) {
			finalPrompt = finalPrompt
				? `${finalPrompt}\n\n${agentsPrompt}`
				: agentsPrompt;
		}

		// 4. 追加系统环境和平台指导
		const systemContext = createSystemContext();
		if (systemContext) {
			finalPrompt = finalPrompt
				? `${finalPrompt}\n\n${systemContext}`
				: systemContext;
		}

		// 5. 添加任务完成标识提示词
		// const taskCompletionPrompt = getTaskCompletionPrompt();
		// if (taskCompletionPrompt) {
		// 	finalPrompt = finalPrompt
		// 		? `${finalPrompt}\n\n${taskCompletionPrompt}`
		// 		: taskCompletionPrompt;
		// }

		// 5.5 注入并行协作上下文
		if (collaborationContext) {
			finalPrompt = `${finalPrompt}${collaborationContext}`;
		}

		// 6. 最后追加主代理传入的任务提示词
		if (prompt) {
			finalPrompt = finalPrompt ? `${finalPrompt}\n\n${prompt}` : prompt;
		}

		const currentSession = sessionManager.getCurrentSession();
		messages = await refreshSubAgentSpecialUserMessages(
			messages,
			currentSession?.id,
			finalPrompt,
		);

		// 在子代理系统提示词后添加任务开始时间
		messages.push({
			role: 'user',
			content: `任务开始时间: ${formatLocalDateTime()}`,
		});

		// 流式执行子代理
		let finalResponse = '';
		let hasError = false;
		let errorMessage = '';
		let totalUsage: TokenUsage | undefined;
		// 当轮 API 返回的 total_tokens(prompt + completion), 用于上下文窗口监控.
		// 与 totalUsage(跨轮累加)不同, 此值仅反映当轮实际上下文大小.
		let latestTotalTokens = 0;
		// 当轮 API 返回的 prompt_tokens, 用于判断 provider usage 是否可靠.
		// 与主代理保持一致: < 1000 视为不可靠, 触发本地 tiktoken 估算.
		let latestPromptTokens = 0;
		// Track all user messages injected from the main session
		const collectedInjectedMessages: string[] = [];

		// Track instanceIds of sub-agents spawned by THIS agent via spawn_sub_agent.
		// Used to prevent this agent from finishing while its children are still running.
		const spawnedChildInstanceIds = new Set<string>();

		// 此子代理执行的本地会话批准工具列表
		// 确保执行期间批准的工具立即被识别
		const sessionApprovedTools = new Set<string>();

		// 子代理内部空回复重试计数器
		let emptyResponseRetryCount = 0;
		const maxEmptyResponseRetries = 3; // 最多重试3次
		let loopIteration = 0;

		// eslint-disable-next-line no-constant-condition
		while (true) {
			loopIteration++;
			// 流式传输前检查中止信号
			if (abortSignal?.aborted) {
				// 发送 done 消息标记完成（类似正常工具中止）
				if (onMessage) {
					onMessage({
						type: 'sub_agent_message',
						agentId: agent.id,
						agentName: agent.name,
						message: {
							type: 'done',
						},
					});
				}
				return {
					success: false,
					result: finalResponse,
					error: 'Sub-agent execution aborted',
				};
			}

			// Inject any pending user messages from the main flow.
			// The main flow enqueues messages via runningSubAgentTracker.enqueueMessage()
			// when the user directs a pending message to this specific sub-agent instance.
			if (instanceId) {
				const injectedMessages =
					runningSubAgentTracker.dequeueMessages(instanceId);
				for (const injectedMsg of injectedMessages) {
					// Collect for inclusion in the final result
					collectedInjectedMessages.push(injectedMsg);

					messages.push({
						role: 'user',
						content: `[User message from main session]\\n${injectedMsg}`,
					});

					// Notify UI about the injected message
					if (onMessage) {
						onMessage({
							type: 'sub_agent_message',
							agentId: agent.id,
							agentName: agent.name,
							message: {
								type: 'user_injected',
								content: injectedMsg,
							},
						});
					}
				}

				// Inject any pending inter-agent messages from other sub-agents
				const interAgentMessages =
					runningSubAgentTracker.dequeueInterAgentMessages(instanceId);
				for (const iaMsg of interAgentMessages) {
					messages.push({
						role: 'user',
						content: `[Inter-agent message from ${iaMsg.fromAgentName} (${iaMsg.fromAgentId})]\n${iaMsg.content}`,
					});

					// Notify UI about the inter-agent message reception
					if (onMessage) {
						onMessage({
							type: 'sub_agent_message',
							agentId: agent.id,
							agentName: agent.name,
							message: {
								type: 'inter_agent_received',
								fromAgentId: iaMsg.fromAgentId,
								fromAgentName: iaMsg.fromAgentName,
								content: iaMsg.content,
							},
						});
					}
				}
			}

			const currentSession = sessionManager.getCurrentSession();
			messages = await refreshSubAgentSpecialUserMessages(
				messages,
				currentSession?.id,
				finalPrompt,
			);

			// 防御性清理: 避免历史中存在孤立 tool_calls / tool_result 导致 Responses API 400
			cleanOrphanedToolCallsInPlace(messages);

			// 重试回调函数 - 为子智能体提供流中断重试支持
			const onRetry = (error: Error, attempt: number, nextDelay: number) => {
				// 通过 onMessage 将重试状态传递给主会话
				if (onMessage) {
					onMessage({
						type: 'sub_agent_message',
						agentId: agent.id,
						agentName: agent.name,
						message: {
							type: 'retry_status',
							isRetrying: true,
							attempt,
							nextDelay,
							errorMessage: `流中断重试 [${
								agent.name
							}]: ${error.message.substring(0, 50)}...`,
						},
					});
				}
			};

			// 使用子代理的工具调用API - 根据配置选择API
			// 应用子代理配置覆盖（模型已从上面的 configProfile 加载）
			// 子代理遵循全局配置（通过 configProfile 继承或覆盖）
			// API 层会根据 configProfile 自动获取自定义系统提示词和请求头

			const stream =
				config.requestMethod === 'anthropic'
					? createStreamingAnthropicCompletion(
							{
								model,
								messages,
								temperature: 0,
								max_tokens: config.maxTokens || 4096,
								tools: allowedTools,
								sessionId: currentSession?.id,
								//disableThinking: true, // Sub-agents 不使用 Extended Thinking
								configProfile: agent.configProfile,
								subAgentSystemPrompt: finalPrompt,
							},
							abortSignal,
							onRetry,
					  )
					: config.requestMethod === 'gemini'
					? createStreamingGeminiCompletion(
							{
								model,
								messages,
								temperature: 0,
								tools: allowedTools,
								configProfile: agent.configProfile,
								subAgentSystemPrompt: finalPrompt,
							},
							abortSignal,
							onRetry,
					  )
					: config.requestMethod === 'responses'
					? createStreamingResponse(
							{
								model,
								messages,
								temperature: 0,
								tools: allowedTools,
								prompt_cache_key: currentSession?.id,
								configProfile: agent.configProfile,
								subAgentSystemPrompt: finalPrompt,
							},
							abortSignal,
							onRetry,
					  )
					: createStreamingChatCompletion(
							{
								model,
								messages,
								temperature: 0,
								tools: allowedTools,
								configProfile: agent.configProfile,
								subAgentSystemPrompt: finalPrompt,
							},
							abortSignal,
							onRetry,
					  );

			let currentContent = '';
			let toolCalls: any[] = [];
			// 保存 thinking/reasoning 内容用于多轮对话
			let currentThinking:
				| {type: 'thinking'; thinking: string; signature?: string}
				| undefined; // Anthropic/Gemini thinking block
			let currentReasoningContent: string | undefined; // Chat API (DeepSeek R1) reasoning_content
			let currentReasoning:
				| {
						summary?: Array<{type: 'summary_text'; text: string}>;
						content?: any;
						encrypted_content?: string;
				  }
				| undefined; // Responses API reasoning data
			let hasReceivedData = false; // 标记是否收到过任何数据

			for await (const event of stream) {
				// 检查中止信号 - 子代理需要检测中断并立即停止
				if (abortSignal?.aborted) {
					break;
				}

				// 检测是否收到有效数据
				if (
					event.type === 'content' ||
					event.type === 'tool_calls' ||
					event.type === 'usage'
				) {
					hasReceivedData = true;
				}

				if (onMessage) {
					onMessage({
						type: 'sub_agent_message',
						agentId: agent.id,
						agentName: agent.name,
						message: event,
					});
				}

				// Capture usage from stream events
				if (event.type === 'usage' && event.usage) {
					const eventUsage = event.usage;
					// Track total_tokens (prompt + completion) for context window monitoring.
					// total_tokens better reflects actual context consumption because the model's
					// response (completion_tokens) will also be added to the messages array,
					// contributing to the next round's input.
					latestTotalTokens =
						eventUsage.total_tokens ||
						(eventUsage.prompt_tokens || 0) +
							(eventUsage.completion_tokens || 0);
					// 单独追踪 prompt_tokens 以判断 usage 是否可靠.
					latestPromptTokens = eventUsage.prompt_tokens || 0;

					if (!totalUsage) {
						totalUsage = {
							inputTokens: eventUsage.prompt_tokens || 0,
							outputTokens: eventUsage.completion_tokens || 0,
							cacheCreationInputTokens: eventUsage.cache_creation_input_tokens,
							cacheReadInputTokens: eventUsage.cache_read_input_tokens,
						};
					} else {
						// Accumulate usage if there are multiple rounds
						totalUsage.inputTokens += eventUsage.prompt_tokens || 0;
						totalUsage.outputTokens += eventUsage.completion_tokens || 0;
						if (eventUsage.cache_creation_input_tokens) {
							totalUsage.cacheCreationInputTokens =
								(totalUsage.cacheCreationInputTokens || 0) +
								eventUsage.cache_creation_input_tokens;
						}
						if (eventUsage.cache_read_input_tokens) {
							totalUsage.cacheReadInputTokens =
								(totalUsage.cacheReadInputTokens || 0) +
								eventUsage.cache_read_input_tokens;
						}
					}

					// Notify UI of context usage DURING the stream (before 'done' marks message complete)
					// This ensures the streaming message still exists for the UI to update
					if (onMessage && config.maxContextTokens && latestTotalTokens > 0) {
						const ctxPct = getContextPercentage(
							latestTotalTokens,
							config.maxContextTokens,
						);
						// Use Math.max(1, ...) so the first API call (small prompt) still shows ≥1%
						// instead of rounding to 0% and hiding the bar entirely
						onMessage({
							type: 'sub_agent_message',
							agentId: agent.id,
							agentName: agent.name,
							message: {
								type: 'context_usage',
								percentage: Math.max(1, Math.round(ctxPct)),
								inputTokens: latestTotalTokens,
								maxTokens: config.maxContextTokens,
							},
						});
					}
				}

				if (event.type === 'content' && event.content) {
					currentContent += event.content;
				} else if (event.type === 'tool_calls' && event.tool_calls) {
					toolCalls = event.tool_calls;
				} else if (event.type === 'reasoning_data' && 'reasoning' in event) {
					// Capture reasoning data from Responses API
					currentReasoning = event.reasoning as typeof currentReasoning;
				} else if (event.type === 'done') {
					// Capture thinking/reasoning from done event for multi-turn conversations
					if ('thinking' in event && event.thinking) {
						// Anthropic/Gemini thinking block
						currentThinking = event.thinking as {
							type: 'thinking';
							thinking: string;
							signature?: string;
						};
					}
					if ('reasoning_content' in event && event.reasoning_content) {
						// Chat API (DeepSeek R1) reasoning_content
						currentReasoningContent = event.reasoning_content as string;
					}
				}
			}

			// 检查空回复情况
			if (
				!hasReceivedData ||
				(!currentContent.trim() && toolCalls.length === 0)
			) {
				// 子代理内部处理空回复重试，不抛出错误给主代理
				emptyResponseRetryCount++;

				if (emptyResponseRetryCount <= maxEmptyResponseRetries) {
					// 发送重试状态消息
					if (onMessage) {
						onMessage({
							type: 'sub_agent_message',
							agentId: agent.id,
							agentName: agent.name,
							message: {
								type: 'retry_status',
								isRetrying: true,
								attempt: emptyResponseRetryCount,
								nextDelay: 1000, // 1秒延迟
								errorMessage: `空回复重试 [${agent.name}]: 未收到内容或工具调用`,
							},
						});
					}

					// 等待1秒后重试
					await new Promise(resolve => setTimeout(resolve, 1000));
					continue; // 继续下一轮循环
				} else {
					// 超过最大重试次数，返回错误但不抛出异常
					return {
						success: false,
						result: finalResponse,
						error: `子代理空回复重试失败：已重试 ${maxEmptyResponseRetries} 次`,
					};
				}
			} else {
				// 重置重试计数器（成功收到数据）
				emptyResponseRetryCount = 0;
			}

			// 添加助手响应到对话
			if (currentContent || toolCalls.length > 0) {
				const assistantMessage: ChatMessage = {
					role: 'assistant',
					content: currentContent || '',
				};

				// Save thinking/reasoning for multi-turn conversations
				// Anthropic/Gemini: thinking block (required by Anthropic when thinking is enabled)
				if (currentThinking) {
					assistantMessage.thinking = currentThinking;
				}
				// Chat API (DeepSeek R1): reasoning_content
				if (currentReasoningContent) {
					(assistantMessage as any).reasoning_content = currentReasoningContent;
				}
				// Responses API: reasoning data with encrypted_content
				if (currentReasoning) {
					(assistantMessage as any).reasoning = currentReasoning;
				}

				if (toolCalls.length > 0) {
					// tool_calls may contain thought_signature (Gemini thinking mode)
					// This is preserved automatically since toolCalls is captured directly from the stream
					assistantMessage.tool_calls = toolCalls;
				}

				messages.push(assistantMessage);
				finalResponse = currentContent;
			}

			if (hasError) {
				return {
					success: false,
					result: finalResponse,
					error: errorMessage,
				};
			}

			// 兜底: 当上游接口未返回 usage 或返回的 prompt_tokens 不合理时(< 1000,
			// 因为系统提示词 + 工具定义通常就超过 1k), 用 tiktoken 估算 token.
			// 此阈值与主代理保持一致(useConversation.ts).
			if (latestPromptTokens < 1000 && config.maxContextTokens) {
				latestTotalTokens = countMessagesTokens(messages, allowedTools);

				// 将估算的上下文占用同步给 UI.
				if (onMessage && latestTotalTokens > 0) {
					const ctxPct = getContextPercentage(
						latestTotalTokens,
						config.maxContextTokens,
					);
					onMessage({
						type: 'sub_agent_message',
						agentId: agent.id,
						agentName: agent.name,
						message: {
							type: 'context_usage',
							percentage: Math.max(1, Math.round(ctxPct)),
							inputTokens: latestTotalTokens,
							maxTokens: config.maxContextTokens,
						},
					});
				}
			}

			// 上下文压缩检查: 接近窗口上限时压缩消息,避免超限失败.
			let justCompressed = false;
			if (latestTotalTokens > 0 && config.maxContextTokens) {
				// 超过阈值后触发压缩.
				if (
					shouldCompressSubAgentContext(
						latestTotalTokens,
						config.maxContextTokens,
					)
				) {
					const ctxPercentage = getContextPercentage(
						latestTotalTokens,
						config.maxContextTokens,
					);
					// Notify UI that compression is starting
					if (onMessage) {
						onMessage({
							type: 'sub_agent_message',
							agentId: agent.id,
							agentName: agent.name,
							message: {
								type: 'context_compressing',
								percentage: Math.round(ctxPercentage),
							},
						});
					}

					try {
						const compressionResult = await compressSubAgentContext(
							messages,
							latestTotalTokens,
							config.maxContextTokens,
							{
								model,
								requestMethod: config.requestMethod,
								maxTokens: config.maxTokens,
								configProfile: agent.configProfile,
							},
							allowedTools,
						);

						if (compressionResult.compressed) {
							// Replace messages array contents
							messages.length = 0;
							messages.push(...compressionResult.messages);
							justCompressed = true;

							// Reset latestTotalTokens to the estimated post-compression value
							// so the next context_usage event reflects the compressed state
							if (compressionResult.afterTokensEstimate) {
								latestTotalTokens = compressionResult.afterTokensEstimate;
							}

							// Notify UI that compression is complete
							if (onMessage) {
								onMessage({
									type: 'sub_agent_message',
									agentId: agent.id,
									agentName: agent.name,
									message: {
										type: 'context_compressed',
										beforeTokens: compressionResult.beforeTokens,
										afterTokensEstimate: compressionResult.afterTokensEstimate,
									},
								});
							}
						}
					} catch (compressError) {
						// Continue without compression — the API call may still succeed
						// or will fail with context_length_exceeded on the next round
					}
				}
			}

			// ── After compression: force continuation if agent was about to exit ──
			// When context was compressed and the model gave a "final" response (no tool_calls),
			// the response was likely generated under context pressure. Remove it and ask the
			// agent to continue working with the now-compressed context.
			if (justCompressed && toolCalls.length === 0) {
				// Remove the last assistant message (premature exit under context pressure)
				while (
					messages.length > 0 &&
					messages[messages.length - 1]?.role === 'assistant'
				) {
					messages.pop();
				}
				// Inject continuation instruction
				messages.push({
					role: 'user',
					content:
						'[System] Your context has been auto-compressed to free up space. Your task is NOT finished. Continue working based on the compressed context above. Pick up where you left off.',
				});
				continue;
			}

			// If no tool calls, we're done — BUT first check for spawned children
			if (toolCalls.length === 0) {
				// ── Wait for spawned child agents before finishing ──
				// If this agent spawned children via spawn_sub_agent, we must
				// wait for them and feed their results back before we exit.
				// This prevents the parent from finishing (and thus the main flow
				// from considering this tool call "done") while children still run.
				const runningChildren = Array.from(spawnedChildInstanceIds).filter(id =>
					runningSubAgentTracker.isRunning(id),
				);

				if (
					runningChildren.length > 0 ||
					runningSubAgentTracker.hasSpawnedResults()
				) {
					// Wait for running children to complete
					if (runningChildren.length > 0) {
						await runningSubAgentTracker.waitForSpawnedAgents(
							300_000, // 5 min timeout
							abortSignal,
						);
					}

					// Drain all spawned results and inject as user context
					const spawnedResults = runningSubAgentTracker.drainSpawnedResults();
					if (spawnedResults.length > 0) {
						for (const sr of spawnedResults) {
							const statusIcon = sr.success ? '✓' : '✗';
							const resultSummary = sr.success
								? sr.result.length > 800
									? sr.result.substring(0, 800) + '...'
									: sr.result
								: sr.error || 'Unknown error';

							messages.push({
								role: 'user',
								content: `[Spawned Sub-Agent Result] ${statusIcon} ${sr.agentName} (${sr.agentId})\nPrompt: ${sr.prompt}\nResult: ${resultSummary}`,
							});

							// Notify UI about the spawned agent completion
							if (onMessage) {
								onMessage({
									type: 'sub_agent_message',
									agentId: agent.id,
									agentName: agent.name,
									message: {
										type: 'spawned_agent_completed',
										spawnedAgentId: sr.agentId,
										spawnedAgentName: sr.agentName,
										success: sr.success,
									} as any,
								});
							}
						}

						// Don't break — continue the loop so the AI sees spawned results
						// and can incorporate them into its final response
						if (onMessage) {
							onMessage({
								type: 'sub_agent_message',
								agentId: agent.id,
								agentName: agent.name,
								message: {
									type: 'done',
								},
							});
						}
						continue;
					}
				}

				if (toolCalls.length === 0) {
					// 执行 onSubAgentComplete 钩子（在子代理任务完成前）
					try {
						const hookResult = await unifiedHooksExecutor.executeHooks(
							'onSubAgentComplete',
							{
								agentId: agent.id,
								agentName: agent.name,
								content: finalResponse,
								success: true,
								usage: totalUsage,
							},
						);

						// 处理钩子返回结果
						if (hookResult.results && hookResult.results.length > 0) {
							let shouldContinue = false;

							for (const result of hookResult.results) {
								if (result.type === 'command' && !result.success) {
									if (result.exitCode >= 2) {
										// exitCode >= 2: 错误，追加消息并再次调用 API
										const errorMessage: ChatMessage = {
											role: 'user',
											content: result.error || result.output || '未知错误',
										};
										messages.push(errorMessage);
										shouldContinue = true;
									}
								} else if (result.type === 'prompt' && result.response) {
									// 处理 prompt 类型
									if (
										result.response.ask === 'ai' &&
										result.response.continue
									) {
										// 发送给 AI 继续处理
										const promptMessage: ChatMessage = {
											role: 'user',
											content: result.response.message,
										};
										messages.push(promptMessage);
										shouldContinue = true;
									}
								}
							}
							// 如果需要继续，则不 break，让循环继续
							if (shouldContinue) {
								// 在继续前发送提示信息
								if (onMessage) {
									// 先发送一个 done 消息标记当前流结束
									onMessage({
										type: 'sub_agent_message',
										agentId: agent.id,
										agentName: agent.name,
										message: {
											type: 'done',
										},
									});
								}
								continue;
							}
						}
					} catch {
						// 钩子异常不应中断子代理主流程.
					}

					// 发送完整结果消息给UI显示
					if (onMessage && finalResponse) {
						onMessage({
							type: 'sub_agent_message',
							agentId: agent.id,
							agentName: agent.name,
							message: {
								type: 'subagent_result',
								agentType: agent.id.replace('agent_', ''),
								content: finalResponse,
								originalContent: finalResponse,
								status: 'success',
								timestamp: Date.now(),
								// @ts-ignore
								isResult: true,
							},
						});
					}

					break;
				}
			}

			// 拦截 send_message_to_agent 工具：子代理间通信，内部处理，不需要外部执行
			const sendMsgTools = toolCalls.filter(
				tc => tc.function.name === 'send_message_to_agent',
			);

			if (sendMsgTools.length > 0 && instanceId) {
				for (const sendMsgTool of sendMsgTools) {
					let targetAgentId: string | undefined;
					let targetInstanceId: string | undefined;
					let msgContent = '';

					try {
						const args = JSON.parse(sendMsgTool.function.arguments);
						targetAgentId = args.target_agent_id;
						targetInstanceId = args.target_instance_id;
						msgContent = args.message || '';
					} catch {
						// 参数解析失败时交由后续校验返回工具错误结果.
					}

					let success = false;
					let resultText = '';

					if (!msgContent) {
						resultText = 'Error: message content is empty';
					} else if (targetInstanceId) {
						// Send to specific instance
						success = runningSubAgentTracker.sendInterAgentMessage(
							instanceId,
							targetInstanceId,
							msgContent,
						);
						if (success) {
							const targetAgent = runningSubAgentTracker
								.getRunningAgents()
								.find(a => a.instanceId === targetInstanceId);
							resultText = `Message sent to ${
								targetAgent?.agentName || targetInstanceId
							}`;
						} else {
							resultText = `Error: Target agent instance "${targetInstanceId}" is not running`;
						}
					} else if (targetAgentId) {
						// Find by agent type ID
						const targetAgent =
							runningSubAgentTracker.findInstanceByAgentId(targetAgentId);
						if (targetAgent && targetAgent.instanceId !== instanceId) {
							success = runningSubAgentTracker.sendInterAgentMessage(
								instanceId,
								targetAgent.instanceId,
								msgContent,
							);
							if (success) {
								resultText = `Message sent to ${targetAgent.agentName} (instance: ${targetAgent.instanceId})`;
							} else {
								resultText = `Error: Failed to send message to ${targetAgentId}`;
							}
						} else if (targetAgent && targetAgent.instanceId === instanceId) {
							resultText = 'Error: Cannot send a message to yourself';
						} else {
							resultText = `Error: No running agent found with ID "${targetAgentId}"`;
						}
					} else {
						resultText =
							'Error: Either target_agent_id or target_instance_id must be provided';
					}

					// Build tool result
					const toolResultMessage = {
						role: 'tool' as const,
						tool_call_id: sendMsgTool.id,
						content: JSON.stringify({success, result: resultText}),
					};
					messages.push(toolResultMessage);

					// Notify UI about the inter-agent message sending
					if (onMessage) {
						onMessage({
							type: 'sub_agent_message',
							agentId: agent.id,
							agentName: agent.name,
							message: {
								type: 'inter_agent_sent',
								targetAgentId: targetAgentId || targetInstanceId || 'unknown',
								targetAgentName:
									(targetInstanceId
										? runningSubAgentTracker
												.getRunningAgents()
												.find(a => a.instanceId === targetInstanceId)?.agentName
										: targetAgentId
										? runningSubAgentTracker.findInstanceByAgentId(
												targetAgentId,
										  )?.agentName
										: undefined) ||
									targetAgentId ||
									'unknown',
								content: msgContent,
								success,
							} as any,
						});
					}
				}

				// Remove send_message_to_agent from toolCalls
				toolCalls = toolCalls.filter(
					tc => tc.function.name !== 'send_message_to_agent',
				);

				if (toolCalls.length === 0) {
					continue;
				}
			}

			// 拦截 query_agents_status 工具：返回当前所有子代理的状态
			const queryStatusTools = toolCalls.filter(
				tc => tc.function.name === 'query_agents_status',
			);

			if (queryStatusTools.length > 0) {
				for (const queryTool of queryStatusTools) {
					const allAgents = runningSubAgentTracker.getRunningAgents();
					const statusList = allAgents.map(a => ({
						instanceId: a.instanceId,
						agentId: a.agentId,
						agentName: a.agentName,
						prompt: a.prompt ? a.prompt.substring(0, 150) : 'N/A',
						runningFor: `${Math.floor(
							(Date.now() - a.startedAt.getTime()) / 1000,
						)}s`,
						isSelf: a.instanceId === instanceId,
					}));

					const toolResultMessage = {
						role: 'tool' as const,
						tool_call_id: queryTool.id,
						content: JSON.stringify({
							totalRunning: allAgents.length,
							agents: statusList,
						}),
					};
					messages.push(toolResultMessage);
				}

				toolCalls = toolCalls.filter(
					tc => tc.function.name !== 'query_agents_status',
				);

				if (toolCalls.length === 0) {
					continue;
				}
			}

			// 拦截 spawn_sub_agent 工具：异步启动新子代理，结果注入主流程
			const spawnTools = toolCalls.filter(
				tc => tc.function.name === 'spawn_sub_agent',
			);

			if (spawnTools.length > 0 && instanceId) {
				for (const spawnTool of spawnTools) {
					let spawnAgentId = '';
					let spawnPrompt = '';

					try {
						const args = JSON.parse(spawnTool.function.arguments);
						spawnAgentId = args.agent_id || '';
						spawnPrompt = args.prompt || '';
					} catch {
						// 参数解析失败时交由后续必填校验统一返回错误.
					}

					if (!spawnAgentId || !spawnPrompt) {
						const toolResultMessage = {
							role: 'tool' as const,
							tool_call_id: spawnTool.id,
							content: JSON.stringify({
								success: false,
								error: 'Both agent_id and prompt are required',
							}),
						};
						messages.push(toolResultMessage);
						continue;
					}

					// 禁止spawn与自身同类型的子代理,避免无效委派和资源浪费.
					if (spawnAgentId === agent.id) {
						const toolResultMessage = {
							role: 'tool' as const,
							tool_call_id: spawnTool.id,
							content: JSON.stringify({
								success: false,
								error: `REJECTED: You (${agent.name}) attempted to spawn another "${spawnAgentId}" which is the SAME type as yourself. This is not allowed because it wastes resources and delegates work you should complete yourself. If you need help from a DIFFERENT specialization, spawn a different agent type. If the task is within your capabilities, do it yourself.`,
							}),
						};
						messages.push(toolResultMessage);
						continue;
					}

					// 仅在白名单非空时才限制spawn目标,undefined或空数组均按不限制处理.
					// 这样可兼容旧配置和默认行为,避免升级后意外阻断已有子代理协作流程.
					const allowedSubAgents = agent.availableSubAgents;
					const hasWhitelist =
						Array.isArray(allowedSubAgents) && allowedSubAgents.length > 0;
					if (hasWhitelist && !allowedSubAgents.includes(spawnAgentId)) {
						const toolResultMessage = {
							role: 'tool' as const,
							tool_call_id: spawnTool.id,
							content: JSON.stringify({
								success: false,
								error: `REJECTED: Agent "${
									agent.name
								}" is not allowed to spawn "${spawnAgentId}". Allowed sub-agents: ${allowedSubAgents.join(
									', ',
								)}`,
							}),
						};
						messages.push(toolResultMessage);
						continue;
					}

					// Look up agent name
					let spawnAgentName = spawnAgentId;
					try {
						const agentConfig = getSubAgent(spawnAgentId);
						if (agentConfig) {
							spawnAgentName = agentConfig.name;
						}
					} catch {
						// Built-in agents aren't resolved by getSubAgent, use ID-based name mapping
						const builtinNames: Record<string, string> = {
							agent_reviewer: 'reviewer',
							agent_explore: 'Explore Agent',
							agent_general: 'General Purpose Agent',
							agent_todo_progress_useful_info_admin:
								'Todo progress and Useful_info Administrator',
							agent_architect: 'Architect',
						};
						spawnAgentName = builtinNames[spawnAgentId] || spawnAgentId;
					}

					// Generate unique instance ID
					const spawnInstanceId = `spawn-${Date.now()}-${Math.random()
						.toString(36)
						.slice(2, 8)}`;

					// Get current agent info for the "spawnedBy" record
					const spawnerInfo = {
						instanceId,
						agentId: agent.id,
						agentName: agent.name,
					};

					// Track this child so we can wait for it before finishing
					spawnedChildInstanceIds.add(spawnInstanceId);

					// Register spawned agent in tracker
					runningSubAgentTracker.register({
						instanceId: spawnInstanceId,
						agentId: spawnAgentId,
						agentName: spawnAgentName,
						prompt: spawnPrompt,
						startedAt: new Date(),
					});

					// Fire-and-forget: start the spawned agent asynchronously
					// Its result will be stored in the tracker for the main flow to pick up
					executeSubAgent(
						spawnAgentId,
						spawnPrompt,
						onMessage, // Same UI callback — spawned agent's messages are visible
						abortSignal, // Same abort signal — ESC stops everything
						requestToolConfirmation,
						isToolAutoApproved,
						yoloMode,
						addToAlwaysApproved,
						requestUserQuestion,
						spawnInstanceId,
						spawnDepth + 1, // Increase depth to enforce MAX_SPAWN_DEPTH limit
					)
						.then(result => {
							// Store the result for the main flow to pick up
							runningSubAgentTracker.storeSpawnedResult({
								instanceId: spawnInstanceId,
								agentId: spawnAgentId,
								agentName: spawnAgentName,
								prompt:
									spawnPrompt.length > 200
										? spawnPrompt.substring(0, 200) + '...'
										: spawnPrompt,
								success: result.success,
								result: result.result,
								error: result.error,
								completedAt: new Date(),
								spawnedBy: spawnerInfo,
							});
						})
						.catch(error => {
							runningSubAgentTracker.storeSpawnedResult({
								instanceId: spawnInstanceId,
								agentId: spawnAgentId,
								agentName: spawnAgentName,
								prompt:
									spawnPrompt.length > 200
										? spawnPrompt.substring(0, 200) + '...'
										: spawnPrompt,
								success: false,
								result: '',
								error: error instanceof Error ? error.message : 'Unknown error',
								completedAt: new Date(),
								spawnedBy: spawnerInfo,
							});
						})
						.finally(() => {
							// Unregister the spawned agent (it may have already been unregistered
							// inside executeSubAgent, but calling again is safe due to the delete check)
							runningSubAgentTracker.unregister(spawnInstanceId);
						});

					// Notify UI that a spawn happened
					if (onMessage) {
						onMessage({
							type: 'sub_agent_message',
							agentId: agent.id,
							agentName: agent.name,
							message: {
								type: 'agent_spawned',
								spawnedAgentId: spawnAgentId,
								spawnedAgentName: spawnAgentName,
								spawnedInstanceId: spawnInstanceId,
								spawnedPrompt: spawnPrompt,
							} as any,
						});
					}

					// Return immediate result to spawning sub-agent
					const toolResultMessage = {
						role: 'tool' as const,
						tool_call_id: spawnTool.id,
						content: JSON.stringify({
							success: true,
							result: `Agent "${spawnAgentName}" (${spawnAgentId}) has been spawned and is now running in the background with instance ID "${spawnInstanceId}". Its results will be automatically reported to the main workflow when it completes.`,
						}),
					};
					messages.push(toolResultMessage);
				}

				toolCalls = toolCalls.filter(
					tc => tc.function.name !== 'spawn_sub_agent',
				);

				if (toolCalls.length === 0) {
					continue;
				}
			}

			// 拦截 askuser 工具：子智能体调用时需要显示主会话的蓝色边框 UI，而不是工具确认界面
			const askUserTool = toolCalls.find(tc =>
				tc.function.name.startsWith('askuser-'),
			);

			if (askUserTool && requestUserQuestion) {
				//解析工具参数，失败时使用默认值
				let question = 'Please select an option:';
				let options: string[] = ['Yes', 'No'];
				let multiSelect = false;

				try {
					const args = JSON.parse(askUserTool.function.arguments);
					if (args.question) question = args.question;
					if (args.options && Array.isArray(args.options)) {
						options = args.options;
					}
					if (args.multiSelect === true) {
						multiSelect = true;
					}
				} catch {
					// 参数解析失败时使用默认问题与选项继续流程.
				}

				const userAnswer = await requestUserQuestion(
					question,
					options,
					multiSelect,
				);

				const answerText = userAnswer.customInput
					? `${
							Array.isArray(userAnswer.selected)
								? userAnswer.selected.join(', ')
								: userAnswer.selected
					  }: ${userAnswer.customInput}`
					: Array.isArray(userAnswer.selected)
					? userAnswer.selected.join(', ')
					: userAnswer.selected;

				const toolResultMessage = {
					role: 'tool' as const,
					tool_call_id: askUserTool.id,
					content: JSON.stringify({
						answer: answerText,
						selected: userAnswer.selected,
						customInput: userAnswer.customInput,
					}),
				};

				messages.push(toolResultMessage);

				if (onMessage) {
					onMessage({
						type: 'sub_agent_message',
						agentId: agent.id,
						agentName: agent.name,
						message: {
							type: 'tool_result',
							tool_call_id: askUserTool.id,
							tool_name: askUserTool.function.name,
							content: JSON.stringify({
								answer: answerText,
								selected: userAnswer.selected,
								customInput: userAnswer.customInput,
							}),
						} as any,
					});
				}

				// 移除已处理的 askuser 工具，避免重复执行
				const remainingTools = toolCalls.filter(tc => tc.id !== askUserTool.id);

				if (remainingTools.length === 0) {
					continue;
				}

				toolCalls = remainingTools;
			}

			// 执行前检查工具批准
			const approvedToolCalls: typeof toolCalls = [];
			const rejectedToolCalls: typeof toolCalls = [];
			const rejectionReasons = new Map<string, string>(); // Map tool_call_id to rejection reason

			for (const toolCall of toolCalls) {
				const toolName = toolCall.function.name;
				let args: any;
				try {
					args = JSON.parse(toolCall.function.arguments);
				} catch (e) {
					args = {};
				}

				// 使用统一的YOLO权限检查器检查工具是否需要确认
				const permissionResult = await checkYoloPermission(
					toolName,
					args,
					yoloMode ?? false,
				);
				let needsConfirmation = permissionResult.needsConfirmation;

				// 检查工具是否在自动批准列表中(全局或会话)
				// 这应该覆盖YOLO权限检查结果
				if (
					sessionApprovedTools.has(toolName) ||
					(isToolAutoApproved && isToolAutoApproved(toolName))
				) {
					needsConfirmation = false;
				}

				if (needsConfirmation && requestToolConfirmation) {
					// Request confirmation from user
					const confirmation = await requestToolConfirmation(toolName, args);

					if (
						confirmation === 'reject' ||
						(typeof confirmation === 'object' &&
							confirmation.type === 'reject_with_reply')
					) {
						rejectedToolCalls.push(toolCall);
						// Save rejection reason if provided
						if (typeof confirmation === 'object' && confirmation.reason) {
							rejectionReasons.set(toolCall.id, confirmation.reason);
						}
						continue;
					}
					// 如果选择'始终批准',则添加到全局和会话列表
					if (confirmation === 'approve_always') {
						// 添加到本地会话集合(立即生效)
						sessionApprovedTools.add(toolName);
						// 添加到全局列表(跨子代理调用持久化)
						if (addToAlwaysApproved) {
							addToAlwaysApproved(toolName);
						}
					}
				}

				approvedToolCalls.push(toolCall);
			}

			// 处理被拒绝的工具 - 将拒绝结果添加到对话而不是停止
			if (rejectedToolCalls.length > 0) {
				const rejectionResults: ChatMessage[] = [];

				for (const toolCall of rejectedToolCalls) {
					// 如果用户提供了拒绝原因,则获取
					const rejectionReason = rejectionReasons.get(toolCall.id);
					const rejectMessage = rejectionReason
						? `Tool execution rejected by user: ${rejectionReason}`
						: 'Tool execution rejected by user';

					const toolResultMessage = {
						role: 'tool' as const,
						tool_call_id: toolCall.id,
						content: `Error: ${rejectMessage}`,
					};
					rejectionResults.push(toolResultMessage);

					// Send tool result to UI
					if (onMessage) {
						onMessage({
							type: 'sub_agent_message',
							agentId: agent.id,
							agentName: agent.name,
							message: {
								type: 'tool_result',
								tool_call_id: toolCall.id,
								tool_name: toolCall.function.name,
								content: `Error: ${rejectMessage}`,
							} as any,
						});
					}
				}

				// 将拒绝结果添加到对话
				messages.push(...rejectionResults);

				// If all tools were rejected and there are no approved tools, continue to next AI turn
				// The AI will see the rejection messages and can respond accordingly
				if (approvedToolCalls.length === 0) {
					continue;
				}

				// Otherwise, continue executing approved tools below
			}

			// Execute approved tool calls
			const toolResults: ChatMessage[] = [];
			for (const toolCall of approvedToolCalls) {
				// 执行每个工具前检查中止信号
				if (abortSignal?.aborted) {
					// Send done message to mark completion
					if (onMessage) {
						onMessage({
							type: 'sub_agent_message',
							agentId: agent.id,
							agentName: agent.name,
							message: {
								type: 'done',
							},
						});
					}
					return {
						success: false,
						result: finalResponse,
						error: 'Sub-agent execution aborted during tool execution',
					};
				}

				try {
					const args = JSON.parse(toolCall.function.arguments);
					// 构建执行上下文，传递子代理的可编辑文件后缀配置
					const executionContext: MCPExecutionContext = {
						editableFileSuffixes,
						skipToolHooks: false,
					};
					const result = await executeMCPTool(
						toolCall.function.name,
						args,
						abortSignal,
						undefined, // onTokenUpdate
						executionContext,
					);

					const toolResult = {
						role: 'tool' as const,
						tool_call_id: toolCall.id,
						content: JSON.stringify(result),
					};
					toolResults.push(toolResult);

					// Send tool result to UI
					if (onMessage) {
						onMessage({
							type: 'sub_agent_message',
							agentId: agent.id,
							agentName: agent.name,
							message: {
								type: 'tool_result',
								tool_call_id: toolCall.id,
								tool_name: toolCall.function.name,
								content: JSON.stringify(result),
							} as any,
						});
					}
				} catch (error) {
					const errorResult = {
						role: 'tool' as const,
						tool_call_id: toolCall.id,
						content: `Error: ${
							error instanceof Error ? error.message : 'Tool execution failed'
						}`,
					};
					toolResults.push(errorResult);

					// Send error result to UI
					if (onMessage) {
						onMessage({
							type: 'sub_agent_message',
							agentId: agent.id,
							agentName: agent.name,
							message: {
								type: 'tool_result',
								tool_call_id: toolCall.id,
								tool_name: toolCall.function.name,
								content: `Error: ${
									error instanceof Error
										? error.message
										: 'Tool execution failed'
								}`,
							} as any,
						});
					}
				}
			}

			// 将工具结果添加到对话
			messages.push(...toolResults);

			// Continue to next iteration if there were tool calls
			// The loop will continue until no more tool calls
		}

		// while (true) 结束后返回最终结果
		return {
			success: true,
			result: finalResponse,
			usage: totalUsage,
			injectedUserMessages:
				collectedInjectedMessages.length > 0
					? collectedInjectedMessages
					: undefined,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : 'Unknown error';

		return {
			success: false,
			result: '',
			error: errorMessage,
		};
	} finally {
		// 恢复主代理readFolders,避免子代理读取影响主会话状态
		setReadFolders(mainAgentReadFolders);
	}
}
