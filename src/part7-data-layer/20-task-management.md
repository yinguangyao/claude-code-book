# 第 20 章 任务管理系统——从 TodoWrite 到多 Agent 任务编排

> 在一个简单对话中，Agent 可以线性地完成工作。但当任务变得复杂——需要拆分步骤、跟踪进度、协调多个 Agent 并行工作时——就需要一个正式的任务管理系统。Claude Code 从早期的 TodoWrite 工具演进到了如今的文件驱动任务系统。

## 20.1 概念引入：Agent 的"看板"

人类开发者用 Jira、Linear 管理任务。Claude Code 的 Agent 也需要类似的能力——不是给人看的，而是给 AI 自己用的：

- **TodoWrite**：早期的轻量级待办列表，单个 Agent 的工作清单
- **Task 系统**（v2）：文件驱动的任务管理，支持多 Agent 认领、依赖阻塞、状态追踪
- **后台任务**：Shell 命令、子 Agent、远程 Agent 等异步任务的生命周期管理

这三个系统共同构成了 Claude Code 的任务管理体系。

## 20.2 架构总览

```
┌──────────────────────────────────────────────────────────┐
│                    任务管理全景                            │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ 前台任务（工具层）                                    │  │
│  │                                                    │  │
│  │  TodoWriteTool  ──→ 单 Agent 待办列表              │  │
│  │  TaskCreateTool ──→ 创建任务                       │  │
│  │  TaskUpdateTool ──→ 更新/认领/删除                 │  │
│  │  TaskGetTool    ──→ 查询任务详情                   │  │
│  │  TaskListTool   ──→ 列出所有任务                   │  │
│  └──────────────────────┬─────────────────────────────┘  │
│                         │                                │
│  ┌──────────────────────┼─────────────────────────────┐  │
│  │ 后台任务（运行时层） │                               │  │
│  │                      ▼                              │  │
│  │  LocalShellTask   ── 后台 Shell 命令               │  │
│  │  LocalAgentTask   ── 本地子 Agent                  │  │
│  │  RemoteAgentTask  ── 远程 CCR Agent                │  │
│  │  DreamTask        ── 自动整理/巩固                  │  │
│  │  InProcessTeammateTask ── 进程内队友               │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                          │
│  存储：~/.claude/tasks/<taskListId>/<id>.json            │
└──────────────────────────────────────────────────────────┘
```

## 20.3 源码走读

### 20.3.1 TodoWrite：轻量级待办

TodoWrite 是 Agent 最早拥有的任务管理能力。它本质上是一个结构化的待办列表，直接写入 AppState：

```typescript
// src/tools/TodoWriteTool/TodoWriteTool.ts

type TodoItem = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string     // 正在进行时的动词形式描述
}
```

TodoWrite 的 Prompt（`src/tools/TodoWriteTool/prompt.ts`）是 Claude Code 中最长的工具提示之一，它详细指导模型**何时**使用、**如何**拆分任务、以及**状态转换规则**。

### 20.3.2 文件驱动任务系统（v2）

v2 系统将任务持久化为独立的 JSON 文件，支持多 Agent 并发操作：

```
~/.claude/tasks/
└── <taskListId>/
    ├── .lock                    ← 列表级锁文件
    ├── .highwatermark           ← 最大已分配 ID
    ├── 1.json                   ← 任务 #1
    ├── 2.json                   ← 任务 #2
    └── N.json
```

**任务数据结构**：

```typescript
// src/utils/tasks.ts

type Task = {
  id: string
  subject: string                // 任务标题
  description: string            // 详细描述
  activeForm: string             // 进行时描述
  owner?: string                 // 认领的 Agent 名称
  status: 'pending' | 'in_progress' | 'completed'
  blocks: string[]               // 本任务阻塞的其他任务 ID
  blockedBy: string[]            // 阻塞本任务的前置任务 ID
  metadata: Record<string, unknown>  // 扩展元数据
}
```

### 20.3.3 任务创建：两级锁设计

```typescript
// src/tools/TaskCreateTool/

async function createTask(taskListId: string, taskData: TaskInput): Promise<Task> {
  // 1. 获取列表级锁（共享锁）
  await withLock(lockPath(taskListId), {
    retries: 30,
    minTimeout: 5,
    maxTimeout: 100,
  }, async () => {
    // 2. 读取高水位标记获取下一个 ID
    const nextId = (await readHighWaterMark(taskListId)) + 1

    // 3. 写入任务文件
    await writeFile(
      taskPath(taskListId, nextId),
      JSON.stringify({ ...taskData, id: String(nextId) })
    )

    // 4. 不更新高水位标记（仅在删除时更新）
  })

  // 5. 通知监听器
  notifyTasksUpdated()
}
```

**为什么高水位标记只在删除时更新？** 因为正常流程中 ID 是单调递增的，高水位自然就是最大的文件名。只有删除操作可能"留下空洞"，此时需要记录历史最大 ID 以防止 ID 复用。ID 复用是危险的——它可能导致任务输出文件的 symlink 攻击。

### 20.3.4 任务认领：原子性检查

多 Agent 场景中，任务认领是一个需要原子性保证的操作：

```typescript
// src/utils/tasks.ts

async function claimTask(
  taskListId: string,
  taskId: string,
  agentId: string,
  options?: { checkAgentBusy?: boolean },
): Promise<ClaimTaskResult> {

  if (options?.checkAgentBusy) {
    // 需要列表级锁——检查该 Agent 是否已有未完成任务
    return withListLock(taskListId, async () => {
      // 原子性地检查所有任务
      const allTasks = await listTasks(taskListId)
      const busyWith = allTasks.filter(t =>
        t.owner === agentId &&
        t.status !== 'completed'
      )
      if (busyWith.length > 0) {
        return { success: false, reason: 'agent_busy', busyWithTasks: busyWith }
      }
      return doClaimTask(taskId, agentId)
    })
  }

  // 不检查忙碌状态——只需任务级锁
  return withTaskLock(taskListId, taskId, async () => {
    return doClaimTask(taskId, agentId)
  })
}

async function doClaimTask(taskId, agentId): Promise<ClaimTaskResult> {
  const task = await readTask(taskId)

  // 验证链
  if (!task) return { success: false, reason: 'task_not_found' }
  if (task.owner && task.owner !== agentId) return { success: false, reason: 'already_claimed' }
  if (task.status === 'completed') return { success: false, reason: 'already_resolved' }

  // 阻塞检查：前置任务必须全部完成
  const blockers = task.blockedBy.filter(bid => {
    const blocker = await readTask(bid)
    return blocker && blocker.status !== 'completed'
  })
  if (blockers.length > 0) return { success: false, reason: 'blocked', blockedByTasks: blockers }

  // 认领成功
  task.owner = agentId
  task.status = 'in_progress'
  await writeTask(task)
  return { success: true, task }
}
```

### 20.3.5 依赖追踪与级联删除

任务之间通过 `blocks[]` / `blockedBy[]` 维护双向依赖关系。当任务被删除时，需要级联清理：

```typescript
async function deleteTask(taskListId: string, taskId: string): Promise<void> {
  await withListLock(taskListId, async () => {
    // 1. 删除任务文件
    await unlink(taskPath(taskListId, taskId))

    // 2. 更新高水位标记
    await bumpHighWaterMark(taskListId, parseInt(taskId))

    // 3. 级联引用清理：从所有其他任务中移除对此任务的引用
    const allTasks = await listTasks(taskListId)
    for (const task of allTasks) {
      let changed = false
      task.blocks = task.blocks.filter(id => { if (id === taskId) { changed = true; return false } return true })
      task.blockedBy = task.blockedBy.filter(id => { if (id === taskId) { changed = true; return false } return true })
      if (changed) await writeTask(task)
    }
  })
}
```

### 20.3.6 后台任务类型

Claude Code 支持多种后台任务类型，每种有独立的生命周期管理：

**Shell 任务**：

```typescript
// src/tasks/LocalShellTask/LocalShellTask.tsx

type LocalShellTaskState = TaskStateBase & {
  command: string                // 原始命令
  shellCommand: ShellCommand     // Shell 进程句柄
  result?: string                // 命令输出
  isBackgrounded: boolean        // 是否被后台化
}

// 生命周期：
// 1. spawnShellTask() → 创建进程
// 2. shellCommand.background(taskId) → 后台化
// 3. 输出持续写入磁盘
// 4. 停滞检测（45 秒无输出 + 匹配提示符模式）
// 5. 完成 → 通知 → 清理
```

**本地 Agent 任务**：

```typescript
// src/tasks/LocalAgentTask/LocalAgentTask.tsx

type LocalAgentTaskState = TaskStateBase & {
  agentId: string
  prompt: string
  selectedAgent: AgentDefinition
  messages: Message[]               // 消息流（从转录同步）
  progress: AgentProgress           // 进度追踪
  pendingMessages: PendingMessage[] // 排队中的消息
  retain: boolean                   // 完成后是否保留
}

// 进度追踪：
// · 累计 token 数
// · 工具调用计数
// · 最近活动列表
// · 通过 updateProgressFromMessage() 递增更新
```

**远程 Agent 任务**：

```typescript
// src/tasks/RemoteAgentTask/RemoteAgentTask.tsx

type RemoteAgentTaskState = TaskStateBase & {
  remoteTaskType: string
  sessionId: string              // CCR 会话 ID
  title: string
  log: SDKMessage[]              // 远程日志流
  isLongRunning: boolean
  isUltraplan: boolean
  ultraplanPhase?: string
}

// 生命周期：
// 1. registerRemoteAgentTask() → 创建
// 2. writeRemoteAgentMetadata() → 元数据持久化到 sidecar
// 3. pollRemoteSessionEvents() → 轮询远程状态
// 4. 完成 → extractPlanFromLog()（如果是 ultraplan）
// 5. deleteRemoteAgentMetadata() → 清理 sidecar
// 6. 恢复时：listRemoteAgentMetadata() → 重新连接
```

**Dream 任务**（自动整理）：

```typescript
// src/tasks/DreamTask/DreamTask.ts

type DreamTaskState = TaskStateBase & {
  phase: 'starting' | 'updating'
  sessionsReviewing: number      // 正在回顾的会话数
  filesTouched: string[]         // 修改过的文件路径
  turns: DreamTurn[]             // 整理轮次
  priorMtime?: number            // 用于回滚检测
}

// 整理机制：
// · 自动启动的巩固子 Agent
// · 回顾最近会话的内容
// · 提取和更新项目记忆
// · Kill 时回滚 mtime（让下次会话可以重试）
```

### 20.3.7 任务列表 ID 的解析层次

在多 Agent 场景中，哪个 Agent 看到哪个任务列表？这由 TaskListId 的解析层次决定：

```typescript
function resolveTaskListId(): string {
  // 优先级从高到低：
  // 1. CLAUDE_CODE_TASK_LIST_ID 环境变量（外部覆盖）
  // 2. 进程内队友的 Leader 团队名（共享看板）
  // 3. CLAUDE_CODE_TEAM_NAME 环境变量（进程队友）
  // 4. TeamCreateTool 设置的 Leader 团队名
  // 5. 当前 Session ID（回退：独立看板）
}
```

这个设计确保了：
- 同一个 Swarm 中的 Agent 共享一个任务列表
- 不同的 Swarm 之间任务列表隔离
- 单独运行的 Agent 使用自己的 Session 作为列表 ID

### 20.3.8 通知与 UI 更新

任务系统通过信号机制触发 UI 更新：

```typescript
// src/utils/tasks.ts

// 发布-订阅模式
const onTasksUpdated = createSignal()

// 任务变更时触发
function notifyTasksUpdated(): void {
  onTasksUpdated.emit()  // 所有订阅者立即收到通知
}

// UI 层订阅
onTasksUpdated.subscribe(() => {
  // 刷新任务列表视图
  // 不需要轮询——事件驱动
})
```

通知的原子性也有保障：

```typescript
// 每个任务只通知一次
type TaskStateBase = {
  // ...
  notified: boolean  // 完成通知是否已发送
}

function enqueueTaskNotification(task: TaskState): void {
  if (task.notified) return  // 去重
  task.notified = true
  // 入队通知
}
```

## 20.4 设计哲学

| 设计 | 说明 |
|------|------|
| **文件即状态** | 每个任务一个 JSON 文件，无需数据库 |
| **两级锁粒度** | 列表级锁用于跨任务操作，任务级锁用于单任务更新 |
| **ID 不复用** | 高水位标记防止删除后 ID 被重新分配 |
| **信号驱动 UI** | 发布-订阅模式，无轮询开销 |
| **Sidecar 元数据** | 远程 Agent 元数据与任务状态分离，支持断线重连 |
| **停滞检测** | Shell 任务 45 秒无输出 + 提示符模式匹配 |

## 20.5 小结

- **三层任务体系**：TodoWrite（轻量清单）→ Task 系统（文件驱动、多 Agent）→ 后台任务（异步执行）
- **文件驱动存储**：每任务一个 JSON，高水位标记防 ID 复用
- **原子性认领**：两级锁 + Agent 忙碌检查，保证多 Agent 不冲突
- **双向依赖追踪**：`blocks[]` / `blockedBy[]` 维护，删除时级联清理
- **五种后台任务**：Shell、本地 Agent、远程 Agent、Dream 整理、进程内队友
- **信号通知机制**：事件驱动的 UI 更新，任务级去重
