import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const sh = (cmd, args) => (spawnSync(cmd, args, { encoding: 'utf8' }).stdout ?? '').trim()

/**
 * 当前网络的指纹。
 *
 * 服务绑在局域网上意味着同网段的人都能碰到它，而 HTTP 是明文的——
 * 在咖啡厅这种网络上等于把 token 摊开。所以换网络必须重新确认，
 * 不认识的网络一律只绑回环（失败即收缩，而不是指望你记得关掉）。
 *
 * SSID 在新版 macOS 上需要定位权限，常常拿不到；网关 IP + 网关 MAC 不需要
 * 任何权限。注意 00:00:5e:00:01:xx 是 VRRP 虚拟 MAC，企业网里并不唯一，
 * 所以要和网关 IP、网段一起算，单靠 MAC 会把不同公司网络认成同一个。
 */
export function fingerprint(lanIp) {
  const route = sh('route', ['-n', 'get', 'default'])
  const gateway = /gateway:\s*([\d.]+)/.exec(route)?.[1] ?? null
  const iface = /interface:\s*(\w+)/.exec(route)?.[1] ?? null

  let mac = null
  if (gateway) {
    spawnSync('ping', ['-c1', '-W500', gateway], { stdio: 'ignore' }) // 先填 ARP 表
    mac = /at ([0-9a-f:]+) on/i.exec(sh('arp', ['-n', gateway]))?.[1] ?? null
  }

  // 拿得到就用，拿不到不影响
  const ssidLine = sh('networksetup', ['-getairportnetwork', iface || 'en0'])
  const ssid = /Current Wi-Fi Network:\s*(.+)$/.exec(ssidLine)?.[1] ?? null

  const subnet = lanIp ? lanIp.split('.').slice(0, 3).join('.') : null

  /**
   * DHCP 侧的额外信号。**不需要任何权限**，和网关 IP/MAC 一样白拿。
   *
   * 为什么必须加：原来的四要素在一种很现实的组合下会**碰撞**——
   * 两个不同公司的网络都用 192.168.1.0/24、网关都是 192.168.1.1、
   * 网关 MAC 都是 VRRP 虚拟地址（00:00:5e:00:01:xx，企业网里并不唯一），
   * 而 SSID 在没有定位权限或走有线时拿不到。四个字段全都一样 →
   * 指纹相同 → **陌生网络被当成已信任**，服务照常绑到局域网，
   * 明文 HTTP 就摊在一个你没确认过的网络上。
   *
   * 这正是信任机制存在的理由，却被它自己的指纹算法绕过去了。
   *
   * DHCP 服务器身份、搜索域、DNS 服务器列表这三样在不同组织之间
   * 几乎不会全部相同，加进来把碰撞面压到可以忽略。
   */
  const pkt = sh('ipconfig', ['getpacket', iface || 'en0'])
  const dhcpServer = /server_identifier \(ip\):\s*([\d.]+)/.exec(pkt)?.[1] ?? null
  const domain = /domain_name \(string\):\s*(.+)$/m.exec(pkt)?.[1]?.trim() ?? null
  const dns = /domain_name_server \(ip_mult\):\s*\{([^}]*)\}/.exec(pkt)?.[1]
    ?.split(',').map((s) => s.trim()).filter(Boolean).sort().join(',') ?? null

  const raw = [gateway, mac, subnet, ssid, dhcpServer, domain, dns].filter(Boolean).join('|')
  if (!raw) return { id: null, label: '未联网', gateway, mac, ssid, subnet, weak: true }

  /**
   * 指纹辨识度低的标志：网关 MAC 是 VRRP 虚拟地址，而且既没有 SSID
   * 也没有搜索域。这时候剩下的全是「同网段就一样」的东西。
   *
   * 不用它来阻止信任——那会让一部分正常用户永远连不上。它只是**说实话**，
   * 让确认那一步能告诉用户「这个网络不好认，换了地方我可能认错」。
   */
  const vrrp = /^00:00:5e:00:01:/i.test(mac ?? '')
  const weak = vrrp && !ssid && !domain

  return {
    id: createHash('sha256').update(raw).digest('hex').slice(0, 16),
    /**
     * 旧版指纹（只用四要素）。**只用于迁移**。
     *
     * 加了新字段之后哈希全变了，老用户升级就会发现所有已信任网络一夜失效、
     * 服务只绑回环、手机连不上——一次安全加固不该以「所有人重新配一遍」收场。
     * 这里算一份旧 id，isTrusted 命中旧 id 时原地迁移到新 id。
     * 是**精确哈希匹配**，不是模糊比对，所以迁移本身不放松任何东西。
     */
    legacyId: createHash('sha256')
      .update([gateway, mac, subnet, ssid].filter(Boolean).join('|'))
      .digest('hex').slice(0, 16),
    label: ssid || domain || (gateway ? `网关 ${gateway}` : '未知网络'),
    gateway,
    mac,
    ssid,
    subnet,
    weak,
  }
}

/**
 * 这个网络信任过吗。**纯函数，不改 config。**
 *
 * 新旧两个指纹都认。旧的那个是为了升级：指纹算法加了 DHCP 侧的字段之后
 * 哈希全变了，只认新 id 的话，升级前信任过的网络会一夜集体失效——表现是
 * 「更新完手机就连不上了」，服务只绑回环，而且完全看不出原因。
 *
 * 判据是旧哈希**精确相等**，不是拿 gateway/subnet 模糊比。所以兼容旧 id
 * 并不放松任何判定，它认的就是同一个网络，只是换了个算法命名。
 *
 * 早先这里写成了「命中旧 id 就顺手迁移到新 id 并删掉旧的」。两个问题：
 *   · 一个叫 isTrusted 的谓词去改调用方的配置，是意外行为
 *   · 改了也不落盘（调用它的多是一次性 CLI 进程，没人 saveConfig），
 *     于是每个进程都白做一遍，配置文件永远不变
 * 认两个 id 就够了，不需要迁移这个动作。
 */
export function isTrusted(config, fp) {
  if (!fp?.id) return false
  const known = config.trustedNetworks ?? {}
  if (known[fp.id]) return true
  return Boolean(fp.legacyId && known[fp.legacyId])
}

export function trust(config, fp) {
  config.trustedNetworks ??= {}
  config.trustedNetworks[fp.id] = {
    label: fp.label,
    gateway: fp.gateway,
    subnet: fp.subnet,
    addedAt: Date.now(),
  }
  return config.trustedNetworks[fp.id]
}
