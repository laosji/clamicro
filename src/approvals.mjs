import { EventEmitter } from 'node:events'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { assessRisk, riskSpans } from './risk/assess.mjs'
import { analyze, truncateDetail, askQuestions } from './view/describe.mjs'
import { noRedact } from './redact.mjs'

/** 逐行抹凭证。行的结构（t/s）不动，只换文本。 */
function redactChange(change, redact) {
  return {
    ...change,
    path: redact(change.path),
    lines: change.lines.map((l) => ({ t: l.t, s: redact(l.s) })),
  }
}
import { SELF_DEADLINE_MS } from './limits.mjs'

/**
 * 把一次工具调用压成一个对账键，用来把 PermissionRequest 挂起的记录
 * 和随后 PreToolUse 报告的「已经开始执行」对上号。见 supersede() 的注释：
 * tool_use_id 在权限阶段还不存在，只能靠这个三元组。
 *
 * 键要稳定：对象字面量的键顺序理论上由构造顺序决定，两个 hook 都源自
 * 同一份 tool_input，顺序本该一致——但这属于「碰巧成立」，不值得依赖。
 * 递归排序后再序列化，代价可以忽略，换来的是不会因为顺序变化而静默失配。
 */
export function matchKey(session_id, tool_name, tool_input) {
  const stable = (v) => {
    if (v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.map(stable)
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, stable(v[k])]),
    )
  }
  return createHash('sha256')
    .update(`${session_id ?? ''}\u0000${tool_name ?? ''}\u0000${JSON.stringify(stable(tool_input ?? {}))}`)
    .digest('base64url')
    .slice(0, 22)
}

// hook 默认超时 600s。我们在 570s 主动返回 deny，绝不让它走到系统超时——
// 否则超时会被当成「非阻塞错误」而放行到正常权限流程，人不在电脑边时终端会
// 空挂在那里等一个没人看的弹框。（计划 §2.1）
/**
 * env 覆盖也要**夹在同一条上限里**。
 *
 * 设置页那条路早就 clamp 了（routes/api.mjs 用 MIN/MAX_APPROVAL_TIMEOUT_MS），
 * 这条没有——`CLAMICRO_APPROVAL_TIMEOUT_MS=599000` 会原样生效，然后撞上
 * hook 的 600 秒系统超时。而系统超时会被 Claude Code 当成**非阻塞错误**，
 * 结果是**放行**：一个本该「超时即拒绝」的高危操作，因为把超时调长了
 * 反而变成了自动通过。这正是 SELF_DEADLINE_MS 这个常量存在的全部理由，
 * 不能留一条绕过它的口子。
 *
 * 上限直接用 SELF_DEADLINE_MS，不 import config.mjs 的 MAX_APPROVAL_TIMEOUT_MS
 * ——那会绕成循环依赖（config 已经 import 了 limits）。两者本来就是同一个值。
 */
const MIN_SELF_TIMEOUT_MS = 10_000
export const SELF_TIMEOUT_MS = (() => {
  const want = Number(process.env.CLAMICRO_APPROVAL_TIMEOUT_MS)
  if (!Number.isFinite(want) || want <= 0) return SELF_DEADLINE_MS
  const clamped = Math.min(SELF_DEADLINE_MS, Math.max(MIN_SELF_TIMEOUT_MS, want))
  if (clamped !== want) {
    console.warn(
      `[approval] CLAMICRO_APPROVAL_TIMEOUT_MS=${want} 超出允许范围，已夹到 ${clamped}ms。` +
      `上限 ${SELF_DEADLINE_MS}ms 是硬的：再长会撞 hook 的 600 秒系统超时，而那会被当成放行。`,
    )
  }
  return clamped
})()

export const OUTCOME = {
  ALLOW: 'allow',
  DENY: 'deny',
}

/**
 * 「放行 = 错过」的工具。
 *
 * extend() 的规则是「到点会通过的就不延长」——因为对普通操作来说，自动通过
 * 正是你想要的结果，延长只会白白拖住 Claude。
 *
 * AskUserQuestion 是这条规则的例外，而且是反过来的：它不是一次「操作」，
 * 是**一道问给人的选择题**。放行它不代表事情办成了，只代表这道题被弹回
 * Mac 终端 —— 手机那边彻底失去了回答的机会。所以对它来说，自动通过和
 * 自动拒绝一样是不可挽回的，同样需要人的尺度的时间。
 *
 * 有实测支撑：历史里唯一一条在手机上答成的 AskUserQuestion，窗口是 223 秒
 * ——靠的正是 extend。按 10 秒算，它会在页面还没读完时就被弹回终端。
 */
export const MISSABLE_TOOLS = new Set(['AskUserQuestion'])


export class ApprovalStore extends EventEmitter {
  #items = new Map()
  #waiters = new Map() // id -> {resolve, timer}
  #redact = noRedact

  /**
   * 注入凭证抹除器。和 Store 上那个是同一个洞的另一半。
   *
   * 事件流那边补过了，审批这边当时漏了——而这边其实更常见：命令里带凭证
   * 是日常（`curl -H 'Authorization: Bearer …'`、把 token 塞进环境变量），
   * 而**审批详情正是手机上最主要显示的东西**。一台只该有可吊销设备令牌的
   * 手机，能从待审批列表里读回主令牌。
   *
   * 只抹**派生的展示字段**（detail / summary / headline），
   * **绝不动 tool_input**——matchKey 拿它逐字算哈希去和 PreToolUse 对账，
   * 改一个字节 supersede 就永远匹配不上，幽灵审批就回来了。
   * publicApproval 本来也不输出 tool_input。
   */
  setRedactor(fn) {
    this.#redact = typeof fn === 'function' ? fn : noRedact
    return this
  }

  /**
   * @param args_known 上报方是否**确实知道**这次调用的参数。
   *   只有 DSH 那条路会传 false（ApprovalRequest 不带参数，靠 callId 回查，
   *   查不到就是不知道）。缺省 true —— Claude Code 的 payload 一直带着参数，
   *   老调用方不该因为多了这个字段而改变行为。
   */
  create({ session_id, tool_name, tool_input, permission_rule, tool_use_id, cwd, args_known }, policy = {}) {
    const now = Date.now()
    const argsKnown = args_known !== false
    const risk = assessRisk(tool_name, tool_input, cwd, { argsKnown })
    const view = analyze(tool_name, tool_input)
    // 先截断、再抹凭证、最后算高亮区间——**顺序不能换**：
    // 下标必须对应用户实际看到的那份文本，抹除会改变长度。
    const detail = this.#redact(truncateDetail(view.detail))

    // 无人操作时的默认结果，按风险分档：
    //   普通 → 短时自动通过（别为 npm run build 打扰人）
    //   高危 → 长时自动拒绝（失败即拒绝，人不在就不该放行 rm -rf）
    const autoApproveMs = Number(policy.autoApproveMs ?? 0)
    const canAuto = autoApproveMs > 0 && (risk.level !== 'high' || policy.autoApproveHighRisk)
    const autoDecision = canAuto ? OUTCOME.ALLOW : OUTCOME.DENY
    const ttl = canAuto ? autoApproveMs : Number(policy.timeoutMs ?? SELF_TIMEOUT_MS)

    const ap = {
      id: randomUUID(),
      // 单个审批专用密钥：推送深链用它，免得从通知点进来还要先登录。
      // 作用域仅限这一条审批，且随它一起过期。
      key: randomBytes(18).toString('base64url'),
      session_id,
      tool_use_id: tool_use_id ?? null, // PermissionRequest 不给，PreToolUse 才有
      match_key: matchKey(session_id, tool_name, tool_input),
      tool_name: tool_name ?? 'unknown',
      tool_input: tool_input ?? {},
      headline: this.#redact(view.headline),
      // agent 生成的命令可能是几 KB 的 heredoc/脚本。全量塞进页面既拖慢
      // 渲染也没人看得完——超长就截断，明确标出还剩多少。
      detail,
      // 命令里哪几段命中了风险规则，给 UI 高亮用。是下标区间不是字符串，
      // 这样前端可以先切片再逐段转义，不会因为转义而错位。
      detail_spans: tool_name === 'Bash' ? riskSpans(detail) : [],
      /**
       * 选择题的结构化题目。只有 AskUserQuestion 有。
       *
       * **不经 #redact**：这里面是模型写给人看的问题和选项，不是命令行、
       * 不含路径也不含凭证。抹一遍只会把「sk-」这类看着像密钥的正常字样
       * 打上马赛克，让选项读不懂。
       */
      choices: tool_name === 'AskUserQuestion' ? askQuestions(tool_input) : [],
      /** 人选了什么。answer() 写入，用来在结果页回显 */
      answer: null,
      impact: view.impact,
      // 描述与命令不符的警告。description 是模型自己写的，是链路里
      // 唯一不可信的部分，不符时必须让用户看见。
      mismatch: view.mismatch ?? null,
      detail_lines: view.detail ? view.detail.split('\n').length : 0,
      /**
       * 写文件类操作要写进去的内容。见 view/describe.mjs 的 fileChange。
       *
       * **要抹凭证**，而且这里比命令行更常撞上：往 .env / 配置文件里写 key
       * 是 agent 每天都在干的事，而这段内容会原样出现在手机页面上。
       * 抹的是派生的展示字段，tool_input 一个字节都不动——matchKey 拿它
       * 逐字算哈希去跟 PreToolUse 对账，改了就永远对不上。
       */
      change: view.change ? redactChange(view.change, this.#redact) : null,
      // 首页卡片、日志、推送正文仍用一行摘要
      summary: this.#redact(view.headline),
      rule: permission_rule?.action ?? null,
      rule_behavior: permission_rule?.behavior ?? null,
      risk,
      created_at: now,
      expires_at: now + ttl,
      auto_decision: autoDecision, // 到点后会怎么处理，UI 要如实告诉用户
      status: 'pending', // pending | allowed | auto_allowed | answered | denied | expired | abandoned | superseded
      decided_by: null, // phone | timeout | abandoned
      decided_at: null,
    }
    this.#items.set(ap.id, ap)
    this.emit('created', ap)
    return ap
  }

  get(id) {
    return this.#items.get(id) ?? null
  }

  /** 落盘用：导出全部记录 */
  all() {
    return [...this.#items.values()]
  }

  /**
   * 从磁盘恢复。仍是 pending 的一律转 abandoned——
   * 进程重启后那些 hook 的 HTTP 连接早就断了，Claude Code 那边
   * 已经走完各自的超时，再显示成「待审批」是在骗人。
   */
  restore(records) {
    let orphaned = 0
    for (const r of records ?? []) {
      if (!r?.id) continue
      // 老记录没有 match_key，补上——否则它们永远对不上账
      r.match_key ??= matchKey(r.session_id, r.tool_name, r.tool_input)
      if (r.status === 'pending') {
        r.status = 'abandoned'
        r.decided_by = 'restart'
        r.decided_at = r.decided_at ?? Date.now()
        orphaned++
      }
      this.#items.set(r.id, r)
    }
    return { restored: records?.length ?? 0, orphaned }
  }

  /**
   * 同一次工具调用已经开始执行了 —— 说明这次授权在别处（终端弹框、
   * 权限规则、acceptEdits 之类的模式）已经被批准，而我们这条还挂着空等。
   *
   * Claude Code 不会取消已经发出的 PermissionRequest 请求，所以连接一直开着、
   * req 的 close 事件也不触发，记录会一直显示「待审批」直到超时。
   * 界面上就出现了「明明已经执行完，却还让你去批」的幽灵条目。
   *
   * 对账键为什么不是 tool_use_id：**PermissionRequest 的 payload 里没有它**。
   * 实测两个 hook 的字段——
   *   PermissionRequest: session_id, transcript_path, cwd, prompt_id,
   *                      permission_mode, effort, hook_event_name,
   *                      tool_name, tool_input, permission_suggestions
   *   PreToolUse:        …同上（无 permission_suggestions）+ tool_use_id
   * Claude Code 在权限阶段还没分配 tool_use_id，等到 PreToolUse 才有。
   * 所以只能用两边都在、且逐字相同的三元组 (session_id, tool_name, tool_input)。
   *
   * 返回 allow —— 操作事实上已经在跑了，这时候回 deny 才是与现实矛盾的。
   */
  supersede(key) {
    if (!key) return null
    // 同一会话里可能连着跑两条一模一样的命令，match_key 会撞。
    // 只结掉最早的那条，剩下的留给下一次 PreToolUse 对账。
    let oldest = null
    for (const ap of this.#items.values()) {
      if (ap.status === 'pending' && ap.match_key === key) {
        if (!oldest || ap.created_at < oldest.created_at) oldest = ap
      }
    }
    if (!oldest) return null
    this.#settle(oldest.id, 'superseded', 'elsewhere')
    return oldest
  }

  pending(sessionId) {
    return [...this.#items.values()].filter(
      (a) => a.status === 'pending' && (!sessionId || a.session_id === sessionId),
    )
  }

  /** 阻塞直到有人决策或自超时。返回 {decision, reason}。 */
  wait(id) {
    const ap = this.#items.get(id)
    if (!ap) return Promise.resolve({ decision: OUTCOME.DENY, reason: '审批记录不存在' })
    if (ap.status !== 'pending') return Promise.resolve(this.#outcomeOf(ap))

    return new Promise((resolve) => {
      // 到点的处理抽成 arm()，因为 extend() 要能把它重新排一次期。
      // 光改 expires_at 是没用的——定时器在创建那一刻就把延迟算死了
      const fire = () => {
        const ttlSec = Math.round((ap.expires_at - ap.created_at) / 1000)
        const allow = ap.auto_decision === OUTCOME.ALLOW
        this.#settle(id, allow ? 'auto_allowed' : 'expired', 'timeout')
        resolve(
          allow
            ? { decision: OUTCOME.ALLOW, reason: null }
            : { decision: OUTCOME.DENY, reason: `等待审批超时（${ttlSec}s），已自动拒绝` },
        )
      }
      const arm = () => {
        const t = setTimeout(fire, Math.max(0, ap.expires_at - Date.now()))
        t.unref?.()
        return t
      }
      this.#waiters.set(id, { resolve, timer: arm(), arm })
    })
  }

  /**
   * 有人真的在看这一条 —— 把时钟往后推。
   *
   * ## 只对「到点会被拒绝」的那些延长
   *
   * 延长存在的意义是：在一个**不可挽回的自动决策**落下之前，给你时间读完再定。
   * 那个决策是拒绝时，延长是在救场；是通过时，延长只是把一件你反正会放行的事
   * 又拖了几分钟。
   *
   * 之前对所有审批一视同仁地推到 3 分钟，代价很具体：点开一条 `npm run build`
   * 然后走开，Claude 会被卡满 3 分钟——而不延长的话只卡 10 秒。用户看到的是
   * 首页显示 10s、点进去突然变 3m，而那个 3m 是真的会让终端干等三分钟。
   *
   * 判据用 `auto_decision === DENY` 而不是「风险等级 high」：两者通常一致，但
   * 打开 autoApproveHighRisk 之后高危也会自动通过，那时它同样不该被延长——
   * 规则始终是「到点会通过的，延长没有意义」。
   *
   * ## 代价（已知并接受）
   *
   * 历史里 11 条在手机上点成的普通审批，有 4 条用了 10 秒以上（最长 49 秒）。
   * 这条改动之后那 4 条会变成自动通过。换来的是：误点开一条普通审批不会再把
   * 会话冻住 3 分钟。想要中间值就把这里改成一个较短的固定值（比如 30 秒）。
   *
   * ## 只延长不缩短
   *
   * 反复打开页面不该把时限越推越近，也不该因为一次打开就把高危那 3 分钟
   * 砍成 10 秒。取 max。
   *
   * ## auto_decision 不变
   *
   * 延长之后你要是又走开了，高危仍然到点拒绝。变的只是「你有多久可以插手」，
   * 不是「不插手会怎样」。
   */
  extend(id, ms) {
    const ap = this.#items.get(id)
    if (!ap || ap.status !== 'pending') return null
    // 到点会通过的，延长只是拖住 Claude，没有任何人受益
    if (ap.auto_decision === OUTCOME.ALLOW && !MISSABLE_TOOLS.has(ap.tool_name)) return ap

    /**
     * **必须封顶在 570 秒。**
     *
     * 详情页每几秒 sync 一次，每次都把截止推到 now + 180s。没有天花板的话，
     * 你在那个页面上停留超过 570 秒，这条审批就永远不会自己结掉——而 570s
     * 这条线存在的全部理由（见文件顶部）就是**绝不能走到 hook 的 600s 系统
     * 超时**：那会被当成「非阻塞错误」放行到 Claude Code 自己的权限流程，
     * 终端空挂在那里等一个没人看的弹框。
     *
     * 天花板从 created_at 算，不是从现在算——它是这条 hook 连接能活多久的
     * 上限，跟你什么时候点开页面无关。
     */
    const ceiling = ap.created_at + SELF_TIMEOUT_MS
    const target = Math.min(Date.now() + Math.max(0, Number(ms) || 0), ceiling)
    if (target <= ap.expires_at) return ap // 只延长不缩短；顶到天花板后也走这条
    ap.expires_at = target

    const waiter = this.#waiters.get(id)
    if (waiter?.arm) {
      clearTimeout(waiter.timer)
      waiter.timer = waiter.arm()
    }
    this.emit('extended', ap)
    return ap
  }

  /** 幂等决策。第一个写入的赢，后到的返回当前状态而不报错。（计划 §4） */
  decide(id, decision, by = 'phone') {
    const ap = this.#items.get(id)
    if (!ap) return { ok: false, code: 'not_found' }
    if (ap.status !== 'pending') {
      return { ok: false, code: 'already_settled', approval: ap }
    }
    if (decision !== OUTCOME.ALLOW && decision !== OUTCOME.DENY) {
      return { ok: false, code: 'bad_decision' }
    }
    this.#settle(id, decision === OUTCOME.ALLOW ? 'allowed' : 'denied', by)
    return { ok: true, approval: ap }
  }

  /**
   * 回答一道 AskUserQuestion。
   *
   * ## 为什么它不是 allow，也不是普通的 deny
   *
   * AskUserQuestion 不是一次「操作」，是一道问给人的选择题。对它：
   *   · allow  = 放行工具调用 = 问题弹回 Mac 终端，手机白看一场
   *   · deny   = 拒绝，但没说你选了什么，模型只知道你不想答
   *
   * 两个都不是「回答」。缺的那一半是**内容**，而 hook 协议里唯一能带内容
   * 回去的字段是 `permissionDecisionReason`——它只在拒绝时才会回传给模型。
   *
   * 所以回答 = 拒绝这次工具调用 + 把选项写进拒绝理由。模型读到
   * 「用户在手机上选择了「X」」之后照着往下走，效果和在终端点一下一样。
   *
   * 看起来绕，但这是**在现有 hook 协议下唯一能把答案送回去的通道**。
   * 代价是这条记录在 Claude Code 那边算一次「被拒绝的工具调用」——
   * 只影响 transcript 的措辞，不影响结果。
   */
  answer(id, choices, by = 'phone') {
    const ap = this.#items.get(id)
    if (!ap) return { ok: false, code: 'not_found' }
    if (ap.status !== 'pending') return { ok: false, code: 'already_settled', approval: ap }
    if (!MISSABLE_TOOLS.has(ap.tool_name)) return { ok: false, code: 'not_answerable' }

    /**
     * 选项文本会**原样进入模型的上下文**（走 permissionDecisionReason，
     * 见 #outcomeOf）。所以它是这个系统里少数几条「外部输入 → 模型指令流」
     * 的通路之一，必须当成不可信输入处理。
     *
     * 而且这条通路的门槛很低：提交只需要该审批的深链 `?k=`，**不需要登录**
     * （见 routes/api.mjs 的 auth:'approval'）。那个 key 会出现在推送通知里。
     *
     * 三道限制，缺一不可：
     *
     *   · **条数** 8 —— 本来就有
     *   · **单条长度** 200 —— 原来完全没有。合法选项的 label 上限是 120
     *     （describe.mjs 的 askQuestions），留点余量给「其它」的自定义文本，
     *     200 足够表达一个选择，又不足以塞进一段像样的指令
     *   · **单行** —— 换行是注入真正的杠杆：它让攻击者能另起一段、伪装成
     *     新的指令块或系统提示。压成一行之后，那段文本只能是
     *     「用户在手机上选择了：「…」」这句话里的一个引号内片段
     *
     * 不做严格白名单（只允许命中已给出的 option label）是因为
     * AskUserQuestion 允许「其它」自由文本，那是正当路径。
     */
    const ONE_LINE = /[\r\n\t\u2028\u2029]+/g
    // 控制字符会在终端和日志里造成错位，顺手一起去掉
    const CTRL = /[\u0000-\u001f\u007f]/g
    const picked = (Array.isArray(choices) ? choices : [choices])
      .map((c) => String(c ?? '').replace(ONE_LINE, ' ').replace(CTRL, '').trim().slice(0, 200))
      .filter(Boolean)
      .slice(0, 8)
    if (!picked.length) return { ok: false, code: 'bad_choice' }

    // 这段文本会原样进入模型的上下文。写清楚「谁、在哪、选了什么」，
    // 别让模型把它读成一句普通的拒绝
    ap.answer = picked
    ap.decided_reason = `用户在手机上选择了：${picked.map((p) => `「${p}」`).join('、')}`
    this.#settle(id, 'answered', by)
    return { ok: true, approval: ap }
  }

  /** Claude Code 侧断开（会话被杀 / 终端自己批了）→ 标记放弃，手机上给明确提示。 */
  abandon(id) {
    const ap = this.#items.get(id)
    if (!ap || ap.status !== 'pending') return
    this.#settle(id, 'abandoned', 'abandoned')
  }

  #settle(id, status, by) {
    const ap = this.#items.get(id)
    if (!ap || ap.status !== 'pending') return
    ap.status = status
    ap.decided_by = by
    ap.decided_at = Date.now()
    this.emit('settled', ap)

    const waiter = this.#waiters.get(id)
    if (waiter) {
      clearTimeout(waiter.timer)
      this.#waiters.delete(id)
      if (status !== 'expired') waiter.resolve(this.#outcomeOf(ap))
    }
  }

  #outcomeOf(ap) {
    if (ap.status === 'allowed' || ap.status === 'auto_allowed') return { decision: OUTCOME.ALLOW, reason: null }
    if (ap.status === 'superseded') return { decision: OUTCOME.ALLOW, reason: null }
    // 回答走拒绝通道，因为 permissionDecisionReason 只在拒绝时回传给模型（见 answer()）
    if (ap.status === 'answered') return { decision: OUTCOME.DENY, reason: ap.decided_reason }
    if (ap.status === 'denied') return { decision: OUTCOME.DENY, reason: '你在手机上拒绝了这个操作' }
    if (ap.status === 'abandoned') return { decision: OUTCOME.DENY, reason: '审批已放弃' }
    return { decision: OUTCOME.DENY, reason: '审批未通过' }
  }

  /** 定期清理已结束的记录，避免内存无限增长 */
  sweep(maxAgeMs = 3600_000) {
    const cutoff = Date.now() - maxAgeMs
    for (const [id, ap] of this.#items) {
      if (ap.status !== 'pending' && (ap.decided_at ?? ap.created_at) < cutoff) this.#items.delete(id)
    }
  }
}
