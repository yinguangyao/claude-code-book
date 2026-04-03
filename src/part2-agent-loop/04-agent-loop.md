# 第 4 章 Agent Loop——一次对话的完整生命周期

> 本章是全书最核心的一章。理解了 Agent Loop，你就理解了 Claude Code 的灵魂。

## 4.1 什么是 Agent Loop

当你在终端里输入一个问题，按下回车，Claude Code 并不只是做了一次 API 调用。它做的事情远比这复杂——它启动了一个**循环**。

这个循环的本质可以用一句话概括：

> **调用模型 → 解析响应 → 执行工具 → 回传结果 → 继续调用模型**

这就是 Agent 与普通聊天机器人的根本区别。聊天机器人是"一问一答"的，而 Agent 是"一问多做"的。用户提出一个需求，Agent 会自主决定需要调用哪些工具、按什么顺序执行，直到任务完成才停下来。

这个循环在 Claude Code 中的实现，全部集中在一个文件里：`src/query.ts`。这是整个项目里最重要、最复杂的文件，接下来我们将逐段拆解它。

## 4.2 架构总览

![Agent Loop 流程](/images/ch04-agent-loop.png)

在深入代码之前，先来看 Agent Loop 的完整流程图：

```
用户输入
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│                    query() 入口                          │
│  · 初始化状态（State）                                    │
│  · 创建 budgetTracker                                    │
│  · 启动 memory prefetch                                  │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
               ┌──────────────┐
               │  while(true) │ ◄──────────────────────────┐
               └──────┬───────┘                            │
                      │                                    │
                      ▼                                    │
        ┌─────────────────────────────┐                    │
        │  预处理阶段                  │                    │
        │  · applyToolResultBudget    │                    │
        │  · snipCompact / microcompact│                    │
        │  · contextCollapse          │                    │
        │  · autocompact              │                    │
        │  · 构建 systemPrompt        │                    │
        │  · token 阻塞检查           │                    │
        └─────────────┬───────────────┘                    │
                      │                                    │
                      ▼                                    │
        ┌─────────────────────────────┐                    │
        │  调用 Claude API（流式）     │                    │
        │  deps.callModel({...})      │                    │
        │  · 流式接收 assistant 消息   │                    │
        │  · 收集 tool_use blocks     │                    │
        │  · 流式执行工具（可选）      │                    │
        └─────────────┬───────────────┘                    │
                      │                                    │
                      ▼                                    │
              needsFollowUp?                               │
              ┌───┴───┐                                    │
          No  │       │ Yes                                │
              ▼       ▼                                    │
        ┌──────┐  ┌──────────────────────┐                 │
        │ 终止  │  │ 执行工具             │                 │
        │ 判断  │  │ · runTools / streaming│                 │
        └──┬───┘  │ · 收集 toolResults   │                 │
           │      │ · 获取 attachments   │                 │
           │      └──────────┬───────────┘                 │
           │                 │                             │
           │                 ▼                             │
           │      ┌──────────────────────┐                 │
           │      │ 组装下一轮消息        │                 │
           │      │ messages + assistant  │                 │
           │      │ + toolResults         │                 │
           │      └──────────┬───────────┘                 │
           │                 │                             │
           │                 └─────────────────────────────┘
           ▼
     return Terminal
     （completed / aborted / error...）
```

整个流程可以分为三大阶段：**预处理**、**模型调用**和**工具执行**。每一轮循环都经历这三个阶段，直到模型判断任务完成（不再产出 `tool_use` block），循环才会终止。

## 4.3 源码走读

### 4.3.1 入口函数与状态初始化

`query.ts` 导出了两个关键函数。外层的 `query()` 是公开入口，内层的 `queryLoop()` 是真正的循环体：

```typescript
export async function* query(
  params: QueryParams,
): AsyncGenerator<StreamEvent | RequestStartEvent | Message | TombstoneMessage | ToolUseSummaryMessage, Terminal> {
  const consumedCommandUuids: string[] = []
  const terminal = yield* queryLoop(params, consumedCommandUuids)
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}
```

注意这里的 `async function*` 语法——这是一个**异步生成器**。这个设计选择非常重要，我们稍后会专门讨论。`query()` 的职责很简单：委托给 `queryLoop()` 执行，完成后通知命令队列中被消费的命令已完成。

进入 `queryLoop()`，首先映入眼帘的是状态初始化：

```typescript
let state: State = {
  messages: params.messages,
  toolUseContext: params.toolUseContext,
  maxOutputTokensOverride: params.maxOutputTokensOverride,
  autoCompactTracking: undefined,
  stopHookActive: undefined,
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  turnCount: 1,
  pendingToolUseSummary: undefined,
  transition: undefined,
}
```

`State` 是循环迭代之间传递的可变状态。每个字段都有明确职责：

- **messages**：当前的完整对话历史，是每一轮循环的核心输入
- **toolUseContext**：工具执行的上下文，包含可用工具列表、权限、abort 信号等
- **turnCount**：当前是第几轮循环，用于 `maxTurns` 限制检查
- **maxOutputTokensRecoveryCount**：输出 token 截断恢复的次数，上限为 3
- **hasAttemptedReactiveCompact**：是否已经尝试过响应式压缩，防止无限重试
- **transition**：上一次迭代是因为什么原因 `continue` 的，用于调试和断言

此外，`buildQueryConfig()` 会在入口处一次性快照不可变的环境配置（如 feature gate 状态），避免循环中途配置变化导致行为不一致。

### 4.3.2 循环主体：while(true)

真正的循环从一个朴素的 `while (true)` 开始。每轮迭代的开头，先解构当前状态：

```typescript
while (true) {
  let { toolUseContext } = state
  const { messages, autoCompactTracking, maxOutputTokensRecoveryCount, ... } = state
```

然后进入**预处理管线**。这条管线做了大量工作来准备发送给 API 的消息数组：

1. **applyToolResultBudget** — 对工具结果施加大小预算，防止过大的工具输出撑爆上下文
2. **snipCompact** — 裁剪历史对话中冗余的部分（feature gate 控制）
3. **microcompact** — 微观压缩，对工具结果做细粒度的缩减
4. **contextCollapse** — 上下文折叠，将早期对话折叠成摘要（feature gate 控制）
5. **autocompact** — 自动压缩，当上下文超过阈值时调用模型生成对话摘要

这五步处理形成了一条完整的**上下文管理管线**，其核心目标是：在保留关键信息的前提下，尽可能减少发送给 API 的 token 数量。

压缩完成后，构建系统提示：

```typescript
const fullSystemPrompt = asSystemPrompt(
  appendSystemContext(systemPrompt, systemContext),
)
```

### 4.3.3 调用 Claude API：流式处理

预处理完成后，进入最关键的部分——调用 Claude API：

```typescript
for await (const message of deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),
  systemPrompt: fullSystemPrompt,
  thinkingConfig: toolUseContext.options.thinkingConfig,
  tools: toolUseContext.options.tools,
  signal: toolUseContext.abortController.signal,
  options: {
    model: currentModel,
    fallbackModel,
    maxOutputTokensOverride,
    querySource,
    // ... 更多选项
  },
})) {
```

`deps.callModel` 返回一个异步迭代器，Claude API 的响应通过流式传输逐块到达。外层的 `for await` 循环逐条处理这些消息。

注意这里使用了**依赖注入**模式：`deps` 默认是 `productionDeps()`，但测试时可以替换为 mock 实现。这是 `query.ts` 可测试性的关键设计。

在流式处理循环内部，有几个核心操作：

**收集 tool_use blocks：**

```typescript
if (message.type === 'assistant') {
  assistantMessages.push(message)
  const msgToolUseBlocks = message.message.content.filter(
    content => content.type === 'tool_use',
  ) as ToolUseBlock[]
  if (msgToolUseBlocks.length > 0) {
    toolUseBlocks.push(...msgToolUseBlocks)
    needsFollowUp = true  // 标记需要继续循环
  }
}
```

这里的 `needsFollowUp` 是循环是否继续的关键信号。只要模型产出了 `tool_use` block，就意味着它想调用工具，循环就必须继续。

**流式工具执行：**

```typescript
if (streamingToolExecutor && !toolUseContext.abortController.signal.aborted) {
  for (const toolBlock of msgToolUseBlocks) {
    streamingToolExecutor.addTool(toolBlock, message)
  }
}
```

当流式工具执行功能开启时，工具不会等到 API 响应全部结束才开始执行——而是在收到 `tool_use` block 的瞬间就开始。这意味着**模型还在生成后续输出时，前面的工具已经在并行执行了**。这是一个精妙的性能优化。

**错误消息暂扣（Withholding）：**

```typescript
let withheld = false
if (reactiveCompact?.isWithheldPromptTooLong(message)) {
  withheld = true
}
if (isWithheldMaxOutputTokens(message)) {
  withheld = true
}
if (!withheld) {
  yield yieldMessage
}
```

这是一个非常巧妙的设计。当 API 返回 `prompt_too_long` 或 `max_output_tokens` 错误时，不立即 yield 给调用方，而是先**暂扣**住。因为循环后面有恢复逻辑可能会处理这些错误——如果恢复成功，调用方永远不知道发生过错误；如果恢复失败，才把错误释放出去。

### 4.3.4 Fallback 机制

API 调用外层还包裹了一层 fallback 循环：

```typescript
let attemptWithFallback = true
while (attemptWithFallback) {
  attemptWithFallback = false
  try {
    // ... 调用 API
  } catch (innerError) {
    if (innerError instanceof FallbackTriggeredError && fallbackModel) {
      currentModel = fallbackModel
      attemptWithFallback = true
      // 清理已收集的消息，重新开始
      assistantMessages.length = 0
      toolResults.length = 0
      toolUseBlocks.length = 0
      needsFollowUp = false
    }
  }
}
```

当主模型不可用（比如高负载时），系统会自动切换到 fallback 模型重试整个请求。切换前会清理所有中间状态，包括已经收到的 assistant 消息——因为那些是来自旧模型的不完整响应。已产出的 assistant 消息会通过 `tombstone` 事件通知 UI 删除：

```typescript
for (const msg of assistantMessages) {
  yield { type: 'tombstone' as const, message: msg }
}
```

### 4.3.5 循环终止条件

API 响应处理完毕后，代码进入终止判断。`needsFollowUp` 为 `false` 意味着模型没有请求工具调用，正常情况下循环应该结束。但在此之前，还有一系列检查：

**1. Prompt-too-long 恢复**

如果 API 返回了被暂扣的 413 错误，会先尝试 context collapse drain（释放已暂存的上下文折叠），失败则尝试 reactive compact（触发一次完整压缩）：

```typescript
if (isWithheld413) {
  // 先尝试 collapse drain
  const drained = contextCollapse.recoverFromOverflow(messagesForQuery, querySource)
  if (drained.committed > 0) {
    state = next  // 更新状态
    continue      // 重新进入循环
  }
}
// 再尝试 reactive compact
if ((isWithheld413 || isWithheldMedia) && reactiveCompact) {
  const compacted = await reactiveCompact.tryReactiveCompact({...})
  if (compacted) {
    state = next
    continue
  }
}
```

**2. Max output tokens 恢复**

当模型输出被截断时，有两层恢复策略：

- **第一层：token 上限升级**——如果当前使用的是默认的 8k 上限，先升级到 64k 重试
- **第二层：多轮恢复**——注入一条提示消息让模型继续，最多重试 3 次

```typescript
if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
  const recoveryMessage = createUserMessage({
    content: `Output token limit hit. Resume directly — no apology, no recap...`,
    isMeta: true,
  })
  state = {
    messages: [...messagesForQuery, ...assistantMessages, recoveryMessage],
    maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
    // ...
  }
  continue
}
```

注意 `recoveryMessage` 的内容精心设计：要求模型"直接继续，不要道歉，不要回顾"。这是与 LLM 交互的实战经验——如果不这样要求，模型往往会浪费大量 token 来解释它被截断了。

**3. Stop hooks**

通过 `handleStopHooks` 执行用户配置的停止钩子，钩子可以选择阻止循环终止或注入错误消息让模型重新执行。

**4. Token budget 检查**

检查是否达到了 token 预算。如果还有余量，注入 nudge 消息让模型继续工作：

```typescript
if (decision.action === 'continue') {
  incrementBudgetContinuationCount()
  state = {
    messages: [...messagesForQuery, ...assistantMessages,
      createUserMessage({ content: decision.nudgeMessage, isMeta: true })],
    transition: { reason: 'token_budget_continuation' },
    // ...
  }
  continue
}
```

**5. MaxTurns 限制**

最简单直接的终止条件：

```typescript
if (maxTurns && nextTurnCount > maxTurns) {
  yield createAttachmentMessage({ type: 'max_turns_reached', maxTurns, turnCount: nextTurnCount })
  return { reason: 'max_turns', turnCount: nextTurnCount }
}
```

**6. 用户中断**

贯穿整个循环，在 API 调用后和工具执行后都会检查 `abortController.signal.aborted`。用户按 Ctrl+C 时会触发 abort 信号，循环会优雅地清理状态并退出。

### 4.3.6 工具执行与下一轮准备

当 `needsFollowUp` 为 `true` 时，进入工具执行阶段：

```typescript
const toolUpdates = streamingToolExecutor
  ? streamingToolExecutor.getRemainingResults()
  : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)

for await (const update of toolUpdates) {
  if (update.message) {
    yield update.message
    toolResults.push(
      ...normalizeMessagesForAPI([update.message], toolUseContext.options.tools)
        .filter(_ => _.type === 'user'),
    )
  }
}
```

这里有两种执行模式：如果启用了流式工具执行器（`StreamingToolExecutor`），大部分工具在 API 响应期间已经开始执行了，这里只需要收集剩余结果；否则走传统的 `runTools` 路径，顺序执行所有工具。

工具执行完毕后，还要处理**附件**（attachments）——包括 memory prefetch 的结果、skill discovery 的结果、以及命令队列中的通知等。这些额外信息会作为下一轮对话的上下文一起发送给模型。

最后，组装下一轮的状态并 `continue`：

```typescript
const next: State = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  toolUseContext: toolUseContextWithQueryTracking,
  autoCompactTracking: tracking,
  turnCount: nextTurnCount,
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  pendingToolUseSummary: nextPendingToolUseSummary,
  transition: { reason: 'next_turn' },
}
state = next
```

消息数组不断增长：原始消息 + 模型回复 + 工具结果，构成下一轮的输入。这就是 Agent Loop 的"记忆"机制——一切都在消息数组里。

### 4.3.7 为什么用 async generator

你可能注意到了，`query()` 和 `queryLoop()` 都使用了 `async function*` 语法，返回 `AsyncGenerator`。这不是一个随意的选择，而是精心设计的结果。

**第一，流式产出进度事件。** 循环内部通过 `yield` 产出各种事件——assistant 消息、tool result、attachment、tombstone、system message 等。UI 层（如 `print.ts`）通过 `for await` 消费这些事件，实现实时渲染。用户可以看到模型正在思考、正在执行哪个工具、工具的输出是什么，一切都是实时的。

**第二，自然的生命周期管理。** 当用户中断时，调用方可以调用 generator 的 `.return()` 方法，这会触发 `using` 声明的资源（如 `pendingMemoryPrefetch`）自动释放。不需要手动管理清理逻辑。

**第三，背压控制。** Generator 天生支持背压——如果消费方处理慢了，生产方会自然暂停在 `yield` 处等待。这防止了快速的 API 响应淹没慢速的 UI 渲染。

与之对比，如果用回调（callback）或 EventEmitter，需要手动管理状态、清理和背压，代码会复杂得多。

### 4.3.8 状态流转总结

整个循环的状态流转可以用 `transition.reason` 字段追踪。一共有以下几种 continue 原因：

| transition.reason | 触发条件 | 说明 |
|---|---|---|
| `next_turn` | 工具执行完毕 | 正常的循环继续 |
| `max_output_tokens_escalate` | 输出被截断 | 升级 token 上限重试 |
| `max_output_tokens_recovery` | 输出被截断（升级后仍截断） | 注入恢复消息继续 |
| `reactive_compact_retry` | prompt 过长 | 响应式压缩后重试 |
| `collapse_drain_retry` | prompt 过长 | 释放折叠后重试 |
| `stop_hook_blocking` | stop hook 阻止结束 | 注入错误消息重试 |
| `token_budget_continuation` | token 预算未用完 | 注入 nudge 消息继续 |

而终止（return）的原因有：`completed`（正常完成）、`aborted_streaming`/`aborted_tools`（用户中断）、`model_error`（API 错误）、`max_turns`（达到轮次上限）、`prompt_too_long`（上下文过长且恢复失败）、`hook_stopped`（钩子阻止继续）等。

## 4.4 小结

回顾整个 Agent Loop，它的设计哲学可以概括为：

**简单的循环，强大的能力。**

核心只是一个 `while (true)` 加一个 `needsFollowUp` 判断。但围绕这个简单骨架，堆叠了一层又一层精密的机制：

- **上下文管理**：五级压缩管线确保长对话不会 token 溢出
- **错误恢复**：prompt-too-long、max-output-tokens、模型不可用，每种错误都有对应的恢复策略
- **性能优化**：流式工具执行、memory prefetch、skill discovery prefetch，多种异步并行策略
- **可观测性**：通过 async generator 的 yield 暴露每一步的进度，UI 可以实时渲染
- **可测试性**：通过依赖注入（deps）隔离外部依赖，便于单元测试

这些机制共同组成了一个健壮的、可扩展的 Agent 执行引擎。而它的所有能力，归根结底都来自那个最朴素的循环：**调用模型 → 执行工具 → 回传结果 → 继续循环**。

---

下一章，我们将深入 `query.ts` 的上游——**QueryEngine**，看看 Agent Loop 是如何被调度和管理的，以及消息队列、会话状态等基础设施是如何与循环协同工作的。
