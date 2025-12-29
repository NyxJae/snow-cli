/**
 * Code analysis utilities for structure validation
 */

import type {StructureAnalysis} from '../../types/filesystem.types.js';

function stripStringsAndCommentsForBalance(content: string): string {
	return content
		.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '""')
		.replace(/\/\/.*$/gm, '')
		.replace(/\/\*[\s\S]*?\*\//g, '');
}

function countPairs(
	cleanContent: string,
	openToken: string,
	closeToken: string,
): {open: number; close: number; balanced: boolean} {
	const open = (cleanContent.match(new RegExp(`\\${openToken}`, 'g')) || [])
		.length;
	const close = (cleanContent.match(new RegExp(`\\${closeToken}`, 'g')) || [])
		.length;
	return {open, close, balanced: open === close};
}

type PairCount = {open: number; close: number; balanced: boolean};

type QuoteBalance = {
	single: PairCount;
	double: PairCount;
	backtick: PairCount;
};

type CommentBalance = {
	block: PairCount;
};

function analyzeQuoteBalance(content: string): QuoteBalance {
	let singleCount = 0;
	let doubleCount = 0;
	let backtickCount = 0;

	let inSingle = false;
	let inDouble = false;
	let inBacktick = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < content.length; i++) {
		const ch = content[i];
		const next = i + 1 < content.length ? content[i + 1] : '';

		if (inLineComment) {
			if (ch === '\n') inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			if (ch === '*' && next === '/') {
				inBlockComment = false;
				i++;
			}
			continue;
		}

		if (!inSingle && !inDouble && !inBacktick) {
			if (ch === '/' && next === '/') {
				inLineComment = true;
				i++;
				continue;
			}
			if (ch === '/' && next === '*') {
				inBlockComment = true;
				i++;
				continue;
			}
		}

		if (ch === '\\' && (inSingle || inDouble || inBacktick)) {
			i++;
			continue;
		}

		if (ch === "'" && !inDouble && !inBacktick) {
			singleCount++;
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle && !inBacktick) {
			doubleCount++;
			inDouble = !inDouble;
			continue;
		}
		if (ch === '`' && !inSingle && !inDouble) {
			backtickCount++;
			inBacktick = !inBacktick;
			continue;
		}
	}

	return {
		single: {
			open: singleCount,
			close: singleCount,
			balanced: singleCount % 2 === 0,
		},
		double: {
			open: doubleCount,
			close: doubleCount,
			balanced: doubleCount % 2 === 0,
		},
		backtick: {
			open: backtickCount,
			close: backtickCount,
			balanced: backtickCount % 2 === 0,
		},
	};
}

function analyzeCommentBalance(content: string): CommentBalance {
	const noStrings = content.replace(
		/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
		'""',
	);
	const open = (noStrings.match(/\/\*/g) || []).length;
	const close = (noStrings.match(/\*\//g) || []).length;
	return {block: {open, close, balanced: open === close}};
}
export function analyzeContentBalance(
	content: string,
	filePath: string,
): StructureAnalysis {
	const analysis: StructureAnalysis = {
		bracketBalance: {
			curly: {open: 0, close: 0, balanced: true},
			round: {open: 0, close: 0, balanced: true},
			square: {open: 0, close: 0, balanced: true},
		},
		indentationWarnings: [],
	};

	const cleanContent = stripStringsAndCommentsForBalance(content);

	analysis.bracketBalance.curly = countPairs(cleanContent, '{', '}');
	analysis.bracketBalance.round = countPairs(cleanContent, '(', ')');
	analysis.bracketBalance.square = countPairs(cleanContent, '[', ']');

	// Quote / block comment pair analysis (only for code-like files to avoid false positives)
	const isCodeLikeFile =
		/\.(c|cc|cpp|cs|go|java|js|jsx|mjs|cjs|ts|tsx|php|rs|swift|kt|kts|py|rb|lua|html|vue|svelte|css|scss|less|json|jsonc)$/i.test(
			filePath,
		);
	if (isCodeLikeFile) {
		analysis.quoteBalance = analyzeQuoteBalance(content);
		analysis.commentBalance = analyzeCommentBalance(content);
	}

	return analysis;
}

export function analyzeCodeStructure(
	_content: string,
	filePath: string,
	editedLines: string[],
): StructureAnalysis {
	const editedContent = editedLines.join('\n');
	const analysis = analyzeContentBalance(editedContent, filePath);

	// Check indentation consistency
	const lines = editedContent.split('\n');
	const indents = lines
		.filter(line => line.trim().length > 0)
		.map(line => {
			const match = line.match(/^(\s*)/);
			return match ? match[1] : '';
		})
		.filter((indent): indent is string => indent !== undefined);

	// Detect mixed tabs/spaces
	const hasTabs = indents.some(indent => indent.includes('\t'));
	const hasSpaces = indents.some(indent => indent.includes(' '));
	if (hasTabs && hasSpaces) {
		analysis.indentationWarnings.push('Mixed tabs and spaces detected');
	}

	// Detect inconsistent indentation levels (spaces only)
	if (!hasTabs && hasSpaces) {
		const spaceCounts = indents
			.filter(indent => indent.length > 0)
			.map(indent => indent.length);

		if (spaceCounts.length > 1) {
			const gcd = spaceCounts.reduce((a, b) => {
				while (b !== 0) {
					const temp = b;
					b = a % b;
					a = temp;
				}
				return a;
			});

			const hasInconsistent = spaceCounts.some(
				count => count % gcd !== 0 && gcd > 1,
			);
			if (hasInconsistent) {
				analysis.indentationWarnings.push(
					`Inconsistent indentation (expected multiples of ${gcd} spaces)`,
				);
			}
		}
	}

	return analysis;
}

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

export function checkEdgeIndentationConsistency(
	filePath: string,
	content: string,
): {ok: boolean; message?: string} {
	if (!/\.(py|yml|yaml)$/i.test(filePath)) return {ok: true};

	const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
	const first = getFirstNonEmptyLine(lines);
	const last = getLastNonEmptyLine(lines);
	if (!first || !last) return {ok: true};

	const firstIndent = first.match(/^(\s*)/)?.[1] || '';
	const lastIndent = last.match(/^(\s*)/)?.[1] || '';

	// only enforce for multi-line blocks
	if (lines.length >= 2 && firstIndent !== lastIndent) {
		return {
			ok: false,
			message: `缩进边界不一致：首行缩进(${JSON.stringify(
				firstIndent,
			)}) != 末行缩进(${JSON.stringify(
				lastIndent,
			)}). 对于 ${filePath} 这类缩进敏感文件，请以“完整代码块/完整 YAML 片段”为最小单位进行替换。`,
		};
	}

	return {ok: true};
}

/**
 * Find smart context boundaries for editing
 * Expands context to include complete code blocks when possible
 */
export function findSmartContextBoundaries(
	lines: string[],
	startLine: number,
	endLine: number,
	requestedContext: number,
): {start: number; end: number; extended: boolean} {
	const totalLines = lines.length;
	let contextStart = Math.max(1, startLine - requestedContext);
	let contextEnd = Math.min(totalLines, endLine + requestedContext);
	let extended = false;

	// Try to find the start of the enclosing block
	let bracketDepth = 0;
	for (let i = startLine - 1; i >= Math.max(0, startLine - 50); i--) {
		const line = lines[i];
		if (!line) continue;

		const trimmed = line.trim();

		// Count brackets (simple approach)
		const openBrackets = (line.match(/\{/g) || []).length;
		const closeBrackets = (line.match(/\}/g) || []).length;
		bracketDepth += closeBrackets - openBrackets;

		// If we find a function/class/block definition with balanced brackets
		if (
			bracketDepth === 0 &&
			(trimmed.match(
				/^(function|class|const|let|var|if|for|while|async|export)\s/i,
			) ||
				trimmed.match(/=>\s*\{/) ||
				trimmed.match(/^\w+\s*\(/))
		) {
			if (i + 1 < contextStart) {
				contextStart = i + 1;
				extended = true;
			}
			break;
		}
	}

	// Try to find the end of the enclosing block
	bracketDepth = 0;
	for (let i = endLine - 1; i < Math.min(totalLines, endLine + 50); i++) {
		const line = lines[i];
		if (!line) continue;

		const trimmed = line.trim();

		// Count brackets
		const openBrackets = (line.match(/\{/g) || []).length;
		const closeBrackets = (line.match(/\}/g) || []).length;
		bracketDepth += openBrackets - closeBrackets;

		// If we find a closing bracket at depth 0
		if (bracketDepth === 0 && trimmed.startsWith('}')) {
			if (i + 1 > contextEnd) {
				contextEnd = i + 1;
				extended = true;
			}
			break;
		}
	}

	return {start: contextStart, end: contextEnd, extended};
}
