import {useCallback, useEffect, useRef, useState} from 'react';
import type {Message} from '../../components/chat/MessageList.js';
import type {HookErrorDetails} from '../../../utils/execution/hookResultHandler.js';
import type {CompressionStatus} from '../../components/compression/CompressionStatus.js';
import type {
	BashSensitiveCommandState,
	CustomCommandExecutionState,
	DraftContent,
	PendingMessageInput,
	PendingUserQuestionResult,
	PendingUserQuestionState,
	RestoreInputContent,
} from './types.js';

export function useChatScreenLocalState() {
	const [messages, setMessages] = useState<Message[]>([]);
	const [isSaving] = useState(false);
	const [pendingMessages, setPendingMessages] = useState<PendingMessageInput[]>(
		[],
	);
	const pendingMessagesRef = useRef<PendingMessageInput[]>([]);
	const userInterruptedRef = useRef(false);
	const [remountKey, setRemountKey] = useState(0);
	const [currentContextPercentage, setCurrentContextPercentage] = useState(0);
	const currentContextPercentageRef = useRef(0);
	const [isExecutingTerminalCommand, setIsExecutingTerminalCommand] =
		useState(false);
	const [customCommandExecution, setCustomCommandExecution] =
		useState<CustomCommandExecutionState>(null);
	const [isCompressing, setIsCompressing] = useState(false);
	const [compressionError, setCompressionError] = useState<string | null>(null);
	const [showPermissionsPanel, setShowPermissionsPanel] = useState(false);
	const [restoreInputContent, setRestoreInputContent] =
		useState<RestoreInputContent>(null);
	const [inputDraftContent, setInputDraftContent] =
		useState<DraftContent>(null);
	const [bashSensitiveCommand, setBashSensitiveCommand] =
		useState<BashSensitiveCommandState>(null);
	const [suppressLoadingIndicator, setSuppressLoadingIndicator] =
		useState(false);
	const hadBashSensitiveCommandRef = useRef(false);
	const [hookError, setHookError] = useState<HookErrorDetails | null>(null);
	const [pendingUserQuestion, setPendingUserQuestion] =
		useState<PendingUserQuestionState>(null);
	const pendingUserQuestionRef = useRef<PendingUserQuestionState>(null);
	const pendingUserQuestionQueueRef = useRef<
		Array<Exclude<PendingUserQuestionState, null>>
	>([]);
	// 仅用于 askuser 交互队列: 当用户在提问界面选择了"取消"(或 Esc),需要清空后续队列,避免遗留弹窗.
	// 注意: 这里不要复用全局 userInterruptedRef,因为它也可能被其他中断场景设置,会误清队列导致后续问题不弹出.
	const shouldClearPendingUserQuestionQueueRef = useRef(false);
	const [compressionStatus, setCompressionStatus] =
		useState<CompressionStatus | null>(null);

	useEffect(() => {
		pendingUserQuestionRef.current = pendingUserQuestion;
	}, [pendingUserQuestion]);

	useEffect(() => {
		// 当用户问题被回答后,若队列中还有待回答问题,则继续展示下一个
		if (pendingUserQuestion) {
			return;
		}

		// 用户在提问界面取消(或 Esc)会触发 abort,此时清空队列避免遗留弹窗
		if (shouldClearPendingUserQuestionQueueRef.current) {
			shouldClearPendingUserQuestionQueueRef.current = false;
			pendingUserQuestionQueueRef.current = [];
			return;
		}

		const next = pendingUserQuestionQueueRef.current.shift();
		if (next) {
			pendingUserQuestionRef.current = next;
			setPendingUserQuestion(next);
		}
	}, [pendingUserQuestion]);

	useEffect(() => {
		currentContextPercentageRef.current = currentContextPercentage;
	}, [currentContextPercentage]);

	useEffect(() => {
		pendingMessagesRef.current = pendingMessages;
	}, [pendingMessages]);

	useEffect(() => {
		const hasPanel = !!bashSensitiveCommand;
		const hadPanel = hadBashSensitiveCommandRef.current;
		hadBashSensitiveCommandRef.current = hasPanel;

		if (hasPanel) {
			setSuppressLoadingIndicator(true);
			return undefined;
		}

		if (hadPanel && !hasPanel) {
			setSuppressLoadingIndicator(true);
			const timer = setTimeout(() => {
				setSuppressLoadingIndicator(false);
			}, 120);
			return () => clearTimeout(timer);
		}

		return undefined;
	}, [bashSensitiveCommand]);

	useEffect(() => {
		if (restoreInputContent !== null) {
			const timer = setTimeout(() => {
				setRestoreInputContent(null);
			}, 100);
			return () => clearTimeout(timer);
		}

		return undefined;
	}, [restoreInputContent]);

	const requestUserQuestion = useCallback(
		async (
			question: string,
			options: string[],
			toolCall: any,
			multiSelect?: boolean,
		): Promise<PendingUserQuestionResult> => {
			return new Promise(resolve => {
				const wrappedResolve = (result: PendingUserQuestionResult) => {
					if (result?.cancelled) {
						shouldClearPendingUserQuestionQueueRef.current = true;
					}
					resolve(result);
				};

				const newQuestion = {
					question,
					options,
					toolCall,
					multiSelect,
					resolve: wrappedResolve,
				};

				// UI 侧 askuser 交互资源唯一: 若当前已有待回答问题(含本 tick 已安排的问题),则进入队列
				// 这样可避免并行子代理同时 askuser 时后来的问题覆盖前一个问题,导致丢弹窗/卡死
				if (pendingUserQuestionRef.current) {
					pendingUserQuestionQueueRef.current.push(newQuestion);
					return;
				}

				pendingUserQuestionRef.current = newQuestion;
				setPendingUserQuestion(newQuestion);
			});
		},
		[],
	);

	return {
		messages,
		setMessages,
		isSaving,
		pendingMessages,
		setPendingMessages,
		pendingMessagesRef,
		userInterruptedRef,
		remountKey,
		setRemountKey,
		currentContextPercentage,
		setCurrentContextPercentage,
		currentContextPercentageRef,
		isExecutingTerminalCommand,
		setIsExecutingTerminalCommand,
		customCommandExecution,
		setCustomCommandExecution,
		isCompressing,
		setIsCompressing,
		compressionError,
		setCompressionError,
		showPermissionsPanel,
		setShowPermissionsPanel,
		restoreInputContent,
		setRestoreInputContent,
		inputDraftContent,
		setInputDraftContent,
		bashSensitiveCommand,
		setBashSensitiveCommand,
		suppressLoadingIndicator,
		setSuppressLoadingIndicator,
		hookError,
		setHookError,
		pendingUserQuestion,
		setPendingUserQuestion,
		requestUserQuestion,
		compressionStatus,
		setCompressionStatus,
	};
}
