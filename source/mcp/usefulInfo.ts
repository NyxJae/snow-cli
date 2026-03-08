import {Tool, type CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
// Type definitions
import type {
	UsefulInfoItem,
	UsefulInfoList,
	GetCurrentSessionId,
	AddUsefulInfoRequest,
	DeleteUsefulInfoRequest,
	BatchAddUsefulInfoRequest,
	BatchDeleteUsefulInfoRequest,
} from './types/usefulInfo.types.js';
// Utility functions
import {formatDateForFolder} from './utils/todo/date.utils.js';

/**
 * 有用信息管理服务 - 支持文件内容的精确跟踪和共享
 * 路径结构: ~/.snow/usefulInfo/项目名/YYYY-MM-DD/sessionId.json
 */
export class UsefulInfoService {
	private readonly infoDir: string;
	private readonly legacyInfoDir: string; // 旧格式路径(向下兼容)
	private getCurrentSessionId: GetCurrentSessionId;

	constructor(baseDir: string, getCurrentSessionId: GetCurrentSessionId) {
		// baseDir 现在已经包含了项目ID，直接使用
		// 路径结构: baseDir/YYYY-MM-DD/sessionId.json
		this.infoDir = baseDir;
		// 保存旧格式路径用于向下兼容: ~/.snow/usefulInfo/
		this.legacyInfoDir = path.join(os.homedir(), '.snow', 'usefulInfo');
		this.getCurrentSessionId = getCurrentSessionId;
	}

	async initialize(): Promise<void> {
		await fs.mkdir(this.infoDir, {recursive: true});
	}

	private getInfoPath(sessionId: string, date?: Date): string {
		const sessionDate = date || new Date();
		const dateFolder = formatDateForFolder(sessionDate);
		const infoDir = path.join(this.infoDir, dateFolder);
		return path.join(infoDir, `${sessionId}.json`);
	}

	private async ensureInfoDir(date?: Date): Promise<void> {
		try {
			await fs.mkdir(this.infoDir, {recursive: true});

			if (date) {
				const dateFolder = formatDateForFolder(date);
				const infoDir = path.join(this.infoDir, dateFolder);
				await fs.mkdir(infoDir, {recursive: true});
			}
		} catch (error) {
			// Directory already exists or other error
		}
	}

	/**
	 * 验证文件是否存在
	 */
	private async validateFileExists(filePath: string): Promise<boolean> {
		try {
			await fs.access(filePath);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * 合并重叠或相邻的行号范围
	 */
	private mergeOverlappingRanges(items: UsefulInfoItem[]): UsefulInfoItem[] {
		if (items.length === 0) return [];

		const groupedByFile = new Map<string, UsefulInfoItem[]>();
		for (const item of items) {
			const existing = groupedByFile.get(item.filePath) || [];
			existing.push(item);
			groupedByFile.set(item.filePath, existing);
		}

		const mergedItems: UsefulInfoItem[] = [];

		for (const [, fileItems] of groupedByFile.entries()) {
			const sorted = fileItems.sort((a, b) => a.startLine - b.startLine);

			let current = sorted[0]!;
			for (let i = 1; i < sorted.length; i++) {
				const next = sorted[i]!;

				// Adjacent ranges (line difference <= 1) are merged
				if (next.startLine <= current.endLine + 1) {
					current = {
						...current,
						endLine: Math.max(current.endLine, next.endLine),
						description: current.description
							? next.description
								? `${current.description}; ${next.description}`
								: current.description
							: next.description,
						updatedAt: new Date().toISOString(),
					};
				} else {
					mergedItems.push(current);
					current = next;
				}
			}
			mergedItems.push(current);
		}

		return mergedItems;
	}

	/**
	 * 创建或更新会话的有用信息列表
	 */
	async saveUsefulInfoList(
		sessionId: string,
		items: UsefulInfoItem[],
		existingList?: UsefulInfoList | null,
	): Promise<UsefulInfoList> {
		// 使用现有列表的createdAt信息，或者使用当前时间
		const sessionCreatedAt = existingList?.createdAt
			? new Date(existingList.createdAt).getTime()
			: Date.now();
		const sessionDate = new Date(sessionCreatedAt);
		await this.ensureInfoDir(sessionDate);
		const infoPath = this.getInfoPath(sessionId, sessionDate);

		try {
			const content = await fs.readFile(infoPath, 'utf-8');
			existingList = JSON.parse(content);
		} catch {
			// 文件不存在,创建新的
		}

		const now = new Date().toISOString();
		const infoList: UsefulInfoList = {
			sessionId,
			items,
			createdAt: existingList?.createdAt ?? now,
			updatedAt: now,
		};

		await fs.writeFile(infoPath, JSON.stringify(infoList, null, 2));
		return infoList;
	}

	/**
	 * 获取会话的有用信息列表
	 */
	async getUsefulInfoList(sessionId: string): Promise<UsefulInfoList | null> {
		// 首先尝试从旧格式加载（向下兼容）
		// 旧格式路径: ~/.snow/usefulInfo/sessionId.json
		try {
			const oldInfoPath = path.join(this.legacyInfoDir, `${sessionId}.json`);
			const content = await fs.readFile(oldInfoPath, 'utf-8');
			return JSON.parse(content);
		} catch (error) {
			// 旧格式不存在，搜索日期文件夹
		}

		// 在日期文件夹中查找有用信息
		try {
			const info = await this.findInfoInDateFolders(sessionId);
			return info;
		} catch (error) {
			// 搜索失败
		}

		return null;
	}

	private async findInfoInDateFolders(
		sessionId: string,
	): Promise<UsefulInfoList | null> {
		try {
			const files = await fs.readdir(this.infoDir);

			for (const file of files) {
				const filePath = path.join(this.infoDir, file);
				const stat = await fs.stat(filePath);

				if (stat.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(file)) {
					// 这是日期文件夹，查找有用信息文件
					const infoPath = path.join(filePath, `${sessionId}.json`);
					try {
						const content = await fs.readFile(infoPath, 'utf-8');
						return JSON.parse(content);
					} catch (error) {
						// 文件不存在或读取失败，继续搜索
						continue;
					}
				}
			}
		} catch (error) {
			// 目录读取失败
		}

		return null;
	}

	/**
	 * 添加有用信息项（支持批量）
	 * 返回成功和失败的项
	 */
	async addUsefulInfo(
		sessionId: string,
		requests: AddUsefulInfoRequest[],
	): Promise<{
		list: UsefulInfoList;
		failed: Array<{filePath: string; reason: string}>;
	}> {
		const existingList = await this.getUsefulInfoList(sessionId);
		const existingItems = existingList?.items || [];

		const newItems: UsefulInfoItem[] = [];
		const failed: Array<{filePath: string; reason: string}> = [];

		for (const req of requests) {
			// 验证必须参数
			if (req.startLine === undefined || req.endLine === undefined) {
				failed.push({
					filePath: req.filePath,
					reason:
						'❌ Missing required parameters: startLine and endLine are required. Both startLine and endLine must be specified for each section.',
				});
				continue;
			}

			// 验证行号为正数
			if (req.startLine < 1 || req.endLine < 1) {
				failed.push({
					filePath: req.filePath,
					reason: `❌ Invalid line numbers: startLine (${req.startLine}) and endLine (${req.endLine}) must be positive integers (≥ 1). Line numbers start from 1.`,
				});
				continue;
			}

			// 验证行号范围有效性
			if (req.startLine > req.endLine) {
				failed.push({
					filePath: req.filePath,
					reason: `❌ Invalid line range: startLine (${req.startLine}) cannot be greater than endLine (${req.endLine}). Ensure startLine ≤ endLine.`,
				});
				continue;
			}

			// 验证文件是否存在
			const fileExists = await this.validateFileExists(req.filePath);
			if (!fileExists) {
				failed.push({
					filePath: req.filePath,
					reason: `❌ File not found: "${req.filePath}". Check if the file path is correct and the file exists.`,
				});
				continue;
			}

			// 验证行数限制 - 每个段落最多50行
			const requestedLines = req.endLine - req.startLine + 1;
			if (requestedLines > 50) {
				failed.push({
					filePath: req.filePath,
					reason: `❌ Line count limit exceeded: requested ${requestedLines} lines, but each section must be ≤50 lines. Please split large sections into smaller parts (≤50 lines each) and add only the most relevant content.`,
				});
				continue;
			}

			// 直接使用提供的行号范围
			const startLine = req.startLine;
			const endLine = req.endLine;

			try {
				const content = await fs.readFile(req.filePath, 'utf-8');
				const totalLines = content.split('\n').length;

				let finalStartLine = startLine;
				let finalEndLine = endLine;

				if (finalStartLine < 1) finalStartLine = 1;
				if (finalEndLine > totalLines) finalEndLine = totalLines;
				if (finalStartLine > finalEndLine) {
					failed.push({
						filePath: req.filePath,
						reason: `❌ Invalid line range after adjustment: ${finalStartLine}-${finalEndLine}. The file may have fewer lines than requested.`,
					});
					continue;
				}

				const now = new Date().toISOString();
				const newItem: UsefulInfoItem = {
					id: `info-${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
					filePath: req.filePath,
					startLine: finalStartLine,
					endLine: finalEndLine,
					createdAt: now,
					updatedAt: now,
					description: req.description,
				};

				newItems.push(newItem);
			} catch (error) {
				failed.push({
					filePath: req.filePath,
					reason: `❌ Failed to read or validate file: ${
						error instanceof Error ? error.message : String(error)
					}. Check file permissions and try again.`,
				});
				continue;
			}
		}

		// 合并新旧项，并处理重叠
		const allItems = [...existingItems, ...newItems];
		const mergedItems = this.mergeOverlappingRanges(allItems);

		const list = await this.saveUsefulInfoList(
			sessionId,
			mergedItems,
			existingList,
		);

		return {list, failed};
	}

	/**
	 * 删除有用信息项（支持批量）
	 */
	async deleteUsefulInfo(
		sessionId: string,
		requests: DeleteUsefulInfoRequest[],
	): Promise<UsefulInfoList | null> {
		const existingList = await this.getUsefulInfoList(sessionId);
		if (!existingList) {
			return null;
		}

		let items = existingList.items;

		for (const req of requests) {
			if (req.itemId) {
				// 按ID删除
				items = items.filter(item => item.id !== req.itemId);
			} else if (req.filePath) {
				if (req.startLine !== undefined && req.endLine !== undefined) {
					// 删除指定文件的指定行号范围（完全匹配）
					items = items.filter(
						item =>
							!(
								item.filePath === req.filePath &&
								item.startLine === req.startLine &&
								item.endLine === req.endLine
							),
					);
				} else {
					// 删除指定文件的所有项
					items = items.filter(item => item.filePath !== req.filePath);
				}
			}
		}

		return this.saveUsefulInfoList(sessionId, items, existingList);
	}

	/**
	 * 清理不存在的文件
	 */
	async cleanupNonExistentFiles(
		sessionId: string,
	): Promise<UsefulInfoList | null> {
		const existingList = await this.getUsefulInfoList(sessionId);
		if (!existingList) {
			return null;
		}

		const validItems: UsefulInfoItem[] = [];

		for (const item of existingList.items) {
			const fileExists = await this.validateFileExists(item.filePath);
			if (fileExists) {
				validItems.push(item);
			} else {
				console.log(`Removing non-existent file: ${item.filePath}`);
			}
		}

		if (validItems.length !== existingList.items.length) {
			return this.saveUsefulInfoList(sessionId, validItems, existingList);
		}

		return existingList;
	}

	/**
	 * 删除整个会话的有用信息列表
	 */
	async deleteUsefulInfoList(sessionId: string): Promise<boolean> {
		// 首先尝试删除旧格式（向下兼容）
		try {
			const oldInfoPath = path.join(this.infoDir, `${sessionId}.json`);
			await fs.unlink(oldInfoPath);
			return true;
		} catch (error) {
			// 旧格式不存在，搜索日期文件夹
		}

		// 在日期文件夹中查找并删除有用信息
		try {
			const files = await fs.readdir(this.infoDir);

			for (const file of files) {
				const filePath = path.join(this.infoDir, file);
				const stat = await fs.stat(filePath);

				if (stat.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(file)) {
					// 这是日期文件夹，查找有用信息文件
					const infoPath = path.join(filePath, `${sessionId}.json`);
					try {
						await fs.unlink(infoPath);
						return true;
					} catch (error) {
						// 文件不存在，继续搜索
						continue;
					}
				}
			}
		} catch (error) {
			// 目录读取失败
		}

		return false;
	}

	/**
	 * 获取所有工具定义
	 */
	getTools(): Tool[] {
		return [
			{
				name: 'useful_info-add',
				description: `📚 Add file content to useful information list - SHARED ACROSS ALL AGENTS

⚠️ CRITICAL USAGE RULES:
- Useful information is SHARED across main agent and all sub-agents in this session
- MUST add/update useful info after editing files
- Use line ranges to add only relevant code sections
- ⚠️ MAX 50 LINES PER SECTION.

## 🎯 WHEN TO ADD:
✅ After editing a file - add the modified section (max 50 lines)
✅ Key code sections needed for context (max 50 lines)
✅ Important configurations or constants (max 50 lines)
✅ Complex logic that needs to be referenced (max 50 lines)
❌ DO NOT add entire files
❌ DO NOT add trivial or obvious code
❌ DO NOT exceed 50 lines per section - split large sections if needed

## 💡 BEST PRACTICES:
- Add specific functions/classes, not whole files
- Update after each significant edit
- Use descriptions to explain why this is useful
- Keep the useful info list focused and relevant
- ⚠️ REQUIRED: Always specify startLine and endLine parameters
- ⚠️ LIMIT: Each section must be ≤50 lines (endLine - startLine + 1 ≤ 50)`,
				inputSchema: {
					type: 'object',
					properties: {
						items: {
							type: 'array',
							items: {
								type: 'object',
								properties: {
									filePath: {
										type: 'string',
										description: 'Path to the file (required)',
									},
									startLine: {
										type: 'number',
										description: 'Starting line number (1-indexed, REQUIRED)',
									},
									endLine: {
										type: 'number',
										description: 'Ending line number (1-indexed, REQUIRED)',
									},
									description: {
										type: 'string',
										description:
											'Optional description explaining why this is useful',
									},
								},
								required: ['filePath', 'startLine', 'endLine'],
							},
							description:
								'Array of file sections to add to useful information',
						},
					},
					required: ['items'],
				},
			},
			{
				name: 'useful_info-delete',
				description: `🗑️ Remove items from useful information list

## 📋 DELETION OPTIONS:
1. By item ID - delete specific item
2. By file path - delete all items for a file
3. By file path + line range - delete specific range (exact match required)

## 💡 USAGE:
- Clean up outdated information
- Remove items after file deletion
- Keep the useful info list relevant`,
				inputSchema: {
					type: 'object',
					properties: {
						items: {
							type: 'array',
							items: {
								type: 'object',
								properties: {
									itemId: {
										type: 'string',
										description: 'Item ID to delete (optional)',
									},
									filePath: {
										type: 'string',
										description: 'File path to delete all items for (optional)',
									},
									startLine: {
										type: 'number',
										description:
											'Starting line number for exact match deletion (optional, requires filePath and endLine)',
									},
									endLine: {
										type: 'number',
										description:
											'Ending line number for exact match deletion (optional, requires filePath and startLine)',
									},
								},
							},
							description: 'Array of deletion requests',
						},
					},
					required: ['items'],
				},
			},
			{
				name: 'useful_info-list',
				description: `📋 List all useful information items for current session

Shows all file sections currently tracked as useful information.
Useful for reviewing what context is being shared across agents.`,
				inputSchema: {
					type: 'object',
					properties: {},
				},
			},
		];
	}

	/**
	 * 执行工具调用
	 */
	async executeTool(
		toolName: string,
		args: Record<string, unknown>,
	): Promise<CallToolResult> {
		// 自动获取当前会话 ID
		const sessionId = this.getCurrentSessionId();
		if (!sessionId) {
			return {
				content: [
					{
						type: 'text',
						text: 'Error: No active session found',
					},
				],
				isError: true,
			};
		}

		try {
			switch (toolName) {
				case 'add': {
					const {items} = args as unknown as BatchAddUsefulInfoRequest;
					const result = await this.addUsefulInfo(sessionId, items);

					const addedCount = result.list.items.length;
					const failedCount = result.failed.length;

					const summary = result.list.items.map(item => ({
						id: item.id,
						filePath: item.filePath,
						lines: `${item.startLine}-${item.endLine}`,
						description: item.description,
					}));

					let message = `✅ Added ${addedCount} item(s) to useful info\n\n${summary
						.map(
							(s, i) =>
								`${i + 1}. ${s.filePath} (lines ${s.lines})${
									s.description ? `: ${s.description}` : ''
								}`,
						)
						.join('\n')}\n\nTotal items: ${addedCount}`;

					if (failedCount > 0) {
						message += `\n\n⚠️ Failed to add ${failedCount} item(s):\n${result.failed
							.map((f, i) => `${i + 1}. ${f.filePath}: ${f.reason}`)
							.join('\n')}`;
					}

					return {
						content: [
							{
								type: 'text',
								text: message,
							},
						],
					};
				}

				case 'delete': {
					const {items} = args as unknown as BatchDeleteUsefulInfoRequest;
					const result = await this.deleteUsefulInfo(sessionId, items);

					if (!result) {
						return {
							content: [
								{
									type: 'text',
									text: 'Useful info list not found',
								},
							],
						};
					}

					// Create concise deletion summary
					const remainingCount = result.items.length;
					const message = `🗑️ Deletion complete\n\nRemaining items: ${remainingCount}`;

					return {
						content: [
							{
								type: 'text',
								text: message,
							},
						],
					};
				}

				case 'list': {
					const result = await this.getUsefulInfoList(sessionId);

					if (!result || result.items.length === 0) {
						return {
							content: [
								{
									type: 'text',
									text: 'No useful information found',
								},
							],
						};
					}

					// Format list with metadata only (no content)
					const itemsList = result.items
						.map((item, index) => {
							const lines = `${item.startLine}-${item.endLine}`;
							const desc = item.description ? ` - ${item.description}` : '';
							return `${index + 1}. [${item.id}] ${
								item.filePath
							} (lines ${lines})${desc}`;
						})
						.join('\n');

					const message = `📋 Useful Information (${result.items.length} items)\n\n${itemsList}\n\nSession: ${result.sessionId}\nUpdated: ${result.updatedAt}`;

					return {
						content: [
							{
								type: 'text',
								text: message,
							},
						],
					};
				}

				default:
					return {
						content: [
							{
								type: 'text',
								text: `Unknown tool: ${toolName}`,
							},
						],
						isError: true,
					};
			}
		} catch (error) {
			return {
				content: [
					{
						type: 'text',
						text: `Error executing ${toolName}: ${
							error instanceof Error ? error.message : String(error)
						}`,
					},
				],
				isError: true,
			};
		}
	}
}
