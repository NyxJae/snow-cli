import type {RouteHandler} from '../http/types.js';
import {readJsonBody} from '../http/json.js';
import {sendFailure, sendSuccess} from '../http/response.js';
import {gitService} from '../services/gitService.js';
import type {
	GitCommitRequest,
	GitDiffRequest,
	GitFileActionRequest,
	GitInitRequest,
	GitStatusRequest,
} from '../../shared/contracts/index.js';
import type {DomainError, DomainErrorCode} from '../../shared/errors/index.js';

/**
 * 判断是否为领域错误对象.
 */
function isDomainError(error: unknown): error is DomainError {
	return (
		typeof error === 'object' &&
		error !== null &&
		'errorCode' in error &&
		'message' in error
	);
}

/**
 * 将异常统一映射为控制面失败响应.
 */
function sendMappedFailure(
	res: Parameters<RouteHandler>[1],
	error: unknown,
): void {
	if (isDomainError(error)) {
		sendFailure(
			res,
			error.errorCode,
			error.message,
			error.details,
			error.statusCode ?? 200,
		);
		return;
	}

	const message = error instanceof Error ? error.message : '未知错误';
	const invalidJsonMessages = new Set([
		'invalid json body',
		'invalid content-type, expected application/json',
		'request body too large',
	]);
	const errorCode: DomainErrorCode = invalidJsonMessages.has(message)
		? 'invalid_json'
		: 'internal_error';
	sendFailure(res, errorCode, message);
}

/**
 * 初始化 Git 仓库.
 */
export const handleGitInit: RouteHandler = async (req, res) => {
	try {
		const payload = await readJsonBody<GitInitRequest>(req);
		sendSuccess(res, gitService.init(payload));
	} catch (error) {
		sendMappedFailure(res, error);
	}
};

/**
 * 获取 Git 状态.
 */
export const handleGitStatus: RouteHandler = async (req, res) => {
	try {
		const payload = await readJsonBody<GitStatusRequest>(req);
		sendSuccess(res, gitService.status(payload));
	} catch (error) {
		sendMappedFailure(res, error);
	}
};

/**
 * 添加到暂存区.
 */
export const handleGitStage: RouteHandler = async (req, res) => {
	try {
		const payload = await readJsonBody<GitFileActionRequest>(req);
		gitService.stage(payload);
		sendSuccess(res, {});
	} catch (error) {
		sendMappedFailure(res, error);
	}
};

/**
 * 撤回暂存区.
 */
export const handleGitUnstage: RouteHandler = async (req, res) => {
	try {
		const payload = await readJsonBody<GitFileActionRequest>(req);
		gitService.unstage(payload);
		sendSuccess(res, {});
	} catch (error) {
		sendMappedFailure(res, error);
	}
};

/**
 * 查询文件差异.
 */
export const handleGitDiff: RouteHandler = async (req, res) => {
	try {
		const payload = await readJsonBody<GitDiffRequest>(req);
		sendSuccess(res, gitService.diff(payload));
	} catch (error) {
		sendMappedFailure(res, error);
	}
};

/**
 * 提交改动.
 */
export const handleGitCommit: RouteHandler = async (req, res) => {
	try {
		const payload = await readJsonBody<GitCommitRequest>(req);
		sendSuccess(res, gitService.commit(payload));
	} catch (error) {
		sendMappedFailure(res, error);
	}
};
