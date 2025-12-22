/**
 * 文件夹笔记预处理器
 * 负责管理已读文件夹状态和格式化文件夹笔记消息
 */

import {
	getParentFolderPaths,
	readNotebookData,
	type FolderNotebook,
} from './notebookManager.js';

/**
 * 已读文件夹集合（每个 Agent 实例独立维护）
 * 记录当前会话中已经读取过的文件所属的文件夹路径
 */
let readFolders: Set<string> = new Set();

/**
 * 更新已读文件夹集合
 * @param filePath 读取的文件路径
 * @returns 新添加的文件夹列表（用于判断是否有新内容需要展示）
 */
export function updateReadFolders(filePath: string): string[] {
	const parentFolders = getParentFolderPaths(filePath);
	const newFolders: string[] = [];

	for (const folder of parentFolders) {
		if (!readFolders.has(folder)) {
			readFolders.add(folder);
			newFolders.push(folder);
		}
	}

	return newFolders;
}

/**
 * 清空已读文件夹集合
 * 通常在压缩对话历史后调用
 */
export function clearReadFolders(): void {
	readFolders.clear();
}

/**
 * 获取当前已读文件夹集合
 * @returns 已读文件夹的 Set 副本
 */
export function getReadFolders(): Set<string> {
	return new Set(readFolders);
}

/**
 * 设置已读文件夹集合
 * 用于在子 Agent 执行后恢复主 Agent 的状态
 * @param folders 要设置的文件夹集合
 */
export function setReadFolders(folders: Set<string>): void {
	readFolders.clear();
	for (const folder of folders) {
		readFolders.add(folder);
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
	// 独立的已读文件夹集合
	const instanceReadFolders = new Set<string>();

	return {
		/**
		 * 更新已读文件夹集合
		 */
		updateReadFolders: (filePath: string): string[] => {
			const parentFolders = getParentFolderPaths(filePath);
			const newFolders: string[] = [];

			for (const folder of parentFolders) {
				if (!instanceReadFolders.has(folder)) {
					instanceReadFolders.add(folder);
					newFolders.push(folder);
				}
			}

			return newFolders;
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
			return new Set(instanceReadFolders);
		},

		/**
		 * 格式化文件夹笔记为 user 消息内容
		 */
		formatFolderNotebookContext: (foldersToShow?: string[]): string => {
			// 收集需要展示的文件夹
			const folders = foldersToShow ?? Array.from(instanceReadFolders);

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
 * @param foldersToShow 需要展示笔记的文件夹列表，如果不传则使用当前 readFolders 集合
 * @returns 格式化后的笔记内容，如果没有笔记则返回空字符串
 */
export function formatFolderNotebookContext(foldersToShow?: string[]): string {
	// 收集需要展示的文件夹
	const folders = foldersToShow ?? Array.from(readFolders);

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
