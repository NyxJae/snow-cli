/**
 * 系统提示词动态生成器
 *
 * 可配置主代理系统重构 - 第一阶段.4
 * 实现基于MainAgentConfig的系统提示词动态生成功能，支持变量替换、条件模板组合和工具权限指导
 */

import type {MainAgentConfig} from '../types/MainAgentConfig.js';

/**
 * 系统提示词生成上下文
 */
export interface SystemPromptContext {
	/** 当前环境信息 */
	environment?: {
		/** 当前时间 */
		currentTime?: string;
		/** 工作目录 */
		workingDirectory?: string;
		/** 平台信息 */
		platform?: string;
		/** Shell类型 */
		shell?: string;
	};
}

/**
 * 系统提示词生成器类
 */
export class SystemPromptGenerator {
	/**
	 * 生成完整的系统提示词
	 *
	 * @param config 主代理配置
	 * @param context 可选的生成上下文
	 * @returns 生成的完整系统提示词
	 */
	static generateSystemPrompt(
		config: MainAgentConfig,
		context?: SystemPromptContext,
	): string {
		const {systemPrompt} = config;

		// 1. 生成基础模板
		let prompt = systemPrompt

		// 3. 添加环境上下文信息
		if (context) {
			const contextInfo = this.generateContextInfo(context);
			if (contextInfo) {
				prompt += '\n\n' + contextInfo;
			}
		}

		return prompt.trim();
	}

	/**
	 * 替换模板中的变量
	 *
	 * @param template 模板字符串
	 * @param variables 变量键值对
	 * @returns 替换后的字符串
	 */
	static replaceTemplateVariables(
		template: string,
		variables: Record<string, string>,
	): string {
		let result = template;

		for (const [key, value] of Object.entries(variables)) {
			const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
			result = result.replace(regex, value);
		}

		return result;
	}

	/**
	 * 生成环境上下文信息
	 *
	 * @param context 生成上下文
	 * @returns 环境上下文字符串
	 */
	static generateContextInfo(context: SystemPromptContext): string {
		let contextInfo = '## 当前环境信息\n\n';

		if (context.environment) {
			contextInfo += '### 系统环境\n\n';
			const env = context.environment;

			if (env.currentTime) {
				contextInfo += `- **当前时间**: ${env.currentTime}\n`;
			}
			if (env.workingDirectory) {
				contextInfo += `- **工作目录**: ${env.workingDirectory}\n`;
			}
			if (env.platform) {
				contextInfo += `- **平台**: ${env.platform}\n`;
			}
			if (env.shell) {
				contextInfo += `- **Shell**: ${env.shell}\n`;
			}
			contextInfo += '\n';
		}

		return contextInfo;
	}

}
