#!/usr/bin/env node
import { createServer } from 'node:http'
import { readFileSync, watch } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, saveConfig, detectLanIp, CONFIG_FILE } from './src/config.mjs'
import { AGENTS } from './src/agents.mjs'
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
import { PairingStore, ConfirmStore, addDevice, removeDevice } from './src/auth/pairing.mjs'
import { hookRoutes } from './src/routes/hooks.mjs'
import { pageRoutes } from './src/routes/pages.mjs'
import { apiRoutes } from './src/routes/api.mjs'
import { makeRedactor } from './src/redact.mjs'
import { verifyHooks, install, HOOK_MAP } from './src/settings.mjs'
import { appPaths } from './src/paths.mjs'
import { stampConsole, rotateLog } from './src/log.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 这次是被 CLI 借来跑一条一次性查询（`--qr` / `--devices` / `--networks` …），
 * 还是真的要起服务。
 *
 * 区别很重要：一次性进程**不该有副作用**，也**不该发通知**——它跑完就
 * `process.exit(0)`，而 HUD 是子进程，进程一走就被带走，通知只会留在日志里。
 */
/**
 * 一次性查询的**白名单**。下面每一个都有对应的处理分支，跑完就 exit。
 * 加新的一次性命令时，这里和那个分支要一起加。
 */
const ONE_SHOT_FLAGS = new Set([
  '--qr', '--trust', '--untrust', '--rotate-token',
  '--devices', '--forget', '--networks', '--config', '--test-push',
])

/**
 * 这次是被 CLI 借来跑一条一次性查询，还是真的要起服务。
 *
 * 判据是「**是不是已知的一次性命令**」，不是「有没有带 `--` 参数」。
 *
 * 原来写的是 `argv.some(a => a.startsWith('--'))`。当前两条常驻启动路径
 * （`cli.mjs start` 和 SessionStart hook）都不带参数，所以它一直是对的——
 * 但那是**巧合**，不是保证。哪天给常驻服务加一个 `--port=` 或 `--foreground`，
 * ONE_SHOT 会当场翻成 true，于是巡检和自愈定时器全部不装：
 * 服务照常监听、healthz 照常回 ok、日志里连时间戳都还在，
 * 只是再也不会自我修复了。这种「看起来完全正常但少了一半功能」的故障，
 * 是这个代码库里最不想要的那一类。
 *
 * `--untrust=x` / `--forget=x` 带值，所以按 `=` 前半截比。
 * 从下标 2 开始：前两项是 node 路径和脚本路径，不是参数。
 * （node 自己的标志走 execArgv，本来就不在 argv 里。）
 */
const ONE_SHOT = process.argv.slice(2).some((a) => ONE_SHOT_FLAGS.has(a.split('=')[0]))

/**
 * 常驻服务的每一行日志都带时间戳；一次性查询不带。
 *
 * 必须在**任何 console 调用之前**装上，否则最早那几行（配置路径、监听地址）
 * 会没有前缀，而它们恰恰是「这次是什么时候起来的」的锚点。
 *
 * 一次性查询的输出是给人看的终端内容——`clamicro qr` 的二维码、状态表格。
 * 给那些行挨个加前缀会把二维码直接毁掉。
 */
if (!ONE_SHOT) stampConsole()

const config = loadConfig()
const store = new Store()

/**
 * 抹掉本服务自己的凭证，再让它进事件流。
 *
 * 事件明细是 Claude 的回复原文；只要它贴过一次登录地址，主令牌就会落进
 * history.json，并通过 /api/state 发给**已配对的手机**——而手机只该持有
 * 自己那份可单独吊销的设备令牌。见 src/redact.mjs。
 *
 * 传函数而不是数组：配对会往 config.devices 里加设备，抹除要看到最新的。
 */
const redact = makeRedactor(() => [config.token, ...(config.devices ?? []).map((d) => d.token)])
store.setRedactor(redact)
// 审批详情是同一个洞的另一半：命令里带凭证很常见，而详情正是手机上
// 最主要显示的东西。见 ApprovalStore.setRedactor 里为什么不能动 tool_input。


const approvals = new ApprovalStore().setRedactor(redact)
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
  const quiet = ONE_SHOT
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

if (!ONE_SHOT) {
  setInterval(() => {
    approvals.sweep(86_400_000) // 记录留一天，够回看昨天的操作
    history.touch()
    healHooks()
    // 日志只增不减，一年下来能涨到几 MB。搭在这个已有的 5 分钟巡检上，
    // 不为它单开定时器
    const cut = rotateLog()
    if (cut) console.log(`[log] 日志已截断：${Math.round(cut.was / 1024)}KB → ${Math.round(cut.now / 1024)}KB`)
  }, 300_000).unref()
}

/**
 * hooks 自愈。
 *
 * `~/.claude/settings.json` 是**共享的**：别的工具往里写、用户手改、恢复
 * 备份整个覆盖——我们的条目随时可能消失。而消失之后的表现是**服务照常
 * 运行、status 一切正常、就是再也收不到任何东西**。这正是 NOTES 里的
 * 第 2 号复发故障。
 *
 * ## 只补「被覆盖」，不补「你故意卸载的」
 *
 * 判据是：**还剩至少一条我们的 hook**。
 *   · 部分缺失 → 多半是被别的写入覆盖掉了，补回来
 *   · 全部缺失 → 看起来就是 `clamicro uninstall`，不该跟用户对着干，
 *     只在日志里说一声，且**只说一次**，不刷屏
 *
 * 不这样区分的话，卸载完只要服务还活着，五分钟后 hooks 又自己回来了——
 * 那比不自愈更糟。
 */
let warnedHooksGone = false
// 「补了但补不回来」只喊一次。这是 5 分钟一轮的巡检，每轮都喊等于没喊
let warnedHooksStuck = false
function healHooks() {
  try {
    const v = verifyHooks({ port: config.port, statusLinePath: appPaths().statusLine })
    if (v.ok) {
      warnedHooksGone = false
      return
    }
    const allGone = v.missing.length >= HOOK_MAP.length + 1
    if (allGone) {
      if (!warnedHooksGone) {
        warnedHooksGone = true
        console.warn('[hooks] settings.json 里已经没有任何 clamicro 的 hook —— 视为你卸载了，不自动补回')
      }
      return
    }
    console.warn(`[hooks] 检测到缺失：${v.missing.join('、')}，正在补回`)
    const { statusLine, sessionStart } = appPaths()
    const r = install({ port: config.port, statusLinePath: statusLine, sessionStartPath: sessionStart })

    /**
     * **补完要复查**，不能补完就宣布成功。
     *
     * 有一类缺失 install 修不好：用户把某个 hook 事件手写成了非数组
     * （对象、字符串），install 只能 skip。原来这里无条件打印「✓ 已补回」
     * 并推一条通知，于是——
     *
     *   · 每 5 分钟一次「hooks 已修复」的通知，而它一次都没修好
     *   · 用户以为好了，实际上那个事件**永远收不到**
     *
     * 「说自己修好了但其实没修」比「没修」危险得多：后者你还会去查，
     * 前者你不会。这跟审批那条「宁可没有功能也不能做假功能」是同一条。
     */
    const after = verifyHooks({ port: config.port, statusLinePath: statusLine })
    if (after.ok) {
      warnedHooksStuck = false
      console.warn('[hooks] ✓ 已补回（原文件已备份）')
      notify({
        title: 'Clamicro',
        icon: '⚠',
        tint: 'warn',
        compact: true,
        short: 'hooks 已修复',
        subtitle: 'hooks 被覆盖，已自动补回',
        body: `缺失：${v.missing.join('、')}`,
      }).catch(() => {})
      return
    }

    // 补不回来。只说一次——这是每 5 分钟跑一次的巡检，
    // 每轮喊一遍等于没喊，真正要紧的那行会被自己刷掉
    const stuck = r.changes.filter((c) => c.kind === 'skip')
    if (!warnedHooksStuck) {
      warnedHooksStuck = true
      const how = stuck.length
        ? `${stuck.map((c) => `${c.event}（${c.why}）`).join('、')}`
        : after.missing.join('、')
      console.warn(
        `[hooks] ✗ 补不回来：${how}\n` +
        `        自动修复对这几项无效，需要手工改 ~/.claude/settings.json：\n` +
        `        把这些事件的值改成数组（[]），然后重跑 npx clamicro install\n` +
        `        在此之前，这些事件的上报收不到——手机上会安静地少掉对应的状态。`,
      )
      notify({
        title: 'Clamicro',
        icon: '⚠',
        tint: 'warn',
        subtitle: 'hooks 修不回来，需要你手工处理',
        body: `${after.missing.join('、')} —— 看终端日志里的说明`,
      }).catch(() => {})
    }
  } catch (err) {
    // 自愈本身不能把服务搞挂
    console.error(`[hooks] 自愈失败: ${err.message}`)
  }
}
/**
 * 启动时先查一次：多数覆盖发生在服务没跑的时候。
 *
 * **只在真的起服务时做。** 第一版没加这个判断，于是 `clamicro devices`
 * 这种纯查询命令也会改写 settings.json 并留一个备份文件——反复破坏就
 * 反复备份，无限堆积。而且它发的那条「已修复」通知还显示不出来
 * （一次性进程 exit 会带走 HUD 子进程）。
 *
 * 一句话：**只读命令不能有副作用。**
 */
if (!ONE_SHOT) healHooks()

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
  const subtitle = `${label} 需要审批${ap.risk.level === 'high' ? ' · 高风险' : ''}`
  const body = `${ap.summary}`.slice(0, 200)

  // 日志文件默认非 600，别把单条审批的 key 写进去
  console.log(`[approval] ${ap.id.slice(0, 8)} 深链 ${detailUrl.replace(/k=[^&]*/, 'k=***')}`)
  // 高危用红，普通审批用黄——余光扫一眼就知道该不该马上处理
  await notify({
    title: 'Clamicro',
    icon: ap.risk.level === 'high' ? '⚠️' : '●',
    tint: ap.risk.level === 'high' ? 'danger' : 'warn',
    subtitle,
    body,
  })
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

/**
 * 撤销信任。补上「能加不能减」这个缺口。
 *
 * `trust` 在安装流程里就会问一次，所以误信任比想象中容易发生——
 * 在咖啡厅手滑点了「是」，那个网络就永久留在列表里，下次再连上会自动暴露。
 * 只能加不能减的权限列表本身就是个设计缺陷。
 *
 *   --untrust            撤销当前网络
 *   --untrust=<id 前缀>   按 networks 列出的 id 撤销
 *   --untrust=all        全部撤销
 */
{
  const arg = process.argv.find((a) => a === '--untrust' || a.startsWith('--untrust='))
  if (arg) {
    const which = arg.includes('=') ? arg.split('=')[1] : null
    const all = config.trustedNetworks ?? {}
    let removed = []

    if (which === 'all') {
      removed = Object.values(all).map((n) => n.label)
      config.trustedNetworks = {}
    } else if (which) {
      for (const [id, n] of Object.entries(all)) {
        if (id.startsWith(which)) {
          delete all[id]
          removed.push(n.label)
        }
      }
    } else {
      const fp = fingerprint(config.lanIp)
      if (fp.id && all[fp.id]) {
        removed.push(all[fp.id].label)
        delete all[fp.id]
      }
    }

    if (!removed.length) {
      console.log(`\n  没有匹配的已信任网络${which ? `（${which}）` : '（当前网络本来就不在列表里）'}\n`)
      process.exit(1)
    }
    saveConfig(config)
    console.log(`\n  ✓ 已撤销信任：${removed.join('、')}`)
    console.log(`  服务在这些网络下将只绑本机。重启服务生效：`)
    console.log(`    npx clamicro stop  然后新开一个 Claude Code 会话\n`)
    process.exit(0)
  }
}

/**
 * 轮换访问令牌。
 *
 * 令牌是 bearer 凭证：拿到它 = 能批准任意操作，包括 rm -rf 和读 ~/.ssh。
 * 而它会通过明文 HTTP 传输、印在二维码上、出现在 URL 里——泄露途径不少
 * （局域网嗅探、屏幕被拍、截图误发）。
 *
 * 之前泄露之后**没有任何补救手段**，只能手工编辑 config.json 再重装。
 * 对一个这种权限的凭证，这是不可接受的缺口。
 *
 * 换掉之后所有旧 cookie 自动失效——sameToken 比的是新值，旧的一律不匹配。
 */
/**
 * 轮换主令牌，**并吊销所有已配对设备**。
 *
 * 原来只换主令牌、设备簿原样保留，还打印「已配对的 N 台设备不受影响」——
 * 而 README 承诺的是「every logged-in device is signed out at once」。
 * 代码和文档说的是相反的两件事。
 *
 * 按文档改代码而不是反过来：这条命令的**使用场景**是「怀疑令牌泄漏」。
 * 那种时刻你要的是一个能一键清干净的开关，不是一个还留着若干扇后门、
 * 需要你再去逐台 forget 的半吊子。想精确吊销某一台，forget <id> 一直都在。
 */
if (process.argv.includes('--rotate-token')) {
  const { randomBytes } = await import('node:crypto')
  const n = config.devices?.length ?? 0
  config.token = randomBytes(32).toString('base64url')
  config.devices = []
  saveConfig(config)
  console.log(`\n  ✓ 已换发主令牌${n ? `，并吊销全部 ${n} 台已配对设备` : ''}`)
  console.log(`  \x1b[2m泄漏的旧令牌和所有旧设备登录即刻失效。\x1b[0m`)
  if (n) console.log(`  \x1b[2m手机需要重新扫码配对： npx clamicro qr\x1b[0m`)
  console.log(`  \x1b[2m只想吊销某一台？下次用 npx clamicro forget <id>，不必全部重配。\x1b[0m\n`)
  process.exit(0)
}

/**
 * 摊开当前真正生效的完整配置，每一项标出是哪一层给的。
 *
 * ## 为什么值得一条独立命令
 *
 * `status` 答的是「现在健康吗」——版本、监听地址、hooks、网络信任。它**不答**
 * 「现在的规则是什么」：审批等多久、高危会不会自动放行、能配几台设备。而后者
 * 恰恰是行为不对劲时你最想知道的。
 *
 * 更要命的是这些值大多**看不见**：生效的 25 项里只有个位数写在 config.json 里，
 * 其余全部只存在于源码的 DEFAULTS。`cat config.json` 给你的是一份沉默的谎言——
 * 你看到的是「我改过什么」，而不是「现在按什么在跑」。
 *
 * maxDevices 就是活例子：默认 1，配置文件里没有这一项，于是「手机为什么老要
 * 重新扫码」查了半天，而答案就是那个看不见的默认值。
 *
 * ## 为什么标来源
 *
 * 只打最终值只能回答「是多少」。「10 秒」和「10 秒 ← 你自己改过」在排查时是
 * 两件不同的事——后者说明有人动过手，前者说明你在跟设计意图较劲。
 */
if (process.argv.includes('--config')) {
  const { explainConfig } = await import('./src/config.mjs')
  const rows = explainConfig(config)
  const C = { 默认值: '\x1b[2m', 配置文件: '\x1b[36m', 环境变量: '\x1b[33m', 运行时探测: '\x1b[35m' }
  const R = '\x1b[0m'
  const w = Math.max(...rows.map((r) => r.key.length))

  console.log('\n  当前生效的配置（不含令牌和设备列表）\n')
  for (const r of rows) {
    const v = r.value === null ? '—' : Array.isArray(r.value) ? `[${r.value.join(', ')}]` : String(r.value)
    console.log(`    ${r.key.padEnd(w)}  ${v.padEnd(26)} ${C[r.source] ?? ''}${r.source}${R}`)
  }

  const n = rows.reduce((a, r) => ((a[r.source] = (a[r.source] ?? 0) + 1), a), {})
  console.log(
    `\n  ${Object.entries(n).map(([k, v]) => `${k} ${v}`).join('  ·  ')}` +
      `\n  \x1b[2m「默认值」的那些在 config.json 里查不到，但一样在起作用。` +
      `改动：设置页，或直接编辑 ${CONFIG_FILE}\x1b[0m\n`,
  )
  process.exit(0)
}

/**
 * 已配对设备列表 / 吊销。
 *
 * 每台设备一个令牌，所以吊销是**单独**的——丢一台手机不必让其他设备
 * 重新配对。这正是「一个全局令牌」做不到的事。
 */
if (process.argv.includes('--devices')) {
  const ds = config.devices ?? []
  if (!ds.length) {
    console.log('\n  还没有配对过设备。用 npx clamicro qr 出码，手机扫一下。\n')
    process.exit(0)
  }
  console.log('\n  已配对的设备：')
  for (const d of ds) {
    const days = Math.round((Date.now() - d.createdAt) / 86400000)
    console.log(`    ${d.id}  ${d.name.padEnd(12)} ${days === 0 ? '今天' : days + ' 天前'}配对`)
  }
  console.log('\n  吊销： npx clamicro forget <id>   全部： npx clamicro forget all\n')
  process.exit(0)
}

{
  const arg = process.argv.find((a) => a.startsWith('--forget='))
  if (arg) {
    const which = arg.split('=')[1]
    const all = config.devices ?? []
    const gone = which === 'all' ? all.slice() : all.filter((d) => d.id.startsWith(which))
    if (!gone.length) {
      console.log(`\n  没有匹配的设备（${which}）。看一眼： npx clamicro devices\n`)
      process.exit(1)
    }
    config.devices = which === 'all' ? [] : all.filter((d) => !d.id.startsWith(which))
    saveConfig(config)
    console.log(`\n  ✓ 已吊销：${gone.map((d) => `${d.name}（${d.id}）`).join('、')}`)
    // 原来这里两行自相矛盾：先说「立即失效」，紧接着说「重启服务生效」。
    // 现在服务会热加载配置（server.mjs 的 watchConfig），「立即」是真的了
    console.log(`  这些设备上的登录即刻失效，其他设备不受影响。\n`)
    process.exit(0)
  }
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
//
// 二维码里放的是一次性配对 id，所以必须向**运行中的**服务申请——
// 这个进程只是个短命的 CLI，它自己生成的 id 没人认。
if (process.argv.includes('--qr')) {
  let pairId = null
  try {
    const r = await fetch(`http://127.0.0.1:${config.port}/api/pair/new`, {
      method: 'POST',
      headers: { 'X-CCM': '1' },
      signal: AbortSignal.timeout(2000),
    })
    pairId = (await r.json()).id
  } catch {
    console.error('\n  服务没在跑，拿不到配对码。')
    console.error('  新开一个 Claude Code 会话（SessionStart hook 会拉起服务），或 npx clamicro start\n')
    process.exit(1)
  }
  const loginUrl = `${config.baseUrl}/ui/pair/${pairId}`

  /**
   * 猫蹲在二维码上面。
   *
   * 不是随手贴的吉祥物：它在 DSH 网页里的**唯一职责**就是点一下把这个二维码
   * 叫出来，这里是同一件事换了个界面。
   *
   * 画不出来（非 TTY、NO_COLOR、只有 16 色）就返回空串，一个字都不打——
   * 它是点缀，绝不能挤走二维码本身，更不能在管道里吐一屏转义序列。
   */
  if (!process.argv.includes('--no-cat')) {
    const { catBlock } = await import('./src/cat.mjs')
    const cat = catBlock()
    if (cat) process.stdout.write(`\n${cat}`)
  }

  console.log(`\n  ${loginUrl}`)
  console.log(`  \x1b[2m一次性，60 秒内有效\x1b[0m\n`)
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync('qrencode', ['-t', 'ANSIUTF8', '-m', '2', loginUrl], { stdio: 'inherit' })
  if (r.error) console.log('（装了 qrencode 可以直接扫码：brew install qrencode）')
  if (config.altUrl) {
    console.log(`\n  用的是 Bonjour 主机名，换 Wi-Fi/换 IP 后依然有效。`)
    console.log(`  万一手机解析不了 .local，改用：${config.altUrl}/ui/pair/${pairId}\n`)
  }
  process.exit(0)
}

// ---- 手动测试提醒：node server.mjs --test-push ----
if (process.argv.includes('--test-push')) {
  const { hudDone } = await import('./src/hud.mjs')
  await notify({ title: 'Clamicro', subtitle: '测试通知', body: '看到这条，说明提醒通道是通的' })
  // 等 HUD 播完再退。HUD 是子进程，这里一 exit 它就没了——自检会打印
  // 「提醒通道是通的」而屏幕上什么都没出现过，比不做自检还糟。
  await hudDone()
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
    // 后端出身。审批卡片要能一眼看出「这条是哪个 harness 问的」——
    // 两个后端同时有待审批时，没有出身字段的卡片长得一模一样，而它们的
    // 后续能力（暂停/取消）和语义并不相同。agent_label 由服务端一次解析好，
    // 前端不必再拉能力表；认不出就落回原始 key，不假装是 Claude Code。
    agent: s?.agent ?? null,
    agent_label: s?.agent ? (AGENTS[s.agent]?.label ?? s.agent) : null,
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
    // 选择题的题干和选项。只有 AskUserQuestion 有，其余是空数组。
    // 手机据此渲染成可点的列表，而不是把原始 JSON 摊在屏幕上
    choices: a.choices ?? [],
    answer: a.answer ?? null,
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
const pairing = new PairingStore()
// 等 Mac 确认的那一段。扫码请求立刻返回等待页，结果落这里，手机轮询取。
const confirms = new ConfirmStore()
// 传函数不是数组：配对成功会往 config.devices 里加，鉴权必须看到最新的那份
// 两个都传函数：令牌和设备簿都可能被 CLI 从另一个进程改掉，见 watchConfig
const auth0 = makeAuth(() => config.token, () => config.devices ?? [])

/**
 * 配置热加载 —— 让吊销真的是「立即」。
 *
 * ## 修的是什么
 *
 * `clamicro forget <id>`（手机丢了的标准处置）和 `clamicro rotate-token`
 * （怀疑令牌泄漏的标准处置）都是**独立的 CLI 进程**：它们只改磁盘上的
 * config.json，而运行中的服务在启动那一刻就把配置读进内存了，此后再没读过。
 *
 * 后果是这两条命令**都不生效，直到重启服务**：
 *   · forget 之后，丢掉的那台手机继续能批准 rm -rf
 *   · rotate 之后，泄漏的旧令牌继续有效，新令牌反而 401
 *
 * 而 forget 自己打印的是「这些设备上的登录**立即失效**」——紧接着下一行
 * 又说「重启服务生效」。两行自相矛盾，而先看到的那行是假的。
 * 在一个安全工具里，「我以为已经吊销了」比「知道自己没吊销」危险得多。
 *
 * ## 只热加载安全相关的三项
 *
 * token / devices / trustedNetworks。端口、baseUrl 这些是启动时确定的
 * （套接字已经绑好了），中途换掉只会让内存状态和实际监听对不上。
 *
 * ## 解析失败就保持原样
 *
 * saveConfig 不是原子写，watch 完全可能读到写了一半的文件。这时候
 * **保留当前配置**是唯一安全的选择：把 token 换成 undefined 会让所有
 * 请求 401，把 devices 换成空数组会让所有手机掉线——一次写盘抖动
 * 不该造成全员登出。
 */
function watchConfig() {
  let timer = null
  try {
    watch(CONFIG_FILE, () => {
      // fs.watch 一次写盘常常触发多次，压一下
      clearTimeout(timer)
      timer = setTimeout(() => {
        let next
        try {
          next = loadConfig()
        } catch {
          return // 多半是读到了写一半的文件，下一次事件会再来
        }
        if (!next || typeof next.token !== 'string' || !next.token) return
        const before = { token: config.token, n: config.devices?.length ?? 0 }
        config.token = next.token
        config.devices = next.devices ?? []
        config.trustedNetworks = next.trustedNetworks ?? {}
        const after = { token: config.token, n: config.devices.length }
        // 只在真的变了时说话，否则每次写盘都刷一行
        if (before.token !== after.token) console.log('[config] 主令牌已轮换，旧令牌即刻失效')
        if (before.n !== after.n) console.log(`[config] 设备簿已更新：${before.n} → ${after.n} 台`)
      }, 150)
    })
  } catch (err) {
    // 监听不了不该拖垮服务——退化成「重启才生效」，也就是修之前的行为
    console.warn(`[config] 无法监听配置文件，吊销类命令需重启服务才生效：${err?.message ?? err}`)
  }
}
if (!ONE_SHOT) watchConfig()
const { sameToken, authorized, loginCookie } = auth0

const auth = auth0
const handleHooks = hookRoutes({
  config, store, approvals, control, inbox, history, notify, notifyApproval,
})
const handlePages = pageRoutes({
  config, approvals, notify, auth, publicApproval, HERE,
  pairing, confirms, addDevice, saveConfig,
})
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
      /**
       * `service` 只对**回环**请求返回。
       *
       * 用途：CLI 在 kill 之前确认「端口上这个进程真的是 clamicro」。
       * 原来 stop / 安装流程是 `lsof -ti tcp:8765` 拿到 PID 就直接 kill，
       * 不校验身份——8765 不是保留端口，被别的程序占着的话，
       * `npx clamicro stop` 会**杀掉一个无辜进程**，而且悄无声息。
       *
       * 不对局域网返回：`{ok:true}` 是匿名的，加上 service 就等于告诉
       * 同网段的任何扫描者「这台机器上有个能批准操作的服务」。
       * 本机的 CLI 走回环，拿得到；外面拿不到。
       */
      return json(res, 200, {
        ok: true,
        stale: detectLanIp() !== config.lanIp,
        ...(isLoopback(req) ? { service: 'clamicro', pid: process.pid } : {}),
      })
    }

    // hooks / statusLine 一律只认本机来源，见 isLoopback 的说明
    // /api/pair/new 能凭空造一个配对 id，等于发一张登录券——必须只认本机。
    // 局域网上任何人都能造券的话，一次性和过期就都白设了。
    if ((path.startsWith('/hooks/') || path === '/statusline' || path === '/api/pair/new') && !isLoopback(req)) {
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
    title: 'Clamicro',
      subtitle: '已收缩到本机',
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

  /**
   * **拿不到网关 ≠ 换到了陌生网络。**
   *
   * fingerprint 在取不到默认网关时返回 `id: null`（未联网）。而全隧道 VPN
   * 周期性重连、Wi-Fi 抖一下，都会制造这么一个瞬间。以前这里把 null 当成
   * 「一个不认识的新网络」，于是**摘掉局域网监听**——手机当场连不上，
   * 而 `networks` 还显示当前网络已信任，看不出任何异常。
   *
   * 收缩是有代价的动作，不能在证据不足时执行。信息缺失就什么都不做，
   * 等下一次事件——网络真变了，下一次一样能判出来。
   */
  if (!fp.id) return
  if (fp.id === currentNetId) return
  currentNetId = fp.id

  if (isTrusted(config, fp)) {
    console.log(`[clamicro] 网络变为「${fp.label}」（已信任）`)
    /**
     * **恢复必须和收缩对称。**
     *
     * 以前这条分支只打日志。于是任何一次误判（哪怕下一秒就纠正）都会让
     * 局域网监听**永久消失**，直到进程重启——日志里「未被信任」和「已信任」
     * 反复横跳，而实际状态一路单向退化成只剩回环。
     *
     * 「失败即收缩」是对的策略，但它的前提是「恢复也要真的发生」。
     * 只有一半的策略不是保守，是坏掉。
     */
    if (ip && !servers.has(ip)) {
      listenOn(ip)
      console.log(`[clamicro] 已恢复局域网监听 ${ip}:${config.port}`)
    }
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
      title: 'Clamicro',
      subtitle: '已收缩到本机',
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
