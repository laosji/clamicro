/**
 * 跟读 Codex 的 rollout JSONL，把「一个回合结束了」这件事补回来。
 *
 * ## 为什么必须有这个文件
 *
 * Codex **没有回合级的结束事件**。0.149 的 hook 事件枚举一共十个
 * （二进制里 snake_case / PascalCase 两份互相印证）：
 *
 *   pre_tool_use  permission_request  post_tool_use  pre_compact  post_compact
 *   session_start session_end         user_prompt_submit          subagent_start
 *   subagent_stop
 *
 * **没有 `stop`。** 而 Claude Code 那条链路里，会话是靠 Stop 走出 Running 的。
 * 结果是：Codex 会话一旦收到 user-prompt-submit 就永远停在「运行中」，
 * 跑成功了也一样，只能等用户退出（SessionEnd）或者 30 分钟后被 sweepStale
 * 标成陈旧。手机上那张卡片会一直转，而那边可能三秒前就跑完了——
 * 这正是这个项目最不想要的那类故障：**界面说的和事实不符**。
 *
 * 信息其实一直躺在盘上。Codex 把每个会话写成一份 JSONL，里面有完整的回合线：
 *
 *   {"type":"event_msg","payload":{"type":"task_started","turn_id":…}}
 *   {"type":"event_msg","payload":{"type":"task_complete","turn_id":…,
 *                                  "last_agent_message":…,"error":{"message":…}}}
 *
 * `task_complete` 还**带 error 字段**，所以「正常结束」和「失败」是能区分的，
 * 不用靠超时猜。额度耗尽那种情况就是走这条：task_started 之后三秒 task_complete
 * 带 error，一个 hook 都不会响。
 *
 * ## 为什么读文件，不接 app-server
 *
 * `codex app-server proxy` 是更「正式」的入口（它甚至能导出 JSON Schema），
 * 但那是一条**有状态的双向协议连接**，还要依赖那个跟桌面 App 共用的常驻
 * daemon。跟读文件是**只读**的：读错了、读不到、格式变了，最坏结果是回到
 * 今天这个「状态不更新」，不会把别人的会话搞坏。零依赖也保得住。
 *
 * 代价要说清楚：**rollout 是 Codex 的内部格式，没有版本承诺。** 所以这里
 * 认不得的字段一律当没看见，任何一行解析失败都只跳过那一行。
 *
 * ## 从哪里开始读
 *
 * 不能简单地「从跟读那一刻的文件末尾开始」——那样有个一秒宽的黑洞：
 * `follow()` 到第一拍之间落盘的事件全部丢失。而这个窗口里恰恰可能躺着
 * 我们唯一要的那条 `task_complete`（失败的回合可以在一秒内结束）。
 *
 * 也不能从头回放：单份 rollout 平均 6.5 MB，而且会把历史回合重新写进时间线。
 *
 * 所以走中间路线：首拍**往回退一小段**（BACKSCAN），然后靠**每行自带的
 * `timestamp`** 筛掉旧事件——只应用 `follow()` 那一刻（减去一点余量）
 * 之后发生的。余量的作用是接住「hook 比 task_started 晚到几秒」那种情况，
 * 真机上见过：rollout 里 task_started 比 SessionStart hook 早三秒。
 *
 * 首拍之后就是普通的按 offset 增量读，不再筛。
 */
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 轮询间隔。文件追加没有可靠的跨平台通知，stat 一个文件便宜到可以忽略。 */
const TICK_MS = 1000

/**
 * 单次最多读多少字节。
 *
 * rollout 里单条 response_item 可以很大（整份文件平均 6.5 MB）。没有上限的话，
 * 一次 stat 撞上大批追加就会把几 MB 一次性拉进内存——而我们真正要的只是
 * 其中几十字节的 task_complete。读不完的部分下一拍继续，反正 offset 记着。
 */
const MAX_CHUNK = 512 * 1024

/** 半行缓冲的上限。超了就丢，说明这一行大得不像我们要的东西。 */
const MAX_PARTIAL = 1024 * 1024

/**
 * 首拍往回退多少字节。
 *
 * 只为了接住「follow 到第一拍之间那一秒」，不是为了回放历史——退多了
 * 等于每次跟读都要重扫一大段，退少了那一秒里的事件就丢了。
 * 真正把旧事件挡在外面的是下面那个时间戳筛子，这个数字只决定**扫多远**。
 */
const BACKSCAN = 256 * 1024

/**
 * 时间戳筛子的余量。
 *
 * 真机上见过 rollout 里的 task_started 比 SessionStart hook **早三秒**，
 * 所以不能拿 follow 的时刻当硬边界。给 10 秒：够接住那种偏差，又不足以
 * 把上一个回合捞回来。
 */
const SLACK_MS = 10_000

/**
 * 在 ~/.codex/sessions 底下找某个会话的 rollout 文件。
 *
 * 路径形如 sessions/2026/08/25/rollout-<ISO>-<session_id>.jsonl，按日期分层。
 * 不做全递归扫描：只往下走四层、且只看目录名是纯数字的那些（年/月/日），
 * 免得哪天 Codex 在这底下放了别的东西，我们跟着走进去。
 */
export function findRollout(sessionId, { home = homedir() } = {}) {
  const root = join(home, '.codex', 'sessions')
  const needle = `-${sessionId}.jsonl`
  const walk = (dir, depth) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return null // 目录不在 / 没权限：当作没找到，不是错误
    }
    // 日期目录倒序：同一个 id 只会有一份，但新的先找到就能早点返回
    for (const e of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      if (e.isFile()) {
        if (e.name.endsWith(needle)) return join(dir, e.name)
      } else if (e.isDirectory() && depth < 3 && /^\d+$/.test(e.name)) {
        const hit = walk(join(dir, e.name), depth + 1)
        if (hit) return hit
      }
    }
    return null
  }
  return walk(root, 0)
}

/**
 * 把 window_minutes 翻成人看得懂的短标签。
 *
 * 只认这几档：Codex 现在报的是 43200（30 天），别的档位是猜的。猜不出来的
 * 就按小时/天直接写，**不硬套** Claude 那套 5h/7d——那两个名字是别人的窗口，
 * 借过来用等于在界面上说一句不成立的话。
 */
function windowLabel(minutes) {
  const m = Number(minutes)
  if (!Number.isFinite(m) || m <= 0) return null
  if (m % 1440 === 0) return `${m / 1440}d`
  if (m % 60 === 0) return `${m / 60}h`
  return `${m}m`
}

/**
 * rate_limits → 我们的窗口数组。
 *
 * Codex 给的是 primary / secondary 两个位子（实测 secondary 常年是 null）。
 * used_percent 缺失时**整条丢掉**而不是补 0：0% 和「不知道」在界面上长得
 * 一模一样，而它们的含义相反。
 */
export function readWindows(rateLimits) {
  const out = []
  for (const key of ['primary', 'secondary']) {
    const w = rateLimits?.[key]
    if (!w) continue
    // 先挡 null/undefined 再转数字：Number(null) 是 0 且 isFinite 通过，
    // 于是「不知道」会被悄悄写成「0%」——那正是这段注释要避免的事
    if (w.used_percent === null || w.used_percent === undefined) continue
    const pct = Number(w.used_percent)
    if (!Number.isFinite(pct)) continue
    const label = windowLabel(w.window_minutes)
    if (!label) continue
    out.push({ key, label, pct, resets_at: Number.isFinite(Number(w.resets_at)) ? Number(w.resets_at) : null })
  }
  return out
}

/**
 * 把一行 rollout JSON 翻成我们认识的回合事件。
 *
 * 认不得的一律返回 null——rollout 里绝大多数行（response_item / world_state /
 * turn_context…）跟状态机无关，它们不是异常。
 */
export function parseLine(line) {
  let row
  try {
    row = JSON.parse(line)
  } catch {
    return null // 半行、空行、或者哪天格式变了：跳过这一行，不是故障
  }
  if (row?.type !== 'event_msg') return null
  const p = row.payload
  // 每行外层都带 ISO 时间戳。首拍靠它筛掉旧事件，见文件头「从哪里开始读」
  const ts = Date.parse(row.timestamp ?? '')
  const at = Number.isFinite(ts) ? ts : null
  if (p?.type === 'task_started') return { kind: 'start', at, turnId: p.turn_id ?? null }
  if (p?.type === 'token_count') {
    /**
     * 用量。**这条推翻了 agents.mjs 里「Codex 不上报用量」那句话**——
     * 那句话对 hook 通道成立（payload 里确实没有），但 TokenCount 就落在
     * rollout 里，跟读这条路看得见。
     *
     * 累计 token 对上 QUOTA.TOKENS，DSH 走的是同一条渲染路径。
     *
     * 同一条事件里还有 rate_limits.primary 的窗口百分比，**这里一并取走**
     * （readWindows）。它进不了 store 的 limits——那个字段的形状写死了
     * five_hour / seven_day，而 Codex 是单个 30 天窗口（window_minutes:
     * 43200）。所以走的是另一条：store.agentLimits，按后端存一组窗口。
     *
     * 额度耗尽时 info 整个是 null（实测），那时没有数字可用，返回 null
     * 让它当没发生：报一个 0 比不报更糟，界面会显示「累计 0 tok」。
     */
    const total = p.info?.total_token_usage?.total_tokens
    const windows = readWindows(p.rate_limits)
    // 两样都没有就当没发生。额度耗尽时 info 和 rate_limits 里全是 null（实测）
    if (!(Number.isFinite(total) && total > 0) && !windows.length) return null
    return { kind: 'usage', at, tokens: Number.isFinite(total) && total > 0 ? total : null, windows }
  }
  if (p?.type === 'task_complete') {
    // error 是个对象（{message}），不是字符串。只取 message：整个对象塞进
    // 时间线的话，用户看到的是一坨 JSON 而不是那句「额度用完了」
    const err = p.error?.message ?? (typeof p.error === 'string' ? p.error : null)
    return { kind: 'end', at, turnId: p.turn_id ?? null, error: err, message: p.last_agent_message ?? null }
  }
  return null
}

/**
 * 跟读器。一个共享定时器服务所有被跟读的会话。
 *
 * 每个会话一个定时器的话，开十个 Codex 会话就是十个定时器在轮询——
 * 而它们要做的事完全一样，合成一拍更省，也更容易一次性关干净。
 */
export function createCodexTail({ store, notify, config, home = homedir(), tickMs = TICK_MS }) {
  /** session_id -> { file, offset, partial } */
  const followed = new Map()
  let timer = null

  const ensureTimer = () => {
    if (timer || !followed.size) return
    timer = setInterval(tick, tickMs)
    // 跟读是**补充**信息，不该把进程钉在事件循环上不让它退出
    timer.unref?.()
  }

  const stopTimer = () => {
    if (timer && !followed.size) {
      clearInterval(timer)
      timer = null
    }
  }

  function tick() {
    for (const [id, st] of followed) {
      // 文件还没出现（会话刚建、Codex 还没落盘）：下一拍再找
      if (!st.file) {
        st.file = findRollout(id, { home })
        if (!st.file) continue
        try {
          // 首拍往回退一小段，再靠时间戳筛——见文件头「从哪里开始读」
          const size0 = statSync(st.file).size
          st.offset = Math.max(0, size0 - BACKSCAN)
          st.priming = true
          // 从文件中间切进去的话，第一行多半是半截。用**标志**记下这件事，
          // 别在下面拿 offset 去算——offset 是字节数而 chunk.length 是字符数，
          // 一行中文就能让那个减法恒为正，把唯一一行完整数据当半截头吃掉。
          st.headMayBePartial = st.offset > 0
        } catch {
          st.file = null
          continue
        }
      }
      let size
      try {
        size = statSync(st.file).size
      } catch {
        // 文件没了（会话被删/归档）：不再跟读，但**不改会话状态**——
        // 编一个「结束了」比不更新更糟
        followed.delete(id)
        continue
      }
      // 变小了 = 被截断或换了文件，从头来，别拿旧 offset 去读新内容
      if (size < st.offset) {
        st.offset = 0
        st.partial = ''
      }
      if (size === st.offset) continue

      const want = Math.min(size - st.offset, MAX_CHUNK)
      let chunk
      let fd
      try {
        fd = openSync(st.file, 'r')
        const buf = Buffer.allocUnsafe(want)
        const got = readSync(fd, buf, 0, want, st.offset)
        chunk = buf.subarray(0, got).toString('utf8')
        st.offset += got
      } catch {
        continue // 读失败就下一拍再来，offset 没动
      } finally {
        if (fd !== undefined) closeSync(fd)
      }

      const lines = (st.partial + chunk).split('\n')
      st.partial = lines.pop() ?? ''
      if (st.partial.length > MAX_PARTIAL) st.partial = ''
      if (st.headMayBePartial) {
        lines.shift()
        st.headMayBePartial = false
      }
      for (const line of lines) {
        if (!line.trim()) continue
        const evt = parseLine(line)
        if (!evt) continue
        /**
         * 首拍只认「follow 之后发生的」。
         *
         * 拿不到时间戳的一律**跳过**而不是放行：首拍读的是历史区间，
         * 放行一条来历不明的 task_complete 就等于凭空报一次「已完成」。
         * 首拍之后不再筛——那时读到的都是新追加的。
         */
        if (st.priming && !(evt.at !== null && evt.at >= st.since)) continue
        apply(id, evt)
      }
      st.priming = false
    }
    stopTimer()
  }

  /**
   * 把回合事件落到会话状态上。
   *
   * 走的是 applyHook 的内部事件名（`turn-start` / `turn-end`），**不在
   * HOOK_EVENTS 里**——所以它们进不了 /hooks/* 那条 HTTP 路由，外面伪造
   * 不出来。这条链路的输入只有本机 ~/.codex 下那份文件。
   */
  function apply(sessionId, evt) {
    const payload = { session_id: sessionId, agent: 'codex' }
    if (evt.kind === 'start') {
      store.applyHook('turn-start', payload, config.notify)
      return
    }
    if (evt.kind === 'usage') {
      // usage_reported 只在**真的拿到数字**时置 true。置 false 会让界面说
      // 「该后端不上报用量」，而事实是「这一轮没报」——两回事
      store.applyHook(
        'turn-usage',
        // usage_reported 只在**真的拿到 token 数**时置 true：光有窗口百分比
        // 不等于报了 token，而 agentUsage 的 tokens 分支看的就是这个布尔
        { ...payload, tokens: evt.tokens, windows: evt.windows, ...(evt.tokens ? { usage_reported: true } : {}) },
        config.notify,
      )
      return
    }
    const { notify: alert } = store.applyHook(
      'turn-end',
      { ...payload, error: evt.error, last_assistant_message: evt.message },
      config.notify,
    )
    if (alert) notify?.(alert)?.catch?.(() => {})
  }

  return {
    /** 开始跟读某个 Codex 会话。重复调用是幂等的。 */
    follow(sessionId) {
      if (!sessionId || followed.has(sessionId)) return
      // file 先留空：会话刚建时文件可能还没落盘，交给 tick 去找
      followed.set(sessionId, {
        file: null, offset: 0, partial: '', priming: false, headMayBePartial: false,
        // 首拍的时间戳下界。留余量：hook 可能比 rollout 里的事件晚到几秒
        since: Date.now() - SLACK_MS,
      })
      ensureTimer()
    },
    /** 会话结束了就别再跟了。SessionEnd 是 Codex 有的事件，这条是可靠的。 */
    unfollow(sessionId) {
      followed.delete(sessionId)
      stopTimer()
    },
    /** 关停用。 */
    stop() {
      followed.clear()
      if (timer) clearInterval(timer)
      timer = null
    },
    /** 测试用：现在跟着哪些会话。 */
    following: () => [...followed.keys()],
  }
}
