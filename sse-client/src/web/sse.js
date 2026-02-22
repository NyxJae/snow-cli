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
} from './state.js';
import {showToolConfirmationDialog, showUserQuestionDialog} from './dialogs.js';

/**
 * 创建SSE与聊天动作.
 * @param {{render:()=>void,refreshSessionList:(serverId?:string)=>Promise<void>}} options 依赖项.
 * @returns {{connectSelectedServer:(isReconnect?:boolean,serverId?:string)=>void,closeConnection:(reason?:'manual'|'error',serverId?:string)=>void,reconnectNow:()=>void,sendChat:()=>Promise<void>,openLogDetail:(eventId:string)=>void,closeLogDetail:()=>void}}
 */
export function createSseActions(options) {
	const {render, refreshSessionList} = options;

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
			state.connection.status = reason === 'error' ? 'error' : 'disconnected';
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
				body: JSON.stringify({type, requestId, response}),
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
	 * 关闭日志详情弹窗.
	 */
	function closeLogDetail() {
		state.chat.dialogs.logDetailOpen = false;
		render();
	}

	/**
	 * 切换日志面板折叠状态.
	 */
	function toggleLogPanel() {
		state.chat.ui.logPanelCollapsed = !state.chat.ui.logPanelCollapsed;
		if (!state.chat.ui.logPanelCollapsed) {
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
	 * 发送渠道快捷切换指令.
	 * @param {'profile'} field 字段.
	 */
	async function applyQuickSwitch(field) {
		if (field !== 'profile') {
			return;
		}
		const value = String(state.chat.quickSwitch.profile ?? '').trim();
		if (!value) {
			pushMessage('error', '请选择渠道');
			render();
			return;
		}
		const previousPreferredProfile =
			state.chat.quickSwitch.preferredProfileForNewSession;
		const input = document.getElementById('chatInput');
		if (input) {
			input.value = `/profile ${value}`;
		}
		state.chat.quickSwitch.preferredProfileForNewSession = value;
		await sendChat();
		if (state.chat.error) {
			state.chat.quickSwitch.preferredProfileForNewSession =
				previousPreferredProfile;
			render();
			return;
		}
		state.chat.statusBar.apiProfile = value;
		render();
	}

	const knownEventTypes = new Set([
		'connected',
		'message',
		'error',
		'complete',
		'tool_confirmation_request',
		'user_question_request',
		'todo_update',
		'todos',
		'agent_list',
		'agent_switched',
		'usage',
		'sub_agent_message',
	]);
	const sessionScopedEventTypes = new Set([
		'message',
		'error',
		'complete',
		'tool_confirmation_request',
		'user_question_request',
		'todo_update',
		'todos',
	]);

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
			state.chat.ui.logPanelCollapsed &&
			Boolean(eventSessionId) &&
			eventSessionId === state.chat.currentSessionId;
		if (shouldIncrementLogUnread) {
			incrementLogUnread();
		}
		switch (event.type) {
			case 'connected': {
				state.connection.status = 'connected';
				state.connection.retryCount = 0;
				pushMessage(
					'system',
					`SSE连接已建立: ${event.data?.connectionId ?? '-'}`,
				);
				void refreshSessionList(serverId);
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
				const text =
					event.data?.content ??
					event.data?.text ??
					event.data?.message ??
					JSON.stringify(event.data);
				pushMessage('assistant', String(text));
				if (typeof event.data?.sessionId === 'string') {
					state.chat.currentSessionId = event.data.sessionId;
					touchSession(event.data.sessionId);
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
			case 'complete': {
				if (typeof event.data?.sessionId === 'string') {
					const completedSessionId = event.data.sessionId;
					touchSession(completedSessionId);
					const isCurrentSession =
						completedSessionId === state.chat.currentSessionId;
					if (!isCurrentSession) {
						markSessionAttention(completedSessionId);
					} else {
						clearSessionAttention(completedSessionId);
					}
					pushInfoMessage('任务已完成,点击查看会话', {
						tipType: 'complete',
						serverId,
						sessionId: completedSessionId,
						allowCurrentSession: true,
					});
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
				state.chat.statusBar.kvCacheCreate = Number(
					event.data?.cacheCreationInputTokens ?? 0,
				);
				break;
			}
			case 'sub_agent_message': {
				const agentId = String(event.data?.agentId ?? '');
				const agentName = String(
					event.data?.agentName ?? agentId ?? 'sub-agent',
				);
				const payload = event.data?.message ?? {};
				const instanceId = String(payload?.instanceId ?? '');
				const nodeId =
					instanceId || `${agentId}:${String(payload?.spawnDepth ?? 0)}`;
				if (!nodeId) {
					break;
				}
				const level = Number(payload?.spawnDepth ?? 0);
				const ensureNode = id => {
					let currentNode = state.chat.subAgents.find(
						item => item.nodeId === id,
					);
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
				if (payload?.type === 'context_usage') {
					node.contextText = `${Number(payload?.percentage ?? 0)}% (${Number(
						payload?.inputTokens ?? 0,
					)} / ${Number(payload?.maxTokens ?? 0)})`;
					node.usageText = `Input ${Number(
						payload?.inputTokens ?? 0,
					)}, Max ${Number(payload?.maxTokens ?? 0)}`;
				} else if (payload?.type === 'done') {
					node.result = node.result || '已完成';
				} else if (payload?.type === 'spawned_agent_completed') {
					node.hasChildren =
						Array.isArray(node.children) && node.children.length > 0;
					node.result =
						payload?.success === false ? '子代理执行失败' : node.result;
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
				} else {
					const line =
						typeof payload?.content === 'string'
							? payload.content
							: typeof payload?.text === 'string'
							? payload.text
							: payload?.type
							? `[${String(payload.type)}]`
							: '';
					if (line) {
						node.lines.push(line);
						node.lines = node.lines.slice(-20);
					}
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
				withServerTabContext(serverId, () => {
					try {
						handled = handleSseEvent(JSON.parse(raw.data), serverId);
					} catch {
						// 非法事件体忽略.
					}
				});
				if (handled) {
					render();
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
			const content = input?.value?.trim() ?? '';
			if (!content) {
				return;
			}
			state.chat.error = '';
			state.chat.ui.chatAutoScrollEnabled = true;
			pushMessage('user', content);
			if (input) {
				input.value = '';
			}
			render();
			try {
				let currentSessionId = state.chat.currentSessionId || undefined;
				const initialAgentId =
					!currentSessionId &&
					state.chat.mainAgent.preferredAgentIdForNewSession
						? state.chat.mainAgent.preferredAgentIdForNewSession
						: undefined;
				const postChatMessage = async chatContent => {
					const response = await fetch(`${baseUrl}/message`, {
						method: 'POST',
						headers: {'Content-Type': 'application/json'},
						body: JSON.stringify({
							type: 'chat',
							content: chatContent,
							sessionId: currentSessionId,
							yoloMode: Boolean(state.chat.statusBar?.yoloMode ?? true),
						}),
					});
					if (!response.ok) {
						throw new Error(`发送失败: HTTP ${response.status}`);
					}
				};
				if (!currentSessionId) {
					const createBody = initialAgentId ? {initialAgentId} : {};
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
					void refreshSessionList(serverId);
					const shouldApplyPreferredProfile =
						!String(content).startsWith('/profile ') &&
						Boolean(state.chat.quickSwitch.preferredProfileForNewSession);
					if (shouldApplyPreferredProfile) {
						await postChatMessage(
							`/profile ${state.chat.quickSwitch.preferredProfileForNewSession}`,
						);
					}
				}

				await postChatMessage(content);
			} catch (error) {
				state.chat.error = error instanceof Error ? error.message : '发送失败';
				pushMessage('error', state.chat.error);
				render();
			}
		});
	}

	return {
		connectSelectedServer,
		closeConnection,
		reconnectNow,
		sendChat,
		openLogDetail,
		closeLogDetail,
		toggleLogPanel,
		dismissInfoMessage,
		pauseInfoCountdown,
		resumeInfoCountdown,
		switchMainAgent,
		updateQuickSwitchField,
		applyQuickSwitch,
		toggleSubAgentNode,
	};
}
