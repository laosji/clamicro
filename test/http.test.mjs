/**
 * HTTP 层的特征测试。
 *
 * 写在把 server.mjs 拆进 src/ **之前**：900 行里一行测试都没有，
 * 直接重构等于闭着眼睛搬。这些用例钉住的是当前的对外行为，
 * 重构后必须原样通过——它们不描述实现，只描述契约。
 *
 * 重点在安全边界上：鉴权、Host 白名单、CSP、cookie 属性、注入转义。
 * 这些地方出错不会报错，只会悄悄少一层防护。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './helpers/server.mjs'

let S
before(async () => { S = await startServer({ port: 8791 }) })
after(async () => { await S?.stop() })

// ---------------------------------------------------------------------------
test('healthz 不泄露内部状态', async () => {
  const r = await S.get('/healthz', { raw: true })
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.ok, true)
  assert.equal(typeof body.stale, 'boolean')
  // 未认证的探测者不需要知道你在跑几个任务
  assert.ok(!('sessions' in body) && !('approvals' in body), `不该泄露: ${JSON.stringify(body)}`)
})

test('Host 白名单挡 DNS rebinding', async (t) => {
  // 必须用 S.raw：fetch 会忽略调用方设置的 Host（forbidden header name）
  await t.test('伪造 Host 被拒', async () => {
    assert.equal((await S.raw('/healthz', { host: 'evil.com' })).status, 403)
  })
  await t.test('重绑到本机 IP 的经典手法也被拒', async () => {
    assert.equal((await S.raw('/healthz', { host: 'attacker.example:8791' })).status, 403)
  })
  await t.test('带端口的合法 Host 放行', async () => {
    assert.equal((await S.raw('/healthz', { host: '127.0.0.1:8791' })).status, 200)
  })
  await t.test('大小写不敏感（LocalHostName 可能是混合大小写）', async () => {
    assert.equal((await S.raw('/healthz', { host: 'LOCALHOST:8791' })).status, 200)
  })

  /**
   * 畸形 Host **不能把进程带走**。
   *
   * `new URL('/healthz', 'http://[')` 抛 ERR_INVALID_URL，而那一行原来裸奔在
   * handler 的 try 外面——同步抛出 = uncaughtException = 进程当场退出。
   *
   * 它的位置比这一节测的所有闸门都靠前：Host 白名单、isLoopback、令牌，
   * 一道都拦不住。也就是说任何能对端口开一条 TCP 的人（信任网络下是整个
   * 局域网，开着隧道时是整个公网）发四个字节就能杀掉服务，而服务一走，
   * 正挂着的阻塞审批全部断线。
   *
   * 断言必须包含**之后还活着**这一条：只断言这一条请求回了 400 的话，
   * 进程在响应写出去之后才死一样能通过。
   */
  await t.test('畸形 Host 回 400，且服务还活着', async () => {
    for (const host of ['[', '[::1', 'a b', '%%']) {
      const r = await S.raw('/healthz', { host }).catch((e) => ({ status: `ERR ${e.code ?? e.message}` }))
      assert.equal(r.status, 400, `Host: ${host} 应该被拒成 400`)
    }
    assert.equal((await S.raw('/healthz', { host: '127.0.0.1:8791' })).status, 200, '进程被畸形 Host 打死了')
  })
})

test('安全响应头', async () => {
  const r = await S.get('/healthz', { raw: true })
  const csp = r.headers.get('content-security-policy')
  assert.ok(csp, '必须有 CSP')
  assert.match(csp, /frame-ancestors 'none'/, '挡点击劫持：否则审批页能被嵌进 iframe 诱导滑动')
  assert.match(csp, /base-uri 'none'/)
  assert.match(csp, /form-action 'none'/)
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer')
})

test('鉴权', async (t) => {
  await t.test('/api/* 无 token → 401', async () => {
    assert.equal((await S.get('/api/sessions', { raw: true })).status, 401)
    assert.equal((await S.get('/api/approvals', { raw: true })).status, 401)
  })
  await t.test('错误的 token → 401', async () => {
    const r = await S.get('/api/sessions', { raw: true, headers: { Authorization: 'Bearer wrong' } })
    assert.equal(r.status, 401)
  })
  await t.test('长度相同但内容不同的 token → 401', async () => {
    const fake = 'x'.repeat(S.token.length)
    const r = await S.get('/api/sessions', { raw: true, headers: { Authorization: `Bearer ${fake}` } })
    assert.equal(r.status, 401)
  })
  await t.test('正确 token → 200', async () => {
    assert.equal((await S.get('/api/sessions')).status, 200)
  })
  await t.test('每一条 /api/* 都要 token —— 不能有漏网的', async () => {
    // 路由表把 auth 变成了每条路由的必填字段，但「必填」只保证写了，
    // 不保证写对。这里挨个打一遍，是唯一能证明没有裸端点的办法。
    const guarded = [
      ['GET', '/api/sessions'], ['GET', '/api/sessions/abc'], ['GET', '/api/approvals'],
      ['GET', '/api/inbox'], ['GET', '/api/config'], ['POST', '/api/config'],
      ['GET', '/api/stream'],
      ['POST', '/api/sessions/abc/say'], ['DELETE', '/api/sessions/abc/say/x'],
      ['POST', '/api/sessions/abc/pause'], ['POST', '/api/sessions/abc/resume'],
      ['POST', '/api/sessions/abc/cancel'],
      ['POST', '/api/selftest/notify'], ['POST', '/api/selftest/approval'],
    ]
    for (const [method, p] of guarded) {
      const r = await S.raw(p, { method })
      assert.equal(r.status, 401, `${method} ${p} 没有拦住未认证请求`)
    }
  })
  await t.test('未登录访问 /ui → 401 且给配对页', async () => {
    const r = await S.get('/ui', { raw: true })
    assert.equal(r.status, 401)
    assert.match(r.headers.get('content-type') ?? '', /text\/html/)
  })
})

test('token 换 cookie：URL 里不留 token', async (t) => {
  const r = await S.get(`/ui?t=${S.token}`, { raw: true })
  await t.test('302 跳到干净的 /ui', () => {
    assert.equal(r.status, 302)
    assert.equal(r.headers.get('location'), '/ui')
  })
  const cookie = r.headers.get('set-cookie') ?? ''
  await t.test('HttpOnly', () => assert.match(cookie, /HttpOnly/))
  await t.test('有效期是 30 天而不是一年', () => {
    // 这个 cookie 能批准 rm -rf 和读 ~/.ssh。一年的有效期对这种权限太长，
    // 而重新扫码只要几秒。令牌本身可以用 clamicro rotate-token 立刻作废。
    const m = /Max-Age=(\d+)/.exec(cookie)
    assert.ok(m, 'cookie 必须带 Max-Age')
    const days = Number(m[1]) / 86400
    assert.ok(days <= 31, `有效期 ${days} 天，太长了`)
    assert.ok(days >= 7, `有效期 ${days} 天，短到每周都要重扫，会逼用户放弃`)
  })

  await t.test('SameSite=Lax 而不是 Strict', () => {
    // 从别的 App 点链接进 Safari（备忘录里存的地址、Mac 上弹的二维码）
    // 属于跨站导航，Strict 的 cookie 不会被带上，表现是每次都像没登录过。
    // Lax 放行顶层 GET 导航，跨站 POST 仍拦住。
    assert.match(cookie, /SameSite=Lax/)
    assert.ok(!/SameSite=Strict/.test(cookie))
  })
  await t.test('cookie 能用于后续访问', async () => {
    const ck = cookie.split(';')[0]
    const r2 = await S.get('/ui', { raw: true, headers: { Cookie: ck } })
    assert.equal(r2.status, 200)
  })
})

test('hooks 端点无 token，因此只能接受回环来源', async () => {
  // 从测试进程只连得到回环，所以这里验的是「回环确实被放行」；
  // 非回环的拒绝逻辑靠 isLoopback，改动它会让这条以外的行为一起变。
  const r = await S.post('/hooks/session-start', { session_id: 'httptest', cwd: '/tmp' }, { raw: true })
  assert.equal(r.status, 200)
})

test('审批全流程', async (t) => {
  // permission-request 是阻塞的：它会一直挂到有人决策。所以不 await 它。
  const inflight = S.post(
    '/hooks/permission-request',
    {
      session_id: 'flow',
      cwd: '/tmp/proj',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/proj/build', description: '清理构建产物' },
    },
    { raw: true },
  )
  await new Promise((r) => setTimeout(r, 400))

  const list = await (await S.get('/api/approvals')).json()
  const ap = list.approvals.find((a) => a.session_id === 'flow')

  await t.test('创建了待审批', () => assert.ok(ap, `未创建: ${JSON.stringify(list)}`))
  await t.test('判为高危，不自动放行', () => {
    assert.equal(ap.risk.level, 'high')
    assert.equal(ap.auto_decision, 'deny')
  })
  await t.test('列表不泄露单条审批密钥', () => assert.ok(!('key' in ap), 'key 只该出现在深链里'))

  await t.test('拒绝后 hook 收到 deny', async () => {
    const d = await S.post(`/api/approvals/${ap.id}/decide`, { decision: 'deny' })
    assert.equal(d.status, 200)
    const hookRes = await (await inflight).json()
    assert.equal(hookRes.hookSpecificOutput.decision.behavior, 'deny')
  })

  await t.test('正常连接不许被当成「已断开」', async () => {
    /**
     * 这条守的是一次差点上线的事故。
     *
     * 答复之前会检查对面还在不在，判据一度写成 `req.destroyed`——而
     * readBody() 读完请求体之后 Node 会把可读侧自动 destroy，于是一个
     * **完全健康**的请求在那一刻 req.destroyed 就是 true（实测确认）。
     * 结果是每一条审批都短路、永不写响应，审批全线失效。
     *
     * 判据必须落在 res 上。这条断言直接盯住那个后果：决定送到了，
     * 记录就不该说它没送到。
     */
    const after = await (await S.get('/api/approvals')).json()
    const settled = [...after.approvals, ...(after.recentlyExpired ?? [])]
      .find((a) => a.id === ap.id)
    if (settled) assert.notEqual(settled.delivered, false, '决定明明送到了，却被记成没送达')
  })

  await t.test('重复决策幂等，返回当前状态而非报错', async () => {
    const again = await S.post(`/api/approvals/${ap.id}/decide`, { decision: 'allow' })
    assert.equal(again.status, 200)
    const body = await again.json()
    assert.equal(body.ok, false)
    assert.equal(body.reason, 'already_settled')
    assert.equal(body.approval.status, 'denied', '后到的决策不得改写结果')
  })
})

test('PreToolUse 销掉已在别处放行的挂起审批', async () => {
  const input = { command: 'echo superseded-flow', description: '测试' }
  const inflight = S.post(
    '/hooks/permission-request',
    { session_id: 'sup', cwd: '/tmp', tool_name: 'Bash', tool_input: input },
    { raw: true },
  )
  await new Promise((r) => setTimeout(r, 300))
  await S.post('/hooks/pre-tool-use', { session_id: 'sup', tool_name: 'Bash', tool_input: input, tool_use_id: 'toolu_x' }, { raw: true })

  const res = await (await inflight).json()
  // 操作事实上已经在跑了，这时候回 deny 才是与现实矛盾的
  assert.equal(res.hookSpecificOutput.decision.behavior, 'allow')
})

test('审批页与深链权限', async (t) => {
  const input = { command: 'ls -la', description: '列目录' }
  const inflight = S.post(
    '/hooks/permission-request',
    { session_id: 'page', cwd: '/tmp', tool_name: 'Bash', tool_input: input },
    { raw: true },
  )
  await new Promise((r) => setTimeout(r, 300))
  const { approvals } = await (await S.get('/api/approvals')).json()
  const ap = approvals.find((a) => a.session_id === 'page')

  await t.test('不存在的审批 → 404', async () => {
    assert.equal((await S.get('/ui/a/00000000-0000-0000-0000-000000000000', { raw: true })).status, 404)
  })
  await t.test('错误的 ?k= 且未登录 → 403', async () => {
    assert.equal((await S.get(`/ui/a/${ap.id}?k=wrong`, { raw: true })).status, 403)
  })
  await t.test('带 token 可访问', async () => {
    assert.equal((await S.get(`/ui/a/${ap.id}`)).status, 200)
  })

  await S.post(`/api/approvals/${ap.id}/decide`, { decision: 'deny' })
  await inflight
})

test('命令原文注入：页面不得把它当标记解释', async () => {
  const nasty = `echo "</script><img src=x onerror=alert(1)>" && rm -rf $'\\u2028' /tmp/x`
  const inflight = S.post(
    '/hooks/permission-request',
    { session_id: 'xss', cwd: '/tmp', tool_name: 'Bash', tool_input: { command: nasty, description: '测试' } },
    { raw: true },
  )
  await new Promise((r) => setTimeout(r, 300))
  const { approvals } = await (await S.get('/api/approvals')).json()
  const ap = approvals.find((a) => a.session_id === 'xss')
  const html = await (await S.get(`/ui/a/${ap.id}`)).text()

  // 内联脚本里的 bootstrap JSON 必须转义 < ——否则 </script> 当场截断脚本
  const boot = html.slice(html.indexOf('const BOOT'), html.indexOf('const BOOT') + 4000)
  assert.ok(!boot.includes('</script>'), '命令里的 </script> 泄漏进了内联脚本')
  assert.ok(!boot.includes('<img src=x'), '未转义的标签泄漏进了内联脚本')
  assert.ok(boot.includes('\\u003c'), '< 应被转义成 \\u003c')

  await S.post(`/api/approvals/${ap.id}/decide`, { decision: 'deny' })
  await inflight
})

test('statusLine 服务端渲染', async () => {
  const r = await fetch(`${S.base}/statusline?render=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: 'sl',
      model: { display_name: 'Opus' },
      context_window: { used_percentage: 42 },
      rate_limits: { five_hour: { used_percentage: 10 }, seven_day: { used_percentage: 20 } },
      cost: { total_cost_usd: 1.234 },
    }),
  })
  assert.equal(r.status, 200)
  const text = await r.text()
  assert.match(text, /Opus/)
  assert.match(text, /ctx 42%/)
  assert.match(text, /5h 10%/)
  assert.match(text, /\$1\.23/)
})

test('未知路由 404，坏 JSON 不打崩服务', async (t) => {
  await t.test('未知 /api 路由', async () => {
    assert.equal((await S.get('/api/nope')).status, 404)
  })
  await t.test('hook 收到坏 JSON 仍回 200 空对象（不能干扰 Claude Code）', async () => {
    const r = await fetch(`${S.base}/hooks/session-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    })
    assert.equal(r.status, 200)
  })
  await t.test('服务仍然健康', async () => {
    assert.equal((await S.get('/healthz', { raw: true })).status, 200)
  })
})

test('裸输 host:port 要跳到首页，不能扔一坨 JSON', async (t) => {
  // 之前根路径落到最后的 404，返回 {"error":"not found"}。服务完全正常，
  // 但看起来像坏了——这类「正常状态被显示成故障」最费排查时间。
  const r = await S.raw('/')
  await t.test('302 而不是 404', () => assert.equal(r.status, 302))
  await t.test('跳到 /ui', () => assert.equal(r.headers.location, '/ui'))
})

test('配对端点', async (t) => {
  await t.test('hint 未认证也能拿到（只给命令，不给口令）', async () => {
    const r = await S.get('/api/pair/hint', { raw: true })
    assert.equal(r.status, 200)
    const b = await r.json()
    assert.equal(b.command, 'npx clamicro qr')
    assert.ok(!JSON.stringify(b).includes(S.token), '绝不能把口令放进未认证响应')
    // 曾经返回的是 `node /Users/<用户名>/.claude/.../server.mjs --qr`，
    // 白白把用户名和安装路径泄露给未认证的请求
    assert.ok(!b.command.includes('/Users/'), '不该泄露绝对路径')
  })

  await t.test('缺自定义头 → 403（CSRF：跨站简单请求带不了它）', async () => {
    const r = await S.post('/api/pair', {}, { raw: true })
    assert.equal(r.status, 403)
  })

  // 带头的那条会真的弹二维码窗口，不在测试里跑；
  // 它依赖 ctx.notify，而漏传依赖已由 requireDeps 在启动时挡住（见 deps.test.mjs）
})

test('?t= 登录：谁递进来的令牌，cookie 就写谁', async (t) => {
  // 这条修的是两个真 bug，一个可用性一个安全：
  //   1. 原来只认主令牌，带**设备令牌**来的一律打回配对页——而设备令牌
  //      恰恰是手机手里那份，换手机/清数据/cookie 过期后重登走的就是这条路
  //   2. cookie 里写的是**主令牌**（loginCookie 不传值就用它），于是从
  //      `clamicro qr` 扫码进来的手机拿到的是那把 forget 吊销不掉、
  //      还能签发新设备的万能钥匙。每设备令牌的设计因此形同虚设
  await t.test('主令牌可以登录', async () => {
    const r = await S.raw(`/ui?t=${S.token}`)
    assert.equal(r.status, 302)
    assert.match(r.headers['set-cookie']?.[0] ?? '', /ccm=/)
  })

  await t.test('乱七八糟的令牌登不进去', async () => {
    assert.equal((await S.raw(`/ui?t=${'x'.repeat(S.token.length)}`)).status, 401)
  })

  await t.test('不带 t 时是配对页，不是看板', async () => {
    assert.equal((await S.raw('/ui')).status, 401)
  })
})

/**
 * 安装器给出的入口：**不含凭证，也不带有效期**。
 *
 * 这一条被推翻过两次，两次都栽在同一类问题上：
 *
 *   v1 印 `/ui?t=<主令牌>` —— 能用（没有有效期），但那是一张永久、全权、
 *      吊销不掉的凭证，被放进终端回滚缓冲、屏幕录制、旁人的镜头里。
 *      泄露之后 `clamicro forget` 也收不回来，因为它不属于任何设备。
 *   v2 印一次性配对券的二维码 —— 安全上没问题，但**时序是坏的**：券在安装
 *      那一刻就开始倒数 60 秒，而人还要读完输出、掏手机、解锁、打开相机。
 *      等镜头对上去码多半已经死了，然后你会以为是网络问题，反复重装。
 *   v3 印一个网址 —— 两头都躲开：不含凭证所以不怕被留存，不会过期所以什么
 *      时候掏手机都行。凭证在手机点了按钮之后才生成，且只出现在 Mac 屏幕上。
 *
 * 所以这里同时钉两个方向：**不能有凭证**，也**不能在安装时就铸券**。
 * 只钉前者的话，v2 那个「安全但用不了」的形态会被判定为通过。
 *
 * 盯的是源码而不是运行结果：这类回归最可能的形态是有人为了「装完就能扫」
 * 顺手把二维码加回来，而那在任何功能测试里都不会红。
 */
test('安装器给的入口不含凭证、也不会过期', async (t) => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'install.mjs'), 'utf8')

  await t.test('没有 ?t=<token> 形式的登录 URL', () => {
    assert.doesNotMatch(src, /\?t=\$\{[^}]*token[^}]*\}/, '主令牌又被拼进 URL 了')
  })

  await t.test('根本不引用 config.token', () => {
    assert.doesNotMatch(src, /config\.token/, '安装器不该碰主令牌')
  })

  await t.test('安装时不铸配对券——它会在人掏出手机之前就过期', () => {
    assert.doesNotMatch(src, /\/api\/pair\/new/, '券在安装那一刻开始倒数，等不到被扫')
    assert.doesNotMatch(src, /\/ui\/pair\//, '安装输出里不该出现具体的配对链接')
  })

  await t.test('给的是入口网址，且要有 IP 兜底', () => {
    // 只给 .local 的话，解析不了 mDNS 的设备（部分 Android / Windows）
    // 会直接卡死在这一步，而这正是新手路径的第一步
    assert.match(src, /config\.altUrl/, '要有 IP 兜底地址')
    assert.match(src, /手机打开/, '入口应当是「手机打开这个网址」')
  })
})

/**
 * 审批历史。
 *
 * 这些数据一直在盘上（history.json 存 300 条，含全部已决策的），但界面上
 * **完全够不着**——`/api/approvals` 只回待审批和最近 30 分钟超时的 5 条。
 * 而「你不在的时候替你做了哪些决定」正是这个产品的主要价值：自动通过的、
 * 超时被拒的、在终端里被别处放行的，恰恰是你没在场的那些。
 */
test('/api/history 只回已经有结果的', async (t) => {
  const mk = async () => (await (await S.post('/api/selftest/approval', {})).json())
  const a = await mk()
  const b = await mk()
  await S.post(`/api/approvals/${a.id}/decide?k=${encodeURIComponent(a.key)}`, { decision: 'allow' })

  await t.test('待审批的不进历史', async () => {
    const d = await (await S.get('/api/history')).json()
    const ids = d.approvals.map((x) => x.id)
    assert.ok(ids.includes(a.id), '已决策的应该在')
    assert.ok(!ids.includes(b.id), '还挂着的那条不该出现在「历史」里')
  })

  await t.test('带结果和决策人', async () => {
    const d = await (await S.get('/api/history')).json()
    const hit = d.approvals.find((x) => x.id === a.id)
    assert.equal(hit.status, 'allowed')
    assert.equal(hit.decided_by, 'phone')
  })

  await t.test('截断要说出来 —— total 和 retained 都得回', async () => {
    // 只回 N 条而不说还有多少，读起来就是「一共就这么多」
    const d = await (await S.get('/api/history?limit=1')).json()
    assert.equal(d.approvals.length, 1)
    assert.ok(d.total >= 1, 'total 必须是全部条数，不是这次返回的条数')
    assert.equal(typeof d.retained, 'number', '盘上保留多少条也要说，否则「更早的没有了」会被读成「没发生过」')
  })

  await t.test('limit：认得的夹在上限内，认不得的走默认值', async () => {
    // 上限 200 是防「一次把三百条命令原文全推到手机上」，不是业务规则
    for (const q of ['9999', '-1']) {
      const d = await (await S.get(`/api/history?limit=${q}`)).json()
      assert.ok(d.approvals.length <= 200, `limit=${q} 没夹住`)
    }
    // 0 / 空 / 非数字都当没写，走默认——而不是当成「要 0 条」
    for (const q of ['0', '', 'abc']) {
      const d = await (await S.get(`/api/history?limit=${q}`)).json()
      assert.ok(d.approvals.length > 0, `limit=${q} 被当成了「要 0 条」`)
    }
  })

  await t.test('要 token —— 里面是命令原文', async () => {
    assert.equal((await S.get('/api/history', { raw: true })).status, 401)
  })

  await t.test('不夹带凭证', async () => {
    const body = await (await S.get('/api/history')).text()
    assert.ok(!body.includes(S.token), '响应里出现了访问令牌')
    // publicApproval 本来就不输出 key，这里再钉一次：历史会被反复翻，
    // 每条都带一把能决策的钥匙就等于把它们摊开
    assert.ok(!/"key"\s*:/.test(body), '历史条目不该带 per-approval key')
  })
})
