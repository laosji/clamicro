import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, copyFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { SELF_DEADLINE_MS } from './limits.mjs'

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

/**
 * 审批等待时长的硬上限。
 *
 * hook 的系统超时是 600 秒。走到那一步，Claude Code 会把它当成**非阻塞错误**，
 * 放行到正常的权限流程——等于这次审批白做，而且没有任何报错。留 30 秒余量。
 *
 * 这个值不是「建议」，是设置页和 API 写入时都要夹住的边界：用户在网页上
 * 把等待时间拉到 10 分钟，得到的不是「等更久」，是「审批失效」。
 */
export const MAX_APPROVAL_TIMEOUT_MS = SELF_DEADLINE_MS
/** 下限：短于这个时间人根本来不及看一眼手机 */
export const MIN_APPROVAL_TIMEOUT_MS = 10_000

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
    /**
     * 会自动通过的操作是否也提醒。**默认是。**
     *
     * 曾经默认关，理由是「10 秒就过了，提醒了也来不及看，只是噪音」。
     * 那个理由只在「提醒 = 要你做决定」时成立。可普通操作本来就不需要你
     * 做决定，提醒的意义是**让你知道它发生过**——不然这个工具在日常操作上
     * 既不拦也不说，你完全不知道 Claude 刚刚跑了什么。
     *
     * 关掉的代价要说清楚：一个任务里十几次工具调用，你一次都不会看到。
     */
    notifyAutoApproved: true,
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
    /**
     * 系统「专注模式 / 勿扰」开着时静音（画面照常显示）。
     *
     * 静音而不隐藏：开专注是「别打扰我」，不是「别让我知道」——待审批那条
     * 藏起来的代价是任务卡到超时被拒。系统通知走的也是这个逻辑，压的是
     * 声音和横幅，不是事件本身。
     */
    respectFocus: true,
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
    /**
     * 高风险操作、以及关闭自动通过时：多久后「自动拒绝」。
     *
     * 默认 3 分钟，不是贴着上限的 570 秒。570 秒意味着你去倒杯水，会话就
     * 冻在那里 9 分半，然后失败——等的时间远超任何人「马上回来」的尺度，
     * 白白吃掉的都是你不在的那段。3 分钟够你听见提示音走回来，也不至于
     * 让一次走神毁掉一个长任务。
     *
     * **硬上限 570 秒**，见 MAX_APPROVAL_TIMEOUT_MS：hook 的系统超时是 600s，
     * 走到那一步会被当成非阻塞错误、放行到正常权限流程，等于审批白做。
     */
    timeoutMs: 180_000,
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

/**
 * 合并盘上的配置到默认值之上。
 *
 * **base 必须深拷贝。** 原来是 `{ ...base }` 浅拷贝：override 里没有的键
 * 直接共享 DEFAULTS 的对象引用，于是后面任何一句
 * `config.notify.macNotify = ...`（迁移代码里就有）都会**改掉 DEFAULTS 本身**。
 *
 * 这个 bug 潜伏很久没暴露，因为以前没人拿 DEFAULTS 做比较。加了「只写非默认项」
 * 之后立刻炸出来：DEFAULTS 被污染成和用户值一样，剪枝就把用户真正设过的值
 * 也当成默认剪掉了——表现是从 Bark 迁移过来的 macNotify:false 直接消失。
 *
 * DEFAULTS 是模块级单例，被写坏之后同一进程里后续所有 loadConfig 都是错的。
 */
function deepMerge(base, override) {
  if (override == null || typeof override !== 'object' || Array.isArray(override)) {
    return override === undefined ? structuredClone(base) : override
  }
  const out = structuredClone(base ?? {})
  for (const [k, v] of Object.entries(override)) {
    out[k] = base?.[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
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
   * 解冻 2.5.0 之前被固化进盘的默认值。
   *
   * 老版本的 saveConfig 把**整个合并后的配置**写盘，于是用户从没设过的默认值
   * 也被 `trust`、配对这些日常操作顺手存了下来。结果是改 DEFAULTS 对所有已有
   * 安装完全无效。saveConfig 已经改成只写非默认项，但盘上那些旧值还在，
   * 而且看起来和「用户显式设的」一模一样。
   *
   * 这两个键可以安全地当成残留删掉，因为**2.5.0 之前它们根本没有设置入口**：
   * timeoutMs 和 notifyAutoApproved 都不在设置页里，API 也不接受写入。
   * 也就是说盘上出现的值只可能是当时的默认值被固化的产物，不可能是用户的选择。
   *
   * 只在「等于那个旧默认值」时改——万一有人手改过 config.json，尊重他。
   *
   * 注意这段跑在 deepMerge **之后**，所以是「赋回新默认值」而不是 delete——
   * 删掉只会留下 undefined，默认值补不回来。赋回之后它等于默认，
   * saveConfig 的 pruneDefaults 自然就不再把它写盘了。
   */
  if (config.approval?.timeoutMs === SELF_DEADLINE_MS) {
    config.approval.timeoutMs = DEFAULTS.approval.timeoutMs
    dirty = true
  }
  if (config.notify?.notifyAutoApproved === false) {
    config.notify.notifyAutoApproved = DEFAULTS.notify.notifyAutoApproved
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
    // **这里才是默认值被固化的源头**，比 saveConfig 更隐蔽：它直接把
    // deepMerge 之后的整个对象写盘，于是每一次「首次启动 / 生成 token /
    // 跑一条迁移」都会把当时的全部默认值刻进 config.json。
    //
    // 一开始只修了 saveConfig，键数纹丝不动——因为服务启动走的是这一条。
    // 两条写路径都得剪，漏一条等于没修。
    writeFileSync(CONFIG_FILE, JSON.stringify(pruneDefaults(config, DEFAULTS), null, 2))
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
  writeFileSync(CONFIG_FILE, JSON.stringify(pruneDefaults(persist, DEFAULTS), null, 2))
  chmodSync(CONFIG_FILE, 0o600)
}

/**
 * 只写「和默认值不一样」的部分。
 *
 * ## 为什么必须这样
 *
 * 原来是把**整个合并后的配置**写盘。于是用户从没设过的每一个默认值，都会被
 * `trust`、配对、换令牌这些日常操作顺手固化进 config.json——实测一个正常使用
 * 的配置里有 27 个键，其中 `quotaWarnPct`、`style`、`checkUpdates`、`timeoutMs`、
 * `notifyAutoApproved` 用户一个都没碰过。
 *
 * 后果是：**这个项目的每一个默认值，都被冻结在用户第一次触发保存的那一刻。**
 * 之后再改 DEFAULTS，对所有已有安装完全无效——包括安全相关的默认值。
 * 实测：把高危等待从 570s 改成 180s、把 notifyAutoApproved 改成 true，
 * 发版之后**没有任何一个老用户拿到**，而 README 已经照新默认写了。
 *
 * 这和 `bind` 那个两天的 bug 是同一个病：**把派生值当成用户意图存了下来。**
 * 那次存的是「启动时探测的结果」，这次存的是「当时的默认值」。
 *
 * ## 语义
 *
 * 值等于默认值 → 不写盘 → 以后跟着默认值走。
 * 值不等于默认值 → 写盘 → 一直是用户说了算。
 *
 * 副作用是：用户手动把某项**设成了和默认值一样**的值，之后默认值变了，
 * 他会跟着变。这是可以接受的——分不清「显式设成 10 秒」和「默认就是 10 秒」，
 * 需要额外记一份「用户碰过哪些键」，代价大于收益。
 *
 * 不在 DEFAULTS 里的东西（token、devices、trustedNetworks…）一律原样保留。
 */
function pruneDefaults(value, defaults) {
  if (defaults === undefined) return value // 不是默认项，是状态，全留
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value) === JSON.stringify(defaults) ? undefined : value
  }
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    const kept = pruneDefaults(v, defaults?.[k])
    if (kept !== undefined) out[k] = kept
  }
  // 整个子对象都等于默认 → 连这个键都不写
  return Object.keys(out).length ? out : undefined
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
