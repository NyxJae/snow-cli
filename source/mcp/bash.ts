import {exec} from 'child_process';
// Type definitions
import type {CommandExecutionResult} from './types/bash.types.js';
// Utility functions
import {
	isDangerousCommand,
	truncateOutput,
} from './utils/bash/security.utils.js';
import {processManager} from '../utils/core/processManager.js';
import {appendTerminalOutput} from '../hooks/execution/useTerminalExecutionState.js';

// Global flag to track if command should be moved to background
let shouldMoveToBackground = false;

// Cache for Git Bash availability check
let gitBashAvailable: boolean | null = null;

/**
 * Check if Git Bash is available on the system
 * @returns true if Git Bash is available, false otherwise
 */
function isGitBashAvailable(): boolean {
	// Return cached result if available
	if (gitBashAvailable !== null) {
		return gitBashAvailable;
	}

	// Only check on Windows
	if (process.platform !== 'win32') {
		gitBashAvailable = false;
		return false;
	}

	// Try to detect Git Bash by checking common installation paths
	const commonPaths = [
		'C:\\Program Files\\Git\\bin\\bash.exe',
		'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
		'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
	];

	const {existsSync} = require('fs');
	for (const path of commonPaths) {
		if (existsSync(path)) {
			gitBashAvailable = true;
			return true;
		}
	}

	// If not found in common paths, try to use 'where' command
	try {
		const {execSync} = require('child_process');
		const result = execSync('where bash', {encoding: 'utf8', timeout: 2000});
		gitBashAvailable = result.trim().length > 0;
		return gitBashAvailable;
	} catch {
		gitBashAvailable = false;
		return false;
	}
}
/**
 * Mark command to be moved to background
 * Called from UI when Ctrl+B is pressed
 */
export function markCommandAsBackgrounded() {
	shouldMoveToBackground = true;
}

/**
 * Reset background flag
 */
export function resetBackgroundFlag() {
	shouldMoveToBackground = false;
}

/**
 * Terminal Command Execution Service
 * Executes terminal commands directly using the system's default shell
 */
export class TerminalCommandService {
	private workingDirectory: string;
	private maxOutputLength: number;

	constructor(
		workingDirectory: string = process.cwd(),
		maxOutputLength: number = 10000,
	) {
		this.workingDirectory = workingDirectory;
		this.maxOutputLength = maxOutputLength;
	}

	/**
	 * Execute a terminal command in the working directory
	 * @param command - The command to execute (e.g., "npm -v", "git status")
	 * @param timeout - Timeout in milliseconds (default: 30000ms = 30s)
	 * @param abortSignal - Optional AbortSignal to cancel command execution (e.g., ESC key)
	 * @returns Execution result including stdout, stderr, and exit code
	 * @throws Error if command execution fails critically
	 */
	async executeCommand(
		command: string,
		timeout: number = 30000,
		abortSignal?: AbortSignal,
	): Promise<CommandExecutionResult> {
		const executedAt = new Date().toISOString();

		try {
			// Security check: reject potentially dangerous commands
			if (isDangerousCommand(command)) {
				throw new Error(
					`Dangerous command detected and blocked: ${command.slice(0, 50)}`,
				);
			}
			// Execute command using system default shell and register the process
			// 智能选择 shell: Windows 下优先使用 Git Bash，不可用时回退到 cmd
			const shell =
				process.platform === 'win32' && isGitBashAvailable()
					? 'bash.exe'
					: undefined;

			const childProcess = exec(command, {
				cwd: this.workingDirectory,
				timeout,
				maxBuffer: this.maxOutputLength,
				shell,
				encoding: 'utf8',
				env: {
					...process.env,
					// 指定 UTF-8 编码环境变量
					...(process.platform === 'win32' && {
						LANG: 'zh_CN.UTF-8',
						LC_ALL: 'zh_CN.UTF-8',
						PYTHONIOENCODING: 'utf-8',
					}),
					// Unix/Linux/macOS 设置 UTF-8 编码
					...(process.platform !== 'win32' && {
						LANG: 'en_US.UTF-8',
						LC_ALL: 'en_US.UTF-8',
					}),
				},
			});

			// Register child process for cleanup
			processManager.register(childProcess);

			// Setup abort signal handler if provided
			let abortHandler: (() => void) | undefined;
			if (abortSignal) {
				abortHandler = () => {
					if (childProcess.pid && !childProcess.killed) {
						// Kill the process immediately when abort signal is triggered
						try {
							if (process.platform === 'win32') {
								// Windows: Use taskkill to kill entire process tree
								exec(`taskkill /PID ${childProcess.pid} /T /F 2>NUL`, {
									windowsHide: true,
								});
							} else {
								// Unix: Send SIGTERM
								childProcess.kill('SIGTERM');
							}
						} catch {
							// Ignore errors if process already dead
						}
					}
				};
				abortSignal.addEventListener('abort', abortHandler);
			}

			// Convert to promise
			const {stdout, stderr} = await new Promise<{
				stdout: string;
				stderr: string;
			}>((resolve, reject) => {
				let stdoutData = '';
				let stderrData = '';
				let backgroundProcessId: string | null = null;

				// Add to background processes if PID available
				if (childProcess.pid) {
					import('../hooks/execution/useBackgroundProcesses.js')
						.then(({addBackgroundProcess}) => {
							backgroundProcessId = addBackgroundProcess(
								command,
								childProcess.pid!,
							);
						})
						.catch(() => {
							// Ignore error if module not available
						});
				}

				// Check background flag periodically
				const backgroundCheckInterval = setInterval(() => {
					if (shouldMoveToBackground) {
						clearInterval(backgroundCheckInterval);
						// Reset flag for next command
						resetBackgroundFlag();
						// Resolve immediately with partial output
						resolve({
							stdout:
								stdoutData +
								'\n[Command moved to background, execution continues...]',
							stderr: stderrData,
						});
					}
				}, 100);

				childProcess.stdout?.on('data', chunk => {
					stdoutData += chunk;
					// Send real-time output to UI
					const lines = String(chunk)
						.split('\n')
						.filter(line => line.trim());
					lines.forEach(line => appendTerminalOutput(line));
				});

				childProcess.stderr?.on('data', chunk => {
					stderrData += chunk;
					// Send real-time output to UI
					const lines = String(chunk)
						.split('\n')
						.filter(line => line.trim());
					lines.forEach(line => appendTerminalOutput(line));
				});

				childProcess.on('error', error => {
					clearInterval(backgroundCheckInterval);
					// Update process status
					if (backgroundProcessId) {
						import('../hooks/execution/useBackgroundProcesses.js')
							.then(({updateBackgroundProcessStatus}) => {
								updateBackgroundProcessStatus(
									backgroundProcessId!,
									'failed',
									1,
								);
							})
							.catch(() => {});
					}
					reject(error);
				});

				childProcess.on('close', (code, signal) => {
					clearInterval(backgroundCheckInterval);

					// Update process status
					if (backgroundProcessId) {
						const status = code === 0 ? 'completed' : 'failed';
						import('../hooks/execution/useBackgroundProcesses.js')
							.then(({updateBackgroundProcessStatus}) => {
								updateBackgroundProcessStatus(
									backgroundProcessId!,
									status,
									code || undefined,
								);
							})
							.catch(() => {});
					}

					// Clean up abort handler
					if (abortHandler && abortSignal) {
						abortSignal.removeEventListener('abort', abortHandler);
					}

					if (signal) {
						// Process was killed by signal (e.g., timeout, manual kill, ESC key)
						// CRITICAL: Still preserve stdout/stderr for debugging
						const error: any = new Error(`Process killed by signal ${signal}`);
						error.code = code || 1;
						error.stdout = stdoutData;
						error.stderr = stderrData;
						error.signal = signal;
						reject(error);
					} else if (code === 0) {
						resolve({stdout: stdoutData, stderr: stderrData});
					} else {
						const error: any = new Error(`Process exited with code ${code}`);
						error.code = code;
						error.stdout = stdoutData;
						error.stderr = stderrData;
						reject(error);
					}
				});
			});

			// Truncate output if too long
			return {
				stdout: truncateOutput(stdout, this.maxOutputLength),
				stderr: truncateOutput(stderr, this.maxOutputLength),
				exitCode: 0,
				command,
				executedAt,
			};
		} catch (error: any) {
			// Handle execution errors (non-zero exit codes)
			if (error.code === 'ETIMEDOUT') {
				throw new Error(`Command timed out after ${timeout}ms: ${command}`);
			}

			// Check if aborted by user (ESC key)
			if (abortSignal?.aborted) {
				return {
					stdout: truncateOutput(error.stdout || '', this.maxOutputLength),
					stderr: truncateOutput(
						error.stderr ||
							'Command execution interrupted by user (ESC key pressed)',
						this.maxOutputLength,
					),
					exitCode: 130, // Standard exit code for SIGINT/user interrupt
					command,
					executedAt,
				};
			}

			// For non-zero exit codes, still return the output
			return {
				stdout: truncateOutput(error.stdout || '', this.maxOutputLength),
				stderr: truncateOutput(
					error.stderr || error.message || '',
					this.maxOutputLength,
				),
				exitCode: error.code || 1,
				command,
				executedAt,
			};
		}
	}

	/**
	 * Get current working directory
	 * @returns Current working directory path
	 */
	getWorkingDirectory(): string {
		return this.workingDirectory;
	}

	/**
	 * Change working directory for future commands
	 * @param newPath - New working directory path
	 * @throws Error if path doesn't exist or is not a directory
	 */
	setWorkingDirectory(newPath: string): void {
		this.workingDirectory = newPath;
	}
}

// Export a default instance
export const terminalService = new TerminalCommandService();

// MCP Tool definitions
export const mcpTools = [
	{
		name: 'terminal-execute',
		description:
			'执行终端命令,如 npm、git、构建脚本等。最佳实践:对于文件编辑,MUST ONLY 使用 `filesystem-xxx` 系列工具,不可使用本工具进行任何文件编辑!!!——主要使用场景:(1) 运行构建/测试/代码检查脚本,(2) 版本控制操作,(3) 包管理,(4) 系统工具',
		inputSchema: {
			type: 'object',
			properties: {
				command: {
					type: 'string',
					description:
						'Terminal command to execute. For file editing, filesystem tools are generally preferred.',
				},
				timeout: {
					type: 'number',
					description: 'Timeout in milliseconds (default: 30000)',
					default: 30000,
					maximum: 300000,
				},
			},
			required: ['command'],
		},
	},
];
