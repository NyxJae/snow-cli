/**
 * Format TODO list into markdown context for injection
 * @param todos - Array of TODO items
 * @param isSubAgent - Whether this is for sub-agent (default: false)
 *                     Sub-agents receive a different prompt emphasizing
 *                     that the TODO list is for reference only
 * @returns Formatted TODO context string
 */
export function formatTodoContext(
	todos: Array<{
		id: string;
		content: string;
		status: 'pending' | 'inProgress' | 'completed';
	}>,
	isSubAgent: boolean = false,
): string {
	if (todos.length === 0) {
		return '';
	}

	const statusSymbol = {
		pending: '[ ]',
		inProgress: '[~]',
		completed: '[x]',
	};

	// Different prompts for main agent vs sub-agent
	const importantNote = isSubAgent
		? [
				'**Important for Sub-Agent**:',
				"- This is the TEAM's global TODO list for reference only",
				'- Focus ONLY on tasks assigned to you by the main agent',
				'- You may update related TODO items using todo-update tool',
				'- Do NOT exceed your assigned scope of work',
		  ]
		: [
				'**Important**: Update TODO status immediately after completing each task using todo-update tool.',
		  ];

	const lines = [
		'## Current TODO List',
		'',
		...todos.map(t => `${statusSymbol[t.status]} ${t.content} (ID: ${t.id})`),
		'',
		...importantNote,
		'',
	];

	return lines.join('\n');
}
