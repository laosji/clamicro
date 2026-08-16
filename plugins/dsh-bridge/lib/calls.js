/**
 * callId → 工具参数 的对照表。
 *
 * ## 为什么需要它
 *
 * DSH 的 `ApprovalRequest` **刻意不带工具参数**——只有 agent / toolName /
 * callId / reason / signal，参数被省掉是为了不跟已经流式发出去的 tool call
 * 重复。（见 docs/subsystems/approval.md）
 *
 * 但手机上那张审批卡片的全部价值就在参数里：「跑一条 Bash」不值得看，
 * 「跑 `rm -rf /`」才值得看。风险评估（clamicro 的 src/risk/assess.mjs）
 * 打分也是按参数打的。
 *
 * 所以订阅 `session/event` 时把 `tool/call` 的参数攒下来，等 `approval/request`
 * 拿着同一个 callId 来问的时候再对上。这也是 dsh-approval-llm 的做法。
 *
 * ## 为什么必须有界
 *
 * 这张表跟着长时间会话增长，而绝大多数工具调用**根本不会触发审批**——
 * 攒下来的东西 99% 用不上。不设上限的话，一个跑一整天的会话会把参数
 * （含文件全文、命令行、diff）全留在内存里。
 *
 * 淘汰按插入序，不按 LRU：审批请求总是紧跟在 tool/call 后面到达，
 * 隔了几百次调用还没来问的那条，就是不会来了。
 */

const DEFAULT_MAX = 200
const DEFAULT_TTL_MS = 10 * 60_000

export class CallTable {
  #map = new Map() // callId -> { toolName, args, at }
  #max
  #ttlMs

  constructor({ max = DEFAULT_MAX, ttlMs = DEFAULT_TTL_MS } = {}) {
    this.#max = max
    this.#ttlMs = ttlMs
  }

  /** 记一次工具调用。callId 缺失就不记——没有键的条目取不回来，只会白占位置。 */
  put(callId, toolName, args) {
    if (!callId) return
    // 同一个 callId 重复出现时先删再插，保证它在插入序里排到最新的位置，
    // 否则一条被反复更新的记录会因为「插入序最老」而先被淘汰掉
    this.#map.delete(callId)
    this.#map.set(callId, { toolName, args, at: Date.now() })
    this.#evict()
  }

  /**
   * 查参数，**不删**。
   *
   * 一条记录在生命周期里要被读两次，顺序是固定的：
   *
   *   tool/call（写入） → approval/request（读，取参数做卡片）
   *                     → 工具执行 → tool/result（读，取工具名）
   *
   * 所以读的时候不能删——审批一读就删的话，随后的 tool/result 查不到工具名，
   * 手机时间线上那条会变成「? 完成了」。真正的删点在 tool/result，见 delete()。
   *
   * @returns {{toolName: string, args: unknown} | null}
   *   null 表示**不知道**，不表示「没有参数」。调用方必须把这两件事分开——
   *   见 report.js 里 args_known 的注释，那是这个插件里最容易写出安全漏洞的地方。
   */
  get(callId) {
    if (!callId) return null
    const hit = this.#map.get(callId)
    if (!hit) return null
    if (Date.now() - hit.at > this.#ttlMs) {
      this.#map.delete(callId)
      return null
    }
    return { toolName: hit.toolName, args: hit.args }
  }

  /** 这次调用彻底结束了（tool/result 到了），可以回收。 */
  delete(callId) {
    if (callId) this.#map.delete(callId)
  }

  get size() {
    return this.#map.size
  }

  #evict() {
    const cutoff = Date.now() - this.#ttlMs
    for (const [k, v] of this.#map) {
      // Map 按插入序迭代，碰到第一条还没过期的就可以停
      if (v.at > cutoff) break
      this.#map.delete(k)
    }
    while (this.#map.size > this.#max) {
      const oldest = this.#map.keys().next()
      if (oldest.done) break
      this.#map.delete(oldest.value)
    }
  }
}
