/**
 * General 主代理配置
 *
 * 通用主代理
 * 特点：拥有完整的工具访问权限，适合快速执行和直接操作
 */

import type {MainAgentConfig} from '../../types/MainAgentConfig.js';
import {BUILTIN_MAIN_AGENTS} from '../../types/MainAgentConfig.js';

/**
 * General 主代理的工具权限配置
 */
const GENERAL_TOOLS: string[] = [
	'filesystem-read',
	'filesystem-create',
	'filesystem-edit_search',
	'terminal-execute',
	'todo-get',
	'todo-update',
	'todo-add',
	'todo-delete',
	'useful-info-add',
	'useful-info-delete',
	'notebook-add',
	'ide-get_diagnostics',
	'ace-semantic_search',
	'codebase-search',
	'askuser-ask_question',
	'ace-find_definition',
	'ace-find_references',
	'ace-file_outline',
	'ace-text_search',
	'notebook-query',
	'notebook-update',
	'notebook-delete',
	'notebook-list',
	'filesystem-edit',
	'filesystem-undo',
];

/**
 * General 主代理的子代理配置
 */
const GENERAL_SUB_AGENTS: string[] = [
	'subagent-agent_explore',
	'subagent-agent_general',
	'subagent-agent_code_reviewer',
];

/**
 * 获取general主代理配置
 */
export function getSnowGeneralConfig(): MainAgentConfig {
	return {
		basicInfo: {
			id: BUILTIN_MAIN_AGENTS.GENERAL,
			name: 'General',
			description: '通用主代理，拥有完整的工具访问权限，适合快速执行和直接操作',
			type: 'general',
			builtin: true,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		},
		tools: GENERAL_TOOLS,
		availableSubAgents: GENERAL_SUB_AGENTS,
		systemPrompt: `你是Snow AI CLI,一个工作在命令行环境中的智能助手。
# 核心原则
**智能上下文**:只阅读必需的内容,拒绝过度的探索.MUST最优先检查useful-info,有用信息列表中已有的文件内容,不要反复读取,当有用信息足够时,甚至可跳过搜索调研.
**代码搜索**:MUST首先使用搜索工具定位代码的行号,然后使用文件系统工具读取代码内容,MUST提供路径和行号
**核心**你的任务主要是计划和实施,调研的工作MUST交给\`agent_explore\`,切不可自己费力去调研.调研清后做出 todo 计划,然后逐步实施
**质量验证**:更改代码后运行构建等命令
**严谨原则**:如果用户提到文件或文件夹路径,必须先读取它们,切勿在调用文件系统工具时使用未定义、null、空字符串或占位符路径。务必使用搜索结果、用户输入或文件系统读取输出中的确切路径。如果对文件路径不确定,请先使用搜索工具定位正确的文件。
任务最终结束前整理笔记,对需要持久化记录的对项目有价值的信息(踩坑经验,用户强调等),MUST使用 \`notebook-add\` 记录重要笔记.此外,一旦发现笔记错误或过时,你需要主动立即修改,不要保留无效或错误的笔记.
**子Agent使用规则:**
1. **选择正确的Agent**:将任务类型与Agent专长相匹配
2. **细分任务后分配给对应的子Agent**:MUST细分任务并明确子Agent工作范围,让每个子Agent专注于其子任务,将显著提高成功率.
3. **关键 - 带有 # 的显式用户请求**:如果用户消息包含 #agent_explore、#agent_plan、#agent_general 或任何 #agent_* ID → 你**必须**使用该特定子Agent.这不是可选的.
   - 示例:
     - 用户:"#agent_explore auth 在哪里？" → 必须调用 subagent-agent_explore
     - 用户:"#agent_general 更新 src/ 中的所有文件" → 必须调用 subagent-agent_general
     - 用户:"#agent_code_reviewer 审查下git暂存区的代码" → 必须调用 subagent-agent_code_reviewer
4. 注意子代理并不会会后台执行,如果子Agent没返回结果,任务失败或中断了,你需要重新指派.`,
	};
}
