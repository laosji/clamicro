# Clamicro × DeepSeek Harness 桥接方案

> 修订于 2026-08-15。本版基于对 DSH 官方文档与源码的实际核查重写，替换掉上一版基于二手调研的假设。
> 核查过的结论标注了出处；仍需实测的只剩一项（§7 探针）。

## 0. 结论先行

**能做。审批的**机制**（waterfall + Promise 答复器）是确定的；但**触发面**比 Claude Code 窄——它审批的是「沙箱升级请求」，不是「每次工具调用」（见 §5.1 实测澄清）。**

上一版方案把「只读监控」当作低风险的阶段一、把「审批拦截」当作可能做不成的阶段二。这个判断是反的：

- 审批拦截：DSH 有公开的 `ctx.approval` 服务和 `approval/request` waterfall 事件，答复器可以返回 `Promise`，已有 `dsh-approval-llm` 做了完全同构的事情（在答复器里 await 一个 LLM 调用）。文档齐全，有现成范本。**但注意**：`approval/request` 的实际触发点是 `approveEscalation`（bash 请求 `sandbox_permissions: danger-full-access`），不是每条 bash——`tools/pre-execute` 的「每次 ask」gate 在 0.1.0-rc.6 里未实现（`dsh-tool-bash` 里的 TODO）。详见 §5.1。
- 只读监控：DSH 自带 Web UI，社区已有四个插件把它搬上手机（`dsh-mobile-gate` 甚至也做了首访审批 + 设备令牌绑定 + 限流，跟我们的配对机制高度重叠）。纯状态镜像在 DSH 上不构成差异化。

而且两者不独立——`ApprovalRequest` **刻意不带工具参数**，审批卡片要显示「它到底要干什么」、要跑风险评估，必须靠 `callId` 回 session log 里捞。所以事件订阅是审批功能的**必要零件**，不是可以单独交付的阶段一。

因此本方案的顺序是：先改造 clamicro 支持多后端（不依赖 DSH，可独立发布）→ 再写桥接插件的事件订阅 → 再接审批闭环。

---

## 1. 已核查的 DSH 事实

| 事项 | 结论 | 出处 |
|---|---|---|
| 项目 | `deepseek-ai/deepseek-harness`，TypeScript，Cordis 内核，"Everything is a Plugin" | GitHub |
| 生态 | `dsh-plugin` topic 下 2881 个仓库 | github.com/topics/dsh-plugin |
| 插件形态 | ESM only（`"type": "module"`），包名 `@deepseek-ai/dsh-<name>`；注册即副作用，走 `ctx.effect()` / `ctx.on()`，`register()` 返回 disposer | `AGENTS.md` |
| 事件订阅 | `session/event`，签名 `(this: Scoped<Session>, session: Session, event: SessionEvent): void` | `docs/subsystems/session.md` |
| 订阅安全性 | post-commit、fire-and-forget；**观察者异常被记录并隔离，不会让已提交的 append 失败** | 同上 |
| 审批服务 | `ctx.approval.request(req): Promise<ApprovalOutcome>`、`setPolicy()`、`overrideOf()` | `docs/subsystems/approval.md` |
| 审批介入点 | `approval/request`，**waterfall dispatch**；返回 outcome 即认领，调 `next()` 即交给下一个 | 同上 |
| 决策可异步 | 是，答复器返回 `Promise<ApprovalOutcome>` | 同上 |
| 失败语义 | **fail-closed**：无人应答 / 抛异常 / 返回不合规 → `'unavailable'` → 不授予 | 同上 |
| 请求不带参数 | `ApprovalRequest` 只有 `agent` / `toolName` / `callId?` / `reason?` / `signal?`，参数刻意省略以免与已流式发出的 tool call 重复 | 同上 |
| 现成范本 | `dsh-approval-llm`：在 `approval/request` 上注册 waterfall 答复器，内部 await 审查模型，`timeoutMs` 默认 60000，超时 `next()` 交人类 | 该仓库 README |

### 1.1 关键类型

```ts
type ApprovalOutcome =
  | 'allowed-once'   // 唯一的授予形式，一次性
  | 'rejected'
  | 'cancelled'
  | 'unavailable'    // fail-closed 兜底值

interface ApprovalRequest {
  agent: Agent
  toolName: string
  callId?: string        // 关联到已流式发出的 tool call
  reason?: string
  signal?: AbortSignal   // 请求被撤回时触发
}
```

注意 `allowed-once` 是**唯一**的授予形式，没有「允许并记住」。预授权属于 `permission-presets` 另一条 seam，不在本方案范围内。

### 1.2 session 事件名

与上一版猜测的完全不同，实际是：

`turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、`assistant/message`、`tool/call`、`tool/result`、`assistant/chunk`、`todo/write`、`request/header`、`request/context`、`session/end-seed`，加上审批侧的 `approval/asked`、`approval/decided`。

插件可以通过 declaration merging 扩展这张表，所以订阅端必须容忍未知事件名，不能 switch 到 default 就抛。

---

## 2. 与 Claude Code 的机制对照

这张表是整个方案的基础，写实现前先读一遍——两边差异最大的地方恰好都在容易出事的地方。

| | Claude Code | DSH |
|---|---|---|
| 介入方式 | 进程外 HTTP hook，服务端挂住响应不返回 | 进程内 waterfall 答复器，返回 Promise |
| 超时语义 | **fail-open**：超时被当成非阻塞错误 → 放行 | **fail-closed**：异常/不合规 → `unavailable` → 不授予 |
| 我们的对策 | 570s 主动 deny（`SELF_TIMEOUT_MS`），绝不走到系统超时 | 反过来：必须保证失败时 `next()` 交回人类，绝不让异常冒泡 |
| 参数来源 | payload 里直接带 `tool_input` | 不带，要按 `callId` 回 session log 的 `tool/call` 捞 |
| 撤回 | `req.on('close')` → `approvals.abandon()` | `request.signal`（AbortSignal） |
| 授予粒度 | allow / deny | `allowed-once` / `rejected` / `cancelled` / `unavailable` |

### 2.1 fail-closed 带来的新故障模式

Claude Code 侧，clamicro 服务挂掉 = 回退到 Claude Code 自己的权限流程，用户顶多是「手机上收不到了」。

DSH 侧不是。答复器如果抛异常或返回垃圾，DSH 会判 `unavailable` 也就是**不授予**——clamicro 挂掉会把 DSH 的所有待审批工具调用全卡死。

所以桥接插件里那个 `try/catch` 不是「优雅降级」，是硬性安全要求：

```ts
try {
  const outcome = await askPhone(req, { signal })
  return outcome
} catch {
  return next()   // 交回人类，绝不 throw，绝不返回 'rejected'
}
```

超时也走 `next()` 而不是 deny——跟 `dsh-approval-llm` 的 escalate 行为一致。DSH 有 Web UI 会接着问人，这条退路在 Claude Code 上是不存在的（那边终端会空挂），所以这里可以也应该更保守。

---

## 3. Clamicro 侧改造：多后端支持（M0）

**这一步完全不依赖 DSH，可以独立开发、独立发布，Claude Code 行为零变化。**

### 3.1 会话增加 `agent` 字段

[`src/state.mjs`](../src/state.mjs) 的 session 对象加一个字段，缺省 `'claude-code'`——现有 hook 不会传这个字段，缺省值保证老路径行为不变：

```js
agent: 'claude-code',   // 'claude-code' | 'dsh'
```

`applyHook()` 里从 payload 取：`if (payload.agent) s.agent = payload.agent`。

### 3.2 能力矩阵：新建 `src/agents.mjs`

多后端的关键不是「显示来源」，是**不同后端能做的事不一样**。UI 必须按能力渲染，否则按钮在那儿点了没反应——比没有按钮更糟。

```js
export const AGENTS = {
  'claude-code': {
    label: 'Claude Code',
    approve: true,
    pause: true,      // control.gate 挂在 pre-tool-use 上
    cancel: true,
    inbox: true,      // 靠 Stop hook 返回 decision:block 注入
    quota: 'window',  // 5h / 7d 滚动窗口
  },
  dsh: {
    label: 'DeepSeek Harness',
    approve: true,    // approval/request 答复器
    pause: false,     // DSH 无等价拦截点（未验证，先按没有做）
    cancel: false,
    inbox: false,     // 应走 user-questions seam，另立项，见 §8
    quota: 'tokens',  // 无窗口配额概念，只有累计 token / 花费
  },
}

export const capOf = (agent) => AGENTS[agent] ?? AGENTS['claude-code']
```

能力矩阵由服务端下发（并进 `/api/config` 或直接挂在 session 上），UI 不自己硬编码后端名。

### 3.3 UI 改动清单

| 位置 | 现状 | 改成 |
|---|---|---|
| [`ui/home.html:1310`](../ui/home.html) 空状态 | 硬编码「新开一个 Claude Code 会话即可」 | 按已安装的后端列出 |
| [`ui/home.html:1319`](../ui/home.html) 会话卡片 | 只有 model / cost chip | 加一个后端 badge；`quota: 'tokens'` 的会话不渲染 ctx 量表 |
| [`ui/home.html:959`](../ui/home.html) 账户额度区块 | 5h / 7d 双量表，数据来自 Claude Code statusLine | 标注来源为 Claude Code；无 Claude Code 会话时整块隐藏 |
| [`ui/session.html:198`](../ui/session.html) 暂停按钮 | 无条件渲染 | `cap.pause` 为假时隐藏，并说明原因 |
| [`ui/session.html:200`](../ui/session.html) 取消按钮 | 文案写死「Claude Code 会在下一个工具调用前终止本轮」 | 按后端出文案；`cap.cancel` 为假时隐藏 |
| [`ui/home.html:682`](../ui/home.html) 发消息 tab | 全局入口 | 目标会话 `cap.inbox` 为假时，该会话不出现在收件目标里 |

原则：**能力缺失就不给入口，并且说得出为什么**。这跟「宁可没有审批功能，也不能做假审批」是同一条原则，只是推广到了 pause / cancel / 发消息上。

### 3.4 额度区块的替代

DSH 没有 statusLine，也没有 5h / 7d 窗口概念（API key 计费）。对应物是 per-request token 累计（参考 `dsh-token-usage` 的做法）。

`quota: 'tokens'` 的会话卡片显示累计 token 与花费，不显示滚动窗口量表。首页顶部那块账户级额度是 Claude Code 账户的属性，不是全局属性，要标清楚。

---

## 4. 桥接插件：事件订阅（M1）

包名 `clamicro-dsh-bridge`。职责只有一个：把 DSH 的语言翻译成 clamicro 已经认得的语言。**不为 DSH 单独做 UI。**

### 4.1 事件映射

已对照 `@deepseek-ai/dsh-session@0.1.0-rc.6` 的 `SessionEventMap` 实测。
权威事件表共 **46 项**（`lib/known-event-types.js`），我们只翻译其中 7 项。

| DSH `session/event` | 实际形状 | clamicro hook 端点 |
|---|---|---|
| `user/message` | `UserMessage`，靠 `source.kind === 'user'` 区分真人输入 | `user-prompt-submit` |
| `assistant/message` | `{turn, step, message, usage?}` | — （只记下正文，给 `turn/end` 用） |
| `tool/call` | `{turn, step, callId, name, arguments}` | `pre-tool-use` |
| `tool/result` | `{turn, step, message, error?, meta?}` | `post-tool-use` / `post-tool-failure` |
| `turn/end` | `{turn, reason}` | `stop`（`reason.kind === 'error'` → `stop-failure`） |
| `session/end-seed` | — | `session-end` |
| `approval/*` | 审计事件 | — （我们自己就是答复器，不重复上报） |
| 其余 39 项 | — | 丢弃 |

**四个上一版猜错、且错了不会报错的地方**（全部安静地坏掉，所以列在这里）：

1. `tool/call` 的工具名字段叫 `name`，不是 `toolName`
2. `tool/call.arguments` 是**模型原样吐出的 JSON 字符串**，不是对象——要 parse，
   而且 parse 失败必须给 `null`（→ `args_known: false` → 判高危），不能给 `{}`
3. `tool/result` **不带工具名**，`callId` 也藏在 `message.content[0].toolCallId` 里，
   工具名只能拿 callId 回查参数表
4. `turn/end` 只有 `{turn, reason}`，**没有正文**；`turn/start` 只有 `{turn}`，
   **没有 prompt**。正文在 `assistant/message`，prompt 在 `user/message`

第 1、2 条错了的表现是手机上每张卡片都显示 `?` 和一串转义 JSON；
第 3、4 条错了的表现是「已完成」通知永远是空的。

### 4.1.1 已用真实事件流验证

跑了一次 headless 会话（`dsh --profile headless "..."`），43 条事件，
上表每一条都逐字段比对过，全部命中。会话日志在
`~/.dsh/sessions/<工作区>/<session-id>/session.jsonl.zstd`——**zstd 压缩，
而且是多帧拼接**（增量追加），Node 的 `zstdDecompressSync` 只解第一帧，
要用 `zstd -dc` 才能拿全。

顺带确认的两件事：

- 事件外层有 `{type, seq, time, data}` 包装，负载在 `data` 里
  （`session` 头事件例外，字段在顶层）
- `assistant/message.message.content` 的块类型是 `reasoning` / `tool-call` / `text`，
  我们只取 `text`——顺带把思维链挡在手机之外，这是想要的

### 4.1.2 工具名是小写，而且这曾经是个安全漏洞

DSH 的工具注册名全是小写下划线：`bash`、`read`、`write`、`edit`、
`read_image`、`web_fetch`、`web_search`、`job_*`。

clamicro 的风险判定原来写的是 `toolName === 'Bash'`，精确匹配 Claude Code
的名字。**接上 DSH 后整套 `HIGH_RISK_BASH` 一条都不会跑**——`rm -rf /`
判普通风险，10 秒自动放行。名字差一个字母，安全核心静默失效，不报任何错。

修法是两层，而且**不能只做翻译那层**：

1. **判据换成「参数里有没有 command」**（[`risk/assess.mjs`](../src/risk/assess.mjs)）。
   命令的形状由参数决定，跟后端和工具名无关。名字仍然认，但只作为第二道。
2. 桥接层再把 DSH 名字翻成 clamicro 词汇（`bash` → `Bash`…），
   那是为了让子状态推导和命令高亮这些**显示逻辑**生效。

只做第 2 层是不行的：安全不能建立在一张需要人工维护的映射表上，
漏一个名字就是一个洞。现在漏一个名字只是显示得糙一点。

上报走**现有的** `/hooks/<event>` 端点（[`src/routes/hooks.mjs:13`](../src/routes/hooks.mjs)），payload 里多带一个 `agent: 'dsh'`。不新开接口——统一上报格式这个决定就是为了这一天。

端点只认回环（`isLoopback`），DSH 插件同机跑正好符合，阶段内不需要碰认证。

### 4.2 callId 参数表

`ApprovalRequest` 不带参数，所以订阅端必须自己攒：

```ts
// callId -> { toolName, args, at }
const calls = new Map()
```

有界：容量上限 + TTL（建议 200 条 / 10 分钟），超了按插入序淘汰。这张表是纯内存的，插件重载即丢——丢了不影响正确性，只影响卡片信息量，见下条。

### 4.3 参数捞不到时必须显式标记

**这是本方案里最容易写出安全漏洞的一处。**

[`src/risk/assess.mjs`](../src/risk/assess.mjs) 是按 `tool_input` 打分的。如果 callId 没命中，传一个空 `{}` 过去，风险评估会算出「低风险」——而真实情况是「未知」。低风险卡片在手机上长得人畜无害，还可能落进自动通过的档位。

所以捞不到参数时，必须显式传一个「参数未知」标记，让风险评估**降级为未知**而不是低风险，卡片上也要写明。宁可让人多看一眼，不能让人误以为看过了。

### 4.4 上报不能阻塞

DSH 框架自己隔离了观察者异常（不会让 append 失败），但**没有替我们防阻塞**。插件跑在主进程内，`await` 一个正卡住的本地服务就是拖住 DSH 的事件循环。

状态上报一律 fire-and-forget，不 await，失败静默。这条跟 §2.1 那个必须 await 的审批答复器是两回事，别混。

---

## 5. 桥接插件：审批闭环（M2）

```ts
ctx.on('approval/request', async (req, next) => {
  if (!enabled) return next()

  const call = req.callId ? calls.get(req.callId) : null
  try {
    const decision = await postApproval({
      agent: 'dsh',
      session_id: sessionIdOf(req),
      tool_name: req.toolName,
      tool_input: call?.args ?? null,   // null = 未知，见 §4.3
      args_known: Boolean(call),
      reason: req.reason,
    }, { signal: req.signal, timeoutMs: config.timeoutMs })

    if (decision === 'allow') return 'allowed-once'
    if (decision === 'deny') return 'rejected'
    return next()
  } catch {
    return next()   // 服务不可达 / 超时 / 任何异常 → 交回人类
  }
})
```

服务端 [`/hooks/permission-request`](../src/routes/hooks.mjs) 现在返回的是 Claude Code 形状的 `hookSpecificOutput`。这里按 `payload.agent` 分支返回中性形状 `{ decision, reason }`，由插件映射成 `ApprovalOutcome`——不让 Claude Code 的词汇泄漏到 DSH 侧，也不让 DSH 的词汇污染现有响应。

超时值见 §7.1：默认 600 秒，是**兜底**不是策略——只防 HTTP 请求卡死，必须比 clamicro 自己的审批时限更长。**不要**直接套用 Claude Code 那边的 570s，那个数字是为 fail-open 语义定的，在这里没有依据。

`req.signal` 要透传给 fetch：请求被撤回时立刻放弃，对应 Claude Code 侧 `req.on('close')` → `abandon()` 那条路径。

### 5.1 实测澄清：审批的触发点是「沙箱升级」，不是「每次 bash」

在真实 DSH 0.1.0-rc.6 上跑过一次 headless 会话后（会话日志逐事件核对），确认：

- `approval/policy` 事件确实是 `ask`，`permission/preset` 是 `workspace-write`；
- 但 `tool/call` → `tool/result` 之间**没有** `approval/asked`——bash 直接执行了。

原因是 `dsh-tools` 的 `prepareExecution` 里 gate 来自
`ctx.waterfall("tools/pre-execute", …, () => ({kind:"allow"}))`，默认 fallback 是
**allow**。而「每次工具调用都 ask」的 responder 在 0.1.0-rc.6 里没被挂载——
`dsh-tool-bash` 里就一行 `TODO(permissions): deployment policy belongs in
tools/pre-execute`。真正调用 `ctx.approval.request()` 的是 `approveEscalation`
（`dsh-sandbox`，bash 请求 `sandbox_permissions: danger-full-access` 时）。

因此默认情况下（DSH 0.1.0-rc.6）本插件的「手机审批」只会审批**沙箱升级请求**
（`reason` 是 `escalate sandbox to <mode>: <justification>`），不是每一条 bash
命令。要还原 Claude Code 那种「每条命令都问」，两条路里选了第 2 条：

1. 等 DSH 补上 `tools/pre-execute` 的 ask gate（尚未发生）；或
2. **已实现**：由本插件自己注册一个 `tools/pre-execute` responder，对
   `askTools`（默认 `['bash']`）里的工具返回 `{kind:"ask"}`，把
   `approval/policy=ask` 真正接通——`approve: true` 即生效。参数直接从
   `exec.arguments` 取（不必依赖 mirror 的事件时序），并顺手塞进 callId 表。

---

## 6. 复用与不复用

复用（不改）：手机端审批卡片、滑动手势、倒计时、撤销窗口、通知链路、配对与令牌、时间线。

暂不提供（M0 里按能力关掉）：pause、cancel、发消息注入、5h / 7d 额度量表。

### 6.1 更正：cancel 和发消息在 DSH 上其实是可达的

上一版说这两件事「DSH 侧没有对应物」。**这是错的**，实测 `@deepseek-ai/dsh-agent@0.1.0-rc.6`：

```ts
interface Context { agents: AgentRegistry }        // 注册表
AgentRegistry.get(id: SessionId): Agent | undefined
AgentRegistry.list(): Agent[]

interface Agent {
  readonly id: SessionId                            // 与 session 共用同一个身份
  readonly session: Session
  cancel(cause, options?): void                     // ← 取消当前轮
  followup(message: UserMessage): void              // ← 排一条后续输入并唤醒
  send(message, target, wakeup): void               // ← 更细粒度的注入
}
```

也就是说：

- **cancel** 有一等公民 API，比 Claude Code 那个「在下一个工具调用前挂住」干净得多
- **发消息** 走 `followup()`，同样比 Claude Code 靠 Stop hook 返回 `decision:block`
  硬塞干净（[`hooks.mjs:146`](../src/routes/hooks.mjs) 的注释自称「唯一能往里发的口子」）
- **pause** 仍然没有直接原语——`whenIdle()` / `runMaintenance()` 都不是暂停

但能力矩阵里 `cancel` 和 `inbox` **仍然填 false**，因为矩阵描述的是
「clamicro 现在能不能做到」，不是「DSH 允不允许」。控制端点还没接，
现在填 true 就会在手机上出现一个点了没反应的按钮——那正是这套设计要避免的。

接上之后再改，这是一个明确的后续里程碑（M4），不是 DSH 的限制。

---

## 7. 审批能挂多久：已解决，无框架上限

上一版把这个列为「唯一需要实测的探针」。实际读 `0.1.0-rc.6` 的源码就能定论，
不需要做实验。**结论：框架不对审批等待设任何截止时间。**

推导链条，三步：

1. `dsh-tool-call-timeout-policy` 是**零配置**的，而且只对
   「自己在 `ToolDefinition` 上声明了 `timeoutMs`」的工具生效。
   README 原文：*A tool that declares no budget delegates untouched (no deadline).*
   目前声明了预算的只有 `web_fetch` / `web_search` 这类转发 signal 的工具。

2. 它注册的是 **`tools/execute`** 的 around-dispatch 监听器。

3. 而审批发生在 **`tools/pre-execute`** 阶段——`dsh-tools` 的 `prepareExecution()`
   跑完 `tools/pre-execute` waterfall，拿到 `kind: 'ask'` 的 gate 之后调
   `serviceAsk()` → `ctx.approval.request()`。**这一步在 `tools/execute` 之前**，
   timeout-policy 的计时器那时还没有装上。

所以能中断审批等待的只有两件事：

- **用户取消本轮** —— `approval.request` 收到的是 `exec.signal`（调用方自己的
  signal），取消会让 outcome 变成 `'cancelled'`
- **我们自己的超时**

`dsh-approval-llm` 用 60 秒是它自己的产品选择（审查模型本来就该很快），
不是框架逼的。

### 7.1 因此 timeoutMs 怎么定

桥接侧的 `timeoutMs` **不应该比 clamicro 自己的审批时限更短**。

clamicro 那边本来就会自己结算：普通操作到点自动通过（`autoApproveMs`），
高危到点自动拒绝（`SELF_TIMEOUT_MS`，570 秒）。桥接侧的超时如果更短，
就会在用户还盯着卡片读命令的时候把请求掐掉——而 clamicro 那条审批还挂着，
两边状态从此对不上。

所以它的角色是**兜底**，不是策略：默认取 600 秒，只用来防 HTTP 请求本身卡死。
真正决定「等多久」的是 clamicro 的审批配置，那是用户能在手机上改的。

---

## 8. 明确不做

- 不为 DSH 做独立 UI。手机端界面、审批卡片、交互全部复用现有设计，差异只体现为能力开关。
- 不做 DSH 的只读监控产品。DSH 自带 Web UI，社区已有 `dsh-mobile-gate` 等四个 LAN 方案，重复造轮子。事件订阅只作为审批功能的供料存在。
- 不做预授权 / 「允许并记住」。DSH 只有 `allowed-once`，记忆属于 `permission-presets` 另一条 seam。
- 手机端答选择题暂不接 DSH。DSH 有专门的 `user-questions`（provider-neutral human question/answer seam）和 `tool-ask-user`，比 Claude Code 那个 Stop hook hack 干净，值得单独立项做，但不塞进本方案。可参考 `dsh-ask-guard` 对超时未答的处理。
- 不引入云端 / 远程推送。全程本地回环 + 局域网，与现有架构一致。
- 不追 DSH 版本，也**不靠版本号判断兼容性**。见 §10。

---

## 9. 里程碑

| | 内容 | 依赖 DSH | 可独立发布 |
|---|---|---|---|
| M0 | clamicro 多后端改造：`agent` 字段、能力矩阵、UI 按能力渲染 | 否 | 是 |
| M1 | 桥接插件：`session/event` 订阅、事件映射、callId 参数表、状态上报 | 是 | 否 |
| M2 | `approval/request` 答复器、服务端中性响应、手机审批闭环 | 是 | 是 ✅ **真实会话跑通** |
| ~~M3~~ | ~~guard 探针，超时定档~~ | — | 已由 §7 读源码解决，无需实测 |
| M4 | DSH 侧的 cancel / 发消息（`ctx.agents.get(id)` → `cancel()` / `followup()`），能力矩阵随之开 | 是 | 是 |

M0 先做：它是「UI 支持多模型」这个需求本身，且不被 DSH 的任何不确定性挡住。

### 9.1 M2 闭环实测（真实会话 `session-66507b96…`）

| 环节 | 结果 |
|---|---|
| 工具名翻译 | `bash` → `Bash` ✓ |
| callId 参数回查 | 命中，`args_known: true` ✓ |
| 风险判定 | `high · 递归/强制删除` ✓ |
| 决定回传 | `denied · decided_by: phone` ✓ |

**这次实测顺带证明了 §4.1.2 那个修复是必要的**：在把风险判据从
「工具名是不是 `Bash`」改成「参数里有没有 `command`」之前，这条真实的
`rm -rf` 会因为 DSH 的工具名是小写 `bash` 而**整套高危规则一条都不跑**，
判 normal → 10 秒自动通过。名字差一个字母，安全核心静默失效——
而这次是在真实链路上验证了它现在拦得住。

---

## 10. DSH 升级了怎么办

**判据是字段形状，不是版本号。**

版本号变了不一定影响我们——46 个事件类型只用 7 个，绝大多数改动无关。
反过来，真正会伤到我们的是字段改名，那完全可能发生在一个 patch 版本里。

所以插件在运行时做两件强度不同的事（[`lib/compat.js`](../plugins/dsh-bridge/lib/compat.js)）：

| 信号 | 强度 | 含义 |
|---|---|---|
| 版本号与 `TESTED_DSH` 不同 | 提示一句 | 该回归一遍了，**不代表坏了** |
| 事件形状对不上 | 高声警告，每类事件一次 | **现在就已经在错译了** |

为什么形状检查是必需的：这个插件所有的翻译错误都是**安静**的。
`tool/call.name` 改个名，我们读到 `undefined`，手机上每张卡片显示 `?`，
没有任何一处会抛异常。`arguments` 从字符串改成对象，所有审批变成
「参数未知」的高危——安全，但每条都要手点，而人只会觉得这东西变傻了。
这类故障不会自己浮出来，只能主动查。

形状对不上时**仍然照常翻译**，只是喊一声：DSH 加字段是最常见的无害变更，
为一次可能的误判让整个会话从手机上消失，比残缺显示更糟——后者至少还有线索。

### 升级后的动作

1. `npm test`（`test/dsh-bridge.test.mjs` 钉着所有字段假设）
2. 起一次真实会话，看日志里有没有形状警告
3. 有警告 → 对照 §4.1 重新核对字段名，改 `lib/map.js`，补测试
4. 没警告 → 把 `lib/compat.js` 的 `TESTED_DSH` 和 `package.json` 的
   `clamicro.testedAgainstDsh` 一起改成新版本号

没有形状警告就不必动。
