# 第 18 章 记忆系统——跨会话的知识持久化

> 一个优秀的助手不仅要完成当下的任务，还要记住过去的经验。Claude Code 的记忆系统就是它的"长期记忆"——让 AI 能够在不同会话之间保持对用户、项目和工作方式的理解。

## 18.1 概念引入：为什么需要记忆

每次启动 Claude Code，模型从零开始——它不知道你是谁、你在做什么项目、你偏好什么工作方式。如果每次对话都要重新解释一遍，效率会大打折扣。

Claude Code 的记忆系统解决了这个问题。它在三个层面建立持久化记忆：

| 层面 | 存储位置 | 生命周期 | 用途 |
|------|---------|---------|------|
| **自动记忆** (Auto Memory) | `~/.claude/projects/<slug>/memory/` | 永久 | 跨会话的用户偏好、项目上下文 |
| **会话记忆** (Session Memory) | `~/.claude/session-memory/<sessionId>/` | 单次会话 | 当前对话的工作状态快照 |
| **Agent 记忆** | `~/.claude/agent-memory/<agentType>/` | 永久 | 每种 Agent 类型的专属知识 |

此外还有一个**团队记忆**（Team Memory）子系统，允许在团队范围内共享项目级知识。

## 18.2 架构总览

```
┌───────────────────────────────────────────────────────────┐
│                    记忆系统全景                              │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │           自动记忆 (Auto Memory)                      │  │
│  │                                                     │  │
│  │  ~/.claude/projects/<slug>/memory/                  │  │
│  │  ├── MEMORY.md          ← 索引文件（≤200 行）        │  │
│  │  ├── user_role.md       ← 用户信息                   │  │
│  │  ├── feedback_style.md  ← 反馈指导                   │  │
│  │  ├── project_auth.md    ← 项目上下文                 │  │
│  │  ├── reference_jira.md  ← 外部引用                   │  │
│  │  └── team/              ← 团队记忆子目录             │  │
│  │      ├── MEMORY.md                                  │  │
│  │      └── *.md                                       │  │
│  └────────────────────────┬────────────────────────────┘  │
│                           │                               │
│  ┌────────────────────────┼────────────────────────────┐  │
│  │           会话记忆 (Session Memory)                    │  │
│  │                                                     │  │
│  │  ~/.claude/session-memory/<sessionId>/notes.md      │  │
│  │  ├── Session Title                                  │  │
│  │  ├── Current State                                  │  │
│  │  ├── Task specification                             │  │
│  │  ├── Files and Functions                            │  │
│  │  ├── Workflow                                       │  │
│  │  ├── Errors & Corrections                           │  │
│  │  ├── Learnings                                      │  │
│  │  └── Worklog                                        │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │           记忆提取 (Memory Extraction)                 │  │
│  │                                                     │  │
│  │  对话结束时 → Fork Agent → 分析新消息 → 写入记忆       │  │
│  │  · 与主 Agent 互斥                                    │  │
│  │  · 最多 5 轮                                          │  │
│  │  · 仅允许读取 + 记忆目录写入                            │  │
│  └─────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────┘
```

核心模块分布在以下文件中：

- **类型定义**：`src/memdir/memoryTypes.ts`
- **路径管理**：`src/memdir/paths.ts`、`src/memdir/teamMemPaths.ts`
- **记忆扫描**：`src/memdir/memoryScan.ts`
- **新鲜度管理**：`src/memdir/memoryAge.ts`
- **提示构建**：`src/memdir/memdir.ts`、`src/memdir/teamMemPrompts.ts`
- **相关性匹配**：`src/memdir/findRelevantMemories.ts`
- **自动提取**：`src/services/extractMemories/extractMemories.ts`
- **会话记忆**：`src/services/SessionMemory/sessionMemory.ts`

## 18.3 源码走读

### 18.3.1 记忆类型分类法

Claude Code 将记忆分为四种严格的类型，每种有明确的语义边界：

```typescript
// src/memdir/memoryTypes.ts

type MemoryType = 'user' | 'feedback' | 'project' | 'reference'
```

| 类型 | 语义 | 示例 |
|------|------|------|
| `user` | 用户角色、偏好、知识水平 | "用户是数据科学家，当前关注可观测性" |
| `feedback` | 工作方式指导（做/不做） | "不要在测试中 mock 数据库——因为上季度出过事故" |
| `project` | 项目动态、目标、截止日期 | "2026-03-05 起冻结非关键合并——移动端发版" |
| `reference` | 外部系统的指针 | "Pipeline bug 在 Linear 项目 INGEST 中跟踪" |

每个记忆文件遵循统一的 Frontmatter 格式：

```markdown
---
name: 用户角色
description: 用户是资深后端工程师，首次接触 React
type: user
---

用户有 10 年 Go 经验但这是他第一次接触 React 前端代码。
解释前端概念时，应类比后端模式来辅助理解。
```

**什么不应该保存？** 这一点同样重要：
- 代码模式、架构、文件路径（可从代码推断）
- Git 历史、谁改了什么（`git log` 是权威来源）
- 调试方案（修复在代码中，上下文在 commit message 中）
- CLAUDE.md 中已有的内容
- 临时任务详情、当前进展

### 18.3.2 存储结构与路径解析

记忆的存储路径经过精心设计，支持多层覆盖：

```typescript
// src/memdir/paths.ts

function getAutoMemPath(): string {
  // 优先级：
  // 1. CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 环境变量（Cowork SDK）
  // 2. settings.json 中的 autoMemoryDirectory（支持 ~/ 展开）
  // 3. 默认路径：~/.claude/projects/<sanitized-repo-root>/memory/
}
```

记忆是否启用也有一个优先级链：

```typescript
function isAutoMemoryEnabled(): boolean {
  // 1. CLAUDE_CODE_DISABLE_AUTO_MEMORY 环境变量 → 强制关闭
  // 2. --bare / CLAUDE_CODE_SIMPLE 标志 → 关闭
  // 3. CCR 无持久存储 → 关闭
  // 4. settings.json 中 autoMemoryEnabled → 项目级开关
  // 5. 默认：启用
}
```

### 18.3.3 MEMORY.md 索引系统

`MEMORY.md` 是记忆系统的"目录页"。它**不存储记忆内容**，只存储指向具体文件的索引：

```markdown
- [用户角色](user_role.md) — 资深后端工程师，首次接触 React
- [代码风格偏好](feedback_style.md) — 不要在回答末尾总结
- [Auth 重构](project_auth.md) — 法务要求的合规改造，非技术债
- [Bug 跟踪](reference_jira.md) — Pipeline bug 在 Linear INGEST 项目
```

索引文件有严格的容量限制：

```typescript
// src/memdir/memdir.ts

function truncateEntrypointContent(content: string): string {
  // 第一道关：行数限制（200 行）
  const lines = content.split('\n')
  if (lines.length > 200) {
    content = lines.slice(0, 200).join('\n')
    content += '\n\n⚠️ MEMORY.md truncated at 200 lines...'
  }

  // 第二道关：字节限制（25KB）
  if (Buffer.byteLength(content) > 25 * 1024) {
    // 在最后一个换行符处截断（避免截断在行中间）
    content = content.slice(0, lastNewlineBefore25KB)
    content += '\n\n⚠️ MEMORY.md truncated at 25KB...'
  }

  return content
}
```

`MEMORY.md` 在每次会话启动时被注入到 System Prompt 中，因此容量控制直接影响 Token 消耗。

### 18.3.4 记忆扫描：memoryScan

扫描记忆目录，获取所有记忆文件的元数据：

```typescript
// src/memdir/memoryScan.ts

async function scanMemoryFiles(
  memoryDir: string,
  signal?: AbortSignal,
): Promise<MemoryHeader[]> {
  // 1. 递归读取目录中所有 .md 文件（排除 MEMORY.md）
  // 2. 读取每个文件的前 30 行，提取 Frontmatter
  // 3. 提取 filename, filepath, mtimeMs, description, type
  // 4. 按修改时间降序排列
  // 5. 最多返回 200 个文件

  return headers.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 200)
}
```

**性能优化**：传统做法是先 `stat()` 获取 mtime 排序，再 `readFile()` 获取内容——需要两次 syscall。这里合并为一次读取，在读取内容时同时获取 mtime，**将系统调用减半**。

### 18.3.5 记忆新鲜度：对抗"过期知识"

记忆最大的风险是**过时**。一条记忆说"auth 模块在 `src/auth/middleware.ts`"，但该文件可能已被重命名或删除。`memoryAge.ts` 提供了一套新鲜度管理机制：

```typescript
// src/memdir/memoryAge.ts

function memoryAge(mtimeMs: number): string {
  const days = memoryAgeDays(mtimeMs)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

function memoryFreshnessText(mtimeMs: number): string | null {
  const days = memoryAgeDays(mtimeMs)
  if (days <= 1) return null  // 新鲜，无需警告

  return [
    `This memory is ${days} days old.`,
    'Memories are point-in-time observations that may no longer be accurate.',
    'Verify against current code before asserting as fact.',
  ].join(' ')
}
```

当 `FileReadTool` 读取记忆文件时，会在内容后附加新鲜度警告（包裹在 `<system-reminder>` 标签中），提醒模型"这条记忆可能已过时，使用前请验证"。

### 18.3.6 相关记忆发现：findRelevantMemories

不是所有记忆都与当前对话相关。系统使用 Claude Sonnet 来做相关性匹配：

```typescript
// src/memdir/findRelevantMemories.ts

async function findRelevantMemories(
  userQuery: string,
  memoryHeaders: MemoryHeader[],
  recentTools: string[],
  alreadySurfaced: Set<string>,
): Promise<SelectedMemory[]> {
  // 1. 将所有记忆文件的 filename + description 组合成候选列表
  // 2. 调用 Sonnet 模型进行相关性选择
  //    - 输入：用户查询 + 候选记忆列表 + 最近使用的工具
  //    - 输出：最多 5 条最相关的记忆
  // 3. 过滤掉已在本轮展示过的记忆（alreadySurfaced）
  // 4. 返回选中的记忆路径 + mtime
}
```

**为什么用 Sonnet 而不是简单的关键词匹配？** 因为相关性往往是语义层面的。用户问"怎么处理认证"，一条描述为"OAuth middleware 重构的合规要求"的记忆高度相关，但关键词匹配可能错过它。

### 18.3.7 自动记忆提取：后台 Agent 模式

这是记忆系统中最精妙的部分。在每轮对话结束后，系统会启动一个**后台 Agent** 来分析对话并提取值得记住的信息：

```typescript
// src/services/extractMemories/extractMemories.ts

async function extractMemories(context: ExtractionContext): Promise<void> {
  // 1. 互斥检查：如果主 Agent 已经写了记忆，跳过
  if (hasMemoryWritesSince(context.lastCursor)) {
    advanceCursor()
    return  // 主 Agent 优先
  }

  // 2. Fork 一个子 Agent
  const forkedAgent = await runForkedAgent({
    // 共享父 Agent 的 Prompt Cache（关键优化！）
    messages: context.messages,
    maxTurns: 5,           // 最多 5 轮对话
    skipTranscript: true,  // 不记录到会话日志（避免竞态）
  })

  // 3. 限制工具权限
  forkedAgent.canUseTool = createAutoMemCanUseTool({
    allow: ['Read', 'Grep', 'Glob'],                    // 允许读取
    allowBash: ['ls', 'find', 'grep', 'cat', 'stat'],   // 只允许只读命令
    allowWrite: isAutoMemPath,                           // 仅允许写入记忆目录
    deny: ['MCP', 'Agent', 'TaskCreate'],                // 禁止扩展工具
  })

  // 4. 注入提取提示（包含现有记忆清单 + 类型分类法）
  // 5. 运行 Agent，让它分析新消息并决定是否写入记忆
}
```

**互斥机制**是关键设计。在同一轮对话中，主 Agent 和提取 Agent 不会同时写入记忆：

```
场景 1：用户说"记住这个"，主 Agent 直接写入
→ 提取 Agent 检测到 hasMemoryWritesSince()
→ 跳过提取，推进游标

场景 2：普通对话结束，无显式记忆写入
→ 提取 Agent 启动，分析对话
→ 决定是否有值得记住的信息
→ 如有，写入记忆文件 + 更新 MEMORY.md
```

**节流控制**：提取不是每轮都执行的：

```typescript
// 通过 Feature Flag 控制节流倍数
// tengu_bramble_lintel = N（默认 1）
// 每 N 个合格轮次执行一次提取
```

### 18.3.8 会话记忆：当前对话的工作笔记

与跨会话的自动记忆不同，会话记忆记录的是**当前对话**的工作状态，类似于"工作笔记"：

```typescript
// src/services/SessionMemory/sessionMemory.ts

// 会话记忆的模板包含以下分区：
const SESSION_MEMORY_SECTIONS = [
  'Session Title',                    // 5-10 个信息密集的词
  'Current State',                    // 当前工作状态、待办、下一步
  'Task specification',               // 用户要求构建什么，设计决策
  'Files and Functions',              // 重要文件及其作用
  'Workflow',                         // 执行过的命令和结果
  'Errors & Corrections',             // 遇到的错误和修复
  'Codebase and System Documentation',// 组件及其关系
  'Learnings',                        // 什么有效、什么无效
  'Key results',                      // 用户需要的精确输出
  'Worklog',                          // 精简的步骤日志
]
```

**容量限制**：
- 每个分区：~2000 Token（~8000 字符）
- 总量：~12000 Token（软限制，超出时生成警告）

**触发条件**——会话记忆在满足以下条件时更新：

```typescript
// src/services/SessionMemory/sessionMemoryUtils.ts

const DEFAULT_SESSION_MEMORY_CONFIG = {
  minimumMessageTokensToInit: 10000,  // 首次提取需积累 10K token
  minimumTokensBetweenUpdate: 5000,   // 每次更新间隔至少 5K token
  toolCallsBetweenUpdates: 3,         // 或至少 3 次工具调用
}

function shouldExtractMemory(context): boolean {
  // Token 阈值始终必须满足
  if (tokensSinceLastExtraction < minimumTokensBetweenUpdate) return false

  // 如果最近一轮有工具调用，需同时满足工具调用阈值
  if (lastTurnHasToolCalls) {
    return toolCallsSinceLastExtraction >= toolCallsBetweenUpdates
  }

  // 如果最近一轮没有工具调用（自然对话断点），只需满足 Token 阈值
  return true
}
```

### 18.3.9 团队记忆

团队记忆允许多人共享项目级知识，存储在自动记忆目录的 `team/` 子目录中：

```typescript
// src/memdir/teamMemPaths.ts

function getTeamMemoryPath(): string {
  return path.join(getAutoMemPath(), 'team')
}
```

团队记忆有额外的**安全防护**——symlink 遍历攻击防御：

```typescript
function validateTeamMemWritePath(filePath: string): boolean {
  // 1. 路径解析 + 字符串级包含检查（快速拒绝）
  // 2. 对最深存在的祖先目录做 symlink 解析
  // 3. 与真实团队目录的规范路径比对
  // 4. 检测悬挂 symlink（writeFile 会跟随）
  // 任何一步失败都拒绝写入
}
```

不同记忆类型有不同的"推荐作用域"：

| 类型 | 默认作用域 | 说明 |
|------|-----------|------|
| `user` | 始终私有 | 用户角色和偏好是个人的 |
| `feedback` | 默认私有 | 仅项目级规范存团队 |
| `project` | 偏向团队 | 项目上下文通常对团队有价值 |
| `reference` | 通常团队 | 外部资源指针对团队都有用 |

### 18.3.10 Agent 记忆

每种 Agent 类型有独立的记忆空间：

```typescript
// src/tools/AgentTool/agentMemory.ts

// 三级作用域：
// 1. 用户级：~/.claude/agent-memory/<agentType>/MEMORY.md
//    全局适用，跨项目
// 2. 项目级：./.claude/agent-memory/<agentType>/MEMORY.md
//    项目特定，可提交到 VCS
// 3. 本地级：./.claude/agent-memory-local/<agentType>/MEMORY.md
//    项目+机器特定，不入 VCS

function getAgentMemoryPaths(agentType: string): AgentMemoryPaths {
  // 清理 Agent 类型名（: → - 以兼容 Windows）
  const sanitized = agentType.replace(/:/g, '-')
  return {
    user: path.join(homedir, '.claude/agent-memory', sanitized, 'MEMORY.md'),
    project: path.join(gitRoot, '.claude/agent-memory', sanitized, 'MEMORY.md'),
    local: path.join(gitRoot, '.claude/agent-memory-local', sanitized, 'MEMORY.md'),
  }
}
```

## 18.4 记忆在系统中的注入点

记忆在多个环节被注入到模型的上下文中：

```
┌────────────────────────┐
│     System Prompt      │ ← MEMORY.md 索引内容注入
│  loadMemoryPrompt()    │    包含记忆类型分类法 + 操作指南
└────────────┬───────────┘
             │
             ▼
┌────────────────────────┐
│     每轮附件收集        │ ← 相关记忆作为 Attachment 注入
│  getAttachments()      │    Sonnet 智能选择最相关的 ≤5 条
└────────────┬───────────┘
             │
             ▼
┌────────────────────────┐
│     FileReadTool       │ ← 读取记忆文件时附加新鲜度警告
│  memoryFreshnessNote() │    提醒模型验证过时信息
└────────────┬───────────┘
             │
             ▼
┌────────────────────────┐
│     对话压缩           │ ← 会话记忆参与压缩重建
│  sessionMemoryCompact  │    保证压缩后不丢失关键上下文
└────────────────────────┘
```

## 18.5 设计哲学与工程取舍

| 设计决策 | 权衡考量 |
|---------|---------|
| **Fork Agent 提取** | 共享 Prompt Cache 减少成本，但增加了互斥复杂度 |
| **四类型强分类** | 限制了灵活性，但保证了记忆的结构化和可检索性 |
| **新鲜度警告** | 增加 Token 消耗，但防止了模型盲目引用过时信息 |
| **Sonnet 做相关性匹配** | 比关键词匹配更准确，但增加了 API 成本 |
| **MEMORY.md 索引 vs 数据库** | 简单可调试，但受限于 200 行 / 25KB |
| **团队记忆 symlink 防御** | 增加了路径检查开销，但防止了目录穿越攻击 |
| **会话记忆分区模板** | 结构化使提取更可靠，但限制了自由发挥 |

## 18.6 小结

- **三层记忆架构**：自动记忆（跨会话）、会话记忆（当前对话）、Agent 记忆（按类型隔离）
- **四类型分类法**：user / feedback / project / reference，严格的语义边界
- **MEMORY.md 索引模式**：200 行 / 25KB 的轻量索引，每条 <150 字符
- **Fork Agent 自动提取**：后台 Agent 分析对话，与主 Agent 互斥写入
- **新鲜度管理**：按天计算记忆年龄，>1 天自动附加验证警告
- **Sonnet 相关性匹配**：语义级选择最多 5 条相关记忆注入上下文
- **团队记忆安全**：symlink 遍历防御 + 作用域推荐机制
- **会话记忆节流**：Token 阈值 + 工具调用次数双门控制
