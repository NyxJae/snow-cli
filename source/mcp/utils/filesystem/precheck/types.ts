export type PrecheckIssue = {
	code:
		| 'brackets_unbalanced'
		| 'block_comment_unbalanced'
		| 'quote_unbalanced'
		| 'indentation_edge_inconsistent';
	message: string;
};

export type PrecheckContext = {
	filePath: string;
	contentKind: 'search' | 'replace';
	profile: LanguageProfile;
};

export type PairToken = {open: string; close: string; label: string};

export type BracketKind = 'curly' | 'round' | 'square';

export type BracketToken = PairToken & {
	kind: BracketKind;
};

export type QuoteKind = 'single' | 'double' | 'backtick' | 'triple-single' | 'triple-double';

export type QuoteToken = PairToken & {
	kind: QuoteKind;
};

export type LanguageProfile = {
	id: 'jsLike' | 'python' | 'yaml' | 'generic';
	brackets: BracketToken[];
	blockComments: PairToken[];
	quotes: QuoteToken[];
	indentationSensitive: boolean;
};

export interface PrecheckRule {
	id: string;
	applies(ctx: PrecheckContext): boolean;
	check(text: string, ctx: PrecheckContext): PrecheckIssue[];
}
