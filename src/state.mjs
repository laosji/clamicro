import { EventEmitter } from 'node:events'
import { noRedact } from './redact.mjs'

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
    if (/\b(test|pytest|jest|vitest|go test|cargo test|npm t\b|npm run test)/.test(cmd)) {
      return 'Running Test'
    }
    return 'Running Command'
  }
  if (toolName.startsWith('mcp__')) return 'Calling MCP'
  return 'Working'
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
   * （查询参数 t= 后面就是主令牌）。那些事件会落盘，并通过 /api/state
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
        session_name: null,
        cwd: null,
        state: STATE.IDLE,
        sub_state: null,
        turn_started_at: null,
        last_message: null,
        updated_at: Date.now(),
        limits: null,
        context: null,
        cost_usd: null,
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
    if (limits?.five_hour) this.#accountLimits = limits
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
      patch = { ...patch, last_message: this.#redact(patch.last_message) }
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
        this.#touch(s, { state: STATE.DONE, sub_state: null, last_message: msg, turn_started_at: null })
        this.#log(id, 'stop', msg)
        if (notifyConfig.onStop && elapsed >= notifyConfig.minTurnMs) {
          notify = {
            title: 'Clamicro',
            icon: '✓',
            // 完成是**状态**：横向一条只说状态本身。
            // 项目名不放这儿——横向态是给余光扫的，「已完成」三个字就够；
            // 想知道是哪个项目，纵向的通知和手机看板里都有。
            compact: true,
            short: '已完成',
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
        this.#touch(s, { state: STATE.ERROR, sub_state: null, last_message: msg, turn_started_at: null })
        this.#log(id, 'error', msg)
        if (notifyConfig.onError) {
          notify = { title: 'Clamicro', icon: '✕', subtitle: `${label} 出错`, body: msg }
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
    this.#touch(s, { state: STATE.WAITING_APPROVAL, sub_state: null, pending_approval_id: approval.id })
    this.#log(sessionId, 'approval-requested', `${approval.tool_name}: ${truncate(approval.summary, 160)}`)
  }

  clearWaitingApproval(sessionId) {
    if (!sessionId) return
    const s = this.session(sessionId)
    if (s.state === STATE.WAITING_APPROVAL) {
      this.#touch(s, { state: STATE.RUNNING, sub_state: 'Thinking', pending_approval_id: null })
    } else {
      this.#touch(s, { pending_approval_id: null })
    }
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
