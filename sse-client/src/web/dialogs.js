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

	const normalizedOptions = Array.isArray(options)
		? options.map(o => String(o ?? ''))
		: [];
	const inputType = multiSelect ? 'checkbox' : 'radio';
	let html = '';
	if (normalizedOptions.length > 0) {
		normalizedOptions.forEach((option, index) => {
			html += `<div class="uq-option" data-option-index="${index}">
				<div class="uq-option-main">
					<label class="uq-option-label">
						<input type="${inputType}" name="userOption" data-option-index="${index}" />
						<span class="uq-option-text">${escapeHtml(option)}</span>
					</label>
					<button type="button" class="uq-edit-btn" data-edit-toggle="${index}" title="编辑选项">✎</button>
				</div>
				<input type="text" class="uq-edit-input hidden" data-option-edit-index="${index}" value="${escapeHtml(
				option,
			)}" placeholder="编辑该选项" />
			</div>`;
		});
	}
	html +=
		'<textarea id="customInput" class="uq-custom-input" placeholder="或输入自定义内容"></textarea>';
	body.innerHTML = html;

	// 移除上一次绑定的 change 监听, 防止多次打开弹窗时叠加
	if (body._uqChangeHandler) {
		body.removeEventListener('change', body._uqChangeHandler);
	}
	// 选项选中时, 用 JS 切换 selected 类(避免 :has() 兼容性问题)
	const syncSelected = () => {
		body.querySelectorAll('.uq-option').forEach(opt => {
			const input = opt.querySelector('input[name="userOption"]');
			opt.classList.toggle('selected', !!input?.checked);
		});
	};
	body._uqChangeHandler = syncSelected;
	body.addEventListener('change', syncSelected);

	// 整行可点击: 点击选项卡片空白区域也能触发选中
	// label 内部点击由原生 label 行为处理, 无需代理(避免 checkbox 双重 toggle)
	body.querySelectorAll('.uq-option').forEach(opt => {
		opt.addEventListener('click', e => {
			if (e.target.closest('.uq-edit-btn, .uq-edit-input, .uq-option-label'))
				return;
			const input = opt.querySelector('input[name="userOption"]');
			if (input && e.target !== input) {
				if (input.type === 'checkbox') {
					input.checked = !input.checked;
				} else {
					input.checked = true;
				}
				input.dispatchEvent(new Event('change', {bubbles: true}));
			}
		});
	});

	// 初始同步选中状态(应对未来可能的默认选中/回填场景)
	syncSelected();

	// 编辑按钮: 折叠编辑框避免挤占选项布局导致弹窗溢出
	body.querySelectorAll('.uq-edit-btn').forEach(btn => {
		btn.addEventListener('click', () => {
			const idx = btn.getAttribute('data-edit-toggle');
			const editInput = body.querySelector(
				`input[data-option-edit-index="${idx}"]`,
			);
			if (editInput) {
				const isHidden = editInput.classList.toggle('hidden');
				btn.textContent = isHidden ? '✎' : '✕';
				if (!isHidden) {
					editInput.focus();
				}
			}
		});
	});

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
			body.querySelectorAll('input[name="userOption"]:checked'),
		);
		const selectedValues = selectedInputs.map(item => {
			const optionIndex = item.getAttribute('data-option-index') ?? '';
			const editedInput = body.querySelector(
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
