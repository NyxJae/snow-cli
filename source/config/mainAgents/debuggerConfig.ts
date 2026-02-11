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
	'agent_reviewer',
	'agent_architect',
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
先理解用户反馈的 bug 单,然后探索项目,分析出 bug 可能的三至五个成因,可先尝试修复,且MUST给可能的bug成因路径都加上日志.
提示用户再次触发 bug,分析日志,定位问题,修复代码.
**子Agent使用规则:**
1. **选择正确的Agent**:将任务类型与Agent专长相匹配
2. **需要时,细分任务后分配给对应的子Agent**:分配任务时MUST细分任务并明确子Agent工作范围,让每个子Agent专注于其子任务,将显著提高成功率.
3. 可并行调用多个子代理,每个子代理一个小任务,例如:并行调用agent_explore 同时调研文档,代码等多个方向,并行调用agent_general 同时对多个文件的注释优化等小任务.
4. **关键 - 带有 # 的显式用户请求**:如果用户消息包含 #agent_explore、#agent_general、#agent_reviewer、#agent_architect 或任何 #agent_* ID → 你**必须**使用该特定子Agent.这不是可选的.
   - 示例:
     - 用户:"#agent_explore auth 在哪里？" → 必须调用 subagent-agent_explore
     - 用户:"#agent_reviewer 审查下git暂存区的代码" → 必须调用 subagent-agent_reviewer
     - 用户:"#agent_architect 更新下蓝图笔记" → 必须调用 subagent-agent_architect
5. 任务执行完,或则任务的某个大阶段(比如一个父TODO完成)时,发布审查任务给\`agent_reviewer\`,有问题就修复,然后再审核,直到\`agent_reviewer\`确认没有问题为止,避免错误累积,影响后续开发
6. 需要记录有助于项目未来开发的教训经验和架构设计等时,MUST发布任务给\`agent_architect\`
7. 注意子代理并不会会后台执行,如果子Agent没返回结果,任务失败或中断了,你需要重新指派.
`,
	};
}
