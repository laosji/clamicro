import { EventEmitter } from 'node:events'
import { noRedact } from './redact.mjs'
import { plainText } from './text.mjs'
import { DEFAULT_AGENT, normalizeAgent } from './agents.mjs'

// 状态机（对应计划 §3）
export const STATE = {
  IDLE: 'Idle',
  RUNNING: 'Running',
  WAITING_APPROVAL: 'Waiting Approval',
  /**
   * agent 停下来了，**在终端里等你打字**。
   *
   * 从 Idle 里拆出来的。原来两者共用一档，而它们对用户的意思相反：
   * Idle 是「会话开着，没事发生」——不用管；Waiting Input 是「它卡住了，
   * 在等你」——你不去终端它就一直不动。合在一起的后果是手机上看不出
   * 「要不要现在起身」，而那恰恰是这个产品唯一想回答的问题。
   *
   * 只有 Claude Code 产生这一档（notification 的 idle_prompt）。别的后端
   * 没有对应事件，它们的会话永远不会进这一档——这不是缺陷，是那条链路
   * 确实没有这个信息，见 docs/architecture.zh-CN.md §3。
   *
   * 不进 sweepStale：那个扫的是「说在跑却半天没动静」，而这一档是**如实
   * 地不动**，标成陈旧等于把一个准确的状态说成可疑的。
   */
  WAITING_INPUT: 'Waiting Input',
  PAUSED: 'Paused',
  DONE: 'Done',
  ERROR: 'Error',
}

/**
 * 这次调用是不是在用一个 skill。
 *
 * **大小写不敏感**，理由是 assess.mjs 用血换来的那条：接 DSH 时实测它的工具
 * 叫 `bash`（小写），于是整套按 `=== 'Bash'` 写的规则一条都没跑，而且不报错。
 * 名字差一个字母就整条链路静默失效，这里不重蹈。
 *
 * 判据只认名字、不认参数形状：`summarizeInput` 那边认 `input.skill` 是**第二道**
 * ——万一哪天来了个我们不认得的名字但带着 skill 参数，时间线至少还写得出
 * 「用了哪个」，不会退回一个空冒号。两道门是故意的。
 */
const isSkill = (toolName) => String(toolName ?? '').toLowerCase() === 'skill'

// Claude Code 没有子状态事件，只能从 tool_name 推导（计划 §3）
function subStateForTool(toolName, toolInput) {
  if (!toolName) return 'Working'
  if (/^(Read|Grep|Glob|WebSearch|WebFetch|NotebookRead)$/.test(toolName)) return 'Searching'
  if (/^(Edit|Write|NotebookEdit)$/.test(toolName)) return 'Editing'
  if (toolName === 'Task' || toolName === 'Agent') return 'Delegating'
  // 和 'Calling MCP' 并列：两者都是「去用一个我们自己不知道内容的东西」。
  // 落到 'Working' 的话，手机上一个 skill 调用和一次普通工具调用长得一样
  if (isSkill(toolName)) return 'Using Skill'
  if (toolName === 'Bash') {
    const cmd = toolInput?.command ?? ''
    if (/\b(test|pytest|jest|vitest|go test|cargo test|npm t|npm run test)\b/.test(cmd)) {
      return 'Running Test'
    }
    return 'Running Command'
  }
  if (toolName.startsWith('mcp__')) return 'Calling MCP'
  return 'Working'
}

/**
 * 完成之后**接着播**的那条额度提示。
 *
 * 不并进「已完成」里：完成是一个状态，额度是另一条信息，挤在一行会让
 * 两个都变得不好扫。分成前后两条，各自只说一件事——反正 HUD 队列本来
 * 就是串行的，第二条会自动等第一条播完。
 *
 * 字段叫 pct 不叫 used_percentage —— applyStatusLine 存进来时就改过名了。
 * 第一版照着 hook 的原始载荷写，读出来永远 undefined，表现是「额度明明有，
 * 胶囊上就是不显示」，而且不报错。测试抓到的。
 *
 * 拿不到额度就返回 null，不播第二条——空闲状态不该因为额度缺失而弹一条
 * 「额度 NaN%」。
 */
function quotaFollowUp(limits) {
  const pct = limits?.five_hour?.pct
  if (!Number.isFinite(pct)) return null
  return {
    icon: '◔',
    short: `${Math.round(pct)}%`,
    // 只有真的接近上限才用警告色，平时是中性的——天天见红会让人对红色脱敏
    tint: pct >= 90 ? 'warn' : 'info',
    // 比主状态短：它是补充信息，不该占同样长的时间
    ms: 1600,
  }
}

function truncate(s, n) {
  if (typeof s !== 'string') return ''
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

export class Store extends EventEmitter {
  #sessions = new Map()
  #events = []
  #nextEventId = 1
  #maxEvents = 2000
  #redact = noRedact

  /**
   * 注入凭证抹除器。
   *
   * 事件明细存的是 Claude 的回复原文，里面可能带着本服务自己的登录地址
   * （查询参数 t= 后面就是主令牌）。那些事件会落盘，并通过 /api/stream
   * 发给已配对的手机——而手机只该拿到自己的设备令牌，主令牌是 forget
   * 吊销不掉、还能签发新设备的那一个。不抹等于把它送出去。
   *
   * 见 src/redact.mjs。不注入就不抹（测试默认）。
   */
  setRedactor(fn) {
    this.#redact = typeof fn === 'function' ? fn : noRedact
    return this
  }

  session(id) {
    if (!id) return null
    let s = this.#sessions.get(id)
    if (!s) {
      s = {
        session_id: id,
        // 哪个后端在跑这个会话。决定手机端给不给暂停/取消/发消息的入口，
        // 见 src/agents.mjs。老 hook 不带这个字段，缺省即 Claude Code。
        agent: DEFAULT_AGENT,
        session_name: null,
        cwd: null,
        state: STATE.IDLE,
        sub_state: null,
        turn_started_at: null,
        last_message: null,
        updated_at: Date.now(),
        /**
         * 这个会话上**还挂着几条**待审批。
         *
         * 必须是集合而不是单个 id：Claude Code 会并行发起工具调用，于是同一个
         * 会话同时挂着两条 PermissionRequest 是常态。原来只有一个
         * pending_approval_id，第二条进来就把第一条覆盖掉；而
         * clearWaitingApproval 只认 session_id、不认是哪一条结束了，
         * 于是**批准其中一条，整个会话就翻回「运行中」**——而 Claude Code
         * 事实上还冻在第二条上。实测复现过。
         *
         * 界面说在跑、实际卡着，是这个产品唯一不能破的那条规矩的反面。
         */
        pending_approvals: [],
        /** 从什么时候开始就没动静了（sweepStale 写）。null = 不陈旧 */
        stale_since: null,
        limits: null,
        context: null,
        cost_usd: null,
        // 累计 token。只有按 API key 计费、没有窗口配额的后端会有（quota:'tokens'）。
        // 不换算成金额：那要一张会悄悄过期的价目表，而一个不准的金额比没有更糟
        /**
         * 起这个会话的那个进程。session-start 时由 hook 带上来（`?owner=`）。
         *
         * 形状因后端而异，用之前必须知道：Claude Code 是**一个会话一个进程**，
         * 而 Codex 的 app-server、DSH 的主进程都是**所有会话共用的常驻进程**。
         * 所以它只够回答「这个后端还开着吗」，**不够**回答「这个会话还活着吗」
         * ——后者仍归 sweepStale。拿它去收会话会把 Codex 的会话全判错。
         */
        owner_pid: null,
        tokens: null,
        // 后端有没有上报过用量。null=还没轮完不知道；true=上报过；false=报过
        // 但适配器不报用量。用它把「没报用量」和「0 token」区分开（见 agentUsage）。
        usage_reported: null,
        model: null,
      }
      this.#sessions.set(id, s)
    }
    return s
  }

  sessions() {
    return [...this.#sessions.values()].sort((a, b) => b.updated_at - a.updated_at)
  }

  accountLimits() {
    return this.#accountLimits
  }

  statusLineSeenAt() {
    return this.#statusLineSeenAt
  }

  /**
   * 每个后端最后一次上报是什么时候。
   *
   * ## 为什么需要它
   *
   * 「这个后端没有会话」和「这个后端已经不上报了」在屏幕上长得一模一样：
   * 两种情况列表里都是空的。可它们该做的事完全相反——前者什么都不用做，
   * 后者说明桥接插件挂了 / hooks 掉了 / DSH 进程没了，而你正靠它替你盯着操作。
   *
   * 这是这个项目反复踩的同一类坑（hooks 静默失败、statusLine 不上报、
   * 服务连不上却只显示空白）：**故障被显示成「正常但没有内容」**。
   * 有了时间戳，界面才说得出「Claude Code 12 分钟没动静了」。
   *
   * 记的是「收到过任何上报」，不是「有活跃会话」——会话结束了后端仍然活着，
   * 这两件事必须分开。
   */
  /**
   * 每个后端自己的窗口配额。
   *
   * **为什么不并进 #accountLimits**：那个字段的形状是写死的
   * `{five_hour, seven_day}`，是 Claude Code 的 statusLine 直接映过来的，
   * 全仓库 33 处引用都建立在这两个名字上。而 Codex 是**单个 30 天窗口**
   * （window_minutes: 43200），别的后端将来还可能是别的档位——把它们塞进
   * 那两个名字里就得撒谎（把 30 天叫成 seven_day），换掉那两个名字则要动
   * 状态栏渲染、CLI status、UI 和三个测试文件。
   *
   * 所以另开一张表：键是后端名，值是**一组**窗口，每个窗口自带 key/label。
   * Claude Code 那条路一个字节都不动，新后端各说各的。
   */
  /**
   * 见过的宿主进程：pid -> 最后一次见到的时间。
   *
   * **记在会话之外，而且会话结束了也不删。** 这正是它和 `session.owner_pid`
   * 的区别，也是「所有应用退出后关服务」这个要求的字面意思：
   * Claude Code 开着但当前没有会话时，服务不该走——它的进程还在。
   * 只看当前会话的话，一个正常结束的会话就会让服务在十分钟后退出，
   * 而那时应用还开着，用户下次开会话又得等它重新拉起。
   *
   * pid 复用的风险是知道的：一个死掉的 pid 理论上会被无关进程占回去，
   * 于是我们误以为某个后端还活着。失败方向是**多跑一会儿**，而不是提前
   * 关掉——那是这里唯一能接受的方向。
   */
  /**
   * 记下一个宿主 pid。两个来源：SessionStart（一个会话一次）和 statusLine
   * （每回合），后者是重启后重新认识宿主的那条路，见 bin/statusline.sh。
   *
   * 单独一个方法而不是让两处各自 `#owners.set`：那张表的语义（不随会话结束
   * 而清空）只写在 owners() 上面，多一个写入点就多一次抄错的机会。
   */
  noteOwner(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    this.#owners.set(pid, Date.now())
    return true
  }

  owners() {
    return [...this.#owners].map(([pid, at]) => ({ pid, at }))
  }

  agentLimits() {
    return Object.fromEntries(this.#agentLimits)
  }

  agentsSeen() {
    return Object.fromEntries(this.#agentSeen)
  }

  /**
   * 每个后端**第一次**上报的时间，给首页分区定顺序用。
   *
   * 单独一个方法而不是把 agentsSeen 的值改成 {first,last}：那样会让
   * 缓存着旧页面的手机把对象当时间戳减，算出 NaN → 永远显示「没有上报」。
   * 加字段是安全的，改字段的形状不是。
   */
  agentsFirstSeen() {
    return Object.fromEntries(this.#agentFirstSeen)
  }

  events(sinceId = 0, sessionId = null) {
    return this.#events.filter(
      (e) => e.id > sinceId && (!sessionId || e.session_id === sessionId),
    )
  }

  /** 落盘用 */
  allEvents() {
    return this.#events
  }

  restoreLimits(limits) {
    if (limits?.five_hour) {
      this.#accountLimits = limits
      /**
       * statusLineSeenAt 没单独落盘，但「有额度数据」这件事本身就说明
       * statusLine 来过。用 limits.at（最后一次带额度的上报时间）恢复，
       * 否则重启后 statusLineSeenAt 是 null，前端 quotaWhy() 会误判成
       * 「statusLine 一次都没来过」（hooks-only），把「旧数据」说成「不调用」。
       */
      if (limits.at) this.#statusLineSeenAt = limits.at
    }
  }
  get nextEventId() {
    return this.#nextEventId
  }

  restoreEvents(events, nextId) {
    if (Array.isArray(events) && events.length) {
      // 从盘上读回来的事件也要过一遍抹除，两个理由：
      //   · 这条路径绕过 #log，不在这里抹就是个漏洞
      //   · 升级到带抹除的版本时，顺手把**已经写进 history.json 的**旧凭证
      //     清掉——否则老用户的历史里那把钥匙会一直躺着，直到被 3000 条上限挤掉
      this.#events = events
        .slice(-this.#maxEvents)
        .map((e) => (typeof e?.detail === 'string' ? { ...e, detail: this.#redact(e.detail) } : e))
      this.#nextEventId = Math.max(Number(nextId) || 1, ...this.#events.map((e) => e.id + 1))
    }
  }

  #log(sessionId, type, detail) {
    // 事件的唯一入口，抹除放这里就没有漏网的路径
    const event = {
      id: this.#nextEventId++,
      session_id: sessionId,
      ts: Date.now(),
      type,
      detail: this.#redact(detail),
    }
    this.#events.push(event)
    if (this.#events.length > this.#maxEvents) this.#events.splice(0, this.#events.length - this.#maxEvents)
    this.emit('event', event)
    return event
  }

  #touch(s, patch) {
    // last_message 和事件明细是同一个来源（助手回复原文），一样要抹
    if (typeof patch.last_message === 'string') {
      /**
       * 在**源头**清洗，不是在某一个消费端。
       *
       * 原来 markdown 只在 notify 那一层剥（plainText），于是网页看板拿到的
       * 还是原文：首页「已完成」卡片上直接显示出 `**粗体**` 和 `## 标题`，
       * 看着就是个半成品。同一个 bug 的第二处——只在一处修，下一个消费端
       * 出现时还会再犯一次。
       *
       * 顺序：先剥 markdown 再抹凭证。反过来的话，`***` 被抹成的 `***`
       * 可能被斜体规则再吃掉一层。
       */
      patch = { ...patch, last_message: this.#redact(plainText(patch.last_message)) }
    }
    Object.assign(s, patch, { updated_at: Date.now() })
    this.emit('session', s)
  }

  /**
   * 处理一个 hook 事件。返回 { body, notify }：
   *   body   —— 回给 Claude Code 的 hook 输出（M0 一律 {}，M1 起审批会返回决策）
   *   notify —— 需要推送时的 {title, body, url, level}，否则 null
   */
  applyHook(eventName, payload, notifyConfig) {
    const id = payload.session_id
    if (!id) return { body: {}, notify: null }
    const s = this.session(id)

    if (payload.cwd) s.cwd = payload.cwd
    if (payload.session_name) s.session_name = payload.session_name
    // 认不得的 agent 落回 Claude Code 而不是原样存下：存下来的话，UI 那边
    // capOf() 同样会落回默认能力，但会话卡片上会显示一个谁也不认识的后端名。
    if (payload.agent) s.agent = normalizeAgent(payload.agent)
    // 记在会话之外：会话结束了后端仍然活着，两件事分开看才判得出「后端没动静了」
    this.#agentSeen.set(s.agent, Date.now())
    if (!this.#agentFirstSeen.has(s.agent)) this.#agentFirstSeen.set(s.agent, Date.now())

    const label = s.session_name || (s.cwd ? s.cwd.split('/').filter(Boolean).pop() : id.slice(0, 8))
    let notify = null

    switch (eventName) {
      case 'session-start':
        // 宿主进程。见 src/lifecycle.mjs —— 全部宿主都没了服务就自己退出。
        // 同时记进 #owners：那张表不随会话结束而清空，见 owners()
        if (this.noteOwner(payload.owner_pid)) s.owner_pid = payload.owner_pid
        this.#touch(s, { state: STATE.IDLE, sub_state: null })
        this.#log(id, 'session-start', payload.source ?? 'startup')
        break

      case 'user-prompt-submit':
        this.#touch(s, { state: STATE.RUNNING, sub_state: 'Thinking', turn_started_at: Date.now() })
        this.#log(id, 'prompt', truncate(payload.prompt ?? '', 200))
        break

      case 'pre-tool-use':
        this.#touch(s, {
          state: s.state === STATE.PAUSED ? STATE.PAUSED : STATE.RUNNING,
          sub_state: subStateForTool(payload.tool_name, payload.tool_input),
        })
        /**
         * skill 调用**单独一个事件类型**，不混在 tool 里。
         *
         * 时间线上它本来长这样：`工具 / Skill: poster`——工具名占掉了那行的
         * 主位，而「Skill」这个词对人零信息量。现在是 `使用 skill / poster`，
         * 一眼就是那个名字。
         *
         * 更要紧的是 detail **只放名字**，不放 `Skill: ` 这种复合串。会话页
         * 的「用过哪些 skill」直接按 `type === 'skill'` 筛、拿 detail 去重，
         * 不用去解析一个给人看的展示字符串——那种解析一旦上游改了措辞就静默
         * 对不上账，而这个仓库在 match_key 那里已经为同一类耦合写过一整段
         * 警告了。
         *
         * 老数据（history.json 里 type 是 tool 的那些）不会被这个列表认到。
         * 这是可接受的：那份列表说的是「这个会话用过什么」，少几条旧的比
         * 为了兼容去解析展示串划算。
         */
        if (isSkill(payload.tool_name)) {
          const name = String(payload.tool_input?.skill ?? '').trim()
          this.#log(id, 'skill', truncate(name || '未具名 skill', 80))
        } else {
          this.#log(id, 'tool', `${payload.tool_name}: ${truncate(summarizeInput(payload.tool_input), 160)}`)
        }
        break

      case 'post-tool-use':
        // 上一个 PostToolUse 到下一个 PreToolUse 之间视为 Thinking（计划 §3）
        this.#touch(s, { sub_state: 'Thinking' })
        break

      case 'post-tool-failure':
        this.#log(id, 'tool-error', `${payload.tool_name} 失败`)
        this.#touch(s, { sub_state: 'Thinking' })
        break

      case 'notification': {
        const kind = payload.notification_type
        if (kind === 'permission_prompt') {
          // M1 之前只做感知，不拦截；真正的阻塞审批走 PermissionRequest
          this.#touch(s, { state: STATE.WAITING_APPROVAL })
          this.#log(id, 'permission-prompt', truncate(payload.message ?? '', 200))
        } else if (kind === 'idle_prompt') {
          // 不是 IDLE：那一档的意思是「没事发生」，而这里是「它在等你打字」。
          // 见 STATE.WAITING_INPUT 上面那段
          this.#touch(s, { state: STATE.WAITING_INPUT, sub_state: null })
          this.#log(id, 'idle', truncate(payload.message ?? '', 200))
        } else {
          this.#log(id, 'notification', `${kind}: ${truncate(payload.message ?? '', 160)}`)
        }
        break
      }

      /**
       * 回合开始 / 结束。**只有 Codex 走这两条**，而且不经过 HTTP。
       *
       * Codex 没有回合级的结束事件（0.149 的十个 hook 事件里没有 stop），
       * 所以它的会话靠跟读 rollout JSONL 补回来，见 src/codex-tail.mjs。
       * 这两个名字**故意不在 HOOK_EVENTS 里**——它们进不了 /hooks/* 路由，
       * 局域网上伪造不出来，唯一的来源是本机 ~/.codex 下那份文件。
       */
      case 'turn-start':
        this.#touch(s, { state: STATE.RUNNING, sub_state: 'Thinking', turn_started_at: Date.now() })
        break

      /**
       * 用量。同样只有 Codex 走，同样不经过 HTTP（见 codex-tail.mjs）。
       *
       * 单独一个事件而不是搭在 turn-end 上：Codex 的 token_count 是独立
       * 落盘的，时机跟 task_complete 不绑定。搭在一起等于要等回合结束才
       * 更新，而失败的回合可能根本走不到那一步。
       */
      case 'turn-usage': {
        const n = Number(payload.tokens)
        const patch = {}
        if (Number.isFinite(n) && n > 0) patch.tokens = n
        if (typeof payload.usage_reported === 'boolean') patch.usage_reported = payload.usage_reported
        if (Object.keys(patch).length) this.#touch(s, patch)
        /**
         * 窗口配额是**账户级**的，不属于某一个会话，所以记在 #agentLimits
         * 上而不是会话上（同 #accountLimits 的道理）。
         *
         * 空数组也要当作「没有」：写进去会让界面画出一组零个格子的容器，
         * 那比不画更难解释。
         */
        if (Array.isArray(payload.windows) && payload.windows.length) {
          this.#agentLimits.set(s.agent, { windows: payload.windows, at: Date.now() })
        }
        break
      }

      case 'turn-end': {
        /**
         * 失败和成功必须分开。
         *
         * task_complete 带 error 时（额度耗尽、模型报错…）这个回合**什么都
         * 没干成**，报「已完成」等于撒谎。ERROR 是状态机里本来就有的一档，
         * 两个前端也都渲染成「出错」，所以这里不需要动界面。
         */
        if (payload.error) {
          /**
           * 报错原文要写进 last_message，不能只记时间线。
           *
           * 首页的出错卡片渲染的就是这个字段，为空时回落到一句通用的
           * 「会话异常终止」（见 ui/home.html）。而我们手里明明有那句真话
           * ——「You've hit your usage limit…」带着重置时间。只记时间线的话，
           * 用户在卡片上看到的永远是同一句正确但没用的话，连续几个回合失败
           * 看起来就像状态卡住了没动。
           */
          const why = truncate(String(payload.error), 300)
          this.#touch(s, { state: STATE.ERROR, sub_state: null, turn_started_at: null, last_message: why })
          this.#log(id, 'turn-error', why)
          break
        }
        // 成功就跟 Claude Code 的 Stop 走同一条路——包括那条「跑完了」的通知。
        // 复用而不是另写一份：两个后端的「回合结束」对用户是同一件事。
        return this.applyHook('stop', payload, notifyConfig)
      }

      case 'stop': {
        // turn_started_at 为空 = 服务在会话中途才启动，时长未知。
        // 此时宁可多推一次，也别漏掉一次任务完成。
        const elapsed = s.turn_started_at ? Date.now() - s.turn_started_at : Infinity
        const msg = truncate(payload.last_assistant_message ?? '', 300)
        // 按 API key 计费的后端没有滚动窗口配额，累计 token 是唯一说得出口的
        // 用量。只在真的报了的时候才写——没有和 0 是两回事
        const tokens = Number(payload.tokens)
        this.#touch(s, {
          state: STATE.DONE, sub_state: null, last_message: msg, turn_started_at: null,
          ...(Number.isFinite(tokens) && tokens > 0 ? { tokens } : {}),
          ...(typeof payload.usage_reported === 'boolean' ? { usage_reported: payload.usage_reported } : {}),
        })
        this.#log(id, 'stop', msg)
        if (notifyConfig.onStop && elapsed >= notifyConfig.minTurnMs) {
          notify = {
            title: 'Clamicro',
            icon: '✓',
            /**
             * 完成是**状态**：横向一条只说状态本身。
             *
             * 项目名不放这儿——横向态是给余光扫的，「已完成」三个字就够；
             * 想知道是哪个项目，纵向通知和手机看板里都有。
             *
             * 但额度要带上：任务刚跑完正是你会抬头看一眼的时刻，也正是
             * 「还能不能再来一轮」这个问题最有意义的时刻。平时它藏在
             * statusLine 和手机看板里，得专门去看。
             */
            compact: true,
            short: '已完成',
            tint: 'ok',
            // 播完「已完成」再接一条额度。见 quotaFollowUp。
            after: quotaFollowUp(this.#accountLimits),
            subtitle: `${label} 已完成`,
            body: msg || `耗时 ${Math.round(elapsed / 1000)}s`,
            level: 'active',
            group: 'clamicro',
          }
        }
        break
      }

      case 'stop-failure': {
        const msg = truncate(payload.error ?? payload.last_assistant_message ?? '任务因 API 错误终止', 300)
        const tokens = Number(payload.tokens)
        this.#touch(s, {
          state: STATE.ERROR, sub_state: null, last_message: msg, turn_started_at: null,
          ...(Number.isFinite(tokens) && tokens > 0 ? { tokens } : {}),
          ...(typeof payload.usage_reported === 'boolean' ? { usage_reported: payload.usage_reported } : {}),
        })
        this.#log(id, 'error', msg)
        if (notifyConfig.onError) {
          notify = { title: 'Clamicro', icon: '✕', tint: 'danger', subtitle: `${label} 出错`, body: msg }
        }
        break
      }

      case 'session-end':
        this.#log(id, 'session-end', payload.reason ?? '')
        this.#sessions.delete(id)
        this.emit('session', { session_id: id, removed: true })
        break
    }

    return { body: {}, notify }
  }

  /** 记录控制动作，并把会话状态切到 Paused/Running */
  noteControl(sessionId, action) {
    if (!sessionId) return
    const s = this.session(sessionId)
    const label = { pause: '已请求暂停', resume: '已恢复', cancel: '已请求取消',
                    cancelled: '已取消本轮', resumed: '已恢复' }[action] ?? action
    this.#log(sessionId, 'control', label)
    if (action === 'pause') this.#touch(s, { state: STATE.PAUSED })
    else if (action === 'resume' || action === 'resumed') {
      if (s.state === STATE.PAUSED) this.#touch(s, { state: STATE.RUNNING, sub_state: 'Thinking' })
    } else if (action === 'cancelled') {
      this.#touch(s, { state: STATE.IDLE, sub_state: null })
    }
  }

  /** 手机消息注入成功，记进时间线 */
  noteInbox(sessionId, pending) {
    if (!sessionId) return
    this.#log(sessionId, 'inbox', truncate(pending.text, 300))
    const s = this.session(sessionId)
    // 注入等于这一轮没停，继续跑
    this.#touch(s, { state: STATE.RUNNING, sub_state: 'Thinking', turn_started_at: Date.now() })
  }

  markWaitingApproval(sessionId, approval) {
    if (!sessionId) return
    const s = this.session(sessionId)
    if (approval.cwd) s.cwd = approval.cwd
    s.pending_approvals ??= []
    if (!s.pending_approvals.includes(approval.id)) s.pending_approvals.push(approval.id)
    // pending_approval_id 保留，指向**最早**那条：它是「这个会话此刻卡在哪」
    // 最该给出的答案。原来指向最新那条，两条并行时第一条就没了入口。
    this.#touch(s, {
      state: STATE.WAITING_APPROVAL,
      sub_state: null,
      pending_approval_id: s.pending_approvals[0],
    })
    this.#log(sessionId, 'approval-requested', `${approval.tool_name}: ${truncate(approval.summary, 160)}`)
  }

  /**
   * 某一条审批结束了。
   *
   * **必须传 approvalId。** 不传等于「把这个会话上的都清掉」——那是老行为，
   * 留着只为兼容还没改的调用方，新代码一律传。少了这个参数就没法知道
   * 「是不是还有别的挂着」，而那正是这个方法出过的 bug。
   */
  clearWaitingApproval(sessionId, approvalId) {
    if (!sessionId) return
    const s = this.session(sessionId)
    s.pending_approvals = approvalId === undefined
      ? []
      : (s.pending_approvals ?? []).filter((id) => id !== approvalId)

    // 还有别的挂着 → 状态**不能**翻回 Running，只把指针挪到下一条
    if (s.pending_approvals.length) {
      this.#touch(s, { pending_approval_id: s.pending_approvals[0] })
      return
    }
    if (s.state === STATE.WAITING_APPROVAL) {
      this.#touch(s, { state: STATE.RUNNING, sub_state: 'Thinking', pending_approval_id: null })
    } else {
      this.#touch(s, { pending_approval_id: null })
    }
  }

  /**
   * 把「很久没动静」的会话标出来。**只陈述观察，不改状态。**
   *
   * 会话只在 session-end 时才从表里消失，而 kill -9、直接关终端窗口、
   * 进程崩溃都不会有那个事件。于是一个在工具调用中途被杀掉的会话会
   * **永远停在「运行中」**：最后一个事件是 pre-tool-use，之后什么都不会来，
   * 也没有任何巡检会碰它（5 分钟那个扫的是审批、history、hooks、日志）。
   *
   * 为什么不直接标成 Error 或者删掉：**沉默不等于死了**。一条跑二十分钟的
   * 测试命令，从 pre-tool-use 到 post-tool-use 之间同样一声不响。把它判成
   * 出错是编一个我们并不知道的结论，而这跟「永远运行中」是同一类错误，
   * 只是方向相反。
   *
   * 所以只记「多久没动静」，让界面照实说。真死了的和真在跑的，用户自己
   * 一眼能分辨——他知道自己有没有在跑长命令，我们不知道。
   */
  sweepStale(maxIdleMs) {
    const now = Date.now()
    let marked = 0
    for (const s of this.#sessions.values()) {
      if (s.state !== STATE.RUNNING && s.state !== STATE.WAITING_APPROVAL) continue
      const idle = now - s.updated_at
      const stale = idle > maxIdleMs
      if (stale === Boolean(s.stale_since)) continue
      // #touch 会改 updated_at，那正是这里不能用它的原因——一改就再也判不出陈旧
      s.stale_since = stale ? s.updated_at : null
      this.emit('session', s)
      if (stale) marked++
    }
    return marked
  }

  /**
   * 额度预警。按 resets_at 记住已提醒过的窗口——
   * 同一个 5 小时窗口只响一次，窗口一换（resets_at 变了）才允许再响。
   */
  #warnedWindow = null
  // 额度是账号级的，不是会话级的。按会话存会出现「某个旧会话的陈旧数字
  // 把最新数字顶掉」，首页显示的就不是真实用量了。只认最新一次观测。
  #accountLimits = null

  // agent -> { windows: [{key, label, pct, resets_at}], at }。见 agentLimits()
  #agentLimits = new Map()

  // 宿主 pid -> 最后一次见到的时间。见 owners()
  #owners = new Map()
  // statusLine 是会话启动时读一次的。装 clamicro 之前就开着的会话永远不会调它，
  // 表现是额度一直空白且毫无错误。记一笔「有没有被调用过」，好把
  // 「还没有会话上报」和「有会话但额度拿不到」区分开。
  #statusLineSeenAt = null
  // agent -> 最后一次收到该后端任何上报的时间。见 agentsSeen()
  #agentSeen = new Map()
  /**
   * agent -> **第一次**上报的时间。用来给首页的模型分区定顺序。
   *
   * 不能拿 sessions 的顺序排：那是按 updated_at 倒序的，谁活跃谁就窜到
   * 前面——卡片位置每来一个事件就换一次，人得重新找「我要看的那个模型
   * 在哪」。位置本身是一种记忆，不该被活跃度改写。
   *
   * 也不用 #agentSeen（最后一次上报）：那同样跟着活跃度变。
   *
   * 服务重启后重新计时，所以顺序是「本次运行里谁先连上」。这没问题——
   * 它仍然稳定，只是锚点是这次启动。
   */
  #agentFirstSeen = new Map()

  applyStatusLine(payload, opts = {}) {
    this.#statusLineSeenAt = Date.now()
    const id = payload.session_id
    if (!id) return
    const s = this.session(id)
    this.#touch(s, {
      session_name: payload.session_name ?? s.session_name,
      cwd: payload.workspace?.current_dir ?? s.cwd,
      model: payload.model?.display_name ?? s.model,
      cost_usd: payload.cost?.total_cost_usd ?? s.cost_usd,
      context: payload.context_window
        ? {
            used_pct: payload.context_window.used_percentage ?? 0,
            size: payload.context_window.context_window_size ?? null,
          }
        : s.context,
      limits: payload.rate_limits
        ? {
            five_hour: {
              pct: payload.rate_limits.five_hour?.used_percentage ?? 0,
              resets_at: payload.rate_limits.five_hour?.resets_at ?? null,
            },
            seven_day: {
              pct: payload.rate_limits.seven_day?.used_percentage ?? 0,
              resets_at: payload.rate_limits.seven_day?.resets_at ?? null,
            },
          }
        : s.limits,
    })

    if (payload.rate_limits) {
      this.#accountLimits = {
        five_hour: {
          pct: payload.rate_limits.five_hour?.used_percentage ?? 0,
          resets_at: payload.rate_limits.five_hour?.resets_at ?? null,
        },
        seven_day: {
          pct: payload.rate_limits.seven_day?.used_percentage ?? 0,
          resets_at: payload.rate_limits.seven_day?.resets_at ?? null,
        },
        at: Date.now(),
        from: id,
      }
    }

    const five = payload.rate_limits?.five_hour
    const threshold = Number(opts.quotaWarnPct ?? 0)
    if (threshold > 0 && five && Number(five.used_percentage) >= threshold) {
      const window = five.resets_at ?? 'unknown'
      if (this.#warnedWindow !== window) {
        this.#warnedWindow = window
        const mins = five.resets_at ? Math.max(0, Math.round((five.resets_at * 1000 - Date.now()) / 60000)) : null
        this.#log(id, 'quota-warn', `5 小时窗口已用 ${Math.round(five.used_percentage)}%`)
        return {
          // 标题固定是「谁」，事件放第二行——位置固定，眼睛不用找。
          // 图标单独给，别塞进标题文字：刘海胶囊有专门的图标位。
          title: 'Clamicro',
          icon: '⚡️',
          compact: true,
          short: `额度 ${Math.round(five.used_percentage)}%`,
          tint: 'warn',
          subtitle: `额度接近上限`,
          body: `5 小时窗口已用 ${Math.round(five.used_percentage)}%` +
            (mins !== null ? `，约 ${mins} 分钟后重置` : ''),
          level: 'timeSensitive',
          group: 'clamicro-quota',
        }
      }
    }
    return null
  }
}

/**
 * 时间线那一行冒号后面写什么。**纯粹是个字段挑选器**，不做判断。
 *
 * `input.skill` 是补进来的：Skill 的入参是 {skill, args}，上面这串一个都不沾，
 * 于是实测时间线里是一条 `Skill: `——冒号后面空的。手机上滚过去，你知道它
 * 调了个 skill，但不知道调的是哪个，而那正是唯一有信息量的那半句。
 *
 * 排在 description 前面：Skill 没有 description，但将来某个工具两样都有时，
 * 更具体的那个更该显示。
 */
function summarizeInput(input) {
  if (!input || typeof input !== 'object') return ''
  return input.command ?? input.file_path ?? input.pattern ?? input.url
    ?? input.skill ?? input.description ?? ''
}
