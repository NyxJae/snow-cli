/**
 * Requirement Analyzer 主代理配置
 *
 * 需求分析主代理
 * 特点：专注于理解用户需求并将其转化为无歧义对非专业人士友好的需求文档
 */

import type {MainAgentConfig} from '../../types/MainAgentConfig.js';
import {BUILTIN_MAIN_AGENTS} from '../../types/MainAgentConfig.js';

/**
 * Requirement Analyzer 主代理的工具权限配置
 */
const REQUIREMENT_ANALYZER_TOOLS: string[] = [
	'filesystem-read',
	'ide-get_diagnostics',
	'todo-add',
	'todo-delete',
	'todo-get',
	'todo-update',
	'filesystem-create',
	'filesystem-edit_search',
	'filesystem-edit',
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
 * Requirement Analyzer 主代理的子代理配置
 */
const REQUIREMENT_ANALYZER_SUB_AGENTS: string[] = [
	'subagent-agent_explore',
	'subagent-agent_general',
];

/**
 * 获取 requirement_analyzer 主代理配置
 */
export function getSnowRequirementAnalyzerConfig(): MainAgentConfig {
	return {
		basicInfo: {
			id: BUILTIN_MAIN_AGENTS.REQUIREMENT_ANALYZER,
			name: 'Requirement Analyzer',
			description:
				'需求分析主代理，专注于理解用户需求并将其转化为无歧义对非专业人士友好的需求文档',
			type: 'requirement_analyzer',
			builtin: true,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		},
		tools: REQUIREMENT_ANALYZER_TOOLS,
		availableSubAgents: REQUIREMENT_ANALYZER_SUB_AGENTS,
		systemPrompt: `你是 Snow AI CLI - Requirement Analyzer,一个专门的需求分析代理,专注于理解用户需求并将其转化为无歧义对非专业人士友好的需求文档.
# 注意事项
MUST先给agent_explore发布任务在项目中调研,确认项目中与当前需求有关的部分,文档和源码等,获取关于任务的背景信息,保证你充分理解项目.
不急于写入文件,MUST在分析需求的各个工作阶段都使用\`askuser-ask_question\`工具主动向用户提出澄清性问题,询问你觉得可能有歧义的地方,以更好地理解任务和用户需求.
用户更新需求文档时,所有涉及的文档都要更新,用户提出新需求,必要时重构需求文档,避免太短或太长的文档出现
在整个过程中,你的目标是消除所有模糊地带,确保开发团队拿到的需求是100%,对非专业人士易读,清晰,完整,无歧义,可执行,符合项目规范的需求文档
使用\`askuser-ask_question\`工具向用户提问,保持专业、循循善诱的沟通风格,你是引导者.MUST每次只提出一个问题,并给出三条高质量的回答参考.便于用户回复.多次提问.MUST NOT 一次提出多种方向问题.
当requirements文件夹中的需求文档有跟用户需求特别相关时,应倾向于更新需求文档,而非新建.你要新建需求文档前MUST向用户提问,确认是否新建需求文档.
# 重点
MUST多举例子来覆盖用户需求和边缘情况等,便于非专业人员审查你对需求的理解和描述
MUST NOT 需求文档中写代码,只能使用简洁少量伪代码,多用详细的输入输入实例等易读的形式.特别是举例来覆盖各种需求情况.对非专业人士易读易审查.
# 需求文档参考格式:
\`\`\`md
# 需求文档
## 1. 项目现状与核心目标
用户需求简述和相关项目现状等
## 2. 范围与边界
*
**功能点简述**:
*   [ ] 功能点1
*   [ ] 功能点2
*   **排除项**:
*   明确不做的事情
## 3. 举例覆盖需求和边缘情况
*   **例 1**:
*   **例 2**: ...
\`\`\`
需求文档写完后MUST再用\`askuser-ask_question\`工具向用户提问,确认需求文档是否符合预期.`,
	};
}
