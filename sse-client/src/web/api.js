import {byId} from './utils.js';
import {
	state,
	resetStateAfterLogout,
	syncServerTabs,
	withServerTabContext,
} from './state.js';

/**
 * 调用控制面 API.
 * @param {string} path 路径.
 * @param {RequestInit} [init] 请求参数.
 * @returns {Promise<any>}
 */
async function requestControl(path, init) {
	const response = await fetch(path, init);
	const payload = await response.json();
	if (!response.ok) {
		throw new Error(payload?.message ?? `HTTP ${response.status}`);
	}
	if (payload?.success === false && payload?.errorCode === 'unauthorized') {
		state.auth.isLoggedIn = false;
	}
	return payload;
}

/**
 * 读取当前或指定服务端.
 * @param {string} [serverId] 服务端ID.
 * @returns {{serverId:string,workDir:string,port:number}|null}
 */
function getServerById(serverId = state.control.selectedServerId) {
	return state.control.servers.find(item => item.serverId === serverId) ?? null;
}

/**
 * 发送 Git 控制面请求并处理业务失败.
 * @param {string} path 接口路径.
 * @param {Record<string, unknown>} body 请求体.
 * @returns {Promise<any>}
 */
async function requestGit(path, body) {
	const payload = await requestControl(path, {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify(body),
	});
	if (!payload?.success) {
		throw new Error(payload?.message ?? 'Git 操作失败');
	}
	return payload?.data ?? {};
}

/**
 * 创建控制面动作.
 * @param {{render:()=>void,onAfterLogout:()=>void,onAfterServersRefreshed?:()=>Promise<void>|void}} options 依赖项.
 * @returns {{
 * 	refreshServers:()=>Promise<void>,
 * 	refreshWorkDirPresets:()=>Promise<void>,
 * 	refreshProfileOptions:()=>Promise<void>,
 * 	saveCurrentWorkDirPreset:()=>Promise<void>,
 * 	updateServerForm:(field:'workDir'|'port'|'timeoutMs',value:string)=>void,
 * 	startServer:()=>Promise<void>,
 * 	stopCurrentServer:()=>Promise<void>,
 * 	stopAllServers:()=>Promise<void>,
 * 	doLogin:()=>Promise<void>,
 * 	doLogout:()=>Promise<void>,
 * 	checkAuth:()=>Promise<void>,
 * 	bootAfterLogin:()=>Promise<void>
 * }}
 */
export function createControlActions(options) {
	const {render, onAfterLogout, onAfterServersRefreshed} = options;

	/**
	 * 拉取控制面服务列表.
	 */
	async function refreshServers() {
		state.control.loading = true;
		state.control.error = '';
		render();
		try {
			const payload = await requestControl('/api/servers');
			state.control.servers = payload?.data?.servers ?? [];
			syncServerTabs(state.control.servers);
			if (
				!state.control.serverForm.workDir &&
				state.control.servers[0]?.workDir
			) {
				state.control.serverForm.workDir = state.control.servers[0].workDir;
			}
			if (typeof onAfterServersRefreshed === 'function') {
				await onAfterServersRefreshed();
			}
		} catch (error) {
			state.control.error =
				error instanceof Error ? error.message : '加载服务失败';
		} finally {
			state.control.loading = false;
			render();
		}
	}

	/**
	 * 更新服务端表单字段.
	 * @param {'workDir'|'port'|'timeoutMs'} field 字段名.
	 * @param {string} value 字段值.
	 */
	function updateServerForm(field, value) {
		if (field === 'timeoutMs') {
			state.control.serverForm.timeoutMs = Number(value) || 300000;
			return;
		}
		if (field === 'port') {
			state.control.serverForm.port = value;
			return;
		}
		state.control.serverForm.workDir = value;
	}

	/**
	 * 刷新可复用工作目录预设.
	 */
	async function refreshWorkDirPresets() {
		try {
			const payload = await requestControl('/api/servers/workdir-presets');
			state.control.workDirPresets = Array.isArray(payload?.data?.workDirs)
				? payload.data.workDirs
				: [];
		} catch {
			state.control.workDirPresets = [];
		} finally {
			render();
		}
	}

	/**
	 * 刷新可用渠道选项.
	 */
	async function refreshProfileOptions() {
		try {
			const payload = await requestControl('/api/servers/profile-options');
			state.control.profileOptions = Array.isArray(payload?.data?.profiles)
				? payload.data.profiles
				: [];
			const activeProfile = String(payload?.data?.activeProfile ?? '').trim();
			state.control.activeProfile = activeProfile;
			const shouldFallbackToActive = profile => {
				const normalized = String(profile ?? '').trim();
				return (
					normalized.length === 0 ||
					!state.control.profileOptions.includes(normalized)
				);
			};
			for (const tab of Object.values(state.control.serverTabs)) {
				if (!tab?.chat?.quickSwitch) {
					continue;
				}
				if (shouldFallbackToActive(tab.chat.quickSwitch.profile)) {
					tab.chat.quickSwitch.profile = activeProfile;
				}
			}
			if (shouldFallbackToActive(state.chat.quickSwitch.profile)) {
				state.chat.quickSwitch.profile = activeProfile;
			}
		} catch {
			state.control.profileOptions = [];
			state.control.activeProfile = '';
		} finally {
			render();
		}
	}

	/**
	 * 保存当前输入的工作目录为预设.
	 */
	async function saveCurrentWorkDirPreset() {
		const workDir = state.control.serverForm.workDir.trim();
		if (!workDir) {
			state.control.error = '请输入项目绝对路径';
			render();
			return;
		}
		state.control.actionLoading = true;
		state.control.error = '';
		render();
		try {
			const payload = await requestControl('/api/servers/workdir-presets', {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({workDir}),
			});
			if (!payload?.success) {
				throw new Error(payload?.message ?? '保存路径失败');
			}
			state.control.workDirPresets = Array.isArray(payload?.data?.workDirs)
				? payload.data.workDirs
				: state.control.workDirPresets;
		} catch (error) {
			state.control.error =
				error instanceof Error ? error.message : '保存路径失败';
		} finally {
			state.control.actionLoading = false;
			render();
		}
	}

	/**
	 * 启动服务端.
	 */
	async function startServer() {
		state.control.actionLoading = true;
		state.control.error = '';
		render();
		try {
			const payload = await requestControl('/api/servers/start', {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({
					workDir: state.control.serverForm.workDir,
					port: state.control.serverForm.port
						? Number(state.control.serverForm.port)
						: undefined,
					timeoutMs: state.control.serverForm.timeoutMs,
				}),
			});
			if (!payload?.success) {
				throw new Error(payload?.message ?? '启动服务失败');
			}
			if (payload?.data?.serverId) {
				state.control.selectedServerId = payload.data.serverId;
			}
			await refreshServers();
		} catch (error) {
			state.control.error =
				error instanceof Error ? error.message : '启动服务失败';
		} finally {
			state.control.actionLoading = false;
			render();
		}
	}

	/**
	 * 停止当前服务端.
	 */
	async function stopCurrentServer() {
		if (!state.control.selectedServerId) {
			return;
		}
		state.control.actionLoading = true;
		state.control.error = '';
		render();
		try {
			const payload = await requestControl('/api/servers/stop', {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({serverId: state.control.selectedServerId}),
			});
			if (!payload?.success) {
				throw new Error(payload?.message ?? '停止服务失败');
			}
			await refreshServers();
		} catch (error) {
			state.control.error =
				error instanceof Error ? error.message : '停止服务失败';
		} finally {
			state.control.actionLoading = false;
			render();
		}
	}

	/**
	 * 停止全部服务端.
	 */
	async function stopAllServers() {
		state.control.actionLoading = true;
		state.control.error = '';
		render();
		try {
			const payload = await requestControl('/api/servers/stop-all', {
				method: 'POST',
			});
			if (!payload?.success) {
				throw new Error(payload?.message ?? '停止全部服务失败');
			}
			await refreshServers();
		} catch (error) {
			state.control.error =
				error instanceof Error ? error.message : '停止全部服务失败';
		} finally {
			state.control.actionLoading = false;
			render();
		}
	}

	/**
	 * 登录后的初始化流程.
	 * 说明: 登录态以 /api/auth/me 为唯一事实源.
	 */
	async function bootAfterLogin() {
		await checkAuth();
		if (!state.auth.isLoggedIn) {
			state.auth.error = '登录状态校验失败,请重试';
			render();
			return;
		}
		await Promise.all([
			refreshServers(),
			refreshWorkDirPresets(),
			refreshProfileOptions(),
		]);
	}

	/**
	 * 登录.
	 */
	async function doLogin() {
		const passwordInput = byId('passwordInput');
		const password = passwordInput?.value ?? '';
		state.auth.error = '';
		render();
		try {
			const payload = await requestControl('/api/auth/login', {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({password}),
			});
			if (!payload.success) {
				state.auth.error = payload.message ?? '登录失败';
				render();
				return;
			}
			await bootAfterLogin();
		} catch (error) {
			state.auth.error = error instanceof Error ? error.message : '登录失败';
			render();
		}
	}

	/**
	 * 登出.
	 */
	async function doLogout() {
		try {
			await requestControl('/api/auth/logout', {method: 'POST'});
			onAfterLogout();
			resetStateAfterLogout();
			render();
		} catch (error) {
			state.auth.error = error instanceof Error ? error.message : '登出失败';
			render();
		}
	}

	/**
	 * 首屏鉴权.
	 */
	async function checkAuth() {
		try {
			const payload = await requestControl('/api/auth/me');
			state.auth.isLoggedIn = Boolean(payload?.data?.isLoggedIn);
		} catch {
			state.auth.isLoggedIn = false;
		}
	}

	return {
		refreshServers,
		refreshWorkDirPresets,
		refreshProfileOptions,
		saveCurrentWorkDirPreset,
		updateServerForm,
		startServer,
		stopCurrentServer,
		stopAllServers,
		doLogin,
		doLogout,
		checkAuth,
		bootAfterLogin,
	};
}

/**
 * 创建 Git 视图动作.
 * @param {{render:()=>void}} options 依赖项.
 */
export function createGitActions(options) {
	const {render} = options;

	/**
	 * 刷新 Git 状态.
	 * @param {string} [serverId] 服务端ID.
	 */
	async function refreshGitStatus(serverId = state.control.selectedServerId) {
		const server = getServerById(serverId);
		if (!server) {
			return;
		}
		withServerTabContext(serverId, () => {
			state.git.loading = true;
			state.git.error = '';
			render();
		});
		try {
			const data = await requestGit('/api/git/status', {
				workDir: server.workDir,
			});
			withServerTabContext(serverId, () => {
				state.git.isInitialized = Boolean(data?.isInitialized);
				state.git.modified = Array.isArray(data?.modified) ? data.modified : [];
				state.git.untracked = Array.isArray(data?.untracked)
					? data.untracked
					: [];
				state.git.deleted = Array.isArray(data?.deleted) ? data.deleted : [];
				state.git.staged = Array.isArray(data?.staged) ? data.staged : [];
			});
		} catch (error) {
			withServerTabContext(serverId, () => {
				state.git.error =
					error instanceof Error ? error.message : '加载 Git 状态失败';
			});
		} finally {
			withServerTabContext(serverId, () => {
				state.git.loading = false;
				render();
			});
		}
	}

	/**
	 * 切换主视图.
	 * @param {'chat'|'git'} view 目标视图.
	 */
	function switchMainView(view) {
		state.git.view = view;
		if (view === 'git') {
			void refreshGitStatus();
		}
		render();
	}

	/**
	 * 初始化仓库.
	 */
	async function initGitRepo() {
		const serverId = state.control.selectedServerId;
		const server = getServerById(serverId);
		if (!server) {
			return;
		}
		withServerTabContext(serverId, () => {
			state.git.initLoading = true;
			state.git.error = '';
			render();
		});
		try {
			await requestGit('/api/git/init', {workDir: server.workDir});
			await refreshGitStatus(serverId);
		} catch (error) {
			withServerTabContext(serverId, () => {
				state.git.error =
					error instanceof Error ? error.message : 'Git 初始化失败';
				render();
			});
		} finally {
			withServerTabContext(serverId, () => {
				state.git.initLoading = false;
				render();
			});
		}
	}

	/**
	 * 加载指定文件 diff.
	 * @param {string} path 文件路径.
	 * @param {boolean} staged 是否暂存区差异.
	 * @param {string} [serverId] 服务端ID.
	 */
	async function loadGitDiff(
		path,
		staged = false,
		serverId = state.control.selectedServerId,
	) {
		const server = getServerById(serverId);
		if (!server || !path) {
			return;
		}
		withServerTabContext(serverId, () => {
			state.git.diffLoading = true;
			state.git.error = '';
			state.git.selectedPath = path;
			state.git.selectedFrom = staged ? 'staged' : 'modified';
			state.git.diffStaged = staged;
			render();
		});
		try {
			const data = await requestGit('/api/git/diff', {
				workDir: server.workDir,
				path,
				staged,
			});
			withServerTabContext(serverId, () => {
				state.git.diffText = String(data?.diffText ?? '');
				render();
			});
		} catch (error) {
			withServerTabContext(serverId, () => {
				state.git.error =
					error instanceof Error ? error.message : '加载差异失败';
				state.git.diffText = '';
				render();
			});
		} finally {
			withServerTabContext(serverId, () => {
				state.git.diffLoading = false;
				render();
			});
		}
	}

	/**
	 * 暂存文件.
	 * @param {string} path 文件路径.
	 */
	async function stageGitFile(path) {
		const serverId = state.control.selectedServerId;
		const server = getServerById(serverId);
		if (!server || !path) {
			return;
		}
		try {
			await requestGit('/api/git/stage', {
				workDir: server.workDir,
				paths: [path],
			});
			await refreshGitStatus(serverId);
			await loadGitDiff(path, true, serverId);
		} catch (error) {
			withServerTabContext(serverId, () => {
				state.git.error = error instanceof Error ? error.message : '暂存失败';
				render();
			});
		}
	}

	/**
	 * 取消暂存文件.
	 * @param {string} path 文件路径.
	 */
	async function unstageGitFile(path) {
		const serverId = state.control.selectedServerId;
		const server = getServerById(serverId);
		if (!server || !path) {
			return;
		}
		try {
			await requestGit('/api/git/unstage', {
				workDir: server.workDir,
				paths: [path],
			});
			await refreshGitStatus(serverId);
			await loadGitDiff(path, false, serverId);
		} catch (error) {
			withServerTabContext(serverId, () => {
				state.git.error =
					error instanceof Error ? error.message : '取消暂存失败';
				render();
			});
		}
	}

	/**
	 * 更新提交信息.
	 * @param {string} message 提交信息.
	 */
	function updateCommitMessage(message) {
		state.git.commitMessage = message;
	}

	/**
	 * 执行提交.
	 */
	async function commitGitChanges() {
		const serverId = state.control.selectedServerId;
		const server = getServerById(serverId);
		if (!server) {
			return;
		}
		const commitMessage = withServerTabContext(
			serverId,
			() => state.git.commitMessage,
		);
		const canCommit = withServerTabContext(
			serverId,
			() =>
				state.git.staged.length > 0 &&
				String(state.git.commitMessage ?? '').trim().length > 0,
		);
		if (!canCommit) {
			withServerTabContext(serverId, () => {
				state.git.error = '提交信息必填且暂存区不能为空';
				render();
			});
			return;
		}
		withServerTabContext(serverId, () => {
			state.git.commitLoading = true;
			state.git.error = '';
			render();
		});
		try {
			await requestGit('/api/git/commit', {
				workDir: server.workDir,
				message: commitMessage,
			});
			withServerTabContext(serverId, () => {
				state.git.commitMessage = '';
				state.git.diffText = '';
			});
			await refreshGitStatus(serverId);
		} catch (error) {
			withServerTabContext(serverId, () => {
				state.git.error = error instanceof Error ? error.message : '提交失败';
				render();
			});
		} finally {
			withServerTabContext(serverId, () => {
				state.git.commitLoading = false;
				render();
			});
		}
	}

	return {
		switchMainView,
		refreshGitStatus,
		initGitRepo,
		loadGitDiff,
		stageGitFile,
		unstageGitFile,
		updateCommitMessage,
		commitGitChanges,
	};
}
