import type {PrecheckIssue, PrecheckRule, QuoteToken} from '../types.js';
import {isEscaped, startsWithAt} from './shared.js';

export class QuotesRule implements PrecheckRule {
	id = 'quotes';

	applies(ctx: any): boolean {
		return (ctx.profile.quotes || []).length > 0;
	}

	check(text: string, ctx: any): PrecheckIssue[] {
		const issues: PrecheckIssue[] = [];
		const quotes: QuoteToken[] = ctx.profile.quotes;

		// for now: enforce even-count for single/double/backtick; and pair-count for triple quotes
		let single = 0;
		let double = 0;
		let backtick = 0;
		let tripleSingle = 0;
		let tripleDouble = 0;

		let inLineComment = false;
		let inBlockComment = false;
		let inSingle = false;
		let inDouble = false;
		let inBacktick = false;

		const hasTripleSingle = quotes.some(q => q.kind === 'triple-single');
		const hasTripleDouble = quotes.some(q => q.kind === 'triple-double');

		for (let i = 0; i < text.length; i++) {
			const ch = text[i] || '';
			const next = i + 1 < text.length ? text[i + 1] : '';

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

			// line/block comments (minimal, language-aware)
			if (!inSingle && !inDouble && !inBacktick) {
				if (ctx?.profile?.id === 'python' && ch === '#') {
					inLineComment = true;
					continue;
				}
				if (ctx?.profile?.id === 'jsLike' && ch === '/' && next === '/') {
					inLineComment = true;
					i++;
					continue;
				}
				if (ctx?.profile?.id === 'jsLike' && ch === '/' && next === '*') {
					inBlockComment = true;
					i++;
					continue;
				}
			}

			// triple quotes (python): when not inside other quotes/comments
			if (!inSingle && !inDouble && !inBacktick) {
				if (
					hasTripleSingle &&
					startsWithAt(text, i, "'''") &&
					!isEscaped(text, i)
				) {
					tripleSingle++;
					i += 2;
					continue;
				}
				if (
					hasTripleDouble &&
					startsWithAt(text, i, '"""') &&
					!isEscaped(text, i)
				) {
					tripleDouble++;
					i += 2;
					continue;
				}
			}

			if ((inSingle || inDouble || inBacktick) && ch === '\\') {
				i++;
				continue;
			}

			if (!inDouble && !inBacktick && ch === "'") {
				single++;
				inSingle = !inSingle;
				continue;
			}
			if (!inSingle && !inBacktick && ch === '"') {
				double++;
				inDouble = !inDouble;
				continue;
			}
			if (!inSingle && !inDouble && ch === '`') {
				backtick++;
				inBacktick = !inBacktick;
				continue;
			}
		}

		const checkEven = (count: number, label: string) => {
			if (count % 2 !== 0) {
				issues.push({
					code: 'quote_unbalanced',
					message: `${ctx.contentKind}Content ${label} 不平衡 (count=${count})`,
				});
			}
		};

		checkEven(single, '单引号');
		checkEven(double, '双引号');
		checkEven(backtick, '反引号');
		if (hasTripleSingle) checkEven(tripleSingle, "三引号 '''");
		if (hasTripleDouble) checkEven(tripleDouble, '三引号 """');

		return issues;
	}
}
