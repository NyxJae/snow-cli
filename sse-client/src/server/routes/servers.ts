import type {RouteHandler} from '../http/types.js';
import {readJsonBody} from '../http/json.js';
import {sendFailure, sendSuccess} from '../http/response.js';
import {serversService} from '../services/serversService.js';
import {workDirPresetService} from '../services/workDirPresetService.js';
import {profileOptionsService} from '../services/profileOptionsService.js';
import type {
	SaveWorkDirPresetRequest,
	StartServerRequest,
	StopServerRequest,
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
 * 查询运行中服务端列表.
 */
export const handleListServers: RouteHandler = (_req, res) => {
	sendSuccess(res, serversService.list());
};

/**
 * 查询可复用的工作目录列表.
 */
export const handleListWorkDirPresets: RouteHandler = (_req, res) => {
	try {
		sendSuccess(res, workDirPresetService.list());
	} catch (error) {
		sendMappedFailure(res, error);
	}
};

/**
 * 查询可用渠道列表与当前激活渠道.
 */
export const handleListProfileOptions: RouteHandler = (_req, res) => {
	try {
		sendSuccess(res, profileOptionsService.list());
	} catch (error) {
		sendMappedFailure(res, error);
	}
};

/**
 * 保存可复用工作目录.
 */
export const handleSaveWorkDirPreset: RouteHandler = async (req, res) => {
	try {
		const payload = await readJsonBody<SaveWorkDirPresetRequest>(req);
		sendSuccess(res, workDirPresetService.save(payload));
	} catch (error) {
		sendMappedFailure(res, error);
	}
};

/**
 * 启动服务端.
 */
export const handleStartServer: RouteHandler = async (req, res) => {
	try {
		const payload = await readJsonBody<StartServerRequest>(req);
		const server = await serversService.start(payload);
		sendSuccess(res, server);
	} catch (error) {
		sendMappedFailure(res, error);
	}
};

/**
 * 停止指定服务端.
 */
export const handleStopServer: RouteHandler = async (req, res) => {
	try {
		const payload = await readJsonBody<StopServerRequest>(req);
		await serversService.stop(payload);
		sendSuccess(res, {});
	} catch (error) {
		sendMappedFailure(res, error);
	}
};

/**
 * 停止全部服务端.
 */
export const handleStopAllServers: RouteHandler = async (_req, res) => {
	try {
		sendSuccess(res, await serversService.stopAll());
	} catch (error) {
		sendMappedFailure(res, error);
	}
};
