import { EventEmitter } from 'node:events'

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

// 挂起最长时间。同样必须小于 hook 的 600s 超时，
// 否则会被当成非阻塞错误、工具照常执行。
const MAX_HOLD_MS = 570_000

export class ControlStore extends EventEmitter {
  #state = new Map() // sessionId -> 'none' | 'paused' | 'cancelled'
  #waiters = new Map() // sessionId -> Set<{resolve, timer}>

  get(sessionId) {
    return this.#state.get(sessionId) ?? CONTROL.NONE
  }

  /** 有没有会话正处于「已请求暂停但还没撞上拦截点」的状态 */
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

  cancel(sessionId) {
    this.#state.set(sessionId, CONTROL.CANCELLED)
    this.emit('change', sessionId, CONTROL.CANCELLED)
    // 如果此刻正有工具调用挂在拦截点上，取消就地被消费掉了，
    // 状态必须复位——否则下一个工具调用会被连带取消。
    // 没有挂起者时才保留 CANCELLED，让下一个拦截点来消费它。
    const consumed = this.#release(sessionId, { action: 'cancel' })
    if (consumed) {
      this.#state.set(sessionId, CONTROL.NONE)
      this.emit('change', sessionId, CONTROL.NONE)
    }
    return { ok: true, state: consumed ? CONTROL.NONE : CONTROL.CANCELLED, consumed }
  }

  /** 会话结束时清干净，别留下悬挂的 waiter */
  forget(sessionId) {
    this.#release(sessionId, { action: 'resume' })
    this.#state.delete(sessionId)
  }

  /**
   * PreToolUse 调这个。返回 null 表示放行；
   * 返回对象则是要回给 Claude Code 的 hook 输出。
   */
  async gate(sessionId) {
    const st = this.get(sessionId)

    if (st === CONTROL.CANCELLED) {
      this.#state.set(sessionId, CONTROL.NONE) // 只取消这一轮
      this.emit('change', sessionId, CONTROL.NONE)
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
    return n
  }

  #drop(sessionId, entry) {
    const set = this.#waiters.get(sessionId)
    if (!set) return
    set.delete(entry)
    if (!set.size) this.#waiters.delete(sessionId)
  }
}
