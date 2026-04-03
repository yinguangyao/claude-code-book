# 第 16 章 多 Agent 协作与高级模式

## 16.1 从单 Agent 到多 Agent：为什么一个不够

前面的章节描述了一个 Claude Code 会话的完整生命周期：用户输入 → 工具调用 → 反馈 → 下一轮。这个单线程模型对于大多数日常任务已经够用。但当任务复杂度超过某个阈值，单 Agent 模型就会暴露出深层的瓶颈。

**Context Window 是第一个瓶颈。** 一次大型重构任务可能需要读取几十个文件、执行数百次工具调用。即便有第 14 章介绍的压缩机制，超长会话依然会丢失早期建立的理解。

**串行执行是第二个瓶颈。** 如果需要研究三个模块、同时修改五个文件，单 Agent 只能一件事做完再做下一件，等待时间随任务规模线性增长。

**专业化是第三个瓶颈。** "什么都做"的通用 Agent 在角色切换之间难以保持最佳状态——一个负责写测试的 Agent 和一个负责研究 API 文档的 Agent，需要不同的工具集和不同的思考框架。

Claude Code 的回答是**多 Agent 协作架构**。其核心思想是：将一个复杂任务分解为若干子任务，由多个专业化的 Worker Agent 并行执行，而一个 Leader（Coordinator）负责全局规划、任务分发与结果综合。这不仅仅是性能优化，更是一种认知架构的升级——Leader 保持高层视角，Worker 专注于深度执行。

## 16.2 架构全景：Leader + Worker 协作模型

![多 Agent 协作架构](/images/ch16-multi-agent.png)

在深入源码之前，先通过架构图建立整体认知：

```
┌─────────────────────────────────────────────────────────────┐
│                     用户（User）                              │
└─────────────────────┬───────────────────────────────────────┘
                      │ 自然语言指令
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              Coordinator（Leader Agent）                      │
│                                                              │
│  工具：AgentTool / SendMessageTool / TaskStopTool            │
│  职责：任务分解、并行调度、结果综合、与用户沟通                │
│  上下文：仅保留高层摘要，不深入细节                           │
└──────┬──────────────────┬──────────────────┬────────────────┘
       │ spawn             │ spawn             │ spawn
       ▼                   ▼                   ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  Worker A    │  │  Worker B    │  │  Worker C    │
│（研究 Agent）│  │（实现 Agent）│  │（验证 Agent）│
│              │  │              │  │              │
│ 工具：Read   │  │ 工具：Edit   │  │ 工具：Bash   │
│ Grep, Glob   │  │ Write, Bash  │  │ Read, Grep   │
│              │  │              │  │              │
│  Git Worktree│  │  Git Worktree│  │              │
│  （隔离副本）│  │  （隔离副本）│  │              │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │ task-notification│ task-notification│ task-notification
       └──────────────────┴──────────────────┘
                          │
                          ▼ 异步通知（user-role message）
                    Coordinator（汇总结果）
```

这张架构图揭示了几个关键设计决策：

1. **Coordinator 只拥有编排工具**，不直接操作文件系统，保持视角纯粹。
2. **Worker 结果以 `<task-notification>` XML 形式异步回传**，不阻塞 Coordinator 的其他工作。
3. **每个 Worker 可以拥有独立的 Git Worktree**，彻底消除文件系统冲突。
4. **Worker 完成后可以被 `SendMessageTool` 继续驱动**，充分利用已建立的上下文。

## 16.3 Coordinator Mode：编排者的诞生

Coordinator Mode 是 Claude Code 多 Agent 体系的顶层概念。启用后，当前实例从一个"全能 Agent"变身为纯粹的编排者——它只会发号施令，不亲自动手。

### 模式检测与系统提示替换

`coordinatorMode.ts` 是这一机制的入口：

```typescript
// src/coordinator/coordinatorMode.ts
export function isCoordinatorMode(): boolean {
  if (feature('COORDINATOR_MODE')) {
    return isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
  }
  return false
}
```

通过环境变量 `CLAUDE_CODE_COORDINATOR_MODE=1` 即可激活。激活后，`getCoordinatorSystemPrompt()` 会替换掉默认的系统提示，将 Claude 的角色完全重塑：

```typescript
export function getCoordinatorSystemPrompt(): string {
  return `You are Claude Code, an AI assistant that orchestrates software
engineering tasks across multiple workers.

## 1. Your Role

You are a **coordinator**. Your job is to:
- Help the user achieve their goal
- Direct workers to research, implement and verify code changes
- Synthesize results and communicate with the user
- Answer questions directly when possible — don't delegate work
  that you can handle without tools
...`
}
```

这段系统提示定义了 Coordinator 的核心行为规范：绝不亲自操作文件、用 `AgentTool` 生成 Worker、用 `SendMessageTool` 继续已有 Worker、永远不要捏造 Worker 的结果。

### Coordinator 的工具集限制

Coordinator 的工具列表在 `constants/tools.ts` 中被明确约束：

```typescript
// src/constants/tools.ts
export const COORDINATOR_MODE_ALLOWED_TOOLS = new Set([
  AGENT_TOOL_NAME,        // 启动新 Worker
  TASK_STOP_TOOL_NAME,    // 停止失控的 Worker
  SEND_MESSAGE_TOOL_NAME, // 继续已有 Worker
  SYNTHETIC_OUTPUT_TOOL_NAME,
])
```

四个工具，仅此而已。这种极简设计保证了 Coordinator 的"不沾手"原则——它在架构上就不具备直接修改文件的能力。

### 上下文注入：让 Coordinator 了解 Worker 的能力

`getCoordinatorUserContext()` 向 Coordinator 注入一段描述 Worker 工具集的文本：

```typescript
export function getCoordinatorUserContext(
  mcpClients: ReadonlyArray<{ name: string }>,
  scratchpadDir?: string,
): { [k: string]: string } {
  if (!isCoordinatorMode()) {
    return {}
  }

  const workerTools = Array.from(ASYNC_AGENT_ALLOWED_TOOLS)
    .filter(name => !INTERNAL_WORKER_TOOLS.has(name))
    .sort()
    .join(', ')

  let content = `Workers spawned via the ${AGENT_TOOL_NAME} tool have
access to these tools: ${workerTools}`

  if (scratchpadDir && isScratchpadGateEnabled()) {
    content += `\n\nScratchpad directory: ${scratchpadDir}\nWorkers can
read and write here without permission prompts. Use this for durable
cross-worker knowledge...`
  }

  return { workerToolsContext: content }
}
```

注意 `scratchpadDir` 参数——当启用时，所有 Worker 共享一个临时目录作为跨 Agent 的持久化知识库，这是多 Agent 协作的重要基础设施。

### 会话恢复时的模式对齐

当用户恢复一个旧会话时，需要确保 Coordinator 模式与保存的会话模式一致：

```typescript
export function matchSessionMode(
  sessionMode: 'coordinator' | 'normal' | undefined,
): string | undefined {
  const currentIsCoordinator = isCoordinatorMode()
  const sessionIsCoordinator = sessionMode === 'coordinator'

  if (currentIsCoordinator === sessionIsCoordinator) {
    return undefined
  }

  // 自动翻转环境变量，使恢复的会话在正确模式下继续
  if (sessionIsCoordinator) {
    process.env.CLAUDE_CODE_COORDINATOR_MODE = '1'
  } else {
    delete process.env.CLAUDE_CODE_COORDINATOR_MODE
  }

  return sessionIsCoordinator
    ? 'Entered coordinator mode to match resumed session.'
    : 'Exited coordinator mode to match resumed session.'
}
```

## 16.4 AgentTool 深度解析：子 Agent 的生命周期

`AgentTool` 是整个多 Agent 体系的核心机制。无论是 Coordinator 派遣 Worker，还是普通 Agent 生成子 Agent，都通过这个工具完成。

### Worker 可用的工具集

`ASYNC_AGENT_ALLOWED_TOOLS` 定义了异步 Worker 可以使用的工具白名单：

```typescript
// src/constants/tools.ts
export const ASYNC_AGENT_ALLOWED_TOOLS = new Set([
  FILE_READ_TOOL_NAME,     // 读文件
  WEB_SEARCH_TOOL_NAME,    // 网络搜索
  TODO_WRITE_TOOL_NAME,    // 任务追踪
  GREP_TOOL_NAME,          // 内容搜索
  WEB_FETCH_TOOL_NAME,     // 网页抓取
  GLOB_TOOL_NAME,          // 文件匹配
  ...SHELL_TOOL_NAMES,     // Bash 执行
  FILE_EDIT_TOOL_NAME,     // 文件编辑
  FILE_WRITE_TOOL_NAME,    // 文件写入
  NOTEBOOK_EDIT_TOOL_NAME, // Notebook 编辑
  SKILL_TOOL_NAME,         // 技能工具
  SYNTHETIC_OUTPUT_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  ENTER_WORKTREE_TOOL_NAME, // 进入 Worktree
  EXIT_WORKTREE_TOOL_NAME,  // 退出 Worktree
])
```

Worker 拥有相当完整的能力集，包括文件读写、Shell 执行和网络访问。默认情况下，`AgentTool` 本身被排除在外（防止无限递归），除非用户是 Anthropic 内部成员（`USER_TYPE === 'ant'`）——内部可以启用多层嵌套 Agent。

### 工具解析：resolveAgentTools

在 Worker 启动时，`resolveAgentTools()` 负责将 Agent 定义中声明的工具列表映射到真实的 Tool 对象：

```typescript
// src/tools/AgentTool/agentToolUtils.ts
export function resolveAgentTools(
  agentDefinition: Pick<AgentDefinition, 'tools' | 'disallowedTools' | ...>,
  availableTools: Tools,
  isAsync = false,
  isMainThread = false,
): ResolvedAgentTools {
  // 通配符 ['*'] 表示允许所有工具
  const hasWildcard =
    agentTools === undefined ||
    (agentTools.length === 1 && agentTools[0] === '*')
  if (hasWildcard) {
    return {
      hasWildcard: true,
      validTools: [],
      invalidTools: [],
      resolvedTools: allowedAvailableTools,
    }
  }
  // 精确匹配声明的工具名称
  for (const toolSpec of agentTools) {
    const tool = availableToolMap.get(toolName)
    if (tool) {
      resolved.push(tool)
    } else {
      invalidTools.push(toolSpec)
    }
  }
  ...
}
```

这里有一个关键的设计细节：Agent 定义支持 `allowedAgentTypes` 语法，例如 `"Agent(worker, researcher)"` 会限制该 Agent 只能派遣 `worker` 和 `researcher` 类型的子 Agent。这为构建严格的 Agent 层次结构提供了基础。

### runAgent：Agent 运行时的骨架

`runAgent()` 是 Worker 实际执行的核心函数，它是一个异步生成器：

```typescript
// src/tools/AgentTool/runAgent.ts
export async function* runAgent({
  agentDefinition,
  promptMessages,
  toolUseContext,
  isAsync,
  availableTools,
  worktreePath,
  ...
}): AsyncGenerator<Message, void> {
  // 1. 初始化 Agent 专属的 MCP 服务器
  const { clients, tools: mcpTools, cleanup } =
    await initializeAgentMcpServers(agentDefinition, parentClients)

  // 2. 构建系统提示和用户上下文
  const [baseUserContext, baseSystemContext] = await Promise.all([
    override?.userContext ?? getUserContext(),
    override?.systemContext ?? getSystemContext(),
  ])

  // 3. 创建隔离的子 Agent 上下文（独立的 readFileState）
  const subagentContext = createSubagentContext(toolUseContext, ...)

  // 4. 运行 query 循环，流式产出消息
  for await (const message of query(...)) {
    yield message
  }
}
```

尤其值得注意的是第三步：`createSubagentContext` 为每个 Worker 创建了独立的 `readFileState`——这是一个缓存已读文件哈希的对象。Worker 有自己独立的文件状态缓存，不与父 Agent 共享，这保证了上下文隔离的彻底性。

### 异步 Worker 的生命周期管理

当 Worker 以异步模式启动（`isAsync: true`），`runAsyncAgentLifecycle()` 接管其完整的生命周期：

```typescript
// src/tools/AgentTool/agentToolUtils.ts
export async function runAsyncAgentLifecycle({
  taskId, abortController, makeStream, metadata, description,
  toolUseContext, rootSetAppState, enableSummarization, getWorktreeResult,
}): Promise<void> {
  const agentMessages: MessageType[] = []
  try {
    const tracker = createProgressTracker()
    for await (const message of makeStream(onCacheSafeParams)) {
      agentMessages.push(message)
      // 实时更新进度到 AppState
      updateAsyncAgentProgress(taskId, getProgressUpdate(tracker), rootSetAppState)
    }

    const agentResult = finalizeAgentTool(agentMessages, taskId, metadata)
    // 任务完成，触发 UI 解锁
    completeAsyncAgent(agentResult, rootSetAppState)

    // 异步通知回传给 Coordinator
    enqueueAgentNotification({
      taskId, description, status: 'completed',
      finalMessage, usage: { totalTokens, toolUses, durationMs },
    })
  } catch (error) {
    if (error instanceof AbortError) {
      // 用户主动终止
      killAsyncAgent(taskId, rootSetAppState)
      enqueueAgentNotification({ status: 'killed', ... })
    } else {
      // 执行失败
      failAsyncAgent(taskId, msg, rootSetAppState)
      enqueueAgentNotification({ status: 'failed', error: msg, ... })
    }
  }
}
```

这段代码揭示了异步 Worker 的三种终态：`completed`（正常完成）、`killed`（被 `TaskStopTool` 终止）、`failed`（执行错误）。每种终态都会通过 `enqueueAgentNotification` 将结果以 `<task-notification>` XML 格式注入 Coordinator 的消息队列。

### task-notification：异步结果的标准格式

Coordinator 系统提示中定义了 Worker 回传通知的 XML 格式：

```xml
<task-notification>
  <task-id>{agentId}</task-id>
  <status>completed|failed|killed</status>
  <summary>{人类可读的状态摘要}</summary>
  <result>{Agent 的最终文本响应}</result>
  <usage>
    <total_tokens>N</total_tokens>
    <tool_uses>N</tool_uses>
    <duration_ms>N</duration_ms>
  </usage>
</task-notification>
```

这个通知作为 `user` 角色消息注入，与真实用户消息共享同一频道。Coordinator 的系统提示明确告知如何区分它们："通过 `<task-notification>` 开头标签识别"。这是一种巧妙的"带外通信"方案——无需修改 API 协议，复用现有消息通道即可实现异步回调。

## 16.5 Fork Subagent：上下文继承的并行分叉

除了 Coordinator-Worker 模型，Claude Code 还实现了另一种多 Agent 模式：**Fork（分叉）**。与从零开始的 Worker 不同，Fork 子 Agent 会继承父 Agent 的完整对话上下文。

### 分叉的核心思想

```typescript
// src/tools/AgentTool/forkSubagent.ts

/**
 * Fork subagent 特性说明：
 * - 省略 subagent_type 时触发隐式分叉
 * - 子 Agent 继承父 Agent 的完整对话历史和系统提示
 * - 所有 Agent 派遣都以后台模式运行，统一使用 <task-notification> 交互模型
 * - 与 Coordinator 模式互斥——Coordinator 已有自己的编排模型
 */
export function isForkSubagentEnabled(): boolean {
  if (feature('FORK_SUBAGENT')) {
    if (isCoordinatorMode()) return false
    if (getIsNonInteractiveSession()) return false
    return true
  }
  return false
}
```

### 消息分叉的实现细节

`buildForkedMessages()` 负责构建分叉子 Agent 的初始消息序列：

```typescript
export function buildForkedMessages(
  directive: string,
  assistantMessage: AssistantMessage,
): MessageType[] {
  // 1. 保留父 Agent 的完整 assistant 消息（包含所有 tool_use 块）
  const fullAssistantMessage = { ...assistantMessage }

  // 2. 为所有 tool_use 块创建占位符 tool_result
  //    关键：所有分叉子 Agent 使用相同的占位符文本，确保 Prompt Cache 命中
  const FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background'
  const toolResultBlocks = toolUseBlocks.map(block => ({
    type: 'tool_result' as const,
    tool_use_id: block.id,
    content: [{ type: 'text', text: FORK_PLACEHOLDER_RESULT }],
  }))

  // 3. 每个分叉子 Agent 只有最后一个文本块不同（包含各自的指令）
  //    结构：[...history, assistant(all_tool_uses), user(placeholder_results..., directive)]
  //    只有最终 directive 不同 → 最大化 Prompt Cache 命中率
  const toolResultMessage = createUserMessage({
    content: [
      ...toolResultBlocks,
      { type: 'text', text: buildChildMessage(directive) },
    ],
  })

  return [fullAssistantMessage, toolResultMessage]
}
```

这段实现体现了一个精妙的性能优化：多个并行分叉子 Agent 的请求前缀完全相同（历史消息 + 父 Agent 消息 + 统一占位符），只有最末尾的指令文本块不同。这使得 Claude API 的 Prompt Cache 可以为所有分叉共享，大幅降低 token 开销。

### 分叉子 Agent 的行为规范

子 Agent 启动时会收到一段严格的行为约束：

```typescript
export function buildChildMessage(directive: string): string {
  return `<fork_boilerplate>
STOP. READ THIS FIRST.

You are a forked worker process. You are NOT the main agent.

RULES (non-negotiable):
1. Your system prompt says "default to forking." IGNORE IT — that's
   for the parent. You ARE the fork. Do NOT spawn sub-agents; execute directly.
2. Do NOT converse, ask questions, or suggest next steps
3. USE your tools directly: Bash, Read, Write, etc.
4. If you modify files, commit your changes before reporting.
5. Your response MUST begin with "Scope:". No preamble.
...
</fork_boilerplate>

FORK_DIRECTIVE:${directive}`
}
```

这段"元提示"的作用是防止递归分叉（规则 1），强制子 Agent 保持沉默地执行（规则 2、5），并建立标准化的报告格式——便于父 Agent 快速解析结果。

## 16.6 Git Worktree 隔离：让每个 Agent 拥有独立的工作目录

当多个 Worker 并行修改同一个代码库时，文件系统冲突是致命的。Claude Code 通过 Git Worktree 机制为每个 Agent 提供完全隔离的工作副本。

### EnterWorktreeTool：进入隔离空间

`EnterWorktreeTool` 的核心逻辑体现在其 `call()` 方法：

```typescript
// src/tools/EnterWorktreeTool/EnterWorktreeTool.ts
async call(input) {
  // 防止在已有 Worktree 内再次创建
  if (getCurrentWorktreeSession()) {
    throw new Error('Already in a worktree session')
  }

  // 确保从主仓库根目录创建，即使当前已在某个 Worktree 内
  const mainRepoRoot = findCanonicalGitRoot(getCwd())
  if (mainRepoRoot && mainRepoRoot !== getCwd()) {
    process.chdir(mainRepoRoot)
    setCwd(mainRepoRoot)
  }

  const slug = input.name ?? getPlanSlug()

  // 在 .claude/worktrees/ 目录下创建新的 Git Worktree
  const worktreeSession = await createWorktreeForSession(getSessionId(), slug)

  // 切换工作目录到新 Worktree
  process.chdir(worktreeSession.worktreePath)
  setCwd(worktreeSession.worktreePath)
  setOriginalCwd(getCwd())
  saveWorktreeState(worktreeSession)

  // 清除依赖 CWD 的缓存，强制重新计算
  clearSystemPromptSections()
  clearMemoryFileCaches()
  getPlansDirectory.cache.clear?.()

  return {
    data: {
      worktreePath: worktreeSession.worktreePath,
      message: `Created worktree at ${worktreeSession.worktreePath}...`,
    },
  }
}
```

`createWorktreeForSession()` 在内部执行 `git worktree add`，在 `.claude/worktrees/<slug>/` 目录创建一个新的 Worktree，并检出与当前 HEAD 相同的新分支。Agent 所有的文件修改都发生在这个隔离副本中，不会影响主仓库的工作目录。

### ExitWorktreeTool：安全退出与清理

退出 Worktree 时需要细心处理未提交的变更：

```typescript
// src/tools/ExitWorktreeTool/ExitWorktreeTool.ts
async validateInput(input) {
  if (input.action === 'remove' && !input.discard_changes) {
    const summary = await countWorktreeChanges(
      session.worktreePath,
      session.originalHeadCommit,
    )
    // 如果有未提交文件或未合并的 commit，拒绝删除（保护用户的工作成果）
    if (changedFiles > 0 || commits > 0) {
      return {
        result: false,
        message: `Worktree has ${parts.join(' and ')}. Removing will
discard this work permanently. Confirm with the user, then re-invoke
with discard_changes: true — or use action: "keep" to preserve.`,
        errorCode: 2,
      }
    }
  }
  return { result: true }
}
```

这个 `validateInput` 守卫实现了"fail-closed"原则：当 git 命令失败（无法确定状态）时，拒绝删除操作，而不是假装安全。这防止了 Agent 在不确定性下销毁用户的工作。

### Worktree 与 Agent 的结合

在 `AgentTool` 的 prompt 中，可以看到 Worktree 隔离的使用方式：

```typescript
// src/tools/AgentTool/prompt.ts
`- You can optionally set \`isolation: "worktree"\` to run the agent in
  a temporary git worktree, giving it an isolated copy of the repository.
  The worktree is automatically cleaned up if the agent makes no changes;
  if changes are made, the worktree path and branch are returned in the result.`
```

当 Coordinator 调用 `AgentTool({ isolation: "worktree", ... })` 时，系统自动为该 Worker 创建专属 Worktree，任务完成后若无改动则自动清理。这使得"快照-修改-报告"的工作模式变得极其自然。

### 分叉 Agent 的 Worktree 通知

当分叉子 Agent 在 Worktree 中运行时，它还会收到一段特殊的上下文提示：

```typescript
// src/tools/AgentTool/forkSubagent.ts
export function buildWorktreeNotice(
  parentCwd: string,
  worktreeCwd: string,
): string {
  return `You've inherited the conversation context above from a parent
agent working in ${parentCwd}. You are operating in an isolated git
worktree at ${worktreeCwd} — same repository, same relative file
structure, separate working copy. Paths in the inherited context refer
to the parent's working directory; translate them to your worktree root.
Re-read files before editing if the parent may have modified them...`
}
```

这段提示解决了一个微妙问题：分叉子 Agent 继承了父 Agent 的历史上下文，其中包含父 Agent 目录下的文件路径。若不加提示，子 Agent 会在自己的 Worktree 中引用父目录的路径，导致混乱。这段提醒明确告知子 Agent 需要进行路径转换。

## 16.7 Swarm 架构：Tmux 驱动的多终端协作

除了 API 级别的多 Agent，Claude Code 还实现了一种更"可视化"的多 Agent 方案：**Swarm（蜂群）** 模式。在 Swarm 中，每个 Agent（Teammate）在独立的 tmux 窗格中运行，用户可以直接观察每个 Agent 的执行过程。

### 核心常量定义

```typescript
// src/utils/swarm/constants.ts
export const TEAM_LEAD_NAME = 'team-lead'
export const SWARM_SESSION_NAME = 'claude-swarm'
export const SWARM_VIEW_WINDOW_NAME = 'swarm-view'
export const TMUX_COMMAND = 'tmux'

export function getSwarmSocketName(): string {
  return `claude-swarm-${process.pid}`
}
```

`team-lead` 是 Leader 的固定名称，`claude-swarm` 是整个 tmux 会话的名称。通过 PID 来构建 Socket 名称，确保多个 Claude 实例的 Swarm 会话互不干扰。

### 多后端支持：PaneBackend 抽象

Swarm 通过 `PaneBackend` 接口抽象了底层的窗格管理，支持 tmux 和 iTerm2 两种后端：

```
backends/
├── TmuxBackend.ts        # tmux 后端实现
├── ITermBackend.ts       # iTerm2 后端实现
├── InProcessBackend.ts   # 进程内后端（用于测试和嵌入式场景）
├── PaneBackendExecutor.ts # 将 PaneBackend 适配到 TeammateExecutor
└── registry.ts           # 后端注册与选择
```

`InProcessBackend` 是一个特殊的后端：它不启动新进程，而是在同一个 Node.js 进程内通过 `AsyncLocalStorage` 实现上下文隔离。这使得 Teammate 可以与主进程共享 API 客户端和 MCP 连接，减少冗余初始化开销。

### CLI 标志继承：让 Teammate 继承父进程的配置

当 Swarm 派遣新的 Teammate 时，`buildInheritedCliFlags()` 确保关键配置的传递：

```typescript
// src/utils/swarm/spawnUtils.ts
export function buildInheritedCliFlags(options?): string {
  const flags: string[] = []

  // 权限模式继承
  if (permissionMode === 'bypassPermissions') {
    flags.push('--dangerously-skip-permissions')
  }

  // 模型配置继承
  const modelOverride = getMainLoopModelOverride()
  if (modelOverride) {
    flags.push(`--model ${quote([modelOverride])}`)
  }

  // 插件配置继承
  for (const pluginDir of inlinePlugins) {
    flags.push(`--plugin-dir ${quote([pluginDir])}`)
  }

  // 确保 Teammate 使用相同的协作模式
  flags.push(`--teammate-mode ${sessionMode}`)

  return flags.join(' ')
}
```

这确保了整个 Swarm 集群的一致性：用户在启动时选择的权限模式、模型版本、插件配置，会自动传播到所有衍生的 Teammate 进程。

## 16.8 Daemon Mode：后台常驻的远程桥接

除了交互式的多 Agent 场景，Claude Code 还支持 **Daemon（守护进程）** 模式，用于无头（headless）的后台运行——特别是在 Claude Code Remote（CCR）场景下。

### Headless Bridge 架构

`bridgeMain.ts` 中的 `runBridgeHeadless()` 是 Daemon 模式的核心入口：

```typescript
// src/bridge/bridgeMain.ts

/**
 * 非交互式桥接入口，用于 remoteControl 守护进程 Worker。
 *
 * 是 bridgeMain() 的精简版本：
 * - 无 readline 对话框
 * - 无 stdin 键盘处理
 * - 无 TUI（终端 UI）
 * - 无 process.exit()
 *
 * 配置来自调用方（daemon.json），认证通过 IPC 传入，
 * 日志写入 Worker 的 stdout 管道。
 * 发生致命错误时抛出异常——Worker 捕获后映射到正确的退出码。
 */
export async function runBridgeHeadless(
  opts: HeadlessBridgeOpts,
  signal: AbortSignal,
): Promise<void> {
  const { dir, log } = opts

  // 设置工作目录
  process.chdir(dir)
  setOriginalCwd(dir)
  setCwdState(dir)

  // 启用配置文件
  enableConfigs()
  initSinks()
  ...
}
```

Daemon 模式下的进程扮演"Worker"角色，由外部的 Supervisor 进程管理其生命周期。Supervisor 负责：认证 token 刷新、崩溃重启（带指数退避）、会话超时管理。

### 错误分类：永久失败 vs 临时失败

Daemon 模式对错误做了精细的分类：

```typescript
export class BridgeHeadlessPermanentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgeHeadlessPermanentError'
  }
}
```

`BridgeHeadlessPermanentError` 代表"不可重试"的永久错误（如 trust 未接受、Worktree 不可用），Worker 在捕获此错误后以特殊退出码退出，告知 Supervisor 不要重启（否则会陷入无限重试循环）。其他错误则被视为临时故障，Supervisor 会按指数退避重试。

### Bridge 配置参数

```typescript
export type HeadlessBridgeOpts = {
  dir: string                    // 工作目录
  name?: string                  // Session 名称
  spawnMode: 'same-dir' | 'worktree'  // Worktree 隔离模式
  capacity: number               // 最大并发 Session 数
  permissionMode?: string        // 权限模式
  sandbox: boolean               // 沙箱模式
  sessionTimeoutMs?: number      // Session 超时
  createSessionOnStart: boolean  // 启动时立即创建 Session
  getAccessToken: () => string | undefined  // 认证 token 提供者
  onAuth401: (failedToken: string) => Promise<boolean>  // 401 回调
  log: (s: string) => void       // 日志输出
}
```

`capacity` 参数允许单个 Daemon 实例管理多个并发 Session，进一步提升资源利用率。`spawnMode: 'worktree'` 则让每个 Session 自动获得独立的 Git Worktree——这是 Worktree 隔离与 Daemon 模式的自然融合。

## 16.9 多 Agent 协作的挑战与最佳实践

理解了架构之后，我们还需要正视多 Agent 带来的新挑战。

### 挑战一：上下文边界的管理

每个 Worker 启动时都是"全新的"——它看不见 Coordinator 与用户的对话历史。源码中的 prompt 规范对此有明确警告：

```
Workers can't see your conversation. Every prompt must be self-contained
with everything the worker needs.
```

Coordinator 系统提示中甚至专门列举了反模式：

```
// 反模式（懒惰的委托）
AgentTool({ prompt: "Based on your findings, fix the auth bug", ... })

// 正确做法（明确的综合规范）
AgentTool({ prompt: "Fix the null pointer in src/auth/validate.ts:42.
The user field on Session is undefined when sessions expire but the
token remains cached. Add a null check before user.id access...", ... })
```

这不是 API 限制，而是深思熟虑的架构选择：强迫 Coordinator 真正理解并消化 Worker 的发现，而不是把理解责任转嫁给下一个 Worker。

### 挑战二：并发冲突与隔离策略

源码中的并发指南给出了明确的分类：

```
- 只读任务（研究）：可以自由并行
- 写密集型任务（实现）：同一批文件一次只能一个 Worker
- 验证任务：可以与操作不同文件区域的实现任务并行
```

Git Worktree 机制解决了文件系统层面的冲突，但不能解决逻辑层面的冲突——两个 Worker 各自修改同一功能的不同部分，最终需要 Coordinator 主导合并策略。

### 挑战三：安全与权限边界

多 Agent 场景下的安全边界更加复杂。源码中有一个安全机制值得关注：

```typescript
// agentToolUtils.ts：Agent 交接时的安全分类
export async function classifyHandoffIfNeeded({
  agentMessages,
  tools,
  toolPermissionContext,
  subagentType,
}): Promise<string | null> {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    // 对 Worker 的完整执行记录进行安全分类
    // 如果发现问题，在通知中附加安全警告
    if (classifierResult.shouldBlock) {
      return `SECURITY WARNING: This sub-agent performed actions that
may violate security policy. Reason: ${classifierResult.reason}.
Review the sub-agent's actions carefully before acting on its output.`
    }
  }
  return null
}
```

每个 Worker 完成后，其完整的执行记录会经过安全分类器的检查。如果发现违反策略的行为，Coordinator 会收到警告而不是直接的结果——这是防止 Prompt Injection 攻击在多 Agent 链路中传播的重要防线。

### 挑战四：失败处理与部分结果

分布式系统中，部分失败是常态。Claude Code 的设计在 Worker 失败时保留已有成果：

```typescript
// 提取 Worker 在失败前积累的部分结果
export function extractPartialResult(
  messages: MessageType[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.type !== 'assistant') continue
    const text = extractTextContent(m.message.content, '\n')
    if (text) return text
  }
  return undefined
}
```

即使 Worker 被意外终止，其最后一条有效的文本输出也会作为 `partialResult` 包含在 `killed` 通知中传回 Coordinator，让 Coordinator 可以决定是继续（`SendMessage`）还是重新派遣。

## 16.10 小结：从工具到生态

回顾本章，我们追踪了 Claude Code 多 Agent 体系的完整脉络：

- **Coordinator Mode** 通过环境变量激活，完全替换系统提示，将 Claude 从通用 Agent 变为纯粹的编排者
- **AgentTool** 是子 Agent 的孵化器，提供从工具解析、上下文隔离到异步生命周期的完整管理
- **Fork Subagent** 实现了上下文继承的并行分叉，通过统一占位符最大化 Prompt Cache 命中率
- **Git Worktree** 为每个 Agent 提供独立的文件系统副本，从根本上消除并发写入冲突
- **Swarm 架构** 通过 tmux 或进程内后端提供可视化的多 Agent 协作界面
- **Daemon Mode** 支持无头后台运行，通过永久/临时错误分类实现智能重试

这些机制共同构成了一个完整的"Agent 操作系统"：有调度（Coordinator）、有隔离（Worktree）、有通信（task-notification）、有安全（transcript classifier）、有持久化（session resume）。

---

## 全书总结

至此，我们完成了对 Claude Code 源码的完整旅程。

这本书从最基础的 CLI 启动流程出发，逐层深入：**工具系统**是 Agent 感知和改变世界的手；**权限系统**是确保安全的边界；**查询引擎**是驱动对话循环的心脏；**上下文管理**是在有限窗口中保持长期记忆的智慧；**多 Agent 协作**是超越单点能力的组织范式。

在源码阅读过程中，有几个设计哲学反复出现，值得我们记住：

**1. 渐进式信任而非全量授权。** 每一个可能产生副作用的操作都有权限检查。权限不是二元的（有/无），而是精细分级的（只读/接受编辑/自动执行）。这种设计让用户能够根据场景选择合适的信任级别。

**2. 容错而非脆弱。** 无论是上下文压缩的分层策略、Worktree 退出前的变更检查，还是 Daemon 模式的永久/临时错误分类，都体现了"优雅降级"而非"一旦出错就崩溃"的设计取向。

**3. 可观测性是一等公民。** 从每个工具调用的 `renderToolUseMessage`/`renderToolResultMessage`，到 Worker 的实时进度更新、Perfetto tracing 埋点，Claude Code 在每个关键路径上都留有可观测的窗口。复杂系统的调试从来不是靠猜，而是靠证据。

**4. 提示词即架构。** 在 AI 系统中，系统提示不只是"给 AI 的说明书"，而是定义系统行为边界的核心配置。Coordinator 的角色切换靠的是一份精心设计的系统提示，分叉子 Agent 的规范靠的是注入的行为约束段落。理解这一点，才能真正理解 AI 原生软件的设计范式。

**5. 并行是默认，串行是例外。** 多 Agent 体系的核心价值在于并行执行独立任务。Coordinator 系统提示中反复强调"并行是你的超能力"（Parallelism is your superpower）。工程上，这需要 Worktree 隔离、异步通知、以及细心的依赖分析共同支撑。

Claude Code 是 AI Agent 工程化的一次认真探索。它不是一个玩具，而是一个在数百万真实用户场景中经过考验的生产系统。它的源码展示了当 LLM 真正需要"做事"而不只是"说话"时，工程师们面临的真实复杂度——以及他们找到的那些优雅答案。

希望这本书能成为你理解和构建下一代 AI Agent 系统的起点。

> 代码会变，架构会迭代，但设计背后的权衡取舍，将永远值得细细品味。
