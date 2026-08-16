import { readBody, json, text } from '../http/respond.mjs'
import { matchKey } from '../approvals.mjs'
import { normalizeAgent } from '../agents.mjs'
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

// 对账漂移只喊一次：它一旦发生就是每次工具调用都发生，每条都喊等于没喊
let warnedMatchDrift = false

export function hookRoutes(ctx) {
  requireDeps('hookRoutes', ctx, ['config', 'store', 'approvals', 'control', 'inbox', 'history', 'notify', 'notifyApproval'])
  const { config, store, approvals, control, inbox, history, notify, notifyApproval } = ctx

  return async function handleHooks(req, res, url, path) {
    // ---- 核心：阻塞式审批 ----
    if (req.method === 'POST' && path === '/hooks/permission-request') {
      const payload = await readBody(req)

      // 自排除：开发 clamicro 自身时，别把自己的工具调用卡住 570 秒。
      // 返回空对象 = 本 hook 无意见，走 Claude Code 正常权限流程。
      if (underIgnored(payload.cwd, config.ignoreCwds)) {
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
      if (payload.agent) s.agent = normalizeAgent(payload.agent)

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
      store.clearWaitingApproval(payload.session_id)

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
        const gated = await control.gate(payload.session_id)
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
      if (event === 'stop' && payload.session_id) {
        const pending = inbox.drain(payload.session_id)
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
