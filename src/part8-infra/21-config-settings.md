# 第 21 章 配置系统——五层合并的设置管理

> 一个看似简单的 `settings.json` 背后，隐藏着五层配置源、三级缓存、MDM 企业管控和实时变更检测。本章将拆解 Claude Code 如何在灵活性与安全性之间找到平衡。

## 21.1 概念引入：为什么配置如此复杂

一个简单的 CLI 工具可能只需要一个配置文件。但 Claude Code 面临的需求远非如此：

- **个人偏好**：用户想自定义模型、主题、快捷键
- **团队规范**：项目组想统一权限规则、Hook 配置
- **本地覆盖**：开发者想在本机加入不提交到 Git 的私有设置
- **企业管控**：IT 管理员想通过 MDM 强制安全策略
- **SDK/CLI 参数**：程序化调用时需要注入运行时配置

这五种需求对应了 Claude Code 的**五层配置源**。

## 21.2 架构总览

```
优先级（低 → 高）：

┌─────────────────────────────────────────────────────┐
│  Plugin Settings（插件默认）                          │
│  只允许部分白名单 key                                 │
└───────────────────────────┬─────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────┐
│  User Settings（用户级）                              │
│  ~/.claude/settings.json                             │
└───────────────────────────┬─────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────┐
│  Project Settings（项目级，共享）                      │
│  .claude/settings.json                               │
└───────────────────────────┬─────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────┐
│  Local Settings（本地覆盖，gitignore）                │
│  .claude/settings.local.json                         │
└───────────────────────────┬─────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────┐
│  Policy Settings（企业策略，最高优先）                  │
│  MDM / managed-settings.json / 注册表                │
│  规则："First Source Wins"                            │
└───────────────────────────┬─────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────┐
│  Flag Settings（运行时注入）                          │
│  CLI --settings / SDK 参数                           │
└─────────────────────────────────────────────────────┘
```

## 21.3 源码走读

### 21.3.1 配置合并策略

```typescript
// src/utils/settings/settings.ts

function loadSettingsFromDisk(): SettingsWithErrors {
  const sources = [
    loadPluginSettings(),          // 插件默认
    loadUserSettings(),            // ~/.claude/settings.json
    loadProjectSettings(),         // .claude/settings.json
    loadLocalSettings(),           // .claude/settings.local.json
    loadPolicySettings(),          // MDM / managed-settings.json
    loadFlagSettings(),            // CLI / SDK 参数
  ]

  // lodash mergeWith + 自定义合并逻辑
  const merged = mergeWith({}, ...sources, settingsMergeCustomizer)
  return { settings: merged, errors: collectAllErrors(sources) }
}

function settingsMergeCustomizer(objValue, srcValue) {
  // 数组：拼接 + 去重
  if (Array.isArray(objValue) && Array.isArray(srcValue)) {
    return uniqBy([...objValue, ...srcValue], JSON.stringify)
  }
  // 对象：深度合并（lodash 默认行为）
  // undefined：视为删除标记
}
```

### 21.3.2 三级缓存架构

```typescript
// src/utils/settings/settingsCache.ts

// 第一级：会话缓存——合并后的最终结果
let sessionCache: SettingsWithErrors | null = null

function getSessionSettingsCache(): SettingsWithErrors {
  if (!sessionCache) {
    sessionCache = loadSettingsFromDisk()
  }
  return sessionCache
}

// 第二级：来源缓存——每个来源的独立结果
const perSourceCache = new Map<SettingSource, SettingsJson>()

function getCachedSettingsForSource(source: SettingSource): SettingsJson {
  if (!perSourceCache.has(source)) {
    perSourceCache.set(source, loadSettingsForSource(source))
  }
  return perSourceCache.get(source)!
}

// 第三级：文件解析缓存——避免重复读盘
const parsedFileCache = new Map<string, SettingsJson>()

function getCachedParsedFile(filePath: string): SettingsJson {
  if (!parsedFileCache.has(filePath)) {
    // 注意：返回克隆值，防止调用方污染缓存
    parsedFileCache.set(filePath, clone(parseSettingsFile(filePath)))
  }
  return clone(parsedFileCache.get(filePath)!)
}
```

**缓存失效时机**：
- 设置文件被 `updateSettingsForSource()` 写入
- `--add-dir` 发现新目录
- 插件初始化完成
- Hooks 配置刷新
- 文件监听器检测到外部变更
- MDM 轮询发现策略更新

### 21.3.3 校验与容错

配置校验不是"全通过或全拒绝"，而是**收集所有错误，尽量使用合法部分**：

```typescript
// src/utils/settings/validation.ts

function validateSettings(raw: unknown): SettingsWithErrors {
  // 1. JSON 解析
  const parsed = safeParseJSON(raw)
  if (!parsed) return { settings: null, errors: [jsonSyntaxError] }

  // 2. 权限规则预过滤——移除格式错误的规则，而非整体拒绝
  const filtered = filterInvalidPermissionRules(parsed)

  // 3. Zod Schema 校验
  const result = SettingsSchema().safeParse(filtered)
  if (!result.success) {
    // 收集错误但不中断
    const errors = formatZodError(result.error)
    return { settings: filtered, errors }
  }

  return { settings: result.data, errors: [] }
}
```

每个 `ValidationError` 包含丰富的上下文：

```typescript
type ValidationError = {
  file: string              // 哪个配置文件
  path: string              // JSON 路径（如 "permissions[2].pattern"）
  message: string           // 错误描述
  expected: string          // 期望的类型/值
  invalidValue: unknown     // 实际的错误值
  suggestion?: string       // 修复建议
  docLink?: string          // 文档链接
}
```

### 21.3.4 MDM 企业管控

MDM（Mobile Device Management）系统允许企业 IT 管理员通过操作系统的管理机制强制推送配置：

```typescript
// src/utils/settings/mdm/settings.ts

// macOS：通过 plist 配置文件
// 优先级：
// 1. /Library/Managed Preferences/<username>/com.anthropic.claudecode.plist（管理员级）
// 2. /Library/Managed Preferences/com.anthropic.claudecode.plist（设备级）
// 3. ~/Library/Preferences/com.anthropic.claudecode.plist（用户级，仅 Anthropic 员工测试用）

// Windows：通过注册表
// 1. HKLM\SOFTWARE\Policies\ClaudeCode（管理员级）
// 2. HKCU\SOFTWARE\Policies\ClaudeCode（用户级）

// Linux：文件系统
// /etc/claude-code/managed-settings.json
```

MDM 采用**"First Source Wins"**策略——与逐层合并不同，它取第一个非空的策略源，完整使用其配置，不与其他源混合。这避免了不同管理员策略之间的冲突。

**异步预加载优化**：

```typescript
// src/utils/settings/mdm/rawRead.ts

// 模块加载时立即触发异步读取
const mdmPromise = startMdmSettingsLoad()  // 不等待

// 首次需要设置时才 await
async function ensureMdmSettingsLoaded(): Promise<MdmSettings> {
  return await mdmPromise  // 此时大概率已完成
}
```

这个"异步预加载 + 延迟 await"模式让 MDM 读取（涉及 subprocess 调用 `plutil` 或 `reg query`）与其他启动任务并行执行，不阻塞启动流程。

### 21.3.5 Drop-in 目录

借鉴 systemd/sudoers 的 drop-in 配置模式：

```
/etc/claude-code/
├── managed-settings.json        ← 基础策略文件
└── managed-settings.d/          ← Drop-in 目录
    ├── 00-base-security.json    ← 基础安全策略
    ├── 10-team-tools.json       ← 团队工具配置
    └── 99-overrides.json        ← 覆盖项
```

文件按字母顺序排序合并，允许不同管理维度独立维护各自的策略片段。

### 21.3.6 实时变更检测

```typescript
// src/utils/settings/changeDetector.ts

// 使用 chokidar 监听配置文件变更
function startSettingsWatcher(): void {
  const watcher = chokidar.watch(enabledSettingsFiles, {
    // 排除 flagSettings（CLI 参数，运行中不变）
  })

  watcher.on('change', async (filePath) => {
    // 稳定性检查：等文件写入完成
    await waitForStability(filePath, {
      threshold: 1000,   // 1 秒无变化
      pollInterval: 500, // 每 500ms 检查一次
    })

    // 内部写入抑制：如果是 Claude Code 自己写的，忽略
    if (isInternalWrite(filePath)) return

    // 重置缓存
    resetSettingsCache()

    // 触发 ConfigChange Hook（可被 Hook 拦截！）
    const hookResult = await fireHook('ConfigChange', { file: filePath })
    if (hookResult?.decision === 'block') return  // Hook 拒绝了这次变更

    // 通知所有监听器
    notifySettingsChanged()
  })

  // 删除 + 重建的 Grace Period
  watcher.on('unlink', (filePath) => {
    // 等 1200ms——很多编辑器是"删除旧文件 + 写入新文件"
    deletionTimers.set(filePath, setTimeout(() => {
      processFileDeletion(filePath)
    }, DELETION_GRACE_MS))
  })

  watcher.on('add', (filePath) => {
    // 文件被重建——取消之前的删除定时器
    if (deletionTimers.has(filePath)) {
      clearTimeout(deletionTimers.get(filePath))
      deletionTimers.delete(filePath)
      // 当作 change 处理
      processFileChange(filePath)
    }
  })
}
```

**MDM 轮询**：由于注册表和 plist 无法通过文件系统事件监听，MDM 设置每 30 分钟轮询一次：

```typescript
setInterval(async () => {
  const current = await readMdmSettings()
  if (!deepEqual(current, lastSnapshot)) {
    notifySettingsChanged()
    lastSnapshot = current
  }
}, 30 * 60 * 1000)  // 30 分钟
```

## 21.4 设计哲学

| 设计 | 说明 |
|------|------|
| **五层合并** | 从个人到企业，每层有明确的语义和优先级 |
| **容错校验** | 一条坏规则不会毒化整个配置文件 |
| **First Source Wins** | 策略层不混合，避免多管理员冲突 |
| **防御性克隆** | 缓存返回克隆值，防止外部代码污染缓存 |
| **Grace Period** | 编辑器"删除+重建"模式不会触发误报 |
| **Hook 可拦截** | 配置变更可被 ConfigChange Hook 审批或拒绝 |
| **异步预加载** | MDM 读取在模块加载时就启动，不阻塞后续流程 |

## 21.5 小结

- **五层配置源**：插件 → 用户 → 项目 → 本地 → 策略 → Flag，优先级递增
- **三级缓存**：会话级（合并结果）→ 来源级（独立结果）→ 文件级（解析结果）
- **容错校验**：Zod Schema + 权限规则预过滤，收集所有错误不中断
- **MDM 企业管控**：macOS plist / Windows 注册表 / Linux 文件，"First Source Wins"
- **Drop-in 目录**：systemd 风格的策略片段合并
- **实时变更检测**：chokidar 文件监听 + 稳定性检查 + 内部写入抑制 + Grace Period
- **Hook 审批**：ConfigChange Hook 可拦截并拒绝配置变更
