import {existsSync, readFileSync, writeFileSync, mkdirSync} from 'fs';
import {join} from 'path';
import {homedir} from 'os';

export interface SubAgent {
	id: string;
	name: string;
	description: string;
	role?: string;
	tools: string[];
	createdAt: string;
	updatedAt: string;
	builtin?: boolean; // Mark if this is a built-in agent
}

export interface SubAgentsConfig {
	agents: SubAgent[];
}

const CONFIG_DIR = join(homedir(), '.snow');
const SUB_AGENTS_CONFIG_FILE = join(CONFIG_DIR, 'sub-agents.json');

/**
 * Built-in sub-agents (hardcoded, always available)
 */
const BUILTIN_AGENTS: SubAgent[] = [
	{
		id: 'agent_explore',
		name: 'Explore Agent',
		description:
			'Specialized for quickly exploring and understanding codebases. Excels at searching code, finding definitions, analyzing code structure and dependencies. Read-only operations.',
		role: 'You are a specialized code exploration agent. Your task is to help users understand codebase structure, locate specific code, and analyze dependencies. Use search and analysis tools to explore code, but do not modify any files or execute commands. Focus on code discovery and understanding.',
		tools: [
			'filesystem-read',
			'ace-find_definition',
			'ace-find_references',
			'ace-semantic_search',
			'ace-text_search',
			'ace-file_outline',
			'codebase-search',
			'websearch-search',
			'websearch-fetch',
		],
		createdAt: '2024-01-01T00:00:00.000Z',
		updatedAt: '2024-01-01T00:00:00.000Z',
		builtin: true,
	},
	{
		id: 'agent_plan',
		name: 'Plan Agent',
		description:
			'Specialized for planning complex tasks. Analyzes requirements, explores code, identifies relevant files, and creates detailed implementation plans. Read-only operations.',
		role: 'You are a specialized task planning agent. Your task is to analyze user requirements, explore existing codebase, identify relevant files and dependencies, and then create detailed implementation plans. Use search and analysis tools to gather information, check diagnostics to understand current state, but do not execute actual modifications. Output clear step-by-step plans including files to modify, suggested implementation approaches, and important considerations.',
		tools: [
			'filesystem-read',
			'ace-find_definition',
			'ace-find_references',
			'ace-semantic_search',
			'ace-text_search',
			'ace-file_outline',
			'ide-get_diagnostics',
			'codebase-search',
			'websearch-search',
			'websearch-fetch',
		],
		createdAt: '2024-01-01T00:00:00.000Z',
		updatedAt: '2024-01-01T00:00:00.000Z',
		builtin: true,
	},
	{
		id: 'agent_general',
		name: 'General Purpose Agent',
		description:
			'General-purpose multi-step task execution agent. Has complete tool access for searching, modifying files, and executing commands. Best for complex tasks requiring actual operations.',
		role: 'You are a general-purpose task execution agent. You can perform various complex multi-step tasks, including searching code, modifying files, executing commands, etc. When given a task, systematically break it down and execute. You have access to all tools and should select appropriate tools as needed to complete tasks efficiently.',
		tools: [
			'filesystem-read',
			'filesystem-create',
			'filesystem-edit',
			'filesystem-edit_search',
			'terminal-execute',
			'ace-find_definition',
			'ace-find_references',
			'ace-semantic_search',
			'ace-text_search',
			'ace-file_outline',
			'websearch-search',
			'websearch-fetch',
			'ide-get_diagnostics',
			'codebase-search',
		],
		createdAt: '2024-01-01T00:00:00.000Z',
		updatedAt: '2024-01-01T00:00:00.000Z',
		builtin: true,
	},
];

function ensureConfigDirectory(): void {
	if (!existsSync(CONFIG_DIR)) {
		mkdirSync(CONFIG_DIR, {recursive: true});
	}
}

function generateId(): string {
	return `agent_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Get user-configured sub-agents only (exported for MCP tool generation)
 */
export function getUserSubAgents(): SubAgent[] {
	try {
		ensureConfigDirectory();

		if (!existsSync(SUB_AGENTS_CONFIG_FILE)) {
			return [];
		}

		const configData = readFileSync(SUB_AGENTS_CONFIG_FILE, 'utf8');
		const config = JSON.parse(configData) as SubAgentsConfig;
		return config.agents || [];
	} catch (error) {
		console.error('Failed to load sub-agents:', error);
		return [];
	}
}

/**
 * Get all sub-agents (built-in + user-configured)
 */
export function getSubAgents(): SubAgent[] {
	const userAgents = getUserSubAgents();
	const result: SubAgent[] = [];
	const userAgentIds = new Set<string>();

	// First, add all user agents that override built-in agents
	for (const userAgent of userAgents) {
		const builtinAgent = BUILTIN_AGENTS.find(ba => ba.id === userAgent.id);
		if (builtinAgent) {
			// User config overrides built-in config, but keep builtin: true
			result.push({
				...userAgent,
				builtin: true, // 保留被覆盖代理的内置标志
			});
			userAgentIds.add(userAgent.id);
		}
	}

	// Next, add remaining built-in agents (those not overridden)
	for (const builtinAgent of BUILTIN_AGENTS) {
		if (!userAgentIds.has(builtinAgent.id)) {
			result.push(builtinAgent);
		}
	}

	// Finally, add pure user-configured agents (those that don't match any built-in)
	for (const userAgent of userAgents) {
		if (!userAgentIds.has(userAgent.id)) {
			result.push(userAgent);
			userAgentIds.add(userAgent.id);
		}
	}

	return result;
}

/**
 * Get a sub-agent by ID (checks both built-in and user-configured)
 */
export function getSubAgent(id: string): SubAgent | null {
	const agents = getSubAgents();
	return agents.find(agent => agent.id === id) || null;
}

/**
 * Save sub-agents to config file (includes user-modified built-in agents)
 */
function saveSubAgents(agents: SubAgent[]): void {
	try {
		ensureConfigDirectory();
		// Save all agents including modified built-in agents
		const config: SubAgentsConfig = {agents};
		const configData = JSON.stringify(config, null, 2);
		writeFileSync(SUB_AGENTS_CONFIG_FILE, configData, 'utf8');
	} catch (error) {
		throw new Error(`Failed to save sub-agents: ${error}`);
	}
}
/**
 * Create a new sub-agent (user-configured only)
 */
export function createSubAgent(
	name: string,
	description: string,
	tools: string[],
	role?: string,
): SubAgent {
	const userAgents = getUserSubAgents();
	const now = new Date().toISOString();

	const newAgent: SubAgent = {
		id: generateId(),
		name,
		description,
		role,
		tools,
		createdAt: now,
		updatedAt: now,
		builtin: false,
	};

	userAgents.push(newAgent);
	saveSubAgents(userAgents);

	return newAgent;
}

/**
 * Update an existing sub-agent (only user-configured agents can be updated)
 */
export function updateSubAgent(
	id: string,
	updates: {
		name?: string;
		description?: string;
		role?: string;
		tools?: string[];
	},
): SubAgent | null {
	const agent = getSubAgent(id);
	if (!agent) {
		return null;
	}

	const userAgents = getUserSubAgents();
	const index = userAgents.findIndex(agent => agent.id === id);

	// If agent doesn't exist in user config but is a built-in agent,
	// create a user entry for it (allowing customization of built-in agents)
	if (index === -1 && agent.builtin) {
		const updatedAgent: SubAgent = {
			id: agent.id,
			name: updates.name ?? agent.name,
			description: updates.description ?? agent.description,
			role: updates.role ?? agent.role,
			tools: updates.tools ?? agent.tools,
			createdAt: agent.createdAt,
			updatedAt: new Date().toISOString(),
			builtin: true, // 为自定义的内置代理保留内置标志
		};

		userAgents.push(updatedAgent);
		saveSubAgents(userAgents);
		return updatedAgent;
	}

	if (index === -1) {
		return null; // Agent not found in user config and not a built-in agent
	}

	const existingAgent = userAgents[index];
	if (!existingAgent) {
		return null;
	}

	const updatedAgent: SubAgent = {
		id: existingAgent.id,
		name: updates.name ?? existingAgent.name,
		description: updates.description ?? existingAgent.description,
		role: updates.role ?? existingAgent.role,
		tools: updates.tools ?? existingAgent.tools,
		createdAt: existingAgent.createdAt,
		updatedAt: new Date().toISOString(),
		builtin: existingAgent.builtin, // Preserve builtin flag
	};

	userAgents[index] = updatedAgent;
	saveSubAgents(userAgents);

	return updatedAgent;
}

/**
 * Delete a sub-agent (only user-configured agents can be deleted)
 */
export function deleteSubAgent(id: string): boolean {
	// Prevent deleting built-in agents
	const agent = getSubAgent(id);
	if (agent?.builtin) {
		return false; // Cannot delete built-in agents
	}

	const userAgents = getUserSubAgents();
	const filteredAgents = userAgents.filter(agent => agent.id !== id);

	if (filteredAgents.length === userAgents.length) {
		return false; // Agent not found
	}

	saveSubAgents(filteredAgents);
	return true;
}

/**
 * Check if a built-in agent has been modified by the user
 */
export function isAgentUserModified(id: string): boolean {
	const userAgent = getUserSubAgents().find(agent => agent.id === id);
	const builtinAgent = BUILTIN_AGENTS.find(agent => agent.id === id);

	// If it's not a built-in agent, it's not applicable
	if (!builtinAgent) {
		return false;
	}

	// If there's a user config for this built-in agent, it's been modified
	return !!userAgent;
}

/**
 * Reset a built-in agent to its default configuration
 */
export function resetBuiltinAgent(id: string): boolean {
	const builtinAgent = BUILTIN_AGENTS.find(agent => agent.id === id);

	// Only allow resetting built-in agents
	if (!builtinAgent) {
		return false;
	}

	const userAgents = getUserSubAgents();
	const filteredAgents = userAgents.filter(agent => agent.id !== id);

	// If no user config existed for this agent, nothing to reset
	if (filteredAgents.length === userAgents.length) {
		return false; // Agent not found in user config
	}

	saveSubAgents(filteredAgents);
	return true;
}

/**
 * Validate sub-agent data
 */
export function validateSubAgent(data: {
	name: string;
	description: string;
	tools: string[];
}): string[] {
	const errors: string[] = [];

	if (!data.name || data.name.trim().length === 0) {
		errors.push('Agent name is required');
	}

	if (data.name && data.name.length > 100) {
		errors.push('Agent name must be less than 100 characters');
	}

	if (data.description && data.description.length > 500) {
		errors.push('Description must be less than 500 characters');
	}

	if (!data.tools || data.tools.length === 0) {
		errors.push('At least one tool must be selected');
	}

	return errors;
}
