/**
 * 登录请求体.
 */
export interface LoginRequest {
	password: string;
}

/**
 * 当前浏览器会话登录态.
 */
export interface MeResponseData {
	isLoggedIn: boolean;
}
