/**
 * 领域级稳定错误码,供 server 与 web 共享使用.
 */
export const DOMAIN_ERROR_CODES = [
	'invalid_password',
	'unauthorized',
	'invalid_work_dir',
	'port_in_use',
	'start_failed',
	'stop_failed',
	'invalid_json',
	'method_not_allowed',
	'not_found',
	'not_implemented',
	'git_not_installed',
	'repo_not_initialized',
	'git_command_failed',
	'invalid_file_path',
	'internal_error',
] as const;

/**
 * 全量稳定错误码联合类型.
 */
export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];
