# Clamicro 架构

> 这份文档描述的是**现在的代码**，不是设想。每条结论都指到文件和行。
> 结论和代码对不上时以代码为准，然后回来改这里——一份说错的架构图比没有
> 更贵，因为它会被当成依据。

## 0. 一句话

> Clamicro 把编码 agent 的事件镜像到手机上，并且**只通过回答 agent 自己发来
> 的请求**来施加控制——所以一个后端能被控制到什么程度，完全取决于它肯把
> 哪些请求发出来。

后半句是硬约束，不是修辞。它直接推出了这份文档里几乎所有别扭的地方：

- 「暂停」的真实语义是**跑完手头这一步再停**，因为唯一能挂住 agent 的时刻是
  它主动发来 `PreToolUse` 的那一刻（[src/control.mjs](../src/control.mjs)）
- 一个不发审批请求的后端，**连审批按钮都不能画**——不是「以后再做」，是这条
  链路上没有可以挂住的东西
- 所以必须有一张能力矩阵，而且它必须是 **enforcement，不是 metadata**（§4）

## 1. 四层

```
┌─ BACKENDS ──────────────────────────────────────────────────┐
│                                                             │
│   Claude Code            DSH                    Codex       │
│        │                  │                       │         │
│        │           ┌──────▼──────┐                │         │
│        │           │ Plugin Host │  DSH 事件 →     │         │
│        │           │  (翻译进程)  │  Claude 兼容    │         │
│        │           └──────┬──────┘   hook 形状     │         │
│        │                  │                       │         │
└────────┼──────────────────┼───────────────────────┼─────────┘
         │                  │                       │
┌─ INGESTION ───────────────────────────────────────┼─────────┐
│        │                  │                       │         │
│        └──────────────────┴───────────┬───────────┘         │
│                                       ▼                     │
│                            HTTP  /hooks/*                   │
│                            （唯一的网络传输）                  │
│                                       │                     │
│   ┌───────────────────────────────────┼─────────┐           │
│   │ rollout tail   LOCAL READ ONLY    │         │           │
│   │ Codex only ───────────────────────┤         │           │
│   │ ~/.codex/sessions/**/*.jsonl      │         │           │
│   └───────────────────────────────────┼─────────┘           │
│                                       │                     │
│   ┌───────────────────────────────────┼─────────┐           │
│   │ HTTP /statusline   Claude only    │         │           │
│   │ 不进状态机，写会话元数据 + 账号额度 ──┤         │           │
│   └───────────────────────────────────┼─────────┘           │
└───────────────────────────────────────┼─────────────────────┘
                                        ▼
┌─ CORE ──────────────────────────────────────────────────────┐
│                                                             │
│   Event normalization  ← 两条传输在这里汇合，共用同一个 switch  │
│   State machine        （§3）                                │
│   Capability matrix    （§4，跨层 enforcement）               │
│   Session / Usage / Approval store                          │
└───────────────────────┬─────────────────────────────────────┘
                        │
            ┌───────────┴────────────┐
            ▼                        ▼
     Mobile / Web UI          Control Response
     （SSE 推送）                    │
                                    ▼
                          回到那个还挂着的 hook 请求（§5）
```

### 为什么 DSH 的特殊性在 Backend 层而不是传输层

`plugins/dsh-bridge` 是一个**翻译进程**，不是第二种传输协议。它把 DSH 的插件
事件映射成 Claude 兼容的 hook 形状，然后 POST 到**同一批** `/hooks/<event>`
端点（[plugins/dsh-bridge/lib/report.js](../plugins/dsh-bridge/lib/report.js)
写着「走的是现成的 hook 端点，不新开接口」）。

把它画在传输层会让人以为有三种协议要维护。只有一种。

## 2. 摄入：一条传输 + 两条本地通道

### 2.1 HTTP `/hooks/*` —— 唯一的网络传输

三个后端共用。事件白名单在
[src/routes/hooks.mjs](../src/routes/hooks.mjs) 的 `HOOK_EVENTS`：

```
session-start  user-prompt-submit  pre-tool-use  post-tool-use
post-tool-failure  notification  stop  stop-failure  session-end
```

`permission-request` **不在这张表里**——它走单独的分支，因为它是唯一会
**挂住不返回**的一条（§5）。

各后端接了几条不一样：Claude Code 9 条（`HOOK_MAP`，
[src/settings.mjs](../src/settings.mjs)），Codex 6 条（`CODEX_HOOKS`，
[src/codex.mjs](../src/codex.mjs)）。Codex 少的三条——`Notification`、
`PostToolUseFailure`、`StopFailure`——**它自己没有**，不是我们没接。

### 2.2 rollout tail —— Codex only，本机只读

Codex **没有回合级的结束事件**（0.149 的十个 hook 事件里没有 `stop`），所以
会话走不出 Running。补法是跟读它的 rollout JSONL
（[src/codex-tail.mjs](../src/codex-tail.mjs)）：

| 盘上的行 | 归一化成 |
|---|---|
| `task_started` | `turn-start` |
| `task_complete`（含 `error` 字段） | `turn-end` |
| `token_count` | `turn-usage` |

`turn-usage` **单独一档，不搭在 turn-end 上**：Codex 的 `token_count` 独立
落盘，时机不绑 `task_complete`，而失败的回合根本走不到 turn-end
（[src/state.mjs](../src/state.mjs) 的 `turn-usage` 分支）。

**这条通道不绕过归一化。** 它调的就是 `store.applyHook('turn-start' | …)`
（[src/codex-tail.mjs](../src/codex-tail.mjs) 的 `tick`），跟 HTTP 那条进同一个
switch、同一个状态机、同一套通知。差别**只在传输**。

`LOCAL READ ONLY` 是一条安全边界，不是实现细节：`turn-*` 这三个名字**故意
不在 `HOOK_EVENTS` 里**，所以它们进不了 `/hooks/*` 路由，**局域网上伪造不
出来**，唯一的来源是本机 `~/.codex` 下那份文件
（[src/state.mjs](../src/state.mjs) 的 `turn-start` 分支）。

为什么读文件而不接 `codex app-server`：那是一条有状态的双向协议连接，还要
依赖跟桌面 App 共用的常驻 daemon。跟读文件是只读的——读错了、读不到、格式
变了，最坏结果是回到「状态不更新」，不会把别人的会话搞坏。代价要说清楚：
**rollout 是 Codex 的内部格式，没有版本承诺**，所以认不得的字段一律当没看见。

#### 那条没走的路：app-server 的控制面（2026-08-28 决定不走）

上面那段说的是「为什么读文件」。这里记**另一半**：app-server 那条路能给什么，
以及为什么明知道它更好，仍然不走。

事实是查证过的，不是印象。`codex app-server generate-json-schema --out <dir>`
（codex-cli 0.150.0-alpha.8）导出 292 个 schema 文件，`ClientRequest` 里
**95 个方法**，其中三个正是我们缺的：

| 方法 | 它能做什么 |
|---|---|
| `turn/start` | 发起一轮 |
| `turn/interrupt` | **中断正在跑的那一轮**，随后发 `turn/completed`（`interrupted`）；文档明说不会终止后台终端 |
| `turn/steer` | **往当前这一轮里插话**。参数 `{threadId, expectedTurnId, input[]}`，其中 `expectedTurnId` 是「必须匹配当前活动轮次」的强制前置条件 |

也就是说：

- 「立即中断本轮」——**hooks 做不到**（`PreToolUse` 只在工具执行前，拦不住
  一个不调工具的回合），而 app-server 有现成的
- 「从手机发消息」——我们现在是靠 `Stop` hook 回 `{decision:'block'}` **模拟**的，
  只能等这一轮结束才送达；`turn/steer` 是真的中途插话

**仍然不走。** 理由不是「做不到」，是**爆炸半径**：

- app-server 是一条有状态的双向连接，依赖的那个 daemon **和桌面 ChatGPT 共用**。
  今天最坏情况是「状态不更新」；接上之后，我们的 bug 可能中断**用户正在用的
  桌面会话**
- 这条链路的失败无法限定在 clamicro 自己身上，而这个产品的全部前提是
  「它不该把别人的会话搞坏」

所以 Codex 侧的能力矩阵保持现状：只镜像，不控制。**这不是「以后再说」，
是一个知道代价之后做的选择**——重新讨论它时，要讨论的是上面那条爆炸半径，
不是「协议支不支持」（支持，已验证）。

同理不做的还有两条：

- **`process.kill(owner_pid)`**：Codex 的 app-server、DSH 的主进程是所有会话
  共用的，杀一个 pid 等于杀掉那个后端的全部会话（见 src/lifecycle.mjs 里对
  owner_pid 形状的说明）
- **把服务日志推到手机**：里面有 cwd、命令原文、令牌前缀。即使抹一遍，
  那也是在扩大数据面，而它换来的只是「排查方便一点」

### 2.3 `/statusline` —— Claude Code only

不是 hook，是独立端点（[bin/statusline.sh](../bin/statusline.sh) →
`/statusline?render=1`）。三件事：

1. **不驱动状态机**——`applyStatusLine` 从不写 `state`
2. **写会话元数据**——`session_name` / `cwd` / `model` / `cost_usd` /
   `context`，并且 `this.session(id)` 对没见过的 id 是**新建**，所以它是
   除 hooks 之外的**第二条会话来源**（[src/state.mjs](../src/state.mjs) 的 `applyStatusLine`）
3. **回写终端**——响应体就是状态栏文本

第 3 点常被说成「唯一的双向通道」，那不准：每条 hook 都是请求/响应。它真正
独特的是**响应内容是给人看的文本，而不是控制决策**。

## 3. Core：状态机

七档：`Idle` `Running` `Waiting Approval` `Waiting Input` `Paused` `Done`
`Error`（[src/state.mjs](../src/state.mjs) 的 `STATE`）。**不是一条线**。

```
                    ┌──────┐
                    │ Idle │◄──── session-start
                    └───┬──┘
                        │
              user-prompt-submit
                        │
                        ▼
   ┌───────────────► Running ◄───────────────┐
   │                 │  │  │                 │
   │                 │  │  └── pause ──► Paused
   │                 │  │                    │
   │                 │  │       ◄─── resume ─┘
   │                 │  │
   │                 │  └── stop / turn-end ──► Done
   │                 │      stop-failure ─────► Error
   │                 │      turn-end(error) ──► Error
   │                 │
   │        PermissionRequest │ notification: permission_prompt
   │                 │        │ (DSH: plugin approval)
   │                 ▼        ▼
   │          Waiting Approval ──┐
   │                 │  ▲        │ 还有别的挂着：留在原地，
   │                 │  └────────┘ 只把指针挪到下一条
   │                 │
   └──── 最后一条清掉 ┘

   cancel ──► 置标记，状态不变（界面显示「取消中」）
                ──► 下一个拦截点消费掉它 ──► Idle

   Running ── notification: idle_prompt ──► Waiting Input   （仅 Claude Code）
   Waiting Input ── user-prompt-submit ──► Running          （不是死胡同）

   session-end ──► 会话从 store 里删除（任何状态都能走，不是一个状态）
   Done / Error ── user-prompt-submit ──► Running（都不是终态）
```

### 每条边的生产者

「统一状态机」指的是**状态档位**统一，**转移**不统一。

| 转移 | claude-code | dsh | codex |
|---|---|---|---|
| → Waiting Approval | `PermissionRequest`（阻塞）+ `notification: permission_prompt`（感知） | plugin approval | **不产生**，见 §4 |
| → Waiting Input | `notification: idle_prompt` | ✗ | ✗ |
| → Paused | pause flag + `PreToolUse` | ✗ | ✗ |
| → Done | `stop` | 映射的 `stop` | rollout `task_complete` |
| → Error | `stop-failure` | 映射的 `stop-failure` | rollout `task_complete` 带 error |
| → Running（注入消息） | `stop` 回 `{decision:'block'}` | ✗ | ✗ |

画图时**标机制而不是标后端名**。写「Codex: N/A」会被读成「以后会有」；
写「Codex 这条链路不产生 Waiting Approval」才是当前的事实。

### Waiting Approval 和 Paused 是两件事

- **Waiting Approval**：agent 主动问「这个操作可以执行吗」
- **Paused**：用户告诉 agent「先别继续」

所以两条边都从 Running 出发，`Waiting Approval → Paused` 这条边**不存在**。

### Idle 和 Waiting Input 是两件事

两者都是「不动」，但对用户的意思相反：

- **Idle**（`session-start`）——会话开着，没事发生。**不用管。**
- **Waiting Input**（`notification: idle_prompt`）——agent 停下来了，
  **在终端里等你打字**。你不去，它就一直不动。

这两档一度是同一个。合在一起的后果是手机上看不出「要不要现在起身」——
而那正是这个产品唯一想回答的问题。

只有 Claude Code 产生 Waiting Input（别的后端没有对应事件，它们的会话
永远不会进这一档，这不是缺陷）。它**不进 sweepStale**：那个扫的是「说在
跑却半天没动静」，而这一档是如实地不动，标成陈旧等于把一个准确的状态
说成可疑的。

## 4. 能力矩阵是 enforcement，不是 metadata

`AGENTS` 表在 [src/agents.mjs](../src/agents.mjs)：

| | approve | pause | cancel | inbox | quota |
|---|---|---|---|---|---|
| Claude Code | ✓ | ✓ | ✓ | ✓ | WINDOW |
| DeepSeek Harness | ✓ | ✗ | ✗ | ✗ | TOKENS |
| Codex | ✗ | ✗ | ✗ | ✗ | TOKENS |

**没有「?」这一档。** 没验证过的原语按不存在处理——漏给一个入口，用户会来
问；多给一个不工作的入口，用户不会来问，他只会以为这东西坏了。

这张表在**三个地方**执行，而且三处不等权：

```
                    CAPABILITY MATRIX
                           │
        ┌──────────────────┼──────────────────┐
        ╎ (虚线)            │                  │
        ▼                  ▼                  ▼
    UI Render          Control API        Ingestion
    /api/config        control / say      permission-request
        │                  │                  │
    不画按钮             409 拒绝            回「无意见」
```

**UI 那一路是装饰性的、可以失效**：`capOf` 在 `/api/config` 还没到手时回落
到 claude-code（全部为真，[src/agents.mjs](../src/agents.mjs) 的 `capOf`），而手机上
缓存着升级前的页面正好是这个状态。所以真正的 enforcement 只有服务端两处
（[src/routes/api.mjs](../src/routes/api.mjs) 的 control / say、
[src/routes/hooks.mjs](../src/routes/hooks.mjs) 的 permission-request），
见 [test/agent-caps.test.mjs](../test/agent-caps.test.mjs)。

### Codex 的 `approve: false` 是真生效的

不是「暂时还没实现」。`permission-request` 端点据它**直接回「无意见」**：
不建审批记录、不推手机、落回 Codex 自己的权限流程。

缺的也不是代码——中继脚本和应答形状都写好了。缺的是**一次真机验收**：
「拒绝」这一路没让 Codex 真的挡下过一条命令，见
[docs/codex-bridge.zh-CN.md](./codex-bridge.zh-CN.md) §4。猜错的表现不是
「按钮点了没反应」，是手机上写着「已拒绝」、命令照样跑完——一个假审批。

跑通之后改这一个布尔值，别处不用动。

## 5. 控制面：只回答，不外发

**Clamicro 从不主动调用任何 agent。** 所有控制都是「把一个进来的请求挂住，
然后回答它」：

```
Agent ──── hook 请求 ────► Clamicro
                              │
                          hold（最长 570s，必须赶在 hook 系统超时之前自己结掉）
                              │
Agent ◄──── 响应即决策 ────────┘
```

| 动作 | 挂在哪 | 回什么 |
|---|---|---|
| 审批 | `PermissionRequest` | allow / deny |
| pause | `PreToolUse` | 一直不返回 |
| cancel | `PreToolUse` | `{continue:false}` |
| 发消息 | `Stop` | `{decision:'block', reason}` |

这就是为什么 Codex 的 inbox 不可能有：它**没有 `Stop` 事件**，那个唯一能往
里发话的口子不存在。也是为什么单靠 `PreToolUse` 拦不住一个不调工具的回合。

## 5.5 进程生命周期：谁把服务拉起来，谁让它走

**拉起来**是各后端的 SessionStart：

| 后端 | 会不会拉起 | 机制 |
|---|---|---|
| Claude Code | 会 | SessionStart 是 `command` 类型，跑 `bin/session-start.sh` |
| Codex | 会 | `bin/codex-hook.sh` 的 session-start `exec` 同一个脚本 |
| DSH | **不会** | 插件进程内 `fetch`，连不上只记一行日志 |

DSH 这条是个真实的缺口：**只开 DSH 的话服务不会起来**，手机上什么都没有，
唯一的线索是 DSH 自己日志里的一行。补它需要 DSH 侧有一个「启动时执行命令」
的口子，目前没找到。

**让它走**是 `src/lifecycle.mjs`：所有后端都退出了就自己关，而不是空转到天亮。

判据不是「会话数为零」——`session-end` 在 kill -9 / 关终端 / 崩溃时都不发，
那样的会话永远赖在表里，服务于是**永远不退**（方向正好反了）。也不是按名字
搜进程——`service-id.mjs` 早有结论「命令行只用来验证一个已知 PID，不用来
查找进程」，而 Claude Code 的可执行文件路径带版本号、有三种形态。

用的是 **session-start 时宿主自报的 PID**（`?owner=`），判活是 `kill(pid, 0)`。
实测 `$PPID` 就是 agent 本身，中间没有 shell：

```
claude-code  ppid → …/claude-code/<ver>/claude.app/Contents/MacOS/claude
codex        ppid → /Applications/ChatGPT.app/…/codex … app-server
dsh          插件在 DSH 进程内，直接 process.pid
```

**形状因后端而异，这决定了它只能做这一件事**：Claude Code 是一个会话一个
进程，而 Codex 的 app-server、DSH 的主进程是所有会话共用的常驻进程。所以它
回答的是「这个后端还开着吗」，**不是**「这个会话还活着吗」——后者仍归
`sweepStale`。拿它去收会话会把 Codex 的会话全判错。

四条「拦住」，方向一律偏保守（关错的代价是审批静默失效，多跑的代价只是一个
闲置进程）：前台启动（`clamicro start`，人正盯着那个窗口）、有待审批（服务
一走卡片永远挂着，而 Codex 拿不到回包会当作「无意见」放行）、任一宿主还活着、
有**新鲜的**未知宿主会话（升级期的老会话；过了陈旧线才不再算数，否则一个
kill -9 留下的会话会把服务钉死到重启）。

还要**连着两拍**（巡检 5 分钟一拍，即至少十分钟）才动手。这个余量是给重启
留的：退出 ChatGPT 再打开、Claude Code 自我更新，中间都有一段谁都不在的窗口，
一拍就退会让用户看到手机莫名断一下线。

## 6. 已知的粗糙处

写在这里是为了不让它们被当成设计。

### 6.1 pause 的状态早于事实，靠 `held` 兜着

`Paused` 这一档有两个时刻，中间隔着不确定的一段：

| | 何时 |
|---|---|
| 状态翻成 `Paused` | **点按钮的当下**（[src/state.mjs](../src/state.mjs) 的 `noteControl`） |
| agent 真的停住 | 下一个 `PreToolUse` 撞上拦截点时 |

中间这段时间里，agent 还在跑手头那一步，而状态已经说「已暂停」了。

补的办法是 `held`——「此刻真的有工具调用挂在拦截点上」，由
`control.on('held')` 推给会话（[server.mjs](../server.mjs)），界面据它把这
一档分成两个词：没挂住是「暂停中」，挂住了才是「已暂停」。判断放在
[ui/agents.js](../ui/agents.js) 的 `stateLabel` 里，两个页面共用一份——
分头写早晚有一处漏掉，而漏掉的那一处会安静地继续说假话。

**注意 `held` 事件两个方向都发。** 只在挂住时发一次的那一版，标记置上之后
再也清不掉：一个曾经被暂停过的会话此后永远显示「正卡在工具调用前」。当时
没暴露，是因为没有任何前端读它。见 [src/control.mjs](../src/control.mjs) 的
`#release` / `#drop`。测试在 `test/control.test.mjs`（单元）和
`test/control-lifecycle.test.mjs`（走真服务，看的是手机拿到的那份会话对象
——这一轮的 bug 全在接线处，单测证明不了接线）。

还没抹平的是**状态值本身**：`state` 仍然早于事实，只有显示层补了。要彻底
一致得把 `Paused` 拆成两档，那会动到两个前端的所有 `=== 'Paused'` 判断，
暂时不值得。

### 6.2 cancel 的状态**晚于**事实，靠 `control` 兜着

跟 pause 正好相反：

| | pause | cancel |
|---|---|---|
| 点下去 | 状态立刻翻成 `Paused` | 状态**不变** |
| 真正落地 | 下一个 `PreToolUse` 挂住 | 下一个拦截点回 `{continue:false}` → `Idle` |
| 中间那段靠什么说话 | `held` | `control === 'cancelled'` |

两种约定，纯属历史。cancel 那一侧其实是更诚实的做法——「请求了」和「生效了」
本来就该分开——只是它一度**什么都不说**：点完取消到真取消之间，界面上没有
任何变化，看起来就是点了没反应。

现在两条都补上了，而且判断在同一个地方
（[ui/agents.js](../ui/agents.js) 的 `stateLabel`）：

```
Running  + control=cancelled  →  取消中     ┐ 取消排在暂停前面：它是用户最近
Paused   + control=cancelled  →  取消中     ┘ 一次意图，暂停中再点取消很常见
Paused   + held=false         →  暂停中
Paused   + held=true          →  已暂停
```

**取消中只在 Running / Paused 时说。** 取消标记会一直留到下一个拦截点消费
它（[src/control.mjs](../src/control.mjs) 有意如此），所以一个自己跑完的
回合结束之后标记还在——那时候写「取消中」是假的，那一轮已经结束了，谁也
没取消它。

### 6.2.1 armed cancel 会跨回合

上面那条的另一面：取消请求没被消费掉的话，它会留到**下一轮的第一个工具
调用**上。表现是「我上次点的取消，把这次的第一条命令干掉了」。

这是 `control.mjs` 的既有语义（没有挂起者时保留 `CANCELLED`，让下一个拦截
点来消费），改它要动控制面的语义，没在这一轮做。现在至少**看得见**了：
标记还在的时候，Running 的会话会显示「取消中」。

### 6.3 额度有两条并行的模型

Claude Code 的窗口走 `limits`，形状**写死**了 `five_hour` + `seven_day`
（来自 statusLine）。Codex 报的是单个 30 天窗口
（`rate_limits.primary`，`window_minutes: 43200`），塞不进去，所以另开了
一条 `store.agentLimits`（agent -> `windows[]`，
[src/state.mjs](../src/state.mjs) 的 `turn-usage` 分支）：`codex-tail.mjs` 的 `readWindows`
翻译，`home.html` 的 `agentUsage` 显示，和累计 token 并排。

两条模型回答的是同一个问题，将来该合并成一条。

这里原来有一个**隐式耦合**：`agentUsage` 只在 `quota === 'tokens'` 分支里读
`windows`，所以把 Codex 的 quota 档位改成别的，30 天窗口会跟着一起从界面上
消失，而不会有任何测试变红。**已经修掉**——每一档都带上 `wins`，判据改成
「有没有收到」而不是「归在哪一档」：窗口是后端**自己报的事实**，跟我们给它
归的类无关。`test/agent-usage.test.mjs` 逐档跑一遍钉住这件事。

### 6.4 `QUOTA.NONE` 当前没有后端使用

Codex 曾经是。留着这一档是因为 `agentUsage` 认它，将来接一个真的什么都不报
的适配器时不必重新发明——**「空着」和「不上报」必须分得开**，都显示成空白的
话，用户会一直等一个永远不会出现的数字。

## 6.5 界面：每一屏现在是什么形状

这一节存在的理由很具体：**同一个 UI 决定被做过两遍以上。**

- 「发消息」搬过两次：独立 tab → 会话页时间线下方（`f0e6d80`）→ 常驻底栏
  输入框（`e70f327`）
- skill 计数两步才落地：先加上（`38a3824`），紧接着改成只在空闲时显示
  （`9c1c3d8`）
- 「让发消息更好找」先做了一颗跳转胶囊，随后整个废掉，换成常驻输入框

服务端每改一处都有地方可查「现在是什么形状、为什么」——就是这份文档前面
六节。**UI 一处都没有。** NOTES.md 里其实记了不少 UI 决定，但它是编年体：
想知道「会话页底栏该是什么样」得读十条散在各轮里的记录，于是没人读，
于是重新决定一遍。

所以这一节按**屏**排，不按时间排。改 UI 之前先看这里；改完把这里一起改。

### 三格导航

首页 / 会话 / 历史（`data-tab="home" | "sess" | "hist"`）。

四格试过一次：加了历史 tab 之后短暂到过四格，手机底部四格已经偏挤，
把「发消息」并进会话页之后回到三格（`f0e6d80`）。

### 首页 `ui/home.html`

| 部位 | 现在的形状 | 判据 |
|---|---|---|
| 顶部路径行 | `clamicro / overview` + 连接光标 + 会话数 | 左边是**产品名**，不是某个项目 |
| 分组 | 按后端分组，**单后端也分组** | 一种排版应付所有情况，不做两套 |
| 空闲态 | 主控台 + 用量环 | 空闲时用量是主体 |
| 非空闲 | 用量收成 header 下一条细线 | 有事发生时让位，但不消失 |
| skill 计数 | 只在空闲时显示 | 参考信息在有事发生时让位（判据与用量共用 `isIdleView`） |
| 额度过期 | 环压灰 + 一行轻字 | 见下面「否决过的」 |

### 会话页 `ui/session.html`

时间线**新的在上**。底栏是一条常驻的输入条：

```
[⏸ 暂停] [🚫 取消] [ 输入框………………… ] [⬆ 发送]
不会立刻送达 · 跑完当前这一轮后进入对话
```

上方按需叠三样：断线横幅（红）、暂停/取消状态说明（黄）、排队中 N 条。

四条不能动的约束：

1. **底栏那行送达提示任何时候都不能省。** 聊天的形状自带「按下去对面就
   收到了」这个承诺，而注入的唯一时机是 Stop hook；会话空着时更远，得等你
   在终端里再发起一轮。那一行是这个形状唯一拆得掉自带承诺的东西。
2. **不支持注入的后端整格不画**（`cap.inbox`）。判据与服务端 409 同源。
   发出去的消息比灰掉的按钮更像成功。
3. **输入框只建一次，之后永不重建。** render 由 SSE 驱动，重建会在用户打字
   时抢走焦点、把光标弹回句首、在手机上收起键盘。
4. **断线时不禁用任何控件。** 判据可能是错的：SSE 会被代理/移动网络/系统
   休眠单独掐掉而普通 HTTP 照样通。陈述事实，动作照旧让人试，失败如实说。

### 否决过的（别再做回去）

| 做过 / 想过 | 为什么否决 |
|---|---|
| 「发消息」独立 tab | 第一件事是「发给哪个会话」——把你刚有的上下文丢掉再让你重建；且 `cap.inbox` 只有 Claude Code 为真，对纯 Codex / 纯 DSH 永远是空 tab |
| 跳转胶囊「↓ 发消息」 | 输入框改成常驻之后没有可跳的地方了。**只留「↑ 最新」一个方向** |
| 顶部写当前项目名 | 多项目时那是「任意挑一个」：三个会话在跑，顶上写着 proj-3，另外两个连名字都不露面。项目名写在每张卡片上，那里它有归属 |
| 标题前的小圆点（连接指示） | 和路径行那个光标说同一句话。两个指示灯说同一件事，人要多看一处才能确认，而且更新时机不同步时反而制造疑问 |
| 额度过期用 ⚠️ 独立警告条 | 放在灰环下面它是整张卡上最响的东西，为的是说一件既不紧急、也不需要你此刻做任何事的事——而「不是当前值」两只灰环已经说过了 |
| 环下面过期时重复写「N 前的数据」 | 两只环并排后那句话会原样出现两遍，加上 gwhy / cmeta 就是三遍 |
| 「取消本轮」/「取消中」 | 它拦的是**下一次工具调用**，一个不调工具的回合它碰不到。现在叫「取消下一步」/「将阻止下一步」 |
| 「加入队列」 | 从内部机制反推出来的词——得先知道有个队列才知道自己在干嘛。现在叫「发送」，送达时机交给下面那行解释 |

### 改 UI 时问自己的三个问题

1. **这一屏现在的形状，上面这几张表里有没有？** 有就先读判据，再决定要不要推翻——推翻可以，但要把表一起改。
2. **我要加的东西，「否决过的」里有没有？** 有就先看当初为什么否决，条件变了没有。
3. **它在所有后端下都成立吗？** 能力矩阵（§4）会让 Codex / DSH 少掉一半控件，最容易漏的就是「这一格空了之后这一屏还成不成立」。

## 7. 加新后端时的四个问题

每接一个后端，成本不是「写一个适配器」，而是**多一种摄入机制**：DSH 要了一个
插件宿主，Codex 要了一个文件跟读器。先回答这四个，再估工作量：

1. **有没有阻塞式的授权请求？** —— 决定 `approve`。没有就只能镜像。
2. **有没有回合结束信号？** —— 没有就得像 Codex 那样另找通道，否则会话永远
   停在 Running。
3. **有没有可以挂住的拦截点？** —— 决定 `pause` / `cancel`。
4. **有没有往回注入消息的口子？** —— 决定 `inbox`。

四个全是「没有」也能接——那就是一个纯镜像后端，能力矩阵里四个 `✗`，UI 上
一个控制按钮都不画。**那是一个完整的、诚实的接入**，不是半成品。
