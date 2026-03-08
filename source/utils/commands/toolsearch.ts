import {
	registerCommand,
	type CommandResult,
} from '../execution/commandExecutor.js';
import {setToolSearchEnabled} from '../config/projectSettings.js';

registerCommand('tool-search', {
	execute: (): CommandResult => {
		setToolSearchEnabled(true);
		return {
			success: true,
			action: 'sendAsMessage',
			prompt: '/tool-search',
			message: 'Running Tool Search',
		};
	},
});

export default {};
