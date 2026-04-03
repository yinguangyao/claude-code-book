# 第 23 章 费用追踪与遥测系统

> 每一次 API 调用都有成本，每一次工具执行都有性能指标。Claude Code 的费用追踪和遥测系统像是驾驶舱的仪表盘——帮助用户控制支出，帮助团队理解使用模式，帮助工程师诊断性能瓶颈。

## 23.1 概念引入：可观测性三支柱

Claude Code 的遥测体系覆盖了可观测性的三个经典维度：

| 维度 | 实现 | 用途 |
|------|------|------|
| **Metrics（指标）** | 费用追踪、Token 计数器 | 用户侧费用展示、资源预算 |
| **Traces（链路）** | OpenTelemetry Span | 请求全链路耗时分析 |
| **Logs（日志）** | 事件日志、错误日志 | 行为分析、异常诊断 |

## 23.2 费用追踪

### 22.2.1 定价模型

Claude Code 为每个模型维护精确的定价表：

```typescript
// src/utils/modelCost.ts

// 单位：USD per million tokens
const PRICING = {
  'claude-haiku-3.5':   { input: 0.80,  output: 4,   cacheRead: 0.08,  cacheWrite: 1.00 },
  'claude-haiku-4.5':   { input: 1.00,  output: 5,   cacheRead: 0.10,  cacheWrite: 1.25 },
  'claude-sonnet':      { input: 3.00,  output: 15,  cacheRead: 0.30,  cacheWrite: 3.75 },
  'claude-opus-4.5':    { input: 5.00,  output: 25,  cacheRead: 0.50,  cacheWrite: 6.25 },
  'claude-opus-4':      { input: 15.00, output: 75,  cacheRead: 1.50,  cacheWrite: 18.75 },
  'claude-opus-4.6':    { input: 15.00, output: 75,  cacheRead: 1.50,  cacheWrite: 18.75 },
  'claude-opus-4.6-fast': { input: 30.00, output: 150, cacheRead: 3.00, cacheWrite: 37.50 },
}
```

### 23.2.2 费用计算流水线

每次 API 响应返回后，费用计算立即执行：

```typescript
// src/cost-tracker.ts

function addToTotalSessionCost(model: string, usage: BetaUsage): void {
  // 1. 计算本次调用费用
  const cost = calculateUSDCost(model, usage)

  // 2. 更新累计费用
  totalCostUSD += cost

  // 3. 更新按模型统计
  const modelUsage = modelUsageMap.get(model) ?? createEmpty()
  modelUsage.inputTokens += usage.input_tokens
  modelUsage.outputTokens += usage.output_tokens
  modelUsage.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0
  modelUsage.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0
  modelUsage.webSearchRequests += usage.server_tool_use?.web_search_requests ?? 0
  modelUsage.costUSD += cost
  modelUsageMap.set(model, modelUsage)

  // 4. 递归处理 Advisor 工具的嵌套费用
  if (usage.advisor_tool_usage) {
    for (const advisorUsage of usage.advisor_tool_usage) {
      addToTotalSessionCost(advisorUsage.model, advisorUsage.usage)
    }
  }

  // 5. 更新 OpenTelemetry 指标
  costCounter.add(cost, { model, speed: isFastMode ? 'fast' : 'normal' })
  tokenCounter.add(usage.input_tokens, { type: 'input', model })
  tokenCounter.add(usage.output_tokens, { type: 'output', model })
}
```

**费用计算公式**：

```
cost = (input_tokens / 1M) × inputPrice
     + (output_tokens / 1M) × outputPrice
     + (cache_read / 1M) × cacheReadPrice
     + (cache_creation / 1M) × cacheWritePrice
     + web_search_requests × searchPricePerRequest
```

### 23.2.3 费用展示

```typescript
// src/cost-tracker.ts

function formatTotalCost(): string {
  // 动态精度：小额用 4 位小数，大额用 2 位
  const precision = totalCostUSD < 0.50 ? 4 : 2
  const costStr = `$${totalCostUSD.toFixed(precision)}`

  // 按模型汇总
  for (const [model, usage] of modelUsageMap) {
    // 格式：模型名 | 输入 Token | 输出 Token | 缓存读 | 缓存写 | 费用
  }

  // 性能指标
  // API 总耗时 vs 墙钟时间
  // 代码变更量（行数增删）
}
```

### 23.2.4 会话费用持久化

费用数据在会话恢复时需要保持连续性：

```typescript
// src/bootstrap/state.ts

function saveCurrentSessionCosts(sessionId: string): void {
  // 以 sessionId 为 key 存储到项目配置
  projectConfig.set(`costs.${sessionId}`, {
    totalCostUSD,
    modelUsageMap: Object.fromEntries(modelUsageMap),
    apiDuration,
    linesChanged,
  })
}

function restoreCostStateForSession(sessionId: string): void {
  const saved = projectConfig.get(`costs.${sessionId}`)
  if (saved) {
    totalCostUSD = saved.totalCostUSD
    // ... 恢复所有指标
  }
}
```

## 23.3 遥测系统

### 23.3.1 事件管线架构

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────┐
│  logEvent()  │────→│  Event Sink  │────→│  Datadog         │
│  logEvent1P()│     │  路由分发    │     │  批量发送 15s     │
└──────────────┘     └──────┬───────┘     └──────────────────┘
                           │
                           │              ┌──────────────────┐
                           └─────────────→│  1P Event Logger │
                                          │  磁盘队列 + 重试  │
                                          │  → /api/event_   │
                                          │    logging/batch  │
                                          └──────────────────┘
```

**事件队列与延迟绑定**：

```typescript
// src/services/analytics/index.ts

const pendingEvents: QueuedEvent[] = []
let sink: AnalyticsSink | null = null

function logEvent(name: string, metadata: AnalyticsMetadata): void {
  if (!sink) {
    // Sink 尚未初始化（启动阶段），排队
    pendingEvents.push({ name, metadata, timestamp: Date.now() })
    return
  }
  sink.logEvent(name, metadata)
}

function attachAnalyticsSink(s: AnalyticsSink): void {
  sink = s
  // 排空队列
  queueMicrotask(() => {
    for (const event of pendingEvents) {
      sink!.logEvent(event.name, event.metadata)
    }
    pendingEvents.length = 0
  })
}
```

这种"排队 + 延迟绑定"模式允许在启动早期就记录事件（如 `tengu_init`），不需要等待 Sink 完全初始化。

### 23.3.2 Datadog 集成

Datadog 只接收白名单事件：

```typescript
// src/services/analytics/datadog.ts

const ALLOWED_EVENTS = [
  'tengu_api_success', 'tengu_api_error',
  'tengu_init', 'tengu_started', 'tengu_exit',
  'tengu_tool_use_*',
  'tengu_model_fallback_triggered',
  'tengu_oauth_*',
  // ... 更多白名单事件
]

function trackDatadogEvent(name: string, metadata: Record<string, unknown>): void {
  if (!isAllowedEvent(name)) return  // 白名单过滤

  // Tag 规范化（降低基数）
  const tags = {
    model: normalizeModel(metadata.model),      // 规范化模型名
    user_bucket: hashToBucket(userId, 30),       // 30 桶隐私分组
    version: normalizeVersion(metadata.version), // 版本规范化
  }

  batch.push({ name, tags, timestamp: Date.now() })

  // 15 秒批量发送
  if (!flushTimer) {
    flushTimer = setTimeout(flushBatch, 15000)
  }
}
```

### 23.3.3 第一方事件日志

1P 事件是 Anthropic 自己的分析管线，具有磁盘持久化和重试能力：

```typescript
// src/services/analytics/firstPartyEventLoggingExporter.ts

class FirstPartyEventLoggingExporter {
  private queue: EventRecord[] = []

  async export(events: EventRecord[]): Promise<void> {
    // 1. 写入磁盘队列（JSONL 格式）
    await appendFile(this.queuePath, events.map(JSON.stringify).join('\n'))

    // 2. 尝试批量上传
    try {
      await this.flush()
    } catch (error) {
      // 失败不丢弃——下次重试
      this.scheduleRetry()
    }
  }

  private async flush(): Promise<void> {
    const events = await this.readQueue()

    // 分块发送（每批 200 条）
    for (const chunk of chunks(events, 200)) {
      await fetch('/api/event_logging/batch', {
        method: 'POST',
        body: JSON.stringify({ events: chunk }),
        headers: { Authorization: `Bearer ${token}` },
      })
    }

    // 成功后清空队列文件
    await truncate(this.queuePath)
  }

  private scheduleRetry(): void {
    // 二次退避重试：500ms → 2s → 8s → 30s（最多 8 次）
    const delay = Math.min(500 * Math.pow(4, this.retryCount), 30000)
    setTimeout(() => this.flush(), delay)
    this.retryCount++
  }
}
```

### 23.3.4 链路追踪（OpenTelemetry）

```typescript
// src/utils/telemetry/sessionTracing.ts

// Span 类型层次：
// interaction (用户请求 → Claude 响应)
//   ├── llm_request (单次 API 调用)
//   ├── tool (工具调用生命周期)
//   │   ├── tool.blocked_on_user (等待用户批准)
//   │   └── tool.execution (实际执行)
//   └── hook (Hook 执行)

function startInteractionSpan(userPrompt: string): Span {
  return tracer.startSpan('interaction', {
    attributes: {
      'user.prompt': userPrompt,
      'model': currentModel,
    },
  })
}

function startToolSpan(toolName: string, parentSpan: Span): Span {
  return tracer.startSpan(`tool.${toolName}`, {
    parent: parentSpan,
    attributes: {
      'tool.name': toolName,
    },
  })
}
```

**AsyncLocalStorage 上下文传播**：

```typescript
// 使用 Node.js AsyncLocalStorage 在异步边界间传播 Span 上下文
const asyncLocalStorage = new AsyncLocalStorage<SpanContext>()

function withSpan<T>(span: Span, fn: () => T): T {
  return asyncLocalStorage.run({ span }, fn)
}

function getCurrentSpan(): Span | undefined {
  return asyncLocalStorage.getStore()?.span
}
```

**孤儿 Span 清理**：

```typescript
// 30 分钟 TTL，后台定时清理
setInterval(() => {
  for (const [id, span] of activeSpans) {
    if (Date.now() - span.startTime > 30 * 60 * 1000) {
      span.end()  // 强制结束
      activeSpans.delete(id)
    }
  }
}, 60000)
```

### 23.3.5 Feature Flag 系统（GrowthBook）

GrowthBook 提供了动态配置和 A/B 测试能力：

```typescript
// src/services/analytics/growthbook.ts

// Feature Value 解析优先级：
// 1. CLAUDE_INTERNAL_FC_OVERRIDES 环境变量（Anthropic 员工本地测试）
// 2. /config Gates Tab 配置（Anthropic 员工个人覆盖）
// 3. 远程评估缓存（GrowthBook 服务器返回）
// 4. 磁盘缓存（上次成功获取的值）
// 5. 默认值（代码内 hardcoded）

async function getFeatureValue<T>(key: string, defaultValue: T): Promise<T> {
  const client = await getGrowthBookClient()
  const value = client.getFeatureValue(key, defaultValue)

  // 首次访问时记录曝光事件（去重）
  logExposureEvent(key, value)

  return value
}
```

**磁盘缓存防断网**：

```typescript
// GrowthBook 客户端初始化失败时（如网络不可用），
// 从磁盘读取上次成功获取的 feature flags
const cachedFeatures = await readGlobalConfig('cachedGrowthBookFeatures')
if (cachedFeatures) {
  client.setFeatures(cachedFeatures)
}
```

### 23.3.6 采样与隐私保护

```typescript
// src/services/analytics/metadata.ts

// 采样控制
function shouldSampleEvent(eventName: string): boolean {
  const config = getFeatureValue('tengu_event_sampling_config', {})
  const rate = config[eventName] ?? 1  // 默认全量
  if (Math.random() > rate) return false
  // 被采样的事件记录采样率（用于后续放大）
  return true
}

// PII 保护
function sanitizeToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.length > 512) {
      sanitized[key] = value.slice(0, 128) + '...'  // 截断长字符串
    } else if (typeof value === 'object') {
      sanitized[key] = truncateNested(value, 2)      // 最多 2 层嵌套
    } else {
      sanitized[key] = value
    }
  }
  // 总输出上限 4KB
  return JSON.parse(JSON.stringify(sanitized).slice(0, 4096))
}

// MCP 工具名清洗
function sanitizeMcpToolName(name: string, server: MCPServer): string {
  // 自定义 MCP 服务器的工具名可能包含敏感信息
  if (!isOfficialServer(server)) {
    return 'mcp_tool'  // 统一替换
  }
  return name
}
```

**隐私级别**：

```typescript
type PrivacyLevel = 'no-telemetry' | 'essential-traffic' | 'telemetry'

// no-telemetry：所有遥测关闭
// essential-traffic：只保留必要的网络请求
// telemetry：完全开启（默认）
```

### 23.3.7 事件元数据丰富

每个事件都会附加丰富的上下文信息：

```typescript
// src/services/analytics/metadata.ts

function getEventMetadata(): EventMetadata {
  return {
    // 模型与会话
    model: currentModel,
    sessionId: currentSessionId,
    userType: isAntEmployee ? 'ant' : 'external',

    // 环境
    platform: process.platform,       // darwin / linux / win32
    nodeVersion: process.version,
    isCI: detectCI(),
    isWSL: detectWSL(),

    // 进程指标
    memoryUsage: process.memoryUsage(),
    cpuUsage: process.cpuUsage(),
    uptime: process.uptime(),

    // 仓库指纹（隐私保护）
    repoHash: sha256(gitRemoteUrl).slice(0, 16),

    // 订阅信息
    subscriptionType: 'pro',
    rateLimitTier: 'tier_1',
  }
}
```

注意 `repoHash`——只传送仓库 URL 的 SHA-256 前 16 字符，无法反推实际仓库地址，但足以做跨会话的关联分析。

## 23.4 设计哲学

| 设计 | 说明 |
|------|------|
| **排队 + 延迟绑定** | 启动阶段就能记录事件，不等 Sink 就绪 |
| **磁盘持久化队列** | 1P 事件写入磁盘，进程重启后可继续发送 |
| **二次退避重试** | 失败不丢弃，指数退避直到成功 |
| **白名单过滤** | Datadog 只接收显式允许的事件类型 |
| **采样 + 放大** | 高频事件按比例采样，分析时乘以采样率还原 |
| **仓库哈希** | 隐私保护的仓库标识，足以做关联但无法反推 |
| **Killswitch** | GrowthBook 远程控制，可实时关闭任何 Sink |

## 23.5 小结

- **费用追踪**：实时计算每次 API 调用费用，支持 Prompt Cache 和 Web Search 计费
- **动态精度展示**：小额 4 位小数，大额 2 位小数
- **三管线遥测**：Datadog（白名单事件）、1P Logger（磁盘队列 + 重试）、OpenTelemetry（链路追踪）
- **OpenTelemetry Span 层次**：interaction → llm_request / tool / hook
- **GrowthBook Feature Flags**：5 级优先级解析，磁盘缓存防断网
- **隐私保护**：MCP 工具名清洗、输入截断、仓库哈希、隐私级别控制
- **采样机制**：动态采样率 + 采样率元数据，支持后续放大还原
