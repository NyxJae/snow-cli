import {byId, escapeHtml} from './utils.js';

/**
 * 切换弹窗显示状态.
 * @param {string} modalId 弹窗ID.
 * @param {boolean} visible 是否显示.
 */
function toggleModal(modalId, visible) {
	const modal = byId(modalId);
	if (!modal) {
		return;
	}
	modal.classList.toggle('hidden', !visible);
	modal.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

/**
 * 解析工具参数文本,避免非JSON导致弹窗渲染失败.
 * @param {string | undefined} rawArgs 原始参数.
 * @returns {string}
 */
function formatToolArgs(rawArgs) {
	if (!rawArgs) {
		return '-';
	}
	try {
		return JSON.stringify(JSON.parse(rawArgs), null, 2);
	} catch {
		return rawArgs;
	}
}

/**
 * 显示工具审批弹窗.
 * @param {{requestId:string,data:any}} event SSE事件.
 * @param {(type:'tool_confirmation_response'|'user_question_response',requestId:string,response:any)=>Promise<void>} sendResponse 响应回传函数.
 */
export function showToolConfirmationDialog(event, sendResponse) {
	const body = byId('toolConfirmationBody');
	const footer = byId('toolConfirmationFooter');
	if (!body || !footer) {
		return;
	}

	const {
		toolCall,
		batchToolNames,
		isSensitive,
		sensitiveInfo,
		availableOptions,
	} = event.data ?? {};
	const toolName = toolCall?.function?.name ?? 'unknown';
	const argsText = formatToolArgs(toolCall?.function?.arguments);
	const optionList = Array.isArray(availableOptions) ? availableOptions : [];

	let html = '';
	if (isSensitive && sensitiveInfo) {
		html += `<div class="session-row selected">
			<div class="session-main">
				<div class="session-title">敏感命令警告</div>
				<div class="hint">模式: ${escapeHtml(sensitiveInfo.pattern ?? '-')}</div>
				<div class="hint">说明: ${escapeHtml(sensitiveInfo.description ?? '-')}</div>
			</div>
		</div>`;
	}
	html += `<div class="session-row">
		<div class="session-main">
			<div class="session-title">工具名称: ${escapeHtml(toolName)}</div>
			<div class="hint">批量工具: ${escapeHtml(batchToolNames ?? '-')}</div>
			<pre class="log-item">${escapeHtml(argsText)}</pre>
		</div>
	</div>`;
	body.innerHTML = html;

	footer.innerHTML = '';
	for (const option of optionList) {
		const button = document.createElement('button');
		button.type = 'button';
		button.textContent = option?.label ?? String(option?.value ?? '确认');
		button.onclick = async () => {
			toggleModal('toolConfirmationModal', false);
			if (option?.value === 'reject_with_reply') {
				const reason = window.prompt('请输入拒绝理由:') ?? '';
				await sendResponse('tool_confirmation_response', event.requestId, {
					type: 'reject_with_reply',
					reason,
				});
				return;
			}
			await sendResponse(
				'tool_confirmation_response',
				event.requestId,
				option?.value ?? 'approve',
			);
		};
		footer.appendChild(button);
	}

	toggleModal('toolConfirmationModal', true);
}

/**
 * 显示用户提问弹窗.
 * @param {{requestId:string,data:any}} event SSE事件.
 * @param {(type:'tool_confirmation_response'|'user_question_response',requestId:string,response:any)=>Promise<void>} sendResponse 响应回传函数.
 */
export function showUserQuestionDialog(event, sendResponse) {
	const title = byId('userQuestionTitle');
	const body = byId('userQuestionBody');
	const footer = byId('userQuestionFooter');
	if (!title || !body || !footer) {
		return;
	}

	const {question, options, multiSelect} = event.data ?? {};
	title.textContent = question ?? '问题确认';

	const normalizedOptions = Array.isArray(options) ? options : [];
	const inputType = multiSelect ? 'checkbox' : 'radio';
	let html = '';
	if (normalizedOptions.length > 0) {
		normalizedOptions.forEach((option, index) => {
			html += `<div class="session-row">
				<label class="row" style="flex:1;align-items:center;gap:8px;">
					<input type="${inputType}" name="userOption" data-option-index="${index}" />
					<span>${escapeHtml(option)}</span>
				</label>
				<input type="text" class="chat-input" data-option-edit-index="${index}" value="${escapeHtml(
				option,
			)}" placeholder="编辑该选项" />
			</div>`;
		});
	}
	html +=
		'<textarea id="customInput" class="chat-input" placeholder="或输入自定义内容"></textarea>';
	body.innerHTML = html;

	footer.innerHTML = '';
	const cancelButton = document.createElement('button');
	cancelButton.type = 'button';
	cancelButton.textContent = '取消';
	cancelButton.onclick = async () => {
		toggleModal('userQuestionModal', false);
		await sendResponse('user_question_response', event.requestId, {
			selected: '',
			cancelled: true,
		});
	};
	footer.appendChild(cancelButton);

	const confirmButton = document.createElement('button');
	confirmButton.type = 'button';
	confirmButton.textContent = '确定';
	confirmButton.onclick = async () => {
		toggleModal('userQuestionModal', false);
		const customInput = (byId('customInput')?.value ?? '').trim();
		if (customInput) {
			await sendResponse('user_question_response', event.requestId, {
				selected: multiSelect ? [customInput] : customInput,
				customInput,
			});
			return;
		}

		const selectedInputs = Array.from(
			document.querySelectorAll('input[name="userOption"]:checked'),
		);
		const selectedValues = selectedInputs.map(item => {
			const optionIndex = item.getAttribute('data-option-index') ?? '';
			const editedInput = document.querySelector(
				`input[data-option-edit-index="${optionIndex}"]`,
			);
			const editedValue = editedInput?.value?.trim() ?? '';
			return editedValue || normalizedOptions[Number(optionIndex)] || '';
		});
		if (multiSelect) {
			await sendResponse('user_question_response', event.requestId, {
				selected: selectedValues,
			});
			return;
		}
		await sendResponse('user_question_response', event.requestId, {
			selected: selectedValues[0] ?? '',
		});
	};
	footer.appendChild(confirmButton);

	toggleModal('userQuestionModal', true);
}
