import type {BracketToken, LanguageProfile, PairToken, QuoteToken} from './types.js';

const BRACKETS: BracketToken[] = [
	{kind: 'curly', open: '{', close: '}', label: '大括号 {}'},
	{kind: 'round', open: '(', close: ')', label: '小括号 ()'},
	{kind: 'square', open: '[', close: ']', label: '中括号 []'},
];

const JS_BLOCK_COMMENTS: PairToken[] = [{open: '/*', close: '*/', label: '多行注释 /* */'}];

const JS_QUOTES: QuoteToken[] = [
	{kind: 'single', open: "'", close: "'", label: '单引号'},
	{kind: 'double', open: '"', close: '"', label: '双引号'},
	{kind: 'backtick', open: '`', close: '`', label: '反引号'},
];

const PY_BLOCK_COMMENTS: PairToken[] = [
	{open: "'''", close: "'''", label: "三引号块 '''"},
	{open: '"""', close: '"""', label: '三引号块 """'},
];

const PY_QUOTES: QuoteToken[] = [
	{kind: 'single', open: "'", close: "'", label: '单引号'},
	{kind: 'double', open: '"', close: '"', label: '双引号'},
	{kind: 'triple-single', open: "'''", close: "'''", label: "三引号 '''"},
	{kind: 'triple-double', open: '"""', close: '"""', label: '三引号 """'},
];

export function resolveLanguageProfile(filePath: string): LanguageProfile {
	const lower = filePath.toLowerCase();
	if (lower.endsWith('.py')) {
		return {
			id: 'python',
			brackets: BRACKETS,
			blockComments: PY_BLOCK_COMMENTS,
			quotes: PY_QUOTES,
			indentationSensitive: true,
		};
	}
	if (lower.endsWith('.yml') || lower.endsWith('.yaml')) {
		return {
			id: 'yaml',
			brackets: BRACKETS,
			blockComments: [],
			quotes: [],
			indentationSensitive: true,
		};
	}
	if (
		lower.endsWith('.js') ||
		lower.endsWith('.jsx') ||
		lower.endsWith('.ts') ||
		lower.endsWith('.tsx') ||
		lower.endsWith('.mjs') ||
		lower.endsWith('.cjs')
	) {
		return {
			id: 'jsLike',
			brackets: BRACKETS,
			blockComments: JS_BLOCK_COMMENTS,
			quotes: JS_QUOTES,
			indentationSensitive: false,
		};
	}
	return {
		id: 'generic',
		brackets: BRACKETS,
		blockComments: JS_BLOCK_COMMENTS,
		quotes: JS_QUOTES,
		indentationSensitive: false,
	};
}
