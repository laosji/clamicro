import { EventEmitter } from 'node:events'
import { noRedact } from './redact.mjs'
import { plainText } from './text.mjs'
import { DEFAULT_AGENT, normalizeAgent } from './agents.mjs'

// 状态机（对应计划 §3）
export const STATE = {
  IDLE: 'Idle',
  RUNNING: 'Running',
  WAITING_APPROVAL: 'Waiting Approval',
  PAUSED: 'Paused',
  DONE: 'Done',
  ERROR: 'Error',
}

// Claude Code 没有子状态事件，只能从 tool_name 推导（计划 §3）
function subStateForTool(toolName, toolInput) {
  if (!toolName) return 'Working'
  if (/^(Read|Grep|Glob|WebSearch|WebFetch|NotebookRead)$/.test(toolName)) return 'Searching'
  if (/^(Edit|Write|NotebookEdit)$/.test(toolName)) return 'Editing'
  if (toolName === 'Task' || toolName === 'Agent') return 'Delegating'
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
        this.#log(id, 'tool', `${payload.tool_name}: ${truncate(summarizeInput(payload.tool_input), 160)}`)
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
          this.#touch(s, { state: STATE.IDLE, sub_state: null })
          this.#log(id, 'idle', truncate(payload.message ?? '', 200))
        } else {
          this.#log(id, 'notification', `${kind}: ${truncate(payload.message ?? '', 160)}`)
        }
        break
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

function summarizeInput(input) {
  if (!input || typeof input !== 'object') return ''
  return input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description ?? ''
}
