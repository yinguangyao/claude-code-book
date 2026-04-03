# 第 11 章 Hook 系统——事件驱动的扩展

## 11.1 概念引入：Agent 生命周期的拦截器

在前几章中，我们已经深入了解了 Claude Code 的 Agent 循环、工具执行和权限体系。这些机制构成了一个完整的运行时管线——从用户输入，到模型推理，到工具调用，再到结果输出。然而，面对真实的工程场景，团队往往需要在这条管线的特定节点"插一脚"：在工具执行前做合规检查、在会话启动时注入环境变量、在模型停止前验证输出质量……

Claude Code 的 Hook 系统正是为此而生。它本质上是一个**事件驱动的拦截器框架**——在 Agent 生命周期的 28 个关键节点暴露事件，允许用户通过 Shell 脚本、LLM 子查询、HTTP 请求或内部回调插入自定义逻辑。

这个设计的灵感并不新鲜。Git 有 pre-commit / post-commit hook，Webpack 有 tapable 插件体系，React 有生命周期方法。但 Claude Code 的 Hook 系统有一个关键区别：它不仅能*观察*事件，还能*改变*事件的走向。一个 PreToolUse hook 可以修改工具输入、批准或拒绝执行；一个 Stop hook 可以阻止模型结束对话并要求它继续工作。这使得 Hook 不仅是"通知"，而是真正的"控制面"。

## 11.2 架构总览：事件触发时机与执行流

![Hook 事件驱动系统](/images/ch11-hook-system.png)

下面这张流程图展示了 Hook 在 Agent 生命周期中的触发时机：

```
用户输入
  │
  ├── UserPromptSubmit ──→ 可拦截/注入上下文
  │
  ▼
SessionStart ──→ 初始化环境变量、注入系统提示
  │
  ▼
┌─────────────── Agent 主循环 ───────────────┐
│                                             │
│  模型推理 → 产生工具调用                      │
│      │                                      │
│      ├── PreToolUse ──→ 批准/拒绝/修改输入    │
│      │                                      │
│      ▼                                      │
│  工具执行                                    │
│      │                                      │
│      ├── PostToolUse ──→ 注入上下文/修改输出   │
│      ├── PostToolUseFailure ──→ 错误处理      │
│      │                                      │
│      ▼                                      │
│  模型继续推理 ...                             │
│      │                                      │
│      ├── Stop ──→ 验证/阻止停止              │
│      ├── SubagentStart / SubagentStop        │
│      ├── PreCompact / PostCompact            │
│                                             │
└─────────────────────────────────────────────┘
  │
  ├── SessionEnd ──→ 清理资源
  │
  ▼
结束
```

从架构层面看，Hook 系统由以下几个核心模块组成：

- **事件定义层** `[coreTypes.ts]` / `[coreSchemas.ts]`：定义全部 28 种 HookEvent 及其输入 Schema
- **配置管理层** `[hooksSettings.ts]` / `[hooksConfigManager.ts]`：从 settings.json、插件、Session 三个来源收集 Hook 配置
- **执行引擎层** `[hooks.ts]`：核心调度逻辑，负责匹配事件、分发到不同执行器
- **执行器** `[execPromptHook.ts]` / `[execAgentHook.ts]` / `[execHttpHook.ts]`：四种 Hook 类型的具体执行实现
- **异步注册表** `[AsyncHookRegistry.ts]`：管理后台异步 Hook 的生命周期
- **事件广播** `[hookEvents.ts]`：Hook 执行过程中的事件发射与监听

## 11.3 源码走读

### 11.3.1 事件类型全览

Claude Code 在 `src/entrypoints/sdk/coreTypes.ts` 中定义了 `HOOK_EVENTS` 常量数组，这是整个 Hook 系统的事件目录：

```typescript
export const HOOK_EVENTS = [
  'PreToolUse',        // 工具执行前
  'PostToolUse',       // 工具执行后
  'PostToolUseFailure',// 工具执行失败后
  'Notification',      // 通知发送时
  'UserPromptSubmit',  // 用户提交提示词时
  'SessionStart',      // 会话启动时
  'SessionEnd',        // 会话结束时
  'Stop',              // 模型即将停止响应时
  'StopFailure',       // 因 API 错误停止时
  'SubagentStart',     // 子 Agent 启动时
  'SubagentStop',      // 子 Agent 停止时
  'PreCompact',        // 对话压缩前
  'PostCompact',       // 对话压缩后
  'PermissionRequest', // 权限对话框弹出时
  'PermissionDenied',  // 权限被拒绝后
  'Setup',             // 仓库初始化/维护时
  'TeammateIdle',      // 团队协作中队友即将空闲时
  'TaskCreated',       // 任务创建时
  'TaskCompleted',     // 任务完成时
  'Elicitation',       // MCP 服务器请求用户输入时
  'ElicitationResult', // 用户回应 MCP 请求后
  'ConfigChange',      // 配置文件变更时
  'WorktreeCreate',    // 工作树创建时
  'WorktreeRemove',    // 工作树移除时
  'InstructionsLoaded',// 指令文件加载时
  'CwdChanged',        // 工作目录切换后
  'FileChanged',       // 被监视文件变更时
] as const
```

这 28 种事件并不是随意堆砌的，它们可以按生命周期阶段分为几类：

| 分类 | 事件 | 典型用途 |
|------|------|---------|
| 会话生命周期 | SessionStart, SessionEnd, Setup | 环境初始化、资源清理 |
| 用户交互 | UserPromptSubmit, Notification | 输入预处理、通知转发 |
| 工具执行 | PreToolUse, PostToolUse, PostToolUseFailure | 合规审查、结果增强 |
| 权限控制 | PermissionRequest, PermissionDenied | 自动化权限决策 |
| 推理控制 | Stop, StopFailure, PreCompact, PostCompact | 质量验证、压缩定制 |
| 子 Agent | SubagentStart, SubagentStop | 子 Agent 行为定制 |
| 文件与配置 | FileChanged, CwdChanged, ConfigChange, InstructionsLoaded | 环境感知 |

每种事件都有独立的输入 Schema。以 `PreToolUseHookInput` 为例，它携带了 `tool_name`、`tool_input`、`tool_use_id` 等字段，使得 Hook 能够精准感知"什么工具要用什么参数做什么事"。所有输入都包含一个公共基础字段集——`session_id`、`transcript_path`、`cwd`、`permission_mode`——这些来自 `createBaseHookInput()` 函数（定义在 `[hooks.ts]` 中）。

`[hooksConfigManager.ts]` 中的 `getHookEventMetadata()` 函数为每个事件提供了元数据描述，包括事件摘要、详细行为说明以及 matcher 字段（用于按工具名、通知类型等维度过滤）。这些元数据不仅驱动 Hook 配置 UI 的渲染，也是理解每种事件行为规约的最佳文档。

### 11.3.2 四种执行方式

Hook 系统支持四种截然不同的执行方式，每种针对不同的使用场景。它们的类型定义集中在 `[src/schemas/hooks.ts]` 中：

```typescript
export const HookCommandSchema = lazySchema(() => {
  return z.discriminatedUnion('type', [
    BashCommandHookSchema,   // Shell 命令
    PromptHookSchema,        // LLM 提示词
    AgentHookSchema,         // Agent 子查询
    HttpHookSchema,          // HTTP 请求
  ])
})
```

**第一种：Command Hook（Shell 脚本）**

这是最基础、也是最常用的 Hook 类型。用户在 `settings.json` 中配置一条 Shell 命令，Claude Code 通过 `spawn` 启动子进程执行，并通过 stdin 传入 JSON 格式的事件输入。

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "python3 ~/scripts/validate-bash.py"
      }]
    }]
  }
}
```

Command Hook 的执行结果通过**退出码**和 **stdout JSON** 两个通道返回。退出码的语义在不同事件下有微妙差异，但核心约定是：

- **退出码 0**：成功，stdout 可选地输出 JSON 控制响应
- **退出码 2**：阻塞性错误，stderr 内容会展示给模型，且阻止后续操作
- **其他退出码**：非阻塞性错误，stderr 仅展示给用户

Command Hook 还支持 `async: true` 配置，使其在后台运行而不阻塞主流程。此时 `[AsyncHookRegistry.ts]` 会接管其生命周期——注册到全局 `pendingHooks` Map 中，定期轮询 `checkForAsyncHookResponses()` 检查是否完成。更进一步，`asyncRewake: true` 模式会在 Hook 以退出码 2 完成时主动"唤醒"模型——通过 `enqueuePendingNotification()` 将阻塞信息注入消息队列。

**第二种：Prompt Hook（LLM 单轮查询）**

Prompt Hook 不执行 Shell 命令，而是调用一个轻量 LLM（默认使用 Haiku 等小模型）进行单轮评估。它的核心实现在 `[execPromptHook.ts]` 中：

```typescript
export async function execPromptHook(
  hook: PromptHook,
  hookName: string,
  hookEvent: HookEvent,
  jsonInput: string,
  signal: AbortSignal,
  toolUseContext: ToolUseContext,
  ...
): Promise<HookResult> {
```

执行时，系统将 Hook 的 `prompt` 字段中的 `$ARGUMENTS` 占位符替换为实际的事件输入 JSON，然后通过 `queryModelWithoutStreaming()` 发起非流式 API 调用。系统提示要求模型返回 `{ok: boolean, reason?: string}` 格式的 JSON 响应。如果 `ok` 为 `false`，则视为阻塞性错误。

Prompt Hook 特别适合那些"需要语义理解但不需要工具调用"的验证场景——例如检查代码变更是否符合编码规范。

**第三种：Agent Hook（隔离子查询）**

Agent Hook 是最强大的 Hook 类型。它会启动一个**完整的隔离 Agent 子会话**，拥有独立的 `agentId`、可以使用工具、支持多轮对话。其实现在 `[execAgentHook.ts]` 中：

```typescript
const hookAgentId = asAgentId(`hook-agent-${randomUUID()}`)
// ...
for await (const message of query({
  messages: agentMessages,
  systemPrompt,
  canUseTool: hasPermissionsToUseTool,
  toolUseContext: agentToolUseContext,
  querySource: 'hook_agent',
})) {
  // 多轮执行，直到获得结构化输出
}
```

Agent Hook 有几个关键设计决策值得注意：

1. **工具隔离**：过滤掉 `ALL_AGENT_DISALLOWED_TOOLS`（如 Agent 工具本身），防止 Hook Agent 再递归启动子 Agent
2. **结构化输出强制**：通过 `registerStructuredOutputEnforcement()` 注册一个 `Stop` 事件的 Function Hook，要求 Agent 必须调用 `SyntheticOutputTool` 返回结构化结果
3. **权限隔离**：以 `dontAsk` 模式运行（非交互），但自动授予读取会话 transcript 文件的权限
4. **回合限制**：最多 50 轮（`MAX_AGENT_TURNS`），超限则静默取消

**第四种：HTTP Hook（远程服务调用）**

HTTP Hook 将事件输入以 JSON POST 请求发送到指定 URL，定义在 `[execHttpHook.ts]` 中。这种方式适合与外部服务集成——例如企业内部的合规审查 API 或监控系统。

HTTP Hook 有严格的安全防护：

- **URL 白名单**：通过 `allowedHttpHookUrls` 配置限制可访问的 URL 模式
- **SSRF 防护**：使用 `ssrfGuardedLookup` 阻止对私有 IP 范围的请求（沙盒代理场景除外）
- **头部注入防护**：`sanitizeHeaderValue()` 剥离 CR/LF/NUL 字节，防止 CRLF 注入
- **环境变量插值控制**：Header 中的 `$VAR_NAME` 引用仅在变量名出现在 `allowedEnvVars` 白名单时才会被解析

### 11.3.3 Hook 响应协议

无论哪种执行方式，所有 Hook 最终都通过统一的 JSON 响应协议与主系统通信。这个协议定义在 `[src/types/hooks.ts]` 的 `syncHookResponseSchema` 中，是整个 Hook 系统的"语言"。

**通用控制字段：**

```typescript
{
  continue?: boolean,      // false 阻止 Claude 继续
  suppressOutput?: boolean,// 隐藏 stdout
  stopReason?: string,     // continue=false 时的原因说明
  decision?: 'approve' | 'block', // 批准或阻止
  reason?: string,         // 决策原因
  systemMessage?: string,  // 展示给用户的警告信息
}
```

**事件特定字段**通过 `hookSpecificOutput` 传递，它是一个 discriminated union，按 `hookEventName` 区分：

- **PreToolUse**：`permissionDecision`（allow/deny/ask）、`updatedInput`（修改工具输入）、`additionalContext`
- **PostToolUse**：`additionalContext`、`updatedMCPToolOutput`（修改 MCP 工具输出）
- **SessionStart**：`additionalContext`、`initialUserMessage`、`watchPaths`
- **PermissionRequest**：`decision`（allow 或 deny，可附带 `updatedInput` 和 `updatedPermissions`）
- **PermissionDenied**：`retry`（允许模型重试被拒绝的操作）

这里最具设计深度的是 **PreToolUse 的权限决策协议**。一个 Hook 可以返回三种权限行为：

- `allow`：批准工具执行，但**不绕过** settings.json 中的 deny/ask 规则（在 `[toolHooks.ts]` 的 `resolveHookPermissionDecision()` 中实现）
- `deny`：拒绝工具执行
- `ask`：要求弹出权限对话框

注意 `allow` 的语义——Hook 的批准不是最终裁决，它仍然要经过 `checkRuleBasedPermissions()` 的规则检查。这是一个防御性设计：即使 Hook 被绕过或配置错误，settings.json 中的硬性策略仍然生效。

### 11.3.4 配置加载与匹配

Hook 的配置可以来自三个层次，优先级从高到低：

1. **用户设置** `~/.claude/settings.json`
2. **项目设置** `.claude/settings.json`
3. **本地设置** `.claude/settings.local.json`

此外，还有两个特殊来源：

- **Plugin Hook**：通过插件系统注册（`PluginHookMatcher` 类型），拥有 `pluginRoot` 和 `pluginId`
- **Session Hook**：运行时内存中的临时 Hook（`sessionHooks.ts`），随会话结束自动销毁

`[hooksSettings.ts]` 中的 `getAllHooks()` 函数负责将所有来源的 Hook 收集到统一的 `IndividualHookConfig[]` 数组中。每个配置项包含 `event`（事件类型）、`config`（Hook 命令）、`matcher`（匹配模式）和 `source`（来源标识）。

匹配机制值得一提。每个 Hook 事件可以定义 `matcher` 字段来过滤触发条件。例如，PreToolUse 事件的 matcher 匹配 `tool_name`——配置 `"matcher": "Bash"` 表示只在 Bash 工具调用时触发。此外，Hook 还支持 `if` 条件字段，使用权限规则语法（如 `"Bash(git *)"` ）做更精细的前置过滤，避免为不相关的调用启动子进程。

### 11.3.5 事件广播系统

`[hookEvents.ts]` 实现了一个独立于主消息流的事件广播系统，用于将 Hook 执行状态传递给外部消费者（如 SDK 消息流、日志系统）。它定义了三种事件：

- `HookStartedEvent`：Hook 开始执行
- `HookProgressEvent`：执行中的进度更新（stdout/stderr）
- `HookResponseEvent`：执行完成（包含退出码和输出）

系统使用一个简单的发布-订阅模型：通过 `registerHookEventHandler()` 注册唯一的事件处理器，未注册时事件暂存于 `pendingEvents` 队列（上限 100 条）。`SessionStart` 和 `Setup` 事件始终广播，其他事件仅在 `setAllHookEventsEnabled(true)` 后才会发射——这通常在 SDK 模式或远程执行模式下启用。

### 11.3.6 信任与安全

Hook 系统在安全性上做了多层防护，这些散布在代码各处的检查构成了一道完整的防线：

`[hooks.ts]` 中的 `shouldSkipHookDueToTrust()` 函数实现了**工作区信任检查**——在交互模式下，只有用户接受了信任对话框后，Hook 才会执行。这是为了防止恶意仓库通过 `.claude/settings.json` 注入 Hook 在用户浏览代码时执行任意命令。

此外，`allowManagedHooksOnly` 策略（通过 `policySettings` 配置）允许企业管理员禁止所有用户/项目级 Hook，仅允许受管 Hook 运行。更极端的 `shouldDisableAllHooksIncludingManaged()` 则完全禁用 Hook 系统。

## 11.4 实际场景示例

**场景一：自动化安全审查**

一个团队希望在 Claude Code 执行任何 Bash 命令前，检查命令中是否包含敏感操作（如 `rm -rf /`、`curl` 上传到外部地址等）。

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "python3 ./scripts/check-bash-safety.py",
        "timeout": 5
      }]
    }]
  }
}
```

脚本从 stdin 读取 JSON 输入，解析 `tool_input.command` 字段，检查是否命中安全黑名单。如果危险，以退出码 2 退出并在 stderr 输出原因——模型会收到这个原因并调整行为。

**场景二：Stop Hook 验证输出质量**

使用 Agent Hook 在模型即将结束对话时验证工作是否完成：

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "agent",
        "prompt": "Check that all unit tests pass by running 'npm test'. $ARGUMENTS"
      }]
    }]
  }
}
```

这会启动一个隔离 Agent 执行 `npm test`，如果测试失败则返回 `{ok: false, reason: "..."}`，主 Agent 会被阻止停止并继续修复。

**场景三：HTTP Hook 集成企业合规系统**

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Write",
      "hooks": [{
        "type": "http",
        "url": "https://compliance.internal.corp/api/check",
        "headers": {
          "Authorization": "Bearer $COMPLIANCE_TOKEN"
        },
        "allowedEnvVars": ["COMPLIANCE_TOKEN"]
      }]
    }]
  }
}
```

每次 Claude Code 写入文件前，将写入内容发送到企业合规 API 进行审查。

## 11.5 小结

Claude Code 的 Hook 系统是一个精心设计的事件驱动扩展框架。从架构角度看，它有几个值得学习的设计模式：

1. **统一的响应协议**：无论 Shell 脚本、LLM 查询还是 HTTP 请求，所有 Hook 都通过同一个 JSON Schema 与主系统通信，极大降低了集成复杂度
2. **安全优先的权限模型**：Hook 的 `allow` 决策不绕过系统策略，确保了"策略始终生效"的不变式
3. **渐进式能力梯度**：从简单的 Shell 脚本到完整的 Agent 子会话，四种执行方式覆盖了从轻量观察到深度验证的全部场景
4. **防御性信任边界**：工作区信任、URL 白名单、SSRF 防护、头部注入防护等多层安全机制

Hook 系统将 Claude Code 从一个封闭的 AI Agent 变成了一个**可编程的 Agent 平台**。理解它的工作原理，是构建企业级 AI 工作流的关键一步。

在下一章中，我们将目光转向 MCP（Model Context Protocol）协议，看看 Claude Code 如何通过标准化协议与外部工具服务器交互，进一步扩展 Agent 的能力边界。
