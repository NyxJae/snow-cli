import {parse, stringify} from '@iarna/toml';
import {existsSync, readFileSync, writeFileSync} from 'fs';

/**
 * 读取TOML文件并解析为指定类型
 * @param filePath 文件路径
 * @returns 解析后的数据，文件不存在或解析失败时返回null
 * @note 此函数不会抛出异常，所有错误都通过返回null处理
 */
export function readToml<T>(filePath: string): T | null {
	try {
		if (!existsSync(filePath)) {
			return null;
		}

		const content = readFileSync(filePath, 'utf8');
		const parsed = parse(content) as T;
		return parsed;
	} catch (error) {
		console.error(`Failed to read TOML file ${filePath}:`, error);
		return null;
	}
}

/**
 * 写入数据到TOML文件
 * @param filePath 文件路径
 * @param data 要写入的数据
 * @throws Error 写入失败时抛出错误
 * @note 此函数在失败时会抛出异常，调用者需要处理错误
 */
export function writeToml<T>(filePath: string, data: T): void {
	try {
		const content = stringify(data as any);
		writeFileSync(filePath, content, 'utf8');
	} catch (error) {
		throw new Error(`Failed to write TOML file ${filePath}: ${error}`);
	}
}

/**
 * 检查TOML文件是否存在
 * @param filePath 文件路径
 * @returns 文件是否存在
 */
export function existsToml(filePath: string): boolean {
	return existsSync(filePath);
}

/**
 * 从JSON文件迁移到TOML文件
 * @param jsonPath JSON文件路径
 * @param tomlPath TOML文件路径
 * @returns 迁移是否成功
 * @note 此函数为未来扩展准备，当前项目中未使用
 */
export function migrateJsonToToml(jsonPath: string, tomlPath: string): boolean {
	if (!existsSync(jsonPath)) {
		return false; // 文件不存在是正常情况
	}

	try {
		const jsonData = readFileSync(jsonPath, 'utf8');
		const parsed = JSON.parse(jsonData);

		writeToml(tomlPath, parsed);
		return true;
	} catch (error) {
		throw new Error(
			`Failed to migrate JSON to TOML (${jsonPath} -> ${tomlPath}): ${error}`,
		);
	}
}
