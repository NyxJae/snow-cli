/**
 * 文件夹笔记预处理器
 * 负责管理已读文件夹状态和格式化文件夹笔记消息
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {logger} from './logger.js';
import {
	getParentFolderPaths,
	readNotebookData,
	type FolderNotebook,
} from './notebookManager.js';

/**
 * 已读文件夹映射（每个 Agent 实例独立维护）
 * Key: 文件夹路径
 * Value: 笔记ID列表（最新5条的ID），用于检测笔记更新
 * 通过比较笔记ID列表来判断是否有新笔记或笔记被更新
 */
let readFolders: Map<string, string[]> = new Map();

const readFoldersBaseDir = path.join(os.homedir(), '.snow', 'folder-notebooks');

function getReadFoldersFilePath(projectId: string, sessionId: string): string {
	return path.join(readFoldersBaseDir, projectId, `${sessionId}.json`);
}

function normalizeReadFoldersRecord(
	record: Record<string, unknown>,
): Map<string, string[]> {
	const normalized = new Map<string, string[]>();
	for (const [folder, noteIds] of Object.entries(record)) {
		if (typeof folder !== 'string' || !Array.isArray(noteIds)) {
			continue;
		}
		const filtered = noteIds.filter(
			(id): id is string => typeof id === 'string' && id.trim().length > 0,
		);
		normalized.set(folder, filtered);
	}
	return normalized;
}

/**
 * 保存当前会话的文件夹笔记已读状态
 * 按项目和会话隔离保存,确保不同会话之间互不影响
 */
export async function saveReadFolders(
	sessionId?: string,
	projectId?: string,
): Promise<void> {
	if (!sessionId || !projectId) {
		return;
	}
	try {
		const folderPath = getReadFoldersFilePath(projectId, sessionId);
		await fs.mkdir(path.dirname(folderPath), {recursive: true});
		const payload = Object.fromEntries(readFolders);
		await fs.writeFile(folderPath, JSON.stringify(payload, null, 2));
	} catch (error) {
		logger.warn('Failed to save folder notebook read state:', error);
	}
}

/**
 * 加载指定会话的文件夹笔记已读状态
 * 不存在时保持为空,避免污染新会话
 */
export async function loadReadFolders(
	sessionId?: string,
	projectId?: string,
): Promise<void> {
	if (!sessionId || !projectId) {
		return;
	}
	const folderPath = getReadFoldersFilePath(projectId, sessionId);
	try {
		const data = await fs.readFile(folderPath, 'utf-8');
		const parsed = JSON.parse(data) as Record<string, unknown>;
		const normalized = normalizeReadFoldersRecord(parsed || {});
		readFolders = normalized;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			logger.warn('Failed to load folder notebook read state:', error);
		}
	}
}

/**
 * 删除指定会话的文件夹笔记已读状态
 * 用于 /clear 等彻底清理场景
 */
export async function deleteReadFolders(
	sessionId?: string,
	projectId?: string,
): Promise<void> {
	if (!sessionId || !projectId) {
		return;
	}
	const folderPath = getReadFoldersFilePath(projectId, sessionId);
	try {
		await fs.unlink(folderPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			logger.warn('Failed to delete folder notebook read state:', error);
		}
	}
}

/**
 * 更新已读文件夹集合
 * @param filePath 读取的文件路径
 * @returns 需要展示笔记的文件夹列表（笔记有更新或首次读取）
 */
export function updateReadFolders(filePath: string): string[] {
	const parentFolders = getParentFolderPaths(filePath);
	const currentFoldersToShow: string[] = [];
	const notebookData = readNotebookData();

	for (const folder of parentFolders) {
		// 获取文件夹当前的笔记ID列表（最新5条）
		const entries = notebookData[folder];
		const currentNoteIds: string[] = entries
			? entries.slice(0, 5).map(e => e.id)
			: [];

		// 获取上次显示的笔记ID列表
		const lastShownNoteIds = readFolders.get(folder) || [];

		// 仅对最新5条做ID比较,避免全量对比导致频繁刷新
		if (!arraysEqual(currentNoteIds, lastShownNoteIds)) {
			// 有变化时才更新,减少重复展示
			readFolders.set(folder, currentNoteIds);
			currentFoldersToShow.push(folder);
		}
	}

	return currentFoldersToShow;
}

/**
 * 比较两个字符串数组是否相等
 * @param arr1 第一个数组
 * @param arr2 第二个数组
 * @returns 是否相等
 */
function arraysEqual(arr1: string[], arr2: string[]): boolean {
	if (arr1.length !== arr2.length) return false;
	return arr1.every((val, index) => val === arr2[index]);
}

/**
 * 清空已读文件夹集合
 * 用于新会话与清理场景,避免跨会话复用
 */
export function clearReadFolders(): void {
	readFolders.clear();
}

/**
 * 获取当前已读文件夹集合
 * @returns 已读文件夹的 Set 副本（仅返回文件夹路径，不包含笔记ID）
 */
export function getReadFolders(): Set<string> {
	return new Set(readFolders.keys());
}

/**
 * 设置已读文件夹集合
 * 用于在子 Agent 执行后恢复主 Agent 的状态
 * 注意：由于现在使用 Map 存储笔记ID，此函数会创建空的笔记ID列表
 * @param folders 要设置的文件夹集合
 */
export function setReadFolders(folders: Set<string>): void {
	readFolders.clear();
	for (const folder of folders) {
		// 创建空的笔记ID列表，下次读取时会检测到笔记并更新
		readFolders.set(folder, []);
	}
}

/**
 * 独立的文件夹笔记预处理器实例接口
 */
export interface FolderNotebookPreprocessorInstance {
	updateReadFolders: (filePath: string) => string[];
	clearReadFolders: () => void;
	getReadFolders: () => Set<string>;
	formatFolderNotebookContext: (foldersToShow?: string[]) => string;
}

/**
 * 创建独立的文件夹笔记预处理器实例
 * 用于子 Agent，避免与主 Agent 共享状态
 * @returns 独立的预处理器实例
 */
export function createFolderNotebookPreprocessor(): FolderNotebookPreprocessorInstance {
	// 独立的已读文件夹映射
	const instanceReadFolders: Map<string, string[]> = new Map();

	return {
		/**
		 * 更新已读文件夹集合
		 */
		updateReadFolders: (filePath: string): string[] => {
			const parentFolders = getParentFolderPaths(filePath);
			const currentFoldersToShow: string[] = [];
			const notebookData = readNotebookData();

			for (const folder of parentFolders) {
				// 获取文件夹当前的笔记ID列表（最新5条）
				const entries = notebookData[folder];
				const currentNoteIds: string[] = entries
					? entries.slice(0, 5).map(e => e.id)
					: [];

				// 获取上次显示的笔记ID列表
				const lastShownNoteIds = instanceReadFolders.get(folder) || [];

				// 比较笔记ID列表是否有变化
				if (!arraysEqual(currentNoteIds, lastShownNoteIds)) {
					// 有变化：更新记录并标记为需要显示
					instanceReadFolders.set(folder, currentNoteIds);
					currentFoldersToShow.push(folder);
				}
			}

			return currentFoldersToShow;
		},

		/**
		 * 清空已读文件夹集合
		 */
		clearReadFolders: (): void => {
			instanceReadFolders.clear();
		},

		/**
		 * 获取当前已读文件夹集合
		 */
		getReadFolders: (): Set<string> => {
			return new Set(instanceReadFolders.keys());
		},

		/**
		 * 格式化文件夹笔记为 user 消息内容
		 */
		formatFolderNotebookContext: (foldersToShowParam?: string[]): string => {
			// 收集需要展示的文件夹
			// 优先使用传入的参数，否则使用 instanceReadFolders.keys() 获取所有已读文件夹
			// 这样可以确保即使笔记未变化，已读文件夹的笔记也能正确显示
			const folders =
				foldersToShowParam && foldersToShowParam.length > 0
					? foldersToShowParam
					: Array.from(instanceReadFolders.keys());

			if (folders.length === 0) {
				return '';
			}

			// 收集所有文件夹的笔记
			const allNotebooks: FolderNotebook[] = [];
			const notebookData = readNotebookData();

			for (const folder of folders) {
				const entries = notebookData[folder];
				if (entries && entries.length > 0) {
					allNotebooks.push({
						folderPath: folder,
						entries: entries.slice(0, 5), // 每个文件夹最新5条
					});
				}
			}

			if (allNotebooks.length === 0) {
				return '';
			}

			// 按路径深度排序（从浅到深）
			allNotebooks.sort((a, b) => {
				const depthA = a.folderPath.split('/').length;
				const depthB = b.folderPath.split('/').length;
				if (depthA !== depthB) return depthA - depthB;
				return a.folderPath.localeCompare(b.folderPath);
			});

			// 格式化输出
			let output = `## 📂 Folder Notebooks (Context from read files)\n\n`;
			output += `The following folder notebooks are relevant to files you've read in this session.\n\n`;

			for (const notebook of allNotebooks) {
				const folderName =
					notebook.folderPath === '/'
						? '/ (project root)'
						: notebook.folderPath;
				output += `### ${folderName}\n`;
				notebook.entries.forEach((entry, index) => {
					output += `  ${index + 1}. [${entry.createdAt}] ${entry.note}\n`;
				});
				output += '\n';
			}

			output += `---\n💡 These notes are from folders containing files you've read. They won't repeat.`;

			return output;
		},
	};
}

/**
 * 格式化文件夹笔记为 user 消息内容
 * @param foldersToShowParam 需要展示笔记的文件夹列表，如果不传则使用当前 readFolders 集合
 * @returns 格式化后的笔记内容，如果没有笔记则返回空字符串
 */
export function formatFolderNotebookContext(
	foldersToShowParam?: string[],
): string {
	// 收集需要展示的文件夹
	// 优先使用传入的参数，否则使用 readFolders.keys() 获取所有已读文件夹
	// 这样可以确保即使笔记未变化，已读文件夹的笔记也能正确显示
	const folders =
		foldersToShowParam && foldersToShowParam.length > 0
			? foldersToShowParam
			: Array.from(readFolders.keys());

	if (folders.length === 0) {
		return '';
	}

	// 收集所有文件夹的笔记
	const allNotebooks: FolderNotebook[] = [];
	const notebookData = readNotebookData();

	for (const folder of folders) {
		const entries = notebookData[folder];
		if (entries && entries.length > 0) {
			allNotebooks.push({
				folderPath: folder,
				entries: entries.slice(0, 5), // 每个文件夹最新5条
			});
		}
	}

	if (allNotebooks.length === 0) {
		return '';
	}

	// 按路径深度排序（从浅到深）
	allNotebooks.sort((a, b) => {
		const depthA = a.folderPath.split('/').length;
		const depthB = b.folderPath.split('/').length;
		if (depthA !== depthB) return depthA - depthB;
		return a.folderPath.localeCompare(b.folderPath);
	});

	// 格式化输出
	let output = `## 📂 Folder Notebooks (Context from read files)\n\n`;
	output += `The following folder notebooks are relevant to files you've read in this session.\n\n`;

	for (const notebook of allNotebooks) {
		const folderName =
			notebook.folderPath === '/' ? '/ (project root)' : notebook.folderPath;
		output += `### ${folderName}\n`;
		notebook.entries.forEach((entry, index) => {
			output += `  ${index + 1}. [${entry.createdAt}] ${entry.note}\n`;
		});
		output += '\n';
	}

	output += `---\n💡 These notes are from folders containing files you've read. They won't repeat.`;

	return output;
}
