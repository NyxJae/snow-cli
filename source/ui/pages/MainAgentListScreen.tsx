import React, {useState, useCallback, useEffect} from 'react';
import {Box, Text, useInput} from 'ink';
import {Alert} from '@inkjs/ui';
import {
	loadMainAgentConfig,
	saveMainAgentConfig,
	deleteMainAgentConfig,
	existsMainAgentConfig,
} from '../../utils/MainAgentConfigIO.js';
import type {MainAgentConfig} from '../../types/MainAgentConfig.js';
import {getBuiltinMainAgentConfigs} from '../../config/DefaultMainAgentConfig.js';
import {useTerminalSize} from '../../hooks/ui/useTerminalSize.js';
import {useTheme} from '../contexts/ThemeContext.js';
import {useI18n} from '../../i18n/index.js';

type Props = {
	onBack: () => void;
	onEdit: (agentId: string) => void;
	inlineMode?: boolean;
};

export default function MainAgentListScreen({
	onBack,
	onEdit,
	inlineMode = false,
}: Props) {
	const {theme} = useTheme();
	const {columns} = useTerminalSize();
	const {t} = useI18n();
	const [agents, setAgents] = useState<
		Array<{id: string; config: MainAgentConfig; isCustom: boolean}>
	>([]);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [resetSuccess, setResetSuccess] = useState(false);
	const [resetFailed, setResetFailed] = useState(false);

	// Truncate text based on terminal width
	const truncateText = useCallback(
		(text: string, prefixLength: number = 0): string => {
			if (!text) return text;
			const maxLength = Math.max(20, columns - prefixLength - 3 - 5 - 3);
			if (text.length <= maxLength) return text;
			return text.substring(0, maxLength) + '...';
		},
		[columns],
	);

	// Load agents on mount
	useEffect(() => {
		loadAgents();
	}, []);

	const loadAgents = useCallback(() => {
		try {
			// 获取内置默认配置
			const builtinConfigs = getBuiltinMainAgentConfigs();

			// 获取用户配置文件
			const configFile = loadMainAgentConfig();

			// 检查配置文件是否实际存在
			const configExists = existsMainAgentConfig();

			// 合并配置：以用户配置为准，但确保所有内置代理都显示
			const mergedAgents: Record<string, MainAgentConfig> = {};
			const customAgents: Set<string> = new Set();

			// 首先添加所有内置配置
			Object.entries(builtinConfigs).forEach(([id, config]) => {
				mergedAgents[id] = config;
			});

			// 当配置文件存在时，检查配置是否真的被自定义了
			if (configExists) {
				Object.entries(configFile.agents).forEach(([id, config]) => {
					mergedAgents[id] = config;

					// 检查配置是否与内置默认配置相同
					const builtinConfig = builtinConfigs[id];
					if (builtinConfig) {
						// 简单比较：检查关键字段是否相同
						const isSameAsBuiltin =
							config.basicInfo.name === builtinConfig.basicInfo.name &&
							config.basicInfo.description ===
								builtinConfig.basicInfo.description &&
							config.systemPrompt === builtinConfig.systemPrompt &&
							JSON.stringify(config.tools) ===
								JSON.stringify(builtinConfig.tools) &&
							JSON.stringify(config.availableSubAgents) ===
								JSON.stringify(builtinConfig.availableSubAgents);

						// 只有当配置与内置配置不同时，才标记为自定义
						if (!isSameAsBuiltin) {
							customAgents.add(id);
						}
					} else {
						// 如果内置配置中没有这个代理，说明是用户添加的自定义代理
						customAgents.add(id);
					}
				});
			}

			// 转换为列表格式
			const agentList = Object.entries(mergedAgents).map(([id, config]) => ({
				id,
				config: config as MainAgentConfig,
				isCustom: customAgents.has(id), // 是否为自定义配置
			}));

			setAgents(agentList); // 设置代理列表
			if (selectedIndex >= agentList.length && agentList.length > 0) {
				setSelectedIndex(agentList.length - 1);
			}
		} catch (error) {
			console.error('Failed to load main agents:', error);
			// 出错时至少显示内置配置
			try {
				const builtinConfigs = getBuiltinMainAgentConfigs();
				const agentList = Object.entries(builtinConfigs).map(
					([id, config]) => ({
						id,
						config: config as MainAgentConfig,
						isCustom: false, // 出错时都显示为内置
					}),
				);
				setAgents(agentList);
			} catch (fallbackError) {
				console.error('Failed to load builtin configs:', fallbackError);
				setAgents([]); // 空数组，类型兼容
			}
		}
	}, [selectedIndex]);

	const handleReset = useCallback(() => {
		if (agents.length === 0) return;

		const agent = agents[selectedIndex];
		if (!agent) return;

		// 只有内置代理才能重置
		if (agent.config.basicInfo.builtin) {
			try {
				const currentConfig = loadMainAgentConfig();

				// 如果配置文件中有这个代理的配置，删除它
				if (currentConfig.agents[agent.id]) {
					delete currentConfig.agents[agent.id];

					// 如果删除后没有其他代理配置了，删除整个配置文件
					const agentIds = Object.keys(currentConfig.agents);
					if (agentIds.length === 0) {
						// 删除整个配置文件
						deleteMainAgentConfig();
					} else {
						// 保存更新后的配置
						saveMainAgentConfig(currentConfig);
					}
				}

				setResetSuccess(true);
				setTimeout(() => setResetSuccess(false), 2000);
				loadAgents();
			} catch (error) {
				setResetFailed(true);
				setTimeout(() => setResetFailed(false), 2000);
			}
		}
	}, [agents, selectedIndex, loadAgents]);

	useInput((input, key) => {
		if (key.escape) {
			onBack();
			return;
		}

		if (key.upArrow) {
			setSelectedIndex(prev => (prev > 0 ? prev - 1 : agents.length - 1));
		} else if (key.downArrow) {
			setSelectedIndex(prev => (prev < agents.length - 1 ? prev + 1 : 0));
		} else if (key.return) {
			if (agents.length > 0) {
				const agent = agents[selectedIndex];
				if (agent) {
					onEdit(agent.id);
				}
			}
		} else if (input === 'd' || input === 'D') {
			if (agents.length > 0) {
				const agent = agents[selectedIndex];
				// 只有内置代理才能重置
				if (agent?.config.basicInfo.builtin) {
					handleReset();
				}
			}
		}
	});

	return (
		<Box flexDirection="column" padding={1}>
			{!inlineMode && (
				<Box marginBottom={1}>
					<Text bold color={theme.colors.menuInfo}>
						❆ 主代理配置
					</Text>
				</Box>
			)}

			{/* Agent List */}
			<Box
				flexDirection="column"
				borderStyle="round"
				borderColor={theme.colors.border}
				paddingX={1}
				paddingY={1}
			>
				{agents.map((agent, index) => {
					const isSelected = index === selectedIndex;
					const isBuiltin = agent.config.basicInfo.builtin;
					const isCustom = agent.isCustom;
					const typeLabel =
						agent.config.basicInfo.type === 'general' ? '通用' : '团队';

					return (
						<Box key={agent.id} flexDirection="column" marginY={0}>
							<Box>
								<Text
									color={
										isSelected
											? theme.colors.menuSelected
											: theme.colors.menuNormal
									}
									bold={isSelected}
								>
									{isSelected ? '❯ ' : '  '}
									{truncateText(agent.config.basicInfo.name, 20)}
									{isBuiltin && (
										<Text
											color={
												isCustom ? theme.colors.warning : theme.colors.menuInfo
											}
										>
											{' '}
											[{isCustom ? '自定义' : '内置'}]
										</Text>
									)}
									<Text color={theme.colors.menuSecondary}> ({typeLabel})</Text>
								</Text>
							</Box>
							{isSelected && (
								<Box marginLeft={3}>
									<Text color={theme.colors.menuSecondary} dimColor>
										{truncateText(agent.config.basicInfo.description, 25)}
									</Text>
								</Box>
							)}
						</Box>
					);
				})}
			</Box>

			{/* Instructions */}
			<Box marginTop={1} flexDirection="column">
				<Text color={theme.colors.menuSecondary} dimColor>
					↑↓: 选择 | Enter: 编辑 | D: 重置 | Esc: 返回
				</Text>
			</Box>

			{/* Success/Error Messages */}
			{resetSuccess && (
				<Box marginTop={1}>
					<Alert variant="success">
						{agents[selectedIndex]?.config.basicInfo.name
							? t.mainAgent.reset.success.replace(
									'{agentName}',
									agents[selectedIndex].config.basicInfo.name,
							  )
							: t.mainAgent.reset.success.replace('{agentName}', '主代理')}
					</Alert>
				</Box>
			)}
			{resetFailed && (
				<Box marginTop={1}>
					<Alert variant="error">
						{agents[selectedIndex]?.config.basicInfo.name
							? t.mainAgent.reset.failed.replace(
									'{agentName}',
									agents[selectedIndex].config.basicInfo.name,
							  )
							: t.mainAgent.reset.failed.replace('{agentName}', '主代理')}
					</Alert>
				</Box>
			)}
		</Box>
	);
}
