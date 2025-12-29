import type {PrecheckIssue, PrecheckRule} from '../types.js';

function getFirstNonEmptyLine(lines: string[]): string | undefined {
	return lines.find(line => line.trim().length > 0);
}

function getLastNonEmptyLine(lines: string[]): string | undefined {
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (line && line.trim().length > 0) return line;
	}
	return undefined;
}

export class IndentationEdgeRule implements PrecheckRule {
	id = 'indentationEdge';

	applies(ctx: any): boolean {
		return Boolean(ctx.profile.indentationSensitive);
	}

	check(text: string, ctx: any): PrecheckIssue[] {
		const issues: PrecheckIssue[] = [];
		const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
		const first = getFirstNonEmptyLine(lines);
		const last = getLastNonEmptyLine(lines);
		if (!first || !last) return issues;

		const firstIndent = first.match(/^(\s*)/)?.[1] || '';
		const lastIndent = last.match(/^(\s*)/)?.[1] || '';

		if (lines.length >= 2 && firstIndent !== lastIndent) {
			issues.push({
				code: 'indentation_edge_inconsistent',
				message:
					`${ctx.contentKind}Content 缩进边界不一致：` +
					`首行缩进(${JSON.stringify(firstIndent)}) != ` +
					`末行缩进(${JSON.stringify(lastIndent)}). ` +
					`对于 ${ctx.filePath} 这类缩进敏感文件，请以“完整代码块/完整 YAML 片段”为最小单位进行替换。`,
			});
		}

		return issues;
	}
}
