# Git Worktree 工作流

## 仓库配置

- 上游仓库: git@github.com:MayDay-wpf/snow-cli.git (upstream)
- 我的远端: git@github.com:NyxJae/snow-cli.git (origin)

## Worktree 结构

### 主 Worktree: `F:/Projects/snow-cli` (main 分支)

- **用途**: 本地开发专属功能
- **工作流程**:
  - 直接在 main 分支开发
  - 提交到 origin/main
  - 定期合并上游新功能: `git fetch upstream && git merge upstream/main`

### 上游 PR Worktree: `F:/Projects/snow-cli-upstream` (upstream-sync 分支)

- **用途**: 向上游仓库提交 PR
- **工作流程**:
  1. 更新 upstream-sync: `git fetch upstream && git merge upstream/main`
  2. 创建功能分支: `git checkout -b feat/xxx` 或 `fix/xxx`
  3. 开发并提交: `git commit -m "type: description"`
  4. 推送到 origin: `git push origin feat/xxx`
  5. 使用 gh 提 PR 到 upstream/main: `gh pr create --repo MayDay-wpf/snow-cli`

## 分支说明

- **main**: 本仓库主要分支,开发独属功能并定期合并上游
- **upstream-sync**: 上游同步分支,仅用于跟踪上游,不做任何修改
- **feat/xxx, fix/xxx**: 从 upstream-sync 创建的功能/修复分支,向上游提 PR

# 测试

本项目 build 通过即可,不用运行 test 或 lint 等命令
本项目是控制台 tui 应用,你负责构建通过后通知用户重启应用后进行测试,反馈信息或日志给你

# 提交与 PR

已安装 gh.提交 PR 时,为避免多行文本截断或特殊字符被转义,MUST 只能使用 --body-file 使用文件形式提交,git commit --file 提交也一样用文件!提交成功后清理该临时文件.
中文提交信息和 pr 信息

# 本地特殊修改

requirements 文件夹中放着我一些本地的一些特殊修改,用于记录和参考
我本地移除了 --yolo 等相关启动命令
也移除了 plan 模式 漏洞猎手等模式,重构成了可配置的主代理,以全面取代了它
移出的功能在合并上游后也不打算要
也移除了 role 相关
主代理和子代理使用 toml 文件配置
todo 改为树形展示,且始终展示,并适配 /clear /resume 从 home 的新会话和上次会话进入时的刷新
增加了主代理系统,配置界面,快捷切换界面
bash.ts 中选择执行命令的 shell 的逻辑改为,优先使用用户当前 shell,没有则使用回退逻辑.
主代理: 系统提示词(有一套系统提示词系统) + 主代理角色定义(有专门主代理配置系统) 规范化了变量命名
子代理: 系统提示词(有一套系统提示词系统) + 子代理角色定义(有专门子代理配置系统) 规范化了变量命名
本地对 Response ApiPI 的工具多模态返回做了特殊处理,对图片使用单分出一个 user 的方式来增强了对中转平台的支持.
对子代理的插嘴机制已完全使用上游方案了
本地对主代理和子代理添加了 限制编辑文件类型的 字段和编辑工具将根据此字段做限制

# 当前任务
解决冲突