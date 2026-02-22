import net from 'node:net';

/**
 * 校验端口范围.
 */
export function isValidPort(port: number): boolean {
	return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * 检查端口是否可用.
 */
export function isPortAvailable(port: number): Promise<boolean> {
	return new Promise(resolve => {
		const tester = net.createServer();

		tester.once('error', () => {
			resolve(false);
		});

		tester.once('listening', () => {
			tester.close(() => resolve(true));
		});

		tester.listen(port, '127.0.0.1');
	});
}
