/**
 * AGENTS.md 相关工具函数
 * 为主代理和子代理提供 AGENTS.md 内容读取支持
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * 读取指定路径的文件内容(如果存在)
 * @param filePath 文件路径
 * @returns 文件内容或空字符串
 */
export function readFileIfExists(filePath: string): string {
	try {
		if (fs.existsSync(filePath)) {
			return fs.readFileSync(filePath, 'utf-8').trim();
		}
		return '';
	} catch (error) {
		console.error(`Failed to read file ${filePath}:`, error);
		return '';
	}
}

/**
 * 获取代理提示，动态读取 AGENTS.md（如果存在）
 * 优先级：全局 AGENTS.md（基础）+ 项目 AGENTS.md（补充）
 * 返回合并后的内容，全局内容在前，项目内容在后
 */
export function getAgentsPrompt(): string {
	const agentsContents: string[] = [];

	// 1. 首先读取全局 AGENTS.md（基础内容）
	const globalContent = readFileIfExists(
		path.join(os.homedir(), '.snow', 'AGENTS.md'),
	);
	if (globalContent) {
		agentsContents.push(globalContent);
	}

	// 2. 读取项目级 AGENTS.md（补充内容）
	const projectContent = readFileIfExists(
		path.join(process.cwd(), 'AGENTS.md'),
	);
	if (projectContent) {
		agentsContents.push(projectContent);
	}

	// 3. 返回合并内容
	if (agentsContents.length > 0) {
		const mergedContent = agentsContents.join('\n\n');
		return mergedContent;
	}

	return '';
}