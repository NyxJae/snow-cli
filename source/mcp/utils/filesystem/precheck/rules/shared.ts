export type ScanMode = 'code' | 'lineComment' | 'blockComment' | 'string';

export function isEscaped(text: string, index: number): boolean {
	let backslashes = 0;
	for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) backslashes++;
	return backslashes % 2 === 1;
}

export function startsWithAt(text: string, index: number, token: string): boolean {
	return token.length > 0 && text.slice(index, index + token.length) === token;
}
