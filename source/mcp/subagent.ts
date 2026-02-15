import {executeSubAgent} from '../utils/execution/subAgentExecutor.js';
import {getUserSubAgents} from '../utils/config/subAgentConfig.js';
import {BUILTIN_AGENTS} from '../utils/config/builtinSubAgents.js';
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
	/** Unique execution instance ID for message injection from the main flow */
	instanceId?: string;
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
			instanceId,
			onMessage,
			abortSignal,
			requestToolConfirmation,
			isToolAutoApproved,
			yoloMode,
			addToAlwaysApproved,
			requestUserQuestion,
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
			instanceId,
		);

		if (!result.success) {
			throw new Error(result.error || 'Sub-agent execution failed');
		}

		return {
			success: true,
			result: result.result,
			usage: result.usage,
			injectedUserMessages: result.injectedUserMessages,
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
		const userAgents = getUserSubAgents();
		const userAgentMap = new Map(userAgents.map(agent => [agent.id, agent]));

		const promptInputSchema = {
			type: 'object',
			properties: {
				prompt: {
					type: 'string',
					description:
						'CRITICAL: Provide COMPLETE context from main session. Sub-agent has NO access to main conversation history. Include all relevant: (1) Task requirements and objectives, (2) Known file locations and code structure, (3) Business logic and constraints, (4) Code patterns or examples, (5) Dependencies and relationships. Be specific and comprehensive - sub-agent cannot ask for clarification from main session.',
				},
			},
			required: ['prompt'],
		};

		const tools = BUILTIN_AGENTS.map(agent => ({
			name: agent.id,
			description: `${agent.name}: ${agent.description}`,
			inputSchema: promptInputSchema,
		}));

		for (const tool of tools) {
			const userAgent = userAgentMap.get(tool.name);
			if (userAgent && userAgent.name && userAgent.description) {
				tool.description = `${userAgent.name}: ${userAgent.description}`;
			}
		}

		const builtInAgentIds = new Set(BUILTIN_AGENTS.map(agent => agent.id));
		tools.push(
			...userAgents
				.filter(agent => !builtInAgentIds.has(agent.id))
				.map(agent => ({
					name: agent.id,
					description: `${agent.name}: ${agent.description}`,
					inputSchema: promptInputSchema,
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
