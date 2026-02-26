import {execSync} from 'child_process';

/**
 * Copy content to clipboard using platform-specific method
 * Supports Windows, macOS, and Linux with Base64 encoding for safe content handling
 *
 * @param content - The string content to copy to clipboard
 * @throws Error if clipboard operation fails
 */
export async function copyToClipboard(content: string): Promise<void> {
	return new Promise((resolve, reject) => {
		try {
			// Convert to Base64 to safely handle special characters (including Chinese, quotes, newlines)
			const base64Content = Buffer.from(content, 'utf-8').toString('base64');

			if (process.platform === 'win32') {
				// Windows: Use PowerShell with Base64 decoding
				execSync(
					`powershell -NoProfile -Command "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64Content}')) | Set-Clipboard"`,
					{encoding: 'utf-8'},
				);
				resolve();
			} else if (process.platform === 'darwin') {
				// macOS: Use pbcopy with Base64 decoding
				execSync(`echo "${base64Content}" | base64 -d | pbcopy`, {
					encoding: 'utf-8',
				});
				resolve();
			} else {
				// Linux: Try xclip first, fallback to xsel
				try {
					execSync(
						`echo "${base64Content}" | base64 -d | xclip -selection clipboard`,
						{encoding: 'utf-8'},
					);
					resolve();
				} catch (xclipError) {
					// Fallback to xsel if xclip is not available
					try {
						execSync(
							`echo "${base64Content}" | base64 -d | xsel --clipboard --input`,
							{encoding: 'utf-8'},
						);
						resolve();
					} catch (xselError) {
						// Both tools failed, let outer catch handle it
						return;
					}
				}
			}
		} catch (error) {
			if (!(error instanceof Error)) {
				reject(new Error('Failed to copy to clipboard: Unknown error'));
				return;
			}

			// Classify error types and provide specific error messages
			const errorMsg = error.message;

			// Tool not found (command not found, ENOENT)
			if (
				errorMsg.includes('command not found') ||
				errorMsg.includes('not found') ||
				errorMsg.includes('spawn ENOENT') ||
				/spawn.*not found/.test(errorMsg)
			) {
				let toolName = 'clipboard tool';
				if (process.platform === 'win32') {
					toolName = 'PowerShell';
				} else if (process.platform === 'darwin') {
					toolName = 'pbcopy';
				} else {
					toolName = 'xclip/xsel';
				}
				reject(
					new Error(
						`Clipboard tool not found: ${toolName} is not available. Please install ${toolName}.`,
					),
				);
				return;
			}

			// Permission errors (EACCES, EPERM)
			if (
				errorMsg.includes('EACCES') ||
				errorMsg.includes('EPERM') ||
				errorMsg.includes('Access denied') ||
				errorMsg.includes('permission denied') ||
				errorMsg.includes('Permission denied')
			) {
				reject(
					new Error(
						'Permission denied: Cannot access clipboard. Please check your permissions.',
					),
				);
				return;
			}

			// Generic error
			reject(new Error(`Failed to copy to clipboard: ${errorMsg}`));
		}
	});
}
