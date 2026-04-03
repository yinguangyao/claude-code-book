# 第 5 章 QueryEngine——SDK 与无头模式

## 5.1 概念引入：为什么需要 QueryEngine

在前面几章中，我们已经了解了 `query()` 函数如何驱动 Agent 的核心推理循环。`query()` 负责与 Claude API 交互、处理流式响应、调度工具调用，是整个系统的"引擎曲轴"。但 `query()` 本身是一个纯粹的函数——它不管理会话状态，不追踪 token 用量，也不关心调用者是谁。

在实际应用中，Claude Code 面对两种截然不同的使用场景：

1. **有头模式（REPL）**：用户在终端中交互式地与 Claude 对话，每次输入一条消息，等待回复，再输入下一条。
2. **无头模式（SDK / 程序化调用）**：外部程序通过 SDK 接口发送 prompt，接收结构化的事件流，无需人工介入。

这两种模式的底层推理逻辑是相同的——都依赖 `query()` 来完成 LLM 调用和工具执行。区别在于**会话生命周期管理**：谁来维护消息列表？谁来累计 usage？谁来记录权限拒绝？谁来判断何时该停止？

`QueryEngine` 就是为回答这些问题而诞生的。它把 `query()` 封装成一个有状态的类，拥有独立的会话上下文，对外暴露一个简洁的 `submitMessage()` 异步生成器接口。正如源码注释所述：

> QueryEngine owns the query lifecycle and session state for a conversation. It extracts the core logic from ask() into a standalone class that can be used by both the headless/SDK path and (in a future phase) the REPL.

一个 `QueryEngine` 实例对应一次完整的对话。每次调用 `submitMessage()` 代表对话中的一个"轮次"（turn），而会话状态（消息、文件缓存、用量统计等）在轮次之间持续存在。

## 5.2 架构图：QueryEngine 的类结构与事件流

![QueryEngine 架构](/images/ch05-query-engine.png)

下面用一张图来描述 QueryEngine 在整体架构中的位置：

```
┌─────────────────────────────────────────────────────────┐
│                   外部调用方                              │
│         SDK Client / REPL / ask() 便捷函数                │
└──────────────────────┬──────────────────────────────────┘
                       │  submitMessage(prompt)
                       ▼
┌─────────────────────────────────────────────────────────┐
│                   QueryEngine                            │
│                                                          │
│  ┌─────────────────────────────────┐                     │
│  │          会话状态                 │                     │
│  │  mutableMessages: Message[]     │                     │
│  │  totalUsage: NonNullableUsage   │                     │
│  │  permissionDenials: SDKPerm...  │                     │
│  │  readFileState: FileStateCache  │                     │
│  │  abortController               │                     │
│  └─────────────────────────────────┘                     │
│                       │                                  │
│    processUserInput() │ 预处理用户输入                     │
│                       ▼                                  │
│              ┌─────────────┐                             │
│              │   query()   │ ──→ Claude API               │
│              └──────┬──────┘                             │
│                     │ AsyncGenerator<Message>             │
│                     ▼                                    │
│           ┌──────────────────┐                           │
│           │  事件分发 switch  │                            │
│           │  (message.type)  │                            │
│           └──────────────────┘                           │
│             │    │    │    │                              │
│             ▼    ▼    ▼    ▼                              │
│          assistant stream system tool_use_summary        │
│             │    │    │    │                              │
└─────────────┼────┼────┼────┼────────────────────────────┘
              ▼    ▼    ▼    ▼
         yield SDKMessage（结构化事件流）
```

`QueryEngine` 对外产出的事件类型（`SDKMessage`）是一组精心设计的联合类型，包括：

| 事件类型 | 含义 |
|---------|------|
| `system_init` | 会话初始化信息（模型、工具列表、权限模式等） |
| `assistant` | Claude 的回复消息 |
| `user` | 用户消息回放（`replayUserMessages` 模式下） |
| `stream_event` | 底层 API 的流式事件（`message_start`、`message_delta`、`message_stop`） |
| `tool_use_summary` | 工具调用的摘要信息 |
| `system` | 系统事件（`compact_boundary`、`api_retry` 等） |
| `result` | 最终结果（成功、错误、超限等） |

## 5.3 源码走读

### 5.3.1 QueryEngineConfig：配置蓝图

`QueryEngine` 的构造函数接受一个 `QueryEngineConfig` 对象，它定义了引擎运行所需的全部上下文 [QueryEngine.ts]：

```typescript
export type QueryEngineConfig = {
  cwd: string
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  agents: AgentDefinition[]
  canUseTool: CanUseToolFn
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  initialMessages?: Message[]
  readFileCache: FileStateCache
  customSystemPrompt?: string
  appendSystemPrompt?: string
  maxTurns?: number
  maxBudgetUsd?: number
  // ...
}
```

配置项的设计体现了几个关键原则：

- **依赖注入**：`canUseTool`、`getAppState`/`setAppState` 等通过回调注入，而非硬编码依赖。这使得 REPL 和 SDK 可以提供不同的实现。
- **可选覆盖**：`customSystemPrompt`、`userSpecifiedModel`、`thinkingConfig` 等均为可选字段，允许调用方按需定制行为。
- **预算控制**：`maxTurns` 和 `maxBudgetUsd` 提供了两个维度的安全阀——轮次上限和费用上限。

### 5.3.2 类的内部状态

构造函数初始化了五个核心状态字段：

```typescript
export class QueryEngine {
  private mutableMessages: Message[]
  private abortController: AbortController
  private permissionDenials: SDKPermissionDenial[]
  private totalUsage: NonNullableUsage
  private readFileState: FileStateCache
  private discoveredSkillNames = new Set<string>()
  // ...
}
```

- **`mutableMessages`**：消息列表，是整个对话的核心数据结构。每次 `submitMessage()` 调用都会向其追加新消息，跨轮次持久保存。
- **`totalUsage`**：累计的 token 用量（输入、输出、缓存命中等），在每个 `message_stop` 事件时更新。
- **`permissionDenials`**：记录所有被拒绝的工具调用权限请求，最终在 `result` 事件中返回给调用方。
- **`readFileState`**：文件状态缓存，追踪已读取文件的内容快照。
- **`abortController`**：中断控制器，支持通过 `interrupt()` 方法中止正在进行的查询。

值得注意的是 `discoveredSkillNames` 字段——它追踪当前轮次中发现的技能名称，在每次 `submitMessage()` 调用开始时清空，避免在长会话的 SDK 模式下无限增长。

### 5.3.3 submitMessage()：事件流的核心

`submitMessage()` 是 `QueryEngine` 的核心方法，也是整个类中最长的一段代码。它是一个 `AsyncGenerator`，调用方通过 `for await...of` 消费产出的 `SDKMessage` 事件。我们把它的执行流程拆解为六个阶段。

**阶段一：上下文组装**

方法开头做了大量的上下文准备工作：

1. 解析模型配置（用户指定或系统默认）
2. 获取系统提示词（`fetchSystemPromptParts`）
3. 组装用户上下文（`userContext`），包括 Coordinator 模式下的额外上下文
4. 处理 memory 机制提示词（当自定义系统提示词与 `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` 同时存在时）
5. 注册结构化输出的 hook（如果配置了 `jsonSchema`）

这些准备工作的代码略显冗长，但本质上是在构建传给 `query()` 的参数。

**阶段二：权限包装**

`canUseTool` 函数被包装了一层 [QueryEngine.ts]：

```typescript
const wrappedCanUseTool: CanUseToolFn = async (tool, input, ...) => {
  const result = await canUseTool(tool, input, ...)
  if (result.behavior !== 'allow') {
    this.permissionDenials.push({
      tool_name: sdkCompatToolName(tool.name),
      tool_use_id: toolUseID,
      tool_input: input,
    })
  }
  return result
}
```

这是一个典型的装饰器模式：在不修改原始权限判断逻辑的前提下，额外记录每一次权限拒绝。这些记录最终会出现在 `result` 消息的 `permission_denials` 字段中，让 SDK 调用方知道哪些操作被阻止了。

**阶段三：用户输入处理**

调用 `processUserInput()` 对用户输入进行预处理，处理斜杠命令、附件等：

```typescript
const { messages: messagesFromUserInput, shouldQuery, allowedTools, ... }
  = await processUserInput({ input: prompt, mode: 'prompt', ... })
this.mutableMessages.push(...messagesFromUserInput)
```

如果 `shouldQuery` 为 `false`（比如用户输入了一个纯本地命令如 `/compact`），则直接产出本地命令的结果，不调用 API。

**阶段四：系统初始化消息**

进入查询之前，先产出一个 `system_init` 消息：

```typescript
yield buildSystemInitMessage({
  tools, mcpClients, model: mainLoopModel,
  permissionMode, commands, agents, skills, plugins, fastMode,
})
```

这是 SDK 调用方收到的第一个事件，包含了当前会话的完整配置信息——可用工具列表、模型名称、权限模式等。调用方可以据此初始化自己的 UI 或状态。

**阶段五：query() 事件分发**

这是方法的主体——一个巨大的 `for await...of` 循环，消费 `query()` 产出的消息流：

```typescript
for await (const message of query({
  messages, systemPrompt, userContext, systemContext,
  canUseTool: wrappedCanUseTool,
  toolUseContext: processUserInputContext,
  maxTurns, taskBudget, ...
})) {
  switch (message.type) {
    case 'assistant':   // 推送到消息列表，yield 标准化后的 SDKMessage
    case 'user':        // 同上，并递增 turnCount
    case 'stream_event':// 追踪 usage，可选 yield 给调用方
    case 'progress':    // 推送并持久化
    case 'attachment':  // 处理结构化输出、max_turns、排队命令等
    case 'system':      // 处理 compact boundary、API 错误重试、snip 边界
    case 'tool_use_summary': // 直接 yield 给调用方
  }
}
```

每种消息类型的处理逻辑各有侧重，但共同遵循三个原则：

1. **状态更新**：将消息追加到 `mutableMessages`，更新 `totalUsage` 等状态。
2. **持久化**：通过 `recordTranscript()` 将消息写入会话存储，确保断点可恢复。
3. **事件转发**：将内部消息转换为 `SDKMessage` 格式 yield 给调用方。

其中 `stream_event` 的处理尤其值得关注——它追踪了 `message_start`、`message_delta`、`message_stop` 三个阶段的 usage 数据：

```typescript
if (message.event.type === 'message_start') {
  currentMessageUsage = updateUsage(currentMessageUsage, message.event.message.usage)
}
if (message.event.type === 'message_delta') {
  currentMessageUsage = updateUsage(currentMessageUsage, message.event.usage)
}
if (message.event.type === 'message_stop') {
  this.totalUsage = accumulateUsage(this.totalUsage, currentMessageUsage)
}
```

这种分阶段累计的设计，是因为 Anthropic API 的流式协议将 usage 信息分散在不同的事件中。

循环体的末尾还有两个"安全阀"检查：

- **费用上限**：`getTotalCost() >= maxBudgetUsd` 时产出 `error_max_budget_usd` 结果并终止。
- **结构化输出重试上限**：当 `jsonSchema` 验证反复失败超过阈值（默认 5 次）时终止。

**阶段六：结果产出**

循环结束后，从消息列表中提取最终结果：

```typescript
const result = messages.findLast(m => m.type === 'assistant' || m.type === 'user')
```

通过 `isResultSuccessful()` 判断是否成功，然后产出对应的 `result` 消息。成功时包含 `textResult`（最后一个文本块的内容）；失败时包含诊断信息和错误日志。

### 5.3.4 有头 vs 无头的统一抽象

`QueryEngine` 的设计巧妙地隔离了交互模式的差异。以下是几个关键的统一点：

**回调注入实现多态**。`canUseTool` 在 REPL 模式下弹出终端提示框让用户确认；在 SDK 模式下根据预设规则自动判断。`QueryEngine` 不关心具体实现，只关心返回值是 `allow` 还是 `deny`。

**`ProcessUserInputContext` 中的 noop**。在 SDK 模式下，许多 REPL 特有的回调被设为空操作：

```typescript
setInProgressToolUseIDs: () => {},
setResponseLength: () => {},
onChangeAPIKey: () => {},
isNonInteractiveSession: true,
```

这些字段在 REPL 中驱动 UI 更新（如进度条、响应长度显示），在无头模式下则静默跳过。

**`ask()` 便捷函数**。源码底部导出了一个 `ask()` 函数，它是 `QueryEngine` 的"一次性"包装：创建实例、调用 `submitMessage()`、最后回写文件缓存。这为简单的 fire-and-forget 场景提供了更简洁的 API：

```typescript
export async function* ask({ prompt, tools, ... }) {
  const engine = new QueryEngine({ ... })
  try {
    yield* engine.submitMessage(prompt, { uuid: promptUuid, isMeta })
  } finally {
    setReadFileCache(engine.getReadFileState())
  }
}
```

### 5.3.5 会话管理的细节

**消息持久化与恢复**。`QueryEngine` 在多个时机调用 `recordTranscript()` 持久化会话：

- 用户消息发出后立即写入（防止进程被杀后丢失用户输入）
- 每个 assistant 消息到达时 fire-and-forget 写入
- compact boundary 前先 flush 保留段尾部的消息

对于 bare 模式（脚本化调用），用户消息的持久化是 fire-and-forget 的——不阻塞主流程，因为脚本化调用通常不需要 `--resume`。而在 cowork 模式下会额外调用 `flushSessionStorage()` 确保数据落盘。

**Compact Boundary 与内存管理**。当对话过长触发压缩时，`query()` 会产出一个 `compact_boundary` 系统消息。`QueryEngine` 收到后会截断 `mutableMessages` 和 `messages` 数组，只保留边界之后的消息：

```typescript
const mutableBoundaryIdx = this.mutableMessages.length - 1
if (mutableBoundaryIdx > 0) {
  this.mutableMessages.splice(0, mutableBoundaryIdx)
}
```

这对于长时间运行的 SDK 会话至关重要——没有 UI 需要保留完整历史，及时释放内存是必须的。

**Snip Replay**。除了 compact boundary，还有一个更轻量的历史裁剪机制——snip。它通过注入的 `snipReplay` 回调实现，当 `HISTORY_SNIP` feature flag 开启时，会在收到 snip boundary 消息时对 `mutableMessages` 进行就地替换。这个机制被设计为可注入的回调，是为了让 feature-gated 的字符串不出现在 `QueryEngine` 的源码中，保持文件在测试时的可编译性。

## 5.4 小结：如何设计一个既能交互又能编程调用的 Agent 引擎

`QueryEngine` 的设计给我们提供了一个优秀的范本——如何让同一套 Agent 核心逻辑同时服务于交互式和程序化两种场景。其核心策略可以归纳为：

1. **分离关注点**：推理逻辑（`query()`）与会话管理（`QueryEngine`）分层。`query()` 只管"思考和行动"，`QueryEngine` 管"生命周期和上下文"。
2. **依赖注入**：通过回调函数注入行为差异（权限判断、状态更新、UI 回调），而非在引擎内部做条件分支。
3. **AsyncGenerator 作为通信协议**：`submitMessage()` 返回 `AsyncGenerator<SDKMessage>`，调用方可以流式消费事件，也可以收集全部结果。这比回调或 EventEmitter 模式更符合 TypeScript 的类型系统，也更容易组合。
4. **内建安全阀**：费用上限、轮次上限、结构化输出重试上限——三道防线确保程序化调用不会失控。
5. **便捷包装**：`ask()` 函数为一次性调用提供简洁入口，`QueryEngine` 类为多轮对话提供完整控制。

这种"类管状态、函数管逻辑、生成器管通信"的三层设计，是构建生产级 Agent SDK 的一种值得借鉴的模式。

---

在下一章中，我们将深入 Tool 接口的设计——工具是 Agent 与外部世界交互的桥梁，而 Claude Code 如何定义、注册、调度这些工具，将是理解整个系统的又一关键拼图。
