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

function stripCommentsOnly(content: string): string {
	return content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function stripStringsOnly(content: string): string {
	return content.replace(
		/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
		'""',
	);
}

type HtmlTagBalance = {
	unclosedTags: string[];
	unopenedTags: string[];
	balanced: boolean;
};

function analyzeJsxHtmlTagBalance(content: string): HtmlTagBalance {
	const tagStack: string[] = [];
	const unopenedTags: string[] = [];

	const pushOpen = (name: string) => tagStack.push(name.toLowerCase());
	const popClose = (name: string) => {
		const expected = tagStack.pop();
		const actual = name.toLowerCase();
		if (!expected || expected !== actual) {
			unopenedTags.push(actual);
			if (expected) tagStack.push(expected);
		}
	};

	const isNameStart = (ch: string) => /[A-Za-z]/.test(ch);
	const isNameChar = (ch: string) => /[A-Za-z0-9-]/.test(ch);

	let i = 0;
	let mode: 'text' | 'tag' | 'jsxExpr' = 'text';
	let braceDepth = 0;
	let inSingle = false;
	let inDouble = false;
	let inBacktick = false;

	const resetQuotes = () => {
		inSingle = false;
		inDouble = false;
		inBacktick = false;
	};

	while (i < content.length) {
		const ch = content[i] || '';
		const next = i + 1 < content.length ? content[i + 1] : '';

		// Escape inside quotes
		if ((inSingle || inDouble || inBacktick) && ch === '\\') {
			i += 2;
			continue;
		}

		// Quote toggles (only meaningful in tag/jsxExpr)
		if (mode !== 'text') {
			if (!inDouble && !inBacktick && ch === "'") {
				inSingle = !inSingle;
				i++;
				continue;
			}
			if (!inSingle && !inBacktick && ch === '"') {
				inDouble = !inDouble;
				i++;
				continue;
			}
			if (!inSingle && !inDouble && ch === '`') {
				inBacktick = !inBacktick;
				i++;
				continue;
			}
		}

		if (mode === 'jsxExpr') {
			if (inSingle || inDouble || inBacktick) {
				i++;
				continue;
			}
			if (ch === '{') {
				braceDepth++;
				i++;
				continue;
			}
			if (ch === '}') {
				braceDepth--;
				i++;
				if (braceDepth <= 0) {
					mode = 'tag';
					braceDepth = 0;
				}
				continue;
			}
			i++;
			continue;
		}

		if (mode === 'tag') {
			if (inSingle || inDouble || inBacktick) {
				i++;
				continue;
			}
			if (ch === '{') {
				mode = 'jsxExpr';
				braceDepth = 1;
				i++;
				continue;
			}
			if (ch === '>') {
				mode = 'text';
				resetQuotes();
				i++;
				continue;
			}
			// Detect self-closing end
			if (ch === '/' && next === '>') {
				mode = 'text';
				resetQuotes();
				i += 2;
				continue;
			}
			i++;
			continue;
		}

		// mode === 'text'
		if (ch === '<') {
			// fragment open <>
			if (next === '>') {
				pushOpen('#fragment');
				mode = 'text';
				i += 2;
				continue;
			}

			// closing
			if (next === '/') {
				let j = i + 2;
				while (j < content.length && /\s/.test(content[j] || '')) j++;
				const afterSlash = content[j] || '';

				// fragment close </>
				if (afterSlash === '>') {
					popClose('#fragment');
					i = j + 1;
					continue;
				}

				// broken closing like "</" or "</  "
				if (!isNameStart(afterSlash)) {
					unopenedTags.push('#broken');
					i += 2;
					continue;
				}

				let name = '';
				while (j < content.length && isNameChar(content[j] || '')) {
					name += content[j] || '';
					j++;
				}
				if (name.length === 0) {
					unopenedTags.push('#broken');
					i += 2;
					continue;
				}
				popClose(name);
				mode = 'tag';
				i = j;
				continue;
			}

			// opening tag
			let j = i + 1;
			while (j < content.length && /\s/.test(content[j] || '')) j++;
			const start = content[j] || '';
			if (!isNameStart(start)) {
				// ignore <! ...> or invalid
				i++;
				continue;
			}
			let name = '';
			while (j < content.length && isNameChar(content[j] || '')) {
				name += content[j] || '';
				j++;
			}
			if (name.length > 0) pushOpen(name);
			mode = 'tag';
			i = j;
			continue;
		}

		i++;
	}

	const unclosedTags = [...tagStack];
	return {
		unclosedTags,
		unopenedTags,
		balanced: unclosedTags.length === 0 && unopenedTags.length === 0,
	};
}
function stripJsTsRegexLiteralsForBalance(content: string): string {
	// Heuristic: remove JS/TS regex literals /.../flags so tokens inside regex ([],(),{},quotes,/* */) don't trigger false positives.
	// NOTE: This is not a full tokenizer; it trades perfect accuracy for fewer false positives.
	let out = '';
	let inSingle = false;
	let inDouble = false;
	let inBacktick = false;
	let inLineComment = false;
	let inBlockComment = false;
	// previous non-whitespace, non-comment char (very rough)
	let prevSignificant = '';

	const canStartRegexAfter = (ch: string): boolean => {
		// If previous significant token is empty or one of these, a / is more likely to start a regex than be division.
		return ch === '' || '([{:;,=!?&|+-*%^~<>'.includes(ch);
	};

	for (let i = 0; i < content.length; i++) {
		const ch = content[i] || '';
		const next = i + 1 < content.length ? content[i + 1] : '';

		if (inLineComment) {
			out += ch;
			if (ch === '\n') {
				inLineComment = false;
				prevSignificant = '';
			}
			continue;
		}
		if (inBlockComment) {
			out += ch;
			if (ch === '*' && next === '/') {
				out += next;
				inBlockComment = false;
				i++;
				prevSignificant = '';
			}
			continue;
		}

		// start comments (only when not in string/template)
		if (!inSingle && !inDouble && !inBacktick) {
			if (ch === '/' && next === '/') {
				out += ch + next;
				inLineComment = true;
				i++;
				continue;
			}
			if (ch === '/' && next === '*') {
				out += ch + next;
				inBlockComment = true;
				i++;
				continue;
			}
		}

		// handle escapes inside strings/templates
		if ((inSingle || inDouble || inBacktick) && ch === '\\') {
			out += ch;
			if (next) {
				out += next;
				i++;
			}
			continue;
		}

		// toggle string/template states
		if (!inDouble && !inBacktick && ch === "'") {
			out += ch;
			inSingle = !inSingle;
			prevSignificant = ch;
			continue;
		}
		if (!inSingle && !inBacktick && ch === '"') {
			out += ch;
			inDouble = !inDouble;
			prevSignificant = ch;
			continue;
		}
		if (!inSingle && !inDouble && ch === '`') {
			out += ch;
			inBacktick = !inBacktick;
			prevSignificant = ch;
			continue;
		}

		// detect regex literal start (only outside strings/comments)
		if (
			!inSingle &&
			!inDouble &&
			!inBacktick &&
			ch === '/' &&
			next !== '/' &&
			next !== '*' &&
			canStartRegexAfter(prevSignificant)
		) {
			// skip until closing /, handling escapes and character classes
			out += '/__REGEX__/';
			let inCharClass = false;
			for (i = i + 1; i < content.length; i++) {
				const c = content[i] || '';
				if (c === '\\') {
					i++;
					continue;
				}
				if (!inCharClass && c === '[') {
					inCharClass = true;
					continue;
				}
				if (inCharClass && c === ']') {
					inCharClass = false;
					continue;
				}
				if (!inCharClass && c === '/') {
					// consume flags
					let j = i + 1;
					while (j < content.length && /[a-z]/i.test(content[j] || '')) j++;
					i = j - 1;
					break;
				}
			}
			prevSignificant = '/';
			continue;
		}

		out += ch;
		if (!/\s/.test(ch)) prevSignificant = ch;
	}
	return out;
}
function stripRubyRegexLiteralsForBalance(content: string): string {
	// Heuristic: remove Ruby regex literals /.../opts and %r{...}opts to avoid balance false positives.
	let out = '';
	let inSingle = false;
	let inDouble = false;
	let inBacktick = false;
	let inLineComment = false;
	let inBlockComment = false;
	let prevSignificant = '';
	const canStartRegexAfter = (ch: string): boolean =>
		ch === '' || '([{:;,=!?&|+-*%^~<>'.includes(ch);
	const openToClose: Record<string, string> = {
		'(': ')',
		'[': ']',
		'{': '}',
		'<': '>',
	};
	for (let i = 0; i < content.length; i++) {
		const ch = content[i] || '';
		const next = i + 1 < content.length ? content[i + 1] : '';
		if (inLineComment) {
			out += ch;
			if (ch === '\n') {
				inLineComment = false;
				prevSignificant = '';
			}
			continue;
		}
		if (inBlockComment) {
			out += ch;
			if (ch === '=' && next === 'e' && content.slice(i, i + 4) === '=end') {
				inBlockComment = false;
			}
			continue;
		}
		if (!inSingle && !inDouble && !inBacktick) {
			if (ch === '#') {
				inLineComment = true;
				out += ch;
				continue;
			}
			if (ch === '=' && content.slice(i, i + 6) === '=begin') {
				inBlockComment = true;
				out += '=begin';
				i += 5;
				continue;
			}
		}
		if ((inSingle || inDouble || inBacktick) && ch === '\\') {
			out += ch + (next || '');
			if (next) i++;
			continue;
		}
		if (!inDouble && !inBacktick && ch === "'") {
			out += ch;
			inSingle = !inSingle;
			prevSignificant = ch;
			continue;
		}
		if (!inSingle && !inBacktick && ch === '"') {
			out += ch;
			inDouble = !inDouble;
			prevSignificant = ch;
			continue;
		}
		if (!inSingle && !inDouble && ch === '`') {
			out += ch;
			inBacktick = !inBacktick;
			prevSignificant = ch;
			continue;
		}
		// %r delimiter form
		if (!inSingle && !inDouble && !inBacktick && ch === '%' && next === 'r') {
			const delim = content[i + 2] || '';
			const closeDelim = openToClose[delim] || delim;
			if (delim) {
				out += '%r__REGEX__';
				i += 2;
				let escaped = false;
				for (i = i + 1; i < content.length; i++) {
					const c = content[i] || '';
					if (!escaped && c === '\\') {
						escaped = true;
						continue;
					}
					if (escaped) {
						escaped = false;
						continue;
					}
					if (c === closeDelim) break;
				}
				// consume options
				let j = i + 1;
				while (j < content.length && /[a-z]/i.test(content[j] || '')) j++;
				i = j - 1;
				prevSignificant = 'r';
				continue;
			}
		}
		// /.../opts form (heuristic like JS)
		if (
			!inSingle &&
			!inDouble &&
			!inBacktick &&
			ch === '/' &&
			canStartRegexAfter(prevSignificant)
		) {
			out += '/__REGEX__/';
			let inCharClass = false;
			for (i = i + 1; i < content.length; i++) {
				const c = content[i] || '';
				if (c === '\\') {
					i++;
					continue;
				}
				if (!inCharClass && c === '[') {
					inCharClass = true;
					continue;
				}
				if (inCharClass && c === ']') {
					inCharClass = false;
					continue;
				}
				if (!inCharClass && c === '/') {
					let j = i + 1;
					while (j < content.length && /[a-z]/i.test(content[j] || '')) j++;
					i = j - 1;
					break;
				}
			}
			prevSignificant = '/';
			continue;
		}
		out += ch;
		if (!/\s/.test(ch)) prevSignificant = ch;
	}
	return out;
}

function stripPhpRegexLiteralsForBalance(content: string): string {
	// Heuristic: remove PHP PCRE regex literals with variable delimiters, e.g. /.../imsu, #...#i, ~...~.
	let out = '';
	let inSingle = false;
	let inDouble = false;
	let inLineComment = false;
	let inBlockComment = false;
	let prevSignificant = '';
	const canStartAfter = (ch: string): boolean =>
		ch === '' || '([{:;,=!?&|+-*%^~<>'.includes(ch);
	const isDelim = (ch: string): boolean =>
		/[^a-z0-9\s]/i.test(ch) && ch !== '\\' && ch !== '"' && ch !== "'";
	for (let i = 0; i < content.length; i++) {
		const ch = content[i] || '';
		const next = i + 1 < content.length ? content[i + 1] : '';
		if (inLineComment) {
			out += ch;
			if (ch === '\n') {
				inLineComment = false;
				prevSignificant = '';
			}
			continue;
		}
		if (inBlockComment) {
			out += ch;
			if (ch === '*' && next === '/') {
				out += next;
				inBlockComment = false;
				i++;
				prevSignificant = '';
			}
			continue;
		}
		if (!inSingle && !inDouble) {
			if (ch === '/' && next === '/') {
				out += ch + next;
				inLineComment = true;
				i++;
				continue;
			}
			if (ch === '#') {
				out += ch;
				inLineComment = true;
				continue;
			}
			if (ch === '/' && next === '*') {
				out += ch + next;
				inBlockComment = true;
				i++;
				continue;
			}
		}
		if ((inSingle || inDouble) && ch === '\\') {
			out += ch + (next || '');
			if (next) i++;
			continue;
		}
		if (!inDouble && ch === "'") {
			out += ch;
			inSingle = !inSingle;
			prevSignificant = ch;
			continue;
		}
		if (!inSingle && ch === '"') {
			out += ch;
			inDouble = !inDouble;
			prevSignificant = ch;
			continue;
		}
		if (
			!inSingle &&
			!inDouble &&
			canStartAfter(prevSignificant) &&
			isDelim(ch)
		) {
			// attempt delimiter-based regex
			const delim = ch;
			out += delim + '__REGEX__' + delim;
			let escaped = false;
			for (i = i + 1; i < content.length; i++) {
				const c = content[i] || '';
				if (!escaped && c === '\\') {
					escaped = true;
					continue;
				}
				if (escaped) {
					escaped = false;
					continue;
				}
				if (c === delim) {
					// consume modifiers
					let j = i + 1;
					while (j < content.length && /[a-z]/i.test(content[j] || '')) j++;
					i = j - 1;
					break;
				}
			}
			prevSignificant = delim;
			continue;
		}
		out += ch;
		if (!/\s/.test(ch)) prevSignificant = ch;
	}
	return out;
}

function stripPerlRegexLiteralsForBalance(content: string): string {
	// Heuristic: remove Perl regex literals m// and s/// (and bare /.../), ignoring strings/comments.
	let out = '';
	let inSingle = false;
	let inDouble = false;
	let inLineComment = false;
	let prevSignificant = '';
	const canStartAfter = (ch: string): boolean =>
		ch === '' || '([{:;,=!?&|+-*%^~<>'.includes(ch);
	const openToClose: Record<string, string> = {
		'(': ')',
		'[': ']',
		'{': '}',
		'<': '>',
	};
	for (let i = 0; i < content.length; i++) {
		const ch = content[i] || '';
		const next = i + 1 < content.length ? content[i + 1] : '';
		if (inLineComment) {
			out += ch;
			if (ch === '\n') {
				inLineComment = false;
				prevSignificant = '';
			}
			continue;
		}
		if (!inSingle && !inDouble && ch === '#') {
			out += ch;
			inLineComment = true;
			continue;
		}
		if ((inSingle || inDouble) && ch === '\\') {
			out += ch + (next || '');
			if (next) i++;
			continue;
		}
		if (!inDouble && ch === "'") {
			out += ch;
			inSingle = !inSingle;
			prevSignificant = ch;
			continue;
		}
		if (!inSingle && ch === '"') {
			out += ch;
			inDouble = !inDouble;
			prevSignificant = ch;
			continue;
		}
		// s{a}{b} or s/a/b/
		if (
			!inSingle &&
			!inDouble &&
			ch === 's' &&
			canStartAfter(prevSignificant)
		) {
			const delim = next;
			if (delim) {
				const closeDelim = openToClose[delim] || delim;
				out +=
					's' +
					delim +
					'__REGEX__' +
					closeDelim +
					delim +
					'__REGEX__' +
					closeDelim;
				i++;
				let part = 0;
				let escaped = false;
				for (i = i + 1; i < content.length; i++) {
					const c = content[i] || '';
					if (!escaped && c === '\\') {
						escaped = true;
						continue;
					}
					if (escaped) {
						escaped = false;
						continue;
					}
					if (c === closeDelim) {
						part++;
						if (part >= 2) {
							let j = i + 1;
							while (j < content.length && /[a-z]/i.test(content[j] || '')) j++;
							i = j - 1;
							break;
						}
					}
				}
				prevSignificant = 's';
				continue;
			}
		}
		// m/.../ or bare /.../
		if (
			!inSingle &&
			!inDouble &&
			((ch === 'm' && canStartAfter(prevSignificant)) ||
				(ch === '/' && canStartAfter(prevSignificant)))
		) {
			const isM = ch === 'm';
			const delim = isM ? next : ch;
			if (delim && delim !== ' ') {
				const closeDelim = openToClose[delim] || delim;
				out += (isM ? 'm' : '') + delim + '__REGEX__' + closeDelim;
				if (isM) i++;
				let escaped = false;
				for (i = i + 1; i < content.length; i++) {
					const c = content[i] || '';
					if (!escaped && c === '\\') {
						escaped = true;
						continue;
					}
					if (escaped) {
						escaped = false;
						continue;
					}
					if (c === closeDelim) {
						let j = i + 1;
						while (j < content.length && /[a-z]/i.test(content[j] || '')) j++;
						i = j - 1;
						break;
					}
				}
				prevSignificant = delim;
				continue;
			}
		}
		out += ch;
		if (!/\s/.test(ch)) prevSignificant = ch;
	}
	return out;
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

	const contentForBracketAnalysis = /\.(js|jsx|mjs|cjs|ts|tsx)$/i.test(filePath)
		? stripJsTsRegexLiteralsForBalance(content)
		: /\.(rb|ru)$/i.test(filePath)
		? stripRubyRegexLiteralsForBalance(content)
		: /\.(php)$/i.test(filePath)
		? stripPhpRegexLiteralsForBalance(content)
		: /\.(pl|pm)$/i.test(filePath)
		? stripPerlRegexLiteralsForBalance(content)
		: content;
	const cleanContent = stripStringsAndCommentsForBalance(
		contentForBracketAnalysis,
	);

	analysis.bracketBalance.curly = countPairs(cleanContent, '{', '}');
	analysis.bracketBalance.round = countPairs(cleanContent, '(', ')');
	analysis.bracketBalance.square = countPairs(cleanContent, '[', ']');

	// Quote / block comment pair analysis (only for code-like files to avoid false positives)
	const isCodeLikeFile =
		/\.(c|cc|cpp|cs|go|java|js|jsx|mjs|cjs|ts|tsx|php|rs|swift|kt|kts|py|rb|lua|html|vue|svelte|css|scss|less|json|jsonc)$/i.test(
			filePath,
		);
	if (isCodeLikeFile) {
		const contentForPairAnalysis = /\.(js|jsx|mjs|cjs|ts|tsx)$/i.test(filePath)
			? stripJsTsRegexLiteralsForBalance(content)
			: /\.(rb|ru)$/i.test(filePath)
			? stripRubyRegexLiteralsForBalance(content)
			: /\.(php)$/i.test(filePath)
			? stripPhpRegexLiteralsForBalance(content)
			: /\.(pl|pm)$/i.test(filePath)
			? stripPerlRegexLiteralsForBalance(content)
			: content;
		analysis.quoteBalance = analyzeQuoteBalance(contentForPairAnalysis);
		analysis.commentBalance = analyzeCommentBalance(contentForPairAnalysis);
	}

	// HTML/JSX tag analysis (for .html, .jsx, .tsx, .vue files)
	// NOTE: `.mjs`/`.ts` files can legally contain JSX-like fragments in some workflows;
	// enabling tag balance here improves safety of filesystem-edit_search pre-check.
	const isMarkupFile = /\.(html|jsx|tsx|vue|mjs|js)$/i.test(filePath);
	if (isMarkupFile) {
		// IMPORTANT:
		// - Do NOT run tag regex on `cleanContent` (it replaces strings with ""), because it can change
		//   the location of `>` and cause false positives (e.g. `<h3 className="title">..</h3>` mis-detected as unclosed).
		// - For tag balance, we strip comments and (loosely) strip string/template literals to reduce
		//   false positives from text that looks like tags.
		// - JSX/TSX isn't HTML; we implement a small tokenizer to avoid common JSX expression pitfalls.
		const markupContent = stripStringsOnly(stripCommentsOnly(content));

		analysis.htmlTags = analyzeJsxHtmlTagBalance(markupContent);
		// normalize: treat any broken tag marker as unopened to make diagnostics clearer
		analysis.htmlTags.unopenedTags =
			analysis.htmlTags.unopenedTags.filter(Boolean);
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
