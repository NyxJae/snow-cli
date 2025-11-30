/**
 * 空回复检测工具
 * 用于检测和处理空回复，确保 agent 工作循环能够正确重试
 */

/**
 * 检测回复是否为空
 * @param content 回复内容
 * @returns 是否为空回复
 */
export function isEmptyResponse(content: string): boolean {
  if (!content) return true;
  
  const trimmed = content.trim();
  
  // 检查纯空白字符
  if (!trimmed) return true;
  
  // 检查常见的空回复模式
  const emptyPatterns = [
    /^[\s\n\r]*$/, // 只有空白字符
    /^(I understand|Understood|Got it|Okay)[\s\n\r]*$/i, // 简单确认
    /^(I have no response|I don't know|No response)[\s\n\r]*$/i, // 明确表示无回复
    /^(Please provide|Please specify|Need more information)[\s\n\r]*$/i, // 请求更多信息
  ];
  
  return emptyPatterns.some(pattern => pattern.test(trimmed));
}

/**
 * 创建空回复错误对象
 * @param content 原始内容
 * @returns 格式化的错误对象
 */
export function createEmptyResponseError(content: string): Error & { code: string; isRetryable: boolean } {
  const error = new Error(
    `Empty or insufficient response detected: "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`
  ) as Error & { code: string; isRetryable: boolean };
  
  error.code = 'EMPTY_RESPONSE';
  error.isRetryable = true;
  
  return error;
}

/**
 * 检测工具调用是否为空
 * @param toolCalls 工具调用数组
 * @returns 是否为空工具调用
 */
export function isEmptyToolCalls(toolCalls: any[]): boolean {
  if (!toolCalls || toolCalls.length === 0) return true;
  
  // 检查是否所有工具调用都是无效的
  return toolCalls.every(call => 
    !call.function || 
    !call.function.name || 
    call.function.name.trim() === ''
  );
}

/**
 * 综合检测回复和工具调用是否都为空
 * @param content 文本内容
 * @param toolCalls 工具调用数组
 * @returns 是否为空回复和空工具调用
 */
export function isEmptyResponseWithTools(content: string, toolCalls: any[]): boolean {
  return isEmptyResponse(content) && isEmptyToolCalls(toolCalls);
}