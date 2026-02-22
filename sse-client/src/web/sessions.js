import {
	state,
	ensureServerTab,
	setSessions,
	pushMessage,
	syncCurrentSessionEvents,
	withServerTabContext,
	clearSessionAttention,
	clearTodoUnread,
} from './state.js';

/**
 * 创建会话管理动作.
 * @param {{render:()=>void,getBaseUrl:(serverId?:string)=>string}} options 依赖项.
 * @returns {{refreshSessionList:(page?:number,serverId?:string)=>Promise<void>,openSessionModal:()=>void,closeSessionModal:()=>void,selectRecentSession:(sessionId:string)=>void,prevSessionPage:()=>Promise<void>,nextSessionPage:()=>Promise<void>,loadSelectedSession:(sessionId:string)=>Promise<void>,deleteSelectedSession:(sessionId:string)=>Promise<void>}}
 */
export function createSessionActions(options) {
	const {render, getBaseUrl} = options;

	/**
	 * 刷新会话列表,支持分页.
	 * @param {number} [page] 页码.
	 * @param {string} [serverId] 服务端ID.
	 */
	async function refreshSessionList(
		page,
		serverId = state.control.selectedServerId,
	) {
		const tab = ensureServerTab(serverId);
		if (!tab) {
			return;
		}
		const baseUrl = getBaseUrl(serverId);
		if (!baseUrl) {
			return;
		}
		const pager = tab.chat.sessionPager;
		const targetPage = Math.max(0, page ?? pager.page);
		pager.loading = true;
		pager.page = targetPage;
		const requestKey = `${pager.page}:${pager.pageSize}`;
		pager.requestKey = requestKey;
		withServerTabContext(serverId, () => {
			render();
		});
		try {
			const response = await fetch(
				`${baseUrl}/session/list?page=${pager.page}&pageSize=${pager.pageSize}`,
			);
			const payload = await response.json();
			if (
				!response.ok ||
				!payload?.success ||
				pager.requestKey !== requestKey
			) {
				return;
			}
			const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
			withServerTabContext(serverId, () => {
				setSessions(sessions);
				pager.total = Number(payload.total ?? sessions.length) || 0;
				pager.hasMore = Boolean(payload.hasMore);
				if (!pager.selectedSessionId && sessions.length > 0) {
					pager.selectedSessionId = sessions[0].id ?? '';
				}
			});
		} catch {
			// 会话列表失败不阻断聊天主流程.
		} finally {
			if (pager.requestKey === requestKey) {
				pager.loading = false;
			}
			withServerTabContext(serverId, () => {
				render();
			});
		}
	}

	/**
	 * 打开会话管理弹窗.
	 */
	function openSessionModal() {
		const modal = document.getElementById('sessionModal');
		modal?.classList.remove('hidden');
		void refreshSessionList();
	}

	/**
	 * 关闭会话管理弹窗.
	 */
	function closeSessionModal() {
		document.getElementById('sessionModal')?.classList.add('hidden');
	}

	/**
	 * 选择最近会话.
	 * @param {string} sessionId 会话ID.
	 */
	function selectRecentSession(sessionId) {
		state.chat.currentSessionId = sessionId;
		state.chat.sessionPager.selectedSessionId = sessionId;
		syncCurrentSessionEvents(sessionId);
		state.chat.dialogs.logDetailOpen = false;
		state.chat.dialogs.logDetailTitle = '';
		state.chat.dialogs.logDetailJson = '';
		clearSessionAttention(sessionId);
		clearTodoUnread();
		render();
	}

	/**
	 * 上一页.
	 */
	async function prevSessionPage() {
		if (state.chat.sessionPager.page <= 0) {
			return;
		}
		await refreshSessionList(state.chat.sessionPager.page - 1);
	}

	/**
	 * 下一页.
	 */
	async function nextSessionPage() {
		if (!state.chat.sessionPager.hasMore) {
			return;
		}
		await refreshSessionList(state.chat.sessionPager.page + 1);
	}

	/**
	 * 归一化会话历史消息文本,兼容多种字段结构.
	 * @param {any} message 历史消息对象.
	 * @returns {string}
	 */
	function normalizeHistoryMessageText(message) {
		const raw =
			message?.content ??
			message?.text ??
			message?.message ??
			message?.value ??
			'';
		if (Array.isArray(raw)) {
			return raw
				.map(item => {
					if (typeof item === 'string') {
						return item;
					}
					return String(item?.text ?? item?.content ?? '');
				})
				.filter(Boolean)
				.join('\n');
		}
		return String(raw ?? '');
	}

	/**
	 * 将服务端历史消息转换为精简展示格式.
	 * @param {Array<any>} history 原始历史消息.
	 * @returns {Array<{role:'assistant'|'user'|'error',content:string,timestamp:string}>}
	 */
	function convertSessionHistoryToChatMessages(history) {
		const messages = [];
		for (const item of history) {
			const role = String(item?.role ?? item?.sender ?? '');
			const timestamp = item?.timestamp ?? new Date().toISOString();
			if (role === 'tool' || role === 'system') {
				continue;
			}
			if (role === 'assistant' || role === 'user' || role === 'error') {
				const text = normalizeHistoryMessageText(item);
				if (text) {
					messages.push({role, content: text, timestamp});
				}
			}
			if (
				role === 'user' &&
				Array.isArray(item?.images) &&
				item.images.length > 0
			) {
				messages.push({role: 'user', content: '[包含图片]', timestamp});
			}
		}
		return messages.slice(-120);
	}

	/**
	 * 继续会话并渲染历史消息.
	 * @param {string} sessionId 会话ID.
	 */
	async function loadSelectedSession(sessionId) {
		const serverId = state.control.selectedServerId;
		const tab = ensureServerTab(serverId);
		if (!tab) {
			return;
		}
		const baseUrl = getBaseUrl(serverId);
		if (!baseUrl || !sessionId) {
			return;
		}
		try {
			const response = await fetch(`${baseUrl}/session/load`, {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({sessionId}),
			});
			const payload = await response.json();
			if (!response.ok || !payload?.success || !payload?.session?.id) {
				withServerTabContext(serverId, () => {
					pushMessage('error', '加载会话失败');
					render();
				});
				return;
			}

			withServerTabContext(serverId, () => {
				tab.chat.currentSessionId = payload.session.id;
				tab.chat.sessionPager.selectedSessionId = payload.session.id;
				syncCurrentSessionEvents(payload.session.id);
				tab.chat.dialogs.logDetailOpen = false;
				tab.chat.dialogs.logDetailTitle = '';
				tab.chat.dialogs.logDetailJson = '';
				clearSessionAttention(payload.session.id);
				clearTodoUnread();
				const history = Array.isArray(payload.session.messages)
					? payload.session.messages
					: [];
				tab.chat.messages = convertSessionHistoryToChatMessages(history);
			});
			await refreshSessionList(tab.chat.sessionPager.page, serverId);
		} catch {
			withServerTabContext(serverId, () => {
				pushMessage('error', '加载会话失败');
				render();
			});
		}
	}

	/**
	 * 永久删除会话(二次确认).
	 * @param {string} sessionId 会话ID.
	 */
	async function deleteSelectedSession(sessionId) {
		const serverId = state.control.selectedServerId;
		const tab = ensureServerTab(serverId);
		if (!tab) {
			return;
		}
		const baseUrl = getBaseUrl(serverId);
		if (!baseUrl || !sessionId) {
			return;
		}
		const confirmed = window.confirm(
			`确认永久删除会话 ${sessionId} ? 删除后不可恢复.`,
		);
		if (!confirmed) {
			return;
		}
		try {
			const response = await fetch(
				`${baseUrl}/session/${encodeURIComponent(sessionId)}`,
				{method: 'DELETE'},
			);
			const payload = await response.json();
			if (!response.ok || !payload?.deleted) {
				withServerTabContext(serverId, () => {
					pushMessage('error', '删除会话失败');
					render();
				});
				return;
			}
			withServerTabContext(serverId, () => {
				pushMessage('system', `已删除会话: ${sessionId}`);
				if (tab.chat.currentSessionId === sessionId) {
					tab.chat.currentSessionId = '';
					tab.chat.messages = [];
				}
				if (tab.chat.sessionPager.page > 0 && tab.chat.sessions.length <= 1) {
					tab.chat.sessionPager.page -= 1;
				}
				tab.chat.sessionPager.selectedSessionId = '';
			});
			await refreshSessionList(tab.chat.sessionPager.page, serverId);
		} catch {
			withServerTabContext(serverId, () => {
				pushMessage('error', '删除会话失败');
				render();
			});
		}
	}

	return {
		refreshSessionList,
		openSessionModal,
		closeSessionModal,
		selectRecentSession,
		prevSessionPage,
		nextSessionPage,
		loadSelectedSession,
		deleteSelectedSession,
	};
}
