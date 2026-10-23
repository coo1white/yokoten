<!-- source: README.md -->
<div align="center">

# yokoten · 横展

### AI 負責想。yokoten 是一個程式，守住從想到做的那一步。

yokoten 是程式，不是 AI。
別人沒辦法用話把它說服。
同一條指令，每次都得到同一個回答。每次檢查不到 100 毫秒，也不花錢。
每條規則都有測試。

它待在你已經在用的 AI 寫程式工具裡。
工具在每條指令或每次修改之前，先問 yokoten。
裝一次就好，不用再學別的。
終端機、桌面軟體、編輯器都能用。在一次跑很多 agent 的工具底下也可以，例如 Orca。
它不取代這些工具。

它不是 AI agent，不是聊天工具，也不是團隊頁面。

**[yokoten.app](https://yokoten.app/?from=github)** &nbsp;·&nbsp; [English](https://github.com/yokoten-labs/yokoten/blob/main/README.md) | [简体中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-CN/README.md) | 繁體中文 | [日本語](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/ja/README.md)

[![ci](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml/badge.svg)](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/yokoten-labs/yokoten/blob/main/LICENSE)
[![npm](https://img.shields.io/npm/v/yokoten?logo=npm)](https://www.npmjs.com/package/yokoten)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.23.4-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

</div>

## 它做什麼

五項保護預設就開著，每個人都一樣，不用設定。
agent 不能做這五件事：

1. **弄丟你的工作。** 不能強制 push，不能硬重置，也不能刪掉 `.git` 或歷史。
2. **洩漏秘密。** 提交或發出的內容裡，不能有金鑰、權杖、電子郵件或家目錄路徑。
3. **替你發布。** 不能打 tag，不能發版，不能發套件，也不能把儲存庫改成公開。什麼時候發布，只有你決定。
4. **執行沒看過的網路上的程式。** 不能把下載的內容直接送進 shell。
5. **拆掉這道保護。** 不能關掉 CI、hook 或規則。只有你能打開對規則的修改。

守衛是看不見的：你什麼都不用打，它也在工作。
有幾條指令是給你用的，例如 `yokoten install` 和 `yokoten doctor`。
團隊指令還沒來，會在 v0.1.2。
這一版裡還沒有。
到時你可以在命令列新增、列出、修改、移除 agent、任務和機器。

這項保護先在 Claude Code 和 Muse 裡測過。
OpenCode 配 DeepSeek、Codex、Grok、Gemini 已經寫進程式，正在測試。
還不能說每個 agent 都完成了。

yokoten 攔住一件事時，不寫程式的人也能照著做。
它會說出攔住了什麼、為什麼、一句可以告訴 AI 的話、一條你自己可以執行的指令，然後是規則。

```
yokoten 攔住了這件事：建立標籤 v1.2.0。
為什麼：標籤會發布一個版本，什麼時候發布只有你決定。
告訴 AI：「這個版本我自己來發布。」
或者你自己執行：git tag v1.2.0
```

## 安裝

只需要 [Node](https://nodejs.org/) 22.23.4 以上（Node 24 要 24.22.1 以上，Node 26 要 26.12.1 以上）。其他不用裝。

```sh
npx yokoten install      # 每台電腦一次
cd your-project
npx yokoten init         # 每個專案一次
npx yokoten doctor       # 你在第幾關，下一步做什麼
```

用 Claude Code 的話，可以改用外掛。先執行 `/plugin marketplace add yokoten-labs/yokoten`，再執行 `/plugin install yokoten@yokoten`。外掛和 `npx` 擇一，不要兩個都裝。只用在 CI 的話，[把它當成 GitHub Action](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#use-it-as-a-github-action)。提交檢查只接受 UTC 的時間。請在 shell 設定檔加一次 `export TZ=UTC`。

`npx skills add yokoten-labs/yokoten` 只複製 skills。還要再執行 `npx yokoten install`，否則沒有指令守衛，也沒有工作階段裡的 doctor。

## 你會看到的畫面

agent 嘗試強制 push。yokoten 把它擋下，說明原因，並給出改法。接著 `doctor` 只指出下一步那一件事：

<img src="https://raw.githubusercontent.com/yokoten-labs/yokoten/main/docs/assets/demo.svg" width="680" alt="終端機畫面。agent 執行 git push --force origin main，yokoten 的 hook 把它擋下，說明發生了什麼、為什麼危險、該怎麼改：改用 --force-with-lease。接著 yokoten doctor 顯示目前在第 1 關（共 5 關），下一步是加上測試。">

## 接下來

團隊指令會在 v0.1.2 到來。
你將可以在命令列新增、列出、修改、移除 agent、任務和機器。
團隊頁面只是預覽。
它不在 0.1 的發布裡。

## 支援範圍

**Agent。** 先在 Claude Code 和 Muse 裡測過。
OpenCode 配 DeepSeek、Codex、Grok、Gemini 已經寫進程式，正在測試。
[agent 表](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#works-with)寫著每一種是怎麼測的。

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
| 3 | **團隊指令**：從命令列新增、列出、修改、移除 agent、任務和機器 | 🚧 將在 v0.1.2 到來；團隊頁面只是預覽，不在 0.1 的發布裡 |
| 4 | **整個循環**：從一份簡短說明，到開發、測試、審查、發布和維護 | 之後 |
| 5 | **橫展**：一個專案學到的教訓變成一項檢查，再推到每個專案 | 目標 |

今天在做的事，看 [issue](https://github.com/yokoten-labs/yokoten/issues) 和 [里程碑](https://github.com/yokoten-labs/yokoten/milestones)。

## 延伸閱讀

- **[使用指南](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md)**：12 條規則、所有指令、運作方式，以及它做不到的事。
- **[決策紀錄](https://github.com/yokoten-labs/yokoten/tree/main/docs/records)**：為什麼這樣做。
- **[更新紀錄](https://github.com/yokoten-labs/yokoten/blob/main/CHANGELOG.md)**、**[參與開發](https://github.com/yokoten-labs/yokoten/blob/main/CONTRIBUTING.md)**、**[資安](https://github.com/yokoten-labs/yokoten/blob/main/.github/SECURITY.md)**、**[伺服器設定](https://github.com/yokoten-labs/yokoten/blob/main/docs/server.md)**。

---

<p align="center"><sub>MIT · 由 <a href="https://coolwhite.us/">coolwhite</a> 和一支 AI agent 團隊做出來。不少做法，是在工廠現場學的。</sub></p>
