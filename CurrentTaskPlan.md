# 角色定义命名规范调整 - 实施计划

## 项目概述

统一主代理和子代理的角色定义变量命名，提升代码可读性与可维护性，避免与全局系统提示词 `systemPrompt` 混淆。

### 目标

- 主代理角色定义: `systemPrompt` → `mainAgentRole`
- 子代理角色定义: `role` → `subAgentRole`
- 保留全局系统提示词的 `systemPrompt` 命名不变

### 实施策略

**破坏性更新**: 不提供向后兼容，旧字段名直接报错，用户需重新配置。

---

## 实施阶段详解

### 阶段 1: 修改类型定义

**目标**: 修改 TypeScript 接口定义，为后续代码变更提供类型支持。

#### 1.1 修改主代理配置接口

**文件**: `source/types/MainAgentConfig.ts`

**位置**: Line 46

**修改内容**:
```typescript
// 修改前
export interface MainAgentConfig {
  basicInfo: MainAgentBasicInfo;
  tools: string[];
  availableSubAgents: string[];
  systemPrompt: string;  // ← 改为 mainAgentRole
}

// 修改后
export interface MainAgentConfig {
  basicInfo: MainAgentBasicInfo;
  tools: string[];
  availableSubAgents: string[];
  mainAgentRole: string;  // ← 新命名
}
```

#### 1.2 修改子代理配置接口

**文件**: `source/utils/config/subAgentConfig.ts`

**位置**: Line 19

**修改内容**:
```typescript
// 修改前
export interface SubAgent {
  id: string;
  name: string;
  description: string;
  systemPrompt?: string;
  tools?: string[];
  role?: string;  // ← 改为 subAgentRole
  createdAt?: string;
  updatedAt?: string;
  builtin?: boolean;
  configProfile?: string;
}

// 修改后
export interface SubAgent {
  id: string;
  name: string;
  description: string;
  systemPrompt?: string;
  tools?: string[];
  subAgentRole?: string;  // ← 新命名
  createdAt?: string;
  updatedAt?: string;
  builtin?: boolean;
  configProfile?: string;
}
```

#### 1.3 修改 updateSubAgent 函数参数类型

**文件**: `source/utils/config/subAgentConfig.ts`

**位置**: Line 738

**修改内容**:
```typescript
// 修改前
export function updateSubAgent(
  id: string,
  updates: {
    name?: string;
    description?: string;
    role?: string;  // ← 改为 subAgentRole
    tools?: string[];
    configProfile?: string;
    customSystemPrompt?: string;
    customHeaders?: Record<string, string>;
  },
): SubAgent | null

// 修改后
export function updateSubAgent(
  id: string,
  updates: {
    name?: string;
    description?: string;
    subAgentRole?: string;  // ← 新命名
    tools?: string[];
    configProfile?: string;
    customSystemPrompt?: string;
    customHeaders?: Record<string, string>;
  },
): SubAgent | null
```

---

### 阶段 2: 修改内置主代理配置

**目标**: 更新 5 个内置主代理配置文件的字段名。

#### 2.1 General 主代理配置

**文件**: `source/config/mainAgents/generalConfig.ts`

**位置**: Line 67

**修改内容**:
```typescript
// 修改前
export function getSnowGeneralConfig(): MainAgentConfig {
  return {
    basicInfo: { /* ... */ },
    tools: GENERAL_TOOLS,
    availableSubAgents: GENERAL_SUB_AGENTS,
    systemPrompt: `你是Snow AI CLI,一个工作在命令行环境中的智能助手。...`,  // ← 改为 mainAgentRole
  };
}

// 修改后
export function getSnowGeneralConfig(): MainAgentConfig {
  return {
    basicInfo: { /* ... */ },
    tools: GENERAL_TOOLS,
    availableSubAgents: GENERAL_SUB_AGENTS,
    mainAgentRole: `你是Snow AI CLI,一个工作在命令行环境中的智能助手。...`,  // ← 新命名
  };
}
```

#### 2.2 Leader 主代理配置

**文件**: `source/config/mainAgents/leaderConfig.ts`

**位置**: Line 60

**修改内容**:
```typescript
systemPrompt: `你是Snow AI CLI, 一个工作在命令行环境中的Agent团队的领导者。...`
// ↓
mainAgentRole: `你是Snow AI CLI, 一个工作在命令行环境中的Agent团队的领导者。...`
```

#### 2.3 Debugger 主代理配置

**文件**: `source/config/mainAgents/debuggerConfig.ts`

**位置**: Line 66

**修改内容**:
```typescript
systemPrompt: `你是 Snow AI CLI - Debugger,一个专门的调试代理,专注于定位和修复代码问题.`
// ↓
mainAgentRole: `你是 Snow AI CLI - Debugger,一个专门的调试代理,专注于定位和修复代码问题.`
```

#### 2.4 Requirement Analyzer 主代理配置

**文件**: `source/config/mainAgents/requirementAnalyzerConfig.ts`

**位置**: Line 67

**修改内容**:
```typescript
systemPrompt: `你是 Snow AI CLI - Requirement Analyzer,一个专门的需求分析代理,...`
// ↓
mainAgentRole: `你是 Snow AI CLI - Requirement Analyzer,一个专门的需求分析代理,...`
```

#### 2.5 Vulnerability Hunter 主代理配置

**文件**: `source/config/mainAgents/vulnerabilityHunterConfig.ts`

**位置**: Line 68

**修改内容**:
```typescript
systemPrompt: `你是 Snow AI CLI - Vulnerability Hunter,一个专门的安全分析代理,...`
// ↓
mainAgentRole: `你是 Snow AI CLI - Vulnerability Hunter,一个专门的安全分析代理,...`
```

---

### 阶段 3: 修改内置子代理配置

**目标**: 更新 `BUILTIN_AGENTS` 数组中所有内置子代理的 `role` 字段。

**文件**: `source/utils/config/subAgentConfig.ts`

**位置**: Lines 58-514 (BUILTIN_AGENTS 数组)

#### 3.1 agent_explore 配置

**位置**: Line 64

**修改内容**:
```typescript
{
  id: 'agent_explore',
  name: 'Explore Agent',
  description: 'Specialized for quickly exploring and understanding codebases...',
  role: `# Code Exploration Specialist...`,  // ← 改为 subAgentRole
  tools: [/* ... */],
  builtin: true,
}
// ↓
{
  id: 'agent_explore',
  name: 'Explore Agent',
  description: 'Specialized for quickly exploring and understanding codebases...',
  subAgentRole: `# Code Exploration Specialist...`,  // ← 新命名
  tools: [/* ... */],
  builtin: true,
}
```

#### 3.2 agent_plan 配置

**位置**: Line 159

**修改内容**:
```typescript
role: `# Task Planning Specialist...`
// ↓
subAgentRole: `# Task Planning Specialist...`
```

#### 3.3 agent_general 配置

**位置**: Line 311

**修改内容**:
```typescript
role: `# General Purpose Task Executor...`
// ↓
subAgentRole: `# General Purpose Task Executor...`
```

---

### 阶段 4: 修改核心使用逻辑

**目标**: 更新运行时读取和使用角色定义的核心逻辑。

#### 4.1 主代理管理器 - generateCleanSystemPrompt 函数

**文件**: `source/utils/MainAgentManager.ts`

**位置**: Lines 305-320

**修改内容**:
```typescript
// 修改前
private generateCleanSystemPrompt(config: MainAgentConfig): string {
  const {systemPrompt} = config;  // ← 改为 mainAgentRole

  // 创建基础提示词
  let prompt = systemPrompt;  // ← 改为 mainAgentRole

  // 添加 AGENTS.md 内容
  const agentsPrompt = getAgentsPrompt();
  if (agentsPrompt) {
    prompt += '\n\n' + agentsPrompt;
  }

  // 添加环境上下文信息
  const contextInfo = createSystemContext();
  if (contextInfo) {
    prompt += '\n\n' + contextInfo;
  }

  return prompt;
}

// 修改后
private generateCleanSystemPrompt(config: MainAgentConfig): string {
  const {mainAgentRole} = config;  // ← 新命名

  // 创建基础提示词
  let prompt = mainAgentRole;  // ← 新命名

  // 添加 AGENTS.md 内容
  const agentsPrompt = getAgentsPrompt();
  if (agentsPrompt) {
    prompt += '\n\n' + agentsPrompt;
  }

  // 添加环境上下文信息
  const contextInfo = createSystemContext();
  if (contextInfo) {
    prompt += '\n\n' + contextInfo;
  }

  return prompt;
}
```

#### 4.2 子代理执行器 - 提示词构建逻辑

**文件**: `source/utils/execution/subAgentExecutor.ts`

**位置**: Lines 831-837

**修改内容**:
```typescript
// 修改前
// Build final prompt with 子代理配置role + AGENTS.md + 系统环境 + 平台指导
let finalPrompt = prompt;

// Append agent-specific role if configured
if (agent.role) {  // ← 改为 subAgentRole
  finalPrompt = `${finalPrompt}\n\n${agent.role}`;  // ← 改为 subAgentRole
}
// Append AGENTS.md content if available
const agentsPrompt = getAgentsPrompt();
if (agentsPrompt) {
  finalPrompt = `${finalPrompt}\n\n${agentsPrompt}`;
}

// 修改后
// Build final prompt with 子代理配置subAgentRole + AGENTS.md + 系统环境 + 平台指导
let finalPrompt = prompt;

// Append agent-specific role if configured
if (agent.subAgentRole) {  // ← 新命名
  finalPrompt = `${finalPrompt}\n\n${agent.subAgentRole}`;  // ← 新命名
}
// Append AGENTS.md content if available
const agentsPrompt = getAgentsPrompt();
if (agentsPrompt) {
  finalPrompt = `${finalPrompt}\n\n${agentsPrompt}`;
}
```

---

### 阶段 5: 修改配置管理逻辑

**目标**: 更新配置更新函数中的字段引用。

**文件**: `source/utils/config/subAgentConfig.ts`

**函数**: `updateSubAgent`

#### 5.1 内置代理用户副本赋值逻辑

**位置**: Line 766

**修改内容**:
```typescript
// 修改前
const userCopy: SubAgent = {
  id: agent.id,
  name: updates.name ?? existingUserCopy?.name ?? agent.name,
  description: updates.description ?? existingUserCopy?.description ?? agent.description,
  role: updates.role ?? existingUserCopy?.role ?? agent.role,  // ← 改为 subAgentRole
  tools: updates.tools ?? existingUserCopy?.tools ?? agent.tools,
  createdAt: existingUserCopy?.createdAt ?? agent.createdAt ?? now,
  updatedAt: now,
  builtin: true,
};

// 修改后
const userCopy: SubAgent = {
  id: agent.id,
  name: updates.name ?? existingUserCopy?.name ?? agent.name,
  description: updates.description ?? existingUserCopy?.description ?? agent.description,
  subAgentRole: updates.subAgentRole ?? existingUserCopy?.subAgentRole ?? agent.subAgentRole,  // ← 新命名
  tools: updates.tools ?? existingUserCopy?.tools ?? agent.tools,
  createdAt: existingUserCopy?.createdAt ?? agent.createdAt ?? now,
  updatedAt: now,
  builtin: true,
};
```

#### 5.2 普通代理更新逻辑

**位置**: Line 802

**修改内容**:
```typescript
// 修改前
const updatedAgent: SubAgent = {
  id: existingAgent.id,
  name: updates.name ?? existingAgent.name,
  description: updates.description ?? existingAgent.description,
  role: updates.role ?? existingAgent.role,  // ← 改为 subAgentRole
  tools: updates.tools ?? existingAgent.tools,
  createdAt: existingAgent.createdAt,
  updatedAt: now,
  builtin: existingAgent.builtin,
};

// 修改后
const updatedAgent: SubAgent = {
  id: existingAgent.id,
  name: updates.name ?? existingAgent.name,
  description: updates.description ?? existingAgent.description,
  subAgentRole: updates.subAgentRole ?? existingAgent.subAgentRole,  // ← 新命名
  tools: updates.tools ?? existingAgent.tools,
  createdAt: existingAgent.createdAt,
  updatedAt: now,
  builtin: existingAgent.builtin,
};
```

---

### 阶段 6: 修改 UI 界面

**目标**: 更新两个配置界面的字段引用和状态管理。

#### 6.1 主代理配置界面

**文件**: `source/ui/pages/MainAgentConfigScreen.tsx`

##### 6.1.1 FormField 类型定义

**位置**: Lines 75-80

**修改内容**:
```typescript
// 修改前
type FormField =
  | 'name'
  | 'description'
  | 'systemPrompt'  // ← 改为 mainAgentRole
  | 'tools'
  | 'subAgents';

// 修改后
type FormField =
  | 'name'
  | 'description'
  | 'mainAgentRole'  // ← 新命名
  | 'tools'
  | 'subAgents';
```

##### 6.1.2 useState 状态声明

**位置**: Lines 92-93

**修改内容**:
```typescript
// 修改前
const [systemPrompt, setSystemPrompt] = useState('');
const [systemPromptExpanded, setSystemPromptExpanded] = useState(false);

// 修改后
const [mainAgentRole, setMainAgentRole] = useState('');
const [mainAgentRoleExpanded, setMainAgentRoleExpanded] = useState(false);
```

##### 6.1.3 loadAgent 函数 - 默认值设置

**位置**: Lines 189-190

**修改内容**:
```typescript
// 修改前
setAgentName('');
setDescription('');
setSystemPrompt(
  '你是Snow AI CLI自定义主代理。\n\n请根据用户需求提供帮助。',
);
setSelectedTools(new Set());
setSelectedSubAgents(new Set());

// 修改后
setAgentName('');
setDescription('');
setMainAgentRole(
  '你是Snow AI CLI自定义主代理。\n\n请根据用户需求提供帮助。',
);
setSelectedTools(new Set());
setSelectedSubAgents(new Set());
```

##### 6.1.4 loadAgent 函数 - 加载现有配置

**位置**: Line 220

**修改内容**:
```typescript
// 修改前
setSystemPrompt(agent.systemPrompt || '');

// 修改后
setMainAgentRole(agent.mainAgentRole || '');
```

##### 6.1.5 handleSave 函数 - baseAgent 初始化

**位置**: Line 644

**修改内容**:
```typescript
// 修改前
const baseAgent: MainAgentConfig = {
  basicInfo: {
    name: '',
    description: '',
    type: 'general',
    builtin: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  tools: [],
  availableSubAgents: [],
  systemPrompt: '',  // ← 改为 mainAgentRole
};

// 修改后
const baseAgent: MainAgentConfig = {
  basicInfo: {
    name: '',
    description: '',
    type: 'general',
    builtin: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  tools: [],
  availableSubAgents: [],
  mainAgentRole: '',  // ← 新命名
};
```

##### 6.1.6 handleSave 函数 - updatedAgent 赋值

**位置**: Lines 661, 681

**修改内容**:
```typescript
// 修改前
const updatedAgent: MainAgentConfig = {
  basicInfo: { /* ... */ },
  tools: validTools,
  availableSubAgents: validSubAgents,
  systemPrompt: systemPrompt,  // ← 改为 mainAgentRole
};

// 修改后
const updatedAgent: MainAgentConfig = {
  basicInfo: { /* ... */ },
  tools: validTools,
  availableSubAgents: validSubAgents,
  mainAgentRole: mainAgentRole,  // ← 新命名
};
```

##### 6.1.7 handleSave 函数 - useEffect 依赖数组

**位置**: Lines 681

**修改内容**:
```typescript
// 修改前
}, [
  agentName,
  description,
  systemPrompt,  // ← 改为 mainAgentRole
  selectedTools,
  selectedSubAgents,
  agentId,
  onSave,
]);

// 修改后
}, [
  agentName,
  description,
  mainAgentRole,  // ← 新命名
  selectedTools,
  selectedSubAgents,
  agentId,
  onSave,
]);
```

##### 6.1.8 字段导航逻辑

**位置**: Lines 709, 716, 732, 754

**修改内容**:
```typescript
// 修改前
// ↑↓键: 在主字段间导航
if (input === 'ArrowDown') {
  const fields: FormField[] = ['name', 'description', 'systemPrompt', 'subAgents', 'tools'];
  const currentIndex = fields.indexOf(currentField);
  if (currentIndex < fields.length - 1) {
    setCurrentField(fields[currentIndex + 1]);
  }
}
// ... 其他导航逻辑

// 修改后
// ↑↓键: 在主字段间导航
if (input === 'ArrowDown') {
  const fields: FormField[] = ['name', 'description', 'mainAgentRole', 'subAgents', 'tools'];
  const currentIndex = fields.indexOf(currentField);
  if (currentIndex < fields.length - 1) {
    setCurrentField(fields[currentIndex + 1]);
  }
}
// ... 其他导航逻辑
```

##### 6.1.9 展开切换逻辑

**位置**: Lines 795-796

**修改内容**:
```typescript
// 修改前
if (currentField === 'systemPrompt' && input === ' ') {
  setSystemPromptExpanded(prev => !prev);
}

// 修改后
if (currentField === 'mainAgentRole' && input === ' ') {
  setMainAgentRoleExpanded(prev => !prev);
}
```

##### 6.1.10 UI 渲染 - 字段判断和显示

**位置**: Lines 1173-1207

**修改内容**:
```typescript
// 修改前
{/* MainAgentRole / systemPrompt */}
{currentField === 'systemPrompt' && (
  <Box flexDirection="column">
    <Box>
      <Text color={theme.secondary}>
        {t.mainAgentConfig.mainAgentRole}
      </Text>
      <Text color={theme.secondary} dimColor>
        {t.mainAgentConfig.mainAgentRoleHint}
      </Text>
    </Box>
    {systemPrompt && systemPrompt.length > 100 && (
      <Box>
        <Text color={theme.secondary}>
          {systemPromptExpanded
            ? t.mainAgentConfig.collapsed
            : t.mainAgentConfig.expanded}
        </Text>
      </Box>
    )}
    {systemPrompt && systemPrompt.length > 100 && !systemPromptExpanded ? (
      <Text>{systemPrompt.substring(0, 100)}...</Text>
    ) : (
      <TextInput
        value={systemPrompt}
        onChange={value => setSystemPrompt(stripFocusArtifacts(value))}
        placeholder={t.mainAgentConfig.mainAgentRolePlaceholder}
        focus={currentField === 'systemPrompt'}
        multiline
      />
    )}
  </Box>
)}

// 修改后
{/* MainAgentRole */}
{currentField === 'mainAgentRole' && (
  <Box flexDirection="column">
    <Box>
      <Text color={theme.secondary}>
        {t.mainAgentConfig.mainAgentRole}
      </Text>
      <Text color={theme.secondary} dimColor>
        {t.mainAgentConfig.mainAgentRoleHint}
      </Text>
    </Box>
    {mainAgentRole && mainAgentRole.length > 100 && (
      <Box>
        <Text color={theme.secondary}>
          {mainAgentRoleExpanded
            ? t.mainAgentConfig.collapsed
            : t.mainAgentConfig.expanded}
        </Text>
      </Box>
    )}
    {mainAgentRole && mainAgentRole.length > 100 && !mainAgentRoleExpanded ? (
      <Text>{mainAgentRole.substring(0, 100)}...</Text>
    ) : (
      <TextInput
        value={mainAgentRole}
        onChange={value => setMainAgentRole(stripFocusArtifacts(value))}
        placeholder={t.mainAgentConfig.mainAgentRolePlaceholder}
        focus={currentField === 'mainAgentRole'}
        multiline
      />
    )}
  </Box>
)}
```

#### 6.2 子代理配置界面

**文件**: `source/ui/pages/SubAgentConfigScreen.tsx`

##### 6.2.1 FormField 类型定义

**位置**: Line 76

**修改内容**:
```typescript
// 修改前
type FormField = 'name' | 'description' | 'role' | 'configProfile' | 'tools';

// 修改后
type FormField = 'name' | 'description' | 'subAgentRole' | 'configProfile' | 'tools';
```

##### 6.2.2 useState 状态声明

**位置**: Lines 88-89

**修改内容**:
```typescript
// 修改前
const [role, setRole] = useState('');
const [roleExpanded, setRoleExpanded] = useState(false);

// 修改后
const [subAgentRole, setSubAgentRole] = useState('');
const [subAgentRoleExpanded, setSubAgentRoleExpanded] = useState(false);
```

##### 6.2.3 loadAgent 函数

**位置**: Line 217

**修改内容**:
```typescript
// 修改前
setAgentName(agent.name);
setDescription(agent.description);
setRole(agent.role || '');

// 修改后
setAgentName(agent.name);
setDescription(agent.description);
setSubAgentRole(agent.subAgentRole || '');
```

##### 6.2.4 handleSave 函数 - createSubAgent 调用

**位置**: Lines 443, 455

**修改内容**:
```typescript
// 修改前
createSubAgent({
  name: agentName,
  description,
  role: role || undefined,  // ← 改为 subAgentRole
  tools: Array.from(selectedTools),
  configProfile: selectedConfigProfileIndex >= 0
    ? availableProfiles[selectedConfigProfileIndex]
    : undefined,
});

// 修改后
createSubAgent({
  name: agentName,
  description,
  subAgentRole: subAgentRole || undefined,  // ← 新命名
  tools: Array.from(selectedTools),
  configProfile: selectedConfigProfileIndex >= 0
    ? availableProfiles[selectedConfigProfileIndex]
    : undefined,
});
```

##### 6.2.5 handleSave 函数 - updateSubAgent 调用

**位置**: Line 473

**修改内容**:
```typescript
// 修改前
updateSubAgent(agentId, {
  name: agentName,
  description,
  role: role || undefined,  // ← 改为 subAgentRole
  tools: Array.from(selectedTools),
  configProfile: selectedConfigProfileIndex >= 0
    ? availableProfiles[selectedConfigProfileIndex]
    : undefined,
});

// 修改后
updateSubAgent(agentId, {
  name: agentName,
  description,
  subAgentRole: subAgentRole || undefined,  // ← 新命名
  tools: Array.from(selectedTools),
  configProfile: selectedConfigProfileIndex >= 0
    ? availableProfiles[selectedConfigProfileIndex]
    : undefined,
});
```

##### 6.2.6 字段导航逻辑

**位置**: Lines 501, 513, 527

**修改内容**:
```typescript
// 修改前
// ↑↓键: 在主字段间导航 (name → description → role → configProfile → tools)
if (input === 'ArrowDown') {
  const fields: FormField[] = ['name', 'description', 'role', 'configProfile', 'tools'];
  const currentIndex = fields.indexOf(currentField);
  if (currentIndex < fields.length - 1) {
    setCurrentField(fields[currentIndex + 1]);
  }
}
// ... 其他导航逻辑

// 修改后
// ↑↓键: 在主字段间导航 (name → description → subAgentRole → configProfile → tools)
if (input === 'ArrowDown') {
  const fields: FormField[] = ['name', 'description', 'subAgentRole', 'configProfile', 'tools'];
  const currentIndex = fields.indexOf(currentField);
  if (currentIndex < fields.length - 1) {
    setCurrentField(fields[currentIndex + 1]);
  }
}
// ... 其他导航逻辑
```

##### 6.2.7 展开切换逻辑

**位置**: Lines 594-596

**修改内容**:
```typescript
// 修改前
// Role field controls - Space to toggle expansion
if (currentField === 'role' && input === ' ') {
  setRoleExpanded(prev => !prev);
}

// 修改后
// SubAgentRole field controls - Space to toggle expansion
if (currentField === 'subAgentRole' && input === ' ') {
  setSubAgentRoleExpanded(prev => !prev);
}
```

##### 6.2.8 UI 渲染 - Role 字段

**位置**: Lines 965-1002

**修改内容**:
```typescript
// 修改前
{/* Role */}
{currentField === 'role' && (
  <Box flexDirection="column">
    <Box>
      <Text color={theme.secondary}>
        {t.subAgentConfig.roleOptional}
      </Text>
      {role && role.length > 100 && (
        <Box>
          <Text color={theme.secondary}>
            {t.subAgentConfig.roleExpandHint.replace(
              '{state}',
              roleExpanded
                ? t.subAgentConfig.roleExpanded
                : t.subAgentConfig.roleCollapsed,
            )}
          </Text>
        </Box>
      )}
    </Box>
    {role && role.length > 100 && !roleExpanded ? (
      <Box>
        <Text>{role.substring(0, 100)}...</Text>
        <Text color={theme.primary}>{t.subAgentConfig.roleViewFull}</Text>
      </Box>
    ) : (
      <TextInput
        value={role}
        onChange={value => setRole(stripFocusArtifacts(value))}
        placeholder={t.subAgentConfig.rolePlaceholder}
        focus={currentField === 'role'}
        multiline
      />
    )}
  </Box>
)}

// 修改后
{/* SubAgentRole */}
{currentField === 'subAgentRole' && (
  <Box flexDirection="column">
    <Box>
      <Text color={theme.secondary}>
        {t.subAgentConfig.roleOptional}
      </Text>
      {subAgentRole && subAgentRole.length > 100 && (
        <Box>
          <Text color={theme.secondary}>
            {t.subAgentConfig.roleExpandHint.replace(
              '{state}',
              subAgentRoleExpanded
                ? t.subAgentConfig.roleExpanded
                : t.subAgentConfig.roleCollapsed,
            )}
          </Text>
        </Box>
      )}
    </Box>
    {subAgentRole && subAgentRole.length > 100 && !subAgentRoleExpanded ? (
      <Box>
        <Text>{subAgentRole.substring(0, 100)}...</Text>
        <Text color={theme.primary}>{t.subAgentConfig.roleViewFull}</Text>
      </Box>
    ) : (
      <TextInput
        value={subAgentRole}
        onChange={value => setSubAgentRole(stripFocusArtifacts(value))}
        placeholder={t.subAgentConfig.rolePlaceholder}
        focus={currentField === 'subAgentRole'}
        multiline
      />
    )}
  </Box>
)}
```

---

### 阶段 7: 构建测试验证

**目标**: 确保所有修改通过编译并正常运行。

#### 7.1 运行构建命令

```bash
npm run build
```

**验证要点**:
- TypeScript 类型检查通过
- 没有编译错误
- 没有类型不匹配警告

#### 7.2 检查构建输出

- 确认构建成功
- 检查是否有 TypeScript 错误或警告
- 验证输出文件生成正常

#### 7.3 启动应用验证

```bash
# 启动应用进行手动测试
npm start
```

**测试步骤**:
1. 进入主代理配置界面
   - 验证所有内置主代理配置加载正常
   - 验证 `mainAgentRole` 字段显示正确
   - 验证编辑和保存功能正常

2. 进入子代理配置界面
   - 验证所有内置子代理配置加载正常
   - 验证 `subAgentRole` 字段显示正确
   - 验证编辑和保存功能正常

3. 创建新代理测试
   - 创建新的主代理，填写 `mainAgentRole`
   - 创建新的子代理，填写 `subAgentRole`
   - 验证保存和加载功能

4. 切换代理测试
   - 切换不同主代理，验证角色定义正确应用
   - 使用不同子代理，验证角色定义正确应用

---

## 重要注意事项

### 1. 破坏性更新

- **不提供向后兼容**: 旧字段名 `systemPrompt` 和 `role` 将直接报错
- **用户需重新配置**: 如果用户有自定义配置文件，需要手动更新字段名
- **旧配置文件失效**: 包含旧字段名的配置文件将无法加载

### 2. 全局系统提示词

- **保持不变**: `systemPrompt` 专指全局系统提示词系统
- **不涉及修改**: `source/utils/config/apiConfig.ts` 中的系统提示词配置不受影响
- **语义清晰**: 通过 `mainAgentRole` 和 `subAgentRole` 明确区分角色定义

### 3. 修改顺序

**必须严格按照以下顺序执行**:
1. 类型定义 (阶段 1)
2. 内置配置 (阶段 2-3)
3. 核心逻辑 (阶段 4)
4. 配置管理 (阶段 5)
5. UI 界面 (阶段 6)
6. 构建验证 (阶段 7)

**原因**: 后续阶段依赖前面的类型和配置修改。

### 4. 代码审核要点

- [ ] 所有类型定义字段名修改完整
- [ ] 所有内置配置字段名修改完整
- [ ] 核心逻辑字段引用全部更新
- [ ] UI 界面状态管理和渲染全部更新
- [ ] 没有遗漏的旧字段名引用
- [ ] 没有引入新的类型错误

### 5. 国际化文件

**本实施不涉及**: UI 界面的显示文本由国际化文件控制，字段内部变量名修改不影响显示文本。

**涉及文件** (仅供参考,无需修改):
- `source/i18n/lang/zh.ts`
- `source/i18n/lang/en.ts`
- `source/i18n/lang/zh-TW.ts`

---

## 文件修改清单

### 类型定义文件 (2 个)
- [ ] `source/types/MainAgentConfig.ts`
- [ ] `source/utils/config/subAgentConfig.ts` (SubAgent 接口)

### 内置主代理配置文件 (5 个)
- [ ] `source/config/mainAgents/generalConfig.ts`
- [ ] `source/config/mainAgents/leaderConfig.ts`
- [ ] `source/config/mainAgents/debuggerConfig.ts`
- [ ] `source/config/mainAgents/requirementAnalyzerConfig.ts`
- [ ] `source/config/mainAgents/vulnerabilityHunterConfig.ts`

### 核心逻辑文件 (3 个)
- [ ] `source/utils/MainAgentManager.ts`
- [ ] `source/utils/execution/subAgentExecutor.ts`
- [ ] `source/utils/config/subAgentConfig.ts` (updateSubAgent 函数)

### UI 界面文件 (2 个)
- [ ] `source/ui/pages/MainAgentConfigScreen.tsx`
- [ ] `source/ui/pages/SubAgentConfigScreen.tsx`

---

## 风险评估

### 高风险
- **配置文件不兼容**: 用户现有自定义配置将失效
  - **缓解措施**: 在文档中明确说明，用户需手动更新

### 中风险
- **UI 状态管理**: 状态变量名修改可能引入逻辑错误
  - **缓解措施**: 仔细检查所有状态引用，逐个测试

### 低风险
- **类型错误**: TypeScript 编译时检查可提前发现
  - **缓解措施**: 必须通过构建验证

---

## 后续优化建议

1. **配置迁移工具**: 未来可考虑提供自动迁移脚本，将旧配置文件转换为新格式
2. **配置验证**: 在加载配置时验证字段名，提供更友好的错误提示
3. **文档更新**: 更新项目文档，明确角色定义的命名规范

---

## 总结

本实施计划通过 7 个阶段完成角色定义命名规范的统一:

- **修改文件数**: 12 个
- **核心改动**: 字段重命名
- **影响范围**: 类型定义、内置配置、核心逻辑、UI 界面
- **兼容性**: 破坏性更新，用户需重新配置
- **验证方式**: TypeScript 编译 + 手动测试

严格按照此计划执行，可确保修改的完整性和正确性。
