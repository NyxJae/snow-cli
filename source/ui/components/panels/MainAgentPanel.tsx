import React, {memo, useMemo} from 'react';
import {Box, Text} from 'ink';
import {useI18n} from '../../../i18n/index.js';
import {useTheme} from '../../contexts/ThemeContext.js';

export interface MainAgentItem {
	id: string;
	name: string;
	description: string;
	isActive: boolean;
	isBuiltin: boolean;
}

interface Props {
	agents: MainAgentItem[];
	selectedIndex: number;
	visible: boolean;
	maxHeight?: number;
	searchQuery?: string;
}

const MainAgentPanel = memo(
	({agents, selectedIndex, visible, maxHeight, searchQuery}: Props) => {
		const {t} = useI18n();
		const {theme} = useTheme();

		// Fixed maximum display items to prevent rendering issues
		const MAX_DISPLAY_ITEMS = 5;
		const effectiveMaxItems = maxHeight
			? Math.min(maxHeight, MAX_DISPLAY_ITEMS)
			: MAX_DISPLAY_ITEMS;

		// Limit displayed agents
		const displayedAgents = useMemo(() => {
			if (agents.length <= effectiveMaxItems) {
				return agents;
			}

			// Show agents around the selected index
			const halfWindow = Math.floor(effectiveMaxItems / 2);
			let startIndex = Math.max(0, selectedIndex - halfWindow);
			let endIndex = Math.min(agents.length, startIndex + effectiveMaxItems);

			// Adjust if we're near the end
			if (endIndex - startIndex < effectiveMaxItems) {
				startIndex = Math.max(0, endIndex - effectiveMaxItems);
			}

			return agents.slice(startIndex, endIndex);
		}, [agents, selectedIndex, effectiveMaxItems]);

		// Calculate actual selected index in the displayed subset
		const displayedSelectedIndex = useMemo(() => {
			return displayedAgents.findIndex(agent => {
				const originalIndex = agents.indexOf(agent);
				return originalIndex === selectedIndex;
			});
		}, [displayedAgents, agents, selectedIndex]);

		// Don't show panel if not visible
		if (!visible) {
			return null;
		}

		return (
			<Box flexDirection="column">
				<Box width="100%">
					<Box flexDirection="column" width="100%">
						<Box>
							<Text color={theme.colors.warning} bold>
								{t.mainAgentPanel.title}{' '}
								{agents.length > effectiveMaxItems &&
									`(${selectedIndex + 1}/${agents.length})`}
							</Text>
						</Box>
						{searchQuery && (
							<Box marginTop={1}>
								<Text color={theme.colors.menuInfo}>
									{t.mainAgentPanel.searchLabel}{' '}
									<Text color={theme.colors.menuSelected}>{searchQuery}</Text>
								</Text>
							</Box>
						)}
						{agents.length === 0 ? (
							<Box marginTop={1}>
								<Text color={theme.colors.menuSecondary} dimColor>
									{t.mainAgentPanel.noResults}
								</Text>
							</Box>
						) : (
							<>
								{displayedAgents.map((agent, index) => (
									<Box
										key={agent.id}
										flexDirection="column"
										width="100%"
									>
										<Text
											color={
												index === displayedSelectedIndex
													? theme.colors.menuSelected
													: theme.colors.menuNormal
											}
											bold
										>
											{index === displayedSelectedIndex ? '> ' : '  '}
											{agent.name}
											{agent.isActive && ` ${t.mainAgentPanel.activeLabel}`}
											{agent.isBuiltin && ` ${t.mainAgentPanel.builtinLabel}`}
										</Text>
										{(index === displayedSelectedIndex || agent.isActive) &&
											agent.description && (
												<Text
													color={
														index === displayedSelectedIndex
															? theme.colors.menuSelected
															: theme.colors.menuSecondary
													}
													dimColor={index !== displayedSelectedIndex}
												>
													{'    '}
													{agent.description}
												</Text>
											)}
									</Box>
								))}
								{agents.length > effectiveMaxItems && (
									<Box marginTop={1}>
										<Text color={theme.colors.menuSecondary} dimColor>
											{t.mainAgentPanel.scrollHint} ·{' '}
											{t.mainAgentPanel.moreHidden.replace(
												'{count}',
												(agents.length - effectiveMaxItems).toString(),
											)}
										</Text>
									</Box>
								)}
							</>
						)}
						<Box marginTop={1}>
							<Text color={theme.colors.menuSecondary} dimColor>
								{t.mainAgentPanel.escHint}
							</Text>
						</Box>
					</Box>
				</Box>
			</Box>
		);
	},
);

MainAgentPanel.displayName = 'MainAgentPanel';

export default MainAgentPanel;