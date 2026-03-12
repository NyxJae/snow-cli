import React from 'react';
import {Box, Text} from 'ink';
import MarkdownRenderer from '../common/MarkdownRenderer.js';
import {getSubAgent} from '../../../utils/config/subAgentConfig.js';

/**
 * 子代理执行结果显示组件的属性接口
 */
interface SubAgentResultProps {
	/** Agent类型标识符（如：'explore', 'general', 或自定义Agent ID） */
	agentType: string;
	/** 显示的完整内容 */
	content: string;
	/** 执行状态 */
	status: 'success' | 'error' | 'timeout';
	/** 执行耗时（毫秒） */
	executionTime?: number;
}

// 内置Agent的图标和颜色配置
const BUILTIN_AGENT_CONFIG: Record<
	string,
	{icon: string; color: string; name: string}
> = {
	explore: {icon: '🤖', color: 'cyan', name: 'Explore Agent'},
	general: {icon: '🔧', color: 'magenta', name: 'General Agent'},
};

// 默认配置（用于自定义Agent）
const DEFAULT_CONFIG = {
	icon: '⚙️',
	color: 'yellow',
};

/**
 * 子代理执行结果显示组件
 *
 * 根据Agent类型动态显示图标、颜色和名称：
 * - 内置Agent(explore/general)使用特殊配置
 * - 自定义Agent从subAgentConfig.ts获取信息
 * - 未知Agent使用默认样式
 */
export default function SubAgentResultDisplay({
	agentType,
	content,
	status,
	executionTime,
}: SubAgentResultProps) {
	// 构造Agent ID（确保与subAgentConfig.ts中的格式一致）
	const agentId = agentType.startsWith('agent_')
		? agentType
		: `agent_${agentType}`;
	const agentInfo = getSubAgent(agentId);

	// 确定显示配置
	let displayIcon: string;
	let displayColor: string;
	let displayName: string;

	if (BUILTIN_AGENT_CONFIG[agentType]) {
		// 内置Agent使用特殊配置
		const config = BUILTIN_AGENT_CONFIG[agentType];
		displayIcon = config.icon;
		displayColor = config.color;
		displayName = config.name;
	} else if (agentInfo) {
		// 自定义Agent使用配置信息
		displayIcon = DEFAULT_CONFIG.icon;
		displayColor = DEFAULT_CONFIG.color;
		displayName = agentInfo.name;
	} else {
		// 未知Agent使用默认配置
		displayIcon = DEFAULT_CONFIG.icon;
		displayColor = DEFAULT_CONFIG.color;
		displayName = `Agent (${agentType})`;
	}

	// 状态图标映射
	const statusIcon =
		status === 'success' ? '✓' : status === 'error' ? '❌' : '⏰';

	// 常量定义
	const MILLISECONDS_PER_SECOND = 1000;
	const TIME_PRECISION = 2;

	return (
		<Box flexDirection="column">
			<Text color={displayColor}>
				{displayIcon} {displayName} Result {statusIcon}
				{executionTime &&
					` (${(executionTime / MILLISECONDS_PER_SECOND).toFixed(
						TIME_PRECISION,
					)}s)`}
			</Text>
			<Box
				borderStyle="single"
				borderColor={displayColor}
				paddingX={1}
				marginLeft={0}
			>
				<MarkdownRenderer content={content || ' '} />
			</Box>
		</Box>
	);
}
