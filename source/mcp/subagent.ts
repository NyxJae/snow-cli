import {executeSubAgent} from '../utils/execution/subAgentExecutor.js';
import {getUserSubAgents} from '../utils/config/subAgentConfig.js';
import type {SubAgentMessage} from '../utils/execution/subAgentExecutor.js';
import type {ToolCall} from '../utils/execution/toolExecutor.js';
import type {ConfirmationResult} from '../ui/components/tools/ToolConfirmation.js';

export interface PendingMessage {
	text: string;
	images?: Array<{data: string; mimeType: string}>;
}

export interface SubAgentToolExecutionOptions {
	agentId: string;
	prompt: string;
	onMessage?: (message: SubAgentMessage) => void;
	abortSignal?: AbortSignal;
	requestToolConfirmation?: (
		toolCall: ToolCall,
		batchToolNames?: string,
		allTools?: ToolCall[],
	) => Promise<ConfirmationResult>;
	isToolAutoApproved?: (toolName: string) => boolean;
	yoloMode?: boolean;
	addToAlwaysApproved?: (toolName: string) => void;
	requestUserQuestion?: (
		question: string,
		options: string[],
		multiSelect?: boolean,
	) => Promise<{selected: string | string[]; customInput?: string}>;
	getPendingMessages?: () => PendingMessage[];
	clearPendingMessages?: () => void;
}

/**
 * Sub-Agent MCP Service
 * Provides tools for executing sub-agents with their own specialized system prompts and tool access
 */
export class SubAgentService {
	/**
	 * Execute a sub-agent as a tool
	 */
	async execute(options: SubAgentToolExecutionOptions): Promise<any> {
		const {
			agentId,
			prompt,
			onMessage,
			abortSignal,
			requestToolConfirmation,
			isToolAutoApproved,
			yoloMode,
			addToAlwaysApproved,
			requestUserQuestion,
			getPendingMessages,
			clearPendingMessages,
		} = options;

		// Create a tool confirmation adapter for sub-agent if needed
		const subAgentToolConfirmation = requestToolConfirmation
			? async (toolName: string, toolArgs: any) => {
					// Create a fake tool call for confirmation
					const fakeToolCall: ToolCall = {
						id: 'subagent-tool',
						type: 'function',
						function: {
							name: toolName,
							arguments: JSON.stringify(toolArgs),
						},
					};
					return await requestToolConfirmation(fakeToolCall);
			  }
			: undefined;

		const result = await executeSubAgent(
			agentId,
			prompt,
			onMessage,
			abortSignal,
			subAgentToolConfirmation,
			isToolAutoApproved,
			yoloMode,
			addToAlwaysApproved,
			requestUserQuestion,
			getPendingMessages,
			clearPendingMessages,
		);

		if (!result.success) {
			throw new Error(result.error || 'Sub-agent execution failed');
		}

		return {
			success: true,
			result: result.result,
			usage: result.usage,
		};
	}

	/**
	 * Get all available sub-agents as MCP tools
	 */
	getTools(): Array<{
		name: string;
		description: string;
		inputSchema: any;
	}> {
		// Get user-configured agents (built-in agents are hardcoded below)
		const userAgents = getUserSubAgents();
		const userAgentMap = new Map(userAgents.map(agent => [agent.id, agent]));

		// Built-in agents (hardcoded, always available)
		const tools = [
			{
				name: 'agent_reviewer',
				description:
					'reviewer: 负责专门审查的子Agent.提供:用户需求,编辑范围,其他要求;产出:审核报告.每次你修改文件,或其他子Agent修改文件后,都MUST发布任务给此Agent审核',
				inputSchema: {
					type: 'object',
					properties: {
						prompt: {
							type: 'string',
							description:
								'CRITICAL: Provide COMPLETE context from main session. Sub-agent has NO access to main conversation history. Include: (1) Full task description with business requirements, (2) Known file locations and code paths, (3) Relevant code snippets or patterns already discovered, (4) Any constraints or important context. Example: "Review changes in src/api/users.ts, focus on error handling and validate outputs against requirements."',
						},
					},
					required: ['prompt'],
				},
			},
			{
				name: 'agent_explore',
				description:
					'Explore Agent: 专门快速探索和理解代码库的子Agent.擅长网络搜索,搜索代码、查找定义、分析代码结构和依赖关系.当需要调研,搜索某目标时,MUST发布任务给此子Agent.可将研究目标细分,并行调用多个探索子代理,每个子代理专注一个方向,比如,一个专门调研文档,一个专门调研代码等.',
				inputSchema: {
					type: 'object',
					properties: {
						prompt: {
							type: 'string',
							description:
								'CRITICAL: Provide COMPLETE context from main session. Sub-agent has NO access to main conversation history. Include: (1) Full task description with business requirements, (2) Known file locations and code paths, (3) Relevant code snippets or patterns already discovered, (4) Any constraints or important context. Example: "Explore authentication implementation. Main flow uses OAuth in src/auth/oauth.ts, need to find all related error handling. User mentioned JWT tokens are validated in middleware."',
						},
					},
					required: ['prompt'],
				},
			},
			{
				name: 'agent_general',
				description:
					'General Purpose Agent: 通用任务执行子Agent.可修改文件和执行命令.最适合需要实际操作的多步骤任务.当有需要实际执行的任务,发布给此Agent.MUST现将任务拆分成小任务发布,让此Agent每次只专注执行一个具体小任务.',
				inputSchema: {
					type: 'object',
					properties: {
						prompt: {
							type: 'string',
							description:
								'CRITICAL: Provide COMPLETE context from main session. Sub-agent has NO access to main conversation history. Include: (1) Full task description with step-by-step requirements, (2) Exact file paths and locations to modify, (3) Code patterns/snippets to follow or replicate, (4) Dependencies between files/changes, (5) Testing/verification requirements, (6) Any business logic or constraints discovered in main session. Example: "Update error handling across API. Files: src/api/users.ts, src/api/posts.ts, src/api/comments.ts. Replace old pattern try-catch with new ErrorHandler class from src/utils/errorHandler.ts. Must preserve existing error codes. Run npm test after changes."',
						},
					},
					required: ['prompt'],
				},
			},
			{
				name: 'agent_todo_progress_useful_info_admin',
				description:
					'Todo progress and Useful_info Administrator: todo进度和 useful_info 管理子Agent,随着任务的进行或中断等,todo和有用信息都会变得混乱,此子Agent负责清理和整理.当任务进度需要明确,todo需要整理,有用信息需要清理时,MUST发布任务给此子Agent.',
				inputSchema: {
					type: 'object',
					properties: {
						prompt: {
							type: 'string',
							description:
								'CRITICAL: Provide COMPLETE context from main session. Sub-agent has NO access to main conversation history. Include: (1) Task progress details and objectives, (2) Known file locations and code structure, (3) TODO states and useful-info state, (4) Dependencies and relationships. Example: "整理当前TODO和useful-info,删除已完成项,保留未完成任务."',
						},
					},
					required: ['prompt'],
				},
			},
		];

		// Built-in agent IDs (used to filter out duplicates)
		const builtInAgentIds = new Set([
			'agent_reviewer',
			'agent_explore',
			'agent_general',
			'agent_todo_progress_useful_info_admin',
		]);

		for (const tool of tools) {
			const userAgent = userAgentMap.get(tool.name);
			if (userAgent && userAgent.name && userAgent.description) {
				tool.description = `${userAgent.name}: ${userAgent.description}`;
			}
		}

		// Add user-configured agents (filter out duplicates with built-in)
		tools.push(
			...userAgents
				.filter(agent => !builtInAgentIds.has(agent.id))
				.map(agent => ({
					name: agent.id,
					description: `${agent.name}: ${agent.description}`,
					inputSchema: {
						type: 'object',
						properties: {
							prompt: {
								type: 'string',
								description:
									'CRITICAL: Provide COMPLETE context from main session. Sub-agent has NO access to main conversation history. Include all relevant: (1) Task requirements and objectives, (2) Known file locations and code structure, (3) Business logic and constraints, (4) Code patterns or examples, (5) Dependencies and relationships. Be specific and comprehensive - sub-agent cannot ask for clarification from main session.',
							},
						},
						required: ['prompt'],
					},
				})),
		);

		return tools;
	}
}

// Export a default instance
export const subAgentService = new SubAgentService();

// MCP Tool definitions (dynamically generated from configuration)
// Note: These are generated at runtime, so we export a function instead of a constant
export function getMCPTools(): Array<{
	name: string;
	description: string;
	inputSchema: any;
}> {
	return subAgentService.getTools();
}
