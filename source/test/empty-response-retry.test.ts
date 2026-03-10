import test from 'ava';

import {createEmptyResponseError} from '../utils/core/emptyResponseDetector.js';

/**
 * 空回复错误必须携带可重试标记,供上层工作循环决定是否继续重试.
 */
test('createEmptyResponseError should mark error as retryable with EMPTY_RESPONSE code', t => {
	const err = createEmptyResponseError('');
	const e = err as any;
	t.is(e.code, 'EMPTY_RESPONSE');
	t.is(e.isRetryable, true);
	t.true(String(err.message).includes('Empty or insufficient response detected'));
});
