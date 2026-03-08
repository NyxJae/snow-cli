import * as fs from 'fs';
import * as path from 'path';

/**
 * Tool Search 全局首轮直出白名单.
 *
 * 仅影响 allowedTools 中哪些工具进入 initialTools,不承担权限来源职责.
 * 条目必须使用完整工具标识并严格精确匹配,例如: `filesystem.filesystem-read`.
 */
export const TOOL_SEARCH_INITIAL_TOOL_WHITELIST: readonly string[] = [
	'filesystem-read',
	'filesystem-create',
	'filesystem-edit_search',
	'terminal-execute',
	'todo-get',
	'todo-update',
	'todo-add',
	'useful_info-add',
	'ide-get_diagnostics',
	'askuser-ask_question',
	'ace-text_search',
	'skill-execute',
];

/**
 * 主代理跳过 Tool Search 的子代理首轮直出白名单.
 *
 * 仅对主代理上下文中的已授权 `subagent-*` 工具生效.
 */
export const MAIN_AGENT_SKIP_TOOL_SEARCH_SUBAGENT_WHITELIST: readonly string[] =
	['agent_explore', 'agent_general', 'agent_reviewer', 'agent_architect'];

export interface ProjectSettings {
	toolSearchEnabled?: boolean;
}

const SNOW_DIR = path.join(process.cwd(), '.snow');
const SETTINGS_FILE = path.join(SNOW_DIR, 'settings.json');

function ensureSnowDir(): void {
	if (!fs.existsSync(SNOW_DIR)) {
		fs.mkdirSync(SNOW_DIR, {recursive: true});
	}
}

function loadSettings(): ProjectSettings {
	try {
		if (!fs.existsSync(SETTINGS_FILE)) {
			return {};
		}
		const content = fs.readFileSync(SETTINGS_FILE, 'utf-8');
		return JSON.parse(content) as ProjectSettings;
	} catch {
		return {};
	}
}

function saveSettings(settings: ProjectSettings): void {
	try {
		ensureSnowDir();
		fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
	} catch {
		// Ignore write errors
	}
}
export function getToolSearchEnabled(): boolean {
	const settings = loadSettings();
	return settings.toolSearchEnabled ?? true;
}

export function setToolSearchEnabled(enabled: boolean): void {
	const settings = loadSettings();
	settings.toolSearchEnabled = enabled;
	saveSettings(settings);
}
