# 第 14 章 对话上下文与消息压缩

## 14.1 核心矛盾：无限对话与有限窗口

任何 AI Agent 的长对话都面临一个根本性矛盾：**对话越长、积累的上下文越丰富，Agent 的决策质量就越高；但 LLM 的 Context Window 是有限的**。

一个典型的 Claude Code 编程会话可能持续数小时，涉及几十次文件读取、数百次工具调用。如果不加管理，这些消息会迅速填满 Context Window（即使是 200K token 的窗口也不例外）。一旦超出上限，API 会直接返回 `prompt_too_long` 错误，整个会话将被中断。

Claude Code 的解决方案是一套分层的上下文压缩体系。它不是简单地"截断旧消息"，而是根据不同的触发条件和紧迫程度，选择恰当的压缩策略，在信息保留和 token 预算之间取得平衡。

## 14.2 消息类型体系

![消息压缩策略](/images/ch14-context-compaction.png)

在深入压缩机制之前，我们需要理解 Claude Code 中消息的类型体系。所有消息都通过 `Message` 联合类型表示，在 `compact.ts` 的导入中可以看到关键类型：

```typescript
// compact.ts 导入的消息类型
import type {
  AssistantMessage,
  AttachmentMessage,
  HookResultMessage,
  Message,
  PartialCompactDirection,
  SystemCompactBoundaryMessage,
  SystemMessage,
  UserMessage,
} from '../../types/message.js'
```

核心消息类型包括：

- **UserMessage**：用户输入或工具执行结果（`tool_result`），是与 API 交互的基本单元
- **AssistantMessage**：模型的回复，包含文本、工具调用（`tool_use`）和思维链（`thinking`）
- **SystemMessage / SystemCompactBoundaryMessage**：系统控制消息，其中 `SystemCompactBoundaryMessage` 是压缩的核心标记，它记录了压缩发生的位置和元数据
- **ProgressMessage**：工具执行过程中的进度信息（如 Bash 命令的实时输出），仅用于 UI 展示
- **AttachmentMessage**：附件消息，用于在压缩后重新注入文件内容、技能描述等上下文
- **HookResultMessage**：Hook 执行结果，在压缩后通过 `processSessionStartHooks` 重新注入

其中 `ProgressMessage` 在压缩时会被直接过滤掉——它只是临时的 UI 信息，对模型推理没有价值。`SystemCompactBoundaryMessage` 则起到"分界线"的作用，标识压缩边界，后续的消息加载逻辑会根据它来决定从哪里开始渲染。

## 14.3 压缩触发流程总览

Claude Code 的压缩体系按触发时机和处理力度可分为四层：

```
用户发送消息
    │
    ▼
┌─────────────────────────────────────────────┐
│ 1. Snip Compact（标记裁剪）                   │
│    基于 [id:xxx] 标记，模型主动裁剪旧消息       │
│    ↓ 释放的 token 数传递给后续阶段              │
├─────────────────────────────────────────────┤
│ 2. Microcompact（微压缩）                     │
│    清理旧工具结果（file_read/grep/bash 等）     │
│    ├── Time-based MC：缓存过期后批量清理        │
│    └── Cached MC：通过 cache_edits API 删除    │
├─────────────────────────────────────────────┤
│ 3. Auto-compact（自动压缩）                    │
│    token 超阈值时触发完整摘要                   │
│    ├── Session Memory Compact                │
│    └── Legacy Compact（调用 LLM 生成摘要）      │
├─────────────────────────────────────────────┤
│ 4. Reactive Compact（响应式压缩）              │
│    API 返回 prompt_too_long 后的紧急压缩        │
└─────────────────────────────────────────────┘
```

## 14.4 Snip Compact：模型主动裁剪

Snip 是 Claude Code 中最轻量的压缩机制。它的核心思路是：**让模型自己决定哪些旧消息可以被丢弃**。

在消息发送给 API 之前，`normalizeMessagesForAPI` 会给每条用户消息附加一个短 ID 标签 `[id:xxx]`。这些标签由 `deriveShortMessageId` 函数从消息的 UUID 确定性生成（6 位 base36 字符串）。模型在需要时可以调用 Snip 工具，指定要裁剪的消息 ID 范围。

```typescript
// utils/messages.ts
export function deriveShortMessageId(uuid: string): string {
  // 从 UUID 确定性地生成 6 位 base36 短 ID
  // ...
}
```

在 `query.ts` 中，Snip 是整个压缩链的第一步：

```typescript
// query.ts — Snip 在 microcompact 和 autocompact 之前执行
let snipTokensFreed = 0
if (feature('HISTORY_SNIP')) {
  const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
  messagesForQuery = snipResult.messages
  snipTokensFreed = snipResult.tokensFreed
  if (snipResult.boundaryMessage) {
    yield snipResult.boundaryMessage
  }
}
```

Snip 释放的 token 数量 `snipTokensFreed` 会传递给后续的 Auto-compact 阈值计算，避免重复压缩：

```typescript
// autoCompact.ts — 从 token 估算中扣除 Snip 已释放的量
const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
```

Snip 的设计哲学是"由模型自驱动"——它不需要复杂的 token 计数逻辑，只需要模型在感知到上下文压力时主动发起裁剪。

## 14.5 Microcompact：微压缩

Microcompact 是一种不需要调用 LLM 的轻量压缩，其目标是清除旧的工具执行结果，降低 token 占用。它只处理特定的"可压缩工具"：

```typescript
// microCompact.ts
const COMPACTABLE_TOOLS = new Set<string>([
  FILE_READ_TOOL_NAME,    // Read
  ...SHELL_TOOL_NAMES,    // Bash / PowerShell
  GREP_TOOL_NAME,         // Grep
  GLOB_TOOL_NAME,         // Glob
  WEB_SEARCH_TOOL_NAME,   // WebSearch
  WEB_FETCH_TOOL_NAME,    // WebFetch
  FILE_EDIT_TOOL_NAME,    // Edit
  FILE_WRITE_TOOL_NAME,   // Write
])
```

这些工具的输出通常体积大且时效性强——一次 `grep` 可能返回上百行匹配结果，但在几轮对话后，这些细节对模型的价值已经大幅降低。

Microcompact 有两条路径：

### 14.5.1 Time-based Microcompact

当用户离开一段时间后回来继续会话，服务端的 prompt cache 已经过期（默认阈值 60 分钟），完整的 prompt 前缀会被重写。此时提前清理旧工具结果可以减少重写的数据量：

```typescript
// microCompact.ts — evaluateTimeBasedTrigger
const gapMinutes =
  (Date.now() - new Date(lastAssistant.timestamp).getTime()) / 60_000
if (!Number.isFinite(gapMinutes) || gapMinutes < config.gapThresholdMinutes) {
  return null
}
```

它保留最近 N 个（由 `keepRecent` 配置，默认 5 个）工具结果，将其余的替换为占位符 `[Old tool result content cleared]`。

### 14.5.2 Cached Microcompact

Cached Microcompact 是一种更精巧的方案。它不修改本地消息内容，而是通过 API 层的 `cache_edits` 机制告诉服务端"删除"特定的工具结果。这样做的好处是**不会破坏已有的 prompt cache 前缀**——对于一个活跃的长会话，cache hit 意味着显著的延迟和成本节省。

```typescript
// microCompact.ts — cachedMicrocompactPath
// 不修改本地消息 — cache_reference 和 cache_edits 在 API 层添加
// Return messages unchanged
return {
  messages,
  compactionInfo: {
    pendingCacheEdits: {
      trigger: 'auto',
      deletedToolIds: toolsToDelete,
      baselineCacheDeletedTokens: baseline,
    },
  },
}
```

## 14.6 Auto-compact：自动压缩

当 token 使用量接近 Context Window 上限时，Auto-compact 是最核心的压缩机制。它会调用 LLM 对整段对话生成结构化摘要，然后用摘要替换全部旧消息。

### 14.6.1 触发阈值

触发阈值的计算考虑了多个因素：

```typescript
// autoCompact.ts
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000

export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)
  return effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS
}

export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,  // 20,000
  )
  let contextWindow = getContextWindowForModel(model, getSdkBetas())
  return contextWindow - reservedTokensForSummary
}
```

以 200K Context Window 的模型为例：有效窗口 = 200K - 20K（摘要输出保留）= 180K，触发阈值 = 180K - 13K = 167K。也就是说，当 token 使用量达到约 **83%** 时就会触发自动压缩，留出足够的缓冲区完成压缩操作本身。

### 14.6.2 熔断机制

一个重要的工程细节是**熔断器**（Circuit Breaker）。如果压缩连续失败 3 次，系统会停止重试，避免在无法恢复的场景（如 prompt 本身就超长）下浪费 API 调用：

```typescript
// autoCompact.ts
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

if (
  tracking?.consecutiveFailures !== undefined &&
  tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
) {
  return { wasCompacted: false }
}
```

源码注释中提到：曾有 1,279 个会话出现 50 次以上连续失败（最多 3,272 次），每天浪费约 250K 次 API 调用。这个熔断器正是对此的修复。

### 14.6.3 压缩流程

Auto-compact 首先尝试 **Session Memory Compact**，失败后才回退到传统的 LLM 摘要压缩：

```typescript
// autoCompact.ts — autoCompactIfNeeded
// 优先尝试 Session Memory 压缩
const sessionMemoryResult = await trySessionMemoryCompaction(
  messages, toolUseContext.agentId, recompactionInfo.autoCompactThreshold,
)
if (sessionMemoryResult) {
  // 使用 Session Memory 结果
  return { wasCompacted: true, compactionResult: sessionMemoryResult }
}

// 回退到传统 LLM 摘要压缩
const compactionResult = await compactConversation(
  messages, toolUseContext, cacheSafeParams,
  true,      // suppressFollowUpQuestions
  undefined, // customInstructions
  true,      // isAutoCompact
  recompactionInfo,
)
```

**Session Memory Compact** 利用后台持续提取的会话记忆（Session Memory）作为摘要来源，无需额外的 LLM 调用。它通过 `calculateMessagesToKeepIndex` 计算需要保留的近期消息，保证至少保留 10,000 token 和 5 条含文本的消息，上限 40,000 token：

```typescript
// sessionMemoryCompact.ts
export const DEFAULT_SM_COMPACT_CONFIG: SessionMemoryCompactConfig = {
  minTokens: 10_000,
  minTextBlockMessages: 5,
  maxTokens: 40_000,
}
```

**传统 LLM 摘要压缩**（`compactConversation`）则将完整对话发送给一个 fork 出的 Agent，由其生成九部分的结构化摘要（Primary Request、Key Technical Concepts、Files and Code Sections、Errors and Fixes 等）。摘要 prompt 要求模型先在 `<analysis>` 标签中进行分析草稿，然后输出正式的 `<summary>`。`formatCompactSummary` 函数在后处理时会剥离 `<analysis>` 块——这是一种"思维链即丢弃"的技巧，分析过程提升了摘要质量，但不会占用压缩后的上下文空间。

### 14.6.4 压缩后的上下文重建

压缩完成后，系统不是简单地插入一条摘要就完事了。`buildPostCompactMessages` 函数构建了完整的压缩后消息序列：

```typescript
// compact.ts
export function buildPostCompactMessages(result: CompactionResult): Message[] {
  return [
    result.boundaryMarker,       // 压缩边界标记
    ...result.summaryMessages,   // 摘要消息
    ...(result.messagesToKeep ?? []),  // 保留的近期消息
    ...result.attachments,       // 附件（文件内容、计划等）
    ...result.hookResults,       // Hook 结果（CLAUDE.md 等）
  ]
}
```

压缩后还会通过 `fileStateCache` 恢复关键文件。系统在压缩前保存了文件状态缓存的快照，压缩后会从中挑选最多 5 个最近访问的文件（`POST_COMPACT_MAX_FILES_TO_RESTORE = 5`），每个文件最多 5,000 token，总预算 50,000 token，重新注入为附件。这确保模型在压缩后仍然"记得"它正在编辑的文件内容。

## 14.7 Reactive Compact：响应式压缩

Reactive Compact 是最后一道防线。当 API 返回 `prompt_too_long` 错误时，说明 Auto-compact 没能及时触发（或被禁用），此时必须紧急压缩。

在 `query.ts` 的主循环中，当检测到 `prompt_too_long` 响应时，系统不会立即将错误暴露给用户，而是先"扣留"（withhold）这条消息，然后尝试 Reactive Compact：

```typescript
// query.ts — 流式循环中的错误拦截
if (reactiveCompact?.isWithheldPromptTooLong(message)) {
  withheld = true
}
// ...
if ((isWithheld413 || isWithheldMedia) && reactiveCompact) {
  const compacted = await reactiveCompact.tryReactiveCompact({
    hasAttempted: hasAttemptedReactiveCompact,
    messages: messagesForQuery,
    // ...
  })
}
```

Reactive Compact 基于 `groupMessagesByApiRound` 将消息按 API 回合分组，然后逐组从尾部剥离，直到上下文大小重新回到安全范围。它是响应式的——只在错误实际发生时才触发，但也意味着已经浪费了一次 API 调用。

## 14.8 文件状态缓存：fileStateCache

`FileStateCache` 是整个压缩体系中不可或缺的辅助设施。它基于 LRU 策略缓存最近读取过的文件内容：

```typescript
// fileStateCache.ts
export class FileStateCache {
  private cache: LRUCache<string, FileState>

  constructor(maxEntries: number, maxSizeBytes: number) {
    this.cache = new LRUCache<string, FileState>({
      max: maxEntries,          // 默认 100 个文件
      maxSize: maxSizeBytes,     // 默认 25MB
      sizeCalculation: value => Math.max(1, Buffer.byteLength(value.content)),
    })
  }
}
```

`FileState` 记录了文件内容、时间戳和读取范围（offset / limit），还有一个 `isPartialView` 标记表示是否只看到了部分内容（如被截断的 CLAUDE.md）。

在压缩时，`cacheToObject` 将缓存导出为快照。压缩后，系统从快照中恢复最重要的文件到新的上下文中。所有路径在存取前都经过 `normalize` 处理，确保不同写法的路径（如 `/foo/../bar` 和 `/bar`）命中同一缓存条目。

## 14.9 小结：质量与成本的平衡术

Claude Code 的上下文压缩体系展现了一种精心设计的分层策略：

| 层级 | 机制 | 触发条件 | 代价 | 信息损失 |
|------|------|---------|------|---------|
| L0 | Snip | 模型主动调用 | 零 API 开销 | 精确控制 |
| L1 | Microcompact | 每次请求前 | 零 API 开销 | 仅清除旧工具输出 |
| L2 | Auto-compact | ~83% 窗口占用 | 一次 LLM 调用 | 结构化摘要 |
| L3 | Reactive Compact | API 413 错误 | 一次浪费的调用 | 紧急截断 |

这种设计的核心智慧在于：**不要等到最后一刻才压缩，而是在多个阶段渐进式地释放空间**。Snip 和 Microcompact 几乎零成本地持续减缓上下文增长；Auto-compact 在安全阈值触发，有充足的空间完成高质量摘要；Reactive Compact 则作为最后的安全网，确保系统在任何情况下都不会彻底崩溃。

同时，熔断器、Session Memory 复用、prompt cache 保护等机制，都体现了对 API 成本的精打细算。在 Claude Code 这种高频调用的产品中，每一次不必要的 API 调用乘以全球用户规模，都是实实在在的成本。

在下一章中，我们将探讨 Claude Code 的会话持久化与恢复机制——当用户关闭终端后重新打开，整个对话状态如何从磁盘恢复，以及压缩边界标记在这一过程中扮演的关键角色。
