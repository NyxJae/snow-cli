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
		// 验证输入数据
		if (data === null || data === undefined) {
			throw new Error('Data cannot be null or undefined');
		}

		// 尝试序列化为TOML
		let content: string;
		try {
			content = stringify(data as any);
		} catch (serializeError) {
			throw new Error(
				`Failed to serialize data to TOML: ${
					serializeError instanceof Error
						? serializeError.message
						: String(serializeError)
				}`,
			);
		}

		// 验证序列化结果
		if (!content || content.trim().length === 0) {
			throw new Error('Serialized TOML content is empty');
		}

		// 写入文件
		writeFileSync(filePath, content, 'utf8');

		// 验证文件是否成功写入
		if (!existsSync(filePath)) {
			throw new Error('File was not created after write operation');
		}

		// 验证文件内容是否可以正确读取
		try {
			const verifyContent = readFileSync(filePath, 'utf8');
			if (verifyContent !== content) {
				throw new Error('Written content does not match expected content');
			}
		} catch (verifyError) {
			throw new Error(
				`Failed to verify written file: ${
					verifyError instanceof Error
						? verifyError.message
						: String(verifyError)
				}`,
			);
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		console.error(`Failed to write TOML file ${filePath}:`, errorMessage);
		throw new Error(`Failed to write TOML file ${filePath}: ${errorMessage}`);
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
 * 验证TOML数据的完整性
 * @param data 要验证的数据
 * @returns 验证结果和错误信息
 */
export function validateTomlData(data: any): {
	isValid: boolean;
	errors: string[];
} {
	const errors: string[] = [];

	// 检查数据是否为null或undefined
	if (data === null || data === undefined) {
		errors.push('Data cannot be null or undefined');
		return {isValid: false, errors};
	}

	// 检查数据是否为对象
	if (typeof data !== 'object' || Array.isArray(data)) {
		errors.push('Data must be an object');
		return {isValid: false, errors};
	}

	// 尝试序列化以验证是否可以转换为TOML
	try {
		const serialized = stringify(data);
		if (!serialized || serialized.trim().length === 0) {
			errors.push('Data serialization resulted in empty content');
		}

		// 尝试反序列化以验证TOML格式的完整性
		try {
			const parsed = parse(serialized);
			// 简单的数据比较检查
			if (JSON.stringify(parsed) !== JSON.stringify(data)) {
				errors.push(
					'Data integrity check failed after serialization/deserialization',
				);
			}
		} catch (parseError) {
			errors.push(
				`TOML parsing validation failed: ${
					parseError instanceof Error ? parseError.message : String(parseError)
				}`,
			);
		}
	} catch (serializeError) {
		errors.push(
			`TOML serialization validation failed: ${
				serializeError instanceof Error
					? serializeError.message
					: String(serializeError)
			}`,
		);
	}

	return {
		isValid: errors.length === 0,
		errors,
	};
}

/**
 * 安全写入TOML文件（带验证）
 * @param filePath 文件路径
 * @param data 要写入的数据
 * @throws Error 验证失败或写入失败时抛出错误
 */
export function writeTomlSafe<T>(filePath: string, data: T): void {
	// 首先验证数据
	const validation = validateTomlData(data);
	if (!validation.isValid) {
		throw new Error(`Data validation failed: ${validation.errors.join(', ')}`);
	}

	// 使用改进的writeToml函数
	writeToml(filePath, data);
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
