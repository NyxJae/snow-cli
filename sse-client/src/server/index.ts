import {createServer} from 'node:http';
import {fileURLToPath, parse as parseUrl} from 'node:url';
import path from 'node:path';
import {HttpRouter} from './http/router.js';
import {sendFailure} from './http/response.js';
import {serveStatic} from './http/static.js';
import {handleHealth} from './routes/health.js';
import {
	handleAuthLogin,
	handleAuthLogout,
	handleAuthMe,
} from './routes/auth.js';
import {
	handleListProfileOptions,
	handleListServers,
	handleListWorkDirPresets,
	handleSaveWorkDirPreset,
	handleStartServer,
	handleStopAllServers,
	handleStopServer,
} from './routes/servers.js';
import {
	handleGitCommit,
	handleGitDiff,
	handleGitInit,
	handleGitStage,
	handleGitStatus,
	handleGitUnstage,
} from './routes/git.js';
import {authService} from './services/authService.js';
import {getSessionToken} from './utils/cookies.js';

const DEFAULT_PORT = 3360;

/**
 * 注册控制面 API 路由.
 */
function registerRoutes(router: HttpRouter): void {
	router.register('GET', '/api/health', handleHealth);
	router.register('POST', '/api/auth/login', handleAuthLogin);
	router.register('POST', '/api/auth/logout', handleAuthLogout);
	router.register('GET', '/api/auth/me', handleAuthMe);
	router.register('GET', '/api/servers', handleListServers);
	router.register(
		'GET',
		'/api/servers/workdir-presets',
		handleListWorkDirPresets,
	);
	router.register(
		'POST',
		'/api/servers/workdir-presets',
		handleSaveWorkDirPreset,
	);
	router.register(
		'GET',
		'/api/servers/profile-options',
		handleListProfileOptions,
	);
	router.register('POST', '/api/servers/start', handleStartServer);
	router.register('POST', '/api/servers/stop', handleStopServer);
	router.register('POST', '/api/servers/stop-all', handleStopAllServers);
	router.register('POST', '/api/git/init', handleGitInit);
	router.register('POST', '/api/git/status', handleGitStatus);
	router.register('POST', '/api/git/stage', handleGitStage);
	router.register('POST', '/api/git/unstage', handleGitUnstage);
	router.register('POST', '/api/git/diff', handleGitDiff);
	router.register('POST', '/api/git/commit', handleGitCommit);
}

/**
 * 计算静态资源目录,避免依赖 process.cwd().
 */
function resolveStaticRoot(): string {
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	return path.resolve(moduleDir, '../../src/web');
}

/**
 * 启动本地控制面 HTTP 服务.
 */
function startServer(port: number): void {
	const router = new HttpRouter();
	registerRoutes(router);
	const staticRoot = resolveStaticRoot();

	const server = createServer(async (req, res) => {
		try {
			if (req.method === 'OPTIONS') {
				res.writeHead(204);
				res.end();
				return;
			}

			const pathname = parseUrl(req.url ?? '', true).pathname ?? '/';
			const isProtectedApiPath =
				pathname.startsWith('/api/servers') || pathname.startsWith('/api/git');
			if (isProtectedApiPath) {
				const token = getSessionToken(req);
				if (!authService.isLoggedIn(token)) {
					sendFailure(res, 'unauthorized', '未登录,请先登录');
					return;
				}
			}

			const routeResult = await router.handle(req, res);
			if (routeResult.handled) {
				return;
			}
			if (routeResult.methodNotAllowed) {
				sendFailure(
					res,
					'method_not_allowed',
					'请求方法不被允许',
					undefined,
					405,
				);
				return;
			}

			const staticServed = await serveStatic(res, staticRoot, pathname);
			if (staticServed) {
				return;
			}

			sendFailure(res, 'not_found', '未找到资源', undefined, 404);
		} catch (error) {
			const errorDetails =
				error instanceof Error
					? {
							name: error.name,
							message: error.message,
					  }
					: undefined;
			sendFailure(
				res,
				'internal_error',
				error instanceof Error ? error.message : '未知错误',
				errorDetails,
				500,
			);
		}
	});

	server.listen(port, () => {
		process.stdout.write(
			`[sse-client] control-plane server running on http://localhost:${port}\n`,
		);
	});
}

startServer(Number(process.env['SSE_CLIENT_PORT'] ?? DEFAULT_PORT));
