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
  if (!h) return true // HTTP/1.0 无 Host，只可能来自本机脚本
  return allowed.has(h.toLowerCase())
}

/**
 * hooks 和 statusLine 只接受本机来源。
 *
 * 这两组端点没有 token（Claude Code 的 http hook 传 header 很别扭）。
 * 原本的假设是「只监听回环」——但服务同时绑了局域网网卡，假设并不成立：
 * 同一 Wi-Fi 上任何人都能伪造 hook 事件，往你手机刷审批通知、
 * 往时间线注入假记录、伪造额度读数。按来源地址挡住。
 */
export function isLoopback(req) {
  const a = req.socket.remoteAddress ?? ''
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
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
