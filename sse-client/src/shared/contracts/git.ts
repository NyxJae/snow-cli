/**
 * Git 初始化请求.
 */
export interface GitInitRequest {
	workDir: string;
}

/**
 * Git 初始化结果.
 */
export interface GitInitData {
	isInitialized: boolean;
}

/**
 * Git 状态查询请求.
 */
export interface GitStatusRequest {
	workDir: string;
}

/**
 * Git 文件变更项.
 */
export interface GitFileItem {
	path: string;
}

/**
 * Git 状态结果.
 */
export interface GitStatusData {
	isInitialized: boolean;
	modified: GitFileItem[];
	untracked: GitFileItem[];
	deleted: GitFileItem[];
	staged: GitFileItem[];
}

/**
 * Git stage/unstage 请求.
 */
export interface GitFileActionRequest {
	workDir: string;
	paths: string[];
}

/**
 * Git diff 请求.
 */
export interface GitDiffRequest {
	workDir: string;
	path: string;
	staged?: boolean;
}

/**
 * Git diff 结果.
 */
export interface GitDiffData {
	path: string;
	staged: boolean;
	diffText: string;
}

/**
 * Git commit 请求.
 */
export interface GitCommitRequest {
	workDir: string;
	message: string;
}

/**
 * Git commit 结果.
 */
export interface GitCommitData {
	commitHash: string;
}
