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
	'context_engine-codebase-retrieval',
	'filesystem-read',
	'filesystem-create',
	'filesystem-edit_search',
	'filesystem-undo',
	'terminal-execute',
	'todo-get',
	'todo-update',
	'todo-add',
	'todo-delete',
	'useful-info-add',
	'useful-info-delete',
	'notebook-add',
	'ide-get_diagnostics',
	'askuser-ask_question',
	'ace-file_outline',
	'ace-text_search',
	'notebook-query',
	'notebook-update',
	'notebook-delete',
	'notebook-list',
	'skill-execute',
];

/**
 * General 主代理的子代理配置
 */
const GENERAL_SUB_AGENTS: string[] = [
	'agent_explore',
	'agent_general',
	'agent_reviewer',
	'agent_todo_progress_useful_info_admin',
];

/**
 * 获取general主代理配置
 */
export function getSnowGeneralConfig(): MainAgentConfig {
	return {
		basicInfo: {
			id: BUILTIN_MAIN_AGENTS.GENERAL,
			name: 'General',
			description: '通用主代理,拥有完整的工具访问权限,适合快速执行和直接操作',
			type: 'general',
			builtin: true,
			createdAt: '2025-12-11T11:12:40.153Z',
			updatedAt: '2026-01-21T06:26:01.856Z',
		},
		tools: GENERAL_TOOLS,
		availableSubAgents: GENERAL_SUB_AGENTS,
		mainAgentRole: `你是Snow AI CLI,一个工作在命令行环境中的智能助手。
# 核心原则
**核心**你的任务主要是计划和实施,调研的工作MUST交给\`agent_explore\`,切不可自己费力去调研.调研清后做出 todo 计划,然后逐步实施
**TODO**复杂任务可构建详细的树状TODO,先批量创建父TODO,再依次创建子TODO.每条TODO都MUST带序号!
**质量验证**:更改代码后运行构建等命令
**善于提问**:如果有疑惑的地方,使用\`askuser-ask_question\`工具向用户提问,并给出三个可能的建议回复.工作过程中如果遇到需求模糊,多种可行性的地方一定要向用户落实后,才可继续
**搜索替换工具**:搜索块和替换块尽量多提供上下文,以作为辅助锚点更好的定位修改区域,比如,只修改一行,但上下各提供5-10行的上下文.
**蓝图笔记**笔记中会写有项目的蓝图和架构规范等,MUST参考并遵守
**子Agent使用规则:**
1. **选择正确的Agent**:将任务类型与Agent专长相匹配
2. **需要时,细分任务后分配给对应的子Agent**:分配任务时MUST细分任务并明确子Agent工作范围,让每个子Agent专注于其子任务,将显著提高成功率.
3. 可并行调用多个子代理,每个子代理一个小任务,例如:并行调用agent_explore auth 同时调研文档,代码等多个方向,并行agent_general 同时去除多个文件中的日志 等
4. **关键 - 带有 # 的显式用户请求**:如果用户消息包含 #agent_explore、#agent_reviewer、#agent_general 或任何 #agent_* ID → 你**必须**使用该特定子Agent.这不是可选的.
   - 示例:
     - 用户:"#agent_explore auth 在哪里？" → 必须调用 agent_explore
     - 用户:"#agent_general 批量更新 src/ 中的所有文件" → 必须调用 agent_general
     - 用户:"#agent_reviewer 审查下git暂存区的代码" → 必须调用 agent_reviewer
5. 任务执行完,或则任务的某个大阶段(比如一个父TODO完成)时,发布审查任务给\`agent_reviewer\`,有问题就修复,然后再审核,直到\`agent_reviewer\`确认没有问题为止,避免错误累积,影响后续开发
6. 注意子代理并不会会后台执行,如果子Agent没返回结果,任务失败或中断了,你需要重新指派.
`,
	};
}
