#!/usr/bin/env node
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { loadConfig, saveConfig, CONFIG_FILE } from './lib/config.mjs'
import { Store, STATE } from './lib/state.mjs'
import { makePusher } from './lib/push.mjs'
import { ApprovalStore } from './lib/approvals.mjs'
import { Relay, encodeCommand, decodeCommand } from './lib/relay.mjs'
import { History } from './lib/history.mjs'
import { ControlStore, CONTROL } from './lib/control.mjs'
import { fingerprint, isTrusted, trust } from './lib/network.mjs'
import { Inbox } from './lib/inbox.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const config = loadConfig()
const store = new Store()
const approvals = new ApprovalStore()
const control = new ControlStore()
const inbox = new Inbox()
const push = makePusher(config)

// ---- 历史落盘：重启后旧通知点开不再是「已失效」 ----
const history = new History()
history.bind(() => ({
  approvals: approvals.all(),
  events: store.allEvents(),
  nextEventId: store.nextEventId,
  limits: store.accountLimits(),
}))
{
  const loaded = history.load()
  const { restored, orphaned } = approvals.restore(loaded.approvals)
  store.restoreEvents(loaded.events, loaded.nextEventId)
  store.restoreLimits(loaded.limits)
  if (restored || loaded.events.length) {
    console.log(
      `[history] 恢复 ${restored} 条审批、${loaded.events.length} 条事件` +
        (orphaned ? `（其中 ${orphaned} 条重启时仍挂起，已标记为已放弃）` : ''),
    )
  }
}
inbox.on('change', (sid) => {
  const s = store.session(sid)
  if (s) {
    s.queued = inbox.list(sid).length
    broadcast('session', s)
  }
})

control.on('change', (sid, st) => {
  const s = store.session(sid)
  if (s) {
    s.control = st
    broadcast('session', s)
  }
})
control.on('held', (sid) => {
  const s = store.session(sid)
  if (s) {
    s.held = true
    broadcast('session', s)
  }
})

approvals.on('created', () => history.touch())
approvals.on('settled', () => history.touch())
store.on('event', () => history.touch())

setInterval(() => {
  approvals.sweep(86_400_000) // 记录留一天，够回看昨天的操作
  history.touch()
}, 300_000).unref()

let lastPairAt = 0 // 配对请求限流，避免局域网上有人刷屏

// ---- ntfy 中转：出站长连接接收手机的审批指令 ----
const relay = config.relay.enabled ? new Relay(config.relay) : null

relay?.on('command', (raw) => {
  const cmd = decodeCommand(raw)
  if (!cmd) return console.warn(`[relay] 丢弃无法解析的指令: ${String(raw).slice(0, 80)}`)
  const ap = approvals.get(cmd.id)
  if (!ap) return console.warn(`[relay] 审批 ${cmd.id.slice(0, 8)} 不存在或已清理`)
  // 校验单条审批专属 key —— 光知道 topic 名批不动任何东西
  if (cmd.key !== ap.key) return console.warn(`[relay] 审批 ${cmd.id.slice(0, 8)} 的 key 不匹配，已拒绝处理`)

  const out = approvals.decide(cmd.id, cmd.decision, 'phone')
  console.log(
    out.ok
      ? `[relay] 审批 ${cmd.id.slice(0, 8)} → ${cmd.decision}`
      : `[relay] 审批 ${cmd.id.slice(0, 8)} 已是终态（${ap.status}），忽略重复指令`,
  )
})

/** 发出一条审批请求通知。走 relay 时带通知内按钮，可锁屏 0-tap 决策。 */
async function notifyApproval(ap, label) {
  // 用 config.baseUrl —— 它已回落到自动探测的局域网 IP；publicBaseUrl 通常是空的
  const detailUrl = `${config.baseUrl}/ui/a/${ap.id}?k=${encodeURIComponent(ap.key)}`
  const title = `${ap.risk.level === 'high' ? '⚠️' : '🔐'} ${label} 需要审批`
  // 默认不把命令全文发上公网——正文只说是什么工具，内容在局域网的审批页上看
  const body = config.notify.detailInPush
    ? `${ap.tool_name}: ${ap.summary}`.slice(0, 400)
    : `${ap.tool_name} 操作${ap.risk.level === 'high' ? '（高风险）' : ''}，点开查看详情`

  if (relay) {
    const mk = (label, decision) => ({
      action: 'http',
      label,
      url: relay.commandUrl,
      method: 'POST',
      body: encodeCommand(ap.id, decision, ap.key),
      clear: true,
    })
    try {
      await relay.publish({
        title,
        body,
        priority: 5, // 突破专注模式
        click: detailUrl,
        actions: [mk('✅ 批准', 'allow'), mk('❌ 拒绝', 'deny')],
      })
      console.log(`[relay] 已推送审批 ${ap.id.slice(0, 8)}（${ap.risk.level}）`)
    } catch (err) {
      console.error(`[relay] 推送失败: ${err.message}`)
    }
  }
  // 附加通道（Bark 没有按钮，只能点开详情页）
  // 日志文件默认非 600，别把单条审批的 key 写进去
  console.log(`[approval] ${ap.id.slice(0, 8)} 深链 ${detailUrl.replace(/k=[^&]*/, 'k=***')}`)
  await push({ title, body, url: detailUrl, level: 'timeSensitive', group: 'clamicro-approval' })
}

// ---- 信任当前网络：node server.mjs --trust ----
if (process.argv.includes('--trust')) {
  const fp = fingerprint(config.lanIp)
  if (!fp.id) {
    console.log('\n  未检测到网络，无法信任。\n')
    process.exit(1)
  }
  const entry = trust(config, fp)
  saveConfig(config)
  console.log(`\n  ✓ 已信任「${entry.label}」（网关 ${fp.gateway}）`)
  console.log(`  服务将在这个网络下暴露到局域网。重启服务生效。\n`)
  process.exit(0)
}

if (process.argv.includes('--networks')) {
  const fp = fingerprint(config.lanIp)
  console.log(`\n  当前：${fp.label}  网关 ${fp.gateway ?? '—'}  ${isTrusted(config, fp) ? '✓ 已信任' : '✗ 未信任'}`)
  console.log('\n  已信任的网络：')
  for (const [id, n] of Object.entries(config.trustedNetworks ?? {})) {
    console.log(`    ${n.label}  网关 ${n.gateway ?? '—'}  ${id.slice(0, 8)}`)
  }
  console.log()
  process.exit(0)
}

// ---- 打印登录二维码：node server.mjs --qr ----
if (process.argv.includes('--qr')) {
  const loginUrl = `${config.baseUrl}/ui?t=${config.token}`
  console.log(`\n  ${loginUrl}\n`)
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync('qrencode', ['-t', 'ANSIUTF8', '-m', '2', loginUrl], { stdio: 'inherit' })
  if (r.error) console.log('（装了 qrencode 可以直接扫码：brew install qrencode）')
  if (config.altUrl) {
    console.log(`\n  用的是 Bonjour 主机名，换 Wi-Fi/换 IP 后依然有效。`)
    console.log(`  万一手机解析不了 .local，改用：${config.altUrl}/ui?t=${config.token}\n`)
  }
  process.exit(0)
}

// ---- 手动测试推送：node server.mjs --test-push ----
if (process.argv.includes('--test-push')) {
  if (config.relay.enabled) {
    const r = new Relay(config.relay)
    await r.publish({
      title: '🔔 Clamicro 测试',
      body: '看到这条 + 下面两个按钮，说明双向链路都通了。',
      priority: 5,
      actions: [
        { action: 'http', label: '✅ 批准', url: r.commandUrl, method: 'POST', body: 'test|allow|test', clear: true },
        { action: 'http', label: '❌ 拒绝', url: r.commandUrl, method: 'POST', body: 'test|deny|test', clear: true },
      ],
    })
    console.log(`[relay] 测试通知已发往 ${r.notifyUrl}`)
  }
  await push({
    title: '🔔 Clamicro 测试',
    body: '如果你在锁屏上看到这条，附加推送通道也通了。',
    level: 'active',
    group: 'clamicro',
  })
  process.exit(0)
}

const HOOK_EVENTS = new Set([
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

// ---- SSE ----
const sseClients = new Set()

function broadcast(type, data, id) {
  const frame = `${id ? `id: ${id}\n` : ''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of sseClients) {
    try {
      res.write(frame)
    } catch {
      sseClients.delete(res)
    }
  }
}

store.on('event', (e) => broadcast('event', e, e.id))
store.on('session', (s) => broadcast('session', s))
approvals.on('created', (a) => broadcast('approval', publicApproval(a)))
approvals.on('settled', (a) => broadcast('approval', publicApproval(a)))

// 对外投影：不泄露 key 之外的内部字段，key 只在深链里单独给
function publicApproval(a, withKey = false) {
  const s = store.session(a.session_id)
  return {
    id: a.id,
    ...(withKey ? { key: a.key } : {}),
    session_id: a.session_id,
    session_name: s?.session_name ?? null,
    cwd: s?.cwd ?? null,
    tool_name: a.tool_name,
    summary: a.summary,
    headline: a.headline,
    detail: a.detail,
    detail_lines: a.detail_lines,
    impact: a.impact,
    rule: a.rule,
    risk: a.risk,
    status: a.status,
    decided_by: a.decided_by,
    created_at: a.created_at,
    expires_at: a.expires_at,
    auto_decision: a.auto_decision,
  }
}

// ---- helpers ----
function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(new Error(`invalid JSON: ${err.message}`))
      }
    })
    req.on('error', reject)
  })
}

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function text(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/** 终端状态栏文本。放在服务端渲染，中继脚本就不必解析 JSON。 */
function renderStatusLine(d) {
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

function html(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/**
 * hooks 和 statusLine 只接受本机来源。
 *
 * 这两组端点没有 token（Claude Code 的 http hook 传 header 很别扭），
 * 原本的假设是「只监听回环」——但服务同时绑了局域网网卡，
 * 假设并不成立：同一 Wi-Fi 上任何人都能伪造 hook 事件，
 * 往你手机刷审批通知、往时间线注入假记录、伪造额度读数。
 * 按来源地址挡住。
 */
/**
 * Host 头白名单 —— 防 DNS rebinding。
 *
 * 局域网服务的经典攻击：恶意站点让 evil.com 先解析到自己，再重绑到
 * 192.168.1.x。浏览器认为仍是同源，CORS 被完全绕过，对方能读整个看板、
 * 命令原文，并批准操作——而且不需要在你的 Wi-Fi 上。
 * 只接受我们自己知道的几个主机名就能挡住：重绑后的 Host 头仍是 evil.com。
 */
const ALLOWED_HOSTS = new Set(
  [
    '127.0.0.1', 'localhost', '[::1]', '::1',
    config.lanIp, config.localHost, config.tailscaleIp,
    (() => { try { return new URL(config.publicBaseUrl).hostname } catch { return null } })(),
  ]
    .filter(Boolean)
    // 全部转小写：Host 头大小写不敏感，而 LocalHostName 可能是大小写混合
    .flatMap((h) => [h.toLowerCase(), `${h.toLowerCase()}:${config.port}`]),
)

function hostAllowed(req) {
  const h = req.headers.host
  if (!h) return true // HTTP/1.0 无 Host，只可能来自本机脚本
  return ALLOWED_HOSTS.has(h.toLowerCase())
}

/** 常数时间比较，避免给出可测的时间差 */
function safeEq(a, b) {
  const x = Buffer.from(String(a ?? ''))
  const y = Buffer.from(String(b ?? ''))
  return x.length === y.length && timingSafeEqual(x, y)
}

function isLoopback(req) {
  const a = req.socket.remoteAddress ?? ''
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

function sameToken(given) {
  if (typeof given !== 'string' || !given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(config.token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function cookieToken(req) {
  const raw = req.headers.cookie ?? ''
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === 'ccm') return decodeURIComponent(v.join('='))
  }
  return null
}

// Bearer（脚本用）或 cookie（手机浏览器用）
function authorized(req) {
  const header = req.headers.authorization ?? ''
  return sameToken(header.startsWith('Bearer ') ? header.slice(7) : '') || sameToken(cookieToken(req))
}

// ---- routes ----
async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname

  try {
    if (!hostAllowed(req)) {
      console.warn(`[security] 拒绝 Host: ${req.headers.host}（疑似 DNS rebinding）`)
      return json(res, 403, { error: 'bad host' })
    }

    // frame-ancestors 挡点击劫持：否则恶意页面可以把审批页嵌进 iframe
    // 诱导你滑动。connect-src 限制页面只能连自己。
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    )

    if (path === '/healthz') {
      // 不泄露会话数——未认证的探测者不需要知道你在跑几个任务
      return json(res, 200, { ok: true })
    }

    // hooks / statusLine 一律只认本机来源，见 isLoopback 的说明
    if ((path.startsWith('/hooks/') || path === '/statusline') && !isLoopback(req)) {
      console.warn(`[security] 拒绝来自 ${req.socket.remoteAddress} 的 ${path}`)
      return json(res, 403, { error: 'forbidden' })
    }

    // ---- 核心：阻塞式审批（计划 §2.1）----
    if (req.method === 'POST' && path === '/hooks/permission-request') {
      const payload = await readBody(req)

      // 自排除：开发 clamicro 自身时，别把自己的工具调用卡住 570 秒。
      // 返回空对象 = 本 hook 无意见，走 Claude Code 正常权限流程。
      if (config.ignoreCwds.some((d) => payload.cwd?.startsWith(d))) {
        return json(res, 200, {})
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
        console.log(`[approval] ${ap.id.slice(0, 8)} 将自动通过（${Math.round((ap.expires_at - ap.created_at) / 1000)}s），不推送`)
      } else {
        notifyApproval(ap, label).catch(() => {})
      }

      const outcome = await approvals.wait(ap.id)
      responded = true
      store.clearWaitingApproval(payload.session_id)

      return json(res, 200, {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: outcome.decision },
          ...(outcome.reason ? { permissionDecisionReason: outcome.reason } : {}),
        },
      })
    }

    // hooks —— 只监听回环，不做 token 校验（Claude Code 的 http hook 传 header 较麻烦）
    if (req.method === 'POST' && path.startsWith('/hooks/')) {
      const event = path.slice('/hooks/'.length)
      if (!HOOK_EVENTS.has(event)) return json(res, 404, { error: `unknown hook event: ${event}` })

      const payload = await readBody(req)

      // Pause/Cancel 的拦截点。Claude Code 没有运行时暂停原语，
      // 只能在下一个工具调用前把它挂住。
      if (event === 'pre-tool-use' && payload.session_id) {
        store.applyHook(event, payload, config.notify)
        const gated = await control.gate(payload.session_id)
        if (gated) {
          store.noteControl(payload.session_id, gated.continue === false ? 'cancelled' : 'resumed')
          return json(res, 200, gated)
        }
        return json(res, 200, {})
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
          return json(res, 200, { decision: 'block', reason: pending.text })
        }
      }

      const { body, notify } = store.applyHook(event, payload, config.notify)

      // 关键：HTTP hook 不支持 async:true，会阻塞工具调用，所以先回包再推送
      json(res, 200, body)
      if (notify) {
        push({ ...notify, url: notify.url ?? `${config.baseUrl}/ui` }).catch(() => {})
      }
      return
    }

    if (req.method === 'POST' && path === '/statusline') {
      const payload = await readBody(req)
      const warn = store.applyStatusLine(payload, { quotaWarnPct: config.notify.quotaWarnPct })
      history.touch()
      if (warn) push(warn).catch(() => {})
      // ?render=1：把状态栏文本渲染好回给中继脚本，
      // 这样脚本侧不用解析 JSON，省掉 jq 依赖也省掉 Node 启动开销
      if (url.searchParams.get('render')) return text(res, 200, renderStatusLine(payload))
      return json(res, 200, {})
    }

    // ---- 配对：未认证也可访问 ----
    // 让二维码显示在 Mac 屏幕上（口令不经过这个未认证的请求返回），
    // 局域网上的其他人最多让你的 Mac 弹一次二维码，看不到内容。
    if (path === '/api/pair/hint') {
      return json(res, 200, { command: `node ${join(HERE, 'server.mjs')} --qr` })
    }

    if (req.method === 'POST' && path === '/api/pair') {
      // 要求一个自定义头。跨站「简单请求」带不了它，会触发预检而被拦下，
      // 否则你访问的任意网站都能让这台 Mac 弹二维码。
      if (req.headers['x-ccm'] !== '1') return json(res, 403, { error: 'forbidden' })
      const now = Date.now()
      if (now - lastPairAt < 10_000) {
        return json(res, 429, { ok: false, error: '刚显示过，去看看 Mac 屏幕' })
      }
      lastPairAt = now
      const loginUrl = `${config.baseUrl}/ui?t=${config.token}`
      const { spawnSync, spawn } = await import('node:child_process')
      const png = join(tmpdir(), 'clamicro-pair.png')
      const q = spawnSync('qrencode', ['-o', png, '-s', '10', '-m', '3', loginUrl])
      if (q.status === 0) {
        spawn('open', [png], { detached: true, stdio: 'ignore' }).unref()
      }
      await push({
        title: '📱 Clamicro 配对',
        body: q.status === 0 ? '扫描屏幕上的二维码即可登录' : loginUrl,
      })
      console.log('[pair] 已在 Mac 上显示二维码')
      return json(res, 200, { ok: true, qr: q.status === 0 })
    }

    // ---- 静态资源（手势模块，两个页面共用）----
    const asset = path.match(/^\/ui\/(swipe\.(?:js|css))$/)
    if (req.method === 'GET' && asset) {
      const body = readFileSync(join(HERE, 'ui', asset[1]), 'utf8')
      res.writeHead(200, {
        'Content-Type': asset[1].endsWith('.js')
          ? 'application/javascript; charset=utf-8'
          : 'text/css; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-cache',
      })
      return res.end(body)
    }

    // ---- 首页 ----
    if (req.method === 'GET' && (path === '/ui' || path === '/ui/')) {
      // 首次带 ?t=<token> 访问 → 换成 httpOnly cookie，之后 URL 里不再出现 token
      const t = url.searchParams.get('t')
      if (t && sameToken(t)) {
        res.writeHead(302, {
          Location: '/ui',
          'Set-Cookie': [
            `ccm=${encodeURIComponent(config.token)}`,
            'HttpOnly',
            // 必须是 Lax 不能是 Strict：从 Bark 通知点进 Safari 属于跨站导航，
            // Strict 的 cookie 不会被带上，每次从通知进来都像没登录过。
            // Lax 放行顶层 GET 导航，跨站 POST 仍然拦住。
            'SameSite=Lax',
            'Path=/',
            'Max-Age=31536000',
            ...(config.baseUrl.startsWith('https:') ? ['Secure'] : []),
          ].join('; '),
        })
        return res.end()
      }
      if (!authorized(req)) {
        return html(res, 401, readFileSync(join(HERE, 'ui', 'pair.html'), 'utf8'))
      }
      return html(res, 200, readFileSync(join(HERE, 'ui', 'home.html'), 'utf8'))
    }

    const uiSess = path.match(/^\/ui\/s\/([\w-]+)$/)
    if (req.method === 'GET' && uiSess) {
      if (!authorized(req)) return html(res, 401, readFileSync(join(HERE, 'ui', 'pair.html'), 'utf8'))
      return html(res, 200, readFileSync(join(HERE, 'ui', 'session.html'), 'utf8'))
    }

    if (req.method === 'GET' && path === '/ui/settings') {
      if (!authorized(req)) return html(res, 401, '<h1>需要访问口令</h1><p>请先从 /ui 进入</p>')
      return html(res, 200, readFileSync(join(HERE, 'ui', 'settings.html'), 'utf8'))
    }

    // ---- 审批页 ----
    const uiMatch = path.match(/^\/ui\/a\/([\w-]+)$/)
    if (req.method === 'GET' && uiMatch) {
      const ap = approvals.get(uiMatch[1])
      if (!ap) return html(res, 404, readFileSync(join(HERE, 'ui', 'gone.html'), 'utf8'))
      if (!safeEq(url.searchParams.get('k'), ap.key) && !authorized(req)) {
        return html(res, 403, '<h1>链接无效</h1>')
      }
      // hasSession：是否持有登录 cookie。只有它为真才在决策后跳回首页——
      // ?k= 只是单条审批的凭证（且经过了推送服务商），不足以授权整个看板。
      // 转义 < 和 U+2028/2029：命令里若含 </script> 会当场截断内联脚本，
      // 行分隔符则会破坏 JS 字符串字面量。
      const boot = JSON.stringify({
        ...publicApproval(ap, true),
        hasSession: sameToken(cookieToken(req)),
      })
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029')
      // 必须用函数式替换。审批内容是 shell 命令，$ 遍地都是，而 replace 的
      // 替换串里 $' 表示"匹配之后的全部内容"、$& 表示匹配本身——直接传字符串
      // 会把页面自己的源码注入进 JSON。函数返回值不做任何 $ 解释。
      const page = readFileSync(join(HERE, 'ui', 'approval.html'), 'utf8').replace(
        '__BOOTSTRAP__',
        () => boot,
      )
      return html(res, 200, page)
    }

    // ---- 审批 API：Bearer token 或该审批专属的 ?k= 均可 ----
    const apiMatch = path.match(/^\/api\/approvals\/([\w-]+)(\/decide)?$/)
    if (apiMatch) {
      const ap = approvals.get(apiMatch[1])
      if (!ap) return json(res, 404, { error: 'not_found' })
      if (!safeEq(url.searchParams.get('k'), ap.key) && !authorized(req)) {
        return json(res, 403, { error: 'forbidden' })
      }
      if (req.method === 'GET' && !apiMatch[2]) {
        return json(res, 200, { approval: publicApproval(ap) })
      }
      if (req.method === 'POST' && apiMatch[2]) {
        const { decision } = await readBody(req)
        const out = approvals.decide(ap.id, decision, 'phone')
        if (!out.ok && out.code === 'already_settled') {
          // 幂等：已被终端或另一入口处理过，回当前真实状态而不是报错（计划 §4）
          return json(res, 200, { ok: false, reason: 'already_settled', approval: publicApproval(ap) })
        }
        if (!out.ok) return json(res, 400, { error: out.code })
        return json(res, 200, { ok: true, approval: publicApproval(ap) })
      }
      return json(res, 405, { error: 'method_not_allowed' })
    }

    // ---- 以下需要 token ----
    if (path.startsWith('/api/')) {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' })

      const say = path.match(/^\/api\/sessions\/([\w-]+)\/say$/)
      if (say && req.method === 'POST') {
        const { text } = await readBody(req)
        if (!String(text ?? '').trim()) return json(res, 400, { error: 'empty' })
        const msg = inbox.queue(say[1], String(text).trim())
        return json(res, 200, { ok: true, message: msg, queued: inbox.list(say[1]).length })
      }

      const unsay = path.match(/^\/api\/sessions\/([\w-]+)\/say\/([\w-]+)$/)
      if (unsay && req.method === 'DELETE') {
        return json(res, 200, { ok: inbox.remove(unsay[1], unsay[2]) })
      }

      if (path === '/api/inbox') {
        return json(res, 200, { inbox: inbox.all() })
      }

      const ctl = path.match(/^\/api\/sessions\/([\w-]+)\/(pause|resume|cancel)$/)
      if (ctl && req.method === 'POST') {
        const [, sid, action] = ctl
        const out = control[action](sid)
        store.noteControl(sid, action)
        console.log(`[control] 会话 ${sid.slice(0, 8)} → ${action}`)
        return json(res, 200, { ...out, held: control.isHeld(sid) })
      }

      if (path === '/api/approvals') {
        return json(res, 200, { approvals: approvals.pending().map((a) => publicApproval(a)) })
      }

      // ---- 设置：Bark key 存在手机上，就该在手机网页里填，而不是让人回终端敲命令 ----
      if (path === '/api/config' && req.method === 'GET') {
        return json(res, 200, {
          barkKey: config.push.bark.key ? `${config.push.bark.key.slice(0, 4)}••••` : '',
          barkConfigured: Boolean(config.push.bark.key),
          pushEnabled: config.push.provider === 'bark',
          macNotify: config.push.macNotify,
          detailInPush: config.notify.detailInPush,
          onStop: config.notify.onStop,
          minTurnMs: config.notify.minTurnMs,
          relayEnabled: config.relay.enabled,
          lanIp: config.lanIp,
          autoApproveMs: config.approval.autoApproveMs,
          timeoutMs: config.approval.timeoutMs,
          autoApproveHighRisk: config.approval.autoApproveHighRisk,
          hostMode: config.hostMode,
          baseUrl: config.baseUrl,
          altUrl: config.altUrl,
          localHost: config.localHost,
          network: { label: net.label, trusted },
        })
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
        for (const k of ['macNotify']) if (typeof body[k] === 'boolean') config.push[k] = body[k]
        for (const k of ['detailInPush', 'onStop']) if (typeof body[k] === 'boolean') config.notify[k] = body[k]
        if (Number.isFinite(body.minTurnMs)) config.notify.minTurnMs = Math.max(0, body.minTurnMs)
        if (Number.isFinite(body.autoApproveMs)) {
          config.approval.autoApproveMs = Math.max(0, body.autoApproveMs)
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
        // 推送通道被悄悄关掉是最难排查的故障：手机一声不响，你以为它在守着。
        // 每次变更都留痕，下次再出问题能直接对时间。
        if (before !== config.push.provider) {
          console.log(`[config] ⚠️ 推送通道 ${before} → ${config.push.provider}（来自网页设置）`)
        } else {
          console.log(`[config] 已从网页更新设置`)
        }
        return json(res, 200, { ok: true })
      }

      if (path === '/api/selftest/push' && req.method === 'POST') {
        await push({ title: '🔔 测试通知', body: '收到这条就说明推送通了', level: 'active', group: 'clamicro' })
        return json(res, 200, { ok: true })
      }

      // 装完立刻走一遍完整流程才叫装好了
      if (path === '/api/selftest/approval' && req.method === 'POST') {
        store.session('selftest').session_name = '安装自检'
        const ap = approvals.create({
          session_id: 'selftest',
          cwd: HERE,
          tool_name: 'Bash',
          tool_input: { command: 'echo "Clamicro 安装自检"', description: '这是一条测试审批，批准或拒绝都不会真的执行任何操作' },
          permission_rule: { action: 'Bash', behavior: 'ask' },
        }, { ...config.approval, autoApproveMs: 0 }) // 自检不自动通过，等你真点一下
        notifyApproval(ap, '安装自检').catch(() => {})
        return json(res, 200, { id: ap.id, key: ap.key })
      }

      if (path === '/api/sessions') {
        return json(res, 200, { sessions: store.sessions(), limits: store.accountLimits() })
      }

      const apiSess = path.match(/^\/api\/sessions\/([\w-]+)$/)
      if (apiSess && req.method === 'GET') {
        const sid = apiSess[1]
        const found = store.sessions().find((x) => x.session_id === sid) ?? null
        return json(res, 200, { session: found, events: store.events(0, sid), queued: inbox.list(sid) })
      }

      if (path === '/api/state') {
        const since = Number(url.searchParams.get('since') ?? 0)
        return json(res, 200, { sessions: store.sessions(), events: store.events(since) })
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
        return
      }

      return json(res, 404, { error: 'not found' })
    }

    return json(res, 404, { error: 'not found' })
  } catch (err) {
    console.error(`[http] ${req.method} ${path}: ${err.message}`)
    // hook 出错也要回 200 空对象，否则会干扰 Claude Code 的正常流程
    if (path.startsWith('/hooks/') || path === '/statusline') return json(res, 200, {})
    return json(res, 400, { error: err.message })
  }
}

// ---- 网络信任闸门 ----
// 陌生网络只绑回环。HTTP 是明文的，在不认识的网络上暴露等于把 token 摊开；
// 与其指望你记得关掉，不如默认收缩、让你显式确认。
const net = fingerprint(config.lanIp)
// Tailscale 自带加密，不受所在物理网络影响，所以不进信任闸门
const trusted = isTrusted(config, net)
const bindHosts = trusted
  ? config.bind
  : config.bind.filter((h) => h === '127.0.0.1' || h === config.tailscaleIp)

if (!trusted && config.lanIp) {
  console.warn(`[security] 当前网络「${net.label}」未被信任，只绑回环，手机暂时连不上`)
  console.warn(`[security] 确认这是可信网络后执行： node ${join(HERE, 'server.mjs')} --trust`)
  push({
    title: '🔒 Clamicro 已收缩到本机',
    body: `检测到新网络「${net.label}」。确认可信后在终端执行 server.mjs --trust`,
    level: 'timeSensitive',
    group: 'clamicro-net',
  }).catch(() => {})
}

// ---- 启动：每个绑定地址一个 server 实例，共享同一 handler ----
const servers = bindHosts.map((host) => {
  const s = createServer(handler)
  s.on('error', (err) => {
    console.error(`[clamicro] 绑定 ${host}:${config.port} 失败: ${err.message}`)
    if (err.code === 'EADDRINUSE') process.exit(1)
  })
  s.listen(config.port, host, () => console.log(`[clamicro] 监听 http://${host}:${config.port}`))
  return s
})

relay?.start()

console.log(`[clamicro] 网络 ${net.label}${trusted ? ' ✓ 已信任' : ' ✗ 未信任（仅本机可用）'}`)
console.log(`[clamicro] 配置文件 ${CONFIG_FILE}`)
console.log(
  relay
    ? `[clamicro] 中转 ${config.relay.server}（手机订阅 topic: ${config.relay.notifyTopic}）`
    : `[clamicro] 中转 已关闭`,
)
if (config.push.provider !== 'none') console.log(`[clamicro] 推送 ${config.push.provider}`)
console.log(
  config.lanIp
    ? `[clamicro] 深链基址 ${config.baseUrl}（手机需在同一 Wi-Fi）${config.altUrl ? ` · 备用 ${config.altUrl}` : ''}`
    : `[clamicro] ⚠️ 未探测到局域网 IP，手机将无法打开审批页`,
)
console.log(`[clamicro] 访问 token ${config.token.slice(0, 8)}…（完整值见配置文件）`)

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n[clamicro] 退出')
    history.flushNow()
    relay?.stop()
    for (const res of sseClients) res.end()
    for (const s of servers) s.close()
    setTimeout(() => process.exit(0), 500).unref()
  })
}
