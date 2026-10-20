<!-- source: README.md -->
<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/banner-dark.svg">
  <img src="../../assets/banner-light.svg" width="100%" alt="yokoten · 横展。旅路には道しるべを。橋には番人を。山あいを登る一本の道が、番号のついた五つの関所を越えて橋へ続き、橋のたもとでは灯籠が見張っている。">
</picture>

<br/>

**誰でも、良いチームのやり方でソフトウェアを作れる。**

あなたと AI エージェントのための、道案内と番人。

**[yokoten.app](https://yokoten.app/?from=github)** &nbsp;·&nbsp; [English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | 日本語

[![ci](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml/badge.svg)](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](../../../LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.18-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

</div>

<sub>このページは英語版からの翻訳です。不自然な表現や誤りに気づいたら、issue や pull request で教えてください。</sub>

## どのエージェントでも使える

次のエージェントでは、危ない操作を実行前に番人が止めます（[それぞれの設定方法](../../guide.md#works-with)、英語）。

- Claude Code
- Codex CLI
- GitHub Copilot CLI
- Antigravity CLI
- Muse Code
- DeepSeek Harness

ほかのエージェントでも、エージェントなしでも、コミットのチェックと CI が問題のある変更を止めます。

## なぜ作ったのか

良いチームでは、どの変更にも理由があり、テストがあり、レビューを通っています。
こうした習慣は、何年もかけて、たいていは何かを壊してから身につくものです。
yokoten があれば、初心者でも初日からこの習慣を実践できます。計画、開発、テスト、レビュー、リリースと、一度にひとつの関所ずつ進みます。
force push、テストを書き換えて通す、個人情報の公開といった致命的なミスは、AI エージェントが実行する前に番人が止めます。

学んだ教訓は、ひとつのプロジェクトに閉じ込めません。*横展*（横展開、よこてんかい）はトヨタの工場で生まれた言葉で、あるラインで見つけた対策をすべてのラインに広げることを指します。
あるプロジェクトが教訓を得たら、yokoten はそのチェックを他のすべてのプロジェクトに届けます。

## インストール

必要なのは [Node](https://nodejs.org/) 22.18 以降だけです。

```sh
npx yokoten install      # PC ごとに一度
cd your-project
npx yokoten init         # プロジェクトごとに一度
npx yokoten doctor       # 今いる関所と、次の一手
```

npm での最初のリリース（10 月 24 日）までは、[clone からインストール](../../guide.md#install-from-a-clone)してください（英語）。

### 知っておくと良いこと

- **コミットは UTC で。** `TZ=UTC git commit` でコミットするか、シェルの設定ファイルに `export TZ=UTC` を一度書いておきます。
  コミットのタイムゾーンから住んでいる地域がおおよそ分かってしまうので、コミットチェックは UTC だけを通します。
- **Claude Code ならプラグインでも入れられます。** `/plugin marketplace add yokoten-labs/yokoten` のあとに
  `/plugin install yokoten@yokoten` を実行します。プラグインと `npx` はどちらか片方だけにしてください（[詳しく](../../guide.md#the-claude-code-plugin)、英語）。
- **CI だけで使うなら**、[GitHub Action として使えます](../../guide.md#use-it-as-a-github-action)（英語）。

## 実際の動き

エージェントが force push しようとすると、yokoten が止めて、理由と直し方を示します。続いて `doctor` が次にやるべきことをひとつ挙げます。

<img src="../../assets/demo.svg" width="680" alt="ターミナル。エージェントが git push --force origin main を実行すると、yokoten のフックがそれを止め、何が起きたか、なぜ危険か、直し方（--force-with-lease を使う）を示す。続いて yokoten doctor が 5 段階中の第 1 段階にいることを示し、次の一手としてテストの追加を挙げる。">

## これから目指す場所

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/road-dark.svg">
  <img src="../../assets/road-light.svg" width="100%" alt="一本の道が山を登り、現在、ハッカソン、その次という三つの駅を通り過ぎる。頂上近くで、他のプロジェクトからの道が合流する。頂上には夢を記した旗が立っている。誰でも、良いチームのやり方でソフトウェアを作れる。">
</picture>
</p>

番人の機能はできあがりました。道案内は今まさに作っています。その次は対応するエージェントとホスティングを増やし、さらに開発サイクル全体へ広げます。
頂上にあるのが*横展*です。ひとつのプロジェクトが学んだことを、すべてのプロジェクトが受け取れます。
五つの段階は[ロードマップ](../../guide.md#where-this-is-going)に、今日の作業は[ボード](https://github.com/orgs/yokoten-labs/projects/1)にあります。

## もっと知る

- **[yokoten.app](https://yokoten.app/?from=github)**：公式サイト。ガイドと決定記録もページとして読めます。
- **[ガイド](../../guide.md)**：12 のルール、すべてのコマンド、仕組み、そしてできないこと（英語）。
- **[サーバーの設定](../../server.md)**：GitHub で `main` とリリースタグを保護する（英語）。
- **[決定記録](../../records/)**：なぜこう作ったのか（英語）。
- **[コントリビュート](../../../AGENTS.md)**：yokoten の開発に参加するときのルール（英語）。
- **[セキュリティ](../../../.github/SECURITY.md)**：セキュリティ上の問題の報告方法（英語）。

---

<p align="center"><sub>MIT · <a href="https://coolwhite.us/">coolwhite</a> が作りました。工場の現場から学んだ教訓とともに。</sub></p>
