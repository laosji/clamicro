import { readBody, json, text } from '../http/respond.mjs'
import { matchKey } from '../approvals.mjs'
import { normalizeAgent, capOf } from '../agents.mjs'
import { requireDeps } from './deps.mjs'

/**
 * Claude Code hooks 的接收端。
 *
 * 这些端点**没有 token**——Claude Code 的 http hook 传自定义头很别扭。
 * 保护它们的是来源地址（只认回环，见 http/security.mjs 的 isLoopback），
 * 所以调用方必须在进入这里之前就把非回环请求挡掉。加新 hook 端点时，
 * 这条前置条件不能忘。
 */
export const HOOK_EVENTS = new Set([
  'session-start',
  'user-prompt-submit',
  'pre-tool-use',
  'post-tool-use',
  'post-tool-failure',
  'notification',
  'stop',
  'stop-failure',
  'session-end',
])

/**
 * cwd 是否落在某个自排除目录里。
 *
 * 必须按**路径分段**比，不能裸 startsWith：`/Users/me/proj` 会连
 * `/Users/me/project-x`、`/Users/me/proj-backup` 一起吞掉，而吞掉的后果是
 * 那个项目的工具调用**一条都不再走审批**——返回 {} 等于「本 hook 无意见」，
 * 直接落回 Claude Code 自己的权限流程。你以为在盯着它，其实没有，
 * 而且不会有任何提示。静默漏审批比报错难查得多。
 */
export function underIgnored(cwd, dirs) {
  if (typeof cwd !== 'string' || !cwd) return false
  return (dirs ?? []).some((d) => {
    if (typeof d !== 'string' || !d) return false
    const base = d.endsWith('/') ? d.slice(0, -1) : d
    return cwd === base || cwd.startsWith(base + '/')
  })
}

/** 终端状态栏文本。放在服务端渲染，中继脚本就不必解析 JSON（省掉 jq 依赖）。 */
function renderStatusLine(d, approvals) {
  const n = (v) => (typeof v === 'number' ? v : 0)
  const pct = (v) => `${Math.floor(n(v))}%`
  const pending = approvals.pending(d.session_id).length
  return [
    d.model?.display_name ?? '?',
    `ctx ${pct(d.context_window?.used_percentage)}`,
    `5h ${pct(d.rate_limits?.five_hour?.used_percentage)}`,
    `7d ${pct(d.rate_limits?.seven_day?.used_percentage)}`,
    `$${(Math.round(n(d.cost?.total_cost_usd) * 100) / 100).toFixed(2)}`,
    ...(pending ? [`⏳ ${pending} 条待审批`] : []),
  ].join('  ·  ')
}

/**
 * 让上报方能用 `?agent=` 说明自己是谁。
 *
 * DSH 的桥接是 JS，往 payload 里加一个字段很自然；Codex 那边是一个 shell
 * 中继脚本，而它拿到的 stdin 是 Codex 生成的 JSON——要往里塞字段就得在
 * bash 里改 JSON，那要么引入 jq（这个项目零依赖），要么手写字符串拼接
 * （在一份含模型生成内容的 JSON 上做这种事，迟早会拼坏）。
 *
 * 所以走查询参数：脚本一个字节都不用改 payload，原样转发。
 * body 里已经写了 agent 的以 body 为准——那是更明确的表达。
 */
export function adoptAgent(payload, url) {
  // 判 typeof 而不是判真假：ESM 是严格模式，给一个字符串赋属性会**抛**
  // TypeError（实测日志：Cannot create property 'agent' on string 'hello'）。
  // 上报体理应是对象，但这条路径谁都能从回环打进来，不该由它决定服务出不出错。
  if (!payload || typeof payload !== 'object') return
  if (!payload.agent) {
    const q = url?.searchParams?.get('agent')
    if (q) payload.agent = q
  }
  /**
   * 认得的值就地规范化，**认不得的也规范化**。
   *
   * 原来只有 `s.agent` 走 normalizeAgent，而下面挑应答方言时比的是**原始值**。
   * 于是一个拼错的名字（`?agent=codx`）会走出一条谁也没预料的路：会话按
   * claude-code 渲染（暂停、取消按钮都在），审批回包却是中性的
   * { decision, reason }——Claude Code 读不懂，于是那个决定被静默丢弃，
   * 落回终端询问。手机上你明明批了。
   *
   * 「同一个字段在两个地方有两种含义」是这类 bug 的温床，所以在入口处
   * 就只留一种。没写 agent 的保持没写：那是「老版本上报」，跟「写了个
   * 不认识的」不是一回事，后者该被纠正，前者不该被凭空补上。
   */
  if (payload.agent) payload.agent = normalizeAgent(payload.agent)

  /**
   * 宿主进程 PID（`?owner=`，session-start.sh 带上来的）。
   *
   * 服务靠它判「还有没有人在用」。只认查询参数、只认纯数字：这条会喂给
   * `process.kill(pid, 0)`，一个非数字就是一次抛异常，而它在的位置是
   * **每一条 hook 的必经之路**。
   */
  if (!payload.owner_pid) {
    const o = url?.searchParams?.get('owner')
    if (o && /^\d+$/.test(o)) payload.owner_pid = Number(o)
  }
}

// 对账漂移只喊一次：它一旦发生就是每次工具调用都发生，每条都喊等于没喊
let warnedMatchDrift = false
// 「这个后端没开审批」每个后端也只喊一次，理由同上
const warnedNoApprove = new Set()

export function hookRoutes(ctx) {
  requireDeps('hookRoutes', ctx, ['config', 'store', 'approvals', 'control', 'inbox', 'history', 'notify', 'notifyApproval', 'notifyHold', 'codexTail'])
  const { config, store, approvals, control, inbox, history, notify, notifyApproval, notifyHold: alertHold, codexTail } = ctx

  return async function handleHooks(req, res, url, path) {
    // ---- 核心：阻塞式审批 ----
    if (req.method === 'POST' && path === '/hooks/permission-request') {
      const payload = await readBody(req)
      adoptAgent(payload, url)

      // 自排除：开发 clamicro 自身时，别把自己的工具调用卡住 570 秒。
      // 返回空对象 = 本 hook 无意见，走 Claude Code 正常权限流程。
      if (underIgnored(payload.cwd, config.ignoreCwds)) {
        json(res, 200, {})
        return true
      }

      /**
       * 这个后端的审批还没开。
       *
       * `approve` 在能力表里躺了很久却**没有任何代码读它**——于是它写着
       * false，审批照样跑完整套：建记录、推手机、阻塞等人、回一个决定。
       * 接 Codex 时这一点变成了真问题：hooks 里接了 PermissionRequest，
       * 而 Codex 的「拒绝」线格式还没在真机上验过，等于把一条没验证过的
       * 拒绝路径直接上了生产。能力表说了不算，比没有能力表更糟。
       *
       * 回 `{}` = 本 hook 无意见，落回后端自己的权限流程（终端里问人），
       * 跟上面自排除目录那条走同一条路。**不建审批记录**：建了就会在手机上
       * 冒出一张卡片，而这个后端根本不该有审批。
       *
       * 这样那个布尔值才真的是开关——验收通过后改成 true，别处一行不用动。
       */
      if (!capOf(payload.agent).approve) {
        if (!warnedNoApprove.has(payload.agent ?? '')) {
          warnedNoApprove.add(payload.agent ?? '')
          console.warn(
            `[approval] ${payload.agent ?? '未知后端'} 的审批能力未开启，本会话的授权请求不拦截（落回它自己的权限流程）`,
          )
        }
        json(res, 200, {})
        return true
      }

      const ap = approvals.create({ ...payload, cwd: payload.cwd }, config.approval)
      const s = store.session(payload.session_id)

      /**
       * 审批这条路**也要认 agent**。
       *
       * 这里不走 applyHook，所以 agent 不会被顺带写进去。而 store.session()
       * 对没见过的 id 是**新建**——缺省 agent 是 claude-code。于是一个 DSH
       * 会话如果审批先到、session-start 后到（或者压根没到），手机上就会
       * 按 Claude Code 的能力渲染：暂停和取消按钮都在，点了没有任何反应。
       *
       * 「按钮在那儿点了没反应」正是能力矩阵要消灭的东西，不能在这条
       * 最要紧的路径上把它放回来。
       */
      /**
       * `s &&` 不能省。`store.session(undefined)` 返回的是 **null**——
       * 一条不带 session_id 的 PermissionRequest（畸形上报、将来某个适配器
       * 漏填）会在这里抛 TypeError，被外层 catch 兜成 200 {}。
       *
       * 后果不是「少认一次 agent」：抛出的位置在 `approvals.wait()` **之前**，
       * 于是审批记录已经建好、却没有任何人在等它——一条永远 pending、
       * 手机上点了也送不回去的幽灵条目，直到被 sweep 清掉。
       *
       * 下面 label 那行早就写了 `s?.`，说明这里本来就预见过 s 可能是 null，
       * 只有这一行漏了。加上之后这条路径能正常走完：markWaitingApproval
       * 自己会因为没有 sessionId 而早退，审批仍然出现在 /api/approvals 里，
       * 决定照样回得去。
       */
      if (s && payload.agent) s.agent = normalizeAgent(payload.agent)

      store.markWaitingApproval(payload.session_id, ap)

      // Claude Code 侧断开（会话被 Ctrl-C / 终端自己批了）→ 别让 waiter 悬着
      let responded = false
      req.on('close', () => {
        if (!responded) approvals.abandon(ap.id)
      })

      const label = s?.session_name || (s?.cwd ? s.cwd.split('/').filter(Boolean).pop() : '会话')
      // 会自动通过的操作不推送：手机震动、掏出来、解锁，10 秒早过去了，
      // 点开只会看到「已自动通过」——那条通知纯属噪音。
      // 它本来就是预授权，不需要惊动任何人；仪表盘开着的话仍能通过 SSE 看到并否决。
      if (ap.auto_decision === 'allow' && !config.notify.notifyAutoApproved) {
        console.log(
          `[approval] ${ap.id.slice(0, 8)} 将自动通过（${Math.round((ap.expires_at - ap.created_at) / 1000)}s），不推送`,
        )
      } else {
        notifyApproval(ap, label).catch(() => {})
      }

      const outcome = await approvals.wait(ap.id)
      responded = true
      // 只清这一条。会话上可能还挂着别的（Claude Code 会并行发起工具调用），
      // 不带 id 地清等于宣布「这个会话不再等审批了」，而它其实还卡着
      store.clearWaitingApproval(payload.session_id, ap.id)

      /**
       * 答复写出去之前先看一眼对面还在不在。
       *
       * 走到这里说明人做了决定，但决定要**送到**才算数。连接已经断了的话，
       * 下面那个 json() 是写进一个死 socket——而记录会一直写着
       * 「已拒绝 · 手机」。记下来，别让界面替一个从没生效的决定作证。
       */
      /**
       * 判据必须落在 **res** 上，不能用 req.destroyed。
       *
       * readBody() 把请求体读完之后，Node 会把可读侧自动 destroy——于是一个
       * **完全健康**的请求在这里 `req.destroyed` 就是 true（实测确认）。
       * 拿它做判据的话每一条审批都会走进这个分支、永不写响应，
       * 审批全线失效。res.destroyed 才是「socket 没了」。
       */
      if (res.destroyed || res.writableEnded) {
        approvals.noteUndelivered(ap.id)
        console.warn(
          `[approval] ${ap.id.slice(0, 8)} 的决定（${outcome.decision}）没能送达：` +
            `请求方已断开，多半是那边被 Ctrl-C 或终端关掉了`,
        )
        return true
      }

      /**
       * Codex 说的是 Claude Code 的方言，但不是同一句话。
       *
       * 它的 hook 输出同样是 `hookSpecificOutput`，字段却叫 permissionDecision
       * （Claude Code 那边这个位置是 decision），值是一个带 behavior 的对象，
       * 取值 allow / deny。这几个名字来自 Codex 二进制里的类型定义
       * （PermissionRequestDecisionWire / PermissionRequestBehaviorWire），
       * **还没在真机上对拒绝跑通过**——见 docs/codex-bridge.zh-CN.md §4。
       *
       * 所以决定同时写进响应头：中继脚本读它来决定退出码，不必解析 JSON，
       * 也就多了一条不依赖这个形状是否猜对的通路。万一 JSON 没被读懂，
       * 退出码 2 仍然能把这条操作挡下来。方向必须是这一侧——漏掉一次拒绝
       * 就是假审批。
       */
      if (payload.agent === 'codex') {
        json(res, 200, {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            permissionDecision: {
              behavior: outcome.decision,
              ...(outcome.reason ? { message: outcome.reason } : {}),
            },
            ...(outcome.reason ? { permissionDecisionReason: outcome.reason } : {}),
          },
        }, { 'X-Clamicro-Decision': outcome.decision })
        return true
      }

      /**
       * 响应形状按上报方分。
       *
       * `hookSpecificOutput` 是 Claude Code 的 hook 协议，别的后端读不懂；
       * 反过来也不能给 Claude Code 加一个裸的顶层 `decision`——那个键在
       * Claude Code 的 hook 输出里另有含义（Stop 用它做 block），加上去
       * 是在往一个已经定义好的协议里塞歧义。
       *
       * 所以：谁来的，就说谁的话。中性形状 { decision, reason } 由调用方
       * 自己映射（DSH 侧映射成 allowed-once / rejected，见 plugins/dsh-bridge）。
       */
      if (payload.agent && payload.agent !== 'claude-code') {
        json(res, 200, { decision: outcome.decision, reason: outcome.reason ?? null })
        return true
      }

      json(res, 200, {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: outcome.decision },
          ...(outcome.reason ? { permissionDecisionReason: outcome.reason } : {}),
        },
      })
      return true
    }

    if (req.method === 'POST' && path.startsWith('/hooks/')) {
      const event = path.slice('/hooks/'.length)
      if (!HOOK_EVENTS.has(event)) {
        json(res, 404, { error: `unknown hook event: ${event}` })
        return true
      }

      const payload = await readBody(req)
      adoptAgent(payload, url)

      /**
       * Codex 的会话要额外跟读它的 rollout 文件。
       *
       * 理由见 src/codex-tail.mjs：Codex **没有回合级的结束事件**，光靠
       * hooks 的话会话收到 user-prompt-submit 之后就永远停在「运行中」。
       *
       * 挂在这里而不是 applyHook 里：状态机该是纯的，起停一个轮询器是副作用。
       * 只对 codex 做——Claude Code 有 Stop，不需要，也不该去读它的目录。
       */
      if (payload.agent === 'codex') {
        /**
         * 认**任何一条** codex 事件，不只是 session-start。
         *
         * 只认 session-start 的话，有一整类会话永远跟不上：**服务启动之前
         * 就已经开着的那些**。SessionStart 一个会话只发一次，服务重启后
         * 那条早就过去了，之后只会收到 prompt / pre-tool-use。
         *
         * 而这在生产里是常态而非例外——自愈重启、改配置重启、机器睡醒。
         * 真机上就是这么撞到的：服务 16:19:45 重启，会话 16:20:13 发来
         * prompt，卡片从此停在「运行中」，因为没人在跟读它。
         *
         * follow 是幂等的，所以每条事件都调一次没有代价。
         */
        if (event === 'session-end') codexTail.unfollow(payload.session_id)
        else codexTail.follow(payload.session_id)
      }

      // 同一次工具调用开始执行 = 这次授权已在别处放行（终端弹框、权限规则、
      // acceptEdits 模式…），把还挂着的那条审批销掉，别让它在界面上冒充「待处理」。
      // 对账用 matchKey 而非 tool_use_id —— PermissionRequest 的 payload 里没有它。
      if (event === 'pre-tool-use' || event === 'post-tool-use') {
        const gone = approvals.supersede(matchKey(payload.session_id, payload.tool_name, payload.tool_input))
        if (gone) console.log(`[approval] ${gone.id.slice(0, 8)} 已在别处放行，销掉挂起记录`)
        /**
         * 对不上账要**说出来**。
         *
         * match_key 是 (session_id, tool_name, tool_input) 的逐字哈希。它成立的
         * 前提是 PermissionRequest 和 PreToolUse 收到的 tool_input **完全相同**
         * ——今天确实如此（见 approvals.supersede 的注释，那里逐字段比对过），
         * 但这是 Claude Code 的实现细节，不是它承诺的契约。哪天它在权限阶段
         * 多注入一个字段，哈希就再也对不上。
         *
         * 那时的表现是：同一次工具调用**已经在跑了**，而手机上那条还挂着
         * 「待审批」，一直挂到超时被自动拒绝——一个已经执行完的操作，
         * 界面告诉你「已拒绝」。没有任何报错，只有一条看不懂的记录。
         *
         * 不去放宽对账键：放宽意味着可能配错，而 supersede 的结果是 **allow**
         * ——配错等于替另一条审批自动放行，那比幽灵条目危险得多。
         * 所以只做检测：同会话同工具还挂着待审批、却没对上号，就是漂移的信号。
         */
        if (!gone && payload.session_id) {
          const orphan = approvals.pending(payload.session_id)
            .find((a) => a.tool_name === payload.tool_name)
          if (orphan && !warnedMatchDrift) {
            warnedMatchDrift = true
            console.warn(
              `[approval] ${orphan.id.slice(0, 8)}（${payload.tool_name}）已经开始执行，但对账键没匹配上。\n` +
              `           多半是 Claude Code 改了权限阶段的 tool_input 字段，match_key 逐字哈希因此失配。\n` +
              `           后果：这条会一直显示「待审批」直到超时，而操作其实已经跑了。\n` +
              `           见 src/approvals.mjs 的 supersede 注释。`,
            )
          }
        }
      }

      // Pause/Cancel 的拦截点。Claude Code 没有运行时暂停原语，
      // 只能在下一个工具调用前把它挂住。
      if (event === 'pre-tool-use' && payload.session_id) {
        store.applyHook(event, payload, config.notify)
        // 传这一轮的标识：上一轮遗留的取消不该动这一轮的第一条命令
        const gated = await control.gate(payload.session_id, {
          turnKey: store.session(payload.session_id)?.turn_started_at ?? null,
        })
        if (gated) {
          store.noteControl(payload.session_id, gated.continue === false ? 'cancelled' : 'resumed')
          json(res, 200, gated)
          return true
        }
        json(res, 200, {})
        return true
      }
      if (event === 'session-end' && payload.session_id) {
        control.forget(payload.session_id)
      }

      // 手机发来的消息在这里注入。Stop 的 decision:block 会阻止 Claude 停下，
      // 并把 reason 当作输入让对话继续——这是 hooks 里唯一能「往里发」的口子。
      /**
       * `!res.destroyed` 这一层和审批那边的 res 检查是同一件事。
       *
       * drain() 是**破坏性**的：队列清空、noteInbox 记一笔「已注入」，
       * 而消息能不能到，全看后面那个还没写的响应。对面在 stop 这一刻被
       * Ctrl-C 或者终端被关掉，文字就没了，而手机上显示已送达。
       *
       * 断了就别动队列——消息留着，手机上看得见，下一轮再送。
       * 留着比消失好。
       */
      if (event === 'stop' && payload.session_id && capOf(payload.agent).inbox && !res.destroyed) {
        /**
         * `capOf(...).inbox` 这一层是**在伤害发生的那一点**再拦一次。
         *
         * 入口（/api/sessions/:id/say）已经按能力挡住了，所以正常情况下
         * 不支持注入的后端队列永远是空的。但万一有东西进去了（旧版本排的、
         * 将来某条新路径），走到这里的后果是队列被排空、记一笔「已注入」，
         * 而 decision:block 那个回包只有 Claude Code 读得懂——文字就没了。
         *
         * 拦住的话，消息**留在队列里**，手机上看得见。留着比消失好。
         */
        let pending = inbox.drain(payload.session_id)

        /**
         * 队列空、但人打开了「等我回话」——**把这次 Stop 挂住**，别急着回。
         *
         * 这是「它在等你回话时能不能从手机回一句」唯一的落点。放行之后
         * Claude Code 就停在终端的提示符上了，而那之后再没有任何 hook 会
         * 触发（`Notification: idle_prompt` 是单向的，它不等回包）——你在
         * 手机上打的字将没有任何东西可以搭载。
         *
         * 挂起最多 90 秒（Inbox.HOLD_MS），期间手机上发出的消息会就地送达；
         * 没等到就照常放行，会话正常停下，和没有这个功能时一模一样。
         */
        if (!pending && inbox.isArmed(payload.session_id)) {
          console.log(`[inbox] 会话 ${payload.session_id.slice(0, 8)} 挂住 Stop，等手机回话`)
          if (alertHold) alertHold(payload.session_id).catch(() => {})
          pending = await inbox.hold(payload.session_id)
        }

        /*
         * `!res.destroyed` **要在 await 之后再看一次**。
         *
         * 上面那次检查发生在挂起之前，而挂起可以持续 90 秒——这中间对面被
         * Ctrl-C、终端被关掉都是常事。drain 已经是破坏性的（队列清空、记一笔
         * 「已注入」），再往一个死掉的响应上写，结果就是消息没了而手机上
         * 显示已送达。这正是原来那段注释在防的事，只是现在多了一段等待。
         */
        if (pending && res.destroyed) {
          console.log(`[inbox] 会话 ${payload.session_id.slice(0, 8)} 等到了回话，但连接已断——消息退回队列`)
          inbox.requeue(payload.session_id, pending)
          return true
        }

        if (pending) {
          store.noteInbox(payload.session_id, pending)
          console.log(`[inbox] 会话 ${payload.session_id.slice(0, 8)} 注入 ${pending.count} 条消息`)
          json(res, 200, { decision: 'block', reason: pending.text })
          return true
        }
      }

      // 别把它也叫 notify —— 会遮蔽上面注入的通知函数
      const { body, notify: alert } = store.applyHook(event, payload, config.notify)

      // 关键：HTTP hook 不支持 async:true，会阻塞工具调用，所以先回包再提醒
      json(res, 200, body)
      if (alert) notify(alert).catch(() => {})
      return true
    }

    if (req.method === 'POST' && path === '/statusline') {
      const payload = await readBody(req)
      /**
       * statusLine 也带宿主 pid（`?owner=`，见 bin/statusline.sh）。
       *
       * SessionStart 那条**一个会话只发一次**，服务重启后就再也收不到——
       * 而 lifecycle 曾经把「一无所知」当成「没人在用」把自己关掉。
       * 这条每回合都来，重启后一个回合就重新认识宿主。
       *
       * 只认纯数字：它要喂给 `process.kill(pid, 0)`，一个非数字就是一次抛异常，
       * 而这里是每次状态栏渲染的必经之路。
       */
      const owner = url.searchParams.get('owner')
      if (owner && /^\d+$/.test(owner)) store.noteOwner(Number(owner))
      const warn = store.applyStatusLine(payload, { quotaWarnPct: config.notify.quotaWarnPct })
      history.touch()
      if (warn) notify(warn).catch(() => {})
      // ?render=1：把状态栏文本渲染好回给中继脚本
      if (url.searchParams.get('render')) {
        text(res, 200, renderStatusLine(payload, approvals))
        return true
      }
      json(res, 200, {})
      return true
    }

    return false
  }
}
