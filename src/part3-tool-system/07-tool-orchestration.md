# 第 7 章 工具编排与并发控制

当 LLM 在一次响应中返回多个 `tool_use` 块时，Claude Code 需要在"尽可能快"和"绝对安全"之间做出抉择。同时读取三个文件显然可以并行，但如果其中夹杂一条 `rm -rf` 呢？本章将深入源码，剖析 Claude Code 是如何在工具编排层面解决这一经典的"吞吐量 vs 安全性"矛盾的。

## 7.1 问题域：一次响应，多个工具调用

Anthropic API 的 `messages` 接口允许模型在一条 assistant 消息中同时返回多个 `tool_use` 内容块。例如，模型可能一次性要求：

1. `Grep` 搜索某个模式
2. `Read` 读取一个文件
3. `Bash` 执行 `git diff`

这三个操作如果依次串行执行，延迟是三者之和。而如果能并行，总延迟约等于最慢的那个。但问题在于——并非所有工具都可以安全地并发执行。一个写文件的 `Edit` 操作和一个读同一文件的 `Read` 操作如果并行，可能读到中间状态；两个 `Bash` 命令如果存在隐式依赖（`mkdir` 后接 `cd`），并行执行会导致第二条命令失败。

Claude Code 的工具编排系统正是为解决这一问题而设计的。

## 7.2 架构概览：分批策略

![工具编排与并发控制](/images/ch07-tool-orchestration.png)

整体编排架构遵循一个核心原则：**只读工具并行，写操作串行**。系统提供了两条执行路径，根据功能开关 `streamingToolExecution` 选择其一：

```
模型返回 N 个 tool_use 块
        │
        ├─ 非流式路径 ──→ toolOrchestration.runTools()
        │                    │
        │                    ├─ partitionToolCalls() 分批
        │                    │    ├─ 连续只读工具 → 一个并发批次
        │                    │    └─ 写操作工具   → 单独一个串行批次
        │                    │
        │                    ├─ 并发批次 → runToolsConcurrently()
        │                    │              (最多 10 并发，all() 调度)
        │                    │
        │                    └─ 串行批次 → runToolsSerially()
        │
        └─ 流式路径 ──→ StreamingToolExecutor
                         │
                         ├─ addTool() 逐个接收
                         ├─ canExecuteTool() 实时判定
                         └─ processQueue() 动态调度
```

两条路径共享同一套并发安全判定逻辑 `isConcurrencySafe`，但调度时机不同：非流式路径在所有 `tool_use` 块到齐后一次性分批；流式路径则在每个块从流中解析出来时即刻决策，做到了真正的"边流式解析，边并行执行"。

## 7.3 源码走读

### 7.3.1 分批逻辑：partitionToolCalls

[`toolOrchestration.ts`] 中的 `partitionToolCalls` 函数是非流式路径的核心。它将 `tool_use` 数组按顺序扫描，将连续的并发安全工具合并为一个批次，遇到非安全工具则单独成批：

```typescript
function partitionToolCalls(
  toolUseMessages: ToolUseBlock[],
  toolUseContext: ToolUseContext,
): Batch[] {
  return toolUseMessages.reduce((acc: Batch[], toolUse) => {
    const tool = findToolByName(toolUseContext.options.tools, toolUse.name)
    const parsedInput = tool?.inputSchema.safeParse(toolUse.input)
    const isConcurrencySafe = parsedInput?.success
      ? (() => {
          try {
            return Boolean(tool?.isConcurrencySafe(parsedInput.data))
          } catch {
            return false
          }
        })()
      : false
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1]!.blocks.push(toolUse)
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] })
    }
    return acc
  }, [])
}
```

这段代码的设计值得关注的有几点：

1. **Schema 验证前置**：在判定并发安全性之前，先用 Zod schema 做 `safeParse`。如果输入不合法（解析失败），直接标记为不安全——这是一种典型的 fail-closed 策略。
2. **异常兜底**：`isConcurrencySafe` 调用本身被 `try-catch` 包裹。例如 `BashTool` 的实现需要解析 shell 命令，如果 `shell-quote` 解析失败会抛异常，此时保守地返回 `false`。
3. **贪心合并**：连续的并发安全工具会被合并到同一批次。但一旦遇到一个非安全工具，批次就会被"切断"，即使后续还有安全工具，也会开启新的批次。这保证了执行顺序的正确性。

举个例子，如果模型返回 `[Grep, Read, Edit, Glob, Read]`，分批结果为：

| 批次 | 工具 | 模式 |
|------|------|------|
| 1 | Grep, Read | 并行 |
| 2 | Edit | 串行 |
| 3 | Glob, Read | 并行 |

### 7.3.2 并发执行与限流

并行批次交由 `runToolsConcurrently` 处理，其核心依赖 [`generators.ts`] 中的 `all()` 工具函数：

```typescript
async function* runToolsConcurrently(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdateLazy, void> {
  yield* all(
    toolUseMessages.map(async function* (toolUse) {
      // ...
      yield* runToolUse(toolUse, ...)
      markToolUseAsComplete(toolUseContext, toolUse.id)
    }),
    getMaxToolUseConcurrency(),
  )
}
```

`all()` 函数是一个带并发上限的异步生成器调度器。它维护一个"正在运行"的 Promise 集合，当集合未满时从等待队列中取出新的生成器启动，当某个生成器完成时立即补充新的。默认并发上限为 10，可通过环境变量 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 覆盖：

```typescript
function getMaxToolUseConcurrency(): number {
  return (
    parseInt(process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY || '', 10) || 10
  )
}
```

值得注意的是，`all()` 采用 `Promise.race` 模式——哪个生成器先 yield 出值，就先处理哪个，实现了结果的"尽早交付"。

### 7.3.3 isConcurrencySafe 的判定逻辑

`isConcurrencySafe` 是 [`Tool.ts`] 中 `Tool` 接口的一个必须实现的方法。通过 `buildTool` 提供的默认值是 `false`——即**默认不安全**，这是 fail-closed 的安全默认值。

各工具的实现策略可以分为三类：

**第一类：无条件安全。** 纯只读工具始终返回 `true`：

- `GrepTool`、`GlobTool`、`FileReadTool`：文件搜索和读取，不会改变任何状态
- `WebSearchTool`、`WebFetchTool`：网络请求，不影响本地文件系统
- `ToolSearchTool`、`TaskListTool`、`TaskGetTool`：查询类操作
- `AgentTool`：子代理拥有独立的执行上下文，天然可并发

**第二类：条件安全。** 需要根据输入判断：

- `BashTool` 和 `PowerShellTool`：调用 `this.isReadOnly?.(input)` 来判定。对 Bash 而言，这意味着解析 shell 命令的 AST，检查命令是否在只读白名单中（如 `git log`、`cat`、`ls`），以及是否包含输出重定向或管道到写命令等危险模式。这段逻辑在 [`readOnlyValidation.ts`] 中实现，维护了包括 `GIT_READ_ONLY_COMMANDS`、`RIPGREP_READ_ONLY_COMMANDS` 等多个白名单。
- `TaskOutputTool`：同样委托给 `isReadOnly` 判断。

**第三类：无条件不安全。** 写操作工具保持默认 `false`：

- `FileEditTool`、`FileWriteTool`：直接修改文件
- `McpAuthTool`：显式设置为 `false`
- 所有未覆盖 `isConcurrencySafe` 的工具，通过 `buildTool` 的默认值 `(_input?) => false` 自动归入此类

对于 MCP（Model Context Protocol）外部工具，则利用 MCP 规范中的 `annotations.readOnlyHint` 字段来判定：

```typescript
isConcurrencySafe() {
  return tool.annotations?.readOnlyHint ?? false
}
```

如果 MCP 服务端未提供该注解，同样默认为不安全。

### 7.3.4 StreamingToolExecutor：流式调度

在启用 `streamingToolExecution` 功能开关时，[`StreamingToolExecutor.ts`] 取代了非流式的 `runTools`。它最大的区别在于：**不需要等待所有 tool_use 块解析完毕，而是每解析出一个块就立即尝试执行**。

`StreamingToolExecutor` 维护一个有状态的工具队列，每个工具有四种状态：`queued`、`executing`、`completed`、`yielded`。核心调度逻辑在 `canExecuteTool` 中：

```typescript
private canExecuteTool(isConcurrencySafe: boolean): boolean {
  const executingTools = this.tools.filter(t => t.status === 'executing')
  return (
    executingTools.length === 0 ||
    (isConcurrencySafe && executingTools.every(t => t.isConcurrencySafe))
  )
}
```

这个判定条件的含义是：一个工具可以开始执行，当且仅当（1）当前没有其他工具在执行，或者（2）自身是并发安全的，且所有正在执行的工具也都是并发安全的。换句话说，**任何一个写操作工具都会独占执行权**，它必须等到前面的所有工具完成，后续工具也必须等它完成。

`processQueue` 方法在每次有工具加入或完成时被调用，遍历队列寻找可执行的工具：

```typescript
private async processQueue(): Promise<void> {
  for (const tool of this.tools) {
    if (tool.status !== 'queued') continue
    if (this.canExecuteTool(tool.isConcurrencySafe)) {
      await this.executeTool(tool)
    } else {
      if (!tool.isConcurrencySafe) break
    }
  }
}
```

注意 `break` 的位置——当遇到一个不安全的排队工具且无法执行时，直接退出循环。这确保了非安全工具之间的严格顺序性。

**错误传播机制** 也值得一提。当一个 `BashTool` 执行出错时，`StreamingToolExecutor` 会通过 `siblingAbortController` 通知所有正在并行执行的兄弟工具立即终止：

```typescript
if (tool.block.name === BASH_TOOL_NAME) {
  this.hasErrored = true
  this.siblingAbortController.abort('sibling_error')
}
```

这个设计的理由是：Bash 命令之间往往存在隐式依赖链（例如 `mkdir` 失败后续的 `cd` 就没有意义），而 `Read`、`Grep` 等工具彼此独立，一个失败不应影响其他。因此只有 Bash 错误才会触发级联取消。

### 7.3.5 ToolUseContext 的传播

[`Tool.ts`] 中定义的 `ToolUseContext` 是工具执行的上下文对象，承载了大量共享状态：工具列表、AbortController、文件状态缓存、应用状态存取器等。在串行执行模式下，上下文修改器（`contextModifier`）会即时生效：

```typescript
// runToolsSerially 中
if (update.contextModifier) {
  currentContext = update.contextModifier.modifyContext(currentContext)
}
```

但在并发模式下，上下文修改被收集并推迟到整个批次完成后才应用——因为并发工具不应看到彼此的中间状态修改：

```typescript
// runTools 中并发批次的处理
for (const block of blocks) {
  const modifiers = queuedContextModifiers[block.id]
  for (const modifier of modifiers) {
    currentContext = modifier(currentContext)
  }
}
```

`StreamingToolExecutor` 中也有类似的限制，源码注释明确指出：

> NOTE: we currently don't support context modifiers for concurrent tools.

这意味着并发安全的工具目前无法修改共享上下文——这是一个有意的简化，避免了复杂的并发状态合并问题。

## 7.4 设计权衡：吞吐量 vs 安全性

回顾整个工具编排系统，可以看到以下几个关键的设计权衡：

1. **Fail-closed 默认值**：新工具如果忘记实现 `isConcurrencySafe`，默认被视为不安全。这牺牲了一些吞吐量，但杜绝了因遗漏导致的并发错误。

2. **贪心分批而非全局优化**：`partitionToolCalls` 使用简单的线性扫描和贪心合并，而非尝试重排序工具调用以最大化并行度。这是因为模型返回的工具调用顺序可能隐含语义依赖，重排序可能破坏正确性。

3. **Bash 命令的特殊待遇**：只有 Bash 错误会触发兄弟工具的级联取消。这反映了 Bash 命令的特殊性——它们是唯一真正可能产生依赖链的工具类型。

4. **流式执行的激进策略**：`StreamingToolExecutor` 选择在 token 流尚未结束时就开始执行已解析的工具，这大幅降低了用户感知延迟，但增加了实现复杂度（需要处理 discard、错误传播、进度消息缓冲等）。

5. **上下文修改的保守处理**：并发工具不支持上下文修改，串行工具的修改即时生效。这避免了需要实现复杂的 CRDT 或锁机制，在当前场景下足够实用。

## 7.5 小结

Claude Code 的工具编排系统通过"只读并行、写操作串行"的核心策略，在保证安全性的前提下最大化了执行效率。非流式路径 `runTools` 提供了清晰的分批语义，流式路径 `StreamingToolExecutor` 则进一步将调度推向实时化。`isConcurrencySafe` 作为每个工具的自我声明，配合 fail-closed 的默认值，构成了整个并发控制体系的基石。

下一章，我们将进入工具权限系统的深水区——当工具通过了并发调度、准备执行时，它还需要通过权限检查这道最后的关卡。第 8 章将详细解析 Claude Code 的权限模型、审批流程与安全分类器的实现。
