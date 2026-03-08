import {
	registerCommand,
	type CommandResult,
} from '../execution/commandExecutor.js';

registerCommand('tool-search', {
	execute: (): CommandResult => {
		return {
			success: true,
			action: 'sendAsMessage',
			prompt: '/tool-search',
			message: 'Running Tool Search',
		};
	},
});

export default {};
