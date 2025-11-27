/**
 * Type definitions for Useful Information Service
 */

/**
 * Useful information item - stores only metadata (file path and line range)
 * Content is read dynamically when needed
 */
export interface UsefulInfoItem {
	id: string;
	filePath: string;
	startLine: number;
	endLine: number;
	createdAt: string;
	updatedAt: string;
	tags?: string[];
	description?: string;
}

/**
 * Internal type with content for runtime use
 * Used by formatUsefulInfoContext when content is needed
 */
export interface UsefulInfoItemWithContent extends UsefulInfoItem {
	content: string; // 带行号的文件内容
}

/**
 * Useful information list for a session
 */
export interface UsefulInfoList {
	sessionId: string;
	items: UsefulInfoItem[];
	createdAt: string;
	updatedAt: string;
}

/**
 * File content cache entry
 */
export interface FileContentCache {
	content: string;
	lastModified: number;
	accessedAt: number;
}

/**
 * Callback function type for getting current session ID
 */
export type GetCurrentSessionId = () => string | null;

/**
 * Add useful information request parameters
 */
export interface AddUsefulInfoRequest {
	filePath: string;
	startLine?: number; // 可选，默认为1
	endLine?: number; // 可选，默认为文件末尾
	description?: string; // 可选描述
}

/**
 * Delete useful information request parameters
 */
export interface DeleteUsefulInfoRequest {
	itemId?: string; // 可选，删除指定项
	filePath?: string; // 可选，删除指定文件的所有项
	startLine?: number; // 可选，配合filePath删除指定行号范围
	endLine?: number; // 可选，配合filePath删除指定行号范围
}

/**
 * Batch add useful information request
 */
export interface BatchAddUsefulInfoRequest {
	items: AddUsefulInfoRequest[];
}

/**
 * Batch delete useful information request
 */
export interface BatchDeleteUsefulInfoRequest {
	items: DeleteUsefulInfoRequest[];
}
