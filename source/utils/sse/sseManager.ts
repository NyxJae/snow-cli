import {SSEServer, SSEEvent, ClientMessage} from '../../api/sse-server.js';
import {handleConversationWithTools} from '../../hooks/conversation/useConversation.js';
import {sessionManager} from '../session/sessionManager.js';
import {hashBasedSnapshotManager} from '../codebase/hashBasedSnapshot.js';
import type {ToolCall} from '../execution/toolExecutor.js';
import type {ConfirmationResult} from '../../ui/components/tools/ToolConfirmation.js';
import type {UserQuestionResult} from '../../hooks/conversation/useConversation.js';
import {
	loadPermissionsConfig,
	addMultipleToolsToPermissions,
} from '../config/permissionsConfig.js';
import {isSensitiveCommand} from '../execution/sensitiveCommandManager.js';
import {getTodoService} from '../execution/mcpToolsManager.js';
import {todoEvents} from '../events/todoEvents.js';
import {randomUUID} from 'crypto';
import {mainAgentManager} from '../MainAgentManager.js';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	unlinkSync,
} from 'fs';
import {join} from 'path';
import {homedir} from 'os';

/**
 * 待处理的交互请求
 */
interface PendingInteraction {
	requestId: string;
	sessionId: string; // 关联的 sessionId，用于 busy 判定
	type: 'tool_confirmation' | 'user_question';
	resolve: (value: any) => void;
	reject: (error: any) => void;
	timeout: NodeJS.Timeout;
}

/**
 * SSE 服务管理器
 * 负责 SSE 服务器的生命周期管理和消息处理
 */
class SSEManager {
	private server: SSEServer | null = null;
	private isRunning = false;
	private pendingInteractions: Map<string, PendingInteraction> = new Map();
	private interactionTimeout = 300000; // 交互超时时长(默认5分钟,可通过start方法配置)
	private logCallback?: (
		message: string,
		level?: 'info' | 'error' | 'success',
	) => void;
	// 存储每个会话的 AbortController，用于中断任务
	private sessionControllers: Map<string, AbortController> = new Map();
	// 存储每个会话的当前主代理ID，实现会话级主代理隔离
	private sessionAgentIds: Map<string, string> = new Map();
	// 存储连接与会话的映射，避免穿透 SSEServer 私有状态
	private connectionSessionMap: Map<string, string> = new Map();
	// 默认主代理ID
	private readonly defaultAgentId = 'general';
	// 当前监听端口,用于管理 PID 文件生命周期
	private currentPort: number | null = null;
	// TODO 事件桥接回调,保持引用稳定以便在 stop 时反注册
	private readonly todoUpdateListener = (data: {
		sessionId: string;
		todos: Array<any>;
	}): void => {
		this.sendTodosToSessionConnections(
			data.sessionId,
			Array.isArray(data.todos) ? data.todos : [],
			'todo_update',
		);
	};

	/**
	 * 向指定会话的所有连接推送 TODO 事件.
	 */
	private sendTodosToSessionConnections(
		sessionId: string,
		todos: Array<any>,
		eventType: 'todo_update' | 'todos',
	): void {
		if (!this.server) {
			return;
		}
		for (const [
			connectionId,
			mappedSessionId,
		] of this.connectionSessionMap.entries()) {
			if (mappedSessionId !== sessionId) {
				continue;
			}
			this.server.sendToConnection(connectionId, {
				type: eventType,
				data: {
					sessionId,
					todos,
				},
				timestamp: new Date().toISOString(),
			});
		}
	}

	/**
	 * 拉取并推送会话当前 TODO 全量快照.
	 */
	private async emitTodosSnapshot(sessionId: string): Promise<void> {
		try {
			const todoService = getTodoService();
			const todoList = await todoService.getTodoList(sessionId);
			this.sendTodosToSessionConnections(
				sessionId,
				todoList?.todos ?? [],
				'todos',
			);
		} catch {
			this.sendTodosToSessionConnections(sessionId, [], 'todos');
		}
	}

	/**
	 * 设置日志回调函数
	 */
	setLogCallback(
		callback: (message: string, level?: 'info' | 'error' | 'success') => void,
	): void {
		this.logCallback = callback;
	}

	/**
	 * 同步 session 与连接映射,并在会话变更时触发 TODO 快照.
	 */
	private mirrorSessionBinding(sessionId: string, connectionId: string): void {
		const previousSessionId = this.connectionSessionMap.get(connectionId);
		// 维护本地映射，避免穿透 SSEServer 私有状态
		this.connectionSessionMap.set(connectionId, sessionId);
		if (previousSessionId !== sessionId) {
			void this.emitTodosSnapshot(sessionId);
		}
	}

	/**
	 * 绑定 session 到连接，并维护本地映射
	 */
	private bindSessionToConnection(
		sessionId: string,
		connectionId: string,
	): void {
		if (this.server) {
			this.server.bindSessionToConnection(sessionId, connectionId);
		}
		this.mirrorSessionBinding(sessionId, connectionId);
	}

	/**
	 * 处理会话创建，设置初始主代理
	 */
	private handleSessionCreated(
		sessionId: string,
		connectionId: string,
		initialAgentId?: string,
	): void {
		// 同步本地映射,若本连接首次绑定该会话则触发一次 TODO 快照
		this.mirrorSessionBinding(sessionId, connectionId);

		// 设置初始主代理
		let agentId = this.defaultAgentId;
		if (initialAgentId) {
			// 校验 initialAgentId 是否有效
			const availableAgents = mainAgentManager.listAvailableAgents();
			const isValid = availableAgents.some(a => a.id === initialAgentId);
			if (isValid) {
				agentId = initialAgentId;
			} else {
				this.log(
					`初始主代理 ${initialAgentId} 无效，使用默认代理 ${this.defaultAgentId}`,
					'info',
				);
			}
		}

		this.sessionAgentIds.set(sessionId, agentId);
		this.log(`会话 ${sessionId} 初始主代理设置为: ${agentId}`, 'info');

		// 发送 agent_list 事件通知客户端
		if (this.server) {
			const availableAgents = mainAgentManager.listAvailableAgents();
			this.server.sendToConnection(connectionId, {
				type: 'agent_list',
				data: {
					agents: availableAgents,
					currentAgentId: agentId,
				},
				timestamp: new Date().toISOString(),
			});
		}
	}

	/**
	 * 获取连接关联的 sessionId
	 */
	private getSessionIdByConnectionId(connectionId: string): string | undefined {
		return this.connectionSessionMap.get(connectionId);
	}

	/**
	 * 处理连接创建，发送初始 agent_list
	 */
	private handleConnectionCreated(
		_connectionId: string,
		sendEvent: (event: SSEEvent) => void,
	): void {
		try {
			const agents = mainAgentManager.listAvailableAgents();
			sendEvent({
				type: 'agent_list',
				data: {
					agents,
					currentAgentId: null,
				},
				timestamp: new Date().toISOString(),
			});
		} catch (error) {
			this.log(
				`连接创建后发送 agent_list 失败: ${
					error instanceof Error ? error.message : String(error)
				}`,
				'error',
			);
		}
	}

	/**
	 * 处理连接关闭，清理本地映射
	 */
	private handleConnectionClosed(connectionId: string): void {
		// 清理 connectionSessionMap
		if (this.connectionSessionMap.has(connectionId)) {
			this.connectionSessionMap.delete(connectionId);
			this.log(`已清理连接 ${connectionId} 的本地映射`, 'info');
		}
	}

	/**
	 * 记录日志
	 */
	private log(
		message: string,
		level: 'info' | 'error' | 'success' = 'info',
	): void {
		if (this.logCallback) {
			this.logCallback(message, level);
		} else {
			console.log(message);
		}
	}

	/**
	 * 启动 SSE 服务
	 */
	async start(
		port: number = 3000,
		interactionTimeout: number = 300000,
	): Promise<void> {
		if (this.isRunning) {
			this.log('SSE 服务已在运行', 'info');
			return;
		}

		// 设置交互超时时长
		this.interactionTimeout = interactionTimeout;

		this.server = new SSEServer(port);

		// 设置日志回调（如果已设置）
		if (this.logCallback) {
			this.server.setLogCallback(this.logCallback);
		}

		// 设置消息处理器
		this.server.setMessageHandler(async (message, sendEvent, connectionId) => {
			await this.handleClientMessage(message, sendEvent, connectionId);
		});

		// 设置会话创建处理器(用于初始化主代理)
		this.server.setSessionCreatedHandler(
			(sessionId, connectionId, initialAgentId) => {
				this.handleSessionCreated(sessionId, connectionId, initialAgentId);
			},
		);
		// 同步 create/load 的会话绑定关系到本地映射,避免 switch_agent 校验误判
		this.server.setSessionBoundHandler((sessionId, connectionId) => {
			this.mirrorSessionBinding(sessionId, connectionId);
		});

		// 设置连接创建处理器(用于发送初始 agent_list)
		this.server.setConnectionCreatedHandler((connectionId, sendEvent) => {
			this.handleConnectionCreated(connectionId, sendEvent);
		});

		// 设置连接关闭处理器(用于清理本地映射)
		this.server.setConnectionClosedHandler(connectionId => {
			this.handleConnectionClosed(connectionId);
		});
		// 订阅 TODO 更新,桥接到对应会话连接
		todoEvents.onTodoUpdate(this.todoUpdateListener);

		await this.server.start();
		this.isRunning = true;
		this.currentPort = port;

		// 写入 PID 文件, 供 sse-client 和 --sse-status 发现本服务
		this.writePidFile(port, interactionTimeout);

		this.log(`SSE 服务已启动,端口 ${port}`, 'success');
	}

	/**
	 * 停止 SSE 服务
	 */
	async stop(): Promise<void> {
		if (!this.isRunning || !this.server) {
			return;
		}
		// 停止前反注册 TODO 监听,避免重复订阅导致重复推送
		todoEvents.offTodoUpdate(this.todoUpdateListener);

		await this.server.stop();
		this.server = null;
		this.isRunning = false;

		// 清理 PID 文件
		this.removePidFile();

		this.log('SSE 服务已停止', 'info');
	}

	/** 避免误覆盖外部守护进程或其他 snow 实例的 PID 文件, 与 sseDaemon.ts 共享 DaemonInfo 格式. */
	private writePidFile(port: number, timeout: number): void {
		const daemonDir = join(homedir(), '.snow', 'sse-daemons');
		if (!existsSync(daemonDir)) {
			mkdirSync(daemonDir, {recursive: true});
		}
		const pidFile = join(daemonDir, `port-${port}.pid`);

		// 同端口 PID 文件若属于另一个存活进程则拒绝覆盖, 保护外部服务
		if (existsSync(pidFile)) {
			try {
				const existing = JSON.parse(readFileSync(pidFile, 'utf-8'));
				if (typeof existing?.pid === 'number' && existing.pid !== process.pid) {
					try {
						process.kill(existing.pid, 0);
						this.log(
							`端口 ${port} 的 PID 文件属于另一个存活进程(pid=${existing.pid}), 跳过写入`,
							'info',
						);
						return;
					} catch (err) {
						// EPERM: 进程存在但无权限发信号, 保守视为存活
						if (
							err instanceof Error &&
							'code' in err &&
							(err as NodeJS.ErrnoException).code === 'EPERM'
						) {
							return;
						}
						// ESRCH 或其他: 进程已不存在, 可安全覆盖
					}
				}
			} catch {
				// PID 文件 JSON 损坏, 可安全覆盖
			}
		}

		const info = {
			pid: process.pid,
			port,
			workDir: process.cwd(),
			timeout,
			startTime: new Date().toISOString(),
		};
		try {
			writeFileSync(pidFile, JSON.stringify(info, null, 2));
		} catch (error) {
			this.log(
				`写入 PID 文件失败: ${error instanceof Error ? error.message : error}`,
				'error',
			);
		}
	}

	/** 仅删除自身写入的 PID 文件, 避免误删其他 snow 实例的记录. */
	private removePidFile(): void {
		if (this.currentPort === null) {
			return;
		}
		const pidFile = join(
			homedir(),
			'.snow',
			'sse-daemons',
			`port-${this.currentPort}.pid`,
		);
		try {
			if (existsSync(pidFile)) {
				const content = JSON.parse(readFileSync(pidFile, 'utf-8'));
				if (content?.pid === process.pid) {
					unlinkSync(pidFile);
				}
			}
		} catch {
			// 文件损坏或已被外部删除, 静默跳过
		}
		this.currentPort = null;
	}

	/**
	 * 处理客户端消息
	 */
	private async handleClientMessage(
		message: ClientMessage,
		sendEvent: (event: SSEEvent) => void,
		connectionId: string,
	): Promise<void> {
		try {
			// 处理交互响应
			if (
				message.type === 'tool_confirmation_response' ||
				message.type === 'user_question_response'
			) {
				this.handleInteractionResponse(message);
				return;
			}

			// 处理中断请求
			if (message.type === 'abort') {
				this.handleAbortRequest(message, sendEvent);
				return;
			}

			// 处理回滚请求
			if (message.type === 'rollback') {
				await this.handleRollbackRequest(message, sendEvent);
				return;
			}

			// 处理主代理切换请求
			if (message.type === 'switch_agent') {
				await this.handleSwitchAgentRequest(message, sendEvent, connectionId);
				return;
			}

			// 处理普通聊天消息
			if (message.type === 'chat' || message.type === 'image') {
				await this.handleChatMessage(message, sendEvent, connectionId);
			}
		} catch (error) {
			this.log(
				`handleClientMessage error: ${
					error instanceof Error ? error.message : String(error)
				}`,
				'error',
			);
			// 发送错误事件
			sendEvent({
				type: 'error',
				data: {
					message: error instanceof Error ? error.message : '未知错误',
					stack: error instanceof Error ? error.stack : undefined,
				},
				timestamp: new Date().toISOString(),
			});
		}
	}

	/**
	 * 处理交互响应
	 */
	private handleInteractionResponse(message: ClientMessage): void {
		if (!message.requestId) {
			this.log('交互响应缺少 requestId', 'error');
			return;
		}

		const pending = this.pendingInteractions.get(message.requestId);
		if (!pending) {
			this.log(`未找到待处理的交互请求: ${message.requestId}`, 'error');
			return;
		}

		// 清除超时
		clearTimeout(pending.timeout);

		// 根据类型处理不同的响应格式
		if (pending.type === 'tool_confirmation') {
			// tool_confirmation 响应：直接是 ConfirmationResult 字符串
			// 期望值：'approve' | 'approve_always' | 'reject' | { rejectWithReply: string }
			pending.resolve(message.response);
		} else if (pending.type === 'user_question') {
			// user_question 响应：完整的 UserQuestionResult 对象
			// 期望格式：{ selected: string | string[], customInput?: string, cancelled?: boolean }
			pending.resolve(message.response);
		}
		// 移除待处理请求
		this.pendingInteractions.delete(message.requestId);
	}

	/**
	 * 处理中断请求
	 */
	private handleAbortRequest(
		message: ClientMessage,
		sendEvent: (event: SSEEvent) => void,
	): void {
		if (!message.sessionId) {
			this.log('中止请求缺少 sessionId', 'error');
			return;
		}

		const controller = this.sessionControllers.get(message.sessionId);
		if (controller) {
			// 触发中断信号
			controller.abort();
			this.log(`会话 ${message.sessionId} 的任务已中止`, 'info');

			// 发送中断确认事件
			sendEvent({
				type: 'message',
				data: {
					role: 'assistant',
					content: '任务已被用户中止',
				},
				timestamp: new Date().toISOString(),
			});

			// 清理 controller
			this.sessionControllers.delete(message.sessionId);
		}
	}

	/**
	 * 处理回滚请求（会话截断 + 可选文件回滚）
	 */
	private async handleRollbackRequest(
		message: ClientMessage,
		sendEvent: (event: SSEEvent) => void,
	): Promise<void> {
		const sessionId = message.sessionId;
		const rollback = message.rollback;

		if (!sessionId) {
			sendEvent({
				type: 'rollback_result',
				data: {success: false, error: 'Missing sessionId'},
				timestamp: new Date().toISOString(),
				requestId: message.requestId,
			});
			return;
		}

		if (!rollback) {
			sendEvent({
				type: 'rollback_result',
				data: {success: false, error: 'Missing rollback payload'},
				timestamp: new Date().toISOString(),
				requestId: message.requestId,
			});
			return;
		}

		try {
			const currentSession = await sessionManager.loadSession(sessionId);
			if (!currentSession) {
				sendEvent({
					type: 'rollback_result',
					data: {success: false, error: 'Session not found', sessionId},
					timestamp: new Date().toISOString(),
					requestId: message.requestId,
				});
				return;
			}

			sessionManager.setCurrentSession(currentSession);

			// 快照系统使用 UI 消息索引, 消息截断使用原始 session.messages 索引
			// snapshotIndex 由 rollback-points API 提供, 回退兼容旧客户端
			const snapshotIdx = rollback.snapshotIndex ?? rollback.messageIndex;
			const validSnapshotIdx =
				Number.isInteger(snapshotIdx) && snapshotIdx >= 0;

			let filesRolledBack = 0;
			if (rollback.rollbackFiles && validSnapshotIdx) {
				filesRolledBack = await hashBasedSnapshotManager.rollbackToMessageIndex(
					sessionId,
					snapshotIdx,
					rollback.selectedFiles,
				);
			}

			if (validSnapshotIdx) {
				await hashBasedSnapshotManager.deleteSnapshotsFromIndex(
					sessionId,
					snapshotIdx,
				);
			}

			await sessionManager.truncateMessages(rollback.messageIndex);

			sendEvent({
				type: 'rollback_result',
				data: {
					success: true,
					sessionId,
					messageIndex: rollback.messageIndex,
					filesRolledBack,
				},
				timestamp: new Date().toISOString(),
				requestId: message.requestId,
			});
		} catch (error) {
			sendEvent({
				type: 'rollback_result',
				data: {
					success: false,
					sessionId,
					error: error instanceof Error ? error.message : 'Unknown error',
				},
				timestamp: new Date().toISOString(),
				requestId: message.requestId,
			});
		}
	}

	/**
	 * 处理聊天消息
	 */
	private async handleChatMessage(
		message: ClientMessage,
		sendEvent: (event: SSEEvent) => void,
		connectionId: string,
	): Promise<void> {
		// 获取或创建 session
		let currentSession;
		if (message.sessionId) {
			// 加载已有的 session
			try {
				currentSession = await sessionManager.loadSession(message.sessionId);
				if (currentSession) {
					sessionManager.setCurrentSession(currentSession);
					// 绑定 session 到当前连接
					this.bindSessionToConnection(message.sessionId, connectionId);
				} else {
					// Session 不存在，创建新的
					currentSession = await sessionManager.createNewSession();
					// 绑定 session 到当前连接
					this.bindSessionToConnection(currentSession.id, connectionId);
				}
			} catch (error) {
				this.log('加载会话失败,创建新会话', 'error');
				currentSession = await sessionManager.createNewSession();
				// 绑定 session 到当前连接
				this.bindSessionToConnection(currentSession.id, connectionId);
			}
		} else {
			// 创建新 session
			currentSession = await sessionManager.createNewSession();
			// 绑定 session 到当前连接
			this.bindSessionToConnection(currentSession.id, connectionId);
		}

		// 在连接事件中返回 sessionId
		sendEvent({
			type: 'message',
			data: {
				role: 'system',
				sessionId: currentSession.id,
				content: `Session ID: ${currentSession.id}`,
			},
			timestamp: new Date().toISOString(),
		});

		// 发送可用主代理列表
		this.sendAgentList(currentSession.id, sendEvent);

		// 发送开始处理事件
		sendEvent({
			type: 'message',
			data: {
				role: 'user',
				content: message.content,
				hasImages: Boolean(message.images && message.images.length > 0),
			},
			timestamp: new Date().toISOString(),
		});

		// 准备图片内容
		const imageContents = message.images?.map(img => ({
			type: 'image' as const,
			data: img.data, // 完整的 data URI
			mimeType: img.mimeType,
		}));

		// 创建 AbortController
		const controller = new AbortController();

		// 存储到 sessionControllers，以便可以从客户端中断
		this.sessionControllers.set(currentSession.id, controller);

		// 消息保存函数
		const saveMessage = async (msg: any) => {
			try {
				await sessionManager.addMessage(msg);
				// 不记录每条消息，避免日志过多
			} catch (error) {
				this.log('保存消息失败', 'error');
			}
		};

		const messagesRef: any[] = [];
		let lastSentMessageId: string | undefined;
		let lastSentToolCallId: string | undefined;

		/** 处理单条消息, 按类型分发为 SSE 事件 */
		const processMessage = (msg: any) => {
			if (msg.subAgentInternal || msg.role === 'subagent') {
				return;
			}

			const messageId = `${msg.role}-${msg.content?.substring(0, 50)}-${
				msg.streaming
			}`;

			if (
				!msg.streaming &&
				!msg.toolCall &&
				!msg.toolResult &&
				messageId === lastSentMessageId
			) {
				return;
			}

			if (msg.toolCall) {
				if (msg.toolCallId === lastSentToolCallId) {
					return;
				}
				sendEvent({
					type: 'tool_call',
					data: {
						function: msg.toolCall,
						toolCallId: msg.toolCallId,
					},
					timestamp: new Date().toISOString(),
				});
				lastSentToolCallId = msg.toolCallId;
			} else if (msg.toolResult) {
				// toolCall?.name 优先; 子代理完成消息无 toolCall, 从 content 格式"✓ toolName"回退提取
				const extractedToolName =
					msg.toolCall?.name ||
					(typeof msg.content === 'string'
						? msg.content.match(/^[✓✗]\s+([\w-]+)/)?.[1]
						: undefined);
				sendEvent({
					type: 'tool_result',
					data: {
						content: msg.toolResult,
						status: msg.messageStatus,
						toolName: extractedToolName,
					},
					timestamp: new Date().toISOString(),
				});
			} else if (msg.role === 'assistant') {
				sendEvent({
					type: 'message',
					data: {
						role: 'assistant',
						content: msg.content,
						streaming: msg.streaming || false,
					},
					timestamp: new Date().toISOString(),
				});

				if (!msg.streaming) {
					lastSentMessageId = messageId;
				}
			}
		};

		const setMessages = (updater: any) => {
			const prevLength = messagesRef.length;
			if (typeof updater === 'function') {
				const newMessages = updater(messagesRef);
				messagesRef.splice(0, messagesRef.length, ...newMessages);
			} else {
				messagesRef.splice(0, messagesRef.length, ...updater);
			}

			// 批量添加时遍历所有新增消息, 单条更新时只处理最后一条
			const newCount = messagesRef.length - prevLength;
			if (newCount > 1) {
				// 批量: 遍历所有新增消息(如并行工具结果)
				for (let i = prevLength; i < messagesRef.length; i++) {
					processMessage(messagesRef[i]!);
				}
			} else if (messagesRef.length > 0) {
				// 单条或就地更新: 只处理最后一条
				processMessage(messagesRef[messagesRef.length - 1]!);
			}
		};

		// Token 计数
		let tokenCount = 0;
		const setStreamTokenCount = (
			count: number | ((prev: number) => number),
		) => {
			if (typeof count === 'function') {
				tokenCount = count(tokenCount);
			} else {
				tokenCount = count;
			}
		};

		// 上下文使用
		const setContextUsage = (usage: any) => {
			sendEvent({
				type: 'usage',
				data: usage,
				timestamp: new Date().toISOString(),
			});
		};

		// 工具确认处理
		const requestToolConfirmation = async (
			toolCall: ToolCall,
			batchToolNames?: string,
			allTools?: ToolCall[],
		): Promise<ConfirmationResult> => {
			const requestId = this.generateRequestId();

			// 检测是否为敏感命令
			let isSensitive = false;
			let sensitiveInfo = undefined;
			if (toolCall.function.name === 'terminal-execute') {
				try {
					const args = JSON.parse(toolCall.function.arguments);
					if (args.command && typeof args.command === 'string') {
						const result = isSensitiveCommand(args.command);
						isSensitive = result.isSensitive;
						if (isSensitive && result.matchedCommand) {
							sensitiveInfo = {
								pattern: result.matchedCommand.pattern,
								description: result.matchedCommand.description,
							};
						}
					}
				} catch {
					// 忽略解析错误
				}
			}

			// 构建可用选项列表
			const availableOptions: Array<{
				value: ConfirmationResult | 'reject_with_reply';
				label: string;
			}> = [{value: 'approve', label: 'Approve once'}];

			// 非敏感命令才显示"总是批准"选项
			if (!isSensitive) {
				availableOptions.push({
					value: 'approve_always',
					label: 'Always approve',
				});
			}

			availableOptions.push(
				{value: 'reject_with_reply', label: 'Reject with reply'},
				{value: 'reject', label: 'Reject and end session'},
			);

			// 发送工具确认请求
			sendEvent({
				type: 'tool_confirmation_request',
				data: {
					toolCall,
					batchToolNames,
					allTools,
					isSensitive,
					sensitiveInfo,
					availableOptions,
				},
				timestamp: new Date().toISOString(),
				requestId,
			});

			// 等待客户端响应
			return this.waitForInteraction(
				requestId,
				'tool_confirmation',
				currentSession.id,
			);
		};

		// 用户问题处理
		const requestUserQuestion = async (
			question: string,
			options: string[],
			toolCall: ToolCall,
			multiSelect?: boolean,
		): Promise<UserQuestionResult> => {
			const requestId = this.generateRequestId();

			// 发送用户问题请求
			sendEvent({
				type: 'user_question_request',
				data: {
					question,
					options,
					toolCall,
					multiSelect,
				},
				timestamp: new Date().toISOString(),
				requestId,
			});

			// 等待客户端响应
			return this.waitForInteraction(
				requestId,
				'user_question',
				currentSession.id,
			);
		};

		// 获取当前工作目录的权限配置
		const workingDirectory = process.cwd();
		const permissionsConfig = loadPermissionsConfig(workingDirectory);
		const approvedToolsSet = new Set(permissionsConfig.alwaysApprovedTools);

		// 工具自动批准检查
		const isToolAutoApproved = (toolName: string) =>
			approvedToolsSet.has(toolName) ||
			toolName.startsWith('todo-') ||
			toolName.startsWith('subagent-') ||
			toolName === 'askuser-ask_question';

		// 添加到自动批准列表
		const addMultipleToAlwaysApproved = (toolNames: string[]) => {
			addMultipleToolsToPermissions(workingDirectory, toolNames);
			// 同步更新本地 Set
			toolNames.forEach(name => approvedToolsSet.add(name));
		};

		const subAgentContextUsageEmitAt = new Map<string, number>();
		const SUB_AGENT_CONTEXT_USAGE_INTERVAL_MS = 1200;
		const subAgentForwardableTypes = new Set([
			'tool_calls',
			'tool_result',
			'subagent_result',
			'agent_spawned',
			'spawned_agent_completed',
			'done',
			'context_usage',
		]);
		const shouldForwardSubAgentMessage = (subAgentMessage: any): boolean => {
			const payload = subAgentMessage?.message ?? {};
			const payloadType = String(payload?.type ?? '');
			if (!payloadType || !subAgentForwardableTypes.has(payloadType)) {
				return false;
			}
			if (payloadType !== 'context_usage') {
				return true;
			}
			const contextKey = String(
				subAgentMessage?.instanceId ?? subAgentMessage?.agentId ?? '',
			);
			if (!contextKey) {
				return false;
			}
			const now = Date.now();
			const lastEmitAt = subAgentContextUsageEmitAt.get(contextKey) ?? 0;
			const percentage = Number(payload?.percentage ?? 0);
			if (
				now - lastEmitAt < SUB_AGENT_CONTEXT_USAGE_INTERVAL_MS &&
				percentage < 100
			) {
				return false;
			}
			subAgentContextUsageEmitAt.set(contextKey, now);
			return true;
		};

		// 调用对话处理逻辑
		try {
			const result = await handleConversationWithTools({
				userContent: message.content || '',
				imageContents,
				controller,
				messages: messagesRef,
				saveMessage,
				setMessages,
				setStreamTokenCount,
				requestToolConfirmation,
				requestUserQuestion,
				isToolAutoApproved,
				addMultipleToAlwaysApproved,
				yoloModeRef: {current: message.yoloMode || false}, // 支持客户端传递 YOLO 模式
				setContextUsage,
				// 子代理事件只转发关键单元,避免 token 级流式导致前端高频重绘.
				onRawSubAgentMessage: subAgentMessage => {
					if (!shouldForwardSubAgentMessage(subAgentMessage)) {
						return;
					}
					sendEvent({
						type: 'sub_agent_message',
						data: subAgentMessage,
						timestamp: new Date().toISOString(),
					});
				},
			});

			// 发送完成事件（包含 sessionId）
			sendEvent({
				type: 'complete',
				data: {
					usage: result.usage,
					tokenCount,
					sessionId: currentSession.id,
				},
				timestamp: new Date().toISOString(),
			});

			// 清理 controller
			this.sessionControllers.delete(currentSession.id);
		} catch (error) {
			// 清理 controller
			this.sessionControllers.delete(currentSession.id);

			// 捕获用户主动中断的错误，作为正常流程结束
			if (
				error instanceof Error &&
				(error.message === 'Request aborted' ||
					error.message === 'User cancelled the interaction')
			) {
				// 发送中断确认事件
				sendEvent({
					type: 'message',
					data: {
						role: 'assistant',
						content:
							error.message === 'Request aborted'
								? '任务已被中止'
								: '用户取消了交互',
					},
					timestamp: new Date().toISOString(),
				});

				// 发送完成事件
				sendEvent({
					type: 'complete',
					data: {
						usage: {input_tokens: 0, output_tokens: 0},
						tokenCount,
						sessionId: currentSession.id,
						cancelled: true,
					},
					timestamp: new Date().toISOString(),
				});
			} else {
				// 其他错误继续抛出，由外层的 handleClientMessage 处理
				throw error;
			}
		}
	}

	/**
	 * 等待交互响应
	 */
	private waitForInteraction(
		requestId: string,
		type: 'tool_confirmation' | 'user_question',
		sessionId: string,
	): Promise<any> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingInteractions.delete(requestId);
				reject(new Error(`Interactive timeout: ${requestId}`));
			}, this.interactionTimeout);

			this.pendingInteractions.set(requestId, {
				requestId,
				sessionId,
				type,
				resolve,
				reject,
				timeout,
			});
		});
	}

	/**
	 * 处理主代理切换请求
	 */
	private async handleSwitchAgentRequest(
		message: ClientMessage,
		sendEvent: (event: SSEEvent) => void,
		connectionId: string,
	): Promise<void> {
		const agentId = message.agentId?.trim();

		// 验证 agentId 是否为空
		if (!agentId) {
			const availableAgents = mainAgentManager.listAvailableAgents();
			sendEvent({
				type: 'error',
				data: {
					errorCode: 'invalid_agent_id',
					message: 'agentId cannot be empty',
					availableAgents,
				},
				timestamp: new Date().toISOString(),
			});
			return;
		}

		// 验证 agentId 格式 [a-z0-9_-]+
		if (!/^[a-z0-9_-]+$/.test(agentId)) {
			const availableAgents = mainAgentManager.listAvailableAgents();
			sendEvent({
				type: 'error',
				data: {
					errorCode: 'invalid_agent_id_format',
					message: 'agentId contains invalid characters. Allowed: [a-z0-9_-]',
					availableAgents,
				},
				timestamp: new Date().toISOString(),
			});
			return;
		}

		// 获取目标 sessionId
		let targetSessionId = message.sessionId;
		if (!targetSessionId) {
			// 未提供 sessionId，尝试从连接获取绑定的 session
			targetSessionId = this.getSessionIdByConnectionId(connectionId);
		}

		if (!targetSessionId) {
			const availableAgents = mainAgentManager.listAvailableAgents();
			sendEvent({
				type: 'error',
				data: {
					errorCode: 'session_not_found',
					message: 'No session associated with this connection',
					availableAgents,
				},
				timestamp: new Date().toISOString(),
			});
			return;
		}

		// 无论客户端是否显式传入 sessionId,都要求该连接当前绑定的会话与目标会话一致,
		// 防止跨连接误操作其他会话.
		const boundSessionId = this.connectionSessionMap.get(connectionId);
		if (!boundSessionId || boundSessionId !== targetSessionId) {
			const availableAgents = mainAgentManager.listAvailableAgents();
			sendEvent({
				type: 'error',
				data: {
					errorCode: 'session_not_found',
					message: `Session not found or not bound: ${targetSessionId}`,
					availableAgents,
				},
				timestamp: new Date().toISOString(),
			});
			return;
		}

		// 检查 session 是否忙（有进行中的任务）
		if (this.isSessionBusy(targetSessionId)) {
			const availableAgents = mainAgentManager.listAvailableAgents();
			sendEvent({
				type: 'error',
				data: {
					errorCode: 'agent_busy',
					message: 'Session is busy with an ongoing task. Please abort first.',
					availableAgents,
				},
				timestamp: new Date().toISOString(),
			});
			return;
		}

		// 验证 agentId 是否存在
		if (!mainAgentManager.isValidAgentId(agentId)) {
			const availableAgents = mainAgentManager.listAvailableAgents();
			sendEvent({
				type: 'error',
				data: {
					errorCode: 'agent_not_found',
					message: `Agent not found: ${agentId}`,
					availableAgents,
				},
				timestamp: new Date().toISOString(),
			});
			return;
		}

		// 获取当前主代理ID
		const previousAgentId = this.getSessionAgentId(targetSessionId);

		// 执行切换
		this.setSessionAgentId(targetSessionId, agentId);

		// 获取新主代理信息
		const agentConfig = mainAgentManager.getAgentConfig(agentId);
		const agentName = agentConfig.basicInfo.name;

		// 发送切换成功事件
		sendEvent({
			type: 'agent_switched',
			data: {
				previousAgentId,
				currentAgentId: agentId,
				agentName,
			},
			timestamp: new Date().toISOString(),
		});

		this.log(
			`Session ${targetSessionId} switched agent: ${previousAgentId} -> ${agentId}`,
			'info',
		);
	}

	/**
	 * 检查 session 是否处于忙碌状态
	 */
	private isSessionBusy(sessionId: string): boolean {
		// 检查是否有进行中的 AbortController（对话进行中）
		if (this.sessionControllers.has(sessionId)) {
			return true;
		}

		// 检查是否有待处理的交互请求
		for (const interaction of this.pendingInteractions.values()) {
			// 通过 sessionId 字段精确匹配
			if (interaction.sessionId === sessionId) {
				return true;
			}
		}

		return false;
	}

	/**
	 * 获取会话的当前主代理ID
	 */
	private getSessionAgentId(sessionId: string): string {
		return this.sessionAgentIds.get(sessionId) || this.defaultAgentId;
	}

	/**
	 * 设置会话的主代理ID
	 */
	private setSessionAgentId(sessionId: string, agentId: string): void {
		this.sessionAgentIds.set(sessionId, agentId);
	}

	/**
	 * 发送可用主代理列表到客户端
	 */
	private sendAgentList(
		sessionId: string,
		sendEvent: (event: SSEEvent) => void,
	): void {
		const agents = mainAgentManager.listAvailableAgents();
		const currentAgentId = this.getSessionAgentId(sessionId);

		sendEvent({
			type: 'agent_list',
			data: {
				agents,
				currentAgentId,
			},
			timestamp: new Date().toISOString(),
		});
	}

	/**
	 * 生成请求ID
	 */
	private generateRequestId(): string {
		return randomUUID();
	}

	/**
	 * 广播事件
	 */
	broadcast(event: SSEEvent): void {
		if (this.server) {
			this.server.broadcast(event);
		}
	}

	/**
	 * 获取运行状态
	 */
	isServerRunning(): boolean {
		return this.isRunning;
	}

	/**
	 * 获取连接数
	 */
	getConnectionCount(): number {
		return this.server?.getConnectionCount() ?? 0;
	}
}

// 导出单例
export const sseManager = new SSEManager();
