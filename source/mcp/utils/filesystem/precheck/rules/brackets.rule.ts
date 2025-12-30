import type {PrecheckIssue, PrecheckRule} from '../types.js';
import {isEscaped, startsWithAt} from './shared.js';

export class BracketsRule implements PrecheckRule {
	id = 'brackets';

	applies(ctx: any): boolean {
		return !ctx?.skipBracketsCheck;
	}

	check(text: string, ctx: any): PrecheckIssue[] {
		const issues: PrecheckIssue[] = [];
		const counts = {
			curly: {open: 0, close: 0, label: '大括号 {}'},
			round: {open: 0, close: 0, label: '小括号 ()'},
			square: {open: 0, close: 0, label: '中括号 []'},
		};

		let inSingle = false;
		let inDouble = false;
		let inBacktick = false;
		let inLineComment = false;
		let inBlockComment = false;

		const isPython = ctx?.profile?.id === 'python';
		const isJsLike = ctx?.profile?.id === 'jsLike';

		for (let i = 0; i < text.length; i++) {
			const ch = text[i] || '';
			const next = i + 1 < text.length ? text[i + 1] : '';

			if (inLineComment) {
				if (ch === '\n') inLineComment = false;
				continue;
			}
			if (inBlockComment) {
				if (isJsLike && ch === '*' && next === '/') {
					inBlockComment = false;
					i++;
				}
				continue;
			}

			if (!inSingle && !inDouble && !inBacktick) {
				if (isPython && ch === '#') {
					inLineComment = true;
					continue;
				}
				if (isJsLike && ch === '/' && next === '/') {
					inLineComment = true;
					i++;
					continue;
				}
				if (isJsLike && ch === '/' && next === '*') {
					inBlockComment = true;
					i++;
					continue;
				}
			}

			if ((inSingle || inDouble || inBacktick) && ch === '\\') {
				i++;
				continue;
			}

			// python triple quotes: treat as opaque block and skip counting inside
			if (isPython && !inSingle && !inDouble && !inBacktick) {
				if (startsWithAt(text, i, "'''") || startsWithAt(text, i, '"""')) {
					const delim = startsWithAt(text, i, "'''") ? "'''" : '"""';
					const closeIndex = text.indexOf(delim, i + 3);
					if (closeIndex === -1) {
						break;
					}
					i = closeIndex + 2;
					continue;
				}
			}

			// toggle quotes to skip bracket chars inside them
			if (!inDouble && !inBacktick && ch === "'" && !isEscaped(text, i)) {
				inSingle = !inSingle;
				continue;
			}
			if (!inSingle && !inBacktick && ch === '"' && !isEscaped(text, i)) {
				inDouble = !inDouble;
				continue;
			}
			if (!inSingle && !inDouble && ch === '`' && !isEscaped(text, i)) {
				inBacktick = !inBacktick;
				continue;
			}

			if (inSingle || inDouble || inBacktick) continue;

			if (ch === '{') counts.curly.open++;
			else if (ch === '}') counts.curly.close++;
			else if (ch === '(') counts.round.open++;
			else if (ch === ')') counts.round.close++;
			else if (ch === '[') counts.square.open++;
			else if (ch === ']') counts.square.close++;
		}

		(Object.keys(counts) as Array<keyof typeof counts>).forEach(kind => {
			const item = counts[kind];
			if (item.open !== item.close) {
				issues.push({
					code: 'brackets_unbalanced',
					message: `${ctx.contentKind}Content ${item.label} 不平衡 (open=${item.open}, close=${item.close})`,
				});
			}
		});

		return issues;
	}
}
