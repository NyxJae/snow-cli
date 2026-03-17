import {
	registerCommand,
	type CommandResult,
} from '../execution/commandExecutor.js';

// 仅注册 gitline 命令入口,具体提交选择与回填逻辑由 UI 层处理.
registerCommand('gitline', {
	execute: (): CommandResult => {
		return {
			success: true,
			action: 'showGitLinePicker',
			message: '打开 Git 提交选择面板',
		};
	},
});

export default {};
