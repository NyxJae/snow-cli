/**
 * 创建聊天状态.
 * @returns {any}
 */
function createChatState() {
	return {
		messages: [],
		events: [],
		eventSeq: 0,
		currentSessionEvents: [],
		todos: [],
		sessions: [],
		recentSessions: [],
		currentSessionId: '',
		error: '',
		dialogs: {
			logDetailOpen: false,
			logDetailTitle: '',
			logDetailJson: '',
		},
		mainAgent: {
			agents: [],
			currentAgentId: '',
			lastConfirmedAgentId: '',
			preferredAgentIdForNewSession: '',
			isSwitchingAgent: false,
			requestedAgentId: '',
		},
		statusBar: {
			apiProfile: '-',
			contextPercent: 0,
			tokenUsed: 0,
			tokenTotal: 0,
			kvCacheRead: 0,
			kvCacheCreate: 0,
			yoloMode: true,
		},
		quickSwitch: {
			profile: '',
			preferredProfileForNewSession: '',
		},
		subAgents: [],
		ui: {
			logPanelCollapsed: true,
			logUnreadCount: 0,
			todoUnreadCount: 0,
			chatAutoScrollEnabled: true,
			chatManualScrollTop: 0,
			infoMessages: [],
			tipMuteUntilByType: {},
			sessionAttention: {},
			subAgentExpandedById: {},
			subAgentPopupIndex: 0,
			pendingDraftText: '',
			pendingImages: [],
			pendingRollbackContent: '',
			assistantWorking: false,
			queuedUserMessages: [],
			queuedMessageSeq: 0,
			flushingQueuedMessage: false,
			compressFlowState: {
				active: false,
				sourceSessionId: '',
				startedAt: 0,
			},
		},
		sessionTouchedAt: {},
		sessionPager: {
			page: 0,
			pageSize: 20,
			total: 0,
			hasMore: false,
			loading: false,
			selectedSessionId: '',
			requestKey: '',
		},
	};
}

/**
 * 创建连接状态.
 * @returns {any}
 */
function createConnectionState() {
	return {
		baseUrl: '',
		status: 'disconnected',
		connectionId: '',
		eventSource: null,
		retryTimer: null,
		retryCount: 0,
		maxRetries: 3,
		retryDelayMs: 1500,
	};
}

/**
 * 创建 Git 视图状态.
 * @returns {any}
 */
function createGitState() {
	return {
		view: 'chat',
		loading: false,
		error: '',
		isInitialized: false,
		modified: [],
		untracked: [],
		deleted: [],
		staged: [],
		selectedPath: '',
		selectedFrom: 'modified',
		diffText: '',
		diffStaged: false,
		diffLoading: false,
		commitMessage: '',
		commitLoading: false,
		initLoading: false,
	};
}

/**
 * 创建服务端Tab状态.
 * @returns {{chat:any,connection:any,git:any}}
 */
function createServerTabState() {
	return {
		chat: createChatState(),
		connection: createConnectionState(),
		git: createGitState(),
	};
}

/**
 * 应用状态树.
 */
export const state = {
	auth: {
		isLoggedIn: false,
		error: '',
	},
	control: {
		servers: [],
		selectedServerId: '',
		loading: false,
		actionLoading: false,
		error: '',
		workDirPresets: [],
		profileOptions: [],
		activeProfile: '',
		serverTabs: {},
		serverForm: {
			workDir: '',
			port: '',
			timeoutMs: 300000,
		},
	},
	chat: createChatState(),
	connection: createConnectionState(),
	git: createGitState(),
};

/**
 * 确保服务端Tab存在.
 * @param {string} serverId 服务端ID.
 * @returns {{chat:any,connection:any}|null}
 */
export function ensureServerTab(serverId) {
	if (!serverId) {
		return null;
	}
	if (!state.control.serverTabs[serverId]) {
		state.control.serverTabs[serverId] = createServerTabState();
	}
	return state.control.serverTabs[serverId];
}

/**
 * 激活服务端Tab上下文.
 * @param {string} serverId 服务端ID.
 */
export function activateServerTab(serverId) {
	if (!serverId) {
		state.control.selectedServerId = '';
		state.chat = createChatState();
		state.connection = createConnectionState();
		state.git = createGitState();
		return;
	}
	const tab = ensureServerTab(serverId);
	if (!tab) {
		return;
	}
	state.control.selectedServerId = serverId;
	state.chat = tab.chat;
	state.connection = tab.connection;
	state.git = tab.git;
}

/**
 * 在指定服务端Tab上下文中执行逻辑,执行后恢复原Tab.
 * @template T
 * @param {string} serverId 服务端ID.
 * @param {()=>T} handler 执行函数.
 * @returns {T}
 */
export function withServerTabContext(serverId, handler) {
	const previousServerId = state.control.selectedServerId;
	activateServerTab(serverId);
	const restorePrevious = () => {
		if (previousServerId !== serverId) {
			activateServerTab(previousServerId);
		}
	};
	try {
		const result = handler();
		if (result && typeof result.then === 'function') {
			return result.finally(() => {
				restorePrevious();
			});
		}
		restorePrevious();
		return result;
	} catch (error) {
		restorePrevious();
		throw error;
	}
}

/**
 * 根据服务列表同步Tab上下文.
 * @param {Array<{serverId:string}>} servers 服务列表.
 */
export function syncServerTabs(servers) {
	const normalized = Array.isArray(servers) ? servers : [];
	const serverIdSet = new Set(
		normalized
			.map(item => item?.serverId)
			.filter(item => typeof item === 'string' && item.length > 0),
	);
	for (const [serverId, tab] of Object.entries(state.control.serverTabs)) {
		if (serverIdSet.has(serverId)) {
			continue;
		}
		if (tab.connection.eventSource) {
			tab.connection.eventSource.close();
		}
		if (tab.connection.retryTimer !== null) {
			window.clearTimeout(tab.connection.retryTimer);
		}
		delete state.control.serverTabs[serverId];
	}
	for (const server of normalized) {
		ensureServerTab(server.serverId);
	}
	const selected = state.control.selectedServerId;
	if (selected && serverIdSet.has(selected)) {
		activateServerTab(selected);
		return;
	}
	const firstServerId = normalized[0]?.serverId ?? '';
	activateServerTab(firstServerId);
}

/**
 * 获取会话展示时间.
 * @param {{lastUpdatedAt?:string|number,updatedAt?:string|number,createdAt?:string|number}} session 会话.
 * @returns {number}
 */
export function getSessionTime(session) {
	const raw = session.lastUpdatedAt ?? session.updatedAt ?? session.createdAt;
	if (raw === undefined || raw === null) {
		return 0;
	}
	if (typeof raw === 'number') {
		return raw;
	}
	const timestamp = Date.parse(String(raw));
	return Number.isNaN(timestamp) ? 0 : timestamp;
}

/**
 * 统一记录SSE事件并截断长度.
 * @param {{type:string,data:any,timestamp?:string}} event SSE事件.
 */
export function pushEvent(event) {
	const sessionId =
		typeof event.data?.sessionId === 'string'
			? event.data.sessionId
			: undefined;
	state.chat.eventSeq += 1;
	state.chat.events.unshift({
		id: `evt-${state.chat.eventSeq}`,
		type: event.type,
		data: event.data,
		timestamp: event.timestamp ?? new Date().toISOString(),
		sessionId,
	});
	state.chat.events = state.chat.events.slice(0, 80);
}

/**
 * 增加日志未读计数.
 */
export function incrementLogUnread() {
	state.chat.ui.logUnreadCount += 1;
}

/**
 * 清空日志未读计数.
 */
export function clearLogUnread() {
	state.chat.ui.logUnreadCount = 0;
}

/**
 * 增加 TODO 未读计数.
 */
export function incrementTodoUnread() {
	state.chat.ui.todoUnreadCount += 1;
}

/**
 * 清空 TODO 未读计数.
 */
export function clearTodoUnread() {
	state.chat.ui.todoUnreadCount = 0;
}

/**
 * 标记会话需要关注.
 * @param {string} sessionId 会话ID.
 */
export function markSessionAttention(sessionId) {
	if (!sessionId) {
		return;
	}
	state.chat.ui.sessionAttention[sessionId] = true;
}

/**
 * 清除会话关注标记.
 * @param {string} sessionId 会话ID.
 */
export function clearSessionAttention(sessionId) {
	if (!sessionId) {
		return;
	}
	delete state.chat.ui.sessionAttention[sessionId];
}

/**
 * 汇总所有服务端Tab的 info 提醒,用于全局 Tips 展示与到期调度.
 * @returns {Array<any>}
 */
export function getAllInfoMessages() {
	const merged = [];
	const seen = new Set();
	const appendUnique = list => {
		for (const item of list ?? []) {
			const id = String(item?.id ?? '');
			if (!id || seen.has(id)) {
				continue;
			}
			seen.add(id);
			merged.push(item);
		}
	};
	appendUnique(state.chat.ui.infoMessages);
	for (const tab of Object.values(state.control.serverTabs)) {
		appendUnique(tab?.chat?.ui?.infoMessages);
	}
	return merged;
}

/**
 * 查找指定 info 提醒在当前或其他服务端Tab中的存储位置.
 * @param {string} infoId 提示ID.
 * @returns {{list:Array<any>,index:number,chat:any}|null}
 */
function findInfoMessageRef(infoId) {
	const activeIndex = state.chat.ui.infoMessages.findIndex(
		item => item.id === infoId,
	);
	if (activeIndex >= 0) {
		return {
			list: state.chat.ui.infoMessages,
			index: activeIndex,
			chat: state.chat,
		};
	}
	for (const tab of Object.values(state.control.serverTabs)) {
		if (!tab?.chat?.ui?.infoMessages || tab.chat === state.chat) {
			continue;
		}
		const index = tab.chat.ui.infoMessages.findIndex(
			item => item.id === infoId,
		);
		if (index >= 0) {
			return {list: tab.chat.ui.infoMessages, index, chat: tab.chat};
		}
	}
	return null;
}

/**
 * 追加 info 消息.
 * @param {string} message 消息文本.
 * @param {{tipType?:string,serverId?:string,sessionId?:string,maxCount?:number,allowCurrentSession?:boolean}} [options] 附加参数.
 */
export function pushInfoMessage(message, options = {}) {
	if (!message) {
		return;
	}
	const tipType = options.tipType ?? '';
	if (tipType && isTipMuted(tipType)) {
		return;
	}
	const allowCurrentSession = Boolean(options.allowCurrentSession);
	if (
		!allowCurrentSession &&
		options.sessionId &&
		options.sessionId === state.chat.currentSessionId
	) {
		return;
	}
	const maxCount = Math.max(1, Number(options.maxCount ?? 3));
	state.chat.ui.infoMessages.unshift({
		id: `info-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		message,
		timestamp: new Date().toISOString(),
		tipType,
		serverId: options.serverId ?? '',
		sessionId: options.sessionId ?? '',
		remainingMs: 5000,
		expiresAt: Date.now() + 5000,
	});
	state.chat.ui.infoMessages = state.chat.ui.infoMessages.slice(0, maxCount);
}

/**
 * 查询指定提醒类型是否处于静默期.
 * @param {string} tipType 提醒类型.
 * @returns {boolean}
 */
export function isTipMuted(tipType) {
	if (!tipType) {
		return false;
	}
	const muteUntil = Number(state.chat.ui.tipMuteUntilByType[tipType] ?? 0);
	return muteUntil > Date.now();
}

/**
 * 设置提醒类型静默截止时间.
 * @param {string} tipType 提醒类型.
 * @param {number} muteUntil 截止时间戳.
 */
export function setTipMuteUntil(tipType, muteUntil) {
	if (!tipType) {
		return;
	}
	state.chat.ui.tipMuteUntilByType[tipType] = Number(muteUntil) || 0;
}

/**
 * 关闭一条 info 提醒,可选触发同类静默.
 * @param {string} infoId 提示ID.
 * @param {number} [muteMs] 同类静默时长(毫秒).
 */
export function dismissInfoMessage(infoId, muteMs = 0) {
	if (!infoId) {
		return;
	}
	const ref = findInfoMessageRef(infoId);
	if (!ref) {
		return;
	}
	const target = ref.list[ref.index];
	ref.list.splice(ref.index, 1);
	if (target?.tipType && muteMs > 0) {
		const muteUntil = Date.now() + muteMs;
		ref.chat.ui.tipMuteUntilByType[target.tipType] = muteUntil;
	}
}

/**
 * 暂停一条 info 提醒倒计时.
 * @param {string} infoId 提示ID.
 */
export function pauseInfoMessageCountdown(infoId) {
	if (!infoId) {
		return;
	}
	const ref = findInfoMessageRef(infoId);
	if (!ref) {
		return;
	}
	const target = ref.list[ref.index];
	const currentExpiresAt = Number(target.expiresAt ?? 0);
	const remainingMs = Math.max(0, currentExpiresAt - Date.now());
	target.remainingMs = remainingMs;
	target.expiresAt = Number.MAX_SAFE_INTEGER;
}

/**
 * 恢复一条 info 提醒倒计时.
 * @param {string} infoId 提示ID.
 */
export function resumeInfoMessageCountdown(infoId) {
	if (!infoId) {
		return;
	}
	const ref = findInfoMessageRef(infoId);
	if (!ref) {
		return;
	}
	const target = ref.list[ref.index];
	const remainingMs = Math.max(0, Number(target.remainingMs ?? 0));
	target.expiresAt = Date.now() + remainingMs;
}

/**
 * 统一追加聊天消息并截断长度.
 * @param {'system'|'assistant'|'user'|'error'} role 消息角色.
 * @param {string} content 消息文本.
 * @param {Record<string, any>} [extra] 扩展字段.
 */
export function pushMessage(role, content, extra = {}) {
	state.chat.messages.push({
		role,
		content,
		timestamp: new Date().toISOString(),
		...extra,
	});
	state.chat.messages = state.chat.messages.slice(-120);
}

/**
 * 最近会话重排逻辑.
 * @param {Array<any>} sessions 会话集合.
 */
export function setSessions(sessions) {
	const normalized = Array.isArray(sessions) ? sessions : [];
	state.chat.sessions = normalized.map(item => {
		const id = item?.id ?? '';
		const touchedAt = id ? state.chat.sessionTouchedAt[id] : undefined;
		if (!id || !touchedAt) {
			return item;
		}
		const baseTime = getSessionTime(item);
		if (baseTime >= touchedAt) {
			return {...item, lastUpdatedAt: new Date(baseTime).toISOString()};
		}
		return {...item, lastUpdatedAt: new Date(touchedAt).toISOString()};
	});
	state.chat.recentSessions = [...state.chat.sessions]
		.sort((left, right) => getSessionTime(right) - getSessionTime(left))
		.slice(0, 5);
}

/**
 * 从会话列表中更新当前会话时间并重排.
 * @param {string} sessionId 会话ID.
 */
export function touchSession(sessionId) {
	if (!sessionId) {
		return;
	}
	const now = Date.now();
	state.chat.sessionTouchedAt[sessionId] = now;
	const session = state.chat.sessions.find(item => item.id === sessionId);
	if (session) {
		session.lastUpdatedAt = new Date(now).toISOString();
	}
	setSessions(state.chat.sessions);
}

/**
 * 根据当前会话同步日志视图,确保日志详情只展示当前会话事件.
 * @param {string} [sessionId] 会话ID,默认使用当前会话.
 */
export function syncCurrentSessionEvents(
	sessionId = state.chat.currentSessionId,
) {
	if (!sessionId) {
		state.chat.currentSessionEvents = [];
		return;
	}
	state.chat.currentSessionEvents = state.chat.events
		.filter(item => item?.sessionId === sessionId)
		.slice(0, 20);
}

/**
 * 清空连接相关聊天状态.
 */
export function resetChatForConnect() {
	const fresh = createChatState();
	state.chat.error = '';
	state.chat.messages = [];
	state.chat.events = [];
	state.chat.eventSeq = 0;
	state.chat.currentSessionEvents = [];
	state.chat.todos = [];
	state.chat.currentSessionId = '';
	state.chat.dialogs.logDetailOpen = false;
	state.chat.dialogs.logDetailTitle = '';
	state.chat.dialogs.logDetailJson = '';
	state.chat.mainAgent = fresh.mainAgent;
	state.chat.statusBar = fresh.statusBar;
	state.chat.subAgents = [];
	state.chat.ui = fresh.ui;
	state.chat.sessionTouchedAt = {};
	state.chat.sessionPager.page = 0;
	state.chat.sessionPager.total = 0;
	state.chat.sessionPager.hasMore = false;
	state.chat.sessionPager.selectedSessionId = '';
	state.chat.sessionPager.requestKey = '';
	setSessions([]);
}

/**
 * 登出后重置状态.
 */
export function resetStateAfterLogout() {
	for (const tab of Object.values(state.control.serverTabs)) {
		if (tab.connection.eventSource) {
			tab.connection.eventSource.close();
		}
		if (tab.connection.retryTimer !== null) {
			window.clearTimeout(tab.connection.retryTimer);
		}
	}
	state.auth.isLoggedIn = false;
	state.auth.error = '';
	state.control.servers = [];
	state.control.selectedServerId = '';
	state.control.workDirPresets = [];
	state.control.profileOptions = [];
	state.control.activeProfile = '';
	state.control.serverTabs = {};
	resetChatForConnect();
	state.connection.baseUrl = '';
	state.connection.status = 'disconnected';
	state.connection.eventSource = null;
	state.connection.retryTimer = null;
	state.connection.retryCount = 0;
}
