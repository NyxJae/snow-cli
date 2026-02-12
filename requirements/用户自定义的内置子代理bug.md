<!-- 现在项目中可让用户用 toml 配置 子代理
且可覆盖内置子代理
目前 覆盖了的内置子代理的 角色定义,工具权限等都是正确的
但description 字段 并未 完全替换
该字段会出现在主代理的 function 类型中(主代理可使用的工具们)


"type":"function"
"function"
:
{
"name":"subagent-agent_general"
"description":"General Purpose Agent: General-purpose multi-step task execution agent. Has full tool access for searching, modifying files, and executing commands. Best for complex tasks requiring actual operations."

此处的 description 还是 未被替换的 使用 的 项目内置子代理的 默认 description
应该是 用 用户配置 的 (无就用默认) -->
已完成