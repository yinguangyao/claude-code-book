# 第 13 章：Skill 与 Plugin 系统

前一章我们深入研究了 Hook 系统——它是一套在模型生命周期节点上插入外部逻辑的机制。本章我们把视野拉宽，看看 Claude Code 的另外两套扩展机制：**Skill（技能）** 与 **Plugin（插件）**。三者共同构成了 Claude Code 的完整扩展体系，但各自的定位与边界截然不同。理解它们之间的分工，是深入理解 Claude Code 架构的关键一步。

![Skill 与 Plugin 扩展体系](/images/ch13-skills-plugins.png)

## 13.1 概念引入：三套机制各自的定位

在正式进入源码之前，先建立一个直觉性的概念框架。

**Skill** 是预先写好的提示词模板，以 slash command（斜杠命令）的形式暴露给用户和模型。当用户键入 `/simplify` 或者模型决定调用 `Skill` 工具时，系统会展开对应的提示词，替换参数，然后在当前对话（或独立的 fork 子智能体）中执行。Skill 的核心是**提示词**，工具白名单和模型覆盖是辅助配置。

**Plugin** 是一个可安装、可启用/禁用的**扩展包**。一个 Plugin 可以同时提供多种组成部分：Skills、Hooks、MCP 服务器、甚至 LSP 服务器。Plugin 的核心是**生命周期管理**——用户可以在 `/plugin` UI 中切换它的启用状态，系统会相应地加载或卸载它携带的所有组件。

**Hook** 是在特定生命周期事件触发时执行的副作用脚本（Shell 命令、HTTP 请求或 LLM 提示词）。Hook 可以独立配置在 `settings.json` 中，也可以内嵌在 Skill 或 Plugin 的定义里，随 Skill 激活或 Plugin 启用而注册。

三者的关系可以这样总结：

```
Plugin（扩展包，管理生命周期）
  └── 包含 Skills（提示词模板）
  └── 包含 Hooks（副作用脚本）
  └── 包含 MCP Servers（外部工具服务）

Skill（也可独立存在，不属于任何 Plugin）
  └── 可携带 Hooks（Skill 激活时注册）
```

下面我们逐层深入源码，把这个抽象框架落到具体实现。

---

## 13.2 Skill 系统：预注册的 Slash Command

### 13.2.1 BundledSkillDefinition 的类型定义

Skill 系统最核心的数据结构定义在 [`src/skills/bundledSkills.ts`](../../../claude-code-source-code/src/skills/bundledSkills.ts)：

```typescript
export type BundledSkillDefinition = {
  name: string
  description: string
  aliases?: string[]
  whenToUse?: string
  argumentHint?: string
  allowedTools?: string[]       // 工具白名单
  model?: string                // 模型覆盖
  disableModelInvocation?: boolean
  userInvocable?: boolean
  isEnabled?: () => boolean     // 动态启用条件
  hooks?: HooksSettings         // 内嵌 Hook 配置
  context?: 'inline' | 'fork'  // 执行上下文
  agent?: string                // fork 模式下的 Agent 类型
  files?: Record<string, string> // 附加参考文件
  getPromptForCommand: (
    args: string,
    context: ToolUseContext,
  ) => Promise<ContentBlockParam[]>
}
```

这个类型涵盖了一个 Skill 的全部语义：

- `allowedTools`：Skill 被展开执行时，模型在该 Skill 的上下文内只能使用这个白名单里的工具。这是一种细粒度的权限隔离机制。
- `model`：允许单个 Skill 覆盖全局模型设置。例如某个 Skill 可以强制使用更强的模型来处理复杂任务。
- `context`：`'inline'` 意味着 Skill 的提示词直接展开到当前对话；`'fork'` 则意味着系统会启动一个独立的子智能体来执行，有自己的 token 预算和上下文隔离。
- `files`：一个键值对映射，键是相对路径，值是文件内容。Skill 首次被调用时，这些文件会被解压到磁盘的临时目录，模型可以通过 `Read`/`Grep` 工具按需读取。这让内嵌在二进制中的 Skill 也能携带复杂的参考文档。
- `hooks`：Skill 激活时自动注册的 Hook 配置，与 settings.json 中的 Hook 格式完全相同。

### 13.2.2 Skill 注册机制：registerBundledSkill()

核心注册函数同样位于 [`src/skills/bundledSkills.ts`](../../../claude-code-source-code/src/skills/bundledSkills.ts)：

```typescript
// 内部注册表，存储所有已注册的 Bundled Skill
const bundledSkills: Command[] = []

export function registerBundledSkill(definition: BundledSkillDefinition): void {
  const { files } = definition
  let skillRoot: string | undefined
  let getPromptForCommand = definition.getPromptForCommand

  // 如果 Skill 携带了附加文件，在首次调用时懒加载解压
  if (files && Object.keys(files).length > 0) {
    skillRoot = getBundledSkillExtractDir(definition.name)
    let extractionPromise: Promise<string | null> | undefined
    const inner = definition.getPromptForCommand
    getPromptForCommand = async (args, ctx) => {
      extractionPromise ??= extractBundledSkillFiles(definition.name, files)
      const extractedDir = await extractionPromise
      const blocks = await inner(args, ctx)
      if (extractedDir === null) return blocks
      return prependBaseDir(blocks, extractedDir) // 在提示词前面追加基础目录路径
    }
  }

  const command: Command = {
    type: 'prompt',
    name: definition.name,
    source: 'bundled',
    loadedFrom: 'bundled',
    allowedTools: definition.allowedTools ?? [],
    // ...其他字段映射
    getPromptForCommand,
  }
  bundledSkills.push(command)
}
```

这个函数完成了两件事：

1. **懒加载文件**：如果 Skill 定义了 `files`，不会在注册时立即写磁盘，而是通过闭包将 `extractionPromise` 记忆化，保证"首次调用时解压，后续调用复用"。并发调用同一个 Skill 时，多个 caller 会 await 同一个 Promise，不会产生竞争写入。
2. **将 BundledSkillDefinition 转换为 Command**：设置 `source: 'bundled'`，这个标记在后续的过滤和调度逻辑中具有重要意义——bundled Skill 在提示词的 token 预算超出时享有不截断描述的优先权。

文件安全写入方面代码也相当讲究：

```typescript
const SAFE_WRITE_FLAGS =
  process.platform === 'win32'
    ? 'wx'
    : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW
```

`O_EXCL`（独占创建，文件已存在则报错）和 `O_NOFOLLOW`（不跟随末端符号链接）组合使用，防止攻击者预先创建符号链接来劫持写入路径。文件权限设为 `0o600`，目录权限设为 `0o700`，确保只有进程所有者可读写。

### 13.2.3 内置 Skill 的初始化流程

所有 Bundled Skill 的注册都集中在 [`src/skills/bundled/index.ts`](../../../claude-code-source-code/src/skills/bundled/index.ts)：

```typescript
export function initBundledSkills(): void {
  registerUpdateConfigSkill()
  registerKeybindingsSkill()
  registerVerifySkill()
  registerDebugSkill()
  registerLoremIpsumSkill()
  registerSkillifySkill()
  registerRememberSkill()
  registerSimplifySkill()
  registerBatchSkill()
  registerStuckSkill()
  // 特性开关控制的可选 Skill
  if (feature('AGENT_TRIGGERS')) {
    const { registerLoopSkill } = require('./loop.js')
    registerLoopSkill()
  }
  if (feature('BUILDING_CLAUDE_APPS')) {
    const { registerClaudeApiSkill } = require('./claudeApi.js')
    registerClaudeApiSkill()
  }
  // ...更多特性开关
}
```

这里有几个值得注意的设计细节：

**条件注册**：功能开关（feature flags）通过 `feature()` 函数在编译期决定是否包含对应代码。Bun 的 bundler 会做树摇（tree-shaking），不满足条件的分支代码不会出现在最终二进制中。对于还在内部测试的功能（如 `KAIROS`、`AGENT_TRIGGERS_REMOTE`），用 `require()` 而非 `import` 是为了避免静态分析把这些模块扯进 bundle。

**运行时条件**：部分 Skill 不仅依赖特性开关，还依赖运行时条件。以 `/remember` Skill 为例：

```typescript
export function registerRememberSkill(): void {
  if (process.env.USER_TYPE !== 'ant') {
    return  // 仅 Anthropic 员工可用
  }
  registerBundledSkill({
    name: 'remember',
    isEnabled: () => isAutoMemoryEnabled(), // 启用条件：auto-memory 功能开启
    // ...
  })
}
```

`isEnabled` 是一个动态检查函数，每次列举命令时都会重新调用，确保 Skill 的可见性能随配置变化而实时更新。

### 13.2.4 一个具体的 Skill 实现：/simplify

[`src/skills/bundled/simplify.ts`](../../../claude-code-source-code/src/skills/bundled/simplify.ts) 展示了一个典型的 Bundled Skill 实现：

```typescript
export function registerSimplifySkill(): void {
  registerBundledSkill({
    name: 'simplify',
    description:
      'Review changed code for reuse, quality, and efficiency, then fix any issues found.',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = SIMPLIFY_PROMPT
      if (args) {
        prompt += `\n\n## Additional Focus\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
```

`SIMPLIFY_PROMPT` 是一段详细的 Markdown 指令，描述了三个并行 Agent 分别负责代码复用审查、代码质量审查和效率审查，最后汇总并修复问题。这个 Skill 没有 `allowedTools` 限制（意味着继承父级权限），也没有指定 `model`（意味着使用默认模型）。

相比之下，`/skillify` Skill 声明了严格的工具白名单：

```typescript
registerBundledSkill({
  name: 'skillify',
  allowedTools: [
    'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'AskUserQuestion', 'Bash(mkdir:*)',
  ],
  disableModelInvocation: false,
  // ...
})
```

`Bash(mkdir:*)` 这种细粒度的权限声明语法（只允许 `mkdir` 命令）体现了 allowedTools 机制的灵活性。

---

## 13.3 与 Command 系统的关系

### 13.3.1 Command 的统一抽象

Skill 并不是独立于 Command 系统之外的概念。在 [`src/types/command.ts`](../../../claude-code-source-code/src/types/command.ts) 中，`Command` 是一个联合类型：

```typescript
export type Command = CommandBase & (PromptCommand | LocalCommand | LocalJSXCommand)

export type PromptCommand = {
  type: 'prompt'
  source: SettingSource | 'builtin' | 'mcp' | 'plugin' | 'bundled'
  loadedFrom?: LoadedFrom
  allowedTools?: string[]
  model?: string
  context?: 'inline' | 'fork'
  hooks?: HooksSettings
  skillRoot?: string
  paths?: string[]  // glob 模式，限定 Skill 在哪些文件上下文中可见
  getPromptForCommand(args: string, context: ToolUseContext): Promise<ContentBlockParam[]>
}
```

`source` 和 `loadedFrom` 两个字段共同标识一个命令的来源：

| source | loadedFrom | 说明 |
|--------|-----------|------|
| `'bundled'` | `'bundled'` | 编译进二进制的内置 Skill |
| `'plugin'` | `'plugin'` | 来自已安装 Plugin 的 Skill |
| `'projectSettings'` | `'skills'` | 项目级 `.claude/skills/` 目录下的文件 |
| `'userSettings'` | `'skills'` | 用户级 `~/.claude/skills/` 目录下的文件 |
| `'builtin'` | — | 硬编码的内置命令（`/help`、`/clear` 等） |
| `'mcp'` | `'mcp'` | MCP 服务器提供的 Skill |

### 13.3.2 命令的加载与组装

[`src/commands.ts`](../../../claude-code-source-code/src/commands.ts) 中的 `loadAllCommands` 函数负责把所有来源的命令组装成统一列表：

```typescript
const loadAllCommands = memoize(async (cwd: string): Promise<Command[]> => {
  const [
    { skillDirCommands, pluginSkills, bundledSkills, builtinPluginSkills },
    pluginCommands,
    workflowCommands,
  ] = await Promise.all([
    getSkills(cwd),
    getPluginCommands(),
    getWorkflowCommands ? getWorkflowCommands(cwd) : Promise.resolve([]),
  ])

  return [
    ...bundledSkills,         // 内置 Skill（优先级最高）
    ...builtinPluginSkills,   // Built-in Plugin 的 Skill
    ...skillDirCommands,      // 文件系统 Skill
    ...workflowCommands,      // Workflow 命令
    ...pluginCommands,        // Plugin 提供的命令
    ...pluginSkills,          // Plugin 提供的 Skill
    ...COMMANDS(),            // 硬编码内置命令
  ]
})
```

合并后的列表经过 `meetsAvailabilityRequirement` 和 `isCommandEnabled` 两道过滤，才是用户最终看到的命令集合。整个过程被 `memoize` 缓存，按 `cwd` 做键，避免重复的磁盘 IO。

### 13.3.3 SkillTool 可见的命令子集

并非所有命令都对模型可见。`getSkillToolCommands` 定义了 `SkillTool` 可以调用的命令范围：

```typescript
export const getSkillToolCommands = memoize(
  async (cwd: string): Promise<Command[]> => {
    const allCommands = await getCommands(cwd)
    return allCommands.filter(
      cmd =>
        cmd.type === 'prompt' &&
        !cmd.disableModelInvocation &&
        cmd.source !== 'builtin' &&
        (cmd.loadedFrom === 'bundled' ||
          cmd.loadedFrom === 'skills' ||
          cmd.loadedFrom === 'commands_DEPRECATED' ||
          cmd.hasUserSpecifiedDescription ||
          cmd.whenToUse),
    )
  },
)
```

过滤逻辑的含义是：

1. 只有 `type: 'prompt'` 的命令可以被模型调用（`local` 和 `localJSX` 类型的命令只供用户交互使用）
2. `disableModelInvocation: true` 的命令对模型不可见（这类命令只能由用户手动输入）
3. `source: 'builtin'` 的硬编码命令排除在外
4. Plugin 和 MCP 来源的命令需要有显式描述（`hasUserSpecifiedDescription` 或 `whenToUse`）才能对模型可见，防止描述不清楚的命令污染模型的选择空间

---

## 13.4 SkillTool：模型如何调用 Skill

### 13.4.1 工具定义与输入模式

[`src/tools/SkillTool/SkillTool.ts`](../../../claude-code-source-code/src/tools/SkillTool/SkillTool.ts) 定义了模型可以调用的 `Skill` 工具：

```typescript
export const inputSchema = lazySchema(() =>
  z.object({
    skill: z.string().describe('The skill name. E.g., "commit", "review-pr", or "pdf"'),
    args: z.string().optional().describe('Optional arguments for the skill'),
  }),
)
```

输出模式是一个联合类型，区分两种执行路径：

```typescript
// inline 模式：Skill 提示词展开到当前对话
const inlineOutputSchema = z.object({
  success: z.boolean(),
  commandName: z.string(),
  allowedTools: z.array(z.string()).optional(),
  model: z.string().optional(),
  status: z.literal('inline').optional(),
})

// fork 模式：Skill 在独立子智能体中执行
const forkedOutputSchema = z.object({
  success: z.boolean(),
  commandName: z.string(),
  status: z.literal('forked'),
  agentId: z.string(),
  result: z.string(),  // 子智能体执行完毕后返回的摘要
})
```

### 13.4.2 工具描述提示词

[`src/tools/SkillTool/prompt.ts`](../../../claude-code-source-code/src/tools/SkillTool/prompt.ts) 中的 `getPrompt` 函数返回注入给模型的工具说明：

```typescript
export const getPrompt = memoize(async (_cwd: string): Promise<string> => {
  return `Execute a skill within the main conversation

When users ask you to perform tasks, check if any of the available skills match.
Skills provide specialized capabilities and domain knowledge.

When users reference a "slash command" or "/<something>" (e.g., "/commit", "/review-pr"),
they are referring to a skill. Use this tool to invoke it.

How to invoke:
- Use this tool with the skill name and optional arguments
- Examples:
  - \`skill: "pdf"\` - invoke the pdf skill
  - \`skill: "commit", args: "-m 'Fix bug'"\` - invoke with arguments

Important:
- When a skill matches the user's request, this is a BLOCKING REQUIREMENT:
  invoke the relevant Skill tool BEFORE generating any other response
- NEVER mention a skill without actually calling this tool
- Do not invoke a skill that is already running
`
})
```

"BLOCKING REQUIREMENT" 是一个强语气的指令——模型在识别到匹配 Skill 时，必须先调用工具，不能先生成文本响应。这防止了模型"空口白话"描述一个技能应该怎么做，而不真正触发它。

### 13.4.3 Skill 列表的 token 预算管理

`getSkillToolCommands` 返回的命令列表会附加到 system-reminder 消息中，让模型在每轮对话开始时知道有哪些 Skill 可用。但随着 Skill 数量增多，列表可能消耗大量 token。`prompt.ts` 中的 `formatCommandsWithinBudget` 实现了精细的预算控制：

```typescript
// Skill 列表占用上下文窗口的 1%（字符数）
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
export const DEFAULT_CHAR_BUDGET = 8_000  // 回退值：200k × 4 × 1%

export function formatCommandsWithinBudget(
  commands: Command[],
  contextWindowTokens?: number,
): string {
  const budget = getCharBudget(contextWindowTokens)

  // 优先保证 bundled Skill 的完整描述
  // 其余 Skill 按预算等比截断描述
  // 极端情况下非 bundled Skill 只显示名称
}
```

Bundled Skill 具有最高优先级，始终展示完整描述；第三方 Skill 和用户自定义 Skill 在空间紧张时会被截断，甚至只保留名称。每条描述还有硬性上限（250 字符），防止单条过长的 `whenToUse` 独占预算。

### 13.4.4 inline 与 fork 两种执行路径

当模型调用 SkillTool 时，系统根据 Skill 的 `context` 字段分流到两条执行路径：

**inline 路径**：调用 `getPromptForCommand` 展开提示词，将结果作为一条系统消息注入到当前对话中。模型"看到"这段提示词后，继续用当前对话的工具权限和模型配置执行任务。

**fork 路径**：调用 `executeForkedSkill` 函数，准备一个独立的子智能体上下文（`prepareForkedCommandContext`），然后通过 `runAgent` 启动子智能体。父级智能体等待子智能体完成，接收其执行结果摘要：

```typescript
async function executeForkedSkill(
  command: Command & { type: 'prompt' },
  // ...
): Promise<ToolResult<Output>> {
  const agentId = createAgentId()

  const { modifiedGetAppState, baseAgent, promptMessages, skillContent } =
    await prepareForkedCommandContext(command, args || '', context)

  for await (const message of runAgent({
    agentDefinition,
    promptMessages,
    toolUseContext: { ...context, getAppState: modifiedGetAppState },
    canUseTool,
    model: command.model as ModelAlias | undefined,
    // ...
  })) {
    agentMessages.push(message)
    // 向父级报告进度
  }

  const resultText = extractResultText(agentMessages, 'Skill execution completed')
  agentMessages.length = 0  // 释放内存

  return {
    data: { success: true, commandName, status: 'forked', agentId, result: resultText },
  }
}
```

fork 模式的优势在于**上下文隔离**：子智能体拥有自己的 token 预算，不会影响父级对话的 context window；子智能体的中间步骤（大量工具调用）不会污染父级的对话历史。适合用于自包含的、不需要实时用户介入的长任务。

---

## 13.5 Plugin 架构

### 13.5.1 Plugin 的两种形态

Claude Code 的 Plugin 系统有两种形态：

**外部插件（External Plugin）**：从 Git 仓库或 marketplace 安装，存储在本地文件系统中，包含一个 `plugin.json` 清单文件。

**内置插件（Built-in Plugin）**：编译进二进制的插件，通过 `registerBuiltinPlugin()` 函数注册，在 `/plugin` UI 中对用户可见，可以被启用/禁用。

目前 [`src/plugins/bundled/index.ts`](../../../claude-code-source-code/src/plugins/bundled/index.ts) 中 `initBuiltinPlugins()` 函数体为空——这是为未来将部分 Bundled Skill 迁移为用户可切换的 Built-in Plugin 而预留的脚手架。

### 13.5.2 BuiltinPluginDefinition 类型

[`src/types/plugin.ts`](../../../claude-code-source-code/src/types/plugin.ts) 定义了内置插件的结构：

```typescript
export type BuiltinPluginDefinition = {
  name: string
  description: string
  version?: string
  skills?: BundledSkillDefinition[]   // 携带的 Skill 列表
  hooks?: HooksSettings               // 携带的 Hook 配置
  mcpServers?: Record<string, McpServerConfig>  // 携带的 MCP 服务器
  isAvailable?: () => boolean         // 动态可用性检查
  defaultEnabled?: boolean            // 默认启用状态
}
```

一个 Plugin 可以同时包含 Skills、Hooks 和 MCP 服务器。这三类组件都跟随 Plugin 的启用/禁用状态一起激活或停用，这是 Plugin 与独立 Skill 最重要的区别。

### 13.5.3 Plugin 的注册与状态管理

[`src/plugins/builtinPlugins.ts`](../../../claude-code-source-code/src/plugins/builtinPlugins.ts) 管理内置插件的注册表和状态：

```typescript
const BUILTIN_PLUGINS: Map<string, BuiltinPluginDefinition> = new Map()

export function getBuiltinPlugins(): {
  enabled: LoadedPlugin[]
  disabled: LoadedPlugin[]
} {
  const settings = getSettings_DEPRECATED()

  for (const [name, definition] of BUILTIN_PLUGINS) {
    if (definition.isAvailable && !definition.isAvailable()) {
      continue  // 不可用的插件直接隐藏
    }

    const pluginId = `${name}@${BUILTIN_MARKETPLACE_NAME}`
    const userSetting = settings?.enabledPlugins?.[pluginId]
    // 优先级：用户设置 > 插件默认值 > true
    const isEnabled =
      userSetting !== undefined
        ? userSetting === true
        : (definition.defaultEnabled ?? true)

    const plugin: LoadedPlugin = {
      name,
      source: pluginId,   // 格式：{name}@builtin
      isBuiltin: true,
      hooksConfig: definition.hooks,
      mcpServers: definition.mcpServers,
      // ...
    }
    isEnabled ? enabled.push(plugin) : disabled.push(plugin)
  }
  return { enabled, disabled }
}
```

Plugin ID 的格式 `{name}@builtin` 是一个重要的命名约定，用来区分内置插件（`@builtin`）和来自外部 marketplace 的插件（`{name}@{marketplace-name}`）。`isBuiltinPluginId()` 函数通过检查是否以 `@builtin` 结尾来判断来源。

### 13.5.4 Plugin Skill 的提取与加载

Plugin 提供的 Skill 通过 `getBuiltinPluginSkillCommands` 转换为标准的 `Command` 对象：

```typescript
export function getBuiltinPluginSkillCommands(): Command[] {
  const { enabled } = getBuiltinPlugins()
  const commands: Command[] = []

  for (const plugin of enabled) {
    const definition = BUILTIN_PLUGINS.get(plugin.name)
    if (!definition?.skills) continue
    for (const skill of definition.skills) {
      commands.push(skillDefinitionToCommand(skill))
    }
  }
  return commands
}

function skillDefinitionToCommand(definition: BundledSkillDefinition): Command {
  return {
    type: 'prompt',
    source: 'bundled',    // 注意：仍然标记为 'bundled'
    loadedFrom: 'bundled',
    // ...其余字段直接映射
  }
}
```

值得注意的是，Plugin Skill 的 `source` 仍然是 `'bundled'` 而不是 `'builtin'`。源码注释解释了原因：

> `'builtin'` in `Command.source` means hardcoded slash commands (`/help`, `/clear`). Using `'bundled'` keeps these skills in the Skill tool's listing, analytics name logging, and prompt-truncation exemption. The user-toggleable aspect is tracked on `LoadedPlugin.isBuiltin`.

也就是说，`Command.source: 'builtin'` 是保留给内部硬编码命令（如 `/clear`、`/help`）的标识，它们对模型不可见。Plugin Skill 需要对模型可见，所以使用 `'bundled'`。是否为内置插件的信息由 `LoadedPlugin.isBuiltin` 字段单独追踪。

### 13.5.5 外部 Plugin 的清单格式

外部 Plugin 通过 `plugin.json`（或 `.claude-plugin/plugin.json`）清单文件描述自身，格式由 [`src/utils/plugins/schemas.ts`](../../../claude-code-source-code/src/utils/plugins/schemas.ts) 中的 `PluginManifestMetadataSchema` 定义：

```typescript
const PluginManifestMetadataSchema = lazySchema(() =>
  z.object({
    name: z.string().min(1).refine(name => !name.includes(' ')), // kebab-case
    version: z.string().optional(),
    description: z.string().optional(),
    author: PluginAuthorSchema().optional(),
    homepage: z.string().url().optional(),
    dependencies: z.array(DependencyRefSchema()).optional(),
  }),
)
```

一个完整的 Plugin 目录结构如下（来自 `pluginLoader.ts` 的注释）：

```
my-plugin/
├── plugin.json          # 可选清单，包含元数据
├── commands/            # 自定义 slash commands
│   ├── build.md
│   └── deploy.md
├── agents/              # 自定义 AI agents
│   └── test-runner.md
├── skills/              # Skill 定义
│   └── my-workflow.md
└── hooks/               # Hook 配置
    └── hooks.json
```

Plugin 可以声明对其他 Plugin 的 `dependencies`，加载器会检查依赖是否满足。如果依赖未启用或未找到，会生成 `dependency-unsatisfied` 类型的错误。

---

## 13.6 三者的对比与边界

理解了各自的源码实现之后，我们可以做一个更清晰的对比：

### 13.6.1 定位对比

| 维度 | Skill | Plugin | Hook |
|------|-------|--------|------|
| **核心形式** | 提示词模板 | 扩展包（容器） | 副作用脚本 |
| **激活方式** | 模型调用工具 / 用户输入斜杠命令 | 用户在 `/plugin` UI 中启用 | 生命周期事件触发 |
| **用户可见性** | 作为 slash command 出现 | 出现在 `/plugin` 列表中 | 后台运行，用户不直接感知 |
| **可包含** | 提示词、工具白名单、模型覆盖、Hooks、Files | Skills、Hooks、MCP 服务器 | 命令/HTTP/LLM 提示词 |
| **生命周期管理** | 无（只要系统运行就可用） | 有（可启用/禁用） | 与 session 或 Skill 绑定 |
| **执行上下文** | inline 或 fork | — | 在 Hook 事件回调中 |

### 13.6.2 选择指南

**何时创建 Skill**：当你有一套可重复使用的工作流程，想以提示词的形式编码下来，并让模型能够自动识别和调用。例如代码审查、PR 合规检查、内存整理等。

**何时创建 Plugin**：当你的扩展需要打包多种组件（既有 Skill 又有 Hook，或者需要配套 MCP 服务器），并且希望用户能够整体控制这个扩展的启用/禁用状态。

**何时使用 Hook**：当你需要在特定事件点（模型采样前、工具调用前、会话结束时等）插入自动化的副作用逻辑，例如自动提交、安全检查、通知等。Hook 不面向模型，而是面向外部系统。

### 13.6.3 组合使用

三者可以自由组合。一个典型的复杂扩展可能是这样的：

1. 创建一个 **Plugin**，携带一个 `/deploy` Skill 和一个 `Stop` Hook
2. `/deploy` Skill 是一套部署工作流的提示词，指定 `context: fork` 在独立子智能体中运行，声明 `allowedTools` 只允许 `Bash(gh:*)` 和 `Bash(kubectl:*)`
3. `Stop` Hook 在每次会话结束时运行一个脚本，清理临时资源
4. Plugin 整体可以被用户在 `/plugin` UI 中一键启用/禁用

这个组合让扩展的功能内聚、权限精确、生命周期可控。

---

## 13.7 小结：扩展体系的分层设计

回顾本章内容，Claude Code 的扩展体系呈现出清晰的分层结构：

最底层是 **Hook**，提供最细粒度的事件钩子，可以在不改变对话流程的前提下注入副作用。

中间层是 **Skill**，将工作流封装为可复用的提示词模板，通过 SkillTool 融入模型的工具调用体系，支持权限隔离（`allowedTools`）、模型覆盖（`model`）和上下文隔离（`context: fork`）。

上层是 **Plugin**，作为多种组件的容器，提供统一的生命周期管理，让用户能够以粗粒度控制一组功能的启用状态。

从源码视角看，这三层的实现都遵循相似的设计原则：**注册表 + 懒加载**。Skill 通过 `registerBundledSkill` 注册到内存注册表，Plugin 通过 `registerBuiltinPlugin` 注册，Hook 通过 `registerSkillHooks`/`addSessionHook` 注册到 session 作用域。实际工作（磁盘 IO、子智能体启动、脚本执行）都在首次调用时懒加载，保证启动性能。

`commands.ts` 中的 `loadAllCommands` 是整个扩展体系的汇聚点，它并行加载所有来源的命令，合并去重，最终交给 `getCommands` 统一对外服务。而 `getSkillToolCommands` 则负责从这个全量列表中筛选出模型可见的子集，再通过 `formatCommandsWithinBudget` 控制注入到 system-reminder 中的 token 量，在"让模型知道更多"和"节约上下文窗口"之间取得平衡。

这套架构的精妙之处在于：对用户而言，Skill 就是一个 slash command；对模型而言，Skill 就是一个工具；对开发者而言，注册一个新 Skill 只需写一个 TypeScript 函数。三种视角下的体验都尽可能简洁，而复杂性被封装在框架内部。

---

**下一章预告**：在了解了 Skill 和 Plugin 系统之后，我们将把目光转向 Claude Code 的另一项核心能力——**MCP（Model Context Protocol）集成**。MCP 让 Claude Code 能够连接任意外部工具服务器，极大地拓展了其工具调用的边界。第 14 章将深入 MCP 客户端的实现、工具的动态注册机制，以及 MCP Skill 与本章讨论的 Bundled Skill 在运行时如何统一协作。
