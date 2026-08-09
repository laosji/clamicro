import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, copyFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'

export const CONFIG_DIR = join(homedir(), '.claude', 'clamicro')
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
export const TUNNEL_PID_FILE = join(CONFIG_DIR, 'tunnel.pid')

/**
 * 隧道进程还活着吗。
 *
 * publicBaseUrl 是**落盘持久化**的，而 quick tunnel 的地址是**临时**的：
 * 重启、进程被杀、Cloudflare 那端断开，地址立刻作废。两者寿命不一致，
 * 结果就是配置里留着一个死地址，而 baseUrl 无条件用它——
 * 之后生成的每个二维码、每条推送深链都指向一个打不开的域名，
 * 而且没有任何报错。踩过一次。
 *
 * 所以地址能不能用，以**进程是否存在**为准，不以配置里写了什么为准。
 */
export function tunnelAlive() {
  if (!existsSync(TUNNEL_PID_FILE)) return false
  const pid = Number(readFileSync(TUNNEL_PID_FILE, 'utf8').trim())
  if (!pid) return false
  try {
    process.kill(pid, 0) // 信号 0 只探测存在性，不真的发信号
    return true
  } catch {
    return false
  }
}

const DEFAULTS = {
  port: 8765,
  // 绑回环 + 局域网网卡。null 表示自动探测本机局域网 IP。
  // 手机与 Mac 同一 Wi-Fi 时直连这个地址，审批指令不出局域网。
  bind: ['127.0.0.1', null],
  token: null, // 首次启动自动生成
  // 深链基址。留空则按 hostMode 自动决定。
  publicBaseUrl: null,
  // 'ip'（默认，一定能通）| 'hostname'（.local，换 IP 不用重扫）| 'auto'
  //
  // 默认必须是 IP。.local 的好处是 DHCP 换 IP 后旧链接依然有效，但
  // **Mac 无法验证手机能否解析它**——Mac 自己解析 .local 走的是回环，
  // 永远成功，所以服务端的任何"探测"都是假的。受管网络常屏蔽组播，
  // 结果就是二维码扫了打不开，而这是硬故障；IP 变了要重扫只是麻烦。
  // 想用 .local 的话，登录后由手机自己探测，通了再在设置页切过去。
  hostMode: 'ip',
  notify: {
    // macOS 本地通知，是现在**唯一**的提醒通道。完全不联网。
    // 远程推送（ntfy 中转、Bark）都删掉了，理由见 src/notify.mjs 的注释：
    // 锁屏可达必须经第三方，而这个产品的前提是近场。
    macNotify: true,
    // Stop 在每一轮助手回复结束时都触发，包括 2 秒就结束的对话。
    // 低于这个时长的 turn 不提醒，否则每问一句都响一次。
    minTurnMs: 30_000,
    onStop: true,
    onError: true,
    // 会自动通过的操作是否也提醒。默认否——提醒了也来不及看，只是噪音。
    notifyAutoApproved: false,
    // 5 小时窗口用量达到这个百分比时提醒一次。0 = 关闭。
    // 目的是别让长任务跑到一半突然被限流卡住。
    quotaWarnPct: 90,
    /**
     * 提醒长什么样：
     *
     *   'notch'  刘海位置的胶囊。看着像系统连外设那条，但**不进通知中心**——
     *            划过去就没了，人不在屏幕前等于没发生。
     *   'banner' 系统标准通知。会留在通知中心，回来还能翻到。
     *   'both'   两个都来。审批这类「错过了代价很大」的场景可以用，
     *            代价是同一件事在屏幕上出现两次。
     */
    style: 'notch',
  },
  /**
   * `clamicro status` 时查一下 registry 上有没有新版。
   *
   * **这是整个工具唯一一次主动对外的网络请求。** 只发给 registry.npmjs.org，
   * 只在你手动敲 status 时发，结果缓存一天，超时 1.5 秒，失败完全静默。
   *
   * 之所以破例联网：2.0.1 及更早的版本会把主令牌泄漏进事件流（任何已配对
   * 的手机都能读回来）。一个管审批的工具，不告诉用户「你这版有安全问题」
   * 是说不过去的。不想要就设成 false，一次都不会发。
   */
  checkUpdates: true,
  approval: {
    // 普通风险操作：无人操作多久后「自动通过」。0 = 关闭，退回自动拒绝。
    // 目的是别为 npm run build 这种事打扰你。
    autoApproveMs: 10_000,
    // 高风险操作、以及关闭自动通过时：多久后「自动拒绝」。
    // 必须小于 hook 的 600s 超时，否则会被当成非阻塞错误放行到正常权限流程。
    timeoutMs: 570_000,
    // 高风险是否也自动通过。默认 false —— 开了等于 rm -rf 在你不在时会自己放行。
    autoApproveHighRisk: false,
  },
  // 同时能有几台手机配对。默认 1 —— 不是为了挡攻击者（局域网明文，
  // 嗅到 cookie 直接重放，不用配对），而是让「多出来一台」必然顶掉你，
  // 从而变得看得见。要 iPhone + iPad 同时用就改成 2。
  maxDevices: 1,
  // 已配对的设备，每台一个独立令牌。丢一台单独吊销即可。
  devices: [],
  // 已信任的网络。只有在这些网络里才会把服务暴露到局域网；
  // 换到陌生网络（咖啡厅、机场）时自动只绑回环，等你显式确认。
  trustedNetworks: {},
  // 这些工作目录下的会话不做阻塞审批（开发 clamicro 自身时避免自己卡自己）
  ignoreCwds: [],
}

/**
 * 项目早期叫 cc-monitor，配置放在 ~/.claude/cc-monitor。
 * 直接换目录会让人丢掉 token 和已信任网络列表——
 * 表现是「装完发现要重新扫码、推送也没了」，而且看不出原因。整个搬过来。
 */
function migrateLegacyDir() {
  const legacy = join(homedir(), '.claude', 'cc-monitor')
  if (!existsSync(legacy)) return
  // 判断依据必须是「配置文件」而不是「目录」：安装器会先把运行时同步到
  // <CONFIG_DIR>/app，目录因此提前存在，用目录判断会直接跳过迁移，
  // 表现就是 token 重新生成、已信任网络丢失，而且没有任何报错。
  mkdirSync(CONFIG_DIR, { recursive: true })
  for (const name of ['config.json', 'history.json']) {
    const from = join(legacy, name)
    const to = join(CONFIG_DIR, name)
    if (existsSync(from) && !existsSync(to)) {
      copyFileSync(from, to)
      console.log(`[config] 已从旧目录迁移 ${name}`)
    }
  }
}

function deepMerge(base, override) {
  if (override == null || typeof override !== 'object' || Array.isArray(override)) {
    return override === undefined ? base : override
  }
  const out = { ...base }
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? deepMerge(base[k], v)
      : v
  }
  return out
}

export function loadConfig() {
  migrateLegacyDir()
  mkdirSync(CONFIG_DIR, { recursive: true })

  let onDisk = {}
  if (existsSync(CONFIG_FILE)) {
    try {
      onDisk = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    } catch (err) {
      throw new Error(`${CONFIG_FILE} 不是合法 JSON: ${err.message}`)
    }
  }

  const config = deepMerge(DEFAULTS, onDisk)

  let dirty = !existsSync(CONFIG_FILE)
  if (!config.token) {
    config.token = randomBytes(32).toString('base64url')
    dirty = true
  }
  // 远程推送已全部删除（ntfy 中转、Bark）。老配置里的 relay / push 段都是
  // 死配置，而且**里面装着凭证**——relay 的 topic 名、Bark 的 device key。
  // 留着既没人读，又让人以为这条通路还在，还多一份泄漏面。
  if ('relay' in config) {
    delete config.relay
    dirty = true
    console.log('[config] 已移除废弃的 relay 配置（ntfy 中转已下线）')
  }
  if ('push' in config) {
    // macNotify 是唯一还有意义的字段，搬进 notify 段
    if (typeof config.push?.macNotify === 'boolean') config.notify.macNotify = config.push.macNotify
    delete config.push
    dirty = true
    console.log('[config] 已移除废弃的 push 配置（远程推送已下线，含其中的 Bark key）')
  }
  // detailInPush 只对远程推送有意义——本地通知就在你自己电脑上
  if ('detailInPush' in (config.notify ?? {})) {
    delete config.notify.detailInPush
    dirty = true
  }

  /**
   * 自愈：丢掉 bind 里钉着的、本机已经没有的地址。
   *
   * 旧版本的 saveConfig 会把探测结果写回盘（见那边的注释），于是 bind 里留下
   * 一个具体 IP。换网络后那个地址不属于本机，listen 报 EADDRNOTAVAIL，服务
   * 只剩回环——而且 null 占位符已经被覆盖掉，新网络的 IP 永远绑不上。
   *
   * saveConfig 那边的修复只防新污染，治不了已经写坏的配置，所以这里再兜一道。
   * 必须放在写盘之前，否则清理结果落不了地。
   */
  if (Array.isArray(config.bind)) {
    const local = new Set(
      Object.values(networkInterfaces()).flat().filter(Boolean).map((a) => a.address),
    )
    const before = JSON.stringify(config.bind)
    config.bind = config.bind.filter((h) => h === null || h === '127.0.0.1' || local.has(h))
    if (!config.bind.includes(null)) config.bind.push(null)
    if (JSON.stringify(config.bind) !== before) {
      console.log('[config] 已清理 bind 里失效的地址，恢复自动探测')
      dirty = true
    }
  }
  if (dirty) {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
    chmodSync(CONFIG_FILE, 0o600) // 含访问 token
    console.log(`[config] 已写入 ${CONFIG_FILE}`)
  }

  // 允许用环境变量覆盖端口：跑第二个实例做测试时，不该抢正式实例的端口。
  // 记住盘上的原值——这是运行时覆盖，不该被 saveConfig 固化下来。
  config.persistedPort = config.port
  if (process.env.CLAMICRO_PORT) config.port = Number(process.env.CLAMICRO_PORT) || config.port
  config.lanIp = detectLanIp()
  config.tailscaleIp = detectTailscaleIp()
  config.localHost = detectLocalHostname()
  // bind 里的 null 占位换成探测到的局域网 IP；探测不到就丢掉那一项
  config.bind = [...new Set(config.bind.map((h) => (h === null ? config.lanIp : h)).filter(Boolean))]
  // Tailscale 是 WireGuard 加密的覆盖网，不受所在物理网络影响，
  // 因此不需要「信任当前网络」那道闸门，也不怕同网段嗅探。
  if (config.tailscaleIp && !config.bind.includes(config.tailscaleIp)) {
    config.bind.push(config.tailscaleIp)
  }

  const host =
    config.hostMode === 'ip'
      ? config.lanIp
      : config.hostMode === 'hostname'
        ? config.localHost
        : config.localHost || config.lanIp
  // 隧道地址只在进程还活着时才算数，否则回落局域网。
  // 不改盘上的 publicBaseUrl——那是用户/CLI 写的，读取不该有写副作用。
  config.tunnelUrl = config.publicBaseUrl && tunnelAlive() ? config.publicBaseUrl : null
  if (config.publicBaseUrl && !config.tunnelUrl) {
    console.log(`[clamicro] 隧道已不在运行，忽略失效地址 ${config.publicBaseUrl}，回落局域网`)
  }
  config.baseUrl = config.tunnelUrl || `http://${host || '127.0.0.1'}:${config.port}`
  // 兜底地址：主机名解析不了时给用户的另一条路
  config.altUrl = config.lanIp && host !== config.lanIp ? `http://${config.lanIp}:${config.port}` : null
  return config
}

/** 把运行时改动写回磁盘。这几个是每次启动重新探测的派生值，不落盘。 */
export function saveConfig(config) {
  const { baseUrl, altUrl, lanIp, localHost, tailscaleIp, tunnelUrl, persistedPort, ...persist } = config
  // 端口写回盘上的原值，别把环境变量的临时覆盖固化进去
  if (persistedPort != null) persist.port = persistedPort

  /**
   * bind 里的 null 是「启动时自动探测局域网 IP」的占位符，loadConfig 会把它
   * 换成探测结果。**换完的结果绝不能落盘。**
   *
   * 踩过一次，代价是两天：一旦固化成具体 IP，换网络后那个地址不属于本机，
   * listen 报 EADDRNOTAVAIL，服务只剩回环——手机连不上，而 `status` 显示
   * 「运行中 ✓ 已信任」，看不出任何异常。
   *
   * 最坑的是触发点：`clamicro trust` 会调 saveConfig，于是那条**专门用来
   * 开放局域网访问**的命令，执行一次就锁死了之后所有网络的绑定。
   *
   * 其他派生值（lanIp、baseUrl…）都是顶层字段，解构就剥掉了；bind 是唯一
   * 一个把派生值藏在数组里的，所以要单独还原。
   */
  if (Array.isArray(persist.bind)) {
    persist.bind = [...new Set(persist.bind.map((h) => (h && (h === lanIp || h === tailscaleIp) ? null : h)))]
    if (!persist.bind.includes(null)) persist.bind.push(null)
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(persist, null, 2))
  chmodSync(CONFIG_FILE, 0o600)
}

/**
 * Tailscale 地址（100.64.0.0/10）。
 * 它是端到端加密的覆盖网——在咖啡厅这种开放网络上，只有这条路能保证
 * 同网段的人看不到明文。detectLanIp 刻意把它排除掉了，这里单独取。
 */
function detectTailscaleIp() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) {
        return a.address
      }
    }
  }
  return null
}

/** macOS 的 Bonjour 主机名。DHCP 换 IP 也不变，比裸 IP 稳。 */
function detectLocalHostname() {
  const r = spawnSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' })
  const name = (r.stdout ?? '').trim()
  // 只接受能安全放进 URL 的名字
  return /^[A-Za-z0-9-]+$/.test(name) ? `${name}.local` : null
}

/** 探测本机局域网 IPv4。优先 en0（Mac 上通常是 Wi-Fi）。 */
/** 导出给 server 的网络巡检用：IP 会在运行期变（DHCP 续租、换 Wi-Fi） */
export function detectLanIp() {
  const ifaces = networkInterfaces()
  const candidates = []
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      // 排除 Tailscale(100.64/10)、Docker 网桥等虚拟网卡
      if (name.startsWith('utun') || name.startsWith('bridge') || name.startsWith('llw')) continue
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) continue
      candidates.push({ name, address: a.address })
    }
  }
  return (candidates.find((c) => c.name === 'en0') ?? candidates[0])?.address ?? null
}
