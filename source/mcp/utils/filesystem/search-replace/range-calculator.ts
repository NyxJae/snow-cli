/**
 * 实际匹配范围计算器
 *
 * 核心功能：修正基于 searchLines.length 计算的初值 endLine，
 * 返回实际匹配的精确范围，避免重复内容 bug
 */

import {normalizeForComparison} from './normalizer.js';

/**
 * 计算选项
 */
export interface RangeCalculationOptions {
	searchContent: string;
	fileLines: string[];
	startLine: number; // 1-indexed
	initialEndLine: number; // 1-indexed，基于 searchLines.length 的初值
	trimMode?: 'conservative' | 'aggressive';
}

/**
 * 计算结果
 *
 * 如果置信度过低，返回 null 表示应中止替换
 */
export interface CalculatedRange {
	startLine: number;
	endLine: number;
	adjustment: number; // 调整了多少行（负数表示减少，正数表示增加）
	confidence: 'high' | 'medium' | 'low';
}

/**
 * 计算实际匹配的精确范围
 *
 * 核心逻辑：
 * 1. 向后裁剪：从 initialEndLine 向前找第一个非空行
 * 2. 向前裁剪：从 startLine 向后找第一个非空行
 * 3. 一致性验证：计算行数差异，设置置信度
 * 4. 多行尾部验证：对最后 N 行进行相似度比较
 *
 * @param options - 计算选项
 * @returns 精确的范围信息，如果置信度过低返回 null
 */
export function calculateActualMatchRange(
	options: RangeCalculationOptions,
): CalculatedRange | null {
	const {
		searchContent,
		fileLines,
		startLine,
		initialEndLine,
		trimMode = 'conservative',
	} = options;

	// 边界检查
	if (
		startLine < 1 ||
		initialEndLine > fileLines.length ||
		startLine > initialEndLine
	) {
		return null;
	}

	const searchLines = searchContent.split('\n');

	// 边界检查：searchLines 可能为空
	if (searchLines.length === 0) {
		return null;
	}

	const lastSearchLine = normalizeForComparison(
		searchLines[searchLines.length - 1]!,
	);

	// 步骤 1: 向后裁剪（从 initialEndLine 向前找第一个非空行）
	let actualEndLine = initialEndLine;

	while (actualEndLine > startLine) {
		const line = fileLines[actualEndLine - 1]; // 1-indexed -> 0-indexed

		// 边界检查
		if (line === undefined) {
			break;
		}

		const normalizedLine = normalizeForComparison(line);

		// 优先裁剪空行（最安全）
		if (normalizedLine.length === 0) {
			actualEndLine--;
			continue;
		}

		// 检查是否与前一行重复（重复内容 bug 的核心特征）
		if (actualEndLine > startLine) {
			const prevLine = fileLines[actualEndLine - 2];
			if (
				prevLine !== undefined &&
				normalizeForComparison(prevLine) === normalizedLine
			) {
				// 当前行与前一行完全相同，说明是重复，继续回退
				actualEndLine--;
				continue;
			}
		}

		// 检查是否是常见的闭合符（end、}、]）
		const isClosingBrace = /^(end|}|]|\))\s*$/i.test(normalizedLine);
		const isLastSearchClosing = /^(end|}|]|\))\s*$/i.test(lastSearchLine);

		if (isClosingBrace && isLastSearchClosing) {
			// 当前行和搜索结尾都是闭合符，检查是否重复
			// 继续回退，寻找更早的匹配
			actualEndLine--;
			continue;
		}

		// 使用增强的结尾验证
		if (
			isExpectedEnding(
				normalizedLine,
				lastSearchLine,
				fileLines,
				startLine,
				actualEndLine,
				searchLines.length,
			)
		) {
			break;
		}

		// 如果是 conservative 模式，遇到明显不匹配的非空行时继续回退
		// 但限制回退次数，避免无限循环
		if (trimMode === 'conservative') {
			// 检查回退距离，如果已经回退很多行仍未找到匹配，停止
			const distance = initialEndLine - actualEndLine;
			if (distance > Math.max(5, searchLines.length)) {
				// 回退距离过大，使用当前位置
				break;
			}
			// 继续回退，寻找更匹配的行
			actualEndLine--;
		} else {
			// aggressive 模式：立即停止
			break;
		}
	}

	// 步骤 2: 向前裁剪（从 startLine 向后找第一个非空行）
	let actualStartLine = startLine;

	while (actualStartLine < actualEndLine) {
		const line = fileLines[actualStartLine - 1];

		// 边界检查
		if (line === undefined) {
			break;
		}

		if (line.trim().length > 0) {
			break;
		}
		actualStartLine++;
	}

	// 步骤 3: 一致性验证
	const actualLineCount = actualEndLine - actualStartLine + 1;
	const searchLineCount = searchLines.length;
	const lineDiff = Math.abs(searchLineCount - actualLineCount);

	let confidence: 'high' | 'medium' | 'low';

	if (lineDiff > 5) {
		// 差异过大，置信度低，应中止
		return null;
	} else if (lineDiff > 2) {
		confidence = 'low';
	} else if (lineDiff > 0) {
		confidence = 'medium';
	} else {
		confidence = 'high';
	}

	// 步骤 4: 计算调整量
	const adjustment = actualEndLine - initialEndLine;

	return {
		startLine: actualStartLine,
		endLine: actualEndLine,
		adjustment,
		confidence,
	};
}

/**
 * 判断某行是否是搜索内容期望的结尾行
 *
 * 增强版本：
 * - 基于搜索内容最后一行（归一化后）的比较
 * - 多行尾部验证（最后 N 行）
 * - 避免在嵌套块中提前截断
 *
 * @param normalizedLine - 归一化后的当前行
 * @param lastSearchLine - 搜索内容最后一行（归一化后）
 * @param fileLines - 文件行数组
 * @param startLine - 匹配起始行
 * @param currentEndLine - 当前检查的结束行
 * @param searchLineCount - 搜索内容的行数
 * @returns 是否是期望的结尾
 */
function isExpectedEnding(
	normalizedLine: string,
	lastSearchLine: string,
	fileLines: string[],
	startLine: number,
	currentEndLine: number,
	searchLineCount: number,
): boolean {
	// 基础相似度检查
	const similarity = calculateLineSimilarity(normalizedLine, lastSearchLine);
	if (similarity >= 0.8) {
		return true;
	}

	// 多行尾部验证：检查最后 N 行的相似度
	const tailLines = Math.min(3, searchLineCount);
	if (tailLines > 1 && currentEndLine - startLine + 1 >= tailLines) {
		const fileTailLines = fileLines
			.slice(currentEndLine - tailLines, currentEndLine)
			.map(normalizeForComparison);

		const searchTailLines = lastSearchLine.split(' ').slice(-tailLines);

		// 简单检查：文件尾部的关键词是否包含在搜索尾部关键词中
		const fileTailKeywords = fileTailLines.flatMap(line => line.split(' '));
		const searchTailKeywords = searchTailLines;

		const matchCount = fileTailKeywords.filter(kw =>
			searchTailKeywords.some(skw => kw.includes(skw) || skw.includes(kw)),
		).length;

		if (matchCount >= tailLines) {
			return true;
		}
	}

	return false;
}

/**
 * 计算两行的相似度
 *
 * @param line1 - 第一行
 * @param line2 - 第二行
 * @returns 相似度（0-1）
 */
function calculateLineSimilarity(line1: string, line2: string): number {
	// 处理空字符串情况
	if (line1.length === 0 || line2.length === 0) {
		// 如果任一行为空，相似度为 0
		return 0.0;
	}

	if (line1 === line2) {
		return 1.0;
	}

	// 简单的包含关系检查
	if (line1.includes(line2) || line2.includes(line1)) {
		return 0.9;
	}

	// 计算公共字符数
	const set1 = new Set(line1.split(''));
	const set2 = new Set(line2.split(''));

	const intersection = new Set([...set1].filter(x => set2.has(x)));
	const union = new Set([...set1, ...set2]);

	return union.size > 0 ? intersection.size / union.size : 0;
}
