/**
 * 主代理配置系统类型定义
 *
 * 可配置主代理系统重构 - 第一阶段.1
 * 定义主代理配置的TypeScript接口，包括基本信息、工具权限、子代理配置和系统提示词模板
 */

import type {ChatCompletionTool} from '../api/types.js';

/**
 * 主代理基本信息配置
 */
export interface MainAgentBasicInfo {
	/** 主代理唯一标识符 */
	id: string;
	/** 主代理显示名称 */
	name: string;
	/** 主代理描述信息 */
	description: string;
	/** 主代理类型：'general' | 'team' | 'debugger' */
	type: 'general' | 'team' | 'debugger';
	/** 是否为内置主代理 */
	builtin?: boolean;
	/** 创建时间 */
	createdAt?: string;
	/** 更新时间 */
	updatedAt?: string;
}

/**
 * 主代理完整配置接口
 */
export interface MainAgentConfig {
	/** 主代理基本信息 */
	basicInfo: MainAgentBasicInfo;
	/** 工具权限配置列表 - 简化为字符串数组格式 */
	tools: string[];
	/** 可用子代理配置列表 */
	availableSubAgents: string[];
	/** 系统提示词模板配置 */
	systemPrompt: string;
}

/**
 * 主代理配置文件根结构（用于TOML序列化）
 */
export interface MainAgentConfigFile {
	/** 主代理配置映射表 */
	agents: Record<string, MainAgentConfig>;
}

/**
 * 主代理运行时状态
 */
export interface MainAgentRuntimeState {
	/** 当前活跃的主代理ID */
	currentAgentId: string;
	/** 当前主代理的完整配置 */
	currentConfig: MainAgentConfig;
	/** 当前可用的ChatCompletionTool列表 */
	availableTools: ChatCompletionTool[];
	/** 当前可用的子代理列表 */
	availableSubAgents: string[];
	/** 最后更新时间 */
	lastUpdated: string;
}

/**
 * 主代理配置验证结果
 */
export interface MainAgentValidationResult {
	/** 验证是否通过 */
	valid: boolean;
	/** 错误信息列表 */
	errors: string[];
	/** 警告信息列表 */
	warnings: string[];
}

/**
 * 主代理配置操作选项
 */
export interface MainAgentConfigOptions {
	/** 是否验证子代理存在性 */
	validateSubAgents?: boolean;
	/** 是否验证工具可用性 */
	validateTools?: boolean;
	/** 是否自动修复配置问题 */
	autoFix?: boolean;
}

/**
 * 主代理类型枚举
 */
export enum MainAgentType {
	GENERAL = 'general',
	TEAM = 'team',
	DEBUGGER = 'debugger',
}

/**
 * 内置主代理ID常量
 */
export const BUILTIN_MAIN_AGENTS = {
	GENERAL: 'general',
	TEAM: 'team',
	DEBUGGER: 'debugger',
} as const;

/**
 * 默认General主代理的工具权限配置
 */
export const DEFAULT_TOOL_PERMISSIONS_FOR_GENERAL: string[] = [
	// 文件系统工具
	'filesystem-read',
	'filesystem-create',
	'filesystem-edit_search',

	// 终端工具
	'terminal-execute',

	// 搜索工具
	'ace-find_definition',
	'ace-find_references',
	'ace-semantic_search',
	'ace-file_outline',
	'ace-text_search',

	// 任务管理工具
	'todo-get',
	'todo-update',
	'todo-add',
	'todo-delete',

	// 信息管理工具
	'useful-info-add',
	'useful-info-delete',
	'useful-info-get',

	// 笔记工具
	'notebook-add',

	// IDE工具
	'ide-get_diagnostics',
] as const;

/**
 * 默认Team主代理的工具权限配置
 */
export const DEFAULT_TOOL_PERMISSIONS_FOR_TEAM: string[] = [
	// 文件系统工具
	'filesystem-read',
	// 任务管理工具
	'todo-get',
	'todo-update',
	'todo-add',
	'todo-delete',
	// IDE工具
	'ide-get_diagnostics',
] as const;

/**
 * 默认general主代理的子代理配置
 */
export const DEFAULT_SUB_AGENTS_FOR_GENERAL: string[] = [
	'subagent-agent_explore',
	'subagent-agent_general',
] as const;

/**
 * 默认Team主代理的子代理配置
 */
export const DEFAULT_SUB_AGENTS_FOR_TEAM: string[] = [
	'subagent-agent_explore',
	'subagent-agent_plan',
	'subagent-agent_general',
] as const;
