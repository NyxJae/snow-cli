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
	'context_engine-codebase-retrieval',
	'ide-get_diagnostics',
	'todo-add',
	'todo-delete',
	'todo-get',
	'todo-update',
	'filesystem-read',
	'filesystem-create',
	'filesystem-edit_search',
	'filesystem-undo',
	'terminal-execute',
	'ace-text_search',
	'useful-info-add',
	'useful-info-delete',
	'notebook-add',
	'askuser-ask_question',
	'ace-file_outline',
	'notebook-query',
	'notebook-update',
	'notebook-delete',
	'notebook-list',
	'skill-execute',
];

/**
 * Debugger 主代理的子代理配置
 */
const DEBUGGER_SUB_AGENTS: string[] = [
	'agent_explore',
	'agent_general',
];

/**
 * 获取debugger主代理配置
 */
export function getSnowDebuggerConfig(): MainAgentConfig {
	return {
		basicInfo: {
			id: BUILTIN_MAIN_AGENTS.DEBUGGER,
			name: 'Debugger',
			description: '调试代理,专注于定位和修复代码问题',
			type: 'debugger',
			builtin: true,
			createdAt: '2025-12-11T11:12:40.153Z',
			updatedAt: '2026-01-21T06:28:03.118Z',
		},
		tools: DEBUGGER_TOOLS,
		availableSubAgents: DEBUGGER_SUB_AGENTS,
		mainAgentRole: `你是 Snow AI CLI - Debugger,一个专门的调试代理,专注于定位和修复代码问题.
先理解用户反馈的 bug 单,然后探索项目,分析出 bug 可能的三至五个成因,再给代码加上日志.
提示用户再次触发 bug,分析日志,定位问题,修复代码.`,
	};
}