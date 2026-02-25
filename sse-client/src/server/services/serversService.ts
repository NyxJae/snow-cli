import {spawn, type ChildProcess} from 'node:child_process';
import {existsSync, readdirSync, readFileSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createDomainError} from '../../shared/errors/index.js';
import type {
	ListServersData,
	ServerItem,
	StartServerRequest,
	StopAllServersData,
	StopServerRequest,
} from '../../shared/contracts/index.js';
import {isPortAvailable, isValidPort} from '../utils/ports.js';
import {validateWorkDir} from '../utils/paths.js';

const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_START_PORT = 3000;
const MAX_PORT_SCAN_ATTEMPTS = 100;

interface RunningServerRecord {
	item: ServerItem;
	process: ChildProcess;
}

/**
 * 服务端进程管理服务,负责 list/start/stop/stop-all.
 */
export class ServersService {
	private readonly runningServers = new Map<string, RunningServerRecord>();
	private startQueue: Promise<void> = Promise.resolve();

	/**
	 * 查询运行中服务列表, 合并本进程启动的 managed 服务和通过 PID 文件发现的 external 服务.
	 */
	public list(): ListServersData {
		const managedServers: ServerItem[] = [...this.runningServers.values()].map(
			record => ({...record.item, source: 'managed' as const}),
		);

		const managedPorts = new Set(managedServers.map(s => s.port));
		const externalServers = this.discoverExternalServers(managedPorts);

		return {
			servers: [...managedServers, ...externalServers],
		};
	}

	/**
	 * 串行启动服务端,关键区包含端口扫描与进程拉起.
	 */
	public async start(payload: StartServerRequest): Promise<ServerItem> {
		return this.enqueueStart(async () => this.startInternal(payload));
	}

	/**
	 * 停止指定服务端, 支持 managed(内存中有 ChildProcess) 和 external(仅有 PID) 两种.
	 */
	public async stop(payload: StopServerRequest): Promise<void> {
		const record = this.runningServers.get(payload.serverId);
		if (record) {
			await this.killProcess(record.process);
			this.runningServers.delete(payload.serverId);
			return;
		}

		// 直接扫描 PID 目录精准匹配, 避免依赖 this.list() 全量合并
		const ext = this.findExternalServer(payload.serverId);
		if (!ext) {
			throw createDomainError('stop_failed', '未找到目标服务');
		}

		await this.killProcessByPid(ext.pid);
		this.safeCleanupPidFile(ext.pidFilePath, ext.pid, ext.port);
	}

	/**
	 * 停止全部服务端.
	 */
	public async stopAll(): Promise<StopAllServersData> {
		const stoppedServerIds: string[] = [];
		const failedServerIds: string[] = [];
		for (const [serverId, record] of this.runningServers.entries()) {
			try {
				await this.killProcess(record.process);
				stoppedServerIds.push(serverId);
				this.runningServers.delete(serverId);
			} catch {
				failedServerIds.push(serverId);
			}
		}
		if (failedServerIds.length > 0) {
			throw createDomainError('stop_failed', '部分服务停止失败', 200, {
				stoppedServerIds,
				failedServerIds,
			});
		}
		return {stoppedServerIds};
	}

	/**
	 * 启动核心流程.
	 */
	private async startInternal(
		payload: StartServerRequest,
	): Promise<ServerItem> {
		const workDir = validateWorkDir(payload.workDir);
		const timeoutMs = this.resolveTimeoutMs(payload.timeoutMs);
		const port = await this.resolveStartPort(payload.port);

		const serverId = `${workDir}#${port}`;
		if (this.runningServers.has(serverId)) {
			throw createDomainError('start_failed', '该服务已在运行');
		}

		const snowArgs = [
			'--sse',
			'--sse-port',
			String(port),
			'--sse-timeout',
			String(timeoutMs),
			'--work-dir',
			workDir,
		];
		const child =
			process.platform === 'win32'
				? spawn('cmd.exe', ['/d', '/s', '/c', 'snow', ...snowArgs], {
						cwd: workDir,
						env: process.env,
						windowsHide: true,
						detached: true,
						stdio: 'ignore',
				  })
				: spawn('snow', snowArgs, {
						cwd: workDir,
						env: process.env,
						windowsHide: true,
						detached: true,
						stdio: 'ignore',
				  });

		await new Promise<void>((resolve, reject) => {
			const onSpawn = (): void => {
				child.off('error', onError);
				resolve();
			};
			const onError = (error: Error): void => {
				child.off('spawn', onSpawn);
				reject(createDomainError('start_failed', `启动失败: ${error.message}`));
			};
			child.once('spawn', onSpawn);
			child.once('error', onError);
		});

		child.unref();
		if (!child.pid) {
			throw createDomainError('start_failed', '启动失败,未获取到进程 PID');
		}

		const item: ServerItem = {
			serverId,
			workDir,
			port,
			timeoutMs,
			pid: child.pid,
			startedAt: new Date().toISOString(),
		};

		this.runningServers.set(serverId, {item, process: child});
		child.once('exit', () => {
			this.runningServers.delete(serverId);
		});

		return item;
	}

	/**
	 * 串行入队 start 请求.
	 */
	private async enqueueStart<T>(operation: () => Promise<T>): Promise<T> {
		const resultPromise = this.startQueue.then(operation, operation);
		this.startQueue = resultPromise.then(
			() => undefined,
			() => undefined,
		);
		return resultPromise;
	}

	/**
	 * 解析端口参数并执行端口扫描.
	 */
	private async resolveStartPort(requestedPort?: number): Promise<number> {
		if (requestedPort !== undefined) {
			if (!isValidPort(requestedPort)) {
				throw createDomainError('port_in_use', '端口不合法');
			}
			const available = await isPortAvailable(requestedPort);
			if (!available) {
				throw createDomainError('port_in_use', '端口已被占用');
			}
			return requestedPort;
		}

		const existingPorts = [...this.runningServers.values()].map(
			record => record.item.port,
		);
		const initialPort =
			existingPorts.length === 0
				? DEFAULT_START_PORT
				: Math.max(...existingPorts) + 1;

		let candidate = initialPort;
		for (let attempt = 0; attempt < MAX_PORT_SCAN_ATTEMPTS; attempt += 1) {
			const available = await isPortAvailable(candidate);
			if (available) {
				return candidate;
			}
			candidate += 1;
		}

		throw createDomainError(
			'port_in_use',
			'端口扫描超过 100 次,请手动指定可用端口',
		);
	}

	/**
	 * 解析超时参数.
	 */
	private resolveTimeoutMs(timeoutMs?: number): number {
		if (timeoutMs === undefined) {
			return DEFAULT_TIMEOUT_MS;
		}
		if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
			throw createDomainError('start_failed', 'timeoutMs 必须是正整数');
		}
		return timeoutMs;
	}

	/**
	 * 跨平台停止子进程.
	 */
	private async killProcess(target: ChildProcess): Promise<void> {
		if (!target.pid) {
			return;
		}
		const pid = target.pid;
		if (target.exitCode !== null || !this.isProcessRunning(pid)) {
			return;
		}
		if (process.platform === 'win32') {
			await new Promise<void>((resolve, reject) => {
				const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
					windowsHide: true,
					stdio: 'ignore',
				});
				killer.once('error', error => {
					reject(
						createDomainError('stop_failed', `停止失败: ${error.message}`),
					);
				});
				killer.once('exit', code => {
					if (code === 0 || !this.isProcessRunning(pid)) {
						resolve();
						return;
					}
					reject(
						createDomainError(
							'stop_failed',
							`停止失败,taskkill退出码: ${String(code ?? 'unknown')}`,
						),
					);
				});
			});
			return;
		}
		try {
			target.kill('SIGTERM');
			await this.waitForExit(target, 3000);
		} catch {
			try {
				target.kill('SIGKILL');
				await this.waitForExit(target, 2000);
			} catch (error) {
				throw createDomainError(
					'stop_failed',
					`停止失败: ${error instanceof Error ? error.message : '未知错误'}`,
				);
			}
		}
	}

	/**
	 * 判断目标进程是否仍存活.
	 */
	private isProcessRunning(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			if (
				error instanceof Error &&
				'code' in error &&
				(error as NodeJS.ErrnoException).code === 'EPERM'
			) {
				return true;
			}
			return false;
		}
	}

	/**
	 * 等待进程退出,超时则抛错.
	 */
	private async waitForExit(
		target: ChildProcess,
		timeoutMs: number,
	): Promise<void> {
		if (target.exitCode !== null) {
			return;
		}
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) {
					return;
				}
				settled = true;
				target.off('exit', onExit);
				reject(createDomainError('stop_failed', '停止进程超时'));
			}, timeoutMs);
			const onExit = (): void => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				resolve();
			};
			target.once('exit', onExit);
		});
	}

	/** 仅凭 PID 跨平台终止进程, 用于停止不在内存 Map 中的 external 服务. */
	private async killProcessByPid(pid: number): Promise<void> {
		if (!this.isProcessRunning(pid)) {
			return;
		}
		if (process.platform === 'win32') {
			await new Promise<void>((resolve, reject) => {
				const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
					windowsHide: true,
					stdio: 'ignore',
				});
				killer.once('error', error => {
					reject(
						createDomainError('stop_failed', `停止失败: ${error.message}`),
					);
				});
				killer.once('exit', code => {
					if (code === 0 || !this.isProcessRunning(pid)) {
						resolve();
						return;
					}
					reject(
						createDomainError(
							'stop_failed',
							`停止失败,taskkill退出码: ${String(code ?? 'unknown')}`,
						),
					);
				});
			});
			return;
		}
		// Unix: SIGTERM -> 等待 -> SIGKILL, 区分错误类型确保不静默吞掉权限不足等异常
		try {
			process.kill(pid, 'SIGTERM');
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ESRCH') {
				return; // 进程已不存在, 视为停止成功
			}
			throw createDomainError(
				'stop_failed',
				`无法终止进程(pid=${pid}): ${
					code ?? (error instanceof Error ? error.message : '未知错误')
				}`,
			);
		}
		// 轮询等待进程退出
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline && this.isProcessRunning(pid)) {
			await new Promise(r => setTimeout(r, 200));
		}
		if (this.isProcessRunning(pid)) {
			try {
				process.kill(pid, 'SIGKILL');
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== 'ESRCH') {
					throw createDomainError(
						'stop_failed',
						`强制终止进程失败(pid=${pid}): ${
							code ?? (error instanceof Error ? error.message : '未知错误')
						}`,
					);
				}
			}
		}
	}

	/** 清理 PID 文件, 校验归属后删除以避免其他进程覆盖后误删. */
	private safeCleanupPidFile(
		pidFilePath: string,
		expectedPid: number,
		expectedPort: number,
	): void {
		try {
			if (!existsSync(pidFilePath)) {
				return;
			}
			const raw = readFileSync(pidFilePath, 'utf-8');
			const info = JSON.parse(raw);
			// 归属校验: 文件可能已被重启的新进程覆盖
			if (info?.pid === expectedPid && info?.port === expectedPort) {
				unlinkSync(pidFilePath);
			}
		} catch {
			// 静默: 文件可能已被目标进程自行清理或内容损坏
		}
	}

	/** 从 daemon PID 文件中定位指定 serverId 的 external 实例, 仅返回存活且不与 managed 冲突的记录. */
	private findExternalServer(
		serverId: string,
	): {pid: number; port: number; pidFilePath: string} | null {
		const daemonDir = join(homedir(), '.snow', 'sse-daemons');
		if (!existsSync(daemonDir)) {
			return null;
		}

		let pidFiles: string[];
		try {
			pidFiles = readdirSync(daemonDir).filter(f => f.endsWith('.pid'));
		} catch {
			return null;
		}

		const managedPorts = new Set(
			[...this.runningServers.values()].map(r => r.item.port),
		);

		for (const fileName of pidFiles) {
			try {
				const filePath = join(daemonDir, fileName);
				const raw = readFileSync(filePath, 'utf-8');
				const info = JSON.parse(raw);

				if (
					typeof info?.pid !== 'number' ||
					typeof info?.port !== 'number' ||
					typeof info?.workDir !== 'string'
				) {
					continue;
				}

				if (managedPorts.has(info.port)) {
					continue;
				}

				// serverId 规则与 discoverExternalServers 一致: workDir#port
				if (`${info.workDir}#${info.port}` !== serverId) {
					continue;
				}

				if (!this.isProcessRunning(info.pid)) {
					continue;
				}

				return {pid: info.pid, port: info.port, pidFilePath: filePath};
			} catch {
				continue;
			}
		}
		return null;
	}

	/** 通过 PID 文件扫描发现未纳入本进程管理的存活 SSE 服务, 标记为 external 供调用方决策. */
	private discoverExternalServers(managedPorts: Set<number>): ServerItem[] {
		const daemonDir = join(homedir(), '.snow', 'sse-daemons');
		if (!existsSync(daemonDir)) {
			return [];
		}

		let pidFiles: string[];
		try {
			pidFiles = readdirSync(daemonDir).filter(f => f.endsWith('.pid'));
		} catch {
			return [];
		}

		const results: ServerItem[] = [];
		for (const fileName of pidFiles) {
			try {
				const raw = readFileSync(join(daemonDir, fileName), 'utf-8');
				const info = JSON.parse(raw);

				// 最小字段校验, 防止损坏数据污染 UI
				if (
					typeof info?.pid !== 'number' ||
					typeof info?.port !== 'number' ||
					typeof info?.workDir !== 'string'
				) {
					continue;
				}

				// 跳过已被本进程管理的端口
				if (managedPorts.has(info.port)) {
					continue;
				}

				// 检查进程是否仍存活
				if (!this.isProcessRunning(info.pid)) {
					continue;
				}

				results.push({
					// serverId 规则须与 managed 服务一致(workDir#port)
					serverId: `${info.workDir}#${info.port}`,
					workDir: info.workDir,
					port: info.port,
					// PID 文件字段为 timeout, 契约(ServerItem)对外为 timeoutMs
					timeoutMs: info.timeout ?? 300000,
					pid: info.pid,
					startedAt: info.startTime ?? '',
					source: 'external',
				});
			} catch {
				// 跳过损坏的 PID 文件
			}
		}
		return results;
	}
}

export const serversService = new ServersService();
