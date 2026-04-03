# 第 8 章 关键工具实现解析

Claude Code 内置了 40 余个工具（Tool），涵盖文件操作、代码搜索、命令执行、子 Agent 调度等方方面面。上一章我们分析了工具系统的接口定义与编排机制，本章将深入几个最核心、最具代表性的工具实现，从源码层面剖析它们的设计决策与工程 trade-off。

![关键工具实现](/images/ch08-tool-implementations.png)

我们选取以下六个工具进行精读：

- **BashTool** —— 命令执行的核心引擎
- **FileReadTool / FileEditTool / FileWriteTool** —— 文件操作三件套
- **AgentTool** —— 子 Agent 生成与隔离
- **GlobTool / GrepTool** —— 高性能代码搜索

## 8.1 BashTool：命令执行引擎

BashTool 是整个工具集中最复杂的单体工具，其源码目录 `src/tools/BashTool/` 包含近 20 个文件，涉及命令解析、安全校验、沙箱管控、输出截断、后台任务等多个子系统。

### 8.1.1 输入模型与超时控制

BashTool 的输入 Schema 定义在 [BashTool.tsx] 中，通过 `lazySchema` 延迟求值以避免模块加载时的循环依赖：

```typescript
const fullInputSchema = lazySchema(() => z.strictObject({
  command: z.string().describe('The command to execute'),
  timeout: semanticNumber(z.number().optional())
    .describe(`Optional timeout in milliseconds (max ${getMaxTimeoutMs()})`),
  description: z.string().optional().describe('...'),
  run_in_background: semanticBoolean(z.boolean().optional()),
  dangerouslyDisableSandbox: semanticBoolean(z.boolean().optional()),
}));
```

这里有两个值得注意的设计：

1. **语义类型包装**：`semanticNumber` 和 `semanticBoolean` 并非标准 Zod 类型，而是对模型输出做容错处理的包装器——当模型返回 `"true"` 而非 `true` 时也能正确解析。这反映了一个务实的工程抉择：与其依赖模型 100% 严格遵循 JSON Schema，不如在工具端做宽松解析。

2. **条件裁剪 Schema**：当后台任务被禁用时，`run_in_background` 字段会从 Schema 中移除，模型根本看不到这个参数。内部字段 `_simulatedSedEdit` 则始终被 `omit`，防止模型直接传入绕过权限校验。

超时控制分为默认超时和最大超时两档。默认超时通常为 120 秒（2 分钟），最大超时为 600 秒（10 分钟），由 [prompt.ts] 中的 `getDefaultTimeoutMs()` 和 `getMaxTimeoutMs()` 从全局配置获取。

### 8.1.2 输出截断与图片处理

命令输出的处理逻辑在 [utils.ts] 的 `formatOutput` 函数中：

```typescript
export function formatOutput(content: string): {
  totalLines: number
  truncatedContent: string
  isImage?: boolean
} {
  const isImage = isImageOutput(content)
  if (isImage) {
    return { totalLines: 1, truncatedContent: content, isImage }
  }

  const maxOutputLength = getMaxOutputLength()
  if (content.length <= maxOutputLength) {
    return { totalLines: countCharInString(content, '\n') + 1, truncatedContent: content }
  }

  const truncatedPart = content.slice(0, maxOutputLength)
  const remainingLines = countCharInString(content, '\n', maxOutputLength) + 1
  const truncated = `${truncatedPart}\n\n... [${remainingLines} lines truncated] ...`
  return { totalLines: countCharInString(content, '\n') + 1, truncatedContent: truncated }
}
```

截断策略采用"前部保留"——保留输出的前 N 个字符，截断尾部。这与人类阅读命令输出的习惯一致：开头通常包含最关键的错误信息或编译结果。截断后会附加提示行，告知模型有多少行被丢弃，帮助模型判断是否需要缩小范围重试。

对于图片输出（以 `data:image/` 开头的 base64 数据），系统会调用 `resizeShellImageOutput` 进行压缩和降采样，避免高 DPI 截图占据过多 token。

### 8.1.3 安全边界：多层防御体系

BashTool 的安全校验是整个工具系统中最复杂的部分。[bashSecurity.ts] 定义了超过 20 种安全检查项，每种检查都有数字编号用于分析日志：

```typescript
const BASH_SECURITY_CHECK_IDS = {
  INCOMPLETE_COMMANDS: 1,
  JQ_SYSTEM_FUNCTION: 2,
  OBFUSCATED_FLAGS: 4,
  SHELL_METACHARACTERS: 5,
  DANGEROUS_VARIABLES: 6,
  DANGEROUS_PATTERNS_COMMAND_SUBSTITUTION: 8,
  ZSH_DANGEROUS_COMMANDS: 20,
  // ... 共 23 种检查
}
```

这些检查覆盖了命令注入、参数混淆、进程替换、Zsh 特有攻击向量（如 `zmodload`、`emulate -c`）等威胁模型。[bashCommandHelpers.ts] 负责复合命令的权限检查——当命令包含管道（`|`）或逻辑操作符（`&&`、`||`）时，系统会将命令拆分为多个 segment，逐段检查权限，然后汇总决策。特别值得注意的是跨 segment 的 `cd + git` 组合检测，防止通过 bare repository 的 `fsmonitor` 机制绕过安全边界。

沙箱（Sandbox）则在操作系统层面提供文件系统和网络的访问控制。[prompt.ts] 中的 `getSimpleSandboxSection` 将沙箱配置（允许读写的路径、网络白名单等）注入到工具描述中，让模型感知约束边界，从而在生成命令时就避开受限路径。

### 8.1.4 后台任务

BashTool 支持两种后台执行模式：模型主动请求（`run_in_background: true`）和系统自动降级（assistant mode 下命令执行超过 15 秒自动转入后台）。后台任务的输出写入磁盘文件，任务完成后通过通知机制告知模型。

## 8.2 文件操作三件套：Read / Edit / Write

### 8.2.1 为什么不是一个 FileTool？

初看之下，将读、编辑、写合并为一个统一的 FileTool 似乎更简洁。然而 Claude Code 将其拆分为三个独立工具，这是一个深思熟虑的设计决策：

| 维度 | FileReadTool | FileEditTool | FileWriteTool |
|------|-------------|-------------|---------------|
| 权限等级 | 只读，通常自动放行 | 写入，需用户确认 | 写入，需用户确认 |
| 操作语义 | 无副作用 | 精确替换 | 全量覆写 |
| 并发安全 | 完全安全 | 需要过期检测 | 需要过期检测 |
| 使用频率 | 极高 | 高 | 中等 |

**权限模型的差异**是最核心的原因。FileReadTool 是只读操作，在大多数场景下可以自动放行而无需用户介入；而 FileEditTool 和 FileWriteTool 修改文件系统，需要经过权限审批。将它们合并意味着要么全部都需审批（降低效率），要么引入复杂的内部分支逻辑——两种方案都不如直接拆分清晰。

**并发安全**也是关键因素。FileReadTool 被标记为 `isConcurrencySafe`（虽然源码中未显式标注，但读操作天然安全），可以与其他只读工具并行执行；而写入工具则需要串行化以避免竞态条件。

### 8.2.2 FileReadTool：读取的精细控制

[FileReadTool.ts] 是一个功能极为丰富的读取工具，远不止"读文件"这么简单。它的核心设计要点包括：

**Token 上限保护**：当文件内容超过最大允许 token 数时，会抛出 `MaxFileReadTokenExceededError`，要求模型使用 `offset` 和 `limit` 参数分段读取。这一机制防止了大文件（如编译产物、日志文件）消耗过多上下文窗口。

**多格式支持**：FileReadTool 不仅能读取文本文件，还支持图片（PNG、JPG 等）、PDF、Jupyter Notebook（`.ipynb`）等格式。对于图片文件，它会调用图片处理管线进行压缩和降采样；对于 PDF，支持分页读取（`pages` 参数），大型 PDF 强制要求指定页码范围。

**设备文件阻断**：源码中维护了一个 `BLOCKED_DEVICE_PATHS` 集合，阻止读取 `/dev/zero`、`/dev/random`、`/dev/stdin` 等设备文件——这些文件要么产生无限输出、要么阻塞等待输入，都会导致进程挂起。

**读取状态追踪**：每次成功读取文件后，工具会在 `readFileState` 中记录文件路径、内容、时间戳以及读取范围（offset/limit）。这个状态是 FileEditTool 和 FileWriteTool 执行过期检测（staleness check）的基础。

### 8.2.3 FileEditTool：精确替换与过期检测

FileEditTool 实现了"查找-替换"语义：给定 `old_string` 和 `new_string`，在文件中定位并替换。这一设计比发送完整文件内容要高效得多——对于大文件，模型只需发送少量变更而非全文。

[FileEditTool.ts] 中的验证逻辑（`validateInput`）是整个工具中最精密的部分：

1. **唯一性校验**：如果 `old_string` 在文件中匹配到多处且 `replace_all` 为 false，工具拒绝执行并要求模型提供更多上下文以唯一定位。
2. **过期检测**：通过比较文件的最后修改时间与 `readFileState` 中记录的时间戳，检测文件是否在读取后被其他进程（如 linter、用户编辑器）修改。若已过期，要求模型重新读取。
3. **前置读取要求**：如果模型在没有先调用 FileReadTool 的情况下就尝试编辑文件，工具会拒绝并提示"先读后写"。这不仅是安全措施，也确保模型对文件当前状态有准确认知。
4. **引号归一化**：`findActualString` 函数（定义在 [utils.ts] 中）处理弯引号（curly quotes）与直引号（straight quotes）的自动匹配。模型输出的 JSON 中无法包含弯引号，但源文件可能使用弯引号，`normalizeQuotes` 会在两者之间做转换，`preserveQuoteStyle` 则确保替换后保持文件原有的引号风格。

文件写入采用"读-改-写"原子操作模式：在 `call` 方法内部，同步读取文件内容、执行替换、写回磁盘这三步之间不插入任何异步操作，以保证一致性。写入完成后还会通知 LSP 服务器和 VSCode 扩展，触发诊断更新和 diff 视图刷新。

### 8.2.4 FileWriteTool：全量覆写的场景

FileWriteTool 用于创建新文件或完整覆盖已有文件的内容。与 FileEditTool 的关键区别在于：

- **操作粒度不同**：FileEditTool 执行精确的片段替换，FileWriteTool 是全量写入
- **适用场景不同**：新建文件只能用 FileWriteTool；对已有文件的大规模重写也适合用 FileWriteTool

FileWriteTool 的实现与 FileEditTool 共享同一套过期检测和前置读取校验机制（对已有文件）。但在行尾处理上有一个重要差异：FileEditTool 保留文件原有的行尾风格（LF 或 CRLF），而 FileWriteTool 始终使用 LF——因为全量写入意味着模型发送了明确的行尾字符，不需要额外转换。源码注释说明了这一决策的背景：

> Write is a full content replacement — the model sent explicit line endings in `content` and meant them. Do not rewrite them.

## 8.3 AgentTool：子 Agent 的生成与隔离

AgentTool 是实现"Agent 调度 Agent"模式的关键工具。它允许主 Agent 启动子 Agent 来处理复杂的多步骤任务，实现了递归式的任务分解。

### 8.3.1 输入模型与 Agent 类型

[AgentTool.tsx] 中的输入 Schema 包含以下核心字段：

- `prompt`：传递给子 Agent 的任务描述
- `description`：3-5 个词的简短摘要
- `subagent_type`：指定使用哪种专用 Agent（如 test-runner、code-reviewer）
- `model`：可选的模型覆写（sonnet / opus / haiku）
- `run_in_background`：是否在后台运行
- `isolation`：隔离模式，支持 `worktree`（git worktree 隔离）和 `remote`（远程环境隔离）

当启用了 Fork Subagent 特性时，省略 `subagent_type` 会触发隐式 fork——子 Agent 继承父 Agent 的完整对话上下文和系统提示词，本质上是"克隆自己"来处理子任务。[forkSubagent.ts] 中定义的 `FORK_AGENT` 配置明确了这一语义：

```typescript
export const FORK_AGENT = {
  agentType: FORK_SUBAGENT_TYPE,
  tools: ['*'],       // 继承父级的全部工具
  model: 'inherit',   // 保持相同模型以复用 prompt cache
  permissionMode: 'bubble', // 权限请求冒泡到父级终端
} satisfies BuiltInAgentDefinition
```

### 8.3.2 工具池过滤与上下文隔离

子 Agent 的工具池并非简单继承父 Agent 的全部工具。[prompt.ts] 中的 `getToolsDescription` 函数展示了工具过滤逻辑——每个 Agent 定义可以声明 `tools`（允许列表）和 `disallowedTools`（拒绝列表），两者组合决定子 Agent 可用的工具集。

[runAgent.ts] 揭示了子 Agent 上下文构建的完整流程：

1. **创建独立的 fileStateCache**：通过 `cloneFileStateCache` 或 `createFileStateCacheWithSizeLimit` 为子 Agent 创建独立的文件状态缓存，防止父子 Agent 之间的状态污染。
2. **构建独立的系统提示词**：调用 `buildEffectiveSystemPrompt` 和 `enhanceSystemPromptWithEnvDetails` 为子 Agent 组装专属的系统提示词。
3. **注册 Agent 级别的 MCP 服务**：`initializeAgentMcpServers` 函数为子 Agent 连接其定义中声明的 MCP 服务器，这些服务器在子 Agent 生命周期结束后自动清理。
4. **独立的中止控制器**：每个子 Agent 拥有自己的 `AbortController`，可以被独立取消而不影响父 Agent。

### 8.3.3 后台运行与通知机制

子 Agent 支持前台（同步）和后台（异步）两种运行模式。前台模式下，父 Agent 会阻塞等待子 Agent 返回结果；后台模式下，父 Agent 可以继续处理其他工作，子 Agent 完成后通过通知系统（notification）将结果送达。

后台 Agent 的进度追踪通过 `createProgressTracker` 和 `updateProgressFromMessage` 实现，支持实时更新任务状态。对于 "one-shot" 类型的内置 Agent（如 `Explore` 和 `Plan`，定义在 [constants.ts] 的 `ONE_SHOT_BUILTIN_AGENT_TYPES` 中），系统会跳过 agentId 和使用统计的附加信息，节省约 135 字符的 token 开销。

## 8.4 GlobTool / GrepTool：高性能代码搜索

### 8.4.1 GlobTool：文件名模式匹配

[GlobTool.ts] 是一个相对精简的工具，它封装了底层的 `glob` 函数，提供按文件名模式搜索的能力。其核心逻辑只有 20 余行：

```typescript
async call(input, { abortController, getAppState, globLimits }) {
  const start = Date.now()
  const limit = globLimits?.maxResults ?? 100
  const { files, truncated } = await glob(
    input.pattern,
    GlobTool.getPath(input),
    { limit, offset: 0 },
    abortController.signal,
    appState.toolPermissionContext,
  )
  const filenames = files.map(toRelativePath)
  return { data: { filenames, durationMs: Date.now() - start, numFiles: filenames.length, truncated } }
}
```

几个设计要点：

- **结果上限**：默认最多返回 100 个文件，防止 `**/*` 这类过于宽泛的模式返回海量结果消耗 token。
- **相对路径转换**：通过 `toRelativePath` 将绝对路径转为相对于工作目录的路径，节省 token 开销——在大型项目中，这个优化可以显著减少每次搜索结果的字符数。
- **并发安全**：标记为 `isConcurrencySafe` 和 `isReadOnly`，可以与其他只读工具并行执行。
- **权限感知**：搜索时传入 `toolPermissionContext`，确保不会返回权限规则所拒绝的路径下的文件。

### 8.4.2 GrepTool：基于 ripgrep 的内容搜索

[GrepTool.ts] 封装了 ripgrep（rg），提供正则表达式级别的代码内容搜索能力。它的输入 Schema 设计得非常丰富，映射了 ripgrep 的常用参数：

- `pattern`：正则表达式
- `output_mode`：三种输出模式——`files_with_matches`（仅文件名）、`content`（匹配内容）、`count`（匹配计数）
- `-A` / `-B` / `-C`：上下文行数控制
- `head_limit` / `offset`：分页参数
- `multiline`：跨行匹配模式

GrepTool 最精巧的设计在于**默认结果上限**（`DEFAULT_HEAD_LIMIT = 250`）和 `applyHeadLimit` 函数：

```typescript
function applyHeadLimit<T>(items: T[], limit: number | undefined, offset: number = 0) {
  if (limit === 0) {              // 显式传 0 = 不限制
    return { items: items.slice(offset), appliedLimit: undefined }
  }
  const effectiveLimit = limit ?? DEFAULT_HEAD_LIMIT  // 未指定则用默认值
  const sliced = items.slice(offset, offset + effectiveLimit)
  const wasTruncated = items.length - offset > effectiveLimit
  return { items: sliced, appliedLimit: wasTruncated ? effectiveLimit : undefined }
}
```

这实现了一个"安全默认 + 显式逃逸"的模式：不指定 `head_limit` 时自动截断到 250 条，防止宽泛搜索填满上下文窗口；模型可以传 `head_limit=0` 来获取完整结果，但需要显式决策。

在 `files_with_matches` 模式下，GrepTool 还会按文件修改时间倒序排列结果——最近修改的文件排在前面，符合开发者"关注最近变更"的直觉。这通过 `Promise.allSettled` + `stat` 实现，单个文件 stat 失败不会影响整体结果（其 mtime 降级为 0）。

搜索时自动排除版本控制目录（`.git`、`.svn`、`.hg` 等）和权限拒绝路径，并限制单行最大宽度为 500 字符（`--max-columns 500`），避免 base64 编码或压缩文件的超长行污染搜索结果。

## 8.5 小结：每个工具的设计 trade-off

回顾本章分析的六个工具，我们可以提炼出几个贯穿始终的设计原则：

**BashTool** 在灵活性与安全性之间求平衡。它是功能最强大的工具——几乎可以执行任意操作——因此也承担了最重的安全防护职责。多层校验、沙箱隔离、输出截断，每一层都在限制其能力边界，但核心设计哲学是"不要一刀切地禁止，而是分层审计"。

**文件操作三件套**选择了"拆分而非合并"，将权限模型的清晰性置于 API 简洁性之上。FileEditTool 的"先读后写"约束和精确替换语义，使得模型的每次文件修改都是可审计、可回滚的。过期检测机制则在模型与人类编辑器并行工作时提供了竞态保护。

**AgentTool** 在上下文共享与隔离之间寻找最佳平衡。Fork 模式共享完整上下文以复用 prompt cache，专用 Agent 模式则提供干净的隔离环境。工具池过滤确保子 Agent 的能力边界与其职责匹配。

**GlobTool / GrepTool** 的设计核心是 token 效率。相对路径转换、结果数量上限、分页机制、修改时间排序——每一个细节都在优化"以最少的 token 传递最有价值的信息"这一目标。

下一章我们将从工具的静态实现转向动态运行时，深入分析工具权限系统的设计——这是连接工具能力与安全边界的关键桥梁。
