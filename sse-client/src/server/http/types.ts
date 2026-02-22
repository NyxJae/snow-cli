import type {IncomingMessage, ServerResponse} from 'node:http';

/**
 * 路由匹配支持的 HTTP 方法.
 */
export type HttpMethod =
	| 'GET'
	| 'POST'
	| 'PUT'
	| 'PATCH'
	| 'DELETE'
	| 'OPTIONS';

/**
 * 路由处理函数签名.
 */
export type RouteHandler = (
	req: IncomingMessage,
	res: ServerResponse,
) => Promise<void> | void;

/**
 * 路由匹配结果,用于区分 404 与 405.
 */
export interface RouteMatchResult {
	handled: boolean;
	methodNotAllowed: boolean;
}
