# 需求文档: MCP 设置界面添加服务管理入口

## 1. 项目现状与核心目标

### 现状

当前系统有两个独立的 MCP 相关界面:

| 界面            | 位置                                           | 进入方式                | 功能                                         |
| --------------- | ---------------------------------------------- | ----------------------- | -------------------------------------------- |
| MCPConfigScreen | `source/ui/pages/MCPConfigScreen.tsx`          | 欢迎界面 -> "MCP 设置"  | 配置外部 MCP 服务器的 JSON 文件(全局/项目级) |
| MCPInfoPanel    | `source/ui/components/panels/MCPInfoPanel.tsx` | 对话界面 -> 输入 `/mcp` | 查看服务状态、启用/禁用内置 MCP 服务         |

### 核心目标

在 MCPConfigScreen 中添加一个入口,使用户可以直接打开 MCPInfoPanel 管理服务状态,无需先进入对话界面输入 `/mcp` 命令。从 MCPInfoPanel 返回时,返回到 MCPConfigScreen 而非对话界面。

## 2. 范围与边界

### 功能点

- [ ] **在 MCPConfigScreen 添加新选项**

  - 新增选项 "MCP 服务管理" (位于现有 "全局配置" 和 "项目配置" 选项之后)
  - 文案使用 i18n key: `mcpConfigScreen.manageServices` (需在 zh.ts/en.ts/zh-TW.ts 中添加)
  - 选中此选项后,打开 MCPInfoPanel 界面
  - 键盘操作: 上下箭头循环选择(到顶再按上回到底部,到底再按下回到顶部),Enter 确认打开
  - 从 2 项扩展到 3 项后,保持循环选择逻辑

- [ ] **MCPInfoPanel 从 MCPConfigScreen 打开时的返回逻辑**

  - 通过 `source` 参数区分打开来源: `source: 'mcpConfig' | 'chat'`
  - 来源为 `mcpConfig` 时: 按 Esc 返回 MCPConfigScreen
  - 来源为 `chat` 时: 按 Esc 返回 ChatScreen(保持现有逻辑)
  - MCPInfoPanel 打开期间,Esc 事件由其优先处理,不传递给外层
  - 返回 MCPConfigScreen 时,保持原来的选择状态(selectedScope 不变)

- [ ] **MCPConfigScreen 保留现有功能**
  - 全局配置选项保持不变
  - 项目配置选项保持不变
  - 当 MCPInfoPanel 未打开时,Esc 返回欢迎界面的逻辑保持不变
  - 当 MCPInfoPanel 打开时,Esc 优先关闭面板而非返回欢迎界面

### 技术实现约束

- **打开方式**: MCPConfigScreen 通过设置 `showMcpPanel(true)` 并传递 `source: 'mcpConfig'` 参数打开 MCPInfoPanel
- **状态管理**: 在 `usePanelState` 中增加 `mcpPanelSource` 状态,记录面板打开来源
- **Esc 优先级**: MCPInfoPanel 的 `useInput` 拦截 Esc 事件,返回时根据 `source` 决定行为
- **组件复用**: MCPInfoPanel 保持现有实现,通过 props 接收 `source` 和 `onClose` 回调

### 排除项

- 不修改 MCPInfoPanel 的核心功能(显示服务列表、Tab 切换启用状态、Enter 刷新等)
- 不修改 `/mcp` 命令的注册和触发逻辑
- 不修改外部 MCP 配置文件的格式和存储位置
- 不在 MCPConfigScreen 入口处预加载 MCP 服务状态(延迟到打开面板时加载)

## 3. 举例覆盖需求和边缘情况

### 例 1: 正常流程 - 从 MCP 设置打开服务管理

**场景**: 用户想查看和启用/禁用内置 MCP 服务

**操作步骤**:

1. 用户在欢迎界面选择 "MCP 设置"
2. 进入 MCPConfigScreen,看到三个选项:
   - 全局配置
   - 项目配置
   - MCP 服务管理 (新增)
3. 用户按向下键选中 "MCP 服务管理"
4. 按 Enter 打开 MCPInfoPanel
5. 用户看到服务列表,按 Tab 禁用某个服务
6. 用户按 Esc 返回 MCPConfigScreen
7. 再按 Esc 返回欢迎界面

**预期行为**:

- 步骤 6 返回 MCPConfigScreen 而非欢迎界面
- 步骤 7 才返回欢迎界面

### 例 2: 从对话界面打开服务管理(保持原有逻辑)

**场景**: 用户在对话中输入 `/mcp` 命令

**操作步骤**:

1. 用户在对话界面输入 `/mcp`
2. MCPInfoPanel 打开,显示服务状态
3. 用户按 Esc 关闭面板

**预期行为**:

- 返回对话界面(保持现有逻辑不变)
- 不受从 MCPConfigScreen 进入的返回逻辑影响

### 例 3: 在 MCPInfoPanel 中操作后返回

**场景**: 用户在服务管理界面禁用服务后返回

**操作步骤**:

1. 从 MCPConfigScreen 进入 MCPInfoPanel
2. 用户选中某个服务,按 Tab 禁用它
3. 按 Esc 返回 MCPConfigScreen
4. 再次进入 MCPInfoPanel 查看,确认服务已禁用

**预期行为**:

- 步骤 3 正确返回到 MCPConfigScreen
- 禁用状态已保存并生效

### 例 4: 多层返回边界

**场景**: 测试多层返回逻辑

**操作步骤**:

1. 欢迎界面 -> MCP 设置 (MCPConfigScreen)
2. MCP 设置 -> 服务管理 (MCPInfoPanel)
3. 服务管理 -> 返回 (按 Esc)
4. 再返回 (按 Esc)

**预期行为**:

- 步骤 3 返回到 MCPConfigScreen
- 步骤 4 返回到欢迎界面

### 例 5: 不保存配置直接返回

**场景**: 用户进入服务管理但不做任何更改

**操作步骤**:

1. 进入 MCPConfigScreen
2. 进入 MCPInfoPanel
3. 查看服务状态,不做操作
4. 按 Esc 返回 MCPConfigScreen
5. 再按 Esc 返回欢迎界面

**预期行为**:

- 无异常,流程正常
- 服务状态保持不变

### 例 6: 从 MCPInfoPanel 返回后配置选项保持选中状态

**场景**: 用户从服务管理返回后,应回到之前的配置界面状态

**操作步骤**:

1. 进入 MCPConfigScreen,当前选中 "项目配置"
2. 按向下键选中 "MCP 服务管理"
3. 按 Enter 打开 MCPInfoPanel
4. 查看服务状态后按 Esc 返回

**预期行为**:

- 返回到 MCPConfigScreen 时,选中项仍为 "MCP 服务管理"(而非重置到第一项)
- 用户可以立即再次 Enter 打开,或按上下键选择其他选项

### 例 7: i18n 文本显示

**场景**: 不同语言环境下正确显示

**操作步骤**:

1. 系统语言为中文时,进入 MCPConfigScreen
2. 看到第三个选项显示 "MCP 服务管理"
3. 切换系统语言为英文,重新进入
4. 看到第三个选项显示 "Manage MCP Services"(假设英文翻译)

**预期行为**:

- 所有文案通过 i18n 系统获取
- 新增 key `mcpConfigScreen.manageServices` 在各语言文件中定义

## 4. i18n 新增 Key

| Key                                  | 中文                     | 英文                                 | 繁体中文                 |
| ------------------------------------ | ------------------------ | ------------------------------------ | ------------------------ |
| `mcpConfigScreen.manageServices`     | MCP 服务管理             | Manage MCP Services                  | MCP 服務管理             |
| `mcpConfigScreen.manageServicesDesc` | 查看和启用/禁用 MCP 服务 | View and enable/disable MCP services | 查看和啟用/停用 MCP 服務 |

## 5. 界面导航关系图

### 现有导航关系

```
WelcomeScreen
    |
    | (选择 MCP 设置)
    v
MCPConfigScreen --(Esc)--> WelcomeScreen
    |
    X (无直接导航到 MCPInfoPanel)

ChatScreen --(/mcp 命令)--> MCPInfoPanel --(Esc)--> ChatScreen
```

### 期望导航关系

```
WelcomeScreen
    |
    | (选择 MCP 设置)
    v
MCPConfigScreen --(Esc)--> WelcomeScreen
    |
    | (选择 MCP 服务管理 + Enter)
    v
MCPInfoPanel --(Esc)--> MCPConfigScreen

ChatScreen --(/mcp 命令)--> MCPInfoPanel --(Esc)--> ChatScreen
```

**关键**: MCPInfoPanel 需要根据打开来源决定返回目标:

- 来源 = MCPConfigScreen -> 返回 MCPConfigScreen
- 来源 = ChatScreen (/mcp) -> 返回 ChatScreen
