<!-- source: README.md -->
<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/banner-dark.svg">
  <img src="../../assets/banner-light.svg" width="100%" alt="yokoten · 橫展。一路幫你帶路，在橋頭替你把關。一條路穿過群山，經過標著 1 到 5 的五關，通到一座橋，橋頭有一盞燈守著。">
</picture>

<br/>

**人人都能像好團隊那樣開發軟體。**

一路帶你上手，也替你看好 AI。

**[yokoten.app](https://yokoten.app/?from=github)** &nbsp;·&nbsp; [English](../../../README.md) | [简体中文](../zh-CN/README.md) | 繁體中文 | [日本語](../ja/README.md)

[![ci](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml/badge.svg)](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](../../../LICENSE)
[![npm](https://img.shields.io/npm/v/yokoten?logo=npm)](https://www.npmjs.com/package/yokoten)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.18-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

</div>

<sub>這頁是從英文版翻過來的。如果讀起來卡卡的或有錯，歡迎開 issue 或 pull request 告訴我們。</sub>

## 用哪個 agent 都可以

在下面這些 agent 裡，危險的操作在執行前就會被擋下來（[各自怎麼設定](../../guide.md#works-with)，英文）：

- Claude Code
- Codex CLI
- GitHub Copilot CLI
- Antigravity CLI
- Muse Code
- DeepSeek Harness
- Grok CLI

用其他 agent，或完全不用 agent，提交檢查和 CI 一樣會擋下有問題的改動。

## 用哪種語言都可以

yokoten 本身需要 Node 22.18 或更新版本（你的電腦和 CI 上都要），但你的專案用哪種語言都可以。
守衛、隱私與密鑰檢查、CI、issue 和 PR 檢查，在每種語言裡都一樣運作。

只有一個步驟會看語言：`doctor` 會找你的測試指令。

| | 語言 |
|---|---|
| 找得到測試指令 | JavaScript 和 TypeScript（npm、Deno）、Python、Go、Rust、Java（Maven、Gradle）、.NET、Ruby、PHP、Swift、Elixir、Dart 和 Flutter，以及有 `make test` 的專案 |
| 開發中（[#550](https://github.com/yokoten-labs/yokoten/issues/550)） | 幫你寫好跑測試的 CI 工作，不必自己手寫 |

前幾步（install、init、doctor）已經在 Python、Go、Rust、.NET、Ruby 和 PHP 專案上試過。
目前從安裝到發版的整條路，只在 TypeScript 專案上完整走過。

## 為什麼做這個

好的團隊裡，每個改動都有理由、有測試、有人 review 過。這些習慣，很多人要做個好幾年、出過幾次包才學會。
有了 yokoten，新手第一天就能照著做：規劃、開發、測試、審查、發布，一次過一關。
AI 要闖大禍的時候，像是 force push、改測試讓它硬過、把個資推上去，橋頭會先有人擋下來。

經驗也不會只留在一個專案裡。「橫展」是豐田工廠的說法：一條產線找到的對策，會推廣到所有產線。
一個專案踩過的坑，yokoten 會把對應的檢查帶到你其他的專案。

## 安裝

只需要 [Node](https://nodejs.org/) 22.18 以上的版本，其他什麼都不用裝。

```sh
npx yokoten install      # 每台電腦做一次
cd your-project
npx yokoten init         # 每個專案做一次
npx yokoten doctor       # 看你走到第幾關、下一步要做什麼
```

### 先知道這幾件事

- **提交時用 UTC 時間。** 用 `TZ=UTC git commit` 提交，或在 shell 設定檔加一行 `export TZ=UTC`。
  提交裡的時區會讓陌生人猜到你大概住哪裡，所以提交檢查只接受 UTC。
- **用 Claude Code 的話，也可以裝外掛。** 先輸入 `/plugin marketplace add yokoten-labs/yokoten`，
  再輸入 `/plugin install yokoten@yokoten`。外掛和 `npx` 擇一就好，不要兩個都裝（[詳細說明](../../guide.md#the-claude-code-plugin)，英文）。
- **只想在 CI 裡用？** [當成 GitHub Action 使用](../../guide.md#use-it-as-a-github-action)（英文）。

## 實際用起來的樣子

agent 想 force push，yokoten 把它擋下來，說明原因，再給出修正方法。接著 `doctor` 告訴你下一步該做哪件事：

<img src="../../assets/demo.svg" width="680" alt="終端機裡，agent 要執行 git push --force origin main，被 yokoten 擋了下來。yokoten 說明這個指令會做什麼、為什麼危險、該怎麼改：改用 --force-with-lease。接著執行 yokoten doctor，它顯示目前在第 1 關（共 5 關），下一步是加上測試。">

## 接下來的方向

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/road-dark.svg">
  <img src="../../assets/road-light.svg" width="100%" alt="一條路沿著山往上爬，經過三站：現在、黑客松、下一步。快到山頂時，其他專案的小路匯了進來。山頂插著一面旗，寫著夢想：人人都能像好團隊那樣開發軟體。">
</picture>
</p>

把關的部分已經完成，帶路的部分正在做。接下來會支援更多 AI 工具和程式碼託管平台，再把整個開發流程都帶進來。
山頂就是「橫展」：一個專案學到的，所有專案都用得上。
五個階段寫在[路線圖](../../guide.md#where-this-is-going)（英文），今天在做什麼可以看[看板](https://github.com/orgs/yokoten-labs/projects/1)。

## 了解更多

- **[yokoten.app](https://yokoten.app/?from=github)**：官網，使用指南和決策紀錄都能直接在上面看。
- **[使用指南](../../guide.md)**：12 條規則、所有指令、運作方式，還有它做不到的事（英文；也有[簡體中文版](../zh-CN/guide.md)）。
- **[伺服器設定](../../server.md)**：在 GitHub 上保護 `main` 分支和發布用的 tag（英文）。
- **[決策紀錄](../../records/)**：為什麼這樣設計（英文）。
- **[更新紀錄](../../../CHANGELOG.md)**：每個版本改了什麼（英文）。
- **[參與開發](../../../CONTRIBUTING.md)**：怎麼回報問題、怎麼提交修改（英文）。
- **[資安](../../../.github/SECURITY.md)**：發現資安問題時怎麼回報（英文）。

---

<p align="center"><sub>MIT · 由 <a href="https://coolwhite.us/">coolwhite</a> 和一支 AI agent 團隊依照 yokoten 自己的規矩打造：v0.1.0 由 Claude Code 打底，v0.1.1 由 Muse Code 主導。許多想法來自工廠現場的經驗。</sub></p>
