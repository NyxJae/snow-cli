/**
 * 运行中服务端条目.
 */
export interface ServerItem {
	serverId: string;
	workDir: string;
	port: number;
	timeoutMs: number;
	pid: number;
	startedAt: string;
}

/**
 * GET /api/servers 的返回数据.
 */
export interface ListServersData {
	servers: ServerItem[];
}

/**
 * POST /api/servers/start 的请求体.
 */
export interface StartServerRequest {
	workDir: string;
	port?: number;
	timeoutMs?: number;
}

/**
 * POST /api/servers/stop 的请求体.
 */
export interface StopServerRequest {
	serverId: string;
}

/**
 * POST /api/servers/stop-all 的返回数据.
 */
export interface StopAllServersData {
	stoppedServerIds: string[];
}

/**
 * 已保存的工作目录列表.
 */
export interface WorkDirPresetsData {
	workDirs: string[];
}

/**
 * 渠道配置选项数据.
 */
export interface ProfileOptionsData {
	profiles: string[];
	activeProfile: string;
}

/**
 * 保存工作目录请求体.
 */
export interface SaveWorkDirPresetRequest {
	workDir: string;
}
