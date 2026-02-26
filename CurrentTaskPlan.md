# CurrentTaskPlan: 流式API空闲超时重试机制(短线任务计划)

## 需求基线
- 需求文档: `requirements/流式API空闲超时重试机制.md`.
- 固定口径: 单字段 `streamIdleTimeoutSec`,单位秒,默认 `180`,无多层优先级.
- 行为边界: 仅有效业务数据刷新计时器,心跳/空事件不刷新,超时整次重发,用户主动中断不重试,旧连接迟到消息必须丢弃.
- 适用范围: Anthropic/Gemini/Chat/Responses 四类流式API保持一致.

## 迭代1(P0): 配置贯通与输入兜底

### 任务包1: 配置模型与持久化贯通
- 目标: 让 `streamIdleTimeoutSec` 在主配置与profiles可读写,并在运行时可稳定获取.
- 涉及文件:
  - `source/utils/config/apiConfig.ts`
  - `source/utils/config/configManager.ts`
  - `source/ui/pages/ConfigScreen.tsx`
- 关键改动:
  - 在 `ApiConfig` 增加 `streamIdleTimeoutSec?: number` 定义.
  - 在配置加载链路统一实现字段归一化: 缺失=>180,非数字/非整数/空字符串=>180.
  - 在 `ConfigScreen` 增加字段展示与编辑入口(放在 `API和模型设置`),并接入保存到主配置与当前profile(`snowcfg.streamIdleTimeoutSec`).
  - 数字输入遵循现有整数输入模型,禁止小数与非数字字符,回车时做最终校验并回退默认值.
- 完成定义(DoD):
  - UI可编辑并显示该字段.
  - 保存后主配置与 `C:/Users/Administrator/.snow/profiles` 对应profile都能看到 `snowcfg.streamIdleTimeoutSec`.
  - 缺失/非法值进入运行时时均回退到180,不阻断请求.
- 风险点:
  - `ConfigScreen` 字段列表与输入状态较多,遗漏任一分支会导致字段不可编辑或保存不完整.
  - profile写入与主配置写入是两条路径,需防止一处成功一处遗漏.

## 迭代2(P0): 四类流式API一致行为落地

### 任务包2: 空闲超时判定与重试语义统一
- 目标: 四类流式API统一使用可配置超时,并严格执行判定口径与边界行为.
- 涉及文件:
  - `source/utils/core/streamGuards.ts`
  - `source/utils/core/retryUtils.ts`
  - `source/api/anthropic.ts`
  - `source/api/chat.ts`
  - `source/api/gemini.ts`
  - `source/api/responses.ts`
- 关键改动:
  - 在四个流式适配器读取当前配置(profile优先沿用现有逻辑),将 `streamIdleTimeoutSec` 转换为 `idleTimeoutMs` 传入 `createIdleTimeoutGuard`.
  - 将 `guard.touch()` 触发点收敛为"仅收到有效业务数据"时触发,心跳/空事件不触发.
  - 保持现有重试链路,超时抛出可重试错误后走整次重发,不实现断点续传.
  - 用户主动中断路径显式 `abandon` 并直接退出,不进入重试.
  - 断开后旧连接迟到消息继续通过现有abandon语义丢弃,避免与新连接数据混流.
- 完成定义(DoD):
  - 四类流式API均使用同一字段控制空闲超时.
  - 心跳/空事件不会刷新计时器,有效业务数据会刷新.
  - 超时触发后进入既有重试机制且为整次重发.
  - 用户主动中断不重试,旧连接迟到消息不输出.
- 风险点:
  - "有效业务数据"在不同API事件结构下判定条件不一致,容易出现某一路误判.
  - 若超时错误文案/标记变形,可能影响 `retryUtils` 的可重试识别.

## MVP发布路径(最小可发布顺序)
1. 先完成迭代1任务包1,确保配置字段可编辑,可持久化,可回退默认值.
2. 接着完成迭代2任务包2,仅改四类流式API空闲超时接线与触发口径,不引入新重试策略.
3. 运行 `npm run build` 验证通过后发布.
4. 发布后由用户重启TUI并做场景回归: 正常流式,空闲超时重试,用户主动中断,旧连接迟到消息丢弃.
