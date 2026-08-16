/**
 * 传输层的安全边界。这些检查全都发生在任何业务逻辑之前。
 *
 * 每一条都对应一种「服务绑在局域网上」才存在的攻击面。放在独立模块里是因为
 * 加新端点时最容易漏掉的就是它们——漏了不会报错，只是悄悄少一层防护。
 */

/**
 * Host 白名单 —— 防 DNS rebinding。
 *
 * 经典攻击：恶意站点让 evil.com 先解析到自己，再重绑到 192.168.1.x。
 * 浏览器认为仍是同源，CORS 被完全绕过，对方能读整个看板、命令原文，
 * 并批准操作——而且**不需要在你的 Wi-Fi 上**。
 * 只接受我们自己知道的几个主机名就能挡住：重绑之后 Host 头仍是 evil.com。
 */
export function allowedHosts({ port, lanIp, localHost, tailscaleIp, tunnelUrl }) {
  const tunnelHost = (() => {
    // tunnelUrl 而非 publicBaseUrl：隧道没在跑时那个域名不该进白名单
    try {
      return new URL(tunnelUrl).hostname
    } catch {
      return null
    }
  })()
  return new Set(
    ['127.0.0.1', 'localhost', '[::1]', '::1', lanIp, localHost, tailscaleIp, tunnelHost]
      .filter(Boolean)
      // 全部转小写：Host 头大小写不敏感，而 macOS 的 LocalHostName 常是混合大小写
      //（比如 MyMac.local）。曾经只把进来的 Host 转了小写、白名单里却存的是原样，
      // 结果服务把自己的主机名拒了。
      .flatMap((h) => [h.toLowerCase(), `${h.toLowerCase()}:${port}`]),
  )
}

export function hostAllowed(req, allowed) {
  const h = req.headers.host
  /**
   * 没有 Host 头时**只放本机**。
   *
   * 原来是无条件 `return true`，理由写的是「HTTP/1.0 无 Host，只可能来自
   * 本机脚本」。这个理由在实际效果上站得住——DNS rebinding 必须经浏览器，
   * 而浏览器一定发 Host；而且这层本来也不是鉴权边界（那是 authorized）。
   * 所以它不是一个可利用的洞。
   *
   * 但它和「严格白名单」这个说法对不上：白名单开了一个「不带就放行」的口子。
   * 而收紧的代价几乎为零——本机脚本本来就在回环上，局域网客户端本来就该
   * 带 Host。让代码说到做到，比留一句需要解释的例外好。
   */
  if (!h) {
    const a = req.socket?.remoteAddress ?? ''
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
  }
  return allowed.has(h.toLowerCase())
}

/** 一次本机直连会带的 Host，全部小写、端口已剥掉 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * 这些头只要出现，就说明请求经过了代理/隧道，不是本机直连。
 * cloudflared 会带 cf-connecting-ip / cf-ray，通用反代带 x-forwarded-*。
 */
const PROXY_HEADERS = [
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'cf-connecting-ip', 'cf-ray', 'forwarded',
]

/**
 * hooks / statusLine / pair-new 只接受**本机直连**。
 *
 * 这几组端点没有 token（Claude Code 的 http hook 传 header 很别扭），
 * 保护完全靠来源判定。最初只看 remoteAddress——但那个判据在开着
 * Cloudflare 隧道时是**假的**：
 *
 *   公网 → cloudflared → 从 127.0.0.1 转发进来 → remoteAddress 是 127.0.0.1
 *
 * 而隧道域名启动时会被加进 Host 白名单（不然隧道根本不能用），于是两道
 * 检查全部放行。后果不是「多暴露一点」，是**整个信任模型失效**：拿到隧道
 * URL 的任何人都能 POST /api/pair/new 造一张配对券，再访问 /ui/pair/:id
 * 换到设备 cookie，从此以一台合法设备的身份批准任何操作。顺带还能伪造
 * hook 事件和额度读数。
 *
 * 所以再加两道，三条都成立才算本机：
 *   1. remoteAddress 是回环（隧道也满足，单独不够用）
 *   2. **Host 是回环名** —— 本机 hook 全都请求 http://127.0.0.1:<port>/…，
 *      而隧道进来的 Host 是 xxx.trycloudflare.com。这是真正区分得开的那一条
 *   3. 没有任何代理/转发头 —— 真正的本机直连不会有
 *
 * 缺 Host 头的放行：HTTP/1.0 没有 Host，那只可能来自本机脚本
 * （hostAllowed 也是同样的处理，两边保持一致）。
 */
export function isLoopback(req) {
  const a = req.socket?.remoteAddress ?? ''
  if (a !== '127.0.0.1' && a !== '::1' && a !== '::ffff:127.0.0.1') return false

  for (const k of PROXY_HEADERS) if (req.headers?.[k]) return false

  const raw = req.headers?.host
  if (!raw) return true
  // 端口无所谓；IPv6 字面量是 [::1]:8765，剥端口不能把方括号一起剥掉
  const host = String(raw).toLowerCase().replace(/:\d+$/, '')
  return LOOPBACK_HOSTS.has(host)
}

/**
 * frame-ancestors 挡点击劫持：否则恶意页面可以把审批页嵌进 iframe 诱导你滑动，
 * 而「滑动批准」这个交互恰恰特别适合被这样骗。
 * connect-src 限制页面只能连自己。
 */
export function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  )
}
