import test from 'ava';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {FilesystemMCPService} from '../mcp/filesystem.js';

async function withTempDir<T>(
	run: (tempDir: string) => Promise<T>,
): Promise<T> {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), 'snow-fs-edit-search-'),
	);
	try {
		return await run(tempDir);
	} finally {
		await fs.rm(tempDir, {recursive: true, force: true});
	}
}

test('editFileBySearch should replace exact content in single file mode', async t => {
	await withTempDir(async tempDir => {
		const targetFile = path.join(tempDir, 'sample.ts');
		const initial = [
			'function sum(a: number, b: number) {',
			'\treturn a + b;',
			'}',
			'',
		].join('\n');
		await fs.writeFile(targetFile, initial, 'utf8');

		const service = new FilesystemMCPService(tempDir);
		const result = await service.editFileBySearch(
			'sample.ts',
			'return a + b;',
			'return a - b;',
		);

		const finalContent = await fs.readFile(targetFile, 'utf8');
		t.true(
			result.message.includes('File edited successfully using search-replace'),
		);
		t.true(finalContent.includes('return a - b;'));
		t.false(finalContent.includes('return a + b;'));
	});
});

test('editFileBySearch should require searchContent and replaceContent in single mode', async t => {
	await withTempDir(async tempDir => {
		const targetFile = path.join(tempDir, 'sample.ts');
		await fs.writeFile(targetFile, 'const value = 1;\n', 'utf8');
		const service = new FilesystemMCPService(tempDir);

		await t.throwsAsync(
			async () => {
				await service.editFileBySearch(
					'sample.ts',
					undefined,
					'const value = 2;',
				);
			},
			{
				message:
					'searchContent and replaceContent are required for single file mode',
			},
		);
	});
});

test('editFileBySearch should report not found when search content does not exist', async t => {
	await withTempDir(async tempDir => {
		const targetFile = path.join(tempDir, 'sample.ts');
		await fs.writeFile(
			targetFile,
			'const alpha = 1;\nconst beta = 2;\n',
			'utf8',
		);
		const service = new FilesystemMCPService(tempDir);

		const error = await t.throwsAsync(
			async () => {
				await service.editFileBySearch(
					'sample.ts',
					'const gamma = 3;',
					'const gamma = 4;',
				);
			},
			{instanceOf: Error},
		);

		t.truthy(error);
		t.true(
			error!.message.includes('Search content not found in file: sample.ts'),
		);
	});
});

test('editFileBySearch should validate occurrence when multiple matches exist', async t => {
	await withTempDir(async tempDir => {
		const targetFile = path.join(tempDir, 'sample.ts');
		await fs.writeFile(
			targetFile,
			'const value = 1;\nconst value = 1;\nconst value = 1;\n',
			'utf8',
		);
		const service = new FilesystemMCPService(tempDir);

		const error = await t.throwsAsync(
			async () => {
				await service.editFileBySearch(
					'sample.ts',
					'const value = 1;',
					'const value = 2;',
					99,
				);
			},
			{instanceOf: Error},
		);

		t.truthy(error);
		t.true(error!.message.includes('Invalid occurrence 99. Found'));
	});
});

test('editFileBySearch should handle multi-line replace when last line is closing brace', async t => {
	await withTempDir(async tempDir => {
		const targetFile = path.join(tempDir, 'sample.ts');
		await fs.writeFile(
			targetFile,
			[
				'function calc(a: number, b: number) {',
				'\tif (a > b) {',
				'\t\treturn a - b;',
				'\t}',
				'\treturn b - a;',
				'}',
				'',
			].join('\n'),
			'utf8',
		);
		const service = new FilesystemMCPService(tempDir);

		await service.editFileBySearch(
			'sample.ts',
			'if (a > b) {\n\t\treturn a - b;\n\t}',
			'if (a >= b) {\n\t\treturn a - b;\n\t}',
		);

		const finalContent = await fs.readFile(targetFile, 'utf8');
		t.true(finalContent.includes('if (a >= b) {\n\t\treturn a - b;\n\t}'));
		t.false(finalContent.includes('if (a > b) {\n\t\treturn a - b;\n\t}'));
	});
});

test('editFileBySearch should handle indented closing brace as last line in search and replace blocks', async t => {
	await withTempDir(async tempDir => {
		const targetFile = path.join(tempDir, 'sample.ts');
		await fs.writeFile(
			targetFile,
			[
				'function run(flag: boolean) {',
				'\tif (flag) {',
				"\t\tconsole.log('on');",
				'\t\treturn 1;',
				'\t}',
				'\treturn 0;',
				'}',
				'',
			].join('\n'),
			'utf8',
		);
		const service = new FilesystemMCPService(tempDir);

		await service.editFileBySearch(
			'sample.ts',
			"if (flag) {\n\t\tconsole.log('on');\n\t\treturn 1;\n\t}",
			"if (flag) {\n\t\tconsole.log('enabled');\n\t\treturn 1;\n\t}",
		);

		const finalContent = await fs.readFile(targetFile, 'utf8');
		t.true(
			finalContent.includes(
				"if (flag) {\n\t\tconsole.log('enabled');\n\t\treturn 1;\n\t}",
			),
		);
		t.false(
			finalContent.includes(
				"if (flag) {\n\t\tconsole.log('on');\n\t\treturn 1;\n\t}",
			),
		);
	});
});

test('editFileBySearch should allow replacing a block that ends with only } line', async t => {
	await withTempDir(async tempDir => {
		const targetFile = path.join(tempDir, 'sample.ts');
		await fs.writeFile(
			targetFile,
			['if (ready) {', '\tstart();', '}', 'end();', ''].join('\n'),
			'utf8',
		);
		const service = new FilesystemMCPService(tempDir);

		await service.editFileBySearch(
			'sample.ts',
			'if (ready) {\n\tstart();\n}',
			'if (ready) {\n\tstart();\n\tlog();\n}',
		);

		const finalContent = await fs.readFile(targetFile, 'utf8');
		t.true(finalContent.includes('if (ready) {\n\tstart();\n\tlog();\n}'));
	});
});

test('editFileBySearch should not swallow next line when searchContent has trailing newline', async t => {
	await withTempDir(async tempDir => {
		const targetFile = path.join(tempDir, 'sample.ts');
		await fs.writeFile(
			targetFile,
			[
				"import type {ConfirmationResult} from '../../ui/components/tools/ToolConfirmation.js';",
				"import type {ImageContent} from '../../api/types.js';",
				"import type {MultimodalContent} from '../../mcp/types/filesystem.types.js';",
				'//安全解析JSON，处理可能被拼接的多个JSON对象',
				'function safeParseToolArguments(argsString: string): Record<string, any> {',
				"\tif (!argsString || argsString.trim() === '') {",
				'\t\treturn {};',
				'\t}',
				'}',
				'',
			].join('\n'),
			'utf8',
		);
		const service = new FilesystemMCPService(tempDir);

		await service.editFileBySearch(
			'sample.ts',
			"import type {ConfirmationResult} from '../../ui/components/tools/ToolConfirmation.js';\nimport type {ImageContent} from '../../api/types.js';\nimport type {MultimodalContent} from '../../mcp/types/filesystem.types.js';\n//安全解析JSON，处理可能被拼接的多个JSON对象\nfunction safeParseToolArguments(argsString: string): Record<string, any> {\n",
			"import type {ConfirmationResult} from '../../ui/components/tools/ToolConfirmation.js';\nimport type {ImageContent} from '../../api/types.js';\nimport type {MultimodalContent} from '../../mcp/types/filesystem.types.js';\n\nimport fs from 'fs';\nimport path from 'path';\n\n//安全解析JSON，处理可能被拼接的多个JSON对象\nfunction safeParseToolArguments(argsString: string): Record<string, any> {\n",
		);

		const finalContent = await fs.readFile(targetFile, 'utf8');
		t.true(
			finalContent.includes("if (!argsString || argsString.trim() === '') {"),
		);
		t.false(
			finalContent.includes(
				"function safeParseToolArguments(argsString: string): Record<string, any> {\n\n\tif (!argsString || argsString.trim() === '') {",
			),
		);
	});
});
