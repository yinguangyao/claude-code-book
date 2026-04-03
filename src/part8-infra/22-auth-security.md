# 第 22 章 认证与安全存储

> 一个 AI Agent 能够读写文件、执行命令、访问网络——这意味着它持有的凭证必须被妥善保护。本章拆解 Claude Code 如何在 macOS Keychain、OAuth 2.0 PKCE 流程和多层回退之间构建安全的认证体系。

## 22.1 概念引入：凭证的生命周期

Claude Code 需要管理两类凭证：

| 类型 | 来源 | 示例 |
|------|------|------|
| **API Key** | 直接密钥 | `ANTHROPIC_API_KEY` 环境变量 |
| **OAuth Token** | 授权码流程 | claude.ai 登录获取的 access_token |

两者都需要**安全存储**（不能明文写磁盘）、**自动刷新**（过期时透明续期）和**多源回退**（一种方式不可用时尝试下一种）。

## 22.2 架构总览

```
认证来源优先级（高 → 低）：

┌────────────────────────────────────────────────┐
│ File Descriptor                                 │
│ CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR         │
│ （CCR 容器内的管道传递）                          │
├────────────────────────────────────────────────┤
│ 环境变量                                        │
│ ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN  │
├────────────────────────────────────────────────┤
│ OAuth Token（安全存储）                          │
│ macOS Keychain / 明文回退                       │
├────────────────────────────────────────────────┤
│ apiKeyHelper                                    │
│ settings.json 中配置的外部命令                   │
├────────────────────────────────────────────────┤
│ ANTHROPIC_API_KEY                               │
│ 环境变量（兼容旧版）                             │
├────────────────────────────────────────────────┤
│ none                                            │
│ 未认证                                          │
└────────────────────────────────────────────────┘
```

## 22.3 源码走读

### 22.3.1 安全存储：平台自适应

Claude Code 的安全存储系统根据平台选择最佳的密钥存储后端：

```typescript
// src/utils/secureStorage/index.ts

function getSecureStorage(): SecureStorage {
  if (isMacOS) {
    return new FallbackStorage(
      new MacOsKeychainStorage(),  // 首选：Keychain
      new PlainTextStorage(),       // 回退：明文文件
    )
  }
  // Windows / Linux：直接使用明文回退
  return new PlainTextStorage()
}
```

**macOS Keychain 实现**：

```typescript
// src/utils/secureStorage/macOsKeychainStorage.ts

class MacOsKeychainStorage implements SecureStorage {
  private cache: Map<string, { value: string; timestamp: number }> = new Map()

  async read(key: string): Promise<string | null> {
    // 1. 检查缓存（TTL = 1000ms）
    const cached = this.cache.get(key)
    if (cached && Date.now() - cached.timestamp < KEYCHAIN_CACHE_TTL_MS) {
      return cached.value
    }

    // 2. 调用 security 命令读取
    const result = await exec(
      `security find-generic-password -a "${username}" -w -s "${serviceName}"`
    )

    // 3. 更新缓存
    this.cache.set(key, { value: result, timestamp: Date.now() })
    return result
  }

  async write(key: string, value: string): Promise<void> {
    // 清除缓存，防止读到旧值
    this.clearCache()

    // Hex 编码防止 Shell 转义问题
    const hexValue = Buffer.from(value).toString('hex')

    // 优先使用 stdin 传递（隐藏负载，防止 CrowdStrike 等进程监控捕获）
    if (hexValue.length < STDIN_LIMIT) {
      await execWithStdin(
        `security -i`,
        `add-generic-password -U -a "${username}" -s "${serviceName}" -X "${hexValue}"`
      )
    } else {
      // 超长负载回退到命令行参数
      await exec(
        `security add-generic-password -U -a "${username}" -s "${serviceName}" -X "${hexValue}"`
      )
    }
  }
}
```

**Stdin vs 命令行参数**：这个选择看似微小，却关乎安全。`security` 命令的参数会出现在进程列表中，能被安全工具（如 CrowdStrike）捕获。通过 stdin 传递，敏感数据不会泄露到进程列表。

**回退存储的迁移逻辑**：

```typescript
// src/utils/secureStorage/fallbackStorage.ts

class FallbackStorage implements SecureStorage {
  constructor(
    private primary: SecureStorage,    // Keychain
    private secondary: SecureStorage,  // 明文
  ) {}

  async write(key: string, value: string): Promise<void> {
    try {
      await this.primary.write(key, value)
      // 首次成功写入 primary → 删除 secondary 中的残留
      await this.secondary.delete(key)
    } catch {
      // primary 失败 → 写入 secondary
      await this.secondary.write(key, value)
      // 清理 primary 中可能的过时数据（避免旧 token 覆盖新 token）
      await this.primary.delete(key).catch(() => {})
    }
  }

  async read(key: string): Promise<string | null> {
    try {
      return await this.primary.read(key)
    } catch {
      return await this.secondary.read(key)
    }
  }
}
```

### 22.3.2 并发读取的去重与生代计数

在高并发场景下，多个组件可能同时请求同一个凭证：

```typescript
// src/utils/secureStorage/macOsKeychainStorage.ts

let readInFlight: Map<string, Promise<string | null>> = new Map()
let generation = 0  // 缓存失效代

async function readAsync(key: string): Promise<string | null> {
  // 去重：如果已有一个读取在进行中，复用它
  const existing = readInFlight.get(key)
  if (existing) return existing

  const currentGen = generation
  const promise = doRead(key).finally(() => {
    readInFlight.delete(key)
  })
  readInFlight.set(key, promise)

  const result = await promise

  // 生代检查：如果在我读取期间缓存被清除了，不更新缓存
  // （防止旧的 in-flight 读取覆盖新写入的值）
  if (currentGen === generation) {
    cache.set(key, { value: result, timestamp: Date.now() })
  }

  return result
}

function clearCache(): void {
  generation++  // 使所有 in-flight 读取的缓存更新失效
  cache.clear()
}
```

**生代计数器**是防止经典的"ABA 问题"的关键：

```
时间线：
  t0: read() 开始，generation=1
  t1: write() 更新了值，clearCache() → generation=2
  t2: read() 的 subprocess 返回旧值
  t3: read() 检查 currentGen(1) !== generation(2)
  t4: 跳过缓存更新 ✓（避免用旧值覆盖新值）
```

### 22.3.3 OAuth 2.0 PKCE 流程

Claude Code 实现了标准的 OAuth 2.0 授权码 + PKCE 流程：

```typescript
// src/services/oauth/index.ts

class OAuthService {
  async startOAuthFlow(): Promise<OAuthTokens> {
    // 1. 生成 PKCE 参数
    const codeVerifier = generateRandomString(128)
    const codeChallenge = base64url(sha256(codeVerifier))
    const state = generateRandomString(32)

    // 2. 启动本地 HTTP 监听器（接收回调）
    const listener = new AuthCodeListener(port)
    await listener.start()

    // 3. 构建授权 URL 并打开浏览器
    const authUrl = buildAuthUrl({
      client_id: CLIENT_ID,        // 固定公开 Client ID
      redirect_uri: `http://localhost:${port}/callback`,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      scope: SCOPES.join(' '),
    })
    await openBrowser(authUrl)

    // 4. 并行等待两种认证方式
    const code = await Promise.race([
      listener.waitForCode(),           // 自动：浏览器回调
      waitForManualCodeInput(),          // 手动：用户粘贴 code
    ])

    // 5. 交换授权码为 Token
    const tokens = await exchangeCodeForTokens(code, codeVerifier)

    // 6. 获取用户 Profile
    tokens.profile = await fetchProfileInfo(tokens.accessToken)

    // 7. 安全存储 Token
    await secureStorage.write('oauth_tokens', JSON.stringify(tokens))

    return tokens
  }
}
```

**PKCE 的安全意义**：传统 OAuth 使用 client_secret，但 CLI 工具无法安全存储 secret（代码是公开的）。PKCE 用一次性的 `code_verifier` 替代 `client_secret`——即使授权码被截获，没有 verifier 也无法交换 Token。

**Token 刷新**：

```typescript
// src/services/oauth/index.ts

async function refreshOAuthToken(refreshToken: string): Promise<OAuthTokens> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      scope: SCOPES.join(' '),
    }),
  })

  const data = await response.json()
  return {
    accessToken: data.access_token,
    // 后端可能返回新的 refresh_token，也可能复用旧的
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  }
}
```

**作用域**：

```typescript
// src/constants/oauth.ts

const SCOPES = [
  'user:profile',              // 个人资料
  'user:inference',            // Claude.ai 推理
  'org:create_api_key',        // 创建 API Key
  'user:sessions:claude_code', // 会话管理
  'user:mcp_servers',          // MCP 服务器配置
  'user:file_upload',          // 文件上传
]
```

### 22.3.4 apiKeyHelper：外部密钥提供者

对于不使用 OAuth 的场景（如企业自建部署），Claude Code 支持通过外部命令获取 API Key：

```typescript
// src/utils/auth.ts

// 在 settings.json 中配置：
// { "apiKeyHelper": "vault read -field=key secret/claude-api" }

let cache: { value: string; epoch: number; timestamp: number } | null = null
let refreshPromise: Promise<string | null> | null = null

async function getApiKeyFromHelper(): Promise<string | null> {
  const helper = getSettings().apiKeyHelper
  if (!helper) return null

  // Stale-while-revalidate 策略
  if (cache && Date.now() - cache.timestamp < TTL) {
    // 缓存新鲜，直接返回
    return cache.value
  }

  if (cache) {
    // 缓存过期但有值——返回旧值，后台刷新
    if (!refreshPromise) {
      refreshPromise = refreshApiKey(helper)
    }
    return cache.value  // 立即返回旧值
  }

  // 冷缓存——必须阻塞等待
  return await refreshApiKey(helper)
}

async function refreshApiKey(command: string): Promise<string | null> {
  const currentEpoch = cache?.epoch ?? 0
  try {
    const key = await exec(command, { timeout: 5000 })
    // Epoch 检查：如果在执行期间缓存被清除了，不更新
    if (currentEpoch === (cache?.epoch ?? 0)) {
      cache = { value: key.trim(), epoch: currentEpoch, timestamp: Date.now() }
    }
    return key.trim()
  } finally {
    refreshPromise = null
  }
}
```

**安全防护**：当 `apiKeyHelper` 来自项目级配置（而非用户级）时，需要先通过工作区信任对话框：

```typescript
if (isProjectSetting(apiKeyHelper)) {
  await requireWorkspaceTrust()
  // 用户必须明确批准才会执行项目配置的命令
}
```

### 22.3.5 上下文守卫

不同的运行环境有不同的认证约束：

```typescript
// src/utils/auth.ts

function getAuthSource(context: AuthContext): AuthSource {
  // 受管 OAuth 上下文（远程模式 / Claude Desktop）
  if (context.isManagedOAuth) {
    // 绝不回退到 apiKeyHelper 或 ANTHROPIC_API_KEY
    // 只使用 OAuth Token
    return 'oauth_only'
  }

  // Bare 模式（--bare）
  if (context.isBare) {
    // 仅 API Key，无 OAuth，无 Keychain
    return 'api_key_only'
  }

  // 第三方服务（Bedrock / Vertex / Foundry）
  if (context.is3P) {
    // 绝不使用 Anthropic OAuth
    return 'provider_native'
  }

  // 标准模式：完整优先级链
  return 'full_chain'
}
```

## 22.4 Keychain 锁定检测

macOS Keychain 可能被锁定（如屏幕保护程序触发后），此时需要优雅降级：

```typescript
// src/utils/secureStorage/macOsKeychainStorage.ts

let keychainLockedCache: boolean | null = null

async function isMacOsKeychainLocked(): Promise<boolean> {
  if (keychainLockedCache !== null) return keychainLockedCache

  try {
    const { exitCode } = await exec('security show-keychain-info')
    keychainLockedCache = exitCode === 36  // 36 = keychain locked
    return keychainLockedCache
  } catch {
    return false  // 非 macOS 或无法检测
  }
}
```

检测结果缓存到进程生命周期——Keychain 锁定状态在进程运行期间不太会改变。

## 22.5 设计哲学

| 设计 | 说明 |
|------|------|
| **Keychain 优先** | 操作系统级加密，比应用层方案更安全 |
| **Stdin 传递** | 避免敏感数据出现在进程列表中 |
| **PKCE 流程** | CLI 无法安全存储 client_secret，用一次性 verifier 替代 |
| **生代计数** | 防止过期的异步读取覆盖新写入的值 |
| **Stale-while-revalidate** | API Key 过期时先返回旧值，后台静默刷新 |
| **上下文守卫** | 不同运行环境强制不同的认证路径 |
| **工作区信任** | 项目配置的认证命令需要用户显式批准 |

## 22.6 小结

- **平台自适应存储**：macOS Keychain → 明文回退，Hex 编码 + Stdin 传递防泄露
- **OAuth 2.0 + PKCE**：标准授权码流程，支持浏览器自动回调和手动粘贴两种方式
- **生代计数器**：解决并发读写的 ABA 问题，防止旧值覆盖新值
- **Stale-while-revalidate**：apiKeyHelper 过期时不阻塞，后台刷新
- **多源优先级链**：File Descriptor → 环境变量 → OAuth → apiKeyHelper → API Key
- **上下文守卫**：受管 OAuth / Bare 模式 / 第三方服务各有独立的认证约束
