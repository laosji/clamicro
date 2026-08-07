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
  const raw = [gateway, mac, subnet, ssid].filter(Boolean).join('|')
  if (!raw) return { id: null, label: '未联网', gateway, mac, ssid, subnet }

  return {
    id: createHash('sha256').update(raw).digest('hex').slice(0, 16),
    label: ssid || (gateway ? `网关 ${gateway}` : '未知网络'),
    gateway,
    mac,
    ssid,
    subnet,
  }
}

export function isTrusted(config, fp) {
  if (!fp.id) return false
  return Boolean(config.trustedNetworks?.[fp.id])
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
