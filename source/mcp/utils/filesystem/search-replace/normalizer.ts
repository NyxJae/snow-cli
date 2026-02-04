/**
 * 统一的归一化策略
 * 与 similarity.utils.ts 保持一致
 */

/**
 * 归一化用于比较的字符串
 * 将连续空白折叠为单个空格，并去除首尾空白
 *
 * @param str - 需要归一化的字符串
 * @returns 归一化后的字符串
 *
 * @example
 * ```typescript
 * normalizeForComparison('  hello   world  ') // 'hello world'
 * normalizeForComparison('line1\n\nline2') // 'line1 line2'
 * ```
 */
export function normalizeForComparison(str: string): string {
	return str.replace(/\s+/g, ' ').trim();
}

/**
 * 归一化行数组（用于多行比较）
 *
 * @param lines - 行数组
 * @returns 归一化后的行数组
 *
 * @example
 * ```typescript
 * normalizeLines(['  hello  ', '  world  ']) // ['hello', 'world']
 * ```
 */
export function normalizeLines(lines: string[]): string[] {
	return lines.map(normalizeForComparison);
}

/**
 * 归一化并合并多行内容
 * 用于相似度计算时的预处理
 *
 * @param lines - 行数组
 * @returns 归一化并合并后的字符串
 *
 * @example
 * ```typescript
 * normalizeAndJoinLines(['line1', 'line2']) // 'line1 line2'
 * normalizeAndJoinLines(['  line1  ', '', '  line2  ']) // 'line1 line2'
 * ```
 */
export function normalizeAndJoinLines(lines: string[]): string {
	const normalized = normalizeLines(lines);
	// 过滤掉空行
	const nonEmpty = normalized.filter(line => line.length > 0);
	return nonEmpty.join(' ');
}
