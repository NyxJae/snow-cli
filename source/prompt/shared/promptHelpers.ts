/**
 * Shared helper functions for system prompt generation
 */

import path from 'path';
import os from 'os';
import {loadCodebaseConfig} from '../../utils/config/codebaseConfig.js';

/**
 * Detect if running in PowerShell environment on Windows
 * Returns: 'pwsh' for PowerShell 7+, 'powershell' for Windows PowerShell 5.x, null if not PowerShell
 */
export function detectWindowsPowerShell(): 'pwsh' | 'powershell' | null {
	const psModulePath = process.env['PSModulePath'] || '';
	if (!psModulePath) return null;

	// PowerShell Core (pwsh) typically has paths containing "PowerShell\7" or similar
	if (
		psModulePath.includes('PowerShell\\7') ||
		psModulePath.includes('powershell\\7')
	) {
		return 'pwsh';
	}

	// Windows PowerShell 5.x has WindowsPowerShell in path
	if (psModulePath.toLowerCase().includes('windowspowershell')) {
		return 'powershell';
	}

	// Has PSModulePath but can't determine version, assume PowerShell
	return 'powershell';
}

/**
 * Get system environment info
 * @param includePowerShellVersion - Whether to include PowerShell version detection
 */
export function getSystemEnvironmentInfo(
	includePowerShellVersion = false,
): string {
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
		const platformType = os.platform();

		// Helper to detect Unix shell from SHELL env
		const getUnixShell = (): string | null => {
			const shellPath = process.env['SHELL'] || '';
			const shellName = path.basename(shellPath).toLowerCase();
			if (shellName.includes('zsh')) return 'zsh';
			if (shellName.includes('bash')) return 'bash';
			if (shellName.includes('fish')) return 'fish';
			if (shellName.includes('pwsh')) return 'PowerShell';
			if (shellName.includes('sh')) return 'sh';
			return shellName || null;
		};

		if (platformType === 'win32') {
			// Check for Unix-like environments first (MSYS2, Git Bash, Cygwin)
			const msystem = process.env['MSYSTEM']; // MSYS2/Git Bash
			if (msystem) {
				const unixShell = getUnixShell();
				return unixShell || 'bash';
			}

			// Fallback to native Windows shell detection
			const psType = detectWindowsPowerShell();
			if (psType) {
				if (includePowerShellVersion) {
					return psType === 'pwsh' ? 'PowerShell 7.x' : 'PowerShell 5.x';
				}
				return 'PowerShell';
			}
			return 'cmd.exe';
		}

		// On Unix-like systems, use SHELL environment variable
		return getUnixShell() || 'shell';
	})();

	const workingDirectory = process.cwd();

	return `Platform: ${platform}
Shell: ${shell}
Working Directory: ${workingDirectory}`;
}

/**
 * Check if codebase functionality is enabled
 */
export function isCodebaseEnabled(): boolean {
	try {
		const config = loadCodebaseConfig();
		return config.enabled;
	} catch (error) {
		return false;
	}
}

/**
 * Get current time information
 */
export function getCurrentTimeInfo(): {date: string} {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const day = String(now.getDate()).padStart(2, '0');
	return {date: `${year}-${month}-${day}`};
}

/**
 * Append system environment and time to prompt
 */
export function appendSystemContext(
	prompt: string,
	systemEnv: string,
	timeInfo: {date: string},
): string {
	return `${prompt}

System Environment:
${systemEnv}

Current Date: ${timeInfo.date}`;
}
