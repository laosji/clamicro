import { readBody, json, text } from '../http/respond.mjs'
import { matchKey } from '../approvals.mjs'

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

export function hookRoutes(ctx) {
  const { config, store, approvals, control, inbox, history, notify, notifyApproval } = ctx

  return async function handleHooks(req, res, url, path) {
    // ---- 核心：阻塞式审批 ----
    if (req.method === 'POST' && path === '/hooks/permission-request') {
      const payload = await readBody(req)

      // 自排除：开发 clamicro 自身时，别把自己的工具调用卡住 570 秒。
      // 返回空对象 = 本 hook 无意见，走 Claude Code 正常权限流程。
      if (config.ignoreCwds.some((d) => payload.cwd?.startsWith(d))) {
        json(res, 200, {})
        return true
      }

      const ap = approvals.create({ ...payload, cwd: payload.cwd }, config.approval)
      const s = store.session(payload.session_id)
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
