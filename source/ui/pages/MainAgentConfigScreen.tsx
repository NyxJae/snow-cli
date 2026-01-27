import React, {useState, useCallback, useMemo, useEffect} from 'react';
import {Box, Text, useInput} from 'ink';
import {existsSync, unlinkSync} from 'fs';
import TextInput from 'ink-text-input';
import {Alert, Spinner} from '@inkjs/ui';
import {getMCPServicesInfo} from '../../utils/execution/mcpToolsManager.js';
import type {MCPServiceTools} from '../../utils/execution/mcpToolsManager.js';
import {
	loadMainAgentConfig,
	saveMainAgentConfig,
	existsMainAgentConfig,
	getMainAgentConfigPath,
} from '../../utils/MainAgentConfigIO.js';
import type {MainAgentConfig} from '../../types/MainAgentConfig.js';
import {getSubAgents} from '../../utils/config/subAgentConfig.js';
import {getBuiltinMainAgentConfigs} from '../../config/DefaultMainAgentConfig.js';
import {useI18n} from '../../i18n/index.js';
import {useTheme} from '../contexts/ThemeContext.js';

// Focus event handling - prevent terminal focus events from appearing as input
const focusEventTokenRegex = /(?:\x1b)?\[[0-9;]*[IO]/g;

const isFocusEventInput = (value?: string) => {
	if (!value) {
		return false;
	}

	if (
		value === '\x1b[I' ||
		value === '\x1b[O' ||
		value === '[I' ||
		value === '[O'
	) {
		return true;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return false;
	}

	const tokens = trimmed.match(focusEventTokenRegex);
	if (!tokens) {
		return false;
	}

	const normalized = trimmed.replace(/\s+/g, '');
	const tokensCombined = tokens.join('');
	return tokensCombined === normalized;
};

const stripFocusArtifacts = (value: string) => {
	if (!value) {
		return '';
	}

	return value
		.replace(/\x1b\[[0-9;]*[IO]/g, '')
		.replace(/\[[0-9;]*[IO]/g, '')
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
};

type Props = {
	onBack: () => void;
	onSave: () => void;
	inlineMode?: boolean;
	agentId?: string; // 主代理ID（general 或 team），undefined表示新增模式
};

type ToolCategory = {
	name: string;
	tools: string[];
};

type FormField =
	| 'name'
	| 'description'
	| 'mainAgentRole'
	| 'tools'
	| 'subAgents';

export default function MainAgentConfigScreen({
	onBack,
	onSave,
	inlineMode = false,
	agentId,
}: Props) {
	const {theme} = useTheme();
	const {t} = useI18n();
	const [agentName, setAgentName] = useState('');
	const [description, setDescription] = useState('');
	const [mainAgentRole, setMainAgentRole] = useState('');
	const [mainAgentRoleExpanded, setMainAgentRoleExpanded] = useState(false);
	const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
	const [selectedSubAgents, setSelectedSubAgents] = useState<Set<string>>(
		new Set(),
	);
	const [currentField, setCurrentField] = useState<FormField>('name');
	const [selectedCategoryIndex, setSelectedCategoryIndex] = useState(0);
	const [selectedToolIndex, setSelectedToolIndex] = useState(0);
	const [selectedSubAgentIndex, setSelectedSubAgentIndex] = useState(0);
	const [showSuccess, setShowSuccess] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [isLoadingMCP, setIsLoadingMCP] = useState(true);
	const [mcpServices, setMcpServices] = useState<MCPServiceTools[]>([]);
	const [loadError, setLoadError] = useState<string | null>(null);

	const toolCategories: ToolCategory[] = [
		{
			name: t.subAgentConfig.filesystemTools,
			tools: [
				'filesystem-read',
				'filesystem-create',
				'filesystem-edit',
				'filesystem-edit_search',
				'filesystem-undo',
			],
		},
		{
			name: t.subAgentConfig.terminalTools,
			tools: ['terminal-execute'],
		},
		{
			name: t.subAgentConfig.aceTools,
			tools: [
				'ace-find_definition',
				'ace-find_references',
				'ace-semantic_search',
				'ace-text_search',
				'ace-file_outline',
			],
		},
		{
			name: t.subAgentConfig.codebaseTools,
			tools: ['codebase-search'],
		},
		{
			name: t.subAgentConfig.todoTools,
			tools: ['todo-get', 'todo-update', 'todo-add', 'todo-delete'],
		},
		{
			name: t.subAgentConfig.usefulInfoTools || 'Useful Information',
			tools: ['useful-info-add', 'useful-info-delete', 'useful-info-list'],
		},
		{
			name: t.subAgentConfig.notebookTools || 'Notebook',
			tools: [
				'notebook-add',
				'notebook-query',
				'notebook-update',
				'notebook-delete',
				'notebook-list',
			],
		},
		{
			name: t.subAgentConfig.webSearchTools,
			tools: ['websearch-search', 'websearch-fetch'],
		},
		{
			name: t.subAgentConfig.ideTools,
			tools: ['ide-get_diagnostics'],
		},
		{
			name: t.subAgentConfig.userInteractionTools || 'User Interaction',
			tools: ['askuser-ask_question'],
		},
		{
			name: t.subAgentConfig.skillTools || 'Skills',
			tools: ['skill-execute'],
		},
	];

	// Load available sub-agents
	const availableSubAgents = useMemo(() => {
		const agents = getSubAgents();
		return agents.map(agent => ({
			id: agent.id,
			name: agent.name,
		}));
	}, []);

	// Load agent data on mount
	useEffect(() => {
		// 新增模式：agentId 为 undefined
		if (!agentId) {
			// 设置默认值
			setAgentName('');
			setDescription('');
			setMainAgentRole(
				'你是Snow AI CLI自定义主代理。\n\n请根据用户需求提供帮助。',
			);
			setSelectedTools(new Set());
			setSelectedSubAgents(new Set());
			return;
		}

		// 编辑模式：检查配置文件是否存在
		const hasConfigFile = existsMainAgentConfig();
		let agent: MainAgentConfig | undefined;

		if (hasConfigFile) {
			// 有配置文件：先尝试加载用户自定义配置
			const configFile = loadMainAgentConfig();
			agent = configFile.agents[agentId];

			// 如果该代理没有被自定义，回退到内置配置
			if (!agent) {
				const builtinConfigs = getBuiltinMainAgentConfigs();
				agent = builtinConfigs[agentId];
			}
		} else {
			// 没有配置文件：直接使用代码内置配置
			const builtinConfigs = getBuiltinMainAgentConfigs();
			agent = builtinConfigs[agentId];
		}

		if (agent) {
			setAgentName(agent.basicInfo.name);
			setDescription(agent.basicInfo.description);
			setMainAgentRole(agent.mainAgentRole || '');
			// 处理工具配置：MainAgentConfig的tools已经是string[]类型
			const tools = Array.isArray(agent.tools) ? agent.tools : [];
			// 注意：这里不进行反向映射，因为主代理配置界面需要等待MCP服务加载
			// 反向映射将在MCP服务加载后的useEffect中处理
			setSelectedTools(new Set(tools));

			// 处理子代理配置：过滤掉不存在的子代理
			const availableSubAgents = getSubAgents();
			const availableSubAgentIds = new Set(
				availableSubAgents.map(sub => sub.id),
			);
			const validSubAgents = (agent.availableSubAgents || []).filter(subId =>
				availableSubAgentIds.has(subId),
			);
			setSelectedSubAgents(new Set(validSubAgents));
		}
	}, [agentId]);

	// Load MCP services on mount
	useEffect(() => {
		const loadMCPServices = async () => {
			try {
				setIsLoadingMCP(true);
				setLoadError(null);
				const services = await getMCPServicesInfo();
				setMcpServices(services);
			} catch (error) {
				setLoadError(
					error instanceof Error
						? error.message
						: 'Failed to load MCP services',
				);
			} finally {
				setIsLoadingMCP(false);
			}
		};

		loadMCPServices();
	}, []);

	// Load and convert agent tools when MCP services are loaded
	useEffect(() => {
		if (mcpServices.length > 0 && agentId) {
			// 检查配置文件是否存在
			const hasConfigFile = existsMainAgentConfig();
			let agent: MainAgentConfig | undefined;
			if (hasConfigFile) {
				// 有配置文件：加载用户自定义配置
				const configFile = loadMainAgentConfig();
				agent = configFile.agents[agentId];
			} else {
				// 没有配置文件：使用代码内置配置
				const builtinConfigs = getBuiltinMainAgentConfigs();
				agent = builtinConfigs[agentId];
			}

			if (agent && agent.tools && agent.tools.length > 0) {
				// 反向映射：将完整格式的工具名转换为UI显示的纯工具名
				const reverseToolMapping = new Map<string, string>();

				// 为每个MCP服务创建反向映射
				for (const service of mcpServices) {
					if (
						!service.isBuiltIn &&
						service.connected &&
						service.tools.length > 0
					) {
						for (const tool of service.tools) {
							const fullName = `${service.serviceName}-${tool.name}`;
							reverseToolMapping.set(fullName, tool.name); // 完整名 -> 纯名
						}
					}
				}

				// 转换存储的工具名
				const convertedTools = agent.tools.map(toolName => {
					// 如果是内置工具，直接返回 - 使用静态检查避免依赖问题
					const isBuiltIn = [
						'filesystem-read',
						'filesystem-create',
						'filesystem-edit',
						'filesystem-edit_search',
						'filesystem-undo',
						'ace-find_definition',
						'ace-find_references',
						'ace-semantic_search',
						'ace-text_search',
						'ace-file_outline',
						'codebase-search',
						'terminal-execute',
						'todo-get',
						'todo-update',
						'todo-add',
						'todo-delete',
						'useful-info-add',
						'useful-info-delete',
						'useful-info-list',
						'notebook-add',
						'notebook-query',
						'notebook-update',
						'notebook-delete',
						'notebook-list',
						'websearch-search',
						'websearch-fetch',
						'ide-get_diagnostics',
						'askuser-ask_question',
						'skill-execute',
					].includes(toolName);

					if (isBuiltIn) {
						return toolName;
					}
					// 尝试反向映射
					return reverseToolMapping.get(toolName) || toolName;
				});

				setSelectedTools(new Set(convertedTools));
			}
		}
	}, [agentId, mcpServices]); // 移除 toolCategories 依赖

	// Combine built-in and MCP tool categories
	const allToolCategories = useMemo(() => {
		const categories = [...toolCategories];

		// Add custom MCP services as separate categories
		for (const service of mcpServices) {
			if (!service.isBuiltIn && service.connected && service.tools.length > 0) {
				categories.push({
					name: `${service.serviceName} ${t.subAgentConfig.categoryMCP}`,
					tools: service.tools.map(t => t.name),
				});
			}
		}

		return categories;
	}, [mcpServices, toolCategories, t]);

	// Get all available tools
	const allTools = useMemo(
		() => allToolCategories.flatMap(cat => cat.tools),
		[allToolCategories],
	);

	const handleToggleTool = useCallback((tool: string) => {
		setSelectedTools(prev => {
			const newSet = new Set(prev);
			if (newSet.has(tool)) {
				newSet.delete(tool);
			} else {
				newSet.add(tool);
			}
			return newSet;
		});
	}, []);

	const handleToggleCategory = useCallback(() => {
		const category = allToolCategories[selectedCategoryIndex];
		if (!category) return;

		const allSelected = category.tools.every(tool => selectedTools.has(tool));

		setSelectedTools(prev => {
			const newSet = new Set(prev);
			if (allSelected) {
				// Deselect all in category
				category.tools.forEach(tool => newSet.delete(tool));
			} else {
				// Select all in category
				category.tools.forEach(tool => newSet.add(tool));
			}
			return newSet;
		});
	}, [selectedCategoryIndex, selectedTools, allToolCategories]);

	const handleToggleCurrentTool = useCallback(() => {
		const category = allToolCategories[selectedCategoryIndex];
		if (!category) return;

		const tool = category.tools[selectedToolIndex];
		if (tool) {
			handleToggleTool(tool);
		}
	}, [
		selectedCategoryIndex,
		selectedToolIndex,
		handleToggleTool,
		allToolCategories,
	]);

	const handleToggleSubAgent = useCallback((subAgentId: string) => {
		setSelectedSubAgents(prev => {
			const newSet = new Set(prev);
			if (newSet.has(subAgentId)) {
				newSet.delete(subAgentId);
			} else {
				newSet.add(subAgentId);
			}
			return newSet;
		});
	}, []);

	const handleToggleCurrentSubAgent = useCallback(() => {
		const subAgent = availableSubAgents[selectedSubAgentIndex];
		if (subAgent) {
			handleToggleSubAgent(subAgent.id);
		}
	}, [selectedSubAgentIndex, handleToggleSubAgent, availableSubAgents]);

	const handleSave = useCallback(() => {
		setSaveError(null);

		// Validate
		if (!agentName.trim()) {
			setSaveError('Agent name is required');
			return;
		}
		if (!description.trim()) {
			setSaveError('Description is required');
			return;
		}
		if (selectedTools.size === 0) {
			setSaveError('At least one tool must be selected');
			return;
		}

		try {
			// 新增模式：生成新的 agentId
			let finalAgentId = agentId;
			if (!agentId) {
				// 使用 name 作为 agentId（转换为英文格式）
				finalAgentId = agentName
					.trim()
					.toLowerCase()
					.replace(/[^a-z0-9]/g, '-')
					.replace(/-+/g, '-')
					.replace(/^-|-$/g, '');

				if (!finalAgentId) {
					setSaveError('代理名称不能为空');
					return;
				}
			}

			// 确保 finalAgentId 不为 undefined
			if (!finalAgentId) {
				setSaveError('代理ID生成失败');
				return;
			}

			// 检查是否为重置操作（与内置配置完全相同）
			const builtinConfigs = getBuiltinMainAgentConfigs();
			const builtinAgent = builtinConfigs[finalAgentId];

			const isResetToBuiltin =
				builtinAgent &&
				agentName.trim() === builtinAgent.basicInfo.name &&
				description.trim() === builtinAgent.basicInfo.description &&
				mainAgentRole.trim() === builtinAgent.mainAgentRole.trim() &&
				JSON.stringify(Array.from(selectedTools).sort()) ===
					JSON.stringify((builtinAgent.tools || []).sort()) &&
				JSON.stringify(Array.from(selectedSubAgents).sort()) ===
					JSON.stringify((builtinAgent.availableSubAgents || []).sort());

			// 智能加载配置：如果配置文件不存在，只创建当前编辑代理的配置
			let configFile: import('../../types/MainAgentConfig.js').MainAgentConfigFile;
			const configExists = existsMainAgentConfig();

			if (configExists) {
				// 配置文件存在，加载完整配置
				configFile = loadMainAgentConfig();
			} else {
				// 配置文件不存在，创建只包含当前代理的空配置
				configFile = {
					agents: {},
				};
			}

			if (isResetToBuiltin) {
				// 重置操作：删除对应的主代理配置
				if (configFile.agents[finalAgentId]) {
					delete configFile.agents[finalAgentId];

					// 如果两个主代理都重置了，删除配置文件
					const remainingAgents = Object.keys(configFile.agents);
					if (remainingAgents.length === 0) {
						// 删除配置文件
						const configPath = getMainAgentConfigPath();
						if (existsSync(configPath)) {
							unlinkSync(configPath);
						}
					} else {
						// 保存剩余的配置
						saveMainAgentConfig(configFile);
					}
				}
			} else {
				// 正常保存操作：创建或更新配置
				const existingAgent = configFile.agents[finalAgentId];

				// 新增模式：检查 ID 是否已存在
				if (!agentId && existingAgent) {
					setSaveError('代理ID已存在，请使用不同的名称');
					return;
				}
				// 只有在编辑模式下才检查代理是否存在
				if (agentId && !existingAgent && !builtinAgent) {
					setSaveError(`Agent ${finalAgentId} not found`);
					return;
				}

				// 清理不存在的子代理ID
				const availableSubAgents = getSubAgents();
				const availableSubAgentIds = new Set(
					availableSubAgents.map(sub => sub.id),
				);
				const validSubAgents = Array.from(selectedSubAgents).filter(subId =>
					availableSubAgentIds.has(subId),
				);

				// 创建工具名映射，将用户选择的纯工具名转换为完整格式
				const toolNameMapping = new Map<string, string>();

				// 为每个MCP服务创建工具名映射
				for (const service of mcpServices) {
					if (
						!service.isBuiltIn &&
						service.connected &&
						service.tools.length > 0
					) {
						for (const tool of service.tools) {
							const fullName = `${service.serviceName}-${tool.name}`;
							toolNameMapping.set(tool.name, fullName);
						}
					}
				}

				// 获取所有内置工具名列表（用于精确匹配）
				const builtInToolNames = new Set<string>();
				for (const category of toolCategories) {
					for (const tool of category.tools) {
						builtInToolNames.add(tool);
					}
				}

				// 映射选中的工具名
				const mappedSelectedTools = Array.from(selectedTools).map(toolId => {
					// 如果是内置工具，直接返回
					if (builtInToolNames.has(toolId)) {
						return toolId;
					}
					// 尝试映射用户选择的纯工具名
					return toolNameMapping.get(toolId) || toolId;
				});

				// 创建包含完整格式工具ID的可用工具集合，用于验证映射后的工具
				const availableToolIds = new Set([
					// 内置工具使用纯名称
					...toolCategories.flatMap(cat => cat.tools),
					// MCP工具使用完整格式
					...mcpServices
						.filter(service => !service.isBuiltIn && service.connected)
						.flatMap(service =>
							service.tools.map(tool => `${service.serviceName}-${tool.name}`),
						),
				]);
				const validTools = mappedSelectedTools.filter(toolId =>
					availableToolIds.has(toolId),
				);

				// 清理配置文件中所有代理的无效子代理ID和工具ID
				for (const [existingAgentId, existingAgentConfig] of Object.entries(
					configFile.agents,
				)) {
					let needsUpdate = false;
					const updatedConfig = {...existingAgentConfig};

					// 清理无效的子代理ID
					if (existingAgentConfig.availableSubAgents) {
						const cleanedSubAgents =
							existingAgentConfig.availableSubAgents.filter(subId =>
								availableSubAgentIds.has(subId),
							);
						if (
							cleanedSubAgents.length !==
							existingAgentConfig.availableSubAgents.length
						) {
							updatedConfig.availableSubAgents = cleanedSubAgents;
							needsUpdate = true;
						}
					}

					// 清理无效的工具ID
					if (existingAgentConfig.tools) {
						const cleanedTools = existingAgentConfig.tools.filter(toolId =>
							availableToolIds.has(toolId),
						);
						if (cleanedTools.length !== existingAgentConfig.tools.length) {
							updatedConfig.tools = cleanedTools;
							needsUpdate = true;
						}
					}

					// 只有在需要更新时才设置新配置
					if (needsUpdate) {
						configFile.agents[existingAgentId] = updatedConfig;
					}
				}

				// Update agent configuration
				let baseAgent = existingAgent ||
					builtinAgent || {
						basicInfo: {
							id: finalAgentId,
							name: '',
							description: '',
							type: 'general',
							builtin: false,
							createdAt: new Date().toISOString(),
							updatedAt: new Date().toISOString(),
						},
						tools: [],
						availableSubAgents: [],
						mainAgentRole: '',
					};

				const updatedAgent: MainAgentConfig = {
					basicInfo: {
						...baseAgent.basicInfo,
						id: finalAgentId,
						name: agentName,
						description: description,
						type: baseAgent.basicInfo.type || 'general',
						builtin: baseAgent.basicInfo.builtin,
						createdAt:
							baseAgent.basicInfo?.createdAt || new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					},
					tools: validTools,
					availableSubAgents: validSubAgents,
					mainAgentRole: mainAgentRole,
				};

				configFile.agents[finalAgentId] = updatedAgent;
				saveMainAgentConfig(configFile);
			}

			setShowSuccess(true);
			setTimeout(() => {
				setShowSuccess(false);
				onSave();
			}, 1500);
		} catch (error) {
			setSaveError(
				error instanceof Error ? error.message : 'Failed to save configuration',
			);
		}
	}, [
		agentName,
		description,
		mainAgentRole,
		selectedTools,
		selectedSubAgents,
		agentId,
		onSave,
	]);

	useInput((rawInput, key) => {
		const input = stripFocusArtifacts(rawInput);

		// Ignore focus events completely
		if (!input && isFocusEventInput(rawInput)) {
			return;
		}

		if (isFocusEventInput(rawInput)) {
			return;
		}

		if (key.escape) {
			onBack();
			return;
		}

		// Define main fields order for navigation
		const mainFields: FormField[] = [
			'name',
			'description',
			'mainAgentRole',
			'tools',
			'subAgents',
		];
		const currentFieldIndex = mainFields.indexOf(currentField);

		if (key.upArrow) {
			if (currentField === 'mainAgentRole') {
				// Jump to previous main field
				setCurrentField('description');
				return;
			} else if (currentField === 'tools') {
				// Navigate within tool list
				if (selectedToolIndex > 0) {
					setSelectedToolIndex(prev => prev - 1);
				} else if (selectedCategoryIndex > 0) {
					const prevCategory = allToolCategories[selectedCategoryIndex - 1];
					setSelectedCategoryIndex(prev => prev - 1);
					setSelectedToolIndex(
						prevCategory ? prevCategory.tools.length - 1 : 0,
					);
				} else {
					// At top of tools, jump to previous field
					setCurrentField('mainAgentRole');
				}
				return;
			} else if (currentField === 'subAgents') {
				// Navigate within sub-agent list
				if (selectedSubAgentIndex > 0) {
					setSelectedSubAgentIndex(prev => prev - 1);
				} else {
					// At top of sub-agents, jump to previous field
					setCurrentField('tools');
				}
				return;
			} else {
				// Normal field: jump to previous main field
				const prevIndex =
					currentFieldIndex > 0 ? currentFieldIndex - 1 : mainFields.length - 1;
				setCurrentField(mainFields[prevIndex]!);
				return;
			}
		}

		if (key.downArrow) {
			if (currentField === 'mainAgentRole') {
				// Jump to next main field
				setCurrentField('tools');
				setSelectedCategoryIndex(0);
				setSelectedToolIndex(0);
				return;
			} else if (currentField === 'tools') {
				// Navigate within tool list
				const currentCategory = allToolCategories[selectedCategoryIndex];
				if (!currentCategory) return;

				if (selectedToolIndex < currentCategory.tools.length - 1) {
					setSelectedToolIndex(prev => prev + 1);
				} else if (selectedCategoryIndex < allToolCategories.length - 1) {
					setSelectedCategoryIndex(prev => prev + 1);
					setSelectedToolIndex(0);
				} else {
					// At bottom of tools, jump to next field
					setCurrentField('subAgents');
					setSelectedSubAgentIndex(0);
				}
				return;
			} else if (currentField === 'subAgents') {
				// Navigate within sub-agent list
				if (selectedSubAgentIndex < availableSubAgents.length - 1) {
					setSelectedSubAgentIndex(prev => prev + 1);
				} else {
					// At bottom of sub-agents, jump to first field (循环)
					setCurrentField('name');
				}
				return;
			} else {
				// Normal field: jump to next main field
				const nextIndex =
					currentFieldIndex < mainFields.length - 1 ? currentFieldIndex + 1 : 0;
				setCurrentField(mainFields[nextIndex]!);
				return;
			}
		}

		// Main agent role field controls - Space to toggle expansion
		if (currentField === 'mainAgentRole' && input === ' ') {
			setMainAgentRoleExpanded(prev => !prev);
			return;
		}

		// Tool-specific controls
		if (currentField === 'tools') {
			if (key.leftArrow) {
				// Navigate to previous category
				if (selectedCategoryIndex > 0) {
					setSelectedCategoryIndex(prev => prev - 1);
					setSelectedToolIndex(0);
				}
				return;
			}
			if (key.rightArrow) {
				// Navigate to next category
				if (selectedCategoryIndex < allToolCategories.length - 1) {
					setSelectedCategoryIndex(prev => prev + 1);
					setSelectedToolIndex(0);
				}
				return;
			}
			if (input === ' ') {
				// Toggle current tool
				handleToggleCurrentTool();
				return;
			}
			if (input === 'a' || input === 'A') {
				// Toggle all in category
				handleToggleCategory();
				return;
			}
		}

		// Sub-agent specific controls
		if (currentField === 'subAgents') {
			if (input === ' ') {
				// Toggle current sub-agent
				handleToggleCurrentSubAgent();
				return;
			}
		}

		// Global left/right arrow navigation between main fields (except tools field which uses it for categories)
		if (key.leftArrow && currentField !== 'tools') {
			// Navigate to previous main field
			const prevIndex =
				currentFieldIndex > 0 ? currentFieldIndex - 1 : mainFields.length - 1;
			setCurrentField(mainFields[prevIndex]!);
			return;
		}

		if (key.rightArrow && currentField !== 'tools') {
			// Navigate to next main field
			const nextIndex =
				currentFieldIndex < mainFields.length - 1 ? currentFieldIndex + 1 : 0;
			setCurrentField(mainFields[nextIndex]!);
			return;
		}

		// Save with Enter key
		if (key.return) {
			handleSave();
			return;
		}
	});

	// Scrollable list rendering helper
	const renderScrollableList = <T extends {id: string; name: string}>(
		items: T[],
		selectedIndex: number,
		selectedSet: Set<string>,
		isActive: boolean,
		maxVisible = 5,
		keyPrefix: string,
	) => {
		const totalItems = items.length;

		// If no items available, show hint
		if (totalItems === 0) {
			return (
				<Box flexDirection="column">
					<Text color={theme.colors.menuSecondary} dimColor>
						{t.subAgentConfig.noItems}
					</Text>
				</Box>
			);
		}

		// Calculate visible range
		let startIndex = Math.max(0, selectedIndex - Math.floor(maxVisible / 2));
		let endIndex = Math.min(totalItems, startIndex + maxVisible);

		// Adjust start position to ensure maxVisible items are shown
		if (endIndex - startIndex < maxVisible) {
			startIndex = Math.max(0, endIndex - maxVisible);
		}

		const visibleItems = items.slice(startIndex, endIndex);
		const hasMore = totalItems > maxVisible;

		return (
			<Box flexDirection="column">
				{startIndex > 0 && (
					<Text color={theme.colors.menuSecondary} dimColor>
						↑{' '}
						{t.subAgentConfig.moreAbove.replace('{count}', String(startIndex))}
					</Text>
				)}
				{visibleItems.map((item, relativeIndex) => {
					const actualIndex = startIndex + relativeIndex;
					const isHighlighted = actualIndex === selectedIndex;
					const isSelected = selectedSet.has(item.id);
					return (
						<Box key={`${keyPrefix}-${actualIndex}`} marginY={0}>
							<Text
								color={
									isActive && isHighlighted
										? theme.colors.menuSelected
										: theme.colors.menuNormal
								}
								bold={isHighlighted}
							>
								{isActive && isHighlighted ? '❯ ' : '  '}
								{isSelected ? '[✓] ' : '[ ] '}
								{item.name}
							</Text>
						</Box>
					);
				})}
				{endIndex < totalItems && (
					<Text color={theme.colors.menuSecondary} dimColor>
						↓{' '}
						{t.subAgentConfig.moreBelow.replace(
							'{count}',
							String(totalItems - endIndex),
						)}
					</Text>
				)}
				{isActive && hasMore && totalItems > 0 && (
					<Text color={theme.colors.menuSecondary} dimColor>
						{' '}
						{t.subAgentConfig.scrollToggleHint}
					</Text>
				)}
				{isActive && !hasMore && totalItems > 0 && (
					<Text color={theme.colors.menuSecondary} dimColor>
						{' '}
						{t.subAgentConfig.spaceToggleHint}
					</Text>
				)}
			</Box>
		);
	};

	// Scrollable tools rendering helper
	const renderScrollableTools = (
		tools: string[],
		selectedIndex: number,
		maxVisible = 5,
	) => {
		const totalTools = tools.length;

		// Calculate visible range
		let startIndex = Math.max(0, selectedIndex - Math.floor(maxVisible / 2));
		let endIndex = Math.min(totalTools, startIndex + maxVisible);

		// Adjust start position to ensure maxVisible items are shown
		if (endIndex - startIndex < maxVisible) {
			startIndex = Math.max(0, endIndex - maxVisible);
		}

		const visibleTools = tools.slice(startIndex, endIndex);
		const hasMore = totalTools > maxVisible;

		return (
			<Box flexDirection="column" marginLeft={2}>
				{startIndex > 0 && (
					<Text color={theme.colors.menuSecondary} dimColor>
						↑{' '}
						{t.subAgentConfig.moreTools.replace('{count}', String(startIndex))}
					</Text>
				)}
				{visibleTools.map((tool, relativeIndex) => {
					const actualIndex = startIndex + relativeIndex;
					const isCurrentTool = actualIndex === selectedIndex;
					return (
						<Box key={tool}>
							<Text
								color={
									isCurrentTool
										? theme.colors.menuInfo
										: theme.colors.menuNormal
								}
								bold={isCurrentTool}
							>
								{isCurrentTool ? '❯ ' : '  '}
								{selectedTools.has(tool) ? '[✓]' : '[ ]'} {tool}
							</Text>
						</Box>
					);
				})}
				{endIndex < totalTools && (
					<Text color={theme.colors.menuSecondary} dimColor>
						↓{' '}
						{t.subAgentConfig.moreTools.replace(
							'{count}',
							String(totalTools - endIndex),
						)}
					</Text>
				)}
				{hasMore && (
					<Text color={theme.colors.menuSecondary} dimColor>
						{t.subAgentConfig.scrollToolsHint}
					</Text>
				)}
			</Box>
		);
	};

	const renderToolSelection = () => {
		return (
			<Box flexDirection="column">
				<Text bold color={theme.colors.menuInfo}>
					{t.subAgentConfig.toolSelection}
				</Text>

				{isLoadingMCP && (
					<Box>
						<Spinner label={t.subAgentConfig.loadingMCP} />
					</Box>
				)}

				{loadError && (
					<Box>
						<Text color={theme.colors.warning}>
							{t.subAgentConfig.mcpLoadError} {loadError}
						</Text>
					</Box>
				)}

				{allToolCategories.map((category, catIndex) => {
					const isCurrent = catIndex === selectedCategoryIndex;
					const selectedInCategory = category.tools.filter(tool =>
						selectedTools.has(tool),
					).length;

					return (
						<Box key={category.name} flexDirection="column">
							<Box>
								<Text
									color={
										isCurrent && currentField === 'tools'
											? theme.colors.menuSelected
											: theme.colors.menuNormal
									}
									bold={isCurrent && currentField === 'tools'}
								>
									{isCurrent && currentField === 'tools' ? '▶ ' : '  '}
									{category.name} ({selectedInCategory}/{category.tools.length})
								</Text>
							</Box>

							{isCurrent &&
								currentField === 'tools' &&
								renderScrollableTools(category.tools, selectedToolIndex, 5)}
						</Box>
					);
				})}

				<Text color={theme.colors.menuSecondary} dimColor>
					{t.subAgentConfig.selectedTools} {selectedTools.size} /{' '}
					{allTools.length} {t.subAgentConfig.toolsCount}
				</Text>
			</Box>
		);
	};

	const renderSubAgentSelection = () => {
		return (
			<Box flexDirection="column">
				<Text bold color={theme.colors.menuInfo}>
					Available Sub-Agents
				</Text>

				{renderScrollableList(
					availableSubAgents,
					selectedSubAgentIndex,
					selectedSubAgents,
					currentField === 'subAgents',
					5,
					'subagent',
				)}

				<Text color={theme.colors.menuSecondary} dimColor>
					Selected: {selectedSubAgents.size} / {availableSubAgents.length}
				</Text>
			</Box>
		);
	};

	return (
		<Box flexDirection="column" padding={1}>
			{!inlineMode && (
				<Box marginBottom={1}>
					<Text bold color={theme.colors.menuInfo}>
						{t.mainAgent.edit.title}
					</Text>
				</Box>
			)}

			{showSuccess && (
				<Box marginBottom={1}>
					<Alert variant="success">
						{agentName
							? t.mainAgent.edit.saveSuccess.replace('{agentName}', agentName)
							: t.mainAgent.edit.saveSuccess.replace('{agentName}', '主代理')}
					</Alert>
				</Box>
			)}

			{saveError && (
				<Box marginBottom={1}>
					<Alert variant="error">{saveError}</Alert>
				</Box>
			)}

			<Box flexDirection="column">
				{/* Agent Name */}
				<Box flexDirection="column">
					<Text
						bold
						color={
							currentField === 'name'
								? theme.colors.menuSelected
								: theme.colors.menuNormal
						}
					>
						Agent Name
					</Text>
					<Box marginLeft={2}>
						<TextInput
							value={agentName}
							onChange={value => setAgentName(stripFocusArtifacts(value))}
							placeholder="Enter agent name"
							focus={currentField === 'name'}
						/>
					</Box>
				</Box>

				{/* Description */}
				<Box flexDirection="column">
					<Text
						bold
						color={
							currentField === 'description'
								? theme.colors.menuSelected
								: theme.colors.menuNormal
						}
					>
						Description
					</Text>
					<Box marginLeft={2}>
						<TextInput
							value={description}
							onChange={value => setDescription(stripFocusArtifacts(value))}
							placeholder="Enter agent description"
							focus={currentField === 'description'}
						/>
					</Box>
				</Box>

				{/* Main Agent Role */}
				<Box flexDirection="column">
					<Text
						bold
						color={
							currentField === 'mainAgentRole'
								? theme.colors.menuSelected
								: theme.colors.menuNormal
						}
					>
						Main Agent Role
						{mainAgentRole && mainAgentRole.length > 100 && (
							<Text color={theme.colors.menuSecondary} dimColor>
								{' '}
								{t.subAgentConfig.roleExpandHint.replace(
									'{status}',
									mainAgentRoleExpanded
										? t.subAgentConfig.roleExpanded
										: t.subAgentConfig.roleCollapsed,
								)}
							</Text>
						)}
					</Text>
					<Box marginLeft={2} flexDirection="column">
						{mainAgentRole &&
						mainAgentRole.length > 100 &&
						!mainAgentRoleExpanded ? (
							<Text color={theme.colors.menuNormal}>
								{mainAgentRole.substring(0, 100)}...
								<Text color={theme.colors.menuSecondary} dimColor>
									{' '}
									{t.subAgentConfig.roleViewFull}
								</Text>
							</Text>
						) : (
							<TextInput
								value={mainAgentRole}
								onChange={value => setMainAgentRole(stripFocusArtifacts(value))}
								placeholder="Enter main agent role"
								focus={currentField === 'mainAgentRole'}
							/>
						)}
					</Box>
				</Box>

				{/* Tool Selection */}
				{renderToolSelection()}

				{/* Sub-Agent Selection */}
				{renderSubAgentSelection()}

				{/* Instructions */}
				<Box marginTop={1}>
					<Text color={theme.colors.menuSecondary} dimColor>
						↑↓: Navigate | ←→: Switch category | Space: Toggle | Enter: Save |
						Esc: Back
					</Text>
				</Box>
			</Box>
		</Box>
	);
}
