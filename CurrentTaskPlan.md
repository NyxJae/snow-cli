# CurrentTaskPlan: 流式 API 空闲超时重试 + 断开后延迟消息丢弃

## 0. 用户需求与目标

需求来源: `requirements/流式API空闲超时重试机制.md`.

要解决的问题:
- 流式连接未断开,但长时间(例如几分钟)没有任何新 chunk,UI 持续显示"正在生成"的假死状态.

目标:
1. 空闲超时检测: 流式读取过程中,监控最后一次收到任何数据的时间,若 3 分钟无数据则判定超时.
2. 超时后触发重试: 需走 `withRetryGenerator` 的重试逻辑.
3. 断开后消息丢弃: 任何断开(空闲超时/网络/用户中断/服务端异常)后,若旧连接仍延迟到达 chunk,必须丢弃,不得 yield,防止新旧连接数据混合.

边界:
- 超时固定 3 分钟(180000ms),不可配置.
- 不修改非流式 API.
- 不改变现有的连接超时逻辑(仅新增空闲超时).

## 1. 现状盘点(与需求强相关)

涉及文件:
- 重试核心: `source/utils/core/retryUtils.ts`
  - `withRetryGenerator` 负责流式重试,使用 `hasYielded` 判断是否允许重试.
  - `isRetriableError` 通过 error.message 关键字判断是否可重试.
- 流式 API 适配器(均存在 reader.read() + SSE/流解析循环):
  - `source/api/anthropic.ts`
  - `source/api/gemini.ts`
  - `source/api/chat.ts`
  - `source/api/responses.ts`

目前已覆盖的"断开检测":
- 在 parseSSEStream 中,当 `reader.read()` 返回 done 时,若 `buffer.trim()` 非空则抛出 `stream terminated unexpectedly with incomplete data`(被标记为 [RETRIABLE]),以触发 `withRetryGenerator` 重试.

## 2. 总体架构方案(建议)

### 2.1 新增通用 stream wrapper(推荐落点)

建议新增文件:
- `source/utils/core/streamGuards.ts` (或 `source/utils/core/streamUtils.ts`),提供可复用的通用机制,供所有流式 API 适配器调用.

建议导出能力:
1. 常量:
   - `export const STREAM_IDLE_TIMEOUT_MS = 180000;`

2. 错误类型:
   - `export class StreamIdleTimeoutError extends Error { name = 'StreamIdleTimeoutError'; }`
   - 错误 message 必须包含可被 `isRetriableError` 识别的关键字(例如包含 "timeout" 或显式新增判定).

3. 包装 AsyncGenerator 的 guard:
   - 输入: `source: AsyncGenerator<T>`, `abortSignal?`, `onAbandon?`
   - 输出: `AsyncGenerator<T>`
   - 行为:
     - idle timer: 3min 无任何数据(即底层 generator 没有 next)则触发 abandon.
     - abandon 后:
       - 设置 `abandoned=true`.
       - 执行 `reader.cancel()`(由调用方提供 cancel 回调).
       - 抛出 `StreamIdleTimeoutError` 以触发 `withRetryGenerator`.
     - yield 前检查 abandoned,若为 true 则丢弃(continue)或直接 return(取决于实现形态),保证延迟消息不外泄.

实现形态建议(更易复用):
- 以 `AbortController` + `Promise.race(reader.read(), idleTimeoutPromise)` 方式实现,并在超时路径执行 cancel.

### 2.2 在 retryUtils.ts 中对 idle timeout 做可重试判定

改动建议:
- `isRetriableError` 增加对 `StreamIdleTimeoutError` 的识别,或者识别 message 中的稳定关键字(例如 `stream idle timeout`).
- `withRetryGenerator` 的 `isStreamInterruption` 判定需把 idle timeout 纳入,以满足"即使 hasYielded=true,也应重试"的需求.

备注:
- 当前逻辑: `hasYielded && !isStreamInterruption` 时不重试.
- 目标: idle timeout 归类为 stream interruption.

### 2.3 API 适配器接入方式

每个流式 API 适配器的接入点:
- 现状均是 `createStreamingXxx` 内部 `yield* withRetryGenerator(() => parseSSEStream(reader), {abortSignal,onRetry})` 这一结构.

推荐接入方式:
- 把 parseSSEStream 的读取循环,统一改成调用 core wrapper,或在 parseSSEStream 内部用 wrapper 包住 `reader.read()`.
- 每个连接/每次重试必须创建独立的 abandoned 状态,禁止跨重试共享.

## 3. 分阶段实施步骤(可回滚)

1. 新增 core 层通用实现
   - 创建 `source/utils/core/streamGuards.ts`.
   - 提供 `STREAM_IDLE_TIMEOUT_MS` 与 `StreamIdleTimeoutError`.
   - 提供一个最小可用的 wrapper(先服务 SSE reader.read 循环).

2. 修改重试核心
   - `source/utils/core/retryUtils.ts`:
     - `isRetriableError` 支持 StreamIdleTimeoutError.
     - `withRetryGenerator` 的 stream interruption 判定包含 idle timeout.

3. 逐个接入 4 个流式 API 适配器
   - `source/api/chat.ts` parseSSEStream
   - `source/api/responses.ts` parseSSEStream
   - `source/api/anthropic.ts` parseSSEStream
   - `source/api/gemini.ts` SSE 读取循环

4. 回归检查与 build
   - 关注边缘情况: 超时后旧连接延迟 chunk 不得 yield.
   - `npm run build` 通过即可.

## 4. 验收标准

1. 在无数据超过 3 分钟的流式响应中,触发重试(可见 onRetry/日志变化).
2. 即使已产出过部分 chunk,仍可在 idle timeout 场景下重试.
3. 超时断开后,旧连接延迟到达的 chunk 不会被 yield(不会与新连接数据混合).
4. Anthropic/Gemini/Chat/Responses 4 条流式链路行为一致.

## 5. 风险与注意事项

- 竞态条件的核心是"断开后仍可能读取到旧数据",需要 abandoned 标记+yield 前检查+reader.cancel.
- 不能依赖 UI 或提示词让模型"别卡住";必须代码层保证.
- 需要确保 idle timer 不会泄漏(正常结束或 abort 时清理).
