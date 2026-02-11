/**
 * 日期时间格式化工具
 */

/**
 * 格式化日期时间为本地时间字符串
 * @param date - 日期对象,默认当前时间
 * @param format - 格式模板,默认 'YYYY-MM-DD HH:mm:ss'
 * @returns 格式化后的时间字符串
 */
export function formatLocalDateTime(
	date: Date = new Date(),
	format: string = 'YYYY-MM-DD HH:mm:ss',
): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	const hours = String(date.getHours()).padStart(2, '0');
	const minutes = String(date.getMinutes()).padStart(2, '0');
	const seconds = String(date.getSeconds()).padStart(2, '0');

	return format
		.replace('YYYY', String(year))
		.replace('MM', month)
		.replace('DD', day)
		.replace('HH', hours)
		.replace('mm', minutes)
		.replace('ss', seconds);
}

/**
 * 获取时区偏移字符串
 * @param date - 日期对象,默认当前时间
 * @returns 时区偏移字符串 (如: UTC+08:00)
 */
export function getTimezoneOffset(date: Date = new Date()): string {
	const timezoneOffset = -date.getTimezoneOffset();
	const offsetHours = Math.floor(Math.abs(timezoneOffset) / 60);
	const offsetMinutes = Math.abs(timezoneOffset) % 60;
	const offsetSign = timezoneOffset >= 0 ? '+' : '-';
	return `UTC${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(
		offsetMinutes,
	).padStart(2, '0')}`;
}
