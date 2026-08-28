import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'

/**
 * 从手机往 Claude Code 发消息。
 *
 * hooks 是单向的（Claude Code → 我们），没有「往里发消息」的 API。
 * 唯一的注入点是 Stop hook 的 decision:block —— 它会阻止 Claude 停下，
 * 并把 reason 当作输入让对话继续。
 *
 * 所以这个功能的真实语义是「排队，等这一轮跑完时送达」，而不是「立刻发送」。
 * 跟 Pause 一样，UI 上必须说清楚，否则用户会以为消息丢了。
 *
 * 已知边界：会话已经空闲时（Stop 早就触发过了），排队的消息要等到
 * 你在终端里再发起一轮、那一轮结束时才会送达。UI 会对这种情况给出提示。
 *
 * ## 「等我回话」——把 Stop 挂住
 *
 * 上面那条边界是这个功能最疼的地方：**它正在等你回话的那一刻，恰恰是我们
 * 手上什么都没有的时刻。** Stop 已经回过 `{}` 了，之后那条
 * `Notification: idle_prompt` 是单向的，Claude Code 不等它的回包。于是你在
 * 手机上打的字没有任何东西可以搭载，只能躺到你回终端敲一下。
 *
 * 唯一的口子是**别急着回 Stop**：挂住它，等你在手机上把话打完，再作为
 * `decision:block` 回过去。手法和 pause 完全一样（src/control.mjs 挂住
 * PreToolUse），架构不变——仍然是「只回答，不外发」，我们没有多出任何
 * 一条主动伸出去的路。
 *
 * ### 为什么必须由人显式打开
 *
 * 挂着 Stop 的这段时间，**终端不会把提示符还给你**。人在 Mac 前面时，
 * 看到的是「它好像还在跑」——正好是你不想要的。所以不能默认常开，也不能
 * 靠「手机上开着这个页面」去猜：页面摔口袋里走开是常态，猜错的代价是
 * 你自己的终端被堵住。谁打开的谁承担这个代价。
 *
 * ### 为什么超时会自动关掉
 *
 * 挂满一次都没等到回话，说明你已经走开了。这时候还留着开关，下一轮又堵
 * 一次，一直堵到你想起来为止。**「忘了关」的代价应该是一次，不是每一轮。**
 */
export class Inbox extends EventEmitter {
  #queues = new Map() // sessionId -> [{id, text, at}]
  /** 开着「等我回话」的会话。sessionId -> true */
  #armed = new Set()
  /** 此刻真的挂在 Stop 上的那些。sessionId -> {resolve, timer} */
  #holds = new Map()

  /**
   * 排一条消息。队列满了返回 null。
   *
   * ## 为什么要有条数上限
   *
   * 单条早就有 4000 字截断，条数一直没有。而消息**只在下一次 Stop 时才送达**
   * ——会话要是一直不再跑（终端关了、任务早结束了），队列就一直涨。
   * 手机上多按几次发送、或者哪个客户端循环调了这个接口，内存无界。
   * 而且它们会在某次 Stop 时**一次性全部注入**，模型收到一大坨陈年指令。
   *
   * ## 为什么是拒绝而不是丢最旧的
   *
   * HUD 那边满了是丢最旧的，因为那是**状态**——积压时旧状态早就过期了。
   * 这里是**用户的指令**：每一条都是他明确要说的话，静默丢掉哪一条都不行。
   * 拒绝新的至少发生在他按下发送的那一刻，手机上能当场告诉他。
   *
   * 20 条：手机上一次输入是有成本的，正常用法远到不了；到得了就说明
   * 那个会话根本不会再跑了，这时候提醒他比继续收下更有用。
   */
  queue(sessionId, text) {
    if (!this.#queues.has(sessionId)) this.#queues.set(sessionId, [])
    const q = this.#queues.get(sessionId)
    if (q.length >= Inbox.MAX_PER_SESSION) return null

    const msg = { id: randomUUID(), text: String(text).slice(0, 4000), at: Date.now() }
    q.push(msg)
    this.emit('change', sessionId)
    return msg
  }

  static MAX_PER_SESSION = 20

  list(sessionId) {
    return this.#queues.get(sessionId) ?? []
  }

  all() {
    return Object.fromEntries([...this.#queues].filter(([, v]) => v.length))
  }

  remove(sessionId, id) {
    const q = this.#queues.get(sessionId)
    if (!q) return false
    const i = q.findIndex((m) => m.id === id)
    if (i < 0) return false
    q.splice(i, 1)
    if (!q.length) this.#queues.delete(sessionId)
    this.emit('change', sessionId)
    return true
  }

  /**
   * 取走并清空某会话的全部排队消息，拼成一次注入。
   * 多条合并而不是逐条注入——逐条会让 Claude 每收一条就跑一轮，
   * 你连着写的三句话会被拆成三次独立任务。
   */
  drain(sessionId) {
    const q = this.#queues.get(sessionId)
    if (!q?.length) return null
    const text = q.map((m) => m.text).join('\n\n')
    this.#queues.delete(sessionId)
    this.emit('change', sessionId)
    return { text, count: q.length }
  }

  /**
   * 挂多久。
   *
   * 90 秒：够你看一眼手机、打一句话。**上限不是技术上限**——hook 的系统超时
   * 给到 570 秒（见 src/limits.mjs），这里主动取小得多，因为超出的每一秒都
   * 花在堵住你自己的终端上。忘了关的代价要小到你能承受。
   */
  static HOLD_MS = 90_000

  isArmed(sessionId) {
    return this.#armed.has(sessionId)
  }

  /** 此刻真的挂着吗——界面要用它区分「开着」和「正在等」 */
  isHolding(sessionId) {
    return this.#holds.has(sessionId)
  }

  /**
   * 这次挂起是什么时候开始的，没挂着返回 null。
   *
   * 界面拿它倒数。**不给的话倒数就是编的**：手机是什么时候打开的、SSE 那条
   * 消息路上花了多久，页面都不知道。而这 90 秒里「还剩多少」直接决定你要不要
   * 现在动手打一段长的。
   */
  holdingSince(sessionId) {
    return this.#holds.get(sessionId)?.at ?? null
  }

  arm(sessionId, on = true) {
    if (on) this.#armed.add(sessionId)
    else {
      this.#armed.delete(sessionId)
      // 关掉时如果正挂着，就地放行——否则人点了「关」，终端还要再堵满 90 秒
      this.#release(sessionId, null)
    }
    this.emit('armed', sessionId, on)
    return on
  }

  /**
   * Stop 到了、队列却是空的时候调这个。
   *
   * 返回 `{text, count}` 表示等到了话（调用方拿去 decision:block），
   * 返回 null 表示没等到（照常放行，会话正常停下，和没这个功能时一样）。
   *
   * @param opts.now 注入时钟，测试用
   * @param opts.timer 注入定时器，测试用
   */
  hold(sessionId, { holdMs = Inbox.HOLD_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    if (!this.#armed.has(sessionId)) return Promise.resolve(null)
    // 同一个会话不该有两个挂起者。真出现就让旧的先走，别让它永远挂着
    this.#release(sessionId, null)

    return new Promise((resolve) => {
      const timer = setTimer(() => {
        this.#holds.delete(sessionId)
        /*
         * 挂满了都没等到——你走开了。**顺手把开关关掉**，理由见类注释：
         * 「忘了关」的代价应该是一次，不是每一轮。
         */
        this.#armed.delete(sessionId)
        this.emit('armed', sessionId, false)
        this.emit('hold-end', sessionId, 'timeout')
        resolve(null)
      }, holdMs)
      timer.unref?.()
      this.#holds.set(sessionId, { resolve, timer, clearTimer, at: Date.now() })
      this.emit('hold-start', sessionId)
    })
  }

  /**
   * 有话来了 / 不挂了。`payload` 为 null 表示放行。
   *
   * 挂起者是在 `hold()` 里等着的那个 Promise；这里 resolve 它。
   */
  #release(sessionId, payload) {
    const h = this.#holds.get(sessionId)
    if (!h) return false
    h.clearTimer(h.timer)
    this.#holds.delete(sessionId)
    h.resolve(payload)
    this.emit('hold-end', sessionId, payload ? 'delivered' : 'released')
    return true
  }

  /**
   * 排队之后调一次：正挂着就地送达。
   *
   * 不在 `queue()` 里直接做，是因为 drain 是**破坏性**的——取走了就没了，
   * 而消息能不能到全看后面那个还没写的 HTTP 响应（见 hooks.mjs 里 stop 那段
   * 关于 `res.destroyed` 的注释）。谁持有那个响应，谁来决定什么时候取。
   */
  deliverIfHolding(sessionId) {
    if (!this.#holds.has(sessionId)) return false
    const pending = this.drain(sessionId)
    if (!pending) return false
    return this.#release(sessionId, pending)
  }

  /**
   * 把已经取走的一坨放回队列头部。
   *
   * 只有一个调用方：挂起等到了回话，但**写响应之前发现连接已经断了**
   * （见 hooks.mjs 里 stop 那段）。drain 是破坏性的，那时消息已经不在队列
   * 里了——不放回去就是「手机上显示已送达，实际上没人收到」。
   *
   * 放回头部而不是尾部：它们本来就排在最前面，顺序是用户写下来的顺序。
   */
  requeue(sessionId, pending) {
    if (!pending?.text) return false
    if (!this.#queues.has(sessionId)) this.#queues.set(sessionId, [])
    this.#queues.get(sessionId).unshift({ id: randomUUID(), text: pending.text, at: Date.now() })
    this.emit('change', sessionId)
    return true
  }

  /** 会话没了就别留挂起者和开关 */
  forget(sessionId) {
    this.#release(sessionId, null)
    this.#armed.delete(sessionId)
    this.#queues.delete(sessionId)
  }
}
