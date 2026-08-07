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

  queue(sessionId, text) {
    const msg = { id: randomUUID(), text: String(text).slice(0, 4000), at: Date.now() }
    if (!this.#queues.has(sessionId)) this.#queues.set(sessionId, [])
    this.#queues.get(sessionId).push(msg)
    this.emit('change', sessionId)
    return msg
  }

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
