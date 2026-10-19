<!-- source: docs/guide.md -->
# yokoten 使用指南

[README](README.md) 是简短版。剩下的都在这里：yokoten 为什么要做、它怎么工作、有哪些规则和命令，还有它做不到的事。

## 一条赛道

**可以把它想成一条赛道。** AI 编程助手是一辆快车，yokoten 是它跑的那条赛道。护栏让一次失误不至于变成翻车，这是「守桥」；路线告诉你下一个弯怎么过，一次一关，这是「带路」；而每一次事故都会让所有赛道更安全：一个项目吃过的亏，会变成所有项目的检查，这就是「横展」。

## 先认识几个词

- **会话**：和 AI 编程助手（比如 Claude Code）的一次对话。
- **hook**：AI 工具在固定时刻自动运行的小程序。yokoten 加了三个：一个在每条命令、每次改
  文件之前运行（可以拦下来），一个在 AI 说完这一轮、准备停下时运行，一个在每次会话开头运行。
- **提交检查**：每次 git 提交前运行的检查（`.githooks/pre-commit`）。
- **CI**：GitHub 在每个 PR 上自动跑的检查。
- **规则集（ruleset）**：GitHub 上保护分支或 tag 的设置，比如「没有审查不能合并」。
- **主人、lead、worker**：主人就是你；lead 是跟你对话的那个 AI 会话；worker 是 lead 为某一个
  任务另开的会话。详见[像带团队一样管 agent](#像带团队一样管-agent)。
- **退出码**：命令结束时交回的一个数字。0 表示一切正常。脚本和 AI 靠它判断结果。
  详见[退出码](#退出码)。
- **JSON**：一种给程序读的纯文本数据格式。加上 `--json` 就输出这种格式。

## 名字的来历

「横展」（yokoten）是丰田车间里的说法：一条产线找到了某个缺陷的对策，不光这条线改，
所有可能出同样问题的产线都要跟着改。yokoten 把这件事搬到你的项目上：一个项目踩过的坑，
它会提醒别的项目先填上。

## 要解决的问题

你带着 AI 做一个项目，做了几个月，踩过不少坑：AI 为了让测试通过，直接把测试改了；
一个 PR 合并时带进了没人审过的提交；服务器地址被写进了仓库里的文件。每踩一次坑，你就加一条
规则、一个 hook、一项检查，这个项目越来越稳。

可是一开新项目，或者回到老项目，这些全都不在。这些经验只留在那个仓库里，和你的脑子里。
你忘了提，AI 就一切从头来。

yokoten 把这些经验写成规则，再配上会自己跑的检查：

- **每条规则都说得出为什么。** 一共 12 条核心规则。每条都写明为什么要有它：是真出过事，
  还是事还没出、先看到了风险；也写明由哪项检查守着。没有检查的规则只是愿望。
- **守卫自己会跑。** AI 要执行坏命令，工具调用 hook 先拦下；hook 看不到的，提交检查来抓；
  有的提交绕过了前两道，CI 再跑一遍同样的检查，把它兜住。
- **不用你记着提醒。** 每次会话一开头先跑 `doctor`，告诉 AI 这个项目走到了第几关、
  下一步做什么。AI 会主动跟你提，你不用记。

## 装上的第一天，有什么不同

| AI 想做的事 | 没有 yokoten | 有 yokoten |
|---|---|---|
| 强推（force push），或者自己打 tag 发版 | 直接就做了 | 还没执行就被拦下，并告诉它为什么 |
| 测试不过，就去改测试 | 测试通过了，bug 还在 | 修 bug 时不许改测试 |
| 提交里带上你的邮箱、服务器 IP、所在城市 | 被公开出去 | 提交被拦下；报告只指出哪个文件第几行，不把内容打出来 |
| 开 PR | 用你的账号开，权限和你一样大 | 用 bot 账号开；你不点头，什么都合不进去 |
| 换到另一个项目 | 一切从头来 | 看出这个项目缺什么，问你要不要补上 |

## 三道检查，一把锁

```mermaid
flowchart LR
  A["AI 执行命令<br/>或改文件"] --> H{{"1 · 工具调用 hook"}}
  H --> C["提交"] --> K{{"2 · 提交检查"}}
  K --> P["PR"] --> I{{"3 · CI"}}
  I --> R{{"锁 · 你的审查"}} --> M["main"]
```

| | 什么时候跑 | 拦下什么 |
|-|-----------|---------|
| **1** | 每次工具调用之前 | 推 tag、强制推送、跳过检查；修复任务里改测试；worker 改规则；项目禁用的程序 |
| **1b** | Claude Code 的 AI 准备结束这一轮时 | 改过的文件里有没有个人信息、密钥，有没有改了不该改的文件（和提交检查一样）。有问题就把它叫回来改一次 |
| **2** | 每次提交 | hook 看不到的：用 `sed` 或脚本改的文件、个人信息、超过 7 项的文件夹 |
| **3** | 每个 PR | 关掉 hook 做出来的提交 |
| **锁** | 服务器上 | 没经过你审查的合并、直接推 `main`、不是你打的发版 tag |

## 会话里看到的是什么

项目还没用上 yokoten 时，会话一开始，AI 会看到：

```
yokoten: stage 1 of 5, safety net. Next: no AGENTS.md, so the agents have no written rules here; `yokoten init` adds one.
Why: an agent follows the rules it can read, and only those.
Tell the user in plain words, one step at a time, and offer to do it (as-is, lighter, or not now with a reason).
```

会话里一次只说一步：在第几关、下一步做什么、为什么要做。第几关不存在哪里，每次都是看项目
里有哪些文件现算的。你说过「暂不」的步骤会跳过。顺序只是建议：后面关里的步骤提前做了，也算
做完。所有步骤都做完了，或者都说了「暂不」，会话里就只有一行，告诉你路走完了。

AI 会用你的语言跟你讲。yokoten 自己的提示用英文写，因为 AI 读英文最不容易出错。

`yokoten doctor` 会列出整条路。每一步标成 done（做完了）、next（下一步）、to do（还没做）、
not now（暂不，后面跟着你给的原因）或者 can't check（这里查不了）。yokoten 还查不了的步骤
先不列出来：

| 关 | 步骤 |
|---|---|
| **1 · 安全网** | `rules`、`tool-hook`、`commit-check`、`runtime`、`tests`（有测试命令，CI 会跑） |
| **2 · 先开 issue，再走 PR** | `ci`（CI 跑 `check`，或者用了 yokoten 的 Action）、`issues`（没有 todo 文件）、`templates`、`labels`（标准标签都在）、`milestone`（有一个没关的里程碑）、`no-build-output`（`dist/`、`build/`、`out/` 里没有提交的文件，也没有编译出来的二进制文件） |
| **3 · 发版** | `changelog`、`titles`（CI 跑 `check --pr`；用 Action 的话，要在 PR 上跑，而且没设 `pr-check: false`） |
| **4 · 带一支 AI 团队** | `codeowners`、`bot`、`skills`、`review`（合并到默认分支前要有一个人批准） |
| **5 · 公开** | `security-files`（安全说明、Dependabot、许可证）、`protection`（默认分支和 `v*` tag 上的规则集）、`merge-settings`（只许 squash 合并，合并后自动删分支）、`security-settings`（secret scanning、push protection、私下报告漏洞、Dependabot 提醒） |

后三步是服务器上的设置。完整的 `doctor` 用 `gh api` 去读，只读不改。
没装 `gh`、没登录、没网，或者远程仓库不在 GitHub 上，这三步就标 can't check，绝不会算作做完。
会话开头不联网，所以那里这三步总是 can't check。

第 2 关的 `labels` 和 `milestone` 也这样读。标准标签是 `bug`、`feat`、`docs`、`refactor`、`ci`、
`owner`、`incident`、`good first issue`、`hotfix`，还有三个 tier 标签 `tier A`、`tier B`、`tier C`。
`init` 会告诉你缺哪些，`init --github --yes` 帮你加上。

第 4 关的 `review` 也这样读服务器。默认分支的规则集（或者分支保护）要求至少一个批准，这一步就算做完。
GitHub 不让你批准自己开的 PR，所以让 bot 来开 PR，你来批准、合并。
设置方法：编辑默认分支上的规则集，在“Require a pull request”里把“Required approvals”设成 1。
另外，Settings → Actions → General 里的“Allow GitHub Actions to create and approve pull requests”要一直关着。
它要是开着，bot 推一个 workflow 就能批准它自己开的 PR，所以 `review` 不算做完。
批准设好以后，合并的人不是写代码的人，OpenSSF Scorecard 应该会把每次改动算作审过。
这是我们从 Scorecard 文档里读到的，还没在真正跑一次 Scorecard 时验证过。
免费账号的私有仓库没有规则集，这时 `review` 标 can't check，等到第 5 关仓库公开时再做。
它不标 not now，因为 not now 只留给你自己做的决定。

如果某一步对应外部的标准，`yokoten doctor` 会在步骤名后面写出来，比如 `ci (Scorecard: CI-Tests)`。
会话开头那三行不写。

为什么这样分，见[决定记录 0004](../records/0004-the-road.md)。

这个仓库自己也在走这条路，每一关你都能直接看它怎么运转：

| 关 | 学会什么 | 在这里看 |
|---|---|---|
| **1 · 安全网** | AI 要读的规则，以及规则管不住时拦下它的检查 | [AGENTS.md](../../AGENTS.md) |
| **2 · 先开 issue，再走 PR** | 每次改动先开 issue 说清为什么；CI 通过了才合并；用标签、里程碑（milestone）和看板管起来 | [issue](https://github.com/yokoten-labs/yokoten/issues?q=is%3Aissue)、[PR](https://github.com/yokoten-labs/yokoten/pulls?q=is%3Apr)、[看板](https://github.com/orgs/yokoten-labs/projects/1) |
| **3 · 发版** | 写明改了什么、为什么改的提交信息；CHANGELOG；每次发版一个版本号 | [CHANGELOG.md](../../CHANGELOG.md) |
| **4 · 带一支 AI 团队** | bot 开 PR，worker 领任务，reviewer 审查；最后拍板的永远是你 | [像带团队一样管 agent](#像带团队一样管-agent) |
| **5 · 公开** | 把全部提交历史查一遍，看有没有漏出隐私；打开安全设置；保护 `main` 分支 | [安全说明](../../.github/SECURITY.md) |

AI 想推送发版 tag 时，会看到：

```
yokoten: git push --tags pushes tags. Only the owner decides when to release. If the owner asked for this, they start a new session with YOKOTEN_RELEASE_APPROVAL=1 (`YOKOTEN_RELEASE_APPROVAL=1 claude`); do not look for another way.
  docs: https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#the-core-rules
```

（提示用英文写，因为 AI 读英文最不容易出错。）

每条提示都是同样的三段：**出了什么事**（what）、**为什么要紧**（why）、**怎么改**（fix，
一条命令或者一处改动）。问题出在某个文件里时，开头先写位置：`文件:行号:`。查到问题时，
只说是哪一类，不说内容：密钥、私有词表里的词，都不会打印出来。如果指南里有一节专门讲这条
规则，提示最后会另起一行，给出那一节的链接：`docs: <链接>`。

想知道某条规则为什么存在，就跑 `yokoten explain <id>`。id 就是规则或步骤的名字，比如
`secret`、`commit-check`。不写 id，或者写了一个不存在的，它会把所有 id 列出来。

```
$ yokoten explain force-push
force-push: no plain force push (core rule 7).
Why: a plain force push can throw away work that someone else pushed.
Check: the tool-call guard stops `git push --force`, `-f` and a `+ref`; `--force-with-lease` passes; a branch ruleset on the server is the lock.
Docs: https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#the-core-rules
```

## 四层

| 层 | 管什么 | 怎么装 |
|----|--------|--------|
| **机器** | 技能、agent 定义、两个用户级 hook，每台电脑都一样 | `yokoten install`，或者 Claude Code 插件 |
| **项目** | 规则、提交检查、工具调用 hook、CI、issue 和 PR 模板、Dependabot（每月一个 PR）、安全说明 | `yokoten init`；老项目再用 `yokoten` 技能 |
| **服务器** | 分支和 tag 规则集、squash 合并、代码负责人、权限受限的 bot、几个安全开关 | 由仓库主人设置一次；`doctor` 会列出步骤 |
| **规则** | `AGENTS.md`：12 条核心规则，加上项目自己的规则 | 每条规则都写明由哪项检查守着 |

老项目不是一张白纸，有些习惯比 yokoten 的还好。所以 `yokoten` 技能会跟你一条一条过，每条
做法都由你定：**照搬**、**减量**（说清去掉了哪部分），或者**暂不**（写明原因，以及什么
时候再看）。「暂不」会写进 `yokoten.json`，`doctor` 就不再追问。

### 先拿一份草稿

`yokoten adopt` 会在你们开始过之前先把这张表填个初稿。它读项目里的文件，逐条写出项目现在的
情况：**已有**、**没有**、**部分有**（项目有自己的做法，比如用 husky 管提交 hook，或者
有 CI 但没跑 yokoten），或者**不清楚**（这一步在这里查不了，比如服务器上的设置，要跑
`yokoten doctor` 才看得到）。然后让模型给每一条提一个建议，附一句理由。

- 模型只拿到这些简短的情况说明，拿不到文件内容。
- 发出去之前，yokoten 先对要发的内容做一遍隐私检查。查到问题就什么都不发。
- 没有 key、调用失败、或者模型的回答不合格式时，改用固定规则出草稿：已有或没有的，照搬；
  部分有的，减量；不清楚的，先用 `doctor` 查一下，再照搬。输出会写明是谁出的草稿。
- `adopt` 不改任何文件。每一条最后还是你来定。
- 部分有的那几条，跑 `init` 也不会被冲掉：它会让 `CLAUDE.md` 引入 `AGENTS.md`，也会把
  提交检查加进 husky 的 `pre-commit`。

用的是 Meta 的模型 API，走它兼容 OpenAI 的接口（`https://api.meta.ai/v1`，模型是
`muse-spark-1.3`）。把 key 设到 `LLAMA_API_KEY` 或 `MODEL_API_KEY` 里。想换成别家兼容 OpenAI 的接口和模型，设 `LLAMA_API_BASE` 和 `LLAMA_MODEL`。

## 支持哪些 agent

yokoten 能管住三种 AI 编程 agent，它们守的是同一套规矩。

| Agent | yokoten 给它加了什么 |
|---|---|
| Claude Code | 工具调用拦截（钩子）、收尾检查（钩子）、每次会话开头的带路提示、skills 和 agents |
| Codex CLI | 工具调用拦截和收尾检查，写在 `.codex/hooks.json`；会话开头的带路提示和命令守卫，写在 `~/.codex/hooks.json`。`apply_patch` 要改哪些文件，守卫都会查，在 shell 里跑的也查 |
| Gemini CLI | 工具调用拦截和收尾检查（AfterAgent），写在 `.gemini/settings.json`；会话开头的带路提示和命令守卫，写在 `~/.gemini/settings.json` |
| 其他 agent | `AGENTS.md` 里的规则；还有提交检查，不管是谁提交的，坏提交都会被拦下 |

项目里的钩子由 `init` 写，用户级的由 `install` 写。每个工具都要你先信任，钩子才会跑：

- **Codex**：项目要先设成信任，项目钩子才会跑。然后在 `/hooks` 里逐个批准。Codex 记的是
  命令本身，命令一改，就得重新批准。
- **Gemini CLI**：文件夹要先设成信任，项目钩子才会跑。要在仓库根目录启动 Gemini：它只读
  启动时所在文件夹里的 `.gemini/settings.json`。新加或改过的钩子，第一次跑之前它会提醒你一次。

worker 靠 `YOKOTEN_ROLE=worker` 认出来。在 Codex 里，子 agent 的 `agent_type` 带 worker
字样的，也算 worker。Gemini CLI 开了严格的环境变量清理后，钩子里拿不到 `YOKOTEN_ROLE`。
这时 yokoten 在 Gemini CLI 里分不出谁是 worker：每个会话都当成 lead，只有 lead 能改的
文件，worker 改了也拦不住。服务器上的锁照样有效：代码负责人，还有一个改不了 CI 的 bot。

## 安装和命令

需要 Node 22.18 或更高版本：它能直接运行 TypeScript，不用先编译。没有任何依赖。
装法有两种：一种是 Claude Code 插件，一种是 `install` 命令（从 npm 跑，或者从 clone
下来的仓库跑）。选一种就行，别两种都装。yokoten 写进去的 hook 命令要在 POSIX shell 里跑，
Windows 上请用 Git Bash。

### 用 Claude Code 插件装

在 Claude Code 里输入：

```text
/plugin marketplace add yokoten-labs/yokoten
/plugin install yokoten@yokoten
```

第一条把这个仓库加成插件市场，第二条打开插件页面，选「Install for you」（给自己装，
所有项目都能用）。不进 Claude Code 也行，在终端里先跑
`claude plugin marketplace add yokoten-labs/yokoten`，再跑 `claude plugin install yokoten@yokoten`。

插件就是这个仓库本身。它用的文件和 `install` 复制的是同一份，所以两种装法不会越走越不一样：

| 插件带来的 | 来自 |
|---|---|
| 技能：`/yokoten:dispatch`、`/yokoten:inspect`、`/yokoten:rca`、`/yokoten:record`、`/yokoten:release`、`/yokoten:yokoten` | `kit/user/skills/` |
| agent：`yokoten:worker`、`yokoten:reviewer`、`yokoten:verifier` | `kit/user/agents/` |
| `/yokoten:init`、`/yokoten:doctor` 和 `/yokoten:update`：直接用插件里的 yokoten 跑这几个命令 | `kit/plugin/skills/` |
| 会话开头跑 `doctor` 的 hook 和命令守卫，跟 `install` 加的两个一样 | `.claude-plugin/plugin.json` |

Claude Code 用 `node` 直接跑插件里的 `.ts` 文件。之所以能跑，是因为插件不放在
`node_modules` 下面（Node 不处理 `node_modules` 里的 TypeScript）。想更新，就打开 `/plugin`，
在 **Installed** 里选 yokoten，点 **Update now**。别人做的插件市场默认不自动更新，要自己打开。在终端里跑
`claude plugin update yokoten@yokoten` 也一样，跑完要重启 Claude Code。插件要是比跑 `doctor`
的这份 yokoten 旧，`doctor` 会提醒你。

插件只管 Claude Code。它不会帮你建私有词表文件：`doctor` 会告诉你文件在哪，你自己建。
插件在你的用户设置里开着的时候，`doctor` 就把它的 hook 和技能算作已经装好。

### 用 npx 装

用 Codex CLI、Gemini CLI，或者不想用插件，就这样装：

```sh
npx yokoten install      # 这台电脑：技能、agent、hook
cd your-project
npx yokoten init         # 这个项目：只加文件，不覆盖
npx yokoten doctor       # 看看走到哪一关，下一步做什么
```

`npx` 会先把包下载下来再运行。这个包没有任何依赖。`install` 和 `init` 会把 yokoten
的运行文件从包里拷出来，一份放到 `~/.local/share/yokoten`，一份放到项目的 `.yokoten/`。
hook 跑的是这两份拷贝，所以不用联网，也不用再经过 `npx`。

npm 上的包跑的是编译好的 JavaScript，因为 Node 不处理 `node_modules` 里的 TypeScript。
仓库本身还是不用编译，只有 `npm pack` 打包的时候才生成 `dist/`
（见[记录 0008](../records/0008-npm-package.md)，英文）。

发布到 npm 是主人的事，跟打发版 tag 一样。tag 一推上去，发布 workflow 就开始跑：先跑检查，
然后发布那一步停下来，等主人在 `release` 环境里点批准，批准了才发到 npm。整个过程不存任何
npm token（见[记录 0009](../records/0009-release-environment.md)，英文）。只有第一个版本例外，
由主人手动发布：npm 上还没有这个包的时候，没法设置信任哪个 workflow。第一个版本发布之前，先
[从 clone 下来的仓库装](#从-clone-下来的仓库装)。

### 从 clone 下来的仓库装

命令一样，只是从 clone 下来的仓库跑。npm 上还没有第一个版本的时候，就用这种装法：

```sh
git clone https://github.com/yokoten-labs/yokoten
node yokoten/bin/yokoten.ts install      # 这台电脑：技能、agent、hook
cd your-project
node ~/.local/share/yokoten/bin/yokoten.ts init     # 这个项目：只加文件，不覆盖
node ~/.local/share/yokoten/bin/yokoten.ts doctor   # 看看走到哪一关，下一步做什么
```

这样装完，PATH 里没有 `yokoten` 这个命令，可 yokoten 的提示里写的都是 `yokoten init`、
`yokoten doctor`。所以 `install` 最后会打出下面这一行，你自己把它加进 shell 配置文件
（`~/.bashrc` 或 `~/.zshrc`），再开一个新的终端就能用了：

```sh
alias yokoten='node ~/.local/share/yokoten/bin/yokoten.ts'
```

yokoten 不会去改你的 shell 配置文件。要是 PATH 里已经有一个 `yokoten` 跑的就是这一份，
`install` 就不打这一行。

这些命令（包括上面 npx 那几条）在 [docs/facts.json](../facts.json) 里还有一份，网站读的是那份，所以改命令的时候两边都要改。

### 当成 GitHub Action 用

GitHub 上的任何仓库，加一个 workflow 文件，就能在 CI 里跑 yokoten 的检查。仓库里不用装
任何东西，数据也不会离开这次 CI：不用令牌，不连外面的服务。

```yaml
# .github/workflows/yokoten.yml
name: yokoten
on:
  pull_request:
    # 有了 edited、labeled、milestoned，改完标题或标签，check --pr 会再跑一遍。
    types: [opened, edited, synchronize, reopened, labeled, unlabeled, milestoned, demilestoned]
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  yokoten:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: yokoten-labs/yokoten@<完整的 commit SHA>
```

这个 action 先装好 Node，再跑 `check`；如果是 PR，还会接着跑 `check --pr`。查出来的问题
会标在 PR 页面上，跟 yokoten 自己的 CI 一样。

它认这三种事件：

- **`push`**：跑 `check`。
- **`pull_request`**：先跑 `check`，再跑 `check --pr`。
- **`issues`**：先跑 `check`，再跑 `check --issue` 查 issue 标题。要在 `on:` 下面加上
  `issues: types: [opened, edited]` 才会触发。

`pull_request_target` 拉下来的是目标分支，不是 PR 本身的代码，所以 action 不跑
`check --pr`，只留一条提示：PR 检查要用 `pull_request` 触发，不是 `pull_request_target`。

- **版本要钉死。** 写完整的 commit SHA。写 `@main` 这种分支名，哪天内容变了你都不知道。
  等发布了正式版本，也可以写版本标签。
- **checkout** 要加 `fetch-depth: 0`。`check --pr` 要比较 PR 的起点和最新提交，两个都得拉下来。
- **权限**只要 `contents: read`。这个 action 不要令牌。
- **参数**有三个：`pr-check`（默认 `true`）、`issue-check`（默认 `true`）和 `node-version`
  （默认 `22`，最低 22.18）。不想查 PR 的格式，就写 `pr-check: false`；不想查 issue 标题，
  就写 `issue-check: false`。
- **Node**：action 装的 Node，这个 job 后面的步骤也会用到。

`check --pr` 按核心规则第 8 条检查 PR。还没按这条规则走的仓库，可以先写 `pr-check: false`。
Dependabot 开的 PR 只查标题，其他几条只提醒、不算失败，因为它的正文是 Dependabot 自己写的。
kit 里 `init` 放的 workflow 暂时还是跑 `.yokoten/` 里的那份，等第一个正式版本发布以后再换成
这个 action，这样就不会依赖 `@main`。

### 命令

`init` 会把 yokoten 运行要用的文件复制到项目的 `.yokoten/` 里。把它一起提交：这样不联网、
不全局安装，hook 和 CI 也能跑。

项目原来的设置，`init` 会保住。有 `CLAUDE.md` 的，它在文件末尾加一行 `@AGENTS.md`：有
`CLAUDE.md` 时，Claude Code 只通过这一行才会读 `AGENTS.md`。`.claude/CLAUDE.md` 也算：
根目录没有 `CLAUDE.md` 的话，就在它末尾加 `@../AGENTS.md`。用 husky 或者别的
`core.hooksPath` 的，它不换掉那个目录，而是把提交检查加进那里的 `pre-commit`。项目自己的
hook 一行都不删，`init` 也会说改了哪个文件。git 自己提交合并时跑的是 `pre-merge-commit`，不是
`pre-commit`，所以 `init` 在那里也放同样的检查（`.githooks/pre-merge-commit`，用 husky 的是
`.husky/pre-merge-commit`）。项目自己写的 `.githooks/pre-commit` 也会加上检查。`.husky/` 下的
文件，文件权限不动：husky 9 是用 `sh` 去跑它们的。

有的仓库在 `.git/hooks` 里也有自己的 hook，可能是 lefthook 或 pre-commit 框架装的，也可能是
手写的。git 改成从 `.githooks` 找 hook 以后，这些 hook 全都不跑了。所以 `init` 写的
`.githooks/pre-commit` 和 `.githooks/pre-merge-commit` 先跑检查，再去跑原来那个 hook；别的有执行
权限的 hook，比如 `commit-msg`、`pre-push`，`init` 也在 `.githooks` 里各写一个文件，只管去跑原来
那个。参数和标准输入都原样传过去。原来的 hook 留在 `.git/hooks` 里不动，`init` 会一个个说保留了
哪些。没有执行权限的 hook，git 现在本来就不跑，所以 `init` 照常设好，并告诉你怎么留住它。要是接
不上（提交 hook 来自全局的 `core.hooksPath`，或者项目自己的 `.githooks` 文件把检查写在 `if` 里，
或者它和原来的 hook 都要读标准输入），`init` 就不设 `core.hooksPath`，并告诉你该怎么做。设了全局
`core.hooksPath` 的话，`.git/hooks` 里的文件本来就没跑过，`init` 不管它们。这样的 hook 会被丢掉的
时候，`doctor` 不会把提交检查算作做完。项目自己的 workflow，`init` 会原样留着，`doctor` 会告诉
你该往里加哪一步。

`init` 还会在 `.github/workflows/` 里放三个 workflow：`yokoten.yml`（跑提交检查；一个 lint
job 用 actionlint 和 zizmor 查 workflow 本身；还有一个 `ci` job，设成必过的检查就只要设它）、
`pr.yml` 和 `issue.yml`。每个 action 都固定到某一次提交，每个 job 都有超时，checkout 不留
token；同一个 PR 推了新提交，还在跑的旧 CI 会自动取消。你自己的测试，加成 `yokoten.yml` 里
的一个 job，再把它写进 `ci` 的 `needs`。

另外还在 `.github/` 里放三个文件，默认设置就是安全的：

- `dependabot.yml`：自动更新 CI 用到的 action。一个月只开一个 PR，所有更新都在里面；
  新版本发布满一周才会用。文件里的注释写了怎么用同样的方式加上你自己的包（npm、pip、Go 等）。
- `SECURITY.md`：告诉别人发现漏洞要私下报告，不要发公开 issue。要让私下报告能用，得在仓库
  设置里打开 private vulnerability reporting（私下报告漏洞）。`doctor` 会把它和其他安全开关
  一起列出来。
- `CODEOWNERS`：默认只许 lead 改的那些路径，都写上主人：`AGENTS.md`、`yokoten.json`、
  `.yokoten/`、hook、agent 配置和 `.github/`。守卫在本机拦住 worker，这个文件在服务器上拦住
  同样的改动。主人取自 GitHub 上的 `origin` 远程仓库；没有的话，文件里先放一个占位符，
  `doctor` 会提醒你换成自己的 GitHub 用户名。GitHub 不认组织当主人，所以 `gh` 查出这个账号是
  组织时，`init` 也写占位符，并提醒你换成一个人，或者 `@组织/团队`。完整的 `doctor` 发现文件里
  只写了组织，也会提醒你。要真正起作用，得在分支保护里打开
  「Require review from Code Owners」（需要 code owner 审查）。项目里本来就有 CODEOWNERS 的
  （放在 `.github/`、根目录或 `docs/`），原样保留。

| 命令 | 做什么 |
|------|--------|
| `install` | 把技能装进 `~/.claude/skills` 和 `~/.agents/skills`，agent 装进 `~/.claude/agents`，加上会话开头的 `doctor` hook 和用户级命令守卫，再建一个空的私有词表。这两个 hook 给 Claude Code 装一份；已经有 `~/.codex` 或 `~/.gemini` 文件夹的话，Codex 和 Gemini CLI 也各装一份 |
| `init [dir]` | 把这套做法放进一个项目。只加文件；已有的文件保留，并告诉你保留了哪些。它还会用 `gh` 看一眼 GitHub，告诉你要补哪些标准标签和里程碑，但不会去改 GitHub。没装 `gh`、没登录，或者远程仓库不在 GitHub 上，就说一声跳过了 |
| `init --github --yes [--remove-default-labels]` | 补上缺的标准标签；没有打开的里程碑时，建一个叫 "First release" 的；要是已经有一个关掉的里程碑叫这个名字，就叫 "Next release"。关掉的里程碑不会被重新打开。已有的标准标签，颜色和说明改成标准的。再跑一次什么也不会变。GitHub 自带的、不在这套里的标签（`question`、`wontfix` 等），只有加上 `--remove-default-labels` 才会删 |
| `update [dir] [--write]` | 看看这个版本的 yokoten 会怎么改项目 `AGENTS.md` 里的核心规则。加上 `--write` 才真的替换；「This project」那部分原样保留。见[更新规则](#更新规则) |
| `doctor [--session] [--json]` | 整条路：每一关、每一步，加上这台电脑还缺什么。`--session` 只说下一步，会话开头用。再加 `--agent gemini`，就按 Gemini CLI 读得懂的 JSON 输出 |
| `adopt [--json]` | 给老项目的采用表出一份草稿：项目现在做到了哪些，每一步建议怎么定。`--json` 输出每一行的数据。不改任何文件 |
| `check [--staged] [--json]` | 检查目录层级、隐私和只有 lead 能改的文件；`--staged` 只查下一次提交。提交里不能有构建产物和二进制文件。查整个目录时，落后于英文的译文会给一条提醒，见[翻译](#翻译) |
| `check --pr` | 在 CI 里检查 PR：标题格式、第一行的 `tier:`、三个小节、关联的 issue、需要时的变更文件、milestone 和标签，见下面的「更新日志」。改到 CODEOWNERS 里列出的文件，必须写 `tier: A`。改动的文档里句子太长、改动的代码里名字难读、改动超过 400 行，都只提醒，不算失败 |
| `check --issue` | 在 CI 里检查 issue 的标题，见下面的「issue 标题」 |
| `changelog [--write]` | 列出 `changes/` 里的文件会往 `[Unreleased]` 下面加哪些条目。加上 `--write` 就真的写进 `CHANGELOG.md`，再删掉这些文件；发版前跑。见下面的「更新日志」 |
| `learn <issue> [--write]` | 从一个事故 issue 起草一条检查，留给人来审。加上 `--write` 才把文件写进 `lessons/`。见下面的「从事故里学」 |
| `learn --ship <id>` | 在 yokoten 里用：把审过的教训搬进 `kit/lessons/`，以后每个项目跑 `doctor` 都会查它。还有 `TODO(reviewer)` 没填，或者它的测试没过，就不让搬 |
| `check --history` | 对所有分支的每一个提交做隐私检查。私有仓库公开之前跑一遍。浅克隆看不到旧的提交，所以它不扫描、直接报错；在 CI 里要拉下全部历史（`fetch-depth: 0`） |
| `hook [--agent <name>] [--commands-only] [--json]` | 工具调用守卫，从标准输入读一次工具调用：默认读 Claude Code 的 PreToolUse；加 `--agent codex` 读 Codex 的 PreToolUse，加 `--agent gemini` 读 Gemini CLI 的 BeforeTool |
| `hook --stop [--agent <name>]` | 收尾检查。从标准输入读这一轮结束的事件，检查改过的文件：默认读 Claude Code 的 Stop；加 `--agent codex` 读 Codex 的 Stop，加 `--agent gemini` 读 Gemini CLI 的 AfterAgent。见[收尾检查](#收尾检查) |
| `explain [<id>] [--json]` | 讲一条规则或者路上的一步：它是什么、为什么要有、yokoten 怎么检查 |
| `bot -- <命令>` | 以 bot 的身份运行一条命令（`gh`、`git push`），用一小时有效的令牌，令牌不会打印出来。如果命令是 `gh issue` 或 `gh pr` 的 `create`、`edit`，并且带了标题，它会先按 CI 的规则检查标题；标题不合格就直接拒绝，什么都不会发出去。设置方法见 [server.md](../server.md#3-the-bot-a-github-app) |

每个命令后面加 `--help` 或 `-h`，就会打出它自己的说明：做什么、有哪些选项、一个例子。
`yokoten help <命令>` 打出的也一样，`yokoten --help` 列出所有命令，`yokoten version`（或者
`--version`、`-v`）打出版本号。看说明不会改任何东西，
退出码是 0。命令或选项打错了，yokoten 会提示最接近的那个，比如 `yokoten docter` 会问
你是不是想打 "doctor"。`bot --` 后面的词都交给要运行的命令，所以
`yokoten bot -- gh --help` 运行的是 `gh --help`。

`check`、`doctor`、`hook`、`explain`、`adopt` 都可以加 `--json`。加了以后，标准输出里只有 JSON，
别的什么都没有，方便 AI 和脚本读。出错时也一样：用法写错了或者程序出错，标准输出是
`{ command, ok: false, error }`，退出码是 1，错误信息照样打在标准错误里。每条结果的字段都一样：`id`、`what`、`why`、`fix`；
指南里讲到这条规则的，再加 `docs`（链接）；问题出在文件里的，再加 `file` 和 `line`。
拿 `id` 去跑 `yokoten explain` 就能看到详细说明。任何字段里都不会有隐私内容。

- `check --json`：`{ check, ok, findings, notes }`。`check` 是 `tree`、`staged`、`history`、
  `pr` 或 `issue`，说明查的是哪一种。`notes` 只是提醒，不会让检查失败。CI 这次跑的不是
  PR 或 issue 时，`check --pr` 和 `check --issue` 直接算通过，多一个 `skipped` 写明原因。
- `doctor --json`：`{ version, ok, selfTest, repo, stage, stages, next, findings, steps,
  notes, server, lessons }`。教训查出来的问题放在 `notes` 里。加 `--session` 时只给下一步、私有词表缺失的提醒，以及核心规则落后时的 `core-rules`。
- `hook --json`：拦下时是 `{ blocked: true, finding }`，放行时是 `{ blocked: false, toolCall: true }`；
  标准输入读到的不是工具调用时，是 `{ blocked: false, toolCall: false }`。AI 工具本身不用它：
  它们按各自的 hook 协议，看退出码，再从标准错误读原因。
- `hook --stop --json`：`{ blocked, stop, findings }`。`stop_hook_active` 为真，或者检查本身出错时，
  多一个 `skipped` 写明原因。读到的不是 Stop 事件时，是 `{ blocked: false, stop: false }`。
- `explain --json`：`{ found, id, kind, what, why, check, docs, stage, standard }`。id 不存在时是
  `{ id, found: false, ids }`，退出码 1；没写 id 时是 `{ ids }`，退出码 0。

输出的规矩只有一条：结果写到标准输出（stdout），问题、拒绝和出错写到标准错误（stderr）。
不认识的选项会直接拒绝，不会悄悄忽略。

`init`、`update`、`doctor`、`check`、`adopt` 和 `bot` 都要在 git 仓库里跑。不在仓库里，
它们会直说，什么文件都不写，退出码是 1。`init <dir>` 碰到不存在的文件夹也会拒绝。
`doctor --session` 在仓库外不出声，免得打扰在别的文件夹里开的会话。

CI 没过，不用再翻日志找原因。`check` 在 GitHub Actions 里跑的时候，每个问题都会标在 PR
改动的那一行上；任务摘要（job summary）里也会列出来：在哪、哪条规则、出了什么问题、
为什么、怎么改。规则名可以点，点开就是指南里讲它的那一节。
只是提醒的，显示成黄色警告，不会让检查失败。和平时的输出一样，这里只说问题在哪，
不会把查到的内容打出来。

### 退出码

| 退出码 | 意思 |
|------|------|
| 0 | 一切正常。路线图上还没做的步骤只是待办，不算问题，`doctor` 照样给 0。`doctor --session` 永远是 0，保证会话总能开始 |
| 1 | 查出了问题：`check` 查出的，或者 `doctor` 查出的（自检失败，或者 core-rules、tree、本机这几项标着 MISSING）、id 不存在（`explain`）、命令用法不对，或者 yokoten 自己出错 |
| 2 | hook 拦下了这次工具调用，或者收尾检查把 AI 叫回来了，原因在标准错误里 |

这几个数字定下来就不改。yokoten 自己出错时给 1。可是三个 AI 工具都只认 2 才拦，守卫一崩，
调用就放过去了。所以 `init`、`install` 和插件写的工具调用 hook 会把别的退出码都改成 2：
守卫崩了、内存爆了、被杀掉了，这次调用都会被拒绝，标准错误里有一行
`` yokoten's guard failed (exit N), so the command is refused; run `yokoten doctor` ``。
标准错误里只有这一行，node 自己的报错和 shell 打的「Killed」都不显示。
有两种情况还是 1：运行时的文件夹没了，或者 AI 工具的 PATH 里找不到 `node`。这时 hook
说一行提示就放行，免得每次工具调用都被拦住，你还能跑 `yokoten doctor` 看是怎么回事。
收尾检查和会话开头的 doctor 照旧，出错就原样交出去。

AI 工具还有一条：hook 跑得比它的超时还久，工具就直接放行。所以守卫读一次调用超过 5 秒
（可以用 `YOKOTEN_GUARD_DEADLINE_MS` 改，最多 30 秒），或者读的时候出错，都会拒绝这次
调用，给 2（`unreadable-command`）。

### 收尾检查

工具调用 hook 只看命令。AI 用 `sed` 或脚本改了文件，它看不到。提交检查看得到，但要等到
提交的时候。收尾检查更早：AI 说完这一轮、准备停下时就跑。在 Claude Code 和 Codex 里是
Stop 事件，在 Gemini CLI 里是 AfterAgent。

```mermaid
flowchart LR
  S["AI 准备停下"] --> A{"已经被叫回来过一次？"}
  A -- 是 --> E["停下"]
  A -- 否 --> C{"改过的文件有问题？"}
  C -- 没有 --> E
  C -- 有 --> B["AI 拿到问题清单，回去改"]
```

- 只查改过的文件：已暂存的、没暂存的，还有 git 没忽略的新文件。用的是 `check --staged`
  那一套：个人信息、密钥、不该改的文件。
- 只叫回来一次。叫回来以后 AI 工具会把 `stop_hook_active` 设成真，下次停下就一定放行，
  不会来回打转。
- 不读历史，不联网。
- yokoten 自己出错时直接放行，只在标准错误里写一行。
- 有个新文件你想留着、不想被查，就把它写进 `.gitignore`，或者写进 `yokoten.json` 的
  `privacy.skip`。

`init` 会把它写进 `.claude/settings.json`、`.codex/hooks.json` 和 `.gemini/settings.json`。
`install` 不在用户级加它：它要读文件，所以由
每个项目自己打开，跟工具调用 hook 里管文件的规则一样。

提交检查不让你提交 `dist/`、`build/`、`out/` 文件夹里的文件，也不让你提交二进制文件。
这些文件每次构建都会重新生成，二进制文件审查的人也看不懂。图片和字体（`png`、`jpg`、`gif`、
`webp`、`svg`、`ico`、`woff`、`woff2`）可以提交。某个文件确实要留在仓库里，就在 `yokoten.json`
里写上它的路径（可以用通配符）：`"allowBuild": ["docs/manual.pdf"]`。

### 禁用的命令

项目对技术栈的约定，比如「不用 Python」「不用 yarn」，agent 干到一半很容易就忘了。只写在
AGENTS.md 里，它就只是个愿望。把这些程序写进 `yokoten.json`，每个配上原因，工具调用守卫就会替你守住：

```json
"commands": {
  "block": {
    "python": "this project is TypeScript only",
    "python3": "this project is TypeScript only"
  }
}
```

这样一来，不管是 lead 还是哪个 worker，只要命令里运行了 `python3`，守卫都会拦下来。提示里会写
是哪个程序、你写的原因，并让 agent 改用项目自己的技术栈。

- 守卫只看每条命令真正运行的程序，按名字认：`/usr/bin/python3` 和 `python3.exe` 都算 `python3`。
- 命令的每一段都会查：`a && b`、`a | b`、`a; b`、`$(...)`，还有交给 shell 运行的字符串：
  `bash -c '...'`、`ssh host '...'`、`flock file -c '...'`。
- 前面加了变量或重定向、套了一层或者放在流程语句里也藏不住：`X=1 python3`；`2>/dev/null python3`；
  `env`、`sudo`、`nice`、`timeout`、`xargs`、`setsid`、`stdbuf` 这类启动器；`if`、`for`、`while`、`!` 后面的命令；
  `find -exec` 运行的程序；`env -S` 里的字符串。
- 只是参数里出现这个名字的不拦：`echo python`、`cat python.md`、`pythonic`，
  还有 `case` 里的匹配项，比如 `python3)`。
  `command -v python3` 也不拦，它只是查程序在哪儿，并不运行。
- 名字里不能带路径，也不能有空格。`commands` 写错了格式，跟 [yokoten.json](#yokotenjson)
  里别的设置写错一样，算配置错误；守卫这时不拦任何程序，但会说一声，核心检查照常运行。

守卫读的是命令的文字。脚本、`make` 目标、npm 脚本或者 shell 函数在里面运行的程序，它看不到。
想拦哪个版本就写哪个：`python3.12` 不算 `python3`。

### yokoten.json

项目的设置都写在仓库根目录的 `yokoten.json` 里。每一项都可以不写。不写的项、写成 `null`
的项，或者整个文件不存在，都按默认值来。

| 设置 | 该怎么写 | 默认值 |
|------|----------|--------|
| `layout` | `{ "maxEntries": 7, "exempt": ["docs/records"] }`：一个大于 0 的整数，加一串文件夹 | 7，没有例外的文件夹 |
| `tests` | 一串通配符 | `*.test.*`、`*.spec.*`、`*_test.go`、`test/**`、`tests/**` |
| `leadOnly` | 一串通配符 | 规则、agent 配置、钩子和 CI |
| `privacy` | `{ "allow": [], "skip": [], "utc": true }`：两串文字，加一个 true 或 false | 跳过锁文件，要求 UTC |
| `notNow` | 每个步骤名配一个原因：`{ "ci": "no remote yet" }` | 没有 |
| `allowBuild` | 一串通配符 | 没有 |
| `areas` | 一串单词 | 任何小写单词都行 |
| `translations` | `{ "fail": true }` | `false` |
| `commands` | `{ "block": { "<程序>": "<原因>" } }` | 不拦任何程序 |

yokoten 拿这张表统一检查每一项：

- 某一项格式不对，比如 `"leadOnly": "x"`，就是配置错误。`check` 和 `doctor` 退出码是 1，
  提示里会把写错的每一项都列出来，并说明应该怎么写，跑一次就能看全。
- 工具调用钩子遇到这种情况，这一项就用默认值，在 stderr 上用一行字说明，核心检查照常运行。
  如果只是对象里的某个字段写错了，比如 `layout.maxEntries`，就只有这个字段用默认值。
  `commands` 写错了，整个禁用列表都不算。
- `yokoten.json` 本身写坏了，不是合法的 JSON，或者最外层不是一个 JSON 对象，`check` 和
  `doctor` 也会报配置错误；钩子这时全部按默认设置干活，用一行字说明，核心检查照常运行。
- yokoten 不认识的设置项，`check` 只给一条提醒，不算错误。这样给新版 yokoten 写的配置，
  在旧版上也能用。对象里不认识的字段也一样只给提醒，比如 `"commands": { "blok": ... }`。

### issue 标题

issue 标题先写改哪一块，再写要做什么。这样一排 issue 看下来，就像以后要合进来的一排提交。

- 任务：`模块: 动词开头的短语`，比如 `doctor: add the review step`。
- 事故（incident）：`模块: 看到的现象`，比如 `check: misses a key in a JSON file`。写你看到了什么，
  别写打算怎么修。
- 最多 60 个字符，结尾不加句号，标题里不写 `#N`，要提别的 issue 就写在正文里。
- 模块名全小写，一个词；要用几个词就用连字符连起来。

`init` 会加上 `.github/workflows/issue.yml`。有人开 issue 或改 issue 时，它跑一次
`check --issue`。它只读不写：不会去 issue 下面留言，也不会帮你改标题。跑红了，作者自己改标题就行。

默认任何小写的模块名都能过。想限定只用哪几个，就在 `yokoten.json` 里列出来：
`"areas": ["doctor", "check", "docs"]`。列了以后，PR 标题 `type(area): summary` 里的模块名也只能用这几个。

### 更新日志

PR 改了用户能感觉到的东西，就加一个小文件：`changes/<issue>-<slug>.md`，不去改
`CHANGELOG.md`。要是每个 PR 都往同一个文件的开头加一行，合进去一个，别的 PR 就全冲突了。
每个 PR 各写各的文件，就不会冲突。

文件就是普通的 Markdown。第 1 行写分类：Added、Changed、Deprecated、Removed、Fixed、Security
或 Internal。第 2 行空着。从第 3 行开始写条目，写成它在更新日志里该有的样子。前面的 `- `
会自动加上。一个文件里写好几条也可以。条目里不能有标题；文件直接放在 `changes/` 下面，
不要放进子文件夹，也不要用链接。

```markdown
Fixed

`doctor` no longer stops when the repo has no remote (#42).
```

`yokoten changelog` 只把这些文件会加什么列出来，不写任何东西。发版前跑
`yokoten changelog --write`：每一条放进 `[Unreleased]` 里对应的分类下面，用过的文件删掉。
已经发布的版本它不碰。有文件格式不对，它会说是哪个文件、错在哪，一个字都不写。

`check --pr` 把 `changes/` 里新加的文件当成这个 PR 的更新日志，还会检查格式。直接改
`CHANGELOG.md` 也照样能过，还没换过来的项目不受影响。`init` 会加上 `changes/README.md`，
里面有格式说明。`changes/` 里的文件可以超过 7 个，因为每次发版都会清空。

### 翻译

英文是原文，译文跟着英文走。英文改了，译文就落后了，可往往没人发现。所以每个译文文件的第 1 行
都写明它是从哪个英文文件翻的，用 HTML 注释写，GitHub 上看不到。

```markdown
<!-- source: docs/guide.md -->
```

路径是英文文件的路径，从仓库根目录算起。只有相对路径才算：像
`<!-- source: https://example.com/post -->` 这样注明出处的注释，或者写的是绝对路径，
`check` 都不管。这一行写一次就行，以后不用再改。改英文时，把译文也一起改了，放在同一个
commit 或同一个 PR 里。

`check` 会读每个 Markdown 和 HTML 文件的第 1 行，然后看当前分支的提交（只沿第一个父提交
往回找）：最后一次改译文的提交，和最后一次改英文的提交是同一个，或者更晚，译文就算最新。
译文改了哪一行都算。

为什么不在这一行记下英文的版本？那样的话，每个改英文的 PR 都得改这一行，两个这样的 PR
一定会在这一行上冲突。这一行不变，几个 PR 同时改，也只会各改各翻的那几段。

代价是：只改译文的提交也算数。在译文里改个错字，可能就把一处没人翻的英文改动盖过去了。所以
改错字之前先跑一下 `check`，如果它说译文落后，先把译文补上。

还有一个已知的漏洞：一个 PR 只改了英文，先合进去；另一个 PR 英文和译文都改了，后合进去。
这时 `check` 发现不了。后合的那个是两个文件最后一次的提交，译文看起来是最新的，可前一个 PR
的英文改动其实没人翻。审只改英文的 PR 时，记得让对方把译文也补上。

工作区里还没提交的改动也这样算：译文改了，就当作更晚的改动；只改了英文、没改译文，译文算落后。

译文落后时，`check` 给一条 `translation-behind` 提醒：落后了几个 commit，怎么看英文改了
什么（`git diff <commit> HEAD -- docs/guide.md`）。提醒不会让 CI 失败。想让它失败，就在
`yokoten.json` 里写 `"translations": { "fail": true }`。

旧的写法在第 1 行还多写了英文的 blob：
`<!-- source: docs/guide.md blob 3b18e512dba79e4c8300dd08aeb37f8e728b8dad -->`。
`check` 照样认。blob 和英文对得上，就算最新；对不上，就按上面的提交来判断。blob 随时可以删掉。

浅克隆里没有 `check` 要比的那些提交。这时 `check` 整次运行只给一条提醒，说译文没检查，
不会每个文件都报一条。就算设了 `"fail": true`，这条提醒也不会让 CI 失败。CI 里 checkout
时设 `fetch-depth: 0`，kit 里的 `yokoten.yml` 已经设好了。

### 更新规则

yokoten 每学到一个教训，核心规则就会改。`yokoten install` 会更新你电脑上的技能和 agent。
项目里的 `AGENTS.md` 是你自己的文件，你不开口，它就不会变；`init` 也不会再去动它。

`doctor` 会拿 `AGENTS.md` 里 `## This project` 上面的部分，跟你正在用的 yokoten
自带的核心规则比。两边不一样，它就报 `core-rules`，会话开头也会提一句。

`yokoten update` 只把要改的地方列出来，不写任何东西：哪几节变了，每一行是加（`+`）
还是删（`-`）。跑 `yokoten update --write` 才会替换核心规则那部分。从 `## This project`
往下的内容一个字节都不动。

核心规则里你自己手改过的行，也会显示成 `-`，因为更新会把它换掉。所以先把你自己的规则
挪到 `## This project` 下面。要是文件里没有这个标题，yokoten 分不清哪些是核心规则、
哪些是你的，它会直接告诉你，不比也不写。

`AGENTS.md` 第一行记着核心规则是哪个版本的 kit 写的，比如 `<!-- yokoten kit 0.1.0 -->`。
这是一行注释，GitHub 上看不到。`init` 会写上它，`update --write` 会换成新版本号。
要是项目里的版本比你正在用的 yokoten 还新，`update` 会拒绝，什么都不写，免得把规则
退回旧版。这时 `doctor` 会让你升级 yokoten 本身，而不是去改项目。没有这一行的文件，
就只按内容比。

`.yokoten/` 里那份也带着 kit 的 `AGENTS.md`，所以 CI 和钩子里跑 `doctor`，比的就是项目
当初拷进来的那版 kit。想换成更新的规则，就用装好的 yokoten、插件或者 clone 下来的仓库跑
`update`。用它们再跑一次 `init`，`.yokoten/` 也会一起更新。直接用 `.yokoten/` 里那份跑 `init`，
那份会原样留着，不会更新。

装了 Claude Code 插件的话，直接用 `/yokoten:update`。它跑的是插件自己那份 yokoten，
先给你看要改什么，你点头了才写。

### 从事故里学

出了一次事故，就是学到了一课。`yokoten learn` 把这一课写成一条检查，最后每个项目都会跑它：

```mermaid
flowchart LR
  A[事故 issue] --> B[yokoten learn]
  B --> C[检查草稿]
  C --> D[人来审]
  D --> E[learn --ship：放进 kit]
  E --> F[每个项目的 doctor]
```

后面跟 issue 编号就行；别的仓库的 issue，就给它的网址。它用 `gh` 读 issue，走的是你自己的登录。
它不调用任何 AI 模型，草稿里的内容全部照着 issue 里的几节来填：

| 草稿里的字段 | 从哪来 |
|---|---|
| `id` | `incident-<编号>` |
| `what` | 标题里 `area: ` 后面那部分 |
| `why` | 「Why it matters」那一节。没有这一节，就先拿「Why it got through」顶上，再留一个 `TODO(reviewer)` 让人改写 |
| `fix` | 「Fix」那一节 |

issue 里没写的那一节，对应的字段就留一个 `TODO(reviewer)`，绝不替你瞎编。issue 的原文也会放进注释里，
审的人不用来回翻。

`yokoten learn 138` 只把草稿打出来，什么都不写。`yokoten learn 138 --write` 会在
`lessons/incident-138/` 里加两个文件：

- `lesson.ts`：这条检查要报的内容，外加一个空的 `findProblems`，检查本身要人来写。
- `lesson.test.ts`：一个「阳性对照」测试：故意喂给检查一个有问题的例子，要求它能抓到。

检查没写好之前，这个测试一直是红的，所以草稿自己永远过不了。`--write` 只加文件，
已经有的文件不会动。

`findProblems` 拿到的是一个仓库的文件夹，在哪里发现问题，就为那个地方报一条。它只读文件：
不联网，也不改任何东西。要写得快一点，因为每个项目跑 `doctor` 都会跑它。

审完了，就把这一课发出去。在 yokoten 的仓库里跑 `yokoten learn --ship incident-138`，
它会把这一课搬进 `kit/lessons/incident-138/`，再在教训表 `kit/lessons/README.md` 里加一行：
编号、出自哪个事故、哪个 yokoten 版本加的。只要还有 `TODO(reviewer)` 没填，或者测试没过，
它就不搬，什么都不动。yokoten 自己也有一个测试，对 kit 里的每一课都查这几条。
之所以做成命令而不是让人手动 `git mv`，是因为搬文件、加表格、跑测试要一次做完，不会只做一半。

项目换上新版 yokoten 以后，`yokoten doctor` 就会拿这一课去查这个项目。查到问题，就给一条提醒：

```
project:
  note    lesson incident-138: test/api.test.ts: a test calls a server on this machine and does not set NO_PROXY; set NO_PROXY and no_proxy to 127.0.0.1,localhost while the test runs, then put the old values back
```

提醒不会让 `doctor` 失败。某个项目不想查这一课，就在 `yokoten.json` 的 "notNow" 里写上它的编号和理由，
比如 `"notNow": { "incident-138": "a setup file sets it" }`。

**自己走一遍。** 在 yokoten 的仓库里跑 `node scripts/demo/loop.ts`，大约一秒就把整个流程走完：
出事故、起草稿、没审就发被拒、人来审、发进 kit，最后另一个项目的 `doctor` 给出提醒。
全程在临时文件夹里做，不联网（用的是假的 `gh`），做完就删。想留下来看看，加 `--keep`，
它会打出文件夹在哪里。

### 设置

项目的设置写在仓库根目录的 `yokoten.json` 里，每一项都可以不写。列表类的设置，你写了
就整个换掉默认值，不会接在默认值后面。

| 键 | 默认值 | 管什么 |
|----|--------|--------|
| `layout.maxEntries` | `7` | 一个文件夹最多放几项（第 10 条核心规则） |
| `layout.exempt` | 无 | 可以超过上限的文件夹，比如一项一项往下记的决策记录 |
| `tests` | `*.test.*`、`*.spec.*`、`*_test.go`、`test/**`、`tests/**` | 哪些算测试文件，修复任务不能改 |
| `leadOnly` | 规则、agent 配置、`.githooks/**`、`.github/**`、项目里那份 yokoten 副本 `.yokoten/**` | worker 不能改的文件 |
| `privacy.allow` | 无 | 隐私检查放行的原样字符串，比如公开的客服邮箱 |
| `privacy.skip` | 各种 lock 文件 | 隐私检查不读的文件 |
| `privacy.utc` | `true` | 提交时间必须用 UTC |
| `notNow` | 无 | 暂时不做的步骤，用 `doctor` 里的名字，每条写上原因：`{ "ci": "no remote yet" }` |
| `allowBuild` | 无 | 提交检查放行的构建产物和二进制文件 |
| `areas` | 不限 | 标题里能用的模块名，见 [issue 标题](#issue-标题) |
| `translations.fail` | `false` | 译文落后于原文时，检查直接失败 |

环境变量：

| 变量 | 管什么 |
|------|--------|
| `YOKOTEN_ROLE=worker` | 这个会话是 worker，不能改只有 lead 能改的文件 |
| `YOKOTEN_FIX_TASK=1` | 这个会话是修复任务，不能改测试文件 |
| `YOKOTEN_RELEASE_APPROVAL=1` | 主人允许这个会话发版 |
| `YOKOTEN_PRIVATE_MARKS` | 私有词表换个路径 |
| `YOKOTEN_BOT_APP_ID`、`YOKOTEN_BOT_KEY`、`YOKOTEN_BOT_INSTALLATION` | bot 的设置，见 [server.md](../server.md#3-the-bot-a-github-app) |
| `YOKOTEN_GITHUB_API` | 换一个 GitHub API 地址，比如自建的 GitHub Enterprise Server |
| `LLAMA_API_KEY` 或 `MODEL_API_KEY`、`LLAMA_API_BASE`、`LLAMA_MODEL` | `adopt` 用的模型，见[先拿一份草稿](#先拿一份草稿) |


## 核心规则

完整的表格和每条的来由在 [`kit/project/AGENTS.md`](../../kit/project/AGENTS.md)。

1. 所有工作从 issue 开始，不用 todo 文件。
2. 没有 PR、CI 没过，什么都进不了 `main`。
3. 只有仓库主人能打 tag、发版。主人随口说一句「合吧」「ship it」，不算同意发版。
4. 修复任务只改代码，不改测试（`YOKOTEN_FIX_TASK=1`）。
5. worker 不改只有 lead 能改的文件：规则、agent 配置、hook、CI。
6. 不许跳过提交检查。查看 core.hooksPath 没问题。换成别的 hooks 文件夹也行，前提是那里的 pre-commit 是能直接执行的 shell 脚本，单独一行跑 `yokoten check`，检查没过就停下提交（用 husky 的项目，`yokoten init` 会帮你加上）。
7. 不用普通的强制推送，不对共享分支做 rebase。
8. 用 squash 合并。一个 PR 只做一件事；零碎的小改动攒成一批再提。
9. 审查和测试的，必须是最终合并的那个提交。
10. 每个文件夹最多 7 项。
11. 仓库里，以及 yokoten 打印出来的内容里，都不能有任何能指向某个人的信息，也不能有密钥。
12. 决定只写一次并保留下来；事实直接替换；时间一律用 UTC。

## 起名字

读代码时，最先看到的是名字，看得最多的也是名字。名字起得好，读的人不用往回翻，就知道它装的是什么。
有一项研究请 72 位开发者在代码里找错：名字是完整单词时，他们比看单个字母或缩写快了大约 19%。

yokoten 自己的代码守五条规矩。为什么这么定、参考了哪些资料，写在[记录 0006](../records/0006-names.md)。

1. 用完整的英文单词。缩写只用人人都认识的：`id`、`url`、`pr`、`ci`、`env`、`config`、`repo`、`dir`、`json`、`html`。不要从单词中间删字母。
2. 一个名字最多 4 个词。不限字符数：一限字符，大家就会去缩写。
3. 只有 10 行之内就用完、也不导出给别的文件的名字，才能用单个字母。`_` 只留给用不到的参数。
4. 变量和函数用 `camelCase`，类型用 `PascalCase`。`CONSTANT_CASE` 只给写在文件开头、不会变的值。缩写词当成普通单词来写：`loadHttpUrl`。
5. 函数名用动词开头。表示「是或否」的值，用 `is`、`has` 或 `can` 开头。同一个东西，在哪个文件里都叫同一个名字。

| 别这么写 | 这么写 | 原因 |
|---|---|---|
| `r`，30 行以后还在用 | `result` | 读到第 30 行，早就忘了 `r` 是什么。 |
| `cfgMgr` | `configManager` | 单词中间删了字母，读的人只能猜。 |
| `processTheUserInputDataNow` | `parseInput` | 6 个词，其中 process、data、now 都没多说什么。 |
| `_count` | `count` | 前面的 `_` 没有任何意思。 |
| 函数里的 `MAX_TRIES` | `maxTries` | `CONSTANT_CASE` 的意思是「整个文件里都不变」。 |
| `loadHTTPURL` | `loadHttpUrl` | 两个缩写连在一起，分不清哪里断开。 |
| `valid` | `isValid` | 看到 `is` 就知道它只有「是」和「否」两种值。 |
| `user()` | `loadUser()` | 动词说清楚这个函数要做什么。 |

名字也不是越长越好。一眼就能看完的地方，短名字反而清楚：三行的循环里写 `for (const n of numbers)` 就很好。
名字用到的地方离得越远，就越要说清楚。

`test/architecture.test.ts` 会检查第 2、3 条，还有函数里的 `CONSTANT_CASE`。每处不合格都会写明该怎么改：

```
src/rules/guards.ts:195: "i" is used for 101 lines. A reader must scroll back to learn what it holds. Name what it is, e.g. "index".
```

别的项目里，`check --pr` 也会提醒两种名字：单个字母却用到很远的地方，或者超过 4 个词。它只看 PR 在 TypeScript 和 JavaScript 文件里新加的行。只是提醒，CI 不会因此失败。

第 1 条和第 5 条要靠人判断，所以交给审查的人来看。

## 像带团队一样管 agent

这套做法把 AI 当成产线上的员工：每个人分工清楚，权限也有限。

- **主人**（你）决定做什么、什么时候发布。只有你能批准 PR、打发版 tag、改仓库设置。
- **lead** 是和你对话的那个会话。它做计划、拆任务、做审查，通过 **bot** 开 PR，从不用你的
  账号。
- **worker** 是 lead 为单个任务启动的会话，各自在自己的 worktree 里，带着
  `YOKOTEN_ROLE=worker`。它改代码、交报告，从不推送。如果是修复任务，还会带上
  `YOKOTEN_FIX_TASK=1`，这时守卫和提交检查都不让它改测试文件。
- **bot** 是装在仓库上的 GitHub App，负责开 PR。就算给了它 Workflows 权限，改 CI 的 PR
  也会经 CODEOWNERS 交给你审；发版要在受保护的 `release` 环境里等你批准。规则集要求你审查，
  所以它开的 PR，你不点头就合不进去。

这套方法靠六个技能来做：`dispatch`（给 worker 派活）、`inspect`（分三轮审查某一个具体提交）、
`rca`（找根因、加检查、再推广到其他项目）、`record`（把决定写下来）、`release`（定下一个
版本号、准备更新日志，tag 由主人来打）、`yokoten`（采用这套做法）。三个 agent 干活：`worker`、`reviewer`（只读）、`verifier`（只跑不修）。

### 谁来审什么

风险越大，越要主人来看。PR 第一行的 tier 说的是：改错了有多难收回（记录 0004）。

| tier | 什么样的改动 | 谁来审 |
|------|--------------|--------|
| C | 日常小改：文档、措辞、样式 | lead 审 |
| B | 普通改动：其他代码，带测试 | lead 审 |
| A | 改错了很难收回：密钥、数据、安装、发版、CODEOWNERS 里的文件 | 主人审 |

`.github/CODEOWNERS` 只列出改错了很难收回的文件：规则、kit、agent 配置、CI、记录。
不是每个文件都列。新项目跑 `init` 时，会按只许 lead 改的路径写好一份。仓库打开「需要 code owner 审查」以后，PR 一改到这些文件，GitHub
就会请主人来审。

`check --pr` 把这两件事接起来。PR 改到 CODEOWNERS 里的文件，第一行却不是 `tier: A`，
检查就不通过。改了哪些路径，决定 tier 最低是多少。作者可以把 tier 往高了写，不能往低了写。

检查读的是目标分支（base）上的 CODEOWNERS，不是 PR 自己改过的那份。这样 PR 没法靠改这个
文件来给自己降级。本地跑、没有 base 的时候，读工作区里的文件，提示里会说读的是哪一份。
没有 CODEOWNERS 文件，就不查。

审的人靠标签找 tier，所以 `check --pr` 也看标签。一个 PR 要有一个类型标签和一个 tier 标签。
类型标签可以直接用标题里的类型（`feat`、`fix`、`docs`、`refactor`、`ci` 等），也可以用常见的叫法：
`fix` 可以叫 `bug`、`hotfix` 或 `incident`，`feat` 可以叫 `feature` 或 `enhancement`，`docs` 可以叫
`documentation`。tier 标签是 `tier A`、`tier B` 或 `tier C`，写成 `tier: B` 也行，而且要跟正文第一行的
`tier:` 一样。少了哪个、哪个不对，各报一条，每条都说怎么改。

服务器怎么设置，一步一步写在 [`docs/server.md`](../server.md)。

## 隐私

第 11 条规则有检查守着。CI 和每次提交都会扫个人邮箱和 IP 地址。在你自己的电脑上，它还会读
`~/.config/yokoten/private-marks`，里面是你的名字、所在城市、域名、服务器名。这个文件放在
仓库外面，因为「不能公开的东西」这张清单本身也不能公开。查到问题时只报文件和行号，不会把
词表里的词打印出来。

IP 只查 IPv4，内网地址（比如 `10.x`、`192.168.x`）也算；IPv6 不查。本机地址和专门留给文档用的
几段地址（`192.0.2.0/24` 等三段）不算。浏览器的版本号（比如 `Chrome/120.0.0.0`）不算 IP，
`logo@2x.png` 这种高清图的文件名也不算邮箱。不过写在 `http://` 后面或者路径里（比如 `api/`
后面）的 IP 照样会查出来。

这个检查也会查密钥：GitHub、npm、Slack、Stripe、Google、OpenAI 和 Anthropic 的 token，
AWS 的 access key id，还有 PEM 私钥。查到了只说是哪一种密钥，不会把密钥本身打印出来。光删掉
不够，git 历史里还留着，得去把它作废，换一个新的。

每个提交还会记下提交时间和你的时区，而时区能大致看出你住在哪里。所以提交检查要求用 UTC：
`init` 会给 agent 会话设好 `TZ=UTC`，你自己提交时，它会告诉你怎么设。

## 做不到的事

如实说明：

- **守卫只看命令文本。** 它看得懂 bash 的写法（引号、heredoc、`bash -c`、`$(...)` 这类替换），
  看不准会跑什么就拦下。但把命令拆开再拼起来，还是能绕过。它防的是失误和走样，不是一把锁。真正
  的锁在服务器上：分支保护、代码负责人，以及一个没有发版权限、改不了 CI 的 bot。
- **服务器设置只能读 GitHub 的。** 换成别的代码托管平台，这几步就标 can't check。bot 的权限 `doctor` 还查不了。
- **先支持 Claude Code。** agent 按 Claude Code 的格式写。技能用的是公开
  的 SKILL.md 格式，所以 `install` 也会把它们放进 `~/.agents/skills`，Codex、Gemini CLI、
  Copilot、Cursor 这些 AI 会去那里找。工具调用守卫和收尾检查在 Codex 和 Gemini CLI 里也能用：
  `init` 会写好 `.codex/hooks.json` 和 `.gemini/settings.json`，这两个工具会先请你信任这些
  hook。还没有人在真的 Codex 或 Gemini CLI 里看到它们拦下过东西（#30），所以 `doctor` 只说
  这些 hook 在不在，不算作缺少。有 `~/.codex` 或 `~/.gemini` 文件夹时，用户级的
  hook 也照这样报告。规则就是普通的 `AGENTS.md`：项目里没有
  `CLAUDE.md` 时 Claude Code 会直接读它，大多数别的 AI 也读。Muse Code 的技能和 hook
  还在计划中。

## 故意没带过来的

这些做法也出自那几个项目，在那里也管用。可放进一套通用的工具里，花的力气比省下的多：检查每个提交的
类型是否和改动的文件对得上；在合并队列里逐字节重放合并；给 todo 文件分门别类的目录；
978 行的规则文件；把签过名的发版结论提交进仓库；把受控英语写作规范当硬性规则（后来带回了一个轻量版，只做提醒、不卡 CI，见
[记录 0005](../records/0005-plain-english.md)）。一条做法
要在不止一个项目里证明过值得，才能进来。


## 现状

版本 0.1。背后的决定记录在 [`docs/records/`](../records/)。工作用 issue 跟踪；参与开发
yokoten 本身的规则在 [`AGENTS.md`](../../AGENTS.md)。

### 往哪里去

梦想：人人都能像好团队那样做软件。软件开发是一整圈：计划、开发、测试、审查、发版、维护，
也就是 SDLC。yokoten 带你在自己的项目里亲手走一遍，一次一关。

| 阶段 | 名字 | 意思 | 现在 |
|---|---|---|---|
| 1 | **守桥** | AI agent 做危险操作之前就被拦下：force push、改测试让它通过、泄露隐私 | ✅ 已完成 |
| 2 | **带路** | 新手跟着 `doctor` 走完五关，一次只做一件事；agent 读懂老项目，起草接入 yokoten 的方案 | 🚧 正在做，黑客松前后 |
| 3 | **任何工具，任何平台** | Claude Code、Codex、Gemini CLI 和 Muse Code 守同一套规则；GitHub、Gitea、GitLab 都能用 | 下一步 |
| 4 | **完整的循环** | 从一份简短的方案开始，到开发、测试、审查、发版、维护，整个 SDLC 每一步都有人带路 | 之后 |
| 5 | **横展** | 一个项目学到的教训，变成一条检查；这条检查推广到所有项目。一个人学到的，大家都能用上 | 目标 |

近期要做的事在 [M0](https://github.com/yokoten-labs/yokoten/milestone/1) 和 [M1](https://github.com/yokoten-labs/yokoten/milestone/2) 里，[看板](https://github.com/orgs/yokoten-labs/projects/1)上能看到今天在做什么。
