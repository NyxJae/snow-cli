import type {RouteHandler} from '../http/types.js';
import {sendSuccess} from '../http/response.js';

/**
 * 健康检查处理器.
 */
export const handleHealth: RouteHandler = (_req, res) => {
	sendSuccess(res, {status: 'ok'});
};
