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

两条模型回答的是同一个问题，将来该合并成一条。合并之前有一个**隐式耦合**
值得知道：`agentUsage` 只在 `quota === 'tokens'` 分支里读 `windows`，所以
把 Codex 的 quota 档位改成别的，30 天窗口会跟着一起从界面上消失，而不会有
任何测试变红。

### 6.4 `QUOTA.NONE` 当前没有后端使用

Codex 曾经是。留着这一档是因为 `agentUsage` 认它，将来接一个真的什么都不报
的适配器时不必重新发明——**「空着」和「不上报」必须分得开**，都显示成空白的
话，用户会一直等一个永远不会出现的数字。

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
