import React, {lazy, Suspense} from 'react';
import {Box, Text} from 'ink';
import Spinner from 'ink-spinner';
import {useTheme} from '../../contexts/ThemeContext.js';
import {useI18n} from '../../../i18n/I18nContext.js';
import {CustomCommandConfigPanel} from './CustomCommandConfigPanel.js';
import {SkillsCreationPanel} from './SkillsCreationPanel.js';
import {ModelsPanel} from './ModelsPanel.js';
import WorkingDirectoryPanel from './WorkingDirectoryPanel.js';
import PermissionsPanel from './PermissionsPanel.js';
import MainAgentPanel from './MainAgentPanel.js';
import {mainAgentManager} from '../../../utils/MainAgentManager.js';
import {BranchPanel} from './BranchPanel.js';
import {ConnectionPanel} from './ConnectionPanel.js';
import TodoListPanel from './TodoListPanel.js';
import type {CommandLocation} from '../../../utils/commands/custom.js';
import type {
	GeneratedSkillContent,
	SkillLocation,
} from '../../../utils/commands/skills.js';

// Lazy load panel components
const MCPInfoPanel = lazy(() => import('./MCPInfoPanel.js'));
const SessionListPanel = lazy(() => import('./SessionListPanel.js'));
const UsagePanel = lazy(() => import('./UsagePanel.js'));
const DiffReviewPanel = lazy(() => import('./DiffReviewPanel.js'));

type PanelsManagerProps = {
	terminalWidth: number;
	workingDirectory: string;
	showSessionPanel: boolean;
	showMcpPanel: boolean;
	showUsagePanel: boolean;
	showModelsPanel: boolean;
	showCustomCommandConfig: boolean;
	showSkillsCreation: boolean;
	showWorkingDirPanel: boolean;
	showPermissionsPanel: boolean;
	showBranchPanel: boolean;
	showDiffReviewPanel: boolean;
	showConnectionPanel: boolean;
	showTodoListPanel: boolean;
	connectionPanelApiUrl?: string;
	diffReviewMessages: Array<{
		role: string;
		content: string;
		images?: Array<{type: 'image'; data: string; mimeType: string}>;
		subAgentDirected?: unknown;
	}>;
	diffReviewSnapshotFileCount: Map<number, number>;
	advancedModel: string;
	basicModel: string;
	setShowSessionPanel: (show: boolean) => void;
	setShowModelsPanel: (show: boolean) => void;
	setShowCustomCommandConfig: (show: boolean) => void;
	setShowSkillsCreation: (show: boolean) => void;
	setShowWorkingDirPanel: (show: boolean) => void;
	setShowPermissionsPanel: (show: boolean) => void;
	setShowBranchPanel: (show: boolean) => void;
	setShowDiffReviewPanel: (show: boolean) => void;
	mcpPanelSource?: 'chat' | 'mcpConfig';
	setShowMcpPanel: (show: boolean) => void;
	setShowConnectionPanel: (show: boolean) => void;
	setShowTodoListPanel: (show: boolean) => void;
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
	// 主代理面板
	showMainAgentPanel: boolean;
	mainAgentSelectedIndex: number;
	mainAgentSearchQuery: string;
};

/**
 * 面板装配器,按状态渲染各功能面板并透传所需回调.
 */
export default function PanelsManager({
	terminalWidth,
	workingDirectory,
	showSessionPanel,
	showMcpPanel,
	showUsagePanel,
	showModelsPanel,
	showCustomCommandConfig,
	showSkillsCreation,
	showWorkingDirPanel,
	showPermissionsPanel,
	showBranchPanel,
	showDiffReviewPanel,
	showConnectionPanel,
	showTodoListPanel,
	connectionPanelApiUrl,
	diffReviewMessages,
	diffReviewSnapshotFileCount,
	advancedModel,
	basicModel,
	setShowSessionPanel,
	setShowModelsPanel,
	setShowCustomCommandConfig,
	setShowSkillsCreation,
	setShowWorkingDirPanel,
	setShowPermissionsPanel,
	setShowBranchPanel,
	setShowDiffReviewPanel,
	mcpPanelSource,
	setShowMcpPanel,
	setShowConnectionPanel,
	setShowTodoListPanel,
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

	// 这里每次 render 重新计算,确保 isActive 始终与 mainAgentManager 当前状态一致.
	// 如果有搜索词,在装配阶段过滤列表,避免在 Panel 内部再维护一份筛选状态.
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
			{/* SessionList 面板 */}
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

			{/* MCPInfo 面板 */}
			{showMcpPanel && (
				<Box paddingX={1} flexDirection="column" width={terminalWidth}>
					<Suspense fallback={loadingFallback}>
						<MCPInfoPanel
							source={mcpPanelSource}
							onClose={() => setShowMcpPanel(false)}
						/>
					</Suspense>
				</Box>
			)}

			{/* Usage 面板 */}
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

			{/* Models 面板 */}
			{showModelsPanel && (
				<Box paddingX={1} flexDirection="column" width={terminalWidth}>
					<ModelsPanel
						advancedModel={advancedModel}
						basicModel={basicModel}
						visible={showModelsPanel}
						onClose={() => setShowModelsPanel(false)}
					/>
				</Box>
			)}

			{/* CustomCommandConfig 面板 */}
			{showCustomCommandConfig && (
				<Box paddingX={1} flexDirection="column" width={terminalWidth}>
					<CustomCommandConfigPanel
						projectRoot={workingDirectory}
						onSave={onCustomCommandSave}
						onCancel={() => setShowCustomCommandConfig(false)}
					/>
				</Box>
			)}

			{/* SkillsCreation 面板 */}
			{showSkillsCreation && (
				<Box paddingX={1} flexDirection="column" width={terminalWidth}>
					<SkillsCreationPanel
						projectRoot={workingDirectory}
						onSave={onSkillsSave}
						onCancel={() => setShowSkillsCreation(false)}
					/>
				</Box>
			)}

			{/* WorkingDirectory 面板 */}
			{showWorkingDirPanel && (
				<Box paddingX={1} flexDirection="column" width={terminalWidth}>
					<WorkingDirectoryPanel
						onClose={() => setShowWorkingDirPanel(false)}
					/>
				</Box>
			)}

			{/* Permissions 面板 */}
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

			{/* Branch 面板 */}
			{showBranchPanel && (
				<Box paddingX={1} flexDirection="column" width={terminalWidth}>
					<BranchPanel onClose={() => setShowBranchPanel(false)} />
				</Box>
			)}

			{/* DiffReview 面板 */}
			{showDiffReviewPanel && (
				<Box paddingX={1} width={terminalWidth}>
					<Suspense fallback={loadingFallback}>
						<DiffReviewPanel
							messages={diffReviewMessages}
							snapshotFileCount={diffReviewSnapshotFileCount}
							onClose={() => setShowDiffReviewPanel(false)}
						/>
					</Suspense>
				</Box>
			)}

			{/* Connection 面板 */}
			{showConnectionPanel && (
				<Box paddingX={1} flexDirection="column" width={terminalWidth}>
					<ConnectionPanel
						onClose={() => setShowConnectionPanel(false)}
						initialApiUrl={connectionPanelApiUrl}
					/>
				</Box>
			)}

			{/* TodoList 面板 */}
			{showTodoListPanel && (
				<Box paddingX={1} flexDirection="column" width={terminalWidth}>
					<TodoListPanel onClose={() => setShowTodoListPanel(false)} />
				</Box>
			)}
		</>
	);
}
