/**
 * Tool Search 服务(渐进式工具发现).
 *
 * 为什么需要它:
 * - 直接把全部工具定义塞进一次模型请求会占用大量上下文.
 * - 该服务提供一个 `tool_search` 元工具,让模型先搜索,再按需加载工具,以节约上下文.
 *
 * 约束:
 * - registry 只能基于当前代理已授权的 allowedTools 构建,不得回流 rawTools 扩权.
 * - 该服务是有状态的,主代理与子代理必须使用隔离实例,避免 registry 串扰.
 */

import type {MCPTool, MCPServiceTools} from './mcpToolsManager.js';

interface SearchResult {
	toolName: string;
	description: string;
	score: number;
}

interface ExternalServiceMeta {
	serviceName: string;
	toolNames: string[];
	toolDescriptions: string[];
}

interface ToolSearchBuildOptions {
	discoveredToolNames: Set<string>;
	initialTools?: MCPTool[];
}

interface BuiltInCategorySummary {
	category: string;
	count: number;
}

export class ToolSearchService {
	private registry: MCPTool[] = [];
	private toolMap: Map<string, MCPTool> = new Map();
	private externalServices: ExternalServiceMeta[] = [];

	/**
	 * 更新工具 registry(仅允许已授权工具).
	 *
	 * 为什么必须这样做:
	 * - Tool Search 只能搜索"当前代理真正允许看到的工具集合".
	 * - 如果把未授权工具放进 registry,会导致越权可见/可搜索.
	 */
	updateRegistry(tools: MCPTool[], servicesInfo?: MCPServiceTools[]): void {
		this.registry = tools;
		this.toolMap.clear();
		for (const tool of tools) {
			this.toolMap.set(tool.function.name, tool);
		}

		const allowedToolNames = new Set(tools.map(tool => tool.function.name));
		this.externalServices = [];
		if (servicesInfo) {
			for (const svc of servicesInfo) {
				const allowedServiceTools = svc.tools.filter(tool =>
					allowedToolNames.has(`${svc.serviceName}-${tool.name}`),
				);
				if (!svc.isBuiltIn && svc.connected && allowedServiceTools.length > 0) {
					this.externalServices.push({
						serviceName: svc.serviceName,
						toolNames: allowedServiceTools.map(t => t.name),
						toolDescriptions: allowedServiceTools.map(
							t => t.description || t.name,
						),
					});
				}
			}
		}
	}

	/**
	 * 根据关键词搜索工具.
	 *
	 * 说明:
	 * - 返回 textResult(给模型看的文本) + matchedToolNames(用于调用侧解锁工具).
	 * - 搜索范围仅限 registry,因此天然不会泄露未授权工具.
	 */
	search(
		query: string,
		maxResults = 5,
	): {textResult: string; matchedToolNames: string[]} {
		const keywords = query
			.toLowerCase()
			.split(/[\s,._-]+/)
			.filter(k => k.length > 1);

		if (keywords.length === 0) {
			return {
				textResult: `Please provide a search query. Available tool categories:\n${this.getCategorySummary()}`,
				matchedToolNames: [],
			};
		}

		// Build a map of external service names for prefix matching bonus
		const externalServiceNames = new Set(
			this.externalServices.map(s => s.serviceName.toLowerCase()),
		);

		const scored: SearchResult[] = [];

		for (const tool of this.registry) {
			const name = tool.function.name.toLowerCase();
			const desc = (tool.function.description || '').toLowerCase();
			let score = 0;

			for (const keyword of keywords) {
				if (name === keyword) {
					score += 20;
				} else if (name.startsWith(keyword + '-') || name.startsWith(keyword)) {
					score += 15;
				} else if (name.includes(keyword)) {
					score += 10;
				}

				if (desc.includes(keyword)) {
					score += 3;
				}

				const params = tool.function.parameters;
				if (params?.properties) {
					const paramNames = Object.keys(params.properties)
						.join(' ')
						.toLowerCase();
					if (paramNames.includes(keyword)) {
						score += 2;
					}
				}

				// Boost score when keyword matches an external service prefix
				// This ensures searching by service name surfaces all its tools
				if (externalServiceNames.has(keyword)) {
					const prefix = keyword + '-';
					if (name.startsWith(prefix) || name === keyword) {
						score += 10;
					}
				}
			}

			if (score > 0) {
				scored.push({
					toolName: tool.function.name,
					description: tool.function.description || '',
					score,
				});
			}
		}

		scored.sort((a, b) => b.score - a.score);
		const results = scored.slice(0, maxResults);

		if (results.length === 0) {
			return {
				textResult: `No tools found matching "${query}". Available tool categories:\n${this.getCategorySummary()}`,
				matchedToolNames: [],
			};
		}

		const lines = results.map(
			(r, i) => `${i + 1}. **${r.toolName}** - ${r.description}`,
		);

		const textResult = `Found ${
			results.length
		} tool(s) matching "${query}" (now available for use):\n\n${lines.join(
			'\n\n',
		)}\n\nThese tools are now loaded and ready to call directly.`;
		const matchedToolNames = results.map(r => r.toolName);

		return {textResult, matchedToolNames};
	}

	private getBuiltInCategoryCounts(): Map<string, number> {
		const externalNames = new Set(
			this.externalServices.map(s => s.serviceName.toLowerCase()),
		);
		const categories = new Map<string, number>();
		for (const tool of this.registry) {
			const prefix =
				tool.function.name.split('-')[0]?.toLowerCase() ||
				tool.function.name.toLowerCase();
			if (externalNames.has(prefix)) {
				continue;
			}
			categories.set(prefix, (categories.get(prefix) || 0) + 1);
		}
		return categories;
	}

	private getSortedBuiltInCategories(limit?: number): BuiltInCategorySummary[] {
		const categories = Array.from(this.getBuiltInCategoryCounts()).map(
			([category, count]) => ({category, count}),
		);
		categories.sort((a, b) => {
			if (b.count !== a.count) {
				return b.count - a.count;
			}
			return a.category.localeCompare(b.category);
		});
		return typeof limit === 'number' ? categories.slice(0, limit) : categories;
	}

	private getBuiltInCategoryExamples(limit = 5): string[] {
		return this.getSortedBuiltInCategories(limit).map(item => item.category);
	}

	private getThirdPartyServiceNames(limit?: number): string[] {
		const serviceNames = this.externalServices.map(s => s.serviceName).sort();
		return typeof limit === 'number'
			? serviceNames.slice(0, limit)
			: serviceNames;
	}

	/**
	 * 获取工具类别摘要,用于在 tool_search 的说明中引导用户如何检索.
	 *
	 * 为什么要区分内置与第三方服务:
	 * - 内置工具可按类别给出示例.
	 * - 第三方 MCP 服务更适合按 serviceName 引导检索.
	 */
	getCategorySummary(): string {
		const builtInLines = this.getSortedBuiltInCategories().map(
			item =>
				`- ${item.category} (${item.count} tool${item.count > 1 ? 's' : ''})`,
		);
		const externalLines = this.externalServices.map(
			svc =>
				`- ${svc.serviceName} (${svc.toolNames.length} tool${
					svc.toolNames.length > 1 ? 's' : ''
				})`,
		);

		let result = builtInLines.join('\n');
		if (externalLines.length > 0) {
			result +=
				(result ? '\n\n' : '') +
				'Third-party MCP services:\n' +
				externalLines.join('\n');
		}
		return result;
	}

	/**
	 * 根据完整工具名获取工具定义.
	 *
	 * 为什么必须使用完整名:
	 * - 工具权限与 Tool Search 的 registry 都以运行时工具全称为唯一标识,避免短名/前缀导致的歧义与越权.
	 */
	getToolByName(name: string): MCPTool | undefined {
		return this.toolMap.get(name);
	}

	/**
	 * 根据工具名集合批量获取工具定义.
	 *
	 * 为什么需要批量接口:
	 * - buildActiveTools 需要按已发现工具名快速组装 tools 列表,避免在上层重复遍历 registry.
	 */
	getToolsByNames(names: Iterable<string>): MCPTool[] {
		const result: MCPTool[] = [];
		for (const name of names) {
			const tool = this.toolMap.get(name);
			if (tool) {
				result.push(tool);
			}
		}
		return result;
	}

	/**
	 * 从历史消息中提取曾经调用过的工具名.
	 *
	 * 为什么需要预加载:
	 * - 避免同一会话反复 tool_search 才能再次调用已用过的工具,降低交互成本.
	 */
	extractUsedToolNames(
		messages: Array<{tool_calls?: Array<{function: {name: string}}>}>,
	): Set<string> {
		const usedNames = new Set<string>();
		for (const msg of messages) {
			if (msg.tool_calls) {
				for (const tc of msg.tool_calls) {
					const name = tc.function.name;
					if (name !== 'tool_search') {
						usedNames.add(name);
					}
				}
			}
		}
		return usedNames;
	}

	/**
	 * 构建一次模型请求需要暴露的 tools 列表.
	 *
	 * 组成:
	 * - 必带: `tool_search`.
	 * - 首轮直出: initialTools.
	 * - 已发现: discoveredToolNames 对应的工具.
	 *
	 * 为什么这样做:
	 * - 避免一次性暴露全部工具导致上下文膨胀.
	 */
	buildActiveTools(options: ToolSearchBuildOptions): MCPTool[] {
		const {discoveredToolNames, initialTools = []} = options;
		const active: MCPTool[] = [this.getToolSearchDefinition()];
		const addedToolNames = new Set<string>();

		for (const tool of initialTools) {
			if (!addedToolNames.has(tool.function.name)) {
				active.push(tool);
				addedToolNames.add(tool.function.name);
			}
		}

		for (const name of discoveredToolNames) {
			if (addedToolNames.has(name)) {
				continue;
			}
			const tool = this.toolMap.get(name);
			if (tool) {
				active.push(tool);
				addedToolNames.add(name);
			}
		}
		return active;
	}
	/**
	 * 获取 `tool_search` 元工具定义.
	 *
	 * 为什么需要动态生成:
	 * - tool_search 的描述里展示的类别/第三方服务信息必须来自"已授权 registry",否则会泄露无权限工具信息.
	 */
	getToolSearchDefinition(): MCPTool {
		const builtInCategoryExamples = this.getBuiltInCategoryExamples(5);
		const builtInCategoryText =
			builtInCategoryExamples.length > 0
				? builtInCategoryExamples.map(category => `"${category}"`).join(', ')
				: 'authorized categories from the current tool registry';
		let description =
			'Search for available tools by keyword or description. Call this FIRST to discover tools you need. Found tools become immediately available. ' +
			`Search by authorized built-in category (e.g., ${builtInCategoryText}) or by action (e.g., "edit file", "search code", "run command"). ` +
			'You can call this multiple times to discover different tool categories.';

		if (this.externalServices.length > 0) {
			const externalSummaries = this.externalServices.map(svc => {
				const toolBrief = svc.toolDescriptions
					.slice(0, 3)
					.map(d => {
						const short = d.length > 60 ? d.substring(0, 57) + '...' : d;
						return short;
					})
					.join('; ');
				const extra =
					svc.toolNames.length > 3 ? ` +${svc.toolNames.length - 3} more` : '';
				return `"${svc.serviceName}" (${toolBrief}${extra})`;
			});
			description +=
				` Additionally, the following third-party MCP services are loaded and searchable: ${externalSummaries.join(
					', ',
				)}. ` + `Search by their service name to discover their tools.`;
		}

		let queryDescription =
			'Search query - tool name, keyword, or description of what you want to do. ' +
			`Examples: ${builtInCategoryText}, "edit file", "search code", "run command"`;

		if (this.externalServices.length > 0) {
			const extNames = this.getThirdPartyServiceNames(5)
				.map(name => `"${name}"`)
				.join(', ');
			queryDescription += `. Third-party services: ${extNames}`;
		}

		return {
			type: 'function',
			function: {
				name: 'tool_search',
				description,
				parameters: {
					type: 'object',
					properties: {
						query: {
							type: 'string',
							description: queryDescription,
						},
					},
					required: ['query'],
				},
			},
		};
	}

	hasTools(): boolean {
		return this.registry.length > 0;
	}

	getToolCount(): number {
		return this.registry.length;
	}
}

export const toolSearchService = new ToolSearchService();

/**
 * 创建隔离的 ToolSearchService 实例.
 *
 * 为什么必须隔离:
 * - ToolSearchService 内部持有 registry/toolMap 等可变状态.
 * - 主代理与子代理若共用单例,会互相覆盖 registry,导致可搜索工具集合串扰.
 */
export function createToolSearchService(): ToolSearchService {
	return new ToolSearchService();
}
