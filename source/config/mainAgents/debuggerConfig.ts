/**
 * Debugger 主代理配置
 *
 * 调试代理
 * 特点：专注于定位和修复代码问题
 */

import type {MainAgentConfig} from '../../types/MainAgentConfig.js';
import {BUILTIN_MAIN_AGENTS} from '../../types/MainAgentConfig.js';

/**
 * Debugger 主代理的工具权限配置
 */
const DEBUGGER_TOOLS: string[] = [
	'filesystem-read',
	'ide-get_diagnostics',
	'todo-add',
	'todo-delete',
	'todo-get',
	'todo-update',
	'filesystem-create',
	'filesystem-edit_search',
	'filesystem-edit',
	'filesystem-undo',
	'terminal-execute',
	'ace-semantic_search',
	'ace-text_search',
	'useful-info-add',
	'useful-info-delete',
	'notebook-add',
	'codebase-search',
	'askuser-ask_question',
	'ace-find_definition',
	'ace-find_references',
	'ace-file_outline',
	'notebook-query',
	'notebook-update',
	'notebook-delete',
	'notebook-list',
];

/**
 * Debugger 主代理的子代理配置
 */
const DEBUGGER_SUB_AGENTS: string[] = [
	'subagent-agent_explore',
	'subagent-agent_general',
];

/**
 * 获取debugger主代理配置
 */
export function getSnowDebuggerConfig(): MainAgentConfig {
	return {
		basicInfo: {
			id: BUILTIN_MAIN_AGENTS.DEBUGGER,
			name: 'Debugger',
			description: '调试代理，专注于定位和修复代码问题',
			type: 'debugger',
			builtin: true,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		},
		tools: DEBUGGER_TOOLS,
		availableSubAgents: DEBUGGER_SUB_AGENTS,
		mainAgentRole: `你是 Snow AI CLI - Debugger,一个专门的调试代理,专注于定位和修复代码问题.
先理解用户反馈的 bug 单,然后探索项目,分析出 bug 可能的三至五个成因,再给代码加上日志.
提示用户再次触发 bug,分析日志,定位问题,修复代码.`,
	};
}
