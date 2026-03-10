import {useState, type Dispatch, type SetStateAction} from 'react';
import {reloadConfig} from '../../utils/config/apiConfig.js';
import {
	getAllProfiles,
	getActiveProfileName,
	switchProfile,
} from '../../utils/config/configManager.js';
import {mainAgentManager} from '../../utils/MainAgentManager.js';

export type PanelState = {
	showSessionPanel: boolean;
	showMcpPanel: boolean;
	showUsagePanel: boolean;
	showCustomCommandConfig: boolean;
	showSkillsCreation: boolean;
	showWorkingDirPanel: boolean;
	showPermissionsPanel: boolean;
	showReviewCommitPanel: boolean;
	showBranchPanel: boolean;
	showProfilePanel: boolean;
	showModelsPanel: boolean;
	showDiffReviewPanel: boolean;
	showConnectionPanel: boolean;
	showNewPromptPanel: boolean;
	showTodoListPanel: boolean;
	connectionPanelApiUrl?: string;
	profileSelectedIndex: number;
	profileSearchQuery: string;
	currentProfileName: string;
	showMainAgentPanel: boolean;
	mainAgentSelectedIndex: number;
	mainAgentSearchQuery: string;
	mcpPanelSource: 'chat' | 'mcpConfig';
};

export type PanelActions = {
	setShowSessionPanel: Dispatch<SetStateAction<boolean>>;
	setShowConnectionPanel: Dispatch<SetStateAction<boolean>>;
	setShowNewPromptPanel: Dispatch<SetStateAction<boolean>>;
	setConnectionPanelApiUrl: Dispatch<SetStateAction<string | undefined>>;
	setShowMcpPanel: Dispatch<SetStateAction<boolean>>;
	setShowUsagePanel: Dispatch<SetStateAction<boolean>>;
	setShowCustomCommandConfig: Dispatch<SetStateAction<boolean>>;
	setShowSkillsCreation: Dispatch<SetStateAction<boolean>>;
	setShowWorkingDirPanel: Dispatch<SetStateAction<boolean>>;
	setShowPermissionsPanel: Dispatch<SetStateAction<boolean>>;
	setShowReviewCommitPanel: Dispatch<SetStateAction<boolean>>;
	setShowBranchPanel: Dispatch<SetStateAction<boolean>>;
	setShowProfilePanel: Dispatch<SetStateAction<boolean>>;
	setShowModelsPanel: Dispatch<SetStateAction<boolean>>;
	setShowDiffReviewPanel: Dispatch<SetStateAction<boolean>>;
	setShowTodoListPanel: Dispatch<SetStateAction<boolean>>;
	setProfileSelectedIndex: Dispatch<SetStateAction<number>>;
	setProfileSearchQuery: Dispatch<SetStateAction<string>>;
	setShowMainAgentPanel: Dispatch<SetStateAction<boolean>>;
	setMainAgentSelectedIndex: Dispatch<SetStateAction<number>>;
	setMainAgentSearchQuery: Dispatch<SetStateAction<string>>;
	setMcpPanelSource: Dispatch<SetStateAction<'chat' | 'mcpConfig'>>;
	handleSwitchProfile: (options: {
		isStreaming: boolean;
		hasPendingRollback: boolean;
		hasPendingToolConfirmation: boolean;
		hasPendingUserQuestion: boolean;
	}) => void;
	handleProfileSelect: (profileName: string) => void;
	handleSwitchMainAgent: (options: {
		isStreaming: boolean;
		hasPendingRollback: boolean;
		hasPendingToolConfirmation: boolean;
		hasPendingUserQuestion: boolean;
	}) => void;
	handleMainAgentSelect: (agentId: string) => void;
	handleEscapeKey: () => boolean; // 返回 true 表示本层已处理 ESC.
	isAnyPanelOpen: () => boolean;
};

/**
 * UI 面板状态管理.
 * - 统一持有各面板 show/hide 状态与选择器状态.
 * - 提供快捷键触发的切换入口,并在有其它遮挡/面板时阻止打开新面板,避免焦点冲突.
 */
export function usePanelState(): PanelState & PanelActions {
	const [showSessionPanel, setShowSessionPanel] = useState(false);
	const [showMcpPanel, setShowMcpPanel] = useState(false);
	const [showUsagePanel, setShowUsagePanel] = useState(false);
	const [showCustomCommandConfig, setShowCustomCommandConfig] = useState(false);
	const [showSkillsCreation, setShowSkillsCreation] = useState(false);
	const [showWorkingDirPanel, setShowWorkingDirPanel] = useState(false);
	const [showPermissionsPanel, setShowPermissionsPanel] = useState(false);
	const [showReviewCommitPanel, setShowReviewCommitPanel] = useState(false);
	const [showBranchPanel, setShowBranchPanel] = useState(false);
	const [showProfilePanel, setShowProfilePanel] = useState(false);
	const [showModelsPanel, setShowModelsPanel] = useState(false);
	const [showDiffReviewPanel, setShowDiffReviewPanel] = useState(false);
	const [showConnectionPanel, setShowConnectionPanel] = useState(false);
	const [showNewPromptPanel, setShowNewPromptPanel] = useState(false);
	const [showTodoListPanel, setShowTodoListPanel] = useState(false);
	const [connectionPanelApiUrl, setConnectionPanelApiUrl] = useState<
		string | undefined
	>(undefined);
	const [profileSelectedIndex, setProfileSelectedIndex] = useState(0);
	const [profileSearchQuery, setProfileSearchQuery] = useState('');
	const [showMainAgentPanel, setShowMainAgentPanel] = useState(false);
	const [mainAgentSelectedIndex, setMainAgentSelectedIndex] = useState(0);
	const [mainAgentSearchQuery, setMainAgentSearchQuery] = useState('');
	const [mcpPanelSource, setMcpPanelSource] = useState<'chat' | 'mcpConfig'>(
		'chat',
	);
	const [currentProfileName, setCurrentProfileName] = useState(() => {
		const profiles = getAllProfiles();
		const activeName = getActiveProfileName();
		const profile = profiles.find(p => p.name === activeName);
		return profile?.displayName || activeName;
	});

	const handleSwitchProfile = (options: {
		isStreaming: boolean;
		hasPendingRollback: boolean;
		hasPendingToolConfirmation: boolean;
		hasPendingUserQuestion: boolean;
	}) => {
		// 面板切换前置判断: 若有任意面板打开或正在流式处理中,直接忽略(避免焦点冲突).
		if (
			showSessionPanel ||
			showMcpPanel ||
			showUsagePanel ||
			showCustomCommandConfig ||
			showSkillsCreation ||
			showWorkingDirPanel ||
			showPermissionsPanel ||
			showReviewCommitPanel ||
			showBranchPanel ||
			showProfilePanel ||
			showModelsPanel ||
			showDiffReviewPanel ||
			showConnectionPanel ||
			showNewPromptPanel ||
			showTodoListPanel ||
			options.hasPendingRollback ||
			options.hasPendingToolConfirmation ||
			options.hasPendingUserQuestion ||
			options.isStreaming
		) {
			return;
		}

		// 用 profile 选择面板替代循环切换,降低误触风险.
		setShowProfilePanel(true);
		setProfileSelectedIndex(0);
		setProfileSearchQuery('');
	};

	const handleProfileSelect = (profileName: string) => {
		// 选择后立即切换配置,并刷新生效.
		switchProfile(profileName);

		// 切换 profile 后立即 reloadConfig,让新配置立刻生效.
		reloadConfig();

		// 更新状态栏展示用的 profile 名称.
		const profiles = getAllProfiles();
		const profile = profiles.find(p => p.name === profileName);
		setCurrentProfileName(profile?.displayName || profileName);

		// 关闭面板并重置搜索状态
		setShowProfilePanel(false);
		setProfileSelectedIndex(0);
		setProfileSearchQuery('');
	};

	const handleSwitchMainAgent = (options: {
		isStreaming: boolean;
		hasPendingRollback: boolean;
		hasPendingToolConfirmation: boolean;
		hasPendingUserQuestion: boolean;
	}) => {
		// 避免多个面板同时争抢输入焦点: 仅在完全空闲状态下才允许打开主代理选择面板.
		if (
			showSessionPanel ||
			showMcpPanel ||
			showUsagePanel ||
			showCustomCommandConfig ||
			showSkillsCreation ||
			showWorkingDirPanel ||
			showPermissionsPanel ||
			showReviewCommitPanel ||
			showBranchPanel ||
			showProfilePanel ||
			showModelsPanel ||
			showDiffReviewPanel ||
			showConnectionPanel ||
			showNewPromptPanel ||
			showTodoListPanel ||
			showMainAgentPanel ||
			options.hasPendingRollback ||
			options.hasPendingToolConfirmation ||
			options.hasPendingUserQuestion ||
			options.isStreaming
		) {
			return;
		}

		setShowMainAgentPanel(true);
		setMainAgentSelectedIndex(0);
		setMainAgentSearchQuery('');
	};

	const handleMainAgentSelect = (agentId: string) => {
		mainAgentManager.setCurrentAgent(agentId);

		// 切换主代理后立即 reloadConfig,确保后续对话使用新主代理的配置与提示词.
		reloadConfig();

		// 关闭面板并重置搜索状态
		setShowMainAgentPanel(false);
		setMainAgentSelectedIndex(0);
		setMainAgentSearchQuery('');
	};

	const handleEscapeKey = (): boolean => {
		// ESC 处理: 按优先级关闭面板,避免多个面板各自处理导致状态错乱.
		if (showSessionPanel) {
			setShowSessionPanel(false);
			return true;
		}

		if (showMcpPanel) {
			setShowMcpPanel(false);
			return true;
		}

		if (showUsagePanel) {
			setShowUsagePanel(false);
			return true;
		}

		// CustomCommandConfigPanel 有独立键盘状态机,此处不强行关闭,避免中断其内部流程.
		if (showCustomCommandConfig) {
			return false;
		}

		// SkillsCreationPanel 有独立键盘状态机,此处不强行关闭,避免中断其内部流程.
		if (showSkillsCreation) {
			return false;
		}

		// WorkingDirectoryPanel 有独立键盘状态机,此处不强行关闭,避免中断其内部流程.
		if (showWorkingDirPanel) {
			return false;
		}

		if (showPermissionsPanel) {
			setShowPermissionsPanel(false);
			return true;
		}

		if (showReviewCommitPanel) {
			setShowReviewCommitPanel(false);
			return true;
		}

		// BranchPanel 有独立键盘状态机,此处不强行关闭,避免中断其内部流程.
		if (showBranchPanel) {
			return false;
		}

		if (showDiffReviewPanel) {
			setShowDiffReviewPanel(false);
			return true;
		}

		// ConnectionPanel 有独立键盘状态机,此处不强行关闭,避免中断其内部流程.
		if (showConnectionPanel) {
			return false;
		}

		if (showProfilePanel) {
			setShowProfilePanel(false);
			return true;
		}

		if (showMainAgentPanel) {
			setShowMainAgentPanel(false);
			return true;
		}

		// ModelsPanel 有独立键盘状态机,此处不强行关闭,避免中断其内部流程.
		if (showModelsPanel) {
			return false;
		}

		// NewPromptPanel 有独立键盘状态机,此处不强行关闭,避免中断其内部流程.
		if (showNewPromptPanel) {
			return false;
		}

		if (showTodoListPanel) {
			setShowTodoListPanel(false);
			return true;
		}

		return false; // ESC 未处理
	};

	const isAnyPanelOpen = (): boolean => {
		return (
			showSessionPanel ||
			showMcpPanel ||
			showUsagePanel ||
			showCustomCommandConfig ||
			showSkillsCreation ||
			showWorkingDirPanel ||
			showPermissionsPanel ||
			showReviewCommitPanel ||
			showBranchPanel ||
			showProfilePanel ||
			showMainAgentPanel ||
			showModelsPanel ||
			showDiffReviewPanel ||
			showConnectionPanel ||
			showNewPromptPanel ||
			showTodoListPanel
		);
	};

	return {
		// State
		showSessionPanel,
		showMcpPanel,
		showUsagePanel,
		showCustomCommandConfig,
		showSkillsCreation,
		showWorkingDirPanel,
		showPermissionsPanel,
		showReviewCommitPanel,
		showBranchPanel,
		showProfilePanel,
		showModelsPanel,
		showDiffReviewPanel,
		showConnectionPanel,
		showNewPromptPanel,
		showTodoListPanel,
		connectionPanelApiUrl,
		profileSelectedIndex,
		profileSearchQuery,
		currentProfileName,
		showMainAgentPanel,
		mainAgentSelectedIndex,
		mainAgentSearchQuery,
		mcpPanelSource,
		// Actions
		setShowSessionPanel,
		setShowMcpPanel,
		setShowUsagePanel,
		setShowCustomCommandConfig,
		setShowSkillsCreation,
		setShowWorkingDirPanel,
		setShowPermissionsPanel,
		setShowReviewCommitPanel,
		setShowBranchPanel,
		setShowProfilePanel,
		setShowModelsPanel,
		setShowDiffReviewPanel,
		setShowConnectionPanel,
		setShowNewPromptPanel,
		setShowTodoListPanel,
		setConnectionPanelApiUrl,
		setProfileSelectedIndex,
		setProfileSearchQuery,
		setShowMainAgentPanel,
		setMainAgentSelectedIndex,
		setMainAgentSearchQuery,
		setMcpPanelSource,
		handleSwitchProfile,
		handleProfileSelect,
		handleSwitchMainAgent,
		handleMainAgentSelect,
		handleEscapeKey,
		isAnyPanelOpen,
	};
}
