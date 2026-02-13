# CurrentTaskPlan: MCPConfigScreen 添加服务管理入口并按 source 返回

## 需求来源
- 需求文档: requirements/MCP设置界面添加服务管理入口.md

## 目标
1. 在 MCPConfigScreen 中新增第 3 个菜单项 "MCP 服务管理",可直接打开 MCPInfoPanel.
2. MCPInfoPanel 支持来源区分:
   - source='chat': 保持 /mcp 现有行为,Esc 关闭后回到 ChatScreen.
   - source='mcpConfig': 从 MCP 设置页进入,Esc 关闭后回到 MCPConfigScreen,且保留 MCPConfigScreen 选中态.
3. i18n 新增 key: mcpConfigScreen.manageServices(及可选 desc).

## 架构设计(最小侵入式)

### 关键约束
- /mcp 命令注册和触发逻辑不改.
- MCPInfoPanel 核心功能不改,仅增加关闭/返回的可配置行为.
- 面板来源(source)只存在于 UI 状态层,不进入执行层(mcpToolsManager 等).

### 推荐状态与 props 方案
1. usePanelState 增加状态:
   - mcpPanelSource: 'chat' | 'mcpConfig'
   - 并提供 setMcpPanelSource.
   - 约定: setShowMcpPanel(true) 之前必须先设置 source.
2. PanelsManager 承担 MCPInfoPanel 的 props 透传:
   - <MCPInfoPanel source={mcpPanelSource} onClose={() => setShowMcpPanel(false)} />
   - 这样 ChatScreen / MCPConfigScreen 不需要了解 MCPInfoPanel 的内部实现细节.
3. MCPInfoPanel 增加 props:
   - source?: 'chat' | 'mcpConfig' (默认 'chat')
   - onClose?: () => void (默认行为: 调用 usePanelState.setShowMcpPanel(false) 的旧逻辑不可再在组件内硬编码,应由外部注入)
   - 在 useInput 内部优先拦截 key.escape,并调用 onClose().

### Screen 侧行为
- ChatScreen:
  - /mcp 命令执行后,在 setShowMcpPanel(true) 前设置 mcpPanelSource='chat'.
  - Esc 关闭逻辑: 仍由 panelState.handleEscapeKey 主导,但 MCPInfoPanel 自己也会拦截 Esc 并触发 onClose,避免事件传递导致二次行为.
- MCPConfigScreen:
  - 新增第 3 个选项,Enter 时:
    - panelState.setMcpPanelSource('mcpConfig')
    - panelState.setShowMcpPanel(true)
  - Esc 行为:
    - 若 showMcpPanel 为 true,不执行 onBack,交给 MCPInfoPanel onClose.
    - 若 showMcpPanel 为 false,保持原行为 onBack().

## 实施步骤(建议按顺序提交)

### 1. i18n
- 修改: source/i18n/lang/zh.ts,en.ts,zh-TW.ts
- 新增:
  - mcpConfigScreen.manageServices
  - (可选) mcpConfigScreen.manageServicesDesc

### 2. UI 状态层
- 修改: source/hooks/ui/usePanelState.ts
- 增加:
  - mcpPanelSource 状态与 setter
  - handleEscapeKey 中关闭 showMcpPanel 时,保留 source 不变或重置为 'chat'(二选一,建议关闭时重置为 'chat' 以避免脏状态)

### 3. PanelsManager 透传 props
- 修改: source/ui/components/panels/PanelsManager.tsx
- MCPInfoPanel 调用改为传 source/onClose.

### 4. MCPInfoPanel 支持 Esc 优先关闭
- 修改: source/ui/components/panels/MCPInfoPanel.tsx
- 新增 props,并在 useInput 内部:
  - if (key.escape) { onClose?.(); return; }
- 注意: 需保证 escape 分支在其它键处理之前,以获得最高优先级.

### 5. MCPConfigScreen 增加入口
- 修改: source/ui/pages/MCPConfigScreen.tsx
- 要点:
  - selectedScope 扩展为 union: 'global' | 'project' | 'manageServices'
  - 上下键循环选择 3 项.
  - Enter: 若是 manageServices,打开 MCPInfoPanel.

### 6. ChatScreen 的 /mcp 触发处设置 source
- 修改: source/hooks/conversation/useCommandHandler.ts 或 ChatScreen.tsx(取决于 action 分发位置)
- 在处理 action === 'showMcpPanel' 时,设置:
  - panelState.setMcpPanelSource('chat')
  - panelState.setShowMcpPanel(true)

## 验收清单
- WelcomeScreen -> MCP 设置 -> 可看到 3 个选项,上下键循环选择无断档.
- 在 MCPConfigScreen 选中 "MCP 服务管理" Enter:
  - MCPInfoPanel 打开.
  - Esc 返回 MCPConfigScreen,选中态仍停留在 "MCP 服务管理".
  - 再次 Esc 返回 WelcomeScreen.
- ChatScreen 输入 /mcp:
  - MCPInfoPanel 打开.
  - Esc 返回 ChatScreen.
- MCPInfoPanel 打开期间:
  - Esc 只关闭面板,不会触发外层 screen 的 onBack.

## 风险点与回归
- Ink 的 useInput 会多处同时监听同一按键,必须确保 MCPInfoPanel 的 ESC 分支 return,且 PanelsManager/ChatScreen 的 ESC 处理不会产生二次关闭副作用.
- 如果 usePanelState.handleEscapeKey 仍关闭 showMcpPanel,且 MCPInfoPanel 同时关闭,应保证幂等(关闭已关闭的 panel 不引发异常).
