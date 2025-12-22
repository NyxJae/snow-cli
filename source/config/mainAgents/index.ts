/**
 * 主代理配置统一导出
 *
 * 整合所有内置主代理配置的导出入口
 */

export {getSnowGeneralConfig} from './generalConfig.js';
export {getSnowTeamConfig} from './teamConfig.js';
export {getSnowDebuggerConfig} from './debuggerConfig.js';

import type {MainAgentConfig} from '../../types/MainAgentConfig.js';
import {BUILTIN_MAIN_AGENTS} from '../../types/MainAgentConfig.js';
import {getSnowGeneralConfig} from './generalConfig.js';
import {getSnowTeamConfig} from './teamConfig.js';
import {getSnowDebuggerConfig} from './debuggerConfig.js';

/**
 * 获取所有内置主代理配置
 * 
 * @returns 包含所有内置主代理配置的映射表
 */
export function getBuiltinMainAgentConfigs(): Record<string, MainAgentConfig> {
	return {
		[BUILTIN_MAIN_AGENTS.GENERAL]: getSnowGeneralConfig(),
		[BUILTIN_MAIN_AGENTS.TEAM]: getSnowTeamConfig(),
		[BUILTIN_MAIN_AGENTS.DEBUGGER]: getSnowDebuggerConfig(),
	};
}