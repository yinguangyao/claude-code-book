# 《深入 Claude Code》开源电子书 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建基于 VitePress 的开源电子书项目，并完成 16 章源码解析内容，部署到 GitHub Pages。

**Architecture:** 使用 VitePress 作为静态站点生成器（Vue 生态、对中文友好、原生支持 sidebar/搜索/代码高亮），所有章节以 Markdown 编写，放在 `src/` 目录下按部分组织。源码引用来自 `/Users/bytedance/Desktop/project/claude-code-source-code/`。

**Tech Stack:** VitePress 1.x, Node.js, GitHub Pages, GitHub Actions (CI/CD)

---

## File Structure

```
claude-code-book/
├── package.json
├── .gitignore
├── src/
│   ├── index.md                          # 首页
│   ├── part1-overview/
│   │   ├── 01-introduction.md            # 第1章：走进 Claude Code
│   │   └── 02-startup-flow.md            # 第2章：启动流程
│   ├── part2-agent-loop/
│   │   ├── 03-system-prompt.md           # 第3章：System Prompt 动态构建
│   │   ├── 04-agent-loop.md              # 第4章：Agent Loop
│   │   └── 05-query-engine.md            # 第5章：QueryEngine
│   ├── part3-tool-system/
│   │   ├── 06-tool-interface.md          # 第6章：Tool 接口设计
│   │   ├── 07-tool-orchestration.md      # 第7章：工具编排与并发
│   │   └── 08-tool-implementations.md    # 第8章：关键工具实现
│   ├── part4-permissions/
│   │   ├── 09-permission-system.md       # 第9章：多层权限系统
│   │   └── 10-permission-modes.md        # 第10章：Permission Mode
│   ├── part5-extensions/
│   │   ├── 11-hooks.md                   # 第11章：Hook 系统
│   │   ├── 12-mcp.md                     # 第12章：MCP 集成
│   │   └── 13-skills-plugins.md          # 第13章：Skill 与 Plugin
│   ├── part6-advanced/
│   │   ├── 14-context-compaction.md      # 第14章：对话上下文与消息压缩
│   │   ├── 15-state-ui.md               # 第15章：状态管理与终端 UI
│   │   └── 16-multi-agent.md            # 第16章：多 Agent 协作
│   └── public/
│       └── images/                       # 架构图、流程图等静态资源
├── .vitepress/
│   └── config.mts                        # VitePress 配置（sidebar、nav、主题）
├── .github/
│   └── workflows/
│       └── deploy.yml                    # GitHub Pages 部署 Action
└── docs/
    ├── design/                           # 设计文档（已有）
    └── superpowers/plans/                # 实施计划（本文件）
```

---

### Task 1: 项目脚手架搭建

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.vitepress/config.mts`
- Create: `src/index.md`

- [ ] **Step 1: 初始化 package.json**

```json
{
  "name": "claude-code-book",
  "version": "1.0.0",
  "description": "深入 Claude Code：AI Agent 架构与源码解析",
  "scripts": {
    "dev": "vitepress dev src",
    "build": "vitepress build src",
    "preview": "vitepress preview src"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: 安装 VitePress**

Run: `cd /Users/bytedance/Desktop/project/claude-code-book && npm install -D vitepress`
Expected: `node_modules/` created, `package-lock.json` generated

- [ ] **Step 3: 创建 .gitignore**

```
node_modules/
.vitepress/cache/
.vitepress/dist/
.DS_Store
```

- [ ] **Step 4: 创建 VitePress 配置**

Create `.vitepress/config.mts`:

```typescript
import { defineConfig } from 'vitepress'

export default defineConfig({
  title: '深入 Claude Code',
  description: 'AI Agent 架构与源码解析',
  lang: 'zh-CN',
  srcDir: '../src',
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '开始阅读', link: '/part1-overview/01-introduction' }
    ],
    sidebar: [
      {
        text: '第一部分：全局视角',
        items: [
          { text: '第1章：走进 Claude Code', link: '/part1-overview/01-introduction' },
          { text: '第2章：启动流程', link: '/part1-overview/02-startup-flow' }
        ]
      },
      {
        text: '第二部分：Agent 核心循环',
        items: [
          { text: '第3章：System Prompt 的动态构建', link: '/part2-agent-loop/03-system-prompt' },
          { text: '第4章：Agent Loop', link: '/part2-agent-loop/04-agent-loop' },
          { text: '第5章：QueryEngine', link: '/part2-agent-loop/05-query-engine' }
        ]
      },
      {
        text: '第三部分：工具系统',
        items: [
          { text: '第6章：Tool 接口设计与注册机制', link: '/part3-tool-system/06-tool-interface' },
          { text: '第7章：工具编排与并发控制', link: '/part3-tool-system/07-tool-orchestration' },
          { text: '第8章：关键工具实现解析', link: '/part3-tool-system/08-tool-implementations' }
        ]
      },
      {
        text: '第四部分：权限与安全',
        items: [
          { text: '第9章：多层权限系统', link: '/part4-permissions/09-permission-system' },
          { text: '第10章：Permission Mode 与安全设计', link: '/part4-permissions/10-permission-modes' }
        ]
      },
      {
        text: '第五部分：扩展机制',
        items: [
          { text: '第11章：Hook 系统', link: '/part5-extensions/11-hooks' },
          { text: '第12章：MCP 集成', link: '/part5-extensions/12-mcp' },
          { text: '第13章：Skill 与 Plugin 系统', link: '/part5-extensions/13-skills-plugins' }
        ]
      },
      {
        text: '第六部分：上下文管理与高级特性',
        items: [
          { text: '第14章：对话上下文与消息压缩', link: '/part6-advanced/14-context-compaction' },
          { text: '第15章：状态管理与终端 UI', link: '/part6-advanced/15-state-ui' },
          { text: '第16章：多 Agent 协作与高级模式', link: '/part6-advanced/16-multi-agent' }
        ]
      }
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/yinguangyao/claude-code-book' }
    ],
    outline: {
      level: [2, 3],
      label: '本页目录'
    },
    search: {
      provider: 'local'
    }
  }
})
```

- [ ] **Step 5: 创建首页**

Create `src/index.md`:

```markdown
---
layout: home
hero:
  name: 深入 Claude Code
  text: AI Agent 架构与源码解析
  tagline: 带你逐模块走读工业级 AI Agent 的设计与实现
  actions:
    - theme: brand
      text: 开始阅读
      link: /part1-overview/01-introduction
    - theme: alt
      text: GitHub
      link: https://github.com/yinguangyao/claude-code-book
features:
  - title: 源码驱动
    details: 基于 Claude Code 真实源码，每章先讲概念再走读代码
  - title: 自底向上
    details: 从启动流程到 Agent Loop、工具系统、权限模型，逐层递进
  - title: 面向工程师
    details: 面向了解 Agent 概念的前端/全栈工程师，聚焦工程实现
---
```

- [ ] **Step 6: 验证 VitePress 启动**

Run: `cd /Users/bytedance/Desktop/project/claude-code-book && npm run dev`
Expected: 本地服务器启动，能看到首页和侧边栏导航

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore .vitepress/config.mts src/index.md
git commit -m "chore: init VitePress project scaffolding"
```

---

### Task 2: GitHub Actions 部署配置

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: 创建部署工作流**

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: src/.vitepress/dist

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    needs: build
    runs-on: ubuntu-latest
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: add GitHub Pages deployment workflow"
```

---

### Task 3: 第 1 章——走进 Claude Code

**Files:**
- Create: `src/part1-overview/01-introduction.md`

**源码参考：**
- `/Users/bytedance/Desktop/project/claude-code-source-code/package.json` — 项目元信息、依赖
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/` — 顶层目录结构

- [ ] **Step 1: 阅读源码，收集素材**

阅读以下文件，提取关键信息：
- `package.json`：版本号、依赖列表（@anthropic-ai/sdk、@modelcontextprotocol/sdk、ink、zod 等）
- `tsconfig.json`：编译配置
- `src/` 顶层：列出所有一级目录和顶层文件，理解模块划分

Run: `ls /Users/bytedance/Desktop/project/claude-code-source-code/src/`

- [ ] **Step 2: 撰写章节内容**

内容要点：
1. 开篇：Claude Code 是什么——不是一个聊天界面，而是一个运行在终端里、能读写文件、执行命令、管理 Git 的 AI Agent
2. 技术栈：TypeScript + React/Ink（终端 UI 框架）+ Node.js >= 18
3. 关键依赖解读：`@anthropic-ai/sdk`（LLM 调用）、`@modelcontextprotocol/sdk`（MCP）、`ink`（终端 React）、`zod`（Schema 校验）
4. 目录结构总览：用树形图展示 `src/` 下的一级目录，每个目录一句话说明职责
5. 全书路线图：用一张简化的架构图展示 16 章覆盖的模块，标注阅读顺序
6. 小结

- [ ] **Step 3: 验证页面渲染**

Run: `npm run dev`
Expected: 侧边栏第 1 章可点击，内容正确渲染，代码块语法高亮正常

- [ ] **Step 4: Commit**

```bash
git add src/part1-overview/01-introduction.md
git commit -m "docs: add chapter 1 - introduction to Claude Code"
```

---

### Task 4: 第 2 章——启动流程

**Files:**
- Create: `src/part1-overview/02-startup-flow.md`

**源码参考：**
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/entrypoints/cli.tsx`
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/entrypoints/init.ts`
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/main.tsx`

- [ ] **Step 1: 阅读源码，收集素材**

重点关注：
- `cli.tsx`：快速路径（`--version` 直接返回，不加载模块）、Commander.js 参数定义、不同模式的分发逻辑（daemon-worker、bridge、remote-control、mcp）
- `init.ts`：`init()` 函数的 memoized 模式、并行初始化（MTLS + proxy + keychain prefetch）、配置加载顺序
- `main.tsx`：完整启动序列——GrowthBook、工具注册、权限上下文、AppState、React/Ink 渲染

- [ ] **Step 2: 撰写章节内容**

内容要点：
1. 概念引入：为什么启动分三阶段？——性能。Agent 的启动要尽可能快，按需加载
2. 流程图：`cli.tsx` → `init.ts` → `main.tsx` 的调用链和各阶段职责
3. 源码走读 `cli.tsx`：展示快速路径代码、参数解析、模式分发的关键代码片段
4. 源码走读 `init.ts`：展示 memoized init、并行初始化的代码
5. 源码走读 `main.tsx`：展示从 getTools → createStore → render REPL 的关键流程
6. 设计分析：三阶段模式对启动时间的优化效果
7. 小结

- [ ] **Step 3: Commit**

```bash
git add src/part1-overview/02-startup-flow.md
git commit -m "docs: add chapter 2 - startup flow"
```

---

### Task 5: 第 3 章——System Prompt 的动态构建

**Files:**
- Create: `src/part2-agent-loop/03-system-prompt.md`

**源码参考：**
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/utils/context.ts`（如存在）
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/utils/messages.ts`
- System prompt 相关文件（需在 `src/` 中搜索 `systemPrompt`、`getSystemContext`、`getUserContext`）

- [ ] **Step 1: 阅读源码，收集素材**

搜索关键函数定位：
Run: `grep -r "getUserContext\|getSystemContext\|systemPrompt\|fetchSystemPrompt" /Users/bytedance/Desktop/project/claude-code-source-code/src/ --include="*.ts" --include="*.tsx" -l | head -20`

重点关注：
- System prompt 的组成部分有哪些
- 环境信息（OS、Shell、CWD）的采集方式
- Git 状态信息的获取
- Claude.md 文件的加载与注入
- 工具描述列表的动态生成
- memoized 缓存策略的实现

- [ ] **Step 2: 撰写章节内容**

内容要点：
1. 概念引入：Agent 的 System Prompt 不是一段固定文本，而是根据当前环境动态拼装的"上下文工程"
2. 架构图：展示 System Prompt 的组成结构——基础指令 + 环境上下文 + 工具描述 + 项目文档
3. 源码走读：逐个展示每类信息的采集和拼装代码
4. 设计分析：memoized 缓存——为什么要缓存？什么时候失效？
5. 上下文工程的实践启示
6. 小结

- [ ] **Step 3: Commit**

```bash
git add src/part2-agent-loop/03-system-prompt.md
git commit -m "docs: add chapter 3 - system prompt construction"
```

---

### Task 6: 第 4 章——Agent Loop（全书核心章节）

**Files:**
- Create: `src/part2-agent-loop/04-agent-loop.md`

**源码参考：**
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/query.ts`

- [ ] **Step 1: 阅读源码，收集素材**

这是全书最重要的源码文件。重点关注：
- `query()` async generator 函数的完整签名和参数
- 主循环结构：while 循环的条件和循环体
- 调用 Claude API 的方式（streaming）
- 响应解析：如何识别 tool_use blocks
- 工具执行的触发点（如何跳转到 toolOrchestration）
- 循环终止条件：stop_reason === 'end_turn'、turn limit、token budget、cost limit
- 错误处理：max_output_tokens 恢复、API 重试

- [ ] **Step 2: 撰写章节内容**

内容要点：
1. 概念引入：ReAct 模式的工业级实现——Reason（LLM 思考）→ Act（调用工具）→ Observe（观察结果）→ 循环
2. 流程图：一次完整对话的生命周期图
3. 源码走读：按执行顺序展示 `query()` 的关键代码段
   - 消息规范化（normalizeMessages）
   - 系统提示词构建
   - API 调用与流式响应
   - tool_use 检测与工具执行
   - 结果追加与循环继续
4. 为什么用 async generator：对比 Promise/callback/async-await 的局限性，说明 generator 如何实现流式进度产出
5. 终止条件与错误恢复的详细走读
6. 设计分析：这个循环如何做到既简洁又健壮
7. 小结

- [ ] **Step 3: Commit**

```bash
git add src/part2-agent-loop/04-agent-loop.md
git commit -m "docs: add chapter 4 - agent loop (core chapter)"
```

---

### Task 7: 第 5 章——QueryEngine

**Files:**
- Create: `src/part2-agent-loop/05-query-engine.md`

**源码参考：**
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/QueryEngine.ts`

- [ ] **Step 1: 阅读源码，收集素材**

重点关注：
- QueryEngine 类的构造函数参数和内部状态
- `submitMessage()` 的实现——如何封装 `query()` generator
- 事件流类型定义：RequestStartEvent、Message、StreamEvent、ToolUseSummaryMessage
- 会话状态管理：消息列表、文件缓存、usage 追踪
- REPL 模式 vs SDK 模式的分支点

- [ ] **Step 2: 撰写章节内容**

内容要点：
1. 概念引入：为什么需要 QueryEngine？——将 Agent Loop 封装为可编程 API
2. 类图：QueryEngine 的属性和方法
3. 源码走读：构造函数、submitMessage()、事件流设计
4. 两种使用模式对比：REPL 交互模式（main.tsx 创建）vs SDK 无头模式（外部 import）
5. 设计分析：如何用一套代码同时支持交互和编程两种场景
6. 小结

- [ ] **Step 3: Commit**

```bash
git add src/part2-agent-loop/05-query-engine.md
git commit -m "docs: add chapter 5 - QueryEngine"
```

---

### Task 8: 第 6 章——Tool 接口设计与注册机制

**Files:**
- Create: `src/part3-tool-system/06-tool-interface.md`

**源码参考：**
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/Tool.ts`
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/tools.ts`

- [ ] **Step 1: 阅读源码，收集素材**

重点关注：
- Tool 接口的完整类型定义
- Zod inputSchema 的使用方式
- execute 方法的 async generator 签名
- `getTools()` 函数：条件过滤逻辑（feature flag、user type）
- ToolContext 类型：appState、tools、commands、mcpClients 等字段

- [ ] **Step 2: 撰写章节内容**

内容要点：
1. 概念引入：Agent 的能力边界由工具定义，工具接口的设计决定了整个系统的扩展性
2. 接口图：Tool 接口的字段和方法
3. 源码走读：Tool 类型定义、Zod Schema 校验、execute generator
4. 工具注册走读：getTools() 的过滤逻辑、feature gate 机制
5. 工具分类总览：用表格展示 40+ 工具的分类和职责
6. 设计分析：为什么 execute 返回 AsyncGenerator 而不是 Promise
7. 小结

- [ ] **Step 3: Commit**

```bash
git add src/part3-tool-system/06-tool-interface.md
git commit -m "docs: add chapter 6 - tool interface and registration"
```

---

### Task 9: 第 7 章——工具编排与并发控制

**Files:**
- Create: `src/part3-tool-system/07-tool-orchestration.md`

**源码参考：**
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/services/tools/toolOrchestration.ts`
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/services/tools/toolExecution.ts`
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/services/tools/StreamingToolExecutor.ts`

- [ ] **Step 1: 阅读源码，收集素材**

重点关注：
- `runTools()` 函数：如何将多个 tool_use 分成并行批次和串行批次
- 并发控制：最多 10 个并发、isConcurrencySafe 判定
- StreamingToolExecutor：流式到达的 tool_use 如何边解析边执行
- ToolUseContext 的创建和传播
- runToolUse() 单个工具的执行流程：PreToolUse hook → 权限检查 → execute → PostToolUse hook

- [ ] **Step 2: 撰写章节内容**

内容要点：
1. 概念引入：LLM 一次可能返回多个工具调用，如何安全高效地并发执行？
2. 流程图：工具编排的分批策略——并行批 vs 串行批
3. 源码走读：runTools() 的分批逻辑、并发控制实现
4. 源码走读：StreamingToolExecutor 的流式调度
5. 源码走读：runToolUse() 单个工具的完整生命周期（含 hook）
6. 设计分析：读写分离的并发策略——简单有效
7. 小结

- [ ] **Step 3: Commit**

```bash
git add src/part3-tool-system/07-tool-orchestration.md
git commit -m "docs: add chapter 7 - tool orchestration and concurrency"
```

---

### Task 10: 第 8 章——关键工具实现解析

**Files:**
- Create: `src/part3-tool-system/08-tool-implementations.md`

**源码参考：**
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/tools/BashTool/`
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/tools/FileEditTool/`
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/tools/FileReadTool/`
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/tools/FileWriteTool/`
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/tools/AgentTool/`
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/tools/GlobTool/`
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/tools/GrepTool/`

- [ ] **Step 1: 阅读源码，收集素材**

每个工具重点关注：inputSchema 定义、execute 实现、错误处理、安全边界

- [ ] **Step 2: 撰写章节内容**

内容要点：
1. 概念引入：工具是 Agent 与外部世界交互的"手脚"，每个工具的设计都有其 trade-off
2. BashTool：命令执行（child_process）、超时控制、输出截断（避免 context 爆炸）、安全边界（哪些命令不能执行）
3. 文件三件套：FileRead（读取 + 行号）、FileEdit（精确替换 vs 全文重写）、FileWrite（创建新文件），为什么拆成三个而不是一个？——职责单一、LLM 更容易正确使用
4. AgentTool：如何生成子 Agent——创建独立 QueryEngine、过滤工具列表（子 Agent 不能再嵌套 Agent）、隔离上下文
5. Glob / Grep：封装 fast-glob / ripgrep 实现高性能搜索
6. 设计分析：每个工具的 description 如何引导 LLM 正确使用
7. 小结

- [ ] **Step 3: Commit**

```bash
git add src/part3-tool-system/08-tool-implementations.md
git commit -m "docs: add chapter 8 - key tool implementations"
```

---

### Task 11: 第 9 章——多层权限系统

**Files:**
- Create: `src/part4-permissions/09-permission-system.md`

**源码参考：**
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/hooks/useCanUseTool.tsx`
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/utils/permissions/`

- [ ] **Step 1: 阅读源码，收集素材**

重点关注：
- `canUseTool()` / `hasPermissionsToUseTool()` 的完整逻辑
- 权限规则类型定义：PermissionRule、PermissionDecision
- 规则来源与优先级
- 拒绝追踪（denialTracking）的实现

- [ ] **Step 2: 撰写章节内容**

内容要点：
1. 概念引入：Agent 不同于普通程序——它能自主决策执行什么操作，因此必须有权限边界
2. 架构图：四层权限架构的层级关系
3. 源码走读：canUseTool() 决策流程，从配置规则到分类器到交互审批到兜底拒绝
4. 源码走读：权限规则的解析——`BashTool(command=rm)` 格式如何匹配
5. 源码走读：拒绝追踪的实现
6. 设计分析：多来源规则合并的优先级策略
7. 小结

- [ ] **Step 3: Commit**

```bash
git add src/part4-permissions/09-permission-system.md
git commit -m "docs: add chapter 9 - multi-layer permission system"
```

---

### Task 12: 第 10 章——Permission Mode 与安全设计哲学

**Files:**
- Create: `src/part4-permissions/10-permission-modes.md`

**源码参考：**
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/tools/EnterPlanModeTool/`
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/utils/permissions/`（autoModeState 相关）

- [ ] **Step 1: 阅读源码，收集素材**

重点关注：
- Permission Mode 枚举定义和切换逻辑
- Plan Mode 的实现：EnterPlanModeTool / ExitPlanModeTool
- 推测执行（Speculation）的状态管理和触发条件
- auto mode 的分类器逻辑（如果可访问）

- [ ] **Step 2: 撰写章节内容**

内容要点：
1. 概念引入：不同场景需要不同的权限粒度——从"每步确认"到"全自动"
2. 五种模式对比表：适用场景、安全等级、用户体验
3. 源码走读：Plan Mode 的实现——进入/退出、操作列表展示
4. 源码走读：推测执行——在等待审批时提前执行，审批通过直接返回
5. 设计分析：安全性与效率的平衡，Agent 安全的通用原则
6. 小结

- [ ] **Step 3: Commit**

```bash
git add src/part4-permissions/10-permission-modes.md
git commit -m "docs: add chapter 10 - permission modes and security philosophy"
```

---

### Task 13: 第 11 章——Hook 系统

**Files:**
- Create: `src/part5-extensions/11-hooks.md`

**源码参考：**
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/utils/hooks/`
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/types/hooks.ts`

- [ ] **Step 1: 阅读源码，收集素材**

重点关注：
- Hook 事件类型定义（HookEvent 枚举或联合类型）
- 三种执行方式的代码路径
- Hook 响应的类型定义和处理逻辑
- `execAgentHook()` 的实现——如何创建隔离 QueryEngine

- [ ] **Step 2: 撰写章节内容**

内容要点：
1. 概念引入：Hook = 生命周期事件 + 自定义处理器，类似 Git hooks 或 Webpack plugins
2. 事件流程图：展示 Hook 在 Agent 循环中的触发点
3. 源码走读：三种 Hook 执行方式的代码
4. 源码走读：Hook 响应协议——如何阻止、修改、扩展默认行为
5. 实际场景示例：PreToolUse hook 做代码风格校验
6. 小结

- [ ] **Step 3: Commit**

```bash
git add src/part5-extensions/11-hooks.md
git commit -m "docs: add chapter 11 - hooks system"
```

---

### Task 14: 第 12 章——MCP 集成

**Files:**
- Create: `src/part5-extensions/12-mcp.md`

**源码参考：**
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/services/mcp/client.ts`
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/services/mcp/types.ts`
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/tools/MCPTool/`

- [ ] **Step 1: 阅读源码，收集素材**

重点关注：
- MCPServerConnection 类：构造函数、connect()、传输协议选择
- 工具发现：list_tools() 调用和 MCPTool 包装
- 工具执行：call_tool() 调用和结果处理
- 认证流程：OAuth2、Elicitation 处理

- [ ] **Step 2: 撰写章节内容**

内容要点：
1. 概念引入：MCP 是什么——让 Agent 接入任意外部工具的标准协议
2. 架构图：Claude Code ↔ MCP Server 的通信架构
3. 源码走读：MCPServerConnection 的四种传输协议实现
4. 源码走读：工具生命周期——配置 → 连接 → 发现 → 调用 → 认证
5. 源码走读：MCPTool 如何将 MCP 工具包装成内部 Tool 接口
6. 设计分析：MCP 对 Agent 生态的意义——从封闭到开放
7. 小结

- [ ] **Step 3: Commit**

```bash
git add src/part5-extensions/12-mcp.md
git commit -m "docs: add chapter 12 - MCP integration"
```

---

### Task 15: 第 13 章——Skill 与 Plugin 系统

**Files:**
- Create: `src/part5-extensions/13-skills-plugins.md`

**源码参考：**
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/skills/`
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/plugins/`
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/commands.ts`

- [ ] **Step 1: 阅读源码，收集素材**

重点关注：
- Skill 的类型定义和注册流程
- SkillTool 的 execute 实现
- Plugin manifest 结构
- commands.ts 中 Skill 与 Command 的关系

- [ ] **Step 2: 撰写章节内容**

内容要点：
1. 概念引入：三种扩展机制的定位——Hook（事件拦截）、Skill（预置能力）、Plugin（第三方包）
2. 对比表：Hook vs Skill vs Plugin 的使用场景、能力边界、开发方式
3. 源码走读：Skill 注册和调用流程
4. 源码走读：Plugin manifest 和生命周期
5. 设计分析：三层扩展体系的组合设计
6. 小结

- [ ] **Step 3: Commit**

```bash
git add src/part5-extensions/13-skills-plugins.md
git commit -m "docs: add chapter 13 - skills and plugins"
```

---

### Task 16: 第 14 章——对话上下文与消息压缩

**Files:**
- Create: `src/part6-advanced/14-context-compaction.md`

**源码参考：**
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/services/compact/`
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/types/message.ts`

- [ ] **Step 1: 阅读源码，收集素材**

重点关注：
- 消息类型联合类型定义
- compact 服务的三种策略实现
- 触发条件：~70% context window、预测超长、手动 snip
- 压缩结果的消息替换逻辑

- [ ] **Step 2: 撰写章节内容**

内容要点：
1. 概念引入：Agent 对话的核心矛盾——上下文越长越有价值，但窗口有限
2. 消息类型图：展示各种消息类型及其在对话中的位置
3. 源码走读：三种压缩策略的触发条件和实现
4. 源码走读：压缩过程——如何将历史消息总结为摘要
5. 设计分析：压缩的信息损失与质量权衡
6. 小结

- [ ] **Step 3: Commit**

```bash
git add src/part6-advanced/14-context-compaction.md
git commit -m "docs: add chapter 14 - context management and compaction"
```

---

### Task 17: 第 15 章——状态管理与终端 UI

**Files:**
- Create: `src/part6-advanced/15-state-ui.md`

**源码参考：**
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/state/AppStateStore.ts`
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/components/`（REPL 相关）

- [ ] **Step 1: 阅读源码，收集素材**

重点关注：
- AppStateStore 的状态结构和更新机制
- Zustand 风格的响应式订阅
- React/Ink 组件结构
- REPL 组件的渲染循环

- [ ] **Step 2: 撰写章节内容**

内容要点：
1. 概念引入：用 React 渲染终端？——Ink 让终端 UI 也能组件化
2. 状态图：AppStateStore 的核心状态字段
3. 源码走读：Store 的创建、更新、订阅机制
4. 源码走读：REPL 组件——从用户输入到 Agent 响应的 UI 流程
5. 源码走读：流式渲染——generator 事件如何驱动 React 更新
6. 设计分析：终端 UI 框架的选型思考
7. 小结

- [ ] **Step 3: Commit**

```bash
git add src/part6-advanced/15-state-ui.md
git commit -m "docs: add chapter 15 - state management and terminal UI"
```

---

### Task 18: 第 16 章——多 Agent 协作与高级模式

**Files:**
- Create: `src/part6-advanced/16-multi-agent.md`

**源码参考：**
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/coordinator/`
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/tools/AgentTool/`
- `/Users/bytedance/Desktop/project/claude-code-source-code/src/tools/EnterWorktreeTool/`

- [ ] **Step 1: 阅读源码，收集素材**

重点关注：
- Coordinator 的 Leader/Worker 模式实现
- 任务分配和结果汇总机制
- Worktree 隔离的 Git 操作
- Daemon Mode 的进程管理

- [ ] **Step 2: 撰写章节内容**

内容要点：
1. 概念引入：单 Agent 的能力有限，多 Agent 协作是 Agent 系统的进化方向
2. 架构图：Coordinator Mode 的 Leader + Worker 架构
3. 源码走读：任务分配、Worker 创建、结果汇总
4. 源码走读：Worktree 隔离——每个 Worker 一个 Git worktree，避免文件冲突
5. 源码走读：Daemon Mode 的后台进程管理
6. 设计分析：多 Agent 协作的核心挑战和解决思路
7. 全书总结：从 Claude Code 源码中学到的 Agent 设计原则
8. 小结

- [ ] **Step 3: Commit**

```bash
git add src/part6-advanced/16-multi-agent.md
git commit -m "docs: add chapter 16 - multi-agent collaboration"
```

---

## Self-Review Checklist

- [x] **Spec coverage:** 16 章全部有对应 Task（Task 3-18），基础设施有 Task 1-2，无遗漏
- [x] **Placeholder scan:** 所有 Task 都有具体的源码参考文件、内容要点，无 TBD/TODO
- [x] **Type consistency:** 文件路径在 File Structure 和各 Task 中一致，章节编号连续
- [x] **每章结构一致:** 概念引入 → 架构图/流程图 → 源码走读 → 设计分析 → 小结
