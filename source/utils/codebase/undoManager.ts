import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {logger} from '../core/logger.js';
import {getCurrentLanguage} from '../config/languageConfig.js';
import {translations} from '../../i18n/index.js';

/**
 * 磁盘存储的备份数据结构
 */
interface DiskBackupData {
	tool: 'filesystem-edit' | 'filesystem-edit_search';
	filePaths: string[];
	originalContents: Record<string, string>; // 文件路径 -> 原始内容
	timestamp: number;
}

/**
 * 编辑操作记录 (仅保存元数据, 内容存储在磁盘)
 */
export interface EditOperation {
	tool: 'filesystem-edit' | 'filesystem-edit_search';
	filePaths: string[]; // 被编辑的文件路径列表
	timestamp: number; // 编辑时间戳
	diskFilePath: string; // 磁盘备份文件路径
}

/**
 * 撤销结果
 */
export interface UndoResult {
	success: boolean;
	message: string;
	filesRestored: Array<{
		filePath: string;
		restored: boolean;
	}>;
	stepsUndone: number;
	remainingSteps: number;
	error?: string;
}

/**
 * UndoManager - 撤销栈管理器
 * 管理编辑操作的撤销栈, 提供撤销功能
 * 采用磁盘存储方案, 避免内存泄漏
 */
class UndoManager {
	private static instance: UndoManager;
	private undoStack: EditOperation[];
	private readonly maxStackSize: number;
	private readonly undoDir: string;

	private constructor() {
		this.undoStack = [];
		this.maxStackSize = 100;
		this.undoDir = path.join(os.homedir(), '.snow', 'undo');
	}

	/**
	 * 单例模式获取实例
	 */
	static getInstance(): UndoManager {
		if (!UndoManager.instance) {
			UndoManager.instance = new UndoManager();
		}
		return UndoManager.instance;
	}

	/**
	 * 重置实例 (用于测试)
	 */
	static reset(): void {
		if (UndoManager.instance) {
			UndoManager.instance.undoStack = [];
		}
		UndoManager.instance = undefined as unknown as UndoManager;
	}

	/**
	 * 确保undo目录存在
	 */
	private async ensureUndoDir(): Promise<void> {
		await fs.mkdir(this.undoDir, {recursive: true});
	}

	/**
	 * 生成操作ID
	 */
	private generateOperationId(): string {
		const timestamp = Date.now();
		const random = Math.random().toString(36).substring(2, 8);
		return `${timestamp}_${random}`;
	}

	/**
	 * 获取磁盘备份文件路径
	 */
	private getDiskFilePath(operationId: string): string {
		return path.join(this.undoDir, `${operationId}.json`);
	}

	/**
	 * 将备份数据写入磁盘
	 */
	private async saveToDisk(
		diskFilePath: string,
		data: DiskBackupData,
	): Promise<boolean> {
		try {
			await this.ensureUndoDir();
			await fs.writeFile(diskFilePath, JSON.stringify(data, null, 2), 'utf-8');
			return true;
		} catch (error) {
			logger.error(
				`[UndoManager] Failed to save backup to disk: ${diskFilePath}`,
				error,
			);
			return false;
		}
	}

	/**
	 * 从磁盘读取备份数据
	 */
	private async loadFromDisk(
		diskFilePath: string,
	): Promise<DiskBackupData | null> {
		try {
			const content = await fs.readFile(diskFilePath, 'utf-8');
			return JSON.parse(content) as DiskBackupData;
		} catch (error) {
			logger.error(
				`[UndoManager] Failed to load backup from disk: ${diskFilePath}`,
				error,
			);
			return null;
		}
	}

	/**
	 * 删除磁盘备份文件
	 */
	private async deleteDiskFile(diskFilePath: string): Promise<void> {
		try {
			await fs.unlink(diskFilePath);
		} catch {
			// 文件可能已被删除, 忽略错误
		}
	}

	/**
	 * 记录编辑操作
	 * @param tool 使用的工具名称
	 * @param filePaths 被编辑的文件路径列表
	 * @param originalContents 文件路径 -> 原始内容的映射
	 */
	async recordEditOperation(
		tool: 'filesystem-edit' | 'filesystem-edit_search',
		filePaths: string[],
		originalContents: Map<string, string>,
	): Promise<void> {
		try {
			const timestamp = Date.now();
			const operationId = this.generateOperationId();
			const diskFilePath = this.getDiskFilePath(operationId);

			// 将 Map 转换为普通对象以便 JSON 序列化
			const contentsRecord: Record<string, string> = {};
			for (const [filePath, content] of originalContents.entries()) {
				contentsRecord[filePath] = content;
			}

			// 构建磁盘存储数据
			const diskData: DiskBackupData = {
				tool,
				filePaths,
				originalContents: contentsRecord,
				timestamp,
			};

			// 写入磁盘
			const saved = await this.saveToDisk(diskFilePath, diskData);
			if (!saved) {
				logger.warn(
					'[UndoManager] Failed to save backup, operation not recorded',
				);
				return;
			}

			// 仅在内存中保存元数据
			const operation: EditOperation = {
				tool,
				filePaths,
				timestamp,
				diskFilePath,
			};

			this.undoStack.push(operation);

			// 限制栈大小, 移除旧操作时同时删除磁盘文件
			if (this.undoStack.length > this.maxStackSize) {
				const removed = this.undoStack.shift();
				if (removed) {
					await this.deleteDiskFile(removed.diskFilePath);
				}
			}
		} catch (error) {
			logger.error('[UndoManager] Failed to record edit operation:', error);
		}
	}

	/**
	 * 撤销操作
	 * @param steps 撤销步数
	 * @param basePath 工作区根目录
	 * @returns 撤销结果
	 */
	async undo(steps: number = 1, basePath: string): Promise<UndoResult> {
		try {
			const currentLanguage = getCurrentLanguage();
			const t = translations[currentLanguage];
			if (this.undoStack.length === 0) {
				return {
					success: false,
					message: t.undoManager.undoFailedEmpty,
					filesRestored: [],
					stepsUndone: 0,
					remainingSteps: 0,
					error: 'undo_stack_empty',
				};
			}

			const actualSteps = Math.min(steps, this.undoStack.length);
			const filesRestored: Array<{filePath: string; restored: boolean}> = [];

			for (let i = 0; i < actualSteps; i++) {
				const operation = this.undoStack.pop();
				if (!operation) continue;

				// 从磁盘读取备份数据
				const diskData = await this.loadFromDisk(operation.diskFilePath);
				if (!diskData) {
					logger.warn(
						`[UndoManager] Backup file not found: ${operation.diskFilePath}`,
					);
					for (const filePath of operation.filePaths) {
						filesRestored.push({filePath, restored: false});
					}
					continue;
				}

				// 恢复每个文件
				for (const filePath of operation.filePaths) {
					const originalContent = diskData.originalContents[filePath];

					if (originalContent === undefined) {
						logger.warn(`[UndoManager] Missing content for file: ${filePath}`);
						filesRestored.push({filePath, restored: false});
						continue;
					}

					try {
						const restored = await this.restoreFile(
							filePath,
							originalContent,
							basePath,
						);
						filesRestored.push({filePath, restored});
					} catch (error) {
						logger.error(
							`[UndoManager] Failed to restore file ${filePath}:`,
							error,
						);
						filesRestored.push({filePath, restored: false});
					}
				}

				// 撤销后删除磁盘备份文件
				await this.deleteDiskFile(operation.diskFilePath);
			}

			const successCount = filesRestored.filter(f => f.restored).length;

			return {
				success: successCount > 0,
				message: t.undoManager.undoSuccess.replace(
					'{steps}',
					String(actualSteps),
				),
				filesRestored,
				stepsUndone: actualSteps,
				remainingSteps: this.undoStack.length,
			};
		} catch (error) {
			logger.error('[UndoManager] Failed to undo:', error);
			const currentLanguage = getCurrentLanguage();
			const t = translations[currentLanguage];
			return {
				success: false,
				message: t.undoManager.undoFailed.replace(
					'{error}',
					error instanceof Error ? error.message : t.undoManager.unknownError,
				),
				filesRestored: [],
				stepsUndone: 0,
				remainingSteps: this.undoStack.length,
				error: 'undo_failed',
			};
		}
	}

	/**
	 * 清空撤销栈并删除所有磁盘备份
	 */
	async clear(): Promise<void> {
		// 删除所有磁盘备份文件
		for (const operation of this.undoStack) {
			await this.deleteDiskFile(operation.diskFilePath);
		}
		this.undoStack = [];
	}

	/**
	 * 获取撤销栈大小
	 */
	getStackSize(): number {
		return this.undoStack.length;
	}

	/**
	 * 获取最近的编辑操作信息
	 */
	getRecentOperations(): EditOperation[] {
		return [...this.undoStack].reverse();
	}

	/**
	 * 恢复文件内容
	 */
	private async restoreFile(
		filePath: string,
		content: string,
		basePath: string,
	): Promise<boolean> {
		try {
			const fullPath = path.isAbsolute(filePath)
				? filePath
				: path.join(basePath, filePath);

			await fs.writeFile(fullPath, content, 'utf-8');
			return true;
		} catch (error) {
			logger.error(`[UndoManager] Failed to restore file ${filePath}:`, error);
			return false;
		}
	}
}

// 导出单例实例
export const undoManager = UndoManager.getInstance();
