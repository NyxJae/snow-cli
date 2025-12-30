import React, {useState, useCallback} from 'react';
import {Box, Text, useApp, useInput} from 'ink';
import {spawn, execSync} from 'child_process';
import {
	writeFileSync,
	readFileSync,
	existsSync,
	copyFileSync,
	mkdirSync,
} from 'fs';
import {join, dirname} from 'path';
import {homedir, platform} from 'os';
import {
	getMCPConfig,
	validateMCPConfig,
	getGlobalMCPConfigPath,
	getProjectMCPConfigPathPublic,
} from '../../utils/config/apiConfig.js';
import {gracefulExit} from '../../utils/core/processManager.js';
import {useTheme} from '../contexts/ThemeContext.js';

type Props = {
	onBack: () => void;
	onSave: () => void;
};

type ConfigScope = 'global' | 'project';

const CONFIG_DIR = join(homedir(), '.snow');

function checkCommandExists(command: string): boolean {
	if (platform() === 'win32') {
		// Windows: 使用 where 命令检查
		try {
			execSync(`where ${command}`, {
				stdio: 'ignore',
				windowsHide: true,
			});
			return true;
		} catch {
			return false;
		}
	}

	// Unix/Linux/macOS: 使用 command -v
	const shells = ['/bin/sh', '/bin/bash', '/bin/zsh'];
	for (const shell of shells) {
		try {
			execSync(`command -v ${command}`, {
				stdio: 'ignore',
				shell,
				env: process.env,
			});
			return true;
		} catch {
			// Try next shell
		}
	}

	return false;
}

function getSystemEditor(): string | null {
	// 优先使用环境变量指定的编辑器 (所有平台)
	const envEditor = process.env['VISUAL'] || process.env['EDITOR'];
	if (envEditor && checkCommandExists(envEditor)) {
		return envEditor;
	}

	if (platform() === 'win32') {
		// Windows: 按优先级检测常见编辑器
		const windowsEditors = ['notepad++', 'notepad', 'code', 'vim', 'nano'];
		for (const editor of windowsEditors) {
			if (checkCommandExists(editor)) {
				return editor;
			}
		}
		return null;
	}

	// Unix/Linux/macOS: 按优先级检测常见编辑器
	const editors = ['nano', 'vim', 'vi'];
	for (const editor of editors) {
		if (checkCommandExists(editor)) {
			return editor;
		}
	}

	return null;
}

export default function MCPConfigScreen({onBack}: Props) {
	const {exit} = useApp();
	const {theme} = useTheme();
	const [selectedScope, setSelectedScope] = useState<ConfigScope>('global');
	const [message, setMessage] = useState<string>('');
	const [messageType, setMessageType] = useState<'info' | 'error'>('info');

	const openConfigFile = useCallback(
		(scope: ConfigScope) => {
			try {
				let configPath: string;

				if (scope === 'project') {
					configPath = getProjectMCPConfigPathPublic();
					const projectDir = dirname(configPath);

					// 如果项目级配置不存在，从全局复制
					if (!existsSync(configPath)) {
						if (!existsSync(projectDir)) {
							mkdirSync(projectDir, {recursive: true});
						}
						const globalPath = getGlobalMCPConfigPath();
						if (existsSync(globalPath)) {
							copyFileSync(globalPath, configPath);
							setMessage('已从全局配置复制到项目级');
						} else {
							// 全局配置也不存在，创建空配置
							writeFileSync(configPath, '{}', 'utf8');
							setMessage('已创建项目级配置');
						}
						setMessageType('info');
					}
				} else {
					configPath = getGlobalMCPConfigPath();
					// 确保全局配置存在
					if (!existsSync(configPath)) {
						// 确保目录存在
						if (!existsSync(CONFIG_DIR)) {
							mkdirSync(CONFIG_DIR, {recursive: true});
						}
						// 尝试从 getMCPConfig 获取现有配置并保存
						const config = getMCPConfig();
						writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
					}
				}

				const editor = getSystemEditor();

				if (!editor) {
					console.error(
						'No text editor found! Please set the EDITOR or VISUAL environment variable.',
					);
					console.error('');
					console.error('Examples:');
					if (platform() === 'win32') {
						console.error('  set EDITOR=notepad');
						console.error('  set EDITOR=code');
						console.error('  set EDITOR=notepad++');
					} else {
						console.error('  export EDITOR=nano');
						console.error('  export EDITOR=vim');
						console.error('  export EDITOR=code');
					}
					console.error('');
					console.error('Or install a text editor:');
					if (platform() === 'win32') {
						console.error('  Windows: Notepad++ or VS Code');
					} else {
						console.error('  Ubuntu/Debian: sudo apt-get install nano');
						console.error('  CentOS/RHEL:   sudo yum install nano');
						console.error('  macOS:         nano is usually pre-installed');
					}
					gracefulExit();
					return;
				}

				if (process.stdin.isTTY) {
					process.stdin.pause();
				}

				exit();

				const child = spawn(editor, [configPath], {
					stdio: 'inherit',
				});

				child.on('close', () => {
					if (process.stdin.isTTY) {
						process.stdin.resume();
						process.stdin.setRawMode(true);
					}

					// 读取编辑后的配置
					if (existsSync(configPath)) {
						try {
							const editedContent = readFileSync(configPath, 'utf8');
							const parsedConfig = JSON.parse(editedContent);
							const validationErrors = validateMCPConfig(parsedConfig);

							if (validationErrors.length === 0) {
								console.log(
									'MCP configuration saved successfully! Please use `snow` restart!',
								);
							} else {
								console.error(
									'Configuration errors:',
									validationErrors.join(', '),
								);
							}
						} catch {
							console.error('Invalid JSON format');
						}
					}

					gracefulExit();
				});

				child.on('error', (error: Error) => {
					if (process.stdin.isTTY) {
						process.stdin.resume();
						process.stdin.setRawMode(true);
					}
					console.error('Failed to open editor:', error.message);
					gracefulExit();
				});

				onBack();
			} catch (error) {
				setMessage(
					'打开失败: ' +
						(error instanceof Error ? error.message : String(error)),
				);
				setMessageType('error');
			}
		},
		[exit],
	);

	useInput((_input, key) => {
		// 上下键切换选择
		if (key.upArrow || key.downArrow) {
			setSelectedScope(prev => (prev === 'global' ? 'project' : 'global'));
			setMessage('');
			return;
		}

		// 回车确认选择
		if (key.return) {
			openConfigFile(selectedScope);
			return;
		}

		// Esc 返回
		if (key.escape) {
			onBack();
			return;
		}
	});

	const globalPath = getGlobalMCPConfigPath();
	const projectPath = getProjectMCPConfigPathPublic();

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text bold color={theme.colors.menuInfo}>
					❆ MCP 配置
				</Text>
			</Box>

			<Box marginBottom={1}>
				<Text>请选择要编辑的配置：</Text>
			</Box>

			<Box
				flexDirection="column"
				borderStyle="round"
				borderColor={theme.colors.border}
				paddingX={1}
				paddingY={1}
			>
				{/* 全局配置选项 */}
				<Box flexDirection="column">
					<Text
						color={
							selectedScope === 'global'
								? theme.colors.menuSelected
								: theme.colors.menuNormal
						}
						bold={selectedScope === 'global'}
					>
						{selectedScope === 'global' ? '❯ ' : '  '}全局配置
					</Text>
					{selectedScope === 'global' && (
						<Box marginLeft={3}>
							<Text color={theme.colors.menuSecondary} dimColor>
								{globalPath}
							</Text>
						</Box>
					)}
				</Box>

				{/* 项目配置选项 */}
				<Box flexDirection="column" marginTop={1}>
					<Text
						color={
							selectedScope === 'project'
								? theme.colors.menuSelected
								: theme.colors.menuNormal
						}
						bold={selectedScope === 'project'}
					>
						{selectedScope === 'project' ? '❯ ' : '  '}项目配置
					</Text>
					{selectedScope === 'project' && (
						<Box marginLeft={3}>
							<Text color={theme.colors.menuSecondary} dimColor>
								{projectPath}
							</Text>
						</Box>
					)}
				</Box>
			</Box>

			{/* 消息提示 */}
			{message && (
				<Box marginTop={1}>
					<Text color={messageType === 'error' ? 'red' : 'cyan'}>
						{message}
					</Text>
				</Box>
			)}

			{/* 快捷键提示 */}
			<Box marginTop={1}>
				<Text color={theme.colors.menuSecondary} dimColor>
					↑↓: 选择 | Enter: 确认 | Esc: 返回
				</Text>
			</Box>
		</Box>
	);
}
