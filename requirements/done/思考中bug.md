# TUI "思考中" 显示消失 Bug 分析与修复记录

## 问题描述

一个不太好复现的 bug:

- **现象**: ❆ 思考中...(xxx · 3s · ↓ 0 tokens) 这个表示正在运行的 TUI 显示消失了, 但还是在正常处理收到的消息
- **触发条件**: 一次调用返回了 `unexpected EOF` 或 `HTTP stream request failed: Post "https://free.duckcoding.com/v1/messages?beta=true": unexpected EOF` 错误, 然后走了重试发送
- **异常行为**:
  1. 重试后 "思考中..." 显示消失, 但新消息仍正常接收处理
  2. ESC 无法再中断处理
  3. 用户可以继续发送消息, 不进入队列, 直接发送
  4. 导致两个消息流在同一会话中同时收发

## 根因分析 (2026-02-26)

经过代码分析和三轮审查, 定位到以下根本原因:

### 1. AbortController 复用问题

**位置**: `source/hooks/conversation/useConversation.ts` - handleConversationWithTools 重试循环

**问题**: 重试循环中使用同一个 AbortController 实例

- 旧流的 abort 状态会影响新流
- 旧流的消息可能在新流开始后仍被处理
- 导致新流无法正常启动或接收数据

**技术细节**:

```typescript
// 问题代码模式
while (retryCount <= MAX_RETRIES) {
	try {
		// 使用同一个 controller 重试
		return await executeWithInternalRetry(options);
	} catch (error) {
		retryCount++;
		await delay(RETRY_DELAY);
	}
}
```

### 2. 重试期间 isStreaming 状态混乱

**位置**: `source/hooks/conversation/useConversation.ts` - 重试循环与流消费

**问题**: 重试时 isStreaming 可能被错误设置为 false

- LoadingIndicator 根据 isStreaming 决定是否显示 "思考中"
- 重试延迟的 5000ms 期间, 如果 isStreaming=false, 显示会消失
- 用户看不到加载状态, 以为可以发送新消息

**关键逻辑**:

```typescript
// LoadingIndicator.tsx 显示条件
if (
	!isStreaming &&
	!isSaving &&
	!isStopping &&
	!hasPendingToolConfirmation &&
	!hasPendingUserQuestion
) {
	return null; // 不显示
}
```

### 3. Controller 引用同步问题

**位置**: `source/hooks/conversation/useConversation.ts` 与 `source/ui/pages/ChatScreen.tsx`

**问题**: 重试时更换 controller, 但 ESC 读取的 controller 引用未同步

- useChatLogic 创建 controller 并传给 useConversation
- 重试时 useConversation 内部创建新 controller
- ChatScreen 的 ESC 处理仍引用旧 controller
- 导致 ESC 中断失效

**引用链路**:

```
useChatLogic (创建 controller)
  → useConversation (重试时创建新 controller)
  → streamingState.abortController (未同步)
  → ChatScreen ESC 处理 (读取旧引用)
```

### 4. Timer 清理不完整

**位置**: `source/hooks/conversation/useConversation.ts` - 流消费循环

**问题**: retryStatusClearTimer 可能未被清理

- 流消费循环中创建 setTimeout 清理 retryStatus
- 如果流被中断或异常退出, timer 未清理
- 可能导致内存泄漏或过期回调修改状态

## 修复方案

### 修复 1: 重试时创建新 AbortController 并同步引用

**文件**: `source/hooks/conversation/useConversation.ts`
**位置**: lines 157-185

**修改**:

```typescript
while (retryCount <= MAX_RETRIES) {
	try {
		if (controller.signal.aborted) {
			throw new Error('Request aborted by user');
		}

		// 重试时创建新 controller 并同步到 streamingState
		if (retryCount > 0) {
			const newController = new AbortController();
			options.controller = newController;
			// 同步更新到 streamingState, 确保 ESC 中断能命中当前有效 controller
			if (options.setAbortController) {
				options.setAbortController(newController);
			}
		}

		if (retryCount > 0 && setRetryStatus) {
			setRetryStatus(null);
		}

		// 重试时确保 isStreaming 状态为 true
		if (retryCount > 0 && options.setIsStreaming) {
			options.setIsStreaming(true);
		}

		return await executeWithInternalRetry(options);
	} catch (error) {
		// ... 错误处理
	}
}
```

**关键点**:

- 每次重试创建新的 AbortController
- 通过 setAbortController 回调同步到 streamingState
- 重试前显式设置 isStreaming=true

### 修复 2: 重试延迟期间保持 isStreaming=true

**文件**: `source/hooks/conversation/useConversation.ts`
**位置**: lines 208-228

**修改**:

```typescript
retryCount++;
if (setRetryStatus) {
	const currentLanguage = getCurrentLanguage();
	const t = translations[currentLanguage].chatScreen;
	setRetryStatus({
		isRetrying: true,
		attempt: retryCount,
		nextDelay: RETRY_DELAY,
		remainingSeconds: Math.floor(RETRY_DELAY / 1000),
		errorMessage: t.retryResending
			.replace('{current}', String(retryCount))
			.replace('{max}', String(MAX_RETRIES)),
	});
}

// 重试延迟期间保持 isStreaming=true, 避免 "思考中" 显示消失
if (options.setIsStreaming) {
	options.setIsStreaming(true);
}

await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
```

**关键点**:

- 在设置 retryStatus 后立即设置 isStreaming=true
- 确保 5000ms 延迟期间 "思考中" 显示不消失

### 修复 3: 优化重试状态清理时机并添加 Timer 管理

**文件**: `source/hooks/conversation/useConversation.ts`
**位置**: lines 401-402 (声明), lines 555-580 (使用)

**修改**:

```typescript
// 在函数开始处声明 timer 引用
let retryStatusClearTimer: NodeJS.Timeout | null = null;

// 在流消费循环中
for await (const chunk of streamGenerator) {
	if (controller.signal.aborted) {
		// 中断时清理 timer, 避免过期回调
		if (retryStatusClearTimer) {
			clearTimeout(retryStatusClearTimer);
			retryStatusClearTimer = null;
		}
		break;
	}

	// 首次接收数据后清除重试状态
	// 延迟 1000ms 确保用户能看到重试提示
	chunkCount++;
	if (setRetryStatus && chunkCount === 1) {
		retryStatusClearTimer = setTimeout(() => {
			setRetryStatus(null);
			retryStatusClearTimer = null;
		}, 1000);
	}
	// ... 其他处理
}
```

**关键点**:

- 延迟时间从 500ms 增加到 1000ms
- 添加 timer 引用管理
- 在中断时清理 timer

### 修复 4: 在 finally 块增加 timer 兜底清理

**文件**: `source/hooks/conversation/useConversation.ts`
**位置**: lines 2443-2457

**修改**:

```typescript
} finally {
  // Cleanup timer to prevent stale callbacks
  if (retryStatusClearTimer) {
    clearTimeout(retryStatusClearTimer);
    retryStatusClearTimer = null;
  }

  // CRITICAL: Ensure UI state is always cleaned up
  if (options.setIsStreaming) {
    options.setIsStreaming(false);
  }

  if (options.setIsStopping) {
    options.setIsStopping(false);
  }
  // ... 其他清理逻辑
}
```

**关键点**:

- finally 块作为兜底清理
- 确保任何退出路径都能清理 timer
- 防止内存泄漏

### 修复 5: 添加 setAbortController 类型定义

**文件**: `source/hooks/conversation/useConversation.ts`
**位置**: lines 128-133

**修改**:

```typescript
/**
 * Sync AbortController to streamingState
 * Used during retry to update controller reference, ensuring ESC interrupt can target the current active controller
 * @param controller New AbortController instance
 */
setAbortController?: (controller: AbortController) => void;
```

**关键点**:

- 补充完整的 JSDoc 文档注释
- 明确说明用途和参数

### 修复 6: 移除 ESC 处理中的重复清理

**文件**: `source/ui/pages/ChatScreen.tsx`
**位置**: lines 1170-1190

**修改**: 移除重复的 `streamingState.setRetryStatus(null)` 调用

## 技术决策

### 决策 1: 重试时创建新 AbortController

**理由**:

- AbortController 的 abort 状态无法重置
- 复用已 abort 的 controller 会导致新流无法正常工作
- 创建新 controller 是唯一可靠的解决方案

### 决策 2: 通过回调同步 controller 引用

**理由**:

- 保持关注点分离, useConversation 不直接依赖 streamingState 实现
- 通过回调注入依赖, 提高可测试性
- 符合 React Hooks 的设计模式

### 决策 3: 延迟清理时间增加到 1000ms

**理由**:

- 500ms 对用户来说太短, 可能看不到重试提示
- 1000ms 提供足够的视觉反馈时间
- 不会显著影响用户体验

## 关键代码位置

### 重试逻辑

- `source/hooks/conversation/useConversation.ts`: handleConversationWithTools 函数
- 重试循环: lines 157-228
- 最大重试次数: 10 次
- 重试延迟: 5000ms

### 流消费

- `source/hooks/conversation/useConversation.ts`: executeWithInternalRetry 函数
- 流消费循环: lines 555-580
- Timer 管理: retryStatusClearTimer

### 状态管理

- `source/hooks/conversation/useStreamingState.ts`: StreamStatus 状态机
- 三态: idle / streaming / stopping
- `source/ui/components/chat/LoadingIndicator.tsx`: "思考中" 显示逻辑

### ESC 中断

- `source/ui/pages/ChatScreen.tsx`: ESC 键处理
- `source/hooks/conversation/useChatLogic.ts`: Controller 创建

## 验证方法

### 构建验证

```bash
npm run build
```

结果: ✓ Bundle created successfully

### 手动测试场景

1. **测试重试功能**

   - 模拟网络错误触发重试
   - 验证 "思考中" 显示不消失
   - 验证重试提示正确显示

2. **测试 ESC 中断**

   - 在重试延迟期间按 ESC
   - 验证立即中断处理
   - 验证状态正确恢复

3. **测试消息队列**
   - 在重试期间发送新消息
   - 验证新消息进入队列
   - 验证不会直接发送

## 未来可能的问题点

### 1. 多次快速重试

**场景**: 网络不稳定导致连续多次重试
**风险**: 可能创建多个 controller, 引用混乱
**建议**: 监控 controller 创建和销毁, 确保引用链路清晰

### 2. 重试期间用户操作

**场景**: 用户在重试延迟期间频繁按 ESC 或发送消息
**风险**: 状态转换可能不符合预期
**建议**: 添加状态转换日志, 便于排查

### 3. Timer 清理时机

**场景**: 异常退出路径可能遗漏 timer 清理
**风险**: 内存泄漏或过期回调
**建议**: 考虑抽取 timer 管理为独立函数, 统一清理逻辑

### 4. 流中断后的状态恢复

**场景**: 流被中断后, 各种状态需要正确恢复
**风险**: 某些状态可能未被重置
**建议**: 在 finally 块中添加完整的状态清理检查清单

## 可选增强建议

1. **抽取 timer 清理函数**

   ```typescript
   const clearRetryStatusTimerSafely = () => {
   	if (retryStatusClearTimer) {
   		clearTimeout(retryStatusClearTimer);
   		retryStatusClearTimer = null;
   	}
   };
   ```

   在创建新 timer 前和 finally 块中统一调用

2. **添加行为测试**
   测试 retry + finally 路径中 timer 不会在结束后再触发状态写入

3. **添加状态转换日志**
   在关键状态转换点添加日志, 便于排查问题

## 审查记录

- **首次审查**: 发现 3 个问题 (controller 引用同步, 重复清理, timer 管理)
- **二次审查**: 发现 3 个问题 (finally 块 timer 清理, 开发日志注释, 文档注释)
- **三次审查**: 通过, 未发现新的阻断性问题

## 修复日期

2026-02-26

## 修复状态

✅ 已完成, 构建验证通过, 等待实际测试反馈
