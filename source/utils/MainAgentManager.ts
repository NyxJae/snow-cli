/**
 * 主代理管理器
 *
 * 可配置主代理系统重构 - 第二阶段.1
 * 实现4状态循环（YOLO → YOLO+Team → Team → General）的主代理状态管理和切换逻辑
 * 完全替代现有的Plan模式系统，转用可配置的主代理系统
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {loadMainAgentConfig} from './MainAgentConfigIO.js';
import {getBuiltinMainAgentConfigs} from '../config/DefaultMainAgentConfig.js';
import type {
	MainAgentConfig,
	MainAgentRuntimeState,
} from '../types/MainAgentConfig.js';
import type {ChatCompletionTool} from '../api/types.js';

/**
 * 主代理模式枚举（4状态循环）
 */
export enum MainAgentMode {
	/** YOLO模式：通用主代理，工具自动通过 */
	Yolo = 'yolo',
	/** Yolo+Team模式：Team主代理，工具自动通过 */
	YoloTeam = 'yolo-team',
	/** Team模式：Team主代理，工具需要用户审核 */
	Team = 'team',
	/** General模式：通用主代理，工具需要用户审核 */
	General = 'general',
}

/**
 * 内置主代理ID映射到模式
 */
const MODE_AGENT_MAPPING: Record<MainAgentMode, string[]> = {
	[MainAgentMode.Yolo]: ['general'],
	[MainAgentMode.YoloTeam]: ['team'],
	[MainAgentMode.Team]: ['team'],
	[MainAgentMode.General]: ['general'],
};

// ============ 辅助工具函数 ============

/**
 * 读取指定路径的文件内容(如果存在)
 * @param filePath 文件路径
 * @returns 文件内容或空字符串
 */
function readFileIfExists(filePath: string): string {
	try {
		if (fs.existsSync(filePath)) {
			return fs.readFileSync(filePath, 'utf-8').trim();
		}
		return '';
	} catch (error) {
		console.error(`Failed to read file ${filePath}:`, error);
		return '';
	}
}

/**
 * 获取 shell 环境信息
 * @returns {shellPath, shellName} shell路径和小写名称
 */
function getShellInfo(): {shellPath: string; shellName: string} {
	const shellPath = process.env['SHELL'] || process.env['ComSpec'] || '';
	const shellName = path.basename(shellPath).toLowerCase();
	return {shellPath, shellName};
}

/**
 * 根据检测到的操作系统和 shell 获取平台特定的命令要求
 */
function getPlatformCommandsSection(): string {
	const platformType = os.platform();
	const {shellName} = getShellInfo();

	// Windows 使用 cmd.exe
	if (platformType === 'win32' && shellName.includes('cmd')) {
		return `## Platform-Specific Command Requirements

**Current Environment: Windows with cmd.exe**

- Use: \`del\`, \`copy\`, \`move\`, \`findstr\`, \`type\`, \`dir\`, \`mkdir\`, \`rmdir\`, \`set\`, \`if\`
- Avoid: Unix commands (\`rm\`, \`cp\`, \`mv\`, \`grep\`, \`cat\`, \`ls\`)
- Avoid: Modern operators (\`&&\`, \`||\` - use \`&\` and \`|\` instead)
- For complex tasks: Prefer Node.js scripts or npm packages`;
	}

	// Windows 使用 PowerShell 5.x
	if (
		platformType === 'win32' &&
		shellName.includes('powershell') &&
		!shellName.includes('pwsh')
	) {
		return `## Platform-Specific Command Requirements

**Current Environment: Windows with PowerShell 5.x**

- Use: \`Remove-Item\`, \`Copy-Item\`, \`Move-Item\`, \`Select-String\`, \`Get-Content\`, \`Get-ChildItem\`, \`New-Item\`
- Shell operators: \`;\` for command separation, \`-and\`, \`-or\` for logical operations
- Avoid: Modern pwsh features and operators like \`&&\`, \`||\` (only work in PowerShell 7+)
- Note: Avoid \`$(...)\` syntax in certain contexts; use \`@()\` array syntax where applicable
- For complex tasks: Prefer Node.js scripts or npm packages`;
	}

	// Windows 使用 PowerShell 7.x+
	if (platformType === 'win32' && shellName.includes('pwsh')) {
		return `## Platform-Specific Command Requirements

**Current Environment: Windows with PowerShell 7.x+**

- Use: All PowerShell cmdlets (\`Remove-Item\`, \`Copy-Item\`, \`Move-Item\`, \`Select-String\`, \`Get-Content\`, etc.)
- Shell operators: \`;\`, \`&&\`, \`||\`, \`-and\`, \`-or\` are all supported
- Supports cross-platform scripting patterns
- For complex tasks: Prefer Node.js scripts or npm packages`;
	}
	// Windows 使用 Bash
	if (platformType === 'win32' && shellName.includes('bash')) {
		return `## Platform-Specific Command Requirements

**Current Environment: Windows with Bash**

- Use: \`rm\`, \`cp\`, \`mv\`, \`grep\`, \`cat\`, \`ls\`, \`mkdir\`, \`rmdir\`, \`find\`, \`sed\`, \`awk\`
- Supports: \`&&\`, \`||\`, pipes \`|\`, redirection \`>\`, \`<\`, \`>>\`
- 推荐使用管道等手段预筛选出你关心的输出,以过滤掉于你无用的输出.
- For complex tasks: Prefer Node.js scripts or npm packages`;
	}

	// macOS/Linux (bash/zsh/sh/fish)
	if (platformType === 'darwin' || platformType === 'linux') {
		return `## Platform-Specific Command Requirements

**Current Environment: ${
			platformType === 'darwin' ? 'macOS' : 'Linux'
		} with Unix shell**

- Use: \`rm\`, \`cp\`, \`mv\`, \`grep\`, \`cat\`, \`ls\`, \`mkdir\`, \`rmdir\`, \`find\`, \`sed\`, \`awk\`
- Supports: \`&&\`, \`||\`, pipes \`|\`, redirection \`>\`, \`<\`, \`>>\`
- For complex tasks: Prefer Node.js scripts or npm packages`;
	}

	// 未知平台的后备选项
	return `## Platform-Specific Command Requirements

**Current Environment: ${platformType}**

For cross-platform compatibility, prefer Node.js scripts or npm packages when possible.`;
}

/**
 * 获取代理提示，动态读取 AGENTS.md（如果存在）
 * 优先级：全局 AGENTS.md（基础）+ 项目 AGENTS.md（补充）
 * 返回合并后的内容，全局内容在前，项目内容在后
 */
function getAgentsPrompt(): string {
	const agentsContents: string[] = [];

	// 1. 首先读取全局 AGENTS.md（基础内容）
	const globalContent = readFileIfExists(
		path.join(os.homedir(), '.snow', 'AGENTS.md'),
	);
	if (globalContent) {
		agentsContents.push(globalContent);
	}

	// 2. 读取项目级 AGENTS.md（补充内容）
	const projectContent = readFileIfExists(
		path.join(process.cwd(), 'AGENTS.md'),
	);
	if (projectContent) {
		agentsContents.push(projectContent);
	}

	// 3. 返回合并内容
	if (agentsContents.length > 0) {
		const mergedContent = agentsContents.join('\n\n');
		return mergedContent;
	}

	return '';
}

/**
 * 主代理管理器类
 *
 * 负责管理主代理的4状态循环切换、配置加载和系统提示词生成
 * 完全替代现有的getSystemPromptForMode()函数
 */
export class MainAgentManager {
	private currentMode: MainAgentMode = MainAgentMode.Yolo;
	private currentState: MainAgentRuntimeState | null = null;

	/**
	 * 初始化主代理管理器
	 * 默认启动为YOLO模式（仅通用主代理）
	 */
	constructor() {
		this.initializeState();
	}

	/**
	 * 获取当前模式
	 */
	getCurrentMode(): MainAgentMode {
		return this.currentMode;
	}

	/**
	 * 切换到下一个模式（4状态循环）
	 *
	 * 循环顺序：YOLO → Yolo+Team → Team → General → YOLO
	 *
	 * @returns 切换后的新模式
	 */
	switchToNextMode(): MainAgentMode {
		const modeOrder = [
			MainAgentMode.Yolo,
			MainAgentMode.YoloTeam,
			MainAgentMode.Team,
			MainAgentMode.General,
		];

		const currentIndex = modeOrder.indexOf(this.currentMode);
		const nextIndex = (currentIndex + 1) % modeOrder.length;

		this.currentMode = modeOrder[nextIndex] as MainAgentMode;
		this.initializeState();

		return this.currentMode;
	}

	/**
	 * 设置特定模式
	 *
	 * @param mode 要设置的模式
	 */
	setMode(mode: MainAgentMode): void {
		this.currentMode = mode;
		this.initializeState();
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
		// YOLO和YOLO+Team模式工具自动通过
		return (
			this.currentMode === MainAgentMode.Yolo ||
			this.currentMode === MainAgentMode.YoloTeam
		);
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
	 *
	 * @returns 当前主代理配置的子代理列表
	 */
	getAvailableSubAgents(): string[] {
		if (!this.currentState) {
			return [];
		}

		return this.currentState.currentConfig.availableSubAgents;
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
		const {systemPrompt} = config;

		// 创建基础提示词
		let prompt = systemPrompt;

		// 添加 AGENTS.md 内容
		const agentsPrompt = getAgentsPrompt();
		if (agentsPrompt) {
			prompt += '\n\n' + agentsPrompt;
		}

		// 添加环境上下文信息
		const contextInfo = this.createSystemContext();
		if (contextInfo) {
			prompt += '\n\n' + contextInfo;
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

			// 获取当前模式对应的主代理ID列表
			const agentIds = MODE_AGENT_MAPPING[this.currentMode];

			// 选择第一个可用的主代理作为当前主代理
			// 优先级：general > team
			let currentAgentId =
				agentIds.find(id => id === 'general') ||
				agentIds.find(id => id === 'team') ||
				agentIds[0];

			if (!currentAgentId || !mergedConfigs[currentAgentId]) {
				// 如果找不到合适的主代理，回退到general
				currentAgentId = 'general';
			}

			const currentConfig = mergedConfigs[currentAgentId];
			if (!currentConfig) {
				throw new Error(`主代理配置未找到: ${currentAgentId}`);
			}

			this.currentState = {
				currentAgentId,
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

			this.currentState = {
				currentAgentId: 'general',
				currentConfig: generalConfig,
				availableTools: this.convertToChatCompletionTools(),
				availableSubAgents: generalConfig.availableSubAgents,
				lastUpdated: new Date().toISOString(),
			};
		}
	}

	/**
	 * 创建系统上下文信息
	 *
	 * @returns 系统上下文字符串
	 */
	private createSystemContext(): string {
		const now = new Date();
		const platform = (() => {
			const platformType = os.platform();
			switch (platformType) {
				case 'win32':
					return 'Windows';
				case 'darwin':
					return 'macOS';
				case 'linux':
					return 'Linux';
				default:
					return platformType;
			}
		})();

		const shell = (() => {
			const shellPath = process.env['SHELL'] || process.env['ComSpec'] || '';
			const shellName = path.basename(shellPath).toLowerCase();
			if (shellName.includes('cmd')) return 'cmd.exe';
			if (shellName.includes('powershell') || shellName.includes('pwsh'))
				return 'PowerShell';
			if (shellName.includes('zsh')) return 'zsh';
			if (shellName.includes('bash')) return 'bash';
			if (shellName.includes('fish')) return 'fish';
			if (shellName.includes('sh')) return 'sh';
			return shellName || 'shell';
		})();

		let context = `## System Environment

Platform: ${platform}
Shell: ${shell}
Working Directory: ${process.cwd()}

## Current Time

Year: ${now.getFullYear()}
Month: ${now.getMonth() + 1}`;

		// 添加平台特定命令指导
		const platformCommands = getPlatformCommandsSection();
		if (platformCommands) {
			context += '\n\n' + platformCommands;
		}

		return context;
	}

	/**
	 * 将工具ID数组转换为ChatCompletionTool数组
	 *
	 * 注意：这里返回简化版本，实际工具转换应该在API层处理
	 *
	 * @returns ChatCompletionTool数组
	 */
	private convertToChatCompletionTools(): ChatCompletionTool[] {
		// 这里返回空数组，实际工具转换应该由具体的API层处理
		// 主代理管理器只负责管理工具权限配置
		return [];
	}

	/**
	 * 获取模式的描述信息
	 *
	 * @param mode 模式
	 * @returns 模式描述
	 */
	static getModeDescription(mode: MainAgentMode): string {
		switch (mode) {
			case MainAgentMode.Yolo:
				return 'YOLO模式 - 通用主代理，工具自动通过';
			case MainAgentMode.YoloTeam:
				return 'Yolo+Team模式 - Team主代理，工具自动通过';
			case MainAgentMode.Team:
				return 'Team模式 - Team主代理，工具需要用户审核';
			case MainAgentMode.General:
				return 'General模式 - 通用主代理，工具需要用户审核';
			default:
				return '未知模式';
		}
	}

	/**
	 * 获取所有可用模式
	 *
	 * @returns 所有模式的列表
	 */
	static getAllModes(): MainAgentMode[] {
		return [
			MainAgentMode.Yolo,
			MainAgentMode.YoloTeam,
			MainAgentMode.Team,
			MainAgentMode.General,
		];
	}
}

/**
 * 全局主代理管理器实例
 */
export const mainAgentManager = new MainAgentManager();

/**
 * 获取当前系统提示词（替代getSystemPromptForMode）
 *
 * 为了保持向后兼容性，提供这个过渡函数
 *
 * @param planMode 旧的planMode参数（已废弃）
 * @returns 当前模式的系统提示词
 */
export function getCurrentSystemPrompt(_planMode?: boolean): string {
	// 忽略planMode参数，使用新的主代理管理器
	return mainAgentManager.getSystemPrompt();
}

/**
 * 切换主代理模式（替代Ctrl+Y的planMode切换）
 *
 * @returns 切换后的新模式描述
 */
export function switchMainAgentMode(): string {
	const newMode = mainAgentManager.switchToNextMode();
	return MainAgentManager.getModeDescription(newMode);
}

/**
 * 获取当前工具自动通过状态
 *
 * @returns true表示工具自动通过
 */
export function getCurrentToolAutoApproval(): boolean {
	return mainAgentManager.getToolAutoApproval();
}
