# 发送前添加的特殊user实际发送顺序修改 - 实施计划

## 项目概述

将主代理和子代理发送给API的消息序列中的特殊user消息(角色定义、TODO、有用信息、文件夹笔记)从固定位置(紧跟system消息之后)改为动态插入到倒数第5条位置,以提高模型注意力和KV缓存命中率。

### 核心目标

1. **动态插入位置**: 以倒数第5条附近为目标插入点,遇到工具调用块时向前移动,保证块完整
2. **统一主代理与子代理**: 子代理需补上文件夹笔记,两者都插入4类特殊user,顺序一致
3. **保持角色定义差异**: 主代理与子代理仍使用各自的角色定义配置,只统一插入策略与顺序
4. **不改system消息位置**: system消息仍保持首条

### 特殊user清单与顺序

1. Agent角色定义(主代理: mainAgentRole, 子代理: subAgentRole)
2. TODO列表
3. 有用信息
4. 文件夹笔记

---

## 技术架构设计

### 核心概念

#### 1. 工具调用块(Tool Call Block)

工具调用块是指一组连续的消息,包含:
- **assistant消息**: 包含`tool_calls`数组
- **tool消息**: 一个或多个,每个`tool消息`的`tool_call_id`对应assistant消息中某个`tool_call`的`id`

**重要**: 工具调用块必须保持完整性,不能被其他消息打断。

#### 2. 倒数第5条插入策略

- 目标位置: 消息数组长度减去5的位置索引
- 安全检查: 如果目标位置落在工具调用块内,向前移动到该块之前
- 边缘情况: 如果消息总数少于5条,则直接追加到末尾

#### 3. 特殊user连续块插入

根据用户确认的方案A,将所有4类特殊user作为一个连续块插入到计算出的安全位置。

### 数据流设计

```
主代理流程:
sessionInitializer.ts
  ├─ 构建基础消息(包括system)
  ├─ 收集历史消息
  ├─ 调用动态插入逻辑
  │   ├─ 收集4类特殊user
  │   ├─ 识别工具调用块
  │   ├─ 计算安全插入位置
  │   └─ 插入特殊user块
  └─ 返回最终消息数组

子代理流程:
subAgentExecutor.ts
  ├─ 构建finalPrompt(包含subAgentRole)
  ├─ 收集历史消息
  ├─ 调用动态插入逻辑
  │   ├─ 收集4类特殊user(包括文件夹笔记)
  │   ├─ 识别工具调用块
  │   ├─ 计算安全插入位置
  │   └─ 插入特殊user块
  └─ 返回最终消息数组
```

---

## 实施阶段详解

### 阶段1: 工具调用块识别和处理

**目标**: 创建通用的工具函数,用于识别工具调用块和计算安全的插入位置。

#### 1.1 创建工具函数模块

**文件**: `source/utils/message/messageUtils.ts` (新建)

**位置**: 创建新文件

**修改内容**:

```typescript
import type {ChatMessage} from '../../api/chat.js';

/**
 * 工具调用块信息
 */
export interface ToolCallBlock {
  /** 块起始索引(assistant消息) */
  startIndex: number;
  /** 块结束索引(最后一个tool消息) */
  endIndex: number;
  /** 包含的工具调用ID集合 */
  toolCallIds: Set<string>;
}

/**
 * 识别消息序列中的工具调用块
 * @param messages 消息数组
 * @returns 工具调用块列表
 */
export function identifyToolCallBlocks(messages: ChatMessage[]): ToolCallBlock[] {
  const blocks: ToolCallBlock[] = [];
  
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    
    // 找到包含tool_calls的assistant消息
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const toolCallIds = new Set(msg.tool_calls.map(tc => tc.id));
      
      // 查找紧随其后的tool消息
      let endIndex = i;
      for (let j = i + 1; j < messages.length; j++) {
        const followingMsg = messages[j];
        if (followingMsg.role === 'tool' && followingMsg.tool_call_id) {
          if (toolCallIds.has(followingMsg.tool_call_id)) {
            endIndex = j;
          } else {
            // 遇到不属于当前块的工具消息,停止
            break;
          }
        } else if (followingMsg.role === 'assistant' && followingMsg.tool_calls) {
          // 遇到下一个assistant消息,停止
          break;
        } else if (followingMsg.role === 'tool') {
          // 遇到不属于当前块的工具消息,停止
          break;
        } else {
          // 其他类型的消息,继续检查
          continue;
        }
      }
      
      blocks.push({
        startIndex: i,
        endIndex,
        toolCallIds,
      });
      
      // 跳过已处理的块
      i = endIndex;
    }
  }
  
  return blocks;
}

/**
 * 计算安全的插入位置,避开工具调用块
 * @param messages 消息数组
 * @param targetIndex 目标插入位置索引
 * @returns 安全的插入位置索引
 */
export function findSafeInsertPosition(
  messages: ChatMessage[],
  targetIndex: number,
): number {
  const blocks = identifyToolCallBlocks(messages);
  
  // 检查目标位置是否在某个工具调用块内
  for (const block of blocks) {
    if (targetIndex >= block.startIndex && targetIndex <= block.endIndex) {
      // 目标位置在块内,返回块起始位置
      return block.startIndex;
    }
  }
  
  // 目标位置安全,直接返回
  return targetIndex;
}

/**
 * 在指定位置安全地插入消息块
 * @param messages 原始消息数组
 * @param messagesToInsert 要插入的消息块
 * @param insertIndex 插入位置索引
 * @returns 新的消息数组
 */
export function insertMessagesAtPosition(
  messages: ChatMessage[],
  messagesToInsert: ChatMessage[],
  insertIndex: number,
): ChatMessage[] {
  if (messagesToInsert.length === 0) {
    return messages;
  }
  
  // 确保插入位置在有效范围内
  const safeIndex = Math.max(0, Math.min(insertIndex, messages.length));
  
  // 构建新数组
  const result = [...messages.slice(0, safeIndex), ...messagesToInsert, ...messages.slice(safeIndex)];
  
  return result;
}

/**
 * 计算倒数第N条的位置
 * @param messages 消息数组
 * @param count 倒数第几条(默认5)
 * @returns 插入位置索引
 */
export function calculateReversePosition(
  messages: ChatMessage[],
  count: number = 5,
): number {
  const targetIndex = messages.length - count;
  return Math.max(0, targetIndex);
}
```

#### 1.2 添加单元测试

**文件**: `source/utils/message/__tests__/messageUtils.test.ts` (新建)

**位置**: 创建新文件

**测试用例**:

1. 测试`identifyToolCallBlocks`:
   - 无工具调用块的空消息数组
   - 单个工具调用块
   - 多个工具调用块
   - 工具调用块不完整(缺少tool消息)
   - 并行工具调用块

2. 测试`findSafeInsertPosition`:
   - 目标位置不在工具调用块内
   - 目标位置在工具调用块起始
   - 目标位置在工具调用块中间
   - 目标位置在工具调用块结束

3. 测试`insertMessagesAtPosition`:
   - 在开头插入
   - 在中间插入
   - 在末尾插入
   - 插入空消息数组

4. 测试`calculateReversePosition`:
   - 消息数组长度大于count
   - 消息数组长度等于count
   - 消息数组长度小于count
   - 空消息数组

---

### 阶段2: 修改主代理消息构建逻辑

**目标**: 修改主代理的消息构建流程,实现动态插入4类特殊user到倒数第5条位置。

**文件**: `source/hooks/conversation/core/sessionInitializer.ts`

**位置**: Lines 34-87

**当前实现**:
```typescript
// Build conversation history with system prompt from mainAgentManager
const conversationMessages: ChatMessage[] = [
  {
    role: 'system',
    content: mainAgentManager.getSystemPrompt(),
  },
];

// If there are TODOs, add pinned context message at the front
if (existingTodoList && existingTodoList.todos.length > 0) {
  const todoContext = formatTodoContext(existingTodoList.todos);
  conversationMessages.push({
    role: 'user',
    content: todoContext,
  });
}

// Add useful information context if available
const usefulInfoService = getUsefulInfoService();
const usefulInfoList = await usefulInfoService.getUsefulInfoList(
  currentSession.id,
);

if (usefulInfoList && usefulInfoList.items.length > 0) {
  const usefulInfoContext = await formatUsefulInfoContext(
    usefulInfoList.items,
  );
  conversationMessages.push({
    role: 'user',
    content: usefulInfoContext,
  });
}

// Add folder notebook context if available (notes from folders of read files)
const folderNotebookContext = formatFolderNotebookContext();
if (folderNotebookContext) {
  conversationMessages.push({
    role: 'user',
    content: folderNotebookContext,
  });
}

// Add history messages from session (includes tool_calls and tool results)
// Filter out internal sub-agent messages (marked with subAgentInternal: true)
const session = sessionManager.getCurrentSession();
if (session && session.messages.length > 0) {
  const filteredMessages = session.messages.filter(
    msg => !msg.subAgentInternal,
  );
  conversationMessages.push(...filteredMessages);
}

return {conversationMessages, currentSession, existingTodoList};
```

**修改后的实现**:

```typescript
import {
  calculateReversePosition,
  findSafeInsertPosition,
  insertMessagesAtPosition,
} from '../../../utils/message/messageUtils.js';

// Build conversation history with system prompt from mainAgentManager
const conversationMessages: ChatMessage[] = [
  {
    role: 'system',
    content: mainAgentManager.getSystemPrompt(),
  },
];

// Add history messages from session (includes tool_calls and tool results)
// Filter out internal sub-agent messages (marked with subAgentInternal: true)
const session = sessionManager.getCurrentSession();
if (session && session.messages.length > 0) {
  const filteredMessages = session.messages.filter(
    msg => !msg.subAgentInternal,
  );
  conversationMessages.push(...filteredMessages);
}

// 收集4类特殊user消息
const specialUserMessages: ChatMessage[] = [];

// 1. Agent角色定义(mainAgentRole)
const currentConfig = mainAgentManager.getCurrentConfig();
if (currentConfig && currentConfig.mainAgentRole) {
  specialUserMessages.push({
    role: 'user',
    content: `## Agent Role Definition\n\n${currentConfig.mainAgentRole}`,
  });
}

// 2. TODO列表
if (existingTodoList && existingTodoList.todos.length > 0) {
  const todoContext = formatTodoContext(existingTodoList.todos);
  specialUserMessages.push({
    role: 'user',
    content: todoContext,
  });
}

// 3. 有用信息
const usefulInfoService = getUsefulInfoService();
const usefulInfoList = await usefulInfoService.getUsefulInfoList(
  currentSession.id,
);

if (usefulInfoList && usefulInfoList.items.length > 0) {
  const usefulInfoContext = await formatUsefulInfoContext(
    usefulInfoList.items,
  );
  specialUserMessages.push({
    role: 'user',
    content: usefulInfoContext,
  });
}

// 4. 文件夹笔记
const folderNotebookContext = formatFolderNotebookContext();
if (folderNotebookContext) {
  specialUserMessages.push({
    role: 'user',
    content: folderNotebookContext,
  });
}

// 如果没有特殊user消息,直接返回
if (specialUserMessages.length === 0) {
  return {conversationMessages, currentSession, existingTodoList};
}

// 计算安全的插入位置
// 跳过system消息(索引0),只在历史消息中计算
const historyMessagesOnly = conversationMessages.filter(
  (msg, index) => index > 0,
);
const targetIndex = calculateReversePosition(historyMessagesOnly, 5);
const safeIndex = findSafeInsertPosition(historyMessagesOnly, targetIndex);

// 插入特殊user块(注意要加上system消息的偏移量+1)
const finalMessages = insertMessagesAtPosition(
  conversationMessages,
  specialUserMessages,
  safeIndex + 1, // +1 because we filtered out system message
);

return {
  conversationMessages: finalMessages,
  currentSession,
  existingTodoList,
};
```

**关键改动点**:

1. **调整顺序**: 先构建包含system和历史消息的基础数组,再收集特殊user
2. **收集4类特殊user**: 包括主代理角色定义、TODO、有用信息、文件夹笔记
3. **动态插入**: 使用工具函数计算安全位置并插入
4. **边缘情况处理**: 如果没有特殊user消息,直接返回基础数组

---

### 阶段3: 修改子代理消息构建逻辑

**目标**: 修改子代理的消息构建流程,补上文件夹笔记功能并实现动态插入4类特殊user。

**文件**: `source/utils/execution/subAgentExecutor.ts`

**位置**: Lines 827-893

**当前实现**:
```typescript
// Build conversation history for sub-agent
const messages: ChatMessage[] = [];

// Build final prompt with 子代理配置subAgentRole + AGENTS.md + 系统环境 + 平台指导
let finalPrompt = prompt;

// Append agent-specific role if configured
if (agent.subAgentRole) {
  finalPrompt = `${finalPrompt}\n\n${agent.subAgentRole}`;
}
// Append AGENTS.md content if available
const agentsPrompt = getAgentsPrompt();
if (agentsPrompt) {
  finalPrompt = `${finalPrompt}\n\n${agentsPrompt}`;
}

// Append system environment and platform guidance
const systemContext = createSystemContext();
if (systemContext) {
  finalPrompt = `${finalPrompt}\n\n${systemContext}`;
}

// 添加任务完成标识提示词
const taskCompletionPrompt = getTaskCompletionPrompt();
if (taskCompletionPrompt) {
  finalPrompt = `${finalPrompt}\n\n${taskCompletionPrompt}`;
}

// 子代理消息顺序必须为：提示词 → todo → useful
messages.push({
  role: 'user',
  content: finalPrompt,
});

// Add TODO context if available
const currentSession = sessionManager.getCurrentSession();
if (currentSession) {
  const todoService = getTodoService();
  const existingTodoList = await todoService.getTodoList(currentSession.id);

  if (existingTodoList && existingTodoList.todos.length > 0) {
    const todoContext = formatTodoContext(existingTodoList.todos, true); // isSubAgent=true
    messages.push({
      role: 'user',
      content: todoContext,
    });
  }
}

// Add useful information context if available
if (currentSession) {
  const usefulInfoService = getUsefulInfoService();
  const usefulInfoList = await usefulInfoService.getUsefulInfoList(
    currentSession.id,
  );

  if (usefulInfoList && usefulInfoList.items.length > 0) {
    const usefulInfoContext = await formatUsefulInfoContext(
      usefulInfoList.items,
    );
    messages.push({
      role: 'user',
      content: usefulInfoContext,
    });
  }
}
```

**修改后的实现**:

```typescript
import {
  calculateReversePosition,
  findSafeInsertPosition,
  insertMessagesAtPosition,
} from '../message/messageUtils.js';
import {formatFolderNotebookContext} from '../core/folderNotebookPreprocessor.js';

// Build conversation history for sub-agent
const messages: ChatMessage[] = [];

// Build final prompt with 子代理配置subAgentRole + AGENTS.md + 系统环境 + 平台指导
let finalPrompt = prompt;

// Append agent-specific role if configured
if (agent.subAgentRole) {
  finalPrompt = `${finalPrompt}\n\n${agent.subAgentRole}`;
}
// Append AGENTS.md content if available
const agentsPrompt = getAgentsPrompt();
if (agentsPrompt) {
  finalPrompt = `${finalPrompt}\n\n${agentsPrompt}`;
}

// Append system environment and platform guidance
const systemContext = createSystemContext();
if (systemContext) {
  finalPrompt = `${finalPrompt}\n\n${systemContext}`;
}

// 添加任务完成标识提示词
const taskCompletionPrompt = getTaskCompletionPrompt();
if (taskCompletionPrompt) {
  finalPrompt = `${finalPrompt}\n\n${taskCompletionPrompt}`;
}

// 子代理的第一条user消息(作为基础消息)
messages.push({
  role: 'user',
  content: finalPrompt,
});

// 检查子代理角色定义是否存在,如果不存在则抛出错误
if (!agent.subAgentRole) {
  throw new Error(
    `子代理 ${agent.id} 缺少角色定义(subAgentRole),无法执行`,
  );
}

// 收集4类特殊user消息
const specialUserMessages: ChatMessage[] = [];

// 1. Agent角色定义(subAgentRole)
specialUserMessages.push({
  role: 'user',
  content: `## Agent Role Definition\n\n${agent.subAgentRole}`,
});

// 2. TODO列表
const currentSession = sessionManager.getCurrentSession();
if (currentSession) {
  const todoService = getTodoService();
  const existingTodoList = await todoService.getTodoList(currentSession.id);

  if (existingTodoList && existingTodoList.todos.length > 0) {
    const todoContext = formatTodoContext(existingTodoList.todos, true); // isSubAgent=true
    specialUserMessages.push({
      role: 'user',
      content: todoContext,
    });
  }
}

// 3. 有用信息
if (currentSession) {
  const usefulInfoService = getUsefulInfoService();
  const usefulInfoList = await usefulInfoService.getUsefulInfoList(
    currentSession.id,
  );

  if (usefulInfoList && usefulInfoList.items.length > 0) {
    const usefulInfoContext = await formatUsefulInfoContext(
      usefulInfoList.items,
    );
    specialUserMessages.push({
      role: 'user',
      content: usefulInfoContext,
    });
  }
}

// 4. 文件夹笔记(新增)
const folderNotebookContext = formatFolderNotebookContext();
if (folderNotebookContext) {
  specialUserMessages.push({
    role: 'user',
    content: folderNotebookContext,
  });
}

// 如果没有特殊user消息(除了角色定义),直接使用基础消息
if (specialUserMessages.length === 0) {
  // 注意: 角色定义应该始终存在,这里只是防御性检查
  return messages;
}

// 计算安全的插入位置
// 跳过第一条finalPrompt消息,只在后续消息中计算
const messagesWithoutFirst = messages.slice(1);
const targetIndex = calculateReversePosition(messagesWithoutFirst, 5);
const safeIndex = findSafeInsertPosition(messagesWithoutFirst, targetIndex);

// 插入特殊user块
const finalMessages = insertMessagesAtPosition(
  messages,
  specialUserMessages,
  safeIndex + 1, // +1 because we filtered out first message
);
```

**关键改动点**:

1. **补上文件夹笔记**: 添加`formatFolderNotebookContext`调用
2. **错误处理**: 检查子代理角色定义是否存在
3. **收集4类特殊user**: 包括subAgentRole、TODO、有用信息、文件夹笔记
4. **动态插入**: 使用与主代理相同的工具函数

**注意事项**:

- 子代理的第一条消息(finalPrompt)保持不变
- 特殊user插入在finalPrompt之后的合适位置
- 如果缺少subAgentRole,抛出明确的错误信息

---

### 阶段4: 测试验证

**目标**: 确保所有修改通过构建验证,并测试主代理和子代理的实际对话流程。

#### 4.1 构建验证

```bash
npm run build
```

**验证要点**:
- TypeScript类型检查通过
- 没有编译错误
- 没有类型不匹配警告

#### 4.2 手动测试步骤

**测试1: 会话开始(无历史)**

1. 启动应用,创建新会话
2. 发送第一条消息
3. 检查消息顺序应该是:
   - system
   - Agent角色定义
   - TODO(如果有)
   - 有用信息(如果有)
   - 文件夹笔记(如果有)
   - user
   - assistant

**测试2: 多轮对话插入位置**

1. 进行多轮对话,积累历史消息
2. 发送新消息
3. 验证特殊user插入到倒数第5条附近
4. 检查工具调用块是否保持完整

**测试3: 工具调用块不被打断**

1. 触发工具调用,生成assistant(tool_calls) → tool消息
2. 检查特殊user不会插入到工具调用块中间
3. 验证assistant(tool_calls)和tool消息保持相邻

**测试4: 子代理功能**

1. 主代理调用子代理
2. 检查子代理消息中包含4类特殊user
3. 验证文件夹笔记功能正常工作
4. 检查子代理角色定义缺失时的错误处理

**测试5: 边缘情况**

1. 特殊user列表为空(只有角色定义)
2. 历史消息少于5条
3. 倒数第5条正好是工具调用块的起始
4. 倒数第5条正好是工具调用块的中间

---

## 文件修改清单

### 新建文件 (2个)

- [ ] `source/utils/message/messageUtils.ts` - 工具调用块识别和处理函数
- [ ] `source/utils/message/__tests__/messageUtils.test.ts` - 单元测试

### 修改文件 (2个)

- [ ] `source/hooks/conversation/core/sessionInitializer.ts` - 主代理消息构建逻辑
- [ ] `source/utils/execution/subAgentExecutor.ts` - 子代理消息构建逻辑

---

## 重要注意事项

### 1. 工具调用块完整性

- **必须保证**: assistant(tool_calls) 和 tool 消息必须相邻,不能被其他消息打断
- **检测方法**: 使用`identifyToolCallBlocks`函数识别块
- **安全插入**: 使用`findSafeInsertPosition`函数自动避开块

### 2. 消息顺序一致性

- **主代理**: system → 特殊user块(动态插入) → 历史消息
- **子代理**: finalPrompt → 特殊user块(动态插入) → 历史消息
- **特殊user块内部顺序**: 角色定义 → TODO → 有用信息 → 文件夹笔记

### 3. 边缘情况处理

- **会话开始**: 历史消息为空,特殊user追加到末尾
- **消息总数不足5条**: 插入到末尾
- **特殊user为空**: 不插入任何特殊user
- **子代理角色定义缺失**: 抛出明确的错误

### 4. 向后兼容性

- **system消息位置**: 保持不变,仍为首条
- **角色定义内容**: 不改变mainAgentRole和subAgentRole的内容
- **格式化函数**: 不改变formatTodoContext、formatUsefulInfoContext、formatFolderNotebookContext的输出格式

### 5. 性能考虑

- **工具调用块识别**: O(n)时间复杂度,其中n是消息数量
- **插入操作**: 使用数组切片和展开操作,避免频繁的push/shift
- **缓存**: 消息数组较大时,可以考虑缓存识别结果

---

## 风险评估

### 高风险

- **工具调用块被意外打断**: 可能导致API调用失败
  - **缓解措施**: 完善的单元测试覆盖所有工具调用块场景
  
- **子代理角色定义缺失**: 可能导致子代理无法执行
  - **缓解措施**: 在消息构建前检查并抛出明确错误

### 中风险

- **特殊user插入位置不合理**: 可能影响模型性能
  - **缓解措施**: 通过实际对话测试验证效果
  
- **性能下降**: 消息数组较大时,工具调用块识别可能耗时
  - **缓解措施**: 优化算法,避免重复识别

### 低风险

- **TypeScript类型错误**: 编译时检查可提前发现
  - **缓解措施**: 必须通过构建验证

---

## 后续优化建议

1. **性能优化**: 
   - 考虑缓存工具调用块识别结果
   - 优化大消息数组的插入操作

2. **可配置性**:
   - 将倒数第5条改为可配置参数
   - 支持自定义特殊user插入策略

3. **监控和日志**:
   - 添加特殊user插入位置的日志
   - 监控工具调用块完整性

4. **测试覆盖率**:
   - 增加更多边缘情况的单元测试
   - 添加集成测试验证完整流程

---

## 总结

本实施计划通过4个阶段完成特殊user动态插入功能:

- **新建文件**: 2个 (工具函数模块 + 单元测试)
- **修改文件**: 2个 (主代理 + 子代理消息构建)
- **核心改动**: 
  - 创建工具调用块识别和处理函数
  - 修改主代理和子代理的消息构建流程
  - 补上子代理的文件夹笔记功能
  - 实现动态插入到倒数第5条位置

**验证方式**: TypeScript编译 + 手动测试

严格按照此计划执行,可确保修改的完整性、正确性和可维护性。
