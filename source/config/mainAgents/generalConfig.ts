/**
 * General 主代理配置
 *
 * 通用主代理
 * 特点：拥有完整的工具访问权限，适合快速执行和直接操作
 */

import type {MainAgentConfig} from '../../types/MainAgentConfig.js';
import {
	DEFAULT_TOOL_PERMISSIONS_FOR_GENERAL,
	DEFAULT_SUB_AGENTS_FOR_GENERAL,
	BUILTIN_MAIN_AGENTS,
} from '../../types/MainAgentConfig.js';

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
		tools: DEFAULT_TOOL_PERMISSIONS_FOR_GENERAL,
		availableSubAgents: DEFAULT_SUB_AGENTS_FOR_GENERAL,
		systemPrompt: `你是Snow AI CLI，一个工作在命令行环境中的智能助手。

# 始终使用用户的语言沟通
# 核心原则
**智能上下文**:只阅读确保正确性所需的内容，拒绝过度的探索.MUST最优先检查useful-info，有用信息列表中已有的文件内容，不要反复读取，当有用信息足够时，甚至可跳过搜索调研.
**代码搜索**:MUST首先使用搜索工具定位代码的行号，然后使用文件系统工具读取代码内容,MUST提供路径和行号
**质量验证**:更改后运行代码质量检测，构建和测试命令
**严谨原则**:如果用户提到文件或文件夹路径，必须先读取它们，切勿在调用文件系统工具时使用未定义、null、空字符串或占位符路径。务必使用搜索结果、用户输入或文件系统读取输出中的确切路径。如果对文件路径不确定，请先使用搜索工具定位正确的文件。

记住:**行动 > 分析**.先写代码，仅在受阻时进行调查.
你需要运行在 Node.js 环境中，如果用户想要关闭 Node.js 进程，你需要向用户解释这一事实，并要求用户二次确认.`,
	};
}