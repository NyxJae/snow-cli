import React, {lazy, Suspense} from 'react';
import {Box, Text} from 'ink';
import Spinner from 'ink-spinner';
import {useTheme} from '../../contexts/ThemeContext.js';
import {useI18n} from '../../../i18n/I18nContext.js';
import {CustomCommandConfigPanel} from './CustomCommandConfigPanel.js';
import {SkillsCreationPanel} from './SkillsCreationPanel.js';
import WorkingDirectoryPanel from './WorkingDirectoryPanel.js';
import PermissionsPanel from './PermissionsPanel.js';
import MainAgentPanel from './MainAgentPanel.js';
import {mainAgentManager} from '../../../utils/MainAgentManager.js';
import type {CommandLocation} from '../../../utils/commands/custom.js';
import type {
	GeneratedSkillContent,
	SkillLocation,
} from '../../../utils/commands/skills.js';

// Lazy load panel components
const MCPInfoPanel = lazy(() => import('./MCPInfoPanel.js'));
const SessionListPanel = lazy(() => import('./SessionListPanel.js'));
const UsagePanel = lazy(() => import('./UsagePanel.js'));

type PanelsManagerProps = {
	terminalWidth: number;
	workingDirectory: string;
	showSessionPanel: boolean;
	showMcpPanel: boolean;
	showUsagePanel: boolean;
	showCustomCommandConfig: boolean;
	showSkillsCreation: boolean;
	showWorkingDirPanel: boolean;
	showPermissionsPanel: boolean;
	setShowSessionPanel: (show: boolean) => void;
	setShowCustomCommandConfig: (show: boolean) => void;
	setShowSkillsCreation: (show: boolean) => void;
	setShowWorkingDirPanel: (show: boolean) => void;
	setShowPermissionsPanel: (show: boolean) => void;
	handleSessionPanelSelect: (sessionId: string) => Promise<void>;

	onCustomCommandSave: (
		name: string,
		command: string,
		type: 'execute' | 'prompt',
		location: CommandLocation,
		description?: string,
	) => Promise<void>;
	onSkillsSave: (
		skillName: string,
		description: string,
		location: SkillLocation,
		generated?: GeneratedSkillContent,
	) => Promise<void>;
	alwaysApprovedTools: Set<string>;
	onRemoveTool: (toolName: string) => void;
	onClearAllTools: () => void;
	// Main agent panel props
	showMainAgentPanel?: boolean;
	mainAgentSelectedIndex?: number;
	mainAgentSearchQuery?: string;
};

export default function PanelsManager({
	terminalWidth,
	workingDirectory,
	showSessionPanel,
	showMcpPanel,
	showUsagePanel,
	showCustomCommandConfig,
	showSkillsCreation,
	showWorkingDirPanel,
	showPermissionsPanel,
	setShowSessionPanel,
	setShowCustomCommandConfig,
	setShowSkillsCreation,
	setShowWorkingDirPanel,
	setShowPermissionsPanel,
	handleSessionPanelSelect,
	onCustomCommandSave,
	onSkillsSave,
	alwaysApprovedTools,
	onRemoveTool,
	onClearAllTools,
	showMainAgentPanel,
	mainAgentSelectedIndex,
	mainAgentSearchQuery,
}: PanelsManagerProps) {
	const {theme} = useTheme();
	const {t} = useI18n();

	// Calculate main agent items on every render to ensure isActive is up-to-date
	// Apply search filter if mainAgentSearchQuery is provided
	const allMainAgentItems =
		mainAgentManager.getOrderedAgentList().map(config => ({
			id: config.basicInfo.id,
			name: config.basicInfo.name,
			description: config.basicInfo.description || '',
			isActive: config.basicInfo.id === mainAgentManager.getCurrentAgentId(),
			isBuiltin: config.basicInfo.builtin ?? false,
		})) || [];

	const mainAgentItems = mainAgentSearchQuery
		? allMainAgentItems.filter(agent => {
				const query = mainAgentSearchQuery.toLowerCase();
				return (
					agent.id.toLowerCase().includes(query) ||
					agent.name.toLowerCase().includes(query) ||
					agent.description.toLowerCase().includes(query)
				);
		  })
		: allMainAgentItems;

	const loadingFallback = (
		<Box>
			<Text>
				<Spinner type="dots" /> Loading...
			</Text>
		</Box>
	);

	return (
		<>
			{/* Show session list panel if active - replaces input */}
			{showSessionPanel && (
				<Box paddingX={1} width={terminalWidth}>
					<Suspense fallback={loadingFallback}>
						<SessionListPanel
							onSelectSession={handleSessionPanelSelect}
							onClose={() => setShowSessionPanel(false)}
						/>
					</Suspense>
				</Box>
			)}

			{/* Show MCP info panel if active - replaces input */}
			{showMcpPanel && (
				<Box paddingX={1} flexDirection="column" width={terminalWidth}>
					<Suspense fallback={loadingFallback}>
						<MCPInfoPanel />
					</Suspense>
					<Box marginTop={1}>
						<Text color={theme.colors.menuSecondary} dimColor>
							{t.chatScreen.pressEscToClose}
						</Text>
					</Box>
				</Box>
			)}

			{/* Show usage panel if active - replaces input */}
			{showUsagePanel && (
				<Box paddingX={1} flexDirection="column" width={terminalWidth}>
					<Suspense fallback={loadingFallback}>
						<UsagePanel />
					</Suspense>
					<Box marginTop={1}>
						<Text color={theme.colors.menuSecondary} dimColor>
							{t.chatScreen.pressEscToClose}
						</Text>
					</Box>
				</Box>
			)}

			{/* Show custom command config panel if active */}
			{showCustomCommandConfig && (
				<Box paddingX={1} flexDirection="column" width={terminalWidth}>
					<CustomCommandConfigPanel
						projectRoot={workingDirectory}
						onSave={onCustomCommandSave}
						onCancel={() => setShowCustomCommandConfig(false)}
					/>
				</Box>
			)}

			{/* Show skills creation panel if active */}
			{showSkillsCreation && (
				<Box paddingX={1} flexDirection="column" width={terminalWidth}>
					<SkillsCreationPanel
						projectRoot={workingDirectory}
						onSave={onSkillsSave}
						onCancel={() => setShowSkillsCreation(false)}
					/>
				</Box>
			)}

			{/* Show working directory panel if active */}
			{showWorkingDirPanel && (
				<Box paddingX={1} flexDirection="column" width={terminalWidth}>
					<WorkingDirectoryPanel
						onClose={() => setShowWorkingDirPanel(false)}
					/>
				</Box>
			)}

			{/* Show permissions panel if active */}
			{showPermissionsPanel && (
				<Box paddingX={1} flexDirection="column" width={terminalWidth}>
					<PermissionsPanel
						alwaysApprovedTools={alwaysApprovedTools}
						onRemoveTool={onRemoveTool}
						onClearAll={onClearAllTools}
						onClose={() => setShowPermissionsPanel(false)}
					/>
				</Box>
			)}

			{/* Show main agent panel if active */}
			{showMainAgentPanel && (
				<Box paddingX={1} width={terminalWidth}>
					<MainAgentPanel
						agents={mainAgentItems}
						selectedIndex={mainAgentSelectedIndex ?? 0}
						visible={true}
						searchQuery={mainAgentSearchQuery}
					/>
				</Box>
			)}
		</>
	);
}
