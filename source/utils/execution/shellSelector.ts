/**
 * Shell 选择器和编码环境配置
 * 提供智能 shell 选择和 UTF-8 编码环境变量设置
 */

import * as fs from 'fs';
import * as path from 'path';
import {execSync} from 'child_process';
import {getShellInfo} from '../agentsPromptUtils.js';

// 缓存变量
let gitBashAvailable: boolean | null = null;
let gitBashPath: string | null = null;

/**
 * 检测 Git Bash 是否可用
 * 注意：此函数保留以供未来使用，当前 selectShellForExecution() 不再调用它
 * @returns {available: boolean, path?: string}
 */
export function detectGitBash(): {available: boolean; path?: string} {
	// 1. 返回缓存结果
	if (gitBashAvailable !== null) {
		return {
			available: gitBashAvailable,
			path: gitBashAvailable ? gitBashPath || undefined : undefined,
		};
	}

	// 2. 非 Windows 系统直接返回 false
	if (process.platform !== 'win32') {
		gitBashAvailable = false;
		return {available: false};
	}

	// 3. 使用环境变量获取 Program Files 路径
	const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
	const programFilesX86 =
		process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

	// 4. 检查常见安装路径（使用 path.join）
	const commonPaths = [
		path.join(programFiles, 'Git', 'bin', 'bash.exe'),
		path.join(programFilesX86, 'Git', 'bin', 'bash.exe'),
		path.join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
		path.join(programFilesX86, 'Git', 'usr', 'bin', 'bash.exe'),
	];

	for (const bashPath of commonPaths) {
		if (fs.existsSync(bashPath)) {
			gitBashAvailable = true;
			gitBashPath = bashPath;
			return {available: true, path: bashPath};
		}
	}

	// 5. 使用 'where bash' 命令检测（带超时）
	try {
		// 设置超时为 2 秒，防止命令卡住
		const whereResult = execSync('where bash', {
			encoding: 'utf-8',
			timeout: 2000,
			windowsHide: true,
		}).trim();

		if (whereResult) {
			// where 命令可能返回多个路径，取第一个
			const paths = whereResult.split('\n');
			if (paths.length > 0 && paths[0]) {
				const bashPath = paths[0].trim();
				if (fs.existsSync(bashPath)) {
					gitBashAvailable = true;
					gitBashPath = bashPath;
					return {available: true, path: bashPath};
				}
			}
		}
	} catch (error) {
		// where 命令失败或超时，继续检查
	}

	// 6. 缓存结果并返回
	gitBashAvailable = false;
	return {available: false};
}

/**
 * 智能选择 shell
 * 优先级：用户当前 shell > cmd.exe 托底 (Windows) / 系统默认
 * @returns shell 路径或 undefined（使用系统默认）
 */
export function selectShellForExecution(): string | undefined {
	const {shellName, shellPath} = getShellInfo();
	const platform = process.platform;

	// Unix/Linux/macOS - 直接使用系统默认
	if (platform !== 'win32') {
		return undefined;
	}

	// Windows - 优先使用用户当前 shell

	// 1. 用户当前是 bash（包括 Git Bash），直接使用
	if (shellName.includes('bash')) {
		return shellPath || 'bash.exe';
	}

	// 2. 用户当前是 PowerShell，直接使用
	if (shellName.includes('powershell') || shellName.includes('pwsh')) {
		return shellPath || 'powershell.exe';
	}

	// 3. 其他情况，使用 cmd.exe 托底
	return shellPath || 'cmd.exe';
}

/**
 * 获取 UTF-8 编码环境变量
 * @returns 环境变量对象
 */
export function getUtf8EnvVars(): Record<string, string> {
	return {
		PYTHONIOENCODING: 'utf-8',
		LANG: 'en_US.UTF-8',
		LC_ALL: 'en_US.UTF-8',
	};
}
