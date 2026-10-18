<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/banner-zh-dark.svg">
  <img src="../assets/banner-zh-light.svg" width="100%" alt="yokoten · 横展。带你上路，替你守桥。一条路穿过群山，经过标着 1 到 5 的五关，通到一座桥，桥头有一盏灯守着。">
</picture>

<br/>

一个人，带几个 AI，照好团队的规矩做软件。<br/>
yokoten 就是这么做出来的：每个 issue、每次审查、每个版本，都在这个仓库里，随你翻。

**[yokoten.app](https://yokoten.app)** &nbsp;·&nbsp; [English](../../README.md) | 中文

<br/>

[![ci](https://github.com/coo1white/yokoten/actions/workflows/yokoten.yml/badge.svg)](https://github.com/coo1white/yokoten/actions/workflows/yokoten.yml)
[![built with Claude Code](https://img.shields.io/badge/built%20with-Claude%20Code-D97757?logo=claude&logoColor=white)](https://claude.com/claude-code)
[![TypeScript](https://img.shields.io/badge/TypeScript-no%20build-3178C6?logo=typescript&logoColor=white)](../records/0002-typescript.md)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.18-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](../../package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE)

[支持](guide.md#支持哪些-agent) Claude Code、Codex CLI 和 Gemini CLI。

</div>

## 装上的第一天，有什么不同

| AI 想做的事 | 没有 yokoten | 有 yokoten |
|---|---|---|
| 强推（force push），或者自己打 tag 发版 | 直接就做了 | 还没执行就被拦下，并告诉它为什么 |
| 测试不过，就去改测试 | 测试通过了，bug 还在 | 修 bug 时不许改测试 |
| 提交里带上你的邮箱、服务器 IP、所在城市 | 被公开出去 | 提交被拦下；报告只指出哪个文件第几行，不把内容打出来 |
| 开 PR | 用你的账号开，权限和你一样大 | 用 bot 账号开；你不点头，什么都合不进去 |
| 换到另一个项目 | 一切从头来 | 看出这个项目缺什么，问你要不要补上 |

被拦下时，AI 看到的不只是一句「不行」，还有原因：

```
yokoten: git push --tags pushes tags. Only the owner decides when to release.
```

（提示用英文写，因为 AI 读英文最不容易出错。）

## 这条路

软件团队的活儿是一圈一圈转的：计划、开发、测试、审查、发版。yokoten 带你一次走一关。
每一关，这个仓库自己都在做，你可以直接看它怎么运转：

| 关 | 学会什么 | 在这里看 |
|---|---|---|
| **1 · 安全网** | AI 要读的规则，以及规则管不住时拦下它的检查 | [AGENTS.md](../../AGENTS.md) |
| **2 · 先开 issue，再走 PR** | 每次改动先开 issue 说清为什么；CI 通过了才合并；用标签、里程碑（milestone）和看板管起来 | [issue](https://github.com/coo1white/yokoten/issues?q=is%3Aissue)、[PR](https://github.com/coo1white/yokoten/pulls?q=is%3Apr)、[看板](https://github.com/users/coo1white/projects/1) |
| **3 · 发版** | 写明改了什么、为什么改的提交信息；CHANGELOG；每次发版一个版本号 | [CHANGELOG.md](../../CHANGELOG.md) |
| **4 · 带一支 AI 团队** | bot 开 PR，worker 领任务，reviewer 审查；最后拍板的永远是你 | [使用指南](guide.md#像带团队一样管-agent) |
| **5 · 公开** | 把全部提交历史查一遍，看有没有漏出隐私；打开安全设置；保护 `main` 分支 | [安全说明](../../.github/SECURITY.md) |

## 往哪里去

**梦想：人人都能像好团队那样做软件。** 好团队里，每次改动都有原因、有测试、有人审过。
这些习惯，很多人要干上好几年、吃过几次亏才学会。有了 yokoten，编程新手第一天就能照着做；
AI 想闯大祸时，桥头有人守着。

软件开发是一整圈：计划、开发、测试、审查、发版、维护（SDLC）。yokoten 带你在自己的项目里
亲手走一遍，一次一关。

经验也不会只留在一个地方。一个项目吃过的亏，yokoten 会提醒别的项目先补上。这就是「横展」的意思。

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/road-dark.svg">
  <img src="../assets/road-light.svg" width="100%" alt="一条路沿着山往上爬，经过三站：现在、黑客松、下一步。快到山顶时，别的项目的小路汇进来。山顶插着一面旗，写着梦想：人人都能像好团队那样做软件。">
</picture>
</p>

| 阶段 | 名字 | 意思 | 现在 |
|---|---|---|---|
| 1 | **守桥** | AI agent 做危险操作之前就被拦下：force push、改测试让它通过、泄露隐私 | ✅ 已完成 |
| 2 | **带路** | 新手跟着 `doctor` 走完五关，一次只做一件事；agent 读懂老项目，起草接入 yokoten 的方案 | 🚧 正在做，黑客松前后 |
| 3 | **任何工具，任何平台** | Claude Code、Codex、Gemini CLI 和 Muse Code 守同一套规则；GitHub、Gitea、GitLab 都能用 | 下一步 |
| 4 | **完整的循环** | 从一份简短的方案开始，到开发、测试、审查、发版、维护，整个 SDLC 每一步都有人带路 | 之后 |
| 5 | **横展** | 一个项目学到的教训，变成一条检查；这条检查推广到所有项目。一个人学到的，大家都能用上 | 目标 |

「横展」这个词来自丰田的工厂：一条产线学到的教训（lessons learned），推广到所有产线。yokoten 的名字就是从这里来的。

近期要做的事在 [M0](https://github.com/coo1white/yokoten/milestone/1) 和 [M1](https://github.com/coo1white/yokoten/milestone/2) 里，[看板](https://github.com/users/coo1white/projects/1)上能看到今天在做什么。

## 快速开始

只要装 [Node](https://nodejs.org/) 22.18 或更高版本，别的都不用装。

```sh
git clone https://github.com/coo1white/yokoten
node yokoten/bin/yokoten.ts install                 # 每台电脑做一次
cd your-project
node ~/.local/share/yokoten/bin/yokoten.ts init      # 每个项目做一次
```

然后用 Claude Code 打开项目。它会告诉你走到了第几关，下一步该做哪一件事。

## 了解更多

- **[使用指南](guide.md)**：12 条规则、所有命令、它怎么工作，还有它做不到的事。
- **[服务器设置](../server.md)**：在 GitHub 上保护 `main` 分支和发版 tag（英文）。
- **[决定记录](../records/)**：为什么这样做（英文）。

---

<p align="center"><sub>MIT · <a href="https://coolwhite.us/">coolwhite</a> 做的。里面不少东西，是在工厂车间里学来的。</sub></p>
