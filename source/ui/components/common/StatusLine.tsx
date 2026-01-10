import React from 'react';
import {Box, Text} from 'ink';
import Spinner from 'ink-spinner';
import {useI18n} from '../../../i18n/index.js';
import {useTheme} from '../../contexts/ThemeContext.js';
import {getSimpleMode} from '../../../utils/config/themeConfig.js';
import {calculateContextPercentage} from '../chat/ChatInput.js';
import {smartTruncatePath} from '../../../utils/ui/messageFormatter.js';

// 根据平台返回快捷键显示文本: Windows/Linux使用 Alt+P, macOS使用 Ctrl+P
const getProfileShortcut = () =>
	process.platform === 'darwin' ? 'Ctrl+P' : 'Alt+P';

type VSCodeConnectionStatus =
	| 'disconnected'
	| 'connecting'
	| 'connected'
	| 'error';

type EditorContext = {
	activeFile?: string;
	selectedText?: string;
	cursorPosition?: {line: number; character: number};
	workspacePath?: string;
};

type ContextUsage = {
	inputTokens: number;
	maxContextTokens: number;
	cacheCreationTokens?: number;
	cacheReadTokens?: number;
	cachedTokens?: number;
};

type Props = {
	// 模式信息
	yoloMode?: boolean;
	currentAgentName?: string; // 新增：当前主代理名称
	yoloEnabled?: boolean; // 新增：YOLO开启状态

	// IDE连接信息
	vscodeConnectionStatus?: VSCodeConnectionStatus;
	editorContext?: EditorContext;

	// Token消耗信息
	contextUsage?: ContextUsage;

	// 代码库索引状态
	codebaseIndexing?: boolean;
	codebaseProgress?: {
		totalFiles: number;
		processedFiles: number;
		totalChunks: number;
		currentFile?: string;
		status?: string;
		error?: string;
	} | null;

	// 文件监视器状态
	watcherEnabled?: boolean;
	fileUpdateNotification?: {
		file: string;
		timestamp: number;
	} | null;

	// Profile 信息
	currentProfileName?: string;
};

export default function StatusLine({
	yoloMode = false,
	currentAgentName,
	yoloEnabled,
	vscodeConnectionStatus,
	editorContext,
	contextUsage,
	codebaseIndexing = false,
	codebaseProgress,
	watcherEnabled = false,
	fileUpdateNotification,
	currentProfileName,
}: Props) {
	const {t} = useI18n();
	const {theme} = useTheme();
	const simpleMode = getSimpleMode();

	// 是否显示任何状态信息
	const hasAnyStatus =
		yoloMode ||
		yoloEnabled ||
		currentAgentName ||
		(vscodeConnectionStatus && vscodeConnectionStatus !== 'disconnected') ||
		contextUsage ||
		codebaseIndexing ||
		watcherEnabled ||
		fileUpdateNotification ||
		currentProfileName;

	if (!hasAnyStatus) {
		return null;
	}

	// 简易模式：横向单行显示状态，Token信息单独一行
	if (simpleMode) {
		const statusItems: Array<{text: string; color: string}> = [];

		// Profile - 显示在最前面
		if (currentProfileName) {
			statusItems.push({
				text: `ꚰ ${currentProfileName} | ${getProfileShortcut()} ${
					t.chatScreen.profileSwitchHint
				}`,
				color: theme.colors.menuInfo,
			});
		}

		// YOLO模式 - 仅当开启时显示
		if (yoloEnabled || yoloMode) {
			statusItems.push({text: '❁ YOLO', color: theme.colors.warning});
		}

		// 主代理名称（始终显示）
		if (currentAgentName) {
			statusItems.push({text: currentAgentName, color: '#60A5FA'});
		}

		// IDE连接状态
		if (vscodeConnectionStatus && vscodeConnectionStatus !== 'disconnected') {
			if (vscodeConnectionStatus === 'connecting') {
				statusItems.push({text: '◐ IDE', color: 'yellow'});
			} else if (vscodeConnectionStatus === 'connected') {
				let ideText = '● IDE';
				if (editorContext?.activeFile) {
					ideText += `: ${editorContext.activeFile}`;
					if (editorContext?.selectedText) {
						ideText += ` (${editorContext.selectedText.length} chars)`;
					}
				}
				statusItems.push({text: ideText, color: 'green'});
			} else if (vscodeConnectionStatus === 'error') {
				statusItems.push({text: '○ IDE', color: 'gray'});
			}
		}

		// 代码库索引状态 - 显示错误或索引进度
		if ((codebaseIndexing || codebaseProgress?.error) && codebaseProgress) {
			if (codebaseProgress.error) {
				statusItems.push({
					text: codebaseProgress.error,
					color: 'yellow',
				});
			} else {
				statusItems.push({
					text: `◐ ${t.chatScreen.codebaseIndexingShort || '索引'} ${
						codebaseProgress.processedFiles
					}/${codebaseProgress.totalFiles}`,
					color: 'cyan',
				});
			}
		}

		// 文件监视器状态
		if (!codebaseIndexing && watcherEnabled) {
			statusItems.push({
				text: `☉ ${t.chatScreen.statusWatcherActiveShort || '监视'}`,
				color: 'green',
			});
		}

		// 文件更新通知
		if (fileUpdateNotification) {
			statusItems.push({
				text: `⛁ ${t.chatScreen.statusFileUpdatedShort || '已更新'}`,
				color: 'yellow',
			});
		}

		return (
			<Box flexDirection="column" paddingX={1} marginTop={1}>
				{/* Token信息单独一行 - 显示在最上方 */}
				{contextUsage && (
					<Box marginBottom={1}>
						<Text color={theme.colors.menuSecondary} dimColor>
							{(() => {
								const isAnthropic =
									(contextUsage.cacheCreationTokens || 0) > 0 ||
									(contextUsage.cacheReadTokens || 0) > 0;
								const isOpenAI = (contextUsage.cachedTokens || 0) > 0;

								const percentage = calculateContextPercentage(contextUsage);

								const totalInputTokens = isAnthropic
									? contextUsage.inputTokens +
									  (contextUsage.cacheCreationTokens || 0) +
									  (contextUsage.cacheReadTokens || 0)
									: contextUsage.inputTokens;

								let color: string;
								if (percentage < 50) color = theme.colors.success;
								else if (percentage < 75) color = theme.colors.warning;
								else if (percentage < 90) color = theme.colors.warning;
								else color = theme.colors.error;

								const formatNumber = (num: number) => {
									if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
									return num.toString();
								};

								const hasCacheMetrics = isAnthropic || isOpenAI;

								return (
									<>
										<Text color={color}>{percentage.toFixed(1)}%</Text>
										<Text> · </Text>
										<Text color={color}>{formatNumber(totalInputTokens)}</Text>
										<Text>{t.chatScreen.tokens}</Text>
										{hasCacheMetrics && (
											<>
												<Text> · </Text>
												{isAnthropic && (
													<>
														{(contextUsage.cacheReadTokens || 0) > 0 && (
															<>
																<Text color={theme.colors.menuInfo}>
																	↯{' '}
																	{formatNumber(
																		contextUsage.cacheReadTokens || 0,
																	)}{' '}
																	{t.chatScreen.cached}
																</Text>
															</>
														)}
														{(contextUsage.cacheCreationTokens || 0) > 0 && (
															<>
																{(contextUsage.cacheReadTokens || 0) > 0 && (
																	<Text> · </Text>
																)}
																<Text color={theme.colors.warning}>
																	◆{' '}
																	{formatNumber(
																		contextUsage.cacheCreationTokens || 0,
																	)}{' '}
																	{t.chatScreen.newCache}
																</Text>
															</>
														)}
													</>
												)}
												{isOpenAI && (
													<Text color={theme.colors.menuInfo}>
														↯ {formatNumber(contextUsage.cachedTokens || 0)}{' '}
														{t.chatScreen.cached}
													</Text>
												)}
											</>
										)}
									</>
								);
							})()}
						</Text>
					</Box>
				)}

				{/* 状态信息行 */}
				{statusItems.length > 0 && (
					<Box>
						<Text dimColor>
							{statusItems.map((item, index) => (
								<React.Fragment key={index}>
									{index > 0 && (
										<Text color={theme.colors.menuSecondary}> | </Text>
									)}
									<Text color={item.color}>{item.text}</Text>
								</React.Fragment>
							))}
						</Text>
					</Box>
				)}
			</Box>
		);
	}

	return (
		<Box flexDirection="column" paddingX={1}>
			{/* Token使用信息 - 始终显示在第一行 */}
			{contextUsage && (
				<Box>
					<Text color={theme.colors.menuSecondary} dimColor>
						{(() => {
							const isAnthropic =
								(contextUsage.cacheCreationTokens || 0) > 0 ||
								(contextUsage.cacheReadTokens || 0) > 0;
							const isOpenAI = (contextUsage.cachedTokens || 0) > 0;

							const percentage = calculateContextPercentage(contextUsage);

							const totalInputTokens = isAnthropic
								? contextUsage.inputTokens +
								  (contextUsage.cacheCreationTokens || 0) +
								  (contextUsage.cacheReadTokens || 0)
								: contextUsage.inputTokens;

							let color: string;
							if (percentage < 50) color = theme.colors.success;
							else if (percentage < 75) color = theme.colors.warning;
							else if (percentage < 90) color = theme.colors.warning;
							else color = theme.colors.error;

							const formatNumber = (num: number) => {
								if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
								return num.toString();
							};

							const hasCacheMetrics = isAnthropic || isOpenAI;

							return (
								<>
									<Text color={color}>{percentage.toFixed(1)}%</Text>
									<Text> · </Text>
									<Text color={color}>{formatNumber(totalInputTokens)}</Text>
									<Text>{t.chatScreen.tokens}</Text>
									{hasCacheMetrics && (
										<>
											<Text> · </Text>
											{isAnthropic && (
												<>
													{(contextUsage.cacheReadTokens || 0) > 0 && (
														<>
															<Text color={theme.colors.menuInfo}>
																↯{' '}
																{formatNumber(
																	contextUsage.cacheReadTokens || 0,
																)}{' '}
																{t.chatScreen.cached}
															</Text>
														</>
													)}
													{(contextUsage.cacheCreationTokens || 0) > 0 && (
														<>
															{(contextUsage.cacheReadTokens || 0) > 0 && (
																<Text> · </Text>
															)}
															<Text color={theme.colors.warning}>
																◆{' '}
																{formatNumber(
																	contextUsage.cacheCreationTokens || 0,
																)}{' '}
																{t.chatScreen.newCache}
															</Text>
														</>
													)}
												</>
											)}
											{isOpenAI && (
												<Text color={theme.colors.menuInfo}>
													↯ {formatNumber(contextUsage.cachedTokens || 0)}{' '}
													{t.chatScreen.cached}
												</Text>
											)}
										</>
									)}
								</>
							);
						})()}
					</Text>
				</Box>
			)}

			{/* Profile显示 */}
			{currentProfileName && (
				<Box>
					<Text color={theme.colors.menuInfo} dimColor>
						ꚰ {t.chatScreen.profileCurrent}: {currentProfileName} |{' '}
						{getProfileShortcut()} {t.chatScreen.profileSwitchHint}
					</Text>
				</Box>
			)}

			{/* YOLO模式提示 - 仅当开启时显示 */}
			{(yoloEnabled || yoloMode) && (
				<Box>
					<Text color={theme.colors.warning} dimColor>
						{t.chatScreen.yoloModeActive}
					</Text>
				</Box>
			)}

			{/* 主代理名称 - 始终显示 */}
			{currentAgentName && (
				<Box>
					<Text color="#60A5FA" dimColor>
						当前主代理: {currentAgentName}
					</Text>
				</Box>
			)}

			{/* IDE连接状态 */}
			{vscodeConnectionStatus &&
				(vscodeConnectionStatus === 'connecting' ||
					vscodeConnectionStatus === 'connected' ||
					vscodeConnectionStatus === 'error') && (
					<Box>
						<Text
							color={
								vscodeConnectionStatus === 'connecting'
									? 'yellow'
									: vscodeConnectionStatus === 'error'
									? 'gray'
									: 'green'
							}
							dimColor
						>
							{vscodeConnectionStatus === 'connecting' ? (
								<>
									<Spinner type="dots" /> {t.chatScreen.ideConnecting}
								</>
							) : vscodeConnectionStatus === 'error' ? (
								<>○ {t.chatScreen.ideError}</>
							) : (
								<>
									● {t.chatScreen.ideConnected}
									{editorContext?.activeFile &&
										t.chatScreen.ideActiveFile.replace(
											'{file}',
											smartTruncatePath(editorContext.activeFile),
										)}
									{editorContext?.selectedText &&
										t.chatScreen.ideSelectedText.replace(
											'{count}',
											editorContext.selectedText.length.toString(),
										)}
								</>
							)}
						</Text>
					</Box>
				)}

			{/* 代码库索引状态 - 显示错误或索引进度 */}
			{(codebaseIndexing || codebaseProgress?.error) && codebaseProgress && (
				<Box>
					{codebaseProgress.error ? (
						<Text color="red" dimColor>
							{codebaseProgress.error}
						</Text>
					) : (
						<Text color="cyan" dimColor>
							<Spinner type="dots" />{' '}
							{t.chatScreen.codebaseIndexing
								.replace(
									'{processed}',
									codebaseProgress.processedFiles.toString(),
								)
								.replace('{total}', codebaseProgress.totalFiles.toString())}
							{codebaseProgress.totalChunks > 0 &&
								` (${t.chatScreen.codebaseProgress.replace(
									'{chunks}',
									codebaseProgress.totalChunks.toString(),
								)})`}
						</Text>
					)}
				</Box>
			)}

			{/* 文件监视器状态 */}
			{!codebaseIndexing && watcherEnabled && (
				<Box>
					<Text color="green" dimColor>
						☉ {t.chatScreen.statusWatcherActive}
					</Text>
				</Box>
			)}

			{/* 文件更新通知 */}
			{fileUpdateNotification && (
				<Box>
					<Text color="yellow" dimColor>
						⛁{' '}
						{t.chatScreen.statusFileUpdated.replace(
							'{file}',
							fileUpdateNotification.file,
						)}
					</Text>
				</Box>
			)}
		</Box>
	);
}
