# 第 17 章 附件系统——从 @文件 到 API 调用

> 当你在 Claude Code 中输入 `@myfile.ts 帮我修复这个 bug`，表面上只是在"提到"一个文件。但在引擎盖下，一个精密的附件系统正在启动——它要读取文件、判断类型、调整大小、检查权限，最终将内容编织进 API 请求。本章将拆解这条从用户输入到模型消费的完整链路。

## 17.1 概念引入：不只是文件

在传统的聊天应用中，"附件"通常指用户上传的文件。但 Claude Code 的附件概念远不止于此。在源码中，`Attachment` 是一个**40+ 种类型的联合类型**，涵盖了模型在每一轮对话中需要感知的所有上下文：

| 类别 | 示例类型 | 作用 |
|------|---------|------|
| 文件附件 | `file`, `directory`, `pdf_reference` | 用户 @提及的文件 |
| IDE 上下文 | `selected_lines_in_ide`, `opened_file_in_ide` | 编辑器当前状态 |
| 变更检测 | `edited_text_file`, `edited_image_file` | 文件修改后的 diff |
| 记忆上下文 | `nested_memory`, `relevant_memories` | CLAUDE.md 和记忆文件 |
| 模式状态 | `plan_mode`, `auto_mode`, `plan_mode_exit` | Agent 模式切换通知 |
| 任务提醒 | `todo_reminder`, `task_reminder` | 待办事项状态 |
| 系统状态 | `token_usage`, `budget_usd`, `compaction_reminder` | 资源使用情况 |
| 通信消息 | `teammate_mailbox`, `team_context` | 多 Agent 协作 |
| Hook 响应 | `async_hook_response`, `hook_cancelled` | 异步钩子结果 |
| 技能与工具 | `dynamic_skill`, `deferred_tools_delta` | 动态能力变更 |

这种设计的哲学是：**不让模型遗漏任何影响决策的上下文**。每一轮对话开始时，附件系统会像一个侦察兵一样，扫描环境中的所有变化并打包报告。

## 17.2 架构总览

```
用户输入 "@file.ts 修复 bug"
  │
  ▼
┌──────────────────────────────────────────────────┐
│              getAttachments() 主入口               │
│                                                    │
│  ┌────────────────┐  ┌────────────────────────┐   │
│  │ 输入解析        │  │ 环境扫描                │   │
│  │ · @文件提取     │  │ · 已变更文件检测        │   │
│  │ · @MCP 资源     │  │ · 嵌套 CLAUDE.md       │   │
│  │ · @Agent 提及   │  │ · 相关记忆             │   │
│  │ · 技能发现      │  │ · 模式状态             │   │
│  └───────┬────────┘  │ · 任务/待办提醒         │   │
│          │           │ · Hook 异步响应         │   │
│          │           │ · IDE 诊断信息          │   │
│          │           │ · Token 用量           │   │
│          │           └──────────┬─────────────┘   │
│          │                      │                  │
│          └──────────┬───────────┘                  │
│                     ▼                              │
│         createAttachmentMessage()                  │
│         封装为 AttachmentMessage                    │
└─────────────────────┬────────────────────────────┘
                      │
                      ▼
              注入到消息流中
              ↓ 交给 Agent Loop
```

核心入口位于 `src/utils/attachments.ts`，这是整个项目中最大的工具函数文件之一。

## 17.3 源码走读

### 17.3.1 核心类型定义

附件系统的类型定义本身就是一张架构蓝图。`Attachment` 是一个判别联合（Discriminated Union），通过 `type` 字段区分：

```typescript
// src/utils/attachments.ts

// 文件附件——最基础的形态
type FileAttachment = {
  type: 'file'
  filename: string
  content: FileReadToolOutput   // 与 FileReadTool 返回格式一致
  truncated?: boolean
  displayPath: string           // 相对于 cwd 的展示路径
}

// 紧凑文件引用——仅标题，不含内容
type CompactFileReferenceAttachment = {
  type: 'compact_file_reference'
  filename: string
  displayPath: string
}

// PDF 引用——大 PDF 只记元数据
type PDFReferenceAttachment = {
  type: 'pdf_reference'
  filename: string
  pageCount: number
  fileSize: number
  displayPath: string
}
```

注意这里的一个关键设计：**PDF 有两条路径**。小 PDF（≤30 页）内联到 `file` 类型中完整发送，大 PDF 则降级为 `pdf_reference` 只传元数据。这是一个典型的"预算感知"设计——在信息完整性和 Token 消耗之间寻找平衡。

附件最终被封装为 `AttachmentMessage`：

```typescript
type AttachmentMessage = {
  attachment: Attachment
  type: 'attachment'
  uuid: UUID
  timestamp: string
}
```

### 17.3.2 主入口：getAttachments()

`getAttachments()` 是整个附件系统的调度中心，其签名揭示了它需要多少上下文：

```typescript
async function getAttachments(
  input: string | null,              // 用户输入文本
  toolUseContext: ToolUseContext,     // 工具执行上下文
  ideSelection: IDESelection | null, // IDE 当前选中状态
  queuedCommands: QueuedCommand[],   // 排队的命令
  messages?: Message[],              // 历史消息
  querySource?: QuerySource,         // 请求来源
  options?: { skipSkillDiscovery?: boolean },
): Promise<Attachment[]>
```

函数内部按**三个层次**收集附件：

**第一层：输入附件**（从用户文本中提取）
```typescript
// 1. 解析 @文件 提及
const files = processAtMentionedFiles(input, toolUseContext)
// 2. 解析 @server:uri MCP 资源
const resources = processMcpResourceAttachments(input, toolUseContext)
// 3. 解析 @agent 提及
const agents = processAgentMentions(input, toolUseContext)
// 4. 技能预发现
const skills = await prefetchSkillDiscovery(input)
```

**第二层：线程安全附件**（任何线程都可以安全访问的上下文）
```typescript
// 这些附件不依赖主线程状态，可在子 Agent 中同样获取
const threadSafe = [
  getQueuedCommands(queuedCommands),        // 排队命令
  getDateChangeAttachment(),                 // 日期变更
  getDeferredToolsDelta(),                   // 延迟工具变更
  getChangedFiles(toolUseContext),           // 已修改文件 diff
  getNestedMemoryAttachments(),              // 嵌套 CLAUDE.md
  getPlanModeReminder(),                     // Plan 模式提醒
  getTodoReminder(),                         // 待办提醒
  getTeammateMailbox(),                      // 多 Agent 邮箱
]
```

**第三层：主线程专属附件**（仅在主线程中附加）
```typescript
// IDE 状态、诊断信息等只在主线程中有意义
const mainOnly = [
  getIdeSelections(ideSelection),            // IDE 选中文本
  getIdeOpenedFiles(),                       // IDE 打开文件
  getDiagnostics(),                          // LSP 诊断
  getTokenUsage(),                           // Token 消耗统计
  getBudgetUsd(),                            // 预算限制
]
```

### 17.3.3 容错设计：maybe() 守护模式

每个附件采集函数都被一个名为 `maybe()` 的守护函数包裹。这是整个附件系统最关键的设计决策之一：

```typescript
// src/utils/attachments.ts

async function maybe<T>(
  name: string,
  fn: () => Promise<T | null>,
  toolUseContext: ToolUseContext,
): Promise<T | null> {
  try {
    const start = Date.now()
    const result = await fn()

    // 5% 采样记录耗时
    if (Math.random() < 0.05) {
      logEvent('tengu_attachment_compute_duration', {
        name,
        duration: Date.now() - start,
      })
    }

    return result
  } catch (error) {
    // 任何单个附件的失败不影响其他附件
    logError('attachment_error', { name, error })
    return null
  }
}
```

**设计哲学**：附件系统遵循"尽力而为"（best-effort）原则。一个文件读取失败不应该阻止整条消息的发送——用户的问题依然可以被回答，只是缺少了部分上下文。这种容错模式在高可用系统中非常常见，但在 AI Agent 中同样重要：**可用性优先于完整性**。

### 17.3.4 @文件提取：processAtMentionedFiles()

当用户输入 `@myfile.ts` 时，系统需要从自然语言文本中精确提取文件路径：

```typescript
// 支持的语法：
// @file.ts          — 普通文件
// @file.ts#L10-20   — 指定行范围
// @"path with spaces.txt" — 带引号的路径
// @./relative/path  — 相对路径

function extractAtMentionedFiles(input: string): string[] {
  // 正则提取所有 @ 开头的路径
  // 支持引号包裹、行号范围等语法
}
```

对每个提取到的路径，系统执行以下流程：

```
原始路径 "@myfile.ts#L10-20"
  │
  ├── expandPath() → 解析为绝对路径
  │
  ├── stat() → 检查文件是否存在
  │     │
  │     ├── 目录？→ readdir() → DirectoryAttachment (最多 1000 条)
  │     │
  │     └── 文件？→ generateFileAttachment()
  │           │
  │           ├── 检查 deny 规则（权限系统）
  │           ├── 检查文件大小限制
  │           ├── 检查是否已在 readFileState 缓存中
  │           │
  │           ├── 调用 FileReadTool.call() 读取内容
  │           │     │
  │           │     ├── 文本文件 → TextFileContent（含截断检测）
  │           │     ├── 图片 → readImageWithTokenBudget()（调整尺寸）
  │           │     ├── PDF → 判断内联 vs 引用
  │           │     └── Notebook → 单元格计数
  │           │
  │           └── 返回相应的 Attachment 类型
  │
  └── 写入分析事件
```

### 17.3.5 图片处理：精密的尺寸管理

图片处理是附件系统中技术细节最密集的部分。Claude API 对图片有严格的尺寸和大小限制，附件系统需要在清晰度和 Token 消耗之间精确平衡：

```typescript
// src/constants/apiLimits.ts

IMAGE_MAX_WIDTH  = 2000   // px
IMAGE_MAX_HEIGHT = 2000   // px
IMAGE_TARGET_RAW_SIZE = 3.75 * 1024 * 1024  // 3.75MB（base64 后约 5MB）
```

图片的处理分为两条路径：

**快速路径（macOS 原生）**：
```typescript
// src/utils/imagePaste.ts
// 使用 image-processor-napi 原生模块
// 直接调用 CoreGraphics 降采样
// 冷启动 ~5ms，热缓存 <1ms
const result = await nativeImageProcessor.getImageFromClipboard()
```

**回退路径（跨平台）**：
```typescript
// 使用 osascript (macOS) / xclip (Linux) / wl-paste (Wayland)
// 保存到临时文件 → 读取 Buffer
// BMP → PNG 转换（via sharp）
// 降采样到目标尺寸
const resized = await maybeResizeAndDownsampleImageBuffer(buffer)
```

### 17.3.6 PDF 智能分流

PDF 的处理体现了系统对"成本感知"的极致追求：

```typescript
// src/utils/pdf.ts

async function tryGetPDFReference(filePath: string): Promise<PDFReferenceAttachment | null> {
  // 1. 验证 PDF 头部（%PDF-）
  const header = fileBuffer.subarray(0, 5).toString('ascii')
  if (!header.startsWith('%PDF-')) {
    return { success: false, error: { reason: 'corrupted' } }
  }

  // 2. 获取页数（调用 pdfinfo 二进制）
  const pageCount = await getPDFPageCount(filePath)

  // 3. 关键决策点：30 页阈值
  if (pageCount > PDF_AT_MENTION_INLINE_THRESHOLD) {  // 30
    // 大 PDF → 只传元数据引用
    return {
      type: 'pdf_reference',
      filename: filePath,
      pageCount,
      fileSize: stats.size,
      displayPath: relative(cwd, filePath)
    }
  }

  // 小 PDF → 完整内联
  return null  // 交由后续逻辑内联处理
}
```

### 17.3.7 变更检测：getChangedFiles()

这是附件系统中最"聪明"的功能之一。它会检查模型已读过的文件是否被外部修改了：

```typescript
async function getChangedFiles(toolUseContext: ToolUseContext): Promise<Attachment[]> {
  const attachments: Attachment[] = []

  for (const [filePath, readState] of toolUseContext.readFileState) {
    // 1. 检查文件修改时间
    const currentMtime = (await stat(filePath)).mtimeMs
    if (currentMtime <= readState.lastReadMtime) continue

    // 2. 文件已变更！提取 diff
    const diff = await getSnippetForTwoFileDiff(
      readState.lastContent,
      await readFile(filePath)
    )

    attachments.push({
      type: 'edited_text_file',
      filename: filePath,
      diff,
      displayPath: relative(cwd, filePath)
    })
  }

  return attachments
}
```

这个机制解决了一个 Agent 常见的问题：**模型可能基于过时的文件内容做决策**。通过在每一轮附加变更 diff，模型始终知道"自从你上次看了之后，这些文件变了"。

### 17.3.8 模式提醒的节流策略

Plan Mode 和 Auto Mode 的提醒不是每轮都发送的，而是有精心设计的节流逻辑：

```typescript
// src/utils/attachments.ts

const PLAN_MODE_ATTACHMENT_CONFIG = {
  TURNS_BETWEEN_ATTACHMENTS: 5,           // 每 5 轮发一次
  FULL_REMINDER_EVERY_N_ATTACHMENTS: 5,   // 每 5 次提醒中有 1 次是完整版
}
```

这意味着：
- 第 1-4 轮：不发送提醒
- 第 5 轮：发送**完整**提醒
- 第 10 轮：发送**精简**提醒
- 第 15 轮：发送精简提醒
- ...
- 第 30 轮：再次发送完整提醒

**为什么不每轮都提醒？** Token 预算。一个完整的 Plan Mode 提醒可能占数百 Token，在长对话中这些成本会快速累积。节流策略在"保持模型意识"和"节省 Token"之间找到了平衡。

### 17.3.9 Bridge 模式下的文件上传

当 Claude Code 在浏览器（claude.ai/code）中运行时，附件需要通过 Bridge 上传到云端：

```typescript
// src/tools/BriefTool/upload.ts

async function uploadBriefAttachment(attachment: ResolvedAttachment): Promise<string | undefined> {
  // 1. 体积检查
  if (attachment.size > MAX_UPLOAD_BYTES) return undefined  // 30MB 上限

  // 2. 获取 OAuth Token
  const token = getBridgeAccessToken()
  if (!token) return undefined

  // 3. 构建 multipart 表单
  const formData = new FormData()
  formData.append('file', fileBuffer, { filename, contentType })

  // 4. 上传到 Anthropic 文件存储
  const response = await axios.post(
    `${baseUrl}/api/oauth/file_upload`,
    formData,
    { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 }
  )

  return response.data.file_uuid  // 返回文件 UUID 供 Web 端预览
}
```

这里有一个巧妙的**懒加载优化**：`upload.ts` 依赖 `axios`、`crypto` 等重量级模块，但只在 Bridge 模式下才会被 `import()`。非 Bridge 模式的构建中，这些代码通过 Dead Code Elimination 被完全剔除。

## 17.4 附件渲染

每个附件在 UI 中有对应的渲染逻辑：

```tsx
// src/components/messages/AttachmentMessage.tsx

switch (attachment.type) {
  case 'file':
  case 'already_read_file':
    return <Line>Read <Text bold>{displayPath}</Text> ({lineCount} lines)</Line>

  case 'directory':
    return <Line>Listed directory <Text bold>{displayPath}</Text></Line>

  case 'pdf_reference':
    return <Line>Referenced PDF <Text bold>{displayPath}</Text> ({pageCount} pages)</Line>

  case 'edited_text_file':
    return <Line>File changed: <Text bold>{displayPath}</Text></Line>

  // ... 50+ 其他 case
}
```

## 17.5 设计哲学与工程取舍

附件系统的设计体现了几个核心原则：

| 原则 | 实现 |
|------|------|
| **容错优先** | `maybe()` 守护，单点失败不传播 |
| **预算感知** | PDF 分流、图片降采样、模式提醒节流 |
| **变更敏感** | `readFileState` 追踪 mtime，主动推送 diff |
| **缓存友好** | 记忆附件头预计算，避免每轮改变导致缓存失效 |
| **平台适配** | 图片处理 macOS 原生 → 跨平台回退 |
| **延迟加载** | Bridge 模块按需 `import()`，DCE 剔除 |

整个附件系统就像一个**上下文雷达**——它不断扫描环境变化，将分散在文件系统、IDE、MCP 服务器、Hook 系统中的信息聚合成结构化的上下文，喂给模型做决策。这是 Claude Code 能够在复杂工程场景中保持情境感知的关键基础设施。

## 17.6 小结

- **附件不只是文件**：40+ 种类型的联合，涵盖文件、IDE 状态、记忆、模式、任务等所有上下文维度
- **三层收集策略**：输入解析 → 线程安全环境扫描 → 主线程专属状态
- **容错守护模式**：`maybe()` 包裹每个采集函数，保证单点故障不传播
- **智能资源管理**：PDF 30 页阈值分流、图片尺寸降采样、模式提醒节流
- **变更追踪机制**：通过 `readFileState` 的 mtime 比对自动推送文件 diff
- **平台自适应**：macOS 原生图片处理 → 跨平台 CLI 回退链
