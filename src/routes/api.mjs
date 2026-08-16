import { readBody, json } from '../http/respond.mjs'
import { safeEq } from '../auth/token.mjs'
import { requireDeps } from './deps.mjs'
import { MAX_APPROVAL_TIMEOUT_MS, MIN_APPROVAL_TIMEOUT_MS } from '../config.mjs'
import { notifyHealth } from '../notify.mjs'
import { AGENTS, capOf, detectAgents } from '../agents.mjs'

/**
 * 审批结束后，那条深链 `?k=` 还能用多久。
 *
 * 只为一件事留：点完批准/拒绝之后，结果页要再拉一次来显示结局。
 * 两分钟远远够，而且离「24 小时」有数量级的差距——那才是这个常量要修掉的东西。
 */
const SETTLED_KEY_GRACE_MS = (() => {
  // 环境变量只为测试留：等两分钟才能验一条断言，那条断言迟早会被删掉。
  // 夹在 [0, 10 分钟]：调大也不该让这把钥匙变成长期凭证
  const want = Number(process.env.CLAMICRO_SETTLED_KEY_GRACE_MS)
  return Number.isFinite(want) && want >= 0 ? Math.min(want, 600_000) : 120_000
})()

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
        const body = await readBody(req)
        /**
         * `choices` 在场 = 这是在回答一道 AskUserQuestion，不是批准一次操作。
         *
         * 走单独的入口而不是复用 decision='deny'：对外的语义必须是「回答」。
         * 内部确实是靠拒绝通道把文本带回模型的（见 approvals.answer 的注释），
         * 但那是协议限制下的实现细节，不该渗到 API 上——否则下一个读这段代码
         * 的人会以为手机上点一个选项等于拒绝了 Claude。
         */
        const out = body?.choices !== undefined
          ? approvals.answer(approval.id, body.choices, 'phone')
          : approvals.decide(approval.id, body?.decision, 'phone')

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
        // 每个后端最后一次上报的时间。用来区分「这个后端没有会话」和
        // 「这个后端已经不上报了」——两者在列表上长得一样，处置完全相反
        agentsSeen: store.agentsSeen(),
        // 首页分区的排序依据：谁先连上谁在前。见 store.agentsFirstSeen 的注释
        agentsFirstSeen: store.agentsFirstSeen(),
      }),
    },
    {
      method: 'GET', path: /^\/api\/sessions\/([\w-]+)$/, auth: 'token',
      handler: ({ res, params: [sid] }) => {
        const session = store.sessions().find((x) => x.session_id === sid) ?? null
        json(res, 200, {
          session,
          // 能力随会话一起给：详情页每次刷新都要它来决定暂停/取消给不给，
          // 单独再拉一次 /api/config 是白白多一个来回，而且两次响应之间
          // 还能不一致
          cap: capOf(session?.agent),
          events: store.events(0, sid),
          queued: inbox.list(sid),
        })
      },
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
        // 队列满了要**当场说**。静默丢掉一条用户明确要发的指令，
        // 比拒绝它糟得多——他会以为发出去了，然后等一个永远不来的回应
        if (!msg) {
          return json(res, 409, {
            error: 'inbox_full',
            queued: inbox.list(sid).length,
            hint: '这个会话已经排了很多条还没送达。消息只在它跑完下一轮时才注入——先去终端里让它跑一轮，或者删掉几条。',
          })
        }
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
    /**
     * 这个响应是**手写白名单**，不是把 config 摊开。
     *
     * 别改成 `json(res, 200, config)` 图省事：那样主令牌和每台设备的令牌会跟着
     * 每一次设置页加载一起发出去。这个接口有鉴权，但「存起来的凭证不该被读接口
     * 原样吐出来」是一条独立的纪律，不能靠「反正有权限保护」兜底——权限那层
     * 出问题的时候，正是你最需要凭证还没泄露的时候。
     *
     * test/api-secrets.test.mjs 钉着这件事：加新字段时如果顺手把令牌带出来，
     * 那条测试会红。
     */
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
        // 后端能力矩阵。全是静态布尔，不含凭证。
        // 由服务端下发而不是让网页硬编码：网页是缓存得最久的那一层，
        // 能力表跟着服务端版本走，才不会出现「服务端已支持、手机上还是灰的」。
        agents: AGENTS,
        // 本机装了哪些后端。是个**数组**——多个后端同时在用是常态，不是边界情况。
        // 只用来决定空状态的文案；谁在跑以上报为准，见 src/agents.mjs 的注释
        detectedAgents: detectAgents(),
        // 提醒通道的健康状况。全是计数和错误文本，不含任何凭证。
        // 通道死掉时，高危审批会全部走到超时被拒、普通审批会照常自动放行，
        // 而你收不到任何一条——这个字段是唯一能让那件事浮出来的东西
        notifyHealth: notifyHealth(),
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
        const byKey = safeEq(url.searchParams.get('k'), approval.key)
        /**
         * `?k=` 在审批**结束之后**很快就失效。
         *
         * README 承诺的是「a leaked deep link can only decide that one approval,
         * **and expires with it**」。而实现里这个 key 的有效期实际上跟着
         * 记录走——记录要到 24 小时后的 sweep 才清掉。也就是说：一条被转发
         * 出去的深链（它会进聊天记录、进浏览器历史），在那次审批早就结束之后，
         * 还能读整整一天的**完整命令原文**（publicApproval 里的 detail 和 cwd）。
         * 决定是决定不了了，但「能读」本身就超出了承诺。
         *
         * 留一小段宽限期而不是当场作废：手机上点完批准/拒绝，结果页还要用
         * 这个 key 再拉一次来显示结局。当场失效的话，用户点完看到的是一个
         * 错误页——那会让人以为操作没成功。
         *
         * 登录令牌不受影响：已配对的设备本来就该能翻历史。这里收紧的只是
         * 那把**能被转发出去**的单条钥匙。
         */
        const settledAgo = approval.decided_at ? Date.now() - approval.decided_at : 0
        if (byKey && approval.status !== 'pending' && settledAgo > SETTLED_KEY_GRACE_MS) {
          return json(res, 403, { error: 'expired', reason: '这条审批已经结束，链接失效了' }), true
        }
        if (!byKey && !authorized(req)) {
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
