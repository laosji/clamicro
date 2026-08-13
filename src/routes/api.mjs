import { readBody, json } from '../http/respond.mjs'
import { safeEq } from '../auth/token.mjs'
import { requireDeps } from './deps.mjs'
import { MAX_APPROVAL_TIMEOUT_MS, MIN_APPROVAL_TIMEOUT_MS } from '../config.mjs'

/**
 * JSON API 路由表。
 *
 * 为什么是表而不是 if 链：**认证不能靠代码顺序维持**。
 * 之前的写法里，「以下一律需要 token」是一条写在中间的 if，谁在它上面
 * 加一个 handler，那个端点就是裸的——没有任何东西会报错，代码看着也正常。
 * 现在 auth 是每条路由必填的字段，漏了在启动时就抛。
 *
 * 两种认证：
 *
 *   'token'    —— 登录令牌。默认就该用这个。
 *   'approval' —— 登录令牌**或**该审批专属的 ?k=。?k= 是为了从通知点开
 *                 就能直接决策，不必先登录，所以作用域严格限制在这一条
 *                 审批上。加新端点时想清楚：这个端点泄露的东西，值得让
 *                 一个能被转发的链接打开吗。不确定就用 'token'。
 */
export function apiRoutes(ctx) {
  requireDeps('apiRoutes', ctx, ['config', 'store', 'approvals', 'control', 'inbox', 'notify', 'saveConfig', 'auth', 'publicApproval', 'notifyApproval', 'sseClients', 'network', 'HERE'])
  const {
    config, store, approvals, control, inbox, notify, saveConfig,
    auth, publicApproval, notifyApproval, sseClients, network, HERE,
  } = ctx
  const { authorized } = auth

  /**
   * @param method  HTTP 方法
   * @param path    字符串（全等）或正则（捕获组进 params）
   * @param auth    'token' | 'approval'，必填
   * @param handler ({ req, res, url, params, approval }) => void
   */
  const ROUTES = [
    // ---- 审批：?k= 可进 ----
    {
      // 详情页每隔几秒会 sync 一次这条。它和「打开页面」是同一个信号：
      // 有人正盯着这一条，那就不该在他读命令的时候自己通过掉
      method: 'GET', path: /^\/api\/approvals\/([\w-]+)$/, auth: 'approval',
      handler: ({ res, approval }) => {
        approvals.extend(approval.id, config.approval?.timeoutMs ?? 180_000)
        json(res, 200, { approval: publicApproval(approval) })
      },
    },
    {
      method: 'POST', path: /^\/api\/approvals\/([\w-]+)\/decide$/, auth: 'approval',
      handler: async ({ req, res, approval }) => {
        const { decision } = await readBody(req)
        const out = approvals.decide(approval.id, decision, 'phone')
        if (!out.ok && out.code === 'already_settled') {
          // 幂等：已被终端或另一入口处理过，回当前真实状态而不是报错
          json(res, 200, { ok: false, reason: 'already_settled', approval: publicApproval(approval) })
          return
        }
        json(res, out.ok ? 200 : 400, out.ok ? { ok: true, approval: publicApproval(approval) } : { error: out.code })
      },
    },

    // ---- 会话 ----
    {
      method: 'GET', path: '/api/sessions', auth: 'token',
      handler: ({ res }) => json(res, 200, {
        sessions: store.sessions(),
        limits: store.accountLimits(),
        statusLineSeenAt: store.statusLineSeenAt(),
      }),
    },
    {
      method: 'GET', path: /^\/api\/sessions\/([\w-]+)$/, auth: 'token',
      handler: ({ res, params: [sid] }) => json(res, 200, {
        session: store.sessions().find((x) => x.session_id === sid) ?? null,
        events: store.events(0, sid),
        queued: inbox.list(sid),
      }),
    },
    {
      method: 'POST', path: /^\/api\/sessions\/([\w-]+)\/(pause|resume|cancel)$/, auth: 'token',
      handler: ({ res, params: [sid, action] }) => {
        const out = control[action](sid)
        store.noteControl(sid, action)
        console.log(`[control] 会话 ${sid.slice(0, 8)} → ${action}`)
        json(res, 200, { ...out, held: control.isHeld(sid) })
      },
    },

    // ---- 从手机往 Claude 发话 ----
    {
      method: 'POST', path: /^\/api\/sessions\/([\w-]+)\/say$/, auth: 'token',
      handler: async ({ req, res, params: [sid] }) => {
        const { text } = await readBody(req)
        if (!String(text ?? '').trim()) return json(res, 400, { error: 'empty' })
        const msg = inbox.queue(sid, String(text).trim())
        json(res, 200, { ok: true, message: msg, queued: inbox.list(sid).length })
      },
    },
    {
      method: 'DELETE', path: /^\/api\/sessions\/([\w-]+)\/say\/([\w-]+)$/, auth: 'token',
      handler: ({ res, params: [sid, mid] }) => json(res, 200, { ok: inbox.remove(sid, mid) }),
    },
    {
      method: 'GET', path: '/api/inbox', auth: 'token',
      handler: ({ res }) => json(res, 200, { inbox: inbox.all() }),
    },
    {
      method: 'GET', path: '/api/approvals', auth: 'token',
      /**
       * 除了待审批，还回**刚刚因超时被自动拒绝**的那些。
       *
       * 这条信息用户以前完全无从得知：你走开二十分钟，某个高危操作等到
       * 超时被拒、那一轮任务因此失败——回到手机上，界面干干净净，什么
       * 痕迹都没有。「在你不在时替你做了决定」是这个工具最该说出口的事，
       * 藏起来等于假装它没发生。
       *
       * 只回 30 分钟内的：再久就不是「刚才」，翻历史更合适。
       */
      handler: ({ res }) => json(res, 200, {
        approvals: approvals.pending().map((a) => publicApproval(a)),
        recentlyExpired: approvals
          .all()
          .filter((a) => a.status === 'expired' && a.decided_at && Date.now() - a.decided_at < 1_800_000)
          .sort((x, y) => y.decided_at - x.decided_at)
          .slice(0, 5)
          .map((a) => publicApproval(a)),
      }),
    },

    // ---- 设置：能在手机网页里改的，就别让人回终端敲命令 ----
    {
      method: 'GET', path: '/api/config', auth: 'token',
      handler: ({ res }) => json(res, 200, {
        macNotify: config.notify.macNotify,
        onStop: config.notify.onStop,
        notifyAutoApproved: config.notify.notifyAutoApproved,
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
      }),
    },
    {
      method: 'POST', path: '/api/config', auth: 'token',
      handler: async ({ req, res }) => {
        const body = await readBody(req)
        const before = config.notify.macNotify
        for (const k of ['macNotify', 'onStop', 'notifyAutoApproved']) {
          if (typeof body[k] === 'boolean') config.notify[k] = body[k]
        }
        if (Number.isFinite(body.minTurnMs)) config.notify.minTurnMs = Math.max(0, body.minTurnMs)
        if (Number.isFinite(body.autoApproveMs)) config.approval.autoApproveMs = Math.max(0, body.autoApproveMs)
        if (Number.isFinite(body.timeoutMs)) {
          // 必须夹住。用户把等待时间拉到 10 分钟，得到的不是「等更久」而是
          // 「审批失效」——超过 hook 的 600s 系统超时后，Claude Code 会把它当成
          // 非阻塞错误放行到正常权限流程，且不报任何错。见 MAX_APPROVAL_TIMEOUT_MS。
          const want = body.timeoutMs
          config.approval.timeoutMs = Math.min(
            MAX_APPROVAL_TIMEOUT_MS,
            Math.max(MIN_APPROVAL_TIMEOUT_MS, want),
          )
          if (config.approval.timeoutMs !== want) {
            console.warn(
              `[config] 等待时长 ${Math.round(want / 1000)}s 超出范围，已夹到 ${Math.round(config.approval.timeoutMs / 1000)}s`,
            )
          }
        }
        if (['auto', 'hostname', 'ip'].includes(body.hostMode)) {
          config.hostMode = body.hostMode
          console.log(`[config] 地址方式 → ${body.hostMode}（重启服务生效）`)
        }
        if (typeof body.autoApproveHighRisk === 'boolean') {
          config.approval.autoApproveHighRisk = body.autoApproveHighRisk
          if (body.autoApproveHighRisk) console.warn('[config] ⚠️ 高风险操作已设为自动通过')
        }
        saveConfig(config)
        // 提醒被悄悄关掉是最难排查的故障：一声不响，你以为它在守着。
        // 每次变更都留痕，下次再出问题能直接对时间。
        console.log(
          before !== config.notify.macNotify
            ? `[config] ⚠️ 本机通知 ${before ? '开' : '关'} → ${config.notify.macNotify ? '开' : '关'}（来自网页设置）`
            : `[config] 已从网页更新设置`,
        )
        json(res, 200, { ok: true })
      },
    },

    // ---- 自检：装完立刻走一遍完整流程才叫装好了 ----
    {
      method: 'POST', path: '/api/selftest/notify', auth: 'token',
      handler: async ({ res }) => {
        await notify({ title: 'Clamicro', subtitle: '测试通知', body: '看到这条就说明提醒是通的' })
        json(res, 200, { ok: true })
      },
    },
    {
      method: 'POST', path: '/api/selftest/approval', auth: 'token',
      handler: ({ res }) => {
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
      },
    },

    // ---- 状态推送 ----
    /*
     * /api/state 删掉了（1.0.0 时代的遗物）。
     *
     * 它是**还没有 SSE 之前**的合并轮询端点，返回 {sessions, events}。两半
     * 现在各有归宿，而且都更好：
     *   sessions → /api/sessions，返回内容逐字相同，还多给 limits 和
     *              statusLineSeenAt
     *   events   → /api/stream，连 ?since= 游标语义都被 Last-Event-ID 接走了
     *
     * 全仓库历史上没有任何 UI 引用过它，文档也没承诺过。留着的代价是实打实
     * 的：它 since=0 时**不设上限**地吐出全部事件（实测 481KB），谁哪天顺手
     * 调一下就是这个量。
     */
    {
      method: 'GET', path: '/api/stream', auth: 'token',
      handler: ({ req, res, url }) => {
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
      },
    },
  ]

  // 启动时就查，而不是等某条路由被访问到才发现它是裸的
  for (const r of ROUTES) {
    if (r.auth !== 'token' && r.auth !== 'approval') {
      throw new Error(`apiRoutes: 路由 ${r.method} ${r.path} 的 auth 非法（${r.auth}）——每条路由都必须显式声明认证方式`)
    }
  }

  const matchPath = (r, path) =>
    typeof r.path === 'string' ? (r.path === path ? [] : null) : (path.match(r.path)?.slice(1) ?? null)

  return async function handleApi(req, res, url, path) {
    if (!path.startsWith('/api/')) return false

    let pathMatched = false
    for (const r of ROUTES) {
      const params = matchPath(r, path)
      if (!params) continue
      pathMatched = true
      if (r.method !== req.method) continue

      // 认证在这里统一做，handler 里不需要也不应该再判一次
      let approval
      if (r.auth === 'approval') {
        approval = approvals.get(params[0])
        if (!approval) return json(res, 404, { error: 'not_found' }), true
        if (!safeEq(url.searchParams.get('k'), approval.key) && !authorized(req)) {
          return json(res, 403, { error: 'forbidden' }), true
        }
      } else if (!authorized(req)) {
        return json(res, 401, { error: 'unauthorized' }), true
      }

      await r.handler({ req, res, url, params, approval })
      return true
    }

    // 路径对了但方法不对 → 405，比 404 好排查（尤其是手写 curl 的时候）
    json(res, pathMatched ? 405 : 404, { error: pathMatched ? 'method_not_allowed' : 'not found' })
    return true
  }
}
