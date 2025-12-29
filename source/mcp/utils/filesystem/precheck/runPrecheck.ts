import {resolveLanguageProfile} from './languageProfiles.js';
import type {PrecheckIssue, PrecheckRule} from './types.js';
import {BracketsRule} from './rules/brackets.rule.js';
import {BlockCommentsRule} from './rules/block-comments.rule.js';
import {QuotesRule} from './rules/quotes.rule.js';
import {IndentationEdgeRule} from './rules/indentation-edge.rule.js';

export function runPrecheck(
	text: string,
	ctx: {filePath: string; contentKind: 'search' | 'replace'},
): PrecheckIssue[] {
	const profile = resolveLanguageProfile(ctx.filePath);
	const fullCtx = {...ctx, profile};
	const rules: PrecheckRule[] = [
		new BracketsRule(),
		new BlockCommentsRule(),
		new QuotesRule(),
		new IndentationEdgeRule(),
	];
	return rules.flatMap(r => (r.applies(fullCtx) ? r.check(text, fullCtx) : []));
}
