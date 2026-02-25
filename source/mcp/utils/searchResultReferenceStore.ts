export interface SearchResultReference {
	id: string;
	filePath: string;
	line: number;
	column: number;
	content: string;
	pattern: string;
	fileGlob?: string;
	isRegex: boolean;
	createdAt: number;
}

const MAX_STORE_SIZE = 2000;
const storeById = new Map<string, SearchResultReference>();

function trimStoreIfNeeded() {
	if (storeById.size <= MAX_STORE_SIZE) return;

	const oldest = Array.from(storeById.values())
		.sort((a, b) => a.createdAt - b.createdAt)
		.slice(0, storeById.size - MAX_STORE_SIZE);

	for (const item of oldest) {
		storeById.delete(item.id);
	}
}

export function createSearchResultReference(input: {
	filePath: string;
	line: number;
	column: number;
	content: string;
	pattern: string;
	fileGlob?: string;
	isRegex: boolean;
}): SearchResultReference {
	const id = `sr_${Date.now().toString(36)}_${Math.random()
		.toString(36)
		.slice(2, 8)}`;
	const result: SearchResultReference = {
		id,
		createdAt: Date.now(),
		...input,
	};
	storeById.set(id, result);
	trimStoreIfNeeded();
	return result;
}

export function getSearchResultReference(params: {
	searchResultId?: string;
}): SearchResultReference | undefined {
	if (params.searchResultId) {
		return storeById.get(params.searchResultId);
	}
	return undefined;
}
