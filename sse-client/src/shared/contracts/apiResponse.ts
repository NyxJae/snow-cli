import type {DomainErrorCode} from '../errors/index.js';

/**
 * 成功响应结构.
 */
export interface ApiSuccessResponse<T> {
	success: true;
	data: T;
	message?: string;
}

/**
 * 失败响应结构.
 */
export interface ApiFailureResponse {
	success: false;
	errorCode: DomainErrorCode;
	message: string;
	details?: unknown;
}

/**
 * 控制面统一响应契约.
 */
export type ApiResponse<T> = ApiSuccessResponse<T> | ApiFailureResponse;
