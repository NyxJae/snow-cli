import {useStdout} from 'ink';
import {useCallback} from 'react';
import type {Message} from '../../ui/components/chat/MessageList.js';
import type {ChatMessage} from '../../api/types.js';
import type {CompressionStatus} from '../../ui/components/compression/CompressionStatus.js';
import {sessionManager} from '../../utils/session/sessionManager.js';
import {compressContext} from '../../utils/core/contextCompressor.js';
import {getTodoService} from '../../utils/execution/mcpToolsManager.js';
import {todoEvents} from '../../utils/events/todoEvents.js';
import {navigateTo} from '../integration/useGlobalNavigation.js';
import type {UsageInfo} from '../../api/chat.js';
import {resetTerminal} from '../../utils/execution/terminal.js';
import {getOpenAiConfig} from '../../utils/config/apiConfig.js';
import {
	showSaveDialog,
	isFileDialogSupported,
} from '../../utils/ui/fileDialog.js';
import {exportMessagesToFile} from '../../utils/session/chatExporter.js';
import {copyToClipboard} from '../../utils/core/clipboard.js';
import {useI18n} from '../../i18n/index.js';

/**
 * 执行上下文压缩
 * @param sessionId - 可选的会话ID，如果提供则使用该ID加载会话进行压缩
 * @param onStatusUpdate - 可选的状态更新回调，用于在UI中显示压缩进度
 * @returns 返回压缩后的UI消息列表和token使用信息，如果失败返回null
 */
export async function executeContextCompression(
	sessionId?: string,
	onStatusUpdate?: (status: CompressionStatus) => void,
): Promise<{
	uiMessages: Message[];
	usage?: UsageInfo;
	summary?: string;
	preservedMessages?: ChatMessage[];
	preservedMessageStartIndex?: number;
	hookFailed?: boolean;
	hookErrorDetails?: any;
} | null> {
	try {
		// 必须提供 sessionId 才能执行压缩,避免压缩错误的会话.
		if (!sessionId) {
			onStatusUpdate?.({
				step: 'skipped',
				message: '当前没有可用的会话ID',
			});
			return null;
		}

		// 压缩前先落盘当前会话,确保最近追加的消息(含 tool_calls)已持久化.
		// 否则 loadSession 可能读到旧数据,导致压缩后的会话缺失 tool_calls,引发对话不一致.
		onStatusUpdate?.({step: 'saving', sessionId});
		const currentSessionBeforeSave = sessionManager.getCurrentSession();
		if (currentSessionBeforeSave && currentSessionBeforeSave.id === sessionId) {
			await sessionManager.saveSession(currentSessionBeforeSave);
		}

		// 使用提供的 sessionId 加载会话(从文件读取,确保数据完整).
		onStatusUpdate?.({step: 'loading', sessionId});
		const currentSession = await sessionManager.loadSession(sessionId);

		if (!currentSession) {
			onStatusUpdate?.({
				step: 'failed',
				message: `加载会话失败: ${sessionId}`,
				sessionId,
			});
			return null;
		}

		if (currentSession.messages.length === 0) {
			onStatusUpdate?.({
				step: 'skipped',
				message: '当前会话没有可压缩的消息',
				sessionId,
			});
			return null;
		}

		// 使用会话文件中的消息进行压缩（这是真实的对话记录）
		const sessionMessages = currentSession.messages;

		// 转换为 ChatMessage 格式（保留所有关键字段）
		const chatMessages = sessionMessages.map(msg => ({
			role: msg.role,
			content: msg.content,
			tool_call_id: msg.tool_call_id,
			tool_calls: msg.tool_calls,
			images: msg.images,
			reasoning: msg.reasoning,
			thinking: msg.thinking, // 保留 thinking 字段（Anthropic Extended Thinking）
			subAgentInternal: msg.subAgentInternal,
		}));

		// 执行全量压缩,保留最后一轮完整对话,避免丢失当前任务上下文.
		onStatusUpdate?.({step: 'compressing', sessionId});
		const compressionResult = await compressContext(chatMessages);

		// 若返回 null,说明历史不足或无法保证压缩安全性,直接跳过.
		if (!compressionResult) {
			onStatusUpdate?.({
				step: 'skipped',
				message: '历史不足,无法安全压缩',
				sessionId,
			});
			return null;
		}

		// beforeCompress hook 若阻断,需要中止后续流程,避免在不满足约束时继续写入压缩会话.
		if (compressionResult.hookFailed) {
			onStatusUpdate?.({
				step: 'failed',
				message: '压缩被 beforeCompress hook 阻断',
				sessionId,
			});
			// 仅返回 hookFailed 标记,让上层中止 AI 流程.
			// 这里不返回 usage,避免 token 统计口径被影响.
			return {
				uiMessages: [],
				hookFailed: true,
				hookErrorDetails: compressionResult.hookErrorDetails,
			};
		}

		// 构建新的会话消息列表
		const newSessionMessages: Array<any> = [];

		// 构建单条user消息，将压缩摘要和保留的消息内容合并为文本
		// 这样避免了复杂的参数对齐问题（tool_calls、tool_call_id等）
		let finalContent = `[Context Summary from Previous Conversation]\n\n${compressionResult.summary}`;

		// 如果有保留的消息，将其内容转换为文本附加到user消息中
		if (
			compressionResult.preservedMessages &&
			compressionResult.preservedMessages.length > 0
		) {
			finalContent +=
				'\n\n---\n\n[Last Interaction - Preserved for Continuity]\n\n';

			for (const msg of compressionResult.preservedMessages) {
				if (msg.role === 'user') {
					finalContent += `**User:**\n${msg.content}\n\n`;
				} else if (msg.role === 'assistant') {
					finalContent += `**Assistant:**\n${msg.content}`;

					// 如果有tool_calls，以可读的JSON格式附加
					if (msg.tool_calls && msg.tool_calls.length > 0) {
						finalContent += '\n\n**[Tool Calls Initiated]:**\n```json\n';
						finalContent += JSON.stringify(msg.tool_calls, null, 2);
						finalContent += '\n```\n\n';
					} else {
						finalContent += '\n\n';
					}
				} else if (msg.role === 'tool') {
					// 工具执行结果
					finalContent += `**[Tool Result - ${msg.tool_call_id}]:**\n`;
					// 尝试格式化JSON，如果失败则直接显示原始内容
					try {
						const parsed = JSON.parse(msg.content);
						finalContent +=
							'```json\n' + JSON.stringify(parsed, null, 2) + '\n```\n\n';
					} catch {
						finalContent += `${msg.content}\n\n`;
					}
				}
			}
		}

		// 添加单条user消息
		newSessionMessages.push({
			role: 'user',
			content: finalContent,
			timestamp: Date.now(),
		});

		// 创建新会话而不是覆盖旧会话
		// 这样可以保留压缩前的完整历史，支持回滚到压缩前的任意快照点
		// skipEmptyTodo=true: 跳过自动创建空TODO，因为后面会继承原会话的TODO
		const compressedSession = await sessionManager.createNewSession(
			false,
			true,
		);

		// 设置新会话的消息
		compressedSession.messages = newSessionMessages;
		compressedSession.messageCount = newSessionMessages.length;
		compressedSession.updatedAt = Date.now();

		// 保留原会话的标题和摘要
		compressedSession.title = currentSession.title;
		compressedSession.summary = currentSession.summary;

		// 记录压缩关系
		compressedSession.compressedFrom = currentSession.id;
		compressedSession.compressedAt = Date.now();
		compressedSession.originalMessageIndex =
			compressionResult.preservedMessageStartIndex;

		// 保存新会话
		await sessionManager.saveSession(compressedSession);

		// 继承原会话的 TODO 列表到新会话
		try {
			const todoService = getTodoService();
			await todoService.copyTodoList(currentSession.id, compressedSession.id);
			onStatusUpdate?.({
				step: 'saving',
				message: `已从会话 ${currentSession.id} 继承 TODO 列表`,
				sessionId: compressedSession.id,
			});
		} catch (error) {
			// TODO 继承失败不应该影响压缩流程,记录日志即可.
			onStatusUpdate?.({
				step: 'skipped',
				message: 'TODO 列表继承失败',
				sessionId: compressedSession.id,
			});
		}

		// 压缩完成后需要从磁盘重新加载会话,确保内存中的会话对象与落盘数据完全一致.
		// 否则后续 saveMessage 可能仍指向旧会话文件,导致消息写入错误的会话.
		onStatusUpdate?.({
			step: 'loading',
			message: '正在从磁盘重新加载压缩后的会话...',
			sessionId: compressedSession.id,
		});
		const reloadedSession = await sessionManager.loadSession(
			compressedSession.id,
		);

		if (reloadedSession) {
			sessionManager.setCurrentSession(reloadedSession);
			onStatusUpdate?.({
				step: 'completed',
				message: '会话已重新加载并设为当前会话',
				sessionId: compressedSession.id,
			});
		} else {
			sessionManager.setCurrentSession(compressedSession);
			onStatusUpdate?.({
				step: 'completed',
				message: '重新加载失败,已回退使用内存版本',
				sessionId: compressedSession.id,
			});
		}

		// 新会话有独立的快照系统，不需要重映射旧会话的快照
		// 旧会话的快照保持不变，如果需要回滚到压缩前，可以切换回旧会话

		// 同步更新UI消息列表：从会话消息转换为UI Message格式
		const newUIMessages: Message[] = [];

		for (const sessionMsg of newSessionMessages) {
			// 跳过 tool 角色的消息（工具执行结果），避免UI显示大量JSON
			if (sessionMsg.role === 'tool') {
				continue;
			}

			const uiMessage: Message = {
				role: sessionMsg.role as any,
				content: sessionMsg.content,
				streaming: false,
			};

			// 如果有 tool_calls，显示工具调用信息（但不显示详细参数）
			if (sessionMsg.tool_calls && sessionMsg.tool_calls.length > 0) {
				// 在内容中添加简洁的工具调用摘要
				const toolSummary = sessionMsg.tool_calls
					.map((tc: any) => `[Tool: ${tc.function.name}]`)
					.join(', ');

				// 如果内容为空或很短，显示工具调用摘要
				if (!uiMessage.content || uiMessage.content.length < 10) {
					uiMessage.content = toolSummary;
				}
			}

			newUIMessages.push(uiMessage);
		}

		return {
			uiMessages: newUIMessages,
			usage: {
				prompt_tokens: compressionResult.usage.prompt_tokens,
				completion_tokens: compressionResult.usage.completion_tokens,
				total_tokens: compressionResult.usage.total_tokens,
			},
			summary: compressionResult.summary,
			preservedMessages: compressionResult.preservedMessages,
			preservedMessageStartIndex: compressionResult.preservedMessageStartIndex,
		};
	} catch (error) {
		onStatusUpdate?.({
			step: 'failed',
			message:
				error instanceof Error ? error.message : 'Context compression failed',
		});
		return null;
	}
}

type CommandHandlerOptions = {
	messages: Message[];
	setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
	setRemountKey: React.Dispatch<React.SetStateAction<number>>;
	clearSavedMessages: () => void;
	setIsCompressing: React.Dispatch<React.SetStateAction<boolean>>;
	setCompressionError: React.Dispatch<React.SetStateAction<string | null>>;
	setShowSessionPanel: React.Dispatch<React.SetStateAction<boolean>>;
	onResumeSessionById?: (sessionId: string) => Promise<void>;
	setShowConnectionPanel: React.Dispatch<React.SetStateAction<boolean>>;
	setConnectionPanelApiUrl: React.Dispatch<
		React.SetStateAction<string | undefined>
	>;
	setShowMcpPanel: React.Dispatch<React.SetStateAction<boolean>>;
	setMcpPanelSource: (source: 'chat' | 'mcpConfig') => void;
	onCompressionStatus?: (
		status:
			| import('../../ui/components/compression/CompressionStatus.js').CompressionStatus
			| null,
	) => void;

	setShowUsagePanel: React.Dispatch<React.SetStateAction<boolean>>;
	setShowModelsPanel: React.Dispatch<React.SetStateAction<boolean>>;
	setShowCustomCommandConfig: React.Dispatch<React.SetStateAction<boolean>>;
	setShowSkillsCreation: React.Dispatch<React.SetStateAction<boolean>>;
	setShowWorkingDirPanel: React.Dispatch<React.SetStateAction<boolean>>;
	setShowReviewCommitPanel: React.Dispatch<React.SetStateAction<boolean>>;
	setShowDiffReviewPanel: React.Dispatch<React.SetStateAction<boolean>>;
	setShowPermissionsPanel: React.Dispatch<React.SetStateAction<boolean>>;
	setShowBranchPanel: React.Dispatch<React.SetStateAction<boolean>>;
	setShowNewPromptPanel: React.Dispatch<React.SetStateAction<boolean>>;
	setShowTodoListPanel: React.Dispatch<React.SetStateAction<boolean>>;
	setShowBackgroundPanel: () => void;
	onSwitchProfile: () => void;
	setYoloMode: React.Dispatch<React.SetStateAction<boolean>>;
	setContextUsage: React.Dispatch<React.SetStateAction<UsageInfo | null>>;
	setCurrentContextPercentage: React.Dispatch<React.SetStateAction<number>>;
	currentContextPercentageRef: React.MutableRefObject<number>;
	setVscodeConnectionStatus: React.Dispatch<
		React.SetStateAction<'disconnected' | 'connecting' | 'connected' | 'error'>
	>;
	setIsExecutingTerminalCommand: React.Dispatch<React.SetStateAction<boolean>>;
	setCustomCommandExecution: React.Dispatch<
		React.SetStateAction<{
			commandName: string;
			command: string;
			isRunning: boolean;
			output: string[];
			exitCode?: number | null;
			error?: string;
		} | null>
	>;
	processMessage: (
		message: string,
		images?: Array<{data: string; mimeType: string}>,
		useBasicModel?: boolean,
		hideUserMessage?: boolean,
	) => Promise<void>;
	onQuit?: () => void;
	onReindexCodebase?: (force?: boolean) => Promise<void>;
	onToggleCodebase?: (mode?: string) => Promise<void>;
};

export function useCommandHandler(options: CommandHandlerOptions) {
	const {stdout} = useStdout();
	const {t} = useI18n();

	const handleCommandExecution = useCallback(
		async (commandName: string, result: any) => {
			// 处理 /compact: 触发上下文压缩并用压缩后的会话替换当前 UI 状态.
			if (
				commandName === 'compact' &&
				result.success &&
				result.action === 'compact'
			) {
				options.setIsCompressing(true);
				options.setCompressionError(null);

				try {
					// 获取当前会话ID
					const currentSession = sessionManager.getCurrentSession();
					if (!currentSession) {
						throw new Error('No active session to compress');
					}

					// 使用提取的压缩函数，传入当前会话ID和状态回调
					const compressionResult = await executeContextCompression(
						currentSession.id,
						status => {
							options.onCompressionStatus?.(status);
						},
					);

					if (!compressionResult) {
						throw new Error('Compression failed');
					}

					options.onCompressionStatus?.(null);

					// 压缩完成后需要主动清空压缩状态,否则状态行可能继续显示旧进度.
					// 更新UI
					options.clearSavedMessages();
					options.setMessages(compressionResult.uiMessages);
					options.setRemountKey(prev => prev + 1);

					// 使用压缩后的 prompt_tokens 重算上下文占用比例,保证统计与压缩后会话一致.
					if (compressionResult.usage) {
						const config = getOpenAiConfig();
						const maxTokens =
							config.maxContextTokens || config.maxTokens || 200000;
						const percentage = Math.min(
							100,
							Math.floor(
								(compressionResult.usage.prompt_tokens / maxTokens) * 100,
							),
						);
						options.setContextUsage({
							...compressionResult.usage,
							percentage,
							maxTokens,
						});
					}
				} catch (error) {
					// Show error message
					const errorMsg =
						error instanceof Error
							? error.message
							: 'Unknown compression error';
					options.onCompressionStatus?.({
						step: 'failed',
						message: errorMsg,
					});
					options.setCompressionError(errorMsg);

					const errorMessage: Message = {
						role: 'assistant',
						content: `**Compression Failed**\\n\\n${errorMsg}`,
						streaming: false,
					};
					options.setMessages(prev => [...prev, errorMessage]);
				} finally {
					options.setIsCompressing(false);
				}
				return;
			}

			// Handle /ide command
			if (commandName === 'ide') {
				if (result.success) {
					// 连接成功后立即更新状态,避免用户在轮询同步前感知延迟
					options.setVscodeConnectionStatus('connected');
					// 不追加command消息,避免消息区出现与连接状态无关的噪音
				} else {
					options.setVscodeConnectionStatus('error');
				}
				return;
			}

			if (result.success && result.action === 'clear') {
				// Execute onSessionStart hook BEFORE clearing session
				(async () => {
					try {
						const {unifiedHooksExecutor} = await import(
							'../../utils/execution/unifiedHooksExecutor.js'
						);
						const hookResult = await unifiedHooksExecutor.executeHooks(
							'onSessionStart',
							{
								messages: [],
								messageCount: 0,
							},
						);

						// Check for hook failures
						let shouldAbort = false;
						let warningMessage: string | null = null;
						if (!hookResult.success) {
							const commandError = hookResult.results.find(
								r => r.type === 'command' && !r.success,
							);

							if (commandError && commandError.type === 'command') {
								const {exitCode, command, output, error} = commandError;
								const combinedOutput =
									[output, error].filter(Boolean).join('\n\n') || '(no output)';

								if (exitCode === 1) {
									// exitCode=1 视为非阻断警告,延后展示以避免清屏逻辑打断用户阅读.
									warningMessage = `[WARN] onSessionStart hook warning:\nCommand: ${command}\nOutput: ${combinedOutput}`;
								} else if (exitCode >= 2 || exitCode < 0) {
									// exitCode>=2 或 exitCode<0 视为阻断错误,需要展示 hook 错误详情并中止后续清理,避免误清会话.
									const errorMessage: Message = {
										role: 'assistant',
										content: '', // Content will be rendered by HookErrorDisplay
										hookError: {
											type: 'error',
											exitCode,
											command,
											output,
											error,
										},
									};

									options.setMessages(prev => [...prev, errorMessage]);
									shouldAbort = true;
								}
							}
						}

						// hook 阻断失败时不清空会话,避免丢失用户上下文(同时保留错误信息供排查).
						if (shouldAbort) {
							return;
						}

						// hook 正常通过后再清理会话.
						resetTerminal(stdout);
						const currentSession = sessionManager.getCurrentSession();
						todoEvents.emitTodoUpdate(currentSession?.id ?? '', []);
						if (currentSession) {
							const {deleteReadFolders} = await import(
								'../../utils/core/folderNotebookPreprocessor.js'
							);
							await deleteReadFolders(
								currentSession.id,
								currentSession.projectId,
							);
						}
						sessionManager.clearCurrentSession();
						options.clearSavedMessages();
						options.setMessages([]);
						options.setRemountKey(prev => prev + 1);
						options.setContextUsage(null);
						options.setCurrentContextPercentage(0);

						// before useEffect syncs the state to ref
						options.currentContextPercentageRef.current = 0;

						// Add command message
						const commandMessage: Message = {
							role: 'command',
							content: '',
							commandName: commandName,
						};
						options.setMessages([commandMessage]);

						// Display warning AFTER clearing screen
						if (warningMessage) {
							console.log(warningMessage);
						}
					} catch (error) {
						console.error('Failed to execute onSessionStart hook:', error);
						// On exception, still clear session
						resetTerminal(stdout);
						const currentSession = sessionManager.getCurrentSession();
						if (currentSession) {
							try {
								await getTodoService().deleteTodoList(currentSession.id);
								todoEvents.emitTodoUpdate(currentSession.id, []);
							} catch (error) {
								console.warn('Failed to clear TODO list:', error);
							}
							const {deleteReadFolders} = await import(
								'../../utils/core/folderNotebookPreprocessor.js'
							);
							await deleteReadFolders(
								currentSession.id,
								currentSession.projectId,
							);
						}
						sessionManager.clearCurrentSession();
						options.clearSavedMessages();
						options.setMessages([]);
						options.setRemountKey(prev => prev + 1);
						options.setContextUsage(null);
						options.setCurrentContextPercentage(0);

						// before useEffect syncs the state to ref
						options.currentContextPercentageRef.current = 0;

						const commandMessage: Message = {
							role: 'command',
							content: '',
							commandName: commandName,
						};
						options.setMessages([commandMessage]);
					}
				})();
			} else if (result.success && result.action === 'showReviewCommitPanel') {
				options.setShowReviewCommitPanel(true);
				// 面板唤醒时不输出 command 消息；避免在用户确认选择前污染消息区
				// 真正开始 review 的摘要会在 onConfirm 后由 handleReviewCommitConfirm 输出
			} else if (
				result.success &&
				result.action === 'resume' &&
				result.sessionId
			) {
				if (options.onResumeSessionById) {
					await options.onResumeSessionById(result.sessionId);
				}
				const commandMessage: Message = {
					role: 'command',
					content: result.message || '',
					commandName: commandName,
				};
				options.setMessages(prev => [...prev, commandMessage]);
			} else if (result.success && result.action === 'showSessionPanel') {
				options.setShowSessionPanel(true);
				const commandMessage: Message = {
					role: 'command',
					content: '',
					commandName: commandName,
				};
				options.setMessages(prev => [...prev, commandMessage]);
			} else if (result.success && result.action === 'showDiffReviewPanel') {
				options.setShowDiffReviewPanel(true);
			} else if (result.success && result.action === 'showConnectionPanel') {
				options.setConnectionPanelApiUrl(result.apiUrl);
				options.setShowConnectionPanel(true);
			} else if (result.success && result.action === 'showMcpPanel') {
				// Set source before opening panel
				options.setMcpPanelSource('chat');
				options.setShowMcpPanel(true);
				const commandMessage: Message = {
					role: 'command',
					content: '',
					commandName: commandName,
				};
				options.setMessages(prev => [...prev, commandMessage]);
			} else if (result.success && result.action === 'showModelsPanel') {
				options.setShowModelsPanel(true);
				const commandMessage: Message = {
					role: 'command',
					content: '',
					commandName: commandName,
				};
				options.setMessages(prev => [...prev, commandMessage]);
			} else if (result.success && result.action === 'showBackgroundPanel') {
				options.setShowBackgroundPanel();
				const commandMessage: Message = {
					role: 'command',
					content: '',
					commandName: commandName,
				};
				options.setMessages(prev => [...prev, commandMessage]);
			} else if (result.success && result.action === 'showProfilePanel') {
				options.onSwitchProfile();
				// Don't add command message to keep UI clean
			} else if (result.success && result.action === 'home') {
				// Clear session BEFORE navigating to prevent stale session leaking into new chat
				sessionManager.clearCurrentSession();
				options.clearSavedMessages();
				// Reset terminal before navigating to welcome screen
				resetTerminal(stdout);
				void import('../../utils/core/folderNotebookPreprocessor.js').then(
					({clearReadFolders}) => {
						clearReadFolders();
					},
				);
				navigateTo('welcome');
			} else if (result.success && result.action === 'showUsagePanel') {
				options.setShowUsagePanel(true);
				const commandMessage: Message = {
					role: 'command',
					content: '',
					commandName: commandName,
				};
				options.setMessages(prev => [...prev, commandMessage]);
			} else if (result.success && result.action === 'help') {
				// 帮助内容改为独立页面,避免在聊天区渲染超长文本导致布局溢出
				navigateTo('help');
				// 不追加command消息,避免无效反馈挤占主对话区
			} else if (
				result.success &&
				result.action === 'showCustomCommandConfig'
			) {
				options.setShowCustomCommandConfig(true);
				const commandMessage: Message = {
					role: 'command',
					content: '',
					commandName: commandName,
				};
				options.setMessages(prev => [...prev, commandMessage]);
			} else if (result.success && result.action === 'showSkillsCreation') {
				options.setShowSkillsCreation(true);
				const commandMessage: Message = {
					role: 'command',
					content: '',
					commandName: commandName,
				};
				options.setMessages(prev => [...prev, commandMessage]);
			} else if (result.success && result.action === 'showWorkingDirPanel') {
				options.setShowWorkingDirPanel(true);
				const commandMessage: Message = {
					role: 'command',
					content: '',
					commandName: commandName,
				};
				options.setMessages(prev => [...prev, commandMessage]);
			} else if (result.success && result.action === 'showPermissionsPanel') {
				options.setShowPermissionsPanel(true);
				const commandMessage: Message = {
					role: 'command',
					content: '',
					commandName: commandName,
				};
				options.setMessages(prev => [...prev, commandMessage]);
			} else if (result.success && result.action === 'showBranchPanel') {
				options.setShowBranchPanel(true);
				const commandMessage: Message = {
					role: 'command',
					content: '',
					commandName: commandName,
				};
				options.setMessages(prev => [...prev, commandMessage]);
			} else if (result.success && result.action === 'showNewPromptPanel') {
				options.setShowNewPromptPanel(true);
			} else if (result.success && result.action === 'showTaskManager') {
				navigateTo('tasks');
			} else if (result.success && result.action === 'showTodoListPanel') {
				options.setShowTodoListPanel(true);
			} else if (
				result.success &&
				result.action === 'executeCustomCommand' &&
				result.prompt
			) {
				const commandMessage: Message = {
					role: 'command',
					content: result.message || '',
					commandName: commandName,
				};
				options.setMessages(prev => [...prev, commandMessage]);
				// Send command to AI for execution
				options.processMessage(result.prompt, undefined, false, false);
			} else if (
				result.success &&
				result.action === 'executeTerminalCommand' &&
				result.prompt
			) {
				// Execute terminal command (execute type - run in terminal)
				// Use customCommandExecution state for real-time output display in dynamic area
				options.setIsExecutingTerminalCommand(true);
				options.setCustomCommandExecution({
					commandName: commandName,
					command: result.prompt,
					isRunning: true,
					output: [],
					exitCode: null,
				});

				// Execute the command using spawn
				const {spawn} = require('child_process');
				const isWindows = process.platform === 'win32';
				const shell = isWindows ? 'cmd' : 'sh';
				const shellArgs = isWindows
					? ['/c', result.prompt]
					: ['-c', result.prompt];

				const child = spawn(shell, shellArgs, {
					timeout: 30000,
				});

				let outputLines: string[] = [];
				// PERFORMANCE: Batch output updates to avoid excessive re-renders
				let cmdOutputFlushTimer: ReturnType<typeof setTimeout> | null = null;
				const CMD_OUTPUT_FLUSH_DELAY = 80;

				const flushCmdOutput = () => {
					if (cmdOutputFlushTimer) {
						clearTimeout(cmdOutputFlushTimer);
						cmdOutputFlushTimer = null;
					}
					const snapshot = outputLines;
					options.setCustomCommandExecution(prev =>
						prev ? {...prev, output: snapshot} : null,
					);
				};

				const scheduleCmdOutputFlush = () => {
					if (cmdOutputFlushTimer) {
						clearTimeout(cmdOutputFlushTimer);
					}
					cmdOutputFlushTimer = setTimeout(
						flushCmdOutput,
						CMD_OUTPUT_FLUSH_DELAY,
					);
				};

				// Stream stdout
				child.stdout.on('data', (data: Buffer) => {
					const text = data.toString();
					const newLines = text
						.split('\n')
						.filter((line: string) => line.length > 0);
					outputLines = [...outputLines, ...newLines].slice(-20); // Keep last 20 lines
					scheduleCmdOutputFlush();
				});

				// Stream stderr
				child.stderr.on('data', (data: Buffer) => {
					const text = data.toString();
					const newLines = text
						.split('\n')
						.filter((line: string) => line.length > 0);
					outputLines = [...outputLines, ...newLines].slice(-20);
					scheduleCmdOutputFlush();
				});

				// Handle completion
				child.on('close', (code: number | null) => {
					// Flush any remaining output before closing
					flushCmdOutput();
					options.setIsExecutingTerminalCommand(false);
					options.setCustomCommandExecution(prev =>
						prev ? {...prev, isRunning: false, exitCode: code} : null,
					);
					// Clear after 3 seconds
					setTimeout(() => {
						options.setCustomCommandExecution(null);
					}, 3000);
				});

				// Handle error
				child.on('error', (error: any) => {
					options.setIsExecutingTerminalCommand(false);
					options.setCustomCommandExecution(prev =>
						prev
							? {...prev, isRunning: false, exitCode: -1, error: error.message}
							: null,
					);
					// Clear after 5 seconds for errors
					setTimeout(() => {
						options.setCustomCommandExecution(null);
					}, 5000);
				});
			} else if (
				result.success &&
				result.action === 'deleteCustomCommand' &&
				result.prompt
			) {
				// Delete custom command
				const {
					deleteCustomCommand,
					registerCustomCommands,
				} = require('../../utils/commands/custom.js');

				try {
					// Use the location from result, default to 'global' if not provided
					const location = result.location || 'global';
					const projectRoot =
						location === 'project' ? process.cwd() : undefined;

					await deleteCustomCommand(result.prompt, location, projectRoot);
					await registerCustomCommands(projectRoot);

					const successMessage: Message = {
						role: 'command',
						content: `Custom command '${result.prompt}' deleted successfully`,
						commandName: commandName,
					};
					options.setMessages(prev => [...prev, successMessage]);
				} catch (error: any) {
					const errorMessage: Message = {
						role: 'command',
						content: `Failed to delete command: ${error.message}`,
						commandName: commandName,
					};
					options.setMessages(prev => [...prev, errorMessage]);
				}
			} else if (result.success && result.action === 'home') {
				// Clear session BEFORE navigating to prevent stale session leaking into new chat
				sessionManager.clearCurrentSession();
				options.clearSavedMessages();
				// Reset terminal before navigating to welcome screen
				resetTerminal(stdout);
				void import('../../utils/core/folderNotebookPreprocessor.js').then(
					({clearReadFolders}) => {
						clearReadFolders();
					},
				);
				navigateTo('welcome');
			} else if (result.success && result.action === 'toggleYolo') {
				// Toggle YOLO mode without adding command message
				options.setYoloMode(prev => !prev);
				// 不追加command消息,避免无效反馈挤占主对话区
			} else if (
				result.success &&
				result.action === 'initProject' &&
				result.prompt
			) {
				// Add command execution feedback
				const commandMessage: Message = {
					role: 'command',
					content: '',
					commandName: commandName,
				};
				options.setMessages(prev => [...prev, commandMessage]);
				// Auto-send the prompt using basicModel, hide the prompt from UI
				options.processMessage(result.prompt, undefined, true, true);
			} else if (
				result.success &&
				result.action === 'review' &&
				result.prompt
			) {
				// Clear current session and start new one for code review
				sessionManager.clearCurrentSession();
				options.clearSavedMessages();
				options.setMessages([]);
				options.setRemountKey(prev => prev + 1);
				// Reset context usage (token statistics)
				options.setContextUsage(null);

				// Add command execution feedback
				const commandMessage: Message = {
					role: 'command',
					content: '',
					commandName: commandName,
				};
				options.setMessages([commandMessage]);
				// Auto-send the review prompt using advanced model (not basic model), hide the prompt from UI
				options.processMessage(result.prompt, undefined, false, true);
			} else if (result.success && result.action === 'exportChat') {
				// Handle export chat command
				// Show loading message first
				const loadingMessage: Message = {
					role: 'command',
					content: 'Opening file save dialog...',
					commandName: commandName,
				};
				options.setMessages(prev => [...prev, loadingMessage]);

				try {
					// Check if file dialog is supported
					if (!isFileDialogSupported()) {
						const errorMessage: Message = {
							role: 'command',
							content:
								'File dialog not supported on this platform. Export cancelled.',
							commandName: commandName,
						};
						options.setMessages(prev => [...prev, errorMessage]);
						return;
					}

					// Generate default filename with timestamp
					const timestamp = new Date()
						.toISOString()
						.replace(/[:.]/g, '-')
						.split('.')[0];
					const defaultFilename = `snow-chat-${timestamp}.txt`;

					// Show native save dialog
					const filePath = await showSaveDialog(
						defaultFilename,
						'Export Chat Conversation',
					);

					if (!filePath) {
						// User cancelled
						const cancelMessage: Message = {
							role: 'command',
							content: 'Export cancelled by user.',
							commandName: commandName,
						};
						options.setMessages(prev => [...prev, cancelMessage]);
						return;
					}

					// Export messages to file
					await exportMessagesToFile(options.messages, filePath);

					// Show success message
					const successMessage: Message = {
						role: 'command',
						content: `✓ Chat exported successfully to:\n${filePath}`,
						commandName: commandName,
					};
					options.setMessages(prev => [...prev, successMessage]);
				} catch (error) {
					// Show error message
					const errorMsg =
						error instanceof Error ? error.message : 'Unknown error';
					const errorMessage: Message = {
						role: 'command',
						content: `✗ Export failed: ${errorMsg}`,
						commandName: commandName,
					};
					options.setMessages(prev => [...prev, errorMessage]);
				}
			} else if (result.success && result.action === 'quit') {
				// Handle quit command - exit the application cleanly
				if (options.onQuit) {
					options.onQuit();
				}
			} else if (result.success && result.action === 'reindexCodebase') {
				// Handle reindex codebase command - silent execution
				if (options.onReindexCodebase) {
					try {
						await options.onReindexCodebase(result.forceReindex);
					} catch (error) {
						const errorMsg =
							error instanceof Error ? error.message : 'Unknown error';
						const errorMessage: Message = {
							role: 'command',
							content: `Failed to rebuild codebase index: ${errorMsg}`,
							commandName: commandName,
						};
						options.setMessages(prev => [...prev, errorMessage]);
					}
				}
			} else if (result.success && result.action === 'copyLastMessage') {
				try {
					const currentSession = sessionManager.getCurrentSession();
					let lastAssistantContent: string | undefined;

					if (currentSession && !currentSession.isTemporary) {
						await sessionManager.saveSession(currentSession);
						const lastAssistantMessage =
							await sessionManager.getLastAssistantMessageFromSession(
								currentSession.id,
							);
						lastAssistantContent = lastAssistantMessage?.content;
					} else if (currentSession) {
						for (let i = currentSession.messages.length - 1; i >= 0; i--) {
							const msg = currentSession.messages[i];
							if (msg && msg.role === 'assistant' && !msg.subAgentInternal) {
								lastAssistantContent = msg.content;
								break;
							}
						}
					}

					if (lastAssistantContent === undefined) {
						const errorMessage: Message = {
							role: 'command',
							content: t.commandPanel.copyLastFeedback.noAssistantMessage,
							commandName: commandName,
						};
						options.setMessages(prev => [...prev, errorMessage]);
						return;
					}

					if (!lastAssistantContent) {
						const errorMessage: Message = {
							role: 'command',
							content: t.commandPanel.copyLastFeedback.emptyAssistantMessage,
							commandName: commandName,
						};
						options.setMessages(prev => [...prev, errorMessage]);
						return;
					}

					await copyToClipboard(lastAssistantContent);

					const successMessage: Message = {
						role: 'command',
						content: t.commandPanel.copyLastFeedback.copySuccess,
						commandName: commandName,
					};
					options.setMessages(prev => [...prev, successMessage]);
				} catch (error) {
					const errorMsg =
						error instanceof Error
							? error.message
							: t.commandPanel.copyLastFeedback.unknownError;
					const errorMessage: Message = {
						role: 'command',
						content: `${t.commandPanel.copyLastFeedback.copyFailedPrefix}: ${errorMsg}`,
						commandName: commandName,
					};
					options.setMessages(prev => [...prev, errorMessage]);
				}
			} else if (result.success && result.action === 'toggleCodebase') {
				if (options.onToggleCodebase) {
					try {
						await options.onToggleCodebase(result.prompt);
					} catch (error) {
						const errorMsg =
							error instanceof Error ? error.message : 'Unknown error';
						const errorMessage: Message = {
							role: 'command',
							content: `Failed to toggle codebase: ${errorMsg}`,
							commandName: commandName,
						};
						options.setMessages(prev => [...prev, errorMessage]);
					}
				}
			} else if (result.message) {
				// 某些命令只返回一段文本,这里将其作为 command 消息展示到消息列表中.
				const commandMessage: Message = {
					role: 'command',
					content: result.message,
					commandName: commandName,
				};
				options.setMessages(prev => [...prev, commandMessage]);
			}
		},
		[stdout, options, t],
	);

	return {handleCommandExecution};
}
