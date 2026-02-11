/**
 * Token 估算工具.
 *
 * 用途: 当上游 provider 不返回 usage,或返回明显不合理的 usage(例如 prompt_tokens 极小)时,
 * 用本地估算结果兜底,用于 UI 的上下文占用显示与自动压缩启发式判断.
 *
 * 注意:
 * - 仅为近似值,不用于计费.
 * - 我们会截断特别长的字符串字段(例如 base64 图片),避免 stringify/encode 产生巨大开销.
 */

import {encoding_for_model} from 'tiktoken';

// 默认使用 gpt-5,因为本项目主要以 gpt-5 运行.
// 若 tiktoken 暂不识别该模型名,estimateTokenCount() 会自动降级到字符数估算.
const DEFAULT_MODEL_FOR_ESTIMATE = 'gpt-5';
const DEFAULT_MAX_STRING_LENGTH = 2000;

/**
 * JSON.stringify + 截断.
 *
 * 目的: 避免把 base64 图片/大日志等超长字段完整纳入估算,导致内存或 CPU 开销过高.
 */
export function stringifyForTokenEstimate(
	value: any,
	maxStringLength: number = DEFAULT_MAX_STRING_LENGTH,
): string {
	return JSON.stringify(value, (_key, v) => {
		if (typeof v === 'string' && v.length > maxStringLength) {
			return v.slice(0, maxStringLength) + '...[truncated]';
		}
		return v;
	});
}

/**
 * 估算文本 token 数.
 *
 * 优先使用 tiktoken;若失败则按 1 token ~= 4 chars 粗略估算.
 */
export async function estimateTokenCount(
	text: string,
	model: string = DEFAULT_MODEL_FOR_ESTIMATE,
): Promise<number> {
	if (!text) return 0;

	try {
		// tiktoken 的 encoding_for_model() 类型联合可能暂未包含新模型名(例如 gpt-5).
		// 这里做一次 cast 以保留运行时行为;若运行时仍不支持,会进入 catch 降级估算.
		const encoder = encoding_for_model(model as any);
		try {
			return encoder.encode(text).length;
		} finally {
			encoder.free();
		}
	} catch {
		// Fallback estimate
		return Math.ceil(text.length / 4);
	}
}
