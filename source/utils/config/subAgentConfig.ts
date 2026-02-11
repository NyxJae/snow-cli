import {
	existsSync,
	readFileSync,
	mkdirSync,
	unlinkSync,
	accessSync,
	constants,
} from 'fs';
import {join} from 'path';
import {homedir} from 'os';
import {readToml, writeToml, existsToml} from './tomlUtils.js';
import {BUILTIN_AGENTS} from './builtinSubAgents.js';

export interface SubAgent {
	id: string;
	name: string;
	description: string;
	systemPrompt?: string;
	tools?: string[];
	subAgentRole?: string;
	createdAt?: string;
	updatedAt?: string;
	builtin?: boolean;
	// 可选配置项
	configProfile?: string; // 配置文件名称
}
export interface SubAgentsConfig {
	agents: SubAgent[];
}

const CONFIG_DIR = join(homedir(), '.snow');
const SUB_AGENTS_TOML_FILE = join(CONFIG_DIR, 'sub-agents.toml');
const SUB_AGENTS_JSON_FILE = join(CONFIG_DIR, 'sub-agents.json');

/**
 * 获取项目级配置目录路径
 */
function getProjectConfigDir(): string {
	return join(process.cwd(), '.snow');
}

/**
 * 获取项目级子代理配置文件路径 (TOML)
 */
function getProjectSubAgentTomlPath(): string {
	return join(getProjectConfigDir(), 'sub-agents.toml');
}

/**
 * 获取项目级子代理配置文件路径 (JSON，向后兼容)
 */
function getProjectSubAgentJsonPath(): string {
	return join(getProjectConfigDir(), 'sub-agents.json');
}


function ensureConfigDirectory(): void {
	if (!existsSync(CONFIG_DIR)) {
		try {
			// 尝试创建配置目录
			mkdirSync(CONFIG_DIR, {recursive: true});

			// 验证目录是否成功创建且有写权限
			try {
				accessSync(CONFIG_DIR, constants.W_OK);
			} catch (accessError) {
				throw new Error(
					`Configuration directory created but is not writable: ${CONFIG_DIR}`,
				);
			}
		} catch (error) {
			if (error instanceof Error) {
				throw new Error(
					`Failed to create configuration directory ${CONFIG_DIR}: ${error.message}`,
				);
			} else {
				throw new Error(
					`Failed to create configuration directory ${CONFIG_DIR}: ${String(
						error,
					)}`,
				);
			}
		}
	} else {
		// 目录已存在，检查写权限
		try {
			accessSync(CONFIG_DIR, constants.W_OK);
		} catch (accessError) {
			throw new Error(
				`Configuration directory exists but is not writable: ${CONFIG_DIR}`,
			);
		}
	}
}

function generateId(): string {
	return `agent_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Get user-configured sub-agents only (exported for MCP tool generation)
 * 优先级：项目级配置 > 全局配置
 * - 如果项目级配置存在且有效（agents数组长度 > 0），使用项目级配置
 * - 否则回退到全局配置
 */
export function getUserSubAgents(): SubAgent[] {
	try {
		// 1. 首先检查项目级配置 (TOML)
		const projectTomlPath = getProjectSubAgentTomlPath();
		if (existsToml(projectTomlPath)) {
			const config = readToml<SubAgentsConfig>(projectTomlPath);
			// 项目级配置存在且有效，使用项目级
			if (config && config.agents && config.agents.length > 0) {
				return config.agents;
			}
			// 项目级配置为空数组或无效，回退到全局
		}

		// 2. 检查项目级配置 (JSON，向后兼容)
		const projectJsonPath = getProjectSubAgentJsonPath();
		if (existsSync(projectJsonPath)) {
			const configData = readFileSync(projectJsonPath, 'utf8');
			const config = JSON.parse(configData) as SubAgentsConfig;
			if (config.agents && config.agents.length > 0) {
				return config.agents;
			}
			// 项目级配置为空数组或无效，回退到全局
		}

		// 3. 回退到全局配置
		ensureConfigDirectory();

		// 优先读取全局TOML文件
		if (existsToml(SUB_AGENTS_TOML_FILE)) {
			const config = readToml<SubAgentsConfig>(SUB_AGENTS_TOML_FILE);
			return config?.agents || [];
		}

		// 回退到全局JSON文件（向后兼容）
		if (existsSync(SUB_AGENTS_JSON_FILE)) {
			const configData = readFileSync(SUB_AGENTS_JSON_FILE, 'utf8');
			const config = JSON.parse(configData) as SubAgentsConfig;
			return config.agents || [];
		}

		return [];
	} catch (error) {
		console.error('Failed to load sub-agents:', error);
		return [];
	}
}

/**
 * Get all sub-agents (built-in + user-configured)
 * 优先使用用户副本，避免重复
 */
export function getSubAgents(): SubAgent[] {
	const userAgents = getUserSubAgents();
	const result: SubAgent[] = [];
	const overriddenIds = new Set<string>();

	// Add user overrides for built-in agents first (preserve ALL user fields, ensure builtin: true)
	for (const userAgent of userAgents) {
		const builtinAgent = BUILTIN_AGENTS.find(ba => ba.id === userAgent.id);
		if (builtinAgent) {
			// 保留用户副本的所有字段,确保 builtin: true
			// 兼容旧版本: 如果 TOML 中没有 builtin 字段,强制设置为 true
			result.push({
				...userAgent,
				builtin: true, // 确保内置代理的用户副本标记为 builtin: true
			});
			overriddenIds.add(userAgent.id);
		}
	}

	// Include remaining built-in agents that were not overridden
	for (const builtinAgent of BUILTIN_AGENTS) {
		if (!overriddenIds.has(builtinAgent.id)) {
			result.push(builtinAgent);
		}
	}

	// Finally, append user-created agents that don't match built-ins
	for (const userAgent of userAgents) {
		if (!overriddenIds.has(userAgent.id)) {
			result.push(userAgent);
			overriddenIds.add(userAgent.id);
		}
	}

	return result;
}

/**
 * Get a sub-agent by ID (checks both built-in and user-configured)
 * getSubAgents已经处理了优先级（用户副本优先）
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
		// 确定保存路径
		// 根据当前配置来源决定写入位置
		let filePath: string;
		if (isUsingProjectSubAgentConfig()) {
			// 当前使用项目级配置，保存到项目级
			filePath = getProjectSubAgentTomlPath();
		} else {
			// 使用全局配置
			ensureConfigDirectory();
			filePath = SUB_AGENTS_TOML_FILE;
		}

		// Save all agents including modified built-in agents
		const config: SubAgentsConfig = {agents};

		// 保存为TOML格式
		writeToml(filePath, config);

		// 如果保存的是全局配置，清理旧的JSON文件（避免混淆）
		if (filePath === SUB_AGENTS_TOML_FILE && existsSync(SUB_AGENTS_JSON_FILE)) {
			try {
				unlinkSync(SUB_AGENTS_JSON_FILE);
			} catch {
				// 忽略删除失败
			}
		}
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
	subAgentRole?: string,
	configProfile?: string,
): SubAgent {
	const userAgents = getUserSubAgents();
	const now = new Date().toISOString();

	const newAgent: SubAgent = {
		id: generateId(),
		name,
		description,
		subAgentRole,
		tools,
		createdAt: now,
		updatedAt: now,
		builtin: false,
		configProfile,
	};

	userAgents.push(newAgent);
	saveSubAgents(userAgents);

	return newAgent;
}

/**
 * Update an existing sub-agent
 * For built-in agents: creates or updates a user copy (override)
 * For user-configured agents: updates the existing agent
 */
export function updateSubAgent(
	id: string,
	updates: {
		name?: string;
		description?: string;
		subAgentRole?: string;
		tools?: string[];
		configProfile?: string;
		customSystemPrompt?: string;
		customHeaders?: Record<string, string>;
	},
): SubAgent | null {
	const agent = getSubAgent(id);
	if (!agent) {
		return null;
	}

	const userAgents = getUserSubAgents();
	const existingUserIndex = userAgents.findIndex(a => a.id === id);
	const existingUserCopy =
		existingUserIndex >= 0 ? userAgents[existingUserIndex] : null;
	const now = new Date().toISOString();

	// If it's a built-in agent, create or update user copy
	if (agent.builtin) {
		// For built-in agents, we need to check if we should clear the field completely
		const userCopy: SubAgent = {
			id: agent.id,
			name: updates.name ?? existingUserCopy?.name ?? agent.name,
			description:
				updates.description ??
				existingUserCopy?.description ??
				agent.description,
			subAgentRole:
				updates.subAgentRole ??
				existingUserCopy?.subAgentRole ??
				agent.subAgentRole,
			tools: updates.tools ?? existingUserCopy?.tools ?? agent.tools,
			createdAt: existingUserCopy?.createdAt ?? agent.createdAt ?? now,
			updatedAt: now,
			builtin: true, // 保持 true,表示这是内置代理的用户副本
		};

		// 只有在 updates 中明确包含这些字段时才添加到 userCopy
		if ('configProfile' in updates) {
			userCopy.configProfile = updates.configProfile;
		}

		if (existingUserIndex >= 0) {
			userAgents[existingUserIndex] = userCopy;
		} else {
			userAgents.push(userCopy);
		}

		saveSubAgents(userAgents);
		return userCopy;
	}

	// Update regular user-configured agent
	if (existingUserIndex === -1) {
		return null;
	}

	const existingAgent = userAgents[existingUserIndex];
	if (!existingAgent) {
		return null;
	}

	const updatedAgent: SubAgent = {
		id: existingAgent.id,
		name: updates.name ?? existingAgent.name,
		description: updates.description ?? existingAgent.description,
		subAgentRole: updates.subAgentRole ?? existingAgent.subAgentRole,
		tools: updates.tools ?? existingAgent.tools,
		createdAt: existingAgent.createdAt,
		updatedAt: now,
		builtin: existingAgent.builtin,
	};

	// 只有在 updates 中明确包含这些字段时才添加到 updatedAgent
	if ('configProfile' in updates) {
		updatedAgent.configProfile = updates.configProfile;
	}
	userAgents[existingUserIndex] = updatedAgent;
	saveSubAgents(userAgents);

	return updatedAgent;
}

/**
 * Delete a sub-agent
 * For built-in agents: removes user override (restores default)
 * For user-configured agents: permanently deletes the agent
 */
export function deleteSubAgent(id: string): boolean {
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
	subAgentRole?: string;
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

	if (data.subAgentRole && data.subAgentRole.length > 5000) {
		errors.push('Role definition must be less than 5000 characters');
	}

	if (!data.tools || data.tools.length === 0) {
		errors.push('At least one tool must be selected');
	}

	return errors;
}

/**
 * 检测当前是否使用项目级子代理配置
 */
export function isUsingProjectSubAgentConfig(): boolean {
	const projectTomlPath = getProjectSubAgentTomlPath();
	if (existsToml(projectTomlPath)) {
		const config = readToml<SubAgentsConfig>(projectTomlPath);
		if (config && config.agents && config.agents.length > 0) {
			return true;
		}
	}

	const projectJsonPath = getProjectSubAgentJsonPath();
	if (existsSync(projectJsonPath)) {
		try {
			const configData = readFileSync(projectJsonPath, 'utf8');
			const config = JSON.parse(configData) as SubAgentsConfig;
			if (config.agents && config.agents.length > 0) {
				return true;
			}
		} catch {
			return false;
		}
	}

	return false;
}

/**
 * 获取全局子代理配置路径
 */
export function getGlobalSubAgentConfigPath(): string {
	return SUB_AGENTS_TOML_FILE;
}

/**
 * 获取项目级子代理配置路径（公开版）
 */
export function getProjectSubAgentConfigPath(): string {
	return getProjectSubAgentTomlPath();
}
