import type {DomainErrorCode} from './codes.js';

/**
 * 控制面 API 统一错误对象.
 */
export interface DomainError {
	errorCode: DomainErrorCode;
	message: string;
	statusCode?: number;
	details?: unknown;
}

/**
 * 创建规范化错误对象,避免路由层重复拼装.
 */
export function createDomainError(
	errorCode: DomainErrorCode,
	message: string,
	statusCode?: number,
	details?: unknown,
): DomainError {
	return {
		errorCode,
		message,
		statusCode,
		details,
	};
}
