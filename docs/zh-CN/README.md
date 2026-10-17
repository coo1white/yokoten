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

[![ci](https://img.shields.io/github/actions/workflow/status/coo1white/yokoten/yokoten.yml?branch=main&label=ci&style=flat&labelColor=1f2328&color=9e3620)](https://github.com/coo1white/yokoten/actions/workflows/yokoten.yml)
[![works with 3 agents](https://img.shields.io/badge/works%20with-3%20agents-9e3620?style=flat&labelColor=1f2328)](guide.md#安装和命令 "Claude Code、Codex、Gemini CLI")
[![dependencies 0](https://img.shields.io/badge/dependencies-0-9e3620?style=flat&labelColor=1f2328)](../../package.json)
[![TypeScript, no build](https://img.shields.io/badge/TypeScript-no%20build-9e3620?style=flat&logo=typescript&logoColor=f0f6fc&labelColor=1f2328)](../records/0002-typescript.md)
[![license MIT](https://img.shields.io/badge/license-MIT-9e3620?style=flat&labelColor=1f2328)](../../LICENSE)

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

| 什么时候 | 做什么 | 在这里看 |
|---|---|---|
| **现在，2026 年 10 月 26 日前** | `doctor` 带你一关一关走；发版流程；检查 GitHub 设置；`npx yokoten`；Codex 和 Gemini CLI 也能拦住危险操作 | [M0](https://github.com/coo1white/yokoten/milestone/1) |
| **Meta 黑客松，10 月 26 日 – 11 月 3 日** | 一个能读懂老项目、起草接入方案的 agent；支持 Muse Code | [M1](https://github.com/coo1white/yokoten/milestone/2) |
| **之后** | Gitea 等其他代码托管平台；大改动前先写一份简短的方案；拿 OpenSSF Best Practices 徽章，公开证明做到了 | [issue](https://github.com/coo1white/yokoten/issues) |

每一步都公开规划。[看板](https://github.com/users/coo1white/projects/1)上能看到今天在做什么。

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

「横展」是丰田的说法：一条产线找到的对策，推广到所有产线。

---

<p align="center"><sub>MIT · 由 <a href="https://coolwhite.us/">coolwhite</a> 制作，带着在工厂车间里学到的东西。</sub></p>
