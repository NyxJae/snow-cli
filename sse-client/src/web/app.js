import {state, activateServerTab, getAllInfoMessages} from './state.js';
import {createControlActions, createGitActions} from './api.js';
import {createSessionActions} from './sessions.js';
import {createSseActions} from './sse.js';
import {renderApp} from './render.js';

let infoExpiryRenderTimer = null;

/**
 * 根据最早过期的 info 提示安排一次重渲染,保证到期自动消失.
 */
function scheduleInfoExpiryRender() {
	if (infoExpiryRenderTimer !== null) {
		window.clearTimeout(infoExpiryRenderTimer);
		infoExpiryRenderTimer = null;
	}
	const now = Date.now();
	const nextExpiresAt = getAllInfoMessages()
		.map(item => Number(item.expiresAt ?? 0))
		.filter(timestamp => timestamp > now && timestamp < Number.MAX_SAFE_INTEGER)
		.sort((left, right) => left - right)[0];
	if (!nextExpiresAt) {
		return;
	}
	const delay = Math.max(0, nextExpiresAt - now);
	infoExpiryRenderTimer = window.setTimeout(() => {
		infoExpiryRenderTimer = null;
		render();
	}, delay + 10);
}

/**
 * 渲染入口,统一注入动作.
 */
function render() {
	renderApp(actions);
	scheduleInfoExpiryRender();
}

const sessionActions = createSessionActions({
	render,
	getBaseUrl: serverId => {
		if (!serverId) {
			return state.connection.baseUrl;
		}
		return (
			state.control.serverTabs[serverId]?.connection.baseUrl ??
			state.connection.baseUrl
		);
	},
});

const sseActions = createSseActions({
	render,
	refreshSessionList: serverId =>
		sessionActions.refreshSessionList(undefined, serverId),
	loadSelectedSession: sessionId =>
		sessionActions.loadSelectedSession(sessionId),
});

/**
 * 登录后或启动时连接全部已登记服务端,并保持当前选中Tab.
 * 仅连接未连接的服务端,避免刷新时强制重连导致聊天状态被重置.
 */
async function connectAllServersAfterRefresh() {
	const serverIds = state.control.servers
		.map(item => item?.serverId)
		.filter(serverId => typeof serverId === 'string' && serverId.length > 0);
	for (const serverId of serverIds) {
		const tab = state.control.serverTabs[serverId];
		const isConnected =
			tab?.connection?.status === 'connected' &&
			tab?.connection?.eventSource !== null;
		if (isConnected) {
			continue;
		}
		actions.connectSelectedServer(false, serverId);
	}
	if (serverIds.length > 0) {
		actions.selectServerTab(state.control.selectedServerId || serverIds[0]);
	}
}

const controlActions = createControlActions({
	render,
	onAfterLogout: () => sseActions.closeConnection('manual'),
	onAfterServersRefreshed: connectAllServersAfterRefresh,
});

const gitActions = createGitActions({render});

const actions = {
	...controlActions,
	...sessionActions,
	...sseActions,
	...gitActions,
	selectServerTab: serverId => {
		activateServerTab(serverId);
		if (state.git.view === 'git') {
			void gitActions.refreshGitStatus(serverId);
		}
		render();
	},
};

/**
 * 应用启动入口.
 */
async function bootstrap() {
	await actions.checkAuth();
	if (state.auth.isLoggedIn) {
		await actions.bootAfterLogin();
	}
	render();
}

void bootstrap();
