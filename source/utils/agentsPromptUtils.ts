/**
 * AGENTS.md 相关工具函数
 * 为主代理和子代理提供 AGENTS.md 内容读取支持
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import {sessionManager} from './session/sessionManager.js';

/**
 * 读取指定路径的文件内容(如果存在)
 * @param filePath 文件路径
 * @returns 文件内容或空字符串
 */
export function readFileIfExists(filePath: string): string {
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
export function getShellInfo(): {shellPath: string; shellName: string} {
	const shellPath = process.env['SHELL'] || process.env['ComSpec'] || '';
	const shellName = path.basename(shellPath).toLowerCase();
	return {shellPath, shellName};
}

/**
 * 根据检测到的操作系统和 shell 获取平台特定的命令要求
 */
export function getPlatformCommandsSection(): string {
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
 * 获取 shell 显示名称
 * @returns shell 显示名称
 */
export function getShellDisplayName(): string {
	const {shellName} = getShellInfo();
	if (shellName.includes('cmd')) return 'cmd.exe';
	if (shellName.includes('powershell') || shellName.includes('pwsh'))
		return 'PowerShell';
	if (shellName.includes('zsh')) return 'zsh';
	if (shellName.includes('bash')) return 'bash';
	if (shellName.includes('fish')) return 'fish';
	if (shellName.includes('sh')) return 'sh';
	return shellName || 'shell';
}

/**
 * 获取平台显示名称
 * @returns 平台显示名称
 */
export function getPlatformDisplayName(): string {
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
}

/**
 * 创建系统上下文信息
 * @returns 系统上下文字符串
 */
export function createSystemContext(): string {
	const now = new Date();
	const platform = getPlatformDisplayName();
	const shell = getShellDisplayName();

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
 * 获取代理提示，动态读取 AGENTS.md（如果存在）
 * 优先级：全局 AGENTS.md（基础）+ 项目 AGENTS.md（补充）
 * 返回合并后的内容，全局内容在前，项目内容在后
 */
export function getAgentsPrompt(): string {
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
 * 获取会话路径信息提示词
 */
export function getSessionPathInfo(): string {
	const sessionPath = sessionManager.getSessionFilePath();

	if (!sessionPath) {
		return '';
	}

	return `本次会话记录全量存储在 \`${sessionPath}\` 中`;
}

/**
 * 获取任务完成标识提示词
 *
 */
export function getTaskCompletionPrompt(): string {
	return `你要不停的使用工具直到完成任务,才可进行一般回复,且MUST在任务完成后的最终回复的最开头或最结尾中添加 \`[Mission_Accomplished!]\` 标记.若想提问必须使用\`askuser-ask_question\`工具提问(若你无此工具则说明你不可提问MUST自主决策)
	`;
}
