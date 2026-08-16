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
 */
export class Inbox extends EventEmitter {
  #queues = new Map() // sessionId -> [{id, text, at}]

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
}
