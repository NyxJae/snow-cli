import fs from 'fs/promises';
import type {UsefulInfoItem} from '../../mcp/types/usefulInfo.types.js';

// File content cache with mtime tracking
interface FileContentCache {
	content: string; // File content
	mtime: number; // File modification timestamp
	timestamp: number; // Cache timestamp
}

// In-memory cache for file contents
const fileCache = new Map<string, FileContentCache>();
const MAX_CACHE_SIZE = 100; // Maximum number of cached files

/**
 * Get file content with mtime-based caching
 */
async function getFileContentWithCache(filePath: string): Promise<string> {
	try {
		// Get current file modification time
		const stats = await fs.stat(filePath);
		const currentMtime = stats.mtimeMs;

		// Check if cached and still valid
		const cached = fileCache.get(filePath);
		if (cached && cached.mtime === currentMtime) {
			return cached.content;
		}

		// Read file and update cache
		const content = await fs.readFile(filePath, 'utf-8');

		// Implement LRU-style cache eviction if cache is full
		if (fileCache.size >= MAX_CACHE_SIZE && !cached) {
			// Remove oldest entry by timestamp
			let oldestKey: string | null = null;
			let oldestTimestamp = Infinity;
			for (const [key, value] of fileCache.entries()) {
				if (value.timestamp < oldestTimestamp) {
					oldestTimestamp = value.timestamp;
					oldestKey = key;
				}
			}
			if (oldestKey) {
				fileCache.delete(oldestKey);
			}
		}

		// Cache the content
		fileCache.set(filePath, {
			content,
			mtime: currentMtime,
			timestamp: Date.now(),
		});

		return content;
	} catch (error) {
		throw error;
	}
}

export async function formatUsefulInfoContext(
	items: UsefulInfoItem[],
): Promise<string> {
	if (items.length === 0) {
		return '';
	}

	// 按添加时间倒序排列，取最新的100条
	const MAX_ITEMS = 100;
	const sortedItems = items
		.sort(
			(a, b) =>
				new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
		)
		.slice(0, MAX_ITEMS);

	const lines = [
		'## 📚 Useful Information (Shared Across All Agents)',
		'',
		`The following file sections are tracked as useful information for this session. Showing latest ${sortedItems.length} items (max ${MAX_ITEMS}).`,
		'All agents (main and sub-agents) have access to this shared context.',
		'',
	];

	// Process items in parallel with caching
	const sectionsPromises = sortedItems.map(async item => {
		const header = item.description
			? `### ${item.description}`
			: `### ${item.filePath}`;
		const location = `**Location**: \`${item.filePath}\` [Lines ${item.startLine}-${item.endLine}] (ID: ${item.id})`;

		const sectionLines: string[] = [header, location, '```'];

		try {
			const content = await getFileContentWithCache(item.filePath);
			const contentLines = content.split('\n');
			const selectedLines = contentLines.slice(
				item.startLine - 1,
				item.endLine,
			);
			const formattedContent = selectedLines
				.map((line, index) => `${item.startLine + index}→${line}`)
				.join('\n');
			sectionLines.push(formattedContent);
		} catch (error) {
			sectionLines.push(
				`Error reading file: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}

		sectionLines.push('```', '');
		return sectionLines.join('\n');
	});

	const sections = await Promise.all(sectionsPromises);
	lines.push(...sections);

	lines.push('---');
	lines.push('');
	lines.push('💡 **Important Guidelines**:');
	lines.push('- This information is SHARED across all agents in this session');
	lines.push('- Add useful info PRECISELY - avoid adding entire files');
	lines.push('- MUST update useful info after editing files');
	lines.push('- Use `useful-info-add` to add new sections');
	lines.push('- Use `useful-info-delete` to remove outdated sections');
	lines.push('');

	return lines.join('\n');
}
