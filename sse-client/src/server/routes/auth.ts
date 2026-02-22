import type {RouteHandler} from '../http/types.js';
import {readJsonBody} from '../http/json.js';
import {sendFailure, sendSuccess} from '../http/response.js';
import {authService} from '../services/authService.js';
import {
	clearSessionCookie,
	getSessionToken,
	setSessionCookie,
} from '../utils/cookies.js';
import type {LoginRequest} from '../../shared/contracts/index.js';
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
 * 登录接口,校验密码后创建会话 cookie.
 */
export const handleAuthLogin: RouteHandler = async (req, res) => {
	try {
		const payload = await readJsonBody<LoginRequest>(req);
		const token = authService.login(payload.password ?? '');
		setSessionCookie(res, token);
		sendSuccess(res, {});
	} catch (error) {
		sendMappedFailure(res, error);
	}
};

/**
 * 登出接口,销毁会话并清理 cookie.
 */
export const handleAuthLogout: RouteHandler = (req, res) => {
	const token = getSessionToken(req);
	authService.logout(token);
	clearSessionCookie(res);
	sendSuccess(res, {});
};

/**
 * 查询当前会话登录态,未登录时保持 success=true.
 */
export const handleAuthMe: RouteHandler = (req, res) => {
	const token = getSessionToken(req);
	sendSuccess(res, {isLoggedIn: authService.isLoggedIn(token)});
};
