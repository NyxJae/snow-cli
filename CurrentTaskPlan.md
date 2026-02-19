# CurrentTaskPlan - SSE客户端适配主代理

## 0. 需求来源
- 需求文档: `requirements/SSE客户端适配主代理.md`
- 目标: 为 `source/test/sse-client/` 浏览器端 SSE 客户端示例增加主代理列表展示与切换能力,对齐服务端 SSE 协议(agent_list,agent_switched,switch_agent,error 扩展).

## 1. 范围与边界(必须遵守)
- 仅修改示例客户端文件,不修改 SSE 服务端逻辑.
- 切换主代理以 `sessionId` 为边界,客户端已知 `currentSessionId` 时必须随 `switch_agent` 一并发送.
- 客户端对未知 `event.type` 与未知 `errorCode` 必须容错,不崩溃.
- 断线重连时必须清理主代理相关状态,重连后等待新的 `agent_list` 再启用选择器.

## 2. 目标交付物
- UI: 聊天面板头部右侧,紧邻"新建会话"按钮,新增主代理选择器 `select#mainAgentSelect`.
- 逻辑: app.js 维护 agents/currentAgentId/isSwitching/pendingAgentId/previousAgentId 状态,并实现事件处理与消息发送.
- 反馈: 切换成功/失败有清晰系统消息,错误码提示明确.

## 3. 实施步骤(按顺序执行)

### 3.1 index.html: 添加主代理选择器DOM
文件: `source/test/sse-client/index.html`
- 在聊天面板 `.panel-header` 内,"新建会话"按钮右侧追加:
  - `<select id="mainAgentSelect" class="header-select" disabled>`
  - 默认 option: `(未连接)` 或 `(等待agent_list...)`
  - (可选) 增加一个小的 `<span id="mainAgentSwitchingHint">切换中...</span>` 用于无障碍提示(也可仅用 CSS).
- 保持现有按钮与标题不变,仅扩展头部右侧控件.

验收:
- 页面加载后,在聊天头部能看到禁用的下拉框.

### 3.2 style.css: 增加选择器样式与loading态
文件: `source/test/sse-client/style.css`
- 为聊天面板头部提供右侧布局:
  - 让 `.panel-header` 支持 `display:flex; align-items:center; justify-content:space-between;` 或保持原布局并为按钮+select 包一层容器.
- 新增样式建议:
  - `.header-actions` 容器(包裹新建会话按钮 + select)
  - `.header-select` 主代理下拉框(紧凑宽度)
  - `.header-select.switching` 或 `[data-switching="true"]` 用于切换中态(降低透明度,显示 spinner 背景图等)

验收:
- select 与新建会话按钮同一行,右侧对齐,且在窄屏不挤压标题.

### 3.3 app.js: 新增主代理状态与UI更新函数
文件: `source/test/sse-client/app.js`
新增全局状态(与 currentSessionId 同级):
- `let agents = [];`
- `let currentAgentId = null;`
- `let isSwitchingAgent = false;`
- `let pendingAgentId = null;`
- `let previousAgentId = null;`

新增UI函数:
- `function resetMainAgentState(reason)`:
  - 清空 agents/currentAgentId/isSwitching/pending/previous.
  - 禁用 select,并设置 option 为 `(未连接)` 或 `(等待agent_list...)`.
- `function renderMainAgentSelect()`:
  - 根据 agents 填充 option(label=name,value=id,title=description).
  - 无 agents 时显示 disabled option: `(暂无可用主代理)`.
  - 根据 currentAgentId 设置 selected.
  - 根据 isSwitchingAgent 设置 disabled + switching class.

验收:
- connect/disconnect/onerror 会正确重置选择器.

### 3.4 app.js: 处理 agent_list/agent_switched 事件
文件: `source/test/sse-client/app.js`,函数 `handleEvent(event)` 增加分支:
- `case 'agent_list'`:
  - `agents = event.data?.agents ?? []`
  - `currentAgentId = event.data?.currentAgentId ?? null`
  - `isSwitchingAgent = false; pendingAgentId=null; previousAgentId=null;`
  - `renderMainAgentSelect()`
- `case 'agent_switched'`:
  - 从 agents 中根据 `previousAgentId` 查 name,找不到用 id 兜底.
  - 更新 `currentAgentId = event.data.currentAgentId`
  - `isSwitchingAgent=false; pendingAgentId=null; previousAgentId=null;`
  - `renderMainAgentSelect()`
  - `addSystemMessage("主代理已切换: {prevName} -> {event.data.agentName}")`

验收:
- 服务端推送 agent_list 时下拉框变为可选,默认选中 currentAgentId.
- 收到 agent_switched 时显示系统消息且选中项更新.

### 3.5 app.js: 发送 switch_agent,并实现回滚与锁
文件: `source/test/sse-client/app.js`
- 在 `connect()` 成功后(或页面初始化时)为 `#mainAgentSelect` 绑定 `change` 事件:
  - 若 `!currentSessionId`: 提示 `请先创建或加载会话` ,并立即把 select 选中项回滚为 currentAgentId.
  - 若 `isSwitchingAgent`: 忽略(或提示"切换中").
  - 若选择与 currentAgentId 相同: 直接 return.
  - 否则:
    - `previousAgentId = currentAgentId; pendingAgentId = selectedId; isSwitchingAgent=true; renderMainAgentSelect();`
    - 发送 fetch 到 `${serverUrl}/message` payload: `{ type:'switch_agent', agentId:selectedId, sessionId: currentSessionId }`

验收:
- 切换时 select 禁用并显示 switching 态.
- 未绑定会话时不发送请求且回滚.

### 3.6 app.js: 扩展 error 事件处理(主代理错误码)
文件: `source/test/sse-client/app.js`,在 `case 'error'` 内扩展:
- 若 `event.data?.errorCode` 属于:
  - `invalid_agent_id`,`invalid_agent_id_format`: 提示固定中文文案.
  - `agent_not_found`: 使用 message + 展示 availableAgents 列表(可简要),并回滚选择器为 previousAgentId.
  - `agent_busy`: 提示"当前会话有进行中的任务...".
  - `session_not_found`: 提示"会话不存在,请先创建或加载会话".
- 若当前处于 `isSwitchingAgent`:
  - `isSwitchingAgent=false; pendingAgentId=null;`
  - 回滚 select 到 `previousAgentId`(并保留 currentAgentId 不变)
  - `previousAgentId=null; renderMainAgentSelect();`
- 其他未知 errorCode: 保持原逻辑 `错误: message`.

验收:
- 切换失败后 select 恢复可用并回滚.
- 未知 errorCode 不导致崩溃.

## 4. 冒烟测试清单(人工)
1. 打开 `source/test/sse-client/index.html`,连接本地 SSE 服务.
2. 连接成功后应收到 agent_list,下拉框启用且有选项.
3. 新建会话或加载会话后,切换主代理应触发 switch_agent.
4. 切换成功: 收到 agent_switched,聊天框出现系统消息,下拉框选中更新.
5. 切换失败: 模拟 agent_busy 等错误,下拉框回滚并提示.
6. 断开连接/网络错误: 下拉框禁用显示(未连接),重连后等待 agent_list 恢复.

## 5. 代码质量要求
- 仅示例代码但仍保持可读性: 抽离 render/reset 函数,避免在 handleEvent 分支堆叠大量 DOM 代码.
- 尽量复用现有 addSystemMessage/logEvent/escapeHtml 等工具函数.
- 所有新增 DOM id/class 必须在 index.html/app.js/style.css 三者一致.
