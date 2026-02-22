import type {ServerResponse} from 'node:http';
import type {ApiResponse} from '../../shared/contracts/index.js';
import type {DomainErrorCode} from '../../shared/errors/index.js';

/**
 * 安全序列化 JSON,避免循环引用导致响应阶段异常.
 */
function safeStringify(payload: unknown): string {
	try {
		return JSON.stringify(payload);
	} catch {
		return JSON.stringify({
			success: false,
			errorCode: 'internal_error',
			message: '响应序列化失败',
		});
	}
}

/**
 * 发送 JSON 响应.
 */
export function sendJson(
	res: ServerResponse,
	statusCode: number,
	payload: unknown,
): void {
	res.writeHead(statusCode, {
		'Content-Type': 'application/json; charset=utf-8',
	});
	res.end(safeStringify(payload));
}

/**
 * 发送 success=true 的统一响应.
 */
export function sendSuccess<T>(
	res: ServerResponse,
	data: T,
	message?: string,
): void {
	const payload: ApiResponse<T> = {
		success: true,
		data,
		message,
	};
	sendJson(res, 200, payload);
}

/**
 * 发送 success=false 的统一响应,默认保持 HTTP 200 业务失败语义.
 */
export function sendFailure(
	res: ServerResponse,
	errorCode: DomainErrorCode,
	message: string,
	details?: unknown,
	statusCode = 200,
): void {
	const payload: ApiResponse<never> = {
		success: false,
		errorCode,
		message,
		details,
	};
	sendJson(res, statusCode, payload);
}
