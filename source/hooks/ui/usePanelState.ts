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
	showHelpPanel: boolean;
	showCustomCommandConfig: boolean;
	showSkillsCreation: boolean;
	showWorkingDirPanel: boolean;
	showPermissionsPanel: boolean;
	showReviewCommitPanel: boolean;
	showProfilePanel: boolean;
	profileSelectedIndex: number;
	profileSearchQuery: string;
	currentProfileName: string;
	showMainAgentPanel: boolean;
	mainAgentSelectedIndex: number;
	mainAgentSearchQuery: string;
};

export type PanelActions = {
	setShowSessionPanel: Dispatch<SetStateAction<boolean>>;
	setShowMcpPanel: Dispatch<SetStateAction<boolean>>;
	setShowUsagePanel: Dispatch<SetStateAction<boolean>>;
	setShowHelpPanel: Dispatch<SetStateAction<boolean>>;
	setShowCustomCommandConfig: Dispatch<SetStateAction<boolean>>;
	setShowSkillsCreation: Dispatch<SetStateAction<boolean>>;
	setShowWorkingDirPanel: Dispatch<SetStateAction<boolean>>;
	setShowPermissionsPanel: Dispatch<SetStateAction<boolean>>;
	setShowReviewCommitPanel: Dispatch<SetStateAction<boolean>>;
	setShowProfilePanel: Dispatch<SetStateAction<boolean>>;
	setProfileSelectedIndex: Dispatch<SetStateAction<number>>;
	setProfileSearchQuery: Dispatch<SetStateAction<string>>;
	setShowMainAgentPanel: Dispatch<SetStateAction<boolean>>;
	setMainAgentSelectedIndex: Dispatch<SetStateAction<number>>;
	setMainAgentSearchQuery: Dispatch<SetStateAction<string>>;
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
	handleEscapeKey: () => boolean; // Returns true if ESC was handled
	isAnyPanelOpen: () => boolean;
};

export function usePanelState(): PanelState & PanelActions {
	const [showSessionPanel, setShowSessionPanel] = useState(false);
	const [showMcpPanel, setShowMcpPanel] = useState(false);
	const [showUsagePanel, setShowUsagePanel] = useState(false);
	const [showHelpPanel, setShowHelpPanel] = useState(false);
	const [showCustomCommandConfig, setShowCustomCommandConfig] = useState(false);
	const [showSkillsCreation, setShowSkillsCreation] = useState(false);
	const [showWorkingDirPanel, setShowWorkingDirPanel] = useState(false);
	const [showPermissionsPanel, setShowPermissionsPanel] = useState(false);
	const [showReviewCommitPanel, setShowReviewCommitPanel] = useState(false);
	const [showProfilePanel, setShowProfilePanel] = useState(false);
	const [profileSelectedIndex, setProfileSelectedIndex] = useState(0);
	const [profileSearchQuery, setProfileSearchQuery] = useState('');
	const [showMainAgentPanel, setShowMainAgentPanel] = useState(false);
	const [mainAgentSelectedIndex, setMainAgentSelectedIndex] = useState(0);
	const [mainAgentSearchQuery, setMainAgentSearchQuery] = useState('');
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
		// Don't switch if any panel is open or streaming
		if (
			showSessionPanel ||
			showMcpPanel ||
			showUsagePanel ||
			showHelpPanel ||
			showCustomCommandConfig ||
			showSkillsCreation ||
			showWorkingDirPanel ||
			showPermissionsPanel ||
			showReviewCommitPanel ||
			showProfilePanel ||
			options.hasPendingRollback ||
			options.hasPendingToolConfirmation ||
			options.hasPendingUserQuestion ||
			options.isStreaming
		) {
			return;
		}

		// Show profile selection panel instead of cycling
		setShowProfilePanel(true);
		setProfileSelectedIndex(0);
		setProfileSearchQuery('');
	};

	const handleProfileSelect = (profileName: string) => {
		// Switch to selected profile
		switchProfile(profileName);

		// Reload config to pick up new profile's configuration
		reloadConfig();

		// Update display name
		const profiles = getAllProfiles();
		const profile = profiles.find(p => p.name === profileName);
		setCurrentProfileName(profile?.displayName || profileName);

		// Close panel and reset search
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
		// Don't switch if any panel is open or streaming
		if (
			showSessionPanel ||
			showMcpPanel ||
			showUsagePanel ||
			showHelpPanel ||
			showCustomCommandConfig ||
			showSkillsCreation ||
			showWorkingDirPanel ||
			showPermissionsPanel ||
			showReviewCommitPanel ||
			showProfilePanel ||
			showMainAgentPanel ||
			options.hasPendingRollback ||
			options.hasPendingToolConfirmation ||
			options.hasPendingUserQuestion ||
			options.isStreaming
		) {
			return;
		}

		// Show main agent selection panel
		setShowMainAgentPanel(true);
		setMainAgentSelectedIndex(0);
		setMainAgentSearchQuery('');
	};

	const handleMainAgentSelect = (agentId: string) => {
		// Switch to selected main agent
		mainAgentManager.setCurrentAgent(agentId);

		// Reload config to pick up new agent's configuration
		reloadConfig();

		// Close panel and reset search
		setShowMainAgentPanel(false);
		setMainAgentSelectedIndex(0);
		setMainAgentSearchQuery('');
	};

	const handleEscapeKey = (): boolean => {
		// Check each panel in priority order and close if open
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

		if (showHelpPanel) {
			setShowHelpPanel(false);
			return true;
		}

		if (showCustomCommandConfig) {
			setShowCustomCommandConfig(false);
			return true;
		}

		if (showSkillsCreation) {
			setShowSkillsCreation(false);
			return true;
		}

		if (showWorkingDirPanel) {
			setShowWorkingDirPanel(false);
			return true;
		}

		if (showPermissionsPanel) {
			setShowPermissionsPanel(false);
			return true;
		}

		if (showReviewCommitPanel) {
			setShowReviewCommitPanel(false);
			return true;
		}

		if (showProfilePanel) {
			setShowProfilePanel(false);
			return true;
		}
		if (showMainAgentPanel) {
			setShowMainAgentPanel(false);
			return true;
		}

		return false; // ESC not handled
	};

	const isAnyPanelOpen = (): boolean => {
		return (
			showSessionPanel ||
			showMcpPanel ||
			showUsagePanel ||
			showHelpPanel ||
			showCustomCommandConfig ||
			showSkillsCreation ||
			showWorkingDirPanel ||
			showPermissionsPanel ||
			showReviewCommitPanel ||
			showProfilePanel ||
			showMainAgentPanel
		);
	};

	return {
		// State
		showSessionPanel,
		showMcpPanel,
		showUsagePanel,
		showHelpPanel,
		showCustomCommandConfig,
		showSkillsCreation,
		showWorkingDirPanel,
		showPermissionsPanel,
		showReviewCommitPanel,
		showProfilePanel,
		profileSelectedIndex,
		profileSearchQuery,
		currentProfileName,
		showMainAgentPanel,
		mainAgentSelectedIndex,
		mainAgentSearchQuery,
		// Actions
		setShowSessionPanel,
		setShowMcpPanel,
		setShowUsagePanel,
		setShowHelpPanel,
		setShowCustomCommandConfig,
		setShowSkillsCreation,
		setShowWorkingDirPanel,
		setShowPermissionsPanel,
		setShowReviewCommitPanel,
		setShowProfilePanel,
		setProfileSelectedIndex,
		setProfileSearchQuery,
		setShowMainAgentPanel,
		setMainAgentSelectedIndex,
		setMainAgentSearchQuery,
		handleSwitchProfile,
		handleProfileSelect,
		handleSwitchMainAgent,
		handleMainAgentSelect,
		handleEscapeKey,
		isAnyPanelOpen,
	};
}
