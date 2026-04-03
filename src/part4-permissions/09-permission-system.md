# 第 9 章 多层权限系统

## 9.1 为什么 Agent 需要权限系统

传统的命令行工具在执行前，用户已经清楚地知道将要发生什么——毕竟命令是自己手动输入的。但 AI Agent 彻底改变了这个前提：LLM 会自主决定调用哪些工具、传入什么参数，而这些工具可以执行真实的、不可逆的操作——删除文件、运行任意 Shell 命令、修改系统配置。

这就产生了一个核心张力：**自主性与安全性之间的平衡**。如果每个工具调用都需要用户审批，Agent 的效率将大打折扣；但如果完全放开权限，一个幻觉（hallucination）就可能导致灾难性后果。

Claude Code 的解决方案是一套精心设计的多层权限架构。这套系统不是简单的"允许/拒绝"二分法，而是通过配置规则、AI 分类器、交互式审批和兜底拒绝四个层次的协同工作，让 Agent 在安全的边界内尽可能自由地行动。

## 9.2 四层权限架构

![四层权限系统](/images/ch09-permission-system.png)

Claude Code 的权限系统由四个层次从上到下依次生效，每一层都可以做出"放行"或"拦截"的决定，只有当前层无法决定时才会向下传递：

```
┌─────────────────────────────────────────────┐
│         第一层：配置规则（Rules）              │
│   deny 规则 → ask 规则 → 工具自身检查         │
│   → allow 规则 → bypassPermissions 模式       │
│                                               │
│   任何一条规则命中即可做出 allow/deny/ask 决定  │
├─────────────────────────────────────────────┤
│         第二层：自动分类器（Classifier）        │
│   auto 模式下，AI 分类器评估操作安全性          │
│   安全白名单工具 → acceptEdits 快速通道         │
│   → YOLO 分类器判定                            │
├─────────────────────────────────────────────┤
│         第三层：交互审批（Interactive）          │
│   向用户展示权限弹窗，等待允许或拒绝             │
│   用户可选择"始终允许"以创建新的配置规则         │
├─────────────────────────────────────────────┤
│         第四层：兜底拒绝（Fallback Deny）       │
│   无头模式 / dontAsk 模式下自动拒绝             │
│   拒绝追踪达到阈值时回退到交互审批               │
└─────────────────────────────────────────────┘
```

这个分层设计的精妙之处在于：频繁的、安全的操作在第一层就被快速放行，避免了不必要的延迟；而真正危险的操作则会层层过滤，最终由用户亲自把关。

## 9.3 源码走读

### 9.3.1 权限决策的核心类型

在深入决策流程之前，先了解权限系统的基础类型定义。在 `[src/types/permissions.ts]` 中，定义了三种权限行为：

```typescript
export type PermissionBehavior = 'allow' | 'deny' | 'ask'
```

这三种行为构成了整个权限系统的基本语义——允许执行、拒绝执行、需要询问。每一条权限规则由三个部分组成：

```typescript
export type PermissionRule = {
  source: PermissionRuleSource    // 规则来源
  ruleBehavior: PermissionBehavior // 行为：allow / deny / ask
  ruleValue: PermissionRuleValue   // 匹配条件
}

export type PermissionRuleValue = {
  toolName: string       // 工具名称，如 "Bash"
  ruleContent?: string   // 可选的内容匹配，如 "npm install"
}
```

规则的字符串表示遵循 `ToolName(content)` 的格式，例如 `Bash(npm install)` 表示匹配 Bash 工具中以 `npm install` 为前缀的命令。`[src/utils/permissions/permissionRuleParser.ts]` 中的 `permissionRuleValueFromString` 函数负责解析这种格式，还处理了括号转义等边界情况。

权限决策的结果则更加丰富。除了三种基本行为外，还有一个 `passthrough`（透传）状态，表示当前层无法做出决定，需要传递给下一层：

```typescript
export type PermissionResult<Input> =
  | PermissionDecision<Input>
  | {
      behavior: 'passthrough'
      message: string
      // ...
    }
```

`PermissionDecisionReason` 类型记录了做出决策的原因，包括 `rule`（配置规则匹配）、`mode`（权限模式决定）、`classifier`（AI 分类器判定）、`hook`（钩子干预）等多种可能。

### 9.3.2 权限规则的来源与优先级

权限规则可以来自多个来源，在 `[src/utils/settings/constants.ts]` 中定义了基础的设置来源：

```typescript
export const SETTING_SOURCES = [
  'userSettings',      // 用户全局设置（~/.claude/settings.json）
  'projectSettings',   // 项目共享设置（.claude/settings.json）
  'localSettings',     // 项目本地设置（.claude/settings.local.json，gitignored）
  'flagSettings',      // CLI --settings 参数指定
  'policySettings',    // 企业管理策略（managed-settings.json）
] as const
```

在权限系统中，还额外支持 `cliArg`、`command` 和 `session` 三种运行时来源。`[src/utils/permissions/permissionsLoader.ts]` 中的 `loadAllPermissionRulesFromDisk` 函数负责从磁盘加载所有规则：

```typescript
export function loadAllPermissionRulesFromDisk(): PermissionRule[] {
  // 如果启用了 allowManagedPermissionRulesOnly，只使用管理策略的规则
  if (shouldAllowManagedPermissionRulesOnly()) {
    return getPermissionRulesForSource('policySettings')
  }
  // 否则从所有启用的来源加载
  const rules: PermissionRule[] = []
  for (const source of getEnabledSettingSources()) {
    rules.push(...getPermissionRulesForSource(source))
  }
  return rules
}
```

这里有一个重要的安全设计：当企业管理员通过 `policySettings` 启用了 `allowManagedPermissionRulesOnly` 时，所有其他来源的权限规则都会被忽略。这确保了在受管环境中，只有管理员制定的策略才能生效。

每个来源的规则以 JSON 格式存储在对应的 settings 文件中：

```json
{
  "permissions": {
    "allow": ["FileRead", "Bash(npm test)"],
    "deny": ["Bash(rm -rf)"],
    "ask": ["Bash(git push)"]
  }
}
```

`settingsJsonToRules` 函数将这种 JSON 结构转换为 `PermissionRule[]` 数组。在运行时，所有来源的规则被整合到 `ToolPermissionContext` 对象中，按 `alwaysAllowRules`、`alwaysDenyRules`、`alwaysAskRules` 三个维度、按来源分组存储。

### 9.3.3 canUseTool 完整决策流程

权限决策的核心逻辑位于 `[src/utils/permissions/permissions.ts]` 中的 `hasPermissionsToUseToolInner` 函数。整个流程严格按步骤编号，清晰地展现了四层架构的运作方式。

**第一步：配置规则检查**

```typescript
// 1a. 整个工具被 deny 规则拒绝
const denyRule = getDenyRuleForTool(appState.toolPermissionContext, tool)
if (denyRule) {
  return { behavior: 'deny', decisionReason: { type: 'rule', rule: denyRule }, ... }
}

// 1b. 整个工具被 ask 规则标记为需要询问
const askRule = getAskRuleForTool(appState.toolPermissionContext, tool)
if (askRule) {
  // 沙箱例外：如果启用了 autoAllowBashIfSandboxed，沙箱内命令可跳过 ask
  if (!canSandboxAutoAllow) {
    return { behavior: 'ask', decisionReason: { type: 'rule', rule: askRule }, ... }
  }
}
```

deny 规则拥有最高优先级——如果一个工具被明确拒绝，任何其他规则都无法覆盖。ask 规则次之，但有一个精妙的例外：如果 Bash 工具启用了沙箱化，且命令可以在沙箱中安全运行，则 ask 规则会被跳过。

**第二步：工具自身权限检查**

```typescript
// 1c. 调用工具实现的 checkPermissions 方法
let toolPermissionResult = await tool.checkPermissions(parsedInput, context)

// 1d. 工具实现拒绝了权限
if (toolPermissionResult?.behavior === 'deny') return toolPermissionResult

// 1f. 内容级 ask 规则优先于 bypassPermissions 模式
if (toolPermissionResult?.behavior === 'ask'
    && toolPermissionResult.decisionReason?.type === 'rule'
    && toolPermissionResult.decisionReason.rule.ruleBehavior === 'ask') {
  return toolPermissionResult
}

// 1g. 安全检查（如 .git/、.claude/ 等敏感路径）不可绕过
if (toolPermissionResult?.behavior === 'ask'
    && toolPermissionResult.decisionReason?.type === 'safetyCheck') {
  return toolPermissionResult
}
```

这里体现了一个重要的设计哲学：**每个工具对自己的安全边界最了解**。Bash 工具知道哪些命令是危险的，文件编辑工具知道哪些路径是敏感的。工具级的安全检查（`safetyCheck`）甚至不可以被 `bypassPermissions` 模式绕过——对 `.git/`、`.claude/` 等目录的写操作必须经过人工确认。

**第三步：模式与全局 allow 规则**

```typescript
// 2a. bypassPermissions 模式直接放行
if (shouldBypassPermissions) {
  return { behavior: 'allow', decisionReason: { type: 'mode', mode: ... } }
}

// 2b. 整个工具被 allow 规则允许
const alwaysAllowedRule = toolAlwaysAllowedRule(context, tool)
if (alwaysAllowedRule) {
  return { behavior: 'allow', decisionReason: { type: 'rule', rule: ... } }
}
```

注意步骤编号的微妙之处：deny/ask 规则在步骤 1 就被检查，而 allow 规则和 bypassPermissions 在步骤 2 才检查。这意味着 **deny 和 ask 规则始终优先于 allow 规则**，确保了安全策略的不可绕过性。

**第四步：转换 passthrough 为 ask**

```typescript
// 3. 将 "passthrough" 转换为 "ask"
const result: PermissionDecision =
  toolPermissionResult.behavior === 'passthrough'
    ? { ...toolPermissionResult, behavior: 'ask' }
    : toolPermissionResult
```

如果经过所有规则检查后，没有任何规则命中，工具自身也返回了 `passthrough`，那么最终结果将是 `ask`——需要进一步处理（进入分类器或交互审批）。

### 9.3.4 外层包装：自动分类器与模式转换

`hasPermissionsToUseToolInner` 返回的结果会被外层的 `hasPermissionsToUseTool` 函数进一步处理。这个函数在 `[src/utils/permissions/permissions.ts]` 中实现了第二层到第四层的逻辑：

```typescript
export const hasPermissionsToUseTool: CanUseToolFn = async (...) => {
  const result = await hasPermissionsToUseToolInner(tool, input, context)

  // allow 直接放行，并重置连续拒绝计数
  if (result.behavior === 'allow') { ... return result }

  if (result.behavior === 'ask') {
    // dontAsk 模式：将 ask 转换为 deny
    if (mode === 'dontAsk') {
      return { behavior: 'deny', ... }
    }
    // auto 模式：使用 AI 分类器
    if (mode === 'auto') {
      // 快速通道 1：acceptEdits 模式下允许的操作直接放行
      // 快速通道 2：安全白名单工具直接放行
      // 完整路径：调用 YOLO 分类器
    }
    // 无头模式：尝试 Hook，失败则自动拒绝
    if (shouldAvoidPermissionPrompts) { ... }
  }
  return result
}
```

在 `auto` 模式下，权限系统引入了 AI 分类器来替代人工审批。分类器的决策遵循三级快速通道：

1. **acceptEdits 快速通道**：模拟 `acceptEdits` 模式检查工具权限，如果在该模式下会被允许（如工作目录内的文件编辑），直接放行。
2. **安全白名单**：`[src/utils/permissions/classifierDecision.ts]` 中定义了 `SAFE_YOLO_ALLOWLISTED_TOOLS`，包含 FileRead、Grep、Glob 等只读工具，这些工具不需要分类器检查。
3. **YOLO 分类器**：对于需要深度评估的操作，调用 `classifyYoloAction` 进行 AI 判断。

### 9.3.5 拒绝追踪

`[src/utils/permissions/denialTracking.ts]` 实现了一个优雅的拒绝追踪机制，防止分类器陷入反复拒绝的死循环：

```typescript
export const DENIAL_LIMITS = {
  maxConsecutive: 3,   // 连续拒绝上限
  maxTotal: 20,        // 总拒绝次数上限
} as const

export function shouldFallbackToPrompting(state: DenialTrackingState): boolean {
  return (
    state.consecutiveDenials >= DENIAL_LIMITS.maxConsecutive ||
    state.totalDenials >= DENIAL_LIMITS.maxTotal
  )
}
```

当连续拒绝达到 3 次或总拒绝达到 20 次时，系统会从自动分类模式回退到交互审批，让用户来做最终决定。每次成功放行都会重置连续拒绝计数，但不会重置总计数：

```typescript
export function recordSuccess(state: DenialTrackingState): DenialTrackingState {
  if (state.consecutiveDenials === 0) return state // 无变化时返回同一引用
  return { ...state, consecutiveDenials: 0 }
}
```

这种设计确保了即使分类器偶尔出错，用户也不会被完全排除在决策之外。

### 9.3.6 交互审批入口

当最终结果为 `ask` 且处于交互模式时，`[src/hooks/useCanUseTool.tsx]` 中的 `useCanUseTool` Hook 接管流程。它创建一个 `PermissionContext`，将权限请求加入 UI 队列，等待用户在终端中做出选择：

```typescript
const decisionPromise = hasPermissionsToUseTool(tool, input, ...)
return decisionPromise.then(async result => {
  if (result.behavior === 'allow') {
    // 配置/规则直接允许
    resolve(ctx.buildAllow(...))
    return
  }
  switch (result.behavior) {
    case 'deny':
      // 记录拒绝，通知用户
      resolve(result)
      return
    case 'ask':
      // 进入交互审批流程
      handleInteractivePermission({ ctx, description, result, ... }, resolve)
      return
  }
})
```

在交互审批中，用户可以选择"允许本次"、"始终允许"（写入配置规则）或"拒绝"。选择"始终允许"会调用 `addPermissionRulesToSettings`，将新规则持久化到对应的 settings 文件中，让同类操作在未来自动通过第一层的规则检查。

## 9.4 小结

Claude Code 的权限系统是 Agent 安全的基石。它通过四层架构在自主性和安全性之间实现了精细的平衡：

- **配置规则**提供了确定性的、可审计的权限控制，deny 规则不可被任何模式绕过。
- **自动分类器**在 auto 模式下充当"AI 安全员"，通过快速通道和深度分析相结合的方式，在不打扰用户的前提下过滤危险操作。
- **交互审批**是最后的人工防线，确保用户始终拥有最终决定权。
- **兜底拒绝**和拒绝追踪机制保证了即使在无人值守的场景下，系统也不会做出不安全的决策。

权限规则的多来源设计（从用户级到企业策略级）则满足了不同场景的管理需求——个人开发者可以自由配置，而企业环境下管理员可以通过 `policySettings` 实施强制策略。

这套系统的关键洞察是：**安全不是一个布尔值，而是一个频谱**。不同的操作有不同的风险等级，不同的用户有不同的信任偏好，好的权限系统应该让每个人都能在自己的舒适区内高效工作。

在下一章中，我们将深入探讨权限系统中最具创新性的组件——auto 模式下的 YOLO 分类器，看看如何用 AI 来判断 AI 的行为是否安全。
