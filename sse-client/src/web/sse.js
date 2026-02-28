import {
	state,
	pushEvent,
	pushMessage,
	touchSession,
	syncCurrentSessionEvents,
	resetChatForConnect,
	withServerTabContext,
	incrementLogUnread,
	clearLogUnread,
	incrementTodoUnread,
	clearTodoUnread,
	pushInfoMessage,
	markSessionAttention,
	clearSessionAttention,
	pauseInfoMessageCountdown,
	resumeInfoMessageCountdown,
	dismissInfoMessage as dismissInfoMessageInState,
	markRunningSession,
	clearRunningSession,
	markSessionTerminalUnread,
	setTerminalReminderWindowActive,
	getUnreadTerminalCount,
	markTerminalReminderPopupShown,
} from './state.js';
import {showToolConfirmationDialog, showUserQuestionDialog} from './dialogs.js';
import {escapeHtml} from './utils.js';

/**
 * 创建SSE与聊天动作.
 * @param {{render:()=>void,renderChatOnly?:()=>void,refreshSessionList:(serverId?:string)=>Promise<void>,loadSelectedSession?:(sessionId:string)=>Promise<void>}} options 依赖项.
 * @returns {{connectSelectedServer:(isReconnect?:boolean,serverId?:string)=>void,closeConnection:(reason?:'manual'|'error',serverId?:string)=>void,reconnectNow:()=>void,sendChat:()=>Promise<void>,openLogDetail:(eventId:string)=>void,openLogTextDetail:(role:string,content:string,timestamp?:string)=>void,closeLogDetail:()=>void}}
 */
export function createSseActions(options) {
	const {
		render,
		renderChatOnly = render,
		refreshSessionList,
		loadSelectedSession,
	} = options;

	/**
	 * 获取当前Tab的压缩流程状态.
	 * @returns {{active:boolean,sourceSessionId:string,startedAt:number,waitHintShown:boolean}}
	 */
	function getCompressFlowState() {
		if (!state.chat.ui.compressFlowState) {
			state.chat.ui.compressFlowState = {
				active: false,
				sourceSessionId: '',
				startedAt: 0,
				waitHintShown: false,
			};
		}
		if (typeof state.chat.ui.compressFlowState.waitHintShown !== 'boolean') {
			state.chat.ui.compressFlowState.waitHintShown = false;
		}
		return state.chat.ui.compressFlowState;
	}

	/**
	 * 重置当前Tab的压缩流程状态.
	 */
	function resetCompressFlowState() {
		const flowState = getCompressFlowState();
		flowState.active = false;
		flowState.sourceSessionId = '';
		flowState.startedAt = 0;
		flowState.waitHintShown = false;
	}

	/**
	 * 清理重连定时器.
	 */
	function clearRetryTimer() {
		if (state.connection.retryTimer !== null) {
			window.clearTimeout(state.connection.retryTimer);
			state.connection.retryTimer = null;
		}
	}

	/**
	 * 关闭指定服务端Tab的SSE连接.
	 * @param {'manual'|'error'} [reason] 关闭原因.
	 * @param {string} [serverId] 服务端ID,默认当前激活Tab.
	 */
	function closeConnection(
		reason = 'manual',
		serverId = state.control.selectedServerId,
	) {
		withServerTabContext(serverId, () => {
			if (state.connection.eventSource) {
				state.connection.eventSource.close();
				state.connection.eventSource = null;
			}
			clearRetryTimer();
			resetCompressFlowState();
			state.connection.connectionId = '';
			state.connection.status = reason === 'error' ? 'error' : 'disconnected';
			state.chat.ui.assistantWorking = false;
			state.chat.ui.flushingQueuedMessage = false;
			state.chat.ui.queuedUserMessages = [];
			state.chat.ui.queuedMessageSeq = 0;
			state.chat.statusBar.sessionWorkStatus = '已停止';
		});
	}

	/**
	 * 发送审批/提问响应.
	 * @param {'tool_confirmation_response'|'user_question_response'} type 响应类型.
	 * @param {string} requestId 请求ID.
	 * @param {any} response 响应内容.
	 * @param {string} [sessionId] 关联会话ID.
	 */
	async function sendInteractiveResponse(type, requestId, response, sessionId) {
		const baseUrl = state.connection.baseUrl;
		if (!baseUrl) {
			pushMessage('error', '未连接服务,无法发送交互响应');
			render();
			return;
		}
		try {
			const httpResponse = await fetch(`${baseUrl}/message`, {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({
					type,
					requestId,
					response,
					connectionId: state.connection.connectionId || undefined,
				}),
			});
			if (!httpResponse.ok) {
				throw new Error(`响应发送失败: HTTP ${httpResponse.status}`);
			}
			if (sessionId) {
				clearSessionAttention(sessionId);
			}
			render();
		} catch (error) {
			pushMessage(
				'error',
				error instanceof Error ? error.message : '响应发送失败',
			);
			render();
		}
	}

	/**
	 * 打开日志详情弹窗.
	 * @param {string} eventId 事件ID.
	 */
	function openLogDetail(eventId) {
		const event = state.chat.currentSessionEvents.find(
			item => item.id === eventId,
		);
		if (!event) {
			return;
		}
		state.chat.dialogs.logDetailOpen = true;
		state.chat.dialogs.logDetailTitle = `日志详情 - ${event.type}`;
		state.chat.dialogs.logDetailJson = JSON.stringify(
			event.data ?? null,
			null,
			2,
		);
		render();
	}

	/**
	 * 打开文本日志详情弹窗.
	 * @param {string} role 日志角色.
	 * @param {string} content 日志内容.
	 * @param {string} [timestamp] 时间戳.
	 */
	function openLogTextDetail(role, content, timestamp = '') {
		state.chat.dialogs.logDetailOpen = true;
		state.chat.dialogs.logDetailTitle = `日志详情 - ${role || 'system'}`;
		state.chat.dialogs.logDetailJson = JSON.stringify(
			{
				role: role || 'system',
				timestamp: timestamp || '',
				content: content || '',
			},
			null,
			2,
		);
		render();
	}

	/**
	 * 打开日志弹窗.
	 */
	function openLogModal() {
		state.chat.dialogs.logModalOpen = true;
		clearLogUnread();
		render();
	}

	/**
	 * 关闭日志弹窗.
	 */
	function closeLogModal() {
		state.chat.dialogs.logModalOpen = false;
		render();
	}

	/**
	 * 打开未查看终态弹窗.
	 */
	function openUnreadTerminalModal() {
		state.chat.dialogs.unreadTerminalModalOpen = true;
		render();
	}

	/**
	 * 关闭未查看终态弹窗.
	 */
	function closeUnreadTerminalModal() {
		state.chat.dialogs.unreadTerminalModalOpen = false;
		render();
	}

	/**
	 * 关闭日志详情弹窗.
	 */
	function closeLogDetail() {
		state.chat.dialogs.logDetailOpen = false;
		render();
	}

	/**
	 * 切换日志弹窗开关状态.
	 */
	function toggleLogPanel() {
		state.chat.dialogs.logModalOpen = !state.chat.dialogs.logModalOpen;
		if (state.chat.dialogs.logModalOpen) {
			clearLogUnread();
		}
		render();
	}

	/**
	 * 关闭单条 info 提示.
	 * @param {string} infoId 提示ID.
	 */
	function dismissInfoMessage(infoId) {
		dismissInfoMessageInState(infoId, 5 * 60 * 1000);
		render();
	}

	/**
	 * 暂停 info 提醒倒计时.
	 * @param {string} infoId 提示ID.
	 */
	function pauseInfoCountdown(infoId) {
		pauseInfoMessageCountdown(infoId);
		render();
	}

	/**
	 * 恢复 info 提醒倒计时.
	 * @param {string} infoId 提示ID.
	 */
	function resumeInfoCountdown(infoId) {
		resumeInfoMessageCountdown(infoId);
		render();
	}

	/**
	 * 切换主代理.
	 * @param {string} agentId 主代理ID.
	 */
	async function switchMainAgent(agentId) {
		const sessionId = state.chat.currentSessionId;
		if (!agentId) {
			return;
		}
		if (!sessionId) {
			state.chat.mainAgent.preferredAgentIdForNewSession = agentId;
			render();
			return;
		}
		if (state.chat.mainAgent.isSwitchingAgent) {
			return;
		}
		if (agentId === state.chat.mainAgent.currentAgentId) {
			return;
		}
		const baseUrl = state.connection.baseUrl;
		if (!baseUrl) {
			pushMessage('error', '未连接服务,无法切换主代理');
			render();
			return;
		}
		state.chat.mainAgent.lastConfirmedAgentId =
			state.chat.mainAgent.currentAgentId;
		state.chat.mainAgent.isSwitchingAgent = true;
		state.chat.mainAgent.requestedAgentId = agentId;
		render();
		try {
			const response = await fetch(`${baseUrl}/message`, {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({
					type: 'switch_agent',
					agentId,
					sessionId,
					connectionId: state.connection.connectionId || undefined,
				}),
			});
			if (!response.ok) {
				throw new Error(`发送失败: HTTP ${response.status}`);
			}
		} catch (error) {
			state.chat.mainAgent.currentAgentId =
				state.chat.mainAgent.lastConfirmedAgentId;
			state.chat.mainAgent.isSwitchingAgent = false;
			state.chat.mainAgent.requestedAgentId = '';
			pushMessage(
				'error',
				error instanceof Error ? error.message : '主代理切换失败',
			);
			render();
		}
	}

	/**
	 * 切换 YOLO 模式开关.
	 */
	function toggleYolo() {
		state.chat.statusBar.yoloMode = !state.chat.statusBar.yoloMode;
		render();
	}

	/**
	 * 添加待发送图片文件(存入暂存区,发送时携带).
	 * 限制: 单次最多6张,单张不超过5MB,总计不超过20MB.
	 * 说明: 放宽阈值以适配常见截图体积,超限时在聊天区展示明确错误提示.
	 * @param {File[]} files 图片文件列表.
	 */
	function addImages(files) {
		const serverId = state.control.selectedServerId;
		withServerTabContext(serverId, () => {
			if (!Array.isArray(state.chat.ui.pendingImages)) {
				state.chat.ui.pendingImages = [];
			}
			state.chat.error = '';

			const MAX_IMAGES = 6;
			const MAX_SINGLE_SIZE = 5 * 1024 * 1024;
			const MAX_TOTAL_SIZE = 20 * 1024 * 1024;
			const currentTotal = state.chat.ui.pendingImages.reduce(
				(sum, f) => sum + (f.size ?? 0),
				0,
			);
			let addedTotal = currentTotal;
			for (const file of files) {
				if (!file.type.startsWith('image/')) {
					continue;
				}
				if (state.chat.ui.pendingImages.length >= MAX_IMAGES) {
					state.chat.error = `最多选择${MAX_IMAGES}张图片`;
					render();
					break;
				}
				if (file.size > MAX_SINGLE_SIZE) {
					state.chat.error = `图片 ${file.name} 超过${Math.round(
						MAX_SINGLE_SIZE / 1024 / 1024,
					)}MB限制, 已跳过`;
					render();
					continue;
				}
				if (addedTotal + file.size > MAX_TOTAL_SIZE) {
					state.chat.error = `图片总大小超过${Math.round(
						MAX_TOTAL_SIZE / 1024 / 1024,
					)}MB限制, 已跳过后续`;
					render();
					break;
				}
				addedTotal += file.size;
				state.chat.ui.pendingImages.push(file);
			}
			render();
		});
	}

	/**
	 * 删除待发送图片.
	 * @param {number} imageIndex 图片索引.
	 */
	function removePendingImage(imageIndex) {
		const serverId = state.control.selectedServerId;
		withServerTabContext(serverId, () => {
			if (!Array.isArray(state.chat.ui.pendingImages)) {
				return;
			}
			if (!Number.isInteger(imageIndex) || imageIndex < 0) {
				return;
			}
			if (imageIndex >= state.chat.ui.pendingImages.length) {
				return;
			}
			state.chat.ui.pendingImages.splice(imageIndex, 1);
			render();
		});
	}

	/**
	 * 更新输入草稿文本.
	 * @param {string} text 草稿文本.
	 */
	function updatePendingDraftText(text) {
		const serverId = state.control.selectedServerId;
		withServerTabContext(serverId, () => {
			state.chat.ui.pendingDraftText = String(text ?? '');
		});
	}

	function canFlushQueuedMessage() {
		if (state.chat.ui.assistantWorking) {
			return false;
		}
		return !state.chat.ui.flushingQueuedMessage;
	}

	function updateSessionWorkStatus() {
		const queue = Array.isArray(state.chat.ui.queuedUserMessages)
			? state.chat.ui.queuedUserMessages
			: [];
		const hasPendingQueue = queue.some(
			item => item?.status === 'queued' || item?.status === 'sending',
		);
		const isWorking =
			Boolean(state.chat.ui.assistantWorking) ||
			Boolean(state.chat.ui.flushingQueuedMessage) ||
			hasPendingQueue;
		state.chat.statusBar.sessionWorkStatus = isWorking ? '工作中' : '已停止';
	}

	function setAssistantWorking(working) {
		state.chat.ui.assistantWorking = Boolean(working);
		if (!working) {
			state.chat.ui.flushingQueuedMessage = false;
		}
		updateSessionWorkStatus();
	}

	function removeQueuedMessage(queueId) {
		const queue = Array.isArray(state.chat.ui.queuedUserMessages)
			? state.chat.ui.queuedUserMessages
			: [];
		const index = queue.findIndex(item => item.id === queueId);
		if (index === -1) {
			return null;
		}
		const [removed] = queue.splice(index, 1);
		updateSessionWorkStatus();
		return removed ?? null;
	}

	function setQueueMessageStatus(queueId, status) {
		const target = state.chat.messages.find(item => item?.queueId === queueId);
		if (!target) {
			return;
		}
		target.queueStatus = status;
		updateSessionWorkStatus();
	}

	function applyQueueMessageSent(queueId) {
		setQueueMessageStatus(queueId, 'sent');
	}

	function editQueuedMessage(queueId, content) {
		const queue = Array.isArray(state.chat.ui.queuedUserMessages)
			? state.chat.ui.queuedUserMessages
			: [];
		const target = queue.find(item => item.id === queueId);
		if (!target || target.status !== 'queued') {
			return false;
		}
		const nextContent = String(content ?? '').trim();
		if (!nextContent) {
			return false;
		}
		target.content = nextContent;
		target.displayContent = nextContent;
		target.updatedAt = Date.now();
		const message = state.chat.messages.find(item => item?.queueId === queueId);
		if (message) {
			message.content = nextContent;
		}
		render();
		return true;
	}

	function cancelQueuedMessage(queueId) {
		const queue = Array.isArray(state.chat.ui.queuedUserMessages)
			? state.chat.ui.queuedUserMessages
			: [];
		const target = queue.find(item => item.id === queueId);
		if (!target || target.status !== 'queued') {
			return;
		}
		removeQueuedMessage(queueId);
		state.chat.messages = state.chat.messages.filter(
			item => item?.queueId !== queueId,
		);
		render();
	}

	function enqueueUserMessage(payload) {
		const nextSeq = Number(state.chat.ui.queuedMessageSeq || 0) + 1;
		state.chat.ui.queuedMessageSeq = nextSeq;
		const queueId = `q-${Date.now()}-${nextSeq}`;
		const queuedItem = {
			id: queueId,
			content: payload.content,
			displayContent: payload.displayContent,
			images: payload.images,
			targetAgentNodeId: payload.targetAgentNodeId || '',
			status: 'queued',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		if (!Array.isArray(state.chat.ui.queuedUserMessages)) {
			state.chat.ui.queuedUserMessages = [];
		}
		state.chat.ui.queuedUserMessages.push(queuedItem);
		state.chat.messages.push({
			role: 'user',
			content: payload.displayContent,
			timestamp: new Date().toISOString(),
			queueId,
			queueStatus: 'queued',
		});
		state.chat.messages = state.chat.messages.slice(-120);
		updateSessionWorkStatus();
		return queuedItem;
	}

	async function postChatToServer({
		serverId,
		baseUrl,
		content,
		images,
		targetAgentNodeId,
	}) {
		let currentSessionId = state.chat.currentSessionId || undefined;
		const pendingProfile = String(
			state.chat.quickSwitch.pendingProfileForNextMessage ?? '',
		).trim();
		const initialAgentId =
			!currentSessionId && state.chat.mainAgent.preferredAgentIdForNewSession
				? state.chat.mainAgent.preferredAgentIdForNewSession
				: undefined;
		const initialProfile =
			!currentSessionId && pendingProfile
				? pendingProfile
				: !currentSessionId &&
				  state.chat.quickSwitch.preferredProfileForNewSession
				? state.chat.quickSwitch.preferredProfileForNewSession
				: undefined;
		const postChatMessage = async (chatContent, options = {}) => {
			const body = {
				type: 'chat',
				content: chatContent,
				sessionId: currentSessionId,
				yoloMode: Boolean(state.chat.statusBar?.yoloMode ?? true),
				connectionId: state.connection.connectionId || undefined,
			};
			if (options.images?.length > 0) {
				body.images = options.images;
			}
			if (options.targetAgentNodeId) {
				body.targetAgentNodeId = options.targetAgentNodeId;
			}
			const response = await fetch(`${baseUrl}/message`, {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify(body),
			});
			if (!response.ok) {
				throw new Error(`发送失败: HTTP ${response.status}`);
			}
		};
		const applyProfileForCurrentSession = async profile => {
			if (!profile || !currentSessionId) {
				return;
			}
			const response = await fetch(`${baseUrl}/message`, {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({
					type: 'switch_profile',
					profile,
					sessionId: currentSessionId,
					connectionId: state.connection.connectionId || undefined,
				}),
			});
			if (!response.ok) {
				throw new Error(`渠道切换失败: HTTP ${response.status}`);
			}
			state.chat.quickSwitch.pendingProfileForNextMessage = '';
			state.chat.quickSwitch.preferredProfileForNewSession = profile;
			state.chat.statusBar.apiProfile = profile;
		};
		if (!currentSessionId) {
			const createBody = {
				...(initialAgentId ? {initialAgentId} : {}),
				...(initialProfile ? {initialProfile} : {}),
				...(state.connection.connectionId
					? {connectionId: state.connection.connectionId}
					: {}),
			};
			const createResponse = await fetch(`${baseUrl}/session/create`, {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify(createBody),
			});
			const createPayload = await createResponse.json();
			const createdSessionId = createPayload?.session?.id;
			if (!createResponse.ok || !createdSessionId) {
				throw new Error(
					createPayload?.message ??
						`创建会话失败: HTTP ${createResponse.status}`,
				);
			}
			currentSessionId = createdSessionId;
			state.chat.currentSessionId = createdSessionId;
			state.chat.mainAgent.preferredAgentIdForNewSession = '';
			if (initialProfile) {
				state.chat.quickSwitch.pendingProfileForNextMessage = '';
				state.chat.quickSwitch.preferredProfileForNewSession = initialProfile;
				state.chat.statusBar.apiProfile = initialProfile;
			}
			void refreshSessionList(serverId);
		} else if (pendingProfile) {
			await applyProfileForCurrentSession(pendingProfile);
		}

		setAssistantWorking(true);
		await postChatMessage(content || '', {
			images: Array.isArray(images) ? images : [],
			targetAgentNodeId: targetAgentNodeId || undefined,
		});
	}

	async function flushQueuedMessagesIfNeeded(serverId, baseUrl) {
		if (!canFlushQueuedMessage()) {
			return;
		}
		const queue = Array.isArray(state.chat.ui.queuedUserMessages)
			? state.chat.ui.queuedUserMessages
			: [];
		const next = queue.find(item => item.status === 'queued');
		if (!next) {
			return;
		}
		let sent = false;
		state.chat.ui.flushingQueuedMessage = true;
		next.status = 'sending';
		setQueueMessageStatus(next.id, 'sending');
		render();
		try {
			await postChatToServer({
				serverId,
				baseUrl,
				content: next.content || '',
				images: next.images,
				targetAgentNodeId: next.targetAgentNodeId || undefined,
			});
			removeQueuedMessage(next.id);
			applyQueueMessageSent(next.id);
			sent = true;
			render();
		} catch {
			next.status = 'queued';
			setQueueMessageStatus(next.id, 'queued');
			render();
		} finally {
			state.chat.ui.flushingQueuedMessage = false;
		}
		if (sent) {
			void flushQueuedMessagesIfNeeded(serverId, baseUrl);
		}
	}

	/**
	 * 更新当前 Tab 的渠道快捷切换值.
	 * @param {'profile'} field 字段.
	 * @param {string} value 值.
	 */
	function updateQuickSwitchField(field, value) {
		if (field !== 'profile') {
			return;
		}
		state.chat.quickSwitch.profile = String(value ?? '').trim();
	}

	/**
	 * 切换子代理节点展开状态.
	 * @param {string} nodeId 节点ID.
	 */
	function toggleSubAgentNode(nodeId) {
		if (!nodeId) {
			return;
		}
		const current = Boolean(state.chat.ui.subAgentExpandedById?.[nodeId]);
		state.chat.ui.subAgentExpandedById[nodeId] = !current;
		render();
	}

	/**
	 * 切换子代理并行弹窗卡片索引.
	 * @param {number} offset 偏移量,可为正负.
	 */
	function shiftSubAgentPopup(offset) {
		const subAgentMap = new Map(
			(state.chat.subAgents ?? []).map(item => [
				String(item?.nodeId ?? ''),
				item,
			]),
		);
		const rootRunningNodeIds = [];
		const seenNodeIds = new Set();
		for (const item of state.chat.subAgents ?? []) {
			const nodeId = String(item?.nodeId ?? '');
			if (!nodeId || seenNodeIds.has(nodeId)) {
				continue;
			}
			const parentNodeId = String(item?.parentNodeId ?? '');
			const nodeStatus = String(item?.status ?? 'running');
			const isRootNode = !parentNodeId || !subAgentMap.has(parentNodeId);
			if (!isRootNode || nodeStatus === 'done') {
				continue;
			}
			seenNodeIds.add(nodeId);
			rootRunningNodeIds.push(nodeId);
		}
		const total = rootRunningNodeIds.length;
		if (total <= 1) {
			state.chat.ui.subAgentPopupIndex = 0;
			render();
			return;
		}
		const current = Number(state.chat.ui.subAgentPopupIndex ?? 0);
		const normalizedCurrent = Number.isFinite(current) ? current : 0;
		state.chat.ui.subAgentPopupIndex =
			(normalizedCurrent + Number(offset || 0) + total) % total;
		render();
	}

	/**
	 * 关闭指定子代理卡片.
	 * @param {string} nodeId 子代理节点ID.
	 */
	function closeSubAgent(nodeId) {
		const targetNodeId = String(nodeId ?? '');
		if (!targetNodeId) {
			return;
		}
		const nodeMap = new Map(
			(state.chat.subAgents ?? []).map(item => [
				String(item?.nodeId ?? ''),
				item,
			]),
		);
		if (!nodeMap.has(targetNodeId)) {
			return;
		}
		const removingIds = new Set();
		const stack = [targetNodeId];
		while (stack.length > 0) {
			const currentId = String(stack.pop() ?? '');
			if (!currentId || removingIds.has(currentId)) {
				continue;
			}
			removingIds.add(currentId);
			const currentNode = nodeMap.get(currentId);
			const children = Array.isArray(currentNode?.children)
				? currentNode.children.map(childId => String(childId ?? ''))
				: [];
			for (const childId of children) {
				if (childId && !removingIds.has(childId)) {
					stack.push(childId);
				}
			}
		}
		state.chat.subAgents = (state.chat.subAgents ?? []).filter(
			item => !removingIds.has(String(item?.nodeId ?? '')),
		);
		for (const removingId of removingIds) {
			delete state.chat.ui.subAgentExpandedById[removingId];
		}
		const rootRunningCount = (state.chat.subAgents ?? []).filter(item => {
			const parentNodeId = String(item?.parentNodeId ?? '');
			const nodeStatus = String(item?.status ?? 'running');
			return !parentNodeId && nodeStatus !== 'done';
		}).length;
		if (rootRunningCount <= 1) {
			state.chat.ui.subAgentPopupIndex = 0;
		} else {
			const current = Number(state.chat.ui.subAgentPopupIndex ?? 0);
			const normalizedCurrent = Number.isFinite(current) ? current : 0;
			state.chat.ui.subAgentPopupIndex =
				((normalizedCurrent % rootRunningCount) + rootRunningCount) %
				rootRunningCount;
		}
		render();
	}

	/**
	 * 切换渠道配置(纯本地, 不发消息给 AI).
	 * 空闲时仅标记下一条消息发送前生效,工作中禁止切换.
	 * @param {'profile'} field 字段.
	 */
	function applyQuickSwitch(field) {
		if (field !== 'profile') {
			return;
		}
		if (
			state.chat.ui.assistantWorking ||
			state.chat.ui.flushingQueuedMessage ||
			String(state.chat.statusBar.sessionWorkStatus ?? '') === '工作中'
		) {
			pushMessage('error', '当前会话工作中,暂不允许切换渠道');
			render();
			return;
		}
		const value = String(state.chat.quickSwitch.profile ?? '').trim();
		if (!value) {
			pushMessage('error', '请选择渠道');
			render();
			return;
		}
		state.chat.quickSwitch.pendingProfileForNextMessage = value;
		state.chat.quickSwitch.preferredProfileForNewSession = value;
		state.chat.statusBar.apiProfile = value;
		pushMessage('system', `渠道已切换为 ${value}, 将在下一条消息发送前生效`);
		render();
	}

	/**
	 * 新建会话: 清空当前聊天状态,下次发送消息时自动创建服务端会话.
	 */
	function newSession() {
		const serverId = state.control.selectedServerId;
		if (!serverId) {
			return;
		}
		withServerTabContext(serverId, () => {
			state.chat.currentSessionId = '';
			state.chat.messages = [];
			state.chat.events = [];
			state.chat.currentSessionEvents = [];
			state.chat.todos = [];
			state.chat.subAgents = [];
			state.chat.error = '';
			state.chat.ui.pendingDraftText = '';
			state.chat.ui.pendingImages = [];
			state.chat.ui.subAgentExpandedById = {};
			state.chat.ui.assistantWorking = false;
			state.chat.ui.flushingQueuedMessage = false;
			state.chat.ui.queuedUserMessages = [];
			state.chat.ui.queuedMessageSeq = 0;
			state.chat.statusBar.sessionWorkStatus = '已停止';
			pushMessage('system', '已创建新会话');
			void refreshSessionList(serverId);
			render();
		});
	}

	/**
	 * 中断当前会话任务, 发送 abort 消息到 POST /message.
	 */
	async function abortSession() {
		const serverId = state.control.selectedServerId;
		return withServerTabContext(serverId, async () => {
			const baseUrl = state.connection.baseUrl;
			const sessionId = state.chat.currentSessionId;
			if (!baseUrl || state.connection.status !== 'connected' || !sessionId) {
				pushMessage('error', '没有活动的会话, 无法中断');
				render();
				return;
			}
			pushMessage('system', '正在中断当前任务...');
			render();
			try {
				const response = await fetch(`${baseUrl}/message`, {
					method: 'POST',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify({
						type: 'abort',
						sessionId,
						connectionId: state.connection.connectionId || undefined,
					}),
				});
				const payload = await response.json();
				if (!response.ok || payload?.success === false) {
					const msg =
						payload?.error ??
						payload?.message ??
						`中断请求失败: HTTP ${response.status}`;
					pushMessage('error', msg);
					render();
					return;
				}
				pushMessage('system', '已发送中断请求');
				render();
			} catch (error) {
				pushMessage(
					'error',
					error instanceof Error ? error.message : '中断请求失败',
				);
				render();
			}
		});
	}

	/**
	 * 获取当前会话的可用回滚点列表.
	 * @returns {Promise<Array<object>>} 回滚点数组, 每项含 messageIndex/summary/hasSnapshot/filesToRollbackCount 等.
	 */
	async function fetchRollbackPoints() {
		const serverId = state.control.selectedServerId;
		return withServerTabContext(serverId, async () => {
			const baseUrl = state.connection.baseUrl;
			const sessionId = state.chat.currentSessionId;
			if (!baseUrl || state.connection.status !== 'connected' || !sessionId) {
				return [];
			}
			try {
				const params = new URLSearchParams({sessionId});
				const response = await fetch(
					`${baseUrl}/session/rollback-points?${params.toString()}`,
				);
				const data = await response.json();
				if (!response.ok || data?.success === false) {
					pushMessage(
						'error',
						data?.error ?? `获取回滚点失败: HTTP ${response.status}`,
					);
					render();
					return [];
				}
				return Array.isArray(data.points) ? data.points : [];
			} catch (error) {
				pushMessage(
					'error',
					error instanceof Error ? error.message : '获取回滚点失败',
				);
				render();
				return [];
			}
		});
	}

	/**
	 * 回退当前会话到指定记录点.
	 * @param {number} messageIndex 目标原始消息索引(0-based, 用于截断 session.messages).
	 * @param {boolean} rollbackFiles 是否同时回滚文件快照.
	 * @param {number} [snapshotIndex] 快照系统使用的 UI 消息索引(用于快照回滚/删除).
	 */
	async function rollbackSession(messageIndex, rollbackFiles, snapshotIndex) {
		const serverId = state.control.selectedServerId;
		return withServerTabContext(serverId, async () => {
			const baseUrl = state.connection.baseUrl;
			const sessionId = state.chat.currentSessionId;
			if (!baseUrl || state.connection.status !== 'connected' || !sessionId) {
				pushMessage('error', '没有活动的会话, 无法回退');
				render();
				return;
			}
			const modeLabel = rollbackFiles ? '对话+文件' : '仅对话';
			pushMessage(
				'system',
				`正在回退到记录点 #${messageIndex} (${modeLabel})...`,
			);
			render();
			try {
				const rollbackPayload = {messageIndex, rollbackFiles};
				if (snapshotIndex !== undefined) {
					rollbackPayload.snapshotIndex = snapshotIndex;
				}
				const response = await fetch(`${baseUrl}/message`, {
					method: 'POST',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify({
						type: 'rollback',
						sessionId,
						rollback: rollbackPayload,
						connectionId: state.connection.connectionId || undefined,
					}),
				});
				const payload = await response.json();
				if (!response.ok || payload?.success === false) {
					const msg =
						payload?.error ??
						payload?.message ??
						`回退请求失败: HTTP ${response.status}`;
					pushMessage('error', msg);
					render();
					return;
				}
				pushMessage('system', '已发送回退请求, 等待服务端完成...');
				render();
			} catch (error) {
				pushMessage(
					'error',
					error instanceof Error ? error.message : '回退请求失败',
				);
				render();
			}
		});
	}

	/**
	 * 压缩当前会话上下文, 调用服务端 POST /context/compress.
	 */
	async function compressSession() {
		const serverId = state.control.selectedServerId;
		return withServerTabContext(serverId, async () => {
			const baseUrl = state.connection.baseUrl;
			const sessionId = state.chat.currentSessionId;
			if (!baseUrl || state.connection.status !== 'connected' || !sessionId) {
				pushMessage('error', '请先建立会话后再压缩');
				render();
				return;
			}
			const compressFlowState = getCompressFlowState();
			compressFlowState.active = true;
			compressFlowState.sourceSessionId = sessionId;
			compressFlowState.startedAt = Date.now();
			compressFlowState.waitHintShown = false;
			pushMessage('system', '⏳ 压缩中...');
			render();
			try {
				const response = await fetch(`${baseUrl}/context/compress`, {
					method: 'POST',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify({sessionId}),
				});
				const payload = await response.json();
				if (!response.ok || payload?.success === false) {
					const msg =
						payload?.error ??
						payload?.message ??
						`压缩失败: HTTP ${response.status}`;
					pushMessage('error', msg);
					resetCompressFlowState();
					render();
					return;
				}
				if (!getCompressFlowState().active) {
					render();
					return;
				}
				await refreshSessionList(serverId);
				const sessions = Array.isArray(state.chat.sessions)
					? state.chat.sessions
					: [];
				const compressedSession = sessions
					.filter(item => String(item?.compressedFrom ?? '') === sessionId)
					.sort(
						(left, right) =>
							Number(right?.updatedAt ?? 0) - Number(left?.updatedAt ?? 0),
					)[0];
				const compressedSessionId = String(compressedSession?.id ?? '').trim();
				if (compressedSessionId) {
					resetCompressFlowState();
					markSessionAttention(compressedSessionId);
					pushInfoMessage('压缩完成,点击查看压缩后会话', {
						tipType: 'complete',
						serverId,
						sessionId: compressedSessionId,
						allowCurrentSession: true,
					});
					pushMessage('system', '✅ 压缩完成,已生成压缩后会话,点击提示可查看');
					render();
					return;
				}
				pushMessage('system', '✅ 压缩请求完成,等待压缩后新会话生成...');
				render();
			} catch (error) {
				pushMessage(
					'error',
					error instanceof Error ? error.message : '压缩请求失败',
				);
				resetCompressFlowState();
				render();
			}
		});
	}

	async function cancelCompressFlow() {
		const serverId = state.control.selectedServerId;
		return withServerTabContext(serverId, async () => {
			const compressFlowState = getCompressFlowState();
			if (!compressFlowState.active) {
				return;
			}
			resetCompressFlowState();
			pushMessage('system', '已取消压缩等待');
			render();
			await abortSession();
		});
	}

	const knownEventTypes = new Set([
		'connected',
		'message',
		'thinking',
		'error',
		'complete',
		'tool_call',
		'tool_result',
		'tool_confirmation_request',
		'user_question_request',
		'todo_update',
		'todos',
		'agent_list',
		'agent_switched',
		'usage',
		'sub_agent_message',
		'rollback_result',
	]);
	const sessionScopedEventTypes = new Set([
		'message',
		'thinking',
		'error',
		'complete',
		'tool_call',
		'tool_result',
		'tool_confirmation_request',
		'user_question_request',
		'todo_update',
		'todos',
	]);
	const chatOnlyRenderEventTypes = new Set([
		'message',
		'thinking',
		'tool_call',
		'tool_result',
		'sub_agent_message',
	]);

	/**
	 * 判断事件是否表示会话运行中.
	 * @param {{type?:string,data?:any}} event SSE事件.
	 * @returns {boolean}
	 */
	function isRunningEvent(event) {
		const eventType = String(event?.type ?? '');
		if (
			new Set(['message', 'thinking', 'tool_call', 'tool_result']).has(
				eventType,
			)
		) {
			return true;
		}
		const role = String(event?.data?.role ?? '').toLowerCase();
		return eventType === 'message' && role === 'assistant';
	}

	/**
	 * 判断事件是否表示会话终态.
	 * @param {{type?:string,data?:any}} event SSE事件.
	 * @returns {boolean}
	 */
	function isTerminalEvent(event) {
		const eventType = String(event?.type ?? '').toLowerCase();
		if (eventType !== 'complete' && eventType !== 'error') {
			return false;
		}
		const terminal = String(
			event?.data?.terminalState ??
				event?.data?.status ??
				event?.data?.state ??
				event?.data?.result ??
				eventType,
		).toLowerCase();
		if (!terminal) {
			return eventType === 'complete';
		}
		return (
			terminal.includes('complete') ||
			terminal.includes('success') ||
			terminal.includes('finish') ||
			terminal.includes('abort') ||
			terminal.includes('interrupt') ||
			terminal.includes('fail') ||
			terminal.includes('error') ||
			terminal.includes('完成') ||
			terminal.includes('中断') ||
			terminal.includes('失败')
		);
	}

	/**
	 * 统一提取并归一化思考内容,兼容字符串与对象两种形态.
	 * @param {any} data SSE事件数据.
	 * @returns {string}
	 */
	function normalizeThinkingText(data) {
		const reasoningSummary = Array.isArray(data?.reasoning?.summary)
			? data.reasoning.summary
					.map(item => String(item?.text ?? '').trim())
					.filter(Boolean)
					.join('\n')
			: '';
		const rawThinking =
			typeof data?.thinking === 'string'
				? data.thinking
				: data?.thinking?.thinking;
		const raw =
			rawThinking ||
			reasoningSummary ||
			data?.reasoning_content ||
			data?.reasoningContent ||
			'';
		return String(raw ?? '').trim();
	}

	/**
	 * 把实时思考增量并入最后一条 assistant 消息.
	 * @param {string} incomingThinking 新到达的思考文本.
	 */
	function mergeThinkingIntoLastAssistant(incomingThinking) {
		if (!incomingThinking) {
			return;
		}
		let targetIndex = -1;
		for (let index = state.chat.messages.length - 1; index >= 0; index -= 1) {
			const item = state.chat.messages[index];
			if (item?.role === 'assistant' && !item?.toolMeta) {
				targetIndex = index;
				break;
			}
		}
		if (targetIndex < 0) {
			pushMessage('assistant', '', {thinking: incomingThinking});
			return;
		}
		const target = state.chat.messages[targetIndex];
		const existingThinking = String(target?.thinking ?? '').trim();
		let mergedThinking = incomingThinking;
		if (!existingThinking) {
			mergedThinking = incomingThinking;
		} else if (incomingThinking === existingThinking) {
			mergedThinking = existingThinking;
		} else if (incomingThinking.startsWith(existingThinking)) {
			mergedThinking = incomingThinking;
		} else if (existingThinking.startsWith(incomingThinking)) {
			mergedThinking = existingThinking;
		} else if (existingThinking.endsWith(incomingThinking)) {
			mergedThinking = existingThinking;
		} else {
			mergedThinking = `${existingThinking}${incomingThinking}`;
		}
		state.chat.messages[targetIndex] = {
			...target,
			thinking: mergedThinking,
		};
	}

	/**
	 * 处理SSE事件,未知事件静默忽略.
	 * @param {{type:string,data:any,timestamp?:string,requestId?:string}} event 事件.
	 * @param {string} [serverId] 事件所属服务端ID.
	 */
	function handleSseEvent(event, serverId = state.control.selectedServerId) {
		if (!knownEventTypes.has(event.type)) {
			return false;
		}
		const sessionIdFromEvent =
			typeof event.data?.sessionId === 'string'
				? event.data.sessionId
				: sessionScopedEventTypes.has(event.type)
				? state.chat.currentSessionId || undefined
				: undefined;
		const eventWithSession = {
			...event,
			data:
				sessionIdFromEvent && !event.data?.sessionId
					? {...(event.data ?? {}), sessionId: sessionIdFromEvent}
					: event.data,
		};
		pushEvent(eventWithSession);
		const eventSessionId =
			typeof eventWithSession.data?.sessionId === 'string'
				? eventWithSession.data.sessionId
				: '';
		const shouldIncrementLogUnread =
			!state.chat.dialogs.logModalOpen &&
			Boolean(eventSessionId) &&
			eventSessionId === state.chat.currentSessionId;
		if (shouldIncrementLogUnread) {
			incrementLogUnread();
		}
		if (eventSessionId && isRunningEvent(eventWithSession)) {
			markRunningSession(eventSessionId, {
				serverId,
				title: String(eventWithSession.data?.sessionTitle ?? ''),
			});
		}
		if (eventSessionId && isTerminalEvent(eventWithSession)) {
			const shouldMarkUnreadTerminal =
				state.chat.ui.terminalReminderWindowActive &&
				eventSessionId !== state.chat.currentSessionId;
			clearRunningSession(eventSessionId);
			if (shouldMarkUnreadTerminal) {
				markSessionTerminalUnread(eventSessionId, {
					serverId,
					title: String(eventWithSession.data?.sessionTitle ?? ''),
					terminalState: String(
						eventWithSession.data?.terminalState ??
							eventWithSession.data?.status ??
							eventWithSession.data?.state ??
							eventWithSession.type,
					),
				});
				if (
					!state.chat.ui.terminalReminderPopupShown &&
					getUnreadTerminalCount() > 0
				) {
					state.chat.dialogs.unreadTerminalModalOpen = true;
					markTerminalReminderPopupShown();
				}
			}
		}
		switch (event.type) {
			case 'connected': {
				state.connection.status = 'connected';
				state.connection.retryCount = 0;
				state.connection.connectionId = event.data?.connectionId ?? '';
				pushMessage(
					'system',
					`SSE连接已建立: ${event.data?.connectionId ?? '-'}`,
				);
				void Promise.resolve(refreshSessionList(serverId)).then(() => {
					withServerTabContext(serverId, () => {
						setTerminalReminderWindowActive(false);
						if (
							getUnreadTerminalCount() > 0 &&
							!state.chat.ui.terminalReminderPopupShown
						) {
							state.chat.dialogs.unreadTerminalModalOpen = true;
							markTerminalReminderPopupShown();
						}
					});
				});
				break;
			}
			case 'agent_list': {
				state.chat.mainAgent.agents = Array.isArray(event.data?.agents)
					? event.data.agents
					: [];
				const currentAgentId =
					typeof event.data?.currentAgentId === 'string'
						? event.data.currentAgentId
						: '';
				if (currentAgentId) {
					state.chat.mainAgent.currentAgentId = currentAgentId;
					state.chat.mainAgent.lastConfirmedAgentId = currentAgentId;
				}
				state.chat.mainAgent.isSwitchingAgent = false;
				state.chat.mainAgent.requestedAgentId = '';
				if (
					!currentAgentId &&
					!state.chat.mainAgent.preferredAgentIdForNewSession &&
					state.chat.mainAgent.agents[0]?.id
				) {
					state.chat.mainAgent.preferredAgentIdForNewSession =
						state.chat.mainAgent.agents[0].id;
				}
				break;
			}
			case 'agent_switched': {
				const currentAgentId = event.data?.currentAgentId ?? '';
				state.chat.mainAgent.currentAgentId = currentAgentId;
				state.chat.mainAgent.lastConfirmedAgentId = currentAgentId;
				state.chat.mainAgent.isSwitchingAgent = false;
				state.chat.mainAgent.requestedAgentId = '';
				break;
			}
			case 'message': {
				const role = event.data?.role;
				const content = String(
					event.data?.content ?? event.data?.text ?? event.data?.message ?? '',
				);
				const thinking = normalizeThinkingText(event.data);
				if (typeof event.data?.sessionId === 'string') {
					touchSession(event.data.sessionId);
				}
				// 服务端会回放 system/user 等角色, 仅允许 assistant 进入聊天区
				if (role !== 'assistant') {
					break;
				}
				if (!content.trim() && !thinking) {
					break;
				}
				if (content.includes('Auto-compressing context')) {
					pushMessage('system', '⏳ 自动压缩已触发,正在整理会话上下文');
				}
				pushMessage('assistant', content, {
					thinking,
				});
				break;
			}
			case 'thinking': {
				if (typeof event.data?.sessionId === 'string') {
					touchSession(event.data.sessionId);
				}
				const thinking = normalizeThinkingText(event.data);
				if (thinking) {
					mergeThinkingIntoLastAssistant(thinking);
				}
				break;
			}
			case 'error': {
				const message = event.data?.message ?? '未知错误';
				pushMessage('error', String(message));
				if (state.chat.mainAgent.isSwitchingAgent) {
					state.chat.mainAgent.currentAgentId =
						state.chat.mainAgent.lastConfirmedAgentId;
					state.chat.mainAgent.isSwitchingAgent = false;
					state.chat.mainAgent.requestedAgentId = '';
				}
				if (typeof event.data?.sessionId === 'string') {
					touchSession(event.data.sessionId);
				}
				break;
			}
			case 'tool_call': {
				setAssistantWorking(true);
				const fn = event.data?.function;
				const toolName = fn?.name ?? 'unknown_tool';
				state.chat.lastToolName = toolName;
				if (toolName.startsWith('subagent-')) {
					// 子代理卡片只基于 sub_agent_message 构建,避免重复卡片.
				}

				let argsSummary = '';
				try {
					const rawArgs = fn?.arguments;
					const args =
						typeof rawArgs === 'string'
							? rawArgs.length > 10000
								? null
								: JSON.parse(rawArgs)
							: rawArgs;
					if (args && typeof args === 'object') {
						const entries = Object.entries(args);
						argsSummary = entries
							.slice(0, 3)
							.map(([k, v]) => {
								let val;
								if (typeof v === 'string') {
									val = v.length > 60 ? v.slice(0, 60) + '...' : v;
								} else {
									try {
										const s = JSON.stringify(v);
										val = s.length > 60 ? s.slice(0, 60) + '...' : s;
									} catch {
										val = String(v).slice(0, 60);
									}
								}
								return `${k}: ${val}`;
							})
							.join(', ');
						if (entries.length > 3) {
							argsSummary += `, ... (+${entries.length - 3})`;
						}
					}
				} catch {
					argsSummary = String(fn?.arguments ?? '').slice(0, 80);
				}
				pushMessage(
					'assistant',
					argsSummary ? `🔧 ${toolName}(${argsSummary})` : `🔧 ${toolName}`,
					{
						toolMeta: {
							kind: 'call',
							title: toolName,
							summary: argsSummary ? `参数: ${argsSummary}` : '等待执行结果',
							detail: fn?.arguments ?? '',
							status: 'running',
						},
					},
				);
				break;
			}
			case 'tool_result': {
				const status = event.data?.status ?? '';
				const resultContent = String(event.data?.content ?? '');
				const toolName = event.data?.toolName || state.chat.lastToolName || '';
				if (toolName.startsWith('subagent-')) {
					const subAgentQueue = Array.isArray(
						state.chat.ui.subAgentToolCallNodeIds,
					)
						? state.chat.ui.subAgentToolCallNodeIds
						: [];
					const targetNodeId = String(subAgentQueue.shift() ?? '');
					state.chat.ui.subAgentToolCallNodeIds = subAgentQueue;
					if (targetNodeId) {
						const targetNode = (state.chat.subAgents ?? []).find(
							item => String(item?.nodeId ?? '') === targetNodeId,
						);
						if (targetNode) {
							targetNode.completedByHook = true;
							targetNode.status = 'running';
							targetNode.result = '工作中';
							if (resultContent) {
								targetNode.lines.push(resultContent);
								targetNode.lines = targetNode.lines.slice(-60);
							}
						}
					}
				}

				if (status === 'error' && resultContent) {
					pushMessage(
						'assistant',
						`✗ 工具错误: ${resultContent.slice(0, 200)}`,
						{
							toolMeta: {
								kind: 'result',
								title: toolName || 'tool_call',
								summary: `工具错误: ${resultContent.slice(0, 200)}`,
								detail: resultContent,
								status: 'error',
							},
						},
					);
				} else if (status === 'success' && resultContent) {
					let summary = '';
					try {
						const data = JSON.parse(resultContent);
						if (toolName.startsWith('subagent-') && data.result) {
							const resultText = String(data.result);
							const icon = data.success === false ? '✗' : '•';
							summary =
								resultText.length > 120
									? `${icon} ${resultText.slice(0, 120)}...`
									: `${icon} ${resultText}`;
						} else if (
							toolName === 'filesystem-read' &&
							data.totalLines !== undefined
						) {
							const readLines = data.endLine
								? data.endLine - (data.startLine || 1) + 1
								: data.totalLines;
							summary = `✓ Read ${readLines} lines${
								data.totalLines > readLines
									? ` of ${data.totalLines} total`
									: ''
							}`;
						} else if (
							(toolName === 'ace-text-search' ||
								toolName === 'ace-text_search') &&
							Array.isArray(data)
						) {
							summary = `✓ Found ${data.length} ${
								data.length === 1 ? 'match' : 'matches'
							}`;
						} else if (toolName === 'ace-file_outline' && data.symbols) {
							summary = `✓ ${data.symbols.length} symbols`;
						} else if (
							toolName === 'ace-semantic-search' ||
							toolName === 'ace-semantic_search'
						) {
							const total =
								(data.symbols?.length || 0) + (data.references?.length || 0);
							summary = `✓ ${total} results`;
						} else if (
							toolName === 'terminal-execute' &&
							data.exitCode !== undefined
						) {
							summary =
								data.exitCode === 0
									? '✓ Command succeeded'
									: `✗ Exit code: ${data.exitCode}`;
						} else if (
							toolName === 'filesystem-edit' ||
							toolName === 'filesystem-edit_search' ||
							toolName === 'filesystem-create'
						) {
							summary = data.message ? `✓ ${data.message}` : '✓ File updated';
						} else if (
							toolName === 'codebase-retrieval' ||
							toolName === 'context_engine-codebase-retrieval'
						) {
							summary = '✓ Codebase context retrieved';
						} else if (typeof data === 'object') {
							const keys = Object.keys(data).slice(0, 3);
							if (keys.length > 0) {
								summary = `✓ ${keys.join(', ')}`;
							}
						}
					} catch {
						summary =
							resultContent.length > 50
								? `✓ ${resultContent.slice(0, 50)}...`
								: `✓ ${resultContent}`;
					}

					if (summary) {
						pushMessage('assistant', `└─ ${summary}`, {
							toolMeta: {
								kind: 'result',
								title: toolName || 'tool_call',
								summary,
								detail: resultContent,
								status: 'success',
							},
						});
					}
				}
				setAssistantWorking(false);
				void flushQueuedMessagesIfNeeded(serverId, state.connection.baseUrl);
				break;
			}

			case 'complete': {
				setAssistantWorking(false);
				void flushQueuedMessagesIfNeeded(serverId, state.connection.baseUrl);
				if (typeof event.data?.sessionId === 'string') {
					const completedSessionId = event.data.sessionId;
					touchSession(completedSessionId);
					const compressFlowState = getCompressFlowState();
					const wasCompressFlowActive = Boolean(compressFlowState.active);
					const compressFlowAge =
						Date.now() - Number(compressFlowState.startedAt || 0);
					const isCompressFlowFresh =
						compressFlowAge >= 0 && compressFlowAge <= 120000;
					const isCompressFlowSameSession =
						compressFlowState.active &&
						completedSessionId === compressFlowState.sourceSessionId &&
						isCompressFlowFresh;
					const isCompressedSessionOfSource = sourceSessionId =>
						Array.isArray(state.chat.sessions) &&
						state.chat.sessions.some(
							item =>
								String(item?.id ?? '') === completedSessionId &&
								String(item?.compressedFrom ?? '') ===
									String(sourceSessionId ?? ''),
						);
					const switchToCompressedSession = () => {
						markSessionAttention(completedSessionId);
						pushInfoMessage('压缩完成,点击查看压缩后会话', {
							tipType: 'complete',
							serverId,
							sessionId: completedSessionId,
							allowCurrentSession: true,
						});
						pushMessage(
							'system',
							'✅ 压缩完成,已生成压缩后会话,点击提示可查看',
						);
						resetCompressFlowState();
					};
					const shouldSwitchToCompressedSession =
						compressFlowState.active &&
						compressFlowState.sourceSessionId &&
						completedSessionId !== compressFlowState.sourceSessionId &&
						isCompressFlowFresh &&
						isCompressedSessionOfSource(compressFlowState.sourceSessionId);
					if (shouldSwitchToCompressedSession) {
						switchToCompressedSession();
					} else {
						const shouldRetrySwitchAfterRefresh =
							compressFlowState.active &&
							compressFlowState.sourceSessionId &&
							completedSessionId !== compressFlowState.sourceSessionId &&
							isCompressFlowFresh;
						if (shouldRetrySwitchAfterRefresh) {
							void Promise.resolve(refreshSessionList(serverId)).then(() => {
								withServerTabContext(serverId, () => {
									const latestFlowState = getCompressFlowState();
									if (
										latestFlowState.active &&
										latestFlowState.sourceSessionId &&
										completedSessionId !== latestFlowState.sourceSessionId &&
										isCompressedSessionOfSource(latestFlowState.sourceSessionId)
									) {
										switchToCompressedSession();
										render();
									}
								});
							});
						}
						if (compressFlowState.active && !isCompressFlowFresh) {
							resetCompressFlowState();
						}
						if (isCompressFlowSameSession && !compressFlowState.waitHintShown) {
							pushMessage('system', '⏳ 压缩进行中,等待压缩后新会话完成...');
							compressFlowState.waitHintShown = true;
						}
						if (!wasCompressFlowActive && !compressFlowState.active) {
							pushInfoMessage('任务已完成,点击查看会话', {
								tipType: 'complete',
								serverId,
								sessionId: completedSessionId,
								allowCurrentSession: true,
							});
						}
					}
				}

				state.chat.statusBar.tokenUsed =
					Number(event.data?.usage?.input_tokens ?? 0) +
					Number(event.data?.usage?.output_tokens ?? 0);
				state.chat.statusBar.yoloMode = Boolean(event.data?.yoloMode ?? true);
				void refreshSessionList(serverId);
				break;
			}

			case 'tool_confirmation_request': {
				if (eventSessionId) {
					markSessionAttention(eventSessionId);
					const isSensitive = Boolean(event.data?.isSensitive);
					pushInfoMessage(
						isSensitive ? '收到敏感命令审批,点击处理' : '收到工具审批,点击处理',
						{
							tipType: isSensitive
								? 'tool_confirmation_request_sensitive'
								: 'tool_confirmation_request',
							serverId,
							sessionId: eventSessionId,
						},
					);
				}
				showToolConfirmationDialog(event, (type, requestId, response) =>
					withServerTabContext(serverId, () =>
						sendInteractiveResponse(type, requestId, response, eventSessionId),
					),
				);
				break;
			}
			case 'user_question_request': {
				if (eventSessionId) {
					markSessionAttention(eventSessionId);
					pushInfoMessage('收到用户提问,点击回复', {
						tipType: 'user_question_request',
						serverId,
						sessionId: eventSessionId,
					});
				}
				showUserQuestionDialog(event, (type, requestId, response) =>
					withServerTabContext(serverId, () =>
						sendInteractiveResponse(type, requestId, response, eventSessionId),
					),
				);
				break;
			}
			case 'todo_update':
			case 'todos': {
				state.chat.todos = Array.isArray(event.data?.todos)
					? event.data.todos
					: Array.isArray(event.data)
					? event.data
					: [];
				incrementTodoUnread();
				break;
			}
			case 'usage': {
				state.chat.statusBar.contextPercent = Number(
					event.data?.percentage ?? 0,
				);
				state.chat.statusBar.tokenTotal = Number(event.data?.maxTokens ?? 0);
				state.chat.statusBar.tokenUsed = Number(event.data?.inputTokens ?? 0);
				state.chat.statusBar.kvCacheRead = Number(
					event.data?.cacheReadInputTokens ?? 0,
				);
				break;
			}
			case 'sub_agent_message': {
				const agentId = String(event.data?.agentId ?? '');
				const agentName = String(
					event.data?.agentName ?? agentId ?? 'sub-agent',
				);
				const payload = event.data?.message ?? {};
				const level = Number(payload?.spawnDepth ?? 0);
				const fallbackNodeId = `${agentId}:${String(level)}`;
				const instanceId = String(payload?.instanceId ?? '');
				const nodeId = instanceId || fallbackNodeId;
				const ensureNode = id => {
					let currentNode = state.chat.subAgents.find(
						item => item.nodeId === id,
					);
					const migrateFallbackNodeToInstance = fallbackNode => {
						for (const item of state.chat.subAgents) {
							if (String(item?.parentNodeId ?? '') === fallbackNodeId) {
								item.parentNodeId = instanceId;
							}
							if (Array.isArray(item?.children)) {
								item.children = item.children.map(childId =>
									String(childId ?? '') === fallbackNodeId
										? instanceId
										: childId,
								);
							}
						}
						fallbackNode.nodeId = instanceId;
						state.chat.ui.subAgentExpandedById[instanceId] = Boolean(
							state.chat.ui.subAgentExpandedById[fallbackNodeId],
						);
						delete state.chat.ui.subAgentExpandedById[fallbackNodeId];
						return fallbackNode;
					};
					if (instanceId && id === fallbackNodeId) {
						const instanceNode = state.chat.subAgents.find(
							item => item.nodeId === instanceId,
						);
						if (instanceNode) {
							return instanceNode;
						}
					}
					if (instanceId && id === instanceId) {
						const fallbackNode = state.chat.subAgents.find(
							item =>
								item.nodeId === fallbackNodeId &&
								String(item?.agentId ?? '') === agentId &&
								Number(item?.level ?? 0) === level,
						);
						if (fallbackNode && fallbackNode !== currentNode) {
							if (currentNode) {
								for (const item of state.chat.subAgents) {
									if (item === fallbackNode) {
										continue;
									}
									if (String(item?.parentNodeId ?? '') === fallbackNodeId) {
										item.parentNodeId = instanceId;
									}
									if (Array.isArray(item?.children)) {
										item.children = item.children.map(childId =>
											String(childId ?? '') === fallbackNodeId
												? instanceId
												: childId,
										);
									}
								}
								const mergedChildren = [
									...(Array.isArray(currentNode.children)
										? currentNode.children
										: []),
									...(Array.isArray(fallbackNode.children)
										? fallbackNode.children
										: []),
								].map(child => String(child ?? ''));
								currentNode.children = [...new Set(mergedChildren)].filter(
									Boolean,
								);
								currentNode.lines = [
									...(Array.isArray(fallbackNode.lines)
										? fallbackNode.lines
										: []),
									...(Array.isArray(currentNode.lines)
										? currentNode.lines
										: []),
								].slice(-60);
								currentNode.hasNormalReply = Boolean(
									currentNode.hasNormalReply || fallbackNode.hasNormalReply,
								);
								currentNode.completedByHook = Boolean(
									currentNode.completedByHook || fallbackNode.completedByHook,
								);
								if (!currentNode.parentNodeId) {
									currentNode.parentNodeId = String(
										fallbackNode.parentNodeId ?? '',
									);
								}
								state.chat.subAgents = state.chat.subAgents.filter(
									item => item !== fallbackNode,
								);
								delete state.chat.ui.subAgentExpandedById[fallbackNodeId];
							} else {
								currentNode = migrateFallbackNodeToInstance(fallbackNode);
							}
						}
					}
					if (!currentNode) {
						currentNode = {
							nodeId: id,
							agentId,
							agentName,
							level,
							parentNodeId: '',
							lines: [],
							result: '',
							contextText: '',
							usageText: '',
							hasChildren: false,
							children: [],
							hasNormalReply: false,
							status: 'running',
							completedByHook: false,
							completedAt: 0,
						};
						state.chat.subAgents.unshift(currentNode);
						state.chat.ui.subAgentExpandedById[id] = level === 0;
					}
					return currentNode;
				};
				const node = ensureNode(nodeId);
				node.agentId = agentId;
				node.agentName = agentName;
				node.level = Number.isFinite(level) ? level : 0;
				const currentType = String(payload?.type ?? '');
				const isHookEvent =
					currentType === 'done' || currentType === 'spawned_agent_completed';
				const isRunningActivityEvent = new Set([
					'content',
					'text',
					'reasoning',
					'thinking',
					'tool_calls',
					'tool_result',
					'context_usage',
					'agent_spawned',
					'inter_agent_sent',
				]).has(currentType);
				const updateCompletionState = () => {
					if (!isHookEvent && isRunningActivityEvent) {
						node.completedByHook = false;
					}
					node.completedByHook = Boolean(node.completedByHook || isHookEvent);
					const canComplete = Boolean(node.hasNormalReply);
					if (canComplete) {
						const alreadyDone = String(node.status ?? '') === 'done';
						node.status = 'done';
						node.result = '已完成';
						node.hasChildren =
							Array.isArray(node.children) && node.children.length > 0;
						if (!alreadyDone) {
							node.completedAt = Date.now();
						}
						return;
					}
					node.status = 'running';
					node.result = '工作中';
				};
				if (payload?.type === 'context_usage') {
					node.contextText = `${Number(payload?.percentage ?? 0)}% (${Number(
						payload?.inputTokens ?? 0,
					)} / ${Number(payload?.maxTokens ?? 0)})`;
					node.usageText = `Input ${Number(
						payload?.inputTokens ?? 0,
					)}, Max ${Number(payload?.maxTokens ?? 0)}`;
				} else if (payload?.type === 'agent_spawned') {
					const childId = String(payload?.spawnedInstanceId ?? '');
					if (childId) {
						const childNode = ensureNode(childId);
						childNode.parentNodeId = nodeId;
						childNode.level = Math.max(
							node.level + 1,
							Number(childNode.level ?? 0),
						);
						if (!node.children.includes(childId)) {
							node.children.push(childId);
						}
						node.hasChildren = node.children.length > 0;
						state.chat.ui.subAgentExpandedById[childId] = false;
					}
				} else if (payload?.type === 'tool_calls') {
					const toolCalls = Array.isArray(payload?.tool_calls)
						? payload.tool_calls
						: [];
					const toolNames = toolCalls
						.map(tc => tc?.function?.name || '?')
						.join(', ');
					if (toolNames) {
						node.lines.push(`🔧 ${toolNames}`);
						node.lines = node.lines.slice(-60);
					}
				} else if (payload?.type === 'tool_result') {
					const toolName = String(payload?.tool_name ?? '');
					const resultContent = String(payload?.content ?? '');
					const isError = resultContent.startsWith('Error:');
					const icon = isError ? '✗' : '•';
					node.lines.push(
						`└─ ${icon} ${toolName ? toolName + ': ' : ''}${resultContent}`,
					);
					node.lines = node.lines.slice(-60);
				} else if (
					payload?.type === 'tool_call_delta' ||
					payload?.type === 'content_delta' ||
					payload?.type === 'reasoning_delta' ||
					payload?.type === 'usage'
				) {
					// 增量事件静默忽略.
				} else {
					const isReasoningType =
						payload?.type === 'reasoning' || payload?.type === 'thinking';
					const isNormalTextType =
						payload?.type === 'content' || payload?.type === 'text';
					const line =
						typeof payload?.content === 'string'
							? payload.content
							: typeof payload?.text === 'string'
							? payload.text
							: isReasoningType
							? String(payload?.text ?? payload?.content ?? '')
							: '';
					if (line) {
						if (isReasoningType) {
							const lastIndex = node.lines.length - 1;
							const lastLine = String(node.lines[lastIndex] ?? '');
							if (lastLine.startsWith('💭 ')) {
								node.lines[lastIndex] = `${lastLine}${line}`;
							} else {
								node.lines.push(`💭 ${line}`);
							}
						} else if (isNormalTextType) {
							const lastIndex = node.lines.length - 1;
							const lastLine = String(node.lines[lastIndex] ?? '');
							const canMergeToLast =
								lastLine &&
								!lastLine.startsWith('💭 ') &&
								!lastLine.startsWith('🔧 ') &&
								!lastLine.startsWith('└─ ');
							if (canMergeToLast) {
								node.lines[lastIndex] = `${lastLine}${line}`;
							} else {
								node.lines.push(line);
							}
							node.hasNormalReply = true;
						} else {
							node.lines.push(line);
						}
						node.lines = node.lines.slice(-60);
					}
				}
				if (payload?.type === 'subagent_result') {
					node.result = '已完成';
					const finalText = String(
						payload?.result ?? payload?.content ?? '',
					).trim();
					node.hasNormalReply = true;
					if (finalText) {
						node.lines.push(finalText);
						node.lines = node.lines.slice(-60);
					}
				}
				updateCompletionState();
				const rootNodeCount = (state.chat.subAgents ?? []).filter(item => {
					const parentNodeId = String(item?.parentNodeId ?? '');
					return !parentNodeId;
				}).length;
				if (rootNodeCount <= 1) {
					state.chat.ui.subAgentPopupIndex = 0;
				}
				break;
			}
			case 'rollback_result': {
				const rd = event.data ?? {};
				if (rd.success) {
					const filesInfo =
						rd.filesRolledBack > 0
							? `, 回滚了 ${rd.filesRolledBack} 个文件`
							: '';
					pushMessage(
						'system',
						`回退成功 (消息索引 #${rd.messageIndex ?? '?'}${filesInfo})`,
					);
					void refreshSessionList(serverId);
					// 重新加载当前会话以刷新聊天记录, 完成后将回退点消息原文恢复到草稿状态
					const sid = state.chat.currentSessionId;
					const pendingContent = state.chat.ui.pendingRollbackContent || '';
					state.chat.ui.pendingRollbackContent = '';
					if (sid && loadSelectedSession) {
						loadSelectedSession(sid).then(() => {
							if (!pendingContent) {
								return;
							}
							withServerTabContext(serverId, () => {
								if (state.chat.currentSessionId !== sid) {
									return;
								}
								state.chat.ui.pendingDraftText = pendingContent;
								if (state.control.selectedServerId === serverId) {
									render();
								}
							});
						});
					}
				} else {
					pushMessage('error', rd.error ?? '回退失败');
				}
				break;
			}
			default:
				break;
		}

		syncCurrentSessionEvents();
		return true;
	}

	/**
	 * 安排有限次自动重连.
	 * @param {string} serverId 服务端ID.
	 */
	function scheduleReconnect(serverId) {
		const shouldRender = serverId === state.control.selectedServerId;
		let needRender = false;
		withServerTabContext(serverId, () => {
			clearRetryTimer();
			if (state.connection.retryCount >= state.connection.maxRetries) {
				pushMessage('error', '自动重连已达到上限,请手动重连');
				needRender = true;
				return;
			}
			state.connection.retryCount += 1;
			state.connection.retryTimer = window.setTimeout(() => {
				state.connection.retryTimer = null;
				connectSelectedServer(true, serverId);
			}, state.connection.retryDelayMs);
		});
		if (shouldRender && needRender) {
			render();
		}
	}

	/**
	 * 建立单服务SSE连接.
	 * @param {boolean} [isReconnect=false] 是否重连流程.
	 * @param {string} [serverId] 服务端ID.
	 */
	function connectSelectedServer(
		isReconnect = false,
		serverId = state.control.selectedServerId,
	) {
		const shouldRender = serverId === state.control.selectedServerId;
		withServerTabContext(serverId, () => {
			const server = state.control.servers.find(
				item => item.serverId === serverId,
			);
			if (!server) {
				state.control.error = '请先选择服务';
				return;
			}

			closeConnection('manual', serverId);
			if (isReconnect) {
				setTerminalReminderWindowActive(true);
			}
			const host = window.location.hostname || '127.0.0.1';
			state.connection.baseUrl = `http://${host}:${server.port}`;
			state.connection.status = 'connecting';
			if (!isReconnect) {
				resetChatForConnect();
			}
			const eventSource = new EventSource(`${state.connection.baseUrl}/events`);
			state.connection.eventSource = eventSource;

			eventSource.onmessage = raw => {
				let handled = false;
				let eventType = '';
				withServerTabContext(serverId, () => {
					try {
						const parsedEvent = JSON.parse(raw.data);
						eventType = String(parsedEvent?.type ?? '');
						handled = handleSseEvent(parsedEvent, serverId);
					} catch {
						// 非法事件体忽略.
					}
				});
				if (handled) {
					if (chatOnlyRenderEventTypes.has(eventType)) {
						renderChatOnly();
					} else {
						render();
					}
				}
			};

			eventSource.onerror = () => {
				const shouldRenderOnError = serverId === state.control.selectedServerId;
				withServerTabContext(serverId, () => {
					closeConnection('error', serverId);
					pushMessage('error', 'SSE连接异常,正在尝试重连');
					scheduleReconnect(serverId);
				});
				if (shouldRenderOnError) {
					render();
				}
			};
		});
		if (shouldRender) {
			render();
		}
	}

	/**
	 * 手动立即重连.
	 */
	function reconnectNow() {
		const serverId = state.control.selectedServerId;
		withServerTabContext(serverId, () => {
			state.connection.retryCount = 0;
			connectSelectedServer(true, serverId);
		});
	}

	/**
	 * 发送聊天消息.
	 */
	async function sendChat() {
		const serverId = state.control.selectedServerId;
		return withServerTabContext(serverId, async () => {
			const baseUrl = state.connection.baseUrl;
			if (!baseUrl || state.connection.status !== 'connected') {
				state.chat.error = '请先连接服务';
				render();
				return;
			}
			const input = document.getElementById('chatInput');
			const draftText =
				typeof state.chat.ui.pendingDraftText === 'string'
					? state.chat.ui.pendingDraftText
					: '';
			const content = draftText.trim();
			const pendingImages = Array.isArray(state.chat.ui.pendingImages)
				? [...state.chat.ui.pendingImages]
				: [];
			const hasContent = Boolean(content) || pendingImages.length > 0;
			if (!hasContent) {
				return;
			}
			const interjectSelect = document.getElementById('interjectTargetSelect');
			const interjectTarget = interjectSelect?.value ?? '';
			state.chat.error = '';
			state.chat.ui.chatAutoScrollEnabled = true;
			const displayContent =
				pendingImages.length > 0
					? `${content || ''}${content ? ' ' : ''}[${
							pendingImages.length
					  }张图片]`
					: content;
			state.chat.ui.pendingDraftText = '';
			if (input) {
				input.value = '';
			}
			state.chat.ui.pendingImages = [];
			try {
				let imageDataList = [];
				if (pendingImages.length > 0) {
					imageDataList = await Promise.all(
						pendingImages.map(
							file =>
								new Promise((resolve, reject) => {
									const reader = new FileReader();
									reader.onload = () => {
										const base64 =
											String(reader.result ?? '').split(',')[1] ?? '';
										resolve({
											type: file.type,
											data: base64,
										});
									};
									reader.onerror = () => reject(new Error('读取图片失败'));
									reader.readAsDataURL(file);
								}),
						),
					);
				}
				const queuedItem = enqueueUserMessage({
					content: content || '',
					displayContent,
					images: imageDataList,
					targetAgentNodeId: interjectTarget || undefined,
				});
				render();
				if (!state.chat.ui.assistantWorking) {
					void flushQueuedMessagesIfNeeded(serverId, baseUrl);
				}
				return queuedItem;
			} catch (error) {
				state.chat.error = error instanceof Error ? error.message : '发送失败';
				pushMessage('error', state.chat.error);
				state.chat.ui.pendingDraftText = draftText;
				if (input) {
					input.value = draftText;
				}
				if (pendingImages.length > 0) {
					state.chat.ui.pendingImages = pendingImages;
				}
				render();
			}
		});
	}

	return {
		connectSelectedServer,
		closeConnection,
		reconnectNow,
		sendChat,
		openLogModal,
		closeLogModal,
		openUnreadTerminalModal,
		closeUnreadTerminalModal,
		openLogDetail,
		openLogTextDetail,
		closeLogDetail,
		toggleLogPanel,
		dismissInfoMessage,
		pauseInfoCountdown,
		resumeInfoCountdown,
		switchMainAgent,
		updateQuickSwitchField,
		applyQuickSwitch,
		newSession,
		abortSession,
		fetchRollbackPoints,
		rollbackSession,
		compressSession,
		cancelCompressFlow,
		toggleSubAgentNode,
		shiftSubAgentPopup,
		closeSubAgent,
		toggleYolo,
		addImages,
		removePendingImage,
		updatePendingDraftText,
		cancelQueuedMessage,
		editQueuedMessage,
	};
}
