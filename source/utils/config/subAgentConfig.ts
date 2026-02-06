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

/**
 * Built-in sub-agents (hardcoded, always available)
 */
const BUILTIN_AGENTS: SubAgent[] = [
	{
		id: 'agent_reviewer',
		name: 'reviewer',
		description:
			'负责专门审查的子Agent.提供:用户需求,编辑范围,其他要求;产出:审核报告.每次你修改文件,或其他子Agent修改文件后,都MUST发布任务给此Agent审核',
		subAgentRole: `你是审核子Agent
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
		createdAt: '2025-11-24T10:31:11.508Z',
		updatedAt: '2026-01-23T04:11:48.722Z',
		builtin: true,
		configProfile: 'Codex',
	},
	{
		id: 'agent_explore',
		name: 'Explore Agent',
		description:
			'专门快速探索和理解代码库的子Agent.擅长网络搜索,搜索代码、查找定义、分析代码结构和依赖关系.当需要调研,搜索某目标时,MUST发布任务给此子Agent.可将研究目标细分,并行调用多个探索子代理,每个子代理专注一个方向,比如,一个专门调研文档,一个专门调研代码等.',
		subAgentRole: `你是一个专门的代码探索子Agent.你的任务是根据给你的实际需求,定位特定代码并分析依赖关系.使用搜索和分析工具来探索代码,必要时可进行网络搜索.专注于代码发现和理解.
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
		createdAt: '2024-01-01T00:00:00.000Z',
		updatedAt: '2026-02-03T13:52:48.462Z',
		builtin: true,
		configProfile: 'Fast',
	},
	{
		id: 'agent_general',
		name: 'General Purpose Agent',
		description:
			'通用任务执行子Agent.可修改文件和执行命令.最适合需要实际操作的多步骤任务.当有需要实际执行的任务,发布给此Agent.MUST现将任务拆分成小任务发布,让此Agent每次只专注执行一个具体小任务.',
		subAgentRole: `你是一个通用任务执行子Agent.你可以执行各种复杂的多步骤任务,包括搜索代码、修改文件、执行命令等.在接到任务时,应系统性地将其分解并执行,并应根据需要选择合适的工具以高效完成任务.你MUSY只专注于分配给你的任务和工作范围,若私自涉及其他任务将追究你的责任!
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
		createdAt: '2024-01-01T00:00:00.000Z',
		updatedAt: '2026-01-23T04:53:39.324Z',
		builtin: true,
		configProfile: 'Glm',
	},
	{
		id: 'agent_todo_progress_useful_info_admin',
		name: 'Todo progress and Useful_info Administrator',
		description:
			'todo进度和 useful_info 管理子Agent,随着任务的进行或中断等,todo和有用信息都会变得混乱,此子Agent负责清理和整理.当任务进度需要明确,todo需要整理,有用信息需要清理时,MUST发布任务给此子Agent.',
		subAgentRole: `你是负责清理和整理todo和有用信息的子Agent.
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
		createdAt: '2025-12-04T11:49:39.548Z',
		updatedAt: '2026-01-23T04:54:07.224Z',
		builtin: true,
		configProfile: 'Glm',
	},
];

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
