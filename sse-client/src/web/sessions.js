import {
	state,
	ensureServerTab,
	setSessions,
	pushMessage,
	syncCurrentSessionEvents,
	withServerTabContext,
	clearSessionAttention,
	clearTodoUnread,
	clearSessionTerminalUnread,
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
		if (serverId === state.control.selectedServerId) {
			render();
		}
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
			if (serverId === state.control.selectedServerId) {
				render();
			}
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
		state.chat.dialogs.logModalOpen = false;
		state.chat.dialogs.logDetailOpen = false;
		state.chat.dialogs.logDetailTitle = '';
		state.chat.dialogs.logDetailJson = '';
		state.chat.dialogs.unreadTerminalModalOpen = false;
		clearSessionAttention(sessionId);
		clearSessionTerminalUnread(sessionId);
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
	 * 归一化会话历史中的思考内容.
	 * @param {any} message 历史消息对象.
	 * @returns {string}
	 */
	function normalizeHistoryThinkingText(message) {
		const reasoningSummary = Array.isArray(message?.reasoning?.summary)
			? message.reasoning.summary
					.map(item => String(item?.text ?? '').trim())
					.filter(Boolean)
					.join('\n')
			: '';
		const raw =
			message?.thinking?.thinking ||
			reasoningSummary ||
			message?.reasoning_content ||
			message?.reasoningContent ||
			'';
		return String(raw ?? '').trim();
	}

	/**
	 * 生成工具调用参数摘要(前3个字段, 值截断60字符).
	 * @param {any} tc 工具调用对象 {function:{name,arguments}}.
	 * @returns {string} 如 "filePath: /src/..., startLine: 1"
	 */
	function summarizeToolCallArgs(tc) {
		try {
			const rawArgs = tc?.function?.arguments;
			const args =
				typeof rawArgs === 'string'
					? rawArgs.length > 10000
						? null
						: JSON.parse(rawArgs)
					: rawArgs;
			if (args && typeof args === 'object') {
				const entries = Object.entries(args);
				let summary = entries
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
					summary += `, ... (+${entries.length - 3})`;
				}
				return summary;
			}
		} catch {
			return String(tc?.function?.arguments ?? '').slice(0, 80);
		}
		return '';
	}

	/**
	 * 为历史工具结果生成摘要(与 sse.js tool_result 保持一致).
	 * @param {string} toolName 工具名.
	 * @param {string} content 工具返回内容.
	 * @param {string} status 状态('success'|'error'|'pending').
	 * @returns {string}
	 */
	function summarizeToolResult(toolName, content, status) {
		if (status === 'error' && content) {
			return `✗ 工具错误: ${content.slice(0, 200)}`;
		}
		if (!content) {
			return '✓ Done';
		}
		try {
			const data = JSON.parse(content);
			if (toolName.startsWith('subagent-') && data.result) {
				const txt = String(data.result);
				const icon = data.success === false ? '✗' : '✓';
				return `${icon} ${txt}`;
			}
			if (toolName === 'filesystem-read' && data.totalLines !== undefined) {
				const readLines = data.endLine
					? data.endLine - (data.startLine || 1) + 1
					: data.totalLines;
				return `✓ Read ${readLines} lines${
					data.totalLines > readLines ? ` of ${data.totalLines} total` : ''
				}`;
			}
			if (
				(toolName === 'ace-text-search' || toolName === 'ace-text_search') &&
				Array.isArray(data)
			) {
				return `✓ Found ${data.length} ${
					data.length === 1 ? 'match' : 'matches'
				}`;
			}
			if (toolName === 'terminal-execute' && data.exitCode !== undefined) {
				return data.exitCode === 0
					? '✓ Command succeeded'
					: `✗ Exit code: ${data.exitCode}`;
			}
			if (
				toolName === 'filesystem-edit' ||
				toolName === 'filesystem-edit_search' ||
				toolName === 'filesystem-create'
			) {
				return data.message ? `✓ ${data.message}` : '✓ File updated';
			}
			if (
				toolName === 'codebase-retrieval' ||
				toolName === 'context_engine-codebase-retrieval'
			) {
				return '✓ Codebase context retrieved';
			}
			if (typeof data === 'object') {
				const keys = Object.keys(data).slice(0, 3);
				if (keys.length > 0) {
					return `✓ ${keys.join(', ')}`;
				}
			}
		} catch {
			// not JSON, use raw content
		}
		return content.length > 50
			? `✓ ${content.slice(0, 50)}...`
			: `✓ ${content}`;
	}

	/**
	 * 将服务端历史消息转换为精简展示格式(含工具调用摘要).
	 * @param {Array<any>} history 原始历史消息.
	 * @returns {Array<{role:'assistant'|'user'|'error',content:string,timestamp:string}>}
	 */
	function convertSessionHistoryToChatMessages(history) {
		const messages = [];
		/** @type {Map<string,string>} tool_call_id → toolName */
		const toolCallMap = new Map();
		const isToolCallLikeText = text =>
			/^(?:🔧|🛠|⚇⚡|⚇)\s*/.test(String(text ?? '').trim());

		for (const item of history) {
			const role = String(item?.role ?? item?.sender ?? '');
			const timestamp = item?.timestamp ?? new Date().toISOString();

			if (role === 'system') {
				continue;
			}

			if (role === 'assistant') {
				const text = normalizeHistoryMessageText(item);
				const thinking = normalizeHistoryThinkingText(item);
				const hasToolCalls =
					Array.isArray(item?.tool_calls) && item.tool_calls.length > 0;
				const shouldKeepAssistantText =
					text && !(hasToolCalls && isToolCallLikeText(text));
				if (shouldKeepAssistantText || thinking) {
					messages.push({
						role,
						content: shouldKeepAssistantText ? text : '',
						timestamp,
						thinking,
					});
				}
				// 展开 tool_calls 为 🔧 摘要行
				if (hasToolCalls) {
					for (const tc of item.tool_calls) {
						const toolName = tc?.function?.name ?? 'unknown_tool';
						if (tc?.id) {
							toolCallMap.set(tc.id, toolName);
						}
						const argsSummary = summarizeToolCallArgs(tc);
						messages.push({
							role: 'assistant',
							content: argsSummary
								? `🔧 ${toolName}(${argsSummary})`
								: `🔧 ${toolName}`,
							timestamp,
							toolMeta: {
								kind: 'call',
								title: toolName,
								summary: argsSummary ? `参数: ${argsSummary}` : '等待执行结果',
								detail: tc?.function?.arguments ?? '',
								status: 'running',
							},
						});
					}
				}
			} else if (role === 'tool') {
				const toolCallId = item?.tool_call_id ?? '';
				const fallbackToolName = String(
					item?.name ?? item?.toolName ?? item?.tool_name ?? item?.tool ?? '',
				);
				const toolName = toolCallMap.get(toolCallId) || fallbackToolName;
				const status = item?.messageStatus ?? 'success';
				const content = String(item?.content ?? '');
				const summary = summarizeToolResult(toolName, content, status);
				let subAgentReply = '';
				if (toolName.startsWith('subagent-') && content) {
					try {
						const resultData = JSON.parse(content);
						subAgentReply = String(
							resultData?.result ?? resultData?.content ?? '',
						).trim();
					} catch {
						subAgentReply = '';
					}
				}
				if (summary) {
					messages.push({
						role: 'assistant',
						content: `└─ ${summary}`,
						timestamp,
						toolMeta: {
							kind: 'result',
							title: toolName || 'tool_call',
							summary,
							detail: content,
							subAgentReply,
							status: status === 'error' ? 'error' : 'success',
						},
					});
				}
			} else if (role === 'user' || role === 'error') {
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
			const loadBody = {sessionId};
			if (state.connection.connectionId) {
				loadBody.connectionId = state.connection.connectionId;
			}
			const response = await fetch(`${baseUrl}/session/load`, {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify(loadBody),
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
				tab.chat.dialogs.logModalOpen = false;
				tab.chat.dialogs.logDetailOpen = false;
				tab.chat.dialogs.logDetailTitle = '';
				tab.chat.dialogs.logDetailJson = '';
				tab.chat.dialogs.unreadTerminalModalOpen = false;
				clearSessionAttention(payload.session.id);
				clearSessionTerminalUnread(payload.session.id);
				clearTodoUnread();
				tab.chat.ui.assistantWorking = false;
				tab.chat.ui.flushingQueuedMessage = false;
				tab.chat.ui.queuedUserMessages = [];
				tab.chat.ui.queuedMessageSeq = 0;
				tab.chat.subAgents = [];
				tab.chat.ui.subAgentExpandedById = {};
				tab.chat.ui.subAgentPopupIndex = 0;
				tab.chat.ui.subAgentToolCallNodeIds = [];
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
					tab.chat.ui.assistantWorking = false;
					tab.chat.ui.flushingQueuedMessage = false;
					tab.chat.ui.queuedUserMessages = [];
					tab.chat.ui.queuedMessageSeq = 0;
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
