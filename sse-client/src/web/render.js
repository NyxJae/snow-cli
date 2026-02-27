import {state, getAllInfoMessages} from './state.js';
import {byId, escapeHtml} from './utils.js';

/**
 * 渲染红点徽标.
 * @returns {string}
 */
function renderBadge() {
	return '<span class="badge-dot" aria-hidden="true"></span>';
}

/**
 * 渲染数字徽标.
 * @param {number} count 数量.
 * @returns {string}
 */
function renderCountBadge(count) {
	if (!count) {
		return '';
	}
	return `<span class="badge-count">${count}</span>`;
}

const LOG_PREVIEW_MAX = 180;
let cachedChatRowHtmlList = [];

/**
 * 清洗思考文本中的 think 标签.
 * @param {string} value 原始文本.
 * @returns {string}
 */
function cleanThinkingContent(value) {
	return String(value ?? '')
		.replace(/\s*<\/?think(?:ing)?>\s*/gi, ' ')
		.trim();
}

/**
 * 捕获聊天输入框状态,用于重绘后恢复输入体验.
 * @returns {{isFocused:boolean,value:string,selectionStart:number|null,selectionEnd:number|null,selectionDirection:'forward'|'backward'|'none'|null}|null}
 */
function captureChatInputSnapshot() {
	const chatInput = byId('chatInput');
	if (!chatInput) {
		return null;
	}
	return {
		isFocused: document.activeElement === chatInput,
		value: String(chatInput.value ?? ''),
		selectionStart: chatInput.selectionStart,
		selectionEnd: chatInput.selectionEnd,
		selectionDirection: chatInput.selectionDirection,
	};
}

/**
 * 恢复聊天输入框状态,仅在重绘前已聚焦时生效.
 * @param {{isFocused:boolean,value:string,selectionStart:number|null,selectionEnd:number|null,selectionDirection:'forward'|'backward'|'none'|null}|null} snapshot 输入框快照.
 * @param {{updatePendingDraftText?:(text:string)=>void}} actions 渲染动作集合.
 */
function restoreChatInputSnapshot(snapshot, actions) {
	if (!snapshot?.isFocused) {
		return;
	}
	const chatInput = byId('chatInput');
	if (!chatInput) {
		return;
	}
	const activeElement = document.activeElement;
	const canRestoreFocus =
		!activeElement ||
		activeElement === document.body ||
		activeElement === chatInput;
	if (!canRestoreFocus) {
		return;
	}
	const value = String(snapshot.value ?? '');
	if (chatInput.value !== value) {
		chatInput.value = value;
	}
	if (typeof actions?.updatePendingDraftText === 'function') {
		actions.updatePendingDraftText(value);
	}
	const textLength = value.length;
	const rawStart = Number.isInteger(snapshot.selectionStart)
		? Number(snapshot.selectionStart)
		: textLength;
	const rawEnd = Number.isInteger(snapshot.selectionEnd)
		? Number(snapshot.selectionEnd)
		: rawStart;
	const selectionStart = Math.min(Math.max(rawStart, 0), textLength);
	const selectionEnd = Math.min(Math.max(rawEnd, 0), textLength);
	try {
		chatInput.focus({preventScroll: true});
	} catch {
		chatInput.focus();
	}
	try {
		chatInput.setSelectionRange(
			selectionStart,
			selectionEnd,
			snapshot.selectionDirection ?? 'none',
		);
	} catch {
		chatInput.setSelectionRange(selectionStart, selectionEnd);
	}
}

/**
 * 生成日志预览文本.
 * @param {string} text 完整日志文本.
 * @returns {string}
 */
function toLogPreview(text) {
	const normalized = String(text ?? '')
		.replace(/\s+/g, ' ')
		.trim();
	if (normalized.length <= LOG_PREVIEW_MAX) {
		return normalized;
	}
	return `${normalized.slice(0, LOG_PREVIEW_MAX)}...`;
}

/**
 * 将工具参数或返回值格式化为可读详情文本.
 * @param {any} value 原始值.
 * @returns {string}
 */
function toToolDetailText(value) {
	if (value === null || value === undefined) {
		return '';
	}
	if (typeof value === 'string') {
		const text = value.trim();
		if (!text) {
			return '';
		}
		try {
			const parsed = JSON.parse(text);
			if (typeof parsed === 'object' && parsed !== null) {
				return JSON.stringify(parsed, null, 2);
			}
		} catch {
			// keep raw text when not JSON.
		}
		return text;
	}
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/**
 * 解析工具消息文本,用于卡片化渲染.
 * @param {string} rawContent 原始消息内容.
 * @param {{kind?:'call'|'result',title?:string,summary?:string,detail?:any,status?:'running'|'success'|'error'}|null} toolMeta 工具元信息.
 * @returns {{kind:'call'|'result',title:string,summary:string,detail:string,status:'running'|'success'|'error'}|null}
 */
function parseToolMessage(rawContent, toolMeta = null) {
	if (toolMeta?.kind === 'call') {
		const detail = toToolDetailText(toolMeta.detail);
		return {
			kind: 'call',
			title: String(toolMeta.title || 'tool_call'),
			summary: String(
				toolMeta.summary || (detail ? '参数已展开' : '等待执行结果'),
			),
			detail,
			status: 'running',
		};
	}
	if (toolMeta?.kind === 'result') {
		const status = toolMeta.status === 'error' ? 'error' : 'success';
		const detail = toToolDetailText(toolMeta.detail);
		const subAgentReply = toToolDetailText(toolMeta.subAgentReply);
		return {
			kind: 'result',
			title: String(
				toolMeta.title ||
					(status === 'error' ? '工具结果(失败)' : '工具结果(成功)'),
			),
			summary: String(toolMeta.summary || detail || '无返回内容'),
			detail: detail || '无返回内容',
			subAgentReply,
			status,
		};
	}

	const content = String(rawContent ?? '').trim();
	if (!content) {
		return null;
	}
	const callPrefix = content.match(/^(?:🔧|🛠|⚇⚡|⚇)\s*(.+)$/);
	if (callPrefix) {
		const stripped = String(callPrefix[1] ?? '').trim();
		const separatorIndex = stripped.search(/[(:]/);
		const toolName =
			separatorIndex > 0
				? stripped.slice(0, separatorIndex).trim()
				: stripped.trim();
		const rawArgs =
			separatorIndex > 0 ? stripped.slice(separatorIndex + 1).trim() : '';
		const argsText = rawArgs.replace(/\)+\s*$/, '').trim();
		return {
			kind: 'call',
			title: toolName || 'tool_call',
			summary: argsText ? `参数: ${argsText}` : '等待执行结果',
			detail: argsText,
			status: 'running',
		};
	}
	if (
		content.startsWith('└─') ||
		content.startsWith('✓') ||
		content.startsWith('✗')
	) {
		const stripped = content.replace(/^└─\s*/, '');
		const status = stripped.startsWith('✗') ? 'error' : 'success';
		const normalized = stripped.replace(/^[✓✗]\s*/, '').trim();
		return {
			kind: 'result',
			title: status === 'error' ? '工具结果(失败)' : '工具结果(成功)',
			summary: normalized || '无返回内容',
			detail: normalized || '无返回内容',
			status,
		};
	}
	return null;
}

/**
 * 渲染工具消息卡片.
 * @param {{title:string,status:'running'|'success'|'error',inputSummary:string,inputDetail:string,outputSummary:string,outputDetail:string}} toolCard 工具卡片数据.
 * @returns {string}
 */
function renderToolCard(toolCard) {
	const statusClass =
		toolCard.status === 'error'
			? 'tool-card-error'
			: toolCard.status === 'success'
			? 'tool-card-success'
			: 'tool-card-running';
	const statusText =
		toolCard.status === 'error'
			? '失败'
			: toolCard.status === 'success'
			? '成功'
			: '执行中';
	const title = String(toolCard.title ?? 'tool_call');
	const normalizedTitle = title.toLowerCase();
	const isSubAgentCard =
		normalizedTitle.startsWith('sub-agent:') ||
		normalizedTitle.startsWith('subagent-');
	const summaryText =
		toolCard.status === 'running'
			? toolCard.inputSummary || '等待执行结果'
			: toolCard.outputSummary || '无返回内容';
	const compactSummary =
		summaryText.length <= 120 ? summaryText : `${summaryText.slice(0, 120)}...`;
	const subAgentSummary =
		toolCard.status === 'running'
			? '子代理工作中,请展开下方区块查看.'
			: '子代理已完成,请展开下方区块查看.';
	const detailBlocks = [];
	if (toolCard.inputDetail) {
		detailBlocks.push(`输入参数:\n${toolCard.inputDetail}`);
	}
	if (toolCard.outputDetail) {
		detailBlocks.push(`返回结果:\n${toolCard.outputDetail}`);
	}
	const detailText = detailBlocks.join('\n\n');
	const needDetails = Boolean(detailText) || summaryText.length > 120;
	const subAgentTaskText = String(toolCard.inputDetail ?? '').trim();
	const subAgentProcessText = String(toolCard.subAgentProcess ?? '').trim();
	const subAgentReplyText = String(toolCard.subAgentReply ?? '').trim();
	const subAgentSections = isSubAgentCard
		? `${
				subAgentTaskText
					? `<details class="tool-card-details"><summary>任务要求</summary><pre>${escapeHtml(
							subAgentTaskText,
					  )}</pre></details>`
					: ''
		  }${
				subAgentProcessText
					? `<details class="tool-card-details" open><summary>工作过程</summary><pre>${escapeHtml(
							subAgentProcessText,
					  )}</pre></details>`
					: ''
		  }${
				subAgentReplyText
					? `<details class="tool-card-details" open><summary>子代理回复</summary><pre>${escapeHtml(
							subAgentReplyText,
					  )}</pre></details>`
					: ''
		  }`
		: '';
	return `<div class="tool-card ${statusClass}">
		<div class="tool-card-header">
			<span class="tool-card-title">${escapeHtml(title)}</span>
			<span class="tool-card-status">${statusText}</span>
		</div>
		<div class="tool-card-summary">${escapeHtml(
			isSubAgentCard ? subAgentSummary : compactSummary,
		)}</div>
		${subAgentSections}
		${
			!isSubAgentCard && needDetails
				? `<details class="tool-card-details"><summary>查看详情</summary><pre>${escapeHtml(
						detailText || summaryText,
				  )}</pre></details>`
				: ''
		}
	</div>`;
}

/**
 * 计算服务端 Tab 的提醒数量.
 * @param {string} serverId 服务端ID.
 * @returns {number}
 */
function getServerAttentionCount(serverId) {
	const tab = state.control.serverTabs[serverId];
	if (!tab) {
		return 0;
	}
	return Object.keys(tab.chat.ui.sessionAttention ?? {}).length;
}

/**
 * 渲染会话侧栏与管理弹窗.
 * @returns {{recentHtml:string,modalHtml:string,pagerText:string}}
 */
function renderSessionArea() {
	const attention = state.chat.ui.sessionAttention ?? {};
	const recentHtml = state.chat.recentSessions
		.map(item => {
			const activeClass =
				item.id === state.chat.currentSessionId ? ' active' : '';
			const badge = attention[item.id] ? renderBadge() : '';
			return `<button class="session-item${activeClass}" data-session-id="${escapeHtml(
				item.id,
			)}">${badge}${escapeHtml(item.title ?? '(无标题)')}</button>`;
		})
		.join('');

	const modalHtml = state.chat.sessions
		.map(item => {
			const selectedClass =
				item.id === state.chat.sessionPager.selectedSessionId
					? ' selected'
					: '';
			const badge = attention[item.id] ? renderBadge() : '';
			return `<div class="session-row${selectedClass}">
				<div class="session-main">
					<div class="session-title">${badge}${escapeHtml(item.title ?? '(无标题)')}</div>
					<div class="hint">${escapeHtml(item.id ?? '')}</div>
				</div>
				<div class="row">
					<button type="button" data-action="load-session" data-session-id="${escapeHtml(
						item.id,
					)}">继续</button>
					<button type="button" data-action="delete-session" data-session-id="${escapeHtml(
						item.id,
					)}">删除</button>
				</div>
			</div>`;
		})
		.join('');

	const pagerText = `第 ${state.chat.sessionPager.page + 1} 页, 共 ${Math.max(
		1,
		Math.ceil(state.chat.sessionPager.total / state.chat.sessionPager.pageSize),
	)} 页`;

	return {
		recentHtml: recentHtml || '<div class="hint">暂无会话</div>',
		modalHtml: modalHtml || '<div class="session-item">暂无会话</div>',
		pagerText,
	};
}

/**
 * 将单行 diff 文本包裹为带语法着色的 HTML span.
 * @param {string} line 原始行文本.
 * @returns {string} 带 class 的 HTML 字符串.
 */
function colorDiffLine(line) {
	const escaped = escapeHtml(line);
	if (line.startsWith('@@')) {
		return `<span class="diff-hunk">${escaped}</span>`;
	}
	if (line.startsWith('diff --') || line.startsWith('index ')) {
		return `<span class="diff-meta">${escaped}</span>`;
	}
	if (line.startsWith('---') || line.startsWith('+++')) {
		return `<span class="diff-header">${escaped}</span>`;
	}
	if (line.startsWith('-')) {
		return `<span class="diff-del">${escaped}</span>`;
	}
	if (line.startsWith('+')) {
		return `<span class="diff-add">${escaped}</span>`;
	}
	return `<span>${escaped}</span>`;
}

/**
 * 将 unified diff 文本渲染为着色 HTML(单列模式).
 * @param {string} diffText 原始 diff 文本.
 * @returns {string} 着色后的 HTML 字符串.
 */
function renderDiffHtml(diffText) {
	return String(diffText || '')
		.split(/\r?\n/)
		.map(line => colorDiffLine(line))
		.join('');
}

/**
 * 将 unified diff 拆分为左(删除侧)右(新增侧)两列着色 HTML.
 * @param {string} diffText 原始 diff 文本.
 * @returns {{left: string, right: string}}
 */
function buildDiffColumns(diffText) {
	const leftLines = [];
	const rightLines = [];
	for (const rawLine of String(diffText || '').split(/\r?\n/)) {
		if (
			rawLine.startsWith('@@') ||
			rawLine.startsWith('diff --') ||
			rawLine.startsWith('index ')
		) {
			const colored = colorDiffLine(rawLine);
			leftLines.push(colored);
			rightLines.push(colored);
			continue;
		}
		if (rawLine.startsWith('---') || rawLine.startsWith('+++')) {
			const colored = colorDiffLine(rawLine);
			leftLines.push(colored);
			rightLines.push(colored);
			continue;
		}
		if (rawLine.startsWith('-')) {
			leftLines.push(colorDiffLine(rawLine));
			rightLines.push('');
			continue;
		}
		if (rawLine.startsWith('+')) {
			leftLines.push('');
			rightLines.push(colorDiffLine(rawLine));
			continue;
		}
		const colored = colorDiffLine(rawLine);
		leftLines.push(colored);
		rightLines.push(colored);
	}
	return {
		left: leftLines.join(''),
		right: rightLines.join(''),
	};
}

/**
 * 渲染 Git 文件列表区块.
 * @param {string} title 标题.
 * @param {Array<{path:string}>} files 文件列表.
 * @param {'modified'|'untracked'|'deleted'|'staged'} source 来源分组.
 * @returns {string}
 */
function renderGitGroup(title, files, source) {
	const rows = files
		.map(item => {
			const path = item?.path ?? '';
			if (!path) {
				return '';
			}
			const isStaged = source === 'staged';
			return `<div class="git-file-row">
				<button type="button" data-action="git-open-diff" data-path="${escapeHtml(
					path,
				)}" data-staged="${isStaged ? '1' : '0'}">${escapeHtml(path)}</button>
				<button type="button" data-action="git-${
					isStaged ? 'unstage' : 'stage'
				}" data-path="${escapeHtml(path)}">${
				isStaged ? '取消暂存' : '暂存'
			}</button>
			</div>`;
		})
		.join('');
	return `<section class="card git-group"><h4>${escapeHtml(title)}</h4>${
		rows || '<div class="hint">空</div>'
	}</section>`;
}

/**
 * 判断聊天列表是否处于底部附近.
 * @param {HTMLElement} container 聊天滚动容器.
 * @returns {boolean}
 */
function isChatListNearBottom(container) {
	const threshold = 16;
	const distance =
		container.scrollHeight - (container.scrollTop + container.clientHeight);
	return distance <= threshold;
}

/**
 * 构建聊天区渲染记录.
 * @returns {Array<{type:'tool',card:any}|{type:'normal',item:any}>}
 */
function buildMergedRenderRecords() {
	const chatRoles = new Set(['user', 'assistant']);
	const sourceChatMessages = state.chat.messages.filter(item =>
		chatRoles.has(item?.role),
	);
	const mergedChatMessages = [];
	const pendingToolCards = [];
	const normalizeToolTitle = title =>
		String(title ?? '')
			.trim()
			.toLowerCase();
	for (let index = 0; index < sourceChatMessages.length; index += 1) {
		const item = sourceChatMessages[index];
		const isUser = item?.role === 'user';
		if (isUser) {
			mergedChatMessages.push({type: 'normal', item});
			continue;
		}
		const parsed = parseToolMessage(
			item?.content ?? '',
			item?.toolMeta ?? null,
		);
		if (parsed?.kind === 'call') {
			const card = {
				title: parsed.title,
				status: 'running',
				inputSummary: parsed.summary,
				inputDetail: parsed.detail,
				outputSummary: '',
				outputDetail: '',
			};
			mergedChatMessages.push({type: 'tool', card});
			pendingToolCards.push(card);
			continue;
		}
		if (parsed?.kind === 'result') {
			const parsedTitle = normalizeToolTitle(parsed.title);
			let fallbackCard = null;
			let targetCard = null;
			for (
				let pendingIndex = pendingToolCards.length - 1;
				pendingIndex >= 0;
				pendingIndex -= 1
			) {
				const candidate = pendingToolCards[pendingIndex];
				if (candidate.status !== 'running') {
					continue;
				}
				if (!fallbackCard) {
					fallbackCard = candidate;
				}
				if (
					parsedTitle &&
					parsedTitle !== 'tool_call' &&
					normalizeToolTitle(candidate.title) === parsedTitle
				) {
					targetCard = candidate;
					break;
				}
			}
			const resolvedCard = targetCard || fallbackCard;
			if (resolvedCard) {
				resolvedCard.status = parsed.status;
				resolvedCard.outputSummary = parsed.summary;
				resolvedCard.outputDetail = parsed.detail;
				if (
					normalizeToolTitle(resolvedCard.title).startsWith('subagent-') &&
					parsed.subAgentReply
				) {
					resolvedCard.subAgentReply = parsed.subAgentReply;
				}
			} else {
				mergedChatMessages.push({
					type: 'tool',
					card: {
						title: parsed.title || 'tool_call',
						status: parsed.status,
						inputSummary: '未捕获工具调用参数',
						inputDetail: '',
						outputSummary: parsed.summary,
						outputDetail: parsed.detail,
						subAgentReply: parsed.subAgentReply || '',
					},
				});
			}
			continue;
		}
		mergedChatMessages.push({type: 'normal', item});
	}
	const subAgentToolCards = (state.chat.subAgents ?? [])
		.filter(item => String(item?.nodeId ?? ''))
		.map(item => {
			const lines = Array.isArray(item?.lines)
				? item.lines.map(line => String(line ?? '').trim()).filter(Boolean)
				: [];
			const processLines = lines.filter(
				line =>
					line.startsWith('💭 ') ||
					line.startsWith('🔧 ') ||
					line.startsWith('└─ '),
			);
			const replyLines = lines.filter(
				line =>
					!line.startsWith('💭 ') &&
					!line.startsWith('🔧 ') &&
					!line.startsWith('└─ '),
			);
			const processSummary =
				processLines.length > 0
					? processLines[processLines.length - 1]
					: '暂无工作过程';
			const replySummary =
				replyLines.length > 0 ? replyLines[replyLines.length - 1] : '';
			const nodeStatus = String(item?.status ?? 'running');
			const status = nodeStatus === 'done' ? 'success' : 'running';
			const agentTitle = String(
				item?.agentName ?? item?.agentId ?? item?.nodeId ?? 'sub-agent',
			);
			return {
				title: `sub-agent:${agentTitle}`,
				status,
				inputSummary: processSummary,
				inputDetail: processLines.join('\n'),
				outputSummary: replySummary,
				outputDetail: replyLines.join('\n'),
				subAgentProcess: processLines.join('\n'),
				subAgentReply: replyLines.join('\n'),
				subAgentAgentId: String(item?.agentId ?? '').trim(),
			};
		});
	const mergedRenderRecords = [...mergedChatMessages];
	for (const subAgentCard of subAgentToolCards) {
		const agentId = normalizeToolTitle(subAgentCard.subAgentAgentId);
		let matchedToolCard = null;
		if (agentId) {
			for (
				let recordIndex = mergedRenderRecords.length - 1;
				recordIndex >= 0;
				recordIndex -= 1
			) {
				const record = mergedRenderRecords[recordIndex];
				if (record?.type !== 'tool') {
					continue;
				}
				const cardTitle = normalizeToolTitle(record?.card?.title ?? '');
				if (cardTitle === `subagent-${agentId}`) {
					matchedToolCard = record.card;
					break;
				}
			}
		}
		if (matchedToolCard) {
			matchedToolCard.status = subAgentCard.status;
			matchedToolCard.outputSummary =
				subAgentCard.outputSummary || matchedToolCard.outputSummary;
			matchedToolCard.outputDetail =
				subAgentCard.outputDetail || matchedToolCard.outputDetail;
			matchedToolCard.subAgentProcess = subAgentCard.subAgentProcess;
			matchedToolCard.subAgentReply = subAgentCard.subAgentReply;
			continue;
		}
		mergedRenderRecords.push({type: 'tool', card: subAgentCard});
	}
	return mergedRenderRecords;
}

/**
 * 构建聊天行HTML数组.
 * @returns {string[]}
 */
function buildMessageRowHtmlList() {
	const mergedRenderRecords = buildMergedRenderRecords();
	return mergedRenderRecords.map(record => {
		if (record.type === 'tool') {
			return `<div class="chat-bubble-wrap chat-bubble-wrap-left chat-bubble-wrap-tool">
				<span class="chat-avatar">🛠</span>
				<div>${renderToolCard(record.card)}</div>
			</div>`;
		}
		const item = record.item;
		const isUser = item.role === 'user';
		const side = isUser ? 'right' : 'left';
		const content = String(item.content ?? '');
		const thinking = cleanThinkingContent(item?.thinking ?? '');
		const queueId = String(item?.queueId ?? '');
		const queueStatus = String(item?.queueStatus ?? '');
		const isQueuedUser = isUser && queueId && queueStatus === 'queued';
		const bubbleClass = isUser ? 'chat-bubble-user' : 'chat-bubble-assistant';
		const avatar = isUser ? '👤' : '🤖';
		const queueActions = isQueuedUser
			? `<div class="row" style="margin-top:6px;gap:6px;justify-content:flex-end;">
				<span class="hint">queued</span>
				<button type="button" data-action="queue-edit" data-queue-id="${escapeHtml(
					queueId,
				)}">编辑</button>
				<button type="button" data-action="queue-cancel" data-queue-id="${escapeHtml(
					queueId,
				)}">撤回</button>
			</div>`
			: '';
		const thinkingBlock =
			!isUser && thinking
				? `<details class="chat-thinking-block"><summary>思考内容</summary><pre>${escapeHtml(
						thinking,
				  )}</pre></details>`
				: '';
		const bubble = content
			? `<div class="chat-bubble ${bubbleClass}">${escapeHtml(content)}</div>`
			: '';
		return `<div class="chat-bubble-wrap chat-bubble-wrap-${side}">
			<span class="chat-avatar">${avatar}</span>
			<div>
				${thinkingBlock}
				${bubble}
				${queueActions}
			</div>
		</div>`;
	});
}

/**
 * 仅增量刷新聊天消息列表,避免整页重绘.
 * @returns {boolean}
 */
export function patchChatMessageList() {
	const chatMessageList = byId('chatMessageList');
	const chatScrollToBottomBtn = byId('chatScrollToBottomBtn');
	if (!chatMessageList) {
		cachedChatRowHtmlList = [];
		return false;
	}
	const previousRows = Array.isArray(cachedChatRowHtmlList)
		? cachedChatRowHtmlList
		: [];
	const nextRows = buildMessageRowHtmlList();
	let firstDiffIndex = -1;
	const compareLength = Math.min(previousRows.length, nextRows.length);
	for (let index = 0; index < compareLength; index += 1) {
		if (previousRows[index] !== nextRows[index]) {
			firstDiffIndex = index;
			break;
		}
	}
	if (firstDiffIndex === -1) {
		if (previousRows.length === nextRows.length) {
			return true;
		}
		firstDiffIndex = compareLength;
	}
	const wrappers = Array.from(chatMessageList.children);
	if (firstDiffIndex < wrappers.length) {
		for (
			let removeIndex = wrappers.length - 1;
			removeIndex >= firstDiffIndex;
			removeIndex -= 1
		) {
			wrappers[removeIndex]?.remove();
		}
	}
	for (let index = firstDiffIndex; index < nextRows.length; index += 1) {
		const template = document.createElement('template');
		template.innerHTML = nextRows[index] || '';
		if (template.content.firstElementChild) {
			chatMessageList.appendChild(template.content.firstElementChild);
		}
	}
	cachedChatRowHtmlList = nextRows;
	if (state.chat.ui.chatAutoScrollEnabled) {
		chatMessageList.scrollTop = chatMessageList.scrollHeight;
	} else {
		state.chat.ui.chatManualScrollTop = chatMessageList.scrollTop;
	}
	if (chatScrollToBottomBtn) {
		chatScrollToBottomBtn.classList.toggle(
			'is-visible',
			!isChatListNearBottom(chatMessageList),
		);
	}
	return true;
}

/**
 * 主渲染函数.
 */
export function renderApp(actions) {
	const app = byId('app');
	if (!app) {
		return;
	}
	const chatInputSnapshot = captureChatInputSnapshot();
	const previousChatMessageList = byId('chatMessageList');
	const previousScrollTop = previousChatMessageList
		? Number(previousChatMessageList.scrollTop || 0)
		: Number(state.chat.ui.chatManualScrollTop || 0);

	if (!state.auth.isLoggedIn) {
		app.innerHTML = `
			<section class="card login-card">
				<h1>❄ Snow SSE</h1>
				<p class="hint">请先登录控制面</p>
				<div class="row">
					<input id="passwordInput" type="password" placeholder="输入密码" />
					<button id="loginBtn" type="button" class="btn-primary">登录</button>
				</div>
				<p class="error">${escapeHtml(state.auth.error)}</p>
			</section>
		`;
		byId('loginBtn')?.addEventListener('click', () => {
			void actions.doLogin();
		});
		return;
	}

	const {recentHtml, modalHtml, pagerText} = renderSessionArea();
	const serverTabButtons = state.control.servers
		.map(item => {
			const activeClass =
				item.serverId === state.control.selectedServerId ? 'active' : '';
			const folderName =
				String(item.workDir ?? '')
					.replace(/[\\/]+$/, '')
					.split(/[\\/]/)
					.pop() || item.workDir;
			const hasDuplicate =
				state.control.servers.filter(s => {
					const n = String(s.workDir ?? '')
						.replace(/[\\/]+$/, '')
						.split(/[\\/]/)
						.pop();
					return n === folderName;
				}).length > 1;
			const tabLabel = hasDuplicate ? `${folderName}:${item.port}` : folderName;
			const externalBadge =
				item.source === 'external'
					? '<span class="external-badge" title="外部服务(非本客户端启动)">ext</span>'
					: '';
			return `<button type="button" class="tab-btn ${activeClass}" data-action="select-server-tab" data-server-id="${escapeHtml(
				item.serverId,
			)}">${externalBadge}${escapeHtml(tabLabel)}${
				getServerAttentionCount(item.serverId) > 0 ? renderBadge() : ''
			}</button>`;
		})
		.join('');
	const messageRowHtmlList = buildMessageRowHtmlList();
	const messageRows = messageRowHtmlList.join('');
	cachedChatRowHtmlList = messageRowHtmlList;
	/**
	 * 渲染 TODO 树状结构.
	 * @param {Array} todos TODO 列表.
	 * @param {string} parentId 父 ID(空字符串为根).
	 * @returns {string} HTML 字符串.
	 */
	function renderTodoTree(
		todos,
		parentId = '',
		visited = new Set(),
		depth = 0,
	) {
		if (depth > 20) {
			return '';
		}
		const children = todos.filter(item => {
			const pid = String(item?.parentId ?? '');
			return pid === parentId;
		});
		if (children.length === 0) {
			return '';
		}
		const rows = children
			.map(item => {
				const todoId = String(item?.todoId ?? item?.id ?? '');
				if (visited.has(todoId)) {
					return '';
				}
				visited.add(todoId);
				const status = item?.status ?? 'pending';
				const content = item?.content ?? '';
				const statusClass = `todo-${
					status === 'inProgress'
						? 'inProgress'
						: status === 'completed'
						? 'completed'
						: 'pending'
				}`;
				const icon =
					status === 'completed' ? '✓' : status === 'inProgress' ? '◉' : '○';
				const childrenHtml = todoId
					? renderTodoTree(todos, todoId, visited, depth + 1)
					: '';
				return `<div class="todo-item ${statusClass}">
					<span class="todo-icon">${icon}</span>
					<span class="todo-content">${escapeHtml(content)}</span>
				</div>${
					childrenHtml ? `<div class="todo-children">${childrenHtml}</div>` : ''
				}`;
			})
			.join('');
		return rows;
	}
	const hasParentIds = state.chat.todos.some(item => item?.parentId);
	const todoRows = hasParentIds
		? renderTodoTree(state.chat.todos, '')
		: state.chat.todos
				.map(item => {
					const status = item?.status ?? 'pending';
					const content = item?.content ?? '';
					const statusClass = `todo-${
						status === 'inProgress'
							? 'inProgress'
							: status === 'completed'
							? 'completed'
							: 'pending'
					}`;
					const icon =
						status === 'completed' ? '✓' : status === 'inProgress' ? '◉' : '○';
					return `<div class="todo-item ${statusClass}">
						<span class="todo-icon">${icon}</span>
						<span class="todo-content">${escapeHtml(content)}</span>
					</div>`;
				})
				.join('');
	const eventRows = state.chat.currentSessionEvents
		.map(item => {
			const detailText = JSON.stringify(item.data ?? null);
			const previewText = toLogPreview(detailText);
			const detailButton = `<button type="button" data-action="open-log-detail" data-event-id="${escapeHtml(
				item.id ?? '',
			)}">详情</button>`;
			return `<div class="log-item"><div class="log-item-row"><span class="log-item-text">[${escapeHtml(
				item.type,
			)}] ${escapeHtml(
				previewText,
			)}</span><span class="log-item-actions">${detailButton}</span></div></div>`;
		})
		.join('');
	const infoRows = getAllInfoMessages()
		.filter(item => Number(item.expiresAt ?? 0) > Date.now())
		.map(item => {
			const tipType = item.tipType ? `[${item.tipType}]` : '[info]';
			const serverLabel = item.serverId || '-';
			const sessionLabel = item.sessionId || '-';
			return `<div class="tip-item" data-info-id="${escapeHtml(
				item.id ?? '',
			)}" data-action="open-info-card" data-server-id="${escapeHtml(
				item.serverId ?? '',
			)}" data-session-id="${escapeHtml(
				item.sessionId ?? '',
			)}"><div><strong>${escapeHtml(tipType)}</strong> ${escapeHtml(
				item.message ?? '',
			)}</div><div class="tip-meta">服务端: ${escapeHtml(
				serverLabel,
			)} | 会话: ${escapeHtml(
				sessionLabel,
			)}</div></div><div class="tip-actions"><button type="button" data-action="open-info-target" data-server-id="${escapeHtml(
				item.serverId ?? '',
			)}" data-session-id="${escapeHtml(
				item.sessionId ?? '',
			)}">查看</button><button type="button" data-action="dismiss-info" data-info-id="${escapeHtml(
				item.id ?? '',
			)}">关闭</button></div></div>`;
		})
		.join('');
	const mainAgentOptions = state.chat.mainAgent.agents
		.map(
			item =>
				`<option value="${escapeHtml(item.id ?? '')}">${escapeHtml(
					item.name ?? item.id ?? '',
				)}</option>`,
		)
		.join('');
	const selectedMainAgentId =
		state.chat.mainAgent.currentAgentId ||
		state.chat.mainAgent.preferredAgentIdForNewSession ||
		'';
	const logDetailTitle = state.chat.dialogs.logDetailTitle || '日志详情';
	const logDetailJson = state.chat.dialogs.logDetailJson || '{}';
	const statusBar = state.chat.statusBar ?? {};
	const canCommit =
		state.git.staged.length > 0 &&
		String(state.git.commitMessage ?? '').trim().length > 0;
	const statusBarHtml =
		state.git.view === 'chat'
			? `<section class="card status-bar"><div class="status-grid">
				<span class="status-item"><span class="status-label">API</span> <span class="status-value">${escapeHtml(
					String(statusBar.apiProfile ?? '-'),
				)}</span></span>
				<span class="status-item"><span class="status-label">上下文</span> <span class="status-value">${escapeHtml(
					`${Number(statusBar.contextPercent ?? 0)}%`,
				)}</span></span>
				<span class="status-item"><span class="status-label">Token</span> <span class="status-value">${escapeHtml(
					`${Number(statusBar.tokenUsed ?? 0)}/${Number(
						statusBar.tokenTotal ?? 0,
					)}`,
				)}</span></span>
				<span class="status-item"><span class="status-label">KV</span> <span class="status-value">${escapeHtml(
					`R${Number(statusBar.kvCacheRead ?? 0)} C${Number(
						statusBar.kvCacheCreate ?? 0,
					)}`,
				)}</span></span>
				<span class="status-item"><span class="status-label">连接</span> <span class="status-value">${escapeHtml(
					state.connection.status || '-',
				)}</span></span>
				<span class="status-item"><span class="status-label">会话</span> <span class="status-value">${escapeHtml(
					String(statusBar.sessionWorkStatus ?? '已停止'),
				)}</span></span>
				<button id="toggleYoloBtn" type="button" class="yolo-toggle ${
					Boolean(statusBar.yoloMode) ? 'yolo-on' : 'yolo-off'
				}">YOLO: ${escapeHtml(
					Boolean(statusBar.yoloMode) ? 'ON' : 'OFF',
			  )}</button>
			</div></section>`
			: '';

	const gitGroupsHtml = [
		renderGitGroup('已暂存', state.git.staged, 'staged'),
		renderGitGroup('已修改', state.git.modified, 'modified'),
		renderGitGroup('未跟踪', state.git.untracked, 'untracked'),
		renderGitGroup('已删除', state.git.deleted, 'deleted'),
	].join('');
	const diffColumns = buildDiffColumns(state.git.diffText);
	const isWideDiff = window.innerWidth >= 1200;
	const gitMainHtml = state.git.isInitialized
		? `<div class="git-layout">
			<div class="git-file-groups">${gitGroupsHtml}</div>
			<section class="card git-diff-card">
				<div class="row">
					<h4>Diff Viewer</h4>
					<button id="refreshGitBtn" type="button" ${
						state.git.loading ? 'disabled' : ''
					}>刷新状态</button>
				</div>
				<p class="hint">文件: ${escapeHtml(state.git.selectedPath || '-')}</p>
				<div class="${isWideDiff ? 'diff-wide' : 'diff-single'}">
				${
					isWideDiff
						? `<pre class="diff-content">${
								diffColumns.left || ''
						  }</pre><pre class="diff-content">${diffColumns.right || ''}</pre>`
						: `<pre class="diff-content">${renderDiffHtml(
								state.git.diffText,
						  )}</pre>`
				}
			</div>
				<div class="row">
					<textarea id="gitCommitInput" class="chat-input" placeholder="输入提交信息">${escapeHtml(
						state.git.commitMessage,
					)}</textarea>
				</div>
				<div class="row">
					<button id="commitGitBtn" type="button" ${
						state.git.commitLoading || !canCommit ? 'disabled' : ''
					}>提交</button>
				</div>
			</section>
		</div>`
		: `<div class="card"><p class="hint">当前目录尚未初始化 Git 仓库.</p><button id="initGitBtn" type="button" ${
				state.git.initLoading ? 'disabled' : ''
		  }>初始化 Git</button></div>`;

	const chatRoles = new Set(['user', 'assistant']);
	const logMessageRows = state.chat.messages
		.filter(item => !chatRoles.has(item?.role))
		.slice(-30)
		.map(item => {
			const previewText = toLogPreview(item.content ?? '');
			const timestamp = item.timestamp
				? `<span class="hint">${escapeHtml(item.timestamp)}</span>`
				: '';
			const detailButton = `<button type="button" data-action="open-log-text-detail" data-log-role="${escapeHtml(
				item.role ?? 'system',
			)}" data-log-content="${escapeHtml(
				item.content ?? '',
			)}" data-log-time="${escapeHtml(item.timestamp ?? '')}">详情</button>`;
			return `<div class="log-item ${
				item.role === 'error' ? 'log-error' : 'log-system'
			}"><div class="log-item-row"><span class="log-item-text">[${escapeHtml(
				item.role,
			)}] ${escapeHtml(
				previewText,
			)}</span><span class="log-item-actions">${timestamp}${detailButton}</span></div></div>`;
		})
		.join('');
	const logPanelHtml = state.chat.ui.logPanelCollapsed
		? ''
		: `<section class="card">
			<h4>系统日志</h4>
			<div class="log-list">${
				logMessageRows || eventRows
					? (logMessageRows || '') + (eventRows || '')
					: '<div class="hint">暂无日志</div>'
			}</div>
		</section>`;

	const runningSubAgents = (state.chat.subAgents ?? []).filter(
		item =>
			String(item?.status ?? 'running') !== 'done' &&
			String(item?.nodeId ?? ''),
	);
	const interjectOptions =
		runningSubAgents.length > 0
			? `<select id="interjectTargetSelect">
				<option value="">发送给主代理</option>
				${runningSubAgents
					.map(
						item =>
							`<option value="${escapeHtml(
								String(item?.nodeId ?? ''),
							)}">${escapeHtml(
								String(item?.agentName ?? item?.agentId ?? 'sub-agent'),
							)}</option>`,
					)
					.join('')}
			</select>`
			: '';

	const pendingImageRows = (state.chat.ui.pendingImages ?? [])
		.map(
			(file, index) =>
				`<span class="image-preview-item" data-image-index="${index}">${escapeHtml(
					String(file?.name ?? `图片${index + 1}`),
				)}<button type="button" data-action="remove-image" data-image-index="${index}">×</button></span>`,
		)
		.join('');
	const isCompressing = Boolean(state.chat.ui.compressFlowState?.active);

	const shouldShowScrollBottomBtn = !state.chat.ui.chatAutoScrollEnabled;
	const mainViewHtml =
		state.git.view === 'git'
			? gitMainHtml
			: `<div class="chat-main-col">
					<div class="chat-message-list-wrap">
						<div id="chatMessageList" class="chat-message-list">${
							messageRows || '<div class="hint">暂无消息</div>'
						}</div>
						<button
							id="chatScrollToBottomBtn"
							type="button"
							class="chat-scroll-bottom-btn${shouldShowScrollBottomBtn ? ' is-visible' : ''}"
							title="回到底部"
							aria-label="回到底部"
						>
							↓ 最新
						</button>
					</div>

					<textarea id="chatInput" class="chat-input" placeholder="输入消息并发送...">${escapeHtml(
						state.chat.ui.pendingDraftText || '',
					)}</textarea>
					${
						isCompressing
							? `<div class="compress-inline-actions" aria-live="polite">
								<div class="compress-inline-label">压缩中</div>
								<button id="cancelCompressBtn" type="button" class="btn-danger compress-cancel-btn">取消压缩</button>
							</div>`
							: `<div class="row chat-actions-primary">
								<input id="imageFileInput" type="file" accept="image/*" multiple style="display:none">
								<button id="imageBtn" type="button">图片</button>
								<button id="sendBtn" type="button" class="btn-primary btn-send-lg">发送</button>
							</div>
							<div class="row chat-actions-secondary">
								${interjectOptions}
								<button id="abortBtn" type="button" class="btn-danger">中断</button>
								<button id="compressSessionBtn" type="button">压缩</button>
								<button id="rollbackBtn" type="button">回退</button>
							</div>`
					}
					${
						state.chat.error
							? `<p class="error">${escapeHtml(state.chat.error)}</p>`
							: ''
					}
					<div id="rollbackPanel" class="rollback-panel" style="display:none"></div>
					<div id="imagePreviewArea" class="row image-preview-area">${
						pendingImageRows || ''
					}</div>


				<div class="todo-side-col">
					<h4>📝 TODO</h4>
					<div class="todo-list">${todoRows || '<div class="hint">暂无 TODO</div>'}</div>
				</div>
			</div>
				${logPanelHtml}
				<div class="row chat-footer-actions"><button id="toggleLogPanelBtn" type="button">日志</button></div>`;

	app.innerHTML = `
		<section class="card">
			<div class="app-header">
				<h1>❄ Snow SSE</h1>
				<button id="logoutBtn" type="button">登出</button>
			</div>
			<div class="row server-form-row">
				<button id="refreshServersBtn" type="button">刷新服务</button>
				<input id="serverWorkDirInput" type="text" list="workDirPresetList" autocomplete="off" placeholder="workDir" value="${escapeHtml(
					state.control.serverForm.workDir,
				)}" />
				<datalist id="workDirPresetList">${state.control.workDirPresets
					.map(workDir => `<option value="${escapeHtml(workDir)}"></option>`)
					.join('')}</datalist>
				<input id="serverPortInput" type="number" placeholder="port(可选)" value="${escapeHtml(
					state.control.serverForm.port,
				)}" />
				<input id="serverTimeoutInput" type="number" placeholder="timeoutMs" value="${escapeHtml(
					String(state.control.serverForm.timeoutMs ?? 300000),
				)}" />
				<button id="startServerBtn" type="button" ${
					state.control.actionLoading ? 'disabled' : ''
				}>启动</button>
				<button id="stopAllServersBtn" type="button" ${
					state.control.actionLoading || state.control.servers.length === 0
						? 'disabled'
						: ''
				}>停止全部</button>
				<button id="saveWorkDirBtn" type="button" ${
					state.control.actionLoading ? 'disabled' : ''
				}>保存为常用路径</button>
			</div>
			<div class="row server-tabs">${
				serverTabButtons || '<span class="hint">暂无服务端</span>'
			}</div>
			<div class="row">${(() => {
				const selectedServer = state.control.servers.find(
					s => s.serverId === state.control.selectedServerId,
				);
				const closeBtnDisabled = state.control.actionLoading || !selectedServer;
				return `
				<button id="reconnectBtn" type="button" ${
					state.control.actionLoading || !state.control.selectedServerId
						? 'disabled'
						: ''
				}>重连</button>
				<button id="closeServerBtn" type="button" ${
					closeBtnDisabled ? 'disabled' : ''
				} title="关闭当前服务端">关闭</button>
				<span class="conn-status">
					<span class="conn-dot conn-dot-${escapeHtml(
						state.connection.status === 'connected'
							? 'connected'
							: state.connection.status === 'connecting'
							? 'connecting'
							: 'disconnected',
					)}"></span>
					${escapeHtml(state.connection.status || 'disconnected')}
				</span>`;
			})()}
			</div>
			<p class="error">${escapeHtml(state.control.error)}</p>
		</section>
		${infoRows ? `<section class="tips-stack">${infoRows}</section>` : ''}
		<section class="layout">
			<aside class="card">
				<div class="row">
					<h3>最近5会话</h3>
					<button id="openSessionModalBtn" type="button">会话管理</button>
				</div>
				<div class="session-list">${recentHtml}</div>
			</aside>
			<section class="card">
				<div class="row tabs">
					<button class="tab-btn ${
						state.git.view === 'chat' ? 'active' : ''
					}" type="button" data-action="switch-view" data-view="chat">聊天</button>
					<button class="tab-btn ${
						state.git.view === 'git' ? 'active' : ''
					}" type="button" data-action="switch-view" data-view="git">Git</button>
					<select id="mainAgentSelect" ${
						state.chat.mainAgent.isSwitchingAgent ||
						state.chat.mainAgent.agents.length === 0
							? 'disabled'
							: ''
					}>
						<option value="">主代理</option>
						${mainAgentOptions}
					</select>
					<select id="quickProfileSelect" ${
						state.control.profileOptions.length === 0 ? 'disabled' : ''
					}>
						<option value="">选择渠道</option>
						${state.control.profileOptions
							.map(
								profile =>
									`<option value="${escapeHtml(profile)}">${escapeHtml(
										profile,
									)}</option>`,
							)
							.join('')}
					</select>
					<button id="newSessionBtn" type="button">新建会话</button>
				</div>
				${mainViewHtml}
				<p class="error">${escapeHtml(state.git.error)}</p>
			</section>
		</section>
		${statusBarHtml}
		<div id="logDetailModal" class="modal ${
			state.chat.dialogs.logDetailOpen ? '' : 'hidden'
		}" aria-hidden="${state.chat.dialogs.logDetailOpen ? 'false' : 'true'}">
			<div class="modal-card">
				<div class="modal-header">
					<h2>${escapeHtml(logDetailTitle)}</h2>
					<button id="closeLogDetailBtn" type="button">关闭</button>
				</div>
				<pre class="log-detail-content">${escapeHtml(logDetailJson)}</pre>
			</div>
		</div>
	`;

	const mainAgentSelect = byId('mainAgentSelect');
	if (mainAgentSelect && selectedMainAgentId) {
		mainAgentSelect.value = selectedMainAgentId;
	}

	const modalList = byId('sessionModalList');
	if (modalList) {
		modalList.innerHTML = `
			<div class="modal-actions">
				<button id="sessionPrevBtn" type="button" ${
					state.chat.sessionPager.page <= 0 || state.chat.sessionPager.loading
						? 'disabled'
						: ''
				}>上一页</button>
				<button id="sessionNextBtn" type="button" ${
					!state.chat.sessionPager.hasMore || state.chat.sessionPager.loading
						? 'disabled'
						: ''
				}>下一页</button>
				<span class="hint">${escapeHtml(pagerText)}</span>
			</div>
			<div class="modal-list">${modalHtml}</div>
		`;
	}

	byId('logoutBtn')?.addEventListener('click', () => {
		void actions.doLogout();
	});
	byId('refreshServersBtn')?.addEventListener('click', () => {
		void actions.refreshServers();
	});
	byId('serverWorkDirInput')?.addEventListener('input', event => {
		const target = /** @type {HTMLInputElement|null} */ (event.currentTarget);
		actions.updateServerForm('workDir', target?.value ?? '');
	});
	byId('serverPortInput')?.addEventListener('input', event => {
		const target = /** @type {HTMLInputElement|null} */ (event.currentTarget);
		actions.updateServerForm('port', target?.value ?? '');
	});
	byId('serverTimeoutInput')?.addEventListener('input', event => {
		const target = /** @type {HTMLInputElement|null} */ (event.currentTarget);
		actions.updateServerForm('timeoutMs', target?.value ?? '');
	});
	byId('startServerBtn')?.addEventListener('click', () => {
		void actions.startServer();
	});
	byId('stopAllServersBtn')?.addEventListener('click', () => {
		void actions.stopAllServers();
	});
	byId('saveWorkDirBtn')?.addEventListener('click', () => {
		void actions.saveCurrentWorkDirPreset();
	});
	byId('reconnectBtn')?.addEventListener('click', () => {
		actions.reconnectNow();
	});
	byId('closeServerBtn')?.addEventListener('click', () => {
		void actions.stopCurrentServer();
	});
	byId('toggleLogPanelBtn')?.addEventListener('click', () => {
		actions.toggleLogPanel();
	});
	byId('mainAgentSelect')?.addEventListener('change', event => {
		const target = /** @type {HTMLSelectElement|null} */ (event.currentTarget);
		void actions.switchMainAgent(target?.value ?? '');
	});
	const quickProfileSelect = byId('quickProfileSelect');
	if (quickProfileSelect) {
		quickProfileSelect.value =
			state.chat.quickSwitch?.profile || state.control.activeProfile || '';
	}
	byId('quickProfileSelect')?.addEventListener('change', event => {
		const target = /** @type {HTMLSelectElement|null} */ (event.currentTarget);
		const value = target?.value ?? '';
		actions.updateQuickSwitchField('profile', value);
		if (value) {
			void actions.applyQuickSwitch('profile');
		}
	});
	byId('newSessionBtn')?.addEventListener('click', () => {
		void actions.newSession();
	});
	byId('chatInput')?.addEventListener('input', event => {
		const target = /** @type {HTMLTextAreaElement|null} */ (
			event.currentTarget
		);
		actions.updatePendingDraftText(target?.value ?? '');
	});
	restoreChatInputSnapshot(chatInputSnapshot, actions);
	byId('sendBtn')?.addEventListener('click', () => {
		state.chat.ui.chatAutoScrollEnabled = true;
		void actions.sendChat();
	});
	byId('imageBtn')?.addEventListener('click', () => {
		if (state.chat.ui.compressFlowState?.active) {
			return;
		}
		byId('imageFileInput')?.click();
	});
	byId('imageFileInput')?.addEventListener('change', event => {
		if (state.chat.ui.compressFlowState?.active) {
			return;
		}
		const input = /** @type {HTMLInputElement|null} */ (event.currentTarget);
		if (!input?.files?.length) {
			return;
		}
		actions.addImages(Array.from(input.files));
		input.value = '';
	});
	for (const item of document.querySelectorAll(
		'[data-action="remove-image"]',
	)) {
		item.addEventListener('click', event => {
			const target = event.currentTarget;
			const imageIndex = Number(target?.getAttribute('data-image-index') ?? -1);
			if (imageIndex >= 0) {
				actions.removePendingImage(imageIndex);
			}
		});
	}
	byId('toggleYoloBtn')?.addEventListener('click', () => {
		actions.toggleYolo();
	});
	byId('compressSessionBtn')?.addEventListener('click', () => {
		if (state.chat.ui.compressFlowState?.active) {
			return;
		}
		void actions.compressSession();
	});
	byId('abortBtn')?.addEventListener('click', () => {
		if (state.chat.ui.compressFlowState?.active) {
			return;
		}
		void actions.abortSession();
	});
	byId('rollbackBtn')?.addEventListener('click', () => {
		if (state.chat.ui.compressFlowState?.active) {
			return;
		}
		void handleRollbackClick();
	});
	byId('cancelCompressBtn')?.addEventListener('click', () => {
		void actions.cancelCompressFlow();
	});
	byId('openSessionModalBtn')?.addEventListener('click', () => {
		actions.openSessionModal();
	});
	byId('closeLogDetailBtn')?.addEventListener('click', () => {
		actions.closeLogDetail();
	});
	byId('initGitBtn')?.addEventListener('click', () => {
		void actions.initGitRepo();
	});
	byId('refreshGitBtn')?.addEventListener('click', () => {
		void actions.refreshGitStatus();
	});
	byId('commitGitBtn')?.addEventListener('click', () => {
		const input = byId('gitCommitInput');
		actions.updateCommitMessage(input?.value ?? '');
		void actions.commitGitChanges();
	});
	byId('gitCommitInput')?.addEventListener('input', event => {
		const target = /** @type {HTMLTextAreaElement|null} */ (
			event.currentTarget
		);
		actions.updateCommitMessage(target?.value ?? '');
	});

	const closeSessionModalBtn = byId('closeSessionModalBtn');
	if (closeSessionModalBtn) {
		closeSessionModalBtn.onclick = () => {
			actions.closeSessionModal();
		};
	}
	byId('sessionPrevBtn')?.addEventListener('click', () => {
		void actions.prevSessionPage();
	});
	byId('sessionNextBtn')?.addEventListener('click', () => {
		void actions.nextSessionPage();
	});

	const chatMessageList = byId('chatMessageList');
	const chatScrollToBottomBtn = byId('chatScrollToBottomBtn');
	if (chatMessageList) {
		chatMessageList.addEventListener('scroll', () => {
			const nearBottom = isChatListNearBottom(chatMessageList);
			state.chat.ui.chatAutoScrollEnabled = nearBottom;
			if (!nearBottom) {
				state.chat.ui.chatManualScrollTop = chatMessageList.scrollTop;
			}
			if (chatScrollToBottomBtn) {
				chatScrollToBottomBtn.classList.toggle('is-visible', !nearBottom);
			}
		});
		if (state.chat.ui.chatAutoScrollEnabled) {
			chatMessageList.scrollTop = chatMessageList.scrollHeight;
		} else {
			chatMessageList.scrollTop = Math.max(0, previousScrollTop);
		}
	}
	if (chatMessageList && chatScrollToBottomBtn) {
		chatScrollToBottomBtn.addEventListener('click', () => {
			chatMessageList.scrollTop = chatMessageList.scrollHeight;
			state.chat.ui.chatAutoScrollEnabled = true;
			state.chat.ui.chatManualScrollTop = 0;
			chatScrollToBottomBtn.classList.remove('is-visible');
		});
	}

	for (const item of document.querySelectorAll('[data-action="switch-view"]')) {
		item.addEventListener('click', event => {
			const target = event.currentTarget;
			const view = target?.getAttribute('data-view');
			if (view === 'chat' || view === 'git') {
				actions.switchMainView(view);
			}
		});
	}

	for (const item of document.querySelectorAll(
		'[data-action="select-server-tab"]',
	)) {
		item.addEventListener('click', event => {
			const target = event.currentTarget;
			const serverId = target?.getAttribute('data-server-id') ?? '';
			actions.selectServerTab(serverId);
		});
	}

	for (const item of document.querySelectorAll(
		'[data-action="open-info-target"]',
	)) {
		item.addEventListener('click', event => {
			event.stopPropagation();
			const target = event.currentTarget;
			const serverId = target?.getAttribute('data-server-id') ?? '';
			const sessionId = target?.getAttribute('data-session-id') ?? '';
			if (serverId) {
				actions.selectServerTab(serverId);
			}
			if (sessionId) {
				actions.selectRecentSession(sessionId);
				void actions.loadSelectedSession(sessionId);
			}
		});
	}

	for (const item of document.querySelectorAll(
		'[data-action="open-info-card"]',
	)) {
		item.addEventListener('click', event => {
			const target = event.currentTarget;
			const serverId = target?.getAttribute('data-server-id') ?? '';
			const sessionId = target?.getAttribute('data-session-id') ?? '';
			if (serverId) {
				actions.selectServerTab(serverId);
			}
			if (sessionId) {
				actions.selectRecentSession(sessionId);
				void actions.loadSelectedSession(sessionId);
			}
		});
	}

	for (const item of document.querySelectorAll(
		'[data-action="dismiss-info"]',
	)) {
		item.addEventListener('click', event => {
			event.stopPropagation();
			const target = event.currentTarget;
			const infoId = target?.getAttribute('data-info-id') ?? '';
			actions.dismissInfoMessage(infoId);
		});
	}

	for (const item of document.querySelectorAll('.tip-item[data-info-id]')) {
		item.addEventListener('mouseenter', event => {
			const target = event.currentTarget;
			const infoId = target?.getAttribute('data-info-id') ?? '';
			actions.pauseInfoCountdown(infoId);
		});
		item.addEventListener('mouseleave', event => {
			const target = event.currentTarget;
			const infoId = target?.getAttribute('data-info-id') ?? '';
			actions.resumeInfoCountdown(infoId);
		});
	}

	for (const item of document.querySelectorAll(
		'[data-session-id][data-action]',
	)) {
		item.addEventListener('click', event => {
			const target = event.currentTarget;
			const sessionId = target?.getAttribute('data-session-id') ?? '';
			const action = target?.getAttribute('data-action') ?? '';
			if (action === 'load-session') {
				void actions.loadSelectedSession(sessionId);
				return;
			}
			if (action === 'delete-session') {
				void actions.deleteSelectedSession(sessionId);
			}
		});
	}

	for (const item of document.querySelectorAll(
		'[data-action="open-log-detail"]',
	)) {
		item.addEventListener('click', event => {
			const target = event.currentTarget;
			const eventId = target?.getAttribute('data-event-id') ?? '';
			actions.openLogDetail(eventId);
		});
	}

	for (const item of document.querySelectorAll(
		'[data-action="open-log-text-detail"]',
	)) {
		item.addEventListener('click', event => {
			const target = event.currentTarget;
			const role = target?.getAttribute('data-log-role') ?? 'system';
			const content = target?.getAttribute('data-log-content') ?? '';
			const timestamp = target?.getAttribute('data-log-time') ?? '';
			actions.openLogTextDetail(role, content, timestamp);
		});
	}

	for (const item of document.querySelectorAll(
		'.session-list [data-session-id]',
	)) {
		item.addEventListener('click', event => {
			const target = event.currentTarget;
			const sessionId = target?.getAttribute('data-session-id') ?? '';
			if (!sessionId) {
				return;
			}
			void actions.loadSelectedSession(sessionId);
		});
	}

	for (const item of document.querySelectorAll(
		'[data-action="queue-cancel"]',
	)) {
		item.addEventListener('click', event => {
			const target = event.currentTarget;
			const queueId = target?.getAttribute('data-queue-id') ?? '';
			if (!queueId) {
				return;
			}
			actions.cancelQueuedMessage(queueId);
		});
	}

	for (const item of document.querySelectorAll('[data-action="queue-edit"]')) {
		item.addEventListener('click', event => {
			const target = event.currentTarget;
			const queueId = target?.getAttribute('data-queue-id') ?? '';
			if (!queueId) {
				return;
			}
			const queuedItem = Array.isArray(state.chat.ui.queuedUserMessages)
				? state.chat.ui.queuedUserMessages.find(entry => entry.id === queueId)
				: null;
			const initialDraft =
				queuedItem?.displayContent ?? queuedItem?.content ?? '';
			const draft = window.prompt('编辑排队消息', initialDraft);
			if (draft == null) {
				return;
			}
			actions.editQueuedMessage(queueId, draft);
		});
	}

	for (const item of document.querySelectorAll(
		'[data-action="git-open-diff"]',
	)) {
		item.addEventListener('click', event => {
			const target = event.currentTarget;
			const path = target?.getAttribute('data-path') ?? '';
			const staged = target?.getAttribute('data-staged') === '1';
			void actions.loadGitDiff(path, staged);
		});
	}

	for (const item of document.querySelectorAll('[data-action="git-stage"]')) {
		item.addEventListener('click', event => {
			const target = event.currentTarget;
			const path = target?.getAttribute('data-path') ?? '';
			void actions.stageGitFile(path);
		});
	}

	for (const item of document.querySelectorAll('[data-action="git-unstage"]')) {
		item.addEventListener('click', event => {
			const target = event.currentTarget;
			const path = target?.getAttribute('data-path') ?? '';
			void actions.unstageGitFile(path);
		});
	}

	/**
	 * 点击"回退"按钮: 拉取回滚点列表并渲染选择面板.
	 */
	async function handleRollbackClick() {
		const panel = byId('rollbackPanel');
		if (!panel) {
			return;
		}
		// 若面板已显示则收起
		if (panel.style.display !== 'none') {
			panel.style.display = 'none';
			return;
		}
		panel.style.display = '';
		panel.innerHTML = '<div class="hint">正在获取回滚点...</div>';
		const points = await actions.fetchRollbackPoints();
		if (!points || points.length === 0) {
			panel.innerHTML = '<div class="hint">没有可用的回滚点</div>';
			return;
		}
		const rows = points
			.map(pt => {
				const time = pt.timestamp
					? new Date(pt.timestamp).toLocaleString()
					: '';
				const snap = pt.hasSnapshot
					? `<span class="badge">${pt.filesToRollbackCount} 文件可回滚</span>`
					: '<span class="hint">无快照</span>';
				const snapAttr =
					pt.snapshotIndex != null
						? ` data-snapshot-index="${pt.snapshotIndex}"`
						: '';
				return `<div class="rollback-item" data-index="${
					pt.messageIndex
				}"${snapAttr}>
				<div class="rollback-summary">#${pt.messageIndex} ${escapeHtml(
					pt.summary,
				)}</div>
				<div class="rollback-meta">${time} ${snap}</div>
				<div class="rollback-actions">
					<button class="rb-dialog-only" data-index="${
						pt.messageIndex
					}"${snapAttr} type="button">仅回退对话</button>
					<button class="rb-dialog-files" data-index="${
						pt.messageIndex
					}"${snapAttr} type="button" ${
					pt.hasSnapshot ? '' : 'disabled'
				}>对话+文件</button>
				</div>
			</div>`;
			})
			.join('');
		panel.innerHTML = `<div class="rollback-header"><strong>选择回退点</strong>
			<button id="closeRollbackPanel" type="button">✕</button></div>${rows}`;
		// 绑定关闭
		byId('closeRollbackPanel')?.addEventListener('click', () => {
			panel.style.display = 'none';
		});
		// 绑定"仅回退对话"
		for (const btn of panel.querySelectorAll('.rb-dialog-only')) {
			btn.addEventListener('click', event => {
				const idx = Number(event.currentTarget?.getAttribute('data-index'));
				const snapRaw = event.currentTarget?.getAttribute(
					'data-snapshot-index',
				);
				const snapIdx = snapRaw != null ? Number(snapRaw) : undefined;
				const point = points.find(p => p.messageIndex === idx);
				state.chat.ui.pendingRollbackContent =
					point?.content || point?.summary || '';
				panel.style.display = 'none';
				void actions.rollbackSession(idx, false, snapIdx);
			});
		}
		// 绑定"对话+文件"
		for (const btn of panel.querySelectorAll('.rb-dialog-files')) {
			btn.addEventListener('click', event => {
				const idx = Number(event.currentTarget?.getAttribute('data-index'));
				const snapRaw = event.currentTarget?.getAttribute(
					'data-snapshot-index',
				);
				const snapIdx = snapRaw != null ? Number(snapRaw) : undefined;
				const point = points.find(p => p.messageIndex === idx);
				state.chat.ui.pendingRollbackContent =
					point?.content || point?.summary || '';
				panel.style.display = 'none';
				void actions.rollbackSession(idx, true, snapIdx);
			});
		}
	}
}
