# CurrentTaskPlan - 正式 Web SSE 客户端(sse-client)

## 0. 需求基线(SSoT)

- 核心需求文档: `requirements/全平台网页版Snow SSE客户端需求.md`
- 协议参考:
  - Snow SSE 协议与端点: `docs/usage/zh/20.SSE服务模式.md`
  - 主代理协议: `requirements/SSE客户端适配主代理.md`

## 1. 项目目标与边界

### 1.1 本迭代目标(先跑起来,再逐步做全功能)

1. 在仓库根目录启用独立子项目目录 `sse-client/`(正式 Web 客户端).
2. 建立"网页 + 本地 Node 控制 API(同源)"的最小闭环:
   - Web 登录门禁(基于 `~/.snow/sse-config.json`,浏览器会话内免重复登录).
   - 服务端进程管理: `GET/POST /api/servers*`.
   - 静态资源托管(手机端可通过同一 URL 访问).
3. 建立浏览器端最小 UI 骨架:
   - 顶部: 服务端 Tab + [聊天|Git] 平级切换.
   - 左侧: 最近会话栏(先做空态/占位,后续接会话接口).
   - 右侧: ChatView/GitView 主区(按需求切换隐藏/保留区域).

### 1.2 必须遵守的边界(不可违背)

- 少依赖: 不引入 React/Vue/Angular,不引入大型状态管理与 UI 组件库.
- 可演进: 必须分层清晰(contracts/services/state/views/components),避免业务逻辑散落 DOM 事件回调.
- 多服务端隔离: 任意状态必须以 serverId(tab) 分片,禁止跨 Tab 共享 currentSessionId 等可变状态.
- 兼容性: 未知 SSE `event.type` 必须静默忽略,页面不可崩溃.
- 认证口径: 仅 Web 入口门禁,不改造 Snow SSE 各业务端点逐请求鉴权.

## 2. 推荐技术栈(落地口径)

- 语言: TypeScript.
- Web: 原生 DOM + ESM module,渲染函数/小组件(无框架).
- Server: Node.js `http`(不引入 Express/Koa).
- 构建:
  - 优先 `tsc -p sse-client/tsconfig.json` 产出 ESM JS(避免 bundler).
  - 如后续确需减少模块请求数,再评估用 esbuild 做无框架 bundling.

## 3. 目录结构(必须按边界放置代码)

- `sse-client/src/server/`: 本地控制面与静态托管.
- `sse-client/src/web/`: 浏览器 UI(views/components/state/services).
- `sse-client/src/shared/`: 双端共享 contracts/errors(禁止放运行时代码).

## 4. 渐进式里程碑计划(仅计划,不写代码)

### M0. 项目骨架与 contracts 固化

- [ ] 1. 固化 shared/contracts:
  - ApiResponse<T>
  - Auth: login,logout,me
  - Servers: list,start,stop,stop-all
- [ ] 2. 控制面 HTTP 最小内核:
  - JSON body 解析
  - 统一错误捕获与响应封装
  - 静态资源托管

验收:

- 控制面进程可启动并提供静态页面(先空白页/占位页即可).

### M1. 登录门禁 + 服务端管理闭环

- [ ] 1. 登录门禁:
  - 读取 `~/.snow/sse-config.json` 校验密码.
  - 登录成功后,浏览器会话内免重复登录(会话结束后需重新登录).
- [ ] 2. /api/auth\*:
  - `POST /api/auth/login`,`POST /api/auth/logout`,`GET /api/auth/me` 按需求实现.
  - `login` 密码错误口径: HTTP 200 + `success=false,errorCode=invalid_password,message=密码错误`.
  - `me` 未登录口径: HTTP 200 + `success=true,data:{isLoggedIn:false}`.
- [ ] 3. /api/servers\*:
  - list/start/stop/stop-all 全部按需求实现.
  - `start` 支持 `workDir,port,timeoutMs`,并返回统一响应结构.
  - 端口默认策略与端口扫描(最多 100 次)按需求实现.
  - 多个 `start` 并发请求按到达顺序串行处理,后一个请求等待前一个完成后再扫描端口.
  - 扫描耗尽或启动失败时返回明确错误码与用户可读提示.

验收:

- `POST /api/auth/login`,`POST /api/auth/logout`,`GET /api/auth/me` 可用并满足需求口径.
- 密码错误时 `login` 返回 HTTP 200 + `success=false,errorCode=invalid_password,message=密码错误`.
- 未登录时 `me` 返回 HTTP 200 + `success=true,data:{isLoggedIn:false}`.
- 浏览器会话结束后重新打开页面时,`me` 返回 `success=true,data:{isLoggedIn:false}`.
- 可在网页中按绝对路径启动 Snow SSE,并在 UI 中看到服务端 Tab.
- 端口按需求规则自动预填并跳过占用端口,最多扫描 100 次后给出手动输入提示.
- 并发触发多个 `start` 请求时,控制面按顺序串行处理并返回各自结果.
- `start` 失败时可看到清晰 `errorCode + message`(如 `port_in_use`,`invalid_work_dir`,`start_failed`).

### M2. 单服务端 ChatView 最小闭环

- [ ] 1. 为单个 serverTab 建立 EventSource 连接并消费核心事件(connected,message,error,complete).
- [ ] 2. 通过 Snow SSE `POST /message` 发送 chat.
- [ ] 3. 未知 SSE event.type 忽略.
- [ ] 4. 连接建立后自动拉取当前 Tab 会话列表,左侧最近 5 会话与会话管理弹窗使用同源数据.
- [ ] 5. 当会话收到新消息或状态变化时,同步更新 `lastUpdatedAt` 并触发最近会话重排.

验收:

- 单 Tab 下可发送文本并收到回复.
- 左侧最近会话会随消息更新自动重排,不会出现旧顺序残留.

### M3. 交互弹窗 + TODO + 日志

- [ ] 1. 审批弹窗(tool_confirmation_request).
- [ ] 2. 提问弹窗(user_question_request): 单选/多选/编辑某条选项/自定义输入/取消.
- [ ] 3. TODO 常驻区(聊天视图)可滚动.
- [ ] 4. 会话日志弹窗仅展示当前会话 SSE 事件流.

### M4. 多服务端 Tab + 会话管理

- [ ] 1. 多服务端并行连接与隔离状态.
- [ ] 2. 左侧最近 5 会话展示 + 会话管理弹窗(分页,继续会话,删除二次确认).
- [ ] 3. Tab 切换时会话数据严格按 serverId 隔离,禁止跨 Tab 串会话.

验收:

- 多个服务端同时在线时,任一 Tab 的会话刷新,删除,继续会话都不影响其他 Tab.
- 左侧最近 5 与会话管理弹窗数据一致,排序规则一致(`lastUpdatedAt` 降序).

### M5. Git 视图

- [ ] 1. Git 视图与聊天视图平级切换.
- [ ] 2. Git API: init,status,stage/unstage,diff,commit.
- [ ] 3. DiffViewer: 视口宽度 >= 1200px 双列,视口宽度 < 1200px 单列.
- [ ] 4. Git 初始化时序: 点击后显示 loading,成功后自动刷新状态,失败保留重试入口.

验收:

- 初始化 Git 后可立即看到最新状态.
- DiffViewer 在 >= 1200px 时双列展示,在 < 1200px 时单列展示.
- 初始化失败时有明确错误提示,且用户可直接重试.

## 5. 风险与回滚策略

- Windows/路径差异: workDir/path 必须统一用 Node path 处理,禁止拼接 shell.
- git 不可用: 必须给出明确错误提示,并允许用户继续使用聊天功能.
- 端口占用/孤儿进程: 控制面需要有 stop-all 与列表自愈策略.

回滚策略:

- 控制面与 Snow SSE 进程强隔离,停止控制面服务即可恢复现状.
- Git 能力按"只读 diff -> stage/unstage -> commit"渐进开放,每步可独立回滚.

## 6. 参考文件

- `requirements/全平台网页版Snow SSE客户端需求.md`
- `docs/usage/zh/20.SSE服务模式.md`
- `source/test/sse-client/`(仅作为联调参考)
