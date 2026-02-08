import {createStreamingAnthropicCompletion} from '../../api/anthropic.js';
import {createStreamingResponse} from '../../api/responses.js';
import {createStreamingGeminiCompletion} from '../../api/gemini.js';
import {createStreamingChatCompletion} from '../../api/chat.js';
import {getSubAgent} from '../config/subAgentConfig.js';
import {
	getAgentsPrompt,
	createSystemContext,
	getTaskCompletionPrompt,
} from '../agentsPromptUtils.js';
import {
	collectAllMCPTools,
	executeMCPTool,
	getUsefulInfoService,
	getTodoService,
} from './mcpToolsManager.js';
import {
	getModelSpecificPromptForConfig,
	getOpenAiConfig,
} from '../config/apiConfig.js';
import {sessionManager} from '../session/sessionManager.js';
import {unifiedHooksExecutor} from './unifiedHooksExecutor.js';
import {checkYoloPermission} from './yoloPermissionChecker.js';
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
	findInsertPositionAfterNthToolFromEnd,
	insertMessagesAtPosition,
} from '../message/messageUtils.js';

export interface SubAgentMessage {
	type: 'sub_agent_message';
	agentId: string;
	agentName: string;
	message: any; // 来自Anthropic API的流事件
}

export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	cacheCreationInputTokens?: number;
	cacheReadInputTokens?: number;
}

export interface SubAgentResult {
	success: boolean;
	result: string;
	error?: string;
	usage?: TokenUsage;
	/** User messages injected from the main session during sub-agent execution */
	injectedUserMessages?: string[];
}

export interface ToolConfirmationCallback {
	(toolName: string, toolArgs: any): Promise<ConfirmationResult>;
}

export interface ToolApprovalChecker {
	(toolName: string): boolean;
}

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

async function refreshSubAgentSpecialUserMessages(
	messages: ChatMessage[],
	sessionId: string | undefined,
	finalPrompt?: string,
): Promise<ChatMessage[]> {
	const baseMessages = stripSpecialUserMessages(messages);
	const specialUserMessages: ChatMessage[] = [];

	// finalPrompt 必须作为 specialUserMessage 注入,否则 stripSpecialUserMessages() 无法识别并移除它,
	// 会导致 while 循环每轮刷新时出现重复/顺序异常,也无法和 TODO/有用信息/文件夹笔记一起动态重排.
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

	const insertPosition = findInsertPositionAfterNthToolFromEnd(baseMessages, 3);
	const safeInsertPosition =
		baseMessages.length > 0 && baseMessages[0]?.role === 'system'
			? Math.max(1, insertPosition)
			: Math.max(0, insertPosition);
	return insertMessagesAtPosition(
		baseMessages,
		specialUserMessages,
		safeInsertPosition,
	);
}

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
 * @param getPendingMessages - 获取待处理用户消息队列的回调函数
 * @param clearPendingMessages - 清空待处理用户消息队列的回调函数
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
): Promise<SubAgentResult> {
	// 保存主代理readFolders状态，子代理以空的readFolders状态开始
	const mainAgentReadFolders = getReadFolders();
	clearReadFolders();

	try {
		// 处理内置代理（硬编码或用户复制的版本）
		let agent: any;

		// 首先检查用户是否有内置代理的自定义副本
		if (
			agentId === 'agent_reviewer' ||
			agentId === 'agent_explore' ||
			agentId === 'agent_general' ||
			agentId === 'agent_todo_progress_useful_info_admin'
		) {
			// 直接检查用户代理（不通过 getSubAgent，因为它可能返回内置代理）
			const {getUserSubAgents} = await import('../config/subAgentConfig.js');
			const userAgents = getUserSubAgents();
			const userAgent = userAgents.find(a => a.id === agentId);
			if (userAgent) {
				// 用户已自定义此内置代理，使用用户的版本
				agent = userAgent;
			}
		}

		// 如果未找到用户副本，使用内置定义
		if (!agent && agentId === 'agent_reviewer') {
			agent = {
				id: 'agent_reviewer',
				name: 'reviewer',
				description:
					'负责专门审查的子Agent.提供:用户需求,编辑范围,其他要求;产出:审核报告.每次你修改文件,或其他子Agent修改文件后,都MUST发布任务给此Agent审核',
				role: `你是审核子Agent
专门负责在对指定范围的文件进行严格的质量和一致性审查,对范围内的文件进行细致入微的审计,确保交付的实现不仅完美实现需求,而且结构清晰、模块化、易于维护,并完全符合项目规范和最佳实践.
# 注意事项
务必审核注释,已知编码者会在写代码时会习惯写一些冗余注释来解释自己当时的行为(eg: 新增xxx,移除xxx,依据xxx等)MUST提出让其修改.检查所有公开的类,方法和字段MUST符合规范的文档注释.内联注释MUST言简意赅,解释"为什么"这么做,而不是简单重复代码"做了什么".MUST 拒绝无意义的废话注释或开发日志式注释!
笔记中会记录本项目的蓝图和架构规范等,务必审核是否符合项目蓝图和架构规范,若发现不符合则MUST提出修改建议!
根据项目要求,运行代码质量检测,构建和测试等命令
MUST 中文注释
你无法也MUST NOT编辑文件,故MUST只读并最终给出审核报告.
MUST NOT 任何假设.每一条审核报告都MUST有项目中文档和项目代码为依据,要先在项目中搜索调查清楚!
请务必遵循**模块化**原则, 将功能拆分到合适的模块和文件中, **避免创建或修改出过大的文件**!如果发现哪个文件过大且可拆分或重构,则MUST提出修改建议.
最终给出审核报告.`,
				tools: [
					'filesystem-read',
					'ace-find_definition',
					'ace-find_references',
					'ace-semantic_search',
					'ace-text_search',
					'ace-file_outline',
					'terminal-execute',
					'todo-get',
					'todo-update',
					'ide-get_diagnostics',
					'useful-info-add',
					'askuser-ask_question',
					'useful-info-delete',
					'skill-execute',
					'context_engine-codebase-retrieval',
				],
			};
		} else if (!agent && agentId === 'agent_explore') {
			agent = {
				id: 'agent_explore',
				name: 'Explore Agent',
				description:
					'专门快速探索和理解代码库的子Agent.擅长网络搜索,搜索代码、查找定义、分析代码结构和依赖关系.当需要调研,搜索某目标时,MUST发布任务给此子Agent.可将研究目标细分,并行调用多个探索子代理,每个子代理专注一个方向,比如,一个专门调研文档,一个专门调研代码等.',
				role: `你是一个专门的代码探索子Agent.你的任务是根据给你的实际需求,定位特定代码并分析依赖关系.使用搜索和分析工具来探索代码,必要时可进行网络搜索.专注于代码发现和理解.
注意一旦项目根路径中有\`DevDocs\`文件夹,MUST从中找于本次任务相关的文档.
MUST并行调用\`useful-info-add\`工具记录你发现的有用信息!!!若发现无用或过时的有用信息记录,则MUST使用\`useful-info-delete\`工具删除!
你不可也无法编辑文件.你MUST将重点聚焦于寻找,而非分析或执行,MUST不带任何偏见和主观,如实客观的记录和反馈你探索到的信息和信息来源!
最终回复探索报告.`,
				tools: [
					'filesystem-read',
					'ace-text_search',
					'ace-file_outline',
					'websearch-search',
					'websearch-fetch',
					'todo-get',
					'todo-update',
					'useful-info-delete',
					'askuser-ask_question',
					'terminal-execute',
					'useful-info-add',
					'skill-execute',
					'context_engine-codebase-retrieval',
				],
			};
		} else if (!agent && agentId === 'agent_general') {
			agent = {
				id: 'agent_general',
				name: 'General Purpose Agent',
				description:
					'通用任务执行子Agent.可修改文件和执行命令.最适合需要实际操作的多步骤任务.当有需要实际执行的任务,发布给此Agent.MUST现将任务拆分成小任务发布,让此Agent每次只专注执行一个具体小任务.',
				role: `你是一个通用任务执行子Agent.你可以执行各种复杂的多步骤任务,包括搜索代码、修改文件、执行命令等.在接到任务时,应系统性地将其分解并执行,并应根据需要选择合适的工具以高效完成任务.你MUSY只专注于分配给你的任务和工作范围,若私自涉及其他任务将追究你的责任!
### 有用信息
- MUST 并行调用,找到的对本次任务有用的信息,MUST使用有用信息工具添加
- 每次修改文件后,MUST并行使用\`useful-info-xx\`工具更新有用信息,同步给其他Agent.
**搜索替换工具**:搜索块和替换块尽量多提供上下文,以作为辅助锚点更好的定位修改区域,比如,只修改一行,但上下各提供5-10行的上下文.
**确保你编写的所有代码无报错后,再发布任务完成信息!**
你要自行验证你所做的修改是否完成了分配给你的任务,确认无误后你可更新todo,标记任务完成.`,
				tools: [
					'filesystem-read',
					'filesystem-create',
					'filesystem-edit_search',
					'filesystem-undo',
					'terminal-execute',
					'ace-text_search',
					'ide-get_diagnostics',
					'todo-get',
					'todo-update',
					'useful-info-add',
					'useful-info-delete',
					'askuser-ask_question',
					'ace-file_outline',
					'skill-execute',
					'context_engine-codebase-retrieval',
				],
			};
		} else if (!agent && agentId === 'agent_todo_progress_useful_info_admin') {
			agent = {
				id: 'agent_todo_progress_useful_info_admin',
				name: 'Todo progress and Useful_info Administrator',
				description:
					'todo进度和 useful_info 管理子Agent,随着任务的进行或中断等,todo和有用信息都会变得混乱,此子Agent负责清理和整理.当任务进度需要明确,todo需要整理,有用信息需要清理时,MUST发布任务给此子Agent.',
				role: `你是负责清理和整理todo和有用信息的子Agent.
首先,你要根据需求,MUST在项目中探索,查看git差异等手段,分析目前任务进度,理清哪些todo已完成,哪些todo未完成.
再使用todo管理工具,删掉已完成的详细子todo
确保todo:1.清晰展示任务现状2.确保有详细步骤指导将来开发3.父todo尽量保留,以便简洁体现任务整体进度4.未实际完成的子任务不要删
最后使用useful-info系列工具,合并整合有用信息,删除对任务无用的,冗余的有用信息,确保有用信息可以精准指导开发,但又不会冗余.`,
				tools: [
					'filesystem-read',
					'ace-find_definition',
					'ace-find_references',
					'ace-semantic_search',
					'ace-text_search',
					'ace-file_outline',
					'terminal-execute',
					'todo-get',
					'todo-update',
					'todo-add',
					'todo-delete',
					'useful-info-add',
					'useful-info-delete',
					'useful-info-list',
					'askuser-ask_question',
					'skill-execute',
					'context_engine-codebase-retrieval',
				],
			};
		} else {
			// 获取用户配置的子代理
			agent = getSubAgent(agentId);
			if (!agent) {
				return {
					success: false,
					result: '',
					error: `Sub-agent with ID "${agentId}" not found`,
				};
			}
		}

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

			return agent.tools.some((allowedTool: string) => {
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
		const taskCompletionPrompt = getTaskCompletionPrompt();
		if (taskCompletionPrompt) {
			finalPrompt = finalPrompt
				? `${finalPrompt}\n\n${taskCompletionPrompt}`
				: taskCompletionPrompt;
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
		// Track all user messages injected from the main session
		const collectedInjectedMessages: string[] = [];

		// 此子代理执行的本地会话批准工具列表
		// 确保执行期间批准的工具立即被识别
		const sessionApprovedTools = new Set<string>();

		// 子代理内部空回复重试计数器
		let emptyResponseRetryCount = 0;
		const maxEmptyResponseRetries = 3; // 最多重试3次

		// eslint-disable-next-line no-constant-condition
		while (true) {
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
				const {runningSubAgentTracker} = await import(
					'./runningSubAgentTracker.js'
				);
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
			}

			const currentSession = sessionManager.getCurrentSession();
			messages = await refreshSubAgentSpecialUserMessages(
				messages,
				currentSession?.id,
				finalPrompt,
			);

			// 重试回调函数 - 为子智能体提供流中断重试支持
			const onRetry = (error: Error, attempt: number, nextDelay: number) => {
				console.log(
					`🔄 子智能体 ${
						agent.name
					} 重试 (${attempt}/${5}): ${error.message.substring(0, 100)}...`,
				);
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
				// Forward message to UI (but don't save to main conversation)
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
			// 没有工具调用时,执行 onSubAgentComplete 钩子（在子代理任务完成前）
			if (toolCalls.length === 0) {
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
								if (result.response.ask === 'ai' && result.response.continue) {
									// 发送给 AI 继续处理
									const promptMessage: ChatMessage = {
										role: 'user',
										content: result.response.message,
									};
									messages.push(promptMessage);
									shouldContinue = true;

									// 向 UI 显示钩子消息，告知用户子代理继续执行
									if (onMessage) {
										console.log(`Hook: ${result.response.message}`);
									}
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
				} catch (error) {
					console.error('onSubAgentComplete hook execution failed:', error);
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
				} catch (error) {
					console.error('Failed to parse askuser tool arguments:', error);
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
					const result = await executeMCPTool(
						toolCall.function.name,
						args,
						abortSignal,
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
		// 移除空回复错误处理，因为现在由子代理内部处理
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
