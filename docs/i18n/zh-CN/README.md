<!-- source: README.md -->
<div align="center">

# yokoten · 横展

### 每个 AI agent，同一套规则。

AI 让写代码变便宜了，管代码却没有。哪家的 agent，yokoten 都让它守你的规则，并把整个团队放在一块看板上。拍板的永远是你。

yokoten 之于 AI 写的代码，就像 UL 认证之于电器：它不造电器，只让每家厂商都过同一套安全标准。

**[yokoten.app](https://yokoten.app/?from=github)** &nbsp;·&nbsp; [English](https://github.com/yokoten-labs/yokoten/blob/main/README.md) | 简体中文 | [繁體中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-TW/README.md) | [日本語](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/ja/README.md)

[![ci](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml/badge.svg)](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/yokoten-labs/yokoten/blob/main/LICENSE)
[![npm](https://img.shields.io/npm/v/yokoten?logo=npm)](https://www.npmjs.com/package/yokoten)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.23.4-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

</div>

## 它做什么

yokoten 是加在你已经在用的 agent 上的一道安全带。钩子、沙箱和设置，用的都是每家 agent 自己的。yokoten 不另起一套。

同样的五道保护对每个人、每个 agent 都成立，默认开着，不用任何设置：

1. **agent 不能弄丢你的工作。** 不许直接 force push，不许硬重置，不许删 `.git` 或历史。
2. **agent 不能泄露秘密。** 提交、issue 或 pull request 里不能有密钥、令牌、邮箱地址或家目录路径。
3. **agent 不能替你发布。** 不许打 tag、发 release、发 npm 包，也不许把仓库改成公开。
4. **agent 不能没读就运行网上的代码。** 不许把下载内容直接管道给 shell。
5. **agent 不能拆掉安全带。** 不许关掉检查或钩子，也不许改 CI 或规则。

`yokoten init` 在五道保护之上加项目规则，从不会去掉任何一道。它会给支持的每个 agent 写好钩子，给 Claude Code、Codex、Gemini CLI 和 Grok 写好沙箱设置。就算没有 agent，提交检查和 CI 也会拦住有问题的改动。为什么人人默认这一套，见[记录 0034](https://github.com/yokoten-labs/yokoten/blob/main/docs/records/0034-one-safeguard-for-everyone.md)。

## 安装

只要 [Node](https://nodejs.org/) 22.23.4 或更高（用 Node 24 要 24.22.1 起，用 Node 26 要 26.12.1 起）。别的都不用装。

```sh
npx yokoten install      # 每台电脑一次
cd your-project
npx yokoten init         # 每个项目一次
npx yokoten doctor       # 走到了第几关，下一步做什么
```

用 Claude Code 的话，可以改用插件。先运行 `/plugin marketplace add yokoten-labs/yokoten`，再运行 `/plugin install yokoten@yokoten`。插件和 `npx` 选一个，不要两个都装。只在 CI 里用的话，[当成 GitHub Action 用](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#use-it-as-a-github-action)。提交检查只认 UTC 时间。在 shell 的配置文件里加一行 `export TZ=UTC`，加一次就行。

## 你会看到什么

agent 试着强推。yokoten 拦住它，说清原因，给出改法。然后 `doctor` 只说出下一步这一件事：

<img src="https://raw.githubusercontent.com/yokoten-labs/yokoten/main/docs/assets/demo.svg" width="680" alt="终端里，agent 执行 git push --force origin main。yokoten 的钩子把它拦下，说明发生了什么、为什么危险、该怎么改：改用 --force-with-lease。接着 yokoten doctor 显示现在是第 1 关，一共 5 关，下一步是加测试。">

## 带一支 agent 团队（预览）

yokoten 自己就是这样一支团队做出来的。lead 负责计划和审查。各家的工程师，每人领一个 issue。

- **每个工程师一个工位。** `yokoten desk` 在 agent 自己的克隆里把它启动。除了它自己的 API，上不了网。不带令牌。你的主目录会被藏起来。它不能推送，也不能改自己要守的规则。
- **bot 来开 PR。** 每个 PR 都写明风险有多大（tier A、B 或 C）。风险高的，要等你批准。检查通过了，才能合并。
- **一块看板。** `yokoten board` 在你这台电脑上开一个页面。你能看到每个 agent 在做什么，每个 PR 走到哪一步（开发、检查、你（只有 tier A）、合并），还有什么在等你。手机上能看。有四种语言。页面不从网上加载任何东西。

看板和工位是预览：已经在 `main` 上，还没上 npm，也不在第一屏。团队命令在 v0.1.2 到来；v0.1.x 只有 CLI。

## 能配合什么

**Agent。** 守卫能在这些里面跑：Claude Code、Codex CLI、GitHub Copilot CLI、Antigravity CLI、Muse Code、DeepSeek Harness 和 Grok CLI。Gemini CLI 只是列在这里，还没有完整跑过。[agent 表](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#works-with)写着每一种是怎么测的。

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
| 3 | **一支团队，任何工具，任何平台**：各家 agent 守同一套规则、用同一块看板；GitHub、Gitea 和 GitLab | 🚧 团队看板正在做，就在 Meta 黑客松前后；下一步是 Windows 和 Gitea |
| 4 | **完整的循环**：从一份短说明，到开发、测试、审查、发版和维护 | 以后 |
| 5 | **横展**：一个项目学到的教训变成一条检查，再送到所有项目 | 目标 |

今天在做的事，看 [issue](https://github.com/yokoten-labs/yokoten/issues) 和 [里程碑](https://github.com/yokoten-labs/yokoten/milestones)。

## 了解更多

- **[使用指南](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md)**：五道保护、安装、所有命令，还有它做不到的事。
- **[决定记录](https://github.com/yokoten-labs/yokoten/tree/main/docs/records)**：为什么这样做。
- **[更新记录](https://github.com/yokoten-labs/yokoten/blob/main/CHANGELOG.md)**、**[参与开发](https://github.com/yokoten-labs/yokoten/blob/main/CONTRIBUTING.md)**、**[安全](https://github.com/yokoten-labs/yokoten/blob/main/.github/SECURITY.md)**、**[服务器设置](https://github.com/yokoten-labs/yokoten/blob/main/docs/server.md)**。

---

<p align="center"><sub>MIT · <a href="https://coolwhite.us/">coolwhite</a> 和一支 AI agent 团队做出来的。里面不少东西，是在工厂车间里学来的。</sub></p>
