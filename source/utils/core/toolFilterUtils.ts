/**
 * 工具筛选通用函数
 *
 * 提供统一的工具权限筛选逻辑，消除各API渠道中的重复代码。
 * 使用主代理管理器进行工具权限控制，确保4状态循环下的完整权限控制。
 */

import {mainAgentManager} from '../MainAgentManager.js';
import type {ChatCompletionTool} from '../../api/types.js';

/**
 * 工具筛选选项接口
 */
export interface ToolFilterOptions {
	/** 原始工具列表 */
	tools?: ChatCompletionTool[];
	/** 是否包含调试信息 */
	enableDebug?: boolean;
}

/**
 * 工具筛选结果接口
 */
export interface ToolFilterResult {
	/** 筛选后的工具列表 */
	filteredTools: ChatCompletionTool[];
	/** 原始工具列表（用于回退） */
	originalTools: ChatCompletionTool[];
	/** 调试信息 */
	debugInfo?: {
		availableTools: string[];
		availableSubAgents: string[];
		allowedToolNames: string[];
		filteredCount: number;
		originalCount: number;
	};
}

/**
 * 使用主代理管理器筛选工具权限
 *
 * 该函数会从主代理管理器获取当前允许的工具和子代理列表，
 * 并对输入的工具进行筛选，只保留在允许列表中的工具。
 * 如果主代理管理器不可用或发生错误，会回退到原始工具列表。
 *
 * @param options 筛选选项
 * @returns 筛选结果
 */
export function filterToolsByMainAgent(
	options: ToolFilterOptions,
): ToolFilterResult {
	const {tools, enableDebug = false} = options;

	// 如果没有工具输入，返回空结果
	if (!tools || tools.length === 0) {
		return {
			filteredTools: [],
			originalTools: [],
		};
	}

	// 原始工具列表（用于回退）
	const originalTools = [...tools];

	try {
		// 从主代理管理器获取可用的工具和子代理列表
		const availableTools = mainAgentManager.getAvailableTools();
		// 获取可用子代理全称
		const availableSubAgents = mainAgentManager.getAvailableSubAgents()

		// 如果没有可用工具或子代理，返回原始列表
		if (availableTools.length === 0 && availableSubAgents.length === 0) {
			return {
				filteredTools: originalTools,
				originalTools,
				debugInfo: enableDebug
					? {
							availableTools,
							availableSubAgents,
							allowedToolNames: [],
							filteredCount: originalTools.length,
							originalCount: originalTools.length,
					  }
					: undefined,
			};
		}

		// 合并允许的工具和子代理列表
		const allowedToolNames = [...availableTools, ...availableSubAgents];
		// 支持精确匹配
		const filteredTools = originalTools.filter(tool => {
			const toolName = tool.function.name;
			return allowedToolNames.some((allowedTool: string) => {
				// 精确匹配
				if (toolName === allowedTool) {
					return true;
				}
				return false;
			});
		});

		// 返回筛选结果
		const result: ToolFilterResult = {
			filteredTools,
			originalTools,
		};

		// 如果启用了调试信息，添加调试数据
		if (enableDebug) {
			result.debugInfo = {
				availableTools,
				availableSubAgents,
				allowedToolNames,
				filteredCount: filteredTools.length,
				originalCount: originalTools.length,
			};
		}

		return result;
	} catch (error) {
		// 错误处理：主代理管理器工具筛选失败，使用原始工具列表
		console.warn('主代理管理器工具筛选失败，使用原始工具列表:', error);

		return {
			filteredTools: originalTools,
			originalTools,
			debugInfo: enableDebug
				? {
						availableTools: [],
						availableSubAgents: [],
						allowedToolNames: [],
						filteredCount: originalTools.length,
						originalCount: originalTools.length,
				  }
				: undefined,
		};
	}
}

/**
 * 简化的工具筛选函数（向后兼容）
 *
 * @param tools 原始工具列表
 * @returns 筛选后的工具列表
 */
export function filterTools(
	tools?: ChatCompletionTool[],
): ChatCompletionTool[] {
	return filterToolsByMainAgent({tools}).filteredTools;
}

/**
 * 获取工具筛选统计信息
 *
 * @param tools 原始工具列表
 * @returns 统计信息
 */
export function getToolFilterStats(tools?: ChatCompletionTool[]) {
	const result = filterToolsByMainAgent({tools, enableDebug: true});

	return {
		originalCount: result.originalTools.length,
		filteredCount: result.filteredTools.length,
		filteredOutCount: result.originalTools.length - result.filteredTools.length,
		availableTools: result.debugInfo?.availableTools || [],
		availableSubAgents: result.debugInfo?.availableSubAgents || [],
		allowedToolNames: result.debugInfo?.allowedToolNames || [],
	};
}
