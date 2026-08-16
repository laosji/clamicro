/**
 * 往 Clamicro 本地服务上报。
 *
 * 走的是**现成的** hook 端点（`/hooks/<event>`），不新开接口——clamicro 那边
 * 早就把 Claude Code 的 hooks 和 statusLine 统一成一套上报格式了，这里只是
 * 第三个说同一种语言的来源。payload 里多带一个 `agent: 'dsh'`，clamicro
 * 用它决定手机上给不给暂停/取消/发消息的入口（见 clamicro 的 src/agents.mjs）。
 *
 * 端点只认回环地址（clamicro 的 http/security.mjs 里的 isLoopback），
 * 所以不需要令牌，也**只能**在同一台机器上跑。
 */

const DEFAULT_ORIGIN = 'http://127.0.0.1:8765'

export class Reporter {
  #origin
  #log

  constructor({ origin = DEFAULT_ORIGIN, log = () => {} } = {}) {
    this.#origin = String(origin).replace(/\/+$/, '')
    this.#log = log
  }

  /**
   * 状态上报：**发出去就不管了**。
   *
   * 这里绝对不能 await，也绝对不能让异常冒出去。两个理由，都不是理论问题：
   *
   *   · 插件跑在 DSH **主进程内**。await 一个正卡住的本地服务（比如它此刻
   *     正挂着一条等人审批的请求）就是拖住 DSH 自己的事件循环。Claude Code
   *     那边的 hook 是独立进程，卡了只卡它自己——这个前提在这里不成立。
   *   · DSH 的 session/event 是 post-commit fire-and-forget，框架会兜住
   *     观察者异常、不让 append 失败。它兜的是**抛异常**，没兜**慢**。
   *
   * 上报失败就是丢一条状态，手机上少一行时间线。这个代价远小于任何一种
   * 让 DSH 变慢或变不稳的可能。
   */
  send(event, payload) {
    const url = `${this.#origin}/hooks/${event}`
    // 不返回这个 promise：拿到它的人可能会 await
    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, agent: 'dsh' }),
      // 状态上报不值得等：clamicro 没起来时连接会被立刻拒绝，
      // 但万一它起着却卡着，这个超时是唯一的兜底
      signal: AbortSignal.timeout(3000),
    }).catch((err) => {
      // 只记不抛。日志也压一压——服务没起来的时候每个事件都会失败一次
      this.#log(`上报 ${event} 失败：${err?.message ?? err}`)
    })
  }

  /**
   * 审批：**这一条必须等**。
   *
   * 跟上面正好相反——审批的全部意义就是在人做决定之前把事情挂住。
   * DSH 的答复器允许返回 Promise（docs/subsystems/approval.md），
   * 这正是 clamicro 需要的形状。
   *
   * @returns {Promise<'allow'|'deny'>}
   * @throws  连不上 / 超时 / 响应不合规都抛。调用方必须接住并交回人类，
   *          见 index.js —— DSH 是 fail-closed，让异常冒出去等于**拒绝**，
   *          而「服务挂了所以全部拒绝」会把整个 DSH 卡死。
   */
  async requestApproval(body, { signal, timeoutMs = 600_000 } = {}) {
    // 两个信号取或：外部撤回（DSH 撤回了这次提问）和我们自己的截止时间
    const timer = AbortSignal.timeout(timeoutMs)
    const composed = signal ? AbortSignal.any([signal, timer]) : timer

    const res = await fetch(`${this.#origin}/hooks/permission-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, agent: 'dsh' }),
      signal: composed,
    })
    if (!res.ok) throw new Error(`审批接口返回 ${res.status}`)

    const data = await res.json()
    const decision = data?.decision ?? data?.hookSpecificOutput?.decision?.behavior
    if (decision !== 'allow' && decision !== 'deny') {
      // 认不出来的决策**不能猜**。猜 allow 是放行了一个没人批准的操作，
      // 猜 deny 是替用户拒绝。抛出去，让调用方交回人类。
      throw new Error(`认不出的决策：${JSON.stringify(decision)}`)
    }
    return decision
  }
}
