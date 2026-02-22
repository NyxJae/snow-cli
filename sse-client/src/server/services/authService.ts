import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createDomainError} from '../../shared/errors/index.js';

interface SessionRecord {
	createdAt: number;
}

interface SseAuthConfig {
	password?: string;
}

const SSE_CONFIG_PATH = path.join(os.homedir(), '.snow', 'sse-config.json');

/**
 * 认证服务,负责校验全局密码并维护浏览器会话级登录态.
 */
export class AuthService {
	private readonly sessions = new Map<string, SessionRecord>();

	/**
	 * 校验密码并创建会话 token.
	 */
	public login(password: string): string {
		if (!this.verifyPassword(password)) {
			throw createDomainError('invalid_password', '密码错误');
		}

		const token = randomUUID();
		this.sessions.set(token, {createdAt: Date.now()});
		return token;
	}

	/**
	 * 销毁登录态会话.
	 */
	public logout(token?: string): void {
		if (!token) {
			return;
		}
		this.sessions.delete(token);
	}

	/**
	 * 判断会话是否已登录.
	 */
	public isLoggedIn(token?: string): boolean {
		if (!token) {
			return false;
		}
		return this.sessions.has(token);
	}

	/**
	 * 从全局配置读取密码并做明文比对.
	 */
	private verifyPassword(inputPassword: string): boolean {
		const config = this.loadSseAuthConfig();
		if (!config.password) {
			throw createDomainError('internal_error', '未配置 SSE 登录密码');
		}
		return inputPassword === config.password;
	}

	/**
	 * 读取 ~/.snow/sse-config.json.
	 */
	private loadSseAuthConfig(): SseAuthConfig {
		if (!fs.existsSync(SSE_CONFIG_PATH)) {
			throw createDomainError('internal_error', '未找到 SSE 配置文件');
		}

		try {
			const raw = fs.readFileSync(SSE_CONFIG_PATH, 'utf8');
			return JSON.parse(raw) as SseAuthConfig;
		} catch {
			throw createDomainError('internal_error', 'SSE 配置文件格式错误');
		}
	}
}

export const authService = new AuthService();
