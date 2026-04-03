# 深入 Claude Code：AI Agent 架构与源码解析

> 带你逐模块走读工业级 AI Agent 的设计与实现

基于 Claude Code v2.1.88 真实源码，从启动流程到 Agent Loop、工具系统、权限模型，沿执行路径逐层递进，面向了解 Agent 概念的前端/全栈工程师，聚焦工程实现而非理论。

## 目录

### 第一部分：全局视角

- [第 1 章：走进 Claude Code](src/part1-overview/01-introduction.md) — 技术栈、目录结构与架构全景
- [第 2 章：启动流程](src/part1-overview/02-startup-flow.md) — 三阶段渐进式加载

### 第二部分：Agent 核心循环

- [第 3 章：System Prompt 的动态构建](src/part2-agent-loop/03-system-prompt.md) — 静态/动态分区与缓存策略
- [第 4 章：Agent Loop](src/part2-agent-loop/04-agent-loop.md) — 调用模型 → 解析响应 → 执行工具 → 回传结果
- [第 5 章：QueryEngine](src/part2-agent-loop/05-query-engine.md) — SDK/Headless 模式下的会话管理

### 第三部分：工具系统

- [第 6 章：Tool 接口设计与注册机制](src/part3-tool-system/06-tool-interface.md) — 泛型接口、Zod Schema 与 Feature Gate
- [第 7 章：工具编排与并发控制](src/part3-tool-system/07-tool-orchestration.md) — 读并行写串行的分区策略
- [第 8 章：关键工具实现解析](src/part3-tool-system/08-tool-implementations.md) — Bash、文件操作三件套、Agent 工具

### 第四部分：权限与安全

- [第 9 章：多层权限系统](src/part4-permissions/09-permission-system.md) — 四层架构与 deny > ask > allow 优先级
- [第 10 章：Permission Mode 与安全设计](src/part4-permissions/10-permission-modes.md) — 五种模式、Plan Mode、推测执行

### 第五部分：扩展机制

- [第 11 章：Hook 系统](src/part5-extensions/11-hooks.md) — 28 种事件、四种执行器、事件驱动的控制面
- [第 12 章：MCP 集成](src/part5-extensions/12-mcp.md) — 五种传输、工具生命周期、OAuth2 全流程
- [第 13 章：Skill 与 Plugin 系统](src/part5-extensions/13-skills-plugins.md) — 技能发现、插件安装与管理

### 第六部分：上下文管理与高级特性

- [第 14 章：对话上下文与消息压缩](src/part6-advanced/14-context-compaction.md) — 四层压缩策略（Snip → Micro → Auto → Reactive）
- [第 15 章：状态管理与终端 UI](src/part6-advanced/15-state-ui.md) — React + Ink 终端渲染、Store 原语、组件层次
- [第 16 章：多 Agent 协作与高级模式](src/part6-advanced/16-multi-agent.md) — Fork 模式、Swarm 协作、远程 Agent

### 第七部分：数据与状态层

- [第 17 章：附件系统](src/part7-data-layer/17-attachment-system.md) — 40+ 种附件类型、@文件提取、图片处理、变更检测
- [第 18 章：记忆系统](src/part7-data-layer/18-memory-system.md) — 四类型分类法、MEMORY.md 索引、Fork Agent 自动提取
- [第 19 章：会话持久化与历史管理](src/part7-data-layer/19-session-history.md) — JSONL 转录、内容寻址去重、会话恢复
- [第 20 章：任务管理系统](src/part7-data-layer/20-task-management.md) — TodoWrite、文件驱动任务、两级锁、后台任务

### 第八部分：基础设施

- [第 21 章：配置系统](src/part8-infra/21-config-settings.md) — 五层合并、三级缓存、MDM 企业管控
- [第 22 章：认证与安全存储](src/part8-infra/22-auth-security.md) — macOS Keychain、OAuth PKCE、生代计数器
- [第 23 章：费用追踪与遥测](src/part8-infra/23-cost-telemetry.md) — Token 定价、三管线遥测、GrowthBook Feature Flags

## 本地运行

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建静态站点
npm run build

# 预览构建结果
npm run preview
```

## 技术栈

- [VitePress](https://vitepress.dev/) — Vue 生态静态站点生成器
- [Mermaid](https://mermaid.js.org/) — 图表渲染
- [markdown-it-pangu](https://github.com/panezhang/markdown-it-pangu) — 中英文自动加空格

## 说明

- 本书基于 Claude Code **v2.1.88** 源码撰写，不跟踪上游更新
- 每章先讲概念再走读代码，代码片段标注源文件路径
- 面向有一定前端/Node.js 基础、了解 Agent 概念的工程师

## License

MIT
