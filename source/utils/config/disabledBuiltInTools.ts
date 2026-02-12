import fs from 'node:fs';
import path from 'node:path';

/**
 * 管理系统内置 MCP 工具的禁用状态
 * 持久化到项目根目录 .snow/disabled-builtin-tools.json
 */

const CONFIG_FILE = 'disabled-builtin-tools.json';

function getConfigPath(): string {
	return path.join(process.cwd(), '.snow', CONFIG_FILE);
}

/**
 * 读取被禁用的内置服务列表
 */
export function getDisabledBuiltInServices(): string[] {
	try {
		const configPath = getConfigPath();
		if (!fs.existsSync(configPath)) {
			return [];
		}
		const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
		return Array.isArray(data.disabledServices) ? data.disabledServices : [];
	} catch {
		return [];
	}
}

/**
 * 检查某个内置服务是否启用
 */
export function isBuiltInServiceEnabled(serviceName: string): boolean {
	return !getDisabledBuiltInServices().includes(serviceName);
}

/**
 * 切换内置服务的启用/禁用状态
 */
export function toggleBuiltInService(serviceName: string): boolean {
	const disabled = getDisabledBuiltInServices();
	const index = disabled.indexOf(serviceName);
	let newEnabled: boolean;

	if (index >= 0) {
		disabled.splice(index, 1);
		newEnabled = true;
	} else {
		disabled.push(serviceName);
		newEnabled = false;
	}

	const configPath = getConfigPath();
	const dir = path.dirname(configPath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, {recursive: true});
	}
	fs.writeFileSync(
		configPath,
		JSON.stringify({disabledServices: disabled}, null, 2),
		'utf-8',
	);

	return newEnabled;
}

/**
 * 从工具名称提取服务名称
 * 例如: filesystem-read -> filesystem, todo-add -> todo
 */
export function getServiceNameFromTool(toolName: string): string {
	const builtInServiceMap: Record<string, string> = {
		filesystem: 'filesystem',
		terminal: 'terminal',
		todo: 'todo',
		notebook: 'notebook',
		ace: 'ace',
		useful: 'usefulInfo', // useful-info-*
		websearch: 'websearch',
		ide: 'ide',
		codebase: 'codebase',
		askuser: 'askuser',
		skill: 'skill',
		subagent: 'subagent',
	};

	const prefix = toolName.split('-')[0];
	return (prefix && builtInServiceMap[prefix]) || prefix || toolName;
}

/**
 * 过滤工具列表，移除属于被禁用服务的工具
 */
export function filterToolsByEnabledServices(tools: string[]): string[] {
	const disabledServices = getDisabledBuiltInServices();
	return tools.filter(toolName => {
		const serviceName = getServiceNameFromTool(toolName);
		return !disabledServices.includes(serviceName);
	});
}

/**
 * 获取启用的服务列表
 */
export function getEnabledBuiltInServices(): string[] {
	const allServices = [
		'filesystem',
		'terminal',
		'todo',
		'notebook',
		'ace',
		'usefulInfo',
		'websearch',
		'ide',
		'codebase',
		'askuser',
		'skill',
		'subagent',
	];
	const disabled = getDisabledBuiltInServices();
	return allServices.filter(s => !disabled.includes(s));
}
