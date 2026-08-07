#!/usr/bin/env node
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, saveConfig, detectLanIp, CONFIG_FILE } from './src/config.mjs'
import { Store, STATE } from './src/state.mjs'
import { makeNotifier } from './src/notify.mjs'
import { ApprovalStore } from './src/approvals.mjs'
import { History } from './src/history.mjs'
import { ControlStore, CONTROL } from './src/control.mjs'
import { fingerprint, isTrusted, trust } from './src/network.mjs'
import { Inbox } from './src/inbox.mjs'
import { watchNetwork } from './src/netwatch.mjs'
import { json } from './src/http/respond.mjs'
import { allowedHosts, hostAllowed, isLoopback, applySecurityHeaders } from './src/http/security.mjs'
import { makeAuth } from './src/auth/token.mjs'
import { hookRoutes } from './src/routes/hooks.mjs'
import { pageRoutes } from './src/routes/pages.mjs'
import { apiRoutes } from './src/routes/api.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const config = loadConfig()
const store = new Store()
const approvals = new ApprovalStore()
const control = new ControlStore()
const inbox = new Inbox()
const notify = makeNotifier(config)

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
  // 一次性查询命令（status / networks / qr）只是借这个进程读数据，
  // 不该把服务端的启动日志混进它们的输出里
  const quiet = process.argv.some((a) => a.startsWith('--'))
  if (!quiet && (restored || loaded.events.length)) {
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

/**
 * 发出一条审批请求通知。
 *
 * 只发通知，不带决策按钮 —— 决策一律回到局域网页面上做。
 * 曾经有过一条 ntfy 双 topic 中转，能在锁屏通知里直接批准；删掉了，理由是：
 * 它把控制面交给了第三方公网服务器，而换来的只是省掉一次点击。
 * 人不在设备边上时，"少点一下"本来就没有价值。
 */
async function notifyApproval(ap, label) {
  // 用 config.baseUrl —— 它已回落到自动探测的局域网 IP；publicBaseUrl 通常是空的
  const detailUrl = `${config.baseUrl}/ui/a/${ap.id}?k=${encodeURIComponent(ap.key)}`
  const title = `${ap.risk.level === 'high' ? '⚠️' : '🔐'} ${label} 需要审批`
  const body = `${ap.summary}`.slice(0, 200)

  // 日志文件默认非 600，别把单条审批的 key 写进去
  console.log(`[approval] ${ap.id.slice(0, 8)} 深链 ${detailUrl.replace(/k=[^&]*/, 'k=***')}`)
  await notify({ title, body })
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
  // 拿不到 SSID 时 label 本身就是「网关 x.x.x.x」，别再把网关拼一遍
  const describe = (n) =>
    n.label === `网关 ${n.gateway}` ? n.label : `${n.label}  网关 ${n.gateway ?? '—'}`
  const fp = fingerprint(config.lanIp)
  console.log(`\n  当前：${describe(fp)}  ${isTrusted(config, fp) ? '✓ 已信任' : '✗ 未信任'}`)
  console.log('\n  已信任的网络：')
  for (const [id, n] of Object.entries(config.trustedNetworks ?? {})) {
    console.log(`    ${describe(n)}  ${id.slice(0, 8)}`)
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

// ---- 手动测试提醒：node server.mjs --test-push ----
if (process.argv.includes('--test-push')) {
  await notify({ title: '🔔 Clamicro 测试', body: '看到这条通知，说明提醒通道是通的。' })
  process.exit(0)
}

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
    detail_spans: a.detail_spans ?? [],
    detail_lines: a.detail_lines,
    impact: a.impact,
    mismatch: a.mismatch ?? null,
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


// Host 白名单在启动时算一次。IP 变了由 SessionStart 的 stale 检查重启进程，
// 网络变了由 netwatch 收缩监听——都不需要在运行期改这个集合。
const ALLOWED_HOSTS = allowedHosts(config)
const { sameToken, authorized, loginCookie } = makeAuth(config.token)

const auth = { sameToken, authorized, loginCookie }
const handleHooks = hookRoutes({
  config, store, approvals, control, inbox, history, notify, notifyApproval,
})
const handlePages = pageRoutes({ config, approvals, notify, auth, publicApproval, HERE })
const handleApi = apiRoutes({
  config, store, approvals, control, inbox, notify, saveConfig,
  auth, publicApproval, notifyApproval, sseClients, HERE,
  // 惰性：net / trusted 在下面的「网络信任闸门」一节才求值，
  // 这里直接传值会撞上 TDZ。闭包体到请求进来时才执行，那时早就有值了。
  network: () => ({ label: net.label, trusted }),
})

// ---- routes ----
async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname

  try {
    if (!hostAllowed(req, ALLOWED_HOSTS)) {
      console.warn(`[security] 拒绝 Host: ${req.headers.host}（疑似 DNS rebinding）`)
      return json(res, 403, { error: 'bad host' })
    }

    applySecurityHeaders(res)

    if (path === '/healthz') {
      // 不泄露会话数——未认证的探测者不需要知道你在跑几个任务。
      //
      // stale：进程启动时绑的局域网地址还成立吗。
      // 监听套接字绑在启动那一刻的 IP 上，DHCP 续租或换 Wi-Fi 之后那个地址
      // 就不属于本机了——手机连过来是超时而不是报错，终端里一片安静，
      // 典型的静默失败。这里现场重新探测一次，让 SessionStart hook 据此决定
      // 要不要重启（服务本来就跟着 Claude Code 的生命周期走，不另开巡检）。
      return json(res, 200, { ok: true, stale: detectLanIp() !== config.lanIp })
    }

    // hooks / statusLine 一律只认本机来源，见 isLoopback 的说明
    if ((path.startsWith('/hooks/') || path === '/statusline') && !isLoopback(req)) {
      console.warn(`[security] 拒绝来自 ${req.socket.remoteAddress} 的 ${path}`)
      return json(res, 403, { error: 'forbidden' })
    }

    if (await handleHooks(req, res, url, path)) return

    if (await handlePages(req, res, url, path)) return

    if (await handleApi(req, res, url, path)) return

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
  notify({
    title: '🔒 Clamicro 已收缩到本机',
    body: `检测到新网络「${net.label}」。确认可信后在终端执行 server.mjs --trust`,
    level: 'timeSensitive',
    group: 'clamicro-net',
  }).catch(() => {})
}

// ---- 启动：每个绑定地址一个 server 实例，共享同一 handler ----
const servers = new Map() // host -> http.Server

function listenOn(host) {
  if (!host || servers.has(host)) return
  const s = createServer(handler)
  s.on('error', (err) => {
    console.error(`[clamicro] 绑定 ${host}:${config.port} 失败: ${err.message}`)
    servers.delete(host)
    // 回环绑不上才是致命的；局域网地址绑不上通常只是网卡刚变
    if (err.code === 'EADDRINUSE' && host === '127.0.0.1') process.exit(1)
  })
  s.listen(config.port, host, () => console.log(`[clamicro] 监听 http://${host}:${config.port}`))
  servers.set(host, s)
}

function stopListening(host) {
  const s = servers.get(host)
  if (!s) return
  s.close()
  servers.delete(host)
  console.warn(`[clamicro] 已停止监听 ${host}:${config.port}`)
}

for (const host of bindHosts) listenOn(host)

/**
 * 网络变了就重新过一遍信任闸门。
 *
 * 闸门原先只在进程启动时判一次。多数情况下换网络会同时换 IP，旧套接字绑的
 * 地址不再属于本机、暴露面自然消失，SessionStart 那边也会因为 stale 重启。
 * 但**换到不同网络却恰好拿到相同 IP**（192.168.1.x 到处都是）时套接字依旧
 * 有效，人就真的暴露在陌生网络上了。
 *
 * 这里只做收缩，不做扩张：新网络不可信就摘掉局域网监听。要重新暴露得显式
 * `clamicro trust` 再重启——「失败即收缩」比「自动恢复」安全。
 */
let currentNetId = net.id
const stopWatching = watchNetwork(() => {
  const ip = detectLanIp()
  const fp = fingerprint(ip)
  if (fp.id === currentNetId) return
  currentNetId = fp.id

  if (isTrusted(config, fp)) {
    console.log(`[clamicro] 网络变为「${fp.label}」（已信任）`)
    if (ip !== config.lanIp) {
      console.log(`[clamicro] 地址变了，新开一个 Claude Code 会话会自动重启到新地址`)
      console.log(`[clamicro] 之后重新生成二维码： npx clamicro qr`)
    }
    return
  }

  const wasExposed = servers.has(config.lanIp)
  if (config.lanIp) stopListening(config.lanIp)
  console.warn(`[security] 网络变为「${fp.label}」，未被信任${wasExposed ? '，已摘掉局域网监听' : ''}`)
  console.warn(`[security] 确认可信后执行： npx clamicro trust`)
  if (wasExposed) {
    notify({
      title: '🔒 Clamicro 已收缩到本机',
      body: `换到了未信任的网络「${fp.label}」，局域网访问已关闭。确认可信后执行 npx clamicro trust`,
      level: 'timeSensitive',
      group: 'clamicro-net',
    }).catch(() => {})
  }
})

console.log(`[clamicro] 网络 ${net.label}${trusted ? ' ✓ 已信任' : ' ✗ 未信任（仅本机可用）'}`)
console.log(`[clamicro] 配置文件 ${CONFIG_FILE}`)
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
    stopWatching()
    for (const res of sseClients) res.end()
    for (const s of servers.values()) s.close()
    setTimeout(() => process.exit(0), 500).unref()
  })
}
