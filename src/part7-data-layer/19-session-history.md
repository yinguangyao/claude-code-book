# 第 19 章 会话持久化与历史管理

> 当你关闭终端后重新打开 Claude Code，输入 `/resume` 恢复上一次对话，一切像是从未中断——历史消息、文件状态、甚至 worktree 位置都被完好恢复。这背后是一套精密的会话持久化系统。

## 19.1 概念引入：Agent 需要记住"刚才发生了什么"

与传统 CLI 工具不同，Claude Code 的一次会话可能持续数小时，涉及数十轮对话和上百次工具调用。用户需要：

- **上下翻阅历史**（↑/↓ 键回溯之前的输入）
- **搜索历史**（Ctrl+R 模糊查找）
- **恢复会话**（`/resume` 继续之前的工作）
- **跨会话引用**（在新会话中查看旧会话的记录）

Claude Code 围绕这些需求构建了两个独立但协作的系统：**输入历史**（History）和**会话转录**（Transcript）。

## 19.2 架构总览

```
~/.claude/
├── history.jsonl                    ← 全局输入历史（所有项目共享）
├── paste-store/
│   └── <hash>.txt                   ← 大文本粘贴的去重存储
└── projects/
    └── <sanitized-project-path>/
        ├── <sessionId>.jsonl        ← 会话转录（完整消息流）
        └── <sessionId>/
            ├── <sessionId>.meta.json ← 会话元数据
            ├── subagents/
            │   └── <agentId>.jsonl  ← 子 Agent 转录
            ├── remote-agents/
            │   └── remote-agent-<taskId>.meta.json
            └── <sessionId>.worktree.json
```

## 19.3 源码走读

### 19.3.1 输入历史：history.ts

输入历史记录用户在终端中输入的每一条命令，类似 shell 的 `.bash_history`：

```typescript
// src/history.ts

type HistoryEntry = {
  display: string                       // 显示文本
  pastedContents?: Record<string, PastedContent>  // 关联的粘贴内容
}

type LogEntry = {
  display: string
  pastedContents?: Record<string, StoredPastedContent>
  timestamp: number
  project: string                       // 项目根路径
  sessionId: string
}
```

**写入流程**：

```typescript
// 批量写入设计——先缓冲，后刷盘
const pendingEntries: LogEntry[] = []

function addToHistory(command: string): void {
  // 检查环境变量 CLAUDE_CODE_SKIP_PROMPT_HISTORY
  if (skipHistory) return

  pendingEntries.push({
    display: command,
    pastedContents: processPastedContents(command),
    timestamp: Date.now(),
    project: getProjectRoot(),
    sessionId: currentSessionId,
  })
}

async function flushPromptHistory(): Promise<void> {
  if (pendingEntries.length === 0) return

  // 获取文件锁（防止多个 Claude Code 实例并发写入）
  await withLock('~/.claude/history.jsonl', {
    stale: 10000,  // 10 秒锁超时
    retries: 3,
  }, async () => {
    // 逐行追加 JSONL
    for (const entry of pendingEntries) {
      await appendFile(historyPath, JSON.stringify(entry) + '\n')
    }
    pendingEntries.length = 0
  })
}
```

**大文本去重**：当粘贴内容超过 1KB 时，不会内联存储，而是通过内容 Hash 存入 `paste-store/`：

```typescript
type StoredPastedContent = {
  id: number
  type: 'text' | 'image'
  content?: string         // 小内容内联
  contentHash?: string     // 大内容存引用
}

async function storePastedText(content: string): Promise<string> {
  const hash = createHash('sha256').update(content).digest('hex')
  const storePath = path.join(pasteStoreDir, `${hash}.txt`)
  // fire-and-forget：写入失败不阻塞主流程
  writeFile(storePath, content).catch(logError)
  return hash
}
```

**读取流程（↑ 键和 Ctrl+R）**：

```typescript
function getHistory(projectRoot: string): HistoryEntry[] {
  // 1. 当前会话的条目优先展示
  // 2. 然后是其他会话的条目
  // 3. 按项目根路径过滤
  // 4. 上限 MAX_HISTORY_ITEMS = 100
}

function getTimestampedHistory(projectRoot: string): TimestampedHistoryEntry[] {
  // Ctrl+R 搜索用
  // 按 display 文本去重
  // 粘贴内容 lazy resolve（列表展示时不解析，选中时才读取）
}
```

### 19.3.2 会话转录与元数据

每个会话的完整消息流存储为 JSONL 格式的转录文件：

```typescript
// 转录包含所有消息类型
type TranscriptEntry = UserMessage | AssistantMessage | AttachmentMessage | SystemMessage

// 每条消息通过 parentUuid 链接形成对话树
interface Message {
  uuid: UUID
  parentUuid?: UUID
  type: string
  timestamp: string
}
```

**会话元数据**以 sidecar JSON 文件形式存储：

```typescript
// <sessionId>/<sessionId>.meta.json
type SessionMetadata = {
  agentType: string          // 使用的 Agent 类型
  worktreePath?: string      // worktree 路径
  description?: string       // 任务描述
}
```

### 19.3.3 会话恢复：processResumedConversation()

`/resume` 命令触发一个多步骤的恢复流程：

```typescript
// src/utils/sessionRestore.ts

async function processResumedConversation(
  sessionId: string,
): Promise<ProcessedResume> {
  // 1. 模式匹配
  //    检查恢复的会话是否与当前 Coordinator 模式兼容
  await modeApi.matchSessionMode(sessionId)

  // 2. Agent 恢复
  //    检查原会话使用的 Agent 类型是否仍可用
  //    应用模型覆盖
  const agent = await restoreAgentFromSession(metadata)

  // 3. Worktree 恢复
  //    如果原会话在 worktree 中，切换到该目录
  //    验证路径仍存在
  if (metadata.worktreePath) {
    await restoreWorktreeForResume(metadata.worktreePath)
  }

  // 4. 重建状态
  //    从转录文件中恢复：
  //    · messages（消息历史）
  //    · fileHistorySnapshots（文件状态快照）
  //    · contextCollapseState（上下文折叠状态）
  //    · customTitle / tag / mode

  return { messages, agent, initialAppState, ... }
}
```

**元数据尾部窗口**：为了在不扫描整个转录文件的情况下快速获取元数据，自定义标题和标签被追加到文件尾部。`readLiteMetadata()` 只读取最后 64KB 来查找：

```typescript
async function readLiteMetadata(transcriptPath: string): Promise<LiteMetadata> {
  // 只读取文件尾部 64KB
  const tailBuffer = await readTail(transcriptPath, 64 * 1024)
  // 在尾部搜索元数据标记
  // 比全文扫描快 10-100 倍
}
```

### 19.3.4 删除历史的双路径设计

```typescript
function removeLastFromHistory(): void {
  // 快速路径：如果条目还在 pendingEntries 缓冲中
  if (pendingEntries.length > 0) {
    pendingEntries.pop()  // O(1)，无 I/O
    return
  }

  // 慢速路径：已经刷盘的条目
  // 记录 timestamp 到 skip set
  // 下次 getHistory() 时过滤掉
  skippedTimestamps.add(lastFlushedTimestamp)
}
```

## 19.4 设计亮点

| 设计 | 说明 |
|------|------|
| **锁机制** | 文件锁 + 10 秒超时，支持多实例并发安全写入 |
| **粘贴去重** | SHA-256 内容寻址存储，避免重复大文本占用空间 |
| **Lazy 解析** | Ctrl+R 列表只显示标题，选中后才加载粘贴内容 |
| **Fire-and-Forget** | 大文本存储和远程元数据写入不阻塞主流程 |
| **尾部窗口** | 元数据追加到文件尾部，64KB 窗口快速扫描 |
| **双层历史** | 全局 history.jsonl 共享，按项目过滤展示 |
| **批量刷盘** | 缓冲多条后批量写入，减少 I/O 次数 |

## 19.5 小结

- **双系统协作**：输入历史（history.jsonl）记录用户输入，会话转录（\<sessionId\>.jsonl）记录完整消息流
- **JSONL 格式**：每行一条记录，支持追加写入，适合流式持久化
- **内容寻址存储**：大文本粘贴通过 SHA-256 Hash 去重到 `paste-store/`
- **文件锁并发控制**：多实例安全写入，10 秒超时防死锁
- **高效恢复**：64KB 尾部窗口快速读取元数据，避免全文扫描
- **多级恢复流程**：模式匹配 → Agent 恢复 → Worktree 切换 → 状态重建
