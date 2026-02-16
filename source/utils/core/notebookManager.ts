import * as fs from 'fs';
import * as path from 'path';

/**
 * 备忘录条目接口
 */
export interface NotebookEntry {
	id: string;
	filePath: string;
	note: string;
	createdAt: string;
	updatedAt: string;
}

/**
 * 备忘录数据结构
 */
interface NotebookData {
	[filePath: string]: NotebookEntry[];
}

/**
 * 文件夹笔记数据结构
 */
export interface FolderNotebook {
	folderPath: string;
	entries: NotebookEntry[];
}

const MAX_ENTRIES_PER_FILE = 50;

/**
 * 获取备忘录存储目录
 */
function getNotebookDir(): string {
	const projectRoot = process.cwd();
	const notebookDir = path.join(projectRoot, '.snow', 'notebook');
	if (!fs.existsSync(notebookDir)) {
		fs.mkdirSync(notebookDir, {recursive: true});
	}
	return notebookDir;
}

/**
 * 获取当前项目的备忘录文件路径
 */
function getNotebookFilePath(): string {
	const projectRoot = process.cwd();
	const projectName = path.basename(projectRoot);
	const notebookDir = getNotebookDir();
	return path.join(notebookDir, `${projectName}.json`);
}

/**
 * 读取备忘录数据
 */
export function readNotebookData(): NotebookData {
	const filePath = getNotebookFilePath();

	if (!fs.existsSync(filePath)) {
		return {};
	}

	try {
		const content = fs.readFileSync(filePath, 'utf-8');
		return JSON.parse(content) as NotebookData;
	} catch (error) {
		console.error('Failed to read notebook data:', error);
		return {};
	}
}

/**
 * 备忘录路径类型
 */
type NotebookPathKind = 'folder' | 'file';

/**
 * 备忘录路径信息
 */
interface NotebookPathInfo {
	original: string;
	segments: string[];
	isFolder: boolean;
}

/**
 * 获取备忘录路径信息,用于排序
 */
function getNotebookPathInfo(filePath: string): NotebookPathInfo {
	let normalized = filePath.replace(/\\/g, '/');
	if (normalized.startsWith('./')) {
		normalized = normalized.substring(2);
	}
	const isRoot = normalized === '/';
	const isFolder = isRoot || normalized.endsWith('/');
	const trimmed = isRoot ? '' : isFolder ? normalized.slice(0, -1) : normalized;
	const segments = trimmed ? trimmed.split('/').filter(Boolean) : [];
	return {
		original: filePath,
		segments,
		isFolder,
	};
}

/**
 * 获取某个路径段的类型(文件夹或文件)
 */
function getSegmentKind(
	pathInfo: NotebookPathInfo,
	segmentIndex: number,
): NotebookPathKind {
	if (segmentIndex < pathInfo.segments.length - 1) {
		return 'folder';
	}
	return pathInfo.isFolder ? 'folder' : 'file';
}

/**
 * 按 ASCII/Unicode 顺序比较字符串
 */
function comparePathSegment(a: string, b: string): number {
	if (a === b) {
		return 0;
	}
	return a < b ? -1 : 1;
}

/**
 * 按树形顺序比较两个路径
 */
function compareNotebookPaths(pathA: string, pathB: string): number {
	if (pathA === pathB) {
		return 0;
	}

	const infoA = getNotebookPathInfo(pathA);
	const infoB = getNotebookPathInfo(pathB);
	const minLength = Math.min(infoA.segments.length, infoB.segments.length);

	for (let index = 0; index < minLength; index++) {
		const segmentA = infoA.segments[index]!;
		const segmentB = infoB.segments[index]!;

		if (segmentA !== segmentB) {
			const kindA = getSegmentKind(infoA, index);
			const kindB = getSegmentKind(infoB, index);
			if (kindA !== kindB) {
				return kindA === 'folder' ? -1 : 1;
			}
			return comparePathSegment(segmentA, segmentB);
		}
	}

	if (infoA.segments.length !== infoB.segments.length) {
		const isAShorter = infoA.segments.length < infoB.segments.length;
		const shorterInfo = isAShorter ? infoA : infoB;
		if (shorterInfo.isFolder) {
			return infoA.segments.length - infoB.segments.length;
		}
		return isAShorter ? 1 : -1;
	}

	if (infoA.isFolder !== infoB.isFolder) {
		return infoA.isFolder ? -1 : 1;
	}

	return comparePathSegment(infoA.original, infoB.original);
}

/**
 * 对备忘录数据按路径树形顺序排序
 */
function sortNotebookDataByPath(data: NotebookData): NotebookData {
	const sortedEntries = Object.entries(data)
		.filter(([, entries]) => entries.length > 0)
		.sort((entryA, entryB) => compareNotebookPaths(entryA[0], entryB[0]));
	const sortedData: NotebookData = {};
	for (const [filePath, entries] of sortedEntries) {
		sortedData[filePath] = entries;
	}
	return sortedData;
}

/**
 * 保存备忘录数据
 */
function saveNotebookData(data: NotebookData): void {
	const filePath = getNotebookFilePath();
	const sortedData = sortNotebookDataByPath(data);

	try {
		fs.writeFileSync(filePath, JSON.stringify(sortedData, null, 2), 'utf-8');
	} catch (error) {
		console.error('Failed to save notebook data:', error);
		throw error;
	}
}

/**
 * 规范化文件路径（转换为相对于项目根目录的路径）
 */
function normalizePath(filePath: string): string {
	const projectRoot = process.cwd();

	// 如果是绝对路径，转换为相对路径
	if (path.isAbsolute(filePath)) {
		return path.relative(projectRoot, filePath).replace(/\\/g, '/');
	}

	// 已经是相对路径，规范化斜杠并移除 ./ 前缀
	let normalized = filePath.replace(/\\/g, '/');
	// 移除开头的 ./ 前缀
	if (normalized.startsWith('./')) {
		normalized = normalized.substring(2);
	}
	return normalized;
}

/**
 * 规范化文件夹路径，确保以 / 结尾
 */
export function normalizeFolderPath(folderPath: string): string {
	const normalized = normalizePath(folderPath);
	return normalized.endsWith('/') ? normalized : normalized + '/';
}

/**
 * 判断路径是否为文件夹路径
 * 1. 如果路径以 / 结尾，返回 true
 * 2. 如果路径存在且是目录，返回 true
 * 3. 否则返回 false
 */
export async function isFolderPath(filePath: string): Promise<boolean> {
	// 如果路径明确以 / 结尾，直接判定为文件夹
	if (filePath.endsWith('/')) {
		return true;
	}

	// 尝试检测文件系统中该路径是否为目录
	try {
		const stats = await fs.promises.stat(filePath);
		return stats.isDirectory();
	} catch {
		// 路径不存在或无法访问，不是文件夹
		return false;
	}
}

/**
 * 获取文件路径的所有父级文件夹
 * @param filePath 文件路径，如 "src/api/v2/client.ts"
 * @returns 所有父级文件夹路径数组，从浅到深排序
 * @example getParentFolderPaths("src/api/v2/client.ts") => ["/", "src/", "src/api/", "src/api/v2/"]
 */
export function getParentFolderPaths(filePath: string): string[] {
	const normalized = normalizePath(filePath);
	const parts = normalized.split('/').filter(p => p !== '');
	const folders: string[] = ['/']; // 根目录

	let current = '';
	for (let i = 0; i < parts.length - 1; i++) {
		current += parts[i] + '/';
		folders.push(current);
	}

	return folders;
}

/**
 * 收集文件路径上所有文件夹的笔记
 * @param filePath 文件路径
 * @param maxEntriesPerFolder 每个文件夹最多显示的笔记条数，默认5条
 * @returns 有笔记的文件夹列表，按路径深度排序（从浅到深）
 */
export function collectFolderNotebooks(
	filePath: string,
	maxEntriesPerFolder: number = 5,
): FolderNotebook[] {
	const folderPaths = getParentFolderPaths(filePath);
	const result: FolderNotebook[] = [];
	const notebookData = readNotebookData();

	for (const folderPath of folderPaths) {
		const entries = notebookData[folderPath];
		if (entries && entries.length > 0) {
			result.push({
				folderPath,
				entries: entries.slice(0, maxEntriesPerFolder),
			});
		}
	}

	return result;
}

/**
 * 添加备忘录
 * @param filePath 文件路径
 * @param note 备忘说明
 * @returns 添加的备忘录条目
 */
export function addNotebook(filePath: string, note: string): NotebookEntry {
	const normalizedPath = normalizePath(filePath);
	const data = readNotebookData();

	if (!data[normalizedPath]) {
		data[normalizedPath] = [];
	}

	// 创建新的备忘录条目（使用本地时间）
	const now = new Date();
	const localTimeStr = `${now.getFullYear()}-${String(
		now.getMonth() + 1,
	).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(
		now.getHours(),
	).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(
		now.getSeconds(),
	).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}`;

	const entry: NotebookEntry = {
		id: `notebook-${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
		filePath: normalizedPath,
		note,
		createdAt: localTimeStr,
		updatedAt: localTimeStr,
	};

	// 添加到数组开头（最新的在前面）
	data[normalizedPath].unshift(entry);

	// 限制每个文件最多50条备忘录
	if (data[normalizedPath].length > MAX_ENTRIES_PER_FILE) {
		data[normalizedPath] = data[normalizedPath].slice(0, MAX_ENTRIES_PER_FILE);
	}

	saveNotebookData(data);

	return entry;
}

/**
 * 查询备忘录
 * @param filePathPattern 文件路径（支持模糊匹配）
 * @param topN 返回最新的N条记录（默认10）
 * @returns 匹配的备忘录条目列表
 */
export function queryNotebook(
	filePathPattern: string = '',
	topN: number = 10,
): NotebookEntry[] {
	const data = readNotebookData();
	const results: NotebookEntry[] = [];

	// 规范化搜索模式（移除 ./ 前缀等）
	const normalizedPattern = filePathPattern
		? normalizePath(filePathPattern).toLowerCase()
		: '';

	// 遍历所有文件路径
	for (const [filePath, entries] of Object.entries(data)) {
		// 如果没有指定模式，或者文件路径包含模式
		if (
			!normalizedPattern ||
			filePath.toLowerCase().includes(normalizedPattern)
		) {
			results.push(...entries);
		}
	}

	// 按创建时间倒序排序（最新的在前）
	results.sort((a, b) => {
		return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
	});

	// 返回 TopN 条记录
	return results.slice(0, topN);
}

/**
 * 获取指定文件的所有备忘录
 * @param filePath 文件路径
 * @returns 该文件的所有备忘录
 */
export function getNotebooksByFile(filePath: string): NotebookEntry[] {
	const normalizedPath = normalizePath(filePath);
	const data = readNotebookData();
	return data[normalizedPath] || [];
}

/**
 * 根据 ID 查找备忘录条目
 * @param notebookId 备忘录ID
 * @returns 找到的条目，未找到返回 null
 */
export function findNotebookById(notebookId: string): NotebookEntry | null {
	const data = readNotebookData();
	for (const [, entries] of Object.entries(data)) {
		const entry = entries.find(e => e.id === notebookId);
		if (entry) {
			// 返回副本以避免外部修改影响原始数据
			return {...entry};
		}
	}
	return null;
}

/**
 * 更新备忘录内容
 * @param notebookId 备忘录ID
 * @param newNote 新的备忘说明
 * @returns 更新后的备忘录条目，如果未找到则返回null
 */
export function updateNotebook(
	notebookId: string,
	newNote: string,
): NotebookEntry | null {
	const data = readNotebookData();
	let updatedEntry: NotebookEntry | null = null;

	for (const [, entries] of Object.entries(data)) {
		const entry = entries.find(e => e.id === notebookId);
		if (entry) {
			// 更新笔记内容和更新时间
			entry.note = newNote;
			const now = new Date();
			entry.updatedAt = `${now.getFullYear()}-${String(
				now.getMonth() + 1,
			).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(
				now.getHours(),
			).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(
				now.getSeconds(),
			).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}`;

			updatedEntry = entry;
			break;
		}
	}

	if (updatedEntry) {
		saveNotebookData(data);
	}

	return updatedEntry;
}

/**
 * 删除备忘录
 * @param notebookId 备忘录ID
 * @returns 是否删除成功
 */
export function deleteNotebook(notebookId: string): boolean {
	const data = readNotebookData();
	let found = false;

	for (const [, entries] of Object.entries(data)) {
		const index = entries.findIndex(entry => entry.id === notebookId);
		if (index !== -1) {
			entries.splice(index, 1);
			found = true;
			break;
		}
	}

	if (found) {
		saveNotebookData(data);
	}

	return found;
}

/**
 * 清空指定文件的所有备忘录
 * @param filePath 文件路径
 */
export function clearNotebooksByFile(filePath: string): void {
	const normalizedPath = normalizePath(filePath);
	const data = readNotebookData();

	if (data[normalizedPath]) {
		delete data[normalizedPath];
		saveNotebookData(data);
	}
}

/**
 * 获取所有备忘录统计信息
 */
export function getNotebookStats(): {
	totalFiles: number;
	totalEntries: number;
	files: Array<{path: string; count: number}>;
} {
	const data = readNotebookData();
	const files = Object.entries(data).map(([path, entries]) => ({
		path,
		count: entries.length,
	}));

	const totalEntries = files.reduce((sum, file) => sum + file.count, 0);

	return {
		totalFiles: files.length,
		totalEntries,
		files: files.sort((a, b) => b.count - a.count),
	};
}

// ============================================================
// Notebook 快照追踪（用于会话回滚时逆向还原 notebook 操作）
// 支持 add / update / delete 三种操作的回滚
// ============================================================

/**
 * Notebook 操作记录类型
 * - add:    回滚时删除该条目
 * - update: 回滚时恢复旧内容
 * - delete: 回滚时重新插入完整条目
 */
type NotebookOperation =
	| {op: 'add'; notebookId: string}
	| {op: 'update'; notebookId: string; previousNote: string}
	| {op: 'delete'; entry: NotebookEntry};

/**
 * 快照追踪数据结构
 * key: "sessionId:messageIndex"  value: NotebookOperation[]
 */
interface NotebookSnapshotData {
	[key: string]: NotebookOperation[];
}

/**
 * 获取 notebook 快照追踪文件路径
 */
function getNotebookSnapshotFilePath(): string {
	const projectRoot = process.cwd();
	const projectName = path.basename(projectRoot);
	const notebookDir = getNotebookDir();
	return path.join(notebookDir, `${projectName}_snapshots.json`);
}

/**
 * 读取 notebook 快照追踪数据
 */
function readNotebookSnapshotData(): NotebookSnapshotData {
	const filePath = getNotebookSnapshotFilePath();
	if (!fs.existsSync(filePath)) {
		return {};
	}
	try {
		const content = fs.readFileSync(filePath, 'utf-8');
		return JSON.parse(content) as NotebookSnapshotData;
	} catch {
		return {};
	}
}

/**
 * 保存 notebook 快照追踪数据
 */
function saveNotebookSnapshotData(data: NotebookSnapshotData): void {
	const filePath = getNotebookSnapshotFilePath();
	try {
		fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
	} catch (error) {
		console.error('Failed to save notebook snapshot data:', error);
	}
}

/**
 * 向快照追踪中追加一条操作记录
 */
function appendNotebookOperation(
	sessionId: string,
	messageIndex: number,
	operation: NotebookOperation,
): void {
	const data = readNotebookSnapshotData();
	const key = `${sessionId}:${messageIndex}`;
	if (!data[key]) {
		data[key] = [];
	}
	data[key].push(operation);
	saveNotebookSnapshotData(data);
}

/**
 * 记录 notebook-add 操作（回滚时将删除该条目）
 */
export function recordNotebookAddition(
	sessionId: string,
	messageIndex: number,
	notebookId: string,
): void {
	appendNotebookOperation(sessionId, messageIndex, {
		op: 'add',
		notebookId,
	});
}

/**
 * 记录 notebook-update 操作（回滚时将恢复旧内容）
 */
export function recordNotebookUpdate(
	sessionId: string,
	messageIndex: number,
	notebookId: string,
	previousNote: string,
): void {
	appendNotebookOperation(sessionId, messageIndex, {
		op: 'update',
		notebookId,
		previousNote,
	});
}

/**
 * 记录 notebook-delete 操作（回滚时将重新插入完整条目）
 */
export function recordNotebookDeletion(
	sessionId: string,
	messageIndex: number,
	entry: NotebookEntry,
): void {
	appendNotebookOperation(sessionId, messageIndex, {
		op: 'delete',
		entry,
	});
}

/**
 * 获取需要回滚的 notebook 操作列表
 * @param sessionId 会话ID
 * @param targetMessageIndex 目标消息索引（>=此索引的所有操作都会被回滚）
 * @returns 需要回滚的操作数组
 */
export function getNotebookOpsToRollback(
	sessionId: string,
	targetMessageIndex: number,
): NotebookOperation[] {
	const data = readNotebookSnapshotData();
	const ops: NotebookOperation[] = [];

	for (const [key, operations] of Object.entries(data)) {
		if (!key.startsWith(`${sessionId}:`)) continue;
		const msgIndex = parseInt(key.split(':')[1] || '', 10);
		if (!isNaN(msgIndex) && msgIndex >= targetMessageIndex) {
			ops.push(...operations);
		}
	}

	return ops;
}

/**
 * 获取需要回滚的 notebook 操作数量（用于 UI 展示）
 */
export function getNotebookRollbackCount(
	sessionId: string,
	targetMessageIndex: number,
): number {
	return getNotebookOpsToRollback(sessionId, targetMessageIndex).length;
}

/**
 * 回滚 notebook：逆向执行 targetMessageIndex 及之后的所有 notebook 操作
 * - add    → 删除该条目
 * - update → 恢复旧 note 内容
 * - delete → 重新插入完整条目
 * @returns 回滚的操作数量
 */
export function rollbackNotebooks(
	sessionId: string,
	targetMessageIndex: number,
): number {
	const ops = getNotebookOpsToRollback(sessionId, targetMessageIndex);

	// 逆序执行，后发生的操作先回滚
	let rolledBackCount = 0;
	for (let i = ops.length - 1; i >= 0; i--) {
		const op = ops[i];
		if (!op) continue;
		try {
			switch (op.op) {
				case 'add':
					// 回滚添加 → 删除
					deleteNotebook(op.notebookId);
					rolledBackCount++;
					break;
				case 'update':
					// 回滚更新 → 恢复旧内容
					updateNotebook(op.notebookId, op.previousNote);
					rolledBackCount++;
					break;
				case 'delete': {
					// 回滚删除 → 重新插入
					const data = readNotebookData();
					const fp = op.entry.filePath;
					if (!data[fp]) {
						data[fp] = [];
					}
					// 插入到对应位置（按时间排序，最新在前）
					data[fp].unshift(op.entry);
					saveNotebookData(data);
					rolledBackCount++;
					break;
				}
			}
		} catch (error) {
			console.error(`Failed to rollback notebook operation:`, error);
		}
	}

	// 清理快照追踪数据
	deleteNotebookSnapshotsFromIndex(sessionId, targetMessageIndex);

	return rolledBackCount;
}

/**
 * 删除指定 messageIndex 及之后的 notebook 快照追踪记录
 */
export function deleteNotebookSnapshotsFromIndex(
	sessionId: string,
	targetMessageIndex: number,
): void {
	const data = readNotebookSnapshotData();
	let changed = false;

	for (const key of Object.keys(data)) {
		if (!key.startsWith(`${sessionId}:`)) continue;
		const msgIndex = parseInt(key.split(':')[1] || '', 10);
		if (!isNaN(msgIndex) && msgIndex >= targetMessageIndex) {
			delete data[key];
			changed = true;
		}
	}

	if (changed) {
		saveNotebookSnapshotData(data);
	}
}

/**
 * 清空指定会话的所有 notebook 快照追踪记录
 */
export function clearAllNotebookSnapshots(sessionId: string): void {
	const data = readNotebookSnapshotData();
	let changed = false;

	for (const key of Object.keys(data)) {
		if (key.startsWith(`${sessionId}:`)) {
			delete data[key];
			changed = true;
		}
	}

	if (changed) {
		saveNotebookSnapshotData(data);
	}
}
