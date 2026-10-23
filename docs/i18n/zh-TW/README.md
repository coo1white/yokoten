<!-- source: README.md -->
<div align="center">

# yokoten · 横展

### 每個 AI agent，同一套規則。

寫程式變便宜了。把程式管好，沒有一起變便宜。yokoten 要各家的 agent 都遵守你的規則，也讓你在同一塊看板上看見整個團隊。決定權始終在你。

yokoten 之於 AI 寫的程式，就像 UL 認證之於電器：它不製造電器，只讓每家廠商都通過同一套安全標準。

**[yokoten.app](https://yokoten.app/?from=github)** &nbsp;·&nbsp; [English](https://github.com/yokoten-labs/yokoten/blob/main/README.md) | [简体中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-CN/README.md) | 繁體中文 | [日本語](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/ja/README.md)

[![ci](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml/badge.svg)](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/yokoten-labs/yokoten/blob/main/LICENSE)
[![npm](https://img.shields.io/npm/v/yokoten?logo=npm)](https://www.npmjs.com/package/yokoten)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.23.4-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

</div>

## 它做什麼

yokoten 在你已經在用的 agent 上面，再補三件事。hook、沙箱、設定，都沿用那家 agent 自己的，不會另外換一套。

1. **每個 agent，同一套規則。** 守衛會在指令和修改真正執行前先看過。強制 push、發布用的 tag、跳過提交檢查、修 bug 的任務裡改測試，還有 agent 要發出去的內容裡的密鑰或個資，都會被擋下。它會告訴 agent 原因，以及該怎麼改。
2. **規則寫進每家 agent 自己的設定。** `yokoten init` 會幫它支援的每個 agent 寫好 hook，並幫 Claude Code、Codex、Gemini CLI 和 Grok 寫好沙箱設定。就算沒有 agent，提交檢查和 CI 還是會擋下有問題的修改。
3. **一塊看板，給一支 agent 團隊用。** 不同廠商的 agent 並排工作，各自待在圍起來的工位裡。開一個頁面，全部都看得到。

## 安裝

只需要 [Node](https://nodejs.org/) 22.23.4 以上（Node 24 要 24.22.1 以上，Node 26 要 26.12.1 以上）。其他不用裝。

```sh
cd your-project
npx yokoten             # 一次就好：裝好 yokoten，加上規則，顯示下一步
```

這就是全部的開始。在任何專案裡再執行一次 `npx yokoten`，它只做還缺的部分。想一步一步來的話：

```sh
npx yokoten install      # 每台電腦一次
npx yokoten init         # 每個專案一次
npx yokoten doctor       # 你在第幾關，下一步做什麼
```

用 Claude Code 的話，可以改用外掛。先執行 `/plugin marketplace add yokoten-labs/yokoten`，再執行 `/plugin install yokoten@yokoten`。外掛和 `npx` 擇一，不要兩個都裝。只用在 CI 的話，[把它當成 GitHub Action](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#use-it-as-a-github-action)。提交檢查只接受 UTC 的時間。請在 shell 設定檔加一次 `export TZ=UTC`。

## 你會看到的畫面

agent 嘗試強制 push。yokoten 把它擋下，說明原因，並給出改法。接著 `doctor` 只指出下一步那一件事：

<img src="https://raw.githubusercontent.com/yokoten-labs/yokoten/main/docs/assets/demo.svg" width="680" alt="終端機畫面。agent 執行 git push --force origin main，yokoten 的 hook 把它擋下，說明發生了什麼、為什麼危險、該怎麼改：改用 --force-with-lease。接著 yokoten doctor 顯示目前在第 1 關（共 5 關），下一步是加上測試。">

## 讓一組 agent 一起工作

yokoten 就是由這樣的團隊做出來的。lead 負責規劃和審查，各家廠商的工程師各自領一個 issue。

- **每位工程師一個工位。** `yokoten desk` 會在 agent 自己的 clone 裡把 agent 啟動。上網只通它自己的 API。token 不會帶進去。家目錄會被藏起來。它不能 push，也不准改自己要守的規則。
- **由 bot 開 PR。** 每個 PR 都會標出風險（tier A、B 或 C）。風險高的要等你核准。檢查通過了，才能合併。
- **一塊看板。** `yokoten board` 在你的電腦上開一個頁面。你可以看見每個 agent 在做什麼、每個 PR 走到「開發、檢查、你（只有 tier A）、合併」的哪一步，以及有什麼在等你。手機上看得到。有四種語言。頁面不會從網路上載入任何東西。

看板和工位已經在 `main` 上。下一次發布，會一起進到 npm。

## 支援範圍

**Agent。** 守衛可以在這些環境執行：Claude Code、Codex CLI、GitHub Copilot CLI、Antigravity CLI、Muse Code、DeepSeek Harness 和 Grok CLI。Gemini CLI 有列出來，但還沒有從頭到尾確認過。[agent 表](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#works-with)寫著每一種是怎麼測的。

**語言。** 專案用哪種語言都可以。守衛、隱私和密鑰檢查、CI，以及 issue 和 PR 檢查，在每種語言裡都一樣。`doctor` 找得到測試指令的有 JavaScript 和 TypeScript、Python、Go、Rust、Java、.NET、Ruby、PHP、Swift、Elixir、Dart，還有任何提供 `make test` 的專案。其中 Go、Python、Rust、.NET、Ruby 和 PHP，`init` 會寫好執行測試的 CI 工作。

## 為什麼要做

好的團隊裡，每個修改都有理由、有測試、有人 review 過。這些習慣通常要做很多年才會，而且常常是出過問題之後。有了 yokoten，新手第一天就能照著做，一次過一關。AI 要闖大禍之前，守衛會先擋下來。

學到的事不會只留在一個專案。「橫展」是豐田工廠的說法：一條產線找到的對策，會推到每一條產線。一個專案得到教訓，yokoten 就把對應的檢查帶到其他專案。

## 這條路上

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/yokoten-labs/yokoten/main/docs/assets/road-dark.svg">
  <img src="https://raw.githubusercontent.com/yokoten-labs/yokoten/main/docs/assets/road-light.svg" width="100%" alt="一條路沿著山往上爬，經過三站：現在、黑客松、下一步。快到山頂時，其他專案的小路匯進來。山頂插著一面旗，寫著夢想：人人都能像好團隊那樣做軟體。">
</picture>
</p>

夢想：人人都能像好團隊那樣做軟體。

| | 階段 | 現在到哪 |
|---|---|---|
| 1 | **守衛**：危險動作發生前，agent 就會被擋下 | ✅ 已完成 |
| 2 | **帶路**：`doctor` 帶新手走完五關；agent 起草舊專案要怎麼接上 yokoten | 🚧 進行中 |
| 3 | **一支團隊，任何工具，任何平台**：各家 agent 用同一套規則、同一塊看板；平台有 GitHub、Gitea、GitLab | 🚧 團隊看板進行中，大約在 Meta 黑客松前後；接著做 Windows 和 Gitea |
| 4 | **整個循環**：從一份簡短說明，到開發、測試、審查、發布和維護 | 之後 |
| 5 | **橫展**：一個專案學到的教訓變成一項檢查，再推到每個專案 | 目標 |

今天在做的事，看 [issue](https://github.com/yokoten-labs/yokoten/issues) 和 [里程碑](https://github.com/yokoten-labs/yokoten/milestones)。

## 延伸閱讀

- **[使用指南](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md)**：12 條規則、所有指令、運作方式，以及它做不到的事。
- **[決策紀錄](https://github.com/yokoten-labs/yokoten/tree/main/docs/records)**：為什麼這樣做。
- **[更新紀錄](https://github.com/yokoten-labs/yokoten/blob/main/CHANGELOG.md)**、**[參與開發](https://github.com/yokoten-labs/yokoten/blob/main/CONTRIBUTING.md)**、**[資安](https://github.com/yokoten-labs/yokoten/blob/main/.github/SECURITY.md)**、**[伺服器設定](https://github.com/yokoten-labs/yokoten/blob/main/docs/server.md)**。

---

<p align="center"><sub>MIT · 由 <a href="https://coolwhite.us/">coolwhite</a> 和一支 AI agent 團隊做出來。不少做法，是在工廠現場學的。</sub></p>
