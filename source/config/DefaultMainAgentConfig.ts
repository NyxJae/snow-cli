/**
 * 默认主代理配置
 *
 * 重新导出内置主代理配置模块
 *
 * 注意：内置主代理配置已拆分为独立文件：
 * - source/config/mainAgents/generalConfig.ts
 * - source/config/mainAgents/teamConfig.ts
 * - source/config/mainAgents/debuggerConfig.ts
 * - source/config/mainAgents/index.ts
 */

import type {MainAgentConfig} from '../types/MainAgentConfig.js';
import {
	getSnowGeneralConfig,
	getSnowTeamConfig,
	getSnowDebuggerConfig,
	getBuiltinMainAgentConfigs,
} from './mainAgents/index.js';

export {
	getSnowGeneralConfig,
	getSnowTeamConfig,
	getSnowDebuggerConfig,
	getBuiltinMainAgentConfigs,
};

/**
 * 创建默认的主代理配置文件结构
 *
 * @returns 符合MainAgentConfigFile接口的默认配置文件
 */
export function createDefaultMainAgentConfigFile() {
	return {
		agents: getBuiltinMainAgentConfigs(),
	};
}

/**
 * 验证主代理配置的完整性
 *
 * @param config 主代理配置
 * @returns 验证结果
 */
export function validateMainAgentConfig(config: MainAgentConfig): {
	valid: boolean;
	errors: string[];
} {
	const errors: string[] = [];

	// 验证基本信息
	if (!config.basicInfo?.id) {
		errors.push('缺少主代理ID');
	}
	if (!config.basicInfo?.name) {
		errors.push('缺少主代理名称');
	}
	if (
		!config.basicInfo?.type ||
		!['general', 'team', 'debugger'].includes(config.basicInfo.type)
	) {
		errors.push('主代理类型必须是general、team或debugger');
	}

	// 验证工具权限配置
	if (!Array.isArray(config.tools)) {
		errors.push('工具权限配置必须是数组');
	} else {
		config.tools.forEach((tool, index) => {
			if (typeof tool !== 'string') {
				errors.push(`工具配置[${index}]必须是字符串`);
			}
		});
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}
