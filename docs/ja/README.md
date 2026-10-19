<!-- source: README.md -->
<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/banner-dark.svg">
  <img src="../assets/banner-light.svg" width="100%" alt="yokoten · 横展。旅路には道しるべを。橋には番人を。山あいを登る一本の道が、番号のついた五つの関所を越えて橋へ続き、橋のたもとでは灯籠が見張っている。">
</picture>

<br/>

**誰でも、良いチームのやり方でソフトウェアを作れる。**<br/>
yokoten は良いチームの習慣を一歩ずつ身につける道案内です。慣れるまでの間は、AI エージェントの番人も務めます。

yokoten 自体も、ひとりの開発者と数体の AI エージェントがこのやり方で作りました。issue もレビューもリリースも、すべてこのリポジトリに残っています。

**[yokoten.app](https://yokoten.app)** &nbsp;·&nbsp; [English](../../README.md) | [中文](../zh-CN/README.md) | 日本語

<sub>このページは英語版からの翻訳です。不自然な表現や誤りに気づいたら、issue や pull request で教えてください。</sub>

<br/>

[![ci](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml/badge.svg)](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml)
[![built with Claude Code](https://img.shields.io/badge/built%20with-Claude%20Code-D97757?logo=claude&logoColor=white)](https://claude.com/claude-code)
[![TypeScript](https://img.shields.io/badge/TypeScript-no%20build-3178C6?logo=typescript&logoColor=white)](../records/0002-typescript.md)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.18-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](../../package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE)

どの AI エージェントでも、エージェントなしでも使えます。コミットのチェックと CI が、誰の変更でも問題を止めます。<br/>
[Claude Code、Codex CLI、GitHub Copilot CLI、Antigravity CLI、Muse Code、DeepSeek Harness](../guide.md#works-with) では、危ない操作を実行前に止めます。

</div>

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

最初のコミットの前に：`TZ=UTC git commit` でコミットするか、シェルの設定ファイルに `export TZ=UTC` を一度書いておいてください。
コミットチェックは UTC 以外のタイムゾーンを通しません。コミットのタイムゾーンから、住んでいる地域がおおよそ分かってしまうからです。

Claude Code ではプラグインとしても使えます。`/plugin marketplace add yokoten-labs/yokoten` のあとに
`/plugin install yokoten@yokoten` を実行してください。どちらか片方だけを使い、両方は入れないでください。
最初のリリースが npm に出るまでは、[clone からインストール](../guide.md#install-from-a-clone)できます。
CI だけで使うなら、[GitHub Action として使う](../guide.md#use-it-as-a-github-action)方法もあります。

## 実際の動き

エージェントが force push しようとすると、yokoten が止めて、理由と直し方を示します。続いて `doctor` が次にやるべきことをひとつ挙げます。

<img src="../assets/demo.svg" width="680" alt="ターミナル。エージェントが git push --force origin main を実行すると、yokoten のフックがそれを止め、何が起きたか、なぜ危険か、直し方（--force-with-lease を使う）を示す。続いて yokoten doctor が 5 段階中の第 1 段階にいることを示し、次の一手としてテストの追加を挙げる。">

## これから目指す場所

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/road-dark.svg">
  <img src="../assets/road-light.svg" width="100%" alt="一本の道が山を登り、現在、ハッカソン、その次という三つの駅を通り過ぎる。頂上近くで、他のプロジェクトからの道が合流する。頂上には夢を記した旗が立っている。誰でも、良いチームのやり方でソフトウェアを作れる。">
</picture>
</p>

番人の機能はできあがりました。道案内は今まさに作っています。その次は対応するエージェントとホスティングを増やし、さらに開発サイクル全体へ広げます。
頂上にあるのが*横展*です。ひとつのプロジェクトが学んだことを、すべてのプロジェクトが受け取れます。
五つの段階は[ロードマップ](../guide.md#where-this-is-going)に、今日の作業は[ボード](https://github.com/orgs/yokoten-labs/projects/1)にあります。

## もっと知る

- **[yokoten.app](https://yokoten.app)**：公式サイト。ガイドと決定記録もページとして読めます。
- **[ガイド](../guide.md)**：12 のルール、すべてのコマンド、仕組み、そしてできないこと（英語）。
- **[サーバーの設定](../server.md)**：GitHub で `main` とリリースタグを保護する（英語）。
- **[決定記録](../records/)**：なぜこう作ったのか（英語）。
- **[コントリビュート](../../AGENTS.md)**：yokoten の開発に参加するときのルール（英語）。
- **[セキュリティ](../../.github/SECURITY.md)**：セキュリティ上の問題の報告方法（英語）。

---

<p align="center"><sub>MIT · <a href="https://coolwhite.us/">coolwhite</a> が作りました。工場の現場から学んだ教訓とともに。</sub></p>
