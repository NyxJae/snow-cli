/**
 * 需要用户交互时抛出的特殊错误.
 *
 * 设计目的:
 * - askuser-ask_question 不是一个"后台执行"的工具,它必须暂停当前工作流,等待用户在 TUI 中完成选择/输入.
 * - 执行层通过抛出本错误,把"需要 UI 出面"这件事显式传递给上层(例如 toolExecutor),由上层负责调度 UI 组件并收集答案.
 *
 * 字段约定:
 * - question: 提问文案.
 * - options: 选项列表(至少 2 项).
 * - toolCallId: 对应的 tool call id,用于把 UI 的回答回填到正确的工具调用.
 * - multiSelect: 是否允许多选.为 true 时 UI 允许勾选多个;为 false 时 UI 强制单选.
 */
export class UserInteractionNeededError extends Error {
	public readonly question: string;
	public readonly options: string[];
	public readonly toolCallId: string;
	public readonly multiSelect: boolean;

	constructor(
		question: string,
		options: string[],
		toolCallId: string = '',
		multiSelect: boolean = true,
	) {
		super('User interaction needed');
		this.name = 'UserInteractionNeededError';
		this.question = question;
		this.options = options;
		this.toolCallId = toolCallId;
		this.multiSelect = multiSelect;
	}
}

export interface UserInteractionResponse {
	selected: string | string[];
	customInput?: string;
	cancelled?: boolean;
}
