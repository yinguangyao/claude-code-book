# 《深入 Claude Code：AI Agent 架构与源码解析》设计文档

## 概述

基于 claude-code-source-code 仓库（当前固定版本），撰写一本面向前端/全栈工程师的开源电子书，以源码解析为主线，帮助读者理解工业级 AI Agent 的设计与实现。

## 目标读者

- 前端/全栈工程师
- 了解 Agent 基本概念（Tool Use、ReAct 等），想看真实工业级实现
- 不需要从零讲 LLM 基础

## 设计决策

- **组织方式**：自底向上，按代码执行路径逐层递进
- **侧重点**：源码解析为主，每章先讲概念/架构图，再进入源码走读
- **篇幅**：16 章，分 6 个部分
- **发布平台**：GitHub 开源电子书，部署到 GitHub Pages
- **源码版本**：基于当前固定版本，不追更新
- **每章结构**：概念引入 → 架构图/流程图 → 源码走读 → 小结

---

## 第一部分：全局视角

### 第 1 章：走进 Claude Code

- Claude Code 是什么：一个运行在终端的 AI Agent，不只是聊天机器人
- 技术栈概览：TypeScript + React/Ink（终端 UI）+ Node.js
- 目录结构总览：`src/entrypoints/`、`src/tools/`、`src/services/`、`src/components/` 等核心目录的职责
- 如何阅读本书：源码版本说明、推荐的阅读方式
- 涉及文件：`package.json`、`tsconfig.json`、`src/` 顶层目录

### 第 2 章：启动流程——从命令行到 REPL

- 三阶段启动链：`cli.tsx`（引导） → `init.ts`（初始化） → `main.tsx`（完整启动）
- `cli.tsx`：快速路径（`--version` 零模块加载）、参数解析、分发到不同模式
- `init.ts`：配置加载、认证、TLS/代理、远程设置获取（并行启动优化）
- `main.tsx`：feature flag 初始化、工具注册、权限上下文、AppState 创建、REPL 渲染
- 设计分析：为什么分三阶段？——启动性能优化，按需加载
- 涉及文件：`src/entrypoints/cli.tsx`、`src/entrypoints/init.ts`、`src/main.tsx`

---

## 第二部分：Agent 核心循环

### 第 3 章：System Prompt 的动态构建

- Agent 的"人设"从哪来：系统提示词不是硬编码的，而是动态拼装的
- 上下文注入的几类信息：环境信息（OS、Shell、CWD）、Git 状态（分支、最近提交）、Claude.md 项目文档、工具描述列表
- `getUserContext()` 和 `getSystemContext()` 的实现：memoized 缓存策略
- 设计分析：如何让 LLM "感知"当前工作环境，上下文工程的实践
- 涉及文件：`src/utils/context.ts`、`src/utils/messages.ts`

### 第 4 章：Agent Loop——一次对话的完整生命周期

- 这是全书最核心的一章
- `query.ts` 的主循环：normalizeMessages → 构建系统提示 → 调用 Claude API → 流式解析响应 → 遇到 tool_use → 执行工具 → 将结果追加到消息 → 继续循环
- 循环终止条件：stop_reason、turn limit、token budget、cost limit
- 为什么用 async generator：流式产出进度事件，UI 可以实时渲染
- 错误恢复：`max_output_tokens` 恢复循环、API 重试与 fallback
- 涉及文件：`src/query.ts`

### 第 5 章：QueryEngine——SDK 与无头模式

- QueryEngine 类：对 `query()` 的封装，面向 SDK/程序化调用
- `submitMessage()` 的事件流设计：RequestStartEvent、Message、StreamEvent、ToolUseSummaryMessage
- 有头（REPL 交互）vs 无头（SDK 集成）的统一抽象
- 会话管理：消息列表、文件缓存、usage 追踪、权限拒绝记录
- 设计分析：如何设计一个既能交互又能编程调用的 Agent 引擎
- 涉及文件：`src/QueryEngine.ts`

---

## 第三部分：工具系统

### 第 6 章：Tool 接口设计与注册机制

- Tool 接口定义：`name`、`description`、`inputSchema`（Zod）、`execute`（async generator）、`isConcurrencySafe`、`userFacingName`
- 为什么用 Zod 做运行时校验：LLM 产出的 JSON 不可信，必须验证
- 工具注册：`getTools()` 函数，基于 feature flag 和用户类型条件过滤
- feature gate 与 dead code elimination：`feature('X')` 在构建时替换为 `false`，esbuild 移除不可达分支
- 40+ 工具的分类：核心 I/O（Bash、File*、Glob、Grep）、Agent（AgentTool、SkillTool）、任务管理（Task*）、网络（WebSearch、WebFetch）
- 涉及文件：`src/Tool.ts`、`src/tools.ts`、`src/tools/` 目录

### 第 7 章：工具编排与并发控制

- 核心问题：LLM 一次可能返回多个 tool_use，如何调度？
- `toolOrchestration.ts`：将工具调用分批——只读工具并行（最多 10 并发）、写操作串行
- `isConcurrencySafe` 的判定逻辑：Bash `set -e` 通常安全、FileEdit 不安全
- `StreamingToolExecutor`：工具调用流式到达时的实时调度，不等全部解析完就开始执行
- `ToolUseContext` 的传播：工具间的上下文共享与副作用协调
- 涉及文件：`src/services/tools/toolOrchestration.ts`、`src/services/tools/toolExecution.ts`、`src/services/tools/StreamingToolExecutor.ts`

### 第 8 章：关键工具实现解析

- Bash 工具：命令执行、超时控制、输出截断、安全边界
- FileRead / FileEdit / FileWrite：三者的职责划分与设计取舍（为什么不是一个 FileTool？）
- AgentTool：如何生成子 Agent——独立 QueryEngine、工具过滤、隔离上下文
- Glob / Grep：高性能代码搜索的封装
- 设计分析：每个工具为什么这样设计，背后的 trade-off
- 涉及文件：`src/tools/BashTool/`、`src/tools/FileEditTool/`、`src/tools/AgentTool/` 等

---

## 第四部分：权限与安全

### 第 9 章：多层权限系统

- 为什么 Agent 需要权限系统：LLM 可以调用工具执行真实操作，必须有安全边界
- 四层权限架构：
  - 第一层：配置规则（settings.json 中的 allow/deny/ask 规则）
  - 第二层：自动分类器（Bash 命令安全性自动判定）
  - 第三层：交互审批（终端弹窗让用户确认）
  - 第四层：兜底拒绝（非交互模式下无法确认则拒绝）
- 权限规则的来源与优先级：session → userSettings → localSettings → projectSettings → policySettings → enterprise
- `canUseTool()` 完整决策流程走读
- 拒绝追踪：记录用户拒绝过的操作，避免重复打扰
- 涉及文件：`src/hooks/useCanUseTool.tsx`、`src/utils/permissions/`

### 第 10 章：Permission Mode 与安全设计哲学

- 五种 Permission Mode：default（默认询问）、plan（先展示再执行）、acceptEdits（自动接受文件编辑）、bypassPermissions（跳过所有权限）、auto（分类器自动判定）
- Plan Mode 的设计：让用户先审阅所有计划的操作再批准执行
- 推测执行（Speculation）：在等待用户审批时预先执行，审批通过后直接返回结果
- 对 Agent 安全的通用思考：Agent 的破坏力远大于普通程序，权限设计是 Agent 工程化的核心命题
- 涉及文件：`src/tools/EnterPlanModeTool/`、`src/utils/permissions/autoModeState.js`

---

## 第五部分：扩展机制

### 第 11 章：Hook 系统——事件驱动的扩展

- Hook 的本质：在 Agent 生命周期的关键节点插入自定义逻辑
- 事件类型全览：PreToolUse、PostToolUse、PostToolUseFailure、UserPromptSubmit、SessionStart、FileChanged 等
- 三种 Hook 执行方式：
  - Sync Hook：Shell 脚本，JSON 输入/输出，轻量快速
  - Agent Hook：启动一个隔离的 QueryEngine 子查询，能使用工具
  - Plugin Hook：由插件清单定义
- Hook 响应协议：`continue`、`decision`（approve/block）、`updatedInput`（修改工具输入）、`watchPaths`（注册文件监听）
- 实际场景：用 PreToolUse Hook 做代码风格校验、用 PostToolUse Hook 做日志记录
- 涉及文件：`src/utils/hooks/`、`src/types/hooks.ts`

### 第 12 章：MCP 集成——开放的工具生态

- MCP 协议简介：Model Context Protocol，让 Agent 接入外部工具服务的标准协议
- `MCPServerConnection`：统一抽象四种传输协议（stdio、SSE、HTTP、WebSocket）
- 工具生命周期：配置发现 → 连接建立 → `list_tools()` → `call_tool()` → 结果流式返回
- 资源系统：`list_resources()` / `ReadMcpResourceTool`，通过 `resource://` URI 访问外部资源
- 认证机制：OAuth2 支持、Token 缓存与刷新、Elicitation（-32042 错误码）处理
- 涉及文件：`src/services/mcp/client.ts`、`src/services/mcp/types.ts`

### 第 13 章：Skill 与 Plugin 系统

- Skill 系统：预注册的 slash command，包含工具白名单、模型覆盖、thinking 配置
- Skill 注册机制：`registerBundledSkill()`，与 Command 系统的关系
- SkillTool：如何在 Agent 对话中调用 Skill——独立 transcript、完整上下文访问
- Plugin 架构：Plugin 清单定义、生命周期钩子、与 Hook 系统的协作
- 设计分析：Skill vs Plugin vs Hook 三者的定位与边界
- 涉及文件：`src/skills/`、`src/plugins/`、`src/commands.ts`

---

## 第六部分：上下文管理与高级特性

### 第 14 章：对话上下文与消息压缩

- 核心矛盾：Agent 对话越长越有价值，但 Context Window 有限
- 消息类型体系：UserMessage、AssistantMessage、ProgressMessage、ToolUseSummaryMessage、TombstoneMessage 等，各自的职责
- 三种压缩策略：
  - Auto-compact：上下文达到 ~70% 时自动触发，生成摘要替换历史
  - Reactive-compact：预测下一轮 prompt 超长，提前压缩
  - Snip（History Snip）：基于边界标记裁剪历史片段
- Token 预算与成本控制：如何在质量和成本之间取舍
- 文件缓存（fileStateCache）：同一轮次内避免重复读取文件
- 涉及文件：`src/services/compact/`、`src/types/message.ts`、`src/utils/fileStateCache.ts`

### 第 15 章：状态管理与终端 UI

- AppStateStore：Zustand 风格的中心化状态管理，存储设置、工具、权限、任务状态
- 响应式订阅：`setAppState()` 回调机制，嵌套 Agent 的状态共享（`setAppStateForTasks`）
- React/Ink 终端 UI：为什么用 React 来渲染终端——组件化、声明式、熟悉的心智模型
- REPL 组件：用户输入 → 命令解析 → 创建 QueryEngine → 调用 query() → 实时渲染进度
- 流式渲染：generator 产出事件 → React 组件实时更新，实现"打字机"效果
- 涉及文件：`src/state/AppStateStore.ts`、`src/components/`

### 第 16 章：多 Agent 协作与高级模式

- Coordinator Mode：Leader + Worker 架构，Leader 分配任务、Worker 独立执行
- AgentTool 回顾：子 Agent 的生成、工具过滤、上下文隔离
- Worktree 隔离：基于 Git worktree 给每个子 Agent 独立的工作目录，避免文件冲突
- Plan Mode 回顾：先规划所有操作、用户审阅后批量执行
- Daemon Mode：后台常驻进程，支持长时间运行的 Agent 任务
- 设计分析：多 Agent 协作中的核心挑战——任务分配、冲突避免、结果汇总
- 涉及文件：`src/coordinator/`、`src/tools/AgentTool/`、`src/tools/EnterWorktreeTool/`
