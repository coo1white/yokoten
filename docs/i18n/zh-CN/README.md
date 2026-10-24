<!-- source: README.md -->
<div align="center">

# yokoten · 横展

### AI 负责想。yokoten 是一个程序，守住从想到做的那一步。

yokoten 是程序，不是 AI。
别人没法用话把它说服。
同一条命令，每次都得到同一个回答。每次检查不到 100 毫秒，也不花钱。
每条规则都有测试。

它待在你已经在用的 AI 写代码工具里面。
工具在每条命令或每次修改之前，先问 yokoten。
装一次就行，不用再学别的。
终端、桌面软件、编辑器里都能用。在一次跑很多 agent 的工具下面也可以，比如 Orca。
它不替换这些工具。

它不是 AI agent，不是聊天工具，也不是团队页面。

**[yokoten.app](https://yokoten.app/?from=github)** &nbsp;·&nbsp; [English](https://github.com/yokoten-labs/yokoten/blob/main/README.md) | 简体中文 | [繁體中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-TW/README.md) | [日本語](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/ja/README.md)

[![ci](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml/badge.svg)](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/yokoten-labs/yokoten/blob/main/LICENSE)
[![npm](https://img.shields.io/npm/v/yokoten?logo=npm)](https://www.npmjs.com/package/yokoten)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.23.4-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

</div>

## 它做什么

yokoten 保护五样东西：你的工作、你的秘密、你的发布、你运行的代码，还有这道保护本身。

其中一部分现在已经开着。守卫会拦住强推、删除 `.git`、推标签、发包、把下载的内容直接送进 shell，以及跳过提交检查。
提交检查会拦住提交里的秘密。项目要先运行 `yokoten init`。
五项保护里剩下的，会在 v0.1.1 到来。

守卫是看不见的：你什么都不打，它也在工作。
有几条命令是给你用的，比如 `yokoten install` 和 `yokoten doctor`。
团队命令计划在 v0.1.2（[issue #823](https://github.com/yokoten-labs/yokoten/issues/823)）。

yokoten 用同一套规则守着九个 AI 写代码 agent：Claude Code、GitHub Copilot CLI、Antigravity CLI、Codex CLI、Muse Code、DeepSeek Harness、Grok CLI、Gemini CLI 和 OpenCode。
其中七个做了端到端验证。Gemini CLI 和 OpenCode 已经写进代码，但还没有做端到端运行。

yokoten 拦住一件事时，不写代码的人也能照着做。
它会说出拦住了什么、为什么、该怎么做，然后给出指南的链接。

```
yokoten: git push origin v1.2.0 pushes a release tag. Only the owner decides when to release. If the owner asked for this, they start a new session with `YOKOTEN_RELEASE_APPROVAL=1 claude` (or your agent's command); do not look for another way.
  docs: https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#the-core-rules
```

## 安装

只要 [Node](https://nodejs.org/) 22.23.4 或更高（用 Node 24 要 24.22.1 起，用 Node 26 要 26.12.1 起）。别的都不用装。

```sh
npx yokoten install      # 每台电脑一次
cd your-project
npx yokoten init         # 每个项目一次
npx yokoten doctor       # 走到了第几关，下一步做什么
```

用 Claude Code 的话，可以改用插件。先运行 `/plugin marketplace add yokoten-labs/yokoten`，再运行 `/plugin install yokoten@yokoten`。插件和 `npx` 选一个，不要两个都装。只在 CI 里用的话，[当成 GitHub Action 用](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#use-it-as-a-github-action)。提交检查只认 UTC 时间。在 shell 的配置文件里加一行 `export TZ=UTC`，加一次就行。

`npx skills add yokoten-labs/yokoten` 只复制 skills。还要再运行 `npx yokoten install`，否则没有命令守卫，也没有会话里的 doctor。

## 你会看到什么

agent 试着强推。yokoten 拦住它，说清原因，给出改法。然后 `doctor` 只说出下一步这一件事：

<img src="https://raw.githubusercontent.com/yokoten-labs/yokoten/main/docs/assets/demo.svg" width="680" alt="终端里，agent 执行 git push --force origin main。yokoten 的钩子把它拦下，说明发生了什么、为什么危险、该怎么改：改用 --force-with-lease。接着 yokoten doctor 显示现在是第 1 关，一共 5 关，下一步是加测试。">

## 接下来

团队命令计划在 v0.1.2（[issue #823](https://github.com/yokoten-labs/yokoten/issues/823)）。
你将可以从命令行添加、查看、修改、删除 agent、任务和机器。
团队页面只是预览。
它不在 0.1 的发布里。

yokoten 在 PR 之前工作，也和 [PR 审查机器人](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-CN/guide.md#在-pr-上会看到的审查机器人) 一起工作。

## 能配合什么

**Agent。** yokoten 用同一套规则守着九个 AI 写代码 agent：Claude Code、GitHub Copilot CLI、Antigravity CLI、Codex CLI、Muse Code、DeepSeek Harness、Grok CLI、Gemini CLI 和 OpenCode。其中七个做了端到端验证。Gemini CLI 和 OpenCode 已经写进代码，但还没有做端到端运行。
[agent 表](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#works-with)写着每一种是怎么测的。

**语言。** 项目用什么语言都可以。守卫、隐私和密钥检查、CI，还有 issue 和 PR 检查，在各种语言里都一样。`doctor` 能找到测试命令的，有 JavaScript 和 TypeScript、Python、Go、Rust、Java、.NET、Ruby、PHP、Swift、Elixir、Dart，以及任何有 `make test` 的项目。其中 Go、Python、Rust、.NET、Ruby 和 PHP，`init` 会替你写好跑测试的 CI 任务。

## 为什么做它

好团队里，每次改动都有原因，有测试，有人审过。这些习惯，很多人要好几年才学会，常常是先出过事。yokoten 让新手第一天就能照着做，一次只走一关。AI 要闯大祸之前，守卫会先拦住。

经验不会只留在一个项目里。「横展」是丰田工厂的说法：一条产线找到的对策，会推广到每一条产线。一个项目学到一课，yokoten 就把这条检查送到别的项目。

## 往哪里去

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/yokoten-labs/yokoten/main/docs/assets/road-dark.svg">
  <img src="https://raw.githubusercontent.com/yokoten-labs/yokoten/main/docs/assets/road-light.svg" width="100%" alt="一条路沿着山往上爬，经过三站：现在、黑客松、下一步。快到山顶时，别的项目的小路汇进来。山顶插着一面旗，写着梦想：人人都能像好团队那样做软件。">
</picture>
</p>

梦想：人人都能像好团队那样做软件。

| | 阶段 | 现在到哪了 |
|---|---|---|
| 1 | **守卫**：agent 做危险操作之前就被拦下 | ✅ 已完成 |
| 2 | **带路**：`doctor` 带新手走完五关；agent 起草老项目怎样接入 yokoten | 🚧 正在做 |
| 3 | **团队命令**：从命令行添加、查看、修改、删除 agent、任务和机器 | 🚧 计划在 v0.1.2（[issue #823](https://github.com/yokoten-labs/yokoten/issues/823)）；团队页面只是预览，不在 0.1 的发布里 |
| 4 | **完整的循环**：从一份短说明，到开发、测试、审查、发版和维护 | 以后 |
| 5 | **横展**：一个项目学到的教训变成一条检查，再送到所有项目 | 目标 |

今天在做的事，看 [issue](https://github.com/yokoten-labs/yokoten/issues) 和 [里程碑](https://github.com/yokoten-labs/yokoten/milestones)。

## 了解更多

- **[使用指南](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md)**：12 条规则、所有命令、它怎么工作，还有它做不到的事。
- **[决定记录](https://github.com/yokoten-labs/yokoten/tree/main/docs/records)**：为什么这样做。
- **[更新记录](https://github.com/yokoten-labs/yokoten/blob/main/CHANGELOG.md)**、**[参与开发](https://github.com/yokoten-labs/yokoten/blob/main/CONTRIBUTING.md)**、**[安全](https://github.com/yokoten-labs/yokoten/blob/main/.github/SECURITY.md)**、**[服务器设置](https://github.com/yokoten-labs/yokoten/blob/main/docs/server.md)**。

---

<p align="center"><sub>MIT · <a href="https://coolwhite.us/">coolwhite</a> 和一支 AI agent 团队做出来的。里面不少东西，是在工厂车间里学来的。</sub></p>
