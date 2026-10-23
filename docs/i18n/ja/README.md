<!-- source: README.md -->
<div align="center">

# yokoten · 横展

### どの AI エージェントにも、同じルールを。

AI でコードを書くのは安くなりました。管理は違います。yokoten は、どのベンダーのエージェントにもあなたのルールを守らせ、チーム全体を一つのボードに出します。決めるのはあなたです。

AI が書いたコードにとっての yokoten は、電気製品にとっての UL 認証のようなものです。製品は作らず、どのメーカーにも同じ安全基準を守らせます。

**[yokoten.app](https://yokoten.app/?from=github)** &nbsp;·&nbsp; [English](https://github.com/yokoten-labs/yokoten/blob/main/README.md) | [简体中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-CN/README.md) | [繁體中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-TW/README.md) | 日本語

[![ci](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml/badge.svg)](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/yokoten-labs/yokoten/blob/main/LICENSE)
[![npm](https://img.shields.io/npm/v/yokoten?logo=npm)](https://www.npmjs.com/package/yokoten)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.23.4-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

</div>

<sub>このページは英語版からの翻訳です。不自然な表現や誤りに気づいたら、issue や pull request で教えてください。</sub>

## 何をするか

yokoten は、今使っているエージェントの上に、三つのことを足します。フックもサンドボックスも設定も、各エージェント自身のものを使います。別の仕組みには取り替えません。

1. **どのエージェントにも、同じルール。** 番人が、コマンドと編集を実行前に見ます。force push、リリースタグ、コミットチェックの省略、修正タスクでのテスト書き換え、エージェントが投稿する内容に含まれる秘密情報や個人情報は止めます。なぜダメか、代わりに何をすればよいかも、エージェントに伝えます。
2. **ルールは、各エージェント自身の形で。** `yokoten init` が、対応しているエージェントごとにフックを書き、Claude Code、Codex、Gemini CLI、Grok にはサンドボックスの設定も書きます。エージェントがいなくても、コミットのチェックと CI が、問題のある変更を止めます。
3. **エージェントのチームのためのボード。** ベンダーが違っても、エージェントはそれぞれ囲われたデスクで並んで働きます。一つのページで、全員の様子が分かります。

## インストール

必要なのは [Node](https://nodejs.org/) 22.23.4 以降だけです（Node 24 は 24.22.1 以降、Node 26 は 26.12.1 以降）。他には何も要りません。

```sh
npx yokoten install      # PC ごとに一度
cd your-project
npx yokoten init         # プロジェクトごとに一度
npx yokoten doctor       # 今いる関所と、次の一手
```

Claude Code ではプラグインも使えます。`/plugin marketplace add yokoten-labs/yokoten` を実行し、続いて `/plugin install yokoten@yokoten` を実行します。プラグインと `npx` は、どちらか片方だけにしてください。[どのバージョンを入れるか](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#which-version-to-install)を選べます。Stable（既定）、Beta、Dev です。CI だけで使うときは、[GitHub Action として使えます](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#use-it-as-a-github-action)。コミットのチェックは、時刻が UTC であることを求めます。シェルの設定ファイルに `export TZ=UTC` を一度書いておいてください。

## 見えるもの

エージェントが force push を試すと、yokoten が止めます。理由と直し方も示します。そのあと `doctor` が、次の一手を一つ挙げます。

<img src="https://raw.githubusercontent.com/yokoten-labs/yokoten/main/docs/assets/demo.svg" width="680" alt="ターミナル。エージェントが git push --force origin main を実行すると、yokoten のフックがそれを止め、何が起きたか、なぜ危険か、直し方（--force-with-lease を使う）を示します。続いて yokoten doctor が 5 段階中の第 1 段階にいることを示し、次の一手としてテストの追加を挙げます。">

## エージェントのチームを動かす

yokoten 自身も、このようなチームで作っています。リードのエージェントが計画とレビューをし、別々のベンダーのエンジニアが issue を一つずつ受け持ちます。

- **エンジニアごとに、一つのデスク。** `yokoten desk` は、エージェントを自分のクローンで起動します。ネットワークは、そのエージェント自身の API 以外にはつながりません。トークンは渡さず、あなたのホームフォルダは隠します。プッシュはできません。自分が従うルールも変えられません。
- **ボットがプルリクエストを開きます。** どのプルリクエストにも、リスクの大きさ（ティア A、B、C）が書いてあります。リスクの高いものは、あなたの承認を待ちます。チェックが緑になるまで、マージはできません。
- **一つのボード。** `yokoten board` は、あなたのコンピューターでページを出します。各エージェントが何をしているか、各プルリクエストが「作成」「チェック」「あなた（ティア A のみ）」「マージ」のどこにいるか、あなたの対応が必要なことが分かります。スマートフォンでも使え、四つの言語で表示します。インターネットからは何も読み込みません。

ボードとデスクは `main` にあります。次のリリースで npm に入ります。

## 対応しているもの

**エージェント。** 番人は、Claude Code、Codex CLI、GitHub Copilot CLI、Antigravity CLI、Muse Code、DeepSeek Harness、Grok CLI で動きます。Gemini CLI は一覧にありますが、端から端まではまだ確認していません。[エージェント表](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#works-with)に、それぞれの試し方が書いてあります。

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
| 3 | **チーム、どのツールでも、どのホスティングでも**：どのベンダーのエージェントも、一つのルールと一つのボードの下で働きます。GitHub、Gitea、GitLab | 🚧 チームのボードはいま、Meta のハッカソンの頃。次は Windows と Gitea |
| 4 | **開発サイクル全体**：短い仕様から、開発、テスト、レビュー、リリース、保守まで | あとで |
| 5 | **横展**：一つのプロジェクトの教訓がチェックになり、そのチェックがすべてのプロジェクトに広がります | 目標 |

今日の作業は、[issue](https://github.com/yokoten-labs/yokoten/issues) と [マイルストーン](https://github.com/yokoten-labs/yokoten/milestones) にあります。

## もっと知る

- **[ガイド](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md)**：12 のルール、すべてのコマンド、仕組み、そしてできないことです。
- **[決定記録](https://github.com/yokoten-labs/yokoten/tree/main/docs/records)**：なぜこう作ったのか。
- **[変更履歴](https://github.com/yokoten-labs/yokoten/blob/main/CHANGELOG.md)**、**[コントリビュート](https://github.com/yokoten-labs/yokoten/blob/main/CONTRIBUTING.md)**、**[セキュリティ](https://github.com/yokoten-labs/yokoten/blob/main/.github/SECURITY.md)**、**[サーバーの設定](https://github.com/yokoten-labs/yokoten/blob/main/docs/server.md)**。

---

<p align="center"><sub>MIT · <a href="https://coolwhite.us/">coolwhite</a> と AI エージェントのチームが作りました。工場の現場から学んだ教訓とともに。</sub></p>
