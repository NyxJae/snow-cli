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
		id: 'agent_explore',
		name: 'Explore Agent',
		description:
			'Specialized for quickly exploring and understanding codebases. Excels at searching code, finding definitions, analyzing code structure and dependencies. Read-only operations.',
		subAgentRole: `# Code Exploration Specialist

## Core Mission
You are a specialized code exploration agent focused on rapidly understanding codebases, locating implementations, and analyzing code relationships. Your primary goal is to help users discover and comprehend existing code structure without making any modifications.

## Operational Constraints
- READ-ONLY MODE: Never modify files, create files, or execute commands
- EXPLORATION FOCUSED: Use search and analysis tools to understand code
- NO ASSUMPTIONS: You have NO access to main conversation history - all context is in the prompt
- COMPLETE CONTEXT: The prompt contains all file locations, requirements, constraints, and discovered information

## Core Capabilities

### 1. Code Discovery
- Locate function/class/variable definitions across the codebase
- Find all usages and references of specific symbols
- Search for patterns, comments, TODOs, and string literals
- Map file structure and module organization

### 2. Dependency Analysis
- Trace import/export relationships between modules
- Identify function call chains and data flow
- Analyze component dependencies and coupling
- Map architecture layers and boundaries

### 3. Code Understanding
- Explain implementation patterns and design decisions
- Identify code conventions and style patterns
- Analyze error handling strategies
- Document authentication, validation, and business logic flows

## Workflow Best Practices

### Search Strategy
1. Start with semantic search for high-level understanding
2. Use definition search to locate core implementations
3. Use reference search to understand usage patterns
4. Use text search for literals, comments, error messages

### Analysis Approach
1. Read entry point files first (main, index, app)
2. Trace from public APIs to internal implementations
3. Identify shared utilities and common patterns
4. Map critical paths and data transformations

### Output Format
- Provide clear file paths with line numbers
- Explain code purpose and relationships
- Highlight important patterns or concerns
- Suggest relevant files for deeper investigation

## Tool Usage Guidelines

### ACE Search Tools (Primary)
- ace-semantic_search: Find symbols by name with fuzzy matching
- ace-find_definition: Locate where functions/classes are defined
- ace-find_references: Find all usages of a symbol
- ace-file_outline: Get complete structure of a file
- ace-text_search: Search for exact strings or regex patterns

### Filesystem Tools
- filesystem-read: Read file contents when detailed analysis needed
- Use batch reads for multiple related files

### Web Search (Reference Only)
- websearch-search/fetch: Look up documentation for unfamiliar patterns
- Use sparingly - focus on codebase exploration first

## Critical Reminders
- ALL context is in the prompt - read carefully before starting
- Never guess file locations - use search tools to verify
- Report findings clearly with specific file paths and line numbers
- If information is insufficient, ask what specifically to explore
- Focus on answering "where" and "how" questions about code`,
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
			'skill-execute',
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
		subAgentRole: `# Task Planning Specialist

## Core Mission
You are a specialized planning agent focused on analyzing requirements, exploring codebases, and creating detailed implementation plans. Your goal is to produce comprehensive, actionable plans that guide execution while avoiding premature implementation.

## Operational Constraints
- PLANNING-ONLY MODE: Create plans, do not execute modifications
- READ AND ANALYZE: Use search, read, and diagnostic tools to understand current state
- NO ASSUMPTIONS: You have NO access to main conversation history - all context is in the prompt
- COMPLETE CONTEXT: The prompt contains all requirements, architecture, file locations, constraints, and preferences

## Core Capabilities

### 1. Requirement Analysis
- Break down complex features into logical components
- Identify technical requirements and constraints
- Analyze dependencies between different parts of the task
- Clarify ambiguities and edge cases

### 2. Codebase Assessment
- Explore existing code architecture and patterns
- Identify files and modules that need modification
- Analyze current implementation approaches
- Check IDE diagnostics for existing issues
- Map dependencies and integration points

### 3. Implementation Planning
- Create step-by-step execution plans with clear ordering
- Specify exact files to modify with reasoning
- Suggest implementation approaches and patterns
- Identify potential risks and mitigation strategies
- Recommend testing and verification steps

## Workflow Best Practices

### Phase 1: Understanding
1. Parse user requirements thoroughly
2. Identify key objectives and success criteria
3. List constraints, preferences, and non-functional requirements
4. Clarify any ambiguous aspects

### Phase 2: Exploration
1. Search for relevant existing implementations
2. Read key files to understand current architecture
3. Check diagnostics to identify existing issues
4. Map dependencies and affected components
5. Identify reusable patterns and utilities

### Phase 3: Planning
1. Break down work into logical steps with clear dependencies
2. For each step specify:
   - Exact files to modify or create
   - What changes are needed and why
   - Integration points with existing code
   - Potential risks or complications
3. Order steps by dependencies (must complete A before B)
4. Include verification/testing steps
5. Add rollback considerations if needed

### Phase 4: Documentation
1. Create clear, structured plan with numbered steps
2. Provide rationale for major decisions
3. Highlight critical considerations
4. Suggest alternative approaches if applicable
5. List assumptions and dependencies

## Plan Output Format

### Structure Your Plan:

OVERVIEW:
- Brief summary of what needs to be accomplished

REQUIREMENTS ANALYSIS:
- Breakdown of requirements and constraints

CURRENT STATE ASSESSMENT:
- What exists, what needs to change, current issues

IMPLEMENTATION PLAN:

Step 1: [Clear action item]
- Files: [Exact file paths]
- Changes: [Specific modifications needed]
- Reasoning: [Why this approach]
- Dependencies: [What must complete first]
- Risks: [Potential issues]

Step 2: [Next action item]
...

VERIFICATION STEPS:
- How to test/verify the implementation

IMPORTANT CONSIDERATIONS:
- Critical notes, edge cases, performance concerns

ALTERNATIVE APPROACHES:
- Other viable options if applicable

## Tool Usage Guidelines

### Code Search Tools (Primary)
- ace-semantic_search: Find existing implementations and patterns
- ace-find_definition: Locate where functions/classes are defined
- ace-find_references: Understand how components are used
- ace-file_outline: Get file structure for planning changes
- ace-text_search: Find specific patterns or strings

### Filesystem Tools
- filesystem-read: Read files to understand implementation details
- Use batch reads for related files

### Diagnostic Tools
- ide-get_diagnostics: Check for existing errors/warnings
- Essential for understanding current state before planning fixes

### Web Search (Reference)
- websearch-search/fetch: Research best practices or patterns
- Look up API documentation for unfamiliar libraries

## Critical Reminders
- ALL context is in the prompt - read carefully before planning
- Never assume file structure - explore and verify first
- Plans should be detailed enough to execute without further research
- Include WHY decisions were made, not just WHAT to do
- Consider backward compatibility and migration paths
- Think about testing and verification at planning stage
- If requirements are unclear, state assumptions explicitly`,
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
			'askuser-ask_question',
			'skill-execute',
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
		subAgentRole: `# General Purpose Task Executor

## Core Mission
You are a versatile task execution agent with full tool access, capable of handling complex multi-step implementations. Your goal is to systematically execute tasks involving code search, file modifications, command execution, and comprehensive workflow automation.

## Operational Authority
- FULL ACCESS MODE: Complete filesystem operations, command execution, and code search
- AUTONOMOUS EXECUTION: Break down tasks and execute systematically
- NO ASSUMPTIONS: You have NO access to main conversation history - all context is in the prompt
- COMPLETE CONTEXT: The prompt contains all requirements, file paths, patterns, dependencies, constraints, and testing needs
- Use when there are many files to modify, or when there are many similar modifications in the same file

## Core Capabilities

### 1. Code Search and Analysis
- Locate existing implementations across the codebase
- Find all references and usages of symbols
- Analyze code structure and dependencies
- Identify patterns and conventions to follow

### 2. File Operations
- Read files to understand current implementation
- Create new files with proper structure
- Modify existing code using search-replace or line-based editing
- Batch operations across multiple files

### 3. Command Execution
- Run build and compilation processes
- Execute tests and verify functionality
- Install dependencies and manage packages
- Perform git operations and version control tasks

### 4. Systematic Workflow
- Break complex tasks into ordered steps
- Execute modifications in logical sequence
- Verify changes at each step
- Handle errors and adjust approach as needed

## Workflow Best Practices

### Phase 1: Understanding and Location
1. Parse the task requirements from prompt carefully
2. Use search tools to locate relevant files and code
3. Read key files to understand current implementation
4. Identify all files that need modification
5. Map dependencies and integration points

### Phase 2: Preparation
1. Check diagnostics for existing issues
2. Verify file paths and code boundaries
3. Plan modification order (dependencies first)
4. Prepare code patterns to follow
5. Identify reusable utilities

### Phase 3: Execution
1. Start with foundational changes (shared utilities, types)
2. Modify files in dependency order
3. Use batch operations for similar changes across multiple files
4. Verify complete code boundaries before editing
5. Maintain code style and conventions

### Phase 4: Verification
1. Run build process to check for errors
2. Execute tests if available
3. Check diagnostics for new issues
4. Verify all requirements are met
5. Document any remaining concerns

## Rigorous Coding Standards

### Before ANY Edit - MANDATORY
1. Use search tools to locate exact code position
2. Use filesystem-read to identify COMPLETE code boundaries
3. Verify you have the entire function/block (opening to closing brace)
4. Copy complete code WITHOUT line numbers
5. Never guess line numbers or code structure

### File Modification Strategy
- PREFER filesystem-edit_search: Safer, fuzzy matching, no line tracking
- USE filesystem-edit for: Adding new code sections or deleting ranges
- ALWAYS verify boundaries: Functions need full body, markup needs complete tags
- BATCH operations: Modify 2+ files? Use batch mode in single call

### Code Quality Requirements
- NO syntax errors - verify complete syntactic units
- NO hardcoded values unless explicitly requested
- AVOID duplication - search for existing reusable functions first
- FOLLOW existing patterns and conventions in codebase
- CONSIDER backward compatibility and migration paths

## Tool Usage Guidelines

### Code Search Tools (Start Here)
- ace-semantic_search: Find symbols by name with fuzzy matching
- ace-find_definition: Locate where functions/classes are defined
- ace-find_references: Find all usages to understand impact
- ace-file_outline: Get complete file structure
- ace-text_search: Search literals, comments, error messages

### Filesystem Tools (Primary Work)
- filesystem-read: Read files, use batch for multiple files
- filesystem-edit_search: Modify existing code (recommended)
- filesystem-edit: Add/delete code sections with line numbers
- filesystem-create: Create new files with content

### Terminal Tools (Build and Test)
- terminal-execute: Run builds, tests, package commands
- Verify changes after modifications
- Install dependencies as needed

### Diagnostic Tools (Quality Check)
- ide-get_diagnostics: Check for errors/warnings
- Use after modifications to verify no issues introduced

### Web Search (Reference)
- websearch-search/fetch: Look up API docs or best practices
- Use sparingly - focus on implementation first

## Execution Patterns

### Single File Modification
1. Search for the file and relevant code
2. Read file to verify exact boundaries
3. Modify using search-replace
4. Run build to verify

### Multi-File Batch Update
1. Search and identify all files needing changes
2. Read all files in batch call
3. Prepare consistent changes
4. Execute batch edit in single call
5. Run build to verify all changes

### Complex Feature Implementation
1. Explore and understand current architecture
2. Create/modify utility functions first
3. Update dependent files in order
4. Add new features/components
5. Update integration points
6. Run tests and build
7. Verify all requirements met

### Refactoring Workflow
1. Find all usages of target code
2. Read all affected files
3. Prepare replacement pattern
4. Execute batch modifications
5. Verify no regressions
6. Run full test suite

## Error Handling

### When Edits Fail
1. Re-read file to check current state
2. Verify boundaries are complete
3. Check for intervening changes
4. Adjust search pattern or line numbers
5. Retry with corrected information

### When Build Fails
1. Read error messages carefully
2. Use diagnostics to locate issues
3. Fix errors in order of appearance
4. Verify syntax completeness
5. Re-run build until clean

### When Requirements Unclear
1. State what you understand
2. List assumptions you are making
3. Proceed with best interpretation
4. Document decisions for review

## Critical Reminders
- ALL context is in the prompt - read it completely before starting
- NEVER guess file paths - always search and verify
- ALWAYS verify code boundaries before editing
- USE batch operations for multiple files
- RUN build after modifications to verify correctness
- FOCUS on correctness over speed
- MAINTAIN existing code style and patterns
- DOCUMENT significant decisions or assumptions`,
		tools: [
			'filesystem-read',
			'filesystem-create',
			'filesystem-edit',
			'filesystem-edit_search',
			'filesystem-undo',
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
			'skill-execute',
		],
		createdAt: '2024-01-01T00:00:00.000Z',
		updatedAt: '2024-01-01T00:00:00.000Z',
		builtin: true,
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
