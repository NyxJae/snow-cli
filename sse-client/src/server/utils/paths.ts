import fs from 'node:fs';
import path from 'node:path';
import {createDomainError} from '../../shared/errors/index.js';

/**
 * 校验工作目录必须为存在的绝对路径目录.
 */
export function validateWorkDir(workDir: string): string {
	if (!workDir || typeof workDir !== 'string') {
		throw createDomainError('invalid_work_dir', 'workDir 不能为空');
	}

	const normalizedInput = workDir.replaceAll('\\', '/').trim();
	if (!normalizedInput) {
		throw createDomainError('invalid_work_dir', 'workDir 不能为空');
	}
	const segments = normalizedInput.split('/').filter(Boolean);
	if (segments.some(segment => segment === '.' || segment === '..')) {
		throw createDomainError('invalid_work_dir', 'workDir 不合法');
	}

	if (!path.isAbsolute(workDir)) {
		throw createDomainError('invalid_work_dir', 'workDir 必须是绝对路径');
	}

	if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) {
		throw createDomainError('invalid_work_dir', 'workDir 不存在或不是目录');
	}

	return path.resolve(workDir);
}

/**
 * 校验 Git 文件路径集合必须是相对路径且禁止路径穿越.
 */
export function validateGitFilePaths(paths: string[]): string[] {
	if (!Array.isArray(paths) || paths.length === 0) {
		throw createDomainError('invalid_json', 'paths 不能为空');
	}

	return paths.map(rawPath => {
		if (typeof rawPath !== 'string') {
			throw createDomainError('invalid_json', 'paths 必须是字符串数组');
		}
		const normalized = rawPath.replaceAll('\\', '/').trim();
		if (!normalized) {
			throw createDomainError('invalid_file_path', '文件路径不能为空');
		}
		if (
			path.isAbsolute(normalized) ||
			normalized.startsWith('/') ||
			/^[A-Za-z]:/.test(normalized)
		) {
			throw createDomainError('invalid_file_path', '文件路径必须是相对路径');
		}
		const segments = normalized.split('/').filter(Boolean);
		if (
			segments.length === 0 ||
			segments.some(segment => segment === '.' || segment === '..')
		) {
			throw createDomainError('invalid_file_path', '文件路径不合法');
		}
		return segments.join('/');
	});
}
