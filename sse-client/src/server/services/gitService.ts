import {spawnSync} from 'node:child_process';
import type {
	GitCommitData,
	GitCommitRequest,
	GitDiffData,
	GitDiffRequest,
	GitFileActionRequest,
	GitFileItem,
	GitInitData,
	GitInitRequest,
	GitStatusData,
	GitStatusRequest,
} from '../../shared/contracts/index.js';
import {createDomainError} from '../../shared/errors/index.js';
import {validateGitFilePaths, validateWorkDir} from '../utils/paths.js';

/**
 * Git 业务服务,负责 init/status/stage/unstage/diff/commit.
 */
export class GitService {
	/**
	 * 初始化 Git 仓库.
	 */
	public init(payload: GitInitRequest): GitInitData {
		const workDir = validateWorkDir(payload.workDir);
		const status = this.runGit(workDir, ['rev-parse', '--is-inside-work-tree']);
		if (status.code === 0) {
			return {isInitialized: true};
		}
		this.ensureGitAvailable(workDir);
		const initResult = this.runGit(workDir, ['init']);
		if (initResult.code !== 0) {
			throw createDomainError(
				'git_command_failed',
				`Git 初始化失败: ${initResult.stderr || '未知错误'}`,
			);
		}
		return {isInitialized: true};
	}

	/**
	 * 查询 Git 状态.
	 */
	public status(payload: GitStatusRequest): GitStatusData {
		const workDir = validateWorkDir(payload.workDir);
		if (!this.isGitRepo(workDir)) {
			return {
				isInitialized: false,
				modified: [],
				untracked: [],
				deleted: [],
				staged: [],
			};
		}
		this.ensureGitAvailable(workDir);
		const porcelain = this.runGit(workDir, ['status', '--porcelain']);
		if (porcelain.code !== 0) {
			throw createDomainError(
				'git_command_failed',
				`Git 状态查询失败: ${porcelain.stderr || '未知错误'}`,
			);
		}
		return this.parseStatusOutput(porcelain.stdout);
	}

	/**
	 * 添加到暂存区.
	 */
	public stage(payload: GitFileActionRequest): void {
		const workDir = validateWorkDir(payload.workDir);
		this.ensureGitRepo(workDir);
		const paths = validateGitFilePaths(payload.paths);
		const result = this.runGit(workDir, ['add', '--', ...paths]);
		if (result.code !== 0) {
			throw createDomainError(
				'git_command_failed',
				`添加暂存失败: ${result.stderr || '未知错误'}`,
			);
		}
	}

	/**
	 * 撤回暂存区文件.
	 */
	public unstage(payload: GitFileActionRequest): void {
		const workDir = validateWorkDir(payload.workDir);
		this.ensureGitRepo(workDir);
		const paths = validateGitFilePaths(payload.paths);
		const result = this.runGit(workDir, ['reset', 'HEAD', '--', ...paths]);
		if (result.code !== 0) {
			throw createDomainError(
				'git_command_failed',
				`撤回暂存失败: ${result.stderr || '未知错误'}`,
			);
		}
	}

	/**
	 * 查询单文件差异.
	 */
	public diff(payload: GitDiffRequest): GitDiffData {
		const workDir = validateWorkDir(payload.workDir);
		this.ensureGitRepo(workDir);
		const paths = validateGitFilePaths([payload.path]);
		const targetPath = paths[0];
		if (!targetPath) {
			throw createDomainError('invalid_file_path', '文件路径不能为空');
		}
		const staged = Boolean(payload.staged);
		const args: string[] = staged
			? ['diff', '--cached', '--', targetPath]
			: ['diff', '--', targetPath];
		const result = this.runGit(workDir, args);
		if (result.code !== 0) {
			throw createDomainError(
				'git_command_failed',
				`查询差异失败: ${result.stderr || '未知错误'}`,
			);
		}
		return {
			path: targetPath,
			staged,
			diffText: result.stdout,
		};
	}

	/**
	 * 提交暂存区改动.
	 */
	public commit(payload: GitCommitRequest): GitCommitData {
		const workDir = validateWorkDir(payload.workDir);
		this.ensureGitRepo(workDir);
		const message = String(payload.message ?? '').trim();
		if (!message) {
			throw createDomainError('invalid_json', '提交信息不能为空');
		}
		const stagedFiles = this.runGit(workDir, [
			'diff',
			'--cached',
			'--name-only',
		]);
		if (stagedFiles.code !== 0) {
			throw createDomainError(
				'git_command_failed',
				`提交前检查失败: ${stagedFiles.stderr || '未知错误'}`,
			);
		}
		if (!stagedFiles.stdout.trim()) {
			throw createDomainError('invalid_json', '暂存区为空,无法提交');
		}
		const commitResult = this.runGit(workDir, ['commit', '-m', message]);
		if (commitResult.code !== 0) {
			throw createDomainError(
				'git_command_failed',
				`提交失败: ${commitResult.stderr || '未知错误'}`,
			);
		}
		const hashResult = this.runGit(workDir, ['rev-parse', 'HEAD']);
		if (hashResult.code !== 0) {
			throw createDomainError(
				'git_command_failed',
				`读取提交哈希失败: ${hashResult.stderr || '未知错误'}`,
			);
		}
		return {
			commitHash: hashResult.stdout.trim(),
		};
	}

	/**
	 * 解析 git status --porcelain 输出.
	 */
	private parseStatusOutput(stdout: string): GitStatusData {
		const modifiedMap = new Map<string, GitFileItem>();
		const untrackedMap = new Map<string, GitFileItem>();
		const deletedMap = new Map<string, GitFileItem>();
		const stagedMap = new Map<string, GitFileItem>();

		const lines = stdout
			.split(/\r?\n/)
			.map(line => line.trimEnd())
			.filter(Boolean);

		for (const line of lines) {
			if (line.startsWith('?? ')) {
				const filePath = line.slice(3).trim();
				if (filePath) {
					untrackedMap.set(filePath, {path: filePath});
				}
				continue;
			}
			if (line.length < 3) {
				continue;
			}
			const x = line[0] ?? ' ';
			const y = line[1] ?? ' ';
			const rawPath = line.slice(3).trim();
			const filePath = rawPath.includes(' -> ')
				? rawPath.split(' -> ').at(-1)?.trim() ?? rawPath
				: rawPath;
			if (!filePath) {
				continue;
			}
			if (x !== ' ' && x !== '?') {
				stagedMap.set(filePath, {path: filePath});
			}
			if (y === 'D') {
				deletedMap.set(filePath, {path: filePath});
				continue;
			}
			if (y !== ' ') {
				modifiedMap.set(filePath, {path: filePath});
			}
		}

		return {
			isInitialized: true,
			modified: [...modifiedMap.values()],
			untracked: [...untrackedMap.values()],
			deleted: [...deletedMap.values()],
			staged: [...stagedMap.values()],
		};
	}

	/**
	 * 确保 git 可执行文件可用.
	 */
	private ensureGitAvailable(workDir: string): void {
		const version = this.runGit(workDir, ['--version']);
		if (version.code !== 0) {
			throw createDomainError(
				'git_not_installed',
				'Git 不可用,请检查安装与 PATH',
			);
		}
	}

	/**
	 * 确保目录已初始化 Git 仓库.
	 */
	private ensureGitRepo(workDir: string): void {
		this.ensureGitAvailable(workDir);
		if (!this.isGitRepo(workDir)) {
			throw createDomainError(
				'repo_not_initialized',
				'当前目录未初始化 Git 仓库',
			);
		}
	}

	/**
	 * 判断目录是否 Git 仓库.
	 */
	private isGitRepo(workDir: string): boolean {
		const result = this.runGit(workDir, ['rev-parse', '--is-inside-work-tree']);
		return result.code === 0;
	}

	/**
	 * 运行 git 命令并返回结果.
	 */
	private runGit(
		workDir: string,
		args: string[],
	): {code: number; stdout: string; stderr: string} {
		const result = spawnSync('git', args, {
			cwd: workDir,
			encoding: 'utf-8',
			windowsHide: true,
			maxBuffer: 5 * 1024 * 1024,
		});
		return {
			code: result.status ?? 1,
			stdout: result.stdout ?? '',
			stderr: result.stderr ?? '',
		};
	}
}

export const gitService = new GitService();
