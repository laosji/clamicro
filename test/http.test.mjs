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
