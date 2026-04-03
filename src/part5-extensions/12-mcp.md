# 第 12 章：MCP 集成——开放的工具生态

> "工具不是 Claude Code 自己拥有的，而是整个生态系统贡献的。"

在前面的章节中，我们看到了 Claude Code 如何通过内置工具（Bash、文件读写、搜索）来完成编码任务。但现实世界的需求远不止于此：开发者需要调用数据库、查询第三方 API、操作 IDE 插件、执行浏览器自动化……这些能力不可能全部内置在 Claude Code 里。

MCP（Model Context Protocol）正是为解决这个问题而生的标准协议。它让任何人都可以编写一个"工具服务器"，Claude Code 只需通过统一的接口连接并调用，就能获得几乎无限的能力扩展。本章将深入 Claude Code 的 MCP 集成实现，看清楚这套开放生态在源码层面是如何构建的。

## 12.1 MCP 是什么

MCP 全称 Model Context Protocol，是 Anthropic 于 2024 年底发布的一套开放协议。其核心思路很简单：

- **MCP Server**：一个独立运行的服务进程，暴露若干"工具"（tools）、"资源"（resources）和"提示模板"（prompts）
- **MCP Client**：即 Claude Code，通过标准化的 JSON-RPC 协议与 Server 通信
- **协议层**：定义了 `tools/list`、`tools/call`、`resources/list`、`resources/read`、`prompts/list` 等标准方法

相比于直接 fork 子进程或 HTTP 调用，MCP 的优势在于：

1. **传输无关性**：同一套协议可以跑在 stdio（本地进程）、SSE、HTTP 或 WebSocket 之上
2. **能力协商**：连接建立时双方协商各自支持的能力集合（capabilities），避免调用不支持的方法
3. **生态开放性**：任何语言、任何框架都可以实现 MCP Server，社区已经有数百个现成实现

从 Claude Code 的视角来看，一个外部 MCP 工具和内置的 `BashTool` 在调用接口上是完全一致的——都是 `Tool` 接口，只是底层实现从本地函数变成了跨进程 RPC。

## 12.2 架构全景

![MCP 集成架构](/images/ch12-mcp-integration.png)

在展开源码之前，先建立一个整体的架构视图：

```
┌─────────────────────────────────────────────────────────┐
│                    Claude Code 进程                      │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │           getMcpToolsCommandsAndResources()        │  │
│  │              (启动时批量初始化所有 Server)           │  │
│  └──────────┬────────────────────────────────────────┘  │
│             │  pMap 并发控制                              │
│             ▼                                           │
│  ┌──────────────────────┐   ┌────────────────────────┐  │
│  │   connectToServer()  │   │  fetchToolsForClient() │  │
│  │   (memoize 缓存)     │──▶│  fetchResourcesForClient│  │
│  └──────────┬───────────┘   │  fetchCommandsForClient│  │
│             │                └────────────────────────┘  │
│             ▼  根据 config.type 选择传输层               │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Transport 层                         │   │
│  │  ┌──────────┐ ┌─────────┐ ┌────────┐ ┌────────┐  │   │
│  │  │  stdio   │ │   SSE   │ │  HTTP  │ │   WS   │  │   │
│  │  │(子进程)  │ │(EventSrc│ │(Stream │ │(Socket)│  │   │
│  │  │         │ │ + OAuth)│ │ HTTP)  │ │       │  │   │
│  │  └──────────┘ └─────────┘ └────────┘ └────────┘  │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │           MCPTool (动态生成的工具实例)             │   │
│  │     name: "mcp__github__create_issue"             │   │
│  │     call() → callMCPTool() → tools/call RPC       │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
            │  JSON-RPC over Transport
            ▼
┌─────────────────────┐
│    MCP Server 进程   │
│  (用户自定义/社区)   │
└─────────────────────┘
```

整个系统的入口在 `getMcpToolsCommandsAndResources()`，它在 Claude Code 启动时被调用，并发地连接所有配置的 MCP Server，将拿到的工具列表注入到运行时可用的工具集合中。

## 12.3 类型系统：MCPServerConnection 的状态机

理解 MCP 集成的第一步是看清楚服务器连接的状态模型。在 `src/services/mcp/types.ts` 中定义了 `MCPServerConnection` 联合类型：

```typescript
// [src/services/mcp/types.ts]
export type MCPServerConnection =
  | ConnectedMCPServer
  | FailedMCPServer
  | NeedsAuthMCPServer
  | PendingMCPServer
  | DisabledMCPServer
```

这是一个典型的"标签联合类型"（discriminated union），每种状态都携带不同的数据字段：

| 状态 | 含义 | 关键字段 |
|------|------|---------|
| `connected` | 连接成功，可以调用工具 | `client`（SDK Client 实例）、`capabilities`、`cleanup` |
| `failed` | 连接失败（网络错误、进程崩溃等） | `error`（错误信息） |
| `needs-auth` | 需要 OAuth 授权 | 无额外字段，UI 会展示授权按钮 |
| `pending` | 正在连接或重连中 | `reconnectAttempt`、`maxReconnectAttempts` |
| `disabled` | 被用户手动禁用 | 无额外字段 |

传输协议的配置同样通过 Zod schema 严格约束，支持六种类型：

```typescript
// [src/services/mcp/types.ts]
export const TransportSchema = lazySchema(() =>
  z.enum(['stdio', 'sse', 'sse-ide', 'http', 'ws', 'sdk']),
)
```

其中 `stdio` 是最常见的本地工具服务器类型（通过启动子进程通信），`sse` 和 `http` 支持远程 MCP Server，`sse-ide` 和 `ws-ide` 是为 IDE 插件集成预留的内部类型，`sdk` 则是进程内运行的特殊模式。

## 12.4 配置发现：多来源合并

在调用 `connectToServer()` 之前，Claude Code 需要知道"有哪些 MCP Server 需要连接"。配置来源有多个层级，通过 `getAllMcpConfigs()` 函数汇总：

```
配置优先级（低 → 高）
  ├── Enterprise 托管配置  (managed-mcp.json，企业级强制策略)
  ├── 用户全局配置         (~/.claude/settings.json 的 mcpServers 字段)
  ├── 项目配置             (.mcp.json，随代码仓库提交)
  ├── Dynamic 配置         (运行时动态注入，如 IDE 插件)
  └── claude.ai 代理配置   (通过 Claude.ai 账号下发的托管服务器)
```

每个来源的配置都会通过 `addScopeToServers()` 打上 `scope` 标记，最终合并成一个 `Record<string, ScopedMcpServerConfig>` 映射表，`scope` 字段用于权限判断和来源追溯。

`.mcp.json` 文件是最常见的项目级配置方式，格式如下：

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    },
    "postgres": {
      "type": "http",
      "url": "https://my-mcp-server.example.com/mcp",
      "oauth": { "clientId": "my-client-id" }
    }
  }
}
```

值得注意的是 `env` 字段中的 `${GITHUB_TOKEN}` 语法——`src/services/mcp/envExpansion.ts` 实现了环境变量展开，在建立连接前会将这些占位符替换为实际的环境变量值，这样敏感信息（如 API Token）可以通过环境变量传入，而不是硬编码在配置文件里。

## 12.5 连接建立：connectToServer 的传输层分发

`connectToServer()` 是 MCP 集成的核心函数，位于 `src/services/mcp/client.ts`。它被 `lodash/memoize` 包装，以服务器名和配置的 JSON 序列化作为缓存键——这意味着对同一个服务器的重复调用会直接返回已缓存的连接，避免重复建立：

```typescript
// [src/services/mcp/client.ts]
export const connectToServer = memoize(
  async (name, serverRef, serverStats?) => {
    // ...根据 serverRef.type 选择传输层
  },
  getServerCacheKey,
)

export function getServerCacheKey(name, serverRef) {
  return `${name}-${jsonStringify(serverRef)}`
}
```

函数内部是一个大型 `if-else` 链，根据 `serverRef.type` 分发到不同的传输层实现：

### stdio 传输（本地子进程）

最常见的本地 MCP Server 启动方式，Claude Code 会 fork 一个子进程并通过 stdin/stdout 通信：

```typescript
// [src/services/mcp/client.ts]
transport = new StdioClientTransport({
  command: finalCommand,
  args: finalArgs,
  env: {
    ...subprocessEnv(),
    ...serverRef.env,
  } as Record<string, string>,
  stderr: 'pipe', // 防止服务器的错误输出污染 CLI 界面
})
```

`stderr: 'pipe'` 的细节很重要：MCP Server 进程的标准错误输出不会直接打印到终端，而是被 Claude Code 捕获并经过日志系统输出，避免破坏 Ink 渲染的 UI。

### SSE 传输（远程服务器，支持 OAuth）

Server-Sent Events 传输用于连接远程 MCP Server，同时支持 OAuth 认证：

```typescript
// [src/services/mcp/client.ts]
const authProvider = new ClaudeAuthProvider(name, serverRef)

const transportOptions: SSEClientTransportOptions = {
  authProvider,
  fetch: wrapFetchWithTimeout(
    wrapFetchWithStepUpDetection(createFetchWithInit(), authProvider),
  ),
  // ...
}

// 注意：EventSource 连接不加超时，因为它是长连接
transportOptions.eventSourceInit = {
  fetch: async (url, init) => {
    const tokens = await authProvider.tokens()
    if (tokens) {
      // 在 SSE 长连接请求中注入 Bearer Token
    }
  },
}
```

这里有个微妙的设计：`wrapFetchWithTimeout` 只对 POST 请求添加 60 秒超时，GET 请求（即 SSE 的持久连接）不加超时，否则 SSE 流会每 60 秒断一次。

### HTTP 传输（Streamable HTTP，最新规范）

HTTP 传输遵循 MCP 规范的 Streamable HTTP 要求，每次 POST 请求都需要在 `Accept` 头中同时声明 `application/json` 和 `text/event-stream`：

```typescript
// [src/services/mcp/client.ts]
const MCP_STREAMABLE_HTTP_ACCEPT = 'application/json, text/event-stream'

// wrapFetchWithTimeout 会确保这个 Accept 头被正确设置
```

### 连接建立与超时控制

无论哪种传输层，连接建立都用了 `Promise.race()` 来实现超时控制：

```typescript
// [src/services/mcp/client.ts]
const connectPromise = client.connect(transport)
const timeoutPromise = new Promise<never>((_, reject) => {
  setTimeout(() => {
    transport.close().catch(() => {})
    reject(new Error(`MCP server "${name}" connection timed out`))
  }, getConnectionTimeoutMs()) // 默认 30 秒，可通过 MCP_TIMEOUT 环境变量覆盖
})

await Promise.race([connectPromise, timeoutPromise])
```

连接成功后，SDK 的 `client.getServerCapabilities()` 返回服务器声明支持的能力集合，这将决定后续能调用哪些方法（如果 `capabilities.tools` 为空，则不调用 `tools/list`）。

## 12.6 工具生命周期：从 list_tools 到 call_tool

### 工具发现：fetchToolsForClient

连接建立后，Claude Code 通过 `fetchToolsForClient()` 获取工具列表。该函数用 LRU 缓存（容量 20）包装，以服务器名为键：

```typescript
// [src/services/mcp/client.ts]
export const fetchToolsForClient = memoizeWithLRU(
  async (client: MCPServerConnection): Promise<Tool[]> => {
    if (!client.capabilities?.tools) return []

    const result = await client.client.request(
      { method: 'tools/list' },
      ListToolsResultSchema,
    ) as ListToolsResult

    const toolsToProcess = recursivelySanitizeUnicode(result.tools)

    return toolsToProcess.map((tool): Tool => {
      const fullyQualifiedName = buildMcpToolName(client.name, tool.name)
      return {
        ...MCPTool,
        name: fullyQualifiedName,
        mcpInfo: { serverName: client.name, toolName: tool.name },
        // ...
      }
    })
  },
  (client) => client.name,
  MCP_FETCH_CACHE_SIZE,
)
```

`recursivelySanitizeUnicode` 会递归地处理工具描述和 schema 中的异常 Unicode 字符，防止来自外部 MCP Server 的数据破坏 Claude 的上下文格式。

### 工具命名规范：mcp__ 前缀

MCP 工具的全限定名由 `buildMcpToolName()` 生成：

```typescript
// [src/services/mcp/mcpStringUtils.ts]
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `${getMcpPrefix(serverName)}${normalizeNameForMCP(toolName)}`
}

export function getMcpPrefix(serverName: string): string {
  return `mcp__${normalizeNameForMCP(serverName)}__`
}
```

`normalizeNameForMCP()` 将所有非字母数字字符（包括点、空格）替换为下划线，确保工具名符合 Anthropic API 的命名约束（`^[a-zA-Z0-9_-]{1,64}$`）。

因此，一个名为 `github` 的服务器提供的 `create_issue` 工具，在 Claude Code 内部的名字就是 `mcp__github__create_issue`。用户在 `settings.json` 中写的权限规则（allow/deny）也需要使用这个全限定名。

### 工具调用：call_tool 的实现

每个从 `fetchToolsForClient` 返回的工具对象，都在 `.call()` 方法中注入了具体的 RPC 调用逻辑：

```typescript
// [src/services/mcp/client.ts]
async call(args, context, _canUseTool, parentMessage, onProgress?) {
  const connectedClient = await ensureConnectedClient(client)
  const mcpResult = await callMCPToolWithUrlElicitationRetry({
    client: connectedClient,
    tool: tool.name,    // 原始工具名，非全限定名
    args,
    meta,
    signal: context.abortController.signal,
    // ...
  })

  return {
    data: mcpResult.content,
    // 如果有结构化内容或元数据，一并返回
    ...((mcpResult._meta || mcpResult.structuredContent) && {
      mcpMeta: { ... }
    }),
  }
}
```

工具调用还内置了会话过期重试机制：如果 HTTP MCP Server 返回 404 并且错误码为 `-32001`（`Session not found`），Claude Code 会清除连接缓存并自动用新 session 重试一次：

```typescript
// [src/services/mcp/client.ts]
const MAX_SESSION_RETRIES = 1
for (let attempt = 0; ; attempt++) {
  try {
    // 调用工具 ...
  } catch (error) {
    if (error instanceof McpSessionExpiredError && attempt < MAX_SESSION_RETRIES) {
      continue // 用新连接重试
    }
    throw error
  }
}
```

### 工具描述截断

有些第三方 MCP Server（尤其是由 OpenAPI spec 自动生成的）会把几十 KB 的文档塞进工具描述里。Claude Code 对此做了截断处理：

```typescript
// [src/services/mcp/client.ts]
const MAX_MCP_DESCRIPTION_LENGTH = 2048

async prompt() {
  const desc = tool.description ?? ''
  return desc.length > MAX_MCP_DESCRIPTION_LENGTH
    ? desc.slice(0, MAX_MCP_DESCRIPTION_LENGTH) + '… [truncated]'
    : desc
}
```

同样，服务器 `instructions`（连接建立时通过 `client.getInstructions()` 获取的系统级提示）也受同一上限约束，避免单个 MCP Server 消耗过多的上下文窗口。

### 连接断开与自动重连

`connectToServer` 在成功返回 `ConnectedMCPServer` 时，会为 `client.onclose` 挂载一个清理回调，负责清除 memoize 缓存：

```typescript
// [src/services/mcp/client.ts]
client.onclose = () => {
  const key = getServerCacheKey(name, serverRef)
  // 清除连接缓存和所有 fetch 缓存
  connectToServer.cache.delete(key)
  fetchToolsForClient.cache.delete(name)
  fetchResourcesForClient.cache.delete(name)
  fetchCommandsForClient.cache.delete(name)
}
```

这样下次调用 `ensureConnectedClient()` 时，`connectToServer` 发现缓存为空，会自动建立新连接。整个重连过程对上层调用者完全透明。

对于远程传输（SSE/HTTP），Claude Code 还实现了基于错误计数的主动关闭策略：连续收到 3 次终端性错误（`ECONNRESET`、`ETIMEDOUT`、`EPIPE` 等），就主动调用 `client.close()` 触发重连链路：

```typescript
// [src/services/mcp/client.ts]
const MAX_ERRORS_BEFORE_RECONNECT = 3

if (consecutiveConnectionErrors >= MAX_ERRORS_BEFORE_RECONNECT) {
  consecutiveConnectionErrors = 0
  closeTransportAndRejectPending('max consecutive terminal errors')
}
```

## 12.7 资源系统：list_resources 与 ReadMcpResourceTool

MCP 不仅支持"工具调用"，还支持"资源读取"——资源是服务器暴露的静态或动态数据，可以通过 URI 寻址。Claude Code 通过两个专用工具实现对资源的访问。

### ListMcpResourcesTool

`src/tools/ListMcpResourcesTool/ListMcpResourcesTool.ts` 实现了对所有连接 MCP Server 的资源列举：

```typescript
// [src/tools/ListMcpResourcesTool/ListMcpResourcesTool.ts]
async call(input, { options: { mcpClients } }) {
  const clientsToProcess = targetServer
    ? mcpClients.filter(c => c.name === targetServer)
    : mcpClients

  const results = await Promise.all(
    clientsToProcess.map(async client => {
      if (client.type !== 'connected') return []
      const fresh = await ensureConnectedClient(client)
      return await fetchResourcesForClient(fresh)
    }),
  )

  return { data: results.flat() }
}
```

在底层，`fetchResourcesForClient` 向 MCP Server 发起 `resources/list` RPC 调用，返回的每个资源都会被附加上 `server` 字段（即 MCP Server 的名称），方便后续查找来源：

```typescript
// [src/services/mcp/client.ts]
export const fetchResourcesForClient = memoizeWithLRU(
  async (client) => {
    const result = await client.client.request(
      { method: 'resources/list' },
      ListResourcesResultSchema,
    )
    return result.resources.map(resource => ({
      ...resource,
      server: client.name,
    }))
  },
  (client) => client.name,
  MCP_FETCH_CACHE_SIZE,
)
```

### ReadMcpResourceTool

`src/tools/ReadMcpResourceTool/ReadMcpResourceTool.ts` 实现了按 URI 读取具体资源内容：

```typescript
// [src/tools/ReadMcpResourceTool/ReadMcpResourceTool.ts]
async call(input, { options: { mcpClients } }) {
  const { server: serverName, uri } = input
  const client = mcpClients.find(c => c.name === serverName)

  const connectedClient = await ensureConnectedClient(client)
  const result = await connectedClient.client.request(
    {
      method: 'resources/read',
      params: { uri },
    },
    ReadResourceResultSchema,
  )

  // 处理二进制内容：base64 解码后写入磁盘，避免把几 MB 的 base64 字符串塞进上下文
  const contents = await Promise.all(
    result.contents.map(async (c, i) => {
      if ('text' in c) return { uri: c.uri, mimeType: c.mimeType, text: c.text }
      if ('blob' in c) {
        const persisted = await persistBinaryContent(
          Buffer.from(c.blob, 'base64'),
          c.mimeType,
          persistId,
        )
        return { uri: c.uri, mimeType: c.mimeType, blobSavedTo: persisted.filepath }
      }
    }),
  )

  return { data: { contents } }
}
```

二进制资源的处理特别值得关注：如果 MCP Server 返回的是 blob 格式（base64 编码的图片、PDF 等），`ReadMcpResourceTool` 会将其解码后写入本地临时文件，在返回给 Claude 的结果中只携带文件路径，而不是几 MB 的 base64 字符串。这是一个重要的内存优化。

### 资源工具的注册时机

资源工具（`ListMcpResourcesTool` 和 `ReadMcpResourceTool`）不是每个 MCP Server 都单独注册一份，而是全局只注册一次：

```typescript
// [src/services/mcp/client.ts]
let resourceToolsAdded = false

if (supportsResources && !resourceToolsAdded) {
  resourceToolsAdded = true
  resourceTools.push(ListMcpResourcesTool, ReadMcpResourceTool)
}
```

这两个通用工具通过参数（`server` 字段）来区分目标服务器，避免在工具列表中产生 N 个重复的资源工具条目。

## 12.8 认证机制：OAuth2 全流程

对于需要认证的远程 MCP Server，Claude Code 实现了完整的 OAuth 2.0 流程，核心在 `src/services/mcp/auth.ts` 的 `ClaudeAuthProvider` 类。

### 认证状态的快速路径

启动时，Claude Code 不会急于对每个远程服务器都走一遍 OAuth 发现流程。`isMcpAuthCached()` 函数维护了一个 15 分钟有效期的文件级缓存：

```typescript
// [src/services/mcp/client.ts]
const MCP_AUTH_CACHE_TTL_MS = 15 * 60 * 1000 // 15 分钟

async function isMcpAuthCached(serverId: string): Promise<boolean> {
  const cache = await getMcpAuthCache()
  const entry = cache[serverId]
  return entry ? Date.now() - entry.timestamp < MCP_AUTH_CACHE_TTL_MS : false
}
```

如果一个服务器在 15 分钟内曾经返回过 `needs-auth`，再次启动时会直接跳过连接尝试，避免每次启动都触发 N 个无效的 OAuth 发现 HTTP 请求。

### Token 存储与刷新

OAuth Token 通过 `getSecureStorage()` 存储在系统钥匙串（macOS Keychain / Linux Secret Service）中，以服务器名和配置的 SHA-256 哈希值作为存储键：

```typescript
// [src/services/mcp/auth.ts]
export function getServerKey(serverName, serverConfig): string {
  const configJson = jsonStringify({
    type: serverConfig.type,
    url: serverConfig.url,
    headers: serverConfig.headers || {},
  })
  const hash = createHash('sha256').update(configJson).digest('hex').substring(0, 16)
  return `${serverName}|${hash}`
}
```

Token 刷新逻辑实现了对异常服务器的兼容处理。例如，Slack 等非标准 OAuth 服务器会在刷新 Token 失效时返回 HTTP 200 但 body 为 `{"error": "invalid_refresh_token"}`，而不是标准的 HTTP 400。`normalizeOAuthErrorBody()` 函数专门处理这种情况，将 200 + 错误 body 重写为 400 响应，确保 SDK 的错误处理逻辑能正确识别 `InvalidGrantError`。

### OAuth 发现（RFC 9728 + RFC 8414）

当 MCP Server 需要 OAuth 但尚无 Token 时，`fetchAuthServerMetadata()` 按照以下顺序发现 Authorization Server：

1. 如果配置了 `authServerMetadataUrl`，直接使用（HTTPS 强制要求）
2. RFC 9728：探测 MCP Server 的 `/.well-known/oauth-protected-resource`，读取 `authorization_servers[0]`，再按 RFC 8414 发现该 AS 的元数据
3. 回退：直接对 MCP Server URL 做 RFC 8414 路径感知探测（保留原有路径，而不是 SDK 默认的去路径行为）

### 跨应用访问（XAA）

Claude Code 还支持 XAA（Cross-App Access），一种允许在企业 SSO 场景下跨应用共享 IdP Token 的机制。当 MCP Server 配置了 `oauth.xaa: true` 时，Claude Code 会先通过企业 IdP 获取 id_token，再用它去 MCP Server 的 AS 做 Token Exchange（RFC 8693），最终获取 MCP 服务的访问令牌。

### 认证工具：McpAuthTool

当服务器状态为 `needs-auth` 时，Claude Code 不是直接抛错，而是向工具列表中注入一个特殊的 `McpAuthTool`。Claude 可以调用这个工具触发 OAuth 流程，引导用户在浏览器中完成授权。这样认证过程本身也变成了一个"工具调用"，与整个 Agent 循环无缝集成。

## 12.9 并发控制：批量启动的设计

Claude Code 启动时可能需要同时连接数十个 MCP Server。`getMcpToolsCommandsAndResources()` 使用 `pMap` 实现了分类并发控制：

```typescript
// [src/services/mcp/client.ts]
// 本地服务器（stdio/sdk）：较低并发，避免同时 fork 太多子进程
const localServers = configEntries.filter(([_, c]) => isLocalMcpServer(c))
// 远程服务器（SSE/HTTP/WS）：较高并发，网络连接不消耗本地资源
const remoteServers = configEntries.filter(([_, c]) => !isLocalMcpServer(c))

await Promise.all([
  processBatched(localServers, getMcpServerConnectionBatchSize(), processServer),     // 默认 3
  processBatched(remoteServers, getRemoteMcpServerConnectionBatchSize(), processServer), // 默认 20
])
```

这两组服务器并发地启动，各自维护独立的并发上限，互不阻塞。`getMcpServerConnectionBatchSize()` 和 `getRemoteMcpServerConnectionBatchSize()` 都支持通过环境变量（`MCP_SERVER_CONNECTION_BATCH_SIZE`、`MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE`）调整，给需要精细调优的用户提供了入口。

`onConnectionAttempt` 回调在每个服务器完成连接（无论成功还是失败）时立即被调用，这意味着 UI 可以实时展示每个服务器的连接状态，而不是等全部服务器都连好再刷新。

## 12.10 进程内 MCP Server：特殊的 in-process 模式

对于某些特定的 MCP Server（如 Claude in Chrome、Computer Use），Claude Code 采用了"进程内运行"的特殊模式，避免启动额外的 325 MB 子进程：

```typescript
// [src/services/mcp/client.ts]
// 对于 Chrome MCP 服务器，在进程内运行以节省资源
const { createLinkedTransportPair } = await import('./InProcessTransport.js')
const context = createChromeContext(serverRef.env)
inProcessServer = createClaudeForChromeMcpServer(context)
const [clientTransport, serverTransport] = createLinkedTransportPair()
await inProcessServer.connect(serverTransport)
transport = clientTransport
```

`InProcessTransport.ts` 实现了一对直接内存通信的 Transport，让 Client 侧和 Server 侧通过内存通道交换 JSON-RPC 消息，而不需要任何 IPC 或网络。从 Client 的视角看，它和真正的子进程 MCP Server 完全一样，只是底层没有 fork。

## 12.11 小结：从封闭工具到开放生态

回顾整个 MCP 集成的实现，可以提炼出几个关键设计决策：

**统一抽象，差异内化**。无论是 stdio 子进程、SSE 长连接还是 HTTP Streamable，在 `connectToServer()` 以上的所有代码都只看到 `MCPServerConnection` 接口和 `Client` 对象，传输层的差异被完全封装在内部。

**缓存驱动的懒重连**。`connectToServer` 的 memoize 缓存 + `onclose` 时的缓存清除，构成了一套优雅的按需重连机制：连接存活时零开销，断开后下次调用自动恢复，不需要任何显式的重连调度。

**状态机模型清晰表达意图**。`MCPServerConnection` 的五种状态不仅让代码更安全（TypeScript 强制处理每种 case），也让 UI 层能够精确展示每台服务器的实际状态，而不是简单的"连接/断开"二元视图。

**认证是一等公民**。OAuth 流程、Token 缓存、`needs-auth` 状态、`McpAuthTool`——这一整套设计让"需要认证的 MCP Server"不是边角情况，而是和普通 Server 同等地位的标准场景。

对于用户来说，MCP 意味着一行 `.mcp.json` 配置就能给 Claude Code 注入无限能力：浏览器自动化、数据库查询、Slack 消息、GitHub PR……整个工具生态变成了一个开放市场。这正是 MCP 协议最根本的价值：**它把 Claude Code 从一个功能固定的工具，变成了一个可编程的能力平台**。

---

下一章，我们将把目光转向 Claude Code 的另一种扩展机制——**自定义命令（Custom Commands）**。与 MCP 侧重于"工具调用"不同，自定义命令让用户定义可复用的提示模板，将复杂的多步工作流封装为一条斜杠命令。我们将看到这套命令系统是如何从 Markdown 文件解析出 `Command` 对象，并与 Agent 循环深度集成的。
