import {spawn, type ChildProcess} from 'node:child_process';
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
	 * 查询运行中服务列表.
	 */
	public list(): ListServersData {
		return {
			servers: [...this.runningServers.values()].map(record => record.item),
		};
	}

	/**
	 * 串行启动服务端,关键区包含端口扫描与进程拉起.
	 */
	public async start(payload: StartServerRequest): Promise<ServerItem> {
		return this.enqueueStart(async () => this.startInternal(payload));
	}

	/**
	 * 停止指定服务端.
	 */
	public async stop(payload: StopServerRequest): Promise<void> {
		const record = this.runningServers.get(payload.serverId);
		if (!record) {
			throw createDomainError('stop_failed', '未找到目标服务');
		}

		await this.killProcess(record.process);
		this.runningServers.delete(payload.serverId);
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
}

export const serversService = new ServersService();
