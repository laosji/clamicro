/**
 * `npx clamicro doctor` —— 一份能直接粘进 issue 的现场。
 *
 * ## 为什么单独有这么一条命令
 *
 * `status` 回答的是「服务好着没」，它面向**已经跑起来的人**。而装到手机上
 * 这条路有七步（环境 → 改 settings.json → 信任网络 → 起服务 → 手机开网址 →
 * 在 Mac 上按允许 → 走完演示审批），任何一步失败人就走了，而我们**永远不会
 * 知道他卡在第几步**：没有遥测（这是对的，控制面不外发），没有 issue 模板，
 * 手机 UI 里也没有反馈入口。
 *
 * 于是这条命令做两件 status 不做的事：
 *
 *   1. **按那七步排队检查**，并在最上面给出一句「看起来卡在第 N 步」。
 *      诊断放在最前面，是因为贴报告的人多半也想知道答案。
 *   2. **输出是可粘贴的 markdown，且脱过敏**。要人手打一份现场，等于要不到。
 *
 * ## 脱敏的判据
 *
 * 抹掉的是**能定位到人**的东西，不是能定位到故障的东西：
 *
 *   · 令牌一个都不取（这里从头到尾不读 config.token）
 *   · 家目录路径压成 `~`（`/Users/<真名>` 是最常见的一处泄漏）
 *   · SSID / 搜索域整个不出现，只说指纹辨识度够不够
 *   · 局域网 IP 只留网段（`192.168.1.x`）—— 网段能判「只绑了回环吗」，
 *     主机位不能判任何事
 *   · 设备只报数量，不报名字（名字来自 User-Agent，常带机主名）
 *
 * 所有探测都可注入，测试不碰真实环境。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'

/** `/Users/someone/x` → `~/x`。家目录路径是这份报告里最常见的一处身份泄漏。 */
export function tildify(s) {
  if (typeof s !== 'string' || !s) return s
  return s.split(homedir()).join('~')
}

/**
 * `192.168.1.23` → `192.168.1.x`。网段够判故障，主机位不够判任何事。
 *
 * 回环和通配一个字都不能动：`127.0.0.1` 被抹成 `127.0.0.x` 之后，
 * 「只绑了回环」这条最要紧的判断在报告上就读不出来了 —— 而那正是
 * 「手机连不上」最常见的原因。
 */
const KEEP = new Set(['127.0.0.1', '::1', '0.0.0.0', '*'])
export function maskIp(ip) {
  if (typeof ip !== 'string') return null
  const t = ip.trim()
  if (KEEP.has(t)) return t
  const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(t)
  return m ? `${m[1]}.x` : t
}

const bin = (name, args = ['--version']) =>
  spawnSync(name, args, { stdio: 'ignore' }).status === 0

/** 实际监听了哪些地址。只回地址，不回端口和进程。 */
function boundAddrs(port) {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
  return [...new Set((r.stdout ?? '').split('\n').slice(1)
    .map((l) => l.trim().split(/\s+/)[8]).filter(Boolean)
    .map((a) => a.replace(`:${port}`, '')))]
}

function listeners(port) {
  const r = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
  return (r.stdout ?? '').trim().split('\n').filter(Boolean)
}

/**
 * 事件历史。**读盘，不问服务**——服务没起来的时候恰恰是最需要这份数据的时候
 * （「装完了，一条事件都没有」和「服务挂了」是两种完全不同的故障）。
 */
function readHistory(file) {
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'))
    const events = d.events ?? []
    const last = events.length ? events[events.length - 1] : null
    return {
      approvals: (d.approvals ?? []).length,
      events: events.length,
      lastAt: last?.at ?? last?.ts ?? null,
    }
  } catch {
    return { approvals: 0, events: 0, lastAt: null }
  }
}

/**
 * 采集。每一项探测都能被替换掉，测试里传假的进来。
 *
 * 任何一项抛异常都只让那一项变成 null，不能让整份报告拿不到——
 * 一个只在环境正常时才跑得出来的诊断工具没有意义。
 */
export async function collect(o = {}) {
  const {
    pkgVersion = null,
    now = Date.now(),
    config = {},
    appDir = '',
    settingsFile = '',
    historyFile = '',
    runtimeVersion = null,
    verifyHooks = null,
    fingerprint = null,
    isTrusted = null,
    weakNote = null,
    hasDsh = null,
    isDshWired = null,
    hasCodex = null,
    verifyCodex = null,
    probe = {},
  } = o

  const p = {
    node: () => process.versions.node,
    os: () => spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).stdout?.trim() || null,
    curl: () => bin('curl'),
    qrencode: () => bin('qrencode'),
    listeners,
    boundAddrs,
    history: () => readHistory(historyFile),
    settingsExists: () => existsSync(settingsFile),
    ...probe,
  }

  const safe = (fn, fallback = null) => { try { return fn() } catch { return fallback } }

  const port = config.port ?? 8765
  const alive = safe(() => p.listeners(port).length > 0, false)
  const bound = alive ? safe(() => p.boundAddrs(port), []) : []
  const net = safe(() => (fingerprint ? fingerprint(config.lanIp) : null))
  const nodeMajor = Number(String(p.node()).split('.')[0])

  return {
    at: new Date(now).toISOString(),
    os: safe(p.os),
    node: p.node(),
    nodeOk: nodeMajor >= 18,
    curl: safe(p.curl, false),
    qrencode: safe(p.qrencode, false),

    pkgVersion,
    runtimeVersion,
    appDir: tildify(appDir),

    settingsExists: safe(p.settingsExists, false),
    hooks: safe(() => (verifyHooks ? verifyHooks({ port }) : null)),

    lanIp: maskIp(config.lanIp ?? null),
    addressMode: config.addressMode ?? null,
    network: net && {
      known: Boolean(net.id),
      trusted: safe(() => (isTrusted ? isTrusted(config, net) : null), null),
      weak: Boolean(net.weak),
      // label 里可能是 SSID 或搜索域，两样都别往报告里放
      weakNote: safe(() => (weakNote ? Boolean(weakNote(net)) : false), false),
      signals: ['gateway', 'mac', 'ssid', 'subnet'].filter((k) => net[k]),
    },
    trustedCount: Object.keys(config.trustedNetworks ?? {}).length,

    port,
    alive,
    bound: bound.map((a) => maskIp(a)),
    lanBound: bound.some((a) => a !== '127.0.0.1' && a !== '::1'),

    devices: (config.devices ?? config.deviceBook ?? []).length ?? 0,
    history: safe(p.history, { approvals: 0, events: 0, lastAt: null }),

    dsh: safe(() => (!hasDsh?.() ? 'none' : isDshWired?.() ? 'wired' : 'detected'), 'unknown'),
    codex: safe(() => {
      if (!hasCodex?.()) return 'none'
      const v = verifyCodex?.(port)
      if (!v?.present) return 'detected'
      if (v.missing?.length || !v.portOk) return 'broken'
      return v.trustSeen ? 'wired' : 'wired-untrusted'
    }, 'unknown'),

    tunnel: Boolean(config.tunnel?.url),
    ignoreCwds: (config.ignoreCwds ?? []).length,
  }
}

/**
 * 七步漏斗，按顺序找**第一个**断掉的地方。
 *
 * 只报第一个：后面的检查大多是前面那一步的下游（网络没信任 → 只绑回环 →
 * 没有设备 → 没有事件），四条一起报等于让人从四个方向去猜同一个原因。
 */
export function diagnose(f) {
  if (!f.nodeOk) {
    return { step: 1, what: `Node 版本太低（${f.node}，需要 ≥ 18）`, fix: '升级 Node 后重跑 npx clamicro install' }
  }
  if (!f.settingsExists || !f.hooks) {
    return { step: 2, what: '读不到 ~/.claude/settings.json', fix: 'npx clamicro install' }
  }
  if (!f.hooks.ok) {
    return { step: 2, what: `hooks 缺 ${f.hooks.missing.join('、')} —— 服务跑着也收不到任何事件`, fix: 'npx clamicro install' }
  }
  if (!f.lanIp) {
    return { step: 3, what: '没探测到局域网地址，手机没有能连的地方', fix: '确认 Mac 连着 Wi-Fi，再重跑 npx clamicro install' }
  }
  if (f.network && f.network.known && f.network.trusted === false) {
    return { step: 3, what: '当前网络没被信任，服务只会绑回环', fix: 'npx clamicro trust' }
  }
  if (!f.alive) {
    return { step: 4, what: '服务没在跑', fix: '开一个 Claude Code 会话会自动拉起它；或跑 npx clamicro start 看报什么错' }
  }
  if (!f.lanBound) {
    return { step: 4, what: '服务只绑了回环，手机连不上', fix: 'npx clamicro logs 看有没有 EADDRNOTAVAIL；多半是换过网络' }
  }
  if (!f.devices) {
    return { step: 5, what: '还没有任何手机配对成功', fix: '手机打开那个网址 → 点「在 Mac 上显示二维码」→ 扫 → 在 Mac 上点「允许」' }
  }
  if (!f.history.events) {
    return { step: 7, what: '配对好了，但一条事件都没收到过', fix: '新开一个 Claude Code 会话（hooks 是会话启动时挂上的）' }
  }
  if (f.codex === 'wired-untrusted') {
    return { step: 7, what: 'Codex 的 hooks 写进去了，但没看到信任记录 —— 没信任时它会静默跳过', fix: '打开一次 Codex 并同意那个 hooks 信任提示' }
  }
  return null
}

const yn = (v) => (v === true ? '是' : v === false ? '否' : '不知道')

const DSH_TEXT = {
  none: '未检测到',
  detected: '检测到但没接（npx clamicro connect dsh）',
  wired: '已接入',
  unknown: '查不到',
}
const CODEX_TEXT = {
  none: '未检测到',
  detected: '检测到但没接（npx clamicro connect codex）',
  'wired-untrusted': '已写入，但没看到信任记录',
  broken: '配置不完整（npx clamicro install）',
  wired: '已接入',
  unknown: '查不到',
}

/** 渲染成可以整段粘走的 markdown。 */
export function render(f) {
  const d = diagnose(f)
  const L = []

  L.push('### clamicro doctor')
  L.push('')
  L.push(d
    ? `**看起来卡在第 ${d.step} 步：${d.what}**\n\n试：\`${d.fix}\``
    : '**七步都通了。** 如果还是不对劲，把下面这张表和你实际看到的现象一起贴出来。')
  L.push('')

  const rows = [
    ['包 / 运行时', `${f.pkgVersion ?? '?'} / ${f.runtimeVersion ?? '未安装'}`],
    ['系统 / Node', `macOS ${f.os ?? '?'} · Node ${f.node}`],
    ['curl / qrencode', `${yn(f.curl)} / ${yn(f.qrencode)}${f.qrencode ? '' : '（没有也能用，配对时弹地址而不是码）'}`],
    ['hooks', !f.hooks
      ? '读不到 settings.json'
      : f.hooks.ok
        ? `完整${f.hooks.statusLine === 'ours' ? '' : ' · statusLine 被别的工具占着，额度采不到'}`
        : `缺 ${f.hooks.missing.join('、')}`],
    ['局域网地址', `${f.lanIp ?? '没探测到'}${f.addressMode ? ` · 模式 ${f.addressMode}` : ''}`],
    ['当前网络', !f.network
      ? '查不到'
      : !f.network.known
        ? '未联网'
        : `${f.network.trusted ? '已信任' : '未信任'} · 可辨识信号 ${f.network.signals.length}/4${f.network.weak ? ' · 辨识度低' : ''}`],
    ['信任过的网络', String(f.trustedCount)],
    ['服务', `${f.alive ? '运行中' : '未运行'} :${f.port}`],
    ['监听', f.bound.length ? f.bound.join('、') : '（没有）'],
    ['已配对设备', String(f.devices)],
    ['历史', `事件 ${f.history.events} · 审批 ${f.history.approvals}`],
    ['DSH', DSH_TEXT[f.dsh] ?? f.dsh],
    ['Codex', CODEX_TEXT[f.codex] ?? f.codex],
  ]
  if (f.tunnel) rows.push(['隧道', '开着'])
  // 旁路必须看得见：这些目录里的操作一条都不拦，而每一项检查都会显示正常
  if (f.ignoreCwds) rows.push(['⚠️ 免审批目录', `${f.ignoreCwds} 个（这些目录下完全不拦截）`])

  L.push('| 检查 | 结果 |')
  L.push('|---|---|')
  for (const [k, v] of rows) L.push(`| ${k} | ${v} |`)
  L.push('')
  L.push(`<sub>${f.at} · 运行时 ${f.appDir}</sub>`)

  return L.join('\n')
}
