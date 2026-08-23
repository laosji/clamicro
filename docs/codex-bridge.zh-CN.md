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
| `src/codex.mjs` | 新增。往 config.toml 写/摘哨兵块、校验、安装流程 |
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
