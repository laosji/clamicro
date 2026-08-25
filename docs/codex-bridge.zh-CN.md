# Clamicro × Codex 桥接方案

> 对象是 OpenAI Codex CLI（ChatGPT 桌面版里带的那个 `codex`）。
> 本文里的事实全部来自 **codex-cli 0.147.0-alpha.6.6** 的实测与二进制核对，
> 标了「未验证」的地方就是真的没验证，别当成已经成立。

## 0. 结论先行

- **能接，而且比接 DSH 便宜。** Codex 自带一套 hook，事件名、payload 字段、
  输出结构跟 Claude Code 几乎同构，所以不需要插件宿主、不需要常驻进程——
  一层 `curl` 中继就够了。
- **已经接上的是状态镜像**：会话、工具调用、结束事件都会流到手机上，
  首页按后端分区显示。
- **审批还没打开**（`src/agents.mjs` 里 `codex.approve = false`）。缺的不是
  代码，是**一次真机验收**：见 §4。跑通之后改一个布尔值即可。
- **有一道 Claude Code 没有的闸门**：hooks 要先被「信任」才会执行，
  而未信任时是**静默跳过**。见 §3——这是这条链路上最容易造成
  「装好了、显示正常、什么都收不到」的地方。

## 1. 已核查的 Codex 事实

### 1.1 hook 事件名与 Claude Code 一致

二进制里的 `HookEventsToml` 列的是：

```
PreToolUse  PermissionRequest  PostToolUse  PreCompact  PostCompact
SessionStart  SessionEnd  UserPromptSubmit  SubagentStart  SubagentStop  Stop
```

**没有**的三个（Claude Code 有、我们原来用着的）：`Notification`、
`PostToolUseFailure`、`StopFailure`。所以 Codex 会话上那三条端点永远收不到
东西，工具失败只能从 `PostToolUse` 的 payload 里看出来。

### 1.2 配置形状（实测）

写在 `~/.codex/config.toml`：

```toml
[[hooks.PreToolUse]]
matcher = "*"
hooks = [{ type = "command", command = "…", timeout = 30 }]
```

验证方法：把 `type` 改成一个不存在的值，`codex doctor` 立刻报
`config could not be loaded`；改回 `command` 则报 `config.toml parse ok`。

handler 只有 `command` / `prompt` / `agent` 三种，**没有 Claude Code 那种
`type: "http"`**。这就是 `bin/codex-hook.sh` 存在的全部理由：补上那一跳。

### 1.3 传给 hook 的字段

实测捞到的（SessionStart / UserPromptSubmit 真实 payload）：

```
session_id  turn_id  transcript_path  cwd  hook_event_name  model
permission_mode  source  trigger  tool_name  tool_input  tool_use_id
agent_id  agent_type  agent_transcript_path  stop_hook_active  last_assistant_message  prompt
```

跟 Claude Code 同名同义，所以 clamicro 的 `store.applyHook` / 风险评估 /
`describe` 一行都不用改。

### 1.4 输出结构

二进制里的类型：`PreToolUseHookSpecificOutputWire`、
`PermissionRequestDecisionWire { behavior, updatedInput, updatedPermissions, message, interrupt }`、
`PermissionRequestBehaviorWire { allow, deny }`，顶层还有
`continue` / `stopReason` / `suppressOutput` / `systemMessage`，
`hookSpecificOutput` 里是 `hookEventName` / `permissionDecision` /
`permissionDecisionReason` / `additionalContext`。

**这一节是类型名核对，不是真机验证。** 我们据此发的形状见
`src/routes/hooks.mjs` 的 codex 分支，验收方法见 §4。

### 1.5 SessionEnd 的超时被强行截到 3 秒

写大了它每次启动都在**用户自己的终端**里打一行：

```
warning: clamping SessionEnd hook timeout to 3s in …/config.toml
```

所以 `src/codex.mjs` 的 `CODEX_HOOKS` 里 SessionEnd 只给 3 秒，
`test/codex.test.mjs` 钉着这个数。其余事件写 600 秒不报警告。

## 2. 与 Claude Code 的机制对照

| | Claude Code | Codex |
|---|---|---|
| 事件送达方式 | hook 直接发 HTTP | 只能执行命令 → `bin/codex-hook.sh` 中继 |
| 表明身份 | 不用（默认后端） | `?agent=codex` 查询参数 |
| 额度 | statusLine 每次会话上报窗口用量 | **没有**。hook payload 里既没有窗口也没有 token 数 |
| hook 生效 | 写进 settings.json 即生效 | 还要被**信任**，见 §3 |
| 回合结束 | `Stop` 事件 | **没有这个事件**，只能跟读 rollout JSONL，见 §3.5 |
| 拉起服务 | SessionStart 跑 `session-start.sh` | 同一个脚本，多传一个 `codex` 参数 |

「表明身份」为什么走查询参数而不是往 payload 里加字段：中继是 bash，
要改 JSON 就得引入 `jq`（这个项目零依赖）或者手拼字符串——在一份含模型
生成内容的 JSON 上手拼，迟早拼坏。走 URL 则一个字节都不用动。

## 3. 信任门：这条链路最容易静默失败的地方

Codex 对 hooks 有一道信任闸门，状态写在 config.toml 的 `[hooks.state]` 里
（`trusted_hash`，Codex 自己算、自己写）。

**实测：hash 不对或没有时，hooks 一条都不执行——不报错、不提示、终端里
干干净净。** 现场是这样的：配置在、服务跑着、Codex 正常干活、clamicro 一个
事件都收不到，而其他每一项检查都显示「已安装」。

这正是 NOTES 里 2 号复发故障（hooks 静默失败）的形状，区别只是起因不是
配置丢了，而是配置**从来没生效过**。

所以：

- 安装流程最后单独一段讲这件事（`src/codex.mjs` 的 `wireUp`，
  `test/codex.test.mjs` 钉着这段话必须被打印）；
- `clamicro status` 把「没接」「配置不全」「没信任」分成三种说法；
- `patchConfig` 内容没变就**不重写**——重写会让 Codex 要求重新信任一次，
  而那中间 hooks 是失效的。

改端口、改事件表都会改变这段内容，因此都要重新信任一次。这一点在安装
提示里也说了。

### 3.1 信任提示**只在终端 TUI 里出现**

这一条是真机上踩出来的，代价是一个多小时：配置写对了、服务跑着、Codex
正常干活、`clamicro status` 每一项都绿，事件一条不来。

原因是 Codex 已经**没有独立客户端**了——它就在 `ChatGPT.app` 里，多数人
从桌面 App 或 VS Code 扩展用它。而那道信任闸门只在**交互式 TUI** 里能点，
那两条路都不是 TUI，**打开一百次也不会被问**。

绕不过去，我把能试的都试过了：

- `codex` 没有 `hooks trust` 这类子命令（翻过 `--help`、`debug --help`、`features`）
- `codex doctor` 整份报告里一个字都没提 hooks
- 手写 `trusted_hash` 不行——那是 Codex 自己算的 sha256，算法没有公开
- `--dangerously-bypass-hook-trust` 只对**单次调用**生效，落不了盘（探针用的就是它）

所以安装提示里必须给出**那条命令本身**（见 `src/codex.mjs` 的 `codexBin`）：

```bash
/Applications/ChatGPT.app/Contents/Resources/codex
```

跑起来点同意，直接退出即可。信任是写进 `config.toml` 持久化的，之后
桌面 App 和 VS Code 的会话一起生效。

**但桌面 App 要重启一次（⌘Q，不是关窗口）。** 它不像 CLI 那样每次会话起一个
新进程，而是把所有会话都跑在一个常驻的 app-server daemon 里
（`codex … app-server`），那个 daemon **启动时读一次配置就不再读了**。

这一条咬过两次，两次的形状一模一样——都是「配置改动晚于进程启动」：

| | 进程起于 | 配置改于 | 结果 |
|---|---|---|---|
| ChatGPT.app 本体 | 14:58 | 15:02 写 hooks | 从没弹过信任提示 |
| app-server daemon | 15:23 | 15:34 写 trust | CLI 同步，桌面不同步 |

判据很直接：比 `ps -eo pid,lstart,command \| grep app-server` 的启动时间和
`~/.codex/config.toml` 的 mtime，后者晚就得重启。

rollout 第一行的 `originator` 能区分是哪条路来的：`codex-tui`（CLI）
/ `Codex Desktop`、`codex_work_desktop`（桌面 App）。

### 3.2 Codex 把信任记录写进**我们的哨兵块里面**

实测到的布局：

```
# >>> clamicro >>> …
[[hooks.SessionStart]] …        ← 我们写的
[hooks.state]                   ← Codex 自己追加的，紧贴 END 之前
[hooks.state."…:session_start:0:0"]
trusted_hash = "sha256:…"
# <<< clamicro <<<
```

今天无害：那些 trust 记录本来就是给 clamicro 自己的 hooks 用的，
`uninstall` 一并删掉是对的。

**但 `[hooks.state]` 是一张共用的表。** 用户以后装了第二个带 hooks 的工具
并信任了它，Codex 很可能把那条记录也追加进同一张表——而那张表落在我们的
哨兵块里面。那时卸载 clamicro 会顺手删掉**别人的**信任记录，没有任何提示，
对方只会看到自己的 hooks 突然静默失效。

`patchConfig` 的纪律是「块外一个字节都不碰」，但没预料到会有别人往块**内**写。
**尚未修复**，记在这里免得忘。

### 3.5 没有 `Stop`：会话走不出「运行中」

0.149 的 hook 事件枚举一共十个（二进制里 snake_case / PascalCase 两份互相印证）：

```
pre_tool_use   permission_request  post_tool_use   pre_compact   post_compact
session_start  session_end         user_prompt_submit
subagent_start subagent_stop
```

**没有 `stop`。** 本文最初照 0.147 的说法写着「事件名一字不差（… Stop …）」，
那是错的——`CODEX_HOOKS` 里也真的接过 `[[hooks.Stop]]`。

错得最阴的地方是 **Codex 照样给它发信任凭证**（配置里会出现
`[hooks.state."…:stop:0:0"]`），所以从任何一个角度看它都像装好了，
而那条 hook 一辈子不会响。表现是：Codex 会话收到 `user-prompt-submit`
之后**永远停在「运行中」**，跑成功了也一样，只能等 `SessionEnd` 或者
30 分钟后被 `sweepStale` 标成陈旧。真机现场：`task_complete` 15:35:39 落盘，
看板 15:38 还在转圈。

Codex 根本没有回合级的结束事件，这是硬限制。补救是**跟读它的 rollout
JSONL**（`~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<session_id>.jsonl`），
里面有完整的回合线：

```
{"type":"event_msg","payload":{"type":"task_started","turn_id":…}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":…,
                               "last_agent_message":…,"error":{"message":…}}}
```

`task_complete` **带 error 字段**，所以「正常结束」和「失败」能区分，不用靠
超时猜——额度耗尽走的就是这条。实现见 `src/codex-tail.mjs`，状态机落点是
`state.mjs` 的 `turn-start` / `turn-end`（**故意不在 `HOOK_EVENTS` 里**，
所以进不了 `/hooks/*` 路由，局域网上伪造不出来）。

为什么读文件不接 `codex app-server proxy`：那是一条有状态的双向协议连接，
还要依赖跟桌面 App 共用的常驻 daemon。跟读文件是只读的，读错了最坏也只是
退回今天这个「状态不更新」，不会把别人的会话搞坏，零依赖也保得住。代价是
rollout 属于 Codex 内部格式、没有版本承诺——所以认不得的字段一律当没看见。

## 4. 验收：审批闭环（未完成）

`src/agents.mjs` 里 codex 的 `approve` 现在是 `false`，因为下面两件事只能
在真机上问出答案：

1. hook 能不能把一次工具调用挂住，能挂多久；
2. 「拒绝」到底认不认。

第 2 条比第 1 条要紧得多：猜错的表现不是按钮没反应，是**手机上写着
「已拒绝」、命令照样跑完**。所以在跑通之前一律按「没有这个能力」算——
这条纪律写在 `src/agents.mjs` 顶上。

跑：

```bash
node scripts/codex-probe.mjs --nap 20
```

探针做的事：起一个假的模型服务（OpenAI Responses 协议，不花 token、
跟你的账号额度无关），让 Codex 发起一次**需要提权**的 `exec_command`，
然后跑两轮——一轮 hook 放行、一轮 hook 拒绝，各看那条命令有没有真的执行。

- 两轮结论相反 → 通过。把 `approve` 改成 `true`，别的都不用动。
  `pause` / `cancel` / `inbox` 仍未验证，别一起改。
- 只有拒绝那轮「没执行」也不算通过：`codex exec` 里本来就没人可问，
  它自己拒了也是这个结果。必须放行那轮真的跑了，才说明回包被读懂了。

探针为什么带 `--dangerously-bypass-hook-trust`：它用的是自己刚生成在临时
目录里的 hooks（自己写的、自己审的），而 §3 那道闸门在非交互模式下没法点。
这个开关正是 Codex 给这种情形留的。

已知可能的坑：`codex exec` 里审批策略可能被强制成 `never`，那样
PermissionRequest 压根不会触发。探针会把这一条单独报出来；真遇上就改用
交互模式手工复现一次。

## 5. clamicro 侧的改动清单

| 文件 | 改了什么 |
|---|---|
| `src/agents.mjs` | 加 `codex` 能力条目（当前只开镜像）、`QUOTA.NONE`、按 `~/.codex/config.toml` 探测 |
| `src/codex.mjs` | 新增。往 config.toml 写/摘哨兵块、校验、安装流程、`codexBin` |
| `src/codex-tail.mjs` | 新增。跟读 rollout JSONL，补回 Codex 没有的回合结束事件（§3.5）|
| `src/state.mjs` | 加 `turn-start` / `turn-end` 两个**内部**事件（不在 `HOOK_EVENTS` 里）|
| `bin/codex-hook.sh` | 新增。中继：stdin → `/hooks/*?agent=codex` → stdout |
| `bin/session-start.sh` | 多接一个可选参数（后端名），其余不变 |
| `src/routes/hooks.mjs` | 认 `?agent=`；审批回包多一个 codex 分支 + `X-Clamicro-Decision` 响应头 |
| `src/http/respond.mjs` | `json()` 支持附加响应头 |
| `install.mjs` / `cli.mjs` | 安装时问一句、卸载时摘干净、`status` 里多一行 |
| `scripts/codex-probe.mjs` | 新增。§4 的验收探针 |

没有改的：`state.mjs`、`risk/`、`view/describe.mjs`、UI。因为 payload 同构，
它们不需要知道事件是从哪个后端来的。

## 6. 没做的，以及为什么

- **自愈**。Claude Code 那边每 5 分钟巡检一次、缺了就补回来。Codex 这边
  不补：重写配置会重置信任状态，等于每次自愈都让用户重点一次「信任」，
  而中间那段时间 hooks 是失效的。所以只在 `clamicro status` 里显示，
  由人决定什么时候重装。
- **额度**。hook 通道里拿不到任何用量数字（那些只出现在 app-server 的
  TokenCount 事件里）。`QUOTA.NONE` 就是这个意思——不是 0，是这条链路
  不上报。
- **暂停 / 取消 / 发消息**。拦截点看着都在（PreToolUse 认 `continue`、
  Stop 认 `decision:block`），但一样没验证过，所以一律按不存在算。
  验完再逐个打开。
- **走 app-server 而不是 hooks**。Codex 有 `codex app-server` /
  `codex remote-control`，事件更全（审批、token 用量、取消都是一等公民），
  但那要求 Codex **跑在 clamicro 底下**，而不是用户自己的终端里。
  代价太大，除非将来 hooks 这条路走不通。
