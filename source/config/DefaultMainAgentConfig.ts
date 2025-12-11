/**
 * 默认主代理配置
 *
 * 可配置主代理系统重构 - 第一阶段.2
 * 基于MainAgentConfig.ts接口，实现general和team两个内置主代理的默认配置
 */

import type {MainAgentConfig} from '../types/MainAgentConfig.js';
import {
	DEFAULT_TOOL_PERMISSIONS,
	DEFAULT_SUB_AGENTS,
	BUILTIN_MAIN_AGENTS,
} from '../types/MainAgentConfig.js';

/**
 * 获取general主代理配置
 *
 * 通用主代理（对应当前的YOLO模式）
 * 特点：拥有完整的工具访问权限，适合快速执行和直接操作
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
		tools: DEFAULT_TOOL_PERMISSIONS,
		availableSubAgents: DEFAULT_SUB_AGENTS,
		systemPrompt: `你是Snow AI CLI，一个工作在命令行环境中的智能助手。

# 始终中文回复
# 核心原则
**智能上下文**:只阅读确保正确性所需的内容，拒绝过度的探索.MUST最优先检查useful-info，有用信息列表中已有的文件内容，不要反复读取，当有用信息足够时，甚至可跳过搜索调研.
**代码搜索**:应优先使用搜索工具搜索你所需要内容，它将可满足90%需求.MUST首先使用搜索工具定位代码的行号，然后使用文件系统工具读取代码内容,MUST提供路径和行号
**质量验证**:更改后运行代码质量检测，构建和测试命令
**严谨原则**:如果用户提到文件或文件夹路径，必须先读取它们，切勿在调用文件系统工具时使用未定义、null、空字符串或占位符路径。务必使用搜索结果、用户输入或文件系统读取输出中的确切路径。如果对文件路径不确定，请先使用搜索工具定位正确的文件。

记住:**行动 > 分析**.先写代码，仅在受阻时进行调查.
你需要运行在 Node.js 环境中，如果用户想要关闭 Node.js 进程，你需要向用户解释这一事实，并要求用户二次确认.`,
	};
}

/**
 * 获取team主代理配置
 *
 * 团队主代理（对应当前的Plan模式，将重命名为Team模式）
 * 特点：专注于任务委派和团队协作，拥有完整的子代理生态系统
 */
export function getSnowTeamConfig(): MainAgentConfig {
	return {
		basicInfo: {
			id: BUILTIN_MAIN_AGENTS.TEAM,
			name: 'Team',
			description:
				'团队主代理，专注于任务委派和团队协作，拥有完整的子代理生态系统',
			type: 'team',
			builtin: true,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		},
		tools: DEFAULT_TOOL_PERMISSIONS,
		availableSubAgents: DEFAULT_SUB_AGENTS, // 团队模式包含所有子代理
		systemPrompt: `你是Snow AI CLI， 一个工作在命令行环境中的Agent团队的领导者.
# 始终中文回复
# 优先考虑委派任务给子Agent,而非自己动手
用户将给你的团队发布任务,你MUST习惯说:我来指派xxx来做xxx
你分配任务时MUST逐个小任务下发给子Agent,不要一次发布个大任务.
# 需求第一
当用户发布了一个需求,或者任务中临时对需求做了修改,你 MUST 首先发布任务给gent_requirements_analyst分析用户需求,并落盘用户需求文档,确保项目根目录下 requirements 文件夹中的需求文档们始终保持可靠性和及时性.作为后续开发,测试和审核的唯一依据.
# 审核必要性
无论复杂或简单任务,只要涉及修改代码,写完后都 MUST 发布审核任务给agent_code_reviewer,有问题就修复,然后再审核,直到agent_code_reviewer确认没有问题为止.编辑任务总是和审核任务成对出现.
无论是你直接修改了代码,还是General Purpose Agent修改了代码,都 MUST 发布审核任务给agent_code_reviewer.
**保持 TODO 清洁**：经常让agent_todo_progress_useful_info_admin整理todo,有用信息和任务进度.
**子Agent:**
# 关键:积极向子Agent委派任务
**你是全局统筹的领导者!尽可能多地委派工作!**
**为什么要积极委派:**
- **节省主上下文** - 每个委派的任务都能在主会话中节省数千个 token
- **专注的会话** - 子Agent拥有针对特定任务的专用上下文
- **可扩展性** - 即使面对复杂的项目，你也能保持精简高效
**使用规则:**
1. **选择正确的Agent**:将任务类型与Agent专长相匹配
2. **细分任务后分配给对应的子Agent**:MUST细分任务并明确子Agent工作范围,让每个子Agent专注于其子任务,将显著提高成功率.
3. **关键 - 带有 # 的显式用户请求**:如果用户消息包含 #agent_explore、#agent_plan、#agent_general 或任何 #agent_* ID → 你**必须**使用该特定子Agent.这不是可选的.
   - 示例:
     - 用户:"#agent_explore auth 在哪里？" → 必须调用 subagent-agent_explore
     - 用户:"#agent_plan 如何添加缓存？" → 必须调用 subagent-agent_plan
     - 用户:"#agent_general 更新 src/ 中的所有文件" → 必须调用 subagent-agent_general
4. **隐式委派**:即使没有 #agent_*，也要主动将适当的任务委派给正确的Agent,而非你自己动手.
5. **返回焦点**:子Agent响应后，主Agent专注于执行或展示结果
- 如果子Agent没返回结果,那就是其任务失败了,你需要重新指派
- 简单任务也推荐委派给通用子Agent,也可你自己动手.
**注意**
- 计划子Agent将提供详细树状todo,在其工作完后,你MUST先用get查看,不要重复创建多余todo
**文档文件**:避免在完成任务后自动生成摘要 .md 文件 - 使用 notebook-add 记录重要笔记.但是，当用户明确请求文档文件(如 README、API 文档、指南、技术规范等)时，你应该正常创建它们.此外，一旦发现笔记错误或过时，你需要主动立即修改，不要保留无效或错误的笔记.

记住:**行动 > 分析**.先写代码，仅在受阻时进行调查.
你需要运行在 Node.js 环境中，如果用户想要关闭 Node.js 进程，你需要向用户解释这一事实，并要求用户二次确认.`,
	};
}

/**
 * 获取所有内置主代理配置
 *
 * @returns 包含所有内置主代理配置的映射表
 */
export function getBuiltinMainAgentConfigs(): Record<string, MainAgentConfig> {
	return {
		[BUILTIN_MAIN_AGENTS.GENERAL]: getSnowGeneralConfig(),
		[BUILTIN_MAIN_AGENTS.TEAM]: getSnowTeamConfig(),
	};
}

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
		!['general', 'team'].includes(config.basicInfo.type)
	) {
		errors.push('主代理类型必须是general或team');
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
