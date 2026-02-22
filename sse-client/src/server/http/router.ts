import {parse as parseUrl} from 'node:url';
import type {IncomingMessage, ServerResponse} from 'node:http';
import type {HttpMethod, RouteHandler, RouteMatchResult} from './types.js';

interface RouteRecord {
	method: HttpMethod;
	path: string;
	handler: RouteHandler;
}

/**
 * 基于 method + pathname 精确匹配的最小路由器.
 */
export class HttpRouter {
	private readonly routes: RouteRecord[] = [];

	/**
	 * 注册一个精确匹配路由.
	 */
	public register(
		method: HttpMethod,
		path: string,
		handler: RouteHandler,
	): void {
		this.routes.push({method, path, handler});
	}

	/**
	 * 解析并执行匹配到的路由处理器,并提供 405 判断能力.
	 */
	public async handle(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<RouteMatchResult> {
		const pathname = parseUrl(req.url ?? '', true).pathname ?? '/';
		const method = (req.method ?? 'GET').toUpperCase() as HttpMethod;

		const pathMatched = this.routes.some(route => route.path === pathname);
		const exactMatched = this.routes.find(
			route => route.method === method && route.path === pathname,
		);
		if (!exactMatched) {
			return {
				handled: false,
				methodNotAllowed: pathMatched,
			};
		}

		await exactMatched.handler(req, res);
		return {
			handled: true,
			methodNotAllowed: false,
		};
	}
}
