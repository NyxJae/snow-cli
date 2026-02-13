import React, {useState, useEffect} from 'react';
import {Box, Text, useInput} from 'ink';
import {
	getMCPServicesInfo,
	refreshMCPToolsCache,
	reconnectMCPService,
} from '../../../utils/execution/mcpToolsManager.js';
import {
	getMCPConfig,
	updateMCPConfig,
} from '../../../utils/config/apiConfig.js';
import {toggleBuiltInService} from '../../../utils/config/disabledBuiltInTools.js';
import {useI18n} from '../../../i18n/I18nContext.js';

interface MCPConnectionStatus {
	name: string;
	connected: boolean;
	tools: string[];
	connectionMethod?: string;
	error?: string;
	isBuiltIn?: boolean;
	enabled?: boolean;
}

interface SelectItem {
	label: string;
	value: string;
	connected?: boolean;
	isBuiltIn?: boolean;
	error?: string;
	isRefreshAll?: boolean;
	enabled?: boolean;
}
interface MCPInfoPanelProps {
	/**
	 * 面板打开来源上下文
	 * 当前未使用，但为未来差异化导航行为预留
	 * @example 'chat' - 从 ChatScreen 通过 /mcp 命令打开
	 * @example 'mcpConfig' - 从 MCPConfigScreen 打开
	 */
	source?: 'chat' | 'mcpConfig';
	/** 关闭面板并返回上一屏的回调函数 */
	onClose: () => void;
}

export default function MCPInfoPanel({
	source: _source,
	onClose,
}: MCPInfoPanelProps) {
	const {t} = useI18n();
	const [mcpStatus, setMcpStatus] = useState<MCPConnectionStatus[]>([]);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [isLoading, setIsLoading] = useState(true);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [isReconnecting, setIsReconnecting] = useState(false);
	const [togglingService, setTogglingService] = useState<string | null>(null);

	const loadMCPStatus = async () => {
		try {
			const servicesInfo = await getMCPServicesInfo();
			const mcpConfig = getMCPConfig();
			const statusList: MCPConnectionStatus[] = servicesInfo.map(service => ({
				name: service.serviceName,
				connected: service.connected,
				tools: service.tools.map(tool => tool.name),
				connectionMethod: service.isBuiltIn ? 'Built-in' : 'External',
				isBuiltIn: service.isBuiltIn,
				error: service.error,
				enabled: service.isBuiltIn
					? service.enabled !== false
					: mcpConfig.mcpServers[service.serviceName]?.enabled !== false,
			}));

			setMcpStatus(statusList);
			setErrorMessage(null);
			setIsLoading(false);
		} catch (error) {
			setErrorMessage(
				error instanceof Error ? error.message : 'Failed to load MCP services',
			);
			setIsLoading(false);
		}
	};

	useEffect(() => {
		let isMounted = true;

		const load = async () => {
			await loadMCPStatus();
		};

		if (isMounted) {
			load();
		}

		return () => {
			isMounted = false;
		};
	}, []);

	const handleServiceSelect = async (item: SelectItem) => {
		setIsReconnecting(true);
		try {
			if (item.value === 'refresh-all') {
				await refreshMCPToolsCache();
			} else if (item.isBuiltIn) {
				await refreshMCPToolsCache();
			} else {
				await reconnectMCPService(item.value);
			}
			await loadMCPStatus();
		} catch (error) {
			setErrorMessage(
				error instanceof Error ? error.message : 'Failed to reconnect',
			);
		} finally {
			setIsReconnecting(false);
		}
	};

	useInput(async (_, key) => {
		// Esc 优先关闭面板
		if (key.escape) {
			onClose();
			return;
		}

		if (isReconnecting || togglingService) return;

		if (key.upArrow) {
			setSelectedIndex(prev => (prev > 0 ? prev - 1 : selectItems.length - 1));
			return;
		}
		if (key.downArrow) {
			setSelectedIndex(prev => (prev < selectItems.length - 1 ? prev + 1 : 0));
			return;
		}

		if (key.return) {
			const currentItem = selectItems[selectedIndex];
			if (currentItem) {
				await handleServiceSelect(currentItem);
			}
			return;
		}

		// Tab 切换服务启用/禁用状态
		if (key.tab) {
			const currentItem = selectItems[selectedIndex];
			if (currentItem && !currentItem.isRefreshAll) {
				try {
					setTogglingService(currentItem.value);
					const serviceName = currentItem.value;

					if (currentItem.isBuiltIn) {
						toggleBuiltInService(serviceName);
					} else {
						const config = getMCPConfig();
						if (config.mcpServers[serviceName]) {
							const currentEnabled =
								config.mcpServers[serviceName].enabled !== false;
							config.mcpServers[serviceName].enabled = !currentEnabled;
							updateMCPConfig(config);
						}
					}

					await refreshMCPToolsCache();
					await loadMCPStatus();
				} catch (error) {
					setErrorMessage(
						error instanceof Error ? error.message : 'Failed to toggle service',
					);
				} finally {
					setTogglingService(null);
				}
			}
		}
	});

	const selectItems: SelectItem[] = [
		{
			label: t.mcpInfoPanel.refreshAll,
			value: 'refresh-all',
			isRefreshAll: true,
		},
		...mcpStatus.map(s => ({
			label: s.name,
			value: s.name,
			connected: s.connected,
			isBuiltIn: s.isBuiltIn,
			error: s.error,
			enabled: s.enabled,
		})),
	];

	if (isLoading) {
		return <Text color="gray">{t.mcpInfoPanel.loading}</Text>;
	}

	if (errorMessage) {
		return (
			<Box borderColor="red" borderStyle="round" paddingX={2} paddingY={0}>
				<Text color="red" dimColor>
					{t.mcpInfoPanel.error.replace('{message}', errorMessage)}
				</Text>
			</Box>
		);
	}

	if (mcpStatus.length === 0) {
		return (
			<Box borderColor="cyan" borderStyle="round" paddingX={2} paddingY={0}>
				<Text color="gray" dimColor>
					{t.mcpInfoPanel.noServices}
				</Text>
			</Box>
		);
	}

	return (
		<Box borderColor="cyan" borderStyle="round" paddingX={2} paddingY={0}>
			<Box flexDirection="column">
				<Text color="cyan" bold>
					{isReconnecting
						? t.mcpInfoPanel.refreshing
						: togglingService
						? t.mcpInfoPanel.toggling.replace('{service}', togglingService)
						: t.mcpInfoPanel.title}
				</Text>
				{!isReconnecting &&
					!togglingService &&
					selectItems.map((item, index) => {
						const isSelected = index === selectedIndex;

						// Render refresh-all item
						if (item.isRefreshAll) {
							return (
								<Box key={item.value}>
									<Text color={isSelected ? 'cyan' : 'blue'}>
										{isSelected ? '❯ ' : '  '}↻ {t.mcpInfoPanel.refreshAll}
									</Text>
								</Box>
							);
						}

						// Check if service is disabled
						const isEnabled = item.enabled !== false;
						const statusColor = !isEnabled
							? 'gray'
							: item.connected
							? 'green'
							: 'red';
						const suffix = !isEnabled
							? t.mcpInfoPanel.statusDisabled
							: item.isBuiltIn
							? t.mcpInfoPanel.statusSystem
							: item.connected
							? t.mcpInfoPanel.statusExternal
							: ` - ${item.error || t.mcpInfoPanel.statusFailed}`;

						return (
							<Box key={item.value}>
								<Text>
									{isSelected ? '❯ ' : '  '}
									<Text color={statusColor}>● </Text>
									<Text
										color={isSelected ? 'cyan' : !isEnabled ? 'gray' : 'white'}
									>
										{item.label}
									</Text>
									<Text color="gray" dimColor>
										{suffix}
									</Text>
								</Text>
							</Box>
						);
					})}
				{(isReconnecting || togglingService) && (
					<Text color="yellow" dimColor>
						{t.mcpInfoPanel.pleaseWait}
					</Text>
				)}
				{!isReconnecting && !togglingService && (
					<>
						<Text color="gray" dimColor>
							{t.mcpInfoPanel.navigationHint}
						</Text>
						<Text color="yellow" dimColor>
							{t.mcpInfoPanel.toolPermissionHint}
						</Text>
					</>
				)}
			</Box>
		</Box>
	);
}
