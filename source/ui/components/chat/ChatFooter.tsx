import React, {
	useState,
	useEffect,
	useRef,
	useMemo,
	Suspense,
	lazy,
} from 'react';
import {Box, Text} from 'ink';
import Spinner from 'ink-spinner';
import ChatInput from './ChatInput.js';
import StatusLine from '../common/StatusLine.js';
import {useI18n} from '../../../i18n/I18nContext.js';
import type {Message} from './MessageList.js';
import {BackgroundProcessPanel} from '../bash/BackgroundProcessPanel.js';
import type {BackgroundProcess} from '../../../hooks/execution/useBackgroundProcesses.js';
import TodoTree from '../special/TodoTree.js';
import {buildTodoTree, flattenTree} from '../special/TodoTree.js';
import type {TodoItem} from '../../../mcp/types/todo.types.js';
import {sessionManager} from '../../../utils/session/sessionManager.js';
import {todoEvents} from '../../../utils/events/todoEvents.js';

const ReviewCommitPanel = lazy(() => import('../panels/ReviewCommitPanel.js'));
import type {ReviewCommitSelection} from '../panels/ReviewCommitPanel.js';

// TODO 滚动相关常量
const AUTO_SCROLL_DELAY_MS = 7000; // 自动滚动延迟（毫秒）
const AUTO_SCROLL_CHECK_INTERVAL_MS = 1000; // 自动滚动检查间隔（毫秒）
const MAX_VISIBLE_TODOS = 5; // 最大可见 TODO 数量

type ChatFooterProps = {
	onSubmit: (
		text: string,
		images?: Array<{data: string; mimeType: string}>,
	) => Promise<void>;
	onCommand: (commandName: string, result: any) => Promise<void>;
	onHistorySelect: (
		selectedIndex: number,
		message: string,
		images?: Array<{type: 'image'; data: string; mimeType: string}>,
	) => Promise<void>;
	onSwitchProfile: () => void;
	handleProfileSelect: (profileName: string) => void;
	handleHistorySelect: (
		selectedIndex: number,
		message: string,
		images?: Array<{type: 'image'; data: string; mimeType: string}>,
	) => Promise<void>;

	// Review commit panel props
	showReviewCommitPanel: boolean;
	setShowReviewCommitPanel: React.Dispatch<React.SetStateAction<boolean>>;
	onReviewCommitConfirm: (
		selection: ReviewCommitSelection[],
		notes: string,
	) => void | Promise<void>;

	disabled: boolean;
	isStopping: boolean;
	isProcessing: boolean;
	chatHistory: Message[];
	yoloMode: boolean;
	setYoloMode: (value: boolean) => void;
	currentAgentName: string;
	contextUsage?: {
		inputTokens: number;
		maxContextTokens: number;
		cacheCreationTokens?: number;
		cacheReadTokens?: number;
		cachedTokens?: number;
	};
	initialContent: {
		text: string;
		images?: Array<{type: 'image'; data: string; mimeType: string}>;
	} | null;
	onContextPercentageChange: (percentage: number) => void;
	showProfilePicker: boolean;
	setShowProfilePicker: (value: boolean | ((prev: boolean) => boolean)) => void;
	profileSelectedIndex: number;
	setProfileSelectedIndex: (index: number | ((prev: number) => number)) => void;
	getFilteredProfiles: () => any[];
	profileSearchQuery: string;
	setProfileSearchQuery: (query: string) => void;
	// Main agent picker props
	showMainAgentPicker?: boolean;
	setShowMainAgentPicker?: (
		value: boolean | ((prev: boolean) => boolean),
	) => void;
	mainAgentSelectedIndex?: number;
	setMainAgentSelectedIndex?: (
		index: number | ((prev: number) => number),
	) => void;
	mainAgentSearchQuery?: string;
	setMainAgentSearchQuery?: (query: string) => void;
	getFilteredMainAgents?: () => Array<{
		id: string;
		name: string;
		description: string;
		isActive: boolean;
		isBuiltin: boolean;
	}>;
	onSwitchMainAgent?: () => void;
	onMainAgentSelect?: (agentId: string) => void;
	vscodeConnectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
	editorContext?: {
		activeFile?: string;
		selectedText?: string;
		cursorPosition?: {line: number; character: number};
		workspaceFolder?: string;
	};
	codebaseIndexing: boolean;
	codebaseProgress: {
		totalFiles: number;
		processedFiles: number;
		totalChunks: number;
		currentFile: string;
		status: string;
		error?: string;
	} | null;
	watcherEnabled: boolean;
	fileUpdateNotification: {file: string; timestamp: number} | null;
	currentProfileName: string;
	isCompressing: boolean;
	compressionError: string | null;

	// Background process panel props
	backgroundProcesses: BackgroundProcess[];
	showBackgroundPanel: boolean;
	selectedProcessIndex: number;
	terminalWidth: number;
};

export default function ChatFooter(props: ChatFooterProps) {
	const {t} = useI18n();
	const [todos, setTodos] = useState<TodoItem[]>([]);
	const [todoScrollOffset, setTodoScrollOffset] = useState<number>(0);
	const userLastScrollTime = useRef<number>(Date.now());

	// 缓存树状结构和扁平化列表，避免重复计算
	const treeNodes = useMemo(() => buildTodoTree(todos), [todos]);
	const flattenedTodos = useMemo(() => flattenTree(treeNodes), [treeNodes]);

	// 使用事件监听 TODO 更新，替代轮询
	useEffect(() => {
		const handleTodoUpdate = (data: {sessionId: string; todos: TodoItem[]}) => {
			// 动态获取当前会话，确保恢复会话后能正确处理
			const currentSession = sessionManager.getCurrentSession();
			// 如果没有当前会话，清空 TODO 显示（/clear 后的情况）
			if (!currentSession) {
				setTodos([]);
				return;
			}
			// 只处理当前会话的 TODO 更新
			if (data.sessionId === currentSession.id) {
				setTodos(data.todos);
			}
		};

		// 监听 TODO 更新事件
		todoEvents.onTodoUpdate(handleTodoUpdate);

		// 清理监听器
		return () => {
			todoEvents.offTodoUpdate(handleTodoUpdate);
		};
	}, []);

	// 自动滚动定时器
	useEffect(() => {
		// 自动滚动定时器 - 每秒检查一次
		const timer = setInterval(() => {
			// 检查用户最近是否操作过
			const timeSinceLastScroll = Date.now() - userLastScrollTime.current;
			if (timeSinceLastScroll < AUTO_SCROLL_DELAY_MS) {
				return; // 用户最近操作过，不自动滚动
			}

			// 不操作后自动滚动到默认位置
			if (flattenedTodos.length === 0) {
				setTodoScrollOffset(0);
				return;
			}

			// 计算第一条未完成的索引
			const firstPendingIndex = flattenedTodos.findIndex(
				t => t.status !== 'completed',
			);
			let targetOffset = 0;

			if (firstPendingIndex === -1) {
				// 全部已完成：显示最后几条
				targetOffset = Math.max(0, flattenedTodos.length - MAX_VISIBLE_TODOS);
			} else if (firstPendingIndex > 0) {
				// 第一条未完成不是第一条：确保第一条未完成可见
				targetOffset = Math.max(0, firstPendingIndex - 1);
			}
			// 否则 firstPendingIndex === 0，从第一条开始显示

			// 确保不超过边界
			const maxOffset = Math.max(0, flattenedTodos.length - MAX_VISIBLE_TODOS);
			targetOffset = Math.min(targetOffset, maxOffset);

			setTodoScrollOffset(targetOffset);

			// 更新 userLastScrollTime，避免重复自动滚动
			userLastScrollTime.current = Date.now();
		}, AUTO_SCROLL_CHECK_INTERVAL_MS);

		return () => clearInterval(timer);
	}, [flattenedTodos]); // 依赖 flattenedTodos，当列表变化时重置定时器

	// 滚动处理函数
	const handleTodoScrollUp = () => {
		if (flattenedTodos.length <= MAX_VISIBLE_TODOS) return;
		const newOffset = Math.max(0, todoScrollOffset - 1);
		setTodoScrollOffset(newOffset);
		userLastScrollTime.current = Date.now();
	};

	const handleTodoScrollDown = () => {
		if (flattenedTodos.length <= MAX_VISIBLE_TODOS) return;
		const maxOffset = Math.max(0, flattenedTodos.length - MAX_VISIBLE_TODOS);
		const newOffset = Math.min(todoScrollOffset + 1, maxOffset);
		setTodoScrollOffset(newOffset);
		userLastScrollTime.current = Date.now();
	};

	return (
		<>
			{!props.showReviewCommitPanel && (
				<>
					<ChatInput
						onSubmit={props.onSubmit}
						onCommand={props.onCommand}
						placeholder={t.chatScreen.inputPlaceholder}
						disabled={props.disabled}
						disableKeyboardNavigation={props.showBackgroundPanel}
						isProcessing={props.isProcessing}
						chatHistory={props.chatHistory}
						onHistorySelect={props.handleHistorySelect}
						yoloMode={props.yoloMode}
						setYoloMode={props.setYoloMode}
						contextUsage={props.contextUsage}
						initialContent={props.initialContent}
						onContextPercentageChange={props.onContextPercentageChange}
						showProfilePicker={props.showProfilePicker}
						setShowProfilePicker={props.setShowProfilePicker}
						profileSelectedIndex={props.profileSelectedIndex}
						setProfileSelectedIndex={props.setProfileSelectedIndex}
						getFilteredProfiles={props.getFilteredProfiles}
						handleProfileSelect={props.handleProfileSelect}
						onSwitchProfile={props.onSwitchProfile}
						profileSearchQuery={props.profileSearchQuery}
						setProfileSearchQuery={props.setProfileSearchQuery}
						showMainAgentPicker={props.showMainAgentPicker}
						setShowMainAgentPicker={props.setShowMainAgentPicker}
						mainAgentSelectedIndex={props.mainAgentSelectedIndex}
						setMainAgentSelectedIndex={props.setMainAgentSelectedIndex}
						mainAgentSearchQuery={props.mainAgentSearchQuery}
						setMainAgentSearchQuery={props.setMainAgentSearchQuery}
						getFilteredMainAgents={props.getFilteredMainAgents}
						onSwitchMainAgent={props.onSwitchMainAgent}
						onMainAgentSelect={props.onMainAgentSelect}
						onTodoScrollUp={handleTodoScrollUp}
						onTodoScrollDown={handleTodoScrollDown}
					/>

					<Box marginTop={1}>
						<TodoTree todos={todos} scrollOffset={todoScrollOffset} />
					</Box>

					<StatusLine
						yoloMode={props.yoloMode}
						currentAgentName={props.currentAgentName}
						vscodeConnectionStatus={props.vscodeConnectionStatus}
						editorContext={props.editorContext}
						contextUsage={props.contextUsage}
						codebaseIndexing={props.codebaseIndexing}
						codebaseProgress={props.codebaseProgress}
						watcherEnabled={props.watcherEnabled}
						fileUpdateNotification={props.fileUpdateNotification}
						currentProfileName={props.currentProfileName}
					/>

					{props.isCompressing && (
						<Box marginTop={1}>
							<Text color="cyan">
								<Spinner type="dots" /> {t.chatScreen.compressionInProgress}
							</Text>
						</Box>
					)}

					{props.compressionError && (
						<Box marginTop={1}>
							<Text color="red">
								{t.chatScreen.compressionFailed.replace(
									'{error}',
									props.compressionError,
								)}
							</Text>
						</Box>
					)}

					{props.showBackgroundPanel && (
						<BackgroundProcessPanel
							processes={props.backgroundProcesses}
							selectedIndex={props.selectedProcessIndex}
							terminalWidth={props.terminalWidth}
						/>
					)}
				</>
			)}

			{props.showReviewCommitPanel && (
				<Box marginTop={1}>
					<Suspense
						fallback={
							<Box>
								<Text>
									<Spinner type="dots" /> Loading...
								</Text>
							</Box>
						}
					>
						<ReviewCommitPanel
							visible={props.showReviewCommitPanel}
							onClose={() => props.setShowReviewCommitPanel(false)}
							onConfirm={props.onReviewCommitConfirm}
							maxHeight={6}
						/>
					</Suspense>
				</Box>
			)}
		</>
	);
}
