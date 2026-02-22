import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
	SaveWorkDirPresetRequest,
	WorkDirPresetsData,
} from '../../shared/contracts/index.js';
import {createDomainError} from '../../shared/errors/index.js';

interface WorkDirPresetStore {
	workDirs?: string[];
}

/**
 * 校验并规范化用于保存预设的工作目录.
 * 预设允许提前保存尚不存在的绝对路径,启动服务时再做目录存在性校验.
 */
function normalizePresetWorkDir(workDir: string): string {
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
	if (!path.isAbsolute(normalizedInput)) {
		throw createDomainError('invalid_work_dir', 'workDir 必须是绝对路径');
	}
	return path.resolve(normalizedInput);
}

const PRESET_FILE_PATH = path.join(
	os.homedir(),
	'.snow',
	'workdir-presets.json',
);

/**
 * 工作目录预设服务,负责读取与保存可复用的 workDir 列表.
 */
export class WorkDirPresetService {
	/**
	 * 获取已保存的工作目录列表.
	 */
	public list(): WorkDirPresetsData {
		const store = this.readStore();
		const workDirs = Array.isArray(store.workDirs)
			? store.workDirs.filter(item => typeof item === 'string' && item.trim())
			: [];
		return {workDirs};
	}

	/**
	 * 保存工作目录,重复项不重复写入.
	 */
	public save(payload: SaveWorkDirPresetRequest): WorkDirPresetsData {
		const workDir = normalizePresetWorkDir(payload.workDir);
		const current = this.list().workDirs;
		if (!current.includes(workDir)) {
			current.unshift(workDir);
		}
		this.writeStore({workDirs: current});
		return {workDirs: current};
	}

	/**
	 * 读取配置文件.
	 */
	private readStore(): WorkDirPresetStore {
		if (!fs.existsSync(PRESET_FILE_PATH)) {
			return {workDirs: []};
		}
		try {
			const raw = fs.readFileSync(PRESET_FILE_PATH, 'utf8');
			const parsed = JSON.parse(raw) as WorkDirPresetStore;
			return parsed && typeof parsed === 'object' ? parsed : {workDirs: []};
		} catch {
			throw createDomainError('internal_error', '工作目录配置文件格式错误');
		}
	}

	/**
	 * 写入配置文件.
	 */
	private writeStore(store: WorkDirPresetStore): void {
		const parentDir = path.dirname(PRESET_FILE_PATH);
		if (!fs.existsSync(parentDir)) {
			fs.mkdirSync(parentDir, {recursive: true});
		}
		fs.writeFileSync(PRESET_FILE_PATH, JSON.stringify(store, null, 2), 'utf8');
	}
}

export const workDirPresetService = new WorkDirPresetService();
