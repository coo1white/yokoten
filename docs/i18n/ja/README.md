<!-- source: README.md -->
<div align="center">

# yokoten · 横展

### AI が考える。yokoten は、考えることから実行までの一歩を守るプログラムです。

yokoten はプログラムです。AI ではありません。
言葉でルールを曲げさせることはできません。
同じコマンドは、毎回同じ答えになります。1 回のチェックは 100 ミリ秒未満で、費用はかかりません。
どのルールにもテストがあります。

すでに使っている AI のコーディングツールの中で動きます。
ツールは、コマンドや編集の前に yokoten へ尋ねます。
一度インストールすれば、ほかに覚えることはありません。
ターミナルでも、デスクトップアプリでも、エディタでも動きます。Orca のように、多くのエージェントを動かすツールの下でも動きます。
それらのツールの代わりにはなりません。

いまの yokoten は、AI エージェントでも、チャットツールでも、チームのページでもありません。

**[yokoten.app](https://yokoten.app/?from=github)** &nbsp;·&nbsp; [English](https://github.com/yokoten-labs/yokoten/blob/main/README.md) | [简体中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-CN/README.md) | [繁體中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-TW/README.md) | 日本語

[![ci](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml/badge.svg)](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/yokoten-labs/yokoten/blob/main/LICENSE)
[![npm](https://img.shields.io/npm/v/yokoten?logo=npm)](https://www.npmjs.com/package/yokoten)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.23.4-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

</div>

## 何をするか

yokoten は五つを守ります。あなたの作業、秘密、公開、実行するコード、そしてこの保護そのものです。

その一部は、いまから有効です。番人は force push、`.git` の削除、タグの push、パッケージの公開、ダウンロードをシェルへ流し込むこと、コミットチェックの省略を止めます。
コミットチェックはコミットに含まれる秘密を止めます。プロジェクトで `yokoten init` を先に実行する必要があります。
五つの保護の残りは、v0.1.1 で来ます。

番人は目に見えません。何も入力しなくても働きます。
人が打つコマンドはわずかです。例えば `yokoten install` と `yokoten doctor` です。
チーム用のコマンドは v0.1.2 を予定しています（[issue #823](https://github.com/yokoten-labs/yokoten/issues/823)）。

yokoten は九つの AI コーディングエージェントを同じルールで守ります。Claude Code、GitHub Copilot CLI、Antigravity CLI、Codex CLI、Muse Code、DeepSeek Harness、Grok CLI、Gemini CLI、OpenCode です。
そのうち七つはエンドツーエンドで検証済みです。Gemini CLI と OpenCode はコードにありますが、エンドツーエンドではまだ実行していません。

yokoten が止めたとき、コードを書かない人でも、その答えで動けます。
止めたこと、理由、どうすればよいかを伝え、ガイドへのリンクを示します。

```
yokoten: git push origin v1.2.0 pushes a release tag. Only the owner decides when to release. If the owner asked for this, they start a new session with `YOKOTEN_RELEASE_APPROVAL=1 claude` (or your agent's command); do not look for another way.
  docs: https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#the-core-rules
```

## インストール

必要なのは [Node](https://nodejs.org/) 22.23.4 以降だけです（Node 24 は 24.22.1 以降、Node 26 は 26.12.1 以降）。他には何も要りません。

```sh
npx yokoten install      # PC ごとに一度
cd your-project
npx yokoten init         # プロジェクトごとに一度
npx yokoten doctor       # 今いる関所と、次の一手
```

Claude Code ではプラグインも使えます。`/plugin marketplace add yokoten-labs/yokoten` を実行し、続いて `/plugin install yokoten@yokoten` を実行します。プラグインと `npx` は、どちらか片方だけにしてください。CI だけで使うときは、[GitHub Action として使えます](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#use-it-as-a-github-action)。コミットのチェックは、時刻が UTC であることを求めます。シェルの設定ファイルに `export TZ=UTC` を一度書いておいてください。

`npx skills add yokoten-labs/yokoten` は、スキルだけをコピーします。`npx yokoten install` も実行してください。でないと、コマンドの番人も、セッションの doctor も入りません。

## 見えるもの

エージェントが force push を試すと、yokoten が止めます。理由と直し方も示します。そのあと `doctor` が、次の一手を一つ挙げます。

<img src="https://raw.githubusercontent.com/yokoten-labs/yokoten/main/docs/assets/demo.svg" width="680" alt="ターミナル。エージェントが git push --force origin main を実行すると、yokoten のフックがそれを止め、何が起きたか、なぜ危険か、直し方（--force-with-lease を使う）を示します。続いて yokoten doctor が 5 段階中の第 1 段階にいることを示し、次の一手としてテストの追加を挙げます。">

## この次

チーム用のコマンドは v0.1.2 を予定しています（[issue #823](https://github.com/yokoten-labs/yokoten/issues/823)）。
コマンドラインから、エージェント、タスク、マシンを追加、一覧、変更、削除できるようになります。
チームのページはプレビューです。
0.1 のリリースには入っていません。

yokoten はプルリクエストの前に動き、[PR レビューボット](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#review-bots-you-will-see-on-pull-requests) と並んで働きます。

## 対応しているもの

**エージェント。** yokoten は九つの AI コーディングエージェントを同じルールで守ります。Claude Code、GitHub Copilot CLI、Antigravity CLI、Codex CLI、Muse Code、DeepSeek Harness、Grok CLI、Gemini CLI、OpenCode です。そのうち七つはエンドツーエンドで検証済みです。Gemini CLI と OpenCode はコードにありますが、エンドツーエンドではまだ実行していません。
[エージェント表](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#works-with)に、それぞれの試し方が書いてあります。

**言語。** プロジェクトの言語は問いません。番人、個人情報と秘密情報のチェック、CI、issue とプルリクエストのチェックは、どの言語でも同じように動きます。`doctor` は、JavaScript と TypeScript、Python、Go、Rust、Java、.NET、Ruby、PHP、Swift、Elixir、Dart、そして `make test` があるプロジェクトについて、テストのコマンドを見つけます。Go、Python、Rust、.NET、Ruby、PHP では、`init` がテストを走らせる CI のジョブを書きます。

## なぜ作ったのか

良いチームでは、どの変更にも理由があり、テストがあり、レビューを通っています。こうした習慣は、何年もかけて身につきます。たいていは、何かを壊してからです。yokoten があれば、初心者でも初日から実践できます。一度に一つの関所です。最悪のミスの前に、番人が AI エージェントを止めます。

学んだ教訓は、一つのプロジェクトに閉じ込めません。*横展*（横展開、よこてんかい）はトヨタの工場で生まれた言葉で、あるラインで見つけた対策をすべてのラインに広げることを指します。一つのプロジェクトが教訓を得たら、yokoten はそのチェックを他のすべてのプロジェクトに届けます。

## これからの道

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/yokoten-labs/yokoten/main/docs/assets/road-dark.svg">
  <img src="https://raw.githubusercontent.com/yokoten-labs/yokoten/main/docs/assets/road-light.svg" width="100%" alt="一本の道が山を登り、現在、ハッカソン、その次という三つの駅を通り過ぎます。頂上近くで、他のプロジェクトからの道が合流します。頂上には夢を記した旗が立っています。誰でも、良いチームのやり方でソフトウェアを作れます。">
</picture>
</p>

夢は、誰でも良いチームのやり方でソフトウェアを作れることです。

| | 段階 | いまどこか |
|---|---|---|
| 1 | **番人**：危険な操作の前に、エージェントを止めます | ✅ 完了 |
| 2 | **道案内**：`doctor` が初心者を五つの関所で案内します。エージェントが、古いプロジェクトへの入れ方を下書きします | 🚧 いま |
| 3 | **チームのコマンド**：コマンドラインからエージェント、タスク、マシンを追加、一覧、変更、削除します | 🚧 v0.1.2 を予定しています（[issue #823](https://github.com/yokoten-labs/yokoten/issues/823)）。チームのページはプレビューで、0.1 のリリースには入りません |
| 4 | **開発サイクル全体**：短い仕様から、開発、テスト、レビュー、リリース、保守まで | あとで |
| 5 | **横展**：一つのプロジェクトの教訓がチェックになり、そのチェックがすべてのプロジェクトに広がります | 目標 |

今日の作業は、[issue](https://github.com/yokoten-labs/yokoten/issues) と [マイルストーン](https://github.com/yokoten-labs/yokoten/milestones) にあります。

## もっと知る

- **[ガイド](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/ja/guide.md)**：12 のルール、すべてのコマンド、仕組み、そしてできないことです。
- **[決定記録](https://github.com/yokoten-labs/yokoten/tree/main/docs/records)**：なぜこう作ったのか。
- **[変更履歴](https://github.com/yokoten-labs/yokoten/blob/main/CHANGELOG.md)**、**[コントリビュート](https://github.com/yokoten-labs/yokoten/blob/main/CONTRIBUTING.md)**、**[セキュリティ](https://github.com/yokoten-labs/yokoten/blob/main/.github/SECURITY.md)**、**[サーバーの設定](https://github.com/yokoten-labs/yokoten/blob/main/docs/server.md)**。

---

<p align="center"><sub>MIT · <a href="https://coolwhite.us/">coolwhite</a> と AI エージェントのチームが作りました。工場の現場から学んだ教訓とともに。</sub></p>
