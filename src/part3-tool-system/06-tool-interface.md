# 第 6 章 Tool 接口设计与注册机制

## 6.1 工具——Agent 的"手"

在前面几章中，我们已经了解了 Claude Code 的消息循环和 Agent 主循环的工作方式。但一个 Agent 如果只能"说话"而不能"动手"，就只是一个聊天机器人。真正让 LLM 从对话助手升级为 AI Agent 的关键，正是**工具（Tool）**。

工具是 Agent 与真实世界交互的桥梁。当 Claude 需要读取一个文件时，它不会自己去操作文件系统——它会发出一个 `tool_use` 请求，指明要调用 `Read` 工具并传入文件路径；Claude Code 的运行时负责执行这个请求，把结果以 `tool_result` 的形式返回给模型。从模型的视角来看，工具就像是它伸向物理世界的一双手：

```
用户提问 → LLM 思考 → 发出 tool_use（调用工具）→ 运行时执行 → 返回 tool_result → LLM 继续思考
```

这一设计的核心约束在于：**LLM 的输出是不可信的**。模型可能产出格式错误的 JSON，可能传入越界的参数，甚至可能请求调用不存在的工具。因此，一套严格的接口规范和运行时校验机制是整个工具系统的基石。

## 6.2 架构总览

![Tool 接口设计](/images/ch06-tool-interface.png)

在深入源码之前，先建立一个全局视角。Claude Code 的工具系统由三层组成：

```
┌─────────────────────────────────────────────────┐
│                  claude.ts 主循环                │
│         调用 getTools() / assembleToolPool()     │
└──────────────────────┬──────────────────────────┘
                       │ Tools（readonly Tool[]）
                       ▼
┌─────────────────────────────────────────────────┐
│              tools.ts  工具注册表                │
│  getAllBaseTools() → getTools() → assembleToolPool()│
│  ┌──────────────┐  ┌──────────────┐             │
│  │ feature gate │  │  deny rules  │  条件过滤    │
│  └──────────────┘  └──────────────┘             │
└──────────────────────┬──────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
  ┌──────────┐  ┌──────────┐  ┌──────────┐
  │ BashTool │  │ GlobTool │  │ FileRead │  ...40+ 工具
  │          │  │          │  │   Tool   │
  └──────────┘  └──────────┘  └──────────┘
       │              │              │
       └──────────────┴──────────────┘
                      │
                 每个工具都实现
                 Tool 接口 (Tool.ts)
```

三层的职责很清晰：

- **Tool 接口**（`Tool.ts`）：定义统一契约——每个工具必须提供什么能力
- **工具注册表**（`tools.ts`）：汇总所有工具，基于条件过滤后输出最终工具池
- **具体工具**（`src/tools/` 目录下 40+ 个工具）：各自实现接口

## 6.3 Tool 接口定义源码走读

### 6.3.1 核心类型签名

打开 `src/Tool.ts`，Tool 接口是整个工具系统的核心类型。它是一个泛型类型，带有三个类型参数：

```typescript
export type Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = {
  readonly name: string
  aliases?: string[]
  readonly inputSchema: Input
  call(...): Promise<ToolResult<Output>>
  description(...): Promise<string>
  isConcurrencySafe(input: z.infer<Input>): boolean
  isReadOnly(input: z.infer<Input>): boolean
  isEnabled(): boolean
  checkPermissions(...): Promise<PermissionResult>
  userFacingName(input: ...): string
  prompt(...): Promise<string>
  // ...还有大量渲染和 UI 相关的方法
}
```

这三个泛型参数各有用途：

- **Input**：工具的输入 Schema，必须是 Zod 对象类型
- **Output**：工具执行后的输出类型
- **P**：进度事件的类型，用于 UI 渲染执行过程中的中间状态

接下来逐一分析最关键的几个成员。

### 6.3.2 name 与 aliases

```typescript
readonly name: string
aliases?: string[]
```

`name` 是工具的唯一标识符，也是 LLM 在 `tool_use` 消息中引用工具时使用的名称。`aliases` 则用于向后兼容——当一个工具被重命名时，旧名称仍然可以匹配到它。源码中提供了辅助函数 `toolMatchesName` 和 `findToolByName` 来统一处理这一逻辑：

```typescript
export function toolMatchesName(
  tool: { name: string; aliases?: string[] },
  name: string,
): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false)
}
```

### 6.3.3 inputSchema——为什么用 Zod 做运行时校验

```typescript
readonly inputSchema: Input  // Input extends AnyObject = z.ZodType<{[key: string]: unknown}>
```

这是整个 Tool 接口设计中最值得深入讨论的一个决策。Claude Code 选择用 **Zod** 而非纯 TypeScript 类型或 JSON Schema 来定义工具的输入约束。

原因很直接：**LLM 产出的 JSON 不可信**。

TypeScript 的类型系统是编译时的，它在运行时完全消失。当 Claude 模型返回一个 `tool_use` 调用时，传入的参数是一段运行时的 JSON 字符串。这段 JSON 可能：

1. 缺少必填字段
2. 字段类型错误（比如该传数字的地方传了字符串）
3. 包含多余字段
4. 结构完全不符合预期

Zod 同时充当两个角色：

- **编译时**：通过 `z.infer<Input>` 推导出 TypeScript 类型，让工具实现代码获得完整的类型检查
- **运行时**：`.parse()` 或 `.safeParse()` 对 LLM 输出进行校验，不合法的输入在执行前就被拦截

以 GlobTool 的 inputSchema 为例：

```typescript
const inputSchema = lazySchema(() =>
  z.strictObject({
    pattern: z.string().describe('The glob pattern to match files against'),
    path: z
      .string()
      .optional()
      .describe('The directory to search in...'),
  }),
)
```

注意两个细节：

1. **`lazySchema`** 包裹：这是一种延迟初始化策略，Schema 只在首次访问时构建，避免应用启动时的初始化开销。
2. **`.describe()`** 不仅是文档：这些描述字符串会被序列化为 JSON Schema 发送给模型，直接影响模型对参数的理解和填写质量。Describe 内容实际上就是发送给 LLM 的 prompt 的一部分。

### 6.3.4 call——异步执行入口

```typescript
call(
  args: z.infer<Input>,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  parentMessage: AssistantMessage,
  onProgress?: ToolCallProgress<P>,
): Promise<ToolResult<Output>>
```

`call` 是工具的核心执行方法。它接收五个参数：

- **args**：经过 Zod 校验的输入参数
- **context**：一个内容极其丰富的上下文对象 `ToolUseContext`，包含当前会话的几乎所有状态——消息历史、abort 控制器、文件状态缓存、应用状态等
- **canUseTool**：权限检查回调，工具在执行过程中可以调用它检查自己是否有权执行某项操作
- **parentMessage**：触发本次工具调用的助手消息
- **onProgress**：可选的进度回调，让长时间运行的工具（如 Bash 命令执行）可以实时推送中间状态给 UI

返回值 `ToolResult<Output>` 包含三个字段：

```typescript
export type ToolResult<T> = {
  data: T
  newMessages?: (UserMessage | AssistantMessage | ...)[]
  contextModifier?: (context: ToolUseContext) => ToolUseContext
}
```

`data` 是工具的实际输出；`newMessages` 允许工具向消息历史中注入新消息；`contextModifier` 可以修改后续工具执行的上下文——但注意，这个修改器**仅对非并发安全的工具生效**。

### 6.3.5 isConcurrencySafe——并发安全标记

```typescript
isConcurrencySafe(input: z.infer<Input>): boolean
```

这个方法决定了工具是否可以与其他工具并行执行。返回 `true` 意味着该工具是纯读取的、无副作用的，可以安全地与其他工具同时运行。例如 GlobTool 和 FileReadTool 都是并发安全的，而 BashTool 和 FileEditTool 则不是。

值得注意的是，`buildTool` 提供的默认值是 `false`（假设不安全）。这是一种**"默认关闭"**（fail-closed）的安全策略：如果工具作者忘了声明并发安全性，系统会保守地将其视为不安全，宁可牺牲并行度也不冒数据竞争的风险。

### 6.3.6 其他关键方法

Tool 接口还定义了一系列辅助方法，按功能可以分为几组：

**权限与安全组**：
- `checkPermissions`：工具特定的权限检查逻辑
- `validateInput`：输入验证，在权限检查之前执行
- `isReadOnly`：是否为只读操作
- `isDestructive`：是否为不可逆操作（删除、覆盖等）
- `preparePermissionMatcher`：为 hook 的 `if` 条件准备匹配器

**UI 渲染组**：
- `renderToolUseMessage`：渲染工具调用的展示
- `renderToolResultMessage`：渲染工具结果的展示
- `renderToolUseProgressMessage`：渲染执行进度
- `renderGroupedToolUse`：批量渲染并行工具调用
- `userFacingName`：面向用户的工具名

**行为控制组**：
- `interruptBehavior`：用户中断时的行为（取消 vs 阻塞）
- `isSearchOrReadCommand`：是否为搜索/读取操作（影响 UI 折叠）
- `shouldDefer`：是否延迟加载（配合 ToolSearch 使用）
- `maxResultSizeChars`：输出大小限制，超出后持久化到磁盘

### 6.3.7 buildTool——统一的构造函数

实际上，工具的实现并不直接构造 `Tool` 对象，而是通过 `buildTool` 辅助函数：

```typescript
export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  return {
    ...TOOL_DEFAULTS,
    userFacingName: () => def.name,
    ...def,
  } as BuiltTool<D>
}
```

`buildTool` 做了一件简单但重要的事：**用合理的默认值填充可选方法**。默认值定义在 `TOOL_DEFAULTS` 中：

- `isEnabled` → `true`（默认启用）
- `isConcurrencySafe` → `false`（默认不安全）
- `isReadOnly` → `false`（默认可写）
- `isDestructive` → `false`（默认非破坏性）
- `checkPermissions` → 直接放行（交由通用权限系统处理）
- `toAutoClassifierInput` → `''`（默认跳过安全分类器）

这个设计确保了：新增一个工具时，不需要实现所有 20+ 个方法——只需关注核心的 `name`、`inputSchema`、`call`、`prompt` 等必要部分，其余由默认值兜底。同时，安全相关的默认值采用"保守"策略，降低遗漏带来的风险。

## 6.4 工具注册：从定义到可用

### 6.4.1 getAllBaseTools()——汇总所有内置工具

`src/tools.ts` 是工具注册的核心文件。`getAllBaseTools()` 函数返回所有可能可用的内置工具列表：

```typescript
export function getAllBaseTools(): Tools {
  return [
    AgentTool,
    TaskOutputTool,
    BashTool,
    ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    NotebookEditTool,
    // ...更多工具
  ]
}
```

这个函数的返回值是一个**静态数组**，但数组的组成是动态的——大量使用展开运算符（`...`）和条件表达式来决定哪些工具被包含。

### 6.4.2 Feature Gate 与 Dead Code Elimination

工具注册中最有特色的设计是 **feature gate** 机制。文件顶部有大量条件导入：

```typescript
const SleepTool =
  feature('PROACTIVE') || feature('KAIROS')
    ? require('./tools/SleepTool/SleepTool.js').SleepTool
    : null

const cronTools = feature('AGENT_TRIGGERS')
  ? [
      require('./tools/ScheduleCronTool/CronCreateTool.js').CronCreateTool,
      require('./tools/ScheduleCronTool/CronDeleteTool.js').CronDeleteTool,
      require('./tools/ScheduleCronTool/CronListTool.js').CronListTool,
    ]
  : []
```

这里的 `feature()` 来自 `bun:bundle`，是 Bun 构建时的编译期求值函数。它的特殊之处在于：当某个 feature flag 为 `false` 时，**Bun 的 bundler 会在构建阶段将 `require(...)` 分支整个移除**（dead code elimination）。这意味着：

- 对于公开发布版本，内部工具（如 `REPLTool`、`TungstenTool`）的代码根本不会出现在最终产物中
- 减小了包体积
- 防止内部工具接口意外泄露

除了编译期 feature flag，还有运行时条件过滤：

```typescript
...(process.env.USER_TYPE === 'ant' ? [ConfigTool] : []),
...(isEnvTruthy(process.env.ENABLE_LSP_TOOL) ? [LSPTool] : []),
...(isWorktreeModeEnabled() ? [EnterWorktreeTool, ExitWorktreeTool] : []),
```

这是两层过滤体系：**构建时（feature flag）** 决定代码是否打包，**运行时（环境变量）** 决定功能是否可用。

### 6.4.3 getTools()——权限过滤后的最终工具集

`getTools()` 是外部获取工具列表的主入口。它在 `getAllBaseTools()` 的基础上进行多层过滤：

```typescript
export const getTools = (permissionContext: ToolPermissionContext): Tools => {
  // 1. 简单模式：仅保留 Bash、Read、Edit
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    const simpleTools: Tool[] = [BashTool, FileReadTool, FileEditTool]
    return filterToolsByDenyRules(simpleTools, permissionContext)
  }

  // 2. 排除特殊工具（MCP 资源工具、合成输出工具）
  const tools = getAllBaseTools().filter(tool => !specialTools.has(tool.name))

  // 3. 应用 deny rules 过滤
  let allowedTools = filterToolsByDenyRules(tools, permissionContext)

  // 4. REPL 模式下隐藏被 REPL 包装的原始工具
  if (isReplModeEnabled()) { ... }

  // 5. isEnabled() 检查
  return allowedTools.filter((_, i) => isEnabled[i])
}
```

整个过滤链体现了**分层安全**的思想：

1. **模式过滤**：`CLAUDE_CODE_SIMPLE` 模式下只保留最基础的三个工具
2. **特殊工具隔离**：MCP 资源相关工具不在普通工具池中
3. **Deny Rules**：管理员可以通过配置规则禁用特定工具
4. **REPL 包装**：REPL 模式下原始工具被 REPL 沙箱包装
5. **isEnabled 自检**：工具自身的启用/禁用逻辑

### 6.4.4 assembleToolPool()——内置工具与 MCP 工具的合并

最终面向主循环的函数是 `assembleToolPool()`，它将内置工具和 MCP（Model Context Protocol）工具合并为统一的工具池：

```typescript
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)

  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  return uniqBy(
    [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
    'name',
  )
}
```

这里有一个重要的细节：工具按名称排序，且**内置工具作为前缀**排在 MCP 工具之前。这不仅是为了美观，更是为了 **prompt cache 的稳定性**——Anthropic API 的系统缓存策略会在内置工具的最后一个位置设置缓存断点。如果 MCP 工具穿插在内置工具之间，每次 MCP 工具变化都会导致缓存失效。

## 6.5 40+ 工具的分类总览

浏览 `src/tools/` 目录，Claude Code 的工具可以按功能分为以下几大类：

**文件操作类**：
- `FileReadTool` — 文件读取（支持图片、PDF、Notebook）
- `FileEditTool` — 精确字符串替换编辑
- `FileWriteTool` — 文件写入/创建
- `NotebookEditTool` — Jupyter Notebook 编辑
- `GlobTool` — 文件名模式匹配搜索
- `GrepTool` — 文件内容正则搜索

**Shell 与执行类**：
- `BashTool` — 通用 Shell 命令执行
- `PowerShellTool` — Windows PowerShell 支持
- `REPLTool` — 沙箱化的 REPL 环境（内部工具）

**Agent 与任务类**：
- `AgentTool` — 子 Agent 创建与管理
- `TaskCreateTool` / `TaskGetTool` / `TaskUpdateTool` / `TaskListTool` — 任务管理
- `TaskOutputTool` / `TaskStopTool` — 任务输出与终止
- `TodoWriteTool` — 待办事项管理
- `TeamCreateTool` / `TeamDeleteTool` — Agent 团队管理
- `SendMessageTool` — 消息发送

**网络与外部交互类**：
- `WebFetchTool` — 网页内容抓取
- `WebSearchTool` — 网络搜索
- `WebBrowserTool` — 浏览器自动化（实验性）

**会话控制类**：
- `EnterPlanModeTool` / `ExitPlanModeV2Tool` — 计划模式切换
- `AskUserQuestionTool` — 主动向用户提问
- `BriefTool` — 简短回复模式
- `SkillTool` — 技能调用
- `ToolSearchTool` — 延迟加载工具的搜索发现

**MCP 集成类**：
- `MCPTool` — MCP 协议工具包装
- `ListMcpResourcesTool` / `ReadMcpResourceTool` — MCP 资源访问

**配置与基础设施类**：
- `ConfigTool` — 配置管理
- `LSPTool` — Language Server Protocol 集成
- `EnterWorktreeTool` / `ExitWorktreeTool` — Git worktree 管理

这个分类体现了 Claude Code 作为一个完整开发工具的野心：它不只是一个代码编辑器的 AI 插件，而是一个能够读写文件、执行命令、管理任务、搜索网络、协调多个 Agent 的全能开发助手。

## 6.6 小结

Claude Code 的 Tool 接口设计遵循了几个核心原则：

1. **统一接口，多态实现**：40+ 个工具共享同一个 `Tool` 类型，通过 `buildTool` 提供合理默认值。新增工具只需关注核心逻辑，框架层面的安全、并发、渲染等行为由接口统一保障。

2. **运行时校验优先**：使用 Zod 在编译时和运行时双重保障输入安全，应对 LLM 输出不可信这一根本挑战。

3. **分层过滤，安全前置**：从 feature gate 的编译期剪枝，到 deny rules 的运行时过滤，再到 `isEnabled`、`checkPermissions` 的工具自检，形成了多层防御体系。

4. **可扩展，可并发**：`isConcurrencySafe` 标记让运行时可以安全地并行调度多个工具；MCP 协议的集成让第三方工具以完全相同的接口接入。

理解了 Tool 接口的设计，一个自然的问题浮现：当模型在一次回复中调用了多个工具时，系统如何决定哪些可以并行、哪些必须串行？工具执行的错误如何处理？`contextModifier` 如何在工具之间传递状态？

这些问题将在下一章——**第 7 章 工具编排与并发执行**——中展开讨论。
