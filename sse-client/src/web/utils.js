/**
 * 获取DOM节点.
 * @param {string} id DOM id.
 * @returns {HTMLElement | null}
 */
export function byId(id) {
	return document.getElementById(id);
}

/**
 * HTML转义,避免日志与消息渲染注入.
 * @param {string} text 原始文本.
 * @returns {string}
 */
export function escapeHtml(text) {
	return String(text)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}
