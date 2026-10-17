<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/banner-zh-dark.svg">
  <img src="../assets/banner-zh-light.svg" width="100%" alt="yokoten · 横展。带你上路，替你守桥。一条路穿过群山，经过标着 1 到 5 的五关，通到一座桥，桥头有一盏灯守着。">
</picture>

<br/>

一个人 + AI，也按专业团队的标准开发。<br/>
yokoten 自己就是这样做出来的，这个仓库就是示范。

**[yokoten.app](https://yokoten.app)** &nbsp;·&nbsp; [English](../../README.md) | 中文

<br/>

[![ci](https://img.shields.io/github/actions/workflow/status/coo1white/yokoten/yokoten.yml?branch=main&label=ci&style=flat&labelColor=1c1a16&color=9e3620)](https://github.com/coo1white/yokoten/actions/workflows/yokoten.yml)
[![works with 3 agents](https://img.shields.io/badge/works%20with-3%20agents-9e3620?style=flat&labelColor=1c1a16)](guide.md#安装和命令 "Claude Code、Codex、Gemini CLI")
[![dependencies 0](https://img.shields.io/badge/dependencies-0-9e3620?style=flat&labelColor=1c1a16)](../../package.json)
[![TypeScript, no build](https://img.shields.io/badge/TypeScript-no%20build-9e3620?style=flat&logo=typescript&logoColor=f4f0e6&labelColor=1c1a16)](../records/0002-typescript.md)
[![license MIT](https://img.shields.io/badge/license-MIT-9e3620?style=flat&labelColor=1c1a16)](../../LICENSE)

</div>

## 装上的第一天，有什么不同

| AI 想做的事 | 没有 yokoten | 有 yokoten |
|---|---|---|
| force push，或者自己打 tag 发版 | 直接执行 | 执行前被拦下，并告诉它原因 |
| 测试不过，就去改测试 | 测试"绿了"，bug 还在 | 修 bug 时不准改测试 |
| 提交时带上你的邮箱、服务器 IP、城市 | 公开出去 | 提交被拦下；报告只说哪个文件第几行，不把内容打出来 |
| 开 PR | 用你的账号，权限和你一样大 | 用 bot 开，没有你同意合不进去 |
| 换到另一个项目 | 从零开始 | 先知道这个项目缺什么，并主动帮你补上 |

被拦下时，AI 看到的是原因，不只是一句"不行"：

```
yokoten: git push --tags pushes tags. Only the owner decides when to release.
```

（提示是英文的，因为 AI 读英文最稳。）

## 一路往前走

软件团队的工作是一个循环：计划、开发、检查、审查、发版。yokoten 带你一关一关走。每一关这个
仓库都已经在用，你可以直接看到它是怎么运转的：

| 关卡 | 学会什么 | 在这里看 |
|---|---|---|
| **1 · 安全网** | AI 要读的规则，能拦住它的检查 | [AGENTS.md](../../AGENTS.md) |
| **2 · 先开 issue，再走 PR** | 每次改动都有原因；CI 通过才合并；标签、milestone、看板 | [issue](https://github.com/coo1white/yokoten/issues?q=is%3Aissue)、[PR](https://github.com/coo1white/yokoten/pulls?q=is%3Apr)、[看板](https://github.com/users/coo1white/projects/1) |
| **3 · 发版** | 清楚的提交信息、CHANGELOG、版本号 | [CHANGELOG.md](../../CHANGELOG.md) |
| **4 · 带一支 AI 团队** | bot、worker、审查；你始终是老板 | [使用指南](guide.md#像带团队一样管-agent) |
| **5 · 公开** | 检查全部历史里的隐私、安全设置、分支保护 | [安全说明](../../.github/SECURITY.md) |

## 往哪里去

**梦想：人人都能像好团队那样做软件。** 编程新手从第一天就走在对的路上，有 AI agent 陪着，也不会摔跤。
软件开发是一整个循环（SDLC：计划、开发、测试、审查、发版、维护）。yokoten 不讲大道理，带你一步一步亲手走一遍。

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/road-dark.svg">
  <img src="../assets/road-light.svg" width="100%" alt="一条路上的五站：第一站已经走完，第二站是现在的位置，后面还有三站。最后一站之后，路分成好几条。">
</picture>
</p>

| 阶段 | 名字 | 意思 | 现在 |
|---|---|---|---|
| 1 | **守桥** | AI agent 做危险操作之前就被拦下：force push、改测试让它通过、泄露隐私 | ✅ 已完成 |
| 2 | **带路** | 新手跟着 `doctor` 走完五关，一次只做一件事；agent 读懂老项目，起草接入 yokoten 的方案 | 🚧 正在做，黑客松前后 |
| 3 | **任何工具，任何平台** | Claude Code、Codex、Gemini CLI 和 Muse Code 守同一套规则；GitHub、Gitea、GitLab 都能用 | 下一步 |
| 4 | **完整的循环** | 从一份简短的方案开始，到开发、测试、审查、发版、维护，整个 SDLC 每一步都有人带路 | 之后 |
| 5 | **横展** | 一个项目学到的教训，变成一条检查；这条检查推广到所有项目。一个人学到的，大家都能用上 | 目标 |

「横展」这个词来自丰田的工厂：一条产线学到的教训，推广到所有产线。yokoten 的名字就是从这里来的。

近期要做的事在 [M0](https://github.com/coo1white/yokoten/milestone/1) 和 [M1](https://github.com/coo1white/yokoten/milestone/2) 里，[看板](https://github.com/users/coo1white/projects/1)上能看到今天在做什么。

## 快速开始

只需要 [Node](https://nodejs.org/) 22.18 或更高版本，别的都不用装。

```sh
git clone https://github.com/coo1white/yokoten
node yokoten/bin/yokoten.ts install                 # 每台电脑一次
cd your-project
node ~/.local/share/yokoten/bin/yokoten.ts init      # 每个项目一次
```

然后用 Claude Code 打开这个项目，它会告诉你走到了哪一关，下一步做什么。

## 了解更多

- **[使用指南](guide.md)**：12 条规则、全部命令、工作原理，以及它做不到的事。
- **[服务器设置](../server.md)**：在 GitHub 上保护 `main` 和发版 tag（英文）。
- **[决定记录](../records/)**：为什么这样设计（英文）。

---

<p align="center"><sub>MIT · 由 <a href="https://coolwhite.us/">coolwhite</a> 制作，带着在工厂车间里学到的东西。</sub></p>
