import type {IncomingMessage, ServerResponse} from 'node:http';

const SESSION_COOKIE_KEY = 'sse_client_session';

/**
 * 解析请求头 Cookie 为键值映射.
 */
export function parseCookies(req: IncomingMessage): Record<string, string> {
	const rawCookie = req.headers.cookie;
	if (!rawCookie) {
		return {};
	}

	return rawCookie.split(';').reduce<Record<string, string>>((acc, part) => {
		const [rawKey, ...restValue] = part.trim().split('=');
		if (!rawKey || restValue.length === 0) {
			return acc;
		}
		acc[rawKey] = decodeURIComponent(restValue.join('='));
		return acc;
	}, {});
}

/**
 * 读取登录态会话 token.
 */
export function getSessionToken(req: IncomingMessage): string | undefined {
	return parseCookies(req)[SESSION_COOKIE_KEY];
}

/**
 * 设置登录态会话 Cookie,不设置 expires/max-age,保持浏览器会话级.
 */
export function setSessionCookie(res: ServerResponse, token: string): void {
	res.setHeader(
		'Set-Cookie',
		`${SESSION_COOKIE_KEY}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`,
	);
}

/**
 * 清理登录态会话 Cookie.
 */
export function clearSessionCookie(res: ServerResponse): void {
	res.setHeader(
		'Set-Cookie',
		`${SESSION_COOKIE_KEY}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
	);
}
