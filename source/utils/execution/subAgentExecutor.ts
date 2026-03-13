import {createStreamingAnthropicCompletion} from '../../api/anthropic.js';
import {createStreamingResponse} from '../../api/responses.js';
import {createStreamingGeminiCompletion} from '../../api/gemini.js';
import {createStreamingChatCompletion} from '../../api/chat.js';
import {getSubAgent, getSubAgents} from '../config/subAgentConfig.js';
import {getAgentsPrompt, createSystemContext} from '../agentsPromptUtils.js';
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
import {connectionManager} from '../connection/ConnectionManager.js';
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
	isExactToolIdentifierMatch,
	shouldExposeToolInitially,
} from '../core/toolFilterUtils.js';
import {
	createToolSearchService,
	toolSearchService as globalToolSearchService,
} from './toolSearchService.js';
import {getToolSearchEnabled} from '../config/projectSettings.js';
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
	/** Internal stop/summarize instructions injected by the executor */
	terminationInstructions?: string[];
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
 * 最大 spawn 深度,用于限制递归 spawn 带来的资源消耗与死循环风险.
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
				error: `未找到ID为 \"${agentId}\" 的子代理`,
			};
		}

		// 获取子代理的可编辑文件后缀配置
		const editableFileSuffixes = agent.editableFileSuffixes;

		// 获取所有可用工具
		const allTools = await collectAllMCPTools();
		const configuredAllowedTools = agent.tools ?? [];

		// 根据子代理允许的工具进行严格精确匹配过滤.
		const allowedTools = allTools.filter((tool: MCPTool) =>
			isExactToolIdentifierMatch(tool.function.name, configuredAllowedTools),
		);

		// Tool Search registry 需要基于子代理自身 allowedTools 构建,并且每次子代理调用都必须
		// 使用独立实例,避免与主代理共享全局单例导致 registry 被覆盖.
		const useToolSearch = getToolSearchEnabled();
		const toolSearch = useToolSearch
			? createToolSearchService()
			: globalToolSearchService;

		// 子代理渐进式工具加载状态.
		// 注意: registry 的更新必须延后到协作工具注入后,确保协作工具也可被 tool_search 搜索到.
		let discoveredToolNames = new Set<string>();
		let initialTools: MCPTool[] = [];
		let activeTools: MCPTool[] = allowedTools;

		if (activeTools.length === 0) {
			return {
				success: false,
				result: '',
				error: `子代理 \"${agent.name}\" 未配置任何可用工具`,
			};
		}

		// 构建子代理的对话历史
		let messages: ChatMessage[] = [];

		// 检查是否配置了 subAgentRole（必需）
		if (!agent.subAgentRole) {
			return {
				success: false,
				result: '',
				error: `子代理 \"${agent.name}\" 缺少 subAgentRole 配置`,
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
					'向正在运行的其他子代理发送消息. 可用于共享信息,同步发现,或与并行执行的子代理协调工作. 该消息会注入目标子代理的上下文. 重要: 发送前建议先使用 query_agents_status 确认目标子代理仍在运行.',
				parameters: {
					type: 'object',
					properties: {
						target_agent_id: {
							type: 'string',
							description:
								'目标子代理的 agentId(类型). 如果同一类型存在多个运行实例,将默认发送给第一个匹配到的实例.',
						},
						target_instance_id: {
							type: 'string',
							description:
								'(可选) 目标子代理的 instanceId. 当同一类型存在多个运行实例时,可用于精确指定发送对象.',
						},
						message: {
							type: 'string',
							description:
								'要发送给目标子代理的消息内容. 请尽量清晰,具体地说明你共享的信息或希望对方执行的动作.',
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
					'查询所有正在运行的子代理状态. 返回当前活跃子代理列表(包含ID,名称,prompt,以及运行时长). 可用于在发送消息前确认目标子代理仍在运行,或发现新启动的子代理.',
				parameters: {
					type: 'object',
					properties: {},
					required: [],
				},
			},
		};

		// 动态构建可 spawn 的子代理列表(运行态兜底清理无效 id,并排除自身)
		const allSubAgents = getSubAgents();
		const allowedSubAgentIds = agent.availableSubAgents;

		// 运行态计算 effectiveSpawnableAgents:
		// - allowedSubAgentIds 为 undefined 或 [] => 等价于没有任何可 spawn 的子代理
		// - 清理不存在的 id(仅保留 getSubAgents() 返回的子代理)
		// - 排除自身 id
		const effectiveSpawnableAgents = (() => {
			if (
				!Array.isArray(allowedSubAgentIds) ||
				allowedSubAgentIds.length === 0
			) {
				return [];
			}

			const allowedIdSet = new Set(allowedSubAgentIds);
			return allSubAgents
				.filter(a => a.id !== agent.id)
				.filter(a => allowedIdSet.has(a.id));
		})();

		const canSpawn =
			spawnDepth < MAX_SPAWN_DEPTH && effectiveSpawnableAgents.length > 0;

		if (
			isExactToolIdentifierMatch(
				sendMessageTool.function.name,
				configuredAllowedTools,
			)
		) {
			allowedTools.push(sendMessageTool);
		}
		if (
			isExactToolIdentifierMatch(
				queryAgentsStatusTool.function.name,
				configuredAllowedTools,
			)
		) {
			allowedTools.push(queryAgentsStatusTool);
		}

		if (
			canSpawn &&
			isExactToolIdentifierMatch('spawn_sub_agent', configuredAllowedTools)
		) {
			// 构建 spawn_sub_agent 工具(仅当 canSpawn 时才注入)
			const agentDescriptions = effectiveSpawnableAgents
				.map(a => `- **${a.id}**: ${a.name} — ${a.description}`)
				.join('\n');

			const agentIdList = effectiveSpawnableAgents.map(a => a.id).join(', ');

			const spawnSubAgentTool: MCPTool = {
				type: 'function' as const,
				function: {
					name: 'spawn_sub_agent',
					description: `创建一个全新的,且与自己类型不同的子代理,以获得更专业的帮助. 被创建的子代理会与当前流程并行运行,并在完成后自动回传结果.

**什么时候用**: 只有在你确实需要不同子代理的专长时才创建.

**什么时候不要用**: 不要用创建子代理来甩锅自己的工作:
- 绝对不要创建和自己同类型的子代理来替你完成任务,这既懒惰又浪费资源
- 如果你自己能做,不要为了"拆分工作"而创建子代理
- 不要因为卡住就创建子代理,请先更努力地尝试,或者直接问用户
- 如果你有足够工具完成任务,请自己完成

**你可以创建的子代理列表**:
${agentDescriptions}`,
					parameters: {
						type: 'object',
						properties: {
							agent_id: {
								type: 'string',
								description: `要创建的子代理 ID. 必须与自身类型不同. 可选: ${agentIdList}.`,
							},
							prompt: {
								type: 'string',
								description:
									'关键: 子代理的任务描述. 子代理无法访问你的历史对话,因此这里必须包含完整上下文,包括相关文件路径,已发现信息,约束与验收标准.',
							},
						},
						required: ['agent_id', 'prompt'],
					},
				},
			};

			allowedTools.push(spawnSubAgentTool);
		}

		// Tool Search:协作工具注入完成后,再用最终 allowedTools 构建 registry 并计算首轮 activeTools.
		if (useToolSearch) {
			toolSearch.updateRegistry(allowedTools);
			initialTools = allowedTools.filter(tool =>
				shouldExposeToolInitially(tool.function.name),
			);
			activeTools = toolSearch.buildActiveTools({
				discoveredToolNames,
				initialTools,
			});
		}

		// 构建并行子代理协作上下文
		const otherAgents = runningSubAgentTracker
			.getRunningAgents()
			.filter(a => a.instanceId !== instanceId);

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
				? ',或使用 `spawn_sub_agent` 创建不同类型的子代理以获得更专业的帮助'
				: '';
			const spawnAdvice = canSpawn
				? '\n\n**创建规则**: 仅在你确实需要其他类型子代理专长,且自己工具无法完成时再创建. 优先完成自己的工作,不要把自己该做的事转交出去.'
				: '';
			collaborationContext = `\n\n## 当前并行运行的其他子代理
以下子代理正在与你并行运行. 你可以使用 \`query_agents_status\` 获取实时状态,使用 \`send_message_to_agent\` 与其沟通${spawnHint}.

${agentList}

如果你发现对其他子代理有帮助的信息,请主动分享.${spawnAdvice}`;
		} else {
			const spawnToolLine = canSpawn
				? '\n- `spawn_sub_agent`: 创建不同类型的子代理以获得更专业的帮助(不要创建自己的同类型来甩锅)'
				: '';
			const spawnUsage = canSpawn
				? '\n\n**创建规则**: 仅在你确实需要不同专长的帮助时才使用 `spawn_sub_agent`. 不要用它来转交自己的任务,也不要为了"并行拆分"而滥用.'
				: '';
			collaborationContext = `\n\n## 子代理协作工具
你可以使用以下协作工具:
- \`query_agents_status\`: 查看当前有哪些子代理正在运行
- \`send_message_to_agent\`: 向正在运行的子代理发送消息(建议先查状态)${spawnToolLine}${spawnUsage}`;
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

		// 5. 注入并行协作上下文
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
		// 记录: 主会话注入到本子代理的用户消息.
		// 这样做的目的不是为了"多存一份",而是为了在最终结果里明确展示主会话对该子代理的追问/补充,
		// 便于主代理汇总与排查并行场景下的信息流.
		const collectedInjectedMessages: string[] = [];
		// 记录: 执行器注入到子代理对话中的内部终止/总结指令.
		// 这些指令用于在工具被拒绝或需要强制停止时,把"为什么停止"稳定地传递给子代理,避免其继续调用工具.
		const collectedTerminationInstructions: string[] = [];

		// 记录: 由本子代理 spawn 出来的子代理 instanceId.
		// 这样做是为了避免父子代理之间出现"父已结束,子仍运行"的状态错乱,导致结果丢失或 UI 状态卡住.
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
					error: '子代理执行已中止',
				};
			}

			// 注入: 主流程在子代理运行期间,可能会把用户追加消息定向投递给某个子代理实例.
			// 这里每一轮循环都要先注入,原因是: 子代理是流式长运行任务,如果不及时注入,用户补充信息会延迟到任务结束才生效.
			if (instanceId) {
				const injectedMessages =
					runningSubAgentTracker.dequeueMessages(instanceId);
				for (const injectedMsg of injectedMessages) {
					// 记录到最终结果中,方便主代理做汇总与回放(否则信息只存在于子代理上下文里,主代理难以追溯).
					collectedInjectedMessages.push(injectedMsg);
					messages.push({
						role: 'user',
						content: `[User message from main session]\\n${injectedMsg}`,
					});

					// 通知 UI: 让用户在主界面看到这条"注入到子代理的消息",避免误以为消息丢失.
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

				// 注入: 其他并行子代理之间的互相消息(协作上下文).
				// 这样做是为了让子代理能感知其他子代理的进展,减少重复劳动,并支持"一个子代理发现线索,另一个立即利用"的并行协作.
				const interAgentMessages =
					runningSubAgentTracker.dequeueInterAgentMessages(instanceId);
				for (const iaMsg of interAgentMessages) {
					messages.push({
						role: 'user',
						content: `[Inter-agent message from ${iaMsg.fromAgentName} (${iaMsg.fromAgentId})]\\n${iaMsg.content}`,
					});

					// 通知 UI: 让用户知道子代理收到了来自其他子代理的消息,便于排查并行协作是否按预期进行.
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
								tools: activeTools,
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
								tools: activeTools,
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
								tools: activeTools,
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
								tools: activeTools,
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

				// 从流事件中捕获 usage.
				// 之所以在流中就处理,是为了让 UI 能在子代理仍处于运行态时实时展示上下文占用情况,避免等到 done 后才更新造成误判.
				if (event.type === 'usage' && event.usage) {
					const eventUsage = event.usage;
					// 使用 total_tokens(prompt + completion)来监控上下文窗口.
					// 选择 total_tokens 的原因是: completion_tokens 也会在下一轮被追加到 messages,从而真实占用后续输入窗口.
					// 仅看 prompt_tokens 容易低估下一轮的上下文压力.
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
						// 跨轮累加 usage,用于最终汇总(子代理可能需要多轮工具交互).
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

					// 在流式过程中就通知 UI 当前上下文占用(而不是等到 done).
					// 这样做是为了保证 UI 还有"正在运行"的子代理消息可供更新,避免 done 后 UI 找不到目标消息导致进度条不刷新.
					if (onMessage && config.maxContextTokens && latestTotalTokens > 0) {
						const ctxPct = getContextPercentage(
							latestTotalTokens,
							config.maxContextTokens,
						);
						// 用 Math.max(1, ...) 兜底,确保首次调用(小 prompt)也至少显示 1%,避免被四舍五入到 0% 导致 UI 直接隐藏进度条.
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
					// 记录 Responses API 的 reasoning 数据,用于多轮对话时保留思考上下文(避免下一轮丢失推理线索).
					currentReasoning = event.reasoning as typeof currentReasoning;
				} else if (event.type === 'done') {
					// 在 done 事件里抓取 thinking/reasoning,用于多轮对话时保留思考块(部分 provider 只在 done 里回传).
					if ('thinking' in event && event.thinking) {
						// Anthropic/Gemini 的 thinking block
						currentThinking = event.thinking as {
							type: 'thinking';
							thinking: string;
							signature?: string;
						};
					}
					if ('reasoning_content' in event && event.reasoning_content) {
						// Chat API(例如 DeepSeek R1) 的 reasoning_content
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

				// 保存 thinking/reasoning,用于多轮对话.
				// Anthropic/Gemini: thinking block(当启用 thinking 时,Anthropic 要求后续轮次继续携带).
				if (currentThinking) {
					assistantMessage.thinking = currentThinking;
				}
				// Chat API(例如 DeepSeek R1): reasoning_content
				if (currentReasoningContent) {
					(assistantMessage as any).reasoning_content = currentReasoningContent;
				}
				// Responses API: 带 encrypted_content 的 reasoning 数据
				if (currentReasoning) {
					(assistantMessage as any).reasoning = currentReasoning;
				}

				if (toolCalls.length > 0) {
					// tool_calls 在部分模式下可能包含 thought_signature(如 Gemini thinking).
					// 这里直接使用流中捕获的 toolCalls,避免自行重建时丢失签名字段.
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
				latestTotalTokens = countMessagesTokens(messages, activeTools);

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
					// 通知 UI: 子代理即将进行上下文压缩(避免用户误以为卡死).
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
							// 用压缩后的 messages 替换原数组,把空间让给后续工具调用与回答.
							messages.length = 0;
							messages.push(...compressionResult.messages);
							justCompressed = true;

							// 重置 latestTotalTokens 为压缩后的估算值,确保下一次 context_usage 反映压缩后的状态,避免 UI 继续显示高占用.
							if (compressionResult.afterTokensEstimate) {
								latestTotalTokens = compressionResult.afterTokensEstimate;
							}

							// 通知 UI: 上下文压缩完成,便于用户确认"刚才的卡顿"是压缩导致而非异常.
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
						// 压缩失败时先继续流程: 这轮请求可能仍能成功,但下一轮可能会因 context_length_exceeded 失败.
						// 这样做是为了避免压缩模块偶发失败就直接中断子代理,保持尽量"能跑就跑"的韧性.
					}
				}
			}

			// 压缩后的强制续跑:
			// 如果刚压缩完,模型却给出"最终回答"(没有 tool_calls),通常意味着它在压缩前的上下文压力下提前收尾了.
			// 因此这里会丢弃这条收尾消息,并注入一条系统指令要求继续工作,让子代理在更空的上下文中把任务做完.
			if (justCompressed && toolCalls.length === 0) {
				// 删除最后一条 assistant 消息(很可能是上下文压力下的提前结束).
				while (
					messages.length > 0 &&
					messages[messages.length - 1]?.role === 'assistant'
				) {
					messages.pop();
				}
				// 注入续跑指令,让子代理在压缩后的上下文里继续完成任务.
				messages.push({
					role: 'user',
					content:
						'[System] Your context has been auto-compressed to free up space. Your task is NOT finished. Continue working based on the compressed context above. Pick up where you left off.',
				});
				continue;
			}

			// 若没有 tool_calls,通常意味着子代理准备结束.
			// 但在结束前需要先检查是否仍有子子代理在运行,否则会出现"父已结束,子仍跑"导致结果丢失或主流程误判完成.
			if (toolCalls.length === 0) {
				// 等待已 spawn 的子代理完成后再结束.
				// 原因: 父代理提前结束会让主流程认为该工具调用已完成,从而错过子代理结果,甚至导致 UI 状态不同步.
				// 因此这里必须等子代理都收敛后,再决定是否真正结束.
				const runningChildren = Array.from(spawnedChildInstanceIds).filter(id =>
					runningSubAgentTracker.isRunning(id),
				);

				if (
					runningChildren.length > 0 ||
					runningSubAgentTracker.hasSpawnedResults()
				) {
					// 等待仍在运行的子代理完成(带超时,避免无限等待).
					if (runningChildren.length > 0) {
						await runningSubAgentTracker.waitForSpawnedAgents(
							300_000, // 5 min timeout
							abortSignal,
						);
					}

					// 取出已完成的子代理结果并注入为 user 上下文.
					// 这样做能让父代理基于子代理输出继续推理,并最终把所有并行结果合并为一个可交付的结论.
					const spawnedResults = runningSubAgentTracker.drainSpawnedResults();
					if (spawnedResults.length > 0) {
						for (const sr of spawnedResults) {
							const statusIcon = sr.success ? '✓' : '✗';
							const resultSummary = sr.success
								? sr.result.length > 800
									? sr.result.substring(0, 800) + '...'
									: sr.result
								: sr.error || '未知错误';

							messages.push({
								role: 'user',
								content: `[Spawned Sub-Agent Result] ${statusIcon} ${sr.agentName} (${sr.agentId})\nPrompt: ${sr.prompt}\n结果: ${resultSummary}`,
								// 说明: 这里保留英文标签 [Spawned Sub-Agent Result]/Prompt,因为它属于内部协议标识,可能被上游解析或用于日志检索. 仅将对用户可读的字段文案中文化.
							});

							// 通知 UI: 某个被 spawn 的子代理已完成,方便用户理解并行任务进度.
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

						// 不要 break,继续下一轮: 需要把子代理结果喂回模型,让它把信息融合进最终答复,避免只收集不使用.
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
							resultText = `消息已发送给 ${
								targetAgent?.agentName || targetInstanceId
							}`;
						} else {
							resultText = `错误: 目标子代理实例 \"${targetInstanceId}\" 未在运行`;
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
								resultText = `消息已发送给 ${targetAgent.agentName} (instance: ${targetAgent.instanceId})`;
							} else {
								resultText = `错误: 发送消息到 ${targetAgentId} 失败`;
							}
						} else if (targetAgent && targetAgent.instanceId === instanceId) {
							resultText = '错误: 不能给自己发送消息';
						} else {
							resultText = `错误: 未找到 ID 为 \"${targetAgentId}\" 的运行中子代理`;
						}
					} else {
						resultText =
							'错误: 必须提供 target_agent_id 或 target_instance_id 其中之一';
					}

					// 构造 tool_result,用于把协作工具的执行结果回填给模型.
					const toolResultMessage = {
						role: 'tool' as const,
						tool_call_id: sendMsgTool.id,
						content: JSON.stringify({success, result: resultText}),
					};
					messages.push(toolResultMessage);

					// 通知 UI: 已向其他子代理发送协作消息,便于用户理解协作是否按预期发生.
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

				// 已在此处消费 send_message_to_agent,从 toolCalls 中移除,避免重复执行.
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
								error: 'agent_id 和 prompt 都是必填项',
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
								error: `REJECTED: 你(${agent.name})尝试创建一个与自己同类型的子代理 \"${spawnAgentId}\". 这会浪费资源,并把你应该自己完成的工作转交给别人,因此不允许. 如果你确实需要不同专长的帮助,请创建其他类型的子代理. 如果该任务在你能力范围内,请自己完成.`,
							}),
						};
						messages.push(toolResultMessage);
						continue;
					}

					// 运行态兜底校验: spawn_sub_agent 的可用目标必须严格等于有效白名单,
					// 避免历史残留/手工编辑导致越权 spawn.
					const allowedSubAgentIds = agent.availableSubAgents;
					const effectiveAllowedSubAgentIds = (() => {
						if (
							!Array.isArray(allowedSubAgentIds) ||
							allowedSubAgentIds.length === 0
						) {
							return [] as string[];
						}
						const allowedIdSet = new Set(allowedSubAgentIds);
						return getSubAgents()
							.filter(a => a.id !== agent.id)
							.filter(a => allowedIdSet.has(a.id))
							.map(a => a.id);
					})();
					if (effectiveAllowedSubAgentIds.length === 0) {
						const toolResultMessage = {
							role: 'tool' as const,
							tool_call_id: spawnTool.id,
							content: JSON.stringify({
								success: false,
								error: 'REJECTED: 当前子代理没有任何可创建的子代理目标.',
							}),
						};
						messages.push(toolResultMessage);
						continue;
					}
					if (!effectiveAllowedSubAgentIds.includes(spawnAgentId)) {
						const toolResultMessage = {
							role: 'tool' as const,
							tool_call_id: spawnTool.id,
							content: JSON.stringify({
								success: false,
								error: `REJECTED: 子代理 \"${
									agent.name
								}\" 无权创建 \"${spawnAgentId}\". 允许的子代理范围: ${effectiveAllowedSubAgentIds.join(
									', ',
								)}`,
							}),
						};
						messages.push(toolResultMessage);
						continue;
					}

					// 解析要 spawn 的子代理展示名(优先读配置,否则回退到内置映射).
					let spawnAgentName = spawnAgentId;
					try {
						const agentConfig = getSubAgent(spawnAgentId);
						if (agentConfig) {
							spawnAgentName = agentConfig.name;
						}
					} catch {
						// 内置子代理不一定能通过 getSubAgent 解析到配置,这里用 ID->名称映射兜底,保证 UI 展示可读.
						const builtinNames: Record<string, string> = {
							agent_reviewer: 'reviewer',
							agent_explore: '探索代理',
							agent_general: '通用任务代理',
							agent_todo_progress_useful_info_admin:
								'TODO 与 useful-info 管理员',
							agent_architect: '架构师',
						};
						spawnAgentName = builtinNames[spawnAgentId] || spawnAgentId;
					}

					// 生成唯一 instanceId,用于跟踪该次 spawn 的子代理运行态与结果回收.
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

					// 返回 spawn_sub_agent 工具的即时结果(子代理已启动,将并行运行)
					const toolResultMessage = {
						role: 'tool' as const,
						tool_call_id: spawnTool.id,
						content: JSON.stringify({
							success: true,
							result: `已创建子代理 \"${spawnAgentName}\" (${spawnAgentId}),并在后台并行运行. instanceId: \"${spawnInstanceId}\". 该子代理完成后会自动把结果回传到主工作流.`,
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
			// askuser 交互是单资源,并发会导致漏弹窗或死锁,因此使用循环逐个串行处理
			while (true) {
				const askUserTool = toolCalls.find(tc =>
					tc.function.name.startsWith('askuser-'),
				);

				// 没有更多 askuser 工具,跳出循环
				if (!askUserTool || !requestUserQuestion) {
					break;
				}

				// 解析工具参数,失败时使用中文兜底文案(避免参数损坏导致 UI 空白)
				let question = '请选择一个选项:';
				let options: string[] = ['是', '否'];
				let multiSelect = true;

				try {
					const args = JSON.parse(askUserTool.function.arguments);
					if (args.question) question = args.question;
					if (args.options && Array.isArray(args.options)) {
						options = args.options;
					}
					if (args.multiSelect === true || args.multiSelect === false) {
						multiSelect = args.multiSelect;
					}
				} catch {
					// 参数解析失败时使用默认问题与选项继续流程.
				}

				// Notify server that user interaction is needed (only if connected)
				if (connectionManager.isConnected()) {
					await connectionManager.notifyUserInteractionNeeded(
						question,
						options,
						askUserTool.id,
						multiSelect,
					);
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

				// 移除已处理的 askuser 工具,继续处理下一个
				toolCalls = toolCalls.filter(tc => tc.id !== askUserTool.id);
			}

			// 如果所有工具都是 askuser 且已处理完毕,继续下一轮
			if (toolCalls.length === 0) {
				continue;
			}

			// 执行前检查工具批准
			const approvedToolCalls: typeof toolCalls = [];
			const rejectedToolCalls: typeof toolCalls = [];
			const rejectionReasons = new Map<string, string>(); // Map tool_call_id to rejection reason
			let shouldStopAfterRejection = false;
			let stopRejectedToolName: string | undefined;
			let stopRejectionReason: string | undefined;

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
						if (confirmation === 'reject') {
							shouldStopAfterRejection = true;
							stopRejectedToolName = toolName;
							stopRejectionReason = rejectionReasons.get(toolCall.id);
							break;
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
				const handledToolIds = new Set<string>([
					...approvedToolCalls.map(tc => tc.id),
					...rejectedToolCalls.map(tc => tc.id),
				]);
				const cancelledToolCalls = shouldStopAfterRejection
					? toolCalls.filter(tc => !handledToolIds.has(tc.id))
					: [];
				const abortedApprovedToolCalls = shouldStopAfterRejection
					? [...approvedToolCalls]
					: [];

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
								rejection_reason: rejectionReason,
							} as any,
						});
					}
				}

				if (shouldStopAfterRejection) {
					const cancelledMessage = stopRejectedToolName
						? `工具执行已取消,原因: 用户拒绝了工具 \\\"${stopRejectedToolName}\\\" 并要求停止子代理`
						: '工具执行已取消,原因: 用户要求停止子代理';

					for (const toolCall of [
						...abortedApprovedToolCalls,
						...cancelledToolCalls,
					]) {
						const toolResultMessage = {
							role: 'tool' as const,
							tool_call_id: toolCall.id,
							content: `Error: ${cancelledMessage}`,
						};
						rejectionResults.push(toolResultMessage);

						if (onMessage) {
							onMessage({
								type: 'sub_agent_message',
								agentId: agent.id,
								agentName: agent.name,
								message: {
									type: 'tool_result',
									tool_call_id: toolCall.id,
									tool_name: toolCall.function.name,
									content: `Error: ${cancelledMessage}`,
								} as any,
							});
						}
					}
				}

				// Add rejection/cancellation results to conversation
				messages.push(...rejectionResults);

				if (shouldStopAfterRejection) {
					const stopInstructionLines = [
						`[System] 用户拒绝了你运行工具 \"${
							stopRejectedToolName || 'unknown tool'
						}\" 的请求,并要求你停止.`,
						stopRejectionReason
							? `[System] 拒绝原因: ${stopRejectionReason}`
							: undefined,
						'[System] 不要再调用任何工具.',
						'[System] 请仅基于当前对话中已经存在的信息,给出你已知内容的最终总结. 同时明确说明由于工具被拒绝导致缺失的关键信息,然后结束你的工作.',
					].filter(Boolean);
					const stopInstruction = stopInstructionLines.join('\\n');
					collectedTerminationInstructions.push(stopInstruction);
					messages.push({
						role: 'user',
						content: stopInstruction,
					});
					continue;
				}

				// If all tools were rejected and there are no approved tools, continue to next AI turn
				if (approvedToolCalls.length === 0) {
					continue;
				}

				// 否则继续执行已批准的工具调用.
			}

			// 执行已批准的 tool calls.
			const toolResults: ChatMessage[] = [];
			for (const toolCall of approvedToolCalls) {
				// Progressive tool loading:当 tool_search 被调用时,将匹配到的工具加入 discoveredToolNames,
				// 并在下一轮请求时通过 buildActiveTools 扩展 activeTools.
				if (useToolSearch && toolCall.function.name === 'tool_search') {
					try {
						const searchArgs = JSON.parse(toolCall.function.arguments || '{}');
						const {matchedToolNames, textResult} = toolSearch.search(
							searchArgs.query || '',
							searchArgs.maxResults,
						);
						for (const name of matchedToolNames) {
							if (!discoveredToolNames.has(name)) {
								discoveredToolNames.add(name);
							}
						}
						// 将 tool_search 的文本结果写回对话,并跳过 executeMCPTool.
						const toolResult = {
							role: 'tool' as const,
							tool_call_id: toolCall.id,
							content: JSON.stringify(textResult),
						};
						toolResults.push(toolResult);
						if (onMessage) {
							onMessage({
								type: 'sub_agent_message',
								agentId: agent.id,
								agentName: agent.name,
								message: {
									type: 'tool_result',
									tool_call_id: toolCall.id,
									tool_name: toolCall.function.name,
									content: JSON.stringify(textResult),
								} as any,
							});
						}
						continue;
					} catch {
						// 解析失败则回退到正常执行路径.
					}
				}
				// 执行每个工具前检查中止信号
				if (abortSignal?.aborted) {
					// 工具执行阶段中止时,需要显式发送 done,避免 UI 仍认为子代理在运行.
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
						error: '子代理执行在工具运行期间被中止',
					};
				}

				try {
					const args = JSON.parse(toolCall.function.arguments);
					// 构建执行上下文，传递子代理的可编辑文件后缀配置
					const executionContext: MCPExecutionContext = {
						editableFileSuffixes,
						skipToolHooks: false,
						toolSearchService: toolSearch,
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

			// Progressive tool loading:在进入下一轮请求前,根据已发现工具重建 activeTools.
			if (useToolSearch) {
				activeTools = toolSearch.buildActiveTools({
					discoveredToolNames,
					initialTools,
				});
			}

			// 若本轮触发了工具调用,则继续下一轮对话.
			// 为什么不在这里 break:
			// - 工具结果需要被追加到 messages,再交给模型决定后续是否继续调用工具或输出最终答复.
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
			terminationInstructions:
				collectedTerminationInstructions.length > 0
					? collectedTerminationInstructions
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
