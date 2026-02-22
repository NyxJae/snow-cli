import type {IncomingMessage} from 'node:http';

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * 读取并解析 JSON 请求体,默认限制 1MB,避免无上限占用内存.
 */
export function readJsonBody<T>(
	req: IncomingMessage,
	maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<T> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const safeResolve = (value: T): void => {
			if (settled) {
				return;
			}
			settled = true;
			resolve(value);
		};
		const safeReject = (error: Error): void => {
			if (settled) {
				return;
			}
			settled = true;
			reject(error);
		};

		const contentType = req.headers['content-type'] ?? '';
		if (contentType && !contentType.includes('application/json')) {
			safeReject(new Error('invalid content-type, expected application/json'));
			return;
		}

		let body = '';

		req.on('data', chunk => {
			if (settled) {
				return;
			}
			body += chunk.toString();
			if (Buffer.byteLength(body, 'utf8') > maxBodyBytes) {
				req.destroy();
				safeReject(new Error('request body too large'));
			}
		});

		req.on('end', () => {
			if (settled) {
				return;
			}
			if (!body) {
				safeResolve({} as T);
				return;
			}

			try {
				safeResolve(JSON.parse(body) as T);
			} catch {
				safeReject(new Error('invalid json body'));
			}
		});

		req.on('error', error => {
			safeReject(
				error instanceof Error ? error : new Error('request stream error'),
			);
		});
	});
}
