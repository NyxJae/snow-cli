# CurrentTaskPlan: ace-text_search P0 一页执行版

## 1. 目标与硬约束

- 需求来源: `requirements/文本搜索工具优化.md` 第 2 章.
- 固定优先级: `git grep -> rg/grep(优先 rg) -> JS fallback`.
- JS fallback 触发条件: 仅前两层 `报错` 或 `不可用`,超时不触发.
- 双超时: `15s` 前台占位返回并转后台,`5min` 作为 `rg/grep` 后台上限.
- 后台结果插回: 通过 `pendingMessages` 同链路,在最新工具执行完毕后作为 `user` 消息插回.
- 参数口径: `maxResults` 默认 `100`,边界 `1~500`,非法值回退 `100`.

## 2. 模块职责边界

- `source/mcp/aceCodeSearch.ts`: 策略执行与结果分类,负责优先级和 fallback 判定,不处理会话插回.
- `source/utils/execution/mcpToolsManager.ts`: 15s 前台返回 + 后台续跑编排,负责 5min 超时终止与入队准备.
- `source/hooks/conversation/useChatLogic.ts`: pending 入队入口,确保携带 `sessionId` 与幂等键.
- `source/hooks/conversation/useConversation.ts`: 工具轮次结束后消费 pending,按 session 保序并去重插回.

## 3. 最小数据契约

- `TextSearchAsyncTask`: `taskId`,`sessionId`,`toolCallId`,`requestHash`,`status`,`startedAt`,`backgroundDeadlineAt`,`finalSource`,`resultCount`,`errorType`.
- `PendingMessageEnvelope`: `text`,`sessionId`,`dedupeKey`,`messageKind`,`createdAt`.
- 终态口径: `success`,`empty`,`unavailable`,`error`,`timeout`.

## 4. 关键时序

1. 进入 `text_search`,先归一 `maxResults`.
2. 按固定优先级执行.
3. 15s 内完成则同步返回.
4. 超过 15s 返回占位,任务转后台继续 `rg/grep`.
5. 后台成功则封装 `tool_async_result` 入 `pendingMessages`.
6. 后台 5min 超时或异常则封装失败提示入 `pendingMessages`,不进入 JS fallback.
7. 在最新工具轮次结束后消费 pending,按 `sessionId + createdAt` 保序,按 `dedupeKey` 去重.

## 5. 阶段执行与验收

- 阶段 A,契约落盘: 明确字段与终态口径,验收 `超时不触发 JS`.
- 阶段 B,策略与参数: 完成 `maxResults` 归一与结果分类,验收边界和非法回退.
- 阶段 C,双超时编排: 打通 15s 占位与 5min 终止,验收两类超时行为.
- 阶段 D,插回链路: 打通 pending 入队与消费去重,验收同会话不乱序不重复.
- 阶段 E,集成收口: 手工走核心场景并执行 `npm run build`.

## 6. 风险收敛与回滚

- 风险 1,重复插回: `dedupeKey` + 每 task 仅一次终态写入.
- 风险 2,跨会话串写: 全链路强制 `sessionId` 校验.
- 风险 3,顺序错乱: 消费层同会话 FIFO.
- 风险 4,后台任务泄漏: 5min 硬超时 + 会话结束清理.
- 回滚 1,开关回滚: `textSearchAsyncEnabled` 一键回同步.
- 回滚 2,分层回滚: 先回滚后台插回,保留参数归一与策略判定.

## 7. MVP 验收清单

- [ ] 优先级保持 `git -> rg/grep -> JS`.
- [ ] JS fallback 仅报错/不可用触发,超时不触发.
- [ ] 15s 返回占位并转后台.
- [ ] 5min 超时失败并入队插回失败提示.
- [ ] 后台结果经 `pendingMessages` 插回 `user` 消息.
- [ ] 满足 session 隔离,幂等去重,顺序保证.
- [ ] `maxResults` 默认 100,边界 1~500,非法回退 100.
- [ ] `npm run build` 通过.
