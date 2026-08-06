import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, copyFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'

export const CONFIG_DIR = join(homedir(), '.claude', 'clamicro')
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

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
  // ntfy 双 topic 中转。默认关闭：开启后审批指令会经过第三方公网服务器。
  // 只在「人不在同一 Wi-Fi、但仍想审批」时才打开——对应原方案第 7 节的后续扩展。
  relay: {
    enabled: false,
    server: 'https://ntfy.sh',
    notifyTopic: null, // Mac → 手机（通知，带审批按钮）
    commandTopic: null, // 手机 → Mac（审批指令）
  },
  // 附加通知通道。relay 开启时这里可留 none；想同时收 Bark 就填 bark。
  // 注意 Bark 不支持通知内按钮，只能点开网页，那才需要 publicBaseUrl 可达。
  push: {
    // macOS 本地通知。完全不联网，「近场」场景的零依赖提醒方式。
    macNotify: true,
    // 远程推送。锁屏可达必须走 APNs，这一块无法只用 Wi-Fi。
    // 人在电脑边时可以设成 'none'，只靠 macNotify。
    provider: 'none', // 'bark' | 'none'
    bark: { server: 'https://api.day.app', key: '' },
  },
  notify: {
    // Stop 在每一轮助手回复结束时都触发，包括 2 秒就结束的对话。
    // 低于这个时长的 turn 不推送，否则每问一句都响一次。
    minTurnMs: 30_000,
    onStop: true,
    onError: true,
    // 推送正文是否带命令全文。false = 公网上只出现「Bash 操作需要审批」，
    // 命令内容只在局域网的审批页上显示。
    detailInPush: false,
    // 会自动通过的操作是否也推送。默认否——推了也来不及看，只是噪音。
    notifyAutoApproved: false,
    // 5 小时窗口用量达到这个百分比时提醒一次。0 = 关闭。
    // 目的是别让长任务跑到一半突然被限流卡住。
    quotaWarnPct: 90,
  },
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
  // 已信任的网络。只有在这些网络里才会把服务暴露到局域网；
  // 换到陌生网络（咖啡厅、机场）时自动只绑回环，等你显式确认。
  trustedNetworks: {},
  // 这些工作目录下的会话不做阻塞审批（开发 clamicro 自身时避免自己卡自己）
  ignoreCwds: [],
}

/**
 * 项目早期叫 cc-monitor，配置放在 ~/.claude/cc-monitor。
 * 直接换目录会让人丢掉 token、Bark key 和已信任网络列表——
 * 表现是「装完发现要重新扫码、推送也没了」，而且看不出原因。整个搬过来。
 */
function migrateLegacyDir() {
  const legacy = join(homedir(), '.claude', 'cc-monitor')
  if (!existsSync(legacy)) return
  // 判断依据必须是「配置文件」而不是「目录」：安装器会先把运行时同步到
  // <CONFIG_DIR>/app，目录因此提前存在，用目录判断会直接跳过迁移，
  // 表现就是 token 重新生成、Bark key 丢失，而且没有任何报错。
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
  // topic 名即凭证，用 32 字节随机量，不可猜
  if (config.relay.enabled && !config.relay.notifyTopic) {
    config.relay.notifyTopic = `ccm-n-${randomBytes(24).toString('base64url')}`
    dirty = true
  }
  if (config.relay.enabled && !config.relay.commandTopic) {
    config.relay.commandTopic = `ccm-c-${randomBytes(24).toString('base64url')}`
    dirty = true
  }
  if (dirty) {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
    chmodSync(CONFIG_FILE, 0o600) // 含 token、topic 名、Bark key
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
  config.baseUrl = config.publicBaseUrl || `http://${host || '127.0.0.1'}:${config.port}`
  // 兜底地址：主机名解析不了时给用户的另一条路
  config.altUrl = config.lanIp && host !== config.lanIp ? `http://${config.lanIp}:${config.port}` : null
  return config
}

/** 把运行时改动写回磁盘。这几个是每次启动重新探测的派生值，不落盘。 */
export function saveConfig(config) {
  const { baseUrl, altUrl, lanIp, localHost, tailscaleIp, persistedPort, ...persist } = config
  // 端口写回盘上的原值，别把环境变量的临时覆盖固化进去
  if (persistedPort != null) persist.port = persistedPort
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
function detectLanIp() {
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
