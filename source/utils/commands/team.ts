import { registerCommand, type CommandResult } from '../execution/commandExecutor.js';

// Team command handler - toggles team mode
registerCommand('team', {
	execute: (): CommandResult => {
		return {
			success: true,
			action: 'toggleTeam',
			message: 'Toggling Team mode'
		};
	}
});

export default {};