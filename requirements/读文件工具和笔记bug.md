读文件工具读取文件时和笔记有些冲突
应该是在读取文件后和笔记内容拼接时有处理逻辑bug
收到的读文件工具返回是这样的

{
  "type": "tool_result",
  "tool_use_id": "call_1e492a3ee9cf4cfcacc1d53c",
  "content": "\"[object Object]\\n\\n## 📂 Folder Notebooks (Context from read files)\\n\\nThe following folder notebooks are relevant to files you've read in this session.\\n\\n### source/\\n  1. [2026-02-22T12:50:00.416] 职责: Snow CLI(TUI)核心源码根目录.承载 CLI 入口、TUI 界面、对话执行、代理系统、模型渠道适配、MCP 集成、配置与工具体系.\\n\\n模块边界(长期规范):\\n- source/ 只包含 Snow CLI 主程序相关代码,不包含独立子项目(sse-client/).\\n- UI(ink/react)与核心逻辑必须分层: UI 只做状态展示与交互编排,对话执行/模型调用/工具系统在 utils/api/mcp/prompt 等模块.\\n\\n依赖拓扑:\\n- 入口: source/cli.tsx,source/app.tsx.\\n- 关键子模块:\\n  - source/utils/: 对话执行、会话、代理运行时、SSE 管理、通用工具.\\n  - source/api/: 模型渠道适配器(Anthropic/OpenAI Chat/OpenAI Responses/Gemini).\\n  - source/mcp/: MCP 客户端与工具管理.\\n  - source/config/: 内置配置(默认主代理,内置 mainAgents 等).\\n  - source/prompt/: 系统提示词与提示词模块(shared 等).\\n  - source/ui/: Ink 组件与屏幕(screen)体系.\\n\\n避坑指南:\\n- 不在 UI 层直接调用模型适配器或拼接提示词,统一经由 utils 层的执行器/manager.\\n- 新增跨模块能力必须补齐对应 notebook 条目(职责,接口摘要,依赖拓扑,避坑).\\n\\n### source/mcp/\\n  1. [2026-02-22T12:51:00.039] 职责: MCP(Model Context Protocol)集成层.负责连接 MCP server,发现/注册工具,并将 MCP 工具以统一接口暴露给对话执行层.\\n\\n接口摘要:\\n- 输入: MCP 配置(全局/项目),会话上下文,工具调用请求.\\n- 输出: Tool 列表,tool execution 结果,以及工具可用性状态.\\n\\n依赖拓扑:\\n- 依赖: source/utils/config/ 读取与编辑配置,source/utils/execution/ 调用工具.\\n- 被依赖: 主代理/子代理执行层与 UI 的 MCP 配置管理界面.\\n\\n避坑指南:\\n- 工具权限必须受 agent profile 限制(包括限制可编辑文件类型的字段),避免越权编辑.\\n- MCP server 连接生命周期要与会话/进程生命周期对齐,避免残留连接导致资源泄漏.\\n- 不要在此层引入具体模型渠道差异,仅做工具协议与运行时管理.\\n\\n---\\n💡 These notes are from folders containing files you've read. They won't repeat.\"",
  "cache_control": {
    "type": "ephemeral",
    "ttl": "5m"
  }
}