# 第 15 章　状态管理与终端 UI

> "终端不是 Web，但 React 可以。"

当我第一次看到 Claude Code 的源码时，最让我惊讶的一件事不是它的 AI 能力，而是它的 UI 架构选择：**用 React 渲染终端界面**。这在工程上并不是"理所当然"的决定——它背后有着清晰的权衡取舍，以及一套自洽的状态管理体系。

![状态管理与终端 UI](/images/ch15-state-ui.png)

本章将完整走读 Claude Code 的状态管理机制与终端 UI 架构，从最底层的 `Store` 原语一路向上，直到 `REPL` 组件如何把用户输入、流式响应、权限弹窗编织在一起实时呈现。

---

## 15.1　为什么用 React 渲染终端

### 传统终端 UI 的痛点

传统的命令行程序通过直接写 `stdout` 来绘制 UI：打印字符、用 ANSI 转义码控制颜色和光标位置。这种方式对于简单输出没有问题，但一旦界面变得复杂——多个区域同时更新、动态进度条、嵌套的权限弹窗——代码就会变成难以维护的面条式命令序列。

Claude Code 面临的 UI 复杂度远超普通 CLI 工具：

- **流式渲染**：模型输出逐 token 到达，需要实时拼接并展示；
- **并发状态**：同时有 spinner、消息列表、权限提示、进度条等多个区域在独立更新；
- **条件渲染**：根据权限模式、是否有 tool use、是否在 transcript 模式等条件显示不同 UI；
- **响应式布局**：终端窗口大小变化时需要重新计算布局。

### Ink：把 React 带进终端

[Ink](https://github.com/vadimdemedes/ink) 是一个把 React 渲染到终端的库。它用 Yoga 布局引擎（React Native 同款）做 flexbox 布局计算，再把虚拟 DOM 的变更差量地写进 `stdout`——只更新发生变化的那些格子，而不是每次重绘整屏。

这意味着 Claude Code 的工程师可以：

- 用 `<Box flexDirection="column">` 来垂直排列组件；
- 用 `<Text color="green">` 来着色文字；
- 用 React hooks 来管理局部状态，用 Context 来共享全局数据；
- 把"界面是状态的函数"这一声明式理念直接用在终端 UI 上。

声明式的好处在这里得到了充分体现：工程师只需描述"当 `isLoading` 为 `true` 时，显示 spinner；当 `messages` 数组增长时，在列表末尾追加新行"，而不用手动管理光标移动和局部重绘。

---

## 15.2　中心化状态：自制 Store

### Store 原语

Claude Code 并没有直接使用 Zustand 或 Redux，而是在 [`src/state/store.ts`](/src/state/store.ts) 中手写了一个极简的响应式 Store：

```typescript
// src/state/store.ts
export type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}

export function createStore<T>(
  initialState: T,
  onChange?: OnChange<T>,
): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()

  return {
    getState: () => state,

    setState: (updater) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return   // 引用不变则跳过
      state = next
      onChange?.({ newState: next, oldState: prev })
      for (const listener of listeners) listener()
    },

    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
```

这个 Store 只有三个方法，但设计上有几个关键点：

1. **函数式更新**：`setState` 接收一个 `(prev: T) => T` 的函数，保证更新是基于最新状态的，避免并发更新时的竞态；
2. **引用相等检测**：`Object.is(next, prev)` 用来做"快速路径"——如果更新函数返回了相同引用，就什么都不做，避免不必要的渲染；
3. **变更钩子**：`onChange` 回调在每次状态变化后同步触发，这是整个状态副作用系统的基础（后面会讲）。

### AppState：一个 TypeScript 宇宙

[`src/state/AppStateStore.ts`](/src/state/AppStateStore.ts) 定义了 `AppState`——这是整个应用的全局状态类型，行数超过 400 行，包含了从用户设置、MCP 连接、任务列表，到 tmux 面板、远程会话 URL、权限模式等几乎所有运行时信息。

以下是几个有代表性的字段：

```typescript
export type AppState = DeepImmutable<{
  settings: SettingsJson          // 从 .claude/settings.json 加载的配置
  verbose: boolean                // 是否显示详细日志
  mainLoopModel: ModelSetting     // 当前使用的模型
  statusLineText: string | undefined  // 底部状态栏文字
  expandedView: 'none' | 'tasks' | 'teammates'  // 扩展视图模式
  toolPermissionContext: ToolPermissionContext  // 工具权限上下文
  spinnerTip?: string             // spinner 旁边的提示文字
  speculation: SpeculationState   // 投机执行状态
  initialMessage: { ... } | null  // 待处理的初始消息
  // ...还有大量其他字段
}> & {
  tasks: { [taskId: string]: TaskState }  // 所有 Agent 任务
  mcp: { clients, tools, commands, resources }  // MCP 连接状态
  notifications: { current, queue }  // 通知队列
  // ...
}
```

`DeepImmutable<T>` 是一个工具类型，它递归地把对象的所有属性标记为 `readonly`，从编译器层面阻止意外的直接 mutation（所有变更必须通过 `setState`）。

### AppStateProvider：Context 注入

[`src/state/AppState.tsx`](/src/state/AppState.tsx) 把 Store 包装成 React Context，注入到整个组件树：

```typescript
export const AppStoreContext = React.createContext<AppStateStore | null>(null)

export function AppStateProvider({ children, initialState, onChangeAppState }) {
  const [store] = useState(
    () => createStore(initialState ?? getDefaultAppState(), onChangeAppState)
  )
  return (
    <HasAppStateContext.Provider value={true}>
      <AppStoreContext.Provider value={store}>
        <MailboxProvider>
          <VoiceProvider>
            {children}
          </VoiceProvider>
        </MailboxProvider>
      </AppStoreContext.Provider>
    </HasAppStateContext.Provider>
  )
}
```

注意 `HasAppStateContext` 这个哨兵 Context——它的存在是为了在 `AppStateProvider` 嵌套时抛出错误，防止开发者意外创建多个状态树。

### useAppState：精准订阅

组件通过 `useAppState` 这个自定义 hook 来订阅状态切片：

```typescript
export function useAppState(selector) {
  const store = useAppStore()
  const get = () => {
    const state = store.getState()
    return selector(state)
  }
  return useSyncExternalStore(store.subscribe, get, get)
}
```

这里使用了 React 18 的 `useSyncExternalStore`，它能正确处理并发渲染下的撕裂问题（tearing）。**关键在于 selector**：组件只需要订阅它实际使用的那个字段，状态的其他部分变化时不会触发重渲染。

在 REPL 组件中，这种精准订阅被广泛使用：

```typescript
// src/screens/REPL.tsx
const toolPermissionContext = useAppState(s => s.toolPermissionContext)
const verbose = useAppState(s => s.verbose)
const spinnerTip = useAppState(s => s.spinnerTip)
const tasks = useAppState(s => s.tasks)
const setAppState = useSetAppState()  // 只取 setter，不订阅任何字段
```

`useSetAppState` 返回稳定的 `store.setState` 引用，调用它的组件不会因为任何状态变化而重渲染——这是性能优化的关键模式。

### onChangeAppState：状态变更的副作用

[`src/state/onChangeAppState.ts`](/src/state/onChangeAppState.ts) 是 Store 的 `onChange` 回调，它是一个集中化的副作用处理点。每当 `AppState` 发生变化，这个函数都会被同步调用，负责把状态变化同步到外部系统：

```typescript
export function onChangeAppState({ newState, oldState }) {
  // 权限模式变化 → 通知 CCR（Claude.ai Remote）和 SDK
  const prevMode = oldState.toolPermissionContext.mode
  const newMode = newState.toolPermissionContext.mode
  if (prevMode !== newMode) {
    notifySessionMetadataChanged({ permission_mode: newExternal })
    notifyPermissionModeChanged(newMode)
  }

  // 模型变化 → 持久化到 settings.json
  if (newState.mainLoopModel !== oldState.mainLoopModel) {
    updateSettingsForSource('userSettings', { model: newState.mainLoopModel })
    setMainLoopModelOverride(newState.mainLoopModel)
  }

  // expandedView 变化 → 持久化到全局配置
  if (newState.expandedView !== oldState.expandedView) {
    saveGlobalConfig(current => ({ ...current, showExpandedTodos: ... }))
  }

  // settings 变化 → 清除认证缓存
  if (newState.settings !== oldState.settings) {
    clearApiKeyHelperCache()
    clearAwsCredentialsCache()
  }
}
```

这个设计把所有的"状态 → 副作用"逻辑收拢在一个地方，任何改变状态的路径（无论是 UI 操作、命令解析还是远程事件）都会自动触发同步，不需要各个调用点手动维护。

---

## 15.3　组件结构：从顶层到叶节点

### App：最顶层的容器

[`src/components/App.tsx`](/src/components/App.tsx) 是 React 树的根节点，只做三件事：提供 FPS 指标 Context、Stats Context 和 AppState Context：

```typescript
export function App({ getFpsMetrics, stats, initialState, children }) {
  return (
    <FpsMetricsProvider getFpsMetrics={getFpsMetrics}>
      <StatsProvider store={stats}>
        <AppStateProvider
          initialState={initialState}
          onChangeAppState={onChangeAppState}
        >
          {children}
        </AppStateProvider>
      </StatsProvider>
    </FpsMetricsProvider>
  )
}
```

`children` 通常就是 `REPL` 组件。

### REPL：核心协调器

[`src/screens/REPL.tsx`](/src/screens/REPL.tsx) 是整个应用最重的组件，代码超过 3000 行。它扮演的角色是**协调器（Coordinator）**：

- 管理 `messages` 数组（对话历史）；
- 管理 `isLoading` 状态（是否有查询在飞）；
- 管理各类弹窗队列（权限确认、费用提示、空闲提示...）；
- 把 `query()` 生成器产出的事件流翻译成 `setMessages` 调用；
- 把用户输入路由到正确的处理函数。

REPL 本身不是一个"叶节点"——它渲染的主要内容是 `Messages`、`PromptInput`、`SpinnerWithVerb` 等子组件，自身更多承担状态聚合和逻辑分发的职责。

### Messages：消息列表的渲染

[`src/components/Messages.tsx`](/src/components/Messages.tsx) 负责渲染对话历史。它接收 `messages` 数组，经过一系列折叠和规范化处理后，把每条消息交给 `MessageRow` 组件渲染。

这里有一个值得注意的性能优化：

```typescript
// Messages.tsx
const LogoHeader = React.memo(function LogoHeader({ agentDefinitions }) {
  // Logo 和状态通知区域被 memo 化
  // 任何 messages 变化都不会导致 Logo 重渲染
})
```

Logo 区域单独 memo 化，因为它是消息列表的第一个兄弟节点。Ink 的渲染引擎（`renderChildren`）有一个优化：一旦遇到"脏"节点，后续所有兄弟节点都会退出 blit（位图复用）模式，重新全量绘制。如果 Logo 每次都脏，那么哪怕有 2800 条消息，每次新消息到达都会触发 150K+ 次写操作，把 CPU 跑满。

### PromptInput：输入区域

[`src/components/PromptInput/PromptInput.tsx`](/src/components/PromptInput/PromptInput.tsx) 是用户输入区域的主组件，它管理：

- 输入框文字和光标位置；
- 历史记录导航（方向键）；
- 命令自动补全；
- 粘贴内容处理（图片、长文本的引用化）；
- Vim 模式支持；
- 投机预测（speculation）的接受/拒绝。

它通过 `useAppState` 读取全局状态（如权限模式、任务列表），通过 `useSetAppState` 写回状态，并通过 props 接收来自 REPL 的回调函数（如 `onSubmit`）。

### Spinner：进度指示

[`src/components/Spinner.tsx`](/src/components/Spinner.tsx) 是查询进行时的进度指示组件。它的有趣之处在于**时间计算方式**：

```typescript
type Props = {
  loadingStartTimeRef: React.RefObject<number>
  totalPausedMsRef: React.RefObject<number>
  pauseStartTimeRef: React.RefObject<number | null>
  // ...
}
```

REPL 传给 Spinner 的不是一个 `elapsedMs` 状态值，而是几个 **`ref`**。Spinner 在每个动画帧（`useAnimationFrame`）中自行读取这些 ref 计算已用时间。这样做的好处是：计时更新不会触发 REPL 的重渲染，动画完全在 Spinner 内部闭合，把"热路径"的渲染范围压到最小。

---

## 15.4　REPL 组件：输入到渲染的完整链路

### 状态初始化

REPL 在挂载时通过 `useAppState` 订阅所需的全局状态切片，同时维护大量本地状态：

```typescript
// 全局状态订阅
const toolPermissionContext = useAppState(s => s.toolPermissionContext)
const tasks = useAppState(s => s.tasks)
const setAppState = useSetAppState()

// 本地状态
const [messages, rawSetMessages] = useState<MessageType[]>(initialMessages ?? [])
const messagesRef = useRef(messages)  // 同步 ref，供非渲染路径读取
const [screen, setScreen] = useState<Screen>('prompt')
const [inputValue, setInputValueRaw] = useState(() => consumeEarlyInput())
```

`messagesRef` 是一个重要的工程模式：React 的状态更新是异步批处理的，但某些回调（如 `handleSpeculationAccept`）在提交 `setMessages` 后立即需要读取最新的消息列表。通过在 `setMessages` 的包装函数里同步更新 `messagesRef`，可以让这类代码绕过 React 的异步批处理，直接读到最新数据：

```typescript
const setMessages = useCallback((action: React.SetStateAction<MessageType[]>) => {
  const prev = messagesRef.current
  const next = typeof action === 'function' ? action(messagesRef.current) : action
  messagesRef.current = next  // 同步更新 ref
  rawSetMessages(next)        // 异步通知 React
}, [])
```

注释里称之为"Zustand 模式"：ref 是事实来源，React state 是渲染的投影。

### 查询生命周期

用户提交输入后，REPL 通过 `QueryGuard` 来管理查询状态：

```typescript
const queryGuard = React.useRef(new QueryGuard()).current
const isQueryActive = React.useSyncExternalStore(
  queryGuard.subscribe,
  queryGuard.getSnapshot
)
```

`QueryGuard` 是一个外部 store，负责追踪"是否有本地查询在进行"。它通过 `reserve()`/`tryStart()`/`end()` 来控制查询的生命周期，防止并发提交。

真正的查询发生在 `onQueryImpl` 这个 `useCallback` 里：

```typescript
const onQueryImpl = useCallback(async (
  messagesIncludingNewMessages,
  newMessages,
  abortController,
  shouldQuery,
  // ...
) => {
  // 1. 准备系统提示词和用户上下文
  const [defaultSystemPrompt, userContext, systemContext] = await Promise.all([
    getSystemPrompt(freshTools, mainLoopModel, ...),
    getUserContext(),
    getSystemContext(),
  ])

  // 2. 调用 query() 生成器，迭代产出的事件
  for await (const event of query({
    messages: messagesIncludingNewMessages,
    systemPrompt,
    userContext,
    toolUseContext,
    // ...
  })) {
    // 3. 把每个事件翻译成 UI 状态更新
    handleMessageFromStream(event, ...)
  }
}, [...])
```

`query()` 是一个 `async generator`（定义在 [`src/query.ts`](/src/query.ts)），它产出三类内容：

- `StreamEvent`：流式文本 token 或工具调用的增量；
- `Message`：一条完整的消息（用户消息、助手消息、进度消息）；
- `RequestStartEvent`：新一轮 API 请求开始的信号。

### 流式消息处理

`handleMessageFromStream` 是把生成器输出映射到 UI 的核心函数。以进度消息为例，有一个特别值得关注的优化：

```typescript
// src/screens/REPL.tsx
} else if (
  newMessage.type === 'progress' &&
  isEphemeralToolProgress(newMessage.data.type)
) {
  // 临时进度 tick（如 BashTool 每秒一次的心跳）
  // 不追加，而是替换最后一条同类消息
  setMessages(oldMessages => {
    const last = oldMessages.at(-1)
    if (
      last?.type === 'progress' &&
      last.parentToolUseID === newMessage.parentToolUseID &&
      last.data.type === newMessage.data.type
    ) {
      const copy = oldMessages.slice()
      copy[copy.length - 1] = newMessage
      return copy
    }
    return [...oldMessages, newMessage]
  })
} else {
  setMessages(oldMessages => [...oldMessages, newMessage])
}
```

BashTool 在执行长命令时每秒发出一次进度 tick。如果每次都追加，一个跑了 10 分钟的命令会产生 600 条进度消息，占用大量内存并导致渲染卡顿。替换策略把数组长度稳定在常数，同时 UI 依然能实时更新。

### useDeferredValue：保持输入响应

即使有了上述优化，当 `messages` 数组很大时，每次新增消息触发的 `Messages` 组件重渲染依然可能阻塞输入。REPL 用 React 18 的 `useDeferredValue` 来解决这个问题：

```typescript
const deferredMessages = useDeferredValue(messages)
```

`useDeferredValue` 告诉 React："这个值的更新可以等一等，如果有更高优先级的任务（比如响应用户按键），先去做那个"。结果是：`Messages` 组件消费 `deferredMessages`，在繁重渲染时它允许轻微滞后；而 `PromptInput` 消费同步的 `inputValue`，始终即时响应。

---

## 15.5　流式渲染：从 Generator 到像素

整个流式渲染的数据流可以描述为一条管道：

```
用户按 Enter
    ↓
onSubmit (PromptInput) → handlePromptSubmit
    ↓
executeUserInput → processUserInput
    ↓
query() [async generator]
    ├── yield RequestStartEvent
    ├── yield StreamEvent (text delta)
    ├── yield StreamEvent (tool_use delta)
    ├── yield Message (完整的助手消息)
    └── yield Message (工具结果)
    ↓
for await → handleMessageFromStream
    ↓
setMessages(prev => [...prev, newMessage])
    ↓
messagesRef.current 同步更新
rawSetMessages 触发 React 调度
    ↓
deferredMessages 在过渡优先级下更新
    ↓
Messages 组件重渲染 → MessageRow → Ink 差量绘制
```

这条管道的每一步都有精心的背压（backpressure）控制：

- `QueryGuard` 防止用户在查询进行中重复提交；
- 临时进度消息用"替换"代替"追加"；
- `useDeferredValue` 让渲染让路给输入响应；
- Ink 只差量更新发生变化的终端格子。

---

## 15.6　弹窗与对话框的协调

REPL 里有一个 `getFocusedInputDialog` 函数，负责决定当前应该聚焦哪个弹窗（如果有的话）：

```typescript
function getFocusedInputDialog() {
  if (isExiting || exitFlow) return undefined
  if (isMessageSelectorVisible) return 'message-selector'
  if (isPromptInputActive) return undefined  // 用户正在输入，不打扰
  if (sandboxPermissionRequestQueue[0]) return 'sandbox-permission'
  if (allowDialogsWithAnimation && toolUseConfirmQueue[0]) return 'tool-permission'
  if (allowDialogsWithAnimation && promptQueue[0]) return 'prompt'
  if (allowDialogsWithAnimation && showingCostDialog) return 'cost'
  // ... 更多优先级更低的弹窗
  return undefined
}
```

这是一个纯函数式的优先级队列，每次渲染重新计算。它不用任何额外的状态来追踪"哪个弹窗该显示"，而是直接从各个队列的实际内容推导出来。弹窗内容渲染在 `PromptInput` 的"焦点占用"位置，同一时刻只有一个弹窗能拿到键盘输入的控制权。

有一个细节值得一提：当 `isPromptInputActive`（用户正在输入）时，弹窗即使有内容也不会弹出来。这是为了防止用户打字到一半，一个权限弹窗突然出现，下一个按键意外地回答了弹窗而不是继续输入。

---

## 15.7　小结：终端 UI 的 React 化

回顾本章走读的内容，Claude Code 的状态管理与 UI 架构体现了几个设计原则：

**单一数据流**：所有状态变更经过 `store.setState`，副作用统一在 `onChangeAppState` 中处理，没有散落在各处的 `saveConfig` 和 `notify` 调用。

**精准订阅**：`useAppState(selector)` + `useSyncExternalStore` 确保组件只在真正关心的状态切片变化时重渲染，避免全局状态更新导致的瀑布式重渲染。

**Ref 作为同步逃生舱**：当 React 的异步批处理成为障碍（如回调需要立即读取最新消息），用 Ref 作为同步的事实来源，React state 降格为渲染的投影。

**分层背压**：从 `QueryGuard`、消息替换、`useDeferredValue` 到 Ink 的差量绘制，在各层为繁重计算设置了缓冲，保持 UI 的响应性。

**声明式优先级**：弹窗焦点用纯函数计算，不引入额外状态；权限模式同步用 diff 触发，不要求调用点手动通知。

这套架构的代价是 `REPL.tsx` 本身的复杂度——3000+ 行的组件是难以绕过的现实。但它的复杂度是集中的、有组织的，而不是散落在各处的。对于一个要在终端里实现"AI 编程助手"级别体验的工具来说，这是合理的权衡。

---

在第 16 章，我们将把目光转向 Claude Code 的**工具系统与权限模型**——当模型决定调用 `BashTool`、`FileEditTool` 或 `AgentTool` 时，背后的权限检查、用户确认和工具执行流程是如何设计的。这是 Claude Code 安全边界的核心所在。
