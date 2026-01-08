import React from 'react';
import {Box, Text} from 'ink';
import {useTheme} from '../../contexts/ThemeContext.js';
import type {TodoItem} from '../../../mcp/types/todo.types.js';
/**
 * TodoTree 组件属性接口
 * @property todos - TODO 列表
 * @property scrollOffset - 滚动偏移量，从第几条开始显示（可选，默认 0）
 */
interface TodoTreeProps {
	todos: TodoItem[];
	scrollOffset?: number;
}

/**
 * TODO Tree 组件 - 显示紧凑任务列表
 */

/**
 * 树节点接口 - 表示树状结构中的节点
 */
interface TreeNode {
	id: string;
	content: string;
	status: 'pending' | 'completed';
	createdAt: string;
	updatedAt: string;
	parentId?: string;
	level: number; // 层级深度，0 表示根任务
	children: TreeNode[]; // 子任务列表
}

/**
 * 扁平化的 TODO 接口 - 用于渲染显示
 */
interface FlattenedTodo extends TodoItem {
	prefix: string; // 连接符前缀
	level: number; // 层级深度
}

/**
 * 构建 TODO 树状结构
 * @param todos - 扁平的 TODO 列表
 * @returns 树状结构的根节点列表
 */
export function buildTodoTree(todos: TodoItem[]): TreeNode[] {
	// 步骤1：创建所有节点的 Map
	const nodeMap = new Map<string, TreeNode>();
	todos.forEach(todo => {
		nodeMap.set(todo.id, {
			...todo,
			level: 0,
			children: [],
		});
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

	return roots;
}

/**
 * 将树状结构扁平化并添加连接符前缀
 * @param nodes - 树状结构的节点列表
 * @returns 扁平化的 TODO 列表，带有连接符前缀
 */
export function flattenTree(nodes: TreeNode[]): FlattenedTodo[] {
	const result: FlattenedTodo[] = [];

	const traverse = (
		node: TreeNode,
		prefix: string,
		siblingsTotal: number,
		siblingIndex: number,
	) => {
		const isLast = siblingIndex === siblingsTotal - 1;
		const currentPrefix =
			node.level === 0
				? isLast
					? '└─ '
					: '├─ '
				: prefix + (isLast ? '└─ ' : '├─ ');
		const verticalPrefix =
			node.level === 0
				? isLast
					? '  '
					: '│ '
				: prefix + (isLast ? '  ' : '│ ');

		result.push({
			id: node.id,
			content: node.content,
			status: node.status,
			createdAt: node.createdAt,
			updatedAt: node.updatedAt,
			parentId: node.parentId,
			prefix: currentPrefix,
			level: node.level,
		});

		// 递归处理子任务
		node.children.forEach((child, i) => {
			traverse(child, verticalPrefix, node.children.length, i);
		});
	};

	nodes.forEach((node, i) => {
		traverse(node, '', nodes.length, i);
	});

	return result;
}

export default function TodoTree({todos, scrollOffset = 0}: TodoTreeProps) {
	const {theme} = useTheme();
	if (todos.length === 0) {
		return (
			<Box flexDirection="column" paddingLeft={2}>
				<Text>
					<Text dimColor>TODO </Text>
					<Text color={theme.colors.menuInfo}>(0/0)</Text>
				</Text>
			</Box>
		);
	}

	// 构建树状结构并扁平化
	const treeNodes = buildTodoTree(todos);
	const flattenedTodos = flattenTree(treeNodes);

	const MAX_VISIBLE = 5;
	const totalCount = flattenedTodos.length;
	const completedCount = flattenedTodos.reduce(
		(acc, t) => acc + (t.status === 'completed' ? 1 : 0),
		0,
	);

	// 应用滚动偏移（在整个列表上滚动）
	let visibleTodos: FlattenedTodo[];

	if (totalCount <= MAX_VISIBLE) {
		// 列表很短，全部显示
		visibleTodos = flattenedTodos;
	} else {
		// 列表很长，应用滚动
		const maxOffset = Math.max(0, totalCount - MAX_VISIBLE);
		const validOffset = Math.min(Math.max(scrollOffset, 0), maxOffset);
		visibleTodos = flattenedTodos.slice(validOffset, validOffset + MAX_VISIBLE);
	}

	// 计算滚动提示
	const hasMoreAbove = scrollOffset > 0;
	const hasMoreBelow = scrollOffset + visibleTodos.length < totalCount;
	const needsScroll = totalCount > MAX_VISIBLE;

	let scrollHint = '';
	if (needsScroll) {
		if (hasMoreAbove && hasMoreBelow) {
			scrollHint = ' ⬆/⬇';
		} else if (hasMoreAbove) {
			scrollHint = ' ⬆';
		} else if (hasMoreBelow) {
			scrollHint = ' ⬇';
		}
	}

	const getStatusIcon = (status: string) => {
		return status === 'completed' ? '✓' : '○';
	};

	const getStatusColor = (status: string) => {
		return status === 'completed'
			? theme.colors.success
			: theme.colors.menuSecondary;
	};

	const renderTodoLine = (
		todo: FlattenedTodo,
		index: number,
	): React.ReactNode => {
		const statusIcon = getStatusIcon(todo.status);
		const statusColor = getStatusColor(todo.status);

		return (
			<Text key={`${todo.id}:${index}`}>
				{todo.prefix}
				<Text color={statusColor}>
					{statusIcon} {todo.content}
				</Text>
			</Text>
		);
	};

	return (
		<Box flexDirection="column" paddingLeft={2}>
			<Text>
				<Text dimColor>TODO </Text>
				<Text color={theme.colors.menuInfo}>
					({completedCount}/{totalCount})
				</Text>
				{scrollHint && <Text dimColor>{scrollHint}</Text>}
				<Text dimColor> alt+u/d</Text>
			</Text>
			{visibleTodos.map((todo, index) => renderTodoLine(todo, index))}
		</Box>
	);
}
