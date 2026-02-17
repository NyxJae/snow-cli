## F:/Projects/openclaw 项目连接 Telegram 的架构总结

### 核心技术栈

项目使用 **[grammY](https://grammy.dev/)** 库(一个 TypeScript Telegram Bot 框架)来连接 Telegram, 核心代码位于 `src/telegram/` 目录.

### 连接流程 (自上而下)

#### 1. 入口 — `monitorTelegramProvider()` (`src/telegram/monitor.ts`)

这是 Telegram 连接的总入口, 主要做了:

1. **加载配置 & 解析账户**: 通过 `resolveTelegramAccount()` 从配置中读取 bot token, 支持多账户(`accounts.<accountId>.botToken` 或环境变量 `TELEGRAM_BOT_TOKEN`).
2. **代理支持**: 如果配置了 `proxy`, 通过 `makeProxyFetch()` 创建代理 fetch 实现.
3. **恢复 update offset**: 从本地存储读取上次处理到的 `updateId`, 避免重启后重复处理消息.
4. **创建 Bot 实例**: 调用 `createTelegramBot()`.
5. **选择连接模式**: 支持两种模式 —
   - **Webhook 模式** (`opts.useWebhook`): 调用 `startTelegramWebhook()` 启动 HTTP 服务器接收 Telegram 推送.
   - **Long Polling 模式** (默认): 使用 `@grammyjs/runner` 的 `run()` 进行并发轮询.

#### 2. Bot 创建 — `createTelegramBot()` (`src/telegram/bot.ts`)

这是核心组装逻辑:

```
new Bot(token, { client: { fetch, timeoutSeconds } })
```

- 使用 grammY 的 `Bot` 构造函数, 传入 token 和可选的 API client 配置(自定义 fetch / 超时).
- 安装中间件:
  - `apiThrottler()` — 限流, 防止触发 Telegram API rate limit.
  - `sequentialize()` — 按聊天/用户顺序化处理, 避免并发冲突.
  - `bot.catch()` — 全局错误兜底.
- 注册消息处理:
  - `registerTelegramNativeCommands()` — 注册 `/command` 风格的原生命令.
  - `registerTelegramHandlers()` — 注册文本/媒体/回调查询等消息处理器.

#### 3. 两种连接模式

| 模式 | 实现 | 说明 |
|---|---|---|
| **Long Polling** | `@grammyjs/runner` 的 `run(bot, options)` | 默认模式, 持续调用 `getUpdates` API, 带指数退避重试, 自动处理 409 冲突和网络错误 |
| **Webhook** | `webhookCallback(bot, "http")` + Node HTTP 服务器 (`src/telegram/webhook.ts`) | 启动本地 HTTP 服务, 通过 `bot.api.setWebhook()` 告知 Telegram 推送地址 |

#### 4. 消息处理流水线

```
收到 Update → registerTelegramHandlers (bot-handlers.ts)
            → createTelegramMessageProcessor (bot-message.ts)
            → buildTelegramMessageContext (bot-message-context.ts)  // 构建上下文: 权限/群组/话题
            → dispatchTelegramMessage (bot-message-dispatch.ts)     // 路由到 Agent 处理
            → deliverTelegramReply (bot/delivery.ts)                // 格式化 & 发送回复
```

#### 5. 关键配置项

- **Token**: `channels.telegram.accounts.<id>.botToken` / `TELEGRAM_BOT_TOKEN`
- **代理**: `channels.telegram.proxy` (支持 SOCKS5/HTTP)
- **网络**: `channels.telegram.network` (自定义 fetch, 如代理/DNS)
- **Webhook**: `channels.telegram.webhookHost`, `webhookPath`, `webhookPort`, `webhookSecret`
- **访问控制**: `allowFrom` / `groupAllowFrom` (白名单用户/群组)
- **流式回复**: `streamMode` (`off` / `partial` / `block`)

#### 6. 关键模块一览

| 文件 | 职责 |
|---|---|
| `monitor.ts` | 连接入口, 启动 polling/webhook |
| `bot.ts` | 创建 & 组装 Bot 实例 |
| `accounts.ts` | 解析多 Telegram 账户配置 |
| `bot-handlers.ts` | 注册 update 处理器(文本/媒体/回调) |
| `bot-message.ts` | 消息处理器工厂 |
| `bot-message-context.ts` | 构建消息上下文(权限/DM/群组) |
| `bot-message-dispatch.ts` | 将消息派发到 Agent |
| `bot/delivery.ts` | 格式化并发送回复(Markdown→HTML, 分块) |
| `webhook.ts` | Webhook HTTP 服务器 |
| `proxy.ts` | SOCKS5/HTTP 代理支持 |
| `network-errors.ts` | 可恢复网络错误判定 |
| `send.ts` | 主动发送/react 消息 API |
| `fetch.ts` | 自定义 fetch 解析(代理/网络配置) |