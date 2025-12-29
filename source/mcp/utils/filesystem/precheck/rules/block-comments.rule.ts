import type {PrecheckIssue, PrecheckRule} from '../types.js';
import {startsWithAt} from './shared.js';

export class BlockCommentsRule implements PrecheckRule {
	id = 'blockComments';

	applies(ctx: any): boolean {
		return (ctx.profile.blockComments || []).length > 0;
	}

	check(text: string, ctx: any): PrecheckIssue[] {
		const issues: PrecheckIssue[] = [];
		for (const pair of ctx.profile.blockComments) {
			const open = pair.open;
			const close = pair.close;
			if (!open || !close) continue;

			let openCount = 0;
			let closeCount = 0;

			// Only scan text outside of normal string literals to reduce false positives.
			// Note: for python triple quotes we still count the triple tokens themselves.
			let inSingle = false;
			let inDouble = false;
			let inBacktick = false;
			let inLineComment = false;
			let inBlockComment = false;

			const isPython = ctx?.profile?.id === 'python';
			const isJsLike = ctx?.profile?.id === 'jsLike';
			const isTriple = open.length === 3 && (open === "'''" || open === '"""');

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

				// For python triple quotes tokens: count them even if we consider it a string.
				if (isPython && isTriple && !inLineComment && !inBlockComment) {
					if (startsWithAt(text, i, open)) {
						openCount++;
						i += open.length - 1;
						continue;
					}
					if (startsWithAt(text, i, close)) {
						closeCount++;
						i += close.length - 1;
						continue;
					}
				}

				if (!isPython) {
					if (!inDouble && !inBacktick && ch === "'") {
						inSingle = !inSingle;
						continue;
					}
					if (!inSingle && !inBacktick && ch === '"') {
						inDouble = !inDouble;
						continue;
					}
					if (!inSingle && !inDouble && ch === '`') {
						inBacktick = !inBacktick;
						continue;
					}
				}

				if (inSingle || inDouble || inBacktick) continue;

				if (startsWithAt(text, i, open)) {
					openCount++;
					i += open.length - 1;
					continue;
				}
				if (startsWithAt(text, i, close)) {
					closeCount++;
					i += close.length - 1;
					continue;
				}
			}

			if (openCount !== closeCount) {
				issues.push({
					code: 'block_comment_unbalanced',
					message: `${ctx.contentKind}Content ${pair.label} 不平衡 (open=${openCount}, close=${closeCount})`,
				});
			}
		}
		return issues;
	}
}
