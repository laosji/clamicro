import { readBody, json } from '../http/respond.mjs'
import { safeEq } from '../auth/token.mjs'

/**
 * JSON API。
 *
 * 分两段，边界很重要：
 *
 * 1. `/api/approvals/:id` —— 登录 token **或**该审批专属的 ?k= 都能进。
 *    ?k= 是为了从推送点开就能直接决策，不必先登录。它经过了推送服务商，
 *    所以作用域严格限制在这一条审批上。
 *
 * 2. 其余 `/api/*` —— 一律要登录 token。
 *
 * 加新端点时默认放进第 2 段。要放进第 1 段必须想清楚：这个端点泄露的东西，
 * 值得让一个经过第三方的凭证打开吗。
 */
export function apiRoutes(ctx) {
  const {
    config, store, approvals, control, inbox, push, saveConfig,
    auth, publicApproval, notifyApproval, sseClients, network, HERE,
  } = ctx
  const { authorized } = auth

  return async function handleApi(req, res, url, path) {
    // ---- 审批 API：Bearer token 或该审批专属的 ?k= 均可 ----
    const apiMatch = path.match(/^\/api\/approvals\/([\w-]+)(\/decide)?$/)
    if (apiMatch) {
      const ap = approvals.get(apiMatch[1])
      if (!ap) {
        json(res, 404, { error: 'not_found' })
        return true
      }
      if (!safeEq(url.searchParams.get('k'), ap.key) && !authorized(req)) {
        json(res, 403, { error: 'forbidden' })
        return true
      }
      if (req.method === 'GET' && !apiMatch[2]) {
        json(res, 200, { approval: publicApproval(ap) })
        return true
      }
      if (req.method === 'POST' && apiMatch[2]) {
        const { decision } = await readBody(req)
        const out = approvals.decide(ap.id, decision, 'phone')
        if (!out.ok && out.code === 'already_settled') {
          // 幂等：已被终端或另一入口处理过，回当前真实状态而不是报错
          json(res, 200, { ok: false, reason: 'already_settled', approval: publicApproval(ap) })
          return true
        }
        json(res, out.ok ? 200 : 400, out.ok ? { ok: true, approval: publicApproval(ap) } : { error: out.code })
        return true
      }
      json(res, 405, { error: 'method_not_allowed' })
      return true
    }

    if (!path.startsWith('/api/')) return false

    // ---- 以下一律需要 token ----
    if (!authorized(req)) {
      json(res, 401, { error: 'unauthorized' })
      return true
    }

    const say = path.match(/^\/api\/sessions\/([\w-]+)\/say$/)
    if (say && req.method === 'POST') {
      const { text } = await readBody(req)
      if (!String(text ?? '').trim()) {
        json(res, 400, { error: 'empty' })
        return true
      }
      const msg = inbox.queue(say[1], String(text).trim())
      json(res, 200, { ok: true, message: msg, queued: inbox.list(say[1]).length })
      return true
    }

    const unsay = path.match(/^\/api\/sessions\/([\w-]+)\/say\/([\w-]+)$/)
    if (unsay && req.method === 'DELETE') {
      json(res, 200, { ok: inbox.remove(unsay[1], unsay[2]) })
      return true
    }

    if (path === '/api/inbox') {
      json(res, 200, { inbox: inbox.all() })
      return true
    }

    const ctl = path.match(/^\/api\/sessions\/([\w-]+)\/(pause|resume|cancel)$/)
    if (ctl && req.method === 'POST') {
      const [, sid, action] = ctl
      const out = control[action](sid)
      store.noteControl(sid, action)
      console.log(`[control] 会话 ${sid.slice(0, 8)} → ${action}`)
      json(res, 200, { ...out, held: control.isHeld(sid) })
      return true
    }

    if (path === '/api/approvals') {
      json(res, 200, { approvals: approvals.pending().map((a) => publicApproval(a)) })
      return true
    }

    // ---- 设置：Bark key 存在手机上，就该在手机网页里填，而不是让人回终端敲命令 ----
    if (path === '/api/config' && req.method === 'GET') {
      json(res, 200, {
        barkKey: config.push.bark.key ? `${config.push.bark.key.slice(0, 4)}••••` : '',
        barkConfigured: Boolean(config.push.bark.key),
        pushEnabled: config.push.provider === 'bark',
        macNotify: config.push.macNotify,
        detailInPush: config.notify.detailInPush,
        onStop: config.notify.onStop,
        minTurnMs: config.notify.minTurnMs,
        lanIp: config.lanIp,
        autoApproveMs: config.approval.autoApproveMs,
        timeoutMs: config.approval.timeoutMs,
        autoApproveHighRisk: config.approval.autoApproveHighRisk,
        hostMode: config.hostMode,
        baseUrl: config.baseUrl,
        altUrl: config.altUrl,
        localHost: config.localHost,
        network: network(),
      })
      return true
    }

    if (path === '/api/config' && req.method === 'POST') {
      const body = await readBody(req)
      const before = config.push.provider
      // 只有显式传了非掩码、非空的 key 才动它。空串一律忽略——
      // 输入框在聚焦时会清空掩码值，失焦时会带着空串触发 change，
      // 那种情况下不该把已配置的 key 抹掉。要清除得显式传 clearKey。
      if (typeof body.barkKey === 'string' && body.barkKey.trim() && !body.barkKey.includes('•')) {
        config.push.bark.key = body.barkKey.trim()
        config.push.provider = 'bark'
      }
      if (body.clearKey === true) {
        config.push.bark.key = ''
        config.push.provider = 'none'
      }
      if (typeof body.pushEnabled === 'boolean') {
        config.push.provider = body.pushEnabled && config.push.bark.key ? 'bark' : 'none'
      }
      if (typeof body.macNotify === 'boolean') config.push.macNotify = body.macNotify
      for (const k of ['detailInPush', 'onStop']) if (typeof body[k] === 'boolean') config.notify[k] = body[k]
      if (Number.isFinite(body.minTurnMs)) config.notify.minTurnMs = Math.max(0, body.minTurnMs)
      if (Number.isFinite(body.autoApproveMs)) config.approval.autoApproveMs = Math.max(0, body.autoApproveMs)
      if (['auto', 'hostname', 'ip'].includes(body.hostMode)) {
        config.hostMode = body.hostMode
        console.log(`[config] 地址方式 → ${body.hostMode}（重启服务生效）`)
      }
      if (typeof body.autoApproveHighRisk === 'boolean') {
        config.approval.autoApproveHighRisk = body.autoApproveHighRisk
        if (body.autoApproveHighRisk) console.warn('[config] ⚠️ 高风险操作已设为自动通过')
      }
      saveConfig(config)
      // 推送通道被悄悄关掉是最难排查的故障：手机一声不响，你以为它在守着。
      // 每次变更都留痕，下次再出问题能直接对时间。
      console.log(
        before !== config.push.provider
          ? `[config] ⚠️ 推送通道 ${before} → ${config.push.provider}（来自网页设置）`
          : `[config] 已从网页更新设置`,
      )
      json(res, 200, { ok: true })
      return true
    }

    if (path === '/api/selftest/push' && req.method === 'POST') {
      await push({ title: '🔔 测试通知', body: '收到这条就说明推送通了', level: 'active', group: 'clamicro' })
      json(res, 200, { ok: true })
      return true
    }

    // 装完立刻走一遍完整流程才叫装好了
    if (path === '/api/selftest/approval' && req.method === 'POST') {
      store.session('selftest').session_name = '安装自检'
      const ap = approvals.create(
        {
          session_id: 'selftest',
          cwd: HERE,
          tool_name: 'Bash',
          tool_input: {
            command: 'echo "Clamicro 安装自检"',
            description: '这是一条测试审批，批准或拒绝都不会真的执行任何操作',
          },
          permission_rule: { action: 'Bash', behavior: 'ask' },
        },
        { ...config.approval, autoApproveMs: 0 }, // 自检不自动通过，等你真点一下
      )
      notifyApproval(ap, '安装自检').catch(() => {})
      json(res, 200, { id: ap.id, key: ap.key })
      return true
    }

    if (path === '/api/sessions') {
      json(res, 200, {
        sessions: store.sessions(),
        limits: store.accountLimits(),
        statusLineSeenAt: store.statusLineSeenAt(),
      })
      return true
    }

    const apiSess = path.match(/^\/api\/sessions\/([\w-]+)$/)
    if (apiSess && req.method === 'GET') {
      const sid = apiSess[1]
      json(res, 200, {
        session: store.sessions().find((x) => x.session_id === sid) ?? null,
        events: store.events(0, sid),
        queued: inbox.list(sid),
      })
      return true
    }

    if (path === '/api/state') {
      json(res, 200, {
        sessions: store.sessions(),
        events: store.events(Number(url.searchParams.get('since') ?? 0)),
      })
      return true
    }

    if (path === '/api/stream') {
      // 断线续传：优先用 Last-Event-ID 头（标准），其次 ?since=
      const lastId = Number(req.headers['last-event-id'] ?? url.searchParams.get('since') ?? 0)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write(`retry: 3000\n\n`)
      res.write(`event: snapshot\ndata: ${JSON.stringify({ sessions: store.sessions() })}\n\n`)
      for (const e of store.events(lastId)) {
        res.write(`id: ${e.id}\nevent: event\ndata: ${JSON.stringify(e)}\n\n`)
      }
      sseClients.add(res)
      const keepAlive = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          /* 下面的 close 会清理 */
        }
      }, 25_000)
      req.on('close', () => {
        clearInterval(keepAlive)
        sseClients.delete(res)
      })
      return true
    }

    json(res, 404, { error: 'not found' })
    return true
  }
}
