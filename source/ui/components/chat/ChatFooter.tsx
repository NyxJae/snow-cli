import React, {useState, useEffect, Suspense, lazy} from 'react';
import {Box, Text} from 'ink';
import Spinner from 'ink-spinner';
import ChatInput from './ChatInput.js';
import StatusLine from '../common/StatusLine.js';
import {useI18n} from '../../../i18n/I18nContext.js';
import type {Message} from './MessageList.js';
import {BackgroundProcessPanel} from '../bash/BackgroundProcessPanel.js';
import type {BackgroundProcess} from '../../../hooks/execution/useBackgroundProcesses.js';
import TodoTree from '../special/TodoTree.js';
import type {TodoItem} from '../../../mcp/types/todo.types.js';
import {sessionManager} from '../../../utils/session/sessionManager.js';
import {todoEvents} from '../../../utils/events/todoEvents.js';

const ReviewCommitPanel = lazy(() => import('../panels/ReviewCommitPanel.js'));
import type {ReviewCommitSelection} from '../panels/ReviewCommitPanel.js';

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
					/>

					<Box marginTop={1}>
						<TodoTree todos={todos} />
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
