import { EventEmitter } from 'node:events'
import { SELF_DEADLINE_MS } from './limits.mjs'

/**
 * 会话级的 Pause / Resume / Cancel。
 *
 * Claude Code 没有「运行时暂停」这个原语——没法在任意时刻冻结它。
 * 能做的是在**下一个可拦截点**（PreToolUse）把它挂住：
 *
 *   pause  → 置标记，下一个 PreToolUse 到达时不返回，一直挂着
 *   resume → 解除挂起，工具照常执行
 *   cancel → 挂起处返回 {continue:false}，Claude Code 直接终止本轮
 *
 * 所以「暂停」的真实语义是「跑完手头这一步就停」，不是「立刻停」。
 * 这一点必须在 UI 上说清楚，否则用户会以为点了没反应。
 */
export const CONTROL = {
  NONE: 'none',
  PAUSED: 'paused',
  CANCELLED: 'cancelled',
}

// 挂起最长时间。和审批的时限同源——都是「必须赶在 hook 的系统超时之前
// 自己结掉」，越过去会被当成非阻塞错误、工具照常执行。
const MAX_HOLD_MS = SELF_DEADLINE_MS

/**
 * 一个「已请求取消」最多留多久。
 *
 * 光有 turnKey 还不够：服务在会话中途启动时 turn_started_at 是 null，
 * 那时候两边都是 null，比出来「同一轮」——于是又会跨回合。TTL 是那种情况
 * 下的兜底。
 *
 * 45 秒：够覆盖「点完取消，等它跑完手头这一步」（那一步通常几秒到十几秒），
 * 又短到过期时你还记得自己点过。再长就变成一个你早就忘了的定时炸弹。
 */
export const CANCEL_TTL_MS = 45_000

export class ControlStore extends EventEmitter {
  #state = new Map() // sessionId -> 'none' | 'paused' | 'cancelled'
  /**
   * 已经点了取消、但还没撞上拦截点的那些。sessionId -> { turnKey, at }
   *
   * **必须带作用域，不能只是一个布尔。** 原来 CANCELLED 只是 #state 里的一个
   * 值，没有挂起者时就一直留着「让下一个拦截点来消费」——而下一个拦截点可能
   * 是**下一轮的第一条命令**。表现是「我上次点的取消，把这次的第一条命令干掉
   * 了」，架构文档 §6.2.1 记着这件事。
   *
   * turnKey 用 `turn_started_at`：三个后端都有（user-prompt-submit / turn-start
   * 时写），不需要任何新字段，而且「这一轮」的定义天然就是它。Codex 的
   * turn_id 更精确，但它只在 rollout 那条路上有，换不来跨后端的一致。
   */
  #armed = new Map()
  #waiters = new Map() // sessionId -> Set<{resolve, timer}>

  get(sessionId) {
    return this.#state.get(sessionId) ?? CONTROL.NONE
  }

  /**
   * 此刻**真的**有工具调用挂在拦截点上吗。
   *
   * 注释一度写反了（说的是「已请求暂停但还没撞上拦截点」），而它恰好是这个
   * 方法的**反面**——有 waiter 就说明已经撞上了。三个调用方（server.mjs 的
   * held 事件、api.mjs 的控制响应、ui/agents.js 的 stateLabel）用的都是正确
   * 语义，所以错的只有这行字。但 Paused 分「暂停中 / 已暂停」两个词全靠它，
   * 下一个照着注释改代码的人会把那两个词反过来。
   */
  isHeld(sessionId) {
    return (this.#waiters.get(sessionId)?.size ?? 0) > 0
  }

  pause(sessionId) {
    this.#state.set(sessionId, CONTROL.PAUSED)
    this.emit('change', sessionId, CONTROL.PAUSED)
    return { ok: true, state: CONTROL.PAUSED }
  }

  resume(sessionId) {
    this.#state.set(sessionId, CONTROL.NONE)
    this.emit('change', sessionId, CONTROL.NONE)
    this.#release(sessionId, { action: 'resume' })
    return { ok: true, state: CONTROL.NONE }
  }

  /**
   * 「阻止下一项工具操作」。**它不是「立即中断」**，两者的差别必须一路说到界面上。
   *
   * @param opts.turnKey 这一轮的标识（会话的 `turn_started_at`）。**没被当场消费
   *   掉的取消，只对这一轮有效**——原来它会一直留着等下一个拦截点，而下一个
   *   拦截点可能是下一轮的第一条命令（架构文档 §6.2.1 记的就是这个）。
   * @param opts.now 注入时钟，测试用
   */
  cancel(sessionId, { turnKey = null, now = Date.now() } = {}) {
    this.#state.set(sessionId, CONTROL.CANCELLED)
    this.emit('change', sessionId, CONTROL.CANCELLED)
    // 如果此刻正有工具调用挂在拦截点上，取消就地被消费掉了，
    // 状态必须复位——否则下一个工具调用会被连带取消。
    // #release 返回的是 waiter 个数，这里要的是「有没有被消费」。
    // 名字是 consumed，调用方也当布尔用——别让类型和名字对不上。
    const consumed = this.#release(sessionId, { action: 'cancel' }) > 0
    if (consumed) {
      this.#state.set(sessionId, CONTROL.NONE)
      this.emit('change', sessionId, CONTROL.NONE)
      this.#armed.delete(sessionId)
    } else {
      // 没有挂起者：留一个**带作用域**的标记，让这一轮的下一个拦截点来消费
      this.#armed.set(sessionId, { turnKey, at: now })
    }
    return { ok: true, state: consumed ? CONTROL.NONE : CONTROL.CANCELLED, consumed }
  }

  /**
   * 这一轮结束了 —— 没被消费掉的取消就地作废。
   *
   * turnKey 那道判据已经能挡住绝大多数跨回合，但服务在会话中途启动时
   * `turn_started_at` 是 null，两边都是 null 就比成了「同一轮」。这条是那种
   * 情况下的第二道，由 store 的 `turn-end` 事件驱动（hooks 和 codex-tail
   * 两条路都会经过它，所以只需要接一处）。
   */
  clearCancel(sessionId, why = 'turn-end') {
    if (!this.#armed.has(sessionId)) return false
    this.#armed.delete(sessionId)
    if (this.get(sessionId) === CONTROL.CANCELLED) {
      this.#state.set(sessionId, CONTROL.NONE)
      this.emit('change', sessionId, CONTROL.NONE)
    }
    this.emit('cancel-cleared', sessionId, why)
    return true
  }

  /** 会话结束时清干净，别留下悬挂的 waiter */
  forget(sessionId) {
    this.#release(sessionId, { action: 'resume' })
    this.#state.delete(sessionId)
    this.#armed.delete(sessionId)
  }

  /**
   * PreToolUse 调这个。返回 null 表示放行；
   * 返回对象则是要回给 Claude Code 的 hook 输出。
   */
  async gate(sessionId, { turnKey = null, now = Date.now() } = {}) {
    const st = this.get(sessionId)

    if (st === CONTROL.CANCELLED) {
      /**
       * **只消费属于这一轮、且还没过期的那个。**
       *
       * armed 里没有记录 = 取消是刚刚点的、当场就被挂起者消费了，这里照旧生效。
       * 有记录但轮次对不上或已过期 = 那是上一轮留下的，**必须放行**——
       * 「我上次点的取消把这次的第一条命令干掉了」正是要修的那个。
       */
      const armed = this.#armed.get(sessionId)
      const stale = armed && (
        (armed.turnKey !== null && turnKey !== null && armed.turnKey !== turnKey) ||
        now - armed.at > CANCEL_TTL_MS
      )
      this.#armed.delete(sessionId)
      this.#state.set(sessionId, CONTROL.NONE)
      this.emit('change', sessionId, CONTROL.NONE)
      if (stale) {
        this.emit('cancel-cleared', sessionId, 'stale')
        return null // 上一轮的遗留，不该动这一轮的第一条命令
      }
      return { continue: false, stopReason: '已从手机取消' }
    }
    if (st !== CONTROL.PAUSED) return null

    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        // 挂太久就自己放行，绝不能拖到 hook 超时——那会被当成
        // 非阻塞错误，工具反而照常执行，比放行更难解释。
        this.#drop(sessionId, entry)
        this.#state.set(sessionId, CONTROL.NONE)
        this.emit('change', sessionId, CONTROL.NONE)
        resolve({ action: 'timeout' })
      }, MAX_HOLD_MS)
      timer.unref?.()
      const entry = { resolve, timer }
      if (!this.#waiters.has(sessionId)) this.#waiters.set(sessionId, new Set())
      this.#waiters.get(sessionId).add(entry)
      this.emit('held', sessionId)
    })

    if (outcome.action === 'cancel') return { continue: false, stopReason: '已从手机取消' }
    return null // resume / timeout 都放行
  }

  /**
   * `held` 事件**两个方向都发**。
   *
   * 原来只在挂住的时候发一次，于是 server.mjs 那边把 `s.held` 置 true 之后
   * 再也没人清——一个曾经被挂住过的会话，此后永远带着「正卡在拦截点上」这
   * 个标记，哪怕早就 resume 了。当时没人发现是因为**没有任何前端读它**；
   * 一旦读了，那就是一条持续说假话的界面。
   *
   * 所以发的是「挂起集合变了」这件事，值由监听方自己去 isHeld() 取——
   * 事件里带布尔的话，release 和 drop 各写一遍 false，早晚有一处漏掉。
   */
  #release(sessionId, outcome) {
    const set = this.#waiters.get(sessionId)
    if (!set || !set.size) return 0
    const n = set.size
    for (const entry of set) {
      clearTimeout(entry.timer)
      entry.resolve(outcome)
    }
    set.clear()
    this.#waiters.delete(sessionId)
    this.emit('held', sessionId)
    return n
  }

  #drop(sessionId, entry) {
    const set = this.#waiters.get(sessionId)
    if (!set) return
    set.delete(entry)
    if (!set.size) this.#waiters.delete(sessionId)
    this.emit('held', sessionId)
  }
}
