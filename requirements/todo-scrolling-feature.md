<!-- # 需求文档 - TODO 滚动功能

## 1. 项目现状与核心目标

### 1.1 项目现状

当前项目中的 TODO 列表显示优化方案已经实现，核心策略是：

- 确保**所有未完成任务**都可见
- **已完成任务适当精简**
- 最大显示数量为 5 条（未完成任务多时会突破此限制）

**当前显示规则**：

- 全是未完成：全部显示
- 全是已完成：只显示最后 5 条
- 混合状态：未完成全部显示 + 已完成补齐（未完成 < 5 时补齐到 5 条，未完成 >= 5 时额外显示 2 条已完成）

### 1.2 用户痛点

当未完成任务很多时（例如 10 个或更多），TODO 列表会变得很长，占用大量屏幕空间，影响用户体验。

### 1.3 核心目标

将 TODO 列表改为**滚动式显示**和**树状显示**，通过以下方式解决长列表和父子关系展示问题：

**滚动功能**：

1. 限制显示高度为最多 5 条
2. 提供快捷键让用户手动上下滚动
3. 一段时间不操作后自动滚动到合适位置
4. 在标题栏显示快捷键指引

**树状显示功能**：

1. 使用连接符（├─、└─、│）显示父子关系
2. 滚动单位是单行 TODO，可能拆分父子关系
3. 自动滚动只看状态，不考虑父子关系

---

## 2. 范围与边界

### 2.1 功能点

**核心功能（滚动）**：

- [ ] 快捷键滚动：Alt+U 向上滚动，Alt+D 向下滚动
- [ ] 显示高度限制：最多显示 5 条 TODO（不足 5 条时显示实际数量）
- [ ] 边界处理：滚动到顶部或底部时停止，不做提示
- [ ] 自动滚动：7 秒不操作后自动滚动到默认位置
- [ ] 快捷键指引：在 TODO 标题栏显示 "alt+u/d ⬆/⬇"

**核心功能（树状显示）**：

- [ ] 使用连接符显示父子关系：├─、└─、│
- [ ] 根据 parentId 构建树形结构
- [ ] 滚动单位是单行 TODO，可能拆分父子关系
- [ ] 自动滚动只看状态，不考虑父子关系

**显示规则**：

- [ ] 手动滚动时，显示滚动范围内的 5 条 TODO（按行滚动，可能拆分父子关系）
- [ ] 自动滚动时，确保第一条未完成 TODO 可见（只看状态，不考虑父子关系）
- [ ] 当 TODO 数量 <= 5 时，显示所有 TODO，不显示滚动提示

### 2.2 排除项

- [ ] 不修改现有 TODO 的数据结构和状态管理
- [ ] 不改变 TODO 的完成/未完成逻辑
- [ ] 不修改其他快捷键功能
- [ ] 不显示倒计时提示（静默自动滚动）
- [ ] 不实现循环滚动（边界处停止）

---

## 3. 举例覆盖需求和边缘情况

### 3.0 树状显示基本场景

**场景 0：树状显示基础（无父子关系）**

输入：

- TODO 列表共 3 条，都是根任务
- 状态：1 未完成，2 已完成，3 未完成

输出：

```
TODO (1/3)
├─ ○ todo 未完成
├─ ✓ todo 已完成
└─ ○ todo 未完成
```

**场景 0.1：树状显示（有父子关系）**

输入：

- TODO 列表共 6 条，结构如下：
  - 父任务 1（未完成）
    - 子任务 1.1（未完成）
    - 子任务 1.2（已完成）
  - 父任务 2（已完成）
    - 子任务 2.1（已完成）

输出：

```
TODO (2/6)
├─ ○ 父任务1
│  ├─ ○ 子任务1.1
│  └─ ✓ 子任务1.2
└─ ✓ 父任务2
   └─ ✓ 子任务2.1
```

**场景 0.2：树状显示（多层嵌套）**

输入：

- TODO 列表共 7 条，结构如下：
  - 父任务 1（未完成）
    - 子任务 1.1（已完成）
      - 孙任务 1.1.1（未完成）
  - 父任务 2（已完成）

输出：

```
TODO (2/7)
├─ ○ 父任务1
│  └─ ✓ 子任务1.1
│     └─ ○ 孙任务1.1.1
└─ ✓ 父任务2
```

**场景 0.3：树状显示（滚动拆分父子关系）**

输入：

- TODO 列表共 12 条，结构如下：
  - 父任务 1（已完成）
    - 子任务 1.1（已完成）
    - 子任务 1.2（已完成）
    - 子任务 1.3（未完成） ← 第一条未完成
    - 子任务 1.4（未完成）
  - 父任务 2（已完成）
    - 子任务 2.1（已完成）
    - ...
- 当前显示第 2-6 条

输出：

```
TODO (5/12) alt+u/d ⬆/⬇
│  ├─ ✓ 子任务1.2  ← 第2条
│  ├─ ○ 子任务1.3  ← 第3条（第一条未完成）
│  └─ ○ 子任务1.4  ← 第4条
└─ ✓ 父任务2  ← 第5条
   ├─ ✓ 子任务2.1  ← 第6条
```

注意：显示从子任务 1.2 开始，没有显示父任务 1，体现了滚动单位是单行 TODO。

### 3.1 基本滚动操作

**场景 1：向上滚动（Alt+U）**

输入：

- TODO 列表共 12 条
- 当前显示第 6-10 条
- 用户按下 Alt+U

输出：

- 显示第 5-9 条
- 标题栏显示：TODO (5/12) alt+u/d ⬆/⬇

**场景 2：向下滚动（Alt+D）**

输入：

- TODO 列表共 12 条
- 当前显示第 3-7 条
- 用户按下 Alt+D

输出：

- 显示第 4-8 条
- 标题栏显示：TODO (5/12) alt+u/d ⬆/⬇

### 3.2 边界情况

**场景 3：滚动到顶部边界**

输入：

- TODO 列表共 12 条
- 当前显示第 1-5 条
- 用户按下 Alt+U

输出：

- 仍然显示第 1-5 条（无法继续向上）
- 标题栏显示：TODO (5/12) alt+u/d ⬇（只显示向下箭头）
- 不显示任何提示或警告

**场景 4：滚动到底部边界**

输入：

- TODO 列表共 12 条
- 当前显示第 8-12 条
- 用户按下 Alt+D

输出：

- 仍然显示第 8-12 条（无法继续向下）
- 标题栏显示：TODO (5/12) alt+u/d ⬆（只显示向上箭头）
- 不显示任何提示或警告

### 3.3 自动滚动

**场景 5：自动滚动到默认位置（正常情况，平铺显示）**

输入：

- TODO 列表共 12 条，状态如下：
  1. 已完成
  2. 已完成
  3. 已完成
  4. 已完成
  5. 未完成（第一条未完成）
  6. 未完成
  7. 未完成
  8. 未完成
  9. 未完成
  10. 已完成
  11. 未完成
  12. 未完成
- 用户手动滚动到第 8-12 条
- 7 秒不操作

输出：

- 自动滚动到第 4-8 条
- 显示内容： 4. todo 已完成 ✓ 5. todo 未完成 ○ 6. todo 未完成 ○ 7. todo 未完成 ○ 8. todo 未完成 ○
- 标题栏显示：TODO (5/12) alt+u/d ⬆/⬇

**场景 6：自动滚动（第一条就是未完成）**

输入：

- TODO 列表共 8 条，状态如下：
  1. 未完成（第一条就是未完成）
  2. 未完成
  3. 未完成
  4. 未完成
  5. 未完成
  6. 已完成
  7. 已完成
  8. 已完成
- 用户手动滚动到第 4-8 条
- 7 秒不操作

输出：

- 自动滚动到第 1-5 条（从第一条开始）
- 显示内容：
  1. todo 未完成 ○
  2. todo 未完成 ○
  3. todo 未完成 ○
  4. todo 未完成 ○
  5. todo 未完成 ○
- 标题栏显示：TODO (5/8) alt+u/d ⬇（只显示向下箭头）

**场景 7：自动滚动（全部已完成）**

输入：

- TODO 列表共 10 条，全部已完成
- 用户手动滚动到第 6-10 条
- 7 秒不操作

输出：

- 自动滚动到第 6-10 条（最后 5 条）
- 显示内容： 6. todo 已完成 ✓ 7. todo 已完成 ✓ 8. todo 已完成 ✓ 9. todo 已完成 ✓ 10. todo 已完成 ✓
- 标题栏显示：TODO (10/10) alt+u/d ⬆（只显示向上箭头）

**场景 8：自动滚动（全部未完成）**

输入：

- TODO 列表共 8 条，全部未完成
- 用户手动滚动到第 4-8 条
- 7 秒不操作

输出：

- 自动滚动到第 1-5 条（从第一条开始）
- 显示内容：
  1. todo 未完成 ○
  2. todo 未完成 ○
  3. todo 未完成 ○
  4. todo 未完成 ○
  5. todo 未完成 ○
- 标题栏显示：TODO (0/8) alt+u/d ⬇（只显示向下箭头）

**场景 8.1：自动滚动（树状结构，第一条未完成是子任务）**

输入：

- TODO 列表共 10 条，结构如下：
  1. 父任务 1（已完成）
  2. 子任务 1.1（已完成）
  3. 子任务 1.2（已完成）
  4. 子任务 1.3（未完成）← 第一条未完成
  5. 子任务 1.4（未完成）
  6. 父任务 2（已完成）
  7. 子任务 2.1（已完成）
  8. 子任务 2.2（未完成）
  9. 父任务 3（已完成）
  10. 子任务 3.1（已完成）
- 用户手动滚动到第 6-10 条
- 7 秒不操作

输出：

- 自动滚动到第 3-7 条（确保第一条未完成可见）
- 显示内容：

```
TODO (3/10) alt+u/d ⬆/⬇
│  ├─ ✓ 子任务1.2  ← 第3条
│  ├─ ○ 子任务1.3  ← 第4条（第一条未完成）
│  └─ ○ 子任务1.4  ← 第5条
└─ ✓ 父任务2  ← 第6条
   ├─ ✓ 子任务2.1  ← 第7条
```

注意：自动滚动只看状态，不考虑父子关系。第一条未完成是子任务 1.3，显示从子任务 1.2 开始（它上面的已完成 TODO）。

**场景 8.2：自动滚动（树状结构，多条未完成分散）**

输入：

- TODO 列表共 12 条，结构如下：
  1. 父任务 1（未完成）← 第一条未完成
  2. 子任务 1.1（已完成）
  3. 子任务 1.2（已完成）
  4. 父任务 2（已完成）
  5. 子任务 2.1（未完成）
  6. 子任务 2.2（已完成）
  7. 父任务 3（已完成）
  8. 子任务 3.1（已完成）
  9. 子任务 3.2（未完成）
  10. 父任务 4（已完成）
  11. 子任务 4.1（已完成）
  12. 子任务 4.2（已完成）
- 用户手动滚动到第 8-12 条
- 7 秒不操作

输出：

- 自动滚动到第 1-5 条（确保第一条未完成可见）
- 显示内容：

```
TODO (3/12) alt+u/d ⬇
├─ ○ 父任务1  ← 第1条（第一条未完成）
│  ├─ ✓ 子任务1.1  ← 第2条
│  └─ ✓ 子任务1.2  ← 第3条
└─ ✓ 父任务2  ← 第4条
   ├─ ○ 子任务2.1  ← 第5条
```

注意：第一条未完成是父任务 1，所以从第 1 条开始显示。

### 3.4 少量 TODO 的情况

**场景 9：TODO 数量少于 5 条**

输入：

- TODO 列表共 3 条
- 状态：1 未完成，2 已完成，3 未完成

输出：

- 显示全部 3 条
- 显示内容：
  1. todo 未完成 ○
  2. todo 已完成 ✓
  3. todo 未完成 ○
- 标题栏显示：TODO (1/3) alt+u/d（不显示箭头）
- 不显示滚动提示（因为不需要滚动）

**场景 10：TODO 列表为空**

输入：

- TODO 列表为空

输出：

- 标题栏显示：TODO (0/0) alt+u/d
- 不显示任何 TODO 内容
- 不显示滚动提示

### 3.5 滚动提示显示

**场景 11：显示完整的滚动提示**

输入：

- TODO 列表共 12 条
- 当前显示第 4-8 条（可以向上和向下滚动）

输出：

- 标题栏显示：TODO (5/12) alt+u/d ⬆/⬇
- 同时显示向上箭头和向下箭头

**场景 12：只显示向下箭头**

输入：

- TODO 列表共 12 条
- 当前显示第 1-5 条（在顶部）

输出：

- 标题栏显示：TODO (5/12) alt+u/d ⬇
- 只显示向下箭头

**场景 13：只显示向上箭头**

输入：

- TODO 列表共 12 条
- 当前显示第 8-12 条（在底部）

输出：

- 标题栏显示：TODO (5/12) alt+u/d ⬆
- 只显示向上箭头

### 3.6 用户交互流程

**场景 14：完整的用户交互流程**

输入：

1. TODO 列表共 15 条，其中 10 条未完成
2. 初始状态：显示第 1-5 条（包含前 5 条未完成）
3. 用户按下 Alt+D 3 次
4. 用户按下 Alt+U 1 次
5. 等待 7 秒不操作

输出：

1. 初始显示第 1-5 条
2. 按 Alt+D 1 次：显示第 2-6 条
3. 按 Alt+D 2 次：显示第 3-7 条
4. 按 Alt+D 3 次：显示第 4-8 条
5. 按 Alt+U 1 次：显示第 3-7 条
6. 7 秒后自动滚动：显示第 1-5 条（恢复默认位置）

---

## 4. 功能详细说明

### 4.1 快捷键定义

| 快捷键 | 功能     | 说明                  |
| ------ | -------- | --------------------- |
| Alt+U  | 向上滚动 | 滚动窗口向上移动 1 条 |
| Alt+D  | 向下滚动 | 滚动窗口向下移动 1 条 |

**注意**：

- Alt 键在 Ink 框架中映射为 `key.meta`
- 检测方式：`key.meta && input === 'u'` 或 `key.meta && input === 'd'`

### 4.2 显示高度规则

| TODO 总数  | 显示高度 | 说明          |
| ---------- | -------- | ------------- |
| 0          | 0 条     | 空列表        |
| 1-5 条     | 实际数量 | 显示所有 TODO |
| 6 条及以上 | 5 条     | 最多显示 5 条 |

### 4.3 自动滚动逻辑

**触发条件**：

- 用户 7 秒内没有按下 Alt+U 或 Alt+D 滚动快捷键

**目标位置计算**：

1. 找到第一条未完成 TODO 的索引（firstPendingIndex）
2. 如果 firstPendingIndex > 0：
   - 目标滚动位置 = firstPendingIndex - 1
   - 确保第一条未完成 TODO 可见
3. 如果 firstPendingIndex = 0（第一条就是未完成）：
   - 目标滚动位置 = 0
   - 从第一条开始显示
4. 如果 firstPendingIndex = -1（全部已完成）：
   - 目标滚动位置 = max(0, totalCount - 5)
   - 显示最后 5 条

**静默滚动**：

- 不显示任何倒计时提示
- 不显示任何动画效果
- 直接更新显示内容

### 4.4 滚动提示显示规则

| 条件                       | 显示内容              |
| -------------------------- | --------------------- |
| 可以向上滚动且可以向下滚动 | alt+u/d ⬆/⬇           |
| 只能向上滚动（在底部）     | alt+u/d ⬆             |
| 只能向下滚动（在顶部）     | alt+u/d ⬇             |
| 不需要滚动（数量 <= 5）    | alt+u/d（不显示箭头） |

### 4.5 标题栏显示格式

**基本格式**：

```
TODO (已完成数/总数) alt+u/d [滚动提示]
```

**示例**：

- `TODO (5/12) alt+u/d ⬆/⬇`
- `TODO (0/8) alt+u/d ⬇`
- `TODO (10/10) alt+u/d ⬆`
- `TODO (3/3) alt+u/d`

**颜色和样式**：

- "TODO "：淡色（dimColor）
- "(已完成数/总数)"：主题色（theme.colors.menuInfo）
- "alt+u/d ⬆/⬇"：淡色（dimColor）
- 箭头（⬆/⬇）：与快捷键指引同色

### 4.6 树状显示详细说明

**树状结构构建**：

- 根据 `parentId` 字段构建父子关系
- 使用 Map 数据结构快速查找父节点
- 递归或迭代方式构建树形结构

**连接符规则**：

- 根任务：使用 `├─` 或 `└─`
- 中间子任务：使用 `│ ├─` 或 `│ └─`
- 最后一项的子任务：使用 `  └─`
- 多层嵌套：每层增加 `│` 或空格缩进

**示例**：

```
├─ 父任务A
│  ├─ 子任务A.1
│  │  └─ 孙任务A.1.1
│  └─ 子任务A.2
└─ 父任务B
   └─ 子任务B.1
```

**滚动与树状结构的交互**：

- 滚动单位是单行 TODO，可能拆分父子关系
- 滚动时按行号滚动，不考虑父子完整性
- 自动滚动只看状态，不考虑父子关系

---

## 5. 技术实现要点

### 5.1 需要修改的文件

| 文件                                        | 修改内容                                         |
| ------------------------------------------- | ------------------------------------------------ |
| `source/ui/components/special/TodoTree.tsx` | 添加滚动状态、逻辑、提示显示、树状结构构建和渲染 |
| `source/hooks/input/useKeyboardInput.ts`    | 添加 Alt+U/D 快捷键处理                          |
| `source/ui/components/chat/ChatFooter.tsx`  | 管理滚动状态，添加自动滚动逻辑                   |

### 5.2 核心状态

```typescript
// ChatFooter 中的状态
todoScrollOffset: number  // 当前滚动偏移量（从第几条开始显示）

// TodoTree 中的 Props
scrollOffset: number  // 滚动偏移量
onScrollUp: () => void  // 向上滚动回调
onScrollDown: () => void  // 向下滚动回调
```

### 5.3 核心计算

```typescript
// 可见 TODO 列表
visibleTodos = todos.slice(scrollOffset, scrollOffset + 5);

// 是否可以向上滚动
hasMoreAbove = scrollOffset > 0;

// 是否可以向下滚动
hasMoreBelow = scrollOffset + 5 < todos.length;

// 最大滚动偏移量
maxScrollOffset = Math.max(0, todos.length - 5);
```

### 5.4 自动滚动定时器

```typescript
// 在 ChatFooter 中使用 useEffect
useEffect(() => {
	// 清除之前的定时器
	clearTimeout(autoScrollTimer);

	// 设置新的定时器
	autoScrollTimer = setTimeout(() => {
		// 计算目标滚动位置
		const firstPendingIndex = todos.findIndex(t => t.status !== 'completed');
		// ... 计算逻辑
	}, 7000); // 7 秒

	return () => clearTimeout(autoScrollTimer);
}, [todos, userLastScrollTime]);
```

### 5.5 树状结构构建和渲染

**树状结构数据类型**：

```typescript
interface TreeNode {
	id: string;
	content: string;
	status: string;
	parentId?: string;
	level: number; // 层级深度，0 表示根任务
	children: TreeNode[]; // 子任务列表
}
```

**构建树状结构**：

```typescript
// 步骤1：创建所有节点的 Map
const nodeMap = new Map<string, TreeNode>();
todos.forEach(todo => {
	nodeMap.set(todo.id, {...todo, level: 0, children: []});
});

// 步骤2：构建父子关系
const roots: TreeNode[] = [];
todos.forEach(todo => {
	const node = nodeMap.get(todo.id)!;
	if (!todo.parentId) {
		roots.push(node);
	} else {
		const parent = nodeMap.get(todo.parentId);
		if (parent) {
			parent.children.push(node);
		}
	}
});

// 步骤3：计算层级深度
const calculateLevel = (node: TreeNode, level: number) => {
	node.level = level;
	node.children.forEach(child => calculateLevel(child, level + 1));
};
roots.forEach(root => calculateLevel(root, 0));
```

**渲染树状结构**：

```typescript
// 生成连接符前缀
const getPrefix = (
	level: number,
	isLast: boolean,
	parentPrefix: string,
): string => {
	if (level === 0) {
		return isLast ? '└─ ' : '├─ ';
	}
	const connector = isLast ? '└─ ' : '├─ ';
	return parentPrefix + connector;
};

// 生成垂直线前缀
const getVerticalLine = (
	level: number,
	isLast: boolean,
	parentPrefix: string,
): string => {
	if (level === 0) {
		return isLast ? '  ' : '│ ';
	}
	const vertical = isLast ? '  ' : '│ ';
	return parentPrefix + vertical;
};

// 递归渲染节点
const renderTreeNode = (
	node: TreeNode,
	index: number,
	total: number,
	prefix: string,
): React.ReactNode => {
	const isLast = index === total - 1;
	const currentPrefix = getPrefix(node.level, isLast, prefix);
	const verticalPrefix = getVerticalLine(node.level, isLast, prefix);

	return (
		<Box flexDirection="column" key={node.id}>
			<Text>
				{currentPrefix}
				{statusIcon}
				{node.content}
			</Text>
			{node.children.map((child, i) =>
				renderTreeNode(child, i, node.children.length, verticalPrefix),
			)}
		</Box>
	);
};
```

**扁平化渲染（支持滚动）**：

```typescript
// 将树状结构扁平化为数组（用于滚动）
const flattenTree = (nodes: TreeNode[]): TodoItem[] => {
	const result: TodoItem[] = [];
	const traverse = (node: TreeNode, prefix: string) => {
		const isLast = node.parentId ? false : true; // 简化处理
		const currentPrefix = getPrefix(node.level, isLast, prefix);
		result.push({...node, prefix});
		node.children.forEach(child => {
			const verticalPrefix = getVerticalLine(node.level, isLast, prefix);
			traverse(child, verticalPrefix);
		});
	};
	nodes.forEach(node => traverse(node, ''));
	return result;
};

// 应用滚动
const flattenedTodos = flattenTree(roots);
const visibleFlattenedTodos = flattenedTodos.slice(
	scrollOffset,
	scrollOffset + 5,
);
```

---

## 6. 验收标准

### 6.1 功能验收（滚动功能）

- [ ] Alt+U 可以向上滚动 TODO 列表
- [ ] Alt+D 可以向下滚动 TODO 列表
- [ ] 滚动到顶部时停止，不显示提示
- [ ] 滚动到底部时停止，不显示提示
- [ ] 7 秒不操作后自动滚动到默认位置
- [ ] 标题栏正确显示快捷键指引
- [ ] 滚动提示箭头正确显示（⬆/⬇）
- [ ] TODO 数量 <= 5 时不显示滚动提示

### 6.1.2 功能验收（树状显示）

- [ ] 使用连接符（├─、└─、│）正确显示父子关系
- [ ] 子任务正确缩进，显示层级关系
- [ ] 多层嵌套（孙任务、曾孙任务）正确显示
- [ ] 根任务、中间子任务、最后一项的连接符正确
- [ ] 滚动时可以拆分父子关系（显示部分子任务）
- [ ] 自动滚动只看状态，不考虑父子关系

### 6.2 边界验收

- [ ] 空列表时正确显示 "TODO (0/0) alt+u/d"
- [ ] 单条 TODO 时正确显示，不显示滚动提示
- [ ] 全部已完成时自动滚动到最后 5 条
- [ ] 全部未完成时自动滚动到前 5 条
- [ ] 第一条就是未完成时自动滚动到第 1 条

### 6.2.2 边界验收（树状显示）

- [ ] 只有根任务时正确显示（没有子任务）
- [ ] 只有子任务时正确显示（没有根任务，异常情况）
- [ ] 深层嵌套（3 层以上）正确显示
- [ ] 滚动拆分父子关系时连接符正确
- [ ] 第一条未完成是子任务时自动滚动正确

### 6.3 用户体验验收

- [ ] 滚动操作流畅，无卡顿
- [ ] 自动滚动静默进行，不打断用户
- [ ] 快捷键指引清晰易懂
- [ ] 滚动提示准确反映当前状态
- [ ] 不影响其他快捷键功能

### 6.3.2 用户体验验收（树状显示）

- [ ] 树状结构清晰易懂，父子关系一目了然
- [ ] 连接符（├─、└─、│）美观且易于识别
- [ ] 滚动拆分父子关系时不影响用户体验
- [ ] 多层嵌套时不会造成视觉混乱
- [ ] 树状显示不影响滚动操作的流畅性 -->

已完成