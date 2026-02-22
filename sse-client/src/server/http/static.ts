import path from 'node:path';
import fs from 'node:fs/promises';
import type {ServerResponse} from 'node:http';

const MIME_TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
};

/**
 * 托管静态文件,并通过相对路径判断阻止路径穿越.
 */
export async function serveStatic(
	res: ServerResponse,
	rootDir: string,
	requestPath: string,
): Promise<boolean> {
	const cleanPath = requestPath === '/' ? '/index.html' : requestPath;
	const targetPath = path.resolve(rootDir, `.${cleanPath}`);
	const normalizedRoot = path.resolve(rootDir);
	const relativePath = path.relative(normalizedRoot, targetPath);

	if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
		return false;
	}

	try {
		const file = await fs.readFile(targetPath);
		const ext = path.extname(targetPath);
		const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
		res.writeHead(200, {'Content-Type': contentType});
		res.end(file);
		return true;
	} catch {
		return false;
	}
}
