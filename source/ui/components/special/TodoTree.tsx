import React, {useEffect, useMemo, useState, useRef} from 'react';
import {Box, Text, useInput} from 'ink';
import {useI18n} from '../../../i18n/index.js';
import {useTheme} from '../../contexts/ThemeContext.js';
import type {TodoItem} from '../../../mcp/types/todo.types.js';

/**
 * TodoTree 组件属性接口
 * @property todos - TODO 列表
 */
interface TodoTreeProps {
	todos: TodoItem[];
}

/**
 * 树节点接口 - 表示树状结构中的节点
 */
interface TreeNode {
	id: string;
	content: string;
	status: 'pending' | 'inProgress' | 'completed';
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

/**
 * TODO Tree 组件 - 显示紧凑任务列表
 */
export default function TodoTree({todos}: TodoTreeProps) {
	const {theme} = useTheme();
	const {t} = useI18n();
	const autoRollbackTimerRef = useRef<NodeJS.Timeout>();

	const PAGE_SIZE = 5;

	// 构建树状结构并扁平化（保持原始顺序，不排序）
	const flattenedTodos = useMemo(() => {
		const treeNodes = buildTodoTree(todos);
		return flattenTree(treeNodes);
	}, [todos]);

	const totalCount = flattenedTodos.length;
	const completedCount = flattenedTodos.reduce(
		(acc, t) => acc + (t.status === 'completed' ? 1 : 0),
		0,
	);

	// 找到第一条重要todo的索引（优先 inProgress，其次 pending）
	const firstImportantIndex = useMemo(() => {
		const inProgressIndex = flattenedTodos.findIndex(
			t => t.status === 'inProgress',
		);
		if (inProgressIndex !== -1) return inProgressIndex;
		return flattenedTodos.findIndex(t => t.status !== 'completed');
	}, [flattenedTodos]);

	const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
	const [pageIndex, setPageIndex] = useState(0);

	// 使用 ref 保存最新的 pageIndex 和 firstImportantIndex，避免闭包问题
	const latestPageIndexRef = useRef(pageIndex);
	const latestFirstImportantIndexRef = useRef(firstImportantIndex);

	// 同步 ref 到最新值
	useEffect(() => {
		latestPageIndexRef.current = pageIndex;
	}, [pageIndex]);

	useEffect(() => {
		latestFirstImportantIndexRef.current = firstImportantIndex;
	}, [firstImportantIndex]);

	// 获取第一条重要todo所在页码（优先 inProgress，其次 pending）
	const getTargetPageIndex = (importantIndex: number) => {
		if (importantIndex === -1) return 0; // 全部完成，从第1页开始
		return Math.floor(importantIndex / PAGE_SIZE);
	};

	// 数据变化或初次加载时，自动定位到第一条重要todo
	useEffect(() => {
		setPageIndex(getTargetPageIndex(firstImportantIndex));
	}, [todos, firstImportantIndex]);

	// 重置自动回滚定时器
	const resetAutoRollbackTimer = () => {
		if (autoRollbackTimerRef.current) {
			clearTimeout(autoRollbackTimerRef.current);
		}
		autoRollbackTimerRef.current = setTimeout(() => {
			// 3秒无操作，自动回滚到第一条重要todo（优先 inProgress，其次 pending）
			// 使用 ref 获取最新值，避免闭包读到旧值
			const targetPage = getTargetPageIndex(
				latestFirstImportantIndexRef.current,
			);
			const currentPage = latestPageIndexRef.current;
			if (targetPage !== currentPage) {
				setPageIndex(targetPage);
			}
		}, 3000);
	};

	// 初始启动定时器
	useEffect(() => {
		resetAutoRollbackTimer();
		return () => {
			if (autoRollbackTimerRef.current) {
				clearTimeout(autoRollbackTimerRef.current);
			}
		};
	}, [pageIndex, firstImportantIndex]);

	// Tab键翻页
	useInput((_input, key) => {
		if (!key.tab || pageCount <= 1) return;

		// 重置定时器（用户有交互）
		resetAutoRollbackTimer();

		// 下一页，循环翻页
		setPageIndex(p => (p + 1) % pageCount);
	});

	const visibleTodos = flattenedTodos.slice(
		pageIndex * PAGE_SIZE,
		pageIndex * PAGE_SIZE + PAGE_SIZE,
	);
	const hiddenCount = Math.max(0, totalCount - visibleTodos.length);

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

	const getStatusIcon = (status: string) => {
		if (status === 'completed') return '✓';
		if (status === 'inProgress') return '~';
		return '○';
	};

	const getStatusColor = (status: string) => {
		if (status === 'completed') return theme.colors.success;
		if (status === 'inProgress') return theme.colors.warning;
		return theme.colors.menuSecondary;
	};

	const renderTodoLine = (
		todo: FlattenedTodo,
		index: number,
	): React.ReactNode => {
		const statusIcon = getStatusIcon(todo.status);
		const statusColor = getStatusColor(todo.status);

		return (
			<Text key={`${todo.id}:${pageIndex}:${index}`}>
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
				<Text dimColor>
					{' '}
					[{pageIndex + 1}/{pageCount}] {t.toolConfirmation.commandPagerHint}
				</Text>
				{hiddenCount > 0 && <Text dimColor> +{hiddenCount} more</Text>}
			</Text>
			{visibleTodos.map((todo, index) => renderTodoLine(todo, index))}
		</Box>
	);
}
