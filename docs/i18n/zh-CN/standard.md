<!-- source: docs/standard.md -->
# 开放标准

[English](../../standard.md)

这一页写给还没见过 yokoten 的厂商工程师。
agent 要加入一个 yokoten 团队，就按这里的形状来。
yokoten 是中立的信任层，站在任何 agent 和代码之间。
这一页是版本 1，日期 2026-10-23（UTC）。
下面这些形状自己都没有版本字段。
形状已经在代码里、又和这一页不一致时，以代码为准。
事件日志先写在这一页。
代码还不会写这份日志。
例子里用的都是占位，比如 `example-vendor`、`model-1` 和 `https://example.com/change`。

## 事件日志

一个仓库只有一份只追加的日志。
路径是公共 git 目录下的 `.git/yokoten/events.jsonl`。
关联的 worktree 也往同一个文件里追加。
文件在 git 目录里，所以不会被提交。
文件是 UTF-8，一行里没有 `\r`。
每一行是一条 OTLP/JSON 的 `ExportLogsServiceRequest`，并且以 `\n` 结束。
这一次请求里有一条 `resourceLogs`、一条 `scopeLogs` 和一条 `logRecords`。
这一行里只有一条日志记录。
资源属性 `service.name` 是 `yokoten`。
资源属性也用同样的键和值。
scope 的名字是 `yokoten`。
写的人不会删掉一行。
这个形状不规定文件怎么轮转。

数据模型把时间叫 `Timestamp`。
文件里用 OTLP/JSON 的名字 `timeUnixNano`。
`timeUnixNano` 是一串数字，不是 JSON 数字。
这个时刻是 UTC。
数据模型把观察到的时间叫 `ObservedTimestamp`。
文件里用 OTLP/JSON 的名字 `observedTimeUnixNano`。
`observedTimeUnixNano` 也是一串数字。
它等于 `timeUnixNano`，因为 yokoten 自己就是来源。
数据模型把种类叫 `EventName`。
文件里用 OTLP/JSON 的名字 `eventName`。
数据模型把原因叫 `Body`。
文件里用 `body`。
事件有原因时，`body` 用 `stringValue`，否则就省掉。

OpenTelemetry 没有这份工作的名字，所以 `eventName` 以 `yokoten.agent` 开头。
八个名字是 `yokoten.agent.start`、`yokoten.agent.heartbeat`、`yokoten.agent.tool_call` 和 `yokoten.agent.refusal`。
还有 `yokoten.agent.report`、`yokoten.agent.stop`、`yokoten.agent.saved` 和 `yokoten.agent.merged`。
一个属性是一对 OTLP 的键和值。
文本值用 `stringValue`。
间隔用 `doubleValue`。
每条事件都有 `attributes` 数组。
文本属性即使是空的也要在。
厂商的键是 `gen_ai.provider.name`。
旧键 `gen_ai.system` 不用。
模型的键是 `gen_ai.request.model`。
`yokoten.agent.start` 和 `yokoten.agent.heartbeat` 必须带 `yokoten.heartbeat.interval`，而且必须是正数。
别的间隔，检查不通过。
`yokoten.agent.refusal` 把 `yokoten.outcome` 写成 `refused`。
`yokoten.agent.stop` 把 `yokoten.outcome` 写成 `done`、`failed`、`timed_out` 或 `stopped`。
`yokoten.agent.tool_call` 把 `gen_ai.operation.name` 写成 `execute_tool`，工具有名字时再写上 `gen_ai.tool.name`。
表里没写的字段可以在。
检查不去管它。

哈希盖住的是这一行原来的字节。
工具要是重新排版 JSON，链就断了。
第一行的 `yokoten.event.previous_hash` 是 64 个 0。
那不是上一行的哈希。
后面每一行存的是上一行字节的小写十六进制 SHA-256，不算换行。
参与哈希的字节不包括这一行末尾的 `\n`。

表里的键都是属性键，除了 `timeUnixNano`、`observedTimeUnixNano`、`eventName` 和 `body`。

| 字段 | 什么时候必须有 | 留下什么 |
| --- | --- | --- |
| `timeUnixNano` | 每条事件 | 数字串。Unix 纪元以来的纳秒。UTC。 |
| `observedTimeUnixNano` | 每条事件 | 和 `timeUnixNano` 同一串数字。 |
| `eventName` | 每条事件 | 上面八个名字里的一个。 |
| `body` | 有原因的时候 | OTLP 的 `stringValue`。这条事件给出的结果原因。 |
| `gen_ai.agent.name` | 每条事件 | agent 的名字。 |
| `gen_ai.provider.name` | 每条事件 | 厂商。 |
| `gen_ai.request.model` | 每条事件 | 模型。 |
| `yokoten.role` | 每条事件 | 声明的角色词。 |
| `yokoten.issue` | 每条事件 | 议题编号的文本，不带 `#`，或者空。 |
| `yokoten.worktree` | 每条事件 | worktree 文件夹的名字。状态视图按这个分组。 |
| `yokoten.event.previous_hash` | 每条事件 | 64 个小写十六进制字符。 |
| `yokoten.heartbeat.interval` | `yokoten.agent.start` 和 `yokoten.agent.heartbeat` | 秒，正数，用 `doubleValue`。 |
| `yokoten.outcome` | `yokoten.agent.stop` 和 `yokoten.agent.refusal` | `done`、`failed`、`timed_out`、`stopped`，拒绝时是 `refused`。 |
| `gen_ai.operation.name` | `yokoten.agent.tool_call` | `execute_tool`。 |
| `gen_ai.tool.name` | `yokoten.agent.tool_call`，而且工具有名字 | 工具的名字。 |

第一条 `yokoten.agent.start` 长这样。
例子里的 `timeUnixNano` 是 `2026-10-23T00:00:00Z`。
例子为了给人看，拆成了多行。
文件里这个对象只占一行。

```json
{
  "resourceLogs": [
    {
      "resource": {
        "attributes": [
          { "key": "service.name", "value": { "stringValue": "yokoten" } }
        ]
      },
      "scopeLogs": [
        {
          "scope": { "name": "yokoten" },
          "logRecords": [
            {
              "timeUnixNano": "1792713600000000000",
              "observedTimeUnixNano": "1792713600000000000",
              "eventName": "yokoten.agent.start",
              "attributes": [
                { "key": "gen_ai.agent.name", "value": { "stringValue": "example-agent" } },
                { "key": "gen_ai.provider.name", "value": { "stringValue": "example-vendor" } },
                { "key": "gen_ai.request.model", "value": { "stringValue": "model-1" } },
                { "key": "yokoten.role", "value": { "stringValue": "engineer" } },
                { "key": "yokoten.issue", "value": { "stringValue": "1" } },
                { "key": "yokoten.worktree", "value": { "stringValue": "example-worktree" } },
                { "key": "yokoten.heartbeat.interval", "value": { "doubleValue": 60 } },
                { "key": "yokoten.event.previous_hash", "value": { "stringValue": "0000000000000000000000000000000000000000000000000000000000000000" } }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

谁来写。hook、runner 和控制器各追加一行。
写的人先拿住 `.git/yokoten/events.lock`，追加这一行，再放开锁。
写的人不会改更早的一行。
锁文件不是日志里的一行。
控制器不写状态文件。
谁来读。状态视图读这份日志。
看板、时间线、每日计数和来源记录也读它。
视图只读日志，不往日志里追加。
怎么检查。每一行必须是一个 JSON 对象。
第一行的 `yokoten.event.previous_hash` 是 64 个 0。
后面每一行存的是上一行字节的小写十六进制 SHA-256，不算换行。
对不上，就是历史被改过。
缺了必填字段，检查不通过。
不认识的 `eventName`，检查不通过。
代码还不会写这份日志。
现在也没有代码在跑这项检查。
版本 1。这份日志没有版本字段。

以后追加的 hook 在 [src/run/hook.ts](../../../src/run/hook.ts)，它的测试在 [test/run/hook.test.ts](../../../test/run/hook.test.ts)。

## 看板动态

看板给每个 agent 留一份刚做了什么的短列表。
这不是厂商自己的会话记录。
厂商不写这份列表，也不把自家的流映射进来。
`yokoten board` 开着的时候，看板在内存里生成它。
看板一重启，列表就是空的。

每条记录有 `kind`、`text` 和 `time`。
一个 agent 最多留 `50` 条。
连续的 `step` 或 `pass` 够 `3` 条，页面就折成一组。
`wait`、`fail` 和 `done` 各占一行，不折叠。
一组里最新的那条仍然单独显示。
agent 第一次出现就是 `waiting` 或 `done` 时，不记一条。
agent 离开以后，它的列表也丢掉。

| 种类 | 文字 | 什么时候记下来 |
| --- | --- | --- |
| `step` | 新的 `doing` | `doing` 变了 |
| `pass` | `Checks passed` | `checks` 变成了 `passing` |
| `fail` | `Checks failed` | `checks` 变成了 `failing` |
| `wait` | `Waiting for you` | 点变成 `waiting`，而且这个 agent 本来就在看板上 |
| `done` | `Finished` | 点变成 `done`，而且这个 agent 本来就在看板上 |

谁来写。看板进程，在 `yokoten board` 运行的时候写。
谁来读。看板页面，还有 `/data` 里的 `feedsJson`。
怎么检查。`recordFeed` 拿上一份视图和这一份比。
版本 1。这条记录没有版本字段。

代码：[src/commands/advice/board/feed/steps.ts](../../../src/commands/advice/board/feed/steps.ts) 和 [src/commands/advice/board/page/browser/script.ts](../../../src/commands/advice/board/page/browser/script.ts)。
测试：[test/commands/advice/board/feed/steps.test.ts](../../../test/commands/advice/board/feed/steps.test.ts) 和 [test/commands/advice/board/page/browser/script.test.ts](../../../test/commands/advice/board/page/browser/script.test.ts)。

## 一次工具调用

每家厂商的工具调用长得不一样。
适配器把它收成同一个 `Action`。
没有一份大家共用的工具名清单。
`Action` 有 `command`、`commands`、`paths`、`cwd` 和 `worker`。
是 shell 时，`command` 就是那条命令。
`paths` 是这次编辑会碰到的文件。
事件里写了目录时，`cwd` 就是那个目录。
调用来自 worker 时，`worker` 为真。
曾经有人要一份所有厂商共用的会话记录。
代码里还没有那个映射。
适配器今天共用的就是 `Action`。

| 运行时 | hook 盯着的名字 | 怎么收成 Action | 读取的字段 |
| --- | --- | --- | --- |
| `claude-code` | `Bash`、`Edit`、`Write`、`MultiEdit`、`NotebookEdit` | 读取器不看工具名。有 `command` 就是 shell。有路径就是编辑。Copilot 用的是同一个读取器。 | `command`、`file_path`、`path`、`notebook_path`、`cwd`、`agent_type`、`tool_input` |
| `codex` | `Bash`、`apply_patch` | `Bash` 是 shell。`apply_patch` 是编辑。shell 里夹了补丁，也算编辑。 | `command`、`tool_name`、`cwd`、`agent_type`、`tool_input` |
| `gemini` | `run_shell_command`、`write_file`、`replace` | shell 那个名字是 shell。编辑那些名字是编辑。没有工位运行时。 | `command`、`file_path`、`tool_name`、`cwd`、`tool_input` |
| `antigravity` | `run_command`、`write_to_file`、`replace_file_content`、`multi_replace_file_content` | shell 那个名字是 shell。编辑那些名字是编辑。没有工位运行时。 | `CommandLine`、`Cwd`、`TargetFile`、`name`、`args`、`toolCall`、`workspacePaths` |
| `muse` | `bash`、`write_file`、`edit_file`、`apply_patch` | shell 那个名字是 shell。编辑那些名字是编辑。 | `command`、`workdir`、`path`、`tool_name`、`cwd`、`tool_input` |
| `deepseek-harness` | `bash`、`pwsh`、`edit`、`write` | 读取器就是 Claude Code 那个函数。匹配器用的是这些名字。 | `command`、`file_path`、`path`、`notebook_path`、`cwd` |
| `grok` | `run_terminal_command`、`run_terminal_cmd`、`Bash`、`Edit`、`Write`、`MultiEdit`、`NotebookEdit`、`EditNotebook`、`search_replace`、`write`、`write_file` | 只读的名字两边都不是：`read_file`、`grep`、`list_dir`、`web_search`、`web_fetch`、`todo_write`、`spawn_subagent`、`task`。别的名字只要带了文件路径，就算编辑，除非名字里有 `__`。 | `command`、`cwd`、`file_path`、`path`、`notebook_path`、`toolName`、`tool_name`、`toolInput`、`tool_input`、`subagentType` |
| `opencode` | 所有工具，经插件 | 有 `command` 或 `code` 就是 shell。有 `filePath`、`path` 或 `file_path` 就是编辑。不是只读动作（`read`、`glob`、`grep`、`list`、`search`）又读不出命令和路径的，直接拒绝。 | `action`、`resources`、`metadata`、`tool`、`args`、`command`、`code`、`filePath`、`path`、`file_path` |

谁来写。厂商的 agent，用它自己的事件形状。
谁来读。工具调用的 hook，在适配器做成 `Action` 之后。
怎么检查。守卫在工具运行前检查 `command` 和 `paths`。
版本 1。`Action` 没有版本字段。

- [src/run/hook.ts](../../../src/run/hook.ts) 和 [test/run/hook.test.ts](../../../test/run/hook.test.ts)。
- [src/commands/hook.ts](../../../src/commands/hook.ts) 和 [test/commands/hook.test.ts](../../../test/commands/hook.test.ts)。
- [src/agents/runtimes/claude-code.ts](../../../src/agents/runtimes/claude-code.ts) 和 [test/agents/runtimes/claude-code.test.ts](../../../test/agents/runtimes/claude-code.test.ts)。
- [src/agents/runtimes/codex.ts](../../../src/agents/runtimes/codex.ts) 和 [test/agents/runtimes/codex.test.ts](../../../test/agents/runtimes/codex.test.ts)。
- [src/agents/runtimes/gemini.ts](../../../src/agents/runtimes/gemini.ts) 和 [test/agents/runtimes/gemini.test.ts](../../../test/agents/runtimes/gemini.test.ts)。
- [src/agents/runtimes/small/antigravity.ts](../../../src/agents/runtimes/small/antigravity.ts) 和 [test/agents/runtimes/small/antigravity.test.ts](../../../test/agents/runtimes/small/antigravity.test.ts)。
- [src/agents/runtimes/muse.ts](../../../src/agents/runtimes/muse.ts) 和 [test/agents/runtimes/muse.test.ts](../../../test/agents/runtimes/muse.test.ts)。
- [src/agents/runtimes/small/deepseek-harness.ts](../../../src/agents/runtimes/small/deepseek-harness.ts) 和 [test/agents/runtimes/small/deepseek-harness.test.ts](../../../test/agents/runtimes/small/deepseek-harness.test.ts)。
- [src/agents/runtimes/grok.ts](../../../src/agents/runtimes/grok.ts) 和 [test/agents/runtimes/grok.test.ts](../../../test/agents/runtimes/grok.test.ts)。
- [src/agents/runtimes/runtime.ts](../../../src/agents/runtimes/runtime.ts) 和 [test/agents/runtimes/runtime.test.ts](../../../test/agents/runtimes/runtime.test.ts)。
- [src/agents/runtimes/small/opencode.ts](../../../src/agents/runtimes/small/opencode.ts) 和 [test/agents/runtimes/small/opencode.test.ts](../../../test/agents/runtimes/small/opencode.test.ts)。

## 状态文件

状态文件是事件日志的一份视图，存在缓存里。
每个 worktree 一份，放在那个 worktree 的根上。
文件名是 `.yokoten-agent.json`。
`init` 会把这个名字写进 `.gitignore`。
这个文件不进提交。
日志用的是 OpenTelemetry 的名字。
视图自己的两个状态是 `alive` 和 `outcome`。
这两个状态分开留。
`stale` 的 agent 可以没有 `outcome`。
已经有 `outcome` 的 agent 仍可以是 `alive`。
只有这个视图写这个文件。
代码现在还不会这么做。
日志不在时，视图不去创建这个文件。
视图只读 `yokoten.worktree` 等于这个 worktree 文件夹名的事件。
别的 worktree 的事件不改这个文件。
每个填上的字段，用文件里最后一条带着它的事件。
更早的一行即使时间更晚，也不算赢。

没有 `yokoten.agent.heartbeat` 时，`alive` 就不在。
在的时候，它有 `interval`、`beat` 和 `phase`。
`interval` 是最近一条 `yokoten.agent.heartbeat` 上的 `yokoten.heartbeat.interval`，单位是秒。
那条事件没有间隔时，视图用最近一条 `yokoten.agent.start` 的间隔。
`interval` 缺了，或者不是正数，`phase` 就留空，不写。
视图把 `beat` 写成没有小数秒的 UTC 文本。
写法和 `updated` 一样，例如 `2026-10-23T00:00:00Z`。
`beat` 不是 `updated`。
离 `beat` 的时间不超过两倍 `interval` 时，`phase` 是 `alive`。
离 `beat` 的时间超过两倍 `interval` 时，`phase` 是 `stale`。
`beat` 比现在还晚，仍然算 `alive`。
只有控制器另定了一个更长的限度，而且离 `beat` 的时间超过了它，`phase` 才是 `gone`。
这一页不定那个限度。
控制器还没定的时候，视图不用 `gone`。

没有事件带 `yokoten.outcome` 时，`outcome` 就不在。
在的时候，它有 `value` 和 `reason`。
`value` 就是那条最新的 `yokoten.outcome`。
`reason` 是那条事件的 `body` 字符串。
`body` 是空的，`reason` 就是空的。
`state` 不是 `alive`，也不是 `outcome`。

代码还没搬过去之前，agent 和停止 hook 仍按下面的行来写这个文件。
搬过去以后，只有这个视图写它。
视图那时从日志填 `alive`、`outcome`、`name`、`vendor`、`model`、`role` 和 `worktree`。
`gen_ai.agent.name` 是空的，就用 worktree 文件夹的名字。
然后再套用表里的 `role` 规则。
`effort`、`task`、`doing`、`state`、`checks`、`blocked`、`question`、`link` 和 `updated` 留着上一手写下的值。

不是文本的值，当成空字符串，但 `alive` 和 `outcome` 除外，它们是对象，或者不在。
不是 JSON 对象的文件，看板直接跳过。

| 字段 | 谁来写 | 留下什么 |
| --- | --- | --- |
| `alive` | 视图，来自 `yokoten.agent.heartbeat` | JSON 对象，或者不在。`interval` 是秒。`beat` 是 UTC 文本。`phase` 是 `alive`、`stale` 或 `gone`。 |
| `outcome` | 视图，来自 `yokoten.outcome` | JSON 对象，或者不在。`value` 是 `done`、`failed`、`timed_out`、`refused` 或 `stopped`。`reason` 是文本。 |
| `name` | agent | 文本。缺了名字，就用 worktree 文件夹的名字。 |
| `vendor` | agent | 文本 |
| `model` | agent | 文本 |
| `effort` | agent | 文本 |
| `task` | agent | 文本 |
| `worktree` | agent | 文本 |
| `doing` | agent | 文本 |
| `log` | agent | 文本。纯文本日志的绝对路径，必须在工位内或运行时的日志文件夹内。看板找不到会话日志时就读它。 |
| `updated` | agent，还有停止 hook | 文本。hook 写成没有毫秒的 UTC 时间，例如 `2026-10-23T00:00:00Z`。 |
| `started` | agent | 文本，格式和 `updated` 一样：这份工作开始的时间。没有就用文件创建的时间，再没有就用 `updated`。 |
| `role` | agent | `lead`、`engineer`、`reviewer`、`verifier` 或 `helper`。别的词，包括 `worker`，都变成空。 |
| `state` | agent | `working`、`waiting` 或 `done` |
| `checks` | 停止 hook | `passing` 或 `failing` |
| `blocked` | agent | 文本。看板只留第一行，最多 `140` 个字符，种类是 `guard`。 |
| `question` | agent | 文本。看板只留第一行，最多 `140` 个字符，种类是 `question`。 |
| `link` | agent | 只认 `http://` 或 `https://`。别的都丢掉。 |

看板那一行还留着 `kind` 和 `why`。
`why` 就是那第一行。
agent 旁边的点是 `working`、`waiting`、`failing`、`idle` 或 `done`。
`done` 和 `waiting` 来自 `state`。
`failing` 来自 `checks`。
其余情况下，`updated` 在 `15 minutes` 以内就显示 `working`。
`updated` 缺了，或者不是一个时间，就显示 `idle`。
安静满 `15 minutes` 才显示 `idle`，而且 `state` 不是 `done` 或 `waiting`，`checks` 也不是 `failing`。
下面这些点的规则，是看板今天在做的事。
这个点现在还不读 `alive` 或 `outcome`。

停止 hook 只在关联的 worktree 里写 `checks` 和 `updated`。
主检出不动。
那里的 `.git` 是一个目录。
文件是 JSON 对象时，别的字段都留着。
不是 JSON、但又小到读得下的文件，会被换成只剩 `checks` 和 `updated`。

hook 最多读 `64 KiB`（`65536` 字节）。
再大就是 `too large`，文件保持原样。
符号链接的警告是 `is not a regular file, so it was left unchanged`。
打不开就是 `cannot be read`，文件保持原样。
读的过程中文件变了，就是 `changed while it was read`，文件保持原样。
警告只在 stderr 上打一行。
这一行里没有文件内容。
hook 先写临时文件再改名，所以中途出现的符号链接会被换掉，不会跟着走进去。

看板自己读的时候会跟着符号链接走。
那一次读取没有大小上限。

谁来写。只有这个视图写这个文件。
代码现在还不会这么做。
今天仍是 agent 写这个文件，删掉它就是离开。
停止 hook 在关联的 worktree 里写 `checks` 和 `updated`。
控制器不写这个文件。
谁来读。lead，还有看板。
怎么检查。视图按日志重新算出来。
哈希对不上，文件就保持原样。
今天的 hook 拒绝非普通文件、超过上限的文件、读不了的文件，以及读取中途变了的文件。
看板跳过没有的、坏的、或者不是对象的文件。
版本 1。这个文件没有版本字段。

- [src/run/hook.ts](../../../src/run/hook.ts) 和 [test/run/hook.test.ts](../../../test/run/hook.test.ts)。
- [src/commands/hook.ts](../../../src/commands/hook.ts) 和 [test/commands/hook.test.ts](../../../test/commands/hook.test.ts)。
- [src/commands/advice/board/agents.ts](../../../src/commands/advice/board/agents.ts) 和 [test/commands/advice/board/agents.test.ts](../../../test/commands/advice/board/agents.test.ts)。
- [src/commands/advice/board/controls.ts](../../../src/commands/advice/board/controls.ts) 和 [test/commands/advice/board/controls.test.ts](../../../test/commands/advice/board/controls.test.ts)。
- [src/commands/advice/board/view.ts](../../../src/commands/advice/board/view.ts) 和 [test/commands/advice/board/view.test.ts](../../../test/commands/advice/board/view.test.ts)。

## Made-with 行

PR 正文最后一个非空行，就是 Made-with 行。
HTML 注释和代码块先被当成空的。
没关上的注释，会把后面的正文都藏起来。
这一行以 `Made with` 开头，前面可以有一个机器人标记。
各段用逗号分开。
角色词不区分大小写。
多出来的空格算成一个。
一对就是一个 `vendor` 和一个 `model`，写成 `example-vendor (model-1)`。
`worker (model-1)` 中间没有厂商，于是两个词都进 `others`。
`lead (model-1)` 也一样。
审阅者一共最多留两个。
`reviewed by` 这一段写坏了，就算别的段也坏，也按审阅者来报。
这一行后面还有字，检查就不通过。
两个 worker 用了不同的模型，两个都留着。

| 这一段 | 归到哪里 |
| --- | --- |
| `worker example-vendor (model-1)` | `writers` |
| `reviewed by example-vendor (model-1)` | `reviewers` |
| `reviewed by example-vendor (model-1) and example-vendor (model-2)` | `reviewers`，一共最多两个 |
| `lead example-vendor (model-1)` | `leads` |
| `example-vendor (model-1)` | `others` |

角色词是 `worker` 和 `lead`。
审阅者用的词是 `reviewed by`。

`gh pr create` 和 `gh pr edit` 检查整篇正文，包括这一行。
评论、带正文的审查、新建的 issue，只检查这一行。
`gh issue edit` 在这里不检查。
这些说明如果带了 `--attach`，会被拒绝，因为上传的文件会落在这一行后面。
Dependabot 开的 PR，这一行有问题只是提醒，不算失败。
这条检查的 id 是 `pr-made-with`。

谁来写。正文的作者。
谁来读。PR 检查，还有 `yokoten bot`。
怎么检查。`parseMadeWith` 读最后一行。行没有了，或者审阅者写错了，`madeWithFindings` 就报 `pr-made-with`。
版本 1。这一行没有版本字段。

- [src/rules/pr.ts](../../../src/rules/pr.ts) 和 [test/rules/pr.test.ts](../../../test/rules/pr.test.ts)。
- [src/commands/merge/bot.ts](../../../src/commands/merge/bot.ts) 和 [test/commands/merge/bot.test.ts](../../../test/commands/merge/bot.test.ts)。

## 来源

Made-with 行是来源记录的第一种样子。
它写明谁写的、谁审的。
来源记录也读事件日志。
代码还不会读这份日志。
它还不是一份完整的物料清单。
批准的人不是这一行上的字段。

| 角色 | yokoten 从哪里读 |
| --- | --- |
| 写的人 | `writers`，来自 `worker` 再加上 `vendor` 和 `model` |
| 审的人 | `reviewers`，最多两个，来自 `reviewed by` |
| 批准的人 | 主人在代码宿主上的 Approve。不在这一行上。只有 tier A。 |
| lead | `leads`，来自 `lead` 再加上厂商和模型。lead 不是批准的人。 |
| 没写角色的 | `others`，一对没有角色词的名字 |

谁来写。PR 作者写这一行。主人在代码宿主上写 Approve。
谁来读。PR 检查，还有读正文的人。
怎么检查。Made-with 检查给出写的人和审的人。tier A 时，`checkApprovalFreshness` 要求主人的 Approve 落在 head 上，或者之后只有基础分支的合并，而且这个 PR 自己的 diff 没变。这条检查的 id 是 `pr-approve`。tier B 和 tier C 不走这道门。
版本 1。这是第一种样子，自己没有版本字段。

- [src/rules/pr.ts](../../../src/rules/pr.ts) 和 [test/rules/pr.test.ts](../../../test/rules/pr.test.ts)。

## 风险等级

PR 正文第一个非空行是等级行。
字母用大写。
这一行上不能再有别的字。

| 这一行 | 检查文案说它表示什么 |
| --- | --- |
| `tier: A` | 密钥、数据、安装、发布，以及 CODEOWNERS 点了名的文件 |
| `tier: B` | 其他代码 |
| `tier: C` | 文档和措辞 |

标签可以写成 `tier A`、`tier: A` 或 `tier:A`，大小写都行。
必须有且只有一个等级标签，并且和正文这一行一致。
这条检查的 id 是 `pr-labels`。
没有这一行，就是 `pr-tier`。

CODEOWNERS 只把下限定在 A。
改到有主人的文件时，`tier: B` 或 `tier: C` 会失败。
那条检查是 `pr-owned`。
作者可以把这一行抬到 `tier: A`。
CODEOWNERS 没有点名的源代码，写成 `tier: C` 也不会被这道检查拒绝。
仓库里没有 CODEOWNERS 时，这道下限不生效。
CI 里从基础分支读 CODEOWNERS。
在本机跑的时候，从工作区读。

用来决定 Approve 那道门的等级：正文或任何一个等级标签说了 A，就是 A。
否则先看正文那一行，再看第一个等级标签。
只有仓库自己已经有等级标签时，issue 才必须带一个。

谁来写。PR 的作者。
谁来读。PR 检查、bot，还有看板。
怎么检查。`checkPullRequestBody` 要求有这一行。`checkTierLabel` 要求一个对得上的标签。`checkOwnedTier` 在改了有主人的文件时要求 A。`checkApprovalFreshness` 拦住 tier A 的合并。
版本 1。这一行没有版本字段。

- [src/rules/pr.ts](../../../src/rules/pr.ts) 和 [test/rules/pr.test.ts](../../../test/rules/pr.test.ts)。

## 工位

工位是 worker 自己的那份克隆，再加上围住 agent 的一道栅栏。
子进程和管道都能用。
工位跑的是 lead 交给它的命令。
它不会自己再加参数。
符号链接在 `.git`、`.git/config`、`.git/hooks`、`.git/yokoten-worker` 和工位状态文件夹上会被拒绝。
在团队里，团队文件夹只读，只有这个 agent 自己的发件箱可以写。

| 字段 | agent 得到什么 |
| --- | --- |
| `desk` | 克隆可以写，包括 `.git`。必须是 `git clone` 出来的，不能是 worktree。 |
| `state` | 工位旁边的状态文件夹可以写。只复制登录文件。lead 自己的状态藏起来。 |
| `readable` | 再露出来，但是只读：Node、agent 程序、`bin`、`src`、`kit`、`dist`、`package.json`、`.gitconfig` 和 `.config/git`。`--read` 可以再加路径。`--marks` 才会把私人词表放进来。 |
| `hidden` | 这些目录如果存在就藏起来：`/home`、`/root`、`/mnt`、`/media`、`/run`，再加上家目录和工位的上一级。在 `darwin` 上是 `/Users`、`/Volumes`，再加上家目录和上一级。 |
| `locked` | `.git/config`、`.git/hooks` 和 `.git/yokoten-worker` 保持只读。在团队里，`.git/yokoten-desk.json` 也锁上。 |
| `hosts` | 只能到 API 主机，而且要经过外面的代理。只接受 CONNECT。端口是 `443`，除非主机那一项自己写了端口。隧道最多 `64` 条。`10 minutes` 没有数据就关掉。代理不读隧道里的内容。 |
| `env` | `YOKOTEN_ROLE` 是 `worker`。`TZ` 是 `UTC`。在团队里还会设置 `YOKOTEN_DESK` 和 `YOKOTEN_TEAM`。 |
| `command` | lead 传进来的那条命令。 |

`/run` 要藏起来，因为那里的 socket 能在栅栏外面启动程序。

工位能启动的运行时是 `claude-code`、`codex`、`grok` 和 `muse`。
DeepSeek 通过 `codex` 来跑。
运行时 id `deepseek-harness` 自己没有工位。
`gemini` 和 `antigravity` 没有工位运行时。
不认识的运行时直接拒绝。

- `claude-code` 可以连 `api.anthropic.com` 和 `platform.claude.com`。
- 复制进去的登录文件是 `.credentials.json`。
- `CLAUDE_CONFIG_DIR` 指向工位自己的状态。
- 新建的状态会写入 `.claude.json`，内容是 `{"hasCompletedOnboarding": true}\n`。
- lead 的 `.claude` 和 `.claude.json` 仍然藏着。
- 登录名 `ANTHROPIC_API_KEY` 和 `CLAUDE_CODE_OAUTH_TOKEN` 会传进去。
- `codex` 可以连 `api.openai.com` 和 `api.deepseek.com`。
- 复制进去的登录文件是 `auth.json`。
- `CODEX_HOME` 指向工位自己的状态。
- lead 的 `.codex` 仍然藏着。
- 登录名 `OPENAI_API_KEY` 和 `CODEX_API_KEY` 会传进去。
- `chatgpt.com` 和 `auth.openai.com` 不在默认主机里。
- ChatGPT 登录需要它们时，lead 用 `--host` 加上。
- `grok` 可以连 `api.x.ai`。
- 复制进去的登录文件是 `auth.json`。
- `GROK_HOME` 指向工位自己的状态。
- lead 的 `.grok` 仍然藏着，只有只读的程序目录 `.grok/bin` 露出来。
- 登录名 `XAI_API_KEY` 和 `GROK_API_KEY` 会传进去。
- `muse` 可以连 `api.meta.ai`。
- 从状态根复制到的位置是 `config/muse/auth.json`。
- 在 `XDG_CONFIG_HOME` 下面，同一个文件是 `muse/auth.json`。
- `XDG_CONFIG_HOME` 指向状态里的 `config` 目录。
- `XDG_DATA_HOME` 指向状态里的 `data` 目录。
- lead 的数据目录 `.local/share/muse` 仍然藏着。
- 登录名 `MODEL_API_KEY` 会传进去。

运行时自己的登录名，不走密钥过滤。
别的名字，只要含有 `TOKEN`、`SECRET`、`KEY`、`PASSWORD`、`PASSWD`、`AUTH`、`CREDENTIAL` 或 `PRIVATE`，就丢掉。
长过 `32 KiB` 的值丢掉。
长得像令牌的值也丢掉。

后端会设置 `HTTPS_PROXY`、`HTTP_PROXY` 和 `ALL_PROXY`。
这三个名字的小写也会设置。
还会设置 `NODE_USE_ENV_PROXY`。
`NO_PROXY` 和 `no_proxy` 设成空的。

Linux 和 WSL2 用 `bwrap`。
macOS 用 `sandbox-exec`，规则从全部拒绝开始。
Windows 本机没有工位后端。

谁来写。`planDesk` 生成这份计划。agent 只能写在可写的文件夹里。
谁来读。工位的后端。agent 看见的是栅栏，不是这份计划对象。
怎么检查。`planDesk` 遇到不认识的运行时、不是克隆的文件夹、或者一条会打开隐藏目录的路径，就抛出错误。代理拒绝一切不是发往允许主机的 CONNECT。
版本 1。`DeskPlan` 没有版本字段。

- [src/agents/desk/desk.ts](../../../src/agents/desk/desk.ts) 和 [test/agents/desk/desk.test.ts](../../../test/agents/desk/desk.test.ts)。
- [src/agents/desk/agent-env.ts](../../../src/agents/desk/agent-env.ts) 和 [test/agents/desk/agent-env.test.ts](../../../test/agents/desk/agent-env.test.ts)。
- [src/agents/desk/network/proxy.ts](../../../src/agents/desk/network/proxy.ts) 和 [test/agents/desk/network/proxy.test.ts](../../../test/agents/desk/network/proxy.test.ts)。
