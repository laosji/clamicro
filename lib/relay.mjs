import { EventEmitter } from 'node:events'

/**
 * ntfy 双 topic 中转。Mac 全程只有出站连接：
 *
 *   Mac ──出站 POST──► <server>/<notifyTopic> ──► iPhone 通知（带按钮）
 *                                                      │ 点按钮
 *   Mac ◄─出站 GET 长连接── <server>/<commandTopic> ◄───┘
 *
 * 因此不需要 Tailscale / 内网穿透 / 公网 IP / 证书。
 */
export class Relay extends EventEmitter {
  #cfg
  #abort = null
  #lastId = null
  #backoff = 1000
  #stopped = false

  constructor(cfg) {
    super()
    this.#cfg = cfg
  }

  get notifyUrl() {
    return `${this.#cfg.server}/${this.#cfg.notifyTopic}`
  }

  get commandUrl() {
    return `${this.#cfg.server}/${this.#cfg.commandTopic}`
  }

  /** 发通知。actions 为 ntfy 的动作按钮数组。 */
  async publish({ title, body, priority = 3, click, actions, tags }) {
    const payload = {
      topic: this.#cfg.notifyTopic,
      title,
      message: body,
      priority,
      ...(click ? { click } : {}),
      ...(actions?.length ? { actions } : {}),
      ...(tags?.length ? { tags } : {}),
    }
    const res = await fetch(this.#cfg.server, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`ntfy publish HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return res.json()
  }

  /** 订阅指令 topic。长连接，断了自动重连并用 since 补齐漏掉的消息。 */
  start() {
    this.#stopped = false
    this.#loop().catch((err) => console.error(`[relay] 订阅循环异常: ${err.message}`))
  }

  stop() {
    this.#stopped = true
    this.#abort?.abort()
  }

  async #loop() {
    while (!this.#stopped) {
      this.#abort = new AbortController()
      try {
        // since 保证重连期间发出的指令不丢；首次用 5s 避免重放历史
        const since = this.#lastId ?? '5s'
        const url = `${this.commandUrl}/json?since=${encodeURIComponent(since)}`
        const res = await fetch(url, { signal: this.#abort.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)

        console.log(`[relay] 已订阅 ${this.commandUrl}`)
        this.#backoff = 1000
        this.emit('connected')

        let buf = ''
        for await (const chunk of res.body) {
          buf += Buffer.from(chunk).toString('utf8')
          let nl
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (line) this.#handle(line)
          }
        }
        throw new Error('连接被对端关闭')
      } catch (err) {
        if (this.#stopped) return
        console.error(`[relay] 断开（${err.message}），${this.#backoff}ms 后重连`)
        this.emit('disconnected', err)
        await new Promise((r) => setTimeout(r, this.#backoff))
        this.#backoff = Math.min(this.#backoff * 2, 30_000)
      }
    }
  }

  #handle(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.id) this.#lastId = msg.id
    if (msg.event !== 'message') return // open / keepalive 忽略
    this.emit('command', msg.message ?? '')
  }
}

/** 指令编码：id|decision|key。不用 JSON，避免任何一层的引号与逗号转义问题。 */
export function encodeCommand(id, decision, key) {
  return `${id}|${decision}|${key}`
}

export function decodeCommand(raw) {
  const [id, decision, key] = String(raw).trim().split('|')
  if (!id || !decision || !key) return null
  return { id, decision, key }
}
