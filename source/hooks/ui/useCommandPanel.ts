import {useState, useCallback, useMemo, useEffect} from 'react';
import {TextBuffer} from '../../utils/ui/textBuffer.js';
import {useI18n} from '../../i18n/index.js';
import {getCustomCommands} from '../../utils/commands/custom.js';
import {commandUsageManager} from '../../utils/session/commandUsageManager.js';

export type CommandPanelCommand = {
	name: string;
	description: string;
	type: 'builtin' | 'execute' | 'prompt';
};

export function useCommandPanel(buffer: TextBuffer, isProcessing = false) {
	const {t} = useI18n();

	const builtInCommands = useMemo(
		() => [
			{name: 'help', description: t.commandPanel.commands.help},
			{name: 'clear', description: t.commandPanel.commands.clear},
			{
				name: 'copy-last',
				description:
					t.commandPanel.commands.copyLast ||
					'Copy last AI message to clipboard',
			},
			{name: 'resume', description: t.commandPanel.commands.resume},
			{name: 'mcp', description: t.commandPanel.commands.mcp},
			{
				name: 'init',
				description: t.commandPanel.commands.init,
			},
			{name: 'ide', description: t.commandPanel.commands.ide},
			{
				name: 'compact',
				description: t.commandPanel.commands.compact,
			},
			{name: 'home', description: t.commandPanel.commands.home},
			{
				name: 'review',
				description: t.commandPanel.commands.review,
			},
			{
				name: 'gitline',
				description:
					t.commandPanel.commands.gitline ||
					'Select git commits and insert them into the chat input',
			},
			{
				name: 'usage',
				description: t.commandPanel.commands.usage,
			},
			{
				name: 'backend',
				description:
					t.commandPanel.commands.backend || 'Show background processes',
			},
			{
				name: 'profiles',
				description: t.commandPanel.commands.profiles,
			},
			{
				name: 'loop',
				description:
					t.commandPanel.commands.loop ||
					'Schedule a session-scoped recurring task. Usage: /loop 5m <prompt>',
			},
			{
				name: 'models',
				description: t.commandPanel.commands.models,
			},
			{
				name: 'export',
				description: t.commandPanel.commands.export,
			},
			{
				name: 'custom',
				description: t.commandPanel.commands.custom || 'Add custom command',
			},
			{
				name: 'skills',
				description: t.commandPanel.commands.skills || 'Create skill template',
			},
			{
				name: 'agent-',
				description: t.commandPanel.commands.agent,
			},
			{
				name: 'todo-',
				description: t.commandPanel.commands.todo,
			},
			{
				name: 'todolist',
				description:
					t.commandPanel.commands.todolist ||
					'Show current session TODO tree and manage items',
			},
			{
				name: 'skills-',
				description:
					t.commandPanel.commands.skillsPicker ||
					'Select a skill and inject its content into the input',
			},
			{
				name: 'add-dir',
				description: t.commandPanel.commands.addDir || 'Add working directory',
			},
			{
				name: 'reindex',
				description: t.commandPanel.commands.reindex,
			},
			{
				name: 'codebase',
				description:
					t.commandPanel.commands.codebase ||
					'Toggle codebase indexing for current project',
			},
			{
				name: 'permissions',
				description:
					t.commandPanel.commands.permissions || 'Manage tool permissions',
			},
			{
				name: 'tool-search',
				description: t.commandPanel.commands.toolSearch || 'Tool Search',
			},
			{
				name: 'worktree',
				description:
					t.commandPanel.commands.worktree ||
					'Open Git branch management panel',
			},
			{
				name: 'diff',
				description:
					t.commandPanel.commands.diff ||
					'Review file changes from a conversation in IDE diff view',
			},
			{
				name: 'connect',
				description:
					t.commandPanel.commands.connect ||
					'Connect to a Snow Instance for AI processing',
			},
			{
				name: 'disconnect',
				description:
					t.commandPanel.commands.disconnect ||
					'Disconnect from the current Snow Instance',
			},
			{
				name: 'connection-status',
				description:
					t.commandPanel.commands.connectionStatus ||
					'Show current connection status',
			},
			{
				name: 'new-prompt',
				description:
					t.commandPanel.commands.newPrompt ||
					'Generate a refined prompt from your requirement using AI',
			},
			{
				name: 'quit',
				description: t.commandPanel.commands.quit,
			},
		],
		[t],
	);

	const normalizedBuiltInCommands = useMemo<CommandPanelCommand[]>(
		() =>
			builtInCommands.map(command => ({
				...command,
				type: 'builtin',
			})),
		[builtInCommands],
	);

	const getAllCommands = useCallback((): CommandPanelCommand[] => {
		const customCommands = getCustomCommands().map(cmd => ({
			name: cmd.name,
			description: cmd.description || cmd.command,
			type: cmd.type,
		}));
		return [...normalizedBuiltInCommands, ...customCommands];
	}, [normalizedBuiltInCommands]);

	const [showCommands, setShowCommands] = useState(false);
	const [commandSelectedIndex, setCommandSelectedIndex] = useState(0);
	const [usageLoaded, setUsageLoaded] = useState(false);

	useEffect(() => {
		let isMounted = true;

		commandUsageManager.ensureLoaded().then(() => {
			if (isMounted) {
				setUsageLoaded(true);
			}
		});

		return () => {
			isMounted = false;
		};
	}, []);

	const getFilteredCommands = useCallback((): CommandPanelCommand[] => {
		const text = buffer.getFullText();
		if (!text.startsWith('/')) return [];

		const query = text.slice(1).toLowerCase();

		const allCommands = getAllCommands();
		const availableCommands = isProcessing
			? allCommands.filter(command => command.type === 'prompt')
			: allCommands;

		// 有查询词时优先按匹配位置排序,再用使用频次打破并列.
		const filtered = availableCommands
			.filter(
				command =>
					command.name.toLowerCase().includes(query) ||
					command.description.toLowerCase().includes(query),
			)
			.map(command => {
				const nameLower = command.name.toLowerCase();
				const descLower = command.description.toLowerCase();
				const usageCount = commandUsageManager.getUsageCountSync(command.name);

				let priority = 4;

				if (nameLower.startsWith(query)) {
					priority = 1;
				} else if (nameLower.includes(query)) {
					priority = 2;
				} else if (descLower.startsWith(query)) {
					priority = 3;
				}

				return {command, priority, usageCount};
			})
			.sort((a, b) => {
				if (query === '') {
					if (a.usageCount !== b.usageCount) {
						return b.usageCount - a.usageCount;
					}
					return a.command.name.localeCompare(b.command.name);
				}

				if (a.priority !== b.priority) {
					return a.priority - b.priority;
				}
				if (a.usageCount !== b.usageCount) {
					return b.usageCount - a.usageCount;
				}
				return a.command.name.localeCompare(b.command.name);
			})
			.map(item => item.command);

		return filtered;
	}, [buffer, getAllCommands, isProcessing, usageLoaded]);

	// Update command panel state
	const updateCommandPanelState = useCallback((text: string) => {
		// Check if / is at the start (not preceded by @ or #)
		if (text.startsWith('/') && text.length > 0) {
			setShowCommands(true);
			setCommandSelectedIndex(0);
		} else {
			setShowCommands(false);
			setCommandSelectedIndex(0);
		}
	}, []);

	return {
		showCommands,
		setShowCommands,
		commandSelectedIndex,
		setCommandSelectedIndex,
		getFilteredCommands,
		updateCommandPanelState,
		getAllCommands,
	};
}
