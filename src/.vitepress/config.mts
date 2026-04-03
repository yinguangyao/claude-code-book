import { defineConfig } from 'vitepress'

export default defineConfig({
  title: '深入 Claude Code',
  description: 'AI Agent 架构与源码解析',
  lang: 'zh-CN',
  base: '/claude-code-book/',
  ignoreDeadLinks: true,

  markdown: {
    lineNumbers: true,
    config(md) {
      // 中英文之间自动插入空格
      try {
        const pangu = require('markdown-it-pangu')
        md.use(pangu)
      } catch {}
    }
  },

  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '开始阅读', link: '/part1-overview/01-introduction' }
    ],

    sidebar: [
      {
        text: '第一部分：全局视角',
        collapsed: false,
        items: [
          { text: '第 1 章：走进 Claude Code', link: '/part1-overview/01-introduction' },
          { text: '第 2 章：启动流程', link: '/part1-overview/02-startup-flow' }
        ]
      },
      {
        text: '第二部分：Agent 核心循环',
        collapsed: false,
        items: [
          { text: '第 3 章：System Prompt 的动态构建', link: '/part2-agent-loop/03-system-prompt' },
          { text: '第 4 章：Agent Loop', link: '/part2-agent-loop/04-agent-loop' },
          { text: '第 5 章：QueryEngine', link: '/part2-agent-loop/05-query-engine' }
        ]
      },
      {
        text: '第三部分：工具系统',
        collapsed: false,
        items: [
          { text: '第 6 章：Tool 接口设计与注册机制', link: '/part3-tool-system/06-tool-interface' },
          { text: '第 7 章：工具编排与并发控制', link: '/part3-tool-system/07-tool-orchestration' },
          { text: '第 8 章：关键工具实现解析', link: '/part3-tool-system/08-tool-implementations' }
        ]
      },
      {
        text: '第四部分：权限与安全',
        collapsed: false,
        items: [
          { text: '第 9 章：多层权限系统', link: '/part4-permissions/09-permission-system' },
          { text: '第 10 章：Permission Mode 与安全设计', link: '/part4-permissions/10-permission-modes' }
        ]
      },
      {
        text: '第五部分：扩展机制',
        collapsed: false,
        items: [
          { text: '第 11 章：Hook 系统', link: '/part5-extensions/11-hooks' },
          { text: '第 12 章：MCP 集成', link: '/part5-extensions/12-mcp' },
          { text: '第 13 章：Skill 与 Plugin 系统', link: '/part5-extensions/13-skills-plugins' }
        ]
      },
      {
        text: '第六部分：上下文管理与高级特性',
        collapsed: false,
        items: [
          { text: '第 14 章：对话上下文与消息压缩', link: '/part6-advanced/14-context-compaction' },
          { text: '第 15 章：状态管理与终端 UI', link: '/part6-advanced/15-state-ui' },
          { text: '第 16 章：多 Agent 协作与高级模式', link: '/part6-advanced/16-multi-agent' }
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
