/**
 * 主代理配置文件读写模块
 *
 * 可配置主代理系统重构 - 第一阶段.3
 * 实现TOML配置文件的读写功能，包括加载、保存、创建默认配置和备份功能
 */

import {mkdirSync, existsSync, unlinkSync} from 'fs';
import {join, basename} from 'path';
import {homedir} from 'os';

import type {MainAgentConfigFile} from '../types/MainAgentConfig.js';
import {readToml, writeTomlSafe, existsToml} from './config/tomlUtils.js';
import {createDefaultMainAgentConfigFile} from '../config/DefaultMainAgentConfig.js';

/**
 * 主代理配置文件路径常量（全局配置）
 */
const CONFIG_DIR = join(homedir(), '.snow');
const CONFIG_FILENAME = 'main-agents.toml';
const CONFIG_PATH = join(CONFIG_DIR, CONFIG_FILENAME);
const BACKUP_DIR = join(CONFIG_DIR, 'backups');

/**
 * 获取项目级配置目录路径
 */
function getProjectConfigDir(): string {
	return join(process.cwd(), '.snow');
}

/**
 * 获取项目级主代理配置文件路径
 */
function getProjectMainAgentConfigPath(): string {
	return join(getProjectConfigDir(), CONFIG_FILENAME);
}

/**
 * 确保全局配置目录存在
 */
function ensureConfigDir(): void {
	if (!existsSync(CONFIG_DIR)) {
		mkdirSync(CONFIG_DIR, {recursive: true});
	}

	if (!existsSync(BACKUP_DIR)) {
		mkdirSync(BACKUP_DIR, {recursive: true});
	}
}

/**
 * 获取配置文件路径
 * 优先级：自定义路径 > 项目级配置 > 全局配置
 *
 * @param configPath 可选的自定义配置文件路径
 * @returns 配置文件的完整路径
 */
export function getMainAgentConfigPath(configPath?: string): string {
	// 1. 自定义路径优先
	if (configPath) {
		return configPath;
	}

	// 2. 检查项目级配置是否存在
	const projectConfigPath = getProjectMainAgentConfigPath();
	if (existsToml(projectConfigPath)) {
		return projectConfigPath;
	}

	// 3. 回退到全局配置
	ensureConfigDir();
	return CONFIG_PATH;
}

/**
 * 检查主代理配置文件是否存在
 *
 * @param configPath 可选的自定义配置文件路径
 * @returns 配置文件是否存在
 */
export function existsMainAgentConfig(configPath?: string): boolean {
	const filePath = getMainAgentConfigPath(configPath);
	return existsToml(filePath);
}

/**
 * 加载主代理配置文件
 * 优先级：自定义路径 > 项目级配置 > 全局配置
 * - 如果项目级配置存在且非空，使用项目级配置
 * - 如果项目级配置为空，回退到全局配置
 * - 如果项目级配置格式错误，抛出包含路径的错误信息
 *
 * @param configPath 可选的自定义配置文件路径
 * @returns 主代理配置文件对象，加载失败时返回默认配置
 * @throws Error 当配置文件存在但格式错误时抛出异常
 */
export function loadMainAgentConfig(configPath?: string): MainAgentConfigFile {
	// 如果指定了自定义路径，直接使用该路径
	if (configPath) {
		return loadConfigFromPath(configPath);
	}

	// 检查项目级配置
	const projectConfigPath = getProjectMainAgentConfigPath();
	if (existsToml(projectConfigPath)) {
		const projectConfig = readToml<MainAgentConfigFile>(projectConfigPath);

		if (projectConfig === null) {
			throw new Error(`项目级配置文件读取失败: ${projectConfigPath}`);
		}

		// 如果项目级配置为空对象，回退到全局配置
		if (
			typeof projectConfig === 'object' &&
			Object.keys(projectConfig).length === 0
		) {
			// 项目级配置为空，回退到全局配置
			return loadGlobalConfig();
		}

		// 验证项目级配置的基本结构
		if (!projectConfig.agents || typeof projectConfig.agents !== 'object') {
			throw new Error(
				`项目级配置文件格式错误: ${projectConfigPath} - 缺少agents字段或agents不是对象`,
			);
		}

		return projectConfig;
	}

	// 回退到全局配置
	return loadGlobalConfig();
}

/**
 * 从指定路径加载配置文件
 */
function loadConfigFromPath(filePath: string): MainAgentConfigFile {
	if (!existsToml(filePath)) {
		return createDefaultMainAgentConfigFile();
	}

	const configFile = readToml<MainAgentConfigFile>(filePath);

	if (configFile === null) {
		throw new Error(`配置文件读取失败: ${filePath}`);
	}

	if (typeof configFile === 'object' && Object.keys(configFile).length === 0) {
		return createDefaultMainAgentConfigFile();
	}

	if (!configFile.agents || typeof configFile.agents !== 'object') {
		throw new Error(
			`配置文件格式错误: ${filePath} - 缺少agents字段或agents不是对象`,
		);
	}

	return configFile;
}

/**
 * 加载全局配置文件
 */
function loadGlobalConfig(): MainAgentConfigFile {
	// 如果全局配置文件不存在，返回内置默认配置
	if (!existsToml(CONFIG_PATH)) {
		return createDefaultMainAgentConfigFile();
	}

	const configFile = readToml<MainAgentConfigFile>(CONFIG_PATH);

	if (configFile === null) {
		throw new Error(`全局配置文件读取失败: ${CONFIG_PATH}`);
	}

	// 空文件当作没有配置文件处理，返回默认配置
	if (typeof configFile === 'object' && Object.keys(configFile).length === 0) {
		return createDefaultMainAgentConfigFile();
	}

	// 验证配置文件的基本结构
	if (!configFile.agents || typeof configFile.agents !== 'object') {
		throw new Error(
			`全局配置文件格式错误: ${CONFIG_PATH} - 缺少agents字段或agents不是对象`,
		);
	}

	return configFile;
}

/**
 * 保存主代理配置文件
 * 注意：保存操作始终写入全局配置目录，不会写入项目级配置
 *
 * @param configFile 要保存的主代理配置文件对象
 * @param configPath 可选的自定义配置文件路径
 * @throws Error 当验证失败或保存失败时抛出异常
 */
export function saveMainAgentConfig(
	configFile: MainAgentConfigFile,
	configPath?: string,
): void {
	// 验证输入数据
	if (!configFile || typeof configFile !== 'object') {
		throw new Error('配置文件对象不能为空或不是对象');
	}

	if (!configFile.agents || typeof configFile.agents !== 'object') {
		throw new Error('配置文件必须包含agents字段');
	}

	// 验证每个代理配置
	for (const [agentId, agentConfig] of Object.entries(configFile.agents)) {
		if (!agentConfig.basicInfo?.id) {
			throw new Error(`代理配置 "${agentId}" 缺少ID`);
		}

		if (agentConfig.basicInfo.id !== agentId) {
			throw new Error(
				`代理配置键值不匹配: 键 "${agentId}" 与配置中的ID "${agentConfig.basicInfo.id}" 不一致`,
			);
		}
	}

	// 确定保存路径
	// 如果指定了自定义路径则使用自定义路径
	// 否则根据当前配置来源决定写入位置
	let filePath: string;
	if (configPath) {
		filePath = configPath;
	} else if (isUsingProjectMainAgentConfig()) {
		// 当前使用项目级配置，保存到项目级
		filePath = getProjectMainAgentConfigPath();
	} else {
		// 使用全局配置
		ensureConfigDir();
		filePath = CONFIG_PATH;
	}

	// 确保配置目录存在（无论全局还是项目级）
	ensureConfigDir();

	// 备份现有配置文件（如果存在）
	if (existsToml(filePath)) {
		backupConfigFile(filePath);
	}

	// 保存配置文件
	try {
		writeTomlSafe(filePath, configFile);
		// console.log(`主代理配置文件已保存: ${filePath}`);
	} catch (error) {
		throw new Error(
			`保存配置文件失败: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/**
 * 删除主代理配置文件
 * @param configPath 可选的自定义配置文件路径
 * @returns 是否成功删除
 */
export function deleteMainAgentConfig(configPath?: string): boolean {
	try {
		const filePath = getMainAgentConfigPath(configPath);

		if (!existsToml(filePath)) {
			// 文件不存在，视为成功
			return true;
		}

		// 备份现有配置文件
		backupConfigFile(filePath);

		// 删除文件
		unlinkSync(filePath);
		// console.log(`主代理配置文件已删除: ${filePath}`);
		return true;
	} catch (error) {
		// console.error('删除主代理配置文件失败:', error);
		return false;
	}
}

/**
 * 创建默认配置文件
 * @param configPath 配置文件路径
 * @returns 创建的默认配置文件对象
 * @throws Error 当创建失败时抛出异常
 */
export function createDefaultConfigFile(
	configPath?: string,
): MainAgentConfigFile {
	const filePath = getMainAgentConfigPath(configPath);

	// 确保配置目录存在
	ensureConfigDir();

	// 创建默认配置
	const defaultConfig = createDefaultMainAgentConfigFile();

	// 保存配置文件
	try {
		writeTomlSafe(filePath, defaultConfig);
		console.log(`默认主代理配置文件已创建: ${filePath}`);
	} catch (error) {
		throw new Error(
			`创建默认配置文件失败: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	return defaultConfig;
}

/**
 * 备份配置文件
 *
 * @param configPath 要备份的配置文件路径
 * @returns 备份文件的路径，备份失败时返回null
 */
export function backupConfigFile(configPath: string): string | null {
	if (!existsToml(configPath)) {
		// 文件不存在，无需备份
		return null;
	}

	try {
		// 确保备份目录存在
		ensureConfigDir();

		// 生成备份文件名（带时间戳）
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const originalBasename = basename(configPath, '.toml');
		const backupFilename = `${originalBasename}.backup.${timestamp}.toml`;
		const backupPath = join(BACKUP_DIR, backupFilename);

		// 复制文件
		const {copyFileSync} = require('fs');
		copyFileSync(configPath, backupPath);

		// console.log(`配置文件已备份: ${backupPath}`);
		return backupPath;
	} catch (error) {
		console.error(
			`备份配置文件失败: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return null;
	}
}

/**
 * 获取所有备份文件列表
 *
 * @returns 备份文件路径数组，按修改时间倒序排列
 */
export function getBackupFiles(): string[] {
	try {
		if (!existsSync(BACKUP_DIR)) {
			return [];
		}

		const {readdirSync, statSync} = require('fs');
		const files = readdirSync(BACKUP_DIR)
			.filter((file: string) => file.endsWith('.toml'))
			.map((file: string) => join(BACKUP_DIR, file))
			.sort((a: string, b: string) => {
				const statA = statSync(a);
				const statB = statSync(b);
				return statB.mtime.getTime() - statA.mtime.getTime();
			});

		return files;
	} catch (error) {
		console.error(
			`获取备份文件列表失败: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return [];
	}
}

/**
 * 从备份文件恢复配置
 *
 * @param backupPath 备份文件路径
 * @param configPath 可选的目标配置文件路径
 * @returns 恢复是否成功
 */
export function restoreFromBackup(
	backupPath: string,
	configPath?: string,
): boolean {
	if (!existsSync(backupPath)) {
		console.error(`备份文件不存在: ${backupPath}`);
		return false;
	}

	try {
		const targetPath = getMainAgentConfigPath(configPath);

		// 备份当前配置文件（如果存在）
		if (existsToml(targetPath)) {
			backupConfigFile(targetPath);
		}

		// 复制备份文件到目标位置
		const {copyFileSync} = require('fs');
		copyFileSync(backupPath, targetPath);

		console.log(`已从备份恢复配置: ${backupPath} -> ${targetPath}`);
		return true;
	} catch (error) {
		console.error(
			`从备份恢复配置失败: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return false;
	}
}

/**
 * 验证配置文件完整性
 *
 * @param configFile 要验证的配置文件对象
 * @returns 验证结果
 */
export function validateConfigFile(configFile: MainAgentConfigFile): {
	valid: boolean;
	errors: string[];
	warnings: string[];
} {
	const errors: string[] = [];
	const warnings: string[] = [];

	// 基本结构验证
	if (!configFile) {
		errors.push('配置文件对象不能为空');
		return {valid: false, errors, warnings};
	}

	if (!configFile.agents || typeof configFile.agents !== 'object') {
		errors.push('配置文件必须包含agents字段');
		return {valid: false, errors, warnings};
	}

	// 验证代理配置
	const agentIds = Object.keys(configFile.agents);
	if (agentIds.length === 0) {
		errors.push('至少需要一个代理配置');
	}

	for (const [agentId, agentConfig] of Object.entries(configFile.agents)) {
		// 基本信息验证
		if (!agentConfig.basicInfo) {
			errors.push(`代理 "${agentId}" 缺少basicInfo字段`);
			continue;
		}

		if (!agentConfig.basicInfo.id) {
			errors.push(`代理 "${agentId}" 缺少ID`);
		} else if (agentConfig.basicInfo.id !== agentId) {
			errors.push(`代理 "${agentId}" 的ID与键名不匹配`);
		}

		if (!agentConfig.basicInfo.name) {
			warnings.push(`代理 "${agentId}" 缺少名称`);
		}

		if (!['general', 'team'].includes(agentConfig.basicInfo.type)) {
			errors.push(`代理 "${agentId}" 的类型必须是general或team`);
		}

		// 工具配置验证
		if (!Array.isArray(agentConfig.tools)) {
			errors.push(`代理 "${agentId}" 的tools字段必须是数组`);
		}

		// 子代理配置验证
		if (!Array.isArray(agentConfig.availableSubAgents)) {
			errors.push(`代理 "${agentId}" 的availableSubAgents字段必须是数组`);
		}
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
	};
}

/**
 * 检测当前是否使用项目级主代理配置
 * @returns 是否使用项目级配置
 */
export function isUsingProjectMainAgentConfig(): boolean {
	const projectConfigPath = getProjectMainAgentConfigPath();
	if (!existsToml(projectConfigPath)) {
		return false;
	}
	// 检查项目级配置是否为空
	const projectConfig = readToml<MainAgentConfigFile>(projectConfigPath);
	return (
		projectConfig !== null &&
		typeof projectConfig === 'object' &&
		Object.keys(projectConfig).length > 0
	);
}

/**
 * 获取全局主代理配置路径（用于复制操作）
 */
export function getGlobalMainAgentConfigPath(): string {
	ensureConfigDir();
	return CONFIG_PATH;
}

/**
 * 获取项目级主代理配置路径（公开版，用于复制操作）
 */
export function getProjectMainAgentConfigPathPublic(): string {
	return getProjectMainAgentConfigPath();
}
