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

<sub>このページは英語版からの翻訳です。不自然な表現や誤りに気づいたら、issue や pull request で教えてください。</sub>

## 何をするか

五つの保護が、設定なしで、誰にでも最初から有効です。
エージェントには、次の五つができません。

1. **作業を失わせること。** force push も、hard reset も、`.git` や履歴の削除もできません。
2. **秘密を漏らすこと。** コミットや投稿に、鍵、トークン、メールアドレス、ホームのパスを入れられません。
3. **あなたに代わって公開すること。** タグ、リリース、パッケージの公開と、リポジトリの公開はできません。いつ公開するかは、あなただけが決めます。
4. **ネットのコードを、読まずに実行すること。** ダウンロードをシェルへ流し込めません。
5. **この保護を外すこと。** CI、フック、ルールを止められません。ルールの変更を開くのは、あなただけです。

番人は目に見えません。何も入力しなくても働きます。
人が打つコマンドはわずかです。例えば `yokoten install` と `yokoten doctor` です。
チーム用のコマンドは次です。v0.1.2 で来ます。
このリリースにはありません。
コマンドラインから、エージェント、タスク、マシンを追加、一覧、変更、削除できるようになります。

保護を最初に試したのは Claude Code と Muse です。
OpenCode（DeepSeek）、Codex、Grok、Gemini はコードにあり、いま試しています。
すべてのエージェントが終わったとは、まだ言えません。

yokoten が止めたとき、コードを書かない人でも、その答えで動けます。
止めたこと、理由、AI に伝える一文、自分で実行するコマンド、それからルールが分かります。

```
yokoten はこれを止めました: タグ v1.2.0 の作成。
理由: タグはリリースを公開します。いつ公開するかは、あなただけが決めます。
AI に伝えてください: 「このリリースは自分で公開します。」
または自分で実行: git tag v1.2.0
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

`npx skills add yokoten-labs/yokoten` はスキルだけをコピーします。`npx yokoten install` も実行してください。そうしないと、コマンドの番人も、セッションの doctor もありません。

## 見えるもの

エージェントが force push を試すと、yokoten が止めます。理由と直し方も示します。そのあと `doctor` が、次の一手を一つ挙げます。

<img src="https://raw.githubusercontent.com/yokoten-labs/yokoten/main/docs/assets/demo.svg" width="680" alt="ターミナル。エージェントが git push --force origin main を実行すると、yokoten のフックがそれを止め、何が起きたか、なぜ危険か、直し方（--force-with-lease を使う）を示します。続いて yokoten doctor が 5 段階中の第 1 段階にいることを示し、次の一手としてテストの追加を挙げます。">

## この次

チーム用のコマンドは v0.1.2 で来ます。
コマンドラインから、エージェント、タスク、マシンを追加、一覧、変更、削除できるようになります。
チームのページはプレビューです。
0.1 のリリースには入っていません。

## 対応しているもの

**エージェント。** 最初に試したのは Claude Code と Muse です。
OpenCode（DeepSeek）、Codex、Grok、Gemini はコードにあり、いま試しています。
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
| 3 | **チームのコマンド**：コマンドラインからエージェント、タスク、マシンを追加、一覧、変更、削除します | 🚧 v0.1.2 で来ます。チームのページはプレビューで、0.1 のリリースには入りません |
| 4 | **開発サイクル全体**：短い仕様から、開発、テスト、レビュー、リリース、保守まで | あとで |
| 5 | **横展**：一つのプロジェクトの教訓がチェックになり、そのチェックがすべてのプロジェクトに広がります | 目標 |

今日の作業は、[issue](https://github.com/yokoten-labs/yokoten/issues) と [マイルストーン](https://github.com/yokoten-labs/yokoten/milestones) にあります。

## もっと知る

- **[ガイド](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md)**：12 のルール、すべてのコマンド、仕組み、そしてできないことです。
- **[決定記録](https://github.com/yokoten-labs/yokoten/tree/main/docs/records)**：なぜこう作ったのか。
- **[変更履歴](https://github.com/yokoten-labs/yokoten/blob/main/CHANGELOG.md)**、**[コントリビュート](https://github.com/yokoten-labs/yokoten/blob/main/CONTRIBUTING.md)**、**[セキュリティ](https://github.com/yokoten-labs/yokoten/blob/main/.github/SECURITY.md)**、**[サーバーの設定](https://github.com/yokoten-labs/yokoten/blob/main/docs/server.md)**。

---

<p align="center"><sub>MIT · <a href="https://coolwhite.us/">coolwhite</a> と AI エージェントのチームが作りました。工場の現場から学んだ教訓とともに。</sub></p>
