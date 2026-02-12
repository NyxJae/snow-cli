/**
 * editableFileSuffixes 规则工具
 * 统一用于配置清洗,回显与文件后缀权限判定.
 */

/**
 * 规范化单个后缀配置项.
 * 规则: trim,补点,小写化,过滤非法值.
 */
export function normalizeSingleEditableSuffix(rawValue: string): string | null {
	const trimmed = rawValue.trim();
	if (!trimmed) {
		return null;
	}

	const withDot = trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
	const normalized = withDot.trim().toLowerCase();
	if (!normalized || normalized === '.') {
		return null;
	}

	return normalized;
}

/**
 * 规范化 editableFileSuffixes 列表.
 * [] 或未配置表示不限制.
 */
export function normalizeEditableFileSuffixes(
	rawValues?: string[],
): string[] {
	if (!Array.isArray(rawValues) || rawValues.length === 0) {
		return [];
	}

	const normalizedSet = new Set<string>();
	for (const value of rawValues) {
		if (typeof value !== 'string') {
			continue;
		}
		const normalized = normalizeSingleEditableSuffix(value);
		if (normalized) {
			normalizedSet.add(normalized);
		}
	}

	return Array.from(normalizedSet);
}

/**
 * 将 TUI 文本输入解析并规范化为后缀列表.
 * 支持英文逗号和中文逗号分隔.
 */
export function parseEditableFileSuffixesInput(input: string): string[] {
	if (!input || !input.trim()) {
		return [];
	}

	const rawValues = input.split(/[，,]/g);
	return normalizeEditableFileSuffixes(rawValues);
}

/**
 * 将后缀列表格式化为 TUI 输入框展示文本.
 */
export function stringifyEditableFileSuffixes(values?: string[]): string {
	return normalizeEditableFileSuffixes(values).join(',');
}

/**
 * 从路径中提取文件名.
 * 支持本地路径和 ssh:// 路径.
 */
export function extractFileNameFromPath(filePath: string): string {
	if (!filePath) {
		return '';
	}

	const normalizedPath = filePath.replace(/\\/g, '/');
	const lastSlashIndex = normalizedPath.lastIndexOf('/');
	if (lastSlashIndex === -1) {
		return normalizedPath;
	}

	return normalizedPath.slice(lastSlashIndex + 1);
}

/**
 * 按最后一个点规则提取后缀.
 * - a.test.ts -> .ts
 * - .env -> .env
 * - .config.json -> .json
 * - a. -> null
 */
export function getFileSuffixByLastDot(filePath: string): string | null {
	const fileName = extractFileNameFromPath(filePath);
	if (!fileName) {
		return null;
	}

	const lastDotIndex = fileName.lastIndexOf('.');
	if (lastDotIndex === -1 || lastDotIndex === fileName.length - 1) {
		return null;
	}

	if (lastDotIndex === 0) {
		return fileName.toLowerCase();
	}

	return fileName.slice(lastDotIndex).toLowerCase();
}

/**
 * 生成拒绝提示中的 xxx 展示文案.
 * 有后缀返回后缀,无后缀返回文件名.
 */
export function getEditableTypeDisplayText(filePath: string): string {
	const suffix = getFileSuffixByLastDot(filePath);
	if (suffix) {
		return suffix;
	}

	const fileName = extractFileNameFromPath(filePath);
	return fileName || filePath;
}

/**
 * 判断目标路径是否在 editableFileSuffixes 白名单内.
 * [] 或未配置表示不限制.
 */
export function isFilePathAllowedByEditableSuffixes(
	filePath: string,
	editableFileSuffixes?: string[],
): boolean {
	const normalizedSuffixes = normalizeEditableFileSuffixes(editableFileSuffixes);
	if (normalizedSuffixes.length === 0) {
		return true;
	}

	const fileSuffix = getFileSuffixByLastDot(filePath);
	if (!fileSuffix) {
		return false;
	}

	return normalizedSuffixes.includes(fileSuffix);
}
