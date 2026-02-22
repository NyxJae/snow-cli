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
 * 解析 unified diff 为左右列.
 * @param {string} diffText 原始 diff 文本.
 * @returns {{left:string,right:string}}
 */
function buildDiffColumns(diffText) {
	const leftLines = [];
	const rightLines = [];
	for (const rawLine of String(diffText || '').split(/\r?\n/)) {
		if (rawLine.startsWith('@@') || rawLine.startsWith('diff --')) {
			leftLines.push(rawLine);
			rightLines.push(rawLine);
			continue;
		}
		if (rawLine.startsWith('---') || rawLine.startsWith('+++')) {
			leftLines.push(rawLine);
			rightLines.push(rawLine);
			continue;
		}
		if (rawLine.startsWith('-')) {
			leftLines.push(rawLine);
			rightLines.push('');
			continue;
		}
		if (rawLine.startsWith('+')) {
			leftLines.push('');
			rightLines.push(rawLine);
			continue;
		}
		leftLines.push(rawLine);
		rightLines.push(rawLine);
	}
	return {
		left: leftLines.join('\n'),
		right: rightLines.join('\n'),
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
 * 主渲染函数.
 */
export function renderApp(actions) {
	const app = byId('app');
	if (!app) {
		return;
	}

	if (!state.auth.isLoggedIn) {
		app.innerHTML = `
			<section class="card">
				<h1>Snow SSE Client</h1>
				<p class="hint">请先登录控制面.</p>
				<div class="row">
					<input id="passwordInput" type="password" placeholder="输入密码" />
					<button id="loginBtn" type="button">登录</button>
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
			return `<button type="button" class="tab-btn ${activeClass}" data-action="select-server-tab" data-server-id="${escapeHtml(
				item.serverId,
			)}">${escapeHtml(item.workDir)}:${item.port}${renderCountBadge(
				getServerAttentionCount(item.serverId),
			)}</button>`;
		})
		.join('');
	const messageRows = state.chat.messages
		.filter(item => item?.role !== 'system')
		.map(
			item =>
				`<div class="log-item"><strong>${escapeHtml(
					item.role,
				)}</strong>: ${escapeHtml(item.content)}</div>`,
		)
		.join('');
	const subAgentMap = new Map(
		(state.chat.subAgents ?? []).map(item => [
			String(item?.nodeId ?? ''),
			item,
		]),
	);
	function renderSubAgentNode(nodeId) {
		const node = subAgentMap.get(String(nodeId));
		if (!node) {
			return '';
		}
		const safeNodeId = String(node?.nodeId ?? '');
		if (!safeNodeId) {
			return '';
		}
		const level = Number(node?.level ?? 0);
		const isExpanded = Boolean(
			state.chat.ui.subAgentExpandedById?.[safeNodeId],
		);
		const children = Array.isArray(node?.children)
			? node.children.filter(childId =>
					Boolean(subAgentMap.get(String(childId))),
			  )
			: [];
		const hasChildren = children.length > 0;
		const lineRows = Array.isArray(node?.lines)
			? node.lines
					.map(
						line =>
							`<div class="sub-agent-line">${escapeHtml(String(line))}</div>`,
					)
					.join('')
			: '';
		const usageText = node?.usageText
			? `<div class="hint">Usage: ${escapeHtml(String(node.usageText))}</div>`
			: '';
		const contextText = node?.contextText
			? `<div class="hint">上下文: ${escapeHtml(
					String(node.contextText),
			  )}</div>`
			: '';
		const resultText = node?.result
			? `<div class="sub-agent-result">${escapeHtml(String(node.result))}</div>`
			: '';
		const childrenHtml =
			hasChildren && isExpanded
				? children.map(childId => renderSubAgentNode(String(childId))).join('')
				: '';
		return `<section class="card sub-agent-card" style="margin-left:${
			Math.max(0, level) * 12
		}px;">
			<div class="row">
				${
					hasChildren
						? `<button type="button" data-action="toggle-sub-agent" data-node-id="${escapeHtml(
								safeNodeId,
						  )}">${isExpanded ? '收起' : '展开'}</button>`
						: '<span class="hint">无子层</span>'
				}
				<strong>${escapeHtml(
					String(node?.agentName ?? node?.agentId ?? 'sub-agent'),
				)}</strong>
			</div>
			<div class="sub-agent-log-list">${
				lineRows || '<div class="hint">暂无过程日志</div>'
			}</div>
			${contextText}
			${usageText}
			${resultText}
			${childrenHtml}
		</section>`;
	}
	const subAgentRows = (state.chat.subAgents ?? [])
		.filter(item => {
			const parentNodeId = String(item?.parentNodeId ?? '');
			if (!parentNodeId) {
				return true;
			}
			return !subAgentMap.has(parentNodeId);
		})
		.map(item => renderSubAgentNode(String(item?.nodeId ?? '')))
		.filter(Boolean)
		.join('');
	const todoRows = state.chat.todos
		.map(item => {
			const status = item?.status ?? 'pending';
			const content = item?.content ?? '';
			return `<div class="log-item"><strong>[${escapeHtml(
				status,
			)}]</strong> ${escapeHtml(content)}</div>`;
		})
		.join('');
	const eventRows = state.chat.currentSessionEvents
		.map(
			item =>
				`<div class="log-item">[${escapeHtml(item.type)}] ${escapeHtml(
					JSON.stringify(item.data),
				)} <button type="button" data-action="open-log-detail" data-event-id="${escapeHtml(
					item.id ?? '',
				)}">详情</button></div>`,
		)
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
			? `<section class="card status-bar"><div class="status-grid"><span>API: ${escapeHtml(
					String(statusBar.apiProfile ?? '-'),
			  )}</span><span>上下文: ${escapeHtml(
					`${Number(statusBar.contextPercent ?? 0)}%`,
			  )}</span><span>Token: ${escapeHtml(
					`${Number(statusBar.tokenUsed ?? 0)} / ${Number(
						statusBar.tokenTotal ?? 0,
					)}`,
			  )}</span><span>KV: ${escapeHtml(
					`Read ${Number(statusBar.kvCacheRead ?? 0)} / Create ${Number(
						statusBar.kvCacheCreate ?? 0,
					)}`,
			  )}</span><span>连接: ${escapeHtml(
					state.connection.status || '-',
			  )}</span><span>YOLO: ${escapeHtml(
					Boolean(statusBar.yoloMode) ? 'ON' : 'OFF',
			  )}</span></div></section>`
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
							? `<pre class="log-item">${escapeHtml(
									diffColumns.left || '',
							  )}</pre><pre class="log-item">${escapeHtml(
									diffColumns.right || '',
							  )}</pre>`
							: `<pre class="log-item">${escapeHtml(
									state.git.diffText || '',
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

	const logPanelHtml = state.chat.ui.logPanelCollapsed
		? ''
		: `<section class="card">
			<h4>SSE事件(最近20条)</h4>
			<div class="log-list">${eventRows || '<div class="hint">暂无事件</div>'}</div>
		</section>`;

	const mainViewHtml =
		state.git.view === 'git'
			? gitMainHtml
			: `<div id="chatMessageList" class="log-list">${
					messageRows || '<div class="hint">暂无消息</div>'
			  }</div>
				${
					subAgentRows
						? `<section class="card"><h4>子代理面板</h4>${subAgentRows}</section>`
						: ''
				}
				<textarea id="chatInput" class="chat-input" placeholder="输入消息并发送"></textarea>
				<div class="row">
					<button id="sendBtn" type="button">发送</button>
					<button id="refreshSessionsBtn" type="button">刷新会话</button>
				</div>
				<p class="error">${escapeHtml(state.chat.error)}</p>
				<h4>TODO ${renderCountBadge(state.chat.ui.todoUnreadCount)}</h4>
				<div class="log-list todo-list">${
					todoRows || '<div class="hint">暂无TODO</div>'
				}</div>
				${logPanelHtml}
				<div class="row chat-footer-actions"><button id="toggleLogPanelBtn" type="button">日志${renderCountBadge(
					state.chat.ui.logUnreadCount,
				)}</button></div>`;

	app.innerHTML = `
		<section class="card">
			<div class="row">
				<h1>Snow SSE Client M5</h1>
				<button id="logoutBtn" type="button">登出</button>
			</div>
			<div class="row server-form-row">
				<button id="refreshServersBtn" type="button">刷新服务</button>
				<input id="serverWorkDirInput" type="text" list="workDirPresetList" placeholder="workDir" value="${escapeHtml(
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
				}>保存路径</button>
			</div>
			<div class="row server-tabs">${
				serverTabButtons || '<span class="hint">暂无服务端</span>'
			}</div>
			<div class="row">
				<button id="reconnectBtn" type="button" ${
					state.control.actionLoading || !state.control.selectedServerId
						? 'disabled'
						: ''
				}>重连</button>
				<button id="closeServerBtn" type="button" ${
					state.control.actionLoading || !state.control.selectedServerId
						? 'disabled'
						: ''
				}>关闭</button>
				<span class="hint">连接状态: ${escapeHtml(state.connection.status)}</span>
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
				</div>
				<div class="row quick-switch-row">
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
					<button id="applyProfileBtn" type="button">切换渠道</button>
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
				<pre class="log-item">${escapeHtml(logDetailJson)}</pre>
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
		quickProfileSelect.value = state.chat.quickSwitch?.profile ?? '';
	}
	byId('quickProfileSelect')?.addEventListener('change', event => {
		const target = /** @type {HTMLSelectElement|null} */ (event.currentTarget);
		actions.updateQuickSwitchField('profile', target?.value ?? '');
	});
	byId('applyProfileBtn')?.addEventListener('click', () => {
		void actions.applyQuickSwitch('profile');
	});
	byId('sendBtn')?.addEventListener('click', () => {
		state.chat.ui.chatAutoScrollEnabled = true;
		void actions.sendChat();
	});
	byId('refreshSessionsBtn')?.addEventListener('click', () => {
		void actions.refreshSessionList();
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
	if (chatMessageList) {
		chatMessageList.addEventListener('scroll', () => {
			state.chat.ui.chatAutoScrollEnabled =
				isChatListNearBottom(chatMessageList);
		});
		if (state.chat.ui.chatAutoScrollEnabled) {
			chatMessageList.scrollTop = chatMessageList.scrollHeight;
		}
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
		'[data-action="toggle-sub-agent"]',
	)) {
		item.addEventListener('click', event => {
			const target = event.currentTarget;
			const nodeId = target?.getAttribute('data-node-id') ?? '';
			actions.toggleSubAgentNode(nodeId);
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
}
