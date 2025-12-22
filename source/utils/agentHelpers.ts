/**
 * 主代理相关的辅助函数
 */

import type {MainAgentConfig} from '../types/MainAgentConfig.js';
/**
 * 获取已启用的工具数量
 */
export function getEnabledToolsCount(agent: MainAgentConfig): number {
	if (!agent.tools) {
		return 0;
	}

	// 简化格式：在列表中的工具就是启用的
	return agent.tools.length;
}

/**
 * 获取已启用的子代理数量
 */
export function getEnabledSubAgentsCount(agent: MainAgentConfig): number {
	if (!agent.availableSubAgents) {
		return 0;
	}
	// 简化格式：在列表中的子代理就是启用的
	return agent.availableSubAgents.length;
}
