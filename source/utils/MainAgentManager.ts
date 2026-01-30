/**
 * 主代理管理器
 *
 * 可配置主代理系统重构 - YOLO解耦与多主代理支持
 * 解耦YOLO模式和主代理切换，使其成为两个独立的控制维度：
 * - YOLO模式：工具调用是否自动通过（布尔开关），通过 Ctrl+Y / Shift+Tab 切换
 * - 主代理选择：使用哪个主代理配置，通过 Alt+M 循环切换
 */

import {loadMainAgentConfig} from './MainAgentConfigIO.js';
import {getBuiltinMainAgentConfigs} from '../config/DefaultMainAgentConfig.js';
import type {
	MainAgentConfig,
	MainAgentRuntimeState,
} from '../types/MainAgentConfig.js';
import type {ChatCompletionTool} from '../api/types.js';
import {
	getAgentsPrompt,
	createSystemContext,
	getTaskCompletionPrompt,
	getSessionPathInfo,
} from './agentsPromptUtils.js';

/**
 * 内置主代理的固定排序顺序
 */
const BUILTIN_AGENT_ORDER = ['general', 'team', 'debugger'];

/**
 * 主代理管理器类
 *
 * 负责管理YOLO模式开关和主代理循环切换、配置加载和系统提示词生成
 * YOLO模式和主代理切换是两个独立的控制维度
 */
export class MainAgentManager {
	/** YOLO模式：工具调用是否自动通过 */
	private yoloEnabled: boolean = true;
	/** 当前主代理ID */
	private currentAgentId: string = 'general';
	/** 运行时状态 */
	private currentState: MainAgentRuntimeState | null = null;

	/**
	 * 初始化主代理管理器
	 * 默认启动为 YOLO 开启 + General 主代理
	 */
	constructor() {
		this.initializeState();
	}

	/**
	 * 切换 YOLO 模式（仅布尔开关）
	 * @returns 新的 YOLO 状态
	 */
	toggleYolo(): boolean {
		this.yoloEnabled = !this.yoloEnabled;
		return this.yoloEnabled;
	}

	/**
	 * 获取 YOLO 模式状态
	 */
	getYoloEnabled(): boolean {
		return this.yoloEnabled;
	}

	/**
	 * 设置 YOLO 模式状态
	 * @param enabled 是否启用 YOLO 模式
	 */
	setYoloEnabled(enabled: boolean): void {
		this.yoloEnabled = enabled;
	}

	/**
	 * 切换到下一个主代理（循环列表）
	 * 循环顺序：General → Leader → RequirementAnalyzer → Debugger → VulnerabilityHunter → General
	 * @returns 新的主代理 ID
	 */
	switchToNextAgent(): string {
		// 对于内置代理的快速切换，使用硬编码的顺序避免文件 I/O
		// 注意：这里的顺序必须与 BUILTIN_MAIN_AGENTS 保持一致
		const builtinOrder = [
			'general',
			'leader',
			'requirement_analyzer',
			'debugger',
			'vulnerability_hunter',
		];
		const currentIndex = builtinOrder.indexOf(this.currentAgentId);

		if (currentIndex !== -1) {
			// 如果当前是内置代理，直接在内置代理中切换
			const nextIndex = (currentIndex + 1) % builtinOrder.length;
			this.currentAgentId = builtinOrder[nextIndex] || 'general';
		} else {
			// 自定义代理仍需读取配置列表
			const agents = this.getOrderedAgentList();
			const customCurrentIndex = agents.findIndex(
				a => a.basicInfo.id === this.currentAgentId,
			);
			const nextIndex = (customCurrentIndex + 1) % agents.length;
			this.currentAgentId = agents[nextIndex]?.basicInfo.id || 'general';
		}

		// 切换主代理后需要刷新运行时状态，确保系统提示词/工具即时生效
		this.initializeState();
		return this.currentAgentId;
	}

	/**
	 * 获取当前主代理名称
	 */
	getCurrentAgentName(): string {
		return this.currentState?.currentConfig?.basicInfo?.name || 'General';
	}

	/**
	 * 获取当前主代理 ID
	 */
	getCurrentAgentId(): string {
		return this.currentAgentId;
	}

	/**
	 * @deprecated 使用 getYoloEnabled() 和 getCurrentAgentId() 代替
	 * 为向后兼容保留，模拟旧的 4 状态返回
	 */
	getCurrentMode(): string {
		const yolo = this.yoloEnabled;
		const isTeam = this.currentAgentId === 'team';

		if (yolo && isTeam) return 'yolo-team';
		if (yolo) return 'yolo';
		if (isTeam) return 'team';
		return 'general';
	}

	/**
	 * 设置当前主代理
	 * @param agentId 主代理 ID
	 */
	setCurrentAgent(agentId: string): void {
		this.currentAgentId = agentId;
		this.initializeState();
	}

	/**
	 * 获取排序后的主代理列表
	 * 顺序：内置代理（General → Team → Debugger）→ 用户自定义代理（按创建时间）
	 */
	getOrderedAgentList(): MainAgentConfig[] {
		const configs = this.getAllConfigs();

		// 分离内置和自定义
		const builtin = configs.filter(c => c.basicInfo.builtin);
		const custom = configs.filter(c => !c.basicInfo.builtin);

		// 内置按固定顺序排序
		builtin.sort((a, b) => {
			const aIndex = BUILTIN_AGENT_ORDER.indexOf(a.basicInfo.id);
			const bIndex = BUILTIN_AGENT_ORDER.indexOf(b.basicInfo.id);
			// 如果不在列表中，放到最后
			const aOrder = aIndex === -1 ? 999 : aIndex;
			const bOrder = bIndex === -1 ? 999 : bIndex;
			return aOrder - bOrder;
		});

		// 自定义按创建时间排序
		custom.sort((a, b) => {
			const aTime = a.basicInfo.createdAt
				? new Date(a.basicInfo.createdAt).getTime()
				: 0;
			const bTime = b.basicInfo.createdAt
				? new Date(b.basicInfo.createdAt).getTime()
				: 0;
			return aTime - bTime;
		});

		return [...builtin, ...custom];
	}

	/**
	 * 获取所有主代理配置
	 */
	getAllConfigs(): MainAgentConfig[] {
		try {
			const userConfig = loadMainAgentConfig();
			const builtinConfigs = getBuiltinMainAgentConfigs();
			const mergedConfigs = {...builtinConfigs, ...userConfig.agents};
			return Object.values(mergedConfigs);
		} catch {
			const builtinConfigs = getBuiltinMainAgentConfigs();
			return Object.values(builtinConfigs);
		}
	}

	/**
	 * 获取当前活跃的主代理配置
	 *
	 * @returns 当前主代理配置，如果没有则返回null
	 */
	getCurrentAgentConfig(): MainAgentConfig | null {
		return this.currentState?.currentConfig || null;
	}

	/**
	 * 获取当前模式的系统提示词
	 *
	 * 这是替代getSystemPromptForMode()的核心函数
	 * 注意：不在系统提示词中包含工具和子代理列表，这些由原生工具调用处理
	 *
	 * @returns 完整的系统提示词
	 */
	getSystemPrompt(): string {
		if (!this.currentState) {
			// 如果状态未初始化，返回通用主代理的默认提示词
			const builtinConfigs = getBuiltinMainAgentConfigs();
			const generalConfig = builtinConfigs['general'];

			if (!generalConfig) {
				throw new Error('General主代理配置未找到');
			}

			return this.generateCleanSystemPrompt(generalConfig);
		}

		const {currentConfig} = this.currentState;
		return this.generateCleanSystemPrompt(currentConfig);
	}

	/**
	 * 获取当前模式的工具自动通过状态
	 *
	 * @returns true表示工具自动通过，false表示需要用户审核
	 */
	getToolAutoApproval(): boolean {
		// 直接返回 YOLO 状态
		return this.yoloEnabled;
	}

	/**
	 * 获取当前可用的工具列表
	 *
	 * 注意：这个列表用于原生工具调用筛选，不包含在系统提示词中
	 *
	 * @returns 当前主代理配置的工具列表
	 */
	getAvailableTools(): string[] {
		if (!this.currentState) {
			return [];
		}

		return this.currentState.currentConfig.tools;
	}

	/**
	 * 获取当前可用的子代理列表
	 *
	 * 注意：这个列表用于原生工具调用筛选，不包含在系统提示词中
	 * 返回的子代理名称直接使用存储的全称格式
	 *
	 * @returns 当前主代理配置的子代理列表
	 */
	getAvailableSubAgents(): string[] {
		if (!this.currentState) {
			return [];
		}

		// 每个子代理名称前都带加 agent_ 前缀
		return this.currentState.currentConfig.availableSubAgents.map(
			agentName => `subagent-${agentName}`,
		);
	}

	/**
	 * 检查指定工具是否可用
	 *
	 * @param toolId 工具ID
	 * @returns true表示工具可用
	 */
	isToolAvailable(toolId: string): boolean {
		const availableTools = this.getAvailableTools();
		return availableTools.includes(toolId);
	}

	/**
	 * 检查指定子代理是否可用
	 *
	 * @param agentId 子代理ID
	 * @returns true表示子代理可用
	 */
	isSubAgentAvailable(agentId: string): boolean {
		const availableAgents = this.getAvailableSubAgents();
		return availableAgents.includes(agentId);
	}

	/**
	 * 生成纯净的系统提示词（不包含工具和子代理列表）
	 *
	 * 工具和子代理权限通过原生工具调用机制处理，不在提示词中显示
	 *
	 * @param config 主代理配置
	 * @returns 纯净的系统提示词
	 */
	private generateCleanSystemPrompt(config: MainAgentConfig): string {
		const {mainAgentRole} = config;

		// 创建基础提示词
		let prompt = mainAgentRole;

		// 添加 AGENTS.md 内容
		const agentsPrompt = getAgentsPrompt();
		if (agentsPrompt) {
			prompt += '\n\n' + agentsPrompt;
		}

		// 添加会话路径信息
		const sessionPathInfo = getSessionPathInfo();
		if (sessionPathInfo) {
			prompt += '\n\n' + sessionPathInfo;
		}

		// 添加环境上下文信息
		const contextInfo = createSystemContext();
		if (contextInfo) {
			prompt += '\n\n' + contextInfo;
		}

		// 添加任务完成标识提示词
		const taskCompletionPrompt = getTaskCompletionPrompt();
		if (taskCompletionPrompt) {
			prompt += '\n\n' + taskCompletionPrompt;
		}

		return prompt.trim();
	}

	/**
	 * 初始化当前状态
	 */
	private initializeState(): void {
		try {
			// 加载用户配置
			const userConfig = loadMainAgentConfig();
			const builtinConfigs = getBuiltinMainAgentConfigs();

			// 合并配置（用户配置覆盖内置配置）
			const mergedConfigs = {...builtinConfigs, ...userConfig.agents};

			// 使用当前选择的主代理ID
			let agentId = this.currentAgentId;

			// 如果找不到对应配置，回退到general
			if (!mergedConfigs[agentId]) {
				agentId = 'general';
				this.currentAgentId = agentId;
			}

			const currentConfig = mergedConfigs[agentId];
			if (!currentConfig) {
				throw new Error(`主代理配置未找到: ${agentId}`);
			}

			this.currentState = {
				currentAgentId: agentId,
				currentConfig,
				availableTools: this.convertToChatCompletionTools(),
				availableSubAgents: currentConfig.availableSubAgents,
				lastUpdated: new Date().toISOString(),
			};
		} catch (error) {
			console.error('主代理管理器初始化失败:', error);
			// 回退到内置general配置
			const builtinConfigs = getBuiltinMainAgentConfigs();
			const generalConfig = builtinConfigs['general'];

			if (!generalConfig) {
				throw new Error('内置General主代理配置未找到');
			}

			this.currentAgentId = 'general';
			this.currentState = {
				currentAgentId: 'general',
				currentConfig: generalConfig,
				availableTools: this.convertToChatCompletionTools(),
				availableSubAgents: generalConfig.availableSubAgents,
				lastUpdated: new Date().toISOString(),
			};
		}
	}

	private convertToChatCompletionTools(): ChatCompletionTool[] {
		// 这里返回空数组，实际工具转换应该由具体的API层处理
		// 主代理管理器只负责管理工具权限配置
		return [];
	}

	/**
	 * 获取状态描述信息（用于UI显示）
	 *
	 * @returns 当前状态的描述
	 */
	getStateDescription(): string {
		const yoloStatus = this.yoloEnabled ? 'YOLO' : 'Manual';
		const agentName = this.getCurrentAgentName();
		return `${yoloStatus} + ${agentName}`;
	}
}

/**
 * 全局主代理管理器实例
 */
export const mainAgentManager = new MainAgentManager();

/**
 * 切换 YOLO 模式
 * @returns 新的 YOLO 状态
 */
export function toggleYoloMode(): boolean {
	return mainAgentManager.toggleYolo();
}

/**
 * 获取 YOLO 模式状态
 * @returns 当前 YOLO 状态
 */
export function getYoloEnabled(): boolean {
	return mainAgentManager.getYoloEnabled();
}

/**
 * 切换到下一个主代理
 * @returns 新的主代理 ID
 */
export function switchMainAgent(): string {
	return mainAgentManager.switchToNextAgent();
}

/**
 * 获取当前主代理名称
 * @returns 当前主代理名称
 */
export function getCurrentAgentName(): string {
	return mainAgentManager.getCurrentAgentName();
}

/**
 * 获取当前主代理 ID
 * @returns 当前主代理 ID
 */
export function getCurrentAgentId(): string {
	return mainAgentManager.getCurrentAgentId();
}

/**
 * 获取当前工具自动通过状态
 *
 * @returns true表示工具自动通过
 */
export function getCurrentToolAutoApproval(): boolean {
	return mainAgentManager.getToolAutoApproval();
}

// =====================================================
// 向后兼容性导出（Deprecated - 将在后续版本移除）
// =====================================================

/**
 * @deprecated 使用 toggleYoloMode() 和 switchMainAgent() 代替
 * 保留此函数是为了向后兼容，将在快捷键重构完成后移除
 */
export function switchMainAgentMode(): string {
	// 暂时保持旧行为：切换主代理
	const newAgentId = mainAgentManager.switchToNextAgent();
	const agentName = mainAgentManager.getCurrentAgentName();
	const yoloStatus = mainAgentManager.getYoloEnabled() ? 'YOLO' : 'Manual';
	return `${yoloStatus} + ${agentName} (Agent: ${newAgentId})`;
}
