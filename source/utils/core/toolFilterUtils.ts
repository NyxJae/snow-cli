/**
 * 工具访问决策核心.
 *
 * 统一收敛主代理工具权限过滤与 Tool Search 暴露分层,确保所有链路遵循:
 * rawTools -> allowedTools -> searchableTools -> initialTools.
 */

import {mainAgentManager} from '../MainAgentManager.js';
import type {ChatCompletionTool} from '../../api/types.js';
import {
	MAIN_AGENT_SKIP_TOOL_SEARCH_SUBAGENT_WHITELIST,
	TOOL_SEARCH_INITIAL_TOOL_WHITELIST,
} from '../config/projectSettings.js';

/**
 * 工具访问决策选项.
 */
export interface ToolFilterOptions {
	/** 原始工具列表 */
	tools?: ChatCompletionTool[];
	/** 是否包含调试信息 */
	enableDebug?: boolean;
}

/**
 * 工具访问调试信息.
 */
export interface ToolAccessDebugInfo {
	availableTools: string[];
	availableSubAgents: string[];
	allowedToolNames: string[];
	globalWhitelistedToolNames: string[];
	mainAgentSubagentWhitelistedToolNames: string[];
	filteredCount: number;
	originalCount: number;
}

/**
 * 工具访问决策结果.
 */
export interface ToolFilterResult {
	/** 原始工具列表 */
	originalTools: ChatCompletionTool[];
	/** 已授权工具全集 */
	allowedTools: ChatCompletionTool[];
	/** 可通过 Tool Search 发现的工具 */
	searchableTools: ChatCompletionTool[];
	/** 首轮直接暴露给模型的工具 */
	initialTools: ChatCompletionTool[];
	/** 向后兼容字段,等价于 allowedTools */
	filteredTools: ChatCompletionTool[];
	/** 已授权工具名称 */
	allowedToolNames: string[];
	/** 可搜索工具名称 */
	searchableToolNames: string[];
	/** 首轮直出工具名称 */
	initialToolNames: string[];
	/** 调试信息 */
	debugInfo?: ToolAccessDebugInfo;
}

/**
 * 规范化工具标识.
 *
 * 运行时工具全称统一使用 `service-tool` 或内建特殊名称本身,不再引入 `.` 形式的二次拼装.
 */
export function normalizeToolIdentifier(toolName: string): string {
	return toolName.trim();
}

/**
 * 使用规范化后的运行时工具全称进行严格精确匹配.
 */
export function isExactToolIdentifierMatch(
	toolName: string,
	allowedIdentifiers: Iterable<string>,
): boolean {
	const normalizedToolName = normalizeToolIdentifier(toolName);
	for (const identifier of allowedIdentifiers) {
		if (normalizeToolIdentifier(identifier) === normalizedToolName) {
			return true;
		}
	}
	return false;
}

/**
 * 判断工具是否应在首轮直接暴露.
 */
export function shouldExposeToolInitially(toolName: string): boolean {
	const normalizedGlobalWhitelist = TOOL_SEARCH_INITIAL_TOOL_WHITELIST.map(
		identifier => normalizeToolIdentifier(identifier),
	);
	if (isExactToolIdentifierMatch(toolName, normalizedGlobalWhitelist)) {
		return true;
	}

	if (toolName.startsWith('subagent-')) {
		const normalizedMainAgentSubagentWhitelist =
			MAIN_AGENT_SKIP_TOOL_SEARCH_SUBAGENT_WHITELIST.map(identifier =>
				identifier.startsWith('subagent-')
					? identifier
					: `subagent-${identifier}`,
			);
		return isExactToolIdentifierMatch(
			toolName,
			normalizedMainAgentSubagentWhitelist,
		);
	}

	return false;
}

/**
 * 计算主代理的统一工具访问结果.
 *
 * 权限过滤永远先于白名单暴露策略. 白名单只决定 initialTools,不扩权.
 */
export function filterToolsByMainAgent(
	options: ToolFilterOptions,
): ToolFilterResult {
	const {tools, enableDebug = false} = options;
	const originalTools = tools ? [...tools] : [];

	if (originalTools.length === 0) {
		return {
			originalTools: [],
			allowedTools: [],
			searchableTools: [],
			initialTools: [],
			filteredTools: [],
			allowedToolNames: [],
			searchableToolNames: [],
			initialToolNames: [],
		};
	}

	try {
		const availableTools = mainAgentManager.getAvailableTools();
		const availableSubAgents = mainAgentManager.getAvailableSubAgents();
		const allowedToolNames = [...availableTools, ...availableSubAgents];
		const allowedNameSet = new Set(allowedToolNames);
		const allowedTools = originalTools.filter(tool =>
			allowedNameSet.has(tool.function.name),
		);
		const initialTools = allowedTools.filter(tool =>
			shouldExposeToolInitially(tool.function.name),
		);
		const initialToolNameSet = new Set(
			initialTools.map(tool => tool.function.name),
		);
		const searchableTools = allowedTools.filter(
			tool => !initialToolNameSet.has(tool.function.name),
		);
		const result: ToolFilterResult = {
			originalTools,
			allowedTools,
			searchableTools,
			initialTools,
			filteredTools: allowedTools,
			allowedToolNames: allowedTools.map(tool => tool.function.name),
			searchableToolNames: searchableTools.map(tool => tool.function.name),
			initialToolNames: initialTools.map(tool => tool.function.name),
		};

		if (enableDebug) {
			result.debugInfo = {
				availableTools,
				availableSubAgents,
				allowedToolNames,
				globalWhitelistedToolNames: allowedTools
					.filter(tool =>
						isExactToolIdentifierMatch(
							tool.function.name,
							TOOL_SEARCH_INITIAL_TOOL_WHITELIST,
						),
					)
					.map(tool => tool.function.name),
				mainAgentSubagentWhitelistedToolNames: allowedTools
					.filter(
						tool =>
							tool.function.name.startsWith('subagent-') &&
							isExactToolIdentifierMatch(
								tool.function.name,
								MAIN_AGENT_SKIP_TOOL_SEARCH_SUBAGENT_WHITELIST,
							),
					)
					.map(tool => tool.function.name),
				filteredCount: allowedTools.length,
				originalCount: originalTools.length,
			};
		}

		return result;
	} catch (error) {
		console.warn(
			'主代理管理器工具筛选失败，按 fail-closed 返回空授权集合:',
			error,
		);
		return {
			originalTools,
			allowedTools: [],
			searchableTools: [],
			initialTools: [],
			filteredTools: [],
			allowedToolNames: [],
			searchableToolNames: [],
			initialToolNames: [],
			debugInfo: enableDebug
				? {
						availableTools: [],
						availableSubAgents: [],
						allowedToolNames: [],
						globalWhitelistedToolNames: [],
						mainAgentSubagentWhitelistedToolNames: [],
						filteredCount: 0,
						originalCount: originalTools.length,
				  }
				: undefined,
		};
	}
}

/**
 * 简化的工具筛选函数(向后兼容).
 */
export function filterTools(
	tools?: ChatCompletionTool[],
): ChatCompletionTool[] {
	return filterToolsByMainAgent({tools}).allowedTools;
}

/**
 * 获取工具筛选统计信息.
 */
export function getToolFilterStats(tools?: ChatCompletionTool[]) {
	const result = filterToolsByMainAgent({tools, enableDebug: true});
	return {
		originalCount: result.originalTools.length,
		filteredCount: result.allowedTools.length,
		filteredOutCount: result.originalTools.length - result.allowedTools.length,
		availableTools: result.debugInfo?.availableTools || [],
		availableSubAgents: result.debugInfo?.availableSubAgents || [],
		allowedToolNames: result.debugInfo?.allowedToolNames || [],
		initialToolNames: result.initialToolNames,
		searchableToolNames: result.searchableToolNames,
	};
}
